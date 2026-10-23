// Time off: request hours, balances, who's out, approvals, payout at exit and .ics (docs/SPEC.md: TIME OFF,
// LEAVE CASES). Pure functions over the DB plus Immer mutation helpers; every date is a parameter.
//
// Legal basis (docs/LAW.md):
//   w-vacation-payout  Vacation vests as earned, a reasonable accrual cap is allowed, use-it-or-lose-it is not,
//                      and unused vacation is paid at the final rate at separation (Labor Code 227.3).
//   a-psl-1, w-psl-caps  Sick leave: 40 hours or 5 days a year, up front or accrued; use may wait until day 90;
//                      use may be capped at 40 hours or 5 days a year. A full front-load each year needs no carryover.
//   w-psl-separation   Separate sick leave is not paid out at separation.
//   a-bereave-rll-5    Bereavement and reproductive loss leave are confidential, so activity text says "time off".
//                      Both need 30 days of service and allow 5 days per event; reproductive loss is capped at
//                      20 days in 12 months (Gov Code 12945.6, 12945.7). checkRequest warns on each.
import type { Draft } from 'immer'
import { compOrFirst, hourlyRateOf, payPeriodsPerYear } from '@/domain/pay'
import { fullName, headcountOn, priorStint } from '@/domain/people'
import type { DB, ID, Person, TimeOffKind, TimeOffPolicy, TimeOffRequest } from '@/domain/types'
import { addDays, addMonths, daysBetween, fmtDate, fmtDay, type ISODate, isWeekday, nowISO } from '@/lib/dates'
import { hoursText, hoursWithDays } from '@/lib/format'
import { buildICS } from '@/lib/ics'
import { newId } from '@/lib/id'
import { logActivity } from '@/store/draft'

// Helpers are function declarations, not module constants: timeoff.ts imports the store, and the
// sample seed may call these functions while that import cycle is still loading.
function r2(n: number): number {
  return Math.round(n * 100) / 100
}

export type HolidayLike = ISODate | { date: ISODate }

function holidaySet(holidays: ReadonlyArray<HolidayLike>): Set<ISODate> {
  return new Set(holidays.map((h) => (typeof h === 'string' ? h : h.date)))
}

// ---------------------------------------------------------------------------------------------
// Workdays and request hours
// ---------------------------------------------------------------------------------------------

/** Weekdays from start to end, inclusive, skipping the holidays. */
export function workdayList(start: ISODate, end: ISODate, holidays: ReadonlyArray<HolidayLike> = []): ISODate[] {
  if (end < start) return []
  const skip = holidaySet(holidays)
  const out: ISODate[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) if (isWeekday(d) && !skip.has(d)) out.push(d)
  return out
}

/** Count of weekdays from start to end, inclusive, skipping the holidays. */
export function workdays(start: ISODate, end: ISODate, holidays: ReadonlyArray<HolidayLike> = []): number {
  return workdayList(start, end, holidays).length
}

/** Hours in a normal workday for the person: hours per week / 5 (8 for full time, 4.8 at 24 hours a week). */
export function hoursPerDayFor(person: Pick<Person, 'hoursPerWeek'>): number {
  return (person.hoursPerWeek > 0 ? person.hoursPerWeek : 40) / 5
}

/**
 * Hours a request uses: workdays x hours per day. `partial` (am or pm) makes the last workday a half day,
 * so a one-day partial request is half a day.
 */
export function requestHours(
  start: ISODate,
  end: ISODate,
  holidays: ReadonlyArray<HolidayLike> = [],
  partial?: 'am' | 'pm',
  hoursPerDay = 8,
): number {
  const days = workdays(start, end, holidays)
  if (days === 0) return 0
  return r2((partial ? days - 0.5 : days) * hoursPerDay)
}

// ---------------------------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------------------------

/** Does the policy apply to the person on the date (company headcount, work state and who it covers)? */
export function policyAvailable(db: DB, policy: TimeOffPolicy, person: Person, date: ISODate): boolean {
  if (policy.appliesFromHeadcount && headcountOn(db, date) < policy.appliesFromHeadcount) return false
  if (policy.appliesToStates?.length) {
    const state = (person.homeState || db.company.hq.state || '').toUpperCase()
    if (!policy.appliesToStates.some((s) => s.toUpperCase() === state)) return false
  }
  switch (policy.appliesTo) {
    case 'full_time':
      return person.employmentType === 'full_time'
    case 'non_exempt':
      return person.flsa === 'non_exempt'
    case 'exempt':
      return person.flsa === 'exempt'
    default:
      return true
  }
}

export function policiesFor(db: DB, person: Person, date: ISODate): TimeOffPolicy[] {
  return db.timeOffPolicies.filter((p) => policyAvailable(db, p, person, date))
}

/**
 * Hours in words for a person whose workday is `hoursPerDay` long (hoursPerDayFor): "3 days" for whole
 * 8-hour days, "5 days, 24 hours" for whole shorter or longer days, else "40 hours". Policy limits written
 * in days (bereavement's 40 hours = 5 days) use the default of 8.
 */
export function hoursLabel(hours: number, hoursPerDay = 8): string {
  const h = r2(hours)
  const inHours = `${h} ${h === 1 ? 'hour' : 'hours'}`
  if (hoursPerDay > 0 && h >= hoursPerDay) {
    const d = h / hoursPerDay
    const n = Math.round(d)
    if (Math.abs(d - n) < 1e-6) {
      const inDays = `${n} ${n === 1 ? 'day' : 'days'}`
      return Math.abs(hoursPerDay - 8) < 1e-9 ? inDays : `${inDays}, ${inHours}`
    }
  }
  return inHours
}

