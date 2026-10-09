'use strict';

/**
 * Ledger — kiosk/terminal spend & income rebuilt from Game.log (Ledger tab).
 *
 * Backed by GET {base}/ledger (services/TransactionLedger.js). Every row is
 * INFERRED from this client's log: the shop archetype in the log is not a
 * place, so the location comes from the kiosk you opened just before, and
 * its friendly name comes from a seed dictionary that is honest about
 * confidence — `exact`, `inferred` (candidates listed) or `unresolved`.
 * Never present an unresolved id as a name. Local only: nothing on this page
 * publishes to Fabric or Discord.
 */

const React = require('react');

const BASE = '/services/star-citizen';
const REFRESH_MS = 15000;

const KIND_LABELS = {
  buy_item_kiosk: 'Bought item (kiosk)',
  buy_item_standard: 'Bought item',
  buy_commodity: 'Bought commodity',
  sell_commodity: 'Sold commodity',
  refinery_order: 'Refinery order'
};

const CSS = `
  .lg-wrap{width:100%;max-width:none;margin:0;padding:12px 14px 72px;display:grid;gap:14px;box-sizing:border-box}
  .lg-panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
  .lg-panel h2{font-size:13px;margin:0;padding:12px 16px;border-bottom:1px solid var(--line);font-weight:600;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .lg-panel h2 .sub{color:var(--muted);font-weight:400;font-size:12px;flex:1;min-width:120px}
  .lg-body{padding:14px 16px}
  .lg-empty{padding:14px;text-align:center;color:var(--muted);font-size:12.5px;font-style:italic}
  .lg-err{background:rgba(248,81,73,.12);color:var(--kill);border-radius:7px;padding:8px 11px;font-size:12.5px;margin-bottom:10px}
  .lg-note{color:var(--muted);font-size:11.5px;line-height:1.5;margin:10px 0 0}
  .lg-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px}
  .lg-kpi{background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:10px 12px}
  .lg-kpi .l{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.03em}
  .lg-kpi .v{font-size:17px;font-weight:600;font-variant-numeric:tabular-nums;margin-top:2px}
  .lg-kpi .v.spend{color:var(--kill)} .lg-kpi .v.income{color:var(--good)}
  .lg-bar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
  .lg-chip{background:transparent;border:1px solid var(--line);color:var(--muted);border-radius:999px;padding:3px 10px;font-size:11.5px;cursor:pointer;font-family:inherit}
  .lg-chip:hover{color:var(--text)}
  .lg-chip.on{border-color:var(--accent);color:var(--text);background:rgba(59,130,246,.12)}
  .lg-btn{background:var(--panel2);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:5px 11px;font-size:12px;cursor:pointer;font-family:inherit}
  .lg-btn:hover{border-color:var(--accent)}
  .lg-btn:disabled{opacity:.55;cursor:default}
  .lg-spacer{flex:1}
  .lg-scroll{overflow-x:auto}
  .lg-table{width:100%;border-collapse:collapse;font-size:12.5px}
  .lg-table th,.lg-table td{padding:7px 10px;text-align:left;border-bottom:1px solid #20262f;vertical-align:top}
  .lg-table th{color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.03em;white-space:nowrap}
  .lg-table td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .lg-table td.num.spend{color:var(--kill)} .lg-table td.num.income{color:var(--good)}
  .lg-when{white-space:nowrap}
  .lg-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
  .lg-conf{display:inline-block;border-radius:999px;padding:0 7px;font-size:10.5px;border:1px solid var(--line);margin-left:6px;white-space:nowrap;color:var(--muted)}
  .lg-conf.exact{border-color:var(--good);color:var(--good)}
  .lg-conf.inferred{border-color:var(--warn);color:var(--warn)}
  .lg-conf.unresolved{border-color:var(--raw);color:var(--raw)}
  .lg-result{display:inline-block;border-radius:999px;padding:0 7px;font-size:10.5px;border:1px solid var(--line);color:var(--muted)}
  .lg-result.Success{border-color:var(--good);color:var(--good)}
`;

