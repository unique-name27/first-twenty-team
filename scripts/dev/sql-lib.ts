// The pure parts of `npm run sql` (scripts/dev/sql.ts, docs/DEV.md): the command line, the shortcut queries
// and the table it prints. No file, network or database access, so tests import it directly. The
// statement checks themselves live with the code that enforces them, server/src/dev/statement.ts.
import { ROW_CAP, type SqlAnswer, type SqlProblem, type SqlRequest, STATEMENT_TIMEOUT_MS } from '../../server/src/dev/readonly'
import { isStatementWord, scan } from '../../server/src/dev/statement'
import { WORKSPACE_ID } from '../../server/src/sqlgen'
import { MAX_OFFSET } from './stack-lib.mjs'

/** The company the shortcuts read unless --workspace names another: the one npm run stack loads the sample into. */
export const DEFAULT_WORKSPACE = WORKSPACE_ID

export type Shortcut = { about: string; sql: string }

/**
 * Ready-made queries over the read model (migration 007), each for one company ($1). They follow
 * server/deploy/browse.sql, a little narrower to fit a terminal.
 */
export const SHORTCUTS = {
  people: {
    about: "everyone on the team, with today's title, department and pay",
    sql: `SELECT c.hire_number AS employee_no, c.full_name, c.employment_state, c.title, c.department_name, c.pay_type,
       c.salary, c.hourly_rate, c.start_date, c.end_date
FROM v_current_job c
WHERE c.workspace_id = $1
ORDER BY c.hire_number`,
  },
  headcount: {
    about: 'headcount at the end of each month, with starts and last days',
    sql: `SELECT h.month, h.headcount, h.starts, h.departures
FROM v_headcount_by_month h
WHERE h.workspace_id = $1
ORDER BY h.month`,
  },
  hires: {
    about: 'one row per hire, from the job to the first pay run',
    sql: `SELECT j.hire_number AS employee_no, j.person_name, j.job_title, j.source, j.applied_on, j.offer_accepted_on,
       j.start_date, j.days_to_hire, j.onboarding_tasks_done AS tasks_done, j.onboarding_tasks_total AS tasks, j.first_payday
FROM v_hire_journey j
WHERE j.workspace_id = $1
ORDER BY j.start_date, j.hire_number`,
  },
  funnel: {
    about: 'applications per job and stage, in each job\'s stage order',
    sql: `SELECT f.job_title, f.stage_position AS pos, f.stage_name, f.reached, f.in_stage, f.active, f.rejected,
       f.withdrawn, f.hired
FROM v_pipeline_funnel f
WHERE f.workspace_id = $1
ORDER BY f.job_title, f.stage_position`,
  },
  payruns: {
    about: 'pay periods marked submitted, with the totals entered afterwards',
    sql: `SELECT r.period_start, r.period_end, r.payday, r.submitted_on, r.gross, r.employer_taxes, r.people_in_period
FROM v_pay_runs r
WHERE r.workspace_id = $1
ORDER BY r.period_start`,
  },
  integrity: {
    about: 'what should never be true of the data (empty is good)',
    sql: `SELECT i.severity, i.code, i.collection, i.record_id, i.field, i.other_id
FROM v_integrity_problems i
WHERE i.workspace_id = $1
ORDER BY i.severity, i.code, i.collection, i.record_id`,
  },
} as const satisfies Record<string, Shortcut>

export type ShortcutName = keyof typeof SHORTCUTS

/** Finds a company by id or slug ($1). */
export const WORKSPACE_LOOKUP_SQL = 'SELECT id, slug, name FROM workspaces WHERE id = $1 OR slug = $1 ORDER BY id = $1 DESC LIMIT 1'
/** The companies on the stack's server, for the message when --workspace names none of them. */
export const WORKSPACE_LIST_SQL = 'SELECT id, slug, name FROM workspaces ORDER BY keep DESC, name LIMIT 20'

