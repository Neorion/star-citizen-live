'use strict';

/**
 * TransactionLedger — optional, self-contained Game.log spend/income ledger.
 *
 * ┌─ SEPARABLE BY DESIGN ───────────────────────────────────────────────────┐
 * │ This whole feature is ONE module + one flag + one small REST surface. It │
 * │ does its own log extraction (it never touches app/parser.js) and only    │
 * │ requires Node built-ins (fs, path, crypto, readline) — no repo-specific   │
 * │ imports. That means this single file can be lifted wholesale into any    │
 * │ other local tool (a standalone CLI, a different relay, a notebook) with  │
 * │ zero changes. To remove it from THIS app: delete this file + data/ledger/│
 * │ + scripts/ledger-ingest.js, drop the `ledger:` settings flag and the      │
 * │ /ledger* routes in app/server.js. Core relay is untouched. Zero runtime  │
 * │ dependencies (D-002).                                                    │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * WHY THIS EXISTS: Game.log DOES record every kiosk/terminal transaction —
 * price, quantity, item — but every identifier in it is an engine string a
 * human can't read (shop archetypes reused at every outlet of a chain,
 * location IDs, item-class GUIDs, commodity GUIDs). There is no in-game spend
 * history. This module parses the five transaction event shapes plus their
 * outcome/location/name context, correlates them into real transactions, and
 * resolves the engine IDs to display names via small seed dictionaries that
 * grow over time — never guessing.
 *
 * PARSER HONESTY (matches app/parser.js's convention, kept independently here
 * since this module must stand alone): every LINE_KIND below carries a
 * `verified` flag. `true` means this exact shape was confirmed against a real
 * captured Game.log line (the feature brief's §2/§9 worked examples). `false`
 * means the shape is built from the brief's documented field list only and
 * has not yet been confirmed against a real line of that kind — treat as a
 * draft to verify, not as ground truth. Never flip one to true without a real
 * matching log line.
 *
 * Data sources — see the feature brief (Game.log Transaction Ledger, drafted
 * 2026-09-11) for the full spec, grammar, and acceptance criteria this
 * implements.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

// --- Line shape -> event kind -------------------------------------------
// Matched by substring on the <Tag> portion of the line, not by position —
// robust to exactly how the timestamp/[Channel] prefix is rendered, and this
// module never assumes app/parser.js's LINE regex is available.
const EVENT_TAGS = [
  { tag: 'CEntityComponentShopUIProvider::SendShopBuyRequest', kind: 'buy_item_kiosk', verified: false },
  { tag: 'CEntityComponentShoppingProvider::SendStandardItemBuyRequest', kind: 'buy_item_standard', verified: false },
  { tag: 'CEntityComponentCommodityUIProvider::SendCommodityBuyRequest', kind: 'buy_commodity', verified: true },
  { tag: 'CEntityComponentCommodityUIProvider::SendCommoditySellRequest', kind: 'sell_commodity', verified: false },
  { tag: 'CEntityComponentMiningShopUIProvider::OnRefineryRequest', kind: 'refinery_order', verified: false },
  // Two known emitters for the outcome line (brief §6.2): the kiosk-UI path
  // carries shopName/kioskId; the "standard" purchase path carries only
  // playerId + result. Both normalize to the same kind; pairing is by
  // arrival order (§6.2), never by field match.
  { tag: 'CEntityComponentShopUIProvider::RmShopFlowResponse', kind: 'shop_flow_response', verified: true },
  { tag: 'CEntityComponentShoppingProvider::RmShopFlowResponse', kind: 'shop_flow_response', verified: false },
  // Fires when the player opens a kiosk — the ONLY source of the physical
  // location for a transaction (shopName is a reusable archetype, not a
  // place; see §2). VERIFIED example line in the brief.
  { tag: 'RequestLocationInventory', kind: 'location_request', verified: true },
  // Opportunistic GUID -> commodity-name harvest while browsing a kiosk.
  // Fragile by design (§4.3) — no literal captured line was given, only the
  // described field (commodityName[ResourceType.X]), so verified:false.
  { tag: 'LoadShopInventoryData', kind: 'commodity_name_hint', verified: false }
];

// Direction per parsed kind — used for the default spend/income split.
const DIRECTION = {
  buy_item_kiosk: 'spend',
  buy_item_standard: 'spend',
  buy_commodity: 'spend',
  sell_commodity: 'income',
  refinery_order: 'spend'
};

const LINE = /^<([^>]+)>/; // leading "<timestamp>" only — this module doesn't need the rest positionally.
const TOKEN = /([A-Za-z_][A-Za-z0-9_]*)\[([^\]]*)\]/g; // key[value] tokens, the log's universal field grammar.

/** Pull every key[value] token out of a line into a plain object. Later
 * duplicates of the same key overwrite earlier ones (rare, harmless). */
