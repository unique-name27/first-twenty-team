// The action inbox: everything that needs a person's attention, computed live from the data and never
// stored (docs/SPEC.md: ACTION INBOX). Only snoozes and dismissals live in db.inboxState, keyed by each
// item's stable key. Statutory items are the only red ones and cannot be snoozed past their due date
// or dismissed; they can only be marked done, or not applicable with a note.
//
// Scopes follow the Viewing-as rules (src/domain/access.ts):
// - admin: the whole company's queue (approvals, compliance, onboarding, contractors, backup), with items
//   other people own shown as 'waiting on them' only when they are overdue or close.
// - manager: their own tasks, scorecards, candidates in jobs they manage, Admin's answer on offers they
//   drafted or manage (changes asked, approved and ready to send; an Admin's draft needs no answer, so it
//   is ready to send once saved), time off from direct reports,
//   manager-owned tasks for their reports and their team's overdue trainings. Never pay, equity or
//   compliance.
// - personal: one person's own tasks (Employee view and Me > My tasks): their checklist tasks, trainings,
//   policy acknowledgements and scorecards.
//
// Each item carries one primary action: a mutation described as data (InboxOp, applied by applyInboxOp
// inside useDB.getState().mutate so it can be undone), a link, or text to copy.
import { format } from 'date-fns'
import type { Draft } from 'immer'
import { href, links } from '@/app/router'
import { LAW_SOURCES } from '@/data/law'
import { canApproveTimeOff, canSeeTimeOffDetail, hiringManagerModeAvailable, isInReportingLine } from '@/domain/access'
import { ACK_TASK_POLICY, closeAckTasks, setTaskStatus } from '@/domain/checklists/actions'
import { dueLabel, fileBy, holidayDates, taskFileBy } from '@/domain/checklists/generate'
import { HARASSMENT_TASK_KINDS, TASK_IDS } from '@/domain/checklists/templates'
import {
  complianceCalendar,
  evaluateAll,
  type CalendarItem,
  hasPerPersonTasks,
  NOT_LEGAL_ADVICE,
  RULE_BY_ID,
  ruleDeadlineBesideTasks,
  type RuleResult,
} from '@/domain/compliance'
import {
  completeRecurringItem,
  markAccessReviewDone,
  markAnnualDone,
  recordTrainingCompletion,
  setRuleActionDone,
  setRuleStatus,
  trainingsRecordedBy,
} from '@/domain/compliance/actions'
import { boardConsentQueue, consentTableText } from '@/domain/equity'
import { GRADUATION_HEADCOUNT, GRADUATION_OUTGROW_AT, graduationCount } from '@/domain/graduation'
import { hasHolidaysIn, rolloverHolidays } from '@/domain/holidays'
import {
  approvalRequired,
  attentionReasons,
  businessDaysBetween,
  candidateName,
  dbHolidays,
  extendOffer,
  approveOffer,
  approveRequisition,
  declineRequisition,
  pendingRequisitions,
  offerNudgeMessage,
  pacificDateOf,
  scorecardsOwed,
  allScorecardsOwed,
  stageById,
  type AttentionReason,
} from '@/domain/hiring'
import { markDesignationSent } from '@/domain/lifecycle'
import {
  cutoffWords,
  markPayRunSubmitted,
  nextPayRunDue,
  payrollProviderName,
  payrollSettings,
  periodHeadline,
  periodLabel,
  periodStarting,
  providerPhrase,
  unmarkedPayRuns,
} from '@/domain/payrun'
import { employedOn, firstName, fullName, getPerson, headcountSeries, incomingOn, isEmployedOn, welcomeEmail } from '@/domain/people'
import { approveAsUnpaid, approveRequest, hoursLabel, isConfidentialKind, pendingApprovals, serviceWait } from '@/domain/timeoff'
import { trainingRequirements, TRAINING_LABELS, CRD_COURSE_URL } from '@/domain/trainings'
import type {
  Checklist,
  ChecklistTask,
  Contractor,
  DB,
  ID,
  InboxState,
  LeaveCase,
  Person,
  TrainingKind,
  Viewer,
} from '@/domain/types'
import { addBusinessDays, addDays, daysBetween, fmtDate, fmtQuarter, fmtShort, type ISODate, type ISODateTime, localDateOf, nowISO, parseDate, quarterOf, today } from '@/lib/dates'
import { listJoin, plural } from '@/lib/format'
import { newId } from '@/lib/id'
import { logActivity } from '@/store/draft'

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export type InboxGroup = 'overdue' | 'this_week' | 'coming_up'

export type InboxKind =
  | 'task'
  | 'task_group'
  | 'scorecard'
  | 'scorecards_team'
  | 'candidates'
  | 'offer_approval'
  | 'offer_waiting'
  | 'offer_changes'
  | 'offer_send'
  | 'offer_expiring'
  | 'requisition'
  | 'requisition_waiting'
  | 'timeoff'
  | 'grants'
  | 'ab5'
  | 'rule'
  | 'rules_group'
  | 'threshold'
  | 'calendar'
  | 'leave_notice'
  | 'training'
  | 'acks'
  | 'ack'
  | 'backup'
  | 'holidays'
  | 'graduation'
  | 'unlock'
  | 'bands'
  | 'payrun'
  | 'payrun_unmarked'

/** A mutation the inbox can run, as plain data (applied by applyInboxOp inside mutate). */
export type InboxOp =
  | { type: 'task_status'; checklistId: ID; taskId: ID; status: 'done' | 'not_applicable'; note?: string }
  | { type: 'approve_offer'; offerId: ID }
  | { type: 'approve_requisition'; jobId: ID }
  | { type: 'decline_requisition'; jobId: ID }
  | { type: 'extend_offer'; offerId: ID; businessDays: number }
  | { type: 'approve_timeoff'; requestId: ID }
  /** Sick leave held before the service wait: approve it as unpaid leave instead of waiving the wait. */
  | { type: 'approve_timeoff_unpaid'; requestId: ID }
  | { type: 'leave_notice_sent'; leaveCaseId: ID }
  | { type: 'rule_action_done'; ruleId: string; actionId: string }
  | { type: 'rule_not_applicable'; ruleId: string; note: string }
  | { type: 'training_done'; personId: ID; kind: TrainingKind }
  | { type: 'recurring_done'; recurringId: ID }
  | { type: 'access_review_done'; quarter: string }
  | { type: 'annual_done'; ruleId: string; year: number }
  | { type: 'de542_filed'; contractorId: ID }
  | { type: 'acknowledge'; policyId: ID; personId: ID }
  | { type: 'backup_downloaded' }
  | { type: 'add_holidays'; year: number }
  /** Pay run prep: the period starting on this date was entered in the provider. */
  | { type: 'payrun_submitted'; periodStart: ISODate }

export type InboxAction =
  /** `toast` names the change; it is also the mutate label (the Undo toast text). */
  | { kind: 'mutate'; label: string; op: InboxOp; toast: string }
  | { kind: 'navigate'; label: string; href: string }
  | { kind: 'copy'; label: string; text: string; toast: string }
  /** Opens a sheet right on Home (a scorecard), so the row's button does what it says. */
  | { kind: 'sheet'; label: string; sheet: 'scorecard'; id: ID }

export type InboxItem = {
  /** Stable across renders and days, e.g. 'task:<checklistId>:<taskId>'. Snoozes and dismissals use it. */
  key: string
  kind: InboxKind
  /** A plain sentence: 'DE 34 for Aisha Bello was due Mon Sep 28: confirm your PEO filed it'. */
  title: string
  detail?: string
  dueOn?: ISODate
  /** Custom chip text when the date is not a due date ('Starts Mon Nov 23'). */
  chip?: string
  /** Explains the date on focus: weekend-aware filing day, or how the due date was set. */
  dueNote?: string
  group: InboxGroup
  /** Legal deadline: red when overdue, cannot be snoozed past dueOn or dismissed. */
  statutory: boolean
  /**
   * A deadline that is not legal but still cannot wait (the provider's payroll cutoff): snoozes stop at this date,
   * the item comes back on it, and it cannot be dismissed. It is never red.
   */
  snoozeLimit?: ISODate
  /** What the snoozeLimit is, for the 'cannot snooze' words ('The payroll cutoff'). */
  snoozeLimitLabel?: string
  waitingOn: 'you' | 'them'
  /** Who it waits on when waitingOn is 'them' (first name or a role), for the badge. */
  waitingOnName?: string
  ownerId?: ID
  /** Where to open it. */
  href: string
  /** The one inline action. */
  primary: InboxAction
  /** Secondary actions for the row's More menu. */
  more?: InboxAction[]
  /** Offer "Not applicable" with a note (statutory checklist tasks and rule steps). */
  notApplicable?: { op: 'task' | 'rule'; checklistId?: ID; taskId?: ID; ruleId?: string }
  /** Time estimate in minutes, summed for the Tonight header. */
  minutes: number
  citation?: { label: string; url?: string }
  /** An outside page to read (a policy document, an official form). */
  externalLink?: { label: string; url: string }
  refs: {
    personId?: ID
    candidateId?: ID
    applicationId?: ID
    jobId?: ID
    offerId?: ID
    checklistId?: ID
    taskId?: ID
    ruleId?: string
    contractorId?: ID
    requestId?: ID
    leaveCaseId?: ID
    policyId?: ID
    grantIds?: ID[]
    trainingKind?: TrainingKind
  }
}

export type InboxScope = 'admin' | 'manager' | 'personal'

export type InboxOptions = {
  /** Current moment, for scorecards (an interview must have ended). Defaults to now on today, else noon on the date. */
  now?: ISODateTime
  /** Override the scope (Me passes 'personal'). Defaults from the viewer's role. */
  scope?: InboxScope
  /** Include items that are snoozed or dismissed (for counts in settings). Default false. */
  includeHidden?: boolean
  /**
   * How many days ahead checklist tasks and trainings are listed. Default HORIZON_DAYS. Me > Tasks passes a
   * longer horizon so its one to-do list also holds later items (they group under Coming up).
   */
  horizonDays?: number
}

// ---------------------------------------------------------------------------------------------
// Groups, snoozes and the Tonight header
// ---------------------------------------------------------------------------------------------

/** Items due in the next 7 days are 'this week'; viewer-owned items show up to 14 days ahead. */
export const WEEK_DAYS = 7
export const HORIZON_DAYS = 14
/** Approaching headcount thresholds show this many days ahead. */
export const THRESHOLD_HORIZON_DAYS = 30
/** Offers out that expire within this many business days. */
export const OFFER_EXPIRY_BUSINESS_DAYS = 5
/** Backups older than this many days show up. */
export const BACKUP_STALE_DAYS = 7

export function groupFor(dueOn: ISODate | undefined, date: ISODate): InboxGroup {
  if (!dueOn) return 'this_week'
  if (dueOn < date) return 'overdue'
  if (dueOn <= addDays(date, WEEK_DAYS)) return 'this_week'
  return 'coming_up'
}

export const GROUP_LABELS: Record<InboxGroup, string> = { overdue: 'Overdue', this_week: 'This week', coming_up: 'Coming up' }

export type SnoozeOption = {
  label: string
  until: ISODate
  /** Shortened to the due date (statutory). */
  capped: boolean
}

const SNOOZE_STEPS: Array<{ label: string; days: number }> = [
  { label: '1 day', days: 1 },
  { label: '3 days', days: 3 },
  { label: '1 week', days: 7 },
]

/**
 * Snooze choices for an item: 1 day, 3 days, 1 week. Statutory items with a due date are capped at the
 * due date (duplicates collapse), and cannot be snoozed at all once due. An item with a snoozeLimit (the
 * payroll cutoff) is capped the same way at that date.
 */
export function snoozeOptions(item: Pick<InboxItem, 'statutory' | 'dueOn' | 'group' | 'snoozeLimit'>, date: ISODate): SnoozeOption[] {
  const out: SnoozeOption[] = []
  // An overdue legal item with no date (a rule that already applies) cannot wait either.
  if (item.statutory && item.group === 'overdue') return []
  const limit = item.snoozeLimit ?? (item.statutory ? item.dueOn : undefined)
  for (const s of SNOOZE_STEPS) {
    let until = addDays(date, s.days)
    let capped = false
    if (limit) {
      if (limit <= date) return []
      if (until > limit) {
        until = limit
        capped = true
      }
    }
    if (out.some((o) => o.until === until)) continue
    out.push({ label: capped ? 'Until the due date' : s.label, until, capped })
  }
  return out
}

/** Statutory items cannot be dismissed (only done, or not applicable with a note), nor can items with a snoozeLimit. */
export function canDismiss(item: Pick<InboxItem, 'statutory' | 'snoozeLimit'>): boolean {
  return !item.statutory && !item.snoozeLimit
}

/**
 * Why an item offers no snooze (snoozeOptions is empty), for the row's lock: a legal deadline once due, or the
 * item's own limit ('The payroll cutoff is today: it cannot be snoozed'), which is not a legal deadline.
 */
export function noSnoozeReason(item: Pick<InboxItem, 'statutory' | 'snoozeLimit' | 'snoozeLimitLabel'>, date: ISODate): string {
  if (!item.statutory && item.snoozeLimit) {
    const what = item.snoozeLimitLabel ?? 'The deadline'
    return item.snoozeLimit === date ? `${what} is today: it cannot be snoozed` : `${what} has passed: it cannot be snoozed`
  }
  return 'A legal deadline cannot be snoozed once due'
}

