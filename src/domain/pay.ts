// Pay, bands, fully loaded cost, run-rate and runway (docs/SPEC.md: LEVELS AND BANDS, COST AND RUNWAY,
// Home dashboard "People cost"). Pure functions over the DB; every date is a parameter.
//
// Employer tax math uses PAYROLL_TAX_2026 (src/data/law.ts), verified in docs/LAW.md:
//   w-fica-2026      Social Security 6.2% up to $184,500, Medicare 1.45% on all wages (employer share).
//                    The 0.9% Additional Medicare Tax is employee-only, so it is not an employer cost.
//   w-futa-base      FUTA 6.0% less the 5.4% state credit = 0.6% on the first $7,000.
//   w-futa-ca-credit-reduction-2025  California is a credit reduction state: 2026 is estimated at 2.1%
//                    effective (5.9% if DOL denies the add-on waiver), final after Nov 10, 2026.
//   w-ca-ui-ett      California new-employer UI 3.4% plus ETT 0.1%, each on the first $7,000.
//   w-ca-sdi-2026    SDI is employee-paid, so it is not an employer cost.
// These are planning estimates, not payroll. The PEO or payroll provider is the system of record.
import { PAYROLL_TAX_2026 } from '@/data/law'
import { employedOn, fullName, incomingOn } from '@/domain/people'
import type {
  Band,
  CompRecord,
  Contractor,
  DB,
  ExemptionBasis,
  FLSA,
  ID,
  Job,
  LawSettings,
  Offer,
  PayrollTaxRateOverrides,
  Person,
  PlanSlot,
} from '@/domain/types'
import { addDays, daysBetween, fmtDate, type ISODate } from '@/lib/dates'
import { listJoin, money, money2, moneyShort, pct } from '@/lib/format'

function r2(n: number): number {
  return Math.round(n * 100) / 100
}

// ---------------------------------------------------------------------------------------------
// Comp records
// ---------------------------------------------------------------------------------------------

export type PayFields = Pick<CompRecord, 'payType' | 'salary' | 'hourlyRate'>

/** A person's job and pay history, oldest first (ties keep their stored order). */
export function compHistory(db: DB, personId: ID): CompRecord[] {
  return db.comp.filter((c) => c.personId === personId).sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn))
}

/** The latest comp record effective on or before the date, or undefined (for example before a start date). */
export function currentComp(db: DB, personId: ID, date: ISODate): CompRecord | undefined {
  const rows = compHistory(db, personId).filter((c) => c.effectiveOn <= date)
  return rows[rows.length - 1]
}

/** Comp on the date, or the first record when the person has not started yet (incoming hires). */
export function compOrFirst(db: DB, personId: ID, date: ISODate): CompRecord | undefined {
  return currentComp(db, personId, date) ?? compHistory(db, personId)[0]
}

/** The person's last day: the end date, or the last day of a separation in progress. */
export function lastDayOf(person: Pick<Person, 'endDate' | 'separation'>): ISODate | undefined {
  return person.endDate ?? person.separation?.lastDay ?? undefined
}

/**
 * A person's job and pay history split at their last day. Rows dated after it never take effect (a change
 * scheduled before offboarding started), so they stay out of the job title and wage rate history, the
 * scheduled-change notice and the current job.
 */
export function compHistoryByLastDay(db: DB, person: Person): { history: CompRecord[]; afterLastDay: CompRecord[]; lastDay?: ISODate } {
  const all = compHistory(db, person.id)
  const lastDay = lastDayOf(person)
  if (!lastDay) return { history: all, afterLastDay: [] }
  return { history: all.filter((r) => r.effectiveOn <= lastDay), afterLastDay: all.filter((r) => r.effectiveOn > lastDay), lastDay }
}

/** Pay periods in a year for a pay schedule: 24 semi-monthly, 26 every two weeks, 12 monthly. */
export function payPeriodsPerYear(schedule: DB['company']['paySchedule']): number {
  return schedule === 'monthly' ? 12 : schedule === 'biweekly' ? 26 : 24
}

/** Annual base pay: the salary, or hourly rate x hours per week x 52. */
export function annualBase(rec: PayFields, hoursPerWeek = 40): number {
  if (rec.payType === 'hourly') return r2((rec.hourlyRate ?? 0) * hoursPerWeek * 52)
  return rec.salary ?? 0
}

/** Base pay restated at 40 hours a week, for comparing part-time pay with full-time bands. */
export function fullTimeEquivalentBase(rec: PayFields, hoursPerWeek = 40): number {
  if (rec.payType === 'hourly') return r2((rec.hourlyRate ?? 0) * 40 * 52)
  const salary = rec.salary ?? 0
  return hoursPerWeek > 0 && hoursPerWeek < 40 ? r2((salary * 40) / hoursPerWeek) : salary
}

/** Hourly rate of pay: the hourly rate, or the salary over hours per week x 52 (final-pay math). */
export function hourlyRateOf(rec: PayFields, hoursPerWeek = 40): number {
  if (rec.payType === 'hourly') return rec.hourlyRate ?? 0
  const hours = hoursPerWeek > 0 ? hoursPerWeek : 40
  return r2((rec.salary ?? 0) / (hours * 52))
}

// ---------------------------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------------------------

export function bandFor(db: DB, familyId: ID, levelId: ID): Band | undefined {
  return db.bands.find((b) => b.familyId === familyId && b.levelId === levelId)
}

/** The band for the person's family and level. With a date, the level comes from their comp record on that date. */
export function bandForPerson(db: DB, person: Person, date?: ISODate): Band | undefined {
  const levelId = (date ? compOrFirst(db, person.id, date)?.levelId : undefined) ?? person.levelId
  return bandFor(db, person.familyId, levelId)
}

/** Base over band midpoint (1.0 = at mid). */
export function compaRatio(base: number, band: Pick<Band, 'mid'>): number {
  return band.mid > 0 ? base / band.mid : 0
}

/** Where base sits in the band: 0 at min, 1 at max, below 0 or above 1 when outside it. */
export function bandPosition(base: number, band: Pick<Band, 'min' | 'max'>): number {
  if (band.max <= band.min) return base < band.min ? -1 : base > band.max ? 2 : 0.5
  return (base - band.min) / (band.max - band.min)
}

export type BandZone = 'below' | 'low' | 'mid' | 'high' | 'above'

export function bandZone(base: number, band: Pick<Band, 'min' | 'max'>): BandZone {
  if (base < band.min) return 'below'
  if (base > band.max) return 'above'
  const p = bandPosition(base, band)
  return p < 1 / 3 ? 'low' : p <= 2 / 3 ? 'mid' : 'high'
}

