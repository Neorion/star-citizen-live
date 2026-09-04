# Design — A Distributed (Non-Central) Option

> **Status:** Design only; no code yet on this fork (a proven reference
> implementation exists elsewhere — see §6). See `DECISIONS.md` → **D-004**, and
> **D-008** (2026-09-04), which supersedes this doc's "defer the transport
> choice" stance: **the transport is Fabric, decided, not one of §6's
> candidates.**
> **Target rung:** **L1 — federated** (grow toward L2/L3 later).
> **Constraint:** Discord stays the **primary UI**; the federated layer runs
> *underneath* for resilience. **There is no VPS** (D-008) — a **Fabric Hub**
> (a seed/relay node, not an org-owned server) fills the always-reachable role
> §4's diagram originally gave the VPS.

This doc explains *what* a non-central version of the project looks like and
*how* we'd get there in small, testable milestones — written so a non-developer
can follow the shape and the trade-offs.

---

## 1. The goal, split in two

The project bundles two flows with **opposite** distribution needs. A good
distributed design treats them separately.

| Flow | What it is | Volume | Stakes | Natural shape |
|------|-----------|--------|--------|---------------|
| **A — Live event feed** | `Game.log` → kills/logins/etc., shared to the org | High, constant | Low (ephemeral) | Broadcast; eventual consistency is fine |
| **B — Missions & contracts** | post → apply → assign → sign/complete (UEC rewards) | Low | **High** (signed agreements) | Shared state that must be **verifiable** |

Most "decentralization is hard" pain comes from forcing both through one
mechanism. We don't.

---

## 2. Why this isn't "undo D-002"

D-002 removed **Fabric** — and that was correct, because Fabric was a *fragile
transport/runtime* (400 MB installs over SSH GitHub URLs that failed on clean
machines). What D-002 also shelved, but we still want, is **decentralized
trust**: signed, content-addressed objects and multisig contracts.

> **Keep:** identity-as-keypair, signed objects, multisig (`secp256k1`/`musig2`).
> **Avoid:** a heavyweight p2p framework and any "trustless consensus" machinery.

The crypto half already exists in `types/Mission.js`. We are not starting over.

---

## 3. The foundation: identity = keys, not accounts

With no central server to "log in" to, **identity must be a keypair** each member
holds. The org becomes a **roster of public keys** (a membership allowlist).
This single idea unlocks everything else:

- Every event a node broadcasts is **signed** → peers know *which member*
  reported it, with no server involved.
- Missions, applications, and completions are signed objects; multisig contracts
  are M-of-N over those same keys (exactly what `Mission.js` models today).
- **Free spam/sybil resistance:** nodes ignore anything not signed by a key on
  the roster.

The roster itself starts simple (a signed list the org leadership publishes) and
can decentralize later.

---

## 4. The L1 picture (what we're actually building toward)

```
        ┌─────────────────────────────────────────────┐
        │                  Discord                     │  ← primary UI (humans)
        └───────────────▲───────────────▲──────────────┘
                        │ bridge        │ bridge
                 ┌──────┴─────┐   ┌──────┴─────┐
   Game.log →    │   Node A   │◄─►│   Node B   │   ← members run nodes; they
   (local)       │ (a member) │   │ (a member) │     gossip SIGNED events to
                 └──────▲─────┘   └──────▲─────┘     each other (federation)
                        │                │
                        └───────┬────────┘
                          ┌─────┴──────┐
                          │ Fabric Hub │  ← seed/relay node (e.g. hub.fabric.pub,
                          │(not an org │    relay.goon.vc); helps peers find &
                          │  server)   │    reach each other. Holds no org data.
                          └────────────┘
   Game.log →    ┌────────────┐
   (local)       │   Node C   │◄─► … more member nodes …
                 └────────────┘
```

