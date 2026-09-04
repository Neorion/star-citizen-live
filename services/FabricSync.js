'use strict';

const EventEmitter = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const meshIdentity = require('./meshIdentity');
const fabricAddress = require('./fabricAddress');

/**
 * Optional Fabric P2P mesh backbone (D-008 / BUILD-PLAN-fabric-mesh.md).
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
 * WS2 stood up identity + a status seam. WS3 (this workstream) adds the
 * PEER ROSTER, the CONSENT GATE ("who is this pilot's data allowed to reach,
 * and only once they say so"), and the OUTBOUND QUEUE + flush loop - all of
 * it runs with no @fabric/core installed, driven by a `network` object
 * (real in WS4, a fake with publishEventBatch() in tests today) injected via
 * settings/the constructor or set directly as `fabric.network`. Nothing here
 * opens a real socket yet - that's WS4.
 */

function idFor (content) {
  return crypto.createHash('sha256').update(String(content)).digest('hex').slice(0, 32);
}

// Local-only fields that must never leave this machine, or that the
// receiver recomputes itself (BUILD-PLAN-fabric-mesh.md WS3 T3.5): `id` is
// server-computed on ingest (see app/server.js's _ingestEvent), `raw` is the
// original log line (privacy), `involves` (kills) can carry local-only
// player/vehicle detail. Denylist, not an allowlist - so a field this port
// doesn't know about yet still reaches a consenting peer instead of being
// silently dropped.
const STRIP_ON_UPLINK = ['id', 'raw', 'involves'];

function sanitizeForUplink (data) {
  if (!data || typeof data !== 'object') return data;
  const out = {};
  for (const k of Object.keys(data)) { if (!STRIP_ON_UPLINK.includes(k)) out[k] = data[k]; }
  return out;
}

class FabricSync extends EventEmitter {
  constructor ({ service, settings, storeDir, network } = {}) {
    super();
    this.service = service || null;
    this.settings = Object.assign({
      enable: false,
      listen: true,
      port: 7777,
      interface: '0.0.0.0',
      peers: null,             // array of seed peer addresses (strings) or partial peer records
      identityFile: null,      // defaults to <storeDir>/fabric-identity.json
      peersFile: null,         // defaults to <storeDir>/fabric-peers.json
      shareLogsGlobal: false,  // broadcast to every connected peer once identity is ready
      uplinkIntervalMs: 5000
    }, settings || {});
    this.storeDir = storeDir || path.join(__dirname, '..', 'stores');

    this.installed = meshIdentity.available();
    this.identity = null;
    this.peer = null;          // real @fabric/core Peer instance - WS4
    // Real transport (WS4) or a test double: { ready, status(), publishEventBatch(events, sentAt, opts) }.
    this.network = network || null;

    this.peers = [];           // known-peer roster, see _normalizePeerRecord()
    this._uplinkQueue = [];    // outbound event queue
    this._uplinkTimer = null;
    this._uplinkWired = false;
    this._startError = null;
  }

  async start () {
    // Peer roster + outbound consent/queue infra needs no Fabric install at
    // all - only the flush step (network.publishEventBatch) ever needs a
    // real connection, and that degrades to "keep the queue" on its own.
    this._loadOrSeedPeers();
    this._wireUplinkQueue();
    this._startUplinkTimer();

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

  // ---- Peer roster (T3.1) ----

  // Normalize a peer roster entry to a stable shape. Returns null for a
  // malformed/unparseable address or one that would dial this process
  // itself (loopback:samePort, or a host this machine already listens on).
  _normalizePeerRecord (p) {
    if (!p || typeof p !== 'object') return null;
    const address = fabricAddress.normalizeFabricAddress(p.address || p.url, { migrate: true });
    if (!address) return null;
    if (fabricAddress.isSelfFabricAddress(address, { listenPort: this.settings.port })) return null;
    return {
      id: p.id || idFor(address),
      address,
      label: p.label || null,
      enabled: p.enabled !== false,
      // Opt-in, per peer: authorize this peer to receive this pilot's events.
      shareLogs: p.shareLogs === true,
      expectedPubkey: p.expectedPubkey ? String(p.expectedPubkey).trim().toLowerCase() : null,
      lastSeen: p.lastSeen || null,
      lastError: p.lastError || null
    };
  }

  _peersFilePath () { return this.settings.peersFile || path.join(this.storeDir, 'fabric-peers.json'); }

  // Load the persisted roster; on first run (no file yet), seed it from
  // settings.peers (address strings or partial records) and persist.
  _loadOrSeedPeers () {
    const file = this._peersFilePath();
    try {
      if (fs.existsSync(file)) {
        const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(arr)) { this.peers = arr.map((p) => this._normalizePeerRecord(p)).filter(Boolean); return; }
      }
    } catch (e) { console.error('[STAR-CITIZEN] fabric: peer roster read failed:', e.message); }
    const seeds = Array.isArray(this.settings.peers) ? this.settings.peers : [];
    this.peers = seeds.map((p) => this._normalizePeerRecord(typeof p === 'string' ? { address: p } : p)).filter(Boolean);
    if (this.peers.length) this._persistPeers();
  }

