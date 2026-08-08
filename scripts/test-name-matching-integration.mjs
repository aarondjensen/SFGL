// scripts/test-name-matching-integration.mjs
// ============================================================================
// End-to-end regression test for the player-name fix, driven by the exact
// production scenario that started it:
//
//   pgatour.com's field page calls him  'Nicolas Echavarria'
//   the manager's roster holds          'Nico Echavarria'
//
// Before the fix, that single spelling difference broke SEVEN things at once,
// each in a different file, each silently:
//
//   1. the ⛳ "in this week's field" flag           RostersView
//   2. the "Playing" roster filter                 RostersView
//   3. the tee-time column                         RostersView
//   4. the odds column                             RostersView
//   5. the live score / position columns           RostersView
//   6. the Wednesday "not in the field" push       api/cron.js
//   7. the player's earnings for the week          processTournamentData
//
// …plus a bogus "isn't in this week's field" confirmation when the manager
// tried to start him. Every one of those reduces to "does this roster name
// resolve against this source's name?", so this file asserts each one against
// the real shared module rather than against a mock.
//
//   node --test scripts/test-name-matching-integration.mjs
//
// processTournamentData itself can't be imported here (it pulls in a directory
// import that Node's ESM resolver rejects), so item 7 exercises the same
// earnings-lookup logic that file performs, against the same matcher it uses.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NameSet, NameMap, namesMatch, auditNames, suggestMatches } from '../api/_playerNames.js';

// What /api/field emits this week.
const FIELD_PAYLOAD = {
  tournament: 'Sanderson Farms Championship',
  players: [
    'Nicolas Echavarria', 'Scottie Scheffler', 'Ludvig Åberg',
    'Si-Woo Kim', 'Matthew Fitzpatrick', 'Viktor Hovland', 'Sungjae Im',
  ],
  teeTimes: [
    { name: 'Nicolas Echavarria', teeTime: '8:24 AM' },
    { name: 'Scottie Scheffler', teeTime: '1:05 PM' },
    { name: 'Si-Woo Kim', teeTime: '9:12 AM' },
  ],
  odds: [
    { name: 'Nicolas Echavarria', odds: '+4500' },
    { name: 'Scottie Scheffler', odds: '+450' },
  ],
};

// What /api/live emits mid-round — note the abbreviated rendering.
const LIVE_PAYLOAD = {
  tournamentName: 'Sanderson Farms Championship',
  state: 'in',
  players: [
    { name: 'Nico Echavarria', score: '-6', position: 'T3', thru: '12', isCut: false, isWD: false },
    { name: 'V. Hovland', score: '-2', position: 'T21', thru: 'F', isCut: false, isWD: false },
  ],
};

// What the manager's roster and lineup actually hold.
const ROSTER = ['Nico Echavarria', 'Scottie Scheffler', 'Ludvig Aberg', 'Si Woo Kim', 'Matt Fitzpatrick'];
const LINEUP = ['Nico Echavarria', 'Scottie Scheffler', 'Ludvig Aberg', 'Si Woo Kim', 'Matt Fitzpatrick'];

// The lookups RostersView builds from the field payload.
const field   = new NameSet(FIELD_PAYLOAD.players);
const teeTime = new NameMap(FIELD_PAYLOAD.teeTimes.map(({ name, teeTime: t }) => [name, t]));
const odds    = new NameMap(FIELD_PAYLOAD.odds.map(({ name, odds: o }) => [name, o]));
const live    = new NameMap(LIVE_PAYLOAD.players.map((p) => [p.name, p]));

test('1. the ⛳ in-field flag renders for every rostered starter', () => {
  for (const name of ROSTER) {
    assert.ok(field.has(name), `${name} should show the ⛳ flag`);
  }
});

test('2. the "Playing" filter keeps every rostered starter', () => {
  const playing = ROSTER.filter((n) => field.has(n));
  assert.deepEqual(playing, ROSTER);
});

test('3. tee times resolve across the spelling difference', () => {
  assert.equal(teeTime.get('Nico Echavarria'), '8:24 AM');
  assert.equal(teeTime.get('Si Woo Kim'), '9:12 AM');
  assert.equal(teeTime.get('Scottie Scheffler'), '1:05 PM');
  // A field player with no published tee time still reads as undefined, not as
  // another player's time.
  assert.equal(teeTime.get('Matt Fitzpatrick'), undefined);
});

test('4. odds resolve across the spelling difference', () => {
  assert.equal(odds.get('Nico Echavarria'), '+4500');
  assert.equal(odds.get('Scottie Scheffler'), '+450');
});

test('5. live score and position resolve, including abbreviated renderings', () => {
  // Roster spelling ≠ leaderboard spelling, in the opposite direction from the
  // field payload — the leaderboard uses the short form here.
  const echavarria = live.get('Nico Echavarria');
  assert.equal(echavarria?.score, '-6');
  assert.equal(echavarria?.position, 'T3');

  // 'Viktor Hovland' on a roster vs 'V. Hovland' on the board.
  assert.equal(live.get('Viktor Hovland')?.score, '-2');

  // A player who isn't on the leaderboard resolves to nothing rather than to
  // a neighbouring row.
  assert.equal(live.get('Scottie Scheffler'), undefined);
});

