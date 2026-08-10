// utils/headshotUtils.js
// Shared headshot helpers used by RostersView, AddDropPlayerModal, WaiverQueue,
// and any other component that renders a player avatar.
//
// ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────────
// There is no single source that has a photo of every golfer. ESPN's CDN
// covers anyone who has played a recent indexed event; PGA Tour's CDN covers a
// different (overlapping but not identical) set, including players who have
// been inactive or injured for months. Neither alone is complete:
//
//     ESPN only ......... 125 / 134 rostered-player sample
//     PGA Tour only ..... 105 / 134
//     both, chained ..... 131 / 134
//
// So instead of picking one, we return an ORDERED LIST of candidate URLs and
// let the browser walk it: makeHeadshotErrorHandler advances to the next URL
// on each failed load. A miss costs one failed request; it can never show the
// wrong player's face, because each URL is keyed to that player in its own
// namespace.
//
// ── ID NAMESPACES (do not mix these up) ────────────────────────────────────
//   ESPN athlete ID  -> a.espncdn.com/i/headshots/golf/players/full/{id}.png
//   PGA TOUR player ID -> pga-tour-res.cloudinary.com/.../headshots_{id}.png
// They are unrelated numbering systems. Feeding a PGA Tour ID to ESPN's CDN
// (which this app did for 134 players) 404s every time.

const ESPN_BASE = 'https://a.espncdn.com/i/headshots/golf/players/full';
const PGA_BASE  = 'https://pga-tour-res.cloudinary.com/image/upload/c_fill,g_face:center,h_294,w_220';

const espnUrl = (id) => `${ESPN_BASE}/${id}.png`;
const pgaUrl  = (id) => `${PGA_BASE}/headshots_${id}.png`;

// ── Manual overrides ─────────────────────────────────────────────────────
// Hard-coded, verified ESPN athlete IDs for names the indexed-event matcher
// can't reliably disambiguate — brothers, cousins, Jr/Sr pairs. Placed FIRST
// in the chain rather than short-circuiting it, so a stale override still
// falls through to the other sources instead of dead-ending.
//
// Verify each ID at https://www.espn.com/golf/player/_/id/{ID}
//
// ⚠ Mirrored in api/headshots.js MANUAL_OVERRIDES (separate deploy target,
// can't share a module). Keep the two in sync.
const MANUAL_OVERRIDES = {
  'Alex Fitzpatrick': '4364865', // .../id/4364865/alex-fitzpatrick — Matt's brother
};

/**
 * Ordered list of candidate image URLs for a player, best first.
 *
 * A headshot-map value is either:
 *   • an object  { url?, espn?, pga? }  — the current shape, from
 *     /api/headshots and /players/{name}, or
 *   • a bare string — the legacy shape: an explicit URL, or an ESPN athlete ID.
 * Both are accepted so nothing already persisted in Firestore needs migrating.
 *
 * Order:
 *   1. Explicit URL (a commish pin written to /players/{name}.headshot_url)
 *   2. Manual override (verified ESPN ID, for names the matcher can't
 *      disambiguate)
 *   3. ESPN athlete ID
 *   4. PGA TOUR player ID
 *
 * Returns [] when nothing is known — callers fall back to the initials avatar.
 */
export const getPlayerHeadshotUrls = (playerName, headshotMap = {}) => {
  const urls = [];
  const push = (u) => { if (u && !urls.includes(u)) urls.push(u); };

  const val = headshotMap?.[playerName];
  const entry = (val && typeof val === 'object') ? val
    : (typeof val === 'string' && val)
      // Legacy bare string: a URL, or an ESPN id.
      ? ((val.startsWith('http') || val.startsWith('/')) ? { url: val } : { espn: val })
      : {};

  if (entry.url) push(entry.url);

  const override = MANUAL_OVERRIDES[playerName];
  if (override) push(espnUrl(override));

  if (entry.espn) push(espnUrl(entry.espn));
  if (entry.pga)  push(pgaUrl(entry.pga));

  return urls;
};

