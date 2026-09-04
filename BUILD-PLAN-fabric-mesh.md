# BUILD-PLAN-fabric-mesh.md — execution plan for the Fabric event-sharing backbone (D-008 / M4)

> **What this is.** The buildable plan for [`DECISIONS.md`](DECISIONS.md) →
> **D-008** ("M4 backbone is Fabric mesh, not a central VPS"), in the same shape
> as [`BUILD-PLAN-rsi.md`](BUILD-PLAN-rsi.md): workstreams → sub-agent-sized
> tasks → acceptance criteria → verification. Where this file and the code
> disagree, **the code wins** — re-read the cited lines, don't guess.
>
> **Evidence basis (all read, none executed):** target `master` @ `app/server.js`
> (863 lines on the branch surveyed); PR #10 branch `decision/fabric-backbone-not-vps`
> (`DECISIONS.md` D-008, `HANDOFF-master.md` §3–§5, `DESIGN-distributed.md` §6,
> `DESIGN-event-convergence.md` §7); reference
> `martindale-star-citizen-live @ feat/op-participation` (HEAD `c569aaf`),
> specifically `services/LiveRelay.js`, `services/FabricNetwork.js` (1,636 lines),
> `functions/identity.js` (348 lines), `tests/relay/{ingest,quantum-shipuse-share,
> fabric-peer}.test.js`, `package.json` + `package-lock.json`, and
> `node_modules/@fabric/{core,http,hub}/package.json`.
>
> **Written:** 2026-09-04, by a Fable research pass against both repos above,
> reviewed and committed by the orchestrating session.
>
> ⚠️ **D-006 still applies.** Each workstream needs the owner's explicit
> go-ahead before code is written. This plan is the proposal, not the
> permission.

---

## 0. Execution protocol (read this first)

**The orchestrator (you) integrates, tests, and commits — sub-agents do the
reading and bulk coding, and never commit or push.** Same discipline as
`BUILD-PLAN-rsi.md` §0:

1. **One workstream at a time**, in the order of §5 unless the owner reorders.
   WS4 and WS5 may run in parallel once WS3 is merged (§5).
2. Give every coding sub-agent the **Pattern Card** (§3, "Pattern Card") verbatim.
3. **Never run WS4's gated network test as a detached/background process.** A
   prior planning pass for this exact work stalled for over ten minutes doing
   exactly that (spawning a two-node Fabric peer test in the background and
   never returning). Run it foreground, with a timeout, once, and read the
   result directly.
4. Branch fresh per workstream (`feature/mesh-*`, off `master`), one PR each.
   Verify with `npm test` (must stay green **with no Fabric installed**) before
   every commit.
5. If a cited `file:line` is stale, search for the quoted identifier instead of
   guessing at a new location.

---

## 1. Assessment summary

### 1.1 What is actually being built (plain terms)

Today each member's relay (`app/server.js`) parses their own `Game.log` and
keeps everything in memory on their own PC. This work adds an **optional
"mesh" module** so a member can choose to share their parsed gameplay events
(deaths, missions, crew sightings, ship destructions, incaps, disconnects,
roster) with **specific other members' relays** over Fabric's peer-to-peer
transport, and receive theirs in return — so the Analyze tab and mission
groups show the org, not just "you". Sharing is **off by default**, **per-peer
opt-in**, **signed** (each relay has a keypair; every batch is Schnorr-signed
so a receiver knows who said it), and **idempotent** (re-delivery never
double-counts).

Nothing changes for a member who leaves it off: `app/server.js` stays
zero-dependency, `npm test` stays green with no Fabric installed.

### 1.2 What is already proven (the reference implementation)

All of the following exists, is tested, and is the pattern to **port, not
redesign**:

