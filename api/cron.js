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

// All email styling uses Raleway with Arial fallback. Most email clients load
// the Google Font link below (Gmail web, Apple Mail, Outlook web); the rest
// fall back to Arial which has nearly identical metrics for our purposes.
// Palette: navy backgrounds + white text, with gold reserved for the SFGL
// logo and final-podium accents only. Matches the in-app theme.
const FONT_STACK = `'Raleway','Helvetica Neue',Arial,sans-serif`;
const FONT_LINK  = `<link href="https://fonts.googleapis.com/css2?family=Raleway:wght@300;400;600;700&display=swap" rel="stylesheet">`;

const HEADER = `<div style="background:#0a1628;padding:22px 24px 18px;border-bottom:1px solid rgba(245,197,24,0.35);"><h1 style="font-family:${FONT_STACK};font-size:24px;font-weight:600;color:#ffffff;margin:0;letter-spacing:6px;">SFGL</h1><p style="font-family:${FONT_STACK};font-size:10px;color:rgba(255,255,255,0.45);margin:4px 0 0;letter-spacing:3px;text-transform:uppercase;font-weight:400;">2026 Season</p></div>`;
const FOOTER = `<div style="padding:16px 24px;border-top:1px solid rgba(255,255,255,0.08);text-align:center;"><a href="https://sfglgolf.com" style="font-family:${FONT_STACK};font-size:12px;color:rgba(255,255,255,0.7);text-decoration:none;letter-spacing:1px;">sfglgolf.com</a><p style="font-family:${FONT_STACK};font-size:10px;color:rgba(255,255,255,0.3);margin:6px 0 0;font-weight:300;">You're receiving this because you're a manager in the SFGL fantasy golf league.</p></div>`;

function wrap(body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">${FONT_LINK}</head><body style="margin:0;padding:0;background:#060e1a;font-family:${FONT_STACK};"><div style="max-width:560px;margin:0 auto;background:#0f1e30;border-radius:4px;overflow:hidden;border:1px solid rgba(255,255,255,0.08);">${HEADER}<div style="padding:24px;">${body}</div>${FOOTER}</div></body></html>`;
}

function buildWaiverResultsEmail(processed, recipientTeam) {
  const rows = processed.map(w => {
    const isMe = w.team === recipientTeam;
    const ok = w.status === 'processed';
    const bg = ok ? (isMe ? 'rgba(80,180,120,0.18)' : 'rgba(80,180,120,0.08)') : 'rgba(200,60,60,0.10)';
    const accent = ok ? '#50b478' : '#cc5555';
    const icon = ok ? '✅' : '❌';
    const label = ok ? 'Approved' : 'Blocked';
    return `<div style="background:${bg};border:1px solid rgba(255,255,255,0.06);border-radius:3px;padding:10px 14px;margin-bottom:6px;${isMe ? 'border-left:3px solid #ffffff;' : ''}font-family:${FONT_STACK};"><div style="font-size:13px;font-weight:600;color:${isMe ? '#ffffff' : 'rgba(255,255,255,0.85)'};">${w.team}<span style="float:right;font-size:11px;font-weight:600;color:${accent};">${icon} ${label}</span></div><div style="font-size:12px;margin-top:4px;font-weight:400;"><span style="color:#50b478;">+ ${w.player}</span>${w.droppedPlayer ? `<span style="color:rgba(255,255,255,0.35);"> → </span><span style="color:#cc5555;">- ${w.droppedPlayer}</span>` : ''}</div>${w.failReason ? `<div style="font-size:10px;color:rgba(255,255,255,0.45);margin-top:4px;font-weight:300;">${w.failReason}</div>` : ''}</div>`;
  }).join('');
  return wrap(`<h2 style="font-family:${FONT_STACK};font-size:18px;font-weight:600;color:#ffffff;margin:0 0 4px;letter-spacing:0.5px;">⏰ Waiver Results</h2><p style="font-family:${FONT_STACK};font-size:10px;color:rgba(255,255,255,0.5);margin:0 0 18px;letter-spacing:2.5px;text-transform:uppercase;font-weight:400;">Processed ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</p>${rows}`);
}

