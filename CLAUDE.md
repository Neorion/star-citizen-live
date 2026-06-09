# Project Context — Fleet (Star Citizen Live)

> **Purpose of this file:** Onboarding/context map for AI-assisted coding (Claude Code, ChatGPT, Copilot).
> Keep it in the repo root. For Claude Code, duplicate it as `CLAUDE.md` so it's auto-loaded as context.
> Last reviewed against source branch: `feature/fabric-0.1.0`.

---

## 1. What this project is

A **Node.js background service that watches the Star Citizen `Game.log` file live** and relays what's
happening to other systems — primarily a **Discord channel** (via webhook) and a small **REST API**.

It's built as a "Fabric service" (Fabric = a decentralized/p2p framework), extending a base `Hub` class.
The longer-term vision in the code includes a **missions system** where org members post missions
(bounty/cargo/exploration) with UEC rewards, others apply, and contracts can be cryptographically
signed — single-signer or **multisig** (`secp256k1` / `musig2`). That crypto/contract layer is the most
ambitious and least-finished part.

**One-line summary:** turn live gameplay (the game log) into a Discord feed + queryable API, with an
aspirational mission-contract system on top.

---

## 2. Where the code came from (attribution & license)

- **Source:** `martindale/star-citizen-live`, branch `feature/fabric-0.1.0`
- **Upstream project:** `GoonCitizen/star-citizen-live` (per `package.json` repository field)
- **Package name:** `@rsi/star-citizen`, version `0.1.0-dev`
- **License:** **MIT** — permissive. You may copy, modify, and redistribute; just keep the original
  copyright/license notice in the files. This import is fully within the license.

---

## 3. Architecture (the main pieces)

| File | Role | State |
|------|------|-------|
| `services/StarCitizen.js` (~805 lines) | The heart. Log watcher, HTTP routes, Discord wiring, state. Extends Fabric `Hub`. | Present, partial |
| `scripts/node.js` | Launcher. `npm start` runs this → creates a `StarCitizen` instance → `.start()`. | Present, works |
| `types/Mission.js` | Mission data model. Uses `crypto`, extends Fabric `Entity`. Supports single/multisig contracts. | Present |
| `components/Interface.js` | React web UI (server-rendered, Semantic UI). | Present but a shell (`TODO: render string here`) |
| `constants.js` | Brand/name constants. | Present |
| `settings/example.js` | Template config. Copy to `local.js`. | Present |
| `tests/rsi.stream.js` | Test file (mocha). | Present |

### How it runs (happy path)
1. `npm start` → `scripts/node.js` loads `settings/local.js` and starts the service.
2. The service opens the log file with the `tail` package and listens for new lines.
3. Each new line → `handleLogChange()` → turned into a generic "activity" → stored in state →
   emitted as an `activity` event → (optionally) announced to Discord and the `authority` URL.
4. The HTTP server (port **3041**) exposes `GET/POST` endpoints for activities, players, vehicles,
   kills, messages, and missions.

### Declarative API (getters on the instance)
`activities`, `players`, `vehicles`, `kills`, `logs`, `missions`, `applications`, `status`.

---

## 4. Current state — what works vs. what's missing

**This is a mid-development feature branch. The README describes the finished vision; the code is partway there.**
Treat the README/CHANGELOG as *intent*, not *fact*. Below is the reality from reading the code.

### Works / present
- Log tailing and turning lines into generic activities.
- HTTP server + endpoints (structurally in place).
- Discord webhook posting with rich embeds (for activities, kills, player-joins, missions, applications).
- Mission **data model** (`types/Mission.js`).
- Config via `settings/example.js` → `local.js`, with secrets read from environment variables.

### Stubbed / unfinished
- **Log parsing is primitive.** `parseLogEntry()` just splits each line on spaces. It does **not**
  recognize specific events.
- **Kill / player-join detection is NOT wired to the log.** The `kill` and `player:join` events only
  fire when something POSTs to the HTTP API — *not* from reading the game log. So the headline feature
  ("kills announced to Discord from monitoring the log") is not actually connected yet. Everything from
  the log currently becomes a generic activity.
- `replayLog()` is an **empty TODO stub** (intended: replay a saved log file for testing).
- `components/Interface.js` renders a placeholder, not a real UI.

