// api/log-error.js — Vercel serverless function
// ============================================================================
// Receives sanitized client-side error reports from the ErrorBoundary +
// window-level handlers in src/pages/ErrorBoundary.jsx, and emails the
// commish via Brevo so production errors don't go unnoticed.
//
// Expected POST body (all fields strings, all optional except message):
//   {
//     message:   string,   // error message (truncated to 500 chars client-side)
//     stack:     string,   // full stack incl. React componentStack if 'react'
//     source:    'react' | 'window' | 'rejection',
//     tabName:   string,   // which ErrorBoundary caught it (if React)
//     url:       string,   // window.location.href at time of error
//     userAgent: string,   // navigator.userAgent
//     timestamp: string,   // ISO 8601
//   }
//
// Rate limiting + dedupe live CLIENT-side (5 reports/session, 60s dedupe
// window). Server is a thin pass-through to Brevo so we don't have to manage
// state in a serverless function. If abuse becomes an issue, add IP-based
// rate limiting via Vercel KV here later.
//
// Why a standalone function (not consolidated into cron.js): error reports
// are user-facing — they fire any time the app crashes. Mixing them with
// cron-only endpoints risks accidental auth issues (cron.js has CRON_SECRET
// auth). This endpoint deliberately has no auth so the client can call it
// freely. Counts against the 12-function Hobby cap.
//
// Env vars required:
//   BREVO_API_KEY        Brevo (Sendinblue) API key
//   ERROR_REPORT_TO      Recipient email (commish). Falls back to noop if unset.
//   ERROR_REPORT_FROM    From email (must be on a Brevo-verified domain).
//                        Defaults to errors@sfglgolf.com if unset.
// ============================================================================

const BREVO_API = 'https://api.brevo.com/v3/smtp/email';

// Truncate to defend against a misbehaving client sending mega-payloads.
const MAX_MESSAGE = 500;
const MAX_STACK = 4000;
const MAX_URL = 500;
const MAX_UA = 300;

function clean(s, max) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, max);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export default async function handler(req, res) {
  // CORS — only POST is valid; preflight allowed
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

  try {
    // Vercel parses JSON bodies automatically when Content-Type is application/json
    const body = req.body || {};

    const message   = clean(body.message,   MAX_MESSAGE) || 'Unknown error';
    const stack     = clean(body.stack,     MAX_STACK);
    const source    = clean(body.source,    20) || 'unknown';
    const tabName   = clean(body.tabName,   80);
    const url       = clean(body.url,       MAX_URL);
    const userAgent = clean(body.userAgent, MAX_UA);
    const timestamp = clean(body.timestamp, 40) || new Date().toISOString();

    const apiKey = process.env.BREVO_API_KEY;
    const toEmail = process.env.ERROR_REPORT_TO;
    const fromEmail = process.env.ERROR_REPORT_FROM || 'errors@sfglgolf.com';

    // No recipient configured → accept the report silently. Useful for
    // staging or if the commish hasn't set the env var yet. Returns 200
    // so the client never sees an error from the error reporter.
    if (!apiKey || !toEmail) {
      console.warn('[log-error] BREVO_API_KEY or ERROR_REPORT_TO missing — report dropped:', message);
      return res.status(200).json({ ok: true, delivered: false, reason: 'reporter not configured' });
    }

    const sourceLabel = source === 'react'     ? 'React boundary'
                      : source === 'window'    ? 'Uncaught window error'
                      : source === 'rejection' ? 'Unhandled promise rejection'
                      : source;

    const subject = `[SFGL error] ${message.slice(0, 100)}`;
    const htmlBody = `
<div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 640px;">
  <h2 style="color:#c33;margin:0 0 16px">SFGL client error</h2>
  <table style="border-collapse: collapse; width: 100%; font-size: 13px;">
    <tr><td style="padding:6px 0;color:#666;width:120px">When</td><td style="padding:6px 0">${escapeHtml(timestamp)}</td></tr>
    <tr><td style="padding:6px 0;color:#666">Source</td><td style="padding:6px 0">${escapeHtml(sourceLabel)}${tabName ? ' — ' + escapeHtml(tabName) : ''}</td></tr>
    <tr><td style="padding:6px 0;color:#666">URL</td><td style="padding:6px 0"><code>${escapeHtml(url)}</code></td></tr>
    <tr><td style="padding:6px 0;color:#666">User agent</td><td style="padding:6px 0;font-size:11px;color:#999">${escapeHtml(userAgent)}</td></tr>
  </table>

  <h3 style="margin:20px 0 6px;font-size:14px">Message</h3>
  <pre style="background:#f8f8f8;border:1px solid #ddd;border-radius:4px;padding:10px;font-size:12px;white-space:pre-wrap;word-break:break-word">${escapeHtml(message)}</pre>

  ${stack ? `
  <h3 style="margin:20px 0 6px;font-size:14px">Stack</h3>
  <pre style="background:#f8f8f8;border:1px solid #ddd;border-radius:4px;padding:10px;font-size:11px;white-space:pre-wrap;word-break:break-word;line-height:1.4">${escapeHtml(stack)}</pre>
  ` : ''}

  <p style="color:#999;font-size:11px;margin-top:24px">
    Sent from <code>api/log-error.js</code>. Reports are rate-limited to 5/session/user with a 60s dedupe window. To stop these emails, unset ERROR_REPORT_TO in Vercel env vars.
  </p>
</div>`.trim();

    const brevoBody = {
      sender: { email: fromEmail, name: 'SFGL Error Reporter' },
      to: [{ email: toEmail }],
      subject,
      htmlContent: htmlBody,
    };

    const brevoResp = await fetch(BREVO_API, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(brevoBody),
    });

    if (!brevoResp.ok) {
      const text = await brevoResp.text();
      console.error('[log-error] Brevo error:', brevoResp.status, text);
      // Return 200 anyway — we don't want a Brevo outage to surface as a
      // visible failure to the client that's already in an error state.
      return res.status(200).json({ ok: true, delivered: false, reason: `brevo ${brevoResp.status}` });
    }

    return res.status(200).json({ ok: true, delivered: true });
  } catch (err) {
    console.error('[log-error] handler crashed:', err);
    return res.status(200).json({ ok: true, delivered: false, reason: 'handler error' });
  }
}
