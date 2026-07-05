'use strict';

/**
 * CargoRouter — optional, self-contained cargo-mission route optimizer.
 *
 * ┌─ SEPARABLE BY DESIGN ───────────────────────────────────────────────────┐
 * │ This whole feature is ONE module + one flag + one UI panel. It does its  │
 * │ own log extraction (it never touches app/parser.js) and couples to the   │
 * │ relay only through `observe(rawLine, parsedEvent)`. To remove it: delete │
 * │ this file, drop the `cargo:` settings flag + the two /cargo,/route routes │
 * │ in app/server.js, and the Cargo-route panel in app/ui.html. Core relay is │
 * │ untouched and its tests stay green. Zero runtime dependencies (D-002).   │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Model is MISSION-centric: every accepted hauling contract is shown, with its
 * pickup/dropoff/cargo filled in as the log reveals them. A contract names ONE
 * endpoint in its accept line — "Contract Accepted: <title> | from <Pickup>" OR
 * "| to <Dropoff>" — so a mission appears the moment it's accepted, before any
 * "Deliver N SCU" objective fires. The "Route" button groups missions by their
 * pickup hub and orders dropoffs by celestial body.
 *
 * Data sources (VERIFIED in the real corpus + live 4.8.0 logs):
 *  - Accept:    <SHUDEvent_OnNotification> "Contract Accepted: <title> | from|to
 *               <Endpoint> <EM..>" + MissionId  → the named pickup or dropoff.
 *  - Manifest:  <SHUDEvent_OnNotification> "Deliver H/N SCU of <Commodity> to
 *               <Dest>" + MissionId + ObjectiveId[dropoff_<GUID>_<idx>] → cargo.
 *  - Station:   <CreateHaulingObjectiveHandler> "Dropoff created ... locationName:
 *               <Station> [<Token>]" → specific station; <System>_<N> token = body.
 *  Body is inferred from the station-name prefix (HUR-/CRU-/ARC-/MIC-) or the
 *  token — no external API, no hand-kept station list.
 *
 * Honesty: reads the local player's own accepted missions (self-reported). After
 * a crash / exit-to-menu the game logs no <EndMission>, so missions not re-seen
 * this session are flagged "carried over" (verify), not silently kept. "Optimal"
 * is a body-clustered heuristic, not a shortest-3D-path solve.
 */

// Terminal statuses — a mission in any of these leaves the active board and drops
// into the greyed "Done" section (never silently deleted; owner decision, §logEnd).
// 'cleared' = user/housekeeping dismiss of a carried-over haul, distinct from a real
// in-game outcome (completed/abandoned/failed) so the label stays honest.
const TERMINAL = ['completed', 'abandoned', 'failed', 'cleared'];

// Circuit order per body name (drives the stop sequence). Lower = visited first.
const STANTON = { 1: 'Hurston', 2: 'Crusader', 3: 'ArcCorp', 4: 'microTech' };
const BODY_ORDER = { Hurston: 1, Crusader: 2, ArcCorp: 3, microTech: 4, 'Asteroid bases': 5, Pyro: 6 };

// UEX reference (committed data/uex-reference.json, baked by `npm run build-vocab`).
// Loaded ONCE, offline; an absent file degrades gracefully to the regex-only path
// below (so tests/installs without the snapshot still work). This is the relay's
// only knowledge of UEX — it never calls the network (D-002).
let _ref = null;
function normName (s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); }
function reference () {
  if (_ref) return _ref;
  _ref = { commodities: [], locations: [], bodyIndex: new Map() };
  try {
    const fs = require('fs'), path = require('path');
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'uex-reference.json'), 'utf8'));
    _ref.commodities = j.commodities || [];
    _ref.locations = j.locations || [];
    for (const l of _ref.locations) if (l.name && l.body) _ref.bodyIndex.set(normName(l.name), l.body);
  } catch (_) { /* no snapshot yet -> regex-only inference, still correct for known hubs */ }
  return _ref;
}