function extractTokens (text) {
  const out = {};
  let m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(text))) out[m[1]] = m[2];
  return out;
}

/** "25600.000000 cSCU" -> { value: 25600, unit: 'cSCU' }. "12" -> { value: 12, unit: null }. */
function parseQuantity (raw) {
  if (raw == null) return { value: null, unit: null };
  const m = String(raw).trim().match(/^(-?[\d.]+)\s*([A-Za-z]+)?$/);
  if (!m) return { value: null, unit: null };
  return { value: parseFloat(m[1]), unit: m[2] || null };
}

function toNumber (raw) {
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/** Deterministic short id, self-contained (this module never imports app/server.js's idFor). */
function idFor (content) {
  return crypto.createHash('sha256').update(String(content)).digest('hex').slice(0, 32);
}

// --- Location-ID grammar [feature brief §4.1] ---------------------------
// <system><planetDigit><moonLetter?>_<class>_<style>_<size>_<function>_<faction>_<instance>
// e.g. Pyro5d_Outpost_col_xs_dpt_otlw_001 -> body Pyro V d, class Outpost,
// style colonial, size xs, function depot, faction outlaw, instance 001.
const LOCATION_ID = /^([A-Za-z]+)(\d+)([a-z])?_([A-Za-z0-9]+)_([A-Za-z0-9]+)_([A-Za-z0-9]+)_([A-Za-z0-9]+)_([A-Za-z0-9]+)_(\d+)$/;
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

/** Decode a location id into its grammar parts, or null if it doesn't match
 * the known shape (still usable — resolveLocation() falls back to unresolved). */
function decodeLocationId (id) {
  const m = String(id || '').match(LOCATION_ID);
  if (!m) return null;
  const [, system, planetDigit, moonLetter, klass, style, size, fn, faction, instance] = m;
  const planetNum = parseInt(planetDigit, 10);
  return {
    bodyToken: system + planetDigit + (moonLetter || ''),
    system,
    planet: ROMAN[planetNum] || planetDigit,
    moon: moonLetter || null,
    class: klass,
    style,
    size,
    function: fn,
    faction,
    instance
  };
}

/** Resolve a location id to a display name + confidence, using the seed
 * dictionary. Never invents a name: exact only when the seed pins exactly one
 * place for that (bodyToken, function, faction); otherwise 'inferred' with
 * every real candidate listed, or 'unresolved' with a reason. */
function resolveLocation (locationId, seed) {
  const decoded = decodeLocationId(locationId);
  if (!decoded) return { id: locationId, display: null, confidence: 'unresolved', reason: 'location id did not match the known grammar', decoded: null };

  const bodyDisplay = (seed && seed.bodies && seed.bodies[decoded.bodyToken]) || decoded.bodyToken;
  const outposts = (seed && seed.outposts) || [];
  const candidates = outposts.filter((o) =>
    o.bodyToken === decoded.bodyToken && o.function === decoded.function && o.faction === decoded.faction &&
    (o.instance == null || o.instance === decoded.instance));

  if (!candidates.length) {
    return { id: locationId, display: null, confidence: 'unresolved', reason: `no seed entry for ${decoded.bodyToken}/${decoded.function}/${decoded.faction}`, decoded, system: decoded.system, bodyDisplay };
  }
  // A seed entry with a single `name` is exact; one with `candidates` (or more
  // than one matching entry) is inferred.
  const named = candidates.filter((c) => c.name);
  if (named.length === 1 && candidates.length === 1) {
    return { id: locationId, display: `${named[0].name}, ${bodyDisplay}`, confidence: 'exact', decoded, system: decoded.system, bodyDisplay };
  }
  const names = [];
  for (const c of candidates) { if (c.name) names.push(c.name); if (Array.isArray(c.candidates)) names.push(...c.candidates); }
  return { id: locationId, display: `${[...new Set(names)].join(' or ')}, ${bodyDisplay} (unconfirmed)`, confidence: 'inferred', candidates: [...new Set(names)], decoded, system: decoded.system, bodyDisplay };
}

/** Resolve an item class to a display name. Exact from the seed dictionary,
 * else the raw class name — never a guess. */
function resolveItem (classIdOrName, seed) {
  const key = classIdOrName || '';
  const known = seed && seed.items && seed.items[key];
  if (known) return { display: known, confidence: 'exact' };
  return { display: key || null, confidence: key ? 'unresolved' : 'unresolved' };
}

/** Resolve a commodity GUID to a name using the map harvested at runtime from
 * LoadShopInventoryData lines (+ any operator override). Best-effort by
 * design (§4.3) — the harvested map has no independent confirmation, so this
 * is always reported 'inferred' when found, 'unresolved' otherwise. */
function resolveCommodity (guid, learnedMap) {
  const known = learnedMap && learnedMap[guid];
  if (known) return { display: known, confidence: 'inferred' };
  return { display: null, confidence: 'unresolved' };
}

/** Classify one raw Game.log line into a typed ledger event, or null if it's
 * not one we care about. Pure function — no state, safe to unit test in
 * isolation and safe to lift into another tool. */
function parseLedgerLine (rawLine) {
  const line = String(rawLine);
  const match = EVENT_TAGS.find((e) => line.includes(e.tag));
  if (!match) return null;

  const tsMatch = line.match(LINE);
  const timestamp = tsMatch ? tsMatch[1] : null;
  const t = extractTokens(line);

  const base = { kind: match.kind, verified: match.verified, timestamp, raw: line };

  switch (match.kind) {
    case 'buy_item_kiosk':
    case 'buy_item_standard': {
      const qty = parseQuantity(t.quantity);
      return Object.assign(base, {
        playerId: t.playerId || null, shopId: t.shopId || null, shopArchetype: t.shopName || null,
        kioskId: t.kioskId || null, amount: toNumber(t.client_price != null ? t.client_price : t.price),
        currencyType: t.currencyType || null, itemClass: t.itemClassGUID || null, itemName: t.itemName || null,
        quantity: qty.value, quantityUnit: qty.unit || 'each'
      });
    }
    case 'buy_commodity': {
      const qty = parseQuantity(t.quantity);
      return Object.assign(base, {
        playerId: t.playerId || null, shopId: t.shopId || null, shopArchetype: t.shopName || null,
        kioskId: t.kioskId || null, amount: toNumber(t.price), unitPrice: toNumber(t.shopPricePerCentiSCU),
        resourceGuid: t.resourceGUID || null, quantity: qty.value, quantityUnit: qty.unit || 'cSCU',
        boxSize: toNumber(t.boxSize), unitAmount: toNumber(t.unitAmount)
      });
    }
    case 'sell_commodity': {
      const qty = parseQuantity(t.quantity);
      return Object.assign(base, {
        playerId: t.playerId || null, shopId: t.shopId || null, shopArchetype: t.shopName || null,
        kioskId: t.kioskId || null, amount: toNumber(t.amount), transactionMode: t.transactionMode || null,
        resourceGuid: t.resourceGUID || null, quantity: qty.value, quantityUnit: qty.unit || 'cSCU',
        boxSize: toNumber(t.boxSize), unitAmount: toNumber(t.unitAmount)
      });
    }
    case 'refinery_order': {
      return Object.assign(base, {
        playerId: t.playerId || null, shopId: t.shopId || null, shopArchetype: t.shopName || null,
        kioskId: t.kioskId || null, currencyType: t.currencyType || null, amount: toNumber(t.price)
      });
    }
    case 'shop_flow_response': {
      return Object.assign(base, {
        playerId: t.playerId || null, shopId: t.shopId || null, shopArchetype: t.shopName || null,
        kioskId: t.kioskId || null, kioskState: t.kioskState || null, result: t.result || null, type: t.type || null
      });
    }
    case 'location_request': {
      const locMatch = line.match(/Location\[([^\]]+)\]/);
      return Object.assign(base, { player: t.Player || null, locationId: locMatch ? locMatch[1] : null });
    }
    case 'commodity_name_hint': {
      const nameMatch = line.match(/commodityName\[(?:ResourceType\.)?([^\]]+)\]/);
      return Object.assign(base, { resourceGuid: t.resourceGUID || null, commodityName: nameMatch ? nameMatch[1] : null });
    }
    default:
      return base;
  }
}

