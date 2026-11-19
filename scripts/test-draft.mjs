// scripts/test-draft.mjs
// ============================================================================
// Keepers, the snake, pick trades, and the rollover.
//
// The rules under test are the ones a league argues about in February and
// cannot re-litigate in September, so they are asserted as statements rather
// than as implementation details:
//
//   • three stars closes the limited keeper slot; two does not
//   • a promoted unlimited player arrives on TWO stars, not one — the
//     retroactive star for his unlimited season is the rule most likely to be
//     quietly dropped by a refactor, and it costs a manager two keeper seasons
//     if it is
//   • the draft order is reverse standings and snakes EVERY round
//   • a traded pick follows the slot it was traded from, not an overall pick
//     number, so regenerating the board does not silently move it
//   • the rollover resets the limited-start counts, because that cap is per
//     season and the durable registry merges tallies upward
//
//   node scripts/test-draft.mjs
// ============================================================================

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

const D = await import('../api/_draft.js');
const { NameSet } = await import('../api/_playerNames.js');

const limited = (name, stars, extra = {}) => ({
  name, limited: true, unlimited: false, stars, yearsOfService: stars, starts: 9, ...extra,
});
const unlimited = (name, extra = {}) => ({
  name, limited: false, unlimited: true, stars: 0, yearsOfService: 1, starts: 4, ...extra,
});

// ── Stars ────────────────────────────────────────────────────────────────────
console.log('\nstars — what the badge says is what the rule reads');

test('a limited player stored on zero stars still reads as one', () => {
  // RostersView renders `'⭐'.repeat(player.stars || 1)`, so a row predating the
  // star field SHOWS one star. Reading the raw 0 would quietly hand him a
  // fourth keeper season.
  assert.equal(D.effectiveStars({ limited: true, stars: 0 }), 1);
  assert.equal(D.effectiveStars({ limited: true }), 1);
});

test('an unlimited player has no stars however the field is set', () => {
  assert.equal(D.effectiveStars(unlimited('x')), 0);
  assert.equal(D.effectiveStars({ limited: false, stars: 3 }), 0);
});

test('a roster entry with neither flag counts as unlimited', () => {
  // Rows written before the tier flags existed. limitedStartsStatus caps
  // `limited` players and nobody else, so "not limited" IS "no start cap".
  assert.equal(D.isUnlimitedTier({ name: 'Legacy Row' }), true);
  assert.equal(D.keeperStatus({ name: 'Legacy Row' }).unlimited.eligible, true);
});

// ── Keeper eligibility ───────────────────────────────────────────────────────
console.log('\nkeepers — three seasons, and the promotion');

test('three stars closes the limited slot', () => {
  const s = D.keeperStatus(limited('Maxed', 3));
  assert.equal(s.limited.eligible, false);
  assert.match(s.limited.reason, /3 stars/);
  assert.equal(D.canKeep(limited('Maxed', 3), 'limited'), false);
});

test('two stars does not — he is kept into his third and last season', () => {
  const s = D.keeperStatus(limited('OneLeft', 2));
  assert.equal(s.limited.eligible, true);
  assert.equal(s.limited.starsIfKept, 3);
});

test('a limited player can never fill the unlimited slot', () => {
  // Once limited, always limited — the same rule buildPlayerAttributeIndex
  // enforces on every drop and re-add.
  assert.equal(D.keeperStatus(limited('Yellow', 1)).unlimited.eligible, false);
  assert.equal(D.canKeep(limited('Yellow', 1), 'unlimited'), false);
});

test('promoting an unlimited player costs him TWO stars, not one', () => {
  const s = D.keeperStatus(unlimited('Blue'));
  assert.equal(s.limited.eligible, true);
  assert.equal(s.limited.promotion, true);
  assert.equal(s.limited.starsIfKept, 2, 'the retroactive star for his unlimited season is missing');
});

test('a promoted player has exactly one keeper season left after this one', () => {
  const promoted = D.keptPlayerAttrs(unlimited('Blue'), 'limited');
  assert.equal(promoted.stars, 2);
  assert.equal(D.keeperStatus(promoted).limited.eligible, true);
  const nextYear = D.keptPlayerAttrs(promoted, 'limited');
  assert.equal(nextYear.stars, 3);
  assert.equal(D.keeperStatus(nextYear).limited.eligible, false);
});

