# BUILD-PLAN-rsi.md — execution plan for porting backlog features onto the RSI fork

> **Third doc in the series.** [`UPSTREAM-RSI-STATE.md`](UPSTREAM-RSI-STATE.md) =
> what diverged. [`PORT-ANALYSIS-rsi.md`](PORT-ANALYSIS-rsi.md) = what it costs
> (patterns P1–P12, LoE bands, risks). **This file = how to actually build it**,
> broken into sub-agent-sized tasks with acceptance criteria and verification
> commands, so a lower-effort execution model can run it without re-deriving
> anything. Where this file and the code disagree, **the code wins** — re-verify
> with the commands given, don't guess.
>
> **Snapshot basis:** upstream `martindale/star-citizen-live @ feature/rsi`
> `a96d5ae` (2026-08-14). **Written:** 2026-08-18.
>
> ⚠️ **D-006 still applies.** Each workstream needs the owner's explicit
> go-ahead before code is written. This plan is the proposal, not the permission.

---

## 0. Execution protocol (read this first, especially on a smaller model)

**You are the orchestrator. Sub-agents do the reading and the bulk coding; you
integrate, test, and commit.** Rules:

1. **One workstream at a time**, in the order of §2 unless the owner reorders.
   Within a workstream, run tasks marked ∥ in parallel; everything else is serial.
2. **Never let a sub-agent commit or push.** Agents return code/diffs/reports;
   the orchestrator applies, runs the verify command, and commits with a
   conventional message (`feat(...)`, `test(...)`, `docs(...)`).
3. **Give every coding sub-agent the Pattern Card (§9.1) verbatim** in its
   prompt. Give every recon sub-agent the file map for its question — don't send
   it to search the whole tree.
4. **Use `Explore` agents for recon** (finding insertion points in the 11k-line
   `LiveRelay.js`, confirming a settings key). **Use `general-purpose` agents
   with `isolation: worktree`** for coding tasks that touch shared files.
5. **Verify before commit, every task:** the task's own verify command, then the
   affected test layer (`npm run test:unit` / `test:relay` / `test:ui`), then
   full `npm test` at each workstream gate. A task is not done until its
   acceptance criteria all pass — no partial credit.
6. **Honesty rules are hard constraints:** never flip a parser rule to
   `verified:true` without a real log line; never emit log-derived data off-node
   without the D-017 consent gate; label inferred metrics as inferred.
7. **If a cited line number is stale** (upstream moves fast), search for the
   quoted code instead. If a *pattern* seems to have changed, stop and re-read
   upstream `AGENTS.md` §3–§5 before proceeding.

### Where the work happens

Two repos, two roles:

| Repo | Path | Role |
|---|---|---|
| `Neorion/star-citizen-live` (origin) | `/home/user/star-citizen-live` | Source of our un-upstreamed code (`git show origin/feature/<branch>:<file>`) + where these docs live |
| `martindale/star-citizen-live` | clone per §1 step 2 | **The build target.** All feature code is written against `feature/rsi` patterns |

**Branching:** for each workstream, branch from upstream `feature/rsi`:
`git checkout -b feat/<ws-name> upstream-rsi/feature/rsi`. Push to
**`Neorion/star-citizen-live`** (we cannot push to martindale). The owner decides
per-workstream whether to open a cross-fork PR to `martindale:feature/rsi`.

### Bootstrap commands (WS0, run once per fresh session)

```bash
# 1. Our repo (docs + source branches)
cd /home/user/star-citizen-live && git fetch origin --prune

# 2. Build target — clone if absent, else fetch
GIT_LFS_SKIP_SMUDGE=1 git clone https://github.com/martindale/star-citizen-live \
  /workspace/martindale/star-citizen-live 2>/dev/null || \
  git -C /workspace/martindale/star-citizen-live fetch origin
cd /workspace/martindale/star-citizen-live && git checkout feature/rsi

# 3. Add our repo as a remote so feature branches can push there
git remote add neorion https://github.com/Neorion/star-citizen-live 2>/dev/null || true

# 4. Environment (Node 24.15.0; Fabric git deps)
node --version   # must be 24.x — use nvm if not
npm i            # .npmrc sets allow-git=all; takes minutes (git deps)
npm test         # MUST be green before any work. If red at HEAD, report and stop.
```

