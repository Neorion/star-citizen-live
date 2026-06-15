'use strict';

/**
 * Star Citizen Game.log parser (M3).
 *
 * Star Citizen 4.x log lines look like:
 *   <2026-06-09T06:23:07.643Z> [Notice] <EventType> ...free text / key=value...
 * or plain header lines:
 *   <2026-06-09T06:22:54.104Z> Log started on ...
 *
 * parseLine() pulls out the timestamp, the [Notice]-style channel, the
 * <EventType> tag, and the remainder, then runs a table of RULES to classify
 * the line into a meaningful event (kill, player login, vehicle destruction,
 * quantum travel, level load, etc.) and extract structured fields.
 *
 * VALIDATION STATUS (important - see PROGRESS.md):
 *   - rules marked  VERIFIED  were tested against a real Game.log.
 *   - rules marked  UNVERIFIED  are built from the documented/community SC 4.x
 *     format but have NOT yet been confirmed against a real combat log. The
 *     supplied sample log was a hangar session with no combat. Treat these as
 *     drafts to confirm against a real kill/vehicle log, and adjust the regex
 *     if the live format differs.
 */

const LINE = /^<([^>]+)>\s*(?:\[(\w+)\]\s*)?(?:<([^>]+)>)?\s*(.*)$/;

// Each rule: { kind, channel?, test(regex), fields(match) -> {...} }
const RULES = [
  // --- VERIFIED against the supplied real Game.log ---
  {
    kind: 'player:login', tag: 'Legacy login response',
    test: /User Login Success - Handle\[([^\]]+)\]/,
    fields: (m) => ({ handle: m[1] })
  },
  {
    kind: 'character:status', tag: 'AccountLoginCharacterStatus_Character',
    test: /geid (\d+)/,
    fields: (m) => ({ geid: m[1] })
  },
  {
    kind: 'session:gamemode', // game mode created / seeded
    test: /SeedGameRulesAndMode(?: Success)?>.*GameMode\[([^\]]+)\]/,
    fields: (m) => ({ gameMode: m[1] })
  },
  {
    kind: 'session:level', // "============ Loading level megamap ============"
    test: /Loading level (\w+)/,
    fields: (m) => ({ level: m[1] })
  },
  {
    kind: 'session:start', // "Log started on Fri Jun 12 20:04:54 2026" - first lines of a fresh log
    test: /Log started on (.+?)\s*$/,
    fields: (m) => ({ startedOn: m[1] })
  },

  // --- VERIFIED against a real combat-mission session (2026-06-12) ---
  // The client log does NOT record explicit PVE/NPC kills, but it logs the
  // mission/contract layer richly. These power live mission tracking.
  {
    kind: 'mission:contract', tag: 'GenerateLocationProperty',
    test: /contract:\s*(\S+)/,
    fields: (m) => ({ contract: m[1] })
  },
  {
    // Links a runtime MissionId to its generator/template name - the bridge that
    // lets us classify a grouped mission by type. VERIFIED (Kersa 4.8.0 + DeadMan
    // 4.7.0 corpus). e.g. generator "FoxwellEnforcement_Generator".
    kind: 'mission:marker', tag: 'CLocalMissionPhaseMarker::CreateMarker',
    test: /missionId \[([0-9a-fA-F-]+)\].*?generator name \[([^\]]+)\]/,
    fields: (m) => ({ missionId: m[1], generator: m[2] })
  },
  {
    kind: 'mission:objective', tag: 'CMissionLogEntry::UpdateActiveObjective',
    test: /id=([0-9a-fA-F-]+).*?\[Text=([^\]]*)\]/,
    fields: (m) => ({ objectiveId: m[1], text: m[2] })
  },
  {
    // Real mission notification: a NON-zero MissionId (rule order matters - this
    // must precede the general hud:notification rule below).
    kind: 'mission:notification', tag: 'SHUDEvent_OnNotification',
    test: /Added notification "([^"]*)".*?MissionId:\s*\[(?!00000000-0000-0000-0000-000000000000\])([0-9a-fA-F-]+)\].*?ObjectiveId:\s*\[([^\]]*)\]/,
    fields: (m) => ({ text: m[1], missionId: m[2], objectiveId: m[3] })
  },
  {
    // Local player incapacitated (downed). A HUD notification beginning
    // "Incapacitated:". VERIFIED in real 4.7.0 logs (DeadMan1227; 617 occurrences,
    // one per down event). The closest combat-outcome signal the client log gives;
    // SC does not log kills. Attributed to the session's player by the service.
    kind: 'player:incap', tag: 'SHUDEvent_OnNotification',
    test: /Added notification "(Incapacitated:[^"]*)"/,
    fields: (m) => ({ text: m[1] })
  },
  {
    // General HUD notification - zone/jurisdiction/tutorial "what's going on"
    // messages with an all-zero (absent) MissionId. NOT a mission item.
    kind: 'hud:notification', tag: 'SHUDEvent_OnNotification',
    test: /Added notification "([^"]*)"/,
    fields: (m) => ({ text: m[1] })
  },

  // --- CLIENT-INVOLVED COMBAT (VERIFIED 2026-06-14 against real member data). Since SC
  // 4.0.2 the client Game.log records <Actor Death> CActor::Kill and <Vehicle Destruction>
  // ONLY for events that involve the running player (your kills, deaths, destructions) -
  // not third-party. VERIFIED end-to-end against Fadingdoughnut0's logs (builds 4.2.x,
  // Aug-Sep 2025): 417 real kills (parser caught all; damage types Bullet/ElectricArc/
  // Explosion/TakeDown/VehicleDestruction/...) + 16 vehicle destructions. Format matches
  // the maintained all-slain parser (DimmaDont/all-slain). See REFERENCES.md. ---
  {
    kind: 'kill', tag: 'Actor Death',
    test: /CActor::Kill: '([^']+)' \[(\d+)\] in zone '([^']+)' killed by '([^']+)' \[(\d+)\] using '([^']+)' \[Class ([^\]]+)\] with damage type '([^']+)' from direction x: ([-\d.]+), y: ([-\d.]+), z: ([-\d.]+)/,
    fields: (m) => ({
      victim: m[1], victimId: m[2], zone: m[3],
      killer: m[4], killerId: m[5], weapon: m[6], weaponClass: m[7], damageType: m[8],
      dirX: m[9], dirY: m[10], dirZ: m[11]
    })
  },
  {
    kind: 'vehicle:destroy', tag: 'Vehicle Destruction',
    test: /Vehicle '([^']+)' \[(\d+)\] in zone '([^']+)' \[pos x: ([-\d.]+), y: ([-\d.]+), z: ([-\d.]+) vel x: ([-\d.]+), y: ([-\d.]+), z: ([-\d.]+)\] driven by '([^']+)' \[(\d+)\] advanced from destroy level (\d+) to (\d+) caused by '([^']+)' \[(\d+)\] with '([^']+)'/,
    fields: (m) => ({
      vehicle: m[1], vehicleId: m[2], zone: m[3],
      driver: m[10], driverId: m[11], fromLevel: m[12], toLevel: m[13],
      attacker: m[14], cause: m[14], attackerId: m[15], damageType: m[16]
    })
  }
  // TODO (UNVERIFIED): quantum:travel removed - 'Quantum' appears in ~15k lines
  // (component names), so a naive pattern produced false positives. Re-add only
  // with a confirmed <Quantum Travel> line format from a real log.
];

