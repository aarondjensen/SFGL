// scripts/import-season-archive.mjs
// ============================================================================
// Load a season-archive fixture into Firestore so the app's Season Archive
// view can open it.
//
//   node scripts/import-season-archive.mjs scripts/fixtures/season-archive-2025.json
//   node scripts/import-season-archive.mjs <fixture> --apply
//
// A DRY RUN unless given --apply, same as backfill-transaction-teamid.mjs.
// Needs Firebase Admin credentials; scripts/_adminCreds.mjs takes either
// FIREBASE_SERVICE_ACCOUNT or the three separate fields, and reads .env.local
// itself, so `vercel env pull .env.local` is enough setup.
//
// WHY A SCRIPT AND NOT A BUTTON IN THE APP
// ----------------------------------------
// Rolling 2027 over archives 2026 through the commish panel, because that
// archive is taken from live collections the app already holds. 2025 predates
// the app entirely: it exists only in a Google Sheet, so it arrives as a
// fixture extracted by scripts/extract-sheet-2025.py. Building a one-off import
// UI for a one-off import would be more code in the bundle than this is on
// disk, and this way the thing that writes it is the thing that can be re-run
// and diffed.
//
// It writes through the SAME layout the app reads — api/_archive.js — rather
// than its own idea of the key names. A season imported under the wrong key is
// invisible rather than broken, which is the worst way for that to show up.
// ============================================================================

import { readFileSync } from 'node:fs';
import { adminDb } from './_adminCreds.mjs';
import {
  ARCHIVE_INDEX, ARCHIVE_PARTS, ARCHIVE_PART_LIMIT, archiveKey,
} from '../api/_archive.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const path = args.find(a => !a.startsWith('--'));

if (!path) {
  console.error('usage: node scripts/import-season-archive.mjs <fixture.json> [--apply]');
  process.exit(1);
}

const fixture = JSON.parse(readFileSync(path, 'utf8'));
const season = Number(fixture.season);
if (!Number.isFinite(season)) {
  console.error(`${path}: no usable "season" field`);
  process.exit(1);
}

const standings = fixture.standings || [];
const parts = {
  teams: fixture.teams || [],
  tournaments: fixture.tournaments || [],
  transactions: fixture.transactions || [],
};

// ── What is about to be written ─────────────────────────────────────────────
console.log(`\n${apply ? 'IMPORTING' : 'DRY RUN —'} SFGL ${season}`);
console.log(`  source: ${fixture.source || '(unstated)'}\n`);

for (const row of standings) {
  console.log(`  ${row.position}. ${String(row.name).padEnd(20)} `
    + `$${Number(row.earnings).toLocaleString('en-US').padStart(12)}`);
}
console.log('');

let refuse = false;
for (const part of ARCHIVE_PARTS) {
  const bytes = JSON.stringify(parts[part]).length;
  const over = bytes > ARCHIVE_PART_LIMIT;
  if (over) refuse = true;
  console.log(`  ${archiveKey(season, part).padEnd(34)} `
    + `${String(parts[part].length).padStart(3)} rows  `
    + `${(bytes / 1000).toFixed(0).padStart(4)} kB${over ? '   TOO LARGE' : ''}`);
}
console.log(`  ${archiveKey(season).padEnd(34)} manifest + ${standings.length} standings rows`);

if (refuse) {
  console.error(`\nA part exceeds ${ARCHIVE_PART_LIMIT / 1000} kB and will not fit in one `
    + 'Firestore document. It needs chunking — see api/_archive.js.\n');
  process.exit(1);
}

// The sheet disagrees with itself in places, and the fixture records where.
// Printed on every run, including the dry one: whoever imports a season should
// see what is known to be wrong with it BEFORE it goes in, rather than finding
// out when a manager asks why an event shows $0.
const zero = fixture.discrepancies?.zeroTotalBlocks || [];
const fees = fixture.discrepancies?.feeTotals || [];
if (zero.length || fees.length) {
  console.log('\n  known discrepancies carried from the source:');
  for (const d of zero) {
    console.log(`    ${String(d.event).slice(0, 40).padEnd(40)} ${String(d.team).padEnd(18)} `
      + `published $0, starters $${Number(d.short).toLocaleString('en-US')}`);
  }
  for (const f of fees) {
    console.log(`    fees: ${String(f.team).padEnd(18)} cells $${f.feeCellsSum}, `
      + `published $${f.publishedTotal}`);
  }
}

if (!apply) {
  console.log('\nDry run — nothing written. Re-run with --apply.\n');
  process.exit(0);
}

// ── Write ───────────────────────────────────────────────────────────────────
// Parts, then the manifest, then the index — the order seasonArchiveApi.save
// uses, and for the same reason: a failure part-way through leaves no manifest,
// so the view will not offer to open a half-written season.
const db = adminDb();
const set = (key, value) => db.collection('sfgl_data').doc(key).set({ key, value });

for (const part of ARCHIVE_PARTS) {
  await set(archiveKey(season, part), parts[part]);
  console.log(`  wrote ${archiveKey(season, part)}`);
}

await set(archiveKey(season), {
  season,
  archivedAt: new Date().toISOString(),
  standings,
  parts: ARCHIVE_PARTS,
  counts: {
    teams: parts.teams.length,
    tournaments: parts.tournaments.length,
    transactions: parts.transactions.length,
  },
  source: fixture.source || null,
});
console.log(`  wrote ${archiveKey(season)}`);

const snap = await db.collection('sfgl_data').doc(ARCHIVE_INDEX).get();
const existing = snap.exists ? (snap.data().value || []) : [];
const seasons = [...new Set([...existing, season])].sort((a, b) => b - a);
await set(ARCHIVE_INDEX, seasons);
console.log(`  wrote ${ARCHIVE_INDEX} → [${seasons.join(', ')}]`);

console.log(`\nSFGL ${season} is now readable under More → Season Archive.\n`);
process.exit(0);
