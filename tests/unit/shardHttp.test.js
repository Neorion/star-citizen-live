'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const shardStore = require('../../functions/shardStore');
const { tryHandleShard, isCrossOrigin } = require('../../functions/shardHttp');

const BASE = '/services/star-citizen';
const LINES = [
  '<2026-09-28T06:35:10.000Z> BackupNameAttachment=" Build(12660092) 27 Sep 26 (16 21 45)"  -- used by backup system',
  '<2026-09-28T06:35:38.985Z> [Notice] <Join PU> address[203.0.113.10] port[64348] shard[pub_use1b_12660092_010] locationId[-5551234] [Team_GameServices][GIM][Matchmaking]',
  '<2026-09-28T06:35:39.008Z> [Notice] <ContextEstablisher Model Change State> ViewName="Replicant 203.0.113.10:64348" connection={3, 0} node_id=00000000-0000-0000-0000-000000000001 playerGEID=900000000001 sessionId="00000000000000000000000000000000" [Team_Network]',
  '<2026-09-28T07:03:29.500Z> [Notice] <RequestLocationInventory> Player[TestPilot] requested inventory for Location[RR_P5_L2] [Inventory]',
  '<2026-09-28T08:43:26.144Z> [Notice] <Recv Bind Batch End Player> Bind Batch End enabled player in batch 7806 ViewName="Replicant 203.0.113.20:64295" connection={3, 0} node_id=00000000-0000-0000-0000-000000000001 playerGEID=900000000001 sessionId="00000000000000000000000000000000" [Team_Network]'
];

function tmpLog () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-shard-http-'));
  const file = path.join(dir, 'Game.log');
  fs.writeFileSync(file, LINES.join('\n') + '\n');
  return { dir, file };
}

