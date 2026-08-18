// Guard: the results cron must not score an event that has not been played.
//
// THE BUG. `playing` means "the app's current event", not "the event that just
// finished". Marking a tournament complete advances `playing` to the next one,
// which is normally still days from teeing off — and handleProcessResults
// picked its event with `t.playing && !t.completed` and no date logic at all,
// because the date resolvers lived in src/utils where api/ cannot reach them.
//
// So on the Monday after the FedEx St. Jude — completed by hand, which leaves
// no `last_auto_results` stamp and therefore leaves the day's retry window
// armed — a later ping found the BMW Championship `playing && !completed` and
// scored it three days before round 1. pgatour.com's past-results page for an
// unplayed event serves the PREVIOUS edition, so the scrape came back as a
// full ordinary result and `players.length` could not tell the difference. The
// BMW was marked complete, the Fall Finish pot was auto-awarded, and every
// manager got a "BMW Championship — TOURNAMENT RESULTS" email.
//
// Two gates now stand in the way, and this file guards both: the date gate
// (isTournamentWeekOver, shared with AdminView's dashboard) and the finality
// gate (the `status` block /api/pga-results has always returned and nothing
// ever read).
import { readFileSync } from 'node:fs';
import {
  SEASON, getTournamentStartDate, resolveTournamentStart,
  tournamentWeekEnd, isTournamentWeekOver,
} from '../api/_league.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') =>
  cond ? (pass++, console.log('  ok   ' + name))
       : (fail++, console.log('  FAIL ' + name + ' ' + extra));

// A wall-clock Date in the same frame getETNow() produces.
const et = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0);

console.log('\n── the week-over test itself ──');
{
  // The real shape of the incident: the 2026 BMW starts Thursday Aug 20, and
  // the cron ran on Tuesday Aug 18.
  const bmw = { name: 'BMW Championship', dates: 'Aug 20-23', startDate: new Date(SEASON, 7, 20) };
  check('an event three days out is NOT over',
    isTournamentWeekOver(bmw, et(SEASON, 8, 18, 20)) === false);
  check('an event mid-round-4 (its own Sunday) is NOT over',
    isTournamentWeekOver(bmw, et(SEASON, 8, 23, 18)) === false);
  check('the same event IS over once its Monday begins',
    isTournamentWeekOver(bmw, et(SEASON, 8, 24, 0)) === true);
  check('week end is the Monday after the Thursday',
    tournamentWeekEnd(bmw)?.getDay() === 1 && tournamentWeekEnd(bmw)?.getDate() === 24);

  // The event that HAD finished. Processing it on the Monday must still work —
  // a gate that blocks the legitimate case is not a fix.
  const stJude = { name: 'FedEx St. Jude Championship', dates: 'Aug 13-16' };
  check('the event that just finished processes normally on its Monday',
    isTournamentWeekOver(stJude, et(SEASON, 8, 17, 9)) === true);
  check('…and not on the Saturday of its own week',
    isTournamentWeekOver(stJude, et(SEASON, 8, 15, 9)) === false);
}

console.log('\n── anchoring: Thursday walk, not start + N days ──');
{
  // A Sunday- or Monday-anchored date is exactly what "+5 days" got wrong: the
  // threshold landed mid-event. Walking to the week's Thursday fixes it.
  const mondayAnchored = { name: 'Anchored Monday', start_date: '2026-08-17' };
  check('a Monday-anchored date resolves to that week, not the previous one',
    tournamentWeekEnd(mondayAnchored)?.getDate() === 24);
  check('a Monday-anchored event is not "over" on the Wednesday',
    isTournamentWeekOver(mondayAnchored, et(2026, 8, 19)) === false);

  // Date-only strings must not slip a day west of Greenwich. '2026-08-20' is a
  // Thursday; parsed as UTC midnight it reads as Wednesday the 19th locally,
  // which would put the week end four days early.
  const isoThursday = { name: 'ISO Thursday', start_date: '2026-08-20' };
  check('a date-only start_date is not day-shifted',
    resolveTournamentStart(isoThursday)?.getDay() === 4,
    `got day ${resolveTournamentStart(isoThursday)?.getDay()}`);
  check('…so its week ends the following Monday',
    tournamentWeekEnd(isoThursday)?.getDate() === 24);
}

