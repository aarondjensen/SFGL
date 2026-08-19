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
// single point of failure for the whole column. The cases below are the ways
// it has lost a player, plus the upstream case it must NOT paper over.
//
// Cases 1–6 are the original set. 7–10 came from the BMW Championship, where
// J.J. Spaun sat in the field with a '—': the two halves of the join had
// disagreed about which key names a player (`playerId` vs `id`).
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

// ── 7. The field page states `playerId`, not `id` ────────────────────────────
// The two halves of the join disagreed about which key names a player. The
// odds side has always read `[p.playerId, p.id]`; the recorder side only ever
// read `obj.id`. A golfer whose field-page object carries `playerId` and no
// `id` therefore contributed nothing to the id map, so their odds row cited an
// id nobody had claimed and was dropped — while `displayName` alone still put
// them in `players`. In the field, ⛳ showing, '—' in Odds, one player at a
// time: only the page sections that spell it `playerId` are affected.
{
  const nd = {
    fieldSection: {
      players: [
        { playerId: '46046', displayName: 'J.J. Spaun', country: 'USA' },
        { id: '47959', displayName: 'Tommy Fleetwood', country: 'ENG' },
      ],
    },
    oddsSection: {
      oddsToWinId: 'mkt-1', oddsEnabled: true,
      players: [{ playerId: '46046', odds: '+4000' }, { playerId: '47959', odds: '+2000' }],
    },
  };
  const { oddsMap, oddsUnresolved } = parseFieldPage(nd);
  check("a golfer identified by 'playerId' is still priced",
    oddsMap['J.J. Spaun'] === '+4000', JSON.stringify(oddsMap));
  check('and nothing is left unresolved', oddsUnresolved === 0, String(oddsUnresolved));
}

// ── 8. A surname-only odds row must not defeat a good id ─────────────────────
// Resolution preferred the row's own name unconditionally, on the reasoning
// that a name needs no join. But the row's name comes from the BOOK, which
// renders how it likes — and nameKey('Spaun') is a single token that meets
// nothing, so the price landed under a junk key while the golfer it was for
// kept their '—'. It did not even count as unresolved. The field is the
// arbiter now: whichever candidate names somebody actually playing wins, and
// the FIELD's spelling is the key.
{
  const nd = {
    fieldSection: {
      players: [{ id: '46046', displayName: 'J.J. Spaun', country: 'USA' }],
    },
    oddsSection: {
      oddsToWinId: 'mkt-1', oddsEnabled: true,
      players: [{ id: '46046', displayName: 'Spaun', odds: '+4000' }],
    },
  };
  const { oddsMap } = parseFieldPage(nd);
  check('a surname-only row resolves through the id map instead',
    oddsMap['J.J. Spaun'] === '+4000', JSON.stringify(oddsMap));
  check('and leaves no junk key behind', !('Spaun' in oddsMap), JSON.stringify(oddsMap));
  check("the roster's spelling reads it", oddsFor(nd, 'JJ Spaun') === '+4000');
}

// ── 9. A favourites rail must not outrank the full board ─────────────────────
// A page can carry several markets, and they overlap. Writing them
// last-write-wins meant whichever the DFS reached last won, so a promo rail or
// a top-10 market could overwrite an outright price. The outright board is the
// enabled one and the one with everybody in it.
{
  const nd = {
    // The small rail is traversed LAST, so under last-write-wins it would win.
    fieldSection: {
      players: [
        { id: '46046', displayName: 'J.J. Spaun', country: 'USA' },
        { id: '47959', displayName: 'Tommy Fleetwood', country: 'ENG' },
        { id: '30925', displayName: 'Shane Lowry', country: 'IRL' },
      ],
    },
    outrightBoard: {
      oddsToWinId: 'mkt-outright', oddsEnabled: true,
      players: [
        { id: '46046', odds: '+4000' }, { id: '47959', odds: '+2000' },
        { id: '30925', odds: '+6500' },
      ],
    },
    top10Rail: {
      oddsToWinId: 'mkt-top10',
      players: [{ id: '47959', odds: '+275' }],
    },
  };
  const { oddsMap } = parseFieldPage(nd);
  check('the outright price survives a smaller overlapping market',
    oddsMap['Tommy Fleetwood'] === '+2000', JSON.stringify(oddsMap));
  check('and the rest of the board is intact',
    oddsMap['J.J. Spaun'] === '+4000' && oddsMap['Shane Lowry'] === '+6500');
}

