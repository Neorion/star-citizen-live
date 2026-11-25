'use strict';

/**
 * HTTP surface for the Game.log transaction ledger — mounted by LiveRelay.
 *
 * Read-only over data already on this node: nothing here publishes to Fabric
 * or Discord (where you shopped and what you spent stays local — D-017).
 *
 *   GET  {base}/ledger             rows (from, to, system, locationId, direction, kind, includeNonSuccess=1,
 *                                  limit=5000 (max 20000), offset=0 — both applied to the NEWEST rows)
 *   GET  {base}/ledger/summary     spend / income / net (+ per system)
 *   GET  {base}/ledger/stats       counts (transactions, files ingested, names learned)
 *   GET  {base}/ledger/export.csv  CSV download
 *   POST {base}/ledger/ingest      { path } | { all: true } — saved logs; local-player only
 *   POST {base}/ledger/action      { action: 'learnLocation'|'learnItem', id, display } — operator corrections
 * Every route is also mounted without the base prefix.
 */

const fs = require('fs');
const path = require('path');

/** Ingests started by this module, keyed by ledger: single-flight guard. */
const RUNNING_INGESTS = new WeakMap();
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const DEFAULT_LIMIT = 5000;
const MAX_LIMIT = 20000;
const MAX_ID_LEN = 200;
const MAX_DISPLAY_LEN = 120;

/**
 * Cross-origin guard for state-changing routes. A browser page on another site
 * sends an Origin header; refuse it unless it is loopback or the same host the
 * request was addressed to. Requests with no Origin (non-browser clients) pass.
 * @param {Object} req Node http request.
 * @returns {boolean} true when the request is a foreign-origin browser request.
 */
function isCrossOrigin (req) {
  const origin = req.headers && req.headers.origin;
  if (!origin) return false;
  let originHost;
  try { originHost = new URL(String(origin)).host.toLowerCase(); } catch (_) { return true; }
  const hostname = originHost.replace(/:\d+$/, '');
  if (LOOPBACK_HOSTS.has(hostname)) return false;
  return originHost !== String(req.headers.host || '').toLowerCase();
}

