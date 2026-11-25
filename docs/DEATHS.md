# Death Reports (the Deaths tab)

The Deaths tab rebuilds each death of your own pilot from your `Game.log` file
and shows it as a short report. A report has a one-line headline, a cause, a
timeline, a position and the gear that was left on the body. It works on the
live game and on saved logs. It is for org members who want to see how they
died, and for reviewers who want to know exactly what the log can and cannot say.
Reports are inferred from your own log. No officer validates them.

## What you see

A **Deaths** tab in the dashboard. It has two views.

**List view.** A table, newest first:

| Column | Meaning |
|---|---|
| When | Local time of the death. Hover to see UTC. |
| Pilot | Your handle as the log shows it. |
| What happened | The headline sentence. |
| Where | Zone name, or `-` if unknown. |
| Ship | Ship name, or `-`. |
| Lost items | How many items were on the corpse and were lost. |
| Status | `confirmed` or `unconfirmed` (see below). |

Above the table:

- **All** and one chip per cause (for example "Crash (pilot)"), each with a count. Click a chip to filter.
- **Rescan logs** reads your saved logs and adds deaths that are not yet on record. A note then says how many files and lines were read and how many deaths were new, updated or already known.

Click a row to open the detail view.

**Detail view.**

- The headline and the status label.
- Facts: pilot, cause, modifiers, ship, seat, impact part, impact speed, what was hit, frame time (flagged "possible lag spike" above 100 ms), killer, weapon, damage. A line is left out when the log has no value for it.
- Where and when: zone, position (with a **Copy** button), triggered, downed, died, respawned, game build, log file name.
- **Timeline**: the matched events in log order, in UTC.
- **Gear left on corpse**: grouped by type (armor, weapon, magazine and so on). Items that stay with the character are shown as "not lost".
- **Evidence**: a collapsed list of the log line numbers and signal names that were matched.
- Buttons: **All deaths** (back), **Export Markdown**, **Export JSON**, **Remove**.

When the relay confirms a new death while the dashboard is open, a toast appears
with the headline and an **Open report** button. It hides after 15 seconds. The
first poll after a page load never shows a toast for an old death.

## How to turn it on / use it

1. Start the relay and open the dashboard. The tab is on by default.
2. The feature flag is `FEATURES.deaths` in `constants.js`. It is `true` by default. Setting it to `false` hides the tab and the toast. There is no environment variable for it.
3. Play. New deaths appear as the live log is read.
4. To add deaths from older logs, open the tab and press **Rescan logs**. It is safe to repeat. A death already on record is skipped, or replaced when the new copy has more evidence.
5. Click a row to read it. Use **Export Markdown** or **Export JSON** to save one report.

Routes (base path `/services/star-citizen`). Every route is also available
without that prefix, for example `/deathreports`.

| Method | Path | What it does |
|---|---|---|
| GET | `/deathreports` | List. Query: `limit` (default 50, max 500), `offset`, `cause`, `status`, `player`. |
| POST | `/deathreports/rescan` | Body `{ "path": "<a known log file>" }` or `{ "all": true }`. Local play only; a hosted server answers 400. Only one rescan runs at a time: an overlapping request gets 409 `{ "error": "death report rescan already running" }`. |
| GET | `/deathreports/:id` | One full report. 404 if unknown. |
| GET | `/deathreports/:id/export` | Download. Query `format=md` (default) or `format=json`. |
| DELETE | `/deathreports/:id` | Remove one report. |

The two changing routes (rescan and DELETE) refuse a browser request whose
`Origin` is neither loopback (`localhost`, `127.0.0.1`, `[::1]`) nor the host the
request was sent to: 403 `{ "error": "cross-origin request refused" }`. A request
with no `Origin` header (curl, scripts) is allowed.

A rescan only reads log files the relay already knows (live log, logbackups,
imported logs). Any other path is refused with 400. The routes stay mounted even
when the tab flag is off.

## Where the data is stored

- File: `death-reports.json`, in the same settings folder as `history.json`.
- It is local to your machine. It is never merged into `history.json`, and it is never sent to peers, Fabric or Discord.
- The newest 2,000 reports are kept. Older ones roll off.
- If the relay has no settings folder, reports live in memory only and are gone when it stops.
- To delete one report: **Remove** in the detail view, or `DELETE /deathreports/:id`.
- To delete everything: stop the relay and delete `death-reports.json`. A later **Rescan logs** rebuilds it from your logs.

## What is verified and what is inferred