/**
 * Merge a freshly-resolved entry into whatever is already known for a player,
 * without discarding fields the new result doesn't carry. Used when merging
 * /api/headshots responses into the headshots map — a response that only has
 * an `espn` id must not wipe a stored `url` pin or a previously-known `pga` id.
 */
const normEntry = (v) => (v && typeof v === 'object') ? v
  : (typeof v === 'string' && v)
    ? ((v.startsWith('http') || v.startsWith('/')) ? { url: v } : { espn: v })
    : {};

export const mergeHeadshotEntry = (prev, next) => ({ ...normEntry(prev), ...normEntry(next) });

/**
 * Given the headshot ids we already hold and a fresh /api/headshots response,
 * return only the players whose ids are NEW or DIFFERENT — i.e. the ones worth
 * writing back to Firestore.
 *
 * The app re-resolves every rostered player on every launch, deliberately: it
 * is how a wrong id (the Alex/Matt Fitzpatrick case) heals itself. But the
 * answer is normally the same one we already have, and persisting it anyway
 * rewrote ~75 player documents per launch with values identical to what was
 * already there — plus the alias-map lookup and the players_last_updated stamp
 * that every upsertMany does. This is what makes the steady state free while
 * leaving the self-healing intact.
 *
 * A response that is SILENT about a source never counts as a change: absent
 * means "couldn't resolve it", not "clear it". That asymmetry is the whole
 * reason mergeHeadshotEntry exists, and it has to hold here too.
 *
 * @param  {Object} known    name -> entry ({url?,espn?,pga?} or legacy string)
 * @param  {Object} results  name -> entry, straight from /api/headshots
 * @return {Array}  [{ name, espnId, pgaId }] — ready for playersApi.upsertMany
 */
export const changedHeadshotIds = (known, results) => {
  return Object.entries(results || {})
    .filter(([name, entry]) => {
      const cur  = normEntry((known || {})[name]);
      const next = normEntry(entry);
      if (next.espn && next.espn !== cur.espn) return true;
      if (next.pga  && next.pga  !== cur.pga)  return true;
      return false;
    })
    .map(([name, entry]) => {
      const next = normEntry(entry);
      return { name, espnId: next.espn, pgaId: next.pga };
    });
};

// ── Initials fallback ────────────────────────────────────────────────────
// Rendered as an inline SVG data URI rather than fetched from ui-avatars.com.
// This is the one layer that must NEVER fail: it is what stands between a
// player with no photo and a broken-image icon. A third-party request can be
// slow, rate-limited, blocked, or offline; a data URI is none of those, costs
// no network round trip, and renders identically every time.
const initialsOf = (name) => {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

/**
 * Initials-avatar data URI for a player.
 * @param {string}  playerName
 * @param {boolean} isLimited  — gold background for limited-slot players,
 *                               matching the gold border used on their row
 */
export const getPlayerHeadshotFallback = (playerName, isLimited = false) => {
  const bg = isLimited ? '#8B6914' : '#1c3a5e';
  const initials = initialsOf(playerName)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">` +
    `<rect width="96" height="96" fill="${bg}"/>` +
    `<text x="48" y="49" fill="#ffffff" font-family="Raleway,Helvetica,Arial,sans-serif" ` +
    `font-size="36" font-weight="700" text-anchor="middle" dominant-baseline="central">${initials}</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

/**
 * Primary headshot URL for a player (first candidate, or the initials avatar).
 */
export const getPlayerHeadshot = (playerName, headshotMap = {}, isLimited = false) => {
  const urls = getPlayerHeadshotUrls(playerName, headshotMap);
  return urls.length > 0 ? urls[0] : getPlayerHeadshotFallback(playerName, isLimited);
};

/**
 * onError handler that walks the remaining candidate URLs before settling on
 * the initials avatar. Attach alongside a src from getPlayerHeadshot():
 *
 *   <img src={getPlayerHeadshot(name, map, limited)}
 *        onError={makeHeadshotErrorHandler(name, map, limited)} />
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
      // Detach first — a data URI can't fail, but a self-referencing onerror
      // would loop forever if it ever did.
      e.target.onerror = null;
      e.target.src = getPlayerHeadshotFallback(playerName, isLimited);
    }
  };
};
