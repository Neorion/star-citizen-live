'use strict';

/**
 * Star Citizen Live - Fabric-free service (M1 skeleton + M3 parser).
 *
 * Boots with ZERO external dependencies - only Node.js built-ins (http, crypto,
 * events, fs, readline) plus global fetch. No @fabric/hub, no SSH git deps, no
 * 400 MB install. `node app/server.js` just works.
 *
 * Features: in-memory collections, REST endpoints, live log tailing (read-only,
 * optional) AND offline replay, real Game.log event parsing (app/parser.js),
 * optional Discord webhook posting, and the mission/contract seam.
 *
 * It edits NOTHING in the Star Citizen installation - the log is only ever read.
 */

const http = require('http');
const crypto = require('crypto');
const EventEmitter = require('events');
const fs = require('fs');
const readline = require('readline');

const { parseLine } = require('./parser');
let Tail; try { Tail = require('tail').Tail; } catch (_) { Tail = null; } // optional live-tail

function idFor (content) {
  return crypto.createHash('sha256').update(String(content)).digest('hex').slice(0, 32);
}

class StarCitizenService extends EventEmitter {
  constructor (settings = {}) {
    super();
    this.settings = Object.assign({
      port: 3041,
      logfile: null,
      discord: { enable: false, webhook: null, announceKills: true, announcePlayerJoins: true, announceActivities: false },
      missions: { enable: true }
    }, settings);
    this.settings.discord = Object.assign({ enable: false, webhook: null, announceKills: true, announcePlayerJoins: true, announceActivities: false }, settings.discord || {});

    this.state = { status: 'STOPPED', activities: {}, players: {}, vehicles: {}, kills: {}, logs: {}, startedAt: null };
    this.logwatcher = null;
    this.server = null;

    const MissionManager = require('../services/MissionManager');
    this.missionManager = (this.settings.missions && this.settings.missions.enable)
      ? new MissionManager(this.settings.missions) : null;

    if (this.settings.discord.enable) this._wireDiscord();
  }

  get activities () { return Object.values(this.state.activities); }
  get players () { return Object.values(this.state.players); }
  get vehicles () { return Object.values(this.state.vehicles); }
  get kills () { return Object.values(this.state.kills); }
  get logs () { return Object.values(this.state.logs); }
  get missions () { return this.missionManager ? this.missionManager.missions : []; }
  get status () { return this.state.status; }

