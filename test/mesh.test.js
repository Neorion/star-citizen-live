'use strict';

// BUILD-PLAN-fabric-mesh.md WS2: identity + FabricSync skeleton + the
// /mesh status route + signed-envelope verification on /events. These
// tests must stay green with NO Fabric installed (meshIdentity.available()
// is false in this environment) - that's the whole point of keeping the
// core service zero-dependency. A couple of tests are conditionally
// skipped when @fabric/core IS present, to exercise the real keypair path
// on a machine that has run `npm run fabric:install`.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const meshIdentity = require('../services/meshIdentity');
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
  const s = new StarCitizenService({ port: 0, logfile: null, discord: { enable: false }, fabric: { enable: true, identityFile: path.join(dir, 'id.json') } });
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

  const s = new StarCitizenService({ port: 0, logfile: null, discord: { enable: false }, ingest: { httpEnable: true }, fabric: { enable: true, identityFile: path.join(dir, 'id.json') } });
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
