// Offer builder logic: band defaults, position in band, exceptions, the California exempt check,
// equity summary (no paper value), approval routing, status transitions, the printable offer letter
// and the Labor Code 2810.5 wage notice.
//
// Grants: sending an offer reserves its options (a 'reserved' grant held by the candidate). Decline,
// expiry and rescission cancel the reservation. Accepting leaves the reservation in place; the Hire
// flow (src/domain/lifecycle.ts hireFromOffer) converts it into the employee's promised grant.
// Module rule: the store import stays LAST and there are no module-level runtime constants.
import type { Draft } from 'immer'
import { LAW_SOURCES } from '@/data/law'
import { capTableIsPlaceholder, current409A, pctOfFullyDiluted } from '@/domain/equity'
import { paydayWords } from '@/domain/payrun/calendar'
import { founder, getPerson, isEmployedOn, personNameById } from '@/domain/people'
import type {
  Band,
  DB,
  EquityGrant,
  ExemptionBasis,
  FLSA,
  ID,
  Job,
  Offer,
  OutcomeReason,
  Role,
  WorkMode,
} from '@/domain/types'
import { addBusinessDays, addDays, fmtDay, type ISODate, type ISODateTime, pacificDateOf } from '@/lib/dates'
import { escapeHTML } from '@/lib/files'
import { money, money2, moneyShort, num, pct } from '@/lib/format'
import { newId } from '@/lib/id'
import { firstStageOfKind, moveApplication, ownerFor, rejectApplication, stageKind, withdrawApplication } from './pipeline'
import {
  businessDayOnOrAfter,
  businessDayOnOrBefore,
  cancelReservedGrants,
  candidateName,
  dbHolidays,
  desiredAnnual,
  desiredHourly,
  desiredPayOf,
  type DesiredPay,
  fmtDayPlain,
  fmtLong,
  isOutcomeReason,
  lowerFirst,
  mondayOnOrAfter,
  outcomeReasonLabel,
  pacificToUTC,
  snapTo,
  vestingText,
} from './util'
import { logActivity } from '@/store/draft'

export type OfferResult = { ok: true } | { ok: false; reason: string }

// ---- Bands and defaults ---------------------------------------------------------------------

export function bandFor(db: Pick<DB, 'bands'>, familyId: ID, levelId: ID): Band | undefined {
  return db.bands.find((b) => b.familyId === familyId && b.levelId === levelId)
}

/** The level band, or a band built from the job's posted range when the level has none. */
export function effectiveBand(db: Pick<DB, 'bands'>, familyId: ID, levelId: ID, job?: Job): Band | undefined {
  const band = bandFor(db, familyId, levelId)
  if (band) return band
  if (job && job.payMin != null && job.payMax != null) {
    return {
      id: `job-${job.id}`,
      familyId,
      levelId,
      min: job.payMin,
      max: job.payMax,
      mid: snapTo((job.payMin + job.payMax) / 2, 1000),
      equityMinPct: job.equityMinPct ?? 0,
      equityMaxPct: job.equityMaxPct ?? 0,
    }
  }
  return undefined
}

/** Likely exemption for a family and level (a starting point; the offer builder lets you change it). */
export function defaultExemptionBasis(familyId: ID, levelId: ID): ExemptionBasis {
  if (familyId === 'f-exec' || levelId === 'lv-m1' || levelId === 'lv-m2' || levelId === 'lv-x1') return 'executive'
  if (familyId === 'f-eng' || familyId === 'f-ml') return 'computer_professional'
  if (familyId === 'f-acct') return 'professional'
  return 'administrative'
}

/** Start date default: the first Monday at least 14 days out (next business day if it is a holiday). */
export function defaultStartDate(date: ISODate, holidays: ISODate[] = []): ISODate {
  return businessDayOnOrAfter(mondayOnOrAfter(addDays(date, 14)), holidays)
}

/**
 * The job's posted pay range (the good-faith estimate in the posting, Labor Code 432.3) in annual terms.
 * A range under $1,000 is hourly, as payRangeLine reads it, and counts at 2,080 hours. Null without one.
 */
function postedAnnualRange(job: Pick<Job, 'payMin' | 'payMax'>): { min: number; max: number; hourly: boolean } | null {
  if (job.payMin == null || job.payMax == null) return null
  const hourly = job.payMax < 1000
  const scale = hourly ? 2080 : 1
  return { min: job.payMin * scale, max: job.payMax * scale, hourly }
}

/** `n` snapped to `step` and kept inside min..max: the nearest step inside the range, else the bound itself. */
function snapInto(n: number, min: number, max: number, step: number): number {
  const v = Math.min(Math.max(n, min), max)
  const s = snapTo(v, step)
  if (s >= min && s <= max) return s
  const up = Math.ceil(min / step) * step
  if (up > max) return v
  return s < min ? up : Math.floor(max / step) * step
}

/**
 * Default annual base: the candidate's desired pay when it sits inside the band, else the band midpoint,
 * snapped to $1,000. When the job has a posted range and that base falls outside it, the base moves
 * inside: to the desired pay when the range holds it, else to the nearest end of the range.
 */
export function defaultBase(band: Pick<Band, 'min' | 'mid' | 'max'> | undefined, job: Pick<Job, 'payMin' | 'payMax'>, desired?: number): number | undefined {
  let base: number | undefined
  if (band) base = desired != null && desired >= band.min && desired <= band.max ? snapTo(desired, 1000) : snapTo(band.mid, 1000)
  else if (desired != null) base = snapTo(desired, 1000)
  const range = postedAnnualRange(job)
  if (!range) return base
  const inRange = (v: number) => v >= range.min && v <= range.max
  if (base != null && inRange(base)) return base
  if (desired != null && inRange(desired)) return snapInto(desired, range.min, range.max, 1000)
  return snapInto(base ?? (range.min + range.max) / 2, range.min, range.max, 1000)
}

/**
 * Default hourly rate, snapped to $0.25. Against an hourly posted range: the desired pay when the range
 * holds it (an hourly desired pay as given, a yearly one at 2,080 hours), else the range midpoint, since
 * an annual band says little about a part-time rate. Otherwise the annual base over 2,080 hours, kept
 * inside an annual posted range. A plain number for `desired` is a yearly figure.
 */
export function defaultHourlyRate(base: number | undefined, job: Pick<Job, 'payMin' | 'payMax'>, desired?: number | DesiredPay): number | undefined {
  const range = postedAnnualRange(job)
  if (range?.hourly) {
    const min = range.min / 2080
    const max = range.max / 2080
    const want = desiredHourly(typeof desired === 'number' ? { amount: desired, unit: 'year' } : desired) ?? null
    return snapInto(want != null && want >= min && want <= max ? want : (min + max) / 2, min, max, 0.25)
  }
  if (base == null) return undefined
  return range ? snapInto(base / 2080, range.min / 2080, range.max / 2080, 0.25) : snapTo(base / 2080, 0.25)
}

/**
 * Prefilled offer for an application. Base comes from defaultBase (desired pay inside the band, else the
 * midpoint, moved inside the job's posted range), and an hourly offer's rate from defaultHourlyRate (the
 * midpoint of an hourly posted range). The work mode and location are the job's (jobWorkLocation). A non-exempt role is hourly when it is not full time or its posted
 * range is hourly. Equity is the midpoint of the level guideline x fully diluted shares, rounded to 500.
 * Expiry is settings.offerExpiryBusinessDays business days out.
 * An exempt job whose default base cannot support an exemption (under the California salary floor or
 * the computer professional minimum) starts non-exempt and hourly, so the builder never opens on a
 * classification it would have to warn about.
 */
export function offerDefaults(db: DB, applicationId: ID, date: ISODate): Partial<Offer> {
  const app = db.applications.find((a) => a.id === applicationId)
  if (!app) return {}
  const job = db.jobs.find((j) => j.id === app.jobId)
  if (!job) return {}
  const cand = db.candidates.find((c) => c.id === app.candidateId)
  const desired = desiredPayOf(cand)
  const holidays = dbHolidays(db)
  const band = effectiveBand(db, job.familyId, job.levelId, job)
  const { locationId, workMode } = jobWorkLocation(db, job)
  let flsa: FLSA = job.flsa
  let hourly = flsa === 'non_exempt' && (job.employmentType !== 'full_time' || !!postedAnnualRange(job)?.hourly)
  const base = defaultBase(band, job, desiredAnnual(desired))
  if (
    flsa === 'exempt' &&
    base != null &&
    exemptCheck(db, { flsa, payType: 'salary', salary: base, familyId: job.familyId, exemptionBasis: defaultExemptionBasis(job.familyId, job.levelId), locationId }).mustBeNonExempt
  ) {
    flsa = 'non_exempt'
    hourly = true
  }
  const midPct = band ? (band.equityMinPct + band.equityMaxPct) / 2 : ((job.equityMinPct ?? 0) + (job.equityMaxPct ?? 0)) / 2
  const equityShares = snapTo(midPct * db.equity.fullyDilutedShares, 500)
  const contingencies: Offer['contingencies'] = job.backgroundCheck ? ['background_check', 'i9', 'piia'] : ['i9', 'piia']
  const version = Math.max(0, ...db.offers.filter((o) => o.applicationId === app.id).map((o) => o.version)) + 1
  const out: Partial<Offer> = {
    applicationId: app.id,
    candidateId: app.candidateId,
    jobId: job.id,
    version,
    title: job.title,
    levelId: job.levelId,
    familyId: job.familyId,
    departmentId: job.departmentId,
    managerId: job.hiringManagerId,
    locationId,
    workMode,
    employmentType: job.employmentType,
    hoursPerWeek: job.employmentType === 'part_time' ? 20 : 40,
    flsa,
    payType: hourly ? 'hourly' : 'salary',
    equityType: 'ISO',
    equityShares,
    vestingMonths: db.settings.defaultVestingMonths,
    cliffMonths: db.settings.defaultCliffMonths,
    startDate: defaultStartDate(date, holidays),
    expiresOn: addBusinessDays(date, db.settings.offerExpiryBusinessDays, holidays),
    contingencies,
    status: 'draft',
    createdOn: date,
    approvals: [],
  }
  if (flsa === 'exempt') out.exemptionBasis = defaultExemptionBasis(job.familyId, job.levelId)
  const rate = hourly ? defaultHourlyRate(base, job, desired) : undefined
  if (rate != null) out.hourlyRate = rate
  else if (!hourly && base != null) out.salary = base
  if (band?.variablePct != null) out.variablePct = band.variablePct
  return out
}

