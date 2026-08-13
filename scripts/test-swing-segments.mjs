// Guard: the swing a tournament belongs to must come from a human, not from a
// calendar-quarter guess.
//
// The bug this exists to prevent: getSegmentForTournament falls back to
// swingForMonth, which maps Jan-Mar / Apr-Jun / Jul-Sep / Oct-Dec. The SFGL
// season runs January to August, so months 10-12 never occur and that fallback
// is STRUCTURALLY INCAPABLE of returning 'Fall Finish'.
//
// The failure is asymmetric, which is what made it expensive: an untagged
// tournament can only ever defect OUT of Fall Finish (into Summer, for anything
// in July or August), never into it. And computeSwingAward gates on "every
// member of the swing completed" — so dropping one event out of Fall Finish can
// leave the remaining members all complete and pay that swing's pot early.
//
// Checked against the real 2026 schedule, the fallback disagreed with the
// commissioner's tagging on 20 of 31 events and left Fall Finish empty.
import {
  seedSegments, segmentSource, getSegmentForTournament,
  makeSwingMembership, getSwingFeesByTeam, getSeasonFeesByTeam,
} from '../api/_rules.js';
import { SWINGS, swingForMonth } from '../api/_league.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') =>
  cond ? (pass++, console.log('  ok   ' + name))
       : (fail++, console.log('  FAIL ' + name + ' ' + extra));

// The real 2026 schedule shape: 31 league events, Jan 15 → Aug 23, plus the
// four non-SFGL events that sit inside those dates as alternates.
const SCHEDULE_2026 = [
  ['Sony Open', '2026-01-15'], ['Amex', '2026-01-22'], ['Farmers', '2026-01-29'],
  ['WM Phoenix Open', '2026-02-05'], ['AT&T Pebble Beach', '2026-02-12'],
  ['Genesis', '2026-02-19'], ['Cognizant', '2026-02-26'], ['API', '2026-03-05'],
  ['The PLAYERS', '2026-03-12'], ['Valspar', '2026-03-19'], ['Houston Open', '2026-03-26'],
  ['Valero', '2026-04-02'], ['Masters', '2026-04-09'], ['RBC', '2026-04-16'],
  ['Cadillac', '2026-04-30'], ['Truist', '2026-05-08'], ['PGA', '2026-05-14'],
  ['Byron Nelson', '2026-05-21'], ['Charles Schwab', '2026-05-28'], ['Memorial', '2026-06-04'],
  ['Canadian Open', '2026-06-11'], ['U.S. Open', '2026-06-18'], ['Travelers', '2026-06-25'],
  ['John Deere', '2026-07-02'], ['Scottish Open', '2026-07-09'], ['The Open', '2026-07-16'],
  ['3M', '2026-07-23'], ['Rocket', '2026-07-30'], ['Wyndham', '2026-08-06'],
  ['FedEx St. Jude', '2026-08-13'], ['BMW', '2026-08-20'],
].map(([name, start_date]) => ({ name, start_date }));

console.log('\n── the month fallback cannot reach Fall Finish ──');
{
  const monthsInSeason = [...new Set(SCHEDULE_2026.map(t => parseInt(t.start_date.slice(5, 7), 10)))];
  const reachable = new Set(monthsInSeason.map(swingForMonth));
  check('season spans Jan–Aug only', Math.max(...monthsInSeason) <= 8);
  check('fallback can never produce Fall Finish', !reachable.has('Fall Finish'),
    `reachable: ${[...reachable].join(', ')}`);
  // If this ever fails it means the season grew into Q4 and the asymmetry above
  // no longer holds — revisit the seeding rationale rather than deleting this.
}

console.log('\n── seedSegments populates all four swings ──');
{
  const seeded = seedSegments(SCHEDULE_2026);
  const counts = {};
  SWINGS.forEach(s => { counts[s] = seeded.filter(t => t.segment === s).length; });

  SWINGS.forEach(s => check(`${s} is non-empty`, counts[s] > 0, `got ${counts[s]}`));
  check('every tournament got a swing', seeded.every(t => t.segment), '');
  check('31 events seed as 8/8/8/7',
    SWINGS.map(s => counts[s]).join('/') === '8/8/8/7',
    SWINGS.map(s => counts[s]).join('/'));

  // Blocks must be contiguous — a swing that interleaves with another would
  // make "the swing is over" meaningless.
  const order = seeded.map(t => SWINGS.indexOf(t.segment));
  check('blocks are contiguous and in order',
    order.every((v, i) => i === 0 || v === order[i - 1] || v === order[i - 1] + 1),
    order.join(','));

  check('input is not mutated', SCHEDULE_2026.every(t => t.segment === undefined));
}

console.log('\n── alternates are never seeded ──');
{
  const withAlts = [
    { name: 'The Open', start_date: '2026-07-16' },
    { name: 'Corales Puntacana', start_date: '2026-07-16', isAlternate: true },
    { name: '3M', start_date: '2026-07-23' },
  ];
  const seeded = seedSegments(withAlts);
  check('alternate keeps no segment', !seeded[1].segment, String(seeded[1].segment));
  check('league events still seeded', !!seeded[0].segment && !!seeded[2].segment);
  // An alternate carrying a segment would join the swing's membership and, being
  // perpetually incomplete, block computeSwingAward for that swing forever.
}

