// Development only (`npm run sql`, docs/DEV.md): checks one SQL statement before readonly.ts runs it. It
// reads the text the way Postgres splits it (quotes, "identifiers", $tag$ dollar quotes, -- and /* */
// comments), so a semicolon or $1 inside a string never counts. Pure: no database.
//
// The checks are the friendly first line, not the guard: readonly.ts also runs every statement in a
// read-only transaction that it rolls back, over the extended query protocol, which refuses a second
// statement by itself.

/** How readonly.ts runs a statement: through a cursor, so it fetches only the rows it shows, or as it is. */
export type StatementKind = 'cursor' | 'direct'

export type CheckedStatement =
  | {
      ok: true
      /** The statement without a trailing semicolon (and anything after it but comments). */
      statement: string
      /** The first word, lowercase: select, with, values, table, explain or show. */
      firstWord: string
      kind: StatementKind
      /** The highest $n placeholder, 0 when there is none. */
      placeholders: number
    }
  | { ok: false; reason: string }

/** Statements that can run through DECLARE ... CURSOR, which accepts a SELECT or VALUES in any of these forms. */
const CURSOR_STARTS = new Set(['select', 'with', 'values', 'table'])
/** Statements that read but cannot run through a cursor; their answers are short. */
const DIRECT_STARTS = new Set(['explain', 'show'])
/** Statements that would end, start or change the transaction readonly.ts runs each statement in. */
const TRANSACTION_STARTS = new Set(['begin', 'start', 'commit', 'end', 'rollback', 'abort', 'savepoint', 'release', 'prepare', 'set', 'reset', 'discard'])

export const ALLOWED_STARTS = 'SELECT, WITH, VALUES, TABLE, EXPLAIN or SHOW'

/** Other first words of SQL statements: npm run sql takes one of these alone as a statement (and refuses it), not as a shortcut. */
const OTHER_STARTS = new Set(['insert', 'update', 'delete', 'merge', 'create', 'drop', 'alter', 'truncate', 'copy', 'call', 'do', 'grant', 'revoke', 'vacuum', 'analyze', 'lock', 'checkpoint', 'listen', 'notify', 'unlisten', 'declare', 'fetch', 'move', 'close', 'execute', 'deallocate', 'refresh', 'reindex', 'cluster', 'comment', 'load'])

/** Whether `word` starts some SQL statement (any case). */
export function isStatementWord(word: string): boolean {
  const w = word.toLowerCase()
  return CURSOR_STARTS.has(w) || DIRECT_STARTS.has(w) || TRANSACTION_STARTS.has(w) || OTHER_STARTS.has(w)
}

const isIdentChar = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_$\u0080-\uFFFF]/.test(c)
const isIdentStart = (c: string | undefined) => c !== undefined && /[A-Za-z_\u0080-\uFFFF]/.test(c)

type Scan = {
  /** Positions of semicolons outside quotes and comments. */
  semicolons: number[]
  /** Position of the last character that is not space, a comment or a semicolon (-1: none). */
  lastCode: number
  /**
   * The first two tokens outside comments, after any opening parentheses: a word in lowercase, or '' for
   * anything else (a quote, a number, punctuation).
   */
  words: string[]
  placeholders: number
  /** What was left open at the end: a quote, an identifier or a comment. */
  unclosed: string | null
}

/** Reads `sql` token by token, as far as the checks need. */
export function scan(sql: string): Scan {
  const out: Scan = { semicolons: [], lastCode: -1, words: [], placeholders: 0, unclosed: null }
  let i = 0
  const n = sql.length
  /** Marks a token at [start, end): `word` when it is a word. Opening parentheses before the first word do not count. */
  const token = (start: number, end: number, word = '') => {
    if (out.words.length < 2 && !(out.words.length === 0 && sql[start] === '(')) out.words.push(word.toLowerCase())
    out.lastCode = end - 1
  }
  while (i < n) {
    const c = sql[i]
    const next = sql[i + 1]
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      i = end === -1 ? n : end + 1
    } else if (c === '/' && next === '*') {
      // Postgres block comments nest.
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--
          i += 2
        } else i++
      }
      if (depth > 0) out.unclosed = 'a /* comment'
    } else if (c === "'" || c === '"') {
      // '' (or "") inside stands for the quote itself; E'...' strings also take backslash escapes.
      const backslashes = c === "'" && (sql[i - 1] === 'E' || sql[i - 1] === 'e') && !isIdentChar(sql[i - 2])
      const start = i
      let closed = false
      i++
      while (i < n) {
        if (backslashes && sql[i] === '\\') i += 2
        else if (sql[i] === c && sql[i + 1] === c) i += 2
        else if (sql[i] === c) {
          closed = true
          i++
          break
        } else i++
      }
      if (!closed) out.unclosed = c === "'" ? "a quote (')" : 'a double quote (")'
      token(start, i)
    } else if (c === '$' && !isIdentChar(sql[i - 1])) {
      const start = i
      const placeholder = /^\$(\d+)/.exec(sql.slice(i))
      const tag = placeholder ? null : /^\$((?:[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?)\$/.exec(sql.slice(i))
      if (placeholder) {
        out.placeholders = Math.max(out.placeholders, Number(placeholder[1]))
        i += placeholder[0].length
      } else if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length)
        if (end === -1) {
          out.unclosed = `a dollar quote (${tag[0]})`
          i = n
        } else i = end + tag[0].length
      } else i++
      token(start, i)
    } else if (c === ';') {
      out.semicolons.push(i)
      i++
    } else if (/\s/.test(c)) {
      i++
    } else if (isIdentStart(c)) {
      const start = i
      while (i < n && isIdentChar(sql[i])) i++
      token(start, i, sql.slice(start, i))
    } else {
      token(i, i + 1)
      i++
    }
  }
  return out
}

/** Whether `sql` is one statement that only reads, and how to run it; otherwise the reason in plain words. */
export function checkStatement(sql: string): CheckedStatement {
  const s = scan(sql)
  if (s.unclosed) return { ok: false, reason: `The statement leaves ${s.unclosed} open. Close it and try again.` }
  if (s.lastCode === -1) return { ok: false, reason: `There is no statement to run. Write one that starts with ${ALLOWED_STARTS}.` }
  const first = s.semicolons[0]
  if (first !== undefined && s.lastCode > first) {
    return { ok: false, reason: 'Run one statement at a time: npm run sql takes a single statement, so it refuses text with two or more.' }
  }
  const [word = '', second = ''] = s.words
  if (TRANSACTION_STARTS.has(word)) {
    const what = word === 'set' && second === 'transaction' ? 'SET TRANSACTION' : word.toUpperCase()
    return {
      ok: false,
      reason: `${what} would start, end or change the transaction npm run sql runs each statement in (read only, rolled back after), so it is refused. Run one statement that starts with ${ALLOWED_STARTS}.`,
    }
  }
  if (!CURSOR_STARTS.has(word) && !DIRECT_STARTS.has(word)) {
    return { ok: false, reason: `npm run sql only reads, so it refuses ${word ? word.toUpperCase() : 'that'}. Start the statement with ${ALLOWED_STARTS}.` }
  }
  const statement = (first === undefined ? sql : sql.slice(0, first)).trim()
  return { ok: true, statement, firstWord: word, kind: CURSOR_STARTS.has(word) ? 'cursor' : 'direct', placeholders: s.placeholders }
}