/** Offer terms a new version carries over from the one before it (never its status or history). */
function carriedTerms(): Array<keyof Offer> {
  return [
    'title',
    'levelId',
    'familyId',
    'departmentId',
    'managerId',
    'employmentType',
    'hoursPerWeek',
    'flsa',
    'exemptionBasis',
    'payType',
    'salary',
    'hourlyRate',
    'variablePct',
    'signOnBonus',
    'equityType',
    'equityShares',
    'vestingMonths',
    'cliffMonths',
    'exceptionReason',
    'contingencies',
  ]
}

/**
 * A new version after a rescind or decline starts from the previous version's terms, so the founder
 * fixes only what was wrong. Status, approvals, sent and decision dates, the decline reason, the
 * background check and the hire link stay behind. The expiry is fresh (from `defaults`), and the start
 * date is kept only while it is still in the future. The work mode and location come from `defaults`
 * (the job as it is now), never from the old version: the job may have moved, say from hybrid to remote.
 */
export function offerFromPrevious(prev: Offer, defaults: Partial<Offer>, date: ISODate): Partial<Offer> {
  const out: Partial<Offer> = { ...defaults }
  const target = out as Record<string, unknown>
  const source = prev as unknown as Record<string, unknown>
  for (const key of carriedTerms()) {
    const v = source[key]
    if (v === undefined) delete target[key]
    else target[key] = Array.isArray(v) ? [...v] : v
  }
  if (prev.startDate > date) out.startDate = prev.startDate
  return out
}

// ---- Work location --------------------------------------------------------------------------

/**
 * The work mode and location an offer for the job starts from: the job's work mode and the first of its
 * locations that fits it (a remote location for remote work, an office otherwise), else its first
 * location, else the workspace's first.
 */
export function jobWorkLocation(db: Pick<DB, 'locations'>, job: Pick<Job, 'locationIds' | 'workMode'>): { workMode: WorkMode; locationId: ID } {
  const locs = job.locationIds.map((id) => db.locations.find((l) => l.id === id)).filter((l) => !!l)
  const fit = locs.find((l) => (l.kind === 'remote') === (job.workMode === 'remote'))
  return { workMode: job.workMode, locationId: fit?.id ?? job.locationIds[0] ?? db.locations[0]?.id ?? '' }
}

/** 'Hybrid at San Jose HQ', 'On site at San Jose HQ', 'Remote from California' (the state the letter names). */
export function offerWorkLocationText(db: Pick<DB, 'locations' | 'company'>, offer: Pick<Offer, 'workMode' | 'locationId'>): string {
  const loc = db.locations.find((l) => l.id === offer.locationId)
  if (offer.workMode === 'remote') return `Remote from ${stateFullName(loc?.state || db.company.hq.state || 'CA')}`
  return `${offer.workMode === 'onsite' ? 'On site' : 'Hybrid'} at ${loc?.name ?? db.company.hq.city}`
}

/**
 * How an offer's work mode and location differ from its job's as the job is now (the job was edited
 * after the offer was drafted), with the job's own (jobWorkLocation) to switch to, both in words
 * ('remote from California', 'hybrid at San Jose HQ'). Null when they match: the same work mode at one
 * of the job's locations. Callers show it only before the offer goes out.
 */
export function offerLocationDrift(
  db: Pick<DB, 'jobs' | 'locations' | 'company'>,
  offer: Pick<Offer, 'jobId' | 'workMode' | 'locationId'>,
): { workMode: WorkMode; locationId: ID; job: string; offer: string; message: string } | null {
  const job = db.jobs.find((j) => j.id === offer.jobId)
  if (!job) return null
  const target = jobWorkLocation(db, job)
  if (offer.workMode === job.workMode && (job.locationIds.includes(offer.locationId) || offer.locationId === target.locationId)) return null
  const now = lowerFirst(offerWorkLocationText(db, target))
  const says = lowerFirst(offerWorkLocationText(db, offer))
  return { ...target, job: now, offer: says, message: `The job is now ${now}. This offer still says ${says}.` }
}

/** Annual base for band comparisons (hourly rates annualized at 2,080 hours, full-time equivalent). */
export function annualizedBase(offer: Pick<Offer, 'payType' | 'salary' | 'hourlyRate'>): number {
  if (offer.payType === 'hourly') return Math.round((offer.hourlyRate ?? 0) * 2080)
  return offer.salary ?? 0
}

/** 0 = band minimum, 1 = band maximum; may fall outside 0..1. */
export function bandPosition(base: number, band: Pick<Band, 'min' | 'max'>): number {
  if (band.max === band.min) return base >= band.max ? 1 : 0
  return (base - band.min) / (band.max - band.min)
}

/** Base divided by the band midpoint (1.0 = at mid). */
export function compaRatio(base: number, band: Pick<Band, 'mid'>): number {
  return band.mid > 0 ? base / band.mid : 0
}

export type OfferException = { field: 'salary' | 'equity'; message: string; resolved: boolean }

/** Pay above the band maximum or equity above the guideline maximum needs an exception reason. */
export function offerExceptions(db: DB, offer: Offer): OfferException[] {
  const job = db.jobs.find((j) => j.id === offer.jobId)
  const band = effectiveBand(db, offer.familyId, offer.levelId, job)
  if (!band) return []
  const resolved = !!offer.exceptionReason?.trim()
  const out: OfferException[] = []
  const base = annualizedBase(offer)
  if (base > band.max) {
    const what = offer.payType === 'hourly' ? `${money2(offer.hourlyRate)} an hour (${money(base)} a year)` : money(base)
    out.push({ field: 'salary', message: `Base of ${what} is above the band maximum of ${money(band.max)}. Add an exception reason.`, resolved })
  }
  const fd = db.equity.fullyDilutedShares
  if (band.equityMaxPct > 0 && fd > 0 && offer.equityShares > Math.round(band.equityMaxPct * fd)) {
    const maxShares = Math.round(band.equityMaxPct * fd)
    out.push({
      field: 'equity',
      message: `${num(offer.equityShares)} options (${pct(offer.equityShares / fd)} of fully diluted) is above the guideline maximum of ${pct(band.equityMaxPct)} (${num(maxShares)} options). Add an exception reason.`,
      resolved,
    })
  }
  return out
}

export type PostedRangeCheck = { side: 'above' | 'below'; message: string }

/**
 * The offer's base against the job's posted pay range (the good-faith estimate printed in the posting,
 * Labor Code 432.3). Pay outside it is allowed, so this warns and never blocks. A range under $1,000 is
 * hourly, as payRangeLine reads it; an hourly offer against an hourly range compares the rates, anything
 * else compares annual base (hourly at 2,080 hours). Null when the job has no range or there is no pay.
 */
export function postedRangeCheck(
  job: Pick<Job, 'payMin' | 'payMax'> | undefined,
  offer: Pick<Offer, 'payType' | 'salary' | 'hourlyRate'>,
): PostedRangeCheck | null {
  if (!job || job.payMin == null || job.payMax == null) return null
  const hourlyRange = job.payMax < 1000
  const hourlyOffer = offer.payType === 'hourly'
  const amount = hourlyRange && hourlyOffer ? (offer.hourlyRate ?? 0) : annualizedBase(offer)
  if (amount <= 0) return null
  const scale = hourlyRange && !hourlyOffer ? 2080 : 1
  const min = job.payMin * scale
  const max = job.payMax * scale
  if (amount >= min && amount <= max) return null
  const side = amount > max ? 'above' : 'below'
  const what = hourlyOffer
    ? `${money2(offer.hourlyRate)} an hour${hourlyRange ? '' : ` (${moneyShort(amount)} a year)`}`
    : `${moneyShort(offer.salary)}${hourlyRange ? ` (${money2((offer.salary ?? 0) / 2080)} an hour)` : ''}`
  const range = hourlyRange ? `${money2(job.payMin)} to ${money2(job.payMax)} an hour` : `${moneyShort(job.payMin)} to ${moneyShort(job.payMax)}`
  return { side, message: `${what} is ${side} the posted range of ${range}. Pay outside the good-faith range can undercut the pay-scale disclosure.` }
}

// ---- Exempt check ---------------------------------------------------------------------------

export type ExemptCheckInput = {
  flsa: FLSA
  payType: 'salary' | 'hourly'
  salary?: number
  hourlyRate?: number
  familyId?: ID
  exemptionBasis?: ExemptionBasis
  hoursPerWeek?: number
  /** For the minimum wage check on non-exempt pay, and the work state (from the location's state). */
  locationId?: ID
  /** Work state (two letters) when it differs from the location's, e.g. a person's home state. */
  state?: string
  /**
   * 'offer' (default) for a hire, whose 2810.5 notice is due by the start date; 'change' for a
   * current employee's job or pay change, whose written change notice is due within 7 calendar days
   * of a pay change (a-wtpa-1, w-wtpa-notice; a manager or title move alone changes nothing in it).
   */
  context?: 'offer' | 'change'
}

export type ExemptCheck = {
  status: 'ok' | 'warn'
  /** True when the pay cannot support an exemption, so the role must be non-exempt. */
  mustBeNonExempt: boolean
  /** True when non-exempt pay works out below the minimum wage where the person works (messages[0] says so). */
  belowMinWage: boolean
  messages: string[]
  citations: Array<{ label: string; url: string }>
}

function nonExemptDuties(context: ExemptCheckInput['context'] = 'offer'): string {
  const notice =
    context === 'change'
      ? 'When the pay changes, give the written Labor Code 2810.5 change notice within 7 calendar days, unless the next timely pay stub shows the change.'
      : 'Give the Labor Code 2810.5 wage notice by the start date.'
  return `A non-exempt role earns overtime after 8 hours in a day or 40 in a week, gets meal and rest breaks, and needs time tracking. ${notice}`
}

/** Outside California: federal overtime after 40 hours a week; state rules vary. */
function nonExemptDutiesElsewhere(state: string): string {
  return `A non-exempt role earns overtime after 40 hours in a week (federal law) and needs time tracking. Check ${state}'s rules for daily overtime, breaks and pay notices.`
}

