'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { SIGNATURES, matchSignal, splitTimestamp } = require('../../functions/deathSignatures');

// Real Game.log slice, build 12660092 (2026-09-27), scrubbed of identifiers by
// scripts/scrub-log-fixture.js. One pilot fatal-collision death.
const FIXTURE = path.join(__dirname, '..', 'relay', 'fixtures', 'death-fatal-collision-pilot.log');
const LINES = fs.readFileSync(FIXTURE, 'utf8').split(/\r?\n/);
const HANDLE = 'TestPilot';
const GEID = '900000000001';
const VEHICLE = 'ANVL_Asgard_900000000002';

function hits () {
  const by = Object.create(null);
  LINES.forEach((line, i) => {
    const sig = matchSignal(line);
    if (!sig) return;
    (by[sig.signal] || (by[sig.signal] = [])).push(Object.assign({ line: i + 1, raw: line }, sig));
  });
  return by;
}

const HITS = hits();
const count = (signal) => (HITS[signal] || []).length;
const one = (signal) => {
  assert.strictEqual(count(signal), 1, `${signal}: expected exactly 1 match in the fixture`);
  return HITS[signal][0];
};

test('every VERIFIED signature matches the real fixture the expected number of times', () => {
  const expected = {
    session_build: 1, session_start: 1, login_character: 1, login_handle: 1,
    fatal_collision: 1, clear_driver: 1, actor_dead: 1, incapacitated: 2,
    corpse_item: 45, corpse_marker: 1,
    bind_layout: 1, bind_end: 1, spawned: 1, inventory_location: 2,
    route: 1, quantum_target: 1, no_route: 3, inventory_closed: 3, cvar_displayinfo: 1
  };
  for (const [signal, n] of Object.entries(expected)) {
    assert.strictEqual(count(signal), n, `${signal} count`);
  }
  // Every table entry is exercised by the fixture (nothing marked verified on faith).
  for (const sig of SIGNATURES) {
    assert.ok(sig.verified, `${sig.signal} is flagged verified`);
    assert.ok(count(sig.signal) > 0, `${sig.signal} has a real fixture line`);
  }
});

test('the 12660092 fixture death logs no <Actor Death> / <Vehicle Destruction> line', () => {
  assert.strictEqual(count('actor_death'), 0);
  assert.strictEqual(count('vehicle_destruction'), 0);
});

test('identity comes from the log, not a constant', () => {
  const login = one('login_character').fields;
  assert.strictEqual(login.name, HANDLE);
  assert.strictEqual(login.geid, GEID);
  assert.strictEqual(login.state, 'STATE_CURRENT');
  assert.strictEqual(login.accountId, undefined, 'account id is never extracted');
  assert.strictEqual(one('login_handle').fields.handle, HANDLE);
  assert.strictEqual(one('session_build').fields.build, '12660092');
});

test('fatal_collision extracts vehicle, part, position, collider, speed and frame time', () => {
  const fc = one('fatal_collision');
  assert.strictEqual(fc.ts, '2026-09-28T00:52:17.679Z');
  assert.strictEqual(fc.fields.vehicle, VEHICLE);
  assert.strictEqual(fc.fields.part, 'Tail');
  assert.strictEqual(fc.fields.zone, 'pyro4');
  assert.strictEqual(fc.fields.playerPilot, true);
  assert.strictEqual(fc.fields.colliderId, -1);
  assert.strictEqual(fc.fields.colliderEntity, 'UNKNOWN');
  assert.ok(Math.abs(fc.fields.speed - 17.84) < 0.01, `speed ${fc.fields.speed}`);
  assert.ok(Math.abs(fc.fields.frameMs - 25.159901) < 1e-6);
  assert.ok(Math.abs(fc.fields.pos.x - -245156.613818) < 1e-6);
  assert.ok(Math.abs(fc.fields.distance - 24.111731) < 1e-6);
});

test('actor_dead, clear_driver and corpse_marker name the local player and vehicle', () => {
  const dead = one('actor_dead').fields;
  assert.strictEqual(dead.actor, HANDLE);
  assert.strictEqual(dead.geid, GEID);
  assert.strictEqual(dead.fromZone, VEHICLE);
  assert.strictEqual(dead.toZone, 'pyro4');
  assert.match(dead.reason, /destroyed vehicle/);
  const cd = one('clear_driver').fields;
  assert.strictEqual(cd.geid, GEID);
  assert.strictEqual(cd.vehicle, VEHICLE);
  assert.strictEqual(one('corpse_marker').fields.actor, HANDLE);
});

test('corpse_item: 45 rows, 7 character-bound (KeptId), first row is the body', () => {
  const rows = HITS.corpse_item;
  assert.strictEqual(rows.filter((r) => r.fields.kept).length, 7);
  assert.strictEqual(rows[0].fields.isBody, true);
  assert.strictEqual(rows[0].fields.itemClass, 'body_01_noMagicPocket');
  assert.match(rows[0].fields.bodyId, /^\d+$/);
  assert.strictEqual(rows.filter((r) => r.fields.isBody).length, 1);
  assert.strictEqual(rows[1].fields.port, 'Armor_Undersuit');
  assert.strictEqual(rows[1].fields.kept, false);
  assert.match(rows[1].fields.classGuid, /^[0-9a-f-]{36}$/);
});

