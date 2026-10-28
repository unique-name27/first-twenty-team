// `npm run stack`: the whole app for development in one command (docs/DEV.md), on Windows, macOS, Linux
// and in GitHub Codespaces.
//
//   1. a data folder, .data/dev (git-ignored), holding a PGlite database in pg/
//   2. migrations, a dev login made once (dev@example.test, random password, kept only in
//      .data/dev/credentials.json) and, while the workspace is empty, the Ledgerlark sample company
//      (scripts/dev/prepare.ts; it finishes before the API starts, because PGlite allows one process per folder)
//   3. the API (tsx watch, restarts on server changes), then, once it answers, the Vite dev server, their
//      logs prefixed. The API runs the development entry, server/src/dev/index.ts: the same server plus
//      development-only routes, unlocked by a secret made for this run (dev-tools.json, for npm run sql)
//   4. the address to open; the app signs itself in there (src/dev/autoconnect.ts)
//
// Ctrl+C stops both. Flags: --fresh, --offset N, --no-seed (stack-lib.mjs USAGE). The pure parts live in
// stack-lib.mjs, with tests. Plain JavaScript, so it runs before anything is compiled.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { apiEnv, appOrigin, DEV_EMAIL, DEV_TOOLS_FILE, devDirName, parseArgs, stackPorts, USAGE } from './stack-lib.mjs'
import { isStackProcess, readStackPid } from './stack-process.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const windows = process.platform === 'win32'
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')

const say = (message) => console.log(`stack: ${message}`)
const die = (message) => {
  console.error(`stack: ${message}`)
  process.exit(1)
}

let args
try {
  args = parseArgs(process.argv.slice(2))
} catch (err) {
  console.error(`stack: ${err.message}\n\n${USAGE}`)
  process.exit(2)
}
if (args.help) {
  console.log(USAGE)
  process.exit(0)
}
if (!existsSync(tsx) || !existsSync(vite)) die('dependencies are missing: run npm ci first.')

const ports = stackPorts(args.offset)
const devDir = devDirName(args.offset)
const dir = path.join(root, devDir)
const pidFile = path.join(dir, 'stack.pid')
const credentialsFile = path.join(dir, 'credentials.json')
const devToolsFile = path.join(dir, DEV_TOOLS_FILE)
const offsetFlag = args.offset ? ` -- --offset ${args.offset}` : ''

// ------------------------------------------------------------------------------------------------
// One stack per data folder
// ------------------------------------------------------------------------------------------------

/** The pid file of a stack that is still running, or null (a stale file is removed, with its dev tools secret). */
function runningStack() {
  if (!existsSync(pidFile)) return null
  const info = readStackPid(pidFile)
  // This process and its parent (npm's shell) may hold the old pid after a restart; neither is another stack.
  if (info && info.pid !== process.pid && info.pid !== process.ppid && isStackProcess(info.pid)) return info
  rmSync(pidFile, { force: true })
  rmSync(devToolsFile, { force: true })
  return null
}

/** Resolves true when nothing listens on `port` at 127.0.0.1. */
function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen({ port, host: '127.0.0.1', exclusive: true })
  })
}

const running = runningStack()
if (running?.holder === 'npm run sim') {
  die(`npm run sim is writing to this data folder (pid ${running.pid}). Start the stack again when it has finished.`)
}
if (running) {
  die(
    `a stack is already running on this data folder (pid ${running.pid}, started ${running.startedAt}).\n` +
      `  Stop it with Ctrl+C in its terminal, or start another one beside it with npm run stack -- --offset ${args.offset + 10}.\n` +
      `  If it is not running any more, delete ${path.relative(root, pidFile)} and try again.`,
  )
}

for (const [port, what] of [
  [ports.app, 'the app'],
  [ports.api, 'the API'],
]) {
  if (!(await portFree(port))) {
    die(
      `port ${port} (${what}) is already in use. Stop whatever runs there (npm run dev, npm run server:dev or ` +
        `another stack), or use other ports: npm run stack -- --offset ${args.offset + 10}`,
    )
  }
}

if (args.fresh) {
  rmSync(dir, { recursive: true, force: true })
  say(`--fresh: deleted ${devDir}`)
}
mkdirSync(dir, { recursive: true })
writeFileSync(pidFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), ports }))

// ------------------------------------------------------------------------------------------------
// Database, dev login, sample company
// ------------------------------------------------------------------------------------------------

/** The dev login, made once. stackId changes with every new login, so browsers sign in again after --fresh. */
if (!existsSync(credentialsFile)) {
  const credentials = {
    email: DEV_EMAIL,
    password: randomBytes(18).toString('base64url'),
    stackId: randomBytes(9).toString('base64url'),
    createdAt: new Date().toISOString(),
    note: 'Development only: the dev login for this computer\'s npm run stack database. Never use it anywhere else.',
  }
  writeFileSync(credentialsFile, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 })
}

const serverEnv = apiEnv(process.env, { apiPort: ports.api, appPort: ports.app, devDir })
const setup = spawnSync(process.execPath, [tsx, 'scripts/dev/prepare.ts', '--dir', devDir, ...(args.seed ? [] : ['--no-seed'])], {
  cwd: root,
  env: serverEnv,
  stdio: 'inherit',
})
if (setup.status !== 0) {
  rmSync(pidFile, { force: true })
  die(`setting up the database failed (see above). npm run stack -- --fresh${args.offset ? ` --offset ${args.offset}` : ''} starts over.`)
}

// ------------------------------------------------------------------------------------------------
// The API and the app
// ------------------------------------------------------------------------------------------------

