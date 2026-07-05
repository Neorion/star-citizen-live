'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeCommodities, normalizeLocations, bodyOfTerminal } = require('../services/uexClient');

// Synthetic rows shaped like the real /2.0 API responses (verified live: 205
// commodities, 823 terminals). No network — normalizers are pure functions.

test('normalizeCommodities keeps visible items, flags illegal, sorts by name', () => {
  const raw = [
    { name: 'Tungsten', code: 'WG', kind: 'Metal', is_illegal: 0, is_visible: 1 },
    { name: 'Widow', code: 'WID', kind: 'Drug', is_illegal: 1, is_visible: 1 },
    { name: 'Ghost', is_visible: 0 },                 // hidden -> dropped
    { code: 'NONAME', is_visible: 1 }                 // no name -> dropped
  ];
  const out = normalizeCommodities(raw);
  assert.deepStrictEqual(out.map((c) => c.name), ['Tungsten', 'Widow']);   // sorted, visible-only
  assert.strictEqual(out.find((c) => c.name === 'Widow').illegal, true);
  assert.strictEqual(out.find((c) => c.name === 'Tungsten').illegal, false);
});

test('bodyOfTerminal maps Pyro system to Pyro and Stanton planets to their bucket', () => {
  assert.strictEqual(bodyOfTerminal({ star_system_name: 'Pyro', planet_name: 'Pyro I' }), 'Pyro');
  assert.strictEqual(bodyOfTerminal({ star_system_name: 'Stanton', planet_name: 'ArcCorp' }), 'ArcCorp');
  assert.strictEqual(bodyOfTerminal({ star_system_name: 'Stanton', planet_name: 'microTech' }), 'microTech');
  assert.strictEqual(bodyOfTerminal({ star_system_name: 'Nyx', planet_name: null }), null);   // unbucketed system
});

test('normalizeLocations emits distinct PLACE names (station/city/outpost) with body', () => {
  const raw = [
    { star_system_name: 'Stanton', planet_name: 'ArcCorp', space_station_name: 'ARC-L1 Wide Forest Station', is_visible: 1 },
    { star_system_name: 'Stanton', planet_name: 'ArcCorp', city_name: 'Area 18', is_visible: 1 },
    { star_system_name: 'Stanton', planet_name: 'ArcCorp', space_station_name: 'ARC-L1 Wide Forest Station', is_visible: 1 }, // dup station -> once
    { star_system_name: 'Pyro', planet_name: 'Pyro I', outpost_name: 'Rustville', is_visible: 1 },
    { star_system_name: 'Stanton', planet_name: 'Hurston', space_station_name: 'Hidden', is_visible: 0 } // hidden -> dropped
  ];
  const out = normalizeLocations(raw);
  const names = out.map((l) => l.name);
  assert.deepStrictEqual(names, ['ARC-L1 Wide Forest Station', 'Area 18', 'Rustville']);  // deduped, sorted
  assert.strictEqual(out.find((l) => l.name === 'Area 18').kind, 'city');
  assert.strictEqual(out.find((l) => l.name === 'Rustville').body, 'Pyro');
  assert.strictEqual(out.find((l) => l.name === 'ARC-L1 Wide Forest Station').body, 'ArcCorp');
});
