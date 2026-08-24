'use strict';

/**
 * CargoRouter — stateful, log-derived cargo-mission accumulator.
 *
 * Ported from Neorion/star-citizen-live (feature/cargo-router branch),
 * services/CargoRouter.js, with the manual-board layer (user-added missions,
 * OCR import, pin/snooze/notes/manual-order, vocab-learning writes, folder-watch
 * config, raw-JSON persistence) stripped out — see BUILD-PLAN-rsi.md WS4/T4.2.
 * This service has exactly ONE mission source: the Game.log, consumed through
 * the already-parsed events functions/parser.js produces (cargo:accept,
 * cargo:deliver, mission:dropoff, mission:end, session:start).
 *
 * Mirrors services/LiveRelay.js's class shape (constructor takes `settings`,
 * state lives on `this`) and services/MissionManager.js's EventEmitter
 * convention. `observe(ev)` takes the SAME shape services/LiveRelay.js's
 * handleLogChange() gets back from parseLine() and hands other accumulators
 * directly (see its `_applyHistoryEvent(ev)` calls inside the event switch,
 * called with the raw parsed event — not a re-shaped payload) — so this class
 * is meant to be driven the same way, e.g. `this.cargoRouter.observe(ev)`
 * alongside those calls, once wired up in a future task (T4.4).
 *
 * No persistence here (Pattern Card #4: only types/Store.js collections may
 * persist, and this task is explicitly scoped to stay in-memory). If this
 * board needs to survive a relay restart, that's a Store-backed follow-up —
 * flagged in the T4.2 handoff notes, not built here.
 */

const EventEmitter = require('events');
const { bodyFromToken, isGenericSystem, bodyFromStation, routeMissions } = require('../functions/cargoRoute');

