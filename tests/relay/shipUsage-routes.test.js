'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const LiveRelay = require('../../services/LiveRelay');

function tmpDir (prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function request (port, method, reqPath, payload) {
  return new Promise((resolve, reject) => {
    const data = payload ? JSON.stringify(payload) : null;
    const headers = data
      ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
      : {};
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function newService (dir) {
  return new LiveRelay({
    port: 0,
    settingsDir: dir,
    fabric: { enable: false },
    missions: { enable: false },
    discord: { enable: false },
    // Explicit (empty) reparse dirs takes the safe branch in
    // _syncCumulativeHistory() instead of the full-machine corpus auto-detect.
    reparse: { dirs: [] }
  });
}

test('GET /ship-usage returns a ShipUsage-typed array (empty when no history)', async () => {
  const dir = tmpDir('sc-ship-usage-empty-');
  const svc = newService(dir);
  await svc.start();
  try {
    const port = svc.server.address().port;
    const r = await request(port, 'GET', '/ship-usage');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.type, 'ShipUsage');
    assert.ok(Array.isArray(r.body.data));
  } finally {
    await svc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /ship-usage rolls up synthetic multi-member/multi-ship shipUse records (dual-mounted path too)', async () => {
  const dir = tmpDir('sc-ship-usage-');
  const svc = newService(dir);
  await svc.start();
  try {
    const port = svc.server.address().port;

    svc.history.shipUse = svc.history.shipUse || [];
    svc.history.shipUse.push(
      { player: 'PilotJane', ship: 'Cutlass Black', ts: '2026-08-10T01:00:00.000Z' },
      { player: 'PilotJane', ship: 'Cutlass Black', ts: '2026-08-10T01:40:00.000Z' },
      { player: 'PilotJane', ship: 'Freelancer', ts: '2026-08-10T02:00:00.000Z' },
      { player: 'PilotBob', ship: 'Aurora MR', ts: '2026-08-10T03:00:00.000Z' },
      { player: 'PilotBob', ship: null, ts: '2026-08-10T04:00:00.000Z' } // no ship -> ignored
    );

    let r = await request(port, 'GET', '/ship-usage');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.type, 'ShipUsage');
    const jane = r.body.data.filter((row) => row.member === 'PilotJane');
    assert.strictEqual(jane.length, 2);
    const cutlass = jane.find((row) => row.ship === 'Cutlass Black');
    assert.strictEqual(cutlass.sessions, 1);
    assert.strictEqual(cutlass.minutes, 60);
    assert.strictEqual(cutlass.inferred, true);
    const bob = r.body.data.filter((row) => row.member === 'PilotBob');
    assert.strictEqual(bob.length, 1, 'null-ship record is skipped');
    assert.strictEqual(bob[0].ship, 'Aurora MR');

    // Base-mounted path works too.
    r = await request(port, 'GET', '/services/star-citizen/ship-usage');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.data.some((row) => row.member === 'PilotJane'));
  } finally {
    await svc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
