'use strict';

/**
 * Parser audit (B-015).
 *
 * Runs every rule in app/parser.js's RULES table against a real log corpus and
 * reports what the "verified" claims + hit-count comments in that file assert
 * by hand: per-rule hit counts, which rules got ZERO hits (a rule commented
 * "verified" that is dormant against the current corpus - see AGENTS.md §6,
 * "a rule can be verified on 4.3.0 yet not fire on 4.8.0"), and the top
 * generic hud:notification texts + unrecognized tags that never got their own
 * rule - candidates to promote next.
 *
 * READ-ONLY: only reads log files, writes nothing.
 *
 * Usage:
 *   npm run audit                 # scan default locations (SC logbackups + ./Gamelogs)
 *   node scripts/audit.js DIR...  # scan explicit directories
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { parseLine, RULES } = require('../app/parser');
const { defaultDirs, findLogs } = require('./backfill');

// Reduce a hud:notification's free text to a stable shape for grouping -
// strip embedded counters/percentages/ids so "Deliver 0/25 Hadanite..." and
// "Deliver 3/25 Hadanite..." group together as one candidate pattern.
function normalizeText (text) {
  return String(text || '')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function newTally () {
  return { hits: {}, unrecognizedTags: {}, genericNotifications: {}, files: 0, lines: 0 };
}

function bump (bucket, key, line) {
  const e = bucket[key] || (bucket[key] = { count: 0, example: line });
  e.count += 1;
}

function processFile (file, tally) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      tally.lines++;
      const r = parseLine(line);
      bump(tally.hits, r.kind, line);
      if (r.kind === 'log:raw' || r.kind === 'log:notice') {
        if (r.tag) bump(tally.unrecognizedTags, r.tag, line);
      } else if (r.kind === 'hud:notification') {
        bump(tally.genericNotifications, normalizeText(r.text), line);
      }
    });
    rl.on('close', () => { tally.files++; resolve(); });
    rl.on('error', () => resolve());
  });
}

async function auditFiles (files, onProgress) {
  const tally = newTally();
  for (let i = 0; i < files.length; i++) {
    await processFile(files[i], tally);
    if (onProgress && (i % 25 === 0 || i === files.length - 1)) onProgress(i + 1, files.length, tally);
  }
  return tally;
}

// Rules whose `kind` never appeared in the tally - dormant against this
// corpus, whether or not their comment claims "verified". zeroHit rules are
// NOT skipped or gated at runtime (see B-017/AGENTS.md §6) - this is a report,
// not a filter.
function zeroHitRules (tally) {
  return RULES.filter((r) => !tally.hits[r.kind]);
}

function topN (bucket, n) {
  return Object.entries(bucket)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, n)
    .map(([key, v]) => ({ key, count: v.count, example: v.example }));
}

function formatReport (tally, n = 15) {
  const lines = [];
  lines.push(`Audited ${tally.files} files · ${tally.lines.toLocaleString()} lines`);
  lines.push('');
  lines.push('Per-rule hits (most first):');
  const kinds = Object.keys(tally.hits).sort((a, b) => tally.hits[b].count - tally.hits[a].count);
  for (const k of kinds) lines.push(`  ${String(tally.hits[k].count).padStart(8)}  ${k}`);
  lines.push('');
  const zero = zeroHitRules(tally);
  lines.push(`Zero-hit rules (${zero.length}):`);
  if (!zero.length) lines.push('  (none - every rule fired at least once against this corpus)');
  for (const r of zero) lines.push(`  ${r.kind}  (tag: ${r.tag || '(none)'}${r.verified === false ? ', UNVERIFIED' : ''})`);
  lines.push('');
  lines.push(`Top ${n} generic hud:notification texts (candidates for their own rule):`);
  for (const { key, count } of topN(tally.genericNotifications, n)) lines.push(`  ${String(count).padStart(8)}  ${key}`);
  lines.push('');
  lines.push(`Top ${n} unrecognized tags (log:raw/log:notice with a <Tag>):`);
  for (const { key, count } of topN(tally.unrecognizedTags, n)) lines.push(`  ${String(count).padStart(8)}  ${key}`);
  return lines.join('\n');
}

async function main () {
  const dirs = process.argv.slice(2).length ? process.argv.slice(2) : defaultDirs();
  if (!dirs.length) { console.error('No log directories found. Pass directories explicitly.'); process.exit(1); }
  console.log('Scanning:\n  ' + dirs.join('\n  '));
  let files = [];
  for (const d of dirs) files.push(...findLogs(d));
  files = [...new Set(files)];
  console.log(`Found ${files.length} log files. Auditing…`);

  const tally = await auditFiles(files, (done, total) => {
    if (done === total) console.log(`  ${done}/${total} files done`);
  });

  console.log('\n' + formatReport(tally));
}

module.exports = { auditFiles, formatReport, zeroHitRules, normalizeText, newTally, processFile };

if (require.main === module) main().catch((e) => { console.error('Audit failed:', e.message); process.exit(1); });