const ZONE_LABEL: Record<BandZone, string> = {
  below: 'Below band',
  low: 'Low in band',
  mid: 'Mid band',
  high: 'High in band',
  above: 'Above band',
}

/** "Below band", "Low in band", "Mid band", "High in band", "Above band". */
export function bandLabel(base: number, band: Pick<Band, 'min' | 'max'>): string {
  return ZONE_LABEL[bandZone(base, band)]
}

// ---------------------------------------------------------------------------------------------
// Employer taxes and fully loaded cost
// ---------------------------------------------------------------------------------------------

/** FUTA after the full 5.4% state credit (docs/LAW.md w-futa-base). Used outside California. */
export const FUTA_BASE_RATE = 0.006
/** Generic state unemployment estimate for states other than California; real rates and wage bases vary. */
export const GENERIC_SUI = { rate: 0.027, wageBase: 9_000 } as const
/** Benefits per head are counted for people working at least this many hours a week (the ACA full-time line). */
export const BENEFITS_MIN_HOURS = 30

export type FutaScenario = 'waiver' | 'no_waiver'

/**
 * Editable tax assumptions (docs/SPEC.md COST AND RUNWAY; docs/LAW.md w-futa-ca-credit-reduction-2025 says to
 * model both the waiver and no-waiver FUTA cases until DOL finalizes after Nov 10, 2026). Rates merge over
 * PAYROLL_TAX_2026; explicit options win over company.costModel.taxOverrides.
 */
export type TaxOptions = { futa?: FutaScenario; rates?: PayrollTaxRateOverrides }

type TaxRates = Required<PayrollTaxRateOverrides>

function defaultTaxRates(): TaxRates {
  const T = PAYROLL_TAX_2026
  return {
    socialSecurityRate: T.socialSecurityRate,
    socialSecurityWageBase: T.socialSecurityWageBase,
    medicareRate: T.medicareRate,
    futaEffectiveRate: T.futaEffectiveRate,
    futaEffectiveRateNoWaiver: T.futaEffectiveRateNoWaiver,
    futaBaseRate: FUTA_BASE_RATE,
    futaWageBase: T.futaWageBase,
    caUiRate: T.caUiRate,
    caEttRate: T.caEttRate,
    caUiWageBase: T.caUiWageBase,
    otherStateSuiRate: GENERIC_SUI.rate,
    otherStateSuiWageBase: GENERIC_SUI.wageBase,
  }
}

/** Merges rate overrides left to right, keeping only finite, non-negative numbers. */
export function mergeTaxRates(...sources: Array<PayrollTaxRateOverrides | undefined>): PayrollTaxRateOverrides {
  const out: PayrollTaxRateOverrides = {}
  for (const src of sources) {
    if (!src) continue
    for (const key of Object.keys(src) as Array<keyof PayrollTaxRateOverrides>) {
      const v = src[key]
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[key] = v
    }
  }
  return out
}

/** The company's stored tax overrides merged under explicit options. */
function companyTax(db: Pick<DB, 'company'>, opts: TaxOptions = {}): TaxOptions {
  const stored = db.company.costModel.taxOverrides
  const futa = opts.futa ?? stored?.futaScenario
  return { ...(futa ? { futa } : {}), rates: mergeTaxRates(stored?.rates, opts.rates) }
}

export type EmployerTaxes = {
  ss: number
  medicare: number
  futa: number
  sui: number
  ett: number
  total: number
  /** Plain-language notes on estimates (non-CA unemployment, the 2026 FUTA estimate). */
  notes: string[]
}

/**
 * Employer payroll taxes on a year of wages (base plus variable) for one employee working in `state`.
 * California: FUTA at the 2026 credit-reduction estimate, UI 3.4% and ETT 0.1% on $7,000.
 * Other states: FUTA at the base 0.6% and a generic 2.7% on $9,000 unemployment estimate.
 * `rates` overrides any of these (for example an experience-rated UI rate after the first 2 to 3 years).
 */
export function employerTaxes(annualWages: number, opts: { state: string } & TaxOptions): EmployerTaxes {
  const over = mergeTaxRates(opts.rates)
  const R: TaxRates = { ...defaultTaxRates(), ...over }
  const wages = Math.max(0, annualWages)
  const state = (opts.state || 'CA').toUpperCase()
  const isCA = state === 'CA'
  const notes: string[] = []
  const ss = r2(R.socialSecurityRate * Math.min(wages, R.socialSecurityWageBase))
  const medicare = r2(R.medicareRate * wages)
  const futaBase = Math.min(wages, R.futaWageBase)
  let futa: number
  let sui: number
  let ett = 0
  if (isCA) {
    const noWaiver = opts.futa === 'no_waiver'
    const rate = noWaiver ? R.futaEffectiveRateNoWaiver : R.futaEffectiveRate
    const rateOverridden = (noWaiver ? over.futaEffectiveRateNoWaiver : over.futaEffectiveRate) != null
    futa = r2(rate * futaBase)
    sui = r2(R.caUiRate * Math.min(wages, R.caUiWageBase))
    ett = r2(R.caEttRate * Math.min(wages, R.caUiWageBase))
    notes.push(
      rateOverridden
        ? `FUTA uses ${pct(rate)} on the first ${money(R.futaWageBase)}, set in place of the 2026 California estimate.`
        : noWaiver
          ? 'FUTA uses 5.9%, the 2026 California rate if the federal add-on waiver is denied (final after Nov 10, 2026).'
          : 'FUTA uses 2.1%, the 2026 California estimate if the federal add-on waiver is granted (final after Nov 10, 2026; up to 5.9% without it).',
    )
    if (over.caUiRate != null || over.caUiWageBase != null) {
      notes.push(`California UI uses ${pct(R.caUiRate)} on the first ${money(R.caUiWageBase)} in place of the 3.4% new-employer rate.`)
    }
  } else {
    futa = r2(R.futaBaseRate * futaBase)
    sui = r2(R.otherStateSuiRate * Math.min(wages, R.otherStateSuiWageBase))
    notes.push(
      over.otherStateSuiRate != null || over.otherStateSuiWageBase != null
        ? `State unemployment for ${state} uses ${pct(R.otherStateSuiRate)} on the first ${money(R.otherStateSuiWageBase)}, the rate set for states other than California.`
        : `State unemployment for ${state} is a generic estimate of 2.7% on the first $9,000. Check the state's new-employer rate.`,
      over.futaBaseRate != null
        ? `FUTA uses ${pct(R.futaBaseRate)} on the first ${money(R.futaWageBase)}.`
        : 'FUTA uses the base 0.6% rate, assuming the state has no credit reduction.',
    )
  }
  return { ss, medicare, futa, sui, ett, total: r2(ss + medicare + futa + sui + ett), notes }
}

