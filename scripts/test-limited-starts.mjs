// Guard: a limited player who is out of starts cannot be started, and the
// number that blocks them is the number the manager was shown.
//
// The bug this exists to prevent: the roster table rendered a limited player's
// starts from tournament results (`sfglStatsMap[name].starts`) while the
// lineup gate compared the stored `player.starts` tally against a hard-coded
// 12. Those are two numbers and one hard-coded cap, so the view could read
// 12/12 beside a player the gate would happily add — and when the gate DID
// refuse, the tap fell through a `canAddToLineup` check that returned before
// reaching the code holding the message, so nothing was said either way.
//
// limitedStartsStatus is now the single answer to "how many starts have they
// used, what is the cap, are they done". Both the badge and the gate call it.
import {
  limitedStartsStatus, maxLimitedStarts, startsUsedByPlayer, eligibleStarters,
  isLimitedPlayer, DEFAULT_MAX_LIMITED_STARTS,
} from '../api/_rules.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') =>
  cond ? (pass++, console.log('  ok   ' + name))
       : (fail++, console.log('  FAIL ' + name + ' ' + extra));

const limited = (starts) => ({ name: 'A Golfer', limited: true, starts });

console.log('\n── the cap ──');
{
  check('defaults to twelve', maxLimitedStarts() === 12 && DEFAULT_MAX_LIMITED_STARTS === 12);
  check('the commish can raise it', maxLimitedStarts({ maxLimitedStarts: 15 }) === 15);
  check('the commish can lower it', maxLimitedStarts({ maxLimitedStarts: 8 }) === 8);
  // league_settings is a Firestore doc edited through a text input; a blank or
  // half-typed field must not read as "no starts allowed for anyone".
  check('a blank setting falls back to the default', maxLimitedStarts({ maxLimitedStarts: '' }) === 12);
  check('zero falls back to the default', maxLimitedStarts({ maxLimitedStarts: 0 }) === 12);
  check('nonsense falls back to the default', maxLimitedStarts({ maxLimitedStarts: 'twelve' }) === 12);
}

console.log('\n── who is out of starts ──');
{
  check('under the cap is fine', limitedStartsStatus(limited(11)).outOfStarts === false);
  check('AT the cap is out — the twelfth start is the last one',
    limitedStartsStatus(limited(12)).outOfStarts === true);
  check('over the cap is out', limitedStartsStatus(limited(13)).outOfStarts === true);
  check('a lowered cap takes effect immediately',
    limitedStartsStatus(limited(9), { settings: { maxLimitedStarts: 8 } }).outOfStarts === true);
  check('a raised cap gives the starts back',
    limitedStartsStatus(limited(12), { settings: { maxLimitedStarts: 15 } }).outOfStarts === false);
}

console.log('\n── only limited players have a cap ──');
{
  check('an unlimited player is never out of starts',
    limitedStartsStatus({ name: 'B', unlimited: true, starts: 40 }).outOfStarts === false);
  check('a plain rostered player is never out of starts',
    limitedStartsStatus({ name: 'C', starts: 40 }).outOfStarts === false);
  // The caller gates on outOfStarts alone, so a missing player must not read
  // as blocked — that would empty every lineup slot it touched.
  check('a missing player is not blocked', limitedStartsStatus(undefined).outOfStarts === false);
  check('a player with no tally is not blocked', limitedStartsStatus(limited(undefined)).outOfStarts === false);
}