/**
 * Days of service before use: the policy's usableAfterDays, else the legal minimum for the kind
 * (docs/LAW.md a-bereave-rll-5: 30 days for bereavement and reproductive loss leave; 90 days for organ and
 * bone marrow donor leave, as the default policies describe under Labor Code 1508 to 1510).
 */
export function serviceDaysRequired(policy: Pick<TimeOffPolicy, 'kind' | 'usableAfterDays'>): number | undefined {
  if (policy.usableAfterDays) return policy.usableAfterDays
  switch (policy.kind) {
    case 'bereavement':
    case 'reproductive_loss':
      return 30
    case 'organ_donor':
    case 'bone_marrow_donor':
      return 90
    default:
      return undefined
  }
}

/** The policy's citation, else the statute for kinds with a legal limit. */
function citeFor(policy: TimeOffPolicy): string | undefined {
  if (policy.citation?.label) return policy.citation.label
  switch (policy.kind) {
    case 'bereavement':
      return 'Gov Code 12945.7'
    case 'reproductive_loss':
      return 'Gov Code 12945.6'
    case 'organ_donor':
    case 'bone_marrow_donor':
      return 'Labor Code 1510'
    default:
      return undefined
  }
}

/**
 * Rolling limits in workdays: reproductive loss leave up to 20 days in 12 months (Gov Code 12945.6, docs/LAW.md
 * a-bereave-rll-5); organ donor up to 30 and bone marrow donor up to 5 business days in a year (Labor Code 1510).
 */
function windowLimit(kind: TimeOffKind): { days: number; span: string } | undefined {
  if (kind === 'reproductive_loss') return { days: 20, span: '12 months' }
  if (kind === 'organ_donor') return { days: 30, span: 'a year' }
  if (kind === 'bone_marrow_donor') return { days: 5, span: 'a year' }
  return undefined
}

/**
 * Activity wording: "vacation" for vacation policies, "time off" for every other kind, because activity can
 * be seen outside Admin and leave types stay private (sick leave needs no reason; bereavement and
 * reproductive loss leave are confidential by law).
 */
function policyPhrase(policy: TimeOffPolicy | undefined): string {
  if (!policy || (policy.kind !== 'vacation' && policy.kind !== 'flexible_vacation')) return 'time off'
  const n = policy.name
  return /^[A-Z]{2}/.test(n) ? n : n.charAt(0).toLowerCase() + n.slice(1)
}

/** Leave kinds kept confidential by law (Gov Code 12945.6 and 12945.7(i)): reproductive loss and bereavement. */
export function isConfidentialKind(kind: TimeOffKind): boolean {
  return kind === 'reproductive_loss' || kind === 'bereavement'
}

function datesText(start: ISODate, end: ISODate): string {
  return start === end ? fmtDay(start) : `${fmtDay(start)} to ${fmtDay(end)}`
}

// ---------------------------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------------------------

type DayUse = { date: ISODate; hours: number }

/** A request's hours spread evenly over its workdays. */
function requestDays(db: DB, req: TimeOffRequest): DayUse[] {
  const days = workdayList(req.startDate, req.endDate, db.holidays)
  if (days.length === 0) return req.hours > 0 ? [{ date: req.startDate, hours: req.hours }] : []
  const per = req.hours / days.length
  return days.map((date) => ({ date, hours: per }))
}

function requestsFor(db: DB, personId: ID, policyId: ID, status: TimeOffRequest['status']): TimeOffRequest[] {
  return db.timeOffRequests.filter((r) => r.personId === personId && r.policyId === policyId && r.status === status)
}

/** Approved hours split into taken (on or before `date`, from `from`) and scheduled (after `date`, through `to`). */
function approvedUse(db: DB, personId: ID, policyId: ID, date: ISODate, from = '0000-01-01', to = '9999-12-31') {
  let taken = 0
  let scheduled = 0
  const takenDays: DayUse[] = []
  for (const r of requestsFor(db, personId, policyId, 'approved')) {
    for (const d of requestDays(db, r)) {
      if (d.date < from || d.date > to) continue
      if (d.date <= date) {
        taken += d.hours
        takenDays.push(d)
      } else scheduled += d.hours
    }
  }
  return { taken, scheduled, takenDays }
}

function pendingHours(db: DB, personId: ID, policyId: ID, from = '0000-01-01'): number {
  return requestsFor(db, personId, policyId, 'pending')
    .filter((r) => r.endDate >= from)
    .reduce((t, r) => t + r.hours, 0)
}

/** Workdays a request covers within [from, to]; a partial (half) last day counts as half a day. */
function requestDaysWithin(db: DB, r: Pick<TimeOffRequest, 'startDate' | 'endDate' | 'partial'>, from: ISODate, to: ISODate): number {
  const list = workdayList(r.startDate, r.endDate, db.holidays)
  let days = list.filter((d) => d >= from && d <= to).length
  const last = list[list.length - 1]
  if (r.partial && last && last >= from && last <= to) days -= 0.5
  return days
}

/** Approved and pending workdays of a policy within [from, to]. */
function daysUsedWithin(db: DB, personId: ID, policyId: ID, from: ISODate, to: ISODate): number {
  return db.timeOffRequests
    .filter((r) => r.personId === personId && r.policyId === policyId && (r.status === 'approved' || r.status === 'pending'))
    .filter((r) => r.startDate <= to && r.endDate >= from)
    .reduce((t, r) => t + requestDaysWithin(db, r, from, to), 0)
}

/**
 * The first day the policy can be used, when it has a service wait. Sick leave is usable on the 90th
 * day of employment (Labor Code 246(c), LAW.md w-psl-caps), which is start + 89 days; the 30- and
 * 90-day kinds need that many days of employment before the leave, so start + N. A rehire within 12
 * months has no sick leave wait (Labor Code 246(g)(2)).
 */
