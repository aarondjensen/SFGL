// Diff the app's season earnings against the Google Sheet's, and say WHERE
// they diverge rather than just that they do.
//
// Usage:
//   node scripts/export-app-earnings.mjs > app-earnings.json
//   node scripts/audit-sheet-vs-app.mjs --app app-earnings.json
//   node scripts/audit-sheet-vs-app.mjs --app app.json --sheet other-sheet.json
//
// Defaults --sheet to scripts/fixtures/sheet-earnings-2026.json.
// READ-ONLY, and needs no credentials — it reads two JSON files.
//
// WHY THIS EXISTS
// ---------------
// The sheet and the app compute the same season from different sources (ESPN
// official money vs pgatour.com) through different code. A season-total
// mismatch therefore says nothing on its own about where the divergence
// entered, and eyeballing 31 tournaments x 5 teams x 5 players is how you miss
// the one that matters.
//
// So it narrows: season → tournament → team → player, and stops descending a
// branch once it agrees. Player names are compared with the app's own
// equivalence matcher, never with ===, because ESPN says "Nicolas Echavarria"
// where a roster says "Nico Echavarria" and a string compare would report a
// phantom discrepancy.
//
// KNOWN CAUSES it labels rather than leaving as a bare number:
//   CUT-RULE   the sheet forfeits a team's earnings for an event when fewer
//              than two starters make the cut; nothing in the app applies that
//              rule (processTournamentData.js sums all five unconditionally).
//   BONUS      totals agree on raw earnings but disagree on round-leader money.
//   LINEUP     the two disagree about WHO was started, not about what they won.
//   MISSING    the tournament or team block exists on one side only.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { namesMatch } from '../api/_playerNames.js';

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const appPath   = arg('--app', null);
// fileURLToPath, not .pathname: on Windows a file: URL's pathname is
// "/C:/dev/sfgl/..." — the leading slash makes readFileSync resolve it to
// "C:\C:\dev\sfgl\..." and fail with ENOENT.
const sheetPath = arg('--sheet',
  fileURLToPath(new URL('./fixtures/sheet-earnings-2026.json', import.meta.url)));

if (!appPath) {
  console.error('Usage: node scripts/audit-sheet-vs-app.mjs --app app-earnings.json [--sheet sheet.json]');
  console.error('Produce the app side with: node scripts/export-app-earnings.mjs > app-earnings.json');
  process.exit(2);
}

// Read as bytes and sniff the encoding rather than assuming utf8.
//
// `node export.mjs > app-earnings.json` in PowerShell writes UTF-16LE with a
// BOM, which fails as `Unexpected token '<27>', "<FF><FE>{"ge"...` — a message that
// points at the JSON rather than at the redirect that mangled it. Accepting
// both encodings here means a file produced by any shell just works; use
// --out on the export side to avoid the problem at source.
const load = (p) => {
  let buf;
  try { buf = readFileSync(p); } catch (e) {
    console.error(`Could not read ${p}: ${e.message}`); process.exit(2);
  }
  let text;
  if (buf[0] === 0xFF && buf[1] === 0xFE)      text = buf.toString('utf16le').slice(1);
  else if (buf[0] === 0xFE && buf[1] === 0xFF) {
    console.error(`${p} is UTF-16BE, which this cannot decode. Re-export with --out.`);
    process.exit(2);
  }
  else if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) text = buf.toString('utf8').slice(1);
  else text = buf.toString('utf8');

  try { return JSON.parse(text); } catch (e) {
    console.error(`Could not parse ${p}: ${e.message}`); process.exit(2);
  }
};

const app = load(appPath);
const sheet = load(sheetPath);
const $ = (n) => (n === null || n === undefined ? '—' : `$${Math.round(n).toLocaleString()}`);
const d$ = (n) => `${n >= 0 ? '+' : '-'}$${Math.abs(Math.round(n)).toLocaleString()}`;

let findings = 0;
const note = (...a) => { findings++; console.log(...a); };

