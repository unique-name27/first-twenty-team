// The pure parts of `npm run sim` (scripts/dev/sim.ts, docs/DEV.md "Simulate a company"): the command line,
// how long an advance runs, the company reset puts on today's date, the company's date between commands,
// the cache key and the names of saves. No file, network or database access (the cache key reads files, and
// reset gets its generated company, through functions the caller passes), so tests import it directly.
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { DB } from '../../src/domain/types'
import { addDays, addMonths, daysBetween, getClockOverride, type ISODate, isUsableDate, setClockOverride } from '../../src/lib/dates'
import { num } from '../../src/lib/format'
import { advance, type PolicyName, POLICIES } from '../../src/sim/advance'
import { SCENARIO_NAMES, SCENARIOS, type ScenarioName } from '../../src/sim/scenarios'
import { MAX_OFFSET } from './stack-lib.mjs'

export const COMMANDS = ['list', 'run', 'reset', 'advance', 'save', 'restore', 'saves'] as const
export type Command = (typeof COMMANDS)[number]

/** The seed an advance uses when none is given: the same command on the same company tells the same story. */
export const DEFAULT_ADVANCE_SEED = 1

export const USAGE = `Usage: npm run sim -- <command> [options]

  list                                 the scenarios, one line each
  run <scenario>                       generate a scenario and print its summary
      [--seed N] [--as-of YYYY-MM-DD]  another seed or as-of date than the scenario's own
      [--out file.json]                also write the workspace, as Settings > Data > Import reads it
  reset <scenario> [--seed N]          replace the stack's company with the scenario, on today's date
      [--as-of YYYY-MM-DD] [--no-shift]  (--no-shift keeps it on its as-of date)
  advance <30d|12w|3m|YYYY-MM-DD>      live the stack's company through the next days
      [--policy quiet|normal|busy] [--seed N]
  save <name>                          keep a copy of the stack's company in <data folder>/saves
  restore <name>                       put a saved copy back
  saves                                list the saved copies

  --offset N    the stack started with npm run stack -- --offset N (its own ports and data folder)
  --help        show this text

While the stack runs, reset, advance, save and restore go through its API, and the app picks up the new
company on its next sync. With no stack running, they open the stack's database folder themselves.`

export type SimArgs = {
  command: Command | 'help'
  scenario: ScenarioName | null
  seed: number | null
  asOf: ISODate | null
  out: string | null
  shift: boolean
  duration: string | null
  policy: PolicyName
  name: string | null
  offset: number
}

/** What each command takes after its name, and which options. */
const SHAPES: Record<Command, { positional: 'scenario' | 'duration' | 'name' | null; options: readonly string[] }> = {
  list: { positional: null, options: [] },
  run: { positional: 'scenario', options: ['--seed', '--as-of', '--out'] },
  reset: { positional: 'scenario', options: ['--seed', '--as-of', '--no-shift'] },
  advance: { positional: 'duration', options: ['--policy', '--seed'] },
  save: { positional: 'name', options: [] },
  restore: { positional: 'name', options: [] },
  saves: { positional: null, options: [] },
}

/** The command line (process.argv.slice(2)), or an Error saying what is wrong (the caller prints USAGE too). */
export function parseSimArgs(argv: readonly string[]): SimArgs {
  const out: SimArgs = { command: 'help', scenario: null, seed: null, asOf: null, out: null, shift: true, duration: null, policy: 'normal', name: null, offset: 0 }
  const positionals: string[] = []
  const given = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    if (raw === '--help' || raw === '-h') return { ...out, command: 'help' }
    if (!raw.startsWith('--')) {
      positionals.push(raw)
      continue
    }
    const eq = raw.indexOf('=')
    const flag = eq > 0 ? raw.slice(0, eq) : raw
    const value = (): string => {
      const v = eq > 0 ? raw.slice(eq + 1) : argv[++i]
      if (v === undefined || v === '') throw new Error(`${flag} needs a value.`)
      return v
    }
    given.add(flag)
    if (flag === '--offset') out.offset = parseOffset(value())
    else if (flag === '--seed') out.seed = parseSeed(value())
    else if (flag === '--as-of') {
      const v = value()
      if (!isUsableDate(v)) throw new Error(`--as-of needs a date written YYYY-MM-DD (got "${v}").`)
      out.asOf = v
    } else if (flag === '--out') out.out = value()
    else if (flag === '--policy') {
      const v = value()
      if (!(v in POLICIES)) throw new Error(`--policy is one of ${Object.keys(POLICIES).join(', ')} (got "${v}").`)
      out.policy = v as PolicyName
    } else if (flag === '--no-shift') {
      if (eq > 0) throw new Error('--no-shift takes no value.')
      out.shift = false
    } else throw new Error(`Unknown option "${flag}".`)
  }

  const [command, ...rest] = positionals
  if (command === undefined) return out
  if (!(COMMANDS as readonly string[]).includes(command)) throw new Error(`Unknown command "${command}". The commands: ${COMMANDS.join(', ')}.`)
  const shape = SHAPES[command as Command]
  out.command = command as Command
  for (const flag of given) {
    if (flag !== '--offset' && !shape.options.includes(flag)) throw new Error(`${command} does not take ${flag}.`)
  }
  if (shape.positional === null) {
    if (rest.length > 0) throw new Error(`${command} takes nothing after it (got "${rest.join(' ')}").`)
    return out
  }
  if (rest.length !== 1) throw new Error(`${command} needs ${shape.positional === 'duration' ? 'how far to go, like 30d' : `a ${shape.positional}`}${rest.length > 1 ? `, once (got "${rest.join(' ')}")` : ''}.`)
  const [arg] = rest
  if (shape.positional === 'scenario') {
    if (!(SCENARIO_NAMES as readonly string[]).includes(arg)) throw new Error(`No scenario named "${arg}". npm run sim -- list shows them.`)
    out.scenario = arg as ScenarioName
  } else if (shape.positional === 'duration') {
    parseDuration(arg)
    out.duration = arg
  } else {
    const problem = saveNameProblem(arg)
    if (problem) throw new Error(problem)
    out.name = arg
  }
  return out
}

