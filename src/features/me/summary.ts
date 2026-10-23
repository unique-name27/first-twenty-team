// Pure helpers for Me (employee self-service). Every function takes the date as a parameter so tests
// can pin it; components pass today() and nowISO(). Rules come from the domain modules (time off,
// equity, trainings, checklists, scorecards); this file only picks out what one person needs to see.
import { links } from '@/app/router'
import { ACK_TASK_POLICY } from '@/domain/checklists/actions'
import { grantSummary, type GrantSummary } from '@/domain/equity'
import { groupFor, type InboxItem, type InboxKind, inboxItems, isHidden, isSoloWorkspace } from '@/domain/inbox'
import { annualBase, bandForPerson, bandLabel, currentComp, compOrFirst } from '@/domain/pay'
import { fullName, getPerson, isEmployedOn, levelLabel, locationName, personNameById } from '@/domain/people'
import { balances, type BalanceRow, hoursPerDayFor, whoIsOut } from '@/domain/timeoff'
import { type TrainingRow } from '@/domain/trainings'
import type { Band, ChecklistTask, CompRecord, DB, EmergencyContact, Holiday, ID, Person, Policy, TrainingKind, Viewer } from '@/domain/types'
import { addDays, daysBetween, fmtDate, fmtDay, fullMonthsBetween, type ISODate, type ISODateTime } from '@/lib/dates'
import { daysFromHours, hoursText, hoursWithDays, num, plural } from '@/lib/format'

/** Tasks due within this many days (or overdue, or undated) count as needing you now. */
export const SOON_DAYS = 30

/** Me > Tasks lists checklist tasks and trainings this many days ahead; past SOON_DAYS they count as later. */
export const TASK_HORIZON_DAYS = 365

/** Onboarding item that saving an emergency contact in Me completes. */
export const EMERGENCY_CONTACTS_TASK = 'on-emergency-contacts'

/** Onboarding checklist tasks that a policy acknowledgement completes (policy id -> template task id). */
export const ACK_TASK_FOR_POLICY: Record<string, string> = {
  'pl-handbook': 'on-ack-handbook',
  'pl-aup': 'on-ack-security',
  'pl-confidentiality': 'on-piia',
}

// ---------------------------------------------------------------------------------------------
// Greeting and small text helpers
// ---------------------------------------------------------------------------------------------

/** "Good morning" (5-11), "Good afternoon" (12-16), "Good evening" (otherwise). */
export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Good morning'
  if (hour >= 12 && hour < 17) return 'Good afternoon'
  return 'Good evening'
}

/** "Mon, Oct 12", with the year when it differs from the reference date's year ("Wed, Sep 8, 2027"). */
export function dayText(d: ISODate, ref?: ISODate): string {
  return ref && d.slice(0, 4) !== ref.slice(0, 4) ? `${fmtDay(d)}, ${d.slice(0, 4)}` : fmtDay(d)
}

/** "Mon, Oct 12" or "Mon, Oct 12 to Fri, Oct 16" (years added when they differ from `ref`). */
export function rangeText(from: ISODate, to: ISODate, ref?: ISODate): string {
  return from === to ? dayText(from, ref) : `${dayText(from, ref)} to ${dayText(to, ref)}`
}

/** "today", "tomorrow", "in 23 days", "2 days ago". */
export function daysAwayText(from: ISODate, to: ISODate): string {
  const n = daysBetween(from, to)
  if (n === 0) return 'today'
  if (n === 1) return 'tomorrow'
  if (n === -1) return 'yesterday'
  return n > 0 ? `in ${plural(n, 'day')}` : `${plural(-n, 'day')} ago`
}

/** "3 weeks", "1 month", "1 year, 4 months" of service; "Starts in 10 days" before the start. */
export function tenureText(startDate: ISODate, date: ISODate): string {
  if (startDate > date) return `Starts ${daysAwayText(date, startDate)}`
  const months = fullMonthsBetween(startDate, date)
  if (months >= 12) {
    const y = Math.floor(months / 12)
    const m = months % 12
    return m ? `${plural(y, 'year')}, ${plural(m, 'month')}` : plural(y, 'year')
  }
  if (months >= 1) return plural(months, 'month')
  const days = Math.max(0, daysBetween(startDate, date))
  if (days >= 7) return plural(Math.floor(days / 7), 'week')
  return days === 0 ? 'First day' : plural(days, 'day')
}