const shortcutLines = Object.entries(SHORTCUTS)
  .map(([name, s]) => `  ${name.padEnd(11)} ${s.about}`)
  .join('\n')

export const USAGE = `Usage: npm run sql -- <shortcut> [--workspace <id or slug>] [--today YYYY-MM-DD] [--json]
       npm run sql -- "<one SELECT>" [the same options]

Reads the npm run stack database and never changes it: through the running stack's API, or straight from
.data/dev/pg when no stack runs. One statement at a time, at most ${ROW_CAP} rows, ${STATEMENT_TIMEOUT_MS / 1000} seconds.

Shortcuts (the sample company, workspace '${DEFAULT_WORKSPACE}', unless --workspace names another):
${shortcutLines}

Options:
  --workspace X   another company, by id or slug (npm run sql -- "SELECT id, slug, name FROM workspaces")
  --today D       read the views that depend on today as of D, like 2026-10-09
  --json          print the rows as JSON instead of a table
  --offset N      the stack started with npm run stack -- --offset N
  --help          show this text

In your own SQL, $1 stands for the company:
  npm run sql -- 'SELECT full_name, title FROM v_current_job WHERE workspace_id = $1'`

export type SqlArgs = {
  help: boolean
  json: boolean
  offset: number
  /** --workspace: a company's id or slug; null for DEFAULT_WORKSPACE. */
  workspace: string | null
  today: string | null
  /** The shortcut named, or null for a statement of one's own. */
  shortcut: ShortcutName | null
  /** The statement to run: the shortcut's, or the one given ('' with --help). */
  sql: string
}

const isShortcut = (word: string): word is ShortcutName => Object.hasOwn(SHORTCUTS, word)

/** The command line, or an Error whose message says what is wrong (the caller prints USAGE too). */
export function parseSqlArgs(argv: readonly string[]): SqlArgs {
  const out: SqlArgs = { help: false, json: false, offset: 0, workspace: null, today: null, shortcut: null, sql: '' }
  const words: string[] = []
  let optionsDone = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--' && !optionsDone) {
      optionsDone = true
      continue
    }
    // An option is one word like --json or --today=2026-10-09; anything else (a statement) is not.
    if (optionsDone || !/^--?[a-z][a-z-]*(=.*)?$/is.test(arg)) {
      words.push(arg)
      continue
    }
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
    const value = (): string => {
      const v = inline ?? argv[++i]
      if (v === undefined || v === '') throw new Error(`${flag} needs a value.`)
      return v
    }
    if (flag === '--help' || flag === '-h') out.help = true
    else if (flag === '--json') out.json = true
    else if (flag === '--workspace') out.workspace = value().trim()
    else if (flag === '--today') {
      const day = value()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`--today needs a date like 2026-10-09 (got "${day}").`)
      out.today = day
    } else if (flag === '--offset') {
      const raw = value()
      if (!/^\d+$/.test(raw) || Number(raw) > MAX_OFFSET) throw new Error(`--offset needs a whole number from 0 to ${MAX_OFFSET}, like --offset 10 (got "${raw}").`)
      out.offset = Number(raw)
    } else throw new Error(`Unknown option "${flag}".`)
  }
  if (out.help) return out
  if (words.length === 0) throw new Error('Name a shortcut or give a statement in quotes.')
  const first = words[0].trim().toLowerCase()
  if (isShortcut(first)) {
    if (words.length > 1) throw new Error(`Run one shortcut at a time (got "${words.join(' ')}").`)
    out.shortcut = first
    out.sql = SHORTCUTS[first].sql
    return out
  }
  const sql = words.join(' ')
  // One bare word is a misspelled shortcut, unless it is SQL (COMMIT alone goes on, to be refused there).
  if (/^[a-z_]+$/i.test(sql.trim()) && !isStatementWord(sql.trim())) throw new Error(`"${sql.trim()}" is not a shortcut. The shortcuts are ${Object.keys(SHORTCUTS).join(', ')}; put a statement of your own in quotes.`)
  out.sql = sql
  return out
}