/** @param {string|null} iso @returns {string} */
function fmtLocal (iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** @param {number|null} n @returns {string} */
function fmtAuec (n) {
  if (n == null || Number.isNaN(n)) return '—';
  return Math.round(n).toLocaleString() + ' aUEC';
}

/** @param {Object} r Ledger row @returns {string} What was bought/sold, best name first, raw id last. */
function whatOf (r) {
  if (r.resourceDisplay) return r.resourceDisplay;
  if (r.itemDisplay) return r.itemDisplay;
  if (r.itemClass) return r.itemClass;
  if (r.resourceGuid) return 'commodity ' + String(r.resourceGuid).slice(0, 8) + '…';
  return r.kind === 'refinery_order' ? 'refinery work order' : '—';
}

/** @param {Object} r Ledger row @returns {string} */
function qtyOf (r) {
  if (r.quantity == null) return '';
  const unit = r.quantityUnit === 'cSCU' ? ` cSCU (${(r.quantity / 100).toLocaleString()} SCU)` : (r.quantityUnit && r.quantityUnit !== 'each' ? ' ' + r.quantityUnit : '');
  return r.quantity.toLocaleString() + unit;
}

class Ledger extends React.Component {
  constructor (props) {
    super(props);
    this.state = {
      loading: !props.rows,
      error: null,
      rows: props.rows || [],
      summary: props.summary || null,
      direction: null,
      includeNonSuccess: false,
      busy: false,
      ingest: null
    };
  }

  componentDidMount () {
    if (!this.props.rows) this.fetchAll();
    this._timer = setInterval(() => this.fetchAll(), REFRESH_MS);
  }

  componentWillUnmount () {
    if (this._timer) clearInterval(this._timer);
  }

  headers (extra) {
    const h = Object.assign({}, extra || {});
    if (this.props.authToken) h.Authorization = `Bearer ${this.props.authToken}`;
    return h;
  }

  /** @returns {Promise<void>} */
  async fetchAll () {
    if (this.props.rows) return;
    try {
      const q = this.state.includeNonSuccess ? '?includeNonSuccess=1' : '';
      const [r1, r2] = await Promise.all([
        fetch(`${BASE}/ledger${q}`, { headers: this.headers() }),
        fetch(`${BASE}/ledger/summary`, { headers: this.headers() })
      ]);
      const j1 = await r1.json();
      if (!r1.ok) throw new Error((j1 && j1.error) || r1.statusText);
      const j2 = r2.ok ? await r2.json() : null;
      this.setState({ loading: false, error: null, rows: (j1 && j1.data) || [], summary: j2 });
    } catch (e) {
      this.setState({ loading: false, error: e.message || String(e) });
    }
  }

  /** Ingest every log file this relay knows (cheap to repeat: unchanged files are skipped). */
  async ingest () {
    this.setState({ busy: true, ingest: null, error: null });
    try {
      const res = await fetch(`${BASE}/ledger/ingest`, {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ all: true })
      });
      const j = await res.json();
      if (!res.ok) throw new Error((j && j.error) || res.statusText);
      this.setState({ busy: false, ingest: j });
      await this.fetchAll();
    } catch (e) {
      this.setState({ busy: false, error: e.message || String(e) });
    }
  }

  async download () {
    try {
      const res = await fetch(`${BASE}/ledger/export.csv`, { headers: this.headers() });
      if (!res.ok) throw new Error(res.statusText);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ledger.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      this.setState({ error: e.message || String(e) });
    }
  }

  /** Operator correction: name a location the seed dictionary does not know. */
  async nameLocation (row) {
    if (typeof window === 'undefined') return;
    const display = window.prompt(`Name for location ${row.locationId}?`, row.locationDisplay || '');
    if (!display || !display.trim()) return;
    try {
      const res = await fetch(`${BASE}/ledger/action`, {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ action: 'learnLocation', id: row.locationId, display: display.trim() })
      });
      const j = await res.json();
      if (!res.ok) throw new Error((j && j.error) || res.statusText);
      await this.fetchAll();
    } catch (e) {
      this.setState({ error: e.message || String(e) });
    }
  }

  renderKpis (s) {
    if (!s) return null;
    const systems = Object.keys(s.bySystem || {});
    return React.createElement('div', { className: 'lg-kpis' },
      React.createElement('div', { className: 'lg-kpi' },
        React.createElement('div', { className: 'l' }, 'Spent'),
        React.createElement('div', { className: 'v spend' }, fmtAuec(s.spend))),
      React.createElement('div', { className: 'lg-kpi' },
        React.createElement('div', { className: 'l' }, 'Earned'),
        React.createElement('div', { className: 'v income' }, fmtAuec(s.income))),
      React.createElement('div', { className: 'lg-kpi' },
        React.createElement('div', { className: 'l' }, 'Net'),
        React.createElement('div', { className: 'v' }, fmtAuec(s.net))),
      React.createElement('div', { className: 'lg-kpi' },
        React.createElement('div', { className: 'l' }, 'Transactions'),
        React.createElement('div', { className: 'v' }, String(s.count || 0),
          systems.length ? React.createElement('span', { className: 'lg-note', style: { marginLeft: 6 } }, systems.join(' · ')) : null))
    );
  }

  render () {
    const all = this.props.rows || this.state.rows || [];
    const rows = (this.state.direction ? all.filter((r) => r.direction === this.state.direction) : all)
      .slice()
      .sort((a, b) => String(b.utcTs).localeCompare(String(a.utcTs)));
    const ing = this.state.ingest;
    return React.createElement('div', { className: 'lg-wrap' },
      React.createElement('div', { className: 'lg-panel' },
        React.createElement('h2', null, '💰 Ledger ',
          React.createElement('span', { className: 'sub' }, '— kiosk & terminal spend and income, rebuilt from Game.log · inferred, local only')),
        React.createElement('div', { className: 'lg-body' },
          this.state.error ? React.createElement('div', { className: 'lg-err' }, this.state.error) : null,
          this.renderKpis(this.props.summary || this.state.summary),
          React.createElement('div', { className: 'lg-bar' },
            [[null, 'All'], ['spend', 'Spend'], ['income', 'Income']].map(([key, label]) => React.createElement('button', {
              key: String(key),
              className: 'lg-chip' + (this.state.direction === key ? ' on' : ''),
              onClick: () => this.setState({ direction: key })
            }, `${label} (${(key ? all.filter((r) => r.direction === key) : all).length})`)),
            React.createElement('button', {
              className: 'lg-chip' + (this.state.includeNonSuccess ? ' on' : ''),
              title: 'Also show requests the shop rejected or never answered',
              onClick: () => this.setState({ includeNonSuccess: !this.state.includeNonSuccess }, () => this.fetchAll())
            }, 'Include failed'),
            React.createElement('span', { className: 'lg-spacer' }),
            React.createElement('button', { className: 'lg-btn', onClick: () => this.download() }, 'Export CSV'),
            React.createElement('button', { className: 'lg-btn', disabled: this.state.busy, onClick: () => this.ingest() },
              this.state.busy ? 'Scanning…' : 'Scan saved logs')
          ),
          ing
            ? React.createElement('p', { className: 'lg-note' },
              `Scanned ${ing.filesScanned} log file${ing.filesScanned === 1 ? '' : 's'} (${ing.filesSkippedUnchanged} unchanged): ` +
              `${ing.transactionsAdded} new transaction${ing.transactionsAdded === 1 ? '' : 's'}, ${ing.transactions} on record.`)
            : null,
          this.state.loading
            ? React.createElement('div', { className: 'lg-empty' }, 'Loading ledger…')
            : (rows.length === 0
              ? React.createElement('div', { className: 'lg-empty' },
                'No transactions on record yet. They appear as you shop; Scan saved logs back-fills history.')
              : React.createElement('div', { className: 'lg-scroll' },
                React.createElement('table', { className: 'lg-table' },
                  React.createElement('thead', null,
                    React.createElement('tr', null,
                      React.createElement('th', null, 'When'),
                      React.createElement('th', null, 'What'),
                      React.createElement('th', null, 'Item / commodity'),
                      React.createElement('th', null, 'Quantity'),
                      React.createElement('th', null, 'Amount'),
                      React.createElement('th', null, 'Where'),
                      React.createElement('th', null, 'Result')
                    )
                  ),
                  React.createElement('tbody', null,
                    rows.map((r) => React.createElement('tr', { key: r.id },
                      React.createElement('td', { className: 'lg-when', title: (r.utcTs || '') + ' (UTC)' }, fmtLocal(r.utcTs)),
                      React.createElement('td', null, KIND_LABELS[r.kind] || r.kind,
                        r.verified === false
                          ? React.createElement('span', { className: 'lg-conf unresolved', title: 'This log line shape has not been confirmed against a real log yet' }, 'unverified shape')
                          : null),
                      React.createElement('td', null, whatOf(r)),
                      React.createElement('td', null, qtyOf(r)),
                      React.createElement('td', { className: 'num ' + r.direction }, (r.direction === 'income' ? '+' : '−') + fmtAuec(r.amountAuec)),
                      React.createElement('td', null,
                        r.locationDisplay
                          ? r.locationDisplay
                          : (r.locationId
                            ? React.createElement('span', { className: 'lg-mono', title: 'No friendly name on record for this location id' }, r.locationId)
                            : 'unknown — no kiosk opened before this'),
                        r.locationId
                          ? React.createElement('span', { className: 'lg-conf ' + (r.locationConfidence || 'unresolved') }, r.locationConfidence || 'unresolved')
                          : null,
                        r.locationId && r.locationConfidence !== 'exact'
                          ? React.createElement('button', { className: 'lg-chip', style: { marginLeft: 6 }, onClick: () => this.nameLocation(r) }, 'name it')
                          : null),
                      React.createElement('td', null, React.createElement('span', { className: 'lg-result ' + (r.result || '') }, r.result || 'Unknown'))
                    ))
                  )
                )
              )),
          React.createElement('p', { className: 'lg-note' },
            'Inferred from this client\'s Game.log, not officer-validated. The shop name in the log is a reusable archetype, ' +
            'not a place: "Where" is the kiosk you opened just before the purchase, named only when the dictionary knows it ' +
            '(exact), listed with candidates when it does not pin one (inferred), or left as the raw id (unresolved). ' +
            'Amounts are what the shop was asked for; failed or unanswered requests are hidden unless you include them.')
        )
      )
    );
  }
}

Ledger.CSS = CSS;

module.exports = Ledger;
