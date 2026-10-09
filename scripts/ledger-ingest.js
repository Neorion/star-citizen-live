#!/usr/bin/env node
'use strict';

/**
 * Transaction-ledger CLI ingest.
 *
 *   npm run ledger                              # every Game.log / logbackup this install knows
 *   node scripts/ledger-ingest.js DIR_OR_FILE…  # explicit paths
 *
 * READ-ONLY on the logs; writes only the ledger's own store
 * (stores/gooncitizen/ledger.json, or under SC_SETTINGS_DIR). Re-running is
 * cheap: unchanged files are skipped via the ledger's own per-file cursor.
 * All parsing lives in services/TransactionLedger.js; this script only
 * supplies "where are the logs" via functions/logCorpus.js.
 */

const path = require('path');
const { TransactionLedger } = require('../services/TransactionLedger');
const logCorpus = require('../functions/logCorpus');
const { storeRoot } = require('../functions/storePaths');

function storeFile () {
  const dir = process.env.SC_SETTINGS_DIR
    ? storeRoot(process.env.SC_SETTINGS_DIR)
    : storeRoot(path.join(__dirname, '..', 'stores'));
  return path.join(dir, 'ledger.json');
}

async function main () {
  const explicit = process.argv.slice(2);
  const inputs = explicit.length ? explicit : logCorpus.discoverCorpusFiles({});
  const ledger = new TransactionLedger({ file: storeFile() });
  const before = ledger.stats();
  console.log(`[LEDGER] scanning ${inputs.length} path${inputs.length === 1 ? '' : 's'}…`);
  const result = await ledger.ingestPaths(inputs);
  const after = ledger.stats();
  console.log(`[LEDGER] ${result.filesFound} log files — ${result.filesScanned} scanned, ${result.filesSkippedUnchanged} unchanged.`);
  console.log(`[LEDGER] transactions ${before.transactions} -> ${after.transactions} (+${after.transactions - before.transactions})`);
  const s = ledger.summary();
  console.log(`[LEDGER] net (Success only): spend ${s.spend.toLocaleString()} · income ${s.income.toLocaleString()} · net ${s.net.toLocaleString()} aUEC`);
  console.log(`[LEDGER] wrote ${storeFile()}`);
}

if (require.main === module) main().catch((e) => { console.error('[LEDGER] failed:', e.message); process.exit(1); });

module.exports = { main, storeFile };
