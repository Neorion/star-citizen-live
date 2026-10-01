'use strict';

/**
 * Death Report — turn a detected death incident into a readable report.
 *
 * Pure leaf module (data in, data out): cause classification, headline,
 * gear categorisation, timeline, list row and Markdown export. Detection
 * lives in functions/deathDetector.js; persistence in deathReportStore.js.
 *
 * Honesty: a report is INFERRED from one client's Game.log. `status` says how
 * far the evidence goes — `confirmed` (corpse recorded / kill line) vs
 * `unconfirmed` (a trigger with no corpse: survived, revived or ejected
 * alive). The kill-based causes (killed_by_*, suicide, environmental,
 * vehicle_destroyed_combat) can only occur on SC <= 4.3.0 logs — later
 * builds do not log kills, so an on-foot death there is `unknown`.
 * Reports never carry raw log lines, GEIDs or item instance ids.
 */

const crypto = require('crypto');
const { shipName, isNPC } = require('./parser');
const { LAG_SPIKE_MS, CAUSE_LABELS, fmtSpeed, groupItems } = require('./deathReportView');

const CAUSES = [
  'vehicle_collision_pilot',
  'vehicle_collision_passenger',
  'vehicle_destroyed_combat',
  'killed_by_player',
  'killed_by_npc',
  'suicide',
  'environmental',
  'vehicle_destroyed_unknown',
  'unknown'
];

const ENVIRONMENTAL_DAMAGE = new Set(['Suffocation', 'Bleed', 'Crash', 'Explosion', 'Unknown']);

const MANUFACTURERS = {
  AEGS: 'Aegis', ANVL: 'Anvil', AOPOA: 'Aopoa', ARGO: 'Argo', BANU: 'Banu', CNOU: 'Consolidated Outland',
  CRUS: 'Crusader', DRAK: 'Drake', ESPR: 'Esperia', GAMA: 'Gatac', GRIN: 'Greycat', KRIG: 'Kruger',
  MISC: 'MISC', MRAI: 'Mirai', MIRAI: 'Mirai', ORIG: 'Origin', RSI: 'RSI', TMBL: 'Tumbril',
  VNCL: 'Vanduul', XIAN: 'Aopoa', XNAA: 'Aopoa'
};

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'];

/**
 * @param {string} content
 * @returns {string} 32-hex content id (same shape as cumulativeHistory ids).
 */
function idFor (content) {
  return crypto.createHash('sha256').update(String(content)).digest('hex').slice(0, 32);
}

/**
 * Stable report id. A confirmed death is keyed by its corpse body id so the
 * live tail and a later full rescan of the same log land on one record even
 * when the live tail joined after the trigger line.
 * @param {Object} incident
 * @returns {string}
 */
function reportId (incident) {
  if (incident.bodyId) return idFor(['deathreport', 'body', incident.bodyId].join('|'));
  return idFor(['deathreport', 'trigger', incident.triggerAt || '', incident.vehicle || incident.player || ''].join('|'));
}

/**
 * Corpse item port -> gear category.
 * @param {string} port
 * @returns {string}
 */
function itemCategory (port) {
  const p = String(port || '');
  if (/^Armor_/i.test(p)) return 'armor';
  if (/^wep_/i.test(p)) return 'weapon';
  if (/^magazine_attach/i.test(p)) return 'magazine';
  if (/^(optics_attach|barrel_attach|underbarrel_attach|module_attach)/i.test(p)) return 'attachment';
  if (/^grenade_attach/i.test(p)) return 'grenade';
  if (/^(medPen_|oxyPen_)/i.test(p)) return 'medical';
  if (/^utility_attach/i.test(p)) return 'utility';
  if (/^backpack$/i.test(p)) return 'backpack';
  if (/_ItemPort$/i.test(p) || /^(helmet_visor|mobiglas_attach)$/i.test(p)) return 'character';
  return 'other';
}

/**
 * "ANVL_Asgard_123456789012" -> "Anvil Asgard". Falls back to the raw class
 * string so a missing name never blocks a report.
 * @param {string|null} vehicle Vehicle instance or class id from the log.
 * @returns {string|null}
 */
