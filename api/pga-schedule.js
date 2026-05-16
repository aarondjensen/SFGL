// api/pga-schedule.js
// ─────────────────────────────────────────────────────────────────────────────
// Fetches the full PGA Tour schedule for a given season from pgatour.com.
// Same __NEXT_DATA__ scrape pattern as api/live.js (leaderboard) — Next.js
// SSR hydration payload contains all the schedule data we need.
//
// USAGE:
//   GET /api/pga-schedule?season=2027
//
// RESPONSE SHAPE (on success):
//   {
//     season: 2027,
//     source: "pgatour.com/schedule",
//     count: 47,
//     tournaments: [
//       {
//         name:           "The Sentry",
//         startDate:      "2027-01-04",     // ISO yyyy-mm-dd
//         endDate:        "2027-01-07",
//         dates:          "Jan 4-7, 2027",  // pre-formatted display string
//         location:       "Kapalua, HI",
//         course:         "Plantation Course at Kapalua",
//         tournamentId:   "R2027016",       // PGA Tour internal ID
//         isSignature:    true,             // auto-detected (best effort)
//         isMajor:        false,
//         isAlternate:    false,
//         tourCode:       "R",              // 'R' = PGA Tour
//         purse:          20000000,         // dollars, if present
//         _raw:           { ... }           // ALL fields from PGA Tour, for fallback
//       },
//       ...
//     ],
//     warnings: [ ... ]                     // human-readable notes (e.g. "course not found")
//   }
//
// On failure:
//   { error: "...", details: "..." }
//
// DESIGN NOTES:
// - PGA Tour's API response shape is undocumented and field names sometimes
//   change. This code probes multiple possible field names for each piece of
//   data ("startDate" vs "tournamentDate" vs "dates.start" etc) before giving
//   up. When a field is missing entirely, we still include the tournament
//   record with that field set to null — the UI can flag it for manual entry.
// - We ALSO return `_raw` per tournament so the import UI can surface any
//   fields we didn't know to look for. Power feature for debugging.
// - Cache: 1 hour CDN cache. Schedule data is published once per year and
//   then mostly static; we don't need fresh-every-request behavior here.

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Referer': 'https://www.pgatour.com/',
};

// PGA Tour majors are stable year-over-year. Used as a fallback when the
// scrape doesn't expose a Major flag explicitly.
const MAJOR_NAME_PATTERNS = [
  /^the masters$/i,
  /^masters tournament$/i,
  /pga championship/i,
  /^u\.?s\.?\s*open/i,
  /^the open(\s+championship)?$/i,
  /british open/i,
];

const isMajorByName = (name) => MAJOR_NAME_PATTERNS.some(re => re.test(String(name || '').trim()));

// Signature events on the 2025/2026 PGA Tour have purses ≥ $20M. This is the
// cleanest auto-detection signal we have if a `tournamentType` field isn't
// exposed. We bias toward false-positive over false-negative — the commish
// can untoggle in the UI either way.
const SIGNATURE_PURSE_THRESHOLD = 20_000_000;

function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// Pull a value out of an object trying a sequence of possible field paths.
// Each path can be either a simple key ("name") or a dotted path ("a.b.c").
const probe = (obj, ...paths) => {
  for (const path of paths) {
    if (!path) continue;
    const parts = path.split('.');
    let cur = obj;
    let ok = true;
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object') { ok = false; break; }
      cur = cur[p];
    }
    if (ok && cur != null && cur !== '') return cur;
  }
  return null;
};

