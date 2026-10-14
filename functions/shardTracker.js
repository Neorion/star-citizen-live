'use strict';

/**
 * Shard tracker — a per-log-session state machine over raw Game.log lines
 * that records which shard this client joined, which replication endpoint
 * it was attached to, and when its own actor was handed between servers,
 * each stamped with the last place the log mentioned.
 *
 * Pure (no I/O). Feed lines in file order; get records back.
 *
 * What the records claim, and what they do not:
 *   - `join`     The shard id is read verbatim from <Join PU>. Its region /
 *                build / number come from the id's own grammar. VERIFIED.
 *   - `handoff`  The replicant endpoint changed mid-session. We record that
 *                it changed and where you were. Whether that is a server-
 *                boundary crossing or a replication-layer rebalance is NOT
 *                established — it is inferred evidence for a place → server
 *                map, nothing more.
 *   - `authority` Your own actor lost authority (handed between servers),
 *                with the last known place. Inferred boundary crossing.
 *   - `place`    The most recent kiosk location / quantum target / route
 *                start seen BEFORE the event, with its own timestamp, so a
 *                consumer can judge how stale it is. Never a position.
 *
 * Records carry no handle, GEID, session id or node id.
 */

const crypto = require('crypto');
const { matchSignal } = require('./shardSignals');

function idFor (content) {
  return crypto.createHash('sha256').update(String(content)).digest('hex').slice(0, 32);
}

/**
 * @param {Object} [opts]
 * @param {string} [opts.logFile] Basename recorded on records (never a full path).
 * @returns {{ feed: function(string): Array<Object>, flush: function(): Array<Object>, current: function(): Object }}
 */
function createShardTracker (opts = {}) {
  const logFile = opts.logFile || null;
  let build = null;
  let shard = null;        // { id, env, region, build, index, address, port, joinedAt }
  let replicant = null;    // { address, port, since }
  let place = null;        // { token, kind, at }
  let seenBuild = false;

  const placeOf = () => (place ? { place: place.token, placeKind: place.kind, placeAt: place.at } : { place: null, placeKind: null, placeAt: null });
  const shardOf = () => ({ shardId: shard ? shard.id : null, region: shard ? shard.region : null, build: (shard && shard.build) || build });

  function reset () {
    shard = null;
    replicant = null;
    place = null;
  }

  /**
   * @param {string} raw
   * @returns {Array<{ type: 'join'|'handoff'|'authority'|'changeServer', record: Object }>}
   */
  function feed (raw) {
    const sig = matchSignal(raw);
    if (!sig) return [];
    const f = sig.fields;
    const at = sig.ts;
    const out = [];

    switch (sig.signal) {
      case 'session_build':
        if (seenBuild) reset(); // a new log header: new game launch
        seenBuild = true;
        build = f.build;
        break;
      case 'join_pu': {
        shard = Object.assign({}, f.shard, { address: f.address, port: f.port, joinedAt: at });
        replicant = null; // the next replicant line is the first of this shard
        out.push({ type: 'join', record: Object.assign({
          id: idFor(['shard-join', at, f.shard.id, f.address, f.port].join('|')),
          at,
          address: f.address,
          port: f.port,
          locationId: f.locationId,
          logFile
        }, shardOf(), placeOf()) });
        break;
      }
      case 'replicant': {
        if (replicant && (replicant.address !== f.address || replicant.port !== f.port)) {
          out.push({ type: 'handoff', record: Object.assign({
            id: idFor(['shard-handoff', at, replicant.address, replicant.port, f.address, f.port].join('|')),
            at,
            from: { address: replicant.address, port: replicant.port, since: replicant.since },
            to: { address: f.address, port: f.port },
            logFile
          }, shardOf(), placeOf()) });
        }
        if (!replicant || replicant.address !== f.address || replicant.port !== f.port) {
          replicant = { address: f.address, port: f.port, since: at };
        }
        break;
      }
      case 'lost_authority':
        // Only the player's own actor; UI/comms pseudo-entities also log this.
        if (/^ui_entity/.test(f.player)) break;
        out.push({ type: 'authority', record: Object.assign({
          id: idFor(['shard-authority', at, replicant ? replicant.address + ':' + replicant.port : ''].join('|')),
          at,
          replicant: replicant ? { address: replicant.address, port: replicant.port } : null,
          logFile
        }, shardOf(), placeOf()) });
        break;
      case 'change_server':
        out.push({ type: 'changeServer', record: Object.assign({
          id: idFor(['shard-changeserver', at, f.phase].join('|')),
          at,
          phase: f.phase,
          shardPersisted: f.shardPersisted,
          server: f.server,
          multiplayer: f.multiplayer,
          logFile
        }, shardOf(), placeOf()) });
        break;
      case 'place_location':
        place = { token: f.place, kind: 'kiosk', at };
        break;
      case 'place_quantum':
        place = { token: f.place, kind: 'quantum-target', at };
        break;
      case 'place_route':
        place = { token: f.place, kind: 'route-start', at };
        break;
      default:
        break;
    }
    return out;
  }

  return {
    feed,
    /** Nothing is buffered; present for symmetry with the other detectors. */
    flush: () => [],
    /** @returns {{ shard: Object|null, replicant: Object|null, place: Object|null, build: string|null }} */
    current: () => ({ shard: shard ? Object.assign({}, shard) : null, replicant: replicant ? Object.assign({}, replicant) : null, place: place ? Object.assign({}, place) : null, build })
  };
}

module.exports = { createShardTracker, idFor };
