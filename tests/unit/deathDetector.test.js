'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { createDeathDetector } = require('../../functions/deathDetector');

// Real Game.log slice, build 12660092 (2026-09-27), scrubbed of identifiers.
const FIXTURE = path.join(__dirname, '..', 'relay', 'fixtures', 'death-fatal-collision-pilot.log');
const LINES = fs.readFileSync(FIXTURE, 'utf8').split(/\r?\n/);
const HANDLE = 'TestPilot';
const VEHICLE = 'ANVL_Asgard_900000000002';

function run (lines, opts) {
  const det = createDeathDetector(opts);
  const events = [];
  lines.forEach((l, i) => { for (const e of det.feed(i + 1, l)) events.push(Object.assign({ atLine: i + 1 }, e)); });
  for (const e of det.flush()) events.push(Object.assign({ atLine: 'flush' }, e));
  return events;
}
const closed = (events) => events.filter((e) => e.type === 'death.closed').map((e) => e.report);
const lineNo = (re) => LINES.findIndex((l) => re.test(l)) + 1;

test('fixture: exactly one confirmed incident with the expected fields', () => {
  const events = run(LINES, { logFile: 'Game.log' });
  const reports = closed(events);
  assert.strictEqual(reports.length, 1);
  const r = reports[0];
  assert.strictEqual(r.status, 'confirmed');
  assert.strictEqual(r.player, HANDLE);
  assert.strictEqual(r.cause, 'vehicle_collision_pilot');
  assert.ok(r.modifiers.includes('ttd_expired'));
  assert.ok(!r.modifiers.includes('possible_lag_spike'));
  assert.strictEqual(r.triggerAt, '2026-09-28T00:52:17.679Z');
  assert.strictEqual(r.incapacitatedAt, '2026-09-28T00:52:18.252Z');
  assert.strictEqual(r.incapSource, 'during-incident');
  assert.strictEqual(r.confirmedAt, '2026-09-28T00:52:47.810Z');
  assert.strictEqual(r.respawnedAt, '2026-09-28T00:53:05.794Z');
  assert.strictEqual(r.zone, 'pyro4');
  assert.strictEqual(r.zoneName, 'Pyro IV');
  assert.strictEqual(r.vehicle, VEHICLE);
  assert.strictEqual(r.vehicleName, 'Anvil Asgard');
  assert.strictEqual(r.wasPilot, true);
  assert.strictEqual(r.controlReleasedAt, '2026-09-28T00:52:17.813Z');
  assert.strictEqual(r.impactPart, 'Tail');
  assert.ok(Math.abs(r.impactSpeed - 17.84) <= 0.01);
  assert.strictEqual(r.colliderEntity, 'UNKNOWN');
  assert.strictEqual(r.collider, 'terrain');
  assert.ok(Math.abs(r.lastFrameMs - 25.16) <= 0.01);
  assert.strictEqual(r.items.length, 45);
  assert.strictEqual(r.itemsKept, 7);
  assert.strictEqual(r.itemsLost, 38);
  assert.match(r.respawnLocationId, /^\d+$/);
  assert.strictEqual(r.build, '12660092');
  assert.strictEqual(r.logFile, 'Game.log');
  const kinds = new Set(r.timeline.map((t) => t.kind));
  for (const k of ['context', 'trigger', 'incapacitated', 'confirmed', 'respawn']) assert.ok(kinds.has(k), `timeline has ${k}`);
  assert.match(r.summary, /^Crashed Anvil Asgard tail-first into terrain on Pyro IV at 17\.8 m\/s \(64 km\/h\)/);
  assert.match(r.summary, /incapacitated, no revive, died after 30 s$/);
});

test('fixture: event order is opened -> confirmed (full manifest) -> closed', () => {
  const events = run(LINES);
  assert.deepStrictEqual(events.map((e) => e.type), ['death.opened', 'death.confirmed', 'death.closed']);
  assert.strictEqual(events[0].atLine, lineNo(/<FatalCollision>/));
  assert.strictEqual(events[1].report.items.length, 45, 'confirmed is announced with the whole manifest');
  assert.strictEqual(events[2].atLine, lineNo(/OnClientSpawned\] Spawned!/));
  assert.strictEqual(events[1].report.id, events[2].report.id, 'confirmed and closed share one id');
});

