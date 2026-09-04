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
 * time. Every Fabric-touching call is deferred to inside a method, and
 * guarded so the service degrades to "installed: false" instead of throwing
 * when @fabric/core isn't present (npm run fabric:install pulls it in).
 *
 * WS2 stood up identity + a status seam. WS3 added the peer roster, the
 * outbound consent gate, and the queue + flush loop, driven by an injected
 * `network` test double - none of it needs @fabric/core installed. WS4
 * (this workstream) adds the REAL transport: a real `@fabric/core` Peer,
 * signed-and-relayed SCEventBatch publish/inbound dispatch into
 * `_ingestEvent`, and seed-hub dialing. Real peer transport is opt-in via
 * `settings.fabric.startPeer` (separate from `enable`, which only turns on
 * identity + consent/queue) - so every WS2/WS3 test and every ordinary
 * `fabric.enable:true` caller stays exactly as side-effect-free as before,
 * even now that @fabric/core is actually installed; only a caller that
 * explicitly asks for `startPeer:true` (the production CLI when SC_FABRIC=1,
 * and WS4's own gated two-node test) ever opens a real socket.
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

// First-boot roster seed (T4.6) when the caller specifies no peers at all
// (settings.peers left unset) and no roster file exists yet. Transport-only:
// shareLogs stays false - a seed hub relays traffic but is never
// auto-authorized to receive this pilot's events (consent is always
// explicit, per-peer or global, never implied by being on the roster).
const DEFAULT_PEERS = ['hub.fabric.pub:7777', 'relay.goon.vc:7777'];

class FabricSync extends EventEmitter {
  constructor ({ service, settings, storeDir, network } = {}) {
    super();
    this.service = service || null;
    this.settings = Object.assign({
      enable: false,
      startPeer: false,        // opt-in: actually open a real @fabric/core Peer (WS4). See class doc.
      listen: true,             // when startPeer is on, accept inbound connections (vs. dial-out only)
      port: 7777,
      interface: '0.0.0.0',
      peers: null,              // array of seed peer addresses (strings) or partial peer records
      allowedKeys: null,        // optional inbound roster pin: array of pubkeys; null = accept any signer
      identityFile: null,       // defaults to <storeDir>/fabric-identity.json
      peersFile: null,          // defaults to <storeDir>/fabric-peers.json
      shareLogsGlobal: false,   // broadcast to every connected peer once identity is ready
      uplinkIntervalMs: 5000
    }, settings || {});
    this.storeDir = storeDir || path.join(__dirname, '..', 'stores');

    this.installed = meshIdentity.available();
    this.identity = null;
    this.peer = null;          // real @fabric/core Peer instance, once _startPeer() runs
    // Transport facade: { ready, status(), publishEventBatch(events, sentAt, opts) }.
    // A test double until _startPeer() replaces it with the real one.
    this.network = network || null;
    this._contractIdCache = null;

    this.peers = [];           // known-peer roster, see _normalizePeerRecord()
    this._uplinkQueue = [];    // outbound event queue
    this._uplinkTimer = null;
    this._uplinkWired = false;
    this._startError = null;

    // Safety net: FabricSync is a standalone EventEmitter (app/server.js
    // doesn't listen on it today). Without at least one 'error' listener,
    // a stray Peer 'error' event would throw and crash the process.
    this.on('error', (e) => console.error('[STAR-CITIZEN] fabric error:', (e && e.message) || e));
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
    } catch (err) {
      this._startError = err.message;
      console.error('[STAR-CITIZEN] fabric: identity load failed:', err.message);
      return false;
    }

    if (this.settings.startPeer) {
      try {
        await this._startPeer();
      } catch (err) {
        this._startError = err.message;
        console.error('[STAR-CITIZEN] fabric: peer transport failed to start:', err.message);
        return false;
      }
    }
    return true;
  }

  async stop () {
    if (this._uplinkTimer) { clearInterval(this._uplinkTimer); this._uplinkTimer = null; }
    await this._stopPeer();
  }

  get ready () { return !!(this.installed && this.identity); }

  // ---- Peer roster (T3.1, T4.6) ----

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
  // settings.peers (address strings or partial records) - or, if the caller
  // specified no peers at all, from the default transport-only seed hubs
  // (T4.6). An explicit empty array (`peers: []`) means "no seeds", not
  // "use the defaults" - tests rely on that to stay isolated.
  _loadOrSeedPeers () {
    const file = this._peersFilePath();
    try {
      if (fs.existsSync(file)) {
        const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(arr)) { this.peers = arr.map((p) => this._normalizePeerRecord(p)).filter(Boolean); return; }
      }
    } catch (e) { console.error('[STAR-CITIZEN] fabric: peer roster read failed:', e.message); }

    const seeds = Array.isArray(this.settings.peers)
      ? this.settings.peers
      : DEFAULT_PEERS.map((address) => ({ address, shareLogs: false }));
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

  // Add (or replace, by address) a peer, persist the roster, and (T4.5) dial
  // it immediately if the real transport is already running. Returns the
  // normalized record, or null if the address was rejected.
  addPeer (input) {
    const rec = this._normalizePeerRecord(input);
    if (!rec) return null;
    this.peers = this.peers.filter((p) => p.address !== rec.address);
    this.peers.push(rec);
    this._persistPeers();
    if (rec.enabled !== false) this._dialAddresses([rec.address]);
    return rec;
  }

  /** Find a peer by id (WS5 REST surface). */
  getPeer (id) { return this.peers.find((p) => p.id === id) || null; }

  // Update enabled/label/shareLogs/expectedPubkey on an existing peer (T5.1
  // "POST …/peers/:id toggles enabled/label/shareLogs"). The address is
  // deliberately pinned to its current value - this is a consent/metadata
  // toggle, not an address edit; re-add the peer to change its address.
  // Dials immediately if the update just enabled a peer. Returns the
  // updated record, or null if `id` isn't on the roster.
  updatePeer (id, patch) {
    const idx = this.peers.findIndex((p) => p.id === id);
    if (idx === -1) return null;
    const existing = this.peers[idx];
    const merged = Object.assign({}, existing, patch || {}, { address: existing.address, id: existing.id });
    const rec = this._normalizePeerRecord(merged);
    if (!rec) return null;
    rec.lastSeen = existing.lastSeen;
    rec.lastError = existing.lastError;
    this.peers[idx] = rec;
    this._persistPeers();
    if (rec.enabled !== false) this._dialAddresses([rec.address]);
    return rec;
  }

  // Remove a peer from the roster and persist. Does not force-close an
  // already-open connection - it simply won't be redialed if it drops.
  // Returns true if a peer was actually removed.
  removePeer (id) {
    const before = this.peers.length;
    this.peers = this.peers.filter((p) => p.id !== id);
    if (this.peers.length === before) return false;
    this._persistPeers();
    return true;
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

  // ---- Real Fabric Peer transport (WS4) ----

  // Our own private contract namespace (T4.1, owner gate G2 = B). Requires
  // @fabric/core - only call once this.installed is true.
  _contractId () {
    if (!this._contractIdCache) this._contractIdCache = require('../contracts/starcitizenlive').starCitizenLiveContractId();
    return this._contractIdCache;
  }

  // T4.2: start a real @fabric/core Peer, dialing the current roster and
  // (if settings.listen) accepting inbound connections. Wires the same
  // `network` facade WS3's flush loop already expects, so _flushUplink()
  // needed zero changes for real transport to work.
  async _startPeer () {
    if (this.peer) return this.peer;
    if (!this.identity) throw new Error('identity required (call after start() has loaded/created one)');

    const Peer = require('@fabric/core/types/peer');
    const master = meshIdentity.masterKeyFromIdentity(this.identity);
    const dialAddresses = this.peers.filter((p) => p.enabled !== false).map((p) => p.address);

    const peer = new Peer({
      listen: this.settings.listen !== false,
      port: Number(this.settings.port) || 7777,
      interface: this.settings.interface || '0.0.0.0',
      peers: dialAddresses,
      peersDb: null,
      networking: true,
      reconnectToKnownPeers: false,
      listenPortAttempts: 20,
      key: { xprv: master.xprv },
      upnp: false,
      constraints: { peers: { max: 32 } }
    });

    peer.on('error', (e) => this.emit('error', e));
    peer.on('warning', (m) => this.emit('warning', m));
    peer.on('ready', (info) => this.emit('ready', info));
    peer.on('connections:open', (ev) => this.emit('connections:open', ev));
    peer.on('connections:close', (ev) => this.emit('connections:close', ev));
    peer.on('peer:self', (ev) => this.emit('peer:self', ev));
    peer.on('contract:message', (ev) => this._onContractMessage(ev));

    await peer.start();
    this.peer = peer;
    this.network = this._buildNetworkFacade(peer);
    console.log(`[STAR-CITIZEN] fabric peer listening on ${peer.settings.port} (id ${String(peer.key.pubkey).slice(0, 12)}…)`);
    return peer;
  }

  // T4.5: destroy raw connections, stop the peer, null everything out. Safe
  // to call even when no peer was ever started.
  async _stopPeer () {
    const peer = this.peer;
    this.peer = null;
    this.network = null;
    if (!peer) return;
    for (const id of Object.keys(peer.connections || {})) {
      const c = peer.connections[id];
      if (!c) continue;
      try { if (typeof c.destroy === 'function') c.destroy(); } catch (_) { /* already torn down */ }
    }
    try { await peer.stop(); } catch (e) { this.emit('error', e); }
  }

  // T4.5: dial newly-added roster addresses at runtime (e.g. from a future
  // WS5 "add peer" REST call), without restarting the whole peer.
  _dialAddresses (addresses) {
    if (!this.peer || typeof this.peer._connect !== 'function') return;
    for (const addr of addresses) {
      if (this.peer.connections && this.peer.connections[addr]) continue;
      try {
        if (typeof this.peer._upsertPeerRegistry === 'function') this.peer._upsertPeerRegistry(addr, { address: addr });
        this.peer._connect(addr);
      } catch (e) { this.emit('warning', `[STAR-CITIZEN] fabric: connect ${addr} failed: ${e.message}`); }
    }
  }

  // T4.3: the `network` facade _flushUplink() (WS3) already knows how to
  // drive - `ready`/`status()`/`publishEventBatch()` - now backed by a real peer.
  _buildNetworkFacade (peer) {
    const self = this;
    return {
      get ready () { return !!(peer && self.identity && peer.key); },
      status () { return { fabricConnected: Object.keys(peer.connections || {}).length }; },
      publishEventBatch (events, sentAt, opts) {
        return self._publishContractMessage('SCEventBatch', { events, sentAt }, opts);
      }
    };
  }

  // Sign a CONTRACT_MESSAGE body under our own contract id and relay it -
  // broadcast (peer.relayFrom) when opts.to is absent, directed (writing
  // straight to the matching connections) otherwise. Ported/simplified from
  // the reference's _signMessage + _signAndRelay + _publishContractMessage
  // (FabricNetwork.js:543-590, 1609-1626) - no groups/chat/proposals, this
  // mesh only ever sends one body type.
  _publishContractMessage (type, object, opts = {}) {
    if (!this.peer) throw new Error('fabric peer not started');
    const pubkey = this.identity && this.identity.pubkey;
    if (!pubkey) throw new Error('identity required');
    const Message = require('@fabric/core/types/message');
    const body = { contract: this._contractId(), type, actor: { publicKey: pubkey, id: pubkey }, object };
    const msg = Message.fromVector(['CONTRACT_MESSAGE', JSON.stringify(body)]).signWithKey(this.peer.key);

    const targets = Array.isArray(opts.to) ? opts.to.map((a) => String(a).trim()).filter(Boolean) : null;
    if (!targets || !targets.length) {
      this.peer.relayFrom(null, msg);
      return msg;
    }
    const buf = msg.toBuffer();
    for (const id of Object.keys(this.peer.connections || {})) {
      if (!targets.some((addr) => FabricSync._connectionMatchesAddress(id, addr))) continue;
      const conn = this.peer.connections[id];
      if (conn && typeof conn._writeFabric === 'function') conn._writeFabric(buf);
    }
    return msg;
  }

  /** True when `connectionId` matches a roster address (exact or host match). */
  static _connectionMatchesAddress (connectionId, rosterAddress) {
    const id = String(connectionId || '').toLowerCase();
    const addr = String(rosterAddress || '').toLowerCase();
    if (!id || !addr) return false;
    if (id === addr) return true;
    const host = addr.split(':')[0];
    return !!(host && (id === host || id.startsWith(host + ':')));
  }

  // T4.4: inbound dispatch - our private contract's SCEventBatch only. Loops
  // events into the SAME _ingestEvent() the HTTP /events route uses (WS1),
  // so a Fabric-delivered event is just as idempotent/source-attributed as
  // one that arrived over HTTP.
  _onContractMessage (ev) {
    if (!ev || !ev.contract || ev.contract !== this._contractId()) return;
    const body = ev.object || {};
    if (body.type !== 'SCEventBatch') return;

    // `ev.signer` is cryptographically recovered by the Peer itself (from
    // the message signature, not from the JSON body) - trustworthy, but in
    // @fabric/core's own x-only form (verified empirically: it's the
    // compressed pubkey minus its 02/03 prefix byte, same convention
    // meshIdentity's pubkeyXOnly/pubkeysMatch already normalize for). The
    // body's own `actor.publicKey` is the full compressed form (matches the
    // HTTP-envelope path's `source` convention) but is unverified content -
    // only trust it once it's confirmed to match the real signer; never let
    // a peer spoof attribution just by writing a different key into the body.
    const claimed = (body.actor && (body.actor.publicKey || body.actor.id)) || null;
    let signer = ev.signer || null;
    if (!signer) return;
    if (claimed && meshIdentity.pubkeysMatch(signer, claimed)) signer = claimed;

    const allowed = this.settings.allowedKeys;
    if (Array.isArray(allowed) && allowed.length && !allowed.some((k) => meshIdentity.pubkeysMatch(k, signer))) {
      this.emit('warning', `[STAR-CITIZEN] fabric: dropping SCEventBatch from an unlisted signer (${String(signer).slice(0, 12)}…)`);
      return;
    }

    const object = body.object != null ? body.object : body;
    const events = Array.isArray(object.events) ? object.events : [];
    let created = 0;
    for (const e of events) {
      if (!this.service || !e) continue;
      try {
        const r = this.service._ingestEvent(signer, e.collection, e.data);
        if (r.created) created++;
      } catch (_) { /* malformed event from a peer - skip it, never crash on inbound data */ }
    }

    const now = new Date().toISOString();
    for (const p of this.peers) {
      if (p.expectedPubkey && meshIdentity.pubkeysMatch(p.expectedPubkey, signer)) p.lastSeen = now;
    }
    if (this.service) this.service.emit('ingest', { source: signer, received: events.length, created, via: 'fabric' });
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
