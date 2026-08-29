'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseContractText, normalize } = require('../app/ocr-parse');

// Real-shape OCR text (mimics the bake-off misreads: ¤ -> stray digit, slash -> 7).
const FROM = `OFFERS ACCEPTED (7/10) HISTORY BEACONS
Junior | Stellar Small Haul | from Fallow Field Rewaro 7 172,250
Contract Deadline N/A
Contracted By Red Wind Linehaul
DETAILS PRIMARY OBJECTIVES
Deliver 0/9 SCU of Hydrogen to Seer's Canyon on Pyro 5b.
Collect Hydrogen from Fallow Field.
Deliver 0715 SCU of Hydrogen to Last Landings on Pyro VI.
Collect Hydrogen from Fallow Field.`;

const TO = `Junior | Stellar Small Haul | to Orbituary Rewanc 7 172,250
Contracted By Red Wind Linehaul
Deliver 0/14 SCU of Silicon to Orbituary above Pyro III.
Collect Silicon from Ashland.
Collect Silicon from The Golden Riviera.`;

test('parses a "from X" haul: pickup, deliveries, reward (with OCR misreads fixed)', () => {
  const c = parseContractText(FROM);
  assert.strictEqual(c.isContract, true);
  assert.strictEqual(c.rank, 'Junior');
  assert.strictEqual(c.contractType, 'Stellar Small Haul');
  assert.strictEqual(c.reward, '172,250');            // ¤ -> "7" stray digit skipped
  assert.strictEqual(c.pickup, 'Fallow Field');       // from-title, no Reward bleed
  assert.strictEqual(c.deliveries.length, 2);
  assert.deepStrictEqual(c.deliveries[0], { scu: 9, commodity: 'Hydrogen', dropoff: "Seer's Canyon", body: 'Pyro' });
  assert.strictEqual(c.deliveries[1].scu, 15);        // "0715" slash-misread -> 0/15
  assert.strictEqual(c.confidence, 'high');
});

test('parses a "to X" haul: dropoff from title, pickup from the Collect line', () => {
  const c = parseContractText(TO);
  assert.strictEqual(c.dropoff, 'Orbituary');         // title, celestial suffix stripped
  assert.strictEqual(c.pickup, 'Ashland');            // first Collect-from (log never has this)
  assert.strictEqual(c.pickups.length, 2);
  assert.strictEqual(c.deliveries[0].scu, 14);
  assert.strictEqual(c.reward, '172,250');
});

test('the slash-misread normalizer only touches Deliver counts', () => {
  assert.match(normalize('Deliver 0710 SCU'), /Deliver 0\/10 SCU/);
  assert.strictEqual(normalize('Deliver 0/7 SCU'), 'Deliver 0/7 SCU');   // legit /7 untouched
});

test('auto-classifies by button: ABANDON -> active, ACCEPT OFFER -> candidate', () => {
  const accepted = parseContractText('Junior | Small Haul | to Orbituary\nDeliver 0/5 SCU of Silicon to Orbituary.\nABANDON  SHARE  TRACK');
  assert.strictEqual(accepted.suggestedStatus, 'active');
  const offer = parseContractText('Junior | Small Haul | from Fallow Field\nDeliver 0/9 SCU of Hydrogen to Rustville.\nACCEPT OFFER  DECLINE');
  assert.strictEqual(offer.suggestedStatus, 'candidate');
  const held = parseContractText('OFFERS  ACCEPTED (7/10)  HISTORY\nSmall Haul to Ruin Station\nABANDON');
  assert.deepStrictEqual(held.held, { accepted: 7, max: 10 });
});

test('a Stanton-planet haul: strips the "on Hurston" suffix and reads the body from it', () => {
  const c = parseContractText(`Member | Small Haul | from Everus Harbor [BP]*
Reward  90,750
Contracted By Covalex Independent Contractors
Deliver 0/2 SCU of Stims to Covalex Distribution Center S1DC06 on Hurston.
Collect Stims from Everus Harbor.
Deliver 0/3 SCU of Stims to HDPC-Farnesway on Hurston.
Collect Stims from Everus Harbor.
Deliver 0/3 SCU of Stims to HDPC-Cassillo on Hurston.
Collect Stims from Everus Harbor.
Deliver 0/2 SCU of Stims to Sakura Sun Magnolia Workcenter on Hurston.
Collect Stims from Everus Harbor.`);
  assert.strictEqual(c.deliveries.length, 4);                       // all four, not just the top one
  assert.strictEqual(c.pickup, 'Everus Harbor');
  assert.deepStrictEqual(c.deliveries.map((d) => d.scu), [2, 3, 3, 2]);
  assert.deepStrictEqual(c.deliveries[1], { scu: 3, commodity: 'Stims', dropoff: 'HDPC-Farnesway', body: 'Hurston' });
  assert.ok(c.deliveries.every((d) => d.body === 'Hurston'));       // body read from the suffix
  assert.ok(c.deliveries.every((d) => !/ on /i.test(d.dropoff)));   // suffix stripped from every name
});

test('recovers every objective from a mangled WHOLE-IMAGE read (not just the top one)', () => {
  // Uncalibrated grab of a two-column contract screen: the low-contrast right column
  // misreads per line ("SCU"->"SGU", "Deliver"->"Deiiver"), which used to drop all but
  // the first objective. The token-fuzzed regex now recovers all three.
  const whole = `DETAILS PRIMARY OBJECTIVES
Greetings, Deliver 0/4 SCU of Silicon to HDPC-Cassillo on Hurston.
Seems like Everus Harbor above Hurston has some 4 Deliver 0/2 SGU of Silicon to Teasa Spaceport in Lorville.
a few different spots. Deiiver 0/4 SCU of Silicon to Sakura Sun Magnolia Workcenter on Hurston.`;
  const c = parseContractText(whole);
  assert.strictEqual(c.deliveries.length, 3);
  assert.deepStrictEqual(c.deliveries.map((d) => d.scu), [4, 2, 4]);
  assert.strictEqual(c.deliveries[1].dropoff, 'Teasa Spaceport');       // "in Lorville" tail stripped
  assert.strictEqual(c.deliveries[1].body, 'Hurston');                  // Lorville -> Hurston
  assert.ok(c.deliveries.every((d) => d.commodity === 'Silicon'));
});

test('non-contract text is rejected (folder-noise guard)', () => {
  const c = parseContractText('Squadron Battle  Score 12  Kills 3  Deaths 1');
  assert.strictEqual(c.isContract, false);
  assert.strictEqual(c.deliveries.length, 0);
});