### Missing files (referenced in code/`package.json` but NOT in the branch)
- `services/MissionManager.js` ← **critical, see Section 5**
- `components/StarCitizenHome.js`
- `components/MissionHome.js`
- `types/MissionApplication.js`
- (`CHANGELOG.md` also claims `INTEGRATION.md`, an `examples/` folder, and a `tests/declarative-api.js`
  that aren't in the branch either.)

These may simply be **unpushed** on the original author's machine — worth confirming with the org leader,
but for your own copy, assume you'll need to create/stub them.

---

## 5. Known blockers to actually running it

1. **Startup crash from missing `MissionManager`.**
   `services/StarCitizen.js` line ~18 does `require('./MissionManager')`, and `missions.enable` defaults
   to `true`. Since `MissionManager.js` doesn't exist, a plain `npm start` will throw
   *"Cannot find module './MissionManager'"*.
   **Two quick fixes (pick one):**
   - Set `missions: { enable: false }` in your `settings/local.js`, **and** comment out / guard the
     top-level `require('./MissionManager')` (a top-level require still runs even if the feature is off), **or**
   - Create a minimal stub `services/MissionManager.js` (an empty class with `start()`/`stop()` methods
     and the events it emits) so the rest of the service boots.

2. **Fabric dependencies install from GitHub branches.**
   `@fabric/hub` resolves to `FabricLabs/hub.fabric.pub#feature/sensemaker`. The code also requires
   `@fabric/core` (e.g. `@fabric/core/types/actor`, `/types/entity`) which is **not listed directly** in
   `package.json` dependencies — it likely arrives transitively via `@fabric/hub`. If `npm install` fails
   or `@fabric/core` is missing, that's the first thing to investigate.

3. **Designed for Windows paths.** Default `logfile` is a Windows path
   (`C:/Program Files/Roberts Space Industries/...`). Set your real path in `local.js`.

---

## 6. Secrets handling (verified clean in source — keep it that way)

- In the source branch, **no live Discord webhook or token is committed.** `settings/local.js` reads them
  from env vars (`process.env.DISCORD_WEBHOOK_URL`, `process.env.DISCORD_CHANNEL_ID`), and
  `settings/auth.txt` contained only placeholder text.
- **For your repo:** put real values in environment variables or a `.env` file that is **gitignored**.
  Never paste your Discord webhook into a tracked file.
- Recommended `.gitignore` entries: `settings/local.js`, `settings/auth.txt`, `.env`, `node_modules/`,
  `stores/`, `reports/`.

---

## 7. Suggested roadmap for AI-assisted coding (easiest → hardest)

1. **Make it boot.** Apply a fix from Section 5.1 so `npm start` runs without crashing. Confirm the
   service starts and the HTTP endpoint `GET http://localhost:3041/services/star-citizen` responds.
2. **Confirm dependencies install.** Run `npm install`; resolve any `@fabric/core` / `@fabric/hub` issues.
3. **Implement `replayLog()`.** Small, self-contained: read a saved `Game.log` line-by-line and feed it
   through the same handler as live tailing. This lets you test everything **without being in-game** —
   do this early, it makes all later work faster.
4. **Write the real log parser** (the core value-add). Detect specific events from actual log lines —
   kills/actor death, vehicle destruction, quantum travel, spawns, etc. — and emit the proper
   `kill` / `player:join` / etc. events so Discord and the API light up correctly. *(Feed the AI real
   sample lines from a current Game.log; the 4.x format is specific and the AI shouldn't guess at it.)*
5. **Add tests** for each parser pattern (mocha is already set up: `npm test`).
6. **(Optional, advanced)** Rebuild the missions system: create `MissionManager.js`, `MissionApplication.js`,
   and the missing UI components. The multisig/crypto contract layer is genuinely advanced — scope it
   carefully or defer to the original author.

---

## 8. Tips for working with AI coding tools on this repo

- **Keep this file current** and point your AI at it each session ("read PROJECT_CONTEXT.md first").
- **Give real examples.** When asking for log-parsing code, paste actual `Game.log` lines. Don't let the
  AI invent the log format — it will hallucinate patterns that don't match the game.
- **Work in small, testable steps.** Build `replayLog()` first, then iterate on the parser against a
  saved log so you get instant feedback.
- **Ask for tests alongside code.** "Add a mocha test that proves this parser detects X" keeps changes honest.
- **Distinguish "broken" from "unfinished."** Much of this isn't buggy — it's simply not built yet
  (see Sections 4–5). Tell the AI that so it doesn't waste effort "fixing" stubs.
- **Don't let the AI commit secrets.** Confirm `.gitignore` covers `local.js` / `.env` before any commit.
