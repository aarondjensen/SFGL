// api/cron.js — single consolidated endpoint for all cron/email operations
// Routes via ?action= query parameter:
//   ?action=waivers          — auto-process pending waivers
//   ?action=lineup-reminder  — send lineup reminders to managers without lineups
//   ?action=notify-results   — send tournament results emails (POST with body)
//   ?action=name-audit       — cross-reference league names against data sources
//
// This consolidates what would be 5 separate functions into 1 to stay under
// Vercel Hobby plan's 12 serverless function limit.

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { getAuth } from 'firebase-admin/auth';
import { isEventEnabled, dedupeTokenDocs, extractNextData } from './_constants.js';
import { NameSet, namesMatch, auditNames, suggestMatches, SUSPECTED_MISMATCH_SCORE } from './_playerNames.js';
import {
  SEASON, getETNow, abbreviateName, waiverCutoff, getTournamentLockHourET, getTeeTimeLockMs,
  isTournamentWeekOver, tournamentWeekEnd,
} from './_league.js';
import { scoringStarters, lineupFor, cutRuleForfeit, eligibleStarters } from './_rules.js';
import {
  getSegmentForTournament, computeSwingAward, buildEffectiveRoster,
  getSeasonEarningsByTeam, bonusesFor,
} from './_rules.js';

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
//   • the team's pref for this event resolves to false on the push channel →
//     silent skip (see isEventEnabled for the three stored pref shapes)
//   • no subscribed devices → silent skip
//
// Returns { sent, failed, skipped, cleanedUp } per push attempt.

// isEventEnabled (and the DEFAULTS_ON set behind it) lives in ./_constants.js,
// shared with api/push.js, so both senders resolve preferences identically.

async function sendPushToTeam({ teamId, event, title, body, deepLink }) {
  if (!teamId || !event) return { sent: 0, failed: 0, skipped: 1, cleanedUp: 0 };

  // Check this team's per-event prefs. Missing prefs map → defaults apply.
  // Missing event key inside prefs → defaults apply.
  try {
    const teamSnap = await db.collection('teams').doc(teamId).get();
    if (!teamSnap.exists) return { sent: 0, failed: 0, skipped: 1, cleanedUp: 0 };
    const prefs = teamSnap.data()?.notificationPrefs;
    // isEventEnabled understands all three stored shapes — { push, email }
    // object, legacy bare boolean, and unset (→ DEFAULTS_ON). Testing for a
    // bare boolean here directly, as this used to, treated an object-shaped
    // opt-out as "no preference" and sent anyway.
    if (!isEventEnabled(prefs, event, 'push')) {
      return { sent: 0, failed: 0, skipped: 1, cleanedUp: 0 };
    }
  } catch (err) {
    console.warn(`[push] prefs check failed for team ${teamId}:`, err.message);
    // Fail safe: don't send if we couldn't verify prefs
    return { sent: 0, failed: 0, skipped: 1, cleanedUp: 0 };
  }

  // Fetch tokens for this team
  let tokenDocs;
  try {
    const tokSnap = await db.collection('pushTokens').where('teamId', '==', teamId).get();
    tokenDocs = tokSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.warn(`[push] token fetch failed for team ${teamId}:`, err.message);
    return { sent: 0, failed: 0, skipped: 1, cleanedUp: 0 };
  }
  if (tokenDocs.length === 0) return { sent: 0, failed: 0, skipped: 1, cleanedUp: 0 };

  // Collapse to one delivery per physical device. Without this, a device with a
  // lingering rotated-token doc receives this push twice (the round-leader
  // double-fire). Dedup logic lives in _constants.js (shared with api/push.js).
  tokenDocs = dedupeTokenDocs(tokenDocs);

  // Send to each token in parallel
  let sent = 0;
  let failed = 0;
  const invalidTokens = [];

  await Promise.all(tokenDocs.map(async (tokDoc) => {
    const message = {
      token: tokDoc.token || tokDoc.id,
      notification: { title, body },
      data: {
        eventType: String(event),
        deepLink:  String(deepLink || '#standings'),
      },
      webpush: {
        notification: {
          icon: '/web-app-manifest-192x192.png',
          badge: '/web-app-manifest-192x192.png',
        },
        fcmOptions: {
          link: deepLink
            ? `https://sfglgolf.com/${deepLink.startsWith('#') ? deepLink : '#' + deepLink}`
            : 'https://sfglgolf.com/',
        },
      },
    };
    try {
      await messaging.send(message);
      sent++;
    } catch (err) {
      failed++;
      const code = err.errorInfo?.code || err.code || '';
      if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token')) {
        invalidTokens.push(tokDoc.id);
      } else {
        console.warn(`[push] send failed (${code}):`, err.message);
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
    } catch (err) {
      console.warn('[push] dead-token cleanup failed:', err.message);
    }
  }

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

// HTML-escape every value that reaches an email body. Most of these strings
// are league data (team/player/tournament names), but handleNotifyResults
// builds its email entirely from a client-supplied POST body — so an
// unescaped interpolation is an HTML-injection sink in mail sent from the
// league's own domain. Mirrors escapeHtml() in api/log-error.js.
// Non-strings (numbers from toLocaleString, etc.) pass through via String().
function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// All email styling uses Raleway with Arial fallback. Most email clients load
// the Google Font link below (Gmail web, Apple Mail, Outlook web); the rest
// fall back to Arial which has nearly identical metrics for our purposes.
// Palette: navy backgrounds + white text, with gold reserved for the SFGL
// logo and final-podium accents only. Matches the in-app theme.
const FONT_STACK = `'Raleway','Helvetica Neue',Arial,sans-serif`;
const FONT_LINK  = `<link href="https://fonts.googleapis.com/css2?family=Raleway:wght@300;400;600;700&display=swap" rel="stylesheet">`;

const HEADER = `<div style="background:#0a1628;padding:22px 24px 18px;border-bottom:1px solid rgba(245,197,24,0.35);"><h1 style="font-family:${FONT_STACK};font-size:24px;font-weight:600;color:#ffffff;margin:0;letter-spacing:6px;">SFGL</h1><p style="font-family:${FONT_STACK};font-size:10px;color:rgba(255,255,255,0.45);margin:4px 0 0;letter-spacing:3px;text-transform:uppercase;font-weight:400;">${SEASON} Season</p></div>`;
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
    return `<div style="background:${bg};border:1px solid rgba(255,255,255,0.06);border-radius:3px;padding:10px 14px;margin-bottom:6px;${isMe ? 'border-left:3px solid #ffffff;' : ''}font-family:${FONT_STACK};"><div style="font-size:13px;font-weight:600;color:${isMe ? '#ffffff' : 'rgba(255,255,255,0.85)'};">${esc(w.team)}<span style="float:right;font-size:11px;font-weight:600;color:${accent};">${icon} ${label}</span></div><div style="font-size:12px;margin-top:4px;font-weight:400;"><span style="color:#50b478;">+ ${esc(w.player)}</span>${w.droppedPlayer ? `<span style="color:rgba(255,255,255,0.35);"> → </span><span style="color:#cc5555;">- ${esc(w.droppedPlayer)}</span>` : ''}</div>${w.failReason ? `<div style="font-size:10px;color:rgba(255,255,255,0.45);margin-top:4px;font-weight:300;">${esc(w.failReason)}</div>` : ''}</div>`;
  }).join('');
  return wrap(`<h2 style="font-family:${FONT_STACK};font-size:18px;font-weight:600;color:#ffffff;margin:0 0 4px;letter-spacing:0.5px;">⏰ Waiver Results</h2><p style="font-family:${FONT_STACK};font-size:10px;color:rgba(255,255,255,0.5);margin:0 0 18px;letter-spacing:2.5px;text-transform:uppercase;font-weight:400;">Processed ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</p>${rows}`);
}

// ── Segment + swing helpers (server-side, mirror AdminView client-side) ──

