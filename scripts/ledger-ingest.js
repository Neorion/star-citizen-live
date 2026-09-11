'use strict';

/**
 * Transaction-ledger CLI ingest.
 *
 * Walks saved Game.log files (the game's own `logbackups`, plus any explicit
 * paths given on the command line) and feeds them through
 * services/TransactionLedger.js into `stores/ledger.json`. READ-ONLY on the
 * logs; only writes the ledger's own store. Re-running is safe and cheap —
 * unchanged files are skipped via the ledger's own file cursor.
 *
 * This script is app glue only. The actual parsing/correlation/resolution
 * logic lives entirely in services/TransactionLedger.js, which has zero
 * dependency on this repo and can be copied into another local tool as-is —
 * this file just supplies "where are my Game.log files" for THIS repo, via
 * scripts/backfill.js's defaultDirs() (SC's usual install locations).
 *
 * Usage:
 *   npm run ledger                 # scan default SC install locations
 *   node scripts/ledger-ingest.js DIR_OR_FILE...   # scan explicit paths
 */

const path = require('path');
const { TransactionLedger } = require('../services/TransactionLedger');
const { defaultDirs } = require('./backfill');

const STORE = path.join(__dirname, '..', 'stores', 'ledger.json');

async function main () {
  const explicit = process.argv.slice(2);
  const dirs = explicit.length ? explicit : defaultDirs();
  console.log('Scanning:\n  ' + dirs.join('\n  '));

  const ledger = new TransactionLedger({ file: STORE });
  const before = ledger.stats();
  const result = await ledger.ingestPaths(dirs);
  const after = ledger.stats();

  console.log(`\nFound ${result.filesFound} log files — ${result.filesScanned} scanned, ${result.filesSkippedUnchanged} unchanged/skipped.`);
  console.log(`Transactions: ${before.transactions} -> ${after.transactions} (+${after.transactions - before.transactions})`);
  const summary = ledger.summary();
  console.log(`Net position (Success only): spend ${summary.spend.toLocaleString()} aUEC, income ${summary.income.toLocaleString()} aUEC, net ${summary.net.toLocaleString()} aUEC`);
  console.log(`\nWrote ${STORE}`);
}

if (require.main === module) main().catch((e) => { console.error('Ledger ingest failed:', e.message); process.exit(1); });

module.exports = { main, STORE };
