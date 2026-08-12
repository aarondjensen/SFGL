// Covers the odds join in api/field.js — the step that turns pgatour.com's
// id-keyed odds payload into the name-keyed list the Odds column reads.
//
// This is the failure this file exists to prevent: a player sits in the field
// with a ⛳ flag and a '—' in the Odds column, ONE player at a time, silently.
// Nothing throws, nothing logs, and the other sixty golfers are priced
// correctly — so the only signal is a manager noticing their guy is blank.
//
// Every pgatour.com odds payload identifies players by ID, not by name
// (`{ oddsToWinId, players: [{ id, odds }] }`), so the id→name join is the
// single point of failure for the whole column. The cases below are the three
// ways it lost a player, plus the upstream case it must NOT paper over.
//
//   node scripts/test-field-odds.mjs

import { parseFieldPage } from '../api/field.js';
import { NameMap, NameSet } from '../api/_playerNames.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') =>
  cond ? (pass++, console.log('  ok   ' + name))
       : (fail++, console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')));

const oddsFor = (nd, name) => new NameMap(
  Object.entries(parseFieldPage(nd).oddsMap),
).get(name);

// ── 1. Odds block traversed BEFORE the players that it prices ────────────────
// walkAll is pre-order DFS over Object.values, so key order here decides
// traversal order. Resolving odds inside that same walk joined against a
// half-built id map: every row reached before its player's id was recorded
// resolved to undefined and was dropped.
{
  const nd = {
    // odds first — this is the whole point of the case
    oddsSection: {
      oddsToWinId: 'mkt-1',
      oddsEnabled: true,
      players: [{ id: '46046', odds: '+4000' }, { id: '47959', odds: '+2000' }],
    },
    fieldSection: {
      players: [
        { id: '46046', displayName: 'J.J. Spaun' },
        { id: '47959', displayName: 'Tommy Fleetwood' },
      ],
    },
  };
  const { oddsMap, players } = parseFieldPage(nd);
  check('odds resolve when the odds block precedes the field list',
    oddsMap['J.J. Spaun'] === '+4000' && oddsMap['Tommy Fleetwood'] === '+2000',
    JSON.stringify(oddsMap));
  check('a priced player is still in the field list',
    new NameSet(players).has('J.J. Spaun'));
}

// ── 2. A second page section overwrites the player's id ──────────────────────
// pgaIds is name→id and last-write-wins, so a player who also appears in a
// featured-group / defending-champion / notable-players module had their id
// replaced by whatever that module's object carried, and the join then matched
// nothing. idToName is id-keyed and first-claim-wins, so it survives.
{
  const nd = {
    fieldSection: {
      players: [
        { id: '46046', displayName: 'J.J. Spaun' },
        { id: '47959', displayName: 'Tommy Fleetwood' },
      ],
    },
    // same golfer, different id namespace (a card/entry id, not a player id)
    featuredSection: { players: [{ id: 'feat-9911', displayName: 'J.J. Spaun' }] },
    oddsSection: {
      oddsToWinId: 'mkt-1',
      oddsEnabled: true,
      players: [{ id: '46046', odds: '+4000' }, { id: '47959', odds: '+2000' }],
    },
  };
  const { oddsMap } = parseFieldPage(nd);
  check('odds survive a later section overwriting the player id',
    oddsMap['J.J. Spaun'] === '+4000', JSON.stringify(oddsMap));
}

// ── 3. The odds row names the player itself ──────────────────────────────────
// A player with no `id` on their field-page object is absent from the id map
// entirely. The row's own name is enough and must be preferred — it needs no
// join and cannot go stale.
{
  const nd = {
    fieldSection: { players: [{ displayName: 'J.J. Spaun' }] },
    oddsSection: {
      oddsToWinId: 'mkt-1',
      oddsEnabled: true,
      players: [{ id: 'unknown-id', displayName: 'J.J. Spaun', odds: '+4000' }],
    },
  };
  check('an odds row that names its player resolves without the id map',
    parseFieldPage(nd).oddsMap['J.J. Spaun'] === '+4000');
}

// ── 4. The roster's spelling still finds the price ───────────────────────────
// The join is only half the trip: whatever spelling comes out has to survive
// NameMap against the spelling the manager's roster holds.
{
  const nd = {
    oddsSection: {
      oddsToWinId: 'mkt-1', oddsEnabled: true,
      players: [{ id: '46046', odds: '+4000' }, { id: '30925', odds: '+6500' }],
    },
    fieldSection: {
      players: [
        { id: '46046', displayName: 'JJ Spaun' },        // feed spelling
        { id: '30925', displayName: 'Shane Lowry' },
      ],
    },
  };
  check("roster 'J.J. Spaun' reads the feed's 'JJ Spaun' price",
    oddsFor(nd, 'J.J. Spaun') === '+4000');
  check("roster 'Spaun, J.J.' reads it too", oddsFor(nd, 'Spaun, J.J.') === '+4000');
  check('an unrelated golfer does not pick up that price',
    oddsFor(nd, 'Shane Lowry') === '+6500');
  check('a golfer with no row reads undefined, not another golfer\'s price',
    oddsFor(nd, 'Viktor Hovland') === undefined);
}

// ── 5. A pulled market is dropped, not rendered as garbage ───────────────────
// When a book suspends a price the row survives with a blank/null value. That
// is a legitimate "no odds" and must stay that way — the old parseInt path
// turned '' into NaN, and the guard against that is worth keeping honest.
{
  const nd = {
    fieldSection: { players: [{ id: '1', displayName: 'A Player' }, { id: '2', displayName: 'B Player' }, { id: '3', displayName: 'C Player' }] },
    oddsSection: {
      oddsToWinId: 'mkt-1', oddsEnabled: true,
      players: [
        { id: '1', odds: '' }, { id: '2', odds: null }, { id: '3', odds: 4000 },
      ],
    },
  };
  const { oddsMap } = parseFieldPage(nd);
  check('blank and null prices are dropped', !('A Player' in oddsMap) && !('B Player' in oddsMap));
  check('a bare number is formatted with a sign', oddsMap['C Player'] === '+4000');
  check('no NaN ever reaches the response',
    !Object.values(oddsMap).some(v => String(v).includes('NaN')), JSON.stringify(oddsMap));
}

// ── 6. Unresolvable rows are counted, not swallowed ──────────────────────────
// The diagnostic that makes the next instance of this visible from
// /api/field?debug=1 instead of from a screenshot of the roster page.
{
  const nd = {
    fieldSection: { players: [{ id: '46046', displayName: 'J.J. Spaun' }] },
    oddsSection: {
      oddsToWinId: 'mkt-1', oddsEnabled: true,
      players: [{ id: '46046', odds: '+4000' }, { id: 'ghost', odds: '+9000' }],
    },
  };
  const { oddsMap, oddsUnresolved } = parseFieldPage(nd);
  check('a row with no name and no known id is counted', oddsUnresolved === 1, String(oddsUnresolved));
  check('the resolvable row is unaffected', oddsMap['J.J. Spaun'] === '+4000');
  check('an unresolvable row adds no entry', Object.keys(oddsMap).length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
