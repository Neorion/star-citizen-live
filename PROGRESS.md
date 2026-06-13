# Progress & Retrospective Log

A running, plain-English trail of what's been done, what we learned, and what's
next. Each milestone closes with a short retro. Newest at the top.

> **Planning (2026-06-13):** direction set for the next phase — see `SOLUTION-BRIEF.md`
> (product overview), `DECISIONS.md` → **D-005**, and `DESIGN-missions-mvp.md` (M5
> technical plan). Next build: **M4** (deploy) → **M5** (officer-validated mission
> register) → **M6** (roles + signed audit).

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
- **M4 — Deploy to the VPS:** stand up the always-on service (provider + DB +
  deploy). See D-003.
- **M5 — Contracts MVP:** create/list/apply/approve missions via API/Discord,
  backed by a small database.
- **M6+:** Discord roles for approvals, signed audit trail, polish.

> Cadence: one milestone per iteration, each ending with a demo, a retro note
> here, and a quick re-prioritization.
