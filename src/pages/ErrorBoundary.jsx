// src/pages/ErrorBoundary.jsx
// ============================================================================
// React error boundary + production error reporter.
//
// When the boundary catches an error, it:
//   1. Renders a fallback UI (unchanged from the original).
//   2. POSTs a sanitized error report to /api/log-error which emails the
//      commish via Brevo. Failure to report is silent — don't let logging
//      errors take down the fallback UI.
//
// Rate limiting: each browser session reports at most MAX_REPORTS errors
// (default 5). Beyond that, errors are caught and shown but not emailed.
// Prevents a render-loop error from spamming the commish's inbox.
//
// Window-level handlers (uncaught errors, unhandled rejections) are wired
// up in App.jsx's top-level useEffect — see the addGlobalErrorReporters
// helper exported below for that wiring.
// ============================================================================

import React from 'react';
import { AlertCircle } from 'lucide-react';
import { colors, theme, fonts } from '../theme.js';

// ── Session-scoped reporter ─────────────────────────────────────────────────
// Module-level so the boundary's componentDidCatch and the window handlers in
// App.jsx share the same counter. Resets on page refresh.
const MAX_REPORTS = 5;
let _reportCount = 0;
// Dedupe key → timestamp. Prevents the same error from being reported twice
// within the dedupe window (60s) — useful when a single bad component
// renders multiple times in quick succession.
const _dedupe = new Map();
const DEDUPE_WINDOW_MS = 60 * 1000;

// ── Stale-chunk auto-reload ─────────────────────────────────────────────────
// After a deploy, Vite renames its content-hashed chunk files. Users with
// the previous build's index.html still loaded will fail to lazy-load any
// route that references the renamed chunks — Vite throws:
//   "Failed to fetch dynamically imported module: .../<Component>-<hash>.js"
//
// This is a transient, expected error during deploys. The right response is
// to silently reload the page (which fetches the new index.html with the
// new chunk references), not show an error UI or email the commish.
//
// Detection: match the error message pattern. Vite + Webpack both produce
// recognizable phrasing. Also matches asset-load failures for static .js
// chunks (chunkLoadError) and a sibling "Importing a module script failed"
// message Safari emits for the same root cause.
//
// Reload-loop protection: if a reload happens and the SAME error appears
// again immediately, that means the issue isn't actually a stale chunk
// (could be a network outage, CDN edge issue, or a real Vite build
// problem). Don't reload-loop the user — surface the error normally.
// sessionStorage marker tracks this within the current tab session.
const STALE_CHUNK_RELOAD_KEY = 'sfgl_stale_chunk_reload_at';
const RELOAD_COOLDOWN_MS = 30 * 1000;

function isStaleChunkError(err) {
  if (!err) return false;
  const msg = String(err.message || err || '');
  return (
    msg.includes('Failed to fetch dynamically imported module') ||
    msg.includes('Importing a module script failed') ||
    msg.includes('error loading dynamically imported module') ||
    // Webpack/legacy bundlers — covered for completeness even though we use Vite
    msg.includes('ChunkLoadError') ||
    msg.includes('Loading chunk') ||
    msg.includes('Loading CSS chunk')
  );
}

function maybeReloadForStaleChunk(err) {
  if (!isStaleChunkError(err)) return false;
  if (typeof window === 'undefined') return false;
  try {
    const lastReloadStr = sessionStorage.getItem(STALE_CHUNK_RELOAD_KEY);
    const lastReload = lastReloadStr ? parseInt(lastReloadStr, 10) : 0;
    const now = Date.now();
    // If we reloaded for the same reason within the cooldown, the reload
    // didn't fix it. Don't loop — fall through to normal error handling.
    if (lastReload && (now - lastReload) < RELOAD_COOLDOWN_MS) {
      console.warn('[stale-chunk] reload already attempted recently, surfacing error');
      return false;
    }
    sessionStorage.setItem(STALE_CHUNK_RELOAD_KEY, String(now));
  } catch (_) {
    // sessionStorage might be unavailable (private browsing, etc) — proceed
    // with reload anyway; worst case is a loop the user can break by closing the tab
  }
  console.warn('[stale-chunk] detected stale chunk reference, reloading');
  window.location.reload();
  return true;
}

