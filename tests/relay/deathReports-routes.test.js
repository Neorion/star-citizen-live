'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LiveRelay = require('../../services/LiveRelay');

const BASE = '/services/star-citizen';
// Real Game.log slice, build 12660092 (2026-09-27), scrubbed of identifiers.
const FIXTURE = path.join(__dirname, 'fixtures', 'death-fatal-collision-pilot.log');

function request (port, method, reqPath, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let body = buf;
        if (/json/.test(res.headers['content-type'] || '')) { try { body = JSON.parse(buf); } catch (_) { /* raw */ } }
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    if (payload) req.write(JSON.stringify(payload));
    req.end();
  });
}

/** A temp "install": the fixture as Game.log, plus a durable settings dir. */
function sandbox () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-death-'));
  const logDir = path.join(dir, 'LIVE');
  fs.mkdirSync(logDir);
  const file = path.join(logDir, 'Game.log');
  fs.copyFileSync(FIXTURE, file);
  return { dir, logDir, file, settingsDir: path.join(dir, 'store') };
}

function relay (sb, extra = {}) {
  return new LiveRelay(Object.assign({
    port: 0,
    logfile: sb.file,
    seed: null,
    missions: { enable: false },
    fabric: { enable: false },
    reparse: { dirs: [sb.logDir] },
    deathReportsFile: path.join(sb.dir, 'death-reports.json')
  }, extra));
}

test('rescan builds the death report; list, detail and exports serve it', async () => {
  const sb = sandbox();
  const svc = relay(sb);
  await svc.start();
  const port = svc.server.address().port;
  try {
    const empty = await request(port, 'GET', `${BASE}/deathreports`);
    assert.strictEqual(empty.status, 200);
    assert.strictEqual(empty.body.total, 0);

    const scan = await request(port, 'POST', `${BASE}/deathreports/rescan`, { path: sb.file });
    assert.strictEqual(scan.status, 200);
    assert.strictEqual(scan.body.type, 'DeathReportRescan');
    assert.strictEqual(scan.body.created, 1);
    assert.strictEqual(scan.body.skippedDuplicates, 0);
    assert.strictEqual(scan.body.lines, 625);

    // Idempotent: the same file again creates nothing.
    const again = await request(port, 'POST', `${BASE}/deathreports/rescan`, { path: sb.file });
    assert.strictEqual(again.body.created, 0);
    assert.strictEqual(again.body.skippedDuplicates, 1);
    const all = await request(port, 'POST', `${BASE}/deathreports/rescan`, { all: true });
    assert.strictEqual(all.body.created, 0);

    const list = await request(port, 'GET', `${BASE}/deathreports?limit=10`);
    assert.strictEqual(list.body.type, 'Collection');
    assert.strictEqual(list.body.total, 1);
    const row = list.body.data[0];
    assert.strictEqual(row.status, 'confirmed');
    assert.strictEqual(row.cause, 'vehicle_collision_pilot');
    assert.strictEqual(row.zoneName, 'Pyro IV');
    assert.strictEqual(row.vehicleName, 'Anvil Asgard');
    assert.strictEqual(row.itemsLost, 38);
    assert.strictEqual(row.items, undefined, 'list rows stay compact');

    // Bare mount works too (dual-mounted route).
    const bare = await request(port, 'GET', '/deathreports');
    assert.strictEqual(bare.body.total, 1);

    // Filters.
    assert.strictEqual((await request(port, 'GET', `${BASE}/deathreports?cause=unknown`)).body.total, 0);
    assert.strictEqual((await request(port, 'GET', `${BASE}/deathreports?status=confirmed`)).body.total, 1);

    const detail = await request(port, 'GET', `${BASE}/deathreports/${row.id}`);
    assert.strictEqual(detail.status, 200);
    assert.strictEqual(detail.body.type, 'DeathReport');
    assert.strictEqual(detail.body.data.items.length, 45);
    assert.strictEqual(detail.body.data.lineBasis, 'file');
    assert.strictEqual(detail.body.data.lineStart, 184);
    assert.strictEqual(detail.body.data.logFile, 'Game.log', 'basename only — no directory path');
    assert.ok(!JSON.stringify(detail.body.data).includes(sb.dir), 'no filesystem path in the report');

    const md = await request(port, 'GET', `${BASE}/deathreports/${row.id}/export?format=md`);
    assert.strictEqual(md.status, 200);
    assert.match(md.headers['content-type'], /text\/markdown/);
    assert.match(md.headers['content-disposition'], /attachment; filename="death-report-[0-9a-f]{8}\.md"/);
    assert.match(md.body, /^# Death report — confirmed/);
    assert.match(md.body, /Crashed Anvil Asgard tail-first into terrain on Pyro IV/);
    assert.match(md.body, /Gear left on corpse \(38\)/);

    const json = await request(port, 'GET', `${BASE}/deathreports/${row.id}/export?format=json`);
    assert.strictEqual(json.body.id, row.id);
    const bad = await request(port, 'GET', `${BASE}/deathreports/${row.id}/export?format=pdf`);
    assert.strictEqual(bad.status, 400);

    // Monitor carries the newest confirmed death for the dashboard toast.
    const mon = await request(port, 'GET', `${BASE}/monitor?limit=5`);
    assert.strictEqual(mon.body.deathReports.total, 1);
    assert.strictEqual(mon.body.deathReports.latest.id, row.id);
  } finally {
    await svc.stop();
    fs.rmSync(sb.dir, { recursive: true, force: true });
  }
});

test('rescan refuses paths that are not known log files', async () => {
  const sb = sandbox();
  const svc = relay(sb);
  await svc.start();
  const port = svc.server.address().port;
  try {
    const outside = path.join(sb.dir, 'notes.txt');
    fs.writeFileSync(outside, 'not a log');
    const res = await request(port, 'POST', `${BASE}/deathreports/rescan`, { path: outside });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /not a known log file/);
    const none = await request(port, 'POST', `${BASE}/deathreports/rescan`, {});
    assert.strictEqual(none.status, 400);
  } finally {
    await svc.stop();
    fs.rmSync(sb.dir, { recursive: true, force: true });
  }
});

