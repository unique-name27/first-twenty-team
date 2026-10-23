// Turns a checklist template into a person's checklist: decides which tasks apply (headcount,
// supervisor, FLSA, remote, state, equity, separation type, leave kind) and computes due dates.
// Business days skip weekends and company holidays. Statutory deadlines keep their real date, and
// agency filings among them (DE 34, other states' new hire reports, 83(b)) get a weekend-aware
// "file by" label; other computed dates that land on a weekend or holiday move to the next business
// day. Pure and deterministic: the date is always passed in.
import { format } from 'date-fns'
import { DEFAULT_CHECKLIST_TEMPLATES, TASK_IDS } from '@/domain/checklists/templates'
import { daysAway, headcountOn, isPeopleManager } from '@/domain/people'
import type {
  Checklist,
  ChecklistKind,
  ChecklistTask,
  DB,
  DueRule,
  EmploymentType,
  FLSA,
  ID,
  LeaveCase,
  OwnerRole,
  Person,
  SeparationType,
  TaskCondition,
  TemplateTask,
} from '@/domain/types'
import { addBusinessDays, addDays, addMonths, federalHolidaysAround, type ISODate, isWeekday, parseDate } from '@/lib/dates'
import { newId } from '@/lib/id'

/** Facts about a person and the company that decide which template tasks apply. */
export type TaskContext = {
  /** W-2 headcount on the anchor date (contractors never count). */
  headcount: number
  /** W-2 headcount plus active contractors (harassment training threshold, Gov Code 12950.1). */
  workforce: number
  supervisor: boolean
  flsa: FLSA
  remote: boolean
  outsideCA: boolean
  hasEquity: boolean
  earlyExercise: boolean
  separationType?: SeparationType
  employmentType: EmploymentType
  backgroundCheck: boolean
  leaveKind?: LeaveCase['kind']
}

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

export function holidayDates(db: Pick<DB, 'holidays'>): ISODate[] {
  return db.holidays.map((h) => h.date)
}

export function isBusinessDay(d: ISODate, holidays: ISODate[] = []): boolean {
  return isWeekday(d) && !holidays.includes(d)
}

/** The date itself when it is a business day, else the next business day. */
export function onOrAfterBusinessDay(d: ISODate, holidays: ISODate[] = []): ISODate {
  let cur = d
  while (!isBusinessDay(cur, holidays)) cur = addDays(cur, 1)
  return cur
}

/** The date itself when it is a business day, else the previous business day. */
export function onOrBeforeBusinessDay(d: ISODate, holidays: ISODate[] = []): ISODate {
  let cur = d
  while (!isBusinessDay(cur, holidays)) cur = addDays(cur, -1)
  return cur
}

/** Raw due date for a rule: calendar days, business days (weekends and holidays skipped) or months. */
export function dueDate(rule: DueRule, anchorDate: ISODate, holidays: ISODate[] = []): ISODate {
  if (rule.unit === 'business_days') return addBusinessDays(anchorDate, rule.offset, holidays)
  if (rule.unit === 'months') return addMonths(anchorDate, rule.offset)
  return addDays(anchorDate, rule.offset)
}

/**
 * Due date for a template task. Statutory deadlines keep their legal date (see fileBy). Other tasks
 * whose computed date lands on a weekend or holiday move to the next business day (a 90-day
 * check-in on a Sunday happens Monday). Offset 0 is the anchor itself and never moves.
 * A statutory deadline counted in business days (I-9 section 2) skips weekends and federal holidays
 * only: company days off such as the day after Thanksgiving never make a legal deadline later.
 */
export function taskDueOn(task: Pick<TemplateTask, 'due' | 'statutory'>, anchorDate: ISODate, holidays: ISODate[] = []): ISODate {
  const counted = task.statutory && task.due.unit === 'business_days' ? federalHolidaysAround(anchorDate) : holidays
  const d = dueDate(task.due, anchorDate, counted)
  if (task.statutory || task.due.offset === 0) return d
  return onOrAfterBusinessDay(d, holidays)
}

/** When a deadline falls on a weekend or holiday, the business day before it; otherwise null. */
export function fileBy(dueOn: ISODate, holidays: ISODate[] = []): ISODate | null {
  if (isBusinessDay(dueOn, holidays)) return null
  return onOrBeforeBusinessDay(addDays(dueOn, -1), holidays)
}

