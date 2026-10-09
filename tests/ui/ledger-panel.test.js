'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

require('../helpers/installReactStub');
const { textOf } = require('../helpers/reactTree');
const Ledger = require('../../components/Ledger');
const { TransactionLedger } = require('../../services/TransactionLedger');

// Real captured line shapes (feature brief §2/§9); handle and player/shop/kiosk ids replaced.
const LOC_LINE = '<2026-09-06T08:03:29.500Z> [Notice] <RequestLocationInventory> Player[TestPilot] requested inventory for Location[Pyro5d_Outpost_col_xs_dpt_otlw_001] [Inventory]';
const BUY_LINE = '<2026-09-06T08:03:31.495Z> [Notice] <CEntityComponentCommodityUIProvider::SendCommodityBuyRequest> Sending SShopCommodityBuyRequest - playerId[900000000001] shopId[900000000002] shopName[SCShop_Trdpst_Warehouse_OTLW_Int_B] kioskId[900000000003] price[2523136.000000] shopPricePerCentiSCU[98.559998] resourceGUID[7f72bf18-3334-4e60-837d-d51d9fa745cd] autoLoading[0] quantity[25600.000000 cSCU] Cargo Box Data: boxSize[8.000000] | unitAmount[32] [Team_CoreGameplayFeatures][Shops][UI]';
const OK_LINE = '<2026-09-06T08:03:32.100Z> [Notice] <CEntityComponentShopUIProvider::RmShopFlowResponse> Received ShopFlowResponse - playerId[900000000001] shopId[900000000002] shopName[SCShop_Trdpst_Warehouse_OTLW_Int_B] kioskId[900000000003] kioskState[BuyRequestProcessing] result[Success] type[Buying]';

function fixtureRows () {
  const ledger = new TransactionLedger({ file: null });
  for (const l of [LOC_LINE, BUY_LINE, OK_LINE]) ledger.observe(l);
  return { rows: ledger.all(), summary: ledger.summary() };
}

describe('Ledger UI', () => {
  it('renders spend/income totals and the resolved transaction row', () => {
    const { rows, summary } = fixtureRows();
    const panel = new Ledger({ rows, summary });
    panel.state.loading = false;
    const text = textOf(panel.render());
    assert.match(text, /Ledger/);
    assert.match(text, /Spent/);
    assert.match(text, /2,523,136 aUEC/);
    assert.match(text, /Bought commodity/);
    assert.match(text, /25,600 cSCU \(256 SCU\)/);
    assert.match(text, /FEO Canyon Depot, Fairo \(Pyro V d\)/);
    assert.match(text, /exact/);
    assert.match(text, /Success/);
    assert.doesNotMatch(text, /\bnull\b|undefined|NaN/);
  });

  it('shows an unresolved location as its raw id, never as a guessed name', () => {
    const { rows, summary } = fixtureRows();
    const row = Object.assign({}, rows[0], {
      locationId: 'Pyro4_Outpost_col_m_scrp_indy_001', locationDisplay: null, locationConfidence: 'unresolved'
    });
    const text = textOf(new Ledger({ rows: [row], summary }).render());
    assert.match(text, /Pyro4_Outpost_col_m_scrp_indy_001/);
    assert.match(text, /unresolved/);
    assert.match(text, /name it/, 'offers an operator correction');
  });

  it('flags rows whose log-line shape is not yet verified against a real log', () => {
    const { rows, summary } = fixtureRows();
    const row = Object.assign({}, rows[0], { kind: 'refinery_order', verified: false, resourceGuid: null, resourceDisplay: null });
    const text = textOf(new Ledger({ rows: [row], summary }).render());
    assert.match(text, /Refinery order/);
    assert.match(text, /unverified shape/);
    assert.match(text, /refinery work order/);
  });

  it('captions the ledger as inferred and explains the location confidence', () => {
    const panel = new Ledger({ rows: [], summary: { count: 0, spend: 0, income: 0, net: 0, bySystem: {} } });
    panel.state.loading = false;
    const text = textOf(panel.render());
    assert.match(text, /not officer-validated/);
    assert.match(text, /reusable archetype/);
    assert.match(text, /No transactions on record yet/);
  });

  it('fetches rows + summary and surfaces errors', async () => {
    const { rows, summary } = fixtureRows();
    const panel = new Ledger({});
    const prev = global.fetch;
    try {
      global.fetch = async (url) => {
        const u = String(url);
        if (u.endsWith('/ledger/summary')) return { ok: true, json: async () => summary };
        assert.ok(u.includes('/services/star-citizen/ledger'));
        return { ok: true, json: async () => ({ type: 'Collection', total: rows.length, data: rows }) };
      };
      await panel.fetchAll();
      assert.match(textOf(panel.render()), /FEO Canyon Depot/);
      global.fetch = async () => ({ ok: false, statusText: 'Unauthorized', json: async () => ({ error: 'Authentication required' }) });
      await panel.fetchAll();
      assert.strictEqual(panel.state.error, 'Authentication required');
    } finally {
      global.fetch = prev;
    }
  });

  it('sends the session token on scan and reports the result', async () => {
    const panel = new Ledger({ authToken: 'tok123' });
    const prev = global.fetch;
    const calls = [];
    try {
      global.fetch = async (url, opts = {}) => {
        calls.push({ url: String(url), opts });
        if (String(url).endsWith('/ledger/ingest')) {
          return { ok: true, json: async () => ({ type: 'LedgerIngest', filesFound: 3, filesScanned: 3, filesSkippedUnchanged: 1, transactionsAdded: 2, transactions: 7 }) };
        }
        if (String(url).endsWith('/ledger/summary')) return { ok: true, json: async () => ({ count: 0, spend: 0, income: 0, net: 0, bySystem: {} }) };
        return { ok: true, json: async () => ({ type: 'Collection', total: 0, data: [] }) };
      };
      await panel.ingest();
      assert.strictEqual(calls[0].opts.method, 'POST');
      assert.strictEqual(calls[0].opts.headers.Authorization, 'Bearer tok123');
      assert.deepStrictEqual(JSON.parse(calls[0].opts.body), { all: true });
      assert.match(textOf(panel.render()), /Scanned 3 log files \(1 unchanged\): 2 new transactions, 7 on record/);
    } finally {
      global.fetch = prev;
    }
  });
});
