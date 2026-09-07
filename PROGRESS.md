# Progress & Retrospective Log

A running, plain-English trail of what's been done, what we learned, and what's
next. Each milestone closes with a short retro. Newest at the top.

> **Planning (2026-06-13):** direction set for the next phase — see `SOLUTION-BRIEF.md`
> (product overview), `DECISIONS.md` → **D-005**, and `DESIGN-missions-mvp.md` (M5
> technical plan). Next build: **M4** (deploy) → **M5** (officer-validated mission
> register) → **M6** (roles + signed audit).

---

## 🔗 WS1 — Idempotent, source-attributed ingest ✅
**Date:** 2026-09-04 · branch `feature/mesh-ingest-idempotent` · first workstream of `BUILD-PLAN-fabric-mesh.md` (D-008)

Zero-dependency prerequisite for the Fabric mesh backbone, buildable and useful
on its own: `canonicalStringify()` + `_ingestEvent(source, collection, data)`
give every ingested event a **stable id** (`idFor(canonicalStringify({source,
collection, data}))`), so re-delivering the same event is a safe no-op
(`created: false`) instead of a duplicate — the single de-risking step
`DESIGN-event-convergence.md` §7 and `HANDOFF-master.md` §5 named first.

- New `POST …/events` (bulk, off by default — `SC_HTTP_INGEST=1`): accepts
  `{ source, events: [{collection, data}] }`, returns per-event
  `{id, created}`. Unsigned/trusted-LAN only until WS2 adds envelope
  verification.
- The existing per-collection `POST …/<name>` seam (players/vehicles/kills/
  missionlog) now routes through the same idempotent path — `activities`
  deliberately excluded (a local pass-through record, not part of the peer
  model).
- Peer-sourced `missionlog`/`crew` events fold into `missionGroups` via the
  existing `_indexMission()`, stamped with `source` and attributed to the
  *sender's* player, never silently defaulted to the local pilot — a peer's
  mission or crew sighting now shows up correctly in `_analyticsDataset()`
  under their own name.
- `INGEST_COLLECTIONS` allowlist: `players, kills, deaths, incaps, vehicles,
  missionlog, crew, disconnects`.

9 new tests (6 unit + 3 API round-trip/idempotency/403-gate), full suite
122/122 green. `git grep "require('@fabric" app/` confirms zero footprint —
this workstream needs no new dependency at all.

Next: WS2 (`FabricSync` module skeleton + identity), per
`BUILD-PLAN-fabric-mesh.md`.

---

## 🪪 WS2 — Mesh identity + FabricSync skeleton + signed-envelope verification ✅
**Date:** 2026-09-04 · branch `feature/mesh-identity-fabricsync` (stacked on `feature/mesh-ingest-idempotent`) · second workstream of `BUILD-PLAN-fabric-mesh.md` (D-008)

