// The admin Home's finance-first summary (docs/SPEC.md, Home dashboard): three answers above the fold
// (am I legally exposed, what are people costing me, what do I need to approve), then the detail.
// Pure: every function takes the inbox items or db and the date, so the sample's moving dates test cleanly.
// Nothing here is stored; the legal list and the approvals queue are views over inboxItems().
import { format } from 'date-fns'
import { nextThreshold, RULE_BY_ID } from '@/domain/compliance'
import { daysOpen, miniFunnel, stuckCount } from '@/domain/hiring/pipeline'
import { candidateName } from '@/domain/hiring/util'
import type { InboxItem, InboxKind } from '@/domain/inbox'
import { rangeText } from '@/domain/inbox'
import { contractorMonthly, outstandingOffers, type PeopleCostSummary, peopleCostSummary } from '@/domain/pay'
import { nextPayRunDue, periodLabel } from '@/domain/payrun'
import { fullName, getPerson, incomingOn } from '@/domain/people'
import { headcountProjection } from '@/domain/plan'
import { hoursLabel } from '@/domain/timeoff'
import type { DB, ID } from '@/domain/types'
import { addDays, daysBetween, fmtShort, type ISODate, parseDate } from '@/lib/dates'
import { plural } from '@/lib/format'

/** Legal items due within this many days show in the legal list and count as "due soon". */
export const LEGAL_WINDOW_DAYS = 14

/** One part of a meta line: words, or an amount the privacy blur hides. */
export type MetaPart = string | { money: number; suffix?: string; short?: boolean }

// ---------------------------------------------------------------------------------------------
// Legal exposure
// ---------------------------------------------------------------------------------------------

export type LegalRow = {
  item: InboxItem
  status: 'overdue' | 'due_soon'
  /** Who it is about: a person's name, or "Company" for a rule. */
  subject: string
  /** The plain-English task, with its form code when there is one: "Confirm the new hire report was filed (DE 34)". */
  task: string
  /** "14 days late", "Due today", "Due in 3 days", "Applies now". */
  when: string
}

/** Checklist tasks by template id, as a plain task and the form it is about. */
const TASK_WORDS: Record<string, string> = {
  'on-de34': 'Confirm the new hire report was filed (DE 34)',
  'on-i9-section1': 'Employee part of the work eligibility form (I-9 section 1)',
  'on-i9-section2': 'Check work eligibility documents (I-9 section 2)',
  'on-w4-de4': 'Tax withholding forms (W-4 and DE 4)',
  'on-harassment-training': 'Harassment prevention training, 1 hour',
  'on-harassment-training-short-term': 'Harassment prevention training, 1 hour',
  'on-harassment-training-supervisor': 'Supervisor harassment prevention training, 2 hours',
  'ch-supervisor-training': 'Supervisor harassment prevention training, 2 hours',
  'on-iipp-training': 'Injury and illness prevention training',
  'on-notice-aca': 'Health insurance marketplace notice (ACA)',
  'ch-wage-notice': 'Pay change notice (Labor Code 2810.5)',
}

