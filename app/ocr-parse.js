'use strict';

/**
 * ocr-parse.js — turn raw OCR text of a Star Citizen contract screen into a
 * structured contract. Shared by the BROWSER (Cargo tab OCR import) and Node
 * tests. No dependencies; works in both via the UMD shim at the bottom.
 *
 * Verified against the 2026-06-30 bake-off output (7 real mobiGlas ACCEPTED
 * detail screenshots, tesseract.js). See DESIGN-cargo-planning.md §6b.
 *
 * The domain normalizer fixes the deterministic OCR misreads seen in the bake-off
 * (the slash in "0/10" read as "7"; "5b"→"Sb"; "500"→"S00"; smart quotes;
 * "Linehaul"→"Linshaul"). Everything else is regex extraction.
 */

function normalize (text) {
  return String(text || '')
    .replace(/[‘’′`]/g, "'")            // smart single quotes -> '
    .replace(/[“”]/g, '"')                   // smart double quotes
    .replace(/\bDeliver\s+(\d)7(\d+)\s+SCU/gi, 'Deliver $1/$2 SCU')   // 0710 -> 0/10 (slash misread)
    .replace(/\bSb\b/g, '5b').replace(/\bS00\b/g, '500')
    .replace(/Lin[a-z]?haul/gi, 'Linehaul');
}

function clean (s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
    .replace(/[.,;:]+$/, '').trim();
}

// Strip the "on Pyro 5b" / "above Pyro III" celestial suffix off a station name.
function stripBody (s) {
  return clean(String(s || '').replace(/\s+(on|above|at the)\s+(Pyro|Stanton|L\d).*$/i, ''));
}

const RANKS = /^(Junior|Member|Senior|Trainee|Recruit|Master|Associate)$/i;

function parseContractText (rawText) {
  const t = normalize(rawText);
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);

  // Title line: the one mentioning a haul with the "rank | type | from/to X" shape.
  const titleLine = lines.find((l) => /Haul/i.test(l) && /\|/.test(l)) || '';
  const parts = titleLine.split('|').map((x) => x.trim()).filter(Boolean);
  let rank = null, contractType = null, pickup = null, titleDropoff = null;
  if (parts.length) {
    const rankM = titleLine.match(/\b(Junior|Member|Senior|Trainee|Recruit|Master|Associate)\b/i);
    rank = rankM ? rankM[1] : null;
    // contractType = the "... Haul" segment
    contractType = clean((parts.find((p) => /Haul/i.test(p)) || parts[1] || parts[0] || '')
      .replace(/\s*\[.*$/, ''));       // drop trailing "[50/100/..." rep tiers if they bled in
    const route = parts.find((p) => /^\s*(from|to)\s+/i.test(p));
    if (route) {
      // cut the endpoint at Reward/Contract/double-space (OCR bleeds the reward
      // panel onto the same line since the crop puts them side by side).
      const m = route.match(/^\s*(from|to)\s+(.+?)(?:\s+Rewa|\s+Contract|\s{2,}|$)/i);
      if (m) { if (/from/i.test(m[1])) pickup = stripBody(m[2]); else titleDropoff = stripBody(m[2]); }
    }
  }

  // Reward (aUEC) — "Reward  ¤ 172,250" (¤ often OCRs to a stray digit; skip it lazily)
  const rewardM = t.match(/Rewa\w{0,3}?.{0,16}?(\d{1,3}(?:,\d{3})+|\d{4,})/i);
  const reward = rewardM ? rewardM[1] : null;

  // Contractor — "Contracted By  Red Wind Linehaul"
  const contractorM = t.match(/Contract(?:ed)? [Bb]y[^A-Za-z]{0,4}([A-Za-z][A-Za-z ]{2,40})/);
  const contractor = contractorM ? clean(contractorM[1]) : null;

  // Deliveries — "Deliver 0/9 SCU of Hydrogen to Seer's Canyon on Pyro 5b."
  const deliveries = [];
  for (const m of t.matchAll(/Deliver\s+\d+\/(\d+)\s+SCU of ([A-Za-z][A-Za-z' ]*?) to ([^\n.]+?)(?:\.|\n|$)/gi)) {
    deliveries.push({ scu: Number(m[1]), commodity: clean(m[2]), dropoff: stripBody(m[3]) });
  }

  // Pickups — "Collect Hydrogen from Fallow Field."
  const pickups = [];
  for (const m of t.matchAll(/Collect ([A-Za-z][A-Za-z' ]*?) from ([^\n.]+?)(?:\.|\n|$)/gi)) {
    const from = stripBody(m[2]);
    if (from && !/^unknown/i.test(from) && !pickups.some((p) => p.from === from && p.commodity === clean(m[1]))) {
      pickups.push({ commodity: clean(m[1]), from });
    }
  }
  if (!pickup && pickups.length) pickup = pickups[0].from;                 // "to X" contracts: pickup from Collect line
  const dropoff = titleDropoff || (deliveries[0] && deliveries[0].dropoff) || null;

  // Confidence heuristic: did we get the load-bearing fields?
  const got = [contractType, reward, (deliveries.length || pickup), dropoff].filter(Boolean).length;
  const confidence = got >= 4 ? 'high' : got >= 2 ? 'medium' : 'low';

  return {
    isContract: /Haul/i.test(t) || deliveries.length > 0,
    title: titleLine || null, rank, contractType: contractType || 'Hauling contract',
    pickup: pickup || null, dropoff, reward, contractor,
    deliveries, pickups, confidence
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { parseContractText, normalize, stripBody };
if (typeof window !== 'undefined') window.parseContractText = parseContractText;
