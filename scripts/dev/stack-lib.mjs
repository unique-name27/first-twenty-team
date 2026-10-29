// The pure parts of `npm run stack` (scripts/dev/stack.mjs), kept here so tests can import them and
// vite.config.ts can share them: argument parsing, ports, the dev data folder, the address the browser
// opens (a GitHub Codespaces forwarded address or 127.0.0.1) and the API's settings. No file, network or
// process access. Types for TypeScript callers are in stack-lib.d.mts.
import path from 'node:path'

/** The ports `npm run dev` and `npm run server:dev` use; --offset N adds N to both. */
export const APP_PORT = 8826
export const API_PORT = 8787

/** The highest --offset: keeps both ports below 65536 and away from nonsense values. */
export const MAX_OFFSET = 1000

/** The dev login `npm run stack` creates once. Its password is random and lives in credentials.json only. */
export const DEV_EMAIL = 'dev@example.test'

/**
 * The file in the stack's data folder that holds the secret for the API's development-only routes
 * (server/src/dev/routes.ts), which `npm run sql` reads. The stack makes a new secret every time it starts
 * and deletes the file when it stops. The Vite dev server never serves .data/ (DEV_FS_DENY), and
 * /__dev/credentials reads credentials.json only.
 */
export const DEV_TOOLS_FILE = 'dev-tools.json'

/** How to run the stack, for --help and for argument errors. */
export const USAGE = `Usage: npm run stack
       npm run stack -- [--fresh] [--offset N] [--no-seed]

  --fresh       delete this stack's data folder (database and dev login) and start over
  --offset N    add N to both ports (app ${APP_PORT}+N, API ${API_PORT}+N), with a data folder of its own,
                so two stacks can run side by side
  --no-seed     leave a new database empty instead of loading the Ledgerlark sample company
  --help        show this text`

/**
 * The command-line flags, or an Error whose message says what is wrong (the caller prints USAGE too).
 * @param {readonly string[]} argv process.argv.slice(2)
 * @returns {{ fresh: boolean, offset: number, seed: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  const out = { fresh: false, offset: 0, seed: true, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--fresh') out.fresh = true
    else if (arg === '--no-seed') out.seed = false
    else if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--offset' || arg.startsWith('--offset=')) {
      const raw = arg === '--offset' ? argv[++i] : arg.slice('--offset='.length)
      out.offset = parseOffset(raw)
    } else throw new Error(`Unknown option "${arg}".`)
  }
  return out
}

/**
 * @param {string | undefined} raw
 * @returns {number}
 */
function parseOffset(raw) {
  if (raw === undefined || !/^\d+$/.test(raw)) throw new Error(`--offset needs a whole number, like --offset 10 (got "${raw ?? ''}").`)
  const n = Number(raw)
  if (n > MAX_OFFSET) throw new Error(`--offset must be at most ${MAX_OFFSET} (got ${n}).`)
  return n
}

/**
 * The two ports for an offset.
 * @param {number} offset
 * @returns {{ app: number, api: number }}
 */
export function stackPorts(offset) {
  return { app: APP_PORT + offset, api: API_PORT + offset }
}

/**
 * The stack's data folder, relative to the repo root (inside .data/, which git ignores). Each offset gets
 * its own, because PGlite lets only one process open a database folder.
 * @param {number} offset
 * @returns {string}
 */
export function devDirName(offset) {
  return offset === 0 ? '.data/dev' : `.data/dev-${offset}`
}

/**
 * The address a GitHub Codespaces browser uses for a forwarded port
 * (https://<CODESPACE_NAME>-<port>.<GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN>), or null outside a codespace.
 * @param {Record<string, string | undefined>} env
 * @param {number} port
 * @returns {string | null}
 */
export function codespaceOrigin(env, port) {
  if (env.CODESPACES !== 'true') return null
  const name = env.CODESPACE_NAME?.trim()
  const domain = forwardingDomain(env)
  if (!name || !domain || !/^[a-z0-9-]+$/i.test(name)) return null
  return `https://${name.toLowerCase()}-${port}.${domain}`
}

/**
 * The Codespaces port-forwarding domain (app.github.dev), lowercase, or null when unset or not a host name.
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
function forwardingDomain(env) {
  const domain = env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN?.trim().toLowerCase()
  return domain && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? domain : null
}

/**
 * The address to open the app at: the codespace's forwarded address, else the Vite server itself.
 * @param {Record<string, string | undefined>} env
 * @param {number} port
 * @returns {string}
 */
