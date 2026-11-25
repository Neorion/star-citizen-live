'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { compute, C } = require('../app/mining-calc');
const ref = require('../data/mining-reference.json');

const by = (arr, id) => arr.find(x => x.id === id);
const HELIX1 = 'helix-i-mining-laser';
const HELIX2 = 'helix-ii-mining-laser';
const ARBOR2 = 'arbor-mh2-mining-laser';

test('reference data: 4.10 snapshot values (silent upstream drift must fail here)', () => {
  assert.ok(String(ref.gameVersion).startsWith('4.10'), `gameVersion ${ref.gameVersion}`);
  assert.strictEqual(by(ref.lasers, HELIX1).power.max, 3900);
  assert.strictEqual(by(ref.lasers, HELIX1).resistance, -30);
  assert.strictEqual(by(ref.modules, 'surge-module').laserPower, 50);
  assert.strictEqual(by(ref.modules, 'surge-module').active, true);
  assert.strictEqual(by(ref.gadgets, 'sabir').resistance, -50);
  for (const l of ref.lasers) {
    assert.ok(l.power.min > 0 && l.power.max > l.power.min, `${l.name} power ${JSON.stringify(l.power)}`);
    assert.ok([0, 1, 2].includes(l.size), `${l.name} size`);
  }
  for (const m of ref.modules) for (const k of ['laserPower', 'resistance', 'instability']) assert.ok(Number.isFinite(m[k]), `${m.name}.${k}`);
  for (const g of ref.gadgets) assert.ok(Number.isFinite(g.resistance), g.name);
  assert.ok(ref.ships.some(s => s.id === 'mole' && s.mounts === 3 && s.size === 2));
});

test('formula: single Helix I, 0 % rock → throttle = mass / (5·Pmax)', () => {
  const r = compute({ rock: { mass: 10000, resistance: 0 }, lasers: [{ head: HELIX1 }] }, ref);
  assert.strictEqual(C, 0.2);
  assert.strictEqual(r.throttle, 51.3);           // 10000 / (5 × 3900) = 0.5128
  assert.strictEqual(r.pNeed, 2000);               // 0.2 × 10000
  assert.strictEqual(r.verdict, 'ok');
  assert.strictEqual(r.massMax, 19500);            // 5 × 3900
});

test('resistance: head modifier scales the rock resistance (Helix I −30 % on a 50 % rock)', () => {
  const r = compute({ rock: { mass: 10000, resistance: 50 }, lasers: [{ head: HELIX1 }] }, ref);
  assert.strictEqual(r.rEff, 35);                  // 50 × 0.7
  assert.strictEqual(r.throttle, 78.9);            // 10000 / (5 × 3900 × 0.65)
  assert.strictEqual(r.verdict, 'ok');             // ≤ 85 % with the default 15 % margin
});

test('active module counts only when fired (Surge +50 % power, −15 % resistance)', () => {
  const off = compute({ rock: { mass: 15000, resistance: 40 }, lasers: [{ head: HELIX1, modules: [{ id: 'surge-module', active: false }] }] }, ref);
  const on = compute({ rock: { mass: 15000, resistance: 40 }, lasers: [{ head: HELIX1, modules: [{ id: 'surge-module', active: true }] }] }, ref);
  assert.strictEqual(off.perLaser[0].pMax, 3900);
  assert.strictEqual(on.perLaser[0].pMax, 5850);
  assert.ok(on.throttle < off.throttle);
  assert.strictEqual(on.rEff, 23.7);               // 40 × 0.7 × 0.845 (Surge is −15.5 % in game data, −15 % on the label)
});

test('module slots are capped by the head (Klein-S2 has 1 slot → second module ignored)', () => {
  const r = compute({ rock: { mass: 10000, resistance: 0 }, lasers: [{ head: 'klein-s2-mining-laser', modules: [{ id: 'rieger-c3-module' }, { id: 'rieger-c3-module' }] }] }, ref);
  assert.strictEqual(r.perLaser[0].pMax, 5437.5);   // 4350 × 1.25 once, not twice
});