- Each node watches **its own** `Game.log` locally (already true — the log only
  exists on the player's PC).
- Nodes **gossip** signed events to a few peers; every node ends up with the same
  feed without a single required hub.
- One or more nodes act as a **Discord bridge**, mirroring the feed into channels.
  If any one node goes down, the others carry on — including whichever node was
  bridging Discord; **there is no VPS to go down** in the first place (D-008).

This is **L1**: a handful of trusted, member-run nodes federating over **Fabric**
(decided, D-008 — not a placeholder). No DHT, no hand-rolled NAT hole-punching —
Fabric's own seed hubs handle peer discovery and relay, which is exactly the
practical hurdle §7 point 2 used to justify keeping a VPS around. That justification
is gone.

---

## 5. How each flow works

**Flow A — live feed (federated broadcast):**
1. Node reads a new log line → `parser.js` classifies it (already built).
2. Node wraps it as a **signed event** `{ event, author_pubkey, sig, ts }`.
3. Node gossips it to its peers; peers verify the signature against the roster
   and drop duplicates (by content hash).
4. Bridge node(s) post it to Discord.

**Flow B — missions/contracts (replicated, verifiable state):**
1. A mission is a **signed, content-addressed object** (its hash = its ID).
2. `apply` / `assign` / `complete` are further signed events that reference that
   hash.
3. Mission **state** = a deterministic fold over those events, with simple
   conflict rules (poster's signature is authoritative for assignment; a
   multisig completion needs its signature threshold).
4. **No node adjudicates** — every node computes the same state and verifies the
   signatures itself. A completed contract is provable offline by anyone.

---

## 6. Transport choice — decided: Fabric (D-008, 2026-09-04)

This section used to defer the choice among the four candidates below. **The
owner has since decided: Fabric.** Kept for the record of what was weighed, and
because the reasoning explains *why* Fabric is an acceptable answer to the
exact concern that made D-002 remove it in the first place.

| Option | Why it was considered | Watch-out | Status |
|--------|-------------|-----------|---|
| **Fabric** (Schnorr-signed peers, seed-hub bootstrap) | Not actually a candidate at write-time — D-002 had removed it for being fragile. Reconsidered because a **working, tested reference implementation now exists** (see below) and it's what the upstream fork independently converged on. | Same install-weight concerns D-002 raised, ~400 MB dep tree — mitigated by making it an **optional, strippable module**, not a core dependency (D-008). | **Chosen** |
| Plain signed HTTP/WebSocket gossip | Tiny, no new deps, nodes already run an HTTP server | Hand-roll peer list + retries + NAT traversal ourselves | Not pursued |
| Nostr-style (signed events + swappable relays) | Reuses our exact secp256k1; relays are redundant & replaceable | Relays are *semi*-central (run several) | Not pursued |
| Hyperswarm / Hypercore | True serverless, NAT hole-punching, append-only signed logs | Newer; more glue; really an L3 tool | Not pursued |
| js-libp2p | Battle-tested gossipsub + DHT | Heaviest; over-scoped for L1 | Not pursued |

**Not a cold start.** A consent-gated Fabric integration — peer identity, the
`_canShareLogs()` / `_logSharePublishOpts()` per-peer opt-in gate (this is where
"share with chosen members only" already lives, with no new design needed for
it), `_startFabricFlush()` for outbound queuing, `_ingestEvent()` folding inbound
peer batches through the *same* history-apply path local events use — was built
and tested this session on the `martindale-star-citizen-live` clone's
`feat/op-participation` branch. MD0–MD2 below are largely **already done there**;
what remains is porting/adapting the pattern onto this fork's much smaller
`app/server.js`, not inventing it fresh.

A small **CRDT** library (Automerge/Yjs) may still go *inside* Fabric's gossip, to
merge mission state without conflicts — evaluated when the mission register's
federated-home question (`HANDOFF-master.md` §4) is picked up, not before.

---

## 7. Honest hard parts (designed-for, not hand-waved)

1. **Source trust is unfixable by decentralization.** Only you see your own
   `Game.log`; a node could *lie* about kills. Signing proves **who said it**, not
   **that it's true**. Accept this; don't pretend otherwise.
2. **NAT traversal** (home routers) is the #1 practical hurdle for real p2p —
   **Fabric's seed hubs solve this for us** (relay when a direct connection isn't
   reachable), which is exactly the job §4's diagram used to give the VPS. This
   used to be an open problem this doc scoped around; as of D-008 it's a solved
   one, inherited from the transport choice.
