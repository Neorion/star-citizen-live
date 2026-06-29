# DESIGN — Cargo planning, manual board & OCR fill-in

> **Status:** Design (no code yet). Extends the shipped cargo route optimizer
> (`DESIGN-cargo-router.md`, branch `feature/cargo-router`) from a log-only tracker
> into a **planning + tracking board** with manual control and an optional OCR
> fill-in. Owner-requested, lead-dev-optional, **strippable** like the router.
> **Decisions below are tagged `[DECIDED]` (agreed with the owner) or `[OPEN]`.**

---

## 1. The problem this solves

The log-only router has three limits the owner hit in real testing:
1. **It can't see un-accepted offers** — so you can't *plan* which contracts to take.
2. **It can't read the pickup** of a "deliver to X" contract (the log omits it on 4.8.0).
3. **OCR/manual missions have no log lifecycle** — nothing auto-completes them.

The fix is to stop treating the log as the only source, and to let the **user be
the authority** over their own board.

## 2. Three sources of truth `[DECIDED]`

Every mission *fact* (status, pickup, dropoff, cargo, reward…) carries a **source**:

| Source | Icon | Nature |
|---|---|---|
| **Log** | 📡 | Automatic, reliable for what SC writes to `Game.log`. |
| **OCR** | 📷 | From a screenshot of the contract screen — fills log gaps. |
| **Manual** | ✋ | The user typed/checked it. |

**The UI shows provenance per fact** (a small source icon) — the project's honesty
rule applied: you always know where a number came from.

**Precedence when sources disagree:** `Manual > Log-lifecycle > OCR > empty` `[DECIDED]`.
- A user mark (complete/abandon/edit) always wins.
- A log completion auto-updates *unless* the user has overridden it (show a subtle
  "log says complete" hint so the override is informed).
- OCR only fills fields that are still empty.

## 3. One model for planning AND tracking: a status lifecycle `[DECIDED]`

Don't make planning vs tracking a *mode* — make it a **status**. One board holds all:

```
Candidate ──accept in-game──▶ Active ──┬─▶ Completed
(offer; OCR/manual,           (accepted;├─▶ Abandoned
 not accepted — your          log/OCR/   └─▶ Expired (offer/contract timed out)
 planning sandbox)            manual)
```

- **Candidate** = an offer you're weighing. Source: OCR-of-offer-board or manual add.
  **No acceptance required** — this is the planning sandbox.
- **Accepting in-game** fires the log `Contract Accepted`, which **promotes** the
  matching candidate to **Active** (match on title + dropoff). The log confirms the plan.
- **Route / Optimize run over any status filter:** "route my **candidates**" (compare
  before committing) vs "route my **actives**" (run what you took).
- **Completed** missions **grey out + strikethrough + ✓**, with a checkbox to confirm/
  clear (and to manually complete log-missed ones). They don't vanish — they age into
  a collapsed "Done" section. `[DECIDED]` (fixes the "Orbituary silently disappeared" UX)

Distinct visual language per status (never reuse "dimmed" for two meanings):
Active = normal · Completed = grey+strike+✓ · Carried-over = amber ⏳ · Abandoned =
grey+✗ · Candidate = dashed border / "OFFER" badge.

## 4. Mission data model (sketch)

```
mission {
  id            // stable (survives refresh/reorder)
  status        // candidate | active | completed | abandoned | expired
  source        // per-field provenance map: { pickup:'ocr', dropoff:'log', ... }
  title, rank, contractType, reward     // from log accept line and/or OCR
  pickup        // 'from X' (log) or OCR; null if only the dropoff is known
  legs[]        // { commodity, scu, dropoff, body, pickedUp:bool, deliveredScu }
  order         // user drag-order (null = use optimizer)
  capturedAt, lastSeen, expiresAt
  notes
}
```
- **Stable `id`** is the linchpin for drag-reorder persistence and dedup.
- **Dedup on contract identity** (title + dropoff + reward), not the image file:
  re-capturing the same contract **updates + restamps `lastSeen`**, never duplicates. `[DECIDED]`

## 5. Phase 1 — the manual board (no OCR) `[DECIDED to build first]`

Pure data + UI, cross-platform, valuable on its own. Lives in the Cargo tab.

- **Statuses & actions:** mark Complete / Abandoned / Expired; per-leg **Picked up ✓**
  (the original point of the Route button); **manual add / edit** a mission (fix an
  OCR/typo, or enter one the tool missed); **snooze/hide**; **pin/priority**; **notes**.
- **Reorder:** drag-and-drop to set your own visit order → **Route** shows *your* order;
  **Optimize route** re-sequences by body-cluster + capacity. (Reorder operates on
  **stops/waypoints**; order persists via the stable id.) `[DECIDED]`
- **Refresh controls:** **Manual refresh**, **Auto-refresh** (configurable interval),
  **Purge & rebuild** — *purge clears only the OCR+manual layer, never the live log
  state.* `[DECIDED]`
- **Folder config field** (used by phase 2) lives here too, persisted to local config.

> Phase 1 already delivers *planning*: hand-enter candidate offers, route/compare them,
> then let the log promote them to active when you accept. OCR just makes populating
> them faster.

## 6. Phase 2 — the OCR fill-in (optional, separable)

