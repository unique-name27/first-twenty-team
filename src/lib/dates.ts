// Dates are stored as ISO strings: 'YYYY-MM-DD' for calendar dates, full ISO for timestamps.
// All calendar math happens on local-midnight Date objects so day counts never drift by timezone.
import {
  addBusinessDays as dfAddBusinessDays,
  addDays as dfAddDays,
  addMonths as dfAddMonths,
  differenceInCalendarDays,
  differenceInCalendarMonths,
  format,
  isValid,
  isWeekend,
  parseISO,
} from 'date-fns'

export type ISODate = string // 'YYYY-MM-DD'
export type ISODateTime = string // full ISO timestamp

let clockOverride: ISODate | null = null

/** Pretend-today for demos and tests (Settings > Data > "Pretend today is"). null = real clock. */
export function setClockOverride(date: ISODate | null): void {
  clockOverride = date
}

export function getClockOverride(): ISODate | null {
  return clockOverride
}

export function parseDate(d: ISODate | ISODateTime): Date {
  if (d.length === 10) {
    const [y, m, day] = d.split('-').map(Number)
    return new Date(y, m - 1, day)
  }
  return parseISO(d)
}

export function toISODate(d: Date): ISODate {
  return format(d, 'yyyy-MM-dd')
}

/** Earliest and latest years a date field accepts (a browser's year box takes up to 6 digits). */
export const MIN_YEAR = 1900
export const MAX_YEAR = 2100

/**
 * True for a real calendar date written 'YYYY-MM-DD' with a year from MIN_YEAR to MAX_YEAR: what a date
 * field passes on. '20266-03-16', '0002-03-16' (a year still being typed) and '2026-02-31' are not.
 */
export function isUsableDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false
  const year = Number(d.slice(0, 4))
  return year >= MIN_YEAR && year <= MAX_YEAR && toISODate(parseDate(d)) === d
}

/** The date or timestamp as a Date, or null when it is not a real one (formatters show '' then, never throw). */
function validDate(d: ISODate | ISODateTime): Date | null {
  const date = parseDate(d)
  return isValid(date) ? date : null
}

export function today(): ISODate {
  return clockOverride ?? toISODate(new Date())
}

/** Now as a timestamp; when the clock is overridden, keeps the real time of day on the pretend date. */
export function nowISO(): ISODateTime {
  const real = new Date()
  if (!clockOverride) return real.toISOString()
  const d = parseDate(clockOverride)
  d.setHours(real.getHours(), real.getMinutes(), real.getSeconds(), 0)
  return d.toISOString()
}

export function addDays(d: ISODate, n: number): ISODate {
  return toISODate(dfAddDays(parseDate(d), n))
}

export function addMonths(d: ISODate, n: number): ISODate {
  return toISODate(dfAddMonths(parseDate(d), n))
}

/** Adds business days (Mon-Fri). Skips the given holidays too. */
export function addBusinessDays(d: ISODate, n: number, holidays: ISODate[] = []): ISODate {
  if (holidays.length === 0) return toISODate(dfAddBusinessDays(parseDate(d), n))
  const skip = new Set(holidays)
  let cur = parseDate(d)
  let left = n
  const step = n >= 0 ? 1 : -1
  while (left !== 0) {
    cur = dfAddDays(cur, step)
    if (!isWeekend(cur) && !skip.has(toISODate(cur))) left -= step
  }
  return toISODate(cur)
}

/**
 * The calendar date of a date or timestamp, in this browser's time zone (the same zone today() and
 * fmtDate use). A timestamp's first 10 characters are its UTC date, which is tomorrow for anything
 * after 5 PM in California, so never slice a timestamp to get its day.
 */
export function localDateOf(d: ISODate | ISODateTime): ISODate {
  return d.length > 10 ? toISODate(parseISO(d)) : d
}

export function daysBetween(from: ISODate, to: ISODate): number {
  return differenceInCalendarDays(parseDate(localDateOf(to)), parseDate(localDateOf(from)))
}

export function monthsBetween(from: ISODate, to: ISODate): number {
  return differenceInCalendarMonths(parseDate(localDateOf(to)), parseDate(localDateOf(from)))
}

