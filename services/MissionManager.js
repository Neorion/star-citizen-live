'use strict';

/**
 * MissionManager — the org mission register (M5.1).
 *
 * Implements D-005: a centralized, OFFICER-VALIDATED register. Lifecycle:
 *   open --apply--> (applications) --officer accept--> assigned
 *        --claim(assignee)--> (claim) --officer validate(approve)--> completed
 *                                       --officer validate(reject)--> back to assigned
 *   open|assigned --officer cancel--> cancelled
 *
 * Every mutation appends a hash-chained AuditEntry (tamper-evident; M6 adds
 * officer signatures over each entry). Backed by app/store.js (memory or file).
 * Keeps the method names/events the rest of the code already uses
 * (createMission/getMission/missions, start/stop) so nothing else breaks.
 *
 * Officer model: settings.officers is an allowlist of actor ids. If EMPTY, the
 * register runs in permissive "bootstrap" mode (everyone is an officer) so it is
 * usable before roles are wired (REST/Discord auth lands in M5.2/M5.3).
 */

const EventEmitter = require('events');
const crypto = require('crypto');
const { Store } = require('../app/store');

const ZERO = '0'.repeat(64);
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

class MissionManager extends EventEmitter {
  constructor (settings = {}) {
    super();
    this.settings = Object.assign({ enable: true, officers: [], dir: null }, settings);
    this.officers = new Set((this.settings.officers || []).map(String));
    this.store = settings.store || new Store({ dir: this.settings.dir });
    this._counter = 0;
  }

  // ---- collections ----
  get missions () { return this.store.all('missions'); }
  get applications () { return this.store.all('applications'); }
  get claims () { return this.store.all('claims'); }
  get validations () { return this.store.all('validations'); }
  get audit () { return this.store.all('audit').sort((a, b) => a.seq - b.seq); }

  async start () { this.emit('ready'); return this; }
  async stop () { this.emit('stopped'); return this; }

  _id (prefix) { this._counter += 1; return `${prefix}-${Date.now().toString(36)}-${this._counter}`; }
  _mission (id) { const m = this.store.get('missions', id); if (!m) throw new Error('mission not found'); return m; }

  // ---- officer permission ----
  isOfficer (actor) { return this.officers.size === 0 || this.officers.has(String(actor)); }
  _requireOfficer (actor) { if (!this.isOfficer(actor)) { const e = new Error('forbidden: not an officer'); e.code = 'FORBIDDEN'; throw e; } }

  // ---- audit (hash chain) ----
  _audit (actor, action, entity, entityId, summary) {
    const chain = this.audit;
    const prevHash = chain.length ? chain[chain.length - 1].hash : ZERO;
    const body = { seq: chain.length, ts: new Date().toISOString(), actor: actor != null ? String(actor) : null, action, entity, entityId, summary: summary || '' };
    const hash = sha256(prevHash + JSON.stringify(body));
    const entry = Object.assign({ id: `audit-${body.seq}` }, body, { prevHash, hash });
    this.store.put('audit', entry.id, entry);
    this.emit('audit', entry);
    return entry;
  }

  // Recompute the chain and confirm nothing was altered.
  verifyAudit () {
    let prev = ZERO;
    for (const e of this.audit) {
      const body = { seq: e.seq, ts: e.ts, actor: e.actor, action: e.action, entity: e.entity, entityId: e.entityId, summary: e.summary };
      if (e.prevHash !== prev || e.hash !== sha256(prev + JSON.stringify(body))) return false;
      prev = e.hash;
    }
    return true;
  }

  // ---- missions ----
  async createMission (data = {}) {
    const officer = data.createdBy || data.officerId || null;
    this._requireOfficer(officer);
    const id = data.id || this._id('mission');
    const mission = {
      id,
      title: data.title || 'Untitled mission',
      type: data.type || 'bounty',
      description: data.description || '',
      reward: Number(data.reward) || 0,
      requirements: data.requirements || null,
      location: data.location || null,
      deadline: data.deadline || null,
      outOfGame: !!data.outOfGame,
      createdBy: officer != null ? String(officer) : null,
      createdAt: new Date().toISOString(),
      status: 'open',
      assigneeId: null,
      contract: data.contract || { type: 'single' }
    };
    this.store.put('missions', id, mission);
    this._audit(officer, 'mission.create', 'mission', id, mission.title);
    this.emit('mission:created', mission);
    return mission;
  }

  getMission (id) { return this.store.get('missions', id); }
  getMissionApplications (missionId) { return this.applications.filter((a) => a.missionId === missionId); }
  getMissionClaims (missionId) { return this.claims.filter((c) => c.missionId === missionId); }

