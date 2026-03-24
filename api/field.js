// api/field.js — Vercel serverless function
// Returns the current/upcoming PGA Tour tournament field with tee times.
//
// Resolution order:
//   1. statdata-api-prod.pgatour.com — PGA Tour's internal JSON API (fast, reliable)
//   2. pgatour.com/schedule + /field page — HTML scrape (__NEXT_DATA__)
//   3. ESPN leaderboard by event ID — last resort, may not have pre-tournament field
//
// GET /api/field          → { players, teeTimes, tournament, count, source }
// GET /api/field?debug=1  → diagnostic info

const HEADERS_JSON = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};
const HEADERS_HTML = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function nameToSlug(name) {
  return name.toLowerCase().replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function walkAll(obj, collect) {
  if (!obj || typeof obj !== 'object') return;
  collect(obj);
  if (Array.isArray(obj)) obj.forEach(o => walkAll(o, collect));
  else Object.values(obj).forEach(v => walkAll(v, collect));
}

function formatTeeTime(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true,
      timeZone: 'America/New_York',
    });
  } catch { return null; }
}

// ── Source 1: statdata-api-prod.pgatour.com ───────────────────────────────────
// Requires knowing T_NUM (e.g. "020" for Houston) and T_CODE ("R" = regular)
// We get these from the schedule page __NEXT_DATA__ tournamentId: "R2026020"
async function fetchFromStatsApi(tournamentId) {
  // tournamentId format: "R2026020" → T_CODE=R, YEAR=2026, T_NUM=020
  const m = tournamentId.match(/^([A-Z])(\d{4})(\d+)$/);
  if (!m) throw new Error(`Unexpected tournament ID format: ${tournamentId}`);
  const [, tCode, year, tNum] = m;
  const url = `https://statdata-api-prod.pgatour.com/api/clientfile/Field?T_CODE=${tCode}&T_NUM=${tNum}&YEAR=${year}&format=json`;
  const resp = await fetch(url, { headers: HEADERS_JSON });
  if (!resp.ok) throw new Error(`Stats API ${resp.status}`);
  const data = await resp.json();

  // Response shape: { Tournament: { Players: { Player: [...] } } }
  const playerList = data?.Tournament?.Players?.Player || data?.Players?.Player || [];
  const arr = Array.isArray(playerList) ? playerList : [playerList];

  const players = arr
    .map(p => {
      const first = p.FirstName || p.firstName || '';
      const last = p.LastName || p.lastName || '';
      const full = p.PlayerName || p.displayName || (first && last ? `${first} ${last}` : '');
      return full.trim();
    })
    .filter(Boolean);

  // Tee times if available
  const teeTimes = arr
    .filter(p => p.TeeTime || p.teeTime)
    .map(p => {
      const first = p.FirstName || p.firstName || '';
      const last = p.LastName || p.lastName || '';
      const name = p.PlayerName || p.displayName || `${first} ${last}`.trim();
      const tt = formatTeeTime(p.TeeTime || p.teeTime);
      return name && tt ? { name, teeTime: tt } : null;
    })
    .filter(Boolean);

  return { players, teeTimes, source: 'pgatour-stats' };
}

