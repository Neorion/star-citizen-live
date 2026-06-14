'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const StarCitizenService = require('../app/server');

const PORT = 3199;
const BASE = '/services/star-citizen';

function call (method, path, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = bodyObj ? JSON.stringify(bodyObj) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, json: b ? JSON.parse(b) : null }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

test('mission register REST flow (create→apply→accept→claim→validate) with 403 guards', async () => {
  const s = new StarCitizenService({ port: PORT, logfile: null, discord: { enable: false }, missions: { enable: true, officers: ['boss'] } });
  await s.start();
  try {
    // create requires an officer
    let r = await call('POST', `${BASE}/missions`, { title: 'Op', createdBy: 'rando' });
    assert.strictEqual(r.status, 403, 'non-officer create is forbidden');
    r = await call('POST', `${BASE}/missions`, { title: 'Escort Op', type: 'fleet-action', reward: 0, outOfGame: true, createdBy: 'boss' });
    assert.strictEqual(r.status, 200);
    const mid = r.json.data.id;
    assert.strictEqual(r.json.data.status, 'open');

    // member applies
    r = await call('POST', `${BASE}/missions/${mid}/apply`, { applicantId: 'PilotJane', message: 'in' });
    assert.strictEqual(r.status, 200);
    const appId = r.json.data.id;

    // officer list of applications
    r = await call('GET', `${BASE}/missions/${mid}/applications`);
    assert.strictEqual(r.json.data.length, 1);

    // non-officer cannot decide
    r = await call('POST', `${BASE}/applications/${appId}/decision`, { decision: 'accept', officerId: 'rando' });
    assert.strictEqual(r.status, 403);
    // officer accepts
    r = await call('POST', `${BASE}/applications/${appId}/decision`, { decision: 'accept', officerId: 'boss' });
    assert.strictEqual(r.status, 200);

    // wrong member cannot claim
    r = await call('POST', `${BASE}/missions/${mid}/claim`, { claimantId: 'SomeoneElse' });
    assert.strictEqual(r.status, 400);
    // assignee claims
    r = await call('POST', `${BASE}/missions/${mid}/claim`, { claimantId: 'PilotJane', note: 'done' });
    assert.strictEqual(r.status, 200);
    const claimId = r.json.data.id;

    // officer validates → completed
    r = await call('POST', `${BASE}/claims/${claimId}/validate`, { decision: 'approve', officerId: 'boss' });
    assert.strictEqual(r.status, 200);
    r = await call('GET', `${BASE}/missions/${mid}`);
    assert.strictEqual(r.json.data.status, 'completed');

    // audit endpoint reflects the chain
    r = await call('GET', `${BASE}/audit`);
    assert.ok(r.json.data.length >= 5, 'audit has the lifecycle entries');

    // unknown mission → 404
    r = await call('POST', `${BASE}/missions/nope/apply`, { applicantId: 'X' });
    assert.strictEqual(r.status, 404);
  } finally {
    await s.stop();
  }
});