export type LoadedCostInput = {
  base: number
  /** Bonus target or sales variable at target, as a fraction of base. */
  variablePct?: number
  /** Work state (two letters). */
  state: string
  /**
   * Count benefits per head (default true). Run-rate passes false below 30 hours a week. Benefits are never
   * counted when Settings records that the company has no group health plan (benefitsBasis).
   */
  benefits?: boolean
} & TaxOptions

export type LoadedCost = {
  base: number
  variable: number
  /** Base plus variable at target (the taxable wages). */
  wages: number
  employerTaxes: EmployerTaxes
  benefits: number
  peoTools: number
  workersComp: number
  totalAnnual: number
  totalMonthly: number
  /** Total over base (1.18 = 18% on top of base). */
  multiplier: number
}

/**
 * Where the benefits per head figure stands: 'plan' when Settings has a group health plan start date,
 * 'none' when it records no plan (benefits count as $0), 'assumed' while the health plan is not recorded
 * (the per-head figure is counted as an assumption).
 */
export function benefitsBasis(company: Pick<DB['company'], 'groupHealthPlanStartedOn'>): 'plan' | 'none' | 'assumed' {
  const on = company.groupHealthPlanStartedOn
  return on ? 'plan' : on === null ? 'none' : 'assumed'
}

/**
 * Fully loaded annual and monthly cost of one employee, using the company's cost model. Tax assumptions come
 * from PAYROLL_TAX_2026, then company.costModel.taxOverrides, then `input.futa` and `input.rates`.
 */
export function loadedCost(db: Pick<DB, 'company'>, input: LoadedCostInput): LoadedCost {
  const model = db.company.costModel
  const base = Math.max(0, input.base)
  const variable = r2(base * (input.variablePct ?? 0))
  const wages = base + variable
  const taxes = employerTaxes(wages, { state: input.state, ...companyTax(db, { futa: input.futa, rates: input.rates }) })
  const benefits = input.benefits === false || benefitsBasis(db.company) === 'none' ? 0 : model.benefitsPerHeadMonthly * 12
  const peoTools = model.peoToolsPerHeadMonthly * 12
  const workersComp = r2(wages * model.workersCompPct)
  const totalAnnual = r2(wages + taxes.total + benefits + peoTools + workersComp)
  return {
    base,
    variable,
    wages,
    employerTaxes: taxes,
    benefits,
    peoTools,
    workersComp,
    totalAnnual,
    totalMonthly: r2(totalAnnual / 12),
    multiplier: base > 0 ? totalAnnual / base : 0,
  }
}

// ---------------------------------------------------------------------------------------------
// Offers and plan slots (shared with equity.ts and plan.ts; kept here so nothing imports in a cycle)
// ---------------------------------------------------------------------------------------------

/** Offer statuses that count as out (not yet accepted or closed). */
export const OUTSTANDING_OFFER_STATUSES: ReadonlyArray<Offer['status']> = ['awaiting_approval', 'approved', 'sent']

/** The latest version of each application's offer. */
export function latestOffers(db: DB): Offer[] {
  const byApp = new Map<ID, Offer>()
  for (const o of db.offers) {
    const prev = byApp.get(o.applicationId)
    if (!prev || o.version > prev.version) byApp.set(o.applicationId, o)
  }
  return [...byApp.values()]
}

function candidateIsPerson(db: DB, candidateId: ID): boolean {
  return db.people.some((p) => p.fromCandidateId === candidateId)
}

/** A sent offer whose expiry date has passed (hiring/offers.ts may not have marked it expired yet). */
export function offerLapsed(o: Pick<Offer, 'status' | 'expiresOn'>, date: ISODate): boolean {
  return o.status === 'sent' && !!o.expiresOn && o.expiresOn < date
}

/**
 * Offers that are out: awaiting approval, approved or sent, latest version only, not yet a person.
 * With a date, sent offers past their expiry date are left out.
 */
export function outstandingOffers(db: DB, date?: ISODate): Offer[] {
  return latestOffers(db).filter(
    (o) =>
      OUTSTANDING_OFFER_STATUSES.includes(o.status) &&
      !(date && offerLapsed(o, date)) &&
      !o.personId &&
      !candidateIsPerson(db, o.candidateId),
  )
}

/** Accepted offers that Hire has not turned into a person yet. They count as incoming. */
export function acceptedOffersNotHired(db: DB): Offer[] {
  return latestOffers(db).filter((o) => o.status === 'accepted' && !o.personId && !candidateIsPerson(db, o.candidateId))
}

export function candidateName(db: DB, candidateId: ID): string {
  const c = db.candidates.find((x) => x.id === candidateId)
  return c ? `${c.firstName} ${c.lastName}` : 'Candidate'
}

/** The job linked to a plan slot (by slot.jobId or job.planSlotId). */
export function slotJob(db: DB, slot: PlanSlot): Job | undefined {
  return (slot.jobId ? db.jobs.find((j) => j.id === slot.jobId) : undefined) ?? db.jobs.find((j) => j.planSlotId === slot.id)
}

/** True when the offer is the one the person was hired from (by offer.personId, or the candidate they were). */
function offerOfPerson(db: DB, o: Offer, personId: ID): boolean {
  if (o.personId === personId) return true
  const from = db.people.find((p) => p.id === personId)?.fromCandidateId
  return !!from && from === o.candidateId
}

/**
 * The offer that decides a slot's status. A held line (slot.personId) takes only the accepted offer its own
 * person was hired from (the newest, for a rehire): two hires from one job each keep their own offer, and a
 * person added without an offer has none (budgetVariance then reads their hire record). A line nobody holds
 * takes an accepted offer no other line's person was hired from, else the newest outstanding one.
 */
export function slotOffer(db: DB, slot: PlanSlot): Offer | undefined {
  const job = slotJob(db, slot)
  if (!job) return undefined
  const offers = latestOffers(db).filter((o) => o.jobId === job.id)
  if (slot.personId) {
    const held = slot.personId
    return offers
      .filter((o) => o.status === 'accepted' && offerOfPerson(db, o, held))
      .sort((a, b) => b.createdOn.localeCompare(a.createdOn))[0]
  }
  const holders = db.plan.filter((s) => s.id !== slot.id && s.personId).map((s) => s.personId as ID)
  return (
    offers.find((o) => o.status === 'accepted' && !holders.some((personId) => offerOfPerson(db, o, personId))) ??
    offers.filter((o) => OUTSTANDING_OFFER_STATUSES.includes(o.status)).sort((a, b) => b.createdOn.localeCompare(a.createdOn))[0]
  )
}

