// Headcount plan: slot status roll-up, projection toward 20, the plan summary line, budget variance and
// the cost of the remaining plan (docs/SPEC.md: HEADCOUNT PLAN, Home dashboard "Headcount vs plan").
// Slot status comes from the linked job, offer and person (planSlotStatus lives in pay.ts so the
// run-rate can use it without an import cycle).
import {
  acceptedOffersNotHired,
  annualBase,
  bandFor,
  candidateName,
  compHistory,
  fullTimeEquivalentBase,
  type LoadedCost,
  loadedCost,
  type PayFields,
  planSlotStatus,
  slotBudgetBase,
  slotJob,
  slotOffer,
  slotPerson,
} from '@/domain/pay'
import { employedOn, fullName, headcountOn, headcountSeries, incomingOn } from '@/domain/people'
import type { Band, DB, ID, Job, Offer, Person, PlanSlot } from '@/domain/types'
import { addDays, fmtDate, fmtShort, type ISODate, nextQuarter, quarterEnd, quarterOf } from '@/lib/dates'

export { planSlotStatus as slotStatus } from '@/domain/pay'

// ---------------------------------------------------------------------------------------------
// Roll-up
// ---------------------------------------------------------------------------------------------

export type PlanRow = {
  slot: PlanSlot
  /** Status rolled up from the job, offer and person. */
  status: PlanSlot['status']
  storedStatus: PlanSlot['status']
  job?: Job
  offer?: Offer
  person?: Person
  band?: Band
  /** Budgeted base, else the band midpoint, else null. */
  budgetBase: number | null
  budgetFromBand: boolean
  /** Fully loaded cost at the budget base (HQ state), or null without a base. */
  loaded: LoadedCost | null
}

/** Every plan slot with its derived status, sorted by quarter, then target start. */
export function planRollup(db: DB): PlanRow[] {
  return [...db.plan]
    .sort((a, b) => a.quarter.localeCompare(b.quarter) || a.targetStart.localeCompare(b.targetStart))
    .map((slot) => {
      const job = slotJob(db, slot)
      const offer = slotOffer(db, slot)
      const person = slotPerson(db, slot)
      const band = bandFor(db, slot.familyId, slot.levelId)
      const { base, fromBand } = slotBudgetBase(db, slot)
      return {
        slot,
        status: planSlotStatus(db, slot),
        storedStatus: slot.status,
        ...(job ? { job } : {}),
        ...(offer ? { offer } : {}),
        ...(person ? { person } : {}),
        ...(band ? { band } : {}),
        budgetBase: base,
        budgetFromBand: fromBand,
        loaded: base != null ? loadedCost(db, { base, variablePct: band?.variablePct ?? 0, state: db.company.hq.state || 'CA' }) : null,
      }
    })
}

/** Counts of slots by derived status. */
export function planStatusCounts(db: DB): Record<PlanSlot['status'], number> {
  const counts: Record<PlanSlot['status'], number> = { planned: 0, open: 0, offer: 0, filled: 0, cut: 0 }
  for (const s of db.plan) counts[planSlotStatus(db, s)] += 1
  return counts
}

// ---------------------------------------------------------------------------------------------
// Hiring onto the plan
// ---------------------------------------------------------------------------------------------

/** A plan line nobody holds yet: not filled or cut, and no person on it. */
function freeSlot(s: PlanSlot): boolean {
  return s.status !== 'filled' && s.status !== 'cut' && !s.personId
}

/**
 * The plan line a hire from this offer fills: the job's own line (its planSlotId), else the first line
 * linked to the job by jobId, as long as nobody holds it yet. A second hire from the same job finds the
 * first hire's line taken and gets undefined, so hireFromOffer adds a filled line for the extra seat
 * instead of moving the first hire off theirs (SPEC: ONE-CLICK HIRE).
 */
export function planSlotForHire(db: DB, offer: Pick<Offer, 'jobId'>, job?: Pick<Job, 'planSlotId'>): PlanSlot | undefined {
  const own = job?.planSlotId ? db.plan.find((s) => s.id === job.planSlotId) : undefined
  if (own && freeSlot(own)) return own
  return db.plan.find((s) => s.jobId === offer.jobId && freeSlot(s))
}

/** Whether any plan line is linked to the job, held or not (a hire past it adds a seat outside the plan). */
export function jobHasPlanLine(db: DB, offer: Pick<Offer, 'jobId'>, job?: Pick<Job, 'planSlotId'>): boolean {
  return db.plan.some((s) => (!!job?.planSlotId && s.id === job.planSlotId) || s.jobId === offer.jobId)
}

