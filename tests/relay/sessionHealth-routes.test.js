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

test('GET /session-health returns a SessionHealth-typed array (empty history), dual-mounted', async () => {
  const dir = tmpDir('sc-sh-empty-');
  const svc = newService(dir);
  await svc.start();
  try {
    const port = svc.server.address().port;

    let r = await request(port, 'GET', '/session-health');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.type, 'SessionHealth');
    assert.ok(Array.isArray(r.body.data));

    r = await request(port, 'GET', '/services/star-citizen/session-health');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.type, 'SessionHealth');
    assert.ok(Array.isArray(r.body.data), 'base-mounted path also works');
  } finally {
    await svc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /session-health rolls up synthetic multi-build session records seeded on svc.history', async () => {
  const dir = tmpDir('sc-sh-rollup-');
  const svc = newService(dir);
  await svc.start();
  try {
    const port = svc.server.address().port;

    svc.history.sessions = svc.history.sessions || [];
    svc.history.sessions.push(
      {
        id: 's1', player: 'PilotJane', ts: '2026-08-10T00:00:00.000Z',
        build: '9999999', branch: 'sc-live-1', changelist: '9999999',
        endTs: '2026-08-10T01:00:00.000Z', disconnects: 1, cleanEnd: true
      },
      {
        id: 's2', player: 'PilotJane', ts: '2026-08-10T02:00:00.000Z',
        build: '9999999', branch: 'sc-live-1', changelist: '9999999',
        endTs: '2026-08-10T02:40:00.000Z', disconnects: 0, cleanEnd: false
      },
      {
        id: 's3', player: 'PilotBob', ts: '2026-08-11T00:00:00.000Z',
        build: '8888888', branch: 'sc-ptu-1', changelist: '8888888',
        endTs: '2026-08-11T00:20:00.000Z', disconnects: 2, cleanEnd: true
      }
    );

    const r = await request(port, 'GET', '/session-health');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.type, 'SessionHealth');
    const rows = r.body.data;

    const b9 = rows.find((row) => row.build === '9999999');
    assert.ok(b9, 'build 9999999 present');
    assert.strictEqual(b9.sessions, 2);
    assert.strictEqual(b9.disconnects, 1);
    assert.strictEqual(b9.crashes, 1);
    assert.strictEqual(b9.medianSessionMinutes, 50);
    assert.strictEqual(b9.inferred, true);

    const b8 = rows.find((row) => row.build === '8888888');
    assert.ok(b8, 'build 8888888 present');
    assert.strictEqual(b8.sessions, 1);
    assert.strictEqual(b8.disconnects, 2);
    assert.strictEqual(b8.crashes, 0);
    assert.strictEqual(b8.medianSessionMinutes, 20);
  } finally {
    await svc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
