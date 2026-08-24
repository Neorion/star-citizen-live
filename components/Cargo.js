'use strict';

/**
 * Cargo — read-only log-derived cargo/hauling board.
 *
 * Backed by GET {base}/cargo (services/CargoRouter.js -> functions/cargoRoute.js
 * routeMissions()). This panel has exactly ONE mission source (the Game.log) —
 * there is no manual-add / OCR-import / pin / snooze layer here (see
 * BUILD-PLAN-rsi.md WS4/T4.2's scope decision: the manual-board layer was not
 * ported). Every hub/leg is exactly what the log says; "Pickup not in log" and
 * "station not yet known" are the log's own honesty gaps, not this panel's —
 * they are rendered as-is, never smoothed over.
 */

const React = require('react');

const BASE = '/services/star-citizen';

const CSS = `
  .cg-wrap{width:100%;max-width:none;margin:0;padding:12px 14px 72px;display:grid;gap:14px;box-sizing:border-box}
  .cg-panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
  .cg-panel h2{font-size:13px;margin:0;padding:12px 16px;border-bottom:1px solid var(--line);font-weight:600;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .cg-panel h2 .sub{color:var(--muted);font-weight:400;font-size:12px;flex:1;min-width:120px}
  .cg-body{padding:14px 16px}
  .cg-empty{padding:14px;text-align:center;color:var(--muted);font-size:12.5px;font-style:italic}
  .cg-err{background:rgba(248,81,73,.12);color:var(--kill);border-radius:7px;padding:8px 11px;font-size:12.5px}
  .cg-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(108px,1fr));gap:10px;padding:12px 16px}
  .cg-mc{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
  .cg-mc .l{font-size:12px;color:var(--muted)}
  .cg-mc .v{font-size:23px;font-weight:650;color:var(--text);line-height:1.25}
  .cg-notes{padding:0 16px 12px;display:grid;gap:4px}
  .cg-note{color:var(--warn);font-size:11.5px;font-style:italic}
  .cg-hub{border-top:1px solid var(--line)}
  .cg-hub.stale{opacity:.7}
  .cg-hub-head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;padding:10px 16px;background:var(--panel2)}
  .cg-hub-head .name{font-weight:600;font-size:13px}
  .cg-hub-head .body{color:var(--muted);font-size:12px}
  .cg-hub-head .scu{margin-left:auto;font-size:12px;color:var(--muted)}
  .cg-hub-head .stale-tag{color:var(--warn);font-size:11px;font-style:italic}
  .cg-table{width:100%;border-collapse:collapse;font-size:12.5px}
  .cg-table th,.cg-table td{padding:6px 10px;text-align:left;border-bottom:1px solid #20262f;vertical-align:top}
  .cg-table th{color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.03em}
  .cg-pending{color:var(--muted);font-style:italic}
  .cg-awaiting{color:var(--muted);font-style:italic}
  .cg-reg{color:var(--accent);font-size:11px;font-weight:600}
  .cg-done{border-top:1px solid var(--line);opacity:.6}
  .cg-done .cg-table{font-size:12px}
`;

/**
 * @param {object} leg - a routeMissions() hub leg entry.
 * @returns {object} React element for one leg's <tr>.
 */
function legRow (leg) {
  const dropoffCell = leg.pending
    ? React.createElement('span', { className: 'cg-pending' }, 'station not yet known')
    : `${leg.dropoff || '—'}${leg.dropBody ? ' (' + leg.dropBody + ')' : ''}`;
  const cargoCell = leg.awaiting
    ? React.createElement('span', { className: 'cg-awaiting' }, 'accepted — no cargo line yet')
    : `${leg.commodity || '—'} · ${leg.scu != null ? leg.scu + ' SCU' : '—'}`;
  return React.createElement('tr', { key: leg.dropKey + ':' + leg.missionId },
    React.createElement('td', null,
      leg.contractType || 'Hauling contract', leg.rank ? ` (${leg.rank})` : '',
      leg.inRegister ? React.createElement('span', { className: 'cg-reg', title: 'Seen in the mission register' }, ' ✓ Register') : null),
    React.createElement('td', null, dropoffCell),
    React.createElement('td', null, cargoCell),
    React.createElement('td', null, leg.reward || '—'),
    React.createElement('td', null, leg.stale ? React.createElement('span', { className: 'cg-note' }, 'carried over') : '—')
  );
}

/**
 * @param {object} hub - a routeMissions() hub entry ({pickup, pickupKnown, pickupBody, collectScu, legs, missions, stale}).
 * @returns {object} React element for one hub section.
 */
