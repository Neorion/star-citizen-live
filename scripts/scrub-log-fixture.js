#!/usr/bin/env node
'use strict';

/**
 * Scrub a real Game.log slice so it can be committed as a test fixture
 * without identifying the player who captured it.
 *
 *   node scripts/scrub-log-fixture.js <in.log> <out.log> --handle <RealHandle>
 *
 * Line shapes are preserved exactly (the parser honesty rule needs real
 * formats), only identifying values are replaced:
 *   - the player handle                 -> TestPilot
 *   - every integer of 9+ digits        -> a synthetic id of the same length
 *     (GEIDs, entity/item instance ids, epoch stamps, CRCs), mapped
 *     consistently so cross-line references still join
 *   - accountId                         -> 10001
 *   - IPv4 addresses                    -> 203.0.113.10 (TEST-NET-3)
 *   - 32-hex session ids                -> zeros
 *   - network node_id GUIDs             -> a fixed placeholder GUID
 *   - the install path                  -> the default install path
 * Item *class* GUIDs are game data shared by every player and are kept.
 *
 * The handle is passed on the command line so this file never contains one.
 */

const fs = require('fs');

const PLACEHOLDER_HANDLE = 'TestPilot';
const PLACEHOLDER_IP = '203.0.113.10';
const PLACEHOLDER_NODE = '00000000-0000-0000-0000-000000000001';
const DEFAULT_EXE = 'C:\\Program Files\\Roberts Space Industries\\StarCitizen\\LIVE\\Bin64\\StarCitizen.exe';

function escapeRe (s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} text Raw log text.
 * @param {{ handle?: string }} [opts]
 * @returns {{ text: string, ids: number }} Scrubbed text + count of remapped ids.
 */
function scrubLog (text, opts = {}) {
  const ids = new Map();
  const counters = Object.create(null);
  const synth = (id) => {
    if (ids.has(id)) return ids.get(id);
    const len = id.length;
    counters[len] = (counters[len] || 0) + 1;
    const out = '9' + String(counters[len]).padStart(len - 1, '0');
    ids.set(id, out);
    return out;
  };

  let out = String(text);
  if (opts.handle) {
    out = out.replace(new RegExp(`(?<![A-Za-z0-9_])${escapeRe(opts.handle)}(?![A-Za-z0-9_])`, 'g'), PLACEHOLDER_HANDLE);
  }
  out = out
    .replace(/(Executable: ).*StarCitizen\.exe/g, (_, p) => p + DEFAULT_EXE)
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, PLACEHOLDER_IP)
    .replace(/\b[0-9a-f]{32}\b/g, '0'.repeat(32))
    .replace(/(node_id=)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (_, p) => p + PLACEHOLDER_NODE)
    .replace(/(accountId )\d+/g, (_, p) => p + '10001')
    // Timestamps (<2026-...Z>) and floats never carry a 9+ digit integer run.
    // Hex/GUID neighbours are excluded so class GUIDs, zeroed session ids and
    // the all-zero "no mission" MissionId keep their real shape.
    .replace(/(?<![\d.a-f-])\d{9,}(?![\d.a-f-])/g, (id) => (/^0+$/.test(id) ? id : synth(id)));
  return { text: out, ids: ids.size };
}

function main (argv) {
  const args = argv.slice(2);
  const hi = args.indexOf('--handle');
  const handle = hi >= 0 ? args[hi + 1] : null;
  const files = args.filter((a, i) => a !== '--handle' && i !== hi + 1);
  if (files.length !== 2) {
    console.error('usage: node scripts/scrub-log-fixture.js <in.log> <out.log> --handle <RealHandle>');
    process.exit(1);
  }
  const result = scrubLog(fs.readFileSync(files[0], 'utf8'), { handle });
  fs.writeFileSync(files[1], result.text);
  console.log(`scrubbed ${files[0]} -> ${files[1]} (${result.ids} ids remapped)`);
}

if (require.main === module) main(process.argv);

module.exports = { scrubLog };