// Coerce various date inputs into yyyy-mm-dd. PGA Tour usually uses ISO
// timestamps but we handle a few formats defensively.
const toIsoDate = (val) => {
  if (!val) return null;
  if (typeof val === 'string') {
    // Already in yyyy-mm-dd form
    if (/^\d{4}-\d{2}-\d{2}/.test(val)) return val.slice(0, 10);
    // Try parsing as Date
    const d = new Date(val);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return null;
  }
  if (typeof val === 'number') {
    const d = new Date(val > 1e12 ? val : val * 1000);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
};

// Build a display-friendly date range string from start/end ISO dates.
// e.g. "Jan 4-7, 2027" — matches the existing `t.dates` format used in
// TournamentsView so imported events render consistently with manually-entered ones.
const formatDateRange = (startIso, endIso) => {
  if (!startIso) return '';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const sd = new Date(startIso + 'T12:00:00Z');
  const sm = months[sd.getUTCMonth()];
  const sday = sd.getUTCDate();
  const syear = sd.getUTCFullYear();
  if (!endIso) return `${sm} ${sday}, ${syear}`;
  const ed = new Date(endIso + 'T12:00:00Z');
  const em = months[ed.getUTCMonth()];
  const eday = ed.getUTCDate();
  if (sm === em) return `${sm} ${sday}-${eday}, ${syear}`;
  return `${sm} ${sday} - ${em} ${eday}, ${syear}`;
};

// Filter for PGA Tour events only (matches the same logic as live.js).
// Returns true when t is plausibly a PGA Tour event; conservatively excludes
// known non-PGA tours (Korn Ferry, Champions, LPGA, LIV, DP World).
const isPgaTourTournament = (t) => {
  if (!t || typeof t !== 'object') return true;
  const code = t.tourCode || t.tour?.code || t.tour?.id || t.tourId || '';
  const name = String(t.tour?.name || t.tourName || '').toLowerCase();
  if (code === 'H' || code === 'S' || code === 'P' || code === 'X' || code === 'M') return false;
  if (name.includes('korn') || name.includes('champion') || name.includes('lpga') || name.includes('liv') || name.includes('dp world')) return false;
  if (code === 'R') return true;
  if (name.includes('pga tour')) return true;
  return true;  // unknown → assume PGA Tour (we're on pgatour.com)
};

// Locate the schedule data inside the dehydratedState.queries array. PGA Tour
// uses different query keys depending on the page; we try multiple known ones
// in priority order.
const findScheduleQuery = (queries) => {
  if (!Array.isArray(queries)) return null;
  // Most likely keys, in priority order
  const candidates = [
    ['scheduleTournaments'],
    ['schedule'],
    ['tournaments'],
    ['seasonSchedule'],
  ];
  for (const candidate of candidates) {
    const q = queries.find(q => Array.isArray(q.queryKey) && q.queryKey[0] === candidate[0]);
    if (q?.state?.data) return { key: candidate[0], data: q.state.data };
  }
  // Last resort: any query whose key contains the word "schedule"
  const fallback = queries.find(q =>
    Array.isArray(q.queryKey) &&
    typeof q.queryKey[0] === 'string' &&
    q.queryKey[0].toLowerCase().includes('schedule')
  );
  if (fallback?.state?.data) return { key: fallback.queryKey[0], data: fallback.state.data };
  return null;
};

// PGA Tour's schedule data is sometimes a flat array, sometimes grouped by
// month/week. Normalize to a flat list.
const flattenSchedule = (data) => {
  if (Array.isArray(data)) {
    // Already flat — but check if these are wrappers with .tournaments inside
    if (data.length > 0 && Array.isArray(data[0]?.tournaments)) {
      return data.flatMap(g => g.tournaments || []);
    }
    return data;
  }
  if (data && typeof data === 'object') {
    if (Array.isArray(data.tournaments)) return data.tournaments;
    if (Array.isArray(data.completed) || Array.isArray(data.upcoming)) {
      return [...(data.completed || []), ...(data.upcoming || [])];
    }
    if (Array.isArray(data.weeks)) {
      return data.weeks.flatMap(w => w.tournaments || []);
    }
    if (Array.isArray(data.months)) {
      return data.months.flatMap(m => (m.tournaments || m.weeks?.flatMap(w => w.tournaments || []) || []));
    }
    // Object whose values are tournament records
    const vals = Object.values(data);
    if (vals.length > 0 && vals[0] && typeof vals[0] === 'object' && (vals[0].tournamentName || vals[0].name)) {
      return vals;
    }
  }
  return [];
};

// Normalize one raw PGA Tour tournament record into our app's schema.
const normalize = (raw) => {
  const name = probe(raw,
    'tournamentName', 'name', 'displayName', 'eventName',
  );
  const startDate = toIsoDate(probe(raw,
    'startDate', 'tournamentDate', 'startDateTime',
    'dates.start', 'date.start', 'start',
  ));
  const endDate = toIsoDate(probe(raw,
    'endDate', 'endDateTime',
    'dates.end', 'date.end', 'end',
  ));
  // Course / venue / location are nested under different shapes year-to-year.
  // PGA Tour sometimes uses a `courses[]` array — pick the primary (first) one.
  let course = probe(raw,
    'courseName', 'course.name',
    'venue.name', 'venueName',
    'primaryCourse.name',
    'host.name',
  );
  if (!course && Array.isArray(raw?.courses) && raw.courses.length > 0) {
    course = raw.courses[0]?.name || raw.courses[0]?.courseName || null;
  }
  // Location: "City, ST" — try several paths
  let location = probe(raw,
    'location', 'venue.location',
    'tournamentLocation',
    'city',
  );
  if (!location) {
    // Try to compose from city + state
    const city = probe(raw, 'venue.city', 'courses.0.city', 'city');
    const state = probe(raw, 'venue.state', 'venue.stateCode', 'courses.0.state', 'state', 'stateCode');
    if (city && state) location = `${city}, ${state}`;
    else if (city) location = city;
  }

  const tournamentId = probe(raw, 'id', 'tournamentId', 'permNum');
  const tourCode = probe(raw, 'tourCode', 'tour.code', 'tour.id', 'tourId');
  const purse = probe(raw, 'purse', 'tournamentPurse', 'totalPurse', 'prizeMoney');

  // Auto-detection of S/M/Alt — best-effort, the commish should review.
  // Major: hardcoded name patterns (Masters, PGA, U.S. Open, Open Championship)
  const isMajor = isMajorByName(name);
  // Signature: explicit field, or by purse threshold, or by tournament type
  const explicitType = String(probe(raw, 'tournamentType', 'eventType', 'category') || '').toLowerCase();
  const explicitSig = explicitType.includes('signature') || explicitType === 'elevated';
  const isSignature = explicitSig
    || (typeof purse === 'number' && purse >= SIGNATURE_PURSE_THRESHOLD && !isMajor);
  // Alternate / opposite-field: explicit field, or naming/scheduling heuristic
  // The PGA Tour sometimes flags these with `oppositeField: true`. Otherwise
  // we'll mark as false and let the commish toggle — opposite-field detection
  // by date-collision would require comparing across the full list and we
  // don't want to bake too many assumptions in.
  const isAlternate = probe(raw, 'oppositeField', 'isOppositeField') === true;

  return {
    name: name || '(unknown)',
    startDate,
    endDate,
    dates: formatDateRange(startDate, endDate),
    location: location || null,
    course: course || null,
    tournamentId: tournamentId || null,
    tourCode: tourCode || null,
    purse: typeof purse === 'number' ? purse : null,
    isSignature,
    isMajor,
    isAlternate,
    _raw: raw,  // pass through for the UI to debug missing fields
  };
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const seasonParam = String(req.query?.season || '').trim();
  const season = parseInt(seasonParam, 10);
  if (!seasonParam || isNaN(season) || season < 2000 || season > 2100) {
    return res.status(400).json({
      error: 'invalid season',
      details: 'Pass ?season=YYYY (e.g. ?season=2027). Must be a 4-digit year.',
    });
  }

  // Best-guess URL. PGA Tour seems to support ?season= but we'll fall back to
  // the bare URL if needed.
  const urlsToTry = [
    `https://www.pgatour.com/schedule?season=${season}`,
    `https://www.pgatour.com/schedule/${season}`,
    `https://www.pgatour.com/schedule`,  // bare — may default to current
  ];

  const warnings = [];
  let nd = null;
  let usedUrl = null;
  for (const url of urlsToTry) {
    try {
      const resp = await fetch(url, { headers: HEADERS });
      if (!resp.ok) {
        warnings.push(`${url} → HTTP ${resp.status}`);
        continue;
      }
      const html = await resp.text();
      const parsed = extractNextData(html);
      if (parsed) {
        nd = parsed;
        usedUrl = url;
        break;
      } else {
        warnings.push(`${url} → no __NEXT_DATA__ block found`);
      }
    } catch (e) {
      warnings.push(`${url} → fetch failed: ${e.message}`);
    }
  }

  if (!nd) {
    return res.status(502).json({
      error: 'unable to fetch PGA Tour schedule',
      details: 'Tried multiple URLs; none returned a parseable __NEXT_DATA__.',
      warnings,
    });
  }

  const queries = nd.props?.pageProps?.dehydratedState?.queries || [];
  const scheduleQ = findScheduleQuery(queries);

  if (!scheduleQ) {
    return res.status(502).json({
      error: 'schedule data not found in page',
      details: 'No query in dehydratedState matched expected keys (scheduleTournaments / schedule / tournaments). PGA Tour may have changed their data shape.',
      queryKeys: queries.map(q => Array.isArray(q.queryKey) ? q.queryKey[0] : '?').slice(0, 20),
      warnings,
    });
  }

  const flat = flattenSchedule(scheduleQ.data);
  if (flat.length === 0) {
    return res.status(502).json({
      error: 'schedule was found but empty after flattening',
      details: 'PGA Tour returned a schedule object but no tournaments could be extracted. They may not have published the requested season yet.',
      sample: JSON.stringify(scheduleQ.data).slice(0, 500),
      warnings,
    });
  }

  // Filter to PGA Tour events + normalize
  const pgaTournaments = flat.filter(isPgaTourTournament);
  const normalized = pgaTournaments
    .map(normalize)
    .sort((a, b) => {
      // Sort by startDate ascending; tournaments without dates go to the end
      if (!a.startDate && !b.startDate) return 0;
      if (!a.startDate) return 1;
      if (!b.startDate) return -1;
      return a.startDate.localeCompare(b.startDate);
    });

  // Surface warnings about partial data so the UI can flag rows for review
  const missingDates = normalized.filter(t => !t.startDate).length;
  const missingCourses = normalized.filter(t => !t.course).length;
  const missingLocations = normalized.filter(t => !t.location).length;
  if (missingDates > 0) warnings.push(`${missingDates} tournament(s) missing dates`);
  if (missingCourses > 0) warnings.push(`${missingCourses} tournament(s) missing course names`);
  if (missingLocations > 0) warnings.push(`${missingLocations} tournament(s) missing location`);

  return res.status(200).json({
    season,
    source: usedUrl,
    queryKey: scheduleQ.key,
    count: normalized.length,
    tournaments: normalized,
    warnings,
  });
}