function parseOffset(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`--offset needs a whole number, like --offset 10 (got "${raw}").`)
  const n = Number(raw)
  if (n > MAX_OFFSET) throw new Error(`--offset must be at most ${MAX_OFFSET} (got ${n}).`)
  return n
}

function parseSeed(raw: string): number {
  if (!/^\d{1,15}$/.test(raw)) throw new Error(`--seed needs a whole number of 0 or more, like --seed 7 (got "${raw}").`)
  return Number(raw)
}

export type Duration = { days: number } | { months: number } | { date: ISODate }

/** "30d", "12w", "3m" or a date: how far an advance goes. Throws on anything else. */
export function parseDuration(text: string): Duration {
  const m = /^(\d{1,4})([dwm])$/.exec(text)
  if (m) {
    const n = Number(m[1])
    if (n === 0) throw new Error(`Advance by at least one day (got "${text}").`)
    return m[2] === 'm' ? { months: n } : { days: m[2] === 'w' ? n * 7 : n }
  }
  if (isUsableDate(text)) return { date: text }
  throw new Error(`How far to advance is a number of days, weeks or months (30d, 12w, 3m) or a date written YYYY-MM-DD (got "${text}").`)
}

/** The last day an advance lives through, from the company's date. A date before it is the time machine's to refuse. */
export function advanceTarget(duration: Duration, from: ISODate): ISODate {
  if ('date' in duration) return duration.date
  return 'months' in duration ? addMonths(from, duration.months) : addDays(from, duration.days)
}

export type WeekShift = {
  /** Whole weeks, in days: from the as-of date to the latest same weekday on or before today. */
  days: number
  /** The as-of date reset generates the scenario on: that weekday. */
  movedAsOf: ISODate
  /** Days from there to today (0 to 6), which reset lives through with the time machine. */
  rest: number
}

/**
 * The date reset generates a scenario on so that the company's date can be `today`: the latest day on or
 * before today with the as-of date's weekday, whole weeks away, so the plan's weekdays keep their names.
 */
export function weekShift(input: { asOf: ISODate; today: ISODate }): WeekShift {
  const { asOf, today } = input
  const gap = daysBetween(asOf, today)
  const days = Math.floor(gap / 7) * 7
  return { days, movedAsOf: addDays(asOf, days), rest: gap - days }
}

/** A generated company as reset receives it (sim.ts reads it from its cache or generates it). */
export type Generated = { db: DB; summary: string; cached: boolean; ms: number }

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * The company reset loads for a generated scenario (not the sample as the app loads it), its date and a line
 * that says how it got there. With `shift`, the company's date is `today`: the scenario is generated as of
 * the date weekShift picks, so every date rule holds as it does for any as-of date (business days and
 * holidays, plan quarters, pay periods: scenario plans are written relative to the as-of date), then lived
 * through the 0 to 6 days left with the time machine at the normal policy. The story is never moved after
 * it is made. Without `shift`, the scenario is on its own as-of date. `generate` gives the scenario as of
 * a date. The clock override is left as it was.
 */
export function resetCompany(
  input: { scenario: ScenarioName; seed: number; asOf: ISODate; shift: boolean; today: ISODate },
  generate: (asOf: ISODate) => Generated,
): { db: DB; companyDate: ISODate; generated: Generated; note: string } {
  const { scenario, seed, asOf, today } = input
  if (!input.shift) {
    const generated = generate(asOf)
    const note = `Kept on its as-of date, ${asOf} (--no-shift). The app shows it on today's date; Settings > Data > Pretend today is shows ${asOf}.`
    return { db: generated.db, companyDate: asOf, generated, note }
  }
  const plan = weekShift({ asOf, today })
  const generated = generate(plan.movedAsOf)
  const on =
    plan.days === 0 ? `On its as-of date, ${asOf}` : `Generated as of ${plan.movedAsOf}, the last ${WEEKDAYS[new Date(`${asOf}T12:00:00Z`).getUTCDay()]} on or before today`
  if (plan.rest === 0) return { db: generated.db, companyDate: today, generated, note: `${on}: today.` }
  const previous = getClockOverride()
  setClockOverride(plan.movedAsOf)
  try {
    const lived = advance(generated.db, { to: today, seed: `reset ${scenario} ${seed}`, policy: 'normal' })
    const days = `${plan.rest} day${plan.rest === 1 ? '' : 's'}`
    return { db: lived.db, companyDate: today, generated, note: `${on}, then lived ${days} to today, ${today} (normal policy, ${num(lived.report.actions)} actions).` }
  } finally {
    setClockOverride(previous)
  }
}