/**
 * The "file by" day for a checklist task: only an agency filing (TASK_IDS.agencyFilings: the DE 34,
 * another state's new hire report, an 83(b) election) due on a weekend or holiday gets one, the business
 * day before it. Final pay, notices handed over and last-day tasks happen on their date, so they never
 * get an earlier day; nor does a filing whose day before would come ahead of the checklist itself (its
 * creation or its anchor, such as a termination recorded that day).
 */
export function taskFileBy(
  task: Pick<ChecklistTask, 'templateTaskId' | 'dueOn'>,
  checklist: Pick<Checklist, 'createdOn' | 'anchorDate'>,
  holidays: ISODate[] = [],
): ISODate | null {
  if (!(TASK_IDS.agencyFilings as readonly string[]).includes(task.templateTaskId ?? '')) return null
  const by = fileBy(task.dueOn, holidays)
  if (!by || by < checklist.createdOn || by < checklist.anchorDate) return null
  return by
}

function shortDay(d: ISODate): string {
  return format(parseDate(d), 'EEE MMM d')
}

/**
 * "due Mon Oct 26" or, on a weekend or holiday, "due Sun Nov 15, file by Fri Nov 13". A checklist task
 * passes its own `by` (taskFileBy), which is null for tasks that happen on their date.
 */
export function dueLabel(dueOn: ISODate, holidays: ISODate[] = [], by: ISODate | null = fileBy(dueOn, holidays)): string {
  return by ? `due ${shortDay(dueOn)}, file by ${shortDay(by)}` : `due ${shortDay(dueOn)}`
}