console.log('\n── segmentSource distinguishes tagged from guessed ──');
{
  check('explicit tag', segmentSource({ segment: 'Fall Finish' }) === 'explicit');
  check('legacy swing field', segmentSource({ swing: 'Fall Finish' }) === 'explicit');
  check('month fallback reported as derived',
    segmentSource({ start_date: '2026-08-06' }) === 'derived');
  check('unresolvable reported as none', segmentSource({ name: 'x' }) === 'none');
  // A seeded schedule must read as fully explicit — that is what stops the UI
  // from showing "⚠ not set" on a freshly imported season.
  check('seeded schedule is entirely explicit',
    seedSegments(SCHEDULE_2026).every(t => segmentSource(t) === 'explicit'));
}

console.log('\n── a tagged Fall Finish survives resolution ──');
{
  const seeded = seedSegments(SCHEDULE_2026);
  const fall = seeded.filter(t => t.segment === 'Fall Finish');
  check('Fall Finish resolves back to itself',
    fall.every(t => getSegmentForTournament(t) === 'Fall Finish'));
  check('…and disagrees with the month fallback, as expected',
    fall.some(t => swingForMonth(parseInt(t.start_date.slice(5, 7), 10)) !== 'Fall Finish'));
}

console.log('\n── membership: a renamed tournament must not orphan its fee ──');
{
  // tournamentsApi.setAll uses the tournament NAME as the Firestore doc id, so
  // renaming an event orphans every transaction already tagged with the old
  // name. Such a row used to answer false for EVERY swing: its fee disappeared
  // from all four pots while still counting in the season total, so the two
  // stopped reconciling with nothing on screen to explain the gap.
  const tournaments = seedSegments(SCHEDULE_2026);
  const fallName = tournaments.find(t => t.segment === 'Fall Finish').name;
  const fallIndex = tournaments.findIndex(t => t.segment === 'Fall Finish');

  const orphan = { team: 'DB', type: 'waiver', fee: 2, status: 'completed',
                   tournament: 'Wyndham Championship (renamed)',
                   tournamentIndex: fallIndex, segment: 'Fall Finish' };

  const inFall = makeSwingMembership(tournaments, 'Fall Finish');
  check('orphaned name falls through to the index', inFall(orphan) === true);

  // …but must not then be counted by a second swing as well.
  const otherSwings = SWINGS.filter(s => s !== 'Fall Finish');
  const alsoMatched = otherSwings.filter(s => makeSwingMembership(tournaments, s)(orphan));
  check('orphan belongs to exactly one swing', alsoMatched.length === 0, alsoMatched.join(','));

  // A name that IS known stays authoritative — it must not fall through to a
  // stale index pointing at a different swing.
  const stale = { team: 'DB', type: 'waiver', fee: 2, status: 'completed',
                  tournament: fallName, tournamentIndex: 0 };
  check('known name wins over a stale index', inFall(stale) === true);
  check('stale index does not add a second swing',
    SWINGS.filter(s => makeSwingMembership(tournaments, s)(stale)).length === 1);
}

console.log('\n── season fees reconcile with the sum of the swings ──');
{
  // The invariant that broke in the sheet: every fee-bearing transaction lands
  // in exactly one swing, so Σ swings === season total. Alternates are the one
  // documented exception (they count to the season, not to any swing), so this
  // fixture deliberately contains none.
  const tournaments = seedSegments(SCHEDULE_2026);
  const settings = {};
  const txs = [
    { team: 'DB', type: 'waiver',      fee: 2, status: 'completed', tournamentIndex: 0 },
    { team: 'DB', type: 'free agent',  fee: 1, status: 'completed', tournamentIndex: 12 },
    { team: 'HH', type: 'waiver',      fee: 2, status: 'completed', tournamentIndex: 20 },
    { team: 'HH', type: 'free agent',  fee: 1, status: 'completed', tournamentIndex: 28 },
    { team: 'W1', type: 'waiver',      fee: 2, status: 'failed',    tournamentIndex: 28 },
    { team: 'W1', type: 'waiver',      fee: 2, status: 'completed',
      tournament: 'Vanished Open', tournamentIndex: 30, segment: 'Fall Finish' },
  ];

  const season = getSeasonFeesByTeam(txs, settings);
  const swingTotals = {};
  SWINGS.forEach(s => {
    const byTeam = getSwingFeesByTeam(txs, tournaments, s, settings);
    Object.entries(byTeam).forEach(([team, v]) => { swingTotals[team] = (swingTotals[team] || 0) + v; });
  });

  Object.keys(season).forEach(team => {
    check(`${team}: season $${season[team]} === Σ swings $${swingTotals[team] || 0}`,
      season[team] === (swingTotals[team] || 0));
  });
  check('failed waiver charged nothing', !Object.values(season).includes(4) || season.W1 === 2,
    JSON.stringify(season));
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
