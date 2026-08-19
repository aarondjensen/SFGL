// Covers the secondary odds sources in api/field.js — a sportsbook and ESPN,
// the gap-fillers for players BOTH pgatour.com pages leave unpriced.
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
//   node scripts/test-field-odds-fallback.mjs

import { bookOddsRows, pickGapOdds, bookUrlsFor, embeddedJson, eventGroupIds, probeUrl } from '../api/field.js';
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
  const rows = bookOddsRows({
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
  const rows = bookOddsRows({
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
  const rows = bookOddsRows({
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
  const odds = pickGapOdds(rows, fieldSet, ['J.J. Spaun', 'Matt McCarty']);
  check("the book's own name never reaches the response",
    !('ESPN BET' in odds) && Object.keys(odds).length === 0, JSON.stringify(odds));
}

// ── The two restrictions ─────────────────────────────────────────────────────
console.log('\n── gaps only ──');
{
  const rows = bookOddsRows({
    a: { displayName: 'J.J. Spaun', odds: '+4000' },
    b: { displayName: 'Tommy Fleetwood', odds: '+1900' },   // tour already priced him
  });
  // Only Spaun is unpriced.
  const odds = pickGapOdds(rows, fieldSet, ['J.J. Spaun']);
  check('the unpriced player is filled', odds['J.J. Spaun'] === '+4000', JSON.stringify(odds));
  check('a player the tour already priced is NOT restated in ESPN\'s numbers',
    !('Tommy Fleetwood' in odds), JSON.stringify(odds));
}

console.log('\n── this week\'s field only ──');
{
  // ESPN's idea of the next event disagreeing with ours: a payload full of
  // golfers from a different tournament.
  const rows = bookOddsRows({
    a: { displayName: 'Rory McIlroy', odds: '+700' },
    b: { displayName: 'Scottie Scheffler', odds: '+450' },
  });
  const odds = pickGapOdds(rows, fieldSet, ['J.J. Spaun', 'Matt McCarty']);
  check('a wrong-event payload fills nothing rather than publishing it',
    Object.keys(odds).length === 0, JSON.stringify(odds));
}

console.log('\n── the roster\'s spelling still reaches it ──');
{
  const rows = bookOddsRows({ a: { displayName: 'JJ Spaun', odds: '+4000' } });
  // The gap list is built from `players`, which spells him 'J.J. Spaun'.
  const odds = pickGapOdds(rows, fieldSet, ['J.J. Spaun']);
  check("ESPN's 'JJ Spaun' fills the field's 'J.J. Spaun'",
    odds['J.J. Spaun'] === '+4000', JSON.stringify(odds));
  check('and the key is the FIELD\'s spelling, not ESPN\'s',
    !('JJ Spaun' in odds), JSON.stringify(odds));
}

// ── Market selection: the part that can do real damage ───────────────────────
// A book prices a tournament a dozen different ways and most of those markets
// name the same golfers. A head-to-head is about -110 and a top-10 is a
// fraction of the win number, so harvesting blind puts a number in a column
// that says 'Odds' and means 'odds to win'. That is WORSE than the blank cell
// this whole exercise exists to fill: a blank is honestly empty, '-115' beside
// a golfer's name reads as real and is wrong.
console.log('\n── only the outright market ──');
{
  const dk = {
    eventGroup: {
      offerCategories: [{
        offerSubcategoryDescriptors: [
          { offerSubcategory: { offers: [[{
            label: 'Tournament Winner',
            outcomes: [
              { label: 'J.J. Spaun', oddsAmerican: '+4000' },
              { label: 'Matt McCarty', oddsAmerican: '+15000' },
              { label: 'Tommy Fleetwood', oddsAmerican: '+1900' },
              { label: 'Shane Lowry', oddsAmerican: '+6000' },
            ],
          }]] } },
          { offerSubcategory: { offers: [[{
            label: 'Top 10 Finish',
            outcomes: [
              { label: 'J.J. Spaun', oddsAmerican: '+250' },
              { label: 'Matt McCarty', oddsAmerican: '+900' },
            ],
          }]] } },
          { offerSubcategory: { offers: [[{
            label: 'Tournament Matchups',
            outcomes: [
              { label: 'J.J. Spaun', oddsAmerican: '-115' },
              { label: 'Matt McCarty', oddsAmerican: '-105' },
            ],
          }]] } },
        ],
      }],
    },
  };
  const rows = bookOddsRows(dk);
  const odds = pickGapOdds(rows, fieldSet, ['J.J. Spaun', 'Matt McCarty']);
  check('the outright price is the one that lands',
    odds['J.J. Spaun'] === '+4000' && odds['Matt McCarty'] === '+15000', JSON.stringify(odds));
  check('no top-10 price leaks into the Odds column',
    !Object.values(odds).includes('+250') && !Object.values(odds).includes('+900'),
    JSON.stringify(odds));
  check('no matchup price leaks in either',
    !Object.values(odds).some(v => v.startsWith('-')), JSON.stringify(odds));
  check('a player the tour already priced is still left alone',
    !('Tommy Fleetwood' in odds), JSON.stringify(odds));
}

console.log('\n── a book with no outright market fills nothing ──');
{
  // The dangerous case: the golfer we want appears ONLY in markets we must not
  // read. There is nothing legitimate to take, so nothing may be taken.
  const rows = bookOddsRows({
    a: { label: 'First Round Leader', outcomes: [{ label: 'J.J. Spaun', oddsAmerican: '+2200' }] },
    b: { label: 'Make The Cut', outcomes: [{ label: 'J.J. Spaun', oddsAmerican: '-300' }] },
    c: { label: '3 Balls - Round 1', outcomes: [{ label: 'J.J. Spaun', oddsAmerican: '+140' }] },
  });
  const odds = pickGapOdds(rows, fieldSet, ['J.J. Spaun']);
  check('nothing is harvested from non-win markets', rows.length === 0, JSON.stringify(rows));
  check('and the cell stays blank rather than wrong',
    Object.keys(odds).length === 0, JSON.stringify(odds));
}

console.log('\n── outcome objects are not double-harvested ──');
{
  // Every outcome also satisfies the flat ESPN test. If the flat branch took
  // them too, every market the label gate just excluded would come back in at
  // rank 1 — and for a player the outright board does not carry, nothing would
  // outrank it.
  const rows = bookOddsRows({
    market: {
      label: 'Top 10 Finish',
      outcomes: [{ label: 'J.J. Spaun', oddsAmerican: '+250', odds: '+250' }],
    },
  });
  check('an excluded market contributes no rows at all', rows.length === 0, JSON.stringify(rows));
}

console.log('\n── the fuller win market wins ──');
{
  const rows = bookOddsRows({
    stale: { label: 'Outright Winner', outcomes: [{ label: 'J.J. Spaun', oddsAmerican: '+9000' }] },
    full: {
      label: 'Tournament Winner',
      outcomes: [
        { label: 'J.J. Spaun', oddsAmerican: '+4000' },
        { label: 'Matt McCarty', oddsAmerican: '+15000' },
        { label: 'Tommy Fleetwood', oddsAmerican: '+1900' },
      ],
    },
  });
  const odds = pickGapOdds(rows, fieldSet, ['J.J. Spaun']);
  check('a fuller board outranks a thin one', odds['J.J. Spaun'] === '+4000', JSON.stringify(odds));
}

console.log('\n── FanDuel\'s runner shape ──');
{
  const rows = bookOddsRows({
    market: {
      marketName: 'Tournament Winner',
      runners: [
        { runnerName: 'J.J. Spaun', winRunnerOdds: { americanDisplayOdds: { americanOdds: 4000 } } },
        { runnerName: 'Tommy Fleetwood', winRunnerOdds: { americanDisplayOdds: { americanOdds: 1900 } } },
      ],
    },
  });
  const odds = pickGapOdds(rows, fieldSet, ['J.J. Spaun']);
  check('a runners/winRunnerOdds market is read too',
    odds['J.J. Spaun'] === '+4000', JSON.stringify(odds));
}

// ── Finding the book's board without guessing at an id ───────────────────────
// The golf event-group id is not documented anywhere, and a guess at it fails
// exactly the way a wrong URL fails: silently, and indistinguishably from "the
// book had nothing". So the league PAGE is the entry point — a fact, not a
// guess — and the id is mined out of it.
console.log('\n── the league page is derived, not hardcoded ──');
{
  const urls = bookUrlsFor('BMW Championship');
  check('the tournament slug comes from nameToSlug',
    urls[0] === 'https://sportsbook.draftkings.com/leagues/golf/bmw-championship', urls[0]);
  check('there is a league-wide fallback for a slug that does not resolve',
    urls.some(u => u.endsWith('/golf/pga')), JSON.stringify(urls));
  // The symbol-dropping rule nameToSlug exists for: 'AT&T' must not become
  // 'at-t'. A literal slug would have been wrong the first week it mattered.
  check('a tournament with punctuation still slugs correctly',
    bookUrlsFor('AT&T Pebble Beach Pro-Am')[0].endsWith('/att-pebble-beach-pro-am'),
    bookUrlsFor('AT&T Pebble Beach Pro-Am')[0]);
  check('no tournament name yields no tournament URL',
    bookUrlsFor(null).length === 1);
}

console.log('\n── ids are read off the page ──');
{
  const html = `<html><body>
    <a href="/sites/US-SB/api/v5/eventgroups/9?format=json">Golf</a>
    <script>var x = {"eventGroupId":92483,"leagueId":"9"};</script>
  </body></html>`;
  const ids = eventGroupIds(html);
  check('an id in a linked API URL is found', ids.includes('9'), JSON.stringify(ids));
  check('an id in embedded state is found too', ids.includes('92483'), JSON.stringify(ids));
  check('duplicates across sources collapse',
    ids.length === new Set(ids).size, JSON.stringify(ids));
  check('the list is capped — every id costs a request', eventGroupIds(
    Array.from({ length: 40 }, (_, i) => `eventgroups/${1000 + i}`).join(' ')).length <= 6);
  check('a page naming no ids yields none', eventGroupIds('<html>nothing</html>').length === 0);

  // A sportsbook's nav names every sport it offers, so most ids on a golf page
  // belong to something else — the first real probe returned four, one of them
  // MLB. The caller can only afford to try a handful, so the plausible ones
  // have to come first.
  const nav = `
    <a href="/leagues/baseball/mlb">MLB</a><span data-eg="84240"></span>
    <a href="/leagues/basketball/nba">NBA</a><span data-eg="42648"></span>
    <div>Golf — BMW Championship</div><a href="/sites/US-SB/api/v5/eventgroups/79494">Golf</a>
  `.replace(/data-eg="(\d+)"/g, '"eventGroupId":$1');
  check('an id sitting near golf words ranks first',
    eventGroupIds(nav)[0] === '79494', JSON.stringify(eventGroupIds(nav)));
}

console.log('\n── a page that embeds its own board needs no id at all ──');
{
  const html = `<html><script type="application/json">${JSON.stringify({
    market: {
      label: 'Tournament Winner',
      outcomes: [
        { label: 'J.J. Spaun', oddsAmerican: '+4000' },
        { label: 'Matt McCarty', oddsAmerican: '+15000' },
        { label: 'Tommy Fleetwood', oddsAmerican: '+1900' },
      ],
    },
  })}</script></html>`;
  const rows = embeddedJson(html).flatMap(b => bookOddsRows(b));
  const odds = pickGapOdds(rows, fieldSet, ['J.J. Spaun', 'Matt McCarty']);
  check('the board is read straight out of the page',
    odds['J.J. Spaun'] === '+4000' && odds['Matt McCarty'] === '+15000', JSON.stringify(odds));
  check('a page with no JSON blobs yields nothing rather than throwing',
    embeddedJson('<html><script>not json at all</script></html>').length === 0);
}

// ── Discovery guards ─────────────────────────────────────────────────────────
// ESPN discovery fails SILENTLY everywhere it is used — the tee-time
// supplement and the odds gap-filler both just quietly do nothing — so these
// are source guards rather than behavioural tests. `oddsEspn: "no-event"` at
// the BMW Championship was the first time this path had ever said anything.
console.log('\n── discovery does not fail silently or expensively ──');
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../api/field.js', import.meta.url), 'utf8');

  // Every other golf endpoint ESPN serves is tour-scoped. The un-scoped form
  // is kept as a second attempt so this cannot regress a URL that works, but
  // the tour-scoped one has to be tried first.
  const scoped = src.indexOf('sports/golf/pga/leaderboard?event=');
  const legacy = src.indexOf('sports/golf/leaderboard?event=');
  check('the tour-scoped leaderboard URL exists', scoped !== -1);
  check('and is tried before the un-scoped one', scoped !== -1 && scoped < legacy);

  // A golf event spans four days, so a single-day `dates=` is a guess about
  // which day ESPN files it under. The bare endpoint just returns what is on.
  check('the bare scoreboard is tried before the dated scan',
    /scoreboard'\)/.test(src));

  // This runs on every origin miss now that any unpriced player triggers it.
  // A 15-day scan against an ESPN that is refusing us is pure latency inside a
  // function that still has pgatour.com and a sportsbook to get through. The
  // bound is asserted as a property, not a literal — the number is a judgement
  // call, an unbounded scan on this path is not.
  const bound = src.match(/findESPNEvent\(0, trace, (\d+)\)/);
  check('the odds path bounds its day scan', !!bound, 'no bounded call found');
  check('and the bound is small', bound && Number(bound[1]) <= 6,
    bound ? bound[1] : 'n/a');

  // The field/tee-time fallback must NOT be bounded the same way — if
  // pgatour.com fails, its scan is the only thing behind this endpoint.
  check('the field fallback keeps its full range',
    /findESPNEvent\(from\)/.test(src));

  // The whole path is wrapped in a swallow, so the trace is the only way a
  // failure can name its own step.
  check('a failed discovery reports which step failed',
    /no-event \(\$\{espnTraceSummary\(trace\)\}\)/.test(src));
}

// ── The probe is public and unauthenticated ─────────────────────────────────
// /api/field?debug=1&probe=<url> makes the deployed function fetch a URL and
// report on it, which is how a source written blind gets verified without a
// deploy per guess. It is also, if left open, an SSRF hole on an endpoint with
// no auth in front of it. Every rejection below happens BEFORE any fetch.
console.log('\n── the probe refuses everything it should ──');
{
  const rejected = async (input, why) => {
    const r = await probeUrl(input);
    check(why, !!r.error, JSON.stringify(r));
  };
  await rejected('not a url at all', 'a non-URL is refused');
  await rejected('http://sportsbook.draftkings.com/x', 'plain http is refused');
  await rejected('https://evil.example.com/x', 'an unlisted host is refused');
  // The classic allowlist bypass: a host that merely CONTAINS an allowed one.
  await rejected('https://draftkings.com.evil.example.com/x',
    'a lookalike host is refused');
  await rejected('file:///etc/passwd', 'a non-http scheme is refused');
  await rejected('https://169.254.169.254/latest/meta-data/',
    'the cloud metadata address is refused');

  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../api/field.js', import.meta.url), 'utf8');
  check('the probe is gated on debug mode',
    /isDebug && req\.query\.probe/.test(src));
  // It reports shape, never content — otherwise it is a proxy.
  check('the probe never returns the response body',
    !/body,\s*$/m.test(src.slice(src.indexOf('async function probeUrl'),
                                 src.indexOf('// ── Handler'))));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