/** The person who filled a slot: slot.personId, else the person hired from the accepted offer slotOffer picks for it. */
export function slotPerson(db: DB, slot: PlanSlot): Person | undefined {
  if (slot.personId) {
    const p = db.people.find((x) => x.id === slot.personId)
    if (p) return p
  }
  const offer = slotOffer(db, slot)
  if (offer?.status !== 'accepted') return undefined
  return db.people.find((p) => (offer.personId && p.id === offer.personId) || p.fromCandidateId === offer.candidateId)
}

/**
 * A plan slot's status rolled up from its job, offer and person: cut stays cut; a linked person or an
 * accepted offer means filled; an outstanding offer means offer; an open job means open; otherwise the
 * stored status (planned for a draft or on-hold job).
 */
export function planSlotStatus(db: DB, slot: PlanSlot): PlanSlot['status'] {
  if (slot.status === 'cut') return 'cut'
  if (slotPerson(db, slot)) return 'filled'
  const job = slotJob(db, slot)
  if (!job) return slot.status
  const offer = slotOffer(db, slot)
  if (offer?.status === 'accepted' || job.status === 'filled') return 'filled'
  if (offer) return 'offer'
  if (job.status === 'open') return 'open'
  if (job.status === 'closed') return slot.status === 'filled' ? 'filled' : 'cut'
  return slot.status === 'open' || slot.status === 'offer' ? 'planned' : slot.status
}

/** Planning base for a slot: its budgeted base, else the band midpoint, else null. */
export function slotBudgetBase(db: DB, slot: PlanSlot): { base: number | null; fromBand: boolean } {
  if (slot.budgetBase != null) return { base: slot.budgetBase, fromBand: false }
  const band = bandFor(db, slot.familyId, slot.levelId)
  return band ? { base: band.mid, fromBand: true } : { base: null, fromBand: false }
}

// ---------------------------------------------------------------------------------------------
// Run-rate
// ---------------------------------------------------------------------------------------------

export type RunRateInclude = 'now' | 'with_incoming' | 'with_offers' | 'at_plan'

export type RunRateLine = {
  key: string
  kind: 'employee' | 'incoming' | 'offer' | 'plan'
  personId?: ID
  offerId?: ID
  candidateId?: ID
  slotId?: ID
  name: string
  departmentId: ID
  base: number
  monthly: number
  cost: LoadedCost
  /** No comp record or pay amount was found, so this line counts benefits and tools only. */
  missingPay?: boolean
}

export type ContractorCost = { contractorId: ID; name: string; monthly: number; note?: string }

export type RunRate = {
  include: RunRateInclude
  date: ISODate
  /** Fully loaded W-2 cost per month (contractors are separate). */
  monthly: number
  annual: number
  /** W-2 heads counted, including incoming hires, offers and plan slots when included. */
  headcount: number
  /** Real people only (employees and incoming hires). */
  people: Array<{ personId: ID; monthly: number }>
  /** Every counted line, including offers and plan slots. */
  lines: RunRateLine[]
  byDepartment: Array<{ departmentId: ID; name: string; monthly: number; headcount: number }>
  /** Monthly totals by cost component. */
  breakdown: { base: number; variable: number; employerTaxes: number; benefits: number; peoTools: number; workersComp: number }
  contractorsMonthly: number
  contractors: ContractorCost[]
}

/** Monthly cost of a contractor: hourly x hours per week x 4.33, monthly as is, a project fee spread over the contract. */
export function contractorMonthly(c: Contractor): { monthly: number; note?: string } {
  if (c.rateUnit === 'hour') {
    if (!c.hoursPerWeek) return { monthly: 0, note: 'No weekly hours set, so this counts as $0 a month.' }
    return { monthly: r2(c.rate * c.hoursPerWeek * 4.33) }
  }
  if (c.rateUnit === 'month') return { monthly: c.rate }
  if (!c.endOn) return { monthly: c.rate, note: 'No end date, so the whole project fee counts in one month.' }
  const months = Math.max(1, (daysBetween(c.startOn, c.endOn) + 1) / 30.4375)
  return { monthly: r2(c.rate / months) }
}

/** Contractors and paid advisors engaged on the date. */
export function activeContractors(db: DB, date: ISODate): Contractor[] {
  return db.contractors.filter(
    (c) => c.startOn <= date && (!c.endOn || c.endOn >= date) && (c.kind === 'contractor' || c.rate > 0),
  )
}

function departmentName(db: DB, id: ID): string {
  return db.departments.find((d) => d.id === id)?.name ?? 'No department'
}

function personLine(db: DB, p: Person, date: ISODate, kind: 'employee' | 'incoming', tax: TaxOptions): RunRateLine {
  const rec = compOrFirst(db, p.id, date)
  const base = rec ? annualBase(rec, p.hoursPerWeek) : 0
  const cost = loadedCost(db, {
    base,
    variablePct: rec?.variablePct ?? 0,
    state: p.homeState || db.company.hq.state,
    benefits: p.hoursPerWeek >= BENEFITS_MIN_HOURS,
    ...tax,
  })
  return {
    key: `p:${p.id}`,
    kind,
    personId: p.id,
    name: fullName(p),
    departmentId: rec?.departmentId ?? p.departmentId,
    base,
    monthly: cost.totalMonthly,
    cost,
    ...(base > 0 ? {} : { missingPay: true }),
  }
}

function offerLine(db: DB, o: Offer, kind: 'incoming' | 'offer', tax: TaxOptions): RunRateLine {
  const hours = o.hoursPerWeek ?? 40
  const base = annualBase(o, hours)
  const state = db.locations.find((l) => l.id === o.locationId)?.state ?? db.company.hq.state
  const cost = loadedCost(db, { base, variablePct: o.variablePct ?? 0, state, benefits: hours >= BENEFITS_MIN_HOURS, ...tax })
  return {
    key: `o:${o.id}`,
    kind,
    offerId: o.id,
    candidateId: o.candidateId,
    name: candidateName(db, o.candidateId),
    departmentId: o.departmentId,
    base,
    monthly: cost.totalMonthly,
    cost,
    ...(base > 0 ? {} : { missingPay: true }),
  }
}

