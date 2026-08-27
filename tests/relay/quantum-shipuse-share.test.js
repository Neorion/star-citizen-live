'use strict';

/**
 * WS2 follow-up: quantum-travel + ship-use sharing over Fabric.
 *
 * Extends the existing kills/deaths/incaps/vehicle-destroy/missionlog sharing
 * pattern to also cover quantum:select/quantum:arrive and vehicle:control
 * (action:'clear'), so a consenting fleet's location/ship data folds into
 * this node's history.quantum/history.shipUse the same way deaths/missions
 * already do — and so functions/opParticipation.js / functions/shipUsage.js
 * reflect the whole fleet, not just the local player.
 *
 * Consent is the EXACT SAME per-peer-or-global gate that already governs
 * every other shared collection (_canShareLogs()/_logSharePublishOpts()) —
 * nothing new was built for "share with only certain members," because the
 * existing per-peer `shareLogs` flag already IS that mechanism.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const LiveRelay = require('../../services/LiveRelay');
const { createIdentity, signEnvelope } = require('../../functions/identity');
const opParticipation = require('../../functions/opParticipation');

const BASE = '/services/star-citizen';

function request (port, method, path, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
    });
    req.on('error', reject);
    if (payload) req.write(JSON.stringify(payload));
    req.end();
  });
}

const SELECT_LINE = '<2026-07-23T23:55:53.091Z> [Notice] <Player Selected Quantum Target - Local> [ItemNavigation][CL][416] | NOT AUTH | DRAK_Clipper_734066837132[734066837132]|CSCItemNavigation::OnPlayerSelectedQuantumTarget|Player has selected point Lorville as their destination, routing locally [Team_CGP4][QuantumTravel]';
const CLEAR_DRIVER_LINE =
  "<2026-06-15T10:00:00.000Z> [Notice] <Vehicle Control Flow>CVehicleMovementBase::ClearDriver: " +
  "Local client node [1234] releasing control token for 'AEGS_Avenger_Titan_487288078845' [56789]";

// --- Outbound: quantum/vehicle:control only queue for Fabric sharing when authorized ---

test('quantum:select and vehicle:control(clear) are NOT queued for sharing by default (off)', async () => {
  const svc = new LiveRelay({ port: 0, fabric: { enable: false }, missions: { enable: false }, discord: { enable: false }, reparse: { dirs: [] } });
  await svc.start();
  svc._startFabricFlush(); // wire the (normally Fabric-lifecycle-gated) uplink listeners for this direct test
  try {
    assert.strictEqual(svc._canShareLogs(), false, 'no identity/consent configured — sharing is off by default');
    svc.handleLogChange(SELECT_LINE);
    svc.handleLogChange(CLEAR_DRIVER_LINE);
    assert.strictEqual(svc._uplinkQueue.length, 0, 'nothing queued while sharing is not authorized');
  } finally {
    clearInterval(svc._uplinkTimer);
    await svc.stop();
  }
});

test('quantum:select and vehicle:control(clear) queue for the "quantum"/"shipuse" collections once sharing is authorized', async () => {
  const svc = new LiveRelay({ port: 0, fabric: { enable: false }, missions: { enable: false }, discord: { enable: false }, reparse: { dirs: [] } });
  await svc.start();
  svc._startFabricFlush();
  try {
    svc._identity = { pubkey: 'test-pubkey' }; // _canShareLogs() requires an unlocked identity too
    svc._shareLogsGlobal = true; // simplest form of "authorized" — same gate as every other shared collection
    svc.handleLogChange(SELECT_LINE);
    svc.handleLogChange(CLEAR_DRIVER_LINE);
    assert.strictEqual(svc._uplinkQueue.length, 2);
    assert.strictEqual(svc._uplinkQueue[0].collection, 'quantum');
    assert.strictEqual(svc._uplinkQueue[0].data.destination, 'Lorville');
    assert.strictEqual(svc._uplinkQueue[1].collection, 'shipuse');
    assert.strictEqual(svc._uplinkQueue[1].data.vehicle, 'AEGS_Avenger_Titan_487288078845');
  } finally {
    clearInterval(svc._uplinkTimer);
    await svc.stop();
  }
});

test('a vehicle:control event that is NOT a "clear" action is not queued (only releasing control counts as ship use)', async () => {
  const svc = new LiveRelay({ port: 0, fabric: { enable: false }, missions: { enable: false }, discord: { enable: false }, reparse: { dirs: [] } });
  await svc.start();
  svc._startFabricFlush();
  try {
    svc._shareLogsGlobal = true;
    // Simulate a non-clear vehicle:control event directly through the generic 'event' bus
    // (there is no real-format log line for a non-clear action to replay here).
    svc.emit('event', { kind: 'vehicle:control', action: 'something-else', vehicle: 'X' });
    assert.strictEqual(svc._uplinkQueue.length, 0);
  } finally {
    clearInterval(svc._uplinkTimer);
    await svc.stop();
  }
});

// --- Inbound: a peer's shared quantum/shipuse events fold into this node's cumulative history ---

async function startServer (extra = {}) {
  const base = { port: 0, mode: 'server', missions: { enable: false }, ingest: { httpEnable: true }, reparse: { dirs: [] } };
  const merged = Object.assign({}, base, extra);
  merged.ingest = Object.assign({}, base.ingest, extra.ingest || {});
  const svc = new LiveRelay(merged);
  await svc.start();
  return { svc, port: svc.server.address().port };
}

test('a peer-shared quantum:select event folds into history.quantum, deduped on replay', async () => {
  const { svc, port } = await startServer();
  const identity = createIdentity();
  try {
    const events = [{
      collection: 'quantum',
      data: { kind: 'quantum:select', player: 'PeerPilot', timestamp: '2026-08-01T01:00:00.000Z', destination: 'Lorville', vehicle: 'DRAK_Clipper_734066837132' }
    }];
    const envelope = signEnvelope(identity, { events, sentAt: 'x' });

    const first = await request(port, 'POST', `${BASE}/events`, envelope);
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    assert.strictEqual(first.body.created, 1);
    assert.strictEqual(svc.history.quantum.length, 1);
    assert.strictEqual(svc.history.quantum[0].player, 'PeerPilot');
    assert.strictEqual(svc.history.quantum[0].destination, 'Lorville');

    const second = await request(port, 'POST', `${BASE}/events`, envelope);
    assert.strictEqual(second.body.created, 0, 'replaying the same signed batch is idempotent at the raw-collection level');
    assert.strictEqual(svc.history.quantum.length, 1, 'history fold is also idempotent (same content id)');
  } finally { await svc.stop(); }
});

test('a peer-shared vehicle:control(clear) event folds into history.shipUse', async () => {
  const { svc, port } = await startServer();
  const identity = createIdentity();
  try {
    const events = [{
      collection: 'shipuse',
      data: { kind: 'vehicle:control', action: 'clear', player: 'PeerPilot', timestamp: '2026-08-01T01:10:00.000Z', vehicle: 'AEGS_Avenger_Titan_487288078845' }
    }];
    const envelope = signEnvelope(identity, { events, sentAt: 'x' });

    const res = await request(port, 'POST', `${BASE}/events`, envelope);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.created, 1);
    assert.strictEqual(svc.history.shipUse.length, 1);
    assert.strictEqual(svc.history.shipUse[0].player, 'PeerPilot');
    assert.strictEqual(svc.history.shipUse[0].ship, 'Avenger Titan');
  } finally { await svc.stop(); }
});

test('a non-clear vehicle:control event in the shipuse collection is accepted but NOT folded into history.shipUse', async () => {
  const { svc, port } = await startServer();
  const identity = createIdentity();
  try {
    const events = [{
      collection: 'shipuse',
      data: { kind: 'vehicle:control', action: 'something-else', player: 'PeerPilot', timestamp: '2026-08-01T01:10:00.000Z', vehicle: 'X' }
    }];
    const envelope = signEnvelope(identity, { events, sentAt: 'x' });
    const res = await request(port, 'POST', `${BASE}/events`, envelope);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.created, 1, 'the raw collection record is still stored');
    assert.strictEqual(svc.history.shipUse.length, 0, 'but it does not fold into cumulative history');
  } finally { await svc.stop(); }
});

// --- End-to-end value: the fleet's shared data actually shows up in the real feature modules ---

test('once folded, a peer\'s shared quantum+shipuse data appears in opParticipation rollups (functions/shipUsage.js — a sibling WS3 branch — reads the identical history.shipUse collection and will inherit this the same way once the branches merge, no extra work needed there)', async () => {
  const { svc, port } = await startServer();
  const identity = createIdentity();
  try {
    const events = [
      { collection: 'quantum', data: { kind: 'quantum:select', player: 'PeerPilot', timestamp: '2026-08-01T01:00:00.000Z', destination: 'Lorville', vehicle: 'DRAK_Clipper_734066837132' } },
      { collection: 'shipuse', data: { kind: 'vehicle:control', action: 'clear', player: 'PeerPilot', timestamp: '2026-08-01T01:10:00.000Z', vehicle: 'AEGS_Avenger_Titan_487288078845' } }
    ];
    await request(port, 'POST', `${BASE}/events`, signEnvelope(identity, { events, sentAt: 'x' }));

    const analytics = svc._analyticsDataset();
    const window = opParticipation.opWindow({ start: '2026-08-01T00:00:00Z', end: '2026-08-01T02:00:00Z' });
    const rows = opParticipation.participationRows(analytics, window, {});
    const peerRow = rows.find((r) => r.member === 'PeerPilot');
    assert.ok(peerRow, 'the peer shows up in participation rows despite never being the LOCAL player');
    assert.ok(peerRow.locations.some((l) => l.zone === 'Lorville'));
    assert.ok(peerRow.ships.some((s) => s.ship === 'Avenger Titan'));
  } finally { await svc.stop(); }
});
