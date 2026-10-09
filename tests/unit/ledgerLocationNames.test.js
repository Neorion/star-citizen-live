'use strict';

const test = require('node:test');
const assert = require('node:assert');

const catalog = require('../../functions/locationCatalog');
const { resolveFromCatalog } = require('../../functions/ledgerLocationNames');
const { TransactionLedger } = require('../../services/TransactionLedger');

// Id shapes as they appear in real RequestLocationInventory lines (place ids, not personal data).

test('Lagrange R&R station ids resolve exactly from the wiki catalog', () => {
  const r = resolveFromCatalog('RR_ARC_L1', catalog);
  assert.strictEqual(r.confidence, 'exact');
  assert.strictEqual(r.display, 'ARC-L1 Wide Forest Station');
  assert.strictEqual(r.system, 'Stanton');
  assert.strictEqual(resolveFromCatalog('RR_MIC_L5', catalog).display, 'MIC-L5 Modern Icarus Station');
  assert.strictEqual(resolveFromCatalog('rr_hur_l2', catalog).display, 'HUR-L2 Faithful Dream Station', 'case-insensitive');
});

test('landing-zone ids resolve exactly', () => {
  assert.deepStrictEqual(resolveFromCatalog('Stanton2_Orison', catalog).display, 'Orison');
  assert.strictEqual(resolveFromCatalog('Stanton3_Area18', catalog).confidence, 'exact');
});

test('low-orbit and jump-point ids list real candidates as inferred, never a single guess', () => {
  const leo = resolveFromCatalog('RR_HUR_LEO', catalog);
  assert.strictEqual(leo.confidence, 'inferred');
  assert.ok(leo.candidates.some((c) => /Everus Harbor/.test(c)));
  assert.ok(!leo.candidates.some((c) => /Comm Array|Relay|Probe/.test(c)), 'objects that cannot host a kiosk are not offered');
  assert.match(leo.display, /\(unconfirmed\)$/);
  const jp = resolveFromCatalog('RR_JP_NyxPyro', catalog);
  assert.strictEqual(jp.confidence, 'inferred');
  assert.deepStrictEqual(jp.candidates.slice().sort(), ['Nyx Gateway (Pyro)', 'Pyro Gateway (Nyx)']);
});

test('ids the catalog cannot name stay null (the ledger then shows the raw id)', () => {
  assert.strictEqual(resolveFromCatalog('RR_P1_L1', catalog), null);
  assert.strictEqual(resolveFromCatalog('AsteroidClusterBase_Nyx_Social_Keeger_1', catalog), null);
  assert.strictEqual(resolveFromCatalog('', catalog), null);
  assert.strictEqual(resolveFromCatalog('RR_ARC_L1', null), null);
});

test('TransactionLedger uses the fallback only when the seed is unresolved, and labels the source', () => {
  const ledger = new TransactionLedger({ file: null, resolveLocationFallback: (id) => resolveFromCatalog(id, catalog) });
  const lines = (locId) => [
    `<2026-09-06T08:03:29.500Z> [Notice] <RequestLocationInventory> Player[TestPilot] requested inventory for Location[${locId}] [Inventory]`,
    '<2026-09-06T08:03:31.495Z> [Notice] <CEntityComponentShopUIProvider::SendShopBuyRequest> Sending SShopBuyRequest - playerId[900000000001] shopId[900000000002] shopName[SCShop_Armor_Core] kioskId[900000000003] price[1200.000000] currencyType[UEC] itemClassGUID[core_test_01] itemName[core_test_01] quantity[1] [Team_CoreGameplayFeatures][Shops][UI]',
    '<2026-09-06T08:03:32.100Z> [Notice] <CEntityComponentShopUIProvider::RmShopFlowResponse> Received ShopFlowResponse - playerId[900000000001] shopId[900000000002] shopName[SCShop_Armor_Core] kioskId[900000000003] kioskState[BuyRequestProcessing] result[Success] type[Buying]'
  ];
  for (const l of lines('RR_ARC_L1')) ledger.observe(l);
  const station = ledger.all()[0];
  assert.strictEqual(station.locationDisplay, 'ARC-L1 Wide Forest Station');
  assert.strictEqual(station.locationConfidence, 'exact');
  assert.strictEqual(station.locationSource, 'catalog');

  // Seed wins over the catalog when it knows the id.
  for (const l of lines('Pyro5d_Outpost_col_xs_dpt_otlw_001').map((x) => x.replace('08:03:3', '09:03:3'))) ledger.observe(l);
  const seeded = ledger.all().find((r) => r.locationId === 'Pyro5d_Outpost_col_xs_dpt_otlw_001');
  assert.strictEqual(seeded.locationDisplay, 'FEO Canyon Depot, Fairo (Pyro V d)');
  assert.strictEqual(seeded.locationSource, 'seed');

  // Operator correction wins over both.
  ledger.learnLocation('RR_ARC_L1', 'My usual armour shop');
  assert.strictEqual(ledger.all()[0].locationDisplay, 'My usual armour shop');
  assert.strictEqual(ledger.all()[0].locationSource, 'operator');
});