// ── Pairing tournaments across the two sources ───────────────────────────────
//
// The sheet knows a tournament by its TAB NAME ("Farmers", "API", "RBC"); the
// app stores the full PGA Tour title ("Farmers Insurance Open", "Arnold Palmer
// Invitational presented by Mastercard", "RBC Heritage"). Comparing those with
// === reports every tournament as missing from both sides, which is the same
// mistake this file already refuses to make for player names.
//
// Match on token containment, then assign one-to-one, best score first. The
// ordering is what disambiguates the genuinely overlapping cases:
//
//   "Canadian Open" ⊂ "RBC Canadian Open"   (2 tokens)  assigned first
//   "RBC"           ⊂ "RBC Canadian Open"   (1 token)   … so RBC gets Heritage
//   "Scottish Open" ⊂ "Genesis Scottish Open"           … so Genesis gets
//   "Genesis"       ⊂ "Genesis Scottish Open"               The Genesis Invitational
//
// A sheet name left with no free candidate is reported as unmatched rather than
// silently paired, for the same reason buildNameIndex drops colliding keys: a
// wrong pairing invents a discrepancy AND hides a real one.
const TOURNAMENT_ALIASES = {
  // Abbreviations no token rule can derive.
  'amex': 'the american express',
  'api': 'arnold palmer invitational presented by mastercard',
};

