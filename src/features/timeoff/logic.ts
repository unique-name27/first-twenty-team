// Pure helpers for the time off feature: calendar grids, quick date picks, range summaries, leave
// case display and the back-from-leave mutation (the designation notice comes from src/domain/lifecycle.ts).
// The rules themselves (hours, balances, approvals, eligibility) live in src/domain/timeoff.ts and
// src/domain/lifecycle.ts; this file only shapes them for the screens.
import type { Draft } from 'immer'
import { canSeePerson, canSeeTimeOffDetail } from '@/domain/access'
import { setTaskStatus } from '@/domain/checklists/actions'
import { TASK_IDS } from '@/domain/checklists/templates'
import { firstName, fullName, isEmployedOn } from '@/domain/people'
import { hoursLabel, type OutEntry, workdayList } from '@/domain/timeoff'
import type { DB, Holiday, ID, LeaveCase, Person, TimeOffKind, TimeOffRequest, Viewer } from '@/domain/types'
import { addDays, addMonths, daysBetween, fmtDate, fmtDay, fmtShort, type ISODate, isWeekday, parseDate } from '@/lib/dates'
import { buildICS } from '@/lib/ics'
import { logActivity } from '@/store/draft'

// ---------------------------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------------------------

/** First day of the month the date falls in. */
export function monthStart(d: ISODate): ISODate {
  return `${d.slice(0, 7)}-01`
}

/** Last day of the month the date falls in. */
export function monthEnd(d: ISODate): ISODate {
  return addDays(addMonths(monthStart(d), 1), -1)
}

/** Monday-first weeks covering the whole month (5 or 6 rows of 7 dates, padded with the neighbors). */
export function monthWeeks(month: ISODate): ISODate[][] {
  const first = monthStart(month)
  const last = monthEnd(month)
  const dow = parseDate(first).getDay() // 0 = Sunday
  let cur = addDays(first, -((dow + 6) % 7))
  const weeks: ISODate[][] = []
  while (cur <= last) {
    const week: ISODate[] = []
    for (let i = 0; i < 7; i++) week.push(addDays(cur, i))
    weeks.push(week)
    cur = addDays(cur, 7)
  }
  return weeks
}

/** Monday of the week the date falls in. */
export function weekMonday(d: ISODate): ISODate {
  const dow = parseDate(d).getDay()
  return addDays(d, -((dow + 6) % 7))
}

/** The same day in the next (or previous) month, clamped to the month's last day. */
export function shiftMonth(d: ISODate, n: number): ISODate {
  return addMonths(d, n)
}

function holidayDates(holidays: ReadonlyArray<Pick<Holiday, 'date'>>): Set<ISODate> {
  return new Set(holidays.map((h) => h.date))
}

export function isWorkday(d: ISODate, holidays: ReadonlyArray<Pick<Holiday, 'date'>>): boolean {
  return isWeekday(d) && !holidays.some((h) => h.date === d)
}

/**
 * People out on each workday in [from, to]. Weekends and company holidays are left out: everyone is
 * off then, so listing names would only add noise.
 */
export function outByDay(entries: OutEntry[], from: ISODate, to: ISODate, holidays: ReadonlyArray<Pick<Holiday, 'date'>>): Map<ISODate, OutEntry[]> {
  const skip = holidayDates(holidays)
  const map = new Map<ISODate, OutEntry[]>()
  for (const e of entries) {
    const start = e.from > from ? e.from : from
    const end = e.to < to ? e.to : to
    for (let d = start; d <= end; d = addDays(d, 1)) {
      if (!isWeekday(d) || skip.has(d)) continue
      const list = map.get(d) ?? []
      list.push(e)
      map.set(d, list)
    }
  }
  return map
}

// ---------------------------------------------------------------------------------------------
// Quick date picks
// ---------------------------------------------------------------------------------------------

export function nextWorkdayOnOrAfter(d: ISODate, holidays: ReadonlyArray<Pick<Holiday, 'date'>>): ISODate {
  let cur = d
  while (!isWorkday(cur, holidays)) cur = addDays(cur, 1)
  return cur
}

/**
 * 'In N weeks' for a start date: the Monday on or after today + N weeks (the next workday when that Monday is
 * a holiday), so the chip lands about N weeks out, the way the offboarding 'In 2 weeks (Fri)' chip does.
 */
