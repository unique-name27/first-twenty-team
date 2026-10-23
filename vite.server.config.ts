// `npm run server:build`: bundles the API server and its command-line tools into dist-server/ as ESM
// (.mjs) for Node 22+. Runtime dependencies (fastify, pg, @fastify/*) stay external and load from
// node_modules; on EC2 a full `npm ci` is needed (not --omit=dev) because the build runs there too.
// The shared src/sync/collections.ts is bundled in. The SQL migrations are copied to dist-server/sql.
// The browser app is built separately by `npm run build` (vite.config.ts).
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

function copyMigrations(): Plugin {
  const dir = new URL('./server/sql/', import.meta.url)
  return {
    name: 'first-twenty:copy-migrations',
    generateBundle() {
      for (const file of readdirSync(dir).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))) {
        this.emitFile({ type: 'asset', fileName: `sql/${file}`, source: readFileSync(new URL(file, dir), 'utf8') })
      }
    },
  }
}

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  define: {
    __FT_SERVER_VERSION__: JSON.stringify(pkg.version),
  },
  publicDir: false,
  plugins: [copyMigrations()],
  build: {
    ssr: true,
    outDir: 'dist-server',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: true,
    rolldownOptions: {
      input: {
        server: 'server/src/index.ts',
        migrate: 'server/src/cli/migrate.ts',
        'create-admin': 'server/src/cli/create-admin.ts',
        'after-restore': 'server/src/cli/after-restore.ts',
      },
      output: {
        format: 'es',
        entryFileNames: '[name].mjs',
        // Shared code sits next to the entries, so import.meta.url finds dist-server/sql from any chunk.
        chunkFileNames: '[name]-[hash].mjs',
      },
    },
  },
})
