'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseLine } = require('../app/parser');

// --- VERIFIED patterns (from a real Game.log hangar session) ---

test('parses base structure: timestamp + channel + tag', () => {
  const r = parseLine("<2026-06-09T06:23:07.643Z> [Notice] <Legacy login response> [CIG-net] User Login Success - Handle[Kersa] - Time[182954069]");
  assert.strictEqual(r.timestamp, '2026-06-09T06:23:07.643Z');
  assert.strictEqual(r.channel, 'Notice');
  assert.strictEqual(r.tag, 'Legacy login response');
});

test('detects player login and extracts handle', () => {
  const r = parseLine("<2026-06-09T06:23:07.643Z> [Notice] <Legacy login response> [CIG-net] User Login Success - Handle[Kersa] - Time[182954069] [Team_GameServices][Login]");
  assert.strictEqual(r.kind, 'player:login');
  assert.strictEqual(r.handle, 'Kersa');
});

test('detects level load', () => {
  const r = parseLine("<2026-06-09T06:23:09.771Z> ============================ Loading level megamap ============================");
  assert.strictEqual(r.kind, 'session:level');
  assert.strictEqual(r.level, 'megamap');
});

test('detects game mode', () => {
  const r = parseLine("<2026-06-09T06:23:10.401Z> [Notice] <SeedingProcessor::SeedGameRulesAndMode Success> shardId[local_shard], GameMode[SC_Frontend], MegaMap[MegaMap.Frontend]");
  assert.strictEqual(r.kind, 'session:gamemode');
  assert.strictEqual(r.gameMode, 'SC_Frontend');
});

test('plain header line classified as log:raw', () => {
  const r = parseLine("<2026-06-09T06:22:54.104Z> Log started on Tue Jun  9 06:22:54 2026");
  assert.strictEqual(r.kind, 'log:raw');
});

// --- UNVERIFIED patterns (documented SC 4.x format; pending real combat log) ---

test('parses documented kill line (UNVERIFIED format)', () => {
  const line = "<2026-06-09T07:00:00.000Z> [Notice] <Actor Death> CActor::Kill: 'VictimGuy' [200111] in zone 'OOC_Stanton' killed by 'KillerGuy' [200222] using 'KLWE_LaserRepeater' [Class unknown] with damage type 'Energy' from direction x: 0";
  const r = parseLine(line);
  assert.strictEqual(r.kind, 'kill');
  assert.strictEqual(r.victim, 'VictimGuy');
  assert.strictEqual(r.killer, 'KillerGuy');
  assert.strictEqual(r.weapon, 'KLWE_LaserRepeater');
  assert.strictEqual(r.damageType, 'Energy');
  assert.strictEqual(r.verified, false);  // flagged as needing real-log confirmation
});

test('parses documented vehicle destruction (UNVERIFIED format)', () => {
  const line = "<2026-06-09T07:01:00.000Z> [Notice] <Vehicle Destruction> CVehicle::OnAdvanceDestroyLevel: Vehicle 'ANVL_Hornet_F7C' [300333] advanced from destroy level 0 to 2 caused by 'KillerGuy' [200222]";
  const r = parseLine(line);
  assert.strictEqual(r.kind, 'vehicle:destroy');
  assert.strictEqual(r.vehicle, 'ANVL_Hornet_F7C');
  assert.strictEqual(r.toLevel, '2');
  assert.strictEqual(r.verified, false);
});

// --- VERIFIED mission patterns (from a real combat-mission session, 2026-06-12) ---

test('detects mission contract name', () => {
  const r = parseLine("<2026-06-12T20:16:06.843Z> [Notice] <GenerateLocationProperty> Generated Locations - variablename: SubLocationType_BP, locations: (Freelancer wreck site [4221372531] [MISC_Freelancer_Space_Stanton1]) contract: FoxwellEnforcement_Stanton_DefendShipNamed_E [Team_MissionFeatures][Missions]");
  assert.strictEqual(r.kind, 'mission:contract');
  assert.strictEqual(r.contract, 'FoxwellEnforcement_Stanton_DefendShipNamed_E');
});

test('detects mission objective update and its text', () => {
  const r = parseLine("<2026-06-12T20:20:11.249Z> [Notice] <CMissionLogEntry::UpdateActiveObjective> Objective updated id=3340e494-888d-96be-0192-0c08d4841aa3, flags=ShowInLog|RespectInheritedVisibility|, hidden=0, hiddenInUI=0, markerHidden=0, uiDisplay[Priority=1][Text=Defeat Hostile Ship] [Team_MissionFeatures][Missions]");
  assert.strictEqual(r.kind, 'mission:objective');
  assert.strictEqual(r.objectiveId, '3340e494-888d-96be-0192-0c08d4841aa3');
  assert.strictEqual(r.text, 'Defeat Hostile Ship');
});

test('detects mission notification with mission/objective ids', () => {
  const r = parseLine("<2026-06-12T20:20:11.252Z> [Notice] <SHUDEvent_OnNotification> Added notification \"New Objective: Defeat Hostile Ships: \" [25] to queue. New queue size: 1, MissionId: [4491dc34-bcf3-4f56-a0b8-228e3e3f40e9], ObjectiveId: [3340e494-888d-96be-0192-0c08d4841aa3] [Team_CoreGameplayFeatures][Missions][Comms]");
  assert.strictEqual(r.kind, 'mission:notification');
  assert.strictEqual(r.text, 'New Objective: Defeat Hostile Ships: ');
  assert.strictEqual(r.missionId, '4491dc34-bcf3-4f56-a0b8-228e3e3f40e9');
  assert.strictEqual(r.objectiveId, '3340e494-888d-96be-0192-0c08d4841aa3');
});
