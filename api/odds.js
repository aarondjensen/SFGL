// api/odds.js — Vercel serverless function
// Delegates to /api/field which is the single hub for all PGA Tour data.
// odds are extracted from the PGA Tour field/odds pages there.
//
// GET /api/odds → { odds: { "Rory McIlroy": "+700" }, tournament, count }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const base = req.headers['x-forwarded-proto']
      ? `${req.headers['x-forwarded-proto']}://${req.headers['host']}`
      : 'https://www.sfglgolf.com';
    const fieldResp = await fetch(`${base}/api/field`);
    if (!fieldResp.ok) throw new Error(`Field ${fieldResp.status}`);
    const data = await fieldResp.json();

    // Convert odds array to { name: odds } map
    const odds = {};
    (data.odds || []).forEach(({ name, odds: o }) => { if (name && o) odds[name] = o; });

    return res.status(200).json({
      odds,
      tournament: data.tournament,
      count: Object.keys(odds).length,
      source: data.source,
    });
  } catch (err) {
    return res.status(200).json({ odds: {}, tournament: null, reason: err.message });
  }
}
