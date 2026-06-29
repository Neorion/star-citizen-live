'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const CargoRouter = require('../services/CargoRouter');

// Real-format lines (verified against the corpus, builds 4.7-4.8.0).
const MID = '1b393a11-629e-4098-8fee-bb3bbc2e5796';
const objTo = (have, need, commodity, dest, idx, mid = MID) =>
  `<2026-03-30T21:11:55.111Z> [Notice] <SHUDEvent_OnNotification> Added notification "New Objective: Deliver ${have}/${need} SCU of ${commodity} to ${dest}: " [8] to queue. New queue size: 2, MissionId: [${mid}], ObjectiveId: [dropoff_eacd0014-8c17-4950-b0bc-c483ef44a459_${idx}] [Team_CoreGameplayFeatures][Missions][Comms]`;
const acceptFrom = (pickup, mid = MID) =>
  `<2026-06-28T18:17:37.836Z> [Notice] <SHUDEvent_OnNotification> Added notification "Contract Accepted:  Junior | Stellar Small Haul | from ${pickup} <EM4>[50/100 Rep]</EM4>: " [15] to queue. New queue size: 1, MissionId: [${mid}], ObjectiveId: []`;
const handlerDropoff = (station, token, guid) =>
  `<2025-08-10T17:44:17.754Z> [Notice] <CreateHaulingObjectiveHandler> Dropoff created - [Cient] sourcename: X, missionId: 00000000-0000-0000-0000-000000000000, locationName: ${station} [${token}], locationHash: 1615454559, objectiveId: dropoff_${guid}_0_0`;

test('builds a pickup -> dropoff leg with bodies from both ends', () => {
  const r = new CargoRouter();
  r.ingest(acceptFrom('Fallow Field'));                                    // pickup hub (Pyro)
  r.ingest(objTo(0, 7, 'Iron', 'HUR-L2 Faithful Dream Station', 0));       // dropoff (Hurston)
  const out = r.route();
  assert.strictEqual(out.hubs.length, 1);
  assert.strictEqual(out.hubs[0].pickup, 'Fallow Field');
  assert.strictEqual(out.hubs[0].pickupBody, 'Pyro');
  assert.strictEqual(out.hubs[0].collectScu, 7);
  assert.strictEqual(out.hubs[0].legs[0].dropoff, 'HUR-L2 Faithful Dream Station');
  assert.strictEqual(out.hubs[0].legs[0].dropBody, 'Hurston');
  assert.strictEqual(out.summary.pickups, 1);
  assert.strictEqual(out.summary.dropoffs, 1);
});

test('a delivery with no named pickup falls under an "open pickup" hub', () => {
  const r = new CargoRouter();
  r.ingest(objTo(0, 5, 'Quartz', 'Checkmate at the L4 Lagrange of Pyro II', 0));   // no accept-from line
  const out = r.route();
  assert.match(out.hubs[0].pickup, /open pickup/i);
  assert.strictEqual(out.hubs[0].legs[0].dropBody, 'Pyro');
});

test('a bare "<System> System" dropoff is pending until the handler names the station', () => {
  const r = new CargoRouter();
  r.ingest(acceptFrom('Orison'));
  r.ingest(objTo(0, 4, 'Aluminum', 'Stanton System', 1));
  assert.strictEqual(r.route().hubs[0].pending.length, 1);                 // no station yet
  r.ingest(handlerDropoff('Wikelo Emporium Selo Station', 'TheCollectorsAsteriod_Stanton2', 'eacd0014-8c17-4950-b0bc-c483ef44a459'));
  const out = r.route();
  assert.strictEqual(out.hubs[0].legs.length, 1);
  assert.strictEqual(out.hubs[0].legs[0].dropoff, 'Wikelo Emporium Selo Station');
});

test('orders a hub\'s dropoffs by celestial-body circuit', () => {
  const r = new CargoRouter();
  r.ingest(acceptFrom('Fallow Field'));
  r.ingest(objTo(0, 5, 'Stims', 'ArcCorp Area18', 0));                     // ArcCorp (order 3)
  r.ingest(objTo(0, 7, 'Iron', 'HUR-L2 Faithful Dream Station', 1));       // Hurston (order 1)
  const legs = r.route().hubs[0].legs;
  assert.strictEqual(legs[0].dropBody, 'Hurston');                        // Hurston before ArcCorp
  assert.strictEqual(legs[1].dropBody, 'ArcCorp');
  assert.strictEqual(r.route().hubs[0].collectScu, 12);
});

test('a fully delivered objective drops out', () => {
  const r = new CargoRouter();
  r.ingest(acceptFrom('Fallow Field'));
  r.ingest(objTo(0, 7, 'Iron', 'HUR-L2 Faithful Dream Station', 0));
  r.ingest(objTo(7, 7, 'Iron', 'HUR-L2 Faithful Dream Station', 0));       // complete
  assert.strictEqual(r.route().hubs.length, 0);
});

test('ending a mission removes its parcels and pickup', () => {
  const r = new CargoRouter();
  r.ingest(acceptFrom('Fallow Field'));
  r.ingest(objTo(0, 7, 'Iron', 'HUR-L2 Faithful Dream Station', 0));
  r.observe('irrelevant', { kind: 'mission:end', missionId: MID });
  assert.strictEqual(r.route().hubs.length, 0);
  assert.strictEqual(r.pickups[MID], undefined);
});

test('carries a mission over a new session (crash/exit) until re-confirmed', () => {
  const r = new CargoRouter();
  r.ingest(acceptFrom('Fallow Field'));
  r.ingest(objTo(0, 7, 'Iron', 'HUR-L2 Faithful Dream Station', 0));
  assert.strictEqual(r.route().hubs[0].stale, false);
  r.observe('<...> Log started on Mon Jun 29 00:04:10 2026', { kind: 'session:start' });
  const out = r.route();
  assert.strictEqual(out.hubs[0].stale, true);
  assert.strictEqual(out.summary.carriedOver, 1);
  assert.ok(out.notes.some((n) => /carried over/.test(n)));
  assert.strictEqual(r.route({ freshOnly: true }).hubs.length, 0);
  r.ingest(objTo(0, 7, 'Iron', 'HUR-L2 Faithful Dream Station', 0));       // re-confirm this session
  assert.strictEqual(r.route().hubs[0].stale, false);
});

test('flags when a hub load exceeds the entered ship capacity', () => {
  const r = new CargoRouter();
  r.ingest(acceptFrom('CRU-L1 Ambitious Dream Station'));
  r.ingest(objTo(0, 40, 'Hydrogen', 'microTech Port Tressler', 0));
  const out = r.route({ shipScu: 32 });
  assert.ok(out.notes.some((n) => /exceeds/.test(n)));
  assert.strictEqual(out.hubs[0].pickupBody, 'Crusader');                 // CRU- prefix
  assert.strictEqual(out.hubs[0].legs[0].dropBody, 'microTech');
});
