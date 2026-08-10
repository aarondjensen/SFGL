#!/usr/bin/env node
// Give every transaction a `teamId`.
//
// Transactions used to identify their team only by NAME (`tx.team`), which
// managers can edit — renaming a team cut it loose from its entire history.
// The fix added `teamId` and made txBelongsToTeam prefer it, falling back to
// the name for rows written before that. The fallback works, but it means the
// editable field is still load-bearing for old rows, and it is what stops
// firestore.rules from keying ownership on `teamId` alone: a manager would be
// denied access to their own history.
//
// This closes that out. It is the migration the rules file's inline caveat
// refers to.
//
// Resolution, in order:
//   1. an exact match on a team document's `name`
//   2. an exact match on a team document's id (some rows already store the id
//      in `team`, from before the two fields were distinct)
// A row matching neither is REPORTED AND LEFT ALONE — it names a team that no
// longer exists under that spelling, and guessing would attach real fees and
// roster moves to the wrong manager. Fix those by hand.
//
// Usage:
//   node scripts/backfill-transaction-teamid.mjs            # dry run (default)
//   node scripts/backfill-transaction-teamid.mjs --apply    # write
//
// Needs Firebase Admin credentials — see scripts/_adminCreds.mjs. Either
// FIREBASE_SERVICE_ACCOUNT (the JSON blob Vercel already holds for /api/cron)
// or the three separate fields.

import { adminDb } from './_adminCreds.mjs';

const APPLY = process.argv.includes('--apply');
const db = adminDb();

console.log(`\n=== transactions.teamId back-fill — ${APPLY ? 'APPLY' : 'DRY RUN'} ===\n`);

const [teamSnap, txSnap] = await Promise.all([
  db.collection('teams').get(),
  db.collection('transactions').get(),
]);

// name → id, and id → id (so a row already holding an id resolves to itself).
const byName = new Map();
const ids = new Set();
teamSnap.docs.forEach(d => {
  const name = d.data()?.name;
  if (name) byName.set(name, d.id);
  ids.add(d.id);
});

console.log(`/teams          ${teamSnap.size} docs`);
console.log(`/transactions   ${txSnap.size} docs\n`);

const resolvable = [];   // [docRef, teamId, txSummary]
const unresolved = [];   // rows naming a team that no longer exists
let alreadySet = 0;
let mismatched = 0;      // teamId present but pointing at no live team

for (const d of txSnap.docs) {
  const tx = d.data() || {};
  if (tx.teamId) {
    if (!ids.has(tx.teamId)) {
      mismatched += 1;
      console.log(`  ⚠ ${d.id}  teamId "${tx.teamId}" matches no team document`);
    }
    alreadySet += 1;
    continue;
  }
  const name = tx.team;
  const resolved = byName.get(name) || (ids.has(name) ? name : null);
  const summary = `${tx.date || '?'} ${tx.type || '?'} ${tx.player || ''}`.trim();
  if (resolved) resolvable.push([d.ref, resolved, `${name} → ${resolved}  (${summary})`]);
  else unresolved.push(`${d.id}  team="${name ?? '(none)'}"  ${summary}`);
}

console.log(`already have teamId   ${alreadySet}`);
console.log(`resolvable            ${resolvable.length}`);
console.log(`unresolved            ${unresolved.length}`);
if (mismatched) console.log(`dangling teamId       ${mismatched}`);
console.log('');

if (resolvable.length) {
  console.log('── would set ──');
  resolvable.slice(0, 40).forEach(([, , line]) => console.log(`  ${line}`));
  if (resolvable.length > 40) console.log(`  … and ${resolvable.length - 40} more`);
  console.log('');
}

if (unresolved.length) {
  console.log('── LEFT ALONE (team name matches no live team) ──');
  unresolved.forEach(line => console.log(`  ${line}`));
  console.log('\n  These need a human. A renamed team whose old name survives only');
  console.log('  here cannot be resolved safely — attaching them to the wrong');
  console.log('  manager moves real fees and roster history.\n');
}

if (!APPLY) {
  console.log(resolvable.length
    ? 'Dry run. Re-run with --apply to write.\n'
    : 'Nothing to do.\n');
  process.exit(unresolved.length ? 1 : 0);
}

if (!resolvable.length) {
  console.log('Nothing to write.\n');
  process.exit(unresolved.length ? 1 : 0);
}

// 500 is the hard batch limit; 400 leaves room and keeps each commit small.
const BATCH_SIZE = 400;
let written = 0;
for (let i = 0; i < resolvable.length; i += BATCH_SIZE) {
  const batch = db.batch();
  resolvable.slice(i, i + BATCH_SIZE).forEach(([ref, teamId]) => {
    // update, not set+merge: this must fail loudly on a document that vanished
    // mid-run rather than silently re-creating it with a single field.
    batch.update(ref, { teamId });
  });
  await batch.commit();
  written += Math.min(BATCH_SIZE, resolvable.length - i);
  console.log(`  committed ${written}/${resolvable.length}`);
}

console.log(`\nDone. ${written} transactions now carry teamId.`);
if (unresolved.length) {
  console.log(`${unresolved.length} left unresolved — see above. firestore.rules should NOT`);
  console.log('be tightened to teamId-only until those are dealt with.\n');
  process.exit(1);
}
console.log('Every transaction resolves to a live team.\n');
