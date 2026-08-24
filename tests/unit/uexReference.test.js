'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const uexReference = require('../../functions/uexReference');

test('loadReference caches until reload is requested', () => {
  const first = uexReference.loadReference();
  const second = uexReference.loadReference();
  assert.strictEqual(first, second);
  const reloaded = uexReference.loadReference({ reload: true });
  assert.notStrictEqual(first, reloaded);
  assert.deepStrictEqual(first.locations, reloaded.locations);
});

test('bodyOfLocation resolves a real committed location to its known body', () => {
  // "Area 18" is committed in data/uex-reference.json with body "ArcCorp".
  assert.strictEqual(uexReference.bodyOfLocation('Area 18'), 'ArcCorp');
  // "Everus Harbor" is committed with body "Hurston".
  assert.strictEqual(uexReference.bodyOfLocation('Everus Harbor'), 'Hurston');
});

test('bodyOfLocation returns null for an unknown name', () => {
  assert.strictEqual(uexReference.bodyOfLocation('Definitely Not A Real Place'), null);
  assert.strictEqual(uexReference.bodyOfLocation(''), null);
  assert.strictEqual(uexReference.bodyOfLocation(undefined), null);
});

test('bodyOfLocation matches case/punctuation-insensitively, like the original normName()', () => {
  assert.strictEqual(uexReference.bodyOfLocation('area 18'), 'ArcCorp');
  assert.strictEqual(uexReference.bodyOfLocation('AREA-18'), 'ArcCorp');
  assert.strictEqual(uexReference.bodyOfLocation('  Area   18!! '), 'ArcCorp');
});

test('listCommodities and listLocations return arrays sourced from the committed reference', () => {
  const commodities = uexReference.listCommodities();
  const locations = uexReference.listLocations();
  assert.ok(Array.isArray(commodities) && commodities.length > 0);
  assert.ok(Array.isArray(locations) && locations.length > 0);
  assert.ok(commodities.some((c) => c.name === 'Gold'));
});

test('referenceStatus reports type/count/path/loadedAt', () => {
  const status = uexReference.referenceStatus();
  assert.strictEqual(status.type, 'UexReference');
  assert.strictEqual(status.path, 'data/uex-reference.json');
  assert.ok(status.count > 0);
  assert.ok(!Number.isNaN(Date.parse(status.loadedAt)));
});
