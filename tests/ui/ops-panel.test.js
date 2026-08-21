'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

require('../helpers/installReactStub');
const { textOf } = require('../helpers/reactTree');
const OpParticipation = require('../../components/OpParticipation');

describe('Ops participation UI', () => {
  it('renders the create-op form', () => {
    const panel = new OpParticipation({});
    panel.state.loading = false;
    panel.state.ops = [];
    panel.state.showCreate = true;
    const tree = panel.render();
    const text = textOf(tree);
    assert.match(text, /Op name/);
    assert.match(text, /Start/);
    assert.match(text, /End/);
    assert.match(text, /Create op/);
  });

  it('shows a friendly empty state when no ops exist', () => {
    const panel = new OpParticipation({});
    panel.state.loading = false;
    panel.state.ops = [];
    const tree = panel.render();
    assert.match(textOf(tree), /No ops yet/);
  });

  it('lists an op in the selector after fetchOps resolves', async () => {
    const panel = new OpParticipation({});
    const prev = global.fetch;
    global.fetch = async (url) => {
      assert.ok(String(url).includes('/services/star-citizen/ops'));
      return {
        ok: true,
        json: async () => ({
          type: 'Collection',
          data: [{ id: 'op1', name: 'Jumptown run', start: '2026-08-20T18:00:00.000Z', end: '2026-08-20T22:00:00.000Z', createdBy: null }]
        })
      };
    };
    try {
      await panel.fetchOps();
      assert.strictEqual(panel.state.ops.length, 1);
      const tree = panel.render();
      assert.match(textOf(tree), /Jumptown run/);
    } finally {
      global.fetch = prev;
    }
  });

  it('fetches and renders participation rows with the honesty caption when an op is selected', async () => {
    const panel = new OpParticipation({});
    panel.state.ops = [{ id: 'op1', name: 'Jumptown run' }];
    panel.state.loading = false;
    const prev = global.fetch;
    global.fetch = async (url) => {
      assert.ok(String(url).includes('/ops/op1/participation'));
      return {
        ok: true,
        json: async () => ({
          type: 'Participation',
          data: {
            op: { id: 'op1', name: 'Jumptown run' },
            rows: [{
              member: 'Alice',
              activeMinutes: 120,
              missionsInWindow: 3,
              missionsCompleted: 2,
              deaths: 1,
              ships: [{ ship: 'Cutlass Black', minutes: 60 }],
              locations: [{ zone: 'Yela', firstSeen: '2026-08-20T18:10:00.000Z', lastSeen: '2026-08-20T19:00:00.000Z' }],
              inferred: true
            }]
          }
        })
      };
    };
    try {
      await panel.selectOp('op1');
      assert.strictEqual(panel.state.selectedOpId, 'op1');
      const tree = panel.render();
      const text = textOf(tree);
      assert.match(text, /Alice/);
      assert.match(text, /Cutlass Black/);
      assert.match(text, /Yela/);
      assert.match(text, /presence proxy/);
      assert.match(text, /not a measured session duration/);
    } finally {
      global.fetch = prev;
    }
  });

  it('shows the advisory split section with its caption when a formula is chosen', async () => {
    const panel = new OpParticipation({});
    panel.state.ops = [{ id: 'op1', name: 'Jumptown run' }];
    panel.state.selectedOpId = 'op1';
    panel.state.loading = false;
    const prev = global.fetch;
    global.fetch = async (url) => {
      assert.ok(String(url).includes('formula=equal'));
      return {
        ok: true,
        json: async () => ({
          type: 'Participation',
          data: {
            op: { id: 'op1', name: 'Jumptown run' },
            rows: [
              { member: 'Alice', activeMinutes: 60, missionsInWindow: 1, missionsCompleted: 1, deaths: 0, ships: [], locations: [], inferred: true },
              { member: 'Bob', activeMinutes: 60, missionsInWindow: 1, missionsCompleted: 0, deaths: 0, ships: [], locations: [], inferred: true }
            ],
            split: [
              { member: 'Alice', share: 0.5, inferred: true, advisory: true },
              { member: 'Bob', share: 0.5, inferred: true, advisory: true }
            ]
          }
        })
      };
    };
    try {
      await panel.onFormulaChange('equal');
      assert.strictEqual(panel.state.formula, 'equal');
      const tree = panel.render();
      const text = textOf(tree);
      assert.match(text, /Suggested split/);
      assert.match(text, /advisory only, the officer decides/);
      assert.match(text, /50\.0%/);
    } finally {
      global.fetch = prev;
    }
  });

  it('surfaces an error state when fetchOps fails', async () => {
    const panel = new OpParticipation({});
    const prev = global.fetch;
    global.fetch = async () => ({ ok: false, statusText: 'Internal Server Error', json: async () => ({ error: 'boom' }) });
    try {
      await panel.fetchOps();
      assert.strictEqual(panel.state.error, 'boom');
      const tree = panel.render();
      assert.match(textOf(tree), /boom/);
    } finally {
      global.fetch = prev;
    }
  });
});
