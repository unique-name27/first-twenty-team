// Server settings, read from environment variables (docs/SYNC.md). On EC2 they come from
// /etc/first-twenty/env (systemd EnvironmentFile); locally from an optional git-ignored .env file in the
// repo root. Nothing secret has a default: DATABASE_URL must be set in production.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigError } from './errors'

export type NodeEnv = 'production' | 'development' | 'test'

export type Config = {
  nodeEnv: NodeEnv
  port: number
  host: string
  /** postgres://... (production) or pglite:<dir> / pglite:memory (development and tests). */
  databaseUrl: string
  /** Resolved PGlite data directory, or 'memory'. Null when databaseUrl is a Postgres URL. */
  pgliteDir: string | null
  pgSslMode: string | undefined
  publicOrigin: string | undefined
  /**
   * PUBLIC_ORIGIN is https: every response gets HSTS and every cookie is Secure, under its __Host- name.
   * (app.ts does the same for any request that reached Caddy over https, whatever PUBLIC_ORIGIN says.)
   */
  secureCookies: boolean
  serveApp: boolean
  appFile: string
  /** Development only: one extra origin allowed to call the API with credentials (CORS). */
  allowedOrigin: string | undefined
  sessionIdleHours: number
  sessionMaxDays: number
  migrateOnStart: boolean
  /** Fastify trustProxy: which proxies may set X-Forwarded-For (default: loopback, i.e. Caddy). */
  trustProxy: string | boolean
  logLevel: string
  rootDir: string
  /**
   * SIGNUP_MODE. 'closed' (default): logins come from server:create-admin and invites only. 'open': a
   * public demo server, where anyone may create a login and a company of their own (POST /api/auth/signup).
   */
  signupMode: SignupMode
  /** DEMO_MAX_WORKSPACES: most demo companies (workspaces not kept) at once; sign-up answers 503 demo_full beyond. */
  demoMaxWorkspaces: number
  /** DEMO_EXPIRE_DAYS: a demo company with no write or sign-in for this many days is deleted (0: never). */
  demoExpireDays: number
  /**
   * DEMO_MAX_TOTAL_MB, in bytes: how much record and document data the demo companies may hold together
   * (each also holds at most validate.ts LIMITS.bytesPerDemoWorkspace). A write that would pass it gets
   * 413 workspace_full, so strangers can never fill the disk the owner's own workspace lives on.
   */
  demoMaxTotalBytes: number
  /** CAREERS_HOSTS, lowercase: host names that serve careers pages and nothing else (empty: careers off). */
  careersHosts: string[]
  /** CAREERS_ORIGIN (default https://<first careers host>): the origin careers links are built on. Undefined when careers are off. */
  careersOrigin: string | undefined
  /** The in-app assistant (server/src/assistant; docs/SERVER.md "Lark, the assistant"). */
  assistant: AssistantConfig
  /**
   * DEV_TOOLS=1, which only `npm run stack` sets: the development server (server/src/dev/index.ts) adds
   * its development-only routes, such as the one `npm run sql` asks. Refused in production.
   */
  devTools: boolean
}

export type SignupMode = 'closed' | 'open'

/** output_config.effort levels the assistant may run at (ASSISTANT_EFFORT). */
export const ASSISTANT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type AssistantEffort = (typeof ASSISTANT_EFFORTS)[number]

/**
 * The assistant's settings. The API key itself (ANTHROPIC_API_KEY) is deliberately not here: it never
 * leaves the environment except into the Anthropic client serve.ts builds (assistant/client.ts), so no log
 * line or answer that includes the config can carry it.
 */
export type AssistantConfig = {
  /** ANTHROPIC_API_KEY is set, or ASSISTANT_FAKE is on: GET /api/assistant says so and chats run. */
  enabled: boolean
  /** ASSISTANT_MODEL (default claude-opus-5-5). */
  model: string
  /** ASSISTANT_EFFORT (default low). */
  effort: AssistantEffort
  /** ASSISTANT_MAX_TOKENS (default 8000): the most each model turn may write, thinking included. */
  maxTokens: number
  /** ASSISTANT_DAILY_PER_WORKSPACE (default 40): messages one company may send per day (UTC). */
  perWorkspaceDaily: number
  /** ASSISTANT_DAILY_GLOBAL (default 600): messages every company together may send per day (UTC). */
  globalDaily: number
  /** ASSISTANT_FAKE=1: a scripted model for development and tests (assistant/fake.ts); refused in production. */
  fake: boolean
}

