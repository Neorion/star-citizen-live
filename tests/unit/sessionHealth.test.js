'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { sessionHealthRollup } = require('../../functions/sessionHealth');

describe('sessionHealthRollup', () => {
  const history = {
    sessions: [
      {
        id: 's1', player: 'Alice', ts: '2026-08-01T00:00:00Z',
        build: '9999999', branch: 'sc-live-1', changelist: '9999999',
        endTs: '2026-08-01T01:00:00Z', disconnects: 1, cleanEnd: true
      },
      {
        id: 's2', player: 'Alice', ts: '2026-08-01T02:00:00Z',
        build: '9999999', branch: 'sc-live-1', changelist: '9999999',
        endTs: '2026-08-01T02:40:00Z', disconnects: 0, cleanEnd: false
      },
      {
        id: 's3', player: 'Bob', ts: '2026-08-02T00:00:00Z',
        build: '8888888', branch: 'sc-ptu-1', changelist: '8888888',
        endTs: '2026-08-02T00:20:00Z', disconnects: 2, cleanEnd: true
      },
      {
        id: 's4', player: 'Bob', ts: '2026-08-02T01:00:00Z',
        build: null, branch: null, changelist: null,
        endTs: null, disconnects: 0, cleanEnd: false
      }
    ]
  };

  it('rolls up per-build totals (sessions/disconnects/crashes) across 2+ builds', () => {
    const rows = sessionHealthRollup(history);
    const b9 = rows.find((r) => r.build === '9999999');
    const b8 = rows.find((r) => r.build === '8888888');
    assert.strictEqual(b9.sessions, 2);
    assert.strictEqual(b9.disconnects, 1);
    assert.strictEqual(b9.crashes, 1);
    assert.strictEqual(b8.sessions, 1);
    assert.strictEqual(b8.disconnects, 2);
    assert.strictEqual(b8.crashes, 0);
  });

  it('falls back to "unknown" when build is missing/null', () => {
    const rows = sessionHealthRollup(history);
    const unknown = rows.find((r) => r.build === 'unknown');
    assert.ok(unknown, 'an "unknown" row exists');
    assert.strictEqual(unknown.sessions, 1);
    assert.strictEqual(unknown.crashes, 1);
  });

  it('computes median session minutes for an even count, and null when a build has no qualifying-duration session', () => {
    const rows = sessionHealthRollup(history);
    const b9 = rows.find((r) => r.build === '9999999');
    // s1: 60m, s2: 40m -> median of two = 50
    assert.strictEqual(b9.medianSessionMinutes, 50);
    const unknown = rows.find((r) => r.build === 'unknown');
    assert.strictEqual(unknown.medianSessionMinutes, null, 'null, not NaN or 0, when nothing qualifies');
  });

  it('computes median session minutes for an odd count', () => {
    const h = {
      sessions: [
        { build: 'X', ts: '2026-08-01T00:00:00Z', endTs: '2026-08-01T00:10:00Z', disconnects: 0, cleanEnd: true },
        { build: 'X', ts: '2026-08-01T01:00:00Z', endTs: '2026-08-01T01:30:00Z', disconnects: 0, cleanEnd: true },
        { build: 'X', ts: '2026-08-01T02:00:00Z', endTs: '2026-08-01T02:05:00Z', disconnects: 0, cleanEnd: true }
      ]
    };
    // durations: 10, 30, 5 -> sorted 5,10,30 -> median 10
    const rows = sessionHealthRollup(h);
    assert.strictEqual(rows[0].medianSessionMinutes, 10);
  });

  it('opts.builds seeds a zero-stat row for a build with no sessions', () => {
    const rows = sessionHealthRollup({ sessions: [] }, { builds: ['9999999', '7777777'] });
    const seeded = rows.find((r) => r.build === '7777777');
    assert.ok(seeded);
    assert.strictEqual(seeded.sessions, 0);
    assert.strictEqual(seeded.disconnects, 0);
    assert.strictEqual(seeded.crashes, 0);
    assert.strictEqual(seeded.disconnectsPerSession, 0);
    assert.strictEqual(seeded.medianSessionMinutes, null);
    assert.strictEqual(seeded.inferred, true);
  });

  it('computes disconnectsPerSession, defaulting to 0 for a zero-session build', () => {
    const rows = sessionHealthRollup(history, { builds: ['0000000'] });
    const b8 = rows.find((r) => r.build === '8888888');
    assert.strictEqual(b8.disconnectsPerSession, 2); // 2 disconnects / 1 session
    const seeded = rows.find((r) => r.build === '0000000');
    assert.strictEqual(seeded.disconnectsPerSession, 0);
  });

  it('sorts rows by build ascending', () => {
    const rows = sessionHealthRollup(history);
    const builds = rows.map((r) => r.build);
    assert.deepStrictEqual(builds, builds.slice().sort());
  });

  it('marks every row inferred: true', () => {
    const rows = sessionHealthRollup(history);
    rows.forEach((r) => assert.strictEqual(r.inferred, true));
  });
});
