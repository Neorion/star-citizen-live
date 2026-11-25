# Handoff — RSI-line feature work (pick up on any machine)

**Updated:** 2026-11-25 · **Owner:** Neorion (non-dev product owner; AI proposes, owner decides; never merge for them)
**Read this first on a new machine.** It replaces `HANDOFF-rsi-features-2026-10-24.md` and folds in the
session memory that only existed on the Windows PC.

House rules that always apply: label **verified** (real log line, name the game build) vs **inferred**;
never overclaim; no player handle / GEID / account id / session id / IP / user path in any commit;
log-derived data is local-only (never written to `history.json`, which is shared with peers).

---

## 1. Repos and branches

One GitHub repo holds everything of ours: **`Neorion/star-citizen-live`** (the owner's fork).
Upstream is **`GoonCitizen/star-citizen-live`** (lead dev: Eric Martindale).

| Branch (on the fork) | Base | What it is |
|---|---|---|
| `feat/death-report` | upstream `feature/rsi` @ `b9c88e6` | Deaths tab (death reports from Game.log). Tip `9eb59e9`. |
| `feat/ledger` | same | Ledger tab (kiosk/terminal spend & income, place names). Tip `cc242ee`. |
| `feat/shard-capture` | same | Gated shard / server-handoff capture, no UI. Tip `023cf55`. |
| `feature/mining-calculator` | fork `feature/ledger` | Rock-crack calculator for the owner's own zero-dependency app (see §6). |
| `docs/rsi-handoff` | fork `master` | This file. |
| `master`, `feature/ledger`, others | — | The owner's own zero-dependency product line (different stack; not merged upstream). |

Upstream facts (checked 2026-11-25):
- The lead dev **takes PRs on `feature/rsi`** and carries it to `master` himself. `feature/rsi` tip is
  `b9c88e6` (2026-10-13); our three branches sit directly on it.
- His newest work is on **`feature/passport`** (10 commits to 2026-11-20: Passport v2 sign-in, group
  wallets, market manager, **Node 26**, reworked `LiveRelay.js`). When he merges it with `feature/rsi`
  our branches will conflict only in `PROGRESS.md`, `components/Dashboard.js` (tab list) and
  `tests/unit/httpPathInventory.test.js`. Ask him if he would rather have PRs against `feature/passport`.
- Fabric libraries (`@fabric/core|http|hub|discord`) are pinned by git commit and change often.

## 2. Set up on the MacBook

```bash
git clone https://github.com/Neorion/star-citizen-live.git rsi && cd rsi
git remote add goon https://github.com/GoonCitizen/star-citizen-live.git && git fetch --all
git checkout feat/death-report        # or feat/ledger / feat/shard-capture
nvm install 24.15.0 && nvm use 24.15.0   # upstream feature/rsi pins Node 24.15 (feature/passport needs 26)
PUPPETEER_SKIP_DOWNLOAD=true npm ci --allow-git=all
```

Notes: always `npm ci` (a plain `npm i` once left stale `@fabric/*` folders). Git deps resolve over
`git+ssh` URLs in the lockfile; if SSH to GitHub is not set up, run
`git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"` first.
`npm test` scripts are POSIX — they work as-is on macOS.

The Mac has **no Game.log archive**, so the memory problem from the Windows PC (7.9 GB of saved logs:
relay startup sync peaks at 2–4 GB, and each `tests/relay` test re-syncs the real corpus) does not
apply there. On the Windows PC: never run `tests/relay/*` in bulk, cap any relay with
`node --max-old-space-size=2048`, and do nothing heavy while the game is running.

## 3. What is left before the three PRs (do in this order)

1. **Rebuild the dashboard bundle** on `feat/death-report` and `feat/ledger` and commit it:
   `node scripts/build.js && node scripts/build-universe-explorer.js`, then commit `assets/index.html`
   (+ `assets/scripts/universe-explorer.js`). The committed asset is currently upstream's build, so
   neither tab is in the bundle. It is a generated, tracked file: always rebuild, never merge it.
2. **Run the tests against the current Fabric pins** (never done since the Oct-13 pin bump or since the
   hardening commits): `npm test`, or per layer `npm run test:unit`, `test:ui`, `test:integration`,
   `test:relay`. Feature-only runs are listed in each `docs/*.md` guide ("For developers").
   Expect **4 pre-existing upstream unit failures** on untouched upstream too: two Fabric device-link /
   OAuth expectations, the `@fabric/discord` pin check, and `/rsi/claim` missing from the route inventory.
   `tests/relay/deathReports-routes.test.js`, `ledger-routes.test.js`, `shard-capture.test.js` last passed
   before the hardening commits; re-run them.
3. **Check the standalone Deaths viewer** still works after its new Host check:
   `npm run deaths:preview -- tests/relay/fixtures/death-fatal-collision-pilot.log` → open
   `http://localhost:3042/`.
4. **See the tabs in the real app:** `SC_FABRIC=0 SC_SETTINGS_DIR=/tmp/sc-store SC_LOGFILE=<a fixture copied to …/LIVE/Game.log> PORT=3043 node scripts/node.js`.
   In a plain browser upstream hides every tab except Home/Map until a Fabric sign-in; for a local look
   set `localStorage['fabric.delegation'] = '{"token":"local-ui-verify"}'` on that origin and reload.
5. **Push** the three branches, then open **three PRs against `GoonCitizen/star-citizen-live` `feature/rsi`**.
   Each description must state: verified vs inferred; how to switch it off (`constants.FEATURES.deaths|ledger`
   hide the tab only; shard capture is fully gated by `SC_SHARD_CAPTURE=1` / `settings.shard.enable`);
   local-only data; the 4 pre-existing failures; "rebuild assets, don't merge"; and this note for him:
   *upstream's own mutating routes have no Origin check (a web page in the same browser can trigger them
   on the loopback API); ours are guarded in their own modules — one central check in `LiveRelay._handle`
   would close it for everything.*