export const ASSISTANT_DEFAULTS = {
  model: 'claude-opus-5-5',
  effort: 'low',
  maxTokens: 8000,
  perWorkspaceDaily: 40,
  globalDaily: 600,
} as const satisfies Partial<AssistantConfig>

/** A model id as the API spells them (claude-opus-5-5): letters, digits, '.', '-' and '_'. */
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{2,99}$/i

type Env = Record<string, string | undefined>

/** Parses a .env file: KEY=value lines, # comments, optional `export `, single or double quotes. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]
    let value = m[2]
    if (value.startsWith('"')) {
      const end = findClosingQuote(value)
      value = value
        .slice(1, end === -1 ? undefined : end)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
    } else if (value.startsWith("'")) {
      const end = value.indexOf("'", 1)
      value = value.slice(1, end === -1 ? undefined : end)
    } else {
      value = value.replace(/\s+#.*$/, '').trim()
    }
    out[key] = value
  }
  return out
}

function findClosingQuote(value: string): number {
  for (let i = 1; i < value.length; i++) {
    if (value[i] === '\\') i++
    else if (value[i] === '"') return i
  }
  return -1
}

/** Loads `file` into `env` without overriding variables that are already set. Returns the keys loaded. */
export function loadDotEnv(file: string, env: Env = process.env): string[] {
  if (!existsSync(file)) return []
  const parsed = parseDotEnv(readFileSync(file, 'utf8'))
  const loaded: string[] = []
  for (const [k, v] of Object.entries(parsed)) {
    if (env[k] === undefined) {
      env[k] = v
      loaded.push(k)
    }
  }
  return loaded
}

/** The repo (or install) root: the nearest folder above this module with a package.json, else the cwd. */
export function findRootDir(start = path.dirname(fileURLToPath(import.meta.url))): string {
  let dir = start
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback
  return /^(1|true|yes|on)$/i.test(value.trim())
}

function positiveInt(env: Env, key: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0 || n > max) throw new ConfigError(`${key} must be a whole number between 1 and ${max} (got "${raw}").`)
  return n
}

function wholeNumber(env: Env, key: string, fallback: number, max: number): number {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > max) throw new ConfigError(`${key} must be a whole number between 0 and ${max} (got "${raw}").`)
  return n
}

/** A DNS host name: letters, digits and hyphens in dot-separated labels (no port, no scheme). */
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/

/** CAREERS_HOSTS: comma-separated host names, lowercased, without repeats. */
function hostList(env: Env, key: string): string[] {
  const out: string[] = []
  for (const part of (env[key] ?? '').split(',')) {
    const host = part.trim().toLowerCase()
    if (!host) continue
    if (!HOST_NAME.test(host)) {
      throw new ConfigError(`${key} must list host names separated by commas, like careers.example.com,jobs.example.com (got "${part.trim()}").`)
    }
    if (!out.includes(host)) out.push(host)
  }
  return out
}

function origin(env: Env, key: string): string | undefined {
  const raw = env[key]?.trim()
  if (!raw) return undefined
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocol')
    return u.origin
  } catch {
    throw new ConfigError(`${key} must be an origin like https://hr.example.com (got "${raw}").`)
  }
}

export type LoadConfigOptions = {
  /** Read <root>/.env first (default true). Tests pass false. */
  dotenv?: boolean
  rootDir?: string
  /** Called with warnings (default console.warn). */
  warn?: (message: string) => void
}

