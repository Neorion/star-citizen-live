'use strict';

/**
 * build-mining-reference.js — one-shot generator for the mining rock-crack calculator.
 * Pulls mining laser heads, modules and gadgets from the star-citizen.wiki API
 * (game-file extraction, version-tagged, keyless) and fills the module laser-power
 * factor from UEX where the wiki API omits it, then bakes everything into:
 *
 *   data/mining-reference.json   — the committed reference (served offline)
 *   app/mining-data.js           — the same payload as a browser global, so the
 *                                  standalone page works from file:// or a WebView
 *
 *   npm run build-mining        # network; run by hand after a game patch
 *
 * This is the ONLY place that touches the network (D-002). Both upstreams are
 * community projects; we redistribute a cached snapshot with attribution.
 * See DESIGN-mining-calculator.md §3 for why the wiki API is the power source and
 * UEX is not (UEX laser power is stale vs 4.10).
 */

const fs = require('fs');
const path = require('path');

const WIKI = 'https://api.star-citizen.wiki/api/v2';
const UEX = 'https://api.uexcorp.uk/2.0';
const GADGET_NAMES = ['BoreMax', 'Okunis', 'OptiMax', 'Sabir', 'Stalwart', 'Waveshift'];

// Module laser-power deltas (%) the wiki API does not expose in `modifiers` and UEX
// does not list yet. Source: the module's starcitizen.tools page, read 2026-09-24.
const LASER_POWER_OVERRIDES = {
  'clearcut-module': { laserPower: 15, active: true, uses: 6, duration: '30 seconds', source: 'starcitizen.tools/Clearcut_Module (2026-09-24)' },
  'deluge-module': { laserPower: 15, source: 'starcitizen.tools/Deluge_Module (2026-09-24)' },
  'overrun-module': { laserPower: 2, source: 'starcitizen.tools/Overrun_Module (2026-09-24)' }
};

// Hand-kept: which vehicles mount which laser sizes. Verify against the ship page
// when a vehicle changes. `mounts` = number of laser heads the crew can fire.
const SHIPS = [
  { id: 'prospector', name: 'MISC Prospector', mounts: 1, size: 1, note: 'solo' },
  { id: 'golem', name: 'Drake Golem', mounts: 1, size: 1, note: 'solo · S1 heads since 4.10' },
  { id: 'mole', name: 'ARGO MOLE', mounts: 3, size: 2, note: 'up to 3 operators' },
  { id: 'roc', name: 'Greycat ROC', mounts: 1, size: 0, note: 'ground · verify head fit' },
  { id: 'roc-ds', name: 'Greycat ROC-DS', mounts: 1, size: 0, note: 'ground · verify head fit' },
  { id: 'atls-geo', name: 'ARGO ATLS GEO', mounts: 1, size: 0, note: 'ground · verify head fit' }
];

async function getJson (url, init) {
  const res = await fetch(url, Object.assign({ headers: { Accept: 'application/json', 'Content-Type': 'application/json' } }, init || {}));
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

async function wikiSearch (query) {
  const out = [];
  for (let page = 1, last = 1; page <= last; page++) {
    const j = await getJson(`${WIKI}/items/search?page=${page}`, { method: 'POST', body: JSON.stringify({ query }) });
    out.push(...(j.data || []));
    last = (j.meta && j.meta.last_page) || 1;
  }
  return out;
}

function num (v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace('%', '').replace('−', '-'));
  return Number.isFinite(n) ? n : null;
}

function modifierMap (block) {
  const map = {};
  if (!block) return map;
  if (block.modifier_map) for (const [k, v] of Object.entries(block.modifier_map)) map[k] = num(v);
  if (Array.isArray(block.modifiers)) for (const m of block.modifiers) if (m && m.name) map[m.name] = num(m.value);
  return map;
}

