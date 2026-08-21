'use strict';

/**
 * OpParticipation — fleet-op selector + officer-facing participation summary.
 *
 * Backed by GET/POST {base}/ops and GET {base}/ops/:id/participation. All
 * numbers here (active minutes, suggested splits) are INFERRED from Game.log
 * telemetry, never ground truth — see functions/opParticipation.js's honesty
 * note. The split section is explicitly advisory: an officer decides, this
 * only suggests.
 */

const React = require('react');

const BASE = '/services/star-citizen';

const FORMULAS = [
  ['', 'None — just show participation'],
  ['equal', 'Equal split'],
  ['byActiveMinutes', 'By active minutes'],
  ['byMissions', 'By missions completed']
];

const CSS = `
  .op-wrap{width:100%;max-width:none;margin:0;padding:12px 14px 72px;display:grid;gap:14px;box-sizing:border-box}
  .op-panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
  .op-panel h2{font-size:13px;margin:0;padding:12px 16px;border-bottom:1px solid var(--line);font-weight:600;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .op-panel h2 .sub{color:var(--muted);font-weight:400;font-size:12px;flex:1;min-width:120px}
  .op-body{padding:14px 16px}
  .op-btn{background:var(--accent);border:none;color:#fff;border-radius:7px;padding:7px 14px;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap}
  .op-btn:disabled{opacity:.45;cursor:default}
  .op-btn.ghost{background:var(--panel2);border:1px solid var(--line);color:var(--text)}
  .op-field{display:grid;gap:4px;margin-bottom:10px}
  .op-field label{font-size:12px;color:var(--muted)}
  .op-field input,.op-field select{background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:8px 10px;font-size:13px}
  .op-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .op-err{background:rgba(248,81,73,.12);color:var(--kill);border-radius:7px;padding:8px 11px;font-size:12.5px;margin-top:8px}
  .op-empty{padding:14px;text-align:center;color:var(--muted);font-size:12.5px;font-style:italic}
  .op-table{width:100%;border-collapse:collapse;font-size:12.5px}
  .op-table th,.op-table td{padding:6px 10px;text-align:left;border-bottom:1px solid #20262f;vertical-align:top}
  .op-table th{color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.03em}
  .op-hint{color:var(--muted);font-size:11px}
  .op-split{margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}
  .op-caption{color:var(--warn);font-size:11.5px;margin:4px 0 8px;font-style:italic}
  .op-share-bar{background:var(--panel2);border-radius:999px;height:6px;overflow:hidden;margin-top:3px;width:120px}
  .op-share-fill{background:var(--accent);height:100%}
`;

function fmtMinutes (n) {
  const m = Number(n) || 0;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem ? `~${h}h ${rem}m` : `~${h}h`;
  }
  return `~${m}m`;
}

function topN (list, key, n) {
  if (!Array.isArray(list) || !list.length) return '—';
  return list.slice(0, n).map((row) => row[key]).join(', ');
}

class OpParticipation extends React.Component {
  constructor (props) {
    super(props);
    this.state = {
      loading: true,
      error: null,
      ops: [],
      selectedOpId: null,
      participation: null,
      pLoading: false,
      pError: null,
      formula: '',
      showCreate: false,
      newName: '',
      newStart: '',
      newEnd: '',
      creating: false,
      createError: null
    };
  }

  componentDidMount () {
    this.fetchOps();
  }

  /** @returns {Promise<void>} */
  async fetchOps () {
    this.setState({ loading: true, error: null });
    try {
      const res = await fetch(`${BASE}/ops`);
      const j = await res.json();
      if (!res.ok) throw new Error((j && j.error) || res.statusText);
      this.setState({ loading: false, ops: (j && j.data) || [] });
    } catch (e) {
      this.setState({ loading: false, error: e.message || String(e) });
    }
  }

  /**
   * @param {string} [opId] - defaults to the currently selected op.
   * @param {string} [formula] - defaults to the currently chosen formula.
   * @returns {Promise<void>}
   */
  async fetchParticipation (opId, formula) {
    const id = opId || this.state.selectedOpId;
    if (!id) return;
    const f = formula !== undefined ? formula : this.state.formula;
    this.setState({ pLoading: true, pError: null });
    try {
      const q = f ? `?formula=${encodeURIComponent(f)}` : '';
      const res = await fetch(`${BASE}/ops/${encodeURIComponent(id)}/participation${q}`);
      const j = await res.json();
      if (!res.ok) throw new Error((j && j.error) || res.statusText);
      this.setState({ pLoading: false, participation: (j && j.data) || null });
    } catch (e) {
      this.setState({ pLoading: false, pError: e.message || String(e), participation: null });
    }
  }

