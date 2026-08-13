// scripts/test-guest-mode.mjs
// ============================================================================
// Guest (anonymous) sign-in stays READ-ONLY.
//
// signInAsGuest() in src/api/authApi.js exists so app-store reviewers and
// closed-track testers can get past the gate without a Google/Apple account and
// without owning a team. That makes an anonymous Firebase user a real
// signed-in principal in this app for the first time, and the rules were
// written before one existed: several of them grant writes to any signed-in
// user, including team_claims create — which is a guest taking a real
// manager's team.
//
// So the invariant is narrow and mechanical: in firestore.rules, READS may key
// on signedIn(); WRITES may not. They key on isMember(), which is signedIn()
// minus anonymous. Nothing here evaluates the rules — that still needs the
// Rules Playground, per the header of firestore.rules — but a new
// `allow write: if signedIn()` slipping in is exactly the kind of thing that
// looks right in review and hands a tester the league.
//
// The client half is checked too, but only for wiring: the guest button
// reaches signInAsGuest, and App.jsx exempts guests from the claim screen
// (where they would otherwise be offered a team they cannot have).
//
//   node scripts/test-guest-mode.mjs
// ============================================================================

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

const rules   = readFileSync('firestore.rules', 'utf8');
const authApi = readFileSync('src/api/authApi.js', 'utf8');
const gate    = readFileSync('src/pages/AuthGate.jsx', 'utf8');
const app     = readFileSync('src/App.jsx', 'utf8');

// Conditions can span lines and comments can contain anything, so strip the
// comments before parsing rather than trying to match around them.
const rulesCode = rules.replace(/\/\/[^\n]*/g, '');

const WRITE_VERBS = new Set(['write', 'create', 'update', 'delete']);
const allows = [...rulesCode.matchAll(/allow\s+([a-z,\s]+?):\s*if([\s\S]*?);/g)].map(m => ({
  verbs: m[1].split(',').map(v => v.trim()).filter(Boolean),
  condition: m[2].replace(/\s+/g, ' ').trim(),
}));

console.log('\nguest mode — anonymous sign-in is read-only');
console.log(`  allow statements parsed : ${allows.length}\n`);

test('firestore.rules parses into allow statements', () => {
  // Guards the guard: a regex that matches nothing would make every assertion
  // below pass vacuously.
  assert.ok(allows.length >= 15, `only ${allows.length} allow statements found — parser is broken`);
  assert.ok(allows.some(a => a.verbs.includes('read')), 'no read grants found');
  assert.ok(allows.some(a => a.verbs.some(v => WRITE_VERBS.has(v))), 'no write grants found');
});

test('anonymous sign-in is recognised by the rules', () => {
  assert.match(
    rulesCode,
    /function isGuest\(\)[\s\S]*?sign_in_provider[\s\S]*?== 'anonymous'/,
    'isGuest() must test the token\'s sign_in_provider against \'anonymous\'',
  );
  assert.match(
    rulesCode,
    /function isMember\(\)[\s\S]*?signedIn\(\)[\s\S]*?!\s*isGuest\(\)/,
    'isMember() must be signedIn() minus guests',
  );
});

test('no write grant keys on bare signedIn()', () => {
  // The whole point. signedIn() is true for a guest; isMember() is not.
  const offenders = allows
    .filter(a => a.verbs.some(v => WRITE_VERBS.has(v)))
    .filter(a => /\bsignedIn\(\)/.test(a.condition))
    .map(a => `allow ${a.verbs.join(', ')}: if ${a.condition};`);
  assert.deepEqual(offenders, [], `write grants open to guests:\n${offenders.join('\n')}`);
});

test('reads are still open to any signed-in user, guests included', () => {
  // The inverse mistake: locking reads to isMember() leaves a guest staring at
  // an empty app, which is worse than no guest login at all.
  const readOnlyGrants = allows.filter(a => a.verbs.length === 1 && a.verbs[0] === 'read');
  const memberGated = readOnlyGrants
    .filter(a => /\bisMember\(\)/.test(a.condition))
    .map(a => `allow read: if ${a.condition};`);
  assert.deepEqual(memberGated, [], `reads a guest cannot make:\n${memberGated.join('\n')}`);
  assert.ok(
    readOnlyGrants.some(a => a.condition === 'signedIn()'),
    'expected at least one plain `allow read: if signedIn()`',
  );
});

test('ownership itself excludes guests', () => {
  assert.match(
    rulesCode,
    /function ownsTeam\(teamId\)\s*\{\s*return isMember\(\)/,
    'ownsTeam() must start from isMember(), not signedIn()',
  );
});

test('team_claims cannot be written by a guest', () => {
  // Named on its own because this is the one that costs somebody their team:
  // create is granted to whoever writes their OWN uid, which a guest has.
  const claimWrites = allows
    .filter(a => a.verbs.some(v => WRITE_VERBS.has(v)))
    .map(a => a.condition)
    .filter(c => /request\.resource\.data\.get\('uid', null\) == request\.auth\.uid/.test(c));
  assert.ok(claimWrites.length >= 2, 'expected the team_claims create + update grants');
  for (const c of claimWrites) {
    assert.match(c, /\bisMember\(\)|\bisCommish\(\)/, `claim write not member-gated: ${c}`);
  }
});

test('the guest sign-in path is anonymous auth, not a shared password', () => {
  assert.match(authApi, /export async function signInAsGuest\(\)/);
  assert.match(authApi, /signInAnonymously\(auth\)/);
  assert.match(authApi, /export function isGuestUser\(/);
  // A checked-in email/password test account would be a credential in the
  // repo AND a full member as far as the rules are concerned.
  assert.ok(
    !/signInWithEmailAndPassword/.test(authApi),
    'guest login must not be a hard-coded email/password account',
  );
});

test('the login screen offers the guest path', () => {
  assert.match(gate, /import \{[^}]*signInAsGuest[^}]*\} from '\.\.\/api\/authApi'/);
  assert.match(gate, /run\('guest', signInAsGuest\)/);
});

test('App.jsx sends guests past the claim screen, not into it', () => {
  // A guest has a uid and no team — the exact shape of the claim branch. Left
  // alone it offers them a real manager's unclaimed team and then fails the
  // write.
  assert.match(app, /isGuest=\{isGuestUser\(auth\.user\)\}/);
  assert.match(
    app,
    /if \(!loggedInTeamId && !isCommissionerClaim && !isGuest\)/,
    'the claim gate must exempt guests',
  );
});

console.log(`\n${passed} assertions passed${process.exitCode ? ' (with failures)' : ''}\n`);