const color = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text)

/** @type {Map<string, import('node:child_process').ChildProcess>} */
const children = new Map()
let stopping = false

/** Starts a child process with its output prefixed line by line. */
function start(name, colorCode, argv, env) {
  const child = spawn(process.execPath, argv, {
    cwd: root,
    env: { ...env, ...(color ? { FORCE_COLOR: '1' } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Unix: its own process group, so Ctrl+C reaches this script only and stop() ends each child's whole
    // tree (tsx watch runs the server as a grandchild). Windows has no groups (detached would open a new
    // console window): Ctrl+C reaches every process in the console, and stop() uses taskkill /T.
    detached: !windows,
  })
  const prefix = paint(colorCode, `[${name}]`.padEnd(6))
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream }).on('line', (line) => console.log(`${prefix} ${line}`))
  }
  child.on('exit', (code, signal) => {
    children.delete(name)
    if (!stopping) {
      console.error(`stack: ${name} stopped (${signal ?? `exit code ${code}`}), so the stack stops too.`)
      void stop(1, false)
    }
  })
  children.set(name, child)
  return child
}

/** Ends a child's process tree: politely first (signal), by force when `force`. */
function end(child, force) {
  if (child.pid === undefined) return
  try {
    if (windows) {
      if (force) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else process.kill(-child.pid, force ? 'SIGKILL' : 'SIGINT')
  } catch {
    /* already gone */
  }
}

/**
 * Stops both children and exits. fromCtrlC: on Windows the children got Ctrl+C from the console too, so
 * they are given a moment to shut down (the API closes its database) before taskkill.
 */
async function stop(code, fromCtrlC) {
  if (stopping) return
  stopping = true
  say('stopping...')
  const exited = [...children.values()].map((child) => new Promise((resolve) => child.once('exit', resolve)))
  if (!windows) for (const child of children.values()) end(child, false)
  if (!windows || fromCtrlC) await Promise.race([Promise.all(exited), new Promise((resolve) => setTimeout(resolve, 5000))])
  for (const child of children.values()) end(child, true)
  children.clear()
  rmSync(pidFile, { force: true })
  rmSync(devToolsFile, { force: true })
  process.exit(code)
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', ...(windows ? ['SIGBREAK'] : [])]) {
  process.on(signal, () => void stop(0, signal === 'SIGINT' || signal === 'SIGBREAK'))
}
// However this script ends (an error included), the children end with it: a leftover API would keep the
// database folder and the ports busy.
process.on('exit', () => {
  for (const child of children.values()) end(child, true)
  rmSync(devToolsFile, { force: true })
})

/** Resolves once `url` answers with a status below 500, or false after `ms`. */
async function waitFor(url, ms) {
  const until = Date.now() + ms
  while (Date.now() < until && !stopping) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (res.status < 500) return true
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return false
}

/** Stops the stack unless `url` answers within 90 seconds. */
async function mustStart(what, url) {
  if (stopping || (await waitFor(url, 90_000)) || stopping) return
  console.error(`stack: ${what} did not start within 90 seconds (see its log above).`)
  await stop(1, false)
}

// The secret for the API's development-only routes (server/src/dev/routes.ts), new every run: the API gets
// it in its environment, npm run sql from this file (the Vite dev server never serves .data/).
const devToolsSecret = randomBytes(32).toString('base64url')
const devTools = {
  secret: devToolsSecret,
  startedAt: new Date().toISOString(),
  note: 'Development only: lets npm run sql ask this stack\'s API. Made anew each time the stack starts, deleted when it stops.',
}
writeFileSync(devToolsFile, `${JSON.stringify(devTools, null, 2)}\n`, { mode: 0o600 })

start('api', '36', [tsx, 'watch', '--clear-screen=false', 'server/src/dev/index.ts'], { ...serverEnv, DEV_TOOLS_SECRET: devToolsSecret })
// The app starts once the API answers. A codespace opens the browser tab as soon as the app's port
// listens, and the automatic sign-in on that first load needs the API.
await mustStart('the API', `http://127.0.0.1:${ports.api}/api/health`)
if (!stopping) {
  // The same command as npm run dev, on this stack's port; the proxy and the dev sign-in follow the env.
  start('app', '35', ['--max-semi-space-size=64', vite, '--port', String(ports.app), '--strictPort', '--host', '127.0.0.1', '--clearScreen', 'false'], {
    ...process.env,
    FIRST_TWENTY_API_PORT: String(ports.api),
    FIRST_TWENTY_DEV_DIR: devDir,
  })
  await mustStart('the app', `http://127.0.0.1:${ports.app}/`)
}
if (!stopping) {
  const url = appOrigin(process.env, ports.app)
  console.log(
    [
      '',
      paint('1', '  First Twenty is running.'),
      `  Open      ${paint('4', url)}`,
      `  Login     ${DEV_EMAIL}: the app signs itself in (password in ${path.relative(root, credentialsFile)})`,
      `  API       http://127.0.0.1:${ports.api} (Vite passes /api through to it)`,
      `  Data      ${devDir} (npm run stack${offsetFlag ? `${offsetFlag} --fresh` : ' -- --fresh'} starts over)`,
      `  SQL       npm run sql${offsetFlag ? `${offsetFlag}` : ' --'} hires (read only; docs/DEV.md)`,
      `  Simulate  npm run sim${offsetFlag ? `${offsetFlag}` : ' --'} reset full-20 (another company; docs/DEV.md)`,
      '  Stop      Ctrl+C',
      '',
    ].join('\n'),
  )
}
