// The compliance engine: evaluates each rule in the catalog against the data for a date.
// States: not_yet, approaching (projected within 60 days from incoming hires, or from outstanding
// offers 'if accepted'), applies, done (marked done or every action done), not_applicable.
// Pure and deterministic: every function takes the date; nothing reads the clock.
import { fileBy as fileByDay, holidayDates, taskFileBy } from '@/domain/checklists/generate'
import { fullName, isEmployedOn } from '@/domain/people'
// trainings imports this module too; both only call each other inside functions, so the cycle is safe.
import { isStatutoryTraining, openTrainingRows } from '@/domain/trainings'
import type { ComplianceStatus, DB, ID, Person } from '@/domain/types'
import { addDays, daysBetween, fmtDate, fmtShort, type ISODate } from '@/lib/dates'
import { listJoin, plural } from '@/lib/format'
import {
  contractors1099,
  countFor,
  estimateTwentyWeeks,
  eventHit,
  eventNotYetText,
  firstDateAtOrAbove,
  firstPaidEmployeeOn,
  hasCaliforniaPresence,
  hasPresenceInCity,
  offerPhantoms,
  paidEmployeesOn,
  projectionDB,
  qualifyingWeeks,
  rawCount,
  weeksAtOrAbove,
} from './counting'
import { annualDoneKey, type ComplianceRule, cycleActionKey, RULE_BY_ID, RULES, type RuleAction } from './rules'

/** A rule is 'approaching' when projected to apply within this many days. */
export const APPROACHING_DAYS = 60

export type RuleState = 'not_yet' | 'approaching' | 'applies' | 'done' | 'not_applicable'

export type RuleResult = {
  rule: ComplianceRule
  state: RuleState
  /**
   * The count used (the admin override when one is set). For 20-week rules this is qualifying weeks, not
   * people, and so is an override on those rules.
   */
  count: number
  /** The computed count before any override. */
  computedCount: number
  overridden: boolean
  howCounted: string
  /** When the rule first applied (threshold first reached, event date, founding for always-on rules). */
  firstAppliedOn?: ISODate
  /** Projected start from people already hired (future start dates and accepted offers). */
  projectedOn?: ISODate
  /** Earlier projected start if outstanding offers (sent or approved) are accepted. Label it 'if accepted'. */
  projectedIfOffersAccepted?: ISODate
  /** Statutory clock (trigger + dueDaysAfterTrigger) or a deadline the user recorded (status.dueOn). */
  dueOn?: ISODate
  /**
   * dueOn comes from an estimated trigger date (EDD DE 1 with no first payroll date in Settings): show it as
   * 'about', never as a legal deadline that came due, and ask for the real date.
   */
  dueEstimated?: boolean
  /**
   * An agency filing (rule.agencyFiling, the DE 1) whose exact deadline lands on a weekend or company holiday:
   * the business day before, to file by. Never set on an estimated date. A date that comes from an overdue
   * follow-up takes that task's own file-by day (taskFileBy: agency filings such as the DE 34 only).
   */
  fileBy?: ISODate
  /** The law takes effect on this later date (rule.effectiveOn, while the evaluation date is before it). */
  effectiveOn?: ISODate
  /** Not required yet, but the same count has reached rule.recommendFrom. */
  recommended: boolean
  /** 20-week federal rules: qualifying weeks and the projected 20th week. */
  weeks?: { n: number; thisYear: number; lastYear: number; estimatedOn?: ISODate; estimatedIfOffersAccepted?: ISODate }
  status?: ComplianceStatus
  /**
   * Action id -> done date: user-recorded, plus some detected from data such as the 25102(o) filing date.
   * Yearly actions (rule.cycle) show the date for the current cycle, or last cycle's while the next one
   * has not reopened yet.
   */
  actionsDone: Record<string, ISODate>
  /**
   * Per-person legal deadlines under this rule that are overdue (a harassment training, a DE 34, an I-9
   * section, an SB 294 or 2810.5 notice). While any exist the rule cannot read Done: its state is
   * 'applies' and dueOn is the earliest overdue date.
   */
  followUps?: RuleFollowUp[]
  /** Actions satisfied by saved data that carries no date (EDD account number, workers' comp carrier): show 'On file'. Their actionsDone value is the evaluation date. */
  onFile: string[]
  openActions: RuleAction[]
  /** Yearly cycle on rules with rule.cycle that apply. */
  cycle?: {
    year: number
    /** This cycle's due date (the next due date on or after the evaluation date). */
    dueOn: ISODate
    /** The day after last cycle's due date. */
    startsOn: ISODate
    /** Every yearly action done for this cycle. */
    doneOn?: ISODate
    /** Every yearly action done for last cycle. */
    lastDoneOn?: ISODate
    /** Last cycle was owed and not done: its yearly actions stay open until done. */
    overdueYear?: number
    /** Yearly actions open now. Outside the reopen window they rest on last cycle's completion. */
    open: boolean
    /**
     * A yearly employee notice with no one to send it to yet (cycle.requires 'paid_employees': only owners
     * with no pay so far): nothing is owed this cycle or last.
     */
    awaitingEmployees?: boolean
  }
  notApplicableReason?: string
}

type TriggerEval = {
  applies: boolean
  count: number
  computedCount: number
  overridden: boolean
  howCounted: string
  firstAppliedOn?: ISODate
  weeks?: { n: number; thisYear: number; lastYear: number }
  /** Site rule: the Settings peak looks out of date (treated as at least approaching). */
  stale?: boolean
  /** Event rule: the event date is an estimate (EventHit.estimated). */
  estimated?: boolean
}

const yearOf = (d: ISODate): number => Number(d.slice(0, 4))

type Detection = ISODate | 'on_file' | undefined

