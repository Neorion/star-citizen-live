'use strict';

const {
  NAME
} = require('../constants');

/**
 * Example configuration for Star Citizen Live service.
 * Copy this file to local.js and customize as needed.
 */
module.exports = {
  authority: 'https://sensemaker.io',
  name: NAME,

  // Path to Star Citizen game log file
  logfile: 'C:/Program Files/Roberts Space Industries/StarCitizen/LIVE/Game.log',

  // HTTP Server Configuration
  http: {
    enable: true,
    port: 3041
  },

  // Discord Integration
  discord: {
    enable: true,
    // Get webhook URL from Discord channel settings -> Integrations -> Webhooks
    webhook: 'https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN',
    // Optional: Discord channel ID for additional features
    channel: 'YOUR_CHANNEL_ID',
    // Configure what gets announced to Discord
    announceActivities: true,
    announceKills: true,
    announcePlayerJoins: true
  },

  // Bulk event ingest (POST …/events - BUILD-PLAN-fabric-mesh.md WS1/WS2).
  // Off by default. Only turn on requireSigned/allowedKeys once `fabric`
  // below is enabled and peers are signing with meshIdentity.
  ingest: {
    httpEnable: false,       // or set SC_HTTP_INGEST=1
    requireSigned: false,    // refuse unsigned batches once the mesh is up
    allowedKeys: null        // e.g. ['<peer pubkey hex>', ...] - null = accept any signer
  },

  // Optional Fabric P2P mesh backbone (D-008 / BUILD-PLAN-fabric-mesh.md).
  // Strippable: leave enable:false and this whole feature costs nothing -
  // services/FabricSync.js is never required, and no @fabric/core dependency
  // is needed. To turn it on: `npm run fabric:install`, then enable:true (or
  // SC_FABRIC=1, which also flips startPeer on automatically - see below).
  // Identity is created on first start and persisted to
  // stores/fabric-identity.json (set SC_FABRIC_PASSPHRASE to encrypt it at rest).
  fabric: {
    enable: false,
    // Real network transport (WS4) is a SEPARATE opt-in from `enable` above:
    // enable:true alone only sets up identity + the consent gate + the
    // outbound queue (all side-effect-free, no socket opened). Only
    // startPeer:true actually starts a real @fabric/core Peer (dials the
    // roster below, optionally listens). The CLI (SC_FABRIC=1) turns this
    // on automatically; library/test callers must ask for it explicitly.
    startPeer: false,
    port: 7777,
    // Seed peers as address strings (dialed on start) or partial records to
    // pre-authorize sharing with. Written once to stores/fabric-peers.json
    // on first start and edited/persisted there after (not re-read from
    // here on later starts). Leave unset on first boot and two transport-
    // only seed hubs (hub.fabric.pub, relay.goon.vc - shareLogs:false) are
    // seeded automatically; pass [] explicitly for an empty roster instead.
    peers: null,   // e.g. ['hub.fabric.pub:7777'] or [{address:'host:7777', shareLogs:true}]
    // Optional inbound pin: only accept SCEventBatch traffic signed by one
    // of these pubkeys (any form - full or x-only, both are normalized).
    // null = accept from any signer whose peer record allows it.
    allowedKeys: null,
    // Opt-in, off by default either way: broadcast this pilot's events to
    // every connected peer once shareLogsGlobal is true, or leave it false
    // and opt in per-peer via that peer's own shareLogs:true instead.
    shareLogsGlobal: false
  },

  // Initial State
  state: {
    status: 'STOPPED',
    activities: {},
    logs: {},
    players: {},
    vehicles: {},
    kills: {}
  }
};

