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
import { getMessaging } from 'firebase-admin/messaging';

// ── Firebase Admin init ─────────────────────────────────────────────────────

function getApp() {
  if (getApps().length) return getApps()[0];
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!sa) throw new Error('FIREBASE_SERVICE_ACCOUNT env var not set');
  return initializeApp({ credential: cert(JSON.parse(sa)) });
}

const db = getFirestore(getApp());
const messaging = getMessaging(getApp());

// ── Push notifications (Wave J Round 6 batch 3-4) ───────────────────────────
// Helper for sending pushes to a single team's subscribed devices, with
// per-event preference checking. Mirrors the logic in /api/push.js but is
// called directly from server-side cron handlers (no HTTP hop needed).
//
// All current events default ON — managers must explicitly opt out via
// team.notificationPrefs.{eventKey} = false.
//
// Event keys:
//   waivers          — weekly waiver round summary (per team's own results)
//   lineupLock       — per-team lineup missing reminder
//   freeAgent        — any team's FA add/drop (broadcast)
//   results          — tournament results processed (broadcast)
//   commishModified  — your roster was edited by the commish
//
// Skip behavior:
//   • teamId not found → silent skip
//   • team has prefs map AND the specific event key is false → silent skip
//   • team has no prefs map at all → fall through to defaults (DEFAULTS_ON)
//   • event not in DEFAULTS_ON → require explicit opt-in (no batch 4 events
//     are in this category — all current events default ON)
//   • no subscribed devices → silent skip
//
// Returns { sent, failed, skipped, cleanedUp } per push attempt.

const DEFAULTS_ON = new Set([
  'waivers', 'lineupLock', 'freeAgent', 'results', 'commishModified', 'leadChange',
]);

// Channel-aware preference reader (server-side mirror of
// getEventChannelPrefs in src/api/pushNotifications.js). Returns whether the
// given channel ('push' | 'email') should fire for an event, given a team's
// notificationPrefs map. Backward-compatible with three stored shapes:
//   • { push, email } object → consult the channel (missing → event default)
//   • bare boolean (legacy)  → gates both channels identically
//   • missing                → event default (DEFAULTS_ON)
function channelAllowed(prefs, event, channel) {
  const stored = prefs?.[event];
  if (stored && typeof stored === 'object') {
    return typeof stored[channel] === 'boolean' ? stored[channel] : DEFAULTS_ON.has(event);
  }
  if (typeof stored === 'boolean') return stored;
  return DEFAULTS_ON.has(event);
}

async function sendPushToTeam({ teamId, event, title, body, deepLink }) {
  // ── Structured logging tag for grep'ability in Vercel logs ─────────────
  // Every line starts with [push] and includes teamId+event so we can trace
  // a single push attempt end-to-end. Useful even with Hobby's 1-hour
  // retention since each line is greppable in the visible window.
  const tag = `[push] team=${teamId} event=${event}`;
  console.log(`${tag} START title=${JSON.stringify(title)} body=${JSON.stringify(body)}`);

  if (!teamId || !event) {
    console.log(`${tag} SKIP: missing teamId or event`);
    return { sent: 0, failed: 0, skipped: 1, cleanedUp: 0 };
  }

  // Check this team's per-event prefs. Missing prefs map → defaults apply.
  // Missing event key inside prefs → defaults apply.
  try {
    const teamSnap = await db.collection('teams').doc(teamId).get();
    if (!teamSnap.exists) {
      console.log(`${tag} SKIP: team doc does not exist`);
      return { sent: 0, failed: 0, skipped: 1, cleanedUp: 0 };
    }
    const prefs = teamSnap.data()?.notificationPrefs;
    if (!channelAllowed(prefs, event, 'push')) {
      console.log(`${tag} SKIP: push channel disabled for this event`);
      return { sent: 0, failed: 0, skipped: 1, cleanedUp: 0 };
    }
    console.log(`${tag} prefs: push channel allowed`);
  } catch (err) {
    console.warn(`${tag} prefs check ERROR: ${err.message}`);
    return { sent: 0, failed: 0, skipped: 1, cleanedUp: 0 };
  }

  // Fetch tokens for this team
  let tokenDocs;
  try {
    const tokSnap = await db.collection('pushTokens').where('teamId', '==', teamId).get();
    tokenDocs = tokSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    console.log(`${tag} tokens: found ${tokenDocs.length}`);
  } catch (err) {
    console.warn(`${tag} token fetch ERROR: ${err.message}`);
    return { sent: 0, failed: 0, skipped: 1, cleanedUp: 0 };
  }
  if (tokenDocs.length === 0) {
    console.log(`${tag} SKIP: no tokens for team`);
    return { sent: 0, failed: 0, skipped: 1, cleanedUp: 0 };
  }

  // Send to each token in parallel
  let sent = 0;
  let failed = 0;
  const invalidTokens = [];

  await Promise.all(tokenDocs.map(async (tokDoc, idx) => {
    // DATA-ONLY payload. Mirrors /api/push.js. A combined notification+data
    // payload on webpush causes FCM to auto-display the notification AND
    // the SW's onBackgroundMessage to fire (because data is present) and
    // also call showNotification — two visible notifications per push.
    // With data-only, FCM does not auto-display; the SW/foreground handler
    // reads title/body from `data` and renders once.
    const tokenStr = tokDoc.token || tokDoc.id;
    const tokenPreview = tokenStr ? tokenStr.slice(0, 12) + '...' : 'EMPTY';
    const message = {
      token: tokenStr,
      data: {
        title:     String(title || 'SFGL'),
        body:      String(body  || ''),
        eventType: String(event),
        deepLink:  String(deepLink || '#standings'),
      },
      webpush: {
        fcmOptions: {
          link: deepLink
            ? `https://sfglgolf.com/${deepLink.startsWith('#') ? deepLink : '#' + deepLink}`
            : 'https://sfglgolf.com/',
        },
      },
    };
    try {
      const messageId = await messaging.send(message);
      sent++;
      console.log(`${tag} SENT idx=${idx} token=${tokenPreview} messageId=${messageId}`);
    } catch (err) {
      failed++;
      const code = err.errorInfo?.code || err.code || 'unknown';
      console.warn(`${tag} FAILED idx=${idx} token=${tokenPreview} code=${code} msg=${err.message}`);
      if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token')) {
        invalidTokens.push(tokDoc.id);
      }
    }
  }));

  // Clean up dead tokens
  let cleanedUp = 0;
  if (invalidTokens.length > 0) {
    try {
      const batch = db.batch();
      invalidTokens.forEach(id => batch.delete(db.collection('pushTokens').doc(id)));
      await batch.commit();
      cleanedUp = invalidTokens.length;
      console.log(`${tag} cleaned up ${cleanedUp} dead tokens`);
    } catch (err) {
      console.warn(`${tag} dead-token cleanup ERROR: ${err.message}`);
    }
  }

  console.log(`${tag} DONE sent=${sent} failed=${failed} cleanedUp=${cleanedUp}`);
  return { sent, failed, skipped: 0, cleanedUp };
}

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

// ── Segment + swing helpers (server-side, mirror AdminView client-side) ──

// Resolve a tournament's segment. Prefer the explicit segment field; fall
// back to date-derived inference when missing (older data).
function getSegmentForTournamentServer(t) {
  if (t?.segment) return t.segment;
  // Date-based fallback: parse a month out of the tournament's dates field
  // (e.g. "May 7-10") and map to the standard SFGL swings.
  const d = String(t?.dates || '').toLowerCase();
  if (d.match(/jan|feb|mar/))                                    return 'Spring Swing';
  if (d.match(/apr|may/))                                        return 'Spring Swing';
  if (d.match(/jun|jul/))                                        return 'Summer Swing';
  if (d.match(/aug|sep/))                                        return 'Fall Swing';
  return null;
}

// Compute the fee pot for a swing — match the client-side computeSwingPot.
// Used by the auto-award path below.
function computeSwingPotServer(transactions, tournaments, swingSegment) {
  if (!swingSegment) return 0;
  const swingIndexes = new Set(
    (tournaments || [])
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => getSegmentForTournamentServer(t) === swingSegment)
      .map(({ i }) => i)
  );
  return (transactions || [])
    .filter(tx => {
      if ((tx.fee || 0) <= 0) return false;
      if (tx.status === 'failed') return false;
      if (tx.type === 'swing_winner') return false;
      return tx.tournamentIndex !== undefined
        ? swingIndexes.has(tx.tournamentIndex)
        : tx.segment === swingSegment;
    })
    .reduce((sum, tx) => sum + (tx.fee || 0), 0);
}

