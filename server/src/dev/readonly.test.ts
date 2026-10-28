// runReadOnly on PGlite: answers in column order through a cursor that stops at the row cap, refusals
// before the database is touched, and the read-only, rolled-back transaction underneath, which holds even
// for statements that pass statement.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db } from '../db'
import { makeTestDb } from '../test/helpers'
import { plainValue, RefusedError, ROW_CAP, runReadOnly, type SqlRequest, TYPE_IDS } from './readonly'

let db: Db

beforeAll(async () => {
  db = await makeTestDb()
  await db.exec(`CREATE TABLE dev_sql_t (id int PRIMARY KEY, name text);
    INSERT INTO dev_sql_t VALUES (1, 'one'), (2, 'two'), (3, 'three');
    CREATE SEQUENCE dev_sql_s;`)
})
afterAll(async () => {
  await db.close()
})

const run = (sql: string, extra: Omit<SqlRequest, 'sql'> = {}) => runReadOnly(db, { sql, ...extra })
const tableRows = async () => (await db.query('SELECT id, name FROM dev_sql_t ORDER BY id')).rows

/** Rejects with the database's error code (SQLSTATE), or fails. */
async function sqlState(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (err) {
    if (err instanceof RefusedError) throw new Error(`refused before the database: ${err.message}`)
    return String((err as { code?: unknown }).code)
  }
  throw new Error('expected the database to refuse the statement')
}

describe('runReadOnly: answers', () => {
  it('answers columns in order and rows as arrays', async () => {
    expect(await run('SELECT id, name FROM dev_sql_t ORDER BY id')).toEqual({
      columns: [
        { name: 'id', typeId: 23 },
        { name: 'name', typeId: 25 },
      ],
      rows: [
        [1, 'one'],
        [2, 'two'],
        [3, 'three'],
      ],
      truncated: false,
    })
  })

  it('answers the columns of a statement that finds no rows', async () => {
    expect(await run('SELECT id, name FROM dev_sql_t WHERE false')).toEqual({ columns: [{ name: 'id', typeId: 23 }, { name: 'name', typeId: 25 }], rows: [], truncated: false })
  })

  it(`stops at ${ROW_CAP} rows and says there were more`, async () => {
    const all = await run('SELECT g FROM generate_series(1, 1000) g')
    expect(all.rows).toHaveLength(ROW_CAP)
    expect(all.rows.at(-1)).toEqual([ROW_CAP])
    expect(all.truncated).toBe(true)
    expect((await run(`SELECT g FROM generate_series(1, ${ROW_CAP}) g`)).truncated).toBe(false)
    expect((await runReadOnly(db, { sql: 'SELECT g FROM generate_series(1, 10) g' }, { rowCap: 4 })).rows).toEqual([[1], [2], [3], [4]])
  })

  it('fetches only the rows it shows, so a statement that never ends still answers', async () => {
    const endless = await run('WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT n FROM r')
    expect(endless.rows).toHaveLength(ROW_CAP)
    expect(endless.truncated).toBe(true)
  })

  it('runs VALUES, TABLE, EXPLAIN and SHOW', async () => {
    expect((await run('VALUES (1, 2)')).rows).toEqual([[1, 2]])
    expect((await run('TABLE dev_sql_t')).rows).toHaveLength(3)
    expect((await run('EXPLAIN SELECT * FROM dev_sql_t')).columns.map((c) => c.name)).toEqual(['QUERY PLAN'])
    expect((await run('SHOW TimeZone')).rows).toHaveLength(1)
  })

  it('passes values for placeholders, and wants exactly as many as the statement uses', async () => {
    expect((await run('SELECT name FROM dev_sql_t WHERE id = $1', { params: [2] })).rows).toEqual([['two']])
    expect((await run('SELECT $1::text AS a, $2::int AS b', { params: ['x', 7] })).rows).toEqual([['x', 7]])
    await expect(run('SELECT name FROM dev_sql_t WHERE id = $1')).rejects.toThrow(/uses \$1 to \$1, but 0 values were given/)
    await expect(run('SELECT 1', { params: ['x'] })).rejects.toThrow(/has no \$1, but 1 value was given/)
  })

  it('refuses an answer with two columns of one name, which would lose one of them', async () => {
    await expect(run('SELECT 1 AS a, 2 AS a')).rejects.toThrow(RefusedError)
    await expect(run('SELECT 1, 2')).rejects.toThrow(/Two columns are named "\?column\?"/)
  })

  it('passes the database error on, with its code, and the database keeps working', async () => {
    expect(await sqlState(run('SELECT nope FROM dev_sql_t'))).toBe('42703')
    expect(await sqlState(run('SELECT * FROM no_such_table'))).toBe('42P01')
    expect((await run('SELECT count(*) AS n FROM dev_sql_t')).rows).toEqual([[3]])
  })

  it('counts an error position in the text as sent, not in the statement it wraps', async () => {
    const position = async (sql: string) => run(sql).catch((err: { position?: string }) => err.position)
    expect(await position('SELECT nope FROM dev_sql_t')).toBe('8')
    expect(await position('  SELECT nope FROM dev_sql_t')).toBe('10')
    expect(await position('EXPLAIN SELECT nope FROM dev_sql_t')).toBe('16')
  })
})

