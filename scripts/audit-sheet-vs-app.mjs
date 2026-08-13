// Diff the app against the Google Sheet — rosters, lineups, earnings,
// transactions, fees and swings — and say WHERE they diverge rather than just
// that they do.
//
// Usage:
//   node scripts/export-app-state.mjs --out app-state.json
//   node scripts/audit-sheet-vs-app.mjs --app app-state.json
//   node scripts/audit-sheet-vs-app.mjs --app app-state.json --sheet other-sheet.json
//
// Defaults --sheet to scripts/fixtures/sheet-state-2026.json (produced by
// scripts/extract-sheet-2026.py from a downloaded copy of the workbook).
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
//   SHEET $0   the sheet's team Total reads $0 while its own player rows do
//              not. Cause unknown — most likely a broken Total formula.
//   NO DATA    the sheet has no starter rows at all for that event.
//   BONUS      totals agree on raw earnings but disagree on round-leader money.
//   LINEUP     the two disagree about WHO was started, not about what they won.
//   MISSING    the tournament or team block exists on one side only.
//
// SECTIONS AFTER THE MONEY
// ------------------------
// Matching season totals is a weaker result than it appears — two offsetting
// lineup errors net to zero, and a transaction the app never recorded for a
// player who missed the cut moves nothing at all. So the remaining dimensions
// run unconditionally:
//
//   the sheet against itself   its three tallies of the same money (event
//                              tabs, team grid, standings) must agree before
//                              "differs from the sheet" means anything
//   rosters                    sheet Rosters tab vs the app's EFFECTIVE roster
//   lineups                    every populated event, money or no money
//   transactions               matched on (team, event, added player)
//   fees and swings            per swing and per season, plus the pots
//   swing assignment           which swing each event lands in, per side

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
  fileURLToPath(new URL('./fixtures/sheet-state-2026.json', import.meta.url)));