// Auto-award helper for server-side processing. Same conditions as the
// client-side maybeAutoAwardSwing in AdminView. Returns { updatedTeams,
// newSwingTx, summary } when an award should fire, or null otherwise.
function maybeAutoAwardSwingServer(swingSegment, tournaments, teams, transactions) {
  if (!swingSegment) return null;
  if (transactions.some(tx => tx.type === 'swing_winner' && tx.segment === swingSegment)) return null;

  const swingTournaments = (tournaments || []).filter(t => getSegmentForTournamentServer(t) === swingSegment);
  if (swingTournaments.length === 0) return null;
  if (!swingTournaments.every(t => t.completed)) return null;

  const rankedTournaments = swingTournaments.filter(t => t.results?.teams);
  if (rankedTournaments.length === 0) return null;

  const byTeam = {};
  rankedTournaments.forEach(t => {
    Object.entries(t.results.teams).forEach(([id, tr]) => {
      byTeam[id] = (byTeam[id] || 0) + (tr.totalEarnings || 0);
    });
  });
  const winnerEntry = Object.entries(byTeam).sort((a, b) => b[1] - a[1])[0];
  if (!winnerEntry) return null;
  const [winnerId] = winnerEntry;
  const winnerTeam = (teams || []).find(t => t.id === winnerId);
  if (!winnerTeam) return null;

  const pot = computeSwingPotServer(transactions, tournaments, swingSegment);
  if (pot === 0) return null;

  const lastSegTourney = rankedTournaments.reduce((last, tt) => {
    const idx = tournaments.indexOf(tt);
    return idx > (last?.idx ?? -1) ? { t: tt, idx } : last;
  }, null);

  const newSwingTx = {
    txId: `swing-${swingSegment}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    team: winnerTeam.name,
    type: 'swing_winner',
    player: winnerTeam.owner,
    fee: 0,
    amount: pot,
    segment: swingSegment,
    date: new Date().toLocaleDateString(),
    timestamp: Date.now(),
    status: 'completed',
    tournamentIndex: lastSegTourney?.idx ?? undefined,
    note: swingSegment + ' winner pot (auto-awarded by cron)',
  };

  // Pot is a side-prize tracked in transactions only — does NOT add to
  // team.earnings, so standings (which derive from tournament.results)
  // remain unaffected. Mirrors the client-side maybeAutoAwardSwing.
  return {
    updatedTeams: teams,
    newSwingTx,
    pot,
    winnerTeamName: winnerTeam.name,
  };
}

function buildTournamentResultsEmail(tournamentName, teamResults, recipientTeam, swingWinnerInfo, seasonStandings) {
  // Defensive: handleNotifyResults takes teamResults from the client body, so
  // bad payloads can land here. Always render *something* informative.
  const list = Array.isArray(teamResults) ? teamResults : [];
  const sorted = [...list].sort((a, b) => (b.totalEarnings || 0) - (a.totalEarnings || 0));

  // ── Overall Season Standings card (top of email) ──
  // Renders a leaderboard of season-to-date totals before this tournament's
  // breakdown. Each row shows rank · team · season total · "+$X this week"
  // delta so the reader sees both the standing AND the shift caused by this
  // event. Hidden when caller doesn't supply seasonStandings (older call
  // sites / unit tests / very first event of the season).
  const standingsList = Array.isArray(seasonStandings) ? seasonStandings : [];
  // Build a lookup so we can annotate each season-row with this-week's earnings.
  const thisWeekByTeam = {};
  list.forEach(tr => { thisWeekByTeam[tr.team] = tr.totalEarnings || 0; });

  const standingsCard = standingsList.length ? `<div style="padding:14px 16px;background:linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02));border:1px solid rgba(255,255,255,0.08);border-radius:4px;margin:0 0 18px;">
    <div style="font-family:${FONT_STACK};font-size:10px;color:rgba(255,255,255,0.5);letter-spacing:2.5px;text-transform:uppercase;font-weight:600;margin:0 0 10px;">📊 Season Standings</div>
    ${standingsList.map((s, i) => {
      const isMe = s.team === recipientTeam;
      const isFirst = i === 0;
      const rankColor = isFirst ? '#f5c518' : 'rgba(255,255,255,0.4)';
      const teamColor = isMe ? '#ffffff' : 'rgba(255,255,255,0.85)';
      const delta = thisWeekByTeam[s.team] || 0;
      const deltaText = delta > 0
        ? `<span style="font-family:${FONT_STACK};font-size:10px;color:rgba(80,180,120,0.85);font-weight:500;margin-left:6px;">+$${delta.toLocaleString()}</span>`
        : '';
      // Same row layout as the per-tournament rows below for visual rhythm,
      // but no player breakdown sub-table — keeps the card compact at the
      // top of the email so it doesn't dwarf the tournament-specific
      // detail that follows.
      return `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:4px;${isMe ? 'background:rgba(255,255,255,0.04);' : ''}"><tr><td width="22" style="font-family:${FONT_STACK};font-size:13px;font-weight:700;color:${rankColor};vertical-align:middle;padding:4px 0 4px 4px;">${i + 1}</td><td style="font-family:${FONT_STACK};font-size:13px;font-weight:${isMe ? '700' : '500'};color:${teamColor};vertical-align:middle;padding:4px 0;">${s.team}${deltaText}</td><td style="font-family:${FONT_STACK};font-size:13px;font-weight:600;color:#50b478;text-align:right;vertical-align:middle;padding:4px 4px 4px 0;">$${(s.totalEarnings || 0).toLocaleString()}</td></tr></table>`;
    }).join('')}
  </div>` : '';

  // ── Swing winner banner (optional) ──
  // When this tournament was the final event of a swing AND a swing winner
  // was auto-awarded, the caller passes swingWinnerInfo so we render a
  // celebratory banner above the tournament results. Same color logic as
  // the in-app StandingsView swing card (gold accent for the winner).
  const swingBanner = swingWinnerInfo ? `<div style="padding:18px 16px;background:linear-gradient(180deg,rgba(245,197,24,0.12),rgba(245,197,24,0.04));border:1px solid rgba(245,197,24,0.35);border-radius:4px;margin:0 0 22px;text-align:center;"><div style="font-family:${FONT_STACK};font-size:10px;color:rgba(245,197,24,0.85);letter-spacing:2.5px;text-transform:uppercase;font-weight:600;margin:0 0 6px;">🏆 ${swingWinnerInfo.segment || 'Swing'} Complete</div><div style="font-family:${FONT_STACK};font-size:18px;color:#ffffff;font-weight:600;margin:0 0 4px;">${swingWinnerInfo.team || ''}</div><div style="font-family:${FONT_STACK};font-size:13px;color:rgba(255,255,255,0.7);font-weight:400;">wins the $${(swingWinnerInfo.pot || 0).toLocaleString()} pot</div></div>` : '';

  // ── Section header for the per-tournament breakdown ──
  // Only render when we have actual rows; keeps very-first-event emails
  // (with no season standings yet) from getting an awkward leading header.
  const tournamentHeader = sorted.length ? `<div style="font-family:${FONT_STACK};font-size:10px;color:rgba(255,255,255,0.5);letter-spacing:2.5px;text-transform:uppercase;font-weight:600;margin:0 0 10px;">⛳ This Tournament</div>` : '';

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

    // Player breakdown (optional). Mirrors TournamentsView's PlayerSlotGrid
    // color logic: unlimited=blue, limited=gold, default=white. Dim variant
    // when the player earned $0 (showEarnings=true with earnings=0). Earnings
    // text is green when positive, muted otherwise. Round-leader badges
    // (R1/R2/R3 orange pills) appear inline next to the player name.
    const players = Array.isArray(tr.players) ? tr.players : [];
    const playerRows = players.map(p => {
      const earned = (p.earnings || 0) > 0;
      const totalEarnings = (p.earnings || 0) + (p.bonus || 0);
      // Name color matches TournamentsView playerNameColor()
      let nameColor;
      if (p.unlimited)    nameColor = earned ? 'rgba(100,180,255,0.95)' : 'rgba(100,180,255,0.45)';
      else if (p.limited) nameColor = earned ? 'rgba(245,197,24,0.95)'  : 'rgba(245,197,24,0.45)';
      else                nameColor = earned ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.35)';

      // Round leader badges — orange pills, one per round led (R1/R2/R3).
      // Email clients vary on flex support, so use inline-block spans
      // separated by hair-spaces for reliable cross-client rendering.
      const rounds = Array.isArray(p.roundsLed) ? p.roundsLed : [];
      const roundBadges = rounds.length ? rounds.map(rl => `<span style="display:inline-block;padding:1px 5px;margin-left:4px;background:rgba(220,110,30,0.35);color:rgba(255,165,80,0.95);border-radius:2px;font-size:9px;font-weight:600;font-family:${FONT_STACK};vertical-align:middle;letter-spacing:0.5px;">R${rl.round || rl}</span>`).join('') : '';

      return `<tr><td style="font-family:${FONT_STACK};font-size:11px;color:${nameColor};padding:2px 0;font-weight:400;">${p.name || ''}${roundBadges}</td><td style="font-family:${FONT_STACK};font-size:11px;color:${totalEarnings > 0 ? '#50b478' : 'rgba(255,255,255,0.35)'};padding:2px 0;text-align:right;font-weight:500;">$${totalEarnings.toLocaleString()}</td></tr>`;
    }).join('');

    return `<div style="padding:12px 14px;background:${bg};border-radius:3px;margin-bottom:6px;${leftBorder}"><table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr><td width="22" style="font-family:${FONT_STACK};font-size:14px;font-weight:700;color:${rankColor};vertical-align:middle;">${i + 1}</td><td style="font-family:${FONT_STACK};font-size:14px;font-weight:${isMe ? '700' : '600'};color:${teamColor};vertical-align:middle;">${tr.team}</td><td style="font-family:${FONT_STACK};font-size:14px;font-weight:600;color:#50b478;text-align:right;vertical-align:middle;">$${(tr.totalEarnings || 0).toLocaleString()}</td></tr></table>${playerRows ? `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.08);">${playerRows}</table>` : ''}</div>`;
  }).join('') : `<div style="font-family:${FONT_STACK};font-size:13px;color:rgba(255,255,255,0.5);padding:24px;text-align:center;background:rgba(255,255,255,0.03);border-radius:3px;font-weight:400;">Team results unavailable for this email. Check the app for the latest standings.</div>`;

  // ── Color-coded player legend ──
  // Subtle footer to explain the name colors — same palette as RostersView
  // / TournamentsView so the visual language is consistent across the app
  // and the email. Only renders if at least one team has player breakdowns.
  const hasPlayerData = sorted.some(tr => Array.isArray(tr.players) && tr.players.length > 0);
  const legend = hasPlayerData ? `<div style="margin:14px 0 0;padding:10px 12px;background:rgba(255,255,255,0.02);border-radius:3px;font-family:${FONT_STACK};font-size:10px;color:rgba(255,255,255,0.5);letter-spacing:0.4px;font-weight:400;text-align:center;"><span style="color:rgba(245,197,24,0.95);font-weight:600;">●</span> Limited &nbsp;&nbsp;<span style="color:rgba(100,180,255,0.95);font-weight:600;">●</span> Unlimited &nbsp;&nbsp;<span style="display:inline-block;padding:1px 5px;background:rgba(220,110,30,0.35);color:rgba(255,165,80,0.95);border-radius:2px;font-size:9px;font-weight:600;letter-spacing:0.5px;">R#</span> Round Leader</div>` : '';

  return wrap(`<h2 style="font-family:${FONT_STACK};font-size:20px;font-weight:600;color:#ffffff;margin:0 0 4px;letter-spacing:0.5px;">🏆 ${tournamentName}</h2><p style="font-family:${FONT_STACK};font-size:10px;color:rgba(255,255,255,0.5);margin:0 0 18px;letter-spacing:2.5px;text-transform:uppercase;font-weight:400;">Tournament Results</p>${standingsCard}${swingBanner}${tournamentHeader}${rows}${legend}`);
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

// Channel-aware email map: like getEmailMap but ALSO filters out teams whose
// EMAIL channel is disabled for the given event. Returns teamName → email for
// teams that should receive an email for this event. Use this instead of
// getEmailMap anywhere a send is gated by a specific notification event.
//
// `event` must be one of the NOTIFICATION_EVENTS keys (waivers, results,
// lineupLock, freeAgent, commishModified, leadChange). Teams with no prefs
// or legacy boolean prefs fall through to the channelAllowed defaults.
function getEmailMapForEvent(settings, teams, event) {
  const emailMap = settings.managerEmails || {};
  const result = {};
  teams.forEach(t => {
    const email = emailMap[t.id] || emailMap[t.name];
    if (!email) return;
    if (!channelAllowed(t.notificationPrefs, event, 'email')) {
      console.log(`[email-gate] SKIP ${t.name} — email channel off for event=${event}`);
      return;
    }
    result[t.name] = email;
  });
  return result;
}

// ── Schedule gate helper ────────────────────────────────────────────────────
// Used by handleWaivers, handleLineupReminder, and handleProcessResults to
// decide whether the current cron ping should fire the action.
//
// Semantics: "the most recent scheduled slot (in the past 7 days) has passed,
// AND we haven't fired since that slot." This intentionally drops the older
// `day === targetDay` strict check so a late-running cron (e.g. Sunday 9pm
// slot but ESPN data not ready until Monday morning) still fires on the next
// ping, rather than waiting a full week.
//
// Returns:
//   { fire: boolean, et: Date, fireStamp: string, slotIso: string }
//
// On a successful fire, callers should write `fireStamp` to their meta doc
// (e.g. `sfgl_data/last_auto_waiver`) so future pings see this run.
//
// Legacy compat: existing meta docs store a "M/D/YYYY" date string. We parse
// those as end-of-day local time so already-completed weekly runs don't
// re-fire after deploying this change.
async function checkScheduleGate({ targetDay, targetHour, targetMinute, lastRunDocId }) {
  const et = getETNow();

  // Most recent scheduled slot at-or-before `now`, computed in ET-naive time.
  // `et` is a Date whose .getHours()/.getDay() reflect ET wall clock (see
  // getETNow). We do all slot math in that same naive frame.
  const slot = new Date(et);
  const daysBack = (et.getDay() - targetDay + 7) % 7;
  slot.setDate(et.getDate() - daysBack);
  slot.setHours(targetHour, targetMinute, 0, 0);
  // If we're on the target day but before the configured time, the "most
  // recent slot" is actually last week's, not today's.
  if (slot.getTime() > et.getTime()) {
    slot.setDate(slot.getDate() - 7);
  }

  // Read last successful fire timestamp.
  const metaSnap = await db.collection('sfgl_data').doc(lastRunDocId).get();
  let lastFireMs = 0;
  if (metaSnap.exists) {
    const val = metaSnap.data().value;
    if (typeof val === 'string') {
      if (/^\d+\/\d+\/\d+$/.test(val)) {
        // Legacy "M/D/YYYY" — treat as end-of-day to suppress spurious refire
        // for runs that completed under the old gate logic.
        const [m, d, y] = val.split('/').map(Number);
        lastFireMs = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
      } else if (/^\d+$/.test(val)) {
        // Legacy numeric ms timestamp string
        lastFireMs = parseInt(val, 10);
      } else {
        // ISO timestamp (new format produced by this helper's callers)
        const parsed = new Date(val);
        if (!isNaN(parsed.getTime())) lastFireMs = parsed.getTime();
      }
    }
  }

  return {
    fire: slot.getTime() > lastFireMs,
    et,
    fireStamp: et.toISOString(),
    slotIso: slot.toISOString(),
    lastFireMs,
    lastFireIso: lastFireMs > 0 ? new Date(lastFireMs).toISOString() : 'never',
  };
}

// ── Action: process waivers ─────────────────────────────────────────────────

async function handleWaivers(res) {
  console.log('[cron-waivers] handler invoked');
  const settings = await loadSettings();
  const targetDay    = settings?.waiverDay    ?? 2;
  const targetHour   = settings?.waiverHour   ?? 20;
  const targetMinute = settings?.waiverMinute ?? 0;
  console.log(`[cron-waivers] target: day=${targetDay} hour=${targetHour} minute=${targetMinute}`);

  // Schedule gate — see checkScheduleGate doc comment for semantics.
  // Drops the older strict `day === wDay` check so a late ping (e.g. ET cron
  // imprecision pushes us past midnight) still fires this week's run rather
  // than waiting until next week.
  const gate = await checkScheduleGate({
    targetDay,
    targetHour,
    targetMinute,
    lastRunDocId: 'last_auto_waiver',
  });
  console.log(`[cron-waivers] gate: fire=${gate.fire} now=${gate.fireStamp} slot=${gate.slotIso} lastFire=${gate.lastFireIso}`);
  if (!gate.fire) {
    return res.json({ status: 'not_yet', message: 'Not past waiver cutoff time, or already processed this week' });
  }
  const fireStamp = gate.fireStamp;

  // Load transactions
  const txSnap = await db.collection('transactions').get();
  const allTx = txSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const pending = allTx.filter(tx => tx.status === 'pending' && tx.type === 'waiver');
  console.log(`[cron-waivers] found ${pending.length} pending waiver claims`);

  if (pending.length === 0) {
    await db.collection('sfgl_data').doc('last_auto_waiver').set({ key: 'last_auto_waiver', value: fireStamp });
    console.log('[cron-waivers] no pending, marking lastFire and exiting');
    return res.json({ status: 'no_pending', message: 'No pending waiver claims' });
  }

  // Load teams + tournaments (tournaments needed to derive current
  // earnings for the waiver tie-breaker).
  let teams = await loadTeams();
  const sfglTournamentsSnap = await db.collection('sfgl_data').doc('fantasy-golf-tournaments').get();
  const tournamentsForWaivers = sfglTournamentsSnap.exists ? sfglTournamentsSnap.data().value : [];

  // Derive each team's current season earnings from tournament.results so
  // waiver priority isn't affected by drift in the stored team.earnings
  // field. Mirrors the client-side fix in handleProcessAll.
  const derivedEarnings = {};
  teams.forEach(t => { derivedEarnings[t.id] = 0; });
  tournamentsForWaivers.forEach(t => {
    if (!t.completed || !t.results?.teams) return;
    Object.entries(t.results.teams).forEach(([teamId, result]) => {
      if (derivedEarnings[teamId] !== undefined) derivedEarnings[teamId] += (result.totalEarnings || 0);
    });
  });
  const em = {}; teams.forEach(t => { em[t.name] = derivedEarnings[t.id] || 0; });
  const pm = {}; [...teams].sort((a, b) => (derivedEarnings[a.id] || 0) - (derivedEarnings[b.id] || 0)).forEach((t, i) => { pm[t.name] = i; });
  let nextLastPlace = teams.length;

  const byTeam = {};
  pending.forEach(w => { if (!byTeam[w.team]) byTeam[w.team] = []; byTeam[w.team].push(w); });
  Object.values(byTeam).forEach(c => c.sort((a, b) => (a.priority || 999) - (b.priority || 999)));

  const allRostered = new Set();
  teams.forEach(t => (t.roster || []).forEach(p => allRostered.add(p.name)));

  // ── Limbo (recently-dropped) players ───────────────────────────────────
  // Mirrors the client-side `limboPlayers` set in AddDropPlayerModal so the
  // UI and server enforce the same rule: a player who was dropped in a
  // processed transaction is unavailable to be added to any roster until
  // the next waiver period (i.e., until the tournament that owned the drop
  // is completed).
  //
  // Why this also has to live server-side: without it, two waivers in the
  // same run can defeat the lock entirely. Team A's waiver drops Y; Team
  // B's waiver wants to add Y. Because Y was just removed from allRostered
  // by Team A's drop, B's existing "already rostered" check passes and B
  // successfully claims a player who's supposed to be locked.
  //
  // The set is seeded from PRIOR processed transactions whose tournament
  // hasn't completed yet, then extended in-place as drops happen during
  // this run.
  const limboPlayers = new Set();
  allTx.forEach(tx => {
    if (!tx.droppedPlayer) return;
    if (tx.type === 'mulligan') return;
    if (tx.status !== 'processed' && tx.status !== 'completed') return;
    if (tx.tournamentIndex !== undefined) {
      const t = tournamentsForWaivers[tx.tournamentIndex];
      if (t && !t.completed) limboPlayers.add(tx.droppedPlayer);
    } else {
      // No tournamentIndex (older data) — treat as in limbo, conservative
      limboPlayers.add(tx.droppedPlayer);
    }
  });
  console.log(`[cron-waivers] seeded ${limboPlayers.size} players in limbo from prior txs`);

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
      // Limbo gate — refuse any claim adding a recently-dropped player.
      // Either dropped via a prior tx (seeded into limboPlayers above) or
      // dropped earlier in this same run (added below after a successful
      // drop). Failing all claims for the player in this round prevents
      // tiebreaker thrash on a player who's unavailable to anyone.
      if (limboPlayers.has(player)) {
        cs.forEach(c => { failed.add(c.claim.id); processedResults.push({ ...c.claim, status: 'failed', failReason: 'Player was recently dropped — unavailable until next waiver period' }); });
        more = true; return;
      }
      if (w.claim.droppedPlayer && (dropped.has(w.claim.droppedPlayer) || !allRostered.has(w.claim.droppedPlayer))) {
        failed.add(w.claim.id); processedResults.push({ ...w.claim, status: 'failed', failReason: w.claim.droppedPlayer + ' already dropped' });
        more = true; return;
      }

      if (w.claim.droppedPlayer) {
        allRostered.delete(w.claim.droppedPlayer);
        dropped.add(w.claim.droppedPlayer);
        // Lock the dropped player from being added by ANY subsequent claim
        // in this same run. Without this, the moment we remove them from
        // allRostered another team's claim for that player would sail
        // through the "already rostered" check above.
        limboPlayers.add(w.claim.droppedPlayer);
      }
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

  batch.set(db.collection('sfgl_data').doc('last_auto_waiver'), { key: 'last_auto_waiver', value: fireStamp });
  await batch.commit();

  // ── Push notifications ───────────────────────────────────────────────────
  // One uniform "Waiver results" push goes to every team after the round is
  // processed. Originally personalized per-team ("Won 1: K. Reitan · Lost
  // 1: A. Smith"), but switched to a single league-wide announcement so
  // every manager sees the same headline regardless of whether they had
  // claims of their own — and tapping through lands them in the
  // Transactions tab where the full league picture is visible.
  //
  // The body is the league-wide count of SUCCESSFUL claims this round
  // (e.g. "3 claims this week"). Send is gated on count > 0 — if no
  // claims actually landed (everyone lost tiebreakers, or no claims
  // filed), no pushes go out. Server-side prefs check via sendPushToTeam
  // means managers can still opt out of the 'waivers' event if they want.
  //
  // Best-effort: push failures don't roll back the waiver batch.
  const pushResults = [];

  // Count successful claims league-wide (players actually added this round).
  // Lost-tiebreaker claims aren't counted — they didn't result in a roster
  // move, so they wouldn't be visible on the Transactions tab the user
  // taps through to. If no claims succeeded, skip the push entirely
  // ("0 claims this week" reads awkwardly and there's nothing new to see).
  const claimsWonCount = processedResults.filter(r => r.status === 'processed').length;
  console.log(`[cron-waivers] processed ${processedResults.length} results, ${claimsWonCount} won`);

  if (claimsWonCount > 0) {
    const body = claimsWonCount === 1
      ? '1 claim this week'
      : `${claimsWonCount} claims this week`;
    console.log(`[cron-waivers] entering push loop for ${teams.length} teams, body=${JSON.stringify(body)}`);
    for (const team of teams) {
      if (!team?.id) {
        console.log(`[cron-waivers] skipping team without id: ${team?.name}`);
        continue;
      }
      try {
        const result = await sendPushToTeam({
          teamId: team.id,
          event: 'waivers',
          title: '⏰ Waiver results',
          body,
          deepLink: '#transactions',
        });
        pushResults.push({ team: team.name, event: 'waivers', ...result });
      } catch (err) {
        console.warn(`[cron-waivers] sendPushToTeam threw for ${team.name}: ${err.message}`);
      }
    }
    console.log(`[cron-waivers] push loop complete: ${JSON.stringify(pushResults)}`);
  } else {
    console.log(`[cron-waivers] no claims won, skipping push loop entirely`);
  }

  // Send emails — only to teams whose EMAIL channel is on for 'waivers'.
  const managerEmails = getEmailMapForEvent(settings, teams, 'waivers');
  const emailResults = [];
  for (const [teamName, email] of Object.entries(managerEmails)) {
    try {
      const html = buildWaiverResultsEmail(processedResults, teamName);
      await sendEmail(email, '⏰ Waiver results', html);
      emailResults.push({ team: teamName, success: true });
    } catch (err) { emailResults.push({ team: teamName, error: err.message }); }
  }

  return res.json({
    status: 'processed', processed: applied.length,
    failed: processedResults.filter(r => r.status === 'failed').length,
    emailsSent: emailResults.filter(r => r.success).length,
    pushesSent: pushResults.reduce((sum, p) => sum + (p.sent || 0), 0),
    details: processedResults.map(r => ({ team: r.team, player: r.player, status: r.status, failReason: r.failReason })),
  });
}

// ── Action: lineup reminder ─────────────────────────────────────────────────

async function handleLineupReminder(res) {
  console.log('[cron-lineup] handler invoked');
  const settings = await loadSettings();
  const targetDay    = settings?.lineupReminderDay    ?? 3;
  const targetHour   = settings?.lineupReminderHour   ?? 9;
  const targetMinute = settings?.lineupReminderMinute ?? 0;
  console.log(`[cron-lineup] target: day=${targetDay} hour=${targetHour} minute=${targetMinute}`);

  // Schedule gate — see checkScheduleGate doc comment. Replaces the older
  // strict-day-match + hour-gate + "already sent today" stack with a single
  // "scheduled slot has passed and we haven't fired since" check. Resilient
  // to off-day pings (Vercel Cron's hourly imprecision can push pings past
  // midnight).
  const gate = await checkScheduleGate({
    targetDay,
    targetHour,
    targetMinute,
    lastRunDocId: 'last_lineup_reminder',
  });
  console.log(`[cron-lineup] gate: fire=${gate.fire} now=${gate.fireStamp} slot=${gate.slotIso} lastFire=${gate.lastFireIso}`);
  if (!gate.fire) {
    return res.json({ status: 'not_yet', message: 'Not past reminder time, or already sent this week' });
  }
  const fireStamp = gate.fireStamp;

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
    if (team.lineup && team.lineup.length > 0) { results.push({ team: team.name, skipped: true }); continue; }
    // Push notification — sent to all subscribed devices for this team,
    // gated by their notificationPrefs.lineupLock setting (default ON).
    // Independent of email — managers without an email on file still get
    // pushes if they've subscribed devices.
    try {
      const pushResult = await sendPushToTeam({
        teamId: team.id,
        event: 'lineupLock',
        title: '⛳ Missing lineup',
        body: `Set your lineup for ${activeTourney.name} — locks at ${lockTime} ET.`,
        deepLink: '#rosters',
      });
      results.push({ team: team.name, pushSent: pushResult.sent });
    } catch (err) {
      console.warn(`[push] lineupLock failed for ${team.name}:`, err.message);
    }
    // Email — only if an email is on file AND the email channel is on.
    if (!email) continue;
    if (!channelAllowed(team.notificationPrefs, 'lineupLock', 'email')) {
      console.log(`[cron-reminder] SKIP email for ${team.name} — email channel off`);
      continue;
    }
    try {
      await sendEmail(email, '⛳ Missing lineup', buildLineupReminderEmail(activeTourney.name, lockTime, team.name));
      results.push({ team: team.name, success: true });
    } catch (err) { results.push({ team: team.name, error: err.message }); }
  }

  await db.collection('sfgl_data').doc('last_lineup_reminder').set({ key: 'last_lineup_reminder', value: fireStamp });
  return res.json({ status: 'sent', tournament: activeTourney.name, results });
}

// ── Action: notify results ──────────────────────────────────────────────────

async function handleNotifyResults(req, res) {
  const { tournamentName, teamResults, swingWinnerInfo, seasonStandings } = req.body || {};
  if (!tournamentName || !teamResults?.length) return res.status(400).json({ error: 'Missing tournamentName or teamResults' });

  const settings = await loadSettings();
  const teams = await loadTeams();
  const managerEmails = getEmailMapForEvent(settings, teams, 'results');
  const results = [];

  for (const [teamName, email] of Object.entries(managerEmails)) {
    try {
      await sendEmail(email, '🏆 Weekly Results Complete', buildTournamentResultsEmail(tournamentName, teamResults, teamName, swingWinnerInfo, seasonStandings));
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
  console.log('[cron-results] handler invoked');
  const settings = await loadSettings();
  const targetDay    = settings?.resultsDay    ?? 1;
  const targetHour   = settings?.resultsHour   ?? 9;
  const targetMinute = settings?.resultsMinute ?? 0;
  console.log(`[cron-results] target: day=${targetDay} hour=${targetHour} minute=${targetMinute}`);

  // Schedule gate — see checkScheduleGate doc comment. Defaults to Monday
  // 9:00 AM ET. Dropping the strict day-match check means a Sunday-evening
  // ping that gets `no_results` (ESPN hasn't published final results yet)
  // is automatically retried on Monday morning's ping — the previous version
  // would have given up until next Sunday.
  const gate = await checkScheduleGate({
    targetDay,
    targetHour,
    targetMinute,
    lastRunDocId: 'last_auto_results',
  });
  console.log(`[cron-results] gate: fire=${gate.fire} now=${gate.fireStamp} slot=${gate.slotIso} lastFire=${gate.lastFireIso}`);
  if (!gate.fire) {
    return res.json({ status: 'not_yet', message: 'Not past results processing time, or already processed this week' });
  }
  const fireStamp = gate.fireStamp;

  // Load remaining data (settings already loaded above)
  const teams = await loadTeams();
  const tournamentsSnap = await db.collection('sfgl_data').doc('fantasy-golf-tournaments').get();
  const tournaments = tournamentsSnap.exists ? tournamentsSnap.data().value : [];
  const statsSnap = await db.collection('sfgl_data').doc('fantasy-golf-global-stats').get();
  const globalStats = statsSnap.exists ? statsSnap.data().value : {};

  // Find active tournament
  const ti = tournaments.findIndex(t => t.playing && !t.completed);
  if (ti === -1) {
    await db.collection('sfgl_data').doc('last_auto_results').set({ key: 'last_auto_results', value: fireStamp });
    return res.json({ status: 'no_active_tournament' });
  }
  const tournament = tournaments[ti];

  // ── Safety gate: tournament must be plausibly complete ───────────────────
  // Defense-in-depth against the catastrophic-but-silent failure mode where
  // /api/pga-results returns a "past results" page for an event that hasn't
  // happened yet (PGA Tour publishes the page with the field listed days in
  // advance). Without this guard the cron would mark a future event
  // "completed" with $0 earnings for everyone — wiping lineups, advancing
  // the active-tournament pointer, and corrupting state in ways that are
  // painful to unwind.
  //
  // Two independent checks. Either alone would catch the bug; both together
  // means a single source of data weirdness can't trigger a false-positive
  // process. Both log loudly before bailing so future failures are easy
  // to diagnose.
  //
  // CHECK A — Calendar gate. Tournament must have started 4+ days ago in ET.
  // PGA Tour rounds are Thu-Sun (4 days). A tournament that started today
  // can't possibly have final results; an event whose start_date is in the
  // future definitely can't. The 4-day grace covers Monday-morning
  // processing of Sunday-finished events. Rain delays / Monday finishes
  // extend this naturally because the second guard (CHECK B) will block
  // until earnings actually exist.
  const startDateStr = tournament.start_date || tournament.startDate;
  if (startDateStr) {
    const startDate = new Date(startDateStr + 'T12:00:00Z');
    if (!isNaN(startDate.getTime())) {
      // Compare in ET-naive frame to match getETNow() semantics elsewhere.
      const nowEt = getETNow();
      const daysSinceStart = (nowEt.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
      console.log(`[cron-results] calendar check: start=${startDateStr} now=${nowEt.toISOString()} daysSinceStart=${daysSinceStart.toFixed(2)}`);
      if (daysSinceStart < 4) {
        console.warn(`[cron-results] REFUSING to process "${tournament.name}" — only ${daysSinceStart.toFixed(2)} days since start (need 4+)`);
        // Don't mark lastFire — we want the cron to keep retrying once the
        // tournament actually finishes. Marking it would suppress next
        // week's legit fire.
        return res.json({
          status: 'too_early',
          tournament: tournament.name,
          startDate: startDateStr,
          daysSinceStart: daysSinceStart.toFixed(2),
          message: `Tournament hasn't been underway long enough to have final results`,
        });
      }
    } else {
      console.warn(`[cron-results] start_date "${startDateStr}" failed to parse for "${tournament.name}" — relying on earnings check`);
    }
  } else {
    console.warn(`[cron-results] no start_date on "${tournament.name}" — relying on earnings check`);
  }

  // Fetch results from ESPN via the existing pga-results API
  // Since we're server-side, call our own API endpoint. Use the www. variant
  // explicitly — the bare sfglgolf.com domain 307-redirects, which causes
  // the internal fetch to fail or stall the function. See the lead-watch
  // handler for the full backstory on the 307 issue.
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'https://www.sfglgolf.com';
  const params = new URLSearchParams({ name: tournament.name, year: '2026' });

  let pgaData;
  try {
    const pgaResp = await fetch(`${baseUrl}/api/pga-results?${params.toString()}`);
    pgaData = await pgaResp.json();
    if (!pgaResp.ok || !pgaData.players?.length) {
      console.log(`[cron-results] pga-results returned no players (status ${pgaResp.status})`);
      return res.json({ status: 'no_results', message: pgaData.error || 'No results available yet for ' + tournament.name });
    }
  } catch (err) {
    console.warn(`[cron-results] pga-results fetch error: ${err.message}`);
    return res.json({ status: 'fetch_error', message: 'Failed to fetch results: ' + err.message });
  }

  // CHECK B — Earnings sanity. A real completed tournament always has at
  // least one player with non-zero earnings (the winner gets paid). If
  // every returned player shows $0, ESPN/PGA Tour gave us a pre-event
  // scaffolded page rather than final results. This catches cases where
  // start_date is missing/malformed but the data itself is the
  // tell-tale: a winner hasn't been paid yet.
  const playersWithEarnings = pgaData.players.filter(p => (p.earnings || 0) > 0).length;
  console.log(`[cron-results] earnings check: ${pgaData.players.length} players, ${playersWithEarnings} with earnings`);
  if (playersWithEarnings === 0) {
    console.warn(`[cron-results] REFUSING to process "${tournament.name}" — pga-results returned ${pgaData.players.length} players but ZERO have earnings`);
    return res.json({
      status: 'no_earnings',
      tournament: tournament.name,
      playersReturned: pgaData.players.length,
      message: 'Tournament results page found but no player has earnings yet — likely a pre-event scaffolded page',
    });
  }

  // CHECK C — Official status gate. The most reliable signal: the PGA Tour
  // page itself reports whether the tournament is OFFICIAL/COMPLETE. This is
  // what catches the failure mode where ESPN/PGA Tour shows PARTIAL final-
  // round data — some players finished (have earnings), others still on the
  // course ($0). CHECK B passes in that case (someone has earnings) but the
  // results aren't final. This check refuses unless the page explicitly says
  // the event is complete.
  //
  // Important nuance: if NO status signal was found at all (sawAnyStatus =
  // false), we DON'T hard-fail on this check — older page structures or the
  // HTML fallback may not expose status. In that case we fall through to
  // CHECK D (winner-purse sanity) which catches partial data via the money
  // distribution. Only an EXPLICIT non-final status causes a refusal here.
  const statusInfo = pgaData.status || {};
  console.log(`[cron-results] status check: sawAnyStatus=${statusInfo.sawAnyStatus} isFinal=${statusInfo.isFinal} raw=[${(statusInfo.raw || []).join(', ')}]`);
  if (statusInfo.sawAnyStatus && !statusInfo.isFinal) {
    console.warn(`[cron-results] REFUSING to process "${tournament.name}" — page status is not final (${(statusInfo.raw || []).join(', ')})`);
    return res.json({
      status: 'not_final',
      tournament: tournament.name,
      statusSignals: statusInfo.raw || [],
      message: 'Tournament page found but its status is not OFFICIAL/COMPLETE yet — results are still in progress',
    });
  }

  // CHECK D — Winner-purse sanity. Independent of status (and the safety net
  // when status isn't exposed). A completed PGA Tour event's winner takes a
  // purse-sized payout — typically $1M+ on a full-field event, and well over
  // $500K even on smaller purses. During a final round, ESPN often shows the
  // current leader with a much smaller number (a projected/partial value) or
  // shows several players tied at an identical mid-size figure with everyone
  // else at $0 — exactly the pattern in the bad email (top teams all at
  // $305,971, most players $0).
  //
  // Heuristic: the top earner must clear a floor that no mid-round partial
  // would plausibly hit. $450K is conservative — lower than any real PGA
  // Tour winner's share, higher than the partial/projected figures we've
  // seen leak through. If the max earnings is below the floor, refuse.
  //
  // Also flag the suspicious "everyone tied at the same number" pattern: if
  // the top 2+ players have IDENTICAL earnings AND that number is below a
  // full winner's share, it's almost certainly partial data, not a real
  // multi-way tie (real ties split the combined purse into DIFFERENT amounts
  // only when positions differ; an exact tie for the win is rare and would
  // still be a large number).
  const WINNER_PURSE_FLOOR = 450000;
  const sortedEarnings = pgaData.players
    .map(p => p.earnings || 0)
    .sort((a, b) => b - a);
  const maxEarnings = sortedEarnings[0] || 0;
  console.log(`[cron-results] winner-purse check: max=$${maxEarnings.toLocaleString()} floor=$${WINNER_PURSE_FLOOR.toLocaleString()}`);
  if (maxEarnings < WINNER_PURSE_FLOOR) {
    console.warn(`[cron-results] REFUSING to process "${tournament.name}" — top earner $${maxEarnings.toLocaleString()} is below winner-purse floor $${WINNER_PURSE_FLOOR.toLocaleString()} (likely partial/mid-round data)`);
    return res.json({
      status: 'suspect_partial',
      tournament: tournament.name,
      maxEarnings,
      floor: WINNER_PURSE_FLOOR,
      message: `Top earner ($${maxEarnings.toLocaleString()}) is below the winner-purse floor — results look partial, not final`,
    });
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
  const resultsData = { teams: {}, earningsMap: { ...earningsMap }, roundLeaders, fullLineups: {}, fullBackups: {} };
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
    if (team.backup) resultsData.fullBackups[team.id] = team.backup;

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
        unlimited: team.roster.find(p => p.name === s.playerName)?.unlimited || false,
        bonus: playersWithBonuses[s.playerName]?.total || 0,
        roundsLed: playersWithBonuses[s.playerName]?.rounds || [],
        wasRoundLeader: (playersWithBonuses[s.playerName]?.total || 0) > 0,
      })),
    };

    // Build lineup-name → earnings map from starterResults so the roster
    // update below uses the EXACT same numbers as resultsData.teams[id].
    // Mirrors the same fix applied to the client-side processTournamentData.
    const earningsByLineupName = {};
    starterResults.forEach(({ playerName, earnings }) => {
      earningsByLineupName[playerName] = earnings;
    });

    const updatedRoster = team.roster.map(player => {
      if (!team.lineup.includes(player.name)) return player;
      const pe = earningsByLineupName[player.name] || 0;
      return { ...player, starts: (player.starts || 0) + 1, sfglEarnings: (player.sfglEarnings || 0) + pe };
    });

    return {
      ...team,
      roster: updatedRoster,
      earnings: (team.earnings || 0) + totalEarnings,
      segmentEarnings: (team.segmentEarnings || 0) + totalEarnings,
      lineup: [],
      backup: null,
    };
  });

  // Mark tournament completed, advance to next
  const newTournaments = tournaments.map((nt, i) => i === ti ? { ...nt, completed: true, playing: false, results: resultsData } : nt);
  const nx = newTournaments.findIndex((nt, i) => i > ti && !nt.completed && !nt.isAlternate);
  if (nx !== -1) { newTournaments.forEach(nt => { nt.playing = false; }); newTournaments[nx].playing = true; }

  // ── Auto-award swing winner if this was the final event of its swing ──
  // Mirrors the client-side handleManualEntry path. Loads transactions so
  // computeSwingPotServer has fee totals and so we can append the new
  // swing_winner tx to Firestore.
  const txSnap = await db.collection('transactions').get();
  const allTransactions = txSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const swingSegment = getSegmentForTournamentServer(newTournaments[ti]);
  const autoAward = maybeAutoAwardSwingServer(swingSegment, newTournaments, updatedTeams, allTransactions);
  const finalTeams = autoAward?.updatedTeams || updatedTeams;

  // Write everything to Firebase
  const batch = db.batch();

  // Update teams (using auto-award-adjusted earnings if applicable)
  for (const team of finalTeams) {
    batch.update(db.collection('teams').doc(team.id), {
      roster: team.roster,
      earnings: team.earnings,
      segmentEarnings: team.segmentEarnings,
      lineup: team.lineup,
      backup: team.backup || null,
    });
  }

  // Update tournaments and stats in sfgl_data
  batch.set(db.collection('sfgl_data').doc('fantasy-golf-tournaments'), { key: 'fantasy-golf-tournaments', value: newTournaments });
  batch.set(db.collection('sfgl_data').doc('fantasy-golf-global-stats'), { key: 'fantasy-golf-global-stats', value: newStats });
  batch.set(db.collection('sfgl_data').doc('last_auto_results'), { key: 'last_auto_results', value: fireStamp });

  // Append swing winner transaction if auto-awarded. New doc; let Firestore
  // generate the doc id and use our txId as the dedup key.
  if (autoAward) {
    const newTxRef = db.collection('transactions').doc();
    batch.set(newTxRef, autoAward.newSwingTx);
  }

  await batch.commit();

  // Email results to all managers whose EMAIL channel is on for 'results'
  const managerEmails = getEmailMapForEvent(settings, teams, 'results');
  // Full player breakdown so the template can render the color-coded names,
  // round-leader badges, and bonus-inclusive earnings totals — matches the
  // shape sent from AdminView's handleManualEntry.
  const teamResultsForEmail = finalTeams
    .filter(t => resultsData.teams[t.id])
    .map(t => ({
      team: t.name,
      totalEarnings: resultsData.teams[t.id].totalEarnings || 0,
      players: (resultsData.teams[t.id].players || []).map(p => {
        const rosterEntry = (t.roster || []).find(rp => rp.name === p.name);
        return {
          name: p.name,
          earnings: p.earnings || 0,
          bonus: p.bonus || 0,
          limited: rosterEntry?.limited ?? !!p.limited,
          unlimited: rosterEntry?.unlimited ?? !!p.unlimited,
          roundsLed: Array.isArray(p.roundsLed) ? p.roundsLed : [],
        };
      }),
    }));

  // Build swing winner banner info if applicable. This causes the email
  // template to lead with a celebration banner above the tournament rows.
  const swingWinnerInfoForEmail = autoAward ? {
    segment: swingSegment,
    team: autoAward.winnerTeamName,
    pot: autoAward.pot,
  } : undefined;

  // ── Compute season standings ──
  // Sums each team's totalEarnings across every completed tournament (using
  // the just-updated newTournaments array so this week's results are
  // included). Derived from results.teams[id].totalEarnings — the same
  // source the in-app StandingsView uses — so the email matches what
  // managers see when they next open the app.
  const seasonStandingsForEmail = (() => {
    const totals = {};
    teams.forEach(t => { totals[t.id] = 0; });
    newTournaments.forEach(tt => {
      if (!tt.completed || !tt.results?.teams) return;
      Object.entries(tt.results.teams).forEach(([tid, r]) => {
        if (totals[tid] !== undefined) totals[tid] += (r.totalEarnings || 0);
      });
    });
    return teams
      .map(t => ({ team: t.name, totalEarnings: totals[t.id] || 0 }))
      .sort((a, b) => b.totalEarnings - a.totalEarnings);
  })();

  const emailResults = [];
  for (const [teamName, email] of Object.entries(managerEmails)) {
    try {
      await sendEmail(email, '🏆 Weekly Results Complete', buildTournamentResultsEmail(tournament.name, teamResultsForEmail, teamName, swingWinnerInfoForEmail, seasonStandingsForEmail));
      emailResults.push({ team: teamName, success: true });
    } catch (err) { emailResults.push({ team: teamName, error: err.message }); }
  }

  // ── Push notifications (Wave J Round 6 batch 4) ───────────────────────────
  // Broadcast tournament results to every team. Body is personalized per
  // team with their final earnings. Best-effort: failures here don't block
  // the response.
  const resultsPushes = [];
  for (const team of teams) {
    if (!team?.id) continue;
    // Personalize body with this team's result for the tournament
    const teamResult = teamResultsForEmail.find(r => r.team === team.name);
    const earnings = teamResult ? teamResult.totalEarnings : 0;
    const body = teamResult
      ? `${tournament.name}: you earned $${earnings.toLocaleString()}`
      : `Results are in for ${tournament.name}`;
    try {
      const result = await sendPushToTeam({
        teamId: team.id,
        event: 'results',
        title: '🏆 Weekly Results Complete',
        body,
        deepLink: '#standings',
      });
      resultsPushes.push({ team: team.name, ...result });
    } catch (err) {
      console.warn(`[push] results failed for ${team.name}:`, err.message);
    }
  }

  return res.json({
    status: 'processed',
    tournament: tournament.name,
    teamsScored: Object.keys(resultsData.teams).length,
    playersLoaded: players.length,
    emailsSent: emailResults.filter(r => r.success).length,
    pushesSent: resultsPushes.reduce((sum, p) => sum + (p.sent || 0), 0),
    swingAutoAwarded: autoAward ? `${swingSegment} → ${autoAward.winnerTeamName} ($${autoAward.pot.toLocaleString()})` : null,
  });
}