// Resolve a tournament's segment. Prefer the explicit segment field, then the
// legacy `swing` field, then date-derived inference.
//
// Segment, fee, pot and swing-award all come from ./_rules.js now. This file
// used to define getSegmentForTournamentServer, getTransactionFeeServer,
// computeSwingPotServer and maybeAutoAwardSwingServer, each under a
// "⚠ KEEP IN SYNC with src/utils/..." comment. Every one of them had drifted
// from the client at some point — wrong month→swing mapping, alternates
// counted in the pot, a different roster-replay order — and each drift showed
// up as the cron quietly disagreeing with what managers saw on screen.

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

  const standingsCard = standingsList.length ? `<div style="margin:0 0 18px;">
    <div style="font-family:${FONT_STACK};font-size:10px;color:rgba(255,255,255,0.5);letter-spacing:2.5px;text-transform:uppercase;font-weight:600;margin:0 0 10px;">📊 Season Standings</div>
    ${standingsList.map((s, i) => {
      const isMe = s.team === recipientTeam;
      const isFirst = i === 0;
      const rankColor = isFirst ? '#f5c518' : 'rgba(255,255,255,0.4)';
      const teamColor = isMe ? '#ffffff' : 'rgba(255,255,255,0.85)';
      const bg = isMe ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.02)';
      const leftBorder = isMe ? 'border-left:3px solid #ffffff;' : isFirst ? 'border-left:3px solid rgba(245,197,24,0.55);' : '';
      const delta = thisWeekByTeam[s.team] || 0;
      const deltaText = delta > 0
        ? `<span style="font-family:${FONT_STACK};font-size:11px;color:rgba(80,180,120,0.85);font-weight:500;margin-left:6px;">+$${delta.toLocaleString()}</span>`
        : '';
      // Identical card layout to the per-tournament rows below (padding, bg,
      // border-radius, left-border, 14px type) so the two sections read as
      // one visual system. No player breakdown sub-table here — the season
      // card stays a clean leaderboard; the inline "+$X" shows this week's
      // delta alongside each team's season total.
      return `<div style="padding:12px 14px;background:${bg};border-radius:3px;margin-bottom:6px;${leftBorder}"><table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr><td width="22" style="font-family:${FONT_STACK};font-size:14px;font-weight:700;color:${rankColor};vertical-align:middle;">${i + 1}</td><td style="font-family:${FONT_STACK};font-size:14px;font-weight:${isMe ? '700' : '600'};color:${teamColor};vertical-align:middle;">${esc(s.team)}${deltaText}</td><td style="font-family:${FONT_STACK};font-size:14px;font-weight:600;color:#50b478;text-align:right;vertical-align:middle;">$${(s.totalEarnings || 0).toLocaleString()}</td></tr></table></div>`;
    }).join('')}
  </div>` : '';

  // ── Swing winner banner (optional) ──
  // When this tournament was the final event of a swing AND a swing winner
  // was auto-awarded, the caller passes swingWinnerInfo so we render a
  // celebratory banner above the tournament results. Same color logic as
  // the in-app StandingsView swing card (gold accent for the winner).
  const swingBanner = swingWinnerInfo ? `<div style="padding:18px 16px;background:linear-gradient(180deg,rgba(245,197,24,0.12),rgba(245,197,24,0.04));border:1px solid rgba(245,197,24,0.35);border-radius:4px;margin:0 0 22px;text-align:center;"><div style="font-family:${FONT_STACK};font-size:10px;color:rgba(245,197,24,0.85);letter-spacing:2.5px;text-transform:uppercase;font-weight:600;margin:0 0 6px;">🏆 ${esc(swingWinnerInfo.segment || 'Swing')} Complete</div><div style="font-family:${FONT_STACK};font-size:18px;color:#ffffff;font-weight:600;margin:0 0 4px;">${esc(swingWinnerInfo.team)}</div><div style="font-family:${FONT_STACK};font-size:13px;color:rgba(255,255,255,0.7);font-weight:400;">wins the $${(swingWinnerInfo.pot || 0).toLocaleString()} pot</div></div>` : '';

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
      const roundBadges = rounds.length ? rounds.map(rl => `<span style="display:inline-block;padding:1px 5px;margin-left:4px;background:rgba(220,110,30,0.35);color:rgba(255,165,80,0.95);border-radius:2px;font-size:9px;font-weight:600;font-family:${FONT_STACK};vertical-align:middle;letter-spacing:0.5px;">R${esc(rl.round || rl)}</span>`).join('') : '';

      return `<tr><td style="font-family:${FONT_STACK};font-size:11px;color:${nameColor};padding:2px 0;font-weight:400;">${esc(p.name)}${roundBadges}</td><td style="font-family:${FONT_STACK};font-size:11px;color:${totalEarnings > 0 ? '#50b478' : 'rgba(255,255,255,0.35)'};padding:2px 0;text-align:right;font-weight:500;">$${totalEarnings.toLocaleString()}</td></tr>`;
    }).join('');

    return `<div style="padding:12px 14px;background:${bg};border-radius:3px;margin-bottom:6px;${leftBorder}"><table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr><td width="22" style="font-family:${FONT_STACK};font-size:14px;font-weight:700;color:${rankColor};vertical-align:middle;">${i + 1}</td><td style="font-family:${FONT_STACK};font-size:14px;font-weight:${isMe ? '700' : '600'};color:${teamColor};vertical-align:middle;">${esc(tr.team)}</td><td style="font-family:${FONT_STACK};font-size:14px;font-weight:600;color:#50b478;text-align:right;vertical-align:middle;">$${(tr.totalEarnings || 0).toLocaleString()}</td></tr></table>${playerRows ? `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.08);">${playerRows}</table>` : ''}</div>`;
  }).join('') : `<div style="font-family:${FONT_STACK};font-size:13px;color:rgba(255,255,255,0.5);padding:24px;text-align:center;background:rgba(255,255,255,0.03);border-radius:3px;font-weight:400;">Team results unavailable for this email. Check the app for the latest standings.</div>`;

  // ── Color-coded player legend ──
  // Subtle footer to explain the name colors — same palette as RostersView
  // / TournamentsView so the visual language is consistent across the app
  // and the email. Only renders if at least one team has player breakdowns.
  const hasPlayerData = sorted.some(tr => Array.isArray(tr.players) && tr.players.length > 0);
  const legend = hasPlayerData ? `<div style="margin:14px 0 0;padding:10px 12px;background:rgba(255,255,255,0.02);border-radius:3px;font-family:${FONT_STACK};font-size:10px;color:rgba(255,255,255,0.5);letter-spacing:0.4px;font-weight:400;text-align:center;"><span style="color:rgba(245,197,24,0.95);font-weight:600;">●</span> Limited &nbsp;&nbsp;<span style="color:rgba(100,180,255,0.95);font-weight:600;">●</span> Unlimited &nbsp;&nbsp;<span style="display:inline-block;padding:1px 5px;background:rgba(220,110,30,0.35);color:rgba(255,165,80,0.95);border-radius:2px;font-size:9px;font-weight:600;letter-spacing:0.5px;">R#</span> Round Leader</div>` : '';

  return wrap(`<h2 style="font-family:${FONT_STACK};font-size:20px;font-weight:600;color:#ffffff;margin:0 0 4px;letter-spacing:0.5px;">🏆 ${esc(tournamentName)}</h2><p style="font-family:${FONT_STACK};font-size:10px;color:rgba(255,255,255,0.5);margin:0 0 18px;letter-spacing:2.5px;text-transform:uppercase;font-weight:400;">Tournament Results</p>${standingsCard}${swingBanner}${tournamentHeader}${rows}${legend}`);
}