console.log('\n── the two counts, reconciled ──');
{
  // The stored tally missed an increment (this is the sfglEarnings drift, in
  // its starts-shaped form); results say twelve. Twelve wins, and the badge
  // showing 12/12 is now telling the truth about what the gate will do.
  check('a stale stored tally loses to the derived count',
    limitedStartsStatus(limited(9), { derivedStarts: 12 }).outOfStarts === true);
  // The derived count is scoped to ONE team's results, so starts a player
  // spent on a previous roster are missing from it. The durable tally carries
  // those, and a player does not get those starts back by changing hands.
  check('a team-scoped derived count loses to the durable tally',
    limitedStartsStatus(limited(12), { derivedStarts: 3 }).outOfStarts === true);
  check('used is the higher of the two',
    limitedStartsStatus(limited(4), { derivedStarts: 7 }).used === 7);
  check('remaining counts down from the cap',
    limitedStartsStatus(limited(4), { derivedStarts: 7 }).remaining === 5);
  check('remaining floors at zero rather than going negative',
    limitedStartsStatus(limited(20)).remaining === 0);
}

console.log('\n── what counts as a start ──');
{
  // Lineup editing reopens Sunday 9pm ET and results process Monday, so for
  // most of a day the newest start exists only as a locked lineup: no stored
  // results, and player.starts not yet incremented. A cap that counts scored
  // starts alone is one short for that whole window — which is exactly long
  // enough for a manager to spend a start they no longer have.
  const teams = [{ id: 'w1', name: 'World #1' }];
  const scored = (names) => ({
    name: 'Played Open', completed: true,
    results: { teams: { w1: { players: names.map(n => ({ name: n, earnings: 100 })) } },
               fullLineups: { w1: names } },
  });
  const locked = (names) => ({ name: 'Locked Open', lockedLineups: { w1: names } });
  const used = (tournaments, transactions = []) =>
    startsUsedByPlayer({ teams, tournaments, transactions });

  check('a scored event counts', used([scored(['A', 'B'])]).get('A') === 1);
  check('a locked but unprocessed event counts too', used([locked(['A'])]).get('A') === 1);
  check('scored and locked events add up', used([scored(['A']), locked(['A'])]).get('A') === 2);
  // A processed event has BOTH stored results and a lockedLineups entry — it
  // is the same start, and counting it twice would bar a player four events
  // early.
  check('a processed event is not counted twice',
    used([{ ...scored(['A']), lockedLineups: { w1: ['A'] } }]).get('A') === 1);
  // team.lineup is deliberately not counted: before lock the manager can still
  // take the player out, so it is not a start yet.
  check('an unlocked live lineup is not a start',
    used([{ name: 'Next Open' }]).get('A') === undefined);
  check('a starter who earned nothing still started',
    used([{ name: 'X', completed: true, results: { teams: { w1: { players: [] } }, fullLineups: { w1: ['A'] } } }]).get('A') === 1);
  check('no teams, no counts', startsUsedByPlayer({ tournaments: [locked(['A'])] }).get('A') === undefined);
  check('missing input is safe', startsUsedByPlayer().get('A') === undefined);
}

console.log('\n── the cap follows the player, not the roster ──');
{
  // A limited player dropped by one team and picked up by another does not get
  // their starts back. Counting per team would hand out a fresh twelve with
  // every transaction.
  const teams = [{ id: 'w1' }, { id: 'drc' }];
  const ev = (teamId, name) => ({
    name: `${teamId} event ${name}`, completed: true,
    results: { teams: { [teamId]: { players: [{ name, earnings: 1 }] } }, fullLineups: { [teamId]: [name] } },
  });
  const tournaments = [ev('w1', 'A'), ev('w1', 'A'), ev('drc', 'A')];
  check('starts spent on a previous roster still count',
    startsUsedByPlayer({ teams, tournaments }).get('A') === 3);
  check('asking about one team sees only that team',
    startsUsedByPlayer({ teams: [{ id: 'drc' }], tournaments }).get('A') === 1);
}