const FEDERAL_SOURCES = {
  overtime: { label: 'DOL overtime pay', url: 'https://www.dol.gov/agencies/whd/overtime' },
  minWage: { label: 'DOL minimum wage', url: 'https://www.dol.gov/agencies/whd/minimum-wage' },
}

/**
 * California exempt check against the yearly values in settings.law: the exempt salary floor
 * (2 x state minimum wage x 2,080) and the computer professional minimums (Labor Code 515.5).
 * The work state comes from the location (or input.state): California floors, daily overtime, breaks
 * and the 2810.5 notice apply only to work in California, the same rule as pay.ts exemptCheck.
 * Elsewhere the minimum wage is the location's (the federal $7.25 floor for Texas).
 * Duties tests still apply; this checks pay only. Not legal advice.
 */
export function exemptCheck(db: Pick<DB, 'settings' | 'locations'>, input: ExemptCheckInput): ExemptCheck {
  const law = db.settings.law
  const messages: string[] = []
  const citations: ExemptCheck['citations'] = []
  let must = false
  const loc = db.locations.find((l) => l.id === input.locationId)
  const state = (input.state || loc?.state || 'CA').toUpperCase()
  const inCA = state === 'CA'
  if (input.flsa === 'exempt') {
    const engineering = input.familyId === 'f-eng' || input.familyId === 'f-ml'
    const basis = input.exemptionBasis ?? (engineering ? 'computer_professional' : undefined)
    if (!inCA && basis !== 'outside_sales') {
      if (input.payType === 'hourly' && basis !== 'computer_professional') {
        must = true
        citations.push(FEDERAL_SOURCES.overtime)
        messages.push('Exempt roles must be paid a salary, not by the hour (computer professionals are the exception). Switch to a salary or classify the role non-exempt.')
        messages.push(nonExemptDutiesElsewhere(state))
        return { status: 'warn', mustBeNonExempt: true, belowMinWage: false, messages, citations }
      }
      citations.push(FEDERAL_SOURCES.overtime)
      messages.push(`California exempt minimums apply only to work in California. Check ${state}'s rules and the federal salary test.`)
      return { status: 'ok', mustBeNonExempt: false, belowMinWage: false, messages, citations }
    }
    if (basis === 'outside_sales') {
      messages.push(
        'The outside sales exemption covers only people who spend more than half their working time away from the office making sales. Inside or remote sales roles do not qualify; use another exemption that truly applies, or classify the role non-exempt.',
      )
      citations.push(LAW_SOURCES.overtime)
    } else if (basis === 'computer_professional') {
      citations.push(LAW_SOURCES.computerPro)
      if (input.payType === 'hourly') {
        if ((input.hourlyRate ?? 0) < law.computerProHourly) {
          must = true
          messages.push(
            `${money2(input.hourlyRate ?? 0)} an hour is below the ${money2(law.computerProHourly)} hourly minimum for the computer professional exemption in ${law.year} (Labor Code 515.5). Classify this role non-exempt.`,
          )
        }
      } else if ((input.salary ?? 0) < law.computerProAnnual) {
        must = true
        messages.push(
          `${money(input.salary ?? 0)} is below the ${money2(law.computerProAnnual)} annual minimum for the computer professional exemption in ${law.year} (Labor Code 515.5). Classify this role non-exempt unless another exemption truly applies.`,
        )
      }
    } else if (input.payType === 'hourly') {
      must = true
      citations.push(LAW_SOURCES.exemptSalary)
      messages.push('Exempt roles must be paid a salary, not by the hour (computer professionals are the exception). Switch to a salary or classify the role non-exempt.')
    } else if ((input.salary ?? 0) < law.exemptSalaryMin) {
      must = true
      citations.push(LAW_SOURCES.exemptSalary)
      messages.push(
        `${money(input.salary ?? 0)} is below the California exempt salary floor of ${money(law.exemptSalaryMin)} for ${law.year} (2 x the ${money2(law.caMinWageHourly)} state minimum wage x 2,080 hours). This role must be non-exempt.`,
      )
    }
    if (must) {
      messages.push(nonExemptDuties(input.context))
      citations.push(LAW_SOURCES.overtime, LAW_SOURCES.mealPeriods, LAW_SOURCES.restPeriods)
    }
    return { status: messages.length ? 'warn' : 'ok', mustBeNonExempt: must, belowMinWage: false, messages, citations }
  }
  // Non-exempt: remind the rules, and check the minimum wage where the person works.
  if (inCA) {
    messages.push(nonExemptDuties(input.context))
    citations.push(LAW_SOURCES.overtime, LAW_SOURCES.mealPeriods, LAW_SOURCES.restPeriods, LAW_SOURCES.wtpa)
  } else {
    messages.push(nonExemptDutiesElsewhere(state))
    citations.push(FEDERAL_SOURCES.overtime)
  }
  // California's state floor applies only in California; elsewhere the location's rate (at least the federal $7.25).
  const minWage = inCA ? Math.max(law.caMinWageHourly, loc?.minWageHourly ?? 0) : Math.max(7.25, loc?.minWageHourly ?? 0)
  const hours = input.hoursPerWeek && input.hoursPerWeek > 0 ? input.hoursPerWeek : 40
  const rateNow = input.payType === 'hourly' ? (input.hourlyRate ?? 0) : (input.salary ?? 0) / 52 / hours
  let warn = false
  if (rateNow > 0 && rateNow < minWage) {
    warn = true
    messages.unshift(`${money2(rateNow)} an hour is below the ${money2(minWage)} minimum wage${loc ? ` for ${loc.name}` : inCA ? ' in California' : ` in ${state}`}.`)
    citations.push(inCA ? LAW_SOURCES.caMinWage : FEDERAL_SOURCES.minWage)
  }
  return { status: warn ? 'warn' : 'ok', mustBeNonExempt: false, belowMinWage: warn, messages, citations }
}

/** The exempt check input for a saved offer (its location sets the work state and the minimum wage). */
export function offerExemptInput(
  offer: Pick<Offer, 'flsa' | 'payType' | 'salary' | 'hourlyRate' | 'familyId' | 'exemptionBasis' | 'hoursPerWeek' | 'locationId'>,
): ExemptCheckInput {
  return {
    flsa: offer.flsa,
    payType: offer.payType,
    ...(offer.salary != null ? { salary: offer.salary } : {}),
    ...(offer.hourlyRate != null ? { hourlyRate: offer.hourlyRate } : {}),
    familyId: offer.familyId,
    ...(offer.exemptionBasis ? { exemptionBasis: offer.exemptionBasis } : {}),
    ...(offer.hoursPerWeek != null ? { hoursPerWeek: offer.hoursPerWeek } : {}),
    locationId: offer.locationId,
  }
}

/**
 * Pay that the classification cannot carry (LAW.md w-exempt-salary-2026, w-sj-minwage-2026): an exempt
 * offer below the exempt salary floor or the computer professional minimum, or non-exempt pay below
 * the minimum wage where the person works. These block sending, and `force` never skips them. Empty
 * while the offer has no pay yet (the pay blocker covers that).
 */
export function classificationIssues(db: Pick<DB, 'settings' | 'locations'>, offer: Offer): SendBlocker[] {
  if (offer.payType === 'salary' ? !offer.salary : !offer.hourlyRate) return []
  const check = exemptCheck(db, offerExemptInput(offer))
  if (check.mustBeNonExempt) return [{ kind: 'classification', message: check.messages[0] }]
  if (check.belowMinWage) return [{ kind: 'classification', message: `${check.messages[0]} Raise the pay before it goes out.` }]
  return []
}

/** A sent offer whose expiry date has passed but that has not been marked expired yet (expireOffers). */
export function isLapsed(offer: Pick<Offer, 'status' | 'expiresOn'>, date: ISODate): boolean {
  return offer.status === 'sent' && !!offer.expiresOn && offer.expiresOn < date
}

// ---- Equity and approval --------------------------------------------------------------------

export type OfferEquitySummary = {
  shares: number
  type: Offer['equityType']
  /** Fraction of fully diluted shares (0.0025 = 0.25%). */
  pctFD: number
  /** Internal estimate: the current 409A price. The board sets the strike at grant. */
  strikeEstimate: number | null
  valuationOn?: ISODate
  vesting: string
  note: string
}

/** Shares, % fully diluted and a strike estimate at the current 409A. No paper value or preferred price. */
export function offerEquitySummary(db: DB, offer: Pick<Offer, 'equityShares' | 'equityType' | 'vestingMonths' | 'cliffMonths'>, date: ISODate): OfferEquitySummary {
  const v = current409A(db, date)
  return {
    shares: offer.equityShares,
    type: offer.equityType,
    pctFD: pctOfFullyDiluted(db, offer.equityShares),
    strikeEstimate: v ? v.fmvPerShare : null,
    ...(v ? { valuationOn: v.effectiveOn } : {}),
    vesting: vestingText(offer.vestingMonths, offer.cliffMonths),
    note: 'Strike is set by the board at grant',
  }
}

/**
 * Fallback for offers that carry no draftedByRole: the founder, or a people-ops staffer (f-ops at
 * L3 or above, or a manager level), who still works here on the date. Executives outside people ops
 * and junior ops roles (an office coordinator) are not admins.
 */
export function isAdminPerson(db: Pick<DB, 'people'>, personId: ID | null | undefined, date?: ISODate): boolean {
  const p = getPerson(db as DB, personId)
  if (!p) return false
  const current = date ? isEmployedOn(p, date) : !p.endDate
  if (!current) return false
  if (p.isFounder) return true
  return p.familyId === 'f-ops' && p.levelId !== 'lv-l1' && p.levelId !== 'lv-l2'
}

/**
 * Approval routes to Admin unless an admin drafted the offer. The drafter's Viewing-as role
 * (draftedByRole) decides when it is recorded; otherwise the drafter must be a current founder or
 * people-ops staffer (isAdminPerson). An offer with no drafter on record needs approval.
 */
export function approvalRequired(
  db: Pick<DB, 'people'>,
  offer: Pick<Offer, 'draftedById'> & Partial<Pick<Offer, 'draftedByRole' | 'createdOn'>>,
  date?: ISODate,
): boolean {
  if (offer.draftedByRole) return offer.draftedByRole !== 'admin'
  if (!offer.draftedById) return true
  return !isAdminPerson(db, offer.draftedById, date ?? offer.createdOn)
}

