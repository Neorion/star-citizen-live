/**
 * Core service for Star Citizen.
 */
'use strict';

// Dependencies
// const fs = require('fs');
const fetch = require('cross-fetch');
const merge = require('lodash.merge');
const { Tail } = require('tail');
const screenshot = require('screenshot-desktop');

// Fabric Types
const Actor = require('@fabric/core/types/actor');
const Hub = require('@fabric/hub');

// TODO: render GoonCitizen/goon.vc static site / import / upgrade it to use this tool
/**
 * Core service for Star Citizen.
 * Provides a Fabric-compatible declarative API with Discord integration.
 * @extends Hub
 * @property {Array} activities - Collection of activities from the game log.
 * @property {Array} players - Collection of known players.
 * @property {Array} vehicles - Collection of known vehicles.
 * @property {Array} logs - Collection of log entries.
 * @property {Array} kills - Collection of kill events.
 * @property {Object} discord - Discord integration instance.
 */
class StarCitizen extends Hub {
  /**
   * Create an instance of the Star Citizen service.
   * @param {Object} [settings] Configuration for this instance.
   * @param {Object} [settings.logfile=C:/Program Files/Roberts Space Industries/StarCitizen/LIVE/Game.log] Path to the log file for Star Citizen.
   * @param {Object} [settings.discord] Discord configuration.
   * @param {String} [settings.discord.webhook] Discord webhook URL for posting updates.
   * @param {String} [settings.discord.channel] Discord channel ID for posting updates.
   * @param {Boolean} [settings.discord.enable=false] Enable Discord integration.
   * @returns {StarCitizen} A new instance of the Star Citizen service.
   */
  constructor (settings = {}) {
    super(settings);

    // Settings
    this.settings = merge({}, this.settings, {
      authority: 'https://sensemaker.io',
      logfile: 'C:/Program Files/Roberts Space Industries/StarCitizen/LIVE/Game.log',
      discord: {
        enable: false,
        webhook: null,
        channel: null,
        announceActivities: true,
        announceKills: true,
        announcePlayerJoins: true
      },
      state: {
        status: 'STOPPED',
        activities: {},
        logs: {},
        players: {},
        vehicles: {},
        kills: {}
      },
      http: {
        port: 3041
      }
    }, settings);

    // HTTP Server
    this.routes = [
      // TODO: prefix with /services/star-citizen only when imported as library
      { path: '/services/star-citizen', method: 'GET', handler: this.handleGenericRequest.bind(this) },
      { path: '/services/star-citizen', method: 'POST', handler: this.handleGenericRequest.bind(this) },
      { path: '/services/star-citizen/activities', method: 'GET', handler: this.handleGetActivitiesRequest.bind(this) },
      { path: '/services/star-citizen/activities', method: 'POST', handler: this.handleCreateActivityRequest.bind(this) },
      // TODO: match GN API as much as possible
      { path: '/services/star-citizen/players', method: 'GET', handler: this.handleGetPlayersRequest.bind(this) },
      { path: '/services/star-citizen/players', method: 'POST', handler: this.handleCreatePlayerRequest.bind(this) },
      { path: '/services/star-citizen/vehicles', method: 'GET', handler: this.handleGetVehiclesRequest.bind(this) },
      { path: '/services/star-citizen/vehicles', method: 'POST', handler: this.handleCreateVehicleRequest.bind(this) },
      { path: '/services/star-citizen/messages', method: 'GET', handler: this.handleGetMessagesRequest.bind(this) },
      { path: '/services/star-citizen/messages', method: 'POST', handler: this.handleCreateMessageRequest.bind(this) },
      { path: '/services/star-citizen/kills', method: 'GET', handler: this.handleGetKillsRequest.bind(this) },
      { path: '/services/star-citizen/kills', method: 'POST', handler: this.handleCreateKillRequest.bind(this) }
    ];

    this.logwatcher = null;
    this.discord = null;

    // State
    this._state = {
      content: JSON.parse(JSON.stringify(this.settings.state))
    };

    // Wire Discord integration if provided
    if (this.settings.discord && this.settings.discord.enable) {
      this._wireDiscord();
    }

    return this;
  }

  // Declarative API Properties
  get activities () {
    return Object.values(this.state.activities || {});
  }

  get logs () {
    return Object.values(this.state.logs || {});
  }

  get players () {
    return Object.values(this.state.players || {});
  }

  get vehicles () {
    return Object.values(this.state.vehicles || {});
  }

