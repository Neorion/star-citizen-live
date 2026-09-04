'use strict';

/**
 * Star Citizen Live contract definition (D-008 WS4 T4.1, owner gate G2 = B).
 *
 * The reference implementation namespaces its Fabric traffic under a shared
 * "GoonCitizen" contract so multiple orgs interop on one mesh
 * (`contracts/gooncitizen.js`). G2's default answer is **B: private** —
 * matching D-008's consent-first stance, our mesh traffic is namespaced
 * under our OWN contract id instead, so upstream GoonCitizen nodes never see
 * (and never need to understand) our `SCEventBatch` frames, and we never see
 * theirs. Nothing here talks to a GoonCitizen/relay.goon.vc peer's app
 * traffic - hub.fabric.pub/relay.goon.vc are only ever used as transport
 * (gossip/relay), never as a shared application namespace.
 *
 * The id MUST be computed the same way `@fabric/core`'s Peer registers a
 * contract (`new Actor(definition).id`), so every Star Citizen Live node
 * agrees on the same namespace from the same frozen definition - no
 * network announcement (CONTRACT_PUBLISH) needed, since it's derived
 * locally and deterministically by anyone running this exact code.
 */

function _actorType () {
  return require('@fabric/core/types/actor');
}

/** Bump when the wire-visible contract shape changes (new id on purpose). */
const STARCITIZENLIVE_CONTRACT_VERSION = 1;

/** Canonical, deterministic genesis object. Keep stable - any change moves the contract id. */
const STARCITIZENLIVE_CONTRACT_DEFINITION = Object.freeze({
  name: 'StarCitizenLive',
  version: STARCITIZENLIVE_CONTRACT_VERSION,
  // Only body type we ever send - the idempotent event batch (WS1/WS3).
  messageTypes: Object.freeze(['SCEventBatch']),
  state: {}
});

let _cachedId = null;

/** A fresh copy of the genesis definition (the frozen constant is never mutated). */
function starCitizenLiveContractDefinition () {
  return {
    name: STARCITIZENLIVE_CONTRACT_DEFINITION.name,
    version: STARCITIZENLIVE_CONTRACT_DEFINITION.version,
    messageTypes: STARCITIZENLIVE_CONTRACT_DEFINITION.messageTypes.slice(),
    state: {}
  };
}

/**
 * Deterministic Star Citizen Live contract id (hex64). Matches core
 * `Peer._registerContract` (`new Actor(object).id`). Requires @fabric/core -
 * never call this unless `meshIdentity.available()` is true.
 * @returns {string}
 */
function starCitizenLiveContractId () {
  if (_cachedId) return _cachedId;
  const Actor = _actorType();
  _cachedId = new Actor(starCitizenLiveContractDefinition()).id;
  return _cachedId;
}

module.exports = {
  STARCITIZENLIVE_CONTRACT_VERSION,
  STARCITIZENLIVE_CONTRACT_DEFINITION,
  starCitizenLiveContractDefinition,
  starCitizenLiveContractId
};