function buildLineupReminderEmail(tournamentName, lockTime, _recipientTeam) {
  return wrap(`<h2 style="font-family:${FONT_STACK};font-size:18px;font-weight:600;color:#ffffff;margin:0 0 4px;letter-spacing:0.5px;">⛳ Lineups Lock Tomorrow</h2><p style="font-family:${FONT_STACK};font-size:13px;color:rgba(255,255,255,0.85);margin:0 0 8px;font-weight:500;">${esc(tournamentName)}</p><p style="font-family:${FONT_STACK};font-size:12px;color:rgba(255,255,255,0.55);margin:0 0 20px;font-weight:400;">Lineups lock <strong style="color:#ffffff;font-weight:600;">Thursday at ${esc(lockTime)} ET</strong>. Make sure your lineup is set!</p><a href="https://sfglgolf.com" style="display:inline-block;padding:10px 24px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.3);border-radius:4px;color:#ffffff;text-decoration:none;font-weight:600;font-size:13px;font-family:${FONT_STACK};letter-spacing:0.5px;">Set Lineup →</a>`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// Single source of truth for tournaments: the same `tournaments` collection the
// client reads via tournamentsApi.getAll() → _getAllOrdered('tournaments',
// 'start_date'). Previously cron read/wrote a separate sfgl_data/
// fantasy-golf-tournaments array doc that the client had already migrated off
// of, so cron-processed results were invisible to the app and cron's reads saw
// stale/empty data. Reading the collection here (ordered by start_date, exactly
// like the client) keeps both sides on one source. Ordering matters: array
// position is used for next-event progression in handleProcessResults, so it
// must match the client's ordering.
/**
 * Store the tournament's real first tee time so isTournamentLocked can lock on
 * it instead of on a timezone-derived hour.
 *
 * Two rules make this safe, and both matter:
 *
 *   1. ONLY ACCEPT A FUTURE TIME. /api/field's per-player disambiguation tracks
 *      each player's NEXT tee, so once round 1 is under way the earliest value
 *      in that payload becomes an afternoon R1 time and then a Friday R2 time.
 *      Capturing one of those would push the lock forward and RE-OPEN a
 *      tournament that had already locked.
 *
 *   2. FREEZE ONCE IT PASSES. After the stored instant has gone by, the lock
 *      has fired and the value is history. Nothing may move it — not a weather
 *      delay, not a re-publish. Before it passes it may still be updated, which
 *      is what lets a Wednesday-night tee-sheet change be picked up.
 *
 * Returns the ISO it stored, or null when it left things alone.
 */
async function captureFirstTeeTime(tournament, fieldData) {
  if (!tournament?.name) return null;

  const iso = fieldData?.firstTeeTimeISO;
  if (typeof iso !== 'string' || !iso) return null;
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;

  const now = Date.now();
  if (ms <= now) return null;                       // rule 1

  const stored = tournament.firstTeeTimeISO;
  if (typeof stored === 'string' && stored) {
    if (stored === iso) return null;                // unchanged
    const storedMs = new Date(stored).getTime();
    if (!Number.isNaN(storedMs) && storedMs <= now) return null;   // rule 2
  }

  await db.collection('tournaments').doc(tournament.name).update({ firstTeeTimeISO: iso });
  tournament.firstTeeTimeISO = iso;                 // keep this run consistent
  return iso;
}

/**
 * Try to capture the active tournament's first tee time. Safe to call on every
 * field-check ping — it short-circuits before spending a fetch once there is
 * nothing left to do.
 *
 * Deliberately independent of the field-check notification gates: the lineup
 * lock must not depend on whether alerts are enabled or on what day they fire.
 * Returns a small status object for the handler's response, and never throws —
 * a capture problem must not break the notification this handler exists for.
 */
async function tryCaptureFirstTeeTime() {
  try {
    const tournaments = await loadTournaments();
    const tournament = tournaments?.find(t => t.playing && !t.completed);
    if (!tournament) return { status: 'no_tournament' };

    // Frozen: the stored instant has passed, so the lock has already fired and
    // nothing may move it. Bail before the fetch — this is the steady state for
    // most of the week.
    const stored = tournament.firstTeeTimeISO;
    if (typeof stored === 'string' && stored) {
      const ms = new Date(stored).getTime();
      if (!Number.isNaN(ms) && ms <= Date.now()) {
        return { status: 'frozen', firstTeeTimeISO: stored };
      }
    }

    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'https://www.sfglgolf.com';

    // No cache-bust here, unlike the field-membership fetch below. Tee times
    // are not second-sensitive and this runs on every ping, so the CDN copy
    // (s-maxage=300) is exactly what we want rather than hammering pgatour.com.
    const resp = await fetch(`${baseUrl}/api/field`);
    if (!resp.ok) return { status: `field_http_${resp.status}` };
    const fieldData = await resp.json();

    const captured = await captureFirstTeeTime(tournament, fieldData);
    return captured
      ? { status: 'captured', firstTeeTimeISO: captured }
      : { status: 'unchanged', firstTeeTimeISO: tournament.firstTeeTimeISO || null };
  } catch (err) {
    console.error('[field-check] first tee capture failed:', err.message);
    return { status: 'error', error: err.message };
  }
}

/**
 * Freeze each team's lineup at lock, so results are scored against what was
 * actually started rather than whatever is current when processing runs.
 *
 * The bug this closes: lineup editing re-opens Sunday 9pm ET
 * (isLineupEditingOpen) and results process Monday 9am ET by default. In that
 * window a manager sets NEXT week's lineup — and processTournamentData reads
 * team.lineup, the live one, so the finished tournament gets scored with it.
 * Confirmed against the 2026 season: three team-events were scored on the wrong
 * five, worth $1.1M, each time substituting a different player from the same
 * roster.
 *
 * Written once and never overwritten: after lock the lineup is history.
 * Only fires when the tee-time lock instant is known; without one this does
 * nothing and processing behaves exactly as it did before.
 */
async function trySnapshotLineups() {
  try {
    const tournaments = await loadTournaments();
    const tournament = tournaments?.find(t => t.playing && !t.completed);
    if (!tournament) return { status: 'no_tournament' };
    if (tournament.lockedLineups && Object.keys(tournament.lockedLineups).length) {
      return { status: 'already_frozen' };
    }

    const lockMs = getTeeTimeLockMs(tournament);
    if (lockMs === null) return { status: 'no_lock_instant' };
    if (Date.now() < lockMs) return { status: 'not_locked_yet' };

    const teams = await loadTeams();
    const lockedLineups = {};
    (teams || []).forEach(t => {
      if (t?.id && Array.isArray(t.lineup) && t.lineup.length) lockedLineups[t.id] = [...t.lineup];
    });
    if (!Object.keys(lockedLineups).length) return { status: 'no_lineups' };

    await db.collection('tournaments').doc(tournament.name).update({ lockedLineups });
    return { status: 'frozen', teams: Object.keys(lockedLineups).length };
  } catch (err) {
    console.error('[field-check] lineup snapshot failed:', err.message);
    return { status: 'error', error: err.message };
  }
}

async function loadTournaments() {
  // Unordered fetch + JS sort by start_date. NOT orderBy('start_date'): that
  // silently drops any doc missing the field, which made this return an EMPTY
  // collection (docs had no start_date) so cron processed nothing. start_date is
  // ordering-only; a doc missing it sorts last (visible), never dropped. Must
  // match the client's ordering (firebase.js _byStartDate) since array position
  // drives next-event progression in handleProcessResults.
  const snap = await db.collection('tournaments').get();
  const byStartDate = (a, b) => {
    const sa = a.start_date || '', sb = b.start_date || '';
    if (sa && sb) return sa < sb ? -1 : sa > sb ? 1 : (a.name || '').localeCompare(b.name || '');
    if (sa) return -1;
    if (sb) return 1;
    return (a.name || '').localeCompare(b.name || '');
  };
  return snap.docs.map(d => ({ _id: d.id, ...d.data() })).sort(byStartDate);
}

async function loadClaims() {
  const snap = await db.collection('team_claims').get();
  const m = {};
  snap.docs.forEach(d => { m[d.id] = d.data(); });
  return m;
}

// Recipient resolution for league emails. A manager's self-set results-email
// (team_claims/{teamId}.notifyEmail) takes precedence over the legacy
// commish-entered settings.managerEmails map; both are keyed per team.
async function getEmailMap(settings, teams) {
  const emailMap = settings.managerEmails || {};
  const claims = await loadClaims();
  const result = {};
  teams.forEach(t => {
    const email = claims[t.id]?.notifyEmail || emailMap[t.id] || emailMap[t.name];
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
  const { day: wDay, hour: wHour, minute: wMin } = waiverCutoff(settings);
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

  // Load teams + tournaments (tournaments needed to derive current
  // earnings for the waiver tie-breaker).
  let teams = await loadTeams();
  const tournamentsForWaivers = await loadTournaments();

  // Derive each team's current season earnings from tournament.results so
  // waiver priority isn't affected by drift in the stored team.earnings
  // field. Mirrors the client-side fix in handleProcessAll.
  const derivedEarnings = getSeasonEarningsByTeam(tournamentsForWaivers);
  const em = {}; teams.forEach(t => { em[t.name] = derivedEarnings[t.id] || 0; });
  const pm = {}; [...teams].sort((a, b) => (derivedEarnings[a.id] || 0) - (derivedEarnings[b.id] || 0)).forEach((t, i) => { pm[t.name] = i; });
  let nextLastPlace = teams.length;

  const byTeam = {};
  pending.forEach(w => { if (!byTeam[w.team]) byTeam[w.team] = []; byTeam[w.team].push(w); });
  Object.values(byTeam).forEach(c => c.sort((a, b) => (a.priority || 999) - (b.priority || 999)));

  // "Already rostered" must be judged against each team's EFFECTIVE roster —
  // the stored base roster with every processed/completed add & drop replayed on
  // top — NOT the raw stored `team.roster` array. The stored array can lag the
  // effective roster (e.g. a player netted out by a processed drop that never
  // got written back into the array), and when it does, a genuine free agent
  // gets wrongly failed as "already rostered." That is exactly the bug that
  // blocked a valid Denny McCarthy claim while he showed as available everywhere
  // else. This mirrors the client's useRoster hook / AddDropPlayerModal
  // availability logic and the manual handleProcessAll() path (buildRoster), so
  // the auto-processor can never disagree with what managers see on-screen.
  //
  // Shared with the client: buildEffectiveRoster in ./_rules.js is the same
  // function the roster page, the add/drop modal and the commish's manual
  // waiver panel run. This used to be an inline copy under a KEEP IN SYNC
  // comment, and it had already drifted on ordering — the tiebreaker that stops
  // a same-week add-then-flip leaving BOTH players on the roster was fixed on
  // the client first.
  const allRostered = new Set();
  teams.forEach(t => buildEffectiveRoster(t, allTx, { tournaments: tournamentsForWaivers })
    .forEach(n => allRostered.add(n)));

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

  // Durable player attributes for the auto-processor — mirrors the client's
  // buildPlayerAttributeIndex / hydratePlayer in sharedHelpers (api/ can't import
  // from src/). A claimed LIMITED player must keep limited status, stars, years
  // of service, and accumulated SFGL data — never come back as unlimited.
  const registryDoc = await (async () => {
    try {
      const snap = await db.collection('sfgl_data').doc('player-registry').get();
      return snap.exists ? (snap.data().value || {}) : {};
    } catch (e) { console.warn('[cron] registry load skipped:', e); return {}; }
  })();
  const attrIndex = (() => {
    const idx = {};
    const upsert = (name, a = {}) => {
      if (!name) return;
      const cur = idx[name] || {};
      const limited = !!(cur.limited || a.limited);
      idx[name] = {
        ...cur, ...a, limited,
        unlimited: limited ? false : !!(a.unlimited ?? cur.unlimited),
        stars:           Math.max(cur.stars ?? 0, a.stars ?? 0),
        yearsOfService:  Math.max(cur.yearsOfService ?? 0, a.yearsOfService ?? 0),
        starts:          Math.max(cur.starts ?? 0, a.starts ?? 0),
        eventsPlayed:    Math.max(cur.eventsPlayed ?? 0, a.eventsPlayed ?? 0),
        cutsMade:        Math.max(cur.cutsMade ?? 0, a.cutsMade ?? 0),
        pgaTourEarnings: Math.max(cur.pgaTourEarnings ?? 0, a.pgaTourEarnings ?? 0),
        sfglEarnings:    Math.max(cur.sfglEarnings ?? 0, a.sfglEarnings ?? 0),
        headshot: a.headshot || cur.headshot || '',
      };
    };
    teams.forEach(t => (t.roster || []).forEach(p => upsert(p.name, p)));
    (tournamentsForWaivers || []).forEach(t => {
      const tr = t?.results?.teams;
      if (!tr) return;
      Object.values(tr).forEach(res => (res.players || []).forEach(pl => upsert(pl.name || pl, { limited: !!pl.limited })));
    });
    // Durable registry (sfgl_data/player-registry) — recovers attributes for a
    // player who has vanished from every current roster and from results.
    Object.entries(registryDoc || {}).forEach(([name, a]) => upsert(name, a));
    return idx;
  })();
  const hydrate = (name) => {
    const a = attrIndex[name] || {};
    const limited = !!a.limited;
    return {
      name, limited,
      unlimited: limited ? false : !!a.unlimited,
      stars: a.stars ?? 0, yearsOfService: a.yearsOfService ?? 1,
      starts: a.starts ?? 0, eventsPlayed: a.eventsPlayed ?? 0, cutsMade: a.cutsMade ?? 0,
      pgaTourEarnings: a.pgaTourEarnings ?? 0, sfglEarnings: a.sfglEarnings ?? 0,
      headshot: a.headshot || '',
    };
  };

  for (const w of applied) {
    const team = teams.find(t => t.name === w.team);
    if (!team) continue;
    let roster = [...(team.roster || [])];
    if (w.droppedPlayer) roster = roster.filter(p => p.name !== w.droppedPlayer);
    if (!roster.some(p => p.name === w.player)) {
      roster.push(hydrate(w.player));
    }
    // Fee was already charged at submission (AddDropPlayerModal). Processing
    // only applies the roster move — mirrors the manual path's applyWaiver(),
    // which never re-touches transactionFees. Re-adding here double-charged the
    // (currently display-unused) field on the auto path only.
    batch.update(db.collection('teams').doc(team.id), { roster });
  }

  batch.set(db.collection('sfgl_data').doc('last_auto_waiver'), { key: 'last_auto_waiver', value: today });
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

  if (claimsWonCount > 0) {
    const body = claimsWonCount === 1
      ? '1 claim this week'
      : `${claimsWonCount} claims this week`;
    for (const team of teams) {
      if (!team?.id) continue;
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
        console.warn(`[push] waivers failed for ${team.name}:`, err.message);
      }
    }
  }

  // Send emails
  const managerEmails = await getEmailMap(settings, teams);
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
    pushesSent: pushResults.reduce((sum, p) => sum + (p.sent || 0), 0),
    details: processedResults.map(r => ({ team: r.team, player: r.player, status: r.status, failReason: r.failReason })),
  });
}

// ── Action: lineup reminder ─────────────────────────────────────────────────

async function handleLineupReminder(res) {
  const et = getETNow();
  const settings = await loadSettings();

  // Admin-configurable day/hour gate (Wave J Round 6 batch 4 follow-up).
  // Was hardcoded to "any Wednesday ping" (et.getDay() !== 3 → not_wednesday)
  // with no hour gate; now mirrors the waivers + results pattern with
  // settings-driven day + hour + minute.
  //
  // Default: Wednesday 9am ET. Backward-compatible — older Firestore docs
  // without these keys fall through to the defaults.
  const targetDay    = settings?.lineupReminderDay    ?? 3;  // Wed
  const targetHour   = settings?.lineupReminderHour   ?? 9;  // 9am ET
  const targetMinute = settings?.lineupReminderMinute ?? 0;

  if (et.getDay() !== targetDay) {
    return res.json({ status: 'not_target_day', targetDay });
  }
  // Hour/minute gate — same pattern as waivers (handleWaivers L433-434).
  // If we're not past the configured time yet today, wait for a later ping.
  if (et.getHours() < targetHour || (et.getHours() === targetHour && et.getMinutes() < targetMinute)) {
    return res.json({ status: 'not_yet', targetHour, targetMinute });
  }

  const today = et.toLocaleDateString('en-US');
  const metaSnap = await db.collection('sfgl_data').doc('last_lineup_reminder').get();
  if (metaSnap.exists && metaSnap.data().value === today) return res.json({ status: 'already_sent' });

  const tournaments = await loadTournaments();
  const activeTourney = tournaments?.find(t => t.playing && !t.completed);
  if (!activeTourney) return res.json({ status: 'no_tournament' });

  // Was `activeTourney.lockHourET || 7` — a field name nothing has ever
  // written, so this always resolved to 7 and the reminder told managers the
  // wrong deadline for every non-ET event (9am at Pebble Beach, 12pm at Sony).
  // Now resolved through the same helpers isTournamentLocked uses, in the same
  // precedence, so the email and the actual lock cannot disagree.
  const teeLockMs = getTeeTimeLockMs(activeTourney);
  const lockTime = teeLockMs !== null
    ? new Date(teeLockMs).toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
      }).replace(' AM', 'am').replace(' PM', 'pm')
    : (() => {
        const h = getTournamentLockHourET(activeTourney);
        return h > 12 ? `${h - 12}pm` : h === 12 ? '12pm' : `${h}am`;
      })();

  const teams = await loadTeams();
  const managerEmails = await getEmailMap(settings, teams);
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
        title: '⛳ Lineup lock today',
        body: `Set your lineup for ${activeTourney.name} — locks at ${lockTime} ET.`,
        deepLink: '#rosters',
      });
      results.push({ team: team.name, pushSent: pushResult.sent });
    } catch (err) {
      console.warn(`[push] lineupLock failed for ${team.name}:`, err.message);
    }
    // Email — only if an email is on file
    if (!email) continue;
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
  const { tournamentName: rawName, teamResults, swingWinnerInfo, seasonStandings } = req.body || {};
  if (!rawName || !teamResults?.length) return res.status(400).json({ error: 'Missing tournamentName or teamResults' });

  // The whole email is built from this request body. The body itself is
  // HTML-escaped at render time (see esc()), but the subject line is a mail
  // HEADER — strip control characters so a newline can't inject additional
  // headers, and bound the length.
  const tournamentName = String(rawName)
    .split('').filter(ch => { const c = ch.charCodeAt(0); return c >= 32 && c !== 127; }).join('')
    .slice(0, 120).trim();
  if (!tournamentName) return res.status(400).json({ error: 'Invalid tournamentName' });

  const settings = await loadSettings();
  const teams = await loadTeams();
  const managerEmails = await getEmailMap(settings, teams);

  // Season standings: prefer client-supplied, else compute server-side so the
  // manual-process AND resend paths always include the standings card. Sums
  // each team's totalEarnings across completed tournaments — the same source
  // StandingsView and the auto-process email use.
  let standings = Array.isArray(seasonStandings) && seasonStandings.length ? seasonStandings : null;
  if (!standings) {
    const tournaments = await loadTournaments();
    const totals = getSeasonEarningsByTeam(tournaments);
    standings = teams
      .map(t => ({ team: t.name, totalEarnings: totals[t.id] || 0 }))
      .sort((a, b) => b.totalEarnings - a.totalEarnings);
  }

  const results = [];

  for (const [teamName, email] of Object.entries(managerEmails)) {
    try {
      await sendEmail(email, `🏆 ${tournamentName} — SFGL Results`, buildTournamentResultsEmail(tournamentName, teamResults, teamName, swingWinnerInfo, standings));
      results.push({ team: teamName, success: true });
    } catch (err) { results.push({ team: teamName, error: err.message }); }
  }

  return res.json({ status: 'sent', emailsSent: results.filter(r => r.success).length, results });
}

