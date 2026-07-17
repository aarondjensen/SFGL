import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { visualizer } from 'rollup-plugin-visualizer'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// public/firebase-messaging-sw.js is a template: service workers can't read
// Vite env vars, so its firebase.initializeApp() block contains
// REPLACE_WITH_VITE_FIREBASE_* placeholders. This plugin substitutes the real
// values from the environment (.env locally, project env vars on Vercel):
//   • build: Vite copies public/ verbatim into dist/, so after the bundle is
//     written we rewrite dist/firebase-messaging-sw.js in place.
//   • dev:   a middleware serves the substituted file at its root URL.
// A missing env var fails the build loudly — a placeholder reaching
// production means background push is silently broken.
function firebaseMessagingSw(env: Record<string, string>): Plugin {
  const inject = (source: string) =>
    source.replace(/REPLACE_WITH_(VITE_[A-Z0-9_]+)/g, (_match, key) => {
      const value = env[key]
      if (!value) {
        throw new Error(
          `firebase-messaging-sw.js: env var ${key} is not set — ` +
          'define it in .env (or Vercel project settings) so the service ' +
          'worker gets a real Firebase config.'
        )
      }
      return value
    })

  let root = process.cwd()
  let outDir = 'dist'
  let isBuild = false

  return {
    name: 'firebase-messaging-sw',
    configResolved(config) {
      root = config.root
      outDir = config.build.outDir
      isBuild = config.command === 'build'
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/firebase-messaging-sw.js') return next()
        const source = readFileSync(path.join(root, 'public/firebase-messaging-sw.js'), 'utf8')
        res.setHeader('Content-Type', 'text/javascript')
        res.end(inject(source))
      })
    },
    closeBundle() {
      if (!isBuild) return
      const outFile = path.resolve(root, outDir, 'firebase-messaging-sw.js')
      writeFileSync(outFile, inject(readFileSync(outFile, 'utf8')))
    },
  }
}

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
    firebaseMessagingSw(loadEnv(mode, process.cwd(), 'VITE_')),
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
            if (id.includes('/firebase/') || id.includes('@firebase/')) {
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
