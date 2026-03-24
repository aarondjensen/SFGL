// api/odds.js — Vercel serverless function
// Scrapes DraftKings Network (dknetwork.draftkings.com) for the current week's
// PGA Tour tournament winner odds. This is a public WordPress blog that publishes
// a full-field odds article every Monday — plain HTML, no JS rendering required.
//
// GET /api/odds          → { odds: { "Scottie Scheffler": "+350", ... }, tournament, count }
// GET /api/odds?debug=1  → diagnostic info

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// DK Network publishes a weekly "odds, full field" article.
// We find it via their WordPress REST API — no scraping the sportsbook needed.
const DKN_API = 'https://dknetwork.draftkings.com/wp-json/wp/v2/posts?per_page=5&categories=golf&search=odds+full+field';

async function findOddsArticle() {
  const resp = await fetch(DKN_API, { headers: { ...HEADERS, Accept: 'application/json' } });
  if (!resp.ok) throw new Error(`DKN API ${resp.status}`);
  const posts = await resp.json();
  if (!posts?.length) throw new Error('No posts found');

  // Find the most recent "odds, full field" article (published this week)
  const oneWeekAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
  const recent = posts.find(p => {
    const published = new Date(p.date).getTime();
    return published > oneWeekAgo && p.link?.includes('odds');
  }) || posts[0];

  return recent.link;
}

async function fetchOddsFromArticle(url) {
  const resp = await fetch(url, { headers: HEADERS });
  if (!resp.ok) throw new Error(`Article fetch ${resp.status}`);
  const html = await resp.text();

  // Extract tournament name from <h1> or <title>
  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  const tournament = titleMatch
    ? titleMatch[1].replace(/<[^>]+>/g, '').replace(/odds.*$/i, '').trim()
    : null;

  // Odds appear in the article as: Player Name **+2000** or Player Name +2000
  // The WordPress content renders markdown bold as <strong>+2000</strong>
  const odds = {};

  // Pattern 1: <li>Player Name <strong>+2000</strong></li>
  const liPattern = /<li>([\s\S]*?)<\/li>/gi;
  for (const [, item] of html.matchAll(liPattern)) {
    const text = item.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    // Match "Player Name +2000" or "Player Name -150"
    const m = text.match(/^(.+?)\s+([+-]\d{3,6})\s*$/);
    if (m) {
      const name = m[1].trim();
      const price = m[2].trim();
      // Filter out non-player items (must have at least first + last name)
      if (name.split(' ').length >= 2 && !name.toLowerCase().includes('click') && !name.toLowerCase().includes('http')) {
        odds[name] = price;
      }
    }
  }

  // Pattern 2: plain text lines "Player Name +2000" (fallback)
  if (!Object.keys(odds).length) {
    const textPattern = /([A-Z][a-z][\w\s'.\-]+?)\s+([+-]\d{3,6})(?:\s|$)/g;
    const bodyMatch = html.match(/<article[\s\S]*?<\/article>/);
    const body = bodyMatch ? bodyMatch[0] : html;
    const plain = body.replace(/<[^>]+>/g, ' ');
    for (const [, name, price] of plain.matchAll(textPattern)) {
      const trimmed = name.trim();
      if (trimmed.split(' ').length >= 2 && trimmed.length < 40) {
        odds[trimmed] = price;
      }
    }
  }

  return { odds, tournament, url };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const isDebug = req.query.debug === '1';

  try {
    const articleUrl = await findOddsArticle();
    const { odds, tournament, url } = await fetchOddsFromArticle(articleUrl);

    if (isDebug) {
      return res.status(200).json({
        articleUrl: url,
        tournament,
        count: Object.keys(odds).length,
        sample: Object.entries(odds).slice(0, 10),
      });
    }

    if (!Object.keys(odds).length) {
      return res.status(200).json({ odds: {}, tournament, reason: 'no-odds-parsed', url });
    }

    return res.status(200).json({ odds, tournament, count: Object.keys(odds).length, source: 'dknetwork' });

  } catch (err) {
    return res.status(200).json({ odds: {}, tournament: null, reason: err.message });
  }
}