function anchorLabel(anchor: DueRule['anchor'], kind?: ChecklistKind): string {
  switch (anchor) {
    case 'start':
      return 'start'
    case 'last_day':
      return 'last day'
    case 'offer_accepted':
      return 'acceptance'
    case 'leave_start':
      return 'leave start'
    case 'created':
      // Leave checklists count from the request; change checklists from the day the change was recorded.
      return kind === 'change' ? 'recording' : 'request'
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** 'Start + 3 business days', '20 days after start', '6 months after start', 'Last day'. Pass the checklist kind to name the 'created' anchor. */
export function dueRuleText(rule: DueRule, kind?: ChecklistKind): string {
  const a = anchorLabel(rule.anchor, kind)
  if (rule.offset === 0) return capitalize(a)
  const n = Math.abs(rule.offset)
  if (rule.unit === 'business_days') {
    const unit = n === 1 ? 'business day' : 'business days'
    return rule.offset > 0 ? `${capitalize(a)} + ${n} ${unit}` : `${n} ${unit} before ${a}`
  }
  const unit = rule.unit === 'months' ? (n === 1 ? 'month' : 'months') : n === 1 ? 'day' : 'days'
  return rule.offset > 0 ? `${n} ${unit} after ${a}` : `${n} ${unit} before ${a}`
}

// ---------------------------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------------------------

/** True when every condition that is set matches the context. No condition = always applies. */
export function taskApplies(cond: TaskCondition | undefined, ctx: TaskContext): boolean {
  if (!cond) return true
  if (cond.minHeadcount != null && ctx.headcount < cond.minHeadcount) return false
  if (cond.belowHeadcount != null && ctx.headcount >= cond.belowHeadcount) return false
  if (cond.minWorkforce != null && ctx.workforce < cond.minWorkforce) return false
  if (cond.supervisor != null && ctx.supervisor !== cond.supervisor) return false
  if (cond.flsa != null && ctx.flsa !== cond.flsa) return false
  if (cond.remote != null && ctx.remote !== cond.remote) return false
  if (cond.outsideCA != null && ctx.outsideCA !== cond.outsideCA) return false
  if (cond.hasEquity != null && ctx.hasEquity !== cond.hasEquity) return false
  if (cond.earlyExercise != null && ctx.earlyExercise !== cond.earlyExercise) return false
  if (cond.backgroundCheck != null && ctx.backgroundCheck !== cond.backgroundCheck) return false
  if (cond.employmentType != null && ctx.employmentType !== cond.employmentType) return false
  if (cond.employmentTypes && !cond.employmentTypes.includes(ctx.employmentType)) return false
  if (cond.separationTypes && (!ctx.separationType || !cond.separationTypes.includes(ctx.separationType))) return false
  if (cond.leaveKinds && (!ctx.leaveKind || !cond.leaveKinds.includes(ctx.leaveKind))) return false
  return true
}

/** Active contractors (not advisors) on a date. */
export function contractorsOn(db: Pick<DB, 'contractors'>, date: ISODate): number {
  return db.contractors.filter((k) => k.kind === 'contractor' && k.startOn <= date && (!k.endOn || k.endOn >= date)).length
}

/** Does the person's job need a background check (their own status, the job flag or the offer contingency)? */
export function requiresBackgroundCheck(db: DB, person: Person): boolean {
  if (person.backgroundCheck) return person.backgroundCheck.status !== 'not_required'
  const app = person.fromApplicationId ? db.applications.find((a) => a.id === person.fromApplicationId) : undefined
  const job = app ? db.jobs.find((j) => j.id === app.jobId) : undefined
  if (job?.backgroundCheck) return true
  const offer = db.offers.find(
    (o) => o.personId === person.id || (!!person.fromApplicationId && o.applicationId === person.fromApplicationId && o.status === 'accepted'),
  )
  return !!offer?.contingencies.includes('background_check')
}

/** Builds the condition context for a person on the anchor date. `extra` overrides any field. */
export function contextFor(db: DB, person: Person, anchorDate: ISODate, extra?: Partial<TaskContext>): TaskContext {
  const headcount = headcountOn(db, anchorDate)
  const grants = db.grants.filter((g) => g.personId === person.id && g.status !== 'cancelled')
  const base: TaskContext = {
    headcount,
    workforce: headcount + contractorsOn(db, anchorDate),
    supervisor: isPeopleManager(db, person.id, anchorDate),
    flsa: person.flsa,
    remote: person.workMode === 'remote',
    outsideCA: (person.homeState || 'CA').toUpperCase() !== 'CA',
    hasEquity: grants.length > 0,
    earlyExercise: grants.some((g) => !!g.earlyExercise),
    separationType: person.separation?.type,
    employmentType: person.employmentType,
    backgroundCheck: requiresBackgroundCheck(db, person),
  }
  return { ...base, ...stripUndefined(extra ?? {}) }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v
  return out
}

// ---------------------------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------------------------

/** Per-task adjustments the lifecycle flows apply at generation (computed deadlines, notes, prefilled status). */
export type TaskOverride = Partial<
  Pick<ChecklistTask, 'dueOn' | 'dueRuleText' | 'title' | 'why' | 'note' | 'status' | 'doneOn' | 'doneById' | 'assigneeId' | 'statutory'>
>

export type GenerateChecklistInput = {
  person: Person
  templateId: ID
  /** The template's main anchor: start date (onboarding, new state), last day (offboarding), leave start, or the change date. */
  anchorDate: ISODate
  createdOn: ISODate
  separationType?: SeparationType
  extra?: Partial<TaskContext>
  /** Keyed by template task id. */
  overrides?: Record<ID, TaskOverride>
  /** Dates for anchors other than the main one, e.g. { created: requestedOn } for a leave. */
  anchors?: Partial<Record<DueRule['anchor'], ISODate>>
  /** Stable checklist id (seed data); a new id otherwise. Task ids derive from it. */
  id?: ID
}

function resolveAnchor(anchor: DueRule['anchor'], kind: ChecklistKind, db: DB, input: GenerateChecklistInput): ISODate {
  const given = input.anchors?.[anchor]
  if (given) return given
  const { person, anchorDate, createdOn } = input
  switch (anchor) {
    case 'start':
      return kind === 'onboarding' || kind === 'new_state' ? anchorDate : person.startDate
    case 'last_day':
      return kind === 'offboarding' ? anchorDate : (person.endDate ?? person.separation?.lastDay ?? anchorDate)
    case 'leave_start':
      return anchorDate
    case 'created':
      return createdOn
    case 'offer_accepted': {
      const offer = db.offers.find((o) => o.personId === person.id && o.status === 'accepted')
      return offer?.decidedOn ?? createdOn
    }
  }
}

function assigneeFor(role: OwnerRole, person: Person): ID | null {
  if (role === 'employee') return person.id
  if (role === 'manager') return person.managerId ?? null
  return null
}

/** The earliest 83(b) deadline recorded on the person's early-exercised grants, if any. */
export function election83bDueOn(db: Pick<DB, 'grants'>, personId: ID): ISODate | undefined {
  return db.grants
    .filter((g) => g.personId === personId && g.status !== 'cancelled' && g.earlyExercise && g.election83bDueOn)
    .map((g) => g.election83bDueOn as ISODate)
    .sort()[0]
}

/**
 * Days a rehire was away from the company (between the earlier stint's last day and this start), or
 * undefined when the person is not linked to an earlier record (rehireOfPersonId). Only the explicit
 * link counts: a same-name match must never skip a legal filing.
 */
export function rehireDaysAway(db: Pick<DB, 'people'>, person: Pick<Person, 'rehireOfPersonId' | 'startDate'>): number | undefined {
  const prior = person.rehireOfPersonId ? db.people.find((p) => p.id === person.rehireOfPersonId) : undefined
  return prior?.endDate ? daysAway(prior.endDate, person.startDate) : undefined
}

/**
 * Overrides known from the data itself. The 83(b) deadline runs from the exercise date, so until an
 * exercise is recorded the task is a reminder with no legal date (not statutory, never red). A rehire
 * back within 60 days needs no DE 34: EDD counts a rehire only after a separation of at least 60
 * consecutive days (docs/LAW.md a-de34-1).
 */
function derivedOverrides(db: DB, person: Person): Record<ID, TaskOverride> {
  const out: Record<ID, TaskOverride> = {}
  const due83b = election83bDueOn(db, person.id)
  out[TASK_IDS.election83b] = due83b
    ? { dueOn: due83b, dueRuleText: '30 days after early exercise', statutory: true }
    : { dueRuleText: 'Within 30 days of an early exercise', statutory: false }
  const away = rehireDaysAway(db, person)
  if (away != null && away < 60) {
    out[TASK_IDS.de34] = {
      status: 'not_applicable',
      note: `Not required: back after ${away} ${away === 1 ? 'day' : 'days'} away. EDD's new hire report covers a rehire only after a separation of at least 60 consecutive days.`,
    }
  }
  return out
}

export function findTemplate(db: Pick<DB, 'checklistTemplates'>, templateId: ID) {
  return db.checklistTemplates.find((t) => t.id === templateId) ?? DEFAULT_CHECKLIST_TEMPLATES.find((t) => t.id === templateId)
}

/** Builds a checklist (not yet stored) with every applicable task open and its due date computed. */
export function generateChecklist(db: DB, input: GenerateChecklistInput): Checklist {
  const template = findTemplate(db, input.templateId)
  if (!template) throw new Error(`No checklist template with id ${input.templateId}`)
  const holidays = holidayDates(db)
  const ctx = contextFor(db, input.person, input.anchorDate, { ...input.extra, separationType: input.separationType ?? input.extra?.separationType })
  const id = input.id ?? newId('ck')
  const suffix = id.startsWith('ck-') ? id.slice(3) : id
  const derived = derivedOverrides(db, input.person)
  const tasks: ChecklistTask[] = template.tasks
    .filter((t) => taskApplies(t.when, ctx))
    .map((t) => {
      const anchor = resolveAnchor(t.due.anchor, template.kind, db, input)
      const o: TaskOverride = { ...derived[t.id], ...input.overrides?.[t.id] }
      const statutory = o.statutory ?? t.statutory
      let dueOn = o.dueOn ?? taskDueOn({ due: t.due, statutory }, anchor, holidays)
      // A lead-time task can never be due before the checklist existed (a hire recorded 3 days before start).
      if (!o.dueOn && !statutory && t.due.offset < 0 && dueOn < input.createdOn) dueOn = onOrAfterBusinessDay(input.createdOn, holidays)
      const task: ChecklistTask = {
        id: `t-${suffix}-${t.id}`,
        templateTaskId: t.id,
        title: o.title ?? t.title,
        ownerRole: t.ownerRole,
        assigneeId: o.assigneeId !== undefined ? o.assigneeId : assigneeFor(t.ownerRole, input.person),
        dueOn,
        dueRuleText: o.dueRuleText ?? dueRuleText(t.due, template.kind),
        status: o.status ?? 'open',
        category: t.category,
        statutory,
      }
      const why = o.why ?? t.why
      if (why) task.why = why
      if (t.citation) task.citation = { ...t.citation }
      if (t.soc2Control) task.soc2Control = t.soc2Control
      if (t.link) task.link = t.link
      if (o.note) task.note = o.note
      if (task.status === 'done') {
        task.doneOn = o.doneOn ?? input.createdOn
        if (o.doneById) task.doneById = o.doneById
      }
      return task
    })
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn))
  const checklist: Checklist = {
    id,
    personId: input.person.id,
    kind: template.kind,
    templateId: template.id,
    anchorDate: input.anchorDate,
    createdOn: input.createdOn,
    tasks,
  }
  const sep = input.separationType ?? input.extra?.separationType
  if (sep) checklist.separationType = sep
  if (tasks.length > 0 && tasks.every((t) => t.status !== 'open')) checklist.completedOn = input.createdOn
  return checklist
}

