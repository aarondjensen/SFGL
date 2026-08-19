// Covers the ESPN odds gap-filler in api/field.js — the last-resort source for
// players BOTH pgatour.com pages leave unpriced.
//
// It exists because of the 2026 BMW Championship: the tour's field page and
// its dedicated /odds page agreed on 48 rows for a 50-man field, so J.J. Spaun
// and Matt McCarty rendered '—' with the join working perfectly. Nothing was
// broken; the tour simply had no price for them.
//
// A second book filling gaps is only safe under two restrictions, and these
// are what this file guards:
//
//   • NAMES ONLY. ESPN athlete ids and PGA TOUR player ids are different
//     namespaces that both look like bare integers. Joining one through the
//     other's map is how a player once got another golfer's face.
//   • GAPS ONLY. A price already served by the tour must never be restated in
//     another book's numbers, and a player outside this week's field must
//     never be published at all — ESPN's "next event" is its own judgement.
//
//   node scripts/test-field-odds-espn.mjs

import { espnOddsRows, pickESPNOdds } from '../api/field.js';
import { NameSet } from '../api/_playerNames.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') =>
  cond ? (pass++, console.log('  ok   ' + name))
       : (fail++, console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')));

const FIELD = ['J.J. Spaun', 'Matt McCarty', 'Tommy Fleetwood', 'Shane Lowry'];
const fieldSet = new NameSet(FIELD);

// ── Harvesting ───────────────────────────────────────────────────────────────
console.log('\n── the harvester reads ESPN\'s shapes ──');
{
  const rows = espnOddsRows({
    // nested athlete + object-wrapped price
    a: { athlete: { id: '9478', displayName: 'J.J. Spaun' }, odds: { displayValue: '+4000' } },
    // flat displayName + bare string price
    b: { displayName: 'Matt McCarty', moneyLine: '+15000' },
    // numeric price
    c: { athlete: { fullName: 'Tommy Fleetwood' }, currentOdds: 2000 },
  });
  const by = Object.fromEntries(rows.map(r => [r.name, r.odds]));
  check('reads a nested athlete with an object price', by['J.J. Spaun'] === '+4000', JSON.stringify(by));
  check('reads a flat displayName with a string price', by['Matt McCarty'] === '+15000');
  check('reads a bare number and signs it', by['Tommy Fleetwood'] === '+2000');
  check('carries no ids — the join must go by name',
    rows.every(r => r.ids.length === 0));
}

console.log('\n── and refuses what is not a price ──');
{
  const rows = espnOddsRows({
    // Numbers shaped exactly like prices, under keys that are not odds. A
    // generic value scan would take every one of these.
    yardage:  { displayName: 'A Golfer', yards: 7400 },
    purse:    { displayName: 'B Golfer', purse: 20000 },
    position: { displayName: 'C Golfer', odds: 12 },      // a position, not a price
    score:    { displayName: 'D Golfer', odds: -8 },      // 8 under par
    even:     { displayName: 'E Golfer', odds: 'EVEN' },  // not parseable
    suspended:{ displayName: 'F Golfer', odds: '' },
  });
  check('nothing survives that is not an odds-named field with a real price',
    rows.length === 0, JSON.stringify(rows));
}

console.log('\n── a name is a person, not a label ──');
{
  const rows = espnOddsRows({
    book:   { name: 'ESPN BET', displayName: 'ESPN BET', odds: '+4000' },
    single: { displayName: 'Spaun', odds: '+4000' },
  });
  check('a one-token name is refused — it matches nothing anyway',
    !rows.some(r => r.name === 'Spaun'), JSON.stringify(rows));

  // The harvester itself is deliberately permissive: a two-token displayName
  // beside an odds key is taken at face value, because the realistic ESPN
  // shapes carry no other corroboration and rejecting a real golfer costs more
  // than carrying a junk row. The guarantee is enforced at the OUTPUT — a name
  // that is not one of the players we came here for cannot be published, so a
  // book's own name is harmless however it is shaped.
  const odds = pickESPNOdds(rows, fieldSet, ['J.J. Spaun', 'Matt McCarty']);
  check("the book's own name never reaches the response",
    !('ESPN BET' in odds) && Object.keys(odds).length === 0, JSON.stringify(odds));
}

// ── The two restrictions ─────────────────────────────────────────────────────
console.log('\n── gaps only ──');
{
  const rows = espnOddsRows({
    a: { displayName: 'J.J. Spaun', odds: '+4000' },
    b: { displayName: 'Tommy Fleetwood', odds: '+1900' },   // tour already priced him
  });
  // Only Spaun is unpriced.
  const odds = pickESPNOdds(rows, fieldSet, ['J.J. Spaun']);
  check('the unpriced player is filled', odds['J.J. Spaun'] === '+4000', JSON.stringify(odds));
  check('a player the tour already priced is NOT restated in ESPN\'s numbers',
    !('Tommy Fleetwood' in odds), JSON.stringify(odds));
}

console.log('\n── this week\'s field only ──');
{
  // ESPN's idea of the next event disagreeing with ours: a payload full of
  // golfers from a different tournament.
  const rows = espnOddsRows({
    a: { displayName: 'Rory McIlroy', odds: '+700' },
    b: { displayName: 'Scottie Scheffler', odds: '+450' },
  });
  const odds = pickESPNOdds(rows, fieldSet, ['J.J. Spaun', 'Matt McCarty']);
  check('a wrong-event payload fills nothing rather than publishing it',
    Object.keys(odds).length === 0, JSON.stringify(odds));
}

console.log('\n── the roster\'s spelling still reaches it ──');
{
  const rows = espnOddsRows({ a: { displayName: 'JJ Spaun', odds: '+4000' } });
  // The gap list is built from `players`, which spells him 'J.J. Spaun'.
  const odds = pickESPNOdds(rows, fieldSet, ['J.J. Spaun']);
  check("ESPN's 'JJ Spaun' fills the field's 'J.J. Spaun'",
    odds['J.J. Spaun'] === '+4000', JSON.stringify(odds));
  check('and the key is the FIELD\'s spelling, not ESPN\'s',
    !('JJ Spaun' in odds), JSON.stringify(odds));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