function vehicleDisplayName (vehicle) {
  if (!vehicle) return null;
  const name = shipName(vehicle);
  if (!name) return String(vehicle).replace(/_\d{6,}$/, '');
  const maker = MANUFACTURERS[String(vehicle).split('_')[0]];
  return maker ? `${maker} ${name}` : name;
}

/**
 * "pyro4" -> "Pyro IV", "OOC_Stanton_2b_Daymar" -> "Daymar"; else the raw zone.
 * @param {string|null} zone
 * @returns {string|null}
 */
function zoneDisplayName (zone) {
  if (!zone) return null;
  const z = String(zone);
  const body = z.match(/^OOC_[A-Za-z]+_\d+[a-z]?_(.+)$/);
  if (body) return body[1].replace(/_/g, ' ');
  const planet = z.match(/^([a-z]+)(\d)([a-z]?)$/);
  if (planet) {
    return planet[1].charAt(0).toUpperCase() + planet[1].slice(1) + ' ' + ROMAN[Number(planet[2])] + planet[3];
  }
  return z;
}

function isUnknownName (name) {
  return !name || /^unknown$/i.test(String(name));
}

/**
 * Cause code from the evidence collected for one incident. First match wins.
 * @param {Object} incident Detector incident (see deathDetector.js).
 * @returns {string} One of CAUSES.
 */
function classifyCause (incident) {
  const c = incident.collision;
  const k = incident.kill;
  const vd = incident.vehicleDestroyed;
  // An unconfirmed pilot collision (no corpse) keeps this cause; `status` carries the doubt.
  if (c && c.playerPilot) return 'vehicle_collision_pilot';
  if (c && !c.playerPilot) return 'vehicle_collision_passenger';
  if (vd && !isUnknownName(vd.causer) && vd.causer !== incident.player) return 'vehicle_destroyed_combat';
  if (k) {
    if (k.killer && k.killer === k.victim) return 'suicide';
    if (isUnknownName(k.killer) && ENVIRONMENTAL_DAMAGE.has(k.damageType)) return 'environmental';
    if (isNPC(k.killer)) return 'killed_by_npc';
    if (k.killer) return 'killed_by_player';
  }
  // Ejected from a destroyed ship with NO collision line: the log says the ship
  // was destroyed, not what destroyed it. Never call that a collision — on a
  // 52.9M-line real corpus every such ejection (47 of 47) had no collision line.
  if (incident.actorDead) return 'vehicle_destroyed_unknown';
  return 'unknown';
}

function secondsBetween (a, b) {
  const t0 = Date.parse(a);
  const t1 = Date.parse(b);
  if (Number.isNaN(t0) || Number.isNaN(t1)) return null;
  return Math.round((t1 - t0) / 1000);
}

/**
 * One-sentence headline for a report.
 * @param {Object} r Report fields (cause, vehicleName, zoneName, …).
 * @returns {string}
 */