async function mount (knownFiles, overrides = {}) {
  const store = shardStore.emptyStore();
  const host = Object.assign({
    enabled: true,
    store,
    current: () => ({ shard: { id: 'pub_use1b_12660092_010' } }),
    hosted: false,
    requireSession: () => true,
    needsAuth: () => false,
    knownLogFiles: () => knownFiles,
    rescan: (files) => shardStore.rescanFiles(store, files)
  }, overrides);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const body = async () => { const c = []; for await (const ch of req) c.push(ch); return c.length ? JSON.parse(Buffer.concat(c).toString()) : {}; };
    const handled = await tryHandleShard(host, req, res, { pathname: url.pathname, url, base: BASE, send, body });
    if (!handled) send(404, { error: 'unhandled' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const request = (method, reqPath, payload, extra) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers: Object.assign({ 'Content-Type': 'application/json' }, extra || {}) }, (res) => {
      let buf = ''; res.on('data', (c) => { buf += c; });
      res.on('end', () => { let b = buf; if (/json/.test(res.headers['content-type'] || '')) { try { b = JSON.parse(buf); } catch (_) {} } resolve({ status: res.statusCode, headers: res.headers, body: b }); });
    });
    req.on('error', reject); if (payload) req.write(JSON.stringify(payload)); req.end();
  });
  return { store, request, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('gated: every shard route is 503 when capture is off', async () => {
  const app = await mount([], { enabled: false, store: null });
  try {
    for (const [m, p] of [['GET', '/shard'], ['GET', '/shard/events'], ['GET', '/shard/export.csv'], ['POST', '/shard/rescan']]) {
      const r = await app.request(m, `${BASE}${p}`, m === 'POST' ? { all: true } : undefined);
      assert.strictEqual(r.status, 503, `${m} ${p}`);
      assert.strictEqual(r.body.enabled, false);
    }
    assert.strictEqual((await app.request('GET', `${BASE}/analytics`)).body.error, 'unhandled', 'other paths fall through');
  } finally { await app.close(); }
});

test('enabled: rescan -> status -> events -> csv; unknown paths refused', async () => {
  const { dir, file } = tmpLog();
  const app = await mount([file]);
  try {
    const empty = await app.request('GET', `${BASE}/shard`);
    assert.strictEqual(empty.body.enabled, true);
    assert.deepStrictEqual(empty.body.counts, { joins: 0, handoffs: 0, authority: 0 });

    const scan = await app.request('POST', `${BASE}/shard/rescan`, { path: file });
    assert.strictEqual(scan.status, 200);
    assert.strictEqual(scan.body.added, 2);
    const again = await app.request('POST', `${BASE}/shard/rescan`, { all: true });
    assert.strictEqual(again.body.added, 0);
    assert.strictEqual(again.body.skippedDuplicates, 2);

    const status = await app.request('GET', '/shard');
    assert.strictEqual(status.body.shards[0].shardId, 'pub_use1b_12660092_010');
    assert.strictEqual(status.body.shards[0].region, 'use1b');
    assert.strictEqual(status.body.current.shard.id, 'pub_use1b_12660092_010');

    const ev = await app.request('GET', `${BASE}/shard/events?kind=handoffs`);
    assert.strictEqual(ev.body.total, 1);
    assert.strictEqual(ev.body.data[0].place, 'RR_P5_L2');
    assert.strictEqual((await app.request('GET', `${BASE}/shard/events?kind=nope`)).status, 400);

    const csv = await app.request('GET', `${BASE}/shard/export.csv`);
    assert.match(csv.headers['content-type'], /text\/csv/);
    assert.match(csv.body, /join,2026-09-28T06:35:38\.985Z,pub_use1b_12660092_010/);

    const outside = path.join(dir, 'notes.txt'); fs.writeFileSync(outside, 'x');
    assert.strictEqual((await app.request('POST', `${BASE}/shard/rescan`, { path: outside })).status, 400);
    assert.strictEqual((await app.request('DELETE', `${BASE}/shard`)).status, 405);
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hosted mode refuses rescan; unauthenticated remote callers cannot read', async () => {
  const { dir, file } = tmpLog();
  const hosted = await mount([file], { hosted: true });
  try { assert.strictEqual((await hosted.request('POST', `${BASE}/shard/rescan`, { all: true })).status, 400); } finally { await hosted.close(); }
  const locked = await mount([file], { requireSession: (req, send) => { send(401, { error: 'Authentication required' }); return false; }, needsAuth: () => true });
  try {
    assert.strictEqual((await locked.request('GET', `${BASE}/shard`)).status, 401);
    assert.strictEqual((await locked.request('GET', `${BASE}/shard/export.csv`)).status, 401);
    assert.strictEqual((await locked.request('POST', `${BASE}/shard/rescan`, { all: true })).status, 401);
  } finally { await locked.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('rescan: an overlapping rescan answers 409; a later one succeeds', async () => {
  const { dir, file } = tmpLog();
  let release;
  let started;
  const startedP = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const app = await mount([file], { rescan: async () => { calls += 1; started(); await gate; return { files: 0, lines: 0, added: 0, skippedDuplicates: 0 }; } });
  try {
    const first = app.request('POST', `${BASE}/shard/rescan`, { all: true });
    await startedP;
    const second = await app.request('POST', `${BASE}/shard/rescan`, { all: true });
    assert.strictEqual(second.status, 409);
    assert.strictEqual(second.body.error, 'shard rescan already running');
    release();
    assert.strictEqual((await first).status, 200);
    assert.strictEqual((await app.request('POST', `${BASE}/shard/rescan`, { all: true })).status, 200);
    assert.strictEqual(calls, 2);
  } finally { release(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rescan: foreign Origin is refused (403); loopback Origin and no Origin are allowed', async () => {
  const { dir, file } = tmpLog();
  const app = await mount([file]);
  try {
    const foreign = await app.request('POST', `${BASE}/shard/rescan`, { all: true }, { Origin: 'https://evil.example' });
    assert.strictEqual(foreign.status, 403);
    assert.strictEqual(foreign.body.error, 'cross-origin request refused');
    assert.strictEqual(app.store.joins.length, 0, 'nothing was scanned');
    assert.strictEqual((await app.request('POST', `${BASE}/shard/rescan`, { all: true }, { Origin: 'http://localhost:5173' })).status, 200);
    assert.strictEqual((await app.request('POST', `${BASE}/shard/rescan`, { all: true }, { Origin: 'http://127.0.0.1:3041' })).status, 200);
    assert.strictEqual((await app.request('POST', `${BASE}/shard/rescan`, { all: true })).status, 200);
    assert.strictEqual(isCrossOrigin({ headers: { origin: 'http://relay.test:3041', host: 'relay.test:3041' } }), false, 'same host as Host header');
    assert.strictEqual(isCrossOrigin({ headers: { origin: 'null', host: 'relay.test:3041' } }), true);
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('gated: 503 comes before the Origin check', async () => {
  const app = await mount([], { enabled: false, store: null });
  try {
    assert.strictEqual((await app.request('POST', `${BASE}/shard/rescan`, { all: true }, { Origin: 'https://evil.example' })).status, 503);
  } finally { await app.close(); }
});
