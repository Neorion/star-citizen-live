'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

require('../helpers/installReactStub');
const { textOf } = require('../helpers/reactTree');
const SessionHealth = require('../../components/SessionHealth');

describe('Session stability UI', () => {
  it('renders the stability table from data passed as a prop', () => {
    const panel = new SessionHealth({
      rows: [
        { build: '9999999', sessions: 4, disconnects: 3, crashes: 1, medianSessionMinutes: 42.5, inferred: true }
      ]
    });
    panel.state.loading = false;
    const tree = panel.render();
    const text = textOf(tree);
    assert.match(text, /9999999/);
    assert.match(text, /~42\.5m/);
  });

  it('renders the stability table from fetched data on mount-style fetch', async () => {
    const panel = new SessionHealth({});
    const prev = global.fetch;
    global.fetch = async (url) => {
      assert.ok(String(url).includes('/services/star-citizen/session-health'));
      return {
        ok: true,
        json: async () => ({
          type: 'SessionHealth',
          data: [
            { build: '8888888', sessions: 2, disconnects: 0, crashes: 2, medianSessionMinutes: 15, inferred: true }
          ]
        })
      };
    };
    try {
      await panel.fetchSessionHealth();
      const tree = panel.render();
      const text = textOf(tree);
      assert.match(text, /8888888/);
      assert.match(text, /~15m/);
    } finally {
      global.fetch = prev;
    }
  });

  it('shows a clear "not enough data" placeholder for a null median, never null/NaN', () => {
    const panel = new SessionHealth({
      rows: [
        { build: 'unknown', sessions: 1, disconnects: 0, crashes: 1, medianSessionMinutes: null, inferred: true }
      ]
    });
    panel.state.loading = false;
    const tree = panel.render();
    const text = textOf(tree);
    assert.match(text, /not enough data/);
    assert.doesNotMatch(text, /\bnull\b/);
    assert.doesNotMatch(text, /NaN/);
  });

  it('captions the crash count as inferred, not a confirmed crash count', () => {
    const panel = new SessionHealth({
      rows: [
        { build: '9999999', sessions: 1, disconnects: 0, crashes: 1, medianSessionMinutes: 10, inferred: true }
      ]
    });
    panel.state.loading = false;
    const tree = panel.render();
    const text = textOf(tree);
    assert.match(text, /INFERRED/);
    assert.match(text, /not a[\s\S]*confirmed crash count/i);
  });

  it('shows a friendly empty state when there is no session history', () => {
    const panel = new SessionHealth({ rows: [] });
    panel.state.loading = false;
    const tree = panel.render();
    assert.match(textOf(tree), /No session history yet/);
  });

  it('surfaces an error state when fetchSessionHealth fails', async () => {
    const panel = new SessionHealth({});
    const prev = global.fetch;
    global.fetch = async () => ({ ok: false, statusText: 'Internal Server Error', json: async () => ({ error: 'boom' }) });
    try {
      await panel.fetchSessionHealth();
      assert.strictEqual(panel.state.error, 'boom');
      const tree = panel.render();
      assert.match(textOf(tree), /boom/);
    } finally {
      global.fetch = prev;
    }
  });
});
