'use strict';

/**
 * cargoRoute — pure route-planning logic for the log-derived cargo board.
 *
 * Ported from Neorion/star-citizen-live (feature/cargo-router branch),
 * services/CargoRouter.js, with the manual-board layer (user-added missions,
 * OCR import, pin/snooze/notes/manual-order, vocab-learning writes, folder-watch
 * config, raw-JSON persistence) stripped out — see BUILD-PLAN-rsi.md WS4/T4.2.
 * This module only knows about ONE mission source (the Game.log), so there is
 * no override precedence to resolve: a mission is either what the log says it
 * is, or it isn't tracked.
 *
 * Zero I/O of its own — the only "I/O" is the lazy, cached read of the
 * committed UEX reference snapshot via functions/uexReference.js (same tier as
 * functions/shipCatalog.js's catalog load: reference data baked in at build
 * time, not runtime state).
 */

const { bodyOfLocation } = require('./uexReference');

/** Terminal mission statuses — no longer shown as "active" on the board. */
const TERMINAL = ['completed', 'abandoned', 'failed', 'cleared'];

/** Stanton system index -> friendly body name, from the "Stanton_<n>" log token. */
const STANTON = { 1: 'Hurston', 2: 'Crusader', 3: 'ArcCorp', 4: 'microTech' };

/** Sort weight for grouping/ordering legs and hubs by celestial body. */
const BODY_ORDER = { Hurston: 1, Crusader: 2, ArcCorp: 3, microTech: 4, 'Asteroid bases': 5, Pyro: 6 };

/**
 * @typedef {object} CargoParcel
 * @property {string} dropKey - the log's per-parcel objective key (dropoff_<guid>_<n>).
 * @property {string|null} guid - the dropoff GUID extracted from dropKey.
 * @property {string} commodity
 * @property {number} scuHave
 * @property {number} scuNeed
 * @property {string} destSystem - the raw destination text from the log (station name, or a generic "<System> System" placeholder).
 * @property {string|null} station - the resolved dropoff station name, once known.
 * @property {{sys?:string, num?:number, name:string|null}|null} body - the resolved dropoff body, once known.
 *
 * @typedef {object} CargoMission
 * @property {string} missionId
 * @property {string|null} title - the raw "<Rank> | <ContractType> | from/to <Place>" title text.
 * @property {string|null} pickup - the pickup hub, if the accept notification named one ("| from X").
 * @property {string|null} titleDropoff - the dropoff, if the accept notification named one ("| to Y") instead of a pickup.
 * @property {string|null} reward
 * @property {string|null} status - set once the log reports an outcome (see TERMINAL); null while active.
 * @property {number} lastSession - the router session index this mission was last confirmed in.
 * @property {Object<string, CargoParcel>} parcels - keyed by dropKey.
 */

/**
 * @param {string} s
 * @returns {string}
 */
