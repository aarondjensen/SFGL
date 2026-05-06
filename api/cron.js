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

// Wave 8: refined to match the app's exact palette and typography.
// pageBg #111d2e, brighter gold #f5c518, app's earnings green, Raleway font
// loaded via Google Fonts with system-font fallbacks for clients that strip
// web fonts (Outlook desktop, etc.). Layouts use display:table instead of
// flex for Outlook compatibility.
const FONT_STACK = `'Raleway','Segoe UI',-apple-system,BlinkMacSystemFont,system-ui,sans-serif`;
const HEADER = `<div style="background:#111d2e;padding:28px 32px 22px;border-bottom:1px solid rgba(180,160,100,0.25);"><div style="font-family:${FONT_STACK};font-size:30px;font-weight:300;color:rgba(255,255,255,0.95);letter-spacing:7px;line-height:1;">SFGL</div><div style="font-family:${FONT_STACK};font-size:11px;font-weight:600;color:rgba(255,255,255,0.4);letter-spacing:2.5px;text-transform:uppercase;margin-top:8px;">2026 Season</div></div>`;
const FOOTER = `<div style="padding:20px 32px;border-top:1px solid rgba(255,255,255,0.06);text-align:center;background:#0d1828;"><a href="https://sfglgolf.com" style="font-family:${FONT_STACK};font-size:13px;font-weight:500;color:#f5c518;text-decoration:none;letter-spacing:1.5px;">sfglgolf.com →</a><div style="font-family:${FONT_STACK};font-size:10px;color:rgba(255,255,255,0.3);margin-top:8px;letter-spacing:0.3px;">You're receiving this because you're a manager in the SFGL fantasy golf league.</div></div>`;

function wrap(body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Raleway:wght@300;400;500;600;700&display=swap" rel="stylesheet"><title>SFGL</title></head><body style="margin:0;padding:0;background:#0a1322;font-family:${FONT_STACK};"><div style="max-width:600px;margin:0 auto;background:#111d2e;border:1px solid rgba(180,160,100,0.12);">${HEADER}<div style="padding:28px 32px 24px;">${body}</div>${FOOTER}</div></body></html>`;
}

