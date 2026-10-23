import { describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import { loadedCost, runRate } from '@/domain/pay'
import { budgetVariance, headcountProjection, jobHasPlanLine, planCost, planRollup, planSlotForHire, planStatusCounts, planSummary, slotStatus } from '@/domain/plan'
import type { CompRecord, DB, Job, Offer, Person, PlanSlot } from '@/domain/types'

const D = '2026-10-09'

function mkPerson(id: string, firstName: string, startDate: string, over: Partial<Person> = {}): Person {
  return {
    id,
    firstName,
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
    startDate,
    hireNumber: 2,
    emergencyContacts: [],
    ...over,
  }
}

function mkComp(personId: string, effectiveOn: string, salary: number): CompRecord {
  return { id: `cr-${personId}`, personId, effectiveOn, payType: 'salary', salary, title: 'Engineer', levelId: 'lv-l3', reason: 'hire' }
}

function mkJob(id: string, status: Job['status']): Job {
  return {
    id,
    title: id,
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
    status,
    stages: [],
    interviewPlan: [],
    description: '',
    sponsorship: 'no',
    backgroundCheck: true,
    priority: 'normal',
  }
}

function mkOffer(id: string, candidateId: string, jobId: string, status: Offer['status'], salary: number, startDate: string): Offer {
  return {
    id,
    applicationId: `a-${id}`,
    candidateId,
    jobId,
    version: 1,
    title: 'Engineer',
    levelId: 'lv-l3',
    familyId: 'f-eng',
    departmentId: 'd-eng',
    managerId: 'p-founder',
    locationId: 'loc-hq',
    workMode: 'hybrid',
    employmentType: 'full_time',
    flsa: 'exempt',
    payType: 'salary',
    salary,
    equityType: 'ISO',
    equityShares: 30_000,
    vestingMonths: 48,
    cliffMonths: 12,
    startDate,
    expiresOn: '2026-10-14',
    contingencies: [],
    status,
    createdOn: '2026-10-01',
    approvals: [],
  }
}

function mkSlot(id: string, over: Partial<PlanSlot>): PlanSlot {
  return {
    id,
    quarter: '2026-Q4',
    title: id,
    departmentId: 'd-eng',
    familyId: 'f-eng',
    levelId: 'lv-l3',
    targetStart: '2026-12-07',
    status: 'planned',
    ...over,
  }
}

function planDB(): DB {
  const db = blankDB({ companyName: 'Testco', founderFirstName: 'Maya', founderLastName: 'Raman', foundedOn: '2025-02-03' })
  db.people.push(
    mkPerson('p-a', 'Ana', '2025-05-12'),
    mkPerson('p-b', 'Ben', '2025-06-09'),
    mkPerson('p-left', 'Lou', '2025-08-18', { endDate: '2026-08-28' }),
    mkPerson('p-leaving', 'Leah', '2025-09-01', { endDate: '2026-11-20' }),
    mkPerson('p-in', 'Ivan', '2026-10-19'),
  )
  db.comp.push(mkComp('p-founder', '2025-02-03', 150_000), mkComp('p-a', '2025-05-12', 200_000), mkComp('p-b', '2025-06-09', 190_000), mkComp('p-in', '2026-10-19', 195_000))
  db.candidates.push(
    { id: 'c-dan', firstName: 'Daniel', lastName: 'Reyes', email: 'd@x.com', links: {}, source: 'outbound', sponsorship: 'no', tags: [], createdOn: '2026-09-01' },
    { id: 'c-mei', firstName: 'Mei', lastName: 'Tanaka', email: 'm@x.com', links: {}, source: 'referral', sponsorship: 'no', tags: [], createdOn: '2026-09-01' },
  )
  db.jobs.push(mkJob('j-open', 'open'), mkJob('j-offer', 'open'), mkJob('j-draft', 'draft'), mkJob('j-acc', 'open'), mkJob('j-closed', 'closed'))
  db.offers.push(
    mkOffer('o-dan', 'c-dan', 'j-offer', 'awaiting_approval', 262_000, '2027-01-11'),
    mkOffer('o-mei', 'c-mei', 'j-acc', 'accepted', 228_000, '2026-11-02'),
  )
  db.plan.push(
    mkSlot('ps-filled', { personId: 'p-in', status: 'filled', budgetBase: 190_000, targetStart: '2026-10-19' }),
    mkSlot('ps-open', { jobId: 'j-open', status: 'open', budgetBase: 200_000 }),
    mkSlot('ps-offer', { jobId: 'j-offer', status: 'open', budgetBase: 250_000, targetStart: '2027-01-04', quarter: '2027-Q1' }),
    mkSlot('ps-planned', { targetStart: '2027-04-05', quarter: '2027-Q2' }),
    mkSlot('ps-draft', { jobId: 'j-draft', status: 'open', budgetBase: 180_000, targetStart: '2027-05-03', quarter: '2027-Q2' }),
    mkSlot('ps-cut', { status: 'cut', budgetBase: 300_000 }),
    mkSlot('ps-acc', { jobId: 'j-acc', status: 'open', budgetBase: 220_000, targetStart: '2026-11-02' }),
    mkSlot('ps-closed', { jobId: 'j-closed', status: 'open', budgetBase: 175_000 }),
  )
  return db
}

describe('plan roll-up', () => {
  it('derives each slot status from its job, offer and person', () => {
    const db = planDB()
    const rows = planRollup(db)
    const status = Object.fromEntries(rows.map((r) => [r.slot.id, r.status]))
    expect(status).toEqual({
      'ps-filled': 'filled',
      'ps-open': 'open',
      'ps-acc': 'filled',
      'ps-cut': 'cut',
      'ps-closed': 'cut',
      'ps-offer': 'offer',
      'ps-planned': 'planned',
      'ps-draft': 'planned',
    })
    expect(rows.map((r) => r.slot.quarter)).toEqual([...rows.map((r) => r.slot.quarter)].sort())
    const planned = rows.find((r) => r.slot.id === 'ps-planned')
    expect(planned).toMatchObject({ budgetBase: 205_000, budgetFromBand: true })
    expect(planned?.loaded?.totalAnnual).toBe(loadedCost(db, { base: 205_000, state: 'CA' }).totalAnnual)
    expect(rows.find((r) => r.slot.id === 'ps-filled')?.person?.id).toBe('p-in')
    expect(rows.find((r) => r.slot.id === 'ps-offer')?.offer?.id).toBe('o-dan')
    expect(slotStatus(db, db.plan[0])).toBe('filled')
    expect(planStatusCounts(db)).toEqual({ planned: 2, open: 1, offer: 1, filled: 2, cut: 2 })
  })
})

describe('headcount projection', () => {
  it('steps actual headcount to today and plans forward with hires, offers, slots and departures', () => {
    const p = headcountProjection(planDB(), D)
    expect(p.current).toBe(4)
    expect(p.actual).toEqual([
      { date: '2025-02-03', value: 1 },
      { date: '2025-05-12', value: 2 },
      { date: '2025-06-09', value: 3 },
      { date: '2025-08-18', value: 4 },
      { date: '2025-09-01', value: 5 },
      { date: '2026-08-29', value: 4 },
      { date: D, value: 4 },
    ])
    expect(p.plan).toEqual([
      { date: D, value: 4 },
      { date: '2026-10-19', value: 5, label: 'Ivan Test' },
      { date: '2026-11-02', value: 6, label: 'Mei Tanaka' },
      { date: '2026-11-21', value: 5, label: 'Leah Test leaves' },
      { date: '2026-12-07', value: 6, label: 'ps-open' },
      { date: '2027-01-11', value: 7, label: 'ps-offer' },
      { date: '2027-04-05', value: 8, label: 'ps-planned' },
      { date: '2027-05-03', value: 9, label: 'ps-draft' },
    ])
    expect(p.targets).toEqual([
      { quarter: '2026-Q4', date: '2026-12-31', value: 6 },
      { quarter: '2027-Q1', date: '2027-03-31', value: 7 },
      { quarter: '2027-Q2', date: '2027-06-30', value: 9 },
    ])
    expect(p.final).toBe(9)
  })

  it('writes the plan summary line', () => {
    expect(planSummary(planDB(), D)).toBe('Plan: 6 by Dec 31, 7 by Mar 31, 9 by Jun 30, 2027')
  })

  it('places overdue slots on today and handles no plan', () => {
    const db = blankDB({ companyName: 'Solo', founderFirstName: 'Maya', founderLastName: 'Raman', foundedOn: '2025-02-03' })
    expect(planSummary(db, D)).toBe('No headcount plan yet.')
    db.plan.push(mkSlot('ps-late', { status: 'open', targetStart: '2026-09-01', quarter: '2026-Q3' }))
    const p = headcountProjection(db, D)
    expect(p.plan).toEqual([{ date: D, value: 2, label: 'ps-late' }])
    expect(planSummary(db, D)).toBe('Plan: 2 by Dec 31, 2026')
    expect(planCost(db, D).rows[0].quarter).toBe('2026-Q4')
  })
})

describe('budget variance and plan cost', () => {
  it('compares budgeted base with the offer or the hire base', () => {
    const { rows, totals } = budgetVariance(planDB())
    const byId = Object.fromEntries(rows.map((r) => [r.slotId, r]))
    expect(Object.keys(byId).sort()).toEqual(['ps-acc', 'ps-filled', 'ps-offer'])
    expect(byId['ps-filled']).toMatchObject({ budgetBase: 190_000, actualBase: 195_000, source: 'comp', variance: 5_000, personId: 'p-in' })
    expect(byId['ps-offer']).toMatchObject({ status: 'offer', actualBase: 262_000, source: 'offer', variance: 12_000 })
    expect(byId['ps-acc']).toMatchObject({ status: 'filled', actualBase: 228_000, variance: 8_000, offerId: 'o-mei' })
    expect(byId['ps-offer'].variancePct).toBeCloseTo(0.048, 3)
    expect(totals).toEqual({ budget: 660_000, actual: 685_000, variance: 25_000 })
  })

  it('costs the remaining slots at budget base or band midpoint', () => {
    const db = planDB()
    const c = planCost(db, D)
    expect(c.rows.map((r) => [r.slotId, r.base, r.basis])).toEqual([
      ['ps-open', 200_000, 'budget'],
      ['ps-offer', 250_000, 'budget'],
      ['ps-planned', 205_000, 'band_mid'],
      ['ps-draft', 180_000, 'budget'],
    ])
    const expected = [200_000, 250_000, 205_000, 180_000].reduce((t, b) => t + Math.round(loadedCost(db, { base: b, state: 'CA' }).totalMonthly), 0)
    expect(c.monthly).toBe(expected)
    expect(c.byQuarter.map((q) => [q.quarter, q.count])).toEqual([
      ['2026-Q4', 1],
      ['2027-Q1', 1],
      ['2027-Q2', 2],
    ])
  })

  it('agrees with the at-plan run-rate on which slots remain', () => {
    const db = planDB()
    const atPlan = runRate(db, D, { include: 'at_plan' })
    expect(atPlan.lines.filter((l) => l.kind === 'plan').map((l) => l.slotId).sort()).toEqual(['ps-draft', 'ps-open', 'ps-planned'])
    expect(atPlan.lines.filter((l) => l.kind === 'offer').map((l) => l.offerId)).toEqual(['o-dan'])
    expect(atPlan.lines.filter((l) => l.kind === 'incoming').map((l) => l.name).sort()).toEqual(['Ivan Test', 'Mei Tanaka'])
  })
})

describe('budget variance with two hires from one job', () => {
  /** Marcus and Priyanka hired from one job at $220K and $205K (band mid $205K), Rosa part time at $31 an hour for 30 hours, and a person added directly. */
  function twoHireDB(): DB {
    const db = planDB()
    db.jobs.push(mkJob('j-fs', 'open'), mkJob('j-ops', 'filled'))
    db.candidates.push(
      { id: 'c-marcus', firstName: 'Marcus', lastName: 'Webb', email: 'mw@x.com', links: {}, source: 'outbound', sponsorship: 'no', tags: [], createdOn: '2026-09-01' },
      { id: 'c-pri', firstName: 'Priyanka', lastName: 'Desai', email: 'pd@x.com', links: {}, source: 'inbound', sponsorship: 'no', tags: [], createdOn: '2026-09-01' },
      { id: 'c-rosa', firstName: 'Rosa', lastName: 'Diaz', email: 'rd@x.com', links: {}, source: 'inbound', sponsorship: 'no', tags: [], createdOn: '2026-09-01' },
    )
    db.people.push(
      mkPerson('p-marcus', 'Marcus', '2026-10-26', { fromCandidateId: 'c-marcus' }),
      mkPerson('p-pri', 'Priyanka', '2026-10-30', { fromCandidateId: 'c-pri' }),
      mkPerson('p-rosa', 'Rosa', '2026-10-19', { fromCandidateId: 'c-rosa', employmentType: 'part_time', hoursPerWeek: 30, flsa: 'non_exempt' }),
      mkPerson('p-half', 'Hal', '2026-10-19', { employmentType: 'part_time', hoursPerWeek: 20 }),
    )
    db.comp.push(mkComp('p-half', '2026-10-19', 100_000))
    db.offers.push(
      { ...mkOffer('o-marcus', 'c-marcus', 'j-fs', 'accepted', 220_000, '2026-10-26'), personId: 'p-marcus' },
      // Linked to Priyanka through her candidate record only.
      { ...mkOffer('o-pri', 'c-pri', 'j-fs', 'accepted', 205_000, '2026-10-30'), createdOn: '2026-10-03' },
      {
        ...mkOffer('o-rosa', 'c-rosa', 'j-ops', 'accepted', 0, '2026-10-19'),
        payType: 'hourly',
        salary: undefined,
        hourlyRate: 31,
        hoursPerWeek: 30,
        employmentType: 'part_time',
        personId: 'p-rosa',
      },
    )
    db.plan.push(
      mkSlot('ps-fs', { jobId: 'j-fs', personId: 'p-marcus', status: 'filled' }),
      // The line hireFromOffer added for the second hire from the same job.
      mkSlot('ps-fs-2', { jobId: 'j-fs', personId: 'p-pri', status: 'filled' }),
      mkSlot('ps-ops', { jobId: 'j-ops', personId: 'p-rosa', status: 'filled', budgetBase: 70_000 }),
      // Someone added directly onto a line of the same job: no offer, so the hire record counts.
      mkSlot('ps-fs-3', { jobId: 'j-fs', personId: 'p-half', status: 'filled' }),
    )
    return db
  }

  it("compares each line with its own hire's offer, not the job's first one", () => {
    const db = twoHireDB()
    const byId = Object.fromEntries(budgetVariance(db).rows.map((r) => [r.slotId, r]))
    expect(byId['ps-fs']).toMatchObject({ budgetBase: 205_000, budgetFromBand: true, actualBase: 220_000, source: 'offer', variance: 15_000, offerId: 'o-marcus', personId: 'p-marcus' })
    expect(byId['ps-fs-2']).toMatchObject({ budgetBase: 205_000, actualBase: 205_000, source: 'offer', variance: 0, offerId: 'o-pri', personId: 'p-pri' })
    expect(byId['ps-fs-3']).toMatchObject({ source: 'comp', personId: 'p-half' })
    expect(byId['ps-fs-3'].offerId).toBeUndefined()
    const rows = planRollup(db)
    expect(rows.find((r) => r.slot.id === 'ps-fs-2')).toMatchObject({ status: 'filled', offer: { id: 'o-pri' }, person: { id: 'p-pri' } })
    expect(rows.find((r) => r.slot.id === 'ps-fs-3')?.offer).toBeUndefined()
  })

  it('restates part-time pay at full time before comparing it with the budget', () => {
    const { rows, totals } = budgetVariance(twoHireDB())
    const byId = Object.fromEntries(rows.map((r) => [r.slotId, r]))
    // $31 x 40 x 52 = $64,480 at full time, not $48,360 for 30 hours.
    expect(byId['ps-ops']).toMatchObject({ budgetBase: 70_000, actualBase: 64_480, restatedFromHours: 30, variance: -5_520 })
    // A $100K salary for 20 hours a week is $200K at full time.
    expect(byId['ps-fs-3']).toMatchObject({ budgetBase: 205_000, actualBase: 200_000, restatedFromHours: 20, variance: -5_000 })
    // Full-time lines are not restated.
    expect(byId['ps-fs'].restatedFromHours).toBeUndefined()
    // The earlier lines (+$25,000 on $660,000) plus +$15,000, $0, -$5,520 and -$5,000.
    expect(totals).toEqual({ budget: 1_345_000, actual: 1_374_480, variance: 29_480 })
  })
})

describe('the plan line a hire fills', () => {
  it("takes the job's own line, else a free line linked by jobId, never a filled or cut one", () => {
    const db = planDB()
    const job = (id: string) => db.jobs.find((j) => j.id === id)
    // Linked by the line's jobId only
    expect(planSlotForHire(db, { jobId: 'j-open' }, job('j-open'))?.id).toBe('ps-open')
    // The job's planSlotId wins over an earlier line that names the job
    db.plan.push(mkSlot('ps-open-own', { status: 'planned' }))
    db.jobs.find((j) => j.id === 'j-open')!.planSlotId = 'ps-open-own'
    expect(planSlotForHire(db, { jobId: 'j-open' }, job('j-open'))?.id).toBe('ps-open-own')
    // Once the job's own line is held, the next free line on the job
    Object.assign(db.plan.find((s) => s.id === 'ps-open-own')!, { status: 'filled', personId: 'p-a' })
    expect(planSlotForHire(db, { jobId: 'j-open' }, job('j-open'))?.id).toBe('ps-open')
    // Nothing free: a person on the line or a filled or cut status rules it out
    Object.assign(db.plan.find((s) => s.id === 'ps-open')!, { personId: 'p-b' })
    expect(planSlotForHire(db, { jobId: 'j-open' }, job('j-open'))).toBeUndefined()
    expect(jobHasPlanLine(db, { jobId: 'j-open' }, job('j-open'))).toBe(true)
    db.plan.push(mkSlot('ps-cut-2', { status: 'cut', jobId: 'j-acc' }), mkSlot('ps-filled-2', { status: 'filled', jobId: 'j-acc' }))
    db.plan = db.plan.filter((s) => s.id !== 'ps-acc')
    expect(planSlotForHire(db, { jobId: 'j-acc' }, job('j-acc'))).toBeUndefined()
    // A job with no line at all
    db.jobs.push(mkJob('j-new', 'open'))
    expect(planSlotForHire(db, { jobId: 'j-new' }, job('j-new'))).toBeUndefined()
    expect(jobHasPlanLine(db, { jobId: 'j-new' }, job('j-new'))).toBe(false)
  })
})