// ── 10. A row for somebody outside the field is reported ─────────────────────
// The diagnostic half of case 8. `oddsUnresolved` only counts rows nothing
// could identify; a row that resolves to a name no roster and no field entry
// answers to is just as broken and used to be completely silent.
{
  const nd = {
    fieldSection: { players: [{ id: '46046', displayName: 'J.J. Spaun', country: 'USA' }] },
    oddsSection: {
      oddsToWinId: 'mkt-1', oddsEnabled: true,
      players: [
        { id: '46046', odds: '+4000' },
        { displayName: 'Some Withdrawal', odds: '+9000' },
      ],
    },
  };
  const { oddsMap, oddsNotInField } = parseFieldPage(nd);
  check('a priced name nobody in the field answers to is reported',
    oddsNotInField.length === 1 && oddsNotInField[0] === 'Some Withdrawal',
    JSON.stringify(oddsNotInField));
  check('a name the field DOES answer to is not reported',
    !oddsNotInField.includes('J.J. Spaun'));
  check('the price is still served — the field list can be incomplete too',
    oddsMap['Some Withdrawal'] === '+9000');
}

// ── 11. A pulled price is told apart from a missing row ─────────────────────
// Both render '—' and they are opposite problems: a board that omits a player
// is ours to chase, a board that has suspended their price is not. Rows with
// no usable price used to be dropped at collection, which threw away the only
// fact that separates the two. They are kept now and reported as `pulled`.
{
  const nd = {
    fieldSection: {
      players: [
        { id: '46046', displayName: 'J.J. Spaun', country: 'USA' },
        { id: '47959', displayName: 'Tommy Fleetwood', country: 'ENG' },
        { id: '30925', displayName: 'Shane Lowry', country: 'IRL' },
      ],
    },
    oddsSection: {
      oddsToWinId: 'mkt-1', oddsEnabled: true,
      players: [
        { id: '46046', odds: '' },        // listed, price pulled
        { id: '47959', odds: '+2000' },
        // Shane Lowry: no row at all
      ],
    },
  };
  const { oddsMap, oddsPulled, oddsUnresolved } = parseFieldPage(nd);
  check('a listed-but-unpriced player is reported as pulled',
    oddsPulled.length === 1 && oddsPulled[0] === 'J.J. Spaun', JSON.stringify(oddsPulled));
  check('a player the board omits entirely is NOT reported as pulled',
    !oddsPulled.includes('Shane Lowry'));
  check('a pulled price still adds no entry', !('J.J. Spaun' in oddsMap));
  check('and is not counted as an identification failure', oddsUnresolved === 0,
    String(oddsUnresolved));
}

// ── 12. A market that suspends a price it does not own ──────────────────────
// A player can sit in two markets. If the top-10 board suspends them while the
// outright board still prices them, they are priced — reporting them as pulled
// would be noise on a column that renders their odds perfectly well.
{
  const nd = {
    fieldSection: { players: [{ id: '46046', displayName: 'J.J. Spaun', country: 'USA' }] },
    outrightBoard: {
      oddsToWinId: 'mkt-outright', oddsEnabled: true,
      players: [{ id: '46046', odds: '+4000' }],
    },
    top10Rail: {
      oddsToWinId: 'mkt-top10',
      players: [{ id: '46046', odds: '' }],
    },
  };
  const { oddsMap, oddsPulled } = parseFieldPage(nd);
  check('a price from another market keeps the player off the pulled list',
    oddsPulled.length === 0, JSON.stringify(oddsPulled));
  check('and the outright price is served', oddsMap['J.J. Spaun'] === '+4000');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