test('keeping resets the start count and advances years of service', () => {
  const kept = D.keptPlayerAttrs(limited('Kept', 1, { yearsOfService: 4, starts: 12 }), 'limited');
  assert.equal(kept.starts, 0, 'the limited-start cap is per season');
  assert.equal(kept.yearsOfService, 5);
  assert.equal(kept.stars, 2);
});

test('keeping an unlimited player in the unlimited slot leaves him unlimited', () => {
  const kept = D.keptPlayerAttrs(unlimited('Blue'), 'unlimited');
  assert.equal(kept.limited, false);
  assert.equal(kept.unlimited, true);
  assert.equal(kept.stars, 0);
});

test('career tallies survive the rollover; the season counter does not', () => {
  const kept = D.keptPlayerAttrs(
    unlimited('Blue', { sfglEarnings: 1_250_000, cutsMade: 14, eventsPlayed: 19, starts: 7 }),
    'unlimited',
  );
  assert.equal(kept.sfglEarnings, 1_250_000);
  assert.equal(kept.cutsMade, 14);
  assert.equal(kept.eventsPlayed, 19);
  assert.equal(kept.starts, 0);
});

test('an ineligible keeper throws rather than producing an illegal roster', () => {
  assert.throws(() => D.keptPlayerAttrs(limited('Maxed', 3), 'limited'), /cannot be kept/);
  assert.throws(() => D.keptPlayerAttrs(limited('Yellow', 1), 'unlimited'), /cannot be kept/);
});

// ── Drafted players ──────────────────────────────────────────────────────────
console.log('\nthe draft rounds — who comes out limited');

test('a limited round makes a golfer new to the league a one-star limited', () => {
  const p = D.draftedPlayerAttrs('Rookie', { round: 1, limitedRounds: 2, prior: null });
  assert.equal(p.limited, true);
  assert.equal(p.stars, 1);
  assert.equal(p.yearsOfService, 1);
});

test('a limited round promotes a former unlimited player onto two stars', () => {
  // Same rule as keeping him into the limited slot. Kept or re-drafted is not
  // a distinction the promotion rule draws.
  const p = D.draftedPlayerAttrs('Blue', { round: 2, limitedRounds: 2, prior: unlimited('Blue') });
  assert.equal(p.limited, true);
  assert.equal(p.stars, 2);
});

test('a later round drafts an unlimited player', () => {
  const p = D.draftedPlayerAttrs('Rookie', { round: 3, limitedRounds: 2, prior: null });
  assert.equal(p.limited, false);
  assert.equal(p.unlimited, true);
  assert.equal(p.stars, 0);
});

test('a limited player re-drafted late does NOT come back unlimited', () => {
  const p = D.draftedPlayerAttrs('Yellow', { round: 7, limitedRounds: 2, prior: limited('Yellow', 2) });
  assert.equal(p.limited, true, 'once limited, always limited');
  assert.equal(p.unlimited, false);
  assert.equal(p.stars, 3, 'another season of limited service is another star');
});

test('a re-drafted player past the cap is simply un-keepable, not un-draftable', () => {
  const p = D.draftedPlayerAttrs('Yellow', { round: 4, limitedRounds: 2, prior: limited('Yellow', 3) });
  assert.equal(p.stars, 4);
  assert.equal(D.keeperStatus(p).limited.eligible, false);
});

// ── Order ────────────────────────────────────────────────────────────────────
console.log('\nthe board — reverse standings, snaked');

const TEAMS = [
  { id: 'a', name: 'Alpha' }, { id: 'b', name: 'Bravo' },
  { id: 'c', name: 'Charlie' }, { id: 'd', name: 'Delta' },
];
const TOURNAMENTS = [{
  name: 'Finale', completed: true,
  results: { teams: { a: { totalEarnings: 400 }, b: { totalEarnings: 300 }, c: { totalEarnings: 200 }, d: { totalEarnings: 100 } } },
}];

