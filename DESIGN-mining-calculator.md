# DESIGN — Mining rock-crack calculator (SC 4.10+, optional module)

> **Status:** Phases 0–1 **built and verified 2026-09-24** (uncommitted working tree;
> owner to pick the branch). Against SC **4.10.1-LIVE**. Same separability contract
> as the cargo router: one engine + one static page + one dashboard tab, strippable
> with zero impact on the core relay, zero runtime dependencies (D-002).
>
> | Built | Where |
> |---|---|
> | Engine (pure, CommonJS + browser global) | `app/mining-calc.js` |
> | Standalone page, Permafleet tokens, phone-ready | `app/mining.html` (served at `/mining`; `?embed=1` hides the header) |
> | Baked 4.10.1 data + browser copy | `data/mining-reference.json`, `app/mining-data.js` — `npm run build-mining` |
> | Routes | `app/server.js`: `/mining`, `/mining-calc.js`, `/mining-data.js`, `GET …/mining/reference` |
> | Dashboard tab | `app/ui.html`: `⛏️ Mining` → iframe of `/mining?embed=1` (lazy) |
> | Tests (12) | `test/mining-calc.test.js` — formula, both stacking rules, tips, data snapshot |
>
> **For the GoonCitizen app (Electron / Android React SPA):** copy the three files
> `app/mining.html`, `app/mining-calc.js`, `app/mining-data.js` into any static folder
> or WebView — they need no server (data is a script global). To go native-React, lift
> `mining-calc.js` unchanged (`require`/`import` works) and reuse the JSON; the page's
> `<style>` block is the Permafleet token set.
>
> **Not built yet:** §7 calibration file, §5 OCR, the mass-vs-resistance chart.

---

## 1. What it does

A player enters the numbers the in-game scan shows for a rock — **Mass (kg)**,
**Resistance (%)**, **Instability (%)** — plus their loadout (ship → laser heads →
modules per head, active/passive → one gadget). The tool answers:

1. **Required raw laser power (MW)** to fracture the rock, and the **throttle %**
   that means on each laser you have.
2. **Verdict:** crackable solo · crackable with a gadget/active module · needs *N*
   lasers (multi-crew / MOLE) · unbreakable with this kit.
3. **Shortfall** in MW when it won't crack, and **what would tip it** (tries every
   gadget and active module you own and lists the ones that make it crackable).
4. **Inverse view (phase 2):** "max mass I can crack at resistance R" curve, the
   chart that mort13's BreakabilityChart draws.
5. **Advisory:** effective instability after laser/module/gadget modifiers, so a
   crackable-but-volatile rock is flagged.

