'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { matchSignal, parseShardId } = require('../../functions/shardSignals');
const { createShardTracker } = require('../../functions/shardTracker');
const shardStore = require('../../functions/shardStore');

// Line shapes copied from real 4.10 logs; handle, ids and addresses replaced
// (TEST-NET addresses, placeholder GEID/GUIDs, shard number kept realistic).
const L = {
  build: '<2026-09-28T06:35:10.000Z> BackupNameAttachment=" Build(12660092) 27 Sep 26 (16 21 45)"  -- used by backup system',
  login: '<2026-09-28T06:35:12.000Z> [Notice] <Legacy login response> [CIG-net] User Login Success - Handle[TestPilot] - Time[900000001] [Team_GameServices][Login]',
  changeStart: '<2026-09-28T06:35:20.617Z> [Notice] <Change Server Start> IsShardPersisted[1] IsServer[0] IsMultiplayer[0] [Team_Network][Network][Loading]',
  seed: '<2026-09-28T06:35:20.730Z> [Notice] <ShardSeeding Success> ShardId[local_shard], ShardName[], ShardStatus[3], MegaMap[MegaMap.Frontend], GameMode[SC_Frontend] [Team_OnlineTech][EntityGraph][Seeding][Services]',
  join: '<2026-09-28T06:35:38.985Z> [Notice] <Join PU> address[203.0.113.10] port[64348] shard[pub_use1b_12660092_010] locationId[-5551234] [Team_GameServices][GIM][Matchmaking]',
  rep1: '<2026-09-28T06:35:39.008Z> [Notice] <ContextEstablisher Model Change State> The Model is changing state meaning views must update their model state. oldState=0 newState=0 localState=0 remoteState=0 modelState=0 ViewName="Replicant 203.0.113.10:64348" connection={3, 0} node_id=00000000-0000-0000-0000-000000000001 playerGEID=900000000001 sessionId="00000000000000000000000000000000" [Team_Network][Network][Replication]',
  localRep: '<2026-09-28T06:35:39.100Z> [Notice] <ContextEstablisher Model Change State> The Model is changing state. ViewName="Replicant <local>:16" connection={1, 0} node_id=00000000-0000-0000-0000-000000000001 [Team_Network][Network][Replication]',
  kiosk: '<2026-09-28T07:03:29.500Z> [Notice] <RequestLocationInventory> Player[TestPilot] requested inventory for Location[RR_P5_L2] [Inventory]',
  qt: '<2026-09-28T07:30:46.223Z> [Notice] <Player Selected Quantum Target - Local> [ItemNavigation][CL][41552] | NOT AUTH | ANVL_Asgard_900000000002[900000000002]|CSCItemNavigation::OnPlayerSelectedQuantumTarget|Player has selected point NavPoint_Dynamic_900000000003 as their destination, routing locally [Team_CGP4][QuantumTravel]',
  route: '<2026-09-28T07:30:46.223Z> [Notice] <Calculate Route> [ItemNavigation][CL][41552] | NOT AUTH | ANVL_Asgard_900000000002[900000000002]|CSCItemNavigation::CalculateRoute|Projected Start Location is Gaslight for route to destination NavPoint_Dynamic_900000000003 [Team_CGP4][QuantumTravel]',
  rep2: '<2026-09-28T08:43:26.144Z> [Notice] <Recv Bind Batch End Player> Bind Batch End enabled player in batch 7806 ViewName="Replicant 203.0.113.20:64295" connection={3, 0} node_id=00000000-0000-0000-0000-000000000001 playerGEID=900000000001 sessionId="00000000000000000000000000000000"  entityId=900000000001, className="Player" [Team_Network][Network][Replication]',
  authority: '<2026-09-28T08:43:27.000Z> [Notice] <ActorAction_ResetActionState> Resetting action state due to time inconsistency or non-contiguous data. Player: TestPilot [900000000001], Reason: Lost authority, Frame start time: 900000001, Other time 0: 0, Other time 1: 0. [Team_ActorFeatures][Actor]',
  uiAuthority: '<2026-09-28T08:43:27.100Z> [Notice] <ActorAction_ResetActionState> Resetting action state due to time inconsistency or non-contiguous data. Player: ui_entity_0000 (comms_user) [9467], Reason: Lost authority, Frame start time: 900000001, Other time 0: 0, Other time 1: 0. [Team_ActorFeatures][Actor]',
  changeEnd: '<2026-09-28T08:50:00.000Z> [Notice] <Change Server End> IsShardPersisted[0] IsServer[1] IsMultiplayer[1] IsOnline[1] IsPersistedInEnvironment[1] IsPersistedInGameMode[0] [Team_Network][Network][Loading]'
};

