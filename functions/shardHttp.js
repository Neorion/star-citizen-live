'use strict';

/**
 * HTTP surface for shard capture — mounted by LiveRelay, GATED.
 *
 * Every route answers 503 `{ enabled: false }` unless `settings.shard.enable`
 * (env `SC_SHARD_CAPTURE=1`) is on. Read-only over data already on this
 * node; nothing here publishes to Fabric or Discord (server addresses stay
 * local — D-017).
 *
 *   GET  {base}/shard             enabled flag, current shard / endpoint, summary
 *   GET  {base}/shard/events      ?kind=joins|handoffs|authority&limit=
 *   GET  {base}/shard/export.csv  CSV download
 *   POST {base}/shard/rescan      { path } | { all: true } — saved logs; local-player only
 * Every route is also mounted without the base prefix.
 */

const fs = require('fs');
const path = require('path');
const shardStore = require('./shardStore');

function pathKey (p) {
  let abs = path.resolve(String(p));
  try { abs = fs.realpathSync(abs); } catch (_) { /* missing file: compare as given */ }
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

// One rescan at a time per store (a rescan re-reads whole log files).
const rescanning = new WeakMap();

/**
 * Cross-origin guard for state-changing requests. A request with no Origin
 * header (curl, same-origin tools) is allowed; a loopback Origin is allowed;
 * any other Origin must match the request's own Host header.
 * @param {Object} req Node http.IncomingMessage
 * @returns {boolean} true when the request should be refused.
 */
function isCrossOrigin (req) {
  const origin = req.headers && req.headers.origin;
  if (!origin) return false;
  let host;
  try { host = new URL(String(origin)).host.toLowerCase(); } catch (_) { return true; }
  const name = host.replace(/:[0-9]+$/, '');
  if (name === 'localhost' || name === '127.0.0.1' || name === '[::1]') return false;
  return host !== String(req.headers.host || '').toLowerCase();
}

const OFF = { enabled: false, error: 'Shard capture is off (set SC_SHARD_CAPTURE=1 or settings.shard.enable)' };

/**
 * @param {Object} host
 * @param {boolean} host.enabled
 * @param {Object|null} host.store shardStore shape (when enabled)
 * @param {function(): Object} [host.current] Tracker's current() (when enabled)
 * @param {function(): Array<string>} host.knownLogFiles
 * @param {function(Array<string>): Promise<Object>} host.rescan
 * @param {function(Object, function): boolean} host.requireSession
 * @param {function(Object): boolean} host.needsAuth
 * @param {boolean} [host.hosted]
 * @returns {Promise<boolean>} true when handled.
 */
async function tryHandleShard (host, req, res, io) {
  const { pathname, url, base, send, body } = io;
  const is = (p) => pathname === `${base}${p}` || pathname === p;
  const matches = is('/shard') || is('/shard/events') || is('/shard/export.csv') || is('/shard/rescan');
  if (!matches) return false;
  const AUTH_REQUIRED = { error: 'Authentication required (POST …/auth with a signed login envelope)' };

  if (!host.enabled || !host.store) { send(503, OFF); return true; }

  if (req.method === 'GET' && is('/shard')) {
    if (!host.requireSession(req, send)) return true;
    const cur = host.current ? host.current() : null;
    send(200, Object.assign({ type: 'ShardCapture', enabled: true, current: cur }, shardStore.summary(host.store)));
    return true;
  }
  if (req.method === 'GET' && is('/shard/events')) {
    if (!host.requireSession(req, send)) return true;
    const kind = url.searchParams.get('kind') || 'handoffs';
    if (!Object.prototype.hasOwnProperty.call(shardStore.CAP, kind)) { send(400, { error: 'kind must be joins, handoffs or authority' }); return true; }
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 200, 1), 5000);
    const rows = host.store[kind].slice(-limit).reverse();
    send(200, { type: 'Collection', kind, total: host.store[kind].length, data: rows });
    return true;
  }
  if (req.method === 'GET' && is('/shard/export.csv')) {
    if (!host.requireSession(req, send)) return true;
    res.writeHead(200, Object.assign({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="shard-capture.csv"'
    }, io.cors || {}));
    res.end(shardStore.toCSV(host.store));
    return true;
  }
  if (req.method === 'POST' && is('/shard/rescan')) {
    if (host.hosted) { send(400, { error: 'shard rescan is a local-player operation' }); return true; }
    if (host.needsAuth(req)) { send(401, AUTH_REQUIRED); return true; }
    if (isCrossOrigin(req)) { send(403, { error: 'cross-origin request refused' }); return true; }
    const d = await body();
    const known = new Map();
    for (const f of host.knownLogFiles()) known.set(pathKey(f), path.resolve(f));
    let files;
    if (d.all === true) files = [...known.values()];
    else if (typeof d.path === 'string' && d.path.trim()) {
      const hit = known.get(pathKey(d.path.trim()));
      if (!hit) { send(400, { error: 'path is not a known log file (import it in the log browser first)' }); return true; }
      files = [hit];
    } else { send(400, { error: 'path or all:true required' }); return true; }
    if (rescanning.get(host.store)) { send(409, { error: 'shard rescan already running' }); return true; }
    rescanning.set(host.store, true);
    let result;
    try { result = await host.rescan(files.filter((f) => fs.existsSync(f))); } finally { rescanning.delete(host.store); }
    send(200, Object.assign({ type: 'ShardRescan' }, result));
    return true;
  }
  send(405, { error: 'method not allowed' });
  return true;
}

module.exports = { tryHandleShard, isCrossOrigin };
