// Pay calendar for pay run prep (docs/SPEC.md: PAY RUN PREP): the company's pay periods, each payday moved off
// weekends and holidays, and the 'Run payroll by' cutoff. Pure functions; every date is a parameter.
//
// Legal basis (docs/LAW.md), not legal advice:
//   w-pay-frequency   Labor Code 204(a): work on the 1st to the 15th is paid by the 26th, the 16th to month end by
//                     the 10th of the next month; every two weeks within 7 days of the period end (204(d)); monthly
//                     only for exempt staff, on or before the 26th, with the whole month's salary.
//   w-payday-holiday  No statute moves a weekend or holiday payday. The default pays the business day before, which
//                     is always lawful (w-pay-early, Labor Code 219); 'after' is the Labor Commissioner's
//                     next-business-day option (DLSE Manual 7.6.2; Parsons v. Estenson Logistics, 2022).
//   w-bank-holidays   Business days skip Saturdays, Sundays, Federal Reserve bank holidays and company holidays.
// The cutoff is the provider's deadline, not a legal one: payday minus N business days (Settings, default 2).
// It also skips company holidays, because the admin is off then.
import { format } from 'date-fns'
import { payPeriods } from '@/domain/timeoff'
import type { Company, DB, Holiday, PayrollPrepSettings } from '@/domain/types'
import { addDays, bankHolidays, type ISODate, isWeekday, parseDate } from '@/lib/dates'

/** The most business days the cutoff can sit before payday (Settings offers 0 to this). */
export const MAX_CUTOFF_BUSINESS_DAYS = 10

/** Pay run prep settings with every default filled in. */
export type PayrollSettings = {
  cutoffBusinessDays: number
  paydayShift: 'before' | 'after'
  semiMonthlyPaydays: { first: number; second: number }
}

/** The defaults: run payroll 2 business days ahead, pay the business day before, the 15th and the last day. */
export function defaultPayrollSettings(): PayrollSettings {
  return { cutoffBusinessDays: 2, paydayShift: 'before', semiMonthlyPaydays: { first: 15, second: 0 } }
}

/**
 * Why semi-monthly paydays cannot be used, or null. The 1st to the 15th is paid from the 15th to the 26th of the
 * same month (Labor Code 204(a) sets the 26th as the latest); the 16th to month end on the last day (0) or on the
 * 1st to the 10th of the next month (204(a) sets the 10th).
 */
export function semiMonthlyPaydaysProblem(p: { first: number; second: number }): string | null {
  if (!Number.isInteger(p.first) || p.first < 15 || p.first > 26) {
    return 'Pick a payday from the 15th to the 26th for the 1st to the 15th: Labor Code 204 sets the 26th as the latest.'
  }
  if (!Number.isInteger(p.second) || p.second < 0 || p.second > 10) {
    return 'Pick the last day of the month, or the 1st to the 10th of the next month, for the 16th to month end: Labor Code 204 sets the 10th as the latest.'
  }
  return null
}

/** Why a cutoff cannot be used, or null: a whole number of business days from 0 to MAX_CUTOFF_BUSINESS_DAYS. */
export function cutoffDaysProblem(n: number | null | undefined): string | null {
  if (n == null || !Number.isInteger(n) || n < 0 || n > MAX_CUTOFF_BUSINESS_DAYS) {
    return `Pick 0 to ${MAX_CUTOFF_BUSINESS_DAYS} business days: how long before payday your provider needs the payroll.`
  }
  return null
}

/** Why pay run prep settings cannot be saved, or null. Semi-monthly paydays are checked only on that schedule. */
export function payrollSettingsProblem(s: PayrollSettings, schedule: Company['paySchedule']): string | null {
  return cutoffDaysProblem(s.cutoffBusinessDays) ?? (schedule === 'semi_monthly' ? semiMonthlyPaydaysProblem(s.semiMonthlyPaydays) : null)
}

/** The company's pay run prep settings, with defaults for anything unset or out of range. */
export function payrollSettings(company: Pick<Company, 'payroll'>): PayrollSettings {
  const p: PayrollPrepSettings = company.payroll ?? {}
  const d = defaultPayrollSettings()
  const n = p.cutoffBusinessDays
  const semi = p.semiMonthlyPaydays
  return {
    cutoffBusinessDays: typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_CUTOFF_BUSINESS_DAYS ? n : d.cutoffBusinessDays,
    paydayShift: p.paydayShift === 'after' ? 'after' : 'before',
    semiMonthlyPaydays: semi && !semiMonthlyPaydaysProblem(semi) ? { first: semi.first, second: semi.second } : d.semiMonthlyPaydays,
  }
}

