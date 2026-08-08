// api/field.js — Vercel serverless function
// Single hub for all PGA Tour tournament data this week.
// Fetches field page → extracts players, player IDs, tee times, and odds in one pass.
//
// GET /api/field          → { players, pgaIds, espnIds, photos, teeTimes, odds, tournament, count, source }
// GET /api/field?debug=1  → diagnostic info

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

import { extractNextData, nameToSlug } from './_constants.js';
import { NameMap, NameSet, resolveAlias } from './_playerNames.js';

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

// Pick the right tee time per player when the PGA Tour field page contains
// data for multiple rounds (R1, R2, R3, R4) inside the same __NEXT_DATA__.
//
// Before this helper existed the parser used naive last-write-wins on
// teeTimeMap[name] = ..., which meant whichever round happened to be
// traversed last in __NEXT_DATA__ won — typically R2 — so during R1 the
// roster page showed afternoon-wave players with their *Friday* (R2)
// tee times instead of their Thursday afternoon ones.
//
// Rule used here:
//   • Prefer the earliest upcoming tee time (≥ now). This gives the
//     correct "next tee" for any player who hasn't started their next
//     round yet, regardless of which round we're in.
//   • If no upcoming time exists (player has played all stored rounds),
//     fall back to the latest past time so something still renders.
//
// `teeTimeMap[name]`     — the human-formatted "8:24 AM" string we serve.
// `teeTimeISOMap[name]`  — the underlying ISO string, used here for cmp.
function makeTeeTimeRecorder(teeTimeMap, teeTimeISOMap) {
  const nowMs = Date.now();
  return function setTeeTime(name, iso) {
    if (!name || !iso || typeof iso !== 'string') return;
    const newMs = new Date(iso).getTime();
    if (isNaN(newMs)) return;
    const existingIso = teeTimeISOMap[name];
    if (!existingIso) {
      teeTimeISOMap[name] = iso;
      teeTimeMap[name] = formatTeeTime(iso);
      return;
    }
    const existingMs = new Date(existingIso).getTime();
    const newIsFuture = newMs >= nowMs;
    const existingIsFuture = existingMs >= nowMs;
    let shouldReplace = false;
    if (newIsFuture && !existingIsFuture) {
      shouldReplace = true;                       // future beats past
    } else if (newIsFuture && existingIsFuture) {
      shouldReplace = newMs < existingMs;         // earliest upcoming wins
    } else if (!newIsFuture && !existingIsFuture) {
      shouldReplace = newMs > existingMs;         // most recent past wins
    }
    if (shouldReplace) {
      teeTimeISOMap[name] = iso;
      teeTimeMap[name] = formatTeeTime(iso);
    }
  };
}

// ── Name identity ─────────────────────────────────────────────────────────
//
// This file used to carry its OWN copy of the alias table and its OWN
// normalizer (normName), under a "⚠ KEEP IN SYNC with src/constants/
// nameAliases.js" comment. The two drifted, as duplicated tables do: this copy
// stripped combining marks but not ø/æ, while the client's copy stripped ø/æ
// but never lowercased.
//
// Worse, the alias table was applied HERE — rewriting the tour's name to the
// SFGL canonical spelling — and the client then compared the result to roster
// names RAW. So the rewrite only helped when the roster already held the
// canonical spelling. When a roster held 'Nico Echavarria' and this endpoint
// emitted 'Nicolas Echavarria', that player silently vanished from the ⛳ flag,
// the "Playing" filter, tee times, odds and live scores.
//
// Both copies are gone. api/_playerNames.js is imported directly by this
// serverless function AND by the browser bundle, and matching is by
// equivalence class on both sides, so it no longer matters which spelling a
// given source uses.
//
// canonicalName() survives only to give the response ONE spelling per player
// when pgatour.com's own page sections disagree — the id/photo/tee-time maps
// below are keyed by name and need a stable key. It is no longer load-bearing
// for matching.
const canonicalName = (name) => resolveAlias(name);