function headline (r) {
  const zone = r.zoneName || r.zone || 'an unknown location';
  const ship = r.vehicleName || r.vehicle || 'ship';
  let text;
  switch (r.cause) {
    case 'vehicle_collision_pilot': {
      const part = r.impactPart ? `${String(r.impactPart).toLowerCase()}-first ` : '';
      const speed = fmtSpeed(r.impactSpeed);
      text = `Crashed ${ship} ${part}into ${r.collider || 'an unknown object'} on ${zone}` + (speed ? ` at ${speed}` : '');
      break;
    }
    case 'vehicle_collision_passenger':
      text = `Died as a passenger when ${ship} hit ${r.collider || 'an unknown object'} on ${zone}`;
      break;
    case 'vehicle_destroyed_combat':
      text = `${ship} destroyed by ${r.killer || 'unknown'}` + (r.damageType ? ` (${r.damageType})` : '') + ` in ${zone}`;
      break;
    case 'killed_by_player':
      text = `Killed by ${r.killer} with ${r.weaponClass || 'unknown weapon'}` + (r.damageType ? ` (${r.damageType})` : '') + ` in ${zone}`;
      break;
    case 'killed_by_npc':
      text = `Killed by an NPC (${r.killer}) in ${zone}`;
      break;
    case 'suicide':
      text = 'Respawned by choice (backspace)';
      break;
    case 'environmental':
      text = `${r.damageType || 'Environmental damage'} in ${zone}`;
      break;
    case 'vehicle_destroyed_unknown':
      text = `Ejected from destroyed ${ship} on ${zone} — what destroyed it is not in the log`;
      break;
    default:
      text = `Died in ${zone} — cause not identifiable from log`;
  }
  // No corpse manifest followed. The log cannot tell these apart, so say all three.
  if (r.status === 'unconfirmed') text += ' — no corpse logged (survived, revived, or the body was lost with the ship)';
  if ((r.modifiers || []).includes('ttd_expired')) {
    const s = secondsBetween(r.incapacitatedAt, r.confirmedAt);
    text += ' — incapacitated, no revive' + (s != null ? `, died after ${s} s` : '');
  }
  return text;
}

function contextLabel (c) {
  switch (c.kind) {
    case 'route': return `Quantum route calculated from ${c.start}` + (c.vehicle ? ` (${vehicleDisplayName(c.vehicle)})` : '');
    case 'quantum_target': return 'Quantum target selected';
    case 'no_route': return 'Navigation: no route loaded (manual flight)';
    case 'inventory_closed': return 'Inventory closed';
    case 'cvar_displayinfo': return `cvar r_DisplayInfo = ${c.value} (FPS overlay toggled)`;
    case 'location': return 'Inventory location changed';
    default: return c.kind;
  }
}

function buildTimeline (incident, report) {
  const rows = [];
  const push = (at, kind, label, line) => { if (at) rows.push({ at, kind, label, line: line || null }); };
  for (const c of incident.context || []) push(c.at, 'context', contextLabel(c), c.line);
  if (incident.collision) {
    push(incident.collision.at, 'trigger',
      `FatalCollision — ${incident.collision.part}, zone ${incident.collision.zone}`, incident.collision.line);
  }
  if (incident.vehicleDestroyed) {
    push(incident.vehicleDestroyed.at, 'trigger',
      `Vehicle destroyed — ${vehicleDisplayName(incident.vehicleDestroyed.vehicle)}`, incident.vehicleDestroyed.line);
  }
  if (incident.actorDead) {
    push(incident.actorDead.at, 'trigger',
      `ActorState Dead — ejected from ${vehicleDisplayName(incident.actorDead.fromZone)} to ${incident.actorDead.toZone}`,
      incident.actorDead.line);
  }
  if (incident.kill) {
    push(incident.kill.at, 'trigger', `Actor Death — ${incident.kill.damageType || 'unknown damage'}`, incident.kill.line);
  }
  if (incident.incapacitatedAt) push(incident.incapacitatedAt, 'incapacitated', 'HUD: Incapacitated', incident.incapLine);
  if (incident.confirmedAt) {
    const label = incident.items.length
      ? `Corpse recorded — ${incident.items.length} items (${report.itemsLost} lost, ${report.itemsKept} character-bound)`
      : 'Death confirmed';
    push(incident.confirmedAt, 'confirmed', label, incident.confirmedLine);
  }
  if (incident.corpseMarkerAt) push(incident.corpseMarkerAt, 'confirmed', 'Corpse marker detached', incident.corpseMarkerLine);
  if (incident.respawnedAt) push(incident.respawnedAt, 'respawn', 'Spawned', incident.respawnLine);
  // Line order is the truth: Game.log timestamps are not strictly monotonic.
  return rows.sort((a, b) => (a.line && b.line) ? a.line - b.line : String(a.at).localeCompare(String(b.at)));
}

/**
 * Build the stored/served report from a detector incident.
 * @param {Object} incident Detector incident state.
 * @param {Object} [opts]
 * @param {function(string): string|null} [opts.vehicleName] Display-name resolver override.
 * @param {function(string): string|null} [opts.zoneName] Display-name resolver override.
 * @returns {Object} Death report (plain JSON).
 */
