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

test('POST /ops creates an op, rejects bad dates, GET /ops lists it', async () => {
  const dir = tmpDir('sc-ops-');
  const svc = newService(dir);
  await svc.start();
  try {
    const port = svc.server.address().port;

    // Bad input: end before start.
    let r = await request(port, 'POST', '/ops', {
      name: 'Bad Op',
      start: '2026-08-02T00:00:00.000Z',
      end: '2026-08-01T00:00:00.000Z'
    });
    assert.strictEqual(r.status, 400);
    assert.ok(r.body && typeof r.body.error === 'string' && r.body.error.length > 0, 'bad window returns a clear error message');

    // Bad input: unparseable dates.
    r = await request(port, 'POST', '/ops', { name: 'Bad Op 2', start: 'not-a-date', end: 'also-not-a-date' });
    assert.strictEqual(r.status, 400);

    // Happy path: create.
    r = await request(port, 'POST', '/ops', {
      name: 'Op Firestorm',
      start: '2026-08-01T00:00:00.000Z',
      end: '2026-08-02T00:00:00.000Z',
      createdBy: 'boss'
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.type, 'Op');
    assert.ok(r.body.data && r.body.data.id, 'created op has an id');
    assert.strictEqual(r.body.data.name, 'Op Firestorm');
    const opId = r.body.data.id;

    // GET /ops lists it (dual-mounted; also check the base-prefixed path).
    r = await request(port, 'GET', '/ops');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.type, 'Collection');
    assert.ok(r.body.data.some((o) => o.id === opId), 'created op appears in the /ops collection');

    r = await request(port, 'GET', '/services/star-citizen/ops');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.data.some((o) => o.id === opId), 'created op appears via the base-mounted path too');
  } finally {
    await svc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /ops/:id/participation 404s for an unknown op id', async () => {
  const dir = tmpDir('sc-ops-404-');
  const svc = newService(dir);
  await svc.start();
  try {
    const port = svc.server.address().port;
    const r = await request(port, 'GET', '/ops/does-not-exist/participation');
    assert.strictEqual(r.status, 404);
    assert.ok(r.body && r.body.error, 'unknown op returns an error message');
  } finally {
    await svc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /ops/:id/participation computes rows, omits split by default, includes split with ?formula=', async () => {
  const dir = tmpDir('sc-ops-participation-');
  const svc = newService(dir);
  await svc.start();
  try {
    const port = svc.server.address().port;

    // Op window covering a single day.
    let r = await request(port, 'POST', '/ops', {
      name: 'Op Homefront',
      start: '2026-08-10T00:00:00.000Z',
      end: '2026-08-11T00:00:00.000Z',
      createdBy: 'boss'
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const opId = r.body.data.id;

    // Seed synthetic history records inside the op window, before calling the route.
    svc.history.missions = svc.history.missions || [];
    svc.history.deaths = svc.history.deaths || [];
    svc.history.quantum = svc.history.quantum || [];
    svc.history.shipUse = svc.history.shipUse || [];

    svc.history.missions.push(
      { player: 'PilotJane', ts: '2026-08-10T01:00:00.000Z', outcome: 'Complete' },
      { player: 'PilotJane', ts: '2026-08-10T02:00:00.000Z', outcome: 'Complete' },
      { player: 'PilotBob', ts: '2026-08-10T03:00:00.000Z', outcome: 'Fail' }
    );
    svc.history.deaths.push({ player: 'PilotBob', ts: '2026-08-10T03:05:00.000Z' });
    svc.history.quantum.push({ player: 'PilotJane', ts: '2026-08-10T01:30:00.000Z', destination: 'Crusader' });
    svc.history.shipUse.push(
      { player: 'PilotJane', ship: 'Cutlass Black', ts: '2026-08-10T01:00:00.000Z' },
      { player: 'PilotBob', ship: 'Aurora MR', ts: '2026-08-10T03:00:00.000Z' }
    );

    // Plain call: rows present, split omitted entirely (not null).
    r = await request(port, 'GET', `/ops/${opId}/participation`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.type, 'Participation');
    assert.ok(r.body.data.op && r.body.data.op.id === opId, 'response echoes the matched op');
    assert.ok(Array.isArray(r.body.data.rows), 'rows is an array');
    assert.ok(!('split' in r.body.data), 'split key is omitted entirely when no formula is requested');
    const jane = r.body.data.rows.find((row) => row.member === 'PilotJane');
    assert.ok(jane, 'PilotJane appears in participation rows');
    assert.strictEqual(jane.missionsInWindow, 2);
    assert.strictEqual(jane.missionsCompleted, 2);
    assert.strictEqual(jane.inferred, true);

    // ?formula=equal: split included as an array.
    r = await request(port, 'GET', `/ops/${opId}/participation?formula=equal`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.data.split), 'split is an array when formula=equal is requested');
    r.body.data.split.forEach((s) => {
      assert.strictEqual(s.inferred, true);
      assert.strictEqual(s.advisory, true);
    });

    // Invalid formula → 400.
    r = await request(port, 'GET', `/ops/${opId}/participation?formula=not-a-real-formula`);
    assert.strictEqual(r.status, 400);
    assert.ok(r.body && r.body.error, 'invalid formula returns a clear error message');
  } finally {
    await svc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
