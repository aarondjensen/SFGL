import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
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
    // main.tsx renders <App /> in JSX, so it needs the same jsx-uses-vars
    // treatment as the .jsx tree — without it, `App` and `StrictMode` read as
    // unused imports here too.
    plugins: { react },
    settings: { react: { version: 'detect' } },
    rules: {
      'react/jsx-uses-vars': 'error',
    },
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
    // eslint-plugin-react is registered for exactly ONE rule: jsx-uses-vars.
    // We deliberately do NOT extend its `recommended` config — that adds
    // prop-types/display-name/etc., which this codebase doesn't use and which
    // would bury real findings under a new pile of noise. See the rules block.
    plugins: { react },
    settings: { react: { version: 'detect' } },
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
      // ── Why this rule is load-bearing ──────────────────────────────────
      // ecmaFeatures.jsx only lets ESLint *parse* JSX. Core `no-unused-vars`
      // walks the scope graph and never counts a JSXIdentifier as a
      // reference, so without this rule every component and icon imported
      // solely for use in markup reads as unused: StandingsView, RostersView,
      // LoadingScreen, App itself, and every lucide-react icon — ~130 false
      // positives that made `npm run lint` useless for finding the ~15
      // genuinely dead symbols mixed in with them.
      //
      // The previous config tried to solve this with `ignoreRestSiblings`
      // (see the no-unused-vars options below). That option governs object
      // REST DESTRUCTURING (`const { a, ...rest } = obj`) and has nothing to
      // do with JSX; it never suppressed a single one of those warnings.
      'react/jsx-uses-vars': 'error',
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
        // ESLint 9 defaults caughtErrors to 'all', so the codebase-wide
        // `catch (_) {}` idiom was reported as an unused variable — the one
        // pattern varsIgnorePattern does NOT cover.
        caughtErrorsIgnorePattern: '^_',
        // Allows `const { failReason, ...rest } = tx` — the omit-a-field
        // idiom used in TransactionsView's re-queue path — without flagging
        // the omitted binding. (JSX usage is handled by react/jsx-uses-vars
        // above, NOT by this option.)
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
        // ESLint 9 defaults caughtErrors to 'all', so the codebase-wide
        // `catch (_) {}` idiom was reported as an unused variable — the one
        // pattern varsIgnorePattern does NOT cover.
        caughtErrorsIgnorePattern: '^_',
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