### Capture `[DECIDED: game-aware capturer → watched folder → we crop]`
- In-game region/hotkey capture is fragile across rigs (exclusive-fullscreen, elevation,
  anti-cheat). So **don't capture a region** — let a **game-aware full-screen capturer**
  the user already has (**Win+Alt+PrtScn Game Bar**, Medal, NVIDIA; on Linux Spectacle/
  Flameshot/Steam) drop full frames into a **user-defined folder**; **we crop in software**
  to a calibrated region. This is also why it's cross-platform.
- **On-demand by default** ("Update now"), with optional folder-poll auto-watch. `[DECIDED]`
- **Filter noise:** the folder has unrelated shots — *attempt to parse; keep only what
  reads as a contract*; junk produces no mission and is ignored.

### Crop profiles `[OPEN]`
- **Offer board** (pre-accept): crop *below the mission name, above "Accept Offer"* —
  this is the **planning** screen (candidates).
- **Active-mission manager** (post-accept): different layout, **no Accept button** — this
  is where the **pickup** detail for "to X" contracts lives.
- **Decision needed:** support both profiles, or standardize on one to start?

### OCR engine `[OPEN — leaning tiered/local-first]`
Trade local/private/free against accuracy/ease:
| Engine | Local? | Notes |
|---|---|---|
| Tesseract | ✅ local, tiny, free | weak on SC's stylized fonts (accuracy risk) |
| EasyOCR / PaddleOCR | ✅ local | better, heavy Python+model deps |
| Local vision-LLM (Ollama: moondream / Llama-3.2-Vision) | ✅ local | best at *layout understanding*; GB models, ideally GPU |
| **Claude vision API** | ☁️ cloud | highest accuracy, lightest to integrate (fetch + key), per-image cost, sends images off-machine |

- Owner constraint: **local-first, but not at the cost of core ability**; must be
  **shareable/installable**; privacy matters.
- **Proposed shape:** a **tiered/hybrid** — a local engine as the free/private default,
  Claude vision as an optional high-accuracy fallback (own flag/key). Pick the local
  default after a quick accuracy bake-off on real SC screenshots.
- **aUEC reward** isn't in the log — OCR *can* read it, which is real planning value
  (profit-per-SCU). A reason the offer-board profile matters.

### Provider config — vendor-agnostic, keys via env only `[DECIDED: Claude now, swappable]`
A thin **adapter interface** so the engine is swappable without touching callers:
```
extractContract(imageBuffer, profile) -> { title, pickup, dropoff, commodity, scu, reward, expiresAt, ... }
```
Implementations behind one config: **Claude** (now), **OpenAI**, **local** (Tesseract/VLM), **none**.
- **Config (env-driven, never hardcoded — same rule as DISCORD_WEBHOOK_URL):**
  - `SC_OCR_PROVIDER` = `claude` | `openai` | `tesseract` | `none` (default `none`).
  - `ANTHROPIC_API_KEY` (Claude) / `OPENAI_API_KEY` (OpenAI) — read from env or the
    gitignored `settings/local.js`; **never committed**.
  - `SC_OCR_MODEL` (optional override; default a cheap vision model per provider).
- **Zero-dep win:** both Claude and OpenAI vision are plain HTTPS — callable with Node's
  built-in `fetch` (already used for Discord). **No SDK / npm dependency** for the cloud
  providers; only the *local* engines add install weight. So the OCR module stays inside
  the project's zero-dep footprint unless a user opts into a local engine.
- **Cloud request shape (both providers):** POST a base64 image block + a "return these
  fields as JSON" prompt → parse the JSON. Default model = the cheap vision tier (Claude
  Haiku / GPT-4o-mini) since OCR extraction is light.
- **Shareable note:** each user supplies **their own** key (cost + security); the install
  pack should let them paste a key (stored locally) or set the env var, and we recommend
  setting a **spend limit** on the key in the provider console.

## 7. Separability & footprint `[DECIDED]`

- All of this stays in the **optional cargo module + flag + Cargo tab**. Delete them →
  core relay + tests untouched (D-002 zero-dep footprint preserved).
- The **OCR engine is the only piece that breaks zero-dep**, so it's an **optional,
  out-of-process** sub-module behind its own flag — never required for the manual board.
- **Cross-platform:** the manual board + folder-watch are OS-agnostic (good for the
  owner's Linux users); only the OCR engine is OS-sensitive (Tesseract/Claude both run
  on Linux; Game Bar is Windows-only but any capturer that writes to the folder works).

## 8. The planning payoff to keep in view `[OPEN / later]`

Beyond routing, planning's killer feature is **selection**: "I have N offers and a
64-SCU hold — which subset is the most efficient/profitable load?" A knapsack pick over
candidates. Not phase 1, but the model (candidates + reward + SCU) is built to support it.

## 9. Open questions to close before/while building

1. **Crop profile(s)** — offer board, active-mission, or both first? (§6)
2. **OCR engine** — confirm tiered local-first; which local engine as default? (§6)
3. **Selection/knapsack** — in scope eventually, or routing-only? (§8)
4. Anything else the owner wants in the **status set** or **per-leg actions**? (§5)

## 10. Build order

1. **Phase 1 — manual board** (statuses, mark/complete/abandon/picked-up, add/edit,
   reorder + Route/Optimize, refresh modes, folder config, provenance icons). Ships value
   immediately; cross-platform; no OCR.
2. **Phase 2 — OCR fill-in** (capture-folder watcher + crop + chosen engine) feeding the
   same model phase 1 already uses.
3. **Phase 3 — selection/knapsack** planning (optional).
