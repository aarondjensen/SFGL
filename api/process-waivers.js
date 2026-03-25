// api/process-waivers.js — auto waiver processing
// Cron: "5 0 * * 3" = 12:05am UTC Wednesday = 8:05pm EDT Tuesday
// Manual: POST /api/process-waivers with header x-sfgl-secret: YOUR_SECRET

import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, writeBatch } from 'firebase/firestore';

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

function isPastWaiverDeadline() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return et.getDay() === 2 && et.getHours() >= 20;
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
  const dropped = new Set(), done = new Set(), failed = new Set(), applied = [];
  const tx2 = [...transactions]; let p = 0, f = 0, more = true;

  while (more) {
    more = false;
    const round = []; Object.entries(byTeam).forEach(([tn, claims]) => { const top = claims.find(c => !done.has(c._idx) && !failed.has(c._idx)); if (top) round.push({ tn, claim: top, o: pm[tn] ?? 999 }); });
    if (!round.length) break;
    const byP = {}; round.forEach(rc => { if (!byP[rc.claim.player]) byP[rc.claim.player] = []; byP[rc.claim.player].push(rc); });
    Object.entries(byP).forEach(([player, cs]) => {
      cs.sort((a, b) => a.o - b.o); const w = cs[0];
      if (allR.has(player)) { cs.forEach(c => { failed.add(c.claim._idx); tx2[c.claim._idx] = { ...tx2[c.claim._idx], status: 'failed', failReason: 'Already rostered', processedDate: new Date().toLocaleDateString() }; f++; }); more = true; return; }
      if (w.claim.droppedPlayer && (dropped.has(w.claim.droppedPlayer) || !allR.has(w.claim.droppedPlayer))) { failed.add(w.claim._idx); tx2[w.claim._idx] = { ...tx2[w.claim._idx], status: 'failed', failReason: 'Drop target unavailable', processedDate: new Date().toLocaleDateString() }; f++; more = true; return; }
      if (w.claim.droppedPlayer) { allR.delete(w.claim.droppedPlayer); dropped.add(w.claim.droppedPlayer); }
      allR.add(player); done.add(w.claim._idx); tx2[w.claim._idx] = { ...tx2[w.claim._idx], status: 'processed', processedDate: new Date().toLocaleDateString() }; applied.push(w.claim); p++;
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
  const isCron = req.headers['x-vercel-cron'] === '1';
  const isManual = req.method === 'POST' && req.headers['x-sfgl-secret'] === process.env.SFGL_CRON_SECRET;

  if (!isCron && !isManual) return res.status(401).json({ error: 'Unauthorized' });
  if (isCron && !isPastWaiverDeadline()) return res.status(200).json({ message: 'Not yet deadline' });

  try {
    const db = getDb();
    const result = await processWaivers(db);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
