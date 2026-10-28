// Development only (`npm run sql`, docs/DEV.md): runs one statement that only reads, on the dev stack's
// database. The API runs it for a request to POST /__dev/sql (routes.ts) while the stack holds the
// database; scripts/dev/sql-worker.ts runs it when no stack does.
//
// Read-only for real, in layers:
//   1. statement.ts: one statement, starting with SELECT, WITH, VALUES, TABLE, EXPLAIN or SHOW; nothing that
//      would start, end or change the transaction.
//   2. A transaction that is read only (SET TRANSACTION READ ONLY, its first statement) and always rolled
//      back, with SET LOCAL statement_timeout.
//   3. The extended query protocol (parameters, one statement per message), which refuses a second
//      statement on its own.
// A SELECT runs through a cursor, so at most ROW_CAP + 1 rows are fetched however many it would return.
//
// PGlite cannot stop a statement once it runs (it is single-threaded and has no timer to cancel with), so
// statement_timeout only works on real Postgres. Where PGlite runs in the npm run sql process,
// scripts/dev/sql.ts stops its worker after STATEMENT_TIMEOUT_MS instead; the stack's API finishes a slow
// statement before it answers anything else.
import type { Db, Field, QueryResult, Row } from '../db'
import { checkStatement } from './statement'

/** The most rows an answer carries. */
export const ROW_CAP = 500
/** How long one statement may run (enforced by Postgres; for PGlite see the note above). */
export const STATEMENT_TIMEOUT_MS = 5000
/** The cursor's name: one per transaction, and every transaction is rolled back, so it never clashes. */
const CURSOR = 'first_twenty_dev_sql'

export type SqlParam = string | number | boolean | null

export type SqlRequest = {
  sql: string
  /** Values for $1, $2, ... in sql. */
  params?: readonly SqlParam[]
  /** YYYY-MM-DD: the day the date-dependent views read as (first_twenty.today), for this statement only. */
  today?: string
}

export type SqlColumn = { name: string; typeId: number }

export type SqlAnswer = {
  columns: SqlColumn[]
  /** One array per row, in column order, holding JSON values only (dates as text, see plainValue). */
  rows: unknown[][]
  /** True when the statement had more than ROW_CAP rows and only the first ROW_CAP are here. */
  truncated: boolean
}

/** A statement or request refused before it reached the database, or an answer that cannot be shown; the message says why. */
export class RefusedError extends Error {
  override name = 'RefusedError'
}

/**
 * What went wrong with a statement, as npm run sql shows it: refused before it ran, or the database's own
 * error (a typo, a missing column), with its SQLSTATE code and where in the text it went wrong.
 */
export type SqlProblem = { kind: 'refused' | 'sql_error'; message: string; code?: string; position?: number }

/** The problem `err` describes, or null when it is some other failure (which stays an error). */
export function sqlProblem(err: unknown): SqlProblem | null {
  if (err instanceof RefusedError) return { kind: 'refused', message: err.message }
  const e = err as { code?: unknown; message?: unknown; position?: unknown } | null
  if (!e || typeof e.code !== 'string' || !/^[0-9A-Z]{5}$/.test(e.code)) return null
  const position = Number(e.position)
  return { kind: 'sql_error', message: String(e.message), code: e.code, ...(position > 0 ? { position } : {}) }
}

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

/** Thrown inside the transaction to roll it back, carrying the answer out. */
class RollBack {
  constructor(readonly answer: SqlAnswer) {}
}

