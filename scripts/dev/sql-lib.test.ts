// The pure parts of npm run sql, and its shortcuts run against the Ledgerlark sample through the same
// read-only runner the stack's API uses (PGlite in memory). The store loads first so every seed and domain
// module finishes loading before the sample is built.
import '@/store/db'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildSampleDB } from '@/data/seed'
import type { Db } from '../../server/src/db'
import { ROW_CAP, runReadOnly, type SqlAnswer } from '../../server/src/dev/readonly'
import { checkStatement } from '../../server/src/dev/statement'
import { replaceWorkspace } from '../../server/src/repo'
import { makeTestDb } from '../../server/src/test/helpers'
import { parseWorkspace } from '../../server/src/validate'
import { asObjects, cellText, DEFAULT_WORKSPACE, formatTable, parseSqlArgs, problemText, requestFor, rowCountLine, SHORTCUTS, type ShortcutName, USAGE } from './sql-lib'

describe('parseSqlArgs', () => {
  it('reads a shortcut, in any case', () => {
    expect(parseSqlArgs(['hires'])).toMatchObject({ shortcut: 'hires', sql: SHORTCUTS.hires.sql, json: false, offset: 0, workspace: null, today: null })
    expect(parseSqlArgs(['Integrity']).shortcut).toBe('integrity')
  })

  it('reads a statement of your own, joining words a shell split apart', () => {
    expect(parseSqlArgs(['SELECT * FROM v_people'])).toMatchObject({ shortcut: null, sql: 'SELECT * FROM v_people' })
    expect(parseSqlArgs(['SELECT', '1'])).toMatchObject({ shortcut: null, sql: 'SELECT 1' })
  })

  it('takes one SQL word as a statement, so COMMIT alone reaches the checks that refuse it', () => {
    for (const word of ['COMMIT', 'rollback', 'BEGIN', 'END', 'ABORT', 'VACUUM']) expect(parseSqlArgs([word]), word).toMatchObject({ shortcut: null, sql: word })
  })

  it('reads every option, as one word or two, before or after', () => {
    expect(parseSqlArgs(['people', '--json', '--workspace', 'acme', '--today=2026-10-09', '--offset', '10'])).toMatchObject({
      shortcut: 'people',
      json: true,
      workspace: 'acme',
      today: '2026-10-09',
      offset: 10,
    })
    expect(parseSqlArgs(['--workspace=acme', 'funnel'])).toMatchObject({ workspace: 'acme', shortcut: 'funnel' })
    expect(parseSqlArgs(['-h']).help).toBe(true)
    expect(parseSqlArgs(['--help', 'nonsense']).help).toBe(true)
    // After --, everything is the statement.
    expect(parseSqlArgs(['--', '--json']).sql).toBe('--json')
  })

  it('says what is wrong', () => {
    expect(() => parseSqlArgs([])).toThrow('Name a shortcut or give a statement in quotes.')
    expect(() => parseSqlArgs(['hirse'])).toThrow('"hirse" is not a shortcut. The shortcuts are people, headcount, hires, funnel, payruns, integrity')
    expect(() => parseSqlArgs(['hires', 'funnel'])).toThrow('Run one shortcut at a time')
    expect(() => parseSqlArgs(['hires', '--jsno'])).toThrow('Unknown option "--jsno"')
    expect(() => parseSqlArgs(['hires', '--workspace'])).toThrow('--workspace needs a value')
    expect(() => parseSqlArgs(['hires', '--today', '9 Oct'])).toThrow('--today needs a date')
    expect(() => parseSqlArgs(['hires', '--offset', '-1'])).toThrow('--offset needs a whole number')
    expect(() => parseSqlArgs(['hires', '--offset', '1001'])).toThrow('--offset needs a whole number')
  })

  it('has usage text that names every shortcut', () => {
    for (const name of Object.keys(SHORTCUTS)) expect(USAGE).toContain(`  ${name} `)
  })
})

describe('requestFor', () => {
  it('passes the company as $1 when the statement uses it', () => {
    expect(requestFor(parseSqlArgs(['hires']), 'acme-id')).toEqual({ sql: SHORTCUTS.hires.sql, params: ['acme-id'] })
    expect(requestFor(parseSqlArgs(['SELECT 1']), 'acme-id')).toEqual({ sql: 'SELECT 1', params: [] })
    expect(requestFor(parseSqlArgs(['hires', '--today', '2026-10-09']), DEFAULT_WORKSPACE)).toEqual({ sql: SHORTCUTS.hires.sql, params: ['default'], today: '2026-10-09' })
  })

  it('refuses --workspace for a statement without $1, and placeholders past $1', () => {
    expect(() => requestFor(parseSqlArgs(['SELECT 1', '--workspace', 'acme']), 'acme')).toThrow('this statement has no $1')
    expect(() => requestFor(parseSqlArgs(['SELECT $1::text, $2::text']), 'acme')).toThrow('Only $1 has a value here')
  })
})