| Concern | Reference code (file:line, `martindale-star-citizen-live @ feat/op-participation`) | Proven by |
|---|---|---|
| Per-peer consent gate | `services/LiveRelay.js:2748` `_logShareTargets()`, `:2757` `_canShareLogs()`, `:2768` `_logSharePublishOpts()`; peer record shape `_normalizePeerRecord()` `:2711` (`{ id, address, label, enabled, shareLogs, expectedPubkey, lastSeen, lastError }`); global flag `_shareLogsGlobal` loaded default-OFF at `:2421` | `tests/relay/quantum-shipuse-share.test.js:49–98` |
| Outbound queue + flush | `_startFabricFlush()` `:10205–10247` (subscribes `kill`, `player:death`, `player:incap`, `vehicle:destroy`, `mission:event`, generic `event`, `player:join`; cap 5000; 5 s timer, `unref()`); `_flushUplink()` `:11211–11241` (batches of 200, requeue on failure, `{to}` targeting) | same test file (queue assertions) |
| Wire publish | `services/FabricNetwork.js:1400` `publishEventBatch()` → `_publishContractMessage()` `:1609` → `_signAndRelay()` `:564` (broadcast via `peer.relayFrom(null,msg)` or directed via `connections[id]._writeFabric(buf)` when `opts.to` set) | `tests/relay/fabric-peer.test.js:115–187` (two real loopback peers converge) |
| Inbound dispatch | `FabricNetwork.js` `attachAppHandlers()` `:118–` — `peer.on('contract:message')` `:161`, routes `SCEventBatch` to `handlers.onEventBatch(object, signer, meta)` `:222`; LiveRelay handler `:8902–8921` loops `object.events` into `_ingestEvent` | fabric-peer test |
| Ingest / fold / idempotency | `LiveRelay.js:4418` `_ingestEvent(source, collection, data)`: `INGEST_COLLECTIONS` allowlist `:124`, canonical id `idFor(canonicalStringify({source, collection, data}))`, `players` roster upsert, history fold for `deaths/missionlog/quantum/shipuse` | `tests/relay/ingest.test.js:50–79` (created 2 → replay created 0; `source` = sender pubkey), `quantum-shipuse-share.test.js:111–189` |
| Signed envelope + tamper rejection | `functions/identity.js:265` `signEnvelope()`, `:283` `verifyEnvelope()`, `:54` `canonicalStringify()`; `LiveRelay.js:4334` `_checkEnvelope()` (401 unsigned/invalid, 403 not on `allowedKeys`) | `ingest.test.js:81–105` |
| Identity | `identity.js:76` `createIdentity()` (BIP39 mnemonic + Fabric `Identity`), `:163` `masterKeyFromIdentity()` (HD xprv → `Key`), `:176` `protocolKeyFromIdentity()`, `:191/:223` `encryptIdentity/decryptIdentity` (scrypt + AES-256-GCM, Node `crypto` only) | `tests/relay/identity.test.js` |
| Peer lifecycle | `FabricNetwork.js:654` `_startInner()` — `new Peer({ listen, port, interface, peers, peersDb, networking, key:{xprv}, upnp:false, constraints:{peers:{max}} })`; `setPeers()` `:427`; `status()` `:462` (`fabricConnected`, `fabricPeerId`, `ready`); `stop()` `:1106`. LiveRelay `_ensureFabricBody()` `:10061–10118` | fabric-peer test |
| Roster persistence + seeds | `DEFAULT_PEERS` `LiveRelay.js:128–131` = `hub.fabric.pub:7777`, `relay.goon.vc:7777`; `_loadPersistedSettings()` `:2371` (first boot seeds hubs; explicit `peers: []` respected); `_persistPeers()` `:3703` | `fabric-peer.test.js:55–66` |
| Peer REST | `POST /peers` `:6376–6412` (`address`, `label`, `enabled`, `shareLogs`, `expectedPubkey`); `GET/DELETE/POST /peers/:id` `:6790–6815` (toggle `shareLogs`) | `tests/relay/peering-http.test.js` |

### 1.3 What is genuinely new work for this codebase

The target is ~700–860 lines vs. ~11,000; almost everything is *extraction*
(pull the functions above out of a monolith into one sibling module) plus
*adaptation* to the target's shapes:

1. **A `source`-aware event id + idempotent upsert** — the target's POST seam
   (`app/server.js:411`-ish) still uses `idFor(JSON.stringify(data) + Date.now())`,
   i.e. **never** idempotent. `DESIGN-event-convergence.md` §7 and
   `HANDOFF-master.md` §5 item 1 both say do this first. Transport-agnostic,
   zero-dep.
2. **The sibling module itself** — `services/FabricSync.js`, wired exactly
   like `this.cargoRouter` (`app/server.js:84–89`), lazy-`require`ing
   `@fabric/core` only when enabled.
3. **Collection mapping** — the target has `crew` and `disconnects` (no
   `quantum`/`shipuse`), and its analytics fold is `_analyticsDataset()`
   (`app/server.js:106`) over `this.deaths` / `this.missionGroups` rather than
   the reference's `_applyHistoryEvent` + `history.*`. Peer events must land
   where that fold already reads.
4. **Player attribution** — target events carry `player: this._sessionHandle`
   (deaths/incaps) or `ev.player` (mission:end) — good — but `_indexMission()`
   and `_analyticsDataset()` default missing players to `me`. Peer-sourced
   groups need `source` + `player` stamped so they aren't attributed to the
   local pilot.
5. **Identity at rest without a desktop unlock UI** — the reference decrypts
   identity in Electron; the relay here is headless. Needs a file-backed
   identity in `stores/` (gitignored) with optional passphrase.
6. **Test gating** — a real two-peer loopback test needs `@fabric/core`
   installed; it must be skipped, not failed, on a zero-dep checkout.

### 1.4 Explicitly out of scope (from the reference — ignore as noise)

Bitcoin/multisig/statechains, `GameStateSnapshot` hub sidechain (stretch only,
§5 WS6), Federation groups/`GroupManager`, chat/`ChatManager`, direct chat,
mission `MissionCreated/Broadcast/Claim` over Fabric, Discord coordination
journal, identity cross-signs, device link, peering offers/
`P2P_PEERING_OFFER`, Verseview beacon, Electron/Android, `@fabric/hub`,
`@fabric/http`, `@fabric/discord`. **And, per D-008: the mission register
(`services/MissionManager.js`) is untouched** — it keeps running exactly as
today in whatever single process hosts it. Its federated home (elected node
vs. M6 multisig) is a separate, unmade owner decision (`HANDOFF-master.md` §4).

---

## 2. Dependency / package assessment

### 2.1 What is actually needed

| Package | Needed? | Why |
|---|---|---|
| `@fabric/core` (`github:FabricLabs/fabric#feature/rsi`) | **Yes — the only one** | `types/peer` (TCP + NOISE transport, `relayFrom`, `connections`), `types/key` (secp256k1 Schnorr, HD derivation), `types/identity`, `types/message` (AMP wire frames, `signWithKey`). |
| `@fabric/http` | **No** | Reference uses only `functions/fabricPubkey` (3 tiny pure functions) and `functions/fabricPeerHost`, for which the reference already ships a **local fallback** `functions/fabricPeerHostLocal.js` (~400 lines, pure, MIT) — port that instead. `@fabric/http` drags `puppeteer@24`, `express`, `jsdom@29`, `webpack` — this is the "headless browser" `SPIKE-LOG-tier0-boot.md` measured and D-002 removed. |
| `@fabric/hub`, `@fabric/discord` | **No** | Hub-side/site code (React, jsdom, nodemailer). Not used by the event path. |
| `tiny-secp256k1`, `bip32`, `bitcoinjs-lib`, `ecpair` (reference top-level) | **No** | Reference uses them for wallet/multisig features; `@fabric/core/types/key` brings its own `@noble/curves` + `bitcoinjs-lib@7`. |