// Build the tee-time list by player IDENTITY rather than by string key.
// Replaces a two-pass exact-then-normalized lookup that still missed any
// rendering difference the old normalizer did not happen to cover.
function joinPlayersToTeeTimes(players, teeTimeMap) {
  const lookup = new NameMap(Object.entries(teeTimeMap));
  const out = [];
  for (const n of players) {
    const tt = lookup.get(n);
    if (tt) out.push({ name: n, teeTime: tt });
  }
  return out;
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
// IDs are kept in SEPARATE, NAMESPACE-PURE maps. They used to share one
// `playerIdMap` that mixed three different things — PGA TOUR player IDs from
// this parser, ESPN athlete IDs merged in from the ESPN fallback, and direct
// photo URLs under `__photo_`-prefixed keys. Any consumer that treated that
// map as "PGA IDs" could take an ESPN ID and build a PGA Tour CDN URL from it,
// which does not 404 — it can resolve to a DIFFERENT REAL GOLFER's photo.
// Wrong faces are worse than missing ones, so the namespaces stay separate.
function parseFieldPage(nd) {
  const playerNames = new Set();
  const pgaIds      = {};   // name → PGA TOUR player id
  const photos      = {};   // name → direct headshot URL (when the page has one)
  const teeTimeMap  = {};   // name → "8:24 AM"
  const teeTimeISOMap = {}; // name → ISO string (internal — used to compare across rounds)
  const oddsMap     = {};   // name → "+700"

  // See makeTeeTimeRecorder for why this exists (multi-round disambiguation).
  const setTeeTime = makeTeeTimeRecorder(teeTimeMap, teeTimeISOMap);

  walkAll(nd, obj => {
    // Player with id + name
    const name = obj.displayName?.trim()
      || (obj.firstName && obj.lastName ? `${obj.firstName.trim()} ${obj.lastName.trim()}` : null);

    if (name?.includes(' ')) {
      playerNames.add(canonicalName(name) || name);
      // Store player ID (field page uses 'id')
      if (obj.id) pgaIds[canonicalName(name) || name] = String(obj.id);
      // Capture photo URL if present directly on player object
      const photo = obj.photo || obj.headshot || obj.photoUrl || obj.imageUrl || obj.headShotUrl || obj.headshotUrl;
      if (photo && typeof photo === 'string' && photo.startsWith('http')) {
        photos[canonicalName(name) || name] = photo;
      }
      // Individual tee time on player object
      const tt = obj.teeTime || obj.teeTimeLocal || obj.startTime;
      if (tt && typeof tt === 'string') {
        setTeeTime(canonicalName(name) || name, tt);
      }
    }

    // Tee time group: { teeTime, players: [...] }
    if ((obj.teeTime || obj.startTime) && Array.isArray(obj.players) && obj.players.length) {
      const ttIso = obj.teeTime || obj.startTime;
      if (typeof ttIso === 'string') {
        obj.players.forEach(p => {
          const pn = p.displayName?.trim()
            || (p.firstName && p.lastName ? `${p.firstName.trim()} ${p.lastName.trim()}` : null);
          if (pn) {
            setTeeTime(canonicalName(pn) || pn, ttIso);
            if (p.id) pgaIds[canonicalName(pn) || pn] = String(p.id);
          }
        });
      }
    }

    // Odds object: { oddsToWinId, players: [{ id, odds }] }
    if (obj.oddsToWinId && Array.isArray(obj.players) && obj.players.length) {
      obj.players.forEach(p => {
        // Resolve name via pgaIds (built above) or direct name fields
        const pn = p.displayName?.trim() || p.playerName?.trim();
        const raw = p.odds ?? p.currentOdds ?? p.americanOdds;
        if (raw != null) {
          const nameToUse = pn || Object.keys(pgaIds).find(n => pgaIds[n] === String(p.playerId || p.id));
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

  // Deduplicate the same golfer appearing under two renderings. The old
  // version only handled the literal "Last, First" vs "First Last" pair by
  // string-rebuilding the name; NameSet's grouping also collapses hyphen,
  // accent, punctuation and nickname differences between page sections, and
  // prefers the first spelling seen. "First Last" entries are added to the
  // set before comma-form ones below so they win as the representative.
  const ordered = [...playerNames].sort((a, b) => Number(a.includes(',')) - Number(b.includes(',')));
  const players = new NameSet(ordered).groups.map((group) => group[0]);

  return { players, pgaIds, photos, teeTimeMap, oddsMap };
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
    const espnIds = {};

    competitors.forEach(c => {
      const name = c.athlete?.displayName || c.athlete?.fullName || '';
      if (!name) return;
      const canonical = canonicalName(name) || name;
      players.push(canonical);
      // ESPN athlete ID doubles as the headshot ID
      if (c.athlete?.id) espnIds[canonical] = String(c.athlete.id);
      const ttRaw = c.teeTime || c.status?.teeTime || c.startTime;
      if (ttRaw) {
        const tt = formatTeeTime(ttRaw);
        if (tt) teeTimes.push({ name: canonical, teeTime: tt });
      }
    });

    if (players.length) return { players, espnIds, teeTimes, oddsMap: {}, tournament: event.name, source: 'espn' };
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
        const { players, pgaIds, photos, teeTimeMap, oddsMap } = parseFieldPage(fieldNd);
        const espnIds = {}; // filled only from the ESPN supplement below

        // If no tee times from field page, try dedicated tee-times page
        let finalTeeTimes = joinPlayersToTeeTimes(players, teeTimeMap);
        if (!finalTeeTimes.length && players.length) {
          try {
            const ttResp = await fetch(`https://www.pgatour.com/tournaments/${year}/${slug}/${tournament.tournamentId}/tee-times`, { headers: HEADERS });
            if (ttResp.ok) {
              const ttNd = extractNextData(await ttResp.text());
              if (ttNd) {
                const { teeTimeMap: ttMap2, pgaIds: pgaIds2, photos: photos2 } = parseFieldPage(ttNd);
                finalTeeTimes = joinPlayersToTeeTimes(players, ttMap2);
                // Merge any new PGA ids / photos from the tee-times page
                Object.assign(pgaIds, pgaIds2);
                Object.assign(photos, photos2);
              }
            }
          } catch (_) {}
        }

        // If still no tee times, supplement from ESPN
        if (!finalTeeTimes.length && players.length) {
          try {
            const espn = await fetchFromESPN();
            if (espn.teeTimes?.length) {
              // Joining PGA Tour names to ESPN names is the highest-variance
              // match in this file — two independent editorial styles. The
              // previous normalizer here stripped every non-[a-z ] character,
              // which folded accents to NOTHING rather than to their base
              // letter ('Muñoz' → 'muoz'), so accented players lost their tee
              // time on this path. NameMap handles it by identity.
              const espnMap = new NameMap(espn.teeTimes.map(({ name, teeTime }) => [name, teeTime]));
              // ESPN ids go in their OWN map — merging them into pgaIds is
              // what made the combined map unsafe to build PGA URLs from.
              Object.assign(espnIds, espn.espnIds || {});
              finalTeeTimes = players
                .filter(n => espnMap.has(n))
                .map(n => ({ name: n, teeTime: espnMap.get(n) }));
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
                    const name = Object.keys(pgaIds).find(n => pgaIds[n] === String(p.playerId));
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
            pgaIds,
            espnIds,
            photos,
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
      result = { ...espn, pgaIds: {}, photos: {}, odds: [] };
    } catch (e) { errors.push(`espn: ${e.message}`); }
  }

  if (!result?.players?.length) {
    return res.status(503).json({ error: 'All sources failed', details: errors });
  }

  if (isDebug) {
    return res.status(200).json({
      source: result.source,
      tournament: result.tournament,
      playerCount: result.players.length,
      teeTimeCount: result.teeTimes?.length || 0,
      oddsCount: result.odds?.length || 0,
      pgaIdCount: Object.keys(result.pgaIds || {}).length,
      espnIdCount: Object.keys(result.espnIds || {}).length,
      photoUrlCount: Object.keys(result.photos || {}).length,
      samplePlayers: result.players.slice(0, 5),
      sampleTeeTimes: result.teeTimes?.slice(0, 3),
      sampleOdds: result.odds?.slice(0, 3),
      samplePgaIds: Object.entries(result.pgaIds || {}).slice(0, 5),
      sampleEspnIds: Object.entries(result.espnIds || {}).slice(0, 5),
      samplePhotos: Object.entries(result.photos || {}).slice(0, 3),
      errors,
    });
  }

  return res.status(200).json({
    players: result.players,
    // Namespace-pure ID maps. `playerIds` (a single map that mixed PGA ids,
    // ESPN ids and __photo_ URLs) is gone — building a PGA Tour CDN URL from an
    // ESPN id can surface a different real golfer's photo.
    pgaIds:  result.pgaIds  || {},
    espnIds: result.espnIds || {},
    photos:  result.photos  || {},
    teeTimes: result.teeTimes || [],
    odds: result.odds || [],
    tournament: result.tournament,
    count: result.players.length,
    source: result.source,
  });
}
