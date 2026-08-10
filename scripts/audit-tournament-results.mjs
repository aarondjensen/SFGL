#!/usr/bin/env node
// Does /tournament_results still hold anything /tournaments does not?
//
// Results used to be written to BOTH places. The write to /tournament_results
// lost its last caller some time ago; the client and the cron now both write
// results onto the tournament document itself. App.jsx still READS the archive
// once at load, purely to fill a gap for any event whose embedded copy was lost
// before that changed.
//
// This script answers whether that backstop is still carrying anything. If it
// reports CLEAN, the read in App.jsx, tournamentResultsApi, and the collection
// itself can all go, and results will have exactly one home.
//
// Usage:  node scripts/audit-tournament-results.mjs [--season 2026]
// Needs the same service-account credentials as the cron:
//   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
// Read-only — it never writes.

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { SEASON } from '../api/_league.js';

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const season = Number(arg('--season', SEASON));

const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
  console.error('Missing FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY.');
  process.exit(2);
}
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}
const db = getFirestore();

const teamsOf = (results) => Object.keys(results?.teams || {}).sort();
const totalOf = (results) =>
  Object.values(results?.teams || {}).reduce((s, tr) => s + (tr?.totalEarnings || 0), 0);

console.log(`\n=== /tournament_results audit — season ${season} ===\n`);

const [tSnap, rSnap] = await Promise.all([
  db.collection('tournaments').get(),
  db.collection('tournament_results').where('season', '==', season).get(),
]);

const canonical = new Map();
tSnap.docs.forEach(d => canonical.set(d.data().name || d.id, d.data()));

console.log(`/tournaments          ${tSnap.size} docs, ${[...canonical.values()].filter(t => t.results).length} carrying results`);
console.log(`/tournament_results   ${rSnap.size} docs for this season\n`);

const onlyInArchive = [];   // archive has results, canonical does not — REAL data
const disagree = [];        // both have results but they differ
const redundant = [];       // both agree — archive adds nothing
const orphan = [];          // archive references a tournament that no longer exists

for (const d of rSnap.docs) {
  const row = d.data();
  const name = row.tournament_name;
  const arch = {
    teams: row.team_results,
    earningsMap: row.earnings_map,
    roundLeaders: row.round_leaders,
  };
  const t = canonical.get(name);
  if (!t) { orphan.push(name); continue; }
  if (!t.results) { onlyInArchive.push({ name, teams: teamsOf(arch), total: totalOf(arch) }); continue; }

  const a = { teams: teamsOf(arch), total: totalOf(arch) };
  const b = { teams: teamsOf(t.results), total: totalOf(t.results) };
  if (JSON.stringify(a) === JSON.stringify(b)) redundant.push(name);
  else disagree.push({ name, archive: a, canonical: b });
}

const line = (label, list) => console.log(`${label.padEnd(38)} ${list.length}`);
line('archive-only (would be LOST if dropped)', onlyInArchive);
line('disagree with the tournament doc', disagree);
line('redundant (identical)', redundant);
line('orphaned (no such tournament)', orphan);

if (onlyInArchive.length) {
  console.log('\n--- archive-only, i.e. the backstop is load-bearing ---');
  onlyInArchive.forEach(x => console.log(`   ${x.name}  teams=[${x.teams}]  total=$${x.total.toLocaleString()}`));
}
if (disagree.length) {
  console.log('\n--- disagreements (canonical wins today; archive shown for comparison) ---');
  disagree.forEach(x => console.log(
    `   ${x.name}\n      archive  : teams=[${x.archive.teams}] total=$${x.archive.total.toLocaleString()}` +
    `\n      canonical: teams=[${x.canonical.teams}] total=$${x.canonical.total.toLocaleString()}`));
}
if (orphan.length) console.log('\n--- orphaned ---\n   ' + orphan.join('\n   '));

const clean = onlyInArchive.length === 0 && disagree.length === 0;
console.log(clean
  ? '\nCLEAN — the archive holds nothing /tournaments does not. The recovery step in\nApp.jsx, tournamentResultsApi and the collection can all be retired.\n'
  : '\nNOT CLEAN — the archive is still carrying data. Reconcile it into /tournaments\nbefore removing the recovery step.\n');
process.exit(clean ? 0 : 1);
