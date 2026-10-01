'use strict';

/**
 * Game.log signatures for local-player death detection (Death Report).
 *
 * Pure leaf module: a line in, a classified signal out. No I/O, no state.
 *
 * Honesty (same rule as functions/parser.js):
 *   - VERIFIED signatures matched a real Game.log from build 12660092
 *     (client dated 2026-09-27) — tests/relay/fixtures/death-fatal-collision-pilot.log,
 *     ONE player, ONE death (pilot, fatal collision). Not yet confirmed on
 *     any other death type on that build.
 *   - <Actor Death> / <Vehicle Destruction> are NOT re-derived here: they go
 *     through the existing parser rules, which are format-verified on SC
 *     <= 4.3.0 only and do not fire on later builds (see parser.js caveat).
 *     The 12660092 fixture death produced neither line.
 */

const { parseLine } = require('./parser');

const TS = /^<(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)> ?/;
const NUM = '(-?[\\d.]+)';

/**
 * Ordered signature table. `hint` is a cheap substring gate checked before
 * the regex so a multi-hundred-MB backlog scan stays fast.
 * @type {Array<{ signal: string, verified: boolean, hint: string, test: RegExp, fields: function(RegExpMatchArray): Object }>}
 */
const SIGNATURES = [
  // ---- session identity ----
  {
    signal: 'session_build', verified: true, hint: 'BackupNameAttachment',
    test: /BackupNameAttachment="\s*Build\((\d+)\)/,
    fields: (m) => ({ build: m[1] })
  },
  {
    signal: 'session_start', verified: true, hint: 'Log started on',
    test: /Log started on (.+?)\s*$/,
    fields: (m) => ({ startedOn: m[1] })
  },
  {
    signal: 'login_character', verified: true, hint: '<AccountLoginCharacterStatus_Character>',
    test: /<AccountLoginCharacterStatus_Character> Character: .*? geid (\d+) - accountId \d+ - name (\S+) - state (\S+)/,
    fields: (m) => ({ geid: m[1], name: m[2], state: m[3] })
  },
  {
    signal: 'login_handle', verified: true, hint: '<Legacy login response>',
    test: /<Legacy login response> .*?Handle\[([^\]]+)\]/,
    fields: (m) => ({ handle: m[1] })
  },

  // ---- death triggers ----
  {
    // CIG's own typo "occured" is in the real line.
    signal: 'fatal_collision', verified: true, hint: '<FatalCollision>',
    test: new RegExp(
      '<FatalCollision> Fatal Collision occured for vehicle (\\S+) ' +
      `\\[Part: ([^,]+), Pos: x: ${NUM}, y: ${NUM}, z: ${NUM}, Zone: ([^,]+), PlayerPilot: ([01])\\] ` +
      'after hitting entity: (.+?) \\[Zone: ([^\\s\\]]*) State: ([^\\]]*)\\]\\. ' +
      `Hit Pos: x: ${NUM}, y: ${NUM}, z: ${NUM}, Distance: ${NUM}, ` +
      `Relative Vel: x: ${NUM}, y: ${NUM}, z: ${NUM}, ` +
      'Collider \\[Id: (-?\\d+), Name: ([^,]*), PhysType: (-?\\d+), Entity: ([^,]*), LocalExtents: [^\\]]*\\], ' +
      'LastFrameTime \\(ms\\): ([\\d.]+)'
    ),
    fields: (m) => {
      const vel = { x: Number(m[15]), y: Number(m[16]), z: Number(m[17]) };
      return {
        vehicle: m[1],
        part: m[2],
        pos: { x: Number(m[3]), y: Number(m[4]), z: Number(m[5]) },
        zone: m[6],
        playerPilot: m[7] === '1',
        hitEntity: m[8],
        distance: Number(m[14]),
        relVel: vel,
        // Magnitude of the relative velocity = impact speed (m/s).
        speed: Math.sqrt(vel.x ** 2 + vel.y ** 2 + vel.z ** 2),
        colliderId: Number(m[18]),
        colliderName: m[19],
        colliderEntity: m[21],
        frameMs: Number(m[22])
      };
    }
  },
  {
    signal: 'clear_driver', verified: true, hint: 'CVehicleMovementBase::ClearDriver',
    test: /CVehicleMovementBase::ClearDriver: Local client node \[(\d+)\] releasing control token for '([^']+)' \[(\d+)\]/,
    fields: (m) => ({ geid: m[1], vehicle: m[2], vehicleId: m[3] })
  },
  {
    signal: 'actor_dead', verified: true, hint: '<[ActorState] Dead>',
    test: /<\[ActorState\] Dead> .*?Actor '([^']+)' \[(\d+)\] ejected from zone '([^']+)' \[(\d+)\] to zone '([^']+)' \[(\d+)\] due to ([^[]+?)\.?\s*\[/,
    fields: (m) => ({ actor: m[1], geid: m[2], fromZone: m[3], toZone: m[5], reason: m[7] })
  },
  {
    // WEAK signal: the fixture REPLAYS this notice 78 s after respawn with no
    // death behind it. Never open an incident from this alone.
    signal: 'incapacitated', verified: true, hint: '"Incapacitated:',
    test: /<SHUDEvent_OnNotification> Added notification "Incapacitated:/,
    fields: () => ({})
  },

  // ---- death confirmation ----
  {
    signal: 'corpse_item', verified: true, hint: 'PopulateItemPortForItemRecoveryEntitlement',
    test: /\[CSCActorCorpseUtils::PopulateItemPortForItemRecoveryEntitlement\]> Item '([^\s']+) - Class\(([^)]+)\)[^']*', Recorded data is: Port Name '([^']+)', Class GUID: '([0-9a-f-]+)'(?:, KeptId: '(\d+)')?/,
    fields: (m) => ({
      instance: m[1],
      itemClass: m[2],
      port: m[3],
      classGuid: m[4],
      kept: m[5] != null,
      // The burst's first line is always the body itself (see parser.js).
      isBody: /^body_01_noMagicPocket$/.test(m[2]),
      bodyId: /^body_01_noMagicPocket$/.test(m[2]) ? (m[1].match(/_(\d+)$/) || [])[1] || null : null
    })
  },
  {
    signal: 'corpse_marker', verified: true, hint: 'name = CorpseMarker_',
    test: /Force detaching ENTITY ATTACHMENT id = (\d+) name = CorpseMarker_\d+ to unblock removal of parent id = (\d+) name = (\S+)/,
    fields: (m) => ({ corpseId: m[2], actor: m[3] })
  },

  // ---- respawn (all four, for the local GEID) ----
  {
    signal: 'bind_layout', verified: true, hint: '<Bind Change Layout Player>',
    test: /<Bind Change Layout Player> .*?entityId=(\d+), className="Player"/,
    fields: (m) => ({ geid: m[1] })
  },
  {
    signal: 'bind_end', verified: true, hint: '<Recv Bind Batch End Player>',
    test: /<Recv Bind Batch End Player> .*?playerGEID=(\d+)/,
    fields: (m) => ({ geid: m[1] })
  },
  {
    signal: 'spawned', verified: true, hint: '[CSessionManager::OnClientSpawned]',
    test: /\[CSessionManager::OnClientSpawned\] Spawned!/,
    fields: () => ({})
  },
  {
    signal: 'inventory_location', verified: true, hint: '<Update Inventory Location>',
    test: /<Update Inventory Location> Player \[([^\]]+)\] is changing location\. Landing \[(\d+)\] -> \[(\d+)\]\. Location \[(\d+)\] -> \[(\d+)\]/,
    fields: (m) => ({ player: m[1], landingFrom: m[2], landingTo: m[3], locFrom: m[4], locTo: m[5] })
  },

  // ---- pre-death context (timeline breadcrumbs only) ----
  {
    signal: 'route', verified: true, hint: 'CSCItemNavigation::CalculateRoute',
    test: /\| (\S+)\[\d+\]\|CSCItemNavigation::CalculateRoute\|Projected Start Location is (.+?) for route to destination (\S+)/,
    fields: (m) => ({ vehicle: m[1], start: m[2], destination: m[3] })
  },
  {
    signal: 'quantum_target', verified: true, hint: 'OnPlayerSelectedQuantumTarget',
    test: /\| (\S+)\[\d+\]\|CSCItemNavigation::OnPlayerSelectedQuantumTarget\|/,
    fields: (m) => ({ vehicle: m[1] })
  },
  {
    signal: 'no_route', verified: true, hint: 'GetStarmapRouteSegmentData|No Route loaded!',
    test: /CSCItemNavigation::GetStarmapRouteSegmentData\|No Route loaded!/,
    fields: () => ({})
  },
  {
    signal: 'inventory_closed', verified: true, hint: '<Close Inventory Grid>',
    test: /<Close Inventory Grid> Player\[([^\]]+)\] closing inventory/,
    fields: (m) => ({ player: m[1] })
  },
  {
    signal: 'cvar_displayinfo', verified: true, hint: 'r_DisplayInfo = ',
    test: /^\s*r_DisplayInfo = (\d+)/,
    fields: (m) => ({ value: Number(m[1]) })
  }
];

