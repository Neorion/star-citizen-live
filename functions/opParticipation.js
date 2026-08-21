'use strict';

/**
 * Op participation + split-suggestion helpers (advisory only).
 *
 * Builds a per-member participation summary for a fleet op window from
 * cumulativeHistory records (missions, deaths, quantum hops, ship use), and
 * an optional cargo/payout split suggestion derived from that summary.
 *
 * HONESTY NOTE: none of the source records carry a duration/end-time — only a
 * single `ts` per event — so there is no reliable way to compute exact
 * wall-clock "active minutes". `activeMinutes` here is an hour-granularity
 * PRESENCE PROXY (distinct hour-buckets touched × 60), not measured session
 * time. Every row/share this module returns is marked `inferred`/`advisory`
 * so callers never present it as ground truth.
 */

/**
 * Build a validated op time window.
 * @param {object} opts
 * @param {string} opts.start - ISO-8601-ish start timestamp (Date.parse-able).
 * @param {string} opts.end - ISO-8601-ish end timestamp (Date.parse-able), must be after start.
 * @param {string} [opts.name] - optional op name/label; trimmed if a string.
 * @returns {{ name: string|null, start: string, end: string }}
 * @throws {Error} with `.code = 'BAD_WINDOW'` on missing/unparseable dates or start >= end.
 */
function opWindow (opts = {}) {
  const { start, end, name } = opts || {};
  if (!start || !end) {
    const err = new Error('op window requires both start and end');
    err.code = 'BAD_WINDOW';
    throw err;
  }
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    const err = new Error('op window start/end must be parseable dates');
    err.code = 'BAD_WINDOW';
    throw err;
  }
  if (startMs >= endMs) {
    const err = new Error('op window end must be after start');
    err.code = 'BAD_WINDOW';
    throw err;
  }
  let cleanName = null;
  if (typeof name === 'string') {
    const trimmed = name.trim();
    cleanName = trimmed.length ? trimmed : null;
  }
  return {
    name: cleanName,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString()
  };
}

/**
 * Derive the "YYYY-MM-DDTHH" hour bucket for a timestamp (UTC, deterministic).
 * @param {string} ts
 * @returns {string|null}
 */
function hourBucketOf (ts) {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 13);
}

/**
 * @param {object} ev
 * @param {number} startMs
 * @param {number} endMs
 * @returns {boolean}
 */
function isInWindow (ev, startMs, endMs) {
  if (!ev || !ev.ts) return false;
  const t = Date.parse(ev.ts);
  if (Number.isNaN(t)) return false;
  return t >= startMs && t <= endMs;
}

/**
 * Build per-member participation rows for an op window from cumulative history.
 * @param {{ missions?: object[], deaths?: object[], quantum?: object[], shipUse?: object[] }} history
 * @param {{ start: string, end: string }} window - typically from opWindow().
 * @param {{ members?: string[] }} [opts] - `members` guarantees a zero-stat row per listed name.
 * @returns {Array<{
 *   member: string,
 *   activeMinutes: number,
 *   missionsInWindow: number,
 *   missionsCompleted: number,
 *   deaths: number,
 *   ships: Array<{ ship: string, minutes: number }>,
 *   locations: Array<{ zone: string, firstSeen: string, lastSeen: string }>,
 *   inferred: true
 * }>}
 */