// The search returns placeholder variants under the same name (e.g. three "Arbor MH1"
// records, one with 1.85-1850 power). Keep every hit; pickBest() chooses per name
// after the detail fetch: base variant first, else the record with the highest max power.
function groupByName (items) {
  const g = new Map();
  for (const it of items) if (it && it.name) (g.get(it.name) || g.set(it.name, []).get(it.name)).push(it);
  return g;
}
function pickBest (details, powerOf) {
  // Highest max power wins (placeholder variants carry stub values like 2-2000 and can
  // even be flagged as the base variant); base-variant flag only breaks ties.
  return details.sort((a, b) => (powerOf(b) - powerOf(a)) || ((b.is_base_variant === true) - (a.is_base_variant === true)))[0];
}

async function main () {
  console.log('[mining-ref] wiki: searching lasers, modules, gadgets …');
  const laserHits = groupByName((await wikiSearch('Mining Laser')).filter(i => i.type === 'WeaponMining'));
  const moduleHits = groupByName((await wikiSearch('Module')).filter(i => i.type === 'MiningModifier' && i.name !== 'Mining Modules'));
  const gadgetHits = [];
  for (const g of GADGET_NAMES) {
    const hit = (await wikiSearch(g)).find(i => i.type === 'Gadget' && i.name === g);
    if (hit) gadgetHits.push(hit);
  }
  console.log(`[mining-ref] ${laserHits.size} lasers, ${moduleHits.size} modules, ${gadgetHits.length} gadgets`);

  console.log('[mining-ref] UEX: module attributes (laser-power factor, type) …');
  // UEX is required: it is the only source that says whether a module's power figure
  // is MINING laser power (counts for cracking) or EXTRACTION laser power (does not).
  const uexMods = {};
  const j = await getJson(`${UEX}/items_attributes?id_category=30`);
  for (const a of (j.data || [])) (uexMods[a.item_name] = uexMods[a.item_name] || {})[a.attribute_name] = a.value;
  if (!Object.keys(uexMods).length) throw new Error('UEX returned no module attributes — refusing to write a reference with unclassified power modifiers');

  const detail = async (hit) => (await getJson(`${WIKI}/items/${hit.slug || hit.uuid}`)).data;
  let gameVersion = '';

  const lasers = [];
  for (const hits of laserHits.values()) {
    const all = await Promise.all(hits.map(detail));
    const d = pickBest(all, x => num(x.mining_laser && x.mining_laser.laser_power && x.mining_laser.laser_power.max) || 0);
    const ml = d.mining_laser || {}; const mods = modifierMap(ml);
    gameVersion = gameVersion || d.version;
    // Stable id: the base-variant slug (e.g. "arbor-mh1-mining-laser"), stats from the best record.
    const id = (all.find(x => x.is_base_variant === true) || d).slug.replace(/-\d+$/, '');
    lasers.push({
      id, name: d.name, size: num(d.size), manufacturer: d.manufacturer && d.manufacturer.name,
      power: { min: num(ml.laser_power && ml.laser_power.min), max: num(ml.laser_power && ml.laser_power.max) },
      extractionPower: num(ml.extraction_laser_power),
      moduleSlots: num(ml.module_slots) || 0,
      optimalRange: num(ml.optimal_range), maxRange: num(ml.maximum_range),
      resistance: mods.resistance || 0, instability: mods.laser_instability || 0,
      chargeWindow: mods.optimal_charge_window_size || 0, inertMaterials: mods.inert_materials || 0,
      version: d.version, source: 'star-citizen.wiki'
    });
  }

  const modules = [];
  for (const hits of moduleHits.values()) {
    const d = pickBest(await Promise.all(hits.map(detail)), () => 0);
    // mining_modifier carries the game-data numbers (power_modifier 0.5 = +50 % laser
    // power, unrounded resistance -15.5); mining_module carries display strings. Game
    // data wins; UEX is only a fallback for the power factor when the wiki lacks it.
    const mm = d.mining_module || {}; const mx = d.mining_modifier || {};
    const mods = Object.assign(modifierMap(mm), modifierMap(mx));
    const uex = uexMods[d.name] || {};
    const override = LASER_POWER_OVERRIDES[d.slug];
    const uexPower = num(uex['Mining Laser Power']);
    const uexExtract = num(uex['Extraction Laser Power']);
    const wikiPower = mx.power_modifier === null || mx.power_modifier === undefined ? null : Math.round(num(mx.power_modifier) * 1000) / 10;
    // The wiki's power_modifier is "the laser this module affects": mining OR extraction.
    let laserPower = 0, extractionPower = 0, powerSource = '';
    if (uexPower !== null) { laserPower = wikiPower !== null ? wikiPower : uexPower - 100; extractionPower = uexExtract !== null ? uexExtract - 100 : 0; }
    else if (uexExtract !== null) { extractionPower = wikiPower !== null ? wikiPower : uexExtract - 100; }          // extraction-only module (FLTR, Vaux, Forel …)
    else if (override) { laserPower = override.laserPower; powerSource = ` + ${override.source}`; }                    // 4.10 modules UEX has not listed yet
    else if (wikiPower !== null) { laserPower = wikiPower; powerSource = ' (power_modifier assumed mining — unclassified by UEX)'; }
    const typeStr = String(mx.type || mm.type || uex['Item Type'] || '');
    modules.push({
      id: d.slug, name: d.name, manufacturer: d.manufacturer && d.manufacturer.name,
      active: override && override.active !== undefined ? override.active : (/active/i.test(typeStr) && !/passive/i.test(typeStr)),
      uses: num(mm.uses) !== null ? num(mm.uses) : num(mx.charges) !== null && /active/i.test(typeStr) ? num(mx.charges) : (override && override.uses) || null,
      duration: mm.duration || (mx.duration ? `${mx.duration} seconds` : null) || (override && override.duration) || null,
      laserPower, resistance: mods.resistance || 0, instability: mods.instability || mods.laser_instability || 0,
      chargeWindow: mods.optimal_charge_window || mods.optimal_charge_window_size || 0,
      extractionPower,
      version: d.version,
      source: 'star-citizen.wiki + UEX (power classification)' + powerSource
    });
  }

  const gadgets = [];
  for (const hit of gadgetHits) {
    const d = await detail(hit); const mods = Object.assign(modifierMap(d.mining_gadget), modifierMap(d.mining_modifier));
    gadgets.push({
      id: d.slug, name: d.name, manufacturer: d.manufacturer && d.manufacturer.name,
      resistance: mods.resistance || 0, instability: mods.laser_instability || mods.instability || 0,
      chargeWindow: mods.optimal_charge_window_size || mods.optimal_charge_window || 0, chargeRate: mods.optimal_charge_window_rate || mods.optimal_charge_rate || 0,
      clusterModifier: mods.cluster_modifier || 0,
      version: d.version, source: 'star-citizen.wiki'
    });
  }

  const byName = (a, b) => a.name.localeCompare(b.name);
  const payload = {
    source: { wiki: WIKI, uex: UEX },
    attribution: 'Item data © Star Citizen Wiki (star-citizen.wiki, game-file extraction) and UEX Corp (uexcorp.space); community projects, cached snapshot for offline use. Break formula: community model (DESIGN-mining-calculator.md §2), not published by CIG.',
    generatedAt: new Date().toISOString(),
    gameVersion,
    model: { c: 0.2, combine: 'per-head', margin: 0.15, note: 'P_need = c*mass/(1-R_eff); mass_max = 5*P*(1-R_eff)' },
    counts: { lasers: lasers.length, modules: modules.length, gadgets: gadgets.length, ships: SHIPS.length },
    ships: SHIPS,
    lasers: lasers.sort(byName),
    modules: modules.sort(byName),
    gadgets: gadgets.sort(byName)
  };

  const dataFile = path.join(__dirname, '..', 'data', 'mining-reference.json');
  const jsFile = path.join(__dirname, '..', 'app', 'mining-data.js');
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify(payload, null, 2) + '\n');
  fs.writeFileSync(jsFile, '// GENERATED by scripts/build-mining-reference.js — do not edit; run `npm run build-mining`.\n' +
    'window.MINING_REFERENCE = ' + JSON.stringify(payload) + ';\n');
  console.log(`[mining-ref] wrote ${dataFile} and ${jsFile} — game ${gameVersion}; ${lasers.length} lasers, ${modules.length} modules, ${gadgets.length} gadgets`);
}

main().catch((e) => { console.error('[mining-ref] FAILED:', e.message); process.exit(1); });