/**
 * True while an offer still needs Admin approval before it can go out: waiting for approval, or a draft
 * that needs one. Its letter is not approved yet: only Admin may generate it, marked as a draft
 * (offerLetter `notApproved`), and the hiring manager gets no letter until Admin approves.
 */
export function waitingOnApproval(db: Pick<DB, 'people'>, offer: Pick<Offer, 'status' | 'draftedById'> & Partial<Pick<Offer, 'draftedByRole' | 'createdOn'>>, date?: ISODate): boolean {
  return offer.status === 'awaiting_approval' || (offer.status === 'draft' && approvalRequired(db, offer, date))
}

/** An approval that still stands: approved, or approved and already sent (a resend). */
function approvalSatisfied(offer: Pick<Offer, 'status'>): boolean {
  return offer.status === 'approved' || offer.status === 'sent'
}

export type SendBlocker = { kind: 'pay' | 'classification' | 'start' | 'expiry' | 'approval' | 'exception'; message: string }

/** 'The start date Mon, Oct 26 has passed.' */
function startPassedText(startDate: ISODate): string {
  return `The start date ${fmtDay(startDate)} has passed.`
}

/** True when the offer's start date is before `date` (a letter or an extension would promise a past day). */
export function startHasPassed(offer: Pick<Offer, 'startDate'>, date: ISODate): boolean {
  return !!offer.startDate && offer.startDate < date
}

/**
 * Why an offer cannot be sent yet, by kind: missing pay, pay the classification cannot carry, a start
 * date or an expiry date already past (only when `date` is given), Admin approval, unresolved band
 * exceptions. Only 'exception' can be overridden (markSent's `force`).
 */
export function sendBlockerList(db: DB, offer: Offer, date?: ISODate): SendBlocker[] {
  const out: SendBlocker[] = []
  if (offer.payType === 'salary' ? !offer.salary : !offer.hourlyRate) out.push({ kind: 'pay', message: 'Add the base pay.' })
  out.push(...classificationIssues(db, offer))
  if (date && startHasPassed(offer, date)) {
    out.push({ kind: 'start', message: `${startPassedText(offer.startDate)} Pick a new start date before sending.` })
  }
  if (date && offer.expiresOn && offer.expiresOn < date) {
    out.push({ kind: 'expiry', message: `The expiry date ${fmtDay(offer.expiresOn)} has passed. Pick a new expiry before sending.` })
  }
  if (approvalRequired(db, offer, date) && !approvalSatisfied(offer)) {
    out.push({ kind: 'approval', message: 'This offer needs Admin approval before it goes out.' })
  }
  for (const e of offerExceptions(db, offer)) if (!e.resolved) out.push({ kind: 'exception', message: e.message })
  return out
}

/** Reasons an offer cannot be sent yet (pay, classification, expiry, approval, unresolved exceptions). */
export function sendBlockers(db: DB, offer: Offer, date?: ISODate): string[] {
  return sendBlockerList(db, offer, date).map((b) => b.message)
}

// ---- Transitions ----------------------------------------------------------------------------

function findOffer(draft: Draft<DB>, offerId: ID) {
  return draft.offers.find((o) => o.id === offerId)
}

function logOffer(draft: Draft<DB>, offer: { id: ID; candidateId: ID }, kind: string, text: string): void {
  logActivity(draft, { entityType: 'offer', entityId: offer.id, relatedId: offer.candidateId, kind, text })
}

/** Why the hours a week cannot be stored: a whole or half number from 1 to 60, or not set. */
export function hoursPerWeekProblem(hours: number | null | undefined): string | null {
  if (hours == null) return null
  if (!Number.isFinite(hours) || hours < 1 || hours > 60) return 'Enter 1 to 60 hours a week.'
  if (!Number.isInteger(hours * 2)) return 'Use whole or half hours, like 24 or 24.5.'
  return null
}

export type CreateOfferResult = { ok: true; id: ID } | { ok: false; reason: string }

/**
 * The candidate's next step while their offer has not gone out, so it never shows a stale 'Debrief and
 * decide' going overdue: 'Send the offer' (no approval needed, or approved), 'Submit the offer for
 * approval' (a draft that needs one) or 'Send the offer once Admin approves' (waiting). Due the next
 * business day, two while it waits for Admin. The owner stays as ownerFor decides (never someone gone).
 */
function unsentOfferNextStep(draft: Draft<DB>, offer: Offer, date: ISODate): void {
  const app = draft.applications.find((a) => a.id === offer.applicationId)
  if (!app || app.status !== 'active') return
  const job = draft.jobs.find((j) => j.id === offer.jobId)
  const waiting = offer.status === 'awaiting_approval'
  const text = waiting ? 'Send the offer once Admin approves' : offer.status === 'draft' && approvalRequired(draft, offer, date) ? 'Submit the offer for approval' : 'Send the offer'
  app.nextStep = { text, dueOn: addBusinessDays(date, waiting ? 2 : 1, dbHolidays(draft)), ownerId: ownerFor(draft, job, date, app.nextStep?.ownerId) }
}

/**
 * Adds a drafted offer (from offerDefaults plus edits) to the workspace and returns its id. Set
 * draftedById and draftedByRole (the Viewing-as role) so approval routing knows whether an admin
 * drafted it; an offer with no drafter on record routes to Admin. The application's next step becomes
 * sending the offer, or submitting it for approval (unsentOfferNextStep, dated from createdOn).
 * Refuses hours a week outside 1 to 60.
 */
export function createOffer(draft: Draft<DB>, offer: Omit<Offer, 'id'> & { id?: ID }): CreateOfferResult {
  const hours = hoursPerWeekProblem(offer.hoursPerWeek)
  if (hours) return { ok: false, reason: hours }
  const id = offer.id ?? newId('o')
  draft.offers.push({ ...offer, id } as Offer)
  logOffer(draft, { id, candidateId: offer.candidateId }, 'offer_drafted', `Drafted an offer for ${candidateName(draft, offer.candidateId)}`)
  const added = findOffer(draft, id)
  if (added && (added.status === 'draft' || added.status === 'awaiting_approval' || added.status === 'approved')) unsentOfferNextStep(draft, added, added.createdOn)
  return { ok: true, id }
}

/** Offer fields the builder can edit before the offer goes out. */
export type OfferPatch = Partial<
  Omit<
    Offer,
    | 'id'
    | 'applicationId'
    | 'candidateId'
    | 'jobId'
    | 'version'
    | 'status'
    | 'createdOn'
    | 'draftedById'
    | 'draftedByRole'
    | 'approvals'
    | 'sentOn'
    | 'decidedOn'
    | 'declineReason'
    | 'competingNote'
    | 'rescindReason'
    | 'backgroundCheck'
    | 'personId'
  >
>

/**
 * Changes to these fields void an approval: the offer goes back to draft. The work location is one of
 * them: it sets the work state, which the exempt check, the minimum wage and the letter's law read.
 */
export function approvalSensitiveFields(): Array<keyof OfferPatch> {
  return ['salary', 'hourlyRate', 'payType', 'variablePct', 'signOnBonus', 'equityShares', 'equityType', 'vestingMonths', 'cliffMonths', 'levelId', 'familyId', 'startDate', 'locationId', 'workMode']
}

/** Who is editing an offer: the Viewing-as role and person. */
export type OfferEditor = { role: Role; personId: ID | null }

/**
 * True when saving `patch` would leave the offer needing Admin approval: it already does, or a
 * non-admin editor changes pay, equity, level, start date or work location (updateOffer then records
 * them as the drafter). The builder uses this to show Submit for approval instead of Save offer.
 */
export function approvalRequiredAfterEdit(db: Pick<DB, 'people'>, offer: Offer, patch: OfferPatch, editor: OfferEditor, date?: ISODate): boolean {
  if (approvalRequired(db, offer, date)) return true
  if (editor.role === 'admin') return false
  const target = offer as unknown as Record<string, unknown>
  return approvalSensitiveFields().some((k) => k in patch && !sameValue(target[k], patch[k]))
}

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Edits an offer that has not gone out (draft, awaiting approval or approved). An approved offer whose
 * pay, equity, level, start date or work location changes goes back to draft, so the approval always
 * matches the terms that are sent. When a non-admin `editor` (a hiring manager) changes those fields,
 * they become the drafter on record, so the offer routes to Admin for approval (SPEC: managers draft,
 * Admin approves) even if Admin drafted it. Either way the next step follows (unsentOfferNextStep).
 * Fields set to undefined are cleared. Refuses hours a week outside 1 to 60.
 */
export function updateOffer(draft: Draft<DB>, offerId: ID, patch: OfferPatch, opts: { date: ISODate; editor?: OfferEditor }): OfferResult {
  const offer = findOffer(draft, offerId)
  if (!offer) return { ok: false, reason: 'Offer not found.' }
  if (offer.status !== 'draft' && offer.status !== 'awaiting_approval' && offer.status !== 'approved') {
    return { ok: false, reason: 'This offer has already gone out. Draft a new version to change its terms.' }
  }
  if ('hoursPerWeek' in patch) {
    const hours = hoursPerWeekProblem(patch.hoursPerWeek)
    if (hours) return { ok: false, reason: hours }
  }
  const sensitive = new Set<string>(approvalSensitiveFields())
  let material = false
  const target = offer as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    const before = target[key]
    if (value === undefined) delete target[key]
    else target[key] = value
    if (sensitive.has(key) && !sameValue(before, value)) material = true
  }
  const name = candidateName(draft, offer.candidateId)
  const editor = opts.editor
  const byManager = material && !!editor && editor.role !== 'admin'
  if (byManager && editor) {
    offer.draftedByRole = editor.role
    if (editor.personId) offer.draftedById = editor.personId
  }
  if (material && offer.status === 'approved') {
    offer.status = 'draft'
    const again = approvalRequired(draft, offer, opts.date) ? ' and needs Admin approval again before it goes out' : ''
    logOffer(draft, offer, 'offer_updated', `Updated the offer for ${name}. Pay, equity, level, start date or work location changed, so it is back in draft${again}.`)
    unsentOfferNextStep(draft, offer, opts.date)
  } else if (byManager) {
    logOffer(draft, offer, 'offer_updated', `Updated the offer for ${name}. Pay, equity, level, start date or work location changed, so it needs Admin approval before it goes out.`)
    if (offer.status === 'draft') unsentOfferNextStep(draft, offer, opts.date)
  } else {
    logOffer(draft, offer, 'offer_updated', `Updated the offer for ${name}`)
  }
  return { ok: true }
}

