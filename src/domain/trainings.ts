// Training tracker: which courses each person needs, when they are due, and whether they are done.
// Harassment prevention (Gov. Code 12950.1): CA-based staff once the company has 5+ employees and
// contractors; 1 hour for staff, 2 hours for supervisors; within 6 months of hire, of becoming a
// supervisor, or of the company reaching 5 (whichever is latest); then every 2 years after completion.
// Security awareness: within 30 days of start, then yearly (required when SOC 2 is on).
// Workplace violence prevention (SB 553): when the plan applies, at the start and then yearly.
// Completions come from db.trainings (completedOn). Pure: the date is always a parameter.
import { ruleApplies } from '@/domain/compliance/engine'
import { changePoints, rawCount, supervisorSince } from '@/domain/compliance/counting'
import { RULE_BY_ID } from '@/domain/compliance/rules'
import { isPeopleManager } from '@/domain/people'
import type { DB, Person, Training, TrainingKind } from '@/domain/types'
import { addDays, addMonths, daysBetween, fmtDate, type ISODate } from '@/lib/dates'

export type TrainingStatus = 'done' | 'due' | 'overdue' | 'upcoming' | 'not_required'

/** A course column in the tracker; harassment covers both the 1-hour and the 2-hour kinds. */
export type TrainingCourse = 'harassment' | 'security_awareness' | 'wvpp'

export type TrainingRow = {
  kind: TrainingKind
  course: TrainingCourse
  title: string
  hours?: number
  required: boolean
  /** Not required, but a good idea (harassment training outside CA or below 5, security training without SOC 2). */
  recommended: boolean
  reason: string
  /**
   * The date the current requirement is due: the first deadline before any completion, then the refresher
   * date (completion + 2 years or 1 year). Undefined when there is nothing to schedule yet.
   */
  dueOn?: ISODate
  status: TrainingStatus
  completedOn?: ISODate
  /** Refresher date after the last completion (equals dueOn once completed). */
  nextDueOn?: ISODate
  certificateLink?: string
  link?: string
}

/** Rows turn from upcoming (or done) to due this many days before the due date. */
export const DUE_SOON_DAYS = 30

export const HARASSMENT_THRESHOLD = 5

export const TRAINING_LABELS: Record<TrainingKind, string> = {
  harassment_employee: 'Harassment prevention (1 hour)',
  harassment_supervisor: 'Harassment prevention for supervisors (2 hours)',
  security_awareness: 'Security awareness',
  wvpp: 'Workplace violence prevention',
}

export const COURSE_LABELS: Record<TrainingCourse, string> = {
  harassment: 'Harassment prevention',
  security_awareness: 'Security awareness',
  wvpp: 'Workplace violence prevention',
}

export const CRD_COURSE_URL = 'https://calcivilrights.ca.gov/shpt/'

/** First date employees plus active contractors reached 5 (all known dates, including scheduled starts). */
export function harassmentThresholdReachedOn(db: DB): ISODate | undefined {
  for (const d of changePoints(db)) if (rawCount(db, 'w2_plus_contractors', d) >= HARASSMENT_THRESHOLD) return d
  return undefined
}

function lastCompletion(db: DB, personId: string, kinds: TrainingKind[], date: ISODate): Training | undefined {
  return db.trainings
    .filter((t) => t.personId === personId && kinds.includes(t.kind) && t.completedOn && t.completedOn <= date)
    .sort((a, b) => (b.completedOn as string).localeCompare(a.completedOn as string))[0]
}

const maxDate = (...ds: Array<ISODate | undefined>): ISODate => ds.filter((d): d is ISODate => !!d).sort().pop() as ISODate

/** Status for a requirement with a first deadline and a refresher period after each completion. */
function cycle(
  date: ISODate,
  initialDue: ISODate | undefined,
  last: Training | undefined,
  periodMonths: number,
): Pick<TrainingRow, 'status' | 'dueOn' | 'nextDueOn' | 'completedOn' | 'certificateLink'> {
  if (last?.completedOn) {
    const next = addMonths(last.completedOn, periodMonths)
    const status: TrainingStatus = date > next ? 'overdue' : daysBetween(date, next) <= DUE_SOON_DAYS ? 'due' : 'done'
    return { status, dueOn: next, nextDueOn: next, completedOn: last.completedOn, certificateLink: last.certificateLink }
  }
  if (!initialDue) return { status: 'due' }
  const status: TrainingStatus = date > initialDue ? 'overdue' : daysBetween(date, initialDue) <= DUE_SOON_DAYS ? 'due' : 'upcoming'
  return { status, dueOn: initialDue }
}

