// api/field.js — Vercel serverless function
// Single hub for all PGA Tour tournament data this week.
// Fetches field page → extracts players, player IDs, tee times, and odds in one pass.
//
// GET /api/field          → { players, playerIds, teeTimes, odds, tournament, count, source }
// GET /api/field?debug=1  → diagnostic info

const HEADERS = {
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

function walkAll(obj, fn) {
  if (!obj || typeof obj !== 'object') return;
  fn(obj);
  (Array.isArray(obj) ? obj : Object.values(obj)).forEach(v => walkAll(v, fn));
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

// ── Known name aliases — maps API name variants to canonical names ──────────────
// Add entries here when PGA Tour uses a different name than our Firebase records
const NAME_ALIASES = {
  'Nico Echavarria':    'Nicolas Echavarria',
  'Rafa Cabrera Bello': 'Rafael Cabrera Bello',
  'Si Woo Kim':         'Si-Woo Kim',
  'Byeong-Hun An':      'Byeong Hun An',
  'K.H. Lee':           'Kyoung-Hoon Lee',
  'S.H. Kim':           'Sung-Hyun Kim',
};
function canonicalName(name) {
  return NAME_ALIASES[name?.trim()] || name?.trim();
}

// ── Get upcoming tournament from schedule ─────────────────────────────────────
async function getUpcomingTournament() {
  const resp = await fetch('https://www.pgatour.com/schedule', { headers: HEADERS });
  if (!resp.ok) throw new Error(`Schedule ${resp.status}`);
  const nd = extractNextData(await resp.text());
  if (!nd) throw new Error('No __NEXT_DATA__ on schedule');

  const queries = nd?.props?.pageProps?.dehydratedState?.queries || [];
  let tournaments = [];
  for (const q of queries) {
    if (q?.state?.data?.tournaments) tournaments = tournaments.concat(q.state.data.tournaments);
  }
  const seen = new Set();
  const unique = tournaments.filter(t => { if (seen.has(t.tournamentId)) return false; seen.add(t.tournamentId); return true; });
  const DONE = ['COMPLETED', 'OFFICIAL', 'PAST', 'CANCELLED'];
  const t = unique.find(t => t.status === 'IN_PROGRESS')
    || unique.find(t => t.status === 'UPCOMING')
    || unique.find(t => !DONE.includes(t.status?.toUpperCase()));
  if (!t) throw new Error('No upcoming tournament');
  return t;
}

// ── Parse field page — players, IDs, tee times, odds all in one pass ──────────
function parseFieldPage(nd) {
  const playerNames = new Set();
  const playerIdMap = {};   // name → pga tour id
  const teeTimeMap  = {};   // name → "8:24 AM"
  const oddsMap     = {};   // name → "+700"

  walkAll(nd, obj => {
    // Player with id + name
    const name = obj.displayName?.trim()
      || (obj.firstName && obj.lastName ? `${obj.firstName.trim()} ${obj.lastName.trim()}` : null);

    if (name?.includes(' ')) {
      playerNames.add(canonicalName(name) || name);
      // Store player ID (field page uses 'id')
      if (obj.id) playerIdMap[canonicalName(name) || name] = String(obj.id);
      // Capture photo URL if present directly on player object
      const photo = obj.photo || obj.headshot || obj.photoUrl || obj.imageUrl || obj.headShotUrl || obj.headshotUrl;
      if (photo && typeof photo === 'string' && photo.startsWith('http')) {
        playerIdMap[`__photo_${canonicalName(name) || name}`] = photo;
      }
      // Individual tee time on player object
      const tt = obj.teeTime || obj.teeTimeLocal || obj.startTime;
      if (tt && typeof tt === 'string') {
        const formatted = formatTeeTime(tt);
        if (formatted) teeTimeMap[name] = formatted;
      }
    }

    // Tee time group: { teeTime, players: [...] }
    if ((obj.teeTime || obj.startTime) && Array.isArray(obj.players) && obj.players.length) {
      const tt = formatTeeTime(obj.teeTime || obj.startTime);
      if (tt) {
        obj.players.forEach(p => {
          const pn = p.displayName?.trim()
            || (p.firstName && p.lastName ? `${p.firstName.trim()} ${p.lastName.trim()}` : null);
          if (pn) {
            teeTimeMap[pn] = tt;
            if (p.id) playerIdMap[pn] = String(p.id);
          }
        });
      }
    }

    // Odds object: { oddsToWinId, players: [{ id, odds }] }
    if (obj.oddsToWinId && Array.isArray(obj.players) && obj.players.length) {
      obj.players.forEach(p => {
        // Resolve name via playerIdMap (built above) or direct name fields
        const pn = p.displayName?.trim() || p.playerName?.trim();
        const raw = p.odds ?? p.currentOdds ?? p.americanOdds;
        if (raw != null) {
          const nameToUse = pn || Object.keys(playerIdMap).find(n => playerIdMap[n] === String(p.playerId || p.id));
          if (nameToUse) {
            if (typeof raw === 'string' && (raw.startsWith('+') || raw.startsWith('-'))) {
              oddsMap[nameToUse] = raw;
            } else {
              const n = parseInt(raw, 10);
              if (!isNaN(n)) oddsMap[nameToUse] = n > 0 ? `+${n}` : `${n}`;
            }
          }
        }
      });
    }
  });

  // Deduplicate "Last, First" vs "First Last"
  const allNames = [...playerNames];
  const players = allNames.filter(name => {
    if (!name.includes(',')) return true;
    const [last, first] = name.split(',').map(s => s.trim());
    return first ? !playerNames.has(`${first} ${last}`) : true;
  });

  return { players, playerIdMap, teeTimeMap, oddsMap };
}

// ── ESPN fallback for field + tee times ───────────────────────────────────────
async function fetchFromESPN() {
  for (let offset = 0; offset <= 14; offset++) {
    const d = new Date(); d.setDate(d.getDate() + offset);
    const ds = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard?dates=${ds}`, { headers: { 'User-Agent': HEADERS['User-Agent'], 'Accept': 'application/json' } });
    if (!r.ok) continue;
    const data = await r.json();
    const pga = (data?.events || []).filter(e => e.status?.type?.state !== 'post');
    if (!pga.length) continue;
    const event = pga.find(e => e.status?.type?.state === 'pre') || pga[0];

    const r2 = await fetch(`https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?event=${event.id}`, { headers: { 'User-Agent': HEADERS['User-Agent'], 'Accept': 'application/json' } });
    if (!r2.ok) continue;
    const ld = await r2.json();
    const competitors = ld?.events?.[0]?.competitions?.[0]?.competitors || [];
    if (!competitors.length) continue;

    const players = [];
    const teeTimes = [];
    const playerIdMap = {};

    competitors.forEach(c => {
      const name = c.athlete?.displayName || c.athlete?.fullName || '';
      if (!name) return;
      players.push(name);
      // ESPN athlete ID doubles as the headshot ID
      if (c.athlete?.id) playerIdMap[name] = String(c.athlete.id);
      const ttRaw = c.teeTime || c.status?.teeTime || c.startTime;
      if (ttRaw) {
        const tt = formatTeeTime(ttRaw);
        if (tt) teeTimes.push({ name, teeTime: tt });
      }
    });

    if (players.length) return { players, playerIdMap, teeTimes, oddsMap: {}, tournament: event.name, source: 'espn' };
  }
  throw new Error('No field found via ESPN');
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const isDebug = req.query.debug === '1';
  const year = new Date().getFullYear().toString();
  const errors = [];

  let result = null;

  // ── Source 1: PGA Tour schedule + field page ────────────────────────────────
  try {
    const tournament = await getUpcomingTournament();
    const slug = nameToSlug(tournament.name);
    const fieldUrl = `https://www.pgatour.com/tournaments/${year}/${slug}/${tournament.tournamentId}/field`;
    const fieldResp = await fetch(fieldUrl, { headers: HEADERS });

    if (fieldResp.ok) {
      const fieldNd = extractNextData(await fieldResp.text());
      if (fieldNd) {
        const { players, playerIdMap, teeTimeMap, oddsMap } = parseFieldPage(fieldNd);

        // If no tee times from field page, try dedicated tee-times page
        let finalTeeTimes = players.filter(n => teeTimeMap[n]).map(n => ({ name: n, teeTime: teeTimeMap[n] }));
        if (!finalTeeTimes.length && players.length) {
          try {
            const ttResp = await fetch(`https://www.pgatour.com/tournaments/${year}/${slug}/${tournament.tournamentId}/tee-times`, { headers: HEADERS });
            if (ttResp.ok) {
              const ttNd = extractNextData(await ttResp.text());
              if (ttNd) {
                const { teeTimeMap: ttMap2, playerIdMap: pidMap2 } = parseFieldPage(ttNd);
                finalTeeTimes = players.filter(n => ttMap2[n]).map(n => ({ name: n, teeTime: ttMap2[n] }));
                // Merge any new IDs from tee-times page
                Object.assign(playerIdMap, pidMap2);
              }
            }
          } catch (_) {}
        }

        // If still no tee times, supplement from ESPN
        if (!finalTeeTimes.length && players.length) {
          try {
            const espn = await fetchFromESPN();
            if (espn.teeTimes?.length) {
              const normalize = s => s.toLowerCase().replace(/[^a-z ]/g, '').trim();
              const espnMap = {};
              espn.teeTimes.forEach(({ name, teeTime }) => { espnMap[normalize(name)] = teeTime; });
              // Also grab ESPN IDs for players we don't have IDs for
              Object.entries(espn.playerIdMap).forEach(([name, id]) => {
                if (!playerIdMap[name]) playerIdMap[name] = id;
              });
              finalTeeTimes = players
                .filter(n => espnMap[normalize(n)])
                .map(n => ({ name: n, teeTime: espnMap[normalize(n)] }));
            }
          } catch (_) {}
        }

        // Fetch odds from odds page if not already embedded in field page
        let finalOdds = Object.entries(oddsMap).map(([name, odds]) => ({ name, odds }));
        if (!finalOdds.length) {
          try {
            const oddsResp = await fetch(`https://www.pgatour.com/tournaments/${year}/${slug}/${tournament.tournamentId}/odds`, { headers: HEADERS });
            if (oddsResp.ok) {
              const oddsNd = extractNextData(await oddsResp.text());
              if (oddsNd) {
                let oddsObj = null;
                walkAll(oddsNd, obj => {
                  if (obj.oddsToWinId && Array.isArray(obj.players) && obj.players.length) {
                    if (!oddsObj || obj.oddsEnabled) oddsObj = obj;
                  }
                });
                if (oddsObj) {
                  oddsObj.players.forEach(p => {
                    const name = Object.keys(playerIdMap).find(n => playerIdMap[n] === String(p.playerId));
                    const raw = p.odds ?? p.currentOdds;
                    if (name && raw != null) {
                      if (typeof raw === 'string' && (raw.startsWith('+') || raw.startsWith('-'))) {
                        finalOdds.push({ name, odds: raw });
                      } else {
                        const n = parseInt(raw, 10);
                        if (!isNaN(n)) finalOdds.push({ name, odds: n > 0 ? `+${n}` : `${n}` });
                      }
                    }
                  });
                }
              }
            }
          } catch (_) {}
        }

        if (players.length) {
          result = {
            players,
            playerIds: playerIdMap,
            teeTimes: finalTeeTimes,
            odds: finalOdds,
            tournament: tournament.name,
            source: 'pgatour',
          };
        }
      }
    }
  } catch (e) { errors.push(`pgatour: ${e.message}`); }

  // ── Source 2: ESPN fallback ─────────────────────────────────────────────────
  if (!result?.players?.length) {
    try {
      const espn = await fetchFromESPN();
      result = { ...espn, odds: [] };
    } catch (e) { errors.push(`espn: ${e.message}`); }
  }

  if (!result?.players?.length) {
    return res.status(503).json({ error: 'All sources failed', details: errors });
  }

  if (isDebug) {
    const photoEntries = Object.entries(result.playerIds || {}).filter(([k]) => k.startsWith('__photo_'));
    return res.status(200).json({
      source: result.source,
      tournament: result.tournament,
      playerCount: result.players.length,
      teeTimeCount: result.teeTimes?.length || 0,
      oddsCount: result.odds?.length || 0,
      playerIdCount: Object.keys(result.playerIds || {}).filter(k => !k.startsWith('__photo_')).length,
      photoUrlCount: photoEntries.length,
      samplePlayers: result.players.slice(0, 5),
      sampleTeeTimes: result.teeTimes?.slice(0, 3),
      sampleOdds: result.odds?.slice(0, 3),
      sampleIds: Object.entries(result.playerIds || {}).filter(([k]) => !k.startsWith('__photo_')).slice(0, 5),
      samplePhotos: photoEntries.slice(0, 3),
      errors,
    });
  }

  return res.status(200).json({
    players: result.players,
    playerIds: result.playerIds || {},
    teeTimes: result.teeTimes || [],
    odds: result.odds || [],
    tournament: result.tournament,
    count: result.players.length,
    source: result.source,
  });
}
