# Log fixtures

Real `Game.log` slices used by the parser, relay and death-detector tests.
Formats here must come from a real log — never invent a line shape.

| File | Build | Contains |
|---|---|---|
| `sample-combat.log`, `sample-missions.log`, `sample-quantum-crime.log` | see parser rule comments | Small samples for the parser rules. |
| `death-fatal-collision-pilot.log` | 12660092 (client 2026-09-27) | One complete local-player death, 625 lines: pilot `<FatalCollision>` → `[ActorState] Dead` → Incapacitated → corpse manifest (45 items, 7 character-bound) → respawn. Also holds the negative-test material: a **replayed** Incapacitated notice after respawn, an `AttachmentReceived` burst *before* the real respawn, and a corpse burst interleaved with other lines. No `<Actor Death>` / `<Vehicle Destruction>` lines. |

## Capturing a new fixture

1. Copy `Game.log` from the game's channel folder **immediately after** the
   event — the client overwrites the file on every launch.
2. Scrub it before it goes anywhere near git:

   ```bash
   node scripts/scrub-log-fixture.js <copied Game.log> tests/relay/fixtures/<name>.log --handle <YourHandle>
   ```

   This replaces the handle, account id, GEID and every entity/item instance
   id, IP addresses, session ids, network node ids and the install path, while
   keeping line shapes, timestamps, positions and item *class* GUIDs intact.
3. `tests/unit/deathReport.test.js` has a privacy guard that fails if the death
   fixture carries an unscrubbed id, address, handle or user path. Extend it
   when adding a fixture.

## Wanted (not yet captured, so not yet verified)

On-foot death, death as a passenger, a survived crash (FatalCollision with no
corpse), a revive before the Time-to-Death timer runs out, and — on builds that
still log them — `killed_by_player`, `killed_by_npc`, self-respawn and
`vehicle_destroyed_combat`.
