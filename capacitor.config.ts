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

  plugins: {
    // Native Google / Apple sign-in. skipNativeAuth keeps the plugin from
    // signing into the native Firebase SDK — it only returns the credential,
    // which authApi.js hands to the JS SDK via signInWithCredential so the
    // web auth state (watchAuth) stays the single source of truth.
    FirebaseAuthentication: {
      skipNativeAuth: true,
      providers: ['google.com', 'apple.com'],
    },
  },

  // SPM build workaround: @capacitor-firebase/messaging needs symlinked
  // package options to resolve its Firebase iOS SDK dependency under Swift
  // Package Manager (same fix used in the MNQ build).
  experimental: {
    ios: {
      spm: {
        packageOptions: {
          '@capacitor-firebase/messaging': { symlink: true },
        },
      },
    },
  },
};

export default config;
