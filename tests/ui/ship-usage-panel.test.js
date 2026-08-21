'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

require('../helpers/installReactStub');
const { textOf } = require('../helpers/reactTree');
const Dashboard = require('../../components/Dashboard');

function baseAnalytics (shipUse) {
  return {
    availableMonths: [],
    sources: {},
    missions: [],
    deaths: [],
    sessions: [],
    quantum: [],
    incap: [],
    crimestat: [],
    shipUse: shipUse || []
  };
}

describe('Ship usage panel (Analyze surface)', () => {
  it('rolls up shipUse history into per-pilot ship rows in the Analyze model', () => {
    const dash = new Dashboard({});
    dash.state.analytics = baseAnalytics([
      { player: 'Alice', ship: 'Cutlass Black', ts: '2026-08-10T01:00:00.000Z' },
      { player: 'Alice', ship: 'Cutlass Black', ts: '2026-08-10T01:40:00.000Z' },
      { player: 'Alice', ship: 'Freelancer', ts: '2026-08-10T02:00:00.000Z' }
    ]);
    const model = dash.buildAnalyzeModel();
    assert.ok(Array.isArray(model.shipRows));
    const cutlass = model.shipRows.find((r) => r.member === 'Alice' && r.ship === 'Cutlass Black');
    assert.ok(cutlass);
    assert.strictEqual(cutlass.sessions, 1);
    assert.strictEqual(cutlass.minutes, 60);
    assert.strictEqual(cutlass.inferred, true);
  });

  it('renders ship rows for a pilot', () => {
    const dash = new Dashboard({});
    const model = {
      shipRows: [
        { member: 'Alice', ship: 'Cutlass Black', sessions: 3, minutes: 180, lastFlown: '2026-08-10T01:00:00.000Z', inferred: true },
        { member: 'Alice', ship: 'Freelancer', sessions: 1, minutes: 60, lastFlown: '2026-08-09T20:00:00.000Z', inferred: true }
      ]
    };
    const tree = dash.renderShipUsage(model);
    const text = textOf(tree);
    assert.match(text, /Ship usage/);
    assert.match(text, /Alice/);
    assert.match(text, /Cutlass Black/);
    assert.match(text, /Freelancer/);
    assert.match(text, /inferred/);
  });

  it('shows a placeholder (not a crash or blank) for a pilot/period with no ship-use data', () => {
    const dash = new Dashboard({});
    const model = { shipRows: [] };
    const tree = dash.renderShipUsage(model);
    const text = textOf(tree);
    assert.match(text, /no ship activity in range yet/);
  });
});
