import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { visualizer } from 'rollup-plugin-visualizer'

// ANALYZE=1 npm run build (or `npm run analyze`) writes a treemap of the
// bundle to dist/stats.html. Open it in a browser to see what's making the
// bundle big — vendor libs (firebase, react, etc.) usually dominate, but
// after the Wave I refactor the app code itself should be split into clean
// lazy-loaded chunks (AdminView, TransactionsView).
//
// The plugin is only added in analyze mode so normal builds stay fast and
// don't write the extra stats artefact.
const isAnalyze = process.env.ANALYZE === '1';

export default defineConfig({
  plugins: [
    react(),
    isAnalyze && visualizer({
      filename: 'dist/stats.html',
      open: true,         // auto-open the report in the default browser
      gzipSize: true,     // show gzip sizes alongside raw — closer to what users download
      brotliSize: true,   // ditto for brotli (what Vercel actually serves)
      template: 'treemap',
    }),
  ].filter(Boolean),
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
})
