'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const deathReportStore = require('../../functions/deathReportStore');
const { tryHandleDeathReports } = require('../../functions/deathReportHttp');

const BASE = '/services/star-citizen';
// Real Game.log slice, build 12660092 (2026-09-27), scrubbed of identifiers.
const FIXTURE = path.join(__dirname, '..', 'relay', 'fixtures', 'death-fatal-collision-pilot.log');

/**
 * Mount the death-report routes on a bare http server — the same module
 * LiveRelay mounts, without needing the Fabric-backed service.
 */
async function mount (overrides = {}) {
  const store = deathReportStore.emptyStore();
  const calls = { dirty: 0 };
  const host = Object.assign({
    store,
    hosted: false,
    requireSession: () => true,
    needsAuth: () => false,
    knownLogFiles: () => [FIXTURE],
    rescan: (files) => deathReportStore.rescanFiles(store, files),
    markDirty: () => { calls.dirty += 1; }
  }, overrides);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const body = async () => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    };
    const handled = await tryHandleDeathReports(host, req, res, { pathname: url.pathname, url, base: BASE, send, body });
    if (!handled) send(404, { error: 'unhandled' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const request = (method, reqPath, payload) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = buf;
        if (/json/.test(res.headers['content-type'] || '')) { try { parsed = JSON.parse(buf); } catch (_) { /* raw */ } }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(JSON.stringify(payload));
    req.end();
  });
  return { store, calls, request, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('rescan -> list -> detail -> export -> delete over HTTP', async () => {
  const app = await mount();
  try {
    const empty = await app.request('GET', `${BASE}/deathreports`);
    assert.strictEqual(empty.status, 200);
    assert.deepStrictEqual(empty.body, { type: 'Collection', total: 0, data: [] });

    const scan = await app.request('POST', `${BASE}/deathreports/rescan`, { path: FIXTURE });
    assert.strictEqual(scan.status, 200);
    assert.strictEqual(scan.body.type, 'DeathReportRescan');
    assert.strictEqual(scan.body.files, 1);
    assert.strictEqual(scan.body.lines, 625);
    assert.strictEqual(scan.body.created, 1);

    // Acceptance: a second rescan creates nothing and skips the duplicate.
    const again = await app.request('POST', `${BASE}/deathreports/rescan`, { all: true });
    assert.strictEqual(again.body.created, 0);
    assert.strictEqual(again.body.skippedDuplicates, 1);

    const list = await app.request('GET', `${BASE}/deathreports?limit=10`);
    assert.strictEqual(list.body.total, 1);
    const row = list.body.data[0];
    assert.strictEqual(row.status, 'confirmed');
    assert.strictEqual(row.cause, 'vehicle_collision_pilot');
    assert.strictEqual(row.zoneName, 'Pyro IV');
    assert.strictEqual(row.vehicleName, 'Anvil Asgard');
    assert.strictEqual(row.itemsLost, 38);
    assert.strictEqual(row.items, undefined, 'list rows stay compact');

    // Dual-mounted without the base prefix.
    assert.strictEqual((await app.request('GET', '/deathreports')).body.total, 1);
    assert.strictEqual((await app.request('GET', `${BASE}/deathreports?cause=unknown`)).body.total, 0);
    assert.strictEqual((await app.request('GET', `${BASE}/deathreports?status=confirmed`)).body.total, 1);

    const detail = await app.request('GET', `${BASE}/deathreports/${row.id}`);
    assert.strictEqual(detail.body.type, 'DeathReport');
    assert.strictEqual(detail.body.data.items.length, 45);
    assert.strictEqual(detail.body.data.lineBasis, 'file');
    assert.strictEqual(detail.body.data.lineStart, 184);
    assert.strictEqual(detail.body.data.logFile, 'death-fatal-collision-pilot.log', 'basename only');
    assert.ok(!JSON.stringify(detail.body.data).includes(path.dirname(FIXTURE)), 'no filesystem path in the report');

    const md = await app.request('GET', `${BASE}/deathreports/${row.id}/export?format=md`);
    assert.strictEqual(md.status, 200);
    assert.match(md.headers['content-type'], /text\/markdown/);
    assert.match(md.headers['content-disposition'], /attachment; filename="death-report-[0-9a-f]{8}\.md"/);
    assert.match(md.body, /^# Death report — confirmed/);
    const json = await app.request('GET', `${BASE}/deathreports/${row.id}/export?format=json`);
    assert.strictEqual(json.body.id, row.id);
    assert.strictEqual((await app.request('GET', `${BASE}/deathreports/${row.id}/export?format=pdf`)).status, 400);

    const del = await app.request('DELETE', `${BASE}/deathreports/${row.id}`);
    assert.strictEqual(del.status, 200);
    assert.strictEqual(app.calls.dirty, 1);
    assert.strictEqual((await app.request('GET', `${BASE}/deathreports/${row.id}`)).status, 404);
    assert.strictEqual((await app.request('DELETE', `${BASE}/deathreports/${row.id}`)).status, 404);
    assert.strictEqual((await app.request('GET', `${BASE}/deathreports/${'0'.repeat(32)}/export`)).status, 404);
  } finally { await app.close(); }
});

test('rescan only reads files the node already knows as logs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-death-http-'));
  const outside = path.join(dir, 'notes.txt');
  fs.writeFileSync(outside, 'not a log');
  const app = await mount();
  try {
    const res = await app.request('POST', `${BASE}/deathreports/rescan`, { path: outside });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /not a known log file/);
    assert.strictEqual((await app.request('POST', `${BASE}/deathreports/rescan`, {})).status, 400);
    assert.strictEqual(app.store.reports.length, 0);
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hosted mode refuses rescan; unauthenticated remote callers cannot read or mutate', async () => {
  const hosted = await mount({ hosted: true });
  try {
    const res = await hosted.request('POST', `${BASE}/deathreports/rescan`, { all: true });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /local-player operation/);
  } finally { await hosted.close(); }

  const locked = await mount({
    requireSession: (req, send) => { send(401, { error: 'Authentication required' }); return false; },
    needsAuth: () => true
  });
  try {
    assert.strictEqual((await locked.request('GET', `${BASE}/deathreports`)).status, 401);
    assert.strictEqual((await locked.request('GET', `${BASE}/deathreports/${'a'.repeat(32)}`)).status, 401);
    assert.strictEqual((await locked.request('POST', `${BASE}/deathreports/rescan`, { all: true })).status, 401);
    assert.strictEqual((await locked.request('DELETE', `${BASE}/deathreports/${'a'.repeat(32)}`)).status, 401);
    assert.strictEqual(locked.store.reports.length, 0);
  } finally { await locked.close(); }
});

test('unrelated paths fall through to the next handler', async () => {
  const app = await mount();
  try {
    assert.strictEqual((await app.request('GET', `${BASE}/analytics`)).status, 404);
    assert.strictEqual((await app.request('GET', `${BASE}/deathreports/not-an-id`)).status, 404);
    assert.strictEqual((await app.request('PUT', `${BASE}/deathreports`)).body.error, 'unhandled');
  } finally { await app.close(); }
});