if (!appPath) {
  console.error('Usage: node scripts/audit-sheet-vs-app.mjs --app app-state.json [--sheet sheet.json]');
  console.error('Produce the app side with: node scripts/export-app-state.mjs --out app-state.json');
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
if (!divergentTeams.size) console.log('\n  Season totals agree for every team.');

// ── Level 2 + 3: tournament, then team ───────────────────────────────────────
// Not exited early on agreement any more. Season totals agreeing means the
// MONEY reconciles, which is a weaker claim than it looks: two offsetting
// lineup errors, or a transaction the app never recorded for a player who
// earned nothing, both leave the totals untouched. The dimensions below are
// checked either way.
if (divergentTeams.size) {
  console.log('\n═══ WHERE THE SEASON GAP COMES FROM ═══');
  if (unmatchedSheet.length || unmatchedApp.length) {
    console.log('\n  Tournaments that could not be paired across the two sources:');
    unmatchedSheet.forEach(n => console.log(`    sheet only: ${n}`));
    unmatchedApp.forEach(n => console.log(`    app only:   ${n}`));
    console.log('    (add an entry to TOURNAMENT_ALIASES if these are the same event)');
  }
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
    if ((sT.starters ?? 0) === 0 && (aT.starters ?? 0) > 0) {
      // No starter rows at all on the sheet side is missing data, NOT a
      // forfeit. Calling it CUT-RULE reads as "the sheet applied a rule" when
      // the truth is "the sheet was never filled in" — opposite conclusions
      // about which side to correct.
      label = 'NO DATA ';
      why = 'the sheet has no starters for this event — tab never populated; the app has results';
    } else if ((sT.total ?? 0) === 0 && (aT.total ?? 0) > 0) {
      // The sheet's team Total reads $0 while its own player rows do not.
      //
      // This was labelled CUT-RULE on the theory that the sheet forfeits an
      // event when fewer than two starters make the cut. That rule does not
      // exist: the 2026 sheet mentions "cut" exactly once, about mulligan
      // timing for three-course events. The wording it was inferred from
      // ("must start five guys… only get dollars if…") is from the 2019
      // sheet's historical notes. Every observed case happened to have one
      // earner, which made a coincidence look like a rule.
      //
      // So this is stated as what it is — a total that disagrees with the
      // rows above it — and not explained away.
      label = 'SHEET $0';
      why = `sheet Total reads $0 but its own player rows sum to ${$(sT.earnings)} `
          + `(${sT.earners} of ${sT.starters} starters earned); the app counted it`;
    } else if (Math.abs((aT.earnings ?? 0) - (sT.earnings ?? 0)) < 1 &&
               Math.abs((aT.bonuses ?? 0) - (sT.bonuses ?? 0)) >= 1) {
      label = 'BONUS   ';
      const rl = app.tournaments?.[appName]?.roundLeaders;
      const who = rl ? ['round1', 'round2', 'round3']
        .map(r => `${r.slice(-1)}: ${[].concat(rl[r] || []).filter(Boolean).join(', ') || '—'}`)
        .join('  |  ') : 'not recorded';
      why = `raw earnings agree; round-leader money differs (sheet ${$(sT.bonuses)} vs app ${$(aT.bonuses)})\n`
          + `           app's round leaders — ${who}`;
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

// ── The sheet against itself ─────────────────────────────────────────────────
// Run FIRST among the non-earnings checks, because it decides what a
// sheet-vs-app delta means. The workbook keeps three independent tallies of the
// same money — the per-event tabs, the per-team player grid, and the Rosters
// standings — and when they disagree, "the app differs from the sheet" has no
// single referent. Naming which of the three is the outlier turns an unfixable
// finding into a cell reference.
if (sheet.teamTabs && sheet.standings) {
  console.log('\n═══ THE SHEET AGAINST ITSELF ═══\n');
  const standBy = Object.fromEntries((sheet.standings || []).map(s => [s.team, s.total]));
  const sheetTeams = Object.keys(sheet.teamTabs);

  console.log(`  ${'Team'.padEnd(22)}${'event tabs'.padStart(15)}${'team tabs'.padStart(15)}${'standings'.padStart(15)}`);
  for (const t of sheetTeams) {
    const ev = sheet.seasonTotals?.[t] ?? 0;
    const tt = Object.values(sheet.teamTabs[t]?.byEvent || {}).reduce((s, v) => s + (v || 0), 0);
    const st = standBy[t] ?? 0;
    const agree = Math.abs(ev - tt) < 1 && Math.abs(ev - st) < 1;
    console.log(`  ${t.padEnd(22)}${$(ev).padStart(15)}${$(tt).padStart(15)}${$(st).padStart(15)}` +
      (agree ? '' : '   <-- disagree'));
  }

  // A Total cell reading $0 over rows that sum to more is a broken formula, and
  // the standings inherit it — so this understates a real team by real money
  // and nothing on the sheet says so.
  console.log('\n  Event blocks whose Total cell disagrees with its own player rows:');
  let brokenTotals = 0;
  for (const [tn, blk] of Object.entries(sheet.tournaments || {})) {
    for (const [team, b] of Object.entries(blk.teams || {})) {
      const rowSum = (b.players || []).reduce((s, p) => s + (p.total || 0), 0);
      if (Math.abs(rowSum - (b.total || 0)) < 1) continue;
      brokenTotals++;
      note(`    ${tn.padEnd(18)}${team.padEnd(20)} rows ${$(rowSum).padStart(12)}  Total ${$(b.total).padStart(12)}`);
    }
  }
  if (!brokenTotals) console.log('    none.');

  console.log('\n  Events where the team grid and the event tab disagree:');
  let gridGaps = 0;
  for (const [tn, blk] of Object.entries(sheet.tournaments || {})) {
    for (const [team, b] of Object.entries(blk.teams || {})) {
      const tt = sheet.teamTabs[team]?.byEvent?.[tn];
      if (tt === undefined || tt === null) continue;
      if (Math.abs((b.total || 0) - tt) < 1) continue;
      gridGaps++;
      note(`    ${tn.padEnd(18)}${team.padEnd(20)} event ${$(b.total).padStart(12)}  grid ${$(tt).padStart(12)}`);
    }
  }
  if (!gridGaps) console.log('    none.');
}

// ── Rosters ──────────────────────────────────────────────────────────────────
// Against the app's EFFECTIVE roster — the drafted one with every processed
// add/drop replayed — because that is what the sheet's Rosters tab is. Diffing
// the drafted roster would report every completed transaction as a finding.
if (sheet.rosters && app.rosters) {
  console.log('\n═══ ROSTERS ═══');
  for (const team of Object.keys(sheet.rosters)) {
    const sNames = (sheet.rosters[team] || []).map(p => p.player);
    const aNames = app.rosters[team]?.effective || [];
    if (!app.rosters[team]) { note(`\n  ${team}: no roster in the app export`); continue; }

    const usedApp = new Set();
    const sheetOnly = [];
    for (const n of sNames) {
      const i = aNames.findIndex((m, j) => !usedApp.has(j) && namesMatch(m, n));
      if (i === -1) sheetOnly.push(n); else usedApp.add(i);
    }
    const appOnly = aNames.filter((_, j) => !usedApp.has(j));

    if (!sheetOnly.length && !appOnly.length) {
      console.log(`\n  ${team}: ${sNames.length} players, identical.`);
      continue;
    }
    console.log(`\n  ${team}:  sheet ${sNames.length}, app ${aNames.length}`);
    sheetOnly.forEach(n => note(`    on the sheet, not the app:  ${n}`));
    appOnly.forEach(n => note(`    in the app, not the sheet:  ${n}`));
  }
}

// ── Lineups ──────────────────────────────────────────────────────────────────
// Every event, not just the ones whose money differs. A starter swapped for one
// who earned the same — or for one who earned nothing while the man he replaced
// also earned nothing — moves no money and is still the wrong lineup, and the
// earnings walk above cannot see it.
if (app.tournaments) {
  console.log('\n═══ LINEUPS ═══\n');
  let lineupGaps = 0;
  for (const tn of allTourneys) {
    const appName = TPAIR.get(tn);
    if (!appName) continue;
    for (const [team, sT] of Object.entries(sheet.tournaments[tn]?.teams || {})) {
      const aT = app.tournaments[appName]?.teams?.[team];
      if (!aT) continue;

      // The sheet's own two records first: column H (submitted) against the
      // scored rows beside it. Where those disagree the sheet is arguing with
      // itself and the app cannot be judged against either.
      const sScored = (sT.players || []).map(p => p.player);
      const sSubmitted = sT.submitted || [];
      if (sSubmitted.length && sSubmitted.length !== sScored.length) {
        note(`  ${tn.padEnd(18)}${team.padEnd(20)} sheet submits ${sSubmitted.length}, scores ${sScored.length}`);
      }

      const aScored = (aT.players || []).map(p => p.player);
      const usedApp = new Set();
      const onlySheet = [];
      for (const n of sScored) {
        const i = aScored.findIndex((m, j) => !usedApp.has(j) && namesMatch(m, n));
        if (i === -1) onlySheet.push(n); else usedApp.add(i);
      }
      const onlyApp = aScored.filter((_, j) => !usedApp.has(j));
      if (!onlySheet.length && !onlyApp.length) continue;

      // An empty sheet block is missing data, not a lineup disagreement — the
      // event tab was never filled in. Saying "the app started five players the
      // sheet did not" about a blank tab buries the real findings.
      if (!sScored.length) continue;

      lineupGaps++;
      note(`  ${tn.padEnd(18)}${team.padEnd(20)} lineups differ`);
      onlySheet.forEach(n => console.log(`      sheet only: ${n}`));
      onlyApp.forEach(n => console.log(`      app only:   ${n}`));

      // lockedLineup is what the app FROZE at lock; scoredAgainst is what it
      // actually scored. A gap between those two means the stored result is
      // stale and a reprocess would change it — a different fix from a
      // genuine disagreement about who was started.
      if (aT.lockedLineup && aT.scoredAgainst &&
          aT.lockedLineup.join('|') !== aT.scoredAgainst.join('|')) {
        console.log(`      app scored against a lineup that is not the one it locked`);
        console.log(`        locked: ${aT.lockedLineup.join(', ')}`);
        console.log(`        scored: ${aT.scoredAgainst.join(', ')}`);
      }
    }
  }
  if (!lineupGaps) console.log('  Every populated event agrees on who was started.');
}

// ── Transactions ─────────────────────────────────────────────────────────────
// Matched on (team, event, added player). Not on the drop: a manager who adds
// one player and drops another in the same week can have the two recorded in
// either order, and pairing on the drop would report both halves as missing.
if (sheet.transactions && app.transactions) {
  console.log('\n═══ TRANSACTIONS ═══\n');

  // swing_winner rows are payouts, not moves — the sheet has no column for
  // them and reporting all four as missing every run trains the eye to skip
  // this section.
  const appTx = app.transactions.filter(tx => tx.type !== 'swing_winner' && tx.status !== 'failed');
  console.log(`  sheet ${sheet.transactions.length} rows, app ${appTx.length} (excluding swing payouts and failed claims)\n`);

  const used = new Set();
  const unmatchedSheetTx = [];
  for (const s of sheet.transactions) {
    const appEvent = TPAIR.get(s.event);
    const i = appTx.findIndex((a, j) =>
      !used.has(j) &&
      a.team === s.team &&
      (!appEvent || !a.tournament || a.tournament === appEvent) &&
      s.added && a.player && namesMatch(a.player, s.added));
    if (i === -1) unmatchedSheetTx.push(s); else used.add(i);
  }
  const unmatchedAppTx = appTx.filter((_, j) => !used.has(j));

  unmatchedSheetTx.forEach(s => note(
    `  sheet only:  ${s.team.padEnd(20)} ${String(s.event).padEnd(18)} +${s.added || '—'} / -${s.dropped || '—'}  fee $${s.fee ?? '—'}`));
  unmatchedAppTx.forEach(a => note(
    `  app only:    ${String(a.team).padEnd(20)} ${String(a.tournament || a.segment || '—').padEnd(18)} +${a.player || '—'} / -${a.droppedPlayer || '—'}  fee $${a.fee ?? '—'}  [${a.type}/${a.status}]`));
  if (!unmatchedSheetTx.length && !unmatchedAppTx.length) {
    console.log('  Every transaction is present on both sides.');
  }
}

// ── Fees and swings ──────────────────────────────────────────────────────────
if (sheet.swings && app.fees?.bySwing) {
  console.log('\n═══ SWING EARNINGS AND FEES ═══');
  for (const swing of Object.keys(app.fees.bySwing)) {
    console.log(`\n  ${swing}`);
    console.log(`    ${'Team'.padEnd(22)}${'earn sheet'.padStart(14)}${'earn app'.padStart(14)}` +
                `${'fee sheet'.padStart(11)}${'fee app'.padStart(10)}`);
    for (const team of Object.keys(sheet.swings)) {
      const s = sheet.swings[team]?.bySwing?.[swing] || {};
      const ae = app.swingEarnings?.[swing]?.[team] ?? 0;
      const af = app.fees.bySwing[swing]?.[team] ?? 0;
      const earnGap = Math.abs((s.earnings ?? 0) - ae) >= 1;
      const feeGap = Math.abs((s.fees ?? 0) - af) >= 0.01;
      if (earnGap || feeGap) findings++;
      console.log(`    ${team.padEnd(22)}${$(s.earnings).padStart(14)}${$(ae).padStart(14)}` +
        `${String(s.fees ?? '—').padStart(11)}${String(af).padStart(10)}` +
        `${earnGap || feeGap ? '   <--' : ''}`);
    }
    const sheetPot = sheet.swingWinners?.[swing];
    const appPot = app.swingPots?.[swing];
    if (sheetPot || appPot !== undefined) {
      console.log(`    pot: sheet $${sheetPot?.pot ?? '—'} (${sheetPot?.team || 'no winner recorded'})` +
        `   app $${appPot ?? '—'}`);
    }
  }

  console.log('\n  Season fees');
  for (const team of Object.keys(sheet.swings)) {
    const s = sheet.swings[team]?.seasonFees;
    const a = app.fees?.season?.[team] ?? 0;
    const gap = Math.abs((s ?? 0) - a) >= 0.01;
    if (gap) findings++;
    console.log(`    ${team.padEnd(22)}sheet $${String(s ?? '—').padStart(9)}   app $${String(a).padStart(9)}${gap ? '   <--' : ''}`);
  }
}

// ── Swing assignment ─────────────────────────────────────────────────────────
// The sheet says which swing an event belongs to in two places that need not
// agree — the Schedule tab's Swing column, and the column group it sits in on
// the Transactions tab — and the app decides for itself from the start date.
// Every fee and swing total above rides on this, so a disagreement here
// explains a fee gap that otherwise looks like a missing transaction.
if (sheet.schedule && app.tournaments) {
  console.log('\n═══ SWING ASSIGNMENT ═══\n');
  let swingGaps = 0;
  const SHEET_SWING = { West: 'West Coast Swing', Spring: 'Spring Swing',
                        Summer: 'Summer Swing', Fall: 'Fall Finish' };
  for (const ev of sheet.schedule) {
    if (!ev.sfgl) continue;
    const appName = TPAIR.get(ev.name);
    const a = appName ? app.tournaments[appName] : null;
    if (!a) continue;
    const sheetSwing = SHEET_SWING[ev.swing] || ev.swing;
    if (a.segmentResolved === sheetSwing) continue;
    swingGaps++;
    note(`  ${ev.name.padEnd(20)} sheet "${sheetSwing}"  app "${a.segmentResolved}"  (app start ${a.startDate || '—'})`);
  }
  if (!swingGaps) console.log('  Every event lands in the same swing on both sides.');
}

console.log(`\n${findings} finding(s).\n`);
