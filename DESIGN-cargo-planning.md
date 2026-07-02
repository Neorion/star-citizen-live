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

### OCR engine `[DECIDED 2026-06-30: browser-side Tesseract.js default; Claude optional fallback — see §6b bake-off]`
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

## 6b. Phase 2 spec — bake-off evidence, UX walkthrough & clash handling `[DECIDED 2026-06-30]`

> This section is the **implementation spec** for Phase 2. It is written to be
> self-contained: an implementer should need only this file + the existing cargo
> module conventions (`services/CargoRouter.js`, `app/ui.html` Cargo tab,
> `POST …/cargo/action`) + the repo guardrails (`AGENTS.md` §6).

### Bake-off evidence (real data, 2026-06-30)
Tested on **7 real contract screenshots** (5120×1440 Medal frames, mobiGlas
ACCEPTED detail screen, Red Wind small hauls). Pipeline: crop to contract panel →
greyscale → **invert** (SC is light-on-dark; OCR wants dark-on-light) → 2× upscale
→ contrast → Tesseract (tesseract.js v5), then light domain normalization.

| Field | Result | Notes |
|---|---|---|
| Title + from/to endpoint | 7/7 | exact |
| **Reward (aUEC)** | 7/7 | `172,250` perfect every time — the log never has this |
| Contractor | 7/7 | "Linshaul/Linhaul" → normalize |
| **Pickups** (`Collect X from Y`) | 7/7 | incl. multi-source; zero hallucinations (verified vs image) |
| Deliver lines w/ SCU | 7/7 present, 5/7 clean | `0/10`→`0710` (slash reads as `7`) — deterministic fix, `have/need` format is known |
| Confidence / speed | 84–86 / ~1.7s per contract | consistent |

**Verdict:** ~95% raw, effectively 100% recoverable with a normalizer + the
review tray. Local-first holds without losing core ability.

**Bonus findings:** (1) **one ACCEPTED-detail screenshot = the complete mission
model** — payout, deadline, contractor, pickup(s) *with planet*, dropoff(s),
per-drop SCU, rep tiers. This closes both the "pickup not in log" and "cargo
logged only after physical load" gaps in one capture per contract. (2) The screen
header (`OFFERS` / `ACCEPTED (7/10)`) **auto-classifies** candidate vs active and
gives a free held-contract count.

**Required normalizer (domain-aware post-processing):**
- `(\d)7(\d+)` in a `Deliver`/`have-need` context → `$1/$2` (slash misread).
- `Sb.` → `5b.`; `S00` → `500`; smart-quotes → ASCII.
- Fuzzy-match commodities/stations against the known vocab (the corpus lists +
  `bodyFromStation()` names) before accepting a field.

