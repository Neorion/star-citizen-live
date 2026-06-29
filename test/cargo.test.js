'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const CargoRouter = require('../services/CargoRouter');

// Real-format lines (verified against the corpus, builds 4.7-4.8.0).
const MID = '1b393a11-629e-4098-8fee-bb3bbc2e5796';
const objTo = (have, need, commodity, dest, idx) =>
  `<2026-03-30T21:11:55.111Z> [Notice] <SHUDEvent_OnNotification> Added notification "New Objective: Deliver ${have}/${need} SCU of ${commodity} to ${dest}: " [8] to queue. New queue size: 2, MissionId: [${MID}], ObjectiveId: [dropoff_eacd0014-8c17-4950-b0bc-c483ef44a459_${idx}] [Team_CoreGameplayFeatures][Missions][Comms]`;
const handlerDropoff = (station, token, guid) =>
  `<2025-08-10T17:44:17.754Z> [Notice] <CreateHaulingObjectiveHandler> Dropoff created - [Cient] sourcename: X, missionId: 00000000-0000-0000-0000-000000000000, locationName: ${station} [${token}], locationHash: 1615454559, objectiveId: dropoff_${guid}_0_0`;

test('routes a delivery whose objective names a specific station (body from station prefix)', () => {
  const r = new CargoRouter();
  r.ingest(objTo(0, 7, 'Iron', 'HUR-L2 Faithful Dream Station', 0));
  const out = r.route();
  assert.strictEqual(out.stops.length, 1);
  assert.strictEqual(out.stops[0].station, 'HUR-L2 Faithful Dream Station');
  assert.strictEqual(out.stops[0].body, 'Hurston');          // HUR- prefix -> Hurston
  assert.strictEqual(out.stops[0].totalScu, 7);
  assert.strictEqual(out.stops[0].parcels[0].commodity, 'Iron');
  assert.strictEqual(out.summary.missions, 1);
});

test('a bare "<System> System" destination is unrouted until the handler names the station', () => {
  const r = new CargoRouter();
  r.ingest(objTo(0, 4, 'Aluminum', 'Stanton System', 1));
  let out = r.route();
  assert.strictEqual(out.stops.length, 0);
  assert.strictEqual(out.unrouted.length, 1);
  // Now the hauling handler names the station for that same dropoff GUID.
  r.ingest(handlerDropoff('Wikelo Emporium Selo Station', 'TheCollectorsAsteriod_Stanton2', 'eacd0014-8c17-4950-b0bc-c483ef44a459'));
  out = r.route();
  assert.strictEqual(out.stops.length, 1);
  assert.strictEqual(out.stops[0].station, 'Wikelo Emporium Selo Station');
});

test('groups multiple commodities to the same station and orders bodies into a circuit', () => {
  const r = new CargoRouter();
  r.ingest(objTo(0, 7, 'Iron', 'HUR-L2 Faithful Dream Station', 0));
  r.ingest(objTo(0, 6, 'Quartz', 'HUR-L2 Faithful Dream Station', 1));
  r.ingest(objTo(0, 5, 'Stims', 'ArcCorp Area18', 2));
  const out = r.route();
  assert.strictEqual(out.stops.length, 2);
  assert.strictEqual(out.stops[0].body, 'Hurston');          // Hurston (order 1) before ArcCorp (order 3)
  assert.strictEqual(out.stops[0].totalScu, 13);             // Iron + Quartz stacked at one stop
  assert.strictEqual(out.stops[1].body, 'ArcCorp');
});

test('a fully delivered objective (have == need) drops out of the route', () => {
  const r = new CargoRouter();
  r.ingest(objTo(0, 7, 'Iron', 'HUR-L2 Faithful Dream Station', 0));
  r.ingest(objTo(7, 7, 'Iron', 'HUR-L2 Faithful Dream Station', 0));   // progress -> complete
  assert.strictEqual(r.route().stops.length, 0);
});

test('ending a mission removes its parcels', () => {
  const r = new CargoRouter();
  r.ingest(objTo(0, 7, 'Iron', 'HUR-L2 Faithful Dream Station', 0));
  r.observe('irrelevant', { kind: 'mission:end', missionId: MID });
  assert.strictEqual(r.route().stops.length, 0);
});

test('carries a mission over a new session (crash/exit) and flags it until re-confirmed', () => {
  const r = new CargoRouter();
  r.ingest(objTo(0, 7, 'Iron', 'HUR-L2 Faithful Dream Station', 0));
  assert.strictEqual(r.route().stops[0].stale, false);              // confirmed this session
  // A relaunch (new "Log started on") — but no <EndMission> fired (crash/exit).
  r.observe('<...> Log started on Mon Jun 29 00:04:10 2026', { kind: 'session:start' });
  let out = r.route();
  assert.strictEqual(out.stops[0].stale, true);                     // now carried over
  assert.strictEqual(out.summary.carriedOver, 1);
  assert.ok(out.notes.some((n) => /carried over/.test(n)));
  assert.strictEqual(r.route({ freshOnly: true }).stops.length, 0); // hidden when fresh-only
  // The objective re-appears this session -> re-confirmed, no longer stale.
  r.ingest(objTo(0, 7, 'Iron', 'HUR-L2 Faithful Dream Station', 0));
  assert.strictEqual(r.route().stops[0].stale, false);
});

test('flags when total cargo exceeds the entered ship capacity', () => {
  const r = new CargoRouter();
  r.ingest(objTo(0, 40, 'Hydrogen', 'CRU-L1 Ambitious Dream Station', 0));
  const out = r.route({ shipScu: 32 });
  assert.ok(out.notes.some((n) => /exceeds/.test(n)));
  assert.strictEqual(out.stops[0].body, 'Crusader');         // CRU- prefix -> Crusader
});