function usableFromDate(policy: TimeOffPolicy, person: Person, db?: Pick<DB, 'people'>): ISODate | undefined {
  const days = serviceDaysRequired(policy)
  if (!days) return undefined
  if (policy.kind === 'sick') {
    if (db && sickRehire(db, person)) return undefined
    return addDays(person.startDate, days - 1)
  }
  return addDays(person.startDate, days)
}

export type ServiceWait = { usableFrom: ISODate; days: number }

/**
 * When a request would start before the policy's service wait ends (sick leave's 90 days, 30 days for
 * bereavement): the first usable day and the wait in days. Null when the policy has no wait, the wait is
 * over by the start date, or a rehire within 12 months has none (Labor Code 246(g)(2)).
 */
export function serviceWait(db: DB, input: Pick<NewRequest, 'personId' | 'policyId' | 'startDate'>): ServiceWait | null {
  const person = db.people.find((p) => p.id === input.personId)
  const policy = db.timeOffPolicies.find((p) => p.id === input.policyId)
  if (!person || !policy) return null
  const usableFrom = usableFromDate(policy, person, db)
  if (!usableFrom || input.startDate >= usableFrom) return null
  return { usableFrom, days: serviceDaysRequired(policy) ?? 0 }
}

/** The unpaid leave policy that covers the person on the date, if the company has one. */
export function unpaidPolicyFor(db: DB, person: Person, date: ISODate): TimeOffPolicy | undefined {
  return policiesFor(db, person, date).find((p) => p.kind === 'unpaid')
}

/** "the 90th day of employment" for sick leave, "30 days after the start date" otherwise. */
function waitText(policy: TimeOffPolicy): string {
  const days = serviceDaysRequired(policy) ?? 0
  return policy.kind === 'sick' ? `the ${days}th day of employment` : `${days} days after the start date`
}

/**
 * A rehire within 12 months of the earlier stint's last day (Labor Code 246(g)(2), LAW.md
 * w-psl-separation): the earlier record, its last day and the sick hours left unused then.
 */
export function sickRehire(db: Pick<DB, 'people'>, person: Person): { prior: Person; lastDay: ISODate } | undefined {
  const prior = priorStint(db, person)
  if (!prior?.endDate) return undefined
  if (addMonths(prior.endDate, 12) < person.startDate) return undefined
  return { prior, lastDay: prior.endDate }
}

/** Unused sick hours restored on a rehire within 12 months (0 when it is not one). */
export function restoredSickHours(db: DB, person: Person, policy: TimeOffPolicy): number {
  if (policy.kind !== 'sick') return 0
  const r = sickRehire(db, person)
  if (!r) return 0
  const row = balances(db, r.prior.id, r.lastDay).find((b) => b.policy.kind === 'sick')
  return Math.max(0, row?.balance ?? 0)
}

// ---------------------------------------------------------------------------------------------
// Accrual (vacation)
// ---------------------------------------------------------------------------------------------

type Period = { start: ISODate; end: ISODate }

function lastDayOfMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate()
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Pay periods overlapping [from, to]: semi-monthly (1-15, 16-end), monthly, or biweekly from `anchor`. */
export function payPeriods(schedule: DB['company']['paySchedule'], from: ISODate, to: ISODate, anchor: ISODate): Period[] {
  const out: Period[] = []
  if (to < from) return out
  if (schedule === 'biweekly') {
    const k = Math.floor(daysBetween(anchor, from) / 14)
    for (let s = addDays(anchor, k * 14); s <= to; s = addDays(s, 14)) {
      const e = addDays(s, 13)
      if (e >= from) out.push({ start: s, end: e })
    }
    return out
  }
  let y = Number(from.slice(0, 4))
  let m = Number(from.slice(5, 7))
  while (`${y}-${pad(m)}-01` <= to) {
    const last = lastDayOfMonth(y, m)
    const ym = `${y}-${pad(m)}`
    const periods: Period[] =
      schedule === 'monthly'
        ? [{ start: `${ym}-01`, end: `${ym}-${pad(last)}` }]
        : [
            { start: `${ym}-01`, end: `${ym}-15` },
            { start: `${ym}-16`, end: `${ym}-${pad(last)}` },
          ]
    for (const p of periods) if (p.end >= from && p.start <= to) out.push(p)
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return out
}

function periodsPerYear(schedule: DB['company']['paySchedule']): number {
  return payPeriodsPerYear(schedule)
}

type AccrualResult = { earned: number; used: number; adjustments: number; balance: number; capReached: boolean; perPeriod: number }

/**
 * Simulates an accrual policy from the start date to `asOf`: each completed pay period credits
 * annualHours / periods per year (prorated by hoursPerWeek / 40, and by days for a first period that
 * starts mid-period), never past the cap (earning pauses at the cap and resumes after use).
 * With `includePartial`, the period in progress is credited up to `asOf` (used for payout at exit,
 * because vacation vests as it is earned).
 */
function simulateAccrual(db: DB, policy: TimeOffPolicy, person: Person, asOf: ISODate, includePartial: boolean): AccrualResult {
  const schedule = db.company.paySchedule
  const perYear = periodsPerYear(schedule)
  const fte = Math.min(1, Math.max(0, person.hoursPerWeek) / 40)
  const perPeriod = ((policy.annualHours ?? 0) / perYear) * fte
  const horizon = person.endDate && person.endDate < asOf ? person.endDate : asOf
  const start = person.startDate
  type Ev = { date: ISODate; order: number; hours: number; kind: 'credit' | 'use' | 'adj' }
  const events: Ev[] = []
  if (horizon >= start) {
    for (const p of payPeriods(schedule, start, horizon, db.company.foundedOn)) {
      const len = daysBetween(p.start, p.end) + 1
      const from = p.start < start ? start : p.start
      const completed = p.end <= horizon
      if (!completed && !includePartial) continue
      const to = completed ? p.end : horizon
      const frac = (daysBetween(from, to) + 1) / len
      if (frac > 0) events.push({ date: to, order: 2, hours: perPeriod * frac, kind: 'credit' })
    }
  }
  const use = approvedUse(db, person.id, policy.id, horizon)
  for (const d of use.takenDays) events.push({ date: d.date, order: 1, hours: d.hours, kind: 'use' })
  for (const a of db.timeOffAdjustments) {
    if (a.personId === person.id && a.policyId === policy.id && a.date <= horizon) {
      events.push({ date: a.date, order: 0, hours: a.hours, kind: 'adj' })
    }
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order)
  const cap = policy.capHours
  let balance = 0
  let earned = 0
  let used = 0
  let adjustments = 0
  for (const e of events) {
    if (e.kind === 'use') {
      balance -= e.hours
      used += e.hours
    } else if (e.kind === 'adj') {
      balance += e.hours
      adjustments += e.hours
    } else {
      const room = cap != null ? Math.max(0, cap - balance) : Infinity
      const credit = Math.min(e.hours, room)
      balance += credit
      earned += credit
    }
  }
  return {
    earned: r2(earned),
    used: r2(used),
    adjustments: r2(adjustments),
    balance: r2(balance),
    capReached: cap != null && balance >= cap - 0.005,
    perPeriod: r2(perPeriod),
  }
}

// ---------------------------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------------------------

export type BalanceRow = {
  policy: TimeOffPolicy
  /** hours = tracked balance; flexible = no balance; per_event = a limit per event only. */
  display: 'hours' | 'flexible' | 'per_event'
  /** Hours earned to date (accrual) or granted this calendar year (front-load); null when not tracked. */
  earned: number | null
  /** Approved hours taken on or before the date (this calendar year for front-load, flexible and per-event). */
  used: number
  /** Approved hours after the date. */
  scheduled: number
  /** Hours in requests waiting for approval. */
  pending: number
  /** Net manual adjustments. */
  adjustments: number
  /** Hours on hand today (earned + adjustments - used); null when not tracked. */
  balance: number | null
  /** Hours still free to request (balance - scheduled, within any yearly use cap); null when not tracked. */
  available: number | null
  capReached: boolean
  /**
   * Policies with a service wait (sick leave's 90 days, 30 days for bereavement): the first usable day, while it
   * is ahead. Before the start date a front-loaded policy with no wait (a rehire's sick leave) is usable from the start.
   */
  usableFrom?: ISODate
  /**
   * Before the start date, for a front-loaded policy: what arrives on day 1 (the grant plus sick hours restored for a
   * rehire within 12 months), with `hours` within any yearly use cap. The row's other numbers stay at 0 until then.
   */
  startsOn?: { date: ISODate; granted: number; restored: number; hours: number }
  perEventHours?: number
  note: string
}

function yearBounds(date: ISODate): { start: ISODate; end: ISODate } {
  const y = date.slice(0, 4)
  return { start: `${y}-01-01`, end: `${y}-12-31` }
}

function accrualRow(db: DB, policy: TimeOffPolicy, person: Person, date: ISODate): BalanceRow {
  // From the last day on, the final pay period counts up to that day (vacation vests as it is earned), so an
  // alumnus's balance is what was paid out at exit.
  const ended = !!person.endDate && person.endDate <= date
  const sim = simulateAccrual(db, policy, person, date, ended)
  const restored = person.startDate <= date ? restoredSickHours(db, person, policy) : 0
  if (restored > 0) {
    sim.balance = r2(sim.balance + restored)
    sim.adjustments = r2(sim.adjustments + restored)
  }
  const after = approvedUse(db, person.id, policy.id, date)
  const pending = r2(pendingHours(db, person.id, policy.id))
  const scheduled = r2(after.scheduled)
  const cap = policy.capHours
  const prorated = person.hoursPerWeek < 40 ? ` (prorated for ${person.hoursPerWeek} hours a week)` : ''
  let note = `Earns ${r2(sim.perPeriod)} hours each pay period${prorated}`
  note += cap != null ? `, up to ${cap} hours.` : '.'
  if (sim.capReached) note = `At the ${cap}-hour cap, so earning is paused until some is used.`
  if (restored > 0) note = `${note} Includes ${hoursLabel(restored, hoursPerDayFor(person))} restored from before (rehired within 12 months, Labor Code 246).`
  return {
    policy,
    display: 'hours',
    earned: sim.earned,
    used: sim.used,
    scheduled,
    pending,
    adjustments: sim.adjustments,
    balance: sim.balance,
    available: r2(sim.balance - scheduled),
    capReached: sim.capReached,
    note,
  }
}

function frontloadRow(db: DB, policy: TimeOffPolicy, person: Person, date: ISODate): BalanceRow {
  const year = yearBounds(date)
  const granted = person.startDate <= date ? (policy.annualHours ?? 0) : 0
  const use = approvedUse(db, person.id, policy.id, date, year.start, year.end)
  // Sick hours left at an earlier stint come back on a rehire within 12 months, in the year of the rehire.
  const restored = person.startDate <= date && person.startDate >= year.start ? restoredSickHours(db, person, policy) : 0
  const adjustments = r2(
    db.timeOffAdjustments
      .filter((a) => a.personId === person.id && a.policyId === policy.id && a.date >= year.start && a.date <= date)
      .reduce((t, a) => t + a.hours, 0) + restored,
  )
  const used = r2(use.taken)
  const scheduled = r2(use.scheduled)
  const pending = r2(pendingHours(db, person.id, policy.id, year.start))
  const pool = granted + adjustments
  const cap = policy.usageCapHours
  const balance = r2(Math.max(0, cap != null ? Math.min(pool - used, cap - used) : pool - used))
  const available = r2(Math.max(0, balance - scheduled))
  const capReached = cap != null && used >= cap - 0.005
  const hpd = hoursPerDayFor(person)
  const notStarted = person.startDate > date
  // Nothing is usable before the start date; a rehire within 12 months has no wait, so day 1 is the first usable day.
  const usable = usableFromDate(policy, person, db) ?? (notStarted ? person.startDate : undefined)
  const waiting = usable && date < usable ? usable : undefined
  let note = `${hoursLabel(policy.annualHours ?? 0, hpd)} each January 1 and at hire`
  note += cap != null ? `, up to ${cap} hours used a year.` : '.'
  let startsOn: BalanceRow['startsOn']
  if (notStarted) {
    // What day 1 brings, so the 0 hours before the start never reads as a lost balance or a failed restore.
    const grant = policy.annualHours ?? 0
    const back = restoredSickHours(db, person, policy)
    const pool = grant + back
    startsOn = { date: person.startDate, granted: grant, restored: back, hours: r2(cap != null ? Math.min(pool, cap) : pool) }
    const plus = back > 0 ? ` plus ${hoursLabel(back, hpd)} restored from before (rehired within 12 months, Labor Code 246)` : ''
    const from = waiting && waiting > person.startDate ? `usable from ${fmtDate(waiting)} (${waitText(policy)})` : 'usable from day 1'
    if (cap != null && pool > cap) {
      // The number shown is what can be used, so say why it is less than the hours on the books.
      note = `On ${fmtDate(person.startDate)}, the start date: ${hoursLabel(grant, hpd)}${plus}, ${hoursText(pool)} on the books; up to ${hoursWithDays(cap, hpd)} can be used a year under your policy, ${from}. ${hoursLabel(grant, hpd)} each January 1 and at hire.`
    } else note = `On ${fmtDate(person.startDate)}, the start date: ${hoursLabel(grant, hpd)}${plus}, ${from}. ${note}`
  } else if (waiting) note = `Usable from ${fmtDate(waiting)} (${waitText(policy)}). ${note}`
  if (restored > 0) {
    const trimmed = cap != null && pool > cap ? ` ${hoursText(pool)} on the books in all, of which up to ${hoursWithDays(cap, hpd)} can be used a year under your policy.` : ''
    note = `${note} Includes ${hoursLabel(restored, hpd)} restored from before (rehired within 12 months, Labor Code 246), usable now.${trimmed}`
  }
  if (capReached) note = `Used the ${cap}-hour yearly limit. Resets January 1.`
  return {
    policy,
    display: 'hours',
    earned: granted,
    used,
    scheduled,
    pending,
    adjustments,
    balance,
    available,
    capReached,
    ...(waiting ? { usableFrom: waiting } : {}),
    ...(startsOn ? { startsOn } : {}),
    note,
  }
}

function untrackedRow(db: DB, policy: TimeOffPolicy, person: Person, date: ISODate): BalanceRow {
  const year = yearBounds(date)
  const use = approvedUse(db, person.id, policy.id, date, year.start, year.end)
  const flexible = policy.method === 'flexible'
  let note = flexible
    ? 'Flexible: no balance to track. Days taken this year are shown for planning.'
    : policy.perEventHours
      ? `Up to ${hoursLabel(policy.perEventHours)} per event.`
      : 'As needed.'
  const usable = usableFromDate(policy, person, db)
  const waiting = usable && date < usable ? usable : undefined
  if (waiting) note = `Usable from ${fmtDate(waiting)} (${waitText(policy)}). ${note}`
  return {
    policy,
    display: flexible ? 'flexible' : 'per_event',
    earned: null,
    used: r2(use.taken),
    scheduled: r2(use.scheduled),
    pending: r2(pendingHours(db, person.id, policy.id, year.start)),
    adjustments: 0,
    balance: null,
    available: null,
    capReached: false,
    ...(waiting ? { usableFrom: waiting } : {}),
    ...(policy.perEventHours ? { perEventHours: policy.perEventHours } : {}),
    note,
  }
}

/** One row per policy that applies to the person on the date. */
export function balances(db: DB, personId: ID, date: ISODate): BalanceRow[] {
  const person = db.people.find((p) => p.id === personId)
  if (!person) return []
  return policiesFor(db, person, date).map((policy) => {
    if (policy.method === 'accrual') return accrualRow(db, policy, person, date)
    if (policy.method === 'frontload') return frontloadRow(db, policy, person, date)
    return untrackedRow(db, policy, person, date)
  })
}

// ---------------------------------------------------------------------------------------------
// Who's out and approvals
// ---------------------------------------------------------------------------------------------

export type OutEntry = {
  personId: ID
  from: ISODate
  to: ISODate
  /** Policy kind, or 'leave' for a protected leave case (shown as "Leave"; no type to non-admins). */
  kind: TimeOffKind | 'leave'
  status: TimeOffRequest['status'] | 'leave'
  label: string
  requestId?: ID
  leaveCaseId?: ID
  policyId?: ID
}

/** Approved and pending time off plus leave cases overlapping [from, to]. */
export function whoIsOut(db: DB, from: ISODate, to: ISODate): OutEntry[] {
  const out: OutEntry[] = []
  for (const r of db.timeOffRequests) {
    if (r.status !== 'approved' && r.status !== 'pending') continue
    if (r.startDate > to || r.endDate < from) continue
    const policy = db.timeOffPolicies.find((p) => p.id === r.policyId)
    out.push({
      personId: r.personId,
      from: r.startDate,
      to: r.endDate,
      kind: policy?.kind ?? 'unpaid',
      status: r.status,
      label: policy?.name ?? 'Time off',
      requestId: r.id,
      policyId: r.policyId,
    })
  }
  for (const l of db.leaveCases) {
    const end = l.returnedOn
      ? addDays(l.returnedOn, -1)
      : l.endedOn
        ? l.endedOn
        : l.expectedReturn
          ? addDays(l.expectedReturn, -1)
          : to
    if (l.startDate > to || end < from) continue
    out.push({ personId: l.personId, from: l.startDate, to: end, kind: 'leave', status: 'leave', label: 'Leave', leaveCaseId: l.id })
  }
  return out.sort((a, b) => a.from.localeCompare(b.from) || a.personId.localeCompare(b.personId))
}

/**
 * Requests waiting for a decision, oldest first. Auto-approve policies (sick leave) wait only when the
 * request falls before the policy's service wait, for Admin to waive it or record it as unpaid.
 */
export function pendingApprovals(db: DB, opts: { managerId?: ID } = {}): TimeOffRequest[] {
  return db.timeOffRequests
    .filter((r) => r.status === 'pending')
    .filter((r) => !opts.managerId || db.people.find((p) => p.id === r.personId)?.managerId === opts.managerId)
    .sort((a, b) => a.requestedOn.localeCompare(b.requestedOn) || a.startDate.localeCompare(b.startDate))
}

/**
 * logActivity, guarded: if the sample seed calls this module while the store is still loading (the
 * store -> seed -> domain import cycle, under module runners without live bindings), write the row directly.
 */
function log(draft: Draft<DB>, a: Parameters<typeof logActivity>[1]): void {
  try {
    logActivity(draft, a)
  } catch {
    draft.activity.push({ id: newId('act'), at: nowISO(), actorId: null, ...a })
  }
}

// ---------------------------------------------------------------------------------------------
// Request checks and mutations
// ---------------------------------------------------------------------------------------------

export type NewRequest = {
  personId: ID
  policyId: ID
  startDate: ISODate
  endDate: ISODate
  partial?: 'am' | 'pm'
  note?: string
}

export type RequestCheck = {
  hours: number
  workdays: number
  /** Hours left after this request for tracked policies (can go negative), else null. */
  balanceAfter: number | null
  /** Warnings with a why. None of them blocks the request (only two hard stops exist in the app). */
  warnings: string[]
  /** The request starts before the policy's service wait ends; `text` is the warning about it. */
  wait?: ServiceWait & { text: string }
}

/** Hours and warnings for a request before it is saved ("balance impact is shown", projected to the start date). */
export function checkRequest(db: DB, input: NewRequest, date: ISODate): RequestCheck {
  const person = db.people.find((p) => p.id === input.personId)
  const policy = db.timeOffPolicies.find((p) => p.id === input.policyId)
  const warnings: string[] = []
  if (!person || !policy) return { hours: 0, workdays: 0, balanceAfter: null, warnings: ['Pick a person and a time off type.'] }
  if (input.endDate < input.startDate) warnings.push('The end date is before the start date.')
  const days = workdays(input.startDate, input.endDate, db.holidays)
  const hours = requestHours(input.startDate, input.endDate, db.holidays, input.partial, hoursPerDayFor(person))
  if (input.endDate >= input.startDate && hours === 0) warnings.push('Those dates are all weekends or company holidays.')
  if (!policyAvailable(db, policy, person, input.startDate)) warnings.push(`${policy.name} does not apply to this person.`)
  // Balance projected to the start date: accrual earned by then, and the right calendar year for a front-load.
  const asOf = input.startDate > date ? input.startDate : date
  const row = balances(db, person.id, asOf).find((b) => b.policy.id === policy.id)
  let balanceAfter: number | null = null
  if (row?.display === 'hours' && row.available != null) {
    balanceAfter = r2(row.available - row.pending - hours)
    if (balanceAfter < 0) {
      const when = asOf > date ? ` on ${fmtDay(asOf)}` : ''
      warnings.push(
        policy.method === 'frontload' && policy.usageCapHours != null
          ? `This goes ${hoursText(-balanceAfter)} past the ${policy.usageCapHours}-hour yearly limit for ${policy.name.toLowerCase()}.`
          : `This is ${hoursText(-balanceAfter)} more than the ${policy.name.toLowerCase()} balance${when}.`,
      )
    }
  }
  const cite = citeFor(policy)
  const citeText = cite ? ` (${cite})` : ''
  // Service minimum for every kind of policy (sick leave's optional wait; 30 days for bereavement and
  // reproductive loss, Gov Code 12945.6 and 12945.7; 90 days for donor leave).
  const wait = serviceWait(db, input)
  const waitWarning = wait ? `${policy.name} is usable from ${fmtDate(wait.usableFrom)} (${waitText(policy)}${cite ? `, ${cite}` : ''}).` : undefined
  if (waitWarning) warnings.push(waitWarning)
  // Per-event limits written in whole days (40 hours = 5 days) are counted in workdays, so a part-timer's
  // shorter days do not stretch the limit; limits in hours (voting time) are counted in hours.
  const reqDays = input.endDate >= input.startDate ? requestDaysWithin(db, input, input.startDate, input.endDate) : 0
  if (policy.perEventHours) {
    const limitDays = policy.perEventHours / 8
    const over = Number.isInteger(limitDays) ? reqDays > limitDays : hours > policy.perEventHours
    if (over) warnings.push(`${policy.name} is up to ${hoursLabel(policy.perEventHours)} per event${citeText}.`)
  }
  const limit = windowLimit(policy.kind)
  if (limit && reqDays > 0 && reqDays <= limit.days) {
    const from = addDays(addMonths(input.endDate, -12), 1)
    const total = daysUsedWithin(db, person.id, policy.id, from, input.endDate) + reqDays
    if (total > limit.days) {
      warnings.push(
        `${policy.name} is up to ${limit.days} days in ${limit.span}${citeText}. With this request, ${total} days fall in the 12 months ending ${fmtDay(input.endDate)}.`,
      )
    }
  }
  const overlap = db.timeOffRequests.find(
    (r) =>
      r.personId === person.id &&
      (r.status === 'approved' || r.status === 'pending') &&
      r.startDate <= input.endDate &&
      r.endDate >= input.startDate,
  )
  if (overlap) warnings.push(`Overlaps an existing request (${datesText(overlap.startDate, overlap.endDate)}).`)
  return { hours, workdays: days, balanceAfter, warnings, ...(wait && waitWarning ? { wait: { ...wait, text: waitWarning } } : {}) }
}

export type CreateRequestOpts = {
  date: ISODate
  id?: ID
  /**
   * Sick leave that starts before the policy's service wait ends: 'hold' waits for Admin (to waive the
   * wait with approveRequest or record it as unpaid with approveAsUnpaid), 'waive' records it approved
   * with the wait waived. Left out, it is recorded as approved, as history written outside the request
   * sheet already decided (the sample's own early sick day carries that decision note).
   */
  beforeWait?: 'hold' | 'waive'
}

/**
 * Creates a request with computed hours. Policies with autoApprove (sick leave: no reason asked) are
 * approved on the spot, except sick leave before the service wait ends, which follows `beforeWait`.
 * Everything else waits for a manager or Admin.
 */
export function createRequest(draft: Draft<DB>, input: NewRequest, opts: CreateRequestOpts): TimeOffRequest {
  const db = draft as DB
  const person = db.people.find((p) => p.id === input.personId)
  const policy = db.timeOffPolicies.find((p) => p.id === input.policyId)
  if (!person) throw new Error('No person with that id.')
  if (!policy) throw new Error('No time off policy with that id.')
  const hours = requestHours(input.startDate, input.endDate, db.holidays, input.partial, hoursPerDayFor(person))
  const wait = policy.autoApprove && opts.beforeWait ? serviceWait(db, input) : null
  const auto = !!policy.autoApprove && (!wait || opts.beforeWait === 'waive')
  const decisionNote = wait ? waivedNote(wait) : 'Approved automatically'
  const req: TimeOffRequest = {
    id: opts.id ?? newId('tr'),
    personId: input.personId,
    policyId: input.policyId,
    startDate: input.startDate,
    endDate: input.endDate,
    ...(input.partial ? { partial: input.partial } : {}),
    hours,
    status: auto ? 'approved' : 'pending',
    ...(input.note ? { note: input.note } : {}),
    requestedOn: opts.date,
    ...(auto ? { decidedOn: opts.date, decisionNote } : {}),
  }
  draft.timeOffRequests.push(req)
  const phrase = policyPhrase(policy)
  const when = `${datesText(req.startDate, req.endDate)} (${hoursLabel(hours, hoursPerDayFor(person))})`
  log(draft, {
    entityType: 'timeoff',
    entityId: req.id,
    relatedId: person.id,
    kind: auto ? 'timeoff_recorded' : 'timeoff_requested',
    text: auto
      ? `${phrase.charAt(0).toUpperCase() + phrase.slice(1)} recorded for ${fullName(person)}, ${when}, ${wait ? `with the ${wait.days}-day wait waived` : 'approved automatically'}`
      : `${fullName(person)} requested ${phrase}, ${when}`,
  })
  return req
}

type DecisionOpts = { date: ISODate; approverId?: ID; note?: string }

function decide(draft: Draft<DB>, requestId: ID, status: 'approved' | 'declined' | 'cancelled', opts: DecisionOpts, verb: string): boolean {
  const req = draft.timeOffRequests.find((r) => r.id === requestId)
  if (!req) return false
  if (status !== 'cancelled' && req.status !== 'pending') return false
  if (status === 'cancelled' && (req.status === 'cancelled' || req.status === 'declined')) return false
  req.status = status
  req.decidedOn = opts.date
  if (opts.approverId) req.approverId = opts.approverId
  if (opts.note) req.decisionNote = opts.note
  const db = draft as DB
  const person = db.people.find((p) => p.id === req.personId)
  const policy = db.timeOffPolicies.find((p) => p.id === req.policyId)
  const name = person ? fullName(person) : 'Unknown person'
  log(draft, {
    entityType: 'timeoff',
    entityId: req.id,
    relatedId: req.personId,
    kind: `timeoff_${status}`,
    text: `${verb} ${name}'s ${policyPhrase(policy)}, ${datesText(req.startDate, req.endDate)}`,
  })
  return true
}

function waivedNote(wait: ServiceWait): string {
  return `Approved: the ${wait.days}-day wait was waived for this request`
}

/** The service wait a pending request falls before (sick leave before day 90), else null. */
function pendingWait(db: DB, requestId: ID): ServiceWait | null {
  const req = db.timeOffRequests.find((r) => r.id === requestId)
  const policy = req ? db.timeOffPolicies.find((p) => p.id === req.policyId) : undefined
  return req && policy?.autoApprove ? serviceWait(db, req) : null
}

/**
 * Approves a pending request. Returns false when it is missing or not pending. Approving sick leave
 * that falls before the service wait waives the wait for that request, and the decision note says so.
 */
export function approveRequest(draft: Draft<DB>, requestId: ID, opts: DecisionOpts): boolean {
  const wait = opts.note ? null : pendingWait(draft as DB, requestId)
  return decide(draft, requestId, 'approved', wait ? { ...opts, note: waivedNote(wait) } : opts, 'Approved')
}

/**
 * Records a pending request that falls before the policy's service wait (sick leave before day 90) as
 * unpaid leave instead: it moves to the unpaid leave policy when the company has one, else it keeps its
 * policy with no hours, so nothing comes off the balance. Returns false when it is missing or not pending.
 */
export function approveAsUnpaid(draft: Draft<DB>, requestId: ID, opts: DecisionOpts): boolean {
  const db = draft as DB
  const req = draft.timeOffRequests.find((r) => r.id === requestId)
  const person = req ? db.people.find((p) => p.id === req.personId) : undefined
  if (!req || !person || req.status !== 'pending') return false
  const wait = pendingWait(db, requestId)
  const unpaid = unpaidPolicyFor(db, person, req.startDate)
  // Keep the policy it was asked on: pay run prep never docks an exempt salary for unpaid sick days.
  if (unpaid && unpaid.id !== req.policyId) req.recordedUnpaidFrom = req.policyId
  if (unpaid) req.policyId = unpaid.id
  else req.hours = 0
  req.status = 'approved'
  req.decidedOn = opts.date
  if (opts.approverId) req.approverId = opts.approverId
  req.decisionNote = opts.note ?? (wait ? `Recorded as unpaid: before the ${wait.days}-day wait ends on ${fmtDate(wait.usableFrom)}` : 'Recorded as unpaid')
  // 'time off', never the leave type: activity can be seen outside Admin.
  log(draft, {
    entityType: 'timeoff',
    entityId: req.id,
    relatedId: req.personId,
    kind: 'timeoff_approved',
    text: `Recorded ${fullName(person)}'s time off as unpaid, ${datesText(req.startDate, req.endDate)}`,
  })
  return true
}

/** Declines a pending request. Returns false when it is missing or not pending. */
export function declineRequest(draft: Draft<DB>, requestId: ID, opts: DecisionOpts): boolean {
  return decide(draft, requestId, 'declined', opts, 'Declined')
}

/** Cancels a pending or approved request. Returns false when it is missing or already closed. */
export function cancelRequest(draft: Draft<DB>, requestId: ID, opts: DecisionOpts): boolean {
  return decide(draft, requestId, 'cancelled', opts, 'Cancelled')
}

// ---------------------------------------------------------------------------------------------
// Payout at separation
// ---------------------------------------------------------------------------------------------

export type VacationPayout = {
  hours: number
  amount: number
  /** Final hourly rate of pay (salary / (hours per week x 52) for salaried staff). */
  rate: number
  /** The day it was counted to: the date asked for, or the person's own last day when that comes first. */
  asOf: ISODate
  rows: Array<{ policyId: ID; name: string; hours: number; amount: number }>
  note: string
}

/**
 * Accrued, unused vacation owed at separation, at the final rate of pay (Labor Code 227.3). Vacation vests
 * as earned, so the pay period in progress counts up to the last day. Sick leave and flexible vacation pay nothing.
 * A person whose recorded last day comes before `lastDay` is counted at their own last day: nothing is earned
 * after it, so an alumnus's payout never grows.
 */
export function vacationPayout(db: DB, personId: ID, askedFor: ISODate): VacationPayout {
  const person = db.people.find((p) => p.id === personId)
  const empty = { hours: 0, amount: 0, rate: 0, rows: [], asOf: askedFor }
  if (!person) return { ...empty, note: 'No person with that id.' }
  const lastDay = person.endDate && person.endDate < askedFor ? person.endDate : askedFor
  const rec = compOrFirst(db, personId, lastDay)
  const rate = rec ? hourlyRateOf(rec, person.hoursPerWeek) : 0
  const asOfLast: Person = { ...person, endDate: lastDay }
  const rows: VacationPayout['rows'] = []
  for (const policy of policiesFor(db, person, lastDay)) {
    // Accrued vacation is paid whatever the policy says (Labor Code 227.3, as payoutRules says); anything else only
    // when the policy pays it out.
    const accruedVacation = policy.kind === 'vacation' && (policy.method === 'accrual' || policy.method === 'frontload')
    if (!policy.paidOutOnExit && !accruedVacation) continue
    let hours = 0
    if (policy.method === 'accrual') hours = simulateAccrual(db, policy, asOfLast, lastDay, true).balance
    else if (policy.method === 'frontload') hours = frontloadRow(db, policy, asOfLast, lastDay).balance ?? 0
    hours = r2(Math.max(0, hours))
    rows.push({ policyId: policy.id, name: policy.name, hours, amount: r2(hours * rate) })
  }
  const hours = r2(rows.reduce((t, r) => t + r.hours, 0))
  const amount = r2(rows.reduce((t, r) => t + r.amount, 0))
  const flexibleOnly = !rows.length && policiesFor(db, person, lastDay).some((p) => p.method === 'flexible')
  const note = rows.length
    ? `Unused vacation is paid with the final paycheck at the final rate of pay (Labor Code 227.3). Sick leave is not paid out.${rec ? '' : ' No pay record was found, so the amount is $0.'}`
    : flexibleOnly
      ? 'Flexible vacation has no accrued balance, so nothing is paid out. Sick leave is not paid out.'
      : 'No vacation policy pays out for this person. Sick leave is not paid out.'
  return { hours, amount, rate, rows, note, asOf: lastDay }
}

// ---------------------------------------------------------------------------------------------
// Calendar file
// ---------------------------------------------------------------------------------------------

/** An all-day .ics event for a request. The title says only "out" so it is safe on a shared calendar. */
export function timeOffICS(db: DB, requestId: ID): string {
  const req = db.timeOffRequests.find((r) => r.id === requestId)
  if (!req) return ''
  const person = db.people.find((p) => p.id === req.personId)
  const name = person ? fullName(person) : 'Time off'
  const status = req.status === 'pending' ? 'Pending approval' : req.status === 'approved' ? 'Approved' : 'Not approved'
  return buildICS(
    [
      {
        uid: `timeoff-${req.id}`,
        title: `${name}: out`,
        date: req.startDate,
        endDate: addDays(req.endDate, 1),
        description: `${status}. ${datesText(req.startDate, req.endDate)}, ${hoursLabel(req.hours, person ? hoursPerDayFor(person) : 8)}.`,
      },
    ],
    'Time off',
  )
}
