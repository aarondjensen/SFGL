// api/process-waivers.js — auto waiver processing
// Cron: fires daily; the function reads waiver-deadline settings from Firestore
// and processes only when current time is past the configured deadline AND
// today's run hasn't already happened (idempotent).
// Manual: POST /api/process-waivers with header x-sfgl-secret: YOUR_SECRET

import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, getDoc, setDoc, writeBatch } from 'firebase/firestore';

const firebaseConfig = {
  apiKey:            process.env.VITE_FIREBASE_API_KEY,
  authDomain:        process.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         process.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     process.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             process.env.VITE_FIREBASE_APP_ID,
};

function getDb() {
  if (!getApps().length) initializeApp(firebaseConfig);
  return getFirestore();
}

// Wave 8: read AdminView's configurable waiver-deadline settings from
// Firestore (league_settings collection, one doc per setting). Returns the
// configured day-of-week (0–6, Sun=0), hour (0–23), and minute (0–59), with
// safe defaults if any are missing.
async function loadWaiverDeadline(db) {
  const snap = await getDocs(collection(db, 'league_settings'));
  const s = {};
  snap.docs.forEach(d => { s[d.id] = d.data().value ?? d.data(); });
  return {
    waiverDay:    typeof s.waiverDay    === 'number' ? s.waiverDay    : 2,   // Tuesday
    waiverHour:   typeof s.waiverHour   === 'number' ? s.waiverHour   : 20,  // 8 PM
    waiverMinute: typeof s.waiverMinute === 'number' ? s.waiverMinute : 0,
  };
}

// Wave 8: determine whether the function should process waivers right now.
// Logic: find the most recent occurrence of the configured day+time in ET.
// If the current time is past that occurrence AND the last recorded auto-run
// is older than that occurrence, we should run. Idempotency uses a Firestore
// doc that stores the timestamp of the last successful run.
async function shouldProcessWaivers(db) {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const settings = await loadWaiverDeadline(db);

  // Compute the most recent deadline occurrence in ET.
  const dl = new Date(et);
  dl.setHours(settings.waiverHour, settings.waiverMinute, 0, 0);
  const dayDiff = (dl.getDay() - settings.waiverDay + 7) % 7;
  if (dayDiff === 0) {
    // Today matches the configured day. If today's deadline is in the future,
    // back up to last week's occurrence.
    if (et < dl) dl.setDate(dl.getDate() - 7);
  } else {
    dl.setDate(dl.getDate() - dayDiff);
  }

  if (et < dl) return { run: false, reason: 'before deadline', nextDeadline: dl.toISOString() };

  // Idempotency: have we already processed for this deadline?
  const metaSnap = await getDoc(doc(db, 'sfgl_data', 'last_auto_waiver'));
  if (metaSnap.exists()) {
    const lastVal = metaSnap.data().value;
    const lastMs = typeof lastVal === 'string' ? Date.parse(lastVal) : Number(lastVal);
    if (Number.isFinite(lastMs) && lastMs >= dl.getTime()) {
      return { run: false, reason: 'already processed for this deadline', deadline: dl.toISOString() };
    }
  }
  return { run: true, deadline: dl };
}

function buildRoster(team, transactions) {
  const rosterSet = new Set((team.roster || []).map(p => p.name));
  transactions
    .filter(tx => tx.team === team.name && tx.type !== 'mulligan' && (tx.status === 'processed' || tx.status === 'completed'))
    .forEach(tx => {
      if (tx.droppedPlayer) rosterSet.delete(tx.droppedPlayer);
      if (tx.player) rosterSet.add(tx.player);
    });
  return rosterSet;
}

function applyWaiver(team, waiver) {
  const roster = [...(team.roster || [])];
  if (waiver.droppedPlayer) {
    const idx = roster.findIndex(p => p.name === waiver.droppedPlayer);
    if (idx !== -1) roster.splice(idx, 1);
  }
  if (waiver.player && !roster.find(p => p.name === waiver.player)) {
    roster.push({ name: waiver.player, limited: false, starts: 0 });
  }
  return { ...team, roster, transactionFees: (team.transactionFees || 0) + (waiver.fee || 0) };
}

