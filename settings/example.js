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
  // SC_FABRIC=1). Identity is created on first start and persisted to
  // stores/fabric-identity.json (set SC_FABRIC_PASSPHRASE to encrypt it at rest).
  fabric: {
    enable: false,
    port: 7777,
    peers: null   // e.g. ['hub.fabric.pub:7777'] - seed peers to dial on start (WS4)
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

