import type { CapacitorConfig } from '@capacitor/cli';

// ─────────────────────────────────────────────────────────────────────────────
// SFGL native app configuration (Capacitor 8)
//
// MODEL: "live-load" — the native iOS/Android shell loads the deployed site at
// server.url. This means:
//   • You keep deploying to Vercel exactly as you do now.
//   • The apps pick up every change instantly, with NO app-store resubmission.
//   • You only rebuild/resubmit the native app when NATIVE config changes
//     (new plugins, push notifications, app icon, etc.) — rarely.
//
// appId is the permanent identifier registered in App Store Connect (iOS) and
// Google Play Console (Android). On Android this CANNOT be changed once the app
// is published, so it is locked in here deliberately.
// ─────────────────────────────────────────────────────────────────────────────

const config: CapacitorConfig = {
  appId: 'com.sfglgolf.app',
  appName: 'SFGL',

  // Required to exist for `npx cap sync`, even though server.url overrides what
  // actually loads. Run `npm run build` once so this folder is present.
  webDir: 'dist',

  server: {
    // The live production site. Must be the www host (matches your existing
    // baseUrl convention; the bare domain 307-redirects).
    url: 'https://www.sfglgolf.com',
    cleartext: false,
  },
};

export default config;
