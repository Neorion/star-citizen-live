'use strict';

/**
 * Per-pilot, per-ship lifetime usage rollup (advisory only).
 *
 * Builds a flat, sorted list of { member, ship } rows from every recorded
 * `history.shipUse` entry, all-time (no op-window scoping — unlike
 * functions/opParticipation.js, which scopes to a single op window).
 *
 * HONESTY NOTE: shipUse records carry only a single `ts` per event — no
 * duration/end-time — so there is no reliable way to compute exact wall-clock
 * flight time. `sessions`/`minutes` here are the same hour-granularity
 * PRESENCE PROXY used by functions/opParticipation.js (distinct hour-buckets
 * touched by that member+ship pair × 60), not measured flight time. Every row
 * this module returns is marked `inferred` so callers never present it as
 * ground truth.
 */

/**
 * Derive the "YYYY-MM-DDTHH" hour bucket for a timestamp (UTC, deterministic).
 * Mirrors functions/opParticipation.js's hourBucketOf exactly.
 * @param {string} ts
 * @returns {string|null}
 */
function hourBucketOf (ts) {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 13);
}

/**
 * Build a lifetime per-member, per-ship usage rollup from cumulative history.
 * @param {{ shipUse?: Array<{ player?: string, ship?: string, ts?: string }> }} history
 * @param {{ members?: string[] }} [opts] - optional allowlist; when given, only
 *   rows for these members are returned. Unlike functions/opParticipation.js,
 *   this never forces a zero-stat placeholder row for a listed member with no
 *   ship-use — there's no meaningful "zero-ship" row to show.
 * @returns {Array<{
 *   member: string,
 *   ship: string,
 *   sessions: number,
 *   minutes: number,
 *   lastFlown: string,
 *   inferred: true
 * }>}
 */
function shipUsageRollup (history, opts = {}) {
  const h = history || {};
  const shipUse = Array.isArray(h.shipUse) ? h.shipUse : [];

  let allow = null;
  if (Array.isArray(opts.members) && opts.members.length) {
    allow = new Set(opts.members.map((m) => String(m)));
  }

  // Group by member+ship pair.
  const groups = Object.create(null);
  for (const rec of shipUse) {
    if (!rec) continue;
    const ship = rec.ship != null ? String(rec.ship).trim() : '';
    if (!ship) continue;
    const member = rec.player != null ? String(rec.player).trim() : '';
    if (!member) continue;
    if (allow && !allow.has(member)) continue;

    const key = member + '::' + ship;
    let g = groups[key];
    if (!g) {
      g = { member, ship, hourBuckets: new Set(), lastFlownMs: -Infinity, lastFlown: null };
      groups[key] = g;
    }

    const bucket = hourBucketOf(rec.ts);
    if (bucket) g.hourBuckets.add(bucket);

    const t = Date.parse(rec.ts);
    if (!Number.isNaN(t) && t > g.lastFlownMs) {
      g.lastFlownMs = t;
      g.lastFlown = rec.ts;
    }
  }

  const rows = Object.keys(groups).map((key) => {
    const g = groups[key];
    const sessions = g.hourBuckets.size;
    return {
      member: g.member,
      ship: g.ship,
      sessions,
      minutes: sessions * 60,
      lastFlown: g.lastFlown,
      inferred: true
    };
  });

  rows.sort((a, b) => {
    if (a.member < b.member) return -1;
    if (a.member > b.member) return 1;
    return b.minutes - a.minutes;
  });

  return rows;
}

module.exports = { shipUsageRollup };