/** Next work anniversary on or after the date (anniversaries replace birthdays). */
export function nextAnniversary(startDate: ISODate, date: ISODate): { date: ISODate; years: number } | null {
  if (startDate > date) return null
  const sy = Number(startDate.slice(0, 4))
  const md = startDate.slice(4)
  const leap = (yy: number) => yy % 4 === 0 && (yy % 100 !== 0 || yy % 400 === 0)
  // Feb 29 starts celebrate on Feb 28 in other years.
  const on = (yy: number) => (md === '-02-29' && !leap(yy) ? `${yy}-02-28` : `${yy}${md}`)
  let y = Number(date.slice(0, 4))
  if (on(y) < date) y += 1
  if (y - sy < 1) y = sy + 1
  return { date: on(y), years: y - sy }
}

// ---------------------------------------------------------------------------------------------
// Policies and acknowledgements
// ---------------------------------------------------------------------------------------------

/** "2.0" equals "v2" equals "2.0.0". */
export function sameVersion(a: string, b: string): boolean {
  const norm = (v: string) => v.trim().toLowerCase().replace(/^v/, '').replace(/(\.0+)+$/, '')
  return norm(a) === norm(b)
}

export type PolicyStatus = {
  policy: Policy
  acknowledgedOn?: ISODate
  /** Acknowledged an earlier version only. */
  previousVersionOn?: ISODate
  owed: boolean
  /** Within 30 days of the later of the start date and the version's effective date (the SOC 2 window). */
  dueOn: ISODate
}

/**
 * Policies that need an acknowledgement and where this person stands on the current version. Versions not
 * yet in effect are left out; people starting soon see the versions in effect today.
 */
export function policyStatuses(db: DB, personId: ID, date: ISODate): PolicyStatus[] {
  const person = getPerson(db, personId)
  if (!person) return []
  return db.policies
    .filter((p) => p.requiresAck && p.effectiveOn <= date)
    .map((policy) => {
      const mine = db.acks.filter((a) => a.personId === personId && a.policyId === policy.id)
      const current = mine
        .filter((a) => sameVersion(a.version, policy.version))
        .sort((a, b) => a.acknowledgedOn.localeCompare(b.acknowledgedOn))[0]
      const previous = mine.sort((a, b) => b.acknowledgedOn.localeCompare(a.acknowledgedOn)).find((a) => !sameVersion(a.version, policy.version))
      const from = person.startDate > policy.effectiveOn ? person.startDate : policy.effectiveOn
      return {
        policy,
        ...(current ? { acknowledgedOn: current.acknowledgedOn } : {}),
        ...(!current && previous ? { previousVersionOn: previous.acknowledgedOn } : {}),
        owed: !current,
        dueOn: addDays(from, 30),
      }
    })
    .sort((a, b) => Number(b.owed) - Number(a.owed) || a.policy.title.localeCompare(b.policy.title))
}

// ---------------------------------------------------------------------------------------------
// My tasks: one list, each task once with one action
// ---------------------------------------------------------------------------------------------

/** The checklist task an inbox row stands for, if it is one. */
function taskOf(db: DB, item: InboxItem): { task: ChecklistTask; personId: ID } | undefined {
  const { checklistId, taskId } = item.refs
  if (item.kind !== 'task' || !checklistId || !taskId) return undefined
  const checklist = db.checklists.find((c) => c.id === checklistId)
  const task = checklist?.tasks.find((t) => t.id === taskId)
  return checklist && task ? { task, personId: checklist.personId } : undefined
}

/**
 * Everything this person owes, as one list: the personal inbox (their own checklist items, tasks assigned
 * to them on teammates' checklists, required trainings, policy acknowledgements and scorecards), looking
 * TASK_HORIZON_DAYS ahead, plus any policy they still owe that the inbox leaves out (someone starting soon).
 * The inbox already drops the copies (a training's checklist task stands for the training, an open
 * acknowledgement task for the policy), so each task shows once with one action. Me > Tasks, the Summary
 * panel, the Tasks tab count and the printed summary all read this list.
 */