/** Clamp a query integer into [min, max], or return the default. */
function intParam (raw, def, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** Compare paths the way the filesystem does (realpath; case-insensitive on Windows). */
function pathKey (p) {
  let abs = path.resolve(String(p));
  try { abs = fs.realpathSync(abs); } catch (_) { /* missing file: compare as given */ }
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/**
 * @param {Object} host
 * @param {Object} host.ledger services/TransactionLedger instance.
 * @param {function(): Array<string>} host.knownLogFiles Log files an ingest may read.
 * @param {function(Object, function): boolean} host.requireSession Read guard; sends 401 itself and returns false.
 * @param {function(Object): boolean} host.needsAuth True when this request must carry a session to mutate.
 * @param {boolean} [host.hosted] True in hosted server mode (no local Game.log).
 * @param {Object} req
 * @param {Object} res
 * @param {{ pathname: string, url: URL, base: string, send: function, body: function, cors?: Object }} io
 * @returns {Promise<boolean>} true when the request was handled.
 */
async function tryHandleLedger (host, req, res, io) {
  const { pathname, url, base, send, body } = io;
  const AUTH_REQUIRED = { error: 'Authentication required (POST …/auth with a signed login envelope)' };
  const q = (k) => url.searchParams.get(k) || undefined;

  if (req.method === 'GET' && (pathname === `${base}/ledger` || pathname === '/ledger')) {
    if (!host.requireSession(req, send)) return true;
    const rows = host.ledger.query({
      from: q('from'),
      to: q('to'),
      system: q('system'),
      locationId: q('locationId'),
      direction: q('direction'),
      kind: q('kind'),
      includeNonSuccess: url.searchParams.get('includeNonSuccess') === '1'
    });
    // Rows are ascending by time: page from the newest end.
    const limit = intParam(url.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = intParam(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
    const end = Math.max(0, rows.length - offset);
    send(200, { type: 'Collection', total: rows.length, data: rows.slice(Math.max(0, end - limit), end) });
    return true;
  }
  if (req.method === 'GET' && (pathname === `${base}/ledger/summary` || pathname === '/ledger/summary')) {
    if (!host.requireSession(req, send)) return true;
    send(200, Object.assign({ type: 'LedgerSummary' }, host.ledger.summary({ from: q('from'), to: q('to') })));
    return true;
  }
  if (req.method === 'GET' && (pathname === `${base}/ledger/stats` || pathname === '/ledger/stats')) {
    if (!host.requireSession(req, send)) return true;
    send(200, Object.assign({ type: 'LedgerStats' }, host.ledger.stats()));
    return true;
  }
  if (req.method === 'GET' && (pathname === `${base}/ledger/export.csv` || pathname === '/ledger/export.csv')) {
    if (!host.requireSession(req, send)) return true;
    const rows = host.ledger.query({ includeNonSuccess: url.searchParams.get('includeNonSuccess') === '1' });
    res.writeHead(200, Object.assign({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="ledger.csv"'
    }, io.cors || {}));
    res.end(host.ledger.toCSV(rows));
    return true;
  }
  if (req.method === 'POST' && (pathname === `${base}/ledger/ingest` || pathname === '/ledger/ingest')) {
    if (host.hosted) { send(400, { error: 'ledger ingest is a local-player operation' }); return true; }
    if (isCrossOrigin(req)) { send(403, { error: 'cross-origin request refused' }); return true; }
    if (host.needsAuth(req)) { send(401, AUTH_REQUIRED); return true; }
    const d = await body();
    // Only files this node already knows as logs — never an arbitrary path from the request.
    const known = new Map();
    for (const f of host.knownLogFiles()) known.set(pathKey(f), path.resolve(f));
    let files;
    if (d.all === true) files = [...known.values()];
    else if (typeof d.path === 'string' && d.path.trim()) {
      const hit = known.get(pathKey(d.path.trim()));
      if (!hit) { send(400, { error: 'path is not a known log file (import it in the log browser first)' }); return true; }
      files = [hit];
    } else { send(400, { error: 'path or all:true required' }); return true; }
    if (RUNNING_INGESTS.has(host.ledger)) { send(409, { error: 'ledger ingest already running' }); return true; }
    const run = host.ledger.ingestPaths(files.filter((f) => fs.existsSync(f)));
    RUNNING_INGESTS.set(host.ledger, run);
    let result;
    try { result = await run; } finally { RUNNING_INGESTS.delete(host.ledger); }
    send(200, Object.assign({ type: 'LedgerIngest' }, result, host.ledger.stats()));
    return true;
  }
  if (req.method === 'POST' && (pathname === `${base}/ledger/action` || pathname === '/ledger/action')) {
    if (host.hosted) { send(400, { error: 'ledger corrections are a local-player operation' }); return true; }
    if (isCrossOrigin(req)) { send(403, { error: 'cross-origin request refused' }); return true; }
    if (host.needsAuth(req)) { send(401, AUTH_REQUIRED); return true; }
    const d = await body();
    const id = typeof d.id === 'string' ? d.id.trim() : '';
    // eslint-disable-next-line no-control-regex
    const display = typeof d.display === 'string' ? d.display.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim() : '';
    if (!id || !display) { send(400, { error: 'id and display required' }); return true; }
    if (id.length > MAX_ID_LEN || display.length > MAX_DISPLAY_LEN) { send(400, { error: 'id or display too long' }); return true; }
    if (d.action === 'learnLocation') host.ledger.learnLocation(id, display);
    else if (d.action === 'learnItem') host.ledger.learnItem(id, display);
    else { send(400, { error: 'unknown action' }); return true; }
    send(200, { type: 'LedgerAction', ok: true, action: d.action, id });
    return true;
  }
  return false;
}

module.exports = { tryHandleLedger, isCrossOrigin };
