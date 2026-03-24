/**
 * Tournament Timezone Utility
 * Maps PGA Tour tournament locations to IANA timezones
 * and calculates lineup lock times (7:00 AM local).
 */

// ── US State abbreviation → IANA timezone ──
// Most states map to a single zone; for states that span two zones
// (e.g. IN, ND, NE, etc.) we pick the zone where PGA venues sit.
const STATE_TIMEZONE_MAP = {
  // Eastern
  CT: 'America/New_York',
  DC: 'America/New_York',
  DE: 'America/New_York',
  FL: 'America/New_York',
  GA: 'America/New_York',
  IN: 'America/New_York',
  KY: 'America/New_York',
  MA: 'America/New_York',
  MD: 'America/New_York',
  ME: 'America/New_York',
  MI: 'America/New_York',
  NC: 'America/New_York',
  NH: 'America/New_York',
  NJ: 'America/New_York',
  NY: 'America/New_York',
  OH: 'America/New_York',
  PA: 'America/New_York',
  RI: 'America/New_York',
  SC: 'America/New_York',
  TN: 'America/New_York',
  VA: 'America/New_York',
  VT: 'America/New_York',
  WV: 'America/New_York',
  // Central
  AL: 'America/Chicago',
  AR: 'America/Chicago',
  IA: 'America/Chicago',
  IL: 'America/Chicago',
  KS: 'America/Chicago',
  LA: 'America/Chicago',
  MN: 'America/Chicago',
  MO: 'America/Chicago',
  MS: 'America/Chicago',
  ND: 'America/Chicago',
  NE: 'America/Chicago',
  OK: 'America/Chicago',
  SD: 'America/Chicago',
  TX: 'America/Chicago',
  WI: 'America/Chicago',
  // Mountain
  AZ: 'America/Phoenix',   // no DST
  CO: 'America/Denver',
  ID: 'America/Boise',
  MT: 'America/Denver',
  NM: 'America/Denver',
  UT: 'America/Denver',
  WY: 'America/Denver',
  // Pacific
  CA: 'America/Los_Angeles',
  NV: 'America/Los_Angeles',
  OR: 'America/Los_Angeles',
  WA: 'America/Los_Angeles',
  // Other
  HI: 'Pacific/Honolulu',
  AK: 'America/Anchorage',
  PR: 'America/Puerto_Rico',
};

// ── International / special tournaments ──
// Keyed by substring match on tournament name
const INTERNATIONAL_TIMEZONE_MAP = {
  'Scottish Open':       'Europe/London',
  'The Open':            'Europe/London',
  'Genesis Scottish':    'Europe/London',
  'Corales Puntacana':   'America/Santo_Domingo',
  'Bermuda':             'Atlantic/Bermuda',
  'Butterfield Bermuda': 'Atlantic/Bermuda',
  'Baycurrent Classic':  'Asia/Tokyo',
  'ZOZO':                'Asia/Tokyo',
};

/**
 * Extract the state abbreviation from a "City, ST" location string.
 * Returns null if no match.
 */
function extractState(location) {
  if (!location) return null;
  const match = location.trim().match(/,\s*([A-Z]{2})$/);
  return match ? match[1] : null;
}

/**
 * Resolve the IANA timezone for a tournament.
 *
 * Priority:
 *   1. Manual override (`tournament.timezoneOverride`)
 *   2. International tournament name match
 *   3. US state from location field
 *   4. Fallback: 'America/New_York'
 *
 * @param {Object} tournament - { name, location, timezoneOverride? }
 * @returns {string} IANA timezone identifier
 */
export function getTournamentTimezone(tournament) {
  // 1. Manual override
  if (tournament.timezoneOverride) return tournament.timezoneOverride;

  // 2. International name match
  for (const [keyword, tz] of Object.entries(INTERNATIONAL_TIMEZONE_MAP)) {
    if (tournament.name?.includes(keyword)) return tz;
  }

  // 3. US state lookup
  const state = extractState(tournament.location);
  if (state && STATE_TIMEZONE_MAP[state]) return STATE_TIMEZONE_MAP[state];

  // 4. Fallback
  return 'America/New_York';
}

