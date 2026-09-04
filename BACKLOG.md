# Idea Backlog

Parked ideas not yet scheduled. Each notes *what*, *why*, and an honest
*feasibility* read against what the `Game.log` actually provides (we know its
limits well — see `sc-log` findings in `PROGRESS.md` / memory). Promote to a
milestone in `PROGRESS.md` when picked up.

---

## B-010 — Cargo Phase 3: rep-progression predictor + load selection
**Added:** 2026-07-02 · extends `DESIGN-cargo-planning.md` (Phases 1–2 shipped on `feature/cargo-router`)

**What:** (a) **Rep predictor** — "≈N more Small Hauls to reach *Member* with Red Wind."
(b) **Load selection** — "which subset of my candidate offers best fills a 64-SCU hold?"

**Why:** natural next value once the OCR import funnel exists; rep is the log's biggest gap.

**Feasibility (evidence-based):**
- ✅ **Rank per contractor** — the contract *title* embeds the current rank (real logs:
  `Junior | Stellar Small Haul` (Red Wind), later `Member | Small Haul`). Tracking the
  rank prefix per faction over time = a progression curve from the log alone.
- ✅ **Rep-per-completion** — the contract screenshots we already OCR carry
  `Reputation Awarded (by difficulty): 50/100/250/500`; the Analyze tab already counts
  completions per faction. Fusion → the predictor.
- ⚠️ **Absolute progress to next tier** — needs OCR of the **rep screen** (a *new* crop
  profile + likely its own tab). This is why Phase 3 = new scope, not a slice of Phase 2.
- ✅ **Load selection** — self-contained on the cargo board: reward (OCR) ÷ total SCU →
  reward-per-SCU; greedy/knapsack pick within the ship's SCU. Reuses the shipped model.

**Shape:** selection is a small in-board add (client-side over the route data). The rep
predictor is a new consumer of the OCR funnel + a rep-screen profile → own tab. Owner
go-ahead needed before building (per D-006).

## B-012 — "New game session" button (force the board to re-baseline the log)
**Added:** 2026-07-02 · owner-requested

**What:** A button on the Cargo/board UI that forces the relay to treat `Game.log`
as a fresh session — re-read from the current session start, clear carried-over /
stale flags, and re-sync the board to the current in-game state.

**Why:** after relaunching the game (new session), the board can hold stale
carried-over missions from the prior session; the owner wants a one-click
re-baseline instead of restarting the relay.

**Shape (log-only, no OCR):** POST `…/cargo/action {action:'resync'}` (or a service
route) that: resets the session counter, drops carried-over/awaiting log missions
not present in the current session, and re-seeds from the live `Game.log` tail.
Keep manual + OCR imports (candidates) unless the user also chooses to clear them.
Pairs with the existing session-restart detection (§carried-over). Small, self-contained.

## B-011 — New value-add tabs from the log (evidence-counted 2026-06-30)
**Added:** 2026-07-02

Corpus sweep of candidate signals (file counts). Each = an optional module + tab + flag,
so the core stays lean. Priority order noted.
- **🛡 Stability & session health** — `Channel Disconnected cause=…` + crash/restart
  (already detected). **492 files.** Disconnects/crashes per build ("is 4.8.184.x worse?").
  Cheap, log-only, unique. *(Priority 1 — cheapest unique value.)*
- **📋 Insurance / fleet attrition** — `CWallet::ProcessClaimToNextStep New Insurance
  Claim Request`. **328 files.** Claims over time vs deaths/collisions = cost-of-ops.
- ✅ **Crew / party** — `<PlayerJoined> mission_id … player_id …`. **165 files.** Who you
  flew with + shared missions; directly feeds the M4 org-wide convergence model.
  **Shipped** on `feature/crew-party` (merged 2026-08-29) — see `PROGRESS.md`.
- **💰 Wallet / trading-lite** — `SendShopBuyRequest … shopName[…] client_price[…]`.
  **136 files.** Prices actually paid; a lead toward a trading assistant.
