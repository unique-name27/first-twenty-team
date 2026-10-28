import { describe, expect, it } from 'vitest'
import { checkStatement, scan } from './statement'

const refused = (sql: string): string => {
  const r = checkStatement(sql)
  if (r.ok) throw new Error(`expected a refusal for ${JSON.stringify(sql)}`)
  return r.reason
}

describe('checkStatement: what may run', () => {
  it('takes one SELECT, WITH, VALUES or TABLE, to run through a cursor', () => {
    for (const sql of ['SELECT 1', 'select * from v_people', 'WITH x AS (SELECT 1) SELECT * FROM x', 'VALUES (1), (2)', 'TABLE v_people', '(SELECT 1) UNION (SELECT 2)']) {
      expect(checkStatement(sql), sql).toMatchObject({ ok: true, kind: 'cursor' })
    }
  })

  it('takes EXPLAIN and SHOW, to run as they are', () => {
    expect(checkStatement('EXPLAIN SELECT 1')).toMatchObject({ ok: true, kind: 'direct', firstWord: 'explain' })
    expect(checkStatement('show statement_timeout')).toMatchObject({ ok: true, kind: 'direct', firstWord: 'show' })
  })

  it('drops one trailing semicolon and the space and comments after it, and keeps comments before', () => {
    expect(checkStatement('  SELECT 1;  ')).toMatchObject({ ok: true, statement: 'SELECT 1' })
    expect(checkStatement('SELECT 1; -- done\n')).toMatchObject({ ok: true, statement: 'SELECT 1' })
    expect(checkStatement('SELECT 1;;')).toMatchObject({ ok: true, statement: 'SELECT 1' })
    expect(checkStatement('-- people\n/* all */ SELECT 1')).toMatchObject({ ok: true, firstWord: 'select', statement: '-- people\n/* all */ SELECT 1' })
  })

  it('counts the highest $n placeholder, outside strings, comments and names', () => {
    expect(checkStatement('SELECT * FROM v_people WHERE workspace_id = $1')).toMatchObject({ ok: true, placeholders: 1 })
    expect(checkStatement('SELECT $2::int, $1::int')).toMatchObject({ ok: true, placeholders: 2 })
    expect(checkStatement("SELECT '$1', \"a$1\", a$1 FROM t -- $3\n/* $4 */")).toMatchObject({ ok: true, placeholders: 0 })
    expect(checkStatement('SELECT $q$ $5 $q$')).toMatchObject({ ok: true, placeholders: 0 })
  })
})

describe('checkStatement: one statement at a time', () => {
  it('refuses a second statement, however it is written', () => {
    for (const sql of [
      'SELECT 1; SELECT 2',
      'SELECT 1; DELETE FROM people',
      'SELECT 1;\nCOMMIT',
      'SELECT 1; /* hidden */ COMMIT',
      "SELECT 'a'; SELECT 'b'",
      'SELECT 1 /* a */; -- b\n SELECT 2',
    ]) {
      expect(refused(sql), sql).toMatch(/one statement at a time/)
    }
  })

  it('never counts a semicolon inside a string, a name, a dollar quote or a comment', () => {
    for (const sql of [
      "SELECT ';'",
      "SELECT 'it''s; fine'",
      "SELECT E'a\\'; b'",
      'SELECT 1 AS ";"',
      'SELECT $$;$$',
      'SELECT $tag$ ; $$ ; $tag$',
      'SELECT 1 -- ; COMMIT',
      'SELECT 1 /* ; /* nested ; */ still a comment ; */',
    ]) {
      expect(checkStatement(sql), sql).toMatchObject({ ok: true })
    }
  })

  it('refuses text that leaves a quote or comment open, since it cannot tell where the statement ends', () => {
    expect(refused("SELECT 'abc")).toMatch(/leaves a quote \(.\) open/)
    expect(refused('SELECT "abc')).toMatch(/double quote/)
    expect(refused('SELECT $x$ abc')).toMatch(/dollar quote \(\$x\$\)/)
    expect(refused('SELECT 1 /* abc')).toMatch(/comment/)
    expect(refused('SELECT 1 /* a /* b */')).toMatch(/comment/)
  })

  it('refuses empty text', () => {
    for (const sql of ['', '   ', ';', '-- nothing\n', '/* nothing */']) expect(refused(sql), sql).toMatch(/no statement to run/)
  })
})

