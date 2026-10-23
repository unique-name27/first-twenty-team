// Company holidays by rule, so next year's set can roll over in one tap (docs/SPEC.md: MONTHLY ADMIN
// NIGHT AND ANNUAL RESET, "In December: next year's holidays roll over"). Business-day math skips
// db.holidays, so a year with no holidays silently counts them as workdays.
//
// Rules: fixed dates that fall on a Saturday are observed the Friday before and on a Sunday the Monday
// after (the federal pattern); nth-weekday holidays never move. New Year's Day on a Saturday is observed
// on Dec 31 of the year before, so it belongs to that year's list. Christmas Eve and the day after
// Christmas move to the nearest free weekday (before and after) when the weekend or another holiday takes
// their date, so the company keeps both days off.
import type { Holiday } from '@/domain/types'
import { addDays, type ISODate, isWeekday, parseDate } from '@/lib/dates'

type Kind = 'fixed' | 'weekday' | 'before' | 'after'

type HolidayRule = {
  /** Name as it appears in the list ('Independence Day'); observed dates add ' (observed)'. */
  name: string
  /** Other names the same rule answers to when rolling a list over. */
  aliases?: string[]
  /** Part of the standard set new workspaces start with. */
  standard: boolean
  kind: Kind
  /** The holiday's own date in a year. */
  on: (year: number) => ISODate
}

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (y: number, m: number, d: number): ISODate => `${y}-${pad(m)}-${pad(d)}`
const dow = (d: ISODate) => parseDate(d).getDay()

/** The nth (1-based) weekday (0 = Sunday) of a month; n = -1 is the last one. */
export function nthWeekday(year: number, month: number, weekday: number, n: number): ISODate {
  if (n > 0) {
    const first = ymd(year, month, 1)
    const offset = (weekday - dow(first) + 7) % 7
    return addDays(first, offset + (n - 1) * 7)
  }
  const nextMonth = month === 12 ? ymd(year + 1, 1, 1) : ymd(year, month + 1, 1)
  const last = addDays(nextMonth, -1)
  return addDays(last, -((dow(last) - weekday + 7) % 7))
}

/** Federal observed date: Saturday moves to Friday, Sunday to Monday. */
export function observedDate(d: ISODate): ISODate {
  const w = dow(d)
  return w === 6 ? addDays(d, -1) : w === 0 ? addDays(d, 1) : d
}

const RULES: HolidayRule[] = [
  { name: "New Year's Day", standard: true, kind: 'fixed', on: (y) => ymd(y, 1, 1) },
  { name: 'Martin Luther King Jr. Day', standard: true, kind: 'weekday', on: (y) => nthWeekday(y, 1, 1, 3) },
  { name: "Presidents' Day", aliases: ["Washington's Birthday"], standard: true, kind: 'weekday', on: (y) => nthWeekday(y, 2, 1, 3) },
  { name: 'Cesar Chavez Day', standard: false, kind: 'fixed', on: (y) => ymd(y, 3, 31) },
  { name: 'Memorial Day', standard: true, kind: 'weekday', on: (y) => nthWeekday(y, 5, 1, -1) },
  { name: 'Juneteenth', standard: true, kind: 'fixed', on: (y) => ymd(y, 6, 19) },
  { name: 'Independence Day', standard: true, kind: 'fixed', on: (y) => ymd(y, 7, 4) },
  { name: 'Labor Day', standard: true, kind: 'weekday', on: (y) => nthWeekday(y, 9, 1, 1) },
  { name: "Indigenous Peoples' Day", aliases: ['Columbus Day'], standard: false, kind: 'weekday', on: (y) => nthWeekday(y, 10, 1, 2) },
  { name: 'Veterans Day', standard: false, kind: 'fixed', on: (y) => ymd(y, 11, 11) },
  { name: 'Thanksgiving', aliases: ['Thanksgiving Day'], standard: true, kind: 'weekday', on: (y) => nthWeekday(y, 11, 4, 4) },
  { name: 'Day after Thanksgiving', standard: true, kind: 'weekday', on: (y) => addDays(nthWeekday(y, 11, 4, 4), 1) },
  { name: 'Christmas Day', aliases: ['Christmas'], standard: true, kind: 'fixed', on: (y) => ymd(y, 12, 25) },
  { name: 'Christmas Eve', standard: true, kind: 'before', on: (y) => ymd(y, 12, 24) },
  { name: 'Day after Christmas', aliases: ['Boxing Day'], standard: false, kind: 'after', on: (y) => ymd(y, 12, 26) },
]