function firstUpper(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

/** "14 days late", "1 day late", "Due today", "Due tomorrow", "Due in 5 days", or "Applies now" (no date). */
export function whenText(item: Pick<InboxItem, 'dueOn' | 'group'>, date: ISODate): string {
  if (!item.dueOn) return item.group === 'overdue' ? 'Applies now' : 'Due soon'
  const d = daysBetween(date, item.dueOn)
  if (d < 0) return `${plural(-d, 'day')} late`
  if (d === 0) return 'Due today'
  if (d === 1) return 'Due tomorrow'
  return `Due in ${d} days`
}

/** The short "Person · task" wording for a legal row, rewritten from the item's references. */
export function legalWords(db: DB, item: InboxItem): { subject: string; task: string } {
  const person = item.refs.personId ? getPerson(db, item.refs.personId) : undefined
  const subject = person ? fullName(person) : 'Company'
  if (item.kind === 'task' && item.refs.checklistId && item.refs.taskId) {
    const task = db.checklists.find((c) => c.id === item.refs.checklistId)?.tasks.find((t) => t.id === item.refs.taskId)
    const words = (task?.templateTaskId && TASK_WORDS[task.templateTaskId]) || task?.title
    if (words) return { subject, task: firstUpper(words) }
  }
  if (item.kind === 'task_group') {
    const n = /(\d+) notices and tasks/.exec(item.title)?.[1]
    return { subject, task: n ? `First-day notices and tasks, ${n} open` : 'First-day notices and tasks' }
  }
  if (item.kind === 'leave_notice') return { subject, task: 'Leave designation notice (CFRA)' }
  if (item.kind === 'training') return { subject, task: item.title.replace(new RegExp(`^${subject}'s\\s*`), '') }
  if ((item.kind === 'rule' || item.kind === 'threshold') && item.refs.ruleId) {
    const rule = RULE_BY_ID[item.refs.ruleId]
    if (rule) return { subject: 'Company', task: rule.title }
  }
  return { subject, task: item.title }
}

/**
 * Legal and compliance items only (statutory), overdue first, then those due within LEGAL_WINDOW_DAYS.
 * A legal item with no date that is not overdue (a rule that starts to apply soon) counts as due soon.
 */
export function legalExposure(db: DB, items: InboxItem[], date: ISODate): { rows: LegalRow[]; overdue: number; dueSoon: number } {
  const until = addDays(date, LEGAL_WINDOW_DAYS)
  const rows = items
    .filter((i) => i.statutory && (i.group === 'overdue' || (i.dueOn ? i.dueOn <= until : i.group !== 'coming_up')))
    .map((item): LegalRow => ({ item, status: item.group === 'overdue' ? 'overdue' : 'due_soon', ...legalWords(db, item), when: whenText(item, date) }))
    .sort((a, b) => Number(a.status !== 'overdue') - Number(b.status !== 'overdue') || (a.item.dueOn ?? '9999').localeCompare(b.item.dueOn ?? '9999'))
  const overdue = rows.filter((r) => r.status === 'overdue').length
  return { rows, overdue, dueSoon: rows.length - overdue }
}

// ---------------------------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------------------------

/** Decisions that belong to the admin: offers, job requests, pay runs, board consent, classification, time off. */
export const APPROVAL_KINDS: InboxKind[] = ['offer_approval', 'requisition', 'payrun', 'payrun_unmarked', 'grants', 'ab5', 'timeoff']

export type ApprovalRow = { item: InboxItem; title: string; meta: MetaPart[] }

function approvalWords(db: DB, item: InboxItem, cost: PeopleCostSummary, date: ISODate): { title: string; meta: MetaPart[] } {
  switch (item.kind) {
    case 'offer_approval': {
      const offer = db.offers.find((o) => o.id === item.refs.offerId)
      const job = db.jobs.find((j) => j.id === (offer?.jobId ?? item.refs.jobId))
      const line = cost.withOffers.lines.find((l) => l.offerId === item.refs.offerId)
      const who = offer ? candidateName(db, offer.candidateId) : 'Offer'
      const meta: MetaPart[] = []
      if (line) meta.push({ money: line.monthly, suffix: '/mo fully loaded', short: true })
      if (offer?.startDate) meta.push(`starts ${fmtShort(offer.startDate)}`)
      return { title: `Offer · ${who}${job ? `, ${job.title}` : ''}`, meta }
    }
    case 'requisition': {
      const job = db.jobs.find((j) => j.id === item.refs.jobId)
      const meta: MetaPart[] = []
      if (job?.payMax) meta.push({ money: job.payMax, suffix: ' top of range', short: true })
      return { title: `New job · ${job?.title ?? item.title}`, meta }
    }
    case 'payrun': {
      const period = nextPayRunDue(db, date)
      const meta: MetaPart[] = item.dueOn ? [`cutoff ${fmtShort(item.dueOn)}`] : []
      if (period) meta.push(`payday ${fmtShort(period.payday)}`)
      meta.push({ money: cost.now.monthly, suffix: '/mo payroll run-rate', short: true })
      return { title: period ? `Pay run · ${periodLabel(period)}` : 'Pay run', meta }
    }
    case 'payrun_unmarked':
      return { title: 'Pay run · confirm it was submitted', meta: item.dueOn ? [`payday was ${fmtShort(item.dueOn)}`] : [] }
    case 'grants': {
      const n = item.refs.grantIds?.length ?? 0
      return { title: `Board consent · ${plural(n, 'option grant')}`, meta: [item.title.replace(/^.*?\(([^)]+)\)$/, '$1')] }
    }
    case 'ab5': {
      const c = db.contractors.find((x) => x.id === item.refs.contractorId)
      const meta: MetaPart[] = []
      if (c) meta.push({ money: contractorMonthly(c).monthly, suffix: '/mo contractor', short: true })
      meta.push('may need to be an employee (AB5)')
      return { title: `Contractor classification · ${c?.name ?? item.title}`, meta }
    }
    case 'timeoff': {
      const r = db.timeOffRequests.find((x) => x.id === item.refs.requestId)
      const person = r ? getPerson(db, r.personId) : undefined
      if (!r || !person) return { title: item.title, meta: [] }
      return { title: `Time off · ${fullName(person)}, ${rangeText(r.startDate, r.endDate)}`, meta: [hoursLabel(r.hours)] }
    }
    default:
      return { title: item.title, meta: [] }
  }
}

