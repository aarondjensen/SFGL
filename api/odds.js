// api/odds.js — Vercel serverless function
// Fetches PGA Tour tournament winner odds from DraftKings' unofficial sportsbook API.
// No API key required — DraftKings exposes this publicly via their website's data layer.
//
// GET /api/odds          → { odds: { "Scottie Scheffler": "+350", ... }, tournament, count }
// GET /api/odds?debug=1  → diagnostic info

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://sportsbook.draftkings.com/',
};

// DraftKings sportsbook API — golf outrights
// Category 1042 = Golf, Subcategory 12923 = Tournament Winner (PGA Tour)
const DK_OFFER_URL = 'https://sportsbook.draftkings.com/sites/US-NJ-SB/api/v5/eventgroups/101/categories/1042/subcategories/12923?format=json';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  // 1 hour cache
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const isDebug = req.query.debug === '1';

  try {
    const resp = await fetch(DK_OFFER_URL, { headers: HEADERS });

    if (!resp.ok) {
      // Try alternate region if NJ fails
      const resp2 = await fetch(DK_OFFER_URL.replace('US-NJ-SB', 'US-CO-SB'), { headers: HEADERS });
      if (!resp2.ok) {
        return res.status(200).json({ odds: {}, tournament: null, reason: `dk-${resp.status}` });
      }
      const data2 = await resp2.json();
      return processAndRespond(data2, isDebug, res);
    }

    const data = await resp.json();
    return processAndRespond(data, isDebug, res);

  } catch (err) {
    return res.status(503).json({ error: err.message });
  }
}

function processAndRespond(data, isDebug, res) {
  if (isDebug) {
    const eventGroups = data?.eventGroup?.offerCategories || [];
    return res.status(200).json({
      topLevelKeys: Object.keys(data || {}),
      eventGroupKeys: data?.eventGroup ? Object.keys(data.eventGroup) : [],
      offerCategoryCount: eventGroups.length,
      sampleCategory: eventGroups[0],
    });
  }

  // Navigate DraftKings' offer structure
  // eventGroup → offerCategories → offerSubcategoryDescriptors → offerSubcategory → offers
  const odds = {};
  let tournament = null;

  try {
    const eventGroup = data?.eventGroup;
    if (!eventGroup) return res.status(200).json({ odds: {}, tournament: null, reason: 'no-event-group' });

    // Find the tournament name from events
    const events = eventGroup.events || [];
    if (events.length) tournament = events[0]?.name || null;

    // Walk offer categories looking for outright winner offers
    const offerCategories = eventGroup.offerCategories || [];
    for (const cat of offerCategories) {
      const subcats = cat.offerSubcategoryDescriptors || [];
      for (const subcat of subcats) {
        const offers = subcat.offerSubcategory?.offers || [];
        for (const offerGroup of offers) {
          // Each offerGroup is an array of offers for one player
          const offerList = Array.isArray(offerGroup) ? offerGroup : [offerGroup];
          for (const offer of offerList) {
            // Outcomes have a label (player name) and an oddsAmerican value
            const outcomes = offer?.outcomes || [];
            for (const outcome of outcomes) {
              const name = outcome?.label || outcome?.participant;
              const price = outcome?.oddsAmerican;
              if (name && price !== undefined && price !== null) {
                // Convert to standard format: +350, -150, etc.
                const n = parseInt(price, 10);
                if (!isNaN(n)) {
                  odds[name] = n > 0 ? `+${n}` : `${n}`;
                }
              }
            }
          }
        }
      }
    }
  } catch (e) {
    return res.status(503).json({ error: `Parse error: ${e.message}` });
  }

  return res.status(200).json({
    odds,
    tournament,
    count: Object.keys(odds).length,
    source: 'draftkings',
  });
}
