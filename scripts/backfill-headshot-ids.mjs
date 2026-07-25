// scripts/backfill-headshot-ids.mjs
// ============================================================================
// One-off maintenance sweep: resolve and persist headshot IDs for every player
// in /players, so no roster or add/drop avatar has to wait on a client-side
// lookup — or fall back to an initials circle because Firestore never had an id.
//
// WHY THIS EXISTS
//   Headshot ids used to be vetoed by a static PGA_TOUR_IDS map in
//   src/constants/index.js. Any name in that map was SKIPPED by the client's
//   /api/headshots auto-fetch on the stated assumption that hard-coded values
//   are "never wrong". They were all wrong — the map held PGA TOUR player ids
//   but the app builds ESPN CDN urls, a different id namespace — so those ~134
//   players both rendered a broken image AND were barred from the lookup that
//   would have given them a working id. They were therefore never resolved and
//   never persisted, which is why players like Mark Hubbard have a /players doc
//   with no espn_id at all.
//
//   The veto is gone and the client now resolves everyone, but that only heals
//   a player once someone loads the app with them on a roster. This script
//   heals the whole collection in one pass, from the server, independent of
//   any client state.
//
// WHAT IT WRITES (only on --apply, only fields that are MISSING or --force'd)
//   /players/{name}.espn_id   ESPN athlete id      → a.espncdn.com headshot
//   /players/{name}.pga_id    PGA TOUR player id   → pga-tour-res.cloudinary.com
//
//   Nothing else on the doc is touched. headshot_url (the commish's manual pin)
//   is never written or cleared — it stays the highest-precedence source.
//
// IDEMPOTENT. Safe to re-run. By default it only fills in blanks; pass --force
// to re-resolve and overwrite ids that are already present (use that when you
// suspect a stale/wrong id, e.g. a brother-collision).
//
// SOURCES (same two the /api/headshots endpoint uses)
//   1. ESPN leaderboards — current event + the 8 most recent completed events
//      of the season. Covers anyone who has played recently.
//   2. The full PGA TOUR player directory at pgatour.com/players (~2,700
//      entries). Covers everyone else, including long-term inactive players
//      that never appear in a recent leaderboard.
//   A player needs only ONE to render; having both means a dead entry in one
//   CDN silently falls through to the other instead of dropping to initials.
//
// USAGE
//   Dry run (default):
//     $env:FIREBASE_SERVICE_ACCOUNT = "C:\dev\keys\sfgl-admin.txt"
//     node scripts/backfill-headshot-ids.mjs
//   Apply:
//     node scripts/backfill-headshot-ids.mjs --apply
//   Re-resolve everything, overwriting existing ids:
//     node scripts/backfill-headshot-ids.mjs --force --apply
//   Limit to specific players (comma-separated, exact doc names):
//     node scripts/backfill-headshot-ids.mjs --only="Mark Hubbard,Kevin Kisner"
//   Also verify every resolved id actually returns an image (slow, ~1 req each):
//     node scripts/backfill-headshot-ids.mjs --verify
//
// SAFETY
//   • Dry run prints a per-player before → after and a summary. No writes.
//   • Never invents an id: the ESPN matcher requires a first-initial match and
//     returns nothing rather than guessing between relatives, and the PGA
//     directory is an exact normalized-name lookup.
//   • Writes go out in chunked batches (Firestore caps a batch at 500 ops).
// ============================================================================

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const args = process.argv.slice(2);
const APPLY  = args.includes('--apply');
const FORCE  = args.includes('--force');
const VERIFY = args.includes('--verify');
const ONLY = ((args.find(a => a.startsWith('--only=')) || '').split('=').slice(1).join('=') || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
const ESPN_CDN = 'https://a.espncdn.com/i/headshots/golf/players/full';
const PGA_CDN  = 'https://pga-tour-res.cloudinary.com/image/upload/c_fill,g_face:center,h_294,w_220/headshots';

const BATCH_LIMIT = 400; // under Firestore's 500-op cap, with headroom

// Same normalization the endpoint's matcher uses: lowercase, strip accents,
// hyphens → spaces, collapse whitespace.
export const normalize = (s) => (s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/ß/g, 'ss')
  .replace(/-/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

// ── Source 1: ESPN leaderboard index ────────────────────────────────────────
export async function buildEspnIndex(season) {
  const map = new Map(); // normalized name -> espn id
  const ids = new Set();

  // Current event(s)
  try {
    const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard', {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (r.ok) (await r.json())?.events?.forEach(e => e?.id && ids.add(String(e.id)));
  } catch { /* fall through to the season sweep */ }

  // 8 most recent completed events of the season
  try {
    const r = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard?dates=${season}0101-${season}1231`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' } },
    );
    if (r.ok) {
      const done = ((await r.json())?.events || [])
        .filter(e => e?.id && e?.status?.type?.state === 'post')
        .map(e => String(e.id));
      done.slice(-8).forEach(id => ids.add(id));
    }
  } catch { /* ignore — PGA directory still covers most players */ }

  await Promise.allSettled([...ids].map(async (id) => {
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?event=${id}`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!r.ok) return;
    const comps = (await r.json())?.events?.[0]?.competitions?.[0]?.competitors || [];
    for (const c of comps) {
      const a = c.athlete || c;
      const nm = a.displayName || a.shortName;
      if (nm && a.id && !map.has(normalize(nm))) map.set(normalize(nm), String(a.id));
    }
  }));

  return { map, eventCount: ids.size };
}

