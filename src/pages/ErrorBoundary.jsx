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

export function reportClientError(payload) {
  try {
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
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
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