function normName (s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Resolve a station/location name to its celestial body. Tries the UEX
 * reference snapshot first (exact name match), then falls back to a regex
 * over known hub prefixes/landmarks so the board stays useful even for
 * locations not yet in the snapshot.
 * @param {string} name
 * @returns {string|null}
 */
function bodyFromStation (name) {
  const uex = bodyOfLocation(name);
  if (uex) return uex;
  const n = String(name).toLowerCase();
  if (/^arc-|area ?18|baijini|riker|arccorp/.test(n)) return 'ArcCorp';
  if (/^cru-|orison|seraphim|ambitious dream|crusader/.test(n)) return 'Crusader';
  if (/^hur-|everus|hurston|hdpc-|lorville|teasa/.test(n)) return 'Hurston';
  if (/^mic-|tressler|new babbage|microtech/.test(n)) return 'microTech';
  if (/wikelo|collector/.test(n)) return 'Asteroid bases';
  if (/pyro|ruin station|checkmate|rod'?s end|rat'?s nest|dudley|patch city|gaslight|orbituary|starlight|seer'?s canyon|rustville|shepherd'?s rest|bueno|last landing|ashland|chawla|canard|sacren|fallow field|sunset mesa|refinery ravine|megumi|endgame|terminus|feo |dunboro|prospect depot/.test(n)) return 'Pyro';
  return null;
}

/**
 * Resolve a "Stanton_<n>" / "Pyro_<n>"-style location token (as seen in the
 * mission:dropoff handler line) to a system/number/body name triple.
 * @param {string} token
 * @returns {{sys: string|null, num: number|null, name: string|null}}
 */
function bodyFromToken (token) {
  const m = String(token).match(/(Stanton|Pyro)_?(\d)/i);
  if (!m) return { sys: null, num: null, name: null };
  const sys = m[1];
  const num = Number(m[2]);
  const name = sys.toLowerCase() === 'stanton' ? (STANTON[num] || ('Stanton ' + num)) : (sys + ' ' + num);
  return { sys, num, name };
}

/**
 * True when a dropoff destination is still a generic system placeholder (the
 * game hasn't assigned a specific station name to it yet, in the log's own text).
 * @param {string} dest
 * @returns {boolean}
 */
function isGenericSystem (dest) {
  return /^(stanton|pyro)\s+system$/i.test(String(dest).trim());
}

/**
 * A mission's delivery parcels are "fully delivered" when it has at least one
 * SCU-bearing parcel and every one of them has scuHave >= scuNeed.
 * @param {CargoMission} mi
 * @returns {boolean}
 */
function isFullyDelivered (mi) {
  const parcels = Object.values(mi.parcels || {}).filter((p) => p.scuNeed > 0);
  return parcels.length > 0 && parcels.every((p) => p.scuHave >= p.scuNeed);
}

/**
 * A mission's displayed status: the log's own outcome wins if we have one;
 * otherwise infer "completed" from full delivery, else "active".
 * @param {CargoMission} mi
 * @returns {string}
 */
function statusOf (mi) {
  if (mi.status) return mi.status;
  if (isFullyDelivered(mi)) return 'completed';
  return 'active';
}

/**
 * A mission is "stale" (carried over) once at least one session boundary has
 * passed since it was last confirmed by a log line (accept/deliver update).
 * @param {CargoMission} mi
 * @param {number} session
 * @returns {boolean}
 */
function isStale (mi, session) {
  return session > 0 && mi.lastSession < session;
}

/**
 * Split a "<Rank> | <ContractType> | from/to <Place>" title into its parts.
 * @param {string|null} title
 * @returns {string[]}
 */
function titleParts (title) {
  return String(title || '').split('|').map((x) => x.trim()).filter(Boolean);
}

/**
 * Order two hub legs by celestial body cluster, then dropoff name.
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
function legCmp (a, b) {
  return (BODY_ORDER[a.dropBody] || 90) - (BODY_ORDER[b.dropBody] || 90) ||
    String(a.dropoff || '').localeCompare(String(b.dropoff || ''));
}

/**
 * Group + order a set of log-derived cargo missions into a route: one entry
 * per pickup hub, each with its dropoff legs ordered by celestial body
 * cluster, plus SCU totals and honest notes about what the log can't tell you.
 *
 * @param {CargoMission[]} missions - plain mission objects (e.g. Object.values(router.missions)).
 * @param {number} session - the router's current session index (increments on each session:start).
 * @param {{shipScu?: number, freshOnly?: boolean, hideAwaiting?: boolean}} [opts]
 *   shipScu: flag hubs whose total collect SCU exceeds this hold size.
 *   freshOnly: hide missions not re-confirmed in the current session.
 *   hideAwaiting: hide accepted-but-not-yet-loaded missions entirely (they still count toward summary.missions unless hidden).
 * @returns {{
 *   enabled: true,
 *   summary: {missions: number, pickups: number, dropoffs: number, totalScu: number, carriedOver: number, done: number, awaiting: number, order: string},
 *   hubs: object[],
 *   done: object[],
 *   notes: string[]
 * }}
 */
function routeMissions (missions, session, opts = {}) {
  const all = Array.isArray(missions) ? missions : [];

  const done = all
    .filter((mi) => TERMINAL.includes(statusOf(mi)))
    .map((mi) => {
      const parts = titleParts(mi.title);
      const firstParcel = Object.values(mi.parcels || {})[0];
      return {
        missionId: mi.missionId,
        status: statusOf(mi),
        contractType: parts.length >= 3 ? parts[1] : 'Hauling contract',
        dropoff: mi.titleDropoff || (firstParcel && firstParcel.station) || null
      };
    });

  let active = all.filter((mi) => !TERMINAL.includes(statusOf(mi)));
  if (opts.freshOnly) active = active.filter((mi) => !isStale(mi, session));

  const byHub = {};
  let carriedOver = 0;
  let awaiting = 0;
  let hiddenAwaiting = 0;

  for (const mi of active) {
    const parcels = Object.values(mi.parcels || {});
    const undelivered = parcels.filter((p) => p.scuHave < p.scuNeed);
    if (!undelivered.length) {
      awaiting += 1;
      if (opts.hideAwaiting) { hiddenAwaiting += 1; continue; }
    }

    const stale = isStale(mi, session);
    if (stale) carriedOver += 1;

    const pickup = mi.pickup || null;
    const hubKey = pickup || ' nopickup';
    const hub = byHub[hubKey] || (byHub[hubKey] = {
      pickup: pickup || 'Pickup not in log',
      pickupKnown: !!pickup,
      pickupBody: pickup ? (bodyFromStation(pickup) || 'Unknown') : null,
      collectScu: 0,
      legs: [],
      missions: 0,
      stale: true
    });
    hub.missions += 1;
    if (!stale) hub.stale = false;

    const parts = titleParts(mi.title);
    const header = {
      title: mi.title || null,
      reward: mi.reward || null,
      rank: parts.length >= 3 ? parts[0] : null,
      contractType: parts.length >= 3 ? parts[1] : (parts[1] || parts[0] || 'Hauling contract'),
      missionId: mi.missionId,
      stale
    };

    if (undelivered.length) {
      for (const p of undelivered) {
        const scu = p.scuNeed - p.scuHave;
        hub.collectScu += scu;
        const dropoff = p.station || mi.titleDropoff || null;
        hub.legs.push(Object.assign({}, header, {
          dropKey: p.dropKey,
          dropoff,
          dropBody: dropoff ? ((p.body && p.body.name) || bodyFromStation(dropoff) || 'Unknown') : null,
          commodity: p.commodity,
          scu,
          pending: !dropoff
        }));
      }
    } else {
      const dropoff = mi.titleDropoff || null;
      hub.legs.push(Object.assign({}, header, {
        dropKey: 'm0',
        dropoff,
        dropBody: dropoff ? (bodyFromStation(dropoff) || 'Unknown') : null,
        commodity: null,
        scu: null,
        pending: !dropoff,
        awaiting: true
      }));
    }
  }

  const hubs = Object.values(byHub)
    .map((h) => { h.legs.sort(legCmp); return h; })
    .sort((a, b) => (a.stale - b.stale) || (b.pickupKnown - a.pickupKnown) ||
      (BODY_ORDER[a.pickupBody] || 90) - (BODY_ORDER[b.pickupBody] || 90) ||
      a.pickup.localeCompare(b.pickup));

  const totalScu = hubs.reduce((s, h) => s + h.collectScu, 0);
  const dropoffs = hubs.reduce((s, h) => s + h.legs.filter((l) => l.dropoff).length, 0);
  const shownMissions = hubs.reduce((s, h) => s + h.missions, 0);
  const pickupNotLogged = hubs.filter((h) => !h.pickupKnown).reduce((s, h) => s + h.missions, 0);

  const notes = [];
  if (opts.shipScu) {
    for (const h of hubs) {
      if (h.collectScu > opts.shipScu) {
        notes.push(`${h.pickupKnown ? 'Pickup at ' + h.pickup : 'This batch'} is ${h.collectScu} SCU — exceeds your ${opts.shipScu} SCU hold; split into multiple loads.`);
      }
    }
  }
  if (carriedOver) notes.push(`${carriedOver} mission(s) carried over from a previous session (a crash/exit logs no end-event) — confirm in your contract manager, or open it in-game to refresh.`);
  if (awaiting && !opts.hideAwaiting) notes.push(`${awaiting} mission(s) accepted but no cargo line yet — loads when you physically pick up that mission's cargo in-game (opening the contract isn't enough).`);
  if (hiddenAwaiting) notes.push(`${hiddenAwaiting} accepted-but-not-loaded haul(s) hidden.`);
  if (pickupNotLogged) notes.push(`${pickupNotLogged} "deliver to…" contract(s) don't record their pickup in the log on this build — the game assigns a collect point and shows it in-game; here only the dropoff is known.`);
  if (!hubs.length && !done.length) notes.push('No cargo missions yet. Accept a hauling contract in-game.');

  return {
    enabled: true,
    summary: { missions: shownMissions, pickups: hubs.length, dropoffs, totalScu, carriedOver, done: done.length, awaiting, order: 'optimize' },
    hubs,
    done,
    notes
  };
}

module.exports = {
  TERMINAL,
  STANTON,
  BODY_ORDER,
  normName,
  bodyFromStation,
  bodyFromToken,
  isGenericSystem,
  routeMissions
};