/**
 * Calculate the lineup lock time for a tournament.
 * Returns a Date set to 7:00 AM local time on the tournament start date.
 *
 * @param {Object} tournament - must have `startDate` (ISO string) or `dates` (display string)
 * @param {number} [lockHour=7] - hour in local time to lock (default 7 AM)
 * @returns {Date|null} - UTC Date representing the lock moment, or null if no date available
 */
export function getLineupLockTime(tournament, lockHour) {
  // Use tournament-level override, then explicit param, then default 7 AM
  const hour = lockHour ?? tournament.lockHour ?? 7;
  const tz = getTournamentTimezone(tournament);

  // Determine the start date
  let startDateStr = tournament.startDate; // ISO string from ESPN

  if (!startDateStr && tournament.dates) {
    // Parse from display dates like "Feb 26 - Mar 1"
    // We need the year — assume current season year
    const year = new Date().getFullYear();
    const match = tournament.dates.match(/^([A-Z][a-z]{2})\s+(\d{1,2})/);
    if (match) {
      const monthStr = match[1];
      const day = match[2];
      const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
                        Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
      if (months[monthStr] !== undefined) {
        startDateStr = new Date(year, months[monthStr], parseInt(day)).toISOString();
      }
    }
  }

  if (!startDateStr) return null;

  // Get the calendar date from the start date
  // We need the date in the tournament's local timezone
  const startDate = new Date(startDateStr);

  // Format in the target timezone to extract the local date components
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(startDate);
  const year  = parseInt(parts.find(p => p.type === 'year').value);
  const month = parseInt(parts.find(p => p.type === 'month').value) - 1;
  const day   = parseInt(parts.find(p => p.type === 'day').value);

  // Now build a date string for 7:00 AM in that timezone
  // Create an ISO-ish string and use the timezone to convert to UTC
  const localDateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00`;

  // Use Intl to figure out the UTC offset at that moment
  // We'll iterate to find the UTC time that corresponds to 7 AM local
  // Simpler approach: use a known reference and adjust
  const utcGuess = new Date(`${localDateStr}Z`);

  // Get what time our UTC guess would be in the local tz
  const localCheck = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    hour12: false,
  }).format(utcGuess);

  const localHour = parseInt(localCheck);
  const offsetHours = localHour - hour;

  // Adjust: if local time is ahead of UTC, we need to subtract
  const lockUTC = new Date(utcGuess.getTime() - offsetHours * 60 * 60 * 1000);

  return lockUTC;
}

/**
 * Format a lock time for display, showing both local tournament time and ET.
 *
 * @param {Date} lockTime - UTC Date of the lock
 * @param {string} tz - IANA timezone of the tournament
 * @returns {string} e.g. "Thu 7:00 AM ET" or "Thu 7:00 AM PT (10:00 AM ET)"
 */
export function formatLockTime(lockTime, tz) {
  if (!lockTime) return '';

  const localFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });

  const localStr = localFmt.format(lockTime);

  // If already ET, no need for dual display
  if (tz === 'America/New_York') return localStr;

  const etFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });

  return `${localStr} (${etFmt.format(lockTime)})`;
}

/**
 * Check if lineups are currently locked for a tournament.
 *
 * @param {Object} tournament
 * @returns {boolean}
 */
export function areLineupsLocked(tournament) {
  const lockTime = getLineupLockTime(tournament);
  if (!lockTime) return false;
  return new Date() >= lockTime;
}

// ── All available timezones for manual override dropdown ──
export const TIMEZONE_OPTIONS = [
  { value: '',                       label: 'Auto-detect' },
  { value: 'Pacific/Honolulu',       label: 'Hawaii (HST)' },
  { value: 'America/Anchorage',      label: 'Alaska (AKST)' },
  { value: 'America/Los_Angeles',    label: 'Pacific (PT)' },
  { value: 'America/Phoenix',        label: 'Arizona (MST)' },
  { value: 'America/Denver',         label: 'Mountain (MT)' },
  { value: 'America/Chicago',        label: 'Central (CT)' },
  { value: 'America/New_York',       label: 'Eastern (ET)' },
  { value: 'America/Puerto_Rico',    label: 'Puerto Rico (AST)' },
  { value: 'America/Santo_Domingo',  label: 'Dominican Republic (AST)' },
  { value: 'Atlantic/Bermuda',       label: 'Bermuda (AST)' },
  { value: 'Europe/London',          label: 'UK (GMT/BST)' },
  { value: 'Asia/Tokyo',             label: 'Japan (JST)' },
];