export function loadConfig(env: Env = process.env, options: LoadConfigOptions = {}): Config {
  const rootDir = options.rootDir ?? findRootDir()
  const warn = options.warn ?? ((m: string) => console.warn(`[first-twenty] ${m}`))
  if (options.dotenv !== false) loadDotEnv(path.join(rootDir, '.env'), env)

  const rawEnv = (env.NODE_ENV ?? 'development').trim()
  const nodeEnv: NodeEnv = rawEnv === 'production' ? 'production' : rawEnv === 'test' ? 'test' : 'development'
  const production = nodeEnv === 'production'

  let databaseUrl = env.DATABASE_URL?.trim() ?? ''
  if (!databaseUrl) {
    if (production) {
      throw new ConfigError(
        'DATABASE_URL is not set. In production it must point at Postgres, for example ' +
          'postgres://first_twenty:CHANGE_ME@127.0.0.1:5432/first_twenty (set it in /etc/first-twenty/env).',
      )
    }
    databaseUrl = 'pglite:./.data/pg'
  }

  let pgliteDir: string | null = null
  if (databaseUrl.startsWith('pglite:')) {
    if (production) {
      throw new ConfigError('DATABASE_URL uses PGlite, which is for development and tests only. Use a postgres:// URL in production.')
    }
    const dir = databaseUrl.slice('pglite:'.length).trim()
    pgliteDir = dir === '' || dir === 'memory' || dir === 'memory://' ? 'memory' : path.resolve(rootDir, dir)
  } else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new ConfigError('DATABASE_URL must start with postgres:// or postgresql:// (or pglite: in development).')
  } else if (production && databaseUrl.includes('CHANGE_ME')) {
    throw new ConfigError('DATABASE_URL still contains the CHANGE_ME placeholder. Put the real database password in /etc/first-twenty/env.')
  }

  const publicOrigin = origin(env, 'PUBLIC_ORIGIN')
  const secureCookies = publicOrigin?.startsWith('https:') ?? false
  const onlyViaCaddy = 'only requests that arrive through Caddy over https get Secure cookies and HSTS'
  if (production && !publicOrigin) warn(`PUBLIC_ORIGIN is not set, so ${onlyViaCaddy}. Set it to https://your-domain.`)
  else if (production && !secureCookies) warn(`PUBLIC_ORIGIN is not https, so ${onlyViaCaddy}. Set it to https://your-domain once the site is public.`)

  const allowedOrigin = origin(env, 'ALLOWED_ORIGIN')
  if (production && allowedOrigin) {
    throw new ConfigError('ALLOWED_ORIGIN is for development only. Remove it in production: the server serves the app itself, same-origin.')
  }

  const serveApp = bool(env.SERVE_APP, false)
  const appFile = path.resolve(rootDir, env.APP_FILE?.trim() || 'first-twenty.html')
  if (serveApp && !existsSync(appFile)) {
    throw new ConfigError(`SERVE_APP=true but the app file ${appFile} does not exist. Run "npm run build" or set APP_FILE.`)
  }

  const trustRaw = env.TRUST_PROXY?.trim()
  const trustProxy: string | boolean =
    !trustRaw ? 'loopback' : /^(false|0|no|off)$/i.test(trustRaw) ? false : /^(true|yes|on)$/i.test(trustRaw) ? true : trustRaw

  const pgSslMode = env.PGSSLMODE?.trim() || undefined
  if (pgSslMode && !['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full', 'no-verify'].includes(pgSslMode)) {
    throw new ConfigError(`PGSSLMODE "${pgSslMode}" is not recognized (use disable, require, verify-full or no-verify).`)
  }

  const rawSignup = env.SIGNUP_MODE?.trim().toLowerCase() || 'closed'
  if (rawSignup !== 'closed' && rawSignup !== 'open') throw new ConfigError(`SIGNUP_MODE must be closed or open (got "${env.SIGNUP_MODE}").`)
  const signupMode: SignupMode = rawSignup
  if (production && signupMode === 'open' && !secureCookies) {
    warn('SIGNUP_MODE=open on a server whose PUBLIC_ORIGIN is not https: strangers would sign up over a plain connection. Set PUBLIC_ORIGIN to https://your-domain.')
  }

  // Careers hosts answer careers pages only (app.ts), so the app's own host can never be one of them.
  const careersHosts = hostList(env, 'CAREERS_HOSTS')
  const appHost = publicOrigin ? new URL(publicOrigin).hostname : undefined
  if (appHost && careersHosts.includes(appHost)) {
    throw new ConfigError(`CAREERS_HOSTS lists ${appHost}, the app's own host (PUBLIC_ORIGIN). Careers pages need a host name of their own.`)
  }
  let careersOrigin = origin(env, 'CAREERS_ORIGIN')
  if (careersHosts.length === 0) {
    if (careersOrigin) warn('CAREERS_ORIGIN is set but CAREERS_HOSTS is empty, so careers pages are off. Set CAREERS_HOSTS too.')
    careersOrigin = undefined
  } else if (careersOrigin) {
    const host = new URL(careersOrigin).hostname
    if (!careersHosts.includes(host)) throw new ConfigError(`CAREERS_ORIGIN must be on one of CAREERS_HOSTS (${careersHosts.join(', ')}); got ${host}.`)
  } else {
    // The first careers host, over the app's own scheme and port (https in production).
    const app = publicOrigin ? new URL(publicOrigin) : null
    careersOrigin = app ? `${app.protocol}//${careersHosts[0]}${app.port ? `:${app.port}` : ''}` : `https://${careersHosts[0]}`
  }

  const assistant = assistantConfig(env, production)

  // The development server's own routes read any company's data (npm run sql); no production server may have them.
  const devTools = bool(env.DEV_TOOLS, false)
  if (devTools && production) throw new ConfigError('DEV_TOOLS is for development only (npm run stack sets it). Remove it in production.')

  return {
    nodeEnv,
    port: positiveInt(env, 'PORT', 8787, 65535),
    host: env.HOST?.trim() || '127.0.0.1',
    databaseUrl,
    pgliteDir,
    pgSslMode,
    publicOrigin,
    secureCookies,
    serveApp,
    appFile,
    allowedOrigin,
    sessionIdleHours: positiveInt(env, 'SESSION_IDLE_HOURS', 12, 24 * 365),
    sessionMaxDays: positiveInt(env, 'SESSION_MAX_DAYS', 7, 365),
    migrateOnStart: bool(env.MIGRATE_ON_START, pgliteDir !== null),
    trustProxy,
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    rootDir,
    signupMode,
    demoMaxWorkspaces: positiveInt(env, 'DEMO_MAX_WORKSPACES', 500, 100_000),
    demoExpireDays: wholeNumber(env, 'DEMO_EXPIRE_DAYS', 30, 3650),
    demoMaxTotalBytes: positiveInt(env, 'DEMO_MAX_TOTAL_MB', 2048, 1_000_000) * 1024 * 1024,
    careersHosts,
    careersOrigin,
    assistant,
    devTools,
  }
}

