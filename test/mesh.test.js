'use strict';

// BUILD-PLAN-fabric-mesh.md WS2: identity + FabricSync skeleton + the
// /mesh status route + signed-envelope verification on /events. WS3 adds
// the peer roster, the outbound consent gate, and the queue + flush loop
// (see the "--- WS3 ---" section below). These tests must stay green with
// NO Fabric installed (meshIdentity.available() is false in this
// environment) - that's the whole point of keeping the core service
// zero-dependency; WS3 in particular needs no @fabric/core at all, only a
// `network` test double. A couple of tests are conditionally skipped when
// @fabric/core IS present, to exercise the real keypair path on a machine
// that has run `npm run fabric:install`.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const EventEmitter = require('events');

const meshIdentity = require('../services/meshIdentity');
const fabricAddress = require('../services/fabricAddress');
const FabricSync = require('../services/FabricSync');
const StarCitizenService = require('../app/server');

const HAS_FABRIC = meshIdentity.available();

function call (port, method, urlPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = bodyObj ? JSON.stringify(bodyObj) : null;
    const r = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, json: b ? JSON.parse(b) : null }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

test('requiring services/FabricSync.js pulls in no @fabric/core module (zero-dep when disabled)', () => {
  const before = Object.keys(require.cache).length;
  delete require.cache[require.resolve('../services/FabricSync')];
  delete require.cache[require.resolve('../services/meshIdentity')];
  require('../services/FabricSync');
  const loadedFabricCore = Object.keys(require.cache).some((k) => k.includes('@fabric'));
  assert.strictEqual(loadedFabricCore, false, 'requiring FabricSync must not eagerly require @fabric/core');
  assert.ok(Object.keys(require.cache).length >= before);
});

test('meshIdentity.available() reflects whether @fabric/core is actually installed', () => {
  assert.strictEqual(typeof meshIdentity.available(), 'boolean');
});

test('meshIdentity.canonicalStringify is order-independent and payloadDigest is deterministic', () => {
  const a = { b: 2, a: 1, nested: { y: 2, x: 1 } };
  const b = { a: 1, nested: { x: 1, y: 2 }, b: 2 };
  assert.strictEqual(meshIdentity.canonicalStringify(a), meshIdentity.canonicalStringify(b));
  assert.deepStrictEqual(meshIdentity.payloadDigest(a), meshIdentity.payloadDigest(b));
});

test('meshIdentity.pubkeyXOnly/pubkeysMatch normalize compressed vs x-only hex', () => {
  const xOnly = 'a'.repeat(64);
  const compressed = '02' + xOnly;
  assert.strictEqual(meshIdentity.pubkeyXOnly(compressed), xOnly);
  assert.strictEqual(meshIdentity.pubkeyXOnly(xOnly), xOnly);
  assert.ok(meshIdentity.pubkeysMatch(compressed, xOnly));
  assert.ok(!meshIdentity.pubkeysMatch(compressed, 'b'.repeat(64)));
  assert.strictEqual(meshIdentity.pubkeyXOnly('not-hex'), null);
});

test('encryptIdentity/decryptIdentity round-trip using Node crypto only (no Fabric needed)', () => {
  // A synthetic "identity" shaped like createIdentity()'s output - exercises
  // the at-rest encryption path without needing a real Fabric keypair.
  const fake = { mnemonic: 'test test test test test test test test test test test junk', xprv: 'xprv-fake-material-not-a-real-key', xpub: 'xpub-fake', pubkey: 'c'.repeat(64), network: 'regtest' };
  const enc = meshIdentity.encryptIdentity(fake, 'correct horse battery staple');
  assert.ok(enc.ciphertext && enc.iv && enc.tag && enc.kdf.salt);
  assert.strictEqual(enc.pubkey, fake.pubkey, 'public fields stay readable unencrypted');
  assert.throws(() => meshIdentity.decryptIdentity(enc, 'wrong password'), /Could not decrypt/);
});