Ported from the proven reference (`martindale-star-citizen-live @ feat/op-participation`,
`functions/identity.js` + `@fabric/http`'s `fabricPubkey.js`), read line-for-line
before writing any of this, per the repo's "verify against real source" rule.

- New `services/meshIdentity.js`: `createIdentity`/`restoreIdentity` (BIP39
  mnemonic → keypair), `signEnvelope`/`verifyEnvelope` (Schnorr, digest over
  `canonicalStringify(payload)` so a tampered payload fails verification even
  with a stale signature), `encryptIdentity`/`decryptIdentity` (scrypt +
  AES-256-GCM, **Node `crypto` only — no Fabric dependency for this half**),
  `pubkeyXOnly`/`pubkeysMatch` (inlined from `@fabric/http` — confirmed pure/
  tiny, so this file never depends on the `@fabric/http` package, which drags
  puppeteer/express/jsdom), and `available()`/`loadOrCreate()`. Every
  `@fabric/core` require is **lazy, inside a function body** — `git grep` and
  a bare `node -e "require('./services/FabricSync')"` both confirm nothing
  Fabric-related loads until a keypair is actually needed.
- New `services/FabricSync.js`: strippable exactly like `CargoRouter` —
  `this.fabric = settings.fabric.enable ? new FabricSync(...) : null`.
  `start()` creates/loads an identity (`stores/fabric-identity.json`,
  optionally encrypted via `SC_FABRIC_PASSPHRASE`) and degrades to
  `installed:false` instead of throwing when `@fabric/core` isn't installed.
  `checkEnvelope(envelope, allowedKeys)` mirrors the reference's
  `_checkEnvelope` shape (`{ok, code, error}`) exactly, so `app/server.js`
  uses it directly with no translation. No real peer transport yet — that's
  WS4.
- `app/server.js`: `this.fabric` constructor seam + lifecycle hooks; new
  `GET …/mesh` status route (`{enabled:false}` when off); `POST …/events`
  now also accepts a **signed envelope** (`{pubkey, payload:{events},
  signature}`) — verified via `this.fabric.checkEnvelope()`, with `source`
  becoming the *verified* sender pubkey — alongside WS1's original unsigned
  `{source, events}` shape (now refusable via `ingest.requireSigned`).
  `monitor` snapshot gained `meshEnabled`.
- `npm run fabric:install` (opt-in `@fabric/core` only — not the whole Fabric
  stack); `settings/example.js` + `CONTINUE.md` document the new envs
  (`SC_FABRIC`, `SC_FABRIC_PORT`, `SC_FABRIC_PEERS`, `SC_FABRIC_PASSPHRASE`,
  `SC_HTTP_INGEST_REQUIRE_SIGNED`, `SC_HTTP_INGEST_ALLOWED_KEYS`).

13 new tests (`test/mesh.test.js`): zero-dep-on-require proof, identity
round-trips, envelope shape/roster rejection, `/mesh` status with Fabric on
and off, the WS1-regression check, and a real signed-envelope round trip
that's conditionally skipped (`{skip: !meshIdentity.available()}`) since
`@fabric/core` isn't installed in this environment. Full suite: 135/135
(134 pass, 1 skipped as expected).

Next: WS3 (outbound consent gate + queue + flush), per
`BUILD-PLAN-fabric-mesh.md`.

---

## 📤 WS3 — Outbound consent gate + peer roster + queue/flush ✅
**Date:** 2026-09-04 · branch `feature/mesh-outbound-consent` · third workstream of `BUILD-PLAN-fabric-mesh.md` (D-008)

Ported from the proven reference (`_normalizePeerRecord`, `_logShareTargets`/
`_canShareLogs`/`_logSharePublishOpts`, `_startFabricFlush`/`_flushUplink` —
`LiveRelay.js:2711–2775, 10205–10247, 11211–11241`, read before writing this).
Runs with **no `@fabric/core` installed at all** — the whole point of this
workstream — driven by an injected `network` test double
(`{ready, status(), publishEventBatch()}`); WS4 swaps in the real one.

- New `services/fabricAddress.js`: a trimmed, pure port of the reference's
  `functions/fabricPeerHostLocal.js` — `isFabricAddress`/
  `normalizeFabricAddress`/`isSelfFabricAddress` and their helpers. Node
  built-ins only (`os`, `dns`); deliberately doesn't port the hub-alias
  rewriting or app-relay-type catalog (out of scope for the roster/consent
  work — pull them in later if a workstream actually needs them).
- `services/FabricSync.js` gained: a **peer roster** (`_normalizePeerRecord`,
  persisted to `stores/fabric-peers.json` stripped of the volatile
  `lastSeen`/`lastError` fields, seeded from `settings.fabric.peers` on first
  run), the **consent gate** (`_canShareLogs`/`_logShareTargets`/
  `_logSharePublishOpts` — identity unlocked **and** (global **or** any
  enabled+consenting peer), ported near-verbatim), the **outbound queue**
  (subscribes to the service's own `kill`/`player:death`/`player:incap`/
  `vehicle:destroy`/`mission:event`/`mission:crew`/`session:disconnect`/
  `player:join` events — deliberately **not** the raw `activity`/`event`/
  `notification`/`logs` streams, so a raw log line never leaves the
  machine), and **flush** (`_flushUplink`: no-op until authorized *and*
  connected, batches 200, requeues + emits `uplink:error` on a publish
  failure, stamps peer `lastSeen` + emits `uplink:sent` on success).
  Outbound payload hygiene strips `id`/`raw`/`involves` before queuing (a
  denylist, not an allowlist, so an unanticipated field still reaches a
  consenting peer instead of silently vanishing).
- `status()` now reports live `shareLogsActive`, the real roster, and
  `connected` from the injected network.

8 new tests in `test/mesh.test.js`: address-helper round trips, roster
normalization (malformed + self-dial rejection), roster persistence across
two `FabricSync` instances, the real-log-line default-off case, the
real-log-line `shareLogsGlobal` broadcast case, a per-peer directed-roster
case, outbound hygiene, and a fake-network flush test covering
throw→requeue→retry-clean and a "nothing connected" hold. Full suite:
**143/143** (142 pass, 1 skipped as expected — the WS2 real-keypair test,
no `@fabric/core` here).

Next: WS4 (real `@fabric/core` Peer transport, two-node convergence — the
only phase needing Fabric actually installed; run its gated network test in
the foreground only, never detached, per this plan's own §0 lesson), per
`BUILD-PLAN-fabric-mesh.md`.

---

## 🕸️ WS4 — Real Fabric Peer transport, two-node convergence ✅
**Date:** 2026-09-04 · branch `feature/mesh-peer-transport` · fourth workstream of `BUILD-PLAN-fabric-mesh.md` (D-008)

The one workstream that actually needs `@fabric/core` installed. **Gate G1
answered first** (owner approved "try the install now"): `npm run
fabric:install` → 140 packages, ~96 MB, ~1 min (not the ~400 MB spike number
— that was core+hub together); one benign `EBADENGINE` patch-version
warning; `require('@fabric/core/types/peer')` loads; `npm audit` clean.
Pinned to commit `047210f33ff6e3a84528074a0b375bc3c8a3bdc8` instead of the
moving `#feature/rsi` branch tip, per the plan's own reproducibility
recommendation. **G2 answered by the stated default** (B — private contract
namespace, unchallenged).

- New `contracts/starcitizenlive.js` (G2/T4.1): our own deterministic
  contract id (`new Actor(definition).id`, same mechanism the reference uses
  for its shared GoonCitizen namespace) — `hub.fabric.pub`/`relay.goon.vc`
  are dialed as transport-only seed hubs, never as an app-message peer.
- `services/FabricSync.js` gained the real transport: `_startPeer()` (a real
  `@fabric/core` Peer, dialing the roster + optionally listening),
  `_publishContractMessage`/inbound `_onContractMessage` (signed
  `CONTRACT_MESSAGE`/`SCEventBatch`, broadcast via `peer.relayFrom` or
  directed via `connections[id]._writeFabric`), `_stopPeer`/`_dialAddresses`
  (T4.5), and first-boot seed-hub rostering (T4.6, `shareLogs:false` —
  transport only, never auto-authorized). The real transport satisfies the
  exact same `network` facade (`ready`/`status()`/`publishEventBatch()`) WS3
  already built `_flushUplink()` against, so the flush loop needed zero
  changes. **Real transport is opt-in via a NEW, separate
  `settings.fabric.startPeer` flag (off by default)** — deliberately kept
  independent from `fabric.enable` (identity + consent/queue) specifically
  so every existing WS2/WS3 test stays exactly as side-effect-free as
  before, even now that `@fabric/core` is actually installed in this
  environment; only an explicit `startPeer:true` (the production CLI when
  `SC_FABRIC=1`, and WS4's own gated test) ever opens a real socket.
- **A real bug, caught only by actually running the gated two-node test
  against the real library** (not by code review or trusting the
  reference's own pattern): `contract:message`'s `ev.signer` is the
  cryptographically-recovered pubkey in **x-only form** (compressed minus
  its `02`/`03` prefix byte), not the full compressed key the reference's
  own `ev.signer || actorPubkey(body)` fallback chain assumes. Fixed by
  verifying the body's claimed `actor.publicKey` against `ev.signer` via
  `meshIdentity.pubkeysMatch()` (x-only-tolerant) before trusting it, and
  falling back to the verified x-only value when a body's claim doesn't
  match — so attribution stays anchored to what the signature actually
  proved and can never be spoofed by a peer just writing a different key
  into the message body. See `BUILD-PLAN-fabric-mesh.md` §8 item 6 for the
  writeup — this is exactly the class of finding G1's "verify before
  building on it" gate exists to catch.
- A second, quieter bug: seeding the roster with the default hub addresses
  (T4.6) when no `peers` setting is given meant several pre-existing WS2/WS3
  tests (which only isolated `identityFile`, not `peersFile`) started
  writing a real `stores/fabric-peers.json` into the actual project
  directory on every `npm test` run once Fabric was actually installed.
  Fixed by isolating `peersFile` in those tests too, and cleaned up the
  stray (gitignored, never-committed) file.

Tests: 1 new fast unit test in `test/mesh.test.js` (`_onContractMessage`
attribution — the x-only/compressed/spoofed-claim cases, gated on
`@fabric/core` being installed) + a new gated `test/mesh-peer.test.js` (2
tests, `SC_FABRIC_TEST=1` + `@fabric/core` required): a real two-node death
event converging A→B with correct attribution, wire idempotency on replay,
a dead-peer-doesn't-crash-the-flush-loop check, and a `shareLogs:false`
peer receiving nothing across two flush cycles despite being connected.
Both gated tests run **in the foreground with a bounded timeout**, per §0's
rule — never as a detached process. Full suite: **146/146** (144 pass, 2
gated-skip on plain `npm test`; both gated tests pass for real under
`SC_FABRIC_TEST=1 node --test test/mesh-peer.test.js`).

Next: WS5 (roster REST + dashboard "Mesh" tab) — can proceed without
further Fabric gates, since it only touches the roster model + the WS3 fake
network. Per `BUILD-PLAN-fabric-mesh.md`.

---

## 🕸️ WS5 — Roster REST + dashboard "Mesh" tab ✅
**Date:** 2026-09-04 · branch `feature/mesh-roster-ui` · fifth (and final planned) workstream of `BUILD-PLAN-fabric-mesh.md` (D-008)

The consent UI itself — the whole reason the roster/consent-gate work in
WS3/WS4 exists. No further Fabric gates needed (routes/UI only touch the
roster model, testable against WS3's fake network with no `@fabric/core`
install required).

- `services/FabricSync.js` gained `getPeer`/`updatePeer`/`removePeer` —
  `updatePeer` pins the address (a consent/metadata toggle, not an address
  edit) and dials immediately if the update just enabled a peer.
- New REST (`app/server.js`, 503 `{enabled:false}` when `!this.fabric`, same
  pattern as Cargo): `GET/POST …/peers`, `GET/POST/DELETE …/peers/:id`,
  `POST …/mesh/settings`. Validates the address, refuses a self-dial and a
  duplicate with clear 400s (reusing `services/fabricAddress.js` directly —
  zero-dep, safe to require unconditionally). `monitor` snapshot gained a
  `mesh: {enabled, ready, connected, queued, shareLogsActive}` summary (T5.3).
- New "🕸 Mesh" dashboard tab (`app/ui.html`, same show/hide-by-`*Enabled`
  pattern as 🚚 Cargo): a status strip, a global "share with all connected
  peers" toggle (off by default, explicit warning copy), an add-peer form,
  and a roster table with a **per-peer "share my events" checkbox — this is
  the actual consent UI**. Mission cards gained a "📡 shared by …" badge
  when `m.source` is a peer, resolved to that peer's label where known
  (honesty rule, T5.2) — scoped to mission cards for this pass; the
  Analyze-tab pilot list wasn't touched, to avoid a larger, more invasive
  change to that heavily cross-filtered rendering code.
- Found and fixed a real scoping bug before it shipped: the mesh JS was
  first written inside the Analyze tab's own IIFE, where `renderMissions()`
  (a top-level function, like `$`) couldn't reach it — moved to top level,
  matching how every other cross-tab helper in this file already works.

**Verified against the real, running relay** (`SC_FABRIC=1`, real seeded
history from the actual `Game.log`) — not just the test suite: the mesh tab
showed a real identity, real listen port, and `connected: 2` against the
**actual public seed hubs** (`hub.fabric.pub`, `relay.goon.vc` — this relay
really reached the real Fabric network). Toggling a peer's "share my
events" checkbox flipped `shareLogsActive` live over the real API, exactly
as designed. Caught a near-miss during this same check: briefly turning
consent on for `hub.fabric.pub` on a real instance seeded with real
gameplay history is exactly the action a user takes to actually start
sharing - confirmed `uplinkQueued` stayed `0` throughout (no live game
session was appending new events in that window) before immediately
reverting the toggle and stopping the preview. No real data left this
machine, but it's a sharp reminder of what this UI actually does once real
consent is granted.

Tests: 5 new in `test/api.test.js` (503-gating, address validation/self-dial/
duplicate rejection, live consent-flip via `POST …/peers/:id` then `DELETE`,
`shareLogsGlobal` flip, monitor's mesh summary on and off). Full suite:
**151/151** (149 pass, 2 gated-skip on plain `npm test`).

This completes the planned Fabric-mesh build plan (WS1–WS5); WS6 (cumulative
snapshot for late joiners) remains optional, "port only if the owner wants
history convergence" per the plan.

---

## 👥 Crew/party tracking — PlayerJoined + player_id directory ✅
**Date:** 2026-08-28 · branch `feature/crew-party`

Shipped the crew/party idea (evidence-counted at 165 real corpus files on a sweep
done on `feature/cargo-router`'s not-yet-merged `BACKLOG.md`; flagged there as
*"Strategic — directly feeds the M4 org-wide convergence model"*), per
`DESIGN-event-convergence.md`'s existing shape: group by shared `mission_id` across
sources. New VERIFIED parser
rule `mission:crew` reads the log's one genuine cross-player line — `<PlayerJoined>
... mission_id <guid> - player_id <num>` — which carries a numeric id only, no
handle. Resolved via a `{ playerId -> handle }` directory built from `mission:end`'s
`Player[]`/`PlayerId[]` pairing (the one place the log ties a handle to that same
numeric id, always for the running player). `scripts/backfill.js` now aggregates
this directory **org-wide**, across every pilot's log in the corpus — so a
teammate's crew sighting resolves to a real name once *they've* ever backloaded or
run the relay, even if you've never seen their own `mission:end` yourself. An
unresolved id falls back to an honest `Pilot #<last4>` tag, never a guess.

`missionGroups` now carries a resolved `crew` array per mission; the dashboard
mission cards show a "👥 with …" line. Verified against the real DeadMan corpus
(25 Mar 2026 log): 22 missions, 15 with real crew data, confirmed both via the live
`/services/star-citizen/missiongroups` API and the rendered UI chips. 8 new tests
(parser + service + backfill + a corpus sanity check), full suite 64/64 green.

Scope note: this ships the whole relay-side vertical slice (parse → fold → resolve
→ REST + UI). Feeding crew into the Analyze/analytics dataset is a natural,
separable follow-up — not built here.

---

## 🔎 Sourced issuer→type fallback — type-"Other" 45% → 14% ✅
**Date:** 2026-06-19 · branch `feature/faction-dimension`

Researched GitHub + the web (SC Wiki API, starcitizen.tools, StarStrings — logged in
`REFERENCES.md`) to classify the issuer-only generator codenames that had no activity
verb. Added a sourced `FACTION_TYPES` fallback in `missionType()`: when the activity
rules don't match, fall back to the contract issuer (CleanAir→Event, Vaughn→Bounty,
InterSec/Foxwell→Mercenary/Defense, Shubin→Mining, Hockrow/Adagio/TarPits→Recovery,
FTL→Hauling, UnitedWayfarersClub→new "Support"). `Unaffiliated`/`GoblinG` left as Other
(no authoritative source — no guessing). After re-backfill: **type-"Other" fell from
~45% to 14%** (3,857 missions), the residue being genuinely issuer-only/no-generator.
Tagged "verified ~4.8.0" — SC content is patch-volatile. Suite green (**57 tests**).

---

## 🏷️ Faction dimension — "By faction" panel + slicer ✅
**Date:** 2026-06-19 · branch `feature/faction-dimension`

Split the contract **issuer** out as its own dimension instead of cramming faction
names into the activity-type list. `missionFaction(generator)` takes the generator
codename's leading token (`<Faction>_<Activity>`) and prettifies it (`HockrowAgency`
→ "Hockrow Agency"); `Unknown` when no generator was captured. Added:
- **"By faction" panel** (outcome-segmented bars per contractor — CleanAir, Adagio,
  HeadHunters, InterSec…) + a **faction multi-select slicer**; clicking a row filters.
- Faction now flows through `scripts/backfill.js` → `stores/history.json` and the
  `/analytics` payload (history + live), and cross-filters every panel.
- Also folded the **safe activity patterns** into `missionType()` (StationAssault/
  ShipWaveAttack/HeadHunters → Bounty; MissingPerson → Recovery; Courier → Hauling),
  shrinking type-"Other" without overloading it — the org-name generators are now
  explained by the faction view rather than dumped in "Other".

Zero deps, JS syntax-checked, suite green (**56 tests**, incl. `missionFaction` +
new type-pattern cases). History re-backfilled to populate faction.

Reworked the Analyze slicers from single-select to **multi-select**: pilot, mission
type, and outcome are now Sets (toggle several at once; "All" clears). Period gained
a **from→to range chooser** (two dropdowns) replacing the fixed per-year toggle, and
the month chips remain as fine multi-select toggles. Clicking the donut, a type bar,
or a pilot row now toggles that value in its multi-select (cross-filter). The
**Pilot comparison** scorecard now respects the pilot multi-select, so you can
compare a chosen subset of pilots ("compare by user"). Every panel + the
vs-prior-period deltas recompute client-side. Pure UI; JS syntax-checked; zero deps;
suite green (**55 tests**). Merged to trunk on owner instruction.

---

## ⚖️ Pilot-comparison panel + branch ready for review ✅
**Date:** 2026-06-19 · branch `feature/death-and-mission-lifecycle`

Added a **Pilot comparison** scorecard to the Analyze tab — per-pilot completion
rate (with bar), missions, sessions, deaths and deaths/session, side by side over
the selected months/type (ignores the single-pilot filter; needs ≥2 pilots). With
the backfill corpus it's real now (DeadMan1227 / Fadingdoughnut0 / Kersa). Pure
client SVG/HTML, no server change. Suite green (**55 tests**).

This closes out the analytics feature set on this branch. Flagged for review in
`REVIEW.md` (proposed merge into `feature/fabric-free-m1`, the fork trunk — no
`main` exists on the remote). Owner opens the PR + merges after Codex's pass
(`gh` isn't installed here, so the PR is opened from the browser/owner side).

---

## 🗄️ Historic backfill + month/year time slicer ✅
**Date:** 2026-06-19 · branch `feature/death-and-mission-lifecycle`

The Analyze tab now spans **real history**, not just the current session. Added
`npm run backfill` (`scripts/backfill.js`): it scans saved logs (the game's own
`logbackups` across channels + any `./Gamelogs` corpus), attributes each to its
pilot via the login handle, and writes a compact `stores/history.json` (gitignored)
— only ended missions, deaths, sessions and a per-month day×hour activity histogram,
never raw lines, so it stays small over gigabytes. First run: **1,525 logs /
85.7M lines → 3,843 missions, 2,980 deaths, 3 pilots (DeadMan1227, Fadingdoughnut0,
Kersa), 10 months (Aug 2025–Jun 2026)**.

The server loads that history on start and `GET …/analytics` now returns the merged
history+live dataset (availableMonths, missions, deaths, sessions, heatcells, pilots).
The dashboard's time control became a **month/year add-remove selector** — toggle
whole years or individual months; every panel + the vs-prior-period deltas recompute
client-side. Suite green (**55 tests**, incl. a backfill unit test). The corpus
makes the multi-pilot leaderboard real *now* — a preview of the org-wide view (M4).
Note: `history.json` aggregates other members' uploaded logs and is **gitignored**
(never pushed).

---

## 📊 "Analyze" dashboard tab — slice-and-dice activity view ✅
**Date:** 2026-06-18 · branch `feature/death-and-mission-lifecycle`

Added a second dashboard tab (Live feed / Analyze) for analysing activity, backed
by a new pre-aggregating `GET …/analytics?days=N` endpoint (real in-memory data,
zero deps). Panels: KPI strip (active pilots, sessions, missions done, completion
rate, deaths, each with a vs-previous-period delta), a **when-you-fly heatmap**
(day × hour from real log timestamps), a **mission-outcome donut**, a
**by-type stacked bar**, and a **pilot leaderboard**. Power-BI-style **slicers**
(time / pilot / mission type / outcome) cross-filter every panel, and clicking a
donut slice, a type bar, or a pilot row acts as a slicer too. Honest empty states
where data is thin. Verified live: real LIVE session rendered (Kersa, 3 missions,
4.4k-event heatmap). Suite green (**54 tests**). Still **local-player only** until
the org-wide relay (M4) — the pilot slicer is already wired for it.

---

## 🩸 Current-build DEATH signal + mission lifecycle parser rules (branch) ✅
**Date:** 2026-06-17 · branch `feature/death-and-mission-lifecycle`

A live test ("someone killed me earlier — did you get that?") exposed a gap: on
4.8.0 the death produced **no kill line** (removed after 4.3.0) **and no
`Incapacitated:` line** — so the relay missed it. Investigation (incl. a sub-agent
sweep of the 525-file corpus) found the reliable current-build signals:

- **Local-player DEATH** — when you die, your corpse spawns and the game lists your
  gear for recovery. The **first** line of that ~30-line burst is always the body:
  `<Adding non kept item [CSCActorCorpseUtils::PopulateItemPortForItemRecoveryEntitlement]> Item 'body_01_noMagicPocket_<id>'`.
  Keying on `body_01_noMagicPocket` = exactly **one event per death**, and it does
  **not** match later corpse-*loot* bursts (those start with gear) → no double-count.
  VERIFIED across 4.7.175→4.8.180 (3 players). New rule `player:death`.
- **Mission lifecycle** — `<CSCPlayerMissionLog::MissionStartCommsNotification>`
  (ContractId + MissionId) = **accepted/started** → `mission:start`; `<EndMission>
  … CompletionType[…] Player[…]` = authoritative **outcome** → `mission:end`.
  CompletionType vocab (corpus): **Complete 1043 / Abandon 292 / Fail 98 /
  Deactivate 20**.

**Built (this branch):** the three parser rules **+ full service/REST/UI wiring**
(owner go-ahead given 2026-06-17). Service now has a `deaths` collection
(`GET …/deaths`), `missionStats()`, mission-lifecycle fields on `…/missiongroups`,
and `deaths`/`missionStats` in `…/monitor`; the dashboard shows a deaths counter, a
mission-outcome summary, and per-mission status badges. **Validated on real backups**
via the `logbackups` archive (SC keeps the previous `Game.log` per launch): replaying
real 4.8.0 sessions detects the deaths (incl. the live-tested 2026-06-16 04:49:59
death) and Complete/Abandon/Fail outcomes. Tests: parser (5) + a real-format replay
fixture + API checks — suite green (**53 tests**). See `DESIGN-mission-dashboard.md`.
Honest scope unchanged: **local-player only** + self-reported — the officer register
stays the source of truth (D-005).

---

## ⚠️ Correction — kill logging was REMOVED after SC 4.3.0 (not in current game) ✅
**Date:** 2026-06-14

Double-checked the "verified kills" against build versions (good catch — they could
have been an old-version artifact). They were: **all 417 kills are from 4.2.1 / 4.3.0**
(Aug–Sep 2025). Mapped all 26 builds in the corpus — **4.3.2, 4.4, 4.5, 4.6, 4.7, 4.8 →
ZERO kills across ~290 files.** Scanned the largest 4.7/4.8 sessions: 0 `CActor::Kill`,
0 `killed by`, 0 reformatted variant — yet **1,660** combat-mission refs + **3,125**
`CSCActorCorpseUtils` corpse-creation lines (combat + deaths happened, kills not logged).
Corroborated by DeadMan-4.7.0 and Kersa-4.8.0 (both zero).

**Conclusion:** CIG removed/moved `CActor::Kill` + `<Vehicle Destruction>` logging after
4.3.0. **The live kill feed does NOT work on the current game (4.8.0).** The parser rules
stay (they parse historical ≤4.3.0 logs correctly; `verified:true` = format-confirmed, not
a current-availability claim). The 💀 Kills panel + Discord wiring remain — they'll only
fire on ≤4.3.0 logs (e.g. historical analysis). This **supersedes** the "headline feature
live" entry below. Lesson: "verified on real data" must be qualified by game version.

---

## 🎯 Kill feed VERIFIED on real member data — headline feature live ✅
**Date:** 2026-06-14

A 3rd member's corpus (**Fadingdoughnut0**: 332 files / 9.6 GB, builds 4.2.x–4.8.0,
Aug 2025–Jun 2026) finally contained client-involved combat. Full scan: 5 files with
kills; our parser caught **all 417** `<Actor Death> CActor::Kill` lines (414 kills +
3 deaths, 394 NPC victims; damage types Bullet/ElectricArc/Explosion/TakeDown/
VehicleDestruction/Crash/Melee/Suicide) **+ 16 `<Vehicle Destruction>`** lines
(shipName: `DRAK_Corsair` → "Corsair").

- Flipped `kill` + `vehicle:destroy` rules to **`verified:true`**. Tests updated (45 pass).
- Corrected memory, both briefs, and `REFERENCES.md`.

The original headline feature — **kills → dashboard 💀 panel / Discord** — is real for
member-involved combat (your kills, deaths, ship destructions). Third-party kills
remain unlogged (SC 4.0.2).

---

## Kills wired end-to-end — ready to test ✅
**Date:** 2026-06-14

Wired the kill path so it lights up the instant a real client-involved kill line arrives:
- `app/server.js` — enriched the kill record: `killerNpc`/`victimNpc` (via `isNPC`),
  `weaponClass`, ids, and **`involves`** (kill / death / other, relative to the session
  player). Kills included in the `/monitor` feed.
- Discord — upgraded `_discordKill` embed (⚔️ Kill / 💀 Death, NPC tags, weapon/zone/type).
- `app/ui.html` — a dedicated **💀 Kills** panel (killer → victim, NPC tags, weapon · type).
- `test/fixtures/sample-combat.log` — committed sample (un-ignored in `.gitignore`) +
  a service test. Tests 44 → **45**.

**Validated live:** seeding the sample shows 3 kills — 2 NPC kills (`Bullet` +
`VehicleDestruction`) and 1 PvP death — correctly classified. **To test for real:** a
member runs the relay and gets/takes a kill; on a confirmed real line, flip the
kill/vehicle rules `verified:false` → `true`.

---

## Finding — kills ARE loggable (for the running player); earlier conclusion corrected ✅
**Date:** 2026-06-14

Researched the SC GitHub ecosystem (see `REFERENCES.md`) and reconciled our "kills
are never logged" conclusion against the **maintained** all-slain parser
(DimmaDont/all-slain, 2025). Its code comment: *"4.0.2 no longer reports kills that
don't involve the client player."* So since SC 4.0.2 the client log records
`<Actor Death> CActor::Kill` **only for kills involving the running player** (your
kills, your deaths) — not third-party kills. The format **matches our dormant
kill/vehicle rules**, and our parser passes all-slain's test lines (FPS = damage type
`Bullet`; ship = `VehicleDestruction`). Our corpora (Kersa hangar + DeadMan 193 logs)
contained **no client-involved kills** (mining/defense/incap-without-death) — hence 0.

**Corrected:** parser comment, the `sc-log-combat-vs-missions` memory, both briefs
(`.md` + `.docx`), and `REFERENCES.md`. Tests 43 → **44** (added the ship-kill
`VehicleDestruction` variant).

**Next:** capture a real member combat session (a kill or a death by the running
player) to flip the kill/vehicle rules `verified:false` → `true`. A kill feed for a
member's own kills + deaths is achievable.

---

## M3.14 — Mission-type classification (generator → category) ✅
**Date:** 2026-06-14

**Why:** to filter the feed by mission type (the earlier "operations" idea). The
`CLocalMissionPhaseMarker` line links a runtime MissionId to its generator/template
name — the bridge to typing a grouped mission.

**What shipped:**
- `app/parser.js` — `mission:marker` rule (MissionId → generator name) and a
  `missionType()` classifier mapping real codenames to categories (Bounty,
  Mercenary/Defense, Hauling, Recovery, Mining, FPS/Facility, Sabotage, Event,
  Other). Built from the Kersa 4.8.0 + DeadMan 4.7.0 corpus; editable.
- `app/server.js` — markers attach `generator` + `type` to the grouped mission;
  `missionGroups` exposes both. `app/ui.html` — the Missions panel badge shows the type.
- Tests: 40 → **43**.

**Validated:** a 120,330-line 4.7.0 session classified 30 missions as
20 Mining / 6 Mercenary-Defense / 4 Other (e.g. Shubin_ResourceGathering_ShipMining
→ Mining, EckhartSecurity_DefendShip → Mercenary/Defense).

---

## M3.13 — Player-down (incapacitation) detection ✅
**Date:** 2026-06-14

**Why:** an export of 193 logs (657 MB) from a second player (DeadMan1227, SC 4.7.0)
reconfirmed kills are never logged — but surfaced a NEW signal Kersa's logs lacked:
the **"Incapacitated:" notification** (617 occurrences, one per down event). It is
the nearest combat-outcome the client log provides.

**What shipped:**
- `app/parser.js` — `player:incap` rule (SHUDEvent notification beginning
  "Incapacitated:"), placed before the generic hud:notification rule.
- `app/server.js` — `incaps` collection + `/incaps` endpoint + count; routed and
  attributed to the session's player handle; optional `announceIncaps` Discord
  embed (off). UI: a "downs" counter.
- `test/api.test.js` — now binds an **ephemeral port** (port 0) to avoid clashes.
- Tests: 37 → **39**.

**Note / bug fixed:** the new field was first named `this._handle`, which shadowed
the `_handle` HTTP method (instance property hid the prototype method → only the
server-starting test failed). Renamed to `_sessionHandle`.

**Validated:** replaying a real 79,516-line 4.7.0 session detected 2 downs,
attributed to DeadMan1227.

---

## M5.2 — Mission register REST API ✅
**Date:** 2026-06-13

**What shipped (DESIGN-missions-mvp.md §5):** wired the register flow into
`app/server.js` — `POST /missions/:id/apply`, `GET /missions/:id/applications`,
`POST /applications/:id/decision`, `POST /missions/:id/claim`,
`POST /claims/:id/validate`, `POST /missions/:id/cancel`, plus read endpoints
`/applications`, `/claims`, `/validations`, `/audit`. A shared error mapper returns
**403** (officer-forbidden), **404** (not found), else **400**; existing
`/missions` create/list/detail unchanged.

**Tests:** 36 → **37** (HTTP integration test: full create→apply→accept→claim→
validate flow + the 403/404 guards, on port 3199).

**Validated:** live demo over the running server (port 3041) ran an out-of-game
"Tactical Strike Group Alpha" through to completed with a 5-entry audit chain.

**Next:** M5.3 — Discord bot (slash commands + the Scheduled-Events hook); needs
the product-owner Discord decisions. M4 (hosting) can run in parallel.

---

## M5.1 — Mission register: store + model + audit chain ✅
**Date:** 2026-06-13

**What shipped (implements D-005 / DESIGN-missions-mvp.md §3–4, §9):**
- `app/store.js` — tiny keyed-collection store; in-memory by default, optional
  file persistence (`dir`). Zero deps; swappable for node:sqlite at deploy.
- `services/MissionManager.js` — stub → real register. Full lifecycle (open →
  apply → accept → assigned → claim → officer validate → completed | reject/cancel),
  officer allowlist (permissive bootstrap when empty), CompletionClaims with
  EvidenceRefs, and a **hash-chained audit log** (`verifyAudit()`); keeps the old
  method names/events so the rest of the service is unchanged.
- `app/server.js` — `/missions` route returns plain records (no toJSON); 403 on
  officer-forbidden create; optional `SC_REGISTER_DIR` / `SC_OFFICERS` env.
- Tests: 31 → **36** (lifecycle, bad-transition guards, officer enforcement,
  audit tamper-detection).

**Validated:** end-to-end demo ran an **out-of-game fleet action** through
create→apply→accept→claim→validate→completed with an intact audit trail; live
service boots cleanly on the real manager.

**Next:** M5.2 (REST routes for the full flow + officer checks), then M5.3
(Discord bot) — needs the product-owner decisions in SOLUTION-BRIEF §7.

---

## M3.12 — Combat progress proxy (inferred from mission objectives) ✅
**Date:** 2026-06-13

**Why:** SC 4.8.0 does not log NPC ship kills (confirmed repeatedly). The closest
signal is mission objective progress that implies combat ("Defeat Hostile Ships",
"Waves Defeated"). Make that a first-class, clearly-labelled proxy — not claimed
as exact kills.

**What shipped:**
- `app/server.js` — `COMBAT_OBJECTIVE` detector; combat objectives are marked
  (`objective.combat=true`), collected into a `combatlog` stream, and emit
  `combat:progress`. New `/combat` endpoint + `combat` count; optional
  `announceCombat` Discord embed (⚔️, off by default).
- `app/ui.html` — a "combat" counter (tooltip: inferred from missions) and a ⚔️
  marker on combat objectives in the Missions panel.
- Tests: 30 → **31**.

**Validated:** replaying a real combat-mission log produced 65 combat-progress
entries ("Defeat Hostile Ships", "Waves Defeated"). Honest limitation: only fires
when a mission frames combat in its objective text; nothing for free-flight kills.

---

## M3.11 — Group missions by MissionId (objectives nested) ✅
**Date:** 2026-06-12

**Why:** `missionlog` was a flat list of disconnected mission lines. The runtime
MissionId GUID ties one mission instance together (see MissionId note in M3.10),
so we can present real missions instead of loose events.

**What shipped:**
- `app/server.js` — `_indexMission()` builds `missionGroups` keyed by MissionId;
  `objectiveId` is the join key (notifications carry MissionId+ObjectiveId,
  objective updates carry ObjectiveId+latest text). New `missionGroups` getter,
  `/missiongroups` endpoint, `missions` count, and `missions` array in `/monitor`.
- `app/ui.html` — a "🎯 Missions" panel renders each mission with its objectives
  nested; the header "missions" counter now reflects grouped missions.
- Tests: 29 → **30**.

**Validated:** replaying a real mission log produced 4 grouped missions, incl. a
delivery contract with its objectives nested ("Deliver 0/6 SCU of Quartz" → "…to
Teasa Spaceport").

---

## M3.10 — Split general HUD notifications out of missions ✅
**Date:** 2026-06-12

**Why:** every `SHUDEvent_OnNotification` was classified `mission:notification`,
but most are general HUD notices (zone/jurisdiction/tutorial) with an all-zero
MissionId — not mission items (spotted on the dashboard).

**What shipped:**
- `app/parser.js` — `mission:notification` now requires a NON-zero MissionId; a
  new `hud:notification` rule catches the rest (zero/absent MissionId).
- `app/server.js` — `hud:notification` routes to a new `notifications` collection
  (+ `/notifications` endpoint, count, `notification` event); missions stay clean.
- Tests: 27 → **29**.

**Validated:** active session now reads missions=2, notifications=15 (the zone
notices moved out of missions).

**MissionId note (researched):** the log's MissionId is a per-instance runtime
GUID — confirmed it spans multiple lines of one mission instance (e.g. 10/7/7
lines per GUID across logs), so it's useful for INTERNAL correlation (grouping a
mission's objectives/notifications/lifecycle), but it is NOT published anywhere
and can't be looked up externally. External enrichment (SCMDB/SC-Wiki/UEX) keys
off the contract TEMPLATE name, not the GUID.

---

## M3.9 — Distinct-player roster vs. login events ✅
**Date:** 2026-06-12

**Why:** the `players` count was counting login *events* (a relog showed as 2
players). Looking ahead to a multi-relay (Fabric) build we want "who is playing"
(distinct handles) separate from "how many logins/sessions".

**What shipped:**
- `app/server.js` — `recordPlayer()` keys players by handle (distinct roster with
  `firstSeen`/`lastSeen`/`logins`); a separate `logins` collection keeps every
  login event. `player:join` now fires once per distinct handle; `player:login`
  on every login. New `/logins` endpoint; `logins` count in `/monitor` + status.
  POST `/players` deduped by handle too (for future remote relays).
- `app/ui.html` — "players" is now the distinct count; login total on hover.
- Tests: 26 → **27**.

**Validated:** real data now reads `players=1` (Kersa) with logins tracked
separately (was showing 2 for one player).

---

## M3.8 — Auto-detect install + channel (LIVE/PTU/EPTU/HOTFIX/TECH-PREVIEW) ✅
**Date:** 2026-06-12

**Why:** players install on different drives/paths and run different channels; a
single hard-coded `SC_LOGFILE` doesn't travel. (User has HOTFIX, LIVE, and
TECH-PREVIEW side by side, across 10 drives.)

**What shipped:**
- `app/locate.js` — `resolveLogFile()` scans drive roots × known install
  sub-paths × channels, and picks the channel whose `Game.log` is **most recently
  modified** (the one being played); ties favour test channels. Honours
  `SC_LOGFILE` (exact) and `SC_CHANNEL` (force) overrides. Pure-ish + injectable
  fs for tests.
- `app/server.js` — startup auto-resolves the log (logs the choice), pre-seeds
  from it by default; `channel` tracked on the service + each session and exposed
  via `/monitor` + status.
- `app/ui.html` — header shows the active channel alongside the build.
- Tests: 20 → **26** (6 locator tests).

**Validated:** `node app/server.js` with **zero config** auto-picked
`HOTFIX -> …\StarCitizen\HOTFIX\Game.log`, seeded it, and tailed it; `SC_CHANNEL`
override resolves correctly.

---

## M3.7 — Game-session tracking + restart-aware live monitoring ✅
**Date:** 2026-06-12

**Why:** the game moves the old `Game.log` to `logbackups/` and creates a fresh,
smaller file on every launch — a naive tail sits at the old byte offset and misses
the new session. Verified the rotation behavior and the `Log started on …` header.

**What shipped:**
- `app/parser.js` — `session:start` rule (from `Log started on <date>`).
- `app/server.js` — replaced the `tail` dependency with a self-contained read-only
  **poller**: when the file shrinks/recreates it resets to byte 0, re-reads the new
  header, and emits `session:restart`; `session:start` builds a per-launch session
  record (`this.sessions`) and resets `this.session` so build/hardware re-stamps.
  Seed now runs before the poller (starts at EOF) to avoid double-reading.
- `app/ui.html` — a "sessions" counter; `/monitor` + status expose `sessions`.
- `package.json` — dropped the now-unused optional `tail` dependency (**zero deps**).
- Tests: 18 → **20**.

**Validated:** monitor restarted, detected the current session (a fresh 06:43 log,
proving a real restart was picked up); live line count climbed (700 → 710).

---

## M3.6 — Validated community reference; folded in the verifiable bits ✅
**Date:** 2026-06-12

**Validated** the Ozy311/greluc `Game.log` reference against the real 4.8.0 log
(`Branch: sc-alpha-4.8.0-hotfix`). Its four headline combat tags (`<Actor Death>`,
`<Vehicle Destruction>`, `<Actor stall>`, `<[ActorState] Corpse>`) have **zero**
matches here — they're from older ~4.0–4.2 builds (SC-Kill-Monitor archived Nov 2025).

**Folded in (verified by tests on real strings):**
- `shipName()` — ship-ID prettifier (1166 hits; `RSI_Aurora_Mk2_…` → "Aurora Mk2").
- `parseSessionInfo()` — stamps each session with build/hardware (Branch, Changelist,
  FileVersion, CPU, RAM, GPU VRAM); exposed via `/monitor` + status + UI header.
- `isNPC()` — NPC indicator list, with bare `PU_` **excluded** (it matches cosmetic
  items like `PU_Protos_Head`, not NPCs).

**Kept for later:** the dormant `kill`/`vehicle:destroy` rules were upgraded to the
reference's fuller regexes but remain `verified:false` — they'll capture full detail
if a future build/mode ever writes those tags again. Tests: 14 → **18**.

---

## M3.5 — Mission/objective tracking (verified on real combat-mission log) ✅
**Date:** 2026-06-12

**Key finding (validated against a real combat-mission session):** the client
`Game.log` does **not** record explicit PVE/NPC ship kills — the word "kill"
never appears and the documented `CActor::Kill` / `<Vehicle Destruction>` formats
are absent. Combat is only visible *indirectly* via mission objective progress.
The mission/contract layer, however, is logged richly.

**What shipped (additive — nothing removed):**
- `app/parser.js` — three **verified** rules: `mission:contract`
  (`GenerateLocationProperty … contract:`), `mission:objective`
  (`CMissionLogEntry::UpdateActiveObjective` → id + on-screen Text), and
  `mission:notification` (`SHUDEvent_OnNotification` → text + MissionId/ObjectiveId).
- `app/server.js` — new `missionlog` collection + `/missionlog` endpoint, routes
  + `mission:event`/`mission:objective` emits, optional `announceMissions` Discord
  embed (off by default), and the monitor now surfaces mission activity.
- `app/ui.html` — panel relabeled “Mission & combat activity”, missions counter.
- Tests: 10 → **14** (3 parser + 1 service routing, all on real log lines).

**Retro:** Real data redirected the headline feature from a PVE kill feed (not
possible from the client log) to **live mission tracking** — which advances the
missions/contracts goal (M5) on verified ground. The unverified combat rules stay
in place for PvP/actor-death logs, which may still use the documented format.

---

## M3 — Real log parser + event detection + Discord wiring ✅ (combat pending)
**Date:** 2026-06-08

**What shipped:**
- `app/parser.js` — a rule-based parser for the SC 4.x log format
  (`<timestamp> [Notice] <EventType> …`). Classifies lines and extracts fields.
- `app/server.js` — now routes parsed events into the right collections
  (kills → kills, logins → players, vehicle destruction → vehicles), emits
  specific events (`kill`, `player:join`, `vehicle:destroy`), and posts optional
  Discord embeds (off by default).

**Validated against your real Game.log (read-only):**
- **VERIFIED** events: player login (`Handle[Kersa]`), character status, level
  loads (6), game-mode creation (6). All parse correctly.
- 0 kills detected — correct, this was a hangar session with no combat.

**Honest status on combat events:**
- Kill and vehicle-destruction parsing is built to the **documented SC 4.x
  format** and is covered by tests, but is flagged `verified: false` in the code
  because we have **not** confirmed it against a real combat log yet.
- A speculative quantum-travel rule was **removed** — "Quantum" appears in ~15,000
  lines (component names), so it produced false positives. It'll be re-added only
  with a confirmed `<Quantum Travel>` line format.

**Retro:** The parser cleanly separates verified vs unverified rules, so it's
honest about what it actually knows. **Open dependency for the headline feature:
a Game.log captured during combat** (kills/ship destruction) to confirm those
patterns. Until then, kill→Discord is wired but unproven on real data.

---

## M2 — Replay script + automated tests ✅
**Date:** 2026-06-08

**What shipped:**
- `scripts/replay.js` — feeds a saved Game.log through the live pipeline and
  prints a tally of detected events. (`npm run replay <path>`)
- `test/parser.test.js`, `test/service.test.js` — 10 tests using Node's built-in
  test runner (**no install needed**). (`npm test`)
- `package.json` rewired: `start` runs the Fabric-free service, `npm install` now
  pulls **only 1 optional package** (was ~400 MB of Fabric). Original Fabric entry
  kept as `start:fabric` (deprecated).

**Validated:** `npm test` → 10/10 pass. `npm install` → 0.4s, 1 package.

**Retro:** Using the built-in test runner sidesteps the install fragility that
plagued the spike. Everything stays runnable with zero setup.

---

## M1 — "It's alive": Fabric-free service skeleton ✅
**Date:** 2026-06-08

- `app/server.js` boots with zero dependencies, serves health + collection +
  mission endpoints, and replays logs. Verified: health endpoint returns JSON;
  replayed the real 27,712-line Game.log into 13,964 activities.

---

## Up next

- **M3-combat (blocked on input):** get a Game.log recorded during combat; confirm
  the kill / vehicle-destruction patterns; turn on a real kills→Discord demo.
- **M4 — Fabric mesh backbone (was: deploy to a VPS; see D-008):** wire in
  Fabric as an optional, strippable sibling module (same seam as
  `services/CargoRouter.js`) — peer identity, consent-gated event sharing
  (reusing the per-peer `shareLogs` gate already proven on the
  `martindale-star-citizen-live` clone's `feat/op-participation` branch), seed
  hub bootstrap. No VPS, no hosting decision to make first.
- **M5 — Contracts MVP:** create/list/apply/approve missions via API/Discord,
  backed by a small database.
- **M6+:** Discord roles for approvals, signed audit trail (can lean on
  Fabric's own signing/identity primitives per D-008), polish.
- **Packaging (cross-platform) — required:** ship the relay as a one-click install on
  **Windows (.exe, Node SEA)** AND **Linux** (self-contained binary + install script /
  optional .deb/AppImage; an always-on peer — Discord bot / web-UI bridge, not
  "the" central service — can still install as a Linux **systemd** service).
  The Linux relay must add **Proton/Wine `Game.log` detection** (Steam compatdata /
  Lutris prefixes) — `app/locate.js` currently scans Windows drives only (see TODO there).
  Trust: Windows Authenticode signing + Linux GPG signing, VirusTotal, SHA-256 checksums.
  See `SOLUTION-BRIEF.md` / `Permafleet-Solution-Brief.docx` §8.

> Cadence: one milestone per iteration, each ending with a demo, a retro note
> here, and a quick re-prioritization.
