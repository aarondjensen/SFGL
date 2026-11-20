// scripts/test-season-archive.mjs
// ============================================================================
// Can a finished season be read back after the rollover has destroyed it?
//
// The rollover is not reversible and does not pretend to be: transactions are
// DELETED (buildEffectiveRoster would otherwise replay last season's add/drops
// onto the new rosters), the schedule import deletes every tournament doc not
// in the new set along with its results, and rosters are replaced in place.
//
// So the archive is the only copy, and for a while it was WRITE-ONLY — one
// sfglDataApi.set with no reader anywhere in the codebase. These assertions
// cover the two ways that goes wrong: nothing reads it, and the thing that
// writes it silently exceeds what a Firestore document can hold.
//
//   node scripts/test-season-archive.mjs
// ============================================================================

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

const firebase = readFileSync('src/api/firebase.js', 'utf8');
const panel    = readFileSync('src/pages/admin/SeasonRolloverPanel.jsx', 'utf8');
const view     = readFileSync('src/pages/SeasonArchiveView.jsx', 'utf8');
const app      = readFileSync('src/App.jsx', 'utf8');

console.log('\nthe archive is written, and read');

test('the archive has a reader, not just a writer', () => {
  // The whole point. A season nobody can open is a season that is gone.
  const files = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(js|jsx)$/.test(full)) files.push(full);
    }
  })('src');
  const readers = files.filter(f =>
    f !== 'src/api/firebase.js' && /seasonArchiveApi\.(get|getManifest|listSeasons)/.test(readFileSync(f, 'utf8')));
  assert.ok(readers.length > 0, 'nothing in src/ reads the archive back');
});

test('the rollover writes it through the API, not by hand', () => {
  assert.match(panel, /seasonArchiveApi\.save\(SEASON/);
  // The old single-document write, which is what could outgrow 1 MiB.
  assert.equal(/sfglDataApi\.set\(archiveKey/.test(panel), false);
});

test('it archives the rosters teams FINISHED on, not the stored arrays', () => {
  // The stored roster array and the replayed effective roster drift apart as
  // soon as a transaction lands, and the replay is the one the app treats as
  // real all season.
  assert.match(panel, /roster: rosters\[t\.id \|\| t\.name\]/);
});

console.log('\nsplit across documents');

test('each collection gets its own key', () => {
  assert.match(firebase, /const ARCHIVE_PARTS\s*=\s*\['teams', 'tournaments', 'transactions'\]/);
});

test('a part too large for one document is refused with a legible error', () => {
  // Firestore caps a document at 1 MiB. Its own rejection names neither the
  // collection nor the size, and this write happens at step 1 of a rollover.
  assert.match(firebase, /ARCHIVE_PART_LIMIT/);
  assert.match(firebase, /the limit is 1 MB/);
});

test('the manifest is written AFTER the parts, and the index after that', () => {
  // A failure part-way through must leave nothing the view will offer to open.
  // A half-written archive that looked complete would be worse than none.
  const parts    = firebase.indexOf('for (const part of ARCHIVE_PARTS)');
  const manifest = firebase.indexOf('await sfglDataApi.set(archiveKey(season), {');
  const index    = firebase.indexOf('await sfglDataApi.set(ARCHIVE_INDEX');
  assert.ok(parts !== -1 && manifest !== -1 && index !== -1, 'expected all three writes');
  assert.ok(parts < manifest, 'the manifest must not precede its parts');
  assert.ok(manifest < index, 'a season must not be listed before it is whole');
});

test('standings ride on the manifest, so opening the view is one read', () => {
  // They are small and they are the tab the view opens on; fetching thirty
  // tournaments to draw them would be the wrong trade.
  const save = firebase.slice(firebase.indexOf('async save(season'));
  assert.match(save.slice(0, save.indexOf('\n  },')), /standings,/);
});

console.log('\nthe view');

test('archived standings render through the real StandingsView', () => {
  // The archived shapes are the ones it takes live, so a manager looking up a
  // finished season sees the table the league read all year rather than a
  // second, slightly-different rendering of it.
  assert.match(view, /import \{ StandingsView \}/);
  assert.match(view, /<StandingsView[\s\S]*?teams=\{archive\.teams/);
});

test('it writes nothing', () => {
  // Read-only is the contract. An archive the UI can edit is not an archive.
  ['seasonArchiveApi.save', 'updateTeams', 'updateTransactions', 'sfglDataApi.set', 'setDoc']
    .forEach(w => assert.equal(view.includes(w), false, `the archive view must not call ${w}`));
});

test('loading is derived, never set synchronously in an effect', () => {
  // The repo's lint rules reject a synchronous setState in an effect body, and
  // deriving it also stops a stale season's data showing under a new season's
  // heading while the new one is in flight.
  assert.match(view, /const loading = season != null && !ready && !error;/);
  // Comments stripped: the note explaining why there is no setLoading mentions
  // it by name, and a guard that its own rationale trips is a guard nobody
  // keeps.
  const code = view.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.equal(/setLoading/.test(code), false);
});

test('#archive survives a reload', () => {
  // It is reached from the More menu, so it is not in TABS — but a deep link
  // and a refresh still have to land on it rather than falling through to
  // Standings.
  assert.match(app, /const EXTRA_TAB_IDS = \['archive'\]/);
  assert.match(app, /new Set\(\[\.\.\.TABS\.map\(t => t\.id\), \.\.\.EXTRA_TAB_IDS\]\)/);
});

test('the view is lazy, so the archive costs nothing until it is opened', () => {
  assert.match(app, /LazySeasonArchiveView = React\.lazy/);
});

console.log(`\n${passed} assertions passed\n`);