// ── Router ──────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// PGAT Stats Sync
// ─────────────────────────────────────────────────────────────────────────────
// Scrapes pgatour.com __NEXT_DATA__ for season earnings/events/cuts. Lives
// inside cron.js (instead of its own api/pgat-stats.js file) so the commish
// doesn't have to remember to deploy a separate function — adding endpoints
// is the most reliably-forgotten deploy step.
//
// Called from AdminView's "Sync PGAT Stats" button via:
//   GET /api/cron?action=pgat-stats
// No auth required (parallel to notify-results).
const PGAT_STATS_URLS = [
  'https://www.pgatour.com/stats/detail/02671',          // Money Earned
  'https://www.pgatour.com/stats/category/money/02671',  // alternate route
  'https://www.pgatour.com/fedexcup/standings',          // FedEx Cup (includes earnings)
];

const PGAT_FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Referer': 'https://www.pgatour.com/',
};

function pgatExtractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function pgatParseStatsFromNextData(nd) {
  const NAME_KEYS  = ['displayName', 'playerName', 'name', 'fullName'];
  const MONEY_KEYS = ['money', 'earnings', 'officialMoney', 'moneyEarned', 'amount', 'statValue'];
  const EVENT_KEYS = ['events', 'eventsPlayed', 'tournaments', 'tournamentsPlayed', 'starts'];
  const CUTS_KEYS  = ['cutsMade', 'cuts', 'madeCuts'];

  const map = new Map();
  const numFromAny = (raw) => {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'number' && isFinite(raw)) return raw;
    if (typeof raw === 'string') {
      const cleaned = raw.replace(/[$,]/g, '').trim();
      const n = parseFloat(cleaned);
      return isNaN(n) ? null : n;
    }
    return null;
  };
  const findOne = (obj, keys) => {
    if (!obj || typeof obj !== 'object') return null;
    for (const k of keys) {
      if (k in obj) { const v = numFromAny(obj[k]); if (v !== null) return v; }
    }
    return null;
  };
  const findName = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    const src = obj.player || obj;
    for (const k of NAME_KEYS) {
      if (typeof src[k] === 'string' && src[k].trim().length > 2) return src[k].trim();
    }
    return null;
  };
  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(walk); return; }
    const name = findName(obj);
    if (name) {
      let earnings = findOne(obj, MONEY_KEYS) ?? findOne(obj.player || {}, MONEY_KEYS);
      let events   = findOne(obj, EVENT_KEYS) ?? findOne(obj.player || {}, EVENT_KEYS);
      let cuts     = findOne(obj, CUTS_KEYS)  ?? findOne(obj.player || {}, CUTS_KEYS);
      if (Array.isArray(obj.stats)) {
        for (const s of obj.stats) {
          const sn = String(s?.statName || s?.name || '').toLowerCase();
          const sv = numFromAny(s?.value ?? s?.statValue);
          if (sv === null) continue;
          if (earnings === null && /money|earning/.test(sn)) earnings = sv;
          if (events   === null && /event|start/.test(sn))   events   = sv;
          if (cuts     === null && /cut/.test(sn))           cuts     = sv;
        }
      }
      if (earnings !== null || events !== null || cuts !== null) {
        const prev = map.get(name) || { earnings: 0, eventsPlayed: 0, cutsMade: 0 };
        map.set(name, {
          earnings:     Math.max(prev.earnings,     earnings || 0),
          eventsPlayed: Math.max(prev.eventsPlayed, events   || 0),
          cutsMade:     Math.max(prev.cutsMade,     cuts     || 0),
        });
      }
    }
    Object.values(obj).forEach(walk);
  };
  walk(nd);
  return [...map.entries()].map(([name, stats]) => ({ name, ...stats }));
}

