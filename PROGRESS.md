# Progress & Retrospective Log

A running, plain-English trail of what's been done, what we learned, and what's
next. Each milestone closes with a short retro. Newest at the top.

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
