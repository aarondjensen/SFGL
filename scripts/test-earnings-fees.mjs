// Differential test for the A3/A4 consolidation: the refactored shared helpers
// must produce EXACTLY what the inline implementations they replaced produced.
// Each legacy function below is copied verbatim from the call site it came from.
import {
  getSeasonEarningsByTeam, getSwingEarningsByTeam,
  getSwingPot, getSwingFeesByTeam, getSeasonFeesByTeam,
  effectiveTransactionFee, getTransactionFee,
} from '../src/utils/sharedHelpers.js';
import { getSegmentForTournament } from '../src/utils/index.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') =>
  cond ? (pass++, console.log('  ok   ' + name))
       : (fail++, console.log('  FAIL ' + name + ' ' + extra));

// ── Legacy implementations, verbatim ──────────────────────────────────────
// From StandingsView.seasonTotals (pre-refactor).
const legacySeasonTotals = (teams, tournaments) => {
  const totals = {};
  teams.forEach(t => { totals[t.id] = 0; });
  tournaments.forEach(t => {
    if (!t.completed || !t.results?.teams) return;
    Object.entries(t.results.teams).forEach(([teamId, result]) => {
      if (totals[teamId] !== undefined) totals[teamId] += (result.totalEarnings || 0);
    });
  });
  return totals;
};
// From StandingsView.swingTotals (pre-refactor).
const legacySwingTotals = (teams, tournaments, selectedSwing) => {
  const totals = {};
  teams.forEach(t => { totals[t.id] = 0; });
  tournaments.forEach(t => {
    if (getSegmentForTournament(t) !== selectedSwing || !t.completed || !t.results?.teams) return;
    Object.entries(t.results.teams).forEach(([teamId, result]) => {
      if (totals[teamId] !== undefined) totals[teamId] += (result.totalEarnings || 0);
    });
  });
  return totals;
};
// From sharedHelpers.getSwingPot (pre-refactor).
const legacySwingPot = (transactions, tournaments, segment, settings) => {
  if (!segment) return 0;
  const swingNames = new Set(); const swingIndexes = new Set();
  (tournaments || []).forEach((t, i) => {
    if (getSegmentForTournament(t) === segment && !t.isAlternate) {
      if (t?.name) swingNames.add(t.name);
      swingIndexes.add(i);
    }
  });
  const inSwing = (tx) => {
    if (tx.tournament) return swingNames.has(tx.tournament);
    if (tx.tournamentIndex !== undefined) return swingIndexes.has(tx.tournamentIndex);
    return tx.segment === segment;
  };
  const effFee = (tx) => {
    const stored = tx.fee || 0;
    return stored > 0 ? stored : getTransactionFee(tx.type, settings, tx.status);
  };
  return (transactions || []).filter(tx => {
    if (tx.status === 'failed') return false;
    if (tx.type === 'swing_winner') return false;
    if (effFee(tx) <= 0) return false;
    return inSwing(tx);
  }).reduce((sum, tx) => sum + effFee(tx), 0);
};
// From TransactionsView.teamFees (pre-refactor).
const legacyTeamFees = (teams, txs, tournaments, currentSwing, settings) => {
  const fees = {};
  teams.forEach(t => { fees[t.name] = { seasonTotal: 0, swingTotal: 0, teamName: t.name }; });
  const names = new Set(); const idxs = new Set();
  (tournaments || []).forEach((t, i) => {
    if (getSegmentForTournament(t) === currentSwing && !t.isAlternate) {
      if (t?.name) names.add(t.name);
      idxs.add(i);
    }
  });
  txs.forEach(tx => {
    if (tx.type === 'swing_winner') return;
    if (tx.status === 'failed') return;
    const fee = (tx.fee || 0) > 0 ? tx.fee : getTransactionFee(tx.type, settings, tx.status);
    if (fees[tx.team] && fee > 0) {
      fees[tx.team].seasonTotal += fee;
      const inSwing = tx.tournament ? names.has(tx.tournament)
        : tx.tournamentIndex !== undefined ? idxs.has(tx.tournamentIndex)
        : tx.segment === currentSwing;
      if (inSwing) fees[tx.team].swingTotal += fee;
    }
  });
  return fees;
};

// ── Deterministic pseudo-random fixture generator ─────────────────────────
let seed = 42;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

const TEAMS = [
  { id: 'drc', name: 'Detroit Rock City' }, { id: 'db', name: 'Dirty Bird(ies)' },
  { id: 'hh', name: 'Hip Happens' }, { id: 'w1', name: 'World #1' }, { id: 'pops', name: 'POPS, LLC' },
];
const SETTINGS = { feeWaiver: 2, feeFA: 1 };

