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
 * What it does: as you accept hauling missions in-game, the Game.log emits the
 * cargo manifest and the destination stations. This module joins them and, on
 * demand ("Route" button), sequences your active deliveries into an efficient
 * stop order — grouped by celestial body so you don't bounce around the system.
 *
 * Data sources (VERIFIED in the real corpus, builds 4.7-4.8.0):
 *  - Objective manifest: <SHUDEvent_OnNotification> "New Objective: Deliver
 *    H/N SCU of <Commodity> to <System>: " ... MissionId:[guid], ObjectiveId:
 *    [dropoff_<GUID>_<idx>]   → commodity + SCU + mission + the dropoff GUID.
 *  - Station: <CreateHaulingObjectiveHandler> "Dropoff created ... locationName:
 *    <Station> [<Token>] ... objectiveId: dropoff_<GUID>_<i>_<j>"  → the named
 *    station and a location token whose <System>_<N> encodes the celestial body.
 *  The join key is the dropoff <GUID>; the body falls out of the token — so no
 *  external API and no hand-maintained station list are needed.
 *
 * Honesty: this reads the local player's own accepted missions (self-reported,
 * client-only, like everything else). Open-delivery pickups are often UNKNOWN
 * (you source the commodity anywhere), so the router optimizes the DROPOFF
 * sequence — the reliable, named side. "Optimal" is a body-clustered heuristic,
 * not a provably shortest 3D path (no travel-time model is in the log).
 */

// Celestial bodies, keyed by the number in a Stanton_<N> location token. Ordered
// as a sensible delivery circuit. Editable; CIG adds locations every patch.
const STANTON = {
  1: { name: 'Hurston', order: 1 },
  2: { name: 'Crusader', order: 2 },
  3: { name: 'ArcCorp', order: 3 },
  4: { name: 'microTech', order: 4 }
};

// Circuit order per body name (drives the stop sequence). Lower = visited first.
const BODY_ORDER = { Hurston: 1, Crusader: 2, ArcCorp: 3, microTech: 4, 'Asteroid bases': 5, Pyro: 6 };

// Infer the celestial body from a station NAME. SC station names are prefixed by
// their planet (ARC-L1.., CRU-L1.., HUR-L1.., MIC-L1..) or are well-known hubs.
// VERIFIED against the real station names in the corpus. Editable per patch.
function bodyFromStation (name) {
  const n = String(name).toLowerCase();
  if (/^arc-|area ?18|baijini|riker|arccorp/.test(n)) return 'ArcCorp';
  if (/^cru-|orison|seraphim|ambitious dream|crusader/.test(n)) return 'Crusader';
  if (/^hur-|everus|hurston/.test(n)) return 'Hurston';
  if (/^mic-|tressler|new babbage|microtech/.test(n)) return 'microTech';
  if (/wikelo|collector/.test(n)) return 'Asteroid bases';
  // Pyro: orbital stations + surface outposts (no planet prefix, so matched by name).
  if (/pyro|ruin station|checkmate|rod'?s end|rat'?s nest|dudley|patch city|gaslight|orbituary|starlight|seer'?s canyon|rustville|hdpc-|shepherd'?s rest|bueno|last landing|ashland|chawla|canard|sacren|fallow field|refinery ravine|megumi|endgame|terminus|feo |dunboro|prospect depot/.test(n)) return 'Pyro';
  return null;
}
// A destination that is just "<System> System" is not a routable station.
function isGenericSystem (dest) { return /^(stanton|pyro)\s+system$/i.test(String(dest).trim()); }