If `npm i` fails on the `@fabric/*` git pins (network/proxy), the **pure-function
workstreams (WS1, most of WS2/WS3 helpers) can still proceed**: leaf helpers and
their `node --test tests/unit/<file>` runs don't need Fabric. Flag the limitation;
don't silently skip the full-suite gate.

---

## 1. Gates — get these answered before starting

| Gate | Question | Blocks | Default if unanswered |
|---|---|---|---|
| **G0** | Owner go-ahead per workstream (D-006) | everything | **Stop.** Present the workstream, wait. |
| **G1** | Do we build against `feature/rsi` (vs staying on our fork)? | WS1–WS5 | This plan assumes **yes**; if no, only WS-alt in §8 applies. |
| **G2** | Does Verseview consume GoonCitizen as a beacon source? | WS2 task T2.6 only | Build WS2 without T2.6; the beacon POST is an add-on. |
| **G3** | Lead-dev agreement on tesseract.js dep + capture width change | WS5 | **Park WS5.** Do not start it speculatively. |

---

## 2. Workstream map

```
WS0 bootstrap ─► WS1 collision rule ─► WS2 participation+beacon ─► WS3 stability+ship-usage
   (½ d)            (1–2 d)               (8–14 d)                     (5–8 d)
                                                                          │
                                              WS4 cargo log-derived  ◄───┘ (independent of WS3,
                                                 (10–14 d)                  needs WS0+G0 only)
                                              WS5 OCR analyzer (parked until G3)
```

| WS | Feature | Backlog | LoE | Sub-agents used |
|---|---|---|---|---|
| WS0 | Bootstrap + golden-slice study | — | ½ d | 1 Explore |
| WS1 | `vehicle:collision` parser rule | fatal-collision branch | S | 0–1 |
| WS2 | Op participation metrics + live beacon | B-001 + Verseview B-002c | M–L | 2 Explore + 3 coding ∥ |
| WS3 | Stability panel + ship-usage view | B-011 ×2 | S–M ×2 | 2 coding ∥ |
| WS4 | Cargo log-derived board port | cargo-router branch | L | 1 Explore + 3 coding |
| WS5 | OCR analyzer into SnapshotManager | cargo Ph2 | M | parked (G3) |

Not planned (per PORT-ANALYSIS): B-010 rep predictor (parked), launchers
(obsolete), Verseview-side items (Python; separate repo, no RSI patterns — plan
separately in `Neorion/Verseview` if G2 = yes, see T2.6 note).

---

## 3. WS0 — Bootstrap + golden slice (orchestrator + 1 Explore agent)

**Goal:** working environment + a written "golden slice" reference the coding
agents copy from.

- **T0.1 (orchestrator):** run §0 bootstrap commands. Acceptance: `npm test`
  green at upstream HEAD (or the pure-function fallback documented).
- **T0.2 (Explore agent):** produce `reports/golden-slice.md` *content* (agent
  returns text; orchestrator writes the file **in the scratchpad, not the repo**)
  describing, with exact code excerpts: (a) `functions/activityHeat.js` full
  text; (b) `components/ActivityHeatmap.js` full text; (c)
  `tests/relay/activityHeat.test.js` full text; (d) the `TABS` array +
  `featureEnabled` (`components/Dashboard.js:44–80`) + one full `case` from the
  render switch (~line 2506); (e) one dual-mounted route block from
  `services/LiveRelay.js` (~6255, the `/peers` one) and the `${base}/analytics`
  route (~5826); (f) the settings-default pattern in LiveRelay's constructor
  (~line 284). This doc is pasted into every coding brief in later workstreams.

**Gate WS0→WS1:** both tasks done; golden-slice doc exists.

---

## 4. WS1 — `vehicle:collision` rule (S; the trust-builder)

No sub-agent needed — this is small enough to do inline; optionally one
general-purpose agent for the whole thing.

- **T1.1 — extract our rule.** In `/home/user/star-citizen-live`:
  `git show origin/feature/fatal-collision-parser:app/parser.js` — the rule is
  the `kind: 'vehicle:collision', tag: 'FatalCollision'` block (~lines 165–191),
  VERIFIED across 236 real lines on 4.6–4.8.0. Also extract its tests:
  `git show origin/feature/fatal-collision-parser:test/parser.test.js` (the 25
  added lines) and the server fold (`app/server.js` diff, 41 lines) for reference.