// Infer the celestial body from a station NAME. Prefer an EXACT match against the
// UEX place list (authoritative station->planet); fall back to the prefix/hub regex
// for the messy cases UEX doesn't carry (HDPC-*, planet-prefixed log names, etc.).
function bodyFromStation (name) {
  const uex = reference().bodyIndex.get(normName(name));
  if (uex) return uex;
  const n = String(name).toLowerCase();
  if (/^arc-|area ?18|baijini|riker|arccorp/.test(n)) return 'ArcCorp';
  if (/^cru-|orison|seraphim|ambitious dream|crusader/.test(n)) return 'Crusader';
  // HDPC-* are Hurston Distribution Pickup Centers (e.g. HDPC-Cassillo, HDPC-Farnesway),
  // verified against a real 4.8.0 "Small Haul" contract ("...on Hurston").
  if (/^hur-|everus|hurston|hdpc-|lorville|teasa/.test(n)) return 'Hurston';
  if (/^mic-|tressler|new babbage|microtech/.test(n)) return 'microTech';
  if (/wikelo|collector/.test(n)) return 'Asteroid bases';
  // Pyro: orbital stations + surface outposts (no planet prefix, matched by name).
  if (/pyro|ruin station|checkmate|rod'?s end|rat'?s nest|dudley|patch city|gaslight|orbituary|starlight|seer'?s canyon|rustville|shepherd'?s rest|bueno|last landing|ashland|chawla|canard|sacren|fallow field|sunset mesa|refinery ravine|megumi|endgame|terminus|feo |dunboro|prospect depot/.test(n)) return 'Pyro';
  return null;
}
function bodyFromToken (token) {
  const m = String(token).match(/(Stanton|Pyro)_?(\d)/i);
  if (!m) return { sys: null, num: null, name: null };
  const sys = m[1], num = Number(m[2]);
  const name = sys.toLowerCase() === 'stanton' ? (STANTON[num] || ('Stanton ' + num)) : (sys + ' ' + num);
  return { sys, num, name };
}
function isGenericSystem (dest) { return /^(stanton|pyro)\s+system$/i.test(String(dest).trim()); }