/** Sends a draft to Admin. The next step becomes sending it once Admin approves. */
export function submitForApproval(draft: Draft<DB>, offerId: ID, opts: { date: ISODate }): OfferResult {
  const offer = findOffer(draft, offerId)
  if (!offer) return { ok: false, reason: 'Offer not found.' }
  if (offer.status !== 'draft') return { ok: false, reason: 'Only a draft can be sent for approval.' }
  offer.status = 'awaiting_approval'
  logOffer(draft, offer, 'offer_submitted', `Sent the offer for ${candidateName(draft, offer.candidateId)} for approval`)
  unsentOfferNextStep(draft, offer, opts.date)
  return { ok: true }
}

export function approveOffer(draft: Draft<DB>, offerId: ID, opts: { approverId: ID; at: ISODateTime; note?: string }): OfferResult {
  const offer = findOffer(draft, offerId)
  if (!offer) return { ok: false, reason: 'Offer not found.' }
  if (offer.status !== 'awaiting_approval' && offer.status !== 'draft') return { ok: false, reason: 'This offer is not waiting for approval.' }
  offer.approvals.push({ approverId: opts.approverId, decision: 'approved', at: opts.at, ...(opts.note ? { note: opts.note } : {}) })
  offer.status = 'approved'
  logOffer(draft, offer, 'offer_approved', `${personNameById(draft, opts.approverId, 'Admin')} approved the offer for ${candidateName(draft, offer.candidateId)}`)
  unsentOfferNextStep(draft, offer, pacificDateOf(opts.at))
  return { ok: true }
}

export function requestOfferChanges(draft: Draft<DB>, offerId: ID, opts: { approverId: ID; at: ISODateTime; note: string }): OfferResult {
  const offer = findOffer(draft, offerId)
  if (!offer) return { ok: false, reason: 'Offer not found.' }
  if (offer.status !== 'awaiting_approval') return { ok: false, reason: 'This offer is not waiting for approval.' }
  offer.approvals.push({ approverId: opts.approverId, decision: 'changes_requested', at: opts.at, note: opts.note })
  offer.status = 'draft'
  logOffer(draft, offer, 'offer_changes_requested', `${personNameById(draft, opts.approverId, 'Admin')} asked for changes to the offer for ${candidateName(draft, offer.candidateId)}`)
  unsentOfferNextStep(draft, offer, pacificDateOf(opts.at))
  return { ok: true }
}

/** Creates (or updates) the 'reserved' grant that holds an outstanding offer's options. */
export function reserveOfferGrant(draft: Draft<DB>, offer: Offer, date: ISODate): EquityGrant | undefined {
  if (offer.equityShares <= 0) {
    cancelReservedGrants(draft, offer.id, date)
    return undefined
  }
  const existing = draft.grants.find((g) => g.fromOfferId === offer.id && g.status === 'reserved')
  const strike = current409A(draft, date)?.fmvPerShare ?? 0
  if (existing) {
    existing.shares = offer.equityShares
    existing.type = offer.equityType
    existing.vestingStart = offer.startDate
    existing.cliffMonths = offer.cliffMonths
    existing.vestingMonths = offer.vestingMonths
    existing.strikePrice = strike
    return existing
  }
  const grant: EquityGrant = {
    id: newId('g'),
    personId: offer.candidateId,
    holderType: 'candidate',
    type: offer.equityType,
    shares: offer.equityShares,
    strikePrice: strike,
    vestingStart: offer.startDate,
    cliffMonths: offer.cliffMonths,
    vestingMonths: offer.vestingMonths,
    status: 'reserved',
    proposedOn: date,
    exercisedShares: 0,
    postTerminationExerciseDays: 90,
    fromOfferId: offer.id,
    note: 'Reserved by an outstanding offer. Strike is set by the board at grant.',
  }
  draft.grants.push(grant)
  return grant
}

/**
 * Marks the offer sent: reserves its options, moves the application to the Offer stage if needed,
 * and sets the next step to follow up before the expiry date. `force` sends despite unresolved
 * band exceptions only; it never skips Admin approval, missing pay, pay the classification cannot
 * carry, or a start date or expiry date already past.
 */
export function markSent(draft: Draft<DB>, offerId: ID, opts: { date: ISODate; force?: boolean }): OfferResult {
  const offer = findOffer(draft, offerId)
  if (!offer) return { ok: false, reason: 'Offer not found.' }
  if (offer.status === 'awaiting_approval') return { ok: false, reason: 'This offer is waiting for Admin approval.' }
  if (offer.status !== 'draft' && offer.status !== 'approved' && offer.status !== 'sent') {
    return { ok: false, reason: 'This offer has already been decided.' }
  }
  const blockers = sendBlockerList(draft, offer, opts.date).filter((b) => !(opts.force && b.kind === 'exception'))
  if (blockers.length) return { ok: false, reason: blockers[0].message }
  offer.status = 'sent'
  offer.sentOn = opts.date
  reserveOfferGrant(draft, offer, opts.date)
  const app = draft.applications.find((a) => a.id === offer.applicationId)
  const job = draft.jobs.find((j) => j.id === offer.jobId)
  if (app && job) {
    const offerStage = firstStageOfKind(job, 'offer')
    if (offerStage && stageKind(job, app.stageId) !== 'offer') moveApplication(draft, app.id, offerStage.id, { date: opts.date })
    const holidays = dbHolidays(draft)
    const followUp = businessDayOnOrBefore(addBusinessDays(offer.expiresOn, -1, holidays), holidays)
    app.lastContactOn = opts.date
    app.nextStep = { text: 'Follow up on the offer', dueOn: followUp < opts.date ? offer.expiresOn : followUp, ownerId: ownerFor(draft, job, opts.date) }
  }
  logOffer(draft, offer, 'offer_sent', `Sent the offer to ${candidateName(draft, offer.candidateId)}, expires ${fmtDayPlain(offer.expiresOn)}`)
  return { ok: true }
}

/**
 * The candidate accepted a sent offer: records the conditional offer date on the application, which
 * unlocks the background check and criminal-history steps (Fair Chance Act). Only a sent offer can be
 * accepted, so its options are already reserved. Hire happens in lifecycle.ts. A start date already
 * past does not block it (a founder may record the acceptance late); the panel asks whether they
 * started then, and moveOfferStart moves it.
 */
export function markAccepted(draft: Draft<DB>, offerId: ID, opts: { date: ISODate }): OfferResult {
  const offer = findOffer(draft, offerId)
  if (!offer) return { ok: false, reason: 'Offer not found.' }
  if (offer.status === 'approved' || offer.status === 'draft') return { ok: false, reason: 'Mark the offer sent before recording the acceptance.' }
  if (offer.status === 'expired') return { ok: false, reason: `This offer expired on ${fmtDay(offer.expiresOn)}. Extend it first.` }
  if (offer.status !== 'sent') return { ok: false, reason: 'Only an offer that is out can be accepted.' }
  if (isLapsed(offer, opts.date)) return { ok: false, reason: `This offer expired on ${fmtDay(offer.expiresOn)}. Extend it first.` }
  offer.status = 'accepted'
  offer.decidedOn = opts.date
  const app = draft.applications.find((a) => a.id === offer.applicationId)
  const job = draft.jobs.find((j) => j.id === offer.jobId)
  if (app) {
    app.conditionalOfferOn = opts.date
    app.lastContactOn = opts.date
    const holidays = dbHolidays(draft)
    const text = offer.contingencies.includes('background_check') ? 'Start the background check' : 'Hire and start onboarding'
    app.nextStep = { text, dueOn: addBusinessDays(opts.date, 1, holidays), ownerId: ownerFor(draft, job, opts.date) }
  }
  logOffer(draft, offer, 'offer_accepted', `${candidateName(draft, offer.candidateId)} accepted the offer`)
  return { ok: true }
}

/**
 * The candidate declined (or backed out after accepting, before the hire was recorded). Cancels the
 * reserved options and, by default, closes the application as withdrawn with the matching reason.
 */
export function markDeclined(
  draft: Draft<DB>,
  offerId: ID,
  reason: string,
  opts: { date: ISODate; note?: string; closeApplication?: boolean; outcomeReason?: OutcomeReason },
): OfferResult {
  const offer = findOffer(draft, offerId)
  if (!offer) return { ok: false, reason: 'Offer not found.' }
  if (offer.status === 'accepted' && offer.personId) return { ok: false, reason: 'This offer is already a hire. Record the departure from the profile instead.' }
  const reneging = offer.status === 'accepted'
  if (offer.status !== 'sent' && offer.status !== 'approved' && offer.status !== 'expired' && !reneging) return { ok: false, reason: 'Only an offer that is out can be declined.' }
  offer.status = 'declined'
  offer.decidedOn = opts.date
  offer.declineReason = reason
  if (opts.note) offer.competingNote = opts.note
  cancelReservedGrants(draft, offer.id, opts.date)
  const name = candidateName(draft, offer.candidateId)
  const why = outcomeReasonLabel(reason).toLowerCase()
  logOffer(draft, offer, 'offer_declined', reneging ? `${name} backed out after accepting the offer (${why})` : `${name} declined the offer (${why})`)
  if (opts.closeApplication ?? true) {
    const outcome = opts.outcomeReason ?? (isOutcomeReason(reason) ? reason : 'other')
    withdrawApplication(draft, offer.applicationId, outcome, { date: opts.date, ...(opts.note ? { note: opts.note } : {}) })
  } else {
    decideNextStep(draft, offer, opts.date)
  }
  return { ok: true }
}

/**
 * The application stays open after its offer was declined, rescinded or discarded: the next step no
 * longer points at that offer but asks for the decision, due the next business day.
 */
function decideNextStep(draft: Draft<DB>, offer: Pick<Offer, 'applicationId' | 'jobId'>, date: ISODate): void {
  const app = draft.applications.find((a) => a.id === offer.applicationId)
  if (!app || app.status !== 'active') return
  const job = draft.jobs.find((j) => j.id === offer.jobId)
  app.nextStep = { text: 'Decide: make a new offer or close out', dueOn: addBusinessDays(date, 1, dbHolidays(draft)), ownerId: ownerFor(draft, job, date, app.nextStep?.ownerId) }
}

