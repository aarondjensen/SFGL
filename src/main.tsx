import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './app-global.css'
import App from './App';

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
// Deferred via setTimeout so registration doesn't compete with the initial
// render for main-thread time. The first paint should be snappy; SW
// registration happening 100ms later doesn't affect user-perceived load.
if ('serviceWorker' in navigator) {
  // Use window.load timing for the most polite registration window.
  window.addEventListener('load', () => {
    setTimeout(() => {
      navigator.serviceWorker
        .register('/firebase-messaging-sw.js')
        .catch(err => console.warn('[sw] registration failed:', err?.message));
    }, 100);
  });
}
