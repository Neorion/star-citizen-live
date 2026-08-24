'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  routeMissions, bodyFromStation, bodyFromToken, isGenericSystem, STANTON, BODY_ORDER
} = require('../../functions/cargoRoute');

// Synthetic mission objects (the shape functions/cargoRoute.js's routeMissions()
// consumes — Object.values(cargoRouter.missions) at runtime). Ported from
// Neorion/star-citizen-live test/cargo.test.js, adapted from raw-line ingest()
// calls to this pure function's plain-object input; manual-board-only assertions
// (addManual/setStatus/setPin/setNotes/importContract, etc.) are out of scope
// and not ported — see BUILD-PLAN-rsi.md WS4/T4.2.

const mission = (overrides = {}) => Object.assign({
  missionId: 'm0',
  title: null,
  pickup: null,
  titleDropoff: null,
  reward: null,
  status: null,
  lastSession: 0,
  parcels: {}
}, overrides);

// --- bodyFromStation / bodyFromToken / isGenericSystem -----------------------

test('bodyFromStation resolves known hub prefixes/landmarks via the regex fallback', () => {
  assert.strictEqual(bodyFromStation('HUR-L2 Faithful Dream Station'), 'Hurston');
  assert.strictEqual(bodyFromStation('Area18'), 'ArcCorp');
  assert.strictEqual(bodyFromStation('Orison'), 'Crusader');
  assert.strictEqual(bodyFromStation('New Babbage'), 'microTech');
  assert.strictEqual(bodyFromStation('Wikelo Emporium Selo Station'), 'Asteroid bases');
  assert.strictEqual(bodyFromStation('Checkmate at the L4 Lagrange of Pyro II'), 'Pyro');
  assert.strictEqual(bodyFromStation('Fallow Field'), 'Pyro');
});

test('bodyFromStation returns null for a name it cannot place (honest "Unknown", not a guess)', () => {
  assert.strictEqual(bodyFromStation('Some Unlisted Outpost'), null);
});

test('bodyFromToken parses a "<System>_<n>" location token', () => {
  assert.deepStrictEqual(bodyFromToken('TheCollectorsAsteriod_Stanton2'), { sys: 'Stanton', num: 2, name: 'Crusader' });
  assert.deepStrictEqual(bodyFromToken('Stanton1'), { sys: 'Stanton', num: 1, name: 'Hurston' });
  assert.deepStrictEqual(bodyFromToken('Pyro_1'), { sys: 'Pyro', num: 1, name: 'Pyro 1' });
  assert.deepStrictEqual(bodyFromToken('nonsense'), { sys: null, num: null, name: null });
});

test('isGenericSystem recognizes the "<System> System" placeholder text and only that', () => {
  assert.strictEqual(isGenericSystem('Stanton System'), true);
  assert.strictEqual(isGenericSystem('Pyro System'), true);
  assert.strictEqual(isGenericSystem('HUR-L2 Faithful Dream Station'), false);
});

test('STANTON and BODY_ORDER are exported as plain lookup objects', () => {
  assert.strictEqual(STANTON[1], 'Hurston');
  assert.strictEqual(STANTON[3], 'ArcCorp');
  assert.strictEqual(BODY_ORDER.Hurston, 1);
  assert.strictEqual(BODY_ORDER.Pyro, 6);
});

// --- routeMissions -------------------------------------------------------

test('builds a pickup -> dropoff leg with bodies resolved at both ends', () => {
  const mi = mission({
    missionId: 'm1',
    title: 'Junior | Stellar Small Haul | from Fallow Field',
    pickup: 'Fallow Field',
    reward: '50/100 Rep',
    parcels: {
      dk0: {
        dropKey: 'dk0', guid: 'g1', commodity: 'Iron', scuHave: 0, scuNeed: 7,
        destSystem: 'HUR-L2 Faithful Dream Station', station: 'HUR-L2 Faithful Dream Station',
        body: { name: bodyFromStation('HUR-L2 Faithful Dream Station') }
      }
    }
  });
  const out = routeMissions([mi], 0, {});
  assert.strictEqual(out.hubs.length, 1);
  assert.strictEqual(out.hubs[0].pickup, 'Fallow Field');
  assert.strictEqual(out.hubs[0].pickupBody, 'Pyro');
  assert.strictEqual(out.hubs[0].collectScu, 7);
  assert.strictEqual(out.hubs[0].legs[0].dropoff, 'HUR-L2 Faithful Dream Station');
  assert.strictEqual(out.hubs[0].legs[0].dropBody, 'Hurston');
  assert.strictEqual(out.summary.pickups, 1);
  assert.strictEqual(out.summary.dropoffs, 1);
  assert.strictEqual(out.summary.totalScu, 7);
});