// ── Action: auto-process tournament results ─────────────────────────────────

// REMOVED: normalizeName — a local "strip accents + lowercase" normalizer.
// It did not handle hyphens, periods or "Last, First" order, so 'Si-Woo Kim'
// and 'Si Woo Kim' were different players as far as results processing was
// concerned. Its call sites now use matchName (below), which asks the right
// question — "same golfer?" rather than "same string?".

// Are these two strings the same golfer? Delegates to the shared module.
//
// The previous body compared normalized keys and then fell back to an
// any-order word-set match. That fallback treated 'Kim Si Woo' and 'Si Woo
// Kim' as one player (correct, and still handled) but ALSO could not see that
// 'Nico Echavarria' and 'Nicolas Echavarria' are one player — so a lineup
// holding one spelling scored $0 against an earnings map keyed with the other.
const matchName = namesMatch;

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
  const tournaments = await loadTournaments();
  const statsSnap = await db.collection('sfgl_data').doc('fantasy-golf-global-stats').get();
  const globalStats = statsSnap.exists ? statsSnap.data().value : {};

  // Find active tournament
  const ti = tournaments.findIndex(t => t.playing && !t.completed);
  if (ti === -1) {
    await db.collection('sfgl_data').doc('last_auto_results').set({ key: 'last_auto_results', value: today });
    return res.json({ status: 'no_active_tournament' });
  }
  const tournament = tournaments[ti];

  // ── Has this event actually been PLAYED? ──────────────────────────────────
  // `playing` means "the app's current event", not "the event that just
  // finished". The moment a tournament is marked complete — by this handler or
  // by the commish in AdminView — `playing` advances to the NEXT event, which
  // is usually still days away from teeing off. Everything below this point
  // treats the event it is handed as finished, so without this gate the cron
  // scores whatever happens to be next on the schedule.
  //
  // It did exactly that. St. Jude was completed by hand, `playing` moved to the
  // BMW Championship, and a later ping in the same day's retry window scored
  // the BMW three days before round 1 — pgatour.com's past-results page for an
  // unplayed event serves the PREVIOUS edition, so `players.length` cannot tell
  // the two apart. The event was marked complete, the Fall Finish pot was
  // auto-awarded, and every manager got a results email.
  //
  // This runs BEFORE the fetch: the results job pings every 30 minutes until
  // 10pm ET, and an event that hasn't been played costs no scrape.
  //
  // null = the event carries no date at all. That is "cannot tell", not "no",
  // so it falls through to the finality check on the fetched results below.
  const weekOver = isTournamentWeekOver(tournament, et);
  if (weekOver === false) {
    return res.json({
      status: 'not_finished',
      tournament: tournament.name,
      message: `${tournament.name} has not finished — its week ends `
        + `${tournamentWeekEnd(tournament)?.toDateString()}. Refusing to process.`,
    });
  }

  // Fetch results from ESPN via the existing pga-results API
  // Since we're server-side, call our own API endpoint
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'https://www.sfglgolf.com';
  const params = new URLSearchParams({ name: tournament.name, year: String(SEASON) });

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

  // ── Is the source saying these results are FINAL? ─────────────────────────
  // /api/pga-results has always returned a `status` block — the tournament and
  // round state it found in pgatour.com's page data — and its own comment says
  // "the result-processing guard uses this to refuse processing until the event
  // is officially complete". No such guard existed; the value was computed,
  // logged, returned and dropped. This is it.
  //
  // Deliberately narrow: only a status that is PRESENT and says "not final"
  // blocks. The HTML-table fallback reports no signal at all, and a page whose
  // status keys move would too — refusing on silence would wedge processing
  // for the season on an upstream markup change, which is a worse failure than
  // the one being prevented. The date gate above is the one that always holds.
  const finality = pgaData.status;
  if (finality?.sawAnyStatus && !finality.isFinal) {
    return res.json({
      status: 'not_final',
      tournament: tournament.name,
      signals: finality.raw?.slice(0, 8) || [],
      message: `${tournament.name} is not final per pgatour.com — will retry.`,
    });
  }
  // Undated event: the date gate could not answer, so the source's own word is
  // all there is. Require it to be an explicit "final" rather than assuming.
  if (weekOver === null && !finality?.isFinal) {
    return res.json({
      status: 'not_final',
      tournament: tournament.name,
      message: `${tournament.name} has no start date and pgatour.com does not `
        + `report it as final — refusing to process. Set its dates in Edit Schedule.`,
    });
  }

  const { players, roundLeaders: rl } = pgaData;

  // Build earnings map
  const earningsMap = {};
  players.forEach(p => { if (p.name && p.earnings >= 0) earningsMap[p.name] = p.earnings; });

  // Filter round leaders to only those in SFGL lineups
  // Two things this must not do, both of which it used to.
  //
  // lineupFor, not t.lineup. Scoring below reads lineupFor — the lineup frozen
  // at lock — so reading the live lineup here made the bonus filter and the
  // scorer disagree about who started. Lineup editing reopens Sunday 9pm ET and
  // results process Monday 9am ET, so by process time t.lineup can already hold
  // next week's five, and a leader would be dropped from a lineup he is
  // simultaneously being scored in.
  //
  // NameSet, not Set. A raw Set compares strings, and the results feed spells
  // Nordic and hyphenated names differently from the rosters — Set.has() is
  // precisely the comparison _playerNames.js exists to replace, and this file
  // already imports NameSet for other call sites.
  const startedPlayers = new NameSet(teams.flatMap(t => lineupFor(tournament, t) || []));
  const filterToStarted = (names) => {
    if (!names?.length) return [];
    return names.filter(n => startedPlayers.has(n));
  };
  const roundLeaders = {
    round1: filterToStarted(rl?.round1) || [],
    round2: filterToStarted(rl?.round2) || [],
    round3: filterToStarted(rl?.round3) || [],
  };
  // Unfiltered round leaders — the full list before restricting to started
  // players. Stored alongside roundLeaders so a mulligan added after processing
  // can credit an IN player who led a round despite not having been in a lineup
  // at process time (roundLeaders would have stripped their name).
  const normLeaders = (names) => (Array.isArray(names) ? names : (names ? [names] : [])).filter(Boolean);
  const roundLeadersAll = {
    round1: normLeaders(rl?.round1),
    round2: normLeaders(rl?.round2),
    round3: normLeaders(rl?.round3),
  };

  // Bonus amounts, honouring the commish's per-round overrides. The tables
  // were declared inline here AND in src/constants — same numbers, twice.
  const bonuses = bonusesFor(tournament, settings);

  // Process each team — mirrors processTournamentData exactly
  const resultsData = { teams: {}, earningsMap: { ...earningsMap }, roundLeaders, roundLeadersAll, fullLineups: {} };
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

  // Loaded here rather than after scoring because eligibleStarters needs the
  // mulligan history: a mulligan moves a start from one player to another, and
  // a start moved is a start spent. Reused by the swing award below.
  const txSnap = await db.collection('transactions').get();
  const allTransactions = txSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const updatedTeams = teams.map(team => {
    // One lineup, read once. This recorded lineupFor (the five frozen at lock)
    // and then SCORED team.lineup (the live five) — so the result and the
    // record of what produced it could disagree. Lineup editing reopens Sunday
    // 9pm ET and this runs Monday 9am ET, which is exactly the window where
    // those two differ, and is how three 2026 events came to be scored on the
    // wrong five in the first place.
    const scoredLineup = [...lineupFor(newTournaments[ti], team)];

    // Gate on the lineup being SCORED, not on team.lineup. Gating on the live
    // one skipped a team that had already cleared their lineup for next week —
    // Sunday 9pm onwards — so their frozen five went unscored entirely.
    if (!scoredLineup.length) return team;

    // The cap's last line. A limited player with no starts left cannot score,
    // however they came to be in the frozen five — a manager who ignored the
    // roster warning through Thursday, a commissioner edit, a cap lowered
    // mid-season. Judged as of THIS event, so a reprocess reproduces history
    // rather than re-judging it. See eligibleStarters.
    const { starters: eligibleLineup, ineligible } = eligibleStarters({
      lineup: scoredLineup,
      teams, tournaments: newTournaments, transactions: allTransactions,
      tournamentIndex: ti, settings,
    });
    ineligible.forEach(({ name, used, max }) => {
      console.warn(`[process-results] ${team.name}: ${name} is out of starts `
        + `(${used}/${max}) and does not score ${tournament.name}`);
    });
    if (!eligibleLineup.length) return team;

    // fullLineups records what SCORED, which is what scoredLineupFor and the
    // starts count both read back. An ineligible player never started, so
    // leaving them out here is also what stops them being charged for it.
    resultsData.fullLineups[team.id] = [...eligibleLineup];

    const starterResults = eligibleLineup.map(playerName => {
      let earnings = earningsMap[playerName];
      if (earnings === undefined) {
        const mk = Object.keys(earningsMap).find(k => matchName(k, playerName));
        earnings = mk !== undefined ? earningsMap[mk] : 0;
      }
      return { playerName, earnings: earnings || 0 };
    });

    // Scores the STARTING LINEUP, not the best five — see scoringStarters.
    const { starters: topStarters, oversized, lineupSize } = scoringStarters(starterResults, settings);
    if (oversized) {
      console.warn(`[process-results] ${team.name} has ${topStarters.length} starters for a lineup `
        + `size of ${lineupSize} — scoring all of them.`);
    }
    let totalEarnings = topStarters.reduce((s, p) => s + p.earnings, 0);
    const bonusEarnings = { round1: 0, round2: 0, round3: 0 };
    const playersWithBonuses = {};

    ['round1', 'round2', 'round3'].forEach(round => {
      const leaders = Array.isArray(roundLeaders[round]) ? roundLeaders[round] : (roundLeaders[round] ? [roundLeaders[round]] : []);
      leaders.forEach(leaderName => {
        if (!leaderName) return;
        const actual = eligibleLineup.find(pn => matchName(pn, leaderName));
        if (actual) {
          bonusEarnings[round] += bonuses[round];
          totalEarnings += bonuses[round];
          if (!playersWithBonuses[actual]) playersWithBonuses[actual] = { total: 0, rounds: [] };
          playersWithBonuses[actual].total += bonuses[round];
          playersWithBonuses[actual].rounds.push({ round: round.replace('round', ''), bonus: bonuses[round] });
        }
      });
    });

    // The cut rule — same placement and same reasoning as
    // processTournamentData: after bonuses, zeroing the team's week while
    // leaving each player's own earnings intact.
    const forfeit = cutRuleForfeit({ starters: topStarters, earningsMap, settings });
    if (forfeit) {
      console.log(`[process-results] ${team.name} forfeits ${tournament.name}: only `
        + `${forfeit.player} made the cut (${forfeit.starters} started`
        + `${forfeit.won ? '' : ', and he did not win'})`);
      totalEarnings = 0;
    }

    resultsData.teams[team.id] = {
      totalEarnings,
      cutRuleForfeit: forfeit || null,
      // Why the team scored fewer than five, for anyone reading the result
      // later. Same treatment cutRuleForfeit gets: recorded, not inferred.
      ineligible: ineligible.length ? ineligible : null,
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

    // starts and sfglEarnings go to the five that were SCORED, which is what
    // eligibleLineup holds. This read team.lineup — the live one — so in the
    // Sunday-9pm-to-Monday window it credited the start to next week's five
    // and charged nothing to the players who actually teed off. For a limited
    // player that is the difference between spending a start and being handed
    // a free one, in both directions, and it is why the client-side twin
    // (processTournamentData) has always used its effectiveLineup here.
    const updatedRoster = team.roster.map(player => {
      if (!eligibleLineup.includes(player.name)) return player;
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
  // getSwingPot needs the full transactions list, and we append the new
  // swing_winner tx to Firestore below.
  const swingSegment = getSegmentForTournament(newTournaments[ti]);
  // Shared with the commissioner's in-app award path — same eligibility gate,
  // same pot, same winner. Only the note differs, so the transaction log says
  // which side actually fired it.
  const award = computeSwingAward({
    segment: swingSegment,
    allTournaments: newTournaments,
    transactions: allTransactions,
    teams: updatedTeams,
    settings,
  });
  const autoAward = award && {
    updatedTeams: award.updatedTeams,
    newSwingTx: { ...award.newTx, note: `${swingSegment} winner pot (auto-awarded by cron)` },
    pot: award.pot,
    winnerTeamName: award.winnerTeam.name,
  };
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

  // Update only the two tournament docs that actually change — the completed
  // event and the next event we advance to "playing" — via field-level updates,
  // so we don't rewrite (or risk clobbering a concurrent write to) the rest of
  // the collection.
  batch.update(db.collection('tournaments').doc(tournament.name), {
    completed: true,
    playing: false,
    results: resultsData,
  });
  if (nx !== -1) {
    batch.update(db.collection('tournaments').doc(newTournaments[nx].name), { playing: true });
  }
  batch.set(db.collection('sfgl_data').doc('fantasy-golf-global-stats'), { key: 'fantasy-golf-global-stats', value: newStats });
  batch.set(db.collection('sfgl_data').doc('last_auto_results'), { key: 'last_auto_results', value: today });

  // Append swing winner transaction if auto-awarded. New doc; let Firestore
  // generate the doc id and use our txId as the dedup key.
  if (autoAward) {
    const newTxRef = db.collection('transactions').doc();
    batch.set(newTxRef, autoAward.newSwingTx);
  }

  await batch.commit();

  // Email results to all managers
  const managerEmails = await getEmailMap(settings, teams);
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
    const totals = getSeasonEarningsByTeam(newTournaments);
    return teams
      .map(t => ({ team: t.name, totalEarnings: totals[t.id] || 0 }))
      .sort((a, b) => b.totalEarnings - a.totalEarnings);
  })();

  const emailResults = [];
  for (const [teamName, email] of Object.entries(managerEmails)) {
    try {
      await sendEmail(email, `🏆 ${tournament.name} — SFGL Results`, buildTournamentResultsEmail(tournament.name, teamResultsForEmail, teamName, swingWinnerInfoForEmail, seasonStandingsForEmail));
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
        title: '🏆 Results processed',
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
    const nd = extractNextData(html);
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
// Schedule: defaults to Monday 5pm ET. OWGR publishes new rankings Monday
// morning (after the weekend's events), so syncing Monday late-afternoon gives
// the rankings time to settle. Day/hour/minute are configurable via settings
// (owgrSyncDay, owgrSyncHour, owgrSyncMinute) following the same pattern as
// waivers and lineup-reminder.
//
// Requires a cron-job.org job pinging ?action=owgr-rankings (auth: Bearer
// CRON_SECRET) — without it this handler is dormant and rankings only update
// when the commish hits "Sync Now" in DataSyncPanel.
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
  const targetHour   = settings?.owgrSyncHour   ?? 17;  // 5pm ET
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
  // scraping logic stays in one place.
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

  // Resolve each OWGR name onto the player doc that ALREADY represents that
  // golfer, so a ranking lands on the existing doc instead of creating a
  // second one under a different spelling.
  //
  // This is where the league's duplicate-spelling problem was manufactured.
  // The previous version consulted only the explicit /players/{name}.aliases
  // arrays — which are populated by hand, through Merge Players — so any
  // spelling difference nobody had merged yet produced a NEW doc. The league
  // then held both 'Nico Echavarria' and 'Nicolas Echavarria': one with a
  // world rank and headshot, one on somebody's roster, and no connection
  // between them.
  //
  // Matching against the existing doc IDs by identity closes that loop: the
  // alias/nickname/initials rules resolve the spelling automatically, and the
  // hand-maintained aliases arrays remain as an override for the cases no rule
  // can derive.
  const aliasMap = {};
  let existingDocs = new NameSet([]);
  try {
    const snap = await db.collection('players').get();
    existingDocs = new NameSet(snap.docs.map(d => d.id));
    snap.docs.forEach(d => {
      const data = d.data();
      const canonical = data.name || d.id;
      const aliases = Array.isArray(data.aliases) ? data.aliases : [];
      aliases.forEach(a => { aliasMap[a] = canonical; });
    });
  } catch (err) {
    console.warn('[owgr-sync] player index load failed; proceeding without:', err.message);
  }

  // Batch-upsert player docs. Firestore batches cap at 500 ops per commit,
  // so we chunk; this matches the BATCH_SIZE=499 used in playersApi.upsertMany.
  const BATCH_SIZE = 499;
  let upserted = 0;
  for (let i = 0; i < fetched.length; i += BATCH_SIZE) {
    const batch = db.batch();
    fetched.slice(i, i + BATCH_SIZE).forEach(({ name, worldRank }) => {
      // Explicit alias array wins (a deliberate commissioner decision), then
      // identity match against an existing doc, then the name as OWGR gave it.
      const canonicalName = aliasMap[name] || existingDocs.resolve(name) || name;
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
    existingDocsIndexed: existingDocs.size,
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
  // 1. Cheap gates FIRST — no network. These run before fetching /api/live so
  //    off-day / disabled pings cost ~nothing and, critically, do NOT trigger a
  //    pgatour.com scrape. With the cron at 5-min intervals this keeps origin
  //    scrapes to watch days only (Fri/Sat/Sun + Mon) instead of hammering
  //    pgatour.com every 5 min, 24/7. /api/live does NOT report a round number,
  //    so we gate on:
  //    (a) the leadWatchEnabled toggle;
  //    (b) day-of-week — Fri/Sat/Sun (rounds 2-4) plus Mon, to catch a
  //        weather-delayed final round. Round 1 (Thursday) stays excluded.
  //    The live-play gate (c) needs leaderboard data, so it stays below the fetch.
  const settings = await loadSettings();
  if (settings?.leadWatchEnabled === false) {
    return res.json({ status: 'disabled' });
  }

  const etDay = getETNow().getDay();      // 0=Sun … 6=Sat
  const WATCH_DAYS = new Set([5, 6, 0, 1]); // Fri, Sat, Sun + Mon (weather-delayed finish)
  if (!WATCH_DAYS.has(etDay)) {
    return res.json({ status: 'off_day', etDay });
  }

  // Round is informational only (state shape / debug); /api/live doesn't
  // expose it, so infer from the day: Fri=2, Sat=3, Sun/Mon=4.
  const round = etDay === 5 ? 2 : etDay === 6 ? 3 : 4;

  // 2. Fetch live leaderboard via the existing /api/live endpoint.
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'https://www.sfglgolf.com';

  let liveData;
  try {
    // Cache-bust: /api/live sets a 5-min CDN cache (s-maxage=300, SWR 600) tuned
    // for the 5-manager client poll. The lead-watch cron must NOT inherit that
    // staleness — a unique query param forces a CDN miss → origin scrape every
    // run, so the leader-set and the score/thru baked into the push reflect the
    // live board, not a snapshot up to 5–10 min old.
    const resp = await fetch(`${baseUrl}/api/live?fresh=${Date.now()}`, {
      headers: { 'Cache-Control': 'no-cache' },
    });
    if (!resp.ok) return res.json({ status: 'live_fetch_failed', http: resp.status });
    liveData = await resp.json();
  } catch (err) {
    return res.json({ status: 'live_fetch_error', error: err.message });
  }

  if (!liveData?.players?.length) return res.json({ status: 'no_players' });

  // 3. Live-play gate — at least one player has a numeric `thru` (actively on
  //    the course). Skips completed events (everyone 'F') and pre-tee-off lulls
  //    where the "leader" is just the previous round's standing.
  const inProgress = liveData.players.some(
    p => !p.isCut && !p.isWD && /^\d+$/.test(String(p.thru || ''))
  );
  if (!inProgress) {
    return res.json({ status: 'not_in_progress' });
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
    // Determine the leader's score string for the push body (e.g. "-12").
    const leaderPlayer = liveData.players.find(p => matchName(p.name, leaderName));
    const scoreStr = leaderPlayer?.score || '';
    const thruStr  = leaderPlayer?.thru  || '';
    const isCoLeader = currentLeaderSet.length > 1;

    for (const team of teams) {
      const lineup = team.lineup || [];
      const inLineup = lineup.some(n => matchName(n, leaderName));
      if (!inLineup) continue;

      const rateKey = `${team.id}:${leaderName}`;
      const lastTs = Date.parse(newFired[rateKey] || 0);
      if (Number.isFinite(lastTs) && (now - lastTs) < RATE_LIMIT_MS) {
        sends.push({ team: team.name, player: leaderName, skipped: 'rate_limited' });
        continue;
      }

      // Build the push. Name shown as "F. Last" to match the leaderboard.
      // Co-leader gets "is T1!"; sole leader gets "is in the lead!".
      const shortName = abbreviateName(leaderName);
      const title = isCoLeader
        ? `🏌 ${shortName} is T1!`
        : `🏌 ${shortName} is in the lead!`;
      // Body keeps score + thru, tournament name removed.
      const bodyParts = [];
      if (scoreStr) bodyParts.push(`${scoreStr}`);
      if (thruStr)  bodyParts.push(`thru ${thruStr}`);
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

// ── Action: field-check ──────────────────────────────────────────────────────
//
// Pushes a heads-up to any manager whose STARTING lineup contains a player who
// is NOT in this week's tournament field. Two situations it catches:
//   (1) a lineup set EARLY — before the field was published — that guessed
//       wrong about who's actually playing; and
//   (2) a rostered starter who WITHDREW after the lineup was set.
//
// Also checks the BACKUP slot on weeks it's enabled (see backupSpotEnabled) —
// an out-of-field backup can't cover a withdrawal, which defeats the point of
// naming one, and nothing else in the app tells the manager that.
//
// Roster gate: only lineup names the team ACTUALLY OWNS are considered, judged
// against the effective roster (buildEffectiveRoster in ./_rules.js), not the raw stored
// array. team.lineup isn't scrubbed when a player leaves the roster — a drop
// processed by Wednesday's waiver run leaves the name sitting in the lineup
// until the manager next edits it — and an unowned name that happens to be out
// of field would otherwise produce a push blaming the FIELD for what is really
// a roster problem. The client already ignores these names (RostersView derives
// activeLineupCount from currentRoster), so they're invisible on-screen; a push
// naming a player the manager no longer has would be pure confusion. Skipped
// names are reported as `offRoster` in the JSON for diagnosis.
//
// Cadence: driven by the commish-set schedule (SeasonSettingsPanel → "Field
// Check Schedule", synced to the cron-job.org field-check job via
// sync-cron-schedule). This handler mirrors handleLineupReminder's day/hour/
// minute gate, so it fires at the configured weekly slot. Timing note: a
// withdrawal announced AFTER the configured check time won't alert until the
// next scheduled run, so setting the check close to lock maximizes WD capture.
//
// Dedup: per-team CONTENT SIGNATURE keyed to the active tournament (state doc
// sfgl_data/fieldCheck). A team is pushed only when its set of out-of-field
// starters CHANGES since the last push — so repeated pings on the configured
// day never nag, but a manager who fixes then re-breaks (or a fresh withdrawal)
// re-notifies. A tournament change fully resets the stored signatures.
//
// Field-known gate: if /api/field returns no players we bail (status
// 'field_unknown') and never warn — exactly like the in-app RostersView
// warning, which stays silent until tournamentField is populated. A field that
// parsed only PARTIALLY is caught separately by the field-integrity gate below
// ('field_too_small' / 'field_partial'), since a short field would otherwise
// flag half the league's starters as missing.
// ── Name-mismatch detection ─────────────────────────────────────────────────
//
// The matching layers in _playerNames.js resolve every mismatch we know how to
// describe. This is the safety net for the ones we don't: it makes an unknown
// mismatch VISIBLE to the commissioner before a manager notices their player
// missing, instead of letting it render silently as "not playing".
//
// classifyUnmatched answers: "this starter isn't in the field — is that
// because they aren't playing, or because we don't recognise the spelling?"
// A close namesake IN the field is evidence of the latter.
//
// SUSPECTED_MISMATCH_SCORE is tuned so this fires on a given-name rendering we
// lack (the Echavarria shape) and on surname typos, but NOT on two members of
// the same golfing family — a roster holding Alex Fitzpatrick while Matt is in
// the field is a real "not playing", and that manager must still be told.
//
// Returns null when the name looks genuinely absent.
const MISMATCH_SCORE_THRESHOLD = SUSPECTED_MISMATCH_SCORE;

function classifyUnmatched(name, fieldPlayers) {
  const suggestions = suggestMatches(name, fieldPlayers, 3);
  const best = suggestions[0];
  if (!best || best.score < MISMATCH_SCORE_THRESHOLD) return null;
  return { name, suggestions };
}

// Persist the latest audit to sfgl_data/nameAudit. AdminView's Name Audit
// panel subscribes to this doc, so a mismatch found by the weekly field check
// is waiting for the commissioner whether or not anyone was watching the cron
// logs when it ran.
async function writeNameAudit(payload) {
  try {
    await db.collection('sfgl_data').doc('nameAudit').set({
      key: 'nameAudit',
      value: { ...payload, checkedAt: new Date().toISOString() },
    });
  } catch (err) {
    // Never let audit bookkeeping fail the operation that produced it.
    console.warn('[name-audit] write failed:', err?.message || err);
  }
}

// ── Action: name-audit ──────────────────────────────────────────────────────
//
// On-demand, full cross-reference of every name the league holds against every
// name our data sources use. Commissioner-only; driven by the AdminView panel.
//
// Checks, in order of how much a mismatch costs a manager:
//   rosters → this week's field    — drives ⛳, "Playing", tee times, odds,
//                                    live scores and the Wednesday push
//   rosters → /players/{name}      — drives world rank and headshots
//   rosters → live leaderboard     — drives in-tournament scores/positions
//
// Reports only names that FAILED to match, each with ranked suggestions, plus
// any ambiguous initials keys the index had to drop. Nothing is changed —
// applying a fix is a deliberate commissioner action through Merge Players.
async function handleNameAudit(res) {
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'https://www.sfglgolf.com';

  const teams = await loadTeams();
  const rosterNames = [...new Set(
    teams.flatMap((t) => [
      ...(t.roster || []).map((p) => p?.name).filter(Boolean),
      ...(t.lineup || []),
    ]),
  )];
  const lineupNames = new Set(teams.flatMap((t) => t.lineup || []));

  const sections = [];

  // 1. Roster vs this week's field.
  let fieldPlayers = [];
  let tournamentName = '';
  try {
    const resp = await fetch(`${baseUrl}/api/field`, { headers: { 'Cache-Control': 'no-cache' } });
    if (resp.ok) {
      const data = await resp.json();
      fieldPlayers = data?.players || [];
      tournamentName = data?.tournament || '';
    }
  } catch (err) {
    sections.push({ check: 'field', error: err.message });
  }
  if (fieldPlayers.length) {
    const audit = auditNames({ names: rosterNames, reference: fieldPlayers });
    sections.push({
      check: 'field',
      label: `Rostered players vs ${tournamentName || 'this week'}'s field`,
      referenceCount: fieldPlayers.length,
      ...audit,
      // A roster player who simply isn't entered this week is normal and not
      // worth the commissioner's attention. Only flag the ones that look like
      // a spelling problem, and mark whether a lineup depends on them.
      unmatched: audit.unmatched
        .filter((u) => u.suggestions.length && u.suggestions[0].score >= MISMATCH_SCORE_THRESHOLD)
        .map((u) => ({ ...u, inLineup: lineupNames.has(u.name) })),
    });
  }

  // 2. Roster vs the /players directory. A roster name with no player doc gets
  //    no world rank and no headshot, and an OWGR sync writing the other
  //    spelling creates a SECOND doc rather than updating the first.
  try {
    const snap = await db.collection('players').get();
    const playerDocs = snap.docs.map((d) => d.id);
    if (playerDocs.length) {
      const audit = auditNames({ names: rosterNames, reference: playerDocs });
      sections.push({
        check: 'players',
        label: 'Rostered players vs the /players directory',
        referenceCount: playerDocs.length,
        ...audit,
        // Here EVERY unmatched name matters — a rostered player should always
        // have a doc — so unmatched is passed through as-is.
      });
    }
  } catch (err) {
    sections.push({ check: 'players', error: err.message });
  }

  // 3. Roster vs the live leaderboard, when an event is under way.
  try {
    const resp = await fetch(`${baseUrl}/api/live`);
    if (resp.ok) {
      const data = await resp.json();
      const livePlayers = (data?.players || []).map((p) => p.name).filter(Boolean);
      if (livePlayers.length) {
        const audit = auditNames({ names: [...lineupNames], reference: livePlayers });
        sections.push({
          check: 'live',
          label: `Starting lineups vs the ${data.tournamentName || 'live'} leaderboard`,
          referenceCount: livePlayers.length,
          ...audit,
          unmatched: audit.unmatched
            .filter((u) => u.suggestions.length && u.suggestions[0].score >= MISMATCH_SCORE_THRESHOLD),
        });
      }
    }
  } catch (err) {
    sections.push({ check: 'live', error: err.message });
  }

  const suspectedMismatches = sections.flatMap((sec) =>
    (sec.unmatched || []).map((u) => ({ check: sec.check, ...u })));

  await writeNameAudit({
    source: 'name-audit',
    tournamentName,
    fieldCount: fieldPlayers.length,
    sections,
    suspectedMismatches,
  });

  return res.json({
    status: 'ok',
    rosterCount: rosterNames.length,
    tournamentName,
    sections,
    suspectedMismatches,
  });
}

async function handleFieldCheck(res) {
  const settings = await loadSettings();

  // The tee-time capture runs FIRST, before every gate below, and is reported
  // on every exit path.
  //
  // It used to sit after them, which coupled the lineup lock to a notification
  // schedule in two bad ways. Turning off field-check ALERTS would have turned
  // off lock capture with them. And the day/hour gate meant exactly one capture
  // attempt per week: if that single run hit a PGA Tour hiccup there was no
  // retry, and by the next one the tournament had started and the future-only
  // rule would reject everything — the lock would silently fall back to the
  // hour rule for that event.
  //
  // Now every ping tries, from the moment a tournament becomes `playing` until
  // the value freezes at tee-off. Tee times publish Wednesday; the default
  // notification gate is Wednesday 6pm ET; capture no longer depends on either.
  const teeCapture = await tryCaptureFirstTeeTime();
  const lineupSnapshot = await trySnapshotLineups();

  if (settings?.fieldCheckEnabled === false) {
    return res.json({ status: 'disabled', teeCapture, lineupSnapshot });
  }

  // Admin-configurable day/hour/minute gate (mirrors handleLineupReminder).
  // Default: Wednesday (3) 6pm ET — late enough that most fields are final,
  // early enough to act before Thursday's lineup lock.
  const targetDay    = settings?.fieldCheckDay    ?? 3;
  const targetHour   = settings?.fieldCheckHour   ?? 18;
  const targetMinute = settings?.fieldCheckMinute ?? 0;

  const et = getETNow();
  if (et.getDay() !== targetDay) {
    return res.json({ status: 'not_target_day', targetDay, teeCapture, lineupSnapshot });
  }
  if (et.getHours() < targetHour || (et.getHours() === targetHour && et.getMinutes() < targetMinute)) {
    return res.json({ status: 'not_yet', targetHour, targetMinute, teeCapture, lineupSnapshot });
  }

  // Must have an active tournament to check against.
  const tournaments = await loadTournaments();
  const activeTourney = tournaments?.find(t => t.playing && !t.completed);
  if (!activeTourney) return res.json({ status: 'no_tournament' });

  // Fetch this week's field from the SAME source RostersView reads (/api/field).
  // Its CDN cache (s-maxage=300) is fine here — field membership isn't second-
  // sensitive — so no aggressive cache-bust. Self-call pattern mirrors
  // handleLeadWatch's /api/live fetch.
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'https://www.sfglgolf.com';
  let fieldData;
  try {
    const resp = await fetch(`${baseUrl}/api/field`, { headers: { 'Cache-Control': 'no-cache' } });
    if (!resp.ok) return res.json({ status: 'field_fetch_failed', http: resp.status });
    fieldData = await resp.json();
  } catch (err) {
    return res.json({ status: 'field_fetch_error', error: err.message });
  }
  const fieldPlayers = fieldData?.players || [];
  if (!fieldPlayers.length) return res.json({ status: 'field_unknown', teeCapture, lineupSnapshot });

  // Field membership by player IDENTITY — the same NameSet the app builds for
  // the ⛳ flag, from the same endpoint, so this push and the roster page can
  // never disagree about who is playing.
  //
  // This used to be a hand-inlined copy of the client's old normalizeNordic
  // plus a lowercase, keyed into a plain Set. It carried the client's bug
  // exactly: a starter stored under a different spelling than the field
  // payload used ('Nico Echavarria' vs 'Nicolas Echavarria') read as NOT in
  // the field, so the manager got a push telling them to bench a player who
  // was in fact teeing off Thursday morning. That is worse than saying
  // nothing — it actively destroys trust in the alert.
  const fieldSet = new NameSet(fieldPlayers);

  const tournamentName = fieldData.tournament || activeTourney.name || '';

  // Load prior dedup state; reset when the tournament changes.
  const stateRef = db.collection('sfgl_data').doc('fieldCheck');
  const stateSnap = await stateRef.get();
  const prevState = stateSnap.exists ? (stateSnap.data().value || {}) : {};
  const sameTournament = prevState.tournamentName === tournamentName;
  const lastSig = sameTournament ? (prevState.lastNotified || {}) : {};

  // ── Field-integrity gate ───────────────────────────────────────────────────
  // A HALF-SCRAPED field is worse than no field: every starter the parser
  // missed reads as "not in the field", so a single upstream markup change
  // blasts a false ⛳ alert to every team at once — and the signature dedup
  // then RECORDS those false alerts, so the corrected run re-pushes.
  // /api/field itself can't tell us it parsed partially (it returns whatever
  // it found across its espn → pgatour fallbacks), so we sanity-check the count
  // here before trusting it.
  //
  // A fixed floor won't do, because small fields are legitimate: the TOUR
  // Championship is 30, Hero World Challenge ~20, match play 64. Those are
  // real fields, and they're exactly the weeks this notification matters most
  // (most rostered players genuinely aren't playing). So we use two gates:
  //
  //   1. Absolute floor — catches the catastrophic parse (a handful of names)
  //      while clearing every real limited field. Overridable via settings
  //      (fieldCheckMinField) if a smaller invitational ever shows up.
  //   2. Relative drop — compare against the largest count we've already seen
  //      FOR THIS SAME TOURNAMENT (high-water mark, stored below and reset
  //      whenever the tournament changes). A field that shrinks by 40%+ mid-week
  //      is a parse regression, not 60 withdrawals.
  //
  // Gate 2 can't help on a tournament's first run — there's no baseline yet —
  // which is why gate 1 stands on its own. It can also trip when /api/field
  // falls back between sources and the fallback returns a shorter list; that
  // errs toward silence rather than a false blast, which is the safe direction.
  // Both bail BEFORE any state write, so a suspect count never becomes the
  // baseline and never records a signature.
  const minField = settings?.fieldCheckMinField ?? 16;
  if (fieldPlayers.length < minField) {
    return res.json({
      status: 'field_too_small',
      fieldCount: fieldPlayers.length,
      minField,
      source: fieldData.source || null,
    });
  }
  const knownCount = sameTournament ? (prevState.fieldCount || 0) : 0;
  if (knownCount && fieldPlayers.length < Math.ceil(knownCount * 0.6)) {
    return res.json({
      status: 'field_partial',
      fieldCount: fieldPlayers.length,
      knownCount,
      source: fieldData.source || null,
    });
  }

  const teams = await loadTeams();

  // Transactions power the effective-roster replay below — a lineup name the
  // team no longer owns must not be blamed on the field.
  let allTx = [];
  try {
    const txSnap = await db.collection('transactions').get();
    allTx = txSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    // Fail SAFE: without transactions we can't tell an owned starter from a
    // stale one, and guessing risks naming players managers no longer have.
    return res.json({ status: 'tx_fetch_failed', error: err.message });
  }

  // Does the backup slot even exist this week? Mirrors isBackupSpotEnabled in
  // src/utils/sharedHelpers.js — without this gate a stale `backup` left over
  // from a previous Major would draw a warning about a slot that isn't in play.
  const backupSpotEnabled =
    activeTourney.isMajor     ? (settings?.backupSpotMajor     ?? true)
    : activeTourney.isSignature ? (settings?.backupSpotSignature ?? false)
    : (settings?.backupSpotRegular ?? false);

  const newSig = { ...lastSig };
  const results = [];

  // League-wide collection of starters we could not match to the field but
  // that look like a NAME problem rather than a genuine absence — see
  // classifyUnmatched.
  const suspectedMismatches = [];

  for (const team of teams) {
    // Match the lineup against the roster by IDENTITY, not string equality.
    // The two lists are written at different times, so a spelling corrected on
    // the roster (a Merge Players fix, say) can leave the lineup holding the
    // old rendering — and an exact-match Set would then read a legitimate
    // starter as unowned and silently skip warning that manager, which is the
    // opposite of what this handler is for.
    const rostered = new NameSet(buildEffectiveRoster(team, allTx, { tournaments }));
    const lineup = team.lineup || [];
    const starters = lineup.filter(name => rostered.has(name));
    const offRoster = lineup.filter(name => !rostered.has(name));

    const unmatched = starters.filter(name => !fieldSet.has(name));

    // Split "genuinely not in the field" from "we probably just don't
    // recognise this spelling". A starter missing from the field who has a
    // very close namesake IN the field is far more likely to be a data problem
    // on our end than a withdrawal, so we do NOT tell the manager to bench
    // them. Those go to the commissioner instead, through the nameAudit doc
    // written at the end of this handler.
    const outOfField = [];
    for (const name of unmatched) {
      const suspect = classifyUnmatched(name, fieldPlayers);
      if (suspect) suspectedMismatches.push({ team: team.name, ...suspect });
      else outOfField.push(name);
    }

    // The backup only matters on weeks the slot is enabled, and only if the
    // team still owns them. Unlike a starter they score nothing either way —
    // the loss is that they can't COVER a withdrawal, so the copy differs.
    // The same mismatch split applies: an unrecognised spelling must reach the
    // commissioner as an audit row, never the manager as a warning.
    const backupName = team.backup || null;
    let backupOut = false;
    if (backupSpotEnabled && backupName && rostered.has(backupName) && !fieldSet.has(backupName)) {
      const suspect = classifyUnmatched(backupName, fieldPlayers);
      if (suspect) suspectedMismatches.push({ team: team.name, ...suspect });
      else backupOut = true;
    }

    // Signature spans both slots so fixing one while breaking the other still
    // re-notifies. Built from RAW names (display abbreviates) so it stays
    // stable, and namespaced so a starter can never collide with a backup.
    // Changing this FORMAT invalidates stored signatures, costing at most one
    // duplicate push per affected team on the first run after the change.
    const signature = [
      ...[...outOfField].sort().map(n => `S:${n}`),
      ...(backupOut ? [`B:${backupName}`] : []),
    ].join('|');

    // Nothing out of field → clear any stored signature so a future break
    // re-notifies, and move on.
    if (!signature) {
      if (newSig[team.id]) delete newSig[team.id];
      results.push({ team: team.name, outOfField: [], offRoster });
      continue;
    }

    // Same out-of-field set we already notified about → don't nag.
    if (lastSig[team.id] === signature) {
      results.push({ team: team.name, outOfField, backupOut, offRoster, skipped: 'already_notified' });
      continue;
    }

    // New / changed out-of-field set → push. Names shown as "F. Last" to match
    // the leaderboard/roster rendering.
    const names = outOfField.map(abbreviateName);
    const shortBackup = backupOut ? abbreviateName(backupName) : null;
    const list = names.length <= 2
      ? names.join(' and ')
      : `${names.slice(0, -1).join(', ')}, and ${names.slice(-1)}`;
    const isPlural = outOfField.length > 1;

    // Title leads with the starters when there are any — that's the costlier
    // problem — and falls back to the backup when it's the only thing wrong.
    const title = outOfField.length === 0
      ? `⛳ Your backup isn't in the field`
      : isPlural
        ? `⛳ ${outOfField.length} starters not in the field`
        : `⛳ ${names[0]} isn't in the field`;

    const sentences = [];
    if (outOfField.length) {
      sentences.push(isPlural
        ? `${list} aren't in ${tournamentName}'s field — they'll score nothing.`
        : `${names[0]} isn't in ${tournamentName}'s field — they'll score nothing.`);
    }
    if (backupOut) {
      sentences.push(outOfField.length
        ? `${shortBackup}, your backup, isn't in the field either — no cover if someone withdraws.`
        : `${shortBackup} is your backup and isn't in ${tournamentName}'s field — no cover if someone withdraws.`);
    }
    const body = `${sentences.join(' ')} Tap to fix your lineup.`;

    try {
      const pushResult = await sendPushToTeam({
        teamId: team.id,
        event: 'fieldCheck',
        title,
        body,
        deepLink: '#rosters',
      });
      newSig[team.id] = signature;
      results.push({ team: team.name, outOfField, backupOut, offRoster, sent: pushResult.sent, failed: pushResult.failed });
    } catch (err) {
      results.push({ team: team.name, outOfField, backupOut, offRoster, error: err.message });
    }
  }

  // fieldCount is the HIGH-WATER mark for this tournament, not the latest count
  // — a field that legitimately shrinks (withdrawals) must not walk the
  // baseline down and thereby blind the relative gate to a later partial parse.
  // It resets with everything else when the tournament changes.
  await stateRef.set({
    key: 'fieldCheck',
    value: {
      tournamentName,
      lastNotified: newSig,
      fieldCount: Math.max(knownCount, fieldPlayers.length),
      fieldSource: fieldData.source || null,
    },
  });

  // Persist anything that looked like a name mismatch, so the commissioner
  // sees it in AdminView → Name Audit rather than finding out when a manager
  // asks why their player shows as not playing.
  await writeNameAudit({
    source: 'field-check',
    tournamentName,
    fieldCount: fieldPlayers.length,
    suspectedMismatches,
    ambiguous: [...fieldSet.ambiguous].map(([key, names]) => ({ key, names })),
  });

  return res.json({
    status: 'sent',
    tournament: tournamentName,
    fieldCount: fieldPlayers.length,
    results,
    suspectedMismatches,
  });
}

// ── Cron-job.org schedule sync ─────────────────────────────────────────
// Pushes a schedule change from the commish panel (SeasonSettingsPanel) to the
// matching cron-job.org job, so the actual ping time tracks the in-app gate.
// Browser-initiated with no CRON_SECRET, so 'sync-cron-schedule' is exempted in
// NO_AUTH_ACTIONS (same posture as notify-results / pgat-stats).
//
// Payload shapes (from the panel):
//   weekly:   { jobType: 'waivers' | 'results' | 'lineup-reminder', day, hour, minute }
//   interval: { jobType: 'lead-watch', minuteInterval }
// The 'results' job expands to a same-day RETRY WINDOW (every 30 min from
// the set time to 10pm ET) so a weather-delayed finish still auto-processes.
//
// `day` uses JS getDay() convention (0=Sunday .. 6=Saturday) — identical to the
// cron handler's gate (et.getDay()) AND to cron-job.org's wdays convention, so
// it maps straight through with no remapping.
const CRONJOB_API_BASE = 'https://api.cron-job.org';
const CRON_SYNC_TZ     = 'America/New_York';
const CRON_JOB_ID_ENV  = {
  'waivers':         'CRONJOB_WAIVERS_JOB_ID',
  'results':         'CRONJOB_RESULTS_JOB_ID',
  'lineup-reminder': 'CRONJOB_LINEUP_REMINDER_JOB_ID',
  'lead-watch':      'CRONJOB_LEAD_WATCH_JOB_ID',
  'owgr-rankings':   'CRONJOB_OWGR_JOB_ID',
  'field-check':     'CRONJOB_FIELD_CHECK_JOB_ID',
};

async function handleSyncCronSchedule(req, res) {
  const body    = req.body || {};
  const jobType = body.jobType;
  const apiKey  = process.env.CRONJOB_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: 'Sync not configured',
      hint:  'Set CRONJOB_API_KEY in Vercel → Settings → Environment Variables',
    });
  }

  const envName = CRON_JOB_ID_ENV[jobType];
  if (!envName) {
    return res.status(400).json({
      error: `Unknown jobType "${jobType}"`,
      hint:  'Expected waivers, results, lineup-reminder, lead-watch, owgr-rankings, or field-check',
    });
  }

  const jobId = process.env[envName];
  if (!jobId) {
    return res.status(500).json({
      error: `Missing job ID for "${jobType}"`,
      hint:  `Set ${envName} in Vercel env vars`,
    });
  }

  // Build the cron-job.org schedule object.
  let schedule;
  if (jobType === 'lead-watch') {
    const n = Number(body.minuteInterval);
    if (!Number.isInteger(n) || n < 1 || n > 60) {
      return res.status(400).json({ error: 'Invalid minuteInterval (expected 1-60)' });
    }
    const minutes = [];
    for (let m = 0; m < 60; m += n) minutes.push(m);
    schedule = {
      timezone: CRON_SYNC_TZ, expiresAt: 0,
      hours: [-1], mdays: [-1], minutes, months: [-1], wdays: [-1],
    };
  } else {
    const day    = Number(body.day);
    const hour   = Number(body.hour);
    const minute = Number(body.minute);
    const valid =
      Number.isInteger(day)    && day    >= 0 && day    <= 6 &&
      Number.isInteger(hour)   && hour   >= 0 && hour   <= 23 &&
      Number.isInteger(minute) && minute >= 0 && minute <= 59;
    if (!valid) {
      return res.status(400).json({ error: 'Invalid day/hour/minute' });
    }
    if (jobType === 'results') {
      // Results may not be final at the scheduled time (e.g. a weather-delayed
      // Monday finish), so fire on a RETRY WINDOW: every 30 min from the
      // configured time through 10pm ET on the same weekday. The handler's
      // idempotency guard (last_auto_results) still ensures it processes
      // exactly once — on the first ping where results have actually posted.
      const endHour = 22;
      const hours = [];
      for (let h = hour; h <= Math.max(hour, endHour); h++) hours.push(h);
      const minutes = [...new Set([minute, (minute + 30) % 60])].sort((a, b) => a - b);
      schedule = {
        timezone: CRON_SYNC_TZ, expiresAt: 0,
        hours, mdays: [-1], minutes, months: [-1], wdays: [day],
      };
    } else {
      schedule = {
        timezone: CRON_SYNC_TZ, expiresAt: 0,
        hours: [hour], mdays: [-1], minutes: [minute], months: [-1], wdays: [day],
      };
    }
  }

  // PATCH the job on cron-job.org. Body is a delta — only the schedule changes.
  let resp;
  try {
    resp = await fetch(`${CRONJOB_API_BASE}/jobs/${jobId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ job: { schedule } }),
    });
  } catch (err) {
    return res.status(502).json({ error: `Could not reach cron-job.org: ${err.message}` });
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    let hint = '';
    if      (resp.status === 401) hint = 'cron-job.org rejected the API key — regenerate it in cron-job.org → Settings and update CRONJOB_API_KEY';
    else if (resp.status === 403) hint = 'API key is IP-restricted in cron-job.org — remove the restriction or allowlist Vercel egress';
    else if (resp.status === 404) hint = `cron-job.org has no job #${jobId} — check ${envName}`;
    else if (resp.status === 429) hint = 'cron-job.org daily/rate limit hit — try again shortly';
    return res.status(502).json({ error: `cron-job.org returned ${resp.status}`, detail: detail.slice(0, 200), hint });
  }

  return res.json({ status: 'synced', jobType, jobId: String(jobId) });
}

// ── Action: stamp the commissioner custom claim (one-time bootstrap) ─────────
// Sets { commissioner: true } on a Firebase Auth user so the locked Firestore
// rules and the app's commish gate recognize them. Auth-gated by CRON_SECRET
// (it is NOT in NO_AUTH_ACTIONS). Run once, after you've signed in at least
// once so your account exists (find your UID in Firebase console →
// Authentication → Users):
//   curl -X POST "https://www.sfglgolf.com/api/cron?action=stamp-commissioner&uid=YOUR_UID" \\
//        -H "Authorization: Bearer YOUR_CRON_SECRET"
// Pass &value=false to revoke. The user must sign out/in (or wait for token
// refresh) for the new claim to take effect.
async function handleStampCommissioner(req, res) {
  const uid = req.query.uid || (req.body && req.body.uid);
  if (!uid) return res.status(400).json({ error: 'uid query param required' });
  const makeCommish = String(req.query.value ?? 'true') !== 'false';
  await getAuth(getApp()).setCustomUserClaims(uid, { commissioner: makeCommish });
  return res.json({ status: 'ok', uid, commissioner: makeCommish });
}

// ── Action: resync legacy tournament store ──────────────────────────────────
// Forces /sfgl_data/fantasy-golf-tournaments to match the canonical /tournaments
// collection. The app reads canonical directly now; this keeps the legacy
// fallback doc (and any legacy reader) in lockstep. Idempotent — canonical is
// never modified. Browser-initiated from the commish panel with no CRON_SECRET,
// so it's exempted in NO_AUTH_ACTIONS below (same posture as notify-results /
// pgat-stats / sync-cron-schedule). Note: tournamentsApi.setAll now syncs the
// legacy doc automatically on every write, so this is a manual repair tool for
// out-of-band edits rather than a routine necessity.
async function handleResyncLegacyTournaments(res) {
  const tournaments = await loadTournaments();
  await db.collection('sfgl_data').doc('fantasy-golf-tournaments')
    .set({ key: 'fantasy-golf-tournaments', value: tournaments });
  return res.json({ updated: tournaments.length });
}

// ── Auth ────────────────────────────────────────────────────────────────────
// Two classes of caller, two credentials:
//
//   SCHEDULER actions  — pinged by cron-job.org. Require Bearer CRON_SECRET.
//   COMMISSIONER actions — invoked from the commish panel in the browser.
//     Require a Firebase ID token whose `commissioner` custom claim is true
//     (the same claim the app's own commish gate reads). Bearer CRON_SECRET is
//     also accepted so curl-based ops/runbooks keep working.
//
// These four used to be in a NO_AUTH_ACTIONS set and ran with NO authentication
// whatsoever. That let anyone on the internet POST to notify-results and email
// every manager from the league's domain with attacker-supplied content,
// rewrite the cron-job.org schedules via sync-cron-schedule, force Firestore
// writes via resync-legacy-tournaments, and burn scrape budget via pgat-stats.
const COMMISSIONER_ACTIONS = new Set([
  'notify-results', 'pgat-stats', 'sync-cron-schedule', 'resync-legacy-tournaments',
  'name-audit',
]);

// Verify the caller is the commissioner. Returns null when authorized, or an
// { status, error } object to return to the client. Fails CLOSED on every
// error path (bad token, expired token, missing claim, verification throw).
async function requireCommissioner(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return { status: 401, error: 'Missing bearer token' };
  }
  const token = header.slice('Bearer '.length).trim();

  // Ops escape hatch: the shared cron secret is equally privileged.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && token === cronSecret) return null;

  try {
    const decoded = await getAuth(getApp()).verifyIdToken(token);
    if (decoded?.commissioner === true) return null;
    return { status: 403, error: 'Commissioner access required' };
  } catch (err) {
    console.warn('[cron] ID token verification failed:', err?.message || err);
    return { status: 401, error: 'Invalid or expired token' };
  }
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  const action = req.query.action || '';

  if (COMMISSIONER_ACTIONS.has(action)) {
    const denied = await requireCommissioner(req);
    if (denied) return res.status(denied.status).json({ error: denied.error });
  } else {
    // Fail CLOSED: a protected action with no configured CRON_SECRET must be
    // rejected, not allowed. (Previously the `&& cronSecret` short-circuit meant
    // an unset secret silently disabled auth entirely.)
    if (!cronSecret) {
      return res.status(503).json({ error: 'CRON_SECRET not configured' });
    }
    if (req.headers.authorization !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    switch (action) {
      case 'waivers':           return await handleWaivers(res);
      case 'lineup-reminder':   return await handleLineupReminder(res);
      case 'process-results':   return await handleProcessResults(res);
      case 'notify-results':    return await handleNotifyResults(req, res);
      case 'pgat-stats':        return await handlePgatStats(res);
      case 'lead-watch':        return await handleLeadWatch(res);
      case 'field-check':       return await handleFieldCheck(res);
      case 'name-audit':        return await handleNameAudit(res);
      case 'owgr-rankings':     return await handleOwgrRankings(res);
      case 'sync-cron-schedule': return await handleSyncCronSchedule(req, res);
      case 'resync-legacy-tournaments': return await handleResyncLegacyTournaments(res);
      case 'stamp-commissioner': return await handleStampCommissioner(req, res);
      default:                  return res.status(400).json({ error: 'Unknown action. Use ?action=waivers|lineup-reminder|process-results|notify-results|pgat-stats|lead-watch|field-check|name-audit|owgr-rankings|sync-cron-schedule|resync-legacy-tournaments' });
    }
  } catch (err) {
    console.error(`[cron] ${action} error:`, err);
    return res.status(500).json({ error: err.message });
  }
}