function slotLine(db: DB, s: PlanSlot, tax: TaxOptions): RunRateLine {
  const { base } = slotBudgetBase(db, s)
  const band = bandFor(db, s.familyId, s.levelId)
  const cost = loadedCost(db, { base: base ?? 0, variablePct: band?.variablePct ?? 0, state: db.company.hq.state || 'CA', ...tax })
  return {
    key: `s:${s.id}`,
    kind: 'plan',
    slotId: s.id,
    name: s.title,
    departmentId: s.departmentId,
    base: base ?? 0,
    monthly: cost.totalMonthly,
    cost,
    ...(base ? {} : { missingPay: true }),
  }
}

/**
 * The run-rate lines for a scenario (W-2 only). Now is today's roster. Every forward scenario (with incoming,
 * with offers, at plan) leaves out employees with a known last day (they are gone by then, as in plan.ts
 * planEvents), and at plan a slot whose offers have all lapsed counts as open.
 */
export function runRateLines(db: DB, date: ISODate, include: RunRateInclude, tax: TaxOptions = {}): RunRateLine[] {
  const employees = employedOn(db, date).filter((p) => include === 'now' || !lastDayOf(p))
  const lines = employees.map((p) => personLine(db, p, date, 'employee', tax))
  if (include === 'now') return lines
  lines.push(...incomingOn(db, date).map((p) => personLine(db, p, date, 'incoming', tax)))
  lines.push(...acceptedOffersNotHired(db).map((o) => offerLine(db, o, 'incoming', tax)))
  if (include === 'with_incoming') return lines
  const out = outstandingOffers(db, date)
  lines.push(...out.map((o) => offerLine(db, o, 'offer', tax)))
  if (include === 'with_offers') return lines
  const liveOfferJobs = new Set(out.map((o) => o.jobId))
  const remaining = db.plan.filter((s) => {
    const st = planSlotStatus(db, s)
    if (st === 'planned' || st === 'open') return true
    if (st !== 'offer') return false
    const job = slotJob(db, s)
    return !!job && !liveOfferJobs.has(job.id)
  })
  lines.push(...remaining.map((s) => slotLine(db, s, tax)))
  return lines
}

/**
 * Fully loaded monthly run-rate on a date.
 * now = employed on the date; with_incoming adds hires who have not started (and accepted offers not yet hired);
 * with_offers adds offers awaiting approval, approved or sent (not past expiry); at_plan adds planned and open
 * plan slots at their budgeted base or band midpoint. The three forward scenarios drop employees with a known last day.
 * Contractors are reported separately and never in `monthly`. `futa` and `rates` override the tax assumptions.
 */
export function runRate(db: DB, date: ISODate, opts: { include: RunRateInclude } & TaxOptions = { include: 'now' }): RunRate {
  const tax: TaxOptions = { futa: opts.futa, rates: opts.rates }
  const lines = runRateLines(db, date, opts.include, tax)
  const sum = (f: (l: RunRateLine) => number) => lines.reduce((t, l) => t + f(l), 0)
  const monthly = Math.round(sum((l) => l.monthly))
  const depts = new Map<ID, { monthly: number; headcount: number }>()
  for (const l of lines) {
    const d = depts.get(l.departmentId) ?? { monthly: 0, headcount: 0 }
    d.monthly += l.monthly
    d.headcount += 1
    depts.set(l.departmentId, d)
  }
  const contractors = activeContractors(db, date).map((c) => {
    const m = contractorMonthly(c)
    return { contractorId: c.id, name: c.name, monthly: m.monthly, ...(m.note ? { note: m.note } : {}) }
  })
  return {
    include: opts.include,
    date,
    monthly,
    annual: Math.round(sum((l) => l.cost.totalAnnual)),
    headcount: lines.length,
    people: lines.filter((l) => l.personId).map((l) => ({ personId: l.personId as ID, monthly: Math.round(l.monthly) })),
    lines,
    byDepartment: [...depts.entries()]
      .map(([departmentId, d]) => ({ departmentId, name: departmentName(db, departmentId), monthly: Math.round(d.monthly), headcount: d.headcount }))
      .sort((a, b) => b.monthly - a.monthly),
    breakdown: {
      base: Math.round(sum((l) => l.cost.base) / 12),
      variable: Math.round(sum((l) => l.cost.variable) / 12),
      employerTaxes: Math.round(sum((l) => l.cost.employerTaxes.total) / 12),
      benefits: Math.round(sum((l) => l.cost.benefits) / 12),
      peoTools: Math.round(sum((l) => l.cost.peoTools) / 12),
      workersComp: Math.round(sum((l) => l.cost.workersComp) / 12),
    },
    contractorsMonthly: Math.round(contractors.reduce((t, c) => t + c.monthly, 0)),
    contractors,
  }
}

// ---------------------------------------------------------------------------------------------
// Runway
// ---------------------------------------------------------------------------------------------

/**
 * Payroll totals entered from the provider (Comp and plan > Pay runs) for paydays in a window, against what the
 * run-rate estimates for the same pay periods: wages at target plus employer taxes, over the periods in a year.
 */
export type PayrollActuals = {
  /** Paydays in the window with totals entered. */
  paydays: number
  /** Gross wages plus employer taxes, as the provider reported them. */
  actual: number
  /** The run-rate's wages and employer taxes for the same number of pay periods. */
  estimated: number
  /** actual - estimated: what runway spends on top of its estimate (negative when payroll cost less). */
  difference: number
}

/**
 * The payroll actuals for paydays after `from` and on or before `to` (the cash on hand already counts a payday on
 * its own date), measured against `rr`'s wages and employer taxes per pay period. Null when no payday in the
 * window has totals, so runway stays a pure estimate until the provider's numbers come in.
 */
export function payrollActualsBetween(db: Pick<DB, 'company'>, from: ISODate, to: ISODate, rr: Pick<RunRate, 'lines'>): PayrollActuals | null {
  const runs = (db.company.payRuns ?? []).filter((r) => r.totals && r.payday > from && r.payday <= to)
  if (!runs.length) return null
  const perPeriod = rr.lines.reduce((t, l) => t + l.cost.wages + l.cost.employerTaxes.total, 0) / payPeriodsPerYear(db.company.paySchedule)
  const actual = r2(runs.reduce((t, r) => t + (r.totals?.gross ?? 0) + (r.totals?.employerTaxes ?? 0), 0))
  const estimated = r2(perPeriod * runs.length)
  return { paydays: runs.length, actual, estimated, difference: r2(actual - estimated) }
}

/** How a payday's provider totals count in runway: spent on top of the estimate, already in cash, or not yet paid. */
export type ActualUse = 'runway' | 'in_cash' | 'upcoming'

