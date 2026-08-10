// scripts/test-firestore-rules.mjs
// ============================================================================
// Does firestore.rules mention every collection the app touches?
//
// This cannot evaluate the rules — that needs the emulator or the Rules
// Playground, and the header of firestore.rules is emphatic that both are
// required before deploying. What it CAN catch is the failure that made the
// first draft dangerous: the file ends in a default-deny, so a collection
// nobody remembered to list is silently denied. team_claims was missed that
// way, which would have blocked the entire sign-in flow, and nothing in the
// repo would have said so.
//
// So: every collection named in src/ must appear in the rules, and every
// collection named in the rules must still exist in src/.
//
//   node scripts/test-firestore-rules.mjs
// ============================================================================

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|jsx|ts|tsx)$/.test(p)) files.push(p);
  }
})('src');

// Collections reached through the Firestore SDK: collection(db, 'x') and
// doc(db, 'x', …). Also picks up the string constants those calls use, since
// team_claims is referenced as CLAIMS rather than inline — which is precisely
// why reading the code by eye missed it.
const used = new Set();
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\b(?:collection|doc)\(\s*db\s*,\s*'([a-zA-Z_]+)'/g)) used.add(m[1]);
  for (const m of src.matchAll(/^const\s+[A-Z_]+\s*=\s*'([a-z_]+)';\s*(?:\/\/.*)?$/gm)) {
    // Only collection-shaped constants that the file then passes to doc()/collection().
    if (new RegExp(`\\b(?:collection|doc)\\(\\s*db\\s*,\\s*[A-Z_]+`).test(src)) used.add(m[1]);
  }
}

const rules = readFileSync('firestore.rules', 'utf8');
// `match /databases/{database}/documents` is the mandatory outer scope, not a
// collection — excluded so it does not read as an orphaned rule.
const declared = new Set(
  [...rules.matchAll(/match \/([a-zA-Z_]+)\/\{/g)]
    .map(m => m[1])
    .filter(name => name !== 'databases'),
);

console.log('\nfirestore.rules — collection coverage');
console.log(`  app writes/reads : ${[...used].sort().join(', ')}`);
console.log(`  rules declare    : ${[...declared].sort().join(', ')}\n`);

test('every collection the app uses has a rule', () => {
  // Without one it hits the default-deny at the bottom of the file and fails
  // at runtime with a permission error and no clue why.
  const missing = [...used].filter(c => !declared.has(c)).sort();
  assert.deepEqual(missing, [], `no rule for: ${missing.join(', ')}`);
});

test('every collection the rules declare is still used', () => {
  // A rule for a collection nobody touches is dead weight that reads as
  // documentation of a thing that exists. tournament_results was exactly this.
  const orphaned = [...declared].filter(c => !used.has(c)).sort();
  assert.deepEqual(orphaned, [], `rule for unused collection: ${orphaned.join(', ')}`);
});

test('team_claims specifically is covered', () => {
  // Named on its own because missing it denies sign-in for everyone, and
  // because it is referenced through a constant rather than a literal — the
  // reason it was missed the first time.
  assert.ok(used.has('team_claims'), 'the extractor stopped seeing team_claims');
  assert.ok(declared.has('team_claims'), 'firestore.rules does not cover team_claims');
});

test('the file still ends in a default deny', () => {
  assert.match(rules, /match \/\{document=\*\*\} \{\s*\n\s*allow read, write: if false;/);
});

test('ownership reads team_claims, not teams', () => {
  // The single most consequential error in the first draft.
  assert.match(rules, /function ownsTeam\(teamId\)[\s\S]*?team_claims\/\$\(teamId\)\)\.data\.uid == request\.auth\.uid/);
  assert.ok(!/documents\/teams\/\$\(teamId\)\)\.data\.uid/.test(rules),
    'ownsTeam is still reading teams/{id}.uid');
});

test('the commissioner claim is never a document field', () => {
  // token.commissioner is stamped server-side; a doc field would be
  // self-grantable. api/push.js does read teams/{id}.isCommissioner, so that
  // field must not be manager-writable either.
  assert.match(rules, /request\.auth\.token\.commissioner == true/);
  assert.ok(!/managerEditableTeamFields[\s\S]{0,400}'isCommissioner'/.test(rules),
    'isCommissioner is in the manager-editable list');
  assert.ok(!/managerEditableTeamFields[\s\S]{0,400}'uid'/.test(rules),
    'uid is in the manager-editable list');
});

console.log(`\n${passed} assertions passed${process.exitCode ? ' (with failures)' : ''}\n`);
