'use strict';

/**
 * Loopback `Host` header check — protects unauthenticated loopback-only
 * servers from DNS-rebinding pages (a hostile site that resolves its own
 * name to 127.0.0.1 still sends its own name in `Host`).
 *
 * Pure and dependency-free so it can be unit-tested without the heavy
 * imports of the scripts that use it.
 */

/**
 * @param {string|undefined} hostHeader Raw `Host` request header.
 * @param {number|string} port The port the server listens on.
 * @returns {boolean} true only for `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`.
 */
function isLocalHost (hostHeader, port) {
  if (typeof hostHeader !== 'string') return false;
  const h = hostHeader.trim().toLowerCase();
  const p = String(port);
  return h === `127.0.0.1:${p}` || h === `localhost:${p}` || h === `[::1]:${p}`;
}

module.exports = { isLocalHost };