test('FabricSync reports installed:false and ready:false with no @fabric/core, and start() is a safe no-op', async () => {
  if (HAS_FABRIC) return; // this scenario only applies to the zero-dep environment
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-mesh-'));
  const fs1 = new FabricSync({ settings: { enable: true }, storeDir: dir });
  assert.strictEqual(fs1.installed, false);
  assert.strictEqual(fs1.ready, false);
  const ok = await fs1.start();
  assert.strictEqual(ok, false);
  assert.strictEqual(fs1.ready, false);
  const status = fs1.status();
  assert.strictEqual(status.installed, false);
  assert.strictEqual(status.pubkey, null);
  await fs1.stop(); // must not throw
});

test('FabricSync.checkEnvelope rejects a malformed envelope and an unrecognized signer, without needing @fabric/core for the shape checks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-mesh-'));
  const fs1 = new FabricSync({ settings: { enable: true }, storeDir: dir });

  let r = fs1.checkEnvelope(null, null);
  assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 401);

  r = fs1.checkEnvelope({ pubkey: 'aa'.repeat(32) }, null); // missing signature/payload
  assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 401);

  r = fs1.checkEnvelope({ pubkey: 'aa'.repeat(32), payload: { events: [] }, signature: 'zz' }, ['bb'.repeat(32)]);
  assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 403, 'sender not on the roster');
});

test('GET …/mesh reports {enabled:false} when the fabric backbone is off (the default)', async () => {
  const s = new StarCitizenService({ port: 0, logfile: null, discord: { enable: false } });
  await s.start();
  const port = s.server.address().port;
  try {
    const r = await call(port, 'GET', '/services/star-citizen/mesh');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.enabled, false);
  } finally { await s.stop(); }
});

test('GET …/mesh reports installed/ready status once fabric.enable is turned on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-mesh-'));
  const s = new StarCitizenService({ port: 0, logfile: null, discord: { enable: false }, fabric: { enable: true, identityFile: path.join(dir, 'id.json'), peersFile: path.join(dir, 'peers.json') } });
  await s.start();
  const port = s.server.address().port;
  try {
    const r = await call(port, 'GET', '/services/star-citizen/mesh');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.enabled, true);
    assert.strictEqual(r.json.installed, HAS_FABRIC);
    if (HAS_FABRIC) {
      assert.ok(r.json.pubkey, 'identity created on start');
      assert.ok(fs.existsSync(path.join(dir, 'id.json')), 'identity persisted to disk');
    } else {
      assert.strictEqual(r.json.pubkey, null);
    }
  } finally { await s.stop(); }
});

test('POST …/events with a signed envelope is refused 501 when the mesh backbone is disabled', async () => {
  const s = new StarCitizenService({ port: 0, logfile: null, discord: { enable: false }, ingest: { httpEnable: true } });
  await s.start();
  const port = s.server.address().port;
  try {
    const r = await call(port, 'POST', '/services/star-citizen/events', { pubkey: 'aa'.repeat(32), payload: { events: [] }, signature: 'zz' });
    assert.strictEqual(r.status, 501);
  } finally { await s.stop(); }
});

test('POST …/events refuses an unsigned batch outright when ingest.requireSigned is set', async () => {
  const s = new StarCitizenService({ port: 0, logfile: null, discord: { enable: false }, ingest: { httpEnable: true, requireSigned: true } });
  await s.start();
  const port = s.server.address().port;
  try {
    const r = await call(port, 'POST', '/services/star-citizen/events', { source: 'peer1', events: [] });
    assert.strictEqual(r.status, 401);
  } finally { await s.stop(); }
});

