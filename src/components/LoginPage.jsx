import { useState } from "react";
import { managerAuthApi } from "../api/supabase";

const styles = `
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=DM+Sans:wght@300;400;500&display=swap');

  .sfgl-login-root {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'DM Sans', sans-serif;
  }
  .sfgl-login-card {
    width: 100%; max-width: 420px;
    background: rgba(14, 31, 20, 0.97);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 6px; padding: 48px 44px 44px;
    backdrop-filter: blur(12px);
    box-shadow: 0 0 0 1px rgba(74,124,89,0.2), 0 32px 80px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.08);
    animation: sfglCardIn 0.5s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  @keyframes sfglCardIn { from { opacity:0; transform:translateY(20px); } to { opacity:1; transform:translateY(0); } }
  @keyframes sfglFadeUp  { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }

  .sfgl-login-header { text-align:center; margin-bottom:32px; animation: sfglFadeUp 0.4s 0.1s cubic-bezier(0.22,1,0.36,1) both; }
  .sfgl-logo-wrap {
    display:inline-flex; align-items:center; justify-content:center;
    width:60px; height:60px; border-radius:50%;
    background: linear-gradient(135deg, #3a7d52 0%, #2a5c3e 100%);
    border: 2px solid rgba(201,168,76,0.4); margin-bottom:16px;
    box-shadow: 0 0 28px rgba(58,125,82,0.35), 0 4px 16px rgba(0,0,0,0.5);
  }
  .sfgl-logo-svg { width:30px; height:30px; }
  .sfgl-login-title { font-family:'Playfair Display',serif; font-size:26px; font-weight:700; color:#f0e8d2; letter-spacing:-0.2px; line-height:1.2; }
  .sfgl-login-title span { color:#c9a84c; }
  .sfgl-login-subtitle { margin-top:6px; font-size:11px; font-weight:400; color:rgba(240,232,210,0.4); letter-spacing:2px; text-transform:uppercase; }

  .sfgl-divider { display:flex; align-items:center; gap:12px; margin:0 0 28px; }
  .sfgl-divider::before, .sfgl-divider::after { content:''; flex:1; height:1px; background:linear-gradient(90deg, transparent, rgba(201,168,76,0.25), transparent); }
  .sfgl-divider-gem { color:rgba(201,168,76,0.35); font-size:9px; }

  .sfgl-field { margin-bottom:16px; animation: sfglFadeUp 0.4s cubic-bezier(0.22,1,0.36,1) both; }
  .sfgl-field:nth-of-type(1) { animation-delay:0.15s; }
  .sfgl-field:nth-of-type(2) { animation-delay:0.2s; }

  .sfgl-label { display:block; font-size:10px; font-weight:500; color:rgba(240,232,210,0.45); letter-spacing:1.5px; text-transform:uppercase; margin-bottom:7px; }
  .sfgl-field-wrap { position:relative; }
  .sfgl-input {
    width:100%; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1);
    border-radius:3px; padding:12px 16px; font-family:'DM Sans',sans-serif;
    font-size:15px; font-weight:400; color:#f0e8d2; outline:none;
    transition:border-color 0.2s, background 0.2s, box-shadow 0.2s; caret-color:#c9a84c;
  }
  .sfgl-input::placeholder { color:rgba(240,232,210,0.18); }
  .sfgl-input:focus { border-color:rgba(201,168,76,0.5); background:rgba(255,255,255,0.07); box-shadow:0 0 0 3px rgba(201,168,76,0.08); }
  .sfgl-input.with-toggle { padding-right:46px; }

  .sfgl-toggle { position:absolute; right:13px; top:50%; transform:translateY(-50%); background:none; border:none; cursor:pointer; color:rgba(240,232,210,0.28); padding:4px; display:flex; align-items:center; transition:color 0.2s; }
  .sfgl-toggle:hover { color:rgba(240,232,210,0.6); }

  .sfgl-field-error { margin-top:5px; font-size:11.5px; color:#e07070; display:flex; align-items:center; gap:4px; }
  .sfgl-hint { margin-top:5px; font-size:11px; color:rgba(240,232,210,0.28); font-style:italic; }

  .sfgl-options { display:flex; align-items:center; margin-bottom:22px; animation: sfglFadeUp 0.4s 0.25s cubic-bezier(0.22,1,0.36,1) both; }
  .sfgl-remember { display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none; }
  .sfgl-checkbox { width:16px; height:16px; appearance:none; -webkit-appearance:none; border:1px solid rgba(255,255,255,0.18); border-radius:2px; background:rgba(255,255,255,0.04); cursor:pointer; position:relative; transition:border-color 0.2s, background 0.2s; flex-shrink:0; }
  .sfgl-checkbox:checked { background:#3a7d52; border-color:#3a7d52; }
  .sfgl-checkbox:checked::after { content:''; position:absolute; left:4px; top:1.5px; width:5px; height:9px; border:2px solid #f0e8d2; border-top:none; border-left:none; transform:rotate(45deg); }
  .sfgl-remember-text { font-size:12.5px; color:rgba(240,232,210,0.4); }

  .sfgl-btn {
    width:100%; padding:13px;
    background: linear-gradient(135deg, #3a7d52 0%, #2e6343 100%);
    border:1px solid rgba(201,168,76,0.22); border-radius:3px;
    font-family:'DM Sans',sans-serif; font-size:13px; font-weight:500;
    letter-spacing:1.5px; text-transform:uppercase; color:#f0e8d2;
    cursor:pointer; transition:all 0.2s; position:relative; overflow:hidden;
    animation: sfglFadeUp 0.4s 0.3s cubic-bezier(0.22,1,0.36,1) both;
  }
  .sfgl-btn::before { content:''; position:absolute; inset:0; background:linear-gradient(135deg, rgba(255,255,255,0.1) 0%, transparent 55%); opacity:0; transition:opacity 0.2s; }
  .sfgl-btn:hover::before { opacity:1; }
  .sfgl-btn:hover { box-shadow:0 4px 20px rgba(58,125,82,0.4), 0 0 0 1px rgba(201,168,76,0.28); transform:translateY(-1px); }
  .sfgl-btn:active { transform:translateY(0); }
  .sfgl-btn:disabled { opacity:0.5; cursor:not-allowed; transform:none !important; }

  .sfgl-spinner { display:inline-block; width:13px; height:13px; border:2px solid rgba(240,232,210,0.25); border-top-color:#f0e8d2; border-radius:50%; animation:sfglSpin 0.65s linear infinite; vertical-align:middle; margin-right:7px; }
  @keyframes sfglSpin { to { transform:rotate(360deg); } }

  .sfgl-server-error { background:rgba(224,112,112,0.08); border:1px solid rgba(224,112,112,0.28); border-radius:3px; padding:11px 13px; font-size:12.5px; color:#e07070; margin-bottom:16px; animation:sfglFadeUp 0.25s ease both; }

  .sfgl-footer { margin-top:22px; text-align:center; animation: sfglFadeUp 0.4s 0.35s cubic-bezier(0.22,1,0.36,1) both; }
  .sfgl-footer p { font-size:11px; color:rgba(240,232,210,0.2); letter-spacing:0.5px; }
`;