function parseLine (raw) {
  const line = String(raw);
  const m = line.match(LINE);
  const base = m
    ? { timestamp: m[1], channel: m[2] || null, tag: m[3] || null, rest: m[4] || '', raw: line }
    : { timestamp: null, channel: null, tag: null, rest: line, raw: line };

  for (const rule of RULES) {
    if (rule.tag && base.tag !== rule.tag) continue;
    const hit = base.rest.match(rule.test) || line.match(rule.test);
    if (hit) {
      return Object.assign(base, { kind: rule.kind, verified: rule.verified !== false }, rule.fields(hit));
    }
  }
  return Object.assign(base, { kind: base.tag ? 'log:notice' : 'log:raw', verified: true });
}

// --- Ship-name extraction [VERIFIED: 1166 hits in real 4.8.0 log] ---
// IDs look like MANUFACTURER_ShipName_<bigid>, e.g. RSI_Aurora_Mk2_480167582679,
// AEGS_Avenger_Titan_487288078845, ARGO_MPUV_1T_490286587822.
const SHIP_PREFIXES = ['ORIG', 'AEGS', 'ANVL', 'CRUS', 'MISC', 'RSI', 'DRAK', 'ARGO', 'ESPR', 'KLWE', 'GRIN', 'XNAA', 'XIAN', 'BANU', 'GAMA', 'TMBL', 'VNCL', 'CNOU'];
const SHIP_ID = new RegExp(`(?:${SHIP_PREFIXES.join('|')})_([A-Za-z0-9_]+?)_\\d{6,}`);

