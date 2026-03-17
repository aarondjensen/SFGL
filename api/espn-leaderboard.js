/**
 * api/espn-leaderboard.js
 * Vercel serverless function — proxies ESPN leaderboard requests server-side,
 * bypassing CORS restrictions that block direct browser fetches.
 *
 * Usage from the browser:
 *   GET /api/espn-leaderboard?tournamentId=401811937
 *   GET /api/espn-leaderboard?scoreboard=1
 *   GET /api/espn-leaderboard?scoreboard=1&dates=2026
 */

export default async function handler(req, res) {
  // Allow requests from your app
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { tournamentId, scoreboard, dates } = req.query;

  let espnUrl;

  if (tournamentId) {
    // Full leaderboard for a specific completed tournament
    espnUrl = `https://site.web.api.espn.com/apis/v2/sports/golf/pga/leaderboard?event=${tournamentId}`;
  } else if (scoreboard) {
    // Current scoreboard (for event ID lookup)
    espnUrl = dates
      ? `https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard?dates=${dates}`
      : `https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard`;
  } else {
    return res.status(400).json({ error: 'Missing tournamentId or scoreboard param' });
  }

  try {
    const espnResp = await fetch(espnUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SFGL/1.0)',
        'Accept': 'application/json',
      },
    });

    if (!espnResp.ok) {
      return res.status(espnResp.status).json({
        error: `ESPN returned ${espnResp.status}`,
        url: espnUrl,
      });
    }

    const data = await espnResp.json();
    // Cache for 5 minutes on Vercel's CDN
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message, url: espnUrl });
  }
}