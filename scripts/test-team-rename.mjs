// Covers the team-rename fix: transactions identify their team by NAME, which
// managers can edit, so a rename used to sever a team from its whole history.
import { txBelongsToTeam, resolveTxTeam } from '../api/_league.js';
import { buildEffectiveRoster, getSeasonFeesForTeam, getSwingFeesForTeam } from '../src/utils/sharedHelpers.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') =>
  cond ? (pass++, console.log('  ok   ' + name))
       : (fail++, console.log('  FAIL ' + name + ' ' + extra));

const OLD = 'World #1', NEW = 'World Number One';
const teamBefore = { id: 'w1', name: OLD, roster: [{ name: 'Scottie Scheffler' }] };
const teamAfter  = { id: 'w1', name: NEW, roster: [{ name: 'Scottie Scheffler' }] };
const tournaments = [
  { name: 'Event A', startDate: '2026-02-05', isAlternate: false },
  { name: 'Event B', startDate: '2026-02-12', isAlternate: false },
];
// Legacy rows: name only, no teamId — exactly what is already in Firestore.
const legacyTx = [
  { team: OLD, type: 'free agent', status: 'processed', player: 'Rory McIlroy',
    droppedPlayer: 'Scottie Scheffler', fee: 1, tournament: 'Event A', timestamp: 1 },
  { team: OLD, type: 'waiver', status: 'processed', player: 'Jon Rahm',
    fee: 2, tournament: 'Event B', timestamp: 2 },
];

// ── The bug ───────────────────────────────────────────────────────────────
// A plain name write (no re-key) leaves legacy rows pointing at the old name.
check('legacy rows still resolve BEFORE a rename',
  buildEffectiveRoster(teamBefore, legacyTx, { tournaments }).has('Rory McIlroy'));
check('BUG REPRODUCED: a bare rename orphans roster replay',
  !buildEffectiveRoster(teamAfter, legacyTx, { tournaments }).has('Rory McIlroy'));
check('BUG REPRODUCED: a bare rename zeroes the fee tally',
  getSeasonFeesForTeam(legacyTx, {}, teamAfter) === 0);

// ── Fix 1: teamsApi.rename re-keys the rows ───────────────────────────────
const rekeyed = legacyTx.map(tx => (tx.team === OLD ? { ...tx, team: NEW, teamId: 'w1' } : tx));
check('after re-key, roster replay is intact',
  buildEffectiveRoster(teamAfter, rekeyed, { tournaments }).has('Rory McIlroy'));
check('after re-key, the dropped player stays dropped',
  !buildEffectiveRoster(teamAfter, rekeyed, { tournaments }).has('Scottie Scheffler'));
check('after re-key, fees are intact', getSeasonFeesForTeam(rekeyed, {}, teamAfter) === 3);
check('after re-key, swing fees are intact',
  getSwingFeesForTeam(rekeyed, tournaments, 'West Coast Swing', {}, teamAfter) === 3);

// ── Fix 2: teamId makes new rows rename-proof with no re-key at all ────────
const stampedTx = legacyTx.map(tx => ({ ...tx, teamId: 'w1' }));
check('a teamId-stamped row survives a rename even WITHOUT re-keying',
  buildEffectiveRoster(teamAfter, stampedTx, { tournaments }).has('Rory McIlroy'));
check('...and its fees survive too', getSeasonFeesForTeam(stampedTx, {}, teamAfter) === 3);

// ── The fallback must be exactly the old behaviour ─────────────────────────
check('no teamId -> matches on name (unchanged legacy semantics)',
  txBelongsToTeam({ team: OLD }, teamBefore) === true);
check('no teamId, different name -> no match',
  txBelongsToTeam({ team: 'Hip Happens' }, teamBefore) === false);
check('teamId present -> name is ignored entirely',
  txBelongsToTeam({ team: 'anything at all', teamId: 'w1' }, teamAfter) === true);
check('teamId present but different -> no match even if names agree',
  txBelongsToTeam({ team: NEW, teamId: 'other' }, teamAfter) === false);
check('a team whose id is absent falls back to its name as the key',
  txBelongsToTeam({ teamId: 'Hip Happens' }, { name: 'Hip Happens' }) === true);
check('null-safe', txBelongsToTeam(null, teamAfter) === false && txBelongsToTeam({}, null) === false);

// ── resolveTxTeam ─────────────────────────────────────────────────────────
const allTeams = [{ id: 'hh', name: 'Hip Happens' }, teamAfter];
check('resolveTxTeam finds by stable id', resolveTxTeam({ teamId: 'w1' }, allTeams)?.id === 'w1');
check('resolveTxTeam finds by legacy name', resolveTxTeam({ team: 'Hip Happens' }, allTeams)?.id === 'hh');
check('resolveTxTeam returns null for an orphan', resolveTxTeam({ team: 'Gone FC' }, allTeams) === null);

// ── Reassignment must move the id, not just the name ──────────────────────
// EditTransactionModal moves a transaction between teams; leaving a stale
// teamId behind would make it keep counting for the old team.
{
  const moved = { team: 'Hip Happens', teamId: 'hh', type: 'waiver', status: 'processed', fee: 2 };
  check('a correctly reassigned row counts for the new team only',
    getSeasonFeesForTeam([moved], {}, allTeams[0]) === 2 &&
    getSeasonFeesForTeam([moved], {}, teamAfter) === 0);
  const stale = { team: 'Hip Happens', teamId: 'w1', type: 'waiver', status: 'processed', fee: 2 };
  check('a STALE teamId would win over the name (why the edit path moves both)',
    getSeasonFeesForTeam([stale], {}, teamAfter) === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