/** Recursively list *.log files under dir. Own small walker — deliberately
 * not shared with scripts/backfill.js so this module has zero repo-specific
 * dependencies. */
function walkLogFiles (dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkLogFiles(p));
    else if (/\.log$/i.test(e.name)) out.push(p);
  }
  return out;
}

function loadJsonSafe (file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

const DEFAULT_LOCATIONS_SEED = path.join(__dirname, '..', 'data', 'ledger', 'locations-seed.json');
const DEFAULT_ITEMS_SEED = path.join(__dirname, '..', 'data', 'ledger', 'items-seed.json');

class TransactionLedger {
  /**
   * @param {Object} opts
   * @param {String|null} [opts.file] Persistence path (JSON). null = in-memory only.
   * @param {String} [opts.locationsSeedFile] Override the seed location dictionary.
   * @param {String} [opts.itemsSeedFile] Override the seed item dictionary.
   */
  constructor ({ file = null, locationsSeedFile = DEFAULT_LOCATIONS_SEED, itemsSeedFile = DEFAULT_ITEMS_SEED } = {}) {
    this.file = file;
    this.locationSeed = loadJsonSafe(locationsSeedFile, { bodies: {}, outposts: [] });
    this.itemSeed = loadJsonSafe(itemsSeedFile, { items: {} });

    // Persisted state.
    this.transactions = {};      // id -> transaction row
    this.cursors = {};           // absolute file path -> { size, mtime }
    this.commodityNames = {};    // resourceGUID -> harvested/learned name
    this.overrides = { locations: {}, items: {} }; // operator corrections, keyed by raw id/class
    this._load();

    // Runtime-only scratch (never persisted; rebuilt per session/file).
    this._pending = [];       // FIFO of open buy/sell requests awaiting a shop_flow_response
    this._lastLocation = null; // { locationId, player, ts } — most recent RequestLocationInventory
    this._session = { file: 'live', buildId: null };
  }

  // ---- persistence --------------------------------------------------
  _load () {
    if (!this.file) return;
    const data = loadJsonSafe(this.file, null);
    if (!data) return;
    this.transactions = data.transactions || {};
    this.cursors = data.cursors || {};
    this.commodityNames = data.commodityNames || {};
    this.overrides = data.overrides || { locations: {}, items: {} };
  }

  _persist () {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({
        transactions: this.transactions, cursors: this.cursors,
        commodityNames: this.commodityNames, overrides: this.overrides
      }));
    } catch (_) { /* non-fatal — never break the caller over a disk hiccup */ }
  }

  // ---- session context (which file/build a batch of observe() calls belongs to) ----
  setSession ({ file = 'live', buildId = null } = {}) {
    this._session = { file, buildId };
  }

  // ---- resolution (kept live so operator corrections apply without re-parsing) ----
  _resolveRow (row) {
    const loc = row.locationId ? resolveLocation(row.locationId, this.locationSeed) : { display: null, confidence: 'unresolved', reason: 'no location captured before this transaction' };
    const locOverride = row.locationId && this.overrides.locations[row.locationId];
    row.locationDisplay = locOverride || loc.display;
    row.locationConfidence = locOverride ? 'exact' : loc.confidence;
    row.system = loc.system || null;

    if (row.itemClass) {
      const itemOverride = this.overrides.items[row.itemClass];
      const item = resolveItem(row.itemClass, this.itemSeed);
      row.itemDisplay = itemOverride || item.display;
    }
    if (row.resourceGuid) {
      const resOverride = this.overrides.items[row.resourceGuid];
      const res = resolveCommodity(row.resourceGuid, this.commodityNames);
      row.resourceDisplay = resOverride || res.display;
    }
    return row;
  }

  /** Re-apply resolution to every stored row (call after learnLocation/learnItem
   * or after growing a seed dictionary, so existing rows pick up the fix). */
  reresolveAll () {
    for (const row of Object.values(this.transactions)) this._resolveRow(row);
    this._persist();
  }

  learnLocation (locationId, display) { this.overrides.locations[locationId] = display; this.reresolveAll(); }
  learnItem (classIdOrGuid, display) { this.overrides.items[classIdOrGuid] = display; this.reresolveAll(); }

  // ---- ingestion ------------------------------------------------------
  /** Feed one raw log line. Safe to call for every line of a live tail —
   * lines this module doesn't care about are a fast no-op. */
  observe (rawLine) {
    const ev = parseLedgerLine(rawLine);
    if (!ev) return null;

    if (ev.kind === 'location_request') {
      this._lastLocation = { locationId: ev.locationId, player: ev.player, ts: ev.timestamp };
      return null;
    }
    if (ev.kind === 'commodity_name_hint') {
      if (ev.resourceGuid && ev.commodityName) this.commodityNames[ev.resourceGuid] = ev.commodityName;
      return null;
    }
    if (ev.kind === 'shop_flow_response') {
      const pending = this._pending.shift(); // pair by arrival order (§6.2) — never by field match
      if (!pending) return null;
      return this._commit(pending, ev);
    }
    // One of the five request kinds: hold it until its response arrives.
    this._pending.push(ev);
    return null;
  }

  /** Any request still waiting for a response at end-of-file/session becomes
   * an explicit Unknown-result row rather than silently vanishing (§6.1). */
  flushPending () {
    const left = this._pending;
    this._pending = [];
    for (const ev of left) this._commit(ev, { result: 'Unknown' });
  }

  _commit (requestEv, responseEv) {
    const direction = DIRECTION[requestEv.kind] || 'spend';
    const id = idFor([requestEv.timestamp, requestEv.shopId, requestEv.kioskId, requestEv.amount, requestEv.quantity].join('|'));
    if (this.transactions[id]) return this.transactions[id]; // idempotent — same event committed twice is a no-op

    const row = {
      id,
      utcTs: requestEv.timestamp,
      sessionFile: this._session.file,
      buildId: this._session.buildId,
      kind: requestEv.kind,
      direction,
      amountAuec: requestEv.amount,
      quantity: requestEv.quantity,
      quantityUnit: requestEv.quantityUnit || null,
      unitPrice: requestEv.unitPrice != null ? requestEv.unitPrice : null,
      itemClass: requestEv.itemClass || null,
      resourceGuid: requestEv.resourceGuid || null,
      shopArchetype: requestEv.shopArchetype || null,
      shopId: requestEv.shopId || null,
      kioskId: requestEv.kioskId || null,
      locationId: this._lastLocation ? this._lastLocation.locationId : null,
      result: responseEv.result || 'Unknown',
      verified: requestEv.verified
    };
    this._resolveRow(row);
    this.transactions[id] = row;
    this._persist();
    return row;
  }

  /** Ingest one file. Streams via readline (never loads the whole file into
   * memory) and is idempotent: a file whose size+mtime match the stored
   * cursor is skipped entirely, satisfying re-ingestion producing zero new
   * rows without re-reading a byte. */
  ingestFile (filePath) {
    const abs = path.resolve(filePath);
    let stat;
    try { stat = fs.statSync(abs); } catch (_) { return { skipped: true, reason: 'stat failed' }; }
    const cursor = this.cursors[abs];
    if (cursor && cursor.size === stat.size && cursor.mtime === stat.mtimeMs) {
      return { skipped: true, reason: 'unchanged since last ingest' };
    }

    this.setSession({ file: path.basename(abs), buildId: this._session.buildId });
    const before = Object.keys(this.transactions).length;

    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: fs.createReadStream(abs), crlfDelay: Infinity });
      rl.on('line', (line) => { try { this.observe(line); } catch (_) { /* one bad line never aborts the file */ } });
      rl.on('close', () => {
        this.flushPending();
        this.cursors[abs] = { size: stat.size, mtime: stat.mtimeMs };
        this._persist();
        resolve({ skipped: false, added: Object.keys(this.transactions).length - before });
      });
      rl.on('error', () => resolve({ skipped: false, added: Object.keys(this.transactions).length - before, error: true }));
    });
  }

  /** Ingest every *.log file found under each of `dirs` (files or directories
   * accepted). Returns a summary; safe to call repeatedly (unchanged files
   * are skipped via ingestFile's cursor check). */
  async ingestPaths (dirs) {
    const files = [];
    for (const d of dirs) {
      let isDir = false;
      try { isDir = fs.statSync(d).isDirectory(); } catch (_) { continue; }
      files.push(...(isDir ? walkLogFiles(d) : [d]));
    }
    let scanned = 0, skipped = 0, added = 0;
    for (const f of files) {
      const r = await this.ingestFile(f);
      scanned++;
      if (r.skipped) skipped++; else added += r.added || 0;
    }
    return { filesFound: files.length, filesScanned: scanned, filesSkippedUnchanged: skipped, transactionsAdded: added };
  }

  // ---- query surface --------------------------------------------------
  all () { return Object.values(this.transactions); }

  query ({ from, to, system, locationId, direction, kind, includeNonSuccess = false } = {}) {
    const fromT = from ? Date.parse(from) : -Infinity;
    const toT = to ? Date.parse(to) : Infinity;
    return this.all()
      .filter((r) => {
        const t = Date.parse(r.utcTs);
        if (!Number.isNaN(t) && (t < fromT || t > toT)) return false;
        if (system && r.system !== system) return false;
        if (locationId && r.locationId !== locationId) return false;
        if (direction && r.direction !== direction) return false;
        if (kind && r.kind !== kind) return false;
        if (!includeNonSuccess && r.result !== 'Success') return false;
        return true;
      })
      .sort((a, b) => (a.utcTs < b.utcTs ? -1 : a.utcTs > b.utcTs ? 1 : 0));
  }

  /** Net spend/income position over a range (Success rows only, by default —
   * matches query()'s default and §6.1's rule). */
  summary (opts = {}) {
    const rows = this.query(opts);
    let spend = 0, income = 0;
    const bySystem = {};
    for (const r of rows) {
      const amt = r.amountAuec || 0;
      if (r.direction === 'income') income += amt; else spend += amt;
      const sys = r.system || 'Unknown';
      bySystem[sys] = (bySystem[sys] || 0) + (r.direction === 'income' ? amt : -amt);
    }
    return { count: rows.length, spend, income, net: income - spend, bySystem };
  }

  /** CSV export — every column of the data model round-trips (§7). */
  toCSV (rows) {
    const cols = ['id', 'utcTs', 'sessionFile', 'buildId', 'kind', 'direction', 'amountAuec', 'quantity',
      'quantityUnit', 'unitPrice', 'itemClass', 'itemDisplay', 'resourceGuid', 'resourceDisplay',
      'shopArchetype', 'shopId', 'kioskId', 'locationId', 'locationDisplay', 'locationConfidence',
      'system', 'result', 'verified'];
    const esc = (v) => {
      if (v == null) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [cols.join(',')];
    for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(','));
    return lines.join('\n');
  }

  stats () {
    return {
      transactions: Object.keys(this.transactions).length,
      filesIngested: Object.keys(this.cursors).length,
      commodityNamesLearned: Object.keys(this.commodityNames).length,
      pendingUnpaired: this._pending.length
    };
  }
}

module.exports = {
  TransactionLedger,
  // Pure helpers exported for standalone reuse/testing — the whole point of
  // keeping this module portable.
  parseLedgerLine, decodeLocationId, resolveLocation, resolveItem, resolveCommodity,
  extractTokens, parseQuantity, walkLogFiles, idFor
};
