'use strict';

/**
 * SessionHealth — per-build session stability rollup (Analyze → Stability,
 * Advanced mode).
 *
 * Backed by GET {base}/session-health (functions/sessionHealth.js). Every row
 * is INFERRED from Game.log telemetry — in particular `crashes` counts
 * sessions with no observed clean disconnect before end-of-file, which can
 * also just mean the file was still being written. Never present the crash
 * count as confirmed.
 */

const React = require('react');

const BASE = '/services/star-citizen';

const CSS = `
  .sh-wrap{width:100%;max-width:none;margin:0;padding:12px 14px 72px;display:grid;gap:14px;box-sizing:border-box}
  .sh-panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
  .sh-panel h2{font-size:13px;margin:0;padding:12px 16px;border-bottom:1px solid var(--line);font-weight:600;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .sh-panel h2 .sub{color:var(--muted);font-weight:400;font-size:12px;flex:1;min-width:120px}
  .sh-body{padding:14px 16px}
  .sh-empty{padding:14px;text-align:center;color:var(--muted);font-size:12.5px;font-style:italic}
  .sh-err{background:rgba(248,81,73,.12);color:var(--kill);border-radius:7px;padding:8px 11px;font-size:12.5px}
  .sh-table{width:100%;border-collapse:collapse;font-size:12.5px}
  .sh-table th,.sh-table td{padding:6px 10px;text-align:left;border-bottom:1px solid #20262f;vertical-align:top}
  .sh-table th{color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.03em}
  .sh-caption{color:var(--warn);font-size:11.5px;margin:0 0 8px;font-style:italic}
`;

/**
 * @param {number|null} minutes
 * @returns {string}
 */
function fmtMedian (minutes) {
  if (minutes == null || Number.isNaN(minutes)) return 'not enough data';
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const rem = Math.round(minutes % 60);
    return rem ? `~${h}h ${rem}m` : `~${h}h`;
  }
  return `~${Math.round(minutes * 10) / 10}m`;
}

class SessionHealth extends React.Component {
  constructor (props) {
    super(props);
    this.state = {
      loading: !props.rows,
      error: null,
      rows: props.rows || null
    };
  }

  componentDidMount () {
    if (this.props.rows) return;
    this.fetchSessionHealth();
  }

  componentDidUpdate (prev) {
    if (prev.rows !== this.props.rows && this.props.rows) {
      this.setState({ rows: this.props.rows, loading: false });
    }
  }

  /** @returns {Promise<void>} */
  async fetchSessionHealth () {
    this.setState({ loading: true, error: null });
    try {
      const res = await fetch(`${BASE}/session-health`);
      const j = await res.json();
      if (!res.ok) throw new Error((j && j.error) || res.statusText);
      this.setState({ loading: false, rows: (j && j.data) || [] });
    } catch (e) {
      this.setState({ loading: false, error: e.message || String(e) });
    }
  }

  render () {
    const rows = this.props.rows || this.state.rows || [];
    return React.createElement('div', { className: 'sh-wrap' },
      React.createElement('div', { className: 'sh-panel' },
        React.createElement('h2', null, '🩺 Session stability ',
          React.createElement('span', { className: 'sub' },
            '— per-build session/disconnect health, inferred from Game.log telemetry')),
        React.createElement('div', { className: 'sh-body' },
          this.state.loading
            ? React.createElement('div', { className: 'sh-empty' }, 'Loading session health…')
            : (this.state.error
              ? React.createElement('div', { className: 'sh-err' }, this.state.error)
              : (rows.length === 0
                ? React.createElement('div', { className: 'sh-empty' }, 'No session history yet.')
                : React.createElement(React.Fragment, null,
                  React.createElement('p', { className: 'sh-caption' },
                    'Crashes are INFERRED — a session with no observed clean disconnect before ' +
                    'end of file, which can also mean the log was still being written. ' +
                    'Not a confirmed crash count.'),
                  React.createElement('div', { style: { overflowX: 'auto' } },
                    React.createElement('table', { className: 'sh-table' },
                      React.createElement('thead', null,
                        React.createElement('tr', null,
                          React.createElement('th', null, 'Build'),
                          React.createElement('th', null, 'Sessions'),
                          React.createElement('th', null, 'Disconnects'),
                          React.createElement('th', null, 'Crashes (inferred)'),
                          React.createElement('th', null, 'Median session length')
                        )
                      ),
                      React.createElement('tbody', null,
                        rows.map((row) => React.createElement('tr', { key: row.build },
                          React.createElement('td', null, row.build),
                          React.createElement('td', null, String(row.sessions || 0)),
                          React.createElement('td', null, String(row.disconnects || 0)),
                          React.createElement('td', null, String(row.crashes || 0)),
                          React.createElement('td', null, fmtMedian(row.medianSessionMinutes))
                        ))
                      )
                    )
                  )
                )))
        )
      )
    );
  }
}

SessionHealth.CSS = CSS;

module.exports = SessionHealth;
