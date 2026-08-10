// scripts/test-player-names.mjs
// ============================================================================
// Regression tests for api/_playerNames.js — the shared name-identity module.
//
//   node scripts/test-player-names.mjs
//
// Uses node:test so it needs no dev dependency. The repo has no test runner
// wired into CI yet; run this after touching _playerNames.js, and especially
// after adding a row to GIVEN_NAME_GROUPS or ALIAS_GROUPS — the "no false
// positives" block below is what stops a careless nickname row from merging
// two different golfers.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  nameKey, nameVariants, namesMatch, resolveAlias,
  NameSet, NameMap, buildNameIndex, auditNames, suggestMatches,
  NAME_ALIASES, ALIAS_GROUPS,
} from '../api/_playerNames.js';

// ── The bug that started this ────────────────────────────────────────────────

test('Nico Echavarria matches Nicolas Echavarria in both directions', () => {
  assert.ok(namesMatch('Nico Echavarria', 'Nicolas Echavarria'));
  assert.ok(namesMatch('Nicolas Echavarria', 'Nico Echavarria'));

  // The exact production shape: /api/field emits one spelling, the roster
  // holds the other, and the ⛳ flag asks the field whether it has the roster
  // name. Both orientations must work — which spelling ends up on which side
  // depends on the data source that week.
  assert.ok(new NameSet(['Nicolas Echavarria']).has('Nico Echavarria'));
  assert.ok(new NameSet(['Nico Echavarria']).has('Nicolas Echavarria'));
});

// ── Layer 1: mechanical ──────────────────────────────────────────────────────

test('nameKey folds case, punctuation, diacritics and Nordic letters', () => {
  assert.equal(nameKey('Nico Echavarria'), 'nico echavarria');
  assert.equal(nameKey('  NICO   ECHAVARRIA '), 'nico echavarria');
  assert.equal(nameKey('Si-Woo Kim'), 'si woo kim');
  assert.equal(nameKey('K.H. Lee'), 'kh lee');
  assert.equal(nameKey("Ryan O'Toole"), 'ryan o toole');
  assert.equal(nameKey('Ludvig Åberg'), 'ludvig aberg');
  assert.equal(nameKey('Rasmus Højgaard'), 'rasmus hojgaard');
  assert.equal(nameKey('Nicolai Højgaard'), 'nicolai hojgaard');
  assert.equal(nameKey('Thorbjørn Olesen'), 'thorbjorn olesen');
  assert.equal(nameKey('Sebastián Muñoz'), 'sebastian munoz');
  assert.equal(nameKey('Joaquín Niemann'), 'joaquin niemann');
});

test('nameKey strips OWGR qualifiers and generational suffixes', () => {
  assert.equal(nameKey('Jackson Koivun(Am)'), 'jackson koivun');
  assert.equal(nameKey('Daniel Brown(Oct1994)'), 'daniel brown');
  assert.equal(nameKey('Harold Varner III'), 'harold varner');
  assert.equal(nameKey('Charles Howell III'), 'charles howell');
  assert.equal(nameKey('Davis Love Jr.'), 'davis love');
  // A lone suffix is never stripped to nothing — blanks must not match blanks.
  assert.equal(nameKey('III'), 'iii');
});

test('nameKey normalises "Last, First" order', () => {
  assert.equal(nameKey('Echavarria, Nico'), 'nico echavarria');
  assert.equal(nameKey('Koivun, Jackson (Am)'), 'jackson koivun');
  assert.ok(namesMatch('Echavarria, Nicolas', 'Nico Echavarria'));
});

test('nameKey is safe on empty and junk input', () => {
  for (const junk of [null, undefined, '', '   ', '()', '.']) {
    assert.equal(nameKey(junk), '');
    assert.equal(nameVariants(junk).size, 0);
  }
  // Two blanks must never be reported as the same golfer.
  assert.equal(namesMatch('', ''), false);
  assert.equal(namesMatch(null, undefined), false);
  assert.equal(new NameSet(['', null]).has(''), false);
});

// ── Layer 2: structural ──────────────────────────────────────────────────────

test('spaceless form unifies East-Asian given-name renderings', () => {
  assert.ok(namesMatch('Sung-Jae Im', 'Sungjae Im'));
  assert.ok(namesMatch('Sung Jae Im', 'Sungjae Im'));
  assert.ok(namesMatch('Si Woo Kim', 'Siwoo Kim'));
  assert.ok(namesMatch('Byeong Hun An', 'Byeong-Hun An'));
  assert.ok(namesMatch('Min-Woo Lee', 'Min Woo Lee'));
});

