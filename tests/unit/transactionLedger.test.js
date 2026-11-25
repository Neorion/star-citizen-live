'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  TransactionLedger, parseLedgerLine, decodeLocationId, resolveLocation, resolveItem, extractTokens, parseQuantity
} = require('../../services/TransactionLedger');

// Real captured lines from the feature brief, identifiers replaced (handle, player/shop/kiosk ids) (Game.log Transaction Ledger,
// drafted 2026-09-11, §2/§9) — the only ones marked `verified:true` below.
const LOC_LINE = '<2026-09-06T08:03:29.500Z> [Notice] <RequestLocationInventory> Player[TestPilot] requested inventory for Location[Pyro5d_Outpost_col_xs_dpt_otlw_001] [Inventory]';
const BUY_COMMODITY_LINE = '<2026-09-06T08:03:31.495Z> [Notice] <CEntityComponentCommodityUIProvider::SendCommodityBuyRequest> Sending SShopCommodityBuyRequest - playerId[900000000001] shopId[900000000002] shopName[SCShop_Trdpst_Warehouse_OTLW_Int_B] kioskId[900000000003] price[2523136.000000] shopPricePerCentiSCU[98.559998] resourceGUID[7f72bf18-3334-4e60-837d-d51d9fa745cd] autoLoading[0] quantity[25600.000000 cSCU] Cargo Box Data: boxSize[8.000000] | unitAmount[32] [Team_CoreGameplayFeatures][Shops][UI]';
const RESPONSE_SUCCESS_LINE = '<2026-09-06T08:03:32.100Z> [Notice] <CEntityComponentShopUIProvider::RmShopFlowResponse> Received ShopFlowResponse - playerId[900000000001] shopId[900000000002] shopName[SCShop_Trdpst_Warehouse_OTLW_Int_B] kioskId[900000000003] kioskState[BuyRequestProcessing] result[Success] type[Buying]';
const RESPONSE_FAILED_LINE = RESPONSE_SUCCESS_LINE.replace('result[Success]', 'result[Failed]');

// --- pure helpers ----------------------------------------------------------

test('extractTokens pulls every key[value] pair regardless of separator', () => {
  const t = extractTokens('shopId[123] price[45.6] Cargo Box Data: boxSize[8.0] | unitAmount[32]');
  assert.strictEqual(t.shopId, '123');
  assert.strictEqual(t.price, '45.6');
  assert.strictEqual(t.boxSize, '8.0');
  assert.strictEqual(t.unitAmount, '32');
});

test('parseQuantity splits a numeric value from its unit suffix', () => {
  assert.deepStrictEqual(parseQuantity('25600.000000 cSCU'), { value: 25600, unit: 'cSCU' });
  assert.deepStrictEqual(parseQuantity('12'), { value: 12, unit: null });
  assert.deepStrictEqual(parseQuantity(null), { value: null, unit: null });
});

test('decodeLocationId parses the brief\'s grammar', () => {
  const d = decodeLocationId('Pyro5d_Outpost_col_xs_dpt_otlw_001');
  assert.strictEqual(d.bodyToken, 'Pyro5d');
  assert.strictEqual(d.system, 'Pyro');
  assert.strictEqual(d.planet, 'V');
  assert.strictEqual(d.moon, 'd');
  assert.strictEqual(d.function, 'dpt');
  assert.strictEqual(d.faction, 'otlw');
  assert.strictEqual(d.instance, '001');
});

test('decodeLocationId returns null for an id that does not match the grammar', () => {
  assert.strictEqual(decodeLocationId('not_a_location_id'), null);
});

// --- resolution [feature brief §4.1 acceptance criteria] -------------------

const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'ledger', 'locations-seed.json'), 'utf8'));
const ITEM_SEED = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'ledger', 'items-seed.json'), 'utf8'));

test('resolveLocation: a single seed match is exact', () => {
  const r = resolveLocation('Pyro5d_Outpost_col_xs_dpt_otlw_001', SEED);
  assert.strictEqual(r.confidence, 'exact');
  assert.strictEqual(r.display, 'FEO Canyon Depot, Fairo (Pyro V d)');
});

test('resolveLocation: multiple real candidates is inferred, never presented as fact', () => {
  const r = resolveLocation('Pyro5a_Outpost_col_m_trdpst_otlw_001', SEED);
  assert.strictEqual(r.confidence, 'inferred');
  assert.deepStrictEqual(r.candidates.sort(), ['Ashland', "Kabir's Post"].sort());
});