function shipName (id) {
  if (!id) return null;
  const m = String(id).match(SHIP_ID);
  if (!m) return null;
  return m[1]
    .replace(/_/g, ' ')                  // Aurora_Mk2 -> Aurora Mk2; MPUV_1T -> MPUV 1T
    .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase splits (e.g. AvengerTitan)
    .trim();
}

// --- NPC vs player detection [indicators VERIFIED present; drives future PvE/PvP] ---
// NOTE: bare "PU_" is intentionally EXCLUDED - in real logs it matches cosmetic item
// names (PU_Protos_Head, Default_LensDisplay_PU), not NPC pilots. Use PU_Pilots only.
const NPC_INDICATORS = ['PU_Pilots', 'PU_Human', 'AI_CRIM', 'AI_', '_NPC_', 'NPC_Archetypes', 'Kopion_', 'Criminal-Pilot', 'Security-', 'Pirate-', '-Pilot_Light_', '-Pilot_Medium_', '-Pilot_Heavy_'];

function isNPC (name) {
  if (!name) return false;
  const n = String(name);
  if (NPC_INDICATORS.some((ind) => n.includes(ind))) return true;
  if (n.length > 40) return true;                       // archetype IDs are long
  if ((n.match(/-/g) || []).length >= 3) return true;   // dashed archetype names
  return false;
}

// --- Session / build / hardware info [VERIFIED against real 4.8.0 header] ---
// One-shot fields from the log header; we stamp each session with build + hardware.
const SESSION_FIELDS = [
  ['fileVersion', /FileVersion:\s*(.+?)\s*$/],
  ['branch', /Branch:\s*(.+?)\s*$/],
  ['changelist', /Changelist:\s*(\d+)/],
  ['builtOn', /Built on\s*(.+?)\s*$/],
  ['cpu', /Host CPU:\s*(.+?)\s*$/],
  ['cpuCores', /Logical CPU Count:\s*(\d+)/],
  ['ramInstalledMB', /(\d+)MB physical memory installed/],
  ['gpu', /D3D Adapter: Description:\s*(.+?)\s*$/],
  ['gpuVramMB', /DedicatedVidMem\w*\s*=\s*(\d+)/],
  ['hostname', /network hostname:\s*(.+?)\s*$/]
];

// Returns { key, value } for a recognized session-info line, else null.
function parseSessionInfo (line) {
  const s = String(line);
  for (const [key, re] of SESSION_FIELDS) {
    const m = s.match(re);
    if (m) return { key, value: m[1] };
  }
  return null;
}

// --- Mission-type classifier [from the real contract/generator codenames in the
// Kersa 4.8.0 + DeadMan 4.7.0 corpus]. Maps a generator/contract name to a
// friendly category. Order matters (first match wins). Editable - CIG adds
// content every patch, same as the NPC list. ---
const MISSION_TYPES = [
  [/killship|killnpc|fpskill|bountyhunter|assassinat|\bhunt/i, 'Bounty'],
  [/mercenary|enforcement|security|patrol|ambush|defend|escort|protect/i, 'Mercenary/Defense'],
  [/haul|cargo|deliver|recovercargo/i, 'Hauling'],
  [/recoveritem|recoverdata|recover|investigat|salvage/i, 'Recovery'],
  [/mining|resourcegather|gather|extract/i, 'Mining'],
  [/facilitydelve|delve|\bfps/i, 'FPS/Facility'],
  [/destroyitems|sabotage|destroy/i, 'Sabotage'],
  [/collector/i, 'Event']
];

function missionType (name) {
  if (!name) return 'Other';
  for (const [re, cat] of MISSION_TYPES) if (re.test(name)) return cat;
  return 'Other';
}

module.exports = { parseLine, RULES, shipName, isNPC, NPC_INDICATORS, parseSessionInfo, SESSION_FIELDS, missionType, MISSION_TYPES };
