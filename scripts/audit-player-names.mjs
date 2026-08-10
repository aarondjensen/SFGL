// scripts/audit-player-names.mjs
// ============================================================================
// Full player-name audit — the one-off sweep behind AdminView → Name Audit.
//
// Reads every name the league holds (rosters, lineups, transactions, the
// /players directory) and cross-references it against every name our data
// sources use (this week's field, the live leaderboard, OWGR). Reports what
// does not line up, with ranked suggestions.
//
// WHY THIS EXISTS
//   api/_playerNames.js resolves every mismatch we know how to describe:
//   spelling, punctuation, accents, "Last, First" order, nicknames ('Nico' ≡
//   'Nicolas'), initials ('K.H. Lee' ≡ 'Kyoung-Hoon Lee'), plus an explicit
//   alias list for the few no rule can derive. This script finds the ones
//   nobody has described yet, and — more importantly — the DUPLICATE PLAYER
//   DOCS that a spelling mismatch already created before the fix landed.
//
//   A duplicate is the expensive kind of mismatch: one doc carries the world
//   rank and headshot, the other sits on a roster, and neither knows about the
//   other. The --duplicates section finds those; Merge Players fixes them.
//
// READ-ONLY. This script never writes to Firestore. Every finding is a
// suggestion for a human to confirm through AdminView → Merge Players, because
// the alternative — auto-merging on a fuzzy score — is how 'Alex Fitzpatrick'
// ends up wearing 'Matt Fitzpatrick's earnings.
//
// USAGE
//   FIREBASE_PROJECT_ID=xxx FIREBASE_CLIENT_EMAIL=xxx FIREBASE_PRIVATE_KEY=xxx \
//     node scripts/audit-player-names.mjs
//
//   Flags:
//     --json      machine-readable output instead of the report
//     --base=URL  where to fetch /api/field and /api/live from
//                 (default https://www.sfglgolf.com)
// ============================================================================

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import {
  NameSet, nameKey, namesMatch, auditNames, suggestMatches, SUSPECTED_MISMATCH_SCORE,
} from '../api/_playerNames.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const baseUrl = (args.find((a) => a.startsWith('--base=')) || '').slice('--base='.length)
  || 'https://www.sfglgolf.com';

const app = initializeApp({
  credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
});
const db = getFirestore(app);

// The same threshold api/cron.js uses to route a finding to the commissioner.
const STRONG = SUSPECTED_MISMATCH_SCORE;

const log = (...a) => { if (!asJson) console.log(...a); };

