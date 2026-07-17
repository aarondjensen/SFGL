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
import { getAuth } from 'firebase-admin/auth';
import { DEFAULTS_ON, dedupeTokenDocs } from './_constants.js';

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

// DEFAULTS_ON is imported from ./_constants.js (shared with api/push.js) so the
// default-on notification set lives in exactly one place.

async function sendPushToTeam({ teamId, event, title, body, deepLink }) {
  if (!teamId || !event) return { sent: 0, failed: 0, skipped: 1, cleanedUp: 0 };

  // Check this team's per-event prefs. Missing prefs map → defaults apply.
  // Missing event key inside prefs → defaults apply.
  try {
    const teamSnap = await db.collection('teams').doc(teamId).get();
    if (!teamSnap.exists) return { sent: 0, failed: 0, skipped: 1, cleanedUp: 0 };
    const prefs = teamSnap.data()?.notificationPrefs;
    if (prefs && typeof prefs[event] === 'boolean') {
      if (prefs[event] === false) return { sent: 0, failed: 0, skipped: 1, cleanedUp: 0 };
    } else {
      // No explicit pref — fall through to default
      if (!DEFAULTS_ON.has(event)) return { sent: 0, failed: 0, skipped: 1, cleanedUp: 0 };
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
          icon: '/favicon/web-app-manifest-192x192.png',
          badge: '/favicon/web-app-manifest-192x192.png',
        },
        fcmOptions: {
          // www is the canonical host — the bare domain 307-redirects, which
          // breaks the notification click-through on some platforms.
          link: deepLink
            ? `https://www.sfglgolf.com/${deepLink.startsWith('#') ? deepLink : '#' + deepLink}`
            : 'https://www.sfglgolf.com/',
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
  const swingNames = new Set();
  const swingIndexes = new Set();
  (tournaments || []).forEach((t, i) => {
    if (getSegmentForTournamentServer(t) === swingSegment) {
      if (t?.name) swingNames.add(t.name);
      swingIndexes.add(i);
    }
  });
  const inSwing = (tx) => {
    if (tx.tournament) return swingNames.has(tx.tournament);
    if (tx.tournamentIndex !== undefined) return swingIndexes.has(tx.tournamentIndex);
    return tx.segment === swingSegment;
  };
  return (transactions || [])
    .filter(tx => {
      if ((tx.fee || 0) <= 0) return false;
      if (tx.status === 'failed') return false;
      if (tx.type === 'swing_winner') return false;
      return inSwing(tx);
    })
    .reduce((sum, tx) => sum + (tx.fee || 0), 0);
}

// Auto-award helper for server-side processing. Same conditions as the
// client-side maybeAutoAwardSwing in AdminView. Returns { updatedTeams,
// newSwingTx, summary } when an award should fire, or null otherwise.
function maybeAutoAwardSwingServer(swingSegment, tournaments, teams, transactions) {
  if (!swingSegment) return null;
  if (transactions.some(tx => tx.type === 'swing_winner' && tx.segment === swingSegment)) return null;

  // Exclude alternate events from the completion gate — they are optional
  // and may never be marked completed, which would otherwise permanently
  // block the auto-award. Mirrors the client-side computeSwingAward, which
  // filters `!t.isAlternate`. (Previously the server included alternates,
  // diverging from the client and leaving such swings recoverable only via
  // the manual Swing Winner panel.)
  const swingTournaments = (tournaments || []).filter(t => getSegmentForTournamentServer(t) === swingSegment && !t.isAlternate);
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
    tournament: lastSegTourney?.t?.name ?? undefined,
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
      return `<div style="padding:12px 14px;background:${bg};border-radius:3px;margin-bottom:6px;${leftBorder}"><table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr><td width="22" style="font-family:${FONT_STACK};font-size:14px;font-weight:700;color:${rankColor};vertical-align:middle;">${i + 1}</td><td style="font-family:${FONT_STACK};font-size:14px;font-weight:${isMe ? '700' : '600'};color:${teamColor};vertical-align:middle;">${s.team}${deltaText}</td><td style="font-family:${FONT_STACK};font-size:14px;font-weight:600;color:#50b478;text-align:right;vertical-align:middle;">$${(s.totalEarnings || 0).toLocaleString()}</td></tr></table></div>`;
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

// Single source of truth for tournaments: the same `tournaments` collection the
// client reads via tournamentsApi.getAll() → _getAllOrdered('tournaments',
// 'start_date'). Previously cron read/wrote a separate sfgl_data/
// fantasy-golf-tournaments array doc that the client had already migrated off
// of, so cron-processed results were invisible to the app and cron's reads saw
// stale/empty data. Reading the collection here (ordered by start_date, exactly
// like the client) keeps both sides on one source. Ordering matters: array
// position is used for next-event progression in handleProcessResults, so it
// must match the client's ordering.
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

  // Load teams + tournaments (tournaments needed to derive current
  // earnings for the waiver tie-breaker).
  let teams = await loadTeams();
  const tournamentsForWaivers = await loadTournaments();

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
  const effectiveRoster = (t) => {
    let names = (t.roster || []).map(p => p.name);
    allTx
      .filter(tx =>
        tx.team === t.name &&
        tx.type !== 'mulligan' &&
        tx.type !== 'swing_winner' &&
        (tx.status === 'processed' || tx.status === 'completed'))
      .sort((a, b) => (a.tournamentIndex ?? 0) - (b.tournamentIndex ?? 0))
      .forEach(tx => {
        if (tx.droppedPlayer) names = names.filter(n => n !== tx.droppedPlayer);
        if (tx.player && !names.includes(tx.player)) names.push(tx.player);
      });
    return names;
  };

  const allRostered = new Set();
  teams.forEach(t => effectiveRoster(t).forEach(n => allRostered.add(n)));

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

  const lockHour = activeTourney.lockHourET || 7;
  const lockTime = lockHour > 12 ? `${lockHour - 12}pm` : lockHour === 12 ? '12pm' : `${lockHour}am`;

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
  const { tournamentName, teamResults, swingWinnerInfo, seasonStandings } = req.body || {};
  if (!tournamentName || !teamResults?.length) return res.status(400).json({ error: 'Missing tournamentName or teamResults' });

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
    const totals = {};
    teams.forEach(t => { totals[t.id] = 0; });
    tournaments.forEach(tt => {
      if (!tt.completed || !tt.results?.teams) return;
      Object.entries(tt.results.teams).forEach(([tid, r]) => {
        if (totals[tid] !== undefined) totals[tid] += (r.totalEarnings || 0);
      });
    });
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

// Name normalization for fuzzy matching (strip accents, lowercase)
function normalizeName(name) {
  return (name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

// "First Last" → "F. Last". Mirrors abbreviateName() in src/utils/index.js —
// keep the two in sync. Single-word names returned unchanged. Used by the
// lead-watch push to match the leaderboard's "V. Hovland" rendering.
function abbreviateName(name) {
  if (!name) return '';
  const parts = name.trim().split(' ');
  if (parts.length < 2) return name;
  return parts[0][0] + '. ' + parts[parts.length - 1];
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

  // Fetch results from ESPN via the existing pga-results API
  // Since we're server-side, call our own API endpoint
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'https://www.sfglgolf.com';
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
      hint:  'Expected waivers, results, lineup-reminder, or lead-watch',
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

export default async function handler(req, res) {
  // Auth check
  const cronSecret = process.env.CRON_SECRET;
  const action = req.query.action || '';

  // Cron actions require auth. Client-callable actions are exempted:
  //   - notify-results: triggered from AdminView after processing
  //   - pgat-stats:     triggered from AdminView's Sync button
  const NO_AUTH_ACTIONS = new Set(['notify-results', 'pgat-stats', 'sync-cron-schedule', 'resync-legacy-tournaments']);
  // Fail CLOSED: a protected action with no configured CRON_SECRET must be
  // rejected, not allowed. (Previously the `&& cronSecret` short-circuit meant
  // an unset secret silently disabled auth entirely.)
  if (!NO_AUTH_ACTIONS.has(action)) {
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
      case 'owgr-rankings':     return await handleOwgrRankings(res);
      case 'sync-cron-schedule': return await handleSyncCronSchedule(req, res);
      case 'resync-legacy-tournaments': return await handleResyncLegacyTournaments(res);
      case 'stamp-commissioner': return await handleStampCommissioner(req, res);
      default:                  return res.status(400).json({ error: 'Unknown action. Use ?action=waivers|lineup-reminder|process-results|notify-results|pgat-stats|lead-watch|owgr-rankings|sync-cron-schedule|resync-legacy-tournaments' });
    }
  } catch (err) {
    console.error(`[cron] ${action} error:`, err);
    return res.status(500).json({ error: err.message });
  }
}