### 2.2 Honest install weight

- `@fabric/core@0.1.0-RC1` declares **35 direct dependencies**, including
  native/heavy ones: `zeromq@6.5`, `level@10` (LevelDB), `redis@6`,
  `node-gyp@13`, `node-addon-api`, `ts-morph@28`, `blessed`, `jayson`,
  `bitcoinjs-lib@7`, `noise-protocol-stream`. `types/peer.js:116` hard-requires
  `level` at module load; `:119` `noise-protocol-stream`. So even the minimal
  install pulls native prebuilds.
- Reference lockfile: 1,276 packages total (that includes Electron/Capacitor —
  not attributable to Fabric). `SPIKE-LOG-tier0-boot.md` measured **~728
  components / ~400 MB** for core+hub; core alone is plausibly 150–300 MB
  with native prebuilds. **Not independently re-measured against this exact
  target** — see §6.
- It is a **git dependency** on a moving branch (`#feature/rsi`), needs
  `allow-git` in `.npmrc` (see `BUILD-PLAN-rsi.md` §0), and the reference runs
  **Node 24**; the target promises Node 18+. `level@10` / `@noble/curves@2` /
  `zeromq@6.5` likely need Node ≥ 20. **Unverified on the owner's machine** —
  see §6, gate G1.

### 2.3 Mitigation — concrete gating (this is the whole point of D-002 surviving D-008)

1. **`package.json` `dependencies` stays `{}`.** Do **not** add `@fabric/core`
   to `dependencies` or `optionalDependencies` (an optionalDependency is still
   fetched by a plain `npm install`, which would silently reintroduce the
   400 MB install for everyone). Instead add a script:
   `"fabric:install": "npm i --no-save @fabric/core@github:FabricLabs/fabric#feature/rsi"`
   and document it in `CONTINUE.md`/`AGENTS.md` §3. *(Owner alternative: list
   it under `optionalDependencies` for discoverability at the cost of the
   "no npm install needed" guarantee — decide at gate G4.)*
2. **One seam, one flag:**
   `this.fabric = (this.settings.fabric && this.settings.fabric.enable) ? new (require('../services/FabricSync'))(…) : null;`
   in the constructor, directly under the `cargoRouter` line, env-driven from
   the `require.main` block as `fabric: { enable: !!process.env.SC_FABRIC }`.
3. **Lazy, guarded `require` inside the module only.**
   `services/FabricSync.js` must `require('@fabric/core/types/peer')` etc.
   **inside** `start()`/`_ensurePeer()`, wrapped in try/catch, so
   `require('../services/FabricSync')` itself succeeds with no Fabric
   installed (needed so unit tests of the consent gate/queue run on a
   zero-dep checkout). If enabled but missing: log one clear line
   (`[STAR-CITIZEN] fabric: @fabric/core not installed — run npm run fabric:install`),
   expose `status().installed=false`, and **degrade to a no-op** (never throw
   from the constructor, never crash the relay).
4. **Nothing Fabric in `app/parser.js`** (D-008 consequence, verbatim). The
   module subscribes to the service's existing `this.emit(...)` events — it
   never touches parsing.
5. **Zero-dep pieces stay in core where they benefit both paths:** canonical
   id + `_ingestEvent()` + idempotent POST (WS1) are Node-`crypto`-only and
   live in `app/server.js`; the reference's `canonicalStringify`/
   `payloadDigest` (`identity.js:54–68`) are pure and portable.

---

## 3. Pattern Card (give to every coding sub-agent verbatim)

- CommonJS, `'use strict'`, 2-space, semicolons, single quotes. Match
  `services/CargoRouter.js` for module shape and `app/server.js` for route
  style (`if (path === \`${base}/x\`) … return send(200, {...})`).
- **Core stays zero-dep.** `app/server.js`, `app/parser.js`, `app/store.js`
  may only `require` Node built-ins and repo files. Only
  `services/FabricSync.js` may `require('@fabric/core/...')`, and only lazily
  inside a try/catch.
- **The log is read-only.** Never write under the SC install.
- **Never crash the relay from the mesh.** Every Fabric call path is wrapped:
  `try { … } catch (e) { this.emit('error', e); }` (the service already has
  an `'error'` safety listener).
- **Consent is a hard gate, default OFF.** No event leaves the process unless
  `_canShareLogs()` is true; `{ to: [...] }` targeting when not global. Copy
  the reference gate; do not invent a new one.
- **Label inferred vs validated.** Peer-sourced data is *attributable*
  (signed) not *trusted*. UI copy must say "shared by \<peer label\>", never
  imply officer validation.
- Tests: `node --test test/*.test.js`, `port: 0`, `historyFile: NO_HISTORY`
  (see `test/service.test.js`), always `await s.stop()` in `finally`,
  `clearInterval` any timers you start.
- If a cited line number is stale, search for the quoted identifier instead.

---

## 4. Workstream map

