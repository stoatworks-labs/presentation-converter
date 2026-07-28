import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
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