// ---------------------------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------------------------

export type StepPoint = { date: ISODate; value: number; label?: string }

export type HeadcountProjection = {
  /** W-2 headcount change points from founding to the date, ending with a point on the date. */
  actual: StepPoint[]
  /** From the date forward: incoming hires, accepted offers, remaining plan slots and known departures. */
  plan: StepPoint[]
  /** Plan headcount at each quarter end from the current quarter to the last planned change. */
  targets: Array<{ quarter: string; date: ISODate; value: number }>
  current: number
  /** Headcount once every planned change has happened. */
  final: number
}

type PlanEvent = { date: ISODate; delta: number; label: string }

function planEvents(db: DB, date: ISODate): PlanEvent[] {
  const events: PlanEvent[] = []
  const at = (d: ISODate) => (d < date ? date : d)
  for (const p of incomingOn(db, date)) events.push({ date: p.startDate, delta: 1, label: fullName(p) })
  for (const o of acceptedOffersNotHired(db)) events.push({ date: at(o.startDate), delta: 1, label: candidateName(db, o.candidateId) })
  for (const s of db.plan) {
    const st = planSlotStatus(db, s)
    if (st !== 'planned' && st !== 'open' && st !== 'offer') continue
    const offer = st === 'offer' ? slotOffer(db, s) : undefined
    events.push({ date: at(offer?.startDate ?? s.targetStart), delta: 1, label: s.title })
  }
  for (const p of employedOn(db, date)) {
    if (p.endDate && p.endDate >= date) events.push({ date: addDays(p.endDate, 1), delta: -1, label: `${fullName(p)} leaves` })
  }
  return events.sort((a, b) => a.date.localeCompare(b.date))
}

/** Actual and planned W-2 headcount as step points, plus plan targets at each quarter end. */
export function headcountProjection(db: DB, date: ISODate): HeadcountProjection {
  const current = headcountOn(db, date)
  const actual: StepPoint[] = headcountSeries(db, date).map((p) => ({ date: p.date, value: p.value }))
  if (!actual.length || actual[actual.length - 1].date !== date) actual.push({ date, value: current })

  const events = planEvents(db, date)
  const plan: StepPoint[] = [{ date, value: current }]
  let value = current
  for (const e of events) {
    value += e.delta
    const last = plan[plan.length - 1]
    if (last.date === e.date) {
      last.value = value
      last.label = last.label ? `${last.label}, ${e.label}` : e.label
    } else plan.push({ date: e.date, value, label: e.label })
  }

  const targets: HeadcountProjection['targets'] = []
  const lastDate = events.length ? events[events.length - 1].date : date
  for (let q = quarterOf(date); q <= quarterOf(lastDate); q = nextQuarter(q)) {
    const end = quarterEnd(q)
    targets.push({ quarter: q, date: end, value: current + events.filter((e) => e.date <= end).reduce((t, e) => t + e.delta, 0) })
  }
  return { actual, plan, targets, current, final: value }
}

/** "Plan: 16 by Dec 31, 19 by Mar 31, 20 by Jun 30, 2027" (quarter ends where the plan changes). */
export function planSummary(db: DB, date: ISODate): string {
  const { targets, current } = headcountProjection(db, date)
  const changes = targets.length > 1 || (targets[0] && targets[0].value !== current)
  if (!db.plan.length && !changes) return 'No headcount plan yet.'
  const shown: typeof targets = []
  for (const t of targets) if (!shown.length || t.value !== shown[shown.length - 1].value) shown.push(t)
  if (!shown.length) return `Plan: ${current} by ${fmtDate(quarterEnd(quarterOf(date)))}`
  const parts = shown.map((t, i) => `${t.value} by ${i === shown.length - 1 ? fmtDate(t.date) : fmtShort(t.date)}`)
  return `Plan: ${parts.join(', ')}`
}

// ---------------------------------------------------------------------------------------------
// Budget variance and plan cost
// ---------------------------------------------------------------------------------------------

export type VarianceRow = {
  slotId: ID
  title: string
  status: 'filled' | 'offer'
  budgetBase: number | null
  budgetFromBand: boolean
  /**
   * Offered base (the deciding offer) or the hire's starting base, restated at full time (40 hours a week)
   * the way the comp table compares pay with bands: budgets and band midpoints are full-time figures.
   */
  actualBase: number | null
  /** Set when actualBase restates part-time pay: the hours a week the offer or hire is for. */
  restatedFromHours?: number
  source: 'offer' | 'comp' | null
  /** actualBase - budgetBase (positive = over budget). */
  variance: number | null
  variancePct: number | null
  personId?: ID
  offerId?: ID
}