export type PayrollActualRow = {
  periodStart: ISODate
  periodEnd: ISODate
  payday: ISODate
  gross: number
  employerTaxes: number
  /** gross + employerTaxes */
  actual: number
  /** The run-rate's wages and employer taxes for one pay period (what runway's burn assumes). */
  estimated: number
  difference: number
  /**
   * 'runway': paid after the cash-as-of date and by today, so cash now spends the difference (payrollActualsBetween).
   * 'in_cash': paid on or before the cash-as-of date (or with no date, by today): cash on hand already includes it.
   * 'upcoming': the payday is still ahead.
   */
  use: ActualUse
}

/**
 * Every pay run with provider totals, newest payday first, against the run-rate per pay period, and how each one
 * counts in runway (Comp and plan > Cost and runway shows it as an actual vs estimate history).
 */
export function payrollActualsHistory(db: Pick<DB, 'company'>, date: ISODate, rr: Pick<RunRate, 'lines'>): PayrollActualRow[] {
  const c = db.company
  const asOf = c.cashAsOf && c.cashAsOf < date ? c.cashAsOf : date
  const perPeriod = rr.lines.reduce((t, l) => t + l.cost.wages + l.cost.employerTaxes.total, 0) / payPeriodsPerYear(c.paySchedule)
  return (c.payRuns ?? [])
    .filter((r) => r.totals)
    .sort((a, b) => b.payday.localeCompare(a.payday))
    .map((r) => {
      const gross = r.totals?.gross ?? 0
      const employerTaxes = r.totals?.employerTaxes ?? 0
      const actual = r2(gross + employerTaxes)
      const estimated = r2(perPeriod)
      const use: ActualUse = r.payday > date ? 'upcoming' : r.payday > asOf ? 'runway' : 'in_cash'
      return { periodStart: r.periodStart, periodEnd: r.periodEnd, payday: r.payday, gross, employerTaxes, actual, estimated, difference: r2(actual - estimated), use }
    })
}

export type Runway = {
  scenario: RunRateInclude
  /** Months of cash left from `date`; null when cash on hand is unknown, Infinity when revenue covers spend, 0 when spent. */
  months: number | null
  /** Cash on hand as entered in Settings, on `cashAsOf`. */
  cashOnHand: number | null
  cashAsOf?: ISODate
  /** Estimated cash on `date`: cash on hand less the net burn since the cash-as-of date. */
  cashNow: number | null
  payrollMonthly: number
  contractorsMonthly: number
  otherMonthlySpend: number
  monthlyRevenue: number
  netBurnMonthly: number
  /** Estimated date cash runs out, or null. */
  runsOutOn: ISODate | null
  text: string
  /** Provider totals for paydays since the cash-as-of date, when any were entered: cashNow spends these instead of the estimate. */
  actuals?: PayrollActuals
}

/** Average days in a month (365.25 / 12). */
export const DAYS_PER_MONTH = 30.4375
/** A cash figure older than this many days is named in the runway text ("cash as of Jan 1, 2026"). */
export const STALE_CASH_DAYS = 45

const SCENARIO_PHRASE: Record<RunRateInclude, string> = {
  now: "at today's burn",
  with_incoming: 'with incoming hires',
  with_offers: 'with incoming hires and offers out',
  at_plan: 'if the plan hires on schedule',
}

/** Past this many months runway reads "more than 5 years": a figure like 508 months is not a forecast anyone can use. */
export const RUNWAY_CAP_MONTHS = 60

/** "27 months", "0.8 months", or "more than 5 years" past RUNWAY_CAP_MONTHS. */
function monthsText(months: number): string {
  if (months > RUNWAY_CAP_MONTHS) return 'more than 5 years'
  return `${months >= 2 ? Math.round(months) : months.toFixed(1)} months`
}

/** A runway figure on its own: "27 months", "0.8 months", "More than 5 years", or "Not shrinking" when revenue covers spend. */
export function runwayMonthsLabel(months: number): string {
  if (months === Infinity) return 'Not shrinking'
  const text = monthsText(months)
  return text[0].toUpperCase() + text.slice(1)
}

/**
 * Runway on `date`. Cash on hand is as of company.cashAsOf, so the net burn since then is spent first:
 * cashNow = cash on hand - today's burn x days since cashAsOf / 30.4375, and months = cashNow / scenario burn,
 * where burn = payroll + other monthly spend + contractors - monthly revenue. The spend since cashAsOf uses
 * today's burn in every scenario, because planned hires were not on payroll then. Paydays since cashAsOf with
 * totals entered from the provider count what payroll really cost (payrollActualsBetween): cashNow also spends
 * the difference between those totals and the estimate. Future months stay estimates.
 */
export function runway(db: DB, date: ISODate, scenario: RunRateInclude = 'now', opts: TaxOptions = {}): Runway {
  const rr = runRate(db, date, { include: scenario, ...opts })
  const c = db.company
  const other = c.otherMonthlySpend ?? 0
  const revenue = c.monthlyRevenue ?? 0
  const burn = rr.monthly + other + rr.contractorsMonthly - revenue
  const rrNow = scenario === 'now' ? rr : runRate(db, date, { include: 'now', ...opts })
  const burnSoFar = rrNow.monthly + other + rrNow.contractorsMonthly - revenue
  const asOf = c.cashAsOf && c.cashAsOf < date ? c.cashAsOf : date
  const actuals = c.cashOnHand == null ? null : payrollActualsBetween(db, asOf, date, rrNow)
  const base = {
    scenario,
    ...(actuals ? { actuals } : {}),
    cashOnHand: c.cashOnHand ?? null,
    ...(c.cashAsOf ? { cashAsOf: c.cashAsOf } : {}),
    payrollMonthly: rr.monthly,
    contractorsMonthly: rr.contractorsMonthly,
    otherMonthlySpend: other,
    monthlyRevenue: revenue,
    netBurnMonthly: Math.round(burn),
  }
  if (c.cashOnHand == null) {
    return { ...base, cashNow: null, months: null, runsOutOn: null, text: 'Add cash on hand in Settings to see runway.' }
  }
  const extra = actuals?.difference ?? 0
  const cashNow = c.cashOnHand - (burnSoFar * daysBetween(asOf, date)) / DAYS_PER_MONTH - extra
  const stale = asOf < date && daysBetween(asOf, date) > STALE_CASH_DAYS ? ` (cash as of ${fmtDate(asOf)})` : ''
  if (burn <= 0) {
    return {
      ...base,
      cashNow: Math.round(cashNow),
      months: Infinity,
      runsOutOn: null,
      text: `Revenue covers monthly spend, so cash is not going down${stale}.`,
    }
  }
  if (cashNow <= 0) {
    const runsOutOn = burnSoFar > 0 ? addDays(asOf, Math.max(0, Math.floor(((c.cashOnHand - extra) / burnSoFar) * DAYS_PER_MONTH))) : date
    return {
      ...base,
      cashNow: Math.round(cashNow),
      months: 0,
      runsOutOn,
      text: `At this burn, the cash on hand from ${fmtDate(asOf)} would have run out by ${fmtDate(runsOutOn)}. Update cash on hand in Settings.`,
    }
  }
  const months = cashNow / burn
  return {
    ...base,
    cashNow: Math.round(cashNow),
    months,
    runsOutOn: addDays(date, Math.floor(months * DAYS_PER_MONTH)),
    text: `${months > RUNWAY_CAP_MONTHS ? 'More than 5 years' : `About ${monthsText(months)}`} of runway ${SCENARIO_PHRASE[scenario]}${stale}.`,
  }
}