test('resolveLocation: no seed entry is unresolved with a reason, not a guess', () => {
  const r = resolveLocation('Pyro4_Outpost_col_m_scrp_indy_001', SEED);
  assert.strictEqual(r.confidence, 'unresolved');
  assert.strictEqual(r.display, null);
  assert.ok(r.reason);
});

test('resolveItem: seeded class resolves exactly; unknown falls back to the raw name', () => {
  assert.deepStrictEqual(resolveItem('crlf_consumable_healing_01', ITEM_SEED), { display: 'Hemozal', confidence: 'exact' });
  const unknown = resolveItem('some_unknown_class', ITEM_SEED);
  assert.strictEqual(unknown.display, 'some_unknown_class');
  assert.strictEqual(unknown.confidence, 'unresolved');
});

// --- line parsing ------------------------------------------------------------

test('parseLedgerLine: the worked commodity-buy example (verified real line)', () => {
  const ev = parseLedgerLine(BUY_COMMODITY_LINE);
  assert.strictEqual(ev.kind, 'buy_commodity');
  assert.strictEqual(ev.verified, true);
  assert.strictEqual(ev.amount, 2523136);
  assert.strictEqual(ev.unitPrice, 98.559998);
  assert.strictEqual(ev.resourceGuid, '7f72bf18-3334-4e60-837d-d51d9fa745cd');
  assert.strictEqual(ev.quantity, 25600);
  assert.strictEqual(ev.quantityUnit, 'cSCU');
  assert.strictEqual(ev.unitAmount, 32);
});

test('parseLedgerLine: RequestLocationInventory gives the location, not the shop archetype', () => {
  const ev = parseLedgerLine(LOC_LINE);
  assert.strictEqual(ev.kind, 'location_request');
  assert.strictEqual(ev.locationId, 'Pyro5d_Outpost_col_xs_dpt_otlw_001');
  assert.strictEqual(ev.player, 'TestPilot');
});

test('parseLedgerLine: RmShopFlowResponse carries the outcome', () => {
  const ev = parseLedgerLine(RESPONSE_SUCCESS_LINE);
  assert.strictEqual(ev.kind, 'shop_flow_response');
  assert.strictEqual(ev.result, 'Success');
});

test('parseLedgerLine: a line with no known tag is not a ledger event', () => {
  assert.strictEqual(parseLedgerLine('<2026-09-06T08:00:00.000Z> [Notice] <SomeOtherThing> nothing to see here'), null);
});

// --- correlation + resolution, end to end via observe() [in-memory] --------

test('observe(): location + buy request + Success response correlate into one resolved transaction', () => {
  const ledger = new TransactionLedger({ file: null });
  ledger.observe(LOC_LINE);
  ledger.observe(BUY_COMMODITY_LINE);
  ledger.observe(RESPONSE_SUCCESS_LINE);

  const rows = ledger.all();
  assert.strictEqual(rows.length, 1);
  const row = rows[0];
  assert.strictEqual(row.direction, 'spend');
  assert.strictEqual(row.amountAuec, 2523136);
  assert.strictEqual(row.result, 'Success');
  assert.strictEqual(row.locationId, 'Pyro5d_Outpost_col_xs_dpt_otlw_001');
  assert.strictEqual(row.locationDisplay, 'FEO Canyon Depot, Fairo (Pyro V d)');
  assert.strictEqual(row.locationConfidence, 'exact');
  assert.strictEqual(row.system, 'Pyro');
});

test('a non-Success response is still recorded but excluded from the default query/summary [§6.1]', () => {
  const ledger = new TransactionLedger({ file: null });
  ledger.observe(LOC_LINE);
  ledger.observe(BUY_COMMODITY_LINE);
  ledger.observe(RESPONSE_FAILED_LINE);

  assert.strictEqual(ledger.all().length, 1);
  assert.strictEqual(ledger.query().length, 0);                       // default: Success only
  assert.strictEqual(ledger.query({ includeNonSuccess: true }).length, 1);
  assert.strictEqual(ledger.summary().count, 0);
});

test('a request with no response ever is flushed as an explicit Unknown row, not dropped', () => {
  const ledger = new TransactionLedger({ file: null });
  ledger.observe(BUY_COMMODITY_LINE);
  ledger.flushPending();
  const rows = ledger.all();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].result, 'Unknown');
});

test('replaying the exact same sequence twice does not duplicate the row [idempotent]', () => {
  const ledger = new TransactionLedger({ file: null });
  for (let i = 0; i < 2; i++) {
    ledger.observe(LOC_LINE);
    ledger.observe(BUY_COMMODITY_LINE);
    ledger.observe(RESPONSE_SUCCESS_LINE);
  }
  assert.strictEqual(ledger.all().length, 1);
});