/**
 * The assistant's settings. It is on when ANTHROPIC_API_KEY holds a key (its value is only checked for
 * being there; the Anthropic client reads it, see assistant/client.ts) or ASSISTANT_FAKE is on, which a
 * production server refuses: a fake model there would answer real people with canned text.
 */
function assistantConfig(env: Env, production: boolean): AssistantConfig {
  const fake = bool(env.ASSISTANT_FAKE, false)
  if (fake && production) {
    throw new ConfigError('ASSISTANT_FAKE is for development and tests only. Remove it in production and set ANTHROPIC_API_KEY instead.')
  }
  const key = env.ANTHROPIC_API_KEY?.trim() ?? ''
  if (/\s/.test(key)) throw new ConfigError('ANTHROPIC_API_KEY has a space or line break in it. Paste the key alone, on one line.')
  const model = env.ASSISTANT_MODEL?.trim() || ASSISTANT_DEFAULTS.model
  if (!MODEL_ID.test(model)) throw new ConfigError(`ASSISTANT_MODEL must be a model id like ${ASSISTANT_DEFAULTS.model} (got "${env.ASSISTANT_MODEL}").`)
  const rawEffort = env.ASSISTANT_EFFORT?.trim().toLowerCase() || ASSISTANT_DEFAULTS.effort
  if (!(ASSISTANT_EFFORTS as readonly string[]).includes(rawEffort)) {
    throw new ConfigError(`ASSISTANT_EFFORT must be one of ${ASSISTANT_EFFORTS.join(', ')} (got "${env.ASSISTANT_EFFORT}").`)
  }
  return {
    enabled: key !== '' || fake,
    model,
    effort: rawEffort as AssistantEffort,
    maxTokens: positiveInt(env, 'ASSISTANT_MAX_TOKENS', ASSISTANT_DEFAULTS.maxTokens, 128_000),
    perWorkspaceDaily: positiveInt(env, 'ASSISTANT_DAILY_PER_WORKSPACE', ASSISTANT_DEFAULTS.perWorkspaceDaily, 100_000),
    globalDaily: positiveInt(env, 'ASSISTANT_DAILY_GLOBAL', ASSISTANT_DEFAULTS.globalDaily, 10_000_000),
    fake,
  }
}

/** A config for tests and tools: in-memory PGlite, nothing served, development defaults. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    nodeEnv: 'test',
    port: 8787,
    host: '127.0.0.1',
    databaseUrl: 'pglite:memory',
    pgliteDir: 'memory',
    pgSslMode: undefined,
    publicOrigin: undefined,
    secureCookies: false,
    serveApp: false,
    appFile: path.join(findRootDir(), 'first-twenty.html'),
    allowedOrigin: undefined,
    sessionIdleHours: 12,
    sessionMaxDays: 7,
    migrateOnStart: true,
    trustProxy: 'loopback',
    logLevel: 'silent',
    rootDir: findRootDir(),
    signupMode: 'closed',
    demoMaxWorkspaces: 500,
    demoExpireDays: 30,
    demoMaxTotalBytes: 2048 * 1024 * 1024,
    careersHosts: [],
    careersOrigin: undefined,
    assistant: { enabled: false, ...ASSISTANT_DEFAULTS, fake: false },
    devTools: false,
    ...overrides,
  }
}