test('WS1 unsigned ingest still works unchanged when requireSigned is left off (regression)', async () => {
  const s = new StarCitizenService({ port: 0, logfile: null, discord: { enable: false }, ingest: { httpEnable: true } });
  await s.start();
  const port = s.server.address().port;
  try {
    const r = await call(port, 'POST', '/services/star-citizen/events', { source: 'peer1', events: [{ collection: 'deaths', data: { player: 'PeerPilot' } }] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.created, 1);
  } finally { await s.stop(); }
});

// --- Real keypair round trip - only runs once @fabric/core is installed ---
test('signEnvelope/verifyEnvelope round-trip and POST …/events accepts a signed batch end-to-end', { skip: !HAS_FABRIC }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-mesh-'));
  const identity = meshIdentity.createIdentity();
  const envelope = meshIdentity.signEnvelope(identity, { events: [{ collection: 'deaths', data: { player: 'PeerPilot' } }] });
  assert.ok(meshIdentity.verifyEnvelope(envelope));
  const tampered = Object.assign({}, envelope, { payload: { events: [] } });
  assert.strictEqual(meshIdentity.verifyEnvelope(tampered), false, 'tampering with the payload invalidates the signature');

  const s = new StarCitizenService({ port: 0, logfile: null, discord: { enable: false }, ingest: { httpEnable: true }, fabric: { enable: true, identityFile: path.join(dir, 'id.json'), peersFile: path.join(dir, 'peers.json') } });
  await s.start();
  const port = s.server.address().port;
  try {
    const r = await call(port, 'POST', '/services/star-citizen/events', envelope);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.created, 1);
    const deaths = await call(port, 'GET', '/services/star-citizen/deaths');
    assert.strictEqual(deaths.json.data[0].source, `fabric:${identity.pubkey}`);
  } finally { await s.stop(); }
});

// --- WS3: peer roster, outbound consent gate, queue + flush (BUILD-PLAN-fabric-mesh.md) ---
// None of this needs @fabric/core - it runs entirely against a stubbed
// identity and an injected `network` test double, per T3's own scope note.

test('fabricAddress: isFabricAddress/normalizeFabricAddress/isSelfFabricAddress on real-shaped inputs', () => {
  assert.strictEqual(fabricAddress.isFabricAddress('hub.fabric.pub:7777'), true);
  assert.strictEqual(fabricAddress.isFabricAddress('not-an-address'), false);
  assert.strictEqual(fabricAddress.isFabricAddress('https://hub.fabric.pub'), false, 'a URL is not a bare address');
  assert.strictEqual(fabricAddress.normalizeFabricAddress('https://hub.fabric.pub/', { migrate: true }), 'hub.fabric.pub:7777');
  assert.strictEqual(fabricAddress.normalizeFabricAddress('garbage'), null);
  assert.strictEqual(fabricAddress.isSelfFabricAddress('127.0.0.1:7777', { listenPort: 7777 }), true);
  assert.strictEqual(fabricAddress.isSelfFabricAddress('127.0.0.1:7778', { listenPort: 7777 }), false);
});

test('_normalizePeerRecord rejects a malformed address and a self-dial (loopback:samePort)', () => {
  const fabric = new FabricSync({ settings: { enable: true, port: 7777 } });
  assert.strictEqual(fabric._normalizePeerRecord({ address: 'not-an-address' }), null);
  assert.strictEqual(fabric._normalizePeerRecord({ address: '127.0.0.1:7777' }), null, 'dialing our own listen port is a self-loop');
  const rec = fabric._normalizePeerRecord({ address: '127.0.0.1:7778', label: 'friend' });
  assert.ok(rec && rec.address === '127.0.0.1:7778' && rec.enabled === true && rec.shareLogs === false);
});

test('peer roster persists to disk (stripped of lastSeen/lastError) and reloads on the next start()', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-mesh-'));
  const f1 = new FabricSync({ settings: { enable: true, peers: ['127.0.0.1:7801'] }, storeDir: dir });
  await f1.start();
  assert.strictEqual(f1.peers.length, 1);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'fabric-peers.json'), 'utf8'));
  assert.strictEqual('lastSeen' in onDisk[0], false, 'lastSeen is volatile - not persisted to the roster file');

  const f2 = new FabricSync({ settings: { enable: true }, storeDir: dir }); // no seeds this time - loads from disk
  await f2.start();
  assert.strictEqual(f2.peers.length, 1);
  assert.strictEqual(f2.peers[0].address, '127.0.0.1:7801');
  await f1.stop(); await f2.stop();
});

