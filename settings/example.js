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