test('6. the Wednesday field-check push warns about nobody', () => {
  // This is the handleFieldCheck body: starters that do not resolve against
  // the field become a "your starter isn't playing" push. Every starter here
  // IS playing, so the list must be empty — a false push telling a manager to
  // bench a player who tees off Thursday is worse than sending nothing.
  const outOfField = LINEUP.filter((name) => !field.has(name));
  assert.deepEqual(outOfField, [], 'no manager should be told to bench a playing golfer');
});

test('7. earnings attribute to the right lineup slot', () => {
  // The results feed keys earnings by ITS spelling; the lineup holds the
  // manager's. This mirrors the starterResults lookup in
  // processTournamentData: exact key first, then matchPlayerName.
  const earningsMap = {
    'Nicolas Echavarria': 1_260_000,
    'Scottie Scheffler': 340_000,
    'Ludvig Åberg': 212_500,
    'Si-Woo Kim': 98_000,
    'Matthew Fitzpatrick': 76_400,
  };

  const resolveEarnings = (playerName) => {
    let earnings = earningsMap[playerName];
    if (earnings === undefined) {
      const mk = Object.keys(earningsMap).find((k) => namesMatch(k, playerName));
      earnings = mk !== undefined ? earningsMap[mk] : 0;
    }
    return earnings || 0;
  };

  assert.equal(resolveEarnings('Nico Echavarria'), 1_260_000);
  assert.equal(resolveEarnings('Ludvig Aberg'), 212_500);
  assert.equal(resolveEarnings('Si Woo Kim'), 98_000);
  assert.equal(resolveEarnings('Matt Fitzpatrick'), 76_400);

  const total = LINEUP.reduce((sum, n) => sum + resolveEarnings(n), 0);
  assert.equal(total, 1_986_900, 'the whole lineup must be credited');

  // The pre-fix behaviour, stated explicitly so a regression is unmistakable:
  // an exact-key lookup alone loses $1,646,900 of this lineup's week.
  const exactOnly = LINEUP.reduce((sum, n) => sum + (earningsMap[n] || 0), 0);
  assert.equal(exactOnly, 340_000);
});

test('8. adding a playing golfer to a lineup raises no false warning', () => {
  // RostersView confirms "X isn't listed in this week's tournament field" when
  // a starter is added who is not in the field. That prompt now only appears
  // for players who genuinely are not entered.
  const wouldWarn = (name) => field.size > 0 && !field.has(name);
  assert.equal(wouldWarn('Nico Echavarria'), false);
  assert.equal(wouldWarn('Rory McIlroy'), true, 'a genuinely absent player SHOULD still warn');
});

test('the audit stays quiet when everything resolves', () => {
  const result = auditNames({ names: ROSTER, reference: FIELD_PAYLOAD.players });
  assert.equal(result.matched, ROSTER.length);
  assert.equal(result.unmatched.length, 0);
  assert.equal(result.ambiguous.length, 0);
});

test('the audit reports an UNKNOWN mismatch instead of hiding it', () => {
  // The layered rules cannot derive 'Joachim B. Hansen' ≡ 'Joachim Hansen'…
  // actually they can (middle initial). Use a transliteration difference no
  // rule covers, which is exactly the shape of the next real-world surprise.
  const fieldNames = ['Kiradech Aphibarnrat', 'Scottie Scheffler'];
  const roster = ['Kiradech Aphibarnat'];   // roster is missing an 'r'

  assert.ok(!namesMatch(roster[0], fieldNames[0]), 'not auto-merged — correct, it is a guess');

  const result = auditNames({ names: roster, reference: fieldNames });
  assert.equal(result.unmatched.length, 1);
  const [best] = result.unmatched[0].suggestions;
  assert.equal(best.name, 'Kiradech Aphibarnrat');
  assert.ok(best.score >= 70, 'must clear the threshold that routes it to the commissioner');
});

test('a genuine absence is reported as an absence, not a name problem', () => {
  // The distinction the field check depends on: no close namesake in the field
  // means the player really is not entered, and the manager SHOULD be told.
  const result = auditNames({ names: ['Rory McIlroy'], reference: FIELD_PAYLOAD.players });
  assert.equal(result.unmatched.length, 1);
  const suggestions = result.unmatched[0].suggestions;
  assert.ok(!suggestions.length || suggestions[0].score < 70,
    'must NOT be misfiled as a name mismatch');
});

test('suggestions never become silent merges', () => {
  // The safety property behind every finding this system reports: a strong
  // suggestion is still only a suggestion. A human confirms it in Merge
  // Players. Otherwise this is the machinery that gives one brother the
  // other's score.
  assert.ok(suggestMatches('Alex Fitzpatrick', ['Matt Fitzpatrick']).length > 0);
  assert.ok(!namesMatch('Alex Fitzpatrick', 'Matt Fitzpatrick'));
  assert.equal(new NameSet(['Matt Fitzpatrick']).resolve('Alex Fitzpatrick'), null);
});