test('default (no consent granted anywhere): real death + mission:end lines queue nothing, _canShareLogs() is false', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-mesh-'));
  const s = new StarCitizenService({ port: 0, logfile: null, discord: { enable: false }, fabric: { enable: true, identityFile: path.join(dir, 'id.json'), peersFile: path.join(dir, 'peers.json') } });
  await s.start();
  try {
    // Neither shareLogsGlobal nor any peer's shareLogs is set - true whether
    // or not @fabric/core happens to be installed (identity alone is not consent).
    assert.strictEqual(s.fabric._canShareLogs(), false, 'no share path authorized -> nothing queues');
    s.handleLogChange("<2026-09-04T00:01:00.000Z> [Notice] <Adding non kept item [CSCActorCorpseUtils::PopulateItemPortForItemRecoveryEntitlement]> Item 'body_01_noMagicPocket_1 - Class(body_01_noMagicPocket)', Recorded data is: Port Name 'Body_ItemPort' [Team_CoreGameplayFeatures][Unknown]");
    s.handleLogChange('<2026-09-04T00:02:00.000Z> [Notice] <EndMission> Ending mission for player. MissionId[cccc3333-0319-4a6a-8b2b-ece75082c848] Player[LocalPilot] PlayerId[204821711285] CompletionType[Complete] Reason[Mission Ended] [Team_MissionFeatures][Missions]');
    assert.strictEqual(s.fabric._uplinkQueue.length, 0);
  } finally { await s.stop(); }
});

test('shareLogsGlobal + a stubbed identity queues real death + mission:end events, broadcast opts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-mesh-'));
  const s = new StarCitizenService({ port: 0, logfile: null, discord: { enable: false }, fabric: { enable: true, shareLogsGlobal: true, identityFile: path.join(dir, 'id.json'), peersFile: path.join(dir, 'peers.json') } });
  await s.start();
  s.fabric.identity = { pubkey: 'test' }; // stub - bypass the real @fabric/core keypair this environment doesn't have
  try {
    s.handleLogChange("<2026-09-04T00:01:00.000Z> [Notice] <Adding non kept item [CSCActorCorpseUtils::PopulateItemPortForItemRecoveryEntitlement]> Item 'body_01_noMagicPocket_1 - Class(body_01_noMagicPocket)', Recorded data is: Port Name 'Body_ItemPort' [Team_CoreGameplayFeatures][Unknown]");
    s.handleLogChange('<2026-09-04T00:02:00.000Z> [Notice] <EndMission> Ending mission for player. MissionId[cccc3333-0319-4a6a-8b2b-ece75082c848] Player[LocalPilot] PlayerId[204821711285] CompletionType[Complete] Reason[Mission Ended] [Team_MissionFeatures][Missions]');

    assert.strictEqual(s.fabric._uplinkQueue.length, 2);
    assert.strictEqual(s.fabric._uplinkQueue[0].collection, 'deaths');
    assert.strictEqual(s.fabric._uplinkQueue[1].collection, 'missionlog');
    assert.deepStrictEqual(s.fabric._logSharePublishOpts(), {}, 'global consent broadcasts to everyone connected');
  } finally { await s.stop(); }
});

test('a per-peer roster (not global) restricts _logSharePublishOpts to consenting, enabled peers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-mesh-'));
  const fabric = new FabricSync({ settings: { enable: true, peersFile: path.join(dir, 'peers.json') }, storeDir: dir });
  fabric.identity = { pubkey: 'test' };
  fabric.peers = [
    { address: '127.0.0.1:7801', enabled: true, shareLogs: true },
    { address: '127.0.0.1:7802', enabled: true, shareLogs: false }
  ];
  assert.deepStrictEqual(fabric._logSharePublishOpts(), { to: ['127.0.0.1:7801'] });

  fabric.peers[0].enabled = false;
  assert.strictEqual(fabric._logSharePublishOpts(), null, 'no enabled+consenting peer left -> nothing authorized');
});

test('queued payloads never carry raw/involves/id (T3.5 outbound hygiene)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-mesh-'));
  const service = new EventEmitter();
  const fabric = new FabricSync({ service, settings: { enable: true, shareLogsGlobal: true, peersFile: path.join(dir, 'peers.json') }, storeDir: dir });
  fabric.identity = { pubkey: 'test' };
  fabric._wireUplinkQueue();
  service.emit('kill', { id: 'abc', player: 'X', raw: '<the original log line>', involves: ['a', 'b'], timestamp: 'now' });
  assert.strictEqual(fabric._uplinkQueue.length, 1);
  const data = fabric._uplinkQueue[0].data;
  assert.ok(!('raw' in data) && !('involves' in data) && !('id' in data), 'local-only fields stripped before queuing');
  assert.strictEqual(data.player, 'X', 'everything else passes through');
});