- **🚀 Ship usage** — ship IDs in nav/QT/collision lines. *Lead — needs a verification
  pass* for a clean "ship-in-use" session signal.

---

## B-001 — Op participation & loot-split metrics (time-on-site, time-on-mission, ship used)
**Added:** 2026-06-14

**What:** During an operation (e.g. the **Hathor** op), capture per-member:
- **time on mission / time in the op** (active minutes within the op window),
- **presence on-site / near a station** over time (where they were, when),
- **ship type(s) used**,
so the org can split loot fairly by contribution rather than by guesswork.

**Why:** large ops need a defensible basis for dividing rewards; "time on
mission + role/ship" is a fairer, less-arguable input than memory.

**Feasibility (from the log — per member running the relay):**
- ✅ **Time-on-op / time-on-mission** — straightforward. We already track sessions
  (login→logout) and mission timestamps; "active minutes in the op window" is the
  `active-player-minutes per operation` metric already noted in the brief. The op
  window comes from the **Discord Events hook** (event start/end).
- ✅ **Ship type(s) used** — derivable. Ship IDs (`MANUFACTURER_Ship_<id>`) appear in
  the log and `shipName()` already prettifies them (e.g. `DRAK_Corsair` → "Corsair").
  Need to pick the spawn/board lines that mark "the player flew ship X".
- ⚠️ **On-site / near-station presence over time** — *partial*. The log has location
  signals (zone names like `OOC_Stanton_2c_Yela`, jurisdiction notices "Entered
  Hurston Dynamics Jurisdiction", "Entered Monitored Space", quantum-travel/location
  lines). So coarse "where + when" is recoverable, but zones are codenames and
  "near station X" needs interpreting position/zone → would benefit from the
  name-enrichment idea (global.ini / DataForge; see `REFERENCES.md`).
- ➡️ **The loot split itself** is an org-policy calculation on top of these inputs
  (officers decide the formula); we provide the metrics, not the verdict.

**Prerequisites:** members run the relay; Fabric mesh sync so member relays
aggregate each other's opted-in events (M4, per D-008 — replaces the earlier
central-VPS plan; no central aggregator to build, each relay shares its own
data directly); the Discord-Events op window; optional location-name enrichment.

**Confidence / honesty:** this is **inferred telemetry** (engagement/presence),
clearly labelled as such — an *input* to an officer's loot decision, not a
validated truth. Non-relay members won't appear.

**Related:** Discord Events hook (§5 brief) · metrics table (§6) · mission grouping ·
name-enrichment (`REFERENCES.md`: unp4k / StarCitizen-GameData).

---

## B-013 — Re-parse: store raw classified event fields, not just derived summaries
**Added:** 2026-09-04 · design learning from a cross-project assessment
**Correction (2026-09-04):** a follow-up deep-dive found StarLogs' "Reprocess Log"
does NOT reclassify in place — it clears its store and replays the log file from
disk (`web_server.py` `/reprocess` → `log_monitor.trigger_reprocess()` →
`replay_entire_log()`). No surveyed project (StarLogs, SC Bridge Companion,
all-slain, SCLogReader) actually stores raw fields for in-place reclassification —
this idea is more advanced than the prior art, not borrowed from it. Kept as our
own design, credited honestly.

**What:** `scripts/backfill.js` currently bakes `missionType()`/`missionFaction()`/
`disconnectCategory()` output directly into `stores/history.json` and discards the
raw fields the classifiers ran on. Instead, store the raw classified-but-uninterpreted
event fields (generator name, disconnect cause code, etc.) alongside — or instead
of — the derived summary, plus a re-derive step that recomputes summaries from
those stored raw fields without re-reading the original `Game.log` files.

**Why:** every time a classifier improves — real precedent: the faction-fallback
work that cut type-"Other" from 45% to 14% — the only way to apply it to existing
history today is a full re-scan of the original log files, which may not even
still exist on a member's machine anymore. A re-parse step turns that into a
few-seconds operation over the existing store.

