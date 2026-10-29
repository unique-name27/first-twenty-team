// The simulator panel's pure helpers (docs/DEV.md, "The simulator panel"): how a situation reads in the list,
// a new situation's defaults and the editor's checks, the feed's filters, the headcount chart's series, the
// timeline's positions, run files to save and load (a short list in this browser too), and the bug report.
// No React and no Worker here, so each rule is tested on its own (helpers.test.ts).
import type { DB, ID } from '@/domain/types'
import { addDays, addMonths, daysBetween, fmtDayAnyYear, type ISODate } from '@/lib/dates'
import { plural } from '@/lib/format'
import type { MetricPoint } from '@/sim/metrics'
import type { RunStart } from '@/sim/play'
import type { Situation, SituationInput, SituationKind } from '@/sim/situations'
import type { EventArea, SimEvent } from '@/sim/story'
import { MAX_RUN_DAYS, type RunMeta } from './protocol'

/** Every date the panel shows has its year: a run goes years ahead. "Thu, Mar 4, 2027" */
export function fmtSimDay(d: ISODate): string {
  return fmtDayAnyYear(d, '0000-01-01')
}

// ---- Situations ------------------------------------------------------------------------------

/** The kinds the editor adds, in the order its menu lists them (pace entries come from the sliders). */
export const ADDABLE_KINDS: Array<{ kind: Exclude<SituationKind, 'pace'>; label: string }> = [
  { kind: 'hiringPush', label: 'Hiring push' },
  { kind: 'growTo', label: 'Grow to a headcount' },
  { kind: 'freeze', label: 'Hiring freeze' },
  { kind: 'quit', label: 'Someone quits' },
  { kind: 'layoff', label: 'Layoff' },
  { kind: 'leave', label: 'Leave' },
  { kind: 'raiseRound', label: 'Raise round' },
  { kind: 'leaderHire', label: 'Senior hire' },
]

export const KIND_LABELS: Record<SituationKind, string> = {
  ...(Object.fromEntries(ADDABLE_KINDS.map((k) => [k.kind, k.label])) as Record<Exclude<SituationKind, 'pace'>, string>),
  pace: 'Pace',
}

/** Names for ids, from the simulated company's roster and departments. */
export type Names = { person: (id: ID) => string; department: (id: ID) => string }

export function namesFrom(roster: ReadonlyArray<{ id: ID; name: string }>, departments: ReadonlyArray<{ id: ID; name: string }>): Names {
  const people = new Map(roster.map((p) => [p.id, p.name]))
  const depts = new Map(departments.map((d) => [d.id, d.name]))
  return { person: (id) => people.get(id) ?? 'someone who has left', department: (id) => depts.get(id) ?? 'a department that is gone' }
}

const pct = (n: number) => `${Math.round(n * 100)}%`

/** What a pace entry changes: "attrition 30% a year, hiring pace 2x". */
export function paceText(changes: Extract<Situation, { kind: 'pace' }>['changes']): string {
  const parts: string[] = []
  if (changes.hiringPace !== undefined) parts.push(`hiring pace ${changes.hiringPace}x`)
  if (changes.attritionPerYear !== undefined) parts.push(`attrition ${pct(changes.attritionPerYear)} a year`)
  if (changes.timeOff !== undefined) parts.push(`time off ${changes.timeOff}x`)
  if (changes.offerAcceptRate !== undefined) parts.push(`offer acceptance ${pct(changes.offerAcceptRate)}`)
  return parts.length ? parts.join(', ') : 'no change'
}

