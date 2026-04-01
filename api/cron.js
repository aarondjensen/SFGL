// api/cron.js — single consolidated endpoint for all cron/email operations
// Routes via ?action= query parameter:
//   ?action=waivers          — auto-process pending waivers
//   ?action=lineup-reminder  — send lineup reminders to managers without lineups
//   ?action=notify-results   — send tournament results emails (POST with body)
//
// This consolidates what would be 5 separate functions into 1 to stay under
// Vercel Hobby plan's 12 serverless function limit.

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// ── Firebase Admin init ─────────────────────────────────────────────────────

function getApp() {
  if (getApps().length) return getApps()[0];
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!sa) throw new Error('FIREBASE_SERVICE_ACCOUNT env var not set');
  return initializeApp({ credential: cert(JSON.parse(sa)) });
}

const db = getFirestore(getApp());

// ── Brevo email ─────────────────────────────────────────────────────────────

const BREVO_API = 'https://api.brevo.com/v3/smtp/email';

function parseSender(from) {
  const match = from.match(/^(.+?)\s*<(.+?)>$/);
  if (match) return { name: match[1].trim(), email: match[2].trim() };
  return { email: from.trim() };
}

async function sendEmail(to, subject, html) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) { console.warn('[sendEmail] BREVO_API_KEY not set'); return { skipped: true }; }
  const sender = parseSender(process.env.EMAIL_FROM || 'SFGL <league@sfglgolf.com>');
  const resp = await fetch(BREVO_API, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ sender, to: [{ email: to }], subject, htmlContent: html }),
  });
  const data = await resp.json();
  if (!resp.ok) { console.error('[sendEmail] Brevo error:', data); throw new Error(data.message || 'Email send failed'); }
  return data;
}

// ── Email templates ─────────────────────────────────────────────────────────

const HEADER = `<div style="background:#0a1628;padding:20px 24px;border-bottom:2px solid rgba(220,170,60,0.4);"><h1 style="font-family:Georgia,serif;font-size:22px;color:#c4a24e;margin:0;letter-spacing:2px;">SFGL</h1><p style="font-family:-apple-system,sans-serif;font-size:11px;color:rgba(255,255,255,0.5);margin:4px 0 0;letter-spacing:1px;text-transform:uppercase;">2026 Season</p></div>`;
const FOOTER = `<div style="padding:16px 24px;border-top:1px solid rgba(255,255,255,0.08);text-align:center;"><a href="https://sfglgolf.com" style="font-family:-apple-system,sans-serif;font-size:12px;color:#c4a24e;text-decoration:none;">sfglgolf.com</a><p style="font-family:-apple-system,sans-serif;font-size:10px;color:rgba(255,255,255,0.3);margin:6px 0 0;">You're receiving this because you're a manager in the SFGL fantasy golf league.</p></div>`;

