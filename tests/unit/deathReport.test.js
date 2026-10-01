'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const deathReport = require('../../functions/deathReport');
const view = require('../../functions/deathReportView');
const store = require('../../functions/deathReportStore');
const { scrubLog } = require('../../scripts/scrub-log-fixture');

// Real Game.log slice, build 12660092 (2026-09-27), scrubbed of identifiers.
const FIXTURE = path.join(__dirname, '..', 'relay', 'fixtures', 'death-fatal-collision-pilot.log');

test('itemCategory maps corpse ports to gear categories', () => {
  const cases = {
    Armor_Torso: 'armor',
    Armor_Undersuit: 'armor',
    wep_stocked_2: 'weapon',
    magazine_attach_1: 'magazine',
    optics_attach: 'attachment',
    barrel_attach: 'attachment',
    underbarrel_attach: 'attachment',
    module_attach: 'attachment',
    grenade_attach_2: 'grenade',
    medPen_attach_1: 'medical',
    oxyPen_attach_1: 'medical',
    utility_attach_1: 'utility',
    backpack: 'backpack',
    Body_ItemPort: 'character',
    helmet_visor: 'character',
    mobiglas_attach: 'character',
    something_else: 'other'
  };
  for (const [port, category] of Object.entries(cases)) {
    assert.strictEqual(deathReport.itemCategory(port), category, port);
  }
});

test('display names fall back to the raw class and never block a report', () => {
  assert.strictEqual(deathReport.vehicleDisplayName('ANVL_Asgard_900000000002'), 'Anvil Asgard');
  assert.strictEqual(deathReport.vehicleDisplayName('DRAK_Corsair_123456789'), 'Drake Corsair');
  assert.strictEqual(deathReport.vehicleDisplayName('ZZZZ_Mystery_123456789'), 'ZZZZ_Mystery');
  assert.strictEqual(deathReport.vehicleDisplayName(null), null);
  assert.strictEqual(deathReport.zoneDisplayName('pyro4'), 'Pyro IV');
  assert.strictEqual(deathReport.zoneDisplayName('OOC_Stanton_2b_Daymar'), 'Daymar');
  assert.strictEqual(deathReport.zoneDisplayName('SomeUnknownZone_12'), 'SomeUnknownZone_12');
});

test('classifyCause: first matching rule wins', () => {
  const c = deathReport.classifyCause;
  assert.strictEqual(c({ collision: { playerPilot: true }, actorDead: {} }), 'vehicle_collision_pilot');
  assert.strictEqual(c({ collision: { playerPilot: false }, actorDead: {} }), 'vehicle_collision_passenger');
  // Ejected from a wreck with no collision line: destroyed, cause not logged — never "a collision".
  assert.strictEqual(c({ actorDead: {} }), 'vehicle_destroyed_unknown');
  assert.strictEqual(c({ actorDead: {}, kill: { victim: 'Me', killer: 'OtherPilot' } }), 'killed_by_player');
  assert.strictEqual(c({ player: 'Me', vehicleDestroyed: { causer: 'Raider' } }), 'vehicle_destroyed_combat');
  assert.strictEqual(c({ player: 'Me', vehicleDestroyed: { causer: 'unknown' } }), 'unknown');
  assert.strictEqual(c({ kill: { victim: 'Me', killer: 'Me', damageType: 'Suicide' } }), 'suicide');
  assert.strictEqual(c({ kill: { victim: 'Me', killer: 'unknown', damageType: 'Suffocation' } }), 'environmental');
  assert.strictEqual(c({ kill: { victim: 'Me', killer: 'PU_Human_Enemy_GroundCombat_NPC_1', damageType: 'Bullet' } }), 'killed_by_npc');
  assert.strictEqual(c({ kill: { victim: 'Me', killer: 'OtherPilot', damageType: 'Bullet' } }), 'killed_by_player');
  assert.strictEqual(c({ confirmedAt: '2026-01-01T00:00:00.000Z' }), 'unknown');
});

