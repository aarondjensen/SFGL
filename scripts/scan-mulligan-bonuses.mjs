// scripts/scan-mulligan-bonuses.mjs
// ============================================================================
// One-off maintenance sweep: find completed tournaments where a mulligan was
// added AFTER processing and the IN player's round-leader bonus was dropped.
//
// WHY THIS EXISTS
//   The old AddTransactionModal "already-processed" swap hard-coded
//   bonus: 0 / roundsLed: [] for the mulligan IN player and only credited
//   their prize money. So any mulligan applied to an already-completed event
//   left the IN player short their round-1/2/3 leader bonus until a full
//   reprocess healed it. The forward bug is fixed in the modal; this script
//   heals the events that already happened.
//
//   Compounding factor: round leaders are FILTERED to started players before
//   they're stored (results.roundLeaders keeps only names that were in some
//   team's lineup at process time). A mulligan IN player wasn't started, so
//   their name was usually stripped from stored roundLeaders. That's why this
//   script re-fetches the UNFILTERED leaders from /api/pga-results (by name)
//   rather than trusting stored data.
//
// WHAT IT TOUCHES (only in --apply mode, only for events that need it)
//   results.teams[teamId].players[IN]  → correct bonus / roundsLed / wasRoundLeader
//   results.teams[teamId].totalEarnings → += the recovered bonus
//   results.teams[teamId].bonuses       → per-round totals reflect the IN player
//   results.fullLineups[teamId]         → OUT→IN swap made consistent
//   team.earnings / team.segmentEarnings → += the recovered bonus
//   (Per-player roster sfglEarnings is money-only and was already correct —
//    the old path handled money; only the bonus was lost — so it is NOT touched
//    unless the money side genuinely diverges, which under the 5-starter rule
//    it does not.)
//
// USAGE
//   Dry run (default — reports, writes NOTHING):
//     FIREBASE_SERVICE_ACCOUNT="$(cat ~/dev/sfgl-service-account.json)" \
//       node scripts/scan-mulligan-bonuses.mjs
//
//   Apply the fixes:
//     FIREBASE_SERVICE_ACCOUNT="$(cat ~/dev/sfgl-service-account.json)" \
//       node scripts/scan-mulligan-bonuses.mjs --apply
//
//   Options:
//     --apply           actually write the corrections (otherwise dry run)
//     --year=2026       override the season year passed to /api/pga-results
//                       (default: derived from each tournament's start_date,
//                        falling back to the current calendar year)
//     --team="World #1" limit the sweep to one team name
//     --event="Masters" limit the sweep to one tournament (substring match)
//
//   Env:
//     FIREBASE_SERVICE_ACCOUNT   service-account JSON (required)
//     SFGL_BASE                  base URL for pga-results
//                                (default https://www.sfglgolf.com)
//
// SAFETY
//   • Dry run prints, per affected event, the stored vs. correct bonus, the
//     unfiltered leaders it fetched, and the exact deltas — eyeball these
//     before running --apply.
//   • If /api/pga-results returns no round leaders for an event, that event is
//     reported as INCONCLUSIVE and skipped (never zeroed) — unusual-format
//     events (WGC Match Play = money only; FedEx staggered finales) should be
//     eyeballed manually.
//   • Writes are per-event batches; a failure on one event does not roll back
//     already-committed events, and re-running is idempotent (an already-correct
//     event reports "no change").
// ============================================================================

import { readFileSync } from 'node:fs';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// ── CLI / env ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const YEAR_OVERRIDE = (args.find(a => a.startsWith('--year=')) || '').split('=')[1] || null;
const TEAM_FILTER = (args.find(a => a.startsWith('--team=')) || '').split('=').slice(1).join('=') || null;
const EVENT_FILTER = (args.find(a => a.startsWith('--event=')) || '').split('=').slice(1).join('=') || null;
const SFGL_BASE = (process.env.SFGL_BASE || 'https://www.sfglgolf.com').replace(/\/+$/, '');

// ── Bonus defaults (mirror api/cron.js) ──────────────────────────────────────
const BONUSES_REG = { round1: 20000, round2: 40000, round3: 60000 };
const BONUSES_MAJ = { round1: 40000, round2: 80000, round3: 120000 };