```
WS1 source id + idempotent ingest ─► WS2 FabricSync skeleton + identity ─► WS3 outbound consent + queue ─► WS4 Peer transport (two-node) ─► WS5 roster REST + Mesh panel
        (zero-dep, ½–1 d)                 (1–2 d)                                (1 d)                          (2–4 d)                         (1–2 d)
                                                                                                                       └─► WS6 (stretch) cumulative snapshot for late joiners
```

| WS | Branch | Deliverable | Needs `@fabric/core` to test? | Ports from |
|---|---|---|---|---|
| WS1 | `feature/mesh-ingest-idempotent` | `source`-aware ids, `_ingestEvent()`, idempotent `POST …/events` + `POST …/<collection>` | **No** | `LiveRelay.js:124, 4418–4466`; `identity.js:54–68` |
| WS2 | `feature/mesh-module-skeleton` | `services/FabricSync.js` skeleton, identity file, settings, `/mesh` status, signed-envelope check on ingest, no-op-when-off tests | Only for the identity/signing tests (skipped otherwise) | `identity.js:40–120, 154–190, 191–300`; `LiveRelay.js:4334`; `FabricNetwork.js:346–400, 462–495` |
| WS3 | `feature/mesh-outbound-consent` | Peer roster model, `_canShareLogs`/`_logShareTargets`/`_logSharePublishOpts`, queue + flush + collection mapping | **No** (fake network injected) | `LiveRelay.js:2711–2735, 2748–2775, 10205–10247, 11211–11241` |
| WS4 | `feature/mesh-peer-transport` | Real Fabric `Peer` start/stop/dial, `SCEventBatch` publish + inbound dispatch → `_ingestEvent`, seeds, roster persistence | **Yes** (gated test) | `FabricNetwork.js:118–260, 427–495, 543–600, 654–760, 1106–1140, 1400–1403, 1609–1626`; `LiveRelay.js:128–131, 2371–2400, 3703, 8902–8921, 10061–10118` |
| WS5 | `feature/mesh-roster-ui` | `GET/POST/DELETE …/peers[/:id]`, global toggle, dashboard "🕸 Mesh" tab | No | `LiveRelay.js:6376–6412, 6790–6815, 6120–6135` |
| WS6 | `feature/mesh-snapshot` (stretch) | Periodic cumulative snapshot so a peer who joins late gets history, not just live events | Yes | `LiveRelay.js:4119–4135, 10254–10262` |

Each WS is one PR. Every PR: `npm test` green **with no Fabric installed** (the
CI/owner-machine baseline), plus the WS-specific gated test where applicable.

---

## 5. Workstreams in detail

### WS1 — Source identity + idempotent ingest (zero-dep; `feature/mesh-ingest-idempotent`)

**Why first:** `HANDOFF-master.md` §5 item 1 and `DESIGN-event-convergence.md`
§7 both name it as the de-risking first step; it benefits Fabric *and* the
existing POST seam; it needs no new dependency, so it can merge immediately.

**Files:** `app/server.js` (constructor, `_handle` collections block, new
`_ingestEvent`), `test/service.test.js`, `test/api.test.js`.

**Tasks**
- **T1.1** Add `canonicalStringify(value)` (pure, sorted keys — port
  `identity.js:54–60` verbatim) next to `idFor()`.
- **T1.2** Add
  `INGEST_COLLECTIONS = ['players','kills','deaths','incaps','vehicles','missionlog','crew','disconnects']`
  (target's actual collection names; drop the reference's
  `quantum/shipuse/chatmessages/missionbroadcasts`).
- **T1.3** Add `_ingestEvent(source, collection, data)` — port
  `LiveRelay.js:4418–4466` minus history fold: allowlist check (throw
  `{code:'BAD_COLLECTION'}`), `players` → `this.recordPlayer(data.name, ts)` +
  stamp `player.source`, otherwise
  `id = idFor(canonicalStringify({ source, collection, data }))`, `existed`
  check, store `Object.assign({ id, source }, data)`, emit `kill` for kills.
  **Adaptation:** for `missionlog`/`crew` events that carry `missionId`, also
  call `this._indexMission(Object.assign({}, data, { source }))` so peer
  missions appear in `missionGroups`; in `_indexMission` stamp
  `m.source = ev.source || null` and `m.player = ev.player || m.player` so
  `_analyticsDataset()` attributes to the peer's pilot, not `me`. Return
  `{ id, created: !existed }`.
- **T1.4** Route `POST …/events` (new) → `{ events: [{collection, data}] }` →
  loop `_ingestEvent(source, …)`; respond
  `{ type:'IngestResult', received, created, results }`. `source` =
  `body.source || 'http:' + req.socket.remoteAddress` in WS1 (unsigned —
  replaced by the verified pubkey in WS2). Gate the route behind
  `settings.ingest = { httpEnable: false }` default (env `SC_HTTP_INGEST=1`),
  returning 403 otherwise. Keep the existing per-collection `POST …/<name>`
  seam but switch its id to the same canonical form (drop `Date.now()`).
- **T1.5** Emit `this.emit('ingest', { source, received, created })` for
  observability (the dashboard monitor can show it later).

**Acceptance criteria**
- Posting the same `events` batch twice yields `created: 2` then
  `created: 0`; collection lengths unchanged on replay.
- A peer-sourced `deaths` event with `player:'PeerPilot'` appears in
  `GET …/analytics` under `PeerPilot`, not the local handle.
- A peer-sourced `missionlog` `mission:end` creates a `missionGroups` entry
  with `source` set and is not counted as the local pilot's mission.
- `POST …/events` returns 403 unless `ingest.httpEnable` is true; every
  existing test still passes.
