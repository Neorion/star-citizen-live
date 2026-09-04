'use strict';

/**
 * Fabric peer address helpers (D-008 / BUILD-PLAN-fabric-mesh.md WS3, T3.1).
 *
 * Trimmed, pure port of the proven reference's
 * `functions/fabricPeerHostLocal.js` (martindale-star-citizen-live @
 * feat/op-participation) - read in full before writing this. Only the
 * pieces WS3's peer roster actually needs are ported: parsing/validating a
 * `host:port` address and detecting a self-dial. NOT ported (out of scope
 * for the mesh's roster/consent-gate work): network-hub alias rewriting
 * (`canonicalizeFabricPeerDial`, `DEFAULT_NETWORK_HUB_SEEDS`) and the
 * app-relay-type catalog helper (`createIsKnownAppRelayType`) - pull those
 * in from the reference if a later workstream needs them.
 *
 * Node built-ins only (`os`, `dns`) - no Fabric dependency, ever.
 */

const MIN_FABRIC_PEER_PORT = 1;
const MAX_FABRIC_PEER_PORT = 65535;

/** @type {Map<string, boolean>} */
const _dnsOwnHostCache = new Map();

// Decimal integer 1..65535 only.
function parseFabricPeerPort (raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!/^\d{1,5}$/.test(s)) return null;
  const p = Number(s);
  if (!Number.isInteger(p) || p < MIN_FABRIC_PEER_PORT || p > MAX_FABRIC_PEER_PORT) return null;
  return p;
}

// Split `host:port`, `pubkey@host:port`, bracketed IPv6 `[::1]:7777`, or a
// bare host / IPv6. Naive split(':')[0] breaks on IPv6 - always use this.
function splitFabricHostPort (address) {
  let s = String(address || '').trim().toLowerCase();
  if (!s) return { host: '', port: null };

  if (!s.startsWith('[')) {
    const at = s.lastIndexOf('@');
    if (at >= 0) s = s.slice(at + 1);
  }

  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end > 1) {
      const host = s.slice(1, end);
      let port = null;
      if (s.length > end + 1 && s[end + 1] === ':') port = parseFabricPeerPort(s.slice(end + 2));
      return { host, port };
    }
  }

  const firstColon = s.indexOf(':');
  const lastColon = s.lastIndexOf(':');
  if (firstColon > 0 && firstColon === lastColon) {
    return { host: s.slice(0, firstColon), port: parseFabricPeerPort(s.slice(firstColon + 1)) };
  }
  return { host: s, port: null };   // bare IPv6 (multiple colons) or a hostname with no port
}

function isLoopbackFabricAddress (address) {
  const host = splitFabricHostPort(address).host;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

// Hostnames/IPs that identify this node, for self-dial filtering.
function collectOwnFabricHosts (opts = {}) {
  const hosts = new Set();
  const add = (raw) => { const { host } = splitFabricHostPort(raw); if (host) hosts.add(host); };
  if (opts.advertiseHost) add(opts.advertiseHost);
  for (const h of opts.ownHosts || []) add(h);
  const env = opts.env || process.env;
  for (const key of ['FABRIC_PUBLIC_HOST', 'FABRIC_ADVERTISE_HOST', 'FABRIC_INTERFACE', 'FABRIC_PEER_INTERFACE']) {
    if (env[key]) add(env[key]);
  }
  if (opts.includeLocalInterfaces !== false) {
    try {
      const os = require('os');
      const ifaces = os.networkInterfaces();
      for (const list of Object.values(ifaces || {})) {
        for (const entry of list || []) {
          if (entry && entry.address) add(String(entry.address).toLowerCase());
        }
      }
    } catch (_) { /* sandboxed/restricted OS - own-host detection degrades to loopback+env only */ }
  }
  return hosts;
}

// True when `host` is not an IP literal and DNS resolves it to a local
// interface. Best-effort: only fires when Node exposes a synchronous DNS
// lookup (not guaranteed pre-Node 22); otherwise this always returns false,
// same as the reference's own fallback.
function hostnameResolvesToOwn (host, ownHosts) {
  const key = String(host || '').trim().toLowerCase();
  if (!key || !ownHosts || !ownHosts.size) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(key)) return false;
  if (key.includes(':')) return false;
  const cacheKey = `${key}|${[...ownHosts].sort().join(',')}`;
  if (_dnsOwnHostCache.has(cacheKey)) return _dnsOwnHostCache.get(cacheKey);
  let hit = false;
  try {
    const dns = require('dns');
    if (typeof dns.lookupSync === 'function') {
      const r = dns.lookupSync(key, { all: true });
      const list = Array.isArray(r) ? r : (r ? [r] : []);
      for (const row of list) {
        const addr = row && (row.address || row);
        if (addr && ownHosts.has(String(addr).toLowerCase())) { hit = true; break; }
      }
    }
  } catch (_) { hit = false; }
  _dnsOwnHostCache.set(cacheKey, hit);
  return hit;
}

// True when dialing `address` would connect back to this process.
function isSelfFabricAddress (address, opts = {}) {
  const { host, port } = splitFabricHostPort(address);
  if (!host) return false;

  if (isLoopbackFabricAddress(address)) {
    const listen = Number(opts.listenPort);
    if (!Number.isFinite(port) || !Number.isFinite(listen) || listen <= 0) return false;
    return port === listen;
  }

  const own = collectOwnFabricHosts(opts);
  if (own.has(host)) return true;
  if (opts.resolveDns === false || opts.includeLocalInterfaces === false) return false;
  return hostnameResolvesToOwn(host, own);
}

function formatFabricHostPort (host, port) {
  const h = String(host || '').trim().toLowerCase();
  const p = parseFabricPeerPort(port);
  if (!h || p == null) return null;
  return h.includes(':') ? `[${h}]:${p}` : `${h}:${p}`;
}

// True when `value` looks like a Fabric peer address (`host:port` or
// `[ipv6]:port`), port a decimal integer in 1..65535.
function isFabricAddress (value) {
  const s = String(value || '').trim();
  if (!s || /^https?:\/\//i.test(s)) return false;
  const { host, port } = splitFabricHostPort(s);
  if (!host || port == null) return false;
  if (s.startsWith('[')) return /^\[[0-9a-fA-F:]+\]:\d{1,5}$/.test(s);
  return /^[a-zA-Z0-9._-]+:\d{1,5}$/.test(s);
}

// Normalize operator input to `host:port` (or `[ipv6]:port`). With
// `migrate:true`, also accepts a legacy `https://host` URL and rewrites it
// to `host:7777` (the Fabric default listen port).
function normalizeFabricAddress (value, { migrate = false } = {}) {
  const raw = String(value || '').trim().replace(/\/$/, '');
  if (!raw) return null;
  if (isFabricAddress(raw)) return raw;
  if (migrate && /^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      if (!u.hostname) return null;
      const host = u.hostname.includes(':') ? `[${u.hostname}]` : u.hostname;
      return `${host}:7777`;
    } catch (_) { return null; }
  }
  return null;
}

/** Clear the DNS own-host cache (tests only). */
function clearOwnHostDnsCache () { _dnsOwnHostCache.clear(); }

module.exports = {
  parseFabricPeerPort,
  splitFabricHostPort,
  isLoopbackFabricAddress,
  collectOwnFabricHosts,
  hostnameResolvesToOwn,
  isSelfFabricAddress,
  formatFabricHostPort,
  isFabricAddress,
  normalizeFabricAddress,
  clearOwnHostDnsCache
};
