'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LiveRelay = require('../../services/LiveRelay');

const BASE = '/services/star-citizen';
// Real 4.10 line shapes; handle, ids and addresses replaced (TEST-NET).
const LINES = [
  '<2026-09-28T06:35:10.000Z> BackupNameAttachment=" Build(12660092) 27 Sep 26 (16 21 45)"  -- used by backup system',
  '<2026-09-28T06:35:38.985Z> [Notice] <Join PU> address[203.0.113.10] port[64348] shard[pub_use1b_12660092_010] locationId[-5551234] [Team_GameServices][GIM][Matchmaking]',
  '<2026-09-28T06:35:39.008Z> [Notice] <ContextEstablisher Model Change State> ViewName="Replicant 203.0.113.10:64348" connection={3, 0} node_id=00000000-0000-0000-0000-000000000001 playerGEID=900000000001 sessionId="00000000000000000000000000000000" [Team_Network]',
  '<2026-09-28T07:03:29.500Z> [Notice] <RequestLocationInventory> Player[TestPilot] requested inventory for Location[RR_P5_L2] [Inventory]',
  '<2026-09-28T08:43:26.144Z> [Notice] <Recv Bind Batch End Player> Bind Batch End enabled player in batch 7806 ViewName="Replicant 203.0.113.20:64295" connection={3, 0} node_id=00000000-0000-0000-0000-000000000001 playerGEID=900000000001 sessionId="00000000000000000000000000000000" [Team_Network]'
];

function request (port, method, reqPath, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let buf = ''; res.on('data', (c) => { buf += c; });
      res.on('end', () => { let b = buf; if (/json/.test(res.headers['content-type'] || '')) { try { b = JSON.parse(buf); } catch (_) {} } resolve({ status: res.statusCode, body: b }); });
    });
    req.on('error', reject); if (payload) req.write(JSON.stringify(payload)); req.end();
  });
}

function sandbox () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-shard-'));
  const logDir = path.join(dir, 'LIVE');
  fs.mkdirSync(logDir);
  const file = path.join(logDir, 'Game.log');
  fs.writeFileSync(file, LINES.join('\n') + '\n');
  return { dir, logDir, file };
}

function relay (sb, shard) {
  return new LiveRelay({
    port: 0, logfile: sb.file, seed: null, missions: { enable: false }, fabric: { enable: false },
    reparse: { dirs: [sb.logDir] }, shard
  });
}

test('off by default: no store, no file, routes answer 503, lines are ignored', async () => {
  const sb = sandbox();
  const svc = relay(sb, undefined);
  await svc.start();
  const port = svc.server.address().port;
  try {
    assert.strictEqual(svc.shardCapture, null);
    for (const line of LINES) svc.handleLogChange(line);
    assert.strictEqual(svc.shardCapture, null);
    const r = await request(port, 'GET', `${BASE}/shard`);
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.body.enabled, false);
    assert.strictEqual((await request(port, 'POST', `${BASE}/shard/rescan`, { all: true })).status, 503);
    assert.deepStrictEqual((await request(port, 'GET', `${BASE}/monitor?limit=1`)).body.shard, { enabled: false });
  } finally {
    await svc.stop();
    assert.ok(!fs.existsSync(path.join(sb.dir, 'shard-capture.json')), 'nothing written when off');
    fs.rmSync(sb.dir, { recursive: true, force: true });
  }
});

test('enabled: live lines are captured, routes serve them, store persists across restart', async () => {
  const sb = sandbox();
  const file = path.join(sb.dir, 'shard-capture.json');
  let svc = relay(sb, { enable: true, file });
  await svc.start();
  let port = svc.server.address().port;
  try {
    const seen = [];
    svc.on('shard:join', (r) => seen.push('join:' + r.shardId));
    svc.on('shard:handoff', (r) => seen.push('handoff:' + r.place));
    for (const line of LINES) svc.handleLogChange(line);
    assert.deepStrictEqual(seen, ['join:pub_use1b_12660092_010', 'handoff:RR_P5_L2']);
    const status = await request(port, 'GET', `${BASE}/shard`);
    assert.strictEqual(status.status, 200);
    assert.strictEqual(status.body.current.shard.id, 'pub_use1b_12660092_010');
    assert.deepStrictEqual(status.body.counts, { joins: 1, handoffs: 1, authority: 0 });
    assert.strictEqual((await request(port, 'GET', `${BASE}/monitor?limit=1`)).body.shard.shardId, 'pub_use1b_12660092_010');
    // A whole-file rescan lands on the same records.
    const scan = await request(port, 'POST', `${BASE}/shard/rescan`, { path: sb.file });
    assert.strictEqual(scan.body.added, 0);
    assert.strictEqual(scan.body.skippedDuplicates, 2);
    // Records never carry handle / GEID / session id.
    const ev = await request(port, 'GET', `${BASE}/shard/events?kind=handoffs`);
    const json = JSON.stringify(ev.body);
    assert.ok(!json.includes('TestPilot') && !json.includes('900000000001') && !json.includes('sessionId'));
  } finally { await svc.stop(); }
  try {
    assert.ok(fs.existsSync(file), 'flushed on stop');
    svc = relay(sb, { enable: true, file });
    await svc.start();
    port = svc.server.address().port;
    assert.deepStrictEqual((await request(port, 'GET', `${BASE}/shard`)).body.counts, { joins: 1, handoffs: 1, authority: 0 });
  } finally {
    await svc.stop();
    fs.rmSync(sb.dir, { recursive: true, force: true });
  }
});
