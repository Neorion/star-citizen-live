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
- **👥 Crew / party** — `<PlayerJoined> mission_id … player_id …`. **165 files.** Who you
  flew with + shared missions; directly feeds the M4 org-wide convergence model. *(Strategic.)*
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

**Prerequisites:** members run the relay; a central service to aggregate multiple
members (M4); the Discord-Events op window; optional location-name enrichment.

**Confidence / honesty:** this is **inferred telemetry** (engagement/presence),
clearly labelled as such — an *input* to an officer's loot decision, not a
validated truth. Non-relay members won't appear.

**Related:** Discord Events hook (§5 brief) · metrics table (§6) · mission grouping ·
name-enrichment (`REFERENCES.md`: unp4k / StarCitizen-GameData).

---

## B-013 — Re-parse: store raw classified event fields, not just derived summaries
**Added:** 2026-09-04 · design learning from a cross-project assessment (StarLogs' "Reprocess Log" button)

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

## B-014 — Event category taxonomy (Lifecycle / Combat / Economy / Movement / Operational)
**Added:** 2026-09-04 · design learning from a cross-project assessment (StarStats' event taxonomy)

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