/**
 * Names that stand for "no name yet": the old placeholder 'Your payroll or PEO provider' that workspaces started
 * before 2026-10-11 stored, and the sample's generic 'Your PEO' (docs/SAMPLE.md), which reads wrong mid-sentence
 * ('Mark submitted to Your PEO').
 */
const PLACEHOLDER_PROVIDER_NAMES = new Set(['your payroll or peo provider', 'your peo', 'your payroll provider'])

/** The payroll or PEO provider's name, or '' when there is none yet (a placeholder counts as none). */
export function payrollProviderName(company: Pick<Company, 'payrollProvider'>): string {
  const name = company.payrollProvider?.name?.trim() ?? ''
  return PLACEHOLDER_PROVIDER_NAMES.has(name.toLowerCase()) ? '' : name
}

/** The provider in a sentence: its name, else 'your PEO' or 'your payroll provider'. */
export function providerPhrase(company: Pick<Company, 'payrollProvider'>): string {
  const name = payrollProviderName(company)
  if (name) return name
  return company.payrollProvider?.kind === 'Payroll' ? 'your payroll provider' : 'your PEO'
}

// ---------------------------------------------------------------------------------------------
// Business days
// ---------------------------------------------------------------------------------------------

/**
 * Days that are not pay business days around [from, to]: Federal Reserve bank holidays for the year before
 * through the year after, plus the company's own holidays. Weekends are checked separately (isPayBusinessDay).
 */
export function payClosures(holidays: ReadonlyArray<Pick<Holiday, 'date'>>, from: ISODate, to: ISODate): Set<ISODate> {
  const out = new Set<ISODate>(holidays.map((h) => h.date))
  for (let y = Number(from.slice(0, 4)) - 1; y <= Number(to.slice(0, 4)) + 1; y++) for (const d of bankHolidays(y)) out.add(d)
  return out
}

export function isPayBusinessDay(d: ISODate, closed: ReadonlySet<ISODate>): boolean {
  return isWeekday(d) && !closed.has(d)
}

/** The date itself on a business day, else the business day before (or after) it. */
export function shiftToBusinessDay(d: ISODate, shift: 'before' | 'after', closed: ReadonlySet<ISODate>): ISODate {
  let cur = d
  const step = shift === 'after' ? 1 : -1
  while (!isPayBusinessDay(cur, closed)) cur = addDays(cur, step)
  return cur
}

/** The business day `n` business days before `d` (`d` itself when n is 0). */
export function businessDaysBefore(d: ISODate, n: number, closed: ReadonlySet<ISODate>): ISODate {
  let cur = d
  let left = n
  while (left > 0) {
    cur = addDays(cur, -1)
    if (isPayBusinessDay(cur, closed)) left -= 1
  }
  return cur
}

// ---------------------------------------------------------------------------------------------
// Periods and paydays
// ---------------------------------------------------------------------------------------------

export type PayPeriod = {
  start: ISODate
  end: ISODate
  /** The day the schedule names: the 15th, the last day, the 26th, or the Friday after a two-week period. */
  scheduledPayday: ISODate
  /** The scheduled payday on a business day (moved before or after it by Settings). */
  payday: ISODate
  /** 'Run payroll by': payday minus the cutoff business days. */
  cutoff: ISODate
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function lastDayOfMonth(ym: string): number {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m, 0).getDate()
}

/**
 * The payday the schedule names for a period, before any weekend or holiday move. Semi-monthly: the 1st to the
 * 15th on `first` of the month, the 16th to month end on its last day or on `second` of the next month. Monthly:
 * the 26th, the latest day Labor Code 204 allows for paying exempt staff monthly. Every two weeks: the Friday
 * after the period ends (1 to 7 days later, within 204(d)'s 7 days).
 */
export function scheduledPayday(schedule: Company['paySchedule'], period: { start: ISODate; end: ISODate }, settings: PayrollSettings): ISODate {
  if (schedule === 'biweekly') {
    let d = addDays(period.end, 1)
    while (parseDate(d).getDay() !== 5) d = addDays(d, 1)
    return d
  }
  const ym = period.start.slice(0, 7)
  if (schedule === 'monthly') return `${ym}-26`
  const { first, second } = settings.semiMonthlyPaydays
  if (period.start.slice(8) === '01') return `${ym}-${pad(Math.min(first, lastDayOfMonth(ym)))}`
  if (second === 0) return period.end
  const next = addDays(period.end, 1).slice(0, 7)
  return `${next}-${pad(second)}`
}

