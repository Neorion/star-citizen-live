'use strict';

/**
 * build-uex-vocab.js — one-shot generator: pull the UEX Corp reference lists
 * (commodities + terminals) and bake them into a COMMITTED data/uex-reference.json
 * that the relay serves offline. Run this by hand after a game patch to refresh:
 *
 *   npm run build-vocab
 *
 * This is the ONLY place that touches the network. The running service reads the
 * committed JSON — never UEX (D-002). Attribution: data © UEX Corp (uexcorp.space),
 * a community project; we redistribute a cached reference snapshot for offline use.
 */

const fs = require('fs');
const path = require('path');
const { fetchReference, BASE_URL } = require('../services/uexClient');

async function main () {
  const outDir = path.join(__dirname, '..', 'data');
  const outFile = path.join(outDir, 'uex-reference.json');
  console.log(`[uex-vocab] fetching reference from ${BASE_URL} …`);
  const ref = await fetchReference();
  const payload = {
    source: ref.source,
    attribution: 'Data © UEX Corp (https://uexcorp.space) — community-maintained; cached snapshot for offline use.',
    generatedAt: new Date().toISOString(),
    counts: { commodities: ref.commodities.length, locations: ref.locations.length },
    commodities: ref.commodities,
    locations: ref.locations
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2) + '\n');
  console.log(`[uex-vocab] wrote ${outFile} — ${payload.counts.commodities} commodities, ${payload.counts.locations} locations`);
}

main().catch((e) => { console.error('[uex-vocab] FAILED:', e.message); process.exit(1); });
