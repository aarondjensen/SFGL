// Differential test for A10: api/cron.js's four hand-copied "…Server" helpers
// (plus its inline roster replay, bonus tables and season-earnings sums) are
// gone, replaced by api/_rules.js. Each legacy implementation below is a
// verbatim copy of what cron.js ran, so the shared version must reproduce it.
import {
  getSegmentForTournament, getTransactionFee, getSwingPot, computeSwingAward,
  buildEffectiveRoster, getSeasonEarningsByTeam, bonusesFor,
  BONUSES_REGULAR, BONUSES_MAJOR,
} from '../api/_rules.js';
import { SWINGS } from '../api/_league.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') =>
  cond ? (pass++, console.log('  ok   ' + name))
       : (fail++, console.log('  FAIL ' + name + ' ' + extra));

// ── Legacy cron implementations, verbatim ─────────────────────────────────
const MONTH_TO_SEGMENT = {
  jan: 'West Coast Swing', feb: 'West Coast Swing', mar: 'West Coast Swing',
  apr: 'Spring Swing',     may: 'Spring Swing',     jun: 'Spring Swing',
  jul: 'Summer Swing',     aug: 'Summer Swing',     sep: 'Summer Swing',
  oct: 'Fall Finish',      nov: 'Fall Finish',      dec: 'Fall Finish',
};
const legacySegmentServer = (t) => {
  if (t?.segment) return t.segment;
  if (t?.swing)   return t.swing;
  const iso = t?.start_date || t?.startDate;
  if (typeof iso === 'string' && /^\d{4}-\d{2}/.test(iso)) {
    const monthNum = parseInt(iso.slice(5, 7), 10);
    const key = Object.keys(MONTH_TO_SEGMENT)[monthNum - 1];
    if (key) return MONTH_TO_SEGMENT[key];
  }
  const d = String(t?.dates || '').toLowerCase();
  for (const [abbr, segment] of Object.entries(MONTH_TO_SEGMENT)) {
    if (d.includes(abbr)) return segment;
  }
  return null;
};
const legacyFeeServer = (type, settings, status) => {
  if (status === 'failed') return 0;
  const t = String(type || '').trim().toLowerCase();
  if (t === 'waiver') return settings?.feeWaiver ?? 2;
  if (t === 'fa' || t === 'free agent') return settings?.feeFA ?? 1;
  return 0;
};
const legacyPotServer = (transactions, tournaments, swingSegment, settings) => {
  if (!swingSegment) return 0;
  const swingNames = new Set(); const swingIndexes = new Set();
  (tournaments || []).forEach((t, i) => {
    if (legacySegmentServer(t) === swingSegment && !t.isAlternate) {
      if (t?.name) swingNames.add(t.name);
      swingIndexes.add(i);
    }
  });
  const inSwing = (tx) => {
    if (tx.tournament) return swingNames.has(tx.tournament);
    if (tx.tournamentIndex !== undefined) return swingIndexes.has(tx.tournamentIndex);
    return tx.segment === swingSegment;
  };
  const effFee = (tx) => {
    const stored = tx.fee || 0;
    return stored > 0 ? stored : legacyFeeServer(tx.type, settings, tx.status);
  };
  return (transactions || []).filter(tx => {
    if (tx.status === 'failed') return false;
    if (tx.type === 'swing_winner') return false;
    if (effFee(tx) <= 0) return false;
    return inSwing(tx);
  }).reduce((sum, tx) => sum + effFee(tx), 0);
};
// cron's inline effective-roster replay (returned an ordered array of names)
const legacyEffectiveRoster = (t, allTx, tournaments) => {
  const txPosition = (tx) => {
    const name = tx.tournament ?? tx.tournamentName;
    if (name) {
      const idx = tournaments.findIndex(x => x && x.name === name);
      if (idx !== -1) return idx;
    }
    return tx.tournamentIndex ?? Number.MAX_SAFE_INTEGER;
  };
  const txTimeMs = (tx) => {
    const v = tx?.timestamp;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (v) { const ms = new Date(v).getTime(); if (Number.isFinite(ms)) return ms; }
    if (tx?.date) { const ms = new Date(tx.date).getTime(); if (Number.isFinite(ms)) return ms; }
    return null;
  };
  let names = (t.roster || []).map(p => p.name);
  allTx
    .filter(tx => tx.team === t.name && tx.type !== 'mulligan' && tx.type !== 'swing_winner'
                  && (tx.status === 'processed' || tx.status === 'completed'))
    .map(tx => ({ tx, pos: txPosition(tx), ms: txTimeMs(tx) }))
    .sort((a, b) => {
      if (a.pos !== b.pos) return a.pos - b.pos;
      if (a.ms !== null && b.ms !== null) return a.ms - b.ms;
      if (a.ms === null && b.ms !== null) return -1;
      if (a.ms !== null && b.ms === null) return 1;
      return 0;
    })
    .forEach(({ tx }) => {
      if (tx.droppedPlayer) names = names.filter(n => n !== tx.droppedPlayer);
      if (tx.player && !names.includes(tx.player)) names.push(tx.player);
    });
  return names;
};
const legacySeasonEarnings = (teams, tournaments) => {
  const totals = {};
  teams.forEach(t => { totals[t.id] = 0; });
  tournaments.forEach(tt => {
    if (!tt.completed || !tt.results?.teams) return;
    Object.entries(tt.results.teams).forEach(([tid, r]) => {
      if (totals[tid] !== undefined) totals[tid] += (r.totalEarnings || 0);
    });
  });
  return totals;
};