Out of scope: ore value / refinery yield (Regolith, UEX and SCMINER already do that
well — link out, don't rebuild).

## 2. The model (community model — CIG has never published the formula)

Two independent public tools implement the **same** break rule, and it matches the
per-head numbers SCMINER shows for 4.10.1:

```
R_eff  = R_rock/100 × M                     M = Π (1 + mod_i/100) over head, active modules, gadget
P_need = c × mass / (1 − R_eff)             c = 0.2   ⇔   mass_max = 5 × P × (1 − R_eff)
P_head = P_max(head) × Π (pwr_i/100)        pwr_i = each module's "Mining Laser Power" (e.g. Surge 150)
throttle% = P_need / P_head                 crackable if ≤ 100 % (minus a safety margin, §2.2)
```

Sources: mort13 `BreakabilityChart/js/calculations.js` (`c_mass = 0.2`, multiplicative
resistance factors), GrimHEX rock-break calculator (`mmax = 5·Pactive·(1−R·M)`),
SCMINER (Helix I 3,900 W → 10,833 kg max at 0 % resistance, i.e. 3900 × 5 / 1.8 —
consistent with c = 0.2 and a 1.8 safety divisor).

### 2.1 Where the tools **disagree** — multi-laser combination (open question)

| Rule | Who | 3× Helix II (−30 % each) on a 60 % rock |
|---|---|---|
| **A. Per-head:** each laser cracks its own share: `Σ P_i (1 − R·M_i)` | GrimHEX | M = 0.70 each → R_eff 0.42 |
| **B. Pooled:** `Σ P_i` with `Π M_i` across heads | mort13 | M = 0.70³ = 0.343 → R_eff 0.21 |

Rule B is far more optimistic. **Design decision:** the engine takes the rule as a
parameter, defaults to **A (conservative)**, and the calibration set (§7) decides.
Label the output "community model, uncalibrated" until §7 has data.

### 2.2 Safety margin

In-game values are rounded and instability eats headroom. Default margin **15 %**
(SCMINER's "solo-comfortable" threshold), user-adjustable. Report the raw ratio too.

### 2.3 What instability does

Not part of the break threshold in any public model. Reported as advisory:
`I_eff = I_rock × Π (1 + inst_i/100)` with a colour band. Don't overclaim.

## 3. Data — what's right, what's stale (verified 2026-09-24)

| Source | Keyless? | Laser power | 4.10 modules (Clearcut/Deluge/Overrun) | Notes |
|---|---|---|---|---|
| **star-citizen.wiki API v2** `api.star-citizen.wiki/api/v2/items/<slug>` | yes | **correct for 4.10** (Helix I 780–3900, Arbor MH1 117–2340), version-tagged `4.10.x-LIVE` | yes (Deluge res −15.5, Overrun res −24.8, Clearcut window +30) | Game-file extraction (ScDataDumper). Module **laser-power** modifier is *missing* from its `modifiers` list (Surge shows only instability/resistance); the wiki HTML page has it (+50 %). Some values come as strings (`"-15%"`). |
| **UEX API 2.0** `items` / `items_attributes` `id_category` 28 gadgets · 29 lasers · 30 modules | yes | **stale**: Helix I 630–3150, Arbor MH1 189–1890 (≈ pre-4.x ×0.8) | no | Modules' "Mining Laser Power" factor present (Surge 150, Stampede 135, Rieger-C3 125 …). Good for names/types/tiers. |
| mort13 `BreakabilityChart/data/*_merged.json` | n/a (file) | hand-patched to 4.x values ("custom power values" commits) | no | Confirms UEX→4.10 drift; MIT © 2026 mort13. |

**Pipeline (mirrors `scripts/build-uex-vocab.js` → `data/uex-reference.json`):**

- `scripts/build-mining-reference.js` — the *only* network step, run by hand after a
  patch: pull lasers/modules/gadgets from the **wiki API** (search endpoint works:
  `POST …/items/search {"query":"Mining Laser"}` → 18 heads; dedupe by slug), fill
  the module **laser-power** factor from **UEX** (or the wiki page) where the API
  omits it, normalise `"−15%"` strings, and record `version` + `source` per item.
- Output `data/mining-reference.json` (committed, served offline, attribution to
  both projects). Shape: `{ generatedAt, gameVersion, lasers[], modules[], gadgets[], ships[] }`.
- `ships[]` is hand-kept: Prospector 1×S1 · MOLE 3×S2 · Golem 1×S1 (new in 4.10) ·
  ROC / ATLS S0 (Lawson / S0 Helix / Arbor MHV show as size 0 — **verify which vehicle
  each fits before listing**).
- Test: schema, every laser has `0 < min < max`, every module/gadget modifier is a
  finite number, and a **snapshot assertion** on 3 known values so a silent upstream
  change fails the build (Helix I max 3900, Surge power 150, Sabir resistance −50).

## 4. Architecture (the separability boundary)

| Piece | Where | To strip |
|---|---|---|
| Engine (pure functions, no DOM, no I/O) | `app/mining-calc.js` — CommonJS + browser-safe (`if (typeof module !== 'undefined') module.exports = …`) | delete the file |
| Reference data + builder | `data/mining-reference.json`, `scripts/build-mining-reference.js` | delete both |
| Flag + 1 route | `app/server.js`: `SC_MINING_CALC=1`, `GET …/mining/reference` (serves the JSON), `miningEnabled` in `/monitor` | remove those lines |
| UI | `app/ui.html`: `⛏️ Mining` tab (hidden unless flag), `#mining-panel` | remove the panel |
| Tests | `test/mining-calc.test.js`, `test/mining-data.test.js` | delete |

No parser changes. No log coupling (§8 — the log has nothing to couple to). The
engine has **no dependency on the relay**, so the same file can back a standalone
`mining.html` for people who don't run the relay at all.

Engine API (proposal):

```js
const { compute } = require('./app/mining-calc');
compute({
  rock:   { mass: 12000, resistance: 55, instability: 30 },
  lasers: [{ head: 'helix-ii-mining-laser', modules: [{ id: 'surge-module', active: true }, { id: 'rieger-c3-module' }] }, …],
  gadget: 'sabir',
  options: { combine: 'per-head' | 'pooled', margin: 0.15 }
}, referenceData)
// → { pNeed, perLaser: [{ pHead, throttle }], rEff, iEff, verdict, shortfallMW, tips: [...], model: 'community-v1' }
```

## 5. Inputs (UI)

- **Ship preset** → pre-fills laser slots and sizes; each slot: head dropdown
  (filtered by size), module slots per head (count from data), active toggles.
- **Rock:** mass, resistance, instability — manual entry. Loadout persists in
  `localStorage` so a MOLE crew doesn't re-enter three heads every rock.
- **Gadget:** one, or none.
- **Phase 2 — OCR:** screenshot of the scan → mass/resistance/instability. Two
  existing pipelines to borrow from: this repo's contract-screen OCR on
  `feature/cargo-router` (tesseract.js) and mort13's 2,100-line CNN/anchor OCR
  (MIT). Decide later; manual entry first.

## 6. Outputs (UI)

Verdict card (green / amber / red), required MW, per-laser throttle bars, shortfall,
"what would tip it" list, effective instability badge, and a one-line honesty label:
*"Community model, not CIG-published — calibrated on N rocks (4.10.1)"* with N live
from `data/mining-calibration.json` (§7). Phase 2 adds the resistance-vs-mass chart.

## 7. Calibration (turns "community model" into "verified on real rocks")

Same honesty rule as the parser's `verified` flag. Org miners record real rocks:

```
{ version: '4.10.1', mass, resistance, instability, loadout, gadget,
  minThrottleThatCracked | didNotCrackAtThrottle, pilot, date }
```

into `data/mining-calibration.json` (committed, small). A test asserts every
observation is consistent with the model (predicted throttle ≤ observed crack, >
observed fail) under the chosen combination rule; the **first multi-laser
observations settle §2.1**. Target: 10 solo rocks + 5 MOLE rocks before the tab
leaves "experimental". This is the only way to move the label from *inferred* to
*validated*.

## 8. Log side — verified negative (bounded)

A grep across the 525-log `Gamelogs/` corpus for mining tags found **only tutorial
HUD notifications** ("Welcome to Mining…", "Mining - Fracture: Target a rock…") —
no rock mass/resistance, no laser/loadout lines. So the calculator cannot be
auto-filled from the log, and no parser rule is proposed. (Full audit with the
B-015 unmatched-line report can confirm; not blocking.)

## 9. Phases and effort

| Phase | Deliverable | Effort |
|---|---|---|
| **0 — Data + engine** | `build-mining-reference.js`, `mining-reference.json`, `mining-calc.js`, tests (formula, both combination rules, snapshot values) | 1 session |
| **1 — Tab** | `⛏️ Mining` tab behind `SC_MINING_CALC`, presets, verdict card, tips, localStorage | 1 session |
| **2 — Calibration + chart** | calibration file + test, honesty label wired, mass-vs-resistance chart | ½ session + org data |
| **3 — OCR** | screenshot → rock stats, reuse cargo OCR | 1 session, after Phase 2 |

## 10. Decisions for the owner

1. **In this repo as a module (recommended, per the cargo-router pattern) or a
   separate static repo?** The engine is standalone either way.
2. **Reuse mort13's code or only its findings?** Recommend *findings only*: the
   engine is ~60 lines of arithmetic and the repo style is CommonJS/no-ESM. Cite
   mort13 (MIT) in `REFERENCES.md`; borrow the OCR later under its licence if wanted.
3. **Default multi-laser rule:** A (conservative) until calibration says otherwise.
4. **Housekeeping (do first):** `BreakabilityChart/` is an untracked *nested git
   clone* of `mort13/BreakabilityChart` containing **hard-coded third-party UEX API
   tokens** (`data.js`, `fetchuex.py`). Do **not** commit it into this repo — add
   `BreakabilityChart/` to `.gitignore` or move it beside the project. Never reuse
   those tokens; our pipeline is keyless.

## 11. Sources

- mort13 — BreakabilityChart: https://mort13.github.io/BreakabilityChart/ (clone in `BreakabilityChart/`)
- GrimHEX rock-break calculator: https://grimhex.net/tools/mining/calculator
- SCMINER crackability matrix (4.10.1): https://scminer.rocks/calculators/rock-crackability
- Regolith Co. laser loadouts: https://regolith.rocks/loadouts/lasers
- star-citizen.wiki API: https://api.star-citizen.wiki/api/v2/items/<slug> (e.g. `helix-i-mining-laser`, `deluge-module`)
- UEX API 2.0: https://api.uexcorp.uk/2.0/items_attributes?id_category=29
- 4.10 mining changes: https://www.elyxir.gg/news/star-citizen/star-citizen-410-overview-key-features-mining-changes-and-pu-fixes
- Module pages: https://starcitizen.tools/Clearcut_Module · Deluge_Module · Overrun_Module