// ── Source 2: full PGA TOUR player directory ────────────────────────────────
export async function buildPgaIndex() {
  const map = new Map(); // normalized name -> pga id
  const r = await fetch('https://www.pgatour.com/players', {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', Referer: 'https://www.pgatour.com/' },
  });
  if (!r.ok) return map;
  const m = (await r.text()).match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return map;
  let nd;
  try { nd = JSON.parse(m[1]); } catch { return map; }

  (function walk(o, depth) {
    if (!o || typeof o !== 'object' || depth > 12) return;
    if (Array.isArray(o)) { o.forEach(x => walk(x, depth + 1)); return; }
    const nm = o.displayName || (o.firstName && o.lastName ? `${o.firstName} ${o.lastName}` : null);
    if (nm && o.id && /^\d+$/.test(String(o.id)) && !map.has(normalize(nm))) {
      map.set(normalize(nm), String(o.id));
    }
    Object.values(o).forEach(v => walk(v, depth + 1));
  })(nd, 0);

  return map;
}

// Verified ESPN ids that bypass the matcher entirely. Mirrors MANUAL_OVERRIDES
// in api/headshots.js and src/utils/headshotUtils.js — three copies exist
// because api/, src/ and scripts/ are separate execution contexts that can't
// share a module. Keep them in sync.
const MANUAL_OVERRIDES = {
  'alex fitzpatrick': '4364865', // verified at .../id/4364865/alex-fitzpatrick
};

// Strict ESPN match: exact, else unique last-name match that ALSO agrees on the
// first initial. Never guesses between relatives (the Alex/Matt Fitzpatrick case).
export function findEspn(index, name) {
  const n = normalize(name);
  if (MANUAL_OVERRIDES[n]) return MANUAL_OVERRIDES[n];
  if (index.has(n)) return index.get(n);
  const parts = n.split(' ');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const initial = parts[0][0];
  const hits = [];
  for (const [k, v] of index) {
    const kp = k.split(' ');
    if (kp[kp.length - 1] === last && kp[0][0] === initial) hits.push(v);
  }
  return hits.length === 1 ? hits[0] : null;
}

const headOk = async (url) => {
  try { return (await fetch(url, { method: 'HEAD' })).status === 200; }
  catch { return false; }
};