**Feasibility (from the log):**
- ✅ **The raw fields already exist mid-computation** — `ingestFiles()` already
  has `gen[ev.missionId]` (the generator name) and `ev.cause` (disconnect cause)
  in scope right where it calls `missionType()`/`disconnectCategory()`; storing
  them costs nothing new to parse, only a slightly larger `stores/history.json`.
- ✅ **A `reparse(store)` function is pure** — feed the raw fields back through
  the current classifier versions, get fresh `type`/`faction`/`category` values.
  No file I/O, no corpus access required.
- ⚠️ **Store size** — raw fields roughly double the per-record footprint; still
  small relative to the log corpus itself (missions/deaths/disconnects are
  already a compact summary, not raw lines).

**Prerequisites:** none — self-contained change to `scripts/backfill.js` +
`app/server.js`'s history loading, plus a `npm run reparse` entry point (or a
dashboard action) that calls it.

**Confidence / honesty:** an internal-tooling improvement, not a new data source —
doesn't change what's validated vs. inferred, just how cheaply we can fix
misclassification after the fact.

**Related:** `missionType`/`missionFaction`/`disconnectCategory` (`app/parser.js`) ·
the faction-fallback retrospective (`PROGRESS.md`, 2026-06-19) · B-011 (stability).

**Addendum — parser/schema version stamp (from SCLogReader's `Database.cs`):**
tag `stores/history.json`'s `meta` with a `parserVersion`, and have the dashboard
nudge "history built with parser vN, current vM — run backfill/reparse" when they
differ. Answers *when* to re-derive; B-013 above answers *how*, cheaply.

## B-014 — Event category taxonomy (Lifecycle / Combat / Economy / Movement / Operational)
**Added:** 2026-09-04 · design learning from a cross-project assessment
**Correction (2026-09-04):** a follow-up deep-dive could not find any real "StarStats"
project (no Rust Star Citizen log parser exists on GitHub as far as a genuine
search could confirm) — this taxonomy is our own synthesis, not borrowed from a
verified source. For context, real surveyed projects' taxonomies are looser:
StarLogs uses a flat 13-value enum, SCLogReader a ~30-kind enum grouped only by
code comments, SC Bridge Companion ~30 commented sections over 57 patterns. Our
5-bucket version is cleaner than any of those — credited as ours, not theirs.

**What:** A thin `category(kind)` pure function, alongside `missionType`/
`missionFaction`, mapping each existing `kind` value to one of five top-level
buckets: **Lifecycle** (login/session/disconnect), **Combat** (kills/incap/death),
**Economy** (wallet/trading — B-011, unbuilt), **Movement** (ship usage/quantum
travel — B-011, unbuilt), **Operational** (crew/party, op-participation — B-001).

**Why:** purely organizational, but it retroactively explains this backlog's own
shape — every B-011 item slots into one of these five buckets — and gives the
dashboard's "recognized events" panel a natural grouping instead of a flat list,
without touching how any individual rule works.

**Feasibility (from the log):** ✅ mechanical — every `kind` value already exists;
this is a lookup table over strings we already emit, same shape as `missionType`'s
`MISSION_TYPES` array. No new parsing, no new data.

**Prerequisites:** none.

**Confidence / honesty:** organizational metadata only — doesn't change what's
validated vs. inferred for any individual event.

**Related:** `missionType`/`missionFaction` (`app/parser.js`) · B-011 (Economy/
Movement items still unbuilt) · B-001 (Operational).

## B-015 — Parser audit: per-rule corpus-hit ledger + unmatched-line report
**Added:** 2026-09-04 · design learning, VERIFIED real (SC Bridge Companion, SCLogReader, all-slain)

**What:** A `scripts/audit.js` (or a `--audit` flag on `scripts/replay.js`) that
runs every `RULES` entry against `Gamelogs/` and reports three things: per-rule
hit counts with one example line, which rules got **zero hits** (a rule "verified"
in a comment but dormant against the current corpus), and the top unmatched
`Added notification "…"` prefixes (candidate new `hud:notification` → real rules).

**Why:** this mechanises a discipline we already do by hand — rule comments cite
exact hit counts ("617 occurrences", "417 real kills") and the `verified` flag —
but nobody currently *runs* anything to check those counts are still true as the
corpus grows or the game patches. Real precedent, not a guess: SC Bridge
Companion's `docs/parser-patterns.csv` ships exactly this (Pattern Name / Event
Type / Output Fields / Corpus Hits / Example Input Line) and their own audit
against 180 log files found zero-hit rules and duplicate patterns; SCLogReader
tracks unmatched lines in a live `ConcurrentDictionary<string,int>`; all-slain's
`tools/new_event_types.py` prints every never-before-seen `<EventType>` tag once.