test('a delivery whose pickup is not in the log is grouped honestly, not "source your own"', () => {
  const mi = mission({
    missionId: 'm2',
    parcels: {
      dk0: {
        dropKey: 'dk0', guid: 'g2', commodity: 'Quartz', scuHave: 0, scuNeed: 5,
        destSystem: 'Checkmate at the L4 Lagrange of Pyro II', station: 'Checkmate at the L4 Lagrange of Pyro II',
        body: { name: bodyFromStation('Checkmate at the L4 Lagrange of Pyro II') }
      }
    }
  });
  const out = routeMissions([mi], 0, {});
  assert.strictEqual(out.hubs[0].pickupKnown, false);
  assert.strictEqual(out.hubs[0].pickup, 'Pickup not in log');
  assert.doesNotMatch(out.hubs[0].pickup, /source your own/i);
  assert.strictEqual(out.hubs[0].legs[0].dropBody, 'Pyro');
});

test('a bare "<System> System" dropoff is pending until a station is known, then resolves once it is', () => {
  const mi = mission({
    missionId: 'm3',
    pickup: 'Orison',
    parcels: {
      dk1: {
        dropKey: 'dk1', guid: 'g3', commodity: 'Aluminum', scuHave: 0, scuNeed: 4,
        destSystem: 'Stanton System', station: null, body: null
      }
    }
  });

  let out = routeMissions([mi], 0, {});
  assert.strictEqual(out.hubs[0].legs[0].pending, true);
  assert.strictEqual(out.hubs[0].legs[0].dropoff, null);

  // Simulate the router backfilling the parcel once mission:dropoff names the station.
  mi.parcels.dk1.station = 'Wikelo Emporium Selo Station';
  mi.parcels.dk1.body = bodyFromToken('TheCollectorsAsteriod_Stanton2');

  out = routeMissions([mi], 0, {});
  assert.strictEqual(out.hubs[0].legs.length, 1);
  assert.strictEqual(out.hubs[0].legs[0].dropoff, 'Wikelo Emporium Selo Station');
  assert.strictEqual(out.hubs[0].legs[0].pending, false);
});

test('multiple dropoffs from one hub are ordered by celestial body cluster, then name', () => {
  const mi = mission({
    missionId: 'm4',
    pickup: 'Orison',
    parcels: {
      a: { dropKey: 'a', guid: 'ga', commodity: 'X', scuHave: 0, scuNeed: 1, destSystem: 'New Babbage', station: 'New Babbage', body: { name: 'microTech' } },
      b: { dropKey: 'b', guid: 'gb', commodity: 'X', scuHave: 0, scuNeed: 1, destSystem: 'Area18', station: 'Area18', body: { name: 'ArcCorp' } },
      c: { dropKey: 'c', guid: 'gc', commodity: 'X', scuHave: 0, scuNeed: 1, destSystem: 'HUR-L2 Faithful Dream Station', station: 'HUR-L2 Faithful Dream Station', body: { name: 'Hurston' } }
    }
  });
  const out = routeMissions([mi], 0, {});
  assert.deepStrictEqual(out.hubs[0].legs.map((l) => l.dropBody), ['Hurston', 'ArcCorp', 'microTech']);
});

test('a fully-delivered mission with no undelivered parcels shows as an "awaiting" leg, not a pending dropoff', () => {
  const mi = mission({ missionId: 'm5', pickup: 'Area18', title: 'Junior | Haul | from Area18' });
  const out = routeMissions([mi], 0, {});
  assert.strictEqual(out.summary.awaiting, 1);
  assert.strictEqual(out.hubs[0].legs[0].awaiting, true);
  assert.match(out.notes.join(' '), /accepted but no cargo line yet/);
});

test('opts.hideAwaiting drops awaiting-only missions from hubs but still counts them as hidden', () => {
  const mi = mission({ missionId: 'm6', pickup: 'Area18' });
  const out = routeMissions([mi], 0, { hideAwaiting: true });
  assert.strictEqual(out.hubs.length, 0);
  assert.match(out.notes.join(' '), /1 accepted-but-not-loaded haul\(s\) hidden/);
});

