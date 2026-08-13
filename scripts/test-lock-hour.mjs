// Guard: one lock hour, shared by the client and the cron.
//
// The bug this exists to prevent: getTournamentLockHourET lived in
// src/utils/index.js, which api/cron.js cannot import. The cron did not copy
// the logic — it read `activeTourney.lockHourET`, a field name nothing in the
// app has ever written. So `|| 7` always won and the lineup-lock reminder told
// every manager 7am: two hours early for a California event, five for Hawaii.
//
// The second thing guarded here is that the commissioner's Edit Schedule
// dropdown actually does something. It has always written `lockHour`, and
// nothing ever read it, so setting it was a no-op.
import {
  getTournamentTimezone, getTournamentLockHourET, fmtETTime,
} from '../api/_league.js';
import { getTournamentLockHourET as clientLockHour } from '../src/utils/index.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') =>
  cond ? (pass++, console.log('  ok   ' + name))
       : (fail++, console.log('  FAIL ' + name + ' ' + extra));

console.log('\n── timezone inference from the location string ──');
{
  const cases = [
    ['Honolulu, HI',       'HT', 12],
    ['La Quinta, CA',      'PT',  9],
    ['Pebble Beach, CA',   'PT',  9],
    ['Scottsdale, AZ',     'MT',  8],
    ['Houston, TX',        'CT',  8],
    ['Silvis, IL',         'CT',  8],
    ['Detroit, MI',        'CT',  8],
    ['Ponte Vedra, FL',    'ET',  7],
    [undefined,            'ET',  7],
  ];
  for (const [location, tz, hour] of cases) {
    const t = location === undefined ? {} : { location };
    check(`${String(location)} → ${tz} → ${fmtETTime(hour)} ET`,
      getTournamentTimezone(t) === tz && getTournamentLockHourET(t) === hour,
      `got ${getTournamentTimezone(t)} / ${getTournamentLockHourET(t)}`);
  }
}

console.log('\n── the commissioner override actually applies ──');
{
  // The whole point: this dropdown wrote lockHour and nothing read it.
  check('override beats the timezone default',
    getTournamentLockHourET({ location: 'Honolulu, HI', lockHour: 8 }) === 8);
  check('override applies to an ET event too',
    getTournamentLockHourET({ location: 'Ponte Vedra, FL', lockHour: 11 }) === 11);
  check('hour 0 is a real override, not falsy-ignored',
    getTournamentLockHourET({ location: 'Ponte Vedra, FL', lockHour: 0 }) === 0);

  // Unset must fall through to the derived hour, NOT to a hardcoded 7 —
  // otherwise Auto silently misstates every non-ET event.
  check('null falls back to the timezone default',
    getTournamentLockHourET({ location: 'La Quinta, CA', lockHour: null }) === 9);
  check('undefined falls back to the timezone default',
    getTournamentLockHourET({ location: 'La Quinta, CA' }) === 9);
}

console.log('\n── a corrupt override must not lock lineups at NaN o\'clock ──');
{
  // setHours(NaN) yields an Invalid Date, which compares false against every
  // time — the tournament would never lock at all.
  const bad = [NaN, 24, -1, 7.5, '9', '', {}, []];
  for (const lockHour of bad) {
    const h = getTournamentLockHourET({ location: 'La Quinta, CA', lockHour });
    check(`${JSON.stringify(lockHour)} → falls back to 9`, h === 9, `got ${h}`);
  }
}

console.log('\n── client and cron resolve identically ──');
{
  // src/utils re-exports the shared implementation rather than keeping its own.
  // If someone reintroduces a client-side copy, this catches the drift.
  const fixtures = [
    { location: 'Honolulu, HI' },
    { location: 'Pebble Beach, CA' },
    { location: 'Houston, TX', lockHour: 10 },
    { location: 'Ponte Vedra, FL' },
    {},
  ];
  check('re-export is the same function object',
    clientLockHour === getTournamentLockHourET);
  for (const t of fixtures) {
    check(`${t.location || 'no location'} agrees`,
      clientLockHour(t) === getTournamentLockHourET(t));
  }
}

console.log('\n── the reminder text the cron builds ──');
{
  // api/cron.js formats the hour for the "you haven't set a lineup" email.
  // Before the fix this said 7am for every event on the schedule.
  const sony   = { location: 'Honolulu, HI' };
  const pebble = { location: 'Pebble Beach, CA' };
  check('Sony reads 12:00 PM, not 7am',
    fmtETTime(getTournamentLockHourET(sony)) === '12:00 PM',
    fmtETTime(getTournamentLockHourET(sony)));
  check('Pebble Beach reads 9:00 AM, not 7am',
    fmtETTime(getTournamentLockHourET(pebble)) === '9:00 AM',
    fmtETTime(getTournamentLockHourET(pebble)));
}

console.log('\n── no stale lockHourET references survive ──');
{
  const { readFileSync } = await import('node:fs');
  const cron = readFileSync(new URL('../api/cron.js', import.meta.url), 'utf8');
  // Comments stripped first: the fix is documented in a comment that names the
  // dead field, and matching that would make this assert the opposite of what
  // it means. Only real property access counts.
  const code = cron
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  check('api/cron.js no longer reads lockHourET', !code.includes('lockHourET'));
  check('api/cron.js uses the shared helper', code.includes('getTournamentLockHourET'));
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
