# Decisions Log (ADRs)

Plain-English record of the *why* behind key choices, so anyone joining later
understands the direction. Newest at the top.

---

## D-004 — Revisit decentralization: federate first (amends D-002/D-003)
**Date:** 2026-06-12 · **Status:** Adopted (direction set; design only, no build yet)

**Decision:** Re-open the decentralization question we shelved in D-002. We will
**not** rip out the central VPS or Discord. Instead we grow a *federated* layer
**underneath** the current setup: multiple member-run nodes that gossip
**signed** events to each other for resilience, while **Discord stays the
primary UI** and the VPS remains a convenient (but no-longer-required) bridge.
Target rung now: **L1 — federated**. L2 (p2p, swappable relays) and L3 (fully
serverless) are explicit later options, not this step. Full design and the
M-series build plan live in `DESIGN-distributed.md`.

**Why:**
- D-002 was right that a *trustless* p2p framework is over-built for an org with
  a trusted leadership — but it conflated **transport** (Fabric, which was the
  fragile part) with **decentralized trust** (signed objects + multisig, which
  we still want). We keep the second and avoid the first.
- The crypto foundation already exists: `types/Mission.js` signs contracts with
  **secp256k1 / musig2 multisig**, and identity-as-keypair gives free spam/sybil
  resistance (ignore anything not signed by a key on the org roster).
- A single VPS (D-003) is one machine and one bill away from the org's data
  vanishing. Federation removes that single point of failure without paying the
  full cost of pure p2p (NAT traversal, serverless discovery) up front.

**Consequences:**
- D-003's VPS becomes **one node among several / a bridge**, not the sole source
  of truth. D-002's "single central service" framing is softened, not reversed.
- New honest limit we accept: decentralization **authenticates** who reported a
  game event; it cannot **verify** the event is true (only that player sees their
  own `Game.log`). Signing proves authorship, not gameplay.
- No blockchain. Signatures give non-repudiation + an audit trail; UEC settlement
  stays social/in-game.

---

## D-002 — Remove Fabric; build a lightweight central service
**Date:** 2026-06-08 · **Status:** Adopted (direction set; migration in progress)

**Decision:** Move off the Fabric framework and rebuild the core as a small,
standard Node service. Run it as a single central service the org hosts (see
D-003), with Discord for identity/interaction and the log relay running locally
on players' PCs.

**Why:**
- The Tier 0 spike (see `SPIKE-LOG-tier0-boot.md`) showed Fabric is heavy and
  fragile: its packages install over key-only SSH GitHub URLs (fail on a clean
  machine), pull ~400 MB including a headless browser, and one core package
  isn't even on the parts list. It never finished installing in a clean
  environment.
- The app's real job — watch a log file, post to Discord, share org contracts —
  does not need a decentralized peer-to-peer framework. An org has a trusted
  authority (its leadership/Discord), so a "trustless" design is over-built.
- Every actual feature survives removal; only generic plumbing needs replacing
  with standard parts (built-in HTTP, EventEmitter, crypto hashing).

**Consequences:**
- We forfeit (for now) decentralization and the cryptographic multisig contracts.
  These can be added later as *separate, optional modules* — the code keeps a
  `MissionManager` seam exactly for this.
- Install drops from ~400 MB + SSH setup to near-zero. M1 has **no** external
  dependencies at all.

---

## D-003 — Host on a small VPS
**Date:** 2026-06-08 · **Status:** Adopted

**Decision:** Host the shared contracts service on a small, low-cost cloud VPS
(always-on Linux box). Discord provides identity/interaction. The log relay runs
locally on each player's PC (it must, because `Game.log` only exists there).

**Why:** Simplest reliable way to have one shared source of truth the whole org
can reach. Avoiding a host was the only real argument for the decentralized
approach, and a few-dollars-a-month box is far simpler than operating a p2p
network. Discord is *identity/front-door*, not a host — the service still has to
run somewhere.

**Open items:** choose provider + monthly cost; decide database (SQLite to start
is fine); set up deploy. Tracked for milestone M4.

---

## D-001 — Stub the missing MissionManager to unblock boot
**Date:** 2026-06-08 · **Status:** Adopted

**Decision:** Added a minimal in-memory `services/MissionManager.js` (no crypto)
so the service can boot. The real mission/contract logic replaces it later.

**Why:** The original branch references `MissionManager.js` but never shipped it,
causing an instant crash. The stub satisfies the interface the service expects
and confirmed the crash is resolved. It is a placeholder, not the real system.