export function myTaskItems(db: DB, personId: ID, date: ISODate, now: ISODateTime): InboxItem[] {
  const person = getPerson(db, personId)
  if (!person) return []
  const viewer: Viewer = { role: 'employee', person, personId }
  const items = inboxItems(db, viewer, date, { scope: 'personal', now, horizonDays: TASK_HORIZON_DAYS }).map((item) => {
    const found = taskOf(db, item)
    if (!found || found.personId !== personId || item.primary.kind !== 'mutate') return item
    const templateId = found.task.templateTaskId ?? ''
    // Saving a contact in Me > Profile completes this item, so the row leads there.
    if (templateId === EMERGENCY_CONTACTS_TASK) {
      return { ...item, primary: { kind: 'navigate', label: 'Add contacts', href: links.me('profile') }, more: [item.primary, ...(item.more ?? [])] } satisfies InboxItem
    }
    // Marking an acknowledgement task done records the acknowledgement, so the button says so.
    const policy = db.policies.find((p) => p.id === ACK_TASK_POLICY[templateId])
    if (policy) {
      return {
        ...item,
        primary: { ...item.primary, label: 'Acknowledge' },
        ...(policy.link && !item.externalLink ? { externalLink: { label: 'Read the policy', url: policy.link } } : {}),
      } satisfies InboxItem
    }
    return item
  })
  // A solo founder is not asked to acknowledge their own starter policies (the inbox rule).
  if (isSoloWorkspace(db, date)) return items
  const covered = coveredByTasks(db, personId, items).policies
  const owed: InboxItem[] = []
  for (const s of policyStatuses(db, personId, date)) {
    if (!s.owed || covered.has(s.policy.id)) continue
    const p = s.policy
    const item: InboxItem = {
      // The inbox's own key for this acknowledgement, so a snooze carries over.
      key: `ack:${p.id}:${p.version}:${personId}`,
      kind: 'ack',
      title: `Read and acknowledge the ${p.title} (v${p.version})`,
      detail: s.previousVersionOn ? `New version since you acknowledged on ${fmtDate(s.previousVersionOn)}.` : p.summary,
      dueOn: s.dueOn,
      group: groupFor(s.dueOn, date),
      statutory: false,
      waitingOn: 'you',
      href: links.me('tasks'),
      primary: { kind: 'mutate', label: 'Acknowledge', op: { type: 'acknowledge', policyId: p.id, personId }, toast: `Acknowledged the ${p.title} v${p.version}` },
      minutes: 5,
      ...(p.link ? { externalLink: { label: 'Read the policy', url: p.link } } : {}),
      refs: { policyId: p.id, personId },
    }
    if (!isHidden(db.inboxState[item.key], item, date)) owed.push(item)
  }
  return owed.length ? [...items, ...owed].sort(byGroupThenDue) : items
}

const GROUP_ORDER: Record<InboxItem['group'], number> = { overdue: 0, this_week: 1, coming_up: 2 }