function participationRows (history, window, opts = {}) {
  const h = history || {};
  const missions = Array.isArray(h.missions) ? h.missions : [];
  const deaths = Array.isArray(h.deaths) ? h.deaths : [];
  const quantum = Array.isArray(h.quantum) ? h.quantum : [];
  const shipUse = Array.isArray(h.shipUse) ? h.shipUse : [];

  const startMs = Date.parse(window && window.start);
  const endMs = Date.parse(window && window.end);

  const winMissions = missions.filter((ev) => isInWindow(ev, startMs, endMs));
  const winDeaths = deaths.filter((ev) => isInWindow(ev, startMs, endMs));
  const winQuantum = quantum.filter((ev) => isInWindow(ev, startMs, endMs));
  const winShipUse = shipUse.filter((ev) => isInWindow(ev, startMs, endMs));

  const members = new Set();
  for (const m of opts.members || []) {
    if (m) members.add(String(m));
  }
  for (const list of [winMissions, winDeaths, winQuantum, winShipUse]) {
    for (const ev of list) {
      if (ev && ev.player) members.add(String(ev.player));
    }
  }

  const rows = Array.from(members).map((member) => {
    const mMissions = winMissions.filter((m) => String(m.player) === member);
    const mDeaths = winDeaths.filter((d) => String(d.player) === member);
    const mQuantum = winQuantum.filter((q) => String(q.player) === member);
    const mShipUse = winShipUse.filter((s) => String(s.player) === member);

    // Hour-bucket presence proxy across every event kind for this member.
    const hourBuckets = new Set();
    for (const list of [mMissions, mDeaths, mQuantum, mShipUse]) {
      for (const ev of list) {
        const bucket = hourBucketOf(ev.ts);
        if (bucket) hourBuckets.add(bucket);
      }
    }

    // Ships: group by name, minutes = distinct member+ship hour-buckets × 60.
    const shipBuckets = Object.create(null);
    for (const s of mShipUse) {
      const ship = s && s.ship ? String(s.ship).trim() : '';
      if (!ship) continue;
      const bucket = hourBucketOf(s.ts);
      if (!bucket) continue;
      if (!shipBuckets[ship]) shipBuckets[ship] = new Set();
      shipBuckets[ship].add(bucket);
    }
    const ships = Object.keys(shipBuckets)
      .map((ship) => ({ ship, minutes: shipBuckets[ship].size * 60 }))
      .filter((row) => row.minutes > 0)
      .sort((a, b) => b.minutes - a.minutes);

    // Locations: group by destination, first/last seen preserved verbatim.
    const locBuckets = Object.create(null);
    for (const q of mQuantum) {
      const zone = q && q.destination ? String(q.destination).trim() : '';
      if (!zone) continue;
      const t = Date.parse(q.ts);
      if (Number.isNaN(t)) continue;
      if (!locBuckets[zone]) {
        locBuckets[zone] = { firstT: t, firstStr: q.ts, lastT: t, lastStr: q.ts };
      } else {
        if (t < locBuckets[zone].firstT) { locBuckets[zone].firstT = t; locBuckets[zone].firstStr = q.ts; }
        if (t > locBuckets[zone].lastT) { locBuckets[zone].lastT = t; locBuckets[zone].lastStr = q.ts; }
      }
    }
    const locations = Object.keys(locBuckets)
      .map((zone) => ({ zone, firstSeen: locBuckets[zone].firstStr, lastSeen: locBuckets[zone].lastStr }))
      .sort((a, b) => Date.parse(a.firstSeen) - Date.parse(b.firstSeen));

    return {
      member,
      activeMinutes: hourBuckets.size * 60,
      missionsInWindow: mMissions.length,
      missionsCompleted: mMissions.filter((m) => m.outcome === 'Complete').length,
      deaths: mDeaths.length,
      ships,
      locations,
      inferred: true
    };
  });

  rows.sort((a, b) => (a.member < b.member ? -1 : a.member > b.member ? 1 : 0));
  return rows;
}

/**
 * Suggest an advisory cargo/payout split from participation rows. Never
 * authoritative — callers must present this as a suggestion, not a decision.
 * @param {Array<{ member: string, activeMinutes: number, missionsCompleted: number }>} rows
 * @param {'equal'|'byActiveMinutes'|'byMissions'} formula
 * @returns {Array<{ member: string, share: number, inferred: true, advisory: true }>}
 * @throws {Error} with `.code = 'BAD_FORMULA'` when formula is not one of the three above.
 */
function splitSuggestion (rows, formula) {
  const list = Array.isArray(rows) ? rows : [];
  if (formula !== 'equal' && formula !== 'byActiveMinutes' && formula !== 'byMissions') {
    const err = new Error('unknown split formula: ' + formula);
    err.code = 'BAD_FORMULA';
    throw err;
  }

  const n = list.length;
  if (!n) return [];

  const equalSplit = () => {
    const share = 1 / n;
    return list.map((r) => ({ member: r.member, share, inferred: true, advisory: true }));
  };

  if (formula === 'equal') return equalSplit();

  if (formula === 'byActiveMinutes') {
    const total = list.reduce((sum, r) => sum + (Number(r.activeMinutes) || 0), 0);
    if (!total) return equalSplit();
    return list.map((r) => ({
      member: r.member,
      share: (Number(r.activeMinutes) || 0) / total,
      inferred: true,
      advisory: true
    }));
  }

  // formula === 'byMissions'
  const total = list.reduce((sum, r) => sum + (Number(r.missionsCompleted) || 0), 0);
  if (!total) return equalSplit();
  return list.map((r) => ({
    member: r.member,
    share: (Number(r.missionsCompleted) || 0) / total,
    inferred: true,
    advisory: true
  }));
}

module.exports = { opWindow, participationRows, splitSuggestion };