/**
 * The sentence an expanded row shows when it offers no snooze. A legal deadline says what it does offer instead
 * (done, or not applicable with a note); an item with its own limit (the payroll cutoff) is not a legal deadline and
 * has neither action, so it says only why (noSnoozeReason).
 */
export function noSnoozeDetail(item: Pick<InboxItem, 'statutory' | 'snoozeLimit' | 'snoozeLimitLabel'>, date: ISODate): string {
  if (!item.statutory && item.snoozeLimit) return `${noSnoozeReason(item, date)}.`
  return 'A legal deadline cannot be snoozed once due. Mark it done, or not applicable with a note.'
}

/** The first letter in capitals, for a phrase that opens a sentence ('time off for 2 people' -> 'Time off ...'). */
function sentenceCase(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text
}

/** Hides an item until a date. Statutory items are capped at their due date when shown (see isHidden). */
export function snoozeItem(draft: Draft<DB> | DB, key: string, until: ISODate): void {
  const prev = draft.inboxState[key] ?? {}
  draft.inboxState[key] = { ...prev, snoozedUntil: until }
}

/** Hides a non-statutory item for good (its key changes when the underlying thing recurs). */
export function dismissItem(draft: Draft<DB> | DB, key: string, date: ISODate = today()): void {
  const prev = draft.inboxState[key] ?? {}
  draft.inboxState[key] = { ...prev, dismissedOn: date }
}

/** Clears a snooze or dismissal. */
export function restoreItem(draft: Draft<DB> | DB, key: string): void {
  delete draft.inboxState[key]
}

/**
 * True while a snooze or dismissal hides the item on the date. Statutory items reappear on their due date, and
 * items with a snoozeLimit on that date.
 */
export function isHidden(state: InboxState | undefined, item: Pick<InboxItem, 'statutory' | 'dueOn' | 'group' | 'snoozeLimit'>, date: ISODate): boolean {
  if (!state) return false
  if (state.dismissedOn && canDismiss(item)) return true
  if (state.snoozedUntil && state.snoozedUntil > date) {
    if (item.statutory && ((item.dueOn && item.dueOn <= date) || item.group === 'overdue')) return false
    if (item.snoozeLimit && item.snoozeLimit <= date) return false
    return true
  }
  return false
}

/** Count and minutes for the Tonight header: everything overdue or due this week. */
export function tonightSummary(items: InboxItem[]): { count: number; minutes: number } {
  const now = items.filter((i) => i.group !== 'coming_up')
  const raw = now.reduce((t, i) => t + Math.max(0, i.minutes), 0)
  const minutes = raw <= 10 ? raw : Math.round(raw / 5) * 5
  return { count: now.length, minutes }
}

/** '25 minutes', '1 hour', '1.5 hours'. */
export function minutesText(m: number): string {
  if (m < 60) return plural(Math.max(1, m), 'minute')
  const h = Math.round(m / 30) / 2
  return h === 1 ? '1 hour' : `${h} hours`
}

/** 'Friday, Oct 9: 13 things, about 25 minutes'. */
export function tonightHeadline(date: ISODate, s: { count: number; minutes: number }): string {
  const day = format(parseDate(date), 'EEEE, MMM d')
  if (s.count === 0) return `${day}: nothing needs you tonight`
  return `${day}: ${plural(s.count, 'thing')}, about ${minutesText(s.minutes)}`
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/** 'Mon Oct 19' */
export function dayText(d: ISODate): string {
  return format(parseDate(localDateOf(d)), 'EEE MMM d')
}

/** 'Oct 30', 'Nov 23-25', 'Nov 30 to Dec 2' */
export function rangeText(start: ISODate, end: ISODate): string {
  if (start === end) return fmtShort(start)
  if (start.slice(0, 7) === end.slice(0, 7)) return `${fmtShort(start)}-${Number(end.slice(8, 10))}`
  return `${fmtShort(start)} to ${fmtShort(end)}`
}

function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s
}

/** "Tomas's", "Aisha Bello's" (the house style adds 's to every name). */
function possessive(name: string): string {
  return `${name}'s`
}

/** AB5 result for a contractor: an exemption moves the test to Borello (likely OK here); otherwise ABC. */
export function ab5Result(c: Pick<Contractor, 'kind' | 'ab5'>): 'likely_ok' | 'review' | 'likely_employee' {
  if (c.kind !== 'contractor') return 'likely_ok'
  if (c.ab5.exemption !== 'none') return 'likely_ok'
  const prongs = [c.ab5.a, c.ab5.b, c.ab5.c]
  if (prongs.some((p) => p === false)) return 'likely_employee'
  if (prongs.some((p) => p === null)) return 'review'
  return 'likely_ok'
}

const AB5_PRONGS: Record<'a' | 'b' | 'c', string> = {
  a: 'A (free from our control)',
  b: 'B (outside our usual business)',
  c: 'C (an independent business of their own)',
}

const AB5_CITATION = {
  label: 'Labor Code 2775 (AB5)',
  url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=LAB&sectionNum=2775.',
}

/** Training kind a checklist task completes, if any. */
export function taskTrainingKind(task: Pick<ChecklistTask, 'templateTaskId'>): TrainingKind | undefined {
  const id = task.templateTaskId ?? ''
  if (HARASSMENT_TASK_KINDS[id]) return HARASSMENT_TASK_KINDS[id]
  if (id === 'on-security-training') return 'security_awareness'
  return undefined
}

/** Who takes the training a task stands for (the new supervisor on the change checklist's task). */
function traineeOf(checklist: Pick<Checklist, 'personId'>, task: Pick<ChecklistTask, 'templateTaskId' | 'assigneeId'>): ID {
  if (task.templateTaskId === TASK_IDS.supervisorTraining && task.assigneeId) return task.assigneeId
  return checklist.personId
}

/** Onboarding acknowledgement tasks and the policy each one records. */

/** Who owns a checklist task: admin (and IT) tasks belong to Admin; manager and employee tasks to a person. */
export function taskOwnerId(db: DB, checklist: Checklist, task: ChecklistTask): ID | null {
  if (task.ownerRole === 'admin' || task.ownerRole === 'it') return null
  if (task.assigneeId) return task.assigneeId
  if (task.ownerRole === 'employee') return checklist.personId
  return getPerson(db, checklist.personId)?.managerId ?? null
}

function reminderText(db: DB, to: string, what: string, senderId: ID | null, extra?: string): string {
  const sender = getPerson(db, senderId)
  return [`Hi ${to},`, '', `${what}${extra ? ` ${extra}` : ''}`, '', 'Thanks,', sender ? firstName(sender) : db.company.name].join('\n')
}

// ---------------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------------

type Ctx = {
  db: DB
  date: ISODate
  now: ISODateTime
  scope: InboxScope
  me: ID | null
  viewer: Viewer
  holidays: ISODate[]
  /** Last date checklist tasks and trainings are listed for (InboxOptions.horizonDays). */
  horizon: ISODate
  name: (id: ID | null | undefined) => string
  first: (id: ID | null | undefined) => string
}

function makeCtx(db: DB, viewer: Viewer, date: ISODate, opts: InboxOptions): Ctx {
  const scope: InboxScope = opts.scope ?? (viewer.role === 'admin' ? 'admin' : viewer.role === 'manager' ? 'manager' : 'personal')
  const now = opts.now ?? (date === today() ? nowISO() : `${date}T19:00:00.000Z`)
  return {
    db,
    date,
    now,
    scope,
    me: viewer.personId,
    viewer,
    holidays: holidayDates(db),
    horizon: addDays(date, opts.horizonDays ?? HORIZON_DAYS),
    name: (id) => {
      const p = getPerson(db, id)
      return p ? fullName(p) : 'Someone'
    },
    first: (id) => {
      const p = getPerson(db, id)
      return p ? firstName(p) : 'someone'
    },
  }
}

/**
 * 'Due Sun Nov 15, file by Fri Nov 13.' when a filing due on a weekend or holiday should go in earlier, plus
 * `extra`. Checklist tasks pass `by` from taskFileBy (agency filings only, never a day before the checklist
 * itself, so final pay on a Saturday last day stays on its date); other rows (compliance calendar filings)
 * use the plain filing rule.
 */
function dueNoteFor(ctx: Ctx, dueOn: ISODate | undefined, extra?: string, by?: ISODate | null): string | undefined {
  if (!dueOn) return extra
  const fileOn = by === undefined ? fileBy(dueOn, ctx.holidays) : by
  const parts = [fileOn ? `${dueLabel(dueOn, ctx.holidays, fileOn).replace(/^due/, 'Due')}.` : '', extra ?? ''].filter(Boolean)
  return parts.length ? parts.join(' ') : undefined
}

// ---------------------------------------------------------------------------------------------
// Source: checklist tasks (onboarding, offboarding, leave, change, new state)
// ---------------------------------------------------------------------------------------------

type TaskPhrase = { title: string; label?: string }

function taskPhrase(ctx: Ctx, checklist: Checklist, task: ChecklistTask, person: Person | undefined, youAreThePerson: boolean): TaskPhrase {
  const id = task.templateTaskId ?? ''
  const name = person ? fullName(person) : 'Someone'
  const first = person ? firstName(person) : 'Someone'
  const overdue = task.dueOn < ctx.date
  const day = dayText(task.dueOn)
  const incoming = !!person && person.startDate > ctx.date && checklist.kind === 'onboarding'
  const prestart = incoming && task.dueOn < checklist.anchorDate
  const starts = person ? `${first} starts ${dayText(person.startDate)}` : ''
  const your = youAreThePerson ? 'Your' : possessive(name)

  if (prestart) {
    const pre: Record<string, TaskPhrase> = {
      'on-laptop': { title: `${starts}: laptop not ordered yet`, label: 'Mark ordered' },
      'on-accounts': { title: `${starts}: accounts with MFA not set up yet`, label: 'Mark set up' },
      'on-welcome': { title: `${starts}: welcome email not sent yet`, label: 'Mark sent' },
      'on-piia': { title: `${starts}: PIIA not signed yet`, label: 'Mark signed' },
      'on-payroll-invite': { title: `${starts}: payroll invite not sent yet`, label: 'Mark sent' },
      'on-background-check': { title: `${starts}: background check not cleared yet`, label: 'Mark cleared' },
    }
    if (pre[id]) return pre[id]
    return { title: `${starts}: ${lowerFirst(task.title)}` }
  }
  switch (id) {
    case 'on-de34':
      return overdue
        ? { title: `DE 34 for ${name} was due ${day}: confirm your PEO filed it`, label: 'Mark filed' }
        : { title: `Confirm your PEO files DE 34 for ${name} by ${day}`, label: 'Mark filed' }
    case 'on-i9-section1':
      return { title: youAreThePerson ? 'Complete I-9 section 1 on your first day' : `I-9 section 1 for ${name}` }
    case 'on-i9-section2':
      return { title: `I-9 section 2 for ${name} (3 business days after the start)` }
    case 'on-security-training':
      return { title: `${your} security awareness training ${overdue ? 'was due' : 'is due'} ${day}` }
    case 'on-harassment-training':
    case 'on-harassment-training-short-term':
      return { title: `${your} harassment prevention training (1 hour) ${overdue ? 'was due' : 'is due'} ${day}` }
    case 'on-harassment-training-supervisor':
    case 'ch-supervisor-training': {
      const trainee = getPerson(ctx.db, traineeOf(checklist, task))
      const who = youAreThePerson || trainee?.id === ctx.me ? 'Your' : possessive(trainee ? fullName(trainee) : name)
      return { title: `${who} supervisor harassment prevention training (2 hours) ${overdue ? 'was due' : 'is due'} ${day}` }
    }
    case 'on-welcome':
      return { title: `Send ${name} the welcome email`, label: 'Mark sent' }
    case 'on-iipp-training':
      return { title: `Give ${name} the injury and illness prevention training` }
    case 'on-production-access':
      return { title: `Approve production access for ${name}`, label: 'Mark approved' }
    case 'on-equity-board':
      return { title: `Add ${possessive(name)} grant to the next board consent` }
    case 'on-checkin-30':
      return { title: `30-day check-in with ${name}` }
    case 'on-checkin-90':
      return { title: `90-day check-in with ${name}` }
    case 'on-emergency-contacts':
      return { title: youAreThePerson ? 'Add your emergency contacts' : `Emergency contacts for ${name}` }
    case 'on-ack-handbook':
      return { title: youAreThePerson ? 'Read and acknowledge the handbook' : `Handbook acknowledgement from ${name}`, label: youAreThePerson ? 'Acknowledge' : undefined }
    case 'on-ack-security':
      return { title: youAreThePerson ? 'Read and acknowledge the security policy' : `Security policy acknowledgement from ${name}`, label: youAreThePerson ? 'Acknowledge' : undefined }
    case 'off-equipment':
      return { title: `${possessive(name)} laptop is not back (left ${fmtShort(person?.endDate ?? checklist.anchorDate)})`, label: 'Mark returned' }
    case 'off-access':
      return { title: `Revoke every account for ${name}`, label: 'Mark revoked' }
    case 'lv-return':
      return { title: `Return-to-work check-in with ${name}` }
    case 'lv-coverage':
      return { title: `Agree a coverage plan for ${possessive(first)} time away` }
    case 'ch-payroll': {
      // Two changes for one person read differently: name what changed (never the amount, so the title
      // stays safe while screen sharing), from the job and pay row the checklist was made for.
      const what = person ? changeWords(ctx.db, person.id, checklist.anchorDate) : undefined
      return { title: what ? `Update payroll for ${name}: ${what}, effective ${fmtShort(checklist.anchorDate)}, by ${day}` : `Update payroll for ${possessive(name)} change by ${day}` }
    }
    case 'ch-wage-notice':
      return { title: `Give ${name} the Labor Code 2810.5 change notice` }
  }
  if (checklist.kind === 'leave' && ctx.scope !== 'admin') return { title: `${name}: leave checklist task` }
  if (youAreThePerson) return { title: task.title }
  return { title: `${name}: ${lowerFirst(task.title)}` }
}

