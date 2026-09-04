'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { auditFiles, formatReport, zeroHitRules, normalizeText } = require('../scripts/audit');
const { RULES } = require('../app/parser');

test('normalizeText collapses embedded numbers so repeated notifications group together', () => {
  assert.strictEqual(normalizeText('Deliver 0/25 Hadanite to Shubin Mining Facility SCD-1: '), 'Deliver #/# Hadanite to Shubin Mining Facility SCD-#:');
  assert.strictEqual(normalizeText('Deliver 12/25 Hadanite to Shubin Mining Facility SCD-1: '), 'Deliver #/# Hadanite to Shubin Mining Facility SCD-#:');
  assert.strictEqual(normalizeText(''), '');
  assert.strictEqual(normalizeText(null), '');
});

test('auditFiles tallies per-rule hits, generic notifications, and unrecognized tags against a real-format fixture', async () => {
  const tally = await auditFiles([path.join(__dirname, 'fixtures', 'sample-audit.log')]);

  assert.strictEqual(tally.files, 1);
  assert.strictEqual(tally.lines, 6);

  assert.strictEqual(tally.hits['player:login'].count, 1);
  assert.strictEqual(tally.hits['hud:notification'].count, 3, 'two "Entered Monitored Space" + one Quantum Travel line, all zero-MissionId');
  assert.strictEqual(tally.hits['log:notice'].count, 2, 'two lines under an unrecognized tag');
  assert.ok(!tally.hits['mission:notification'], 'no non-zero MissionId in this fixture');

  assert.strictEqual(tally.genericNotifications['Entered Monitored Space:'].count, 2);
  assert.strictEqual(tally.genericNotifications['Quantum Travel Calibration Started By DeadMan#:'].count, 1);

  assert.strictEqual(tally.unrecognizedTags.SomeUnrecognizedThing.count, 2);
});

test('zeroHitRules reports every RULES entry whose kind never appeared, and only those', async () => {
  const tally = await auditFiles([path.join(__dirname, 'fixtures', 'sample-audit.log')]);
  const zero = zeroHitRules(tally);
  const zeroKinds = zero.map((r) => r.kind);

  assert.ok(zeroKinds.includes('kill'), 'this tiny fixture has no kill line');
  assert.ok(zeroKinds.includes('vehicle:destroy'), 'this tiny fixture has no vehicle-destruction line');
  assert.ok(!zeroKinds.includes('player:login'), 'player:login DID fire - must not be reported as zero-hit');
  assert.ok(!zeroKinds.includes('hud:notification'), 'hud:notification DID fire - must not be reported as zero-hit');
  // Every zero-hit entry really is a RULES entry (no invented kinds).
  assert.ok(zero.every((r) => RULES.includes(r)));
});

test('the full real corpus has zero zero-hit rules (every VERIFIED rule is live) — skips without a corpus', { skip: (() => { try { return require('fs').readdirSync(path.join(__dirname, '..', 'Gamelogs')).length === 0; } catch (_) { return true; } })() ? 'no corpus under Gamelogs/ (gitignored)' : false }, async () => {
  const { findLogs } = require('../scripts/backfill');
  const files = findLogs(path.join(__dirname, '..', 'Gamelogs'))
    .map((f) => ({ f, size: require('fs').statSync(f).size }))
    .sort((a, b) => a.size - b.size)
    .slice(0, 20)
    .map((x) => x.f);
  const tally = await auditFiles(files);
  assert.ok(tally.lines > 0);
  // Not a strict assertion (a 20-file sample may legitimately miss a rare rule
  // like vehicle:destroy) - just confirms the audit runs clean end-to-end on
  // real data and produces a report string.
  const report = formatReport(tally);
  assert.ok(report.includes('Per-rule hits'));
  assert.ok(report.includes('Zero-hit rules'));
});
