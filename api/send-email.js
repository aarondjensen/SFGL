// api/send-email.js — email utility using Brevo (formerly Sendinblue)
// Sends styled HTML emails to individual managers
//
// ENV VARS REQUIRED:
//   BREVO_API_KEY — from brevo.com dashboard → SMTP & API → API Keys
//   EMAIL_FROM    — e.g. "SFGL <league@sfglgolf.com>" (after domain verification)

const BREVO_API = 'https://api.brevo.com/v3/smtp/email';

/**
 * Parse "Display Name <email>" or plain email into Brevo sender object.
 */
function parseSender(from) {
  const match = from.match(/^(.+?)\s*<(.+?)>$/);
  if (match) return { name: match[1].trim(), email: match[2].trim() };
  return { email: from.trim() };
}

/**
 * Send a single email via Brevo.
 */
export async function sendEmail(to, subject, html) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.warn('[sendEmail] BREVO_API_KEY not set — skipping email');
    return { skipped: true };
  }

  const from = process.env.EMAIL_FROM || 'SFGL <league@sfglgolf.com>';
  const sender = parseSender(from);

  const resp = await fetch(BREVO_API, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      sender,
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });

  const data = await resp.json();
  if (!resp.ok) {
    console.error('[sendEmail] Brevo error:', data);
    throw new Error(data.message || 'Email send failed');
  }
  return data;
}

/**
 * Send an email to multiple recipients (individually, not CC/BCC).
 */
export async function sendToAll(recipients, subject, htmlOrFn) {
  const results = [];
  for (const email of recipients) {
    if (!email) continue;
    try {
      const html = typeof htmlOrFn === 'function' ? htmlOrFn(email) : htmlOrFn;
      const result = await sendEmail(email, subject, html);
      results.push({ email, success: true, ...result });
    } catch (err) {
      console.error(`[sendToAll] Failed for ${email}:`, err.message);
      results.push({ email, success: false, error: err.message });
    }
  }
  return results;
}

// ── Email templates ──────────────────────────────────────────────────────────

const HEADER = `
  <div style="background:#0a1628;padding:20px 24px;border-bottom:2px solid rgba(220,170,60,0.4);">
    <h1 style="font-family:Georgia,serif;font-size:22px;color:#c4a24e;margin:0;letter-spacing:2px;">SFGL</h1>
    <p style="font-family:-apple-system,sans-serif;font-size:11px;color:rgba(255,255,255,0.5);margin:4px 0 0;letter-spacing:1px;text-transform:uppercase;">2026 Season</p>
  </div>
`;

const FOOTER = `
  <div style="padding:16px 24px;border-top:1px solid rgba(255,255,255,0.08);text-align:center;">
    <a href="https://sfglgolf.com" style="font-family:-apple-system,sans-serif;font-size:12px;color:#c4a24e;text-decoration:none;">sfglgolf.com</a>
    <p style="font-family:-apple-system,sans-serif;font-size:10px;color:rgba(255,255,255,0.3);margin:6px 0 0;">You're receiving this because you're a manager in the SFGL fantasy golf league.</p>
  </div>
`;

function wrap(bodyHtml) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#060e1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#0f1e30;border-radius:4px;overflow:hidden;border:1px solid rgba(255,255,255,0.08);">
    ${HEADER}
    <div style="padding:24px;">${bodyHtml}</div>
    ${FOOTER}
  </div>
