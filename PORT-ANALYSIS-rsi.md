# PORT-ANALYSIS-rsi.md — feature analysis + level of effort to recode onto the RSI fork's design patterns

> **Companion to [`UPSTREAM-RSI-STATE.md`](UPSTREAM-RSI-STATE.md).** That file says
> *what* diverged. This one says *what it would cost to build our backlog inside
> the new codebase*, and *which items the community already solved*.
>
> **Snapshot:** 2026-08-17 · upstream `martindale/star-citizen-live @ feature/rsi`
> `a96d5ae`. Re-derive with the commands in `UPSTREAM-RSI-STATE.md` §0.
>
> ⚠️ **Advisory only.** Per `AGENTS.md` §10 / D-006 the owner decides what gets
> built. Nothing here is authorisation, and nothing here has been implemented.
> Effort figures are estimates, not commitments — see §3 for how they were derived.

---

## 1. The conformance target — RSI fork design patterns

These are read off the code, not inferred. **This is the checklist any ported
feature must satisfy**, and the source of most of the "pattern tax" in §4.

| # | Pattern | Evidence | What it costs a port |
|---|---|---|---|
| P1 | **CommonJS + `'use strict'` + JSDoc on every export** (`@param`/`@returns`, typedefs) | every file in `functions/` | Low — same as our fork, plus JSDoc discipline |
| P2 | **`functions/` = pure leaf helpers.** Data in, data out. No `fs`, no network, no state. ~130 modules, median ~100 lines | `functions/activityHeat.js` (116 lines) | **Medium** — our service classes mix pure logic with I/O and must be split |
| P3 | **`services/` = stateful managers.** `LiveRelay` (HTTP + orchestration), `MissionManager`, `ChatManager`, `GroupManager`, `PayoutManager`, `SnapshotManager`, `FabricNetwork` | `services/` | Low |
| P4 | **Persistence via the Fabric Store, never raw `fs`.** `types/Store.js` composes `@fabric/core` Store; collections at `/collections/<name>` under `stores/gooncitizen/` | `types/Store.js`, AGENTS §3 | **Medium** — our `app/store.js` + JSON files must be re-pointed |
| P5 | **Routes are inline dual-mounted string compares** inside LiveRelay's handler: `if (pathname === \`${base}/x\` \|\| pathname === '/x')` | `services/LiveRelay.js:6255+` | Low per route, but the file is **11,147 lines** — merge-conflict risk is real |
| P6 | **UI = React class components using `React.createElement` — no JSX.** CSS as a per-component template-literal `CSS` constant. esbuild bundle | `components/ActivityHeatmap.js` | **High.** `createElement` runs ≈1.5–2× the line count of equivalent JSX, and *all* of our HTML/vanilla-JS UI is a full rewrite |
| P7 | **Tab registration is three touch-points:** `TABS` array + `case` in the render switch + `featureEnabled(key)` gate, with `ADVANCED_TABS` / `androidSurface()` visibility | `components/Dashboard.js:49–80, 2506+` | Low, but must be done in a 2,814-line file |
| P8 | **Parser rules are declarative entries** in `RULES`: `{ kind, tag, test: /re/, fields: (m) => ({…}), verified: bool }` | `functions/parser.js` | **Very low** — our parser is the direct ancestor of theirs |
| P9 | **Mesh gossip needs a message type.** Genesis `messageTypes` is **frozen** to `['MissionBroadcast','SCEventBatch']`; anything new ships as a **non-genesis app message** (the `NoteShare` / `GroupDataShare` precedent) | `contracts/gooncitizen.js:39` | Medium — only if the feature crosses the mesh |
| P10 | **Sharing is consent-gated (D-017).** No log-derived payload leaves the node without `_canShareLogs()` / an explicit per-peer grant. Default **off** | `DECISIONS.md` D-017 | Low to implement, **mandatory** to respect |
| P11 | **Five-layer test suite:** `tests/unit` (leaf) · `tests/fabric` · `tests/relay` (LiveRelay + parser + register) · `tests/integration` (HTTP/Discord flows) · `tests/ui` (React trees via stub, no browser). Opt-in `tests/browser` (Chromium) | `tests/` | **Medium** — our single `test/` dir must be split across ≥3 layers |
| P12 | **Env:** Node pinned **24.15.0**; `npm i` with `allow-git=all`; `@fabric/*` pins move with Hub RC work and **must not be bumped casually** | AGENTS §3, release posture | Setup cost + a standing rebase tax |

