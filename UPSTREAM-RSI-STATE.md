# UPSTREAM-RSI-STATE.md — where `martindale/star-citizen-live @ feature/rsi` is, and what it means for us

> **Why this file exists.** This repo's own docs (`AGENTS.md`, `PROGRESS.md`,
> `CONTINUE.md`) describe **our fork's `master`**, which stopped moving on
> **2026-07-05**. The lead developer's branch has since become a *substantially
> different product*. This file is the durable, self-contained record of that
> divergence so **any future session — on any model — can pick the thread up
> without re-deriving it.** It is written to survive a model-selection change:
> every claim below names the file, branch, or command it came from.
>
> **Snapshot taken:** 2026-08-17 · **Author:** Claude Code session on branch
> `claude/star-citizen-fork-features-he1h1f`.
>
> ⚠️ **This is a survey, not an authorisation.** Per `AGENTS.md` §10 / D-006 the
> owner decides what gets built. Nothing here has been implemented.

---

## 0. How to re-derive this (do this first if the file looks stale)

Upstream is a **public** repo, readable anonymously — no attach needed:

```bash
GIT_LFS_SKIP_SMUDGE=1 git clone https://github.com/martindale/star-citizen-live \
  /workspace/martindale/star-citizen-live
cd /workspace/martindale/star-citizen-live && git checkout feature/rsi
head -200 AGENTS.md          # upstream's own current-state doc — the best single source
grep -n '^## D-0' DECISIONS.md
git log --format='%ad %an %s' --date=short feature/rsi | head -60
```

`Neorion/Verseview` is **private** — attach it first with `add_repo`
(`owner: Neorion, repo: Verseview`), then
`git clone --depth 1 https://github.com/Neorion/verseview /workspace/verseview`.
Its backlog is `BACKLOG.md`, its spec is `CLAUDE.md`.

### Snapshot facts (verify against the commands above)

| | |
|---|---|
| Upstream branch | `martindale/star-citizen-live` → `feature/rsi` |
| Upstream tip at snapshot | `a96d5ae` — *"Use latest Fabric"* — **2026-08-14** |
| Upstream `master` | `60e5cdd` (the merge-base; effectively dormant) |
| Commits on `feature/rsi` not on upstream `master` | **133** |
| Commit cadence | 67 in 2026-06 · 25 in 2026-07 · 13 in 2026-08 — **active, decelerating** |
| Authors | Eric Martindale 87 · **Neorion 53** · 2 others |
| Our `master` tip | `d7a3c5e` — **2026-07-05** |
| Our newest branch work | `feature/cargo-router` `10d4ca4` — 2026-07-05 |

---

## 1. The one-paragraph answer

**Our fork was absorbed, then the product moved on without us.** All 53 of
Neorion's commits through **2026-06-24** are in `feature/rsi` — the parser, the
mission register, the Analyze dashboard, the backfill, D-005/D-006/D-007 are all
upstream, and D-007 (analytics + log backload as protected goals) is still an
adopted upstream goal. Since then, upstream turned the relay into **GoonCitizen**:
an Electron desktop app + Android app, with **Fabric P2P brought back deliberately**
as the mesh transport (D-009/D-010), Bitcoin multisig escrow for mission payouts
(D-008), Federation groups, chat, a Discord bot bridge, and a Hub-sealed sidechain.
Meanwhile our `master` still runs the retired zero-dependency `app/` skeleton, and
our newest work (Cargo Router, FatalCollision parser) never went upstream.

---

## 2. What changed, feature by feature

### 2.1 The shape of the thing

| | Our `master` (2026-07-05) | Upstream `feature/rsi` (2026-08-14) |
|---|---|---|
| Product name | star-citizen-live relay | **GoonCitizen** (`appId vc.goon.desktop`) |
| Entry point | `app/server.js` (~530 lines) | `services/LiveRelay.js` (**~11,150 lines**) + Electron `main.js` |
| `app/` tree | the whole service | **deleted** — retired |
| Runtime deps | **zero** (Node built-ins) | `@fabric/core`, `@fabric/http`, `@fabric/hub`, `@fabric/discord`, `bitcoinjs-lib`, `tiny-secp256k1`, `bip32`, `qrcode`, `tail`, `screenshot-desktop` |
| Node | 18+ | **pinned 24.15.0**; needs `npm i` with `allow-git=all` |
| UI | one static `app/ui.html` | **43 React components** (`components/`), esbuild SPA |
| Platforms | localhost web | web + **Electron** (win/deb/mac installers) + **Android** (Capacitor) |
| Helper modules | 4 files in `app/` | **~130 files in `functions/`** |
| Tests | 55, one `test/` dir | 5 layered suites: `unit`, `fabric`, `relay`, `integration`, `ui` (+ opt-in Chromium `browser`) |
| ADRs | D-001…D-007 | D-001…**D-019** |