describe('the table', () => {
  const answer: SqlAnswer = {
    columns: [
      { name: 'name', typeId: 25 },
      { name: 'n', typeId: 23 },
      { name: 'pay', typeId: 1700 },
      { name: 'extra', typeId: 3802 },
    ],
    rows: [
      ['Ada', 1, '120000.00', { a: 1 }],
      ['Bo', 12, null, null],
    ],
    truncated: false,
  }

  it('lines columns up, numbers on the right, nulls empty, JSON on one line', () => {
    expect(formatTable(answer)).toBe(
      [
        ' name | n  | pay       | extra', //
        '------+----+-----------+---------',
        ' Ada  |  1 | 120000.00 | {"a":1}',
        ' Bo   | 12 |           |',
      ].join('\n'),
    )
  })

  it('keeps each cell on one line and short', () => {
    expect(cellText('two\nlines\r\n\there')).toBe('two lines here')
    expect(cellText('x'.repeat(100), 10)).toBe('xxxxxxx...')
    expect(cellText(false)).toBe('false')
  })

  it('prints nothing for an answer without columns', () => {
    expect(formatTable({ columns: [], rows: [[], []] })).toBe('')
  })

  it('counts rows, and says when there were more', () => {
    expect(rowCountLine({ rows: [[1]], truncated: false })).toBe('(1 row)')
    expect(rowCountLine({ rows: [], truncated: false })).toBe('(0 rows)')
    expect(rowCountLine({ rows: Array.from({ length: ROW_CAP }, () => [1]), truncated: true })).toBe(`(the first ${ROW_CAP} rows; there are more. Add a WHERE or a LIMIT to see the ones you want.)`)
  })

  it('gives rows as objects for --json', () => {
    expect(asObjects(answer)).toEqual([
      { name: 'Ada', n: 1, pay: '120000.00', extra: { a: 1 } },
      { name: 'Bo', n: 12, pay: null, extra: null },
    ])
  })
})

describe('problemText', () => {
  it('says why a statement was refused', () => {
    expect(problemText({ kind: 'refused', message: 'COMMIT would end it.' }, 'COMMIT')).toBe('Refused: COMMIT would end it.')
  })

  it("shows the database's error under the line it points at", () => {
    const sql = 'SELECT full_name,\n       nope\nFROM v_people'
    expect(problemText({ kind: 'sql_error', message: 'column "nope" does not exist', code: '42703', position: 26 }, sql)).toBe(
      ['The database said (42703): column "nope" does not exist', '         nope', '         ^'].join('\n'),
    )
    expect(problemText({ kind: 'sql_error', message: 'syntax error' }, 'SELEC 1')).toBe('The database said: syntax error')
  })
})

describe('npm run sql stays on this computer', () => {
  const sources = ['scripts/dev/sql.ts', 'scripts/dev/sql-worker.ts', 'scripts/dev/sql-lib.ts'].map((file) => [file, readFileSync(file, 'utf8')] as const)

  it('never reads DATABASE_URL, a .env file or the server settings', () => {
    for (const [file, code] of sources) {
      // The header comment says so in words; the code itself must not touch them.
      const body = code.replace(/^\/\/.*$/gm, '')
      expect(body, file).not.toMatch(/DATABASE_URL|loadConfig|loadDotEnv|process\.env/)
    }
  })

  it('only ever calls 127.0.0.1', () => {
    const [, sql] = sources[0]
    const urls = [...sql.matchAll(/`(\w+:\/\/[^`]*)`/g)].map((m) => m[1])
    expect(urls).toEqual(['http://127.0.0.1:${port}/api/health', 'http://127.0.0.1:${port}${DEV_SQL_PATH}'])
  })
})

describe('the shortcuts', () => {
  it('are each one statement that reads, for one company ($1)', () => {
    for (const [name, s] of Object.entries(SHORTCUTS)) expect(checkStatement(s.sql), name).toMatchObject({ ok: true, kind: 'cursor', placeholders: 1 })
  })

  describe('on the sample company', () => {
    const ANCHOR = '2026-10-09'
    let db: Db
    beforeAll(async () => {
      db = await makeTestDb()
      await replaceWorkspace(db, parseWorkspace({ db: buildSampleDB(), confirmReplace: true }), null, DEFAULT_WORKSPACE)
    })
    afterAll(async () => {
      await db.close()
    })

    const run = (name: ShortcutName) => runReadOnly(db, requestFor(parseSqlArgs([name, '--today', ANCHOR]), DEFAULT_WORKSPACE))

    it('all run, and the sample has rows for each but integrity, which is clean', async () => {
      for (const name of Object.keys(SHORTCUTS) as ShortcutName[]) {
        const answer = await run(name)
        expect(answer.truncated, name).toBe(false)
        if (name === 'integrity') expect(answer.rows, name).toEqual([])
        else expect(answer.rows.length, name).toBeGreaterThan(0)
      }
    })

    it('read hires as one row per hire, with the columns the table prints', async () => {
      const hires = await run('hires')
      expect(hires.columns.map((c) => c.name)).toEqual(['employee_no', 'person_name', 'job_title', 'source', 'applied_on', 'offer_accepted_on', 'start_date', 'days_to_hire', 'tasks_done', 'tasks', 'first_payday'])
      expect(hires.rows).toHaveLength(16)
      expect(formatTable(hires).split('\n')).toHaveLength(18)
    })

    it('read nothing of another company', async () => {
      const other = await runReadOnly(db, requestFor(parseSqlArgs(['people']), 'no-such-company'))
      expect(other.rows).toEqual([])
    })
  })
})
