'use strict';

/**
 * Friendly names for the location ids the transaction ledger sees in
 * Game.log, derived from the wiki-backed location catalog
 * (functions/locationCatalog.js) — never from a hard-coded name table.
 *
 * Observed id shapes (one player's 1,933 real transactions, 2026-10-08):
 *   RR_ARC_L1 · RR_MIC_L5 …        Rest & Relax Lagrange stations        -> "ARC-L1 Wide Forest Station" (catalog)
 *   RR_HUR_LEO · RR_P2_LEO         low-orbit stations                     -> candidates from the catalog (inferred)
 *   Stanton2_Orison · Stanton3_Area18  landing zones                      -> catalog landing zone (exact)
 *   RR_JP_NyxPyro                  jump-point station                     -> gateway candidates (inferred)
 *   RR_P1_L1 · AsteroidClusterBase_Nyx_Social_Keeger_1  not derivable    -> unresolved (raw id shown)
 *
 * Confidence follows the ledger's rule: `exact` only when the token pins one
 * catalog entry, `inferred` with every real candidate listed, else null.
 */

const PLANET_CODES = {
  ARC: { planet: 'ArcCorp', system: 'Stanton' },
  CRU: { planet: 'Crusader', system: 'Stanton' },
  HUR: { planet: 'Hurston', system: 'Stanton' },
  MIC: { planet: 'microTech', system: 'Stanton' }
};

const STATION_TYPES = /^Manmade/;

function norm (s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * @param {string} id Location id from a `RequestLocationInventory` line.
 * @param {{ searchLocations: function, listLocations: function }} catalog functions/locationCatalog.js (or a stub).
 * @returns {{ display: string, confidence: 'exact'|'inferred', candidates?: Array<string>, system: string|null }|null}
 */
function resolveFromCatalog (id, catalog) {
  if (!id || !catalog) return null;
  const s = String(id);
  let m;

  // RR_<planet>_L<n> — a Lagrange-point Rest & Relax station.
  if ((m = s.match(/^RR_(ARC|CRU|HUR|MIC)_L(\d)$/i))) {
    const token = `${m[1].toUpperCase()}-L${m[2]}`;
    const hits = safeSearch(catalog, token).filter((x) => STATION_TYPES.test(x.type || '') && norm(x.name).startsWith(norm(token)));
    if (hits.length === 1) return { display: hits[0].name, confidence: 'exact', system: hits[0].system || PLANET_CODES[m[1].toUpperCase()].system };
    if (hits.length > 1) return inferred(hits);
    return null;
  }

  // RR_<planet>_LEO — the station in low orbit of that planet.
  if ((m = s.match(/^RR_(ARC|CRU|HUR|MIC)_LEO$/i))) {
    const code = PLANET_CODES[m[1].toUpperCase()];
    // Orbital objects of that planet, minus the ones that cannot host a kiosk
    // (comm arrays, relays, probes, service pads). Still reported as inferred.
    const hits = safeList(catalog).filter((x) => STATION_TYPES.test(x.type || '') &&
      norm(x.parent) === norm(code.planet) && !/-L\d/.test(x.name || '') &&
      !/(Comm Array|Relay|Probe|Cry-Astro|Service \d)/i.test(x.name || ''));
    // Found by elimination, not by a name token in the id — never better than inferred.
    if (hits.length) return inferred(hits);
    return null;
  }

  // <System><n>_<Name> — a landing zone such as Stanton2_Orison, Stanton3_Area18.
  if ((m = s.match(/^([A-Za-z]+)\d+_([A-Za-z][A-Za-z0-9]+)$/))) {
    const hits = safeSearch(catalog, m[2]).filter((x) => norm(x.name) === norm(m[2]));
    const zones = hits.filter((x) => /LandingZone/i.test(x.type || ''));
    const pick = zones.length ? zones : hits;
    if (pick.length === 1) return { display: pick[0].name, confidence: 'exact', system: pick[0].system || m[1] };
    if (pick.length > 1) return inferred(pick);
    return null;
  }

  // RR_JP_<A><B> — a jump-point gateway station between two systems.
  if ((m = s.match(/^RR_JP_([A-Z][a-z]+)([A-Z][a-z]+)$/))) {
    // The two sides of the jump: "<B> Gateway" in system A and "<A> Gateway" in system B.
    const pair = [[m[1], m[2]], [m[2], m[1]]];
    const hits = safeList(catalog).filter((x) => pair.some(([here, there]) =>
      norm(x.name) === norm(`${there} Gateway`) && (norm(x.system) === norm(here) || norm(x.parent) === norm(here))));
    if (hits.length === 1) return { display: hits[0].name, confidence: 'exact', system: hits[0].system };
    if (hits.length > 1) return inferred(hits);
    return null;
  }

  return null;
}

function inferred (hits) {
  const names = [...new Set(hits.map((x) => `${x.name}${x.system ? ` (${x.system})` : ''}`))];
  return { display: names.join(' or ') + ' (unconfirmed)', confidence: 'inferred', candidates: names, system: hits[0].system || null };
}

function safeSearch (catalog, q) {
  try { return catalog.searchLocations(q, { limit: 12 }) || []; } catch (_) { return []; }
}

function safeList (catalog) {
  try { return catalog.listLocations() || []; } catch (_) { return []; }
}

module.exports = { resolveFromCatalog, PLANET_CODES };
