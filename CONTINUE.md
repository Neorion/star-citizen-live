# How to continue this project

A quick-start so anyone (including future-you) can pick this up. Plain steps.

## Run the M1 service right now (no install needed)

The M1 skeleton uses only Node.js built-ins — nothing to install.

```bash
node app/server.js
```

Then open in a browser (or curl):

```
http://localhost:3041/services/star-citizen
```

You should see a JSON status response. That's the service running.

To try the offline log replay (read-only — never edits the game):

```bash
node -e "const S=require('./app/server.js'); const s=new S(); s.replayLog('PATH/TO/Game.log').then(n=>console.log('replayed',n,'lines'))"
```

## Save this to your own GitHub repo

The folder is on your computer, so run these from your machine (a regular
terminal in this folder). Replace the URL with your repo.

```bash
git init
git add .
git commit -m "Star Citizen Live: Fabric-free M1 skeleton + spike artifacts"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

Create the empty repo first on GitHub (no README/license, to avoid conflicts).
The `.gitignore` already excludes secrets (`settings/local.js`, `settings/auth.txt`,
`.env`), `node_modules/`, and any `*.log` files — so a personal `Game.log` placed
here will **not** be committed.

## What's where

- `app/server.js` — the new Fabric-free service (the thing you run).
- `services/MissionManager.js` — placeholder mission system (no crypto yet).
- `services/StarCitizen.js`, `types/`, `components/` — the original Fabric-based
  code, kept for reference during migration.
- `DECISIONS.md` — why we're doing what we're doing.
- `PROGRESS.md` — milestone + retrospective trail.
- `SPIKE-LOG-tier0-boot.md` — the plain-English spike write-up.

## Next milestone

**M3 (headline feature)** needs a `Game.log` that contains **combat/kills** — the
sample provided was a hangar session with none. Drop a combat log anywhere in
this folder (it's gitignored) and the parser work can use it.

## Common commands (updated at M2/M3)

```bash
npm install        # now installs in <1s (1 optional package), no Fabric
npm start          # run the service (http://localhost:3041/services/star-citizen)
npm test           # run the test suite (Node built-in runner, no deps)
npm run replay /path/to/Game.log   # replay a saved log and tally detected events
```

Live monitoring (zero dependencies — a built-in poller, no `tail` package):
`npm start` **auto-detects** the install across drives (C:, E:, "Program Files",
etc.) and picks the channel whose `Game.log` is freshest — LIVE, PTU, EPTU,
HOTFIX, or TECH-PREVIEW (the one you're actually playing). The dashboard shows
the chosen channel + build.

## Fabric mesh backbone (optional, in progress — see `BUILD-PLAN-fabric-mesh.md`)

D-008 replaced the old "central VPS" M4 plan with a Fabric P2P mesh. It's fully
optional and off by default — the core service stays zero-dependency either
way. To try it:

```bash
npm run fabric:install         # pulls in @fabric/core only (not the whole Fabric stack)
SC_FABRIC=1 npm start           # generates/loads a mesh identity, stores/fabric-identity.json
SC_HTTP_INGEST=1 npm start       # also accept POST …/events (WS1's idempotent bulk ingest)
```

`GET …/mesh` reports identity/roster/queue status (`{enabled:false}` when
Fabric isn't turned on). `SC_FABRIC_PASSPHRASE` encrypts the identity file at
rest (scrypt + AES-256-GCM); otherwise it's written plaintext with an explicit
`warning` field.

**WS4 (2026-09-04): real peer transport is live.** `SC_FABRIC=1` now also
opens a real `@fabric/core` Peer (listens, dials your `SC_FABRIC_PEERS`
roster or the default seed hubs) — nothing shares your events anywhere until
you say so: set a peer's `shareLogs:true` (per-peer consent) or turn on
`shareLogsGlobal` in `settings/local.js`. `SC_FABRIC_ALLOWED_KEYS` optionally
pins inbound traffic to a comma-separated pubkey allowlist. Two-node
convergence has its own gated test (needs `@fabric/core` installed):

```bash
SC_FABRIC_TEST=1 node --test test/mesh-peer.test.js   # always foreground, never detached
```

Overrides (highest priority first):
- `SC_LOGFILE=/full/path/to/Game.log` — force an exact file.
- `SC_CHANNEL=HOTFIX` — force a channel (e.g. after a hotfix drops and auto-detect
  ties LIVE vs HOTFIX).

It survives the game rotating/recreating `Game.log` between launches (and ALT-F4 +
relaunch) and tracks each game session. By default it pre-fills from the current
log's history on start; set `SC_SEED=/path` to seed from a different file. Open
`http://localhost:3041/` for the live dashboard. Discord (optional): set
`DISCORD_WEBHOOK_URL`.
