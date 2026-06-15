'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseLine, shipName, isNPC, parseSessionInfo, missionType } = require('../app/parser');

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

test('detects session start (fresh log header)', () => {
  const r = parseLine("<2026-06-12T20:04:54.975Z> Log started on Fri Jun 12 20:04:54 2026");
  assert.strictEqual(r.kind, 'session:start');
  assert.strictEqual(r.startedOn, 'Fri Jun 12 20:04:54 2026');
});

test('detects game mode', () => {
  const r = parseLine("<2026-06-09T06:23:10.401Z> [Notice] <SeedingProcessor::SeedGameRulesAndMode Success> shardId[local_shard], GameMode[SC_Frontend], MegaMap[MegaMap.Frontend]");
  assert.strictEqual(r.kind, 'session:gamemode');
  assert.strictEqual(r.gameMode, 'SC_Frontend');
});

test('plain header line classified as log:raw', () => {
  const r = parseLine('<2026-06-12T20:04:54.975Z> BackupNameAttachment=" Build(11952564) 12 Jun 26 (12 04 50)"  -- used by backup system');
  assert.strictEqual(r.kind, 'log:raw');
});

// --- UNVERIFIED patterns (documented SC 4.x format; pending real combat log) ---

test('parses a player kill (Actor Death) — VERIFIED on real member data', () => {
  const line = "<2026-06-09T07:00:00.000Z> [Notice] <Actor Death> CActor::Kill: 'VictimGuy' [200111] in zone 'OOC_Stanton' killed by 'KillerGuy' [200222] using 'KLWE_LaserRepeater' [Class KLWE_LaserRepeater_S3] with damage type 'Energy' from direction x: 0.5, y: -0.2, z: 0.1";
  const r = parseLine(line);
  assert.strictEqual(r.kind, 'kill');
  assert.strictEqual(r.victim, 'VictimGuy');
  assert.strictEqual(r.killer, 'KillerGuy');
  assert.strictEqual(r.weapon, 'KLWE_LaserRepeater');
  assert.strictEqual(r.damageType, 'Energy');
  assert.strictEqual(r.dirZ, '0.1');
  assert.strictEqual(r.verified, true);   // VERIFIED 2026-06-14 against 417 real kills
});

test('parses a ship kill (Actor Death, damage type VehicleDestruction) — format corroborated by all-slain', () => {
  const line = "<2026-04-16T00:00:00.000Z> [Notice] <Actor Death> CActor::Kill: 'PU_Human-NineTails-Gunner-Male-Light_01_1234567890123' [1234567890123] in zone 'ANVL_Valkyrie_PU_AI_NT_QIG_1234567890123' killed by 'Player-123_Name' [123456789012] using 'BEHR_LaserCannon_S5_1234567890123' [Class unknown] with damage type 'VehicleDestruction' from direction x: 0.000000, y: 0.000000, z: 0.000000 [Team_ActorTech][Actor]";
  const r = parseLine(line);
  assert.strictEqual(r.kind, 'kill');
  assert.strictEqual(r.killer, 'Player-123_Name');
  assert.strictEqual(r.damageType, 'VehicleDestruction');
  assert.strictEqual(r.verified, true);
});