test('gadget: Sabir halves rock resistance for every head', () => {
  const plain = compute({ rock: { mass: 20000, resistance: 60 }, lasers: [{ head: HELIX2 }] }, ref);
  const sabir = compute({ rock: { mass: 20000, resistance: 60 }, lasers: [{ head: HELIX2 }], gadget: 'sabir' }, ref);
  assert.strictEqual(plain.rEff, 42);              // 60 × 0.7
  assert.strictEqual(sabir.rEff, 21);              // 60 × 0.7 × 0.5
  assert.ok(sabir.throttle < plain.throttle);
});

test('multi-laser: per-head (default) is more conservative than pooled', () => {
  const mole = [{ head: HELIX2 }, { head: HELIX2 }, { head: HELIX2 }];
  const per = compute({ rock: { mass: 40000, resistance: 60 }, lasers: mole }, ref);
  const pooled = compute({ rock: { mass: 40000, resistance: 60 }, lasers: mole, options: { combine: 'pooled' } }, ref);
  assert.strictEqual(per.combine, 'per-head');
  assert.strictEqual(per.rEff, 42);
  assert.strictEqual(pooled.rEff, 20.6);           // 60 × 0.7³
  assert.ok(pooled.throttle < per.throttle);
  assert.strictEqual(per.pAvailable, 14790);       // 3 × 4930
});

test('fewest heads: a small rock on a MOLE needs one head', () => {
  const r = compute({ rock: { mass: 8000, resistance: 20 }, lasers: [{ head: HELIX2 }, { head: HELIX2 }, { head: HELIX2 }] }, ref);
  assert.ok(r.bestSubset);
  assert.strictEqual(r.bestSubset.heads.length, 1);
});

test('verdicts: marginal inside the safety margin, short beyond it, unbreakable at ≥100 % effective resistance', () => {
  const marginal = compute({ rock: { mass: 18000, resistance: 0 }, lasers: [{ head: HELIX1 }] }, ref); // 18000/19500 = 92 %
  assert.strictEqual(marginal.verdict, 'marginal');
  const short = compute({ rock: { mass: 30000, resistance: 0 }, lasers: [{ head: HELIX1 }] }, ref);
  assert.strictEqual(short.verdict, 'short');
  assert.strictEqual(short.shortfallMW, 2100);     // 0.2 × 30000 − 3900
  const unb = compute({ rock: { mass: 5000, resistance: 80 }, lasers: [{ head: ARBOR2 }] }, ref); // 80 × 1.25 = 100 %
  assert.strictEqual(unb.verdict, 'unbreakable');
  assert.strictEqual(unb.throttle, Infinity);
});

test('tips: when short, a resistance gadget or an unfired consumable that would crack it is listed', () => {
  const r = compute({ rock: { mass: 13000, resistance: 55 }, lasers: [{ head: HELIX1, modules: [{ id: 'surge-module', active: false }] }] }, ref);
  assert.strictEqual(r.verdict, 'short');
  assert.ok(r.tips.some(t => t.kind === 'gadget' && t.id === 'sabir'), JSON.stringify(r.tips));
  assert.ok(r.tips.some(t => t.kind === 'module' && t.id === 'surge-module'), JSON.stringify(r.tips));
  for (const t of r.tips) assert.ok(t.throttle <= 85);
});

test('instability is advisory: reported with head/module/gadget factors, never changes the verdict', () => {
  const a = compute({ rock: { mass: 5000, resistance: 10, instability: 40 }, lasers: [{ head: 'pitman-mining-laser' }] }, ref); // +35 %
  assert.strictEqual(a.iEff, 54);
  assert.strictEqual(a.iBand, 'mid');
  const b = compute({ rock: { mass: 5000, resistance: 10, instability: 0 }, lasers: [{ head: 'pitman-mining-laser' }] }, ref);
  assert.strictEqual(a.verdict, b.verdict);
});

test('empty / unknown input is safe', () => {
  const r = compute({ rock: { mass: 0 }, lasers: [{ head: 'nope' }] }, ref);
  assert.strictEqual(r.verdict, 'ok');
  assert.strictEqual(r.perLaser.length, 0);
  assert.strictEqual(r.pNeed, 0);
});
