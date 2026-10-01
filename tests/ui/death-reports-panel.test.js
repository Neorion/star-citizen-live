'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

require('../helpers/installReactStub');
const { textOf, findByClass } = require('../helpers/reactTree');
const DeathReports = require('../../components/DeathReports');
const { scanFile } = require('../../functions/deathReportStore');
const { listRow } = require('../../functions/deathReport');

// Real Game.log slice, build 12660092 (2026-09-27), scrubbed of identifiers.
const FIXTURE = path.join(__dirname, '..', 'relay', 'fixtures', 'death-fatal-collision-pilot.log');

async function fixtureReport () {
  const { reports } = await scanFile(FIXTURE);
  return Object.assign({}, reports[0], { lineBasis: 'file' });
}

describe('Death reports UI', () => {
  it('lists deaths with headline, place, ship, lost-item count and status', async () => {
    const report = await fixtureReport();
    const panel = new DeathReports({ rows: [listRow(report)] });
    panel.state.loading = false;
    const text = textOf(panel.render());
    assert.match(text, /Death reports/);
    assert.match(text, /Crashed Anvil Asgard tail-first into terrain on Pyro IV/);
    assert.match(text, /Pyro IV/);
    assert.match(text, /Anvil Asgard/);
    assert.match(text, /38/);
    assert.match(text, /confirmed/);
    assert.match(text, /Crash \(pilot\) \(1\)/, 'cause filter chip with a count');
  });

  it('captions the list as inferred and local, never officer-validated', () => {
    const panel = new DeathReports({ rows: [] });
    panel.state.loading = false;
    const text = textOf(panel.render());
    assert.match(text, /inferred, local only/);
    assert.match(text, /not officer-validated/);
    assert.match(text, /No deaths on record yet/);
    assert.doesNotMatch(text, /\bnull\b|undefined|NaN/);
  });

  it('filters the list by cause chip', () => {
    const rows = [
      { id: 'a'.repeat(32), status: 'confirmed', cause: 'unknown', summary: 'Died in Zone A', at: '2026-09-01T00:00:00.000Z', itemsLost: 3 },
      { id: 'b'.repeat(32), status: 'unconfirmed', cause: 'vehicle_collision_pilot', summary: 'Crashed Drake Corsair', at: '2026-09-02T00:00:00.000Z', itemsLost: 0 }
    ];
    const panel = new DeathReports({ rows });
    panel.state.loading = false;
    panel.state.cause = 'unknown';
    const text = textOf(panel.render());
    assert.match(text, /Died in Zone A/);
    assert.doesNotMatch(text, /Crashed Drake Corsair/);
  });

  it('renders the full report: cause card, timeline, location, gear and evidence', async () => {
    const report = await fixtureReport();
    const panel = new DeathReports({ rows: [], report });
    const tree = panel.render();
    const text = textOf(tree);
    assert.match(text, /Crashed Anvil Asgard tail-first into terrain on Pyro IV at 17\.8 m\/s \(64 km\/h\)/);
    assert.match(text, /Crash \(pilot\)/);
    assert.match(text, /ttd_expired/);
    assert.match(text, /25\.2 ms — normal/);
    assert.match(text, /Pyro IV \(pyro4\)/);
    assert.match(text, /x -245156\.61 · y -85688\.16 · z 189431\.93/);
    assert.match(text, /FatalCollision — Tail, zone pyro4/);
    assert.match(text, /Corpse recorded — 45 items \(38 lost, 7 character-bound\)/);
    assert.match(text, /Gear left on corpse \(38\)/);
    assert.match(text, /not lost \(7\)/);
    assert.match(text, /behr_rifle_ballistic_02_mag_civilian ×5/);
    assert.match(text, /Export Markdown/);
    assert.match(text, /Line numbers count from the top of the log file/);
    assert.match(text, /Raw log text is not stored/);
    assert.ok(findByClass(tree, 'dr-time'), 'timeline list rendered');
    assert.doesNotMatch(text, /\bnull\b|undefined|NaN/);
  });

  it('labels a live-captured report honestly about its line numbers', async () => {
    const report = Object.assign(await fixtureReport(), { lineBasis: 'stream' });
    const text = textOf(new DeathReports({ rows: [], report }).render());
    assert.match(text, /Captured live: line numbers count from when the relay attached/);
  });

  it('fetches the list from the relay and surfaces errors', async () => {
    const panel = new DeathReports({});
    const prev = global.fetch;
    try {
      global.fetch = async (url) => {
        assert.ok(String(url).includes('/services/star-citizen/deathreports'));
        return { ok: true, json: async () => ({ type: 'Collection', total: 1, data: [{ id: 'c'.repeat(32), status: 'confirmed', cause: 'unknown', summary: 'Died in Zone C', at: '2026-09-03T00:00:00.000Z', itemsLost: 2 }] }) };
      };
      await panel.fetchList();
      assert.match(textOf(panel.render()), /Died in Zone C/);
      global.fetch = async () => ({ ok: false, statusText: 'Unauthorized', json: async () => ({ error: 'Authentication required' }) });
      await panel.fetchList();
      assert.strictEqual(panel.state.error, 'Authentication required');
      assert.match(textOf(panel.render()), /Authentication required/);
    } finally {
      global.fetch = prev;
    }
  });

  it('sends the session token and reports the rescan result', async () => {
    const panel = new DeathReports({ authToken: 'tok123' });
    const prev = global.fetch;
    const calls = [];
    try {
      global.fetch = async (url, opts = {}) => {
        calls.push({ url: String(url), opts });
        if (String(url).endsWith('/deathreports/rescan')) {
          return { ok: true, json: async () => ({ type: 'DeathReportRescan', files: 3, lines: 1200, created: 2, updated: 0, skippedDuplicates: 1 }) };
        }
        return { ok: true, json: async () => ({ type: 'Collection', total: 0, data: [] }) };
      };
      await panel.rescan();
      assert.strictEqual(calls[0].opts.method, 'POST');
      assert.strictEqual(calls[0].opts.headers.Authorization, 'Bearer tok123');
      assert.deepStrictEqual(JSON.parse(calls[0].opts.body), { all: true });
      assert.match(textOf(panel.render()), /Rescanned 3 log files \(1200 lines\): 2 new, 0 updated, 1 already on record/);
    } finally {
      global.fetch = prev;
    }
  });
});
