// Pay run prep for one pay period (docs/SPEC.md: PAY RUN PREP): who is on payroll, what changed (new hires, pay
// changes, sign-on bonuses, time off, leaves, last days with their final pay deadline and vacation payout) and an
// estimated gross per person. Estimates only: the payroll provider or PEO calculates the real amounts, taxes and
// net pay. Pure functions over the DB; every date is a parameter.
//
// Legal basis (docs/LAW.md), not legal advice:
//   w-salary-first-last-week  An exempt salary is paid in full for any week with work; only the first and last week
//                             of employment may be prorated. Estimate for a partial period: annual / 260 x weekdays on
//                             payroll (Monday to Friday, holidays included), never more than the regular period amount.
//                             Every weekday of the period on payroll is a whole period (the regular amount).
//   w-exempt-deductions-ca    Unpaid full days for personal reasons come off at annual / 260 a day. Never partial days,
//                             company closures or sick days: those are flagged instead. No work all period: $0.
//   w-nonexempt-salary-rate   A full-time (40 hours) non-exempt salary's hourly rate is weekly salary / 40 (annual /
//                             2080). Labor Code 515(d) speaks only of full-time salaries: a part-time one is estimated
//                             at weekly salary / the hours it covers, labeled as a method, not 515(d).
//   w-final-pay-termination, w-final-pay-resignation, w-waiting-time-penalty  finalPayDeadline() and
//                             waitingTimeExposure() in src/domain/checklists/finalPay.ts, for work in California only
//                             (anyone working elsewhere gets a flag to check that state's rules). With paydays in
//                             arrears, the wages of a period that ended before the last day can be due with the final
//                             check, before that period's own payday: flagged too.
//   w-vacation-payout         Accrued vacation (and flexible vacation with a cap or a yearly allowance) is paid at the
//                             final rate (vacationPayout() in src/domain/timeoff.ts), in California. w-psl-separation:
//                             sick leave is not, unless the company's policy pays it out (listed under its own name).
//   w-sick-pay-timing         Sick hours taken are paid by the next regular payday.
//   w-overtime-next-payday    Overtime is due by the next regular payday; hours come from time tracking.
//   w-exempt-salary-2026, w-software-exempt-2026, w-ca-minwage-2026, w-sj-minwage-2026  pay floor flags.
// No California rule was found for partial weeks of unpaid CFRA, PDL or bonding leave: those estimate
// proportionally and are flagged for review.
import { dailyRateFor, finalPayDeadline, type FinalPayRule, payoutRules, vacationPaidAtExit, waitingTimeExposure } from '@/domain/checklists/finalPay'
import { compHistory, exemptCheck, lastDayOf, latestOffers, payPeriodsPerYear } from '@/domain/pay'
import { fullName } from '@/domain/people'
import { balances, hoursPerDayFor, policiesFor, vacationPayout, workdayList } from '@/domain/timeoff'
import type { CompRecord, DB, FLSA, ID, LeaveCase, Offer, PayRunRecord, Person, TimeOffKind, TimeOffPolicy, TimeOffRequest } from '@/domain/types'
import { addDays, fmtDay, type ISODate } from '@/lib/dates'
import { money, money2 } from '@/lib/format'
import { latePayday, payCalendar, type PayPeriod, payrollProviderName, periodLabel, providerPhrase } from './calendar'

function r2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Hours to at most two decimals, as the export writes them: 22.25 -> '22.25', 16 -> '16'. */
export function hoursText2(hours: number): string {
  return String(r2(hours))
}

/**
 * A non-exempt salary per hour. Full time (40 hours a week or more): weekly salary / 40, annual / 2080 (Labor Code
 * 515(d), docs/LAW.md w-nonexempt-salary-rate). Part time: weekly salary / the hours a week it covers, a method for the
 * estimate (515(d) speaks only of full-time salaries).
 */
export function salaryHourlyRate(annual: number, hoursPerWeek: number): { rate: number; basis: 'full_time' | 'scheduled_hours' } {
  if (hoursPerWeek > 0 && hoursPerWeek < 40) return { rate: annual / 52 / hoursPerWeek, basis: 'scheduled_hours' }
  return { rate: annual / 2080, basis: 'full_time' }
}

/** Hours of time off taken in the period, by the columns payroll uses. Bereavement and reproductive loss go under other, unnamed. */
export type TimeOffBuckets = { pto: number; sick: number; other: number; unpaid: number }

export type PayRunFlagKind =
  | 'final_pay_off_cycle'
  | 'final_pay_late'
  | 'final_pay_issued'
  | 'final_pay_arrears'
  | 'no_separation'
  | 'final_pay_other_state'
  | 'vacation_payout_check'
  | 'unpaid_sick'
  | 'partial_unpaid'
  | 'leave_no_pay_rule'
  | 'leave_all_period'
  | 'leave_partial'
  | 'no_pay'
  | 'min_wage'
  | 'exempt_floor'
  | 'pending_time_off'
  | 'hourly_segment'

/**
 * Something to check before submitting. `bad` ones are legal deadlines or pay floors; the rest are reminders.
 * `private` marks text that carries a pay amount, so the page shows it under the privacy blur.
 */
export type PayRunFlag = { kind: PayRunFlagKind; text: string; tone: 'bad' | 'warn' | 'info'; private?: true }

type PayFields = Pick<CompRecord, 'payType' | 'salary' | 'hourlyRate'>

