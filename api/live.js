// api/live.js — pgatour.com/leaderboard → dehydratedState → leaderboard query → players[].scoringData
// Returns: { state, players, tournamentName }
// The tournamentName field is used by RostersView to verify the live data matches
// the app's active tournament (prevents showing wrong scores when commish is behind).

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Referer': 'https://www.pgatour.com/',
};

function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  // Cache for 2 minutes on Vercel CDN during live play
  // Wave 5: cache aligned to the 5-minute client poll interval. With 5 managers
  // polling out-of-sync, the previous 2-minute CDN cache forced a re-fetch from
  // pgatour.com on most polls. 300s matches the poll cadence so most polls
  // serve from the CDN, with a 600s stale-while-revalidate window for safety.
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const resp = await fetch('https://www.pgatour.com/leaderboard', { headers: HEADERS });
    if (!resp.ok) return res.status(502).json({ error: `pgatour.com ${resp.status}` });

    const html = await resp.text();
    const nd   = extractNextData(html);
    if (!nd) return res.status(200).json({ state: 'pre', players: [], tournamentName: '' });

    const queries = nd.props?.pageProps?.dehydratedState?.queries || [];

    // ── Identify PGA Tour vs other tours ──
    // PGA Tour's tourCode is 'R' across their data. Other tours have:
    //   'H' = Korn Ferry, 'S' = Champions, 'P' = LPGA, 'X' = LIV, etc.
    // Some objects use other field names — tour.id, tourId, tour.code — so
    // we check several. Returns true if the tournament looks like PGA Tour
    // OR if we can't tell (fail open rather than skip everything).
    const isPgaTourTournament = (t) => {
      if (!t || typeof t !== 'object') return true;
      const code = t.tourCode || t.tour?.code || t.tour?.id || t.tourId || '';
      const name = String(t.tour?.name || t.tourName || '').toLowerCase();
      // Explicit non-PGA Tour signals
      if (code === 'H' || code === 'S' || code === 'P' || code === 'X' || code === 'M') return false;
      if (name.includes('korn') || name.includes('champion') || name.includes('lpga') || name.includes('liv')) return false;
      // Explicit PGA Tour signal — preferred
      if (code === 'R') return true;
      if (name.includes('pga tour')) return true;
      // Unknown → assume PGA Tour (we're on pgatour.com)
      return true;
    };

    // ── Extract tournament name + ID from the "tournaments" query ──
    // CRITICAL: filter to PGA Tour events only. Without this, when both
    // PGA Championship and a Korn Ferry event run the same week, we'd
    // pick whichever came first in the array (recently: Colonial Life
    // Charity Classic, a Korn Ferry event).
    let tournamentName = '';
    let tournamentId = '';
    let currentStatus = '';
    let pgaTourns = [];
    const tournamentsQuery = queries.find(q =>
      Array.isArray(q.queryKey) && q.queryKey[0] === 'tournaments'
    );
    if (tournamentsQuery?.state?.data) {
      const allTourns = Array.isArray(tournamentsQuery.state.data)
        ? tournamentsQuery.state.data
        : Object.values(tournamentsQuery.state.data);
      pgaTourns = allTourns.filter(isPgaTourTournament);
      // Prefer IN_PROGRESS, then NOT_STARTED, then any PGA Tour event.
      const current = pgaTourns.find(t => t.tournamentStatus === 'IN_PROGRESS')
        || pgaTourns.find(t => t.tournamentStatus === 'NOT_STARTED')
        || pgaTourns[0];
      tournamentName = current?.tournamentName || '';
      tournamentId = current?.id || current?.tournamentId || '';
      currentStatus = current?.tournamentStatus || '';
    }
    // Fallback: check the single "tournament" query
    if (!tournamentName) {
      const tournQuery = queries.find(q =>
        Array.isArray(q.queryKey) && q.queryKey[0] === 'tournament'
      );
      const td = tournQuery?.state?.data;
      if (td && isPgaTourTournament(td)) {
        tournamentName = td.tournamentName || '';
        tournamentId = td.id || td.tournamentId || '';
      }
    }
    // Fallback: pageProps.tournament
    if (!tournamentName) {
      const tp = nd.props?.pageProps?.tournament;
      if (tp && isPgaTourTournament(tp)) {
        tournamentName = tp.tournamentName || '';
        tournamentId = tp.id || tp.tournamentId || '';
      }
    }

    // ── Extract leaderboard players ──
    // If multiple leaderboard queries exist (one per tour), find the one
    // matching our chosen PGA Tour tournament's ID. The queryKey usually
    // shapes like ['leaderboard', { tournamentId: 'R2026XXX' }] or similar.
    const lbQueries = queries.filter(q =>
      Array.isArray(q.queryKey) && q.queryKey[0] === 'leaderboard'
    );
    let lbQuery = null;
    if (tournamentId && lbQueries.length > 1) {
      // Try to find the leaderboard tied to our tournament's ID. Inspect
      // both the queryKey shape (object-form) and the data itself.
      lbQuery = lbQueries.find(q => {
        const key = q.queryKey[1];
        if (key && typeof key === 'object') {
          return key.tournamentId === tournamentId || key.id === tournamentId;
        }
        return q.state?.data?.tournamentId === tournamentId
          || q.state?.data?.id === tournamentId;
      });
    }
    if (!lbQuery) lbQuery = lbQueries[0];
    const lbData = lbQuery?.state?.data;

    if (!lbData?.players?.length) {
      return res.status(200).json({ state: 'pre', players: [], tournamentName });
    }

    const players = lbData.players.map(row => {
      const name = row.player?.displayName;
      if (!name) return null;

      const sd = row.scoringData || {};

      // Score: sd.total is "-5", "+2", "E", "0"
      const totalRaw = sd.total ?? '0';
      const totalScore = parseInt(totalRaw, 10) || 0;
      const score = totalScore < 0 ? `${totalScore}` : totalScore > 0 ? `+${totalScore}` : 'E';

      // Position: sd.position is "T1", "1", "CUT" etc
      const position = sd.position || '';

      // Thru: "F*" or "F" = finished, "9" = thru 9, "-" or "" = not started
      const thruRaw = (sd.thru || '').replace('*', '').trim();
      const playerState = (sd.playerState || '').toUpperCase();
      let thru = '';
      if (playerState === 'COMPLETE' || thruRaw === 'F') {
        thru = 'F';
      } else if (thruRaw && thruRaw !== '-') {
        // Could be a hole number OR a tee time ("1:30 PM")
        const n = parseInt(thruRaw, 10);
        if (/^\d+$/.test(thruRaw) && !isNaN(n)) {
          thru = n.toString();
        } else {
          // Tee time — pass through as-is
          thru = thruRaw;
        }
      }

      const isCut = playerState === 'CUT' || position === 'CUT';
      const isWD  = playerState === 'WD'  || position === 'WD';

      return { name, score, totalScore, position, thru, isCut, isWD };
    }).filter(Boolean);

    const anyStarted = players.some(p =>
      p.thru === 'F' || /^\d+$/.test(p.thru) || p.isCut || p.isWD
    );
    const state = anyStarted ? 'in' : 'pre';

    // Stale-leaderboard resolution: between events (e.g. Sun night → Wed of
    // the next tournament week) pgatour.com still serves the just-completed
    // event's board while the "tournaments" query already lists the upcoming
    // NOT_STARTED event — which is the name we resolved above. If the named
    // event hasn't started but the board shows finished/in-progress play, the
    // players and the name describe DIFFERENT events.
    //
    // The board is still valuable in this window: if the commish hasn't
    // processed results yet, the app's active tournament is the COMPLETED
    // event and managers want to keep seeing final positions. So instead of
    // blanking, identify the completed event the board belongs to and return
    // the players labeled with THAT event's name and state 'post'. Clients
    // fuzzy-match tournamentName against their active tournament, so:
    //   • Results not yet processed (active = completed event) → names match,
    //     final positions keep rendering with a "Final" treatment.
    //   • Results processed / app moved on (active = upcoming event) → names
    //     mismatch, clients discard the data — same safety as before. Last
    //     week's positions are never pinned onto this week's field because
    //     the name we send is the completed event's, not the upcoming one's.
    if (currentStatus === 'NOT_STARTED' && anyStarted) {
      const isDone = (s) => !!s && s !== 'IN_PROGRESS' && s !== 'NOT_STARTED';
      // Prefer tying the board to its own tournament via the leaderboard
      // query key / data id; fall back to any completed PGA Tour event in
      // the tournaments list (the page only carries current-week-adjacent
      // events, so this is unambiguous in practice).
      const lbKey = lbQuery?.queryKey?.[1];
      const lbTournId = (lbKey && typeof lbKey === 'object')
        ? (lbKey.tournamentId || lbKey.id || '')
        : (lbData.tournamentId || lbData.id || '');
      const boardTourn =
        (lbTournId && pgaTourns.find(t => (t.id || t.tournamentId) === lbTournId && isDone(t.tournamentStatus)))
        || pgaTourns.find(t => isDone(t.tournamentStatus))
        || null;
      if (boardTourn?.tournamentName) {
        return res.status(200).json({
          state: 'post',
          players,
          tournamentName: boardTourn.tournamentName,
        });
      }
      // Can't identify the completed event — keep the conservative blank.
      return res.status(200).json({ state: 'pre', players: [], tournamentName });
    }

    return res.status(200).json({ state, players, tournamentName });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