/** For a course that is not required: done if a valid completion exists, otherwise not_required. */
function optional(
  date: ISODate,
  recommendedDue: ISODate | undefined,
  last: Training | undefined,
  periodMonths: number,
): Pick<TrainingRow, 'status' | 'dueOn' | 'nextDueOn' | 'completedOn' | 'certificateLink'> {
  if (last?.completedOn) {
    const next = addMonths(last.completedOn, periodMonths)
    return { status: date <= next ? 'done' : 'not_required', dueOn: next, nextDueOn: next, completedOn: last.completedOn, certificateLink: last.certificateLink }
  }
  return { status: 'not_required', dueOn: recommendedDue }
}

function harassmentRow(db: DB, person: Person, date: ISODate): TrainingRow {
  const isSup = isPeopleManager(db, person.id, date)
  const supSince = isSup ? supervisorSince(db, person.id) : undefined
  const kind: TrainingKind = isSup ? 'harassment_supervisor' : 'harassment_employee'
  const hours = isSup ? 2 : 1
  const kinds: TrainingKind[] = isSup ? ['harassment_supervisor'] : ['harassment_employee', 'harassment_supervisor']
  const last = lastCompletion(db, person.id, kinds, date)

  const computedReach = harassmentThresholdReachedOn(db)
  const override = db.complianceStatus['harassment-training']?.countOverride
  let reachedOn: ISODate | undefined
  if (override) reachedOn = override.value >= HARASSMENT_THRESHOLD ? (computedReach && computedReach <= date ? computedReach : person.startDate) : undefined
  else reachedOn = computedReach

  const base = { kind, course: 'harassment' as const, title: TRAINING_LABELS[kind], hours, link: CRD_COURSE_URL }
  const own = maxDate(person.startDate, supSince)
  // Short-term hires (interns, hired for under 6 months) train within 30 days or 100 hours worked,
  // whichever comes first (Gov Code 12950.1, LAW.md a-shpt-5), the same date as their onboarding task.
  const shortTerm = person.employmentType === 'intern'
  const due = shortTerm ? addDays(maxDate(person.startDate, reachedOn), 30) : addMonths(maxDate(own, reachedOn), 6)

  if (person.homeState !== 'CA') {
    return {
      ...base,
      required: false,
      recommended: true,
      reason: `Works outside California (${person.homeState}), so this training is not required. Recommended.`,
      ...optional(date, addMonths(own, 6), last, 24),
    }
  }
  if (!reachedOn) {
    const count = rawCount(db, 'w2_plus_contractors', date)
    return {
      ...base,
      required: false,
      recommended: true,
      reason: `Required once the company has 5 or more employees and contractors (${count} now). Recommended now.`,
      ...optional(date, addMonths(own, 6), last, 24),
    }
  }
  const lead = shortTerm
    ? 'Short-term hire in California: 1 hour within 30 days or 100 hours worked, whichever comes first.'
    : isSup
      ? 'Supervisor in California: 2 hours within 6 months of becoming a supervisor, then every 2 years.'
      : 'Based in California: 1 hour within 6 months of hire, then every 2 years.'
  let reason = lead
  if (reachedOn > date) reason = `${lead} Required from ${fmtDate(reachedOn)}, when the company reaches 5 employees and contractors.`
  else if (reachedOn > own) reason = `${lead} Due ${shortTerm ? '30 days' : '6 months'} after the company reached 5 on ${fmtDate(reachedOn)}.`
  return { ...base, required: true, recommended: false, reason, ...cycle(date, due, last, 24) }
}

function securityRow(db: DB, person: Person, date: ISODate): TrainingRow {
  const last = lastCompletion(db, person.id, ['security_awareness'], date)
  const due = addDays(person.startDate, 30)
  const base = { kind: 'security_awareness' as const, course: 'security_awareness' as const, title: TRAINING_LABELS.security_awareness, link: db.company.linkOuts.training }
  if (!db.company.soc2Enabled) {
    return {
      ...base,
      required: false,
      recommended: true,
      reason: 'Recommended within 30 days of start, then yearly. Required once SOC 2 evidence is turned on.',
      ...optional(date, due, last, 12),
    }
  }
  return {
    ...base,
    required: true,
    recommended: false,
    reason: 'SOC 2 control (company policy, not a legal requirement): within 30 days of start, then every year.',
    ...cycle(date, due, last, 12),
  }
}

