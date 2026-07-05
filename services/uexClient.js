'use strict';

/**
 * uexClient.js — thin, zero-dependency client for the public UEX Corp API
 * (https://api.uexcorp.space/2.0). Used at BUILD TIME by scripts/build-uex-vocab.js
 * to bake a committed reference dataset (data/uex-reference.json) that the relay
 * then serves OFFLINE — the running service never calls UEX (D-002: zero runtime
 * deps, offline-first, read-only).
 *
 * ┌─ WHY A CLIENT, NOT JUST A SCRIPT ───────────────────────────────────────────┐
 * │ Kept as a reusable module (fetch + normalizers) so a future LIVE refresh —   │
 * │ or price/route features — can call the same normalized surface instead of    │
 * │ re-deriving it. The generator is one caller today; live is a future caller.  │
 * └──────────────────────────────────────────────────────────────────────────────┘
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

// The four Stanton planets are our celestial-body buckets; everything in the Pyro
// system collapses to a single 'Pyro' bucket (matches CargoRouter's BODY_ORDER).
const STANTON_BODIES = { hurston: 'Hurston', crusader: 'Crusader', arccorp: 'ArcCorp', microtech: 'microTech' };

// Resolve a terminal to one of our body buckets. Pyro system -> 'Pyro'; Stanton ->
// the parent planet (a moon/Lagrange station still belongs to its planet's bucket).
function bodyOfTerminal (t) {
  if (t && /pyro/i.test(String(t.star_system_name || ''))) return 'Pyro';
  const p = String((t && t.planet_name) || '').toLowerCase().replace(/[^a-z]/g, '');
  return STANTON_BODIES[p] || null;
}

// GET a /2.0 endpoint and return its `data` array. Throws on a non-ok envelope.
async function fetchEndpoint (endpoint, opts = {}) {
  const url = `${BASE_URL}/${String(endpoint).replace(/^\/+/, '')}`;
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'star-citizen-live/uex-vocab' }, signal: opts.signal });
  if (!res.ok) throw new Error(`UEX ${endpoint}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.status && json.status !== 'ok') throw new Error(`UEX ${endpoint}: status ${json.status}`);
  return Array.isArray(json.data) ? json.data : [];
}

// Compact, dropdown-ready commodity: keep only what a cargo picker needs.
function normalizeCommodities (raw) {
  return (raw || [])
    .filter((c) => c && c.name && c.is_visible)
    .map((c) => ({ name: String(c.name).trim(), code: c.code || null, kind: c.kind || null, illegal: !!c.is_illegal }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Distinct PLACE names (space station / city / outpost) → body, from the terminal
// list. One terminal can surface several place names; we emit each once, preferring
// the most specific. Deduped by lowercased name.
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

// Fetch + normalize both reference lists in one call (the generator's entry point).
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
