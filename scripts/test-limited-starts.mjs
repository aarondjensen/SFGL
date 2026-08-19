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
import { limitedStartsStatus, maxLimitedStarts, DEFAULT_MAX_LIMITED_STARTS } from '../api/_rules.js';
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
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