// ── Source 2: pgatour.com schedule + field HTML page ─────────────────────────
async function fetchFromPGATourHtml(year) {
  const schedResp = await fetch('https://www.pgatour.com/schedule', { headers: HEADERS_HTML });
  if (!schedResp.ok) throw new Error(`Schedule page ${schedResp.status}`);
  const schedHtml = await schedResp.text();
  const nd = extractNextData(schedHtml);
  if (!nd) throw new Error('No __NEXT_DATA__ on schedule page');

  // Find upcoming tournament
  const queries = nd?.props?.pageProps?.dehydratedState?.queries || [];
  let tournaments = [];
  for (const q of queries) {
    if (q?.state?.data?.tournaments) tournaments = tournaments.concat(q.state.data.tournaments);
  }
  const seen = new Set();
  const unique = tournaments.filter(t => { if (seen.has(t.tournamentId)) return false; seen.add(t.tournamentId); return true; });
  const DONE = ['COMPLETED', 'OFFICIAL', 'PAST', 'CANCELLED'];
  const tournament = unique.find(t => t.status === 'IN_PROGRESS')
    || unique.find(t => t.status === 'UPCOMING')
    || unique.find(t => !DONE.includes(t.status?.toUpperCase()));
  if (!tournament) throw new Error('No upcoming tournament on schedule');

  const slug = nameToSlug(tournament.name);
  const fieldUrl = `https://www.pgatour.com/tournaments/${year}/${slug}/${tournament.tournamentId}/field`;
  const fieldResp = await fetch(fieldUrl, { headers: HEADERS_HTML });
  if (!fieldResp.ok) throw new Error(`Field page ${fieldResp.status}`);
  const fieldHtml = await fieldResp.text();
  const fieldNd = extractNextData(fieldHtml);

  const playerNames = new Set();
  const teeTimeMap = {};
  const oddsMap = {};

  if (fieldNd) {
    walkAll(fieldNd, obj => {
      const name = obj.displayName?.trim() || (obj.firstName && obj.lastName ? `${obj.firstName.trim()} ${obj.lastName.trim()}` : null);
      if (name?.includes(' ')) {
        playerNames.add(name);
        const tt = obj.teeTime || obj.teeTimeLocal || obj.startTime;
        if (tt && typeof tt === 'string') teeTimeMap[name] = formatTeeTime(tt) || tt;
      }
      if ((obj.teeTime || obj.startTime) && Array.isArray(obj.players)) {
        const tt = formatTeeTime(obj.teeTime || obj.startTime);
        obj.players.forEach(p => {
          const pn = p.displayName?.trim() || (p.firstName && p.lastName ? `${p.firstName.trim()} ${p.lastName.trim()}` : null);
          if (pn && tt) teeTimeMap[pn] = tt;
        });
      }
      if (obj.oddsToWinId && obj.oddsEnabled && Array.isArray(obj.players)) {
        obj.players.forEach(p => {
          const pn = p.displayName?.trim() || p.playerName?.trim();
          const n = parseInt(p.odds || p.currentOdds, 10);
          if (pn && !isNaN(n)) oddsMap[pn] = n > 0 ? `+${n}` : `${n}`;
        });
      }
    });
  }

  // Deduplicate Last,First vs First Last
  const allNames = [...playerNames];
  const players = allNames.filter(name => {
    if (!name.includes(',')) return true;
    const [last, first] = name.split(',').map(s => s.trim());
    return first ? !playerNames.has(`${first} ${last}`) : true;
  });

  const normalize = k => {
    if (!k.includes(',')) return k;
    const [last, first] = k.split(',').map(s => s.trim());
    return first ? `${first} ${last}` : k;
  };
  const normTeeTimeMap = {};
  Object.entries(teeTimeMap).forEach(([k, v]) => { normTeeTimeMap[normalize(k)] = v; });
  let teeTimes = players.filter(n => normTeeTimeMap[n]).map(n => ({ name: n, teeTime: normTeeTimeMap[n] }));

  // If no tee times from field page, try the dedicated /tee-times page
  if (!teeTimes.length && players.length) {
    try {
      const slug = nameToSlug(tournament.name);
      const ttUrl = `https://www.pgatour.com/tournaments/${year}/${slug}/${tournament.tournamentId}/tee-times`;
      const ttResp = await fetch(ttUrl, { headers: HEADERS_HTML });
      if (ttResp.ok) {
        const ttHtml = await ttResp.text();
        const ttNd = extractNextData(ttHtml);
        if (ttNd) {
          const ttMapFromPage = {};
          walkAll(ttNd, obj => {
            // Tee time group: { teeTime/startTime, players: [...] }
            if ((obj.teeTime || obj.startTime) && Array.isArray(obj.players) && obj.players.length) {
              const tt = formatTeeTime(obj.teeTime || obj.startTime);
              if (tt) obj.players.forEach(p => {
                const pn = p.displayName?.trim() || (p.firstName && p.lastName ? `${p.firstName.trim()} ${p.lastName.trim()}` : null);
                if (pn) ttMapFromPage[normalize(pn)] = tt;
              });
            }
            // Also check for player object with teeTime directly
            const pn = obj.displayName?.trim() || (obj.firstName && obj.lastName ? `${obj.firstName.trim()} ${obj.lastName.trim()}` : null);
            if (pn) {
              const tt = obj.teeTime || obj.teeTimeLocal || obj.startTime;
              if (tt && typeof tt === 'string' && (tt.includes('T') || tt.includes(':'))) {
                ttMapFromPage[normalize(pn)] = formatTeeTime(tt) || tt;
              }
            }
          });
          teeTimes = players
            .filter(n => ttMapFromPage[normalize(n)])
            .map(n => ({ name: n, teeTime: ttMapFromPage[normalize(n)] }));
        }
      }
    } catch (_) { /* tee times page failed — not critical */ }
  }

  return { players, teeTimes, tournament, source: 'pgatour-html' };
}

