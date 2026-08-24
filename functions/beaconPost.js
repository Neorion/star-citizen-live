'use strict';

/**
 * Verseview beacon payload builder (pure, no I/O).
 *
 * Builds the POST body GoonCitizen sends to Verseview's `/api/beacon` when an
 * operator explicitly opts in to location sharing (`verseviewShareBeacon`).
 * The actual `fetch()` call, throttling, and settings gating live in
 * services/LiveRelay.js — this module only shapes the payload.
 *
 * Deliberately tiny and honest: this does NOT validate that `destination`
 * resolves to a real Verseview Location, and does not attempt any mapping or
 * fuzzy-matching — Verseview's own exact-match lookup (Location.code or
 * Location.name, case-insensitive) is authoritative. A 400 "unknown
 * location" response from Verseview for an unrecognized QT waypoint codename
 * is an expected, non-fatal outcome, not a bug in this module.
 */

/**
 * Build the `/api/beacon` payload for a quantum-travel destination.
 * @param {string} destination - Raw destination string from the most recent
 *   `quantum:select` event (e.g. a QT waypoint codename or a place name).
 * @returns {{ location_code: string }|null} Payload to POST, or `null` when
 *   there is nothing to send (empty/missing/whitespace-only destination).
 */
function beaconPayload (destination) {
  if (destination === undefined || destination === null) return null;
  const trimmed = String(destination).trim();
  if (!trimmed) return null;
  return { location_code: trimmed };
}

module.exports = { beaconPayload };