async function pgatFetchAndParse(url, timeoutMs = 7000) {
  // Per-fetch AbortController timeout so a slow PGA Tour URL can't burn the
  // whole 10s Vercel Hobby budget. Without this, sequential fetches with
  // unbounded latency triggered Vercel's HTML "function timed out" page,
  // which the client then choked on with "Unexpected token 'T'" trying to
  // parse the HTML as JSON.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { headers: PGAT_FETCH_HEADERS, signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
    const html = await resp.text();
    const nd = pgatExtractNextData(html);
    if (!nd) throw new Error(`No __NEXT_DATA__ on ${url}`);
    return pgatParseStatsFromNextData(nd);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Timeout (${timeoutMs}ms) fetching ${url}`);
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function handlePgatStats(res) {
  // Fire all 3 URLs in parallel — overall finishes in ~7s max regardless of
  // PGA Tour latency, well under Vercel's 10s Hobby-plan limit.
  const results = await Promise.allSettled(
    PGAT_STATS_URLS.map(url => pgatFetchAndParse(url))
  );
  const tried = [];
  let bestPlayers = [];
  let lastError = null;
  results.forEach((r, i) => {
    const url = PGAT_STATS_URLS[i];
    if (r.status === 'fulfilled') {
      const players = r.value;
      const withEarnings = players.filter(p => (p.earnings || 0) > 0);
      tried.push({ url, count: withEarnings.length });
      if (withEarnings.length > bestPlayers.length) bestPlayers = withEarnings;
    } else {
      lastError = r.reason?.message || String(r.reason);
      tried.push({ url, error: lastError });
    }
  });
  if (bestPlayers.length === 0) {
    return res.status(502).json({ error: 'No PGA Tour stats data could be parsed', attempts: tried, lastError });
  }
  return res.status(200).json({
    players: bestPlayers.sort((a, b) => b.earnings - a.earnings),
    count: bestPlayers.length,
    sourceAttempts: tried,
  });
}

// ── Action: owgr-rankings ───────────────────────────────────────────────────
//
// Refreshes OWGR world rankings from apiweb.owgr.com. Mirrors what
// DataSyncPanel.handleSyncOwgr does on the client, but runs server-side via
// cron so the manager doesn't have to remember to sync weekly.
//
// Schedule: defaults to Monday 2pm ET. OWGR publishes new rankings every
// Monday morning, so 2pm ET gives them several hours to settle before we
// fetch. Day/hour/minute are configurable via settings (owgrSyncDay,
// owgrSyncHour, owgrSyncMinute) following the same pattern as waivers and
// lineup-reminder.
//
// Idempotency: cron-job.org will fire on schedule but the day/hour gate
// short-circuits any out-of-window pings. The `last_owgr_sync` doc tracks
// whether we already ran today, so multiple in-window pings collapse to a
// single sync.
//
// Data flow:
//   1. Day/hour gate (early return if outside window)
//   2. Day-of dedupe (early return if already synced today)
//   3. Fetch /api/owgr internally (reuses the existing serverless function)
//   4. Build alias map from Firestore (resolve names to canonical doc IDs)
//   5. Batch-upsert player docs with new world_rank values
//   6. Update app_metadata/players_last_updated (back-compat)
//   7. Update league_settings/owgrLastSynced (authoritative — read by the
//      DataSyncPanel through the settings subscription)
async function handleOwgrRankings(res) {
  const et = getETNow();
  const settings = await loadSettings();

  // Day/hour/minute gate, mirroring handleLineupReminder.
  const targetDay    = settings?.owgrSyncDay    ?? 1;   // Mon
  const targetHour   = settings?.owgrSyncHour   ?? 14;  // 2pm ET
  const targetMinute = settings?.owgrSyncMinute ?? 0;

  if (et.getDay() !== targetDay) {
    return res.json({ status: 'not_target_day', targetDay });
  }
  if (et.getHours() < targetHour || (et.getHours() === targetHour && et.getMinutes() < targetMinute)) {
    return res.json({ status: 'not_yet', targetHour, targetMinute });
  }

  // Day-of dedupe — collapse multiple in-window pings to one actual sync.
  const today = et.toLocaleDateString('en-US');
  const dedupeRef = db.collection('sfgl_data').doc('last_owgr_sync');
  const dedupeSnap = await dedupeRef.get();
  if (dedupeSnap.exists && dedupeSnap.data().value === today) {
    return res.json({ status: 'already_synced_today' });
  }

  // Fetch /api/owgr internally. Reuses the existing endpoint so the OWGR
  // scraping logic stays in one place. Use the www. variant explicitly —
  // bare sfglgolf.com 307-redirects (see lead-watch handler comment).
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'https://www.sfglgolf.com';

  let owgrData;
  try {
    const resp = await fetch(`${baseUrl}/api/owgr`);
    if (!resp.ok) {
      return res.status(502).json({ status: 'owgr_fetch_failed', http: resp.status });
    }
    owgrData = await resp.json();
  } catch (err) {
    return res.status(502).json({ status: 'owgr_fetch_error', error: err.message });
  }

  // Same parsing/cleaning as the client (DataSyncPanel.handleSyncOwgr):
  // strip parenthetical suffixes from names, require a space (filters out
  // single-token entries that aren't real player names).
  const cleanName = (n) => (n || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  const fetched = (owgrData.players || [])
    .map(({ name, worldRank }) => ({ name: cleanName(name), worldRank }))
    .filter(p => p.name && p.name.includes(' ') && Number.isFinite(p.worldRank));

  if (!fetched.length) {
    return res.status(502).json({ status: 'no_rankings_returned' });
  }

  // Resolve aliases — some players are stored under a canonical name (e.g.
  // Nico Echavarria) that differs from what OWGR returns ("Nicolas
  // Echavarria"). Without this, the alias-having player's ranking never
  // updates via cron. Client upsertMany does the same resolution; we
  // duplicate it here because cron can't reach the client helpers.
  const aliasMap = {};
  try {
    const aliasSnap = await db.collection('players').where('aliases', '!=', null).get();
    aliasSnap.docs.forEach(d => {
      const data = d.data();
      const canonical = data.name || d.id;
      const aliases = Array.isArray(data.aliases) ? data.aliases : [];
      aliases.forEach(a => { aliasMap[a] = canonical; });
    });
  } catch (err) {
    console.warn('[owgr-sync] alias map load failed; proceeding without:', err.message);
  }

  // Batch-upsert player docs. Firestore batches cap at 500 ops per commit,
  // so we chunk; this matches the BATCH_SIZE=499 used in playersApi.upsertMany.
  const BATCH_SIZE = 499;
  let upserted = 0;
  for (let i = 0; i < fetched.length; i += BATCH_SIZE) {
    const batch = db.batch();
    fetched.slice(i, i + BATCH_SIZE).forEach(({ name, worldRank }) => {
      const canonicalName = aliasMap[name] || name;
      batch.set(
        db.collection('players').doc(canonicalName),
        { name: canonicalName, world_rank: worldRank },
        { merge: true }
      );
      upserted++;
    });
    await batch.commit();
  }

  // Update both timestamp locations: app_metadata for back-compat, and
  // league_settings.owgrLastSynced for the panel's primary source.
  const ts = new Date().toISOString();
  await db.collection('app_metadata').doc('players_last_updated').set({
    key: 'players_last_updated', value: ts,
  });
  await db.collection('league_settings').doc('owgrLastSynced').set({
    key: 'owgrLastSynced', value: ts,
  });

  // Mark today as synced for the dedupe gate.
  await dedupeRef.set({ key: 'last_owgr_sync', value: today });

  return res.json({
    status: 'sent',
    upserted,
    aliasesApplied: Object.keys(aliasMap).length,
    timestamp: ts,
  });
}

// ── Action: lead-watch ──────────────────────────────────────────────────────
//
// Monitors live tournament leaderboard for lead changes and sends a push to
// any team whose starting lineup includes the new leader. Fires only during
// round 2 or later — round 1 is too noisy with morning/afternoon waves
// spread across hours.
//
// Cadence: cron-job.org pings every 10 minutes. The handler is cheap when
// there's no live tournament (early return after checking activeTourney).
//
// Rate limiting: a given team+player combo won't get pinged more than once
// per 30 minutes. Prevents Sunday-final-round spam if a player ping-pongs at
// the top.
//
// State storage: sfgl_data/leadWatch — single doc with:
//   {
//     tournamentName: string,           // discriminator
//     round:          number,
//     leaderNames:    string[],         // sorted, deduplicated current-leader set
//     lastFired:      { "teamId:playerName": ISO timestamp }
//   }
//
// Reset behavior: when tournamentName changes, the doc is fully overwritten
// with the new state. The lastFired map is per-tournament — no carryover.
async function handleLeadWatch(res) {
  // 1. Fetch live leaderboard via the existing /api/live endpoint.
  //
  // The base URL MUST be the www. variant — sfglgolf.com without www
  // redirects (307), and the internal fetch either fails or stalls the
  // function waiting on the redirect, which causes the outer cron-job.org
  // call to time out and counts as a failed execution. cron-job.org auto-
  // disables jobs after enough consecutive fails, which is exactly what
  // happened on 5/27 when both this URL AND the cron-job.org job URL used
  // the bare domain.
  //
  // VERCEL_URL is unset for normal production runtime (only set for preview
  // deployments), so the fallback path is what actually runs in production.
  // Hardcode www. here so prod always works.
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'https://www.sfglgolf.com';

  let liveData;
  try {
    const resp = await fetch(`${baseUrl}/api/live`);
    if (!resp.ok) return res.json({ status: 'live_fetch_failed', http: resp.status });
    liveData = await resp.json();
  } catch (err) {
    return res.json({ status: 'live_fetch_error', error: err.message });
  }

  if (!liveData?.players?.length) return res.json({ status: 'no_players' });

  // 2. Gate: round 2 or later. The /api/live `round` field can be a number
  //    or string depending on PGA Tour's payload; coerce defensively.
  const round = parseInt(liveData.round, 10);
  if (!Number.isFinite(round) || round < 2) {
    return res.json({ status: 'round_too_early', round: liveData.round });
  }

  const tournamentName = liveData.tournamentName || liveData.eventName || '';
  if (!tournamentName) return res.json({ status: 'no_tournament_name' });

  // 3. Compute the current leader-set. A player counts as "leading" when
  //    position is '1' or 'T1'. Sort alphabetically for stable comparison
  //    across runs (set-equality doesn't depend on order, but JSON-stringify
  //    does).
  const isLeaderPos = (pos) => pos === '1' || pos === 'T1';
  const currentLeaders = liveData.players
    .filter(p => p.name && isLeaderPos(p.position) && !p.isCut && !p.isWD)
    .map(p => p.name);
  const currentLeaderSet = [...new Set(currentLeaders)].sort();

  if (currentLeaderSet.length === 0) {
    return res.json({ status: 'no_current_leader' });
  }

  // 4. Load previous state. If tournament changed, treat as fresh start.
  const stateRef = db.collection('sfgl_data').doc('leadWatch');
  const stateSnap = await stateRef.get();
  const prevState = stateSnap.exists ? stateSnap.data().value || {} : {};
  const sameTournament = prevState.tournamentName === tournamentName;
  const prevLeaderSet = sameTournament ? (prevState.leaderNames || []) : [];
  const lastFired = sameTournament ? (prevState.lastFired || {}) : {};

  // 5. Identify NEW leaders — names in the current set that weren't in the
  //    previous set. These are who "took the lead" this poll cycle.
  //    Players who were already in the leader set don't get re-pinged
  //    (otherwise a 3-way tie at T1 would re-fire on every poll).
  const prevLeaderNameSet = new Set(prevLeaderSet);
  const newLeaders = currentLeaderSet.filter(n => !prevLeaderNameSet.has(n));

  // No new leaders — leader-set is the same or smaller. Update state anyway
  // (in case round number advanced) and exit.
  if (newLeaders.length === 0) {
    await stateRef.set({
      key: 'leadWatch',
      value: {
        tournamentName,
        round,
        leaderNames: currentLeaderSet,
        lastFired,
      },
    });
    return res.json({ status: 'no_change', leaders: currentLeaderSet });
  }

  // 6. For each new leader × each team with that player in lineup, send a
  //    push (rate-limited). The 30-minute window is per team+player —
  //    different teams sharing the same player get separate budgets.
  const teams = await loadTeams();
  const newFired = { ...lastFired };
  const RATE_LIMIT_MS = 30 * 60 * 1000;
  const now = Date.now();
  const sends = [];

  for (const leaderName of newLeaders) {
    const leaderNorm = normalizeName(leaderName);
    // Determine the leader's score string for the push body (e.g. "-12").
    const leaderPlayer = liveData.players.find(p => normalizeName(p.name) === leaderNorm);
    const scoreStr = leaderPlayer?.score || '';
    const thruStr  = leaderPlayer?.thru  || '';
    const isCoLeader = currentLeaderSet.length > 1;

    for (const team of teams) {
      const lineup = team.lineup || [];
      const inLineup = lineup.some(n => normalizeName(n) === leaderNorm);
      if (!inLineup) continue;

      const rateKey = `${team.id}:${leaderName}`;
      const lastTs = Date.parse(newFired[rateKey] || 0);
      if (Number.isFinite(lastTs) && (now - lastTs) < RATE_LIMIT_MS) {
        sends.push({ team: team.name, player: leaderName, skipped: 'rate_limited' });
        continue;
      }

      // Build the push. Co-leader gets a slightly softer headline than sole
      // leader to be honest about the state of play.
      const title = isCoLeader
        ? `🏌 ${leaderName} is tied for the lead`
        : `🏌 ${leaderName} takes the lead`;
      const bodyParts = [];
      if (scoreStr) bodyParts.push(`${scoreStr}`);
      if (thruStr)  bodyParts.push(`thru ${thruStr}`);
      bodyParts.push(`at ${tournamentName}`);
      const body = bodyParts.join(' · ');

      try {
        const pushResult = await sendPushToTeam({
          teamId: team.id,
          event: 'leadChange',
          title,
          body,
          deepLink: '#rosters',
        });
        newFired[rateKey] = new Date(now).toISOString();
        sends.push({ team: team.name, player: leaderName, sent: pushResult.sent, failed: pushResult.failed });
      } catch (err) {
        sends.push({ team: team.name, player: leaderName, error: err.message });
      }
    }
  }

  // 7. Persist new state (always, even when no sends fired — leaderNames
  //    advances regardless).
  await stateRef.set({
    key: 'leadWatch',
    value: {
      tournamentName,
      round,
      leaderNames: currentLeaderSet,
      lastFired: newFired,
    },
  });

  return res.json({
    status: 'sent',
    tournament: tournamentName,
    round,
    prevLeaders: prevLeaderSet,
    currentLeaders: currentLeaderSet,
    newLeaders,
    sends,
  });
}

// ── Action: sync-cron-schedule ──────────────────────────────────────────────
//
// Updates the cron-job.org job schedule for one of our recurring tasks to
// match what the commish set in AdminView. Called from the client every
// time the commish saves a schedule, so AdminView is the single source of
// truth for when each automation fires.
//
// This is what lets us escape Vercel Hobby's "fires within an hour-window"
// imprecision — cron-job.org fires within seconds of the configured time,
// and its REST API lets us reschedule from code.
//
// Request body (POST):
//   {
//     jobType: 'waivers' | 'results' | 'lineup-reminder',
//     day:     0-6 (0=Sun, 6=Sat),
//     hour:    0-23 (ET),
//     minute:  0-59
//   }
//
// Required env vars (server-side only — API key never reaches the client):
//   CRONJOB_API_KEY                — Personal API key from cron-job.org
//   CRONJOB_WAIVERS_JOB_ID         — Numeric job ID for the Waivers job
//   CRONJOB_RESULTS_JOB_ID         — Numeric job ID for the Process Results job
//   CRONJOB_LINEUP_REMINDER_JOB_ID — Numeric job ID for the Lineup Reminders job
//   CRONJOB_LEAD_WATCH_JOB_ID      — Numeric job ID for the Lead Watch job
//
// Schedule semantics:
//   • Weekly jobs (waivers / results / lineup-reminder): client sends
//     day/hour/minute in ET; we set timezone=America/New_York and pin the
//     schedule to that single weekday slot.
//   • Interval jobs (lead-watch): client sends a `minuteInterval` (e.g. 10).
//     We expand it into an explicit minutes-of-the-hour list (0, 10, 20, 30,
//     40, 50 for minuteInterval=10) and set hours/wdays/mdays/months to
//     wildcards so the job fires at those minutes around the clock. The
//     handler itself self-gates on round/tournament state, so 24/7 polling
//     is cheap when there's no live event.
async function handleSyncCronSchedule(req, res) {
  const { jobType, day, hour, minute, minuteInterval } = req.body || {};

  // Map jobType → env var for the cron-job.org numeric job ID, and the
  // schedule shape that job uses (weekly slot vs. minute-interval).
  const jobIdEnvMap = {
    'waivers':         { env: 'CRONJOB_WAIVERS_JOB_ID',         shape: 'weekly'   },
    'results':         { env: 'CRONJOB_RESULTS_JOB_ID',         shape: 'weekly'   },
    'lineup-reminder': { env: 'CRONJOB_LINEUP_REMINDER_JOB_ID', shape: 'weekly'   },
    'lead-watch':      { env: 'CRONJOB_LEAD_WATCH_JOB_ID',      shape: 'interval' },
  };
  if (!jobIdEnvMap[jobType]) {
    return res.status(400).json({
      error: `Invalid jobType. Must be one of: ${Object.keys(jobIdEnvMap).join(', ')}`,
    });
  }
  const { env: jobIdEnvVar, shape: scheduleShape } = jobIdEnvMap[jobType];

  // Shape-specific validation + payload assembly. Done before any network
  // call so a bad request doesn't waste a cron-job.org API hit.
  let schedulePayload;
  if (scheduleShape === 'weekly') {
    if (typeof day !== 'number' || day < 0 || day > 6) {
      return res.status(400).json({ error: 'Invalid day (must be 0-6)' });
    }
    if (typeof hour !== 'number' || hour < 0 || hour > 23) {
      return res.status(400).json({ error: 'Invalid hour (must be 0-23)' });
    }
    if (typeof minute !== 'number' || minute < 0 || minute > 59) {
      return res.status(400).json({ error: 'Invalid minute (must be 0-59)' });
    }
    schedulePayload = {
      timezone: 'America/New_York',
      hours:   [hour],
      minutes: [minute],
      wdays:   [day],
      mdays:   [-1],
      months:  [-1],
    };
  } else {
    // interval shape: minuteInterval ∈ {5, 10, 15, 20, 30}. Expand to an
    // explicit minutes list (cron-job.org doesn't support a step expression
    // directly through this API — it takes literal minute values). Hours
    // and weekdays wildcard so the job fires every interval around the
    // clock; the handler's internal gates (no live tournament / round < 2)
    // make the off-hour pings cheap.
    const allowedIntervals = [5, 10, 15, 20, 30];
    if (!allowedIntervals.includes(minuteInterval)) {
      return res.status(400).json({
        error: `Invalid minuteInterval. Must be one of: ${allowedIntervals.join(', ')}`,
      });
    }
    const minutes = [];
    for (let m = 0; m < 60; m += minuteInterval) minutes.push(m);
    schedulePayload = {
      timezone: 'America/New_York',
      hours:   [-1],
      minutes,
      wdays:   [-1],
      mdays:   [-1],
      months:  [-1],
    };
  }

  const jobId = process.env[jobIdEnvVar];
  const apiKey = process.env.CRONJOB_API_KEY;

  if (!jobId) {
    console.warn(`[sync-cron-schedule] ${jobIdEnvVar} not set`);
    return res.status(500).json({
      error: `Server config error: ${jobIdEnvVar} not set`,
      hint: 'Add the cron-job.org job ID to Vercel environment variables',
    });
  }
  if (!apiKey) {
    console.warn('[sync-cron-schedule] CRONJOB_API_KEY not set');
    return res.status(500).json({
      error: 'Server config error: CRONJOB_API_KEY not set',
      hint: 'Add your cron-job.org API key to Vercel environment variables',
    });
  }

  // Build the cron-job.org PATCH payload using the schedule we assembled
  // above (shape-aware). Reference:
  //   https://docs.cron-job.org/rest-api.html#updating-a-job
  // The schedule object uses arrays for hours/minutes/wdays etc. with -1
  // meaning "wildcard". Weekly schedules use a single hours+minutes+wdays
  // slot; interval schedules use a minutes list + wildcards.
  const payload = { job: { schedule: schedulePayload } };

  const logDesc = scheduleShape === 'weekly'
    ? `${day}/${hour}:${String(minute).padStart(2, '0')} ET`
    : `every ${minuteInterval} min`;
  console.log(`[sync-cron-schedule] updating ${jobType} (jobId=${jobId}) → ${logDesc}`);

  try {
    const resp = await fetch(`https://api.cron-job.org/jobs/${encodeURIComponent(jobId)}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(payload),
    });

    const respText = await resp.text();
    let respData;
    try { respData = JSON.parse(respText); } catch { respData = { raw: respText }; }

    if (!resp.ok) {
      console.warn(`[sync-cron-schedule] cron-job.org returned ${resp.status}: ${respText.slice(0, 500)}`);
      return res.status(502).json({
        error: `cron-job.org returned HTTP ${resp.status}`,
        details: respData,
        hint: resp.status === 401 ? 'Check CRONJOB_API_KEY' :
              resp.status === 404 ? `Check ${jobIdEnvVar} — job may not exist` : undefined,
      });
    }

    console.log(`[sync-cron-schedule] success for ${jobType}`);
    return res.json({
      success: true,
      jobType,
      schedule: scheduleShape === 'weekly'
        ? { day, hour, minute, timezone: 'America/New_York' }
        : { minuteInterval, timezone: 'America/New_York' },
    });
  } catch (err) {
    console.error(`[sync-cron-schedule] fetch error: ${err.message}`);
    return res.status(500).json({
      error: `Failed to reach cron-job.org: ${err.message}`,
    });
  }
}


