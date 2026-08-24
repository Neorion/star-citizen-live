'use strict';

/**
 * uexClient.js — thin, zero-dependency client for the public UEX Corp API
 * (https://api.uexcorp.space/2.0). Used at BUILD TIME by scripts/build-uex-vocab.js
 * to bake a committed reference dataset (data/uex-reference.json) that the app
 * then serves OFFLINE — the running app never calls UEX at runtime. This keeps
 * cargo/commodity lookups offline-first and read-only, mirroring how
 * data/ships/catalog.json is baked ahead of time instead of fetched live.
 *
 * The /2.0 reference endpoints (commodities, terminals) are PUBLIC and keyless.
 * Every response is a { status, data:[...] } envelope. Uses Node's built-in global
 * fetch (Node 18+), so no npm dependency.
 *
 * Data facts verified live against the API (205 commodities, 823 terminals):
 *  - commodity: { name, code, kind, is_illegal, is_visible, weight_scu, ... }
 *  - terminal:  { name, type, star_system_name, planet_name, orbit_name, moon_name,
 *                 space_station_name, outpost_name, city_name, is_cargo_center, ... }
 *    The game/log names the PLACE (space station / city / outpost), not UEX's
 *    "Admin - ARC-L1" terminal name — so locations normalize on the place names.
 */

const BASE_URL = 'https://api.uexcorp.space/2.0';

const STANTON_BODIES = { hurston: 'Hurston', crusader: 'Crusader', arccorp: 'ArcCorp', microtech: 'microTech' };

/**
 * Resolve the "body" (planet/moon bucket, or Pyro) for a raw UEX terminal record.
 * @param {object} t - raw terminal record from the UEX /terminals endpoint
 * @returns {string|null}
 */
function bodyOfTerminal (t) {
  if (t && /pyro/i.test(String(t.star_system_name || ''))) return 'Pyro';
  const p = String((t && t.planet_name) || '').toLowerCase().replace(/[^a-z]/g, '');
  return STANTON_BODIES[p] || null;
}

/**
 * Fetch and parse one UEX /2.0 endpoint.
 * @param {string} endpoint - endpoint path, e.g. 'commodities' or 'terminals'
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<object[]>}
 */
async function fetchEndpoint (endpoint, opts = {}) {
  const url = `${BASE_URL}/${String(endpoint).replace(/^\/+/, '')}`;
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'star-citizen-live/uex-vocab' }, signal: opts.signal });
  if (!res.ok) throw new Error(`UEX ${endpoint}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.status && json.status !== 'ok') throw new Error(`UEX ${endpoint}: status ${json.status}`);
  return Array.isArray(json.data) ? json.data : [];
}

/**
 * Normalize raw UEX commodity records into the shape we bake into data/uex-reference.json.
 * @param {object[]} raw - raw commodity records from the UEX /commodities endpoint
 * @returns {{ name: string, code: string|null, kind: string|null, illegal: boolean }[]}
 */
function normalizeCommodities (raw) {
  return (raw || [])
    .filter((c) => c && c.name && c.is_visible)
    .map((c) => ({ name: String(c.name).trim(), code: c.code || null, kind: c.kind || null, illegal: !!c.is_illegal }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Normalize raw UEX terminal records into distinct PLACE-name location rows
 * (station / city / outpost) with a resolved body, for the committed reference.
 * @param {object[]} raw - raw terminal records from the UEX /terminals endpoint
 * @returns {{ name: string, body: string|null, system: string|null, planet: string|null, kind: string }[]}
 */
function normalizeLocations (raw) {
  const byName = new Map();
  for (const t of raw || []) {
    if (!t || !t.is_visible) continue;
    const body = bodyOfTerminal(t);
    const system = t.star_system_name || null;
    const candidates = [
      [t.space_station_name, 'station'],
      [t.city_name, 'city'],
      [t.outpost_name, 'outpost']
    ];
    for (const [nameRaw, kind] of candidates) {
      const name = nameRaw && String(nameRaw).trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (!byName.has(key)) byName.set(key, { name, body, system, planet: t.planet_name || null, kind });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Fetch and normalize the full UEX reference dataset (commodities + locations).
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ source: string, commodities: object[], locations: object[] }>}
 */
async function fetchReference (opts = {}) {
  const [commoditiesRaw, terminalsRaw] = await Promise.all([
    fetchEndpoint('commodities', opts),
    fetchEndpoint('terminals', opts)
  ]);
  return {
    source: BASE_URL,
    commodities: normalizeCommodities(commoditiesRaw),
    locations: normalizeLocations(terminalsRaw)
  };
}

module.exports = { BASE_URL, fetchEndpoint, fetchReference, normalizeCommodities, normalizeLocations, bodyOfTerminal };