test('respawn + context signatures carry the fields the detector needs', () => {
  assert.strictEqual(one('bind_layout').fields.geid, GEID);
  assert.strictEqual(one('bind_end').fields.geid, GEID);
  assert.strictEqual(one('spawned').ts, '2026-09-28T00:53:05.794Z');
  const landing = HITS.inventory_location[0].fields;
  assert.strictEqual(landing.player, HANDLE);
  assert.strictEqual(landing.landingFrom, '0');
  assert.notStrictEqual(landing.landingTo, '0');
  assert.strictEqual(one('route').fields.start, 'Gaslight');
  assert.strictEqual(one('cvar_displayinfo').fields.value, 1);
});

test('each signature rejects a near-miss of its own real line', () => {
  // Break the distinctive token of a real matching line; it must stop matching that signal.
  const breakers = {
    session_build: (l) => l.replace('Build(', 'Bild('),
    session_start: (l) => l.replace('Log started on', 'Log stopped on'),
    login_character: (l) => l.replace(' geid ', ' gid '),
    login_handle: (l) => l.replace('Handle[', 'Handel['),
    fatal_collision: (l) => l.replace('PlayerPilot: 1', 'PlayerPilot: maybe'),
    clear_driver: (l) => l.replace('releasing control token', 'acquiring control token'),
    actor_dead: (l) => l.replace('ejected from zone', 'moved from zone'),
    incapacitated: (l) => l.replace('"Incapacitated:', '"Recovered:'),
    corpse_item: (l) => l.replace("Port Name '", "Port '"),
    corpse_marker: (l) => l.replace('CorpseMarker_', 'QuestMarker_'),
    bind_layout: (l) => l.replace('className="Player"', 'className="Vehicle"'),
    bind_end: (l) => l.replace('playerGEID=', 'playerName='),
    spawned: (l) => l.replace('Spawned!', 'Spawning'),
    inventory_location: (l) => l.replace('is changing location', 'kept location'),
    route: (l) => l.replace('Projected Start Location is', 'Start is'),
    quantum_target: (l) => l.replace('OnPlayerSelectedQuantumTarget', 'OnPlayerClearedQuantumTarget'),
    no_route: (l) => l.replace('No Route loaded!', 'Route loaded'),
    inventory_closed: (l) => l.replace('closing inventory', 'opening inventory'),
    cvar_displayinfo: (l) => l.replace('r_DisplayInfo = ', 'r_DisplayInfo: ')
  };
  for (const sig of SIGNATURES) {
    const real = HITS[sig.signal][0].raw;
    const broken = breakers[sig.signal](real);
    assert.notStrictEqual(broken, real, `${sig.signal}: breaker changed the line`);
    const res = matchSignal(broken);
    assert.ok(!res || res.signal !== sig.signal, `${sig.signal} must not match its near-miss`);
  }
});

test('historical kill / vehicle-destruction lines route through the parser rules', () => {
  const kill = matchSignal("<2025-09-01T10:00:00.000Z> [Notice] <Actor Death> CActor::Kill: 'Victim' [111] in zone 'Zone_1' killed by 'Killer' [222] using 'gun_1' [Class Rifle] with damage type 'Bullet' from direction x: 0.1, y: 0.2, z: 0.3 [Team_ActorTech][Actor]");
  assert.strictEqual(kill.signal, 'actor_death');
  assert.strictEqual(kill.fields.victim, 'Victim');
  assert.strictEqual(kill.fields.killer, 'Killer');
  assert.strictEqual(kill.fields.damageType, 'Bullet');
  const vd = matchSignal("<2025-09-01T10:00:01.000Z> [Notice] <Vehicle Destruction> CVehicle::OnAdvanceDestroyLevel: Vehicle 'DRAK_Corsair_123456789' [123456789] in zone 'Zone_1' [pos x: 1.0, y: 2.0, z: 3.0 vel x: 0.0, y: 0.0, z: 0.0] driven by 'Victim' [111] advanced from destroy level 1 to 2 caused by 'Killer' [222] with 'Combat' [Team_CGP4][Vehicle]");
  assert.strictEqual(vd.signal, 'vehicle_destruction');
  assert.strictEqual(vd.fields.toLevel, 2);
  assert.strictEqual(vd.fields.driver, 'Victim');
});

test('unrelated and truncated lines are ignored, not thrown on', () => {
  assert.strictEqual(matchSignal(''), null);
  assert.strictEqual(matchSignal('<2026-09-28T00:52:17.679Z> [Notice] <Something Else> nothing to see'), null);
  const fatal = HITS.fatal_collision[0].raw;
  assert.strictEqual(matchSignal(fatal.slice(0, 120)), null, 'a line cut mid-write does not match');
  assert.deepStrictEqual(splitTimestamp('no timestamp here'), { ts: null, rest: 'no timestamp here' });
});