test('fixture: the replayed Incapacitated notice after respawn creates and modifies nothing', () => {
  const replay = LINES.map((l, i) => (/"Incapacitated:/.test(l) && /Added notification/.test(l) ? i + 1 : 0)).filter(Boolean);
  assert.strictEqual(replay.length, 2, 'one real + one replayed notice');
  const events = run(LINES);
  assert.ok(events.every((e) => e.atLine === 'flush' || e.atLine < replay[1]), 'no event at or after the replay');
  assert.strictEqual(closed(events)[0].incapacitatedAt, '2026-09-28T00:52:18.252Z');
});

test('fixture: the AttachmentReceived burst before the real respawn does not close the incident', () => {
  const firstAttach = lineNo(/<AttachmentReceived>/);
  const spawned = lineNo(/OnClientSpawned\] Spawned!/);
  assert.ok(firstAttach < spawned);
  const upToBurst = run(LINES.slice(0, lineNo(/<Bind Change Layout Player>/) - 1));
  const r = closed(upToBurst)[0];
  assert.strictEqual(r.status, 'confirmed');
  assert.strictEqual(r.respawnedAt, null, 'dressing the new body is not a respawn');
});

test('reports carry no raw log lines, GEIDs or item instance ids', () => {
  const r = closed(run(LINES))[0];
  const json = JSON.stringify(r);
  assert.ok(!json.includes('900000000001'), 'player GEID is not stored');
  assert.ok(r.evidence.every((e) => Object.keys(e).sort().join() === 'at,line,signal'), 'evidence is line refs only');
  assert.ok(r.items.every((i) => i.instance === undefined));
  assert.ok(!/<FatalCollision>|\[Notice\]/.test(json));
});

test('out-of-order timestamps inside the manifest burst do not split it', () => {
  const lines = LINES.slice();
  const first = lineNo(/PopulateItemPortForItemRecoveryEntitlement/) - 1;
  // Game.log is not strictly monotonic: push two manifest rows 1 ms into the past.
  let moved = 0;
  for (let i = first + 5; i < lines.length && moved < 2; i++) {
    if (/PopulateItemPortForItemRecoveryEntitlement/.test(lines[i])) {
      lines[i] = lines[i].replace('00:52:47.810Z', '00:52:47.809Z');
      moved += 1;
    }
  }
  assert.strictEqual(moved, 2);
  const r = closed(run(lines))[0];
  assert.strictEqual(r.items.length, 45);
  assert.strictEqual(r.confirmedAt, '2026-09-28T00:52:47.810Z');
});

test('pilot collision then respawn with no corpse closes as unconfirmed (ejected alive)', () => {
  const lines = LINES.filter((l) => !/PopulateItemPortForItemRecoveryEntitlement|CorpseMarker_/.test(l));
  const reports = closed(run(lines));
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].status, 'unconfirmed');
  assert.strictEqual(reports[0].cause, 'vehicle_collision_pilot');
  assert.strictEqual(reports[0].confirmedAt, null);
  assert.strictEqual(reports[0].respawnedAt, '2026-09-28T00:53:05.794Z');
  assert.match(reports[0].summary, /no corpse logged \(survived, revived, or the body was lost with the ship\)/);
  assert.strictEqual(reports[0].closedBy, 'respawn');
});

test('an open incident with nothing after it times out as unconfirmed after 10 minutes of log time', () => {
  const upToTrigger = LINES.slice(0, lineNo(/<FatalCollision>/));
  const later = '<2026-09-28T01:02:18.000Z> [Notice] <Something> ten minutes later';
  const det = createDeathDetector();
  const events = [];
  upToTrigger.concat([later]).forEach((l, i) => events.push(...det.feed(i + 1, l)));
  assert.deepStrictEqual(events.map((e) => e.type), ['death.opened', 'death.closed']);
  assert.strictEqual(events[1].report.status, 'unconfirmed');
  assert.deepStrictEqual(det.flush(), []);
});

