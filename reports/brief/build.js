'use strict';
const fs = require('fs');
const { Resvg } = require('@resvg/resvg-js');
const { figs } = require('./diagrams');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun,
  Footer, AlignmentType, LevelFormat, HeadingLevel, BorderStyle, WidthType,
  ShadingType, PageNumber, PageBreak, ExternalHyperlink
} = require('docx');

// ---- render diagrams to PNG (in memory) ----
const png = {};
const dim = {};
for (const f of figs) {
  png[f.name] = new Resvg(f.svg, { fitTo: { mode: 'width', value: f.w * 2 }, font: { loadSystemFonts: true } }).render().asPng();
  dim[f.name] = { w: f.w, h: f.h };
}

const CW = 9360;                       // content width (US Letter, 1" margins) in DXA
const IMGW = 624;                      // image display width in px (6.5in)
const C = { blue: '1d4a7a', green: '1f5237', amber: '8a5d10', ink: '1a2230', grey: '5b6472', rule: '2f6db0' };

// ---- helpers ----
const H1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(t)] });
const H2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(t)] });
const H3 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun(t)] });
function P (runs, opts) {
  const children = (typeof runs === 'string') ? [new TextRun(runs)] : runs;
  return new Paragraph(Object.assign({ spacing: { after: 120, line: 276 }, children }, opts || {}));
}
const T = (t, o) => new TextRun(Object.assign({ text: t }, o || {}));
const bold = (t) => new TextRun({ text: t, bold: true });
function bullet (runs, level) {
  const children = (typeof runs === 'string') ? [new TextRun(runs)] : runs;
  return new Paragraph({ numbering: { reference: 'b', level: level || 0 }, spacing: { after: 60 }, children });
}
function num (runs) {
  const children = (typeof runs === 'string') ? [new TextRun(runs)] : runs;
  return new Paragraph({ numbering: { reference: 'n', level: 0 }, spacing: { after: 60 }, children });
}
function fig (name, caption) {
  const d = dim[name];
  const h = Math.round(IMGW * d.h / d.w);
  return [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 40 }, children: [
      new ImageRun({ type: 'png', data: png[name], transformation: { width: IMGW, height: h }, altText: { title: caption, description: caption, name } })
    ] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 160 }, children: [new TextRun({ text: caption, italics: true, size: 19, color: C.grey })] })
  ];
}
const border = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
const borders = { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border };
function cell (text, w, opts) {
  opts = opts || {};
  const runs = Array.isArray(text) ? text : [new TextRun({ text: String(text), bold: !!opts.bold, color: opts.color || (opts.head ? 'FFFFFF' : C.ink), size: 19 })];
  return new TableCell({
    width: { size: w, type: WidthType.DXA },
    shading: { fill: opts.head ? C.rule : (opts.fill || 'FFFFFF'), type: ShadingType.CLEAR },
    margins: { top: 60, bottom: 60, left: 110, right: 110 },
    children: [new Paragraph({ children: runs })]
  });
}
function table (headers, rows, widths) {
  const trs = [new TableRow({ tableHeader: true, children: headers.map((h, i) => cell(h, widths[i], { head: true, bold: true })) })];
  for (const r of rows) trs.push(new TableRow({ children: r.map((c, i) => cell(c, widths[i], typeof c === 'object' && !Array.isArray(c) ? c : {})) }));
  return new Table({ width: { size: CW, type: WidthType.DXA }, columnWidths: widths, borders, rows: trs });
}
const rule = () => new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C.rule, space: 1 } }, spacing: { after: 120 } });
const space = (a) => new Paragraph({ spacing: { after: a || 80 }, children: [] });

// ---- document body ----
const body = [];
// Title block
body.push(new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: 'Permafleet Mission Platform', bold: true, size: 48, color: C.blue, font: 'Arial' })] }));
body.push(new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: 'Solution Brief', size: 32, color: C.ink })] }));
body.push(new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: 'A live Star Citizen activity relay + an officer-validated mission register for the org. Prepared 13 June 2026 · Status: working prototype, expanding.', italics: true, size: 20, color: C.grey })] }));
body.push(rule());