test('reports persist across restarts and can be deleted', async () => {
  const sb = sandbox();
  let svc = relay(sb);
  await svc.start();
  let port = svc.server.address().port;
  let id;
  try {
    await request(port, 'POST', `${BASE}/deathreports/rescan`, { path: sb.file });
    id = (await request(port, 'GET', `${BASE}/deathreports`)).body.data[0].id;
  } finally { await svc.stop(); }
  try {
    assert.ok(fs.existsSync(path.join(sb.dir, 'death-reports.json')), 'flushed on stop');
    svc = relay(sb);
    await svc.start();
    port = svc.server.address().port;
    assert.strictEqual((await request(port, 'GET', `${BASE}/deathreports`)).body.total, 1);

    const del = await request(port, 'DELETE', `${BASE}/deathreports/${id}`);
    assert.strictEqual(del.status, 200);
    assert.strictEqual((await request(port, 'GET', `${BASE}/deathreports/${id}`)).status, 404);
    assert.strictEqual((await request(port, 'DELETE', `${BASE}/deathreports/${id}`)).status, 404);
    assert.strictEqual((await request(port, 'GET', `${BASE}/deathreports`)).body.total, 0);
  } finally {
    await svc.stop();
    fs.rmSync(sb.dir, { recursive: true, force: true });
  }
});

test('live lines build the same report and emit opened -> confirmed -> closed', async () => {
  const sb = sandbox();
  const svc = relay(sb);
  const phases = [];
  svc.on('death:report', (e) => phases.push(e.phase));
  try {
    const lines = fs.readFileSync(FIXTURE, 'utf8').split(/\r?\n/).filter((l) => l.trim());
    for (const line of lines) svc.handleLogChange(line);
    assert.deepStrictEqual(phases, ['opened', 'confirmed', 'closed']);
    assert.strictEqual(svc.deathReports.reports.length, 1);
    const live = svc.deathReports.reports[0];
    assert.strictEqual(live.status, 'confirmed');
    assert.strictEqual(live.lineBasis, 'stream');
    assert.strictEqual(live.items.length, 45);
    // The existing cumulative death count is untouched by the report feature.
    assert.strictEqual(svc.deaths.length, 1);

    // A later full rescan lands on the same record instead of duplicating it.
    const result = await svc._rescanDeathReports([sb.file]);
    assert.strictEqual(result.created, 0);
    assert.strictEqual(svc.deathReports.reports.length, 1);
  } finally {
    if (svc._deathReportsFlushTimer) clearTimeout(svc._deathReportsFlushTimer);
    if (svc._historyFlushTimer) clearTimeout(svc._historyFlushTimer);
    fs.rmSync(sb.dir, { recursive: true, force: true });
  }
});

test('death reports never enter shared history or the activity tree', async () => {
  const sb = sandbox();
  const svc = relay(sb);
  try {
    const lines = fs.readFileSync(FIXTURE, 'utf8').split(/\r?\n/).filter((l) => l.trim());
    for (const line of lines) svc.handleLogChange(line);
    assert.strictEqual(svc.deathReports.reports.length, 1);
    const history = JSON.stringify(svc.history);
    assert.ok(!history.includes('qrt_utility_heavy'), 'no gear manifest in cumulative history');
    assert.ok(!history.includes('deathreport'), 'no report rows in cumulative history');
    assert.strictEqual(svc.history.deathReports, undefined);
  } finally {
    if (svc._deathReportsFlushTimer) clearTimeout(svc._deathReportsFlushTimer);
    if (svc._historyFlushTimer) clearTimeout(svc._historyFlushTimer);
    fs.rmSync(sb.dir, { recursive: true, force: true });
  }
});