## 4. The three features in one screen

Shared module pattern: `functions/<x>Signals.js` (regexes) → `<x>Detector|Tracker.js` (pure state machine)
→ `<x>Store.js` (own JSON file beside `history.json`, idempotent ids) → `<x>Http.js` (`tryHandle…`, mounted
by `LiveRelay`) → `components/<X>.js` (React.createElement, no JSX). `LiveRelay.js` changes are additive.
User/dev guides: `docs/DEATHS.md`, `docs/LEDGER.md`, `docs/SHARD-CAPTURE.md` on their branches; each
branch's `PROGRESS.md` top entry has the full write-up and real-data numbers.

- **Deaths.** Verified on ONE fixture (build 12660092, pilot fatal collision), scrubbed with
  `scripts/scrub-log-fixture.js` (privacy-guard test in `tests/unit/deathReport.test.js`). Counts-only run
  on the owner's logs: 498 confirmed deaths; on-foot deaths have no cause in the log (479 `unknown`);
  47/47 ejections from a destroyed ship had no collision line (`vehicle_destroyed_unknown`); respawn time
  seen for ~1 in 10; no kill/cause logging after SC 4.3.0.
- **Ledger.** 1,933 transactions on the owner's logs; place names 624 exact / 262 inferred / 586
  unresolved (Pyro station tokens `RR_P#_L#`, asteroid bases — "name it" corrections are the path).
  Known gap: item rows show a GUID although the log line carries `itemName` — small fix outstanding.
- **Shard capture.** `<Join PU> … shard[pub_<region>_<build>_<n>]` names the shard (444 distinct, regions
  `use1b/euw1b/ape1a/apse2a`; the owner plays from Alaska and picks APAC shards on purpose). Join addresses
  are not a shard fingerprint — compare shard ids. Handoff / authority-loss records are inferred.