function buildWaiverResultsEmail(processed, recipientTeam) {
  // Wave 8: rebuilt to match the tournament results email visually. Splits
  // claims into two sections (Successful and Blocked) with section headers.
  // Each claim renders as a card with a header band (team + status) and a
  // body row (player swap + reason if blocked). The recipient's claims get
  // a gold left-border highlight, same as the results email.
  const successful = processed.filter(w => w.status === 'processed');
  const blocked    = processed.filter(w => w.status !== 'processed');

  const renderCard = (w) => {
    const isMe = w.team === recipientTeam;
    const isSuccess = w.status === 'processed';

    const cardBg = isMe ? 'rgba(245,197,24,0.07)' : 'rgba(255,255,255,0.025)';
    const cardBorder = isMe ? '1px solid rgba(245,197,24,0.4)' : '1px solid rgba(255,255,255,0.06)';
    // Header band tint: gold for recipient, otherwise green/red light tint
    // matching the success/block status of the claim.
    const headerBandBg = isMe
      ? 'rgba(245,197,24,0.14)'
      : (isSuccess ? 'rgba(80,180,120,0.08)' : 'rgba(220,80,80,0.08)');
    const teamNameWeight = isMe ? '700' : '600';
    const teamNameColor = isMe ? '#ffffff' : 'rgba(255,255,255,0.92)';

    const statusColor = isSuccess ? '#50c378' : '#dc5555';
    const statusIcon  = isSuccess ? '✓' : '✕';
    const statusLabel = isSuccess ? 'SUCCESSFUL' : 'BLOCKED';
    const statusPill = `<span style="display:inline-block;font-family:${FONT_STACK};font-size:10px;font-weight:700;color:${statusColor};background:${isSuccess ? 'rgba(80,180,120,0.12)' : 'rgba(220,80,80,0.12)'};padding:3px 9px;border-radius:3px;letter-spacing:0.8px;">${statusIcon} ${statusLabel}</span>`;

    // Body: player swap. Player added in green, dropped in muted red.
    const playerInColor  = isSuccess ? '#50c378' : 'rgba(255,255,255,0.55)';
    const playerOutColor = 'rgba(220,80,80,0.7)';
    const swapRow = `<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td style="padding:11px 18px;font-family:${FONT_STACK};font-size:14px;">
        <span style="color:${playerInColor};font-weight:500;">+ ${w.player}</span>${w.droppedPlayer ? `<span style="color:rgba(255,255,255,0.25);margin:0 8px;">→</span><span style="color:${playerOutColor};font-weight:500;">− ${w.droppedPlayer}</span>` : ''}
      </td>
    </tr></table>`;

    // Reason row (only for blocked claims)
    const reasonRow = (!isSuccess && w.failReason)
      ? `<div style="padding:0 18px 11px;font-family:${FONT_STACK};font-size:12px;color:rgba(255,255,255,0.45);font-style:italic;border-top:1px solid rgba(255,255,255,0.04);padding-top:9px;">${w.failReason}</div>`
      : '';

    return `<div style="margin-bottom:10px;background:${cardBg};border:${cardBorder};${isMe ? 'border-left:4px solid #f5c518;' : ''}border-radius:4px;overflow:hidden;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${headerBandBg};border-bottom:1px solid rgba(255,255,255,0.08);">
        <tr>
          <td style="padding:11px 18px;font-family:${FONT_STACK};font-size:15px;font-weight:${teamNameWeight};color:${teamNameColor};letter-spacing:0.2px;">${w.team}</td>
          <td style="padding:11px 18px;text-align:right;white-space:nowrap;">${statusPill}</td>
        </tr>
      </table>
      ${swapRow}
      ${reasonRow}
    </div>`;
  };

  const renderSection = (title, count, claims, accentColor) => {
    if (claims.length === 0) return '';
    return `<div style="margin-bottom:8px;margin-top:18px;font-family:${FONT_STACK};font-size:11px;font-weight:700;color:${accentColor};letter-spacing:2px;text-transform:uppercase;">${title} <span style="color:rgba(255,255,255,0.35);font-weight:500;margin-left:4px;">(${count})</span></div>${claims.map(renderCard).join('')}`;
  };

  const successfulSection = renderSection('Successful Claims', successful.length, successful, '#50c378');
  const blockedSection    = renderSection('Blocked Claims',    blocked.length,    blocked,    '#dc5555');

  // If somehow nothing to show, still render gracefully.
  const body = (successful.length === 0 && blocked.length === 0)
    ? `<div style="font-family:${FONT_STACK};font-size:13px;color:rgba(255,255,255,0.45);font-style:italic;padding:14px 0;">No claims were processed.</div>`
    : `${successfulSection}${blockedSection}`;

  const dateLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

  return wrap(`<div style="font-family:${FONT_STACK};font-size:24px;font-weight:500;color:#f5c518;margin:0 0 4px;letter-spacing:0.3px;">⏰ Waiver Results</div><div style="font-family:${FONT_STACK};font-size:11px;font-weight:600;color:rgba(255,255,255,0.45);letter-spacing:2.5px;text-transform:uppercase;margin:0 0 22px;">Processed ${dateLabel}</div>${body}`);
}

