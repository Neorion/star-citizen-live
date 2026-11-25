'use strict';

/**
 * Shard capture store — durable, idempotent, local-only, OFF by default.
 *
 * `shard-capture.json` beside `history.json`. Kept out of history on purpose:
 * it holds server addresses, which must never ride along with anything that
 * log sharing or the activity tree publish to peers (D-017).
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { createShardTracker } = require('./shardTracker');

// Per-kind caps. <Change Server> start/end pairs are loading-screen transitions
// (2,000+ per player corpus, no server identity) and are deliberately NOT stored.
const CAP = { joins: 5000, handoffs: 5000, authority: 5000 };
const SCAN_YIELD_EVERY = 4000;

function emptyStore () {
  return { joins: [], handoffs: [], authority: [], meta: { savedAt: null } };
}

function normalizeStore (raw) {
  const s = emptyStore();
  if (!raw || typeof raw !== 'object') return s;
  for (const k of Object.keys(CAP)) s[k] = Array.isArray(raw[k]) ? raw[k].filter((r) => r && r.id) : [];
  s.meta = Object.assign({}, s.meta, raw.meta || {});
  return s;
}

/** @param {string|null} settingsDir @returns {string|null} */
function storePath (settingsDir) {
  return settingsDir ? path.join(settingsDir, 'shard-capture.json') : null;
}

function loadStore (file) {
  try {
    if (!file || !fs.existsSync(file)) return emptyStore();
    return normalizeStore(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (_) {
    return emptyStore();
  }
}

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

const SHARD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PLACE = 200;

const KIND = { join: 'joins', handoff: 'handoffs', authority: 'authority' };

/**
 * Add one tracker event's record. Idempotent by record id.
 * @returns {boolean} true when something new was stored.
 */
function addEvent (store, event) {
  const key = KIND[event && event.type];
  if (!key || !event.record || !event.record.id) return false;
  let rec = event.record;
  if (typeof rec.shardId === 'string' && !SHARD_ID_RE.test(rec.shardId)) return false;
  if (typeof rec.place === 'string' && rec.place.length > MAX_PLACE) rec = Object.assign({}, rec, { place: null });
  const list = store[key];
  if (list.some((r) => r.id === rec.id)) return false;
  // At the cap, anything older than the oldest kept record is dropped, not
  // rotated in — so re-scanning old files stays a no-op.
  if (list.length >= CAP[key] && String(rec.at) <= String(list[0].at)) return false;
  list.push(rec);
  list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  if (list.length > CAP[key]) list.splice(0, list.length - CAP[key]);
  return true;
}

/**
 * Operator summary: shards seen, replicant endpoints per shard, and the
 * places where handoffs / authority losses happened most. Counts only.
 */
function summary (store) {
  // Null-prototype maps: keys come from log text, so `__proto__` must stay inert.
  const shards = Object.create(null);
  const touch = (r) => {
    if (!r.shardId) return null;
    const s = shards[r.shardId] || (shards[r.shardId] = { shardId: r.shardId, region: r.region || null, build: r.build || null, joins: 0, handoffs: 0, authority: 0, firstSeen: r.at, lastSeen: r.at, endpoints: new Set() });
    if (r.at < s.firstSeen) s.firstSeen = r.at;
    if (r.at > s.lastSeen) s.lastSeen = r.at;
    return s;
  };
  for (const r of store.joins) { const s = touch(r); if (s) { s.joins += 1; s.endpoints.add(`${r.address}:${r.port}`); } }
  for (const r of store.handoffs) { const s = touch(r); if (s) { s.handoffs += 1; s.endpoints.add(`${r.from.address}:${r.from.port}`); s.endpoints.add(`${r.to.address}:${r.to.port}`); } }
  for (const r of store.authority) { const s = touch(r); if (s) { s.authority += 1; if (r.replicant) s.endpoints.add(`${r.replicant.address}:${r.replicant.port}`); } }
  const byPlace = (rows) => {
    const m = Object.create(null);
    for (const r of rows) { const k = r.place || '(unknown)'; m[k] = (m[k] || 0) + 1; }
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([place, count]) => ({ place, count }));
  };
  const regions = Object.create(null);
  for (const s of Object.values(shards)) regions[s.region || '?'] = (regions[s.region || '?'] || 0) + 1;
  return {
    counts: { joins: store.joins.length, handoffs: store.handoffs.length, authority: store.authority.length },
    shards: Object.values(shards).map((s) => Object.assign({}, s, { endpoints: s.endpoints.size })).sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen))),
    regions: Object.assign({}, regions),
    handoffsByPlace: byPlace(store.handoffs),
    authorityByPlace: byPlace(store.authority)
  };
}

/**
 * CSV of every record (one row per event). Columns are fixed so exports diff cleanly.
 */
function toCSV (store) {
  const cols = ['kind', 'at', 'shardId', 'region', 'build', 'place', 'placeKind', 'placeAt', 'fromAddress', 'fromPort', 'toAddress', 'toPort', 'logFile'];
  const esc = (v) => { if (v == null) return ''; let s = String(v); if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = [cols.join(',')];
  const push = (kind, r, from, to) => rows.push([kind, r.at, r.shardId, r.region, r.build, r.place, r.placeKind, r.placeAt,
    from && from.address, from && from.port, to && to.address, to && to.port, r.logFile].map(esc).join(','));
  for (const r of store.joins) push('join', r, null, { address: r.address, port: r.port });
  for (const r of store.handoffs) push('handoff', r, r.from, r.to);
  for (const r of store.authority) push('authority', r, r.replicant, null);
  return rows.join('\n');
}

/**
 * Run the tracker over one whole log file (read-only).
 * @returns {Promise<{ events: Array<Object>, lines: number }>}
 */
function scanFile (file) {
  return new Promise((resolve, reject) => {
    const tracker = createShardTracker({ logFile: path.basename(file) });
    const events = [];
    let lines = 0;
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      lines += 1;
      for (const e of tracker.feed(line)) events.push(e);
      if (lines % SCAN_YIELD_EVERY === 0) { rl.pause(); setImmediate(() => rl.resume()); }
    });
    rl.on('close', () => resolve({ events, lines }));
    rl.on('error', reject);
    stream.on('error', reject);
  });
}

/**
 * Scan whole files into the store. Idempotent by record id.
 * @returns {Promise<{ files: number, lines: number, added: number, skippedDuplicates: number }>}
 */
async function rescanFiles (store, files) {
  const out = { files: 0, lines: 0, added: 0, skippedDuplicates: 0 };
  for (const file of files || []) {
    let r;
    try { r = await scanFile(file); } catch (_) { continue; }
    out.files += 1;
    out.lines += r.lines;
    for (const e of r.events) { if (addEvent(store, e)) out.added += 1; else out.skippedDuplicates += 1; }
  }
  return out;
}

module.exports = { CAP, emptyStore, storePath, loadStore, saveStore, addEvent, summary, toCSV, scanFile, rescanFiles };