export type RuleFollowUp = {
  personId: ID
  title: string
  dueOn: ISODate
  source: 'training' | 'checklist'
  /** An agency filing task (the DE 34) due on a weekend or holiday: the business day before (taskFileBy). */
  fileBy?: ISODate
}

/** Rules whose per-person duties live on onboarding or change checklists (template task ids). */
const PER_PERSON_TASKS: Record<string, string[]> = {
  'new-hire-reporting': ['on-de34'],
  'form-i9': ['on-i9-section1', 'on-i9-section2'],
  'sb294-new-hire': ['on-notice-sb294'],
  'wage-notice-2810-5': ['on-notice-2810-5', 'ch-wage-notice'],
}

/** True for a rule whose per-person deadlines live on checklist tasks (the DE 34, I-9, SB 294 and 2810.5 tasks). */
export function hasPerPersonTasks(ruleId: string): boolean {
  return ruleId in PER_PERSON_TASKS
}

/**
 * The deadline a rule keeps of its own next to the checklist tasks that carry its per-person deadlines, for a
 * list that shows those tasks too (the Home inbox). A date that only comes from an overdue task (a follow-up)
 * stays on that task's row, and so does a clock (dueDaysAfterTrigger) started by a hire whose checklist has
 * the task. What is left: a deadline recorded on the card, or a clock for a hire with no such task.
 * Rules without per-person tasks keep r.dueOn.
 */
export function ruleDeadlineBesideTasks(db: DB, r: RuleResult): ISODate | undefined {
  const taskIds = PER_PERSON_TASKS[r.rule.id]
  if (!taskIds || !r.dueOn) return r.dueOn
  if (r.status?.dueOn) return r.status.dueOn
  const start = r.firstAppliedOn
  if (r.rule.dueDaysAfterTrigger === undefined || !start) return undefined
  const starters = new Set(db.people.filter((p) => p.startDate === start).map((p) => p.id))
  const onTask = db.checklists.some((c) => starters.has(c.personId) && c.tasks.some((t) => !!t.templateTaskId && taskIds.includes(t.templateTaskId)))
  return onTask ? undefined : addDays(start, r.rule.dueDaysAfterTrigger)
}

/** Overdue per-person legal deadlines under a rule, oldest first (see RuleResult.followUps). */
export function ruleFollowUps(db: DB, rule: ComplianceRule, date: ISODate): RuleFollowUp[] {
  const out: RuleFollowUp[] = []
  const course = rule.id === 'harassment-training' ? 'harassment' : rule.id === 'wvpp' ? 'wvpp' : null
  if (course) {
    for (const { person, row } of openTrainingRows(db, date, course)) {
      if (row.status !== 'overdue' || !row.dueOn || !isStatutoryTraining(row)) continue
      out.push({ personId: person.id, title: `${fullName(person)}: ${row.title.toLowerCase()}`, dueOn: row.dueOn, source: 'training' })
    }
  }
  const taskIds = PER_PERSON_TASKS[rule.id]
  if (taskIds) {
    const holidays = holidayDates(db)
    for (const c of db.checklists) {
      const person = db.people.find((p) => p.id === c.personId)
      if (!person || (person.endDate && person.endDate < date)) continue
      for (const t of c.tasks) {
        if (!t.templateTaskId || !taskIds.includes(t.templateTaskId) || t.status !== 'open' || !t.statutory || t.dueOn >= date) continue
        const by = taskFileBy(t, c, holidays)
        out.push({ personId: person.id, title: `${fullName(person)}: ${t.title}`, dueOn: t.dueOn, source: 'checklist', ...(by ? { fileBy: by } : {}) })
      }
    }
  }
  return out.sort((a, b) => a.dueOn.localeCompare(b.dueOn))
}

/** Action completion that the data already proves: a date, or 'on_file' when the data has no date. */
const DETECTORS: Record<string, Record<string, (db: DB) => Detection>> = {
  'first-option-grant': {
    'file-25102o': (db) => db.equity.filing25102oOn,
    'get-409a': (db) => [...db.equity.valuations].sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn))[0]?.effectiveOn,
    'board-consent': (db) =>
      db.grants
        .map((g) => g.boardApprovedOn)
        .filter((d): d is ISODate => !!d)
        .sort()[0],
  },
  // EDD issues the account number only after registration, and a policy number means the policy is bound.
  'edd-registration': {
    register: (db) => (db.company.eddAccountNumber?.trim() ? 'on_file' : undefined),
    'save-account': (db) => (db.company.eddAccountNumber?.trim() ? 'on_file' : undefined),
  },
  'workers-comp': {
    'bind-policy': (db) => (db.company.workersCompCarrier?.policyNumber?.trim() ? 'on_file' : undefined),
    'save-carrier': (db) => (db.company.workersCompCarrier?.name?.trim() ? 'on_file' : undefined),
  },
}

function detectedActions(db: DB, rule: ComplianceRule, date: ISODate): { done: Record<string, ISODate>; onFile: string[] } {
  const done: Record<string, ISODate> = {}
  const onFile: string[] = []
  for (const [actionId, fn] of Object.entries(DETECTORS[rule.id] ?? {})) {
    const d = fn(db)
    if (d === 'on_file') {
      done[actionId] = date
      onFile.push(actionId)
    } else if (d) done[actionId] = d
  }
  return { done, onFile }
}

/**
 * Federal 20-week coverage is retroactive: once week 20 is reached in year X, the employer is covered for all
 * of X and X+1 (EEOC Compliance Manual, Section 2). The start of the unbroken run of covered years that
 * reaches the date, as Jan 1 of its first year.
 */