function buildTournamentResultsEmail(tournamentName, teamResults, recipientTeam) {
  // Wave 8: rebuilt to show all teams (including those with no lineup) and
  // each team's full lineup with per-player earnings. Sorts by total earnings
  // desc; teams without a lineup sort to the bottom and show a "no lineup"
  // notice instead of player rows.
  const sorted = [...teamResults].sort((a, b) => {
    if (a.submitted && !b.submitted) return -1;
    if (!a.submitted && b.submitted) return 1;
    return (b.totalEarnings || 0) - (a.totalEarnings || 0);
  });

  // Medal styling for top-3 ranks (matches app's getMedalStyle)
  const medalStyle = (rank) => {
    if (rank === 1) return { bg: 'rgba(245,197,24,0.95)',  text: '#111d2e' };
    if (rank === 2) return { bg: 'rgba(180,180,190,0.75)', text: '#111d2e' };
    if (rank === 3) return { bg: 'rgba(160,110,60,0.8)',   text: '#ffffff' };
    return { bg: 'rgba(255,255,255,0.06)', text: 'rgba(255,255,255,0.4)' };
  };

  const teamBlocks = sorted.map((tr, i) => {
    const isMe = tr.team === recipientTeam;
    const rank = i + 1;
    const totalLabel = (tr.totalEarnings || 0).toLocaleString();
    const totalColor = (tr.totalEarnings || 0) > 0 ? '#50c378' : 'rgba(255,255,255,0.3)';

    const cardBg = isMe ? 'rgba(245,197,24,0.07)' : 'rgba(255,255,255,0.025)';
    const cardBorder = isMe ? '1px solid rgba(245,197,24,0.4)' : '1px solid rgba(255,255,255,0.06)';
    // Wave 8: header band has its own slightly elevated bg so the row stands
    // out from the player rows below. For the recipient, use a stronger gold
    // tint; for others, a subtle white tint.
    const headerBandBg = isMe ? 'rgba(245,197,24,0.14)' : 'rgba(255,255,255,0.05)';
    const teamNameWeight = isMe ? '700' : '600';
    const teamNameColor = isMe ? '#ffffff' : 'rgba(255,255,255,0.92)';

    const medal = medalStyle(rank);
    const medalCircle = `<span style="display:inline-block;width:24px;height:24px;line-height:24px;border-radius:12px;background:${medal.bg};color:${medal.text};font-family:${FONT_STACK};font-size:12px;font-weight:700;text-align:center;margin-right:12px;vertical-align:middle;">${rank}</span>`;

    let lineupBody = '';
    if (!tr.submitted) {
      lineupBody = `<div style="padding:14px 18px;font-family:${FONT_STACK};font-size:13px;color:rgba(255,255,255,0.4);font-style:italic;">No lineup submitted</div>`;
    } else if (tr.players && tr.players.length > 0) {
      const playersSorted = [...tr.players].sort((a, b) => (b.earnings || 0) - (a.earnings || 0));
      const playerRows = playersSorted.map((p, idx) => {
        // Wave 8: limited players get their NAME in gold (matches the app's
        // limited-player styling). Earnings use the same color as the name —
        // white for normal, gold for limited.
        const isLimited = !!p.limited;
        const nameColor     = isLimited ? '#f5c518' : 'rgba(255,255,255,0.88)';
        const earningsColor = nameColor; // intentionally matches name
        const limitedStar = isLimited ? `<span style="margin-left:6px;font-size:11px;">⭐</span>` : '';
        // R-badge shows just the round label, no "LEADER" suffix
        const bonusBadge = p.wasRoundLeader && p.roundsLed && p.roundsLed.length > 0
          ? `<span style="display:inline-block;margin-left:8px;font-family:${FONT_STACK};font-size:10px;font-weight:700;color:#f5c518;background:rgba(245,197,24,0.12);padding:2px 7px;border-radius:3px;letter-spacing:0.8px;">${p.roundsLed.map(r => 'R' + r.round).join('·')}</span>`
          : '';
        // Bonus moves to a stacked row below the earnings instead of inline
        const bonusRow = (p.bonus && p.bonus > 0)
          ? `<div style="font-family:${FONT_STACK};font-size:11px;color:rgba(245,197,24,0.7);margin-top:2px;letter-spacing:0.2px;">+$${p.bonus.toLocaleString()}</div>`
          : '';
        const earningsLabel = (p.earnings || 0).toLocaleString();
        const rowBorder = idx === 0 ? '' : 'border-top:1px solid rgba(255,255,255,0.04);';
        return `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="${rowBorder}"><tr>
          <td style="padding:9px 18px;font-family:${FONT_STACK};font-size:14px;color:${nameColor};">${p.name || '—'}${limitedStar}${bonusBadge}</td>
          <td style="padding:9px 18px;text-align:right;white-space:nowrap;font-family:${FONT_STACK};vertical-align:top;">
            <div style="font-size:14px;font-weight:500;color:${earningsColor};">$${earningsLabel}</div>
            ${bonusRow}
          </td>
        </tr></table>`;
      }).join('');
      lineupBody = playerRows;
    } else {
      lineupBody = `<div style="padding:14px 18px;font-family:${FONT_STACK};font-size:13px;color:rgba(255,255,255,0.4);font-style:italic;">No starters scored</div>`;
    }

    return `<div style="margin-bottom:14px;background:${cardBg};border:${cardBorder};${isMe ? 'border-left:4px solid #f5c518;' : ''}border-radius:4px;overflow:hidden;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${headerBandBg};border-bottom:1px solid rgba(255,255,255,0.08);">
        <tr>
          <td style="padding:14px 18px;">
            ${medalCircle}<span style="font-family:${FONT_STACK};font-size:17px;font-weight:${teamNameWeight};color:${teamNameColor};letter-spacing:0.2px;vertical-align:middle;">${tr.team}</span>
          </td>
          <td style="padding:14px 18px;text-align:right;white-space:nowrap;font-family:${FONT_STACK};font-size:17px;font-weight:600;color:${totalColor};letter-spacing:-0.3px;">$${totalLabel}</td>
        </tr>
      </table>
      ${lineupBody}
    </div>`;
  }).join('');

  return wrap(`<div style="font-family:${FONT_STACK};font-size:24px;font-weight:500;color:#f5c518;margin:0 0 4px;letter-spacing:0.3px;">🏆 ${tournamentName}</div><div style="font-family:${FONT_STACK};font-size:11px;font-weight:600;color:rgba(255,255,255,0.45);letter-spacing:2.5px;text-transform:uppercase;margin:0 0 22px;">Tournament Results</div>${teamBlocks}`);
}

