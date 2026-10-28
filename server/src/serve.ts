// Runs the First Twenty server: load settings, open the database, migrate when MIGRATE_ON_START=true
// (the default for PGlite in development), listen on HOST:PORT and shut down cleanly on SIGTERM/SIGINT.
// Two entries start it: server/src/index.ts (production, `npm run server:dev`) and server/src/dev/index.ts
// (`npm run stack`), which adds development-only routes through beforeListen.
import type { FastifyInstance } from 'fastify'
import { buildApp } from './app'
import { anthropicClient } from './assistant/client'
import { registerCareers } from './careers/routes'
import { type Config, loadConfig } from './config'
import { type Db, openDb } from './db'
import { ConfigError } from './errors'
import { housekeeping } from './housekeeping'
import { migrate, unappliedMigrations } from './migrate'

const DAY_MS = 86_400_000

export type ServeOptions = {
  /** Checks the settings before anything opens; a ConfigError stops the server with its message. */
  checkConfig?: (config: Config) => void
  /** Adds to the built app before it listens (the development entry adds its routes here). */
  beforeListen?: (app: FastifyInstance, deps: { db: Db; config: Config }) => Promise<void>
}

function describeDb(config: Config): string {
  if (config.pgliteDir) return config.pgliteDir === 'memory' ? 'PGlite (in memory)' : `PGlite at ${config.pgliteDir}`
  try {
    const u = new URL(config.databaseUrl)
    return `Postgres at ${u.hostname}:${u.port || '5432'}${u.pathname}` // never the password
  } catch {
    return 'Postgres'
  }
}

async function serve(options: ServeOptions): Promise<void> {
  let config: Config
  try {
    config = loadConfig()
    options.checkConfig?.(config)
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[first-twenty] ${err.message}`)
      process.exit(1)
    }
    throw err
  }

  const db = await openDb(config, (err) => console.error('[first-twenty] database connection error:', err.message))
  if (config.migrateOnStart) {
    const { applied } = await migrate(db, { log: (m) => console.log(`[first-twenty] ${m}`) })
    if (applied.length === 0) console.log('[first-twenty] Database schema is up to date.')
  } else {
    // Starts anyway (the schema owner may be about to migrate), but says so loudly; /api/health answers
    // 503 until the migrations are in.
    const pending = await unappliedMigrations(db).catch(() => [])
    if (pending.length > 0) {
      console.error(
        `[first-twenty] The database is missing ${pending.join(', ')}. Run "npm run server:migrate" (on EC2: ` +
          'bash server/deploy/with-env.sh npm run server:migrate), then restart. Sign-in fails until then.',
      )
    }
  }

  // The careers pages answer on CAREERS_HOSTS only (none set: no careers routes at all). The assistant's
  // client gets ANTHROPIC_API_KEY straight from the environment (loadConfig loaded .env into it), and
  // nothing else ever holds the key; ASSISTANT_FAKE (development only) makes buildApp use the fake.
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim()
  const assistantClient = config.assistant.enabled && !config.assistant.fake && apiKey ? anthropicClient(apiKey) : undefined
  const app = await buildApp({ db, config, careers: registerCareers, assistantClient })
  await options.beforeListen?.(app, { db, config })

  // Housekeeping at startup and once a day (housekeeping.ts): ended sessions, demo companies unused for
  // DEMO_EXPIRE_DAYS, old change-log rows, long-expired invites, assistant usage rows past ASSISTANT_USAGE_DAYS.
  const runHousekeeping = async () => {
    try {
      const done = await housekeeping(db, config)
      if (done.expiredWorkspaces > 0 || done.prunedChanges > 0 || done.assistantUsage > 0) app.log.info(done, 'housekeeping removed old data')
    } catch (err) {
      app.log.error({ err }, 'housekeeping failed')
    }
  }
  const timer = setInterval(runHousekeeping, DAY_MS)
  timer.unref()

  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    app.log.info({ signal }, 'shutting down')
    clearInterval(timer)
    const force = setTimeout(() => process.exit(1), 10_000)
    force.unref()
    try {
      await app.close()
      await db.close()
      process.exit(0)
    } catch (err) {
      app.log.error({ err }, 'shutdown failed')
      process.exit(1)
    }
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  await app.listen({ host: config.host, port: config.port })
  app.log.info(
    {
      db: describeDb(config),
      serveApp: config.serveApp,
      env: config.nodeEnv,
      signupMode: config.signupMode,
      careersHosts: config.careersHosts,
      // Whether the assistant is on and with which model; never the key.
      assistant: config.assistant.enabled ? (config.assistant.fake ? 'fake' : config.assistant.model) : 'off',
    },
    `First Twenty server listening on http://${config.host}:${config.port}`,
  )
  void runHousekeeping()
}

/** Starts the server; a failure to start ends the process with exit code 1. */
export function startServer(options: ServeOptions = {}): void {
  serve(options).catch((err) => {
    console.error('[first-twenty] failed to start:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