function buildReport (incident, opts = {}) {
  const c = incident.collision || null;
  const k = incident.kill || null;
  const vd = incident.vehicleDestroyed || null;
  const vehicle = (c && c.vehicle) || (incident.actorDead && incident.actorDead.fromZone) || (vd && vd.vehicle) || null;
  const zone = (c && c.zone) || (incident.actorDead && incident.actorDead.toZone) || (k && k.zone) || (vd && vd.zone) || null;
  const nameOfVehicle = opts.vehicleName || vehicleDisplayName;
  const nameOfZone = opts.zoneName || zoneDisplayName;

  const items = (incident.items || []).map((i) => ({
    itemClass: i.itemClass,
    port: i.port,
    classGuid: i.classGuid || null,
    category: itemCategory(i.port),
    kept: !!i.kept
  }));
  const itemsKept = items.filter((i) => i.kept).length;

  const modifiers = [];
  if (incident.incapacitatedAt && incident.confirmedAt) modifiers.push('ttd_expired');
  if (c && c.frameMs > LAG_SPIKE_MS) modifiers.push('possible_lag_spike');

  const terrain = !!(c && c.colliderId === -1 && isUnknownName(c.colliderEntity));
  const report = {
    id: null,
    status: incident.status === 'confirmed' ? 'confirmed' : (incident.status === 'unconfirmed' ? 'unconfirmed' : 'open'),
    player: incident.player || 'unknown',
    sessionId: incident.sessionId || null,
    build: incident.build || null,
    logFile: incident.logFile || null,
    lineStart: incident.lineStart || null,
    lineEnd: incident.lineEnd || null,
    cause: null,
    summary: null,
    modifiers,
    triggerAt: incident.triggerAt || null,
    incapacitatedAt: incident.incapacitatedAt || null,
    incapSource: incident.incapacitatedAt ? (incident.incapSource || 'during-incident') : null,
    confirmedAt: incident.confirmedAt || null,
    respawnedAt: incident.respawnedAt || null,
    zone,
    zoneName: zone ? (nameOfZone(zone) || zone) : null,
    pos: c ? c.pos : null,
    vehicle,
    vehicleName: vehicle ? (nameOfVehicle(vehicle) || vehicle) : null,
    // Collision line says so, or I released this ship's controls right before
    // the ejection. Otherwise unknown — never assume "passenger".
    wasPilot: c ? !!c.playerPilot : (incident.controlReleasedAt ? true : null),
    controlReleasedAt: incident.controlReleasedAt || null,
    impactPart: c ? c.part : null,
    impactSpeed: c ? Math.round(c.speed * 100) / 100 : null,
    relVel: c ? c.relVel : null,
    collider: c ? (terrain ? 'terrain' : (isUnknownName(c.hitEntity) ? (c.colliderName || 'unknown object') : c.hitEntity)) : null,
    colliderEntity: c ? c.colliderEntity : null,
    colliderDistance: c ? c.distance : null,
    lastFrameMs: c ? Math.round(c.frameMs * 100) / 100 : null,
    killer: (k && k.killer) || (vd && vd.causer) || null,
    weaponClass: k ? k.weaponClass : null,
    damageType: (k && k.damageType) || (vd && vd.damageType) || null,
    bodyId: incident.bodyId || null,
    corpseId: incident.corpseId || null,
    respawnLocationId: incident.respawnLocationId || null,
    // How the incident ended: respawn | superseded | timeout | session-end | end-of-log (null while open).
    closedBy: incident.closeReason || null,
    items,
    itemsLost: items.length - itemsKept,
    itemsKept,
    timeline: [],
    evidence: (incident.evidence || []).map((e) => ({ line: e.line, at: e.at, signal: e.signal })),
    inferred: true
  };
  report.id = reportId(Object.assign({}, incident, { vehicle }));
  report.cause = classifyCause(incident);
  report.summary = headline(report);
  report.timeline = buildTimeline(incident, report);
  return report;
}

