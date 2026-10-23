import { describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import {
  annualBase,
  bandFor,
  bandLabel,
  bandPosition,
  benefitsBasis,
  compaRatio,
  compHistory,
  compHistoryByLastDay,
  compTable,
  contractorMonthly,
  currentComp,
  employerTaxes,
  exemptCheck,
  exemptFlags,
  fullTimeEquivalentBase,
  hourlyRateOf,
  lastDayOf,
  loadedCost,
  offerMonthlyImpact,
  outOfBand,
  outstandingOffers,
  payPeriodsPerYear,
  payrollActualsBetween,
  payrollActualsHistory,
  peopleCostSummary,
  planSlotStatus,
  runRate,
  runway,
  RUNWAY_CAP_MONTHS,
  runwayMonthsLabel,
  slotOffer,
  slotPerson,
} from '@/domain/pay'
import { headcountProjection } from '@/domain/plan'
import type { CompRecord, Contractor, DB, Job, Offer, Person, PlanSlot } from '@/domain/types'

const D = '2026-10-09'

function mkPerson(id: string, over: Partial<Person> = {}): Person {
  return {
    id,
    firstName: id.slice(2, 3).toUpperCase() + id.slice(3),
    lastName: 'Test',
    workEmail: `${id}@test.com`,
    title: 'Engineer',
    departmentId: 'd-eng',
    familyId: 'f-eng',
    levelId: 'lv-l3',
    managerId: 'p-founder',
    locationId: 'loc-hq',
    workMode: 'hybrid',
    homeState: 'CA',
    employmentType: 'full_time',
    hoursPerWeek: 40,
    flsa: 'exempt',
    exemptionBasis: 'professional',
    startDate: '2026-01-05',
    hireNumber: 2,
    emergencyContacts: [],
    ...over,
  }
}

function mkComp(personId: string, effectiveOn: string, salary: number, over: Partial<CompRecord> = {}): CompRecord {
  return {
    id: `cr-${personId}-${effectiveOn}`,
    personId,
    effectiveOn,
    payType: 'salary',
    salary,
    title: 'Engineer',
    levelId: 'lv-l3',
    reason: 'hire',
    ...over,
  }
}

function mkOffer(id: string, over: Partial<Offer> = {}): Offer {
  return {
    id,
    applicationId: `a-${id}`,
    candidateId: `c-${id}`,
    jobId: 'j-none',
    version: 1,
    title: 'Solutions engineer',
    levelId: 'lv-l3',
    familyId: 'f-solutions',
    departmentId: 'd-gtm',
    managerId: 'p-founder',
    locationId: 'loc-hq',
    workMode: 'hybrid',
    employmentType: 'full_time',
    flsa: 'exempt',
    payType: 'salary',
    salary: 165_000,
    equityType: 'ISO',
    equityShares: 18_000,
    vestingMonths: 48,
    cliffMonths: 12,
    startDate: '2026-11-09',
    expiresOn: '2026-10-14',
    contingencies: [],
    status: 'sent',
    createdOn: '2026-10-07',
    approvals: [],
    ...over,
  }
}

function mkJob(id: string, over: Partial<Job> = {}): Job {
  return {
    id,
    title: 'Job',
    departmentId: 'd-eng',
    familyId: 'f-eng',
    levelId: 'lv-l3',
    hiringManagerId: 'p-founder',
    panelIds: [],
    locationIds: ['loc-hq'],
    workMode: 'hybrid',
    employmentType: 'full_time',
    flsa: 'exempt',
    payMin: 180_000,
    payMax: 230_000,
    status: 'open',
    stages: [],
    interviewPlan: [],
    description: '',
    sponsorship: 'no',
    backgroundCheck: true,
    priority: 'normal',
    ...over,
  }
}

function mkSlot(id: string, over: Partial<PlanSlot> = {}): PlanSlot {
  return {
    id,
    quarter: '2026-Q4',
    title: 'Senior engineer',
    departmentId: 'd-eng',
    familyId: 'f-eng',
    levelId: 'lv-l3',
    targetStart: '2026-12-07',
    status: 'planned',
    ...over,
  }
}

function mkContractor(id: string, over: Partial<Contractor> = {}): Contractor {
  return {
    id,
    kind: 'contractor',
    name: id,
    entityType: 'individual',
    email: `${id}@test.com`,
    scope: 'Work',
    rate: 85,
    rateUnit: 'hour',
    hoursPerWeek: 25,
    startOn: '2026-04-01',
    managerId: 'p-founder',
    departmentId: 'd-ops',
    state: 'CA',
    ab5: { exemption: 'none', a: null, b: null, c: null },
    w9OnFile: true,
    ...over,
  }
}

function baseDB(): DB {
  const db = blankDB({ companyName: 'Testco', founderFirstName: 'Maya', founderLastName: 'Raman', foundedOn: '2025-02-03' })
  db.comp.push(mkComp('p-founder', '2025-02-03', 150_000, { levelId: 'lv-x1', title: 'Founder and CEO' }))
  return db
}

/** Founder, a CA engineer, a TX seller, a part-time hourly coordinator, an alumnus, an incoming hire, offers, plan slots and contractors. */
function richDB(): DB {
  const db = baseDB()
  db.locations.push({ id: 'loc-remote-tx', name: 'Remote (Texas)', kind: 'remote', state: 'TX', minWageHourly: 7.25 })
  db.people.push(
    mkPerson('p-ana', { startDate: '2025-05-12' }),
    mkPerson('p-tex', { startDate: '2026-03-02', homeState: 'TX', familyId: 'f-gtm', departmentId: 'd-gtm', locationId: 'loc-remote-tx' }),
    mkPerson('p-luis', {
      startDate: '2026-07-20',
      employmentType: 'part_time',
      hoursPerWeek: 24,
      flsa: 'non_exempt',
      exemptionBasis: undefined,
      familyId: 'f-ops',
      levelId: 'lv-l1',
      departmentId: 'd-ops',
    }),
    mkPerson('p-omar', { startDate: '2026-05-04', endDate: '2026-08-28' }),
    mkPerson('p-lucas', { startDate: '2026-10-19' }),
  )
  db.comp.push(
    mkComp('p-ana', '2025-05-12', 185_000),
    mkComp('p-ana', '2026-03-01', 212_000, { reason: 'market' }),
    mkComp('p-tex', '2026-03-02', 140_000, { variablePct: 1 }),
    mkComp('p-luis', '2026-07-20', 0, { payType: 'hourly', salary: undefined, hourlyRate: 30, levelId: 'lv-l1', flsa: 'non_exempt' }),
    mkComp('p-omar', '2026-05-04', 188_000),
    mkComp('p-lucas', '2026-10-19', 195_000),
  )
  db.offers.push(
    mkOffer('o-dan-v1', { applicationId: 'a-dan', candidateId: 'c-dan', version: 1, salary: 160_000, variablePct: 0.15, jobId: 'j-se' }),
    mkOffer('o-dan-v2', { applicationId: 'a-dan', candidateId: 'c-dan', version: 2, salary: 165_000, variablePct: 0.15, jobId: 'j-se' }),
    mkOffer('o-mei', { applicationId: 'a-mei', candidateId: 'c-mei', status: 'accepted', salary: 228_000, familyId: 'f-ml', departmentId: 'd-eng', startDate: '2026-11-02' }),
    mkOffer('o-old', { applicationId: 'a-old', candidateId: 'c-old', status: 'declined', salary: 999_000 }),
  )
  db.candidates.push(
    { id: 'c-dan', firstName: 'Danielle', lastName: 'Brooks', email: 'd@x.com', links: {}, source: 'outbound', sponsorship: 'no', tags: [], createdOn: '2026-09-01' },
    { id: 'c-mei', firstName: 'Mei', lastName: 'Tanaka', email: 'm@x.com', links: {}, source: 'referral', sponsorship: 'no', tags: [], createdOn: '2026-09-01' },
  )
  db.jobs.push(mkJob('j-open'), mkJob('j-se', { familyId: 'f-solutions', departmentId: 'd-gtm' }))
  db.plan.push(
    mkSlot('ps-open', { jobId: 'j-open', status: 'open', budgetBase: 200_000 }),
    mkSlot('ps-planned', { targetStart: '2027-04-05', quarter: '2027-Q2' }),
    mkSlot('ps-cut', { status: 'cut', budgetBase: 300_000 }),
    mkSlot('ps-filled', { personId: 'p-lucas', status: 'filled', budgetBase: 190_000 }),
    mkSlot('ps-offer', { jobId: 'j-se', status: 'open', budgetBase: 170_000, familyId: 'f-solutions' }),
  )
  db.contractors.push(
    mkContractor('k-marisol'),
    mkContractor('k-northline', { rate: 6_500, rateUnit: 'month', hoursPerWeek: 8, entityType: 'llc' }),
    mkContractor('k-fieldnote', { rate: 38_000, rateUnit: 'project', startOn: '2025-11-01', endOn: '2026-02-28' }),
    mkContractor('k-adv', { kind: 'advisor', rate: 0, rateUnit: 'month', startOn: '2025-07-01' }),
  )
  return db
}

describe('comp records and bands', () => {
  it('picks the latest record on or before the date', () => {
    const db = richDB()
    expect(compHistory(db, 'p-ana').map((c) => c.salary)).toEqual([185_000, 212_000])
    expect(currentComp(db, 'p-ana', '2026-02-28')?.salary).toBe(185_000)
    expect(currentComp(db, 'p-ana', '2026-03-01')?.salary).toBe(212_000)
    expect(currentComp(db, 'p-ana', '2025-01-01')).toBeUndefined()
    expect(currentComp(db, 'p-lucas', D)).toBeUndefined()
  })

  it('annualizes hourly pay and restates part time at 40 hours', () => {
    const rec = { payType: 'hourly' as const, hourlyRate: 30 }
    expect(annualBase(rec, 24)).toBe(37_440)
    expect(fullTimeEquivalentBase(rec, 24)).toBe(62_400)
    expect(fullTimeEquivalentBase({ payType: 'salary', salary: 60_000 }, 20)).toBe(120_000)
    expect(hourlyRateOf({ payType: 'salary', salary: 156_000 }, 40)).toBe(75)
  })

  it('computes compa-ratio, band position and label', () => {
    const db = baseDB()
    const band = bandFor(db, 'f-eng', 'lv-l3')
    expect(band).toMatchObject({ min: 180_000, mid: 205_000, max: 230_000 })
    if (!band) return
    expect(compaRatio(205_000, band)).toBe(1)
    expect(bandPosition(180_000, band)).toBe(0)
    expect(bandPosition(230_000, band)).toBe(1)
    expect(bandLabel(170_000, band)).toBe('Below band')
    expect(bandLabel(185_000, band)).toBe('Low in band')
    expect(bandLabel(205_000, band)).toBe('Mid band')
    expect(bandLabel(225_000, band)).toBe('High in band')
    expect(bandLabel(240_000, band)).toBe('Above band')
  })
})

describe('employer taxes', () => {
  it('charges Social Security on wages up to the $184,500 base only', () => {
    const at = employerTaxes(184_500, { state: 'CA' })
    expect(at.ss).toBe(11_439)
    const above = employerTaxes(250_000, { state: 'CA' })
    expect(above.ss).toBe(11_439)
    expect(above.medicare).toBe(3_625)
    const below = employerTaxes(100_000, { state: 'CA' })
    expect(below.ss).toBe(6_200)
    expect(below.medicare).toBe(1_450)
  })

  it('uses California FUTA, UI and ETT on the first $7,000', () => {
    const t = employerTaxes(100_000, { state: 'CA' })
    expect(t.futa).toBe(147)
    expect(t.sui).toBe(238)
    expect(t.ett).toBe(7)
    expect(t.total).toBe(6_200 + 1_450 + 147 + 238 + 7)
    expect(employerTaxes(100_000, { state: 'CA', futa: 'no_waiver' }).futa).toBe(413)
    // Wages under the $7,000 base are taxed in full.
    expect(employerTaxes(5_000, { state: 'CA' }).sui).toBe(170)
  })

  it('estimates other states at 2.7% on $9,000 with base FUTA, and says so', () => {
    const t = employerTaxes(100_000, { state: 'TX' })
    expect(t.futa).toBe(42)
    expect(t.sui).toBe(243)
    expect(t.ett).toBe(0)
    expect(t.notes.join(' ')).toContain('TX is a generic estimate of 2.7% on the first $9,000')
    expect(t.notes.join(' ')).not.toMatch(/\u2014/)
  })

  it('takes rate overrides and says which assumptions changed', () => {
    const ca = employerTaxes(100_000, { state: 'CA', rates: { caUiRate: 0.05, futaEffectiveRate: 0.018 } })
    expect(ca.sui).toBe(350)
    expect(ca.futa).toBe(126)
    expect(ca.notes).toEqual([
      'FUTA uses 1.8% on the first $7,000, set in place of the 2026 California estimate.',
      'California UI uses 5% on the first $7,000 in place of the 3.4% new-employer rate.',
    ])
    const tx = employerTaxes(100_000, { state: 'TX', rates: { otherStateSuiRate: 0.01, otherStateSuiWageBase: 9_000 } })
    expect(tx.sui).toBe(90)
    expect(tx.notes[0]).toBe('State unemployment for TX uses 1% on the first $9,000, the rate set for states other than California.')
    // Missing or invalid values fall back to the 2026 constants.
    expect(employerTaxes(100_000, { state: 'CA', rates: { caUiRate: undefined, medicareRate: -1 } }).total).toBe(employerTaxes(100_000, { state: 'CA' }).total)
  })

  it('applies the stored FUTA scenario and rates, with explicit options winning', () => {
    const db = baseDB()
    db.company.costModel = { ...db.company.costModel, taxOverrides: { futaScenario: 'no_waiver', rates: { caUiRate: 0.05 } } }
    const stored = loadedCost(db, { base: 100_000, state: 'CA' })
    expect(stored.employerTaxes).toMatchObject({ futa: 413, sui: 350 })
    expect(loadedCost(db, { base: 100_000, state: 'CA', futa: 'waiver', rates: { caUiRate: 0.034 } }).employerTaxes).toMatchObject({ futa: 147, sui: 238 })
    // Run-rate and runway pass the scenario through: 413 - 147 = $266 a year more for the founder.
    const plain = baseDB()
    const waiver = runRate(plain, D, { include: 'now' })
    const noWaiver = runRate(plain, D, { include: 'now', futa: 'no_waiver' })
    expect(Math.round((noWaiver.lines[0].cost.totalAnnual - waiver.lines[0].cost.totalAnnual) * 100) / 100).toBe(266)
    plain.company.cashOnHand = 1_000_000
    expect(runway(plain, D, 'now', { futa: 'no_waiver' }).payrollMonthly).toBe(noWaiver.monthly)
  })
})

describe('loaded cost', () => {
  it('loads a $190K California engineer at about 1.18x', () => {
    const c = loadedCost(baseDB(), { base: 190_000, state: 'CA' })
    expect(c.employerTaxes.total).toBe(11_439 + 2_755 + 147 + 238 + 7)
    expect(c.benefits).toBe(13_800)
    expect(c.peoTools).toBe(4_500)
    expect(c.workersComp).toBe(570)
    expect(c.totalAnnual).toBe(223_456)
    expect(c.totalMonthly).toBeCloseTo(18_621.33, 2)
    expect(c.multiplier).toBeCloseTo(1.176, 3)
  })

  it('counts no benefits when Settings records no group health plan', () => {
    const db = baseDB()
    expect(benefitsBasis(db.company)).toBe('assumed')
    expect(loadedCost(db, { base: 0, state: 'CA' }).benefits).toBe(13_800)
    db.company.groupHealthPlanStartedOn = null
    expect(benefitsBasis(db.company)).toBe('none')
    const none = loadedCost(db, { base: 0, state: 'CA' })
    expect(none.benefits).toBe(0)
    // A founder with no salary: PEO and tools only, and no multiplier on a $0 base.
    expect(none).toMatchObject({ totalMonthly: 375, multiplier: 0 })
    expect(runRate(db, D).breakdown.benefits).toBe(0)
    db.company.groupHealthPlanStartedOn = '2026-01-01'
    expect(benefitsBasis(db.company)).toBe('plan')
    expect(loadedCost(db, { base: 0, state: 'CA' }).benefits).toBe(13_800)
  })

  it('taxes variable pay and can leave out benefits', () => {
    const c = loadedCost(baseDB(), { base: 140_000, variablePct: 1, state: 'TX', benefits: false })
    expect(c.variable).toBe(140_000)
    expect(c.wages).toBe(280_000)
    expect(c.employerTaxes.medicare).toBe(4_060)
    expect(c.benefits).toBe(0)
    expect(c.workersComp).toBe(840)
  })
})

describe('run-rate', () => {
  it('counts employed people now, skipping alumni and incoming hires', () => {
    const db = richDB()
    const rr = runRate(db, D, { include: 'now' })
    expect(rr.lines.map((l) => l.personId).sort()).toEqual(['p-ana', 'p-founder', 'p-luis', 'p-tex'])
    expect(rr.headcount).toBe(4)
    const expected =
      loadedCost(db, { base: 150_000, state: 'CA' }).totalMonthly +
      loadedCost(db, { base: 212_000, state: 'CA' }).totalMonthly +
      loadedCost(db, { base: 140_000, variablePct: 1, state: 'TX' }).totalMonthly +
      loadedCost(db, { base: 37_440, state: 'CA', benefits: false }).totalMonthly
    expect(rr.monthly).toBe(Math.round(expected))
    // Part time under 30 hours: no benefits, but tools still count.
    const luis = rr.lines.find((l) => l.personId === 'p-luis')
    expect(luis?.cost.benefits).toBe(0)
    expect(luis?.cost.peoTools).toBe(4_500)
    expect(rr.byDepartment.reduce((t, d) => t + d.headcount, 0)).toBe(4)
    expect(Math.abs(rr.byDepartment.reduce((t, d) => t + d.monthly, 0) - rr.monthly)).toBeLessThanOrEqual(2)
  })

  it('adds incoming hires, then offers out (latest version only), then remaining plan slots', () => {
    const db = richDB()
    const incoming = runRate(db, D, { include: 'with_incoming' })
    expect(incoming.headcount).toBe(6)
    expect(incoming.lines.filter((l) => l.kind === 'incoming').map((l) => l.name).sort()).toEqual(['Lucas Test', 'Mei Tanaka'])

    const offers = runRate(db, D, { include: 'with_offers' })
    expect(offers.headcount).toBe(7)
    const dan = offers.lines.filter((l) => l.kind === 'offer')
    expect(dan).toHaveLength(1)
    expect(dan[0].offerId).toBe('o-dan-v2')
    expect(dan[0].cost.variable).toBe(24_750)

    const plan = runRate(db, D, { include: 'at_plan' })
    // Open and planned slots only: the cut slot, the filled slot and the slot with an offer out are not added.
    expect(plan.lines.filter((l) => l.kind === 'plan').map((l) => l.slotId).sort()).toEqual(['ps-open', 'ps-planned'])
    const planned = plan.lines.find((l) => l.slotId === 'ps-planned')
    expect(planned?.base).toBe(205_000)
    expect(plan.monthly).toBeGreaterThan(offers.monthly)
    expect(plan.people.map((p) => p.personId)).toContain('p-lucas')
  })

  it('keeps contractors separate: hourly x hours x 4.33, monthly, and project fees spread over the contract', () => {
    const db = richDB()
    const rr = runRate(db, D, { include: 'now' })
    expect(rr.contractors.map((c) => c.contractorId).sort()).toEqual(['k-marisol', 'k-northline'])
    expect(rr.contractorsMonthly).toBe(Math.round(85 * 25 * 4.33 + 6_500))
    expect(contractorMonthly(mkContractor('k-p', { rate: 38_000, rateUnit: 'project', startOn: '2025-11-01', endOn: '2026-02-28' })).monthly).toBeCloseTo(
      38_000 / (120 / 30.4375),
      1,
    )
    expect(contractorMonthly(mkContractor('k-h', { hoursPerWeek: undefined })).note).toContain('No weekly hours')
  })

  it('finds outstanding offers once per application', () => {
    expect(outstandingOffers(richDB()).map((o) => o.id)).toEqual(['o-dan-v2'])
  })

  it('leaves out sent offers past their expiry date and counts their slot as open again', () => {
    const db = richDB()
    db.offers = db.offers.map((o) => (o.id === 'o-dan-v2' ? { ...o, expiresOn: '2026-10-01' } : o))
    expect(outstandingOffers(db).map((o) => o.id)).toEqual(['o-dan-v2'])
    expect(outstandingOffers(db, D)).toEqual([])
    expect(runRate(db, D, { include: 'with_offers' }).headcount).toBe(6)
    // The slot still shows an offer until hiring marks it expired, but its cost is not lost at plan.
    const plan = runRate(db, D, { include: 'at_plan' })
    expect(plan.lines.filter((l) => l.kind === 'plan').map((l) => l.slotId).sort()).toEqual(['ps-offer', 'ps-open', 'ps-planned'])
  })

  it('leaves out employees with a known last day in every forward scenario, but not now', () => {
    const db = richDB()
    // Ana leaves at the end of the month; Tex's separation is recorded with no end date set yet.
    const ana = db.people.find((p) => p.id === 'p-ana') as Person
    ana.endDate = '2026-10-30'
    const tex = db.people.find((p) => p.id === 'p-tex') as Person
    tex.separation = { type: 'resigned_notice', reason: 'Test', lastDay: '2026-11-13' }
    const ids = (include: 'now' | 'with_incoming' | 'with_offers' | 'at_plan') => runRate(db, D, { include }).lines.map((l) => l.personId ?? l.offerId ?? l.slotId)
    expect(ids('now')).toEqual(expect.arrayContaining(['p-ana', 'p-tex']))
    for (const s of ['with_incoming', 'with_offers', 'at_plan'] as const) {
      expect(ids(s)).not.toContain('p-ana')
      expect(ids(s)).not.toContain('p-tex')
    }
    // So each step adds up: 4 now, 2 leave and 2 join, then 1 offer, then 2 plan lines.
    expect(runRate(db, D, { include: 'now' }).headcount).toBe(4)
    expect(runRate(db, D, { include: 'with_incoming' }).headcount).toBe(4)
    expect(runRate(db, D, { include: 'with_offers' }).headcount).toBe(5)
    expect(runRate(db, D, { include: 'at_plan' }).headcount).toBe(7)
  })

  it('leaves out employees with a known end date at plan, matching the plan projection', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-leaver', { startDate: '2026-01-05', endDate: '2026-12-15' }))
    db.comp.push(mkComp('p-leaver', '2026-01-05', 200_000))
    db.plan.push(mkSlot('ps-backfill', { title: 'Backfill', targetStart: '2026-12-16' }))
    expect(runRate(db, D, { include: 'now' }).headcount).toBe(2)
    const atPlan = runRate(db, D, { include: 'at_plan' })
    expect(atPlan.lines.map((l) => l.name)).toEqual(['Maya Raman', 'Backfill'])
    expect(atPlan.headcount).toBe(headcountProjection(db, D).final)
  })
})

