// Applies server/sql/NNN_name.sql files in order, each inside its own transaction, and records them in
// schema_migrations. Safe to run on every boot (MIGRATE_ON_START=true) and from several processes at
// once: an advisory lock serializes runners and each file is re-checked inside its transaction.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Db } from './db'

const FILE_RE = /^\d{3}_[a-z0-9_]+\.sql$/
// Any constant works; it only has to be the same for every First Twenty process.
const LOCK_KEY = 72_026_001

/**
 * Where the .sql files live: MIGRATIONS_DIR, else next to the bundle (dist-server/sql, copied by
 * vite.server.config.ts), else server/sql when running from source (tsx, vitest).
 */
export function migrationsDir(env: Record<string, string | undefined> = process.env): string {
  if (env.MIGRATIONS_DIR) return path.resolve(env.MIGRATIONS_DIR)
  const here = path.dirname(fileURLToPath(import.meta.url))
  for (const candidate of [path.join(here, 'sql'), path.join(here, '..', 'sql')]) {
    if (existsSync(candidate) && readdirSync(candidate).some((f) => FILE_RE.test(f))) return candidate
  }
  throw new Error(`No migrations found next to ${here}. Set MIGRATIONS_DIR to the folder holding 001_init.sql.`)
}

export function migrationFiles(dir = migrationsDir()): string[] {
  return readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .sort()
}

async function ensureTable(db: Db): Promise<void> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`)
}

export async function appliedMigrations(db: Db): Promise<string[]> {
  await ensureTable(db)
  const r = await db.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name')
  return r.rows.map((row) => row.name)
}

export type MigrateResult = { applied: string[]; alreadyApplied: string[] }

/** Applies pending migrations. Returns what it applied. */
export async function migrate(db: Db, options: { dir?: string; log?: (message: string) => void } = {}): Promise<MigrateResult> {
  const dir = options.dir ?? migrationsDir()
  const files = migrationFiles(dir)
  const before = new Set(await appliedMigrations(db))
  const applied: string[] = []
  for (const file of files) {
    if (before.has(file)) continue
    const sql = readFileSync(path.join(dir, file), 'utf8')
    const did = await db.tx(async (q) => {
      await q.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY])
      const done = await q.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file])
      if (done.rows.length > 0) return false
      await q.exec(sql)
      await q.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
      return true
    })
    if (did) {
      applied.push(file)
      options.log?.(`Applied ${file}`)
    }
  }
  return { applied, alreadyApplied: files.filter((f) => before.has(f)) }
}

/** Lists files not yet applied, without applying them. */
export async function pendingMigrations(db: Db, dir = migrationsDir()): Promise<string[]> {
  const done = new Set(await appliedMigrations(db))
  return migrationFiles(dir).filter((f) => !done.has(f))
}

/**
 * pendingMigrations for the server's own login, which may read schema_migrations but not create tables
 * (appliedMigrations creates the table when it is missing). A missing table counts as nothing applied.
 */
export async function unappliedMigrations(db: Db, dir = migrationsDir()): Promise<string[]> {
  const table = await db.query<{ t: string | null }>("SELECT to_regclass('schema_migrations')::text AS t")
  const done = new Set<string>()
  if (table.rows[0]?.t) {
    for (const row of (await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows) done.add(row.name)
  }
  return migrationFiles(dir).filter((f) => !done.has(f))
}
