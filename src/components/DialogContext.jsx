import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import { X, Check, AlertCircle, Clock } from 'lucide-react';

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

  return (
    <DialogContext.Provider value={{ showToast, showConfirm }}>
      {children}

      {/* Toasts */}
      <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
        {toasts.map(toast => {
          const bg   = toast.type === 'success' ? 'bg-green-600' : toast.type === 'error' ? 'bg-red-600' : 'bg-blue-600';
          const Icon = toast.type === 'success' ? Check : toast.type === 'error' ? AlertCircle : Clock;
          return (
            <div key={toast.id} className={`${bg} text-white px-5 py-3 rounded-lg shadow-2xl flex items-center gap-3 max-w-sm pointer-events-auto animate-[slideIn_0.3s_ease-out]`}>
              <Icon className="w-4 h-4 flex-shrink-0" />
              <span className="text-sm flex-1">{toast.message}</span>
              <button onClick={() => removeToast(toast.id)} className="hover:bg-white/20 rounded p-0.5" aria-label="Dismiss">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>

      {/* Confirm dialog */}
      {confirm && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[100] p-4" onClick={() => handleResult(false)}>
          <div
            className="bg-gray-800 rounded-xl shadow-2xl max-w-md w-full p-6 border border-gray-700 animate-[scaleIn_0.2s_ease-out]"
            onClick={e => e.stopPropagation()}
            role="alertdialog"
          >
            <h3 className="text-lg font-bold mb-2">{confirm.title}</h3>
            <p className="text-gray-300 text-sm mb-6 whitespace-pre-line">{confirm.message}</p>
            <div className="flex gap-3">
              <button onClick={() => handleResult(false)} className="flex-1 py-2.5 bg-gray-700 hover:bg-gray-600 rounded-lg font-medium text-sm transition-colors">
                {confirm.cancelText  || 'Cancel'}
              </button>
              <button onClick={() => handleResult(true)} autoFocus className={`flex-1 py-2.5 rounded-lg font-medium text-sm transition-colors ${confirm.type === 'danger' ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700'}`}>
                {confirm.confirmText || 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        html { scrollbar-gutter: stable; }
        @keyframes slideIn { from { transform: translateX(100%); opacity:0; } to { transform: translateX(0); opacity:1; } }
        @keyframes scaleIn { from { transform: scale(0.95); opacity:0; } to { transform: scale(1); opacity:1; } }
      `}</style>
    </DialogContext.Provider>
  );
};
