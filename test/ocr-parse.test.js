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
  assert.deepStrictEqual(c.deliveries[0], { scu: 9, commodity: 'Hydrogen', dropoff: "Seer's Canyon" });
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

test('non-contract text is rejected (folder-noise guard)', () => {
  const c = parseContractText('Squadron Battle  Score 12  Kills 3  Deaths 1');
  assert.strictEqual(c.isContract, false);
  assert.strictEqual(c.deliveries.length, 0);
});
