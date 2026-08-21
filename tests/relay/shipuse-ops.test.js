'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cumulativeHistory = require('../../functions/cumulativeHistory');
const { parseLine } = require('../../functions/parser');
const LiveRelay = require('../../services/LiveRelay');

// Matches the real "Vehicle Control Flow" rule in functions/parser.js
// (CVehicleMovementBase::ClearDriver, ~line 174-179) with a ship id shaped
// like a real 4.x entity id (MANUFACTURER_ShipName_<bigid>).
const CLEAR_DRIVER_LINE =
  "<2026-06-15T10:00:00.000Z> [Notice] <Vehicle Control Flow>CVehicleMovementBase::ClearDriver: " +
  "Local client node [1234] releasing control token for 'AEGS_Avenger_Titan_487288078845' [56789]";

test('cumulativeHistory folds vehicle:control (action:clear) into history.shipUse, deduped', () => {
  const ev = parseLine(CLEAR_DRIVER_LINE);
  assert.strictEqual(ev.kind, 'vehicle:control');
  assert.strictEqual(ev.action, 'clear');
  assert.strictEqual(ev.vehicle, 'AEGS_Avenger_Titan_487288078845');

  const history = cumulativeHistory.emptyHistory();
  const index = cumulativeHistory.indexHistory(history);

  const first = cumulativeHistory.applyEvent(history, index, ev, { handle: 'TestPilot', countHeat: false });
  assert.strictEqual(first, true, 'first apply records a new shipUse entry');
  assert.strictEqual(history.shipUse.length, 1);

  const row = history.shipUse[0];
  assert.ok(row.id);
  assert.strictEqual(row.player, 'TestPilot');
  assert.strictEqual(row.ts, '2026-06-15T10:00:00.000Z');
  assert.strictEqual(row.ship, 'Avenger Titan');

  // Re-applying the identical event (e.g. cursor overlap / re-scan) must not duplicate.
  const second = cumulativeHistory.applyEvent(history, index, ev, { handle: 'TestPilot', countHeat: false });
  assert.strictEqual(second, false, 'duplicate apply is a no-op');
  assert.strictEqual(history.shipUse.length, 1);

  // normalizeHistory / historyLeaves / cumulativeCounts all know about shipUse.
  const normalized = cumulativeHistory.normalizeHistory(history);
  assert.strictEqual(normalized.shipUse.length, 1);
  const leaves = cumulativeHistory.historyLeaves(history);
  assert.ok(leaves.some((l) => l.kind === 'shipUse' && l.id === row.id));
  const counts = cumulativeHistory.cumulativeCounts(history);
  assert.strictEqual(counts.shipUse, 1);
});

test('vehicle:control with a non-clear action is ignored (only action:clear folds)', () => {
  const history = cumulativeHistory.emptyHistory();
  const index = cumulativeHistory.indexHistory(history);
  const ev = {
    kind: 'vehicle:control',
    action: 'something-else',
    vehicle: 'AEGS_Avenger_Titan_487288078845',
    vehicleId: '56789',
    timestamp: '2026-06-15T10:00:00.000Z'
  };
  const changed = cumulativeHistory.applyEvent(history, index, ev, { handle: 'TestPilot', countHeat: false });
  assert.strictEqual(changed, false);
  assert.strictEqual(history.shipUse.length, 0);
});

function tmpSettingsDir (prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function bootOptions (dir) {
  const logCopy = path.join(dir, 'Game.log');
  if (!fs.existsSync(logCopy)) fs.writeFileSync(logCopy, '');
  return {
    port: 0,
    logfile: logCopy,
    seed: null,
    settingsDir: dir,
    historyFile: path.join(dir, 'history.json'),
    cursorsFile: path.join(dir, 'log-cursors.json'),
    missions: { enable: false },
    fabric: { enable: false },
    // Explicit (empty) reparse dirs takes the safe branch in
    // _syncCumulativeHistory() instead of the full-machine corpus auto-detect.
    reparse: { dirs: [] }
  };
}

test('LiveRelay ops roster persists and reloads from the same settingsDir', async () => {
  const dir = tmpSettingsDir('gc-ops-');

  const svc = new LiveRelay(bootOptions(dir));
  await svc.start();
  try {
    assert.deepStrictEqual(svc.ops, [], 'no ops persisted yet');

    const op = svc._buildOpRecord({
      name: 'Jumptown Raid',
      start: '2026-06-20T18:00:00.000Z',
      end: '2026-06-20T20:00:00.000Z',
      createdBy: 'ABC123'
    });
    assert.ok(op.id);
    assert.strictEqual(op.name, 'Jumptown Raid');
    assert.strictEqual(op.createdBy, 'abc123', 'createdBy is lower-cased');

    svc.ops.push(op);
    svc._persistOps();
  } finally {
    if (svc.status !== 'STOPPED') await svc.stop();
  }

  // Reload from the same settingsDir in a fresh instance (new process, in
  // effect) — only after the first instance has released the Store, since
  // two LiveRelay instances can't hold the same LevelDB-backed Store open
  // concurrently.
  const svc2 = new LiveRelay(bootOptions(dir));
  await svc2.start();
  try {
    assert.strictEqual(svc2.ops.length, 1);
    assert.strictEqual(svc2.ops[0].name, 'Jumptown Raid');
    assert.strictEqual(svc2.ops[0].start, '2026-06-20T18:00:00.000Z');
    assert.strictEqual(svc2.ops[0].end, '2026-06-20T20:00:00.000Z');
    assert.strictEqual(svc2.ops[0].createdBy, 'abc123');
  } finally {
    await svc2.stop();
  }
});

test('LiveRelay._buildOpRecord validates name/start/end', async () => {
  const dir = tmpSettingsDir('gc-ops-validate-');
  const svc = new LiveRelay(bootOptions(dir));
  await svc.start();
  try {
    assert.throws(() => svc._buildOpRecord({ name: '', start: '2026-06-20T18:00:00.000Z', end: '2026-06-20T20:00:00.000Z' }),
      /name is required/);
    assert.throws(() => svc._buildOpRecord({ name: 'X', start: 'not-a-date', end: '2026-06-20T20:00:00.000Z' }),
      /start must be a parseable date/);
    assert.throws(() => svc._buildOpRecord({ name: 'X', start: '2026-06-20T20:00:00.000Z', end: 'not-a-date' }),
      /end must be a parseable date/);
    assert.throws(() => svc._buildOpRecord({ name: 'X', start: '2026-06-20T20:00:00.000Z', end: '2026-06-20T18:00:00.000Z' }),
      /start must be before end/);
  } finally {
    await svc.stop();
  }
});