console.log('\n── stopping the count at an event ──');
{
  const teams = [{ id: 'w1' }];
  const ev = (name) => ({
    name, completed: true,
    results: { teams: { w1: { players: [{ name: 'A', earnings: 1 }] } }, fullLineups: { w1: ['A'] } },
  });
  const tournaments = [ev('one'), ev('two'), ev('three')];
  check('beforeIndex is exclusive',
    startsUsedByPlayer({ teams, tournaments, beforeIndex: 2 }).get('A') === 2);
  check('beforeIndex 0 counts nothing',
    startsUsedByPlayer({ teams, tournaments, beforeIndex: 0 }).get('A') === undefined);
  check('no beforeIndex counts everything',
    startsUsedByPlayer({ teams, tournaments }).get('A') === 3);
}

console.log('\n── mulligans move the start ──');
{
  const teams = [{ id: 'w1', name: 'World #1' }];
  const mull = (out, inP, tournament) => ({
    type: 'mulligan', teamId: 'w1', tournament, droppedPlayer: out, player: inP, status: 'completed',
  });
  const used = (tournaments, transactions) => startsUsedByPlayer({ teams, tournaments, transactions });

  const lockedEvent = [{ name: 'Locked Open', lockedLineups: { w1: ['A', 'B'] } }];
  check('the mulliganed-out player gets the start back',
    used(lockedEvent, [mull('A', 'C', 'Locked Open')]).get('A') === undefined);
  check('the mulliganed-in player spends one',
    used(lockedEvent, [mull('A', 'C', 'Locked Open')]).get('C') === 1);
  check('a failed mulligan moves nothing',
    used(lockedEvent, [{ ...mull('A', 'C', 'Locked Open'), status: 'failed' }]).get('A') === 1);
  // Stored results already reflect an applied mulligan, so only the OUT player
  // needs removing there — adding IN again would double-count them.
  const scoredEvent = [{
    name: 'Played Open', completed: true,
    results: { teams: { w1: { players: [{ name: 'C', earnings: 5 }] } }, fullLineups: { w1: ['C'] } },
  }];
  check('a scored mulligan counts the IN player once',
    used(scoredEvent, [mull('A', 'C', 'Played Open')]).get('C') === 1);
  check("another team's mulligan cannot erase this team's start",
    used(lockedEvent, [{ ...mull('A', 'C', 'Locked Open'), teamId: 'drc' }]).get('A') === 1);
}

console.log('\n── the Sunday-night window ──');
{
  // The scenario in full: eleven scored starts, a twelfth locked and played
  // but not yet processed, and a manager setting next week's lineup at 10pm
  // Sunday. Every stored number still says eleven.
  const teams = [{ id: 'w1' }];
  const tournaments = [
    ...Array.from({ length: 11 }, (_, i) => ({
      name: `Event ${i}`, completed: true,
      results: { teams: { w1: { players: [{ name: 'Limited Larry', earnings: 1 }] } },
                 fullLineups: { w1: ['Limited Larry'] } },
    })),
    { name: 'Just Played', lockedLineups: { w1: ['Limited Larry'] } },
  ];
  const player = { name: 'Limited Larry', limited: true, starts: 11 };
  const status = limitedStartsStatus(player, {
    derivedStarts: startsUsedByPlayer({ teams, tournaments }).get('Limited Larry'),
    settings: {},
  });
  check('the pending twelfth start is counted', status.used === 12);
  check('and the thirteenth is refused', status.outOfStarts === true);
}