const ACCEPT_RE = /Contract Accepted:\s*(.+?)\s*(?:<EM\d|:\s*")[\s\S]*?MissionId:\s*\[([0-9a-fA-F-]+)\]/;
const OBJECTIVE_RE = /Deliver (\d+)\/(\d+) SCU of (.+?) to ([^:"]+?):.*?MissionId:\s*\[([0-9a-fA-F-]+)\],\s*ObjectiveId:\s*\[(dropoff_[0-9a-fA-F-]+_\d+)\]/;
const DROPOFF_RE = /Dropoff created.*?locationName:\s*(.+?)\s*\[([^\]]+)\].*?objectiveId:\s*(dropoff_[0-9a-fA-F-]+(?:_\d+)*)/;
const GUID_RE = /dropoff_([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';

class CargoRouter {
  constructor () {
    this.missions = {};        // missionId -> mission (log-derived)
    this.stationByGuid = {};   // dropoff GUID -> { station, token, body }
    this.session = 0;          // increments on each new game session ("Log started on")
    // --- Manual board layer (Phase 1): user overrides + hand-added candidates,
    // persisted to an optional JSON file so they survive a relay restart. The user
    // is the authority — precedence is manual > log > OCR. ---
    this.file = (arguments[0] && arguments[0].file) || null;
    this.manual = { overrides: {}, added: {}, order: [], config: { screensDir: null, lastProcessed: 0 }, vocab: { commodities: [], locations: [] } };
    this._c = 0;
    this._load();
  }

  _load () {
    if (!this.file) return;
    try { const fs = require('fs'); if (fs.existsSync(this.file)) { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.manual = { overrides: j.overrides || {}, added: j.added || {}, order: j.order || [], config: j.config || { screensDir: null, lastProcessed: 0 }, vocab: j.vocab || { commodities: [], locations: [] } }; } } catch (e) { /* ignore a corrupt store */ }
  }

  // ---- Folder-watch config (Phase 2 slice 3). The server lists/serves files;
  // the BROWSER does the OCR. Config survives purge. ----
  getConfig () { return this.manual.config || (this.manual.config = { screensDir: null, lastProcessed: 0, cropRegion: null }); }
  setScreensDir (dir) { this.getConfig().screensDir = dir || null; this._save(); }
  setCropRegion (r) { this.getConfig().cropRegion = (r && r.w > 0 && r.h > 0) ? { x: +r.x, y: +r.y, w: +r.w, h: +r.h } : null; this._save(); }
  markProcessed (mtime) { const c = this.getConfig(); if (Number(mtime) > (c.lastProcessed || 0)) { c.lastProcessed = Number(mtime); this._save(); } }
  _save () {
    if (!this.file) return;
    try { const fs = require('fs'), path = require('path'); fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.manual)); } catch (e) { /* non-fatal */ }
  }

  _guid (objectiveId) { const m = String(objectiveId).match(GUID_RE); return m ? m[1].toLowerCase() : null; }
  _mission (id) {
    return this.missions[id] || (this.missions[id] = { missionId: id, title: null, pickup: null, titleDropoff: null, parcels: {}, lastSession: this.session });
  }

  observe (rawLine, ev) {
    // Fresh session (relaunch after crash/exit). DON'T wipe — a crash logs no
    // <EndMission>, so missions may still be live. Bump the counter; route() flags
    // anything not re-confirmed this session as "carried over".
    if (ev && ev.kind === 'session:start') this.session += 1;
    if (ev && ev.kind === 'mission:end' && ev.missionId) this.logEnd(ev.missionId, ev.completionType);
    this.ingest(String(rawLine));
  }

  ingest (line) {
    let m;
    // Contract acceptance — names the pickup ("| from X") OR the dropoff ("| to Y").
    if ((m = line.match(ACCEPT_RE))) {
      const title = m[1].trim(), missionId = m[2];
      // "Contract Accepted" also fires for bounties / mercenary / etc. Only track
      // HAULING contracts — gate on a hauling-ish title, or a mission we already
      // know is cargo (it logged a Deliver objective). Stops non-cargo contracts
      // showing up as "accepted but no cargo line".
      const isHaul = /\b(haul|cargo|freight|deliver)/i.test(title);
      if (missionId !== ZERO_GUID && (isHaul || this.missions[missionId])) {
        const mi = this._mission(missionId);
        mi.title = title; mi.lastSession = this.session;
        // Reward tiers live in the "<EM4>[50/200/.. Rep]" segment (reputation, not aUEC).
        const rew = line.match(/<EM\d>\[([^\]]+)\]/);
        if (rew) mi.reward = rew[1].trim();
        const dir = title.match(/\|\s*(from|to)\s+(.+?)\s*$/i);
        if (dir) { if (/^from$/i.test(dir[1])) mi.pickup = dir[2].trim(); else mi.titleDropoff = dir[2].trim(); }
      }
      return 'accept';
    }
    // Delivery objective — commodity + SCU + dropoff + dropoff GUID.
    if ((m = line.match(OBJECTIVE_RE))) {
      const [, have, need, commodity, destRaw, missionId, dropKey] = m;
      if (missionId === ZERO_GUID) return null;
      const dest = destRaw.trim();
      const guid = this._guid(dropKey);
      const handler = guid && this.stationByGuid[guid];
      let station = null, body = null;
      if (!isGenericSystem(dest)) { station = dest; body = { name: bodyFromStation(dest) }; }
      else if (handler) { station = handler.station; body = handler.body; }
      const mi = this._mission(missionId);
      mi.lastSession = this.session;
      mi.parcels[dropKey] = { dropKey, guid, commodity: commodity.trim(), scuHave: Number(have), scuNeed: Number(need), destSystem: dest, station, body };
      this.learnVocab('commodity', commodity.trim()); this.learnVocab('location', station);
      return 'objective';
    }
    // Hauling handler — names the specific dropoff station for a dropoff GUID.
    if ((m = line.match(DROPOFF_RE))) {
      const [, station, token, objectiveId] = m;
      const guid = this._guid(objectiveId);
      if (!guid) return null;
      const body = bodyFromToken(token);
      this.stationByGuid[guid] = { station: station.trim(), token, body };
      this.learnVocab('location', station.trim());
      for (const mi of Object.values(this.missions)) {
        for (const p of Object.values(mi.parcels)) if (p.guid === guid && !p.station) { p.station = station.trim(); p.body = body; }
      }
      return 'station';
    }
    return null;
  }

  // Log says the mission ended. DON'T delete — grey it out with a status so it
  // ages into the "Done" section instead of silently vanishing (owner decision).
  logEnd (missionId, completionType) {
    const mi = this.missions[missionId];
    if (!mi) return;
    const c = String(completionType || '');
    mi.status = /abandon/i.test(c) ? 'abandoned' : /fail/i.test(c) ? 'failed' : /deactiv/i.test(c) ? 'abandoned' : 'completed';
    mi.statusSource = 'log';
  }

  // ---- Manual board actions (Phase 1). Precedence: manual override > log > OCR. ----
  _ov (id) { return this.manual.overrides[id] || (this.manual.overrides[id] = {}); }
  setStatus (id, status) { if (status) this._ov(id).status = status; else delete this._ov(id).status; this._save(); }
  togglePickup (id, dropKey, val) { const o = this._ov(id); o.pickedUp = o.pickedUp || {}; o.pickedUp[dropKey] = (val === undefined) ? !o.pickedUp[dropKey] : !!val; this._save(); }
  setNotes (id, notes) { const n = String(notes || ''); if (n) this._ov(id).notes = n; else delete this._ov(id).notes; this._save(); }
  setSnooze (id, val) { const o = this._ov(id); if (val === undefined ? !o.snoozed : val) o.snoozed = true; else delete o.snoozed; this._save(); }
  setPin (id, val) { const o = this._ov(id); if (val === undefined ? !o.pinned : val) o.pinned = true; else delete o.pinned; this._save(); }
  setOrder (ids) { this.manual.order = Array.isArray(ids) ? ids.slice() : []; this._save(); }
  // User-entered cargo for a mission the game hasn't revealed yet (accepted-but-not-
  // loaded, or pickup-only "deliver to X"). Stored as an override so it attaches to a
  // LOG mission without pretending the log produced it — legs render as ✋ user-entered.
  setParcels (id, parcels) {
    const o = this._ov(id);
    if (Array.isArray(parcels) && parcels.length) {
      o.parcels = parcels.map((p, i) => ({ dropKey: 'u' + i, commodity: String(p.commodity || '').trim() || null,
        scuHave: 0, scuNeed: Number(p.scu != null ? p.scu : p.scuNeed) || 0, station: String(p.dropoff || p.station || '').trim() || null, user: true }))
        .filter((p) => p.commodity || p.station || p.scuNeed);
      for (const p of o.parcels) { this.learnVocab('commodity', p.commodity); this.learnVocab('location', p.station); }
      if (!o.parcels.length) delete o.parcels;
    } else delete o.parcels;
    this._save();
  }
  // Pickup the log doesn't record ("deliver to X" contracts on 4.8.0) — user supplies it.
  setPickup (id, pickup) { const o = this._ov(id); const v = String(pickup || '').trim(); if (v) { o.pickup = v; this.learnVocab('location', v); } else delete o.pickup; this._save(); }
  // Effective parcels/pickup: log data wins; user-entered overrides fill the gap.
  _parcels (mi) {
    if (Object.keys(mi.parcels || {}).length) return mi.parcels;
    const ov = this.manual.overrides[mi.missionId];
    if (ov && Array.isArray(ov.parcels) && ov.parcels.length) { const o = {}; for (const p of ov.parcels) o[p.dropKey] = p; return o; }
    return mi.parcels || {};
  }
  _pickupOf (mi) { const ov = this.manual.overrides[mi.missionId]; return (ov && ov.pickup) || mi.pickup || null; }
  _hasUserCargo (mi) { return !Object.keys(mi.parcels || {}).length && !!(this.manual.overrides[mi.missionId] && this.manual.overrides[mi.missionId].parcels); }
  addManual (d = {}) {
    const id = d.id || ('m-' + Date.now().toString(36) + '-' + (++this._c));
    // A haul can list SEVERAL pickup locations ("collect from any of these") — keep them all.
    const pickupList = (Array.isArray(d.pickups) && d.pickups.length)
      ? [...new Set(d.pickups.map((p) => (p && p.from) || p).filter(Boolean))]
      : (d.pickup ? [d.pickup] : []);
    const mi = { missionId: id, source: d.source || 'manual', status: d.status || 'candidate',
      title: d.title || null, pickup: d.pickup || pickupList[0] || null, pickupList, titleDropoff: d.dropoff || null,
      reward: d.reward || null, contractType: d.contractType || d.type || 'Manual', parcels: {}, lastSession: this.session,
      identity: this._identity(d) };
    const mkParcel = (i, commodity, scu, station, body) => ({ dropKey: 'm' + i, commodity: commodity || null, scuHave: 0, scuNeed: Number(scu) || 0, station: station || null, body: station ? { name: body || bodyFromStation(station) } : null });
    if (Array.isArray(d.deliveries) && d.deliveries.length) {   // multi-drop (OCR import)
      d.deliveries.forEach((dl, i) => { mi.parcels['m' + i] = mkParcel(i, dl.commodity, dl.scu, dl.dropoff || d.dropoff, dl.body); });
    } else if (d.dropoff || d.commodity || d.scu) {
      mi.parcels.m0 = mkParcel(0, d.commodity, d.scu, d.dropoff);
    }
    this.manual.added[id] = mi; this._learnFromMission(mi); this._save(); return mi;
  }
  // Contract identity for dedup (Phase 2): type + primary endpoint + reward, lowercased.
  _identity (d) {
    // Key on the DROPOFF (stable), not the pickup (OCR fills it later — unstable).
    const ep = d.dropoff || (Array.isArray(d.deliveries) && d.deliveries[0] && d.deliveries[0].dropoff) || d.pickup || '';
    return [String(d.contractType || '').toLowerCase().trim(), String(ep).toLowerCase().trim(), String(d.reward || '').replace(/\D/g, '')].join('|');
  }
  removeManual (id) { delete this.manual.added[id]; delete this.manual.overrides[id]; this._save(); }

  // ---- Vocabulary (dropdown data) — UEX seed ∪ user/observed learned entries ----
  // The combobox reads vocab(); anything the log/OCR/user supplies that UEX doesn't
  // have is remembered here, so the picker self-populates to the player's game build.
  _vocab () { return this.manual.vocab || (this.manual.vocab = { commodities: [], locations: [] }); }
  vocab () {
    const ref = reference();
    const learned = this._vocab();
    const seenC = new Set(ref.commodities.map((c) => normName(c.name)));
    const seenL = new Set(ref.locations.map((l) => normName(l.name)));
    const commodities = ref.commodities.map((c) => ({ name: c.name, illegal: !!c.illegal, kind: c.kind || null, source: 'uex' }))
      .concat((learned.commodities || []).filter((c) => !seenC.has(normName(c.name))).map((c) => ({ name: c.name, illegal: false, kind: null, source: 'learned' })));
    const locations = ref.locations.map((l) => ({ name: l.name, body: l.body || null, system: l.system || null, kind: l.kind || null, source: 'uex' }))
      .concat((learned.locations || []).filter((l) => !seenL.has(normName(l.name))).map((l) => ({ name: l.name, body: bodyFromStation(l.name) || null, system: null, kind: null, source: 'learned' })));
    return { source: ref.source || null, generatedAt: ref.generatedAt || null, commodities, locations };
  }
  // Remember a value if it's genuinely new (not already in UEX or learned). Returns
  // true only when something was added (so passive log-learning no-ops after first).
  learnVocab (kind, value) {
    const key = kind === 'commodity' ? 'commodities' : kind === 'location' ? 'locations' : null;
    const name = String(value == null ? '' : value).trim();
    if (!key || !name || name.length > 80 || isGenericSystem(name)) return false;
    const ref = reference();
    const nk = normName(name);
    const seed = key === 'commodities' ? ref.commodities : ref.locations;
    if (seed.some((x) => normName(x.name) === nk)) return false;         // already in UEX
    const v = this._vocab(); const list = v[key] || (v[key] = []);
    if (list.some((x) => normName(x.name) === nk)) return false;          // already learned
    if (list.length >= 500) return false;                                // sanity cap
    list.push({ name }); this._save(); return true;
  }
  // Prune a learned entry (typo/OCR junk). UEX seed entries are read-only (can't remove).
  unlearnVocab (kind, value) {
    const key = kind === 'commodity' ? 'commodities' : kind === 'location' ? 'locations' : null;
    if (!key) return false;
    const v = this._vocab(); const nk = normName(value);
    const before = (v[key] || []).length;
    v[key] = (v[key] || []).filter((x) => normName(x.name) !== nk);
    if (v[key].length !== before) { this._save(); return true; }
    return false;
  }
  // Live refresh seam (foundation; default OFF — the relay is offline-first, D-002).
  // The server calls this with freshly-fetched UEX data behind an opt-in flag; here
  // we just swap the in-memory reference + rebuild the body index.
  setReference (data) {
    const ref = reference();
    if (data && Array.isArray(data.commodities)) ref.commodities = data.commodities;
    if (data && Array.isArray(data.locations)) {
      ref.locations = data.locations;
      ref.bodyIndex = new Map();
      for (const l of ref.locations) if (l.name && l.body) ref.bodyIndex.set(normName(l.name), l.body);
    }
    return { commodities: ref.commodities.length, locations: ref.locations.length };
  }
  // Learn every commodity/known-station a mission carries (passive vocab growth).
  _learnFromMission (mi) {
    if (!mi) return;
    for (const p of Object.values(mi.parcels || {})) { this.learnVocab('commodity', p.commodity); this.learnVocab('location', p.station); }
    for (const pk of (mi.pickupList || (mi.pickup ? [mi.pickup] : []))) this.learnVocab('location', pk);
    this.learnVocab('location', mi.titleDropoff);
  }
  // Import with dedup (Phase 2): a re-import of the same contract MERGES (fills
  // blanks, adds new drops) rather than duplicating — the idempotency invariant.
  importContract (d = {}) {
    const idn = this._identity(d);
    const bare = idn.replace(/\|/g, '').trim();
    const existing = bare ? Object.values(this.manual.added).find((mi) => mi.identity === idn) : null;
    if (existing) { this._mergeInto(existing, d); this._save(); return { merged: true, id: existing.missionId }; }
    const mi = this.addManual(d);
    return { merged: false, id: mi.missionId };
  }
  _mergeInto (mi, d) {
    if (!mi.pickup && d.pickup) mi.pickup = d.pickup;
    // union the pickup lists (a re-import may reveal pickups the first read missed)
    const incoming = (Array.isArray(d.pickups) && d.pickups.length) ? d.pickups.map((p) => (p && p.from) || p).filter(Boolean) : (d.pickup ? [d.pickup] : []);
    if (incoming.length) { mi.pickupList = [...new Set([...(mi.pickupList || (mi.pickup ? [mi.pickup] : [])), ...incoming])]; if (!mi.pickup) mi.pickup = mi.pickupList[0]; }
    if (!mi.reward && d.reward) mi.reward = d.reward;
    if (!mi.titleDropoff && d.dropoff) mi.titleDropoff = d.dropoff;
    if (d.contractType && (!mi.contractType || mi.contractType === 'Manual')) mi.contractType = d.contractType;
    if (Array.isArray(d.deliveries)) {                    // add drops we don't already have (forward-only)
      const have = new Set(Object.values(mi.parcels).map((p) => (p.commodity || '').toLowerCase() + '|' + (p.station || '').toLowerCase()));
      let n = Object.keys(mi.parcels).length;
      for (const dl of d.deliveries) { const key = (dl.commodity || '').toLowerCase() + '|' + (dl.dropoff || '').toLowerCase();
        if (!have.has(key)) { const k = 'm' + (n++); mi.parcels[k] = { dropKey: k, commodity: dl.commodity || null, scuHave: 0, scuNeed: Number(dl.scu) || 0, station: dl.dropoff || null, body: dl.dropoff ? { name: dl.body || bodyFromStation(dl.dropoff) } : null }; have.add(key); } }
    }
    mi.lastSeen = Date.now();
    this._learnFromMission(mi);
  }
  purge () { this.manual = { overrides: {}, added: {}, order: [], config: this.getConfig(), vocab: this._vocab() }; this._save(); }

  // ---- status resolution (manual override wins, then log, then derived) ----
  _allMissions () { return Object.values(this.missions).concat(Object.values(this.manual.added)); }
  _fullyDelivered (mi) { const p = Object.values(mi.parcels).filter((x) => x.scuNeed > 0); return p.length > 0 && p.every((x) => x.scuHave >= x.scuNeed); }
  statusOf (mi) {
    const ov = this.manual.overrides[mi.missionId];
    if (ov && ov.status) return ov.status;          // manual wins
    if (mi.status) return mi.status;                // log status
    if (this._fullyDelivered(mi)) return 'completed';
    return mi.source === 'manual' ? 'candidate' : 'active';
  }
  // Active board missions (not done) — used by /cargo and the router.
  activeMissions () { return this._allMissions().filter((mi) => !TERMINAL.includes(this.statusOf(mi))); }

  // A log-derived mission last confirmed in an EARLIER game session — "carried over".
  // (Manual/OCR entries are user-owned, never auto-flagged stale.)
  _stale (mi) { return mi.source !== 'manual' && this.session > 0 && mi.lastSession < this.session; }

  // Bulk "Clear carried-over": dismiss every stale log mission still on the active
  // board. Sets a manual 'cleared' override (reversible via reactivate ↺), which is
  // why it's an override and not a delete — the log can't re-derive it, so wiping it
  // would lose the user's decision on relay restart. Returns how many were cleared.
  clearStale () {
    let n = 0;
    for (const mi of Object.values(this.missions)) {
      if (this._stale(mi) && !TERMINAL.includes(this.statusOf(mi))) { this._ov(mi.missionId).status = 'cleared'; n += 1; }
    }
    if (n) this._save();
    return n;
  }

  // The "Route" button. Groups active missions by pickup hub; orders each hub's
  // dropoffs by celestial body. opts.shipScu flags over-capacity hubs;
  // opts.freshOnly hides carried-over (unconfirmed-this-session) missions.
  route (opts = {}) {
    const DONE = TERMINAL;
    const staleOf = (mi) => this._stale(mi);
    const pickedUpOf = (id, dropKey) => { const o = this.manual.overrides[id]; return !!(o && o.pickedUp && o.pickedUp[dropKey]); };
    const all = this._allMissions();

    // Done section (greyed): completed / abandoned / failed — never silently dropped.
    const done = all.filter((mi) => DONE.includes(this.statusOf(mi))).map((mi) => {
      const parts = String(mi.title || '').split('|').map((x) => x.trim()).filter(Boolean);
      return { missionId: mi.missionId, status: this.statusOf(mi), source: mi.source || 'log',
        contractType: parts.length >= 3 ? parts[1] : (mi.contractType || 'Hauling contract'),
        dropoff: mi.titleDropoff || (Object.values(mi.parcels)[0] && Object.values(mi.parcels)[0].station) || null };
    });

    let missions = all.filter((mi) => !DONE.includes(this.statusOf(mi)));
    if (opts.freshOnly) missions = missions.filter((mi) => !staleOf(mi));

    const ovOf = (mi) => this.manual.overrides[mi.missionId] || {};
    const orderIdx = (id) => { const i = (this.manual.order || []).indexOf(id); return i < 0 ? 1e6 : i; };
    const brief = (mi) => { const parts = String(mi.title || '').split('|').map((x) => x.trim()).filter(Boolean);
      return { missionId: mi.missionId, source: mi.source || 'log', contractType: parts.length >= 3 ? parts[1] : (mi.contractType || 'Hauling contract'),
        dropoff: mi.titleDropoff || (Object.values(mi.parcels)[0] && Object.values(mi.parcels)[0].station) || null }; };
    // Snoozed = hidden from the active board but kept (own section).
    const snoozed = missions.filter((mi) => ovOf(mi).snoozed).map(brief);
    missions = missions.filter((mi) => !ovOf(mi).snoozed);

    const byHub = {};
    let carriedOver = 0, awaiting = 0, hiddenAwaiting = 0;
    for (const mi of missions) {
      const undelivered = Object.values(this._parcels(mi)).filter((p) => p.scuHave < p.scuNeed);
      if (!undelivered.length) { awaiting += 1; if (opts.hideAwaiting) { hiddenAwaiting += 1; continue; } }
      const stale = staleOf(mi);
      if (stale) carriedOver += 1;
      const candidate = this.statusOf(mi) === 'candidate';
      const userCargo = this._hasUserCargo(mi);
      const ov = ovOf(mi); const pinned = !!ov.pinned; const oidx = orderIdx(mi.missionId);
      // "from X" contracts name the pickup; "to X" contracts only name the dropoff
      // (the game assigns a collect point but doesn't write it to the log on 4.8.0 —
      // the user can supply it, which _pickupOf folds in as an override).
      const pickup = this._pickupOf(mi);
      const hubKey = pickup || ' nopickup';
      const hub = byHub[hubKey] || (byHub[hubKey] = { pickup: pickup || 'Pickup not in log', pickupKnown: !!pickup, pickupBody: pickup ? (bodyFromStation(pickup) || 'Unknown') : null, collectScu: 0, legs: [], missions: 0, stale: true, pinned: false, order: 1e6 });
      hub.missions += 1;
      if (!stale) hub.stale = false;
      if (pinned) hub.pinned = true;
      hub.order = Math.min(hub.order, oidx);
      // Mission header, mirroring the in-game contract card: rank | type | route.
      const parts = String(mi.title || '').split('|').map((x) => x.trim()).filter(Boolean);
      const hdr = { title: mi.title || null, reward: mi.reward || null,
        rank: parts.length >= 3 ? parts[0] : null,
        contractType: parts.length >= 3 ? parts[1] : (mi.contractType || parts[1] || parts[0] || 'Hauling contract'),
        missionId: mi.missionId, source: mi.source || 'log', stale, candidate, pinned, userCargo, notes: ov.notes || null, order: oidx,
        pickups: (mi.pickupList && mi.pickupList.length) ? mi.pickupList : (pickup ? [pickup] : []) };
      if (undelivered.length) {
        for (const p of undelivered) {
          const scu = p.scuNeed - p.scuHave;
          const pickedUp = pickedUpOf(mi.missionId, p.dropKey);
          if (!pickedUp) hub.collectScu += scu;     // already-collected legs don't count toward what's left to load
          const dropoff = p.station || mi.titleDropoff || null;
          hub.legs.push(Object.assign({}, hdr, { dropKey: p.dropKey, dropoff, dropBody: dropoff ? ((p.body && p.body.name) || bodyFromStation(dropoff) || 'Unknown') : null, commodity: p.commodity, scu, pending: !dropoff, pickedUp, userLeg: !!p.user }));
        }
      } else {
        // Accepted but no Deliver objective yet — show the title endpoint; cargo TBD.
        // `canAddCargo` invites the user to type the requirement in-place (inline editor).
        const dropoff = mi.titleDropoff || null;
        hub.legs.push(Object.assign({}, hdr, { dropKey: 'm0', dropoff, dropBody: dropoff ? (bodyFromStation(dropoff) || 'Unknown') : null, commodity: null, scu: null, pending: !dropoff, awaiting: true, canAddCargo: true, pickedUp: pickedUpOf(mi.missionId, 'm0') }));
      }
    }
    // "My order" = user drag order (pinned first); "Optimize" = body-cluster (default).
    const manualOrder = opts.order === 'manual';
    const legCmp = (a, b) => (b.pinned - a.pinned) || (manualOrder ? (a.order - b.order) : 0) || (a.pickedUp - b.pickedUp) || (a.pending - b.pending) || (BODY_ORDER[a.dropBody] || 90) - (BODY_ORDER[b.dropBody] || 90) || String(a.dropoff || '').localeCompare(String(b.dropoff || ''));
    const hubs = Object.values(byHub).map((h) => { h.legs.sort(legCmp); return h; })
      .sort((a, b) => (b.pinned - a.pinned) || (manualOrder ? (a.order - b.order) : 0) || (a.stale - b.stale) || (b.pickupKnown - a.pickupKnown) || (BODY_ORDER[a.pickupBody] || 90) - (BODY_ORDER[b.pickupBody] || 90) || a.pickup.localeCompare(b.pickup));

    const totalScu = hubs.reduce((s, h) => s + h.collectScu, 0);
    const dropoffs = hubs.reduce((s, h) => s + h.legs.filter((l) => l.dropoff).length, 0);
    const shownMissions = hubs.reduce((s, h) => s + h.missions, 0);
    const pickupNotLogged = hubs.filter((h) => !h.pickupKnown).reduce((s, h) => s + h.missions, 0);

    const notes = [];
    if (opts.shipScu) for (const h of hubs) if (h.collectScu > opts.shipScu) notes.push(`${h.pickupKnown ? 'Pickup at ' + h.pickup : 'This batch'} is ${h.collectScu} SCU — exceeds your ${opts.shipScu} SCU hold; split into multiple loads.`);
    if (carriedOver) notes.push(`${carriedOver} mission(s) carried over from a previous session (a crash/exit logs no end-event) — confirm in your contract manager, or open it in-game to refresh.`);
    if (awaiting && !opts.hideAwaiting) notes.push(`${awaiting} mission(s) accepted but no cargo line yet — loads when you physically pick up that mission's cargo in-game (opening the contract isn't enough).`);
    if (hiddenAwaiting) notes.push(`${hiddenAwaiting} accepted-but-not-loaded haul(s) hidden.`);
    if (pickupNotLogged) notes.push(`${pickupNotLogged} "deliver to…" contract(s) don't record their pickup in the log on this build — the game assigns a collect point and shows it in-game; here only the dropoff is known.`);
    if (!hubs.length && !done.length && !snoozed.length) notes.push('No cargo missions yet. Accept a hauling contract in-game, or add one manually with the + Add button.');

    return {
      enabled: true,
      summary: { missions: shownMissions, pickups: hubs.length, dropoffs, totalScu, carriedOver, done: done.length, snoozed: snoozed.length, awaiting, order: manualOrder ? 'manual' : 'optimize' },
      hubs, done, snoozed, notes
    };
  }
}

module.exports = CargoRouter;
