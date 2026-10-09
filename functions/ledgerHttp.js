'use strict';

/**
 * HTTP surface for the Game.log transaction ledger — mounted by LiveRelay.
 *
 * Read-only over data already on this node: nothing here publishes to Fabric
 * or Discord (where you shopped and what you spent stays local — D-017).
 *
 *   GET  {base}/ledger             rows (from, to, system, locationId, direction, kind, includeNonSuccess=1)
 *   GET  {base}/ledger/summary     spend / income / net (+ per system)
 *   GET  {base}/ledger/stats       counts (transactions, files ingested, names learned)
 *   GET  {base}/ledger/export.csv  CSV download
 *   POST {base}/ledger/ingest      { path } | { all: true } — saved logs; local-player only
 *   POST {base}/ledger/action      { action: 'learnLocation'|'learnItem', id, display } — operator corrections
 * Every route is also mounted without the base prefix.
 */

const fs = require('fs');
const path = require('path');

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
    send(200, { type: 'Collection', total: rows.length, data: rows });
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
    const result = await host.ledger.ingestPaths(files.filter((f) => fs.existsSync(f)));
    send(200, Object.assign({ type: 'LedgerIngest' }, result, host.ledger.stats()));
    return true;
  }
  if (req.method === 'POST' && (pathname === `${base}/ledger/action` || pathname === '/ledger/action')) {
    if (host.needsAuth(req)) { send(401, AUTH_REQUIRED); return true; }
    const d = await body();
    const id = typeof d.id === 'string' ? d.id.trim() : '';
    const display = typeof d.display === 'string' ? d.display.trim() : '';
    if (!id || !display) { send(400, { error: 'id and display required' }); return true; }
    if (d.action === 'learnLocation') host.ledger.learnLocation(id, display);
    else if (d.action === 'learnItem') host.ledger.learnItem(id, display);
    else { send(400, { error: 'unknown action' }); return true; }
    send(200, { type: 'LedgerAction', ok: true, action: d.action, id });
    return true;
  }
  return false;
}

module.exports = { tryHandleLedger };