function twentyWeekCoverageStart(db: DB, n: number, date: ISODate): ISODate | undefined {
  const y = yearOf(date)
  const earliestYear = Math.min(yearOf(db.company.foundedOn || date), ...db.people.map((p) => yearOf(p.startDate)))
  const weeks = new Map<number, number>()
  const w = (yr: number) => {
    if (!weeks.has(yr)) weeks.set(yr, yr < earliestYear ? 0 : qualifyingWeeks(db, n, yr, yr === y ? date : undefined).length)
    return weeks.get(yr) as number
  }
  let first: number | undefined
  for (let yr = y; yr >= earliestYear; yr--) {
    if (w(yr) < 20 && w(yr - 1) < 20) break
    first = yr
  }
  return first === undefined ? undefined : `${first}-01-01`
}

function evalTrigger(db: DB, rule: ComplianceRule, date: ISODate): TriggerEval {
  const t = rule.trigger
  const override = db.complianceStatus[rule.id]?.countOverride
  if (t.kind === 'always') {
    const count = rawCount(db, 'w2_one_in_ca', date)
    // A law that covers contracts from a later date (stay-or-pay) applies now as preparation; it is in force
    // from its effective date, never from a founding date before the law existed.
    const effective = rule.effectiveOn && rule.effectiveOn > (db.company.foundedOn || '') ? rule.effectiveOn : undefined
    return {
      applies: true,
      count,
      computedCount: count,
      overridden: false,
      howCounted: effective
        ? `Applies to every employer, at any size, for contracts entered on or after ${fmtDate(effective)}.`
        : 'Applies to every employer, at any size.',
      firstAppliedOn: effective ? (effective <= date ? effective : undefined) : db.company.foundedOn,
    }
  }
  if (t.kind === 'event') {
    const hit = eventHit(db, t.event, date)
    const applies = !!hit && hit.date <= date
    const howCounted = hit ? (applies ? hit.text : `Not yet. Scheduled: ${hit.text}`) : `Not yet. ${eventNotYetText(t.event, db)}`
    return {
      applies,
      count: applies ? 1 : 0,
      computedCount: applies ? 1 : 0,
      overridden: false,
      howCounted,
      firstAppliedOn: applies ? hit?.date : undefined,
      ...(hit?.estimated ? { estimated: true } : {}),
    }
  }
  if (t.kind === 'site') {
    const res = countFor(db, 'site', date, { n: t.n })
    const computedApplies = res.count >= t.n || !!res.publicAccess
    const count = override ? override.value : res.count
    const applies = override ? count >= t.n || !!res.publicAccess : computedApplies
    const firstAppliedOn = computedApplies ? firstDateAtOrAbove(db, 'site', t.n, { through: date }) : undefined
    return {
      applies,
      count,
      computedCount: res.count,
      overridden: !!override,
      howCounted: overrideText(rule, override, res.count) + res.howCounted,
      firstAppliedOn: applies ? firstAppliedOn : undefined,
      stale: !applies && !override && !!res.staleSetting,
    }
  }
  const { method, n } = t
  const res = countFor(db, method, date, { n, ...rule.countOptions })
  const meets = (c: number) => (method === 'weeks_20' ? c >= 20 : c >= n)
  const computedApplies = meets(res.count)
  const count = override ? override.value : res.count
  const applies = override ? meets(count) : computedApplies
  let firstAppliedOn: ISODate | undefined
  if (computedApplies) {
    if (method === 'weeks_20') firstAppliedOn = twentyWeekCoverageStart(db, n, date)
    else if (method === 'cobra_prior_year') firstAppliedOn = `${yearOf(date)}-01-01`
    else firstAppliedOn = firstDateAtOrAbove(db, method, n, { through: date })
  }
  return {
    applies,
    count,
    computedCount: res.count,
    overridden: !!override,
    howCounted: overrideText(rule, override, res.count) + res.howCounted,
    firstAppliedOn: applies ? firstAppliedOn : undefined,
    weeks: res.weeks,
  }
}

/** Plain lead for an admin override. On 20-week rules the override is in qualifying weeks, not people. */
function overrideText(rule: ComplianceRule | undefined, override: ComplianceStatus['countOverride'], computed: number): string {
  if (!override) return ''
  const note = override.note ? ` (${override.note.replace(/\.$/, '')})` : ''
  if (rule?.trigger.kind === 'headcount' && rule.trigger.method === 'weeks_20') {
    return `An admin set this to ${plural(override.value, 'qualifying week')}${note} (computed: ${plural(computed, 'week')}). `
  }
  return `An admin set this count to ${override.value}${note}; the computed count is ${computed}. `
}

function notApplicableReason(db: DB, rule: ComplianceRule, date: ISODate, status?: ComplianceStatus): string | undefined {
  if (status?.status === 'not_applicable') return `Marked not applicable${status.note ? `: ${status.note.replace(/\.$/, '')}` : ''}.`
  if (rule.scope && !hasPresenceInCity(db, rule.scope.city)) return `No workplace or staff in ${rule.scope.city}.`
  if ((rule.jurisdiction === 'california' || rule.jurisdiction === 'san_jose') && !hasCaliforniaPresence(db, date)) {
    return 'No one works in California.'
  }
  if (rule.supersededBy) {
    const other = RULE_BY_ID[rule.supersededBy]
    if (other && evalTrigger(db, other, date).applies) return `${other.title} applies instead.`
  }
  // Continuation coverage needs a group health plan; null in Settings means the company offers none.
  if ((rule.id === 'cal-cobra' || rule.id === 'federal-cobra') && db.company.groupHealthPlanStartedOn === null) {
    return 'No group health plan is offered (Settings, Company).'
  }
  return undefined
}