  get kills () {
    return Object.values(this.state.kills || {});
  }

  get status () {
    return this.state.status;
  }

  /**
   * Wire Discord integration into the service.
   * @private
   */
  _wireDiscord () {
    // Listen for activity events and relay to Discord
    this.on('activity', this._handleActivityForDiscord.bind(this));
    this.on('kill', this._handleKillForDiscord.bind(this));
    this.on('player:join', this._handlePlayerJoinForDiscord.bind(this));
    this.on('log', this._handleLogForDiscord.bind(this));
  }

  /**
   * Handle activity events for Discord.
   * @param {Object} activity - The activity to announce.
   * @private
   */
  async _handleActivityForDiscord (activity) {
    if (!this.settings.discord.announceActivities) return;
    if (!this.settings.discord.webhook) return;

    try {
      await this.postToDiscord({
        embeds: [{
          title: '🎮 Star Citizen Activity',
          description: activity.type,
          fields: [
            { name: 'Actor', value: activity.actor.id, inline: true },
            { name: 'Object', value: activity.object.id, inline: true },
            { name: 'Target', value: activity.target, inline: true }
          ],
          timestamp: new Date().toISOString(),
          color: 0x00FF00
        }]
      });
    } catch (error) {
      console.error('[STAR-CITIZEN]', '[DISCORD]', 'Error posting activity:', error);
    }
  }

  /**
   * Handle kill events for Discord.
   * @param {Object} kill - The kill event to announce.
   * @private
   */
  async _handleKillForDiscord (kill) {
    if (!this.settings.discord.announceKills) return;
    if (!this.settings.discord.webhook) return;

    try {
      await this.postToDiscord({
        embeds: [{
          title: '💀 Kill Event',
          description: `${kill.killer} eliminated ${kill.victim}`,
          fields: [
            { name: 'Killer', value: kill.killer, inline: true },
            { name: 'Victim', value: kill.victim, inline: true },
            { name: 'Weapon', value: kill.weapon || 'Unknown', inline: true }
          ],
          timestamp: new Date().toISOString(),
          color: 0xFF0000
        }]
      });
    } catch (error) {
      console.error('[STAR-CITIZEN]', '[DISCORD]', 'Error posting kill:', error);
    }
  }

  /**
   * Handle player join events for Discord.
   * @param {Object} player - The player that joined.
   * @private
   */
  async _handlePlayerJoinForDiscord (player) {
    if (!this.settings.discord.announcePlayerJoins) return;
    if (!this.settings.discord.webhook) return;

    try {
      await this.postToDiscord({
        embeds: [{
          title: '👤 Player Joined',
          description: `${player.name} has entered the verse`,
          fields: [
            { name: 'Player', value: player.name, inline: true },
            { name: 'ID', value: player.id, inline: true }
          ],
          timestamp: new Date().toISOString(),
          color: 0x0000FF
        }]
      });
    } catch (error) {
      console.error('[STAR-CITIZEN]', '[DISCORD]', 'Error posting player join:', error);
    }
  }

  /**
   * Handle log events for Discord.
   * @param {String} log - The log message.
   * @private
   */
  async _handleLogForDiscord (log) {
    // Only post important logs to Discord
    if (!this.settings.discord.webhook) return;
    // Implement custom filtering logic here if needed
  }