Security review (2026-11-25, independent agent, all three branches): no High findings; Medium/Low items
fixed in the three "fix(…): harden…" commits (ingest isolation + atomic debounced writes in the ledger,
prototype-safe maps, shard-id validation, single-flight rescans, CSV formula neutralising, Origin guard on
our mutating routes, hosted-mode block on ledger corrections, Host check on the preview server, detector
bounds). Our branches add **no new dependencies**; `npm audit`'s 26 findings are all upstream's tree.

## 5. Backlog (owner-approved or discussed), with rough effort

S = 1–2 days, M = 3–8, L = 9–20, XL = 21+.

| Item | Effort | Notes |
|---|---|---|
| `SC_HISTORY_SYNC=0` switch (**approved**) | S | Skip the relay's startup log sync; own branch `feat/history-sync-switch`. Spec: skip `_syncCumulativeHistory()`, set `_historySync.status='skipped'`, plumb through `scripts/node.js`, document, relay test. |
| Ledger: keep `itemName`; friendly item/commodity names (UEX/wiki, build-time) | S + M | |
| Deaths: split "Deaths" vs "Ship losses"; ocean-crash cause (`Boundary Violation`) | S | |
| **Org shard radar** (the "wow" pick) | L | Who in the org is on my shard, where, and which outsiders were seen. Needs the two-player same-shard test first, then a consent-gated share of the shard id. |
| Sightings (transit-carriage lines name nearby players) | M | Other people's handles: own privacy design, own flag. |
| SC 5.0 telemetry reader → combat timer, clean death events | M–L | Local gRPC feed, `sc.game.telemetry.v1.GameTelemetryService/TelemetryStream`, 127.0.0.1:2942, off by default (`user.cfg`). Gives ship/vitals/aUEC/dead/downed; **no** killer, position, shard or other players. PTU-only knowledge from community reverse-engineering; CIG has not said whether tools may use it. |
| **Mining module** (switchable) | M (+L for org ops) | Port the calculator (§6) as a Mining tab; add refinery-order and mining-session logs from Game.log; org mining ops on the register. Complements Bedrock (GPL-3, screen-reading, single-player) — do not copy its code. |
| Rebase older branches (`feat/op-participation`, `feat/cargo-log-board`, `feat/stability-ship-usage`) | M | Still on upstream's Aug-14 commit. |
| Open fork backlog: B-011 insurance, B-011 crew, B-015 parser audit, B-017 rule version tags, B-014 categories, B-016 two-line pairing, B-018 location table, B-013 re-parse, B-012, B-002c beacon, B-010 rep predictor (park) | S–L each | See `BACKLOG.md` and `PORT-ANALYSIS-rsi.md` §4 on the fork's `master`. |
| Lean rewrite (native collector + SQLite, no Electron/Fabric) | XL | Middle path first: add SQLite + telemetry to the zero-dependency fork. |

Open question for the owner: a "new death feature spec" mentioned on 2026-10-08 was never found.

## 6. Mining calculator (branch `feature/mining-calculator`)

Built 2026-09-24 against SC 4.10.1, in the owner's zero-dependency app: `app/mining-calc.js` (engine),
`app/mining.html`, `app/mining-data.js`, `data/mining-reference.json`, `scripts/build-mining-reference.js`
(`npm run build-mining`), `test/mining-calc.test.js`, design in `DESIGN-mining-calculator.md`.
Formula is the community model (c = 0.2) after mort13's MIT BreakabilityChart; laser stats from the wiki
API v2 (UEX was stale). The local `BreakabilityChart/` clone contains third-party tokens — **never commit it**.

## 7. Things that bit us (so they don't again)

- The dashboard asset conflicts on every upstream change: rebuild it.
- Repo files are CRLF on Windows (`core.autocrlf=true`); scripted edits must preserve endings.
- On the Windows PC the AI's `npm install` and `git push` were blocked by the permission system; the
  owner runs those.
- Upstream's relay grows to 2–4 GB at first start on a large log archive (measured on unmodified upstream).
- Use cheaper sub-agents for mechanical work (docs, mechanical fixes, reviews) and review their diffs.
