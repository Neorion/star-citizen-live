'use strict';

const NAME = 'GOONCITIZEN';
const BRAND_NAME = 'G00N CITIZEN';

/**
 * Feature flags. Disabled features are hidden from the dashboard (tab, home
 * card, and routed view). Off by default here; flip to `true` to enable.
 */
const FEATURES = {
  // Wallet tab; runtime settings.bitcoin.enable can still hide it when false.
  wallet: true,
  // Files tab (advanced UI); runtime settings.documents.enable + Advanced mode.
  // Chat 📎 attach uses the same local catalog (always, not a remote Hub).
  documents: true,
  library: false,
  // Cargo tab (WS4/T4.4): log-derived hauling board. Off by default — new
  // work on someone else's trunk defaults off per BUILD-PLAN-rsi.md.
  cargo: false
};

module.exports = {
  NAME,
  BRAND_NAME,
  FEATURES
};