  // Persist the roster, stripping volatile fields (lastSeen/lastError) that
  // are runtime-only and shouldn't be treated as durable configuration.
  _persistPeers () {
    try {
      const slim = this.peers.map((p) => ({ id: p.id, address: p.address, label: p.label, enabled: p.enabled, shareLogs: p.shareLogs, expectedPubkey: p.expectedPubkey }));
      fs.mkdirSync(path.dirname(this._peersFilePath()), { recursive: true });
      fs.writeFileSync(this._peersFilePath(), JSON.stringify(slim, null, 2));
    } catch (e) { console.error('[STAR-CITIZEN] fabric: peer roster persist failed:', e.message); }
  }

  // Add (or replace, by address) a peer and persist the roster. Returns the
  // normalized record, or null if the address was rejected.
  addPeer (input) {
    const rec = this._normalizePeerRecord(input);
    if (!rec) return null;
    this.peers = this.peers.filter((p) => p.address !== rec.address);
    this.peers.push(rec);
    this._persistPeers();
    return rec;
  }

  // ---- Consent gate (T3.2 - ported verbatim from the reference's
  // _logShareTargets/_canShareLogs/_logSharePublishOpts) ----

  // Addresses authorized to receive this pilot's events (null = everyone
  // connected, once shareLogsGlobal is on).
  _logShareTargets () {
    if (this.settings.shareLogsGlobal) return null;
    return this.peers.filter((p) => p && p.enabled !== false && p.shareLogs === true).map((p) => p.address).filter(Boolean);
  }

  // True once identity is unlocked AND at least one share path is authorized
  // (global, or at least one peer opted in). No network state involved -
  // that's checked separately at flush time.
  _canShareLogs () {
    if (!this.identity) return false;
    if (this.settings.shareLogsGlobal) return true;
    return this.peers.some((p) => p && p.enabled !== false && p.shareLogs === true);
  }

  // `{}` = broadcast, `{ to: [...] }` = directed, `null` = nothing authorized.
  _logSharePublishOpts () {
    if (!this._canShareLogs()) return null;
    const targets = this._logShareTargets();
    if (targets === null) return {};
    if (!targets.length) return null;
    return { to: targets };
  }

  // ---- Outbound queue + flush (T3.3/T3.4) ----

  // Subscribe to the service's own event stream. Deliberately narrow: only
  // the named per-collection events below queue anything - raw log lines
  // (`activity`/`event`/`notification`/`logs`) never leave this machine.
  _wireUplinkQueue () {
    if (this._uplinkWired || !this.service) return;
    this._uplinkWired = true;

    const queue = (collection) => (ev) => {
      if (!this._canShareLogs()) return;
      this._uplinkQueue.push({ collection, data: sanitizeForUplink(ev) });
      if (this._uplinkQueue.length > 5000) this._uplinkQueue.shift();
    };
    this.service.on('kill', queue('kills'));
    this.service.on('player:death', queue('deaths'));
    this.service.on('player:incap', queue('incaps'));
    this.service.on('vehicle:destroy', queue('vehicles'));
    this.service.on('mission:event', queue('missionlog'));
    this.service.on('mission:crew', queue('crew'));
    this.service.on('session:disconnect', queue('disconnects'));
    this.service.on('player:join', (p) => {
      if (!this._canShareLogs()) return;
      this._uplinkQueue.push({ collection: 'players', data: { name: p.name, timestamp: p.lastSeen } });
      if (this._uplinkQueue.length > 5000) this._uplinkQueue.shift();
    });
  }

  _startUplinkTimer () {
    if (this._uplinkTimer) return;
    const interval = this.settings.uplinkIntervalMs || 5000;
    this._uplinkTimer = setInterval(() => {
      this._flushUplink().catch((e) => { if (this.service) this.service.emit('error', e); else this.emit('error', e); });
    }, interval);
    if (this._uplinkTimer.unref) this._uplinkTimer.unref();
  }

  // Publish up to 200 queued events as one batch. No-ops (keeping the queue
  // intact) when nothing is authorized, or no network/no connected peer -
  // only a genuine publish failure requeues + records lastError.
  async _flushUplink () {
    if (!this._uplinkQueue.length) return null;
    const opts = this._logSharePublishOpts();
    if (opts === null) return null;
    if (!this.network || !this.network.ready) return null;
    const status = typeof this.network.status === 'function' ? this.network.status() : {};
    if (!status.fabricConnected) return null;   // keep the queue until at least one peer is up

    const events = this._uplinkQueue.splice(0, 200);
    try {
      await Promise.resolve(this.network.publishEventBatch(events, new Date().toISOString(), opts));
      const targets = opts.to || null;
      const now = new Date().toISOString();
      for (const p of this.peers) {
        if (p.enabled === false) continue;
        if (!targets || targets.includes(p.address)) { p.lastSeen = now; p.lastError = null; }
      }
      this.emit('uplink:sent', { count: events.length, to: targets });
      return { count: events.length, to: targets };
    } catch (e) {
      this._uplinkQueue.unshift(...events);
      if (this._uplinkQueue.length > 5000) this._uplinkQueue.length = 5000;
      for (const p of this.peers) { if (p.enabled !== false) p.lastError = e.message; }
      this.emit('uplink:error', { error: e.message });
      return null;
    }
  }

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
      connected: (this.network && typeof this.network.status === 'function' && this.network.status().fabricConnected) || 0,
      peers: this.peers,
      shareLogsGlobal: !!this.settings.shareLogsGlobal,
      shareLogsActive: this._canShareLogs(),
      uplinkQueued: this._uplinkQueue.length,
      startError: this._startError
    };
  }
}

module.exports = FabricSync;