// ── Action: resync-legacy-tournaments ───────────────────────────────────────
//
// Repairs the divergence between `/tournaments/{name}` (canonical, read by
// the app via useLeague) and `/sfgl_data/fantasy-golf-tournaments` (legacy
// doc, read by cron and various other code paths).
//
// The divergence arises because the result-processing cron writes ONLY to
// the legacy doc, while client-side updates (e.g., schedule edits, Undo)
// write to the canonical collection. So after a bad cron fire — or after
// an Undo — the two stores can disagree about which tournament is playing
// vs. completed.
//
// What this action does:
//   1. Read the legacy doc's array (preserves array order, which is
//      semantically meaningful — `tournamentIndex` references position).
//   2. Read all docs from the canonical `/tournaments` collection.
//   3. For each legacy entry, replace its mutable fields (completed,
//      playing, results, plus any other fields the canonical has) with the
//      canonical version. Legacy-only fields (none expected, but defensive)
//      survive.
//   4. Write the merged array back to the legacy doc.
//
// Idempotent: safe to call any number of times. Called automatically by
// Undo and the result-processing handler going forward to keep the stores
// in sync; also exposed as a standalone action so the commish can fix the
// current bad state.
async function handleResyncLegacyTournaments(res) {
  console.log('[resync-legacy] handler invoked');

  // Read current legacy doc to preserve array order
  const legacySnap = await db.collection('sfgl_data').doc('fantasy-golf-tournaments').get();
  if (!legacySnap.exists) {
    console.warn('[resync-legacy] legacy doc does not exist; nothing to resync');
    return res.status(404).json({ error: 'Legacy tournament doc not found' });
  }
  const legacyArray = Array.isArray(legacySnap.data().value) ? legacySnap.data().value : [];
  console.log(`[resync-legacy] legacy array has ${legacyArray.length} tournaments`);

  // Read all canonical /tournaments docs into a name-keyed map
  const canonicalSnap = await db.collection('tournaments').get();
  const canonicalMap = {};
  canonicalSnap.docs.forEach(d => {
    const data = d.data();
    const name = data.name || d.id;
    canonicalMap[name] = { ...data, name };
  });
  console.log(`[resync-legacy] canonical map has ${Object.keys(canonicalMap).length} tournaments`);

  // Merge: each legacy entry replaced with canonical version (same array
  // position). Legacy entries without a canonical match are left as-is —
  // shouldn't happen in normal operation but defensive against drift.
  let updated = 0;
  let missing = 0;
  const merged = legacyArray.map(t => {
    const canonical = canonicalMap[t.name];
    if (!canonical) {
      missing++;
      console.warn(`[resync-legacy] no canonical doc for "${t.name}" — leaving as-is`);
      return t;
    }
    updated++;
    // Canonical fields take precedence. Spread legacy first, then canonical
    // overrides — this preserves any legacy-only fields if they exist.
    return { ...t, ...canonical };
  });

  // Write back
  await db.collection('sfgl_data').doc('fantasy-golf-tournaments').set({
    key: 'fantasy-golf-tournaments',
    value: merged,
  });

  console.log(`[resync-legacy] complete: ${updated} updated, ${missing} missing canonical`);
  return res.json({
    success: true,
    updated,
    missingCanonical: missing,
    total: merged.length,
  });
}


