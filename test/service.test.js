'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const StarCitizenService = require('../app/server');

test('service constructs with mission stub and starts STOPPED', () => {
  const s = new StarCitizenService({ discord: { enable: false } });
  assert.strictEqual(s.status, 'STOPPED');
  assert.ok(s.missionManager, 'mission manager present');
});

test('handleLogChange routes a kill into the kills collection and emits', () => {
  const s = new StarCitizenService({ discord: { enable: false } });
  let emitted = null;
  s.on('kill', (k) => { emitted = k; });
  s.handleLogChange("<2026-06-09T07:00:00.000Z> [Notice] <Actor Death> CActor::Kill: 'V' [1] in zone 'Z' killed by 'K' [2] using 'W' [Class WC] with damage type 'Energy' from direction x: 0, y: 0, z: 0");
  assert.strictEqual(s.kills.length, 1);
  assert.strictEqual(emitted.killer, 'K');
});

test('handleLogChange routes a login into the players collection', () => {
  const s = new StarCitizenService({ discord: { enable: false } });
  s.handleLogChange("<2026-06-09T06:23:07.643Z> [Notice] <Legacy login response> [CIG-net] User Login Success - Handle[Kersa] - Time[1]");
  assert.strictEqual(s.players.length, 1);
  assert.strictEqual(s.players[0].name, 'Kersa');
});

test('players dedupe by handle; logins count every event', () => {
  const s = new StarCitizenService({ discord: { enable: false } });
  let joins = 0;
  s.on('player:join', () => { joins++; });
  const login = (t) => s.handleLogChange(`<${t}> [Notice] <Legacy login response> [CIG-net] User Login Success - Handle[Kersa] - Time[1] [Login]`);
  login('2026-06-13T06:43:45.000Z');
  login('2026-06-13T07:05:00.000Z');   // same handle, second login
  assert.strictEqual(s.players.length, 1, 'one distinct player');
  assert.strictEqual(s.players[0].logins, 2, 'two logins recorded');
  assert.strictEqual(s.logins.length, 2, 'two login events');
  assert.strictEqual(joins, 1, 'player:join fires once per distinct handle');

  // a different handle is a new distinct player
  s.handleLogChange('<2026-06-13T07:10:00.000Z> [Notice] <Legacy login response> [CIG-net] User Login Success - Handle[Raven] - Time[1] [Login]');
  assert.strictEqual(s.players.length, 2);
  assert.strictEqual(joins, 2);
});

test('handleLogChange routes a mission objective into missionlog and emits', () => {
  const s = new StarCitizenService({ discord: { enable: false } });
  let emitted = null;
  s.on('mission:objective', (m) => { emitted = m; });
  s.handleLogChange("<2026-06-12T20:20:11.249Z> [Notice] <CMissionLogEntry::UpdateActiveObjective> Objective updated id=3340e494-888d-96be-0192-0c08d4841aa3, flags=ShowInLog|, hidden=0, uiDisplay[Priority=1][Text=Defeat Hostile Ship] [Team_MissionFeatures][Missions]");
  assert.strictEqual(s.missionlog.length, 1);
  assert.strictEqual(emitted.text, 'Defeat Hostile Ship');
});

test('HUD notification routes to notifications, not missionlog', () => {
  const s = new StarCitizenService({ discord: { enable: false } });
  s.handleLogChange('<2026-06-13T07:12:41.081Z> [Notice] <SHUDEvent_OnNotification> Added notification "Entering Armistice Zone - Combat Prohibited: " [8] to queue. New queue size: 3, MissionId: [00000000-0000-0000-0000-000000000000], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]');
  assert.strictEqual(s.notifications.length, 1);
  assert.strictEqual(s.missionlog.length, 0);
  assert.strictEqual(s.notifications[0].text, 'Entering Armistice Zone - Combat Prohibited: ');
});

test('handleLogChange stamps session build/hardware from header lines', () => {
  const s = new StarCitizenService({ discord: { enable: false } });
  s.handleLogChange('<2026-06-12T20:04:54.975Z> Log started on Fri Jun 12 20:04:54 2026');
  s.handleLogChange('<2026-06-12T20:04:55.614Z> Branch: sc-alpha-4.8.0-hotfix');
  s.handleLogChange('<2026-06-12T20:04:55.614Z> Changelist: 11952564');
  assert.strictEqual(s.session.branch, 'sc-alpha-4.8.0-hotfix');
  assert.strictEqual(s.session.changelist, '11952564');
});

test('handleLogChange tracks each game session and resets on a new launch', () => {
  const s = new StarCitizenService({ discord: { enable: false } });
  let started = 0;
  s.on('session:start', () => { started++; });
  s.handleLogChange('<2026-06-12T20:04:54.975Z> Log started on Fri Jun 12 20:04:54 2026');
  s.handleLogChange('<2026-06-12T20:04:55.614Z> Branch: sc-alpha-4.8.0-hotfix');
  assert.strictEqual(s.sessions.length, 1);
  assert.strictEqual(s.session.branch, 'sc-alpha-4.8.0-hotfix');
  // a second launch (game restart) starts a fresh session and resets build info
  s.handleLogChange('<2026-06-13T06:18:00.000Z> Log started on Sat Jun 13 06:18:00 2026');
  assert.strictEqual(s.sessions.length, 2);
  assert.strictEqual(started, 2);
  assert.strictEqual(s.session.startedOn, 'Sat Jun 13 06:18:00 2026');
  assert.strictEqual(s.session.branch, undefined);  // reset for the new session
});