const OBJECTIVE_RE = /Deliver (\d+)\/(\d+) SCU of (.+?) to ([^:"]+?):.*?MissionId:\s*\[([0-9a-fA-F-]+)\],\s*ObjectiveId:\s*\[(dropoff_[0-9a-fA-F-]+_\d+)\]/;
// Contract acceptance names the PICKUP/source: "Contract Accepted: <title> | from <Pickup> <EM..>".
const ACCEPT_RE = /Contract Accepted:\s*(.+?)\s*(?:<EM\d|:\s*")[\s\S]*?MissionId:\s*\[([0-9a-fA-F-]+)\]/;
const DROPOFF_RE = /Dropoff created.*?locationName:\s*(.+?)\s*\[([^\]]+)\].*?objectiveId:\s*(dropoff_[0-9a-fA-F-]+(?:_\d+)*)/;
const GUID_RE = /dropoff_([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';

function bodyFromToken (token) {
  const m = String(token).match(/(Stanton|Pyro)_?(\d)/i);
  if (!m) return { sys: null, num: null, name: null };
  const sys = m[1], num = Number(m[2]);
  const name = sys.toLowerCase() === 'stanton' ? (STANTON[num] && STANTON[num].name) || ('Stanton ' + num) : (sys + ' ' + num);
  return { sys, num, name };
}
class CargoRouter {
  constructor () {
    this.parcels = {};         // dropKey -> parcel (a delivery leg)
    this.stationByGuid = {};   // dropoff GUID -> { station, token, body }
    this.pickups = {};         // missionId -> { pickup, title } (the source/collect point)
    this.missionActive = {};   // missionId -> true while open
    this.session = 0;          // increments on each new game session ("Log started on")
  }

  _guid (objectiveId) { const m = String(objectiveId).match(GUID_RE); return m ? m[1].toLowerCase() : null; }

  // Single entry point from the relay. rawLine is the log line; ev is the parsed
  // event (used only to catch mission:end). No coupling beyond this signature.
  observe (rawLine, ev) {
    // A fresh game session (relaunch after crash / exit-to-menu). We DON'T wipe
    // carried-over cargo — a crash logs no <EndMission>, so the missions may still
    // be live. Instead we bump the session counter; the route then flags anything
    // not re-confirmed THIS session as "carried over, verify" (see route()).
    if (ev && ev.kind === 'session:start') this.session += 1;
    if (ev && ev.kind === 'mission:end' && ev.missionId) this.endMission(ev.missionId);
    this.ingest(String(rawLine));
  }

  ingest (line) {
    let m;
    if ((m = line.match(ACCEPT_RE))) {
      const title = m[1].trim(), missionId = m[2];
      const fm = title.match(/\|\s*from (.+?)\s*$/);   // pickup = the "| from <X>" tail
      if (missionId !== ZERO_GUID) {
        this.pickups[missionId] = { pickup: fm ? fm[1].trim() : null, title };
        this.missionActive[missionId] = true;
      }
      return 'accept';
    }
    if ((m = line.match(OBJECTIVE_RE))) {
      const [, have, need, commodity, destRaw, missionId, dropKey] = m;
      const dest = destRaw.trim();
      const guid = this._guid(dropKey);
      const handler = guid && this.stationByGuid[guid];
      // The objective often names the destination station directly; only fall
      // back to the <CreateHaulingObjectiveHandler> join when it's a bare system.
      let station = null, body = null;
      if (!isGenericSystem(dest)) { station = dest; body = { name: bodyFromStation(dest) }; }
      else if (handler) { station = handler.station; body = handler.body; }
      this.parcels[dropKey] = {
        dropKey, guid, missionId,
        commodity: commodity.trim(),
        scuHave: Number(have), scuNeed: Number(need),
        destSystem: dest,
        station,
        body,
        lastSession: this.session   // the session this delivery was last confirmed in
      };
      if (missionId && missionId !== ZERO_GUID) this.missionActive[missionId] = true;
      return 'objective';
    }
    if ((m = line.match(DROPOFF_RE))) {
      const [, station, token, objectiveId] = m;
      const guid = this._guid(objectiveId);
      if (!guid) return null;
      const body = bodyFromToken(token);
      this.stationByGuid[guid] = { station: station.trim(), token, body };
      // Back-fill any parcels already seen for this dropoff GUID.
      for (const p of Object.values(this.parcels)) {
        if (p.guid === guid && !p.station) { p.station = station.trim(); p.body = body; }
      }
      return 'station';
    }
    return null;
  }

  endMission (missionId) {
    delete this.missionActive[missionId];
    delete this.pickups[missionId];
    for (const k of Object.keys(this.parcels)) if (this.parcels[k].missionId === missionId) delete this.parcels[k];
  }

  // Parcels still to deliver: mission still open and not yet fully delivered.
  activeParcels () {
    return Object.values(this.parcels).filter((p) =>
      this.missionActive[p.missionId] && p.scuHave < p.scuNeed);
  }

  // The "Route" button calls this. Builds pickup -> dropoff legs, groups legs by
  // their pickup hub, and within each hub orders the dropoffs by celestial body.
  // Output is the routing breakdown: where to collect, where to deliver, in order.
  //   opts.shipScu   — flag when a hub's load exceeds this capacity.
  //   opts.freshOnly — drop carried-over (unconfirmed-this-session) deliveries.
  route (opts = {}) {
    // "Carried over": last confirmed in an earlier session. After a crash / exit
    // to menu the game logs no <EndMission>, so these MIGHT be gone — flag, don't
    // assume. Confirmed again the moment their objective re-appears this session.
    const staleOf = (p) => this.session > 0 && p.lastSession < this.session;
    let active = this.activeParcels();
    if (opts.freshOnly) active = active.filter((p) => !staleOf(p));

    const byHub = {};              // pickup location -> hub
    const unrouted = [];           // deliveries with no resolved dropoff station
    let carriedOver = 0;
    for (const p of active) {
      const stale = staleOf(p);
      if (stale) carriedOver += 1;
      const scu = p.scuNeed - p.scuHave;
      const pick = this.pickups[p.missionId] || {};
      const pickup = pick.pickup || 'Open pickup (source your own)';
      const leg = { dropoff: p.station, dropBody: (p.body && p.body.name) || 'Unknown', commodity: p.commodity, scu, missionId: p.missionId, stale };
      const hub = byHub[pickup] || (byHub[pickup] = {
        pickup, pickupBody: bodyFromStation(pickup) || 'Unknown', collectScu: 0, legs: [], pending: [], stale: true
      });
      if (!stale) hub.stale = false;
      hub.collectScu += scu;
      if (p.station) hub.legs.push(leg); else hub.pending.push(leg);
      if (!p.station) unrouted.push({ commodity: p.commodity, scu, destSystem: p.destSystem, pickup, stale });
    }
    // Order dropoffs within a hub by body circuit, then station; order hubs by body.
    const hubs = Object.values(byHub).map((h) => {
      h.legs.sort((a, b) => (BODY_ORDER[a.dropBody] || 90) - (BODY_ORDER[b.dropBody] || 90) || String(a.dropoff).localeCompare(b.dropoff));
      h.dropoffs = h.legs.length; h.pendingCount = h.pending.length;
      return h;
    }).sort((a, b) => (a.stale - b.stale) || (BODY_ORDER[a.pickupBody] || 90) - (BODY_ORDER[b.pickupBody] || 90) || a.pickup.localeCompare(b.pickup));

    const totalScu = active.reduce((s, p) => s + (p.scuNeed - p.scuHave), 0);
    const missions = new Set(active.map((p) => p.missionId));
    const dropoffs = active.filter((p) => p.station).length;

    const notes = [];
    if (opts.shipScu) for (const h of hubs) if (h.collectScu > opts.shipScu) notes.push(`Pickup at ${h.pickup} is ${h.collectScu} SCU — exceeds your ${opts.shipScu} SCU hold, so split it into multiple loads.`);
    if (carriedOver) notes.push(`${carriedOver} delivery(ies) carried over from a previous session (game exit/crash logs no end-event) — confirm they're still in your contract manager, or hit Route after the objectives refresh in-game.`);
    if (unrouted.length) notes.push(`${unrouted.length} delivery(ies) have no named dropoff station yet (logged only as a system) — listed under each hub as "destination pending".`);
    if (!hubs.length) notes.push('No active cargo deliveries detected. Accept a hauling contract, then hit Route.');

    return {
      enabled: true,
      summary: { missions: missions.size, pickups: hubs.length, dropoffs, totalScu, carriedOver },
      hubs, unrouted, notes
    };
  }
}

module.exports = CargoRouter;
