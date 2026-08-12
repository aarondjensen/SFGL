// Covers the player/label discrimination in api/field.js — the step that
// decides whether a named object in pgatour.com's __NEXT_DATA__ is a golfer.
//
// The field list was built from "any object whose displayName contains a
// space", so `{ displayName: 'FedExCup Fall' }` — a tour-section label sharing
// the page with the field — became a phantom golfer and inflated the count.
//
// The two errors are NOT symmetric, and most of this file is about the
// expensive one:
//
//   phantom accepted → a wrong `count`, and an entry that matches no roster
//   real golfer rejected → no ⛳ flag, gone from the "Playing" filter, and a
//                          Wednesday "not in this week's field" push fired at
//                          a manager whose player is very much in it
//
// So the accept cases below outnumber the reject cases on purpose. When a new
// payload shape shows up, this file should be made MORE permissive.
//
//   node scripts/test-field-players.mjs

import { parseFieldPage } from '../api/field.js';
import { NameSet } from '../api/_playerNames.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') =>
  cond ? (pass++, console.log('  ok   ' + name))
       : (fail++, console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')));

const parseOne = (playerObj) => parseFieldPage({ section: { players: [playerObj] } });
const accepts = (playerObj) => new NameSet(parseOne(playerObj).players).has(playerObj.displayName
  || `${playerObj.firstName} ${playerObj.lastName}`);

// ── The phantom ──────────────────────────────────────────────────────────────
{
  const nd = {
    tourSection: { id: 'fall', displayName: 'FedExCup Fall' },
    fieldSection: {
      players: [
        { id: '46046', displayName: 'J.J. Spaun', shortName: 'J.J. Spaun', country: 'USA' },
        { id: '47959', displayName: 'Tommy Fleetwood', shortName: 'T. Fleetwood', country: 'ENG' },
      ],
    },
  };
  const { players, rejectedNames } = parseFieldPage(nd);
  check('the FedExCup Fall label is not a golfer', !new NameSet(players).has('FedExCup Fall'));
  check('the label is reported as rejected, not silently dropped',
    rejectedNames.includes('FedExCup Fall'), JSON.stringify(rejectedNames));
  check('the real golfers beside it survive',
    players.length === 2 && new NameSet(players).has('J.J. Spaun') && new NameSet(players).has('Tommy Fleetwood'),
    JSON.stringify(players));
  check('count reflects golfers only', players.length === 2, String(players.length));
}

// ── Accepts: every shape a real golfer turns up in ───────────────────────────
// A miss here costs a manager their ⛳ flag, so these are the load-bearing
// assertions in this file.
{
  const shapes = {
    'firstName + lastName, nothing else': { firstName: 'Matt', lastName: 'McCarty' },
    'displayName + shortName':            { displayName: 'Matt McCarty', shortName: 'M. McCarty' },
    'displayName + country':              { displayName: 'Matt McCarty', country: 'USA' },
    'displayName + countryFlag':          { displayName: 'Matt McCarty', countryFlag: 'https://x/usa.svg' },
    'displayName + headshot':             { displayName: 'Matt McCarty', headshot: 'https://x/p.png' },
    'displayName + teeTime':              { displayName: 'Matt McCarty', teeTime: '2026-08-13T12:24:00Z' },
    'displayName + amateur flag':         { displayName: 'Matt McCarty', amateur: false },
    'displayName + owgr':                 { displayName: 'Matt McCarty', owgr: 61 },
    'displayName + playerId':             { displayName: 'Matt McCarty', playerId: '52372' },
    'displayName + __typename Player':    { displayName: 'Matt McCarty', __typename: 'Player' },
    'displayName + __typename FieldPlayer': { displayName: 'Matt McCarty', __typename: 'FieldPlayer' },
    // A numeric id is the marker that separates a golfer from a section: PGA
    // TOUR player ids are numbers, section ids are slugs ('fall').
    'displayName + numeric id':           { displayName: 'Matt McCarty', id: '52372' },
  };
  for (const [label, obj] of Object.entries(shapes)) {
    check(`accepts a golfer given as ${label}`, accepts(obj), JSON.stringify(parseOne(obj).players));
  }
}

// ── The safety net: a pairing proves personhood ──────────────────────────────
// Nothing but a golfer is grouped under a tee time, so a player whose own
// object is too sparse to pass the marker test is still recovered.
{
  const nd = {
    // deliberately bare — no markers at all
    fieldSection: { players: [{ displayName: 'Matt McCarty' }] },
    groups: [{ teeTime: '2026-08-13T12:24:00Z', players: [{ id: '52372', displayName: 'Matt McCarty' }] }],
  };
  const { players, rejectedNames, teeTimeMap } = parseFieldPage(nd);
  check('a bare player object is recovered from its tee-time group',
    new NameSet(players).has('Matt McCarty'), JSON.stringify(players));
  check('and is no longer listed as rejected',
    !rejectedNames.includes('Matt McCarty'), JSON.stringify(rejectedNames));
  check('their tee time still lands', !!teeTimeMap['Matt McCarty']);
}

// ── Rejects: page furniture ──────────────────────────────────────────────────
{
  const labels = [
    { displayName: 'FedExCup Fall' },
    { displayName: 'FedExCup Fall', id: 'fall' },   // a slug id is not evidence
    { displayName: 'FedExCup Playoffs', id: 'playoffs' },
    { displayName: 'Official Money', id: 'money' },
    { displayName: 'Past Results' },
  ];
  for (const obj of labels) {
    check(`rejects the label ${JSON.stringify(obj.displayName)}`, !accepts(obj));
  }
  check('a single-word name was never eligible anyway', !accepts({ displayName: 'Leaderboard' }));
}

// ── A rejected label must not poison the id or photo maps ────────────────────
{
  const nd = {
    tourSection: { id: 'fall', displayName: 'FedExCup Fall', image: 'https://x/fall.png' },
    fieldSection: { players: [{ id: '46046', displayName: 'J.J. Spaun', country: 'USA' }] },
  };
  const { pgaIds, photos } = parseFieldPage(nd);
  check('a rejected label claims no player id', !('FedExCup Fall' in pgaIds), JSON.stringify(pgaIds));
  check('a rejected label claims no photo', !('FedExCup Fall' in photos));
  check('the real golfer keeps their id', pgaIds['J.J. Spaun'] === '46046');
}

// ── The filter must never be able to cost a player their odds ────────────────
// Rejection skips the field list, but NOT the id→name record the odds join
// reads. An earlier cut of this filter coupled the two, so a mis-rejected
// golfer lost their price as well as their ⛳ — trading one silent bug for a
// worse one.
{
  const nd = {
    // deliberately marker-free, so looksLikePlayer rejects it
    fieldSection: { players: [{ id: 'odd-id-form', displayName: 'Matt McCarty' }] },
    oddsSection: {
      oddsToWinId: 'mkt-1', oddsEnabled: true,
      players: [{ id: 'odd-id-form', odds: '+9000' }],
    },
  };
  const { players, oddsMap, oddsUnresolved } = parseFieldPage(nd);
  check('a rejected name is still priced by the odds join',
    oddsMap['Matt McCarty'] === '+9000', JSON.stringify(oddsMap));
  check('and the odds row is not counted as unresolved', oddsUnresolved === 0);
  check('while staying out of the field list', !new NameSet(players).has('Matt McCarty'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
