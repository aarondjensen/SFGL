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

    // ── Extract tournament name from the "tournaments" or "tournament" query ──
    let tournamentName = '';
    const tournamentsQuery = queries.find(q =>
      Array.isArray(q.queryKey) && q.queryKey[0] === 'tournaments'
    );
    if (tournamentsQuery?.state?.data) {
      // The tournaments query returns an array; the first one with IN_PROGRESS or NOT_STARTED is current
      const tourns = Array.isArray(tournamentsQuery.state.data)
        ? tournamentsQuery.state.data
        : Object.values(tournamentsQuery.state.data);
      const current = tourns.find(t =>
        t.tournamentStatus === 'IN_PROGRESS' || t.tournamentStatus === 'NOT_STARTED'
      ) || tourns[0];
      tournamentName = current?.tournamentName || '';
    }
    // Fallback: check the single "tournament" query
    if (!tournamentName) {
      const tournQuery = queries.find(q =>
        Array.isArray(q.queryKey) && q.queryKey[0] === 'tournament'
      );
      tournamentName = tournQuery?.state?.data?.tournamentName || '';
    }
    // Fallback: pageProps.tournament
    if (!tournamentName) {
      tournamentName = nd.props?.pageProps?.tournament?.tournamentName || '';
    }

    // ── Extract leaderboard players ──
    const lbQuery = queries.find(q =>
      Array.isArray(q.queryKey) && q.queryKey[0] === 'leaderboard'
    );
    const lbData  = lbQuery?.state?.data;

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

    return res.status(200).json({ state, players, tournamentName });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
