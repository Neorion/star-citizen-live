'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const CargoRouter = require('../../services/CargoRouter');
const { parseLine } = require('../../functions/parser');

// --- Real-corpus-verified lines (byte-identical to the samples in
// tests/relay/parser.test.js, itself VERIFIED against real 4.7-4.8.0 Game.log
// corpus — see that file and BUILD-PLAN-rsi.md WS4/T4.0/T4.2). ---

const MID = '1b393a11-629e-4098-8fee-bb3bbc2e5796';
const GUID = 'eacd0014-8c17-4950-b0bc-c483ef44a459';

const ACCEPT_LINE =
  '<2026-06-28T18:17:37.836Z> [Notice] <SHUDEvent_OnNotification> Added notification "Contract Accepted:  Junior | Stellar Small Haul | from Fallow Field <EM4>[50/100 Rep]</EM4>: " [15] to queue. New queue size: 1, MissionId: [' +
  MID + '], ObjectiveId: []';

const BOUNTY_ACCEPT_LINE =
  '<t> [Notice] <SHUDEvent_OnNotification> Added notification "Contract Accepted:  Bounty Assignment: Domenico Pfaffner (HRT) <EM4>[50 Rep]</EM4>: " [5] to queue. New queue size:1, MissionId: [99999999-9999-9999-9999-999999999999], ObjectiveId: []';

const DELIVER_LINE_KNOWN_STATION =
  '<2026-03-30T21:11:55.111Z> [Notice] <SHUDEvent_OnNotification> Added notification "New Objective: Deliver 0/7 SCU of Iron to HUR-L2 Faithful Dream Station: " [8] to queue. New queue size: 2, MissionId: [' +
  MID + '], ObjectiveId: [dropoff_' + GUID + '_0] [Team_CoreGameplayFeatures][Missions][Comms]';

const DROPOFF_LINE =
  '<2025-08-10T17:44:17.754Z> [Notice] <CreateHaulingObjectiveHandler> Dropoff created - [Cient] sourcename: X, missionId: 00000000-0000-0000-0000-000000000000, locationName: Wikelo Emporium Selo Station [TheCollectorsAsteriod_Stanton2], locationHash: 1615454559, objectiveId: dropoff_' +
  GUID + '_0_0';

// Same VERIFIED cargo:deliver regex shape as DELIVER_LINE_KNOWN_STATION, but
// parameterized with a generic "<System> System" destination + a fresh dropKey
// index — needed to exercise the pending -> backfilled-by-handler path, which
// none of the given literal corpus samples (all non-generic destinations)
// happen to cover.
const deliverGeneric = (idx) =>
  '<2026-03-30T21:12:00.000Z> [Notice] <SHUDEvent_OnNotification> Added notification "New Objective: Deliver 0/4 SCU of Aluminum to Stanton System: " [9] to queue. New queue size: 2, MissionId: [' +
  MID + '], ObjectiveId: [dropoff_' + GUID + '_' + idx + '] [Team_CoreGameplayFeatures][Missions][Comms]';

const endLine = (missionId, completionType) =>
  `<2026-06-28T18:20:00.000Z> [Notice] <EndMission> MissionId[${missionId}] Player[Foo] PlayerId[123] CompletionType[${completionType}] Reason[Mission Ended]`;

const SESSION_START_LINE = '<2026-06-29T09:00:00.000Z> Log started on Mon Jun 29 09:00:00 2026';

test('accept -> deliver (known station) builds an active hub with the right pickup/dropoff', () => {
  const r = new CargoRouter();
  r.observe(parseLine(ACCEPT_LINE));
  r.observe(parseLine(DELIVER_LINE_KNOWN_STATION));
  const out = r.route();
  assert.strictEqual(out.hubs.length, 1);
  assert.strictEqual(out.hubs[0].pickup, 'Fallow Field');
  assert.strictEqual(out.hubs[0].legs[0].dropoff, 'HUR-L2 Faithful Dream Station');
  assert.strictEqual(out.hubs[0].legs[0].dropBody, 'Hurston');
});

test('a late mission:dropoff handler for an already-known-station GUID does not override it', () => {
  const r = new CargoRouter();
  r.observe(parseLine(ACCEPT_LINE));
  r.observe(parseLine(DELIVER_LINE_KNOWN_STATION));
  r.observe(parseLine(DROPOFF_LINE));   // same GUID, different station name
  const out = r.route();
  assert.strictEqual(out.hubs[0].legs[0].dropoff, 'HUR-L2 Faithful Dream Station');
});