export default async function handler(req, res) {
  // Auth check
  const cronSecret = process.env.CRON_SECRET;
  const action = req.query.action || '';

  // Cron actions require auth. Client-callable actions are exempted:
  //   - notify-results:      triggered from AdminView after processing
  //   - pgat-stats:          triggered from AdminView's Sync button
  //   - sync-cron-schedule:  triggered from AdminView's schedule save buttons.
  //                          API key stays server-side (env var) so no secret
  //                          is exposed by no-auth; worst case is a stranger
  //                          who guesses the endpoint changes when waivers
  //                          process — visible immediately to the commish.
  const NO_AUTH_ACTIONS = new Set(['notify-results', 'pgat-stats', 'sync-cron-schedule', 'resync-legacy-tournaments']);
  if (!NO_AUTH_ACTIONS.has(action) && cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    switch (action) {
      case 'waivers':                     return await handleWaivers(res);
      case 'lineup-reminder':             return await handleLineupReminder(res);
      case 'process-results':             return await handleProcessResults(res);
      case 'notify-results':              return await handleNotifyResults(req, res);
      case 'pgat-stats':                  return await handlePgatStats(res);
      case 'lead-watch':                  return await handleLeadWatch(res);
      case 'owgr-rankings':               return await handleOwgrRankings(res);
      case 'sync-cron-schedule':          return await handleSyncCronSchedule(req, res);
      case 'resync-legacy-tournaments':   return await handleResyncLegacyTournaments(res);
      default:                            return res.status(400).json({ error: 'Unknown action. Use ?action=waivers|lineup-reminder|process-results|notify-results|pgat-stats|lead-watch|owgr-rankings|sync-cron-schedule|resync-legacy-tournaments' });
    }
  } catch (err) {
    console.error(`[cron] ${action} error:`, err);
    return res.status(500).json({ error: err.message });
  }
}
