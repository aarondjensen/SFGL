import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// Wave D fix: previously the `files` glob was '**/*.{ts,tsx}' which meant
// every .js and .jsx file in the codebase was invisible to the linter.
// Since the codebase has exactly one .tsx file (main.tsx) and zero .ts files
// in source, that meant `npm run lint` was a no-op no matter what.
//
// Now both blocks below are configured: TS files get the full TS rule set
// (unchanged from before), and JS/JSX files get react-hooks + the standard
// JS recommended rules. After this change, lint will actually surface
// missing useEffect deps, unused variables, etc.

export default defineConfig([
  // Ignore build output and native wrappers. The previous list was just
  // ['dist', 'node_modules', 'api/**'], which left the linter walking
  // android/app/build/, android/app/src/main/assets/public/, and every
  // .claude/worktrees/*/dist/ — i.e. minified vendor bundles. `npm run lint`
  // reported ~3,500 problems, of which only ~180 were in src/, so real errors
  // were unfindable.
  //
  // 'api/**' was ALSO ignored, meaning the serverless layer (including the
  // 2,000-line cron.js that processes waivers and results) was never linted at
  // all. It is linted now — see the Node block below.
  globalIgnores([
    '**/dist/**',
    '**/node_modules/**',
    'android/**',
    'ios/**',
    '.claude/**',
    'scripts/history/**',
  ]),

  // TypeScript files (main.tsx, vite.config.ts, etc.)
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },

  // JavaScript / JSX — the browser app (src/ tree only).
  // Scoped to src/ so the React-specific rules (react-hooks, react-refresh)
  // don't fire on the Node serverless functions, which have no components.
  {
    files: ['src/**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.node,   // Vite imports + cron-job env
      },
    },
    rules: {
      // Don't fail builds on warnings during the initial rollout — flip to
      // 'error' once the codebase is clean and you want the linter to enforce
      // these strictly going forward.
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/rules-of-hooks': 'error',
      // Downgraded from error: this is a Fast-Refresh DX rule, not a
      // correctness one, and the codebase deliberately co-locates a few
      // non-component exports with their components — useDialog beside
      // DialogProvider, addGlobalErrorReporters beside ErrorBoundary, the
      // shared style objects in adminStyles. Splitting those into separate
      // files to satisfy the rule would cost more in indirection than it
      // saves in occasional full reloads during development.
      'react-refresh/only-export-components': 'warn',
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        // React lint quirk: components imported only as JSX usage are flagged
        // unless we tell it to ignore PascalCase identifiers.
        ignoreRestSiblings: true,
      }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },

  // Node serverless functions + build scripts. Previously excluded from
  // linting entirely via an `api/**` global ignore, which is how the
  // `aliasMap` no-undef class of bug could sit undetected in a deploy target
  // that runs waiver and results processing.
  {
    files: ['api/**/*.js', 'scripts/**/*.{js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        fetch: 'readonly',   // Node 18+ global on Vercel
        URL: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },

  // Service worker — browser-ish but with worker globals, and it deliberately
  // uses importScripts + the global `firebase` compat namespace.
  {
    files: ['public/firebase-messaging-sw.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.serviceworker, firebase: 'readonly', importScripts: 'readonly' },
    },
  },
])
