// Guard: the finishing position shown on a results email is a reading of the
// purse, not a guess at one.
//
// A stored result carries no finishing position — only earningsMap, name →
// money. cutRuleForfeit already leans on that for the winner ("the champion is
// always the top earner"); finishPositions extends the same fact to the whole
// field, because a tour purse pays strictly less for each lower position and
// splits ties equally. So equal cheque ⟺ equal finish, and ranking the distinct
// amounts reproduces the leaderboard exactly.
//
// What these cover: golf's tie numbering (two at 2nd puts the next at 4th, not
// 3rd), the MC/DNP split that a bare `earnings || 0` destroys, and the wiring
// in api/cron.js that has to keep `inField` alive from the earnings lookup all
// the way to the stored player row.
import { readFileSync } from 'node:fs';
import {
  finishPositions, cutRuleForfeit,
  FINISH_MISSED_CUT, FINISH_DID_NOT_PLAY,
} from '../api/_rules.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') =>
  cond ? (pass++, console.log('  ok   ' + name))
       : (fail++, console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')));

console.log('\n── an ordinary field ──');
{
  // Winner, a clean 2nd, three tied, then a cut line.
  const map = {
    'Scottie Scheffler': 3600000,
    'Rory McIlroy':      2180000,
    'Ludvig Åberg':      1380000,
    'Tommy Fleetwood':   1380000,
    'Sam Burns':         1380000,
    'Keegan Bradley':     900000,
    'Rickie Fowler':           0,
    'Jordan Spieth':           0,
  };
  const place = finishPositions(map);

  check('the top cheque is 1',       place(3600000) === '1',  place(3600000));
  check('a lone second is 2',        place(2180000) === '2',  place(2180000));
  check('three on one cheque are T3', place(1380000) === 'T3', place(1380000));
  check('the tie pushes the next to 6, not 4',
    place(900000) === '6', place(900000));
  check('$0 in the field is MC',
    place(0) === FINISH_MISSED_CUT, place(0));

  // The winner derivation the cut rule already relies on must agree with this
  // one, or the email and the forfeit would disagree about who won.
  const forfeit = cutRuleForfeit({
    starters: [{ playerName: 'Scottie Scheffler', earnings: 3600000 }],
    earningsMap: map,
    settings: { lineupSize: 5 },
  });
  check('position 1 is the same player the cut rule calls the winner',
    forfeit?.won === true && place(3600000) === '1');
}

console.log('\n── in the field vs never teed off ──');
{
  const place = finishPositions({ 'A': 1000000, 'B': 0 });
  check('$0 with inField true is MC',
    place(0, true) === FINISH_MISSED_CUT, place(0, true));
  check('$0 with inField false is DNP',
    place(0, false) === FINISH_DID_NOT_PLAY, place(0, false));
  check('MC and DNP are not the same label',
    FINISH_MISSED_CUT !== FINISH_DID_NOT_PLAY);
  check('inField defaults to true, so old callers still read MC',
    place(0) === FINISH_MISSED_CUT);
  check('a cheque the field does not carry cannot be placed',
    place(777, true) === FINISH_DID_NOT_PLAY, place(777, true));
}

console.log('\n── shapes that must not throw ──');
{
  check('an empty map places nothing', finishPositions({})(0) === FINISH_MISSED_CUT);
  check('no map at all still returns a function',
    typeof finishPositions() === 'function');
  const place = finishPositions({ 'A': '2500000', 'B': '1500000' });
  check('string amounts are read as money', place('2500000') === '1', place('2500000'));
  check('a negative amount is not a position',
    finishPositions({ 'A': 100 })(-5) === FINISH_MISSED_CUT);

  // A signature/no-cut event pays everybody, so nothing should read MC.
  const noCut = { 'A': 3600000, 'B': 2180000, 'C': 1380000, 'D': 900000, 'E': 640000 };
  const p = finishPositions(noCut);
  const labels = Object.values(noCut).map(v => p(v));
  check('a no-cut field produces no MC rows',
    !labels.includes(FINISH_MISSED_CUT), labels.join(','));
  check('a no-cut field numbers straight through',
    labels.join(',') === '1,2,3,4,5', labels.join(','));
}

console.log('\n── ties at the top ──');
{
  // Not a real golf outcome (a playoff settles it), but the label must still
  // be honest rather than silently claiming an outright win.
  const place = finishPositions({ 'A': 1000000, 'B': 1000000, 'C': 500000 });
  check('a shared top cheque is T1, not 1', place(1000000) === 'T1', place(1000000));
  check('and the next is 3', place(500000) === '3', place(500000));
}

console.log('\n── api/cron.js wiring ──');
{
  const cron = readFileSync(new URL('../api/cron.js', import.meta.url), 'utf8');
  const strip = (s) => s.replace(/\/\/[^\n]*/g, '');
  const proc = strip(cron.slice(cron.indexOf('async function handleProcessResults')));

  check('the field lookup keeps `inField` instead of collapsing to 0',
    /inField:\s*earnings\s*!==\s*undefined/.test(proc),
    'a missing name must stay distinguishable from a $0 cheque');
  check('the lookup no longer defaults the miss to 0 before that test',
    !/const mk = Object\.keys\(earningsMap\)[\s\S]{0,120}earningsMap\[mk\] : 0;/.test(proc));
  check('positions are built once against the whole field',
    /finishPositions\(earningsMap\)/.test(proc));
  check('the stored player row carries its position',
    /position:\s*placeOf\(s\.earnings,\s*s\.inField\)/.test(proc));
  check('the email payload forwards it',
    /position:\s*p\.position\s*\|\|\s*null/.test(proc));

  // The whole point of the request: position sits to the LEFT of the name.
  const tpl = strip(cron.slice(cron.indexOf('function buildTournamentResultsEmail'),
                               cron.indexOf('function buildLineupReminderEmail')));
  check('the template builds a position cell', /const placeCell = /.test(tpl));
  const row = tpl.slice(tpl.indexOf('return `<tr>'));
  const rowLine = row.slice(0, row.indexOf('\n'));
  check('the position cell precedes the name cell',
    rowLine.indexOf('${placeCell}') !== -1 &&
    rowLine.indexOf('${placeCell}') < rowLine.indexOf('esc(p.name)'),
    rowLine.slice(0, 120));
  check('a payload with no position renders an empty cell, not a guess',
    /p\.position \? String\(p\.position\) : ''/.test(tpl));
  check('the legend names MC only when positions are present',
    /hasPlaceData/.test(tpl) && /Missed Cut/.test(tpl));
}

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
