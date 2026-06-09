# Progress & Retrospective Log

A running, plain-English trail of what's been done, what we learned, and what's
next. Each milestone closes with a short retro. Newest at the top.

---

## M1 — "It's alive": Fabric-free service skeleton ✅
**Date:** 2026-06-08

**What shipped:**
- `app/server.js` — a lightweight service with **zero external dependencies**
  (Node built-ins only). It boots, serves the health endpoint, the collection
  endpoints (activities/players/vehicles/kills/messages), and the mission
  endpoints via the stub.
- Offline **log replay** implemented (`replayLog`) so we can test without the game.

**Validated (actually ran):**
- `node app/server.js` boots and prints its listening URL.
- `GET /services/star-citizen` returns live JSON status.
- `POST` a test kill → `GET /kills` reflects it.
- Replayed the real uploaded `Game.log` (27,712 lines, read-only) → 13,964
  activities ingested. Pipeline works end to end.

**What we learned:**
- The provided `Game.log` is a hangar/menu session — **no combat/kill events in
  it**. The SC 4.x format is `<timestamp> [Notice] <EventType> key=value …`.
- To build the kill parser (M3) we need a **combat-containing log**, or we build
  to the documented kill format and test against a real combat log later.

**Retro:** Removing Fabric made M1 fast and dependency-free, exactly as hoped.
Biggest open risk for value delivery is now *getting a representative combat log*
for the parser. Next milestone unchanged.

---

## Up next

- **M2 — Core pipeline polish:** wire `replayLog` to a sample log via a small
  script + a first mocha test; expose replayed data through the API cleanly.
- **M3 — Real parser + Discord (headline feature):** detect kills / player joins /
  quantum travel / spawns from real log lines and post them to a Discord channel.
  *Blocked on: a combat-containing Game.log sample.*
- **M4 — Deploy to the VPS:** stand up the always-on service (provider + DB +
  deploy). See D-003.
- **M5 — Contracts MVP:** create/list/apply/approve missions via API/Discord,
  backed by a small database.
- **M6+:** Discord roles for approvals, signed audit trail, polish.

> Cadence: one milestone per iteration. Each ends with a demo (something you can
> see run), a retro note here, and a quick re-prioritization before the next.
