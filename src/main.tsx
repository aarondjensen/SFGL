import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './app-global.css'
import App from './App';
import { registerMessagingSW } from './api/swRegistration';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// ── Service worker registration ────────────────────────────────────────────
// Registers /firebase-messaging-sw.js unconditionally so its shell-cache
// strategy applies to ALL users, not just those who've enabled push
// notifications. The same SW also handles FCM background pushes — that side
// is unaffected (push subscription still happens lazily in pushNotifications.js
// when the user opts in).
//
// Without this, the SW only registered when a user enabled notifications,
// meaning anyone who declined the prompt got zero benefit from shell caching
// — every PWA reopen re-downloaded the entire SPA bundle.
//
// Registration goes through api/swRegistration.js, which appends the Firebase
// web config to the SW URL — the SW can't read import.meta.env itself, and the
// hand-copied config block it used to carry shipped with unreplaced
// REPLACE_WITH_* placeholders. Both registration sites share that helper so
// there is exactly one registration.
//
// Deferred via setTimeout so registration doesn't compete with the initial
// render for main-thread time. The first paint should be snappy; SW
// registration happening 100ms later doesn't affect user-perceived load.
if ('serviceWorker' in navigator) {
  // Use window.load timing for the most polite registration window.
  window.addEventListener('load', () => {
    setTimeout(() => { registerMessagingSW(); }, 100);
  });
}