**Feasibility (from the log):**
- ✅ **Fully mechanical over what we already have** — `RULES` already carries
  `kind`/`tag`/`test`; running each against `Gamelogs/` and tallying matches needs
  no new parsing, no new data, no schema change.
- ✅ **Directly operationalizes AGENTS.md's own rule** ("a rule can be verified on
  4.3.0 yet not fire on 4.8.0") — turns a prose caveat into a number you can watch
  drop to zero across a patch.

**Prerequisites:** none — a read-only script over the existing corpus.

**Confidence / honesty:** tooling, not a data source — makes existing honesty
claims (hit counts in comments) checkable instead of asserted.

**Related:** `RULES` (`app/parser.js`) · `scripts/replay.js` · AGENTS.md §6
(parser honesty / `verified` flag) · B-013 (re-parse — a rule audit is the natural
trigger for "time to re-derive history").

---

## B-016 — Two-line event coalescing seam (pending-slot pattern)
**Added:** 2026-09-04 · design learning, VERIFIED real (SC Bridge Companion `internal/logtailer/parser.go`, SCLogReader `Core/LogParser.cs`); shape confirmed in our own corpus 2026-09-04

**What:** A single named "pending" slot in the parser — not a general buffering
engine — that one rule can set, the very next matching rule can complete, and
any other line clears. Needed for the one two-line event we have real evidence
of: a player-to-player money transfer, logged as
`Added notification "You sent <name>:` followed by an untagged
`<ts> <n> aUEC` line.

**Why:** `parseLine` is stateless per line. Our existing cross-line joins are
*keyed joins* (`missionId`/`objectiveId` in `_indexMission`) or *first-line-wins*
(the `player:death` rule keys on the `body_01_noMagicPocket` line and ignores the
~30 gear lines that follow) — neither fits "line A sets context, line B completes
it, unrelated line clears it." Today the header line is swallowed by the
`hud:notification` catch-all and the amount line lands as `log:raw`, so the
transfer is invisible.

**Feasibility (from the log):**
- ✅ **Real in our corpus:** 18 files (Deadman) carry the pair; 11 with a
  recipient, 7 with it blank (`"You sent :`). Amount units are **unverified** —
  values like `1005000000` and `5025` appear side by side and look scaled.
- ✅ **Confirmed shape from two independent projects.** sc-companion's
  `parser.go` holds `pendingType string; pendingData map[string]string`; a
  `money_sent_pending` pattern sets it and returns no event, `money_amount`
  completes it only `if p.pendingType == "money_sent"`, and the default branch
  calls `clearPending()`. SCLogReader's `LogParser.cs` does the same with
  `_pendWho / _pendDir / _pendTime` and an `AmtLine` regex.
- ⚠️ **Neither reference has a timeout, and SCLogReader never clears at all** —
  its `_pendTime` is only copied into the emitted event, and an intervening line
  leaves the slot armed indefinitely. sc-companion clears on any other matched
  line. We should clear on any non-completing line *and* add a small window using
  the pending line's own timestamp (not wall-clock — replay/backfill must behave
  identically), so a dropped second line can't hang the slot in `handleLogChange`.