test('standings come from the same derivation the season table displays', () => {
  const s = D.seasonStandings({ teams: TEAMS, tournaments: TOURNAMENTS });
  assert.deepEqual(s.map(r => r.teamId), ['a', 'b', 'c', 'd']);
  assert.deepEqual(s.map(r => r.position), [1, 2, 3, 4]);
});

test('last place picks first', () => {
  const order = D.draftOrderTeamIds(D.seasonStandings({ teams: TEAMS, tournaments: TOURNAMENTS }));
  assert.deepEqual(order, ['d', 'c', 'b', 'a']);
});

test('a tie breaks stably, so regenerating does not reshuffle the board', () => {
  const tied = [{
    name: 'Finale', completed: true,
    results: { teams: { a: { totalEarnings: 100 }, b: { totalEarnings: 100 } } },
  }];
  const once  = D.seasonStandings({ teams: TEAMS.slice(0, 2), tournaments: tied });
  const twice = D.seasonStandings({ teams: [...TEAMS.slice(0, 2)].reverse(), tournaments: tied });
  assert.deepEqual(once.map(r => r.teamId), twice.map(r => r.teamId));
});

test('the snake reverses every even round, limited rounds included', () => {
  const order = D.buildDraftOrder({ teamIds: ['d', 'c', 'b', 'a'], rounds: 3, limitedRounds: 2 });
  const round = (n) => order.filter(p => p.round === n).map(p => p.teamId);
  assert.deepEqual(round(1), ['d', 'c', 'b', 'a']);
  assert.deepEqual(round(2), ['a', 'b', 'c', 'd']);
  assert.deepEqual(round(3), ['d', 'c', 'b', 'a']);
});