// ---------------------------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------------------------

/** "This offer adds $23,200 a month fully loaded." */
export function offerMonthlyImpact(
  db: DB,
  offer: Offer,
  opts: TaxOptions = {},
): { monthly: number; annual: number; cost: LoadedCost; text: string } {
  const line = offerLine(db, offer, 'offer', opts)
  const shown = Math.round(line.cost.totalMonthly / 100) * 100
  return {
    monthly: line.cost.totalMonthly,
    annual: line.cost.totalAnnual,
    cost: line.cost,
    text: `This offer adds ${money(shown)} a month fully loaded.`,
  }
}

// ---------------------------------------------------------------------------------------------
// Exempt checks and band exceptions
// ---------------------------------------------------------------------------------------------

export type ExemptIssue = {
  kind: 'salary_floor' | 'computer_professional' | 'hourly_exempt'
  /** Annual salary, or the hourly rate for hourly computer professionals. */
  pay: number
  minimum: number
  text: string
}

export type ExemptInput = {
  payType: 'salary' | 'hourly'
  salary?: number
  hourlyRate?: number
  hoursPerWeek?: number
  exemptionBasis?: ExemptionBasis
  /** Work state. California floors apply only to work in California. */
  state?: string
}

/**
 * California exempt pay check for someone classified exempt (docs/LAW.md w-exempt-salary-2026,
 * w-software-exempt-2026). Returns null when the pay passes. Outside sales has no salary test, and
 * only California work is checked. The duties tests also apply and are not checked here.
 */
export function exemptCheck(law: LawSettings, input: ExemptInput): ExemptIssue | null {
  if (input.state && input.state.toUpperCase() !== 'CA') return null
  if (input.exemptionBasis === 'outside_sales') return null
  if (input.exemptionBasis === 'computer_professional') {
    if (input.payType === 'hourly') {
      const rate = input.hourlyRate ?? 0
      if (rate >= law.computerProHourly) return null
      return {
        kind: 'computer_professional',
        pay: rate,
        minimum: law.computerProHourly,
        text: `${money2(rate)} an hour is below the ${law.year} California computer professional minimum of ${money2(law.computerProHourly)} an hour (Labor Code 515.5). Treat the role as non-exempt or raise pay.`,
      }
    }
    const salary = input.salary ?? 0
    if (salary >= law.computerProAnnual) return null
    return {
      kind: 'computer_professional',
      pay: salary,
      minimum: law.computerProAnnual,
      text: `${money(salary)} is below the ${law.year} California computer professional minimum of ${money2(law.computerProAnnual)} a year (Labor Code 515.5). Use another exemption that fits, treat the role as non-exempt, or raise pay.`,
    }
  }
  if (input.payType === 'hourly') {
    const annual = annualBase(input, input.hoursPerWeek ?? 40)
    return {
      kind: 'hourly_exempt',
      pay: annual,
      minimum: law.exemptSalaryMin,
      text: `Paid hourly but classified exempt. The executive, administrative and professional exemptions need a salary of at least ${money(law.exemptSalaryMin)} a year. Review the classification.`,
    }
  }
  const salary = input.salary ?? 0
  if (salary >= law.exemptSalaryMin) return null
  return {
    kind: 'salary_floor',
    pay: salary,
    minimum: law.exemptSalaryMin,
    text: `${money(salary)} is below the ${law.year} California exempt minimum of ${money(law.exemptSalaryMin)} (2 x the state minimum wage x 2,080 hours). Reclassify as non-exempt or raise pay.`,
  }
}

export type ExemptFlag = ExemptIssue & { personId: ID; name: string }

/** Employees (and incoming hires) classified exempt whose pay is below the California minimum for their exemption. */
export function exemptFlags(db: DB, date: ISODate): ExemptFlag[] {
  const people = [...employedOn(db, date), ...incomingOn(db, date)]
  const out: ExemptFlag[] = []
  for (const p of people) {
    const rec = compOrFirst(db, p.id, date)
    const flsa: FLSA = rec?.flsa ?? p.flsa
    if (flsa !== 'exempt' || !rec) continue
    const issue = exemptCheck(db.settings.law, {
      payType: rec.payType,
      salary: rec.salary,
      hourlyRate: rec.hourlyRate,
      hoursPerWeek: p.hoursPerWeek,
      // The row in force on the date knows its exemption; older rows without one fall back to the person.
      exemptionBasis: rec.exemptionBasis ?? p.exemptionBasis,
      state: p.homeState,
    })
    if (issue) out.push({ ...issue, personId: p.id, name: fullName(p) })
  }
  return out
}

/**
 * The band exception reason on the record in force on the date (the first record for an incoming hire). An
 * older record's reason never explains newer pay: changeJobOrPay carries the reason forward on a change that
 * leaves pay alone, so a newer record without one is pay set with no exception recorded, or pay that sat
 * inside the band until the band was edited (bands are not dated, so that cannot be told apart).
 */
function latestExceptionReason(db: DB, person: Person, date: ISODate): string | undefined {
  return compOrFirst(db, person.id, date)?.exceptionReason || undefined
}

export type OutOfBandRow = {
  personId: ID
  name: string
  /** Base restated at full time, as compared with the band. */
  base: number
  band: Band
  direction: 'below' | 'above'
  /** Distance to the nearest band edge, in dollars. */
  gap: number
  compaRatio: number
  exceptionReason?: string
}

