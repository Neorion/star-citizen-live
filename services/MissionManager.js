'use strict';

/**
 * Minimal MissionManager stub.
 *
 * The real MissionManager.js was never pushed to the feature/fabric-0.1.0 branch,
 * but services/StarCitizen.js does a top-level require('./MissionManager') and
 * constructs one whenever settings.missions.enable is true (the default). Without
 * this file, `npm start` throws "Cannot find module './MissionManager'" before the
 * service can boot.
 *
 * This stub satisfies the interface StarCitizen.js expects (an EventEmitter with
 * start/stop and mission/application methods) using simple in-memory storage. It
 * implements NO crypto / multisig logic - it exists only to let the service boot
 * and make the mission HTTP endpoints return sensible responses. Replace with the
 * real implementation when the missions system is built out.
 */

const EventEmitter = require('events');

class MissionManager extends EventEmitter {
  constructor (settings = {}) {
    super();
    this.settings = Object.assign({ enable: true, autoApprove: false, maxApplicationsPerMission: 10 }, settings);
    this._missions = new Map();
    this._applications = new Map();
    this._counter = 0;
  }

  get missions () { return Array.from(this._missions.values()); }
  get applications () { return Array.from(this._applications.values()); }

  async start () { this.emit('ready'); return this; }
  async stop () { this.emit('stopped'); return this; }

  _id (prefix) { this._counter += 1; return `${prefix}-${Date.now()}-${this._counter}`; }
  _wrap (obj) { return Object.assign({}, obj, { toJSON: () => obj }); }

  async createMission (data = {}) {
    const id = data.id || this._id('mission');
    const mission = { id, title: data.title || 'Untitled mission', type: data.type || 'bounty', reward: data.reward || 0, status: 'open', contract: data.contract || { type: 'single' }, createdAt: new Date().toISOString() };
    this._missions.set(id, mission);
    this.emit('mission:created', mission);
    return this._wrap(mission);
  }

  getMission (id) { const m = this._missions.get(id); return m ? this._wrap(m) : null; }

  async completeMission (id) { const m = this._missions.get(id); if (!m) throw new Error('Mission not found'); m.status = 'completed'; this.emit('mission:completed', m); return this._wrap(m); }
  async failMission (id, reason) { const m = this._missions.get(id); if (!m) throw new Error('Mission not found'); m.status = 'failed'; m.failureReason = reason || null; this.emit('mission:failed', m); return this._wrap(m); }

  getMissionApplications (missionId) { return this.applications.filter((a) => a.missionId === missionId); }

  async submitApplication (data = {}) {
    if (!this._missions.has(data.missionId)) throw new Error('Mission not found');
    const id = data.id || this._id('application');
    const application = { id, missionId: data.missionId, applicantId: data.applicantId || 'unknown', message: data.message || '', isMultisig: !!data.isMultisig, verified: false, status: 'submitted', createdAt: new Date().toISOString() };
    this._applications.set(id, application);
    this.emit('application:submitted', application);
    if (this.settings.autoApprove) await this.approveApplication(id);
    return this._wrap(application);
  }

  async approveApplication (id) { const a = this._applications.get(id); if (!a) throw new Error('Application not found'); a.status = 'approved'; this.emit('application:approved', a); return this._wrap(a); }
  async rejectApplication (id, reason) { const a = this._applications.get(id); if (!a) throw new Error('Application not found'); a.status = 'rejected'; a.rejectionReason = reason || null; this.emit('application:rejected', a); return this._wrap(a); }
}

module.exports = MissionManager;
