'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { shipUsageRollup } = require('../../functions/shipUsage');

describe('shipUsage', () => {
  describe('shipUsageRollup', () => {
    it('returns [] for empty/missing history without throwing', () => {
      assert.deepStrictEqual(shipUsageRollup({}), []);
      assert.deepStrictEqual(shipUsageRollup({ shipUse: [] }), []);
      assert.deepStrictEqual(shipUsageRollup(undefined), []);
    });

    it('groups records by member+ship, skipping null/empty ship (and empty player) records', () => {
      const history = {
        shipUse: [
          { player: 'Alice', ship: 'Cutlass Black', ts: '2026-08-01T01:10:00Z' },
          { player: 'Alice', ship: 'Cutlass Black', ts: '2026-08-01T01:40:00Z' },
          { player: 'Alice', ship: null, ts: '2026-08-01T02:00:00Z' },
          { player: 'Alice', ship: '', ts: '2026-08-01T02:05:00Z' },
          { player: 'Alice', ts: '2026-08-01T02:10:00Z' }, // ship missing entirely
          { player: '', ship: 'Freelancer', ts: '2026-08-01T02:20:00Z' }, // player missing
          { player: 'Bob', ship: 'Freelancer', ts: '2026-08-01T03:00:00Z' }
        ]
      };
      const rows = shipUsageRollup(history);
      assert.strictEqual(rows.length, 2);
      const alice = rows.find((r) => r.member === 'Alice' && r.ship === 'Cutlass Black');
      const bob = rows.find((r) => r.member === 'Bob' && r.ship === 'Freelancer');
      assert.ok(alice);
      assert.ok(bob);
    });

    it('computes sessions as distinct hour-buckets and minutes = sessions * 60', () => {
      const history = {
        shipUse: [
          // Same hour bucket -> 1 session.
          { player: 'Alice', ship: 'Cutlass Black', ts: '2026-08-01T01:10:00Z' },
          { player: 'Alice', ship: 'Cutlass Black', ts: '2026-08-01T01:40:00Z' },
          // Different hour bucket -> 2nd session.
          { player: 'Alice', ship: 'Cutlass Black', ts: '2026-08-01T02:15:00Z' }
        ]
      };
      const rows = shipUsageRollup(history);
      const row = rows.find((r) => r.member === 'Alice' && r.ship === 'Cutlass Black');
      assert.strictEqual(row.sessions, 2);
      assert.strictEqual(row.minutes, 120);
      assert.strictEqual(row.inferred, true);
    });

    it('lastFlown picks the max ts verbatim (not reformatted)', () => {
      const history = {
        shipUse: [
          { player: 'Alice', ship: 'Freelancer', ts: '2026-08-01T01:00:00.000Z' },
          { player: 'Alice', ship: 'Freelancer', ts: '2026-08-03T09:30:00.000Z' },
          { player: 'Alice', ship: 'Freelancer', ts: '2026-08-02T05:00:00.000Z' }
        ]
      };
      const rows = shipUsageRollup(history);
      const row = rows.find((r) => r.member === 'Alice' && r.ship === 'Freelancer');
      assert.strictEqual(row.lastFlown, '2026-08-03T09:30:00.000Z');
    });

    it('sorts by member ascending, then by minutes descending within member', () => {
      const history = {
        shipUse: [
          { player: 'Bob', ship: 'Aurora MR', ts: '2026-08-01T01:00:00Z' },
          { player: 'Alice', ship: 'Freelancer', ts: '2026-08-01T01:00:00Z' },
          { player: 'Alice', ship: 'Freelancer', ts: '2026-08-01T02:00:00Z' },
          { player: 'Alice', ship: 'Freelancer', ts: '2026-08-01T03:00:00Z' },
          { player: 'Alice', ship: 'Cutlass Black', ts: '2026-08-01T04:00:00Z' }
        ]
      };
      const rows = shipUsageRollup(history);
      assert.deepStrictEqual(rows.map((r) => r.member), ['Alice', 'Alice', 'Bob']);
      // Alice: Freelancer has 3 hour-buckets (180min) > Cutlass Black's 1 (60min).
      assert.strictEqual(rows[0].ship, 'Freelancer');
      assert.strictEqual(rows[1].ship, 'Cutlass Black');
      assert.ok(rows[0].minutes >= rows[1].minutes);
    });

    it('supports an optional members allowlist without forcing zero-stat rows', () => {
      const history = {
        shipUse: [
          { player: 'Alice', ship: 'Freelancer', ts: '2026-08-01T01:00:00Z' },
          { player: 'Bob', ship: 'Aurora MR', ts: '2026-08-01T01:00:00Z' }
        ]
      };
      const rows = shipUsageRollup(history, { members: ['Alice', 'Carol'] });
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].member, 'Alice');
      // Carol has zero ship-use and gets no placeholder row.
      assert.ok(!rows.find((r) => r.member === 'Carol'));
    });
  });
});
