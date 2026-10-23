import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import {
  addValuation,
  approveGrants,
  boardConsentQueue,
  capTableErrors,
  capTableIsPlaceholder,
  cliffDate,
  confirmCapTable,
  consentTableText,
  current409A,
  defaultSafeHarborEnd,
  exerciseDeadline,
  grantNeeds409A,
  grantSummary,
  monthsVested,
  nextVestDate,
  poolSummary,
  removeValuation,
  scheduleText,
  sharesHeld,
  updateCapTable,
  updateValuation,
  upcomingCliffs,
  upcomingVests,
  valuationErrors,
  valuationWarnings,
  vestedHeld,
  vestedShares,
  vestingPoints,
  vestingStop,
} from '@/domain/equity'
import type { Checklist, ChecklistTask, DB, EquityGrant, Offer, Person } from '@/domain/types'

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

function mkGrant(id: string, personId: string, shares: number, vestingStart: string, over: Partial<EquityGrant> = {}): EquityGrant {
  return {
    id,
    personId,
    holderType: 'employee',
    type: 'ISO',
    shares,
    strikePrice: 0.25,
    vestingStart,
    cliffMonths: 12,
    vestingMonths: 48,
    status: 'approved',
    boardApprovedOn: vestingStart,
    exercisedShares: 0,
    postTerminationExerciseDays: 90,
    ...over,
  }
}

function mkTask(id: string, templateTaskId: string, title: string, dueOn: string): ChecklistTask {
  return { id, templateTaskId, title, ownerRole: 'admin', assigneeId: null, dueOn, status: 'open', category: 'equity', statutory: false }
}

function checklist(id: string, personId: string, kind: Checklist['kind'], anchorDate: string, tasks: ChecklistTask[], createdOn = anchorDate): Checklist {
  return { id, personId, kind, templateId: `tpl-${kind}`, anchorDate, createdOn, tasks }
}

function equityDB(): DB {
  const db = blankDB({ companyName: 'Testco', founderFirstName: 'Maya', founderLastName: 'Raman', foundedOn: '2025-02-03' })
  db.equity.poolShares = 1_200_000
  db.equity.poolIncreases = [{ id: 'pi-seed', date: '2026-02-24', shares: 500_000, note: 'Seed top-up' }]
  db.equity.valuations = [
    { id: 'v-1', effectiveOn: '2025-05-01', fmvPerShare: 0.25, provider: 'Meridian', expiresOn: '2026-05-01' },
    { id: 'v-2', effectiveOn: '2026-03-20', fmvPerShare: 1.15, provider: 'Meridian', expiresOn: '2027-03-20' },
  ]
  db.company.fundingRounds = [{ id: 'fr-seed', name: 'Seed', closedOn: '2026-02-24', amount: 14_000_000, instrument: 'Priced' }]
  db.people.push(
    mkPerson('p-tomas', 'Tomas', '2025-05-12'),
    mkPerson('p-kofi', 'Kofi', '2025-10-06'),
    mkPerson('p-ben', 'Ben', '2025-08-18', { endDate: '2026-09-18' }),
    mkPerson('p-omar', 'Omar', '2026-05-04', { endDate: '2026-08-28' }),
    mkPerson('p-aisha', 'Aisha', '2026-09-08'),
    mkPerson('p-gone', 'Gwen', '2025-10-06', { endDate: '2026-09-01' }),
  )
  db.candidates.push(
    { id: 'c-dan', firstName: 'Daniel', lastName: 'Reyes', email: 'd@x.com', links: {}, source: 'outbound', sponsorship: 'no', tags: [], createdOn: '2026-09-01' },
    { id: 'c-dee', firstName: 'Dee', lastName: 'Brooks', email: 'e@x.com', links: {}, source: 'inbound', sponsorship: 'no', tags: [], createdOn: '2026-09-01' },
  )
  db.grants.push(
    mkGrant('g-tomas', 'p-tomas', 150_000, '2025-05-12', { exercisedShares: 10_000 }),
    mkGrant('g-kofi', 'p-kofi', 52_000, '2025-10-06'),
    mkGrant('g-ben', 'p-ben', 60_000, '2025-08-18', { cancelledShares: 43_750, cancelledOn: '2026-09-18' }),
    mkGrant('g-omar', 'p-omar', 30_000, '2026-05-04', { status: 'cancelled', cancelledShares: 30_000, cancelledOn: '2026-08-28', strikePrice: 1.15 }),
    mkGrant('g-aisha', 'p-aisha', 12_000, '2026-09-08', { status: 'promised', boardApprovedOn: undefined, strikePrice: 1.15, proposedOn: '2026-09-02' }),
    mkGrant('g-dan', 'c-dan', 50_000, '2026-11-02', { holderType: 'candidate', status: 'reserved', boardApprovedOn: undefined, fromOfferId: 'o-dan', strikePrice: 1.15 }),
    mkGrant('g-declined', 'c-old', 20_000, '2026-06-01', { holderType: 'candidate', status: 'cancelled', boardApprovedOn: undefined, cancelledShares: 20_000 }),
    mkGrant('g-gone', 'p-gone', 24_000, '2025-10-06'),
  )
  const offer: Offer = {
    id: 'o-dee',
    applicationId: 'a-dee',
    candidateId: 'c-dee',
    jobId: 'j-se',
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
  }
  db.offers.push(offer)
  return db
}