function wrap(body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="margin:0;padding:0;background:#060e1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;"><div style="max-width:560px;margin:0 auto;background:#0f1e30;border-radius:4px;overflow:hidden;border:1px solid rgba(255,255,255,0.08);">${HEADER}<div style="padding:24px;">${body}</div>${FOOTER}</div></body></html>`;
}

function buildWaiverResultsEmail(processed, recipientTeam) {
  const rows = processed.map(w => {
    const isMe = w.team === recipientTeam;
    const bg = w.status === 'processed' ? (isMe ? 'rgba(80,180,120,0.15)' : 'rgba(80,180,120,0.06)') : 'rgba(200,60,60,0.08)';
    const icon = w.status === 'processed' ? '✅' : '❌';
    const label = w.status === 'processed' ? 'Approved' : 'Blocked';
    return `<div style="background:${bg};border:1px solid rgba(255,255,255,0.06);border-radius:3px;padding:10px 14px;margin-bottom:6px;${isMe ? 'border-left:3px solid #c4a24e;' : ''}"><div style="font-size:13px;font-weight:600;color:${isMe ? '#ffffff' : 'rgba(255,255,255,0.8)'};">${w.team}<span style="float:right;font-size:11px;font-weight:400;color:${w.status === 'processed' ? '#50b478' : '#cc5555'};">${icon} ${label}</span></div><div style="font-size:12px;margin-top:4px;"><span style="color:#50b478;">+ ${w.player}</span>${w.droppedPlayer ? `<span style="color:rgba(255,255,255,0.3);"> → </span><span style="color:#cc5555;">- ${w.droppedPlayer}</span>` : ''}</div>${w.failReason ? `<div style="font-size:10px;color:rgba(255,255,255,0.4);margin-top:3px;">${w.failReason}</div>` : ''}</div>`;
  }).join('');
  return wrap(`<h2 style="font-family:Georgia,serif;font-size:16px;color:#c4a24e;margin:0 0 4px;">⏰ Waiver Results</h2><p style="font-size:12px;color:rgba(255,255,255,0.5);margin:0 0 16px;">Processed ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</p>${rows}`);
}

function buildTournamentResultsEmail(tournamentName, teamResults, recipientTeam) {
  const sorted = [...teamResults].sort((a, b) => b.totalEarnings - a.totalEarnings);
  const rows = sorted.map((tr, i) => {
    const isMe = tr.team === recipientTeam;
    return `<div style="padding:8px 12px;background:${isMe ? 'rgba(196,162,78,0.1)' : 'rgba(255,255,255,0.02)'};border-radius:3px;margin-bottom:4px;${isMe ? 'border-left:3px solid #c4a24e;' : ''}"><span style="font-size:14px;font-weight:700;color:rgba(255,255,255,0.3);display:inline-block;width:20px;">${i + 1}</span><span style="font-size:13px;font-weight:${isMe ? '700' : '500'};color:${isMe ? '#ffffff' : 'rgba(255,255,255,0.75)'};">${tr.team}</span><span style="float:right;font-size:13px;font-weight:600;color:#50b478;">$${(tr.totalEarnings || 0).toLocaleString()}</span></div>`;
  }).join('');
  return wrap(`<h2 style="font-family:Georgia,serif;font-size:16px;color:#c4a24e;margin:0 0 4px;">🏆 ${tournamentName}</h2><p style="font-size:12px;color:rgba(255,255,255,0.5);margin:0 0 16px;">Tournament Results</p>${rows}`);
}

function buildLineupReminderEmail(tournamentName, lockTime, recipientTeam) {
  return wrap(`<h2 style="font-family:Georgia,serif;font-size:16px;color:#c4a24e;margin:0 0 4px;">⛳ Lineups Lock Soon</h2><p style="font-size:13px;color:rgba(255,255,255,0.75);margin:0 0 8px;">${tournamentName}</p><p style="font-size:12px;color:rgba(255,255,255,0.5);margin:0 0 20px;">Lineups lock <strong style="color:#ffffff;">Thursday at ${lockTime} ET</strong>. Make sure your lineup is set!</p><a href="https://sfglgolf.com" style="display:inline-block;padding:10px 24px;background:rgba(196,162,78,0.15);border:1px solid rgba(196,162,78,0.5);border-radius:4px;color:#c4a24e;text-decoration:none;font-weight:600;font-size:13px;">Set Lineup →</a>`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getETNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

async function loadSettings() {
  const snap = await db.collection('league_settings').get();
  const s = {};
  snap.docs.forEach(d => { s[d.id] = d.data().value ?? d.data(); });
  return s;
}

async function loadTeams() {
  const snap = await db.collection('teams').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

function getEmailMap(settings, teams) {
  const emailMap = settings.managerEmails || {};
  const result = {};
  teams.forEach(t => {
    const email = emailMap[t.id] || emailMap[t.name];
    if (email) result[t.name] = email;
  });
  return result;
}

// ── Action: process waivers ─────────────────────────────────────────────────

async function handleWaivers(res) {
  const settings = await loadSettings();

  // Check if past cutoff
  const et = getETNow();
  const day = et.getDay();
  const timeVal = et.getHours() * 60 + et.getMinutes();
  const wDay = settings?.waiverDay ?? 2;
  const wHour = settings?.waiverHour ?? 20;
  const wMin = settings?.waiverMinute ?? 0;
  if (!(day === wDay && timeVal >= (wHour * 60 + wMin))) {
    return res.json({ status: 'not_yet', message: 'Not past waiver cutoff time' });
  }

  // Already run today?
  const metaSnap = await db.collection('sfgl_data').doc('last_auto_waiver').get();
  const today = getETNow().toLocaleDateString('en-US');
  if (metaSnap.exists && metaSnap.data().value === today) {
    return res.json({ status: 'already_run', message: 'Waivers already processed today' });
  }

  // Load transactions
  const txSnap = await db.collection('transactions').get();
  const allTx = txSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const pending = allTx.filter(tx => tx.status === 'pending' && tx.type === 'waiver');

  if (pending.length === 0) {
    await db.collection('sfgl_data').doc('last_auto_waiver').set({ key: 'last_auto_waiver', value: today });
    return res.json({ status: 'no_pending', message: 'No pending waiver claims' });
  }

  // Load teams
  let teams = await loadTeams();
  const em = {}; teams.forEach(t => { em[t.name] = t.earnings || 0; });
  const pm = {}; [...teams].sort((a, b) => (a.earnings || 0) - (b.earnings || 0)).forEach((t, i) => { pm[t.name] = i; });
  let nextLastPlace = teams.length;

  const byTeam = {};
  pending.forEach(w => { if (!byTeam[w.team]) byTeam[w.team] = []; byTeam[w.team].push(w); });
  Object.values(byTeam).forEach(c => c.sort((a, b) => (a.priority || 999) - (b.priority || 999)));

  const allRostered = new Set();
  teams.forEach(t => (t.roster || []).forEach(p => allRostered.add(p.name)));

  const dropped = new Set(), done = new Set(), failed = new Set(), applied = [];
  const processedResults = [];
  let more = true;

  while (more) {
    more = false;
    const round = [];
    Object.entries(byTeam).forEach(([tn, claims]) => {
      const top = claims.find(c => !done.has(c.id) && !failed.has(c.id));
      if (top) round.push({ tn, claim: top, o: pm[tn] ?? 999 });
    });
    if (!round.length) break;

    const byPlayer = {};
    round.forEach(rc => { if (!byPlayer[rc.claim.player]) byPlayer[rc.claim.player] = []; byPlayer[rc.claim.player].push(rc); });

    Object.entries(byPlayer).forEach(([player, cs]) => {
      cs.sort((a, b) => a.o - b.o);
      const w = cs[0];

      if (allRostered.has(player)) {
        cs.forEach(c => { failed.add(c.claim.id); processedResults.push({ ...c.claim, status: 'failed', failReason: 'Player already rostered' }); });
        more = true; return;
      }
      if (w.claim.droppedPlayer && (dropped.has(w.claim.droppedPlayer) || !allRostered.has(w.claim.droppedPlayer))) {
        failed.add(w.claim.id); processedResults.push({ ...w.claim, status: 'failed', failReason: w.claim.droppedPlayer + ' already dropped' });
        more = true; return;
      }

      if (w.claim.droppedPlayer) { allRostered.delete(w.claim.droppedPlayer); dropped.add(w.claim.droppedPlayer); }
      allRostered.add(player); done.add(w.claim.id);
      applied.push(w.claim); processedResults.push({ ...w.claim, status: 'processed' });
      pm[w.tn] = nextLastPlace++;

      const winEarn = '$' + (em[w.tn] || 0).toLocaleString();
      cs.slice(1).forEach(l => {
        const loseEarn = '$' + (em[l.tn] || 0).toLocaleString();
        failed.add(l.claim.id);
        processedResults.push({ ...l.claim, status: 'failed', failReason: `Lost tiebreaker to ${w.tn} (${winEarn} vs ${loseEarn})` });
      });
      more = true;
    });
  }

  // Write to Firebase
  const batch = db.batch();
  const processedDate = new Date().toLocaleDateString();

  processedResults.forEach(r => {
    if (r.id) {
      const ref = db.collection('transactions').doc(r.id);
      const update = { status: r.status, processedDate };
      if (r.failReason) update.failReason = r.failReason;
      batch.update(ref, update);
    }
  });

  for (const w of applied) {
    const team = teams.find(t => t.name === w.team);
    if (!team) continue;
    let roster = [...(team.roster || [])];
    if (w.droppedPlayer) roster = roster.filter(p => p.name !== w.droppedPlayer);
    if (!roster.some(p => p.name === w.player)) {
      roster.push({ name: w.player, limited: false, stars: 0, unlimited: false, yearsOfService: 1, starts: 0, eventsPlayed: 0, cutsMade: 0, pgaTourEarnings: 0, sfglEarnings: 0, headshot: '' });
    }
    batch.update(db.collection('teams').doc(team.id), { roster, transactionFees: (team.transactionFees || 0) + (w.fee || 0) });
  }

  batch.set(db.collection('sfgl_data').doc('last_auto_waiver'), { key: 'last_auto_waiver', value: today });
  await batch.commit();

  // Send emails
  const managerEmails = getEmailMap(settings, teams);
  const emailResults = [];
  for (const [teamName, email] of Object.entries(managerEmails)) {
    try {
      const html = buildWaiverResultsEmail(processedResults, teamName);
      await sendEmail(email, '⏰ SFGL Waiver Results', html);
      emailResults.push({ team: teamName, success: true });
    } catch (err) { emailResults.push({ team: teamName, error: err.message }); }
  }

  return res.json({
    status: 'processed', processed: applied.length,
    failed: processedResults.filter(r => r.status === 'failed').length,
    emailsSent: emailResults.filter(r => r.success).length,
    details: processedResults.map(r => ({ team: r.team, player: r.player, status: r.status, failReason: r.failReason })),
  });
}

// ── Action: lineup reminder ─────────────────────────────────────────────────

async function handleLineupReminder(res) {
  const et = getETNow();
  if (et.getDay() !== 4) return res.json({ status: 'not_thursday' });

  const today = et.toLocaleDateString('en-US');
  const metaSnap = await db.collection('sfgl_data').doc('last_lineup_reminder').get();
  if (metaSnap.exists && metaSnap.data().value === today) return res.json({ status: 'already_sent' });

  const settings = await loadSettings();
  const sfglSnap = await db.collection('sfgl_data').doc('fantasy-golf-tournaments').get();
  const tournaments = sfglSnap.exists ? sfglSnap.data().value : [];
  const activeTourney = tournaments?.find(t => t.playing && !t.completed);
  if (!activeTourney) return res.json({ status: 'no_tournament' });

  const lockHour = activeTourney.lockHourET || 7;
  const lockTime = lockHour > 12 ? `${lockHour - 12}pm` : lockHour === 12 ? '12pm' : `${lockHour}am`;

  const teams = await loadTeams();
  const managerEmails = getEmailMap(settings, teams);
  const results = [];

  for (const team of teams) {
    const email = managerEmails[team.name];
    if (!email) continue;
    if (team.lineup && team.lineup.length > 0) { results.push({ team: team.name, skipped: true }); continue; }
    try {
      await sendEmail(email, `⛳ Lineups lock today — ${activeTourney.name}`, buildLineupReminderEmail(activeTourney.name, lockTime, team.name));
      results.push({ team: team.name, success: true });
    } catch (err) { results.push({ team: team.name, error: err.message }); }
  }

  await db.collection('sfgl_data').doc('last_lineup_reminder').set({ key: 'last_lineup_reminder', value: today });
  return res.json({ status: 'sent', tournament: activeTourney.name, results });
}

// ── Action: notify results ──────────────────────────────────────────────────

async function handleNotifyResults(req, res) {
  const { tournamentName, teamResults } = req.body || {};
  if (!tournamentName || !teamResults?.length) return res.status(400).json({ error: 'Missing tournamentName or teamResults' });

  const settings = await loadSettings();
  const teams = await loadTeams();
  const managerEmails = getEmailMap(settings, teams);
  const results = [];

  for (const [teamName, email] of Object.entries(managerEmails)) {
    try {
      await sendEmail(email, `🏆 ${tournamentName} — SFGL Results`, buildTournamentResultsEmail(tournamentName, teamResults, teamName));
      results.push({ team: teamName, success: true });
    } catch (err) { results.push({ team: teamName, error: err.message }); }
  }

  return res.json({ status: 'sent', emailsSent: results.filter(r => r.success).length, results });
}

// ── Router ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // Auth check
  const cronSecret = process.env.CRON_SECRET;
  const action = req.query.action || '';

  // Cron actions require auth; notify-results is called from the client (no auth needed)
  if (action !== 'notify-results' && cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    switch (action) {
      case 'waivers':          return await handleWaivers(res);
      case 'lineup-reminder':  return await handleLineupReminder(res);
      case 'notify-results':   return await handleNotifyResults(req, res);
      default:                 return res.status(400).json({ error: 'Unknown action. Use ?action=waivers|lineup-reminder|notify-results' });
    }
  } catch (err) {
    console.error(`[cron] ${action} error:`, err);
    return res.status(500).json({ error: err.message });
  }
}