- `git grep "require('@fabric" app/` returns nothing.

**Verify:** `npm test` (no Fabric installed). New tests in
`test/service.test.js` (`_ingestEvent` idempotency + attribution) and
`test/api.test.js` (`/events` round trip, 403 gate).

---

### WS2 — `FabricSync` module skeleton + identity + settings (`feature/mesh-module-skeleton`)

**Files:** new `services/FabricSync.js`, new `services/meshIdentity.js` (keep
separate from FabricSync — it is the only file that touches key material),
`app/server.js` (constructor seam + `/mesh` status route + `_checkEnvelope`
hook on `/events`), `settings/example.js`, `package.json` (script only),
`CONTINUE.md`, `test/mesh.test.js` (new).

**Tasks**
- **T2.1 Settings defaults** in constructor:
  `fabric: { enable: false, listen: true, port: 7777, interface: '0.0.0.0', peers: null, identityFile: null, shareLogsGlobal: false, uplinkIntervalMs: 5000 }`.
  Env mapping: `SC_FABRIC=1`, `SC_FABRIC_PORT`, `SC_FABRIC_PEERS` (comma list
  `host:port`), `SC_FABRIC_PASSPHRASE` (optional). Add the same to
  `settings/example.js`.
- **T2.2 Seam:**
  `this.fabric = enabled ? new FabricSync({ service: this, settings: this.settings.fabric, storeDir }) : null;`
  immediately after `this.cargoRouter`, with the same "remove this line + the
  routes + the panel to strip" comment. `start()`/`stop()`: `if (this.fabric) await this.fabric.start()`
  after the HTTP server is up; `if (this.fabric) await this.fabric.stop()`
  first in `stop()`.
- **T2.3 `services/meshIdentity.js`** — port from `functions/identity.js`:
  `canonicalStringify`, `payloadDigest`, `createIdentity`, `restoreIdentity`,
  `keyFromIdentity`, `masterKeyFromIdentity`, `signEnvelope`, `verifyEnvelope`,
  `encryptIdentity`, `decryptIdentity`, `pubkeysMatch` (inline the 3 functions
  from `@fabric/http/functions/fabricPubkey` — do not depend on
  `@fabric/http`). All `@fabric/core` requires (`types/key`,
  `types/identity`) **lazy inside functions**, guarded; export `available()` →
  boolean. **Adaptation:** `loadOrCreate(file, passphrase)` — if
  `stores/fabric-identity.json` exists, load (decrypt if passphrase); else
  create, write (encrypt if passphrase, else plaintext with
  `"warning": "plaintext key — set SC_FABRIC_PASSPHRASE"`), `chmod 600`
  best-effort. Never log the mnemonic/xprv.
- **T2.4 `services/FabricSync.js` skeleton** — `class FabricSync extends EventEmitter`
  with: constructor (settings merge; **no** Fabric require), `start()` (loads
  identity via T2.3; if `!meshIdentity.available()` → set `this.installed=false`,
  log the one-line hint, return), `stop()`, `status()` returning
  `{ enabled:true, installed, ready:false, pubkey, listenPort, connected:0, peers:[], shareLogsGlobal, shareLogsActive:false, uplinkQueued:0 }`.
  Consent/queue/transport methods are stubs that WS3/WS4 fill.
- **T2.5 Status route:** `GET …/mesh` → `this.fabric ? this.fabric.status() : { enabled:false }`
  (same 503-vs-disabled shape as `/cargo`). Add `meshEnabled: !!this.fabric`
  to the monitor snapshot next to `cargoEnabled`.
- **T2.6 Signed ingest:** port `_checkEnvelope` (`LiveRelay.js:4334–4346`)
  into `app/server.js` as `_checkEnvelope(envelope)` that delegates to
  `this.fabric ? meshIdentity.verifyEnvelope : null`. `POST …/events` now: if
  `this.fabric` → require `{ pubkey, payload:{events}, signature }`, 401 on
  missing/invalid, 403 if `settings.ingest.allowedKeys` set and not listed,
  `source = envelope.pubkey`; if `!this.fabric` → WS1 behaviour unchanged
  (documented as trusted-LAN only).
- **T2.7 `npm run fabric:install`** script (§2.3 item 1) + `CONTINUE.md`
  paragraph.

**Acceptance criteria**
- With `fabric` unset: `new StarCitizenService({...})` has
  `this.fabric === null`; `GET …/mesh` → `{ enabled:false }`; **no** `@fabric`
  module is in `require.cache` after constructing + starting + stopping the
  service. This is the "truly a no-op when disabled" proof.
- With `fabric: { enable:true }` and `@fabric/core` **not** installed:
  constructor and `start()` succeed; `status().installed === false`; one
  console hint; all other routes work.
- With `@fabric/core` installed (gated `SC_FABRIC_TEST=1`): `start()` creates
  `stores/fabric-identity.json` (or the `identityFile` path in a tmp dir),
  second start reloads the same `pubkey`; `signEnvelope`→`verifyEnvelope`
  round-trips; a tampered payload fails; encrypted file with passphrase does
  not contain the xprv in plaintext.
- `POST …/events` with a valid signed envelope → 200 and `source === pubkey`;
  unsigned → 401 when fabric is on.
- `npm test` green with no Fabric installed (gated tests report `skipped`,
  not failed).

**Verify:** `npm test`; then, on a machine with `npm run fabric:install` done,
`SC_FABRIC_TEST=1 node --test test/mesh.test.js`.

---

### WS3 — Outbound consent gate + queue + flush (`feature/mesh-outbound-consent`)