function buildLineupReminderEmail(tournamentName, lockTime, recipientTeam) {
  return wrap(`<div style="font-family:${FONT_STACK};font-size:22px;font-weight:500;color:#f5c518;margin:0 0 4px;letter-spacing:0.3px;">⛳ Lineups Lock Tomorrow</div><div style="font-family:${FONT_STACK};font-size:14px;color:rgba(255,255,255,0.78);margin:8px 0 12px;">${tournamentName}</div><div style="font-family:${FONT_STACK};font-size:13px;color:rgba(255,255,255,0.5);margin:0 0 24px;">Lineups lock <strong style="color:#ffffff;font-weight:600;">Thursday at ${lockTime} ET</strong>. Make sure your lineup is set.</div><a href="https://sfglgolf.com" style="display:inline-block;padding:11px 26px;background:rgba(245,197,24,0.12);border:1px solid rgba(245,197,24,0.5);border-radius:4px;color:#f5c518;text-decoration:none;font-family:${FONT_STACK};font-weight:600;font-size:13px;letter-spacing:0.5px;">Set Lineup →</a>`);
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

// Wave 8: read tournaments from the dedicated `tournaments` collection.
// Previously this was read from `sfgl_data/fantasy-golf-tournaments`, which
// was deleted in a prior cleanup. The result was that every cron handler
// silently saw zero tournaments and exited. This matches tournamentsApi.getAll
// in src/api/firebase.js — fetch all docs, sort client-side by parsed dates.
const _MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function _parseTournamentDate(datesStr) {
  if (!datesStr) return new Date(9999, 11, 31);
  const m = String(datesStr).match(/^([A-Za-z]+)\s+(\d+)/);
  if (!m) return new Date(9999, 11, 31);
  const monthKey = m[1].slice(0, 3);
  const month = _MONTHS[monthKey];
  const day = parseInt(m[2], 10);
  if (month === undefined || isNaN(day)) return new Date(9999, 11, 31);
  return new Date(new Date().getFullYear(), month, day);
}
async function loadTournaments() {
  const snap = await db.collection('tournaments').get();
  const tournaments = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
  return tournaments.sort((a, b) => _parseTournamentDate(a.dates) - _parseTournamentDate(b.dates));
}

// Wave 8: read global player stats from sfgl_data using the correct doc name.
// The cron previously read 'fantasy-golf-global-stats' but the actual doc
// kept after the prior cleanup is 'fantasy-golf-global-player-stats'.
async function loadGlobalPlayerStats() {
  const snap = await db.collection('sfgl_data').doc('fantasy-golf-global-player-stats').get();
  return snap.exists ? (snap.data().value || {}) : {};
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
  if (et.getDay() !== 3) return res.json({ status: 'not_wednesday' });

  const today = et.toLocaleDateString('en-US');
  const metaSnap = await db.collection('sfgl_data').doc('last_lineup_reminder').get();
  if (metaSnap.exists && metaSnap.data().value === today) return res.json({ status: 'already_sent' });

  const settings = await loadSettings();
  const tournaments = await loadTournaments();
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
      const sendResult = await sendEmail(email, `🏆 ${tournamentName} — SFGL Results`, buildTournamentResultsEmail(tournamentName, teamResults, teamName));
      // Wave 8: sendEmail returns { skipped: true } if BREVO_API_KEY is missing.
      // Don't count those as successes. Distinguish so the caller can tell
      // "all sent" from "all skipped/errored".
      if (sendResult?.skipped) {
        results.push({ team: teamName, skipped: true, reason: 'BREVO_API_KEY missing' });
      } else {
        results.push({ team: teamName, success: true });
      }
    } catch (err) { results.push({ team: teamName, error: err.message }); }
  }

  const sent    = results.filter(r => r.success).length;
  const errored = results.filter(r => r.error).length;
  const skipped = results.filter(r => r.skipped).length;
  const total   = results.length;

  // If no manager emails configured, also a problem worth surfacing
  if (total === 0) return res.status(500).json({ status: 'no_recipients', message: 'No manager emails configured', sent: 0, errored: 0, skipped: 0, results });
  // If everything failed, return non-2xx so the client surfaces the failure
  if (sent === 0)  return res.status(502).json({ status: 'all_failed',   message: skipped === total ? 'BREVO_API_KEY not configured' : 'All sends errored', sent, errored, skipped, results });
  return res.json({ status: 'sent', emailsSent: sent, errored, skipped, results });
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

