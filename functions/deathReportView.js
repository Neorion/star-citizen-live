'use strict';

/**
 * Death report display helpers shared by the relay (Markdown export) and the
 * dashboard bundle. Browser-safe: no Node built-ins, no parser import.
 */

/** Frame times above this (ms) at impact are flagged as a possible lag spike. */
const LAG_SPIKE_MS = 100;

const CAUSE_LABELS = {
  vehicle_collision_pilot: 'Crash (pilot)',
  vehicle_collision_passenger: 'Crash (passenger)',
  vehicle_destroyed_combat: 'Ship destroyed',
  killed_by_player: 'Killed by player',
  killed_by_npc: 'Killed by NPC',
  suicide: 'Self-respawn',
  environmental: 'Environmental',
  vehicle_destroyed_unknown: 'Ship destroyed (cause not logged)',
  unknown: 'Unknown'
};

const CATEGORY_ORDER = [
  'armor', 'backpack', 'weapon', 'magazine', 'attachment', 'grenade', 'medical', 'utility', 'other', 'character'
];

/**
 * @param {number|null} ms Speed in m/s.
 * @returns {string|null} e.g. "17.8 m/s (64 km/h)"
 */
function fmtSpeed (ms) {
  if (ms == null || Number.isNaN(ms)) return null;
  return `${ms.toFixed(1)} m/s (${Math.round(ms * 3.6)} km/h)`;
}

/**
 * Group a report's gear by category (lost items first, character-bound last).
 * @param {Object} r Death report.
 * @returns {Array<{ category: string, label: string, kept: boolean, count: number, items: Array<{ itemClass: string, count: number }> }>}
 */
function groupItems (r) {
  const groups = [];
  const lost = ((r && r.items) || []).filter((i) => !i.kept);
  const kept = ((r && r.items) || []).filter((i) => i.kept);
  const tally = (rows) => {
    const by = new Map();
    for (const i of rows) by.set(i.itemClass, (by.get(i.itemClass) || 0) + 1);
    return [...by.entries()].map(([itemClass, count]) => ({ itemClass, count }));
  };
  for (const category of CATEGORY_ORDER) {
    const rows = lost.filter((i) => i.category === category);
    // Lost items on character ports (visor, hat) are worn gear, not the
    // character-bound parts below — label them so the two never read alike.
    const label = category === 'character' ? 'worn' : category;
    if (rows.length) groups.push({ category, label, kept: false, count: rows.length, items: tally(rows) });
  }
  if (kept.length) {
    groups.push({ category: 'character-bound', label: 'not lost', kept: true, count: kept.length, items: tally(kept) });
  }
  return groups;
}

module.exports = {
  LAG_SPIKE_MS,
  CAUSE_LABELS,
  CATEGORY_ORDER,
  fmtSpeed,
  groupItems
};