/** The latest payday Labor Code 204 names for a period, before the next-business-day allowance (w-pay-frequency). */
export function lawfulPaydayLimit(schedule: Company['paySchedule'], period: { start: ISODate; end: ISODate }): ISODate {
  if (schedule === 'biweekly') return addDays(period.end, 7)
  const ym = period.start.slice(0, 7)
  if (schedule === 'monthly' || period.start.slice(8) === '01') return `${ym}-26`
  return `${addDays(period.end, 1).slice(0, 7)}-10`
}

/** A payday that lands after its Labor Code 204 date, and how far the Labor Commissioner's position reaches. */
export type LatePayday = {
  /** The Labor Code 204 date (lawfulPaydayLimit). */
  limit: ISODate
  /**
   * The next business day the DLSE position allows (DLSE Manual 7.6.2, docs/LAW.md w-payday-holiday): the first day
   * on or after the 204 date that is not a Saturday, a Sunday or a holiday the company observes.
   */
  dlseDay: ISODate
  /**
   * True when the payday is on or before dlseDay. False when a Federal Reserve bank holiday the company works
   * pushed it further (Columbus Day, which Code of Civil Procedure 135 leaves out): no cited source covers that day.
   */
  covered: boolean
}

/**
 * Null for a payday on or before its Labor Code 204 date; otherwise the 204 date, the DLSE next business day and
 * whether the payday stays within it. Only weekends and company holidays count for the DLSE day: the position reaches
 * past a Saturday, a Sunday or a holiday the employer observes, not past a bank holiday the company works.
 */
export function latePayday(
  schedule: Company['paySchedule'],
  period: Pick<PayPeriod, 'start' | 'end' | 'payday'>,
  holidays: ReadonlyArray<Pick<Holiday, 'date'>>,
): LatePayday | null {
  const limit = lawfulPaydayLimit(schedule, period)
  if (period.payday <= limit) return null
  const observed = new Set(holidays.map((h) => h.date))
  let dlseDay = limit
  while (!isPayBusinessDay(dlseDay, observed)) dlseDay = addDays(dlseDay, 1)
  return { limit, dlseDay, covered: period.payday <= dlseDay }
}

/**
 * The pay periods overlapping [from, to] with their paydays and cutoffs. Periods come from payPeriods in
 * src/domain/timeoff.ts (biweekly anchored on the founding date), the same ones vacation accrual uses.
 */
export function payCalendar(db: Pick<DB, 'company' | 'holidays'>, from: ISODate, to: ISODate): PayPeriod[] {
  const settings = payrollSettings(db.company)
  const schedule = db.company.paySchedule
  const periods = payPeriods(schedule, from, to, db.company.foundedOn)
  if (!periods.length) return []
  const closed = payClosures(db.holidays, periods[0].start, addDays(periods[periods.length - 1].end, 45))
  return periods.map((p) => {
    const sched = scheduledPayday(schedule, p, settings)
    const payday = shiftToBusinessDay(sched, settings.paydayShift, closed)
    return { start: p.start, end: p.end, scheduledPayday: sched, payday, cutoff: businessDaysBefore(payday, settings.cutoffBusinessDays, closed) }
  })
}

/** The pay period that contains the date. */
export function periodContaining(db: Pick<DB, 'company' | 'holidays'>, date: ISODate): PayPeriod {
  return payCalendar(db, date, date)[0]
}

/** The pay period that starts on `start`, if the schedule has one. */
export function periodStarting(db: Pick<DB, 'company' | 'holidays'>, start: ISODate): PayPeriod | undefined {
  return payCalendar(db, start, start).find((p) => p.start === start)
}

/** `before` periods ahead of the one containing the date, that one, and `after` periods following it. */
export function periodsAround(db: Pick<DB, 'company' | 'holidays'>, date: ISODate, before: number, after: number): PayPeriod[] {
  const all = payCalendar(db, addDays(date, -31 * (before + 1)), addDays(date, 31 * (after + 1)))
  const i = all.findIndex((p) => p.start <= date && p.end >= date)
  return i < 0 ? all : all.slice(Math.max(0, i - before), i + after + 1)
}

