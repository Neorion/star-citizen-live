# Reference Projects — reuse catalog

A living list of Star Citizen open-source projects with **code, patterns, data, or
tooling** we can draw on for this project's goals (log relay → Discord/API, mission
register + officer validation, mission-type classification, player-down/combat
signals, metrics, cross-platform packaging, friendly-name enrichment).

> **Verify before you borrow.** Licences below are unconfirmed unless noted — check
> each repo's LICENSE before copying code (MIT/Apache/BSD = reusable with notice;
> GPL/AGPL = copyleft, treat as *ideas only*; none = ideas only). Also check the last
> commit (archived/stale = ideas only) — see "How to consider a project" at the end.

## How each maps to our goals

### A. Game.log parsing / kill & event tracking  *(core — and the kill lead)*
| Project | Lang | Take | Notes |
|---|---|---|---|
| [DimmaDont/all-slain](https://github.com/DimmaDont/all-slain) | Python | **regexes + ideas** | Maintained (2025). **RECONCILED (2026-06-14):** its `<Actor Death> CActor::Kill` format = our dormant rule, and code comment confirms "4.0.2 no longer reports kills that don't involve the client player." Our parser passes its test lines (Bullet + VehicleDestruction). So kills DO log — for the running player only. |
| [PINKgeekPDX/VerseWatcher](https://github.com/PINKgeekPDX/VerseWatcher) | Python | regexes + ideas | Real-time monitor w/ player names, weapons, ships. Same kill-reconciliation value. |
| [Ozy311/StarLogs](https://github.com/Ozy311/StarLogs) | Python | regexes + dashboard idea | Already our reference for the documented `<Actor Death>`/`<Vehicle Destruction>` formats. |
| [BubbaGumpShrump/AutoTrackR2](https://github.com/BubbaGumpShrump/AutoTrackR2) | PowerShell | pattern | Kill tracking with **API integration** — mirrors our external-input `/kills` channel. |
| [cornholio21/CornFeed](https://github.com/cornholio21/CornFeed) | — | pattern | Minimal log-based kill feed. |
| [Miwshera/TouchPortal-SCTools](https://github.com/Miwshera/TouchPortal-SCTools) | — | pattern | Reads Game.log for kill events (Touch Portal plugin). |
| [greluc/SC-Kill-Monitor](https://github.com/greluc/SC-Kill-Monitor) | Java | ideas only | **GPL-3.0, archived Nov 2025** — its archival is consistent with the kill-log format changing. |
| [ckuma/scplay](https://github.com/ckuma/scplay) | Python | idea | Playtime from log timestamps — a session/play-time metric we could add. |

### B. Discord bots / org & fleet management  *(M5.3 + register)*
| Project | Lang | Take | Notes |
|---|---|---|---|
| [Iridium-Confederation/IRCON-Bot](https://github.com/Iridium-Confederation/IRCON-Bot) | — | structure + ideas | Fleet management bot; imports a member's fleet from RSI. Reference for our bot + roster. |
| [StarCitizenWiki/discord-bot](https://github.com/StarCitizenWiki/discord-bot) | — | structure + data | Slash-command bot backed by the SC-Wiki API. Good command/structure reference + enrichment. |
| [bgadrian/sc-janus](https://github.com/bgadrian/sc-janus) | — | pattern | Org admin/utility bot. |
| [Mirdalan/discord_astro_bot](https://github.com/Mirdalan/discord_astro_bot) | Python | idea | Members add/remove owned ships — roster/ownership model. |

### C. Localization / friendly names  *(ship + mission display names)*
| Project | Lang | Take | Notes |
|---|---|---|---|
| [BeltaKoda/StarMeld](https://github.com/BeltaKoda/StarMeld) | — | pattern/data | global.ini merge tool — how to combine localization packs. |
| [Osiris-DevWorks/smart-citizen](https://github.com/Osiris-DevWorks/smart-citizen) | — | pattern/data | Localization editor; categories (Ships, Missions, Gear…). |
| [ExoAE/ScCompLangPack](https://github.com/ExoAE/ScCompLangPack) | PowerShell | data | Component naming. |
| [Dymerz/StarCitizen-Localization](https://github.com/Dymerz/StarCitizen-Localization) | TypeScript | pattern | Localization install flow. |

### D. Game data / APIs / extraction  *(codename → friendly-name enrichment)*
| Project | Lang | Take | Notes |
|---|---|---|---|
| [dolkensp/unp4k](https://github.com/dolkensp/unp4k) | C# | **tool** | Extracts `Data.p4k` (global.ini, DataForge). The local, durable way to map mission/ship codenames → names. |
| [Dymerz/StarCitizen-GameData](https://github.com/Dymerz/StarCitizen-GameData) | C# | **tool/data** | Converts game data XML → JSON/SQL — turns DataForge into a usable lookup table. |
| [StarCitizenWiki/API](https://github.com/StarCitizenWiki/API) | PHP | **live API** | Scraped game data + public API (ships, missions). Enrichment source (community-run → fragility caveat). |
| [Dymerz/RSI-Scraper](https://github.com/Dymerz/RSI-Scraper) | Python | idea | Scrape RSI org members/fleet — roster import. |
| [dolkensp/Spectrum.Net](https://github.com/dolkensp/Spectrum.Net) | C# | idea | RSI Spectrum API wrapper — identity/integration idea. |
| UEXcorp API · SCMDB (non-GitHub) | — | live API | Trade/contract catalogs (from earlier research). |

### E. Linux / packaging  *(our cross-platform packaging + Proton path TODO)*
| Project | Lang | Take | Notes |
|---|---|---|---|
| [starcitizen-lug/lug-helper](https://github.com/starcitizen-lug/lug-helper) | Shell | **idea/data** | 692★ Linux installer — **knows the Proton/Wine `Game.log` paths** our Linux relay needs (locate.js TODO). |
| [SpenserCai/LGS-Helper](https://github.com/SpenserCai/LGS-Helper) | Go | idea | Steam Deck/Linux runner; launch + path handling. |

### F. Overlays / dashboards / misc  *(UI/UX ideas)*
| Project | Lang | Take | Notes |
|---|---|---|---|
| [ArkanisCorporation/ArkanisOverlay](https://github.com/ArkanisCorporation/ArkanisOverlay) | C# | idea | Companion overlay — UX reference. |
| [dolkensp/HangarXPLOR](https://github.com/dolkensp/HangarXPLOR) | JS | idea | Browser-extension pattern. |
| [dydrmr/VerseTime](https://github.com/dydrmr/VerseTime) | JS | minor | In-verse time. |

## Priority picks for *our* roadmap
1. **all-slain — DONE & reopened kill detection.** Kills DO log for the running player (Actor Death/CActor::Kill, 4.0.2+); our parser already matches. Next: capture a real member combat session (a member who actually gets/takes a kill) to flip the kill/vehicle rules to verified.
2. **lug-helper** — Proton/Wine log paths for the Linux relay (M-packaging, `app/locate.js`).
3. **unp4k + StarCitizen-GameData** — extract DataForge/global.ini locally to turn mission/ship codenames into friendly names (the enrichment we deferred).
4. **StarCitizenWiki/discord-bot + IRCON-Bot** — reference shapes for the M5.3 Discord bot.

## Stalled-but-promising (revive / repurpose for a future project)
Idle ≥ ~12 months or archived (last-push checked 2026-06-14). Permissive licence =
forkable; GPL = ideas/approach only (copyleft); none = ideas only. Archived/old means
*verify against the current game/site/API before investing*.

| Project | Idle | Lic | Could seed… |
|---|---|---|---|
| [dolkensp/Spectrum.Net](https://github.com/dolkensp/Spectrum.Net) | ~9 yr | MIT | **RSI Spectrum (forums/chat) integration** — identity/community. Rare capability; API drifted → reference + rewrite. |
| [StarCitizenWiki/discord-bot](https://github.com/StarCitizenWiki/discord-bot) | archived ~15 mo | MIT | **Fork-base for an SC info/ops Discord bot** (slash commands + data lookup). |
| [Dymerz/StarCitizen-GameData](https://github.com/Dymerz/StarCitizen-GameData) | ~4 yr | GPL-3.0 | **DataForge → JSON/SQL lookup** (mission/ship/item names). Pair with the active unp4k. Approach only. |
| [Dymerz/RSI-Scraper](https://github.com/Dymerz/RSI-Scraper) | ~3 yr | GPL-3.0 | **Org roster / fleet import** (members, ships). Scrapers rot — ideas only. |
| [Valalol/Star-Citizen-Navigation](https://github.com/Valalol/Star-Citizen-Navigation) | ~2 yr | MIT | **Navigation/logistics companion** (routes, locations). 69★ base; forkable. |
| [SpenserCai/LGS-Helper](https://github.com/SpenserCai/LGS-Helper) | ~16 mo | GPL-3.0 | **Linux/Steam-Deck launcher** (Proton paths). 419★ + idle = may want a maintainer. |
| [Mirdalan/discord_astro_bot](https://github.com/Mirdalan/discord_astro_bot) | ~5 yr | MIT | Clean **ship-ownership roster bot** seed. |
| [bgadrian/sc-janus](https://github.com/bgadrian/sc-janus) | ~9 yr | none | Historical org bot — ideas only (no licence). |

## How to consider a project for reuse (the rubric)
Score each on:
- **Licence** — MIT/Apache/BSD → reuse code (keep notice); GPL/AGPL → ideas only; none → ideas only.
- **Maintenance** — recent commits → lower "could go away" risk; archived/stale → ideas only.
- **Language fit** — JS/Node → adapt directly; Python/C#/Go/PHP → port the *idea*, not the code.
- **Value type** — (a) **Code** to adapt, (b) **Pattern/idea** to reimplement, (c) **Data/format** (their regexes, codename maps), (d) **Live API** to call (carries an external-dependency/"could go away" risk), (e) **Tooling** to run offline (e.g. unp4k).
- **Goal fit** — which of our milestones it serves.
- **Integration risk** — dependency weight, external-service fragility, and whether it pulls us back toward heavy frameworks (the reason D-002 dropped Fabric).

Decision shortcut: prefer **local + durable** (read the player's own files, run a tool offline) over **remote + fragile** (a community API that can disappear) — the same principle behind D-003/D-005.
