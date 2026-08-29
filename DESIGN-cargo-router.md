# DESIGN — Cargo route optimizer (optional module)

> **Status:** Working prototype on branch `feature/cargo-router` (off `master`).
> **Owner-requested, lead-dev-optional.** This is a self-contained feature that
> the owner wants but the lead dev can leave out of their build entirely. It is
> built to be stripped with zero impact on the core relay.

---

## 1. What it does

As you accept **hauling missions** in-game, the `Game.log` emits each delivery's
cargo manifest and destination. This module joins them and, when you click
**Route**, sequences your *active* deliveries into an efficient stop order —
grouped by celestial body so you don't bounce around the system. It's the
"have I picked up everything, and what's the best order to run it?" button.

**The loop the owner asked for:** accept contracts → click **Route** → deliveries
that complete drop off automatically (via `mission:end`) → accept more → click
**Route** again to re-optimize.

## 2. Why it's feasible (verified in the real corpus, builds 4.7–4.8.0)

| Signal | Log line | Gives |
|---|---|---|
| Manifest | `<SHUDEvent_OnNotification>` *"Deliver H/N SCU of `<Commodity>` to `<Dest>`"* + `MissionId` + `ObjectiveId:[dropoff_<GUID>_<idx>]` | commodity, SCU have/need, mission, dropoff GUID |
| Station | `<CreateHaulingObjectiveHandler>` *"Dropoff created … locationName: `<Station>` [`<Token>`] … objectiveId: dropoff_<GUID>…"* | the named station; token's `Stanton_<N>` encodes the body |

Two routing keys fall out **for free** — no external API, no hand-kept station list:
1. **The destination is often a specific station already** (e.g. `HUR-L2 Faithful
   Dream Station`), and the **name prefix encodes the body** (`HUR-`→Hurston,
   `CRU-`→Crusader, `ARC-`→ArcCorp, `MIC-`→microTech). So most deliveries route
   from the manifest line alone.
2. When the destination is a bare `"<System> System"`, the station comes from the
   `<CreateHaulingObjectiveHandler>` line, joined on the dropoff **GUID**.

## 3. The separability boundary (the important part)

The whole feature is **one module + one flag + one UI panel**:

| Piece | Where | To strip |
|---|---|---|
| Engine + extraction + routing | `services/CargoRouter.js` | delete the file |
| Flag + 2 routes + observe() seam | `app/server.js` (`cargo:` setting, `…/route` + `…/cargo`, one `observe()` call, `cargoEnabled` in `/monitor`) | remove those lines |
| UI | `app/ui.html` (`#cargo-panel` + `renderCargoRoute`) | remove the panel |

The module **never touches `app/parser.js`** — it does its own line extraction and
couples to the relay only through `cargoRouter.observe(rawLine, parsedEvent)`. It's
**off by default** (`SC_CARGO_ROUTER=1` to enable). Removing it leaves the core
relay and its 57 tests untouched. **Zero runtime dependencies** (D-002 preserved).

```bash
SC_CARGO_ROUTER=1 npm start      # enable; a "🚚 Cargo route" panel appears
GET …/route?scu=64               # optimized stops (optional ship SCU capacity)
GET …/cargo                      # raw active cargo parcels
```

## 4. Routing model + honest limits

- **Heuristic, not provably optimal.** Stops are grouped by station, clustered by
  body, and bodies ordered into a fixed circuit (Hurston→Crusader→ArcCorp→microTech).
  The log has no travel-time model, so this is a sensible *body-clustered* order,
  not a shortest-3D-path solve.
- **Dropoff-centric.** Open-delivery hauls (you source the commodity anywhere) log
  the pickup as `UNKNOWN`, so the router optimizes the **dropoff** sequence — the
  reliable, named side. Cross-system `"Pyro System"` dropoffs with no named station
  surface under "destination pending" rather than being dropped silently.
- **Self-reported / client-only**, like every log signal here.
- **Capacity-aware:** enter your ship's SCU and it flags trips that need splitting.

## 5. Future improvements (slick ideas, not yet built)

- **Pickup legs — DONE.** The route is now a pickup→dropoff breakdown: the
  "Contract Accepted: … | from `<Pickup>`" notification names the source, joined
  to each delivery by MissionId, and the route groups deliveries under their
  pickup hub with dropoffs ordered by body. Open-delivery hauls (no named source)
  fall under an "open pickup" hub.
- **UEX Corp API** (optional, behind a 2nd flag) for real inter-station distances →
  true nearest-neighbour ordering instead of the fixed circuit.
- **Payout/SCU efficiency** ranking if a reward signal can be tied to the mission.
- **A simple node map** of the route (SVG), and a per-stop "picked up?" checklist.
- **Discord `/route`** once the M5.3 bot lands.
