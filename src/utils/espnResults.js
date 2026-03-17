/**
 * espnResults.js
 * ============================================================================
 * Fetches completed tournament earnings and round leaders from ESPN.
 *
 * Uses a SINGLE fetch to the ESPN scoreboard endpoint, which is CORS-safe.
 * The scoreboard returns full competitor data (scores, stats, status) for
 * recent/current events. For completed events that have aged off the default
 * scoreboard, we try the calendar year endpoint.
 *
 * NO secondary fetch to site.web.api.espn.com or summary endpoints —
 * those are not reliably CORS-accessible from the browser.
 *
 * Returns:
 *   {
 *     earningsMap:    { [playerName]: earnings }
 *                     ALL starters. Made-cut: earnings > 0. Missed-cut: earnings = 0.
 *     roundLeaders:   { round1: [name], round2: [name], round3: [name] }
 *     playerCount, madeCutCount, missedCutCount, eventName, espnEventId
 *   }
 * ============================================================================
 */

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard';

// ── Name normalisation ────────────────────────────────────────────────────────
const normName = (s) =>
  (s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const normTournName = (s) =>
  normName(s)
    .replace(/\b(the|championship|open|invitational|classic|tournament|pro|am|presented|by|at|of|golf)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// ── Extract competitors from an ESPN event object ─────────────────────────────
function extractCompetitors(event) {
  return event?.competitions?.[0]?.competitors || [];
}

// ── Find matching event + return its competitor list ─────────────────────────
function findEventInList(events, target) {
  let match = events.find(e => normTournName(e.name) === target);
  if (!match) {
    match = events.find(e => {
      const en = normTournName(e.name);
      return en.includes(target) || target.includes(en);
    });
  }
  return match || null;
}

// ── Round score helpers ───────────────────────────────────────────────────────
function getRoundScores(competitor) {
  return (competitor.linescores || []).map(ls => {
    const val = ls.value ?? ls.score ?? ls.displayValue;
    if (val === undefined || val === null || val === '--' || val === '') return null;
    const n = parseInt(val, 10);
    return isNaN(n) ? null : n;
  });
}

function getLeadersAfterRound(competitors, roundIndex) {
  const scores = competitors
    .map(c => {
      const rounds = getRoundScores(c);
      if (rounds.length < roundIndex) return null;
      let total = 0;
      for (let i = 0; i < roundIndex; i++) {
        if (rounds[i] === null) return null;
        total += rounds[i];
      }
      return { name: c.athlete?.displayName || c.displayName || '', score: total };
    })
    .filter(Boolean);

  if (scores.length === 0) return [];
  const best = Math.min(...scores.map(s => s.score));
  return scores.filter(s => s.score === best).map(s => s.name);
}

// ── Earnings extraction ───────────────────────────────────────────────────────
function extractEarnings(competitor) {
  if (competitor.earnings !== undefined && competitor.earnings !== null) {
    const n = parseInt(competitor.earnings, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  if (Array.isArray(competitor.statistics)) {
    const earnStat = competitor.statistics.find(s =>
      (s.name || '').toLowerCase().includes('earn') ||
      (s.abbreviation || '').toLowerCase().includes('earn')
    );
    if (earnStat) {
      const n = parseInt((earnStat.displayValue || '').replace(/[^0-9]/g, ''), 10);
      if (!isNaN(n) && n > 0) return n;
    }
    for (const stat of competitor.statistics) {
      const raw = (stat.displayValue || '').replace(/[$,]/g, '');
      const n   = parseInt(raw, 10);
      if (!isNaN(n) && n >= 10000) return n;
    }
  }
  return 0;
}

function didNotFinish(competitor) {
  const s = (
    competitor.status?.type?.name ||
    competitor.status?.type?.description ||
    competitor.status?.name ||
    competitor.statusName || ''
  ).toLowerCase();
  return s.includes('cut') || s.includes('wd') || s.includes('withdraw') ||
         s.includes('dq')  || s.includes('disqualif');
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function fetchESPNResults(tournamentName) {
  const target = normTournName(tournamentName);

  let eventName    = '';
  let espnEventId  = '';
  let competitors  = [];

  // ── Attempt 1: current scoreboard (recent/in-progress events, full data) ──
  const sbResp = await fetch(SCOREBOARD);
  if (!sbResp.ok) throw new Error(`ESPN fetch failed: ${sbResp.status}`);
  const sbData = await sbResp.json();

  const sbMatch = findEventInList(sbData.events || [], target);
  if (sbMatch) {
    eventName   = sbMatch.name;
    espnEventId = sbMatch.id;
    competitors = extractCompetitors(sbMatch);
    console.log(`[ESPN] Found "${eventName}" on current scoreboard. Competitors: ${competitors.length}`);
  }

  // ── Attempt 2: calendar year scoreboard ───────────────────────────────────
  // The current scoreboard only shows a rolling window of recent events.
  // For events a few weeks old, try the full calendar year endpoint.
  if (competitors.length === 0) {
    const year    = new Date().getFullYear();
    const calResp = await fetch(`${SCOREBOARD}?dates=${year}`);
    if (!calResp.ok) throw new Error(`ESPN calendar fetch failed: ${calResp.status}`);
    const calData = await calResp.json();

    const calMatch = findEventInList(calData.events || [], target);
    if (calMatch) {
      eventName   = calMatch.name;
      espnEventId = calMatch.id;
      competitors = extractCompetitors(calMatch);
      console.log(`[ESPN] Found "${eventName}" on year calendar. Competitors: ${competitors.length}`);
    }
  }

  // ── Attempt 3: try a few recent weeks of the calendar ─────────────────────
  // ?dates=YYYYMMDD on the scoreboard returns events for that week.
  // Walk back up to 8 weeks to find the event if it's not on the year view.
  if (competitors.length === 0 && !espnEventId) {
    const now = new Date();
    for (let weeksBack = 0; weeksBack <= 8; weeksBack++) {
      const d = new Date(now);
      d.setDate(d.getDate() - weeksBack * 7);
      const dateStr = d.toISOString().slice(0, 10).replace(/-/g, '');
      const wResp   = await fetch(`${SCOREBOARD}?dates=${dateStr}`);
      if (!wResp.ok) continue;
      const wData   = await wResp.json();
      const wMatch  = findEventInList(wData.events || [], target);
      if (wMatch) {
        eventName   = wMatch.name;
        espnEventId = wMatch.id;
        competitors = extractCompetitors(wMatch);
        console.log(`[ESPN] Found "${eventName}" at week -${weeksBack}. Competitors: ${competitors.length}`);
        break;
      }
    }
  }

  if (!espnEventId) {
    throw new Error(
      `Could not find "${tournamentName}" on ESPN. ` +
      `The tournament may not be available yet.`
    );
  }

  if (competitors.length === 0) {
    // Log what we got to help debug
    console.warn('[ESPN] Event found but no competitors in scoreboard response. Event ID:', espnEventId);
    throw new Error(
      `ESPN found the event but returned no player data. ` +
      `The event may not have started or results may not be posted yet.`
    );
  }

  // ── Build earningsMap ─────────────────────────────────────────────────────
  const earningsMap  = {};
  let   missedCutCount = 0;

  competitors.forEach(c => {
    const name = c.athlete?.displayName || c.displayName;
    if (!name) return;
    if (didNotFinish(c)) {
      earningsMap[name] = 0;
      missedCutCount++;
    } else {
      earningsMap[name] = extractEarnings(c);
    }
  });

  const madeCutCount = Object.values(earningsMap).filter(e => e > 0).length;
  if (madeCutCount === 0 && competitors.length > 0) {
    throw new Error(
      'ESPN has player data but no earnings yet. ' +
      'The event may still be in progress or prize money may not be posted. ' +
      'Try again after the tournament concludes.'
    );
  }

  // ── Round leaders ─────────────────────────────────────────────────────────
  const roundLeaders = {
    round1: getLeadersAfterRound(competitors, 1),
    round2: getLeadersAfterRound(competitors, 2),
    round3: getLeadersAfterRound(competitors, 3),
  };

  return {
    earningsMap,
    roundLeaders,
    playerCount:    Object.keys(earningsMap).length,
    madeCutCount,
    missedCutCount,
    eventName,
    espnEventId,
  };
}
