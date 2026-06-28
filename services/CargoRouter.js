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
  if (/pyro|ruin station|checkmate|rod's|rat's nest|dudley|patch city|gaslight|orbituary/.test(n)) return 'Pyro';
  return null;
}
// A destination that is just "<System> System" is not a routable station.
function isGenericSystem (dest) { return /^(stanton|pyro)\s+system$/i.test(String(dest).trim()); }

const OBJECTIVE_RE = /Deliver (\d+)\/(\d+) SCU of (.+?) to ([^:"]+?):.*?MissionId:\s*\[([0-9a-fA-F-]+)\],\s*ObjectiveId:\s*\[(dropoff_[0-9a-fA-F-]+_\d+)\]/;
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
    this.parcels = {};        // dropKey -> parcel
    this.stationByGuid = {};   // dropoff GUID -> { station, token, body }
    this.missionActive = {};   // missionId -> true while open
  }

  _guid (objectiveId) { const m = String(objectiveId).match(GUID_RE); return m ? m[1].toLowerCase() : null; }

  // Single entry point from the relay. rawLine is the log line; ev is the parsed
  // event (used only to catch mission:end). No coupling beyond this signature.
  observe (rawLine, ev) {
    if (ev && ev.kind === 'mission:end' && ev.missionId) this.endMission(ev.missionId);
    this.ingest(String(rawLine));
  }

  ingest (line) {
    let m;
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
        body
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
    for (const k of Object.keys(this.parcels)) if (this.parcels[k].missionId === missionId) delete this.parcels[k];
  }

  // Parcels still to deliver: mission still open and not yet fully delivered.
  activeParcels () {
    return Object.values(this.parcels).filter((p) =>
      this.missionActive[p.missionId] && p.scuHave < p.scuNeed);
  }

  // The "Route" button calls this. Groups active deliveries by station, clusters
  // stations by celestial body, orders bodies into a circuit. opts.shipScu (SCU)
  // optionally flags trips that exceed capacity.
  route (opts = {}) {
    const active = this.activeParcels();
    const byStation = {};          // key -> stop
    const unrouted = [];           // parcels with no resolved station
    for (const p of active) {
      if (!p.station) { unrouted.push({ commodity: p.commodity, scu: p.scuNeed - p.scuHave, missionId: p.missionId, destSystem: p.destSystem }); continue; }
      const key = p.station;
      const bodyName = (p.body && p.body.name) || 'Unknown';
      const stop = byStation[key] || (byStation[key] = {
        station: p.station, body: bodyName,
        order: BODY_ORDER[bodyName] || 90,
        parcels: [], totalScu: 0
      });
      const remaining = p.scuNeed - p.scuHave;
      stop.parcels.push({ commodity: p.commodity, scu: remaining, missionId: p.missionId });
      stop.totalScu += remaining;
    }
    const stops = Object.values(byStation).sort((a, b) => a.order - b.order || a.station.localeCompare(b.station));

    const totalScu = stops.reduce((s, x) => s + x.totalScu, 0) + unrouted.reduce((s, x) => s + x.scu, 0);
    const bodies = [...new Set(stops.map((s) => s.body))];
    const missions = new Set(active.map((p) => p.missionId));
    const commodities = [...new Set(active.map((p) => p.commodity))];

    const notes = [];
    if (opts.shipScu && totalScu > opts.shipScu) notes.push(`Total ${totalScu} SCU exceeds the ${opts.shipScu} SCU you entered — plan multiple trips.`);
    if (unrouted.length) notes.push(`${unrouted.length} delivery(ies) have no named station yet (open delivery / not seen in log) — shown under "destination pending".`);
    if (!stops.length && !unrouted.length) notes.push('No active cargo deliveries detected. Accept a hauling contract, then hit Route.');

    return {
      enabled: true,
      summary: { missions: missions.size, stops: stops.length, bodies: bodies.filter(Boolean).length, totalScu, commodities: commodities.length },
      stops, unrouted, notes
    };
  }
}

module.exports = CargoRouter;
