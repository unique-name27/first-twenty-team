// Shared helpers for the hiring domain: business-day math with company holidays, Pacific time
// conversion, medians, names and small draft utilities. Pure: this file never imports the store, so
// its constants are always initialized before any module that logs activity runs.
import { format } from 'date-fns'
import type { Application, Candidate, DB, ID, Offer, OutcomeReason } from '@/domain/types'
import { addDays, addMonths, type ISODate, type ISODateTime, isPacificDaylight, isWeekday, pacificDateOf, pacificOffsetHours, parseDate } from '@/lib/dates'

/** A citation chip: label plus an official source link when there is one. */
export type Citation = { label: string; url?: string }

/** Holidays as plain dates or as rows with a date (db.holidays). */
export type HolidayInput = ReadonlyArray<ISODate | { date: ISODate }>

export function holidayDates(h: HolidayInput | null | undefined): ISODate[] {
  if (!h) return []
  return h.map((x) => (typeof x === 'string' ? x : x.date))
}

/** The company's holiday dates from the workspace. */
export function dbHolidays(db: Pick<DB, 'holidays'>): ISODate[] {
  return (db.holidays ?? []).map((h) => h.date)
}

export function isBusinessDay(d: ISODate, holidays: HolidayInput = []): boolean {
  const day = d.slice(0, 10)
  return isWeekday(day) && !holidayDates(holidays).includes(day)
}

/** Business days after `from`, up to and including `to`. 0 when `to` is on or before `from`. */
export function businessDaysBetween(from: ISODate, to: ISODate, holidays: HolidayInput = []): number {
  const a = from.slice(0, 10)
  const b = to.slice(0, 10)
  if (b <= a) return 0
  const skip = new Set(holidayDates(holidays))
  let n = 0
  let cur = a
  while (cur < b) {
    cur = addDays(cur, 1)
    if (isWeekday(cur) && !skip.has(cur)) n += 1
  }
  return n
}

/** The date itself when it is a business day, else the closest earlier business day. */
export function businessDayOnOrBefore(d: ISODate, holidays: HolidayInput = []): ISODate {
  let cur = d.slice(0, 10)
  for (let i = 0; i < 30 && !isBusinessDay(cur, holidays); i++) cur = addDays(cur, -1)
  return cur
}

/** The date itself when it is a business day, else the next business day. */
export function businessDayOnOrAfter(d: ISODate, holidays: HolidayInput = []): ISODate {
  let cur = d.slice(0, 10)
  for (let i = 0; i < 30 && !isBusinessDay(cur, holidays); i++) cur = addDays(cur, 1)
  return cur
}

/** First Monday on or after the date. */
export function mondayOnOrAfter(d: ISODate): ISODate {
  const dow = parseDate(d.slice(0, 10)).getDay() // 0 Sun .. 6 Sat
  const add = (8 - dow) % 7
  return addDays(d.slice(0, 10), add)
}

export function addYears(d: ISODate, n: number): ISODate {
  return addMonths(d, 12 * n)
}