/** The inbox's order: group, overdue legal deadlines first, then due date and title. */
function byGroupThenDue(a: InboxItem, b: InboxItem): number {
  return (
    GROUP_ORDER[a.group] - GROUP_ORDER[b.group] ||
    Number(b.statutory && b.group === 'overdue') - Number(a.statutory && a.group === 'overdue') ||
    (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999') ||
    a.title.localeCompare(b.title)
  )
}

/** Overdue, undated (an acknowledgement) or due within SOON_DAYS: needs you now. Later items wait under Coming up. */
export function isDueSoon(item: { dueOn?: ISODate }, date: ISODate): boolean {
  return !item.dueOn || item.dueOn <= addDays(date, SOON_DAYS)
}

export function taskCounts(items: ReadonlyArray<{ dueOn?: ISODate }>, date: ISODate): { soon: number; later: number } {
  const soon = items.filter((i) => isDueSoon(i, date)).length
  return { soon, later: items.length - soon }
}

/** Policies and trainings the to-do list already holds, so the reference lists show their status only. */
export function coveredByTasks(db: DB, personId: ID, items: InboxItem[]): { policies: Set<ID>; trainings: Set<TrainingKind> } {
  const policies = new Set<ID>()
  const trainings = new Set<TrainingKind>()
  for (const item of items) {
    if (item.kind === 'ack' && item.refs.policyId) policies.add(item.refs.policyId)
    if (item.refs.trainingKind && (item.refs.personId ?? personId) === personId) trainings.add(item.refs.trainingKind)
    const found = taskOf(db, item)
    const policyId = found && found.personId === personId ? ACK_TASK_POLICY[found.task.templateTaskId ?? ''] : undefined
    if (policyId) policies.add(policyId)
  }
  return { policies, trainings }
}

export type TrainingStatusTone = 'good' | 'warn' | 'bad' | 'neutral' | 'outline'

/** The status words for a training in Me's reference list: 'Done', 'Due Mon, Mar 8, 2027', 'Overdue since Thu, Oct 8'. */
export function trainingStatusText(row: TrainingRow, date: ISODate): { label: string; tone: TrainingStatusTone } {
  const legal = row.course !== 'security_awareness'
  switch (row.status) {
    case 'done':
      return { label: row.nextDueOn ? `Done, next by ${dayText(row.nextDueOn, date)}` : 'Done', tone: 'good' }
    case 'due':
      if (!row.dueOn) return row.course === 'wvpp' ? { label: 'Waiting on plan', tone: 'neutral' } : { label: 'Due', tone: 'warn' }
      return { label: `Due ${dayText(row.dueOn, date)}`, tone: 'warn' }
    case 'overdue':
      return { label: row.dueOn ? `Overdue since ${dayText(row.dueOn, date)}` : 'Overdue', tone: legal && row.required ? 'bad' : 'warn' }
    case 'upcoming':
      return { label: row.dueOn ? `Due ${dayText(row.dueOn, date)}` : 'Upcoming', tone: 'neutral' }
    default:
      return row.recommended ? { label: 'Recommended', tone: 'outline' } : { label: 'Not required', tone: 'outline' }
  }
}

export type TodoKind = 'checklist' | 'training' | 'policy' | 'scorecard'

/** A to-do as plain data, for the printed and copied summary. */
export type Todo = {
  key: string
  kind: TodoKind
  title: string
  /** Short context line: why, or what it belongs to. */
  detail?: string
  dueOn?: ISODate
  overdue: boolean
  /** isDueSoon: counts toward "my tasks". */
  now: boolean
  statutory?: boolean
  policyId?: ID
  checklistId?: ID
  taskId?: ID
  templateTaskId?: ID
}

const TODO_KIND: Partial<Record<InboxKind, TodoKind>> = { training: 'training', ack: 'policy', scorecard: 'scorecard' }

/** myTaskItems as plain to-dos (the same list in the same order). */
export function myTodos(db: DB, personId: ID, date: ISODate, now: ISODateTime): Todo[] {
  return myTaskItems(db, personId, date, now).map((item) => {
    const found = taskOf(db, item)
    const templateTaskId = found?.task.templateTaskId
    const policyId = item.refs.policyId ?? (templateTaskId ? ACK_TASK_POLICY[templateTaskId] : undefined)
    return {
      key: item.key,
      kind: TODO_KIND[item.kind] ?? (policyId ? 'policy' : 'checklist'),
      title: item.title,
      ...(item.detail ? { detail: item.detail } : {}),
      ...(item.dueOn ? { dueOn: item.dueOn } : {}),
      overdue: item.group === 'overdue',
      now: isDueSoon(item, date),
      statutory: item.statutory,
      ...(policyId ? { policyId } : {}),
      ...(item.refs.checklistId ? { checklistId: item.refs.checklistId } : {}),
      ...(item.refs.taskId ? { taskId: item.refs.taskId } : {}),
      ...(templateTaskId ? { templateTaskId } : {}),
    }
  })
}

export function todoCount(todos: Todo[]): number {
  return todos.filter((t) => t.now).length
}

// ---------------------------------------------------------------------------------------------
// Time off
// ---------------------------------------------------------------------------------------------

export type BalanceLine = {
  policyId: ID
  name: string
  kind: 'vacation' | 'sick'
  /** "127.3 hours" / "Flexible". Hours to one decimal, like every balance in the app. */
  value: string
  /** The same balance in days: "15.9 days" (when tracked). */
  days?: string
  /** "127.3 hours (15.9 days)" / "Flexible", for the printed and copied summary. */
  text: string
  /** Hours free to request, when tracked. */
  hours: number | null
  /** Sick leave before the 90-day wait ends: the hours are granted but usable only from this day. */
  usableFrom?: ISODate
  note?: string
}

function lineFor(row: BalanceRow, person: Person, kind: 'vacation' | 'sick'): BalanceLine {
  const perDay = hoursPerDayFor(person)
  if (row.display !== 'hours' || row.available == null) {
    return {
      policyId: row.policy.id,
      name: row.policy.name,
      kind,
      value: 'Flexible',
      text: 'Flexible',
      hours: null,
      note: 'No balance to track. Agree dates with your manager.',
    }
  }
  // The wait goes in the main line ("5 days, usable from Dec 6"), not in the notes.
  const notes: string[] = []
  if (row.scheduled > 0) notes.push(`${hoursWithDays(row.scheduled, perDay)} already booked`)
  if (row.pending > 0) notes.push(`${hoursWithDays(row.pending, perDay)} waiting for approval`)
  if (row.capReached) notes.push('At the cap, so earning is paused')
  const available = Math.max(0, row.available)
  return {
    policyId: row.policy.id,
    name: row.policy.name,
    kind,
    value: hoursText(available),
    days: daysFromHours(available, perDay),
    text: hoursWithDays(available, perDay),
    hours: row.available,
    ...(row.usableFrom ? { usableFrom: row.usableFrom } : {}),
    ...(notes.length ? { note: notes.join('. ') + '.' } : {}),
  }
}

/** "5 days available" or, before the wait ends, "5 days, usable from Dec 6, 2026". */
export function availabilityText(b: Pick<BalanceLine, 'days' | 'usableFrom'>, amount = b.days): string {
  const lead = amount ? `${amount}` : ''
  if (b.usableFrom) return `${lead ? `${lead}, usable` : 'Usable'} from ${fmtDate(b.usableFrom)}`
  return lead ? `${lead} available` : 'available'
}

/** Vacation and California sick leave, kept separate (sick leave is never paid out and needs no reason). */
export function vacationAndSick(db: DB, personId: ID, date: ISODate): { vacation?: BalanceLine; sick?: BalanceLine } {
  const person = getPerson(db, personId)
  if (!person) return {}
  const rows = balances(db, personId, date)
  const vac = rows.find((r) => r.policy.kind === 'vacation' || r.policy.kind === 'flexible_vacation')
  const sick = rows.find((r) => r.policy.kind === 'sick')
  return {
    ...(vac ? { vacation: lineFor(vac, person, 'vacation') } : {}),
    ...(sick ? { sick: lineFor(sick, person, 'sick') } : {}),
  }
}

export type MyTimeOff = { from: ISODate; to: ISODate; label: string; status: 'approved' | 'pending' | 'leave' }

/** The person's next booked time off or leave that has not ended yet. */
export function nextTimeOff(db: DB, personId: ID, date: ISODate): MyTimeOff | null {
  const items: MyTimeOff[] = []
  for (const r of db.timeOffRequests) {
    if (r.personId !== personId || (r.status !== 'approved' && r.status !== 'pending') || r.endDate < date) continue
    const policy = db.timeOffPolicies.find((p) => p.id === r.policyId)
    items.push({ from: r.startDate, to: r.endDate, label: policy?.name ?? 'Time off', status: r.status })
  }
  for (const l of db.leaveCases) {
    if (l.personId !== personId || l.returnedOn || l.endedOn) continue
    const to = l.expectedReturn ? addDays(l.expectedReturn, -1) : l.startDate
    if (to < date && l.expectedReturn) continue
    items.push({ from: l.startDate, to, label: 'Leave', status: 'leave' })
  }
  return items.sort((a, b) => a.from.localeCompare(b.from))[0] ?? null
}

export function upcomingHolidays(db: DB, date: ISODate, limit = 3): Holiday[] {
  return [...db.holidays].filter((h) => h.date >= date).sort((a, b) => a.date.localeCompare(b.date)).slice(0, limit)
}

export type TeammateOut = { personId: ID; name: string; from: ISODate; to: ISODate }

/**
 * Teammates out in [from, to]: approved time off and leave only (pending requests are private), with no
 * type, so every view can show it ("Out").
 */
export function teammatesOut(db: DB, personId: ID | null, from: ISODate, to: ISODate): TeammateOut[] {
  const byPerson = new Map<ID, TeammateOut>()
  for (const e of whoIsOut(db, from, to)) {
    if (e.personId === personId) continue
    if (e.status !== 'approved' && e.status !== 'leave') continue
    const p = getPerson(db, e.personId)
    if (!p || !(isEmployedOn(p, from) || isEmployedOn(p, to))) continue
    const prev = byPerson.get(e.personId)
    if (prev) {
      if (e.from < prev.from) prev.from = e.from
      if (e.to > prev.to) prev.to = e.to
    } else byPerson.set(e.personId, { personId: e.personId, name: fullName(p), from: e.from, to: e.to })
  }
  return [...byPerson.values()].sort((a, b) => a.from.localeCompare(b.from) || a.name.localeCompare(b.name))
}

/** Teammates whose start date falls in the date's calendar month (other than the person), soonest first. */
export function startingThisMonth(db: DB, personId: ID | null, date: ISODate): Person[] {
  const month = date.slice(0, 7)
  return db.people
    .filter((p) => p.id !== personId && p.startDate.slice(0, 7) === month && !(p.endDate && p.endDate < p.startDate))
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
}

/** The next teammate to start after this month, within 60 days, for an empty "starting this month". */
export function nextStarter(db: DB, personId: ID | null, date: ISODate): Person | undefined {
  const monthEnd = `${date.slice(0, 7)}-31`
  const limit = addDays(date, 60)
  return db.people
    .filter((p) => p.id !== personId && p.startDate > monthEnd && p.startDate <= limit && !p.endDate)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))[0]
}

