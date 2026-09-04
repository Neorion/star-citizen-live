'use strict';

/**
 * Mesh identity helpers (D-008 / BUILD-PLAN-fabric-mesh.md WS2).
 *
 * Ported from the proven reference implementation
 * (martindale-star-citizen-live @ feat/op-participation, functions/identity.js)
 * and functions/fabricPubkey.js from @fabric/http, inlined here so this file
 * never depends on @fabric/http (which drags puppeteer/express/jsdom - the
 * exact "headless browser" weight D-002 removed; see BUILD-PLAN-fabric-mesh.md
 * §2). Only @fabric/core is ever required, and only lazily, inside the
 * functions that actually need a keypair - so requiring this module (and
 * therefore services/FabricSync.js) costs nothing when Fabric isn't
 * installed. encryptIdentity/decryptIdentity use Node's own `crypto` only
 * (scrypt + AES-256-GCM) and need no Fabric dependency at all.
 *
 * Never log a mnemonic, xprv, or decrypted secret.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ENCRYPTION_VERSION = 1;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 32;

// True once `@fabric/core` is actually installed (npm run fabric:install).
// Callers must check this before calling anything that needs a real keypair
// (createIdentity/restoreIdentity/signEnvelope/verifyEnvelope) - everything
// else (canonicalStringify, payloadDigest, pubkeyXOnly, pubkeysMatch,
// encryptIdentity, decryptIdentity) works with no Fabric installed.
function available () {
  try { require.resolve('@fabric/core/types/key'); return true; } catch (_) { return false; }
}

// Deterministic JSON stringify (recursively sorted object keys) so a
// signature is stable across processes and re-signable/re-verifiable
// regardless of key insertion order. Same algorithm as app/server.js's
// canonicalStringify (WS1) - duplicated here rather than imported, so this
// module has no dependency on app/server.js (services/ should never require
// app/ - the seam only goes the other way).
function canonicalStringify (value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}';
}

function payloadDigest (payload) {
  return crypto.createHash('sha256').update(canonicalStringify(payload)).digest();
}

function fabricIdentityNetwork (opts = {}) {
  const raw = opts.network || process.env.FABRIC_BITCOIN_NETWORK || process.env.BITCOIN_NETWORK || 'regtest';
  return String(raw).trim().toLowerCase() || 'regtest';
}

function fabricIdentityFrom (opts = {}) {
  const Identity = require('@fabric/core/types/identity');
  const settings = { network: fabricIdentityNetwork(opts) };
  if (opts.xprv) settings.xprv = opts.xprv;
  if (opts.mnemonic) settings.mnemonic = opts.mnemonic;
  if (opts.seed) settings.seed = opts.seed;
  return new Identity(settings);
}

// Create a brand-new identity (BIP39 mnemonic + Fabric-protocol keypair).
function createIdentity (opts = {}) {
  const identity = fabricIdentityFrom(opts);
  const master = identity.key;
  return {
    mnemonic: master.mnemonic, xprv: master.xprv, xpub: master.xpub,
    pubkey: identity.pubkey, id: identity.pubkey, network: fabricIdentityNetwork(opts)
  };
}

function looksLikeRawSeedHex (value) {
  if (value == null) return false;
  const trimmed = String(value).trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (!/^(?:0x)?[0-9a-fA-F]+$/i.test(trimmed)) return false;
  const hex = trimmed.replace(/^0x/i, '');
  if (hex.length % 2 !== 0) return false;
  const bytes = hex.length / 2;
  return bytes >= 16 && bytes <= 64;
}

// Restore an identity from a BIP39 mnemonic, raw seed hex, or an xprv.
function restoreIdentity (input) {
  let opts = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('xprv') || trimmed.startsWith('tprv')) opts = { xprv: trimmed };
    else if (looksLikeRawSeedHex(trimmed)) opts = { seed: trimmed.replace(/^0x/i, '').toLowerCase() };
    else opts = { mnemonic: trimmed };
  }
  if (!opts || (!opts.mnemonic && !opts.xprv && !opts.seed)) {
    throw new Error('restoreIdentity requires a mnemonic, seed hex, or xprv');
  }
  const identity = fabricIdentityFrom({ xprv: opts.xprv, mnemonic: opts.mnemonic, seed: opts.seed, network: opts.network });
  const master = identity.key;
  return {
    mnemonic: opts.mnemonic || master.mnemonic || null, xprv: master.xprv, xpub: master.xpub,
    pubkey: identity.pubkey, id: identity.pubkey, network: fabricIdentityNetwork(opts)
  };
}

// HD master Key for Peer construction (Peer derives the Fabric path from this).
function masterKeyFromIdentity (identity) {
  const Key = require('@fabric/core/types/key');
  if (!identity) throw new Error('identity required');
  if (identity.xprv) return new Key({ xprv: identity.xprv });
  if (identity.mnemonic) return new Key({ mnemonic: identity.mnemonic });
  throw new Error('identity has no private material (xprv or mnemonic)');
}

// Fabric-protocol signing key (matches Identity#pubkey / envelope signatures).
function protocolKeyFromIdentity (identity) {
  if (!identity) throw new Error('identity required');
  if (!identity.xprv && !identity.mnemonic) throw new Error('identity has no private material (xprv or mnemonic)');
  return fabricIdentityFrom(identity).fabricKey;
}

function keyFromIdentity (identity) { return protocolKeyFromIdentity(identity); }

// Encrypt an identity for storage at rest. Only public fields remain
// readable; mnemonic + xprv are sealed with scrypt + AES-256-GCM. Node
// built-ins only - no Fabric dependency for this half.
function encryptIdentity (identity, password) {
  if (!identity || !identity.xprv) throw new Error('identity with xprv required');
  if (!password || typeof password !== 'string') throw new Error('password required');

  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, KEY_LENGTH, SCRYPT_PARAMS);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derived, iv);
  const secret = JSON.stringify({ mnemonic: identity.mnemonic || null, xprv: identity.xprv });
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: ENCRYPTION_VERSION,
    kdf: Object.assign({ algorithm: 'scrypt', salt: salt.toString('hex') }, SCRYPT_PARAMS),
    cipher: 'aes-256-gcm', iv: iv.toString('hex'), tag: tag.toString('hex'), ciphertext: ciphertext.toString('hex'),
    pubkey: identity.pubkey, xpub: identity.xpub, id: identity.pubkey, network: identity.network,
    createdAt: new Date().toISOString()
  };
}

// Decrypt an identity blob produced by encryptIdentity().
function decryptIdentity (blob, password) {
  if (!blob || !blob.ciphertext) throw new Error('encrypted identity blob required');
  if (!password || typeof password !== 'string') throw new Error('password required');

  const salt = Buffer.from(blob.kdf.salt, 'hex');
  const params = { N: blob.kdf.N, r: blob.kdf.r, p: blob.kdf.p };
  const derived = crypto.scryptSync(password, salt, KEY_LENGTH, params);
  const decipher = crypto.createDecipheriv('aes-256-gcm', derived, Buffer.from(blob.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'hex'));

  let secret;
  try {
    const plaintext = Buffer.concat([decipher.update(Buffer.from(blob.ciphertext, 'hex')), decipher.final()]);
    secret = JSON.parse(plaintext.toString('utf8'));
  } catch (error) {
    throw new Error('Could not decrypt identity (wrong password or corrupted file)');
  }

  const identity = fabricIdentityFrom({ xprv: secret.xprv, mnemonic: secret.mnemonic || undefined, network: blob.network });
  return {
    mnemonic: secret.mnemonic || null, xprv: secret.xprv, xpub: identity.key.xpub,
    pubkey: identity.pubkey, id: identity.pubkey, network: fabricIdentityNetwork({ network: blob.network })
  };
}

// Create a Schnorr-signed envelope around a payload.
function signEnvelope (identity, payload) {
  const Key = require('@fabric/core/types/key');
  const key = (identity instanceof Key) ? identity : protocolKeyFromIdentity(identity);
  const digest = payloadDigest(payload);
  const signature = key.signSchnorr(digest);
  return { pubkey: key.pubkey, payload, signature: Buffer.from(signature).toString('hex'), digest: digest.toString('hex') };
}

// Verify a Schnorr-signed envelope. Recomputes the payload digest, so a
// tampered payload fails even with a valid signature over the old digest.
function verifyEnvelope (envelope) {
  if (!envelope || !envelope.pubkey || !envelope.signature || envelope.payload === undefined) return false;
  try {
    const Key = require('@fabric/core/types/key');
    const digest = payloadDigest(envelope.payload);
    const key = new Key({ public: envelope.pubkey });
    return key.verifySchnorr(digest, Buffer.from(envelope.signature, 'hex')) === true;
  } catch (error) {
    return false;
  }
}

// --- Pubkey normalization (inlined from @fabric/http's functions/fabricPubkey.js -
// pure string/regex helpers, no dependency on the package itself). Compressed
// (02/03||x, 33-byte) and x-only (32-byte) forms compare equal. ---
function pubkeyXOnly (hex) {
  const s = String(hex || '').toLowerCase().replace(/^0x/, '');
  if (/^0[23][0-9a-f]{64}$/.test(s)) return s.slice(2);
  if (/^[0-9a-f]{64}$/.test(s)) return s;
  return null;
}

function pubkeysMatch (a, b) {
  const xa = pubkeyXOnly(a);
  const xb = pubkeyXOnly(b);
  return !!(xa && xb && xa === xb);
}

// Load a persisted identity from `file`, or create + persist a new one.
// Encrypted (scrypt+AES-256-GCM) when `passphrase` is given; otherwise
// plaintext with an explicit `warning` field - never silent about the
// tradeoff. Never logs the mnemonic/xprv. Best-effort chmod 600 (a no-op on
// platforms - e.g. Windows - where it doesn't apply).
function loadOrCreate (file, passphrase) {
  if (fs.existsSync(file)) {
    const blob = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (blob.ciphertext) {
      if (!passphrase) throw new Error(`${file} is encrypted; set SC_FABRIC_PASSPHRASE`);
      return decryptIdentity(blob, passphrase);
    }
    return blob;   // plaintext identity, written by an earlier run with no passphrase
  }
  const identity = createIdentity();
  const toWrite = passphrase
    ? encryptIdentity(identity, passphrase)
    : Object.assign({ warning: 'plaintext key - set SC_FABRIC_PASSPHRASE to encrypt at rest' }, identity);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(toWrite, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) { /* best-effort */ }
  return identity;
}

module.exports = {
  available,
  canonicalStringify,
  payloadDigest,
  fabricIdentityNetwork,
  createIdentity,
  restoreIdentity,
  keyFromIdentity,
  protocolKeyFromIdentity,
  masterKeyFromIdentity,
  encryptIdentity,
  decryptIdentity,
  signEnvelope,
  verifyEnvelope,
  pubkeyXOnly,
  pubkeysMatch,
  loadOrCreate
};