describe('runReadOnly: refusals never reach the database', () => {
  it('refuses COMMIT, ROLLBACK, SET TRANSACTION, BEGIN and a second statement before opening a transaction', async () => {
    let transactions = 0
    const counting: Db = { ...db, tx: (fn, options) => (transactions++, db.tx(fn, options)) }
    for (const sql of ['COMMIT', 'ROLLBACK', 'SET TRANSACTION READ WRITE', 'BEGIN', 'START TRANSACTION', 'END', 'SELECT 1; DELETE FROM dev_sql_t', 'DELETE FROM dev_sql_t']) {
      await expect(runReadOnly(counting, { sql }), sql).rejects.toThrow(RefusedError)
    }
    expect(transactions).toBe(0)
    await runReadOnly(counting, { sql: 'SELECT 1 AS one' })
    expect(transactions).toBe(1)
  })

  it('refuses a today that is not a date', async () => {
    await expect(run('SELECT 1', { today: '2026-13-01' })).rejects.toThrow(/today must be a date/)
    await expect(run('SELECT 1', { today: "2026-10-09'; COMMIT; --" })).rejects.toThrow(RefusedError)
  })
})

describe('runReadOnly: the transaction underneath', () => {
  it('is read only, so a statement that would write is refused by the database even when it passes the checks', async () => {
    expect(await sqlState(run('SELECT nextval($1)', { params: ['dev_sql_s'] }))).toBe('25006')
    expect(await sqlState(run('SELECT * FROM dev_sql_t FOR UPDATE'))).toBe('25006')
    expect(await sqlState(run('EXPLAIN ANALYZE DELETE FROM dev_sql_t'))).toBe('25006')
    // DECLARE refuses a WITH that writes; the read-only transaction would refuse it too.
    expect(await sqlState(run('WITH d AS (DELETE FROM dev_sql_t RETURNING *) SELECT * FROM d'))).toMatch(/^(0A000|25006|42601)$/)
    // A read-only transaction cannot be made writable once it has read.
    expect(await sqlState(run("SELECT set_config('transaction_read_only', 'off', true)"))).toBe('25001')
    expect(await tableRows()).toEqual([
      { id: 1, name: 'one' },
      { id: 2, name: 'two' },
      { id: 3, name: 'three' },
    ])
    expect((await db.query("SELECT nextval('dev_sql_s') AS n")).rows).toEqual([{ n: 1 }])
  })

  it('is rolled back, so settings a statement changes for the session do not outlive it', async () => {
    const before = (await db.query<{ search_path: string }>('SHOW search_path')).rows[0].search_path
    await run("SELECT set_config('search_path', 'pg_catalog', false)")
    await run("SELECT set_config('statement_timeout', '0', false)")
    expect((await db.query<{ search_path: string }>('SHOW search_path')).rows[0].search_path).toBe(before)
  })

  it('sets statement_timeout for its statement only', async () => {
    expect((await run('SHOW statement_timeout')).rows).toEqual([['5s']])
    expect((await runReadOnly(db, { sql: 'SHOW statement_timeout' }, { timeoutMs: 1500 })).rows).toEqual([['1500ms']])
    expect((await db.query<{ statement_timeout: string }>('SHOW statement_timeout')).rows[0].statement_timeout).toBe('0')
  })

  it('reads the date-dependent views as of today when asked, for this statement only', async () => {
    expect((await run('SELECT ft_today() AS d', { today: '2026-10-09' })).rows).toEqual([['2026-10-09']])
    expect((await run("SELECT current_setting('first_twenty.today', true) AS d")).rows[0][0]).toBeFalsy()
  })
})

describe('plainValue', () => {
  it('turns what PGlite reads into values JSON can carry', async () => {
    const answer = await run(`SELECT '2026-10-09'::date AS d, '2026-10-09 12:34:56.5+00'::timestamptz AS tz,
      '2026-10-09 12:34:56'::timestamp AS ts, 1.50::numeric AS n, 9007199254740993::int8 AS big, 5::int8 AS small,
      '\\x01ff'::bytea AS b, '{"a": [1]}'::jsonb AS j, ARRAY[1, 2] AS arr, 'NaN'::float8 AS nan, true AS yes, NULL::text AS nothing`)
    expect(Object.fromEntries(answer.columns.map((c, i) => [c.name, answer.rows[0][i]]))).toEqual({
      d: '2026-10-09',
      tz: '2026-10-09T12:34:56.500Z',
      ts: '2026-10-09T12:34:56.000',
      n: '1.50',
      big: '9007199254740993',
      small: 5,
      b: '\\x01ff',
      j: { a: [1] },
      arr: [1, 2],
      nan: 'NaN',
      yes: true,
      nothing: null,
    })
    expect(JSON.parse(JSON.stringify(answer.rows))).toEqual(answer.rows)
  })

  it('handles dates that are not dates', () => {
    expect(plainValue(new Date(Number.NaN), TYPE_IDS.date)).toBe('infinity')
    expect(plainValue(undefined, 0)).toBeNull()
    expect(plainValue(Infinity, 701)).toBe('Infinity')
  })
})
