'use strict';

/**
 * Game.log signatures for shard / server-topology capture.
 *
 * Pure leaf module: a line in, a classified signal out. No I/O, no state.
 *
 * Honesty: every signature below was matched against one player's real 4.10
 * logs on 2026-10-13 (builds 12660092 → 12913470). What each line MEANS at
 * the server-meshing level is partly inferred — see functions/shardTracker.js
 * for the claims we make and the ones we do not.
 *
 *   join_pu          <Join PU> address[ip] port[n] shard[pub_use1b_12660092_010] locationId[…]
 *                    The one line that names the shard. VERIFIED (84 joins / 25 files).
 *   replicant        ViewName="Replicant ip:port" on the Context-Establisher / Bind-Batch
 *                    lines: the replication endpoint this client is attached to. VERIFIED.
 *   lost_authority   <ActorAction_ResetActionState> … Player: <handle> [geid], Reason: Lost authority
 *                    Our own actor handed between servers. VERIFIED (322 / 25 files).
 *   change_server    <Change Server Start|End> IsShardPersisted[…] IsServer[…] IsMultiplayer[…]
 *   shard_seed       <ShardSeeding Success> ShardId[local_shard] … (client-local seeding)
 *   place context    RequestLocationInventory Location[…], quantum target selected, route start
 *   session          login handle, build number
 */

const TS = /^<(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)> ?/;
const IP = '(\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})';

/**
 * `pub_use1b_12660092_010` -> { env: 'pub', region: 'use1b', build: '12660092', index: '010' }.
 * Unknown shapes return only the raw id — never a guessed region.
 * @param {string} shardId
 * @returns {{ id: string, env: string|null, region: string|null, build: string|null, index: string|null }}
 */
function parseShardId (shardId) {
  const id = String(shardId || '');
  const m = id.match(/^([a-z]+)_([a-z]+\d*[a-z]?)_(\d{6,})_(\d+)$/i);
  if (!m) return { id, env: null, region: null, build: null, index: null };
  return { id, env: m[1], region: m[2], build: m[3], index: m[4] };
}

const SIGNATURES = [
  {
    signal: 'session_build', hint: 'BackupNameAttachment',
    test: /BackupNameAttachment="\s*Build\((\d+)\)/,
    fields: (m) => ({ build: m[1] })
  },
  {
    signal: 'login_handle', hint: '<Legacy login response>',
    test: /<Legacy login response> .*?Handle\[([^\]]+)\]/,
    fields: (m) => ({ handle: m[1] })
  },
  {
    signal: 'join_pu', hint: '<Join PU>',
    test: new RegExp(`<Join PU> address\\[${IP}\\] port\\[(\\d+)\\] shard\\[([^\\]]+)\\](?: locationId\\[(-?\\d+)\\])?`),
    fields: (m) => Object.assign({ address: m[1], port: Number(m[2]), locationId: m[4] || null }, { shard: parseShardId(m[3]) })
  },
  {
    signal: 'replicant', hint: 'ViewName="Replicant ',
    test: new RegExp(`ViewName="Replicant ${IP}:(\\d+)"`),
    fields: (m) => ({ address: m[1], port: Number(m[2]) })
  },
  {
    signal: 'lost_authority', hint: 'Reason: Lost authority',
    test: /<ActorAction_ResetActionState> .*?Player: (\S+) \[(\d+)\], Reason: Lost authority/,
    fields: (m) => ({ player: m[1], geid: m[2] })
  },
  {
    signal: 'change_server', hint: '<Change Server ',
    test: /<Change Server (Start|End)> IsShardPersisted\[(\d)\] IsServer\[(\d)\] IsMultiplayer\[(\d)\]/,
    fields: (m) => ({ phase: m[1].toLowerCase(), shardPersisted: m[2] === '1', server: m[3] === '1', multiplayer: m[4] === '1' })
  },
  {
    signal: 'shard_seed', hint: '<ShardSeeding Success>',
    test: /<ShardSeeding Success> ShardId\[([^\]]*)\]/,
    fields: (m) => ({ shardId: m[1] })
  },
  {
    signal: 'place_location', hint: '<RequestLocationInventory>',
    test: /<RequestLocationInventory> Player\[([^\]]+)\] requested inventory for Location\[([^\]]+)\]/,
    fields: (m) => ({ player: m[1], place: m[2] })
  },
  {
    signal: 'place_quantum', hint: 'OnPlayerSelectedQuantumTarget',
    test: /OnPlayerSelectedQuantumTarget\|Player has selected point (\S+) as their destination/,
    fields: (m) => ({ place: m[1] })
  },
  {
    signal: 'place_route', hint: 'CSCItemNavigation::CalculateRoute|Projected Start Location is',
    test: /CalculateRoute\|Projected Start Location is (.+?) for route to destination (\S+)/,
    fields: (m) => ({ place: m[1], destination: m[2] })
  }
];

/**
 * @param {string} raw One log line.
 * @returns {{ signal: string, ts: string|null, fields: Object }|null}
 */
function matchSignal (raw) {
  const line = String(raw);
  for (const sig of SIGNATURES) {
    if (line.indexOf(sig.hint) === -1) continue;
    const m = line.match(sig.test);
    if (m) {
      const t = line.match(TS);
      return { signal: sig.signal, ts: t ? t[1] : null, fields: sig.fields(m) };
    }
  }
  return null;
}

module.exports = { SIGNATURES, matchSignal, parseShardId };
