'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { isLocalHost } = require('../../functions/loopbackHost');

test('isLocalHost accepts only loopback names on the listening port', () => {
  assert.strictEqual(isLocalHost('127.0.0.1:3042', 3042), true);
  assert.strictEqual(isLocalHost('localhost:3042', 3042), true);
  assert.strictEqual(isLocalHost('LOCALHOST:3042', '3042'), true);
  assert.strictEqual(isLocalHost('[::1]:3042', 3042), true);
});

test('isLocalHost refuses rebinding names, wrong ports and missing headers', () => {
  assert.strictEqual(isLocalHost('rebind.example.net:3042', 3042), false);
  assert.strictEqual(isLocalHost('127.0.0.1.example.net:3042', 3042), false);
  assert.strictEqual(isLocalHost('127.0.0.1:9999', 3042), false);
  assert.strictEqual(isLocalHost('127.0.0.1', 3042), false);
  assert.strictEqual(isLocalHost('203.0.113.7:3042', 3042), false);
  assert.strictEqual(isLocalHost('', 3042), false);
  assert.strictEqual(isLocalHost(undefined, 3042), false);
});
