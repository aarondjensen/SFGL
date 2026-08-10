// scripts/test-team-abbr.mjs
// ============================================================================
// Team display abbreviations must survive a rename.
//
// They used to come from a TEAM_ABBREVIATIONS table keyed by team NAME — which
// managers can edit. Renaming 'Dirty Bird(ies)' therefore missed the table and
// silently fell back to initials of the new name, losing the curated 'DBs'
// with no way to get it back short of a code change.
//
// That is the same defect as transactions keying on `tx.team`: an editable
// display string used as an identity key. The abbreviation now lives on the
// team document as `abbr`, with the seed table re-keyed by the stable id.
//
//   node scripts/test-team-abbr.mjs
// ============================================================================

import assert from 'node:assert/strict';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

const { getTeamAbbreviation, setTeamRegistry } = await import('../src/utils/index.js');
const { TEAM_ABBREVIATIONS } = await import('../src/constants/index.js');

const TEAMS = [
  { id: 'drc',  name: 'Detroit Rock City' },
  { id: 'db',   name: 'Dirty Bird(ies)'   },
  { id: 'w1',   name: 'World #1'          },
];
setTeamRegistry(TEAMS);

console.log('\nseed table');

test('the seed table is keyed by id, not by name', () => {
  // The whole fix. A name-keyed table cannot survive a rename.
  assert.equal(TEAM_ABBREVIATIONS.drc, 'DRC');
  assert.equal(TEAM_ABBREVIATIONS['Detroit Rock City'], undefined);
});

test('a team with no stored abbr falls back to the seed', () => {
  assert.equal(getTeamAbbreviation('Detroit Rock City'), 'DRC');
  assert.equal(getTeamAbbreviation('Dirty Bird(ies)'), 'DBs');
});

console.log('\nrename');

test('the seed survives a rename', () => {
  // The regression this file exists for: before, 'Birdie Machine' missed the
  // name-keyed table and became 'BM'.
  setTeamRegistry([{ id: 'db', name: 'Birdie Machine' }]);
  assert.equal(getTeamAbbreviation('Birdie Machine'), 'DBs');
});

test('a stored abbr survives a rename too', () => {
  setTeamRegistry([{ id: 'db', name: 'Something Else', abbr: 'BIRD' }]);
  assert.equal(getTeamAbbreviation('Something Else'), 'BIRD');
});

test('a stored abbr beats the seed', () => {
  setTeamRegistry([{ id: 'drc', name: 'Detroit Rock City', abbr: 'ROCK' }]);
  assert.equal(getTeamAbbreviation('Detroit Rock City'), 'ROCK');
});

console.log('\nfallbacks');

test('an unknown team still gets initials', () => {
  setTeamRegistry(TEAMS);
  assert.equal(getTeamAbbreviation('Brand New Team'), 'BNT');
});

test('a team with neither abbr nor seed entry gets initials', () => {
  setTeamRegistry([{ id: 'zz', name: 'Late Joiners United' }]);
  assert.equal(getTeamAbbreviation('Late Joiners United'), 'LJU');
});

test('initials cap at three characters', () => {
  setTeamRegistry([]);
  assert.equal(getTeamAbbreviation('One Two Three Four Five'), 'OTT');
});

test('a blank stored abbr does not shadow the seed', () => {
  // An emptied input should clear back to the derived value, not render ''.
  setTeamRegistry([{ id: 'drc', name: 'Detroit Rock City', abbr: '   ' }]);
  assert.equal(getTeamAbbreviation('Detroit Rock City'), 'DRC');
});

test('a team object can be passed directly', () => {
  // AccountModal has the team to hand and should not need the registry.
  setTeamRegistry([]);
  assert.equal(getTeamAbbreviation({ id: 'w1', name: 'World #1' }), 'W#1');
  assert.equal(getTeamAbbreviation({ id: 'w1', name: 'World #1', abbr: 'NO1' }), 'NO1');
});

test('empty and missing names do not throw', () => {
  setTeamRegistry(TEAMS);
  assert.equal(getTeamAbbreviation(''), '');
  assert.equal(getTeamAbbreviation(undefined), '');
  assert.equal(getTeamAbbreviation(null), '');
});

test('an empty registry falls back to initials, not a crash', () => {
  // Deliberately NOT 'Detroit Rock City' here: its initials are also 'DRC', so
  // that name cannot distinguish "found the seed" from "derived initials" and
  // the assertion would pass either way.
  setTeamRegistry(undefined);
  assert.equal(getTeamAbbreviation('Dirty Bird(ies)'), 'DB');   // seed is 'DBs'
});

console.log(`\n${passed} assertions passed${process.exitCode ? ' (with failures)' : ''}\n`);
