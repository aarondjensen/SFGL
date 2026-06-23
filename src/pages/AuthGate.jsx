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
            <button
              style={{ ...S.btn, ...(busy ? S.btnBusy : null) }}
              disabled={!!busy}
              onClick={() => run('google', signInWithGoogle)}
            >
              {busy === 'google' ? 'Signing in…' : 'Continue with Google'}
            </button>

            <button
              style={{ ...S.btn, ...S.btnApple, ...(busy ? S.btnBusy : null) }}
              disabled={!!busy}
              onClick={() => run('apple', signInWithApple)}
            >
              {busy === 'apple' ? 'Signing in…' : 'Continue with Apple'}
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
  btn: {
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
    transition: 'background 0.15s, border-color 0.15s',
  },
  btnApple: {
    background: '#ffffff',
    color: '#111111',
    borderColor: '#ffffff',
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