// ---------------------------------------------------------------------------------------------
// Progress and inbox
// ---------------------------------------------------------------------------------------------

export type ChecklistProgress = {
  done: number
  /** Tasks that count (not-applicable ones are left out). */
  total: number
  open: number
  overdue: number
  statutoryOverdue: number
  /** The open task due soonest. */
  nextDue?: ChecklistTask
  /** Whole-number percent done, 0 to 100. */
  pct: number
  /** Every task due before the anchor date (pre-start for onboarding) is done. */
  dayOneReady: boolean
}

export function checklistProgress(cl: Checklist, date: ISODate): ChecklistProgress {
  const counted = cl.tasks.filter((t) => t.status !== 'not_applicable')
  const done = counted.filter((t) => t.status === 'done').length
  const open = counted.filter((t) => t.status === 'open')
  const overdueTasks = open.filter((t) => t.dueOn < date)
  const nextDue = [...open].sort((a, b) => a.dueOn.localeCompare(b.dueOn))[0]
  const preStart = counted.filter((t) => t.dueOn < cl.anchorDate)
  return {
    done,
    total: counted.length,
    open: open.length,
    overdue: overdueTasks.length,
    statutoryOverdue: overdueTasks.filter((t) => t.statutory).length,
    nextDue,
    pct: counted.length ? Math.round((done / counted.length) * 100) : 100,
    dayOneReady: preStart.every((t) => t.status === 'done'),
  }
}