function wvppRow(db: DB, person: Person, date: ISODate): TrainingRow {
  const last = lastCompletion(db, person.id, ['wvpp'], date)
  const base = { kind: 'wvpp' as const, course: 'wvpp' as const, title: TRAINING_LABELS.wvpp }
  const rule = RULE_BY_ID.wvpp
  if (!ruleApplies(db, rule, date)) {
    return {
      ...base,
      required: false,
      recommended: false,
      reason: 'Required only when the SB 553 plan applies (10 or more people on site at once, or a workplace open to the public).',
      ...optional(date, undefined, last, 12),
    }
  }
  if (person.workMode === 'remote') {
    return {
      ...base,
      required: false,
      recommended: false,
      reason: 'Works remotely from a place they choose, which SB 553 does not cover.',
      ...optional(date, undefined, last, 12),
    }
  }
  const status = db.complianceStatus[rule.id]
  const planOn = status?.actionsDone?.['write-plan'] ?? status?.doneOn
  if (!planOn) {
    return {
      ...base,
      required: true,
      recommended: false,
      reason: 'SB 553 applies: train everyone when the plan is first established, then every year.',
      ...cycle(date, undefined, last, 12),
    }
  }
  return {
    ...base,
    required: true,
    recommended: false,
    reason:
      'SB 553 applies: train when the plan is first established (and new staff when they start), then every year. The 30-day date is a company target, not a statutory deadline; the yearly refresher is required.',
    ...cycle(date, addDays(maxDate(planOn, person.startDate), 30), last, 12),
  }
}

/** True for a row whose due date is a legal deadline: harassment training, and WVPP only for the yearly refresher (LAW.md a-wvpp-1 sets no initial day count). */
export function isStatutoryTraining(row: Pick<TrainingRow, 'course' | 'completedOn'>): boolean {
  if (row.course === 'security_awareness') return false
  if (row.course === 'wvpp') return !!row.completedOn
  return true
}

/** People employed on the date (not yet left) with a required row for the course that is not done yet. */
export function openTrainingRows(db: DB, date: ISODate, course: TrainingCourse): Array<{ person: Person; row: TrainingRow }> {
  const out: Array<{ person: Person; row: TrainingRow }> = []
  for (const person of db.people) {
    if (person.startDate > date || (person.endDate && person.endDate < date)) continue
    const row = trainingRequirements(db, person, date).find((r) => r.course === course)
    if (row && row.required && row.status !== 'done' && !(row.status === 'due' && row.completedOn)) out.push({ person, row })
  }
  return out
}

/** The last day worked, recorded or scheduled. */
function lastDayOf(person: Person): ISODate | undefined {
  return person.separation?.lastDay ?? person.endDate ?? undefined
}

/** A row that is not owed: a completion that is still valid shows as done, the rest as not required. */
function notOwed(r: TrainingRow, date: ISODate, reason: string): TrainingRow {
  const valid = !!r.completedOn && !!r.nextDueOn && date <= r.nextDueOn
  return { ...r, required: false, recommended: false, reason, status: valid ? 'done' : 'not_required', dueOn: valid ? r.dueOn : undefined }
}

/**
 * One row per course for a person on the date: harassment (1 or 2 hours), security awareness, WVPP.
 * After the last day nothing is required. Before a scheduled last day, a course that falls due after it
 * is not required either (the person leaves first), the way startOffboarding drops pending trainings
 * due after the last day.
 */
export function trainingRequirements(db: DB, person: Person, date: ISODate): TrainingRow[] {
  const rows = [harassmentRow(db, person, date), securityRow(db, person, date), wvppRow(db, person, date)]
  const last = lastDayOf(person)
  if (!last) return rows
  if (last < date) return rows.map((r) => notOwed(r, date, `Left on ${fmtDate(last)}; no longer required.`))
  return rows.map((r) => (r.required && r.dueOn && r.dueOn > last ? notOwed(r, date, `Leaves ${fmtDate(last)}, before it is due; not required.`) : r))
}

export type TrainingMatrix = {
  courses: Array<{ course: TrainingCourse; label: string }>
  rows: Array<{ person: Person; cells: Record<TrainingCourse, TrainingRow> }>
  counts: { overdue: number; due: number; done: number }
}

/** People (current and starting soon, in hire order) by course. Former employees are left out. */
export function trainingMatrix(db: DB, date: ISODate): TrainingMatrix {
  const people = db.people
    .filter((p) => !(p.endDate && p.endDate < date))
    .sort((a, b) => a.hireNumber - b.hireNumber || a.startDate.localeCompare(b.startDate))
  const counts = { overdue: 0, due: 0, done: 0 }
  const rows = people.map((person) => {
    const list = trainingRequirements(db, person, date)
    const cells = Object.fromEntries(list.map((r) => [r.course, r])) as Record<TrainingCourse, TrainingRow>
    for (const r of list) {
      if (r.status === 'overdue' && r.required) counts.overdue += 1
      else if (r.status === 'due' && r.required) counts.due += 1
      else if (r.status === 'done') counts.done += 1
    }
    return { person, cells }
  })
  return {
    courses: (Object.keys(COURSE_LABELS) as TrainingCourse[]).map((course) => ({ course, label: COURSE_LABELS[course] })),
    rows,
    counts,
  }
}