**The headline tax is P6.** Roughly: pure-logic ports are cheap (P2/P8 are close to
what we already write), and **UI ports are expensive** — no JSX means every panel
is hand-built `createElement` trees.

---

## 2. Ecosystem scan — what the community already solved

Applying Verseview's own `LINK → QUERY → FORK → BUILD` rule (its `CLAUDE.md` §10)
and this repo's reuse rubric (`REFERENCES.md`). **Two backlog areas are already
served by mature third-party tools, and one of ours is genuinely unique.**

### 2.1 Direct competitors to our Cargo Router

| Tool | What it does | Overlap |
|---|---|---|
| **ContractTracker V2** (Nexus Mods) | F3 hotkey scans the mission panel; OCR (Windows 10/11 native + Tesseract fallback) parses mission name, type, pickup, dropoff, SCU, reward; floating overlay | **~90% of our OCR path (Phase 2)** — and it is a rewritten C# app, actively maintained |
| **SC DataHub — Game Tools** | Hotkey contract entry, multi-stop route planning matched to ship SCU, optimized route sheet, minimisable in-game overlay | **~90% of our route board (Phase 1 UI) + all of B-010 load selection** |

**Honest read:** the contract-OCR-and-route-board niche is now **crowded and better
resourced than us**. Our differentiator is *not* the route board — it is that our
cargo data is **log-derived evidence attributable to a member and joinable to the
officer-validated register**. Neither competitor does org accountability.

### 2.2 Adjacent tools worth linking, not rebuilding

| Tool | Relevance |
|---|---|
| **OrgManager** · **SC Org.Tools** | Org fleet tracking, live ops, personnel. Overlaps Verseview's Assets/Ops surface — check before extending B-003 |
| **FleetYards** | Ship DB + hangar tracker; a fleet-import source alongside upstream's Starjump importer |
| **UEX API 2.0** (+ its community-tools list) | Already our cargo vocab source (`services/uexClient.js`); still the right QUERY-don't-author answer for commodities (Verseview B-003) |
| **SC Beacon Net** | Live player beacons + Discord coordination — adjacent to Verseview B-002c, but it is a *service-request* beacon, not a location feed. **Not a substitute** |
| **StarLogs · VerseWatcher · SC_LogViewer · Star Parse** | Log parsers/overlays. Format cross-checks only — all remain constrained by the same 4.3.0 kill-logging removal |
| **Star-Citizen-Navigation** (MIT, ~2 yr idle) | Forkable navigation/route logic if we ever do in-verse routing |

### 2.3 Where we are genuinely unaddressed

Nothing found does **officer-validated mission accountability with a tamper-evident
audit chain**, and nothing does **participation metrics for loot-splitting**. B-001
remains our most defensible item. That is where effort should go.

---

## 3. How effort was estimated

Focused engineer-days for someone **already oriented in the upstream tree** (add
3–5 days of onboarding for a first contribution: `npm i` with `allow-git=all`,
Node 24.15.0, the five test layers, the Fabric Store).

| Band | Days | Meaning |
|---|---|---|
| **S** | 1–2 | One leaf helper + test, or one parser rule |
| **M** | 3–8 | Helper + route + small panel + tests across 2–3 layers |
| **L** | 9–20 | New tab, multiple helpers, persistence, mesh or OCR work |
| **XL** | 21+ | Multi-subsystem; needs the lead developer's buy-in on architecture |

Calibration anchor: `functions/activityHeat.js` (116) + `components/ActivityHeatmap.js`
(84) + `tests/relay/activityHeat.test.js` (54) = **254 lines for one complete,
conforming, tested feature slice**. That is the unit of work.

**"Pattern tax"** = the share of effort spent purely on conforming (UI rewrite to
`createElement`, splitting pure logic out of classes, re-homing tests, Store
re-pointing) rather than on the feature itself.

---

## 4. Feature-by-feature analysis

### 4.1 Porting our un-upstreamed code