</body></html>`;
}

/**
 * Build waiver results email.
 */
export function buildWaiverResultsEmail(processed, recipientTeam) {
  const rows = processed.map(w => {
    const isMe = w.team === recipientTeam;
    const bgColor = w.status === 'processed'
      ? (isMe ? 'rgba(80,180,120,0.15)' : 'rgba(80,180,120,0.06)')
      : 'rgba(200,60,60,0.08)';
    const statusIcon = w.status === 'processed' ? '✅' : '❌';
    const statusText = w.status === 'processed' ? 'Approved' : 'Blocked';
    return `
      <div style="background:${bgColor};border:1px solid rgba(255,255,255,0.06);border-radius:3px;padding:10px 14px;margin-bottom:6px;${isMe ? 'border-left:3px solid #c4a24e;' : ''}">
        <div style="font-size:13px;font-weight:600;color:${isMe ? '#ffffff' : 'rgba(255,255,255,0.8)'};">
          ${w.team}
          <span style="float:right;font-size:11px;font-weight:400;color:${w.status === 'processed' ? '#50b478' : '#cc5555'};">${statusIcon} ${statusText}</span>
        </div>
        <div style="font-size:12px;margin-top:4px;">
          <span style="color:#50b478;">+ ${w.player}</span>
          ${w.droppedPlayer ? `<span style="color:rgba(255,255,255,0.3);"> → </span><span style="color:#cc5555;">- ${w.droppedPlayer}</span>` : ''}
        </div>
        ${w.failReason ? `<div style="font-size:10px;color:rgba(255,255,255,0.4);margin-top:3px;">${w.failReason}</div>` : ''}
      </div>`;
  }).join('');

  return wrap(`
    <h2 style="font-family:Georgia,serif;font-size:16px;color:#c4a24e;margin:0 0 4px;">⏰ Waiver Results</h2>
    <p style="font-size:12px;color:rgba(255,255,255,0.5);margin:0 0 16px;">Processed ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</p>
    ${rows}
  `);
}

/**
 * Build tournament results email.
 */
export function buildTournamentResultsEmail(tournamentName, teamResults, recipientTeam) {
  const sorted = [...teamResults].sort((a, b) => b.totalEarnings - a.totalEarnings);
  const rows = sorted.map((tr, i) => {
    const isMe = tr.team === recipientTeam;
    return `
      <div style="padding:8px 12px;background:${isMe ? 'rgba(196,162,78,0.1)' : 'rgba(255,255,255,0.02)'};border-radius:3px;margin-bottom:4px;${isMe ? 'border-left:3px solid #c4a24e;' : ''}">
        <span style="font-size:14px;font-weight:700;color:rgba(255,255,255,0.3);display:inline-block;width:20px;">${i + 1}</span>
        <span style="font-size:13px;font-weight:${isMe ? '700' : '500'};color:${isMe ? '#ffffff' : 'rgba(255,255,255,0.75)'};">${tr.team}</span>
        <span style="float:right;font-size:13px;font-weight:600;color:#50b478;">$${(tr.totalEarnings || 0).toLocaleString()}</span>
      </div>`;
  }).join('');

  return wrap(`
    <h2 style="font-family:Georgia,serif;font-size:16px;color:#c4a24e;margin:0 0 4px;">🏆 ${tournamentName}</h2>
    <p style="font-size:12px;color:rgba(255,255,255,0.5);margin:0 0 16px;">Tournament Results</p>
    ${rows}
  `);
}

/**
 * Build lineup reminder email.
 */
export function buildLineupReminderEmail(tournamentName, lockTime, recipientTeam) {
  return wrap(`
    <h2 style="font-family:Georgia,serif;font-size:16px;color:#c4a24e;margin:0 0 4px;">⛳ Lineups Lock Soon</h2>
    <p style="font-size:13px;color:rgba(255,255,255,0.75);margin:0 0 8px;">${tournamentName}</p>
    <p style="font-size:12px;color:rgba(255,255,255,0.5);margin:0 0 20px;">Lineups lock <strong style="color:#ffffff;">Thursday at ${lockTime} ET</strong>. Make sure your lineup is set!</p>
    <a href="https://sfglgolf.com" style="display:inline-block;padding:10px 24px;background:rgba(196,162,78,0.15);border:1px solid rgba(196,162,78,0.5);border-radius:4px;color:#c4a24e;text-decoration:none;font-weight:600;font-size:13px;">Set Lineup →</a>
  `);
}