export type OpenTask = {
  checklist: Checklist
  task: ChecklistTask
  personId: ID
  overdue: boolean
  /** Business day to file by when an agency filing is due on a weekend or holiday (taskFileBy). */
  fileBy: ISODate | null
}

export type OpenTaskFilter = {
  ownerRole?: OwnerRole
  personId?: ID
  assigneeId?: ID
  /** Only tasks due on or before this date. */
  dueBy?: ISODate
}

/**
 * Is this task moot because the person left before it was due? Offboarding tasks never are, and
 * neither are the obligations that survive an early exit (I-9, new hire report, ACA notice) unless
 * the person never started at all. startOffboarding closes these; this is the safety net for data
 * recorded another way.
 */
export function mootAfterExit(checklist: Pick<Checklist, 'kind'>, task: Pick<ChecklistTask, 'dueOn' | 'templateTaskId'>, person: Pick<Person, 'startDate' | 'endDate'> | undefined): boolean {
  if (!person?.endDate || checklist.kind === 'offboarding') return false
  if (person.endDate < person.startDate) return true
  if (task.dueOn <= person.endDate) return false
  return !(TASK_IDS.survivesExit as readonly string[]).includes(task.templateTaskId ?? '')
}

/** Open tasks across every checklist, soonest first. Tasks made moot by an exit are left out. */
export function openTasks(db: DB, date: ISODate, filter: OpenTaskFilter = {}): OpenTask[] {
  const holidays = holidayDates(db)
  const people = new Map(db.people.map((p) => [p.id, p]))
  const out: OpenTask[] = []
  for (const checklist of db.checklists) {
    if (filter.personId && checklist.personId !== filter.personId) continue
    const person = people.get(checklist.personId)
    for (const task of checklist.tasks) {
      if (task.status !== 'open') continue
      if (mootAfterExit(checklist, task, person)) continue
      if (filter.ownerRole && task.ownerRole !== filter.ownerRole) continue
      if (filter.assigneeId && task.assigneeId !== filter.assigneeId) continue
      if (filter.dueBy && task.dueOn > filter.dueBy) continue
      out.push({ checklist, task, personId: checklist.personId, overdue: task.dueOn < date, fileBy: taskFileBy(task, checklist, holidays) })
    }
  }
  return out.sort((a, b) => a.task.dueOn.localeCompare(b.task.dueOn) || Number(b.task.statutory) - Number(a.task.statutory))
}
