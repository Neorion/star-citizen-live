# Ledger (the Ledger tab)

The Ledger tab rebuilds your kiosk and terminal spending and earning from
`Game.log`. It lists item buys, commodity buys and sells, and refinery orders,
with price, quantity, result and where it happened. The game has no spend
history of its own, so this fills the gap. It is for org members who want to
see their aUEC flow, and for reviewers who want to know how far the place names
can be trusted. The data is inferred from your own log.

## What you see

A **Ledger** tab with a summary strip and a table.

Summary strip: **Spent**, **Earned**, **Net**, **Transactions**, and a per-system
net when systems are known.

Controls:

- **All / Spend / Income** filter.
- **Include failed** also shows requests the shop rejected or never answered.
- **Export CSV** downloads the rows.
- **Scan saved logs** reads your saved logs. Unchanged files are skipped.

Table columns:

| Column | Meaning |
|---|---|
| When | Local time. Hover for UTC. |
| What | "Bought item (kiosk)", "Bought item", "Bought commodity", "Sold commodity" or "Refinery order". A row can carry an **unverified shape** tag. |
| Item / commodity | Display name if known, else the raw class or id. |
| Quantity | Quantity with its unit. |
| Amount | aUEC, with a sign: plus for income, minus for spend. |
| Where | Place name, a confidence label, and a **name it** button when the place is not exact. |
| Result | `Success`, or another result from the shop, or `Unknown`. |

The page refreshes itself every 15 seconds.

## How to turn it on / use it

1. Start the relay and open the dashboard. The tab is on by default.
2. The feature flag is `FEATURES.ledger` in `constants.js`. It is `true` by default. Setting it to `false` hides the tab. There is no environment variable for it. The routes stay mounted either way.
3. Play. Transactions are read from the live log as it is written.
4. To add older purchases, press **Scan saved logs**. Repeating it is cheap.
5. If a place shows a raw id, press **name it** and type a name. The name is saved and applied to every matching row, and it counts as exact.
6. Command line alternative: `npm run ledger` scans every log this install knows. `node scripts/ledger-ingest.js <folder or file>` scans only what you give it. It only reads logs.

Routes (base path `/services/star-citizen`). Every route is also available
without that prefix, for example `/ledger`.

| Method | Path | What it does |
|---|---|---|
| GET | `/ledger` | Rows, oldest first. Query: `from`, `to`, `system`, `locationId`, `direction`, `kind`, `includeNonSuccess=1`, `limit` (default 5000, max 20000), `offset` (default 0). `limit` and `offset` count from the newest row. `total` is the full match count. |
| GET | `/ledger/summary` | Spend, income, net, count, and net per system. |
| GET | `/ledger/stats` | Counts: transactions, files ingested, commodity names learned, unpaired requests. |
| GET | `/ledger/export.csv` | CSV download of all successful rows (add `includeNonSuccess=1` for the rest). |
| POST | `/ledger/ingest` | Body `{ "path": "<a known log file>" }` or `{ "all": true }`. Local play only; a hosted server answers 400. Only one ingest runs at a time; a second one answers 409. |
| POST | `/ledger/action` | Body `{ "action": "learnLocation" or "learnItem", "id", "display" }`. Saves a correction. Local play only (a hosted server answers 400). `id` is at most 200 characters and `display` at most 120; control characters are stripped from `display`. |

Ingest only reads log files the relay already knows. Other paths get 400.

Both POST routes refuse a browser request from another site (403). A request whose `Origin` is `localhost`, `127.0.0.1` or `[::1]`, or matches the `Host` it was sent to, is fine, and so is a request with no `Origin` header (scripts and `curl`).

## Where the data is stored

- File: `ledger.json`, in the same settings folder as `history.json`. The command line tool writes `ledger.json` under `stores/gooncitizen/` (or under `SC_SETTINGS_DIR` when that is set).
- It holds the transactions, a per-file cursor (size and modified time), harvested commodity names, and your corrections.
- Local only. It is never merged into `history.json` and never sent to peers, Fabric or Discord.
- Saves are atomic (a temporary file, then a rename). Live transactions and corrections are written after a short delay (about 2 seconds), and always when the relay stops. A scan of a saved log writes once, when that file is finished.
- With no settings folder, the ledger lives in memory only.
- To delete: stop the relay and delete `ledger.json`. A later scan rebuilds it from your logs, but your "name it" corrections would be lost.

