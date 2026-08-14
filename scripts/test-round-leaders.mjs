// Guards the round-leader correction logic in scripts/set-round-leaders.mjs.
//
//   node scripts/test-round-leaders.mjs
//
// Needs no credentials — applyRoundLeaderCorrection is pure, which is why it
// was separated from the Firestore walk.
//
// The invariant worth guarding is that a tournament stores TWO leader lists —
// roundLeadersAll (everyone who led) and roundLeaders (only those who were
// started, which is what pays) — and they must never contradict each other.
// A filtered list holding a name the full list does not is how the app and its
// own audit trail start disagreeing about who led a round, which is the exact
// state these corrections exist to repair rather than introduce.

import { applyRoundLeaderCorrection } from './set-round-leaders.mjs';
import { namesMatch } from '../api/_playerNames.js';

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? '  ok  ' : '  FAIL'}  ${label}`);
  if (!cond) failures++;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\nround-leader corrections\n');

// ── set ──────────────────────────────────────────────────────────────────────
{
  const { all, filtered } = applyRoundLeaderCorrection({
    currentAll: {},
    correction: { set: { round1: ['Ludvig Åberg'], round2: ['Matt Fitzpatrick'], round3: ['Matt Fitzpatrick'] } },
    startedNames: ['Ludvig Aberg', 'Matt Fitzpatrick', 'Jordan Spieth'],
  });
  check('set writes all three rounds', eq(all.round2, ['Matt Fitzpatrick']));
  check('an event with no leaders recorded gains them',
    all.round1.length === 1 && all.round3.length === 1);
  check('a started leader collects, matched across the Å/A spelling',
    eq(filtered.round1, ['Ludvig Åberg']));
}

// ── the started-only filter ──────────────────────────────────────────────────
{
  const { all, filtered } = applyRoundLeaderCorrection({
    currentAll: {},
    correction: { set: { round1: ['Matt McCarty'], round2: ['Sungjae Im'] } },
    startedNames: ['Sung-Jae Im', 'Alex Fitzpatrick'],
  });
  check('a leader nobody started stays in the full list', eq(all.round1, ['Matt McCarty']));
  check('...and collects nothing', eq(filtered.round1, []));
  check('an alias-group spelling still collects (Sungjae/Sung-Jae Im)',
    eq(filtered.round2, ['Sungjae Im']));
}

// ── remove ───────────────────────────────────────────────────────────────────
{
  const currentAll = { round1: ['Sam Burns', 'Sahith Theegala', 'Eric Cole', 'Brooks Koepka'] };
  const started = ['Sam Burns', 'Sahith Theegala', 'Eric Cole', 'Brooks Koepka'];
  const { all, filtered } = applyRoundLeaderCorrection({
    currentAll, correction: { remove: { round1: ['Brooks Koepka'] } }, startedNames: started,
  });
  check('remove takes out exactly one name', eq(all.round1, ['Sam Burns', 'Sahith Theegala', 'Eric Cole']));
  check('...and the rest keep collecting', eq(filtered.round1, ['Sam Burns', 'Sahith Theegala', 'Eric Cole']));

  const again = applyRoundLeaderCorrection({
    currentAll: all, correction: { remove: { round1: ['Brooks Koepka'] } }, startedNames: started,
  });
  check('remove is idempotent', eq(again.all.round1, all.round1));

  // Removing by a different spelling of the same golfer must still work —
  // otherwise a correction silently does nothing, which is the failure mode
  // that let the original bonus error sit unnoticed for a season.
  const nordic = applyRoundLeaderCorrection({
    currentAll: { round1: ['Nicolai Højgaard'] },
    correction: { remove: { round1: ['Nicolai Hojgaard'] } },
    startedNames: [],
  });
  check('remove matches by identity, not by string', eq(nordic.all.round1, []));
}

// ── rounds nobody mentioned ──────────────────────────────────────────────────
{
  const currentAll = { round1: ['A Player'], round2: ['B Player'], round3: ['C Player'] };
  const { all } = applyRoundLeaderCorrection({
    currentAll, correction: { set: { round2: ['D Player'] } }, startedNames: [],
  });
  check('an unmentioned round is carried through untouched',
    eq(all.round1, ['A Player']) && eq(all.round3, ['C Player']));
  check('the mentioned round is replaced', eq(all.round2, ['D Player']));
}

// ── set and remove on the same round ─────────────────────────────────────────
{
  const { all } = applyRoundLeaderCorrection({
    currentAll: { round1: ['Old Name'] },
    correction: { set: { round1: ['Keep Me', 'Drop Me'] }, remove: { round1: ['Drop Me'] } },
    startedNames: [],
  });
  check('set applies before remove', eq(all.round1, ['Keep Me']));
}

// ── the invariant ────────────────────────────────────────────────────────────
{
  const cases = [
    { currentAll: {}, correction: { set: { round1: ['Matt McCarty'] } }, startedNames: [] },
    { currentAll: { round2: ['Sungjae Im'] }, correction: { remove: { round2: ['Nobody'] } }, startedNames: ['Sung-Jae Im'] },
    { currentAll: { round3: ['Alex Fitzpatrick', 'Matt Fitzpatrick'] }, correction: {}, startedNames: ['Matt Fitzpatrick'] },
  ];
  const holds = cases.every(c => {
    const { all, filtered } = applyRoundLeaderCorrection(c);
    return ['round1', 'round2', 'round3'].every(r =>
      filtered[r].every(n => all[r].some(m => namesMatch(m, n))));
  });
  check('filtered is always a subset of all, under name equivalence', holds);
}

// ── shape ────────────────────────────────────────────────────────────────────
{
  const { all, filtered } = applyRoundLeaderCorrection({});
  check('an empty call still returns all three rounds on both lists',
    eq(all, { round1: [], round2: [], round3: [] }) &&
    eq(filtered, { round1: [], round2: [], round3: [] }));

  const scalar = applyRoundLeaderCorrection({
    currentAll: { round1: 'Solo Leader' }, correction: {}, startedNames: ['Solo Leader'],
  });
  check('a bare string leader is read as a one-name list', eq(scalar.all.round1, ['Solo Leader']));
}

console.log(failures ? `\n${failures} failure(s).\n` : '\nAll round-leader correction tests passed.\n');
process.exit(failures ? 1 : 0);