  /**
   * Post a message to Discord via webhook.
   * @param {Object} payload - The Discord webhook payload.
   * @returns {Promise<Response>} The fetch response.
   */
  async postToDiscord (payload) {
    if (!this.settings.discord.webhook) {
      throw new Error('Discord webhook URL not configured');
    }

    return fetch(this.settings.discord.webhook, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  }

  async announceActivity (activity) {
    return new Promise((resolve, reject) => {
      const url = `${this.settings.authority}/services/star-citizen/activities`;
      const announcement = fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(activity)
      });

      announcement.catch((error) => {
        console.error('Could not announce activity:', error);
        reject(error);
      });

      announcement.then((response) => {
        resolve(response);
      });
    });
  }

  // HTTP Request Handlers
  handleGetActivitiesRequest (req, res, next) {
    return res.send({
      type: 'Collection',
      data: this.activities
    });
  }

  handleCreateActivityRequest (req, res, next) {
    const actor = new Actor(req.body);
    this._state.content.activities[actor.id] = req.body;
    this.commit();
    this.emit('activity', req.body);
    return res.send({
      type: 'Activity',
      data: req.body
    });
  }

  handleGetPlayersRequest (req, res, next) {
    return res.send({
      type: 'Collection',
      data: this.players
    });
  }

  handleCreatePlayerRequest (req, res, next) {
    const actor = new Actor(req.body);
    this._state.content.players[actor.id] = req.body;
    this.commit();
    this.emit('player:join', req.body);
    return res.send({
      type: 'Player',
      data: req.body
    });
  }

  handleGetVehiclesRequest (req, res, next) {
    return res.send({
      type: 'Collection',
      data: this.vehicles
    });
  }

  handleCreateVehicleRequest (req, res, next) {
    const actor = new Actor(req.body);
    this._state.content.vehicles[actor.id] = req.body;
    this.commit();
    return res.send({
      type: 'Vehicle',
      data: req.body
    });
  }

  handleGetMessagesRequest (req, res, next) {
    return res.send({
      type: 'Collection',
      data: this.logs
    });
  }

  handleCreateMessageRequest (req, res, next) {
    const actor = new Actor(req.body);
    this._state.content.logs[actor.id] = req.body;
    this.commit();
    return res.send({
      type: 'Message',
      data: req.body
    });
  }

  handleGetKillsRequest (req, res, next) {
    return res.send({
      type: 'Collection',
      data: this.kills
    });
  }

  handleCreateKillRequest (req, res, next) {
    const actor = new Actor(req.body);
    this._state.content.kills[actor.id] = req.body;
    this.commit();
    this.emit('kill', req.body);
    return res.send({
      type: 'Kill',
      data: req.body
    });
  }

  handleGenericRequest (req, res, next) {
    console.debug('received request:', req);
    return res.send({
      type: 'StarCitizen',
      data: {
        id: this.id,
        status: this.status,
        activities: this.activities.length,
        players: this.players.length,
        vehicles: this.vehicles.length,
        kills: this.kills.length,
        logs: this.logs.length
      }
    });
  }

  handleLogChange (entry) {
    const actor = new Actor({ content: entry });
    const message = this.parseLogEntry(entry);
    const activity = {
      type: 'StarCitizenLogEntry',
      actor: {
        id: this.id
      },
      object: {
        id: actor.id,
        content: entry
      },
      target: '/logs'
    };

    this.emit('activity', activity);

    switch (message.parts[1]) {
      case '[Notice]':
      case 'CryAnimation:':
      case 'Warning':
        return this;
    }

    console.debug('[FABRIC]', '[STAR-CITIZEN]', '[LOG]', `[${actor.id}]`, message);
    this._state.content.logs[actor.id] = message;
    this._state.content.activities[actor.id] = activity;
    this.commit();
    this.announceActivity(activity).catch((error) => { console.error('Could not announce activity:', error); });

    return this;
  }

  parseLogEntry (entry) {
    const parts = entry.split(' ');
    const object = {
      timestamp: parts[0],
      parts: parts
    };

    return object;
  }

  handleLogError (error) {
    console.error('Error reading log:', error);
  }

  openLog () {
    try {
      this.logwatcher = new Tail(this.settings.logfile);
      this.logwatcher.on('line', this.handleLogChange.bind(this));
      this.logwatcher.on('error', this.handleLogError.bind(this));
    } catch (exception) {
      this.emit('error', `Could not open log: ${exception.toString()}`);
    }
  }

  replayLog () {
    // TODO: implement log replay functionality
  }

  async screenshot () {
    return new Promise((resolve, reject) => {
      screenshot({
        format: 'png'
      }).then((image) => {
        resolve(image);
      }).catch((error) => {
        reject(error);
      });
    });
  }

  async start () {
    console.log('[STAR-CITIZEN]', 'Starting service...');
    this._state.content.status = 'STARTING';

    if (this.settings.http && this.settings.http.enable) {
      await this.http.start();
    }

    this.openLog();

    this._state.content.status = 'STARTED';
    this.commit();

    console.log('[STAR-CITIZEN]', 'Service started');
    this.emit('ready');

    return this;
  }

  async stop () {
    console.log('[STAR-CITIZEN]', 'Stopping service...');
    this._state.content.status = 'STOPPING';

    if (this.logwatcher) {
      this.logwatcher.unwatch();
      this.logwatcher = null;
    }

    if (this.settings.http && this.settings.http.enable) {
      await this.http.stop();
    }

    this._state.content.status = 'STOPPED';
    this.commit();

    console.log('[STAR-CITIZEN]', 'Service stopped');
    this.emit('stopped');

    return this;
  }
}

module.exports = StarCitizen;