3. **Eventual consistency:** two members may briefly see different mission states;
   the conflict rules in §5 settle it, and the UI must tolerate "settling."
4. **No blockchain needed.** UEC isn't on-chain money; signatures give
   non-repudiation + audit, settlement stays social/in-game. Heavy consensus would
   be over-engineering.
5. **Roster management** (adding/removing members, key rotation) is its own small
   problem; start with a leadership-signed list, decentralize later.

---

## 8. Spike plan (M-series) — design/spike only, no production build

Each milestone is small, demoable, and ends with a retro note in `PROGRESS.md`.
These slot **after** the existing roadmap's M3-combat and can run in parallel with
M4/M5 thinking.

- **MD0 — Identity primitives.** Generate/load a per-node keypair; sign + verify
  a sample event. **Fabric provides this directly** (Schnorr identity) — no need
  to reuse `Mission.js`'s secp256k1/musig2 for the transport layer specifically;
  that crypto stays reserved for M6's register signing. *Already proven* on the
  `feat/op-participation` reference — this is a port, not a spike.
- **MD1 — Signed event envelope.** Define the wrapper around the existing parser
  output; round-trip + verify; reject events from a peer without consent
  (`_canShareLogs()` in the reference implementation). *Already proven* there too.
- **MD2 — Two-node federation (the transport spike).** Stand up **two** local
  nodes; Node A gossips signed events to Node B **over Fabric** (decided, not a
  spike choice); B dedupes by hash and shows the same feed. *Demo:* replay a log
  on A, watch events appear on B. *Already proven* on the reference branch
  (quantum-travel + ship-use events, consent-gated) — remaining work here is
  porting that pattern onto this fork's `app/server.js`.
- **MD3 — Discord bridge as a node.** Make one node mirror the federated feed into
  Discord, proving Discord is a *view*, not the backbone — kill the bridge node
  and the feed still flows between A and B. *Demo:* bridge down, federation up.
- **MD4 — Missions as signed, foldable state.** Represent post/apply/assign as
  signed events; compute mission state by folding them on every node; apply the
  conflict rules; (optional) evaluate a CRDT lib here. *Demo:* two nodes
  independently agree on the same mission's assignee.
- **MD5 — Multisig completion.** Wire `Mission.js` musig2 so an M-of-N contract
  completes only when the signature threshold is met, verifiable on any node with
  no server. *Demo:* 2-of-3 completion verified offline.
- **MD6 — Roster + membership.** Leadership-signed roster of pubkeys; nodes accept
  only roster-signed events; cover add/remove/rotate. *Demo:* an off-roster node's
  events are ignored org-wide.

**Stop/return points:** MD0–MD2 are de-risked already (the reference
implementation is the go). After **MD5** we have a genuinely decentralized
contract layer for the mission register, if/when that's picked up. L2/L3
(dropping even the seed-hub relay for pure serverless discovery) remain later,
optional escalations — not required by D-008, which only removes the VPS, not
Fabric's own seed-hub layer.

---

## 9. What this does *not* change

- Discord stays the primary, human-facing UI.
- The local `Game.log` watcher / `parser.js` are unchanged — they just feed a
  signing+gossip layer instead of (or in addition to) a single central service.
- **There is no VPS to keep running (D-008).** If the org later wants a
  reliably-online node for the Discord bridge or a web UI, that node is one
  Fabric peer among several, not a privileged central server — see
  `HANDOFF-master.md` §4 for the one thing that still genuinely needs a
  federated-or-elected home: the mission register's single-source-of-truth
  requirement (D-005), which this doc's Flow B (§1/§5) was always scoped to
  handle separately from the event firehose.