export function maxDate(...dates: Array<ISODate | null | undefined>): ISODate | undefined {
  let best: ISODate | undefined
  for (const d of dates) if (d && (!best || d.slice(0, 10) > best)) best = d.slice(0, 10)
  return best
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function snapTo(n: number, step: number): number {
  return Math.round(n / step) * step
}

/** A candidate's desired pay in its own unit: dollars a year, or an hourly rate (hourly and part-time jobs). */
export type DesiredPay = { amount: number; unit: 'year' | 'hour' }

/** The candidate's desired pay with its unit (a year when no unit is stored), or undefined when not asked. */
export function desiredPayOf(c: Pick<Candidate, 'desiredPay' | 'desiredPayUnit'> | undefined): DesiredPay | undefined {
  if (!c || c.desiredPay == null) return undefined
  return { amount: c.desiredPay, unit: c.desiredPayUnit === 'hour' ? 'hour' : 'year' }
}

/** Desired pay as a yearly figure for band comparisons: an hourly rate at 2,080 hours (full-time equivalent). */
export function desiredAnnual(d: DesiredPay | undefined): number | undefined {
  if (!d) return undefined
  return d.unit === 'hour' ? Math.round(d.amount * 2080) : d.amount
}

/** Desired pay as an hourly rate: an hourly figure as given, a yearly one over 2,080 hours (unrounded). */
export function desiredHourly(d: DesiredPay | undefined): number | undefined {
  if (!d) return undefined
  return d.unit === 'hour' ? d.amount : d.amount / 2080
}

/** "Mon Jan 11" (no comma), used in planning lines. */
export function fmtDayPlain(d: ISODate): string {
  return format(parseDate(d.slice(0, 10)), 'EEE MMM d')
}

/** "October 26, 2026", used in letters and notices. */
export function fmtLong(d: ISODate | null | undefined): string {
  if (!d) return ''
  return format(parseDate(d.slice(0, 10)), 'MMMM d, yyyy')
}

/** "4-year vesting with a 1-year cliff, then monthly" */
export function vestingText(vestingMonths: number, cliffMonths: number): string {
  const years = vestingMonths % 12 === 0 ? `${vestingMonths / 12}-year` : `${vestingMonths}-month`
  if (cliffMonths <= 0) return `${years} vesting, monthly`
  const cliff = cliffMonths % 12 === 0 ? `${cliffMonths / 12}-year cliff` : `${cliffMonths}-month cliff`
  return `${years} vesting with a ${cliff}, then monthly`
}

/** "intro call" from "Intro call"; leaves acronyms ("SQL deep dive") alone. */
export function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s
}

// ---- Pacific time ---------------------------------------------------------------------------
// Interviews are proposed and shown in Pacific time. US daylight saving time runs from 2:00 AM on
// the second Sunday of March to 2:00 AM on the first Sunday of November. Business-hour times never
// fall inside the 1-3 AM transition window, so a date-level check is exact for them.

export const PACIFIC_TZ = 'America/Los_Angeles'

// isPacificDaylight, pacificOffsetHours and pacificDateOf live in @/lib/dates (re-exported here).
export { isPacificDaylight, pacificDateOf, pacificOffsetHours }

/** ISO timestamp (UTC) for a Pacific wall-clock time on a date. */
export function pacificToUTC(d: ISODate, hour: number, minute = 0): ISODateTime {
  const [y, m, day] = d.slice(0, 10).split('-').map(Number)
  const offset = pacificOffsetHours(d)
  return new Date(Date.UTC(y, m - 1, day, hour - offset, minute)).toISOString()
}


export function addHoursISO(iso: ISODateTime, hours: number): ISODateTime {
  return new Date(new Date(iso).getTime() + hours * 3_600_000).toISOString()
}

export function addMinutesISO(iso: ISODateTime, minutes: number): ISODateTime {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString()
}

// ---- Names and records ----------------------------------------------------------------------

export function candidateName(db: Pick<DB, 'candidates'>, candidateId: ID | null | undefined): string {
  const c = db.candidates.find((x) => x.id === candidateId)
  return c ? `${c.firstName} ${c.lastName}`.trim() : 'Candidate'
}

export function candidateFirstName(db: Pick<DB, 'candidates'>, candidateId: ID | null | undefined): string {
  return db.candidates.find((x) => x.id === candidateId)?.firstName ?? 'there'
}

export function applicationName(db: Pick<DB, 'candidates' | 'applications'>, appId: ID): string {
  const app = db.applications.find((a) => a.id === appId)
  return app ? candidateName(db, app.candidateId) : 'Candidate'
}

/** Offers for an application, newest version first. */
export function offersFor(db: Pick<DB, 'offers'>, applicationId: ID): Offer[] {
  return db.offers.filter((o) => o.applicationId === applicationId).sort((a, b) => b.version - a.version)
}

