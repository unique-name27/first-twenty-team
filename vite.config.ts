import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// `npm run build` emits one self-contained first-twenty.html (double-click to open, no server).
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [react(), tailwindcss(), ...(mode === 'single' ? [viteSingleFile({ removeViteModuleLoader: true })] : [])],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    allowedHosts: ['.localhost'],
    // `npm run server:dev` listens here; the app calls /api same-origin through this proxy.
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false } },
  },
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    chunkSizeWarningLimit: 4000,
    assetsInlineLimit: mode === 'single' ? 100_000_000 : 4096,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/careers/**/*.test.ts', 'server/src/**/*.test.ts', 'server/deploy/**/*.test.ts'],
    testTimeout: 20_000,
  },
}))