test('initials form unifies K.H. Lee with Kyoung-Hoon Lee', () => {
  assert.ok(namesMatch('K.H. Lee', 'Kyoung-Hoon Lee'));
  assert.ok(namesMatch('KH Lee', 'Kyoung Hoon Lee'));
  assert.ok(namesMatch('S.H. Kim', 'Sung-Hyun Kim'));
  assert.ok(namesMatch('C.T. Pan', 'Cheng-Tsung Pan'));
});

test('abbreviated "V. Hovland" leaderboard renderings match', () => {
  // pgatour.com abbreviates the given name on narrow leaderboard layouts.
  assert.ok(namesMatch('Viktor Hovland', 'V. Hovland'));
  assert.ok(namesMatch('S. Scheffler', 'Scottie Scheffler'));
  assert.ok(namesMatch('N. Echavarria', 'Nico Echavarria'));
});

test('two abbreviated forms sharing a surname never match', () => {
  // 'Sam Stevens' and 'Scott Stevens' both abbreviate to 's stevens'. Because
  // that key is WEAK on both sides, it proves nothing — this is the guard that
  // keeps the initials layer from merging every S. Stevens on tour.
  assert.ok(!namesMatch('Sam Stevens', 'Scott Stevens'));
  assert.ok(!namesMatch('Justin Thomas', 'Jordan Thomas'));
  assert.ok(!namesMatch('Viktor Hovland', 'Vince Hovland'));

  // And an inherently ambiguous leaderboard row resolves to NOBODY rather
  // than to whichever player happened to be indexed first.
  const field = new NameSet(['Sam Stevens', 'Scott Stevens']);
  assert.equal(field.resolve('S. Stevens'), null);
  assert.equal(field.resolve('Sam Stevens'), 'Sam Stevens');
  assert.equal(field.resolve('Scott Stevens'), 'Scott Stevens');
});

test('same-surname brothers in one field stay distinct', () => {
  // Pierceson and Parker Coody play the same events. The old live-score
  // matcher fell back to surname-only matching, so whichever brother the
  // leaderboard listed first could hand the other his score.
  const field = new NameSet(['Pierceson Coody', 'Parker Coody']);
  assert.equal(field.resolve('Pierceson Coody'), 'Pierceson Coody');
  assert.equal(field.resolve('Parker Coody'), 'Parker Coody');
  assert.equal(field.resolve('P. Coody'), null, 'ambiguous abbreviation must not resolve');
  assert.ok(!namesMatch('Pierceson Coody', 'Parker Coody'));
});

// ── Layer 3: nicknames ───────────────────────────────────────────────────────

test('given-name groups cover the common short forms', () => {
  const pairs = [
    ['Matt Fitzpatrick', 'Matthew Fitzpatrick'],
    ['Matt Kuchar', 'Matthew Kuchar'],
    ['Matt Wallace', 'Matthew Wallace'],
    ['Matt McCarty', 'Matthew McCarty'],
    ['Will Zalatoris', 'William Zalatoris'],
    ['Ben Griffin', 'Benjamin Griffin'],
    ['Cam Davis', 'Cameron Davis'],
    ['Nick Dunlap', 'Nicholas Dunlap'],
    ['Nick Taylor', 'Nicholas Taylor'],
    ['Joe Highsmith', 'Joseph Highsmith'],
    ['Alex Noren', 'Alexander Noren'],
    ['Chris Kirk', 'Christopher Kirk'],
    ['Doug Ghim', 'Douglas Ghim'],
    ['Sam Stevens', 'Samuel Stevens'],
    ['Vince Whaley', 'Vincent Whaley'],
    ['Johnny Keefer', 'John Keefer'],
    ['Rafa Cabrera Bello', 'Rafael Cabrera Bello'],
    ['Zach Johnson', 'Zachary Johnson'],
    ['Danny Willett', 'Daniel Willett'],
    ['Tom Kim', 'Thomas Kim'],
  ];
  for (const [a, b] of pairs) {
    assert.ok(namesMatch(a, b), `expected "${a}" to match "${b}"`);
  }
});

test('the nickname layer generalises beyond the names we hardcoded', () => {
  // None of these exist in ALIAS_GROUPS. They work because the rule is about
  // name FORMS, not about specific players — which is the whole point: the
  // next Nico is covered before anyone files a bug.
  const derived = [
    ['Nico Someone', 'Nicolas Someone'],
    ['Matt Newcomer', 'Matthew Newcomer'],
    ['Ben Rookie', 'Benjamin Rookie'],
    ['Cam Qualifier', 'Cameron Qualifier'],
  ];
  for (const [a, b] of derived) {
    assert.ok(namesMatch(a, b), `expected derived match "${a}" ≡ "${b}"`);
    assert.ok(!(a in NAME_ALIASES), `${a} should not need an explicit alias`);
  }
});

// ── No false positives — the property that protects manager trust ────────────