/** True for a rescinded offer that never went out: the candidate never saw it, so it reads 'Discarded'. */
export function isDiscarded(offer: Pick<Offer, 'status' | 'sentOn'>): boolean {
  return offer.status === 'rescinded' && !offer.sentOn
}

/**
 * Withdraws an offer (for example after the Fair Chance process), or discards one that never went out.
 * Keeps the reason on the offer. Optionally closes the application; when it stays open, the next step
 * asks whether to make a new offer or close out.
 */
export function rescindOffer(
  draft: Draft<DB>,
  offerId: ID,
  opts: { date: ISODate; reason: string; closeApplication?: boolean },
): OfferResult {
  const offer = findOffer(draft, offerId)
  if (!offer) return { ok: false, reason: 'Offer not found.' }
  if (offer.status === 'declined' || offer.status === 'rescinded') return { ok: false, reason: 'This offer is already closed.' }
  if (offer.personId) return { ok: false, reason: 'This offer is already a hire. Record the departure from the profile instead.' }
  offer.status = 'rescinded'
  offer.decidedOn = opts.date
  if (opts.reason.trim()) offer.rescindReason = opts.reason.trim()
  cancelReservedGrants(draft, offer.id, opts.date)
  const name = candidateName(draft, offer.candidateId)
  if (isDiscarded(offer)) logOffer(draft, offer, 'offer_discarded', `Discarded the draft offer for ${name}: ${opts.reason}`)
  else logOffer(draft, offer, 'offer_rescinded', `Rescinded the offer for ${name}: ${opts.reason}`)
  if (opts.closeApplication) rejectApplication(draft, offer.applicationId, 'other', { date: opts.date, note: opts.reason })
  else decideNextStep(draft, offer, opts.date)
  return { ok: true }
}

/**
 * Marks sent offers past their expiry date as expired and releases their options. The expiry date is
 * the decision date, so lapsed offers count against offer acceptance. Returns the count.
 *
 * Deterministic: everything it writes comes from the offer itself (the expiry date stands in for
 * today in the grant release, the next step's due date and owner, and the activity row's id and time),
 * so every device that runs it on load produces the same records whatever day it runs.
 */
export function expireOffers(draft: Draft<DB>, date: ISODate): number {
  let n = 0
  const holidays = dbHolidays(draft)
  for (const offer of draft.offers) {
    if (!isLapsed(offer, date)) continue
    const on = offer.expiresOn
    offer.status = 'expired'
    offer.decidedOn = on
    cancelReservedGrants(draft, offer.id, on)
    const app = draft.applications.find((a) => a.id === offer.applicationId)
    if (app && app.status === 'active') {
      const job = draft.jobs.find((j) => j.id === offer.jobId)
      app.nextStep = { text: 'Offer expired: extend it or close out', dueOn: addBusinessDays(on, 1, holidays), ownerId: ownerFor(draft, job, on, app.nextStep?.ownerId) }
    }
    const id = `act-offer-expired-${offer.id}-${on}`
    if (!draft.activity.some((a) => a.id === id)) {
      // A system event, so no actor; it happened at the start of the day after the expiry date (Pacific).
      draft.activity.push({
        id,
        at: pacificToUTC(addDays(on, 1), 0, 0),
        actorId: null,
        entityType: 'offer',
        entityId: offer.id,
        relatedId: offer.candidateId,
        kind: 'offer_expired',
        text: `The offer for ${candidateName(draft, offer.candidateId)} expired on ${fmtDayPlain(on)}`,
      })
    }
    n += 1
  }
  return n
}

/**
 * Extends a sent (or just-expired) offer to a new expiry date and re-reserves its options. While its
 * start date has passed it is refused unless `startDate` moves the start too, so a reopened offer never
 * promises a day that is gone.
 */
export function extendOffer(draft: Draft<DB>, offerId: ID, newExpiresOn: ISODate, opts: { date: ISODate; startDate?: ISODate }): OfferResult {
  const offer = findOffer(draft, offerId)
  if (!offer) return { ok: false, reason: 'Offer not found.' }
  if (offer.status !== 'sent' && offer.status !== 'expired') return { ok: false, reason: 'Only an offer that is out can be extended.' }
  if (newExpiresOn < opts.date) return { ok: false, reason: 'Pick a new expiry date on or after today.' }
  if (opts.startDate != null && opts.startDate < opts.date) return { ok: false, reason: 'Pick a start date on or after today.' }
  if (opts.startDate == null && startHasPassed(offer, opts.date)) {
    return { ok: false, reason: `${startPassedText(offer.startDate)} Open the offer to extend it with a new start date.` }
  }
  const movedStart = opts.startDate != null && opts.startDate !== offer.startDate
  if (opts.startDate != null) offer.startDate = opts.startDate
  offer.expiresOn = newExpiresOn
  if (offer.status === 'expired') {
    offer.status = 'sent'
    delete offer.decidedOn
  }
  reserveOfferGrant(draft, offer, opts.date)
  const app = draft.applications.find((a) => a.id === offer.applicationId)
  if (app && app.status === 'active') {
    const holidays = dbHolidays(draft)
    const job = draft.jobs.find((j) => j.id === offer.jobId)
    app.nextStep = { text: 'Follow up on the offer', dueOn: businessDayOnOrBefore(addBusinessDays(newExpiresOn, -1, holidays), holidays), ownerId: ownerFor(draft, job, opts.date, app.nextStep?.ownerId) }
  }
  const moved = movedStart ? ` and moved the start date to ${fmtDayPlain(offer.startDate)}` : ''
  logOffer(draft, offer, 'offer_extended', `Extended the offer for ${candidateName(draft, offer.candidateId)} to ${fmtDayPlain(newExpiresOn)}${moved}`)
  return { ok: true }
}

/**
 * Moves an offer's start date to a day on or after `date`. Before the offer goes out this is an edit
 * (updateOffer: the start date is approval-sensitive, so an approved offer goes back to draft). An offer
 * that is out, expired or accepted keeps its status, since the founder agreed the new day with the
 * candidate; its reserved options vest from the new day. A hire's start date lives on their profile.
 */
export function moveOfferStart(draft: Draft<DB>, offerId: ID, startDate: ISODate, opts: { date: ISODate; editor?: OfferEditor }): OfferResult {
  const offer = findOffer(draft, offerId)
  if (!offer) return { ok: false, reason: 'Offer not found.' }
  if (startDate < opts.date) return { ok: false, reason: 'Pick a start date on or after today.' }
  if (offer.personId) return { ok: false, reason: 'This offer is already a hire, so the start date is on their profile.' }
  if (offer.status === 'draft' || offer.status === 'awaiting_approval' || offer.status === 'approved') return updateOffer(draft, offerId, { startDate }, opts)
  if (offer.status !== 'sent' && offer.status !== 'expired' && offer.status !== 'accepted') return { ok: false, reason: 'This offer is closed.' }
  if (offer.startDate === startDate) return { ok: true }
  offer.startDate = startDate
  const reserved = draft.grants.find((g) => g.fromOfferId === offer.id && g.status === 'reserved')
  if (reserved) reserved.vestingStart = startDate
  logOffer(draft, offer, 'offer_start_moved', `Moved the start date for ${candidateName(draft, offer.candidateId)} to ${fmtDayPlain(startDate)}`)
  return { ok: true }
}

/**
 * Why the offer letter (and the wage notice) should not be built yet: the start date has passed on an
 * offer the candidate has not accepted, or comes before the letter's own date (its sent date, else the
 * day it was drafted). Null when the start date is fine.
 */
export function letterStartIssue(offer: Pick<Offer, 'status' | 'startDate' | 'sentOn' | 'createdOn'>, date: ISODate): string | null {
  const undecided = offer.status === 'draft' || offer.status === 'awaiting_approval' || offer.status === 'approved' || offer.status === 'sent' || offer.status === 'expired'
  const letterDate = offer.sentOn ?? offer.createdOn
  if ((undecided && startHasPassed(offer, date)) || (!!letterDate && startHasPassed(offer, letterDate))) {
    return `${startPassedText(offer.startDate)} Pick a new start date before you generate the letter.`
  }
  return null
}

// ---- Generated documents --------------------------------------------------------------------

type Section = { heading?: string; paragraphs: string[] }

/** The line on top of a document whose offer Admin has not approved yet (preview, print and copied text). */
export function notApprovedMark(): string {
  return 'Draft, not approved. Admin approves this offer before it goes out. Do not send this copy.'
}

function render(title: string, sections: Section[], signature?: { left: string[]; right: string[] }, mark?: string): { html: string; text: string } {
  const html: string[] = [...(mark ? [`<p class="draft-mark"><strong>${escapeHTML(mark)}</strong></p>`] : []), `<h1>${escapeHTML(title)}</h1>`]
  const text: string[] = [...(mark ? [mark, ''] : []), title, '']
  for (const s of sections) {
    if (s.heading) {
      html.push(`<h2>${escapeHTML(s.heading)}</h2>`)
      // Sentence case as written, set off by a blank line and an underline.
      text.push('', s.heading, '-'.repeat(s.heading.length))
    }
    for (const p of s.paragraphs) {
      html.push(`<p>${escapeHTML(p).replace(/\n/g, '<br>')}</p>`)
      text.push(p, '')
    }
  }
  if (signature) {
    html.push(
      `<div class="sig"><div>${signature.left.map(escapeHTML).join('<br>')}</div><div>${signature.right.map(escapeHTML).join('<br>')}</div></div>`,
    )
    text.push('', '______________________________', ...signature.left, '', '______________________________', ...signature.right)
  }
  return { html: html.join('\n'), text: text.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n' }
}

/** 'California' for 'CA' (the 50 states and DC); any other code as given. */
function stateFullName(code: string): string {
  const codes = 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' ')
  const names = [
    'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois',
    'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri',
    'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma',
    'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington',
    'West Virginia', 'Wisconsin', 'Wyoming', 'the District of Columbia',
  ]
  const i = codes.indexOf(code.toUpperCase())
  return i === -1 ? code : names[i]
}

