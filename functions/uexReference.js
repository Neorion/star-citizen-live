'use strict';

/**
 * Known UEX Corp reference data (commodities + locations) — baked from
 * data/uex-reference.json (built offline via `npm run build-vocab`; see
 * scripts/build-uex-vocab.js and services/uexClient.js). Mirrors the
 * lazy-cached load / {reload} option pattern used by functions/shipCatalog.js.
 */

const fs = require('fs');
const path = require('path');

const REFERENCE_PATH = path.join(__dirname, '..', 'data', 'uex-reference.json');

/** @type {{ commodities: object[], locations: object[], bodyIndex: Map<string, string|null>, loadedAt: number }|null} */
let _cache = null;

/**
 * @param {string} value
 * @returns {string}
 */
function normName (value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Load (and cache) the UEX reference dataset from disk.
 * @param {{ reload?: boolean }} [opts]
 * @returns {{ commodities: object[], locations: object[], bodyIndex: Map<string, string|null>, loadedAt: number }}
 */
function loadReference (opts = {}) {
  if (_cache && !opts.reload) return _cache;
  let commodities = [];
  let locations = [];
  try {
    const raw = JSON.parse(fs.readFileSync(REFERENCE_PATH, 'utf8'));
    commodities = Array.isArray(raw.commodities) ? raw.commodities : [];
    locations = Array.isArray(raw.locations) ? raw.locations : [];
  } catch (_) {
    commodities = [];
    locations = [];
  }
  const bodyIndex = new Map();
  for (const loc of locations) {
    if (!loc || !loc.name) continue;
    const key = normName(loc.name);
    if (key && !bodyIndex.has(key)) bodyIndex.set(key, loc.body || null);
  }
  _cache = {
    commodities: commodities.slice(),
    locations: locations.slice(),
    bodyIndex,
    loadedAt: Date.now()
  };
  return _cache;
}

/**
 * @returns {object[]}
 */
function listCommodities () {
  return loadReference().commodities.slice();
}

/**
 * @returns {object[]}
 */
function listLocations () {
  return loadReference().locations.slice();
}

/**
 * Resolve the body (planet/moon bucket, or "Pyro") for a location name, matched
 * case/punctuation-insensitively against the baked reference.
 * @param {string} name
 * @returns {string|null}
 */
function bodyOfLocation (name) {
  const ref = loadReference();
  const key = normName(name);
  if (!key) return null;
  return ref.bodyIndex.has(key) ? ref.bodyIndex.get(key) : null;
}

/**
 * Reference status for APIs.
 * @returns {{ type: string, count: number, path: string, loadedAt: string }}
 */
function referenceStatus () {
  const ref = loadReference();
  return {
    type: 'UexReference',
    count: ref.commodities.length + ref.locations.length,
    path: 'data/uex-reference.json',
    loadedAt: new Date(ref.loadedAt).toISOString()
  };
}

module.exports = {
  REFERENCE_PATH,
  normName,
  loadReference,
  listCommodities,
  listLocations,
  bodyOfLocation,
  referenceStatus
};