### Architecture (locks in the earlier tiering decision)
- **OCR runs in the BROWSER** (tesseract.js WASM, vendored or CDN) with **canvas
  preprocessing** (crop/invert/upscale/threshold). The Node relay **never touches
  image bytes** — it only (a) lists/serves files from the configured screenshots
  folder and (b) receives parsed contract JSON. Zero new npm deps server-side;
  cross-platform (Linux users just point at their capturer's folder).
- **Claude tier** stays server-side behind `SC_OCR_PROVIDER=claude` +
  `ANTHROPIC_API_KEY` (env only) as an optional accuracy fallback per §6 provider
  config. Never required.

### The three invariants (these make it idiot-proof — do not violate)
1. **One funnel.** Every image — folder-watch or drag-drop/paste — flows through
   the same parse → classify → dedup → stage/commit pipeline.
2. **Idempotent imports.** Dedup on contract identity (title + endpoint + reward):
   re-processing the same contract **merges (fills blanks only, restamps
   `lastSeen`)** — it can never duplicate, regress a field, or damage the board.
3. **OCR never changes status.** Imports fill *data*. Status transitions belong to
   the log lifecycle and the user (precedence stays manual > log > OCR). An import
   matching a completed/abandoned mission must NOT resurrect it.

### UX walkthrough
**Setup (once, ~60s):** Cargo tab → ⚙ Capture panel → folder path (pre-filled with
the Game Bar default `Videos\Captures`) → **Calibrate**: latest screenshot renders
in-browser, user drags a crop box over the contract panel (saved as a named
profile; re-drag on resolution change) → **Test** button OCRs it and shows the
parsed card.

**Automated loop:** user hits `Win+Alt+PrtScn` on a contract detail screen (their
*only* job) → folder watcher notices (poll, same pattern as the log poller) →
browser fetches + crops + OCRs (~2s, local) → classifier: non-contract images are
silently ignored (receipt line, never an error) → `OFFERS`→Candidate /
`ACCEPTED`→Active → dedup/merge → **receipt toast** ("📷 Imported: Small Haul →
Orbituary · ¤172,250 — Undo"). Low confidence / missing fields → a **"Needs review
(N)" tray** with an editable pre-filled card (never a blocking modal, never a
silent guess).

**Manual path:** drag-drop or Ctrl+V an image anywhere on the Cargo tab — same
funnel, different door.

### Clash matrix (agreed behaviours)
| Scenario | Behaviour |
|---|---|
| Rapid successive screenshots | Process in capture (mtime) order; idempotent dedup means same-contract shots merge, distinct ones create cards |
| Abandon in-game after import | Log `EndMission[Abandon]` → ✕ Done; later screenshots do **not** resurrect (invariant 3) |
| Re-accept same contract later | New log missionId → new card; old stays in Done |
| Game crash | Existing session/⏳ carried-over logic; **re-screenshotting the ACCEPTED tab re-confirms** (a screenshot is the verification action) |
| Relay/browser off when screenshot taken | Nothing lost: **the folder is the durable queue** — catch-up scan processes files newer than the persisted last-processed mark |
| Re-shot after progress (0/9→4/9) | Progress merges forward-only (`max()`); log owns live progress |
| Old/unrelated shots in folder | Only files newer than "watch started" by default; explicit "Import older…" backfill; non-contracts ignored with a receipt count |
| OCR import races the log accept | Dedup merges (candidate promotes, keeps OCR payout, gains missionId); stray twin = 🗑 + Undo |
| Resolution change breaks crop | Classifier finds nothing → gentle "couldn't read — recalibrate?" linking to the drag-box |
| OCR-only mission abandoned in-game (no id match) | Honest limit: may not auto-flip; covered by ✕ + a stale sweep (not re-seen in N sessions → flagged) |

**User guidance to surface in tips:** screenshot the contract **detail** view (the
clicked-open panel), not the list — the list imports partial and lands in review.

### Build slices (each shippable + testable alone)
1. **Import funnel core:** paste/drag-drop → canvas crop (fixed profile) →
   tesseract.js → normalizer → preview-confirm card → `POST …/cargo/action` add /
   merge. (No folder watch yet.)
2. **Dedup/merge + receipts + review tray + Undo.**
3. **Folder watch:** server lists new files (`GET …/cargo/screens` + serve image),
   browser OCRs, last-processed mark persisted; catch-up scan; "Check now" button +
   auto toggle.
4. **Calibration UI** (drag crop box, profiles) + `OFFERS`/`ACCEPTED` auto-classify.
5. **Claude fallback tier** (server-side, env key, per §6 provider config).

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

1. ~~Crop profile(s)~~ **CLOSED (§6b):** the ACCEPTED **detail** screen is primary
   (it carries the complete model); the offer board is the same funnel via the
   `OFFERS` header auto-classify. Calibration supports named profiles anyway.
2. ~~OCR engine~~ **CLOSED (§6b bake-off):** browser-side tesseract.js default;
   Claude vision optional server-side fallback.
3. **Selection/knapsack** — in scope eventually, or routing-only? (§8)
4. Anything else the owner wants in the **status set** or **per-leg actions**? (§5)

## 10. Build order

1. **Phase 1 — manual board** (statuses, mark/complete/abandon/picked-up, add/edit,
   reorder + Route/Optimize, refresh modes, folder config, provenance icons). Ships value
   immediately; cross-platform; no OCR.
2. **Phase 2 — OCR fill-in** (capture-folder watcher + crop + chosen engine) feeding the
   same model phase 1 already uses.
3. **Phase 3 — selection/knapsack** planning (optional).