test('parses vehicle destruction — VERIFIED on real member data', () => {
  const line = "<2026-06-09T07:01:00.000Z> [Notice] <Vehicle Destruction> CVehicle::OnAdvanceDestroyLevel: Vehicle 'ANVL_Hornet_F7C' [300333] in zone 'OOC_Stanton_1a' [pos x: 1.0, y: 2.0, z: 3.0 vel x: 0.0, y: 0.0, z: 0.0] driven by 'PilotGuy' [400444] advanced from destroy level 0 to 2 caused by 'KillerGuy' [200222] with 'Ballistic'";
  const r = parseLine(line);
  assert.strictEqual(r.kind, 'vehicle:destroy');
  assert.strictEqual(r.vehicle, 'ANVL_Hornet_F7C');
  assert.strictEqual(r.toLevel, '2');
  assert.strictEqual(r.attacker, 'KillerGuy');
  assert.strictEqual(r.damageType, 'Ballistic');
  assert.strictEqual(r.verified, true);
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

test('zero-MissionId notification is a general HUD notice, not a mission', () => {
  const r = parseLine('<2026-06-13T07:12:41.081Z> [Notice] <SHUDEvent_OnNotification> Added notification "Entering Armistice Zone - Combat Prohibited: " [8] to queue. New queue size: 3, MissionId: [00000000-0000-0000-0000-000000000000], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]');
  assert.strictEqual(r.kind, 'hud:notification');
  assert.strictEqual(r.text, 'Entering Armistice Zone - Combat Prohibited: ');
  assert.strictEqual(r.missionId, undefined);   // not tied to a mission
});

test('detects mission marker (missionId -> generator name)', () => {
  const r = parseLine('<2026-06-13T07:00:00.000Z> [Notice] <CLocalMissionPhaseMarker::CreateMarker> Creating objective marker: missionId [0204222e-95c7-4211-a2ad-a18e1056de65], generator name [FoxwellEnforcement_Generator], more [Team_MissionFeatures][Missions]');
  assert.strictEqual(r.kind, 'mission:marker');
  assert.strictEqual(r.missionId, '0204222e-95c7-4211-a2ad-a18e1056de65');
  assert.strictEqual(r.generator, 'FoxwellEnforcement_Generator');
});

test('classifies mission types from real generator codenames', () => {
  assert.strictEqual(missionType('BountyHuntersGuild_KIllShip'), 'Bounty');
  assert.strictEqual(missionType('FoxwellEnforcement_Patrol'), 'Mercenary/Defense');
  assert.strictEqual(missionType('Covalex_Hauling'), 'Hauling');
  assert.strictEqual(missionType('Rayari_RecoverItem'), 'Recovery');
  assert.strictEqual(missionType('Shubin_ResourceGathering_ShipMining'), 'Mining');
  assert.strictEqual(missionType('SomeUnknown_Generator'), 'Other');
});

test('detects player incapacitation (down) — VERIFIED in 4.7.0 logs', () => {
  const line = `<2026-03-26T04:18:32.475Z> [Notice] <SHUDEvent_OnNotification> Added notification "Incapacitated: While incapacitated, ask others in your party to revive you before the 'Time to Death' timer expires." [156] to queue. New queue size: 1, MissionId: [00000000-0000-0000-0000-000000000000], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]`;
  const r = parseLine(line);
  assert.strictEqual(r.kind, 'player:incap');
  assert.ok(r.text.startsWith('Incapacitated:'));
});

// --- VERIFIED helpers folded in from the community reference (validated on real log) ---

test('shipName extracts and prettifies real ship IDs', () => {
  assert.strictEqual(shipName('RSI_Aurora_Mk2_480167582679'), 'Aurora Mk2');
  assert.strictEqual(shipName('AEGS_Avenger_Titan_487288078845'), 'Avenger Titan');
  assert.strictEqual(shipName('ARGO_MPUV_1T_490286587822'), 'MPUV 1T');
  assert.strictEqual(shipName('not-a-ship'), null);
});

test('isNPC uses reliable indicators (and excludes cosmetic PU_ items)', () => {
  assert.strictEqual(isNPC('PU_Pilots_Outlaw_Gunner_01'), true);
  assert.strictEqual(isNPC('AI_CRIM_Pilot'), true);
  assert.strictEqual(isNPC('Kersa'), false);                       // a real handle
  assert.strictEqual(isNPC('PU_Protos_Head_200000000225'), false); // cosmetic item, not an NPC
});

test('parseSessionInfo reads build + hardware from header lines', () => {
  assert.deepStrictEqual(parseSessionInfo('Branch: sc-alpha-4.8.0-hotfix'), { key: 'branch', value: 'sc-alpha-4.8.0-hotfix' });
  assert.deepStrictEqual(parseSessionInfo('Changelist: 11952564'), { key: 'changelist', value: '11952564' });
  assert.deepStrictEqual(parseSessionInfo('31793MB physical memory installed, 9382MB available'), { key: 'ramInstalledMB', value: '31793' });
  assert.strictEqual(parseSessionInfo('just a normal log line'), null);
});