describe('existing vesting helpers', () => {
  const g = mkGrant('g', 'p', 48_000, '2025-10-06')
  it('vests nothing before the cliff, a quarter at the cliff, then monthly', () => {
    expect(monthsVested(g, '2026-10-05')).toBe(0)
    expect(vestedShares(g, '2026-10-05')).toBe(0)
    expect(vestedShares(g, '2026-10-06')).toBe(12_000)
    expect(vestedShares(g, '2026-11-06')).toBe(13_000)
    expect(vestedShares(g, '2030-01-01')).toBe(48_000)
    expect(cliffDate(g)).toBe('2026-10-06')
    expect(nextVestDate(g, '2026-10-09')).toBe('2026-11-06')
  })

  it('vests a 31st start on the last day of shorter months everywhere', () => {
    const g31 = mkGrant('g31', 'p-x', 48_000, '2025-01-31')
    expect(vestedShares(g31, '2026-01-30')).toBe(0)
    expect(vestedShares(g31, '2026-01-31')).toBe(12_000)
    expect(vestedShares(g31, '2026-02-27')).toBe(12_000)
    expect(vestedShares(g31, '2026-02-28')).toBe(13_000)
    expect(vestedShares(g31, '2026-04-29')).toBe(14_000)
    expect(vestedShares(g31, '2026-04-30')).toBe(15_000)
    expect(nextVestDate(g31, '2026-02-27')).toBe('2026-02-28')
    expect(nextVestDate(g31, '2026-02-28')).toBe('2026-03-31')
    expect(vestingPoints(g31)[13]).toEqual({ date: '2026-02-28', vested: 13_000 })

    const db = equityDB()
    db.people.push(mkPerson('p-x', 'Xia', '2025-01-31'))
    db.grants.push(g31)
    expect(upcomingVests(db, '2026-02-28', '2026-02-28').filter((v) => v.grantId === 'g31')).toEqual([
      { personId: 'p-x', grantId: 'g31', date: '2026-02-28', shares: 1_000, cumulative: 13_000, isCliff: false, awaitingBoard: false },
    ])
    expect(upcomingVests(db, '2026-04-30', '2026-04-30').find((v) => v.grantId === 'g31')?.cumulative).toBe(15_000)
    expect(grantSummary(db, 'p-x', '2026-02-28')).toMatchObject({ vested: 13_000, nextVest: { date: '2026-03-31', shares: 1_000 } })
    expect(grantSummary(db, 'p-x', '2026-04-30')).toMatchObject({ vested: 15_000, nextVest: { date: '2026-05-31', shares: 1_000 } })
    expect(grantSummary(db, 'p-x', '2026-04-29')).toMatchObject({ vested: 14_000, nextVest: { date: '2026-04-30', shares: 1_000 } })
  })

  it('counts held shares after cancellation', () => {
    expect(sharesHeld(mkGrant('a', 'p', 60_000, '2025-08-18', { cancelledShares: 43_750 }))).toBe(16_250)
    expect(sharesHeld(mkGrant('b', 'p', 30_000, '2026-05-04', { status: 'cancelled' }))).toBe(0)
  })
})

describe('pool summary', () => {
  it('splits the pool into granted, awaiting board, reserved, returned and available', () => {
    const s = poolSummary(equityDB(), D)
    expect(s.poolShares).toBe(1_700_000)
    expect(s.increases).toBe(500_000)
    // Tomas 150,000 (10,000 exercised still count), Kofi 52,000, Ben's 16,250 kept.
    expect(s.grantedOutstanding).toBe(150_000 + 52_000 + 16_250)
    expect(s.exercised).toBe(10_000)
    expect(s.awaitingBoard).toBe(12_000)
    // Daniel's reserved grant plus Dee's offer, which has no grant row yet.
    expect(s.reservedByOffers).toBe(50_000 + 18_000)
    // Ben's 43,750 unvested, Omar's 30,000, and Gwen's 24,000: she left Sep 1, before her cliff, and no
    // cancellation was recorded. The declined offer's reservation never left the pool.
    expect(s.returned).toBe(43_750 + 30_000 + 24_000)
    expect(s.unrecordedForfeitures).toBe(24_000)
    expect(s.unrecordedGrantIds).toEqual(['g-gone'])
    expect(s.available).toBe(1_700_000 - 218_250 - 12_000 - 68_000)
    expect(s.usedPct).toBeCloseTo((218_250 + 12_000 + 68_000) / 1_700_000, 6)
  })

  it('keeps what vested before an unrecorded departure, or what was exercised', () => {
    const db = equityDB()
    db.people = db.people.map((p) => (p.id === 'p-gone' ? { ...p, endDate: '2026-11-15' } : p))
    // Cliff on Oct 6 (6,000) and Nov 6 (500 more): 6,500 kept, 17,500 back to the pool.
    const s = poolSummary(db, '2026-12-01')
    expect(s.unrecordedForfeitures).toBe(17_500)
    expect(s.grantedOutstanding).toBe(150_000 + 52_000 + 16_250 + 6_500)
    // Still employed on the end date itself: nothing is returned yet.
    expect(poolSummary(db, '2026-11-15').unrecordedForfeitures).toBe(0)
    db.grants = db.grants.map((g) => (g.id === 'g-gone' ? { ...g, earlyExercise: true, exercisedShares: 10_000 } : g))
    expect(poolSummary(db, '2026-12-01').unrecordedForfeitures).toBe(14_000)
  })

  it('stops holding shares for offers past their expiry date', () => {
    const db = equityDB()
    // Dee's offer expires Oct 14; Daniel's reserved grant came from an offer that lapsed Oct 1.
    db.offers.push({ ...db.offers[0], id: 'o-dan', applicationId: 'a-dan', candidateId: 'c-dan', equityShares: 50_000, expiresOn: '2026-10-01' })
    expect(poolSummary(db, D).reservedByOffers).toBe(18_000)
    expect(poolSummary(db, '2026-10-15').reservedByOffers).toBe(0)
  })

  it("returns a leaver's unvested shares on their last day, not when offboarding starts", () => {
    const db = equityDB()
    // Offboarding recorded today for a last day of Oct 30: Kofi keeps vesting until then.
    db.grants = db.grants.map((g) => (g.id === 'g-kofi' ? { ...g, cancelledShares: 30_000, cancelledOn: '2026-10-30' } : g))
    const before = poolSummary(db, D)
    expect(before.grantedOutstanding).toBe(150_000 + 52_000 + 16_250)
    expect(before.returned).toBe(43_750 + 30_000 + 24_000)
    const after = poolSummary(db, '2026-10-30')
    expect(after.grantedOutstanding).toBe(150_000 + 22_000 + 16_250)
    expect(after.returned).toBe(43_750 + 30_000 + 24_000 + 30_000)
    const kofi = db.grants.find((g) => g.id === 'g-kofi') as EquityGrant
    expect(sharesHeld(kofi, D)).toBe(52_000)
    expect(sharesHeld(kofi, '2026-10-30')).toBe(22_000)
  })

  it('counts pool increases only from their date', () => {
    expect(poolSummary(equityDB(), '2026-01-01').poolShares).toBe(1_200_000)
  })
})