test('staleness: a mission not re-confirmed this session is flagged stale and counted as carried over', () => {
  const mi = mission({
    missionId: 'm7',
    pickup: 'Area18',
    lastSession: 0,
    parcels: { a: { dropKey: 'a', guid: 'ga', commodity: 'X', scuHave: 0, scuNeed: 1, destSystem: 'HUR-L2 Faithful Dream Station', station: 'HUR-L2 Faithful Dream Station', body: { name: 'Hurston' } } }
  });
  const out = routeMissions([mi], 1, {});   // router session has advanced to 1
  assert.strictEqual(out.hubs[0].stale, true);
  assert.strictEqual(out.summary.carriedOver, 1);
  assert.match(out.notes.join(' '), /carried over from a previous session/);
});

test('opts.freshOnly hides stale (carried-over) missions entirely', () => {
  const mi = mission({ missionId: 'm8', pickup: 'Area18', lastSession: 0 });
  const out = routeMissions([mi], 1, { freshOnly: true });
  assert.strictEqual(out.hubs.length, 0);
});

test('opts.shipScu flags a hub whose collect total exceeds the given hold size', () => {
  const mi = mission({
    missionId: 'm9',
    pickup: 'Area18',
    parcels: { a: { dropKey: 'a', guid: 'ga', commodity: 'X', scuHave: 0, scuNeed: 40, destSystem: 'HUR-L2 Faithful Dream Station', station: 'HUR-L2 Faithful Dream Station', body: { name: 'Hurston' } } }
  });
  const out = routeMissions([mi], 0, { shipScu: 32 });
  assert.match(out.notes.join(' '), /Pickup at Area18 is 40 SCU — exceeds your 32 SCU hold/);
});

test('a mission whose pickup was never logged rolls up into the "pickup not logged" note', () => {
  const mi = mission({
    missionId: 'm10',
    parcels: { a: { dropKey: 'a', guid: 'ga', commodity: 'X', scuHave: 0, scuNeed: 1, destSystem: 'HUR-L2 Faithful Dream Station', station: 'HUR-L2 Faithful Dream Station', body: { name: 'Hurston' } } }
  });
  const out = routeMissions([mi], 0, {});
  assert.match(out.notes.join(' '), /don't record their pickup in the log/);
});

test('TERMINAL missions (completed/abandoned/failed/cleared) are grouped into done[], not hubs', () => {
  const completed = mission({ missionId: 'd1', title: 'Junior | Stellar Small Haul | from Area18', status: 'completed', pickup: 'Area18' });
  const abandoned = mission({ missionId: 'd2', title: 'Junior | Stellar Small Haul | to Ruin Station', status: 'abandoned', titleDropoff: 'Ruin Station' });
  const out = routeMissions([completed, abandoned], 0, {});
  assert.strictEqual(out.hubs.length, 0);
  assert.strictEqual(out.done.length, 2);
  const byId = Object.fromEntries(out.done.map((d) => [d.missionId, d]));
  assert.strictEqual(byId.d1.status, 'completed');
  assert.strictEqual(byId.d1.contractType, 'Stellar Small Haul');
  assert.strictEqual(byId.d2.status, 'abandoned');
  assert.strictEqual(byId.d2.dropoff, 'Ruin Station');
});

test('a mission with no title falls back to "Hauling contract" as its contract type', () => {
  const mi = mission({
    missionId: 'm11',
    pickup: 'Area18',
    parcels: { a: { dropKey: 'a', guid: 'ga', commodity: 'X', scuHave: 0, scuNeed: 1, destSystem: 'HUR-L2 Faithful Dream Station', station: 'HUR-L2 Faithful Dream Station', body: { name: 'Hurston' } } }
  });
  const out = routeMissions([mi], 0, {});
  assert.strictEqual(out.hubs[0].legs[0].contractType, 'Hauling contract');
});

test('with no missions and none done, the board says so honestly', () => {
  const out = routeMissions([], 0, {});
  assert.strictEqual(out.hubs.length, 0);
  assert.strictEqual(out.done.length, 0);
  assert.deepStrictEqual(out.notes, ['No cargo missions yet. Accept a hauling contract in-game.']);
});
