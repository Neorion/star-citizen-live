'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const LiveRelay = require('../../services/LiveRelay');
const gameLogMissionRegister = require('../../functions/gameLogMissionRegister');
const { parseLine } = require('../../functions/parser');

function tmpDir (prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function request (port, method, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

const MID = '1b393a11-629e-4098-8fee-bb3bbc2e5796';
const ACCEPT_LINE =
  '<2026-06-28T18:17:37.836Z> [Notice] <SHUDEvent_OnNotification> Added notification "Contract Accepted:  Junior | Stellar Small Haul | from Fallow Field <EM4>[50/100 Rep]</EM4>: " [15] to queue. New queue size: 1, MissionId: [' +
  MID + '], ObjectiveId: []';
const DELIVER_LINE =
  '<2026-03-30T21:11:55.111Z> [Notice] <SHUDEvent_OnNotification> Added notification "New Objective: Deliver 0/7 SCU of Iron to HUR-L2 Faithful Dream Station: " [8] to queue. New queue size: 2, MissionId: [' +
  MID + '], ObjectiveId: [dropoff_eacd0014-8c17-4950-b0bc-c483ef44a459_0] [Team_CoreGameplayFeatures][Missions][Comms]';

test('a cargo mission whose MissionId matches a gamelog-sourced register row is flagged inRegister: true', async () => {
  const dir = tmpDir('sc-cargo-register-');
  const svc = new LiveRelay({
    port: 0,
    settingsDir: dir,
    fabric: { enable: false },
    missions: { enable: true },
    discord: { enable: false },
    reparse: { dirs: [] }
  });
  await svc.start();
  try {
    const port = svc.server.address().port;

    // Cargo side: accumulate the mission via the real event pipeline.
    svc.cargoRouter.observe(parseLine(ACCEPT_LINE));
    svc.cargoRouter.observe(parseLine(DELIVER_LINE));
    assert.ok(svc.cargoRouter.missions[MID], 'cargo router tracked the mission');

    // Register side: seed a gamelog-sourced register row with the SAME MissionId.
    const snap = gameLogMissionRegister.snapshotFromGameLog({
      scMissionId: MID,
      generator: 'FoxwellHauling_Generator',
      startedAt: '2026-06-28T18:17:37.836Z',
      player: 'Fadingdoughnut0'
    });
    const { mission } = svc.missionManager.upsertFromGameLog(snap);
    assert.strictEqual(mission.id, MID, 'register row id is the SC MissionId (registerIdForGameLog)');
    assert.strictEqual(mission.source, 'gamelog');

    const r = await request(port, 'GET', '/cargo');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const leg = r.body.hubs[0].legs.find((l) => l.missionId === MID);
    assert.ok(leg, 'the matching leg is present');
    assert.strictEqual(leg.inRegister, true, 'the leg is flagged as seen in the register');
  } finally {
    await svc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a cargo mission with NO matching register row is flagged inRegister: false', async () => {
  const dir = tmpDir('sc-cargo-no-register-');
  const svc = new LiveRelay({
    port: 0,
    settingsDir: dir,
    fabric: { enable: false },
    missions: { enable: true },
    discord: { enable: false },
    reparse: { dirs: [] }
  });
  await svc.start();
  try {
    const port = svc.server.address().port;
    svc.cargoRouter.observe(parseLine(ACCEPT_LINE));
    svc.cargoRouter.observe(parseLine(DELIVER_LINE));

    const r = await request(port, 'GET', '/cargo');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const leg = r.body.hubs[0].legs.find((l) => l.missionId === MID);
    assert.ok(leg);
    assert.strictEqual(leg.inRegister, false);
  } finally {
    await svc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the register join never writes to the register — GET /cargo does not change missionManager.missions', async () => {
  const dir = tmpDir('sc-cargo-register-readonly-');
  const svc = new LiveRelay({
    port: 0,
    settingsDir: dir,
    fabric: { enable: false },
    missions: { enable: true },
    discord: { enable: false },
    reparse: { dirs: [] }
  });
  await svc.start();
  try {
    const port = svc.server.address().port;
    svc.cargoRouter.observe(parseLine(ACCEPT_LINE));
    svc.cargoRouter.observe(parseLine(DELIVER_LINE));
    const before = svc.missions.length;

    await request(port, 'GET', '/cargo');
    await request(port, 'GET', '/cargo');

    assert.strictEqual(svc.missions.length, before, 'no register rows were created by reading the cargo board');
  } finally {
    await svc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
