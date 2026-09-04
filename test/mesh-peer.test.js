'use strict';

// BUILD-PLAN-fabric-mesh.md WS4 T4.7: the ONE gated, real-network test in
// this repo. Skipped unless BOTH SC_FABRIC_TEST=1 is set AND @fabric/core
// actually resolves - so a zero-dep checkout (or plain `npm test`) never
// touches a real socket. Per §0 rule 3 of the build plan: run this file in
// the FOREGROUND with a timeout, never as a detached/background process -
//   SC_FABRIC_TEST=1 node --test test/mesh-peer.test.js
// Two in-process StarCitizenService nodes on loopback, random high ports.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const meshIdentity = require('../services/meshIdentity');
const StarCitizenService = require('../app/server');

const GATED = process.env.SC_FABRIC_TEST === '1' && meshIdentity.available();
const TEST_OPTS = { skip: !GATED ? 'set SC_FABRIC_TEST=1 with @fabric/core installed to run the real two-node peer test' : false, timeout: 20000 };

// Real, format-verified 4.8.0 log lines (same ones test/api.test.js and
// test/mesh.test.js already use) - a genuine death + mission:end pair.
const DEATH_LINE = "<2026-09-04T00:01:00.000Z> [Notice] <Adding non kept item [CSCActorCorpseUtils::PopulateItemPortForItemRecoveryEntitlement]> Item 'body_01_noMagicPocket_1 - Class(body_01_noMagicPocket)', Recorded data is: Port Name 'Body_ItemPort' [Team_CoreGameplayFeatures][Unknown]";

function randomPort () { return 20000 + Math.floor(Math.random() * 20000); }

function waitFor (predicate, { timeoutMs = 8000, intervalMs = 50 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      let ok;
      try { ok = predicate(); } catch (e) { return reject(e); }
      if (ok) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out: ' + predicate.toString()));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function makeNode (label, { port, peers, shareLogsGlobal = false, storeDir }) {
  return new StarCitizenService({
    port: 0,
    logfile: null,
    discord: { enable: false },
    fabric: {
      enable: true,
      startPeer: true,
      listen: true,
      port,
      peers: peers || [],   // explicit [] - no default hub seeding in a gated test
      shareLogsGlobal,
      identityFile: path.join(storeDir, `${label}-identity.json`),
      peersFile: path.join(storeDir, `${label}-peers.json`)
    }
  });
}

test('two real Fabric peers converge a death event A -> B, idempotently, with correct attribution', TEST_OPTS, async () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-mesh-peer-'));
  const portB = randomPort();
  const portA = randomPort();

  // A dials B directly and consents to share with it.
  const A = makeNode('a', { port: portA, storeDir, peers: [{ address: `127.0.0.1:${portB}`, shareLogs: true }] });
  const B = makeNode('b', { port: portB, storeDir, peers: [] });

  try {
    await B.start();
    await A.start();

    await waitFor(() => A.fabric.peer && A.fabric.peer.key && B.fabric.peer && B.fabric.peer.key, { timeoutMs: 5000 });
    await waitFor(() => A.fabric.status().connected >= 1, { timeoutMs: 8000 });

    // B never authorized anything (empty roster, shareLogsGlobal off) -
    // consent is per-direction, connecting doesn't imply it either way.
    assert.strictEqual(B.fabric._canShareLogs(), false, "B never granted consent to anyone - connecting doesn't grant it");

    A.handleLogChange(DEATH_LINE);
    assert.strictEqual(A.fabric._uplinkQueue.length, 1, 'A queued the death (consented to B)');
    await A.fabric._flushUplink();

    await waitFor(() => B.deaths.length === 1, { timeoutMs: 8000 });
    assert.strictEqual(B.deaths[0].source, A.fabric.identity.pubkey, 'attributed to the sender, not B’s own pilot');

    // Idempotent over the wire: the exact same real log line parsed again
    // produces the same semantic event; B must not double-count it.
    A.handleLogChange(DEATH_LINE);
    await A.fabric._flushUplink();
    await new Promise((r) => setTimeout(r, 300));   // let the inbound handler settle
    assert.strictEqual(B.deaths.length, 1, 'replaying the same event over the wire is a no-op');

    // Killing B must not crash A - A should just queue/warn, not throw.
    await B.stop();
    A.handleLogChange(DEATH_LINE.replace('_1 ', '_2 '));
    await assert.doesNotReject(() => A.fabric._flushUplink(), 'a dead peer must not crash the flush loop');
  } finally {
    await A.stop();
    await B.stop();
  }
});

test('a peer with shareLogs:false never receives anything, even after real connection + repeated flushes', TEST_OPTS, async () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-mesh-peer-'));
  const portB = randomPort();
  const portA = randomPort();

  const A = makeNode('a2', { port: portA, storeDir, peers: [{ address: `127.0.0.1:${portB}`, shareLogs: false }] });   // explicitly NOT consenting
  const B = makeNode('b2', { port: portB, storeDir, peers: [] });

  try {
    await B.start();
    await A.start();

    await waitFor(() => A.fabric.status().connected >= 1, { timeoutMs: 8000 });

    A.handleLogChange(DEATH_LINE);
    assert.strictEqual(A.fabric._uplinkQueue.length, 0, 'no consent -> never even queued');
    await A.fabric._flushUplink();
    await A.fabric._flushUplink();
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(B.deaths.length, 0, 'B received nothing across two flush cycles');
  } finally {
    await A.stop();
    await B.stop();
  }
});