// ── Fixtures ──────────────────────────────────────────────────────────────
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const TEAMS = [
  { id: 'drc', name: 'Detroit Rock City', roster: [{ name: 'A One' }, { name: 'B Two' }] },
  { id: 'w1',  name: 'World #1',          roster: [{ name: 'C Three' }] },
  { id: 'hh',  name: 'Hip Happens',       roster: [] },
];
const SETTINGS = { feeWaiver: 2, feeFA: 1 };

function fixture(n) {
  const tournaments = [];
  for (let i = 0; i < 20; i++) {
    const month = (i % 12) + 1;
    const completed = rnd() > 0.35;
    tournaments.push({
      name: `Event ${i}`,
      start_date: `2026-${String(month).padStart(2, '0')}-05`,
      isAlternate: rnd() > 0.85,
      completed,
      results: completed && rnd() > 0.2
        ? { teams: Object.fromEntries(TEAMS.filter(() => rnd() > 0.25)
            .map(t => [t.id, { totalEarnings: Math.floor(rnd() * 800000) }])) }
        : undefined,
    });
  }
  const txs = [];
  for (let i = 0; i < n; i++) {
    const ti = Math.floor(rnd() * tournaments.length);
    txs.push({
      team: pick(TEAMS).name,
      type: pick(['waiver', 'fa', 'free agent', 'drop', 'mulligan', 'swing_winner']),
      status: pick(['processed', 'processed', 'completed', 'failed', 'pending']),
      fee: rnd() > 0.5 ? Math.floor(rnd() * 3) : 0,
      player: `P${Math.floor(rnd() * 12)}`,
      droppedPlayer: rnd() > 0.5 ? `P${Math.floor(rnd() * 12)}` : undefined,
      tournament: rnd() > 0.3 ? tournaments[ti].name : undefined,
      tournamentIndex: rnd() > 0.2 ? ti : undefined,
      timestamp: Math.floor(rnd() * 1e6),
      segment: pick(SWINGS),
    });
  }
  return { tournaments, txs };
}