function addressLine(db: Pick<DB, 'company'>): string {
  const a = db.company.hq
  const street = [a.street, a.suite].filter(Boolean).join(', ')
  return [street, a.city, `${a.state} ${a.zip}`.trim()].filter((x) => x && x.trim()).join(', ')
}

function payScheduleText(db: Pick<DB, 'company'>): string {
  switch (db.company.paySchedule) {
    case 'biweekly':
      return 'every two weeks'
    case 'monthly':
      return 'monthly'
    default:
      return 'twice a month'
  }
}

/**
 * The regular payday in words: the Settings value, or the pay calendar's own words (paydayWords, the same paydays
 * Comp and plan > Pay runs counts), so the wage notice cannot drift from the calendar.
 */
export function regularPaydayText(db: Pick<DB, 'company'>): string {
  if (db.company.regularPayday?.trim()) return db.company.regularPayday.trim()
  return paydayWords(db.company)
}

/**
 * Printable offer letter. At-will (Labor Code 2922), contingencies (background check after this
 * conditional offer under the Fair Chance Act, I-9, PIIA with the Labor Code 2870 notice), equity
 * subject to board approval with shares, % fully diluted (once the cap table is confirmed) and strike set at grant (no dollar
 * projections), no noncompete (Business and Professions Code 16600), California law and venue
 * (Labor Code 925), expiry and signature lines. With `notApproved` (the offer still waits for Admin,
 * waitingOnApproval) the letter opens with notApprovedMark and its subject says it is a draft.
 */
export function offerLetter(db: DB, offerId: ID, opts: { notApproved?: boolean } = {}): { subject: string; html: string; text: string } | null {
  const offer = db.offers.find((o) => o.id === offerId)
  if (!offer) return null
  const cand = db.candidates.find((c) => c.id === offer.candidateId)
  const company = db.company
  const manager = getPerson(db, offer.managerId)
  const location = db.locations.find((l) => l.id === offer.locationId)
  const signer = founder(db)
  const first = cand?.firstName ?? 'there'
  const fullName = cand ? `${cand.firstName} ${cand.lastName}` : 'Candidate'
  const letterDate = fmtLong(offer.sentOn ?? offer.createdOn)
  const exempt = offer.flsa === 'exempt'
  const hours = offer.hoursPerWeek ?? (offer.employmentType === 'full_time' ? 40 : undefined)
  // Under 30 hours a week reads as part-time even when the type was left at full time.
  const partTime = offer.employmentType === 'part_time' || (hours != null && hours < 30)
  const positionLead =
    offer.employmentType === 'intern'
      ? `This is an internship. You will work as ${offer.title}${hours && hours < 30 ? `, about ${hours} hours a week` : ''}`
      : `You will work ${partTime ? `part-time${hours ? ` (about ${hours} hours a week)` : ''}` : 'full-time'} as ${offer.title}`
  const computerPro = offer.exemptionBasis === 'computer_professional' || (!offer.exemptionBasis && (offer.familyId === 'f-eng' || offer.familyId === 'f-ml'))
  // California clauses (Labor Code 925 venue, 2751 commissions, California overtime and breaks, 2922,
  // B&P 16600) are written for work in California; other states get neutral wording (LAW.md).
  const workState = (location?.state || company.hq.state || 'CA').toUpperCase()
  const inCA = workState === 'CA'
  // A remote offer names the state they work from, never the office address it is not tied to.
  const where = location ? `${location.name}${location.kind === 'hq' ? ` (${addressLine(db)})` : ''}` : company.hq.city
  const locationText =
    offer.workMode === 'remote' ? `You will work remotely from ${stateFullName(workState)}.` : `Your work location is ${where}, ${offer.workMode === 'onsite' ? 'on site' : 'hybrid'}.`
  const sections: Section[] = []

  sections.push({
    paragraphs: [
      `${company.legalName}\n${addressLine(db)}`,
      letterDate,
      `Dear ${first},`,
      `We are delighted to offer you the position of ${offer.title} at ${company.name}. This letter sets out the terms of our offer.`,
    ],
  })
  sections.push({
    heading: 'Position',
    paragraphs: [
      `${positionLead}, reporting to ${manager ? `${manager.preferredName || manager.firstName} ${manager.lastName}, ${manager.title}` : 'your manager'}. ${locationText} Your start date will be ${fmtLong(offer.startDate)}.`,
    ],
  })
  const pay: string[] = []
  if (offer.payType === 'salary') {
    pay.push(
      exempt
        ? `Your base salary will be ${money(offer.salary)} a year, paid ${payScheduleText(db)}. This position is exempt, which means it is paid a salary and is not eligible for overtime.`
        : inCA
          ? `Your base salary will be ${money(offer.salary)} a year, paid ${payScheduleText(db)}. This position is non-exempt: you are eligible for overtime under California law, you will receive meal and rest breaks, and you will record your hours worked.`
          : `Your base salary will be ${money(offer.salary)} a year, paid ${payScheduleText(db)}. This position is non-exempt: you are eligible for overtime as the law of the state where you work and federal law provide, and you will record your hours worked.`,
    )
  } else if (exempt) {
    // Hourly exempt pay is allowed only for computer professionals (Labor Code 515.5).
    pay.push(
      `Your pay will be ${money2(offer.hourlyRate)} an hour, paid ${payScheduleText(db)}. This position is exempt${computerPro ? ' under the computer professional exemption (Labor Code 515.5)' : ''}, which means it is not eligible for overtime.`,
    )
  } else {
    pay.push(
      inCA
        ? `Your pay will be ${money2(offer.hourlyRate)} an hour, paid ${payScheduleText(db)}. This position is non-exempt: you will earn overtime at 1.5 times your regular rate (2 times where California law requires), you will receive meal and rest breaks, and you will record your hours worked.`
        : `Your pay will be ${money2(offer.hourlyRate)} an hour, paid ${payScheduleText(db)}. This position is non-exempt: you will earn overtime at 1.5 times your regular rate for hours over 40 in a week (and more where the law of the state where you work requires), and you will record your hours worked.`,
    )
  }
  if (offer.variablePct && offer.variablePct > 0) {
    const base = annualizedBase(offer)
    const sales = offer.familyId === 'f-gtm'
    pay.push(
      `You will be eligible for variable pay with a target of ${money(Math.round(base * offer.variablePct))} a year (${pct(offer.variablePct)} of base), under a separate written plan${sales ? (inCA ? ' that sets out how commissions are earned and paid, as California requires (Labor Code 2751)' : ' that sets out how commissions are earned and paid') : ''}.`,
    )
  }
  if (offer.signOnBonus && offer.signOnBonus > 0) {
    pay.push(`You will receive a one-time sign-on bonus of ${money(offer.signOnBonus)}, paid with your first regular paycheck.`)
  }
  pay.push('You will be eligible for the benefits the company offers to similarly situated employees, subject to the terms of each plan.')
  sections.push({ heading: 'Pay and benefits', paragraphs: pay })

  if (offer.equityShares > 0) {
    const fd = db.equity.fullyDilutedShares
    // A placeholder cap table (Start fresh, not yet confirmed) would put a made-up percentage in writing.
    const pctText = fd > 0 && !capTableIsPlaceholder(db) ? pct(offer.equityShares / fd) : ''
    const typeName = offer.equityType === 'ISO' ? 'an incentive stock option (ISO), to the extent the law allows' : 'a nonqualified stock option (NSO)'
    const span = offer.vestingMonths % 12 === 0 ? `${offer.vestingMonths / 12} years` : `${offer.vestingMonths} months`
    const schedule =
      offer.cliffMonths > 0
        ? `${pct(offer.cliffMonths / offer.vestingMonths)} vests after ${offer.cliffMonths} months of service (the cliff), and the rest vests in equal monthly parts over the following ${offer.vestingMonths - offer.cliffMonths} months`
        : 'it vests in equal monthly parts'
    sections.push({
      heading: 'Equity',
      paragraphs: [
        `Subject to approval by the Board of Directors, you will be granted an option to purchase ${num(offer.equityShares)} shares of the company's common stock${pctText ? `, about ${pctText} of the company's fully diluted shares today` : ''}, as ${typeName}.`,
        `The exercise price will be the fair market value of a share on the date the Board grants the option, as set by the Board. The option vests over ${span}: ${schedule}, as long as you keep working for the company. The option is governed by the company's equity plan and your grant agreement.`,
      ],
    })
  }

  const conts: string[] = []
  if (offer.contingencies.includes('background_check')) {
    conts.push(
      'A background check. It runs only after you accept this conditional offer, with your written consent, and in a manner consistent with the California Fair Chance Act (Government Code 12952) and federal and California consumer reporting laws. If anything in the report concerns us, you will receive written notice and time to respond before any decision.',
    )
  }
  if (offer.contingencies.includes('i9')) {
    conts.push('Proof of your identity and authorization to work in the United States, as required by federal law (Form I-9), within 3 business days of your start date.')
  }
  if (offer.contingencies.includes('piia')) {
    conts.push(
      "Signing the company's Confidential information and invention assignment agreement. It includes the written notice required by Labor Code 2870: it does not apply to inventions you develop entirely on your own time without the company's equipment, supplies, facilities or trade secret information, unless they relate to the company's business or research or result from your work for the company.",
    )
  }
  if (conts.length) sections.push({ heading: 'Conditions of this offer', paragraphs: ['This offer depends on:', ...conts.map((c, i) => `${i + 1}. ${c}`)] })

  sections.push({
    heading: 'At-will employment',
    paragraphs: [
      `Your employment with the company is at will${inCA ? ', as provided in California Labor Code 2922' : ''}. This means that either you or the company may end the employment relationship at any time, with or without cause or notice. There is no fixed term of employment, and only a written agreement signed by the CEO can change this.`,
    ],
  })
  sections.push({
    heading: 'Your freedom to work',
    paragraphs: [
      inCA
        ? 'Nothing in this letter or in any company agreement restricts your ability to work for anyone else after you leave the company. California law makes noncompete agreements void (Business and Professions Code 16600). You must not bring or use confidential information or trade secrets belonging to any former employer.'
        : 'Nothing in this letter or in any company agreement restricts your ability to work for anyone else after you leave the company; the company does not use noncompete agreements. You must not bring or use confidential information or trade secrets belonging to any former employer.',
    ],
  })
  sections.push({
    heading: 'Governing law',
    paragraphs: [
      inCA
        ? 'This letter is governed by California law. Any dispute about your employment will be decided in California, as Labor Code 925 provides for employees who live and work in California.'
        : `This letter is governed by the law of the state where you work (${workState}) and applicable federal law.`,
      'This letter, together with the agreements it mentions, is the complete agreement about the terms of your employment and replaces any earlier discussions.',
    ],
  })
  sections.push({
    heading: 'Next steps',
    paragraphs: [
      `This offer expires at the end of the day on ${fmtLong(offer.expiresOn)}. To accept, sign and date below and return this letter. We are excited about what we will build together.`,
      `Sincerely,`,
    ],
  })

  const signerName = signer ? `${signer.preferredName || signer.firstName} ${signer.lastName}` : company.name
  const signerTitle = signer?.title ?? ''
  const doc = render(
    `Offer of employment: ${offer.title}`,
    sections,
    {
      left: [signerName, signerTitle, company.legalName].filter(Boolean),
      right: [`Accepted by ${fullName}`, 'Date:'],
    },
    opts.notApproved ? notApprovedMark() : undefined,
  )
  return { subject: `${opts.notApproved ? 'Draft, not approved: ' : ''}Your offer from ${company.name}`, ...doc }
}