describe('runway', () => {
  it('divides cash by payroll plus other spend plus contractors minus revenue', () => {
    const db = baseDB()
    // Founder alone at $150K in CA costs $15,051 a month fully loaded.
    expect(runRate(db, D).monthly).toBe(15_051)
    db.company.cashOnHand = 2_700_000
    db.company.cashAsOf = '2026-10-01'
    db.company.otherMonthlySpend = 94_949
    db.company.monthlyRevenue = 10_000
    const r = runway(db, D)
    expect(r.netBurnMonthly).toBe(100_000)
    // 8 days of burn since Oct 1 are spent first: $2.7M - $100K x 8 / 30.4375.
    expect(r.cashNow).toBe(2_673_717)
    expect(r.months).toBeCloseTo(26.737, 3)
    expect(r.text).toBe("About 27 months of runway at today's burn.")
    // The same run-out date as 27 months (821 days) after the cash-as-of date: 813 days after Oct 9.
    expect(r.runsOutOn).toBe('2028-12-30')
  })

  it('spends the burn since an old cash figure and says how old it is', () => {
    const db = baseDB()
    db.company.otherMonthlySpend = 94_949
    db.company.monthlyRevenue = 10_000
    db.company.cashOnHand = 1_000_000
    db.company.cashAsOf = '2026-01-01'
    // 281 days at $100K a month leaves about $76,800 on Oct 9, under a month.
    const r = runway(db, D)
    expect(r.cashNow).toBe(76_797)
    expect(r.months).toBeCloseTo(0.768, 3)
    expect(r.text).toBe("About 0.8 months of runway at today's burn (cash as of Jan 1, 2026).")
    expect(r.runsOutOn).toBe('2026-11-01')
    // A figure already spent says when it ran out.
    db.company.cashOnHand = 500_000
    const gone = runway(db, D)
    expect(gone).toMatchObject({ months: 0, runsOutOn: '2026-06-02' })
    expect(gone.text).toBe('At this burn, the cash on hand from Jan 1, 2026 would have run out by Jun 2, 2026. Update cash on hand in Settings.')
    expect(peopleCostSummary(db, D).text).toContain('would have run out by Jun 2, 2026')
  })

  it('spends the time since the cash date at the current burn in every scenario', () => {
    const db = richDB()
    db.company.cashOnHand = 5_000_000
    db.company.cashAsOf = '2026-07-01'
    db.company.otherMonthlySpend = 50_000
    const now = runway(db, D, 'now')
    const atPlan = runway(db, D, 'at_plan')
    expect(atPlan.cashNow).toBe(now.cashNow)
    expect(atPlan.netBurnMonthly).toBeGreaterThan(now.netBurnMonthly)
    expect(atPlan.months).toBeCloseTo((now.cashNow ?? 0) / (atPlan.payrollMonthly + 50_000 + atPlan.contractorsMonthly), 1)
    expect(now.text).toContain('(cash as of Jul 1, 2026)')
    expect(peopleCostSummary(db, D).text).toMatch(/at plan \(cash as of Jul 1, 2026\)\.$/)
  })

  it('includes contractors and plan hires in the at-plan scenario', () => {
    const db = richDB()
    db.company.cashOnHand = 5_000_000
    db.company.otherMonthlySpend = 50_000
    const now = runway(db, D, 'now')
    const atPlan = runway(db, D, 'at_plan')
    expect(now.netBurnMonthly).toBe(now.payrollMonthly + 50_000 + now.contractorsMonthly)
    expect(atPlan.months ?? 0).toBeLessThan(now.months ?? 0)
    expect(atPlan.text).toContain('if the plan hires on schedule')
  })

  it('spends the provider totals for paydays since the cash date instead of the estimate (pay run prep)', () => {
    const db = baseDB()
    db.company.cashOnHand = 1_000_000
    db.company.cashAsOf = '2026-09-01'
    db.company.otherMonthlySpend = 40_000
    const plain = runway(db, D)
    expect(plain.actuals).toBeUndefined()
    const totals = (gross: number, employerTaxes: number) => ({ gross, employerTaxes, enteredOn: '2026-10-02' })
    db.company.payRuns = [
      // Before the window (cash on hand already counts it), on the cash date itself, and after today: left out.
      { periodStart: '2026-08-16', periodEnd: '2026-08-31', payday: '2026-08-31', submittedOn: '2026-08-27', totals: totals(9_000, 900) },
      { periodStart: '2026-08-17', periodEnd: '2026-08-31', payday: '2026-09-01', submittedOn: '2026-08-28', totals: totals(9_000, 900) },
      { periodStart: '2026-09-01', periodEnd: '2026-09-15', payday: '2026-09-15', submittedOn: '2026-09-11', totals: totals(6_250, 600) },
      { periodStart: '2026-09-16', periodEnd: '2026-09-30', payday: '2026-09-30', submittedOn: '2026-09-28', totals: totals(6_250, 480) },
      // Submitted without totals: still an estimate.
      { periodStart: '2026-10-01', periodEnd: '2026-10-15', payday: '2026-10-08', submittedOn: '2026-10-06' },
      { periodStart: '2026-10-16', periodEnd: '2026-10-31', payday: '2026-10-30', submittedOn: '2026-10-09', totals: totals(9_000, 900) },
    ]
    const r = runway(db, D)
    // The founder's $150,000 plus $11,867 of employer taxes is $6,744.46 a semi-monthly period.
    expect(r.actuals).toEqual({ paydays: 2, actual: 13_580, estimated: 13_488.92, difference: 91.08 })
    expect((plain.cashNow ?? 0) - (r.cashNow ?? 0)).toBeGreaterThanOrEqual(91)
    expect((plain.cashNow ?? 0) - (r.cashNow ?? 0)).toBeLessThanOrEqual(92)
    // Future months stay estimates: the burn is the same.
    expect(r.netBurnMonthly).toBe(plain.netBurnMonthly)
    expect(payrollActualsBetween(db, '2026-09-30', D, runRate(db, D))).toBeNull()
    expect(payPeriodsPerYear('biweekly')).toBe(26)
    expect(payPeriodsPerYear('monthly')).toBe(12)
  })

  it('lists every payday with provider totals against the estimate, and how each counts in runway', () => {
    const db = baseDB()
    db.company.cashOnHand = 1_000_000
    db.company.cashAsOf = '2026-09-20'
    const totals = (gross: number, employerTaxes: number) => ({ gross, employerTaxes, enteredOn: '2026-10-02' })
    db.company.payRuns = [
      { periodStart: '2026-09-01', periodEnd: '2026-09-15', payday: '2026-09-15', submittedOn: '2026-09-11', totals: totals(6_250, 600) },
      { periodStart: '2026-09-16', periodEnd: '2026-09-30', payday: '2026-09-30', submittedOn: '2026-09-28', totals: totals(6_250, 480) },
      { periodStart: '2026-10-01', periodEnd: '2026-10-15', payday: '2026-10-15', submittedOn: '2026-10-09' },
      { periodStart: '2026-10-16', periodEnd: '2026-10-31', payday: '2026-10-30', submittedOn: '2026-10-09', totals: totals(6_300, 500) },
    ]
    const rows = payrollActualsHistory(db, D, runRate(db, D))
    // Newest payday first; the one without totals is left out. $6,744.46 a period is the founder's wages and taxes.
    expect(rows.map((r) => [r.periodStart, r.actual, r.estimated, r.difference, r.use])).toEqual([
      ['2026-10-16', 6800, 6744.46, 55.54, 'upcoming'],
      ['2026-09-16', 6730, 6744.46, -14.46, 'runway'],
      ['2026-09-01', 6850, 6744.46, 105.54, 'in_cash'],
    ])
    // The rows runway spends are exactly the ones payrollActualsBetween finds.
    expect(runway(db, D).actuals).toMatchObject({ paydays: 1, actual: 6730, difference: -14.46 })
    // With no cash-as-of date, cash counts as today's: every past payday is already in it.
    delete db.company.cashAsOf
    expect(payrollActualsHistory(db, D, runRate(db, D)).map((r) => r.use)).toEqual(['upcoming', 'in_cash', 'in_cash'])
  })

  it('handles unknown cash and revenue that covers spend', () => {
    const db = baseDB()
    expect(runway(db, D).months).toBeNull()
    expect(runway(db, D).text).toContain('Add cash on hand')
    db.company.cashOnHand = 1_000_000
    db.company.monthlyRevenue = 500_000
    expect(runway(db, D).months).toBe(Infinity)
  })

  it('says more than 5 years instead of hundreds of months', () => {
    // An unpaid founder, $18K a month of other spend and $15K of revenue: hundreds of months on $2.3M.
    const db = baseDB()
    db.comp[0].salary = 0
    db.company.cashOnHand = 2_300_000
    db.company.otherMonthlySpend = 18_000
    db.company.monthlyRevenue = 15_000
    const r = runway(db, D)
    expect(r.months).toBeGreaterThan(300)
    expect(r.text).toBe("More than 5 years of runway at today's burn.")
    expect(runway(db, D, 'at_plan').text).toBe('More than 5 years of runway if the plan hires on schedule.')
    expect(peopleCostSummary(db, D).text).toMatch(/ Runway more than 5 years at today's burn\.$/)
    expect(runwayMonthsLabel(r.months ?? 0)).toBe('More than 5 years')
    // Up to the cap the months show; under 2 months, to a tenth.
    expect(runwayMonthsLabel(RUNWAY_CAP_MONTHS)).toBe('60 months')
    expect(runwayMonthsLabel(26.737)).toBe('27 months')
    expect(runwayMonthsLabel(0.768)).toBe('0.8 months')
    expect(runwayMonthsLabel(Infinity)).toBe('Not shrinking')
  })
})

describe('offers, exempt checks and band exceptions', () => {
  it('states an offer monthly impact rounded to $100', () => {
    const r = offerMonthlyImpact(baseDB(), mkOffer('o-x', { salary: 190_000 }))
    expect(r.monthly).toBeCloseTo(18_621.33, 2)
    expect(r.text).toBe('This offer adds $18,600 a month fully loaded.')
  })

  it('checks the California exempt salary floor and the computer professional minimum', () => {
    const law = baseDB().settings.law
    expect(exemptCheck(law, { payType: 'salary', salary: 65_000, exemptionBasis: 'administrative', state: 'CA' })?.kind).toBe('salary_floor')
    expect(exemptCheck(law, { payType: 'salary', salary: 70_304, exemptionBasis: 'administrative', state: 'CA' })).toBeNull()
    expect(exemptCheck(law, { payType: 'salary', salary: 110_000, exemptionBasis: 'computer_professional' })?.kind).toBe('computer_professional')
    // The annual minimum is $122,573.13: a $122,573 salary fails, and the text shows the cents so it never reads "$122,573 is below $122,573".
    expect(exemptCheck(law, { payType: 'salary', salary: 122_573, exemptionBasis: 'computer_professional' })?.text).toContain('minimum of $122,573.13 a year')
    expect(exemptCheck(law, { payType: 'salary', salary: 122_574, exemptionBasis: 'computer_professional' })).toBeNull()
    expect(exemptCheck(law, { payType: 'hourly', hourlyRate: 60, exemptionBasis: 'computer_professional' })).toBeNull()
    expect(exemptCheck(law, { payType: 'hourly', hourlyRate: 58, exemptionBasis: 'computer_professional' })?.text).toContain('$58.85')
    expect(exemptCheck(law, { payType: 'hourly', hourlyRate: 90, exemptionBasis: 'professional' })?.kind).toBe('hourly_exempt')
    expect(exemptCheck(law, { payType: 'salary', salary: 50_000, exemptionBasis: 'outside_sales', state: 'CA' })).toBeNull()
    expect(exemptCheck(law, { payType: 'salary', salary: 50_000, exemptionBasis: 'administrative', state: 'TX' })).toBeNull()
  })

  it('flags exempt employees below the minimum and skips non-exempt ones', () => {
    const db = richDB()
    db.people.push(mkPerson('p-low', { exemptionBasis: 'administrative', familyId: 'f-ops', levelId: 'lv-l1' }))
    db.comp.push(mkComp('p-low', '2026-01-05', 65_000, { levelId: 'lv-l1' }))
    const flags = exemptFlags(db, D)
    expect(flags.map((f) => f.personId)).toEqual(['p-low'])
    expect(flags[0].text).toContain('$70,304')
  })

  it('lists people outside their band with the exception reason, comparing part time at full time', () => {
    const db = richDB()
    db.people.push(mkPerson('p-found', { startDate: '2025-06-09' }))
    db.comp.push(
      mkComp('p-found', '2025-06-09', 170_000, { exceptionReason: 'Founding, equity-heavy' }),
      // A title change leaves pay alone, so changeJobOrPay carries the reason forward onto the new row.
      mkComp('p-found', '2026-03-01', 170_000, { reason: 'title_only', title: 'Founding engineer', exceptionReason: 'Founding, equity-heavy' }),
    )
    const rows = outOfBand(db, D)
    const found = rows.find((r) => r.personId === 'p-found')
    expect(found).toMatchObject({ direction: 'below', gap: 10_000, exceptionReason: 'Founding, equity-heavy' })
    // Luis earns $30 an hour at 24 hours: $62,400 at full time, inside the $60K-$80K band.
    expect(rows.find((r) => r.personId === 'p-luis')).toBeUndefined()
    const table = compTable(db, D)
    expect(table.find((r) => r.personId === 'p-luis')).toMatchObject({ base: 37_440, fteBase: 62_400, hoursPerWeek: 24, bandLabel: 'Low in band' })
    expect(table.find((r) => r.personId === 'p-ana')?.hoursPerWeek).toBe(40)
    expect(table.find((r) => r.personId === 'p-lucas')?.incoming).toBe(true)
  })

  it('drops an exception reason once pay has been inside the band', () => {
    const db = richDB()
    db.people.push(mkPerson('p-x', { startDate: '2025-06-09' }))
    db.comp.push(
      mkComp('p-x', '2025-06-09', 150_000, { exceptionReason: 'Founding, equity-heavy' }),
      mkComp('p-x', '2026-03-01', 205_000, { reason: 'market' }),
    )
    expect(compTable(db, D).find((r) => r.personId === 'p-x')).toMatchObject({ bandLabel: 'Mid band' })
    expect(compTable(db, D).find((r) => r.personId === 'p-x')?.exceptionReason).toBeUndefined()
    expect(outOfBand(db, D).find((r) => r.personId === 'p-x')).toBeUndefined()
    // A promotion to L4 at the same pay is below the L4 band for a new reason, so the old one does not come back.
    db.comp.push(mkComp('p-x', '2026-09-01', 205_000, { reason: 'promotion', levelId: 'lv-l4' }))
    const row = outOfBand(db, D).find((r) => r.personId === 'p-x')
    expect(row).toMatchObject({ direction: 'below', gap: 5_000 })
    expect(row?.exceptionReason).toBeUndefined()
    expect(compTable(db, D).find((r) => r.personId === 'p-x')).toMatchObject({ bandLabel: 'Below band' })
    expect(compTable(db, D).find((r) => r.personId === 'p-x')?.exceptionReason).toBeUndefined()
  })

  it('explains out-of-band pay only with the reason on the record in force', () => {
    const db = richDB()
    // Hired below band with a reason, then a market adjustment into the band with none.
    db.people.push(mkPerson('p-kofi', { startDate: '2025-10-06' }))
    db.comp.push(
      mkComp('p-kofi', '2025-10-06', 178_000, { exceptionReason: 'Pre-seed offer: below band, equity-heavy' }),
      mkComp('p-kofi', '2026-03-01', 192_000, { reason: 'market' }),
    )
    expect(outOfBand(db, D).find((r) => r.personId === 'p-kofi')).toBeUndefined()
    // Editing the band to $195K-$245K puts him below it: the hire-time reason does not explain that.
    const band = db.bands.find((b) => b.familyId === 'f-eng' && b.levelId === 'lv-l3')
    if (band) Object.assign(band, { min: 195_000, mid: 220_000, max: 245_000 })
    const row = outOfBand(db, D).find((r) => r.personId === 'p-kofi')
    expect(row).toMatchObject({ direction: 'below', gap: 3_000 })
    expect(row?.exceptionReason).toBeUndefined()
    expect(compTable(db, D).find((r) => r.personId === 'p-kofi')).toMatchObject({ bandLabel: 'Below band' })
    expect(compTable(db, D).find((r) => r.personId === 'p-kofi')?.exceptionReason).toBeUndefined()
    // A pay change below band with no reason recorded does not inherit the older one either.
    db.people.push(mkPerson('p-mo', { startDate: '2025-06-09' }))
    db.comp.push(
      mkComp('p-mo', '2025-06-09', 150_000, { exceptionReason: 'Founding, equity-heavy' }),
      mkComp('p-mo', '2026-03-01', 170_000, { reason: 'market' }),
    )
    expect(outOfBand(db, D).find((r) => r.personId === 'p-mo')?.exceptionReason).toBeUndefined()
    // An incoming hire's first record still explains their offer.
    db.people.push(mkPerson('p-new', { startDate: '2026-11-02' }))
    db.comp.push(mkComp('p-new', '2026-11-02', 185_000, { exceptionReason: 'Market data for this role' }))
    expect(outOfBand(db, D).find((r) => r.personId === 'p-new')?.exceptionReason).toBe('Market data for this role')
  })

  it('leaves rows dated after the last day out of the history', () => {
    const db = richDB()
    // Ana is let go today, after a promotion was scheduled for Nov 1.
    db.comp.push(mkComp('p-ana', '2026-11-01', 215_000, { reason: 'promotion', levelId: 'lv-l4', scheduled: true }))
    const ana = db.people.find((p) => p.id === 'p-ana') as Person
    expect(compHistoryByLastDay(db, ana)).toMatchObject({ afterLastDay: [] })
    expect(compHistoryByLastDay(db, ana).history).toHaveLength(3)
    ana.separation = { type: 'terminated', reason: 'Test', lastDay: D }
    expect(lastDayOf(ana)).toBe(D)
    const split = compHistoryByLastDay(db, ana)
    expect(split.lastDay).toBe(D)
    expect(split.history.map((r) => r.effectiveOn)).toEqual(['2025-05-12', '2026-03-01'])
    expect(split.afterLastDay.map((r) => r.salary)).toEqual([215_000])
    ana.endDate = '2026-11-01'
    // A last day on the effective date: the change takes effect that day.
    expect(compHistoryByLastDay(db, ana).afterLastDay).toEqual([])
  })
})

describe('plan slot status and the home summary', () => {
  it('rolls slot status up from job, offer and person', () => {
    const db = richDB()
    const status = (id: string) => planSlotStatus(db, db.plan.find((s) => s.id === id) as PlanSlot)
    expect(status('ps-open')).toBe('open')
    expect(status('ps-planned')).toBe('planned')
    expect(status('ps-cut')).toBe('cut')
    expect(status('ps-filled')).toBe('filled')
    expect(status('ps-offer')).toBe('offer')
  })

  it('writes the people cost line', () => {
    const db = richDB()
    db.company.cashOnHand = 9_400_000
    db.company.otherMonthlySpend = 110_000
    const s = peopleCostSummary(db, D)
    expect(s.addedNames).toEqual(['Lucas', 'Mei', 'Danielle'])
    expect(s.text).toMatch(/^Run-rate \$[\d.]+K a month fully loaded, \$[\d.]+K with Lucas, Mei and Danielle, about \$[\d.]+K at plan\./)
    expect(s.text).toMatch(/Contractors \$15\.7K a month\. Runway about \d+ months at today's burn, about \d+ at plan\.$/)
    expect(s.text).not.toMatch(/\u2014/)
    // Past 5 years today, the line says so and still gives the months at plan.
    db.company.cashOnHand = 13_400_000
    expect(peopleCostSummary(db, D).text).toMatch(/Runway more than 5 years at today's burn, about \d+ at plan\.$/)
  })

  it("gives each held plan line its own person's offer when one job hires twice", () => {
    const db = baseDB()
    db.jobs.push(mkJob('j-fs'))
    db.candidates.push(
      { id: 'c-marcus', firstName: 'Marcus', lastName: 'Webb', email: 'mw@x.com', links: {}, source: 'outbound', sponsorship: 'no', tags: [], createdOn: '2026-09-01' },
      { id: 'c-pri', firstName: 'Priyanka', lastName: 'Desai', email: 'pd@x.com', links: {}, source: 'inbound', sponsorship: 'no', tags: [], createdOn: '2026-09-01' },
    )
    db.people.push(
      mkPerson('p-marcus', { startDate: '2026-10-26', fromCandidateId: 'c-marcus' }),
      mkPerson('p-pri', { startDate: '2026-10-30', fromCandidateId: 'c-pri' }),
      mkPerson('p-direct', { startDate: '2026-10-19' }),
    )
    db.offers.push(
      mkOffer('o-marcus', { candidateId: 'c-marcus', jobId: 'j-fs', status: 'accepted', salary: 220_000, personId: 'p-marcus', createdOn: '2026-09-20' }),
      // Linked to the hire through the candidate only.
      mkOffer('o-pri', { candidateId: 'c-pri', jobId: 'j-fs', status: 'accepted', salary: 205_000, createdOn: '2026-09-28' }),
      mkOffer('o-next', { candidateId: 'c-next', jobId: 'j-fs', status: 'sent', salary: 210_000 }),
    )
    db.plan.push(
      mkSlot('ps-marcus', { jobId: 'j-fs', personId: 'p-marcus', status: 'filled' }),
      mkSlot('ps-pri', { jobId: 'j-fs', personId: 'p-pri', status: 'filled' }),
      mkSlot('ps-direct', { jobId: 'j-fs', personId: 'p-direct', status: 'filled' }),
      mkSlot('ps-seat', { jobId: 'j-fs', status: 'open' }),
    )
    const slot = (id: string) => db.plan.find((s) => s.id === id) as PlanSlot
    expect(slotOffer(db, slot('ps-marcus'))?.id).toBe('o-marcus')
    expect(slotOffer(db, slot('ps-pri'))?.id).toBe('o-pri')
    // Added without an offer: none, so the plan reads the hire record instead.
    expect(slotOffer(db, slot('ps-direct'))).toBeUndefined()
    expect(slotPerson(db, slot('ps-direct'))?.id).toBe('p-direct')
    // The open seat skips the accepted offers the other lines' people were hired from.
    expect(slotOffer(db, slot('ps-seat'))?.id).toBe('o-next')
    expect(slotPerson(db, slot('ps-seat'))).toBeUndefined()
    expect(planSlotStatus(db, slot('ps-seat'))).toBe('offer')
    // An accepted offer nobody was hired from yet fills the open seat.
    db.offers.push(mkOffer('o-kim', { candidateId: 'c-kim', jobId: 'j-fs', status: 'accepted', salary: 200_000 }))
    expect(slotOffer(db, slot('ps-seat'))?.id).toBe('o-kim')
    expect(planSlotStatus(db, slot('ps-seat'))).toBe('filled')
  })
})