- **T1.2 — port the rule.** Add the block to upstream `functions/parser.js`
  `RULES`, adjacent to the other current-build rules (after `player:death`).
  Keep the comment block including the "CIG's typo 'occured'" note and
  `verified: true` (legitimately — it was verified on real lines; carry the
  corpus citation in the comment). `shipName` is already in scope in that file.
- **T1.3 — tests.** Port the real-line test cases into
  `tests/relay/parser.test.js` style (check where existing parser tests live:
  `ls tests/relay/ | grep -i pars` — if a `corpus.test.js`/parser suite exists,
  extend it; else new `tests/relay/parser-collision.test.js`).
- **T1.4 — optional fold (ask owner):** add `vehicle:collision` to
  `functions/cumulativeHistory.js` (mirror how `quantum:select`/`arrive` fold at
  ~line 203, with an `idFor` dedupe key) and to `functions/liveFeed.js` so it
  appears in the Feed. This is the difference between "rule exists" and
  "feature visible" — small, but it touches shared files, so name it in the PR.

**Verify:** `npm run test:relay` green; `npm run replay <real ≤4.8 log>` counts
collisions. **Acceptance:** rule fires on the 236-line corpus sample lines;
no other rule's counts change (regression check via existing corpus test).

**Deliverable:** branch `feat/vehicle-collision` pushed to `neorion` remote;
owner decides on the cross-fork PR (this is the goodwill contribution).

---

## 5. WS2 — B-001 participation metrics + B-002c beacon (M–L; the centerpiece)

**Design (one paragraph):** all inputs already exist upstream — `quantum:*`
events (location), `vehicle:control`/`stow` (ship), sessions + missions in
cumulative history (time), `presence.js` (online window + visibility),
`SCEventBatch` + D-017 (consented multi-member aggregation). We add: **one pure
metrics module** (given an op window + event streams → per-member participation
rows), **one route**, **one panel**, an **op-window source** (manual first,
Discord Events later), and — gated on G2 — **one beacon POST adapter**.

### Recon (run both ∥, Explore agents)

- **T2.0a:** map exactly which event kinds reach `_analyticsDataset()`
  (`services/LiveRelay.js:4060`) and what a history record looks like for
  `quantum`, `sessions`, `missions` (read `functions/cumulativeHistory.js`
  record shapes). Return: field-by-field shapes + whether `vehicle:control`
  events are folded into history (at snapshot time they were **not** — if still
  true, T2.1 consumes them from the live event stream and T2.2 must also fold a
  compact `shipUse` record into cumulativeHistory; confirm).
- **T2.0b:** map the D-017 share path end-to-end: `_canShareLogs()`
  (`LiveRelay.js:2733`), where `SCEventBatch` is built/sent (~10013–10023), how
  per-peer `shareLogs` grants are stored, and how inbound peer batches fold into
  analytics (~4349). Return: the exact function names + a 20-line summary.

### Build (T2.1–T2.3 ∥ after recon; T2.4–T2.5 serial after them)