test('parseShardId reads region / build / number from the id grammar, never guesses', () => {
  assert.deepStrictEqual(parseShardId('pub_use1b_12660092_010'), { id: 'pub_use1b_12660092_010', env: 'pub', region: 'use1b', build: '12660092', index: '010' });
  assert.deepStrictEqual(parseShardId('local_shard'), { id: 'local_shard', env: null, region: null, build: null, index: null });
});

test('every signature matches its real line shape and ignores near misses', () => {
  assert.strictEqual(matchSignal(L.join).signal, 'join_pu');
  assert.deepStrictEqual(matchSignal(L.join).fields.shard.region, 'use1b');
  assert.strictEqual(matchSignal(L.join).fields.port, 64348);
  assert.strictEqual(matchSignal(L.rep1).signal, 'replicant');
  assert.strictEqual(matchSignal(L.rep1).fields.address, '203.0.113.10');
  assert.strictEqual(matchSignal(L.localRep), null, 'the in-process <local> replicant is not an endpoint');
  assert.strictEqual(matchSignal(L.authority).signal, 'lost_authority');
  assert.strictEqual(matchSignal(L.changeStart).fields.phase, 'start');
  assert.strictEqual(matchSignal(L.changeEnd).fields.server, true);
  assert.strictEqual(matchSignal(L.seed).fields.shardId, 'local_shard');
  assert.strictEqual(matchSignal(L.kiosk).fields.place, 'RR_P5_L2');
  assert.strictEqual(matchSignal(L.qt).fields.place, 'NavPoint_Dynamic_900000000003');
  assert.strictEqual(matchSignal(L.route).fields.place, 'Gaslight');
  assert.strictEqual(matchSignal(L.authority.replace('Lost authority', 'Lost control')), null);
  assert.strictEqual(matchSignal('<2026-09-28T06:35:38.985Z> [Notice] <Join PU> something else entirely'), null);
});

test('tracker: join, handoff with last place, own authority loss; UI entities ignored', () => {
  const t = createShardTracker({ logFile: 'Game.log' });
  const events = [];
  for (const k of ['build', 'login', 'changeStart', 'seed', 'join', 'rep1', 'localRep', 'kiosk', 'qt', 'route', 'rep2', 'authority', 'uiAuthority', 'changeEnd']) events.push(...t.feed(L[k]));
  assert.deepStrictEqual(events.map((e) => e.type), ['changeServer', 'join', 'handoff', 'authority', 'changeServer']);
  const join = events[1].record;
  assert.strictEqual(join.shardId, 'pub_use1b_12660092_010');
  assert.strictEqual(join.region, 'use1b');
  assert.strictEqual(join.build, '12660092');
  assert.strictEqual(join.address, '203.0.113.10');
  const hand = events[2].record;
  assert.deepStrictEqual(hand.from, { address: '203.0.113.10', port: 64348, since: '2026-09-28T06:35:39.008Z' });
  assert.deepStrictEqual(hand.to, { address: '203.0.113.20', port: 64295 });
  assert.strictEqual(hand.place, 'Gaslight', 'the most recent place signal wins');
  assert.strictEqual(hand.placeKind, 'route-start');
  assert.strictEqual(hand.placeAt, '2026-09-28T07:30:46.223Z');
  assert.strictEqual(hand.shardId, 'pub_use1b_12660092_010');
  const auth = events[3].record;
  assert.deepStrictEqual(auth.replicant, { address: '203.0.113.20', port: 64295 });
  assert.strictEqual(auth.place, 'Gaslight');
  assert.strictEqual(t.current().shard.id, 'pub_use1b_12660092_010');
  // Nothing identifying leaks into records.
  const json = JSON.stringify(events);
  assert.ok(!json.includes('TestPilot') && !json.includes('900000000001') && !json.includes('sessionId'));
});

test('tracker: a new log header resets shard and endpoint state', () => {
  const t = createShardTracker();
  for (const k of ['build', 'join', 'rep1']) t.feed(L[k]);
  assert.ok(t.current().shard);
  t.feed(L.build);
  assert.strictEqual(t.current().shard, null);
  assert.strictEqual(t.current().replicant, null);
  // A fresh join after the reset is a join, not a handoff.
  const ev = [].concat(t.feed(L.join), t.feed(L.rep1));
  assert.deepStrictEqual(ev.map((e) => e.type), ['join']);
});

