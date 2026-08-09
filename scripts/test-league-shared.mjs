// Covers api/_league.js — the module src/ and api/ now share for season,
// swings, the ET clock and time formatting.
import {
  SEASON, SWINGS, swingForMonth, DAY_NAMES, DAY_ABBRS,
  getETParts, getETNow, getETClock,
  fmtETTime, fmtWaiverCutoff, waiverCutoff, DEFAULT_WAIVER_CUTOFF,
  abbreviateName,
} from '../api/_league.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') =>
  cond ? (pass++, console.log('  ok   ' + name))
       : (fail++, console.log('  FAIL ' + name + ' ' + extra));

// ── Season / swings ───────────────────────────────────────────────────────
check('SEASON is a 4-digit year', Number.isInteger(SEASON) && SEASON > 2000);
check('four swings, chronological', SWINGS.length === 4 && SWINGS[0] === 'West Coast Swing' && SWINGS[3] === 'Fall Finish');

// swingForMonth must reproduce the old hand-written month ranges exactly.
const legacySegmentByMonth = (m) => {
  if (m >= 1 && m <= 3) return 'West Coast Swing';
  if (m >= 4 && m <= 6) return 'Spring Swing';
  if (m >= 7 && m <= 9) return 'Summer Swing';
  return 'Fall Finish';
};
let monthsOk = true;
for (let m = 1; m <= 12; m++) if (swingForMonth(m) !== legacySegmentByMonth(m)) monthsOk = false;
check('all 12 months match the previous mapping', monthsOk);
check('invalid month -> null (was a silent "Fall Finish")',
  swingForMonth(0) === null && swingForMonth(13) === null && swingForMonth(NaN) === null);

// The old cron map was keyed by month abbreviation in calendar order; confirm
// the shared mapping agrees with it, since the cron drives pot + auto-award.
const legacyCronMap = {
  jan: 'West Coast Swing', feb: 'West Coast Swing', mar: 'West Coast Swing',
  apr: 'Spring Swing',     may: 'Spring Swing',     jun: 'Spring Swing',
  jul: 'Summer Swing',     aug: 'Summer Swing',     sep: 'Summer Swing',
  oct: 'Fall Finish',      nov: 'Fall Finish',      dec: 'Fall Finish',
};
check('matches the cron month map it replaced',
  Object.values(legacyCronMap).every((seg, i) => swingForMonth(i + 1) === seg));

// ── Days ──────────────────────────────────────────────────────────────────
check('DAY_NAMES indexed from Sunday (matches Date.getDay)', DAY_NAMES[0] === 'Sunday' && DAY_NAMES[6] === 'Saturday');
check('DAY_ABBRS aligns with DAY_NAMES', DAY_ABBRS.every((a, i) => DAY_NAMES[i].startsWith(a)));

// ── ET clock ──────────────────────────────────────────────────────────────
const p = getETParts();
check('getETParts fields are in range',
  p.month >= 1 && p.month <= 12 && p.day >= 1 && p.day <= 31 &&
  p.hour >= 0 && p.hour <= 23 && p.minute >= 0 && p.minute <= 59);
check('midnight normalises to hour 0, never 24', p.hour !== 24);

const now = getETNow();
check('getETNow returns a valid Date (not Invalid Date)', now instanceof Date && !isNaN(now.getTime()));

// The wall-clock Date must carry the ET fields, not the host timezone's.
check('getETNow fields equal getETParts fields',
  now.getFullYear() === p.year && now.getMonth() + 1 === p.month &&
  now.getDate() === p.day && now.getHours() === p.hour);

// Cross-check against an independent formatting of the same instant.
const ref = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: '2-digit', hour12: false,
}).format(new Date());
check('hour agrees with an independent ET formatting',
  Math.abs(now.getHours() - (parseInt(ref, 10) % 24)) <= 1, `(got ${now.getHours()}, ref ${ref})`);

const clock = getETClock();
check('getETClock weekday matches getETNow weekday', clock.day === now.getDay());
check('totalMinutes is consistent', clock.totalMinutes === clock.hour * 60 + clock.minute);

// The replaced implementation, to confirm we did not change the answer.
const legacyETDate = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
const legacy = legacyETDate();
check('agrees with the toLocaleString variant it replaced',
  !isNaN(legacy.getTime()) && Math.abs(legacy.getTime() - now.getTime()) < 2000,
  `(legacy ${legacy}, new ${now})`);

// ── Formatting ────────────────────────────────────────────────────────────
check('fmtETTime(20,0) -> 8:00 PM', fmtETTime(20, 0) === '8:00 PM');
check('fmtETTime(0,5)  -> 12:05 AM', fmtETTime(0, 5) === '12:05 AM');
check('fmtETTime(12,0) -> 12:00 PM', fmtETTime(12, 0) === '12:00 PM');

check('default cutoff is Tue 8pm', fmtWaiverCutoff(undefined) === 'Tue 8pm');
check('cutoff omits :00 minutes', fmtWaiverCutoff({ waiverDay: 4, waiverHour: 9, waiverMinute: 0 }) === 'Thu 9am');
check('cutoff shows non-zero minutes', fmtWaiverCutoff({ waiverDay: 2, waiverHour: 20, waiverMinute: 30 }) === 'Tue 8:30pm');
check('waiverCutoff applies defaults', JSON.stringify(waiverCutoff(null)) === JSON.stringify(DEFAULT_WAIVER_CUTOFF));
check('waiverCutoff honours partial overrides',
  waiverCutoff({ waiverHour: 9 }).hour === 9 && waiverCutoff({ waiverHour: 9 }).day === DEFAULT_WAIVER_CUTOFF.day);

// ── Names ─────────────────────────────────────────────────────────────────
check('abbreviateName basic', abbreviateName('Rory McIlroy') === 'R. McIlroy');
check('abbreviateName single word unchanged', abbreviateName('Cabrera') === 'Cabrera');
check('abbreviateName empty', abbreviateName('') === '' && abbreviateName(null) === '');
check('abbreviateName three-part name uses last', abbreviateName('Charles Howell III') === 'C. III');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
