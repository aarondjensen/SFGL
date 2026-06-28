// src/pages/AuthGate.jsx
// ============================================================================
// The gate that stands in front of the app. Two modes:
//   • 'login' — not signed in: Continue with Google / Continue with Apple.
//   • 'claim' — signed in but no team yet: pick an UNclaimed team (self-claim).
//
// App.jsx decides the mode from auth + team-claim state and renders the app
// itself once the user is signed in AND owns a team (or is the commissioner).
// Login is self-contained here; claiming is delegated to onClaim() because the
// uid lives in App's auth state.
// ============================================================================

import React, { useState } from 'react';
import { fonts, fontSize } from '../theme.js';
import { signInWithGoogle, signInWithApple } from '../api/authApi';

const NAVY_TOP = '#0b1521';
const NAVY_BOT = '#111d2e';
const GOLD = '#f5c518';
const WHITE = 'rgba(255,255,255,0.93)';
const MUTED = 'rgba(255,255,255,0.45)';
const LINE = 'rgba(255,255,255,0.12)';
// Apple's HIG requires the button text use the system font (SF Pro on Apple
// platforms); the same stack is fine for Google.
const SYSTEM_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

// Official provider marks (do not restyle the paths — brand-compliant as-is).
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" />
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" />
    </svg>
  );
}

function AppleMark() {
  return (
    <svg width="16" height="18" viewBox="0 0 16 18" aria-hidden="true" fill="#fff" style={{ flexShrink: 0, marginTop: -2 }}>
      <path d="M13.07 9.57c-.02-2.05 1.67-3.03 1.75-3.08-.95-1.39-2.43-1.58-2.96-1.6-1.26-.13-2.46.74-3.1.74-.64 0-1.62-.72-2.67-.7-1.37.02-2.64.8-3.35 2.03-1.43 2.48-.37 6.15 1.02 8.16.68.98 1.49 2.08 2.55 2.04 1.02-.04 1.41-.66 2.65-.66 1.23 0 1.58.66 2.66.64 1.1-.02 1.79-1 2.46-1.99.78-1.14 1.1-2.24 1.12-2.3-.02-.01-2.15-.83-2.17-3.28zM11.03 3.5c.56-.68.94-1.62.84-2.56-.81.03-1.79.54-2.37 1.22-.52.6-.98 1.56-.86 2.48.9.07 1.83-.46 2.39-1.14z" />
    </svg>
  );
}

export default function AuthGate({
  mode = 'login',
  teams = [],
  claims = {},
  onClaim,
  onSignOut,
  userLabel = '',
}) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');

  const run = async (key, fn) => {
    setError('');
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      const code = e?.code;
      if (code !== 'auth/popup-closed-by-user' && code !== 'auth/cancelled-popup-request') {
        setError(e?.message || 'Something went wrong. Please try again.');
      }
    } finally {
      setBusy(null);
    }
  };

  const unclaimed = teams.filter((t) => !claims[t.id]?.uid);

  return (
    <div style={S.wrap}>
      <div style={S.card}>
        <div style={S.wordmark}>SFGL</div>

        {mode === 'login' ? (
          <>
            {/* Apple first — HIG wants Sign in with Apple at least as prominent. */}
            <button
              style={{ ...S.btnBase, ...S.btnApple, ...(busy ? S.btnBusy : null) }}
              disabled={!!busy}
              onClick={() => run('apple', signInWithApple)}
            >
              <AppleMark />
              <span>{busy === 'apple' ? 'Signing in…' : 'Continue with Apple'}</span>
            </button>

            <button
              style={{ ...S.btnBase, ...S.btnGoogle, ...(busy ? S.btnBusy : null) }}
              disabled={!!busy}
              onClick={() => run('google', signInWithGoogle)}
            >
              <GoogleMark />
              <span>{busy === 'google' ? 'Signing in…' : 'Continue with Google'}</span>
            </button>
          </>
        ) : (
          <>
            <div style={S.tagline}>Which team are you?</div>
            {userLabel ? <div style={S.signedAs}>Signed in as {userLabel}</div> : null}

            {unclaimed.length === 0 ? (
              <div style={S.note}>
                Every team has been claimed. If one of these is yours, ask the
                commissioner to reassign it to you.
              </div>
            ) : (
              <div style={S.teamList}>
                {unclaimed.map((t) => (
                  <button
                    key={t.id}
                    style={{ ...S.teamBtn, ...(busy ? S.btnBusy : null) }}
                    disabled={!!busy}
                    onClick={() => run(t.id, () => onClaim(t.id))}
                  >
                    {busy === t.id ? 'Claiming…' : t.name}
                  </button>
                ))}
              </div>
            )}

            <button style={S.signOut} disabled={!!busy} onClick={onSignOut}>
              Sign out
            </button>
          </>
        )}

        {error ? <div style={S.error}>{error}</div> : null}
      </div>
    </div>
  );
}

const S = {
  wrap: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    background: `linear-gradient(180deg, ${NAVY_TOP} 0%, ${NAVY_BOT} 100%)`,
    fontFamily: fonts.sans,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 12,
  },
  wordmark: {
    textAlign: 'center',
    fontFamily: fonts.sans,
    fontSize: fontSize.xl || 22,
    fontWeight: 600,
    letterSpacing: 5,
    color: WHITE,
    marginBottom: 4,
  },
  tagline: {
    textAlign: 'center',
    fontSize: fontSize.md || 14,
    color: MUTED,
    marginBottom: 12,
  },
  signedAs: {
    textAlign: 'center',
    fontSize: fontSize.sm || 12,
    color: MUTED,
    marginTop: -6,
    marginBottom: 6,
    wordBreak: 'break-word',
  },
  // Shared button shell — both providers identical size/weight (equal prominence).
  btnBase: {
    width: '100%',
    height: 48,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: '0 16px',
    borderRadius: 8,
    fontFamily: SYSTEM_FONT,
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'opacity 0.15s',
  },
  // Apple: official black button, white logo + text.
  btnApple: {
    background: '#000000',
    color: '#ffffff',
    border: '1px solid #000000',
  },
  // Google: official light button, 4-color G, Google's #747775 border.
  btnGoogle: {
    background: '#ffffff',
    color: '#1f1f1f',
    border: '1px solid #747775',
  },
  btnBusy: {
    opacity: 0.6,
    cursor: 'default',
  },
  teamList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  teamBtn: {
    width: '100%',
    padding: '12px 16px',
    borderRadius: 8,
    border: `1px solid ${LINE}`,
    background: 'rgba(255,255,255,0.06)',
    color: WHITE,
    fontFamily: fonts.sans,
    fontSize: fontSize.base || 13,
    fontWeight: 600,
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'background 0.15s, border-color 0.15s',
  },
  signOut: {
    marginTop: 6,
    background: 'none',
    border: 'none',
    color: MUTED,
    fontFamily: fonts.sans,
    fontSize: fontSize.sm || 12,
    cursor: 'pointer',
    textDecoration: 'underline',
  },
  note: {
    fontSize: fontSize.sm || 12,
    color: MUTED,
    lineHeight: 1.5,
    textAlign: 'center',
    padding: '4px 4px 8px',
  },
  error: {
    marginTop: 4,
    fontSize: fontSize.sm || 12,
    color: '#ff8a8a',
    textAlign: 'center',
    lineHeight: 1.4,
  },
};

// Exported so App can reuse the accent if needed.
export const GATE_GOLD = GOLD;
