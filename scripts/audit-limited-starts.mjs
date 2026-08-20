// scripts/audit-limited-starts.mjs
// ============================================================================
// Where every limited player's start count comes from, event by event.
//
// READ-ONLY by default. Needs Firebase Admin credentials — see
// scripts/_adminCreds.mjs.
//
// WHY THIS EXISTS. The app derives a limited player's starts from tournament
// results and lineups frozen at lock. The roster doc ALSO carries a stored
// `starts` tally, and the two disagree, because the tally was maintained for
// years by a cron that credited each start to `team.lineup` — the LIVE five —
// rather than to the five that actually played. Between Sunday 9pm ET, when
// lineup editing reopens, and Monday's processing those are different lineups,
// so the start landed on next week's players and the ones who teed off were
// never charged. (api/cron.js now credits the scored lineup; the damage
// already written is what this reports.)
//
// Nothing in the cap still reads the stored tally, so a wrong one is no longer
// able to bar anyone. It is worth repairing anyway: `sfglEarnings` on the same
// roster entries was written by the same broken line, and that one IS shown.
//
// USAGE
//   node scripts/audit-limited-starts.mjs                  # every limited player
//   node scripts/audit-limited-starts.mjs --player=Fleetwood
//   node scripts/audit-limited-starts.mjs --team="World #1"
//   node scripts/audit-limited-starts.mjs --events         # list the events counted
//   node scripts/audit-limited-starts.mjs --apply          # write the repair
//
// --apply rewrites roster `starts` to the derived number and FORCE-SETS the
// player-registry entry, because the registry's monotonic max-merge would
// otherwise re-inflate a decrement on the next team save. It touches `starts`
// and nothing else. Run the dry run first and read it.
// ============================================================================

