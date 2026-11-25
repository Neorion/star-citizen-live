# Shard Capture

Shard capture records which game shard your client joined, and where you were
when your pilot was handed between servers. The game writes these facts to
`Game.log`. The capture saves them to a local file so a person can study how
the servers are laid out. It is off by default and has no screen. It is for the
lead developer and for anyone collecting data. It is not a feature members will
notice.

## What you see

There is no screen. It is a data capture.

- Nothing is added to the dashboard.
- The only visible trace is the dashboard's monitor data, which gets a small `shard` entry holding `enabled: true` and the current shard id. It holds no addresses.
- You read the data through the routes below, or open the CSV export in a spreadsheet.

Three kinds of record are kept:

| Kind | Meaning | Status |
|---|---|---|
| `join` | You joined a shard. Shard id, region, build, number, server address and port. | Read straight from the log. |
| `handoff` | The replication endpoint changed during one shard. | Inferred boundary evidence. |
| `authority` | Your own actor lost authority (handed to another server). | Inferred boundary evidence. |

Handoff and authority records also carry the last place the log named, its kind
(`kiosk`, `quantum-target` or `route-start`) and the time of that mention.

## How to turn it on / use it

1. Turn it on with either of these. Restart the relay afterwards.
   - Environment variable: `SC_SHARD_CAPTURE=1`
   - Settings: `shard: { enable: true }` in `settings/local.js` (the template is `settings/example.js`)
2. Optional: `shard.file` in settings sets a different file path for the store.
3. Play, or open the relay with your saved logs available. Live lines are read as they arrive.
4. To add shards from saved logs, call `POST /shard/rescan`.
5. Read the results with `GET /shard`, `GET /shard/events` or the CSV export.

When the flag is off, nothing is built: no store, no file and no tracker. Every
shard route answers 503 with `{ enabled: false }`.

Routes (base path `/services/star-citizen`). Every route is also available
without that prefix, for example `/shard`.

| Method | Path | What it does |
|---|---|---|
| GET | `/shard` | Enabled flag, the current shard and endpoint, and a summary: counts, shards seen, regions, top places for handoffs and authority losses. |
| GET | `/shard/events` | Raw records. Query `kind=joins`, `handoffs` (default) or `authority`, and `limit` (default 200, max 5000). Newest first. |
| GET | `/shard/export.csv` | CSV of every record. |
| POST | `/shard/rescan` | Body `{ "path": "<a known log file>" }` or `{ "all": true }`. Local play only; a hosted server answers 400. Only one rescan runs at a time (a second answers 409 `{ "error": "shard rescan already running" }`). A browser request whose `Origin` is neither loopback nor the relay's own host answers 403 `{ "error": "cross-origin request refused" }`; requests with no `Origin` header are allowed. |

A rescan only reads log files the relay already knows. Other paths get 400.

## Where the data is stored

- File: `shard-capture.json`, in the same settings folder as `history.json` (`stores/gooncitizen/` in the example settings).
- It is local only, which strictly means loopback. In shared-LAN mode any signed-in peer can read the records through the read routes (same session model as the other read routes). It is kept apart from `history.json` on purpose, because it holds server addresses. It is never sent to peers, Fabric or Discord.
- At most 5,000 records of each kind are kept. Records older than the oldest one kept are dropped, so re-scanning old files changes nothing.
- With no settings folder, the data is memory only.
- To delete: stop the relay and delete `shard-capture.json`. To stop collecting, turn the flag off.

## What is verified and what is inferred

- **Verified from the log:** the `join` line names the shard. Environment, region, build and number come from the id itself. Unknown id shapes keep only the raw id; a region is never guessed. Shard ids must match `[A-Za-z0-9_-]{1,64}` and must not be `__proto__`, `constructor` or `prototype`; anything else is ignored, so no join is recorded for it. Place tokens longer than 200 characters are stored as `null`. The replication endpoint line and the "Lost authority" line were also matched against real logs. The signatures were matched on one player's logs, builds 12660092 to 12913470.
- **Inferred:**
  - A `handoff` shows the endpoint changed. The code does not establish whether that is a real server boundary or a replication-layer rebalance.
  - An `authority` loss is treated as a boundary crossing, with that same caveat.
  - A place is the last kiosk, quantum target or route start seen before the event, with its own timestamp so you can judge how old it is. It is never a position.
- **Do not compare addresses to decide "same shard".** In one player's logs, 258 of 444 shards were joined through more than one address. Compare shard ids.
- **Real-data run (counts only):** 1,252 unique joins, 16 handoffs, 293 authority losses.
- Loading-screen "Change Server" lines are read by the tracker but not stored, because they carry no server identity.

## Privacy

- Stored: shard id, region, build, server address and port, place token, place kind and time, log file name.
- Not stored: your handle, entity id, session id or node id. A test checks this.
- Server addresses are stored, and `GET /shard` shows the current one. Treat the file as sensitive and do not share it.
- Local only. Nothing is published. CSV cells that start with `=`, `+`, `-`, `@`, tab or CR get a leading single quote so a spreadsheet does not run them as formulas.

## Known limits

- Off by default and no screen.
- Only your own client is seen. Nothing says whether two org members on one shard read the same shard id. That two-player test has not been done.
- Place attribution is coarse. It only knows kiosk, quantum target and route start.
- The corpus figures (2,523 joins across 1,696 log files, 444 distinct shard ids, 293 own-actor authority losses) are from one player's logs only.
- Rescan reads whole files and can be slow on a large archive.

## For developers

| File | Role |
|---|---|
| `functions/shardSignals.js` | Pure: one line in, one signal out. Also `parseShardId`. |
| `functions/shardTracker.js` | Pure state machine. Emits `join`, `handoff`, `authority` and `changeServer` events. |
| `functions/shardStore.js` | Load, save, add (idempotent by id), summary, CSV, file rescan. Per-kind cap of 5,000. |
| `functions/shardHttp.js` | The routes above, gated by the flag. |
| `services/LiveRelay.js` | Builds the capture only when enabled, feeds lines, saves after a short delay, mounts the routes. |
| `scripts/node.js` | Reads `SC_SHARD_CAPTURE`. |
| `settings/example.js` | The `shard` block. |

Run only this feature's tests:

```
NODE_ENV=test node --test tests/unit/shardTracker.test.js tests/unit/shardHttp.test.js
```

Warning: do not run the whole `tests/relay/*.test.js` layer on a machine with a
large log archive. Each test relay re-syncs the real logs. `tests/relay/shard-capture.test.js`
is a relay test, so run it alone and only when needed.
