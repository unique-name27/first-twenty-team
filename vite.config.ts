import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { defaultExclude } from 'vitest/config'
import { devCredentials } from './scripts/dev/credentials.ts'
import { apiPortFromEnv, codespaceAllowedHosts, DEV_FS_DENY } from './scripts/dev/stack-lib.mjs'
import { TIERS } from './scripts/test/tiers.ts'

const root = fileURLToPath(new URL('.', import.meta.url))

// `npm run build` emits one self-contained first-twenty.html (double-click to open, no server).
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    // Development only (apply: 'serve'): GET /__dev/credentials for the dev auto sign-in (docs/DEV.md).
    devCredentials(root),
    ...(mode === 'single' ? [viteSingleFile({ removeViteModuleLoader: true })] : []),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    // In GitHub Codespaces the browser comes in as <name>-8826.app.github.dev (docs/DEV.md).
    allowedHosts: ['.localhost', ...codespaceAllowedHosts(process.env)],
    // `npm run server:dev` listens here (`npm run stack -- --offset N` moves it); the app calls /api
    // same-origin through this proxy.
    proxy: { '/api': { target: `http://127.0.0.1:${apiPortFromEnv(process.env)}`, changeOrigin: false } },
    // Vite's own deny list plus .data/ (the dev databases and the stack's dev login), so no page can read
    // those files straight from the dev server (stack-lib.mjs DEV_FS_DENY says why).
    fs: { deny: DEV_FS_DENY },
    // PGlite writes to its files under .data/ all the time; none of them is app code to reload.
    watch: { ignored: ['**/.data/**'] },
  },
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    chunkSizeWarningLimit: 4000,
    assetsInlineLimit: mode === 'single' ? 100_000_000 : 4096,
  },
  test: {
    environment: 'node',
    testTimeout: 20_000,
    // Every run in UTC, as on the CI runners, whatever the computer's own time zone: some tests show a
    // timestamp as a date, and east of about UTC+5 that date is a day later.
    env: { TZ: 'UTC' },
    // One project per test tier (scripts/test/tiers.ts): `npm run test:unit`, `test:server`, `test:e2e`
    // and `test:deploy`. Each takes the settings above.
    projects: TIERS.map((tier) => ({
      extends: true,
      test: { name: tier.name, include: tier.include, exclude: [...defaultExclude, ...tier.exclude] },
    })),
  },
}))