async function fetchJson(path) {
  try {
    const resp = await fetch(`${baseUrl}${path}`, { headers: { 'Cache-Control': 'no-cache' } });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

async function main() {
  // ── Gather what the league holds ──────────────────────────────────────────
  const [teamsSnap, playersSnap] = await Promise.all([
    db.collection('teams').get(),
    db.collection('players').get(),
  ]);

  const teams = teamsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const playerDocs = playersSnap.docs.map((d) => d.id);

  const rosterNames = new Set();
  const lineupNames = new Set();
  for (const t of teams) {
    (t.roster || []).forEach((p) => { if (p?.name) rosterNames.add(p.name); });
    (t.lineup || []).forEach((n) => { if (n) { rosterNames.add(n); lineupNames.add(n); } });
    if (t.backup) rosterNames.add(t.backup);
  }

  // Transactions reference players by name too. A transaction naming a player
  // under a spelling no roster uses is how a name drifts into the data in the
  // first place, so they are worth auditing.
  const txNames = new Set();
  try {
    const txDoc = await db.collection('sfgl_data').doc('fantasy-golf-transactions').get();
    const txs = txDoc.exists ? (txDoc.data().value || []) : [];
    for (const tx of txs) {
      if (tx?.player) txNames.add(tx.player);
      if (tx?.droppedPlayer) txNames.add(tx.droppedPlayer);
    }
  } catch { /* transactions are optional for this audit */ }

  log(`\nSFGL PLAYER NAME AUDIT`);
  log(`${'='.repeat(72)}`);
  log(`teams ${teams.length} · rostered names ${rosterNames.size} · lineup names ${lineupNames.size}`);
  log(`transaction names ${txNames.size} · /players docs ${playerDocs.length}`);

  const report = { checkedAt: new Date().toISOString(), sections: [] };

  // ── 1. Duplicate player docs ──────────────────────────────────────────────
  // Two /players docs that resolve to the same golfer. This is the highest
  // -value finding: the league is already carrying a split identity, and
  // whichever doc the roster points at is missing whatever the other holds.
  const docIndex = new NameSet(playerDocs);
  const duplicates = docIndex.groups.filter((g) => g.length > 1);

  // Also flag docs that DON'T merge under the current rules but look like the
  // same player — those need a human call and an alias entry.
  const nearDuplicates = [];
  const byLast = new Map();
  for (const name of playerDocs) {
    const key = nameKey(name);
    if (!key) continue;
    const last = key.split(' ').slice(-1)[0];
    if (!byLast.has(last)) byLast.set(last, []);
    byLast.get(last).push(name);
  }
  for (const [, names] of byLast) {
    if (names.length < 2) continue;
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        if (namesMatch(names[i], names[j])) continue;   // already merged above
        const [best] = suggestMatches(names[i], [names[j]], 1);
        if (best && best.score >= 95) nearDuplicates.push({ a: names[i], b: names[j], reason: best.reason });
      }
    }
  }

  report.sections.push({ check: 'duplicates', duplicates, nearDuplicates });
  log(`\n${'─'.repeat(72)}`);
  log(`DUPLICATE PLAYER DOCS`);
  log(`  One golfer, two /players docs — rank and headshot on one, roster on the other.`);
  if (!duplicates.length && !nearDuplicates.length) {
    log(`  ✓ none found`);
  } else {
    duplicates.forEach((g) => log(`  ● ${g.join('  ≡  ')}   (matched automatically — merge to consolidate)`));
    nearDuplicates.forEach((d) => log(`  ? ${d.a}  vs  ${d.b}   (${d.reason} — needs a human call)`));
  }

  // ── 2. Rostered players with no /players doc ──────────────────────────────
  // No doc means no world rank and no headshot, and the next OWGR sync will
  // create a doc under the SOURCE's spelling rather than the roster's.
  const rosterVsDocs = auditNames({ names: [...rosterNames], reference: playerDocs });
  report.sections.push({ check: 'players', ...rosterVsDocs });
  log(`\n${'─'.repeat(72)}`);
  log(`ROSTERED PLAYERS vs /players DIRECTORY`);
  log(`  ${rosterVsDocs.matched}/${rosterVsDocs.checked} matched`);
  if (!rosterVsDocs.unmatched.length) log(`  ✓ every rostered player has a doc`);
  rosterVsDocs.unmatched.forEach(printFinding);

  // ── 3. Rosters vs this week's field ───────────────────────────────────────
  const field = await fetchJson('/api/field');
  const fieldPlayers = field?.players || [];
  if (!fieldPlayers.length) {
    log(`\n${'─'.repeat(72)}`);
    log(`THIS WEEK'S FIELD — unavailable (${baseUrl}/api/field returned nothing)`);
    report.sections.push({ check: 'field', error: 'field unavailable' });
  } else {
    const vsField = auditNames({ names: [...rosterNames], reference: fieldPlayers });
    // A rostered player simply not entered this week is normal. Only spelling
    // -shaped misses are interesting here.
    const suspicious = vsField.unmatched.filter(
      (u) => u.suggestions.length && u.suggestions[0].score >= STRONG,
    ).map((u) => ({ ...u, inLineup: [...lineupNames].some((n) => nameKey(n) === nameKey(u.name)) }));

    report.sections.push({ check: 'field', tournament: field.tournament, ...vsField, unmatched: suspicious });
    log(`\n${'─'.repeat(72)}`);
    log(`ROSTERS vs FIELD — ${field.tournament || 'this week'} (${fieldPlayers.length} players)`);
    log(`  ${vsField.matched}/${vsField.checked} rostered players are in the field`);
    log(`  ${vsField.unmatched.length - suspicious.length} not entered this week (expected)`);
    if (!suspicious.length) log(`  ✓ no spelling-shaped misses`);
    suspicious.forEach((f) => printFinding(f, f.inLineup ? '  ⚠ IN A LINEUP' : ''));

    if (vsField.ambiguous.length) {
      log(`\n  Ambiguous abbreviations in this field (dropped rather than guessed):`);
      vsField.ambiguous.forEach(({ key, names }) => log(`    ${key} → ${names.join(' / ')}`));
    }
  }

  // ── 4. Lineups vs the live leaderboard ────────────────────────────────────
  const live = await fetchJson('/api/live');
  const livePlayers = (live?.players || []).map((p) => p.name).filter(Boolean);
  if (livePlayers.length) {
    const vsLive = auditNames({ names: [...lineupNames], reference: livePlayers });
    const suspicious = vsLive.unmatched.filter(
      (u) => u.suggestions.length && u.suggestions[0].score >= STRONG,
    );
    report.sections.push({ check: 'live', tournament: live.tournamentName, ...vsLive, unmatched: suspicious });
    log(`\n${'─'.repeat(72)}`);
    log(`STARTING LINEUPS vs LIVE LEADERBOARD — ${live.tournamentName || ''} (${livePlayers.length} players)`);
    log(`  ${vsLive.matched}/${vsLive.checked} starters found on the leaderboard`);
    if (!suspicious.length) log(`  ✓ no spelling-shaped misses`);
    suspicious.forEach((f) => printFinding(f));
  }

  // ── 5. Transaction names vs rosters + directory ───────────────────────────
  const knownNames = [...new Set([...rosterNames, ...playerDocs])];
  const vsTx = auditNames({ names: [...txNames], reference: knownNames });
  const txSuspicious = vsTx.unmatched.filter(
    (u) => u.suggestions.length && u.suggestions[0].score >= STRONG,
  );
  report.sections.push({ check: 'transactions', ...vsTx, unmatched: txSuspicious });
  if (txNames.size) {
    log(`\n${'─'.repeat(72)}`);
    log(`TRANSACTION NAMES vs ROSTERS + DIRECTORY`);
    log(`  ${vsTx.matched}/${vsTx.checked} matched`);
    if (!txSuspicious.length) log(`  ✓ no spelling-shaped misses`);
    txSuspicious.forEach((f) => printFinding(f));
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const totalFindings = report.sections.reduce(
    (n, s) => n + (s.unmatched?.length || 0) + (s.duplicates?.length || 0) + (s.nearDuplicates?.length || 0),
    0,
  );

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    log(`\n${'='.repeat(72)}`);
    log(totalFindings === 0
      ? `✓ CLEAN — nothing needs attention.`
      : `${totalFindings} item${totalFindings === 1 ? '' : 's'} need review. Fix each in AdminView → Merge Players.`);
    log(`Read-only: this script wrote nothing.\n`);
  }

  process.exit(0);
}

function printFinding(finding, suffix = '') {
  log(`  ● ${finding.name}${suffix}`);
  if (!finding.suggestions?.length) {
    log(`      no close candidate — most likely genuinely absent`);
    return;
  }
  finding.suggestions.forEach((s) => log(`      ↳ ${s.name}  (${s.reason})`));
}

main().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(1);
});