**Files:** `services/FabricSync.js`, `test/mesh.test.js`. No `@fabric/core`
needed — inject a fake `network` with
`publishEventBatch(events, sentAt, opts)`.

**Tasks**
- **T3.1 Peer roster model** — port `_normalizePeerRecord`
  (`LiveRelay.js:2711–2735`), keeping `expectedPubkey` (cheap, enables pinning
  later): `{ id: idFor(address), address:'host:port', label, enabled:true, shareLogs:false, expectedPubkey, lastSeen, lastError }`.
  Address validation: port `isFabricAddress`/`normalizeFabricAddress`/
  `isSelfFabricAddress` from `functions/fabricPeerHostLocal.js` (pure).
  Roster file `stores/fabric-peers.json`; `_persistPeers()` strips
  `lastSeen/lastError`.
- **T3.2 Consent gate** — port **verbatim** `_logShareTargets()` `:2748`,
  `_canShareLogs()` `:2757` (requires identity loaded **and** (global **or**
  any `enabled && shareLogs` peer)), `_logSharePublishOpts()` `:2768` (`null`
  = nothing authorized; `{}` = broadcast; `{ to:[addresses] }` = directed).
- **T3.3 Queue wiring** — port `_startFabricFlush()` `:10205–10247`. Subscribe
  on the **service** (`this.service.on(...)`): `kill`→`kills`,
  `player:death`→`deaths`, `player:incap`→`incaps`, `vehicle:destroy`→`vehicles`,
  `mission:event`→`missionlog`, `mission:crew`→`crew`,
  `session:disconnect`→`disconnects`, `player:join`→`players`
  (`{ name, timestamp: p.lastSeen }`). Every listener starts with
  `if (!this._canShareLogs()) return;`. Cap 5000 (shift oldest). Timer
  `settings.uplinkIntervalMs` (5000), `unref()`. **Do not** subscribe to
  `activity`/`event`/`notification`/`logs` — raw lines never leave the
  machine.
- **T3.4 Flush** — port `_flushUplink()` `:11211–11241`: no-op when queue
  empty or `opts === null`; require `network.ready && network.status().fabricConnected > 0`
  else keep queue; splice 200; `network.publishEventBatch(events, iso, opts)`;
  on success stamp matching peers' `lastSeen` and emit
  `uplink:sent {count, to}`; on throw `unshift` back (cap 5000), stamp
  `lastError`, emit `uplink:error`.
- **T3.5 Outbound payload hygiene** — strip fields that are local-only before
  queuing: `id` (receiver recomputes), `involves` (kills), `raw`. Keep
  `player`, `timestamp`, `kind`, `missionId`, `generator`, `completionType`,
  `playerId`, `bodyId`, `vehicle`, `cause`, `category`, `build`.

**Acceptance criteria (mirror `quantum-shipuse-share.test.js:49–98`)**
- Default (no roster, global off): after `handleLogChange` of a real death
  line + a real `mission:end` line, `fabric._uplinkQueue.length === 0` and
  `_canShareLogs() === false`.
- `shareLogsGlobal = true` + identity stub `{ pubkey:'test' }`: same two
  lines → queue length 2 with `collection` `deaths` then `missionlog`;
  `_logSharePublishOpts()` deep-equals `{}`.
- Global off, roster
  `[{address:'127.0.0.1:7801', shareLogs:true}, {address:'127.0.0.1:7802', shareLogs:false}]`
  → `_logSharePublishOpts()` deep-equals `{ to:['127.0.0.1:7801'] }`; with the
  first peer `enabled:false` → `null` and nothing queues.
- Fake network throwing once → events are requeued, `uplink:error` emitted,
  second flush succeeds and empties the queue; a fake
  `status().fabricConnected === 0` → nothing sent, queue intact.
- Queued payloads contain no `raw`/`involves` keys.

**Verify:** `npm test` (all of WS3 runs without Fabric).

---

### WS4 — Real Fabric Peer transport, two-node convergence (`feature/mesh-peer-transport`)

**Files:** `services/FabricSync.js` (transport section), new
`services/fabricPeerHost.js` (port of the reference's
`functions/fabricPeerHostLocal.js`), `test/mesh-peer.test.js` (gated).