/** One line for the situation list: "Hiring push: 3 roles in Engineering". */
export function situationSummary(s: Situation, names: Names): string {
  switch (s.kind) {
    case 'hiringPush':
      return `Hiring push: ${plural(s.roles, 'role')}${s.departmentId ? ` in ${names.department(s.departmentId)}` : ''}`
    case 'growTo':
      return `Grow to ${s.headcount} people by ${fmtSimDay(s.by)}${s.departmentId ? `, hiring in ${names.department(s.departmentId)}` : ''}`
    case 'freeze':
      return `Hiring freeze to ${fmtSimDay(s.until)}${s.holdOpenJobs ? ', open jobs on hold' : ''}`
    case 'quit':
      return `${s.personId ? names.person(s.personId) : 'Someone at random'} quits${s.notice === 'none' ? ' with no notice' : ''}${s.backfill ? ', with a backfill' : ', no backfill'}`
    case 'layoff': {
      const who = s.personIds ? `${s.personIds.map(names.person).join(', ')}` : s.departmentId ? `everyone in ${names.department(s.departmentId)}` : `${plural(s.count ?? 1, 'person', 'people')} at random`
      const notice = s.noticeDays ? `, last day ${plural(s.noticeDays, 'day')} later` : ', last day the same day'
      return `Layoff: ${who}${notice}${s.closeJobs ? ', jobs closed' : ''}${s.freezeDays ? `, then a ${s.freezeDays}-day freeze` : ''}`
    }
    case 'leave':
      return `${s.leaveKind === 'bonding' ? 'Bonding leave' : s.leaveKind === 'cfra' ? 'CFRA leave' : 'Leave'} for ${s.personId ? names.person(s.personId) : 'someone at random'}, ${plural(s.weeks, 'week')}`
    case 'raiseRound':
      return `Raise round: ${s.percent}% for everyone${s.includeFounder ? ', founder too' : ''}${s.respectBands ? ', within bands' : ''}`
    case 'leaderHire':
      return `Senior hire: ${s.title ?? (s.levelId === 'lv-x1' ? 'an executive' : 'a Head of')} for ${names.department(s.departmentId)}${s.reports === 'department' ? ', the department moves under them' : `, ${plural(s.reports.length, 'person', 'people')} move under them`}`
    case 'pace':
      return `Pace: ${paceText(s.changes)}`
  }
}

/** An id no situation in the list has: "quit-2". */
export function nextSituationId(kind: SituationKind, list: ReadonlyArray<{ id: string }>): string {
  const taken = new Set(list.map((s) => s.id))
  let n = 1
  while (taken.has(`${kind}-${n}`)) n += 1
  return `${kind}-${n}`
}

/** A new situation of a kind on a day, with the editor's defaults. */
export function newSituation(kind: Exclude<SituationKind, 'pace'>, on: ISODate, list: ReadonlyArray<{ id: string }>, departments: ReadonlyArray<{ id: ID }>): SituationInput {
  const id = nextSituationId(kind, list)
  const dept = departments[0]?.id ?? 'd-eng'
  switch (kind) {
    case 'hiringPush':
      return { id, on, kind, roles: 2 }
    case 'growTo':
      return { id, on, kind, headcount: 20, by: addMonths(on, 6) }
    case 'freeze':
      return { id, on, kind, until: addMonths(on, 2), holdOpenJobs: false }
    case 'quit':
      return { id, on, kind, personId: null, notice: 'two_weeks', backfill: true }
    case 'layoff':
      return { id, on, kind, count: 2, noticeDays: 0, closeJobs: false, freezeDays: 0 }
    case 'leave':
      return { id, on, kind, personId: null, leaveKind: 'bonding', weeks: 8 }
    case 'raiseRound':
      return { id, on, kind, percent: 3, includeFounder: false, respectBands: true, effective: 'next_pay_period' }
    case 'leaderHire':
      return { id, on, kind, departmentId: dept, levelId: 'lv-m2', reports: 'department' }
  }
}

/**
 * What the editor says is wrong with a situation before the worker sees it: the field and a message. The
 * worker checks the rest (the schema), and the app refuses what does not fit the company as a note.
 */
export function situationProblems(s: SituationInput, from: ISODate, until: ISODate): Record<string, string> {
  const out: Record<string, string> = {}
  if (!(s.on > from)) out.on = `Pick a day after the run starts (${fmtSimDay(from)}).`
  else if (s.on > until) out.on = `Pick a day on or before the run ends (${fmtSimDay(until)}).`
  if (s.kind === 'freeze' && s.until < s.on) out.until = 'The freeze ends before it starts.'
  if (s.kind === 'growTo' && !(s.by > s.on)) out.by = 'Pick a day after the push starts.'
  if (s.kind === 'layoff' && s.personIds && s.personIds.length === 0) out.personIds = 'Pick at least one person.'
  if (s.kind === 'layoff' && s.count !== undefined && !(s.count >= 1)) out.count = 'Lay off at least one person.'
  if (s.kind === 'hiringPush' && !(s.roles >= 1 && s.roles <= 10)) out.roles = 'Enter 1 to 10 roles.'
  if (s.kind === 'raiseRound' && !(s.percent > 0 && s.percent <= 50)) out.percent = 'Enter a raise from 0.1% to 50%.'
  return out
}