test('a lag-spike frame time adds the possible_lag_spike modifier', () => {
  const r = deathReport.buildReport({
    status: 'confirmed',
    triggerAt: '2026-09-28T00:52:17.679Z',
    confirmedAt: '2026-09-28T00:52:20.000Z',
    collision: {
      at: '2026-09-28T00:52:17.679Z', line: 1, vehicle: 'ANVL_Asgard_900000000002', part: 'Nose', zone: 'pyro4',
      playerPilot: true, hitEntity: 'RSI_Aurora_900000000009', pos: { x: 1, y: 2, z: 3 }, distance: 3,
      relVel: { x: 3, y: 4, z: 0 }, speed: 5, colliderId: 12, colliderName: 'hull', colliderEntity: 'RSI_Aurora_900000000009', frameMs: 250
    },
    items: [],
    evidence: []
  });
  assert.deepStrictEqual(r.modifiers, ['possible_lag_spike']);
  assert.strictEqual(r.collider, 'RSI_Aurora_900000000009', 'a named collider is not reported as terrain');
  assert.match(r.summary, /^Crashed Anvil Asgard nose-first into RSI_Aurora_900000000009 on Pyro IV at 5\.0 m\/s \(18 km\/h\)$/);
});

test('groupItems tallies lost gear by category and keeps character-bound items apart', () => {
  const groups = view.groupItems({
    items: [
      { itemClass: 'mag_a', category: 'magazine', kept: false },
      { itemClass: 'mag_a', category: 'magazine', kept: false },
      { itemClass: 'core_a', category: 'armor', kept: false },
      { itemClass: 'hair_02', category: 'character', kept: true }
    ]
  });
  assert.deepStrictEqual(groups.map((g) => g.category), ['armor', 'magazine', 'character-bound']);
  assert.deepStrictEqual(groups[1].items, [{ itemClass: 'mag_a', count: 2 }]);
  assert.strictEqual(groups[2].kept, true);
  assert.deepStrictEqual(view.groupItems(null), []);
});

test('store: upsert is idempotent, keeps the richer copy, lists newest first', () => {
  const s = store.emptyStore();
  const a = { id: 'a'.repeat(32), status: 'confirmed', confirmedAt: '2026-01-01T00:00:00.000Z', cause: 'unknown', evidence: [1], items: [] };
  const b = { id: 'b'.repeat(32), status: 'unconfirmed', triggerAt: '2026-02-01T00:00:00.000Z', cause: 'vehicle_collision_pilot', evidence: [1], items: [] };
  assert.strictEqual(store.upsertReport(s, a), 'created');
  assert.strictEqual(store.upsertReport(s, b), 'created');
  assert.strictEqual(store.upsertReport(s, a), 'skipped');
  assert.strictEqual(store.upsertReport(s, Object.assign({}, a, { evidence: [1, 2, 3] })), 'updated');
  assert.strictEqual(store.upsertReport(s, Object.assign({}, a, { evidence: [] })), 'skipped', 'a poorer copy never overwrites');
  assert.strictEqual(store.upsertReport(s, { status: 'confirmed' }), 'skipped', 'no id, no record');
  const page = store.listReports(s, {});
  assert.strictEqual(page.total, 2);
  assert.deepStrictEqual(page.rows.map((r) => r.id[0]), ['b', 'a']);
  assert.strictEqual(store.listReports(s, { status: 'confirmed' }).total, 1);
  assert.strictEqual(store.listReports(s, { cause: 'vehicle_collision_pilot' }).rows[0].id, b.id);
  assert.strictEqual(store.listReports(s, { limit: 1, offset: 1 }).rows[0].id, a.id);
  assert.strictEqual(store.removeReport(s, a.id), true);
  assert.strictEqual(store.removeReport(s, a.id), false);
  assert.strictEqual(store.getReport(s, a.id), null);
});