const ZERO_GUID = '00000000-0000-0000-0000-000000000000';
const HAUL_TITLE_RE = /\b(haul|cargo|freight|deliver)/i;
const DROPOFF_GUID_RE = /dropoff_([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;

/**
 * Extract the dropoff GUID shared by a cargo:deliver `dropKey` and a
 * mission:dropoff `objectiveId` — the two events use different trailing
 * index suffixes (`_<n>` vs `_<n>_<n>`), so this only keeps the GUID itself.
 * @param {string} key
 * @returns {string|null}
 */
function guidFromKey (key) {
  const m = String(key || '').match(DROPOFF_GUID_RE);
  return m ? m[1].toLowerCase() : null;
}

/**
 * CargoRouter service. Accumulates cargo/hauling missions from parsed
 * Game.log events into a route-able board (see route()).
 */
class CargoRouter extends EventEmitter {
  /**
   * @param {object} [settings]
   */
  constructor (settings = {}) {
    super();
    this.settings = Object.assign({}, settings);
    /** @type {Object<string, import('../functions/cargoRoute').CargoMission>} missionId -> accumulated mission */
    this.missions = {};
    /** @type {Object<string, {station: string, token: string, body: object}>} dropoff GUID -> known station */
    this.stationByGuid = {};
    /** @type {number} increments on each session:start (fresh game launch) */
    this.session = 0;
  }

  /**
   * Get-or-create the accumulated mission record for a runtime MissionId.
   * @param {string} missionId
   * @returns {import('../functions/cargoRoute').CargoMission}
   * @private
   */
  _mission (missionId) {
    return this.missions[missionId] || (this.missions[missionId] = {
      missionId,
      title: null,
      pickup: null,
      titleDropoff: null,
      reward: null,
      status: null,
      statusSource: null,
      lastSession: this.session,
      parcels: {}
    });
  }

  /**
   * Consume one already-parsed upstream event — the same object shape
   * functions/parser.js's parseLine() returns (has `.kind`, `.timestamp`, plus
   * the rule's structured fields). Unrecognized kinds are ignored.
   * @param {object} ev
   * @returns {void}
   */
  observe (ev) {
    if (!ev || !ev.kind) return;
    switch (ev.kind) {
      case 'session:start': this.session += 1; break;
      case 'cargo:accept': this._onAccept(ev); break;
      case 'cargo:deliver': this._onDeliver(ev); break;
      case 'mission:dropoff': this._onDropoffHandler(ev); break;
      case 'mission:end': this._onMissionEnd(ev); break;
      default: break;
    }
  }

  /**
   * Handle a cargo:accept event. Only tracks a mission when its title looks
   * like a hauling contract, OR the mission is already known (e.g. its
   * delivery objective arrived first) — a non-hauling "Contract Accepted"
   * (bounties, etc.) fires this same parser rule by design; filtering to
   * hauling-only is this module's job, not the parser's.
   * @param {object} ev
   * @private
   */
  _onAccept (ev) {
    if (!ev.missionId || ev.missionId === ZERO_GUID) return;
    const isHaul = HAUL_TITLE_RE.test(ev.title || '');
    const known = !!this.missions[ev.missionId];
    if (!isHaul && !known) return;

    const mi = this._mission(ev.missionId);
    mi.title = ev.title || mi.title;
    mi.lastSession = this.session;
    if (ev.reward) mi.reward = ev.reward;
    if (ev.pickup) mi.pickup = ev.pickup;
    if (ev.dropoff) mi.titleDropoff = ev.dropoff;
  }

  /**
   * Handle a cargo:deliver event (a "New Objective: Deliver X/Y SCU..." line).
   * Resolves the dropoff station immediately when the destination already
   * names one; otherwise, for a generic "<System> System" placeholder, uses
   * whatever a PRIOR mission:dropoff handler event already recorded for this
   * GUID (may still be unknown — a later handler event backfills it, see
   * _onDropoffHandler).
   * @param {object} ev
   * @private
   */
  _onDeliver (ev) {
    if (!ev.missionId || !ev.dropKey) return;
    const mi = this._mission(ev.missionId);
    mi.lastSession = this.session;

    const guid = guidFromKey(ev.dropKey);
    const dest = String(ev.destination || '').trim();
    let station = null;
    let body = null;
    if (!isGenericSystem(dest)) {
      station = dest;
      body = { name: bodyFromStation(dest) };
    } else {
      const handler = guid ? this.stationByGuid[guid] : null;
      if (handler) {
        station = handler.station;
        body = handler.body;
      }
    }

    mi.parcels[ev.dropKey] = {
      dropKey: ev.dropKey,
      guid,
      commodity: ev.commodity,
      scuHave: ev.scuHave,
      scuNeed: ev.scuNeed,
      destSystem: dest,
      station,
      body
    };
  }

  /**
   * Handle a mission:dropoff event (the "Dropoff created..." handler line
   * naming a dropoff GUID's station). May arrive BEFORE or AFTER the matching
   * cargo:deliver event, in either order — records the station for the GUID
   * either way, and backfills any already-recorded parcel across ALL missions
   * that shares this GUID and hasn't learned its station yet.
   * @param {object} ev
   * @private
   */
  _onDropoffHandler (ev) {
    const guid = guidFromKey(ev.objectiveId);
    if (!guid) return;
    const body = bodyFromToken(ev.token);
    this.stationByGuid[guid] = { station: ev.station, token: ev.token, body };

    for (const mi of Object.values(this.missions)) {
      for (const p of Object.values(mi.parcels)) {
        if (p.guid === guid && !p.station) {
          p.station = ev.station;
          p.body = body;
        }
      }
    }
  }

  /**
   * Handle a mission:end event — the log's authoritative per-mission outcome.
   * Sets a terminal status only on a mission we're already tracking (a
   * mission:end for an untracked/non-hauling mission is simply ignored).
   * @param {object} ev
   * @private
   */
  _onMissionEnd (ev) {
    const mi = this.missions[ev.missionId];
    if (!mi) return;
    const c = String(ev.completionType || '');
    mi.status = /abandon/i.test(c) ? 'abandoned' : /fail/i.test(c) ? 'failed' : /deactiv/i.test(c) ? 'abandoned' : 'completed';
    mi.statusSource = 'log';
    this.emit('mission:end', mi);
  }

  /**
   * Build the routed cargo board from the missions accumulated so far.
   * @param {{shipScu?: number, freshOnly?: boolean, hideAwaiting?: boolean}} [opts]
   * @returns {object} see functions/cargoRoute.js routeMissions()
   */
  route (opts = {}) {
    return routeMissions(Object.values(this.missions), this.session, opts);
  }
}

module.exports = CargoRouter;