  /**
   * @param {string} id
   * @returns {Promise<void>}
   */
  selectOp (id) {
    this.setState({ selectedOpId: id, participation: null, pError: null });
    return this.fetchParticipation(id, this.state.formula);
  }

  /**
   * @param {string} value
   * @returns {Promise<void>}
   */
  onFormulaChange (value) {
    this.setState({ formula: value });
    return this.fetchParticipation(this.state.selectedOpId, value);
  }

  /** @returns {Promise<void>} */
  async createOp () {
    const name = (this.state.newName || '').trim();
    const start = this.state.newStart;
    const end = this.state.newEnd;
    if (!name) { this.setState({ createError: 'op name is required' }); return; }
    if (!start || !end) { this.setState({ createError: 'op start and end are required' }); return; }
    this.setState({ creating: true, createError: null });
    try {
      const body = { name, start, end };
      if (this.props.identityPubkey) body.createdBy = this.props.identityPubkey;
      const res = await fetch(`${BASE}/ops`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const j = await res.json();
      if (!res.ok) throw new Error((j && j.error) || res.statusText);
      const created = j && j.data;
      this.setState({ creating: false, showCreate: false, newName: '', newStart: '', newEnd: '' });
      await this.fetchOps();
      if (created && created.id) this.selectOp(created.id);
    } catch (e) {
      this.setState({ creating: false, createError: e.message || String(e) });
    }
  }

  renderCreateForm () {
    if (!this.state.showCreate) return null;
    return React.createElement('div', { className: 'op-body', style: { borderTop: '1px solid var(--line)' } },
      React.createElement('div', { className: 'op-field' },
        React.createElement('label', null, 'Op name'),
        React.createElement('input', {
          value: this.state.newName,
          placeholder: 'Jumptown run — Aug 20',
          onChange: (e) => this.setState({ newName: e.target.value })
        })
      ),
      React.createElement('div', { className: 'op-row' },
        React.createElement('div', { className: 'op-field', style: { flex: 1 } },
          React.createElement('label', null, 'Start'),
          React.createElement('input', {
            type: 'datetime-local',
            value: this.state.newStart,
            onChange: (e) => this.setState({ newStart: e.target.value })
          })
        ),
        React.createElement('div', { className: 'op-field', style: { flex: 1 } },
          React.createElement('label', null, 'End'),
          React.createElement('input', {
            type: 'datetime-local',
            value: this.state.newEnd,
            onChange: (e) => this.setState({ newEnd: e.target.value })
          })
        )
      ),
      this.state.createError
        ? React.createElement('div', { className: 'op-err' }, this.state.createError)
        : null,
      React.createElement('div', { className: 'op-row' },
        React.createElement('button', {
          className: 'op-btn',
          disabled: this.state.creating,
          onClick: () => this.createOp()
        }, this.state.creating ? 'Creating…' : 'Create op'),
        React.createElement('button', {
          className: 'op-btn ghost',
          onClick: () => this.setState({ showCreate: false, createError: null })
        }, 'Cancel')
      )
    );
  }

  renderSelector () {
    const ops = this.state.ops || [];
    if (!ops.length) {
      return React.createElement('div', { className: 'op-body' },
        React.createElement('div', { className: 'op-empty' },
          'No ops yet — create your first one below to start tracking participation.'),
        !this.state.showCreate
          ? React.createElement('div', { className: 'op-row', style: { justifyContent: 'center', marginTop: 8 } },
            React.createElement('button', {
              className: 'op-btn',
              onClick: () => this.setState({ showCreate: true })
            }, '+ New op'))
          : null,
        this.renderCreateForm()
      );
    }
    return React.createElement('div', { className: 'op-body' },
      React.createElement('div', { className: 'op-row' },
        React.createElement('div', { className: 'op-field', style: { flex: 1, marginBottom: 0 } },
          React.createElement('label', null, 'Op'),
          React.createElement('select', {
            value: this.state.selectedOpId || '',
            onChange: (e) => { if (e.target.value) this.selectOp(e.target.value); }
          },
            React.createElement('option', { value: '' }, 'Select an op…'),
            ops.map((op) => React.createElement('option', { key: op.id, value: op.id }, op.name))
          )
        ),
        React.createElement('button', {
          className: 'op-btn ghost',
          onClick: () => this.setState({ showCreate: !this.state.showCreate })
        }, this.state.showCreate ? 'Close' : '+ New op')
      ),
      this.renderCreateForm()
    );
  }

  renderSplit () {
    const p = this.state.participation;
    if (!this.state.formula || !p || !Array.isArray(p.split)) return null;
    return React.createElement('div', { className: 'op-split' },
      React.createElement('div', { style: { fontWeight: 600, fontSize: 12.5 } }, 'Suggested split'),
      React.createElement('div', { className: 'op-caption' },
        'Inferred from log telemetry — advisory only, the officer decides.'),
      p.split.map((row) => React.createElement('div', { key: row.member, style: { marginBottom: 6 } },
        React.createElement('div', { className: 'op-row', style: { justifyContent: 'space-between' } },
          React.createElement('span', null, row.member),
          React.createElement('span', null, (row.share * 100).toFixed(1) + '%')
        ),
        React.createElement('div', { className: 'op-share-bar' },
          React.createElement('div', {
            className: 'op-share-fill',
            style: { width: Math.max(0, Math.min(100, row.share * 100)) + '%' }
          })
        )
      ))
    );
  }

  renderParticipation () {
    if (!this.state.selectedOpId) return null;
    if (this.state.pLoading) {
      return React.createElement('div', { className: 'op-body' },
        React.createElement('div', { className: 'op-empty' }, 'Loading participation…'));
    }
    if (this.state.pError) {
      return React.createElement('div', { className: 'op-body' },
        React.createElement('div', { className: 'op-err' }, this.state.pError));
    }
    const p = this.state.participation;
    const rows = (p && Array.isArray(p.rows)) ? p.rows : [];
    return React.createElement('div', { className: 'op-body' },
      React.createElement('div', { className: 'op-row' },
        React.createElement('div', { className: 'op-field', style: { flex: 1, marginBottom: 0 } },
          React.createElement('label', null, 'Suggest a split (advisory)'),
          React.createElement('select', {
            value: this.state.formula || '',
            onChange: (e) => this.onFormulaChange(e.target.value)
          },
            FORMULAS.map(([value, label]) => React.createElement('option', { key: value || 'none', value }, label))
          )
        )
      ),
      React.createElement('p', { className: 'op-hint' },
        'Active minutes is an hour-bucket presence proxy from Game.log telemetry, ' +
        'not a measured session duration — treat it as approximate, not exact time.'),
      rows.length === 0
        ? React.createElement('div', { className: 'op-empty' }, 'No participation recorded in this op window yet.')
        : React.createElement('div', { style: { overflowX: 'auto' } },
          React.createElement('table', { className: 'op-table' },
            React.createElement('thead', null,
              React.createElement('tr', null,
                React.createElement('th', null, 'Member'),
                React.createElement('th', null, 'Active minutes (inferred)'),
                React.createElement('th', null, 'Missions (in-window / completed)'),
                React.createElement('th', null, 'Deaths'),
                React.createElement('th', null, 'Top ship(s)'),
                React.createElement('th', null, 'Top location(s)')
              )
            ),
            React.createElement('tbody', null,
              rows.map((row) => React.createElement('tr', { key: row.member },
                React.createElement('td', null, row.member),
                React.createElement('td', null, fmtMinutes(row.activeMinutes)),
                React.createElement('td', null, `${row.missionsInWindow || 0} / ${row.missionsCompleted || 0}`),
                React.createElement('td', null, String(row.deaths || 0)),
                React.createElement('td', null, topN(row.ships, 'ship', 2)),
                React.createElement('td', null, topN(row.locations, 'zone', 2))
              ))
            )
          )
        ),
      this.renderSplit()
    );
  }

  render () {
    if (this.state.loading) {
      return React.createElement('div', { className: 'op-wrap' },
        React.createElement('div', { className: 'op-panel' },
          React.createElement('div', { className: 'op-body' },
            React.createElement('div', { className: 'op-empty' }, 'Loading ops…'))));
    }
    if (this.state.error) {
      return React.createElement('div', { className: 'op-wrap' },
        React.createElement('div', { className: 'op-panel' },
          React.createElement('div', { className: 'op-body' },
            React.createElement('div', { className: 'op-err' }, this.state.error))));
    }
    return React.createElement('div', { className: 'op-wrap' },
      React.createElement('div', { className: 'op-panel' },
        React.createElement('h2', null, '🚀 Ops',
          React.createElement('span', { className: 'sub' },
            '— fleet-op participation, inferred from Game.log telemetry (not exact time)')),
        this.renderSelector()
      ),
      this.state.selectedOpId
        ? React.createElement('div', { className: 'op-panel' },
          React.createElement('h2', null, 'Participation'),
          this.renderParticipation()
        )
        : null
    );
  }
}

OpParticipation.CSS = CSS;

module.exports = OpParticipation;