  // ---- HTTP ----
  async _handle (req, res) {
    const base = '/services/star-citizen';
    const url = new URL(req.url, `http://localhost:${this.settings.port}`);
    const path = url.pathname;
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj, null, 2)); };
    const body = async () => { const c = []; for await (const ch of req) c.push(ch); return c.length ? JSON.parse(Buffer.concat(c).toString()) : {}; };

    try {
      if (req.method === 'GET' && path === base) {
        return send(200, { type: 'StarCitizen', data: {
          status: this.status, startedAt: this.state.startedAt,
          activities: this.activities.length, players: this.players.length,
          vehicles: this.vehicles.length, kills: this.kills.length,
          logs: this.logs.length, missions: this.missions.length
        }});
      }
      const collections = { activities: () => this.activities, players: () => this.players, vehicles: () => this.vehicles, kills: () => this.kills, messages: () => this.logs };
      for (const [name, getter] of Object.entries(collections)) {
        if (path === `${base}/${name}`) {
          if (req.method === 'GET') return send(200, { type: 'Collection', data: getter() });
          if (req.method === 'POST' && name !== 'messages') {
            const data = await body();
            const id = idFor(JSON.stringify(data) + Date.now());
            this.state[name][id] = Object.assign({ id }, data);
            if (name === 'players') this.emit('player:join', this.state[name][id]);
            if (name === 'kills') this.emit('kill', this.state[name][id]);
            return send(200, { type: name, data: this.state[name][id] });
          }
        }
      }
      if (path === `${base}/missions`) {
        if (req.method === 'GET') return send(200, { type: 'Collection', data: this.missions });
        if (req.method === 'POST') {
          if (!this.missionManager) return send(503, { error: 'Mission system not available' });
          const m = await this.missionManager.createMission(await body());
          return send(200, { type: 'Mission', data: m.toJSON() });
        }
      }
      const mMatch = path.match(new RegExp(`^${base}/missions/([^/]+)$`));
      if (mMatch && req.method === 'GET') {
        if (!this.missionManager) return send(503, { error: 'Mission system not available' });
        const m = this.missionManager.getMission(mMatch[1]);
        return m ? send(200, { type: 'Mission', data: m.toJSON() }) : send(404, { error: 'Mission not found' });
      }
      return send(404, { error: 'Not found', path });
    } catch (e) {
      return send(500, { error: e.message });
    }
  }

  // ---- Log handling (read-only) ----
  parseLogEntry (entry) { return parseLine(entry); }

  handleLogChange (entry) {
    const ev = parseLine(entry);
    const id = idFor(entry);

    // Always keep a generic record.
    this.state.logs[id] = ev;
    const activity = { type: 'StarCitizenLogEntry', id, kind: ev.kind, timestamp: ev.timestamp, object: { id, content: entry }, target: '/logs' };
    this.state.activities[id] = activity;

    // Route classified events into the right collections + emit specific events.
    switch (ev.kind) {
      case 'kill': {
        const kill = { id, killer: ev.killer, victim: ev.victim, weapon: ev.weapon, zone: ev.zone, damageType: ev.damageType, timestamp: ev.timestamp };
        this.state.kills[id] = kill;
        this.emit('kill', kill);
        break;
      }
      case 'player:login': {
        const player = { id, name: ev.handle, timestamp: ev.timestamp };
        this.state.players[id] = player;
        this.emit('player:join', player);
        break;
      }
      case 'vehicle:destroy': {
        const v = { id, vehicle: ev.vehicle, cause: ev.cause, fromLevel: ev.fromLevel, toLevel: ev.toLevel, timestamp: ev.timestamp };
        this.state.vehicles[id] = v;
        this.emit('vehicle:destroy', v);
        break;
      }
      default: break;
    }

    this.emit('event', ev);       // every parsed line (used by replay tally)
    this.emit('activity', activity);
    return ev;
  }

  openLog () {
    if (!this.settings.logfile || !Tail) return;
    try {
      this.logwatcher = new Tail(this.settings.logfile);   // read-only watch
      this.logwatcher.on('line', (line) => this.handleLogChange(line));
      this.logwatcher.on('error', (e) => this.emit('error', e));
    } catch (e) { this.emit('error', e); }
  }

  async replayLog (path) {
    return new Promise((resolve, reject) => {
      let count = 0;
      const rl = readline.createInterface({ input: fs.createReadStream(path), crlfDelay: Infinity });
      rl.on('line', (line) => { if (line.trim()) { this.handleLogChange(line); count++; } });
      rl.on('close', () => resolve(count));
      rl.on('error', reject);
    });
  }

  // ---- Discord (optional) ----
  _wireDiscord () {
    this.on('kill', (k) => { if (this.settings.discord.announceKills) this._discordKill(k); });
    this.on('player:join', (p) => { if (this.settings.discord.announcePlayerJoins) this._discordJoin(p); });
    this.on('activity', (a) => { if (this.settings.discord.announceActivities) this._discordActivity(a); });
  }

  _discordKill (k) {
    return this.postToDiscord({ embeds: [{ title: '💀 Kill', description: `${k.killer} eliminated ${k.victim}`,
      fields: [ { name: 'Weapon', value: k.weapon || 'Unknown', inline: true }, { name: 'Zone', value: k.zone || 'Unknown', inline: true } ],
      color: 0xFF0000, timestamp: new Date().toISOString() }] });
  }
  _discordJoin (p) {
    return this.postToDiscord({ embeds: [{ title: '👤 Player', description: `${p.name} logged in`, color: 0x0000FF, timestamp: new Date().toISOString() }] });
  }
  _discordActivity (a) {
    return this.postToDiscord({ embeds: [{ title: '🎮 Activity', description: a.kind, color: 0x00FF00, timestamp: new Date().toISOString() }] });
  }

  async postToDiscord (payload) {
    if (!this.settings.discord.enable || !this.settings.discord.webhook) return null;
    if (typeof fetch !== 'function') return null;
    try {
      return await fetch(this.settings.discord.webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    } catch (e) { this.emit('error', e); return null; }
  }

  // ---- Lifecycle ----
  async start () {
    this.state.status = 'STARTING';
    if (this.missionManager) await this.missionManager.start();
    this.openLog();
    this.server = http.createServer((req, res) => this._handle(req, res));
    await new Promise((resolve) => this.server.listen(this.settings.port, resolve));
    this.state.status = 'STARTED';
    this.state.startedAt = new Date().toISOString();
    this.emit('ready');
    console.log(`[STAR-CITIZEN] listening on http://localhost:${this.settings.port}/services/star-citizen`);
    return this;
  }

  async stop () {
    this.state.status = 'STOPPING';
    if (this.logwatcher) { this.logwatcher.unwatch(); this.logwatcher = null; }
    if (this.missionManager) await this.missionManager.stop();
    if (this.server) await new Promise((r) => this.server.close(r));
    this.state.status = 'STOPPED';
    this.emit('stopped');
    return this;
  }
}

module.exports = StarCitizenService;

if (require.main === module) {
  const svc = new StarCitizenService({ port: process.env.PORT || 3041, logfile: process.env.SC_LOGFILE || null,
    discord: { enable: !!process.env.DISCORD_WEBHOOK_URL, webhook: process.env.DISCORD_WEBHOOK_URL || null } });
  svc.start();
}