- **T2.1 — `functions/opParticipation.js`** (general-purpose agent, worktree).
  Pure module, `activityHeat.js` mould. Exports:
  - `opWindow({ start, end, name })` → validated window object;
  - `participationRows(history, window, opts)` → per-member rows
    `{ member, activeMinutes, missionsInWindow, missionsCompleted, deaths,
    ships: [{ ship, minutes }], locations: [{ zone, firstSeen, lastSeen }],
    inferred: true }`. Active minutes = union of session overlap with the
    window, clamped; locations from `quantum` records; ships from `shipUse`
    records (or live events per T2.0a's finding).
  - `splitSuggestion(rows, formula)` → **advisory** shares for
    `formula ∈ {'equal','byActiveMinutes','byMissions'}`; every output object
    carries `inferred: true` and `advisory: true`. **No officer verdicts here**
    (D-005: officers decide; we provide inputs).
  - Full JSDoc; zero I/O; **≤250 lines**. Test: `tests/unit/opParticipation.test.js`
    — window edge cases (event straddling start/end, empty history, member with
    sessions but no missions, timezone-naive ts handling).
- **T2.2 — persistence + settings** (general-purpose agent, worktree). If T2.0a
  confirmed ship-use isn't in history: fold a compact record from
  `vehicle:control` into `functions/cumulativeHistory.js` (mirror the quantum
  fold + dedupe-Set pattern at ~124/203). Add an `ops` collection to the Fabric
  Store (P4 — via `types/Store.js` collections, **never raw `fs`**) storing
  operator-defined op windows `{ id, name, start, end, createdBy }`. Settings
  defaults in the LiveRelay constructor block (~284): none needed beyond
  existing share gates for this task. Test in `tests/relay/`.
- **T2.3 — routes** (general-purpose agent, worktree). In `LiveRelay.js`, using
  the dual-mount pattern (golden slice (e)):
  - `GET|POST ${base}/ops` — list/create op windows (400 on bad dates);
  - `GET ${base}/ops/:id/participation` — runs `participationRows` over the
    merged local+peer analytics dataset (reuse `_analyticsDataset()`), plus
    `?formula=` for `splitSuggestion`.
  - **Consent invariant:** these routes read *already-consented* data (local +
    inbound peer batches). They must not trigger any new outbound share.
  Test: `tests/relay/opParticipation-routes.test.js` (copy an existing
  relay HTTP test's server-boot harness — see `tests/relay/api.test.js`).
- **T2.4 — panel** (general-purpose agent, worktree; **give it the golden
  slice**). `components/OpParticipation.js`: op selector (list from `/ops`),
  create-op form (name/start/end), participation table, formula dropdown showing
  advisory shares with an explicit "inferred telemetry — officer decides"
  caption. `React.createElement` only, per-component `CSS` constant, ≤400 lines.
  Register: add to `TABS` in `Dashboard.js` (key `ops`, label `Ops`) + render
  `case` + it respects `featureEnabled('ops')`. Test: `tests/ui/ops-panel.test.js`
  using the `tests/helpers/reactStub.js` harness (copy `missions-shell.test.js`
  structure).
- **T2.5 — integration + docs** (orchestrator). Wire-through check: create op →
  replay a log → participation rows appear. Full `npm test`. Update upstream-PR
  description text; note the Discord-Events op-window hook as future work (the
  bot bridge exists; the Scheduled-Events listener does not — do **not** build
  it in this WS).
- **T2.6 — beacon POST (only if G2 = yes)** (general-purpose agent).
  `functions/beaconPost.js`: pure payload builder
  `beaconPayload(presence, lastQuantum, member)` →
  `{ handle, location, ship, ts, source: 'gooncitizen-log' }`. LiveRelay: a
  timer that, **only when** `settings.verseview.beaconUrl` is set **and** a new
  explicit `settings.verseview.shareBeacon === true` (default **false** —
  mirrors D-017; do not reuse `shareLogsGlobal`), POSTs on quantum:arrive /
  presence change, throttled ≥60 s. Settings UI: one row in
  `components/Settings.js` (URL + toggle). Tests: unit (payload) + relay
  (gate: no POST when off — assert via injected fetch stub).
  *(Verseview's `/api/beacon` seam + B-018 ladder are Python work in
  `Neorion/Verseview` — separate plan there; keep this side to the POST.)*

**Gate WS2→WS3:** full `npm test` green; owner demo of the Ops panel on a
replayed real log; honesty labels present in UI and API payloads.

---

## 6. WS3 — B-011 stability + ship usage (two S–M tasks, fully ∥)

Both are "already-parsed signal → rollup helper → panel section". Run as two
parallel general-purpose agents (worktrees), each briefed with the golden slice.

- **T3.1 — stability & session health.**
  - `functions/sessionHealth.js`: from history sessions + `session:disconnect`
    events → per-build rows `{ build, sessions, disconnects, crashes,
    disconnectsPerSession, medianSessionMinutes }`. (Recon note: check whether
    disconnect events fold into cumulative history; if not, add the fold —
    same pattern as T2.2. Crash inference = session that ends without a
    clean marker; label it inferred.)
  - Route `GET ${base}/session-health`; panel **section inside the existing
    Analyze surface** (find where analytics panels render — search
    `components/` for `analytics`; do NOT add a new top-level tab for this).
  - Tests: unit (rollup math incl. zero-session build) + relay (route) + ui.
- **T3.2 — ship usage.**
  - `functions/shipUsage.js`: from `vehicle:control`/`stow` (+ T2.2's history
    fold, if landed — coordinate: if WS2 shipped, consume its `shipUse`
    records instead of re-deriving) → per-ship
    `{ ship, shipName, sessions, minutes, lastFlown }` per member.
  - Route `GET ${base}/ship-usage`; Analyze section with `shipCatalog`
    prettified names.
  - Tests: unit + relay + ui.

**Naming rule (from PORT-ANALYSIS):** nothing in this WS may be called
"Wallet" — upstream Wallet = Bitcoin.

**Gate:** full `npm test`; both sections visible on replayed data.

---

## 7. WS4 — Cargo, log-derived half only (L; the disciplined port)

**Scope discipline:** port rows 2+3 of PORT-ANALYSIS §4.1 only — the
log-derived board + UEX vocab. **No OCR (that's WS5/G3), no route-board
ambitions beyond what we already had** (SC DataHub owns that niche); our angle
is member-attributed, register-joinable evidence.

- **T4.0 (Explore, recon):** confirm which of our three regexes are already
  covered by upstream rules: our `ACCEPT_RE`≈`mission:contract` +
  `mission:start`; `OBJECTIVE_RE`≈`mission:objective`; `DROPOFF_RE` — check for
  an upstream equivalent (search `functions/parser.js` for `Dropoff`; at
  snapshot there was **none**). Return: a mapping table + the exact `fields`
  each upstream rule yields.
- **T4.1 — parser gap** (small): add a `mission:dropoff` rule to
  `functions/parser.js` from our `DROPOFF_RE`
  (`git show origin/feature/cargo-router:services/CargoRouter.js`, lines ~94–98),
  `verified: true` with corpus citation carried over. Test with real lines from
  our cargo test fixtures (`git show origin/feature/cargo-router:test/cargo.test.js`).
- **T4.2 — pure logic** (general-purpose, worktree): split our
  `CargoRouter.js` (483 lines) per P2: the stateless parts
  (`bodyFromStation`, `bodyFromToken`, route grouping/sorting, SCU math,
  `STANTON`/`BODY_ORDER` tables) → `functions/cargoRoute.js`, **consuming
  upstream parser events** (`mission:contract`/`objective`/`dropoff` fields per
  T4.0's mapping) instead of re-matching raw lines. Stateful
  accumulation/lifecycle (TERMINAL states, session carry-over) →
  `services/CargoRouter.js` upstream-style (EventEmitter, injected store).
  Port `test/cargo.test.js` (332 lines) split across `tests/unit` (route math)
  + `tests/relay` (lifecycle). This is the biggest single task in the plan;
  give the agent our full original file + T4.0's mapping + the golden slice.
- **T4.3 — UEX vocab** (small ∥ with T4.2): `data/uex-reference.json` +
  `services/uexClient.js` + `scripts/build-uex-vocab.js` port — follows
  upstream's `data/ships/catalog.json` + `refresh-ship-catalog.js` convention
  almost 1:1. Port `test/uex.test.js` → `tests/unit/`.
- **T4.4 — panel** (general-purpose, worktree, golden slice): `components/Cargo.js`
  rewriting our ~590-line HTML board as `createElement`; `TABS` entry `cargo`
  gated `featureEnabled('cargo')` **default off** (feature-flag politeness on
  someone else's trunk); route `GET ${base}/cargo` for board state. UI test in
  `tests/ui/`.
- **T4.5 — register join** (orchestrator, small): cargo missions carry
  `MissionId` — surface a "seen in register" cross-link where the id matches a
  `source:'gamelog'` register row (read-only join; no register writes).

**Gate:** full `npm test`; board populates from a replayed real hauling log.

---

## 8. WS5 — OCR analyzer (PARKED until G3) + WS-alt

**WS5 (do not start without G3):** plug `ocr-parse.js` (`git show
origin/feature/cargo-router:app/ocr-parse.js`, 125 lines, already dependency-free
parsing logic) into `services/SnapshotManager.js`'s injected-analyzer seam. The
two G3 items to negotiate first: tesseract.js as a dep, and a capture path
better than `SNAPSHOT_TARGET_WIDTH = 640` (region crop or per-capture width
override in `main.js:applySnapshotCaptureToService`). Until then, T4.2's board
accepts manual entry as the non-log intake.

**WS-alt (if G1 = no, we stay on our fork):** only WS1's inverse applies —
backport upstream's `quantum:*` + `vehicle:control`/`stow` rules into our
`app/parser.js` (S–M, same P8 compatibility) and build B-001 on our own stack.
Everything else in this plan assumes G1 = yes.

---

## 9. Standing sub-agent briefs

### 9.1 Pattern Card — paste verbatim into every coding brief

```
Conform to these patterns (evidence in PORT-ANALYSIS-rsi.md §1). Violations = rework:
1. CommonJS, 'use strict', 2-space indent, semicolons, single quotes.
2. JSDoc @param/@returns on every exported function.
3. functions/ modules are PURE: no fs, no network, no timers, no state.
   Stateful code goes in services/ (EventEmitter class, injected store).
4. Persistence ONLY via the Fabric Store collections (types/Store.js) — never raw fs.
5. Routes: dual-mount string compare in LiveRelay's handler:
   if (pathname === `${base}/x` || pathname === '/x') { ... }
   Errors: 403 officer-forbidden, 404 not-found, else 400.
6. UI: React CLASS components, React.createElement ONLY — NO JSX. Per-component
   CSS template-literal constant. Match ActivityHeatmap.js structure.
7. New tab = three touch-points: TABS array + render-switch case +
   featureEnabled(key) gate (components/Dashboard.js:44-80, ~2506).
8. Parser rules: { kind, tag, test: /re/, fields: (m) => ({...}), verified: bool }.
   NEVER set verified:true without a real log line; cite corpus + game version.
9. Mesh messages: genesis messageTypes is FROZEN; new types ship as non-genesis
   app messages (NoteShare precedent). Prefer not crossing the mesh at all.
10. D-017: no log-derived payload leaves the node without an explicit opt-in
    setting that defaults to FALSE.
11. Tests: unit → tests/unit/, LiveRelay/parser → tests/relay/, HTTP flows →
    tests/integration/, component trees → tests/ui/ (reactStub harness).
    Node built-in runner (node:test + node:assert).
12. Do NOT touch package.json deps, @fabric/* pins, or contracts/ genesis.
13. Return your work as complete file contents + a list of edits to shared
    files (LiveRelay.js, Dashboard.js) as minimal anchored diffs. Do not commit.
```

### 9.2 Recon brief template (Explore agents)

```
Read-only recon in /workspace/martindale/star-citizen-live (branch feature/rsi).
Question: <one specific question>.
Start from these files/lines: <from this plan>. If line numbers are stale,
search for the quoted code. Return: exact answer + code excerpts + file:line
citations. Do not summarize the whole codebase.
```

### 9.3 Verification checklist (orchestrator, per task)

```
[ ] Task's own verify command passes
[ ] Affected layer green (test:unit / test:relay / test:ui)
[ ] No changes to package.json, contracts/, @fabric pins (git diff --stat check)
[ ] New sharing paths default OFF (grep the new setting's default)
[ ] Inferred metrics labelled inferred/advisory in payload AND UI
[ ] Commit message conventional; no model identifiers in committed artifacts
[ ] At workstream gate: full npm test + push branch to neorion remote
```

---

## 10. Definition of done (whole plan)

| WS | Done means |
|---|---|
| WS1 | `feat/vehicle-collision` pushed; corpus regression unchanged; owner has PR decision in hand |
| WS2 | Ops tab live on replayed data; split suggestions labelled advisory; beacon POST off-by-default (or skipped per G2) |
| WS3 | Stability + ship-usage sections in Analyze; no "Wallet" naming |
| WS4 | Cargo tab (flag-off) populating from a real hauling log; register cross-link works |
| WS5 | Not started unless G3 recorded in DECISIONS.md-style note from the owner |

**Standing risk to manage throughout** (PORT-ANALYSIS §7): upstream moves —
rebase each feature branch onto fresh `feature/rsi` at every workstream boundary,
and keep every branch small enough that a conflict in `LiveRelay.js`/`Dashboard.js`
is an hour, not a day.