console.log('\n── a maxed player cannot score ──');
{
  // Everything upstream can be walked past: a manager leaves a maxed player in
  // through Thursday's lock, or a commish edits the lineup. Scoring refuses.
  const larry = { name: 'Limited Larry', limited: true, starts: 0 };
  const steady = { name: 'Unlimited Ursula', unlimited: true };
  const teams = [{ id: 'w1', roster: [larry, steady] }];
  const played = (n) => ({
    name: `Event ${n}`, completed: true,
    results: { teams: { w1: { players: [{ name: 'Limited Larry', earnings: 1, limited: true }] } },
               fullLineups: { w1: ['Limited Larry'] } },
  });
  const history = Array.from({ length: 12 }, (_, i) => played(i));
  const schedule = [...history, { name: 'This Week' }];
  const call = (over = {}) => eligibleStarters({
    lineup: ['Limited Larry', 'Unlimited Ursula'],
    teams, tournaments: schedule, tournamentIndex: 12, ...over,
  });

  check('the maxed player is dropped from the scoring five',
    call().starters.join() === 'Unlimited Ursula');
  check('and is reported, with the count that barred them',
    call().ineligible.length === 1 &&
    call().ineligible[0].name === 'Limited Larry' &&
    call().ineligible[0].used === 12 && call().ineligible[0].max === 12);
  check('everyone else still scores', call().starters.includes('Unlimited Ursula'));

  // One start short of the cap is still a start.
  const eleven = [...history.slice(0, 11), { name: 'This Week' }];
  check('a player with one start left scores',
    eligibleStarters({ lineup: ['Limited Larry'], teams, tournaments: eleven, tournamentIndex: 11 })
      .starters.length === 1);

  // An unlimited player has no cap however many events they have played.
  check('an unlimited player is never ineligible',
    eligibleStarters({
      lineup: ['Unlimited Ursula'],
      teams: [{ id: 'w1', roster: [steady] }],
      tournaments: schedule, tournamentIndex: 12,
    }).ineligible.length === 0);

  check('a raised cap lets them score', call({ settings: { maxLimitedStarts: 15 } }).ineligible.length === 0);
  check('a lowered cap bars them earlier',
    eligibleStarters({ lineup: ['Limited Larry'], teams, tournaments: eleven, tournamentIndex: 11, settings: { maxLimitedStarts: 10 } })
      .ineligible.length === 1);
}

console.log('\n── reprocessing reproduces history, it does not re-judge it ──');
{
  // THE trap. player.starts is a season-to-date total, so judging event 3 by
  // it in December would throw out a lineup that was entirely legal in March.
  // Eligibility is counted as of the event, which is why the durable tally is
  // not consulted here.
  const larry = { name: 'Limited Larry', limited: true, starts: 12 };
  const teams = [{ id: 'w1', roster: [larry] }];
  const played = (n) => ({
    name: `Event ${n}`, completed: true,
    results: { teams: { w1: { players: [{ name: 'Limited Larry', earnings: 1, limited: true }] } },
               fullLineups: { w1: ['Limited Larry'] } },
  });
  const season = Array.from({ length: 12 }, (_, i) => played(i));

  check('a legal early event survives a reprocess in December',
    eligibleStarters({ lineup: ['Limited Larry'], teams, tournaments: season, tournamentIndex: 3 })
      .ineligible.length === 0);
  check('and the thirteenth event is still refused',
    eligibleStarters({ lineup: ['Limited Larry'], teams, tournaments: [...season, { name: 'Thirteenth' }], tournamentIndex: 12 })
      .ineligible.length === 1);
  // Without a schedule position there is no "before", and the event being
  // scored would count against itself. Fail open rather than strip a lineup.
  check('no schedule position means no judgement',
    eligibleStarters({ lineup: ['Limited Larry'], teams, tournaments: season }).ineligible.length === 0);
  check('failing open keeps the whole lineup',
    eligibleStarters({ lineup: ['Limited Larry'], teams, tournaments: season }).starters.length === 1);
}

console.log('\n── who counts as limited ──');
{
  check('a roster entry says so',
    isLimitedPlayer('A', { teams: [{ roster: [{ name: 'A', limited: true }] }] }) === true);
  // Limited status never lapses, so a dropped player is still limited — the
  // results snapshots are the durable record buildPlayerAttributeIndex uses.
  check('results history remembers a dropped player',
    isLimitedPlayer('A', {
      teams: [{ roster: [] }],
      tournaments: [{ results: { teams: { w1: { players: [{ name: 'A', limited: true }] } } } }],
    }) === true);
  check('an ordinary player is not limited',
    isLimitedPlayer('A', { teams: [{ roster: [{ name: 'A' }] }] }) === false);
  check('an unknown name is not limited', isLimitedPlayer('A', {}) === false);
  check('no name is not limited', isLimitedPlayer(null, {}) === false);
}