// Contents
body.push(H2('Contents'));
['Executive summary', '1. What this is', '2. Where we are now', '3. What users can do', '4. The mission register & lifecycle',
 '5. The Discord Events hook', '6. Making a busy feed useful — filters, grouping, metrics', '7. Future web UI (Discord-role-gated)',
 '8. Packaging & distribution (.exe) and virus-scan trust', '9. Future option — decentralized deployment',
 '10. External dependencies & indicative costs', '11. Roadmap', '12. Decisions for the product owner', '13. Honest limitations'].forEach((s) => body.push(bullet(s)));
body.push(new Paragraph({ children: [new PageBreak()] }));

// Executive summary
body.push(H1('Executive summary'));
body.push(P([T('This project began as a way to turn a single player’s Star Citizen game log into a Discord feed. Through hands-on testing it has grown into something more useful for an organisation: a '), bold('live activity relay'), T(' that each member runs locally, feeding a '), bold('central mission register'), T(' that officers use to post missions and fleet actions, members use to take part, and '), bold('officers validate'), T(' on completion — all backed by a tamper-evident record.')]));
body.push(P([T('The single most important thing we learned: '), bold('the game log cannot prove what happened.'), T(' The current build does not record kills or ship destruction at all, and a player’s own log is self-reported. So the platform is deliberately built around '), bold('human (officer) validation'), T(' as the authority, with the game log providing supporting “evidence” where it exists. This is exactly why it handles '), bold('out-of-game missions and fleet actions'), T(' as naturally as in-game ones.')]));
body.push(P([T('Today the live relay and dashboard work and are tested; the mission register’s engine is built and proven end-to-end; the remaining work is to give it buttons (a web API and a Discord bot) and to host it on a small always-on server. A standout opportunity is to hook into '), bold('Discord Scheduled Events'), T(' — officers already create them and members already click “Interested” — so we can capture interest, attendance and activity with almost no new workflow.')]));
body.push(P([T('Looking further ahead, the architecture keeps the door open to a '), bold('decentralized (federated) deployment'), T(' — where members’ own machines share signed updates so there is no single point of failure — without committing to it now. It is an optional resilience upgrade, not a requirement, and most of the value arrives well before it is needed.')]));

// 1. What this is
body.push(H1('1. What this is'));
body.push(P([T('Think of it as two halves that work together but are kept separate: a '), bold('Live Relay'), T(' on each member’s PC (the only place the game log exists), and a '), bold('Central Service'), T(' in the cloud that holds the shared mission register, the activity feed, and the audit trail. '), bold('Discord is the front door'), T(' everyone already uses.')]));
body.push(...fig('architecture', 'Figure 1 — How the pieces fit together.'));

// 2. Where we are now
body.push(H1('2. Where we are now'));
body.push(P('An honest snapshot of what a user can actually do today versus what is planned:'));
body.push(table(
  ['Capability', 'Status'],
  [
    ['Live dashboard — sessions, players, missions (from the log), combat-objective progress, notifications', { bold: false, fill: 'E7F4EC' }].length ? ['Live dashboard — sessions, players, missions, combat-progress, notifications', 'Built & tested'] : [],
    ['Auto-detect game install & channel (LIVE / PTU / HOTFIX), survive restarts', 'Built & tested'],
    ['Group missions by mission, with objectives nested', 'Built & tested'],
    ['Live activity posted to Discord (one-way webhook)', 'Working once connected'],
    ['Mission register engine — create / apply / assign / claim / officer-validate + audit', 'Built (engine), proven end-to-end'],
    ['Mission register over a web API', 'Next (M5.2)'],
    ['Mission register inside Discord (slash commands + Events hook)', 'Planned (M5.3)'],
    ['Always-on cloud hosting', 'Planned (M4)'],
    ['Detecting individual kills', 'Not possible (game does not log them)'],
    ['Decentralized / no-central-server', 'Optional, later']
  ].filter((r) => r.length),
  [6600, 2760]
));