test('different golfers never match', () => {
  const mustNotMatch = [
    // The pair this codebase has already been burned by (headshot mix-up).
    ['Alex Fitzpatrick', 'Matt Fitzpatrick'],
    ['Nicolai Højgaard', 'Rasmus Højgaard'],
    ['Cameron Young', 'Cameron Davis'],
    ['Tom Kim', 'Si Woo Kim'],
    ['Min Woo Lee', 'Kyoung-Hoon Lee'],
    ['Nick Taylor', 'Nick Dunlap'],
    ['Ben An', 'Ben Griffin'],
    ['Sam Burns', 'Sam Stevens'],
    ['Davis Riley', 'David Riley'],       // 'davis' is its own given name
    ['Davis Thompson', 'David Thompson'],
    ['Harold Varner', 'Harry Higgs'],
    ['Justin Rose', 'Justin Thomas'],
    ['Adam Scott', 'Adam Svensson'],
    ['Robert MacIntyre', 'Robert Streb'],
    ['Sungjae Im', 'Sung Kang'],
  ];
  for (const [a, b] of mustNotMatch) {
    assert.ok(!namesMatch(a, b), `"${a}" must NOT match "${b}"`);
  }
});

test('an ambiguous initials key is dropped, not guessed', () => {
  // Two golfers whose initials forms collide: both reduce to 'jm smith'.
  // The index must refuse the shared key rather than hand it to whichever
  // was inserted first, and each must still resolve on its own full name.
  const set = new NameSet(['Jin Man Smith', 'Jae Min Smith']);
  const { ambiguous } = buildNameIndex(['Jin Man Smith', 'Jae Min Smith']);
  assert.ok(ambiguous.has('jm smith'), 'collision should be recorded');
  assert.equal(set.resolve('J.M. Smith'), null, 'ambiguous key must not resolve');
  assert.equal(set.resolve('Jin Man Smith'), 'Jin Man Smith');
  assert.equal(set.resolve('Jae Min Smith'), 'Jae Min Smith');
});

test('two lossy initials forms never match each other', () => {
  // The tier rule: 'jm smith' is a WEAK key on both sides, so it proves
  // nothing. Without this, every multi-token given name sharing a surname and
  // two initials would collapse into one golfer.
  assert.ok(!namesMatch('Jin Man Smith', 'Jae Min Smith'));
  assert.ok(!namesMatch('Sung Hyun Park', 'Seon Ho Park'));
  // …but a weak key still matches a STRONG one — that is the K.H. Lee case,
  // where the other side is literally written in initials form.
  assert.ok(namesMatch('Jin Man Smith', 'J.M. Smith'));
});

test('a list carrying both spellings of one golfer indexes as one entity', () => {
  // /api/field can emit two renderings when page sections disagree. Treating
  // that as a conflict would drop BOTH and make the player vanish — the exact
  // failure mode we are fixing, arriving by another route.
  const field = new NameSet(['Nico Echavarria', 'Nicolas Echavarria', 'Rory McIlroy']);
  assert.equal(field.size, 2, 'the two spellings collapse into one golfer');
  assert.ok(field.has('Nico Echavarria'));
  assert.ok(field.has('Nicolas Echavarria'));
  assert.equal(field.ambiguous.size, 0, 'same golfer is not an ambiguity');

  // Same for the initials pair, and for a tee-time map keyed either way.
  assert.ok(new NameSet(['Kyoung-Hoon Lee', 'K.H. Lee']).has('KH Lee'));
  const tee = new NameMap([['Nico Echavarria', '8:24 AM'], ['Nicolas Echavarria', '8:24 AM']]);
  assert.equal(tee.get('Nicolas Echavarria'), '8:24 AM');
});

// ── Alias groups ─────────────────────────────────────────────────────────────

test('resolveAlias returns the canonical spelling for Firestore doc ids', () => {
  assert.equal(resolveAlias('Nico Echavarria'), 'Nicolas Echavarria');
  assert.equal(resolveAlias('Samuel Stevens'), 'Sam Stevens');
  assert.equal(resolveAlias('K.H. Lee'), 'Kyoung-Hoon Lee');
  assert.equal(resolveAlias('S.H. Kim'), 'Sung-Hyun Kim');
  // An unknown name passes through untouched, trimmed.
  assert.equal(resolveAlias('  Scottie Scheffler '), 'Scottie Scheffler');
  assert.equal(resolveAlias(''), '');
});