function hubSection (hub) {
  return React.createElement('div', { className: 'cg-hub' + (hub.stale ? ' stale' : ''), key: hub.pickup },
    React.createElement('div', { className: 'cg-hub-head' },
      React.createElement('span', { className: 'name' }, hub.pickup),
      hub.pickupBody ? React.createElement('span', { className: 'body' }, hub.pickupBody) : null,
      React.createElement('span', { className: 'scu' }, `${hub.missions} mission(s) · ${hub.collectScu} SCU`),
      hub.stale ? React.createElement('span', { className: 'stale-tag' }, 'not confirmed this session') : null
    ),
    React.createElement('div', { style: { overflowX: 'auto' } },
      React.createElement('table', { className: 'cg-table' },
        React.createElement('thead', null,
          React.createElement('tr', null,
            React.createElement('th', null, 'Contract'),
            React.createElement('th', null, 'Dropoff'),
            React.createElement('th', null, 'Cargo'),
            React.createElement('th', null, 'Reward'),
            React.createElement('th', null, 'Status')
          )
        ),
        React.createElement('tbody', null, hub.legs.map(legRow))
      )
    )
  );
}

/**
 * @param {object} d - a routeMissions() done entry ({missionId, status, contractType, dropoff}).
 * @returns {object} React element for one <tr> in the Done table.
 */
function doneRow (d) {
  return React.createElement('tr', { key: d.missionId },
    React.createElement('td', null,
      d.contractType || 'Hauling contract',
      d.inRegister ? React.createElement('span', { className: 'cg-reg', title: 'Seen in the mission register' }, ' ✓ Register') : null),
    React.createElement('td', null, d.dropoff || '—'),
    React.createElement('td', null, d.status)
  );
}

class Cargo extends React.Component {
  constructor (props) {
    super(props);
    this.state = {
      loading: true,
      error: null,
      summary: null,
      hubs: [],
      done: [],
      notes: []
    };
  }

  componentDidMount () {
    this.fetchCargo();
  }

  /** @returns {Promise<void>} */
  async fetchCargo () {
    this.setState({ loading: true, error: null });
    try {
      const res = await fetch(`${BASE}/cargo`);
      const j = await res.json();
      if (!res.ok) throw new Error((j && j.error) || res.statusText);
      this.setState({
        loading: false,
        summary: j.summary || null,
        hubs: Array.isArray(j.hubs) ? j.hubs : [],
        done: Array.isArray(j.done) ? j.done : [],
        notes: Array.isArray(j.notes) ? j.notes : []
      });
    } catch (e) {
      this.setState({ loading: false, error: e.message || String(e) });
    }
  }

  renderSummary () {
    const s = this.state.summary;
    if (!s) return null;
    const kpis = [
      ['Missions', s.missions],
      ['Pickups', s.pickups],
      ['Dropoffs', s.dropoffs],
      ['Total SCU', s.totalScu],
      ['Done', s.done]
    ];
    return React.createElement('div', { className: 'cg-kpis' },
      kpis.map((k) => React.createElement('div', { className: 'cg-mc', key: k[0] },
        React.createElement('div', { className: 'l' }, k[0]),
        React.createElement('div', { className: 'v' }, String(k[1] != null ? k[1] : 0))
      ))
    );
  }

  renderNotes () {
    const notes = this.state.notes || [];
    if (!notes.length) return null;
    return React.createElement('div', { className: 'cg-notes' },
      notes.map((n, i) => React.createElement('div', { className: 'cg-note', key: i }, n))
    );
  }

  renderDone () {
    const done = this.state.done || [];
    if (!done.length) return null;
    return React.createElement('div', { className: 'cg-done' },
      React.createElement('div', { className: 'cg-hub-head' },
        React.createElement('span', { className: 'name' }, 'Done')),
      React.createElement('div', { style: { overflowX: 'auto' } },
        React.createElement('table', { className: 'cg-table' },
          React.createElement('thead', null,
            React.createElement('tr', null,
              React.createElement('th', null, 'Contract'),
              React.createElement('th', null, 'Dropoff'),
              React.createElement('th', null, 'Status')
            )
          ),
          React.createElement('tbody', null, done.map(doneRow))
        )
      )
    );
  }

  render () {
    if (this.state.loading) {
      return React.createElement('div', { className: 'cg-wrap' },
        React.createElement('div', { className: 'cg-panel' },
          React.createElement('div', { className: 'cg-body' },
            React.createElement('div', { className: 'cg-empty' }, 'Loading cargo board…'))));
    }
    if (this.state.error) {
      return React.createElement('div', { className: 'cg-wrap' },
        React.createElement('div', { className: 'cg-panel' },
          React.createElement('div', { className: 'cg-body' },
            React.createElement('div', { className: 'cg-err' }, this.state.error))));
    }
    const hubs = this.state.hubs || [];
    // Empty state: routeMissions() already pushes an honest "No cargo missions
    // yet…" line into notes[] when hubs.length===0 && done.length===0 — that
    // note (rendered by renderNotes() below) IS the empty state; no separate
    // placeholder text is added here to avoid duplicating it.
    return React.createElement('div', { className: 'cg-wrap' },
      React.createElement('div', { className: 'cg-panel' },
        React.createElement('h2', null, '📦 Cargo',
          React.createElement('span', { className: 'sub' },
            '— hauling contracts routed from Game.log telemetry, one pickup hub at a time')),
        this.renderSummary(),
        this.renderNotes(),
        hubs.map(hubSection),
        this.renderDone()
      )
    );
  }
}

Cargo.CSS = CSS;

module.exports = Cargo;