export function startInWeeks(t: ISODate, weeks: number, holidays: ReadonlyArray<Pick<Holiday, 'date'>>): ISODate {
  const target = addDays(t, 7 * weeks)
  const monday = weekMonday(target) === target ? target : addDays(weekMonday(target), 7)
  return nextWorkdayOnOrAfter(monday, holidays)
}

/** Start date chips for a leave case: Today, Next Mon, then 'In 2 weeks (Mon)' and on, labeled with the weekday they land on. */
export function leaveStartPresets(t: ISODate, holidays: ReadonlyArray<Pick<Holiday, 'date'>>): Array<{ label: string; date: ISODate }> {
  const weekday = (d: ISODate) => fmtDay(d).split(',')[0]
  return [
    { label: 'Today', date: t },
    { label: 'Next Mon', date: addDays(weekMonday(t), 7) },
    ...[2, 4, 6].map((n) => {
      const date = startInWeeks(t, n, holidays)
      return { label: `In ${n} weeks (${weekday(date)})`, date }
    }),
  ]
}

/**
 * Start date chips for a hire or a rehire: Next Mon, then 'In 2 weeks (Mon)' and 'In 3 weeks (Mon)' on the Monday
 * on or after today plus N weeks (startInWeeks), labeled with the weekday they land on, as the leave chips are.
 */
export function hireStartPresets(t: ISODate, holidays: ReadonlyArray<Pick<Holiday, 'date'>>): Array<{ label: string; date: ISODate }> {
  const weekday = (d: ISODate) => fmtDay(d).split(',')[0]
  return [
    { label: 'Next Mon', date: addDays(weekMonday(t), 7) },
    ...[2, 3].map((n) => {
      const date = startInWeeks(t, n, holidays)
      return { label: `In ${n} weeks (${weekday(date)})`, date }
    }),
  ]
}

export function lastWorkdayOnOrBefore(d: ISODate, holidays: ReadonlyArray<Pick<Holiday, 'date'>>): ISODate {
  let cur = d
  while (!isWorkday(cur, holidays)) cur = addDays(cur, -1)
  return cur
}

export type DatePreset = { label: string; date: ISODate }
export type RangePreset = { label: string; start: ISODate; end: ISODate }