test('the eight canonical spellings inherited from nameAliases.js are unchanged', () => {
  // These are live /players/{name} Firestore document IDs. Changing one
  // orphans that player's rankings, headshot ids and career stats.
  const frozen = {
    'Samuel Stevens': 'Sam Stevens',
    'Vincent Whaley': 'Vince Whaley',
    'Rafa Cabrera Bello': 'Rafael Cabrera Bello',
    'Si-Woo Kim': 'Si Woo Kim',
    'Byeong Hun An': 'Byeong-Hun An',
    'Nico Echavarria': 'Nicolas Echavarria',
    'K.H. Lee': 'Kyoung-Hoon Lee',
    'S.H. Kim': 'Sung-Hyun Kim',
  };
  for (const [alternate, canonical] of Object.entries(frozen)) {
    assert.equal(resolveAlias(alternate), canonical,
      `canonical spelling for "${alternate}" must stay "${canonical}"`);
  }
});

test('no name appears in two different alias groups', () => {
  // Two groups claiming the same spelling would mean two canonical answers
  // for one name — the exact contradiction the old dual tables had.
  const seen = new Map();
  for (const group of ALIAS_GROUPS) {
    for (const name of group) {
      const key = nameKey(name);
      assert.ok(!seen.has(key) || seen.get(key) === group[0],
        `"${name}" is claimed by both "${seen.get(key)}" and "${group[0]}"`);
      seen.set(key, group[0]);
    }
  }
});

// ── NameSet / NameMap ────────────────────────────────────────────────────────

test('NameSet matches raw names against a field list', () => {
  const field = new NameSet([
    'Nicolas Echavarria', 'Ludvig Åberg', 'Si-Woo Kim',
    'Matthew Fitzpatrick', 'Harold Varner III', 'Koivun, Jackson (Am)',
  ]);
  assert.ok(field.has('Nico Echavarria'));
  assert.ok(field.has('Ludvig Aberg'));
  assert.ok(field.has('Si Woo Kim'));
  assert.ok(field.has('Matt Fitzpatrick'));
  assert.ok(field.has('Harold Varner'));
  assert.ok(field.has('Jackson Koivun'));
  assert.ok(!field.has('Scottie Scheffler'));
  assert.ok(!field.has(''));
  assert.equal(field.resolve('Nico Echavarria'), 'Nicolas Echavarria');
  assert.equal(field.size, 6);
});

test('NameMap looks up tee times and odds by identity', () => {
  const tee = new NameMap([
    ['Nicolas Echavarria', '8:24 AM'],
    ['Ludvig Åberg', '1:05 PM'],
  ]);
  assert.equal(tee.get('Nico Echavarria'), '8:24 AM');
  assert.equal(tee.get('Ludvig Aberg'), '1:05 PM');
  assert.equal(tee.get('Scottie Scheffler'), undefined);
  assert.equal(tee.get(''), undefined);
  assert.equal(tee.size, 2);
  // Falsy values must be retrievable, not swallowed by the has/get contract.
  const zero = new NameMap([['Nico Echavarria', 0]]);
  assert.equal(zero.get('Nicolas Echavarria'), 0);
});

test('NameMap accepts a Map as well as entry pairs', () => {
  const tee = new NameMap(new Map([['Nicolas Echavarria', '8:24 AM']]));
  assert.equal(tee.get('Nico Echavarria'), '8:24 AM');
});

// ── Audit ────────────────────────────────────────────────────────────────────

test('auditNames reports only genuinely unmatched names', () => {
  const field = ['Nicolas Echavarria', 'Scottie Scheffler', 'Ludvig Åberg'];
  const roster = ['Nico Echavarria', 'Ludvig Aberg', 'Rory McIlroy'];
  const result = auditNames({ names: roster, reference: field });

  assert.equal(result.checked, 3);
  assert.equal(result.matched, 2);
  assert.equal(result.unmatched.length, 1);
  // Rory is genuinely not in this field — that is a real "not playing", not a
  // name problem, and it must still be reported as unmatched.
  assert.equal(result.unmatched[0].name, 'Rory McIlroy');
});

test('suggestMatches ranks the likely same-golfer candidates first', () => {
  const candidates = ['Nicolas Echavarria', 'Scottie Scheffler', 'Nick Dunlap'];
  const [best] = suggestMatches('Nico Echavaria', candidates); // note: typo'd surname
  assert.equal(best.name, 'Nicolas Echavarria');

  // Suggestions are advisory only — a near-miss must never become a match.
  assert.ok(suggestMatches('Alex Fitzpatrick', ['Matt Fitzpatrick']).length > 0);
  assert.ok(!namesMatch('Alex Fitzpatrick', 'Matt Fitzpatrick'));
});

test('audit surfaces a real roster-vs-field mismatch with a suggestion', () => {
  const result = auditNames({
    names: ['Some Newguy'],
    reference: ['Some Newquy'],   // one-character source-side difference
  });
  assert.equal(result.unmatched.length, 1);
  assert.equal(result.unmatched[0].suggestions[0].name, 'Some Newquy');
});
