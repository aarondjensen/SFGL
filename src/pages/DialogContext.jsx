import { createContext, useContext, useState, useCallback, useRef } from 'react';
import { X, Check, AlertCircle, Clock } from 'lucide-react';
import { theme, colors, fonts, blue, greenMuted, steel, black, scrim, fontSize } from '../theme.js';
import { useModalBehavior } from '../utils/modalUtils';

const DialogContext = createContext(null);
export const useDialog = () => useContext(DialogContext);

export const DialogProvider = ({ children }) => {
  const [toasts,  setToasts]  = useState([]);
  const [confirm, setConfirm] = useState(null);
  const resolveRef = useRef(null);

  // showToast(message, type, options?)
  //   type:    'success' | 'error' | 'warning' | 'info'  (default: 'success')
  //   options: { position?: 'top' | 'bottom' }            (default: 'bottom')
  //
  // Most toasts (admin actions, status messages) stay at the bottom. High-
  // frequency interactions like lineup add/remove use 'top' so the toast
  // doesn't fight with the bottom-nav for attention each tap.
  const showToast = useCallback((message, type = 'success', options = {}) => {
    const id = Date.now() + Math.random();
    const position = options.position === 'top' ? 'top' : 'bottom';
    setToasts(prev => [...prev, { id, message, type, position }]);
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

  // ── Escape, scroll lock and focus trap ────────────────────────────────────
  // Was a bare Escape listener. The dialog is the app's only confirmation
  // gate — deleting a team, reversing a transaction — and Tab walked straight
  // out of it into the page behind, so a keyboard user could be operating the
  // roster underneath while a "Delete this team?" prompt was still up.
  const confirmRef = useRef(null);
  const cancelResult = useCallback(() => handleResult(false), [handleResult]);
  useModalBehavior(!!confirm, cancelResult, confirmRef);

  // Toast accent colors
  const toastAccent = (type) => {
    if (type === 'success') return { bg: 'rgba(40,100,60,0.95)',  border: greenMuted(0.4),  icon: colors.success };
    if (type === 'error')   return { bg: 'rgba(100,30,30,0.95)',  border: 'rgba(200,70,70,0.4)',   icon: colors.danger  };
    if (type === 'warning') return { bg: 'rgba(100,80,20,0.95)',  border: 'rgba(200,170,60,0.4)',  icon: colors.warning };
    return                         { bg: 'rgba(20,40,90,0.95)',   border: steel(0.4), icon: blue(0.9) };
  };

  const ToastIcon = (type) => type === 'success' ? Check : type === 'error' ? AlertCircle : Clock;

  return (
    <DialogContext.Provider value={{ showToast, showConfirm }}>
      {children}

      {/* ── Toast stacks ── render two stacks so 'top' and 'bottom' positioned
           toasts each live in their own container without colliding. */}
      {['top', 'bottom'].map(stackPos => {
        const stackToasts = toasts.filter(t => (t.position || 'bottom') === stackPos);
        if (!stackToasts.length) return null;
        const containerStyle = stackPos === 'top'
          ? {
              position: 'fixed',
              top: 'calc(8px + env(safe-area-inset-top))',  // overlay the header (toast zIndex 100 > header 50)
              left: '50%', transform: 'translateX(-50%)',
              zIndex: 100, display: 'flex', flexDirection: 'column', gap: 8,
              pointerEvents: 'none',
              width: '100%', maxWidth: 360, padding: '0 16px',
            }
          : {
              position: 'fixed',
              bottom: 'calc(96px + env(safe-area-inset-bottom))',  // clear bottom-nav
              left: '50%', transform: 'translateX(-50%)',
              zIndex: 100, display: 'flex', flexDirection: 'column', gap: 8,
              pointerEvents: 'none',
              width: '100%', maxWidth: 360, padding: '0 16px',
            };
        return (
          <div key={stackPos} style={containerStyle}>
            {stackToasts.map(toast => {
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
                  boxShadow: `0 8px 32px ${black(0.4)}`,
                  backdropFilter: 'blur(8px)',
                  animation: stackPos === 'top' ? 'sfgl-slideDown 0.25s ease-out' : 'sfgl-slideUp 0.25s ease-out',
                }}>
                  <Icon style={{ width: 14, height: 14, color: accent.icon, flexShrink: 0 }} />
                  <span style={{ fontFamily: fonts.sans, fontSize: fontSize.base, color: colors.textPrimary, flex: 1 }}>
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
        );
      })}

      {/* ── Confirm dialog ── */}
      {confirm && (
        <div
          style={{
            position: 'fixed', inset: 0,
            background: scrim(0.82), backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 100, padding: 16,
          }}
          onClick={() => handleResult(false)}
        >
          <div
            style={{
              background: '#0f1d35',
              border: `1px solid ${
                confirm.type === 'danger'  ? colors.dangerBorder  :
                confirm.type === 'warning' ? colors.warningBorder :
                colors.border
              }`,
              borderRadius: 3,
              boxShadow: `0 24px 80px ${black(0.6)}`,
              maxWidth: 420, width: '100%',
              padding: '24px 26px',
              animation: 'sfgl-scaleIn 0.18s ease-out',
            }}
            ref={confirmRef}
            onClick={e => e.stopPropagation()}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="sfgl-confirm-title"
            aria-describedby="sfgl-confirm-message"
            tabIndex={-1}
          >
            {/* Title */}
            <h3 id="sfgl-confirm-title" style={{
              ...theme.h2,
              marginBottom: 10,
              color:
                confirm.type === 'danger'  ? colors.danger  :
                confirm.type === 'warning' ? colors.warning :
                colors.textPrimary,
            }}>
              {confirm.title}
            </h3>

            {/* Message */}
            <p id="sfgl-confirm-message" style={{
              fontFamily: fonts.sans, fontSize: fontSize.base,
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
                data-autofocus
                style={{
                  ...(
                    confirm.type === 'danger'  ? theme.btnDanger  :
                    confirm.type === 'warning' ? theme.btnWarning :
                    theme.btnPrimary
                  ),
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