async function processWaivers(db) {
  const [teamsSnap, txSnap] = await Promise.all([
    getDocs(collection(db, 'teams')),
    getDocs(collection(db, 'transactions')),
  ]);

  const teams = teamsSnap.docs.map(d => ({ id: d.id, ...d.data(), lineup: d.data().lineup || [], roster: d.data().roster || [] }));
  const transactions = txSnap.docs.map(d => ({ _docId: d.id, ...d.data() }));

  const pending = transactions
    .map((t, idx) => ({ ...t, _idx: idx }))
    .filter(t => t.status === 'pending' && t.type === 'waiver')
    .sort((a, b) => (a.priority || 999) - (b.priority || 999));

  if (!pending.length) return { processed: 0, failed: 0, message: 'No pending waivers' };

  const pm = {}; [...teams].sort((a, b) => (a.earnings || 0) - (b.earnings || 0)).forEach((t, i) => { pm[t.name] = i; });
  let nextLastPlace = teams.length;
  const byTeam = {}; pending.forEach(w => { if (!byTeam[w.team]) byTeam[w.team] = []; byTeam[w.team].push(w); });
  Object.values(byTeam).forEach(c => c.sort((a, b) => (a.priority || 999) - (b.priority || 999)));
  const allR = new Set(); teams.forEach(t => buildRoster(t, transactions).forEach(n => allR.add(n)));

  // Wave 8: per-team roster + drop tracking. Previously a single global
  // `dropped` set conflated "drop target already used by an earlier successful
  // claim from THIS team" with "drop target not on any roster" under one
  // misleading "Drop target unavailable" message — and could fail a perfectly
  // legal claim. Example bug: Team A submits two claims both dropping Player X;
  // claim 1 loses a tiebreaker (X is NOT actually dropped); claim 2 then
  // fails because the global state thinks X is gone, even though he's still
  // on Team A's roster. We now track drops per team and validate the drop
  // target against the claimant's CURRENT (per-team) roster snapshot.
  const teamRosters = {};
  teams.forEach(t => { teamRosters[t.name] = new Set(buildRoster(t, transactions)); });
  const droppedByTeam = {};

  const done = new Set(), failed = new Set(), applied = [];
  const tx2 = [...transactions]; let p = 0, f = 0, more = true;

  while (more) {
    more = false;
    const round = []; Object.entries(byTeam).forEach(([tn, claims]) => { const top = claims.find(c => !done.has(c._idx) && !failed.has(c._idx)); if (top) round.push({ tn, claim: top, o: pm[tn] ?? 999 }); });
    if (!round.length) break;
    const byP = {}; round.forEach(rc => { if (!byP[rc.claim.player]) byP[rc.claim.player] = []; byP[rc.claim.player].push(rc); });
    Object.entries(byP).forEach(([player, cs]) => {
      cs.sort((a, b) => a.o - b.o); const w = cs[0];
      if (allR.has(player)) { cs.forEach(c => { failed.add(c.claim._idx); tx2[c.claim._idx] = { ...tx2[c.claim._idx], status: 'failed', failReason: 'Already rostered', processedDate: new Date().toLocaleDateString() }; f++; }); more = true; return; }

      // Wave 8: per-team drop validation with distinct error messages
      if (w.claim.droppedPlayer) {
        const winnerTeamRoster = teamRosters[w.tn] || new Set();
        const winnerTeamDropped = droppedByTeam[w.tn] || new Set();
        if (winnerTeamDropped.has(w.claim.droppedPlayer)) {
          failed.add(w.claim._idx);
          tx2[w.claim._idx] = { ...tx2[w.claim._idx], status: 'failed', failReason: w.claim.droppedPlayer + ' already dropped by earlier claim', processedDate: new Date().toLocaleDateString() };
          f++; more = true; return;
        }
        if (!winnerTeamRoster.has(w.claim.droppedPlayer)) {
          failed.add(w.claim._idx);
          tx2[w.claim._idx] = { ...tx2[w.claim._idx], status: 'failed', failReason: w.claim.droppedPlayer + ` not on ${w.tn}'s roster`, processedDate: new Date().toLocaleDateString() };
          f++; more = true; return;
        }
      }

      // Apply winner to global allR + per-team trackers
      if (w.claim.droppedPlayer) {
        allR.delete(w.claim.droppedPlayer);
        if (!droppedByTeam[w.tn]) droppedByTeam[w.tn] = new Set();
        droppedByTeam[w.tn].add(w.claim.droppedPlayer);
        if (teamRosters[w.tn]) teamRosters[w.tn].delete(w.claim.droppedPlayer);
      }
      allR.add(player);
      if (teamRosters[w.tn]) teamRosters[w.tn].add(player);
      done.add(w.claim._idx); tx2[w.claim._idx] = { ...tx2[w.claim._idx], status: 'processed', processedDate: new Date().toLocaleDateString() }; applied.push(w.claim); p++;
      pm[w.tn] = nextLastPlace++;
      cs.slice(1).forEach(l => { failed.add(l.claim._idx); tx2[l.claim._idx] = { ...tx2[l.claim._idx], status: 'failed', failReason: 'Lost tiebreaker to ' + w.tn, processedDate: new Date().toLocaleDateString() }; f++; }); more = true;
    });
  }

  let t2 = [...teams]; applied.forEach(w => { t2 = t2.map(t => applyWaiver(t, w)); });

  // Write changes back to Firestore
  const batch = writeBatch(db);
  tx2.forEach((tx, idx) => {
    if (transactions[idx]?.status !== tx.status && tx._docId) {
      batch.update(doc(db, 'transactions', tx._docId), {
        status: tx.status,
        ...(tx.failReason && { failReason: tx.failReason }),
        processedDate: tx.processedDate,
      });
    }
  });
  t2.forEach(team => {
    if (applied.some(w => w.team === team.name)) {
      batch.update(doc(db, 'teams', team.id), {
        roster: team.roster,
        transactionFees: team.transactionFees,
      });
    }
  });
  await batch.commit();

  return { processed: p, failed: f, message: `Processed ${p} waiver${p !== 1 ? 's' : ''}${f ? `, ${f} failed` : ''}` };
}

