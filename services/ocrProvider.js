'use strict';

/**
 * ocrProvider.js — OPTIONAL cloud OCR fallback for the cargo importer.
 *
 * SEPARABLE + zero-dep: uses Node's built-in global `fetch` (Node 18+). Keys come
 * from the environment ONLY, never hardcoded (same rule as DISCORD_WEBHOOK_URL).
 * Enabled with SC_OCR_PROVIDER=claude + ANTHROPIC_API_KEY. Provider-agnostic shape
 * so OpenAI/others can be added as sibling functions behind the same route.
 *
 * PRIVACY: this tier sends the screenshot to the provider's cloud (the documented
 * trade-off — the local tesseract.js tier keeps images on-machine). Only used when
 * the user explicitly opts in.
 */

const PROMPT = 'You are reading a Star Citizen mobiGlas hauling contract screen. ' +
  'Extract ONLY what is visible, as strict minified JSON with these keys: ' +
  'contractType (string), rank (string or null), pickup (string or null — the collect location), ' +
  'dropoff (string or null — the primary delivery station), reward (string — the aUEC number as shown), ' +
  'deliveries (array of {"scu":number,"commodity":string,"dropoff":string}), ' +
  'pickups (array of {"commodity":string,"from":string}), ' +
  'suggestedStatus ("active" if an ABANDON button is visible, "candidate" if an ACCEPT button is visible, else null). ' +
  'Strip celestial suffixes like "on Pyro 5b" from station names. Output JSON only, no prose, no code fences.';

// image: data-URL or bare base64. Returns { provider, contract, text }.
async function ocrViaClaude (image, mime, apiKey, model) {
  if (typeof fetch !== 'function') throw new Error('global fetch unavailable (needs Node 18+)');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const data = String(image || '').replace(/^data:[^,]+,/, '');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: model || 'claude-haiku-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mime || 'image/png', data } },
        { type: 'text', text: PROMPT }
      ] }]
    })
  });
  if (!res.ok) throw new Error('Claude API ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const j = await res.json();
  const text = (j.content || []).map((c) => c.text || '').join('');
  let contract = null;
  try { const m = text.match(/\{[\s\S]*\}/); if (m) contract = JSON.parse(m[0]); } catch (_) { /* leave null */ }
  if (contract) {
    contract.isContract = true;
    contract.confidence = contract.confidence || 'high';
    if (!Array.isArray(contract.deliveries)) contract.deliveries = [];
    if (!Array.isArray(contract.pickups)) contract.pickups = [];
  }
  return { provider: 'claude', contract, text };
}

module.exports = { ocrViaClaude, PROMPT };