describe('409A warnings', () => {
  it('stays quiet while the 409A is current and no round followed it', () => {
    expect(valuationWarnings(equityDB(), D)).toEqual([])
  })

  it('warns 60 days before expiry and after it', () => {
    const soon = valuationWarnings(equityDB(), '2027-02-01')
    expect(soon.map((w) => w.kind)).toEqual(['expiring'])
    expect(soon[0].text).toBe('The 409A from Mar 20, 2026 expires in 47 days (Mar 20, 2027). Plan the next valuation now so grants keep safe harbor.')
    expect(valuationWarnings(equityDB(), '2027-01-19').map((w) => w.kind)).toEqual(['expiring'])
    expect(valuationWarnings(equityDB(), '2027-01-18')).toEqual([])
    const late = valuationWarnings(equityDB(), '2027-03-21')
    expect(late.map((w) => w.kind)).toEqual(['expired'])
    expect(late[0].text).toContain('expired on Mar 20, 2027')
  })

  it('warns when a round closed after the 409A in effect', () => {
    // Aisha's promised $1.15 strike also differs from the $0.25 409A in effect that day.
    const w = valuationWarnings(equityDB(), '2026-03-01')
    expect(w.map((x) => x.kind)).toEqual(['financing', 'strike'])
    expect(w[0].text).toContain('The Seed round closed on Feb 24, 2026, after the current 409A (May 1, 2025)')
  })

  it('warns about a missing 409A and a promised strike that differs from it', () => {
    const none = equityDB()
    none.equity.valuations = []
    expect(valuationWarnings(none, D).map((w) => w.kind)).toEqual(['missing'])
    const stale = equityDB()
    const g = stale.grants.find((x) => x.id === 'g-aisha')
    if (g) g.strikePrice = 0.25
    const w = valuationWarnings(stale, D)
    expect(w.map((x) => x.kind)).toEqual(['strike'])
    expect(w[0].text).toContain('$0.25 strike, but the 409A in effect is $1.15')
  })
})

describe('vesting points, cliffs and vests', () => {
  it('builds monthly cumulative points with the cliff jump', () => {
    const pts = vestingPoints(mkGrant('g', 'p', 48_000, '2025-10-06'))
    expect(pts).toHaveLength(49)
    expect(pts[0]).toEqual({ date: '2025-10-06', vested: 0 })
    expect(pts[11].vested).toBe(0)
    expect(pts[12]).toEqual({ date: '2026-10-06', vested: 12_000 })
    expect(pts[13].vested).toBe(13_000)
    expect(pts[48]).toEqual({ date: '2029-10-06', vested: 48_000 })
  })

  it('flattens after a cancellation', () => {
    const pts = vestingPoints(mkGrant('g', 'p', 60_000, '2025-08-18', { cancelledShares: 43_750, cancelledOn: '2026-09-18' }))
    expect(pts[13].vested).toBe(16_250)
    expect(pts[14].vested).toBe(16_250)
    expect(pts[48].vested).toBe(16_250)
  })

  it('lists cliffs in range for people still here', () => {
    const cliffs = upcomingCliffs(equityDB(), '2026-10-01', '2026-10-31')
    // Gwen left Sep 1, before her Oct 6 cliff.
    expect(cliffs).toEqual([{ personId: 'p-kofi', grantId: 'g-kofi', date: '2026-10-06', shares: 13_000, awaitingBoard: false }])
    expect(upcomingCliffs(equityDB(), '2027-09-01', '2027-09-30')).toEqual([
      { personId: 'p-aisha', grantId: 'g-aisha', date: '2027-09-08', shares: 3_000, awaitingBoard: true },
    ])
  })

  it('lists monthly vests with shares and running totals', () => {
    const vests = upcomingVests(equityDB(), '2026-11-01', '2026-11-30').filter((v) => v.personId === 'p-kofi')
    expect(vests).toEqual([
      { personId: 'p-kofi', grantId: 'g-kofi', date: '2026-11-06', shares: 1_083, cumulative: 14_083, isCliff: false, awaitingBoard: false },
    ])
  })

  it('writes schedules in plain words', () => {
    expect(scheduleText({ cliffMonths: 12, vestingMonths: 48 })).toBe('4-year vesting, 1-year cliff, then monthly')
    expect(scheduleText({ cliffMonths: 0, vestingMonths: 24 })).toBe('Monthly over 2 years, no cliff')
    expect(scheduleText({ cliffMonths: 6, vestingMonths: 30 })).toBe('30-month vesting, 6-month cliff, then monthly')
  })
})