/** Whole months elapsed (a month counts only once its day-of-month is reached). Used for vesting. */
export function fullMonthsBetween(from: ISODate, to: ISODate): number {
  const a = parseDate(from.slice(0, 10))
  const b = parseDate(to.slice(0, 10))
  let months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth())
  if (b.getDate() < a.getDate()) months -= 1
  return Math.max(0, months)
}

export function isBefore(a: ISODate, b: ISODate): boolean {
  return localDateOf(a) < localDateOf(b)
}

export function isAfter(a: ISODate, b: ISODate): boolean {
  return localDateOf(a) > localDateOf(b)
}

export function isWithin(d: ISODate, from: ISODate, to: ISODate): boolean {
  const x = localDateOf(d)
  return x >= localDateOf(from) && x <= localDateOf(to)
}

export function isWeekday(d: ISODate): boolean {
  return !isWeekend(parseDate(d.slice(0, 10)))
}

// The formatters return '' for a value that is not a real date (a year typed with 5 digits), so one bad
// value never takes the page down.

/** "Oct 9, 2026" */
export function fmtDate(d: ISODate | ISODateTime | null | undefined): string {
  const date = d ? validDate(d) : null
  return date ? format(date, 'MMM d, yyyy') : ''
}

/** "Oct 9" */
export function fmtShort(d: ISODate | ISODateTime | null | undefined): string {
  const date = d ? validDate(d) : null
  return date ? format(date, 'MMM d') : ''
}

/** "Fri, Oct 9" */
export function fmtDay(d: ISODate | ISODateTime | null | undefined): string {
  const date = d ? validDate(d) : null
  return date ? format(date, 'EEE, MMM d') : ''
}

/**
 * "Fri, Oct 9" in the reference year (today's by default), "Sat, Oct 9, 2027" in any other, so a date a
 * year out never reads like this year's.
 */
export function fmtDayAnyYear(d: ISODate | ISODateTime | null | undefined, ref: ISODate = today()): string {
  const date = d ? validDate(d) : null
  if (!date) return ''
  return format(date, date.getFullYear() === parseDate(ref).getFullYear() ? 'EEE, MMM d' : 'EEE, MMM d, yyyy')
}

/** "Fri, Oct 9, 10:30 AM" */
export function fmtDateTime(d: ISODateTime | null | undefined): string {
  const date = d ? parseISO(d) : null
  return date && isValid(date) ? format(date, 'EEE, MMM d, h:mm a') : ''
}

/** "10:30 AM" */
export function fmtTime(d: ISODateTime | null | undefined): string {
  const date = d ? parseISO(d) : null
  return date && isValid(date) ? format(date, 'h:mm a') : ''
}

/** "Oct 2026" */
export function fmtMonth(d: ISODate | null | undefined): string {
  const date = d ? validDate(d) : null
  return date ? format(date, 'MMM yyyy') : ''
}

/** Relative phrasing against today(): "today", "tomorrow", "in 5 days", "3 days ago", else a date. */
export function fmtRelative(d: ISODate | ISODateTime | null | undefined): string {
  if (!d || !validDate(d)) return ''
  const n = daysBetween(today(), localDateOf(d))
  if (n === 0) return 'today'
  if (n === 1) return 'tomorrow'
  if (n === -1) return 'yesterday'
  if (n > 1 && n <= 14) return `in ${n} days`
  if (n < -1 && n >= -14) return `${-n} days ago`
  return fmtDate(d)
}

/** "1 yr 4 mo", "7 mo", "3 wk" for tenure-style durations. */
export function fmtDuration(from: ISODate, to: ISODate = today()): string {
  const months = fullMonthsBetween(from, to)
  if (months >= 12) {
    const y = Math.floor(months / 12)
    const m = months % 12
    return m ? `${y} yr ${m} mo` : `${y} yr`
  }
  if (months >= 1) return `${months} mo`
  const days = Math.max(0, daysBetween(from, to))
  if (days >= 7) return `${Math.floor(days / 7)} wk`
  return `${days} d`
}

