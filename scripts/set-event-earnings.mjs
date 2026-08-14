// Correct a player's stored earnings for a past event.
//
// Usage:
//   node scripts/set-event-earnings.mjs --file scripts/fixtures/earnings-corrections-2026.json
//   node scripts/set-event-earnings.mjs --file <corrections.json> --apply
//
// DRY RUN BY DEFAULT. Nothing is written until --apply.
// Needs Firebase Admin credentials — see scripts/_adminCreds.mjs.
//
// WHY THIS EXISTS
// ---------------
// results.earningsMap is the event's money as its source reported it, and
// everything downstream is computed from it. When the source is simply wrong
// about a player, the Admin panel's earnings textarea can be edited by hand —
// but that means retyping a whole field's worth of lines to change one, with no
// record of what was changed or why.
//
// The 2026 case: Nicolai Højgaard finished T26 at the Genesis Scottish Open and
// T61 at the Rocket Classic, and the stored feed holds $0 for him at both. Not
// a name-matching fault — audit-zero-earners cleared that across the whole
// season — but the two money sources disagreeing about one player, with the
// commissioner ruling for the one the app does not use.
//
// UPDATES THE EXISTING KEY, NEVER ADDS A SECOND
// ---------------------------------------------
// Earnings are resolved with Object.keys(earningsMap).find(k => namesMatch(...)),
// so a map holding both "Nicolai Hojgaard" at $0 and "Nicolai Højgaard" at
// $78,750 scores whichever key enumerates first. Writing the corrected figure
// under a new spelling would therefore be a coin flip that looks like a fix. So
// this rewrites every key that already matches the player, and only inserts a
// new one when none does.
//
// A WRITE HERE IS HALF THE FIX. Team totals, segment earnings and per-player
// sfglEarnings are baked in at process time. REPROCESS each tournament in
// Admin → Tournament Results afterwards. Same contract as set-locked-lineups.

import { readFileSync } from 'node:fs';
import { adminDb } from './_adminCreds.mjs';
import { namesMatch } from '../api/_playerNames.js';

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const filePath = arg('--file', null);
const apply = process.argv.includes('--apply');

if (!filePath) {
  console.error('Usage: node scripts/set-event-earnings.mjs --file <corrections.json> [--apply]');
  process.exit(2);
}

const db = adminDb();
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const $ = (n) => `$${Math.round(n || 0).toLocaleString()}`;

/** Exact name, then case-insensitive, then "short name inside the full title". */
function findByName(docs, wanted) {
  const exact = docs.find(d => d.name === wanted);
  if (exact) return exact;
  const ci = docs.find(d => norm(d.name) === norm(wanted));
  if (ci) return ci;
  const wt = norm(wanted).split(' ').filter(Boolean);
  const subset = docs.filter(d => {
    const dt = new Set(norm(d.name).split(' ').filter(Boolean));
    return wt.length && wt.every(t => dt.has(t));
  });
  // Ambiguity is refused, not guessed: "RBC" matches Heritage AND Canadian Open.
  return subset.length === 1 ? subset[0] : null;
}

async function main() {
  const corrections = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!Array.isArray(corrections) || !corrections.length) {
    console.error('Corrections file must be a non-empty array.');
    process.exit(2);
  }

  const snap = await db.collection('tournaments').get();
  const tournaments = snap.docs.map(d => ({ _id: d.id, ...d.data() }));

  const writes = new Map();
  let failed = 0;

  for (const c of corrections) {
    const t = findByName(tournaments, c.tournament);
    if (!t) { console.error(`✗ no single tournament matches "${c.tournament}"`); failed++; continue; }
    if (!c.earnings || !Object.keys(c.earnings).length) {
      console.error(`✗ ${t.name}: needs an "earnings" object`); failed++; continue;
    }
    if (!t.results?.earningsMap) {
      console.error(`✗ ${t.name}: has no stored earningsMap — process the tournament first`);
      failed++; continue;
    }

    const map = { ...t.results.earningsMap };
    const lines = [];
    let changed = false;

    for (const [player, rawAmount] of Object.entries(c.earnings)) {
      const amount = Number(rawAmount);
      if (!Number.isFinite(amount) || amount < 0) {
        console.error(`✗ ${t.name} / ${player}: "${rawAmount}" is not an amount`); failed++; continue;
      }

      const keys = Object.keys(map).filter(k => namesMatch(k, player));
      if (!keys.length) {
        // Nobody by that name in the field. Inserting is defensible — a player
        // the feed omitted entirely — but it is also what a typo looks like, so
        // it is called out rather than done quietly.
        lines.push(`   + "${player}" not in this field's ${Object.keys(map).length} players — INSERTING at ${$(amount)}`);
        map[player] = amount;
        changed = true;
        continue;
      }

      if (keys.length > 1) {
        lines.push(`   ! ${player} appears under ${keys.length} keys — setting all of them`);
      }
      for (const k of keys) {
        const before = Number(map[k]) || 0;
        if (before === amount) {
          lines.push(`   = ${k}: already ${$(amount)}`);
          continue;
        }
        lines.push(`   → ${k}: ${$(before)} → ${$(amount)}`);
        map[k] = amount;
        changed = true;
      }
    }

    console.log(`\n${t.name}`);
    lines.forEach(l => console.log(l));
    if (!changed) { console.log('   no change — already correct'); continue; }
    writes.set(t._id, { name: t.name, map });
  }

  if (failed) {
    console.error(`\n${failed} correction(s) failed validation — nothing written.`);
    process.exit(1);
  }
  if (!apply) {
    console.log(`\nDRY RUN — ${writes.size} tournament doc(s) would be updated. Re-run with --apply.`);
    return;
  }

  for (const [docId, entry] of writes) {
    await db.collection('tournaments').doc(docId).update({ 'results.earningsMap': entry.map });
    console.log(`✓ wrote earningsMap to "${entry.name}"`);
  }
  console.log('\nNow REPROCESS each of those tournaments in Admin → Tournament Results.');
  console.log('Team totals, segment earnings and per-player sfglEarnings are all baked in');
  console.log('at process time; this corrected only the map they are computed from.');
}

main().catch(err => {
  console.error('set-event-earnings failed:', err.message);
  process.exit(1);
});