/** People (employed or incoming) whose full-time-equivalent base sits outside their band. */
export function outOfBand(db: DB, date: ISODate): OutOfBandRow[] {
  const out: OutOfBandRow[] = []
  for (const p of [...employedOn(db, date), ...incomingOn(db, date)]) {
    const rec = compOrFirst(db, p.id, date)
    const band = bandForPerson(db, p, date)
    if (!rec || !band) continue
    const base = fullTimeEquivalentBase(rec, p.hoursPerWeek)
    if (base >= band.min && base <= band.max) continue
    const direction = base < band.min ? 'below' : 'above'
    const reason = latestExceptionReason(db, p, date)
    out.push({
      personId: p.id,
      name: fullName(p),
      base,
      band,
      direction,
      gap: direction === 'below' ? band.min - base : base - band.max,
      compaRatio: compaRatio(base, band),
      ...(reason ? { exceptionReason: reason } : {}),
    })
  }
  return out
}

export type CompTableRow = {
  personId: ID
  name: string
  title: string
  departmentId: ID
  familyId: ID
  levelId: ID
  flsa: FLSA
  payType: 'salary' | 'hourly'
  hourlyRate?: number
  /** Scheduled hours a week (40 for full time); part-time pay is restated at 40 in fteBase. */
  hoursPerWeek: number
  /** Actual annual base (hourly x hours x 52 for hourly pay). */
  base: number
  /** Base restated at full time (used for the band comparison). */
  fteBase: number
  variablePct: number
  variable: number
  band?: Band
  bandPosition: number | null
  bandLabel: string | null
  compaRatio: number | null
  lastChange?: { effectiveOn: ISODate; reason: CompRecord['reason'] }
  exceptionReason?: string
  incoming: boolean
}

/** One row per employed or incoming person for the comp table. */
export function compTable(db: DB, date: ISODate): CompTableRow[] {
  const incomingIds = new Set(incomingOn(db, date).map((p) => p.id))
  return [...employedOn(db, date), ...incomingOn(db, date)].map((p) => {
    const rec = compOrFirst(db, p.id, date)
    const band = bandForPerson(db, p, date)
    const base = rec ? annualBase(rec, p.hoursPerWeek) : 0
    const fteBase = rec ? fullTimeEquivalentBase(rec, p.hoursPerWeek) : 0
    const variablePct = rec?.variablePct ?? 0
    // A reason shows only while pay is outside the band.
    const zone = band && rec ? bandZone(fteBase, band) : null
    const reason = zone === 'below' || zone === 'above' ? latestExceptionReason(db, p, date) : undefined
    return {
      personId: p.id,
      name: fullName(p),
      title: rec?.title ?? p.title,
      departmentId: rec?.departmentId ?? p.departmentId,
      familyId: p.familyId,
      levelId: rec?.levelId ?? p.levelId,
      flsa: rec?.flsa ?? p.flsa,
      payType: rec?.payType ?? 'salary',
      ...(rec?.payType === 'hourly' ? { hourlyRate: rec.hourlyRate ?? 0 } : {}),
      hoursPerWeek: p.hoursPerWeek || 40,
      base,
      fteBase,
      variablePct,
      variable: r2(base * variablePct),
      ...(band ? { band } : {}),
      bandPosition: band && rec ? bandPosition(fteBase, band) : null,
      bandLabel: zone ? ZONE_LABEL[zone] : null,
      compaRatio: band && rec ? compaRatio(fteBase, band) : null,
      ...(rec ? { lastChange: { effectiveOn: rec.effectiveOn, reason: rec.reason } } : {}),
      ...(reason ? { exceptionReason: reason } : {}),
      incoming: incomingIds.has(p.id),
    }
  })
}

// ---------------------------------------------------------------------------------------------
// Home dashboard summary
// ---------------------------------------------------------------------------------------------

export type PeopleCostSummary = {
  now: RunRate
  withOffers: RunRate
  atPlan: RunRate
  runwayNow: Runway
  runwayAtPlan: Runway
  /** Names added by the "with" scenario (incoming hires and offers out), first names. */
  addedNames: string[]
  text: string
}

/**
 * The Home "People cost" line: "Run-rate $235K a month fully loaded, $278K with Ravi and Danielle,
 * about $380K at plan. Contractors $21K a month. Runway about 27 months at today's burn, about 20 at plan."
 */
export function peopleCostSummary(db: DB, date: ISODate, opts: TaxOptions = {}): PeopleCostSummary {
  const now = runRate(db, date, { include: 'now', ...opts })
  const withOffers = runRate(db, date, { include: 'with_offers', ...opts })
  const atPlan = runRate(db, date, { include: 'at_plan', ...opts })
  const runwayNow = runway(db, date, 'now', opts)
  const runwayAtPlan = runway(db, date, 'at_plan', opts)
  const added = withOffers.lines.filter((l) => l.kind === 'incoming' || l.kind === 'offer').map((l) => l.name.split(' ')[0])
  const parts = [`Run-rate ${moneyShort(now.monthly)} a month fully loaded`]
  if (added.length) {
    const who = added.length <= 3 ? listJoin(added) : `${added.length} incoming hires and offers`
    parts.push(`${moneyShort(withOffers.monthly)} with ${who}`)
  }
  if (atPlan.monthly !== withOffers.monthly) parts.push(`about ${moneyShort(atPlan.monthly)} at plan`)
  let text = `${parts.join(', ')}.`
  if (now.contractorsMonthly > 0) text += ` Contractors ${moneyShort(now.contractorsMonthly)} a month.`
  const fmtMonths = (r: Runway) =>
    r.months === Infinity ? 'not shrinking' : (r.months ?? 0) > RUNWAY_CAP_MONTHS ? monthsText(r.months ?? 0) : `about ${monthsText(r.months ?? 0)}`
  const stale =
    runwayNow.cashAsOf && runwayNow.cashAsOf < date && daysBetween(runwayNow.cashAsOf, date) > STALE_CASH_DAYS
      ? ` (cash as of ${fmtDate(runwayNow.cashAsOf)})`
      : ''
  if (runwayNow.months == null) text += ' Add cash on hand in Settings to see runway.'
  else if (runwayNow.months === Infinity) text += ' Revenue covers monthly spend today.'
  else if (runwayNow.months === 0) text += ` ${runwayNow.text}`
  else {
    text += ` Runway ${fmtMonths(runwayNow)} at today's burn`
    text +=
      atPlan.monthly !== now.monthly && runwayAtPlan.months != null
        ? `, ${fmtMonths(runwayAtPlan).replace(' months', '')} at plan${stale}.`
        : `${stale}.`
  }
  return { now, withOffers, atPlan, runwayNow, runwayAtPlan, addedNames: added, text }
}
