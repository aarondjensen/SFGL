// api/cron-waivers.js — Vercel Cron Job
// Auto-processes pending waiver claims at the configured time and emails results.
// Schedule: runs every 5 minutes (configured in vercel.json)
//
// Logic mirrors AdminView.handleProcessAll exactly:
//   1. Check if current ET time is past the configured waiver cutoff
//   2. Check if there are pending waiver claims
//   3. Process using tiebreaker logic (lowest earnings wins)
//   4. Update Firebase (teams, transactions)
//   5. Email results to all managers

import { db } from './firebase-admin.js';
import { sendToAll, buildWaiverResultsEmail } from './send-email.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function getETNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

function isPastCutoff(settings) {
  const et = getETNow();
  const day = et.getDay();
  const timeVal = et.getHours() * 60 + et.getMinutes();
  const wDay = settings?.waiverDay ?? 2;
  const wHour = settings?.waiverHour ?? 20;
  const wMin = settings?.waiverMinute ?? 0;
  return day === wDay && timeVal >= (wHour * 60 + wMin);
}

// ── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // Verify cron secret (Vercel sends CRON_SECRET header for cron jobs)
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // 1. Load settings
    const settingsSnap = await db.collection('league_settings').get();
    const settings = {};
    settingsSnap.docs.forEach(d => { settings[d.id] = d.data().value ?? d.data(); });

    // Check if it's time to process
    if (!isPastCutoff(settings)) {
      return res.json({ status: 'not_yet', message: 'Not past waiver cutoff time' });
    }

    // Check if already processed today (prevent double-processing)
    const metaSnap = await db.collection('sfgl_data').doc('last_auto_waiver').get();
    const lastRun = metaSnap.exists ? metaSnap.data().value : null;
    const today = getETNow().toLocaleDateString('en-US');
    if (lastRun === today) {
      return res.json({ status: 'already_run', message: 'Waivers already processed today' });
    }

    // 2. Load transactions
    const txSnap = await db.collection('transactions').get();
    const allTransactions = txSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const pending = allTransactions.filter(tx => tx.status === 'pending' && tx.type === 'waiver');

    if (pending.length === 0) {
      // Mark as run even with no pending — so we don't keep checking
      await db.collection('sfgl_data').doc('last_auto_waiver').set({ key: 'last_auto_waiver', value: today });
      return res.json({ status: 'no_pending', message: 'No pending waiver claims' });
    }

    // 3. Load teams
    const teamsSnap = await db.collection('teams').get();
    let teams = teamsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // 4. Process waivers — mirrors handleProcessAll logic exactly
    const em = {};
    teams.forEach(t => { em[t.name] = t.earnings || 0; });
    const pm = {};
    [...teams].sort((a, b) => (a.earnings || 0) - (b.earnings || 0)).forEach((t, i) => { pm[t.name] = i; });
    let nextLastPlace = teams.length;

    // Group by team, sort each team's claims by priority
    const byTeam = {};
    pending.forEach(w => { if (!byTeam[w.team]) byTeam[w.team] = []; byTeam[w.team].push(w); });
    Object.values(byTeam).forEach(c => c.sort((a, b) => (a.priority || 999) - (b.priority || 999)));

    // Build current rostered set
    const allRostered = new Set();
    teams.forEach(t => {
      (t.roster || []).forEach(p => allRostered.add(p.name));
    });

    const dropped = new Set();
    const done = new Set();
    const failed = new Set();
    const applied = [];
    const processedResults = []; // for email summary
    let more = true;

    while (more) {
      more = false;
      const round = [];
      Object.entries(byTeam).forEach(([tn, claims]) => {
        const top = claims.find(c => !done.has(c.id) && !failed.has(c.id));
        if (top) round.push({ tn, claim: top, o: pm[tn] ?? 999 });
      });
      if (!round.length) break;

      // Group by player to find competing claims
      const byPlayer = {};
      round.forEach(rc => {
        if (!byPlayer[rc.claim.player]) byPlayer[rc.claim.player] = [];
        byPlayer[rc.claim.player].push(rc);
      });

      Object.entries(byPlayer).forEach(([player, cs]) => {
        cs.sort((a, b) => a.o - b.o);
        const w = cs[0];

        // Player already rostered?
        if (allRostered.has(player)) {
          cs.forEach(c => {
            failed.add(c.claim.id);
            processedResults.push({ ...c.claim, status: 'failed', failReason: 'Player already rostered' });
          });
          more = true;
          return;
        }

        // Drop player already gone?
        if (w.claim.droppedPlayer && (dropped.has(w.claim.droppedPlayer) || !allRostered.has(w.claim.droppedPlayer))) {
          failed.add(w.claim.id);
          processedResults.push({ ...w.claim, status: 'failed', failReason: w.claim.droppedPlayer + ' already dropped' });
          more = true;
          return;
        }

        // Winner processes
        if (w.claim.droppedPlayer) {
          allRostered.delete(w.claim.droppedPlayer);
          dropped.add(w.claim.droppedPlayer);
        }
        allRostered.add(player);
        done.add(w.claim.id);
        applied.push(w.claim);
        processedResults.push({ ...w.claim, status: 'processed' });

        pm[w.tn] = nextLastPlace++;

        // Losers
        const winEarn = '$' + (em[w.tn] || 0).toLocaleString();
        cs.slice(1).forEach(l => {
          const loseEarn = '$' + (em[l.tn] || 0).toLocaleString();
          failed.add(l.claim.id);
          processedResults.push({
            ...l.claim,
            status: 'failed',
            failReason: `Lost tiebreaker to ${w.tn} (${winEarn} vs ${loseEarn})`,
          });
        });
        more = true;
      });
    }

    // 5. Write results to Firebase
    const batch = db.batch();
    const processedDate = new Date().toLocaleDateString();

    // Update transaction statuses
    processedResults.forEach(r => {
      if (r.id) {
        const ref = db.collection('transactions').doc(r.id);
        const update = { status: r.status, processedDate };
        if (r.failReason) update.failReason = r.failReason;
        batch.update(ref, update);
      }
    });

    // Apply roster changes for winners
    for (const w of applied) {
      const team = teams.find(t => t.name === w.team);
      if (!team) continue;

      let roster = [...(team.roster || [])];
      if (w.droppedPlayer) roster = roster.filter(p => p.name !== w.droppedPlayer);
      if (!roster.some(p => p.name === w.player)) {
        roster.push({
          name: w.player, limited: false, stars: 0, unlimited: false,
          yearsOfService: 1, starts: 0, eventsPlayed: 0, cutsMade: 0,
          pgaTourEarnings: 0, sfglEarnings: 0, headshot: '',
        });
      }

      const fee = w.fee || 0;
      batch.update(db.collection('teams').doc(team.id), {
        roster,
        transactionFees: (team.transactionFees || 0) + fee,
      });
    }

    // Mark today as processed
    batch.set(db.collection('sfgl_data').doc('last_auto_waiver'), { key: 'last_auto_waiver', value: today });

    await batch.commit();

    // 6. Send emails to all managers
    const emailMap = settings.managerEmails || {};
    const managerEmails = {};
    teams.forEach(t => {
      const email = emailMap[t.id] || emailMap[t.name];
      if (email) managerEmails[t.name] = email;
    });

    const emailResults = [];
    for (const [teamName, email] of Object.entries(managerEmails)) {
      try {
        const html = buildWaiverResultsEmail(processedResults, teamName);
        const result = await sendToAll([email], '⏰ SFGL Waiver Results', () => html);
        emailResults.push({ team: teamName, ...result[0] });
      } catch (err) {
        emailResults.push({ team: teamName, error: err.message });
      }
    }

    return res.json({
      status: 'processed',
      processed: applied.length,
      failed: processedResults.filter(r => r.status === 'failed').length,
      emailsSent: emailResults.filter(r => r.success).length,
      details: processedResults.map(r => ({ team: r.team, player: r.player, status: r.status, failReason: r.failReason })),
    });

  } catch (err) {
    console.error('[cron-waivers] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
