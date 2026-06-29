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
    this.missions = {};        // missionId -> mission { title, pickup, titleDropoff, parcels, lastSession }
    this.stationByGuid = {};   // dropoff GUID -> { station, token, body }
    this.session = 0;          // increments on each new game session ("Log started on")
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
    if (ev && ev.kind === 'mission:end' && ev.missionId) this.endMission(ev.missionId);
    this.ingest(String(rawLine));
  }

  ingest (line) {
    let m;
    // Contract acceptance — names the pickup ("| from X") OR the dropoff ("| to Y").
    if ((m = line.match(ACCEPT_RE))) {
      const title = m[1].trim(), missionId = m[2];
      if (missionId !== ZERO_GUID) {
        const mi = this._mission(missionId);
        mi.title = title; mi.lastSession = this.session;
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

  endMission (missionId) { delete this.missions[missionId]; }

  // Active = not ended and not fully delivered (all parcels have >= need).
  activeMissions () {
    return Object.values(this.missions).filter((mi) => {
      const parcels = Object.values(mi.parcels);
      return !(parcels.length && parcels.every((p) => p.scuHave >= p.scuNeed));
    });
  }

  // The "Route" button. Groups active missions by pickup hub; orders each hub's
  // dropoffs by celestial body. opts.shipScu flags over-capacity hubs;
  // opts.freshOnly hides carried-over (unconfirmed-this-session) missions.
  route (opts = {}) {
    const staleOf = (mi) => this.session > 0 && mi.lastSession < this.session;
    let missions = this.activeMissions();
    if (opts.freshOnly) missions = missions.filter((mi) => !staleOf(mi));

    const byHub = {};
    let carriedOver = 0, awaiting = 0;
    for (const mi of missions) {
      const stale = staleOf(mi);
      if (stale) carriedOver += 1;
      const pickup = mi.pickup || 'Open pickup (source your own)';
      const hub = byHub[pickup] || (byHub[pickup] = { pickup, pickupBody: bodyFromStation(pickup) || 'Unknown', collectScu: 0, legs: [], missions: 0, stale: true });
      hub.missions += 1;
      if (!stale) hub.stale = false;
      const undelivered = Object.values(mi.parcels).filter((p) => p.scuHave < p.scuNeed);
      if (undelivered.length) {
        for (const p of undelivered) {
          const scu = p.scuNeed - p.scuHave;
          hub.collectScu += scu;
          const dropoff = p.station || mi.titleDropoff || null;
          hub.legs.push({ dropoff, dropBody: dropoff ? ((p.body && p.body.name) || bodyFromStation(dropoff) || 'Unknown') : null, commodity: p.commodity, scu, missionId: mi.missionId, stale, pending: !dropoff });
        }
      } else {
        // Accepted but no Deliver objective yet — show the title endpoint; cargo TBD.
        awaiting += 1;
        const dropoff = mi.titleDropoff || null;
        hub.legs.push({ dropoff, dropBody: dropoff ? (bodyFromStation(dropoff) || 'Unknown') : null, commodity: null, scu: null, missionId: mi.missionId, stale, pending: !dropoff, awaiting: true });
      }
    }
    const hubs = Object.values(byHub).map((h) => {
      h.legs.sort((a, b) => (a.pending - b.pending) || (BODY_ORDER[a.dropBody] || 90) - (BODY_ORDER[b.dropBody] || 90) || String(a.dropoff || '').localeCompare(String(b.dropoff || '')));
      return h;
    }).sort((a, b) => (a.stale - b.stale) || (BODY_ORDER[a.pickupBody] || 90) - (BODY_ORDER[b.pickupBody] || 90) || a.pickup.localeCompare(b.pickup));

    const totalScu = hubs.reduce((s, h) => s + h.collectScu, 0);
    const dropoffs = hubs.reduce((s, h) => s + h.legs.filter((l) => l.dropoff).length, 0);

    const notes = [];
    if (opts.shipScu) for (const h of hubs) if (h.collectScu > opts.shipScu) notes.push(`Pickup at ${h.pickup} is ${h.collectScu} SCU — exceeds your ${opts.shipScu} SCU hold; split into multiple loads.`);
    if (carriedOver) notes.push(`${carriedOver} mission(s) carried over from a previous session (a crash/exit logs no end-event) — confirm in your contract manager, or open it in-game to refresh.`);
    if (awaiting) notes.push(`${awaiting} mission(s) accepted but no cargo line yet — open the contract or pick up the cargo in-game, then hit Route to fill them in.`);
    if (!hubs.length) notes.push('No active cargo missions detected. Accept a hauling contract, then hit Route.');

    return {
      enabled: true,
      summary: { missions: missions.length, pickups: hubs.length, dropoffs, totalScu, carriedOver },
      hubs, notes
    };
  }
}

module.exports = CargoRouter;