/**
 * Compact row for list views.
 * @param {Object} r Death report.
 * @returns {Object}
 */
function listRow (r) {
  return {
    id: r.id,
    status: r.status,
    player: r.player,
    at: r.confirmedAt || r.triggerAt,
    confirmedAt: r.confirmedAt,
    cause: r.cause,
    summary: r.summary,
    zoneName: r.zoneName,
    vehicleName: r.vehicleName,
    itemsLost: r.itemsLost,
    modifiers: r.modifiers || []
  };
}

function clock (iso) {
  return iso ? String(iso).slice(11, 23) : '';
}

/**
 * Markdown export — same layout as the dashboard detail page.
 * @param {Object} r Death report.
 * @returns {string}
 */
function toMarkdown (r) {
  const out = [];
  out.push(`# Death report — ${r.status}`);
  out.push('');
  out.push(`**${r.summary}**`);
  out.push('');
  out.push(`- Pilot: ${r.player}`);
  out.push(`- When (UTC): ${r.confirmedAt || r.triggerAt || 'unknown'}`);
  out.push(`- Cause: ${r.cause}` + (r.modifiers.length ? ` · modifiers: ${r.modifiers.join(', ')}` : ''));
  if (r.impactPart) {
    const v = r.relVel ? ` · relative velocity (${r.relVel.x.toFixed(2)}, ${r.relVel.y.toFixed(2)}, ${r.relVel.z.toFixed(2)})` : '';
    out.push(`- Impact: part ${r.impactPart}${v} → ${fmtSpeed(r.impactSpeed)}`);
  }
  if (r.collider) out.push(`- Collider: ${r.collider}` + (r.colliderDistance != null ? ` · distance ${r.colliderDistance.toFixed(1)} m` : ''));
  if (r.lastFrameMs != null) {
    out.push(`- Frame time: ${r.lastFrameMs.toFixed(1)} ms (${r.lastFrameMs > LAG_SPIKE_MS ? 'possible lag spike' : 'normal — no lag spike'})`);
  }
  if (r.wasPilot != null) out.push(`- Pilot seat: ${r.wasPilot ? 'yes' : 'no'}`);
  if (r.killer) out.push(`- Killer: ${r.killer}` + (r.weaponClass ? ` · ${r.weaponClass}` : '') + (r.damageType ? ` · ${r.damageType}` : ''));
  if (r.zone) {
    const p = r.pos ? ` · x ${r.pos.x.toFixed(2)} · y ${r.pos.y.toFixed(2)} · z ${r.pos.z.toFixed(2)}` : '';
    out.push(`- Location: ${r.zone} (${r.zoneName})${p}`);
  }
  if (r.vehicleName) out.push(`- Ship: ${r.vehicleName}`);
  if (r.build) out.push(`- Game build: ${r.build}`);
  out.push('');
  out.push('## Timeline (UTC)');
  out.push('');
  for (const t of r.timeline) out.push(`- \`${clock(t.at)}\` **${t.kind}** — ${t.label}`);
  out.push('');
  out.push(`## Gear left on corpse (${r.itemsLost})`);
  out.push('');
  const groups = groupItems(r);
  if (!groups.length) out.push('_No corpse manifest in the log._');
  for (const g of groups) {
    const names = g.items.map((i) => (i.count > 1 ? `${i.itemClass} ×${i.count}` : i.itemClass)).join(', ');
    out.push(g.kept ? `- **Character-bound, not lost (${g.count}):** ${names}` : `- **${g.label}** (${g.count}): ${names}`);
  }
  out.push('');
  out.push('_Inferred from one client Game.log; not officer-validated._');
  out.push('');
  return out.join('\n');
}

module.exports = {
  CAUSES,
  CAUSE_LABELS,
  LAG_SPIKE_MS,
  idFor,
  reportId,
  itemCategory,
  vehicleDisplayName,
  zoneDisplayName,
  classifyCause,
  headline,
  buildReport,
  listRow,
  groupItems,
  toMarkdown
};