describe('board consent', () => {
  it('queues promised grants and copies a tab-separated consent table', () => {
    const db = equityDB()
    expect(boardConsentQueue(db).map((g) => g.id)).toEqual(['g-aisha'])
    const text = consentTableText(db, ['g-aisha', 'missing'], D)
    expect(text.split('\n')).toEqual([
      'Name\tShares\tType\tStrike\tVest start\tSchedule',
      'Aisha Test\t12,000\tISO\t$1.15\t2026-09-08\t4-year vesting, 1-year cliff, then monthly',
    ])
  })

  it('fills a missing strike from the 409A in effect', () => {
    const db = equityDB()
    const g = db.grants.find((x) => x.id === 'g-aisha')
    if (g) g.strikePrice = 0
    expect(consentTableText(db, ['g-aisha'], D)).toContain('\t$1.15\t')
  })

  it('prints the strike a promised grant will get at the board date', () => {
    const db = equityDB()
    const g = db.grants.find((x) => x.id === 'g-aisha')
    if (g) g.strikePrice = 0.25
    // A stale $0.25 strike from before the seed round: approveGrants will set $1.15, so the table says $1.15.
    expect(consentTableText(db, ['g-aisha'], D)).toContain('\t$1.15\t')
    expect(consentTableText(db, ['g-aisha'], D, { keepStrike: true })).toContain('\t$0.25\t')
    // Approved grants keep their recorded strike.
    expect(consentTableText(db, ['g-kofi'], D)).toContain('\t$0.25\t')
    db.equity.valuations = []
    expect(consentTableText(db, ['g-aisha'], D)).toContain('\t$0.25\t')
  })

  it('approves promised grants, prices them at the board-date 409A and starts the 25102(o) clock once', () => {
    const start = equityDB()
    // A company with no earlier board approvals.
    start.grants = start.grants.filter((x) => !x.boardApprovedOn)
    const g = start.grants.find((x) => x.id === 'g-aisha')
    if (g) g.strikePrice = 0.25
    let result: ReturnType<typeof approveGrants> | undefined
    const next = produce(start, (d) => {
      result = approveGrants(d, ['g-aisha', 'g-kofi'], '2026-10-09', { date: D })
    })
    expect(result?.approved).toEqual(['g-aisha'])
    expect(result?.skipped).toEqual(['g-kofi'])
    expect(result?.firstIssuance).toBe(true)
    expect(result?.notice25102oDueOn).toBe('2026-11-08')
    const approved = next.grants.find((x) => x.id === 'g-aisha')
    expect(approved).toMatchObject({ status: 'approved', boardApprovedOn: '2026-10-09', strikePrice: 1.15 })
    expect(next.equity.firstIssuanceOn).toBe('2026-10-09')
    expect(next.activity.map((a) => a.text)).toEqual([
      'Board approved the option grant for Aisha Test (board date Oct 9, 2026)',
      'First option grants recorded on Oct 9, 2026. The California 25102(o) notice is due by Nov 8, 2026.',
    ])

    const again = produce(next, (d) => {
      d.grants.push(mkGrant('g-new', 'p-kofi', 5_000, '2026-10-09', { status: 'promised', boardApprovedOn: undefined }))
      result = approveGrants(d, ['g-new'], '2027-04-01', { date: D })
    })
    expect(result?.firstIssuance).toBe(false)
    expect(again.equity.firstIssuanceOn).toBe('2026-10-09')
    expect(result?.warnings.some((w) => w.includes('expired on Mar 20, 2027'))).toBe(true)
    expect(result?.warnings.some((w) => w.includes('after today'))).toBe(true)
  })

  it('dates the first issuance from earlier board approvals when it was never recorded', () => {
    // Tomas's grant was approved May 12, 2025; firstIssuanceOn was never set.
    let result: ReturnType<typeof approveGrants> | undefined
    const next = produce(equityDB(), (d) => {
      result = approveGrants(d, ['g-aisha'], '2026-10-09', { date: D })
    })
    expect(result?.firstIssuance).toBe(false)
    expect(result?.notice25102oDueOn).toBeUndefined()
    expect(next.equity.firstIssuanceOn).toBe('2025-05-12')
    expect(result?.warnings).toContain(
      'The California 25102(o) notice was due by Jun 11, 2025, 30 days after the first option grants on May 12, 2025. No filing is recorded, so file it now or record the filing date.',
    )
    expect(next.activity.at(-1)?.text).toBe(
      'First option grants recorded as of May 12, 2025, the earliest board approval on file. The California 25102(o) notice was due by Jun 11, 2025.',
    )

    // A filing on record: no warning. A grant cancelled after board approval still counts as issued.
    const filed = equityDB()
    filed.equity.filing25102oOn = '2025-06-01'
    filed.grants = filed.grants.filter((x) => x.status !== 'approved')
    const after = produce(filed, (d) => {
      result = approveGrants(d, ['g-aisha'], '2026-10-09', { date: D })
    })
    expect(after.equity.firstIssuanceOn).toBe('2026-05-04')
    expect(result?.firstIssuance).toBe(false)
    expect(result?.warnings.some((w) => w.includes('25102(o)'))).toBe(false)
  })

  it('will not approve an option grant at a $0 strike when no 409A is in effect', () => {
    const db = equityDB()
    db.equity.valuations = []
    db.grants.push(mkGrant('g-zero', 'p-kofi', 5_000, '2026-10-09', { status: 'promised', boardApprovedOn: undefined, strikePrice: 0 }))
    let result: ReturnType<typeof approveGrants> | undefined
    const next = produce(db, (d) => {
      result = approveGrants(d, ['g-zero', 'g-aisha'], '2026-10-09', { date: D })
    })
    expect(result?.approved).toEqual(['g-aisha'])
    expect(result?.skipped).toEqual(['g-zero'])
    expect(result?.noStrike).toEqual(['g-zero'])
    expect(result?.warnings.some((w) => w.includes('Record a 409A first'))).toBe(true)
    expect(next.grants.find((g) => g.id === 'g-zero')?.status).toBe('promised')
  })

  it('says first, and only once, that grants wait for a 409A when it approves none', () => {
    // A fresh company: one accepted offer with options, no 409A on file.
    const db = equityDB()
    db.equity.valuations = []
    db.grants = [mkGrant('g-dana', 'p-kofi', 35_000, '2026-10-12', { status: 'promised', boardApprovedOn: undefined, strikePrice: 0 })]
    expect(grantNeeds409A(db, db.grants[0], D)).toBe(true)
    expect(grantNeeds409A(db, { ...db.grants[0], type: 'RSA' }, D)).toBe(false)
    expect(grantNeeds409A(db, { ...db.grants[0], strikePrice: 0.5 }, D)).toBe(false)
    let result: ReturnType<typeof approveGrants> | undefined
    const next = produce(db, (d) => {
      result = approveGrants(d, ['g-dana'], D, { date: D })
    })
    expect(result).toMatchObject({ approved: [], skipped: ['g-dana'], noStrike: ['g-dana'], firstIssuance: false })
    expect(result?.warnings[0]).toBe(
      '1 option grant was not approved: no 409A valuation is in effect on Oct 9, 2026, so there is no strike price. Record a 409A first.',
    )
    // The generic "no 409A on file" warning would repeat it.
    expect(result?.warnings.filter((w) => w.includes('409A'))).toHaveLength(1)
    // Nothing changed, so the store records no Undo step for it.
    expect(next).toBe(db)

    // Once a 409A is recorded, the same grant is approved at its price.
    const priced = produce(db, (d) => {
      addValuation(d, { effectiveOn: '2026-10-01', fmvPerShare: 0.42, provider: 'Carta', expiresOn: '2027-10-01' })
      result = approveGrants(d, ['g-dana'], D, { date: D })
    })
    expect(grantNeeds409A(priced, db.grants[0], D)).toBe(false)
    expect(result).toMatchObject({ approved: ['g-dana'], skipped: [], noStrike: [], firstIssuance: true })
    expect(priced.grants[0]).toMatchObject({ status: 'approved', strikePrice: 0.42, boardApprovedOn: D })
    // A board date before the 409A took effect still has no price.
    expect(grantNeeds409A(priced, db.grants[0], '2026-09-30')).toBe(true)
  })

  it("closes the onboarding task 'Grant added to the next board consent' when the board approves the hire grant", () => {
    const withChecklist = (checkinStatus: ChecklistTask['status']) => {
      const db = equityDB()
      db.checklists.push(
        checklist('ck-aisha', 'p-aisha', 'onboarding', '2026-09-08', [
          mkTask('t-board', 'on-equity-board', 'Grant added to the next board consent', '2026-10-08'),
          { ...mkTask('t-checkin', 'on-checkin-90', '90-day check-in', '2026-12-07'), status: checkinStatus },
        ]),
      )
      return db
    }
    const db = withChecklist('open')
    let result: ReturnType<typeof approveGrants> | undefined
    const next = produce(db, (d) => {
      result = approveGrants(d, ['g-aisha'], '2026-10-08', { date: D })
    })
    expect(result?.tasksClosed).toBe(1)
    const tasks = next.checklists[0].tasks
    expect(tasks.find((t) => t.id === 't-board')).toMatchObject({ status: 'done', doneOn: '2026-10-08' })
    expect(tasks.find((t) => t.id === 't-checkin')?.status).toBe('open')
    expect(next.checklists[0].completedOn).toBeUndefined()
    expect(next.activity.map((a) => a.text)).toContain('Marked done: Grant added to the next board consent for Aisha Test')
    // Undo restores the state before the change: the task is open again there.
    expect(db.checklists[0].tasks[0].status).toBe('open')

    // The last open task: the checklist completes. A board date still ahead dates the task today.
    const ahead = produce(withChecklist('done'), (d) => {
      result = approveGrants(d, ['g-aisha'], '2026-10-20', { date: D })
    })
    expect(ahead.checklists[0].tasks[0]).toMatchObject({ status: 'done', doneOn: D })
    expect(ahead.checklists[0].completedOn).toBe(D)
  })

  it('leaves the onboarding task open while another hire grant still waits, or the grant could not be approved', () => {
    const db = equityDB()
    db.grants.push(mkGrant('g-aisha-2', 'p-aisha', 3_000, '2026-09-08', { status: 'promised', boardApprovedOn: undefined, strikePrice: 1.15 }))
    db.checklists.push(checklist('ck-aisha', 'p-aisha', 'onboarding', '2026-09-08', [mkTask('t-board', 'on-equity-board', 'Grant added to the next board consent', '2026-10-08')]))
    let result: ReturnType<typeof approveGrants> | undefined
    const one = produce(db, (d) => {
      result = approveGrants(d, ['g-aisha'], D, { date: D })
    })
    expect(result?.tasksClosed).toBe(0)
    expect(one.checklists[0].tasks[0].status).toBe('open')
    const both = produce(one, (d) => {
      result = approveGrants(d, ['g-aisha-2'], D, { date: D })
    })
    expect(result?.tasksClosed).toBe(1)
    expect(both.checklists[0].tasks[0].status).toBe('done')

    // No 409A on the board date: nothing is approved, so nothing closes.
    const unpriced = equityDB()
    unpriced.equity.valuations = []
    unpriced.grants = [mkGrant('g-dana', 'p-aisha', 35_000, '2026-10-12', { status: 'promised', boardApprovedOn: undefined, strikePrice: 0 })]
    unpriced.checklists.push(checklist('ck-aisha', 'p-aisha', 'onboarding', '2026-09-08', [mkTask('t-board', 'on-equity-board', 'Grant added to the next board consent', '2026-10-08')]))
    const after = produce(unpriced, (d) => {
      result = approveGrants(d, ['g-dana'], D, { date: D })
    })
    expect(result?.tasksClosed).toBe(0)
    expect(after).toBe(unpriced)
  })

  it("closes a refresh grant's task on the change checklist that queued it", () => {
    const db = equityDB()
    db.grants.push(
      mkGrant('g-kofi-refresh', 'p-kofi', 8_000, '2026-11-01', { status: 'promised', boardApprovedOn: undefined, cliffMonths: 0, note: 'Refresh grant (promotion)', strikePrice: 1.15 }),
    )
    db.checklists.push(
      // A stale onboarding task from Kofi's hire, and an older change still waiting on its own refresh grant.
      checklist('ck-kofi-on', 'p-kofi', 'onboarding', '2025-10-06', [mkTask('t-on-board', 'on-equity-board', 'Grant added to the next board consent', '2025-11-05')]),
      checklist('ck-kofi-old', 'p-kofi', 'change', '2026-06-01', [mkTask('t-old', 'ch-refresh-grant', 'Refresh grant added to the next board consent', '2026-07-01')], '2026-05-20'),
      checklist('ck-kofi-new', 'p-kofi', 'change', '2026-11-01', [mkTask('t-new', 'ch-refresh-grant', 'Refresh grant added to the next board consent', '2026-11-08')], '2026-10-09'),
    )
    let result: ReturnType<typeof approveGrants> | undefined
    const next = produce(db, (d) => {
      result = approveGrants(d, ['g-kofi-refresh'], D, { date: D })
    })
    expect(result?.tasksClosed).toBe(1)
    const status = (checklistId: string) => next.checklists.find((c) => c.id === checklistId)?.tasks[0].status
    expect(status('ck-kofi-new')).toBe('done')
    expect(status('ck-kofi-old')).toBe('open')
    expect(status('ck-kofi-on')).toBe('open')
    expect(next.checklists.find((c) => c.id === 'ck-kofi-new')?.completedOn).toBe(D)

    // With no change checklist dated on the vesting start, the oldest open refresh task closes.
    const moved = produce(db, (d) => {
      const g = d.grants.find((x) => x.id === 'g-kofi-refresh')
      if (g) g.vestingStart = '2026-12-01'
      approveGrants(d, ['g-kofi-refresh'], D, { date: D })
    })
    expect(moved.checklists.find((c) => c.id === 'ck-kofi-old')?.tasks[0].status).toBe('done')
    expect(moved.checklists.find((c) => c.id === 'ck-kofi-new')?.tasks[0].status).toBe('open')
  })

  it('gives 90 days to exercise after the last day', () => {
    expect(exerciseDeadline({ postTerminationExerciseDays: 90 }, '2026-09-18')).toBe('2026-12-17')
  })
})