/** The one approvals queue: decisions waiting on the admin, in inbox order, with money and date impact. */
export function approvalsQueue(db: DB, items: InboxItem[], date: ISODate, cost: PeopleCostSummary = peopleCostSummary(db, date)): ApprovalRow[] {
  return items
    .filter((i) => APPROVAL_KINDS.includes(i.kind) && i.waitingOn === 'you')
    .map((item) => ({ item, ...approvalWords(db, item, cost, date) }))
}

/** Items due now (overdue or this week) that wait on someone else: the "waiting on others" link. */
export function waitingOnOthers(items: InboxItem[]): number {
  return items.filter((i) => i.waitingOn === 'them' && i.group !== 'coming_up').length
}

/** The page title: the date ('Thursday, Oct 22'). */
export function homeDateTitle(date: ISODate): string {
  return format(parseDate(date), 'EEEE, MMM d')
}

/** "3 legal items overdue. 6 decisions waiting on you." */
export function homeAnswer(legalOverdue: number, approvals: number): string {
  const legal = legalOverdue ? `${plural(legalOverdue, 'legal item')} overdue.` : 'No legal items overdue.'
  const decide = approvals ? `${plural(approvals, 'decision')} waiting on you.` : 'Nothing waiting on your approval.'
  return `${legal} ${decide}`
}

// ---------------------------------------------------------------------------------------------
// Headcount tile
// ---------------------------------------------------------------------------------------------

export type HeadcountTile = {
  current: number
  /** The plan at the end of the current quarter, when there is a plan. */
  plan: { value: number; date: ISODate } | null
  /** Headcount at each change point, for the sparkline. */
  history: number[]
  /** The next legal headcount threshold and how many hires away it is. */
  next: { n: number; away: number } | null
}

export function headcountTile(db: DB, date: ISODate): HeadcountTile {
  const proj = headcountProjection(db, date)
  const target = proj.targets[0]
  const nt = nextThreshold(db, date)
  return {
    current: proj.current,
    plan: target && (db.plan.length > 0 || target.value !== proj.current) ? { value: target.value, date: target.date } : null,
    history: proj.actual.map((p) => p.value),
    next: nt && nt.kind === 'headcount' ? { n: nt.n, away: Math.max(0, nt.n - nt.current) } : null,
  }
}

// ---------------------------------------------------------------------------------------------
// Hiring and joining and leaving tables
// ---------------------------------------------------------------------------------------------

export type HiringRow = {
  jobId: ID
  title: string
  applied: number
  onsite: number
  daysOpen: number | null
  stuck: number
  offersOut: number
  status: { tone: 'good' | 'warn' | 'accent'; text: string }
}