export type PayRunRow = {
  personId: ID
  /** Display name (preferred first name). */
  name: string
  /** Legal first name for the provider. */
  firstName: string
  lastName: string
  employeeNumber: number
  payrollId?: string
  workEmail: string
  payType: 'salary' | 'hourly'
  flsa: FLSA
  /** Annual salary or hourly rate in force at the end of the person's time in the period. */
  rate: number
  rateBasis: 'year' | 'hour'
  /** A non-exempt salary restated per hour (salaryHourlyRate), for overtime and unpaid hours in the provider. */
  hourlyEquivalent?: number
  /** How hourlyEquivalent was worked out: annual / 2080 (full time, Labor Code 515(d)) or weekly salary / scheduled hours. */
  hourlyBasis?: 'full_time' | 'scheduled_hours'
  hoursPerWeek: number
  /** Start and last day when they fall inside the period. */
  startInPeriod?: ISODate
  endInPeriod?: ISODate
  /** Weekdays (Monday to Friday, holidays included) in the period, and the ones the person is on payroll. */
  weekdays: number
  weekdaysOnPayroll: number
  /** The regular check: annual salary / pay periods a year at the rate in force at the end (0 for hourly pay). */
  regularAmount: number
  /** Salary estimate for the period; null for hourly pay (hours come from time tracking). */
  salaryEstimate: number | null
  /** Unpaid time taken off the salary estimate: full days for exempt staff, hours for non-exempt salaried staff. */
  deduction: number
  unpaidDaysDeducted: number
  /** Sign-on bonus from the accepted offer, paid with the first check. */
  bonus: number
  /** Unused vacation paid at exit (Labor Code 227.3): vacation and flexible vacation policies only. */
  vacationPayout?: { hours: number; amount: number; rate: number }
  /** Another balance the company's own policy pays out at exit (sick leave set to 'Paid out at exit'), by its name. */
  otherPayout?: { hours: number; amount: number; rate: number; name: string }
  /** Salary estimate + bonus + payouts; null for hourly pay. */
  estimatedGross: number | null
  payChanges: Array<{ effectiveOn: ISODate; from: PayFields; to: PayFields }>
  timeOff: TimeOffBuckets
  /** Leave dates inside the period (never the leave type). */
  leave?: { from: ISODate; to: ISODate }
  finalPay?: {
    dueOn: ISODate
    rule: FinalPayRule
    text: string
    detail: string
    citation: { label: string; url: string }
    /** Due before the period's payday: the final check needs an off-cycle payroll. */
    beforePayday: boolean
    issuedOn?: ISODate
    /** Waiting-time penalty exposure once the deadline passed unpaid (Labor Code 203). */
    exposure?: { daysLate: number; amount: number }
  }
  /** Final pay already issued off-cycle: nothing more in this run unless wages were missed. */
  paidOffCycle?: boolean
  /** Paid sick leave left at the end of the period (Labor Code 246(i): it goes on the pay stub). */
  sickBalance?: number
  flags: PayRunFlag[]
  /** Plain notes for the export. Never a leave type or a medical detail. */
  notes: string[]
}

export type PayRunStatus = 'submitted' | 'open' | 'not_marked'

/**
 * The period's sums. `estimatedGross` adds the rows that have one (salaried people, final pay not issued yet), and
 * `bonus`, `vacationPayout` and `otherPayout` are the parts of that sum, so 'including' is always true. Bonuses and
 * payouts of people paid hourly are not in it (their gross waits for the hours): they are listed in `outside`.
 */
export type PayRunTotals = {
  people: number
  estimatedGross: number
  salaried: number
  hourly: number
  bonus: number
  vacationPayout: number
  otherPayout: number
  outside: Array<{ personId: ID; name: string; bonus: number; vacationPayout: number; otherPayout: number }>
}