let segBad = 0, feeBad = 0, potBad = 0, rosterBad = 0, earnBad = 0;
for (let trial = 0; trial < 40; trial++) {
  const { tournaments, txs } = fixture(100);

  for (const t of tournaments) {
    if (getSegmentForTournament(t) !== legacySegmentServer(t)) segBad++;
  }
  for (const tx of txs) {
    if (getTransactionFee(tx.type, SETTINGS, tx.status) !== legacyFeeServer(tx.type, SETTINGS, tx.status)) feeBad++;
  }
  for (const seg of SWINGS) {
    if (getSwingPot(txs, tournaments, seg, SETTINGS) !== legacyPotServer(txs, tournaments, seg, SETTINGS)) potBad++;
  }
  for (const team of TEAMS) {
    const shared = [...buildEffectiveRoster(team, txs, { tournaments })].sort();
    const legacy = legacyEffectiveRoster(team, txs, tournaments).slice().sort();
    if (JSON.stringify(shared) !== JSON.stringify(legacy)) rosterBad++;
  }
  const le = legacySeasonEarnings(TEAMS, tournaments);
  const se = getSeasonEarningsByTeam(tournaments);
  for (const t of TEAMS) if ((le[t.id] || 0) !== (se[t.id] || 0)) earnBad++;
}

check('segment resolution matches getSegmentForTournamentServer', segBad === 0, `(${segBad})`);
check('fee resolution matches getTransactionFeeServer', feeBad === 0, `(${feeBad})`);
check('swing pot matches computeSwingPotServer', potBad === 0, `(${potBad})`);
check('effective roster matches the cron inline replay', rosterBad === 0, `(${rosterBad})`);
check('season earnings match the cron inline sums', earnBad === 0, `(${earnBad})`);

// ── Bonus tables ──────────────────────────────────────────────────────────
check('regular bonuses unchanged',
  JSON.stringify(bonusesFor({ isMajor: false }, {})) === JSON.stringify(BONUSES_REGULAR));
check('major bonuses unchanged',
  JSON.stringify(bonusesFor({ isMajor: true }, {})) === JSON.stringify(BONUSES_MAJOR));
check('commish overrides win for majors',
  bonusesFor({ isMajor: true }, { bonusR1Major: 999 }).round1 === 999 &&
  bonusesFor({ isMajor: true }, { bonusR1Major: 999 }).round2 === BONUSES_MAJOR.round2);
check('commish overrides win for regulars',
  bonusesFor({ isMajor: false }, { bonusR3Regular: 5 }).round3 === 5);

// ── Swing award: eligibility gate ─────────────────────────────────────────
{
  const tournaments = [
    { name: 'A', start_date: '2026-02-05', completed: true,  results: { teams: { w1: { totalEarnings: 100 }, drc: { totalEarnings: 50 } } } },
    { name: 'B', start_date: '2026-02-12', completed: true,  results: { teams: { w1: { totalEarnings: 10 },  drc: { totalEarnings: 90 } } } },
  ];
  const txs = [{ team: 'World #1', type: 'waiver', status: 'processed', fee: 2, tournament: 'A' }];
  const award = computeSwingAward({ segment: 'West Coast Swing', allTournaments: tournaments, transactions: txs, teams: TEAMS, settings: SETTINGS });
  check('awards to the swing leader (drc 140 vs w1 110)', award?.winnerTeam?.id === 'drc');
  check('pot equals collected fees', award?.pot === 2);
  check('the tx carries a stable teamId', award?.newTx?.teamId === 'drc');

  const incomplete = [...tournaments, { name: 'C', start_date: '2026-03-05', completed: false }];
  check('no award while a swing event is unfinished',
    computeSwingAward({ segment: 'West Coast Swing', allTournaments: incomplete, transactions: txs, teams: TEAMS, settings: SETTINGS }) === null);

  const alternateOnly = [...tournaments, { name: 'Alt', start_date: '2026-03-05', completed: false, isAlternate: true }];
  check('an unfinished ALTERNATE does not block the award',
    computeSwingAward({ segment: 'West Coast Swing', allTournaments: alternateOnly, transactions: txs, teams: TEAMS, settings: SETTINGS })?.winnerTeam?.id === 'drc');

  const already = [...txs, { team: 'World #1', type: 'swing_winner', segment: 'West Coast Swing', status: 'completed' }];
  check('idempotent once awarded',
    computeSwingAward({ segment: 'West Coast Swing', allTournaments: tournaments, transactions: already, teams: TEAMS, settings: SETTINGS }) === null);

  check('no award when the pot is empty',
    computeSwingAward({ segment: 'West Coast Swing', allTournaments: tournaments, transactions: [], teams: TEAMS, settings: SETTINGS }) === null);

  check('the pot is NOT added to team.earnings',
    award.updatedTeams.every(t => t.earnings === undefined || t.earnings === 0));
}


