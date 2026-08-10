import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { visualizer } from 'rollup-plugin-visualizer'
import { SEASON } from './api/_league.js'

// `npm run analyze` (= `vite build --mode analyze`) writes a treemap of the
// bundle to dist/stats.html and auto-opens it. After the Wave I refactor the
// app code itself is split into clean lazy-loaded chunks (AdminView,
// TransactionsView, LoginPage). The manualChunks config below additionally
// pulls vendor deps (Firebase, React, lucide-react) into their own chunks so:
//   • The main bundle stays under Vite's 500 KB warning threshold.
//   • Cache hits survive app-code redeploys (vendor chunks rarely change).
//   • HTTP/2 lets the browser fetch chunks in parallel — wall-clock load
//     time on first visit is no worse, and return visits are faster.
//
// The plugin is only added in analyze mode so normal `npm run build` stays
// fast and doesn't write the extra stats artefact. Using Vite's --mode flag
// (instead of an env var) is cross-platform — works on Windows PowerShell as
// well as macOS/Linux shells.
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    // Substitute %SFGL_SEASON% in index.html from the single SEASON constant.
    // index.html is static and can't import a module, so before this it carried
    // its own copy of the year — the last of the eleven hardcoded 2026s. Doing
    // it at build time rather than assigning document.title at runtime avoids a
    // frame of the stale year in the tab.
    {
      name: 'sfgl-html-season',
      transformIndexHtml: (html: string) =>
        html.replace(/%SFGL_SEASON%/g, String(SEASON)),
    },
    mode === 'analyze' && visualizer({
      filename: 'dist/stats.html',
      open: true,         // auto-open the report in the default browser
      gzipSize: true,     // show gzip sizes alongside raw — closer to what users download
      brotliSize: true,   // ditto for brotli (what Vercel actually serves)
      template: 'treemap',
    }),
  ].filter(Boolean),
  build: {
    rollupOptions: {
      output: {
        // ── Manual chunk splitting ─────────────────────────────────────────
        // Function form (not the object form) lets us split by package-name
        // matching, which is more robust than enumerating exact entry points
        // — Firebase ships dozens of submodules (firebase/app, firestore,
        // auth, etc.) and we want them all in the same chunk regardless of
        // which submodules the app code imports.
        manualChunks(id) {
          if (id.includes('node_modules')) {
            // Capacitor first, and deliberately so: @capacitor-firebase/* are
            // native bridges FOR Firebase, and they used to fall through to
            // vendor-misc while idb — a Firebase runtime dependency — landed
            // there too. That made the two chunks import each other
            // (vendor-firebase → idb → vendor-misc → @capacitor-firebase →
            // vendor-firebase) and rollup warned on every build. Splitting the
            // native bridges out and pulling idb in with the SDK it belongs to
            // leaves one direction of travel: capacitor → firebase.
            // ── Deliberately unassigned ──
            // These two are reached ONLY through dynamic imports: the native
            // Capacitor bridges from authApi/pushNotifications on iOS and
            // Android, and firebase/messaging from api/pushNotifications, which
            // now loads when the Notifications modal opens rather than at boot.
            //
            // Returning undefined hands them to rollup's own dynamic-import
            // splitting, which puts them in the chunk fetched at the moment
            // they are needed. Naming them here would defeat the point: a
            // manual chunk becomes a static dependency of the chunk that
            // references it, so both were downloaded on every first paint —
            // measured, not assumed. The web build never executes either one.
            if (
              id.includes('@capacitor-firebase') ||
              id.includes('@firebase/messaging') ||
              id.includes('/firebase/messaging/')
            ) {
              return;
            }
            if (id.includes('@capacitor')) {
              return 'vendor-capacitor';
            }
            if (id.includes('/firebase/') || id.includes('@firebase/') || id.includes('/idb/')) {
              return 'vendor-firebase';
            }
            if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) {
              return 'vendor-react';
            }
            if (id.includes('lucide-react')) {
              return 'vendor-icons';
            }
            // Other small deps (anything else from node_modules) go into a
            // generic vendor chunk. Keeps the main bundle to just app code.
            return 'vendor-misc';
          }
        },
      },
    },
  },
  server: {
    proxy: {
      // Proxy /api/* to the Vercel dev server in local development.
      // Run `vercel dev` instead of `npm run dev` to use the serverless functions locally.
      // If using `npm run dev`, requests to /api/ will fail — test on the deployed site instead.
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
}))
