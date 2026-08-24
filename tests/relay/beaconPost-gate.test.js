'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LiveRelay = require('../../services/LiveRelay');

function tmpDir (prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

// Real VERIFIED sample lines (functions/parser.js quantum:select / quantum:arrive rules;
// same shapes used in tests/relay/parser.test.js).
const SELECT_LINE = '<2026-07-23T23:55:53.091Z> [Notice] <Player Selected Quantum Target - Local> [ItemNavigation][CL][416] | NOT AUTH | DRAK_Clipper_734066837132[734066837132]|CSCItemNavigation::OnPlayerSelectedQuantumTarget|Player has selected point rs_ext_cru-leo1 as their destination, routing locally [Team_CGP4][QuantumTravel]';
const ARRIVE_LINE = '<2026-07-26T05:08:02.800Z> [Notice] <Quantum Drive Arrived - Arrived at Final Destination> [ItemNavigation][CL][9156] | NOT AUTH | RSI_Mantis_738839128122[738839128122]|CSCItemNavigation::OnQuantumDriveArrived|Quantum Drive has arrived at final destination [Team_CGP4][QuantumTravel]';

function stubFetch (impl) {
  const calls = [];
  const prev = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts: opts || {} });
    return impl ? impl(url, opts) : { ok: true, status: 200, json: async () => ({}) };
  };
  return { calls, restore: () => { global.fetch = prev; } };
}

test('beacon OFF by default: quantum:select + quantum:arrive never call fetch', async () => {
  const dir = tmpDir('sc-beacon-off-');
  const svc = newService(dir);
  await svc.start();
  const { calls, restore } = stubFetch();
  try {
    svc.handleLogChange(SELECT_LINE);
    svc.handleLogChange(ARRIVE_LINE);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(calls.length, 0, 'fetch must never be called while verseviewShareBeacon is off');
  } finally {
    restore();
    await svc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('beacon ON: fires exactly one POST with the right URL, Authorization header, and body', async () => {
  const dir = tmpDir('sc-beacon-on-');
  const svc = newService(dir);
  await svc.start();
  const { calls, restore } = stubFetch();
  try {
    svc._verseviewShareBeacon = true;
    svc._verseviewBeaconUrl = 'https://verseview.example.com/api/beacon';
    svc._verseviewBeaconToken = 'tok-abc123';

    svc.handleLogChange(SELECT_LINE);
    svc.handleLogChange(ARRIVE_LINE);
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(calls.length, 1, 'exactly one beacon POST should fire');
    const call = calls[0];
    assert.strictEqual(call.url, 'https://verseview.example.com/api/beacon');
    assert.strictEqual(call.opts.method, 'POST');
    assert.strictEqual(call.opts.headers.Authorization, 'Bearer tok-abc123');
    assert.strictEqual(call.opts.headers['Content-Type'], 'application/json');
    assert.deepStrictEqual(JSON.parse(call.opts.body), { location_code: 'rs_ext_cru-leo1' });
  } finally {
    restore();
    await svc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('60s throttle: two rapid arrivals in a row only fire one fetch call', async () => {
  const dir = tmpDir('sc-beacon-throttle-');
  const svc = newService(dir);
  await svc.start();
  const { calls, restore } = stubFetch();
  try {
    svc._verseviewShareBeacon = true;
    svc._verseviewBeaconUrl = 'https://verseview.example.com/api/beacon';
    svc._verseviewBeaconToken = 'tok-abc123';

    svc.handleLogChange(SELECT_LINE);
    svc.handleLogChange(ARRIVE_LINE); // first arrival: fires
    svc.handleLogChange(ARRIVE_LINE); // second arrival, immediately after: throttled
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(calls.length, 1, 'a second arrival inside the 60s window must not fire a second POST');
  } finally {
    restore();
    await svc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a non-2xx response is a silent no-op: no throw, no error event', async () => {
  const dir = tmpDir('sc-beacon-4xx-');
  const svc = newService(dir);
  await svc.start();
  const { calls, restore } = stubFetch(() => ({ ok: false, status: 400, json: async () => ({ detail: 'unknown location' }) }));
  const errors = [];
  svc.on('error', (e) => errors.push(e));
  try {
    svc._verseviewShareBeacon = true;
    svc._verseviewBeaconUrl = 'https://verseview.example.com/api/beacon';
    svc._verseviewBeaconToken = 'tok-abc123';

    svc.handleLogChange(SELECT_LINE);
    assert.doesNotThrow(() => svc.handleLogChange(ARRIVE_LINE));
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(calls.length, 1, 'the POST is still attempted');
    assert.strictEqual(errors.length, 0, 'a 400 "unknown location" must not emit an error event');
  } finally {
    restore();
    await svc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a genuine fetch rejection (network failure) does emit an error event, but does not throw', async () => {
  const dir = tmpDir('sc-beacon-network-fail-');
  const svc = newService(dir);
  await svc.start();
  const prev = global.fetch;
  global.fetch = async () => { throw new Error('ECONNREFUSED fake network failure'); };
  const errors = [];
  svc.on('error', (e) => errors.push(e));
  try {
    svc._verseviewShareBeacon = true;
    svc._verseviewBeaconUrl = 'https://verseview.example.com/api/beacon';
    svc._verseviewBeaconToken = 'tok-abc123';

    svc.handleLogChange(SELECT_LINE);
    assert.doesNotThrow(() => svc.handleLogChange(ARRIVE_LINE));
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(errors.length, 1, 'an actual network failure should still surface via the error event');
  } finally {
    global.fetch = prev;
    await svc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the beacon token is loaded from the secrets file, never from the persisted settings map', async () => {
  const dir = tmpDir('sc-beacon-secrets-load-');
  const verseviewConfig = require('../../functions/verseviewConfig');
  verseviewConfig.writeSecretsFile(dir, { beaconToken: 'tok-from-file' });

  const svc = newService(dir);
  await svc.start();
  try {
    assert.strictEqual(svc._verseviewBeaconToken, 'tok-from-file');
  } finally {
    await svc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PUT /settings/verseview/secrets persists the token to the secrets file and never echoes it back', async () => {
  const http = require('http');
  const dir = tmpDir('sc-beacon-secrets-route-');
  const svc = newService(dir);
  await svc.start();
  try {
    const port = svc.server.address().port;
    const body = JSON.stringify({ beaconToken: 'tok-via-route' });
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, method: 'PUT', path: '/settings/verseview/secrets',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, (r) => {
        let buf = '';
        r.on('data', (c) => { buf += c; });
        r.on('end', () => resolve({ status: r.statusCode, body: buf ? JSON.parse(buf) : null }));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.secrets.beaconTokenConfigured, true);
    assert.strictEqual(JSON.stringify(res.body).includes('tok-via-route'), false, 'the raw token must never appear in the response');
    assert.strictEqual(svc._verseviewBeaconToken, 'tok-via-route');

    const verseviewConfig = require('../../functions/verseviewConfig');
    assert.deepStrictEqual(verseviewConfig.readSecretsFile(dir), { beaconToken: 'tok-via-route' });
  } finally {
    await svc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
