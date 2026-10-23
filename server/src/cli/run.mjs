// Runs a server command-line tool (npm run server:migrate, server:create-admin, server:after-restore):
// - production (NODE_ENV=production): the built bundle dist-server/<name>.mjs (npm run server:build);
// - otherwise: the TypeScript source through tsx, so development never needs a build first.
// Plain JavaScript on purpose: it must run before anything is compiled.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [name, ...args] = process.argv.slice(2)
if (!name || !/^[a-z-]+$/.test(name)) {
  console.error('Usage: node server/src/cli/run.mjs <migrate|create-admin|after-restore> [args]')
  process.exit(2)
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const bundle = path.join(root, 'dist-server', `${name}.mjs`)
const source = path.join(root, 'server', 'src', 'cli', `${name}.ts`)
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const production = process.env.NODE_ENV === 'production'

let argv
if ((production || !existsSync(tsx)) && existsSync(bundle)) argv = [bundle, ...args]
else if (existsSync(tsx) && existsSync(source)) argv = [tsx, source, ...args]
else {
  console.error(production ? `Missing ${bundle}. Run "npm run server:build" first.` : `Cannot run ${name}: install dependencies with "npm ci".`)
  process.exit(1)
}

const child = spawn(process.execPath, argv, { stdio: 'inherit', cwd: root })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