// ── scoringStarters: the starting lineup scores, not "the best five" ─────────
// Three byte-identical copies of
//   [...starterResults].sort((a,b)=>b.earnings-a.earnings).slice(0,5)
// lived in processTournamentData.js, api/cron.js and mulliganReversal.js. The
// slice silently kept the five highest earners, so an oversized lineup — which
// the mulligan fallback branch can produce by pushing an IN player — was scored
// on its best five instead of being surfaced as the data error it is.
{
  const { scoringStarters, DEFAULT_LINEUP_SIZE } = await import('../api/_rules.js');
  const mk = (...v) => v.map((earnings, i) => ({ playerName: `P${i}`, earnings }));

  const five = scoringStarters(mk(100, 400, 0, 250, 50));
  check('five starters: nothing dropped', five.starters.length === 5);
  check('five starters: not flagged oversized', five.oversized === false);
  check('sorted descending for display',
    five.starters.map(s => s.earnings).join(',') === '400,250,100,50,0');

  // Fewer than five is legal — a manager may start short.
  const three = scoringStarters(mk(100, 0, 50));
  check('short lineup keeps every starter', three.starters.length === 3);
  check('short lineup is not oversized', three.oversized === false);

  // The case the slice used to hide: six names, lowest earner silently dropped.
  const six = scoringStarters(mk(900, 800, 700, 600, 500, 400));
  check('oversized lineup keeps ALL starters', six.starters.length === 6);
  check('oversized lineup is flagged', six.oversized === true);
  check('oversized total counts every starter',
    six.starters.reduce((s, p) => s + p.earnings, 0) === 3900,
    String(six.starters.reduce((s, p) => s + p.earnings, 0)));

  // The commissioner's lineupSize setting is honoured for the oversize check
  // rather than a hardcoded 5.
  check('lineupSize from settings raises the threshold',
    scoringStarters(mk(1, 2, 3, 4, 5, 6), { lineupSize: 6 }).oversized === false);
  check('lineupSize from settings lowers it',
    scoringStarters(mk(1, 2, 3, 4), { lineupSize: 3 }).oversized === true);
  check('bad lineupSize falls back to the default',
    scoringStarters(mk(1, 2, 3, 4, 5, 6), { lineupSize: 0 }).oversized === true &&
    DEFAULT_LINEUP_SIZE === 5);
  check('empty input is safe', scoringStarters(null).starters.length === 0);
}




// ── lineupFor: score the lineup frozen at lock, not the live one ────────────
// Lineup editing re-opens Sunday 9pm ET; results process Monday 9am ET. In that
// window a manager sets NEXT week's five and the finished tournament was being
// scored with them. Confirmed in 2026: three team-events scored on the wrong
// five, worth $1.1M — RBC Heritage (Harris English scored instead of Brian
// Harman), Valspar x2 (Marco Penge for Ben Griffin, Michael Kim for Austin
// Smotherman). Each substitute is a different player from the SAME roster,
// which is what a next-week lineup looks like.
{
  const { lineupFor } = await import('../api/_rules.js');
  const team = { id: 'db', lineup: ['Harris English', 'B', 'C', 'D', 'E'] };  // this week
  const frozen = { lockedLineups: { db: ['Brian Harman', 'B', 'C', 'D', 'E'] } };

  check('prefers the lineup frozen at lock',
    lineupFor(frozen, team)[0] === 'Brian Harman');
  check('falls back to the live lineup when nothing was frozen',
    lineupFor({}, team)[0] === 'Harris English');
  check('falls back when the snapshot has no entry for this team',
    lineupFor({ lockedLineups: { other: ['X'] } }, team)[0] === 'Harris English');
  check('an empty snapshot does not blank the lineup',
    lineupFor({ lockedLineups: { db: [] } }, team).length === 5);
  check('missing tournament is safe', lineupFor(null, team).length === 5);
  check('missing team is safe', lineupFor(frozen, null).length === 0);
  check('a non-array snapshot is ignored',
    lineupFor({ lockedLineups: { db: 'Brian Harman' } }, team)[0] === 'Harris English');
}