- ⚠️ **Placement:** the slot must be checked *before* the `hud:notification`
  catch-all, and untagged continuation lines are the norm (most
  `SHUDEvent_OnNotification` lines are followed by an untagged echo of their own
  text), so the completer must match its exact shape, not "next untagged line."

**Prerequisites:** none — the money-transfer pair is the concrete first use.
Not a B-011 dependency: B-011's wallet evidence (`SendShopBuyRequest …
client_price[…]`) is single-line, and crew/party is already shipped on the
single-line `<PlayerJoined>` rule.

**Confidence / honesty:** a parsing-mechanism improvement plus one new signal.
Mark the coalesced `kind` `verified: true` only once both halves and the amount
unit are confirmed against real logs.

**Related:** `_indexMission` (`app/server.js`) · `player:death` and
`hud:notification` rules (`app/parser.js`) · B-011 (wallet/trading-lite) · B-014
(Economy bucket).

---

## B-017 — Version metadata on parser rules (verifiedOn / dormantSince)
**Added:** 2026-09-04 · design learning, VERIFIED real (all-slain `handler.py` / `compatibility.py` / `build.py`)

**What:** Optional `verifiedOn: ['4.7.175', '4.8.180']` / `dormantSince: '4.3.2'`
fields on `RULES` entries, surfaced in `/monitor` (a new key — `RULES` is already
exported) and in B-015's audit ledger — metadata only, never used to skip a rule.

**Why:** the version caveat already exists as prose (the kill / `vehicle:destroy`
"≤ 4.3.0 only" comment block) — this makes it a queryable field, so the dashboard
or B-015's audit can say *which* rules are version-gated without grepping comments.

**Feasibility (from the log):**
- ✅ **Real precedent; deliberately NOT copying the runtime behaviour.** all-slain
  gives every handler class an `is_compatible(version, build)` classmethod (via
  mixins such as `SinceV420` in `compatibility.py`), and `build.py` reads
  `Changelist:` then *filters out* incompatible handlers before matching. We
  decline that part: `backfill.js` / `replayLog` process mixed-version corpora in
  one pass, and a "dormant" rule unexpectedly matching on a new build is exactly
  the signal we want to see, not suppress.
- ✅ **Additive-only** — no change to `parseLine`'s matching; `verified` today is
  just `rule.verified !== false`, and the new keys sit beside it.

**Prerequisites:** none. Pairs with B-015 (where the metadata becomes visible).

**Confidence / honesty:** documentation-as-data, not a new signal.

**Related:** kill / `vehicle:destroy` version caveat (`app/parser.js`) ·
`parseSessionInfo` (already captures `fileVersion` / `branch` / `changelist`) ·
B-015 · AGENTS.md §6 ("verified" must be qualified by game version).

---

## B-018 — Generated zone/location reference table + "unknown" surfacing
**Added:** 2026-09-04 · design learning, VERIFIED real (all-slain `tools/extract_actors.py`, `.github/ISSUE_TEMPLATE/location.yml`)

**What:** IF B-001's "presence on-site / near a station" work is picked up,
generate a committed zone-name lookup table in the same *shape* as
`data/uex-reference.json` (build-time script → committed JSON, served offline,
refreshed on demand) — from a **different source**: game data, not the UEX API.
Try the player's own `global.ini` first (local, read-only, ships with the game;
**untested** whether zone codenames like `OOC_Stanton_2c_Yela` key into it —
mission codenames do not), falling back to DataForge extraction (unp4k +
StarCitizen-GameData, per `REFERENCES.md`). Plus a dashboard affordance listing
the top *unresolved* zone/generator tokens, so the owner sees what's missing
instead of it silently becoming "Unknown".

**Why:** the generator convention already works for cargo vocab; extending it
to zone names is a small, consistent step. The "surface what's unresolved"
affordance is a cheap, real safety net: all-slain prints a red "?" before an
unrecognised location id and ships a GitHub issue template for reporting it.
Today `missionFaction` falls back to `'Unknown'` and nothing counts how often.

**Feasibility (from the log):**
- ✅ **The generator pattern exists** — `scripts/build-uex-vocab.js` →
  `data/uex-reference.json` (`npm run build-vocab`).
- ❌ **Declining a generated NPC dictionary** (all-slain's ~1,500-entry `ACTORS`
  table, regexed out of scunpacked's `Game2.xml`) — kills aren't logged on the
  current build (4.8.0), so NPC classification only serves ≤ 4.3.0 replay: not
  enough to justify a game-data extraction pipeline today.
- ⚠️ **Not a standalone build** — only matters once B-001 is picked up; listed
  as the shape to reach for then.

**Prerequisites:** B-001 being picked up; a build-time data source (global.ini
or unp4k / StarCitizen-GameData). Extraction tooling runs at build time only —
no runtime dependency (AGENTS.md §6).

**Confidence / honesty:** the table is generated from a versioned data source
and committed, so its provenance is checkable; which source resolves zone
codenames is not yet verified.

**Related:** `scripts/build-uex-vocab.js` / `data/uex-reference.json` · B-001 ·
`REFERENCES.md` (unp4k / StarCitizen-GameData) · `missionFaction` fallback
(`app/parser.js`).

---

## B-019 — Quantum travel: destination + calibration tracking
**Added:** 2026-09-04 · evidence-counted via `scripts/audit.js` (B-015)'s first real run

**What:** A `quantum:calibrating` (or similar) rule for
`Added notification "Quantum Travel Calibration Started By <handle>: "` — the
zero-MissionId `hud:notification` catch-all currently swallows this text whole.
`app/parser.js` already has a standing TODO for quantum travel ("re-add only
with a confirmed `<Quantum Travel>` line format from a real log") — B-015's
audit ledger is that confirmation.

**Why:** the single highest-volume generic notification in the whole corpus by
a wide margin (see feasibility) — a real, currently-wasted destination/movement
signal, and the concrete unblock for B-011's "Ship usage" item and B-001's
"presence on-site" component (coarse where+when via quantum-travel legs).

**Feasibility (from the log — B-015's first real audit run, 525 files / 54M lines):**
- ✅ **Real and dominant:** `Quantum Travel Calibration Started By DeadMan#:` /
  `...Fadingdoughnut#:` — 6,080 + 5,752 = **11,832 combined hits**, more than
  double the next candidate ("Entering Armistice Zone", 4,048). The handle is
  embedded in the notification text itself (normalized away by the audit's
  digit-stripping, but present verbatim in the raw line) — a free, direct
  handle↔quantum-travel-event tie, no separate resolution needed.
