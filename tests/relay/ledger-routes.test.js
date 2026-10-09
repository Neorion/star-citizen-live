'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LiveRelay = require('../../services/LiveRelay');

const BASE = '/services/star-citizen';

// Real captured line shapes (feature brief §2/§9); handle and player/shop/kiosk ids replaced.
const LINES = [
  '<2026-09-06T08:03:29.500Z> [Notice] <RequestLocationInventory> Player[TestPilot] requested inventory for Location[Pyro5d_Outpost_col_xs_dpt_otlw_001] [Inventory]',
  '<2026-09-06T08:03:31.495Z> [Notice] <CEntityComponentCommodityUIProvider::SendCommodityBuyRequest> Sending SShopCommodityBuyRequest - playerId[900000000001] shopId[900000000002] shopName[SCShop_Trdpst_Warehouse_OTLW_Int_B] kioskId[900000000003] price[2523136.000000] shopPricePerCentiSCU[98.559998] resourceGUID[7f72bf18-3334-4e60-837d-d51d9fa745cd] autoLoading[0] quantity[25600.000000 cSCU] Cargo Box Data: boxSize[8.000000] | unitAmount[32] [Team_CoreGameplayFeatures][Shops][UI]',
  '<2026-09-06T08:03:32.100Z> [Notice] <CEntityComponentShopUIProvider::RmShopFlowResponse> Received ShopFlowResponse - playerId[900000000001] shopId[900000000002] shopName[SCShop_Trdpst_Warehouse_OTLW_Int_B] kioskId[900000000003] kioskState[BuyRequestProcessing] result[Success] type[Buying]'
];

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

function sandbox () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-ledger-'));
  const logDir = path.join(dir, 'LIVE');
  fs.mkdirSync(logDir);
  const file = path.join(logDir, 'Game.log');
  fs.writeFileSync(file, LINES.join('\n') + '\n');
  return { dir, logDir, file };
}

function relay (sb) {
  return new LiveRelay({
    port: 0,
    logfile: sb.file,
    seed: null,
    missions: { enable: false },
    fabric: { enable: false },
    reparse: { dirs: [sb.logDir] },
    ledgerFile: path.join(sb.dir, 'ledger.json')
  });
}

test('ledger routes are mounted on the relay; ingest persists across restarts', async () => {
  const sb = sandbox();
  let svc = relay(sb);
  await svc.start();
  let port = svc.server.address().port;
  try {
    assert.strictEqual((await request(port, 'GET', `${BASE}/ledger`)).body.total, 0);
    const ing = await request(port, 'POST', `${BASE}/ledger/ingest`, { path: sb.file });
    assert.strictEqual(ing.status, 200);
    assert.strictEqual(ing.body.transactionsAdded, 1);
    const rows = await request(port, 'GET', `${BASE}/ledger`);
    assert.strictEqual(rows.body.total, 1);
    assert.strictEqual(rows.body.data[0].locationDisplay, 'FEO Canyon Depot, Fairo (Pyro V d)');
    assert.strictEqual((await request(port, 'GET', `${BASE}/ledger/summary`)).body.spend, 2523136);
    assert.match((await request(port, 'GET', `${BASE}/ledger/export.csv`)).headers['content-type'], /text\/csv/);
    const mon = await request(port, 'GET', `${BASE}/monitor?limit=1`);
    assert.strictEqual(mon.body.ledger.transactions, 1);
    assert.strictEqual((await request(port, 'POST', `${BASE}/ledger/ingest`, { path: path.join(sb.dir, 'nope.log') })).status, 400);
  } finally { await svc.stop(); }
  try {
    assert.ok(fs.existsSync(path.join(sb.dir, 'ledger.json')), 'ledger persisted beside the store');
    svc = relay(sb);
    await svc.start();
    port = svc.server.address().port;
    assert.strictEqual((await request(port, 'GET', `${BASE}/ledger`)).body.total, 1);
  } finally {
    await svc.stop();
    fs.rmSync(sb.dir, { recursive: true, force: true });
  }
});

test('live lines feed the ledger through handleLogChange', () => {
  const sb = sandbox();
  const svc = relay(sb);
  try {
    for (const line of LINES) svc.handleLogChange(line);
    assert.strictEqual(svc.ledger.all().length, 1);
    assert.strictEqual(svc.ledger.all()[0].result, 'Success');
    // Ledger rows never enter cumulative history (shared with peers).
    assert.ok(!JSON.stringify(svc.history).includes('SCShop_Trdpst'));
  } finally {
    if (svc._historyFlushTimer) clearTimeout(svc._historyFlushTimer);
    fs.rmSync(sb.dir, { recursive: true, force: true });
  }
});