test('_flushUplink requeues on a throw + emits uplink:error, retries clean, and holds the queue when nothing is connected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-mesh-'));
  const fabric = new FabricSync({ settings: { enable: true, shareLogsGlobal: true, peersFile: path.join(dir, 'peers.json') }, storeDir: dir });
  fabric.identity = { pubkey: 'test' };
  fabric._uplinkQueue.push({ collection: 'deaths', data: { player: 'X' } });

  let calls = 0;
  fabric.network = {
    ready: true,
    status: () => ({ fabricConnected: 1 }),
    publishEventBatch: () => { calls++; if (calls === 1) throw new Error('peer unreachable'); }
  };

  let errored = false;
  fabric.once('uplink:error', () => { errored = true; });
  await fabric._flushUplink();
  assert.strictEqual(errored, true);
  assert.strictEqual(fabric._uplinkQueue.length, 1, 'requeued on failure');

  let sent = null;
  fabric.once('uplink:sent', (e) => { sent = e; });
  await fabric._flushUplink();
  assert.strictEqual(fabric._uplinkQueue.length, 0);
  assert.strictEqual(sent.count, 1);

  // Nothing connected -> queue held, no publish attempted.
  fabric._uplinkQueue.push({ collection: 'deaths', data: { player: 'Y' } });
  fabric.network.status = () => ({ fabricConnected: 0 });
  await fabric._flushUplink();
  assert.strictEqual(fabric._uplinkQueue.length, 1, 'held - nothing connected');
  assert.strictEqual(calls, 2, 'network was not called a third time');
});

// --- WS4: real Peer transport - inbound dispatch + attribution (BUILD-PLAN-fabric-mesh.md) ---
// Only the two-node network test itself (test/mesh-peer.test.js) is gated
// on SC_FABRIC_TEST; this one exercises _onContractMessage() directly with
// a synthetic event shaped exactly like the real one @fabric/core emits
// (empirically confirmed against a real two-node run: `ev.signer` is the
// cryptographically-recovered x-only pubkey, NOT the full compressed form -
// see FabricSync.js's _onContractMessage comment). Still needs @fabric/core
// only because _contractId() computes our real contract id.
test('_onContractMessage attributes to the real (x-only) signer, upgrading to the full key only once it matches', { skip: !HAS_FABRIC }, () => {
  const EE = require('events');
  const service = new EE();
  const calls = [];
  service._ingestEvent = (source, collection, data) => { calls.push({ source, collection, data }); return { id: 'x', created: true }; };

  const fabric = new FabricSync({ service });
  const identity = meshIdentity.createIdentity();
  const xOnly = meshIdentity.pubkeyXOnly(identity.pubkey);
  const contract = fabric._contractId();

  fabric._onContractMessage({
    contract,
    signer: xOnly,
    object: {
      type: 'SCEventBatch',
      actor: { publicKey: identity.pubkey, id: identity.pubkey },
      object: { events: [{ collection: 'deaths', data: { player: 'PeerPilot' } }] }
    }
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].source, identity.pubkey, 'upgraded to the full compressed key once it matched the real signer');

  // A body claiming a DIFFERENT key than the real signer must never win -
  // attribution stays anchored to what the signature actually proved.
  const other = meshIdentity.createIdentity();
  fabric._onContractMessage({
    contract,
    signer: xOnly,
    object: {
      type: 'SCEventBatch',
      actor: { publicKey: other.pubkey, id: other.pubkey },
      object: { events: [{ collection: 'deaths', data: { player: 'Spoofed' } }] }
    }
  });
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[1].source, xOnly, 'mismatched claim rejected - falls back to the verified x-only signer, never the spoofed key');

  // A message under a different contract id (not ours) is ignored entirely.
  fabric._onContractMessage({ contract: 'someone-elses-contract', signer: xOnly, object: { type: 'SCEventBatch', object: { events: [{ collection: 'deaths', data: {} }] } } });
  assert.strictEqual(calls.length, 2, 'a foreign contract id is not our traffic');
});