describe('checkStatement: nothing that starts, ends or changes the transaction', () => {
  const cases: [string, RegExp][] = [
    ['COMMIT', /^COMMIT would/],
    ['commit;', /^COMMIT would/],
    ['ROLLBACK', /^ROLLBACK would/],
    ['ROLLBACK TO SAVEPOINT a', /^ROLLBACK would/],
    ['SET TRANSACTION READ WRITE', /^SET TRANSACTION would/],
    ['set  transaction isolation level serializable', /^SET TRANSACTION would/],
    ['/* sneaky */ SET TRANSACTION READ WRITE', /^SET TRANSACTION would/],
    ['SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE', /^SET would/],
    ['SET LOCAL statement_timeout = 0', /^SET would/],
    ['SET first_twenty.today = \'2026-10-09\'', /^SET would/],
    ['RESET ALL', /^RESET would/],
    ['BEGIN', /^BEGIN would/],
    ['BEGIN READ WRITE', /^BEGIN would/],
    ['START TRANSACTION READ WRITE', /^START would/],
    ['END', /^END would/],
    ['ABORT', /^ABORT would/],
    ['SAVEPOINT a', /^SAVEPOINT would/],
    ['RELEASE SAVEPOINT a', /^RELEASE would/],
    ["PREPARE TRANSACTION 'x'", /^PREPARE would/],
    ['DISCARD ALL', /^DISCARD would/],
  ]
  for (const [sql, message] of cases) {
    it(`refuses ${sql}`, () => {
      const reason = refused(sql)
      expect(reason).toMatch(message)
      expect(reason).toMatch(/read only, rolled back after/)
    })
  }
})

describe('checkStatement: reads only', () => {
  it('refuses statements that write or do anything but read, naming them', () => {
    for (const [sql, word] of [
      ['INSERT INTO people VALUES (1)', 'INSERT'],
      ['UPDATE people SET data = data', 'UPDATE'],
      ['delete from people', 'DELETE'],
      ['DROP VIEW v_people', 'DROP'],
      ['CREATE TABLE t (a int)', 'CREATE'],
      ['TRUNCATE people', 'TRUNCATE'],
      ['COPY people TO STDOUT', 'COPY'],
      ["DO $$ BEGIN PERFORM 1; END $$", 'DO'],
      ['CALL p()', 'CALL'],
      ['DECLARE c CURSOR FOR SELECT 1', 'DECLARE'],
      ['FETCH 1 FROM c', 'FETCH'],
      ['LOCK people', 'LOCK'],
      ['VACUUM', 'VACUUM'],
      ['selectx 1', 'SELECTX'],
    ]) {
      expect(refused(sql), sql).toBe(`npm run sql only reads, so it refuses ${word}. Start the statement with SELECT, WITH, VALUES, TABLE, EXPLAIN or SHOW.`)
    }
    expect(refused("'SELECT 1'")).toMatch(/refuses that\./)
  })
})

describe('scan', () => {
  it('reads the first two tokens after comments and opening parentheses', () => {
    expect(scan('/* a */ ((select x').words).toEqual(['select', 'x'])
    expect(scan("set 'x'").words).toEqual(['set', ''])
  })

  it('takes backslash escapes only in E strings', () => {
    // Standard strings keep a backslash as it is, so the quote after it closes the string.
    expect(scan("SELECT 'a\\'; SELECT 2").semicolons).toHaveLength(1)
    expect(scan("SELECT E'a\\'; SELECT 2'").semicolons).toHaveLength(0)
  })
})