/** One row per open job: applied, reached onsite, days open, and a status word. */
export function hiringRows(db: DB, date: ISODate): HiringRow[] {
  const offers = outstandingOffers(db, date)
  return db.jobs
    .filter((j) => j.status === 'open')
    .map((job): HiringRow => {
      const funnel = miniFunnel(db, job)
      const applied = funnel.find((s) => s.kind === 'new')?.total ?? 0
      const onsite = funnel.find((s) => s.kind === 'onsite')?.total ?? 0
      const stuck = stuckCount(db, job, date)
      const offersOut = offers.filter((o) => o.jobId === job.id).length
      const status: HiringRow['status'] = offersOut
        ? { tone: 'accent', text: offersOut === 1 ? 'Offer out' : `${offersOut} offers out` }
        : stuck
          ? { tone: 'warn', text: `${stuck} stuck` }
          : { tone: 'good', text: 'On track' }
      return { jobId: job.id, title: job.title, applied, onsite, daysOpen: daysOpen(job, date), stuck, offersOut, status }
    })
    .sort((a, b) => (b.daysOpen ?? -1) - (a.daysOpen ?? -1))
}

export type MoveRow = {
  key: string
  personId: ID
  name: string
  change: 'Joining' | 'Started' | 'Leaving' | 'Left'
  date: ISODate
  checklistId?: ID
  done: number
  total: number
  status: { tone: 'good' | 'warn' | 'bad'; text: string }
}

/** Onboarding counts as in flight for six weeks after the start, or while something on it is overdue. */
const RECENT_START_DAYS = 42

/**
 * People joining (hired, not started), recently started with onboarding open, leaving (a last day ahead) or
 * left with offboarding still open, with checklist progress and a status word.
 */
export function joiningLeaving(db: DB, date: ISODate): MoveRow[] {
  const rows: MoveRow[] = []
  const seen = new Set<ID>()
  const status = (overdueLegal: number, overdue: number): MoveRow['status'] =>
    overdueLegal ? { tone: 'bad', text: 'Legal overdue' } : overdue ? { tone: 'warn', text: `${overdue} overdue` } : { tone: 'good', text: 'On track' }
  for (const cl of db.checklists) {
    if (cl.completedOn || (cl.kind !== 'onboarding' && cl.kind !== 'offboarding')) continue
    const person = getPerson(db, cl.personId)
    if (!person) continue
    const open = cl.tasks.filter((t) => t.status === 'open')
    if (!open.length) continue
    const late = open.filter((t) => t.dueOn < date)
    const recent = cl.anchorDate >= addDays(date, -RECENT_START_DAYS)
    if (cl.kind === 'onboarding' && !recent && !late.length) continue
    const change: MoveRow['change'] =
      cl.kind === 'onboarding' ? (person.startDate > date ? 'Joining' : 'Started') : person.endDate && person.endDate >= date ? 'Leaving' : 'Left'
    seen.add(`${person.id}:${cl.kind}`)
    rows.push({
      key: cl.id,
      personId: person.id,
      name: fullName(person),
      change,
      date: cl.kind === 'onboarding' ? person.startDate : (person.endDate ?? cl.anchorDate),
      checklistId: cl.id,
      done: cl.tasks.filter((t) => t.status !== 'open').length,
      total: cl.tasks.length,
      status: status(late.filter((t) => t.statutory).length, late.length),
    })
  }
  for (const p of incomingOn(db, date)) {
    if (seen.has(`${p.id}:onboarding`)) continue
    rows.push({ key: `in:${p.id}`, personId: p.id, name: fullName(p), change: 'Joining', date: p.startDate, done: 0, total: 0, status: status(0, 0) })
  }
  for (const p of db.people) {
    if (!p.endDate || p.endDate < date || seen.has(`${p.id}:offboarding`)) continue
    rows.push({ key: `out:${p.id}`, personId: p.id, name: fullName(p), change: 'Leaving', date: p.endDate, done: 0, total: 0, status: status(0, 0) })
  }
  const rank = { Joining: 0, Leaving: 1, Started: 2, Left: 3 }
  return rows.sort((a, b) => rank[a.change] - rank[b.change] || a.date.localeCompare(b.date))
}