const EyeOpen = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
  </svg>
);
const EyeClosed = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
    <line x1="1" y1="1" x2="23" y2="23"/>
  </svg>
);
const GolfFlag = () => (
  <svg viewBox="0 0 32 32" fill="none" className="sfgl-logo-svg">
    <circle cx="10" cy="26" r="3" fill="rgba(240,232,210,0.9)"/>
    <line x1="10" y1="23" x2="10" y2="6" stroke="rgba(240,232,210,0.9)" strokeWidth="1.8" strokeLinecap="round"/>
    <path d="M10 6 L22 10 L10 14 Z" fill="#c9a84c"/>
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
      setServerError(err.message || 'Login failed. Check your name and password.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <style>{styles}</style>
      <div className="sfgl-login-root">
        <div className="sfgl-login-card">

          <div className="sfgl-login-header">
            <div className="sfgl-logo-wrap"><GolfFlag /></div>
            <h1 className="sfgl-login-title">SFGL <span>Fantasy</span></h1>
            <p className="sfgl-login-subtitle">Manager Portal</p>
          </div>

          <div className="sfgl-divider"><span className="sfgl-divider-gem">✦</span></div>

          <form onSubmit={handleSubmit} noValidate>
            {serverError && <div className="sfgl-server-error">⚠ {serverError}</div>}

            <div className="sfgl-field">
              <label htmlFor="sfgl-name" className="sfgl-label">Your Name</label>
              <div className="sfgl-field-wrap">
                <input id="sfgl-name" type="text" className="sfgl-input"
                  placeholder="e.g. Jensen" value={name} autoFocus autoComplete="username"
                  onChange={e => { setName(e.target.value); setErrors(v => ({...v, name:''})); }}
                />
              </div>
              {errors.name
                ? <p className="sfgl-field-error">⚠ {errors.name}</p>
                : <p className="sfgl-hint">Your last name (e.g. Jensen, Fano, Lutz)</p>
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
                : <p className="sfgl-hint">Default password: your name in lowercase</p>
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

          <div className="sfgl-footer"><p>SFGL Season 2026 · Managers only</p></div>
        </div>
      </div>
    </>
  );
}
