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

// Circuit order per body name (drives the stop sequence). Lower = visited first.
const STANTON = { 1: 'Hurston', 2: 'Crusader', 3: 'ArcCorp', 4: 'microTech' };
const BODY_ORDER = { Hurston: 1, Crusader: 2, ArcCorp: 3, microTech: 4, 'Asteroid bases': 5, Pyro: 6 };

// Infer the celestial body from a station NAME. SC station names are prefixed by
// their planet (ARC-L1.., CRU-L1.., HUR-L1.., MIC-L1..) or are well-known hubs.
function bodyFromStation (name) {
  const n = String(name).toLowerCase();
  if (/^arc-|area ?18|baijini|riker|arccorp/.test(n)) return 'ArcCorp';
  if (/^cru-|orison|seraphim|ambitious dream|crusader/.test(n)) return 'Crusader';
  if (/^hur-|everus|hurston/.test(n)) return 'Hurston';
  if (/^mic-|tressler|new babbage|microtech/.test(n)) return 'microTech';
  if (/wikelo|collector/.test(n)) return 'Asteroid bases';
  // Pyro: orbital stations + surface outposts (no planet prefix, matched by name).
  if (/pyro|ruin station|checkmate|rod'?s end|rat'?s nest|dudley|patch city|gaslight|orbituary|starlight|seer'?s canyon|rustville|hdpc-|shepherd'?s rest|bueno|last landing|ashland|chawla|canard|sacren|fallow field|sunset mesa|refinery ravine|megumi|endgame|terminus|feo |dunboro|prospect depot/.test(n)) return 'Pyro';
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
    this.manual = { overrides: {}, added: {}, order: [] };   // overrides[id]={status?,pickedUp:{},notes?,snoozed?,pinned?}; added[id]=mission; order=[missionId]
    this._c = 0;
    this._load();
  }

  _load () {
    if (!this.file) return;
    try { const fs = require('fs'); if (fs.existsSync(this.file)) { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.manual = { overrides: j.overrides || {}, added: j.added || {}, order: j.order || [] }; } } catch (e) { /* ignore a corrupt store */ }
  }
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
      return 'objective';
    }
    // Hauling handler — names the specific dropoff station for a dropoff GUID.
    if ((m = line.match(DROPOFF_RE))) {
      const [, station, token, objectiveId] = m;
      const guid = this._guid(objectiveId);
      if (!guid) return null;
      const body = bodyFromToken(token);
      this.stationByGuid[guid] = { station: station.trim(), token, body };
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
  addManual (d = {}) {
    const id = 'm-' + Date.now().toString(36) + '-' + (++this._c);
    const mi = { missionId: id, source: 'manual', status: d.status || 'candidate',
      title: d.title || null, pickup: d.pickup || null, titleDropoff: d.dropoff || null,
      reward: d.reward || null, contractType: d.contractType || d.type || 'Manual', parcels: {}, lastSession: this.session };
    if (d.dropoff || d.commodity || d.scu) mi.parcels.m0 = { dropKey: 'm0', commodity: d.commodity || null, scuHave: 0, scuNeed: Number(d.scu) || 0, station: d.dropoff || null, body: d.dropoff ? { name: bodyFromStation(d.dropoff) } : null };
    this.manual.added[id] = mi; this._save(); return mi;
  }
  removeManual (id) { delete this.manual.added[id]; delete this.manual.overrides[id]; this._save(); }
  purge () { this.manual = { overrides: {}, added: {}, order: [] }; this._save(); }

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
  activeMissions () { return this._allMissions().filter((mi) => !['completed', 'abandoned', 'failed'].includes(this.statusOf(mi))); }

  // The "Route" button. Groups active missions by pickup hub; orders each hub's
  // dropoffs by celestial body. opts.shipScu flags over-capacity hubs;
  // opts.freshOnly hides carried-over (unconfirmed-this-session) missions.
  route (opts = {}) {
    const DONE = ['completed', 'abandoned', 'failed'];
    const staleOf = (mi) => mi.source !== 'manual' && this.session > 0 && mi.lastSession < this.session;
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
      const undelivered = Object.values(mi.parcels).filter((p) => p.scuHave < p.scuNeed);
      if (!undelivered.length) { awaiting += 1; if (opts.hideAwaiting) { hiddenAwaiting += 1; continue; } }
      const stale = staleOf(mi);
      if (stale) carriedOver += 1;
      const candidate = this.statusOf(mi) === 'candidate';
      const ov = ovOf(mi); const pinned = !!ov.pinned; const oidx = orderIdx(mi.missionId);
      // "from X" contracts name the pickup; "to X" contracts only name the dropoff
      // (the game assigns a collect point but doesn't write it to the log on 4.8.0).
      const pickup = mi.pickup || null;
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
        missionId: mi.missionId, source: mi.source || 'log', stale, candidate, pinned, notes: ov.notes || null, order: oidx };
      if (undelivered.length) {
        for (const p of undelivered) {
          const scu = p.scuNeed - p.scuHave;
          const pickedUp = pickedUpOf(mi.missionId, p.dropKey);
          if (!pickedUp) hub.collectScu += scu;     // already-collected legs don't count toward what's left to load
          const dropoff = p.station || mi.titleDropoff || null;
          hub.legs.push(Object.assign({}, hdr, { dropKey: p.dropKey, dropoff, dropBody: dropoff ? ((p.body && p.body.name) || bodyFromStation(dropoff) || 'Unknown') : null, commodity: p.commodity, scu, pending: !dropoff, pickedUp }));
        }
      } else {
        // Accepted but no Deliver objective yet — show the title endpoint; cargo TBD.
        const dropoff = mi.titleDropoff || null;
        hub.legs.push(Object.assign({}, hdr, { dropKey: 'm0', dropoff, dropBody: dropoff ? (bodyFromStation(dropoff) || 'Unknown') : null, commodity: null, scu: null, pending: !dropoff, awaiting: true, pickedUp: pickedUpOf(mi.missionId, 'm0') }));
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