// ---------------------------------------------------------------------------------------------
// Equity headline (the cliff countdown)
// ---------------------------------------------------------------------------------------------

export type EquityHeadline = {
  status: GrantSummary['status']
  /** Plain headline with no share counts: 'Grant awaiting board consent', 'Cliff in 23 days'. */
  title: string
  /** Days until the next cliff while it is ahead. */
  cliffDays?: number
  cliffOn?: ISODate
  cliffShares?: number
  nextVest?: { date: ISODate; shares: number }
  totalShares: number
  vested: number
  vestingStart?: ISODate
}

/** Null when the person has no grants (and none reserved). */
export function equityHeadline(db: DB, personId: ID, date: ISODate): EquityHeadline | null {
  const s = grantSummary(db, personId, date)
  if (s.status === 'none') return null
  const cliffAhead = s.cliff && !s.cliff.passed ? s.cliff : null
  const cliffDays = cliffAhead ? daysBetween(date, cliffAhead.date) : undefined
  const countdown = (d: number) => (d === 0 ? 'Cliff today' : d === 1 ? 'Cliff tomorrow' : `Cliff in ${num(d)} days`)
  let title: string
  switch (s.status) {
    case 'reserved':
      title = 'Options reserved in your offer'
      break
    case 'awaiting_board':
      title = 'Grant awaiting board consent'
      break
    case 'pre_cliff':
      title = cliffDays != null ? countdown(cliffDays) : 'No options vested yet'
      break
    case 'vesting':
      title = cliffDays != null ? countdown(cliffDays) : s.nextVest ? `Next vest ${daysAwayText(date, s.nextVest.date)}` : 'Vesting monthly'
      break
    case 'fully_vested':
      title = 'Fully vested'
      break
    case 'leaving':
      // A last day is set and still ahead: vesting stops there.
      title = s.exit ? `Vesting stops ${fmtDay(s.exit.lastDay)}` : 'Vesting stops on the last day'
      break
    default:
      title = 'Vested options kept after leaving'
  }
  const first = s.grants[0]
  return {
    status: s.status,
    title,
    ...(cliffAhead ? { cliffDays, cliffOn: cliffAhead.date, cliffShares: cliffAhead.shares } : {}),
    ...(s.nextVest ? { nextVest: s.nextVest } : {}),
    totalShares: s.totalShares,
    vested: s.vested,
    ...(first ? { vestingStart: first.vestingStart } : {}),
  }
}

