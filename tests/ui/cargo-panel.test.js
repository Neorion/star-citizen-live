'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

require('../helpers/installReactStub');
const { textOf } = require('../helpers/reactTree');
const Cargo = require('../../components/Cargo');

const SAMPLE = {
  type: 'Cargo',
  enabled: true,
  summary: { missions: 2, pickups: 1, dropoffs: 1, totalScu: 12, carriedOver: 0, done: 1, awaiting: 1, order: 'optimize' },
  hubs: [
    {
      pickup: 'Everus Harbor',
      pickupKnown: true,
      pickupBody: 'Hurston',
      collectScu: 12,
      missions: 2,
      stale: false,
      legs: [
        {
          title: 'Rank 1 | Hauling | to Area18', reward: '12,000 aUEC', rank: 'Rank 1',
          contractType: 'Hauling', missionId: 'm1', stale: false,
          dropKey: 'dropoff_aaaa_0', dropoff: null, dropBody: null,
          commodity: 'Agricultural Supplies', scu: 12, pending: true, inRegister: true
        },
        {
          title: 'Rank 1 | Hauling | to Lorville', reward: '8,000 aUEC', rank: 'Rank 1',
          contractType: 'Hauling', missionId: 'm2', stale: false,
          dropKey: 'm0', dropoff: 'Lorville', dropBody: 'Hurston',
          commodity: null, scu: null, pending: false, awaiting: true
        }
      ]
    }
  ],
  done: [
    { missionId: 'm0', status: 'completed', contractType: 'Hauling', dropoff: 'Area18' }
  ],
  notes: [
    '1 mission(s) accepted but no cargo line yet — loads when you physically pick up that mission\'s cargo in-game (opening the contract isn\'t enough).'
  ]
};

/**
 * @param {object} json - the body fetch() should resolve with.
 * @returns {Function} a fetch stub.
 */
function fetchResolving (json) {
  return async (url) => {
    assert.ok(String(url).includes('/services/star-citizen/cargo'));
    return { ok: true, json: async () => json };
  };
}

describe('Cargo panel', () => {
  it('renders hub/leg rows from fetched data', async () => {
    const panel = new Cargo({});
    const prev = global.fetch;
    global.fetch = fetchResolving(SAMPLE);
    try {
      await panel.fetchCargo();
      const tree = panel.render();
      const text = textOf(tree);
      assert.match(text, /Everus Harbor/);
      assert.match(text, /Hurston/);
      assert.match(text, /Agricultural Supplies/);
      assert.match(text, /12 SCU/);
      assert.match(text, /Lorville/);
    } finally {
      global.fetch = prev;
    }
  });

  it('shows the register cross-link badge for a leg whose mission is inRegister', async () => {
    const panel = new Cargo({});
    const prev = global.fetch;
    global.fetch = fetchResolving(SAMPLE);
    try {
      await panel.fetchCargo();
      const text = textOf(panel.render());
      assert.match(text, /Register/);
    } finally {
      global.fetch = prev;
    }
  });

  it('shows "station not yet known" for a pending leg, not blank', async () => {
    const panel = new Cargo({});
    const prev = global.fetch;
    global.fetch = fetchResolving(SAMPLE);
    try {
      await panel.fetchCargo();
      const text = textOf(panel.render());
      assert.match(text, /station not yet known/);
    } finally {
      global.fetch = prev;
    }
  });

  it('shows "accepted — no cargo line yet" for an awaiting leg, not blank', async () => {
    const panel = new Cargo({});
    const prev = global.fetch;
    global.fetch = fetchResolving(SAMPLE);
    try {
      await panel.fetchCargo();
      const text = textOf(panel.render());
      assert.match(text, /accepted — no cargo line yet/);
    } finally {
      global.fetch = prev;
    }
  });

  it('renders the Done section', async () => {
    const panel = new Cargo({});
    const prev = global.fetch;
    global.fetch = fetchResolving(SAMPLE);
    try {
      await panel.fetchCargo();
      const text = textOf(panel.render());
      assert.match(text, /Done/);
      assert.match(text, /Area18/);
      assert.match(text, /completed/);
    } finally {
      global.fetch = prev;
    }
  });

  it('renders notes', async () => {
    const panel = new Cargo({});
    const prev = global.fetch;
    global.fetch = fetchResolving(SAMPLE);
    try {
      await panel.fetchCargo();
      const text = textOf(panel.render());
      assert.match(text, /no cargo line yet/);
    } finally {
      global.fetch = prev;
    }
  });

  it('shows the route\'s own empty-state note when there are no hubs and no done entries', async () => {
    const panel = new Cargo({});
    const prev = global.fetch;
    global.fetch = fetchResolving({
      type: 'Cargo',
      enabled: true,
      summary: { missions: 0, pickups: 0, dropoffs: 0, totalScu: 0, carriedOver: 0, done: 0, awaiting: 0, order: 'optimize' },
      hubs: [],
      done: [],
      notes: ['No cargo missions yet. Accept a hauling contract in-game.']
    });
    try {
      await panel.fetchCargo();
      const text = textOf(panel.render());
      assert.match(text, /No cargo missions yet/);
    } finally {
      global.fetch = prev;
    }
  });

  it('surfaces an error state when fetch fails', async () => {
    const panel = new Cargo({});
    const prev = global.fetch;
    global.fetch = async () => ({ ok: false, statusText: 'Internal Server Error', json: async () => ({ error: 'boom' }) });
    try {
      await panel.fetchCargo();
      assert.strictEqual(panel.state.error, 'boom');
      const text = textOf(panel.render());
      assert.match(text, /boom/);
    } finally {
      global.fetch = prev;
    }
  });
});
