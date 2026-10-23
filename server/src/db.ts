// A tiny driver-agnostic database adapter: { query, exec, tx, close } over pg.Pool (production) or
// PGlite (real Postgres in WebAssembly, for development and tests). The rest of the server only sees
// this interface, so the SQL is the same everywhere.
//
// Driver differences the callers must allow for: int8/bigint columns come back as strings (pg) or
// numbers/bigints (PGlite), so read them with Number(). JSON parameters are always passed as strings
// with an explicit ::jsonb cast (pg would turn a JS array into a Postgres array otherwise).
import { mkdirSync } from 'node:fs'
import type { Config } from './config'

export type Row = Record<string, unknown>
export type QueryResult<T> = { rows: T[]; rowCount: number }

export interface Queryable {
  query<T extends Row = Row>(text: string, params?: unknown[]): Promise<QueryResult<T>>
  /** Runs one or more statements without parameters (migrations). */
  exec(sql: string): Promise<void>
}

export type TxOptions = {
  isolation?: 'read committed' | 'repeatable read' | 'serializable'
  readOnly?: boolean
}

export interface Db extends Queryable {
  readonly kind: 'pg' | 'pglite'
  /** Runs fn in a transaction: COMMIT when it resolves, ROLLBACK when it throws. */
  tx<T>(fn: (q: Queryable) => Promise<T>, options?: TxOptions): Promise<T>
  close(): Promise<void>
}

function txPreamble(options?: TxOptions): string | null {
  if (!options?.isolation && !options?.readOnly) return null
  const parts: string[] = []
  if (options.isolation) parts.push(`ISOLATION LEVEL ${options.isolation.toUpperCase()}`)
  if (options.readOnly) parts.push('READ ONLY')
  return `SET TRANSACTION ${parts.join(', ')}`
}

// ---------------------------------------------------------------------------------------------
// PGlite
// ---------------------------------------------------------------------------------------------

type PGliteLike = {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>
  exec(sql: string): Promise<unknown>
  transaction<T>(fn: (tx: {
    query<R>(text: string, params?: unknown[]): Promise<{ rows: R[]; affectedRows?: number }>
    exec(sql: string): Promise<unknown>
  }) => Promise<T>): Promise<T>
  close(): Promise<void>
  closed?: boolean
}

/** Wraps an open PGlite instance (exported so tests can share one in-memory database). */
export function fromPGlite(pg: PGliteLike): Db {
  const wrap = (target: Pick<PGliteLike, 'query' | 'exec'>): Queryable => ({
    async query<T extends Row>(text: string, params?: unknown[]) {
      const r = await target.query<T>(text, params)
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }
    },
    async exec(sql: string) {
      await target.exec(sql)
    },
  })
  const top = wrap(pg)
  return {
    kind: 'pglite',
    query: top.query,
    exec: top.exec,
    async tx(fn, options) {
      return pg.transaction(async (t) => {
        const q = wrap(t)
        const pre = txPreamble(options)
        if (pre) await q.exec(pre)
        return fn(q)
      })
    },
    async close() {
      if (!pg.closed) await pg.close()
    },
  }
}

/** Opens PGlite at `dir` ('memory' for an in-memory database). Loaded lazily: it is a dev dependency. */
export async function openPGlite(dir: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite')
  if (dir !== 'memory') mkdirSync(dir, { recursive: true })
  const pg = dir === 'memory' ? await PGlite.create() : await PGlite.create(dir)
  return fromPGlite(pg as unknown as PGliteLike)
}

// ---------------------------------------------------------------------------------------------
// pg (node-postgres)
// ---------------------------------------------------------------------------------------------

function sslOption(mode: string | undefined): boolean | { rejectUnauthorized: boolean } | undefined {
  switch (mode) {
    case undefined:
      return undefined // let the connection string decide (sslmode=...); none for a localhost Postgres
    case 'disable':
    case 'allow':
    case 'prefer':
      return false
    case 'no-verify':
      return { rejectUnauthorized: false }
    default:
      return { rejectUnauthorized: true } // require, verify-ca, verify-full
  }
}

export async function openPg(config: Pick<Config, 'databaseUrl' | 'pgSslMode'>, onError?: (err: Error) => void): Promise<Db> {
  const pgModule = await import('pg')
  const Pool = pgModule.default?.Pool ?? (pgModule as unknown as { Pool: typeof pgModule.default.Pool }).Pool
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: sslOption(config.pgSslMode),
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 60_000,
    application_name: 'first-twenty',
  })
  // An idle client losing its connection must not crash the process.
  pool.on('error', (err) => onError?.(err))

  type PgClient = { query(text: string, params?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }> }
  const wrap = (c: PgClient): Queryable => ({
    async query<T extends Row>(text: string, params?: unknown[]) {
      const r = await c.query(text, params)
      return { rows: r.rows as T[], rowCount: r.rowCount ?? r.rows.length }
    },
    async exec(sql: string) {
      await c.query(sql) // no parameters: simple protocol, several statements allowed
    },
  })
  const top = wrap(pool)
  return {
    kind: 'pg',
    query: top.query,
    exec: top.exec,
    async tx(fn, options) {
      const client = await pool.connect()
      let broken = false
      try {
        await client.query('BEGIN')
        const pre = txPreamble(options)
        if (pre) await client.query(pre)
        const result = await fn(wrap(client))
        await client.query('COMMIT')
        return result
      } catch (err) {
        try {
          await client.query('ROLLBACK')
        } catch {
          broken = true
        }
        throw err
      } finally {
        client.release(broken)
      }
    },
    async close() {
      await pool.end()
    },
  }
}

/** Opens the database the config names: PGlite for pglite: URLs, otherwise Postgres through pg. */
export async function openDb(config: Config, onError?: (err: Error) => void): Promise<Db> {
  if (config.pgliteDir) return openPGlite(config.pgliteDir)
  return openPg(config, onError)
}