console.log('\n── the other doors into a starting lineup ──');
{
  const modal = readFileSync(new URL('../src/pages/AddTransactionModal.jsx', import.meta.url), 'utf8');
  // A mulligan IN puts a player in the five that score, so it is a start and
  // the cap applies. Nothing checked it before.
  check('a mulligan in is capped too',
    /limitedStartsStatus/.test(modal) && /A mulligan in is a start/.test(modal));

  // starts and sfglEarnings must be credited to the five that were SCORED.
  // The cron read team.lineup — the LIVE five — which in the Sunday-night
  // window is next week's, so the start landed on the wrong players and the
  // ones who actually teed off were never charged.
  const cron = readFileSync(new URL('../api/cron.js', import.meta.url), 'utf8');
  check('the cron credits starts to the lineup that scored',
    /if \(!eligibleLineup\.includes\(player\.name\)\) return player;/.test(cron));
  check('the cron filters the frozen five through the cap',
    /eligibleStarters\(\{/.test(cron));
  check('the cron no longer gates scoring on the live lineup',
    !/if \(!team\.lineup \|\| team\.lineup\.length === 0\) return team;/.test(cron));

  // A team that scores four with no explanation reads as a processing bug.
  const results = readFileSync(new URL('../src/pages/TournamentsView.jsx', import.meta.url), 'utf8');
  check('the result says why a starter is missing',
    /tr\.ineligible/.test(results) && /out of starts/.test(results));

  const client = readFileSync(new URL('../src/pages/admin/processTournamentData.js', import.meta.url), 'utf8');
  check('the client twin credits starts to the same lineup',
    /if \(!eligibleLineup\.includes\(player\.name\)\) return player;/.test(client));
  check('the client twin filters through the same cap',
    /eligibleStarters\(\{/.test(client));
  check('the client twin gates on it too',
    !/if \(!team\.lineup \|\| team\.lineup\.length === 0\) return team;/.test(client));
}

console.log('\n── the view reads the rule, not its own copy ──');
{
  const view = readFileSync(new URL('../src/pages/RostersView.jsx', import.meta.url), 'utf8');
  check('RostersView imports limitedStartsStatus',
    /import\s*\{[^}]*limitedStartsStatus[^}]*\}\s*from\s*'\.\.\/\.\.\/api\/_rules\.js'/.test(view));
  // Either of these coming back means the badge and the gate have started
  // deriving the cap separately again, which is the whole bug.
  check('RostersView holds no cap of its own',
    !/maxLimitedStarts\s*\?\?/.test(view) && !/MAX_LIMITED_STARTS\s*=/.test(view));
  check('RostersView compares no raw starts tally against a cap',
    !/\.starts\s*[<>]=?\s*MAX_LIMITED_STARTS/.test(view));
  // The refusal has to reach the manager. It lives in the toast; a silently
  // swallowed tap is what shipped before.
  check('the block tells the manager why', /out of starts —/.test(view));

  // The add-time block cannot catch a lineup that was already legal when it
  // was set and went over the cap while sitting there — Sunday 9pm to Monday.
  // A banner over the lineup is the only thing standing in that gap.
  check('a starter over the cap is called out on the roster page',
    /outOfStartsStarters/.test(view) && /Out of starts/.test(view));
  // Removal is offered, not performed: an automatic one would be a Firestore
  // write triggered by rendering a page.
  check('the fix is offered as a tap, not done on render',
    !/useEffect[^)]*outOfStartsStarters/.test(view));
  // Each togglePlayerInLineup call recomputes from the same `teams` closure,
  // so a loop of them in one tick keeps only the last removal.
  check('removing several starters is one write, not a loop of toggles',
    !/outOfStartsStarters\.forEach\(p => togglePlayerInLineup/.test(view));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