// 3. What users can do
body.push(H1('3. What users can do'));
body.push(H3('Member'));
['Browse missions and fleet actions (reward, requirements, deadline).', 'Apply from Discord; get assigned when an officer accepts.', 'Mark a mission complete and (optionally) attach evidence the relay captured.', 'See their own participation history.'].forEach((t) => body.push(bullet(t)));
body.push(H3('Officer / administrator'));
['Post missions and fleet actions — including out-of-game ones the game cannot see.', 'Accept or reject applications.', 'Validate completions — the core authority step that approves the reward.', 'Manage who is an officer via a Discord role.', 'See a tamper-evident audit trail of who created, applied to and approved everything.'].forEach((t) => body.push(bullet(t)));

// 4. lifecycle
body.push(H1('4. The mission register & lifecycle'));
body.push(P([T('Every mission moves through a simple, auditable lifecycle. The '), bold('officer validation'), T(' step is the heart of it: because the log cannot prove completion, a human confirms it.')]));
body.push(...fig('lifecycle', 'Figure 2 — Mission lifecycle, from posting to officer-validated completion.'));

// 5. Discord events
body.push(H1('5. The Discord Events hook'));
body.push(P([T('Officers already create '), bold('Discord Scheduled Events'), T(' and members already click “Interested.” We can build on that instead of inventing a new workflow. Discord’s API lets us read the interested list; the relay supplies who actually turned up and what they did during the event window.')]));
body.push(...fig('events', 'Figure 3 — Using Discord Events to capture interest, attendance and activity.'));
body.push(P([bold('Why it’s powerful: '), T('it turns a workflow officers already use into a participation record — interested vs. turned-up vs. did-stuff — with almost no extra effort. The one prerequisite is a one-time link between each member’s relay and their Discord identity so activity can be attributed to the right person.')]));

// 6. filters / grouping / metrics
body.push(H1('6. Making a busy feed useful — filters, grouping, metrics'));
body.push(P('At fleet scale a raw feed becomes noise. Three levers keep it valuable:'));
body.push(H3('Filter by mission type or operation'));
body.push(P('In-game mission types (Bounty, Mercenary/Defense, Hauling, Salvage, Investigation, dynamic events such as XenoThreat) can be inferred from the log and mapped to friendly categories. Org “operations” (e.g. “Tactical Strike Group” — a real announced Star Citizen feature) are officer-named labels that in-game activity rolls up under.'));
body.push(H3('Group, don’t spam'));
['Group by mission (one card per mission, not per line).', 'Roll up to operation level (one card per op).', 'Edit a single message as it progresses, or use one thread per operation — the biggest noise-killer.', 'Optional periodic digest instead of live events.'].forEach((t) => body.push(bullet(t)));
body.push(H3('Metrics — what the log allows'));
body.push(P([bold('The register is the scoreboard (trustworthy); the log is the colour commentary (engagement, clearly labelled “inferred”).'), T(' Suggested measures:')]));
body.push(table(
  ['Metric', 'Source', 'Confidence'],
  [
    ['Operation participation (distinct members active)', 'relays', 'inferred'],
    ['Active-player-minutes per operation', 'relays', 'inferred'],
    ['Objectives advanced / combat-progress per op', 'relays', 'inferred (proxy)'],
    ['Missions completed per week; completion rate', 'register', 'validated'],
    ['Average time-to-complete / time-to-validate', 'register', 'validated'],
    ['Interest → turn-up conversion; no-show rate', 'Discord + relays', 'mixed'],
    ['Member leaderboard (participation, not kills)', 'register', 'validated']
  ],
  [5200, 2080, 2080]
));

