import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
// The rest of the fleet uses @electron-toolkit/eslint-config-prettier, which
// bundles eslint-plugin-prettier and so reports formatting drift as lint
// errors. This repo predates the shared prettier settings and would need ~930
// lines reflowed to satisfy it, so it takes plain eslint-config-prettier —
// same job of standing down the formatting-adjacent rules, no reformat.
import eslintConfigPrettier from 'eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      // Vendored/mastered elsewhere: the shared Stoatworks About-window assets
      // are plain JS mastered in stoatworks-backend, and the Nextcloud app's JS
      // is loaded by Nextcloud's own runtime, not built here.
      'packages/web/public/**',
      'nextcloud/**'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    // Plain JavaScript — the screenshot script and any future build helper.
    // The TypeScript-only rules in the shared config have nothing to say here.
    files: ['**/*.{js,mjs,cjs}'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  eslintConfigPrettier
)
