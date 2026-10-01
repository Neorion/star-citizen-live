'use strict';

/**
 * Death report store — durable, idempotent, local-only.
 *
 * A sibling of cumulative history (`death-reports.json` next to
 * `history.json`), kept in its OWN file on purpose: reports carry a gear
 * manifest and a death position, so they must never ride along with the
 * history payloads that log sharing / the activity tree publish to peers
 * (D-017). Nothing in this module talks to the network.
 *
 * Reports are keyed by a content id (see deathReport.reportId), so the live
 * tail and any number of file rescans converge on one record per death.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { createDeathDetector } = require('./deathDetector');
const { listRow } = require('./deathReport');

/** Newest reports kept on disk; older ones roll off. */
const MAX_REPORTS = 2000;
/** Pause readline this often so HTTP / IPC can run during a large rescan. */
const SCAN_YIELD_EVERY = 4000;

/** @returns {{ reports: Array<Object>, meta: { savedAt: string|null } }} */
function emptyStore () {
  return { reports: [], meta: { savedAt: null } };
}

function normalizeStore (raw) {
  const s = emptyStore();
  if (!raw || typeof raw !== 'object') return s;
  s.reports = Array.isArray(raw.reports) ? raw.reports.filter((r) => r && typeof r === 'object' && r.id) : [];
  s.meta = Object.assign({}, s.meta, raw.meta || {});
  return s;
}

/**
 * @param {string|null} settingsDir
 * @returns {string|null} `<settingsDir>/death-reports.json`, or null for memory-only.
 */
function storePath (settingsDir) {
  if (!settingsDir) return null;
  return path.join(settingsDir, 'death-reports.json');
}

/** @param {string|null} file @returns {Object} */
function loadStore (file) {
  try {
    if (!file || !fs.existsSync(file)) return emptyStore();
    return normalizeStore(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (_) {
    return emptyStore();
  }
}

/** @param {string|null} file @param {Object} store */
function saveStore (file, store) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const out = normalizeStore(store);
  out.meta.savedAt = new Date().toISOString();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out));
  fs.renameSync(tmp, file);
  store.meta = out.meta;
}

/** How much evidence a report carries — the richer copy of one death wins. */
function richness (r) {
  return (r.status === 'confirmed' ? 1000 : 0) + (r.respawnedAt ? 100 : 0) +
    (r.evidence || []).length + (r.items || []).length;
}

const when = (r) => String(r.confirmedAt || r.triggerAt || '');

/**
 * Insert a report, or replace the stored copy when the new one is richer.
 * @param {Object} store
 * @param {Object} report
 * @returns {'created'|'updated'|'skipped'}
 */
function upsertReport (store, report) {
  if (!store || !report || !report.id) return 'skipped';
  const i = store.reports.findIndex((r) => r.id === report.id);
  if (i === -1) {
    store.reports.push(report);
    store.reports.sort((a, b) => when(a).localeCompare(when(b)));
    if (store.reports.length > MAX_REPORTS) store.reports.splice(0, store.reports.length - MAX_REPORTS);
    return 'created';
  }
  if (richness(report) > richness(store.reports[i])) {
    store.reports[i] = report;
    return 'updated';
  }
  return 'skipped';
}

/** @param {Object} store @param {string} id @returns {Object|null} */
function getReport (store, id) {
  return (store && store.reports.find((r) => r.id === id)) || null;
}

/** @param {Object} store @param {string} id @returns {boolean} true when a report was removed */
function removeReport (store, id) {
  const i = store ? store.reports.findIndex((r) => r.id === id) : -1;
  if (i === -1) return false;
  store.reports.splice(i, 1);
  return true;
}

/**
 * Paged list, newest first.
 * @param {Object} store
 * @param {{ limit?: number, offset?: number, cause?: string, status?: string, player?: string }} [q]
 * @returns {{ total: number, rows: Array<Object> }}
 */
function listReports (store, q = {}) {
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 500);
  const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
  const rows = (store ? store.reports : [])
    .filter((r) => (!q.cause || r.cause === q.cause) && (!q.status || r.status === q.status) &&
      (!q.player || r.player === q.player))
    .sort((a, b) => when(b).localeCompare(when(a)));
  return { total: rows.length, rows: rows.slice(offset, offset + limit).map(listRow) };
}

/**
 * Run the detector over one whole log file (read-only).
 * @param {string} file Absolute path of a Game.log / logbackup.
 * @param {Object} [opts] Passed to createDeathDetector (`handle`, name resolvers).
 * @returns {Promise<{ reports: Array<Object>, lines: number }>} Closed incidents found in the file.
 */
function scanFile (file, opts = {}) {
  return new Promise((resolve, reject) => {
    const det = createDeathDetector(Object.assign({}, opts, { logFile: path.basename(file) }));
    const reports = [];
    const take = (events) => { for (const e of events) if (e.type === 'death.closed') reports.push(e.report); };
    let lines = 0;
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      lines += 1;
      take(det.feed(lines, line));
      if (lines % SCAN_YIELD_EVERY === 0) {
        rl.pause();
        setImmediate(() => rl.resume());
      }
    });
    rl.on('close', () => { take(det.flush()); resolve({ reports, lines }); });
    rl.on('error', reject);
    stream.on('error', reject);
  });
}

/**
 * Scan whole log files into a store. Idempotent: a death already on record is
 * skipped, or upgraded when the file carries more evidence than the stored copy.
 * @param {Object} store
 * @param {Array<string>} files Absolute log paths (vetted by the caller).
 * @param {Object} [opts] Passed to scanFile / createDeathDetector.
 * @returns {Promise<{ files: number, lines: number, created: number, updated: number, skippedDuplicates: number }>}
 */
async function rescanFiles (store, files, opts = {}) {
  const out = { files: 0, lines: 0, created: 0, updated: 0, skippedDuplicates: 0 };
  for (const file of files || []) {
    let result;
    try { result = await scanFile(file, opts); } catch (_) { continue; }
    out.files += 1;
    out.lines += result.lines;
    for (const r of result.reports) {
      // A whole-file scan yields true file line numbers (the live tail does not).
      const action = upsertReport(store, Object.assign({}, r, { lineBasis: 'file' }));
      if (action === 'created') out.created += 1;
      else if (action === 'updated') out.updated += 1;
      else out.skippedDuplicates += 1;
    }
  }
  return out;
}

module.exports = {
  MAX_REPORTS,
  emptyStore,
  storePath,
  loadStore,
  saveStore,
  upsertReport,
  getReport,
  removeReport,
  listReports,
  scanFile,
  rescanFiles
};