**Tasks**
- **T4.1 Contract namespace decision (owner gate G2, §7):** the reference
  wraps batches as
  `CONTRACT_MESSAGE { contract: gooncitizenContractId(), type:'SCEventBatch', actor:{publicKey,id}, object:{events,sentAt} }`
  (`FabricNetwork.js:1609–1626`). **Option A (interop):** copy the
  `contracts/gooncitizen.js` definition so our batches are readable by
  GoonCitizen/`relay.goon.vc` peers. **Option B (private):** define
  `contracts/starcitizenlive.js` with our own definition → our own contract
  id; upstream nodes ignore us, we ignore them. **Default if unanswered: B**
  (privacy-first, matches D-008's consent stance); make it a one-constant
  switch.
- **T4.2 Peer start** — port `_startInner()` `FabricNetwork.js:654–700`
  minimal: `const Peer = require('@fabric/core/types/peer')`;
  `new Peer({ listen, port, interface, peers: roster addresses, peersDb: null, networking:true, reconnectToKnownPeers:false, listenPortAttempts:20, key:{ xprv: masterKeyFromIdentity(identity).xprv }, upnp:false, constraints:{ peers:{ max: 32 } } })`;
  forward `error/warning/ready/connections:open/connections:close/peer:self`.
  `ready` getter = `peer && identity && peer.key`. `status()` fills
  `fabricConnected = Object.keys(peer.connections).length`,
  `fabricPeerId = peer.key.pubkey`.
- **T4.3 Publish** — port `_signMessage`/`_signAndRelay` (`:543–590`) +
  `_publishContractMessage` (`:1609`) + `publishEventBatch` (`:1400`):
  broadcast via `peer.relayFrom(null, msg)`; directed via iterating
  `peer.connections` with `connectionMatchesAddress` (`:533`) and
  `_writeFabric(buf)`.
- **T4.4 Inbound** — port `attachAppHandlers` subset (`:118–124, 161–178,
  222–223`): `peer.on('contract:message', ev)` → if
  `ev.contract === OUR_CONTRACT_ID && body.type === 'SCEventBatch'` →
  `onEventBatch(object, signer, meta)` → loop `object.events` into
  `this.service._ingestEvent(signer, ev.collection, ev.data)`, count
  `created`, emit `ingest {source, received, created, via:'fabric'}`, stamp
  peers' `lastSeen`. Optional allowlist: if `settings.fabric.allowedKeys`
  non-empty and `signer` not listed (via `pubkeysMatch`) → drop + `warning`.
- **T4.5 Dial management** — port `setPeers()` (`:427–460`) for roster
  changes at runtime; `stop()` (`:1106–1131`) — destroy raw inbound sockets,
  `peer.stop()`, null out.
- **T4.6 Seeds + first-boot roster** — port `DEFAULT_PEERS`
  (`LiveRelay.js:128–131`: `hub.fabric.pub:7777`, `relay.goon.vc:7777`) and
  the `_loadPersistedSettings` roster rules (`:2375–2389`): explicit
  `peers: []` ⇒ empty roster (tests); persisted file wins; first boot with
  nothing ⇒ seed hubs **with `shareLogs:false`** (hubs are transport only;
  consent still per-peer). Self-dial filter via `isSelfFabricAddress`.
- **T4.7 Gated two-node test** — model on `fabric-peer.test.js:115–187` but
  for events: node B `fabric:{enable:true, listen:true, port:PB, peers:[]}`;
  node A `peers:[{address:'127.0.0.1:PB', shareLogs:true}]`; wait for both
  `ready` and `fabricConnected >= 1`; `A.handleLogChange(<real death line>)`;
  `A.fabric._flushUplink()`; wait for
  `B.deaths.length === 1 && B.deaths[0].source === A.fabric.pubkey`; flush
  again → still 1 (idempotent over the wire). Second case: A's peer record
  `shareLogs:false` → after two flush cycles B has 0. **Gate:** `test.skip`
  unless `process.env.SC_FABRIC_TEST === '1'` **and**
  `require.resolve('@fabric/core')` succeeds. Timeout ≤ 20 s, random high
  ports. Always `stop()` both in `finally`.

**Acceptance criteria**
- On a zero-dep checkout `npm test` is green and `test/mesh-peer.test.js`
  reports skipped.
- With Fabric installed and `SC_FABRIC_TEST=1`: the two-node death event
  converges A→B with `source` = A's pubkey; replay is idempotent;
  `shareLogs:false` sends nothing; B→A does not happen unless B's roster
  grants it (consent is per-direction).
- `GET …/mesh` on a running node shows `ready:true`, `fabricConnected`,
  `pubkey`.
- Killing the peer process on B does not crash A (A logs
  `uplink:error`/warning, keeps queue).

**Verify:** `npm test` (baseline) then
`SC_FABRIC_TEST=1 node --test test/mesh-peer.test.js` — **run by the
orchestrator in the foreground with a timeout, never as a detached background
process** (§0 rule 3).

---

### WS5 — Roster REST + dashboard "Mesh" tab (`feature/mesh-roster-ui`)

**Files:** `app/server.js` (routes), `app/ui.html` (new tab, same pattern as
the 🚚 Cargo tab), `test/api.test.js`.

**Tasks**
- **T5.1 Routes** (503 `{enabled:false}` when `!this.fabric`, same as cargo):
  `GET …/peers` (roster with status), `POST …/peers`
  `{address,label,enabled,shareLogs,expectedPubkey}` (validate `host:port`,
  refuse self, refuse duplicate), `GET/POST/DELETE …/peers/:id` (POST toggles
  `enabled/label/shareLogs`), `POST …/mesh/settings` `{ shareLogsGlobal }`.
  Each mutation → `_persistPeers()` + `fabric.setPeers(...)`.
- **T5.2 UI tab "🕸 Mesh":** status strip (pubkey short, listen port,
  connected count, queued), roster table with **per-peer "share my events"
  checkbox** (this *is* the consent UI), add-peer form, a global "share with
  all connected peers" toggle defaulting off with explicit warning copy, and
  a "shared by \<label\>" badge on peer-sourced rows elsewhere (Analyze pilot
  list, mission cards) — honesty rule.
- **T5.3** Monitor snapshot: `mesh: { enabled, ready, connected, queued, shareLogsActive }`.

**Acceptance criteria**
- `POST …/peers` then `POST …/peers/:id {shareLogs:true}` flips
  `fabric._logSharePublishOpts()` from `null` to `{to:[address]}` without
  restart; DELETE returns it to `null`.
- Duplicate/self/invalid addresses → 400 with clear messages.
- With `this.fabric === null` every `/peers*` route → 503 `{enabled:false}`;
  UI tab hidden when `meshEnabled` is false (as cargo does).

**Verify:** `npm test` (HTTP tests run against a `FabricSync` with the WS3
fake network — no Fabric needed).

---

### WS6 — Stretch: cumulative snapshot for late joiners (`feature/mesh-snapshot`)

Live batches only cover events after both peers are up. The reference solves
"I joined the mesh after you flew" with a periodic `GameStateSnapshot`
(`LiveRelay.js:4119–4135` publish, `_maybePublishGameState` `:10254–10262`,
60 s min interval, same consent gate) folded on receipt. Port only if the
owner wants history convergence; otherwise `npm run backfill` + WS1's
`/events` remains the history path. **Not required for D-008.**

---

## 6. Sequencing recommendation

1. **Build WS1 first, alone, and merge it.** Zero-dep, small, reviewable in
   minutes, and it is the piece every later phase (and the existing POST
   seam) depends on. It also lets the owner see peer attribution in the
   Analyze tab via plain HTTP before any Fabric is installed.
2. **WS2 → WS3 strictly sequential** (WS3 needs the module + identity stub
   from WS2). Both are testable with no Fabric installed, so they can land
   on the owner's machine without the 400 MB install.
3. **WS4 is the only phase that needs `npm run fabric:install`** and the
   only one with a network test. Gate it on **G1** (Node version compatible —
   verify on the owner's PC first) and **G2** (contract namespace A/B).
4. **WS5 can run in parallel with WS4** once WS3 is merged (routes/UI only
   touch the roster model and fake network). Two sub-agents in separate
   worktrees is fine.
5. **WS6 only after WS4 is proven end-to-end** on two real machines, and only
   on request.

---

## 7. Gates (D-006 — owner answers before the relevant workstream starts)

| Gate | Question | Blocks | Default if unanswered |
|---|---|---|---|
| G0 | Owner go-ahead per workstream | all | stop and wait |
| G1 | Does `@fabric/core#feature/rsi` install and load on the owner's Windows PC with the Node version there? (`npm run fabric:install && node -e "require('@fabric/core/types/peer')"`) | WS4 | If it fails, WS1–WS3 + WS5 still ship; report the failure verbatim |
| G2 | Contract namespace: interop with GoonCitizen id (A) or private id (B)? | WS4 T4.1 | B (private) |
| G3 | Identity at rest: plaintext-in-`stores/` by default with optional `SC_FABRIC_PASSPHRASE`, or passphrase mandatory? | WS2 T2.3 | plaintext + loud warning (headless relay; matches "secrets via env") |
| G4 | Dependency declaration: script-only (`fabric:install`) vs `optionalDependencies` | WS2 T2.7 | script-only |

---

## 8. Open risks / unknowns (stated, not guessed)

1. **Install weight of `@fabric/core` alone was not independently measured
   against this exact target.** Spike numbers (~400 MB, 728 pkgs) were for
   core+hub together. Core's own manifest (35 deps incl. `zeromq`, `level`,
   `redis`, `ts-morph`, `node-gyp`, `blessed`) means it is still heavy and
   includes native prebuilds. Measure at G1.
2. **Node version compatibility.** Reference pins Node 24; target promises
   18+. `level@10`, `zeromq@6.5`, `@noble/curves@2` may require ≥ 20.
   Unverified.
3. **Git dependency on a moving branch (`#feature/rsi`) with `allow-git`** —
   reproducibility risk; consider pinning to a commit SHA once G1 passes.
4. **Whether public seed hubs (`hub.fabric.pub`, `relay.goon.vc`) relay a
   *private* contract id (G2 option B).** The reference's
   `relayAppMessages` flag and `isKnownAppRelayType` suggest hubs filter by
   known app types; a private namespace may only work between peers that
   dial each other directly (LAN/port-forward). NAT traversal beyond what
   Fabric's own seed hubs solve is not addressed by this plan — the
   `DESIGN-distributed.md` §7 "honest hard parts" still apply where it does.
5. **`peersDb: null`** — `types/peer.js:116` requires `level` at load even
   when `peersDb` is null; confirm the `Peer` constructor tolerates `null`
   without creating a LevelDB (the reference tests pass `peersDb: null`, so
   likely yes, but not independently re-confirmed here).
6. **Directed sends (`{to}`) depend on private Peer internals**
   (`connections[id]._writeFabric`, `_upsertPeerRegistry`, `_connect`) —
   these are underscore-prefixed in `@fabric/core` and could change on the
   `feature/rsi` branch. Pin the SHA (item 3).
7. **Identity model is heavier than needed** (BIP39 mnemonic + HD xprv)
   because `Peer` derives its key from an xprv. A raw-seed path exists
   (`identity.js:89–108` `looksLikeRawSeedHex`/`xprvFromRawSeedHex`) if the
   owner prefers a simpler file.
8. **`_indexMission` attribution change (T1.3)** touches a path shared with
   the crew/party feature and the mission-stats counters — run
   `test/service.test.js` and `test/corpus.test.js` specifically after WS1;
   do not let a peer mission's `source` leak into local-only counters
   (`missionStats()`).
9. **Mission register remains single-home by design** — this plan does not
   replicate `MissionManager` state; two members each running
   `missions.enable:true` will have two independent registers. That is the
   status quo (D-005, unchanged by D-008), but WS5's UI should say so
   explicitly to avoid implying the register is shared.
10. **The reference's `fabric-peer.test.js` binds real TCP ports and takes
    seconds to converge** — this is the class of test a prior planning
    attempt tried to run live in the background and stalled on. Under this
    plan it is only *read* for the pattern; WS4's actual port (T4.7) is run
    once, foreground, gated, by the orchestrator (§0 rule 3).