| Feature | Source | LoE | Pattern tax | Notes |
|---|---|---|---|---|
| **`vehicle:collision` rule** (`<FatalCollision>`, current-build) | `feature/fatal-collision-parser` (+117 lines) | **S** (1–2 d) | **~0%** | Our parser is the direct ancestor of theirs (P8). Add a `RULES` entry + `fields` + a `tests/relay` case; optionally fold into `cumulativeHistory` + `liveFeed`. **The cleanest possible first contribution back upstream.** |
| **Cargo Router — log-derived board** (`services/CargoRouter.js`, 483 lines; its own regexes, never touches the parser) | `feature/cargo-router` | **L** (10–14 d) | **~45%** | Split per P2: pure route/dropoff logic → `functions/cargoRoute.js`; stateful accumulation stays a service. Its private `ACCEPT_RE` / `OBJECTIVE_RE` / `DROPOFF_RE` should be re-based onto upstream's existing `mission:contract` / `mission:objective` rules rather than re-parsing raw lines. UI is a **full `createElement` rewrite** (P6) — that is most of the tax. |
| **UEX vocab + client** (`data/uex-reference.json` 2,202 lines, `services/uexClient.js`, `scripts/build-uex-vocab.js`) | `feature/cargo-router` | **S–M** (2–4 d) | **~15%** | Maps almost 1:1 onto upstream's existing `data/ships/catalog.json` + `scripts/refresh-ship-catalog.js` convention. Easiest part of the cargo port. |
| **Contract-screen OCR** (`app/ocr-parse.js`, 125 lines, browser-side tesseract.js) | `feature/cargo-router` | **M** (5–8 d) | **~30%** | See §5 — the host seam already exists upstream; the blocker is capture resolution and one new dependency, not architecture. |
| **Cargo tests** (932 lines across 3 files) | `feature/cargo-router` | **M** (3–5 d) | **~70%** | Pure re-homing across `tests/unit` (parse), `tests/relay` (routes), `tests/ui` (panel) per P11. Almost entirely tax. |
| **`run.bat` / `run.sh` launchers** | `master` | — | — | **Obsolete.** Superseded by Electron installers. Do not port. |

**Cargo total if ported whole: L–XL (≈20–30 days).** Given §2.1, porting the
*whole* thing is hard to justify. Porting the **log-derived half only** (rows 2+3,
≈12–18 days) keeps our unique evidence-grade angle and drops the part where
ContractTracker and SC DataHub are simply ahead of us.

### 4.2 Star Citizen Live backlog

| ID | Feature | LoE | Pattern tax | What upstream already gives us |
|---|---|---|---|---|
| **B-001** | **Op participation & loot-split metrics** | **M–L** (8–14 d) | **~25%** | 🟢 **Best value in the list.** Every prerequisite landed: `quantum:select/arrive/route` (verified) = presence; `vehicle:control`/`stow` + `shipCatalog` + `presence.js` = ship-used; cumulative history = the time base; `SCEventBatch` over the consent-gated mesh = multi-member aggregation *without the M4 VPS this was waiting on*. Shape it as `functions/opParticipation.js` (pure, exactly the `activityHeat` mould) + one route + one panel. **Only genuinely missing input: the Discord-Events op window.** Optional upside: settle to the existing multisig escrow instead of staying advisory. |
| **B-011** | Stability & session health | **S–M** (3–5 d) | ~30% | 🟢 `session:disconnect` (`Channel Disconnected`) is **already a parsed rule**. Needs a per-build rollup helper + panel. Cheapest unique win, as originally scored. |
| **B-011** | Ship usage | **S–M** (3–5 d) | ~40% | 🟢 Was "a lead needing a verification pass" — `vehicle:control`/`stow`/`list` + `presence.js` **did that pass**. Now mostly a view. |
| **B-011** | Crew / party | **M** (5–8 d) | ~25% | 🟡 `party:marker` + `social:group-cache` exist; the decisive `<PlayerJoined>` line is **unparsed upstream**. One S rule, then an M rollup. Strategic: feeds org-wide convergence. |
| **B-011** | Insurance / fleet attrition | **M** (4–7 d) | ~30% | 🔴 `CWallet::ProcessClaimToNextStep` unparsed. New rule + panel; 328-file evidence base still stands. |
| **B-011** | Wallet / trading-lite (prices paid) | **M** (4–7 d) | ~30% | 🔴 `SendShopBuyRequest` unparsed. **Naming collision:** upstream "Wallet" means Bitcoin — this must ship as "Purchases"/"Spend", never "Wallet". |
| **B-012** | "New game session" re-baseline button | **S** (1–2 d) | ~20% | 🟡 **Re-scope before building.** D-014 moved the model from session-scoped to all-time cumulative with byte cursors, so the original ticket's premise has changed. Likely smaller *and* differently shaped. |
| **B-010** | Cargo Ph3 — load selection | **S** (1–2 d) | ~20% | Pure knapsack over route data; self-contained *once* 4.1 lands. But **SC DataHub already ships this**. |
| **B-010** | Cargo Ph3 — rep predictor | **L** (10–15 d) | ~35% | Needs a **new rep-screen OCR crop profile** + own tab. Highest-cost, most-contested item in the backlog. **Recommend parking.** |