test('a truncated final line (tail mid-write) is ignored, not crashed on', () => {
  const cut = LINES.slice(0, lineNo(/<FatalCollision>/) - 1);
  cut.push(LINES[lineNo(/<FatalCollision>/) - 1].slice(0, 90));
  assert.deepStrictEqual(run(cut), []);
});

test('on-foot death on a current build: the corpse body line alone opens and confirms (cause unknown)', () => {
  const lines = LINES.filter((l) => !/<FatalCollision>|ClearDriver|<\[ActorState\] Dead>/.test(l));
  const reports = closed(run(lines));
  assert.strictEqual(reports.length, 1);
  const r = reports[0];
  assert.strictEqual(r.status, 'confirmed');
  assert.strictEqual(r.cause, 'unknown');
  assert.strictEqual(r.items.length, 45);
  assert.strictEqual(r.incapSource, 'preceding-notice', 'the downed notice came before any trigger and is labelled so');
  assert.ok(r.modifiers.includes('ttd_expired'));
  assert.match(r.summary, /cause not identifiable from log/);
});

test('a corpse-LOOT burst (starts with gear, not a body) is not a death', () => {
  const lines = LINES.filter((l) => !/<FatalCollision>|ClearDriver|<\[ActorState\] Dead>|body_01_noMagicPocket_\d+ - Class/.test(l));
  assert.deepStrictEqual(run(lines), []);
});

test('the same death keeps one id whether or not the trigger line was seen (live tail joined late)', () => {
  const full = closed(run(LINES))[0];
  const late = closed(run(LINES.slice(lineNo(/<FatalCollision>/)), { handle: HANDLE }))[0];
  assert.strictEqual(late.status, 'confirmed');
  assert.strictEqual(late.id, full.id);
  assert.strictEqual(late.player, HANDLE, 'falls back to the handle the relay supplies');
});

test('someone else being ejected from a wreck does not open an incident for me', () => {
  const other = LINES[lineNo(/<\[ActorState\] Dead>/) - 1]
    .replace("Actor 'TestPilot' [900000000001]", "Actor 'OtherPilot' [900000009999]");
  const lines = LINES.slice(0, lineNo(/<FatalCollision>/) - 1).concat([other]);
  assert.deepStrictEqual(run(lines), []);
});

test('SC <= 4.3.0 kill line naming the local player is trigger + confirmation', () => {
  const lines = [
    '<2025-09-01T09:59:00.000Z> [Notice] <Legacy login response> [CIG-net] User Login Success - Handle[TestPilot] - Time[1] [Team_GameServices][Login]',
    "<2025-09-01T10:00:00.000Z> [Notice] <Actor Death> CActor::Kill: 'SomeoneElse' [5] in zone 'Zone_1' killed by 'TestPilot' [1] using 'gun_1' [Class Rifle] with damage type 'Bullet' from direction x: 0.1, y: 0.2, z: 0.3 [Team_ActorTech][Actor]",
    "<2025-09-01T10:05:00.000Z> [Notice] <Actor Death> CActor::Kill: 'TestPilot' [1] in zone 'Zone_2' killed by 'OtherPilot' [2] using 'gun_2' [Class Sniper] with damage type 'Bullet' from direction x: 0.1, y: 0.2, z: 0.3 [Team_ActorTech][Actor]"
  ];
  const events = run(lines);
  assert.deepStrictEqual(events.map((e) => e.type), ['death.opened', 'death.confirmed', 'death.closed']);
  const r = closed(events)[0];
  assert.strictEqual(r.status, 'confirmed');
  assert.strictEqual(r.cause, 'killed_by_player');
  assert.strictEqual(r.killer, 'OtherPilot');
  assert.strictEqual(r.weaponClass, 'Sniper');
  assert.strictEqual(r.zone, 'Zone_2');
  assert.match(r.summary, /^Killed by OtherPilot with Sniper \(Bullet\) in Zone_2/);
});