/** The earliest period whose payday is on or after the date (in arrears, the period just ended can still be it). */
export function nextPayPeriod(db: Pick<DB, 'company' | 'holidays'>, date: ISODate): PayPeriod | undefined {
  return payCalendar(db, addDays(date, -45), addDays(date, 62)).find((p) => p.payday >= date)
}

// ---------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------

function shortDay(d: ISODate): string {
  return format(parseDate(d), 'MMM d')
}

/** 'Oct 1-15', 'Oct 16-31', 'Dec 28 to Jan 10', 'Oct 30' for one day (a time off request). */
export function periodLabel(p: { start: ISODate; end: ISODate }): string {
  if (p.start === p.end) return shortDay(p.start)
  if (p.start.slice(0, 7) === p.end.slice(0, 7)) return `${shortDay(p.start)}-${Number(p.end.slice(8))}`
  return `${shortDay(p.start)} to ${shortDay(p.end)}`
}

/** 'Oct 1-15, 2026', 'Dec 28, 2026 to Jan 10, 2027'. */
export function periodLabelLong(p: { start: ISODate; end: ISODate }): string {
  if (p.start.slice(0, 4) === p.end.slice(0, 4)) return `${periodLabel(p)}, ${p.end.slice(0, 4)}`
  return `${format(parseDate(p.start), 'MMM d, yyyy')} to ${format(parseDate(p.end), 'MMM d, yyyy')}`
}

function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'}`
}

/**
 * The regular paydays in plain words, for the Labor Code 2810.5 wage notice and the payday notice (Labor Code
 * 207, docs/LAW.md w-payday-notice): 'the 15th and the last day of each month, or the business day before when
 * that is a weekend or holiday'.
 */
export function paydayWords(company: Pick<Company, 'paySchedule' | 'payroll'>): string {
  const s = payrollSettings(company)
  return `${paydayCoreWords(company)}, or ${paydayShiftWords(s.paydayShift)} when that is a weekend or holiday`
}

/** paydayWords without the weekend and holiday clause: 'the 15th and the last day of each month'. */
function paydayCoreWords(company: Pick<Company, 'paySchedule' | 'payroll'>): string {
  if (company.paySchedule === 'biweekly') return 'every other Friday, for the two weeks that ended before it'
  if (company.paySchedule === 'monthly') return 'the 26th of each month, for the whole month'
  const { first, second } = payrollSettings(company).semiMonthlyPaydays
  if (first === 15 && second === 0) return 'the 15th and the last day of each month'
  const late = second === 0 ? 'the last day of the month' : `the ${ordinal(second)} of the next month`
  return `the ${ordinal(first)} of each month for work on the 1st to the 15th, and ${late} for work from the 16th to month end`
}

/**
 * True when a typed 'Regular payday' (Settings, Company) only repeats the calendar's words for these settings, with
 * or without the weekend clause: the sample's 'the 15th and the last day of each month', or a copy of the hint. Such
 * a text goes stale when the schedule or the paydays change, so the change clears it (dropStaleRegularPayday).
 */
export function isCalendarPaydayText(text: string | undefined, company: Pick<Company, 'paySchedule' | 'payroll'>): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\.$/, '').replace(/\s+/g, ' ')
  const t = norm(text ?? '')
  return !!t && (t === norm(paydayCoreWords(company)) || t === norm(paydayWords(company)))
}

/** Where a payday that is not a business day moves, in words: 'the business day before' or 'the next business day'. */
export function paydayShiftWords(shift: 'before' | 'after'): string {
  return shift === 'after' ? 'the next business day' : 'the business day before'
}

/** '2 business days before payday', 'on payday' for 0. */
export function cutoffWords(n: number): string {
  if (n === 0) return 'on payday'
  return `${n} business ${n === 1 ? 'day' : 'days'} before payday`
}

/**
 * The semi-monthly paydays Settings offers, all inside the Labor Code 204 windows: the 15th to the 26th for the 1st
 * to the 15th, and the last day of the month or the 1st to the 10th of the next month for the 16th to month end.
 */
export function semiMonthlyPaydayChoices(): { first: Array<{ value: number; label: string }>; second: Array<{ value: number; label: string }> } {
  const first = Array.from({ length: 12 }, (_, i) => 15 + i).map((d) => ({ value: d, label: `The ${ordinal(d)}` }))
  const second = [
    { value: 0, label: 'The last day of the month' },
    ...Array.from({ length: 10 }, (_, i) => i + 1).map((d) => ({ value: d, label: `The ${ordinal(d)} of the next month` })),
  ]
  return { first, second }
}