export function latestOffer(db: Pick<DB, 'offers'>, applicationId: ID): Offer | undefined {
  return offersFor(db, applicationId)[0]
}

/** The offer still in play (draft, awaiting approval, approved or sent), if any. */
export function openOffer(db: Pick<DB, 'offers'>, applicationId: ID): Offer | undefined {
  return offersFor(db, applicationId).find((o) => isOpenOfferStatus(o.status))
}

export function isOpenOfferStatus(s: Offer['status']): boolean {
  return s === 'draft' || s === 'awaiting_approval' || s === 'approved' || s === 'sent'
}

/** Hired, or accepted an offer and still active (starts later): the application produced a hire. */
export function isHire(app: Pick<Application, 'status' | 'conditionalOfferOn'>): boolean {
  return app.status === 'hired' || (app.status === 'active' && !!app.conditionalOfferOn)
}

export const OUTCOME_REASON_LABELS: Record<OutcomeReason, string> = {
  not_a_fit_level: 'Not a fit for level',
  skills_gap: 'Skills gap',
  chose_other_offer: 'Chose another offer',
  comp: 'Comp',
  location: 'Location',
  timing: 'Timing',
  no_response: 'No response',
  withdrew: 'Withdrew',
  position_filled: 'Position filled',
  other: 'Other',
}

export function outcomeReasonLabel(r: OutcomeReason | string | undefined): string {
  if (!r) return 'Not given'
  return (OUTCOME_REASON_LABELS as Record<string, string>)[r] ?? r
}

export function isOutcomeReason(r: string): r is OutcomeReason {
  return Object.prototype.hasOwnProperty.call(OUTCOME_REASON_LABELS, r)
}

// ---- Draft utilities (no logging; callers log) ----------------------------------------------

/**
 * Takes an application's interviews that have not started off the calendar, with their unsubmitted
 * scorecards (used when it is rejected, withdrawn or hired). Interviews under way or done stay on the
 * record (kept 4 years, LAW.md a-ads-1). Without `nowISO`, interviews on a later Pacific date count
 * as not started. Returns how many were cancelled.
 */
export function cancelUnstartedInterviews(
  draft: { interviews: DB['interviews']; scorecards: DB['scorecards'] },
  applicationId: ID,
  date: ISODate,
  nowISO?: ISODateTime,
): number {
  const nowMs = nowISO ? Date.parse(nowISO) : NaN
  const notStarted = (startsAt: ISODateTime) => (Number.isFinite(nowMs) ? Date.parse(startsAt) > nowMs : pacificDateOf(startsAt) > date)
  let n = 0
  for (const i of draft.interviews) {
    if (i.applicationId === applicationId && i.status === 'scheduled' && notStarted(i.startsAt)) {
      i.status = 'cancelled'
      draft.scorecards = draft.scorecards.filter((s) => s.interviewId !== i.id || !!s.submittedAt)
      n++
    }
  }
  return n
}

type GrantDraftDB = { grants: DB['grants'] }

/** Cancels any reserved grant held by an offer, returning the shares to the pool. */
export function cancelReservedGrants(draft: GrantDraftDB, offerId: ID, date: ISODate): number {
  let n = 0
  for (const g of draft.grants) {
    if (g.fromOfferId === offerId && g.status === 'reserved') {
      g.status = 'cancelled'
      g.cancelledOn = date
      g.cancelledShares = g.shares
      n += 1
    }
  }
  return n
}

/** Keeps applicant records at least 4 years after a decision (Gov Code 12946). */
export function extendRetention(draft: { candidates: DB['candidates'] }, candidateId: ID, decidedOn: ISODate): void {
  const c = draft.candidates.find((x) => x.id === candidateId)
  if (!c) return
  const until = addYears(decidedOn, 4)
  if (!c.retainUntil || c.retainUntil < until) c.retainUntil = until
}