### 2.2 New capability blocks (none of these exist on our fork)

- **Fabric P2P mesh (D-009/D-010).** Schnorr-signed Peer uplink to
  `hub.fabric.pub:7777` / `relay.goon.vc:7777`. This *reverses* our D-002 for the
  transport layer while keeping the relay itself local.
- **Bitcoin / payouts (D-008).** Group k-of-n P2WSH multisig wallets, mission
  rewards escrowed to the authorities' multisig, claim → BIP340-Schnorr approve →
  payout PSBT. Ledger mode by default; mainnet explicitly refused.
- **Federation Groups + Chat + Peers.** Groups are Hub-aligned Federation
  contracts with subgroups, invites, per-group Statechain journals, pinned
  channels/messages, opaque `fabric:<hex>` share offers (D-019).
- **Discord bot bridge** (not just the webhook we had): guild/channel/member
  catalogs accumulated locally so they survive Discord being down, in-app DMs,
  bridged channels, and **Discord ↔ Fabric identity linking** via a one-time
  `!link <code>`.
- **Cumulative durable history (D-014).** Byte-cursor sync of `Game.log` **and**
  `logbackups` on every start into `stores/gooncitizen/history.json`. Our
  `npm run backfill` survives as an optional CLI onto the same store. Header
  counts are now all-time by default.
- **Consent-gated log sharing (D-017).** `SCEventBatch` / `GameStateSnapshot`
  leave the node only after explicit per-peer authorize; default **off**.
- **Hub sidechain / Beacon seal (D-015/D-016/D-018).** Chain-of-Blocks gossip
  firehose, federation-signed Beacon epochs sealing a public `stateDigest`.
- **Files / document exchange.** Per-node catalog, sats-priced offers, peer
  inventory queries, chat attachments, `npm run publish:builds`.
- **Presence + fleets + ship catalog.** `functions/presence.js` (online window,
  current-ship publication, `private|peers|groups|public` visibility),
  `functions/starjumpFleet.js` (Starjump/FleetViewer JSON import),
  `functions/shipCatalog.js` (SC Wiki vehicles API). Routes `/presence`,
  `/presence/roster`, `/presence/ship`, `/fleets`, `/ships`, `/overlay`.
- **Register absorbs the log.** The mission register now ingests Game.log
  missions as `source: 'gamelog'` evidence rows (reward 0) — officer posts stay
  the payout path, so D-005 holds.

### 2.3 The parser — our biggest concrete gain

`app/parser.js` (ours, ~230 lines) → `functions/parser.js` (upstream, **506 lines**).
New rule families upstream, all absent from our fork:

| Family | Rules | Why it matters to us |
|---|---|---|
| `quantum:select` / `quantum:arrive` / `quantum:route` | 3 | **Location tracking.** Verified against Jul-2026 LIVE backups. This is the missing piece for B-001 presence and Verseview B-002c. |
| `vehicle:control`, `vehicle:stow`, `vehicle:list:*` | 5 | **"which ship was flown"** — the ✅-but-unbuilt half of B-001. |
| `inventory:*` | ~13 | Cargo/hold state — a real lead for a resource ledger. |
| `session:disconnect` (`Channel Disconnected`) | 1 | Backlog **B-011 "Stability & session health"** signal already parsed. |
| `player:crimestat` | 1 | New dimension, folded into cumulative history. |
| `party:marker`, `social:group-cache`, `social:player-instance` | 3 | Partial crew/party signal (B-011 "Crew/party"). |
| `comms:*`, `grpc:*`, `session:universe:*` | ~8 | Session diagnostics. |

**Still NOT parsed upstream** (checked by grep on `functions/`, `services/`):
`<PlayerJoined>` (true crew/party), `CWallet::ProcessClaimToNextStep` (insurance
claims), `SendShopBuyRequest` (prices paid), `<FatalCollision>` (**we have this —
see §3**).

### 2.4 Reality checks that did NOT change

Do not re-litigate these; upstream still holds them, same wording:

- **Kills are not logged in SC 4.8.0.** CIG removed `CActor::Kill` /
  `<Vehicle Destruction>` after **4.3.0**. Our 417-kill verification stands, and
  the rules still parse historical logs only.
- **Parser honesty `verified:` flag** — never flip to `true` without a real
  matching log line, and qualify by game version.
- **The mission register is the source of truth, not the log** (D-005).
- **Read-only log access, always.**

---

## 3. What is ours and still un-upstreamed

Everything after 2026-06-24 stayed on our side. If we want it in the new world it
has to be ported — upstream will not pick it up on its own.

| Work | Branch | Size | Port difficulty |
|---|---|---|---|
| **Cargo Router + contract-screen OCR** — `services/CargoRouter.js`, `app/ocr-parse.js`, `services/uexClient.js`, `services/ocrProvider.js`, UEX vocab, 3 test files, the 🚚 tab | `feature/cargo-router` | **+4,710 lines / 19 files** | **Medium.** `CargoRouter.js` never touches the parser (by design) so the service logic ports cleanly; the UI must be rebuilt as a React component, and OCR needs a home in the Electron/Android shells. Upstream has **no cargo feature** — "cargo" there is only mission-text. |
| **`vehicle:collision` parser rule** (`<FatalCollision>`, current-build) | `feature/fatal-collision-parser` | +117 lines | **Easy.** One rule + fields; upstream `functions/parser.js` has no FatalCollision rule. Cleanest possible first contribution back. |
| One-click `run.bat` / `run.sh` launchers | `master` | small | **Obsolete** — superseded by Electron installers. |
| `DESIGN-event-convergence.md`, `HANDOFF-master.md` | `master` | docs | Partly superseded by D-010/D-017 (the mesh *is* the convergence transport now). |

---

## 4. Backlog mapping — what the new fork makes cheap

Legend: **🟢 unlocked** (upstream already provides the hard part) ·
**🟡 partial** (some pieces there) · **🔴 still ours to build**.

### 4.1 Star Citizen Live backlog (`BACKLOG.md`, incl. `feature/cargo-router`)

| ID | Item | Verdict on the new fork |
|---|---|---|
| **B-001** | Op participation & loot-split metrics | **🟢 Best-value pick.** Every prerequisite is now met: the ⚠️ "on-site presence" blocker is answered by the verified `quantum:*` rules; "ship used" by `vehicle:control`/`stow` + `presence.js`; multi-member aggregation by the Fabric mesh + consent-gated `SCEventBatch` (D-017) — which replaces the M4 VPS this item was waiting on. **What's left is the metric layer, not the plumbing.** Bonus: payout can land in the existing multisig escrow instead of being advisory. |
| **B-011** · Stability & session health | **🟢** `session:disconnect` is already a parsed rule; needs a panel + per-build rollup. Cheapest unique win, as originally scored. |
| **B-011** · Ship usage | **🟢** Was a "lead needing a verification pass" — `vehicle:control` + `shipCatalog.js` + `presence.js` did that pass. |
| **B-011** · Crew / party | **🟡** `party:marker` and `social:group-cache` exist; the decisive `<PlayerJoined>` line is still unparsed. Add the rule, then it's cheap. |
| **B-011** · Insurance / fleet attrition | **🔴** `ProcessClaimToNextStep` unparsed upstream. New rule needed; 328-file evidence base still stands. |
| **B-011** · Wallet / trading-lite | **🔴** `SendShopBuyRequest` unparsed. Note the name collision: upstream "Wallet" means **Bitcoin**, not in-game aUEC. |
| **B-012** | "New game session" re-baseline button | **🟡 Re-scope before building.** D-014 changed the model from session-scoped to all-time cumulative, so "re-baseline" now means something different. Likely smaller *and* differently shaped than the original ticket. |
| **B-010** | Cargo Phase 3 — rep predictor + load selection | **🔴 Blocked on porting Phase 1–2 first** (§3). Load selection is self-contained; the rep predictor still needs the new rep-screen OCR profile. |

### 4.2 Verseview / VERSEMAP backlog (`Neorion/Verseview` `BACKLOG.md`)

**Read this first:** Verseview is **SvelteKit + FastAPI + SQLite**; GoonCitizen is
**Node + React + Fabric**. There is **no code reuse** across them. The value is
that GoonCitizen becomes the **data producer** Verseview's roadmap keeps deferring
for want of one — i.e. treat it as an upstream feed, not a library.