// ── Name helpers (mirror api/cron.js normalizeName / matchName) ───────────────
const normalizeName = (name) =>
  (name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

const matchName = (a, b) => {
  const na = normalizeName(a), nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const wa = na.split(' '), wb = nb.split(' ');
  if (wa.length === wb.length) return wa.every(w => wb.includes(w));
  return false;
};

const lookupEarnings = (name, earningsMap) => {
  if (earningsMap[name] !== undefined) return earningsMap[name] || 0;
  const k = Object.keys(earningsMap).find(key => matchName(key, name));
  return k !== undefined ? (earningsMap[k] || 0) : 0;
};

// ── Tournament ordering (mirror src/api/firebase.js _byStartDate: start_date
//    ascending; docs missing start_date sort LAST) so tournamentIndex-based
//    mulligan references resolve correctly. ─────────────────────────────────
const byStartDate = (a, b) => {
  const sa = a.start_date || '', sb = b.start_date || '';
  if (!sa && !sb) return 0;
  if (!sa) return 1;
  if (!sb) return -1;
  return sa < sb ? -1 : sa > sb ? 1 : 0;
};

// ── Recompute a team's tournament result (mirror processTournamentData /
//    mulliganReversal.recomputeTeamTournamentResult): top-5 by earnings, plus
//    round-leader bonuses matched against the effective lineup. ─────────────
const recomputeTeamResult = (lineup, earningsMap, roundLeaders, isMajor, roster) => {
  const bonuses = isMajor ? BONUSES_MAJ : BONUSES_REG;
  const starterResults = (lineup || []).map(pn => ({ playerName: pn, earnings: lookupEarnings(pn, earningsMap) }));
  const topStarters = [...starterResults].sort((a, b) => b.earnings - a.earnings).slice(0, 5);
  let totalEarnings = topStarters.reduce((s, p) => s + p.earnings, 0);
  const bonusEarnings = { round1: 0, round2: 0, round3: 0 };
  const playersWithBonuses = {};
  ['round1', 'round2', 'round3'].forEach(round => {
    const leaders = Array.isArray(roundLeaders?.[round])
      ? roundLeaders[round]
      : (roundLeaders?.[round] ? [roundLeaders[round]] : []);
    leaders.forEach(leaderName => {
      if (!leaderName) return;
      const actual = (lineup || []).find(pn => normalizeName(pn) === normalizeName(leaderName));
      if (actual) {
        bonusEarnings[round] = bonuses[round];
        totalEarnings += bonuses[round];
        if (!playersWithBonuses[actual]) playersWithBonuses[actual] = { total: 0, rounds: [] };
        playersWithBonuses[actual].total += bonuses[round];
        playersWithBonuses[actual].rounds.push({ round: round.replace('round', ''), bonus: bonuses[round] });
      }
    });
  });
  const players = topStarters.map(s => ({
    name: s.playerName,
    earnings: s.earnings,
    limited: (roster || []).find(p => p.name === s.playerName)?.limited || false,
    bonus: playersWithBonuses[s.playerName]?.total || 0,
    roundsLed: playersWithBonuses[s.playerName]?.rounds || [],
    wasRoundLeader: (playersWithBonuses[s.playerName]?.total || 0) > 0,
  }));
  return { totalEarnings, bonuses: bonusEarnings, players };
};

// ── Fetch UNFILTERED round leaders from the deployed pga-results endpoint ─────
const fetchUnfilteredLeaders = async (name, year) => {
  const url = `${SFGL_BASE}/api/pga-results?name=${encodeURIComponent(name)}&year=${encodeURIComponent(year)}`;
  const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!resp.ok) throw new Error(`pga-results ${resp.status} for "${name}" (${year})`);
  const data = await resp.json();
  const rl = data.roundLeaders || {};
  const norm = (v) => (Array.isArray(v) ? v : (v ? [v] : [])).map(x => (typeof x === 'string' ? x : (x?.name || x?.displayName || ''))).filter(Boolean);
  return { round1: norm(rl.round1), round2: norm(rl.round2), round3: norm(rl.round3) };
};

