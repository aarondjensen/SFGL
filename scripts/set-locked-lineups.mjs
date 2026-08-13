// Retroactively correct the lineup a past tournament is scored against.
//
// Usage:
//   node scripts/set-locked-lineups.mjs --file scripts/fixtures/lineup-corrections-2026.json
//   node scripts/set-locked-lineups.mjs --file <corrections.json> --apply
//
// DRY RUN BY DEFAULT. Nothing is written until --apply.
// Needs Firebase Admin credentials — see scripts/_adminCreds.mjs.
//
// WHY THIS EXISTS
// ---------------
// Three 2026 team-events were scored on the wrong five, worth $1.1M, because
// processTournamentData read the LIVE team.lineup: lineup editing re-opens
// Sunday 9pm ET and results process Monday 9am ET, so a manager who set next
// week's five in that window had them applied to the finished tournament.
// lineupFor() now prefers tournament.lockedLineups, but that only prevents
// recurrence — the stored results are still wrong.
//
// The Admin panel cannot fix them: it seeds its editable copy from
// results.fullLineups and offers no control to change it, so a plain reprocess
// faithfully restores the same wrong five.
//
// So this writes the correct lineup into lockedLineups, and the commissioner
// then reprocesses that tournament in Admin → Tournament Results. Reprocessing
// is what makes the correction safe: it reverses the old result first, undoing
// team.earnings, segmentEarnings, per-player sfglEarnings/starts and the global
// player stats, then re-applies from the corrected lineup. Editing
// results.teams directly would leave every one of those aggregates stale.
//
// CORRECTIONS FILE
//   [
//     { "tournament": "RBC Heritage", "team": "Dirty Bird(ies)",
//       "replace": { "Harris English": "Brian Harman" } },
//     { "tournament": "Valspar Championship", "team": "Hip Happens",
//       "lineup": ["Justin Thomas", "Ryo Hisatsune", "Ben Griffin",
//                  "Matt Fitzpatrick", "Jacob Bridgeman"] }
//   ]
//
// `replace` swaps named players and leaves the rest of the recorded lineup
// alone — safer than restating all five when only one is disputed. `lineup`
// sets the whole thing. Every resulting name must be on that team's roster;
// a typo fails the run rather than silently scoring a player who does not
// exist.

import { readFileSync } from 'node:fs';
import { adminDb } from './_adminCreds.mjs';
import { namesMatch } from '../api/_playerNames.js';


const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const filePath = arg('--file', null);
const apply = process.argv.includes('--apply');

if (!filePath) {
  console.error('Usage: node scripts/set-locked-lineups.mjs --file <corrections.json> [--apply]');
  process.exit(2);
}

const db = adminDb();
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Exact name, then case-insensitive, then "sheet tab name inside the full title". */
function findByName(docs, wanted) {
  const exact = docs.find(d => d.name === wanted);
  if (exact) return exact;
  const ci = docs.find(d => norm(d.name) === norm(wanted));
  if (ci) return ci;
  const wt = norm(wanted).split(' ').filter(Boolean);
  const subset = docs.filter(d => {
    const dt = new Set(norm(d.name).split(' ').filter(Boolean));
    return wt.length && wt.every(t => dt.has(t));
  });
  // Ambiguity is refused, not guessed: "RBC" matches Heritage AND Canadian Open.
  return subset.length === 1 ? subset[0] : null;
}

async function main() {
  const corrections = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!Array.isArray(corrections) || !corrections.length) {
    console.error('Corrections file must be a non-empty array.');
    process.exit(2);
  }

  const [tSnap, teamSnap] = await Promise.all([
    db.collection('tournaments').get(),
    db.collection('teams').get(),
  ]);
  const tournaments = tSnap.docs.map(d => ({ _id: d.id, ...d.data() }));
  const teams = teamSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const writes = new Map();   // tournament doc id → { name, lockedLineups }
  let failed = 0;

  for (const c of corrections) {
    const t = findByName(tournaments, c.tournament);
    if (!t) { console.error(`✗ no single tournament matches "${c.tournament}"`); failed++; continue; }
    const team = findByName(teams, c.team);
    if (!team) { console.error(`✗ no single team matches "${c.team}"`); failed++; continue; }

    // What the event is CURRENTLY SCORED AGAINST — results.fullLineups, the
    // lineup the processor recorded at the time.
    //
    // NOT lineupFor(): that is the processor's own precedence and falls back to
    // team.lineup, the team's LIVE lineup. Using it here showed today's five
    // instead of the scored ones, which is the very drift this script exists to
    // repair. An existing lockedLineups entry wins, so re-running after a
    // correction is idempotent.
    const scored = t.lockedLineups?.[team.id]
      || t.results?.fullLineups?.[team.id]
      || team.lineup
      || [];
    const current = [...scored];
    if (!current.length) {
      console.error(`✗ ${t.name} / ${team.name}: no recorded lineup to correct`); failed++; continue;
    }

    let next;
    if (Array.isArray(c.lineup) && c.lineup.length) {
      next = [...c.lineup];
    } else if (c.replace && Object.keys(c.replace).length) {
      next = [...current];
      for (const [outName, inName] of Object.entries(c.replace)) {
        const idx = next.findIndex(p => namesMatch(p, outName));
        if (idx === -1) {
          console.error(`✗ ${t.name} / ${team.name}: "${outName}" is not in the recorded lineup ` +
            `(${current.join(', ')})`);
          failed++; next = null; break;
        }
        next[idx] = inName;
      }
      if (!next) continue;
    } else {
      console.error(`✗ ${t.name} / ${team.name}: needs either "lineup" or "replace"`); failed++; continue;
    }

    // Every name must be a real player on that roster.
    const roster = (team.roster || []).map(p => p.name);
    const unknown = next.filter(n => !roster.some(r => namesMatch(r, n)));
    if (unknown.length) {
      console.error(`✗ ${t.name} / ${team.name}: not on the roster — ${unknown.join(', ')}`);
      failed++; continue;
    }

    const entry = writes.get(t._id) || { name: t.name, lockedLineups: { ...(t.lockedLineups || {}) } };
    entry.lockedLineups[team.id] = next;
    writes.set(t._id, entry);

    console.log(`\n${t.name} / ${team.name}`);
    console.log(`   was: ${current.join(', ')}`);
    console.log(`   now: ${next.join(', ')}`);
  }

  if (failed) {
    console.error(`\n${failed} correction(s) failed validation — nothing written.`);
    process.exit(1);
  }

  if (!apply) {
    console.log(`\nDRY RUN — ${writes.size} tournament doc(s) would be updated. Re-run with --apply.`);
    return;
  }

  for (const [docId, entry] of writes) {
    await db.collection('tournaments').doc(docId).update({ lockedLineups: entry.lockedLineups });
    console.log(`✓ wrote lockedLineups to "${entry.name}"`);
  }
  console.log('\nNow REPROCESS each of those tournaments in Admin → Tournament Results.');
  console.log('Reprocessing reverses the old result and re-applies from the corrected lineup,');
  console.log('which is what keeps team earnings, roster stats and player stats consistent.');
}

main().catch(err => {
  console.error('set-locked-lineups failed:', err.message);
  process.exit(1);
});