function buildTournamentResultsEmail(tournamentName, teamResults, recipientTeam) {
  // Defensive: handleNotifyResults takes teamResults from the client body, so
  // bad payloads can land here. Always render *something* informative.
  const list = Array.isArray(teamResults) ? teamResults : [];
  const sorted = [...list].sort((a, b) => (b.totalEarnings || 0) - (a.totalEarnings || 0));

  // ── Team standings rows ──
  // Each row shows rank · team · earnings, with the recipient's row highlighted
  // by a white left border. If player breakdowns are supplied (they're
  // included automatically by handleProcessResults), they render in a sub-list
  // under the team row.
  const rows = sorted.length ? sorted.map((tr, i) => {
    const isMe        = tr.team === recipientTeam;
    const isFirst     = i === 0;
    const rankColor   = isFirst ? '#f5c518' : 'rgba(255,255,255,0.4)';
    const teamColor   = isMe    ? '#ffffff' : 'rgba(255,255,255,0.85)';
    const bg          = isMe    ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.02)';
    const leftBorder  = isMe    ? 'border-left:3px solid #ffffff;' : isFirst ? 'border-left:3px solid rgba(245,197,24,0.55);' : '';

    // Player breakdown (optional). Earnings highlighted green if >0, muted
    // otherwise so it's clear at a glance who contributed.
    const players = Array.isArray(tr.players) ? tr.players : [];
    const playerRows = players.map(p => {
      const earned = (p.earnings || 0) > 0;
      const star = p.limited ? '★ ' : '';
      return `<tr><td style="font-family:${FONT_STACK};font-size:11px;color:rgba(255,255,255,0.6);padding:2px 0;font-weight:400;">${star}${p.name || ''}</td><td style="font-family:${FONT_STACK};font-size:11px;color:${earned ? '#50b478' : 'rgba(255,255,255,0.35)'};padding:2px 0;text-align:right;font-weight:500;">$${(p.earnings || 0).toLocaleString()}</td></tr>`;
    }).join('');

    return `<div style="padding:12px 14px;background:${bg};border-radius:3px;margin-bottom:6px;${leftBorder}"><table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr><td width="22" style="font-family:${FONT_STACK};font-size:14px;font-weight:700;color:${rankColor};vertical-align:middle;">${i + 1}</td><td style="font-family:${FONT_STACK};font-size:14px;font-weight:${isMe ? '700' : '600'};color:${teamColor};vertical-align:middle;">${tr.team}</td><td style="font-family:${FONT_STACK};font-size:14px;font-weight:600;color:#50b478;text-align:right;vertical-align:middle;">$${(tr.totalEarnings || 0).toLocaleString()}</td></tr></table>${playerRows ? `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.08);">${playerRows}</table>` : ''}</div>`;
  }).join('') : `<div style="font-family:${FONT_STACK};font-size:13px;color:rgba(255,255,255,0.5);padding:24px;text-align:center;background:rgba(255,255,255,0.03);border-radius:3px;font-weight:400;">Team results unavailable for this email. Check the app for the latest standings.</div>`;

  return wrap(`<h2 style="font-family:${FONT_STACK};font-size:20px;font-weight:600;color:#ffffff;margin:0 0 4px;letter-spacing:0.5px;">🏆 ${tournamentName}</h2><p style="font-family:${FONT_STACK};font-size:10px;color:rgba(255,255,255,0.5);margin:0 0 18px;letter-spacing:2.5px;text-transform:uppercase;font-weight:400;">Tournament Results</p>${rows}`);
}

