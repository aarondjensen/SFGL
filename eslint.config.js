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
  globalIgnores(['dist', 'node_modules']),

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

  // JavaScript / JSX (the entire src/ tree)
  {
    files: ['**/*.{js,jsx}'],
    ignores: ['api/**'],   // serverless functions get their own Node block below
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

  // Vercel serverless functions (api/) — plain Node, no React, no browser
  // globals. Previously these were globalIgnored and never linted at all.
  {
    files: ['api/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',   // `catch (_)` is the api/ convention
        ignoreRestSiblings: true,
      }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
])