// ---- Labor Code 2810.5 wage notice ----------------------------------------------------------

/** County for common Bay Area cities (the disaster-declaration line names the work county). */
export function countyForCity(city: string | undefined): string | undefined {
  if (!city) return undefined
  const c = city.trim().toLowerCase()
  const santaClara = ['san jose', 'santa clara', 'sunnyvale', 'mountain view', 'palo alto', 'cupertino', 'milpitas', 'campbell', 'los gatos', 'saratoga', 'los altos', 'morgan hill', 'gilroy']
  const alameda = ['oakland', 'fremont', 'berkeley', 'hayward', 'alameda', 'pleasanton', 'livermore', 'union city', 'newark', 'emeryville', 'dublin']
  const sanMateo = ['san mateo', 'redwood city', 'menlo park', 'east palo alto', 'burlingame', 'south san francisco', 'foster city', 'san carlos', 'belmont', 'daly city']
  if (santaClara.includes(c)) return 'Santa Clara County'
  if (alameda.includes(c)) return 'Alameda County'
  if (sanMateo.includes(c)) return 'San Mateo County'
  if (c === 'san francisco') return 'San Francisco County'
  return undefined
}

/** '40 hours (5 days)', or just the hours when they are not whole 8-hour days. */
function sickHoursText(hours: number): string {
  const days = hours / 8
  return Number.isInteger(days) ? `${num(hours)} hours (${num(days)} ${days === 1 ? 'day' : 'days'})` : `${num(hours)} hours`
}

type WageInput = {
  name: string
  title: string
  startDate: ISODate
  payType: 'salary' | 'hourly'
  salary?: number
  hourlyRate?: number
  hoursPerWeek: number
  flsa: FLSA
  locationId: ID
  city?: string
}

/**
 * Labor Code 2810.5 notice to a non-exempt hire, due no later than the start date (optional for
 * exempt hires, whose notice says 'Exempt from overtime' instead of overtime rates): pay rate and
 * basis with overtime rates, allowances, regular payday, employer legal and DBA names, address and
 * phone, the workers' comp carrier's name, address and phone (2810.5(a)(1)(H); LAW.md a-wc-1), paid
 * sick leave rights, and the disaster-declaration line. For a person, pay comes from the comp row in
 * effect on `date` (default: their start date). `missing` lists details to add in Settings first.
 * `notApproved` marks the notice for an offer Admin has not approved yet, as offerLetter does.
 */
export function wageNotice2810_5(
  db: DB,
  ref: { offerId?: ID; personId?: ID; date?: ISODate; notApproved?: boolean },
): { html: string; text: string; missing: string[] } | null {
  let input: WageInput | null = null
  if (ref.offerId) {
    const o = db.offers.find((x) => x.id === ref.offerId)
    if (!o) return null
    const loc = db.locations.find((l) => l.id === o.locationId)
    input = {
      name: candidateName(db, o.candidateId),
      title: o.title,
      startDate: o.startDate,
      payType: o.payType,
      ...(o.salary != null ? { salary: o.salary } : {}),
      ...(o.hourlyRate != null ? { hourlyRate: o.hourlyRate } : {}),
      hoursPerWeek: o.hoursPerWeek ?? 40,
      flsa: o.flsa,
      locationId: o.locationId,
      ...(loc?.city ? { city: loc.city } : {}),
    }
  } else if (ref.personId) {
    const p = getPerson(db, ref.personId)
    if (!p) return null
    // The pay in effect on the date (start date by default), never a future-dated raise.
    const asOf = ref.date ?? p.startDate
    const rows = db.comp.filter((c) => c.personId === p.id).sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn))
    const comp = rows.filter((c) => c.effectiveOn <= asOf).pop() ?? rows[0]
    input = {
      name: `${p.preferredName || p.firstName} ${p.lastName}`,
      title: comp?.title ?? p.title,
      startDate: p.startDate,
      payType: comp?.payType ?? 'salary',
      ...(comp?.salary != null ? { salary: comp.salary } : {}),
      ...(comp?.hourlyRate != null ? { hourlyRate: comp.hourlyRate } : {}),
      hoursPerWeek: p.hoursPerWeek || 40,
      flsa: comp?.flsa ?? p.flsa,
      locationId: p.locationId,
    }
    const city = p.workMode === 'remote' ? p.homeCity : (db.locations.find((l) => l.id === p.locationId)?.city ?? p.homeCity)
    if (city) input.city = city
  }
  if (!input) return null
  const company = db.company
  const missing: string[] = []
  const exempt = input.flsa === 'exempt'
  const regular = input.payType === 'hourly' ? (input.hourlyRate ?? 0) : (input.salary ?? 0) / 52 / (input.hoursPerWeek || 40)
  const rateLine =
    input.payType === 'hourly'
      ? `${money2(input.hourlyRate)} per hour (rate by the hour)`
      : exempt
        ? `${money(input.salary)} per year, paid as a salary`
        : `${money(input.salary)} per year, paid as a salary (regular hourly rate for overtime: ${money2(regular)})`
  const otLine = exempt
    ? 'Overtime: Exempt from overtime.'
    : `Overtime rates: ${money2(regular * 1.5)} per hour (1.5 times the regular rate) for hours over 8 in a workday or 40 in a workweek and the first 8 hours on a seventh consecutive workday; ${money2(regular * 2)} per hour (2 times) for hours over 12 in a workday and over 8 on a seventh consecutive workday.`
  const carrier = company.workersCompCarrier
  if (!carrier?.name) missing.push("Workers' comp carrier (Settings > Company)")
  if (!carrier?.address) missing.push("Workers' comp carrier address (Settings > Company)")
  if (!carrier?.phone) missing.push("Workers' comp carrier phone (Settings > Company)")
  if (!company.phone) missing.push('Company phone number (Settings > Company)')
  if (!company.hq.street) missing.push('Company street address (Settings > Company)')
  // A blank regular payday is not missing: regularPaydayText prints the pay calendar's own words.
  const sick = db.timeOffPolicies.find((p) => p.kind === 'sick')
  const sickPlan =
    sick?.method === 'frontload'
      ? `The company provides ${sickHoursText(sick.annualHours ?? 40)} of paid sick leave at the start of each year and at hire${sick.usableAfterDays ? `, usable from day ${sick.usableAfterDays}` : ''}.`
      : 'You accrue paid sick leave at 1 hour for every 30 hours worked, under Labor Code 246.'
  const county = countyForCity(input.city) ?? 'the county where you will work'
  const dba = company.name && company.name !== company.legalName && !company.legalName.startsWith(`${company.name},`) ? company.name : 'None'
  const sections: Section[] = [
    {
      heading: 'Employee',
      paragraphs: [`Name: ${input.name}\nJob title: ${input.title}\nStart date: ${fmtLong(input.startDate)}`],
    },
    {
      heading: 'Pay',
      paragraphs: [
        `Rate of pay: ${rateLine}`,
        otLine,
        'Allowances claimed as part of the minimum wage (meals or lodging): None.',
        `Regular payday: ${regularPaydayText(db)}. Pay schedule: ${payScheduleText(db)}.`,
      ],
    },
    {
      heading: 'Employer',
      paragraphs: [
        `Legal name: ${company.legalName}\nOther names the employer does business as (DBA): ${dba}\nPhysical address of main office: ${addressLine(db)}\nMailing address, if different: Same\nPhone: ${company.phone ?? 'Not set'}`,
      ],
    },
    {
      heading: "Workers' compensation insurance",
      paragraphs: [
        `Carrier: ${carrier?.name || 'Not set'}\nCarrier address: ${carrier?.address || 'Not set'}\nCarrier phone: ${carrier?.phone || 'Not set'}${carrier?.policyNumber ? `\nPolicy number: ${carrier.policyNumber}` : ''}`,
      ],
    },
    {
      heading: 'Paid sick leave',
      paragraphs: [
        'Unless exempt, you are entitled to paid sick leave under California law, which provides that you: may accrue paid sick leave and may request and use at least 40 hours or 5 days of paid sick leave per year; may not be terminated or retaliated against for using or requesting paid sick leave; and have the right to file a complaint against an employer who retaliates or discriminates.',
        sickPlan,
      ],
    },
    {
      heading: 'Emergency or disaster declaration',
      paragraphs: [
        `Has a federal or state emergency or disaster declaration that may affect your health and safety been issued for ${county} within 30 days before your first day of work?  [ ] Yes   [ ] No   [ ] Not known`,
      ],
    },
    {
      paragraphs: [
        'You will be told in writing of any change to this information within 7 calendar days, unless the change appears on a timely wage statement or another required writing.',
        'Notice to employee under California Labor Code 2810.5.',
      ],
    },
  ]
  const doc = render(
    'Notice to employee (Labor Code 2810.5)',
    sections,
    {
      left: [`For ${company.legalName}`, 'Date:'],
      right: [`Received by ${input.name}`, 'Date:'],
    },
    ref.notApproved ? notApprovedMark() : undefined,
  )
  return { ...doc, missing }
}