/** The windows with no hiring: freezes, and the freeze after a layoff. */
export function freezeWindows(list: readonly Situation[]): Array<{ id: string; from: ISODate; to: ISODate }> {
  const out: Array<{ id: string; from: ISODate; to: ISODate }> = []
  for (const s of list) {
    if (s.kind === 'freeze') out.push({ id: s.id, from: s.on, to: s.until })
    if (s.kind === 'layoff' && s.freezeDays > 0) out.push({ id: s.id, from: s.on, to: addDays(s.on, s.freezeDays) })
  }
  return out
}

// ---- Feed and chart --------------------------------------------------------------------------

export type FeedFilter = 'headlines' | 'hiring' | 'people' | 'pay' | 'all'

export const FEED_FILTERS: Array<{ value: FeedFilter; label: string }> = [
  { value: 'headlines', label: 'Headlines' },
  { value: 'hiring', label: 'Hiring' },
  { value: 'people', label: 'People' },
  { value: 'pay', label: 'Pay' },
  { value: 'all', label: 'Everything' },
]

const FILTER_AREAS: Record<Exclude<FeedFilter, 'headlines' | 'all'>, EventArea[]> = {
  hiring: ['hiring'],
  people: ['people', 'situations'],
  pay: ['pay'],
}

/** The feed's events for a filter, newest first. Headlines are importance 1 (what situations did included). */
export function feedEvents(events: readonly SimEvent[], filter: FeedFilter): SimEvent[] {
  const keep = filter === 'all' ? () => true : filter === 'headlines' ? (e: SimEvent) => e.importance === 1 : (e: SimEvent) => FILTER_AREAS[filter].includes(e.area)
  const out: SimEvent[] = []
  for (let i = events.length - 1; i >= 0; i--) if (keep(events[i])) out.push(events[i])
  return out
}

/**
 * The headcount chart's two series: employees, and employees plus people starting. Each keeps a point only
 * where its value changes (a step chart holds a value until the next point), from the start day on.
 */
export function headcountSeries(start: MetricPoint | null, points: readonly MetricPoint[]): { employees: Array<{ date: ISODate; value: number }>; withStarting: Array<{ date: ISODate; value: number }> } {
  const employees: Array<{ date: ISODate; value: number }> = []
  const withStarting: Array<{ date: ISODate; value: number }> = []
  const all = start ? [start, ...points] : points
  for (const p of all) {
    if (employees.at(-1)?.value !== p.headcount) employees.push({ date: p.date, value: p.headcount })
    const v = p.headcount + p.incoming
    if (withStarting.at(-1)?.value !== v) withStarting.push({ date: p.date, value: v })
  }
  return { employees, withStarting }
}

/** Where a day sits on the timeline from `from` to `until`, from 0 to 1. */
export function timelineAt(day: ISODate, from: ISODate, until: ISODate): number {
  const span = daysBetween(from, until)
  if (span <= 0) return 0
  return Math.min(1, Math.max(0, daysBetween(from, day) / span))
}

/** The last day the run can end on, and the default end: a year from the start. */
export function untilLimits(from: ISODate): { latest: ISODate; byDefault: ISODate } {
  return { latest: addDays(from, MAX_RUN_DAYS), byDefault: addMonths(from, 12) }
}

// ---- Sizes -----------------------------------------------------------------------------------

/** About what a browser keeps for one site, in characters (localStorage counts characters). */
export const BROWSER_LIMIT = 5_000_000
/** Keep refuses a company bigger than this: the browser must also hold its preferences and sync state. */
export const KEEP_LIMIT = 4_000_000

/** "2.4 MB" (a workspace's JSON in characters, close to bytes for this data). */
export function fmtSize(chars: number): string {
  if (chars < 1_000_000) return `${Math.max(1, Math.round(chars / 1000))} KB`
  return `${(chars / 1_000_000).toFixed(1)} MB`
}

// ---- Run files -------------------------------------------------------------------------------

/** A run file the worker reads (the schema check happens there), from the start and the run so far. */
export function runFile(start: RunStart, run: RunMeta, situations: readonly Situation[]): Record<string, unknown> {
  return { version: 1, start, seed: run.seed, pace: run.pace, situations: [...situations], until: run.until }
}

/** A run file to share: a start from this company never carries the company (the repo is public). */
export function shareableRunFile(start: RunStart, run: RunMeta, situations: readonly Situation[]): Record<string, unknown> {
  const safe = start.kind === 'workspace' ? { kind: 'workspace', date: start.date, db: 'this company, not included' } : start
  return { ...runFile(start, run, situations), start: safe }
}

/** "sim-run-full-20-2027-03-04.json", "sim-company-tidebeam-2027-03-04.json" */
export function simFileName(kind: 'run' | 'company', name: string, date: ISODate): string {
  const stem =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'simulation'
  return `sim-${kind}-${stem}-${date}.json`
}