// 7. future web UI
body.push(H1('7. Future web UI (Discord-role-gated)'));
body.push(P([T('Discord remains the primary interface, but a '), bold('lightweight web front end on the VPS'), T(' is a natural future addition for officers who want a richer view (a validation queue, metrics dashboards). The key idea: members '), bold('log in with Discord'), T(' (no new passwords) and their '), bold('Discord roles decide what they see'), T(' — officers get the admin views, members get their own. This is a placeholder for planning; not yet built.')]));
body.push(...fig('webui', 'Figure 4 — Placeholder concept: a VPS web front end gated by Discord roles.'));

// 8. packaging
body.push(H1('8. Packaging & distribution (Windows & Linux) and virus-scan trust'));
body.push(P([T('For non-technical members the relay should be a '), bold('single download that just runs'), T(' — no Node.js install, no terminal. We need '), bold('both a Windows and a Linux'), T(' build: many members play on Windows, a growing number play via Proton/Wine on Linux, and the central service itself runs on a Linux server.')]));
body.push(...fig('packaging', 'Figure 5 — From source code to a trusted, cross-platform install (Windows & Linux).'));
body.push(H3('Packaging — three targets'));
body.push(table(
  ['Target', 'What we ship', 'How it runs'],
  [
    ['Windows relay', 'A single .exe (Node.js Single Executable App; alt: pkg/nexe)', 'Double-click; optional auto-start as a background task'],
    ['Linux relay', 'A self-contained binary + install script (tarball; optionally .deb / AppImage)', 'One-line install; optional auto-start as a systemd user service'],
    ['Server (VPS)', 'The central service installed as a Linux systemd service', 'Runs always-on; survives reboots']
  ],
  [1900, 4560, 2900]
));
['First-run setup writes a tiny config (member’s Discord ID, the server address) on either OS.', 'The relay auto-detects the game log: Windows drive paths today; the Linux build adds Proton/Wine prefix detection (e.g. under the Steam/Lutris compat folder).'].forEach((t) => body.push(bullet(t)));
body.push(H3('Virus-scan & trust (important for adoption)'));
body.push(P('Windows: bundled-Node executables from an unknown publisher commonly trigger SmartScreen warnings and occasional antivirus false positives. Linux: no SmartScreen, but we still want verifiable, signed downloads. The trust stack covers both:'));
[
  [bold('Signing'), T(' — Windows: an Authenticode (ideally EV) certificate earns instant SmartScreen reputation — the real fix for “unknown publisher” (~$200–600/yr). Linux: GPG-sign the binaries (and, for a .deb, a GPG-signed apt repo) — free.')],
  [bold('VirusTotal'), T(' — upload each release (free, ~70 engines) and publish the report link so members can verify, on both platforms.')],
  [bold('GitHub Releases + SHA-256 checksums'), T(' — members confirm the file is unmodified; the build is auditable because the source is open.')],
  [bold('False-positive submission'), T(' — if Microsoft Defender (or a Linux AV) flags a release, submit it for review to clear it.')]
].forEach((r) => body.push(bullet(r)));
body.push(P([bold('Honest note: '), T('false positives are normal for this kind of executable; the combination of signing + VirusTotal + checksums + open source is how we establish trust, not a single silver bullet.')]));

// 9. decentralized
body.push(H1('9. Future option — decentralized deployment'));
body.push(P([T('The current plan uses one small cloud server the org runs — simple, cheap and a good fit for a trusted organisation. The architecture also keeps the door open to a '), bold('federated'), T(' version: members’ own machines exchange '), bold('signed'), T(' updates so there is no single point of failure, with the cloud server becoming just one node among several and Discord still the front door.')]));
body.push(...fig('decentralized', 'Figure 6 — Optional future: a federated network with no single point of failure.'));
body.push(P([bold('Recommendation: '), T('treat this as an optional resilience upgrade for later. It is genuinely workable (the cryptographic building blocks already exist in the codebase), but it is a sizeable effort and the org — with trusted leadership — does not need it to get the full value. Revisit only if removing reliance on the single server becomes important, or to federate across multiple orgs.')]));