function dedupe<T extends { label: string }>(list: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>()
  return list.filter((t) => {
    const k = key(t)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * Time off kinds that are usually recorded on the day or after it (an illness or a death is not planned),
 * so their date chips lead with Today and Yesterday.
 */
export function afterTheFactKind(kind: TimeOffKind): boolean {
  return kind === 'sick' || kind === 'bereavement' || kind === 'reproductive_loss'
}

/**
 * Start date chips: Today and Tomorrow when they are workdays, then Next Mon and Next Fri.
 * With `past` (sick leave and other after-the-fact kinds) the chips lead with Today (when it is a workday)
 * and the last workday before it: "Yesterday", or "Last Fri" after a weekend or holiday.
 */
export function startPresets(todayISO: ISODate, holidays: ReadonlyArray<Pick<Holiday, 'date'>>, opts: { past?: boolean } = {}): DatePreset[] {
  const out: DatePreset[] = []
  if (isWorkday(todayISO, holidays)) out.push({ label: 'Today', date: todayISO })
  if (opts.past) {
    const yesterday = addDays(todayISO, -1)
    const prev = lastWorkdayOnOrBefore(yesterday, holidays)
    out.push({ label: prev === yesterday ? 'Yesterday' : `Last ${WEEKDAY_SHORT[parseDate(prev).getDay()]}`, date: prev })
  }
  const tomorrow = addDays(todayISO, 1)
  if (isWorkday(tomorrow, holidays)) out.push({ label: 'Tomorrow', date: tomorrow })
  const nextMon = addDays(weekMonday(todayISO), 7)
  out.push({ label: 'Next Mon', date: nextWorkdayOnOrAfter(nextMon, holidays) })
  const thisFri = addDays(weekMonday(todayISO), 4)
  const nextFri = thisFri > todayISO ? thisFri : addDays(thisFri, 7)
  // A Friday holiday can pull the chip back to today or earlier; then the next week's Friday is the one ahead.
  let fri = lastWorkdayOnOrBefore(nextFri, holidays)
  if (fri <= todayISO) fri = lastWorkdayOnOrBefore(addDays(nextFri, 7), holidays)
  out.push({ label: 'Next Fri', date: fri })
  return dedupe(out, (p) => p.date)
}

/** End date chips relative to the start: Same day, End of week, 1 week, 2 weeks. */
export function endPresets(start: ISODate, holidays: ReadonlyArray<Pick<Holiday, 'date'>>): DatePreset[] {
  const fri = addDays(weekMonday(start), 4)
  const out: DatePreset[] = [{ label: 'Same day', date: start }]
  if (fri > start) out.push({ label: 'End of week', date: lastWorkdayOnOrBefore(fri, holidays) })
  out.push({ label: '1 week', date: lastWorkdayOnOrBefore(addDays(start, 6), holidays) })
  out.push({ label: '2 weeks', date: lastWorkdayOnOrBefore(addDays(start, 13), holidays) })
  return dedupe(
    out.filter((p) => p.date >= start),
    (p) => p.date,
  )
}

/**
 * One-tap ranges: next week (Mon to Fri) and Thanksgiving week while it is still ahead. Workday counts
 * skip the holidays inside them, so Thanksgiving week costs 3 days, not 5.
 */
export function rangePresets(todayISO: ISODate, holidays: ReadonlyArray<Pick<Holiday, 'date' | 'name'>>): RangePreset[] {
  const out: RangePreset[] = []
  const nextMon = addDays(weekMonday(todayISO), 7)
  out.push({ label: 'Next week', start: nextMon, end: addDays(nextMon, 4) })
  const thanks = holidays
    .filter((h) => /^thanksgiving/i.test(h.name) && h.date > todayISO)
    .sort((a, b) => a.date.localeCompare(b.date))[0]
  if (thanks) {
    const mon = weekMonday(thanks.date)
    // Only while the whole week is still ahead and within about four months.
    if (mon > todayISO && daysBetween(todayISO, mon) <= 120) out.push({ label: 'Thanksgiving week', start: mon, end: addDays(mon, 4) })
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Range summary
// ---------------------------------------------------------------------------------------------

export type RangeSummary = {
  workdays: number
  hours: number
  /** "3 workdays, 24 hours" */
  text: string
  holidaysSkipped: Array<Pick<Holiday, 'date' | 'name'>>
  weekendDays: number
}

function trim(n: number): string {
  return String(Math.round(n * 100) / 100)
}

/** Workdays and hours a range uses (weekends and company holidays skipped; a half day on the last workday). */
export function rangeSummary(
  start: ISODate,
  end: ISODate,
  holidays: ReadonlyArray<Pick<Holiday, 'date' | 'name'>>,
  partial: 'am' | 'pm' | undefined,
  hoursPerDay: number,
): RangeSummary {
  if (end < start) return { workdays: 0, hours: 0, text: 'The end date is before the start date', holidaysSkipped: [], weekendDays: 0 }
  const list = workdayList(start, end, holidays.map((h) => h.date))
  const days = list.length === 0 ? 0 : partial ? list.length - 0.5 : list.length
  const hours = Math.round(days * hoursPerDay * 100) / 100
  let weekendDays = 0
  for (let d = start; d <= end; d = addDays(d, 1)) if (!isWeekday(d)) weekendDays += 1
  const holidaysSkipped = holidays.filter((h) => h.date >= start && h.date <= end && isWeekday(h.date)).sort((a, b) => a.date.localeCompare(b.date))
  const text =
    days === 0
      ? 'No workdays in that range'
      : `${trim(days)} ${days === 1 ? 'workday' : 'workdays'}, ${trim(hours)} ${hours === 1 ? 'hour' : 'hours'}`
  return { workdays: days, hours, text, holidaysSkipped, weekendDays }
}

/** "Fri, Oct 30" or "Mon, Oct 12 to Fri, Oct 16" (adds the year when the range crosses one). */
export function rangeText(start: ISODate, end: ISODate): string {
  if (start === end) return fmtDay(start)
  if (start.slice(0, 4) !== end.slice(0, 4)) return `${fmtDay(start)}, ${start.slice(0, 4)} to ${fmtDay(end)}, ${end.slice(0, 4)}`
  return `${fmtDay(start)} to ${fmtDay(end)}`
}

/** Short range for tight spaces: "Oct 30" or "Oct 12 to 16" or "Dec 21 to Jan 8". */
export function shortRange(start: ISODate, end: ISODate): string {
  if (start === end) return fmtShort(start)
  if (start.slice(0, 7) === end.slice(0, 7)) return `${fmtShort(start)} to ${Number(end.slice(8, 10))}`
  return `${fmtShort(start)} to ${fmtShort(end)}`
}

/** Hours with days in brackets, to one decimal: "24 hours (3 days)". The one formatter lives in src/lib/format. */
export { hoursWithDays } from '@/lib/format'

export { hoursLabel }

// ---------------------------------------------------------------------------------------------
// Labels and privacy
// ---------------------------------------------------------------------------------------------

export const LEAVE_KIND_LABEL: Record<LeaveCase['kind'], string> = {
  cfra: 'CFRA leave',
  pdl: 'Pregnancy disability leave',
  bonding: 'Baby bonding (CFRA)',
  military: 'Military leave',
  other: 'Other leave',
}

/**
 * Who may open a leave case from the leave sheet. Admin opens one for anyone; a person requests family or
 * medical leave for themselves (the 5-business-day response clock starts at their request); nobody else can.
 */
export type LeaveSheetMode = 'admin' | 'self' | 'none'

export function leaveSheetMode(viewer: Pick<Viewer, 'role' | 'personId'>, personId: ID | undefined): LeaveSheetMode {
  if (viewer.role === 'admin') return 'admin'
  if (personId && viewer.personId === personId) return 'self'
  return 'none'
}

/** Leave kinds each mode offers: Admin records any kind; a person requests CFRA, pregnancy disability or bonding. */
export function leaveKindsFor(mode: LeaveSheetMode): Array<LeaveCase['kind']> {
  if (mode === 'admin') return ['bonding', 'cfra', 'pdl', 'military', 'other']
  if (mode === 'self') return ['bonding', 'cfra', 'pdl']
  return []
}

/** The one date rule for opening a leave case anywhere: a first day, and an expected first day back after it. */
export function leaveDatesValid(startDate: ISODate | null | undefined, expectedReturn: ISODate | null | undefined): boolean {
  return !!startDate && !!expectedReturn && expectedReturn > startDate
}

/** Expected first day back prefilled when the first day is picked: 12 weeks later (the CFRA maximum), on a workday. */
export function defaultLeaveReturn(startDate: ISODate, holidays: ReadonlyArray<Pick<Holiday, 'date'>>): ISODate {
  return nextWorkdayOnOrAfter(addDays(startDate, 84), holidays)
}

/**
 * The longest note a time off request or a leave case takes (maxLength). A note is a line or two for the approver
 * or about coverage; the cap keeps the record well under what the server takes for one record.
 */
export const TIMEOFF_NOTE_MAX_CHARS = 1_000

/** '850 of 1,000 characters' once a note gets near the limit, else null. */
export function noteCountText(text: string, max = TIMEOFF_NOTE_MAX_CHARS): string | null {
  return text.length >= max * 0.8 ? `${text.length.toLocaleString('en-US')} of ${max.toLocaleString('en-US')} characters` : null
}

/** Policy kinds whose request never asks for a note or reason (sick leave, and leave kept confidential by law). */
export function noReasonKind(kind: TimeOffKind): boolean {
  return kind === 'sick' || kind === 'bereavement' || kind === 'reproductive_loss'
}

/** Last day of a leave case (the day before the return), or undefined while open-ended. */
export function leaveLastDay(l: Pick<LeaveCase, 'returnedOn' | 'endedOn' | 'expectedReturn'>): ISODate | undefined {
  if (l.returnedOn) return addDays(l.returnedOn, -1)
  if (l.endedOn) return l.endedOn
  if (l.expectedReturn) return addDays(l.expectedReturn, -1)
  return undefined
}

export type LeavePhase = 'upcoming' | 'on_leave' | 'returned' | 'ended'

export function leavePhase(l: LeaveCase, todayISO: ISODate): LeavePhase {
  if (l.returnedOn && l.returnedOn <= todayISO) return 'returned'
  if (l.endedOn && l.endedOn < todayISO) return 'ended'
  if (l.startDate > todayISO) return 'upcoming'
  return 'on_leave'
}

/**
 * What a viewer reads for a leave: Admin and the person see the type; a manager in the person's line sees
 * "Leave, back Jan 11"; everyone else sees only "Out".
 */
export function leaveText(l: LeaveCase, access: { type: boolean; line: boolean }): string {
  const back = l.returnedOn ?? l.expectedReturn
  const backText = back ? `back ${fmtShort(back)}` : 'return date not set'
  if (access.type) return `${LEAVE_KIND_LABEL[l.kind]}, ${backText}`
  if (access.line) return `Leave, ${backText}`
  return 'Out'
}

export type NoticeState = { state: 'sent' | 'overdue' | 'due_soon' | 'due' | 'none'; text: string }

/** Designation notice status: sent, overdue (statutory, shows red), due within 3 days, or due later. */
export function designationState(l: Pick<LeaveCase, 'designationNoticeDueOn' | 'designationNoticeSentOn'>, todayISO: ISODate): NoticeState {
  if (l.designationNoticeSentOn) return { state: 'sent', text: `Sent ${fmtDate(l.designationNoticeSentOn)}` }
  const due = l.designationNoticeDueOn
  if (!due) return { state: 'none', text: 'No notice due' }
  const days = daysBetween(todayISO, due)
  if (days < 0) return { state: 'overdue', text: `Overdue since ${fmtDay(due)}` }
  if (days <= 3) return { state: 'due_soon', text: days === 0 ? `Due today, ${fmtDay(due)}` : `Due ${fmtDay(due)}` }
  return { state: 'due', text: `Due ${fmtDay(due)}` }
}

export type EntryView = {
  /** False when the viewer should not see the entry at all (someone else's pending request). */
  visible: boolean
  /** "Vacation", "Baby bonding (CFRA), back Jan 11", "Leave, back Jan 11", "Time off" or "Out". */
  text: string
  /** The viewer may see the type and status (pending or approved). */
  detail: boolean
  pending: boolean
}

/**
 * How one who's-out entry reads for a viewer (docs/SPEC.md, Viewing as rules): Admin and the person see the
 * type; a manager sees types for their reporting line except confidential kinds (bereavement and reproductive
 * loss read "Time off"); leave reads "Leave, back <date>" for the manager line; everyone else reads "Out".
 * Pending requests show only to people who could see their detail.
 */
export function entryView(db: DB, viewer: Viewer, e: OutEntry): EntryView {
  const self = !!viewer.personId && viewer.personId === e.personId
  if (e.kind === 'leave') {
    const leave = db.leaveCases.find((l) => l.id === e.leaveCaseId)
    const type = canSeePerson(viewer, db, e.personId, 'leave')
    const line = canSeePerson(viewer, db, e.personId, 'timeoff')
    const text = leave ? leaveText(leave, { type, line }) : type || line ? 'Leave' : 'Out'
    return { visible: true, text, detail: type || line, pending: false }
  }
  const req = e.requestId ? db.timeOffRequests.find((r) => r.id === e.requestId) : undefined
  const detail = req ? canSeeTimeOffDetail(viewer, db, req) : false
  const pending = e.status === 'pending'
  if (!detail) return { visible: !pending, text: 'Out', detail: false, pending: false }
  const confidential = e.kind === 'bereavement' || e.kind === 'reproductive_loss'
  const text = confidential && viewer.role !== 'admin' && !self ? 'Time off' : e.label
  return { visible: true, text, detail: true, pending }
}

/** Who approves a person's time off: their manager, else Admin. */
export function approverLabel(db: Pick<DB, 'people'>, person: Pick<Person, 'managerId'>): string {
  const m = person.managerId ? db.people.find((p) => p.id === person.managerId) : undefined
  return m ? fullName(m) : 'Admin'
}

/**
 * The manager a pending request waits on, by the inbox's rule (src/domain/inbox.ts timeOffItems): for
 * Admin, the person's manager when that manager is still here and is someone else. Null when it waits on
 * the viewer, which is always so outside Admin, and for sick leave before the service wait (Admin's call).
 */
export function waitingOnManager(db: DB, viewer: Pick<Viewer, 'role' | 'personId'>, req: TimeOffRequest, date: ISODate): Person | null {
  if (viewer.role !== 'admin') return null
  if (db.timeOffPolicies.find((p) => p.id === req.policyId)?.autoApprove) return null
  const person = db.people.find((p) => p.id === req.personId)
  const manager = person?.managerId ? db.people.find((p) => p.id === person.managerId) : undefined
  if (!manager || manager.id === viewer.personId || !isEmployedOn(manager, date)) return null
  return manager
}

export type ApprovalGroup = { key: string; label: string; manager?: Person; requests: TimeOffRequest[] }

/**
 * Requests to approve, grouped the way the inbox routes them: "Waiting for you" first (always there, even
 * when empty), then "Waiting on Tomas" for each manager who approves the rest. Admin can still act on those.
 */
export function approvalGroups(db: DB, viewer: Pick<Viewer, 'role' | 'personId'>, requests: TimeOffRequest[], date: ISODate): ApprovalGroup[] {
  const mine: TimeOffRequest[] = []
  const others = new Map<ID, ApprovalGroup>()
  for (const r of requests) {
    const manager = waitingOnManager(db, viewer, r, date)
    if (!manager) {
      mine.push(r)
      continue
    }
    const group = others.get(manager.id) ?? { key: manager.id, label: `Waiting on ${firstName(manager)}`, manager, requests: [] }
    group.requests.push(r)
    others.set(manager.id, group)
  }
  return [{ key: 'you', label: 'Waiting for you', requests: mine }, ...[...others.values()].sort((a, b) => a.label.localeCompare(b.label))]
}

// ---------------------------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------------------------

export function holidaysForYear<T extends Pick<Holiday, 'date'>>(holidays: ReadonlyArray<T>, year: number): T[] {
  const y = String(year)
  return holidays.filter((h) => h.date.startsWith(y)).sort((a, b) => a.date.localeCompare(b.date))
}

/** All-day events for a year of company holidays. */
export function holidaysICS(holidays: ReadonlyArray<Holiday>, companyName: string, year: number): string {
  return buildICS(
    holidaysForYear(holidays, year).map((h) => ({
      uid: `holiday-${h.date}`,
      title: `${h.name} (${companyName} holiday)`,
      date: h.date,
      description: `${companyName} is closed.`,
    })),
    `${companyName} holidays ${year}`,
  )
}

/** Plain text list for Copy: "Thu, Nov 26: Thanksgiving". */
export function holidaysText(holidays: ReadonlyArray<Holiday>, companyName: string, year: number): string {
  const rows = holidaysForYear(holidays, year).map((h) => `${fmtDay(h.date)}: ${h.name}`)
  return [`${companyName} holidays ${year}`, ...rows].join('\n')
}

// ---------------------------------------------------------------------------------------------
// Leave case mutations (Immer drafts)
// ---------------------------------------------------------------------------------------------

function leaveChecklistTask(draft: Draft<DB>, leave: Pick<LeaveCase, 'personId' | 'startDate'>, templateTaskId: ID) {
  const lists = draft.checklists.filter((c) => c.personId === leave.personId && c.kind === 'leave')
  const ordered = [...lists.filter((c) => c.anchorDate === leave.startDate), ...lists.filter((c) => c.anchorDate !== leave.startDate)]
  for (const c of ordered) {
    const t = c.tasks.find((x) => x.templateTaskId === templateTaskId && x.status === 'open')
    if (t) return { checklistId: c.id, taskId: t.id }
  }
  return undefined
}

/**
 * Records the response and designation notice as sent. The one implementation lives in the domain
 * (src/domain/lifecycle.ts) so the timeoff panel, the inbox and the compliance calendar never disagree.
 */
export { markDesignationSent } from '@/domain/lifecycle'

/** Records the return from leave and closes the return-to-work check. Returns false when already recorded. */
export function markReturned(draft: Draft<DB>, leaveId: ID, opts: { date: ISODate; byId?: ID | null }): boolean {
  const leave = draft.leaveCases.find((l) => l.id === leaveId)
  if (!leave || leave.returnedOn) return false
  leave.returnedOn = opts.date
  const task = leaveChecklistTask(draft, leave, TASK_IDS.returnToWork)
  if (task) setTaskStatus(draft, task.checklistId, task.taskId, 'done', { date: opts.date, byId: opts.byId ?? null })
  const person = draft.people.find((p) => p.id === leave.personId)
  logActivity(draft, {
    entityType: 'leave',
    entityId: leave.id,
    relatedId: leave.personId,
    kind: 'leave_returned',
    text: `Recorded ${person ? `${fullName(person)}'s` : 'the'} return from leave on ${fmtDay(opts.date)}`,
  })
  return true
}