/** When the rule is projected to start; `estimated` when that rests on an estimated event date (EventHit.estimated). */
function project(db: DB, rule: ComplianceRule, date: ISODate, includeOutstanding: boolean): { on: ISODate; estimated?: boolean } | undefined {
  const pdb = projectionDB(db, date, includeOutstanding)
  const t = rule.trigger
  const at = (on: ISODate | undefined) => (on ? { on } : undefined)
  switch (t.kind) {
    case 'always':
      return undefined
    case 'site':
      return at(firstDateAtOrAbove(pdb, 'site', t.n, { after: date }))
    case 'event': {
      const hit = eventHit(pdb, t.event, date)
      return hit && hit.date > date ? { on: hit.date, ...(hit.estimated ? { estimated: true } : {}) } : undefined
    }
    case 'headcount': {
      if (t.method === 'weeks_20') return at(estimateTwentyWeeks(pdb, t.n, date))
      if (t.method === 'cobra_prior_year') {
        const next = `${yearOf(date) + 1}-01-01`
        return rawCount(pdb, t.method, next, { n: t.n, ...rule.countOptions }) >= t.n ? { on: next } : undefined
      }
      return at(firstDateAtOrAbove(pdb, t.method, t.n, { after: date }))
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Yearly cycles (rule.cycle): the SB 294 notice, January posters, the 1099-NEC filing
// ---------------------------------------------------------------------------------------------

/** Yearly actions reopen this many days before their due date; until then last cycle's completion stands. */
export const CYCLE_REOPEN_DAYS = 60

/** The cycle year a date falls in: the year of the next due date on or after it. */
export function cycleYearOn(rule: ComplianceRule, date: ISODate): number {
  const mmdd = rule.cycle?.dueMonthDay ?? '12-31'
  return date.slice(5) <= mmdd ? yearOf(date) : yearOf(date) + 1
}

export function cycleDueOn(rule: ComplianceRule, year: number): ISODate {
  return `${year}-${rule.cycle?.dueMonthDay ?? '12-31'}`
}

/** First day of a cycle: the day after the previous year's due date. */
export function cycleStartsOn(rule: ComplianceRule, year: number): ISODate {
  return addDays(cycleDueOn(rule, year - 1), 1)
}

/**
 * When a yearly action was done for a cycle year: the whole-cycle key (markAnnualDone, calendar tick), the
 * action's key for that year (setRuleActionDone), or a plain dated record that falls inside the cycle.
 */
export function cycleActionDoneOn(rule: ComplianceRule, done: Record<string, ISODate>, actionId: string, year: number): ISODate | undefined {
  const whole = done[annualDoneKey(year)]
  if (whole) return whole
  const keyed = done[cycleActionKey(actionId, year)]
  if (keyed) return keyed
  const plain = done[actionId]
  return plain && plain >= cycleStartsOn(rule, year) && plain <= cycleDueOn(rule, year) ? plain : undefined
}

/**
 * The done records a yearly rule is judged on: its actionsDone, plus a whole-cycle record for the rule
 * itself being marked done (setRuleStatus 'done'). That counts for the cycle open when it was marked: the
 * upcoming one inside its reopen window, otherwise the one before it, so marking a rule done in March never
 * covers next January's filing.
 */
function cycleRecords(db: DB, rule: ComplianceRule): Record<string, ISODate> {
  const status = db.complianceStatus[rule.id]
  const done: Record<string, ISODate> = { ...(status?.actionsDone ?? {}) }
  if (rule.cycle && status?.status === 'done' && status.doneOn) {
    const y = cycleYearOn(rule, status.doneOn)
    const year = daysBetween(status.doneOn, cycleDueOn(rule, y)) <= CYCLE_REOPEN_DAYS ? y : y - 1
    const key = annualDoneKey(year)
    if (!done[key]) done[key] = status.doneOn
  }
  return done
}

function cycleDoneIn(rule: ComplianceRule, done: Record<string, ISODate>, year: number): ISODate | undefined {
  if (done[annualDoneKey(year)]) return done[annualDoneKey(year)]
  if (!rule.cycle) return undefined
  const dates = rule.cycle.actionIds.map((id) => cycleActionDoneOn(rule, done, id, year))
  if (dates.some((d) => !d)) return undefined
  return (dates as ISODate[]).sort().pop()
}

/** When every yearly action on the rule was done for a cycle year (or the whole cycle was marked done). */
export function cycleDoneOn(db: DB, rule: ComplianceRule, year: number): ISODate | undefined {
  return cycleDoneIn(rule, cycleRecords(db, rule), year)
}

/**
 * Whether a cycle year is owed: the yearly duty exists that year (firstYear), the rule applied on that
 * year's due date (or applies now, for a cycle not yet due), and any extra condition holds (1099-NEC: a
 * contractor paid at or above the threshold in the year before).
 */
export function cycleOwed(db: DB, rule: ComplianceRule, year: number, date: ISODate): boolean {
  const c = rule.cycle
  if (!c) return false
  if (c.firstYear && year < c.firstYear) return false
  const due = cycleDueOn(rule, year)
  if (!evalTrigger(db, rule, due < date ? due : date).applies) return false
  if (c.requires === 'contractors_1099' && !contractors1099(db, year - 1).length) return false
  if (c.requires === 'paid_employees' && !paidEmployeesOn(db, due).length) return false
  return true
}

/**
 * The cycle year a yearly action ticked on `date` completes: last cycle's while it is still open and this
 * cycle has not reopened (a late filing), otherwise this cycle's. Used by setRuleActionDone.
 */
export function cycleYearForCompletion(db: DB, rule: ComplianceRule, actionId: string, date: ISODate): number {
  const y = cycleYearOn(rule, date)
  const done = cycleRecords(db, rule)
  const reopened = daysBetween(date, cycleDueOn(rule, y)) <= CYCLE_REOPEN_DAYS
  if (!reopened && cycleOwed(db, rule, y - 1, date) && !cycleActionDoneOn(rule, done, actionId, y - 1)) return y - 1
  return y
}

type CycleEval = { cycle: NonNullable<RuleResult['cycle']>; done: Record<string, ISODate | undefined>; notDue: Set<string> }

function evaluateCycle(db: DB, rule: ComplianceRule, raw: Record<string, ISODate>, date: ISODate): CycleEval | undefined {
  const c = rule.cycle
  if (!c) return undefined
  const y = cycleYearOn(rule, date)
  const dueOn = cycleDueOn(rule, y)
  const reopened = daysBetween(date, dueOn) <= CYCLE_REOPEN_DAYS
  const owedNow = cycleOwed(db, rule, y, date)
  const owedPrev = cycleOwed(db, rule, y - 1, date)
  const done: Record<string, ISODate | undefined> = {}
  const notDue = new Set<string>()
  let open = false
  let overdue = false
  for (const id of c.actionIds) {
    const now = cycleActionDoneOn(rule, raw, id, y)
    const prev = cycleActionDoneOn(rule, raw, id, y - 1)
    if (now) done[id] = now
    else if (owedPrev && !prev) {
      done[id] = undefined
      open = overdue = true
    } else if (!owedNow || !reopened) {
      // Nothing due yet this cycle: last cycle's completion stands, if there was one.
      done[id] = prev
      if (!prev) notDue.add(id)
    } else {
      done[id] = undefined
      open = true
    }
  }
  return {
    cycle: {
      year: y,
      dueOn,
      startsOn: cycleStartsOn(rule, y),
      doneOn: cycleDoneIn(rule, raw, y),
      lastDoneOn: cycleDoneIn(rule, raw, y - 1),
      overdueYear: overdue ? y - 1 : undefined,
      open,
      ...(c.requires === 'paid_employees' && !owedNow && !owedPrev ? { awaitingEmployees: true } : {}),
    },
    done,
    notDue,
  }
}

/** Evaluates one rule on a date. */
export function evaluateRule(db: DB, rule: ComplianceRule, date: ISODate): RuleResult {
  const status = db.complianceStatus[rule.id]
  const detected = detectedActions(db, rule, date)
  const raw = status?.actionsDone ?? {}
  const actionsDone: Record<string, ISODate> = { ...detected.done }
  for (const a of rule.actions) if (raw[a.id]) actionsDone[a.id] = raw[a.id]
  const t = evalTrigger(db, rule, date)
  // A yearly employee notice starts with the first person it can go to, never with a founder working unpaid.
  if (rule.cycle?.requires === 'paid_employees' && t.applies) t.firstAppliedOn = firstPaidEmployeeOn(db, date)
  const na = notApplicableReason(db, rule, date, status)

  // Yearly actions count only for their cycle (never 'done forever').
  const cyc = t.applies ? evaluateCycle(db, rule, cycleRecords(db, rule), date) : undefined
  const notDue = cyc?.notDue ?? new Set<string>()
  if (cyc) {
    for (const [id, d] of Object.entries(cyc.done)) {
      if (d) actionsDone[id] = d
      else delete actionsDone[id]
    }
    // Marking the rule done covers its one-time actions for good; only the yearly ones come back.
    if (status?.status === 'done' && status.doneOn) {
      for (const a of rule.actions) if (!(a.id in cyc.done) && !actionsDone[a.id]) actionsDone[a.id] = status.doneOn
    }
  }
  // SB 553 'Train everyone' is done only while the training tracker agrees: a tick without a WVPP
  // completion for everyone in scope reopens (ticking it records those completions; see actions.ts).
  if (rule.id === 'wvpp' && actionsDone.train && t.applies && openTrainingRows(db, date, 'wvpp').length > 0) delete actionsDone.train
  const openActions = rule.actions.filter((a) => !actionsDone[a.id] && !notDue.has(a.id))
  const followUps = t.applies && !na ? ruleFollowUps(db, rule, date) : []

  let projectedOn: ISODate | undefined
  let projectedIfOffersAccepted: ISODate | undefined
  let projectedEstimated = false
  if (!t.applies && !t.overridden) {
    const projected = project(db, rule, date, false)
    projectedOn = projected?.on
    projectedEstimated = !!projected?.estimated
    const withOffers = project(db, rule, date, true)?.on
    if (withOffers && (!projectedOn || withOffers < projectedOn)) projectedIfOffersAccepted = withOffers
  }

  // A rule-level 'done' on a yearly rule counts for the cycle it was marked in (see cycleRecords), so it
  // lapses once the next cycle's yearly actions open.
  const markedDone = status?.status === 'done' && !cyc?.cycle.open

  const horizon = addDays(date, APPROACHING_DAYS)
  const anyRecorded = rule.actions.some((a) => actionsDone[a.id])
  const allActionsDone = rule.actions.length > 0 && openActions.length === 0 && anyRecorded
  let state: RuleState
  if (na) state = 'not_applicable'
  else if (followUps.length > 0) state = 'applies'
  else if (markedDone || allActionsDone) state = 'done'
  else if (t.applies) state = 'applies'
  else if (t.stale || (projectedOn && projectedOn <= horizon) || (projectedIfOffersAccepted && projectedIfOffersAccepted <= horizon)) state = 'approaching'
  else state = 'not_yet'

  const dueBase = t.applies ? t.firstAppliedOn : projectedOn
  const clockDue = rule.dueDaysAfterTrigger !== undefined && dueBase ? addDays(dueBase, rule.dueDaysAfterTrigger) : undefined
  const ruleDue = status?.dueOn ?? clockDue
  const firstFollowUp = followUps[0]?.dueOn
  const dueOn = firstFollowUp && (!ruleDue || firstFollowUp < ruleDue) ? firstFollowUp : ruleDue
  // Only a recorded trigger date makes the clock a legal deadline; an estimated one reads 'about'.
  const dueEstimated = !!dueOn && !status?.dueOn && dueOn === clockDue && dueOn !== firstFollowUp && (t.applies ? !!t.estimated : projectedEstimated)
  // A filing due on a weekend or company holiday goes in the business day before, never before its trigger. A
  // date from an overdue task (a DE 34) takes the task's own file-by day, as its checklist row shows.
  let by: ISODate | null = null
  if (dueOn && !dueEstimated) {
    if (rule.agencyFiling && dueOn === ruleDue) by = fileByDay(dueOn, holidayDates(db))
    else if (dueOn === firstFollowUp) by = followUps.find((f) => f.dueOn === dueOn && f.fileBy)?.fileBy ?? null
  }
  const fileBy = by && (!dueBase || by >= dueBase) ? by : undefined

  let recommended = false
  if (!t.applies && rule.recommendFrom !== undefined && rule.trigger.kind === 'headcount' && rule.trigger.method !== 'weeks_20') {
    recommended = rawCount(db, rule.trigger.method, date, rule.countOptions) >= rule.recommendFrom
  }

  const weeks =
    t.weeks &&
    ({
      ...t.weeks,
      estimatedOn: t.applies ? undefined : projectedOn,
      estimatedIfOffersAccepted: t.applies ? undefined : projectedIfOffersAccepted,
    } satisfies RuleResult['weeks'])

  return {
    rule,
    state,
    count: t.count,
    computedCount: t.computedCount,
    overridden: t.overridden,
    howCounted: t.howCounted,
    firstAppliedOn: t.firstAppliedOn,
    projectedOn,
    projectedIfOffersAccepted,
    dueOn,
    ...(dueEstimated ? { dueEstimated } : {}),
    ...(fileBy ? { fileBy } : {}),
    ...(t.applies && rule.effectiveOn && rule.effectiveOn > date ? { effectiveOn: rule.effectiveOn } : {}),
    recommended,
    weeks,
    status,
    actionsDone,
    ...(followUps.length ? { followUps } : {}),
    onFile: detected.onFile.filter((id) => !raw[id]),
    openActions,
    cycle: cyc?.cycle,
    notApplicableReason: na,
  }
}

/** True when the rule's trigger is met on the date (honoring an override) and it is not marked or found not applicable. */
export function ruleApplies(db: DB, rule: ComplianceRule, date: ISODate): boolean {
  if (notApplicableReason(db, rule, date, db.complianceStatus[rule.id])) return false
  return evalTrigger(db, rule, date).applies
}

/** Every rule in the catalog, evaluated on the date (catalog order). */
export function evaluateAll(db: DB, date: ISODate): RuleResult[] {
  return RULES.map((r) => evaluateRule(db, r, date))
}

/** Counts by state plus open actions on rules that apply, for badges. */
export function summarizeResults(results: RuleResult[]): Record<RuleState, number> & { openActions: number } {
  const out = { not_yet: 0, approaching: 0, applies: 0, done: 0, not_applicable: 0, openActions: 0 }
  for (const r of results) {
    out[r.state] += 1
    if (r.state === 'applies') out.openActions += r.openActions.length
  }
  return out
}

/**
 * The pay-range hard stop (Labor Code 432.3): once active employees plus accepted offers reach 15,
 * a job cannot be marked posted without a pay range. Honors an admin count override on the rule.
 */
export function payRangeRequiredToPost(db: DB, date: ISODate): { required: boolean; count: number; howCounted: string } {
  const employed = db.people.filter((p) => isEmployedOn(p, date)).length
  const incoming = db.people.filter((p) => p.startDate > date && !(p.endDate && p.endDate < p.startDate)).length
  const accepted = offerPhantoms(db, date).filter((ph) => ph.kind === 'incoming').length
  const computed = employed + incoming + accepted
  const override = db.complianceStatus['pay-scale-in-postings']?.countOverride
  const count = override ? override.value : computed
  const parts = [plural(employed, 'employee'), `${plural(incoming + accepted, 'accepted offer')} not started yet`]
  return {
    required: count >= 15 && hasCaliforniaPresence(db, date),
    count,
    howCounted: `${overrideText(RULE_BY_ID['pay-scale-in-postings'], override, computed)}${listJoin(parts)}: ${computed} in total. At 15, every job post needs a pay range.`,
  }
}

// ---------------------------------------------------------------------------------------------
// Next threshold card
// ---------------------------------------------------------------------------------------------

export type NextThreshold = {
  n: number
  kind: 'headcount' | 'site'
  current: number
  /** The count once everyone already hired has started. */
  withIncoming: number
  projectedOn?: ISODate
  projectedIfOffersAccepted?: ISODate
  /** Rules that switch on at this milestone and do not apply yet. */
  rules: Array<{ id: string; title: string; summary: string }>
  federalWeeks?: { n: number; weeksSoFar: number; estimatedOn?: ISODate; estimatedIfOffersAccepted?: ISODate }
  howCounted: string
  /** One or two plain sentences for the card. */
  summary: string
}

const MILESTONES: Array<{ n: number; kind: 'headcount' | 'site' }> = [
  { n: 5, kind: 'headcount' },
  { n: 10, kind: 'site' },
  { n: 15, kind: 'headcount' },
  { n: 20, kind: 'headcount' },
  { n: 25, kind: 'headcount' },
  { n: 36, kind: 'headcount' },
  { n: 50, kind: 'headcount' },
  { n: 75, kind: 'headcount' },
  { n: 100, kind: 'headcount' },
]

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** 'late May 2027' */
export function roughDate(d: ISODate): string {
  const [y, m, day] = d.split('-').map(Number)
  const part = day <= 10 ? 'early' : day <= 20 ? 'mid' : 'late'
  return `${part} ${MONTHS[m - 1]} ${y}`
}

/**
 * The next milestone (5, 10, 15, 20, then 25, 36, 50, 75, 100) with projections. At 10 the card is about the
 * office (SB 553) when there is one and the plan does not apply yet, and also lists the rules that start at
 * 10 employees (IIPP records); without an office, or once SB 553 applies, it is a headcount card for those
 * rules. It is skipped once headcount is 10 or more (a stale peak-on-site setting must not hide 15; the
 * SB 553 card flags it instead). null past 100.
 */
export function nextThreshold(db: DB, date: ISODate): NextThreshold | null {
  const current = rawCount(db, 'w2_one_in_ca', date)
  const hasSite = db.locations.some((l) => l.kind === 'hq')
  for (const m of MILESTONES) {
    if (current >= m.n) continue
    if (m.kind === 'site') {
      if (hasSite && !evalTrigger(db, RULE_BY_ID.wvpp, date).applies) return siteMilestone(db, date)
      const ten = headcountMilestone(db, date, m.n, current)
      if (ten.rules.length) return ten
      continue
    }
    return headcountMilestone(db, date, m.n, current)
  }
  return null
}

function pendingRulesAt(db: DB, date: ISODate, match: (r: ComplianceRule) => boolean): NextThreshold['rules'] {
  return RULES.filter(match)
    .map((r) => evaluateRule(db, r, date))
    .filter((res) => res.state === 'not_yet' || res.state === 'approaching')
    .map((res) => ({ id: res.rule.id, title: res.rule.title, summary: res.rule.summary }))
}

function newPeople(db: DB, date: ISODate, until: ISODate): Person[] {
  return db.people.filter((p) => p.startDate > date && p.startDate <= until).sort((a, b) => a.startDate.localeCompare(b.startDate))
}

function headcountMilestone(db: DB, date: ISODate, n: number, current: number): NextThreshold {
  const pdb = projectionDB(db, date, false)
  const pdbAll = projectionDB(db, date, true)
  const projectedOn = firstDateAtOrAbove(pdb, 'w2_one_in_ca', n, { after: date })
  const withOffers = firstDateAtOrAbove(pdbAll, 'w2_one_in_ca', n, { after: date })
  const projectedIfOffersAccepted = withOffers && (!projectedOn || withOffers < projectedOn) ? withOffers : undefined
  const lastStart = pdb.people
    .map((p) => p.startDate)
    .filter((d) => d > date)
    .sort()
    .pop()
  const withIncoming = lastStart ? rawCount(pdb, 'w2_one_in_ca', lastStart) : current

  const rules = pendingRulesAt(db, date, (r) => r.trigger.kind === 'headcount' && r.trigger.n === n)
  const weeksRule = RULES.find((r) => r.trigger.kind === 'headcount' && r.trigger.method === 'weeks_20' && r.trigger.n === n)
  let federalWeeks: NextThreshold['federalWeeks']
  if (weeksRule) {
    const est = estimateTwentyWeeks(pdb, n, date)
    const estAll = estimateTwentyWeeks(pdbAll, n, date)
    federalWeeks = {
      n,
      weeksSoFar: weeksAtOrAbove(db, n, yearOf(date), date),
      estimatedOn: est,
      estimatedIfOffersAccepted: estAll && (!est || estAll < est) ? estAll : undefined,
    }
  }

  const sentences = [`You have ${plural(current, 'employee')}.`]
  const label = (p: Person) => `${fullName(p)} (${fmtShort(p.startDate)}${p.id.startsWith('offer:') && isOutstanding(db, date, p.id) ? ', if accepted' : ''})`
  if (projectedOn) {
    sentences.push(`With ${listJoin(newPeople(pdb, date, projectedOn).map(label))}, you reach ${n} on ${fmtDate(projectedOn)}.`)
  } else if (projectedIfOffersAccepted) {
    sentences.push(`With ${listJoin(newPeople(pdbAll, date, projectedIfOffersAccepted).map(label))}, you would reach ${n} on ${fmtDate(projectedIfOffersAccepted)}.`)
  } else if (withIncoming > current) {
    sentences.push(`With the people already hired you will have ${withIncoming}.`)
  }
  if (federalWeeks) {
    const est = federalWeeks.estimatedOn ?? federalWeeks.estimatedIfOffersAccepted
    // Coverage is retroactive (LAW.md b-titlevii-ada-15): reaching week 20 in a year covers that whole year.
    const tail = est
      ? `; at that pace you would reach week 20 around ${roughDate(est)}${federalWeeks.estimatedOn ? '' : ' if offers are accepted'}, and coverage then reaches back to Jan 1, ${est.slice(0, 4)}, so plan as covered for all of ${est.slice(0, 4)}`
      : ''
    sentences.push(
      `Federal coverage at ${n} needs ${n} or more employees in 20 calendar weeks of one year (week ${federalWeeks.weeksSoFar} of 20 in ${yearOf(date)})${tail}.`,
    )
  }
  return {
    n,
    kind: 'headcount',
    current,
    withIncoming,
    projectedOn,
    projectedIfOffersAccepted,
    rules,
    federalWeeks,
    howCounted: countFor(db, 'w2_one_in_ca', date).howCounted,
    summary: sentences.join(' '),
  }
}

function isOutstanding(db: DB, date: ISODate, phantomId: ID): boolean {
  return offerPhantoms(db, date).some((ph) => ph.person.id === phantomId && ph.kind === 'if_accepted')
}

function siteMilestone(db: DB, date: ISODate): NextThreshold {
  const res = countFor(db, 'site', date, { n: 10 })
  const pdb = projectionDB(db, date, false)
  const pdbAll = projectionDB(db, date, true)
  const projectedOn = firstDateAtOrAbove(pdb, 'site', 10, { after: date })
  const withOffers = firstDateAtOrAbove(pdbAll, 'site', 10, { after: date })
  const lastStart = pdb.people
    .map((p) => p.startDate)
    .filter((d) => d > date)
    .sort()
    .pop()
  const withIncoming = !lastStart ? res.count : rawCount(pdb, 'site', lastStart)
  let summary = res.fromSettings
    ? `About ${plural(res.count, 'person', 'people')} ${res.count === 1 ? 'is' : 'are'} at the office at once on a busy day. Update the typical peak on site in Settings as the team grows.`
    : `${plural(res.count, 'employee')} ${res.count === 1 ? 'works' : 'work'} at the office on an onsite or hybrid basis.`
  if (res.staleSetting) {
    summary = `Your Settings peak (${res.setting}) is below the ${res.assigned} people assigned to the office on an onsite or hybrid basis; update it in Settings.`
  }
  const headcountTen = pendingRulesAt(db, date, (r) => r.trigger.kind === 'headcount' && r.trigger.n === 10 && r.trigger.method !== 'weeks_20')
  return {
    n: 10,
    kind: 'site',
    current: res.count,
    withIncoming,
    projectedOn,
    projectedIfOffersAccepted: withOffers && (!projectedOn || withOffers < projectedOn) ? withOffers : undefined,
    rules: [...pendingRulesAt(db, date, (r) => r.trigger.kind === 'site' && r.trigger.n === 10), ...headcountTen],
    howCounted: res.howCounted,
    summary,
  }
}

// ---------------------------------------------------------------------------------------------
// Milestone history and the headcount ruler
// ---------------------------------------------------------------------------------------------

export type Milestone = { n: number; date: ISODate; direction: 'up' | 'down'; personId?: ID; text: string }

export const HISTORY_THRESHOLDS = [5, 10, 15, 20]

/**
 * Crossings of 5, 10, 15 and 20 in W-2 headcount, up and down, as a story:
 * 'Crossed 5 on Oct 6, 2025 when Kofi Boateng joined.' A down-crossing is dated the first day without
 * the person. Pass `through` to stop at a date; without it, scheduled future starts are included.
 */
export function milestoneHistory(db: DB, through?: ISODate): Milestone[] {
  const points = new Set<ISODate>()
  for (const p of db.people) {
    points.add(p.startDate)
    if (p.endDate) points.add(addDays(p.endDate, 1))
  }
  const out: Milestone[] = []
  let prev = 0
  for (const d of [...points].sort()) {
    if (through && d > through) break
    const after = db.people.filter((p) => isEmployedOn(p, d)).length
    const starters = db.people.filter((p) => p.startDate === d).sort((a, b) => a.hireNumber - b.hireNumber)
    const leavers = db.people.filter((p) => p.endDate && addDays(p.endDate, 1) === d).sort((a, b) => a.hireNumber - b.hireNumber)
    for (const n of HISTORY_THRESHOLDS) {
      if (prev < n && after >= n) {
        let c = prev - leavers.length
        const who = starters.find(() => ++c >= n) ?? starters[starters.length - 1]
        out.push({
          n,
          date: d,
          direction: 'up',
          personId: who?.id,
          text: who ? `Crossed ${n} on ${fmtDate(d)} when ${fullName(who)} joined.` : `Crossed ${n} on ${fmtDate(d)}.`,
        })
      } else if (prev >= n && after < n) {
        let c = prev
        const who = leavers.find(() => --c < n) ?? leavers[leavers.length - 1]
        const lastDay = who?.endDate ?? addDays(d, -1)
        out.push({
          n,
          date: d,
          direction: 'down',
          personId: who?.id,
          text: who
            ? `Dropped below ${n} after ${fullName(who)}'s last day on ${fmtDate(lastDay)}.`
            : `Dropped below ${n} on ${fmtDate(d)}.`,
        })
      }
    }
    prev = after
  }
  return out
}

export type RulerDot = {
  personId?: ID
  offerId?: ID
  label: string
  /** employee = solid; incoming = solid, starts later; if_accepted = hollow, offer outstanding. */
  kind: 'employee' | 'incoming' | 'if_accepted'
  /** Start date (or proposed start date for offers). */
  date: ISODate
}

/** One dot per employee (hire order), then people already hired who start later, then outstanding offers. */
export function headcountRuler(db: DB, date: ISODate): RulerDot[] {
  const employees = db.people
    .filter((p) => isEmployedOn(p, date))
    .sort((a, b) => a.hireNumber - b.hireNumber || a.startDate.localeCompare(b.startDate))
    .map((p): RulerDot => ({ personId: p.id, label: fullName(p), kind: 'employee', date: p.startDate }))
  const phantoms = offerPhantoms(db, date)
  const incoming = [
    ...db.people
      .filter((p) => p.startDate > date && !(p.endDate && p.endDate < p.startDate))
      .map((p): RulerDot => ({ personId: p.id, label: fullName(p), kind: 'incoming', date: p.startDate })),
    ...phantoms
      .filter((ph) => ph.kind === 'incoming')
      .map((ph): RulerDot => ({ offerId: ph.offer.id, label: fullName(ph.person), kind: 'incoming', date: ph.person.startDate })),
  ].sort((a, b) => a.date.localeCompare(b.date))
  const ifAccepted = phantoms
    .filter((ph) => ph.kind === 'if_accepted')
    .map((ph): RulerDot => ({ offerId: ph.offer.id, label: fullName(ph.person), kind: 'if_accepted', date: ph.person.startDate }))
  return [...employees, ...incoming, ...ifAccepted]
}