console.log('\n── "cannot tell" is not "no" ──');
{
  // An event with no date of any kind answers null. The cron must not read
  // that as false (nothing would ever process) nor as true (the whole point of
  // the gate is gone) — it falls through to requiring an explicit "final" from
  // the results source.
  check('an undated event answers null, not false',
    isTournamentWeekOver({ name: 'Mystery Event' }) === null);
  check('tournamentWeekEnd answers null for the same event',
    tournamentWeekEnd({ name: 'Mystery Event' }) === null);
  check('an unparseable dates string answers null',
    isTournamentWeekOver({ name: 'Junk', dates: 'sometime in spring' }) === null);
  check('null tournament is handled',
    isTournamentWeekOver(null) === null);
}

console.log('\n── resolver precedence is unchanged by the move ──');
{
  const t = {
    startDate: new Date(SEASON, 3, 10),   // real date wins
    dates: 'Jan 1-4',
    start_date: '2025-01-06',             // synthetic ordering value loses
  };
  check('a real startDate beats the dates string and the ordering field',
    resolveTournamentStart(t).getMonth() === 3 && resolveTournamentStart(t).getDate() === 10);
  check('the dates string beats the ordering field',
    resolveTournamentStart({ dates: 'Apr 6-12', start_date: '2025-01-06' }).getMonth() === 3);
  check('the ordering field is the last resort, not the first',
    resolveTournamentStart({ start_date: '2026-05-14' }).getMonth() === 4);
  check('the dates string takes the year from SEASON',
    getTournamentStartDate({ dates: 'Apr 6-12' }).getFullYear() === SEASON);
}

console.log('\n── the cron actually applies both gates ──');
{
  // Source guards. The logic above is only worth having if handleProcessResults
  // calls it, and the finality signal spent its whole life being computed,
  // logged, returned and dropped.
  const cron = readFileSync('api/cron.js', 'utf8');
  const proc = cron.slice(cron.indexOf('async function handleProcessResults'));
  const body = proc.slice(0, proc.indexOf('\n// ── Router'));

  check('process-results imports the shared week-over test',
    /isTournamentWeekOver/.test(cron.slice(0, cron.indexOf('async function'))));
  check('it refuses an event whose week is not over',
    /weekOver === false/.test(body) && /'not_finished'/.test(body));
  check('the date gate runs BEFORE the scrape, so a retry ping is free',
    body.indexOf('weekOver === false') < body.indexOf('/api/pga-results'));
  check('it reads the finality block /api/pga-results returns',
    /pgaData\.status/.test(body) && /sawAnyStatus && !finality\.isFinal/.test(body));
  check('an undated event still needs an explicit final',
    /weekOver === null && !finality\?\.isFinal/.test(body));
  // A refusal must NOT stamp last_auto_results. That stamp is the "processed
  // today" flag; setting it here would retire the day's remaining retry pings,
  // so a Monday-finish event would never process at all.
  const dateGate  = body.slice(body.indexOf('const weekOver ='), body.indexOf('// Fetch results from ESPN'));
  const finalGate = body.slice(body.indexOf('const finality ='), body.indexOf('const { players, roundLeaders: rl }'));
  check('the date gate refuses without retiring the day\'s retries',
    dateGate.length > 0 && !/last_auto_results/.test(dateGate));
  check('the finality gate refuses without retiring the day\'s retries',
    finalGate.length > 0 && !/last_auto_results/.test(finalGate));

  // The signal itself must keep being produced.
  const results = readFileSync('api/pga-results.js', 'utf8');
  check('pga-results still returns status alongside players',
    /return res\.status\(200\)\.json\(\{ players, roundLeaders, status/.test(results));
  check('…and still treats only genuinely final states as final',
    /FINAL_VALUES = new Set\(\[[^\]]*'official'/.test(results));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