test('mission:dropoff arrives BEFORE the delivery objective: deliver resolves the known station immediately', () => {
  const r = new CargoRouter();
  r.observe(parseLine(ACCEPT_LINE));
  r.observe(parseLine(DROPOFF_LINE));
  r.observe(parseLine(deliverGeneric(0)));
  const out = r.route();
  assert.strictEqual(out.hubs[0].legs[0].dropoff, 'Wikelo Emporium Selo Station');
  assert.strictEqual(out.hubs[0].legs[0].pending, false);
});

test('mission:dropoff arrives AFTER the delivery objective: the parcel is backfilled once the station is known', () => {
  const r = new CargoRouter();
  r.observe(parseLine(ACCEPT_LINE));
  r.observe(parseLine(deliverGeneric(1)));
  let out = r.route();
  assert.strictEqual(out.hubs[0].legs[0].pending, true);
  assert.strictEqual(out.hubs[0].legs[0].dropoff, null);

  r.observe(parseLine(DROPOFF_LINE));
  out = r.route();
  assert.strictEqual(out.hubs[0].legs[0].dropoff, 'Wikelo Emporium Selo Station');
  assert.strictEqual(out.hubs[0].legs[0].pending, false);
});

test('a non-hauling "Contract Accepted" (e.g. a bounty) is ignored unless the mission is already known', () => {
  const r = new CargoRouter();
  r.observe(parseLine(BOUNTY_ACCEPT_LINE));
  assert.strictEqual(Object.keys(r.missions).length, 0);

  // If a haul-shaped mission with this SAME id is already tracked (its
  // delivery objective arrived first), a later non-haul-titled accept for
  // that id still updates it — the "already known" half of the gate.
  const knownId = '99999999-9999-9999-9999-999999999999';
  const knownDeliver =
    `<2026-03-30T21:11:55.111Z> [Notice] <SHUDEvent_OnNotification> Added notification "New Objective: Deliver 0/2 SCU of Gold to Area18: " [8] to queue. New queue size: 2, MissionId: [${knownId}], ObjectiveId: [dropoff_${GUID}_9] [Team_CoreGameplayFeatures][Missions][Comms]`;
  r.observe(parseLine(knownDeliver));
  r.observe(parseLine(BOUNTY_ACCEPT_LINE));
  assert.ok(r.missions[knownId]);
  assert.match(r.missions[knownId].title, /Bounty Assignment/);
});

test('mission:end sets a terminal status from the log (Complete -> completed)', () => {
  const r = new CargoRouter();
  r.observe(parseLine(ACCEPT_LINE));
  r.observe(parseLine(DELIVER_LINE_KNOWN_STATION));
  r.observe(parseLine(endLine(MID, 'Complete')));
  const out = r.route();
  assert.strictEqual(out.hubs.length, 0);
  assert.strictEqual(out.done.length, 1);
  assert.strictEqual(out.done[0].status, 'completed');
  assert.strictEqual(out.done[0].missionId, MID);
});

test('mission:end maps Abandon/Fail/Deactivate to abandoned/failed/abandoned', () => {
  const cases = [['Abandon', 'abandoned'], ['Fail', 'failed'], ['Deactivate', 'abandoned']];
  for (const [completionType, expected] of cases) {
    const r = new CargoRouter();
    r.observe(parseLine(ACCEPT_LINE));
    r.observe(parseLine(endLine(MID, completionType)));
    const out = r.route();
    assert.strictEqual(out.done[0].status, expected, `${completionType} -> ${expected}`);
  }
});

test('session:start increments the session; a mission not re-observed becomes stale/carried-over, and freshOnly hides it', () => {
  const r = new CargoRouter();
  r.observe(parseLine(ACCEPT_LINE));
  r.observe(parseLine(DELIVER_LINE_KNOWN_STATION));
  assert.strictEqual(r.session, 0);

  r.observe(parseLine(SESSION_START_LINE));
  assert.strictEqual(r.session, 1);

  let out = r.route();
  assert.strictEqual(out.hubs[0].stale, true);
  assert.strictEqual(out.summary.carriedOver, 1);

  out = r.route({ freshOnly: true });
  assert.strictEqual(out.hubs.length, 0);

  // Re-observing the mission this session clears staleness.
  r.observe(parseLine(DELIVER_LINE_KNOWN_STATION));
  out = r.route();
  assert.strictEqual(out.hubs[0].stale, false);
});
