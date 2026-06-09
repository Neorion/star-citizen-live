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
  s.handleLogChange("<2026-06-09T07:00:00.000Z> [Notice] <Actor Death> CActor::Kill: 'V' [1] in zone 'Z' killed by 'K' [2] using 'W' [Class x] with damage type 'Energy' from direction x: 0");
  assert.strictEqual(s.kills.length, 1);
  assert.strictEqual(emitted.killer, 'K');
});

test('handleLogChange routes a login into the players collection', () => {
  const s = new StarCitizenService({ discord: { enable: false } });
  s.handleLogChange("<2026-06-09T06:23:07.643Z> [Notice] <Legacy login response> [CIG-net] User Login Success - Handle[Kersa] - Time[1]");
  assert.strictEqual(s.players.length, 1);
  assert.strictEqual(s.players[0].name, 'Kersa');
});
