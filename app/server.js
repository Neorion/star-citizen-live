'use strict';

/**
 * Star Citizen Live - M1 "Fabric-free" service skeleton.
 *
 * Boots with ZERO external dependencies - only Node.js built-ins (http, crypto,
 * events, fs, readline) plus the global fetch in modern Node. No @fabric/hub, no
 * SSH git dependencies, no 400 MB install, nothing to `npm install` to run it.
 * `node app/server.js` just works.
 *
 * Preserves the project's real features: in-memory collections, the REST
 * endpoints, live log tailing (read-only, optional) AND offline log replay,
 * Discord webhook posting (optional; off by default), and the mission/contract
 * seam via services/MissionManager.js.
 *
 * It edits NOTHING in the Star Citizen installation - the log is only ever read.
 */

const http = require('http');
const crypto = require('crypto');
const EventEmitter = require('events');
const fs = require('fs');
const readline = require('readline');

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
      discord: { enable: false, webhook: null },
      missions: { enable: true }
    }, settings);

    this.state = { status: 'STOPPED', activities: {}, players: {}, vehicles: {}, kills: {}, logs: {}, startedAt: null };
    this.logwatcher = null;
    this.server = null;

    const MissionManager = require('../services/MissionManager');
    this.missionManager = (this.settings.missions && this.settings.missions.enable)
      ? new MissionManager(this.settings.missions) : null;
  }

  get activities () { return Object.values(this.state.activities); }
  get players () { return Object.values(this.state.players); }
  get vehicles () { return Object.values(this.state.vehicles); }
  get kills () { return Object.values(this.state.kills); }
  get logs () { return Object.values(this.state.logs); }
  get missions () { return this.missionManager ? this.missionManager.missions : []; }
  get status () { return this.state.status; }

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

  parseLogEntry (entry) {
    const parts = String(entry).split(' ');
    return { timestamp: parts[0], parts, raw: entry };
  }

  handleLogChange (entry) {
    const id = idFor(entry);
    const message = this.parseLogEntry(entry);
    const activity = { type: 'StarCitizenLogEntry', id, object: { id, content: entry }, target: '/logs' };
    this.state.logs[id] = message;
    this.state.activities[id] = activity;
    this.emit('activity', activity);
    return activity;
  }

  openLog () {
    if (!this.settings.logfile || !Tail) return;
    try {
      this.logwatcher = new Tail(this.settings.logfile);
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

  async postToDiscord (payload) {
    if (!this.settings.discord.enable || !this.settings.discord.webhook) return null;
    if (typeof fetch !== 'function') return null;
    return fetch(this.settings.discord.webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  }

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
  const svc = new StarCitizenService({ port: process.env.PORT || 3041 });
  svc.start();
}