## What is verified and what is inferred

- **Rows** are inferred from request lines in your log. The amount is what the shop was asked for.
- **Verified on real logs** (one player, 2026-10-08): the item buy (kiosk), item buy (standard), commodity buy and commodity sell request lines, the kiosk outcome line, and the kiosk location line. Each request type had amount, quantity, item and shop fields on every row seen.
- **Not verified:** the refinery order line (the real lines seen carried no price or quantity under the documented names), the outcome line from the standard purchase path, and the commodity-name hint. Rows built from an unverified shape show **unverified shape**.
- **Result:** a request is paired with the next outcome line, in arrival order. A request with no answer by the end of the log becomes `Unknown`. More than 200 unanswered live requests push the oldest one out as `Unknown`. A scan of saved logs pairs inside its own context, so scanning while you play never disturbs the live pairing. By default only `Success` rows are listed and counted.
- **Where.** The shop name in the log is reused at every outlet of a chain, so it is not a place. The place is the kiosk you opened just before the purchase. Labels:
  - `exact`: one real place is pinned, by the seed file, by the wiki-based catalog, or by you.
  - `inferred`: several places fit. All are listed and marked "(unconfirmed)".
  - `unresolved`: the raw id is shown, never a made-up name.
- Row source: `seed`, `catalog` or `operator`.
- **Sanity run** (counts only): 1,933 transactions; 624 places exact, 262 inferred, 586 unresolved.
- Commodity names come from a best-effort harvest and are never better than `inferred`.

## Privacy

- Stored: time, aUEC amount, quantity, item class or commodity id, shop and kiosk ids, location id, result, log file name, your corrections.
- Not stored: raw log lines or file paths. The handle is read to pair a kiosk with a player but is not part of the stored row.
- Local only. Nothing is published.
- Test fixtures use placeholder handles and ids.

## Known limits

- The location seed is small: two Pyro bodies and two outposts. The wiki catalog adds Lagrange stations and landing zones. Low-orbit and jump-point stations are only inferred. Pyro station tokens and asteroid bases stay unresolved.
- The item dictionary has one entry, so most items show a class name.
- Only a purchase made after you opened a kiosk gets a place. Otherwise Where says "unknown".
- No per-place or per-item totals, and no map link.
- The tab can name a place but has no button to name an item. The `learnItem` action exists on the API.
- Amounts for failed or unanswered requests are hidden by default.

## For developers

| File | Role |
|---|---|
| `services/TransactionLedger.js` | Self-contained. Node built-ins only. Line parser, pairing, resolvers, store, `query`, `summary`, CSV (cells that start with `=`, `+`, `-` or `@` are quote-prefixed so spreadsheets do not run them). |
| `functions/ledgerLocationNames.js` | Second opinion for place ids, using `functions/locationCatalog.js`. |
| `functions/ledgerHttp.js` | The routes above. |
| `components/Ledger.js` | The tab. |
| `scripts/ledger-ingest.js` | `npm run ledger`. |
| `data/ledger/locations-seed.json` | Seed places. Grow it by adding entries. |
| `data/ledger/items-seed.json` | Seed item names. |
| `services/LiveRelay.js` | Feeds each raw line to `ledger.observe` and mounts the routes. |

Run only this feature's tests:

```
NODE_ENV=test node --test tests/unit/transactionLedger.test.js tests/unit/ledgerHttp.test.js tests/unit/ledgerLocationNames.test.js tests/ui/ledger-panel.test.js
```

Warning: do not run the whole `tests/relay/*.test.js` layer on a machine with a
large log archive. Each test relay re-syncs the real logs. `tests/relay/ledger-routes.test.js`
is a relay test, so run it alone and only when needed.

The unit tests for the HTTP routes are in `tests/unit/ledgerHttp.test.js`.