function buildFixture(n) {
  const tournaments = [];
  for (let i = 0; i < 24; i++) {
    const month = (i % 12) + 1;
    const completed = rnd() > 0.4;
    tournaments.push({
      name: `Event ${i}`,
      start_date: `2026-${String(month).padStart(2, '0')}-05`,
      startDate: `2026-${String(month).padStart(2, '0')}-05`,
      isAlternate: rnd() > 0.85,
      completed,
      results: completed && rnd() > 0.15
        ? { teams: Object.fromEntries(TEAMS.filter(() => rnd() > 0.2)
            .map(t => [t.id, { totalEarnings: Math.floor(rnd() * 900000) }])) }
        : undefined,
    });
  }
  const txs = [];
  for (let i = 0; i < n; i++) {
    const ti = Math.floor(rnd() * tournaments.length);
    const useName = rnd() > 0.3;          // new rows carry a name, legacy ones an index
    const hasIdx = rnd() > 0.2;
    txs.push({
      team: pick(TEAMS).name,
      type: pick(['waiver', 'fa', 'free agent', 'drop', 'mulligan', 'swing_winner']),
      status: pick(['processed', 'processed', 'completed', 'failed', 'pending']),
      fee: rnd() > 0.5 ? Math.floor(rnd() * 4) : 0,   // sometimes 0 -> derived
      amount: Math.floor(rnd() * 20),
      tournament: useName ? tournaments[ti].name : undefined,
      tournamentIndex: hasIdx ? ti : undefined,
      segment: pick(['West Coast Swing', 'Spring Swing', 'Summer Swing', 'Fall Finish']),
    });
  }
  return { tournaments, txs };
}

const SEGMENTS = ['West Coast Swing', 'Spring Swing', 'Summer Swing', 'Fall Finish'];
let earningsMismatch = 0, swingEarnMismatch = 0, potMismatch = 0, feeMismatch = 0;

for (let trial = 0; trial < 40; trial++) {
  const { tournaments, txs } = buildFixture(120);

  // A3 — season earnings
  const legacy = legacySeasonTotals(TEAMS, tournaments);
  const shared = getSeasonEarningsByTeam(tournaments);
  for (const t of TEAMS) if ((legacy[t.id] || 0) !== (shared[t.id] || 0)) earningsMismatch++;

  for (const seg of SEGMENTS) {
    // A3 — swing earnings
    const lS = legacySwingTotals(TEAMS, tournaments, seg);
    const sS = getSwingEarningsByTeam(tournaments, seg);
    for (const t of TEAMS) if ((lS[t.id] || 0) !== (sS[t.id] || 0)) swingEarnMismatch++;

    // A4 — swing pot
    if (legacySwingPot(txs, tournaments, seg, SETTINGS) !== getSwingPot(txs, tournaments, seg, SETTINGS)) potMismatch++;

    // A4 — per-team fee panel
    const lF = legacyTeamFees(TEAMS, txs, tournaments, seg, SETTINGS);
    const season = getSeasonFeesByTeam(txs, SETTINGS);
    const swing = getSwingFeesByTeam(txs, tournaments, seg, SETTINGS);
    for (const t of TEAMS) {
      if (lF[t.name].seasonTotal !== (season[t.name] || 0)) feeMismatch++;
      if (lF[t.name].swingTotal !== (swing[t.name] || 0)) feeMismatch++;
    }
  }
}

check('season earnings identical to StandingsView inline version', earningsMismatch === 0, `(${earningsMismatch} mismatches)`);
check('swing earnings identical to StandingsView inline version', swingEarnMismatch === 0, `(${swingEarnMismatch} mismatches)`);
check('swing pot identical to previous getSwingPot', potMismatch === 0, `(${potMismatch} mismatches)`);
check('per-team fees identical to TransactionsView inline version', feeMismatch === 0, `(${feeMismatch} mismatches)`);

// ── The invariant the refactor buys: pot === sum of the cards ─────────────
{
  const { tournaments, txs } = buildFixture(200);
  let ok = true;
  for (const seg of SEGMENTS) {
    const byTeam = getSwingFeesByTeam(txs, tournaments, seg, SETTINGS);
    const sum = Object.values(byTeam).reduce((a, b) => a + b, 0);
    if (sum !== getSwingPot(txs, tournaments, seg, SETTINGS)) ok = false;
  }
  check('pot is exactly the sum of the per-team breakdown', ok);
}

// ── effectiveTransactionFee rules ─────────────────────────────────────────
check('stored fee wins when > 0', effectiveTransactionFee({ type: 'waiver', fee: 5 }, SETTINGS) === 5);
check('derives waiver fee when stored is 0', effectiveTransactionFee({ type: 'waiver', fee: 0 }, SETTINGS) === 2);
check("derives 'free agent' spelling", effectiveTransactionFee({ type: 'free agent', fee: 0 }, SETTINGS) === 1);
check("derives 'fa' spelling", effectiveTransactionFee({ type: 'fa' }, SETTINGS) === 1);
check('failed claims owe nothing', effectiveTransactionFee({ type: 'waiver', status: 'failed' }, SETTINGS) === 0);
check('non-fee types owe nothing', effectiveTransactionFee({ type: 'drop' }, SETTINGS) === 0);
check('honours configured fees', effectiveTransactionFee({ type: 'waiver' }, { feeWaiver: 7 }) === 7);

// ── Alternates excluded from the pot but not from season fees ─────────────
{
  const tournaments = [
    { name: 'Reg', startDate: '2026-02-05', isAlternate: false },
    { name: 'Alt', startDate: '2026-02-12', isAlternate: true },
  ];
  const txs = [
    { team: 'A', type: 'waiver', status: 'processed', fee: 2, tournament: 'Reg' },
    { team: 'A', type: 'waiver', status: 'processed', fee: 2, tournament: 'Alt' },
  ];
  check('alternate-event fees excluded from swing pot',
    getSwingPot(txs, tournaments, 'West Coast Swing', SETTINGS) === 2);
  check('alternate-event fees still counted in season total',
    getSeasonFeesByTeam(txs, SETTINGS)['A'] === 4);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
