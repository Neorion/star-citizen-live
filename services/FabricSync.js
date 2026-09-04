'use strict';

const EventEmitter = require('events');
const path = require('path');
const meshIdentity = require('./meshIdentity');

/**
 * Optional Fabric P2P mesh backbone (D-008 / BUILD-PLAN-fabric-mesh.md WS2).
 *
 * Strippable exactly like services/CargoRouter.js: app/server.js only builds
 * one of these when settings.fabric.enable is true -
 *   this.fabric = this.settings.fabric.enable ? new FabricSync({...}) : null
 * - so requiring this file must NEVER pull in @fabric/core at module load
 * time. Every Fabric-touching call is deferred to inside a method (start(),
 * mostly via meshIdentity, whose own functions are lazy the same way), and
 * guarded so the service degrades to "installed: false" instead of throwing
 * when @fabric/core isn't present (npm run fabric:install pulls it in).
 *
 * This workstream (WS2) only stands up identity + a status seam. Nothing
 * here opens a socket or talks to a peer yet - that's WS3 (outbound queue)
 * and WS4 (real Peer transport).
 */
class FabricSync extends EventEmitter {
  constructor ({ service, settings, storeDir } = {}) {
    super();
    this.service = service || null;
    this.settings = Object.assign({
      enable: false,
      listen: true,
      port: 7777,
      interface: '0.0.0.0',
      peers: null,             // array of seed peer addresses, e.g. ['hub.fabric.pub:7777']
      identityFile: null,      // defaults to <storeDir>/fabric-identity.json
      shareLogsGlobal: false,  // per-peer consent gate lands in WS3
      uplinkIntervalMs: 5000
    }, settings || {});
    this.storeDir = storeDir || path.join(__dirname, '..', 'stores');

    this.installed = meshIdentity.available();
    this.identity = null;
    this.peer = null;          // real @fabric/core Peer instance - WS4
    this._peers = [];          // known-peer roster - WS3/WS5
    this._uplinkQueue = [];    // outbound event queue - WS3
    this._uplinkTimer = null;
    this._startError = null;
  }

  async start () {
    if (!this.installed) {
      console.log('[STAR-CITIZEN] fabric: @fabric/core is not installed - run `npm run fabric:install` to enable the mesh backbone');
      return false;
    }
    const file = this.settings.identityFile || path.join(this.storeDir, 'fabric-identity.json');
    try {
      this.identity = meshIdentity.loadOrCreate(file, process.env.SC_FABRIC_PASSPHRASE || null);
      console.log(`[STAR-CITIZEN] fabric: identity ready (pubkey ${this.identity.pubkey.slice(0, 12)}…)`);
      return true;
    } catch (err) {
      this._startError = err.message;
      console.error('[STAR-CITIZEN] fabric: identity load failed:', err.message);
      return false;
    }
  }

  async stop () {
    if (this._uplinkTimer) { clearInterval(this._uplinkTimer); this._uplinkTimer = null; }
    // Real transport teardown (Peer#stop) lands in WS4 - nothing open yet.
  }

  get ready () { return !!(this.installed && this.identity); }

  // Verify a signed envelope from a peer against the roster (if one is
  // configured). Mirrors the reference implementation's _checkEnvelope
  // shape ({ok, code, error}) so app/server.js's /events route can use it
  // directly without translating error shapes.
  checkEnvelope (envelope, allowedKeys) {
    if (!envelope || !envelope.pubkey || !envelope.signature || envelope.payload === undefined) {
      return { ok: false, code: 401, error: 'Signed envelope required: { pubkey, payload, signature }' };
    }
    if (Array.isArray(allowedKeys) && allowedKeys.length && !allowedKeys.some((k) => meshIdentity.pubkeysMatch(k, envelope.pubkey))) {
      return { ok: false, code: 403, error: 'Sender key is not on the roster' };
    }
    if (!meshIdentity.verifyEnvelope(envelope)) {
      return { ok: false, code: 401, error: 'Invalid signature' };
    }
    return { ok: true, code: 200, error: null };
  }

  status () {
    return {
      enabled: true,
      installed: this.installed,
      ready: this.ready,
      pubkey: this.identity ? this.identity.pubkey : null,
      listenPort: this.settings.port,
      connected: 0,           // real peer count lands in WS4
      peers: this._peers,
      shareLogsGlobal: !!this.settings.shareLogsGlobal,
      shareLogsActive: false, // per-peer consent gate - WS3
      uplinkQueued: this._uplinkQueue.length,
      startError: this._startError
    };
  }
}

module.exports = FabricSync;