test('a new game session resets identity and finalizes any open incident', () => {
  const upToTrigger = LINES.slice(0, lineNo(/<FatalCollision>/));
  const next = [
    '<2026-09-29T10:00:00.000Z> BackupNameAttachment=" Build(12660092) 28 Sep 26 (10 00 00)"  -- used by backup system',
    '<2026-09-29T10:00:00.000Z> Log started on Tue Sep 29 10:00:00 2026'
  ];
  const det = createDeathDetector();
  const events = [];
  upToTrigger.concat(next).forEach((l, i) => events.push(...det.feed(i + 1, l)));
  assert.deepStrictEqual(events.map((e) => e.type), ['death.opened', 'death.closed']);
  assert.strictEqual(det.identity().handle, null);
});

test('a confirmed death with no respawn sequence closes after 10 minutes of log time', () => {
  // Most real deaths never log the bind-layout respawn sequence.
  const noRespawn = LINES.slice(0, lineNo(/<Bind Change Layout Player>/) - 1);
  const soon = '<2026-09-28T00:58:00.000Z> [Notice] <Something> five minutes on';
  const later = '<2026-09-28T01:03:00.000Z> [Notice] <Something> ten minutes on';
  const det = createDeathDetector();
  const events = [];
  noRespawn.concat([soon]).forEach((l, i) => events.push(...det.feed(i + 1, l)));
  assert.deepStrictEqual(events.map((e) => e.type), ['death.opened', 'death.confirmed'], 'still waiting for a respawn');
  events.push(...det.feed(9999, later));
  assert.strictEqual(events[2].type, 'death.closed');
  assert.strictEqual(events[2].report.status, 'confirmed');
  assert.strictEqual(events[2].report.closedBy, 'timeout');
  assert.strictEqual(events[2].report.respawnedAt, null);
});

test('a downed notice during the respawn wait belongs to the next death, labelled as inferred', () => {
  const noRespawn = LINES.slice(0, lineNo(/<Bind Change Layout Player>/) - 1);
  const incap = LINES[lineNo(/Added notification "Incapacitated:/) - 1].replace('00:52:18.252Z', '00:58:00.000Z');
  const corpseLines = LINES.filter((l) => /PopulateItemPortForItemRecoveryEntitlement/.test(l))
    .map((l) => l.replace('00:52:47.810Z', '00:58:30.000Z').replace(/noMagicPocket_\d+/, 'noMagicPocket_900000009999'));
  const reports = closed(run(noRespawn.concat([incap], corpseLines)));
  assert.strictEqual(reports.length, 2);
  assert.strictEqual(reports[0].closedBy, 'superseded');
  assert.strictEqual(reports[0].incapacitatedAt, '2026-09-28T00:52:18.252Z', 'the first death keeps its own notice');
  assert.notStrictEqual(reports[1].id, reports[0].id, 'a different body id is a different death');
  assert.strictEqual(reports[1].cause, 'unknown');
  assert.strictEqual(reports[1].incapacitatedAt, '2026-09-28T00:58:00.000Z');
  assert.strictEqual(reports[1].incapSource, 'preceding-notice');
  assert.ok(reports[1].modifiers.includes('ttd_expired'));
});

test('ejected from a destroyed ship with no collision line is not called a collision', () => {
  const noCollision = LINES.filter((l) => !/<FatalCollision>/.test(l));
  const r = closed(run(noCollision))[0];
  assert.strictEqual(r.status, 'confirmed');
  assert.strictEqual(r.cause, 'vehicle_destroyed_unknown');
  assert.strictEqual(r.wasPilot, true, 'released this ship\'s controls right before the ejection');
  assert.strictEqual(r.impactSpeed, null);
  assert.strictEqual(r.collider, null);
  assert.match(r.summary, /^Ejected from destroyed Anvil Asgard on Pyro IV — what destroyed it is not in the log/);
  assert.doesNotMatch(r.summary, /hit|crash|passenger/i);

  // Without the control-release line there is no evidence of the seat either.
  const noSeat = noCollision.filter((l) => !/ClearDriver/.test(l));
  assert.strictEqual(closed(run(noSeat))[0].wasPilot, null);
});
