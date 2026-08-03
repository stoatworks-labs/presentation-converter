import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

import { readFileSync } from 'node:fs'

// The ROOT package.json: this is a workspace, the release tag follows the root
// version, and a workspace copy drifts behind it silently.
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

export default defineConfig({
  // The About dialog shows the version the build actually produced. about-data.js
  // carries one baked at sync time as a fallback, and it goes stale the moment a
  // release is tagged; this is the one that is always right.
  define: { __APP_VERSION__: JSON.stringify(`v${pkg.version}`) },
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  server: {
    port: 4748,
    proxy: {
      // In dev the GUI runs on its own port; the API stays on the server's.
      '/api': {
        target: 'http://127.0.0.1:4747',
        changeOrigin: true
      }
    }
  }
})
