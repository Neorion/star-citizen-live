'use strict';

/**
 * Verseview beacon secrets (the Bearer token) — never written to the Fabric
 * Store, mirrors functions/discordConfig.js's secrets-file convention
 * exactly. `verseviewBeaconUrl` and `verseviewShareBeacon` are NOT secrets
 * (a URL and a boolean toggle) and live in the normal Fabric Store settings
 * (functions/settingsStore.js) — only the token gets this treatment, since
 * it's a bearer credential granting write access to the operator's Verseview
 * account and must never round-trip in plaintext through GET /settings.
 */

const fs = require('fs');
const path = require('path');

const SECRETS_FILE = 'verseview.secrets.json';

/**
 * @param {string} settingsDir
 * @returns {string|null}
 */
function secretsPath (settingsDir) {
  const root = String(settingsDir || '').trim();
  if (!root) return null;
  return path.join(root, SECRETS_FILE);
}

/**
 * @param {string} settingsDir
 * @returns {{ beaconToken?: string }}
 */
function readSecretsFile (settingsDir) {
  const p = secretsPath(settingsDir);
  if (!p || !fs.existsSync(p)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (_) {
    return {};
  }
}

/**
 * Persist the Verseview beacon token beside the store root (gitignored under
 * stores/). Empty string clears it. Omitting the key leaves it unchanged.
 * @param {string} settingsDir
 * @param {{ beaconToken?: string }} patch
 * @returns {{ beaconTokenConfigured: boolean }} redacted summary — never the token itself.
 */
function writeSecretsFile (settingsDir, patch = {}) {
  const p = secretsPath(settingsDir);
  if (!p) throw new Error('settingsDir required to store Verseview secrets');
  const prev = readSecretsFile(settingsDir);
  const next = Object.assign({}, prev);
  if (Object.prototype.hasOwnProperty.call(patch, 'beaconToken')) {
    const v = patch.beaconToken;
    if (v === null || v === undefined || String(v).trim() === '') delete next.beaconToken;
    else next.beaconToken = String(v).trim();
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return { beaconTokenConfigured: !!next.beaconToken };
}

module.exports = { SECRETS_FILE, secretsPath, readSecretsFile, writeSecretsFile };
