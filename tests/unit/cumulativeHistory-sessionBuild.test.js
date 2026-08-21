'use strict';

/**
 * Direct ingestFile() coverage for the WS3/T3.1 session build+disconnect+endTs
 * capture (functions/cumulativeHistory.js) — feeds a real-shaped log file
 * through the actual file-ingest path, not just synthetic history records.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cumulativeHistory = require('../../functions/cumulativeHistory');

const LOG_LINES = [
  'Branch: sc-alpha-4.8.0-hotfix',
  'Changelist: 11952564',
  '<2026-08-01T00:00:00.000Z> Log started on Sat Aug 01 00:00:00 2026',
  '<2026-08-01T00:00:05.000Z> [Notice] <Legacy login response> [CIG-net] User Login Success - Handle[TestPilot] - Time[1]',
  '<2026-08-01T00:30:00.000Z> [Notice] <Channel Disconnected> cause=30010 reason="Nub destroyed" frame=7592 isRemote=0 map="megamap" gamerules="SC_Frontend" hostType="GameClient" remoteAddr=<local>:16 localAddr=<local>:12300 connection={2, 0} session=x node_id=y nickname="TestPilot" playerGEID=204100515861 uptime_secs=157.980515 [Team_Network][Network][Gateway][Disconnection]',
  '<2026-08-01T00:30:05.000Z> [Notice] <Legacy login response> [CIG-net] User Login Success - Handle[TestPilot] - Time[2]'
].join('\n') + '\n';

function tmpLogFile () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-session-build-'));
  const file = path.join(dir, 'Game.log');
  fs.writeFileSync(file, LOG_LINES);
  return file;
}

test('ingestFile captures build/branch/changelist, endTs, and disconnect count on the session record', async () => {
  const file = tmpLogFile();
  const history = cumulativeHistory.emptyHistory();
  const index = cumulativeHistory.indexHistory(history);
  const cursors = {};

  const result = await cumulativeHistory.ingestFile(file, history, index, cursors);
  assert.strictEqual(result.changed, true);
  assert.strictEqual(history.sessions.length, 1);

  const s = history.sessions[0];
  assert.strictEqual(s.player, 'TestPilot');
  assert.strictEqual(s.ts, '2026-08-01T00:00:00.000Z');
  assert.strictEqual(s.branch, 'sc-alpha-4.8.0-hotfix');
  assert.strictEqual(s.changelist, '11952564');
  assert.strictEqual(s.build, '11952564', 'build prefers changelist over branch');
  assert.strictEqual(s.endTs, '2026-08-01T00:30:05.000Z', 'endTs is the max parsed timestamp seen in the file');
  assert.strictEqual(s.disconnects, 1);
  assert.strictEqual(s.cleanEnd, true, 'a session:disconnect was observed before EOF');

  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('a session with no disconnect line is marked cleanEnd:false (inferred, not certain)', async () => {
  const noDisconnectLines = [
    'Branch: sc-alpha-4.8.0-hotfix',
    'Changelist: 11952564',
    '<2026-08-02T00:00:00.000Z> Log started on Sun Aug 02 00:00:00 2026',
    '<2026-08-02T00:00:05.000Z> [Notice] <Legacy login response> [CIG-net] User Login Success - Handle[TestPilot] - Time[1]'
  ].join('\n') + '\n';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-session-build-nodc-'));
  const file = path.join(dir, 'Game.log');
  fs.writeFileSync(file, noDisconnectLines);

  const history = cumulativeHistory.emptyHistory();
  const index = cumulativeHistory.indexHistory(history);
  await cumulativeHistory.ingestFile(file, history, index, {});

  assert.strictEqual(history.sessions.length, 1);
  assert.strictEqual(history.sessions[0].disconnects, 0);
  assert.strictEqual(history.sessions[0].cleanEnd, false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a session record with no build header at all falls back to build:null (sessionHealth then buckets it "unknown")', async () => {
  const noHeaderLines = [
    '<2026-08-03T00:00:00.000Z> Log started on Mon Aug 03 00:00:00 2026',
    '<2026-08-03T00:00:05.000Z> [Notice] <Legacy login response> [CIG-net] User Login Success - Handle[TestPilot] - Time[1]'
  ].join('\n') + '\n';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-session-build-nohdr-'));
  const file = path.join(dir, 'Game.log');
  fs.writeFileSync(file, noHeaderLines);

  const history = cumulativeHistory.emptyHistory();
  const index = cumulativeHistory.indexHistory(history);
  await cumulativeHistory.ingestFile(file, history, index, {});

  assert.strictEqual(history.sessions[0].build, null);
  assert.strictEqual(history.sessions[0].branch, null);
  assert.strictEqual(history.sessions[0].changelist, null);

  fs.rmSync(dir, { recursive: true, force: true });
});