const normTourney = (s) => String(s || '')
  .toLowerCase()
  .replace(/\bpresented by\b.*$/, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const tokens = (s) => new Set(normTourney(s).split(' ').filter(Boolean));

function pairTournaments(sheetNames, appNames) {
  const pairs = new Map();     // sheet name → app name
  const taken = new Set();
  const scored = [];

  for (const sn of sheetNames) {
    const alias = TOURNAMENT_ALIASES[normTourney(sn)];
    const st = tokens(sn);
    for (const an of appNames) {
      const at = tokens(an);
      let score = 0;
      if (alias && normTourney(an).startsWith(normTourney(alias))) score = 99;
      else if (st.size && [...st].every(t => at.has(t))) score = st.size;
      else if (at.size && [...at].every(t => st.has(t))) score = at.size;
      if (score) scored.push({ sn, an, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  for (const { sn, an } of scored) {
    if (pairs.has(sn) || taken.has(an)) continue;
    pairs.set(sn, an);
    taken.add(an);
  }
  return { pairs, unmatchedSheet: sheetNames.filter(n => !pairs.has(n)),
           unmatchedApp: appNames.filter(n => !taken.has(n)) };
}

const { pairs: TPAIR, unmatchedSheet, unmatchedApp } = pairTournaments(
  Object.keys(sheet.tournaments || {}), Object.keys(app.tournaments || {}));

// ── Level 1: season ──────────────────────────────────────────────────────────
console.log('\n═══ SEASON TOTALS ═══\n');
const teams = [...new Set([...Object.keys(sheet.seasonTotals || {}), ...Object.keys(app.seasonTotals || {})])].sort();
const divergentTeams = new Set();

console.log(`  ${'Team'.padEnd(22)}${'Sheet'.padStart(15)}${'App'.padStart(15)}${'Δ'.padStart(15)}`);
for (const t of teams) {
  const s = sheet.seasonTotals?.[t];
  const a = app.seasonTotals?.[t];
  const delta = (a ?? 0) - (s ?? 0);
  if (Math.abs(delta) >= 1) divergentTeams.add(t);
  const mark = Math.abs(delta) < 1 ? '' : '   <-- differs';
  console.log(`  ${t.padEnd(22)}${$(s).padStart(15)}${$(a).padStart(15)}${(delta ? d$(delta) : '—').padStart(15)}${mark}`);
}
if (!divergentTeams.size) {
  console.log('\n  Season totals agree for every team.\n');
  process.exit(0);
}

// ── Level 2 + 3: tournament, then team ───────────────────────────────────────
console.log('\n═══ WHERE THE SEASON GAP COMES FROM ═══');
if (unmatchedSheet.length || unmatchedApp.length) {
  console.log('\n  Tournaments that could not be paired across the two sources:');
  unmatchedSheet.forEach(n => console.log(`    sheet only: ${n}`));
  unmatchedApp.forEach(n => console.log(`    app only:   ${n}`));
  console.log('    (add an entry to TOURNAMENT_ALIASES if these are the same event)');
}
const allTourneys = Object.keys(sheet.tournaments || {});

for (const team of [...divergentTeams].sort()) {
  console.log(`\n── ${team} ──`);
  let running = 0;

  for (const tn of allTourneys) {
    const sT = sheet.tournaments?.[tn]?.teams?.[team];
    const appName = TPAIR.get(tn);
    const aT = appName ? app.tournaments?.[appName]?.teams?.[team] : undefined;
    if (!sT && !aT) continue;

    if (!sT || !aT) {
      const where = sT ? 'the sheet' : 'the app';
      note(`  MISSING  ${tn.padEnd(20)} team block present only in ${where}  (${$((sT || aT).total)})`);
      running += (aT?.total ?? 0) - (sT?.total ?? 0);
      continue;
    }

    const delta = (aT.total ?? 0) - (sT.total ?? 0);
    if (Math.abs(delta) < 1) continue;
    running += delta;

    // Label the cause instead of printing a bare number.
    let label = 'DIFFERS ';
    let why = '';
    if ((sT.total ?? 0) === 0 && (aT.total ?? 0) > 0 && (sT.earners ?? 0) < 2) {
      label = 'CUT-RULE';
      why = `sheet forfeited the event (${sT.earners} of ${sT.starters} starters made money); the app counted it`;
    } else if (Math.abs((aT.earnings ?? 0) - (sT.earnings ?? 0)) < 1 &&
               Math.abs((aT.bonuses ?? 0) - (sT.bonuses ?? 0)) >= 1) {
      label = 'BONUS   ';
      why = `raw earnings agree; round-leader money differs (sheet ${$(sT.bonuses)} vs app ${$(aT.bonuses)})`;
    }

    note(`  ${label} ${tn.padEnd(20)} sheet ${$(sT.total).padStart(12)}  app ${$(aT.total).padStart(12)}  ${d$(delta)}`);
    if (appName && appName !== tn) console.log(`           app calls this "${appName}"`);
    if (why) console.log(`           ${why}`);

    // ── Level 4: player, only for tournaments that actually disagree ─────────
    const sP = sT.players || [];
    const aP = aT.players || [];
    const usedApp = new Set();
    for (const p of sP) {
      const m = aP.findIndex((q, i) => !usedApp.has(i) && namesMatch(q.player, p.player));
      if (m === -1) {
        console.log(`             LINEUP  "${p.player}" started in the sheet, not in the app  (${$(p.total)})`);
        continue;
      }
      usedApp.add(m);
      const q = aP[m];
      const pd = (q.total ?? 0) - (p.total ?? 0);
      if (Math.abs(pd) >= 1) {
        const namePart = q.player === p.player ? p.player : `${p.player} / ${q.player}`;
        console.log(`             ${namePart.padEnd(34)} sheet ${$(p.total).padStart(11)}  app ${$(q.total).padStart(11)}  ${d$(pd)}`);
      }
    }
    aP.forEach((q, i) => {
      if (!usedApp.has(i)) {
        console.log(`             LINEUP  "${q.player}" started in the app, not in the sheet  (${$(q.total)})`);
      }
    });
  }

  const seasonDelta = (app.seasonTotals?.[team] ?? 0) - (sheet.seasonTotals?.[team] ?? 0);
  const tag = Math.abs(running - seasonDelta) < 1 ? 'fully explained' : 'UNEXPLAINED REMAINDER';
  console.log(`  ${'—'.repeat(60)}`);
  console.log(`  per-tournament deltas ${d$(running)} vs season gap ${d$(seasonDelta)}  → ${tag}`);
  if (Math.abs(running - seasonDelta) >= 1) {
    note(`  ${d$(seasonDelta - running)} of this team's season gap is not attributable to any tournament ` +
         `— check the standings formula rather than the data.`);
  }
}

console.log(`\n${findings} finding(s).\n`);