  async cancelMission (data = {}) {
    const m = this._mission(data.missionId);
    this._requireOfficer(data.officerId);
    if (m.status === 'completed' || m.status === 'cancelled') throw new Error(`cannot cancel a ${m.status} mission`);
    m.status = 'cancelled';
    m.cancelReason = data.reason || null;
    this.store.put('missions', m.id, m);
    this._audit(data.officerId, 'mission.cancel', 'mission', m.id, data.reason || '');
    this.emit('mission:cancelled', m);
    return m;
  }

  // ---- applications ----
  async applyToMission (data = {}) {
    const m = this._mission(data.missionId);
    if (m.status !== 'open') throw new Error(`mission is ${m.status}, not open`);
    const id = data.id || this._id('application');
    const app = { id, missionId: m.id, applicantId: String(data.applicantId || 'unknown'), message: data.message || '', status: 'pending', createdAt: new Date().toISOString() };
    this.store.put('applications', id, app);
    this._audit(app.applicantId, 'application.submit', 'application', id, m.title);
    this.emit('application:submitted', app);
    return app;
  }

  async decideApplication (data = {}) {
    const app = this.store.get('applications', data.applicationId);
    if (!app) throw new Error('application not found');
    this._requireOfficer(data.officerId);
    if (app.status !== 'pending') throw new Error(`application already ${app.status}`);
    app.decidedBy = data.officerId != null ? String(data.officerId) : null;
    app.decidedAt = new Date().toISOString();

    if (data.decision === 'accept') {
      const m = this._mission(app.missionId);
      if (m.status !== 'open') throw new Error(`mission is ${m.status}, cannot assign`);
      app.status = 'accepted';
      m.status = 'assigned';
      m.assigneeId = app.applicantId;
      this.store.put('applications', app.id, app);
      this.store.put('missions', m.id, m);
      this._audit(data.officerId, 'application.accept', 'application', app.id, m.title);
      this.emit('application:accepted', app);
    } else if (data.decision === 'reject') {
      app.status = 'rejected';
      app.reason = data.reason || null;
      this.store.put('applications', app.id, app);
      this._audit(data.officerId, 'application.reject', 'application', app.id, data.reason || '');
      this.emit('application:rejected', app);
    } else {
      throw new Error('decision must be "accept" or "reject"');
    }
    return app;
  }

  // ---- completion claims + officer validation ----
  async submitClaim (data = {}) {
    const m = this._mission(data.missionId);
    if (m.status !== 'assigned') throw new Error(`mission is ${m.status}, not assigned`);
    if (String(data.claimantId) !== String(m.assigneeId)) throw new Error('only the assignee can claim completion');
    const id = data.id || this._id('claim');
    const claim = { id, missionId: m.id, claimantId: String(data.claimantId), note: data.note || '', evidence: Array.isArray(data.evidence) ? data.evidence : [], status: 'pending', claimedAt: new Date().toISOString() };
    this.store.put('claims', id, claim);
    this._audit(claim.claimantId, 'claim.submit', 'claim', id, m.title);
    this.emit('claim:submitted', claim);
    return claim;
  }

  async validateClaim (data = {}) {
    const claim = this.store.get('claims', data.claimId);
    if (!claim) throw new Error('claim not found');
    this._requireOfficer(data.officerId);
    if (claim.status !== 'pending') throw new Error(`claim already ${claim.status}`);
    const m = this._mission(claim.missionId);
    const validation = { id: this._id('validation'), claimId: claim.id, missionId: m.id, officerId: data.officerId != null ? String(data.officerId) : null, decision: data.decision, note: data.note || '', validatedAt: new Date().toISOString() };

    if (data.decision === 'approve') {
      claim.status = 'validated';
      m.status = 'completed';
      m.completedAt = validation.validatedAt;
      this.store.put('claims', claim.id, claim);
      this.store.put('missions', m.id, m);
      this.store.put('validations', validation.id, validation);
      this._audit(data.officerId, 'claim.validate', 'claim', claim.id, 'approved');
      this.emit('claim:validated', validation);
      this.emit('mission:completed', m);
    } else if (data.decision === 'reject') {
      claim.status = 'rejected';                 // mission stays 'assigned'; assignee may re-claim
      this.store.put('claims', claim.id, claim);
      this.store.put('validations', validation.id, validation);
      this._audit(data.officerId, 'claim.validate', 'claim', claim.id, 'rejected');
      this.emit('claim:rejected', validation);
    } else {
      throw new Error('decision must be "approve" or "reject"');
    }
    return validation;
  }
}

module.exports = MissionManager;