export function appOrigin(env, port) {
  return codespaceOrigin(env, port) ?? `http://127.0.0.1:${port}`
}

/**
 * Extra host names the Vite dev server must accept (server.allowedHosts). In a codespace the browser
 * sends Host: <name>-<port>.app.github.dev, which Vite refuses by default; '.app.github.dev' allows that
 * domain and every name under it, so any port and any --offset work. Empty outside a codespace.
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function codespaceAllowedHosts(env) {
  if (env.CODESPACES !== 'true') return []
  const domain = forwardingDomain(env)
  return domain ? [`.${domain}`] : []
}

/**
 * Files the Vite dev server must never serve (server.fs.deny). Vite serves any file under the repo root,
 * so .data/ (the PGlite databases and the stack's dev login) is on the list: the dev login is handed out
 * only by /__dev/credentials, with its checks (scripts/dev/credentials.ts). Setting server.fs.deny
 * replaces Vite's own list instead of adding to it, so the first entries repeat Vite's defaults
 * (stack-lib.test.ts checks they still match).
 */
export const DEV_FS_DENY = ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**', '**/.data/**']

/**
 * True when a process's command line (Linux /proc/<pid>/cmdline: arguments separated by NUL) holds a stack's
 * data folder: node with scripts/dev/stack.mjs as one argument, or npm run sim (scripts/dev/sim.ts), which
 * takes the stack's pid file while it writes to the folder with no stack running. A shell wrapper
 * (sh -c "node scripts/dev/stack.mjs", as npm starts it) does not count, so the stack never mistakes its own
 * parent for another stack.
 * @param {string} cmdline
 * @returns {boolean}
 */
export function isStackCommandLine(cmdline) {
  return cmdline.split('\0').some((arg) => /(^|[\\/])scripts[\\/]dev[\\/](stack\.mjs|sim\.ts)$/.test(arg))
}

/**
 * The API port the Vite proxy sends /api to: FIRST_TWENTY_API_PORT (set by the stack for --offset), else 8787.
 * @param {Record<string, string | undefined>} env
 * @returns {number}
 */
export function apiPortFromEnv(env) {
  const raw = env.FIRST_TWENTY_API_PORT?.trim()
  const n = raw && /^\d+$/.test(raw) ? Number(raw) : NaN
  return n > 0 && n < 65536 ? n : API_PORT
}

/**
 * The environment the API process runs with: development mode on the stack's own PGlite folder, open
 * sign-up (team members can try making companies), the scripted assistant and PUBLIC_ORIGIN set to the
 * address the browser opens, so invite links point there and, in a codespace (https), the sign-in
 * cookies are Secure __Host- cookies, as on the live server.
 *
 * ALLOWED_ORIGIN is emptied: the browser reaches the API through the Vite proxy, same-origin, so no
 * cross-origin access is needed. ANTHROPIC_API_KEY is emptied too: a codespace may carry one for Claude
 * Code, and the stack's assistant never spends it. Both are set to '' rather than removed, because the
 * server fills unset variables from a .env file (config.ts loadDotEnv) and an empty one counts as set.
 * LOG_LEVEL defaults to warn (every request otherwise logs a line); set it in the environment to see more.
 * DEV_TOOLS=1 lets the development entry (server/src/dev/index.ts) add its routes; the stack passes their
 * secret to the API process alone (DEV_TOOLS_SECRET), never through this function.
 * @param {Record<string, string | undefined>} base usually process.env
 * @param {{ apiPort: number, appPort: number, devDir: string }} stack devDir relative to the repo root
 * @returns {Record<string, string | undefined>}
 */
export function apiEnv(base, stack) {
  return {
    ...base,
    ALLOWED_ORIGIN: '',
    ANTHROPIC_API_KEY: '',
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: String(stack.apiPort),
    DATABASE_URL: `pglite:${path.posix.join(stack.devDir, 'pg')}`,
    PUBLIC_ORIGIN: appOrigin(base, stack.appPort),
    SERVE_APP: 'false',
    MIGRATE_ON_START: 'true',
    SIGNUP_MODE: 'open',
    ASSISTANT_FAKE: '1',
    DEV_TOOLS: '1',
    LOG_LEVEL: base.LOG_LEVEL?.trim() || 'warn',
  }
}
