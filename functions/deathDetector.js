'use strict';

/**
 * Death detector — a per-log-session state machine over raw Game.log lines.
 *
 * Pure (no I/O): feed it lines in file order, get death-report events back.
 * The same detector serves the live tail and whole-file rescans.
 *
 *   IDLE ──(pilot FatalCollision | ActorState Dead for me | kill of me |
 *           my vehicle destroyed | corpse body line)──▶ OPEN
 *   OPEN ──(corpse body line | kill of me)──▶ CONFIRMED
 *   OPEN ──(respawn sequence, no corpse)──▶ closed `unconfirmed`
 *   OPEN ──(10 min of log time, nothing)──▶ closed `unconfirmed`
 *   CONFIRMED ──(respawn sequence)──▶ closed `confirmed`
 *   CONFIRMED ──(new trigger before respawn)──▶ finalize, open a new incident
 *
 * Rules learned from the real fixture (build 12660092):
 *   - Order by LINE, not time: Game.log timestamps are not strictly monotonic.
 *   - The "Incapacitated" HUD notice is replayed after respawn, so it only
 *     annotates an incident and never opens one.
 *   - The corpse manifest burst is NOT contiguous (other subsystems log in
 *     between), so the burst is bounded by time, not by the next foreign line.
 *   - "Spawned!" alone also fires on join / main menu, and AttachmentReceived
 *     bursts fire while the new body is dressed before the real respawn — the
 *     respawn needs the full bind-layout + bind-end + Spawned sequence.
 *   - On builds after 4.3.0 an on-foot death logs no trigger at all; the
 *     corpse body line is then both trigger and confirmation (cause unknown).
 */

const { matchSignal } = require('./deathSignatures');
const { buildReport, idFor } = require('./deathReport');

const OPEN_TIMEOUT_MS = 10 * 60 * 1000;
const BURST_GAP_MS = 2000;
const RESPAWN_LOCATION_WAIT_MS = 5000;
const PRECEDING_INCAP_WINDOW_MS = 10 * 60 * 1000;
const PASSENGER_COLLISION_WINDOW_MS = 30 * 1000;
const SAME_DEATH_WINDOW_MS = 15 * 1000;
// A confirmed death waits this long (log time) for its respawn sequence, then
// closes without one. Most never get one: across a 52.9M-line real corpus the
// bind-layout sequence followed the corpse within this window in roughly 1 in
// 10 deaths on recent builds (4 of 37 on build 12660092) and never before
// build 11875683. Without a bound, an unrelated re-bind hours later would be
// mistaken for the respawn. `respawnedAt` is therefore optional evidence.
const CONFIRMED_LINGER_MS = 10 * 60 * 1000;
const CONTROL_RELEASE_WINDOW_MS = 5 * 1000;
const CONTEXT_KINDS = new Set(['route', 'quantum_target', 'no_route', 'inventory_closed', 'cvar_displayinfo']);

/** `<2026-09-28T00:52:17.679Z> …` -> epoch ms, without a regex (hot path). */
function lineTime (raw) {
  if (raw.charCodeAt(0) !== 60 || raw.charCodeAt(25) !== 62) return NaN; // '<' … '>'
  return Date.parse(raw.slice(1, 25));
}

/**
 * @param {Object} [opts]
 * @param {string} [opts.handle] Fallback player handle when the log's own login lines were not seen (live tail joined mid-session).
 * @param {string} [opts.logFile] Log file name recorded on reports (basename only — never a full path).
 * @param {function(string): string|null} [opts.vehicleName] Display-name resolver passed to buildReport.
 * @param {function(string): string|null} [opts.zoneName] Display-name resolver passed to buildReport.
 * @returns {{ feed: function(number, string): Array<Object>, flush: function(): Array<Object>, setHandle: function(string): void, identity: function(): Object }}
 */