/**
 * What a job or pay change on a date was, in words with no amounts: 'promotion to L4', 'manager change to
 * Tomas Herrera', 'merit raise'. Reads the person's job and pay row effective that day (the newest one).
 */
export function changeWords(db: DB, personId: ID, on: ISODate): string | undefined {
  const rec = db.comp.filter((r) => r.personId === personId && r.effectiveOn === on).pop()
  if (!rec) return undefined
  const manager = rec.managerId ? getPerson(db, rec.managerId) : undefined
  switch (rec.reason) {
    case 'promotion': {
      const level = db.levels.find((l) => l.id === rec.levelId)
      return `promotion to ${level?.code ?? rec.title}`
    }
    case 'manager_change':
      return manager ? `manager change to ${fullName(manager)}` : 'manager change'
    case 'merit':
      return 'merit raise'
    case 'market':
      return 'market adjustment'
    case 'title_only':
      return `title change to ${rec.title}`
    case 'transfer': {
      const dept = db.departments.find((d) => d.id === rec.departmentId)
      return dept ? `transfer to ${dept.name}` : 'transfer'
    }
    case 'correction':
      return 'pay record correction'
    case 'hire':
      return 'new hire'
  }
}

function taskItems(ctx: Ctx): InboxItem[] {
  const { db, date, scope, me, horizon } = ctx
  const week = addDays(date, WEEK_DAYS)
  const people = new Map(db.people.map((p) => [p.id, p]))
  const out: InboxItem[] = []
  // Viewer-owned tasks on someone else's checklist, keyed by checklist + due date, for grouping.
  const buckets = new Map<string, InboxItem[]>()

  for (const checklist of db.checklists) {
    const person = people.get(checklist.personId)
    for (const task of checklist.tasks) {
      if (task.status !== 'open') continue
      if (task.dueOn > horizon) continue
      // The leave designation notice has its own row with the leave case.
      if (task.templateTaskId === TASK_IDS.designation) continue
      if (person?.endDate && checklist.kind !== 'offboarding') {
        if (person.endDate < person.startDate) continue
        if (task.dueOn > person.endDate && !(TASK_IDS.survivesExit as readonly string[]).includes(task.templateTaskId ?? '')) continue
      }
      const ownerId = taskOwnerId(db, checklist, task)
      const adminTask = ownerId === null
      const mine = scope === 'admin' ? adminTask || ownerId === me : !adminTask && ownerId === me
      const training = taskTrainingKind(task)
      const trainee = training ? traineeOf(checklist, task) : undefined
      let include = false
      let waitingOn: 'you' | 'them' = 'you'
      if (mine) include = true
      else if (scope === 'admin') {
        // Others' tasks: overdue ones, and trainings due this week.
        include = task.dueOn < date || (!!training && task.dueOn <= week)
        waitingOn = 'them'
      } else if (scope === 'manager' && training && trainee && task.dueOn < date && isInReportingLine(ctx.viewer, db, trainee)) {
        include = true
        waitingOn = 'them'
      }
      if (!include) continue

      const youAreThePerson = checklist.personId === me && task.ownerRole === 'employee'
      const phrase = taskPhrase(ctx, checklist, task, person, youAreThePerson)
      const group = groupFor(task.dueOn, date)
      const ownerName = ownerId ? ctx.first(ownerId) : 'Admin'
      const doneOp: InboxAction = {
        kind: 'mutate',
        label: phrase.label ?? 'Mark done',
        op: { type: 'task_status', checklistId: checklist.id, taskId: task.id, status: 'done' },
        toast: `Marked done: ${task.title}${person ? ` for ${fullName(person)}` : ''}`,
      }
      let primary: InboxAction = doneOp
      const more: InboxAction[] = []
      // The welcome email task does what it says: copy the filled 'welcome' template, then mark it sent.
      const welcome = task.templateTaskId === 'on-welcome' && waitingOn === 'you' && person ? welcomeEmail(db, person.id, { senderId: me }) : null
      if (welcome && person) {
        primary = {
          kind: 'copy',
          label: 'Copy welcome email',
          text: `Subject: ${welcome.subject}\n\n${welcome.body}`,
          toast: `Copied the welcome email for ${fullName(person)}${welcome.to ? ` (send it to ${welcome.to})` : ''}`,
        }
        more.push(doneOp)
      } else if (task.templateTaskId === 'off-equipment' && person) {
        primary = {
          kind: 'copy',
          label: 'Copy reminder',
          text: reminderText(
            db,
            firstName(person),
            `Could you send back your ${db.company.name} laptop and any other equipment? Reply with a good address and we will send a prepaid box.`,
            me,
          ),
          toast: `Copied a laptop return reminder for ${fullName(person)}`,
        }
        more.push(doneOp)
      } else if (waitingOn === 'them' && scope === 'manager') {
        primary = {
          kind: 'copy',
          label: 'Copy reminder',
          text: reminderText(db, ctx.first(trainee ?? ownerId), `A reminder: ${lowerFirst(task.title)} was due ${dayText(task.dueOn)}.`, me, training && training !== 'security_awareness' ? `The free CRD course is here: ${CRD_COURSE_URL}` : undefined),
          toast: `Copied a reminder for ${ctx.name(trainee ?? ownerId)}`,
        }
      } else if (waitingOn === 'them') {
        more.push({
          kind: 'copy',
          label: 'Copy reminder',
          text: reminderText(db, ctx.first(ownerId ?? trainee), `A reminder: ${lowerFirst(task.title)}${person && person.id !== ownerId ? ` for ${fullName(person)}` : ''} is due ${dayText(task.dueOn)}.`, me),
          toast: `Copied a reminder for ${ctx.name(ownerId ?? trainee)}`,
        })
      }
      const canSeeChecklist = scope !== 'personal' || checklist.personId === me
      const item: InboxItem = {
        key: `task:${checklist.id}:${task.id}`,
        kind: 'task',
        title: phrase.title,
        detail: task.why && (scope === 'admin' || checklist.kind !== 'leave') ? task.why : undefined,
        dueOn: task.dueOn,
        dueNote: dueNoteFor(ctx, task.dueOn, task.dueRuleText ? `${task.dueRuleText}.` : undefined, taskFileBy(task, checklist, ctx.holidays)),
        group,
        statutory: task.statutory,
        waitingOn,
        waitingOnName: waitingOn === 'them' ? ownerName : undefined,
        ownerId: ownerId ?? undefined,
        href: canSeeChecklist ? links.checklist(checklist.id) : links.me('tasks'),
        primary,
        more: more.length ? more : undefined,
        notApplicable: waitingOn === 'you' || scope === 'admin' ? { op: 'task', checklistId: checklist.id, taskId: task.id } : undefined,
        minutes: waitingOn === 'them' ? 1 : task.statutory ? 3 : 2,
        citation: task.citation,
        refs: { personId: checklist.personId, checklistId: checklist.id, taskId: task.id, ...(training ? { trainingKind: training } : {}) },
      }
      if (training && trainee) item.refs.personId = trainee
      // Viewer-owned work on someone else's checklist may be grouped by day (a first-day notices packet).
      if (waitingOn === 'you' && checklist.personId !== me && task.templateTaskId !== 'off-equipment' && !welcome) {
        const k = `${checklist.id}|${task.dueOn}`
        const list = buckets.get(k) ?? []
        list.push(item)
        buckets.set(k, list)
      } else out.push(item)
    }
  }

  for (const [k, list] of buckets) {
    if (list.length < 3) {
      out.push(...list)
      continue
    }
    const [checklistId, dueOn] = k.split('|')
    const checklist = db.checklists.find((c) => c.id === checklistId) as Checklist
    const person = people.get(checklist.personId)
    const name = person ? fullName(person) : 'Someone'
    const firstDay = checklist.kind === 'onboarding' && dueOn === checklist.anchorDate
    const statutory = list.some((i) => i.statutory)
    const grouped = list.map((i) => checklist.tasks.find((t) => t.id === i.refs.taskId))
    const tasks = list.map((i, n) => grouped[n]?.title ?? i.title)
    // The tasks share a due date: an earlier day to file by shows only when one of them is an agency filing.
    const by = grouped.map((t) => (t ? taskFileBy(t, checklist, ctx.holidays) : null)).find(Boolean) ?? null
    out.push({
      key: `tasks:${checklistId}:${dueOn}`,
      kind: 'task_group',
      title: firstDay
        ? `${possessive(name)} first day, ${dayText(dueOn)}: ${list.length} notices and tasks`
        : `${name}: ${list.length} tasks due ${dayText(dueOn)}`,
      detail: `${listJoin(tasks.slice(0, 4))}${tasks.length > 4 ? `, and ${tasks.length - 4} more` : ''}.`,
      dueOn,
      dueNote: dueNoteFor(ctx, dueOn, undefined, by),
      group: groupFor(dueOn, date),
      statutory,
      waitingOn: 'you',
      href: links.checklist(checklistId),
      primary: { kind: 'navigate', label: 'Open checklist', href: links.checklist(checklistId) },
      minutes: Math.min(15, list.length * 2),
      refs: { personId: checklist.personId, checklistId },
    })
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Source: hiring (scorecards, candidates needing attention, offers)
// ---------------------------------------------------------------------------------------------

function scorecardItems(ctx: Ctx): InboxItem[] {
  const { db, me, date } = ctx
  const out: InboxItem[] = []
  if (me) {
    for (const s of scorecardsOwed(db, me, ctx.now)) {
      const app = db.applications.find((a) => a.id === s.scorecard.applicationId)
      const cand = app ? candidateName(db, app.candidateId) : 'a candidate'
      const held = pacificDateOf(s.interview.startsAt)
      const dueOn = pacificDateOf(s.scorecard.dueAt)
      out.push({
        key: `scorecard:${s.scorecard.id}`,
        kind: 'scorecard',
        title: `Scorecard owed: your ${lowerFirst(s.interview.name)} with ${cand} (${dayText(held)})`,
        detail: 'Scorecards are due 24 hours after the interview. Other scorecards stay hidden until yours is in.',
        dueOn,
        group: s.overdue ? 'overdue' : groupFor(dueOn, date),
        statutory: false,
        waitingOn: 'you',
        href: app ? links.candidate(app.candidateId) : links.hiring(),
        // Opens the scorecard sheet on the spot: Fill, a tap per attribute, Submit.
        primary: { kind: 'sheet', label: 'Fill scorecard', sheet: 'scorecard', id: s.scorecard.id },
        more: app ? [{ kind: 'navigate', label: 'Open the candidate', href: links.candidate(app.candidateId) }] : undefined,
        minutes: 3,
        refs: { candidateId: app?.candidateId, applicationId: app?.id, jobId: app?.jobId },
      })
    }
  }
  if (ctx.scope === 'admin') {
    const others = allScorecardsOwed(db, ctx.now).filter((s) => s.overdue && s.scorecard.interviewerId !== me)
    if (others.length) {
      const byPerson = new Map<ID, number>()
      for (const s of others) byPerson.set(s.scorecard.interviewerId, (byPerson.get(s.scorecard.interviewerId) ?? 0) + 1)
      const names = [...byPerson.entries()].map(([id, n]) => `${ctx.name(id)}${n > 1 ? ` (${n})` : ''}`)
      const lines = others.map((s) => {
        const app = db.applications.find((a) => a.id === s.scorecard.applicationId)
        return `${ctx.first(s.scorecard.interviewerId)}: ${s.interview.name} with ${app ? candidateName(db, app.candidateId) : 'a candidate'} (${dayText(pacificDateOf(s.interview.startsAt))})`
      })
      const earliest = others.map((s) => pacificDateOf(s.scorecard.dueAt)).sort()[0]
      out.push({
        key: `scorecards-team:${others.map((s) => s.scorecard.id).sort().join(',')}`,
        kind: 'scorecards_team',
        title: `${plural(others.length, 'scorecard')} overdue from the team: ${listJoin(names)}`,
        detail: 'Debriefs wait until every interviewer has scored.',
        dueOn: earliest,
        group: 'overdue',
        statutory: false,
        waitingOn: 'them',
        waitingOnName: byPerson.size === 1 ? ctx.first([...byPerson.keys()][0]) : 'interviewers',
        href: links.hiring('candidates'),
        primary: {
          kind: 'copy',
          label: 'Copy nudge',
          text: ['Hi all,', '', 'A quick nudge on scorecards still open:', ...lines.map((l) => `- ${l}`), '', 'Each one takes under a minute. Thanks!'].join('\n'),
          toast: `Copied a nudge for ${plural(others.length, 'overdue scorecard')}`,
        },
        minutes: 1,
        refs: {},
      })
    }
  }
  return out
}

const REASON_ORDER: AttentionReason[] = ['past_sla', 'no_next_step', 'next_step_overdue', 'waiting_too_long']
const REASON_WORDS: Record<AttentionReason, string> = {
  past_sla: 'past SLA',
  no_next_step: 'with no next step',
  next_step_overdue: 'with an overdue next step',
  waiting_too_long: 'waiting to hear back',
}

/** 'Senior full-stack engineer: 3 candidates past SLA in Intro call' for one job's stuck candidates. */
export function candidatesTitle(jobTitle: string, rows: Array<{ reasons: AttentionReason[]; stageName: string }>): string {
  const n = rows.length
  const main = REASON_ORDER.find((r) => rows.every((x) => x.reasons.includes(r)))
  const stages = [...new Set(rows.map((r) => r.stageName))]
  const inStage = stages.length === 1 ? ` in ${stages[0]}` : ''
  if (main) return `${jobTitle}: ${plural(n, 'candidate')} ${REASON_WORDS[main]}${inStage}`
  return `${jobTitle}: ${plural(n, 'candidate')} need${n === 1 ? 's' : ''} a next step${inStage}`
}

function candidateItems(ctx: Ctx): InboxItem[] {
  const { db, date, scope, me } = ctx
  if (scope === 'personal') return []
  const out: InboxItem[] = []
  for (const job of db.jobs) {
    if (job.status !== 'open' && job.status !== 'on_hold') continue
    const managed = job.hiringManagerId === me
    if (scope === 'manager' && !managed) continue
    const rows: Array<{ appId: ID; reasons: AttentionReason[]; stageName: string; due?: ISODate }> = []
    for (const app of db.applications) {
      if (app.jobId !== job.id) continue
      const reasons = attentionReasons(db, app, date)
      if (!reasons.length) continue
      rows.push({ appId: app.id, reasons, stageName: stageById(job, app.stageId)?.name ?? 'the pipeline', due: app.nextStep?.dueOn })
    }
    if (!rows.length) continue
    const hm = getPerson(db, job.hiringManagerId)
    const hmHere = !!hm && isEmployedOn(hm, date)
    const waitingOn: 'you' | 'them' = scope === 'manager' || managed || !hmHere ? 'you' : 'them'
    const late = rows.some((r) => r.reasons.includes('past_sla') || r.reasons.includes('next_step_overdue'))
    const counts = REASON_ORDER.map((r) => [r, rows.filter((x) => x.reasons.includes(r)).length] as const).filter(([, n]) => n > 0)
    const dueOn = late ? rows.map((r) => r.due).filter((d): d is ISODate => !!d && d < date).sort()[0] : undefined
    out.push({
      key: `candidates:${job.id}`,
      kind: 'candidates',
      title: candidatesTitle(job.title, rows),
      detail: `${counts.map(([r, n]) => `${n} ${REASON_WORDS[r]}`).join(', ')}. Sweep shows one candidate at a time, about 30 seconds each.`,
      dueOn,
      group: late ? 'overdue' : 'this_week',
      statutory: false,
      waitingOn,
      waitingOnName: waitingOn === 'them' && hm ? firstName(hm) : undefined,
      ownerId: job.hiringManagerId,
      href: links.job(job.id),
      primary: { kind: 'navigate', label: `Sweep ${rows.length}`, href: links.job(job.id, 'sweep') },
      minutes: Math.max(1, Math.round(rows.length * 0.5)),
      refs: { jobId: job.id },
    })
  }
  return out
}

function offerItems(ctx: Ctx): InboxItem[] {
  const { db, date, scope, me } = ctx
  if (scope === 'personal') return []
  const out: InboxItem[] = []
  const holidays = dbHolidays(db)
  for (const offer of db.offers) {
    const job = db.jobs.find((j) => j.id === offer.jobId)
    const cand = candidateName(db, offer.candidateId)
    const managed = !!job && job.hiringManagerId === me
    if (offer.status === 'awaiting_approval') {
      if (scope === 'admin') {
        out.push({
          key: `offer-approval:${offer.id}:v${offer.version}`,
          kind: 'offer_approval',
          title: `Approve the offer for ${cand} (${offer.title})${offer.draftedById ? `, drafted by ${ctx.name(offer.draftedById)}` : ''}`,
          detail: 'Approving lets the hiring manager send it. Review the band position and any exception first.',
          group: 'this_week',
          statutory: false,
          waitingOn: 'you',
          href: links.candidate(offer.candidateId),
          primary: { kind: 'mutate', label: 'Approve', op: { type: 'approve_offer', offerId: offer.id }, toast: `Approved the offer for ${cand}` },
          more: [{ kind: 'navigate', label: 'Review the offer', href: links.candidate(offer.candidateId) }],
          minutes: 3,
          refs: { offerId: offer.id, candidateId: offer.candidateId, applicationId: offer.applicationId, jobId: offer.jobId },
        })
      } else if (offer.draftedById === me) {
        out.push({
          key: `offer-waiting:${offer.id}:v${offer.version}`,
          kind: 'offer_waiting',
          title: `Your offer for ${cand} is waiting for Admin approval`,
          group: 'this_week',
          statutory: false,
          waitingOn: 'them',
          waitingOnName: 'Admin',
          href: links.candidate(offer.candidateId),
          primary: { kind: 'navigate', label: 'Open offer', href: links.candidate(offer.candidateId) },
          minutes: 0,
          refs: { offerId: offer.id, candidateId: offer.candidateId, jobId: offer.jobId },
        })
      }
      continue
    }
    // Admin's answer comes back to the people who send the offer: the drafter and the hiring manager.
    const sender = offer.draftedById === me || managed
    const last = offer.approvals[offer.approvals.length - 1]
    if (offer.status === 'draft' && last?.decision === 'changes_requested') {
      if (!sender || last.approverId === me) continue
      const by = getPerson(db, last.approverId) ? ctx.name(last.approverId) : 'Admin'
      const note = (last.note ?? '').replace(/\s+/g, ' ').trim().replace(/[.!\s]+$/, '')
      out.push({
        key: `offer-changes:${offer.id}:${last.at}`,
        kind: 'offer_changes',
        title: `${by} asked for changes to the offer for ${cand}${note ? `: ${note}` : ''}`,
        detail: 'Edit the offer on the candidate page, then submit it for approval again.',
        group: 'this_week',
        statutory: false,
        waitingOn: 'you',
        href: links.candidate(offer.candidateId),
        primary: { kind: 'navigate', label: 'Open offer', href: links.candidate(offer.candidateId) },
        minutes: 5,
        refs: { offerId: offer.id, candidateId: offer.candidateId, applicationId: offer.applicationId, jobId: offer.jobId },
      })
      continue
    }
    // A draft that needs no approval (an Admin drafted it) is ready to go out as soon as it is saved.
    if (offer.status === 'draft') {
      if (!sender || approvalRequired(db, offer)) continue
      const by = offer.draftedById === me ? 'You' : offer.draftedById && getPerson(db, offer.draftedById) ? ctx.name(offer.draftedById) : 'Admin'
      out.push({
        key: `offer-send:${offer.id}:v${offer.version}`,
        kind: 'offer_send',
        title: `Send the offer to ${cand} (${offer.title})`,
        detail: `${by} drafted it ${dayText(offer.createdOn)}. Generate the letter, send it, then mark it sent on the candidate page.`,
        group: 'this_week',
        statutory: false,
        waitingOn: 'you',
        href: links.candidate(offer.candidateId),
        primary: { kind: 'navigate', label: 'Open offer', href: links.candidate(offer.candidateId) },
        minutes: 5,
        refs: { offerId: offer.id, candidateId: offer.candidateId, applicationId: offer.applicationId, jobId: offer.jobId },
      })
      continue
    }
    if (offer.status === 'approved') {
      if (!sender) continue
      const approval = [...offer.approvals].reverse().find((a) => a.decision === 'approved')
      const by = approval && getPerson(db, approval.approverId) ? ctx.name(approval.approverId) : 'Admin'
      out.push({
        key: `offer-approved:${offer.id}:v${offer.version}`,
        kind: 'offer_send',
        title: `Send the approved offer to ${cand} (${offer.title})`,
        detail: `${by} approved it${approval ? ` ${dayText(approval.at)}` : ''}. Generate the letter, send it to ${cand}, then mark it sent on the candidate page.`,
        group: 'this_week',
        statutory: false,
        waitingOn: 'you',
        href: links.candidate(offer.candidateId),
        primary: { kind: 'navigate', label: 'Open offer', href: links.candidate(offer.candidateId) },
        minutes: 5,
        refs: { offerId: offer.id, candidateId: offer.candidateId, applicationId: offer.applicationId, jobId: offer.jobId },
      })
      continue
    }
    // An expired offer (closed at load, or still 'sent' past its date) waits on you to extend it or close
    // it out, while the application is still open; a nudge would quote a date that has passed.
    const expired = offer.status === 'expired' || (offer.status === 'sent' && !!offer.expiresOn && offer.expiresOn < date)
    if (offer.status !== 'sent' && !expired) continue
    if (scope === 'manager' && !managed) continue
    const newExpiry = addBusinessDays(offer.expiresOn < date ? date : offer.expiresOn, 3, holidays)
    const extend: InboxAction = {
      kind: 'mutate',
      label: 'Extend 3 days',
      op: { type: 'extend_offer', offerId: offer.id, businessDays: 3 },
      toast: `Extended the offer for ${cand} to ${dayText(newExpiry)}`,
    }
    const open: InboxAction = { kind: 'navigate', label: 'Open offer', href: links.candidate(offer.candidateId) }
    const refs = { offerId: offer.id, candidateId: offer.candidateId, applicationId: offer.applicationId, jobId: offer.jobId }
    if (expired) {
      if (offer.status === 'expired' && db.applications.find((a) => a.id === offer.applicationId)?.status !== 'active') continue
      out.push({
        key: `offer-expired:${offer.id}:${offer.expiresOn}`,
        kind: 'offer_expiring',
        title: `${possessive(cand)} offer expired ${dayText(offer.expiresOn)}`,
        detail: 'Extend it to reopen, or record that they declined.',
        dueOn: offer.expiresOn,
        group: groupFor(offer.expiresOn, date),
        statutory: false,
        waitingOn: 'you',
        href: links.candidate(offer.candidateId),
        primary: extend,
        more: [open],
        minutes: 2,
        refs,
      })
      continue
    }
    const left = businessDaysBetween(date, offer.expiresOn, holidays)
    if (left > OFFER_EXPIRY_BUSINESS_DAYS) continue
    const nudge = offerNudgeMessage(db, offer.id, { senderId: me ?? undefined })
    const candFirst = db.candidates.find((c) => c.id === offer.candidateId)?.firstName ?? 'the candidate'
    out.push({
      key: `offer-expiring:${offer.id}:${offer.expiresOn}`,
      kind: 'offer_expiring',
      title: `${possessive(cand)} offer expires ${dayText(offer.expiresOn)}`,
      detail: 'A short, warm check-in usually helps. Offer to walk through the equity.',
      dueOn: offer.expiresOn,
      group: groupFor(offer.expiresOn, date),
      statutory: false,
      waitingOn: 'them',
      waitingOnName: candFirst,
      href: links.candidate(offer.candidateId),
      primary: nudge ? { kind: 'copy', label: 'Copy nudge', text: `Subject: ${nudge.subject}\n\n${nudge.body}`, toast: `Copied an offer nudge for ${cand}` } : open,
      more: [extend],
      minutes: 2,
      refs,
    })
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Source: job requests (requisitions) from hiring managers
// ---------------------------------------------------------------------------------------------

/**
 * Admin: one approval per pending job request, Approve as the one inline action (it adds a plan line).
 * Manager: their own pending requests, waiting on Admin. Never a cost (the request stores none).
 */
function requisitionItems(ctx: Ctx): InboxItem[] {
  const { db, scope, me } = ctx
  if (scope === 'personal') return []
  const out: InboxItem[] = []
  for (const job of pendingRequisitions(db)) {
    const req = job.requisition
    if (!req) continue
    const level = db.levels.find((l) => l.id === job.levelId)
    const what = `${job.title}${level ? ` (${level.code})` : ''}, ${fmtQuarter(req.quarter)}`
    const why = req.reason.replace(/[.!?\s]+$/, '')
    if (scope === 'admin') {
      out.push({
        key: `requisition:${job.id}`,
        kind: 'requisition',
        title: `Approve the job request: ${what}, from ${ctx.name(req.requestedById)}`,
        detail: `${why ? `Why: ${why}. ` : ''}Approving adds it to the headcount plan. You post it from the job.`,
        group: 'this_week',
        statutory: false,
        waitingOn: 'you',
        href: links.job(job.id),
        primary: { kind: 'mutate', label: 'Approve', op: { type: 'approve_requisition', jobId: job.id }, toast: `Approved the ${job.title} job request` },
        more: [
          { kind: 'navigate', label: 'Review the job', href: links.job(job.id) },
          { kind: 'mutate', label: 'Decline', op: { type: 'decline_requisition', jobId: job.id }, toast: `Declined the ${job.title} job request` },
        ],
        minutes: 2,
        refs: { jobId: job.id, personId: req.requestedById },
      })
    } else if (req.requestedById === me) {
      out.push({
        key: `requisition-waiting:${job.id}`,
        kind: 'requisition_waiting',
        title: `Your job request for ${what} is waiting for Admin approval`,
        group: 'this_week',
        statutory: false,
        waitingOn: 'them',
        waitingOnName: 'Admin',
        href: links.job(job.id),
        primary: { kind: 'navigate', label: 'Open job', href: links.job(job.id) },
        minutes: 0,
        refs: { jobId: job.id },
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Source: time off approvals and leave notices
// ---------------------------------------------------------------------------------------------

function timeOffItems(ctx: Ctx): InboxItem[] {
  const { db, date, scope, me, viewer } = ctx
  if (scope === 'personal') return []
  const out: InboxItem[] = []
  for (const r of pendingApprovals(db)) {
    if (!canApproveTimeOff(viewer, db, r)) continue
    const person = getPerson(db, r.personId)
    if (!person) continue
    const manager = getPerson(db, person.managerId)
    const managerHere = !!manager && isEmployedOn(manager, date)
    const policy = db.timeOffPolicies.find((p) => p.id === r.policyId)
    // A pending request on an auto-approved policy (sick leave held before the 90-day wait) is Admin's
    // to decide (canApproveTimeOff), so it never waits on the manager.
    const adminOnly = !!policy?.autoApprove
    let waitingOn: 'you' | 'them' = 'you'
    if (scope === 'admin' && managerHere && manager.id !== me && !adminOnly) {
      // Another manager approves; Admin sees it only when it starts within a week.
      if (r.startDate > addDays(date, WEEK_DAYS)) continue
      waitingOn = 'them'
    }
    const showType = !!policy && canSeeTimeOffDetail(viewer, db, r) && (scope === 'admin' || !isConfidentialKind(policy.kind))
    const started = r.startDate < date
    // Sick leave held before the service wait: the same choice as the Time off tab, never a plain Approve that
    // silently pays it as sick leave.
    const wait = adminOnly ? serviceWait(db, r) : null
    const who = possessive(fullName(person))
    const range = rangeText(r.startDate, r.endDate)
    const detail = [showType ? policy?.name : 'Time off', hoursLabel(r.hours, person.hoursPerWeek / 5 || 8)].filter(Boolean).join(', ')
    const waitText = wait ? `Starts before ${showType && policy ? policy.name.toLowerCase() : 'it'} is usable (${dayText(wait.usableFrom)}, the ${wait.days}-day wait).` : ''
    out.push({
      key: `timeoff:${r.id}`,
      kind: 'timeoff',
      title: `${fullName(person)} requested ${range} off`,
      detail: wait ? `${detail}. ${waitText} Waive the wait to pay it as sick leave, or record it as unpaid.` : detail,
      chip: started ? `Started ${dayText(r.startDate)}` : `Starts ${dayText(r.startDate)}`,
      group: started ? 'overdue' : 'this_week',
      statutory: false,
      waitingOn,
      waitingOnName: waitingOn === 'them' ? manager?.firstName : undefined,
      href: links.people('timeoff'),
      primary: wait
        ? { kind: 'mutate', label: 'Waive the wait', op: { type: 'approve_timeoff', requestId: r.id }, toast: `Waived the wait and approved ${who} time off, ${range}` }
        : { kind: 'mutate', label: 'Approve', op: { type: 'approve_timeoff', requestId: r.id }, toast: `Approved ${who} time off, ${range}` },
      more: [
        ...(wait
          ? [{ kind: 'mutate' as const, label: 'Record as unpaid', op: { type: 'approve_timeoff_unpaid' as const, requestId: r.id }, toast: `Recorded ${who} time off as unpaid, ${range}` }]
          : []),
        { kind: 'navigate', label: 'Open in Time off', href: links.people('timeoff') },
      ],
      minutes: 1,
      refs: { requestId: r.id, personId: r.personId },
    })
  }
  return out
}

const LEAVE_WORDS: Record<LeaveCase['kind'], string> = {
  cfra: 'CFRA',
  pdl: 'pregnancy disability',
  bonding: 'CFRA bonding',
  military: 'military',
  other: '',
}

function leaveNoticeItems(ctx: Ctx): InboxItem[] {
  const { db, date } = ctx
  if (ctx.scope !== 'admin') return []
  const out: InboxItem[] = []
  const citation = RULE_BY_ID['cfra-pdl']?.citation
  for (const l of db.leaveCases) {
    if (!l.designationNoticeDueOn || l.designationNoticeSentOn || l.endedOn || l.returnedOn) continue
    if (l.designationNoticeDueOn > addDays(date, HORIZON_DAYS)) continue
    const person = getPerson(db, l.personId)
    const who = person ? possessive(firstName(person)) : 'A'
    const kind = LEAVE_WORDS[l.kind]
    const overdue = l.designationNoticeDueOn < date
    out.push({
      key: `leave-notice:${l.id}`,
      kind: 'leave_notice',
      title: `${who} ${kind ? `${kind} ` : 'leave '}designation notice ${overdue ? 'was due' : 'is due'} ${dayText(l.designationNoticeDueOn)}`,
      detail: `Requested ${dayText(l.requestedOn)} for leave starting ${dayText(l.startDate)}. Send the response and designation notice, then record it.`,
      dueOn: l.designationNoticeDueOn,
      dueNote: 'This app sets 5 business days from the request; confirm the exact CFRA timing with counsel.',
      group: groupFor(l.designationNoticeDueOn, date),
      // A company target, not a statutory deadline (ARCHITECTURE.md, Legal rules by work state).
      statutory: false,
      waitingOn: 'you',
      href: person ? links.person(person.id, 'timeoff') : links.people('timeoff'),
      primary: { kind: 'mutate', label: 'Mark sent', op: { type: 'leave_notice_sent', leaveCaseId: l.id }, toast: `Recorded the designation notice as sent${person ? ` to ${fullName(person)}` : ''}` },
      minutes: 5,
      citation,
      refs: { leaveCaseId: l.id, personId: l.personId },
    })
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Source: equity, contractors, compliance rules and calendar (Admin)
// ---------------------------------------------------------------------------------------------

function grantItems(ctx: Ctx): InboxItem[] {
  const { db, date } = ctx
  if (ctx.scope !== 'admin') return []
  const queue = boardConsentQueue(db)
  if (!queue.length) return []
  const ids = queue.map((g) => g.id)
  const names = queue.map((g) => {
    const p = getPerson(db, g.personId)
    if (p) return firstName(p)
    const c = db.contractors.find((x) => x.id === g.personId)
    return c?.name ?? 'someone'
  })
  return [
    {
      key: `grants:${[...ids].sort().join(',')}`,
      kind: 'grants',
      title: `${plural(queue.length, 'grant')} awaiting board consent (${listJoin(names)})`,
      detail: 'Copy the consent table for counsel or your cap table tool, then mark the grants approved with the board date.',
      group: 'this_week',
      statutory: false,
      waitingOn: 'you',
      href: links.comp('equity'),
      primary: { kind: 'copy', label: 'Copy consent table', text: consentTableText(db, ids, date), toast: `Copied the consent table for ${plural(queue.length, 'grant')}` },
      more: [{ kind: 'navigate', label: 'Open the board consent queue', href: links.comp('equity') }],
      minutes: 3,
      refs: { grantIds: ids },
    },
  ]
}

function ab5Items(ctx: Ctx): InboxItem[] {
  const { db, date } = ctx
  if (ctx.scope !== 'admin') return []
  const out: InboxItem[] = []
  for (const c of db.contractors) {
    if (c.kind !== 'contractor' || c.startOn > date || (c.endOn && c.endOn < date)) continue
    // Converted to an employee: the AB5 risk is settled (the employee record carries the rest).
    if (c.convertedToPersonId && db.people.some((p) => p.id === c.convertedToPersonId)) continue
    const result = ab5Result(c)
    if (result === 'likely_ok') continue
    const failed = (['a', 'b', 'c'] as const).filter((k) => c.ab5[k] === false).map((k) => AB5_PRONGS[k])
    const open = (['a', 'b', 'c'] as const).filter((k) => c.ab5[k] === null).map((k) => AB5_PRONGS[k])
    const label = c.entityName && c.entityType !== 'individual' ? c.entityName : c.name
    out.push({
      key: `ab5:${c.id}:${result}`,
      kind: 'ab5',
      title: result === 'likely_employee' ? `${label} (contractor) is likely an employee under AB5` : `Finish the AB5 check for ${label} (contractor)`,
      detail:
        result === 'likely_employee'
          ? `Fails prong ${listJoin(failed)}. Convert to an employee or restructure the work, and ask counsel.`
          : `Still to answer: prong ${listJoin(open)}.`,
      group: 'this_week',
      statutory: false,
      waitingOn: 'you',
      href: links.contractor(c.id),
      primary: { kind: 'navigate', label: result === 'likely_employee' ? 'Review and convert' : 'Finish the check', href: links.contractor(c.id) },
      minutes: 5,
      citation: AB5_CITATION,
      refs: { contractorId: c.id },
    })
  }
  return out
}

/** Rules covered by the First hire kit (Home shows them there while headcount is 1; see firstHireKitShown). */
export const KIT_RULE_IDS = ['edd-registration', 'workers-comp', 'iipp', 'paid-sick-leave', 'posters-federal', 'posters-california', 'posters-san-jose']

function ruleOpenActions(r: RuleResult) {
  const yearly = new Set(r.rule.cycle?.actionIds ?? [])
  return r.openActions.filter((a) => !yearly.has(a.id))
}

/** Rules that apply from the first employee (or always): steps to set up once, not a crossing that came due. */
function isBaselineRule(r: RuleResult): boolean {
  const t = r.rule.trigger
  return t.kind === 'always' || (t.kind === 'headcount' && t.method !== 'weeks_20' && t.n <= 1)
}

/**
 * One rule's next open step. `setup`: a step to set up once whose deadlines live elsewhere (the per-person
 * checklist tasks under the DE 34, I-9, SB 294 and 2810.5 rules), so it carries no date and is not a legal deadline.
 */
function ruleItem(ctx: Ctx, r: RuleResult, setup = false): InboxItem {
  const open = ruleOpenActions(r)
  const next = open[0]
  const t = r.rule.trigger
  // A clock that rests on an estimate (EDD DE 1 with no first payroll date saved) is never a red legal
  // deadline: while its first step (the one the clock is for) is open, the step is to add the real date,
  // and the estimate reads 'about'; later steps carry no date at all.
  if (r.dueEstimated && r.dueOn && next.id === r.rule.actions[0]?.id) return estimatedRuleItem(ctx, r, r.dueOn)
  const threshold = t.kind === 'site' || (t.kind === 'headcount' && t.method !== 'weeks_20' && t.n > 1)
  const dueOn = setup ? undefined : ((r.dueEstimated ? undefined : r.dueOn) ?? (threshold ? r.firstAppliedOn : undefined))
  // A threshold rule that applies now is already owed, even when the crossing date cannot be dated.
  const group: InboxGroup = dueOn ? groupFor(dueOn, ctx.date) : threshold ? 'overdue' : 'this_week'
  // SB 553 says what is missing while there is no plan; once it is written, the row names the next step.
  const noPlan = r.rule.id === 'wvpp' && open.some((a) => a.id === 'write-plan')
  const title = noPlan
    ? `${r.count} people are at the office at once on busy days, so a workplace violence prevention plan applies: none on file`
    : `${r.rule.title}: ${lowerFirst(next.title)}`
  return {
    key: `rule:${r.rule.id}:${next.id}`,
    kind: 'rule',
    title,
    detail: `${noPlan ? `Next: ${next.title}. ` : ''}${open.length > 1 ? `${plural(open.length - 1, 'more step')} after this. ` : ''}${r.rule.summary} ${NOT_LEGAL_ADVICE}`,
    dueOn,
    // An agency filing due on a weekend or holiday (the DE 1) gets its file-by day, as the DE 34 task does.
    dueNote:
      dueOn && r.fileBy && dueOn === r.dueOn
        ? dueNoteFor(ctx, dueOn, undefined, r.fileBy)
        : dueOn && r.firstAppliedOn && dueOn === r.firstAppliedOn
          ? `This has applied since ${fmtDate(r.firstAppliedOn)}.`
          : undefined,
    chip: !dueOn && threshold ? 'Applies now' : undefined,
    group,
    statutory: !setup && r.rule.statutory && !r.dueEstimated,
    waitingOn: 'you',
    href: links.rule(r.rule.id),
    primary: stepDone(ctx, r, next),
    more: [{ kind: 'navigate', label: 'Open the rule', href: links.rule(r.rule.id) }],
    notApplicable: { op: 'rule', ruleId: r.rule.id },
    minutes: 5,
    citation: r.rule.citation,
    externalLink: next.link ? { label: 'Official page', url: next.link } : undefined,
    refs: { ruleId: r.rule.id },
  }
}

/** 'Mark step done' for a rule step. SB 553 'Train everyone' also records training, so its toast says for how many. */
function stepDone(ctx: Ctx, r: RuleResult, step: { id: string; title: string }): InboxAction {
  const trained = trainingsRecordedBy(ctx.db, r.rule.id, step.id, ctx.date)
  return {
    kind: 'mutate',
    label: 'Mark step done',
    op: { type: 'rule_action_done', ruleId: r.rule.id, actionId: step.id },
    toast: trained ? `Recorded WVPP training for ${plural(trained, 'person', 'people')} today` : `Done: ${step.title}`,
  }
}

/** A rule whose due date is an estimate: ask for the date that makes it exact, without a red deadline. */
function estimatedRuleItem(ctx: Ctx, r: RuleResult, about: ISODate): InboxItem {
  const next = ruleOpenActions(r)[0]
  return {
    key: `rule:${r.rule.id}:estimated`,
    kind: 'rule',
    title: `${r.rule.title}: add your first payroll date in Settings, Company`,
    detail: `Due about ${dayText(about)}, ${r.rule.dueDaysAfterTrigger ?? 15} days after the first payroll. ${r.howCounted} Then ${lowerFirst(next.title)}. ${NOT_LEGAL_ADVICE}`,
    chip: `About ${fmtShort(about)}`,
    // Never overdue on an estimate; it waits with this week's work until the date is in.
    group: about < ctx.date ? 'this_week' : groupFor(about, ctx.date),
    statutory: false,
    waitingOn: 'you',
    href: links.rule(r.rule.id),
    primary: { kind: 'navigate', label: 'Add the date', href: links.settings('company') },
    more: [stepDone(ctx, r, next), { kind: 'navigate', label: 'Open the rule', href: links.rule(r.rule.id) }],
    notApplicable: { op: 'rule', ruleId: r.rule.id },
    minutes: 2,
    citation: r.rule.citation,
    externalLink: next.link ? { label: 'Official page', url: next.link } : undefined,
    refs: { ruleId: r.rule.id },
  }
}

function ruleItems(ctx: Ctx, kitShown: boolean): InboxItem[] {
  const { db, date } = ctx
  if (ctx.scope !== 'admin') return []
  const results = evaluateAll(db, date)
  const out: InboxItem[] = []
  const baseline: RuleResult[] = []
  let inKit = 0
  for (const r of results) {
    if (r.state !== 'applies' || r.rule.upcoming) continue
    if (!ruleOpenActions(r).length) continue
    // The First hire kit on Home lists these while headcount is 1, so they are not repeated here.
    if (kitShown && KIT_RULE_IDS.includes(r.rule.id)) {
      inKit += 1
      continue
    }
    // The DE 34, I-9, SB 294 and 2810.5 deadlines are each hire's checklist tasks, which have rows of their
    // own: the rule's company steps wait with the set-up steps, undated, unless the rule has a deadline of
    // its own (one recorded on the card, or a clock for a hire with no such task).
    if (hasPerPersonTasks(r.rule.id)) {
      const own = ruleDeadlineBesideTasks(db, r)
      if (own) out.push(ruleItem(ctx, own === r.dueOn ? r : { ...r, dueOn: own, fileBy: undefined }))
      else baseline.push(r)
    } else if (isBaselineRule(r) && !r.dueOn) baseline.push(r)
    else out.push(ruleItem(ctx, r))
  }
  if (baseline.length <= 2) out.push(...baseline.map((r) => ruleItem(ctx, r, hasPerPersonTasks(r.rule.id))))
  else {
    out.push({
      key: `rules-baseline:${baseline.map((r) => r.rule.id).sort().join(',')}`,
      kind: 'rules_group',
      // The kit's rules are left out of this count, so say so: Compliance lists them all.
      title: `${plural(baseline.length, inKit ? 'more rule' : 'rule', inKit ? 'more rules' : 'rules')} that apply at any size ${baseline.length === 1 ? 'has' : 'have'} open steps`,
      detail: `${inKit ? `Besides the ${inKit} in the First hire kit. ` : ''}${listJoin(baseline.slice(0, 4).map((r) => r.rule.title))}${baseline.length > 4 ? `, and ${baseline.length - 4} more` : ''}. ${NOT_LEGAL_ADVICE}`,
      group: 'this_week',
      statutory: false,
      waitingOn: 'you',
      href: links.compliance('milestones'),
      primary: { kind: 'navigate', label: 'Review rules', href: links.compliance('milestones') },
      minutes: 10,
      refs: {},
    })
  }

  // Thresholds coming up: 'You will be a 15+ employer on Mon Oct 19: 2 things'.
  const horizon = addDays(date, THRESHOLD_HORIZON_DAYS)
  const coming = new Map<string, { n: number; on: ISODate; ifAccepted: boolean; rules: RuleResult[] }>()
  for (const r of results) {
    if (r.state !== 'approaching') continue
    const t = r.rule.trigger
    if (t.kind !== 'headcount' || t.method === 'weeks_20' || t.method === 'cobra_prior_year') continue
    const on = r.projectedOn ?? r.projectedIfOffersAccepted
    if (!on || on > horizon) continue
    const ifAccepted = !r.projectedOn
    const k = `${t.n}|${on}`
    const entry = coming.get(k) ?? { n: t.n, on, ifAccepted, rules: [] }
    entry.rules.push(r)
    coming.set(k, entry)
  }
  for (const e of coming.values()) {
    out.push({
      key: `threshold:${e.n}:${e.on}`,
      kind: 'threshold',
      title: `You ${e.ifAccepted ? 'would be' : 'will be'} a ${e.n}+ employer on ${dayText(e.on)}${e.ifAccepted ? ' if offers are accepted' : ''}: ${plural(e.rules.length, 'thing')} to get ready`,
      detail: `${listJoin(e.rules.map((r) => r.rule.title))}. ${NOT_LEGAL_ADVICE}`,
      dueOn: e.on,
      group: groupFor(e.on, date),
      statutory: false,
      waitingOn: 'you',
      href: links.compliance('milestones'),
      primary: { kind: 'navigate', label: 'See what changes', href: links.compliance('milestones') },
      minutes: 3,
      refs: {},
    })
  }
  return out
}

function calendarItems(ctx: Ctx): InboxItem[] {
  const { db, date, me } = ctx
  if (ctx.scope !== 'admin') return []
  const skipKinds = new Set<CalendarItem['kind']>(['training', 'leave_notice', 'rule_deadline'])
  const items = complianceCalendar(db, addDays(date, -90), addDays(date, HORIZON_DAYS)).filter((c) => !c.done && !skipKinds.has(c.kind))
  const out: InboxItem[] = []
  for (const c of items) {
    const rule = c.ruleId ? RULE_BY_ID[c.ruleId] : undefined
    let primary: InboxAction = { kind: 'navigate', label: 'Open calendar', href: links.compliance('calendar') }
    let href = links.compliance('calendar')
    let ownerId: ID | undefined
    const year = Number(c.date.slice(0, 4))
    switch (c.kind) {
      case 'recurring': {
        const r = db.recurring.find((x) => c.id === `rec-${x.id}-${c.date}`)
        if (r) {
          ownerId = r.ownerId
          primary = { kind: 'mutate', label: 'Mark done', op: { type: 'recurring_done', recurringId: r.id }, toast: `Done: ${r.title}` }
        }
        break
      }
      case 'soc2_access_review':
        primary = { kind: 'mutate', label: 'Mark done', op: { type: 'access_review_done', quarter: quarterOf(c.date) }, toast: `Recorded the ${quarterOf(c.date).replace(/^(\d{4})-(Q\d)$/, '$2 $1')} access review` }
        href = links.compliance('soc2')
        break
      case 'sb294_notice':
      case 'victims_notice':
        if (c.ruleId) primary = { kind: 'mutate', label: 'Mark sent', op: { type: 'annual_done', ruleId: c.ruleId, year }, toast: `Marked sent for ${year}: ${c.title}` }
        break
      case 'form_1099':
        if (c.ruleId) primary = { kind: 'mutate', label: 'Mark filed', op: { type: 'annual_done', ruleId: c.ruleId, year }, toast: `Marked the ${year} 1099-NEC filing done` }
        break
      case 'de542':
        if (c.contractorId) {
          primary = { kind: 'mutate', label: 'Mark filed', op: { type: 'de542_filed', contractorId: c.contractorId }, toast: `Recorded DE 542 as filed for ${db.contractors.find((x) => x.id === c.contractorId)?.name ?? 'the contractor'}` }
          href = links.contractor(c.contractorId)
        }
        break
      case 'contract_end':
        if (c.contractorId) {
          href = links.contractor(c.contractorId)
          primary = { kind: 'navigate', label: 'Open contract', href }
        }
        break
      case 'i9_reverify':
        if (c.personId) {
          href = links.person(c.personId)
          primary = { kind: 'navigate', label: 'Open profile', href }
        }
        break
      case 'valuation_409a':
        href = links.comp('equity')
        primary = { kind: 'navigate', label: 'Open equity', href }
        break
      case 'rate_review':
        href = links.settings('rules')
        primary = { kind: 'navigate', label: 'Review rates', href }
        break
    }
    const waitingOn: 'you' | 'them' = ownerId && ownerId !== me ? 'them' : 'you'
    out.push({
      key: `cal:${c.id}`,
      kind: 'calendar',
      title: c.date < date && !/due$/.test(c.title) ? `${c.title} (was due ${dayText(c.date)})` : c.title,
      detail: c.detail,
      dueOn: c.date,
      // A legal deadline on a weekend gets a file-by day; a contract end or a company target happens on its date.
      dueNote: dueNoteFor(ctx, c.date, undefined, c.statutory ? undefined : null),
      group: groupFor(c.date, date),
      statutory: c.statutory,
      waitingOn,
      waitingOnName: waitingOn === 'them' ? ctx.first(ownerId) : undefined,
      ownerId,
      href,
      primary,
      more: primary.kind === 'navigate' && href === links.compliance('calendar') ? undefined : [{ kind: 'navigate', label: 'Open calendar', href: links.compliance('calendar') }],
      minutes: 3,
      citation: rule?.citation,
      externalLink: c.link && !rule ? { label: 'Official page', url: c.link } : undefined,
      refs: { ruleId: c.ruleId, personId: c.personId, contractorId: c.contractorId },
    })
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Source: trainings, policy acknowledgements, backup
// ---------------------------------------------------------------------------------------------

function trainingItems(ctx: Ctx, covered: Set<string>): InboxItem[] {
  const { db, date, scope, me, viewer, horizon } = ctx
  const out: InboxItem[] = []
  const week = addDays(date, WEEK_DAYS)
  const people = [...employedOn(db, date), ...incomingOn(db, date)]
  for (const p of people) {
    const self = p.id === me
    const team = scope === 'manager' && isInReportingLine(viewer, db, p.id)
    if (!self && scope !== 'admin' && !team) continue
    for (const row of trainingRequirements(db, p, date)) {
      if (!row.required || !row.dueOn) continue
      if (row.status !== 'overdue' && row.status !== 'due') continue
      if (row.dueOn > horizon) continue
      if (covered.has(`${p.id}|${row.kind}`)) continue
      const overdue = row.dueOn < date
      if (!self && scope === 'admin' && !overdue && row.dueOn > week) continue
      if (team && !overdue) continue
      const label = TRAINING_LABELS[row.kind]
      const statutory = row.course !== 'security_awareness'
      const waitingOn: 'you' | 'them' = self ? 'you' : 'them'
      const who = self ? 'Your' : possessive(fullName(p))
      const done: InboxAction = {
        kind: 'mutate',
        label: 'Mark done',
        op: { type: 'training_done', personId: p.id, kind: row.kind },
        toast: `Recorded ${lowerFirst(label)} for ${fullName(p)}`,
      }
      const reminder: InboxAction = {
        kind: 'copy',
        label: 'Copy reminder',
        text: reminderText(db, firstName(p), `A reminder: your ${lowerFirst(label)} ${overdue ? 'was due' : 'is due'} ${dayText(row.dueOn)}.`, me, row.course === 'harassment' ? `The free CRD course is here: ${CRD_COURSE_URL}` : undefined),
        toast: `Copied a training reminder for ${fullName(p)}`,
      }
      out.push({
        key: `training:${p.id}:${row.kind}:${row.dueOn}`,
        kind: 'training',
        title: `${who} ${lowerFirst(label)} ${overdue ? 'was due' : 'is due'} ${dayText(row.dueOn)}`,
        detail: row.reason,
        dueOn: row.dueOn,
        group: groupFor(row.dueOn, date),
        statutory,
        waitingOn,
        waitingOnName: waitingOn === 'them' ? firstName(p) : undefined,
        ownerId: p.id,
        href: scope === 'admin' ? links.compliance('training') : self ? links.me('tasks') : links.person(p.id),
        primary: team ? reminder : done,
        more: !self && !team ? [reminder] : undefined,
        minutes: self ? (row.hours ?? 0.5) * 60 : 1,
        citation: row.course === 'harassment' ? { label: 'Gov. Code 12950.1', url: CRD_COURSE_URL } : row.course === 'wvpp' ? RULE_BY_ID.wvpp?.citation : undefined,
        externalLink: self && row.link ? { label: 'Open the course', url: row.link } : undefined,
        refs: { personId: p.id, trainingKind: row.kind },
      })
    }
  }
  return out
}

function ackItems(ctx: Ctx, solo: boolean): InboxItem[] {
  const { db, date, scope, me } = ctx
  const out: InboxItem[] = []
  const employed = employedOn(db, date)
  // People whose onboarding checklist still has the acknowledgement task open (that row covers it).
  const openAckTask = new Set<string>()
  for (const cl of db.checklists) {
    for (const t of cl.tasks) {
      const pol = ACK_TASK_POLICY[t.templateTaskId ?? '']
      if (pol && t.status === 'open') openAckTask.add(`${cl.personId}|${pol}`)
    }
  }
  for (const policy of db.policies) {
    if (!policy.requiresAck || policy.effectiveOn > date) continue
    const missing = employed.filter(
      (p) =>
        !openAckTask.has(`${p.id}|${policy.id}`) &&
        !db.acks.some((a) => a.personId === p.id && a.policyId === policy.id && a.version === policy.version),
    )
    // While headcount is 1 the founder is not asked to acknowledge their own starter policies.
    if (me && !solo && missing.some((p) => p.id === me)) {
      out.push({
        key: `ack:${policy.id}:${policy.version}:${me}`,
        kind: 'ack',
        title: `Read and acknowledge the ${policy.title} (v${policy.version})`,
        detail: policy.summary,
        group: 'this_week',
        statutory: false,
        waitingOn: 'you',
        href: links.me('tasks'),
        primary: { kind: 'mutate', label: 'Acknowledge', op: { type: 'acknowledge', policyId: policy.id, personId: me }, toast: `Acknowledged the ${policy.title} v${policy.version}` },
        minutes: 5,
        externalLink: policy.link ? { label: 'Read the policy', url: policy.link } : undefined,
        refs: { policyId: policy.id, personId: me },
      })
    }
    if (scope !== 'admin') continue
    const others = missing.filter((p) => p.id !== me)
    if (!others.length) continue
    const names = others.map((p) => firstName(p))
    out.push({
      key: `acks:${policy.id}:${policy.version}`,
      kind: 'acks',
      title: `${policy.title} v${policy.version}: ${plural(others.length, 'acknowledgement')} missing`,
      detail: `Still to acknowledge: ${listJoin(others.map((p) => fullName(p)))}.`,
      group: 'this_week',
      statutory: false,
      waitingOn: 'them',
      waitingOnName: others.length === 1 ? names[0] : `${others.length} people`,
      href: links.compliance('notices'),
      primary: {
        kind: 'copy',
        label: 'Copy reminder',
        text: reminderText(
          db,
          listJoin(names),
          `Please read the ${policy.title} (version ${policy.version}, effective ${fmtDate(policy.effectiveOn)}) and acknowledge it in First Twenty under Me, My tasks.`,
          me,
          policy.link ? `Here it is: ${policy.link}` : undefined,
        ),
        toast: `Copied an acknowledgement reminder for ${plural(others.length, 'person', 'people')}`,
      },
      minutes: 2,
      refs: { policyId: policy.id },
    })
  }
  return out
}

function backupItems(ctx: Ctx): InboxItem[] {
  const { db, date } = ctx
  if (ctx.scope !== 'admin' || db.meta.sample) return []
  // A timestamp: compare by the local calendar day (an evening backup is still today), as the header chip does.
  const last = db.meta.lastExportedOn ? localDateOf(db.meta.lastExportedOn) : undefined
  const age = last ? daysBetween(last, date) : null
  if (age !== null && age <= BACKUP_STALE_DAYS) return []
  return [
    {
      key: `backup:${last ?? 'never'}`,
      kind: 'backup',
      title: age === null ? 'You have not downloaded a backup yet' : `Your last backup was ${plural(age, 'day')} ago`,
      detail: 'Everything lives in this browser. A backup file lets you restore it on any computer.',
      group: 'this_week',
      statutory: false,
      waitingOn: 'you',
      href: links.settings('data'),
      primary: { kind: 'mutate', label: 'Download backup', op: { type: 'backup_downloaded' }, toast: 'Downloaded a backup' },
      minutes: 1,
      refs: {},
    },
  ]
}

// ---------------------------------------------------------------------------------------------
// Source: the growth journey (one-time 'why now' announcements and the levels and bands nudge)
// ---------------------------------------------------------------------------------------------

/** An unlock announcement shows for this many days after the data unlocked the area (or until dismissed). */
export const UNLOCK_SHOW_DAYS = 14
/** W-2 headcount at which the inbox asks for levels and bands before the next offer (docs/SPEC.md, Growth journey 5). */
export const BANDS_NUDGE_HEADCOUNT = 5

const PAY_SCALE_CITATION = {
  label: 'Labor Code 432.3',
  url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=432.3.&lawCode=LAB',
}

function earliest(dates: Array<ISODate | undefined | null>): ISODate | undefined {
  return dates.filter((d): d is ISODate => !!d).sort()[0]
}

export type UnlockEvent = { area: 'first_hire' | 'equity' | 'contractors' | 'manager_view'; on: ISODate }

/**
 * When each growth-journey area switched on, from the data: the second employee's start, the first
 * grant, the first contractor's start, and the first non-founder manager. Only events on or before
 * the date are returned.
 */
export function unlockEvents(db: DB, date: ISODate): UnlockEvent[] {
  const out: UnlockEvent[] = []
  const second = headcountSeries(db, date).find((p) => p.value >= 2)
  if (second) out.push({ area: 'first_hire', on: second.date })
  const grant = earliest(
    db.grants.filter((g) => g.status === 'promised' || g.status === 'approved').map((g) => g.proposedOn ?? g.boardApprovedOn ?? g.vestingStart),
  )
  if (grant && grant <= date) out.push({ area: 'equity', on: grant })
  const contractor = earliest(db.contractors.filter((c) => c.kind === 'contractor' && c.startOn <= date).map((c) => c.startOn))
  if (contractor) out.push({ area: 'contractors', on: contractor })
  if (hiringManagerModeAvailable(db)) {
    const founders = new Set(db.people.filter((p) => p.isFounder).map((p) => p.id))
    const byId = new Map(db.people.map((p) => [p.id, p]))
    const reports = db.people
      .filter((r) => r.managerId && !founders.has(r.managerId) && byId.has(r.managerId))
      .map((r) => (r.startDate > (byId.get(r.managerId as ID) as Person).startDate ? r.startDate : (byId.get(r.managerId as ID) as Person).startDate))
    const jobs = db.jobs.filter((j) => !founders.has(j.hiringManagerId) && byId.has(j.hiringManagerId)).map((j) => j.openedOn)
    const on = earliest([...reports, ...jobs])
    if (on && on <= date) out.push({ area: 'manager_view', on })
  }
  return out
}

const UNLOCK_COPY: Record<UnlockEvent['area'], { title: string; detail: string; href: string; label: string }> = {
  first_hire: {
    title: 'New: onboarding, time off and the directory are on',
    detail: 'Why now: you have your first employee. Onboarding checklists, time off, the directory and the run-rate card now fill in, and Employee view previews what your hire sees.',
    href: links.people(),
    label: 'Open People',
  },
  equity: {
    title: 'New: equity tracking is on',
    detail: 'Why now: you recorded your first grant. Comp and plan now tracks the 409A, the board consent queue and the 25102(o) notice due within 30 days of the first grant.',
    href: links.comp('equity'),
    label: 'Open equity',
  },
  contractors: {
    title: 'New: contractor checks are on',
    detail: 'Why now: your first contractor started. Each contractor gets an AB5 check, and individuals paid or contracted for $600 or more need a DE 542 within 20 days.',
    href: links.people('contractors'),
    label: 'Open contractors',
  },
  manager_view: {
    title: 'New: Hiring manager view is available',
    detail: 'Why now: someone other than the founder now manages people or a job. Their time off approvals and drafted offers route through them, and supervisor harassment training is due within 6 months.',
    href: links.people('org'),
    label: 'Open the org chart',
  },
}

function growthItems(ctx: Ctx): InboxItem[] {
  const { db, date } = ctx
  if (ctx.scope !== 'admin') return []
  const out: InboxItem[] = []
  for (const e of unlockEvents(db, date)) {
    if (daysBetween(e.on, date) > UNLOCK_SHOW_DAYS) continue
    const copy = UNLOCK_COPY[e.area]
    out.push({
      key: `unlock:${e.area}`,
      kind: 'unlock',
      title: copy.title,
      detail: copy.detail,
      group: 'this_week',
      statutory: false,
      waitingOn: 'you',
      href: copy.href,
      primary: { kind: 'navigate', label: copy.label, href: copy.href },
      minutes: 1,
      refs: {},
    })
  }
  // Levels and bands before the next offer, once, at 5 employees, until a band is edited or the row is dismissed.
  const reviewed = db.activity.some((a) => a.kind === 'band_changed' || a.kind === 'bands_updated')
  if (!reviewed && employedOn(db, date).length >= BANDS_NUDGE_HEADCOUNT) {
    out.push({
      key: 'nudge:bands',
      kind: 'bands',
      title: 'Set levels and bands before your next offer',
      detail: `Why now: you have ${BANDS_NUDGE_HEADCOUNT} or more employees. Offers start from the band for the level, and anyone can ask for the pay scale of their role or a role they applied for. At 15, every job post needs the range.`,
      group: 'this_week',
      statutory: false,
      waitingOn: 'you',
      href: links.comp('bands'),
      primary: { kind: 'navigate', label: 'Review bands', href: links.comp('bands') },
      minutes: 10,
      citation: PAY_SCALE_CITATION,
      refs: {},
    })
  }
  return out
}

/** December: next year's holidays roll over (business-day math skips only listed holidays). */
function holidayItems(ctx: Ctx): InboxItem[] {
  const { db, date } = ctx
  if (ctx.scope !== 'admin' || date.slice(5, 7) !== '12') return []
  const next = Number(date.slice(0, 4)) + 1
  if (hasHolidaysIn(db.holidays, next)) return []
  const roll = rolloverHolidays(db.holidays, next)
  if (roll.add.length === 0) return []
  const from = roll.basedOn.length ? `carried over from ${listJoin(roll.basedOn.map(String))}` : 'from the standard set'
  const dueOn = `${next - 1}-12-31`
  return [
    {
      key: `holidays:${next}`,
      kind: 'holidays',
      title: `Add the ${next} company holidays`,
      detail: `Due dates in ${next} count holidays as workdays until they are listed. ${plural(roll.add.length, 'holiday')} ${from}, with observed dates.`,
      dueOn,
      group: groupFor(dueOn, date),
      statutory: false,
      waitingOn: 'you',
      href: links.settings('timeoff'),
      primary: { kind: 'mutate', label: `Add ${plural(roll.add.length, 'holiday')}`, op: { type: 'add_holidays', year: next }, toast: `Added the ${next} holidays` },
      more: [{ kind: 'navigate', label: 'Review holidays first', href: links.settings('timeoff') }],
      minutes: 2,
      refs: {},
    },
  ]
}

// ---------------------------------------------------------------------------------------------
// Source: pay run prep (docs/SPEC.md PAY RUN PREP)
// ---------------------------------------------------------------------------------------------

/**
 * Admin: 'Run payroll by <cutoff>' for the next pay period not marked submitted. The cutoff is the provider's
 * deadline (Settings), not a legal one, so the item is never red; it cannot be snoozed past the cutoff or
 * dismissed. The payday is the legal date (Labor Code 204, docs/LAW.md w-pay-frequency, w-late-pay-penalty):
 * once the cutoff has passed the item leads Overdue, ahead of the legal rows, until payday (leadsOverdue).
 */
function payRunItems(ctx: Ctx): InboxItem[] {
  const { db, date } = ctx
  if (ctx.scope !== 'admin') return []
  const period = nextPayRunDue(db, date)
  if (!period || period.cutoff > addDays(date, HORIZON_DAYS)) return []
  const provider = providerPhrase(db.company)
  const label = periodLabel(period)
  const settings = payrollSettings(db.company)
  const late = period.cutoff < date
  const moved = period.payday !== period.scheduledPayday ? ` (moved from ${dayText(period.scheduledPayday)}, not a business day)` : ''
  return [
    {
      key: `payrun:${period.start}`,
      kind: 'payrun',
      title: late
        ? `Run the ${label} payroll now: the cutoff was ${dayText(period.cutoff)}, payday is ${dayText(period.payday)}`
        : `Run the ${label} payroll in ${provider} by ${dayText(period.cutoff)}`,
      detail: `Payday ${dayText(period.payday)}${moved}. ${sentenceCase(periodHeadline(db, period))}. Export the prep, enter it in ${provider}, then mark it submitted.`,
      dueOn: period.cutoff,
      dueNote: `${payrollProviderName(db.company) ? `${provider}'s cutoff` : 'The provider cutoff'}, ${cutoffWords(settings.cutoffBusinessDays)} (Settings, Link-outs). The payday is the legal deadline: a missed payday can cost $100 per employee, more if it happens again (Labor Code 210).`,
      group: groupFor(period.cutoff, date),
      statutory: false,
      snoozeLimit: period.cutoff,
      snoozeLimitLabel: 'The payroll cutoff',
      waitingOn: 'you',
      href: links.payRun(period.start),
      primary: { kind: 'navigate', label: 'Open pay run prep', href: links.payRun(period.start) },
      more: [
        {
          kind: 'mutate',
          label: `Mark submitted to ${provider}`,
          op: { type: 'payrun_submitted', periodStart: period.start },
          toast: `Marked the ${label} payroll submitted`,
        },
      ],
      minutes: 15,
      citation: { label: LAW_SOURCES.lc204.label, url: LAW_SOURCES.lc204.url },
      refs: {},
    },
  ]
}

/**
 * Admin: a payday passed in the last UNMARKED_REMINDER_DAYS days and nobody marked its payroll submitted. Quiet
 * (amber, snoozable, dismissable): most often the payroll ran and only the mark is missing, and the mark also
 * records the first payroll date for the EDD clock (docs/LAW.md a-edd-register-1).
 */
function payRunUnmarkedItems(ctx: Ctx): InboxItem[] {
  const { db, date } = ctx
  if (ctx.scope !== 'admin') return []
  const provider = providerPhrase(db.company)
  return unmarkedPayRuns(db, date).map((period): InboxItem => {
    const label = periodLabel(period)
    return {
      key: `payrun-unmarked:${period.start}`,
      kind: 'payrun_unmarked',
      title: `Did the ${label} payroll run? Payday was ${dayText(period.payday)}`,
      detail: `Nothing is marked for it here. If it ran in ${provider}, mark it submitted. If it did not, run it now: a late payday can cost $100 per employee (Labor Code 210).`,
      dueOn: period.payday,
      group: groupFor(period.payday, date),
      statutory: false,
      waitingOn: 'you',
      href: links.payRun(period.start),
      primary: { kind: 'mutate', label: 'Mark submitted', op: { type: 'payrun_submitted', periodStart: period.start }, toast: `Marked the ${label} payroll submitted` },
      more: [{ kind: 'navigate', label: 'Open pay run prep', href: links.payRun(period.start) }],
      minutes: 2,
      citation: { label: LAW_SOURCES.lc210.label, url: LAW_SOURCES.lc210.url },
      refs: {},
    }
  })
}

/** Shown once (dismiss hides it for good) when employees plus accepted offers reach 20. */
function graduationItems(ctx: Ctx): InboxItem[] {
  const { db, date } = ctx
  if (ctx.scope !== 'admin') return []
  const count = graduationCount(db, date)
  if (count.total < GRADUATION_HEADCOUNT) return []
  return [
    {
      key: 'graduation',
      kind: 'graduation',
      title: `${count.total} people, counting accepted offers: graduation export packs are ready`,
      detail: `Past about ${GRADUATION_OUTGROW_AT} people, or with several hires in another state, a real HRIS and ATS fits better. Settings, Data has CSV packs shaped for their imports.`,
      group: 'coming_up',
      statutory: false,
      waitingOn: 'you',
      href: href('settings', 'data', 'graduation'),
      primary: { kind: 'navigate', label: 'Open graduation packs', href: href('settings', 'data', 'graduation') },
      minutes: 5,
      refs: {},
    },
  ]
}

// ---------------------------------------------------------------------------------------------
// The inbox
// ---------------------------------------------------------------------------------------------

/** Solo founder workspace: one employee, nobody starting. Home uses the solo layout and copy. */
export function isSoloWorkspace(db: DB, date: ISODate): boolean {
  return employedOn(db, date).length <= 1 && incomingOn(db, date).length === 0
}

/**
 * The First hire kit shows on Home while W-2 headcount is 1, including while the first hire is
 * pre-start: that is when workers' comp, the IIPP and posters become urgent (docs/SPEC.md, Home).
 */
export function firstHireKitShown(db: DB, date: ISODate): boolean {
  return employedOn(db, date).length <= 1
}

const GROUP_ORDER: Record<InboxGroup, number> = { overdue: 0, this_week: 1, coming_up: 2 }

/**
 * An overdue row with a snoozeLimit that has passed (a payroll past its cutoff, still before payday) leads Overdue,
 * ahead of the legal rows: its legal date (the payday) is today or still ahead and can still be met, while the legal
 * rows are already late. Home shows the first rows of a group before 'Show more', so it must be on top to be seen.
 */
function leadsOverdue(i: InboxItem): boolean {
  return i.group === 'overdue' && !i.statutory && !!i.snoozeLimit
}

function compareItems(a: InboxItem, b: InboxItem): number {
  return (
    GROUP_ORDER[a.group] - GROUP_ORDER[b.group] ||
    Number(leadsOverdue(b)) - Number(leadsOverdue(a)) ||
    Number(b.statutory && b.group === 'overdue') - Number(a.statutory && a.group === 'overdue') ||
    (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999') ||
    Number(a.waitingOn === 'them') - Number(b.waitingOn === 'them') ||
    a.title.localeCompare(b.title)
  )
}

/**
 * Every item that needs the viewer's attention on the date, computed live (never stored), grouped
 * Overdue, This week and Coming up, sorted with legal deadlines first. Snoozed and dismissed items are
 * left out (statutory ones come back on their due date).
 */
export function inboxItems(db: DB, viewer: Viewer, date: ISODate, opts: InboxOptions = {}): InboxItem[] {
  const ctx = makeCtx(db, viewer, date, opts)
  // Headcount 1 (even with a first hire who has not started): the First hire kit covers the basics.
  const kitShown = firstHireKitShown(db, date)
  const tasks = taskItems(ctx)
  const covered = new Set(tasks.filter((i) => i.refs.trainingKind && i.refs.personId).map((i) => `${i.refs.personId}|${i.refs.trainingKind}`))
  const all = [
    ...tasks,
    ...scorecardItems(ctx),
    ...candidateItems(ctx),
    ...offerItems(ctx),
    ...requisitionItems(ctx),
    ...timeOffItems(ctx),
    ...leaveNoticeItems(ctx),
    ...grantItems(ctx),
    ...ab5Items(ctx),
    ...ruleItems(ctx, kitShown),
    ...calendarItems(ctx),
    ...trainingItems(ctx, covered),
    // While headcount is 1 the founder is not asked to acknowledge their own starter policies.
    ...ackItems(ctx, kitShown),
    ...growthItems(ctx),
    ...backupItems(ctx),
    ...holidayItems(ctx),
    ...graduationItems(ctx),
    ...payRunItems(ctx),
    ...payRunUnmarkedItems(ctx),
  ]
  const seen = new Set<string>()
  const out = all.filter((i) => {
    if (seen.has(i.key)) return false
    seen.add(i.key)
    return opts.includeHidden || !isHidden(db.inboxState[i.key], i, date)
  })
  return out.sort(compareItems)
}

/** Items for one filter: all, waiting on you, waiting on them. */
export function filterItems(items: InboxItem[], filter: 'all' | 'you' | 'them'): InboxItem[] {
  return filter === 'all' ? items : items.filter((i) => i.waitingOn === filter)
}

/**
 * The rows a filter shows. Coming up folds away while there is work due now (unless it is opened), so
 * the filter counts match the list, and the Tonight header (tonightSummary) while Coming up is folded.
 */
export function visibleForFilter(items: InboxItem[], filter: 'all' | 'you' | 'them', comingUpOpen = false): InboxItem[] {
  const list = filterItems(items, filter)
  const folded = !comingUpOpen && list.some((i) => i.group !== 'coming_up')
  return folded ? list.filter((i) => i.group !== 'coming_up') : list
}

// ---------------------------------------------------------------------------------------------
// Applying an item's action
// ---------------------------------------------------------------------------------------------

export type InboxOpResult = { ok: true } | { ok: false; reason: string }

/**
 * Runs an inbox mutation on a draft. Call it inside useDB.getState().mutate(action.toast, ...) so the
 * change is undoable. Returns why it could not be done (show it in a toast); nothing changes then.
 */
export function applyInboxOp(draft: Draft<DB>, op: InboxOp, ctx: { date: ISODate; actorId: ID | null }): InboxOpResult {
  const { date, actorId } = ctx
  switch (op.type) {
    case 'task_status': {
      const checklist = draft.checklists.find((c) => c.id === op.checklistId)
      const task = checklist?.tasks.find((t) => t.id === op.taskId)
      if (!checklist || !task) return { ok: false, reason: 'That task no longer exists.' }
      if (task.status !== 'open') return { ok: false, reason: 'That task is already closed.' }
      if (op.status === 'not_applicable' && task.statutory && !op.note?.trim()) return { ok: false, reason: 'Add a note to say why this legal task does not apply.' }
      setTaskStatus(draft, op.checklistId, op.taskId, op.status, { date, byId: actorId, ...(op.note !== undefined ? { note: op.note } : {}) })
      if (op.status === 'done') {
        // Security training is tracked in the training tracker too (harassment syncs inside setTaskStatus).
        if (task.templateTaskId === 'on-security-training') {
          const already = draft.trainings.some((t) => t.personId === checklist.personId && t.kind === 'security_awareness' && t.completedOn === date)
          if (!already) recordTrainingCompletion(draft, checklist.personId, 'security_awareness', date)
        }
        const policyId = ACK_TASK_POLICY[task.templateTaskId ?? '']
        const policy = policyId ? draft.policies.find((p) => p.id === policyId) : undefined
        if (policy && !draft.acks.some((a) => a.personId === checklist.personId && a.policyId === policy.id && a.version === policy.version)) {
          draft.acks.push({ id: newId('ack'), policyId: policy.id, version: policy.version, personId: checklist.personId, acknowledgedOn: date })
        }
      }
      return { ok: true }
    }
    case 'approve_requisition':
      return approveRequisition(draft, op.jobId, { approverId: actorId, date })
    case 'decline_requisition':
      return declineRequisition(draft, op.jobId, { approverId: actorId, date })
    case 'approve_offer': {
      if (!actorId) return { ok: false, reason: 'Pick who you are under Viewing as, then approve.' }
      return approveOffer(draft, op.offerId, { approverId: actorId, at: nowISO() })
    }
    case 'extend_offer': {
      const offer = draft.offers.find((o) => o.id === op.offerId)
      if (!offer) return { ok: false, reason: 'That offer no longer exists.' }
      const holidays = dbHolidays(draft as DB)
      const base = offer.expiresOn < date ? date : offer.expiresOn
      return extendOffer(draft, op.offerId, addBusinessDays(base, op.businessDays, holidays), { date })
    }
    case 'approve_timeoff':
      return approveRequest(draft, op.requestId, { date, ...(actorId ? { approverId: actorId } : {}) })
        ? { ok: true }
        : { ok: false, reason: 'This request was already decided.' }
    case 'approve_timeoff_unpaid':
      return approveAsUnpaid(draft, op.requestId, { date, ...(actorId ? { approverId: actorId } : {}) })
        ? { ok: true }
        : { ok: false, reason: 'This request was already decided.' }
    case 'leave_notice_sent': {
      const leave = draft.leaveCases.find((l) => l.id === op.leaveCaseId)
      if (!leave) return { ok: false, reason: 'That leave case no longer exists.' }
      if (leave.designationNoticeSentOn) return { ok: false, reason: 'The notice is already recorded as sent.' }
      // One path for every surface (timeoff panel, compliance calendar, inbox): dates the case, closes the task, logs.
      return markDesignationSent(draft, op.leaveCaseId, { date, byId: actorId })
        ? { ok: true }
        : { ok: false, reason: 'The notice is already recorded as sent.' }
    }
    case 'rule_action_done':
      setRuleActionDone(draft, op.ruleId, op.actionId, date)
      return { ok: true }
    case 'rule_not_applicable':
      if (!op.note.trim()) return { ok: false, reason: 'Add a note to say why this rule does not apply.' }
      setRuleStatus(draft, op.ruleId, 'not_applicable', date, op.note.trim())
      return { ok: true }
    case 'training_done': {
      recordTrainingCompletion(draft, op.personId, op.kind, date)
      // Close the matching onboarding or change task so the two never disagree.
      for (const cl of draft.checklists) {
        for (const t of cl.tasks) {
          if (t.status !== 'open' || taskTrainingKind(t) !== op.kind) continue
          if (traineeOf(cl, t) !== op.personId) continue
          setTaskStatus(draft, cl.id, t.id, 'done', { date, byId: actorId })
        }
      }
      return { ok: true }
    }
    case 'recurring_done':
      if (!draft.recurring.some((r) => r.id === op.recurringId)) return { ok: false, reason: 'That calendar item no longer exists.' }
      completeRecurringItem(draft, op.recurringId, date)
      return { ok: true }
    case 'access_review_done':
      markAccessReviewDone(draft, op.quarter, date)
      return { ok: true }
    case 'annual_done':
      markAnnualDone(draft, op.ruleId, op.year, date)
      return { ok: true }
    case 'de542_filed': {
      const c = draft.contractors.find((x) => x.id === op.contractorId)
      if (!c) return { ok: false, reason: 'That contractor no longer exists.' }
      c.de542FiledOn = date
      logActivity(draft, { entityType: 'contractor', entityId: c.id, kind: 'de542_filed', text: `Recorded DE 542 as filed for ${c.name} on ${fmtDate(date)}` })
      return { ok: true }
    }
    case 'acknowledge': {
      const policy = draft.policies.find((p) => p.id === op.policyId)
      if (!policy) return { ok: false, reason: 'That policy no longer exists.' }
      if (draft.acks.some((a) => a.personId === op.personId && a.policyId === policy.id && a.version === policy.version)) {
        return { ok: false, reason: 'Already acknowledged.' }
      }
      draft.acks.push({ id: newId('ack'), policyId: policy.id, version: policy.version, personId: op.personId, acknowledgedOn: date })
      closeAckTasks(draft, op.personId, policy.id, date)
      const person = draft.people.find((p) => p.id === op.personId)
      logActivity(draft, {
        entityType: 'person',
        entityId: op.personId,
        kind: 'policy_ack',
        text: `${person ? fullName(person) : 'Someone'} acknowledged the ${policy.title} v${policy.version}`,
      })
      return { ok: true }
    }
    case 'backup_downloaded':
      draft.meta.lastExportedOn = nowISO()
      return { ok: true }
    case 'payrun_submitted': {
      const period = periodStarting(draft as DB, op.periodStart)
      if (!period) return { ok: false, reason: 'That pay period is no longer on the pay schedule.' }
      const done = markPayRunSubmitted(draft, period, { date, actorId })
      return done.ok ? { ok: true } : done
    }
    case 'add_holidays': {
      const roll = rolloverHolidays(draft.holidays, op.year)
      if (roll.add.length === 0) return { ok: false, reason: `The ${op.year} holidays are already listed.` }
      draft.holidays.push(...roll.add)
      draft.holidays.sort((a, b) => a.date.localeCompare(b.date))
      return { ok: true }
    }
  }
}
