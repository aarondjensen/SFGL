// Put back the lineups a reprocess wiped.
//
// Usage:
//   node scripts/restore-lineups.mjs --from "FedEx St. Jude"
//   node scripts/restore-lineups.mjs --from "FedEx St. Jude" --apply
//   node scripts/restore-lineups.mjs --list
//
// DRY RUN BY DEFAULT. Nothing is written until --apply.
// Needs Firebase Admin credentials — see scripts/_adminCreds.mjs.
//
// WHY THIS EXISTS
// ---------------
// Reprocessing a past tournament used to destroy the CURRENT week's submitted
// lineups. The reprocess overwrites team.lineup with the old event's five so
// the scorer can re-run it, and processTournamentData then clears lineup to []
// as it correctly does when an event finishes — so an audit of a March result
// emptied what every manager had submitted for the tournament being played that
// afternoon. No warning, no undo, and nothing on screen to say it had happened.
//
// TournamentResultsPanel now saves the live lineups before reversing and puts
// them back afterwards, so this cannot recur. This script is for the damage
// already done.
//
// WHERE THE LINEUPS COME BACK FROM
// --------------------------------
// tournament.lockedLineups — the snapshot frozen at the first tee time, which
// exists precisely because the live lineup is not trustworthy after the fact.
// It is written when the event locks, so for a tournament already under way it
// holds exactly what the managers submitted.
//
// It is also the ONLY honest source. team.lineup has been cleared; the roster
// says who is available, not who was picked; and last week's fullLineups is a
// different week's five. If a team has no snapshot, this says so and restores
// nothing for them rather than inventing a lineup — a wrong lineup scores wrong
// and looks right, which is the failure this whole audit has been chasing.

import { adminDb } from './_adminCreds.mjs';

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const from = arg('--from', null);
const apply = process.argv.includes('--apply');
const list = process.argv.includes('--list');

if (!from && !list) {
  console.error('Usage: node scripts/restore-lineups.mjs --from "<tournament>" [--apply]');
  console.error('       node scripts/restore-lineups.mjs --list');
  process.exit(2);
}

const db = adminDb();
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function main() {
  const [tSnap, teamSnap] = await Promise.all([
    db.collection('tournaments').get(),
    db.collection('teams').get(),
  ]);
  const tournaments = tSnap.docs.map(d => ({ _id: d.id, ...d.data() }));
  const teams = teamSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  if (list) {
    console.log('\nTournaments holding a lineup snapshot:\n');
    tournaments
      .filter(t => t.lockedLineups && Object.keys(t.lockedLineups).length)
      .sort((a, b) => String(a.start_date || '').localeCompare(String(b.start_date || '')))
      .forEach(t => {
        const n = Object.values(t.lockedLineups).filter(l => Array.isArray(l) && l.length).length;
        console.log(`  ${String(t.name).padEnd(46)} ${n} team(s)` +
          `${t.completed ? '' : '   ← not completed'}${t.playing ? '   ← currently playing' : ''}`);
      });
    console.log('\nCurrent team.lineup:');
    teams.forEach(t => console.log(`  ${String(t.name).padEnd(22)} ${(t.lineup || []).length} player(s)` +
      `${(t.lineup || []).length ? ': ' + t.lineup.join(', ') : '  ← EMPTY'}`));
    return;
  }

  const exact = tournaments.filter(t => norm(t.name) === norm(from));
  const wt = norm(from).split(' ').filter(Boolean);
  const subset = tournaments.filter(t => {
    const dt = new Set(norm(t.name).split(' ').filter(Boolean));
    return wt.length && wt.every(x => dt.has(x));
  });
  const matches = exact.length ? exact : subset;
  if (matches.length !== 1) {
    // Ambiguity is refused, not guessed — restoring the wrong week's five would
    // be worse than restoring nothing.
    console.error(matches.length
      ? `"${from}" matches ${matches.length}: ${matches.map(t => t.name).join(', ')}`
      : `Nothing matches "${from}".`);
    process.exit(1);
  }
  const t = matches[0];
  const snapshots = t.lockedLineups || {};

  if (!Object.keys(snapshots).length) {
    console.error(`\n"${t.name}" has no lineup snapshot — nothing can be restored from it.`);
    console.error('Run with --list to see which tournaments do.');
    process.exit(1);
  }

  console.log(`\nRestoring from "${t.name}"\n`);
  const writes = [];
  for (const team of teams) {
    const snap = snapshots[team.id];
    const current = Array.isArray(team.lineup) ? team.lineup : [];
    if (!Array.isArray(snap) || !snap.length) {
      console.log(`  ${String(team.name).padEnd(22)} no snapshot — leaving as is (${current.length} player(s))`);
      continue;
    }
    if (current.length === snap.length && current.every((n, i) => n === snap[i])) {
      console.log(`  ${String(team.name).padEnd(22)} already matches the snapshot`);
      continue;
    }
    console.log(`  ${String(team.name).padEnd(22)} ${current.length} → ${snap.length}: ${snap.join(', ')}`);
    if (current.length) console.log(`  ${' '.repeat(22)} (overwriting: ${current.join(', ')})`);
    writes.push({ id: team.id, name: team.name, lineup: [...snap] });
  }

  if (!writes.length) { console.log('\nNothing to restore.'); return; }
  if (!apply) {
    console.log(`\nDRY RUN — ${writes.length} team(s) would be updated. Re-run with --apply.`);
    return;
  }
  for (const w of writes) {
    await db.collection('teams').doc(w.id).update({ lineup: w.lineup });
    console.log(`✓ restored ${w.name}`);
  }
  console.log('\nNo reprocess needed — a lineup is an input, not a stored result.');
}

main().catch(err => {
  console.error('restore-lineups failed:', err.message);
  process.exit(1);
});