/** A run file from pasted or loaded text, or why it is not one (the worker then checks what is in it). */
export function readRunText(text: string): { ok: true; run: unknown } | { ok: false; message: string } {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, message: 'Paste a run file first.' }
  try {
    const run = JSON.parse(trimmed) as unknown
    if (!run || typeof run !== 'object' || Array.isArray(run)) return { ok: false, message: 'A run file is a JSON object with version, start and until.' }
    if (typeof (run as { start?: { db?: unknown } }).start?.db === 'string') {
      return { ok: false, message: 'This run file comes from a bug report: it starts from a company it does not include. Pick that company and start again.' }
    }
    return { ok: true, run }
  } catch {
    return { ok: false, message: 'That is not JSON: copy the whole run file, from the first { to the last }.' }
  }
}

/** The text of a bug report: where it stopped, what it was doing, and a run file anyone can play again. */
export function bugReport(o: {
  start: RunStart
  run: RunMeta
  situations: readonly Situation[]
  label: string
  date: ISODate | null
  error: { message: string; day: ISODate | null; traceTail: string[] } | null
}): string {
  const lines = [`Simulator run: ${o.start.kind === 'workspace' ? 'start: this company, not included' : o.label}`, `On: ${o.date ?? 'not started'}`]
  if (o.error) lines.push(`Stopped${o.error.day ? ` on ${o.error.day}` : ''}: ${o.error.message}`, '', 'Last actions:', ...o.error.traceTail.map((t) => `  ${t}`))
  lines.push('', 'Run file (npm run sim -- play run.json):', JSON.stringify(shareableRunFile(o.start, o.run, o.situations), null, 2))
  return lines.join('\n')
}

// ---- Runs kept in this browser ---------------------------------------------------------------

/** The panel's own keys share this prefix (CI looks for it in the build: none may reach it). */
export const STORAGE_PREFIX = 'ft-dev-simulator'
export const SAVED_RUNS_KEY = `${STORAGE_PREFIX}:runs`
/** The list keeps this many runs, newest first. */
export const SAVED_RUNS_MAX = 8
/** A run bigger than this (a start from a big company) is not kept in the list: download it instead. */
export const SAVED_RUN_MAX_CHARS = 400_000

export type SavedRun = { name: string; savedAt: string; run: Record<string, unknown> }

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

export function loadSavedRuns(storage: StorageLike | null): SavedRun[] {
  try {
    const raw = storage?.getItem(SAVED_RUNS_KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as unknown
    return Array.isArray(list) ? list.filter((r): r is SavedRun => !!r && typeof r.name === 'string' && typeof r.savedAt === 'string' && !!r.run && typeof r.run === 'object') : []
  } catch {
    return []
  }
}

/** Keeps a run under a name (replacing one with the same name), or says why it could not. */
export function saveRun(storage: StorageLike | null, name: string, run: Record<string, unknown>, at: string): { ok: true; list: SavedRun[] } | { ok: false; message: string } {
  const clean = name.trim()
  if (!clean) return { ok: false, message: 'Name the run first.' }
  const size = JSON.stringify(run).length
  if (size > SAVED_RUN_MAX_CHARS) return { ok: false, message: `This run carries a company (${fmtSize(size)}), too big for the list in this browser. Download it instead.` }
  const list = [{ name: clean, savedAt: at, run }, ...loadSavedRuns(storage).filter((r) => r.name !== clean)].slice(0, SAVED_RUNS_MAX)
  try {
    if (!storage) throw new Error('no storage')
    storage.setItem(SAVED_RUNS_KEY, JSON.stringify(list))
    return { ok: true, list }
  } catch {
    return { ok: false, message: 'This browser did not keep it (private window or full storage). Download it instead.' }
  }
}

export function removeSavedRun(storage: StorageLike | null, name: string): SavedRun[] {
  const list = loadSavedRuns(storage).filter((r) => r.name !== name)
  try {
    storage?.setItem(SAVED_RUNS_KEY, JSON.stringify(list))
  } catch {
    /* storage blocked: the list stays as it was */
  }
  return list
}

/** This browser's storage, or null where it is blocked. */
export function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** A company kept from a simulation gets a new identity: another company, never merged with one it came from. */
export function withNewIdentity(db: DB, workspaceId: string): DB {
  return { ...db, meta: { ...db.meta, sample: false, workspaceId } as DB['meta'] }
}
