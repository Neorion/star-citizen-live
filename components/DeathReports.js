'use strict';

/**
 * DeathReports — list + detail of local-player death incidents (Deaths tab).
 *
 * Backed by GET {base}/deathreports (functions/deathDetector.js). Deep link:
 * `#deaths?id=<report id>`.
 *
 * Every report is INFERRED from this client's Game.log — never present one as
 * officer-validated. `confirmed` means a corpse (or, on SC <= 4.3.0, a kill
 * line) was logged; `unconfirmed` means a trigger with no corpse. Reports are
 * local only: nothing on this page publishes to Fabric or Discord.
 */

const React = require('react');
const { readAppHash, setAppHash } = require('../functions/appHash');
const { CAUSE_LABELS, LAG_SPIKE_MS, fmtSpeed, groupItems } = require('../functions/deathReportView');

const BASE = '/services/star-citizen';
const REFRESH_MS = 15000;

const CSS = `
  .dr-wrap{width:100%;max-width:none;margin:0;padding:12px 14px 72px;display:grid;gap:14px;box-sizing:border-box}
  .dr-panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
  .dr-panel h2{font-size:13px;margin:0;padding:12px 16px;border-bottom:1px solid var(--line);font-weight:600;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .dr-panel h2 .sub{color:var(--muted);font-weight:400;font-size:12px;flex:1;min-width:120px}
  .dr-body{padding:14px 16px}
  .dr-empty{padding:14px;text-align:center;color:var(--muted);font-size:12.5px;font-style:italic}
  .dr-err{background:rgba(248,81,73,.12);color:var(--kill);border-radius:7px;padding:8px 11px;font-size:12.5px;margin-bottom:10px}
  .dr-note{color:var(--muted);font-size:11.5px;line-height:1.5;margin:10px 0 0}
  .dr-bar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
  .dr-chip{background:transparent;border:1px solid var(--line);color:var(--muted);border-radius:999px;padding:3px 10px;font-size:11.5px;cursor:pointer;font-family:inherit}
  .dr-chip:hover{color:var(--text)}
  .dr-chip.on{border-color:var(--accent);color:var(--text);background:rgba(59,130,246,.12)}
  .dr-btn{background:var(--panel2);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:5px 11px;font-size:12px;cursor:pointer;font-family:inherit}
  .dr-btn:hover{border-color:var(--accent)}
  .dr-btn:disabled{opacity:.55;cursor:default}
  .dr-btn.danger:hover{border-color:var(--kill);color:var(--kill)}
  .dr-spacer{flex:1}
  .dr-scroll{overflow-x:auto}
  .dr-table{width:100%;border-collapse:collapse;font-size:12.5px}
  .dr-table th,.dr-table td{padding:7px 10px;text-align:left;border-bottom:1px solid #20262f;vertical-align:top}
  .dr-table th{color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.03em;white-space:nowrap}
  .dr-table td.num{text-align:right;font-variant-numeric:tabular-nums}
  .dr-table tbody tr{cursor:pointer}
  .dr-table tbody tr:hover{background:var(--panel2)}
  .dr-when{white-space:nowrap}
  .dr-pill{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11px;border:1px solid var(--line);white-space:nowrap}
  .dr-pill.confirmed{border-color:var(--kill);color:var(--kill)}
  .dr-pill.unconfirmed{border-color:var(--warn);color:var(--warn)}
  .dr-pill.open{border-color:var(--accent);color:var(--accent)}
  .dr-head{font-size:15px;line-height:1.45;font-weight:600;margin:0 0 8px}
  .dr-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
  .dr-kv{display:grid;grid-template-columns:120px 1fr;gap:5px 10px;font-size:12.5px;margin:0}
  .dr-kv dt{color:var(--muted)}
  .dr-kv dd{margin:0;overflow-wrap:anywhere}
  .dr-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
  .dr-time{list-style:none;margin:0;padding:0;font-size:12.5px}
  .dr-time li{display:grid;grid-template-columns:96px 104px 1fr;gap:8px;padding:5px 0;border-bottom:1px solid #20262f}
  .dr-time li:last-child{border-bottom:none}
  .dr-kind{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.03em}
  .dr-kind.trigger,.dr-kind.confirmed{color:var(--kill)}
  .dr-kind.incapacitated{color:var(--warn)}
  .dr-kind.respawn{color:var(--good)}
  .dr-gear{display:grid;grid-template-columns:120px 1fr;gap:6px 10px;font-size:12.5px;margin:0}
  .dr-gear dt{color:var(--muted)}
  .dr-gear dd{margin:0;overflow-wrap:anywhere}
  .dr-details summary{cursor:pointer;color:var(--muted);font-size:12px}
  .dr-details ul{margin:8px 0 0;padding:0;list-style:none;font-size:11.5px}
  .dr-toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:60;display:flex;gap:10px;align-items:center;
    max-width:min(760px,calc(100vw - 28px));background:var(--panel);border:1px solid var(--kill);border-radius:10px;
    padding:10px 14px;font-size:12.5px;box-shadow:0 8px 28px rgba(0,0,0,.45)}
  .dr-toast-text{flex:1;min-width:0}
`;

