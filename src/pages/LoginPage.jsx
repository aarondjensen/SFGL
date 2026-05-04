import { useState } from "react";
import { managerAuthApi } from "../api/firebase";
import "./LoginPage.css";

const EyeOpen = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>
);
const EyeClosed = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
    <line x1="1" y1="1" x2="23" y2="23"/>
  </svg>
);

export default function LoginPage({ onLogin }) {
  const [name,        setName]        = useState('');
  const [password,    setPassword]    = useState('');
  const [showPw,      setShowPw]      = useState(false);
  const [remember,    setRemember]    = useState(true);
  const [loading,     setLoading]     = useState(false);
  const [serverError, setServerError] = useState('');
  const [errors,      setErrors]      = useState({});

  const validate = () => {
    const e = {};
    if (!name.trim())     e.name     = 'Please enter your name';
    if (!password.trim()) e.password = 'Please enter your password';
    return e;
  };

  const handleSubmit = async (evt) => {
    evt.preventDefault();
    setServerError('');
    const errs = validate();
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setErrors({});
    setLoading(true);
    try {
      const result = await managerAuthApi.login(name.trim(), password.trim());
      if (onLogin) onLogin(result);
    } catch (err) {
      setServerError(err.message || 'Login failed — check your name and password.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <div className="sfgl-login-root">
        <div className="sfgl-login-card">

          <div className="sfgl-login-header">
            <div style={{
              fontFamily: "'Raleway', system-ui, sans-serif",
              fontSize: 32, fontWeight: 600, letterSpacing: 8,
              color: 'rgba(255,255,255,0.92)',
              textAlign: 'center', marginBottom: 16,
              userSelect: 'none',
            }}>SFGL</div>
            <p className="sfgl-login-subtitle">Manager Portal · 2026 Season</p>
          </div>

          <div className="sfgl-divider"><span className="sfgl-divider-gem">◆</span></div>

          <form onSubmit={handleSubmit} noValidate>
            {serverError && <div className="sfgl-server-error">⚠ {serverError}</div>}

            <div className="sfgl-field">
              <label htmlFor="sfgl-name" className="sfgl-label">Name</label>
              <div className="sfgl-field-wrap">
                <input id="sfgl-name" type="text" className="sfgl-input"
                  placeholder="Login name" value={name} autoFocus autoComplete="username"
                  onChange={e => { setName(e.target.value); setErrors(v => ({...v, name:''})); }}
                />
              </div>
              {errors.name
                ? <p className="sfgl-field-error">⚠ {errors.name}</p>
                : <p className="sfgl-hint">Crawforth · Fano · Hershey · Jensen · Lutz</p>
              }
            </div>

            <div className="sfgl-field">
              <label htmlFor="sfgl-password" className="sfgl-label">Password</label>
              <div className="sfgl-field-wrap">
                <input id="sfgl-password" type={showPw ? 'text' : 'password'}
                  className="sfgl-input with-toggle" placeholder="••••••••"
                  value={password} autoComplete="current-password"
                  onChange={e => { setPassword(e.target.value); setErrors(v => ({...v, password:''})); }}
                />
                <button type="button" className="sfgl-toggle"
                  onClick={() => setShowPw(v => !v)}
                  aria-label={showPw ? 'Hide password' : 'Show password'}>
                  {showPw ? <EyeClosed /> : <EyeOpen />}
                </button>
              </div>
              {errors.password
                ? <p className="sfgl-field-error">⚠ {errors.password}</p>
                : <p className="sfgl-hint">Enter the login name set by your commissioner</p>
              }
            </div>

            <div className="sfgl-options">
              <label className="sfgl-remember">
                <input type="checkbox" className="sfgl-checkbox" checked={remember}
                  onChange={e => setRemember(e.target.checked)} />
                <span className="sfgl-remember-text">Keep me logged in</span>
              </label>
            </div>

            <button type="submit" className="sfgl-btn" disabled={loading}>
              {loading && <span className="sfgl-spinner" />}
              {loading ? 'Signing In…' : 'Sign In'}
            </button>
          </form>

          <div className="sfgl-footer">
            <p>Sinclair Fantasy Golf League</p>
          </div>
        </div>
      </div>
    </>
  );
}