- **Verified on real data:** one log slice, game build 12660092, one player, one death. It was a pilot crash: fatal collision, incapacitated, corpse recorded, respawn. Every signal the detector uses has a real line in that slice. No other kind of death is verified on that build.
- **Rule from the code:** nothing is marked verified without a real log line. The fixture holds a scrubbed copy of that slice.
- **Inferred:** every report. The status labels:
  - `confirmed`: the log recorded a corpse (or a kill line). A death is keyed by the body id, so the live tail and a rescan give one record.
  - `unconfirmed`: a crash or ejection with no corpse logged. You may have survived, been revived, or the body was lost with the ship. The log cannot tell which.
- **Causes:** the kill-based causes (killed by player or NPC, self-respawn, environmental, ship destroyed in combat) can only appear on game builds up to 4.3.0, which logged kills. Newer builds do not log who or what killed you, so an on-foot death shows cause `unknown`. An ejection from a destroyed ship with no collision line shows "cause not logged".
- **Respawn time** is optional. In one player's log archive it was found for about 1 in 10 recent deaths, and for none on older builds.
- **Downed time** can be marked "inferred from an earlier notice".
- **Sanity run (one player's logs, counts only):** 577 incidents, 498 confirmed and 79 unconfirmed. This checks consistency only. Nobody compared the reports with what happened in game.
- Live reports count line numbers from when the relay attached. Rescan reports count from the top of the file.

## Privacy

- Stored: handle, build, zone, position, timestamps, cause fields, item class names from the corpse, matched line numbers, and the log file name only.
- Not stored: raw log lines, account ids, entity ids, item instance ids, or file paths.
- Local only. Nothing is published.
- The test fixture is scrubbed: handle becomes `TestPilot`, long ids are remapped, IPs become a documentation address. `scripts/scrub-log-fixture.js` replaces only the handle you pass with `--handle`, plus any named with a repeatable `--also <OtherHandle>` (they become `Pilot2`, `Pilot3`, ...). It does not remove unnamed handles, IPv6 addresses, hostnames or other profile paths, so review its output and run the privacy-guard test before committing a fixture.

## Known limits

- One incident keeps at most 400 evidence entries and 600 corpse items. If a runaway log hits either cap, the report is marked `truncated: true` and the extra entries are dropped.
- If the trigger or confirming log line has no timestamp, the log-time timeouts cannot run. The incident then closes as `unconfirmed` after 5,000 further lines.
- Only your own pilot is covered.
- On-foot deaths on current builds have no cause.
- Only the pilot fatal-collision shape is verified. Passenger death, survived crash, revive, and kill-based deaths on builds up to 4.3.0 have no committed fixture.
- The "Incapacitated" notice is replayed after respawn. It never opens a report.
- Not done yet: a rebuilt `assets/index.html` (run `npm run build:browser` with current dependencies), an in-game overlay toast, a "show on map" link.

## For developers

| File | Role |
|---|---|
| `functions/deathSignatures.js` | Regexes for the log lines. |
| `functions/deathDetector.js` | Pure state machine: lines in, report events out. Order is by line, not by time. |
| `functions/deathReport.js` | Cause, headline, gear grouping, timeline, Markdown export. |
| `functions/deathReportView.js` | Browser-safe labels and formatters. |
| `functions/deathReportStore.js` | Load, save, upsert, list, file rescan. Writes `death-reports.json`. |
| `functions/deathReportHttp.js` | The routes above. |
| `components/DeathReports.js` | The tab. |
| `services/LiveRelay.js` | Feeds lines in and mounts the routes. |
| `scripts/death-report-preview.js` | `npm run deaths:preview`. Standalone viewer on 127.0.0.1, port 3042, memory only, no Fabric packages needed. It answers 403 `forbidden host` to any request whose `Host` header is not loopback plus its port (DNS-rebinding guard, `functions/loopbackHost.js`). |
| `scripts/scrub-log-fixture.js` | Scrubs a log slice before it is committed as a fixture. |
| `tests/relay/fixtures/README.md` | Fixture list and how to capture a new one. |

Run only this feature's tests:

```
NODE_ENV=test node --test tests/unit/deathSignatures.test.js tests/unit/deathDetector.test.js tests/unit/deathReport.test.js tests/unit/deathReportHttp.test.js tests/ui/death-reports-panel.test.js
```

Warning: do not run the whole `tests/relay/*.test.js` layer on a machine with a
large log archive. Each test relay re-syncs the real logs, which is slow and
heavy on memory. `tests/relay/deathReports-routes.test.js` is a relay test, so
run it alone and only when needed.