const fmt = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const yearOf = (tournament) => {
  if (YEAR_OVERRIDE) return YEAR_OVERRIDE;
  const sd = tournament.start_date || '';
  const m = /^(\d{4})/.exec(sd);
  return m ? m[1] : String(new Date().getFullYear());
};

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const saRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!saRaw) {
    console.error('ERROR: FIREBASE_SERVICE_ACCOUNT env var not set.');
    process.exit(1);
  }
  let sa;
  try {
    // Accept either a JSON string or a path to a JSON file.
    sa = saRaw.trim().startsWith('{') ? JSON.parse(saRaw) : JSON.parse(readFileSync(saRaw, 'utf8'));
  } catch (e) {
    console.error('ERROR: FIREBASE_SERVICE_ACCOUNT is not valid JSON (or a readable JSON file path):', e.message);
    process.exit(1);
  }
  if (!getApps().length) initializeApp({ credential: cert(sa) });
  const db = getFirestore();

  console.log(`\n=== SFGL mulligan-bonus sweep ===`);
  console.log(`mode: ${APPLY ? 'APPLY (will write)' : 'DRY RUN (no writes)'}`);
  console.log(`pga-results base: ${SFGL_BASE}`);
  if (TEAM_FILTER) console.log(`team filter: ${TEAM_FILTER}`);
  if (EVENT_FILTER) console.log(`event filter: ${EVENT_FILTER}`);
  console.log('');

  // Load everything up front.
  const [teamSnap, tourneySnap, txSnap, settingsSnap] = await Promise.all([
    db.collection('teams').get(),
    db.collection('tournaments').get(),
    db.collection('transactions').get(),
    db.collection('league_settings').get(),
  ]);

  const teams = teamSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const teamById = new Map(teams.map(t => [t.id, t]));
  const teamByName = new Map(teams.map(t => [t.name, t]));

  const tournaments = tourneySnap.docs
    .map(d => ({ ...d.data(), name: d.data().name || d.id, _docId: d.id }))
    .sort(byStartDate);
  // Positional index used by tournamentIndex-based mulligan references.
  tournaments.forEach((t, i) => { t._index = i; });

  const settings = {};
  settingsSnap.docs.forEach(d => { settings[d.id] = d.data().value ?? d.data(); });
  const bonusFor = (isMajor) => (isMajor
    ? { round1: settings.bonusR1Major ?? BONUSES_MAJ.round1, round2: settings.bonusR2Major ?? BONUSES_MAJ.round2, round3: settings.bonusR3Major ?? BONUSES_MAJ.round3 }
    : { round1: settings.bonusR1Regular ?? BONUSES_REG.round1, round2: settings.bonusR2Regular ?? BONUSES_REG.round2, round3: settings.bonusR3Regular ?? BONUSES_REG.round3 });

  const mulligans = txSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(tx => tx.type === 'mulligan'
      && tx.status !== 'pending' && tx.status !== 'failed'
      && tx.player && tx.droppedPlayer);

  // Resolve a mulligan's target tournament: prefer name, fall back to index.
  const resolveTournament = (tx) => {
    const nm = tx.tournament ?? tx.tournamentName;
    if (nm) {
      const byName = tournaments.find(t => t.name === nm);
      if (byName) return byName;
    }
    if (tx.tournamentIndex != null) return tournaments[tx.tournamentIndex] || null;
    return null;
  };

  // Group mulligans by target completed tournament.
  const byTourney = new Map(); // tournament.name -> [mulligan tx]
  for (const mx of mulligans) {
    const t = resolveTournament(mx);
    if (!t || !t.completed || !t.results) continue;
    if (EVENT_FILTER && !t.name.toLowerCase().includes(EVENT_FILTER.toLowerCase())) continue;
    if (TEAM_FILTER && mx.team !== TEAM_FILTER) continue;
    if (!byTourney.has(t.name)) byTourney.set(t.name, []);
    byTourney.get(t.name).push(mx);
  }

  if (byTourney.size === 0) {
    console.log('No completed tournaments with applied mulligans found. Nothing to do.\n');
    return;
  }

  let affectedCount = 0, fixedCount = 0, inconclusiveCount = 0, cleanCount = 0;
  const pendingWrites = []; // { tournament, teamUpdates:Map, resultsPatch }

  for (const [tourneyName, muls] of byTourney) {
    const tournament = tournaments.find(t => t.name === tourneyName);
    const isMajor = !!tournament.isMajor;
    const results = tournament.results;
    const earningsMap = results.earningsMap || {};
    const storedLeaders = results.roundLeaders || {};

    console.log(`\n── ${tourneyName} ${isMajor ? '(MAJOR)' : ''} — ${muls.length} mulligan(s) ──`);

    // Fetch the true, unfiltered round leaders once per event.
    let unfiltered = null;
    try {
      unfiltered = await fetchUnfilteredLeaders(tourneyName, yearOf(tournament));
      const leadStr = ['round1', 'round2', 'round3']
        .map(r => `${r.replace('round', 'R')}: ${(unfiltered[r] || []).join(', ') || '—'}`).join('  |  ');
      console.log(`   fetched leaders → ${leadStr}`);
    } catch (e) {
      console.log(`   ⚠️  could not fetch leaders (${e.message}). Falling back to STORED leaders (may be filtered).`);
    }
    const leadersForCalc = unfiltered || storedLeaders;
    const anyLeaders = ['round1', 'round2', 'round3'].some(r => (leadersForCalc?.[r] || []).length);

    // Per-team result patches and per-team earnings deltas for this event.
    const resultsTeamsPatch = {};
    const resultsFullLineupsPatch = {};
    const teamEarningsDelta = new Map(); // teamId -> delta

    // Group this event's mulligans by team.
    const mulsByTeam = new Map();
    for (const mx of muls) {
      if (!mulsByTeam.has(mx.team)) mulsByTeam.set(mx.team, []);
      mulsByTeam.get(mx.team).push(mx);
    }

    for (const [teamName, teamMuls] of mulsByTeam) {
      const team = teamByName.get(teamName);
      if (!team) { console.log(`   • ${teamName}: team not found, skipping`); continue; }
      const storedTeamRes = results.teams?.[team.id];
      if (!storedTeamRes) { console.log(`   • ${teamName}: no stored result for this event, skipping`); continue; }

      // Build the effective lineup: stored full lineup with each mulligan
      // OUT→IN applied. Fall back to the stored top-5 names if fullLineups
      // is absent (older events).
      let effLineup = Array.isArray(results.fullLineups?.[team.id])
        ? [...results.fullLineups[team.id]]
        : (storedTeamRes.players || []).map(p => p.name || p);
      const inNames = [];
      for (const mx of teamMuls) {
        const idx = effLineup.findIndex(n => n === mx.droppedPlayer);
        if (idx !== -1) effLineup[idx] = mx.player;
        else if (!effLineup.includes(mx.player)) effLineup.push(mx.player);
        inNames.push(mx.player);
      }

      const stored = {
        total: storedTeamRes.totalEarnings || 0,
        bonusByName: Object.fromEntries((storedTeamRes.players || []).map(p => [(p.name || p), p.bonus || 0])),
      };

      if (!anyLeaders) {
        console.log(`   • ${teamName}: INCONCLUSIVE — no round-leader data available; skipped (eyeball manually).`);
        inconclusiveCount++;
        continue;
      }

      const recomputed = recomputeTeamResult(effLineup, earningsMap, leadersForCalc, isMajor, team.roster);
      // Preserve mulligan display markers on the IN player(s).
      const markedPlayers = recomputed.players.map(p =>
        inNames.includes(p.name)
          ? { ...p, mulliganIn: true, replacedPlayer: (teamMuls.find(m => m.player === p.name)?.droppedPlayer) || null }
          : p
      );

      const totalDelta = recomputed.totalEarnings - stored.total;
      // Report the IN player bonus specifically.
      const inReport = inNames.map(nm => {
        const before = stored.bonusByName[nm] || 0;
        const after = recomputed.players.find(p => p.name === nm)?.bonus || 0;
        return `${nm}: bonus ${fmt(before)} → ${fmt(after)}`;
      }).join('; ');

      if (Math.abs(totalDelta) < 0.5) {
        console.log(`   • ${teamName}: already correct — ${inReport}. No change.`);
        cleanCount++;
        continue;
      }

      affectedCount++;
      console.log(`   • ${teamName}: NEEDS FIX — ${inReport}`);
      console.log(`       team total ${fmt(stored.total)} → ${fmt(recomputed.totalEarnings)}  (Δ ${totalDelta >= 0 ? '+' : ''}${fmt(totalDelta)})`);

      // Stage the patch for this team.
      resultsTeamsPatch[team.id] = {
        ...storedTeamRes,
        totalEarnings: recomputed.totalEarnings,
        bonuses: recomputed.bonuses,
        players: markedPlayers,
      };
      resultsFullLineupsPatch[team.id] = effLineup;
      teamEarningsDelta.set(team.id, (teamEarningsDelta.get(team.id) || 0) + totalDelta);

      // Money side: per-player sfglEarnings was already handled by the old
      // path (money was credited; only the bonus was lost) and bonuses never
      // flow into sfglEarnings, so under the 5-starter rule there is no
      // per-player money delta to apply. Verify and warn if that ever fails.
      const oldMoney = {}; (storedTeamRes.players || []).forEach(p => { oldMoney[p.name || p] = (oldMoney[p.name || p] || 0) + (p.earnings || 0); });
      const newMoney = {}; recomputed.players.forEach(p => { newMoney[p.name] = (newMoney[p.name] || 0) + (p.earnings || 0); });
      const moneyDiffers = [...new Set([...Object.keys(oldMoney), ...Object.keys(newMoney)])]
        .some(n => Math.abs((newMoney[n] || 0) - (oldMoney[n] || 0)) > 0.5);
      if (moneyDiffers) {
        console.log(`       ⚠️  per-player MONEY changed too (top-5 composition shifted). Roster sfglEarnings deltas will be applied.`);
        resultsTeamsPatch[team.id]._moneyDelta = Object.fromEntries(
          [...new Set([...Object.keys(oldMoney), ...Object.keys(newMoney)])]
            .map(n => [n, (newMoney[n] || 0) - (oldMoney[n] || 0)])
            .filter(([, d]) => Math.abs(d) > 0.5)
        );
      }
      fixedCount++;
    }

    if (APPLY && Object.keys(resultsTeamsPatch).length) {
      pendingWrites.push({ tournament, resultsTeamsPatch, resultsFullLineupsPatch, teamEarningsDelta });
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n=== summary ===`);
  console.log(`teams needing a bonus fix: ${affectedCount}`);
  console.log(`teams already correct:     ${cleanCount}`);
  console.log(`teams inconclusive:        ${inconclusiveCount}`);

  if (!APPLY) {
    console.log(`\nDRY RUN — nothing written. Re-run with --apply to commit the fixes above.\n`);
    return;
  }

  if (!pendingWrites.length) {
    console.log(`\nNothing to write.\n`);
    return;
  }

  console.log(`\nApplying ${pendingWrites.length} event write(s)...`);
  for (const w of pendingWrites) {
    const { tournament, resultsTeamsPatch, resultsFullLineupsPatch, teamEarningsDelta } = w;
    const batch = db.batch();

    // Merge patches into the stored results object.
    const newResults = {
      ...tournament.results,
      teams: { ...(tournament.results.teams || {}) },
      fullLineups: { ...(tournament.results.fullLineups || {}) },
    };
    const rosterMoneyDeltas = new Map(); // teamId -> { playerName: delta }
    for (const [teamId, patch] of Object.entries(resultsTeamsPatch)) {
      const { _moneyDelta, ...clean } = patch;
      newResults.teams[teamId] = clean;
      if (_moneyDelta) rosterMoneyDeltas.set(teamId, _moneyDelta);
    }
    for (const [teamId, ln] of Object.entries(resultsFullLineupsPatch)) {
      newResults.fullLineups[teamId] = ln;
    }

    batch.update(db.collection('tournaments').doc(tournament._docId), { results: newResults });

    // Team earnings/segmentEarnings deltas (+ any rare roster money deltas).
    for (const [teamId, delta] of teamEarningsDelta) {
      const team = teamById.get(teamId);
      if (!team) continue;
      const update = {
        earnings: (team.earnings || 0) + delta,
        segmentEarnings: (team.segmentEarnings || 0) + delta,
      };
      const md = rosterMoneyDeltas.get(teamId);
      if (md) {
        update.roster = (team.roster || []).map(p => {
          const d = md[p.name];
          if (!d) return p;
          return { ...p, sfglEarnings: Math.max(0, (p.sfglEarnings || 0) + d) };
        });
      }
      batch.update(db.collection('teams').doc(teamId), update);
    }

    await batch.commit();
    console.log(`   ✓ ${tournament.name}`);
  }

  console.log(`\nDone. Applied fixes to ${pendingWrites.length} event(s).\n`);
}

main().catch(err => { console.error('\nFATAL:', err); process.exit(1); });