/** Quarter label for a date: "2026-Q4". */
export function quarterOf(d: ISODate): string {
  const date = parseDate(d.slice(0, 10))
  return `${date.getFullYear()}-Q${Math.floor(date.getMonth() / 3) + 1}`
}

/** "Q4 2026" from "2026-Q4". */
export function fmtQuarter(q: string): string {
  const [y, qq] = q.split('-')
  return `${qq} ${y}`
}

/** First day of a quarter label. */
export function quarterStart(q: string): ISODate {
  const [y, qq] = q.split('-Q')
  const month = (Number(qq) - 1) * 3 + 1
  return `${y}-${String(month).padStart(2, '0')}-01`
}

export function quarterEnd(q: string): ISODate {
  return addDays(addMonths(quarterStart(q), 3), -1)
}

export function nextQuarter(q: string, n = 1): string {
  return quarterOf(addMonths(quarterStart(q), 3 * n))
}

// ---- US federal holidays ----------------------------------------------------------------------

function nthWeekdayOfMonth(y: number, month0: number, weekday: number, n: number): number {
  const first = new Date(Date.UTC(y, month0, 1)).getUTCDay()
  return 1 + ((weekday - first + 7) % 7) + 7 * (n - 1)
}

function lastWeekdayOfMonth(y: number, month0: number, weekday: number): number {
  const lastDay = new Date(Date.UTC(y, month0 + 1, 0)).getUTCDate()
  const last = new Date(Date.UTC(y, month0, lastDay)).getUTCDay()
  return lastDay - ((last - weekday + 7) % 7)
}

/**
 * The 11 US federal holidays observed in a year (5 U.S.C. 6103): a Saturday holiday is observed the
 * Friday before, a Sunday one the Monday after. Statutory business-day deadlines (I-9 section 2) skip
 * weekends and these days only, never company-chosen days off (LAW.md b-i9-deadlines).
 */
