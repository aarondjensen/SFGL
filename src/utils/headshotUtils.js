// utils/headshotUtils.js
// Shared headshot helpers used by RostersView, AddDropPlayerModal, and any
// other component that renders player avatar images.
//
// Stored headshot values are ESPN athlete IDs (numeric strings) or full URLs.
// ESPN headshot URL: https://a.espncdn.com/i/headshots/golf/players/full/{espnId}.png
// Fallback: ui-avatars.com initials avatar.

const ESPN_BASE = 'https://a.espncdn.com/i/headshots/golf/players/full';

// ── Manual overrides ─────────────────────────────────────────────────────
// Hard-coded ESPN athlete IDs that take precedence over whatever's in the
// headshotMap. Used for names where the indexed-event lookup can't reliably
// disambiguate brothers, cousins, Jr/Sr pairs, etc.
//
// CLIENT-SIDE override is the most reliable layer — it applies regardless
// of what the api/headshots endpoint returned, what's in Firestore, or
// what's in the constants PGA_TOUR_IDS fallback. Even if the API serves
// the wrong ID (stale Vercel CDN cache, old deploy, etc.), the display
// will still resolve to the correct face.
//
// Verify each ID at https://www.espn.com/golf/player/_/id/{ID}
//
// To add a player here: find their ESPN profile URL, copy the numeric ID
// from /id/{ID}, add an entry with the exact display name (case-sensitive)
// the app uses. Both display and any uses of `headshotMap[player.name]`
// will hit this map first.
const MANUAL_OVERRIDES = {
  'Alex Fitzpatrick': '4364865', // .../id/4364865/alex-fitzpatrick — Matt's brother
};

/**
 * Returns an ordered array of image URLs to try for a player.
 * Falls back gracefully if no entry in the headshotMap.
 *
 * Lookup order:
 *   1. MANUAL_OVERRIDES (hard-coded, verified IDs — bulletproof against
 *      bad data anywhere upstream).
 *   2. headshotMap (from /api/headshots fetch / Firestore).
 *   3. Empty array → caller falls back to initials avatar.
 */
export const getPlayerHeadshotUrls = (playerName, headshotMap = {}) => {
  const override = MANUAL_OVERRIDES[playerName];
  if (override) return [`${ESPN_BASE}/${override}.png`];

  const val = headshotMap[playerName];
  if (!val) return [];
  if (typeof val === 'string' && (val.startsWith('http') || val.startsWith('/'))) return [val];
  return [`${ESPN_BASE}/${val}.png`];
};

/**
 * Returns the fallback initials-avatar URL for a player.
 * @param {string}  playerName
 * @param {boolean} isLimited  — uses gold background for limited-slot players
 */
export const getPlayerHeadshotFallback = (playerName, isLimited = false) => {
  const bg = isLimited ? '8B6914' : '1c3a5e';
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(playerName)}&background=${bg}&color=ffffff&size=96&bold=true&font-size=0.38`;
};

/**
 * Returns the primary headshot URL for a player (first in the list, or fallback).
 */
export const getPlayerHeadshot = (playerName, headshotMap = {}, isLimited = false) => {
  const urls = getPlayerHeadshotUrls(playerName, headshotMap);
  if (urls.length > 0) return urls[0];
  return getPlayerHeadshotFallback(playerName, isLimited);
};

/**
 * Returns an onError handler that walks through fallback URLs before
 * settling on the initials avatar.
 */
export const makeHeadshotErrorHandler = (playerName, headshotMap = {}, isLimited = false) => {
  const urls = getPlayerHeadshotUrls(playerName, headshotMap);
  let attempt = 0;
  return function handler(e) {
    attempt++;
    if (attempt < urls.length) {
      e.target.src = urls[attempt];
      e.target.onerror = handler;
    } else {
      e.target.onerror = null;
      e.target.src = getPlayerHeadshotFallback(playerName, isLimited);
    }
  };
};