/** @param {string|null} iso @returns {string} Local date + time, or '—'. */
function fmtLocal (iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** @param {string|null} iso @returns {string} UTC clock with milliseconds. */
function fmtClock (iso) {
  return iso ? String(iso).slice(11, 23) : '';
}

/** @param {string} cause @returns {string} */
function causeLabel (cause) {
  return CAUSE_LABELS[cause] || cause || 'Unknown';
}

class DeathReports extends React.Component {
  constructor (props) {
    super(props);
    this.state = {
      loading: !props.rows,
      error: null,
      rows: props.rows || [],
      total: props.rows ? props.rows.length : 0,
      cause: null,
      selectedId: props.report ? props.report.id : null,
      report: props.report || null,
      reportLoading: false,
      busy: false,
      rescan: null,
      copied: false
    };
  }

  componentDidMount () {
    this._onHash = () => this.syncFromHash();
    if (typeof window !== 'undefined') window.addEventListener('hashchange', this._onHash);
    this.syncFromHash();
    if (!this.props.rows) this.fetchList();
    this._timer = setInterval(() => { if (!this.state.selectedId) this.fetchList(); }, REFRESH_MS);
  }

  componentWillUnmount () {
    if (this._onHash && typeof window !== 'undefined') window.removeEventListener('hashchange', this._onHash);
    if (this._timer) clearInterval(this._timer);
  }

  /** @returns {Object} Bearer header for hosted / shared-LAN sessions. */
  headers (extra) {
    const h = Object.assign({}, extra || {});
    if (this.props.authToken) h.Authorization = `Bearer ${this.props.authToken}`;
    return h;
  }

  syncFromHash () {
    const { path, query } = readAppHash();
    if (path !== 'deaths') return;
    const id = query.id || null;
    if (id === this.state.selectedId) return;
    if (id) this.fetchReport(id);
    else this.setState({ selectedId: null, report: null });
  }

  /** @returns {Promise<void>} */
  async fetchList () {
    try {
      const res = await fetch(`${BASE}/deathreports?limit=200`, { headers: this.headers() });
      const j = await res.json();
      if (!res.ok) throw new Error((j && j.error) || res.statusText);
      this.setState({ loading: false, error: null, rows: (j && j.data) || [], total: (j && j.total) || 0 });
    } catch (e) {
      this.setState({ loading: false, error: e.message || String(e) });
    }
  }

  /** @param {string} id @returns {Promise<void>} */
  async fetchReport (id) {
    this.setState({ selectedId: id, report: null, reportLoading: true, error: null, copied: false });
    try {
      const res = await fetch(`${BASE}/deathreports/${encodeURIComponent(id)}`, { headers: this.headers() });
      const j = await res.json();
      if (!res.ok) throw new Error((j && j.error) || res.statusText);
      this.setState({ report: j.data, reportLoading: false });
    } catch (e) {
      this.setState({ reportLoading: false, error: e.message || String(e) });
    }
  }

  openReport (id) {
    setAppHash('deaths', { id });
    this.fetchReport(id);
  }

  closeReport () {
    setAppHash('deaths');
    this.setState({ selectedId: null, report: null, error: null });
    this.fetchList();
  }

  /** Re-run the detector over every log file this relay knows about. */
  async rescan () {
    this.setState({ busy: true, rescan: null, error: null });
    try {
      const res = await fetch(`${BASE}/deathreports/rescan`, {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ all: true })
      });
      const j = await res.json();
      if (!res.ok) throw new Error((j && j.error) || res.statusText);
      this.setState({ busy: false, rescan: j });
      await this.fetchList();
    } catch (e) {
      this.setState({ busy: false, error: e.message || String(e) });
    }
  }

  /** @param {string} id */
  async remove (id) {
    if (typeof window !== 'undefined' && !window.confirm('Remove this death report? A rescan of the log will bring it back.')) return;
    try {
      const res = await fetch(`${BASE}/deathreports/${encodeURIComponent(id)}`, { method: 'DELETE', headers: this.headers() });
      const j = await res.json();
      if (!res.ok) throw new Error((j && j.error) || res.statusText);
      this.closeReport();
    } catch (e) {
      this.setState({ error: e.message || String(e) });
    }
  }

  /** @param {'md'|'json'} format Download the export through fetch so the session header rides along. */
  async download (format) {
    const r = this.state.report;
    if (!r) return;
    try {
      const res = await fetch(`${BASE}/deathreports/${encodeURIComponent(r.id)}/export?format=${format}`, { headers: this.headers() });
      if (!res.ok) throw new Error(res.statusText);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `death-report-${r.id.slice(0, 8)}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      this.setState({ error: e.message || String(e) });
    }
  }

  async copyCoords () {
    const p = this.state.report && this.state.report.pos;
    if (!p) return;
    try {
      await navigator.clipboard.writeText(`${p.x} ${p.y} ${p.z}`);
      this.setState({ copied: true });
    } catch (_) { /* clipboard unavailable */ }
  }

  renderList () {
    const rows = this.props.rows || this.state.rows || [];
    const causes = [...new Set(rows.map((r) => r.cause))].filter(Boolean);
    const shown = this.state.cause ? rows.filter((r) => r.cause === this.state.cause) : rows;
    const rescan = this.state.rescan;
    return React.createElement('div', { className: 'dr-panel' },
      React.createElement('h2', null, '💀 Death reports ',
        React.createElement('span', { className: 'sub' }, '— rebuilt from Game.log · inferred, local only')),
      React.createElement('div', { className: 'dr-body' },
        this.state.error ? React.createElement('div', { className: 'dr-err' }, this.state.error) : null,
        React.createElement('div', { className: 'dr-bar' },
          React.createElement('button', {
            className: 'dr-chip' + (!this.state.cause ? ' on' : ''),
            onClick: () => this.setState({ cause: null })
          }, `All (${rows.length})`),
          causes.map((c) => React.createElement('button', {
            key: c,
            className: 'dr-chip' + (this.state.cause === c ? ' on' : ''),
            onClick: () => this.setState({ cause: c })
          }, `${causeLabel(c)} (${rows.filter((r) => r.cause === c).length})`)),
          React.createElement('span', { className: 'dr-spacer' }),
          React.createElement('button', {
            className: 'dr-btn', disabled: this.state.busy, onClick: () => this.rescan()
          }, this.state.busy ? 'Rescanning…' : 'Rescan logs')
        ),
        rescan
          ? React.createElement('p', { className: 'dr-note' },
            `Rescanned ${rescan.files} log file${rescan.files === 1 ? '' : 's'} (${rescan.lines} lines): ` +
            `${rescan.created} new, ${rescan.updated} updated, ${rescan.skippedDuplicates} already on record.`)
          : null,
        this.state.loading
          ? React.createElement('div', { className: 'dr-empty' }, 'Loading death reports…')
          : (shown.length === 0
            ? React.createElement('div', { className: 'dr-empty' },
              'No deaths on record yet. They appear here as they happen; Rescan logs back-fills saved logs.')
            : React.createElement('div', { className: 'dr-scroll' },
              React.createElement('table', { className: 'dr-table' },
                React.createElement('thead', null,
                  React.createElement('tr', null,
                    React.createElement('th', null, 'When'),
                    React.createElement('th', null, 'Pilot'),
                    React.createElement('th', null, 'What happened'),
                    React.createElement('th', null, 'Where'),
                    React.createElement('th', null, 'Ship'),
                    React.createElement('th', null, 'Lost items'),
                    React.createElement('th', null, 'Status')
                  )
                ),
                React.createElement('tbody', null,
                  shown.map((r) => React.createElement('tr', { key: r.id, onClick: () => this.openReport(r.id) },
                    React.createElement('td', { className: 'dr-when', title: (r.at || '') + ' (UTC)' }, fmtLocal(r.at)),
                    React.createElement('td', null, r.player || '—'),
                    React.createElement('td', null, r.summary || causeLabel(r.cause)),
                    React.createElement('td', null, r.zoneName || '—'),
                    React.createElement('td', null, r.vehicleName || '—'),
                    React.createElement('td', { className: 'num' }, String(r.itemsLost || 0)),
                    React.createElement('td', null,
                      React.createElement('span', { className: 'dr-pill ' + r.status }, r.status))
                  ))
                )
              )
            )),
        React.createElement('p', { className: 'dr-note' },
          'Inferred from this client\'s Game.log, not officer-validated. "confirmed" = a corpse was logged; ' +
          '"unconfirmed" = a crash or ejection with no corpse logged (survived, revived, or the body was lost with the ship — ' +
          'the log cannot tell which). Current game builds do not log who or what killed you, so on-foot deaths show an unknown cause.')
      )
    );
  }

  renderDetail () {
    const r = this.props.report || this.state.report;
    const back = React.createElement('button', { className: 'dr-btn', onClick: () => this.closeReport() }, '← All deaths');
    if (!r) {
      return React.createElement('div', { className: 'dr-panel' },
        React.createElement('h2', null, back),
        React.createElement('div', { className: 'dr-body' },
          this.state.error
            ? React.createElement('div', { className: 'dr-err' }, this.state.error)
            : React.createElement('div', { className: 'dr-empty' }, 'Loading death report…')));
    }
    const kv = (label, value) => (value == null || value === ''
      ? null
      : [React.createElement('dt', { key: label + 'k' }, label), React.createElement('dd', { key: label + 'v' }, value)]);
    const groups = groupItems(r);
    const lag = r.lastFrameMs != null && r.lastFrameMs > LAG_SPIKE_MS;
    return React.createElement(React.Fragment, null,
      React.createElement('div', { className: 'dr-panel' },
        React.createElement('h2', null, back,
          React.createElement('span', { className: 'sub' }, `death report · ${fmtLocal(r.confirmedAt || r.triggerAt)}`),
          React.createElement('button', { className: 'dr-btn', onClick: () => this.download('md') }, 'Export Markdown'),
          React.createElement('button', { className: 'dr-btn', onClick: () => this.download('json') }, 'Export JSON'),
          React.createElement('button', { className: 'dr-btn danger', onClick: () => this.remove(r.id) }, 'Remove')),
        React.createElement('div', { className: 'dr-body' },
          this.state.error ? React.createElement('div', { className: 'dr-err' }, this.state.error) : null,
          React.createElement('p', { className: 'dr-head' }, r.summary, ' ',
            React.createElement('span', { className: 'dr-pill ' + r.status }, r.status)),
          React.createElement('div', { className: 'dr-grid' },
            React.createElement('dl', { className: 'dr-kv' },
              kv('Pilot', r.player),
              kv('Cause', causeLabel(r.cause)),
              kv('Modifiers', (r.modifiers || []).join(', ')),
              kv('Ship', r.vehicleName),
              kv('Seat', r.wasPilot == null ? null : (r.wasPilot ? 'pilot' : 'passenger')),
              kv('Impact part', r.impactPart),
              kv('Impact speed', fmtSpeed(r.impactSpeed)),
              kv('Hit', r.collider ? r.collider + (r.colliderDistance != null ? ` · ${r.colliderDistance.toFixed(1)} m` : '') : null),
              kv('Frame time', r.lastFrameMs != null
                ? `${r.lastFrameMs.toFixed(1)} ms — ${lag ? 'possible lag spike' : 'normal'}`
                : null),
              kv('Killer', r.killer),
              kv('Weapon', r.weaponClass),
              kv('Damage', r.damageType)
            ),
            React.createElement('dl', { className: 'dr-kv' },
              kv('Where', r.zoneName ? (r.zoneName === r.zone ? r.zone : `${r.zoneName} (${r.zone})`) : null),
              kv('Position', r.pos
                ? React.createElement('span', null,
                  React.createElement('span', { className: 'dr-mono' },
                    `x ${r.pos.x.toFixed(2)} · y ${r.pos.y.toFixed(2)} · z ${r.pos.z.toFixed(2)} `),
                  React.createElement('button', { className: 'dr-chip', onClick: () => this.copyCoords() },
                    this.state.copied ? 'Copied' : 'Copy'))
                : null),
              kv('Triggered', r.triggerAt ? fmtClock(r.triggerAt) + ' UTC' : null),
              kv('Downed', r.incapacitatedAt
                ? fmtClock(r.incapacitatedAt) + ' UTC' + (r.incapSource === 'preceding-notice' ? ' (inferred from an earlier notice)' : '')
                : null),
              kv('Died', r.confirmedAt ? fmtClock(r.confirmedAt) + ' UTC' : null),
              kv('Respawned', r.respawnedAt ? fmtClock(r.respawnedAt) + ' UTC' : null),
              kv('Game build', r.build),
              kv('Log file', r.logFile)
            )
          )
        )
      ),
      React.createElement('div', { className: 'dr-panel' },
        React.createElement('h2', null, 'Timeline ', React.createElement('span', { className: 'sub' }, '— UTC, in log order')),
        React.createElement('div', { className: 'dr-body' },
          React.createElement('ul', { className: 'dr-time' },
            (r.timeline || []).map((t, i) => React.createElement('li', { key: i },
              React.createElement('span', { className: 'dr-mono' }, fmtClock(t.at)),
              React.createElement('span', { className: 'dr-kind ' + t.kind }, t.kind),
              React.createElement('span', null, t.label)
            ))
          )
        )
      ),
      React.createElement('div', { className: 'dr-panel' },
        React.createElement('h2', null, `Gear left on corpse (${r.itemsLost || 0}) `,
          React.createElement('span', { className: 'sub' }, '— from the corpse manifest in the log')),
        React.createElement('div', { className: 'dr-body' },
          groups.length === 0
            ? React.createElement('div', { className: 'dr-empty' }, 'No corpse manifest was logged for this incident.')
            : React.createElement('dl', { className: 'dr-gear' },
              groups.map((g) => [
                React.createElement('dt', { key: g.category + 'k' }, `${g.label} (${g.count})`),
                React.createElement('dd', { key: g.category + 'v', className: 'dr-mono' },
                  g.items.map((i) => (i.count > 1 ? `${i.itemClass} ×${i.count}` : i.itemClass)).join(', '))
              ])
            ),
          React.createElement('details', { className: 'dr-details', style: { marginTop: 12 } },
            React.createElement('summary', null, `Evidence — ${(r.evidence || []).length} matched log lines`),
            React.createElement('ul', { className: 'dr-mono' },
              (r.evidence || []).map((e, i) => React.createElement('li', { key: i },
                `line ${e.line} · ${fmtClock(e.at)} · ${e.signal}`))),
            React.createElement('p', { className: 'dr-note' },
              r.lineBasis === 'file'
                ? 'Line numbers count from the top of the log file. Raw log text is not stored.'
                : 'Captured live: line numbers count from when the relay attached, not from the top of the file. Raw log text is not stored.')
          )
        )
      )
    );
  }

  render () {
    const detail = !!(this.props.report || this.state.selectedId);
    return React.createElement('div', { className: 'dr-wrap' }, detail ? this.renderDetail() : this.renderList());
  }
}

DeathReports.CSS = CSS;

module.exports = DeathReports;
