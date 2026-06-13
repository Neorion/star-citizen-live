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

test('handleLogChange routes a mission objective into missionlog and emits', () => {
  const s = new StarCitizenService({ discord: { enable: false } });
  let emitted = null;
  s.on('mission:objective', (m) => { emitted = m; });
  s.handleLogChange("<2026-06-12T20:20:11.249Z> [Notice] <CMissionLogEntry::UpdateActiveObjective> Objective updated id=3340e494-888d-96be-0192-0c08d4841aa3, flags=ShowInLog|, hidden=0, uiDisplay[Priority=1][Text=Defeat Hostile Ship] [Team_MissionFeatures][Missions]");
  assert.strictEqual(s.missionlog.length, 1);
  assert.strictEqual(emitted.text, 'Defeat Hostile Ship');
});

test('handleLogChange stamps session build/hardware from header lines', () => {
  const s = new StarCitizenService({ discord: { enable: false } });
  s.handleLogChange('<2026-06-12T20:04:55.614Z> Branch: sc-alpha-4.8.0-hotfix');
  s.handleLogChange('<2026-06-12T20:04:55.614Z> Changelist: 11952564');
  assert.strictEqual(s.session.branch, 'sc-alpha-4.8.0-hotfix');
  assert.strictEqual(s.session.changelist, '11952564');
});