// ---------------------------------------------------------------------------------------------
// Pay and band
// ---------------------------------------------------------------------------------------------

/** The placeholder workspaces started before 2026-10-11 stored as the provider name (it names nobody). */
const PROVIDER_PLACEHOLDER = 'Your payroll or PEO provider'

/**
 * The payroll or PEO provider's name for 'pay stubs live with ...' lines, or null when none is set:
 * Start fresh leaves it empty, and older workspaces stored the placeholder as the name.
 */
export function payrollProviderName(db: Pick<DB, 'company'>): string | null {
  const name = db.company.payrollProvider?.name?.trim()
  return name && name !== PROVIDER_PLACEHOLDER ? name : null
}

export type MyPay = {
  record: CompRecord
  /** Annual base (hourly x hours x 52 for hourly pay). */
  base: number
  band?: Band
  /** 'Mid band' etc. */
  bandText?: string
  /** 0..1 inside the band (clamped), for a position meter. */
  position?: number
}

export function myPay(db: DB, personId: ID, date: ISODate): MyPay | null {
  const person = getPerson(db, personId)
  if (!person) return null
  const record = currentComp(db, personId, date) ?? compOrFirst(db, personId, date)
  if (!record) return null
  const base = annualBase(record, person.hoursPerWeek)
  const band = bandForPerson(db, person, date)
  if (!band) return { record, base }
  const span = band.max - band.min
  const position = span > 0 ? Math.max(0, Math.min(1, (base - band.min) / span)) : 0.5
  return { record, base, band, bandText: bandLabel(base, band), position }
}

// ---------------------------------------------------------------------------------------------
// Printable summary
// ---------------------------------------------------------------------------------------------

export type SummaryModel = {
  name: string
  title: string
  hireNumber: number
  startDate: ISODate
  tenure: string
  manager: string
  location: string
  level: string
  workEmail: string
  companyName: string
  date: ISODate
  pay: { payType: 'salary' | 'hourly'; base: number; hourlyRate?: number; variablePct?: number } | null
  band: { min: number; max: number; text?: string } | null
  equity: EquityHeadline | null
  balances: BalanceLine[]
  nextTimeOff: MyTimeOff | null
  holidays: Holiday[]
  todos: Todo[]
  emergencyContacts: EmergencyContact[]
}

