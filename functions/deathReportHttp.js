'use strict';

/**
 * HTTP surface for death reports — mounted by LiveRelay (and by the
 * standalone preview, scripts/death-report-preview.js).
 *
 * Read-only over data already on this node: nothing here publishes to Fabric
 * or Discord (gear manifests + death positions stay local — D-017).
 *
 *   GET    {base}/deathreports            list (limit, offset, cause, status, player)
 *   POST   {base}/deathreports/rescan     { path } | { all: true } — local-player only
 *   GET    {base}/deathreports/:id        full report
 *   GET    {base}/deathreports/:id/export ?format=md|json download
 *   DELETE {base}/deathreports/:id        remove one
 * Every route is also mounted without the base prefix.
 */

const fs = require('fs');
const path = require('path');
const deathReportStore = require('./deathReportStore');
const deathReport = require('./deathReport');

/** Compare paths the way the filesystem does (realpath; case-insensitive on Windows). */
function pathKey (p) {
  let abs = path.resolve(String(p));
  try { abs = fs.realpathSync(abs); } catch (_) { /* missing file: compare as given */ }
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/**
 * @param {Object} host What the routes need from the service that mounts them.
 * @param {Object} host.store Death report store (deathReportStore shape).
 * @param {function(): Array<string>} host.knownLogFiles Log files a rescan may read.
 * @param {function(Array<string>): Promise<Object>} host.rescan Scan files into the store.
 * @param {function(): void} host.markDirty Called after the store changes.
 * @param {function(Object, function): boolean} host.requireSession Read guard; sends 401 itself and returns false.
 * @param {function(Object): boolean} host.needsAuth True when this request must carry a session to mutate.
 * @param {boolean} [host.hosted] True in hosted server mode (no local Game.log).
 * @param {Object} req
 * @param {Object} res
 * @param {Object} io
 * @param {string} io.pathname
 * @param {URL} io.url
 * @param {string} io.base Service base path (`/services/star-citizen`).
 * @param {function(number, Object): void} io.send JSON responder.
 * @param {function(): Promise<Object>} io.body JSON body reader.
 * @param {Object} [io.cors] Extra headers for non-JSON responses.
 * @returns {Promise<boolean>} true when the request was handled.
 */
async function tryHandleDeathReports (host, req, res, io) {
  const { pathname, url, base, send, body } = io;
  const AUTH_REQUIRED = { error: 'Authentication required (POST …/auth with a signed login envelope)' };

  if (req.method === 'GET' && (pathname === `${base}/deathreports` || pathname === '/deathreports')) {
    if (!host.requireSession(req, send)) return true;
    const page = deathReportStore.listReports(host.store, {
      limit: url.searchParams.get('limit'),
      offset: url.searchParams.get('offset'),
      cause: url.searchParams.get('cause') || null,
      status: url.searchParams.get('status') || null,
      player: url.searchParams.get('player') || null
    });
    send(200, { type: 'Collection', total: page.total, data: page.rows });
    return true;
  }

  if (req.method === 'POST' && (pathname === `${base}/deathreports/rescan` || pathname === '/deathreports/rescan')) {
    if (host.hosted) { send(400, { error: 'death report rescan is a local-player operation' }); return true; }
    if (host.needsAuth(req)) { send(401, AUTH_REQUIRED); return true; }
    const d = await body();
    // Only files this node already knows as logs (live log, logbackups,
    // imported corpus) — never an arbitrary path from the request.
    const known = new Map();
    for (const f of host.knownLogFiles()) known.set(pathKey(f), path.resolve(f));
    let files;
    if (d.all === true) files = [...known.values()];
    else if (typeof d.path === 'string' && d.path.trim()) {
      const hit = known.get(pathKey(d.path.trim()));
      if (!hit) { send(400, { error: 'path is not a known log file (import it in the log browser first)' }); return true; }
      files = [hit];
    } else { send(400, { error: 'path or all:true required' }); return true; }
    const result = await host.rescan(files.filter((f) => fs.existsSync(f)));
    send(200, Object.assign({ type: 'DeathReportRescan' }, result));
    return true;
  }

  const m = pathname.match(new RegExp(`^(?:${base})?/deathreports/([0-9a-f]{32})(/export)?$`));
  if (!m) return false;
  const found = deathReportStore.getReport(host.store, m[1]);

  if (req.method === 'GET') {
    if (!host.requireSession(req, send)) return true;
    if (!found) { send(404, { error: 'Death report not found' }); return true; }
    if (!m[2]) { send(200, { type: 'DeathReport', data: found }); return true; }
    const format = url.searchParams.get('format') || 'md';
    if (format !== 'md' && format !== 'json') { send(400, { error: 'format must be md or json' }); return true; }
    const text = format === 'md' ? deathReport.toMarkdown(found) : JSON.stringify(found, null, 2);
    res.writeHead(200, Object.assign({
      'Content-Type': format === 'md' ? 'text/markdown; charset=utf-8' : 'application/json',
      'Content-Disposition': `attachment; filename="death-report-${found.id.slice(0, 8)}.${format}"`
    }, io.cors || {}));
    res.end(text);
    return true;
  }

  if (req.method === 'DELETE' && !m[2]) {
    if (host.needsAuth(req)) { send(401, AUTH_REQUIRED); return true; }
    if (!deathReportStore.removeReport(host.store, m[1])) { send(404, { error: 'Death report not found' }); return true; }
    host.markDirty();
    send(200, { type: 'DeathReportRemoved', id: m[1] });
    return true;
  }

  return false;
}

module.exports = {
  tryHandleDeathReports
};