/** 'Independence Day (observed)' -> 'independence day', for matching names across years. */
function baseName(name: string): string {
  return name
    .replace(/\s*\(observed\)\s*$/i, '')
    .trim()
    .toLowerCase()
}

function ruleFor(name: string): HolidayRule | undefined {
  const b = baseName(name)
  return RULES.find((r) => r.name.toLowerCase() === b || r.aliases?.some((a) => a.toLowerCase() === b))
}

const holiday = (date: ISODate, name: string): Holiday => ({ id: `hol-${date}`, date, name })

/**
 * Holidays for a year from the rules, sorted by date. `names` picks which rules to use (any name or
 * alias, observed or not); without it, the standard set: New Year's Day, MLK Day, Presidents' Day,
 * Memorial Day, Juneteenth, Independence Day, Labor Day, Thanksgiving and the day after, Christmas Eve
 * and Christmas Day.
 */
export function holidaysForYear(year: number, names?: Iterable<string>): Holiday[] {
  const wanted = names ? new Set([...names].map((n) => ruleFor(n)).filter((r): r is HolidayRule => !!r)) : undefined
  const rules = RULES.filter((r) => (wanted ? wanted.has(r) : r.standard))
  const taken = new Map<ISODate, string>()
  const put = (date: ISODate, name: string) => {
    if (date.startsWith(`${year}-`) && !taken.has(date)) taken.set(date, name)
  }
  // Fixed and nth-weekday dates first; Christmas Eve and the day after then fit around them.
  for (const r of rules) {
    if (r.kind === 'weekday') put(r.on(year), r.name)
    if (r.kind !== 'fixed') continue
    const own = r.on(year)
    const obs = observedDate(own)
    put(obs, obs === own ? r.name : `${r.name} (observed)`)
    // New Year's Day on a Saturday next year is observed on Dec 31 this year.
    if (r.name === "New Year's Day") {
      const next = r.on(year + 1)
      if (observedDate(next) !== next && observedDate(next) < next) put(observedDate(next), `${r.name} (observed)`)
    }
  }
  for (const r of rules) {
    if (r.kind !== 'before' && r.kind !== 'after') continue
    const own = r.on(year)
    const step = r.kind === 'before' ? -1 : 1
    let d = own
    while (!isWeekday(d) || taken.has(d)) d = addDays(d, step)
    put(d, d === own ? r.name : `${r.name} (observed)`)
  }
  return [...taken.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, name]) => holiday(date, name))
}

export type HolidayRollover = {
  year: number
  /** Holidays to add (dates already in the list are left alone). */
  add: Holiday[]
  /** Years whose lists set which holidays carry over; empty means the standard set was used. */
  basedOn: number[]
  /** Names from those years with no date rule (floating holidays, company days off): add them by hand. */
  byHand: string[]
  /** New Year's Day on a Saturday is observed on Dec 31 of the year before, so it is not in `add`. */
  observedYearBefore: Holiday | null
}

/**
 * Next year's holidays from the company's own recent lists: every rule-based holiday in either of the
 * two years before `year` carries over (so a holiday the company removed stays removed), recomputed for
 * the new year with observed dates. With no recent list, the standard set. Dates already listed are skipped.
 */
export function rolloverHolidays(existing: ReadonlyArray<Holiday>, year: number): HolidayRollover {
  const basedOn = [year - 1, year - 2].filter((y) => existing.some((h) => h.date.startsWith(`${y}-`)))
  const recent = existing.filter((h) => basedOn.some((y) => h.date.startsWith(`${y}-`)))
  const names = recent.map((h) => h.name)
  const byHand = [...new Set(recent.filter((h) => !ruleFor(h.name)).map((h) => h.name.trim()))].sort()
  const have = new Set(existing.map((h) => h.date))
  const add = holidaysForYear(year, basedOn.length ? names : undefined).filter((h) => !have.has(h.date))
  const keepsNewYear = basedOn.length ? names.some((n) => ruleFor(n)?.name === "New Year's Day") : true
  const jan1 = ymd(year, 1, 1)
  const observedYearBefore = keepsNewYear && observedDate(jan1) < jan1 ? holiday(observedDate(jan1), "New Year's Day (observed)") : null
  return { year, add, basedOn, byHand, observedYearBefore }
}

/** True when the company lists at least one holiday in the year. */
export function hasHolidaysIn(existing: ReadonlyArray<Pick<Holiday, 'date'>>, year: number): boolean {
  return existing.some((h) => h.date.startsWith(`${year}-`))
}