export function summaryModel(db: DB, personId: ID, date: ISODate, now: ISODateTime): SummaryModel | null {
  const person = getPerson(db, personId)
  if (!person) return null
  const pay = myPay(db, personId, date)
  const { vacation, sick } = vacationAndSick(db, personId, date)
  const year = date.slice(0, 4)
  return {
    name: fullName(person),
    title: pay?.record.title ?? person.title,
    hireNumber: person.hireNumber,
    startDate: person.startDate,
    tenure: tenureText(person.startDate, date),
    manager: person.managerId ? personNameById(db, person.managerId, '') : '',
    location: locationName(db, person.locationId),
    level: levelLabel(db, pay?.record.levelId ?? person.levelId),
    workEmail: person.workEmail || 'Not set',
    companyName: db.company.name,
    date,
    pay: pay
      ? {
          payType: pay.record.payType,
          base: pay.base,
          ...(pay.record.hourlyRate != null ? { hourlyRate: pay.record.hourlyRate } : {}),
          ...(pay.record.variablePct ? { variablePct: pay.record.variablePct } : {}),
        }
      : null,
    band: pay?.band ? { min: pay.band.min, max: pay.band.max, ...(pay.bandText ? { text: pay.bandText } : {}) } : null,
    equity: equityHeadline(db, personId, date),
    balances: [vacation, sick].filter((b): b is BalanceLine => !!b),
    nextTimeOff: nextTimeOff(db, personId, date),
    holidays: db.holidays.filter((h) => h.date >= date && h.date.slice(0, 4) <= String(Number(year) + 1)).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6),
    todos: myTodos(db, personId, date, now),
    emergencyContacts: person.emergencyContacts,
  }
}

const money0 = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`

function payLine(m: SummaryModel, hide: boolean): string {
  if (!m.pay) return 'Not recorded'
  if (hide) return 'Hidden (privacy blur is on)'
  const base = m.pay.payType === 'hourly' && m.pay.hourlyRate != null ? `$${m.pay.hourlyRate.toFixed(2)} an hour` : `${money0(m.pay.base)} a year`
  return m.pay.variablePct ? `${base}, plus ${Math.round(m.pay.variablePct * 100)}% variable at target` : base
}

function equityLines(m: SummaryModel, hide: boolean): string[] {
  const e = m.equity
  if (!e) return []
  const shares = (n: number) => (hide ? 'hidden' : num(n))
  const lines = [e.title]
  lines.push(`Options: ${shares(e.totalShares)} total, ${shares(e.vested)} vested`)
  if (e.cliffOn && e.cliffShares != null) lines.push(`Cliff: ${fmtDate(e.cliffOn)} (${shares(e.cliffShares)} options vest)`)
  if (e.nextVest && e.status !== 'awaiting_board') lines.push(`Next vest: ${fmtDate(e.nextVest.date)} (${shares(e.nextVest.shares)} options)`)
  return lines
}

/** "127.3 hours (15.9 days) available." or, before the sick leave wait ends, "40 hours (5 days), usable from Dec 6, 2026." */
function balanceSentence(b: BalanceLine): string {
  const main = b.hours == null ? b.text : availabilityText(b, b.text)
  return b.note ? `${main}. ${b.note}` : `${main}.`
}

/** 'All caught up', or 'Nothing due in the next 30 days (3 tasks later)' when only later tasks are left. */
export function nothingDueText(todos: Todo[]): string {
  const later = todos.filter((t) => !t.now).length
  return later ? `Nothing due in the next ${SOON_DAYS} days (${plural(later, 'task')} later)` : 'All caught up'
}

function todoLine(t: Todo): string {
  const due = t.dueOn ? (t.overdue ? `was due ${fmtDate(t.dueOn)}` : `due ${fmtDate(t.dueOn)}`) : ''
  return due ? `${t.title} (${due})` : t.title
}

/** Plain-text summary for Copy. Amounts are left out when `hideAmounts` (privacy blur) is on. */
export function summaryText(m: SummaryModel, opts: { hideAmounts?: boolean } = {}): string {
  const hide = !!opts.hideAmounts
  const out: string[] = []
  out.push(`My summary: ${m.name}`)
  out.push(`${m.companyName}, as of ${fmtDate(m.date)}`)
  out.push('')
  out.push('Job')
  out.push(`${m.title}${m.level ? ` (${m.level})` : ''}, employee #${m.hireNumber}`)
  out.push(`Started ${fmtDate(m.startDate)} (${m.tenure})`)
  if (m.manager) out.push(`Manager: ${m.manager}`)
  if (m.location) out.push(`Location: ${m.location}`)
  out.push(`Work email: ${m.workEmail}`)
  out.push('')
  out.push('Pay')
  out.push(`Base: ${payLine(m, hide)}`)
  if (m.band) out.push(`Pay band for my position: ${hide ? 'hidden' : `${money0(m.band.min)} to ${money0(m.band.max)}`}`)
  const eq = equityLines(m, hide)
  if (eq.length) {
    out.push('')
    out.push('Equity')
    out.push(...eq)
  }
  out.push('')
  out.push('Time off')
  for (const b of m.balances) out.push(`${b.name}: ${balanceSentence(b)}`)
  out.push(`Next time off: ${m.nextTimeOff ? `${rangeText(m.nextTimeOff.from, m.nextTimeOff.to, m.date)}${m.nextTimeOff.status === 'pending' ? ' (waiting for approval)' : ''}` : 'Nothing booked'}`)
  if (m.holidays.length) out.push(`Upcoming holidays: ${m.holidays.map((h) => `${h.name} ${dayText(h.date, m.date)}`).join('; ')}`)
  out.push('')
  out.push('My tasks')
  const todos = m.todos.filter((t) => t.now)
  if (todos.length) for (const t of todos) out.push(`- ${todoLine(t)}`)
  else out.push(nothingDueText(m.todos))
  out.push('')
  out.push('Emergency contacts')
  if (m.emergencyContacts.length) {
    for (const c of m.emergencyContacts) out.push(`- ${c.name} (${c.relation}), ${c.phone}${c.sb294Notify ? ', notify if I am arrested or detained at work' : ''}`)
  } else out.push('None added yet')
  return out.join('\n')
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