### 4.3 Verseview / VERSEMAP backlog

**Read first:** Verseview is **SvelteKit + FastAPI + SQLite**; GoonCitizen is
**Node + React + Fabric**. There is **no code reuse between them**. "Recode to RSI
patterns" only applies to the items that would live *inside* GoonCitizen as a data
producer — the rest stay Python and carry no RSI port cost at all.

| ID | Feature | Where it lands | LoE | Notes |
|---|---|---|---|---|
| **B-002c** | **Live beacon → `POST /api/beacon`** | **GoonCitizen** (RSI patterns) | **M** (4–7 d) · tax ~20% | 🟢 **Best effort-to-value ratio anywhere in either backlog.** Verseview deferred this to Phase 4 for want of "a companion-app + opt-in-trust cost" — **that app now exists, ships as an installer, and already has the consent model (D-017)**. Work = `functions/beaconPost.js` (pure payload shaping) + settings toggle + gate + route. Verseview's `/api/beacon` seam is already built. |
| **B-018** | Position-resolution ladder | Verseview (Python) | **S** (1–2 d) | 🟢 No RSI cost. Unblocks the moment B-002c lands — it was only waiting for a beacon tier to exist. |
| **B-002b** | Discord `/deploy`, `/spotted` | Split | **M** (5–8 d) | 🟡 GoonCitizen's Discord bot bridge + `!link` identity mapping is the hard half, already built. Slash commands are new. |
| **B-011/012** | Discord OAuth · verified RSI handle | Verseview | **—** | 🟡 Different mechanism, same goal: `!link` proves *Discord ↔ Fabric key*, **not** an RSI handle. Keep Verseview's CitizenID OIDC as the `handle_verified` path; use `!link` only to bind a member to a beacon source. |
| **B-003** | Resource ledger auto-population | Split | **L** (10–16 d) | 🟡 Upstream's `inventory:*` rules (~13) are a real lead. **Honesty constraint:** log-derived movements are *evidence*, never authority over the authored ledger — matches both repos' rules. Also check OrgManager/SC Org.Tools overlap first. |
| **B-015** | SSE activity stream | Verseview | **S–M** (2–5 d) | 🔴 **No SSE upstream** (no `text/event-stream` anywhere); their live feed is Fabric gossip. Keep Verseview's own plan; no port. |
| **B-010 / B-016** | Role model · SharingGrant | Verseview | **M–L** (8–15 d) | 🟡 **Steal the design, not the code.** GoonCitizen already ships `members` vs `validators`, reader invites, `ContractCapabilityGrant`, and 4-level `private/peers/groups/public` visibility — a working answer to the exact problem Verseview deferred twice. |
| **B-021** | Public recruiting view | Verseview | **M** (4–8 d) | 🟡 Same pattern already implemented upstream: profiles expose **only** opted-in data, never the local heatmap. Good prior art. |

---

## 5. The finding that changes the cargo/OCR calculus

Upstream has **already built the host seam for OCR and left the analyzer empty.**

- `services/SnapshotManager.js` (193 lines) — periodic reduced-size JPEG capture,
  opt-in, auto-purging, images under `stores/gooncitizen/snapshots/`, metadata in
  the Fabric Store `snapshots` collection. Its own docstring: *"so a **future image
  analyzer** can parse gameplay the log does not cover."*
- `main.js` wires the capture via `screenshot-desktop` + Electron `nativeImage`;
  the comment on `SNAPSHOT_TARGET_WIDTH` reads *"big enough for OCR/analysis."*