export function federalHolidays(year: number): ISODate[] {
  const iso = (m0: number, d: number) => `${year}-${String(m0 + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  const observed = (m0: number, d: number): ISODate => {
    const wd = new Date(Date.UTC(year, m0, d)).getUTCDay()
    if (wd === 6) return toISODate(new Date(year, m0, d - 1))
    if (wd === 0) return toISODate(new Date(year, m0, d + 1))
    return iso(m0, d)
  }
  return [
    observed(0, 1), // New Year's Day
    iso(0, nthWeekdayOfMonth(year, 0, 1, 3)), // Martin Luther King Jr. Day
    iso(1, nthWeekdayOfMonth(year, 1, 1, 3)), // Washington's Birthday
    iso(4, lastWeekdayOfMonth(year, 4, 1)), // Memorial Day
    observed(5, 19), // Juneteenth
    observed(6, 4), // Independence Day
    iso(8, nthWeekdayOfMonth(year, 8, 1, 1)), // Labor Day
    iso(9, nthWeekdayOfMonth(year, 9, 1, 2)), // Columbus Day
    observed(10, 11), // Veterans Day
    iso(10, nthWeekdayOfMonth(year, 10, 4, 4)), // Thanksgiving
    observed(11, 25), // Christmas Day
  ].sort()
}

/**
 * The days the Federal Reserve Banks close in a year (docs/LAW.md w-bank-holidays), when direct deposits do
 * not settle: the same 11 holidays as federalHolidays, but only a Sunday holiday moves (to the Monday after).
 * For a Saturday holiday the Reserve Banks stay open the Friday before, so it has no weekday closure at all
 * (Jul 4, 2026; Jun 19 and Dec 25, 2027). Pay calendars use this list, never federalHolidays.
 */
export function bankHolidays(year: number): ISODate[] {
  const iso = (m0: number, d: number) => `${year}-${String(m0 + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  const fixed = (m0: number, d: number): ISODate | null => {
    const wd = new Date(Date.UTC(year, m0, d)).getUTCDay()
    if (wd === 6) return null
    if (wd === 0) return toISODate(new Date(year, m0, d + 1))
    return iso(m0, d)
  }
  const days: Array<ISODate | null> = [
    fixed(0, 1), // New Year's Day
    iso(0, nthWeekdayOfMonth(year, 0, 1, 3)), // Martin Luther King Jr. Day
    iso(1, nthWeekdayOfMonth(year, 1, 1, 3)), // Washington's Birthday
    iso(4, lastWeekdayOfMonth(year, 4, 1)), // Memorial Day
    fixed(5, 19), // Juneteenth
    fixed(6, 4), // Independence Day
    iso(8, nthWeekdayOfMonth(year, 8, 1, 1)), // Labor Day
    iso(9, nthWeekdayOfMonth(year, 9, 1, 2)), // Columbus Day
    fixed(10, 11), // Veterans Day
    iso(10, nthWeekdayOfMonth(year, 10, 4, 4)), // Thanksgiving
    fixed(11, 25), // Christmas Day
  ]
  return days.filter((d): d is ISODate => d !== null).sort()
}

/** Federal holidays from the year before to the year after a date (enough for any short deadline). */
export function federalHolidaysAround(d: ISODate): ISODate[] {
  const y = Number(d.slice(0, 4))
  return [...federalHolidays(y - 1), ...federalHolidays(y), ...federalHolidays(y + 1)]
}

// ---- Pacific time (the company's time zone; US daylight-saving rules) ---------------------------

function nthSunday(y: number, month0: number, n: number): number {
  const first = new Date(Date.UTC(y, month0, 1)).getUTCDay()
  const firstSunday = 1 + ((7 - first) % 7)
  return firstSunday + 7 * (n - 1)
}

/** True when the calendar date is in Pacific daylight time (second Sunday of March to first Sunday of November). */
export function isPacificDaylight(d: ISODate): boolean {
  const [y, m, day] = d.slice(0, 10).split('-').map(Number)
  const start = `${y}-03-${String(nthSunday(y, 2, 2)).padStart(2, '0')}`
  const end = `${y}-11-${String(nthSunday(y, 10, 1)).padStart(2, '0')}`
  const cur = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return cur >= start && cur < end
}

/** UTC offset in hours for Pacific time on the date: -7 (PDT) or -8 (PST). */
export function pacificOffsetHours(d: ISODate): number {
  return isPacificDaylight(d) ? -7 : -8
}

/** The Pacific calendar date of a timestamp (exact outside the 12-3 AM window on transition days). */
export function pacificDateOf(iso: ISODateTime): ISODate {
  const t = new Date(iso).getTime()
  const asPDT = new Date(t - 7 * 3_600_000).toISOString().slice(0, 10)
  return isPacificDaylight(asPDT) ? asPDT : new Date(t - 8 * 3_600_000).toISOString().slice(0, 10)
}

/**
 * Moves a timestamp by whole calendar days keeping its Pacific wall-clock time, so a 10 AM interview
 * stays at 10 AM when the move crosses a daylight-saving change.
 */
export function shiftTimestampDays(iso: ISODateTime, days: number): ISODateTime {
  const t = new Date(iso).getTime()
  const naive = t + days * 86_400_000
  const before = pacificOffsetHours(pacificDateOf(iso))
  const after = pacificOffsetHours(pacificDateOf(new Date(naive).toISOString()))
  return new Date(naive + (before - after) * 3_600_000).toISOString()
}

/** Shift every date-looking string in a value by n days (used to keep sample data current). */
export function shiftDatesDeep<T>(value: T, days: number, skipKeys: Set<string> = new Set()): T {
  if (days === 0) return value
  const dateRe = /^\d{4}-\d{2}-\d{2}$/
  const dateTimeRe = /^\d{4}-\d{2}-\d{2}T/
  const walk = (v: unknown, key?: string): unknown => {
    if (key && skipKeys.has(key)) return v
    if (typeof v === 'string') {
      if (dateRe.test(v)) return addDays(v, days)
      if (dateTimeRe.test(v)) return shiftTimestampDays(v, days)
      return v
    }
    if (Array.isArray(v)) return v.map((x) => walk(x))
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, k)
      return out
    }
    return v
  }
  return walk(value) as T
}
