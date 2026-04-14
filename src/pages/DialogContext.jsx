import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { X, Check, AlertCircle, Clock } from 'lucide-react';
import { theme, colors, fonts } from '../theme.js';

const DialogContext = createContext(null);
export const useDialog = () => useContext(DialogContext);

export const DialogProvider = ({ children }) => {
  const [toasts,  setToasts]  = useState([]);
  const [confirm, setConfirm] = useState(null);
  const resolveRef = useRef(null);

  const showToast = useCallback((message, type = 'success') => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const showConfirm = useCallback((title, message, opts = {}) =>
    new Promise(resolve => {
      resolveRef.current = resolve;
      setConfirm({ title, message, ...opts });
    }),
  []);

  const handleResult = useCallback((result) => {
    resolveRef.current?.(result);
    resolveRef.current = null;
    setConfirm(null);
  }, []);

  // ── Escape key closes confirm dialog ──────────────────────────────────────
  useEffect(() => {
    if (!confirm) return;
    const handler = (e) => { if (e.key === 'Escape') handleResult(false); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [confirm, handleResult]);

  // Toast accent colors
  const toastAccent = (type) => {
    if (type === 'success') return { bg: 'rgba(40,100,60,0.95)',  border: 'rgba(80,180,120,0.4)',  icon: colors.success };
    if (type === 'error')   return { bg: 'rgba(100,30,30,0.95)',  border: 'rgba(200,70,70,0.4)',   icon: colors.danger  };
    if (type === 'warning') return { bg: 'rgba(100,80,20,0.95)',  border: 'rgba(200,170,60,0.4)',  icon: colors.warning };
    return                         { bg: 'rgba(20,40,90,0.95)',   border: 'rgba(100,140,220,0.4)', icon: 'rgba(100,160,255,0.9)' };
  };

  const ToastIcon = (type) => type === 'success' ? Check : type === 'error' ? AlertCircle : Clock;

  return (
    <DialogContext.Provider value={{ showToast, showConfirm }}>
      {children}

      {/* ── Toasts ── */}
      <div style={{
        position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
        zIndex: 100,
        display: 'flex', flexDirection: 'column', gap: 8,
        pointerEvents: 'none',
        width: '100%', maxWidth: 360, padding: '0 16px',
      }}>
        {toasts.map(toast => {
          const accent = toastAccent(toast.type);
          const Icon   = ToastIcon(toast.type);
          return (
            <div key={toast.id} style={{
              background: accent.bg,
              border: `1px solid ${accent.border}`,
              borderRadius: 3,
              padding: '10px 14px',
              display: 'flex', alignItems: 'center', gap: 10,
              maxWidth: 340,
              pointerEvents: 'auto',
              boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
              backdropFilter: 'blur(8px)',
              animation: 'sfgl-slideUp 0.25s ease-out',
            }}>
              <Icon style={{ width: 14, height: 14, color: accent.icon, flexShrink: 0 }} />
              <span style={{ fontFamily: fonts.sans, fontSize: 13, color: colors.textPrimary, flex: 1 }}>
                {toast.message}
              </span>
              <button onClick={() => removeToast(toast.id)}
                aria-label="Dismiss"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.textSecondary, padding: 2, display: 'flex', alignItems: 'center', flexShrink: 0 }}
                onMouseEnter={e => { e.currentTarget.style.color = colors.textPrimary; }}
                onMouseLeave={e => { e.currentTarget.style.color = colors.textSecondary; }}
              >
                <X style={{ width: 13, height: 13 }} />
              </button>
            </div>
          );
        })}
      </div>

      {/* ── Confirm dialog ── */}
      {confirm && (
        <div
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(5,10,25,0.82)', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 100, padding: 16,
          }}
          onClick={() => handleResult(false)}
        >
          <div
            style={{
              background: '#0f1d35',
              border: `1px solid ${confirm.type === 'danger' ? colors.dangerBorder : colors.border}`,
              borderRadius: 3,
              boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
              maxWidth: 420, width: '100%',
              padding: '24px 26px',
              animation: 'sfgl-scaleIn 0.18s ease-out',
            }}
            onClick={e => e.stopPropagation()}
            role="alertdialog"
          >
            {/* Title */}
            <h3 style={{
              ...theme.h2,
              marginBottom: 10,
              color: confirm.type === 'danger' ? colors.danger : colors.textPrimary,
            }}>
              {confirm.title}
            </h3>

            {/* Message */}
            <p style={{
              fontFamily: fonts.sans, fontSize: 13,
              color: colors.textSecondary,
              lineHeight: 1.6, whiteSpace: 'pre-line',
              marginBottom: 22,
            }}>
              {confirm.message}
            </p>

            {/* Buttons */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <button
                onClick={() => handleResult(false)}
                style={{ ...theme.btnSecondary, padding: '10px 16px' }}
                onMouseEnter={e => { e.currentTarget.style.opacity = '0.8'; }}
                onMouseLeave={e => { e.currentTarget.style.opacity = '1'; }}
              >
                {confirm.cancelText || 'Cancel'}
              </button>
              <button
                onClick={() => handleResult(true)}
                autoFocus
                style={{
                  ...(confirm.type === 'danger' ? theme.btnDanger : theme.btnPrimary),
                  padding: '10px 16px',
                }}
                onMouseEnter={e => { e.currentTarget.style.opacity = '0.8'; }}
                onMouseLeave={e => { e.currentTarget.style.opacity = '1'; }}
              >
                {confirm.confirmText || 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Animations now in app-global.css — no inline <style> needed */}
    </DialogContext.Provider>
  );
};