async function handleProcessResults(res, dryRun = false) {
  const et = getETNow();
  // Only run on Monday — but dry-run can be tested any day for safety verification
  if (!dryRun && et.getDay() !== 1) return res.json({ status: 'not_monday' });

  const today = et.toLocaleDateString('en-US');
  const metaSnap = await db.collection('sfgl_data').doc('last_auto_results').get();
  if (!dryRun && metaSnap.exists && metaSnap.data().value === today) {
    return res.json({ status: 'already_run', message: 'Results already processed today' });
  }

  // Load all data (Wave 8: tournaments from dedicated collection, stats from
  // correctly-named sfgl_data doc — both were silently broken before)
  const settings = await loadSettings();
  const teams = await loadTeams();
  const tournaments = await loadTournaments();
  const globalStats = await loadGlobalPlayerStats();

  // Find active tournament
  const ti = tournaments.findIndex(t => t.playing && !t.completed);
  if (ti === -1) {
    if (!dryRun) await db.collection('sfgl_data').doc('last_auto_results').set({ key: 'last_auto_results', value: today });
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

  // Wave 8: dryRun support — return what WOULD be written, without committing.
  // Hit the endpoint with ?action=processResults&dryRun=1 to preview.
  if (dryRun) {
    return res.json({
      status: 'dry_run',
      tournament: tournament.name,
      wouldUpdate: {
        teams: updatedTeams.map(t => ({ id: t.id, name: t.name, earnings: t.earnings, lineup: t.lineup })),
        tournaments: newTournaments.filter(nt => nt.completed === true || nt.playing === true).map(nt => ({ name: nt.name, completed: !!nt.completed, playing: !!nt.playing })),
        statsKeys: Object.keys(newStats).length,
      },
    });
  }

  // Write everything to Firebase
  const batch = db.batch();

  // Update teams (unchanged — already writes to dedicated `teams` collection)
  for (const team of updatedTeams) {
    batch.update(db.collection('teams').doc(team.id), {
      roster: team.roster,
      earnings: team.earnings,
      segmentEarnings: team.segmentEarnings,
      lineup: team.lineup,
    });
  }

  // Wave 8: update tournaments in the DEDICATED `tournaments` collection.
  // Previously this wrote to sfgl_data/fantasy-golf-tournaments which the app
  // doesn't read from anymore. Each tournament gets its own doc, mirroring
  // tournamentsApi.setAll() in src/api/firebase.js. Strip the `_id` we added
  // when reading so we don't store it back.
  for (const t of newTournaments) {
    const docId = t._id || t.name || t.id;
    const data = { ...t };
    delete data._id;
    batch.set(db.collection('tournaments').doc(docId), data);
  }

  // Wave 8: stats doc name corrected — was 'fantasy-golf-global-stats',
  // actual doc kept after cleanup is 'fantasy-golf-global-player-stats'.
  batch.set(db.collection('sfgl_data').doc('fantasy-golf-global-player-stats'), { key: 'fantasy-golf-global-player-stats', value: newStats });
  batch.set(db.collection('sfgl_data').doc('last_auto_results'), { key: 'last_auto_results', value: today });

  await batch.commit();

  // Email results to all managers
  const managerEmails = getEmailMap(settings, teams);
  // Wave 8: include all teams (even those without lineups) and per-team
  // lineup details so the email can render player breakdowns.
  const teamResultsForEmail = updatedTeams.map(t => ({
    team: t.name,
    totalEarnings: resultsData.teams[t.id]?.totalEarnings || 0,
    players: resultsData.teams[t.id]?.players || [],
    submitted: !!resultsData.teams[t.id],
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
      case 'process-results':   return await handleProcessResults(res, req.query.dryRun === '1' || req.query.dryRun === 'true');
      case 'notify-results':    return await handleNotifyResults(req, res);
      default:                  return res.status(400).json({ error: 'Unknown action. Use ?action=waivers|lineup-reminder|process-results|notify-results' });
    }
  } catch (err) {
    console.error(`[cron] ${action} error:`, err);
    return res.status(500).json({ error: err.message });
  }
}
