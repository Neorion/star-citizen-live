'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { opWindow, participationRows, splitSuggestion } = require('../../functions/opParticipation');

describe('opParticipation', () => {
  describe('opWindow', () => {
    it('builds a valid window from parseable dates and trims the name', () => {
      const win = opWindow({ start: '2026-08-01T00:00:00Z', end: '2026-08-01T04:00:00Z', name: '  Op Ember  ' });
      assert.strictEqual(win.name, 'Op Ember');
      assert.strictEqual(typeof win.start, 'string');
      assert.strictEqual(typeof win.end, 'string');
      assert.ok(Date.parse(win.start) < Date.parse(win.end));
    });

    it('defaults name to null when omitted', () => {
      const win = opWindow({ start: '2026-08-01T00:00:00Z', end: '2026-08-01T01:00:00Z' });
      assert.strictEqual(win.name, null);
    });

    it('throws BAD_WINDOW when start or end is missing', () => {
      assert.throws(() => opWindow({ end: '2026-08-01T00:00:00Z' }), (err) => err.code === 'BAD_WINDOW');
      assert.throws(() => opWindow({ start: '2026-08-01T00:00:00Z' }), (err) => err.code === 'BAD_WINDOW');
    });

    it('throws BAD_WINDOW on unparseable dates', () => {
      assert.throws(
        () => opWindow({ start: 'not-a-date', end: '2026-08-01T00:00:00Z' }),
        (err) => err.code === 'BAD_WINDOW'
      );
    });

    it('throws BAD_WINDOW when start >= end', () => {
      assert.throws(
        () => opWindow({ start: '2026-08-01T04:00:00Z', end: '2026-08-01T04:00:00Z' }),
        (err) => err.code === 'BAD_WINDOW'
      );
      assert.throws(
        () => opWindow({ start: '2026-08-01T05:00:00Z', end: '2026-08-01T04:00:00Z' }),
        (err) => err.code === 'BAD_WINDOW'
      );
    });
  });

  describe('participationRows', () => {
    const window = opWindow({ start: '2026-08-01T00:00:00Z', end: '2026-08-01T04:00:00Z' });

    const history = {
      missions: [
        { id: 'm1', player: 'Alice', outcome: 'Complete', ts: '2026-08-01T01:00:00Z' },
        { id: 'm2', player: 'Alice', outcome: 'Fail', ts: '2026-08-01T02:00:00Z' },
        { id: 'm3', player: 'Bob', outcome: 'Complete', ts: '2026-08-01T03:59:59Z' }, // just inside
        { id: 'm4', player: 'Bob', outcome: 'Complete', ts: '2026-08-01T04:00:01Z' }, // just outside
        { id: 'm5', player: 'Dora', outcome: 'Complete', ts: '2026-08-01T00:00:00Z' }, // exactly at start
        { id: 'm6', player: 'Dora', outcome: 'Complete', ts: '2026-08-01T04:00:00Z' } // exactly at end
      ],
      deaths: [
        { id: 'd1', player: 'Alice', ts: '2026-08-01T01:30:00Z', bodyId: 'x' }
      ],
      quantum: [
        { id: 'q1', player: 'Alice', phase: 'arrive', ts: '2026-08-01T01:05:00Z', destination: 'Lorville' },
        { id: 'q2', player: 'Alice', phase: 'arrive', ts: '2026-08-01T02:10:00Z', destination: 'Area18' },
        { id: 'q3', player: 'Alice', phase: 'arrive', ts: '2026-08-01T02:20:00Z', destination: 'Lorville' }
      ],
      shipUse: [
        { id: 's1', player: 'Alice', ts: '2026-08-01T01:10:00Z', ship: 'Cutlass Black' },
        { id: 's2', player: 'Alice', ts: '2026-08-01T02:15:00Z', ship: 'Cutlass Black' },
        { id: 's3', player: 'Alice', ts: '2026-08-01T03:00:00Z', ship: 'Freelancer' }
      ]
    };

    it('filters missions to the window (exclusive of events past the end)', () => {
      const rows = participationRows(history, window);
      const bob = rows.find((r) => r.member === 'Bob');
      assert.strictEqual(bob.missionsInWindow, 1);
      assert.strictEqual(bob.missionsCompleted, 1);
    });

    it('includes events exactly at the start and end boundary (inclusive)', () => {
      const rows = participationRows(history, window);
      const dora = rows.find((r) => r.member === 'Dora');
      assert.strictEqual(dora.missionsInWindow, 2);
      assert.strictEqual(dora.missionsCompleted, 2);
    });

    it('includes opts.members even with zero events, and skips non-listed zero-event members', () => {
      const rows = participationRows(history, window, { members: ['Alice', 'Carol'] });
      assert.ok(!rows.find((r) => r.member === 'Zed'));
      const carol = rows.find((r) => r.member === 'Carol');
      assert.ok(carol);
      assert.strictEqual(carol.activeMinutes, 0);
      assert.strictEqual(carol.missionsInWindow, 0);
      assert.strictEqual(carol.missionsCompleted, 0);
      assert.strictEqual(carol.deaths, 0);
      assert.deepStrictEqual(carol.ships, []);
      assert.deepStrictEqual(carol.locations, []);
      assert.strictEqual(carol.inferred, true);
    });

    it('groups ships by name and sorts descending by minutes', () => {
      const rows = participationRows(history, window);
      const alice = rows.find((r) => r.member === 'Alice');
      assert.strictEqual(alice.ships[0].ship, 'Cutlass Black');
      assert.ok(alice.ships[0].minutes >= alice.ships[1].minutes);
      assert.ok(alice.ships.every((s) => s.minutes > 0));
    });

    it('groups locations with firstSeen/lastSeen (verbatim) and sorts by firstSeen', () => {
      const rows = participationRows(history, window);
      const alice = rows.find((r) => r.member === 'Alice');
      const lorville = alice.locations.find((l) => l.zone === 'Lorville');
      assert.strictEqual(lorville.firstSeen, '2026-08-01T01:05:00Z');
      assert.strictEqual(lorville.lastSeen, '2026-08-01T02:20:00Z');
      assert.strictEqual(alice.locations[0].zone, 'Lorville');
    });

    it('sorts rows by member ascending', () => {
      const rows = participationRows(history, window, { members: ['Zed', 'Alice'] });
      const names = rows.map((r) => r.member);
      const sorted = names.slice().sort();
      assert.deepStrictEqual(names, sorted);
    });

    it('defaults missing history collections to empty arrays without throwing', () => {
      const rows = participationRows({}, window, { members: ['Solo'] });
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].member, 'Solo');
      assert.strictEqual(rows[0].activeMinutes, 0);
      assert.strictEqual(rows[0].inferred, true);
    });
  });

  describe('splitSuggestion', () => {
    const rows = [
      { member: 'Alice', activeMinutes: 120, missionsCompleted: 3 },
      { member: 'Bob', activeMinutes: 60, missionsCompleted: 1 },
      { member: 'Carol', activeMinutes: 0, missionsCompleted: 0 }
    ];

    it('splits equally and preserves row order', () => {
      const out = splitSuggestion(rows, 'equal');
      assert.strictEqual(out.length, 3);
      out.forEach((o) => {
        assert.ok(Math.abs(o.share - 1 / 3) < 1e-9);
        assert.strictEqual(o.inferred, true);
        assert.strictEqual(o.advisory, true);
      });
      assert.deepStrictEqual(out.map((o) => o.member), ['Alice', 'Bob', 'Carol']);
    });

    it('returns an empty array for equal split with no rows', () => {
      assert.deepStrictEqual(splitSuggestion([], 'equal'), []);
    });

    it('splits by active minutes proportionally', () => {
      const out = splitSuggestion(rows, 'byActiveMinutes');
      const alice = out.find((o) => o.member === 'Alice');
      const bob = out.find((o) => o.member === 'Bob');
      const carol = out.find((o) => o.member === 'Carol');
      assert.ok(Math.abs(alice.share - 120 / 180) < 1e-9);
      assert.ok(Math.abs(bob.share - 60 / 180) < 1e-9);
      assert.strictEqual(carol.share, 0);
    });

    it('splits by missions completed proportionally', () => {
      const out = splitSuggestion(rows, 'byMissions');
      const alice = out.find((o) => o.member === 'Alice');
      const bob = out.find((o) => o.member === 'Bob');
      const carol = out.find((o) => o.member === 'Carol');
      assert.ok(Math.abs(alice.share - 3 / 4) < 1e-9);
      assert.ok(Math.abs(bob.share - 1 / 4) < 1e-9);
      assert.strictEqual(carol.share, 0);
    });

    it('falls back to equal split when the sum is 0', () => {
      const zeroRows = [
        { member: 'A', activeMinutes: 0, missionsCompleted: 0 },
        { member: 'B', activeMinutes: 0, missionsCompleted: 0 }
      ];
      const byMin = splitSuggestion(zeroRows, 'byActiveMinutes');
      const byMis = splitSuggestion(zeroRows, 'byMissions');
      assert.strictEqual(byMin.length, 2);
      byMin.forEach((o) => assert.ok(Math.abs(o.share - 0.5) < 1e-9));
      byMis.forEach((o) => assert.ok(Math.abs(o.share - 0.5) < 1e-9));
    });

    it('throws BAD_FORMULA for an unknown formula', () => {
      assert.throws(() => splitSuggestion(rows, 'bogus'), (err) => err.code === 'BAD_FORMULA');
    });
  });
});
