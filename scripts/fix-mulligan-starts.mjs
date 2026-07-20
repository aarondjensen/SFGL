// scripts/fix-mulligan-starts.mjs
// ============================================================================
// Companion to scan-mulligan-bonuses.mjs. That scan heals a mulligan's money +
// round bonus but deliberately does NOT touch `starts`. When a mulligan is
// applied to an already-processed event, the IN player gained a start and the
// OUT player lost one — but ONLY Limited players track starts, and the modal's
// starts adjustment was skipped in the cases the scan repairs. This script
// applies just those start deltas.
//
// WHAT IT DOES (only for Limited players, only on --apply)
//   IN  player (Limited): starts + 1
//   OUT player (Limited): starts - 1
//   roster AND player-registry are updated together. The registry is FORCE-SET
//   (not merged) because its monotonic max-merge would otherwise silently
//   re-inflate a decrement on the next team save.
//
// IMPORTANT — NOT idempotent. Each run applies the deltas again. Run the dry run,
// confirm the before→after is what you expect, then run --apply EXACTLY ONCE.
//
// USAGE
//   Dry run (default):
//     $env:FIREBASE_SERVICE_ACCOUNT = "C:\dev\keys\sfgl-admin.txt"
//     node scripts/fix-mulligan-starts.mjs --event="Open Championship"
//   Apply:
//     node scripts/fix-mulligan-starts.mjs --event="Open Championship" --apply
//
//   --event / --team filters behave like the scan. Omit --event to review every
//   mulligan (still Limited-only, still dry-run unless --apply).
//
// SAFETY
//   • Dry run prints, per affected player, current → proposed starts and whether
//     a registry override will be written. Nothing is written without --apply.
//   • Non-Limited players are listed as "skipped (not Limited)" and never changed.
// ============================================================================

import { readFileSync } from 'node:fs';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const TEAM_FILTER = (args.find(a => a.startsWith('--team=')) || '').split('=').slice(1).join('=') || null;
const EVENT_FILTER = (args.find(a => a.startsWith('--event=')) || '').split('=').slice(1).join('=') || null;

const REGISTRY_DOC = 'sfgl_data/player-registry';

const normalizeName = (n) => (n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

async function main() {
  const saRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!saRaw) { console.error('ERROR: FIREBASE_SERVICE_ACCOUNT env var not set.'); process.exit(1); }
  let sa;
  try { sa = saRaw.trim().startsWith('{') ? JSON.parse(saRaw) : JSON.parse(readFileSync(saRaw, 'utf8')); }
  catch (e) { console.error('ERROR: FIREBASE_SERVICE_ACCOUNT is not valid JSON or a readable file path:', e.message); process.exit(1); }
  if (!getApps().length) initializeApp({ credential: cert(sa) });
  const db = getFirestore();

  console.log(`\n=== SFGL mulligan STARTS fix ===`);
  console.log(`mode: ${APPLY ? 'APPLY (will write)' : 'DRY RUN (no writes)'}`);
  if (TEAM_FILTER) console.log(`team filter: ${TEAM_FILTER}`);
  if (EVENT_FILTER) console.log(`event filter: ${EVENT_FILTER}`);
  console.log('');

  const [teamSnap, tourneySnap, txSnap, regSnap] = await Promise.all([
    db.collection('teams').get(),
    db.collection('tournaments').get(),
    db.collection('transactions').get(),
    db.doc(REGISTRY_DOC).get(),
  ]);

  const teams = teamSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const teamByName = new Map(teams.map(t => [t.name, t]));
  const tournaments = tourneySnap.docs.map(d => ({ ...d.data(), name: d.data().name || d.id }));
  const registry = regSnap.exists ? (regSnap.data() || {}) : {};

  const resolveTournament = (tx) => {
    const nm = tx.tournament ?? tx.tournamentName;
    if (nm) { const t = tournaments.find(x => x.name === nm); if (t) return t; }
    if (tx.tournamentIndex != null) return tournaments[tx.tournamentIndex] || null;
    return null;
  };

  const muls = txSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(tx => tx.type === 'mulligan' && tx.status !== 'pending' && tx.status !== 'failed' && tx.player && tx.droppedPlayer);

  // Find the registry key matching a display name (registry is keyed by name).
  const regKeyFor = (name) => {
    if (registry[name] !== undefined) return name;
    return Object.keys(registry).find(k => normalizeName(k) === normalizeName(name)) || null;
  };

  // Accumulate per-team roster edits and registry overrides.
  const teamRosterPatch = new Map(); // teamId -> Map(playerName -> newStarts)
  const registryOverrides = {};      // regKey -> newStarts
  let planned = 0;

  for (const mx of muls) {
    const t = resolveTournament(mx);
    if (!t || !t.completed || !t.results) continue;
    if (EVENT_FILTER && !t.name.toLowerCase().includes(EVENT_FILTER.toLowerCase())) continue;
    if (TEAM_FILTER && mx.team !== TEAM_FILTER) continue;

    const team = teamByName.get(mx.team);
    if (!team) { console.log(`• ${mx.team}: team not found, skipping`); continue; }

    console.log(`── ${t.name} — ${mx.team}: IN ${mx.player} / OUT ${mx.droppedPlayer} ──`);

    const rosterPatch = teamRosterPatch.get(team.id) || new Map();
    const applyOne = (name, delta, label) => {
      const rp = (team.roster || []).find(p => p.name === name);
      if (!rp) { console.log(`   • ${name} (${label}): not on roster, skipping`); return; }
      if (!rp.limited) { console.log(`   • ${name} (${label}): skipped (not Limited)`); return; }
      const cur = rosterPatch.has(name) ? rosterPatch.get(name) : (rp.starts || 0);
      const next = Math.max(0, cur + delta);
      rosterPatch.set(name, next);
      const rk = regKeyFor(name);
      console.log(`   • ${name} (${label}, Limited): starts ${cur} → ${next}${rk ? '  [registry override]' : '  [no registry entry]'}`);
      if (rk) registryOverrides[rk] = { ...(registry[rk] || {}), starts: next };
      planned++;
    };
    applyOne(mx.player, +1, 'IN');
    applyOne(mx.droppedPlayer, -1, 'OUT');

    if (rosterPatch.size) teamRosterPatch.set(team.id, rosterPatch);
  }

  console.log(`\n=== summary ===`);
  console.log(`Limited start adjustments planned: ${planned}`);

  if (!APPLY) { console.log(`\nDRY RUN — nothing written. Re-run with --apply (ONCE) to commit.\n`); return; }
  if (!planned) { console.log(`\nNothing to write.\n`); return; }

  const batch = db.batch();
  for (const [teamId, patch] of teamRosterPatch) {
    const team = teams.find(t => t.id === teamId);
    const newRoster = (team.roster || []).map(p => patch.has(p.name) ? { ...p, starts: patch.get(p.name) } : p);
    batch.update(db.collection('teams').doc(teamId), { roster: newRoster });
  }
  if (Object.keys(registryOverrides).length) {
    // Merge-set only the touched registry entries.
    batch.set(db.doc(REGISTRY_DOC), registryOverrides, { merge: true });
  }
  await batch.commit();
  console.log(`\nDone. Wrote roster + registry start adjustments.\n`);
}

main().catch(err => { console.error('\nFATAL:', err); process.exit(1); });