- ⚠️ **Destination unconfirmed from this line alone** — "Calibration Started"
  is the *beginning* of a jump, not necessarily the destination. Needs a real
  log pull (`grep -A/-B` around a calibration line) to confirm whether the
  destination name is on this line, a paired follow-up line (candidate for
  B-016's coalescing seam if so), or only recoverable from a separate
  `quantum:arrive`-style line not yet identified. Do the real-log check before
  writing the rule, per this repo's own parser-honesty discipline (AGENTS.md §6)
  — don't guess the destination field from the notification text's shape alone.

**Prerequisites:** none to start (B-015 already ships) — needs one real-log
read-through to pin the exact line shape before writing a `verified: true` rule.

**Confidence / honesty:** the volume and handle-attribution are validated
(counted directly from real logs); the destination/route shape is NOT yet
confirmed — mark accordingly until checked.

**Related:** `app/parser.js` (existing quantum-travel TODO comment) · B-015
(source of this evidence) · B-011 (ship usage) · B-001 (on-site presence) ·
B-014 (Movement bucket).

---

## How to add an idea
Copy the block below, increment the id, fill it in. Keep the feasibility read honest.

```
## B-00X — <short title>
**Added:** YYYY-MM-DD
**What:** …
**Why:** …
**Feasibility (from the log):** ✅/⚠️/❌ per sub-part, with the reason.
**Prerequisites:** …
**Confidence / honesty:** validated vs inferred; who/what it depends on.
**Related:** …
```