test('store: scanFile over the fixture, then save/load round-trips; a second scan adds nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-death-store-'));
  const file = path.join(dir, 'death-reports.json');
  try {
    const first = await store.scanFile(FIXTURE);
    assert.strictEqual(first.lines, 625);
    assert.strictEqual(first.reports.length, 1);
    assert.strictEqual(first.reports[0].logFile, 'death-fatal-collision-pilot.log');
    const s = store.emptyStore();
    assert.strictEqual(store.upsertReport(s, first.reports[0]), 'created');
    store.saveStore(file, s);
    const loaded = store.loadStore(file);
    assert.strictEqual(loaded.reports.length, 1);
    assert.ok(loaded.meta.savedAt);
    const second = await store.scanFile(FIXTURE);
    assert.strictEqual(store.upsertReport(loaded, second.reports[0]), 'skipped');
    assert.strictEqual(loaded.reports.length, 1);
    assert.deepStrictEqual(store.loadStore(path.join(dir, 'missing.json')), store.emptyStore());
    assert.strictEqual(store.storePath(null), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('toMarkdown renders headline, cause, timeline and gear', async () => {
  const { reports } = await store.scanFile(FIXTURE);
  const md = deathReport.toMarkdown(reports[0]);
  assert.match(md, /^# Death report — confirmed/);
  assert.match(md, /\*\*Crashed Anvil Asgard tail-first into terrain on Pyro IV at 17\.8 m\/s \(64 km\/h\)/);
  assert.match(md, /- Cause: vehicle_collision_pilot · modifiers: ttd_expired/);
  assert.match(md, /- Frame time: 25\.2 ms \(normal — no lag spike\)/);
  assert.match(md, /`00:52:17\.679` \*\*trigger\*\* — FatalCollision — Tail, zone pyro4/);
  assert.match(md, /## Gear left on corpse \(38\)/);
  assert.match(md, /\*\*Character-bound, not lost \(7\):\*\*/);
  assert.match(md, /not officer-validated/);
});

test('privacy guard: the committed fixture carries no real identifiers', () => {
  const text = fs.readFileSync(FIXTURE, 'utf8');
  // Every long numeric id is synthetic (scrubber output starts with 9) or a zero placeholder.
  const longIds = text.match(/(?<![\d.a-f-])\d{9,}(?![\d.a-f-])/g) || [];
  assert.ok(longIds.length > 100);
  assert.ok(longIds.every((id) => /^9\d+$/.test(id) || /^0+$/.test(id)), 'unscrubbed numeric id in fixture');
  const ips = text.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) || [];
  assert.ok(ips.every((ip) => ip === '203.0.113.10'), 'only the TEST-NET placeholder address may appear');
  const handles = new Set((text.match(/Handle\[([^\]]+)\]/g) || []).concat(text.match(/Player ?\[([^\]]+)\]/g) || []));
  assert.ok([...handles].every((h) => h.includes('TestPilot')), 'only the placeholder handle may appear');
  assert.ok(!/accountId (?!10001\b)\d+/.test(text));
  assert.ok(!/sessionId="(?!0{32}")[0-9a-f]+"/.test(text));
  assert.ok(!/[A-Za-z]:\\Users\\/.test(text), 'no user profile path');
});

test('scrubLog replaces identifiers consistently and keeps line shapes', () => {
  const raw = [
    '<2026-01-01T00:00:00.000Z> Executable: D:\\Games\\RSI\\StarCitizen\\LIVE\\Bin64\\StarCitizen.exe',
    // Invented stand-ins for the kinds of identifier a real log carries.
    '<2026-01-01T00:00:01.000Z> [Notice] <AccountLoginCharacterStatus_Character> Character: createdAt 1600000000001 - updatedAt 1600000000002 - geid 123456789012 - accountId 77777 - name RealName - state STATE_CURRENT',
    '<2026-01-01T00:00:02.000Z> [Notice] <Legacy login response> [CIG-net] User Login Success - Handle[RealName] - Time[123456789]',
    '<2026-01-01T00:00:03.000Z> [Notice] <Recv Bind Batch End Player> ViewName="Replicant 198.51.100.23:64337" node_id=abcdef12-3456-7890-abcd-ef1234567890 playerGEID=123456789012 sessionId="0123456789abcdef0123456789abcdef" x: -245156.613818',
    "<2026-01-01T00:00:04.000Z> Item 'body_01_noMagicPocket_555555555555', Class GUID: 'dbaa8a7d-755f-4104-8b24-7b58fd1e76f6', MissionId: [00000000-0000-0000-0000-000000000000]"
  ].join('\n');
  const { text, ids } = scrubLog(raw, { handle: 'RealName' });
  assert.ok(ids >= 4);
  for (const leak of ['RealName', '123456789012', '77777', '198.51.100', '0123456789abcdef', 'abcdef12', '555555555555', 'D:\\Games']) {
    assert.ok(!text.includes(leak), `leaked ${leak}`);
  }
  assert.match(text, /name TestPilot - state STATE_CURRENT/);
  assert.match(text, /Handle\[TestPilot\]/);
  assert.match(text, /accountId 10001 /);
  // The same GEID maps to the same synthetic id on every line (cross-line joins survive).
  const geid = text.match(/geid (\d+)/)[1];
  assert.match(text, new RegExp(`playerGEID=${geid} `));
  assert.strictEqual(geid.length, 12);
  // Game data and float coordinates are untouched.
  assert.ok(text.includes("Class GUID: 'dbaa8a7d-755f-4104-8b24-7b58fd1e76f6'"));
  assert.ok(text.includes('MissionId: [00000000-0000-0000-0000-000000000000]'));
  assert.ok(text.includes('x: -245156.613818'));
  assert.ok(text.includes('<2026-01-01T00:00:03.000Z>'));
});