test('overall numbering is contiguous and pick-in-round restarts each round', () => {
  const order = D.buildDraftOrder({ teamIds: ['d', 'c', 'b', 'a'], rounds: 3, limitedRounds: 2 });
  assert.deepEqual(order.map(p => p.overall), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.deepEqual(order.filter(p => p.round === 2).map(p => p.pickInRound), [1, 2, 3, 4]);
});

test('exactly the first two rounds are flagged limited', () => {
  const order = D.buildDraftOrder({ teamIds: ['d', 'c', 'b', 'a'], rounds: 5, limitedRounds: 2 });
  assert.deepEqual([...new Set(order.filter(p => p.limited).map(p => p.round))], [1, 2]);
});

test('the default round count fills the roster around the keepers', () => {
  assert.equal(D.defaultDraftRounds({ rosterLimit: 13 }), 11);
  assert.equal(D.defaultDraftRounds({ rosterLimit: 13, keeperSlots: 0 }), 13);
});

// ── Trades ───────────────────────────────────────────────────────────────────
console.log('\ntrades — a pick follows its slot, not its number');

const STATE = { orderTeamIds: ['d', 'c', 'b', 'a'], rounds: 4, limitedRounds: 2, trades: [] };

test('a traded pick changes hands and remembers where it came from', () => {
  const order = D.resolveDraftOrder({ ...STATE, trades: [{ round: 3, originalTeamId: 'd', toTeamId: 'a' }] });
  const slot = order.find(p => p.round === 3 && p.originalTeamId === 'd');
  assert.equal(slot.teamId, 'a');
  assert.equal(slot.originalTeamId, 'd', 'the board can no longer say the trade happened');
});

test('a trade survives the board being regenerated with a different order', () => {
  // Keyed on {round, originalTeamId}, not on an overall number. A commissioner
  // settling a tie must not slide every recorded trade onto the wrong pick.
  const trades = [{ round: 2, originalTeamId: 'b', toTeamId: 'a' }];
  const before = D.resolveDraftOrder({ ...STATE, trades });
  const after  = D.resolveDraftOrder({ ...STATE, orderTeamIds: ['a', 'b', 'c', 'd'], trades });
  const pick = (o) => o.find(p => p.round === 2 && p.originalTeamId === 'b');
  assert.equal(pick(before).teamId, 'a');
  assert.equal(pick(after).teamId, 'a');
  assert.notEqual(pick(before).overall, pick(after).overall, 'fixture no longer moves the pick');
});

test('a pick flipped twice ends with its last owner', () => {
  const order = D.resolveDraftOrder({ ...STATE, trades: [
    { round: 1, originalTeamId: 'd', toTeamId: 'c' },
    { round: 1, originalTeamId: 'd', toTeamId: 'b' },
  ] });
  assert.equal(order.find(p => p.round === 1 && p.originalTeamId === 'd').teamId, 'b');
});

test('a trade naming a round that no longer exists is ignored, not fatal', () => {
  // Shortening the draft must never make the board unbuildable.
  const order = D.resolveDraftOrder({ ...STATE, rounds: 2, trades: [{ round: 9, originalTeamId: 'd', toTeamId: 'a' }] });
  assert.equal(order.length, 8);
});

test('a team owns the picks traded TO it', () => {
  const order = D.resolveDraftOrder({ ...STATE, trades: [{ round: 1, originalTeamId: 'd', toTeamId: 'a' }] });
  assert.equal(D.picksForTeam(order, 'a').length, 5);
  assert.equal(D.picksForTeam(order, 'd').length, 3);
});

// ── The clock ────────────────────────────────────────────────────────────────
console.log('\nthe clock');

test('the clock is the lowest UNMADE slot, not the one after the last made', () => {
  // A commissioner correcting pick 2 deletes it; the clock has to go back to
  // it rather than sail past a hole in the board.
  const order = D.buildDraftOrder({ teamIds: ['d', 'c'], rounds: 2, limitedRounds: 1 });
  const picks = [{ overall: 1, player: 'One' }, { overall: 3, player: 'Three' }];
  assert.equal(D.currentPick(order, picks).overall, 2);
});

test('a full board has nobody on the clock', () => {
  const order = D.buildDraftOrder({ teamIds: ['d', 'c'], rounds: 1, limitedRounds: 1 });
  assert.equal(D.currentPick(order, [{ overall: 1 }, { overall: 2 }]), null);
});

test('pick labels are round.pick, zero-padded', () => {
  assert.equal(D.pickLabel({ round: 3, pickInRound: 2 }), 'R3.02');
});

// ── Rollover ─────────────────────────────────────────────────────────────────
console.log('\nrollover — keepers plus picks becomes the new roster');

const TEAM = {
  id: 'a', name: 'Alpha',
  lineup: ['Old Guy'], backup: 'Bench Guy',
  earnings: 500, segmentEarnings: 100, segmentFees: 8, transactionFees: 8,
  roster: [limited('Yellow One', 1), unlimited('Blue One'), limited('Maxed', 3)],
};

test('the new roster is the two keepers followed by the picks, in board order', () => {
  const roster = D.rolloverRoster({
    team: TEAM,
    keepers: { limited: 'Yellow One', unlimited: 'Blue One' },
    picks: [
      { overall: 5, round: 2, player: 'Second Pick' },
      { overall: 1, round: 1, player: 'First Pick' },
    ],
    limitedRounds: 2,
  });
  assert.deepEqual(roster.map(p => p.name), ['Yellow One', 'Blue One', 'First Pick', 'Second Pick']);
  assert.deepEqual(roster.map(p => p.limited), [true, false, true, true]);
  assert.deepEqual(roster.map(p => p.stars), [2, 0, 1, 1]);
});

test('a keeper is matched by player identity, not by string equality', () => {
  // The tag stores the name the manager saw; the roster entry may be spelled
  // by whichever source last wrote it. `===` on a golfer name is the bug this
  // codebase keeps re-fixing.
  const team = { id: 'b', name: 'Bravo', roster: [unlimited('Nicolas Echavarria')] };
  const roster = D.rolloverRoster({ team, keepers: { unlimited: 'Nico Echavarria' } });
  assert.deepEqual(roster.map(p => p.name), ['Nicolas Echavarria']);
});

test('one player cannot be tagged in both slots', () => {
  const team = { id: 'c', name: 'Charlie', roster: [unlimited('Blue One')] };
  assert.throws(
    () => D.rolloverRoster({ team, keepers: { limited: 'Blue One', unlimited: 'Blue One' } }),
    /both keeper slots/,
  );
});

test('a keeper who is not on the roster is refused, not silently dropped', () => {
  assert.throws(
    () => D.rolloverRoster({ team: TEAM, keepers: { limited: 'Nobody At All' } }),
    /not on the roster/,
  );
});

test('an untagged slot simply produces a shorter roster', () => {
  const roster = D.rolloverRoster({ team: TEAM, keepers: { unlimited: 'Blue One' }, picks: [] });
  assert.deepEqual(roster.map(p => p.name), ['Blue One']);
});

test('prior attributes are resolved by identity, so a promotion is not lost', () => {
  // The pool comes from OWGR and the registry is keyed by the roster spelling.
  // A bare registry[name] reads 'Nico Echavarria' as new to the league, which
  // costs him the retroactive star and — for a limited player — would reset him
  // to unlimited.
  const priorOf = D.registryLookup({ 'Nicolas Echavarria': unlimited('Nicolas Echavarria') });
  assert.equal(priorOf('Nico Echavarria')?.name, 'Nicolas Echavarria');
  assert.equal(priorOf('Somebody Else'), null);

  const drafted = D.draftedPlayerAttrs('Nico Echavarria', {
    round: 1, limitedRounds: 2, prior: priorOf('Nico Echavarria'),
  });
  assert.equal(drafted.stars, 2, 'the retroactive star was lost to a spelling');
});

test('a re-drafted limited player keeps his tier through a name variant', () => {
  const priorOf = D.registryLookup({ 'Nicolas Echavarria': limited('Nicolas Echavarria', 2) });
  const drafted = D.draftedPlayerAttrs('Nico Echavarria', {
    round: 6, limitedRounds: 2, prior: priorOf('Nico Echavarria'),
  });
  assert.equal(drafted.limited, true, 'once limited, always limited');
  assert.equal(drafted.stars, 3);
});

test('the team document is cleared of everything the season accumulated', () => {
  const next = D.rolloverTeam({ team: TEAM, roster: [], mulligans: { regular: 1 } });
  assert.deepEqual(next.lineup, []);
  assert.equal('backup' in next, false, 'a leftover backup would point at a player who is gone');
  assert.equal(next.earnings, 0);
  assert.equal(next.segmentEarnings, 0);
  assert.equal(next.segmentFees, 0);
  assert.equal(next.transactionFees, 0);
  assert.deepEqual(next.mulligans, { regular: 1 });
  assert.equal(next.keepers, null, 'last season’s tags would pre-fill the next rollover');
  assert.equal(next.id, 'a', 'identity survives');
});

test('the registry overrides force the start counts back down to zero', () => {
  // The durable registry merges tallies with Math.max, so a roster reset to
  // zero is pulled straight back up on the next team save without these.
  const overrides = D.rolloverRegistryOverrides([[
    { name: 'Yellow One', limited: true, unlimited: false, stars: 2, yearsOfService: 3 },
  ]]);
  assert.equal(overrides['Yellow One'].starts, 0);
  assert.equal(overrides['Yellow One'].stars, 2);
  assert.equal(overrides['Yellow One'].limited, true);
});

// ── Star corrections ─────────────────────────────────────────────────────────
console.log('\nstar corrections — making a monotonic tally go DOWN');

test('a correction force-sets the tier fields', () => {
  const o = D.starCorrectionOverrides([limited('Yellow', 2)]);
  assert.equal(o.Yellow.stars, 2);
  assert.equal(o.Yellow.limited, true);
  assert.equal(o.Yellow.unlimited, false);
});

test('a correction leaves the season start count ALONE', () => {
  // The distinction from rolloverRegistryOverrides, which zeroes it because a
  // rollover begins a new season. Correcting a star count before the rollover
  // must not rewrite what the closing season actually played — the archive and
  // the limited-start audit both still read it.
  const o = D.starCorrectionOverrides([limited('Yellow', 2, { starts: 9 })]);
  assert.equal('starts' in o.Yellow, false);
  const r = D.rolloverRegistryOverrides([[limited('Yellow', 2, { starts: 9 })]]);
  assert.equal(r.Yellow.starts, 0, 'fixture no longer contrasts the two');
});

test('a correction never demotes a limited player', () => {
  // Once limited, always limited. A zero would read as a demotion, so the
  // floor is one star however the caller asks.
  const o = D.starCorrectionOverrides([{ name: 'Yellow', limited: true, stars: 0 }]);
  assert.equal(o.Yellow.limited, true);
  assert.equal(o.Yellow.stars, 1);
});

test('a correction can promote an unlimited player the sheet has as limited', () => {
  const o = D.starCorrectionOverrides([{ name: 'Blue', limited: true, stars: 2 }]);
  assert.equal(o.Blue.limited, true);
  assert.equal(o.Blue.stars, 2);
});

test('an unlimited player keeps zero stars', () => {
  const o = D.starCorrectionOverrides([unlimited('Blue')]);
  assert.equal(o.Blue.limited, false);
  assert.equal(o.Blue.unlimited, true);
  assert.equal(o.Blue.stars, 0);
});

test('the override is what survives the registry max-merge', () => {
  // Reproduces the merge in buildPlayerAttributeIndex: without the override a
  // decrease is read straight back out of the registry on the next save.
  const registry = { Yellow: { limited: true, stars: 3 } };
  const rosterEntry = { name: 'Yellow', limited: true, stars: 2 };   // corrected down
  const merged = { stars: Math.max(registry.Yellow.stars ?? 0, rosterEntry.stars ?? 0) };
  assert.equal(merged.stars, 3, 'the merge is what loses the correction');

  const o = D.starCorrectionOverrides([rosterEntry]);
  const after = { ...merged, ...o.Yellow };
  assert.equal(after.stars, 2, 'the override must win');
});

// ── The 2026 seed ────────────────────────────────────────────────────────────
console.log('\nthe 2026 seed — the sheet is the only honest copy of the count');

const seedMod = await import('../src/pages/admin/keeperSeed2026.js');

test('the generated seed is in step with the sheet fixture', () => {
  // Regenerated by scripts/derive-keeper-seed-2026.mjs; this fails when the
  // fixture is refreshed and the seed is not.
  const sheet = JSON.parse(readFileSync('scripts/fixtures/sheet-state-2026.json', 'utf8'));
  const fromSheet = Object.values(sheet.rosters)
    .flat()
    .filter(p => String(p?.keeper ?? '').trim())
    .length;
  assert.equal(seedMod.KEEPER_SEED_2026.length, fromSheet);
});

test('every team carries three limited players — one kept, two drafted', () => {
  // The structure the draft defaults assume: keep 1 limited + 1 unlimited,
  // then 11 rounds with the first 2 limited gives 3 limited and 10 unlimited
  // on a 13-man roster. If the sheet ever stops agreeing, the round defaults
  // are wrong and this is where it shows.
  const byTeam = {};
  seedMod.KEEPER_SEED_2026.forEach(r => { byTeam[r.teamId] = (byTeam[r.teamId] || 0) + 1; });
  assert.deepEqual([...new Set(Object.values(byTeam))], [3]);
  const rounds = D.defaultDraftRounds({ rosterLimit: 13 });
  assert.equal(1 + D.DEFAULT_LIMITED_ROUNDS, 3, 'kept limited + limited rounds must equal the sheet');
  assert.equal(1 + (rounds - D.DEFAULT_LIMITED_ROUNDS), 10, 'kept unlimited + remaining rounds');
});

test('no seeded count exceeds the keeper cap', () => {
  const over = seedMod.KEEPER_SEED_2026.filter(r => r.stars > D.KEEPER_MAX_STARS);
  assert.deepEqual(over, []);
});

test('the players at the cap are the ones who cannot be kept', () => {
  const capped = seedMod.KEEPER_SEED_2026
    .filter(r => r.stars >= D.KEEPER_MAX_STARS)
    .map(r => r.player)
    .sort();
  assert.deepEqual(capped, ['Hideki Matsuyama', 'Rory McIlroy', 'Scottie Scheffler', 'Tommy Fleetwood']);
  capped.forEach(name => {
    const row = seedMod.KEEPER_SEED_2026.find(r => r.player === name);
    assert.equal(D.keeperStatus(limited(name, row.stars)).limited.eligible, false);
  });
});

test('a seeded name resolves onto a roster spelling by identity', () => {
  // 'Ludvig Åberg' and 'Nicolai Højgaard' are why the step matches through
  // NameSet: a string compare would report them as off-roster and offer to
  // seed a duplicate.
  const roster = new NameSet(['Ludvig Aberg', 'Keegan Bradley']);
  assert.equal(roster.resolve('Ludvig Åberg'), 'Ludvig Aberg');
});

// ── Source guards ────────────────────────────────────────────────────────────
console.log('\nguards — one copy of each rule');

const draftSrc    = readFileSync('api/_draft.js', 'utf8');
const keeperModal = readFileSync('src/pages/KeeperTagModal.jsx', 'utf8');
const draftModal  = readFileSync('src/pages/DraftModal.jsx', 'utf8');
const rollover    = readFileSync('src/pages/admin/SeasonRolloverPanel.jsx', 'utf8');

test('api/_draft.js stays importable from a serverless function', () => {
  // The moment it reaches into src/ it stops being shared and becomes a copy.
  assert.equal(/from '\.\.\/src\//.test(draftSrc), false);
  assert.equal(/require\(/.test(draftSrc), false);
});

test('the keeper ceiling is named once', () => {
  const literals = (draftSrc.match(/maxStars\s*=\s*3|>=\s*3\b/g) || []);
  assert.deepEqual(literals, [], 'the cap must come from KEEPER_MAX_STARS');
  assert.equal(D.KEEPER_MAX_STARS, 3);
});

test('the UI asks _draft.js for eligibility rather than re-deriving it', () => {
  assert.match(keeperModal, /from '\.\.\/\.\.\/api\/_draft\.js'/);
  assert.match(keeperModal, /keeperStatus/);
  assert.equal(/\.stars\s*[<>]=?\s*\d/.test(keeperModal), false, 'star arithmetic leaked into the view');
  assert.equal(/\.stars\s*[<>]=?\s*\d/.test(rollover), false, 'star arithmetic leaked into the panel');
});

test('the draft screen previews a pick with the function the rollover applies', () => {
  // The tier shown on the confirm button and the tier written to the roster
  // have to be one computation, or the board lies about what it is doing.
  assert.match(draftModal, /draftedPlayerAttrs/);
  assert.match(rollover, /rolloverRoster/);
});

test('the years-of-service step force-sets through the CORRECTION override', () => {
  const step = readFileSync('src/pages/admin/KeeperYearsStep.jsx', 'utf8');
  // Not rolloverRegistryOverrides: that one zeroes `starts`, which would
  // rewrite what the closing season actually played.
  assert.match(step, /starCorrectionOverrides/);
  assert.equal(/rolloverRegistryOverrides/.test(step), false);
  // And it has to reach updateTeams WITH them — a plain save loses a decrease.
  assert.match(step, /updateTeams\(nextTeams, starCorrectionOverrides\(corrected\)\)/);
});

test('the step matches seed names to roster names by identity', () => {
  const step = readFileSync('src/pages/admin/KeeperYearsStep.jsx', 'utf8');
  assert.match(step, /new NameSet\(/);
  assert.match(step, /resolver\.resolve\(seed\.player\)/);
});

test('the seed file is generated, and says so', () => {
  const seed = readFileSync('src/pages/admin/keeperSeed2026.js', 'utf8');
  assert.match(seed, /GENERATED — do not edit by hand/);
  assert.match(seed, /derive-keeper-seed-2026\.mjs/);
});

test('picks are read with a where clause and sorted in JS, never ordered by', () => {
  // orderBy silently EXCLUDES documents missing the ordered field — the trap
  // that once made the whole tournaments collection read as empty, and a pick
  // written by an older client is exactly the document that would go missing.
  const code = readFileSync('src/api/firebase.js', 'utf8')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');
  assert.equal(/orderBy\('overall'/.test(code), false);
  assert.match(code, /where\('season', '==', Number\(season\)\)/);
});

console.log(`\n${passed} assertions passed\n`);