/**
 * Budgeted versus offered or actual base for each filled slot and each slot with an offer out. Part-time pay
 * is restated at full time before the comparison, so a 30-hour hire is not counted as under budget.
 */
export function budgetVariance(db: DB): { rows: VarianceRow[]; totals: { budget: number; actual: number; variance: number } } {
  const rows: VarianceRow[] = []
  for (const slot of db.plan) {
    const status = planSlotStatus(db, slot)
    if (status !== 'filled' && status !== 'offer') continue
    const { base: budgetBase, fromBand } = slotBudgetBase(db, slot)
    const offer = slotOffer(db, slot)
    const person = slotPerson(db, slot)
    // The pay and its hours: the deciding offer, else the hire's first record.
    let paid: { rec: PayFields; hours: number } | null = null
    let source: VarianceRow['source'] = null
    if (offer) {
      paid = { rec: offer, hours: offer.hoursPerWeek ?? 40 }
      source = 'offer'
    } else if (person) {
      const history = compHistory(db, person.id)
      const hire = history.find((c) => c.reason === 'hire') ?? history[0]
      if (hire) {
        paid = { rec: hire, hours: person.hoursPerWeek || 40 }
        source = 'comp'
      }
    }
    const actualBase = paid ? fullTimeEquivalentBase(paid.rec, paid.hours) : null
    const restatedFromHours = paid && actualBase !== annualBase(paid.rec, paid.hours) ? paid.hours : undefined
    const variance = budgetBase != null && actualBase != null ? actualBase - budgetBase : null
    rows.push({
      slotId: slot.id,
      title: slot.title,
      status,
      budgetBase,
      budgetFromBand: fromBand,
      actualBase,
      ...(restatedFromHours != null ? { restatedFromHours } : {}),
      source,
      variance,
      variancePct: variance != null && budgetBase ? variance / budgetBase : null,
      ...(person ? { personId: person.id } : {}),
      ...(offer ? { offerId: offer.id } : {}),
    })
  }
  const both = rows.filter((r) => r.budgetBase != null && r.actualBase != null)
  const budget = both.reduce((t, r) => t + (r.budgetBase ?? 0), 0)
  const actual = both.reduce((t, r) => t + (r.actualBase ?? 0), 0)
  return { rows, totals: { budget, actual, variance: actual - budget } }
}

export type PlanCostRow = {
  slotId: ID
  title: string
  quarter: string
  status: PlanSlot['status']
  targetStart: ISODate
  base: number
  basis: 'budget' | 'band_mid' | 'none'
  monthly: number
  annual: number
}

export type PlanCost = {
  rows: PlanCostRow[]
  count: number
  monthly: number
  annual: number
  /** Added monthly cost by the quarter each slot is expected to start (overdue slots count in the current quarter). */
  byQuarter: Array<{ quarter: string; count: number; monthly: number }>
}

/** Fully loaded cost of the slots not yet filled (planned, open or offer) at budget base or band midpoint. */
export function planCost(db: DB, date: ISODate): PlanCost {
  const rows: PlanCostRow[] = []
  for (const slot of db.plan) {
    const status = planSlotStatus(db, slot)
    if (status !== 'planned' && status !== 'open' && status !== 'offer') continue
    const { base, fromBand } = slotBudgetBase(db, slot)
    const band = bandFor(db, slot.familyId, slot.levelId)
    const cost = loadedCost(db, { base: base ?? 0, variablePct: band?.variablePct ?? 0, state: db.company.hq.state || 'CA' })
    rows.push({
      slotId: slot.id,
      title: slot.title,
      quarter: quarterOf(slot.targetStart < date ? date : slot.targetStart),
      status,
      targetStart: slot.targetStart,
      base: base ?? 0,
      basis: base == null ? 'none' : fromBand ? 'band_mid' : 'budget',
      monthly: Math.round(cost.totalMonthly),
      annual: Math.round(cost.totalAnnual),
    })
  }
  rows.sort((a, b) => a.targetStart.localeCompare(b.targetStart))
  const quarters = new Map<string, { count: number; monthly: number }>()
  for (const r of rows) {
    const q = quarters.get(r.quarter) ?? { count: 0, monthly: 0 }
    q.count += 1
    q.monthly += r.monthly
    quarters.set(r.quarter, q)
  }
  return {
    rows,
    count: rows.length,
    monthly: rows.reduce((t, r) => t + r.monthly, 0),
    annual: rows.reduce((t, r) => t + r.annual, 0),
    byQuarter: [...quarters.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([quarter, q]) => ({ quarter, ...q })),
  }
}