// ── scoredLineupFor: what a PAST event was scored with ──────────────────────
// The near-twin of lineupFor, and the reason both exist. Asking lineupFor what
// a finished event scored gets you team.lineup — the manager's CURRENT five —
// whenever no snapshot was frozen. A correction script did exactly that,
// concluded that none of an event's round leaders had been started, and wrote
// an empty bonus list over a correct one. The fallback ORDER is the whole
// point, so every rung is pinned here.
{
  const { scoredLineupFor } = await import('../api/_rules.js');
  const team = { id: 'db', lineup: ['LIVE1', 'LIVE2'] };   // next week's five
  const locked    = { lockedLineups: { db: ['LOCK1', 'LOCK2'] } };
  const processed = { results: { fullLineups: { db: ['FULL1', 'FULL2'] } } };
  const scored    = { results: { teams: { db: { players: [{ name: 'ROW1' }, { name: 'ROW2' }] } } } };

  check('prefers the lock snapshot over everything',
    scoredLineupFor({ ...locked, ...processed }, team).source === 'locked');
  // Both rungs live under `results`, so this has to be a deep merge — a
  // top-level spread would replace one wholesale and test nothing.
  const both = { results: { ...processed.results, ...scored.results } };
  check('then what the processor recorded scoring',
    scoredLineupFor(both, team).lineup[0] === 'FULL1');
  check('then the stored player rows, for results predating fullLineups',
    scoredLineupFor(scored, team).lineup[0] === 'ROW1');
  check('the player-row rung is labelled as such',
    scoredLineupFor(scored, team).source === 'scored');

  // The rung that matters: reachable, but never silently.
  const guess = scoredLineupFor({}, team);
  check('falls back to the live lineup only as a last resort', guess.lineup[0] === 'LIVE1');
  check('...and says so, so a caller can refuse to act on it', guess.source === 'live');

  check('no record anywhere is "none", not a bogus empty lineup',
    scoredLineupFor({}, { id: 'db' }).source === 'none');
  check('missing tournament is safe', scoredLineupFor(null, team).lineup.length === 2);
  check('missing team is safe', scoredLineupFor(locked, null).lineup.length === 0);
  check('an empty snapshot falls through rather than blanking the lineup',
    scoredLineupFor({ lockedLineups: { db: [] }, ...processed }, team).source === 'processed');

  // An oversized stored lineup is a data error — Hip Happens carried six at the
  // 2026 Wyndham — and must be returned whole. Trimming it here would hide the
  // error from the very script written to repair it.
  const six = { lockedLineups: { db: ['A', 'B', 'C', 'D', 'E', 'F'] } };
  check('an oversized lineup is returned intact, not trimmed',
    scoredLineupFor(six, team).lineup.length === 6);

  // Returned arrays must be copies: set-locked-lineups mutates what it gets
  // back, and handing out the stored array would edit the snapshot in place.
  const copy = scoredLineupFor(locked, team).lineup;
  copy[0] = 'MUTATED';
  check('returns a copy, so callers cannot edit the stored record',
    locked.lockedLineups.db[0] === 'LOCK1');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
