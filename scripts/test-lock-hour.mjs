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
  getTournamentTimezone, getTournamentLockHourET, getTeeTimeLockMs, fmtETTime,
} from '../api/_league.js';
import {
  getTournamentLockHourET as clientLockHour, isTournamentLocked,
} from '../src/utils/index.js';

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

console.log('\n── tee-time lock precedence ──');
{
  const iso = '2026-08-06T11:35:00.000Z';   // 7:35am ET Thursday
  const ms = new Date(iso).getTime();

  check('a known first tee time drives the lock',
    getTeeTimeLockMs({ location: 'Ponte Vedra, FL', firstTeeTimeISO: iso }) === ms);

  // The commissioner's call is a deliberate human decision — a weather delay,
  // a Monday finish — and must outrank whatever the tee sheet says.
  check('an explicit lockHour outranks the tee time',
    getTeeTimeLockMs({ firstTeeTimeISO: iso, lockHour: 10 }) === null);
  check('lockHour 0 also outranks it (not falsy-ignored)',
    getTeeTimeLockMs({ firstTeeTimeISO: iso, lockHour: 0 }) === null);

  // Absence must degrade to exactly the previous behaviour, never to something
  // worse — no tee time is not a reason to change when a lineup locks.
  check('no tee time → null (fall back to the hour rule)',
    getTeeTimeLockMs({ location: 'Pebble Beach, CA' }) === null);
  for (const bad of [null, '', 'not a date', 12345, {}]) {
    check(`unparseable ${JSON.stringify(bad)} → null`,
      getTeeTimeLockMs({ firstTeeTimeISO: bad }) === null);
  }
  // An out-of-range lockHour is not a valid override, so the tee time still wins.
  check('a corrupt lockHour does not suppress the tee time',
    getTeeTimeLockMs({ firstTeeTimeISO: iso, lockHour: 99 }) === ms);
}

console.log('\n── isTournamentLocked honours the tee time ──');
{
  const past   = new Date(Date.now() - 3600_000).toISOString();
  const future = new Date(Date.now() + 3600_000).toISOString();

  check('locked once the first tee has passed',
    isTournamentLocked({ location: 'Ponte Vedra, FL', dates: 'Aug 6-9', firstTeeTimeISO: past }) === true);
  check('open while the first tee is still ahead',
    isTournamentLocked({ location: 'Ponte Vedra, FL', dates: 'Aug 6-9', firstTeeTimeISO: future }) === false);

  // The tee-time branch compares absolute instants; the fallback works in
  // getETNow()'s shifted wall-clock space. A tournament with no start date at
  // all still resolves via the tee time rather than bailing to "not locked".
  check('a tee time works even with no parseable start date',
    isTournamentLocked({ firstTeeTimeISO: past }) === true);
}

console.log('\n── capture rules that keep the lock from moving ──');
{
  // Mirrors captureFirstTeeTime in api/cron.js. /api/field tracks each player's
  // NEXT tee, so mid-tournament its earliest value becomes an afternoon R1 time
  // and then a Friday R2 time. Capturing one would push the lock forward and
  // RE-OPEN a tournament that had already locked.
  const { readFileSync } = await import('node:fs');
  const cron = readFileSync(new URL('../api/cron.js', import.meta.url), 'utf8');
  check('cron has a capture step', cron.includes('captureFirstTeeTime'));
  check('capture refuses a non-future tee time', /ms <= now\) return null/.test(cron));
  check('capture freezes once the stored instant has passed',
    /storedMs <= now\) return null/.test(cron));
  check('field.js serves the absolute instant',
    readFileSync(new URL('../api/field.js', import.meta.url), 'utf8').includes('firstTeeTimeISO'));
}

console.log('\n── locks ONCE before round 1, stays locked all week ──');
{
  // The league rule: rosters lock before the first round and stay locked for
  // the duration. Rounds 2/3/4 tee times are irrelevant to locking, so the
  // lock must be monotonic — never true then false again.
  const firstTee = new Date('2026-08-06T11:35:00.000Z').getTime();   // Thu 7:35am ET
  const t = { location: 'Greensboro, NC', dates: 'Aug 6-9',
              firstTeeTimeISO: new Date(firstTee).toISOString() };

  // Walk the whole tournament week minute-coarse and assert the lock never
  // flips back open once it has fired.
  const realNow = Date.now;
  let everLocked = false, reopened = false;
  try {
    for (let h = -48; h <= 120; h++) {          // Tue before → Monday after
      Date.now = () => firstTee + h * 3600_000;
      const locked = isTournamentLocked(t);
      if (locked) everLocked = true;
      else if (everLocked) reopened = true;
    }
  } finally { Date.now = realNow; }

  check('locks at some point during the week', everLocked);
  check('never re-opens once locked', !reopened);

  // Later rounds must not enter into it at all: the resolver reads only
  // firstTeeTimeISO, so an R2/R3/R4 time on the record changes nothing.
  const withLaterRounds = {
    ...t,
    teeTimes: [{ name: 'X', teeTime: '1:30 PM' }],
    round2TeeTime: '2026-08-07T12:00:00.000Z',
    round4TeeTime: '2026-08-09T15:00:00.000Z',
  };
  check('later-round times do not move the lock',
    getTeeTimeLockMs(withLaterRounds) === getTeeTimeLockMs(t));
}

console.log('\n── the tee-sheet fallback still yields a first tee ──');
{
  // This branch runs precisely because the field page carried no tee times, so
  // it is also the branch where firstTeeTimeISO came back null. If it drops the
  // value, the lineup lock silently reverts to the hour rule for every event
  // whose field page omits the tee sheet.
  const { readFileSync } = await import('node:fs');
  const field = readFileSync(new URL('../api/field.js', import.meta.url), 'utf8');
  check('tee-times page threads firstTeeTimeISO', /firstTeeTimeISO: firstTee2/.test(field));
  check('and it is adopted when the field page had none',
    /if \(!firstTeeTimeISO && firstTee2\) firstTeeTimeISO = firstTee2;/.test(field));
  check('parseFieldPage returns it', /rejectedNames: rejected, firstTeeTimeISO/.test(field));
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