// 10. dependencies
body.push(H1('10. External dependencies & indicative costs'));
body.push(table(
  ['Dependency', 'What it’s for', 'Cost / effort'],
  [
    ['Small cloud server (VPS)', 'Hosts the always-on register & feed', '~$5–10 / month'],
    ['Discord bot', 'Two-way commands & the Events hook (a webhook can only post out)', 'Free; ~30 min setup'],
    ['Discord server + Officer role', 'Identity and who-can-validate', 'Free; your existing server'],
    ['Each member runs the relay', 'Reads their local game log (Windows or Linux)', 'Free; small download'],
    ['Code-signing certificate', 'Trusted Windows .exe (no SmartScreen); Linux uses free GPG', '~$200–600 / yr (Windows, optional)'],
    ['Domain name', 'Friendly web address (web UI)', '~$10–15 / year (optional)']
  ],
  [2500, 4360, 2500]
));
body.push(P([bold('Deliberately not needed: '), T('no blockchain, no cryptocurrency, no paid database, no app-store apps.')]));

// 11. roadmap
body.push(H1('11. Roadmap'));
[
  [bold('M4 — Stand up the cloud server'), T(' (a home for the register). Needs: hosting choice/budget.')],
  [bold('M5 — Mission register'), T(': API (M5.2) then Discord bot + Events hook (M5.3). Needs: create the Discord bot, define the Officer role.')],
  [bold('M6 — Officer roles + signed audit trail'), T(' (cryptographically signed validations).')],
  [bold('Ongoing — improve what the relay recognises'), T(' (never blocks the register).')],
  [bold('Later / optional — web UI and/or decentralization'), T('.')]
].forEach((r) => body.push(num(r)));

// 12. decisions
body.push(H1('12. Decisions for the product owner'));
['Hosting provider and monthly budget.', 'Approve creating the Discord bot; choose which role = Officer.', 'Live-feed channel: public or private.', 'Confirm rewards are informational only (no real money / no blockchain).', 'Whether to buy a code-signing certificate for the .exe (improves member trust).'].forEach((t) => body.push(num(t)));

// 13. limitations
body.push(H1('13. Honest limitations'));
['Individual kills (PvE or PvP) cannot be detected — the game does not log them.', 'In-game “activity” is only visible for members who run the relay.', 'Activity attribution needs a one-time link between a member’s relay and their Discord ID.', 'Cross-player correlation of a shared mission is by type + operation + time window, unless the game exposes a shared id (to be confirmed against a real capture).', 'A player’s own log is self-reported — which is exactly why officer validation is the authority.'].forEach((t) => body.push(bullet(t)));
body.push(space(120));
body.push(P([new TextRun({ text: 'Prepared by the build team with Claude Code. Source and living technical docs (DESIGN-missions-mvp, DECISIONS, PROGRESS) are in the project repository.', italics: true, size: 18, color: C.grey })]));

// ---- assemble ----
const doc = new Document({
  styles: {
    default: { document: { run: { font: 'Arial', size: 22, color: '202020' } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 30, bold: true, color: C.blue, font: 'Arial' }, paragraph: { spacing: { before: 280, after: 140 }, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 25, bold: true, color: C.ink, font: 'Arial' }, paragraph: { spacing: { before: 180, after: 100 }, outlineLevel: 1 } },
      { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 22, bold: true, color: C.rule, font: 'Arial' }, paragraph: { spacing: { before: 140, after: 60 }, outlineLevel: 2 } }
    ]
  },
  numbering: {
    config: [
      { reference: 'b', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 280 } } } }, { level: 1, format: LevelFormat.BULLET, text: '◦', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1080, hanging: 280 } } } }] },
      { reference: 'n', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 280 } } } }] }
    ]
  },
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Permafleet Mission Platform — Solution Brief    ·    Page ', size: 16, color: '9099A6' }), new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '9099A6' })] })] }) },
    children: body
  }]
});

Packer.toBuffer(doc).then((buf) => {
  const out = 'C:/Users/Kev29/Claude/Projects/Star-citizen-live/Permafleet-Solution-Brief.docx';
  fs.writeFileSync(out, buf);
  console.log('WROTE', out, buf.length, 'bytes');
});
