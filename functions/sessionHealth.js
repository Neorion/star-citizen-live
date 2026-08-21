'use strict';

/**
 * Session-health rollup (advisory only).
 *
 * Groups cumulativeHistory session records by build (changelist, falling back
 * to branch, falling back to 'unknown') and summarizes disconnect/crash
 * signals and a session-duration median per build.
 *
 * HONESTY NOTE: `crashes` counts sessions where `cleanEnd === false` — i.e. no
 * `session:disconnect` line was observed before end-of-file for that ingested
 * file. That is a HEURISTIC, not a confirmed crash: the same shape shows up
 * when a file was still being actively written at capture time (e.g. the
 * live-tailed Game.log grabbed mid-session for a backup). Every row this
 * module returns is marked `inferred: true` so callers never present it as
 * ground truth.
 */

/**
 * Median of a list of numbers (minutes), rounded to 1 decimal place.
 * @param {number[]} values
 * @returns {number|null} null when the list is empty
 */
function median (values) {
  if (!values || !values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const raw = sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(raw * 10) / 10;
}

/**
 * Roll up per-build session health from cumulative history.
 * @param {{ sessions?: object[] }} history - typically `_analyticsDataset()`'s output.
 * @param {{ builds?: string[] }} [opts] - `builds` guarantees a zero-stat row per listed build.
 * @returns {Array<{
 *   build: string,
 *   sessions: number,
 *   disconnects: number,
 *   crashes: number,
 *   disconnectsPerSession: number,
 *   medianSessionMinutes: number|null,
 *   inferred: true
 * }>}
 */
function sessionHealthRollup (history, opts = {}) {
  const h = history || {};
  const sessions = Array.isArray(h.sessions) ? h.sessions : [];

  const groups = Object.create(null);
  const ensure = (build) => {
    if (!groups[build]) {
      groups[build] = { build, sessions: 0, disconnects: 0, crashes: 0, minutes: [] };
    }
    return groups[build];
  };

  for (const b of opts.builds || []) {
    if (b) ensure(String(b));
  }

  for (const s of sessions) {
    if (!s) continue;
    const build = s.build ? String(s.build) : 'unknown';
    const row = ensure(build);
    row.sessions += 1;
    row.disconnects += Number(s.disconnects) || 0;
    if (s.cleanEnd === false) row.crashes += 1;

    if (s.ts && s.endTs) {
      const start = Date.parse(s.ts);
      const end = Date.parse(s.endTs);
      if (!Number.isNaN(start) && !Number.isNaN(end) && end > start) {
        row.minutes.push((end - start) / 60000);
      }
    }
  }

  const rows = Object.keys(groups).map((build) => {
    const g = groups[build];
    return {
      build: g.build,
      sessions: g.sessions,
      disconnects: g.disconnects,
      crashes: g.crashes,
      disconnectsPerSession: g.sessions ? g.disconnects / g.sessions : 0,
      medianSessionMinutes: median(g.minutes),
      inferred: true
    };
  });

  rows.sort((a, b) => (a.build < b.build ? -1 : a.build > b.build ? 1 : 0));
  return rows;
}

module.exports = { sessionHealthRollup };