import { adminDb } from './_adminCreds.mjs';
import { startsUsedByPlayer, maxLimitedStarts, lineupTargetIndex } from '../api/_rules.js';
import { NameSet } from '../api/_playerNames.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const SHOW_EVENTS = args.includes('--events');
const arg = (k) => (args.find(a => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=') || null;
const PLAYER_FILTER = arg('player');
const TEAM_FILTER = arg('team');

const REGISTRY_DOC = 'player-registry';
const db = adminDb();

async function main() {
  const [tSnap, teamSnap, txSnap, setSnap] = await Promise.all([
    db.collection('tournaments').get(),
    db.collection('teams').get(),
    db.collection('transactions').get(),
    db.collection('league_settings').get(),
  ]);

  const settings = {};
  setSnap.docs.forEach(d => { settings[d.data().key] = d.data().value; });
  const max = maxLimitedStarts(settings);

  // Same ordering the app uses — NOT orderBy('start_date'), which drops docs
  // missing the field. See loadTournaments in api/cron.js.
  const tournaments = tSnap.docs
    .map(d => ({ _id: d.id, ...d.data() }))
    .sort((a, b) => String(a.start_date || '').localeCompare(String(b.start_date || '')));
  const teams = teamSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const transactions = txSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const target = lineupTargetIndex(tournaments);
  const spent = startsUsedByPlayer({ teams, tournaments, transactions, beforeIndex: target });

  console.log(`\n=== SFGL limited starts ===`);
  console.log(`cap: ${max}   tournaments: ${tournaments.length}   teams: ${teams.length}`);
  console.log(`lineup target: ${target < tournaments.length ? `[${target}] ${tournaments[target].name}` : '(end of schedule)'}`);
  console.log(`  starts BEFORE that event are spent; that event's own start is not\n`);

  // An event that is neither completed nor dateable sitting before the target
  // used to collapse the whole count to zero. It no longer can, but it is
  // still a schedule problem worth seeing.
  const stragglers = tournaments
    .map((t, i) => ({ t, i }))
    .filter(({ t, i }) => i < target && !t.completed && !t.isAlternate);
  if (stragglers.length) {
    console.log(`  ⚠ not marked completed, yet behind the current event:`);
    stragglers.forEach(({ t, i }) => console.log(`      [${i}] ${t.name}`));
    console.log('');
  }

  const rows = [];
  for (const team of teams) {
    if (TEAM_FILTER && !String(team.name || '').toLowerCase().includes(TEAM_FILTER.toLowerCase())) continue;
    for (const p of team.roster || []) {
      if (!p?.limited) continue;
      if (PLAYER_FILTER && !String(p.name).toLowerCase().includes(PLAYER_FILTER.toLowerCase())) continue;
      const derived = spent.get(p.name) || 0;
      const stored = Number(p.starts) || 0;
      const inLineup = (team.lineup || []).includes(p.name);
      rows.push({ team, player: p, derived, stored, inLineup });
    }
  }
  rows.sort((a, b) => b.derived - a.derived || String(a.player.name).localeCompare(String(b.player.name)));

  let disagree = 0;
  for (const r of rows) {
    const flag = r.derived !== r.stored ? '  ✗ STORED DISAGREES' : '';
    if (r.derived !== r.stored) disagree++;
    const badge = `${r.derived + (r.inLineup && r.derived < max ? 1 : 0)}/${max}`;
    const state = r.derived >= max ? 'OUT OF STARTS'
      : r.inLineup && r.derived + 1 >= max ? 'last start (in lineup)'
      : r.inLineup ? 'in lineup' : '';
    console.log(`${String(r.player.name).padEnd(24)} ${r.team.name.padEnd(18)} `
      + `spent ${String(r.derived).padStart(2)}  stored ${String(r.stored).padStart(2)}  `
      + `badge ${badge.padEnd(6)} ${state}${flag}`);

    if (SHOW_EVENTS) {
      // Recount one player, one event at a time, so the source of every start
      // is visible. Same rules as startsUsedByPlayer, spelled out.
      tournaments.slice(0, target).forEach((t, i) => {
        const tr = t.completed ? t.results?.teams?.[r.team.id] : null;
        const names = tr
          ? new NameSet([...(tr.players || []).map(x => x?.name || x),
                         ...(t.results.fullLineups?.[r.team.id] || [])])
          : new NameSet(t.lockedLineups?.[r.team.id] || []);
        if (names.has(r.player.name)) {
          console.log(`      [${String(i).padStart(2)}] ${tr ? 'scored' : 'locked'}  ${t.name}`);
        }
      });
    }
  }

  console.log(`\n${rows.length} limited player-slots, ${disagree} where the stored tally disagrees.`);

  if (!disagree) { console.log('Nothing to repair.\n'); return; }
  if (!APPLY) {
    console.log('Dry run — nothing written. Re-run with --apply to set stored `starts`');
    console.log('to the derived number (roster + player-registry).\n');
    return;
  }

  const regRef = db.collection('sfgl_data').doc(REGISTRY_DOC);
  const registry = (await regRef.get()).data()?.value || {};
  const batch = db.batch();
  let writes = 0;

  for (const team of teams) {
    const touched = rows.filter(r => r.team.id === team.id && r.derived !== r.stored);
    if (!touched.length) continue;
    const fix = new Map(touched.map(r => [r.player.name, r.derived]));
    const roster = (team.roster || []).map(p =>
      fix.has(p.name) ? { ...p, starts: fix.get(p.name) } : p);
    batch.update(db.collection('teams').doc(team.id), { roster });
    writes++;
    // Force-set, never merge: the registry's monotonic max-merge would put a
    // decrement straight back on the next team save.
    touched.forEach(r => {
      registry[r.player.name] = { ...(registry[r.player.name] || {}), starts: r.derived };
    });
  }
  batch.set(regRef, { key: REGISTRY_DOC, value: registry });
  await batch.commit();
  console.log(`Applied: ${disagree} tallies across ${writes} teams, plus the registry.\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