async function main() {
  const saRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!saRaw) { console.error('ERROR: FIREBASE_SERVICE_ACCOUNT env var not set.'); process.exit(1); }
  let sa;
  try { sa = saRaw.trim().startsWith('{') ? JSON.parse(saRaw) : JSON.parse(readFileSync(saRaw, 'utf8')); }
  catch (e) { console.error('ERROR: FIREBASE_SERVICE_ACCOUNT is not valid JSON or a readable file path:', e.message); process.exit(1); }
  if (!getApps().length) initializeApp({ credential: cert(sa) });
  const db = getFirestore();

  console.log('\n=== SFGL headshot id backfill ===');
  console.log(`mode: ${APPLY ? 'APPLY (will write)' : 'DRY RUN (no writes)'}`);
  if (FORCE) console.log('force: re-resolving ids that are already set');
  if (VERIFY) console.log('verify: HEAD-checking every resolved url');
  if (ONLY.length) console.log(`only: ${ONLY.join(', ')}`);
  console.log('');

  const season = new Date().getUTCFullYear();
  process.stdout.write('building indexes… ');
  const [{ map: espnIndex, eventCount }, pgaIndex] = await Promise.all([
    buildEspnIndex(season),
    buildPgaIndex(),
  ]);
  console.log(`ESPN ${espnIndex.size} players (${eventCount} events) · PGA directory ${pgaIndex.size} players\n`);

  if (espnIndex.size === 0 && pgaIndex.size === 0) {
    console.error('ERROR: both sources returned nothing — aborting rather than writing blanks.');
    process.exit(1);
  }

  const snap = await db.collection('players').get();
  let players = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (ONLY.length) {
    const want = new Set(ONLY.map(normalize));
    players = players.filter(p => want.has(normalize(p.id)));
    const missing = ONLY.filter(n => !players.some(p => normalize(p.id) === normalize(n)));
    missing.forEach(n => console.log(`  ! no /players doc named "${n}"`));
  }
  console.log(`scanning ${players.length} player docs…\n`);

  const updates = [];
  const stats = { alreadyOk: 0, gainedEspn: 0, gainedPga: 0, stillNone: 0, verifiedBad: 0 };
  const unresolved = [];

  for (const p of players) {
    // The doc ID is the canonical player name.
    const name = p.id;
    const curEspn = p.espn_id ? String(p.espn_id) : null;
    const curPga  = p.pga_id  ? String(p.pga_id)  : null;

    const wantEspn = (FORCE || !curEspn) ? findEspn(espnIndex, name) : null;
    const wantPga  = (FORCE || !curPga)  ? (pgaIndex.get(normalize(name)) || null) : null;

    const patch = {};
    if (wantEspn && wantEspn !== curEspn) patch.espn_id = wantEspn;
    if (wantPga  && wantPga  !== curPga)  patch.pga_id  = wantPga;

    const finalEspn = patch.espn_id || curEspn;
    const finalPga  = patch.pga_id  || curPga;

    if (VERIFY) {
      if (finalEspn && !(await headOk(`${ESPN_CDN}/${finalEspn}.png`))) {
        console.log(`  ✗ ${name} — espn ${finalEspn} does not resolve`);
        stats.verifiedBad++;
      }
      if (finalPga && !(await headOk(`${PGA_CDN}_${finalPga}.png`))) {
        console.log(`  ✗ ${name} — pga ${finalPga} does not resolve`);
        stats.verifiedBad++;
      }
    }

    if (!finalEspn && !finalPga) {
      stats.stillNone++;
      unresolved.push(name);
      continue;
    }

    if (Object.keys(patch).length === 0) { stats.alreadyOk++; continue; }

    if (patch.espn_id) stats.gainedEspn++;
    if (patch.pga_id)  stats.gainedPga++;
    updates.push({ name, patch, before: { espn: curEspn, pga: curPga } });
    console.log(
      `  ${name.padEnd(26)} espn ${String(curEspn || '—').padEnd(9)}→ ${String(patch.espn_id || curEspn || '—').padEnd(9)}` +
      ` pga ${String(curPga || '—').padEnd(8)}→ ${patch.pga_id || curPga || '—'}`
    );
  }

  console.log('\n── summary ──');
  console.log(`  docs scanned          : ${players.length}`);
  console.log(`  already complete      : ${stats.alreadyOk}`);
  console.log(`  gaining an espn_id    : ${stats.gainedEspn}`);
  console.log(`  gaining a  pga_id     : ${stats.gainedPga}`);
  console.log(`  docs to write         : ${updates.length}`);
  console.log(`  still unresolvable    : ${stats.stillNone}`);
  if (VERIFY) console.log(`  ids failing HEAD check: ${stats.verifiedBad}`);
  if (unresolved.length) {
    console.log(`\n  unresolvable (will keep showing initials):`);
    unresolved.forEach(n => console.log(`    · ${n}`));
  }

  if (!updates.length) { console.log('\nNothing to write.\n'); return; }
  if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply to commit.\n'); return; }

  let written = 0;
  for (let i = 0; i < updates.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    for (const u of updates.slice(i, i + BATCH_LIMIT)) {
      // merge:true — only the id fields are touched; headshot_url and every
      // other field on the doc are left exactly as they are.
      batch.set(db.collection('players').doc(u.name), u.patch, { merge: true });
    }
    await batch.commit();
    written += Math.min(BATCH_LIMIT, updates.length - i);
    console.log(`  committed ${written}/${updates.length}`);
  }
  console.log(`\n✓ Wrote ${written} player docs.\n`);
}

// Only auto-run when executed directly, so the pure index/match helpers above
// can be imported by a test harness without opening a Firestore connection.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(e => { console.error('\nFAILED:', e); process.exit(1); });
}