/**
 * Split the leading `<ISO timestamp> ` prefix off a raw log line.
 * @param {string} raw
 * @returns {{ ts: string|null, rest: string }}
 */
function splitTimestamp (raw) {
  const line = String(raw);
  const m = line.match(TS);
  return m ? { ts: m[1], rest: line.slice(m[0].length) } : { ts: null, rest: line };
}

/**
 * Classify one raw Game.log line as a death-report signal.
 * @param {string} raw One log line.
 * @returns {{ signal: string, ts: string|null, verified: boolean, fields: Object }|null}
 *   null when the line is not relevant to death detection.
 */
function matchSignal (raw) {
  const line = String(raw);
  for (const sig of SIGNATURES) {
    if (line.indexOf(sig.hint) === -1) continue;
    const { ts, rest } = splitTimestamp(line);
    const m = rest.match(sig.test);
    if (m) return { signal: sig.signal, ts, verified: sig.verified, fields: sig.fields(m) };
  }
  // Historical (<= 4.3.0) kill / vehicle-destruction lines reuse the parser's
  // already format-verified rules instead of a second copy of the regex.
  if (line.indexOf('<Actor Death>') !== -1 || line.indexOf('<Vehicle Destruction>') !== -1) {
    const ev = parseLine(line);
    if (ev.kind === 'kill') {
      return {
        signal: 'actor_death', ts: ev.timestamp, verified: true,
        fields: {
          victim: ev.victim, victimId: ev.victimId, zone: ev.zone, killer: ev.killer,
          killerId: ev.killerId, weapon: ev.weapon, weaponClass: ev.weaponClass, damageType: ev.damageType
        }
      };
    }
    if (ev.kind === 'vehicle:destroy') {
      return {
        signal: 'vehicle_destruction', ts: ev.timestamp, verified: true,
        fields: {
          vehicle: ev.vehicle, zone: ev.zone, driver: ev.driver, driverId: ev.driverId,
          fromLevel: Number(ev.fromLevel), toLevel: Number(ev.toLevel),
          causer: ev.attacker, causerId: ev.attackerId, damageType: ev.damageType
        }
      };
    }
  }
  return null;
}

module.exports = {
  SIGNATURES,
  splitTimestamp,
  matchSignal
};
