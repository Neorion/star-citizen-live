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

  // --- UNVERIFIED: documented SC 4.x combat formats, pending a real combat log ---
  {
    kind: 'kill', tag: 'Actor Death', verified: false,
    test: /CActor::Kill: '([^']+)' \[(\d+)\] in zone '([^']*)' killed by '([^']+)' \[(\d+)\] using '([^']+)'(?:.*?with damage type '([^']+)')?/,
    fields: (m) => ({
      victim: m[1], victimId: m[2], zone: m[3],
      killer: m[4], killerId: m[5], weapon: m[6], damageType: m[7] || 'Unknown'
    })
  },
  {
    kind: 'vehicle:destroy', tag: 'Vehicle Destruction', verified: false,
    test: /Vehicle '([^']+)' \[(\d+)\].*?destroy level (\d+) to (\d+).*?caused by '([^']+)'/,
    fields: (m) => ({ vehicle: m[1], vehicleId: m[2], fromLevel: m[3], toLevel: m[4], cause: m[5] })
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

module.exports = { parseLine, RULES };