- `screenshot-desktop` is **already a runtime dependency** — no new dep for capture.
- An always-on-top Electron **overlay window** already exists (`/overlay`,
  `assets/overlay.html`, `overlayAlwaysOnTop` setting).

**Our `app/ocr-parse.js` is precisely the missing analyzer.** That drops the OCR
port from "new subsystem" to "plug a parser into an existing seam," which is why
§4.1 rates it **M**, not L.

**Two honest caveats.** (1) `SNAPSHOT_TARGET_WIDTH = 640` is **too small to OCR a
contract screen reliably** — a higher-resolution or region-cropped capture path is
required, and that is a change to upstream code, not just an addition. (2) The OCR
engine itself (tesseract.js) is still a **new runtime dependency** and needs the
lead developer's agreement under their dependency rule (P12).

---

## 6. Recommended sequencing

Ordered by value ÷ effort, respecting that the owner authorises each step.

1. **`vehicle:collision` upstream (S, ~0% tax).** Small, current-build, fills a real
   gap, establishes the contribution channel. The obvious first move whether or not
   we rebase.
2. **B-001 + Verseview B-002c as one build (M–L combined).** They are the same
   underlying work — parse location + ship, attribute to a member, publish with
   consent. Doing them together lands the longest-blocked item in *both* backlogs
   and produces the one capability no third-party tool offers.
3. **B-011 stability + ship usage (S–M each).** Cheap, unique, already-parsed
   signals; good momentum items to follow (2).
4. **Cargo: port the log-derived half only (L).** Keeps the evidence-grade
   differentiator; concedes the route board to SC DataHub and ContractTracker.
5. **OCR analyzer into `SnapshotManager` (M) — only after a capture-resolution
   decision** with the lead developer.
6. **Park B-010 rep predictor.** Highest cost, most contested, weakest moat.

**Two questions gate everything above:** do we rebase onto `feature/rsi` at all
(`UPSTREAM-RSI-STATE.md` §5.1), and does Verseview consume GoonCitizen as a beacon
source (§5.4)? Items 2 and 5 assume yes to the first; item 2's Verseview half
assumes yes to the second.

---

## 7. Risks to price in

- **Moving target.** Upstream shipped 13 commits in the first two weeks of August;
  `@fabric/*` pins move with Hub RC work and must not be bumped casually (P12). Any
  long-lived port branch pays a continuous rebase tax.
- **Merge-conflict surface.** `services/LiveRelay.js` is 11,147 lines and
  `components/Dashboard.js` is 2,814. Every new route and tab touches both. Land
  changes small and often.
- **No JSX (P6)** is the single largest and most easily under-estimated cost when
  porting anything with a UI.
- **Frozen genesis `messageTypes` (P9).** Any new mesh-crossing feature must ship as
  a non-genesis app message; assuming otherwise means a redesign late.
- **Dependency politics.** tesseract.js is the only genuinely contentious addition
  in this whole analysis. Get agreement before building against it.
- **Ecosystem risk (§2.1).** ContractTracker V2 and SC DataHub are better resourced
  than us in the cargo niche. Competing there costs weeks; the org-accountability
  angle costs less and no one else is doing it.

---

## Sources for §2 (ecosystem scan, checked 2026-08-17)

- [The Best 3rd Party Star Citizen Tools](https://star-citizen.help/guides/getting-started/the-best-star-citizen-tools/)
- [OrgManager](https://orgmanager.space/) · [SC Org.Tools](https://scorg.tools/)
- [UEX — Community Tools / API 2.0](https://uexcorp.space/api/community_made)
- [ContractTracker V2 (Nexus Mods)](https://www.nexusmods.com/starcitizen/mods/34)
- [SC DataHub — Game Tools](https://sc-datahub.com/tools)
- [SC Beacon Net](https://citizen-starter-guide.com/sc-beacon-net-crew-org-finder/)
- [Ozy311/StarLogs](https://github.com/Ozy311/StarLogs) · [PINKgeekPDX/VerseWatcher](https://github.com/PINKgeekPDX/VerseWatcher) · [HalfBakedBaker/SC_LogViewer](https://github.com/HalfBakedBaker/SC_LogViewer)
- [Star Parse](https://starparse.streamlit.app/)
- [Valalol/Star-Citizen-Navigation](https://github.com/Valalol/Star-Citizen-Navigation)