/** Body HTML for printHTML. Everything is escaped. */
export function summaryHTML(m: SummaryModel, opts: { hideAmounts?: boolean } = {}): string {
  const hide = !!opts.hideAmounts
  const row = (label: string, value: string) => `<tr><th style="width:34%">${esc(label)}</th><td>${esc(value)}</td></tr>`
  const parts: string[] = []
  parts.push(`<h1>My summary: ${esc(m.name)}</h1>`)
  parts.push(`<p class="muted">${esc(m.companyName)}, as of ${esc(fmtDate(m.date))}. Personal copy; keep it somewhere private.</p>`)
  parts.push('<h2>Job</h2><table>')
  parts.push(row('Title', `${m.title}${m.level ? ` (${m.level})` : ''}`))
  parts.push(row('Employee number', `#${m.hireNumber}`))
  parts.push(row('Start date', `${fmtDate(m.startDate)} (${m.tenure})`))
  if (m.manager) parts.push(row('Manager', m.manager))
  if (m.location) parts.push(row('Location', m.location))
  parts.push(row('Work email', m.workEmail))
  parts.push('</table><h2>Pay</h2><table>')
  parts.push(row('Base', payLine(m, hide)))
  if (m.band) parts.push(row('Pay band for my position', hide ? 'Hidden (privacy blur is on)' : `${money0(m.band.min)} to ${money0(m.band.max)}`))
  parts.push('</table>')
  const eq = equityLines(m, hide)
  if (eq.length) {
    parts.push('<h2>Equity</h2><table>')
    parts.push(row('Status', eq[0]))
    for (const l of eq.slice(1)) {
      const [label, ...rest] = l.split(': ')
      parts.push(row(label, rest.join(': ')))
    }
    parts.push('</table><p class="muted">Options are a planning figure here; the cap table tool is the record.</p>')
  }
  parts.push('<h2>Time off</h2><table>')
  for (const b of m.balances) parts.push(row(b.name, balanceSentence(b)))
  parts.push(
    row(
      'Next time off',
      m.nextTimeOff ? `${rangeText(m.nextTimeOff.from, m.nextTimeOff.to, m.date)}${m.nextTimeOff.status === 'pending' ? ' (waiting for approval)' : ''}` : 'Nothing booked',
    ),
  )
  parts.push('</table>')
  if (m.holidays.length) {
    parts.push('<h2>Upcoming holidays</h2><table>')
    for (const h of m.holidays) parts.push(row(dayText(h.date, m.date), h.name))
    parts.push('</table>')
  }
  parts.push('<h2>My tasks</h2>')
  const todos = m.todos.filter((t) => t.now)
  parts.push(todos.length ? `<ul>${todos.map((t) => `<li>${esc(todoLine(t))}</li>`).join('')}</ul>` : `<p>${esc(nothingDueText(m.todos))}.</p>`)
  parts.push('<h2>Emergency contacts</h2>')
  parts.push(
    m.emergencyContacts.length
      ? `<table>${m.emergencyContacts.map((c) => row(`${c.name} (${c.relation})`, `${c.phone}${c.sb294Notify ? '. Notify if I am arrested or detained at work (SB 294).' : ''}`)).join('')}</table>`
      : '<p>None added yet.</p>',
  )
  return parts.join('\n')
}
