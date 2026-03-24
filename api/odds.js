// api/odds.js — Vercel serverless function
// Returns tournament winner odds from DraftKings via The Odds API.
// Only fetches Mon 12am ET through Thu 12pm ET to conserve free tier quota (500/month).
//
// GET /api/odds → { odds: { "Scottie Scheffler": "+350", ... }, tournament, cached }

const API_KEY   = '5cbe0a4ee51da3443fad2aed008113dd';
const ODDS_URL  = 'https://api.the-odds-api.com/v4/sports/golf_pga/odds/';

function getNowET() {
  const now = new Date();
  return new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

function isWithinOddsWindow() {
  const et = getNowET();
  const day = et.getDay(); // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu
  const hour = et.getHours();
  // Mon 12am through Thu 12pm ET
  if (day === 1 || day === 2 || day === 3) return true;
  if (day === 4 && hour < 12) return true;
  return false;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  // 1 hour cache — odds don't change that fast, conserves API quota
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const isDebug = req.query.debug === '1';

  // Outside the Mon–Thu window: return empty rather than waste quota
  if (!isWithinOddsWindow() && !isDebug) {
    return res.status(200).json({ odds: {}, tournament: null, reason: 'outside-window' });
  }

  try {
    const url = new URL(ODDS_URL);
    url.searchParams.set('apiKey', API_KEY);
    url.searchParams.set('regions', 'us');
    url.searchParams.set('markets', 'outrights');
    url.searchParams.set('oddsFormat', 'american');
    url.searchParams.set('bookmakers', 'draftkings');

    const resp = await fetch(url.toString());

    if (isDebug) {
      const remaining = resp.headers.get('x-requests-remaining');
      const used = resp.headers.get('x-requests-used');
      if (!resp.ok) {
        return res.status(200).json({ error: `Odds API ${resp.status}`, remaining, used });
      }
      const data = await resp.json();
      return res.status(200).json({
        eventCount: data.length,
        remaining,
        used,
        firstEvent: data[0] ? {
          id: data[0].id,
          sport: data[0].sport_key,
          name: data[0].home_team || data[0].sport_title,
          bookmakerCount: data[0].bookmakers?.length,
          sampleOutcomes: data[0].bookmakers?.[0]?.markets?.[0]?.outcomes?.slice(0, 5),
        } : null,
      });
    }

    if (!resp.ok) {
      return res.status(502).json({ error: `Odds API returned ${resp.status}` });
    }

    const data = await resp.json();

    if (!data.length) {
      return res.status(200).json({ odds: {}, tournament: null });
    }

    // Golf outrights — there's typically one event (the current week's tournament)
    const event = data[0];
    const tournament = event.sport_title || 'PGA Tour';
    const bookmaker = event.bookmakers?.find(b => b.key === 'draftkings') || event.bookmakers?.[0];
    const outcomes = bookmaker?.markets?.[0]?.outcomes || [];

    // Build { playerName: "+2000" } map
    const odds = {};
    outcomes.forEach(({ name, price }) => {
      if (name && price !== undefined) {
        odds[name] = price > 0 ? `+${price}` : `${price}`;
      }
    });

    return res.status(200).json({
      odds,
      tournament,
      count: Object.keys(odds).length,
      bookmaker: bookmaker?.title || 'DraftKings',
      requestsRemaining: resp.headers.get('x-requests-remaining'),
    });

  } catch (err) {
    return res.status(503).json({ error: err.message });
  }
}