function createDeathDetector (opts = {}) {
  let identity = { handle: null, geid: null };
  let fallbackHandle = opts.handle || null;
  let session = { build: null, startedOn: null };
  let incident = null;
  let context = Object.create(null);     // latest entry per context kind
  let idleIncap = null;                  // last Incapacitated notice seen while idle
  let passengerCollision = null;         // last PlayerPilot:0 collision (may precede ActorState Dead)
  let lastControlRelease = null;         // last "Local client node releasing control token" (I was the pilot)
  let lastMs = NaN;

  const handle = () => identity.handle || fallbackHandle || null;
  const sessionId = () => ((session.startedOn || session.build)
    ? idFor(['session', session.startedOn || '', session.build || ''].join('|'))
    : null);

  /** true = me, false = someone else, null = cannot tell (identity not seen yet). */
  function isMe (geid, name) {
    if (geid && identity.geid) return geid === identity.geid;
    if (name && handle()) return name === handle();
    return null;
  }

  function report () {
    return buildReport(Object.assign({}, incident, {
      player: handle() || incident.player || 'unknown',
      sessionId: sessionId(),
      build: session.build,
      logFile: opts.logFile || null
    }), { vehicleName: opts.vehicleName, zoneName: opts.zoneName });
  }

  function evidence (lineNo, sig) {
    incident.evidence.push({ line: lineNo, at: sig.ts, signal: sig.signal });
    incident.lineEnd = lineNo;
  }

  function open (lineNo, sig, events) {
    incident = {
      status: 'open',
      triggerAt: sig.ts,
      triggerSignal: sig.signal,
      lineStart: lineNo,
      lineEnd: lineNo,
      player: handle(),
      // Snapshot: the latest breadcrumb of each kind before the trigger.
      context: Object.keys(context).map((k) => context[k]).sort((a, b) => a.line - b.line),
      collision: null,
      actorDead: null,
      kill: null,
      vehicleDestroyed: null,
      controlReleasedAt: null,
      incapacitatedAt: null,
      incapSource: null,
      incapLine: null,
      confirmedAt: null,
      confirmedLine: null,
      bodyId: null,
      items: [],
      burstOpen: false,
      burstLastMs: NaN,
      corpseId: null,
      corpseMarkerAt: null,
      corpseMarkerLine: null,
      respawn: null,
      respawnedAt: null,
      respawnLine: null,
      respawnLocationId: null,
      evidence: []
    };
    evidence(lineNo, sig);
    events.push({ type: 'death.opened', report: report() });
  }

  function confirm (lineNo, sig) {
    incident.status = 'confirmed';
    incident.confirmedAt = sig.ts;
    incident.confirmedLine = lineNo;
  }

  /** Emit `death.confirmed` once per incident, when its evidence is complete enough to show. */
  function announce (events) {
    if (!incident || incident.announced || incident.status !== 'confirmed') return;
    incident.announced = true;
    events.push({ type: 'death.confirmed', report: report() });
  }

  function close (events, why) {
    if (!incident) return;
    incident.burstOpen = false;
    if (incident.status === 'open') incident.status = 'unconfirmed';
    incident.closeReason = why;
    announce(events); // the log ended (or respawn came) before the manifest burst timed out
    events.push({ type: 'death.closed', report: report() });
    // A downed notice newer than this death's confirmation belongs to the next one.
    const confirmedMs = incident.confirmedAt ? Date.parse(incident.confirmedAt) : NaN;
    if (!(idleIncap && idleIncap.ms > confirmedMs)) idleIncap = null;
    incident = null;
    passengerCollision = null;
  }

  function resetSession (events) {
    close(events, 'session-end');
    identity = { handle: null, geid: null };
    session = { build: null, startedOn: null };
    context = Object.create(null);
  }

  function tryRespawn (events) {
    const r = incident && incident.respawn;
    if (!r || !r.layoutAt || !r.endAt || !r.spawnedAt) return;
    if (!r.landingTo && !r.locationExpired) return; // wait briefly for the landing line
    incident.respawnedAt = r.spawnedAt;
    incident.respawnLine = r.spawnedLine;
    incident.respawnLocationId = r.landingTo || null;
    close(events, 'respawn');
  }

  /** Housekeeping that depends only on log time passing. */
  function tick (ms, events) {
    if (!incident || Number.isNaN(ms)) return;
    if (incident.burstOpen && ms - incident.burstLastMs > BURST_GAP_MS) {
      incident.burstOpen = false;
      announce(events);
    }
    const r = incident.respawn;
    if (r && r.spawnedAt && !r.landingTo && ms - Date.parse(r.spawnedAt) > RESPAWN_LOCATION_WAIT_MS) {
      r.locationExpired = true;
      tryRespawn(events);
      if (!incident) return;
    }
    if (incident.status === 'open' && ms - Date.parse(incident.triggerAt) > OPEN_TIMEOUT_MS) {
      close(events, 'timeout');
      return;
    }
    if (incident.status === 'confirmed' && !incident.burstOpen &&
        ms - Date.parse(incident.confirmedAt) > CONFIRMED_LINGER_MS) {
      close(events, 'timeout');
    }
  }

  /**
   * A fresh trigger while the previous death was confirmed but never respawned
   * starts a new incident. Triggers right behind the confirmation (a kill line
   * followed by the ship's destruction) still belong to the same death.
   */
  function supersede (ms, events) {
    if (!incident || incident.status !== 'confirmed') return;
    if (ms - Date.parse(incident.confirmedAt) <= SAME_DEATH_WINDOW_MS) return;
    close(events, 'superseded');
  }

  /**
   * Feed one log line.
   * @param {number} lineNo 1-based line number in the file (informational; ordering key).
   * @param {string} raw The log line.
   * @returns {Array<{ type: string, report: Object }>} Zero or more `death.opened` / `death.confirmed` / `death.closed` events.
   */
  function feed (lineNo, raw) {
    const events = [];
    const line = String(raw);
    if (incident) {
      const ms = lineTime(line);
      if (!Number.isNaN(ms)) { lastMs = ms; tick(ms, events); }
    }
    const sig = matchSignal(line);
    if (!sig) return events;
    const f = sig.fields;
    const ms = sig.ts ? Date.parse(sig.ts) : lastMs;

    switch (sig.signal) {
      case 'session_build':
        if (session.build) resetSession(events);
        session.build = f.build;
        break;
      case 'session_start':
        if (session.startedOn) resetSession(events);
        session.startedOn = f.startedOn;
        break;
      case 'login_character':
        if (f.state === 'STATE_CURRENT') {
          identity.geid = f.geid;
          if (!identity.handle) identity.handle = f.name;
        }
        break;
      case 'login_handle':
        identity.handle = f.handle;
        break;

      case 'fatal_collision': {
        const col = Object.assign({ at: sig.ts, line: lineNo }, f);
        if (!f.playerPilot) {
          passengerCollision = col;
          if (incident && incident.status === 'open' && !incident.collision) { incident.collision = col; evidence(lineNo, sig); }
          break;
        }
        supersede(ms, events);
        if (!incident) open(lineNo, sig, events);
        else evidence(lineNo, sig);
        if (!incident.collision) incident.collision = col;
        break;
      }
      case 'clear_driver':
        // "Local client node [GEID]" is by definition this client.
        if (!identity.geid) identity.geid = f.geid;
        lastControlRelease = { vehicle: f.vehicle, at: sig.ts, ms, line: lineNo, signal: sig.signal };
        if (incident && incident.collision && incident.collision.vehicle === f.vehicle && !incident.controlReleasedAt) {
          incident.controlReleasedAt = sig.ts;
          evidence(lineNo, sig);
        }
        break;
      case 'actor_dead': {
        const me = isMe(f.geid, f.actor);
        const sameVehicle = !!(incident && incident.collision && incident.collision.vehicle === f.fromZone);
        if (me === false || (me === null && !sameVehicle)) break;
        supersede(ms, events);
        if (!incident) {
          open(lineNo, sig, events);
          if (passengerCollision && passengerCollision.vehicle === f.fromZone &&
              ms - Date.parse(passengerCollision.at) <= PASSENGER_COLLISION_WINDOW_MS) {
            incident.collision = passengerCollision;
          }
          // No collision line, but I had just released this ship's controls: I was flying it.
          if (lastControlRelease && lastControlRelease.vehicle === f.fromZone &&
              ms - lastControlRelease.ms <= CONTROL_RELEASE_WINDOW_MS) {
            incident.controlReleasedAt = lastControlRelease.at;
            incident.evidence.unshift({ line: lastControlRelease.line, at: lastControlRelease.at, signal: lastControlRelease.signal });
          }
        } else evidence(lineNo, sig);
        if (!incident.actorDead) incident.actorDead = Object.assign({ at: sig.ts, line: lineNo }, f);
        if (!identity.geid) identity.geid = f.geid;
        if (!identity.handle) identity.handle = f.actor;
        break;
      }
      case 'actor_death': {
        // <= 4.3.0 only. A kill line naming me is trigger and confirmation at once.
        if (isMe(f.victimId, f.victim) !== true) break;
        supersede(ms, events);
        if (!incident) open(lineNo, sig, events);
        else evidence(lineNo, sig);
        incident.kill = Object.assign({ at: sig.ts, line: lineNo }, f);
        if (incident.status === 'open') confirm(lineNo, sig);
        announce(events);
        break;
      }
      case 'vehicle_destruction': {
        // <= 4.3.0 only. Hard-death level (>= 2) of a vehicle I was driving.
        if (isMe(f.driverId, f.driver) !== true || !(f.toLevel >= 2)) break;
        supersede(ms, events);
        if (!incident) open(lineNo, sig, events);
        else evidence(lineNo, sig);
        if (!incident.vehicleDestroyed) incident.vehicleDestroyed = Object.assign({ at: sig.ts, line: lineNo }, f);
        break;
      }
      case 'incapacitated':
        // Idle, or still waiting on a respawn for a death already confirmed:
        // remember it for the NEXT incident (it cannot belong to this one).
        if (!incident || (incident.status === 'confirmed' && !incident.burstOpen)) {
          idleIncap = { at: sig.ts, line: lineNo, ms };
          break;
        }
        if (incident.status === 'open' && !incident.incapacitatedAt) {
          incident.incapacitatedAt = sig.ts;
          incident.incapSource = 'during-incident';
          incident.incapLine = lineNo;
          evidence(lineNo, sig);
        }
        break;

      case 'corpse_item': {
        const inBurst = !!(incident && incident.burstOpen);
        if (f.isBody && !inBurst) {
          supersede(ms, events);
          if (!incident) {
            open(lineNo, sig, events);
            // On-foot death: the downed notice came while idle. Labelled as such.
            if (idleIncap && ms - idleIncap.ms <= PRECEDING_INCAP_WINDOW_MS) {
              incident.incapacitatedAt = idleIncap.at;
              incident.incapSource = 'preceding-notice';
              incident.incapLine = idleIncap.line;
            }
          } else evidence(lineNo, sig);
          if (incident.status === 'open') confirm(lineNo, sig);
          incident.bodyId = f.bodyId;
          incident.burstOpen = true;
          incident.burstLastMs = ms;
        } else if (!inBurst) {
          break; // a corpse-LOOT burst (starts with gear, not a body) — not a death
        }
        incident.items.push({ itemClass: f.itemClass, port: f.port, classGuid: f.classGuid, kept: f.kept });
        if (!Number.isNaN(ms) && !(ms < incident.burstLastMs)) incident.burstLastMs = ms;
        incident.lineEnd = lineNo;
        break;
      }
      case 'corpse_marker':
        if (incident && incident.status === 'confirmed' && isMe(null, f.actor) !== false && !incident.corpseId) {
          incident.corpseId = f.corpseId;
          incident.corpseMarkerAt = sig.ts;
          incident.corpseMarkerLine = lineNo;
          evidence(lineNo, sig);
        }
        break;

      case 'bind_layout':
        if (incident && isMe(f.geid, null) !== false) {
          incident.respawn = { layoutAt: sig.ts };
          evidence(lineNo, sig);
        }
        break;
      case 'bind_end':
        if (incident && incident.respawn && incident.respawn.layoutAt && isMe(f.geid, null) !== false) {
          incident.respawn.endAt = sig.ts;
          evidence(lineNo, sig);
        }
        break;
      case 'spawned':
        if (incident && incident.respawn && incident.respawn.endAt && !incident.respawn.spawnedAt) {
          incident.respawn.spawnedAt = sig.ts;
          incident.respawn.spawnedLine = lineNo;
          evidence(lineNo, sig);
          tryRespawn(events);
        }
        break;
      case 'inventory_location':
        if (incident && incident.respawn && incident.respawn.layoutAt && !incident.respawn.landingTo &&
            f.landingFrom === '0' && f.landingTo !== '0' && isMe(null, f.player) !== false) {
          incident.respawn.landingTo = f.landingTo;
          evidence(lineNo, sig);
          tryRespawn(events);
        }
        break;

      default:
        if (CONTEXT_KINDS.has(sig.signal)) {
          context[sig.signal] = Object.assign({ kind: sig.signal, at: sig.ts, line: lineNo }, f);
        }
    }
    return events;
  }

  /**
   * End of input: finalize whatever is still open (a confirmed death with no
   * respawn stays `confirmed`; an open trigger closes as `unconfirmed`).
   * @returns {Array<{ type: string, report: Object }>}
   */
  function flush () {
    const events = [];
    close(events, 'end-of-log');
    return events;
  }

  return {
    feed,
    flush,
    /** @param {string} h Fallback handle (e.g. the relay's session handle). */
    setHandle: (h) => { if (h) fallbackHandle = h; },
    identity: () => ({ handle: handle(), geidKnown: !!identity.geid })
  };
}

module.exports = {
  createDeathDetector,
  OPEN_TIMEOUT_MS,
  BURST_GAP_MS
};