export type PayRunPrep = {
  period: PayPeriod
  schedule: DB['company']['paySchedule']
  periodsPerYear: number
  rows: PayRunRow[]
  totals: PayRunTotals
  /** Requests in the period still waiting for a decision. */
  pendingTimeOff: Array<{ requestId: ID; personId: ID; name: string; startDate: ISODate; endDate: ISODate }>
  /** Period-level notes: a payday past the Labor Code 204 limit, monthly pay for non-exempt staff. */
  notices: string[]
  record?: PayRunRecord
  status: PayRunStatus
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/** Monday to Friday from start to end, inclusive, holidays included (a salaried week with a holiday is a full week). */
export function weekdayList(start: ISODate, end: ISODate): ISODate[] {
  return workdayList(start, end, [])
}

function samePay(a: PayFields, b: PayFields): boolean {
  return a.payType === b.payType && (a.salary ?? 0) === (b.salary ?? 0) && (a.hourlyRate ?? 0) === (b.hourlyRate ?? 0)
}

function payWords(p: PayFields): string {
  return p.payType === 'hourly' ? `${money2(p.hourlyRate ?? 0)} an hour` : money(p.salary ?? 0)
}

/**
 * The record for a period: the same start and end. A record from another schedule (Oct 1-15 after a switch to every
 * two weeks) never stands in for a new period that only overlaps it, so that period still gets its reminder. The
 * sample's runs are rebuilt from the calendar when it loads (samplePayRuns), never shifted.
 */
export function runForPeriod(runs: ReadonlyArray<PayRunRecord> | undefined, period: { start: ISODate; end: ISODate }): PayRunRecord | undefined {
  return (runs ?? []).find((r) => r.periodStart === period.start && r.periodEnd === period.end)
}

/** Submitted, open (payday today or later) or not marked (payday passed without a Mark submitted). */
export function payRunStatus(record: PayRunRecord | undefined, period: Pick<PayPeriod, 'payday'>, date: ISODate): PayRunStatus {
  if (record?.submittedOn) return 'submitted'
  return period.payday >= date ? 'open' : 'not_marked'
}

/** The accepted offer the person was hired from (by offer.personId, else their candidate), newest version. */
export function hireOffer(db: Pick<DB, 'offers'>, person: Pick<Person, 'id' | 'fromCandidateId' | 'fromApplicationId'>): Offer | undefined {
  const accepted = latestOffers(db as DB).filter((o) => o.status === 'accepted')
  return (
    accepted.find((o) => o.personId === person.id) ??
    accepted.find((o) => !!person.fromApplicationId && o.applicationId === person.fromApplicationId) ??
    accepted.find((o) => !!person.fromCandidateId && o.candidateId === person.fromCandidateId)
  )
}

/** The last day of a leave case: the day before the return, else its end, else open (null). */
function leaveLastDay(l: LeaveCase): ISODate | null {
  if (l.returnedOn) return addDays(l.returnedOn, -1)
  if (l.endedOn) return l.endedOn
  if (l.expectedReturn) return addDays(l.expectedReturn, -1)
  return null
}

/**
 * Leave kinds with no pay rule behind them in the app: jury and witness duty (the default policy keeps only an exempt
 * salary whole), bereavement and reproductive loss (their default policies give the time, not the pay). Voting time
 * and organ and bone marrow donor leave are paid time under their default policies (which cite Elections Code 14000
 * and Labor Code 1510). No pay rule for these kinds was researched (docs/LAW.md, Pay run prep, open questions).
 */
const NO_PAY_RULE: ReadonlySet<TimeOffKind> = new Set(['jury_duty', 'bereavement', 'reproductive_loss'])

/**
 * Which payroll column a time off kind goes in. For hourly and non-exempt staff, leave with no pay rule is unpaid
 * (Gusto pays its 'Other time off' column); an exempt salary is not reduced for it, so it stays under other. The
 * columns never name the kind.
 */
function bucketFor(kind: TimeOffKind, nonExempt: boolean): keyof TimeOffBuckets {
  if (kind === 'vacation' || kind === 'flexible_vacation') return 'pto'
  if (kind === 'sick') return 'sick'
  if (kind === 'unpaid') return 'unpaid'
  if (nonExempt && NO_PAY_RULE.has(kind)) return 'unpaid'
  return 'other'
}

/** Sick leave recorded as unpaid (before the 90-day wait): moved to the unpaid policy, or kept on sick with no hours. */
function isUnpaidSick(req: TimeOffRequest, policy: TimeOffPolicy | undefined, policies: ReadonlyArray<TimeOffPolicy>): boolean {
  if (req.recordedUnpaidFrom) return policies.find((p) => p.id === req.recordedUnpaidFrom)?.kind === 'sick'
  if (policy?.kind === 'sick' && req.hours === 0) return true
  return policy?.kind === 'unpaid' && (req.decisionNote ?? '').startsWith('Recorded as unpaid')
}

export type DayUse = { date: ISODate; hours: number; fullDay: boolean }

/**
 * A request's hours by workday (company holidays skipped, as requests count them): a full day each, in order, and the
 * rest on the last day, so Nov 2-4 with a pm partial (20 hours) is 8, 8 and 4, and a request across a period boundary
 * puts its hours on the right side. Only the last day can be partial. A request with at least a full day for every
 * workday (and no partial) is spread evenly, all full days. A request recorded with no hours (unpaid sick leave kept
 * on its policy) counts a normal day each, the partial last day half of one.
 */
export function requestDays(req: Pick<TimeOffRequest, 'startDate' | 'endDate' | 'hours' | 'partial'>, holidays: ReadonlyArray<{ date: ISODate }>, hoursPerDay: number): DayUse[] {
  const days = workdayList(req.startDate, req.endDate, holidays)
  if (!days.length) return req.hours > 0 ? [{ date: req.startDate, hours: req.hours, fullDay: false }] : []
  const total = req.hours > 0 ? req.hours : (req.partial ? days.length - 0.5 : days.length) * hoursPerDay
  if (!req.partial && total >= days.length * hoursPerDay - 0.01) return days.map((date) => ({ date, hours: total / days.length, fullDay: true }))
  const out: DayUse[] = []
  let left = total
  days.forEach((date, i) => {
    const last = i === days.length - 1
    const hours = last ? left : Math.min(hoursPerDay, left)
    left -= hours
    if (hours > 0.001) out.push({ date, hours, fullDay: !(last && req.partial) && hours >= hoursPerDay - 0.01 })
  })
  return out
}

// ---------------------------------------------------------------------------------------------
// One person
// ---------------------------------------------------------------------------------------------

type Segment = { from: ISODate; to: ISODate; rec: CompRecord }

/**
 * The comp records in force over [from, to], split at each pay change. With no record in force on `from` (an owner
 * whose salary starts after their start date, or a first record dated after the start), the first segment starts on
 * the first record's date: nothing is paid before it.
 */
function paySegments(history: CompRecord[], from: ISODate, to: ISODate): Segment[] {
  const upTo = history.filter((r) => r.effectiveOn <= to)
  if (!upTo.length) return []
  const atStart = upTo.filter((r) => r.effectiveOn <= from)
  const first = atStart[atStart.length - 1]
  const out: Segment[] = [first ? { from, to, rec: first } : { from: upTo[0].effectiveOn, to, rec: upTo[0] }]
  for (const r of upTo) {
    if (r.effectiveOn <= from) continue
    const last = out[out.length - 1]
    // A title, level or manager change keeps the pay: the newer row (its FLSA status) carries on in the same segment.
    if (samePay(last.rec, r)) {
      last.rec = r
      continue
    }
    last.to = addDays(r.effectiveOn, -1)
    out.push({ from: r.effectiveOn, to, rec: r })
  }
  return out
}

function minWageFor(db: DB, person: Person): { floor: number; where: string } {
  const loc = db.locations.find((l) => l.id === person.locationId)
  const state = (loc?.kind === 'remote' ? person.homeState : loc?.state) || person.homeState || db.company.hq.state || 'CA'
  const inCA = state.toUpperCase() === 'CA'
  // As the offer check does: California's floor applies only in California; elsewhere the location's rate (at least $7.25).
  const floor = inCA ? Math.max(db.settings.law.caMinWageHourly, loc?.minWageHourly ?? 0) : Math.max(7.25, loc?.minWageHourly ?? 0)
  return { floor, where: loc ? `for ${loc.name}` : inCA ? 'in California' : `in ${state}` }
}

/**
 * The period just before `period` when its payday falls after a final pay deadline and the person was employed in it:
 * with paydays in arrears (the 16th to month end paid on the 10th), those wages are still unpaid on the last day and
 * belong in the final check.
 */
function earlierUnpaidPeriod(db: Pick<DB, 'company' | 'holidays'>, period: PayPeriod, dueOn: ISODate, startDate: ISODate): PayPeriod | undefined {
  const day = addDays(period.start, -1)
  const prev = payCalendar(db, day, day)[0]
  return prev && prev.payday > dueOn && prev.end >= startDate ? prev : undefined
}

/**
 * What is paid out at the last day, by policy kind. Vacation and flexible vacation go under the Labor Code 227.3 payout
 * (when vacationPaidAtExit says it is owed). Any other balance a policy pays out (sick leave set to 'Paid out at exit')
 * is listed under the policy's own name, never as vacation. A flexible policy with a cap or a yearly allowance counts as
 * vacation (payoutRules) but keeps no balance in the app: that is a check, not $0.
 */
function exitPayouts(
  db: DB,
  person: Person,
  lastDay: ISODate,
): { vacation?: PayRunRow['vacationPayout']; other?: PayRunRow['otherPayout']; flags: PayRunFlag[]; notes: string[] } {
  const policies = policiesFor(db, person, lastDay)
  const v = vacationPayout(db, person.id, lastDay)
  const policyOf = (id: ID) => db.timeOffPolicies.find((p) => p.id === id)
  const isVacation = (kind: TimeOffKind | undefined) => kind === 'vacation' || kind === 'flexible_vacation'
  const flags: PayRunFlag[] = []
  const notes: string[] = []
  let vacation: PayRunRow['vacationPayout']
  let other: PayRunRow['otherPayout']
  if (vacationPaidAtExit(policies, person)) {
    const rows = v.rows.filter((r) => isVacation(policyOf(r.policyId)?.kind))
    const hours = r2(rows.reduce((t, r) => t + r.hours, 0))
    if (hours > 0) {
      vacation = { hours, amount: r2(rows.reduce((t, r) => t + r.amount, 0)), rate: v.rate }
      notes.push(`Vacation payout: ${hoursText2(hours)} hours at the final rate (Labor Code 227.3)`)
    }
    for (const rule of payoutRules(policies, person)) {
      const p = policyOf(rule.policyId)
      if (!rule.paidOut || !p || !isVacation(p.kind) || p.method !== 'flexible') continue
      flags.push({
        kind: 'vacation_payout_check',
        tone: 'warn',
        text: `${p.name} has a cap or a yearly allowance, so unused hours count as vacation and are paid at the final rate (Labor Code 227.3). The app keeps no balance for it: add the unused hours to the final check.`,
      })
    }
  }
  const others = v.rows.filter((r) => !isVacation(policyOf(r.policyId)?.kind) && r.hours > 0)
  if (others.length) {
    const hours = r2(others.reduce((t, r) => t + r.hours, 0))
    const name = others.map((r) => r.name).join(' and ')
    other = { hours, amount: r2(others.reduce((t, r) => t + r.amount, 0)), rate: v.rate, name }
    notes.push(`${name} payout: ${hoursText2(hours)} hours at the final rate (your policy pays it out)`)
  }
  return { ...(vacation ? { vacation } : {}), ...(other ? { other } : {}), flags, notes }
}

function personRow(db: DB, person: Person, period: PayPeriod, date: ISODate, ppy: number): PayRunRow {
  const lastDay = lastDayOf(person)
  const spanStart = person.startDate > period.start ? person.startDate : period.start
  const spanEnd = lastDay && lastDay < period.end ? lastDay : period.end
  const startInPeriod = person.startDate >= period.start ? person.startDate : undefined
  const endInPeriod = lastDay && lastDay <= period.end ? lastDay : undefined
  const allWeekdays = weekdayList(period.start, period.end)
  const hpd = hoursPerDayFor(person)
  const flags: PayRunFlag[] = []
  const notes: string[] = []

  const segments = paySegments(compHistory(db, person.id), spanStart, spanEnd)
  // Pay starts with the first segment: an owner whose salary starts mid-period, or a first pay record dated after the
  // start, is not on payroll for the weekdays before it.
  const payFrom = segments[0]?.from ?? spanStart
  const payStartsLate = payFrom > spanStart
  const onPayroll = weekdayList(payFrom, spanEnd)
  const endRec = segments[segments.length - 1]?.rec
  const payType = endRec?.payType ?? 'salary'
  const flsa: FLSA = endRec?.flsa ?? person.flsa
  const nonExempt = payType === 'hourly' || flsa === 'non_exempt'
  const rate = endRec ? (payType === 'hourly' ? (endRec.hourlyRate ?? 0) : (endRec.salary ?? 0)) : 0
  const annualOf = (rec: CompRecord) => (rec.payType === 'salary' ? (rec.salary ?? 0) : 0)
  const regularAmount = endRec && payType === 'salary' ? r2(annualOf(endRec) / ppy) : 0
  const hourly = payType === 'salary' && flsa === 'non_exempt' && rate > 0 ? salaryHourlyRate(rate, person.hoursPerWeek) : undefined
  const payChanges = segments.slice(1).map((s, i) => ({
    effectiveOn: s.from,
    from: { payType: segments[i].rec.payType, salary: segments[i].rec.salary, hourlyRate: segments[i].rec.hourlyRate },
    to: { payType: s.rec.payType, salary: s.rec.salary, hourlyRate: s.rec.hourlyRate },
  }))
  if (!endRec || rate <= 0) flags.push({ kind: 'no_pay', tone: 'warn', text: 'No pay rate on record: add one in Change job or pay, or leave them out if they are not on payroll.' })

  // Approved time off in the person's days on payroll, and requests still waiting.
  const policies = db.timeOffPolicies
  const timeOff: TimeOffBuckets = { pto: 0, sick: 0, other: 0, unpaid: 0 }
  const paidOffDays = new Set<ISODate>()
  const unpaidFullDays: ISODate[] = []
  let unpaidHours = 0
  let partialUnpaid = 0
  let unpaidSickDays = 0
  let noPayRuleHours = 0
  for (const req of db.timeOffRequests) {
    if (req.personId !== person.id || req.status !== 'approved' || req.endDate < spanStart || req.startDate > spanEnd) continue
    const policy = policies.find((p) => p.id === req.policyId)
    const unpaidSick = isUnpaidSick(req, policy, policies)
    const bucket = unpaidSick ? 'unpaid' : policy ? bucketFor(policy.kind, nonExempt) : 'other'
    const noPayRule = !unpaidSick && bucket === 'unpaid' && !!policy && policy.kind !== 'unpaid'
    for (const d of requestDays(req, db.holidays, hpd)) {
      if (d.date < spanStart || d.date > spanEnd) continue
      timeOff[bucket] += d.hours
      if (bucket !== 'unpaid') {
        paidOffDays.add(d.date)
        continue
      }
      unpaidHours += d.hours
      if (noPayRule) noPayRuleHours += d.hours
      if (unpaidSick) unpaidSickDays += 1
      else if (d.fullDay) unpaidFullDays.push(d.date)
      else partialUnpaid += 1
    }
  }
  for (const k of Object.keys(timeOff) as Array<keyof TimeOffBuckets>) timeOff[k] = r2(timeOff[k])
  if (noPayRuleHours > 0) {
    // Never the kind of leave: bereavement and reproductive loss are confidential.
    flags.push({
      kind: 'leave_no_pay_rule',
      tone: 'info',
      text: `Leave with no pay rule in the law (jury duty, for one) is listed as unpaid hours. If your policy pays it, enter those hours as paid in ${providerPhrase(db.company)}.`,
    })
  }

  // Protected leave days (assumed unpaid), less days covered by paid time off.
  const leaveDays = new Set<ISODate>()
  let leave: PayRunRow['leave']
  for (const l of db.leaveCases) {
    if (l.personId !== person.id) continue
    const end = leaveLastDay(l) ?? spanEnd
    const from = l.startDate > spanStart ? l.startDate : spanStart
    const to = end < spanEnd ? end : spanEnd
    if (to < from) continue
    leave = { from: leave && leave.from < from ? leave.from : from, to: leave && leave.to > to ? leave.to : to }
    for (const d of weekdayList(from, to)) if (!paidOffDays.has(d)) leaveDays.add(d)
  }
  if (leave) notes.push(`On leave ${periodLabel({ start: leave.from, end: leave.to })}`)

  // Salary estimate (w-salary-first-last-week).
  let salaryEstimate: number | null = null
  let deduction = 0
  let unpaidDaysDeducted = 0
  const salaried = segments.filter((s) => s.rec.payType === 'salary')
  if (salaried.length) {
    // A whole period is every weekday of it on payroll: a start on its first weekday (Mon Nov 2 in Nov 1-15, which
    // begins on a Sunday) or a last day on its last weekday is no partial check.
    const fullPeriod = onPayroll.length === allWeekdays.length
    const paidDays = onPayroll.filter((d) => !leaveDays.has(d))
    const recOn = (d: ISODate) => segments.find((s) => s.from <= d && s.to >= d)?.rec
    const maxR = Math.max(...salaried.map((s) => annualOf(s.rec) / ppy))
    let est: number
    if (fullPeriod && leaveDays.size === 0 && salaried.length === segments.length) {
      est =
        segments.length === 1
          ? annualOf(segments[0].rec) / ppy
          : segments.reduce((t, s) => t + (annualOf(s.rec) / ppy) * (weekdayList(s.from, s.to).length / allWeekdays.length), 0)
    } else {
      est = Math.min(maxR, paidDays.reduce((t, d) => t + annualOf(recOn(d) ?? segments[0].rec) / 260, 0))
    }
    // Unpaid time (w-exempt-deductions-ca): exempt staff lose full personal days only; non-exempt salaried staff the hours.
    if (flsa === 'exempt') {
      for (const d of unpaidFullDays) {
        if (leaveDays.has(d)) continue
        const rec = recOn(d)
        if (!rec || rec.payType !== 'salary') continue
        deduction += annualOf(rec) / 260
        unpaidDaysDeducted += 1
      }
      if (partialUnpaid > 0) {
        flags.push({ kind: 'partial_unpaid', tone: 'info', text: 'Unpaid part of a day: not taken off an exempt salary (any work in a day earns the whole day).' })
      }
      if (unpaidSickDays > 0) {
        flags.push({
          kind: 'unpaid_sick',
          tone: 'warn',
          text: 'Sick time recorded as unpaid: check before docking pay. An exempt salary is not reduced for sickness unless a sickness and disability plan covers it.',
        })
      }
    } else if (unpaidHours > 0 && endRec) {
      deduction = unpaidHours * salaryHourlyRate(annualOf(endRec), person.hoursPerWeek).rate
    }
    salaryEstimate = r2(Math.max(0, est - deduction))
    deduction = r2(Math.min(deduction, est))
    if (onPayroll.length > 0 && paidDays.length === 0) {
      flags.push({ kind: 'leave_all_period', tone: 'info', text: 'On leave the whole period: $0 estimated, assuming the leave is unpaid. Add any vacation or sick time they use.' })
    } else if (leaveDays.size > 0) {
      flags.push({
        kind: 'leave_partial',
        tone: 'warn',
        text: 'Part of the period on leave: the estimate is proportional (annual / 260 a weekday worked). Review it: no California rule sets this for a partial week.',
      })
    }
    if (salaried.length < segments.length) {
      flags.push({ kind: 'hourly_segment', tone: 'info', text: 'Paid hourly for part of the period: add those hours from time tracking.' })
    }
    if (startInPeriod) notes.push(fullPeriod ? 'New hire: first check, on payroll every weekday of the period' : `New hire: first check prorated, ${paidDays.length} of ${allWeekdays.length} weekdays`)
    if (payStartsLate) notes.push(`Pay starts ${fmtDay(payFrom)} (the first pay record): ${paidDays.length} of ${allWeekdays.length} weekdays`)
    if (endInPeriod) notes.push(fullPeriod ? `Last day ${fmtDay(endInPeriod)}: on payroll every weekday of the period` : `Last day ${fmtDay(endInPeriod)}: ${paidDays.length} of ${allWeekdays.length} weekdays`)
  } else if (endRec) {
    notes.push(startInPeriod ? 'New hire: hours from your time tracking' : 'Hours from your time tracking')
  }
  for (const c of payChanges) notes.push(`Pay change ${fmtDay(c.effectiveOn)}: ${payWords(c.from)} to ${payWords(c.to)}`)
  if (unpaidDaysDeducted > 0) notes.push(`${unpaidDaysDeducted} unpaid ${unpaidDaysDeducted === 1 ? 'day' : 'days'} taken off the salary`)
  if (hourly?.basis === 'scheduled_hours') {
    notes.push(`Hourly rate: weekly salary / ${hoursText2(person.hoursPerWeek)} scheduled hours, a method for part time (Labor Code 515(d)'s annual / 2080 is for 40 hours)`)
  }
  if (payType === 'hourly' || flsa === 'non_exempt') notes.push('Overtime from the last period is due this payday (hours from time tracking)')

  // Sign-on bonus with the first check (the period that contains the start date).
  const offer = startInPeriod ? hireOffer(db, person) : undefined
  const bonus = offer?.signOnBonus && offer.signOnBonus > 0 ? offer.signOnBonus : 0
  if (bonus) notes.push('Sign-on bonus from the offer, with the first check')

  // Last day in the period: final pay deadline, payouts, off-cycle check. California's deadlines (Labor Code 201 to
  // 203) and payout rule (227.3) apply to work in California only, as the offboarding wizard says; anyone working in
  // another state gets a flag to check that state's rules instead.
  let finalPay: PayRunRow['finalPay']
  let payout: PayRunRow['vacationPayout']
  let otherPayout: PayRunRow['otherPayout']
  let paidOffCycle = false
  const workState = (person.homeState || db.company.hq.state || 'CA').toUpperCase()
  const sep = person.separation
  const issuedOn = sep?.finalPayIssuedOn
  if (endInPeriod) {
    if (!sep) {
      flags.push({ kind: 'no_separation', tone: 'warn', text: 'Last day recorded without an offboarding: start it to get the final pay deadline.' })
    } else if (issuedOn) {
      paidOffCycle = true
      flags.push({ kind: 'final_pay_issued', tone: 'info', text: `Final pay issued ${fmtDay(issuedOn)}: nothing more in this payroll unless wages were missed.` })
      notes.push(`Final pay issued ${fmtDay(issuedOn)}: leave out of this payroll`)
    }
    if (sep && workState !== 'CA') {
      if (!issuedOn) {
        // Other states' final pay rules were not researched (docs/LAW.md): no claim about them, only where to check.
        flags.push({
          kind: 'final_pay_other_state',
          tone: 'warn',
          text: `Works in ${workState}: final pay and any vacation payout follow ${workState}'s rules, not California's. Confirm the deadline with ${providerPhrase(db.company)}.`,
        })
        notes.push(`Last day ${fmtDay(endInPeriod)}: final pay follows ${workState} rules`)
      }
    } else if (sep) {
      const deadline = finalPayDeadline(sep.type, endInPeriod, sep.noticeGivenOn)
      const dueOn = sep.finalPayDueOn ?? deadline.dueOn
      const exposure =
        !issuedOn && date > dueOn && endRec ? waitingTimeExposure({ dailyRate: dailyRateFor(endRec, person.hoursPerWeek), dueOn, asOf: date }) : undefined
      finalPay = {
        dueOn,
        rule: deadline.rule,
        text: deadline.text,
        detail: deadline.detail,
        citation: deadline.citation,
        beforePayday: dueOn < period.payday,
        ...(issuedOn ? { issuedOn } : {}),
        ...(exposure && exposure.daysLate > 0 ? { exposure } : {}),
      }
      if (issuedOn) {
        // Flagged above: nothing more is due in this payroll.
      } else if (exposure && exposure.daysLate > 0) {
        flags.push({
          kind: 'final_pay_late',
          tone: 'bad',
          private: true,
          text: `Final pay was due ${fmtDay(dueOn)} (${deadline.citation.label}). Waiting time penalty so far: ${exposure.daysLate} ${exposure.daysLate === 1 ? 'day' : 'days'} of pay, about ${money(exposure.amount)} (Labor Code 203).`,
        })
      } else if (dueOn < period.payday) {
        const earlier = earlierUnpaidPeriod(db, period, dueOn, person.startDate)
        flags.push({
          kind: 'final_pay_off_cycle',
          tone: 'bad',
          text: `Final check due ${fmtDay(dueOn)} (${deadline.citation.label}), before the ${fmtDay(period.payday)} payday: run an off-cycle (dismissal) payroll.${
            earlier ? ` Include the ${periodLabel(earlier)} wages too: their payday, ${fmtDay(earlier.payday)}, is after the deadline.` : ''
          }`,
        })
      }
      if (!issuedOn) notes.push(`Final check due ${fmtDay(dueOn)} (${deadline.citation.label})${dueOn < period.payday ? ': pay off-cycle' : ''}`)
      const exit = exitPayouts(db, person, endInPeriod)
      payout = exit.vacation
      otherPayout = exit.other
      if (!issuedOn) flags.push(...exit.flags)
      notes.push(...exit.notes)
    }
  } else if (sep && lastDay && lastDay > period.end && workState === 'CA') {
    // Paydays in arrears: this period ended before the last day, but its payday can come after the final pay deadline.
    // Those wages are then part of the final check (Labor Code 201, 202), not this payday's.
    if (issuedOn && issuedOn <= period.payday) {
      paidOffCycle = true
      flags.push({ kind: 'final_pay_issued', tone: 'info', text: `Final pay issued ${fmtDay(issuedOn)}, before this payday: it paid these wages too. Leave them out unless any were missed.` })
      notes.push(`Final pay issued ${fmtDay(issuedOn)}: leave out of this payroll`)
    } else if (!issuedOn) {
      const deadline = finalPayDeadline(sep.type, lastDay, sep.noticeGivenOn)
      const dueOn = sep.finalPayDueOn ?? deadline.dueOn
      if (dueOn < period.payday) {
        flags.push({
          kind: 'final_pay_arrears',
          tone: 'bad',
          text: `Last day ${fmtDay(lastDay)}: these wages are part of the final check due ${fmtDay(dueOn)} (${deadline.citation.label}). Pay them off-cycle, not on ${fmtDay(period.payday)}.`,
        })
        notes.push(`Wages due with the final check by ${fmtDay(dueOn)} (${deadline.citation.label}): pay off-cycle`)
      }
    }
  }

  // Pay floors: the work location's minimum wage for hourly pay, the exempt salary for a full period.
  if (endRec && payType === 'hourly' && rate > 0) {
    const mw = minWageFor(db, person)
    if (rate < mw.floor) flags.push({ kind: 'min_wage', tone: 'bad', private: true, text: `${money2(rate)} an hour is below the ${money2(mw.floor)} minimum wage ${mw.where}.` })
  }
  if (endRec && flsa === 'exempt' && !startInPeriod && !endInPeriod && !payStartsLate) {
    const issue = exemptCheck(db.settings.law, {
      payType: endRec.payType,
      salary: endRec.salary,
      hourlyRate: endRec.hourlyRate,
      hoursPerWeek: person.hoursPerWeek,
      exemptionBasis: endRec.exemptionBasis ?? person.exemptionBasis,
      state: person.homeState,
    })
    if (issue) flags.push({ kind: 'exempt_floor', tone: 'warn', private: true, text: issue.text })
  }

  const sick = balances(db, person.id, spanEnd).find((b) => b.policy.kind === 'sick')
  const payoutAmount = (payout?.amount ?? 0) + (otherPayout?.amount ?? 0)
  const estimatedGross = paidOffCycle || salaryEstimate === null ? null : r2(salaryEstimate + bonus + payoutAmount)
  if (salaryEstimate !== null || bonus || payoutAmount) notes.push('Estimate only: the provider calculates taxes and net pay')

  return {
    personId: person.id,
    name: fullName(person),
    firstName: person.firstName,
    lastName: person.lastName,
    employeeNumber: person.hireNumber,
    ...(person.payrollId?.trim() ? { payrollId: person.payrollId.trim() } : {}),
    workEmail: person.workEmail,
    payType,
    flsa,
    rate,
    rateBasis: payType === 'hourly' ? 'hour' : 'year',
    ...(hourly ? { hourlyEquivalent: r2(hourly.rate), hourlyBasis: hourly.basis } : {}),
    hoursPerWeek: person.hoursPerWeek,
    ...(startInPeriod ? { startInPeriod } : {}),
    ...(endInPeriod ? { endInPeriod } : {}),
    weekdays: allWeekdays.length,
    weekdaysOnPayroll: onPayroll.length,
    regularAmount,
    salaryEstimate: paidOffCycle ? null : salaryEstimate,
    deduction,
    unpaidDaysDeducted,
    bonus,
    ...(payout ? { vacationPayout: payout } : {}),
    ...(otherPayout ? { otherPayout } : {}),
    estimatedGross,
    payChanges,
    timeOff,
    ...(leave ? { leave } : {}),
    ...(finalPay ? { finalPay } : {}),
    ...(paidOffCycle ? { paidOffCycle } : {}),
    ...(sick?.balance != null ? { sickBalance: r2(sick.balance) } : {}),
    flags,
    notes,
  }
}

// ---------------------------------------------------------------------------------------------
// The period
// ---------------------------------------------------------------------------------------------

/** People on payroll at any time in the period: started on or before its end, last day (if any) on or after its start. */
export function peopleOnPayroll(db: Pick<DB, 'people'>, period: { start: ISODate; end: ISODate }): Person[] {
  return db.people
    .filter((p) => p.startDate <= period.end && (lastDayOf(p) ?? '9999-12-31') >= period.start)
    .sort((a, b) => a.hireNumber - b.hireNumber || a.lastName.localeCompare(b.lastName))
}

/** Everything the pay run for one period needs, as of `date` (status, waiting-time exposure). */
export function payRunPrep(db: DB, period: PayPeriod, date: ISODate): PayRunPrep {
  const schedule = db.company.paySchedule
  const ppy = payPeriodsPerYear(schedule)
  const people = peopleOnPayroll(db, period)
  const rows = people.map((p) => personRow(db, p, period, date, ppy))
  const names = new Map(people.map((p) => [p.id, fullName(p)]))
  const pendingTimeOff = db.timeOffRequests
    .filter((r) => r.status === 'pending' && names.has(r.personId) && r.endDate >= period.start && r.startDate <= period.end)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
    .map((r) => ({ requestId: r.id, personId: r.personId, name: names.get(r.personId) as string, startDate: r.startDate, endDate: r.endDate }))
  for (const p of pendingTimeOff) {
    const row = rows.find((x) => x.personId === p.personId)
    row?.flags.push({ kind: 'pending_time_off', tone: 'warn', text: `Time off request for ${periodLabel({ start: p.startDate, end: p.endDate })} is waiting for a decision.` })
  }

  const notices: string[] = []
  const late = latePayday(schedule, period, db.holidays)
  if (late) notices.push(latePaydayText(period, late))
  if (schedule === 'monthly') {
    const hourly = rows.filter((r) => r.flsa === 'non_exempt').map((r) => r.name)
    if (hourly.length) {
      notices.push(
        `Monthly pay is allowed only for exempt staff (Labor Code 204). ${hourly.join(', ')} ${hourly.length === 1 ? 'is non-exempt and needs' : 'are non-exempt and need'} at least two paydays a month.`,
      )
    }
  }

  const record = runForPeriod(db.company.payRuns, period)
  return {
    period,
    schedule,
    periodsPerYear: ppy,
    rows,
    totals: payRunTotals(rows),
    pendingTimeOff,
    notices,
    ...(record ? { record } : {}),
    status: payRunStatus(record, period, date),
  }
}

/**
 * The period's sums (PayRunTotals): the estimated gross of the rows that have one, with the bonuses and payouts inside
 * it, and apart from it the bonuses and payouts of people paid hourly (their gross waits for the hours). Final pay
 * already issued off-cycle counts nowhere.
 */
export function payRunTotals(rows: ReadonlyArray<PayRunRow>): PayRunTotals {
  const inGross = rows.filter((r) => r.estimatedGross !== null)
  const sum = (list: ReadonlyArray<PayRunRow>, f: (r: PayRunRow) => number) => r2(list.reduce((t, r) => t + f(r), 0))
  const outside = rows
    .filter((r) => r.estimatedGross === null && !r.paidOffCycle && (r.bonus > 0 || r.vacationPayout || r.otherPayout))
    .map((r) => ({ personId: r.personId, name: r.name, bonus: r.bonus, vacationPayout: r.vacationPayout?.amount ?? 0, otherPayout: r.otherPayout?.amount ?? 0 }))
  return {
    people: rows.length,
    estimatedGross: sum(inGross, (r) => r.estimatedGross ?? 0),
    salaried: inGross.length,
    hourly: rows.filter((r) => r.payType === 'hourly').length,
    bonus: sum(inGross, (r) => r.bonus),
    vacationPayout: sum(inGross, (r) => r.vacationPayout?.amount ?? 0),
    otherPayout: sum(inGross, (r) => r.otherPayout?.amount ?? 0),
    outside,
  }
}

/**
 * The notice for a payday past its Labor Code 204 date. Within the DLSE next-business-day position (past a Saturday, a
 * Sunday or a holiday the company observes) it says so, with the business day before as the always-lawful choice.
 * Past a Federal Reserve bank holiday the company works, no cited source covers the payday: pay the business day before.
 */
export function latePaydayText(period: Pick<PayPeriod, 'payday' | 'scheduledPayday'>, late: { limit: ISODate; dlseDay: ISODate; covered: boolean }): string {
  const head = `Payday ${fmtDay(period.payday)} falls after ${fmtDay(late.limit)}, the Labor Code 204 date, because the scheduled day is not a business day.`
  if (late.covered) {
    return `${head} The Labor Commissioner's position allows the next business day after a Saturday, a Sunday or a holiday you observe (DLSE Manual 7.6.2); paying the business day before is always lawful (Labor Code 219).`
  }
  return `${head} The Labor Commissioner's next-business-day position (DLSE Manual 7.6.2) reaches only ${fmtDay(late.dlseDay)}: a bank holiday you work, when direct deposits cannot settle, is not covered. Pay the business day before instead (Labor Code 219).`
}

/** Who changed this period, for the summary above the table. */
export function periodChanges(prep: PayRunPrep): {
  newHires: PayRunRow[]
  leaving: PayRunRow[]
  payChanges: PayRunRow[]
  bonuses: PayRunRow[]
  timeOff: PayRunRow[]
  leaves: PayRunRow[]
} {
  const rows = prep.rows
  return {
    newHires: rows.filter((r) => r.startInPeriod),
    leaving: rows.filter((r) => r.endInPeriod),
    payChanges: rows.filter((r) => r.payChanges.length > 0),
    bonuses: rows.filter((r) => r.bonus > 0),
    timeOff: rows.filter((r) => r.timeOff.pto + r.timeOff.sick + r.timeOff.other + r.timeOff.unpaid > 0),
    leaves: rows.filter((r) => r.leave),
  }
}

/** 'Your PEO' when the provider has no name, for headings. */
export function providerTitle(db: Pick<DB, 'company'>): string {
  const name = payrollProviderName(db.company)
  return name || (db.company.payrollProvider?.kind === 'Payroll' ? 'Your payroll provider' : 'Your PEO')
}

/** True when someone on payroll in the period has a pay rate (a company with an unpaid founder only runs no payroll). */
export function hasPaidPeople(db: Pick<DB, 'people' | 'comp'>, period: { start: ISODate; end: ISODate }): boolean {
  return peopleOnPayroll(db, period).some((p) =>
    db.comp.some((c) => c.personId === p.id && c.effectiveOn <= period.end && ((c.payType === 'hourly' ? c.hourlyRate : c.salary) ?? 0) > 0),
  )
}

/**
 * The pay run the admin should do next: the earliest period whose payday is today or later, not yet marked
 * submitted, with someone paid on it. Undefined when there is none (no paid people, or everything submitted).
 */
export function nextPayRunDue(db: DB, date: ISODate): PayPeriod | undefined {
  return payCalendar(db, addDays(date, -45), addDays(date, 62)).find(
    (p) => p.payday >= date && !runForPeriod(db.company.payRuns, p)?.submittedOn && hasPaidPeople(db, p),
  )
}

/** How many days after a payday the inbox asks whether a payroll nobody marked submitted ran. */
export const UNMARKED_REMINDER_DAYS = 7

/**
 * Periods whose payday passed in the last `days` days (not today) without a Mark submitted, with someone paid on
 * them, oldest first. Past that window the period list still says 'Not marked'.
 */
export function unmarkedPayRuns(db: DB, date: ISODate, days = UNMARKED_REMINDER_DAYS): PayPeriod[] {
  const from = addDays(date, -days)
  return payCalendar(db, addDays(from, -45), date).filter(
    (p) => p.payday < date && p.payday >= from && !runForPeriod(db.company.payRuns, p)?.submittedOn && hasPaidPeople(db, p),
  )
}

/**
 * What changed in a period, counted cheaply for the inbox line (payRunPrep does the full work on the page):
 * 'Lucas Ferreira starts; 1 pay change; time off for 2 people'.
 */
export function periodHeadline(db: Pick<DB, 'people' | 'comp' | 'timeOffRequests' | 'leaveCases' | 'offers'>, period: { start: ISODate; end: ISODate }): string {
  const people = peopleOnPayroll(db, period)
  const parts: string[] = []
  const starts = people.filter((p) => p.startDate >= period.start)
  const leaving = people.filter((p) => {
    const last = lastDayOf(p)
    return !!last && last <= period.end
  })
  const names = (list: Person[]) => (list.length <= 2 ? list.map((p) => fullName(p)).join(' and ') : `${list.length} people`)
  if (starts.length) parts.push(`${names(starts)} ${starts.length === 1 ? 'starts' : 'start'}`)
  if (leaving.length) parts.push(`${names(leaving)} ${leaving.length === 1 ? 'leaves' : 'leave'}`)
  const ids = new Set(people.map((p) => p.id))
  const changed = new Set<ID>()
  for (const p of people) {
    const rows = compHistory(db as DB, p.id)
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].effectiveOn >= period.start && rows[i].effectiveOn <= period.end && !samePay(rows[i - 1], rows[i])) changed.add(p.id)
    }
  }
  if (changed.size) parts.push(`${changed.size} pay ${changed.size === 1 ? 'change' : 'changes'}`)
  const bonuses = starts.filter((p) => (hireOffer(db, p)?.signOnBonus ?? 0) > 0).length
  if (bonuses) parts.push(`${bonuses} sign-on ${bonuses === 1 ? 'bonus' : 'bonuses'}`)
  const off = new Set(
    db.timeOffRequests.filter((r) => r.status === 'approved' && ids.has(r.personId) && r.endDate >= period.start && r.startDate <= period.end).map((r) => r.personId),
  )
  if (off.size) parts.push(`time off for ${off.size === 1 ? '1 person' : `${off.size} people`}`)
  const onLeave = new Set(
    db.leaveCases
      .filter((l) => ids.has(l.personId) && l.startDate <= period.end && (leaveLastDay(l) ?? '9999-12-31') >= period.start)
      .map((l) => l.personId),
  )
  if (onLeave.size) parts.push(`${onLeave.size === 1 ? '1 person' : `${onLeave.size} people`} on leave`)
  return parts.length ? parts.join('; ') : 'No starts, last days, pay changes or time off'
}