describe('grant summary', () => {
  it('summarizes a vesting grant with the next vest', () => {
    const s = grantSummary(equityDB(), 'p-kofi', D)
    expect(s).toMatchObject({ totalShares: 52_000, vested: 13_000, unvested: 39_000, status: 'vesting' })
    expect(s.nextVest).toEqual({ date: '2026-11-06', shares: 1_083 })
    expect(s.cliff).toEqual({ date: '2026-10-06', shares: 13_000, passed: true })
    expect(s.text).toBe('13,000 of 52,000 vested; next 1,083 on Nov 6')
  })

  it('counts down to the cliff', () => {
    const s = grantSummary(equityDB(), 'p-kofi', '2026-09-01')
    expect(s.status).toBe('pre_cliff')
    expect(s.nextVest).toEqual({ date: '2026-10-06', shares: 13_000 })
    expect(s.text).toBe('13,000 options vest at the cliff on Oct 6, 2026')
  })

  it('shows grants waiting for the board and grants kept after leaving', () => {
    expect(grantSummary(equityDB(), 'p-aisha', D)).toMatchObject({ status: 'awaiting_board', awaitingBoard: 12_000, text: 'Grant awaiting board consent' })
    const ben = grantSummary(equityDB(), 'p-ben', D)
    expect(ben).toMatchObject({ status: 'ended', totalShares: 16_250, vested: 16_250, nextVest: null })
    expect(vestedHeld(equityDB(), equityDB().grants.find((g) => g.id === 'g-ben') as EquityGrant, '2027-06-01')).toBe(16_250)
    expect(grantSummary(equityDB(), 'p-founder', D).status).toBe('none')
  })

  /** Offboarding as lifecycle.ts records it: end date, separation, and the unvested shares cancelled on the last day. */
  function offboard(db: DB, personId: string, lastDay: string, type: 'terminated' | 'resigned_notice') {
    const p = db.people.find((x) => x.id === personId) as Person
    p.endDate = lastDay
    p.separation = { type, reason: 'Test', lastDay }
    for (const g of db.grants.filter((x) => x.personId === personId && x.status === 'approved')) {
      g.cancelledShares = g.shares - vestedShares(g, lastDay)
      g.cancelledOn = lastDay
    }
    p.separation.exerciseDeadline = exerciseDeadline({ postTerminationExerciseDays: 90 }, lastDay)
  }

  it('stops vesting on the last day of someone terminated today', () => {
    const db = equityDB()
    offboard(db, 'p-kofi', D, 'terminated')
    const s = grantSummary(db, 'p-kofi', D)
    expect(s).toMatchObject({ status: 'leaving', totalShares: 13_000, vested: 13_000, nextVest: null, fullyVestedOn: null })
    expect(s.exit).toEqual({ lastDay: D, vestedAtExit: 13_000, returnsToPool: 39_000, exerciseBy: '2027-01-07' })
    expect(s.text).toBe('Vesting stops Oct 9, 2026: 13,000 vested, 39,000 return to the pool')
    // The next day it reads as kept after leaving.
    expect(grantSummary(db, 'p-kofi', '2026-10-10')).toMatchObject({ status: 'ended', vested: 13_000, nextVest: null })
  })

  it('keeps vests before a future last day and none after it', () => {
    const db = equityDB()
    db.people.push(mkPerson('p-elena', 'Elena', '2025-08-18'))
    db.grants.push(mkGrant('g-elena', 'p-elena', 60_000, '2025-08-18'))
    offboard(db, 'p-elena', '2026-10-30', 'resigned_notice')
    const s = grantSummary(db, 'p-elena', D)
    expect(s).toMatchObject({ status: 'leaving', vested: 16_250, nextVest: { date: '2026-10-18', shares: 1_250 }, fullyVestedOn: null })
    expect(s.exit).toMatchObject({ lastDay: '2026-10-30', vestedAtExit: 17_500, returnsToPool: 42_500, exerciseBy: '2027-01-28' })
    expect(s.text).toBe('Vesting stops Oct 30, 2026: 17,500 vested, 42,500 return to the pool')
    expect(grantSummary(db, 'p-elena', '2026-10-19').nextVest).toBeNull()

    // A separation with no end date or cancellation recorded yet stops vesting all the same.
    const bare = equityDB()
    bare.people.push(mkPerson('p-elena', 'Elena', '2025-08-18', { separation: { type: 'resigned_notice', reason: 'Test', lastDay: '2026-10-30' } }))
    bare.grants.push(mkGrant('g-elena', 'p-elena', 60_000, '2025-08-18'))
    const g = bare.grants.find((x) => x.id === 'g-elena') as EquityGrant
    expect(vestingStop(bare, g)).toBe('2026-10-30')
    expect(vestedHeld(bare, g, '2027-06-01')).toBe(17_500)
    expect(grantSummary(bare, 'p-elena', D)).toMatchObject({ status: 'leaving', nextVest: { date: '2026-10-18', shares: 1_250 }, fullyVestedOn: null })
    expect(grantSummary(bare, 'p-elena', D).exit).toMatchObject({ vestedAtExit: 17_500, returnsToPool: 42_500, exerciseBy: '2027-01-28' })
    // The vesting chart line goes flat after the last day.
    const points = vestingPoints(g, vestingStop(bare, g))
    expect(points.find((p) => p.date === '2026-10-18')?.vested).toBe(17_500)
    expect(points.at(-1)).toEqual({ date: '2029-08-18', vested: 17_500 })
  })

  it('does not count a cliff after the last day', () => {
    const db = equityDB()
    // Aisha starts Sep 8, 2026 and leaves before her Sep 8, 2027 cliff, with no cancellation recorded.
    const g = db.grants.find((x) => x.id === 'g-aisha') as EquityGrant
    g.status = 'approved'
    g.boardApprovedOn = '2026-10-01'
    const p = db.people.find((x) => x.id === 'p-aisha') as Person
    p.endDate = '2027-03-01'
    const s = grantSummary(db, 'p-aisha', D)
    expect(s.cliff).toBeNull()
    expect(s.nextVest).toBeNull()
    expect(s.exit).toMatchObject({ vestedAtExit: 0, returnsToPool: 12_000, exerciseBy: null })
  })
})