test('store: idempotent add, summary and CSV', () => {
  const s = shardStore.emptyStore();
  const t = createShardTracker({ logFile: 'Game.log' });
  const events = [];
  for (const k of ['build', 'join', 'rep1', 'kiosk', 'rep2', 'authority']) events.push(...t.feed(L[k]));
  for (const e of events) assert.strictEqual(shardStore.addEvent(s, e), true);
  for (const e of events) assert.strictEqual(shardStore.addEvent(s, e), false, 'same event again is a no-op');
  const sum = shardStore.summary(s);
  assert.deepStrictEqual(sum.counts, { joins: 1, handoffs: 1, authority: 1 });
  assert.strictEqual(sum.shards.length, 1);
  assert.strictEqual(sum.shards[0].endpoints, 2);
  assert.deepStrictEqual(sum.regions, { use1b: 1 });
  assert.deepStrictEqual(sum.handoffsByPlace, [{ place: 'RR_P5_L2', count: 1 }]);
  const csv = shardStore.toCSV(s);
  assert.match(csv.split('\n')[0], /^kind,at,shardId,region/);
  assert.strictEqual(csv.trim().split('\n').length, 4);
  assert.match(csv, /handoff,2026-09-28T08:43:26\.144Z,pub_use1b_12660092_010,use1b,12660092,RR_P5_L2,kiosk/);
});
test('signals: ids that fail validation or name object prototypes yield no join', () => {
  const mk = (id) => L.join.replace('pub_use1b_12660092_010', id);
  for (const id of ['__proto__', 'constructor', 'a b', 'x'.repeat(65), 'pub.use']) {
    assert.strictEqual(matchSignal(mk(id)), null, id);
    const t = createShardTracker({ logFile: 'Game.log' });
    assert.deepStrictEqual(t.feed(mk(id)), [], id);
  }
  assert.strictEqual(parseShardId('a/b'), null);
  assert.strictEqual(parseShardId(''), null);
  assert.strictEqual(({}).joins, undefined);
});

test('store: a stored record with a prototype-name shardId cannot break summary()', () => {
  const s = shardStore.emptyStore();
  s.joins.push({ id: 'j1', at: '2026-09-28T06:35:38.985Z', shardId: 'constructor', region: '__proto__', address: '203.0.113.10', port: 1 });
  s.joins.push({ id: 'j2', at: '2026-09-28T06:36:38.985Z', shardId: '__proto__', address: '203.0.113.11', port: 2 });
  s.handoffs.push({ id: 'h1', at: '2026-09-28T06:37:00.000Z', shardId: 'constructor', place: '__proto__', from: { address: '203.0.113.10', port: 1 }, to: { address: '203.0.113.20', port: 3 } });
  let sum;
  assert.doesNotThrow(() => { sum = shardStore.summary(s); });
  assert.strictEqual(sum.shards.length, 2);
  assert.strictEqual(sum.handoffsByPlace[0].place, '__proto__');
  assert.strictEqual(({}).joins, undefined);
  assert.strictEqual(({}).region, undefined);
});

test('store: addEvent drops invalid shard ids and over-long places', () => {
  const s = shardStore.emptyStore();
  const rec = (over) => ({ type: 'handoff', record: Object.assign({ id: 'h-' + Math.random(), at: '2026-09-28T06:37:00.000Z', shardId: 'pub_use1b_12660092_010', place: 'Gaslight', from: { address: '203.0.113.10', port: 1 }, to: { address: '203.0.113.20', port: 2 } }, over) });
  assert.strictEqual(shardStore.addEvent(s, rec({ shardId: 'bad id!' })), false);
  assert.strictEqual(shardStore.addEvent(s, rec({ shardId: null })), true, 'null shardId is allowed');
  assert.strictEqual(shardStore.addEvent(s, rec({ place: 'x'.repeat(201) })), true);
  assert.strictEqual(shardStore.addEvent(s, rec({ place: 'x'.repeat(200) })), true);
  assert.strictEqual(s.handoffs.length, 3);
  assert.strictEqual(s.handoffs.filter((r) => r.place === null).length, 1, 'over-long place stored as null');
});

test('store: CSV prefixes formula-looking text cells, not numbers', () => {
  const s = shardStore.emptyStore();
  const at = '2026-09-28T06:37:00.000Z';
  const places = ['=1+1', '+SUM(A1)', '-2', '@x', '\tTab', '\rCR', 'ok', 'a,b'];
  places.forEach((place, i) => s.handoffs.push({ id: 'h' + i, at, shardId: 'pub_use1b_12660092_010', place, from: { address: '203.0.113.10', port: -5 }, to: { address: '203.0.113.20', port: 2 } }));
  const csv = shardStore.toCSV(s);
  for (const p of ['=1+1', '+SUM(A1)', '-2', '@x']) assert.ok(csv.includes(',' + String.fromCharCode(39) + p + ','), p);
  assert.ok(csv.includes(',"' + String.fromCharCode(39) + '\rCR",'), 'CR-leading cell is prefixed and quoted');
  assert.ok(csv.includes(',ok,') && csv.includes(',"a,b",'));
  assert.ok(csv.includes(',203.0.113.10,-5,'), 'numeric cells are not prefixed');
});