/**
 * The request for these arguments, with `workspaceId` as $1 when the statement uses it. Throws when the
 * statement wants more values than that, or --workspace was given for a statement without $1.
 */
export function requestFor(args: SqlArgs, workspaceId: string): SqlRequest {
  const placeholders = scan(args.sql).placeholders
  if (placeholders > 1) throw new Error('Only $1 has a value here (the company). Write any other value into the statement.')
  if (placeholders === 0 && args.workspace !== null) {
    throw new Error('--workspace picks the company for a shortcut, or for $1 in a statement of your own, and this statement has no $1.')
  }
  return { sql: args.sql, params: placeholders === 1 ? [workspaceId] : [], ...(args.today ? { today: args.today } : {}) }
}

/** Postgres type ids of numbers, which the table lines up on the right. */
export const NUMBER_TYPE_IDS = new Set([20, 21, 23, 26, 700, 701, 1700])

/** One cell as table text: empty for null, JSON for lists and objects, on one line, at most `max` characters. */
export function cellText(value: unknown, max = 60): string {
  if (value === null || value === undefined) return ''
  const text = (typeof value === 'object' ? JSON.stringify(value) : String(value)).replace(/\s*[\r\n\t]+\s*/g, ' ')
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

/** The answer as an aligned text table: a header, a rule, a line per row (numbers on the right). */
export function formatTable(answer: Pick<SqlAnswer, 'columns' | 'rows'>, max = 60): string {
  if (answer.columns.length === 0) return ''
  const cells = answer.rows.map((row) => row.map((v) => cellText(v, max)))
  const widths = answer.columns.map((c, i) => Math.max(c.name.length, ...cells.map((r) => r[i].length)))
  const right = answer.columns.map((c) => NUMBER_TYPE_IDS.has(c.typeId))
  const line = (values: string[], alignRight: boolean[]) =>
    ` ${values.map((v, i) => (alignRight[i] ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join(' | ')}`.trimEnd()
  return [
    line(
      answer.columns.map((c) => c.name),
      answer.columns.map(() => false),
    ),
    widths.map((w) => '-'.repeat(w + 2)).join('+'),
    ...cells.map((r) => line(r, right)),
  ].join('\n')
}

/** The line under the table: how many rows, and whether there were more than it shows. */
export function rowCountLine(answer: Pick<SqlAnswer, 'rows' | 'truncated'>): string {
  const n = answer.rows.length
  if (answer.truncated) return `(the first ${n} rows; there are more. Add a WHERE or a LIMIT to see the ones you want.)`
  return `(${n} row${n === 1 ? '' : 's'})`
}

/** The rows as objects keyed by column name, for --json. */
export function asObjects(answer: Pick<SqlAnswer, 'columns' | 'rows'>): Record<string, unknown>[] {
  return answer.rows.map((row) => Object.fromEntries(answer.columns.map((c, i) => [c.name, row[i]])))
}

/**
 * A problem in plain words: why a statement was refused, or the database's error with the line of the
 * statement it points at and a ^ under the spot.
 */
export function problemText(problem: SqlProblem, sql: string): string {
  if (problem.kind === 'refused') return `Refused: ${problem.message}`
  const lines = [`The database said${problem.code ? ` (${problem.code})` : ''}: ${problem.message}`]
  const at = problem.position
  if (at !== undefined && at >= 1 && at <= sql.length) {
    const lineStart = sql.lastIndexOf('\n', at - 1) + 1
    const lineEnd = sql.indexOf('\n', lineStart)
    const text = sql.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
    lines.push(`  ${text.replace(/\t/g, ' ')}`, `  ${' '.repeat(at - 1 - lineStart)}^`)
  }
  return lines.join('\n')
}