// ── Ignorable noise filter ──────────────────────────────────────────────────
// Errors that carry no actionable information and should never generate an
// email report. The canonical case is the bare "Script error." string that
// browsers emit for uncaught errors thrown by CROSS-ORIGIN scripts — the
// real message and stack are redacted for security, so there's nothing to
// debug. These commonly fire from:
//   • Firebase / FCM SDK (loaded cross-origin from gstatic.com)
//   • ESPN headshot/leaderboard CDN scripts
//   • Safari's Web Push / notification-permission flow on iOS PWAs
//   • Browser extensions injecting scripts
// We also filter a few other well-known no-signal messages browsers produce.
const IGNORABLE_MESSAGES = [
  'script error.',
  'script error',
  // ResizeObserver benign warnings — fire constantly on some layouts, never
  // represent a real bug.
  'resizeobserver loop limit exceeded',
  'resizeobserver loop completed with undelivered notifications',
  // Safari/iOS network blips during fetch that aren't actionable
  'load failed',
  // Generic "null is not an object" with no stack from cross-origin contexts
  // is left OUT here intentionally — those can be real bugs in our code.
];
function isIgnorableNoise(payload) {
  if (!payload) return true;
  const msg = String(payload.message || '').trim().toLowerCase();
  if (!msg) return true; // empty message = no signal
  // Exact-match the known-noise strings. Use exact/startsWith rather than
  // includes() so we don't accidentally suppress a real error that merely
  // contains the word "script".
  for (const noise of IGNORABLE_MESSAGES) {
    if (msg === noise || msg === noise + '.') return true;
  }
  // A "Script error." with no stack is the cross-origin redaction case —
  // belt-and-suspenders in case punctuation/whitespace varies.
  if (msg.startsWith('script error') && !payload.stack) return true;

  // Browser-extension noise — MetaMask & other wallet injectors, ad blockers,
  // password managers. They inject scripts into every page and surface errors
  // on window via 'error'/'unhandledrejection', but the stack points at an
  // extension URL (or the message is a known wallet string). SFGL has no
  // wallet/extension integration, so these are never actionable.
  const stack = String(payload.stack || '');
  if (/(?:chrome|moz|safari(?:-web)?|edge)-extension:\/\//i.test(stack)) return true;
  if (/metamask|ethereum|web3|solana|phantom|could not establish connection\. receiving end does not exist|the message port closed before a response/i.test(msg)) return true;

  return false;
}

export function reportClientError(payload) {
  try {
    // Stale-chunk errors during a deploy are expected; auto-reload silently
    // instead of emailing the commish. Check both the message and the stack
    // since unhandledrejection wrapper may have the original error nested.
    if (isStaleChunkError({ message: payload?.message }) || isStaleChunkError({ message: payload?.stack })) {
      if (maybeReloadForStaleChunk({ message: payload?.message || payload?.stack })) return;
    }

    // Ignore uninformative cross-origin / browser-noise errors. These carry
    // no actionable detail (no stack, no line) — the browser deliberately
    // redacts them for security when the error originates from a script
    // served cross-origin (Firebase/FCM SDK from gstatic, ESPN CDN, Safari's
    // notification-permission flow, browser extensions, etc.). Reporting
    // them just spams the commish's inbox with "Script error." emails that
    // can't be debugged. Drop them before they count toward the rate limit
    // or get sent.
    if (isIgnorableNoise(payload)) {
      console.warn('[error-report] ignoring uninformative error:', payload?.message);
      return;
    }

    if (_reportCount >= MAX_REPORTS) return;

    // Dedupe by error message + first stack frame
    const stackHead = (payload.stack || '').split('\n').slice(0, 2).join('|');
    const dedupeKey = (payload.message || '') + '||' + stackHead;
    const now = Date.now();
    const lastSeen = _dedupe.get(dedupeKey);
    if (lastSeen && (now - lastSeen) < DEDUPE_WINDOW_MS) return;
    _dedupe.set(dedupeKey, now);

    _reportCount++;

    // Build full payload — server expects the schema below
    const body = {
      message:    String(payload.message || 'Unknown error').slice(0, 500),
      stack:      String(payload.stack || '').slice(0, 4000),
      source:     String(payload.source || 'react'),     // 'react' | 'window' | 'rejection'
      tabName:    String(payload.tabName || ''),
      url:        typeof window !== 'undefined' ? window.location.href : '',
      userAgent:  typeof navigator !== 'undefined' ? navigator.userAgent : '',
      timestamp:  new Date().toISOString(),
    };

    // Fire-and-forget. Use keepalive so the request survives if the page
    // is unloading right after the error.
    fetch('/api/log-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => { /* swallow — never let a reporter failure surface */ });
  } catch (_) {
    // Belt-and-suspenders: any failure in the reporter itself must be silent
  }
}

// ── Window-level handlers ───────────────────────────────────────────────────
// Call once from App.jsx's top-level useEffect. Captures uncaught errors and
// unhandled promise rejections that React's boundary can't see (e.g. errors
// inside async handlers, event listeners not wrapped by React).
export function addGlobalErrorReporters() {
  if (typeof window === 'undefined') return () => {};

  const onError = (event) => {
    reportClientError({
      message: event.message,
      stack: event.error?.stack,
      source: 'window',
    });
  };
  const onRejection = (event) => {
    const reason = event.reason;
    reportClientError({
      message: reason?.message || String(reason),
      stack: reason?.stack,
      source: 'rejection',
    });
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  // Return unsubscribe for useEffect cleanup symmetry
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}

// ── React error boundary ────────────────────────────────────────────────────
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    // Stale-chunk errors (after a deploy) → silent reload instead of
    // rendering the fallback UI. The reload is fired imperatively from
    // componentDidCatch below; getDerivedStateFromError still flips
    // hasError so we get a one-frame placeholder rather than React
    // continuing to try (and re-fail) the render.
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    // Intercept stale-chunk errors before the normal logging path. Silent
    // reload (no email, no fallback UI) — see maybeReloadForStaleChunk
    // for the loop-protection rationale.
    if (maybeReloadForStaleChunk(error)) return;

    console.error(`[ErrorBoundary${this.props.tabName ? ` — ${this.props.tabName}` : ''}]`, error, info);
    reportClientError({
      message: error?.message || 'React boundary error',
      stack: (error?.stack || '') + '\n\n--- componentStack ---\n' + (info?.componentStack || ''),
      source: 'react',
      tabName: this.props.tabName || '',
    });
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      const tabLabel = this.props.tabName ? ` in ${this.props.tabName}` : '';
      return (
        <div style={{
          background: colors.dangerBg,
          border: `1px solid ${colors.dangerBorder}`,
          borderRadius: 3,       // matches theme shape.cardRadius
          padding: '32px 24px',
          textAlign: 'center',
        }}>
          <AlertCircle style={{
            width: 40, height: 40,
            color: colors.danger,
            margin: '0 auto 12px',
            display: 'block',
          }} />
          <h3 style={{
            fontFamily: fonts.serif,
            fontWeight: 600,
            fontSize: 18,
            color: colors.textPrimary,
            marginBottom: 8,
          }}>
            Something went wrong{tabLabel}
          </h3>
          <p style={{
            fontFamily: fonts.sans,
            fontSize: 13,
            color: colors.textSecondary,
            marginBottom: 16,
          }}>
            {this.state.error?.message || 'An unexpected error occurred'}
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <button
              onClick={this.handleRetry}
              style={{
                ...theme.btnSecondary,
                padding: '8px 16px',
              }}
            >
              Try Again
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{
                ...theme.btnDanger,
                padding: '8px 16px',
              }}
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