/** Runs `request` read-only and rolls back; throws RefusedError, or the database's own error. */
export async function runReadOnly(db: Db, request: SqlRequest, limits: { rowCap?: number; timeoutMs?: number } = {}): Promise<SqlAnswer> {
  const rowCap = limits.rowCap ?? ROW_CAP
  const timeoutMs = Math.trunc(limits.timeoutMs ?? STATEMENT_TIMEOUT_MS)
  const checked = checkStatement(request.sql)
  if (!checked.ok) throw new RefusedError(checked.reason)
  const params = request.params ?? []
  if (params.length !== checked.placeholders) {
    throw new RefusedError(
      checked.placeholders === 0
        ? `The statement has no $1, but ${params.length} value${params.length === 1 ? ' was' : 's were'} given for one.`
        : `The statement uses $1 to $${checked.placeholders}, but ${params.length} value${params.length === 1 ? ' was' : 's were'} given.`,
    )
  }
  if (request.today !== undefined && !DAY.test(request.today)) throw new RefusedError(`today must be a date like 2026-10-09 (got "${request.today}").`)

  const prefix = checked.kind === 'cursor' ? `DECLARE ${CURSOR} NO SCROLL CURSOR FOR ` : ''
  try {
    await db.tx(
      async (q) => {
        await q.exec(`SET LOCAL statement_timeout = ${timeoutMs}`)
        if (request.today !== undefined) await q.query("SELECT set_config('first_twenty.today', $1, true)", [request.today])
        let result: QueryResult<Row>
        if (checked.kind === 'cursor') {
          await q.query(prefix + checked.statement, [...params])
          result = await q.query(`FETCH FORWARD ${rowCap + 1} FROM ${CURSOR}`)
        } else {
          result = await q.query(checked.statement, [...params])
        }
        throw new RollBack(answerOf(result, rowCap))
      },
      { readOnly: true },
    )
  } catch (err) {
    if (err instanceof RollBack) return err.answer
    throw withPositionIn(request.sql, prefix, err)
  }
  throw new Error('runReadOnly: the transaction ended without an answer')
}

/**
 * The database error with its position (where in the text it went wrong, counting from 1) moved to count
 * in the text as it was sent, not in the statement wrapped in DECLARE and trimmed. A position inside the
 * wrapper is dropped.
 */
function withPositionIn(sql: string, prefix: string, err: unknown): unknown {
  const e = err as { position?: unknown }
  if (e === null || typeof e !== 'object' || e.position === undefined) return err
  const at = Number(e.position) - prefix.length + (sql.length - sql.trimStart().length)
  e.position = at > 0 ? String(at) : undefined
  return err
}

/** The answer for a query result: columns in order, rows as arrays of plain values, at most rowCap of them. */
function answerOf(result: QueryResult<Row>, rowCap: number): SqlAnswer {
  const fields: Field[] = result.fields ?? Object.keys(result.rows[0] ?? {}).map((name) => ({ name, dataTypeID: 0 }))
  const seen = new Set<string>()
  for (const f of fields) {
    // Rows come back keyed by column name, so two columns of one name would lose one of them.
    if (seen.has(f.name)) throw new RefusedError(`Two columns are named "${f.name}". Give each its own name with AS, like SELECT a.id AS application_id, c.id AS candidate_id.`)
    seen.add(f.name)
  }
  const rows = result.rows.slice(0, rowCap).map((row) => fields.map((f) => plainValue(row[f.name], f.dataTypeID)))
  return { columns: fields.map((f) => ({ name: f.name, typeId: f.dataTypeID })), rows, truncated: result.rows.length > rowCap }
}

/** Postgres type ids (pg_type.oid) plainValue treats specially. */
export const TYPE_IDS = { date: 1082, timestamp: 1114, timestamptz: 1184, bytea: 17 } as const

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

/**
 * A value as JSON can carry it, the same from either driver: a date as YYYY-MM-DD, a timestamp with time
 * zone as an ISO string in UTC, one without as its own wall-clock time, a 64-bit integer as a number (as
 * text past 2^53), bytes as \x hex, and NaN or Infinity as text.
 */
export function plainValue(value: unknown, typeId: number): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return 'infinity'
    // PGlite reads a date as midnight UTC and a timestamp without time zone as local time.
    if (typeId === TYPE_IDS.date) return value.toISOString().slice(0, 10)
    if (typeId === TYPE_IDS.timestamp) {
      const d = value
      return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
    }
    return value.toISOString()
  }
  if (value instanceof Uint8Array) return `\\x${Buffer.from(value).toString('hex')}`
  if (Array.isArray(value)) return value.map((v) => plainValue(v, 0))
  return value
}
