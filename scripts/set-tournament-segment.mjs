// Pin a tournament's swing explicitly, instead of letting it be inferred.
//
// Usage:
//   node scripts/set-tournament-segment.mjs --tournament "Truist" --segment "Summer Swing"
//   node scripts/set-tournament-segment.mjs --tournament "Truist" --segment "Summer Swing" --apply
//   node scripts/set-tournament-segment.mjs --audit
//
// DRY RUN BY DEFAULT. --audit lists every tournament whose swing is inferred
// rather than stored, which is the set at risk of the bug below.
// Needs Firebase Admin credentials — see scripts/_adminCreds.mjs.
//
// WHY THIS EXISTS
// ---------------
// getSegmentForTournament prefers a stored `segment`, and falls back to
// reading the month out of `start_date`. That fallback is a trap, because
// start_date is an ORDERING field, not a date: _ensureStartDates back-fills
// missing values with a synthetic weekly series anchored at 2025-01-06 purely
// to keep the schedule sorted. A tournament with no stored segment therefore
// gets a swing derived from a date nobody chose.
//
// That is what happened to the 2026 Truist Championship. Its start_date reads
// 2025-05-07 — synthetic, and the wrong year — so the month fallback put it in
// the Spring Swing while the league had it opening the Summer. About $8.1M of
// team earnings and every fee attached to that week landed in the wrong pot.
//
// The schedule importer seeds segments for everything it imports (seedSegments
// in api/_rules.js), so this only ever has to repair events that predate that
// or arrived some other way. --audit finds them.

import { adminDb } from './_adminCreds.mjs';
import { SWINGS } from '../api/_league.js';
import { getSegmentForTournament, segmentSource } from '../api/_rules.js';

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const wanted = arg('--tournament', null);
const segment = arg('--segment', null);
const apply = process.argv.includes('--apply');
const audit = process.argv.includes('--audit');

if (!audit && (!wanted || !segment)) {
  console.error('Usage: node scripts/set-tournament-segment.mjs --tournament <name> --segment <swing> [--apply]');
  console.error('       node scripts/set-tournament-segment.mjs --audit');
  console.error(`Swings: ${SWINGS.join(' | ')}`);
  process.exit(2);
}
if (!audit && !SWINGS.includes(segment)) {
  console.error(`"${segment}" is not a swing. Expected one of: ${SWINGS.join(' | ')}`);
  process.exit(2);
}

const db = adminDb();
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function main() {
  const snap = await db.collection('tournaments').get();
  const tournaments = snap.docs.map(d => ({ _id: d.id, ...d.data() }));

  if (audit) {
    const derived = tournaments.filter(t => segmentSource(t) === 'derived');
    const none = tournaments.filter(t => segmentSource(t) === 'none');
    console.log(`\n${tournaments.length} tournaments, ${derived.length} with an inferred swing, ${none.length} with none.\n`);
    for (const t of derived) {
      console.log(`  ${String(t.name).padEnd(46)} ${String(getSegmentForTournament(t)).padEnd(18)} ` +
        `inferred from ${t.start_date || t.startDate || t.dates || '—'}`);
    }
    none.forEach(t => console.log(`  ${String(t.name).padEnd(46)} NO SWING AT ALL`));
    if (derived.length || none.length) {
      console.log('\nAn inferred swing is only as good as start_date, which is an ordering');
      console.log('field and may be synthetic. Pin each of these with --tournament/--segment.');
    }
    return;
  }

  // Ambiguity is refused, not guessed: "RBC" matches Heritage AND Canadian Open.
  const exact = tournaments.filter(t => norm(t.name) === norm(wanted));
  const wt = norm(wanted).split(' ').filter(Boolean);
  const subset = tournaments.filter(t => {
    const dt = new Set(norm(t.name).split(' ').filter(Boolean));
    return wt.length && wt.every(x => dt.has(x));
  });
  const matches = exact.length ? exact : subset;
  if (matches.length !== 1) {
    console.error(matches.length
      ? `"${wanted}" matches ${matches.length}: ${matches.map(t => t.name).join(', ')}`
      : `Nothing matches "${wanted}".`);
    process.exit(1);
  }

  const t = matches[0];
  const before = getSegmentForTournament(t);
  const source = segmentSource(t);

  console.log(`\n${t.name}`);
  console.log(`   was: ${before || '—'}  (${source}${source === 'derived' ? `, from ${t.start_date || t.startDate || t.dates}` : ''})`);
  console.log(`   now: ${segment}  (explicit)`);

  if (t.segment === segment) {
    console.log('\n   no change — already stored as this swing.');
    return;
  }
  if (!apply) {
    console.log('\nDRY RUN — re-run with --apply.');
    return;
  }

  await db.collection('tournaments').doc(t._id).update({ segment });
  console.log(`\n✓ pinned "${t.name}" to ${segment}`);
  console.log('\nNo reprocess needed — swing earnings, fees and pots are all derived at read');
  console.log('time from this field. They move as soon as the app reloads.');
}

main().catch(err => {
  console.error('set-tournament-segment failed:', err.message);
  process.exit(1);
});