export default async function handler(req, res) {
  // Wave 8: three valid invocation paths.
  // 1. Vercel cron (x-vercel-cron: 1 header) — applies deadline + idempotency gates.
  // 2. cron-job.org or any external scheduler (Authorization: Bearer <CRON_SECRET>)
  //    — also applies deadline + idempotency gates. This is the path used for
  //    minute-precision auto-processing per AdminView's configured waiver time.
  // 3. Manual override (POST with x-sfgl-secret) — bypasses gates so commish
  //    can force a run from AdminView regardless of time / idempotency state.
  const isVercelCron   = req.headers['x-vercel-cron'] === '1';
  const cronSecret     = process.env.CRON_SECRET;
  const isExternalCron = !!cronSecret && req.headers.authorization === `Bearer ${cronSecret}`;
  const isCron         = isVercelCron || isExternalCron;
  const isManual       = req.method === 'POST' && req.headers['x-sfgl-secret'] === process.env.SFGL_CRON_SECRET;

  if (!isCron && !isManual) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const db = getDb();

    // Cron invocations validate against AdminView's configurable settings
    // (waiverDay/Hour/Minute) and a Firestore-backed idempotency doc.
    // Manual invocations skip these gates so the commish can force a run
    // from AdminView if needed.
    if (isCron) {
      const check = await shouldProcessWaivers(db);
      if (!check.run) return res.status(200).json({ status: 'skipped', reason: check.reason, ...(check.nextDeadline && { nextDeadline: check.nextDeadline }) });
    }

    const result = await processWaivers(db);

    // Stamp the idempotency doc on success so we don't process again
    // until the next deadline occurrence (or until the doc is cleared).
    if (isCron) {
      await setDoc(doc(db, 'sfgl_data', 'last_auto_waiver'), {
        key: 'last_auto_waiver',
        value: new Date().toISOString(),
      });
    }

    return res.status(200).json({ status: 'ok', ...result });
  } catch (err) {
    console.error('[process-waivers] error:', err);
    return res.status(500).json({ error: err.message });
  }
}