// ── Source 3: ESPN event field + tee times ───────────────────────────────────
async function fetchFromESPN() {
  // Find upcoming event ID
  for (let offset = 0; offset <= 14; offset++) {
    const d = new Date(); d.setDate(d.getDate() + offset);
    const ds = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard?dates=${ds}`, { headers: HEADERS_JSON });
    if (!r.ok) continue;
    const data = await r.json();
    const pga = (data?.events || []).filter(e => e.status?.type?.state !== 'post');
    if (!pga.length) continue;
    const event = pga.find(e => e.status?.type?.state === 'pre') || pga[0];

    // Fetch full event field via leaderboard endpoint — includes teeTime on competitors
    const r2 = await fetch(`https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?event=${event.id}`, { headers: HEADERS_JSON });
    if (!r2.ok) continue;
    const ld = await r2.json();
    const competitors = ld?.events?.[0]?.competitions?.[0]?.competitors || [];
    if (!competitors.length) continue;

    const players = [];
    const teeTimes = [];

    competitors.forEach(c => {
      const name = c.athlete?.displayName || c.athlete?.fullName || '';
      if (!name) return;
      players.push(name);
      // ESPN stores tee time on the competitor or its status
      const ttRaw = c.teeTime || c.status?.teeTime || c.startTime;
      if (ttRaw) {
        const tt = formatTeeTime(ttRaw);
        if (tt) teeTimes.push({ name, teeTime: tt });
      }
    });

    if (players.length) return { players, teeTimes, tournament: event.name, source: 'espn' };
  }
  throw new Error('No field found via ESPN');
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const isDebug = req.query.debug === '1';
  const year = new Date().getFullYear().toString();

  let result = null;
  const errors = [];

  // Try each source in order
  // Source 1: Stats API (requires tournament ID — get from schedule first)
  try {
    const schedResp = await fetch('https://www.pgatour.com/schedule', { headers: HEADERS_HTML });
    if (schedResp.ok) {
      const nd = extractNextData(await schedResp.text());
      const queries = nd?.props?.pageProps?.dehydratedState?.queries || [];
      let tournaments = [];
      for (const q of queries) {
        if (q?.state?.data?.tournaments) tournaments = tournaments.concat(q.state.data.tournaments);
      }
      const DONE = ['COMPLETED', 'OFFICIAL', 'PAST', 'CANCELLED'];
      const seen = new Set();
      const unique = tournaments.filter(t => { if (seen.has(t.tournamentId)) return false; seen.add(t.tournamentId); return true; });
      const tournament = unique.find(t => t.status === 'IN_PROGRESS')
        || unique.find(t => t.status === 'UPCOMING')
        || unique.find(t => !DONE.includes(t.status?.toUpperCase()));

      if (tournament?.tournamentId) {
        try {
          const statsResult = await fetchFromStatsApi(tournament.tournamentId);
          if (statsResult.players.length) {
            result = { ...statsResult, tournament: tournament.name };
          }
        } catch (e) { errors.push(`stats-api: ${e.message}`); }

        // If stats API failed, try field HTML page (same schedule fetch)
        if (!result) {
          try {
            const slug = nameToSlug(tournament.name);
            const fieldResp = await fetch(`https://www.pgatour.com/tournaments/${year}/${slug}/${tournament.tournamentId}/field`, { headers: HEADERS_HTML });
            if (fieldResp.ok) {
              const fieldHtml = await fieldResp.text();
              const fieldNd = extractNextData(fieldHtml);
              if (fieldNd) {
                const playerNames = new Set();
                const teeTimeMap = {};
                walkAll(fieldNd, obj => {
                  const name = obj.displayName?.trim() || (obj.firstName && obj.lastName ? `${obj.firstName.trim()} ${obj.lastName.trim()}` : null);
                  if (name?.includes(' ')) playerNames.add(name);
                  if ((obj.teeTime || obj.startTime) && Array.isArray(obj.players)) {
                    const tt = formatTeeTime(obj.teeTime || obj.startTime);
                    obj.players.forEach(p => {
                      const pn = p.displayName?.trim() || (p.firstName && p.lastName ? `${p.firstName.trim()} ${p.lastName.trim()}` : null);
                      if (pn && tt) teeTimeMap[pn] = tt;
                    });
                  }
                });
                const normalize = k => { if (!k.includes(',')) return k; const [last, first] = k.split(',').map(s => s.trim()); return first ? `${first} ${last}` : k; };
                const players = [...playerNames].filter(n => !n.includes(',') || !playerNames.has(`${n.split(',')[1]?.trim()} ${n.split(',')[0]?.trim()}`));
                const normMap = {}; Object.entries(teeTimeMap).forEach(([k, v]) => { normMap[normalize(k)] = v; });
                let teeTimes = players.filter(n => normMap[n]).map(n => ({ name: n, teeTime: normMap[n] }));

                // Try /tee-times page if field page had no tee times
                if (!teeTimes.length && players.length) {
                  try {
                    const ttResp = await fetch(`https://www.pgatour.com/tournaments/${year}/${slug}/${tournament.tournamentId}/tee-times`, { headers: HEADERS_HTML });
                    if (ttResp.ok) {
                      const ttNd = extractNextData(await ttResp.text());
                      if (ttNd) {
                        const ttMap = {};
                        walkAll(ttNd, obj => {
                          if ((obj.teeTime || obj.startTime) && Array.isArray(obj.players) && obj.players.length) {
                            const tt = formatTeeTime(obj.teeTime || obj.startTime);
                            if (tt) obj.players.forEach(p => {
                              const pn = p.displayName?.trim() || (p.firstName && p.lastName ? `${p.firstName.trim()} ${p.lastName.trim()}` : null);
                              if (pn) ttMap[normalize(pn)] = tt;
                            });
                          }
                        });
                        teeTimes = players.filter(n => ttMap[normalize(n)]).map(n => ({ name: n, teeTime: ttMap[normalize(n)] }));
                      }
                    }
                  } catch (_) {}
                }

                if (players.length) result = { players, teeTimes, tournament: tournament.name, source: 'pgatour-html' };
              }
            }
          } catch (e) { errors.push(`html: ${e.message}`); }
        }
      }
    }
  } catch (e) { errors.push(`schedule: ${e.message}`); }

  // Source 3: ESPN fallback (full fallback if no result, or tee time supplement)
  if (!result) {
    try {
      result = await fetchFromESPN();
    } catch (e) { errors.push(`espn: ${e.message}`); }
  } else if (result.players.length && !result.teeTimes?.length) {
    // We have players from PGA Tour but no tee times — try ESPN to supplement
    try {
      const espn = await fetchFromESPN();
      if (espn.teeTimes?.length) {
        // Match ESPN tee times to our PGA Tour player names by normalized name
        const normalize = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/ø/g,'o').replace(/Ø/g,'O').replace(/æ/g,'ae').replace(/Æ/g,'Ae').replace(/ß/g,'ss')
          .toLowerCase().replace(/[^a-z ]/g, '').trim();
        const espnTTMap = {};
        espn.teeTimes.forEach(({ name, teeTime }) => { espnTTMap[normalize(name)] = teeTime; });
        result.teeTimes = result.players
          .filter(n => espnTTMap[normalize(n)])
          .map(n => ({ name: n, teeTime: espnTTMap[normalize(n)] }));
      }
    } catch (_) { /* tee time supplement failed — not critical */ }
  }

  if (!result?.players?.length) {
    return res.status(503).json({ error: 'All field sources failed', details: errors });
  }

  if (isDebug) {
    return res.status(200).json({
      source: result.source,
      tournament: result.tournament,
      playerCount: result.players.length,
      teeTimeCount: result.teeTimes?.length || 0,
      samplePlayers: result.players.slice(0, 10),
      errors,
    });
  }

  return res.status(200).json({
    players: result.players,
    teeTimes: result.teeTimes || [],
    odds: result.odds || [],
    tournament: result.tournament,
    count: result.players.length,
    source: result.source,
  });
}
