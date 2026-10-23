// Checks on the pay schedule and pay run settings before they are saved (Settings, Company and Link-outs; docs/SPEC.md
// PAY RUN PREP). Pure functions over the DB; every date is a parameter.
//
// Legal basis (docs/LAW.md), not legal advice:
//   w-pay-frequency   Labor Code 204(a): monthly pay only when everyone on that schedule is exempt; non-exempt staff
//                     are paid at least twice a month.
//   w-payday-holiday  The Labor Commissioner's next-business-day position (DLSE Manual 7.6.2) reaches past a Saturday,
//                     a Sunday or a holiday the employer observes; paying the business day before is always lawful.
//   w-wtpa-notice     A new payday is a change the Labor Code 2810.5 notice covers for non-exempt staff: written notice
//                     within 7 calendar days.
import { lastDayOf } from '@/domain/pay'
import { fullName } from '@/domain/people'
import type { Company, DB, Person } from '@/domain/types'
import { addDays, fmtDay, type ISODate } from '@/lib/dates'
import { listJoin } from '@/lib/format'
import { latePayday, type LatePayday, payCalendar, type PayPeriod, type PayrollSettings } from './calendar'

/** Non-exempt people employed on the date or starting later (anyone whose last day has not passed), in hire order. */
export function nonExemptStaff(db: Pick<DB, 'people'>, date: ISODate): Person[] {
  return db.people
    .filter((p) => p.flsa === 'non_exempt' && (lastDayOf(p) ?? '9999-12-31') >= date)
    .sort((a, b) => a.hireNumber - b.hireNumber)
}

/**
 * Why a monthly pay schedule cannot be saved, or null: Labor Code 204(a) allows monthly pay only when everyone on it
 * is exempt, so anyone non-exempt employed today or starting later blocks it (named).
 */
export function monthlyScheduleProblem(db: Pick<DB, 'people'>, date: ISODate): string | null {
  const names = nonExemptStaff(db, date).map((p) => fullName(p))
  if (!names.length) return null
  return `Monthly pay is allowed only when everyone on it is exempt (Labor Code 204). ${listJoin(names)} ${names.length === 1 ? 'is' : 'are'} non-exempt and ${
    names.length === 1 ? 'needs' : 'need'
  } at least two paydays a month: keep a semi-monthly or two-week schedule.`
}

/**
 * The reminder shown while paydays or the pay schedule change: non-exempt staff get written notice of the new paydays
 * within 7 days (Labor Code 2810.5). Null with nobody non-exempt.
 */
export function paydayChangeNotice(db: Pick<DB, 'people'>, date: ISODate): string | null {
  const names = nonExemptStaff(db, date).map((p) => fullName(p))
  if (!names.length) return null
  return `Changing paydays? ${listJoin(names)} ${names.length === 1 ? 'is' : 'are'} non-exempt: give written notice of the new paydays within 7 days (Labor Code 2810.5).`
}

/** 'Mon, Nov 30', with the year when it is not the year of `date` ('Tue, Oct 12, 2027'). */
function dayWithYear(d: ISODate, date: ISODate): string {
  return d.slice(0, 4) === date.slice(0, 4) ? fmtDay(d) : `${fmtDay(d)}, ${d.slice(0, 4)}`
}

/**
 * The words for latePaydaysWith, for the settings form: a title and a sentence that lists up to four paydays (each
 * with the 204 date it is for), says which a bank holiday the company works pushed out of the DLSE position, and
 * names the fix. Null when nothing is late.
 */
export function latePaydaysText(late: ReadonlyArray<LatePaydayPreview>, date: ISODate): { title: string; text: string } | null {
  if (!late.length) return null
  const shown = late.slice(0, 4).map((l) => `${dayWithYear(l.payday, date)} (for ${dayWithYear(l.limit, date)})`)
  const list = `${shown.join('; ')}${late.length > 4 ? `; and ${late.length - 4} more` : ''}.`
  const uncovered = late.filter((l) => !l.covered)
  const reach = uncovered.length
    ? `${listJoin(uncovered.map((l) => dayWithYear(l.payday, date)))} ${uncovered.length === 1 ? 'is' : 'are'} pushed past a bank holiday you work, which the Labor Commissioner's next-business-day position does not cover.`
    : "The Labor Commissioner's position allows the next business day after a Saturday, a Sunday or a holiday you observe."
  return {
    title: `${late.length === 1 ? '1 payday' : `${late.length} paydays`} in the next year would fall after the Labor Code 204 date`,
    text: `${list} ${reach} Choose Business day before, or an earlier payday, to pay on or before the 204 date.`,
  }
}

/** A payday the draft settings would put after its Labor Code 204 date. */
export type LatePaydayPreview = PayPeriod & LatePayday

/**
 * The paydays in the next `months` months that these settings (not yet saved) would put after the Labor Code 204
 * date, with how far the DLSE next-business-day position reaches for each (LatePayday.covered). Empty when every
 * payday is on time, as it always is with 'business day before' and paydays inside the 204 windows.
 */
export function latePaydaysWith(
  db: Pick<DB, 'company' | 'holidays'>,
  settings: PayrollSettings,
  schedule: Company['paySchedule'],
  date: ISODate,
  months = 12,
): LatePaydayPreview[] {
  const company: Company = { ...db.company, paySchedule: schedule, payroll: { ...db.company.payroll, ...settings } }
  const out: LatePaydayPreview[] = []
  for (const p of payCalendar({ company, holidays: db.holidays }, date, addDays(date, 31 * months))) {
    if (p.payday < date) continue
    const late = latePayday(schedule, p, db.holidays)
    if (late) out.push({ ...p, ...late })
  }
  return out
}