test('learnLocation persists an operator correction and re-applies it to existing rows', () => {
  const ledger = new TransactionLedger({ file: null });
  ledger.observe(LOC_LINE);
  ledger.observe(BUY_COMMODITY_LINE);
  ledger.observe(RESPONSE_SUCCESS_LINE);
  ledger.learnLocation('Pyro5d_Outpost_col_xs_dpt_otlw_001', 'Corrected Name');
  assert.strictEqual(ledger.all()[0].locationDisplay, 'Corrected Name');
  assert.strictEqual(ledger.all()[0].locationConfidence, 'exact');
});

test('toCSV round-trips every documented column [§7]', () => {
  const ledger = new TransactionLedger({ file: null });
  ledger.observe(LOC_LINE);
  ledger.observe(BUY_COMMODITY_LINE);
  ledger.observe(RESPONSE_SUCCESS_LINE);
  const csv = ledger.toCSV(ledger.all());
  const lines = csv.trim().split('\n');
  assert.strictEqual(lines.length, 2); // header + one row
  assert.match(lines[0], /^id,utcTs,sessionFile/);
  assert.match(lines[1], /2523136/);
  assert.match(lines[1], /FEO Canyon Depot/);
});

// --- file ingestion: streaming + idempotent cursor [§7 acceptance criteria] -