/** What reset and advance remember between commands: the company's date, for the history the server gave its last replace. */
export type CompanyDate = { historyId: string; date: ISODate }

/**
 * The stack's company's date: the date the last reset, advance or restore left it on, while the server still
 * holds that copy (same history; edits in the browser keep it). Any other copy (the sample the stack loads,
 * an Import from the app) lives on the real date, `today`.
 */
export function companyDateFor(remembered: CompanyDate | null, historyId: string, today: ISODate): ISODate {
  return remembered && remembered.historyId === historyId && isUsableDate(remembered.date) ? remembered.date : today
}

export type CacheKey = { scenario: ScenarioName; seed: number; asOf: ISODate; sourceHash: string }

/** The cache file for a generated scenario. Every part of the key is in the name, so a change to any of them misses. */
export function cacheFileName(key: CacheKey): string {
  if (!/^[0-9a-f]{16,}$/.test(key.sourceHash)) throw new Error('A source hash is hexadecimal.')
  return `${cachePrefix(key)}${key.sourceHash.slice(0, 16)}.json`
}

/** The start every cache file of this scenario, seed and date shares: older files with it are from older code. */
export function cachePrefix(key: Pick<CacheKey, 'scenario' | 'seed' | 'asOf'>): string {
  return `${key.scenario}-${key.seed}-${key.asOf}-`
}

/** Every module specifier in `code`: static imports and exports, side-effect imports and import(). */
export function specifiers(code: string): string[] {
  const out: string[] = []
  for (const m of code.matchAll(/^\s*(?:import|export)\b[^'"`;]*?(?:\bfrom\s*)?['"]([^'"]+)['"]/gm)) out.push(m[1])
  for (const m of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1])
  return out
}

/**
 * A hash of every source file `entries` reach through imports (relative and @/ paths; packages are left
 * out), for the cache key: a change to the generator, the domain rules, the law tables, the name pools or
 * anything else generation runs on gives another hash. `read` returns a file's text, or undefined when there
 * is no such file. Files are hashed by their path from `root` and their text, in path order.
 */
export function sourceHash(entries: readonly string[], root: string, read: (file: string) => string | undefined): string {
  const seen = new Map<string, string>()
  const queue = [...entries]
  for (const entry of entries) {
    const text = read(entry)
    if (text === undefined) throw new Error(`No file at ${entry}.`)
    seen.set(entry, text)
  }
  while (queue.length > 0) {
    const file = queue.shift() as string
    if (!/\.(ts|tsx|mjs)$/.test(file)) continue
    for (const spec of specifiers(seen.get(file) as string)) {
      const base = spec.startsWith('@/') ? path.join(root, 'src', spec.slice(2)) : spec.startsWith('.') ? path.resolve(path.dirname(file), spec) : null
      if (base === null) continue
      const stem = base.replace(/\.(m?js)$/, '')
      const found = [base, `${stem}.ts`, `${stem}.tsx`, `${base}.mjs`, path.join(base, 'index.ts')]
        .filter((c) => /\.(ts|tsx|mjs|js|json)$/.test(c))
        .map((c) => [c, seen.has(c) ? seen.get(c) : read(c)] as const)
        .find(([, text]) => text !== undefined)
      if (!found) throw new Error(`Cannot find ${spec}, imported by ${path.relative(root, file)}.`)
      if (seen.has(found[0])) continue
      seen.set(found[0], found[1] as string)
      queue.push(found[0])
    }
  }
  const hash = createHash('sha256')
  for (const file of [...seen.keys()].sort((a, b) => rel(root, a).localeCompare(rel(root, b)))) {
    hash.update(`${rel(root, file)}\0${(seen.get(file) as string).replace(/\r\n/g, '\n')}\0`)
  }
  return hash.digest('hex')
}

const rel = (root: string, file: string) => path.relative(root, file).split(path.sep).join('/')

/** Why a save name cannot be used, or null: letters, digits, dots, dashes and underscores, as a file name. */
export function saveNameProblem(name: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || name.includes('..')) {
    return `A save's name is 1 to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit (got "${name}").`
  }
  return null
}

/** The workspace as the app's backup JSON (Settings > Data > Import reads it). */
export function workspaceJson(db: unknown): string {
  return `${JSON.stringify(db, null, 2)}\n`
}

/** One line per scenario for `list`. */
export function scenarioLines(): string[] {
  const width = Math.max(...SCENARIO_NAMES.map((n) => n.length))
  return SCENARIO_NAMES.map((n) => {
    const s = SCENARIOS[n]
    return `  ${n.padEnd(width)}  ${s.description}${s.target === 'server' ? ' (run only: too big for reset)' : ''}`
  })
}
