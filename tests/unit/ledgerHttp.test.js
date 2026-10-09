'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { TransactionLedger } = require('../../services/TransactionLedger');
const { tryHandleLedger } = require('../../functions/ledgerHttp');

const BASE = '/services/star-citizen';

// Real captured line shapes (feature brief §2/§9); handle and player/shop/kiosk ids replaced.
const LOC_LINE = '<2026-09-06T08:03:29.500Z> [Notice] <RequestLocationInventory> Player[TestPilot] requested inventory for Location[Pyro5d_Outpost_col_xs_dpt_otlw_001] [Inventory]';
const BUY_LINE = '<2026-09-06T08:03:31.495Z> [Notice] <CEntityComponentCommodityUIProvider::SendCommodityBuyRequest> Sending SShopCommodityBuyRequest - playerId[900000000001] shopId[900000000002] shopName[SCShop_Trdpst_Warehouse_OTLW_Int_B] kioskId[900000000003] price[2523136.000000] shopPricePerCentiSCU[98.559998] resourceGUID[7f72bf18-3334-4e60-837d-d51d9fa745cd] autoLoading[0] quantity[25600.000000 cSCU] Cargo Box Data: boxSize[8.000000] | unitAmount[32] [Team_CoreGameplayFeatures][Shops][UI]';
const OK_LINE = '<2026-09-06T08:03:32.100Z> [Notice] <CEntityComponentShopUIProvider::RmShopFlowResponse> Received ShopFlowResponse - playerId[900000000001] shopId[900000000002] shopName[SCShop_Trdpst_Warehouse_OTLW_Int_B] kioskId[900000000003] kioskState[BuyRequestProcessing] result[Success] type[Buying]';

function tmpLog () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-ledger-http-'));
  const file = path.join(dir, 'Game.log');
  fs.writeFileSync(file, [LOC_LINE, BUY_LINE, OK_LINE].join('\n') + '\n');
  return { dir, file };
}

/** Mount the ledger routes on a bare http server — the same module LiveRelay mounts. */
async function mount (knownFiles, overrides = {}) {
  const ledger = new TransactionLedger({ file: null });
  const host = Object.assign({
    ledger,
    hosted: false,
    requireSession: () => true,
    needsAuth: () => false,
    knownLogFiles: () => knownFiles
  }, overrides);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const body = async () => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    };
    const handled = await tryHandleLedger(host, req, res, { pathname: url.pathname, url, base: BASE, send, body });
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
  return { ledger, request, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('ingest -> rows -> summary -> stats -> csv -> correction over HTTP', async () => {
  const { dir, file } = tmpLog();
  const app = await mount([file]);
  try {
    assert.deepStrictEqual((await app.request('GET', `${BASE}/ledger`)).body, { type: 'Collection', total: 0, data: [] });

    const ing = await app.request('POST', `${BASE}/ledger/ingest`, { path: file });
    assert.strictEqual(ing.status, 200);
    assert.strictEqual(ing.body.type, 'LedgerIngest');
    assert.strictEqual(ing.body.transactionsAdded, 1);
    assert.strictEqual(ing.body.transactions, 1);

    // Idempotent per file: the unchanged file is skipped.
    const again = await app.request('POST', `${BASE}/ledger/ingest`, { all: true });
    assert.strictEqual(again.body.filesSkippedUnchanged, 1);
    assert.strictEqual(again.body.transactionsAdded, 0);

    const rows = await app.request('GET', `${BASE}/ledger`);
    assert.strictEqual(rows.body.total, 1);
    const row = rows.body.data[0];
    assert.strictEqual(row.direction, 'spend');
    assert.strictEqual(row.amountAuec, 2523136);
    assert.strictEqual(row.locationDisplay, 'FEO Canyon Depot, Fairo (Pyro V d)');
    assert.strictEqual(row.locationConfidence, 'exact');
    assert.strictEqual((await app.request('GET', '/ledger')).body.total, 1, 'dual-mounted');
    assert.strictEqual((await app.request('GET', `${BASE}/ledger?direction=income`)).body.total, 0);
    assert.strictEqual((await app.request('GET', `${BASE}/ledger?system=Pyro`)).body.total, 1);

    const sum = await app.request('GET', `${BASE}/ledger/summary`);
    assert.strictEqual(sum.body.type, 'LedgerSummary');
    assert.strictEqual(sum.body.spend, 2523136);
    assert.strictEqual(sum.body.net, -2523136);
    assert.strictEqual(sum.body.bySystem.Pyro, -2523136);

    const stats = await app.request('GET', `${BASE}/ledger/stats`);
    assert.strictEqual(stats.body.filesIngested, 1);

    const csv = await app.request('GET', `${BASE}/ledger/export.csv`);
    assert.strictEqual(csv.status, 200);
    assert.match(csv.headers['content-type'], /text\/csv/);
    assert.match(csv.headers['content-disposition'], /ledger\.csv/);
    assert.match(csv.body, /^id,utcTs,sessionFile/);
    assert.match(csv.body, /FEO Canyon Depot/);

    const fix = await app.request('POST', `${BASE}/ledger/action`, { action: 'learnLocation', id: row.locationId, display: 'Corrected Depot' });
    assert.strictEqual(fix.status, 200);
    assert.strictEqual((await app.request('GET', `${BASE}/ledger`)).body.data[0].locationDisplay, 'Corrected Depot');
    assert.strictEqual((await app.request('POST', `${BASE}/ledger/action`, { action: 'nope', id: 'x', display: 'y' })).status, 400);
    assert.strictEqual((await app.request('POST', `${BASE}/ledger/action`, { action: 'learnItem', id: '', display: 'y' })).status, 400);
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ingest only reads files the node already knows as logs', async () => {
  const { dir, file } = tmpLog();
  const outside = path.join(dir, 'notes.txt');
  fs.writeFileSync(outside, 'not a log');
  const app = await mount([file]);
  try {
    const res = await app.request('POST', `${BASE}/ledger/ingest`, { path: outside });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /not a known log file/);
    assert.strictEqual((await app.request('POST', `${BASE}/ledger/ingest`, {})).status, 400);
    assert.strictEqual(app.ledger.all().length, 0);
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hosted mode refuses ingest; unauthenticated remote callers cannot read or mutate', async () => {
  const { dir, file } = tmpLog();
  const hosted = await mount([file], { hosted: true });
  try {
    const res = await hosted.request('POST', `${BASE}/ledger/ingest`, { all: true });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /local-player operation/);
  } finally { await hosted.close(); }

  const locked = await mount([file], {
    requireSession: (req, send) => { send(401, { error: 'Authentication required' }); return false; },
    needsAuth: () => true
  });
  try {
    for (const p of ['/ledger', '/ledger/summary', '/ledger/stats', '/ledger/export.csv']) {
      assert.strictEqual((await locked.request('GET', `${BASE}${p}`)).status, 401, p);
    }
    assert.strictEqual((await locked.request('POST', `${BASE}/ledger/ingest`, { all: true })).status, 401);
    assert.strictEqual((await locked.request('POST', `${BASE}/ledger/action`, { action: 'learnItem', id: 'a', display: 'b' })).status, 401);
  } finally {
    await locked.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unrelated paths fall through to the next handler', async () => {
  const app = await mount([]);
  try {
    assert.strictEqual((await app.request('GET', `${BASE}/analytics`)).body.error, 'unhandled');
    assert.strictEqual((await app.request('PUT', `${BASE}/ledger`)).body.error, 'unhandled');
  } finally { await app.close(); }
});