test('ingestFile is idempotent: re-ingesting an unchanged file adds nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
  const file = path.join(dir, 'Game.log');
  fs.writeFileSync(file, [LOC_LINE, BUY_COMMODITY_LINE, RESPONSE_SUCCESS_LINE].join('\n') + '\n');

  const storeFile = path.join(dir, 'ledger.json');
  const ledger = new TransactionLedger({ file: storeFile });

  const first = await ledger.ingestFile(file);
  assert.strictEqual(first.skipped, false);
  assert.strictEqual(ledger.all().length, 1);

  const second = await ledger.ingestFile(file);
  assert.strictEqual(second.skipped, true);
  assert.strictEqual(ledger.all().length, 1); // still one row, not two

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a fresh TransactionLedger reloads persisted transactions from disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
  const file = path.join(dir, 'Game.log');
  fs.writeFileSync(file, [LOC_LINE, BUY_COMMODITY_LINE, RESPONSE_SUCCESS_LINE].join('\n') + '\n');
  const storeFile = path.join(dir, 'ledger.json');

  const ledger1 = new TransactionLedger({ file: storeFile });
  await ledger1.ingestFile(file);

  const ledger2 = new TransactionLedger({ file: storeFile });
  assert.strictEqual(ledger2.all().length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

// --- hardening: ingest isolation, persistence, pending cap, prototype safety, CSV ---

test('a concurrent ingestFile never disturbs the live tail pairing or location', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
  const file = path.join(dir, 'Game.log');
  const OTHER_LOC = LOC_LINE.replace('Pyro5d_Outpost_col_xs_dpt_otlw_001', 'Stanton2_Orison');
  fs.writeFileSync(file, [OTHER_LOC, BUY_COMMODITY_LINE.replace('08:03:31.495', '07:00:00.000'), RESPONSE_SUCCESS_LINE].join('\n') + '\n');
  try {
    const ledger = new TransactionLedger({ file: null });
    const ingest = ledger.ingestFile(file); // starts streaming; resolves later
    ledger.observe(LOC_LINE);
    ledger.observe(BUY_COMMODITY_LINE);
    assert.strictEqual(ledger.stats().pendingUnpaired, 1, 'live pending is untouched by the ingest');
    ledger.observe(RESPONSE_SUCCESS_LINE);
    await ingest;
    const rows = ledger.all();
    assert.strictEqual(rows.length, 2);
    const live = rows.find((r) => r.sessionFile === 'live');
    const ing = rows.find((r) => r.sessionFile === 'Game.log');
    assert.strictEqual(live.locationId, 'Pyro5d_Outpost_col_xs_dpt_otlw_001');
    assert.strictEqual(live.result, 'Success');
    assert.strictEqual(ing.locationId, 'Stanton2_Orison');
    assert.strictEqual(ing.result, 'Success');
    assert.strictEqual(ledger.stats().pendingUnpaired, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('location does not carry over between ingested files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
  const a = path.join(dir, 'a.log');
  const b = path.join(dir, 'b.log');
  fs.writeFileSync(a, [LOC_LINE, BUY_COMMODITY_LINE, RESPONSE_SUCCESS_LINE].join('\n') + '\n');
  fs.writeFileSync(b, [BUY_COMMODITY_LINE.replace('08:03:31.495', '09:00:00.000'), RESPONSE_SUCCESS_LINE].join('\n') + '\n');
  try {
    const ledger = new TransactionLedger({ file: null });
    await ledger.ingestFile(a);
    await ledger.ingestFile(b);
    const rowB = ledger.all().find((r) => r.sessionFile === 'b.log');
    assert.strictEqual(rowB.locationId, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('persistence is atomic, debounced and flushable; in-memory mode has no timer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
  const storeFile = path.join(dir, 'ledger.json');
  try {
    const mem = new TransactionLedger({ file: null });
    mem.observe(LOC_LINE); mem.observe(BUY_COMMODITY_LINE); mem.observe(RESPONSE_SUCCESS_LINE);
    mem.learnLocation('x', 'y');
    assert.strictEqual(mem._flushTimer, null, 'no timer without a file');

    const ledger = new TransactionLedger({ file: storeFile });
    ledger.observe(LOC_LINE); ledger.observe(BUY_COMMODITY_LINE); ledger.observe(RESPONSE_SUCCESS_LINE);
    assert.strictEqual(fs.existsSync(storeFile), false, 'live commit is debounced, not written immediately');
    assert.ok(ledger._flushTimer, 'a debounce timer is pending');
    ledger.flush();
    assert.strictEqual(ledger._flushTimer, null);
    assert.strictEqual(fs.existsSync(`${storeFile}.tmp`), false, 'tmp file is renamed away');
    assert.strictEqual(Object.keys(JSON.parse(fs.readFileSync(storeFile, 'utf8')).transactions).length, 1);
    assert.strictEqual(new TransactionLedger({ file: storeFile }).all().length, 1);

    ledger.learnLocation('Pyro5d_Outpost_col_xs_dpt_otlw_001', 'Renamed');
    assert.ok(ledger._flushTimer, 'learnLocation schedules a flush');
    ledger.flush();
    assert.strictEqual(JSON.parse(fs.readFileSync(storeFile, 'utf8')).overrides.locations.Pyro5d_Outpost_col_xs_dpt_otlw_001, 'Renamed');
    ledger.flush(); // clean: no-op
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the live pending queue is capped at 200; the oldest becomes Unknown', () => {
  const ledger = new TransactionLedger({ file: null });
  for (let i = 0; i < 205; i++) {
    ledger.observe(BUY_COMMODITY_LINE.replace('08:03:31.495', `08:${String(i % 60).padStart(2, '0')}:${String(Math.floor(i / 60)).padStart(2, '0')}.000`).replace('price[2523136.000000]', `price[${1000 + i}.000000]`));
  }
  assert.strictEqual(ledger.stats().pendingUnpaired, 200);
  const unknown = ledger.query({ includeNonSuccess: true }).filter((r) => r.result === 'Unknown');
  assert.strictEqual(unknown.length, 5);
});

test('tokens like "constructor" are not treated as overrides, seeds or learned names', () => {
  const ledger = new TransactionLedger({ file: null });
  const row = { locationId: 'constructor', itemClass: 'toString', resourceGuid: 'hasOwnProperty' };
  ledger._resolveRow(row);
  assert.notStrictEqual(typeof row.locationDisplay, 'function');
  assert.notStrictEqual(typeof row.itemDisplay, 'function');
  assert.notStrictEqual(typeof row.resourceDisplay, 'function');
  assert.strictEqual(row.itemDisplay, 'toString');
  assert.strictEqual(resolveItem('constructor', ITEM_SEED).confidence, 'unresolved');
  assert.strictEqual(resolveLocation('Pyro5constructor_Outpost_col_xs_dpt_otlw_001', SEED).confidence, 'unresolved');
  const s = ledger.summary();
  assert.deepStrictEqual(s.bySystem, {});
});

test('toCSV prefixes formula-like strings but leaves numbers alone', () => {
  const ledger = new TransactionLedger({ file: null });
  const csv = ledger.toCSV([
    { id: '=1+1', buildId: '+cmd', kind: '-x', direction: '@sum', itemClass: '\tTab', itemDisplay: 'a\rb', amountAuec: -5, quantity: 3 },
    { id: 'plain', amountAuec: 10 }
  ]);
  const body = csv.split('\n').slice(1).join('\n');
  assert.ok(body.includes("'=1+1"));
  assert.ok(body.includes("'+cmd"));
  assert.ok(body.includes("'-x"));
  assert.ok(body.includes("'@sum"));
  assert.ok(body.includes("\"'\tTab\"") || body.includes("'\tTab"));
  assert.ok(body.includes('"a\rb"'), 'cell with CR is quoted');
  assert.ok(/(^|,)-5(,|$)/m.test(body), 'negative number is not prefixed');
  assert.ok(!body.includes("'-5"));
});