| ID | Item | Verdict |
|---|---|---|
| **B-002c** | Live beacon → `POST /api/beacon`, "last seen 2h ago" | **🟢 The single highest-value link.** Verseview deferred this to Phase 4 because it needed "a companion-app + opt-in-trust cost". **That companion app now exists, ships as an installer, and already has the opt-in consent model (D-017).** Verified `quantum:*` gives real location changes; `presence.js` already carries an online window and `private/peers/groups/public` visibility. Work reduces to one POST adapter + honest age-labelling — which Verseview's `/api/beacon` seam was designed for. |
| **B-018** | Position-resolution rule (`verified > fresh-beacon > declared > stale-beacon`) | **🟢** Becomes implementable the moment B-002c lands — it was waiting on a beacon tier to exist. |
| **B-002b** | Discord `/deploy`, `/spotted` → ActivityEvents | **🟡** GoonCitizen's Discord bot bridge + `!link` identity mapping is the hard half. Slash commands would be new; the **verified handle → location** path is the real prize. |
| **B-011/B-012** | Discord OAuth identity · verified RSI handle | **🟡** Different mechanism, same outcome: GoonCitizen's `!link` proves *Discord ↔ Fabric key*, not *RSI handle*. Verseview's CitizenID OIDC path stays the better answer for `handle_verified`; use `!link` only to join a Verseview member to a beacon source. |
| **B-003** | Resource ledger (in/out movements, types, tags, attribution) | **🟡** The upstream `inventory:*` rules are a genuine lead toward *auto-populating* movements. Treat as **evidence input** to Verseview's authored ledger — never as authority. Respects both repos' honesty rules. |
| **B-015** | SSE activity stream | **🔴 No SSE upstream** (grep: no `text/event-stream`). Its live feed is Fabric gossip. Keep Verseview's own SSE plan. |
| **B-010 / B-016** | Role model · SharingGrant | **🟡 Worth stealing the *design*, not the code.** GoonCitizen already ships `members` vs `validators`, reader invites, `ContractCapabilityGrant`, and 4-level visibility — a working answer to the exact problem Verseview has deferred twice. |
| **B-021** | Public recruiting view (sanitized read model) | **🟡** Same pattern already implemented upstream: profiles expose **only** opted-in data (playtimes, pinned files), never the local heatmap. Good prior art. |

### 4.3 If you only do one thing

**B-001 (SC Live) and B-002c (Verseview) are the same underlying build** — parse
location + ship, attribute to a member, ship it somewhere with consent. Doing them
as one piece of work serves both backlogs and lands the item that has been blocked
longest in each.

---

## 5. Open decisions for the owner (nothing proceeds without these)

1. **Do we rebase onto `feature/rsi`, or stay Fabric-free?** This is the fork in
   the road, and it is not a small one — it reverses D-002 for transport, adds
   ~10 runtime deps, pins Node 24.15.0, and retires `app/` entirely. Our zero-dep
   posture and the one-click launcher were deliberate choices for non-technical
   org members; Electron installers are arguably a *better* answer to that same
   goal, but it is the owner's call, not ours.
2. **Where does Cargo Router live?** Port it to `feature/rsi` (React rewrite),
   keep maintaining it on our fork, or offer it upstream as a PR.
3. **Offer `vehicle:collision` upstream?** Small, self-contained, current-build,
   fills a real gap. The obvious goodwill contribution if we stay separate.
4. **Does Verseview consume GoonCitizen as a beacon source?** If yes, B-002c
   moves from Phase 4 to near-term and B-018 unblocks with it.
5. **Bitcoin payouts (D-008) — in or out of scope for us?** Upstream has built a
   full escrow path. It is powerful and it is a governance/compliance decision
   well above a code review.

---

## 6. Notes for the next session

- Prefer upstream **`AGENTS.md` §3–§5** over its `CONTINUE.md`/`PROGRESS.md`;
  upstream says so itself — those still describe the retired `app/` path.
- Our `CONTINUE.md` and `PROGRESS.md` are accurate **for our fork only**.
- Upstream warns: do **not** treat June-2026 `REVIEW.md` branches as current, and
  do **not** bump the coordinated `@fabric/*` pins casually.
- Upstream `REPORT-remaining-work.md` (2026-08-06) is their live P0/P1/P2 list —
  the fastest read on where their attention actually is (journal catch-up,
  reader→signer promotion, Taproot ladder).
- Verseview's roadmap is **complete through Phase 5 core**; what is deferred there
  is auth enforcement and the beacon — see its `BACKLOG.md` phase table.