describe('409A valuations and cap table', () => {
  it('records, corrects and removes a 409A, logging no price', () => {
    const db = equityDB()
    db.equity.valuations = []
    let id = ''
    const added = produce(db, (d) => {
      id = addValuation(d, { effectiveOn: '2026-10-01', fmvPerShare: 0.4249999, provider: '  Carta ', expiresOn: defaultSafeHarborEnd('2026-10-01'), note: ' ' })
    })
    expect(added.equity.valuations).toEqual([{ id, effectiveOn: '2026-10-01', fmvPerShare: 0.425, provider: 'Carta', expiresOn: '2027-10-01' }])
    expect(current409A(added, D)?.id).toBe(id)
    expect(added.activity.at(-1)).toMatchObject({ entityType: 'equity', kind: 'valuation_recorded' })
    expect(added.activity.at(-1)?.text).toBe('Recorded a 409A valuation effective Oct 1, 2026 from Carta, safe harbor until Oct 1, 2027')
    // In safe harbor; only Aisha's promised strike ($1.15) differs from the new price.
    expect(valuationWarnings(added, D).map((w) => w.kind)).toEqual(['strike'])

    let changed = true
    const same = produce(added, (d) => {
      changed = updateValuation(d, id, { effectiveOn: '2026-10-01', fmvPerShare: 0.425, provider: 'Carta', expiresOn: '2027-10-01' })
    })
    expect(changed).toBe(false)
    expect(same).toBe(added)
    const fixed = produce(added, (d) => {
      changed = updateValuation(d, id, { effectiveOn: '2026-10-01', fmvPerShare: 0.45, provider: 'Carta', expiresOn: '2027-09-30', note: 'Corrected' })
    })
    expect(changed).toBe(true)
    expect(fixed.equity.valuations[0]).toMatchObject({ fmvPerShare: 0.45, expiresOn: '2027-09-30', note: 'Corrected' })
    expect(fixed.activity.at(-1)?.text).toBe('Updated the 409A valuation effective Oct 1, 2026')

    const removed = produce(fixed, (d) => {
      removeValuation(d, id)
    })
    expect(removed.equity.valuations).toEqual([])
    expect(removed.activity.at(-1)).toMatchObject({ kind: 'valuation_removed', text: 'Removed the 409A valuation effective Oct 1, 2026' })
    expect(removed.activity.every((a) => !a.text.includes('$'))).toBe(true)
  })

  it('checks a 409A entry field by field', () => {
    expect(defaultSafeHarborEnd('2026-02-28')).toBe('2027-02-28')
    expect(valuationErrors({ effectiveOn: '2026-10-01', fmvPerShare: 0.42, provider: 'Carta', expiresOn: '2027-10-01' })).toEqual({})
    expect(valuationErrors({ effectiveOn: null, fmvPerShare: null, provider: ' ', expiresOn: null })).toEqual({
      effectiveOn: 'Pick the effective date from the valuation report.',
      fmvPerShare: 'Enter the fair market value a share, more than $0.',
      provider: 'Name the firm that did the valuation.',
      expiresOn: 'Pick the date safe harbor ends.',
    })
    expect(valuationErrors({ effectiveOn: '2026-10-01', fmvPerShare: 0, provider: 'Carta', expiresOn: '2026-10-01' })).toMatchObject({
      fmvPerShare: 'Enter the fair market value a share, more than $0.',
      expiresOn: 'Safe harbor has to end after the effective date.',
    })
    expect(valuationErrors({ effectiveOn: '2026-03-20', fmvPerShare: 1, provider: 'Carta', expiresOn: '2027-03-20' }, equityDB().equity.valuations).effectiveOn).toBe(
      'A 409A with this effective date is already on file. Edit that one instead.',
    )
  })

  it('checks and writes the cap table, keeping pool increases', () => {
    const ok = { authorizedShares: 12_000_000, fullyDilutedShares: 10_000_000, founderShares: 8_000_000, poolShares: 1_500_000 }
    expect(capTableErrors(ok)).toEqual({})
    expect(capTableErrors({ ...ok, poolShares: null, founderShares: 1.5 })).toEqual({
      poolShares: 'Enter the option pool.',
      founderShares: 'Use a whole number of shares, 0 or more.',
    })
    expect(capTableErrors({ ...ok, fullyDilutedShares: 0 }).fullyDilutedShares).toBe('Fully diluted shares must be more than 0.')
    expect(capTableErrors(ok, 600_000).fullyDilutedShares).toBe(
      'Fully diluted has to cover the founder shares plus the whole option pool (10,100,000, with 600,000 added to the pool later).',
    )
    expect(capTableErrors({ ...ok, authorizedShares: 9_000_000 }).authorizedShares).toBe(
      'Authorized shares have to be at least the fully diluted count. The charter sets how many the company may issue.',
    )

    const db = equityDB()
    let changed = false
    const next = produce(db, (d) => {
      changed = updateCapTable(d, { ...ok, poolShares: 1_400_000 }, D)
    })
    expect(changed).toBe(true)
    expect(next.equity).toMatchObject({ ...ok, poolShares: 1_400_000, poolIncreases: db.equity.poolIncreases, capTableConfirmedOn: D })
    expect(poolSummary(next, D).poolShares).toBe(1_900_000)
    expect(next.activity.at(-1)).toMatchObject({ kind: 'cap_table_updated', text: 'Updated the cap table: authorized, fully diluted, founder and option pool shares' })
    const again = produce(next, (d) => {
      changed = updateCapTable(d, { ...ok, poolShares: 1_400_000 }, '2026-10-12')
    })
    expect(changed).toBe(false)
    expect(again).toBe(next)
  })

  it('treats the Start fresh cap table as placeholder numbers until they are entered or confirmed', () => {
    const fresh = blankDB({ companyName: 'Testco', founderFirstName: 'Maya', founderLastName: 'Raman' })
    expect(fresh.equity.capTableConfirmedOn).toBeUndefined()
    expect(capTableIsPlaceholder(fresh)).toBe(true)
    const numbers = {
      authorizedShares: fresh.equity.authorizedShares,
      fullyDilutedShares: fresh.equity.fullyDilutedShares,
      founderShares: fresh.equity.founderShares,
      poolShares: fresh.equity.poolShares,
    }
    // Saving the placeholder numbers unchanged confirms them.
    let changed = false
    const saved = produce(fresh, (d) => {
      changed = updateCapTable(d, numbers, D)
    })
    expect(changed).toBe(true)
    expect(capTableIsPlaceholder(saved)).toBe(false)
    expect(saved.equity).toMatchObject({ ...numbers, capTableConfirmedOn: D })
    expect(saved.activity.at(-1)).toMatchObject({ kind: 'cap_table_confirmed', text: 'Confirmed the cap table numbers' })
    // 'These numbers are right' confirms once and keeps the first date.
    const confirmed = produce(fresh, (d) => {
      changed = confirmCapTable(d, D)
    })
    expect(changed).toBe(true)
    expect(confirmed.equity.capTableConfirmedOn).toBe(D)
    const twice = produce(confirmed, (d) => {
      changed = confirmCapTable(d, '2026-10-12')
    })
    expect(changed).toBe(false)
    expect(twice).toBe(confirmed)
  })
})
