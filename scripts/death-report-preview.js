#!/usr/bin/env node
'use strict';

/**
 * Standalone Death Reports viewer — the Deaths tab on its own, in a browser.
 *
 *   node scripts/death-report-preview.js [Game.log | folder …] [--port 3042]
 *
 * A development/preview tool, not the product: it mounts ONLY the death
 * report component and routes, so it runs without the Fabric packages the
 * full relay (`npm start`) needs. Same component, same HTTP module, same
 * detector as the relay.
 *
 * - Read-only: log files are only ever read.
 * - Memory-only: nothing is written to disk; reports vanish when it stops.
 * - Loopback-only: listens on 127.0.0.1, never on the network.
 *
 * With no paths it looks for the installed game's Game.log + logbackups.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const esbuild = require('esbuild');

const logCorpus = require('../functions/logCorpus');
const deathReportStore = require('../functions/deathReportStore');
const { tryHandleDeathReports } = require('../functions/deathReportHttp');
const DeathReports = require('../components/DeathReports');

const ROOT = path.join(__dirname, '..');
const BASE = '/services/star-citizen';

const BASE_CSS = `
  :root{
    --bg:#0e1117; --panel:#161b22; --panel2:#1c232d; --line:#2a313c;
    --text:#e6edf3; --muted:#8b949e; --accent:#3b82f6;
    --good:#3fb950; --warn:#d29922; --raw:#6e7681; --kill:#f85149;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;font-size:14px}
  .pv-bar{padding:10px 16px;border-bottom:1px solid var(--line);background:var(--panel);color:var(--muted);font-size:12px}
  .pv-bar b{color:var(--text)}
`;

const ENTRY = `
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const DeathReports = require('./components/DeathReports');
  // The component deep-links as #deaths?id=…; make that the preview's home.
  if (!/^#deaths/.test(window.location.hash)) window.location.hash = 'deaths';
  createRoot(document.getElementById('root')).render(React.createElement(DeathReports, null));
`;

function parseArgs (argv) {
  const out = { port: 3042, inputs: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') out.port = parseInt(argv[++i], 10) || out.port;
    else out.inputs.push(argv[i]);
  }
  return out;
}

/** Expand files/folders into a de-duplicated list of log files. */
function resolveLogs (inputs) {
  const seen = new Set();
  const files = [];
  const push = (f) => {
    const abs = path.resolve(f);
    if (!seen.has(abs) && fs.existsSync(abs)) { seen.add(abs); files.push(abs); }
  };
  if (!inputs.length) {
    for (const f of logCorpus.discoverCorpusFiles({})) push(f);
    return files;
  }
  for (const input of inputs) {
    let st;
    try { st = fs.statSync(input); } catch (_) { console.warn('[DEATHS]', 'not found:', input); continue; }
    if (st.isDirectory()) for (const f of logCorpus.findLogs(input)) push(f);
    else push(input);
  }
  return files;
}

async function buildPage () {
  const result = await esbuild.build({
    stdin: { contents: ENTRY, resolveDir: ROOT, loader: 'js' },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['chrome100'],
    define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
    logLevel: 'warning'
  });
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Death reports — preview</title>
<style>${BASE_CSS}${DeathReports.CSS}</style>
</head>
<body>
<div class="pv-bar"><b>Death reports preview</b> — standalone viewer · read-only · nothing is saved or shared</div>
<div id="root"></div>
<script>${result.outputFiles[0].text}</script>
</body>
</html>
`;
}

async function main () {
  const args = parseArgs(process.argv.slice(2));
  const files = resolveLogs(args.inputs);
  const store = deathReportStore.emptyStore();
  const rescan = (list) => deathReportStore.rescanFiles(store, list);

  const html = await buildPage();
  const host = {
    store,
    hosted: false,
    requireSession: () => true,   // loopback-only preview: no remote sessions
    needsAuth: () => false,
    knownLogFiles: () => files,
    rescan,
    markDirty: () => {}           // memory-only
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj, null, 2));
    };
    const body = async () => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    };
    try {
      if (req.method === 'GET' && pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      if (await tryHandleDeathReports(host, req, res, { pathname, url, base: BASE, send, body })) return;
      send(404, { error: 'Not found' });
    } catch (e) {
      send(500, { error: e.message });
    }
  });
  server.listen(args.port, '127.0.0.1', () => {
    console.log('[DEATHS]', `open http://localhost:${args.port}/  (Ctrl+C to stop)`);
    // Scan after the page is up: a large log backlog takes minutes, and the
    // list refreshes itself as reports arrive.
    console.log('[DEATHS]', `scanning ${files.length} log file${files.length === 1 ? '' : 's'} in the background…`);
    rescan(files).then((first) => {
      console.log('[DEATHS]', `${first.lines} lines · ${first.created} death report${first.created === 1 ? '' : 's'} found`);
    }).catch((e) => console.error('[DEATHS]', 'scan failed:', e.message));
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[DEATHS]', err);
    process.exit(1);
  });
}

module.exports = { parseArgs, resolveLogs, buildPage };