function buildLineupReminderEmail(tournamentName, lockTime, recipientTeam) {
  return wrap(`<h2 style="font-family:${FONT_STACK};font-size:18px;font-weight:600;color:#ffffff;margin:0 0 4px;letter-spacing:0.5px;">⛳ Lineups Lock Tomorrow</h2><p style="font-family:${FONT_STACK};font-size:13px;color:rgba(255,255,255,0.85);margin:0 0 8px;font-weight:500;">${tournamentName}</p><p style="font-family:${FONT_STACK};font-size:12px;color:rgba(255,255,255,0.55);margin:0 0 20px;font-weight:400;">Lineups lock <strong style="color:#ffffff;font-weight:600;">Thursday at ${lockTime} ET</strong>. Make sure your lineup is set!</p><a href="https://sfglgolf.com" style="display:inline-block;padding:10px 24px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.3);border-radius:4px;color:#ffffff;text-decoration:none;font-weight:600;font-size:13px;font-family:${FONT_STACK};letter-spacing:0.5px;">Set Lineup →</a>`);
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
      roster.push({ name: w.player, limited: false, stars: 0, unlimited: false, yearsOfService: 1, starts: 0, eventsPlayed: 0, cutsMade: 0, pgaTourEarnings: 0, sfglEarnings: 0 });
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
  if (et.getDay() !== 3) return res.json({ status: 'not_wednesday' });

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

// ── Action: auto-process tournament results ─────────────────────────────────

// Name normalization for fuzzy matching (strip accents, lowercase)
function normalizeName(name) {
  return (name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function matchName(a, b) {
  const na = normalizeName(a), nb = normalizeName(b);
  if (na === nb) return true;
  const wa = na.split(' '), wb = nb.split(' ');
  if (wa.length === wb.length) return wa.every(w => wb.includes(w));
  return false;
}

async function handleProcessResults(res) {
  const settings = await loadSettings();
  const et = getETNow();

  // Time gate — mirrors the waiver-schedule pattern. Settings are configured
  // from the AdminView; defaults to Monday 9:00 AM ET so PGA tournaments that
  // finish Sunday have a buffer for late-Sunday Monday-finishes.
  const rDay  = settings?.resultsDay    ?? 1; // 0=Sun…6=Sat, default Mon=1
  const rHour = settings?.resultsHour   ?? 9; // 24h ET
  const rMin  = settings?.resultsMinute ?? 0;
  const day = et.getDay();
  const timeVal = et.getHours() * 60 + et.getMinutes();
  if (!(day === rDay && timeVal >= (rHour * 60 + rMin))) {
    return res.json({ status: 'not_yet', message: 'Not past results processing time' });
  }

  const today = et.toLocaleDateString('en-US');
  const metaSnap = await db.collection('sfgl_data').doc('last_auto_results').get();
  if (metaSnap.exists && metaSnap.data().value === today) {
    return res.json({ status: 'already_run', message: 'Results already processed today' });
  }

  // Load remaining data (settings already loaded above)
  const teams = await loadTeams();
  const tournamentsSnap = await db.collection('sfgl_data').doc('fantasy-golf-tournaments').get();
  const tournaments = tournamentsSnap.exists ? tournamentsSnap.data().value : [];
  const statsSnap = await db.collection('sfgl_data').doc('fantasy-golf-global-stats').get();
  const globalStats = statsSnap.exists ? statsSnap.data().value : {};

  // Find active tournament
  const ti = tournaments.findIndex(t => t.playing && !t.completed);
  if (ti === -1) {
    await db.collection('sfgl_data').doc('last_auto_results').set({ key: 'last_auto_results', value: today });
    return res.json({ status: 'no_active_tournament' });
  }
  const tournament = tournaments[ti];

  // Fetch results from ESPN via the existing pga-results API
  // Since we're server-side, call our own API endpoint
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'https://sfglgolf.com';
  const params = new URLSearchParams({ name: tournament.name, year: '2026' });

  let pgaData;
  try {
    const pgaResp = await fetch(`${baseUrl}/api/pga-results?${params.toString()}`);
    pgaData = await pgaResp.json();
    if (!pgaResp.ok || !pgaData.players?.length) {
      return res.json({ status: 'no_results', message: pgaData.error || 'No results available yet for ' + tournament.name });
    }
  } catch (err) {
    return res.json({ status: 'fetch_error', message: 'Failed to fetch results: ' + err.message });
  }

  const { players, roundLeaders: rl } = pgaData;

  // Build earnings map
  const earningsMap = {};
  players.forEach(p => { if (p.name && p.earnings >= 0) earningsMap[p.name] = p.earnings; });

  // Filter round leaders to only those in SFGL lineups
  const startedPlayers = new Set(teams.flatMap(t => t.lineup || []));
  const filterToStarted = (names) => {
    if (!names?.length) return [];
    return names.filter(n => startedPlayers.has(n));
  };
  const roundLeaders = {
    round1: filterToStarted(rl?.round1) || [],
    round2: filterToStarted(rl?.round2) || [],
    round3: filterToStarted(rl?.round3) || [],
  };

  // Build bonus amounts from settings
  const BONUSES_REG = { round1: 20000, round2: 40000, round3: 60000 };
  const BONUSES_MAJ = { round1: 40000, round2: 80000, round3: 120000 };
  const bonuses = tournament.isMajor
    ? { round1: settings.bonusR1Major ?? BONUSES_MAJ.round1, round2: settings.bonusR2Major ?? BONUSES_MAJ.round2, round3: settings.bonusR3Major ?? BONUSES_MAJ.round3 }
    : { round1: settings.bonusR1Regular ?? BONUSES_REG.round1, round2: settings.bonusR2Regular ?? BONUSES_REG.round2, round3: settings.bonusR3Regular ?? BONUSES_REG.round3 };

  // Process each team — mirrors processTournamentData exactly
  const resultsData = { teams: {}, earningsMap: { ...earningsMap }, roundLeaders, fullLineups: {} };
  const newStats = { ...globalStats };

  // Update global player stats
  Object.entries(earningsMap).forEach(([name, earnings]) => {
    if (!newStats[name]) newStats[name] = { eventsPlayed: 0, cutsMade: 0, pgaTourEarnings: 0 };
    newStats[name] = {
      ...newStats[name],
      eventsPlayed: newStats[name].eventsPlayed + 1,
      cutsMade: newStats[name].cutsMade + (earnings > 0 ? 1 : 0),
      pgaTourEarnings: newStats[name].pgaTourEarnings + earnings,
    };
  });

  const updatedTeams = teams.map(team => {
    if (!team.lineup || team.lineup.length === 0) return team;

    resultsData.fullLineups[team.id] = [...team.lineup];

    const starterResults = team.lineup.map(playerName => {
      let earnings = earningsMap[playerName];
      if (earnings === undefined) {
        const mk = Object.keys(earningsMap).find(k => matchName(k, playerName));
        earnings = mk !== undefined ? earningsMap[mk] : 0;
      }
      return { playerName, earnings: earnings || 0 };
    });

    const topStarters = [...starterResults].sort((a, b) => b.earnings - a.earnings).slice(0, 5);
    let totalEarnings = topStarters.reduce((s, p) => s + p.earnings, 0);
    const bonusEarnings = { round1: 0, round2: 0, round3: 0 };
    const playersWithBonuses = {};

    ['round1', 'round2', 'round3'].forEach(round => {
      const leaders = Array.isArray(roundLeaders[round]) ? roundLeaders[round] : (roundLeaders[round] ? [roundLeaders[round]] : []);
      leaders.forEach(leaderName => {
        if (!leaderName) return;
        const actual = team.lineup.find(pn => normalizeName(pn) === normalizeName(leaderName));
        if (actual) {
          bonusEarnings[round] = bonuses[round];
          totalEarnings += bonuses[round];
          if (!playersWithBonuses[actual]) playersWithBonuses[actual] = { total: 0, rounds: [] };
          playersWithBonuses[actual].total += bonuses[round];
          playersWithBonuses[actual].rounds.push({ round: round.replace('round', ''), bonus: bonuses[round] });
        }
      });
    });

    resultsData.teams[team.id] = {
      totalEarnings,
      bonuses: bonusEarnings,
      players: topStarters.map(s => ({
        name: s.playerName,
        earnings: s.earnings,
        limited: team.roster.find(p => p.name === s.playerName)?.limited || false,
        bonus: playersWithBonuses[s.playerName]?.total || 0,
        roundsLed: playersWithBonuses[s.playerName]?.rounds || [],
        wasRoundLeader: (playersWithBonuses[s.playerName]?.total || 0) > 0,
      })),
    };

    const updatedRoster = team.roster.map(player => {
      if (!team.lineup.includes(player.name)) return player;
      let pe = earningsMap[player.name];
      if (pe === undefined) { const mk = Object.keys(earningsMap).find(k => matchName(k, player.name)); if (mk) pe = earningsMap[mk]; }
      return { ...player, starts: (player.starts || 0) + 1, sfglEarnings: (player.sfglEarnings || 0) + (pe || 0) };
    });

    return {
      ...team,
      roster: updatedRoster,
      earnings: (team.earnings || 0) + totalEarnings,
      segmentEarnings: (team.segmentEarnings || 0) + totalEarnings,
      lineup: [],
    };
  });

  // Mark tournament completed, advance to next
  const newTournaments = tournaments.map((nt, i) => i === ti ? { ...nt, completed: true, playing: false, results: resultsData } : nt);
  const nx = newTournaments.findIndex((nt, i) => i > ti && !nt.completed && !nt.isAlternate);
  if (nx !== -1) { newTournaments.forEach(nt => { nt.playing = false; }); newTournaments[nx].playing = true; }

  // Write everything to Firebase
  const batch = db.batch();

  // Update teams
  for (const team of updatedTeams) {
    batch.update(db.collection('teams').doc(team.id), {
      roster: team.roster,
      earnings: team.earnings,
      segmentEarnings: team.segmentEarnings,
      lineup: team.lineup,
    });
  }

  // Update tournaments and stats in sfgl_data
  batch.set(db.collection('sfgl_data').doc('fantasy-golf-tournaments'), { key: 'fantasy-golf-tournaments', value: newTournaments });
  batch.set(db.collection('sfgl_data').doc('fantasy-golf-global-stats'), { key: 'fantasy-golf-global-stats', value: newStats });
  batch.set(db.collection('sfgl_data').doc('last_auto_results'), { key: 'last_auto_results', value: today });

  await batch.commit();

  // Email results to all managers
  const managerEmails = getEmailMap(settings, teams);
  // Include player data so the email template can render the per-team
  // player breakdown (name + earnings). Star-marked (limited) players are
  // also flagged for the template.
  const teamResultsForEmail = updatedTeams
    .filter(t => resultsData.teams[t.id])
    .map(t => ({
      team: t.name,
      totalEarnings: resultsData.teams[t.id].totalEarnings || 0,
      players: (resultsData.teams[t.id].players || []).map(p => ({
        name: p.name,
        earnings: p.earnings || 0,
        limited: !!p.limited,
      })),
    }));

  const emailResults = [];
  for (const [teamName, email] of Object.entries(managerEmails)) {
    try {
      await sendEmail(email, `🏆 ${tournament.name} — SFGL Results`, buildTournamentResultsEmail(tournament.name, teamResultsForEmail, teamName));
      emailResults.push({ team: teamName, success: true });
    } catch (err) { emailResults.push({ team: teamName, error: err.message }); }
  }

  return res.json({
    status: 'processed',
    tournament: tournament.name,
    teamsScored: Object.keys(resultsData.teams).length,
    playersLoaded: players.length,
    emailsSent: emailResults.filter(r => r.success).length,
  });
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
      case 'waivers':           return await handleWaivers(res);
      case 'lineup-reminder':   return await handleLineupReminder(res);
      case 'process-results':   return await handleProcessResults(res);
      case 'notify-results':    return await handleNotifyResults(req, res);
      default:                  return res.status(400).json({ error: 'Unknown action. Use ?action=waivers|lineup-reminder|process-results|notify-results' });
    }
  } catch (err) {
    console.error(`[cron] ${action} error:`, err);
    return res.status(500).json({ error: err.message });
  }
}
