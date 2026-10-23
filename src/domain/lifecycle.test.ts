import { type Draft, produce } from 'immer'
import { describe, expect, it, vi } from 'vitest'
import { links } from '@/app/router'
import { blankDB } from '@/data/blank'
import { DEFAULT_STAGES } from '@/data/defaults'
import { checklistProgress, generateChecklist, openTasks } from '@/domain/checklists/generate'
import { scorecardsOwed } from '@/domain/hiring/scorecards'
import { exemptFlags, planSlotStatus } from '@/domain/pay'
import { taskOwnerId } from '@/domain/inbox'
import { headcountOn } from '@/domain/people'
import { pendingApprovals, whoIsOut } from '@/domain/timeoff'
import type { Checklist, CompRecord, DB, EquityGrant, Offer, Person } from '@/domain/types'
import { addDays } from '@/lib/dates'
import {
  applyScheduledChanges,
  canCancelChange,
  cancelScheduledChange,
  changeJobOrPay,
  changeTaskPlan,
  closeForExit,
  companyDomain,
  currentJob,
  exitCleanupLines,
  hireFromOffer,
  hirePreview,
  leaveEligibility,
  markDesignationSent,
  offboardPerson,
  openJobFromPlan,
  parseCityState,
  payrollUpdateDue,
  reassignReportsAtExit,
  reportsAsOf,
  retentionDates,
  startLeave,
  startOffboarding,
} from './lifecycle'

// The store loads the sample on import; keep these tests independent of the sample seed.
vi.mock('@/data/seed', async () => {
  const blank = await import('@/data/blank')
  return {
    SAMPLE_ANCHOR: '2026-10-09',
    buildSampleDB: () => blank.blankDB({ companyName: 'Test', founderFirstName: 'Test', founderLastName: 'Founder', foundedOn: '2025-01-01' }),
  }
})

const TODAY = '2026-10-09'
const START = '2026-10-19'

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

function baseDB(): DB {
  const db = blankDB({ companyName: 'Ledgerlark', founderFirstName: 'Maya', founderLastName: 'Raman', foundedOn: '2025-02-03' })
  db.company.website = 'https://www.ledgerlark.com'
  db.equity.valuations.push({ id: 'v-1', effectiveOn: '2026-03-20', fmvPerShare: 1.15, provider: 'Test valuation', expiresOn: '2027-03-20' })
  return db
}

function addPerson(db: DB, id: string, over: Partial<Person> = {}): Person {
  const p: Person = {
    id,
    firstName: id.slice(2, 3).toUpperCase() + id.slice(3),
    lastName: 'Tester',
    workEmail: `${id.slice(2)}@ledgerlark.com`,
    title: 'Software engineer',
    departmentId: 'd-eng',
    familyId: 'f-eng',
    levelId: 'lv-l2',
    managerId: 'p-founder',
    locationId: 'loc-hq',
    workMode: 'hybrid',
    homeCity: 'San Jose',
    homeState: 'CA',
    employmentType: 'full_time',
    hoursPerWeek: 40,
    flsa: 'exempt',
    startDate: '2025-06-01',
    hireNumber: db.people.length + 1,
    emergencyContacts: [],
    ...over,
  }
  db.people.push(p)
  return p
}

function grant(id: string, personId: string, over: Partial<EquityGrant> = {}): EquityGrant {
  return {
    id,
    personId,
    holderType: 'employee',
    type: 'ISO',
    shares: 48_000,
    strikePrice: 1.15,
    vestingStart: '2026-01-12',
    cliffMonths: 12,
    vestingMonths: 48,
    status: 'approved',
    boardApprovedOn: '2026-01-22',
    exercisedShares: 0,
    postTerminationExerciseDays: 90,
    ...over,
  }
}

type HireFixture = { location?: string; workMode?: Offer['workMode']; reserved?: boolean; referred?: boolean; flsa?: Offer['flsa'] }

/** Founder, an open job linked to a plan line, and Lucas with an accepted offer starting Mon Oct 19. */
function hiringDB(f: HireFixture = {}): DB {
  const db = baseDB()
  db.plan.push({
    id: 'ps-data',
    quarter: '2026-Q4',
    title: 'Senior data engineer',
    departmentId: 'd-eng',
    familyId: 'f-eng',
    levelId: 'lv-l3',
    targetStart: START,
    status: 'offer',
    jobId: 'j-data',
  })
  db.jobs.push({
    id: 'j-data',
    title: 'Senior data engineer',
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
    openedOn: '2026-09-01',
    planSlotId: 'ps-data',
    stages: DEFAULT_STAGES.map((s) => ({ ...s })),
    interviewPlan: [],
    description: '',
    sponsorship: 'no',
    backgroundCheck: true,
    priority: 'normal',
    referralBonus: 6000,
  })
  db.candidates.push({
    id: 'c-lucas',
    firstName: 'Lucas',
    lastName: 'Ferreira',
    email: 'lucas.f@example.com',
    phone: '408-555-0100',
    links: {},
    location: f.location ?? 'Sunnyvale, CA',
    source: f.referred === false ? 'inbound' : 'referral',
    referrerId: f.referred === false ? null : 'p-founder',
    sponsorship: 'no',
    tags: [],
    createdOn: '2026-09-01',
  })
  db.applications.push({
    id: 'a-lucas',
    candidateId: 'c-lucas',
    jobId: 'j-data',
    stageId: 'offer',
    status: 'active',
    appliedOn: '2026-09-01',
    stageEnteredOn: '2026-09-25',
    history: [{ stageId: 'new', at: '2026-09-01' }],
    nextStep: { text: 'Hire', dueOn: '2026-10-01', ownerId: 'p-founder' },
  })
  db.offers.push({
    id: 'o-lucas',
    applicationId: 'a-lucas',
    candidateId: 'c-lucas',
    jobId: 'j-data',
    version: 1,
    title: 'Senior data engineer',
    levelId: 'lv-l3',
    familyId: 'f-eng',
    departmentId: 'd-eng',
    managerId: 'p-founder',
    locationId: 'loc-hq',
    workMode: f.workMode ?? 'hybrid',
    employmentType: 'full_time',
    flsa: f.flsa ?? 'exempt',
    exemptionBasis: 'computer_professional',
    payType: 'salary',
    salary: 195_000,
    equityType: 'ISO',
    equityShares: 30_000,
    vestingMonths: 48,
    cliffMonths: 12,
    startDate: START,
    expiresOn: '2026-10-02',
    contingencies: ['background_check', 'i9', 'piia'],
    status: 'accepted',
    createdOn: '2026-09-25',
    approvals: [{ approverId: 'p-founder', decision: 'approved', at: '2026-09-26T17:00:00.000Z' }],
    sentOn: '2026-09-26',
    decidedOn: '2026-09-30',
    backgroundCheck: { status: 'complete', result: 'clear', completedOn: '2026-10-06' },
  })
  if (f.reserved !== false) {
    db.grants.push(grant('g-lucas', 'c-lucas', { holderType: 'candidate', shares: 30_000, vestingStart: START, status: 'reserved', boardApprovedOn: undefined, fromOfferId: 'o-lucas' }))
  }
  return db
}

function run<T>(db: DB, fn: (d: Draft<DB>) => T): { db: DB; result: T } {
  let result: T | undefined
  const next = produce(db, (d) => {
    result = fn(d)
  })
  return { db: next, result: result as T }
}

function task(cl: Checklist | undefined, templateTaskId: string) {
  return cl?.tasks.find((t) => t.templateTaskId === templateTaskId)
}

// ---------------------------------------------------------------------------------------------
// Hire
// ---------------------------------------------------------------------------------------------

describe('hireFromOffer', () => {
  it('turns an accepted offer into employee #2 end to end', () => {
    const { db, result: id } = run(hiringDB(), (d) => hireFromOffer(d, 'o-lucas', { date: TODAY }))
    expect(id).toBe('p-lucas')
    const p = db.people.find((x) => x.id === id)
    expect(p).toMatchObject({
      firstName: 'Lucas',
      lastName: 'Ferreira',
      workEmail: 'lucas@ledgerlark.com',
      personalEmail: 'lucas.f@example.com',
      hireNumber: 2,
      title: 'Senior data engineer',
      levelId: 'lv-l3',
      managerId: 'p-founder',
      startDate: START,
      homeCity: 'Sunnyvale',
      homeState: 'CA',
      flsa: 'exempt',
      exemptionBasis: 'computer_professional',
      hoursPerWeek: 40,
      fromCandidateId: 'c-lucas',
      fromApplicationId: 'a-lucas',
      emergencyContacts: [],
      backgroundCheck: { status: 'clear', completedOn: '2026-10-06' },
    })

    const comp = db.comp.filter((c) => c.personId === id)
    expect(comp).toHaveLength(1)
    expect(comp[0]).toMatchObject({ reason: 'hire', effectiveOn: START, payType: 'salary', salary: 195_000, approvedById: 'p-founder', approvedOn: '2026-09-26' })

    const g = db.grants.find((x) => x.id === 'g-lucas')
    expect(g).toMatchObject({ status: 'promised', personId: id, holderType: 'employee', shares: 30_000 })
    expect(db.grants).toHaveLength(1)

    const lists = db.checklists.filter((c) => c.personId === id)
    expect(lists.map((c) => c.templateId)).toEqual(['tpl-onboarding'])
    const onb = lists[0]
    expect(onb).toMatchObject({ anchorDate: START, createdOn: TODAY })
    expect(task(onb, 'on-background-check')).toMatchObject({ status: 'done', doneOn: '2026-10-06' })
    expect(task(onb, 'on-i9-section2')?.dueOn).toBe('2026-10-22')
    expect(task(onb, 'on-equity-board')).toBeDefined()

    const app = db.applications[0]
    expect(app).toMatchObject({ status: 'hired', stageId: 'hired', closedOn: TODAY, stageEnteredOn: TODAY })
    expect(app.history[app.history.length - 1]).toEqual({ stageId: 'hired', at: TODAY })
    expect(app.nextStep).toBeUndefined()

    expect(db.jobs[0]).toMatchObject({ status: 'filled', closedOn: TODAY })
    expect(db.plan[0]).toMatchObject({ status: 'filled', personId: id })
    expect(db.referrals).toEqual([expect.objectContaining({ candidateId: 'c-lucas', referrerId: 'p-founder', bonusAmount: 6000, payableOn: '2027-01-17' })])
    expect(db.offers[0].personId).toBe(id)
    expect(db.documents).toEqual([expect.objectContaining({ personId: id, type: 'offer_letter', status: 'signed', date: '2026-09-30' })])
    const hired = db.activity.find((a) => a.kind === 'hired' && a.entityType === 'person')
    expect(hired?.text).toBe('Hired Lucas Ferreira as Senior data engineer, employee #2, starting Mon, Oct 19')
    expect(hired?.text).not.toMatch(/\$/)
  })

  it('takes upcoming interviews off the calendar with their unwritten scorecards', () => {
    const db = hiringDB()
    db.interviews.push(
      { id: 'i-past', applicationId: 'a-lucas', stageId: 'onsite', name: 'Onsite', startsAt: '2026-10-01T17:00:00.000Z', durationMin: 60, interviewerIds: ['p-founder'], format: 'onsite', status: 'completed', attributes: [] },
      { id: 'i-next', applicationId: 'a-lucas', stageId: 'intro', name: 'Intro call', startsAt: '2026-10-12T17:00:00.000Z', durationMin: 45, interviewerIds: ['p-founder'], format: 'video', status: 'scheduled', attributes: [] },
    )
    db.scorecards.push(
      { id: 's-past', interviewId: 'i-past', applicationId: 'a-lucas', interviewerId: 'p-founder', dueAt: '2026-10-02T18:00:00.000Z', submittedAt: '2026-10-01T20:00:00.000Z', ratings: {}, overall: 4 },
      { id: 's-next', interviewId: 'i-next', applicationId: 'a-lucas', interviewerId: 'p-founder', dueAt: '2026-10-13T17:45:00.000Z', ratings: {} },
    )
    const { db: next } = run(db, (d) => hireFromOffer(d, 'o-lucas', { date: TODAY, nowISO: '2026-10-09T18:00:00.000Z' }))
    expect(next.interviews.find((i) => i.id === 'i-next')?.status).toBe('cancelled')
    expect(next.interviews.find((i) => i.id === 'i-past')?.status).toBe('completed')
    expect(next.scorecards.map((x) => x.id)).toEqual(['s-past'])
    // Nobody is nagged for a card on a candidate who is already hired.
    expect(scorecardsOwed(next, 'p-founder', '2026-10-14T12:00:00.000Z')).toEqual([])
  })

  it('is idempotent once hired', () => {
    const first = run(hiringDB(), (d) => hireFromOffer(d, 'o-lucas', { date: TODAY }))
    const again = run(first.db, (d) => hireFromOffer(d, 'o-lucas', { date: TODAY }))
    expect(again.result).toBe('p-lucas')
    expect(again.db.people).toHaveLength(2)
    expect(again.db.checklists).toHaveLength(1)
  })

  it('refuses an offer that is not accepted', () => {
    const db = hiringDB()
    db.offers[0].status = 'sent'
    expect(() => run(db, (d) => hireFromOffer(d, 'o-lucas', { date: TODAY }))).toThrow(/accepted/)
  })

  it('keeps ids and work emails unique', () => {
    const db = hiringDB()
    addPerson(db, 'p-lucas', { workEmail: 'lucas@ledgerlark.com' })
    const { db: next, result } = run(db, (d) => hireFromOffer(d, 'o-lucas', { date: TODAY }))
    expect(result).toBe('p-lucas-ferreira')
    expect(next.people.find((p) => p.id === result)?.workEmail).toBe('lucas.ferreira@ledgerlark.com')
    expect(next.people.find((p) => p.id === result)?.hireNumber).toBe(3)
  })

  it('creates a grant at the current 409A when none was reserved', () => {
    const { db } = run(hiringDB({ reserved: false }), (d) => hireFromOffer(d, 'o-lucas', { date: TODAY }))
    expect(db.grants).toEqual([
      expect.objectContaining({ personId: 'p-lucas', status: 'promised', strikePrice: 1.15, vestingStart: START, shares: 30_000, cliffMonths: 12, fromOfferId: 'o-lucas' }),
    ])
  })

  it('adds a new-state checklist for the first remote hire outside California', () => {
    const { db } = run(hiringDB({ location: 'Austin, Texas', workMode: 'remote' }), (d) => hireFromOffer(d, 'o-lucas', { date: TODAY }))
    const p = db.people.find((x) => x.id === 'p-lucas')
    expect(p).toMatchObject({ homeCity: 'Austin', homeState: 'TX', workMode: 'remote' })
    expect(db.checklists.map((c) => c.templateId)).toEqual(['tpl-onboarding', 'tpl-new-state'])
    const onb = db.checklists[0]
    expect(task(onb, 'on-new-state')).toBeDefined()
    expect(task(onb, 'on-remote-setup')).toBeDefined()
    expect(task(onb, 'on-de34')).toBeUndefined()
    expect(task(db.checklists[1], 'ns-register')?.dueOn).toBe('2026-10-12')
  })

  it('skips the new-state checklist when someone already works from that state', () => {
    const db = hiringDB({ location: 'Austin, TX', workMode: 'remote' })
    addPerson(db, 'p-caleb', { homeState: 'TX', homeCity: 'Austin', workMode: 'remote' })
    const { db: next } = run(db, (d) => hireFromOffer(d, 'o-lucas', { date: TODAY }))
    expect(next.checklists.map((c) => c.templateId)).toEqual(['tpl-onboarding'])
    expect(task(next.checklists[0], 'on-new-state')?.note).toMatch(/already set up/)
  })

  it('places an onsite hire who lives out of state at the office', () => {
    const { db } = run(hiringDB({ location: 'Austin, TX' }), (d) => hireFromOffer(d, 'o-lucas', { date: TODAY }))
    expect(db.people.find((x) => x.id === 'p-lucas')).toMatchObject({ homeState: 'CA', homeCity: 'San Jose' })
  })

  it('keeps the job open while another offer is outstanding', () => {
    const db = hiringDB({ referred: false })
    db.offers.push({ ...db.offers[0], id: 'o-other', applicationId: 'a-other', candidateId: 'c-other', status: 'sent', backgroundCheck: undefined })
    const { db: next } = run(db, (d) => hireFromOffer(d, 'o-lucas', { date: TODAY }))
    expect(next.jobs[0].status).toBe('open')
    expect(next.plan[0].status).toBe('filled')
    expect(next.referrals).toHaveLength(0)
  })
})

describe('hirePreview', () => {
  it('shows the threshold a hire crosses on the start date', () => {
    const db = hiringDB()
    addPerson(db, 'p-a')
    addPerson(db, 'p-b')
    addPerson(db, 'p-c')
    expect(hirePreview(db, 'o-lucas')).toEqual({ date: START, headcountBefore: 4, headcountAfter: 5, crossesThresholds: [5] })
  })

  it('does not count the person twice after the hire', () => {
    const { db } = run(hiringDB(), (d) => hireFromOffer(d, 'o-lucas', { date: TODAY }))
    expect(hirePreview(db, 'o-lucas')).toMatchObject({ headcountBefore: 1, headcountAfter: 2, crossesThresholds: [] })
  })

  it('ignores people who start after the hire', () => {
    const db = hiringDB()
    for (const id of ['p-a', 'p-b', 'p-c']) addPerson(db, id)
    addPerson(db, 'p-later', { startDate: '2026-11-02' })
    expect(hirePreview(db, 'o-lucas').headcountAfter).toBe(5)
  })
})

describe('parsing helpers', () => {
  it('parses city and state', () => {
    expect(parseCityState('Sunnyvale, CA')).toEqual({ city: 'Sunnyvale', state: 'CA' })
    expect(parseCityState('Denver, Colorado, USA')).toEqual({ city: 'Denver', state: 'CO' })
    expect(parseCityState('San Jose, CA 95113')).toEqual({ city: 'San Jose', state: 'CA' })
    expect(parseCityState('Remote')).toEqual({})
    expect(parseCityState(undefined)).toEqual({})
  })

  it('derives the company domain from the website or the founder email, never from the name', () => {
    expect(companyDomain({ website: 'https://www.ledgerlark.com/about' })).toBe('ledgerlark.com')
    expect(companyDomain({ website: 'https://www.ledgerlark.com/about' }, 'maya@other.com')).toBe('ledgerlark.com')
    expect(companyDomain({}, 'Maya@TallyHawk.io')).toBe('tallyhawk.io')
    // A personal mailbox says nothing about the company domain
    expect(companyDomain({}, 'test.only.ledgerlark@gmail.com')).toBeNull()
    expect(companyDomain({})).toBeNull()
    expect(companyDomain({ website: '  ' }, '')).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// Offboarding
// ---------------------------------------------------------------------------------------------

describe('startOffboarding', () => {
  it('returns every option before the cliff and pays on the last day after notice', () => {
    const db = baseDB()
    addPerson(db, 'p-kofi', { startDate: '2026-01-12' })
    db.grants.push(grant('g-kofi', 'p-kofi'))
    db.documents.push({ id: 'doc-1', personId: 'p-kofi', type: 'i9_section2', name: 'I-9', status: 'filed', date: '2026-01-14' })
    db.documents.push({ id: 'doc-2', personId: 'p-kofi', type: 'piia', name: 'PIIA', status: 'signed', date: '2026-01-08' })
    const sep = { type: 'resigned_notice' as const, reason: 'Joined a later-stage company', lastDay: '2026-10-30', noticeGivenOn: '2026-10-16', rehireEligible: true }
    const { db: next, result: ckId } = run(db, (d) => startOffboarding(d, 'p-kofi', sep, { date: '2026-10-16' }))
    const p = next.people.find((x) => x.id === 'p-kofi')
    expect(p?.endDate).toBe('2026-10-30')
    expect(p?.separation).toMatchObject({ type: 'resigned_notice', finalPayDueOn: '2026-10-30', vestedAtSeparation: 0, rehireEligible: true, noticeGivenOn: '2026-10-16' })
    expect(p?.separation?.exerciseDeadline).toBeUndefined()
    expect(next.grants[0]).toMatchObject({ status: 'cancelled', cancelledShares: 48_000, cancelledOn: '2026-10-30' })

    const cl = next.checklists.find((c) => c.id === ckId)
    expect(cl).toMatchObject({ kind: 'offboarding', anchorDate: '2026-10-30', separationType: 'resigned_notice' })
    expect(task(cl, 'off-final-pay-notice')).toMatchObject({ dueOn: '2026-10-30', statutory: true, dueRuleText: 'Last day' })
    expect(task(cl, 'off-separation-notices')).toBeUndefined()
    expect(task(cl, 'off-separation-notices-optional')).toBeDefined()
    expect(task(cl, 'off-exit-note')?.note).toBe('Unvested options return to the pool. Share counts are on the Equity tab.')
    expect(task(cl, 'off-rehire')).toMatchObject({ status: 'done', note: 'Rehire eligible: yes.' })
    expect(task(cl, 'off-retention')?.status).toBe('done')
    expect(task(cl, 'off-reassign-reports')).toBeUndefined()

    const keep = retentionDates({ startDate: '2026-01-12' }, '2026-10-30')
    expect(keep).toEqual({ personnelUntil: '2030-10-30', payrollUntil: '2029-10-30', i9Until: '2029-01-12' })
    expect(next.documents.find((d) => d.id === 'doc-1')?.retainUntil).toBe('2029-01-12')
    expect(next.documents.find((d) => d.id === 'doc-2')?.retainUntil).toBe('2030-10-30')

    expect(headcountOn(next, '2026-10-30')).toBe(2)
    expect(headcountOn(next, '2026-10-31')).toBe(1)

    // Recording the same separation again keeps the first checklist
    const again = run(next, (d) => startOffboarding(d, 'p-kofi', sep, { date: '2026-10-16' }))
    expect(again.result).toBe(ckId)
    expect(again.db.checklists).toHaveLength(1)
  })

  it('keeps vested options after the cliff and cancels the rest', () => {
    const db = baseDB()
    addPerson(db, 'p-omar', { startDate: '2025-05-12' })
    db.grants.push(grant('g-omar', 'p-omar', { vestingStart: '2025-05-12' }))
    db.grants.push(grant('g-omar-refresh', 'p-omar', { shares: 5_000, status: 'promised', boardApprovedOn: undefined }))
    const sep = { type: 'resigned_notice' as const, reason: 'Moved', lastDay: '2026-08-28', noticeGivenOn: '2026-08-14' }
    const { db: next } = run(db, (d) => startOffboarding(d, 'p-omar', sep, { date: '2026-08-14' }))
    expect(next.grants[0]).toMatchObject({ status: 'approved', cancelledShares: 33_000, cancelledOn: '2026-08-28' })
    expect(next.grants[1]).toMatchObject({ status: 'cancelled', cancelledShares: 5_000 })
    const s = next.people.find((x) => x.id === 'p-omar')?.separation
    expect(s).toMatchObject({ vestedAtSeparation: 15_000, exerciseDeadline: '2026-11-26' })
    const cl = next.checklists[0]
    expect(task(cl, 'off-exit-note')?.note).toBe('Vested options can be exercised until Nov 26, 2026. Unvested options return to the pool. Share counts are on the Equity tab.')
    expect(next.activity.find((a) => a.kind === 'options_returned')?.text).toBe('Returned unvested options from Omar Tester to the pool')
    expect(task(cl, 'off-rehire')?.status).toBe('open')
  })

  it('terminations: final pay at the meeting, EDD notices, reports to reassign', () => {
    const db = baseDB()
    addPerson(db, 'p-tomas')
    addPerson(db, 'p-kwame', { managerId: 'p-tomas', firstName: 'Kwame', lastName: 'Mensah' })
    addPerson(db, 'p-wei', { managerId: 'p-tomas', firstName: 'Wei', lastName: 'Chen' })
    const sep = { type: 'terminated' as const, reason: 'Performance', lastDay: '2026-10-21' }
    const { db: next } = run(db, (d) => startOffboarding(d, 'p-tomas', sep, { date: '2026-10-21' }))
    const cl = next.checklists[0]
    expect(task(cl, 'off-final-pay-termination')).toMatchObject({ dueOn: '2026-10-21', statutory: true })
    expect(task(cl, 'off-separation-notices')?.statutory).toBe(true)
    expect(task(cl, 'off-reassign-reports')?.note).toBe('Reassign Kwame Mensah and Wei Chen.')
    expect(task(cl, 'off-exit-note')).toBeUndefined()
    expect(next.activity.some((a) => a.kind === 'offboarding_started' && a.text.includes('terminated, last day Wed, Oct 21'))).toBe(true)
  })

  it('resignations without enough notice get 72 hours', () => {
    const db = baseDB()
    addPerson(db, 'p-a')
    const short = run(db, (d) =>
      startOffboarding(d, 'p-a', { type: 'resigned_notice', reason: 'Left', lastDay: '2026-10-30', noticeGivenOn: '2026-10-29' }, { date: '2026-10-29' }),
    ).db
    expect(short.people[1].separation?.finalPayDueOn).toBe('2026-11-02')
    expect(task(short.checklists[0], 'off-final-pay-notice')).toMatchObject({ dueOn: '2026-11-02', title: 'Final paycheck paid within 72 hours' })

    const walkout = run(db, (d) => startOffboarding(d, 'p-a', { type: 'resigned_no_notice', reason: 'Left', lastDay: '2026-10-30' }, { date: '2026-10-30' })).db
    expect(task(walkout.checklists[0], 'off-final-pay-72h')).toMatchObject({ dueOn: '2026-11-02', dueRuleText: 'Within 72 hours of the last day' })
  })

  it('marks vacation payout not applicable without an accrued vacation policy', () => {
    const db = baseDB()
    addPerson(db, 'p-a')
    db.timeOffPolicies = db.timeOffPolicies.filter((p) => p.kind !== 'vacation')
    const { db: next } = run(db, (d) => startOffboarding(d, 'p-a', { type: 'laid_off', reason: 'Restructure', lastDay: '2026-10-30' }, { date: '2026-10-30' }))
    expect(task(next.checklists[0], 'off-vacation-payout')?.status).toBe('not_applicable')
  })
})

// ---------------------------------------------------------------------------------------------
// Change job or pay
// ---------------------------------------------------------------------------------------------

function changeDB(): DB {
  const db = baseDB()
  addPerson(db, 'p-lena', { firstName: 'Lena', lastName: 'Park', levelId: 'lv-l4', startDate: '2025-06-23' })
  addPerson(db, 'p-kwame', { firstName: 'Kwame', lastName: 'Mensah', title: 'Frontend engineer', startDate: '2025-11-03' })
  addPerson(db, 'p-sofia', { startDate: '2026-01-12' })
  addPerson(db, 'p-nikhil', { startDate: '2026-04-06' })
  const hire: CompRecord = {
    id: 'cr-kwame-hire',
    personId: 'p-kwame',
    effectiveOn: '2025-11-03',
    payType: 'salary',
    salary: 172_000,
    variablePct: 0.05,
    title: 'Frontend engineer',
    levelId: 'lv-l2',
    managerId: 'p-founder',
    departmentId: 'd-eng',
    flsa: 'exempt',
    reason: 'hire',
    exceptionReason: 'Founding, equity-heavy',
  }
  db.comp.push(hire)
  return db
}

describe('changeJobOrPay', () => {
  it('writes history, queues a refresh grant and assigns supervisor training for a first direct report', () => {
    const change = {
      effectiveOn: '2027-01-01',
      reason: 'promotion' as const,
      title: 'Senior frontend engineer',
      levelId: 'lv-l3',
      managerId: 'p-lena',
      salary: 192_000,
      approvedById: 'p-founder',
      refreshGrantShares: 12_000,
    }
    const { db, result: crId } = run(changeDB(), (d) => changeJobOrPay(d, 'p-kwame', change, { date: TODAY }))
    const rows = db.comp.filter((c) => c.personId === 'p-kwame')
    expect(rows).toHaveLength(2)
    const row = rows.find((c) => c.id === crId)
    expect(row).toMatchObject({
      effectiveOn: '2027-01-01',
      payType: 'salary',
      salary: 192_000,
      variablePct: 0.05,
      title: 'Senior frontend engineer',
      levelId: 'lv-l3',
      managerId: 'p-lena',
      departmentId: 'd-eng',
      flsa: 'exempt',
      reason: 'promotion',
      approvedById: 'p-founder',
      approvedOn: TODAY,
    })
    expect(row?.exceptionReason).toBeUndefined()
    expect(row?.appliedOn).toBeUndefined()

    // Future-dated: the person keeps today's job until it takes effect
    const kwame = db.people.find((p) => p.id === 'p-kwame')
    expect(kwame).toMatchObject({ title: 'Frontend engineer', managerId: 'p-founder' })
    expect(currentJob(db, 'p-kwame', '2026-12-31')?.id).toBe('cr-kwame-hire')
    expect(currentJob(db, 'p-kwame', '2027-01-01')?.id).toBe(crId)

    expect(db.trainings).toEqual([expect.objectContaining({ personId: 'p-lena', kind: 'harassment_supervisor', dueOn: '2027-07-01' })])
    const cl = db.checklists.find((c) => c.templateId === 'tpl-change')
    expect(cl).toMatchObject({ personId: 'p-kwame', kind: 'change', anchorDate: '2027-01-01', createdOn: TODAY })
    expect(task(cl, 'ch-payroll')?.dueOn).toBe('2026-12-18')
    expect(task(cl, 'ch-supervisor-training')).toMatchObject({ dueOn: '2027-07-01', statutory: true })
    expect(task(cl, 'ch-supervisor-training')?.note).toMatch(/Lena Park/)
    expect(task(cl, 'ch-refresh-grant')).toBeDefined()
    expect(task(cl, 'ch-wage-notice')).toBeUndefined()
    expect(db.grants).toEqual([expect.objectContaining({ personId: 'p-kwame', shares: 12_000, status: 'promised', strikePrice: 1.15, vestingStart: '2027-01-01' })])
    const logged = db.activity.find((a) => a.kind === 'job_changed')
    expect(logged?.text).toBe('Recorded a promotion for Kwame Mensah, effective Jan 1, 2027 (title Senior frontend engineer, reports to Lena Park, pay updated, refresh grant queued)')
    // No pay or equity amounts in activity text (the only digits are the date)
    expect(logged?.text.replace('Jan 1, 2027', '')).not.toMatch(/\d|\$/)
    expect(row?.scheduled).toBe(true)
    expect(task(cl, 'ch-supervisor-training')?.assigneeId).toBe('p-lena')
    expect(task(cl, 'ch-refresh-grant')?.note).not.toMatch(/\d/)

    // On the effective date the scheduled change lands on the person, once
    const later = run(db, (d) => applyScheduledChanges(d, '2027-01-01'))
    expect(later.result).toBe(1)
    expect(later.db.people.find((p) => p.id === 'p-kwame')).toMatchObject({ title: 'Senior frontend engineer', levelId: 'lv-l3', managerId: 'p-lena' })
    expect(run(later.db, (d) => applyScheduledChanges(d, '2027-01-02')).result).toBe(0)
  })

  it('updates the person now when already effective and gives non-exempt staff a 7-day notice', () => {
    const db = changeDB()
    addPerson(db, 'p-luis', { flsa: 'non_exempt', employmentType: 'part_time', hoursPerWeek: 24, title: 'Office coordinator' })
    db.comp.push({ id: 'cr-luis', personId: 'p-luis', effectiveOn: '2025-06-01', payType: 'hourly', hourlyRate: 28, title: 'Office coordinator', levelId: 'lv-l1', flsa: 'non_exempt', reason: 'hire' })
    const { db: next, result } = run(db, (d) => changeJobOrPay(d, 'p-luis', { effectiveOn: TODAY, reason: 'merit', hourlyRate: 30 }, { date: TODAY }))
    expect(next.comp.find((c) => c.id === result)).toMatchObject({ payType: 'hourly', hourlyRate: 30, appliedOn: TODAY, title: 'Office coordinator' })
    const cl = next.checklists[0]
    expect(task(cl, 'ch-wage-notice')).toMatchObject({ dueOn: '2026-10-16', statutory: true })
    expect(task(cl, 'ch-supervisor-training')).toBeUndefined()

    const titleOnly = run(db, (d) => changeJobOrPay(d, 'p-luis', { effectiveOn: TODAY, reason: 'title_only', title: 'Office and events coordinator' }, { date: TODAY }))
    expect(task(titleOnly.db.checklists[0], 'ch-wage-notice')).toBeUndefined()
    expect(titleOnly.db.people.find((p) => p.id === 'p-luis')?.title).toBe('Office and events coordinator')
  })

  it('assigns no training under 5 workers or when the manager already has reports', () => {
    const small = baseDB()
    addPerson(small, 'p-lena')
    addPerson(small, 'p-kwame')
    const a = run(small, (d) => changeJobOrPay(d, 'p-kwame', { effectiveOn: TODAY, reason: 'manager_change', managerId: 'p-lena' }, { date: TODAY }))
    expect(a.db.trainings).toHaveLength(0)
    expect(task(a.db.checklists[0], 'ch-supervisor-training')).toBeUndefined()

    const db = changeDB()
    db.people.find((p) => p.id === 'p-sofia')!.managerId = 'p-lena'
    const b = run(db, (d) => changeJobOrPay(d, 'p-kwame', { effectiveOn: TODAY, reason: 'manager_change', managerId: 'p-lena' }, { date: TODAY }))
    expect(b.db.trainings).toHaveLength(0)
    expect(b.db.people.find((p) => p.id === 'p-kwame')?.managerId).toBe('p-lena')
  })

  it('dates the payroll update two weeks ahead, never in the past', () => {
    expect(payrollUpdateDue('2027-01-01', TODAY)).toBe('2026-12-18')
    expect(payrollUpdateDue(TODAY, TODAY)).toBe('2026-10-12')
  })
})

// ---------------------------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------------------------

describe('startLeave', () => {
  it('sets the designation notice 5 business days after the request and builds the leave checklist', () => {
    const db = baseDB()
    addPerson(db, 'p-tomas', { startDate: '2025-05-12', firstName: 'Tomas', lastName: 'Herrera' })
    for (const id of ['p-a', 'p-b', 'p-c']) addPerson(db, id)
    const leave = { personId: 'p-tomas', kind: 'bonding' as const, requestedOn: '2026-10-06', startDate: '2026-11-16', expectedReturn: '2027-01-08' }
    const { db: next, result: id } = run(db, (d) => startLeave(d, leave, { date: '2026-10-06' }))
    expect(next.leaveCases).toEqual([expect.objectContaining({ id, designationNoticeDueOn: '2026-10-13', kind: 'bonding' })])
    const cl = next.checklists[0]
    expect(cl).toMatchObject({ kind: 'leave', anchorDate: '2026-11-16' })
    expect(task(cl, 'lv-designation')).toMatchObject({ dueOn: '2026-10-13', statutory: false })
    expect(task(cl, 'lv-edd')?.dueOn).toBe('2026-10-07')
    expect(task(cl, 'lv-lactation')?.title).toBe('Policy packet shared')
    expect(task(cl, 'lv-benefits')).toBeDefined()
    expect(task(cl, 'lv-coverage')?.dueOn).toBe('2026-11-09')
    expect(task(cl, 'lv-return')?.dueOn).toBe('2027-01-08')
    expect(task(cl, 'lv-separation-notices')).toMatchObject({ dueOn: '2026-11-16', statutory: true })
    const logged = next.activity.find((a) => a.kind === 'leave_opened')
    expect(logged?.text).toBe('Opened a protected leave case for Tomas Herrera, starting Mon, Nov 16')
  })

  it('skips company holidays and parental-only tasks', () => {
    const db = baseDB()
    addPerson(db, 'p-a')
    const leave = { personId: 'p-a', kind: 'military' as const, requestedOn: '2026-11-23', startDate: '2027-01-04' }
    const { db: next } = run(db, (d) => startLeave(d, leave, { date: '2026-11-23' }))
    expect(next.leaveCases[0].designationNoticeDueOn).toBe('2026-12-02')
    const cl = next.checklists[0]
    expect(task(cl, 'lv-lactation')).toBeUndefined()
    expect(task(cl, 'lv-benefits')).toBeUndefined()
    expect(task(cl, 'lv-return')?.dueOn).toBe('2027-03-29')
  })
})

describe('markDesignationSent', () => {
  function onLeave() {
    const db = baseDB()
    addPerson(db, 'p-tomas', { startDate: '2025-05-12', firstName: 'Tomas', lastName: 'Herrera' })
    for (const pid of ['p-a', 'p-b', 'p-c']) addPerson(db, pid)
    const leave = { personId: 'p-tomas', kind: 'bonding' as const, requestedOn: '2026-10-06', startDate: '2026-11-16', expectedReturn: '2027-01-08' }
    const { db: next, result: id } = run(db, (d) => startLeave(d, leave, { date: '2026-10-06' }))
    return { db: structuredClone(next), id }
  }

  it('dates the case, closes the leave checklist task and logs once without the leave type', () => {
    const { db, id } = onLeave()
    const { db: next, result } = run(db, (d) => [
      markDesignationSent(d, id, { date: TODAY, byId: 'p-founder' }),
      markDesignationSent(d, id, { date: TODAY }),
    ])
    expect(result).toEqual([true, false])
    expect(next.leaveCases[0].designationNoticeSentOn).toBe(TODAY)
    expect(task(next.checklists[0], 'lv-designation')).toMatchObject({ status: 'done', doneOn: TODAY, doneById: 'p-founder' })
    const logged = next.activity.filter((a) => a.entityId === id && a.kind === 'leave_notice_sent')
    expect(logged).toHaveLength(1)
    expect(logged[0].text).toBe('Recorded the leave response notice as sent to Tomas Herrera')
    expect(logged[0].text).not.toMatch(/bonding|CFRA|FMLA/i)
  })

  it('closes the task on the checklist for this leave when the person has an older leave checklist', () => {
    const { db, id } = onLeave()
    const older = structuredClone(db.checklists[0])
    older.id = 'ck-older'
    older.anchorDate = '2025-12-01'
    db.checklists.unshift(older)
    const { db: next } = run(db, (d) => markDesignationSent(d, id, { date: TODAY }))
    expect(task(next.checklists.find((c) => c.id === 'ck-older'), 'lv-designation')?.status).toBe('open')
    expect(task(next.checklists.find((c) => c.id !== 'ck-older'), 'lv-designation')?.status).toBe('done')
  })

  it('returns false for a missing case and changes nothing', () => {
    const { db } = onLeave()
    const { db: next, result } = run(db, (d) => markDesignationSent(d, 'lc-missing', { date: TODAY }))
    expect(result).toBe(false)
    expect(next).toBe(db)
  })
})

describe('leaveEligibility', () => {
  function staffed(): DB {
    const db = baseDB()
    addPerson(db, 'p-tomas', { startDate: '2025-05-12' })
    addPerson(db, 'p-sofia', { startDate: '2026-01-12' })
    addPerson(db, 'p-luis', { startDate: '2025-05-12', employmentType: 'part_time', hoursPerWeek: 20, flsa: 'non_exempt' })
    addPerson(db, 'p-b')
    return db
  }

  it('CFRA needs 5+ employees, more than 12 months and 1,250 hours', () => {
    const db = staffed()
    expect(leaveEligibility(db, 'p-tomas', 'cfra', '2026-11-16')).toMatchObject({ eligible: true, monthsOfService: 18 })
    const sofia = leaveEligibility(db, 'p-sofia', 'bonding', '2026-11-16')
    expect(sofia.eligible).toBe(false)
    expect(sofia.reasons.join(' ')).toMatch(/more than 12 months/)
    const luis = leaveEligibility(db, 'p-luis', 'cfra', '2026-11-16')
    expect(luis.eligible).toBe(false)
    expect(luis.estimatedHours).toBe(1043)
  })

  it('PDL has no service requirement but needs 5+ employees', () => {
    const db = staffed()
    expect(leaveEligibility(db, 'p-sofia', 'pdl', '2026-11-16').eligible).toBe(true)
    const small = baseDB()
    addPerson(small, 'p-a')
    const r = leaveEligibility(small, 'p-a', 'pdl', '2026-11-16')
    expect(r.eligible).toBe(false)
    expect(r.reasons[0]).toMatch(/5 or more employees/)
  })
})

// ---------------------------------------------------------------------------------------------
// Plan line to job
// ---------------------------------------------------------------------------------------------

describe('openJobFromPlan', () => {
  function planDB(): DB {
    const db = baseDB()
    db.plan.push({
      id: 'ps-pm',
      quarter: '2027-Q2',
      title: 'Product manager, close and reconciliation',
      departmentId: 'd-product',
      familyId: 'f-eng',
      levelId: 'lv-l3',
      targetStart: '2027-04-05',
      status: 'planned',
    })
    return db
  }

  it('opens a draft job with the band range and default stages', () => {
    const { db, result: id } = run(planDB(), (d) => openJobFromPlan(d, 'ps-pm', { date: TODAY, hiringManagerId: 'p-founder' }))
    expect(id).toBe('j-product-manager-close-and-reconciliation')
    const job = db.jobs.find((j) => j.id === id)
    expect(job).toMatchObject({ status: 'draft', payMin: 180_000, payMax: 230_000, planSlotId: 'ps-pm', hiringManagerId: 'p-founder', openedOn: TODAY, targetStart: '2027-04-05' })
    expect(job?.stages.map((s) => s.id)).toEqual(['new', 'intro', 'technical', 'onsite', 'offer', 'hired'])
    expect(db.plan[0]).toMatchObject({ status: 'open', jobId: id })
    expect(run(db, (d) => openJobFromPlan(d, 'ps-pm', { date: TODAY, hiringManagerId: 'p-founder' })).result).toBe(id)
  })

  it('uses a role template for stages, interview plan and description', () => {
    const db = planDB()
    db.settings.roleTemplates = [
      {
        id: 'rt-pm',
        name: 'Product manager',
        familyId: 'f-eng',
        levelId: 'lv-l3',
        departmentId: 'd-product',
        jdOutline: 'Own the close and reconciliation roadmap.',
        stages: DEFAULT_STAGES.filter((s) => s.id !== 'technical').map((s) => ({ ...s })),
        interviewPlan: [{ id: 'st-intro', stageId: 'intro', name: 'Intro call', durationMin: 30, attributes: [{ name: 'Customer empathy' }] }],
      },
    ]
    const { db: next, result: id } = run(db, (d) => openJobFromPlan(d, 'ps-pm', { date: TODAY, hiringManagerId: 'p-founder', roleTemplateId: 'rt-pm' }))
    const job = next.jobs.find((j) => j.id === id)
    expect(job?.roleTemplateId).toBe('rt-pm')
    expect(job?.stages).toHaveLength(5)
    expect(job?.interviewPlan).toEqual([expect.objectContaining({ id: 'st-intro', interviewerIds: [] })])
    expect(job?.description).toBe('Own the close and reconciliation roadmap.')
  })
})

// ---------------------------------------------------------------------------------------------
// Review fixes: exits close what they make moot, history-safe changes, backfills
// ---------------------------------------------------------------------------------------------

describe('startOffboarding closes what the exit makes moot', () => {
  const sep = { type: 'resigned_notice' as const, reason: 'Moved', lastDay: '2026-10-30', noticeGivenOn: '2026-10-16' }

  it('closes onboarding tasks due after the last day, pending trainings and an open leave case', () => {
    const db = baseDB()
    for (const id of ['p-a', 'p-b', 'p-c']) addPerson(db, id)
    const lena = addPerson(db, 'p-lena', { startDate: '2026-08-03' })
    const onb = generateChecklist(db, { person: lena, templateId: 'tpl-onboarding', anchorDate: lena.startDate, createdOn: '2026-07-20', id: 'ck-lena' })
    expect(task(onb, 'on-harassment-training')?.dueOn).toBe('2027-02-03')
    for (const t of onb.tasks) if (t.dueOn <= sep.lastDay) t.status = 'done'
    db.checklists.push(onb)
    db.trainings.push({ id: 'trn-1', personId: 'p-lena', kind: 'harassment_employee', dueOn: '2027-02-03' })
    db.trainings.push({ id: 'trn-2', personId: 'p-lena', kind: 'security_awareness', dueOn: '2026-09-02', completedOn: '2026-08-20' })
    db.leaveCases.push({ id: 'lc-1', personId: 'p-lena', kind: 'pdl', requestedOn: '2026-10-01', startDate: '2026-10-12', expectedReturn: '2026-12-14' })

    const { db: next } = run(db, (d) => startOffboarding(d, 'p-lena', sep, { date: '2026-10-16' }))
    const cl = next.checklists.find((c) => c.id === 'ck-lena')
    expect(task(cl, 'on-harassment-training')).toMatchObject({ status: 'not_applicable', note: 'Left on Oct 30, 2026.' })
    expect(task(cl, 'on-checkin-90')?.status).toBe('not_applicable')
    expect(cl?.completedOn).toBe('2026-10-16')
    // A year later nothing from onboarding is open or red
    expect(checklistProgress(cl as Checklist, '2027-10-30')).toMatchObject({ open: 0, overdue: 0, statutoryOverdue: 0 })
    expect(openTasks(next, '2027-10-30', { personId: 'p-lena' }).every((x) => x.checklist.kind === 'offboarding')).toBe(true)
    expect(next.trainings.map((t) => t.id)).toEqual(['trn-2'])
    expect(next.leaveCases[0].endedOn).toBe('2026-10-30')
    const cleanup = next.activity.find((a) => a.kind === 'exit_cleanup')
    expect(cleanup?.text).toBe('Closed 2 open tasks, 1 pending training and the open leave case for Lena Tester after the exit on Fri, Oct 30')
  })

  it('keeps the I-9, the new hire report and the ACA notice open after a very early exit', () => {
    const db = baseDB()
    const p = addPerson(db, 'p-quinn', { startDate: START })
    db.checklists.push(generateChecklist(db, { person: p, templateId: 'tpl-onboarding', anchorDate: START, createdOn: TODAY, id: 'ck-quinn' }))
    const { db: next } = run(db, (d) =>
      startOffboarding(d, 'p-quinn', { type: 'resigned_no_notice', reason: 'Left', lastDay: '2026-10-23' }, { date: '2026-10-23' }),
    )
    const cl = next.checklists.find((c) => c.id === 'ck-quinn')
    expect(task(cl, 'on-de34')).toMatchObject({ status: 'open', dueOn: '2026-11-08' })
    expect(task(cl, 'on-notice-aca')?.status).toBe('open')
    expect(task(cl, 'on-i9-section2')).toMatchObject({ status: 'open', dueOn: '2026-10-22' })
    expect(task(cl, 'on-checkin-30')?.status).toBe('not_applicable')
    expect(task(cl, 'on-security-training')?.status).toBe('not_applicable')
  })

  it('closes every onboarding task when the person never started, and skips final pay', () => {
    const db = baseDB()
    const p = addPerson(db, 'p-mei', { startDate: '2026-11-02' })
    db.checklists.push(generateChecklist(db, { person: p, templateId: 'tpl-onboarding', anchorDate: p.startDate, createdOn: TODAY, id: 'ck-mei' }))
    const { db: next, result } = run(db, (d) =>
      startOffboarding(d, 'p-mei', { type: 'resigned_notice', reason: 'Took another offer', lastDay: '2026-10-20', noticeGivenOn: '2026-10-14' }, { date: '2026-10-14' }),
    )
    const onb = next.checklists.find((c) => c.id === 'ck-mei')
    expect(onb?.tasks.length).toBeGreaterThan(20)
    expect(onb?.tasks.every((t) => t.status === 'not_applicable' && t.note === 'Left on Oct 20, 2026, before the start date.')).toBe(true)
    expect(onb?.completedOn).toBe('2026-10-14')
    const off = next.checklists.find((c) => c.id === result)
    for (const id of ['off-final-pay-notice', 'off-vacation-payout', 'off-separation-notices-optional', 'off-cobra', 'off-hipp']) {
      expect(task(off, id)?.status, id).toBe('not_applicable')
    }
    expect(task(off, 'off-access')?.status).toBe('open')
  })

  it('decides the vacation payout by the policies that cover the person', () => {
    const db = baseDB()
    addPerson(db, 'p-ex')
    addPerson(db, 'p-hourly', { flsa: 'non_exempt' })
    // Copies: the default policy objects are shared and frozen by earlier produce calls
    db.timeOffPolicies = db.timeOffPolicies.map((p) => (p.kind === 'vacation' ? { ...p, appliesTo: 'non_exempt' as const } : p))
    db.timeOffPolicies.push({ id: 'pol-flex', name: 'Flexible vacation', kind: 'flexible_vacation', method: 'flexible', paidOutOnExit: false, appliesTo: 'exempt', description: 'Take what you need.' })
    const layoff = { type: 'laid_off' as const, reason: 'Restructure', lastDay: '2026-10-30' }
    const ex = run(db, (d) => startOffboarding(d, 'p-ex', layoff, { date: '2026-10-30' })).db
    expect(task(ex.checklists[0], 'off-vacation-payout')?.status).toBe('not_applicable')
    const hourly = run(db, (d) => startOffboarding(d, 'p-hourly', layoff, { date: '2026-10-30' })).db
    expect(task(hourly.checklists[0], 'off-vacation-payout')?.status).toBe('open')
    // A capped "flexible" policy is really vacation, so it is paid
    db.timeOffPolicies = db.timeOffPolicies.map((p) => (p.id === 'pol-flex' ? { ...p, capHours: 160 } : p))
    const capped = run(db, (d) => startOffboarding(d, 'p-ex', layoff, { date: '2026-10-30' })).db
    expect(task(capped.checklists[0], 'off-vacation-payout')?.status).toBe('open')
  })
})

describe('changeJobOrPay keeps history and the person in step', () => {
  function promoted(): DB {
    const db = changeDB()
    db.comp.push({
      id: 'cr-kwame-promo',
      personId: 'p-kwame',
      effectiveOn: '2026-09-01',
      payType: 'salary',
      salary: 185_000,
      variablePct: 0.05,
      title: 'Senior frontend engineer',
      levelId: 'lv-l3',
      managerId: 'p-founder',
      departmentId: 'd-eng',
      flsa: 'exempt',
      reason: 'promotion',
      appliedOn: '2026-09-01',
    })
    const kwame = db.people.find((p) => p.id === 'p-kwame')
    if (kwame) Object.assign(kwame, { title: 'Senior frontend engineer', levelId: 'lv-l3' })
    return db
  }

  it('a backdated correction fixes history without overwriting the current job', () => {
    const { db, result } = run(promoted(), (d) =>
      changeJobOrPay(d, 'p-kwame', { effectiveOn: '2026-08-01', reason: 'correction', title: 'Frontend engineer II' }, { date: TODAY }),
    )
    expect(db.people.find((p) => p.id === 'p-kwame')).toMatchObject({ title: 'Senior frontend engineer', levelId: 'lv-l3' })
    expect(currentJob(db, 'p-kwame', TODAY)?.id).toBe('cr-kwame-promo')
    expect(currentJob(db, 'p-kwame', '2026-08-15')?.title).toBe('Frontend engineer II')
    const row = db.comp.find((c) => c.id === result)
    expect(row?.appliedOn).toBe(TODAY)
    expect(row?.scheduled).toBeUndefined()
    // The later promotion set its own title, so it keeps it
    expect(db.comp.find((c) => c.id === 'cr-kwame-promo')?.title).toBe('Senior frontend engineer')
    expect(run(db, (d) => applyScheduledChanges(d, TODAY)).result).toBe(0)
  })

  it('carries a backdated manager change into the later row that held the old manager', () => {
    const { db } = run(promoted(), (d) => changeJobOrPay(d, 'p-kwame', { effectiveOn: '2026-08-01', reason: 'manager_change', managerId: 'p-lena' }, { date: TODAY }))
    expect(db.comp.find((c) => c.id === 'cr-kwame-promo')?.managerId).toBe('p-lena')
    expect(db.people.find((p) => p.id === 'p-kwame')).toMatchObject({ managerId: 'p-lena', title: 'Senior frontend engineer' })
    expect(db.activity.find((a) => a.kind === 'job_changed')?.text).toMatch(/carried into 1 later change\)$/)
  })

  it('a manager change before an already queued promotion is not reverted when the promotion lands', () => {
    let db = changeDB()
    db = run(db, (d) => changeJobOrPay(d, 'p-kwame', { effectiveOn: '2027-01-01', reason: 'promotion', title: 'Senior frontend engineer' }, { date: TODAY })).db
    db = run(db, (d) => changeJobOrPay(d, 'p-kwame', { effectiveOn: '2026-11-01', reason: 'manager_change', managerId: 'p-lena' }, { date: TODAY })).db
    const jan = db.comp.find((c) => c.personId === 'p-kwame' && c.effectiveOn === '2027-01-01')
    expect(jan).toMatchObject({ managerId: 'p-lena', title: 'Senior frontend engineer', scheduled: true })
    const nov = run(db, (d) => applyScheduledChanges(d, '2026-11-01'))
    expect(nov.result).toBe(1)
    expect(nov.db.people.find((p) => p.id === 'p-kwame')).toMatchObject({ managerId: 'p-lena', title: 'Frontend engineer' })
    const jan1 = run(nov.db, (d) => applyScheduledChanges(d, '2027-01-01'))
    expect(jan1.result).toBe(1)
    expect(jan1.db.people.find((p) => p.id === 'p-kwame')).toMatchObject({ managerId: 'p-lena', title: 'Senior frontend engineer' })
  })

  it('dates the 2810.5 change notice from the effective date', () => {
    const db = changeDB()
    addPerson(db, 'p-luis', { flsa: 'non_exempt', employmentType: 'part_time', hoursPerWeek: 24, title: 'Office coordinator' })
    db.comp.push({ id: 'cr-luis', personId: 'p-luis', effectiveOn: '2025-06-01', payType: 'hourly', hourlyRate: 28, title: 'Office coordinator', levelId: 'lv-l1', flsa: 'non_exempt', reason: 'hire' })
    const future = run(db, (d) => changeJobOrPay(d, 'p-luis', { effectiveOn: '2027-01-01', reason: 'merit', hourlyRate: 30 }, { date: TODAY })).db
    expect(task(future.checklists[0], 'ch-wage-notice')).toMatchObject({ dueOn: '2027-01-08', dueRuleText: '7 days after the change takes effect' })
    const backdated = run(db, (d) => changeJobOrPay(d, 'p-luis', { effectiveOn: '2026-06-01', reason: 'correction', hourlyRate: 29 }, { date: TODAY })).db
    expect(task(backdated.checklists[0], 'ch-wage-notice')?.dueOn).toBe('2026-06-08')
    expect(backdated.checklists[0].tasks.every((t) => !/request/.test(t.dueRuleText ?? ''))).toBe(true)
  })
})

describe('changeJobOrPay records the exemption basis', () => {
  // A non-exempt engineer on a $100K salary: exempt as a computer professional needs far more in 2026.
  function nonExemptEngineer(): DB {
    const db = changeDB()
    addPerson(db, 'p-eli', { firstName: 'Eli', lastName: 'Stone', flsa: 'non_exempt', startDate: '2026-02-02' })
    db.comp.push({ id: 'cr-eli', personId: 'p-eli', effectiveOn: '2026-02-02', payType: 'salary', salary: 100_000, title: 'Software engineer', levelId: 'lv-l2', flsa: 'non_exempt', reason: 'hire' })
    return db
  }

  it('writes the basis on the row and the person when someone becomes exempt today', () => {
    const { db, result } = run(nonExemptEngineer(), (d) =>
      changeJobOrPay(d, 'p-eli', { effectiveOn: TODAY, reason: 'correction', flsa: 'exempt', exemptionBasis: 'computer_professional' }, { date: TODAY }),
    )
    expect(db.comp.find((c) => c.id === result)).toMatchObject({ flsa: 'exempt', exemptionBasis: 'computer_professional' })
    expect(db.people.find((p) => p.id === 'p-eli')).toMatchObject({ flsa: 'exempt', exemptionBasis: 'computer_professional' })
    // The comp table checks the computer professional minimum, not just the general exempt floor
    expect(exemptFlags(db, TODAY).find((f) => f.personId === 'p-eli')?.kind).toBe('computer_professional')
  })

  it('lands the basis with a future-dated change on its effective date', () => {
    const { db, result } = run(nonExemptEngineer(), (d) =>
      changeJobOrPay(d, 'p-eli', { effectiveOn: '2027-01-01', reason: 'market', flsa: 'exempt', exemptionBasis: 'computer_professional' }, { date: TODAY }),
    )
    expect(db.comp.find((c) => c.id === result)).toMatchObject({ scheduled: true, exemptionBasis: 'computer_professional' })
    expect(db.people.find((p) => p.id === 'p-eli')?.exemptionBasis).toBeUndefined()
    const later = run(db, (d) => applyScheduledChanges(d, '2027-01-01'))
    expect(later.result).toBe(1)
    expect(later.db.people.find((p) => p.id === 'p-eli')).toMatchObject({ flsa: 'exempt', exemptionBasis: 'computer_professional' })
    expect(exemptFlags(later.db, '2027-01-01').find((f) => f.personId === 'p-eli')?.kind).toBe('computer_professional')
  })

  it('applies a scheduled change of basis alone (still exempt)', () => {
    const db = changeDB()
    db.people.find((p) => p.id === 'p-kwame')!.exemptionBasis = 'computer_professional'
    const queued = run(db, (d) => changeJobOrPay(d, 'p-kwame', { effectiveOn: '2027-01-01', reason: 'promotion', title: 'Engineering manager', levelId: 'lv-m1', exemptionBasis: 'executive' }, { date: TODAY })).db
    const landed = run(queued, (d) => applyScheduledChanges(d, '2027-01-01')).db
    expect(landed.people.find((p) => p.id === 'p-kwame')).toMatchObject({ levelId: 'lv-m1', exemptionBasis: 'executive' })
  })

  it('carries the basis forward on other changes and drops it for non-exempt rows', () => {
    const db = changeDB()
    db.people.find((p) => p.id === 'p-kwame')!.exemptionBasis = 'computer_professional'
    // The hire row predates basis tracking, so the person's basis is carried onto the new row
    const titled = run(db, (d) => changeJobOrPay(d, 'p-kwame', { effectiveOn: TODAY, reason: 'title_only', title: 'Frontend engineer II' }, { date: TODAY }))
    expect(titled.db.comp.find((c) => c.id === titled.result)?.exemptionBasis).toBe('computer_professional')
    const hourly = run(titled.db, (d) => changeJobOrPay(d, 'p-kwame', { effectiveOn: TODAY, reason: 'correction', flsa: 'non_exempt' }, { date: TODAY }))
    expect(hourly.db.comp.find((c) => c.id === hourly.result)?.exemptionBasis).toBeUndefined()
    expect(hourly.db.people.find((p) => p.id === 'p-kwame')?.exemptionBasis).toBeUndefined()
  })

  it('carries a backdated reclassification into later rows that held the old status', () => {
    const db = nonExemptEngineer()
    db.comp.push({ id: 'cr-eli-raise', personId: 'p-eli', effectiveOn: '2026-09-01', payType: 'salary', salary: 210_000, title: 'Software engineer', levelId: 'lv-l2', flsa: 'non_exempt', reason: 'merit', appliedOn: '2026-09-01' })
    const { db: next } = run(db, (d) =>
      changeJobOrPay(d, 'p-eli', { effectiveOn: '2026-08-01', reason: 'correction', flsa: 'exempt', exemptionBasis: 'computer_professional' }, { date: TODAY }),
    )
    expect(next.comp.find((c) => c.id === 'cr-eli-raise')).toMatchObject({ flsa: 'exempt', exemptionBasis: 'computer_professional' })
    expect(next.people.find((p) => p.id === 'p-eli')).toMatchObject({ flsa: 'exempt', exemptionBasis: 'computer_professional' })
  })
})

describe('applyScheduledChanges', () => {
  it('leaves seeded or imported rows alone', () => {
    const db = baseDB()
    addPerson(db, 'p-a', { title: 'Person title' })
    db.comp.push({ id: 'cr-a', personId: 'p-a', effectiveOn: '2025-06-01', payType: 'salary', salary: 150_000, title: 'Record title', levelId: 'lv-l2', reason: 'hire' })
    const { db: next, result } = run(db, (d) => applyScheduledChanges(d, TODAY))
    expect(result).toBe(0)
    expect(next.people.find((p) => p.id === 'p-a')?.title).toBe('Person title')
    expect(next.activity).toHaveLength(db.activity.length)
  })

  it('never lands a change dated after the last day', () => {
    const db = baseDB()
    addPerson(db, 'p-b', { title: 'Engineer', endDate: '2026-10-30' })
    db.comp.push({ id: 'cr-b', personId: 'p-b', effectiveOn: '2026-11-01', payType: 'salary', title: 'Senior engineer', levelId: 'lv-l3', reason: 'promotion', scheduled: true })
    const { db: next, result } = run(db, (d) => applyScheduledChanges(d, '2026-11-15'))
    expect(result).toBe(0)
    expect(next.people.find((p) => p.id === 'p-b')?.title).toBe('Engineer')
  })
})

describe('openJobFromPlan backfills', () => {
  function planDB(): DB {
    const db = baseDB()
    addPerson(db, 'p-ben', { firstName: 'Ben', lastName: 'Carter', endDate: '2026-09-04' })
    db.plan.push({ id: 'ps-fs', quarter: '2026-Q3', title: 'Senior full-stack engineer', departmentId: 'd-eng', familyId: 'f-eng', levelId: 'lv-l3', targetStart: '2026-06-01', status: 'planned' })
    return db
  }

  it('reopens a filled line as a new backfill job', () => {
    const first = run(planDB(), (d) => openJobFromPlan(d, 'ps-fs', { date: '2026-03-02', hiringManagerId: 'p-founder' }))
    const filled = produce(first.db, (d) => {
      const job = d.jobs.find((j) => j.id === first.result)
      if (job) job.status = 'filled'
      Object.assign(d.plan[0], { status: 'filled', personId: 'p-ben' })
    })
    const { db, result } = run(filled, (d) => openJobFromPlan(d, 'ps-fs', { date: TODAY, hiringManagerId: 'p-founder' }))
    expect(result).not.toBe(first.result)
    expect(result).toBe('j-senior-full-stack-engineer-2')
    expect(db.jobs.find((j) => j.id === result)).toMatchObject({ status: 'draft', isBackfill: true, backfillForPersonId: 'p-ben', openedOn: TODAY })
    expect(db.jobs.find((j) => j.id === first.result)?.status).toBe('filled')
    expect(db.plan[0]).toMatchObject({ status: 'open', jobId: result, personId: null, isBackfill: true, backfillForPersonId: 'p-ben' })
    expect(db.activity[db.activity.length - 1].text).toBe('Reopened Senior full-stack engineer as a draft backfill job for Ben Carter')
  })

  it("starts a backfill from the leaver's own job when no template matches the level", () => {
    const noTemplates = planDB()
    noTemplates.settings.roleTemplates = []
    const first = run(noTemplates, (d) => openJobFromPlan(d, 'ps-fs', { date: '2026-03-02', hiringManagerId: 'p-founder' }))
    const filled = produce(first.db, (d) => {
      const job = d.jobs.find((j) => j.id === first.result)
      if (job) {
        job.status = 'filled'
        job.description = 'Build the close workspace end to end.'
        job.interviewPlan = [{ id: 'st-tech', stageId: 'technical', name: 'Pairing', durationMin: 60, interviewerIds: ['p-ben'], attributes: [{ name: 'Craft' }] }]
      }
      d.applications.push({ id: 'a-ben', candidateId: 'c-ben', jobId: first.result, stageId: 'hired', stageEnteredOn: '2026-03-20', status: 'hired', appliedOn: '2026-03-03', history: [] } as never)
      const ben = d.people.find((p) => p.id === 'p-ben')
      if (ben) ben.fromApplicationId = 'a-ben'
      Object.assign(d.plan[0], { status: 'filled', personId: 'p-ben' })
    })
    const { db, result } = run(filled, (d) => openJobFromPlan(d, 'ps-fs', { date: TODAY, hiringManagerId: 'p-founder' }))
    const job = db.jobs.find((j) => j.id === result)
    expect(job?.description).toBe('Build the close workspace end to end.')
    expect(job?.interviewPlan).toEqual([{ id: 'st-tech', stageId: 'technical', name: 'Pairing', durationMin: 60, interviewerIds: [], attributes: [{ name: 'Craft' }] }])
  })

  it('falls back to the same family\'s template at the nearest level', () => {
    const db = planDB()
    db.settings.roleTemplates = [
      {
        id: 'rt-staff',
        name: 'Staff engineer',
        familyId: 'f-eng',
        levelId: 'lv-l4',
        departmentId: 'd-eng',
        jdOutline: 'Lead the platform.',
        stages: DEFAULT_STAGES.map((s) => ({ ...s })),
        interviewPlan: [],
      },
    ]
    const { db: next, result } = run(db, (d) => openJobFromPlan(d, 'ps-fs', { date: TODAY, hiringManagerId: 'p-founder' }))
    expect(next.jobs.find((j) => j.id === result)).toMatchObject({ description: 'Lead the platform.', roleTemplateId: 'rt-staff' })
  })

  it('returns the job while it is still live', () => {
    const first = run(planDB(), (d) => openJobFromPlan(d, 'ps-fs', { date: TODAY, hiringManagerId: 'p-founder' }))
    const held = produce(first.db, (d) => {
      const job = d.jobs.find((j) => j.id === first.result)
      if (job) job.status = 'on_hold'
    })
    expect(run(held, (d) => openJobFromPlan(d, 'ps-fs', { date: TODAY, hiringManagerId: 'p-founder' })).result).toBe(first.result)
  })
})

describe('hireFromOffer syncs the reserved grant', () => {
  it('uses the accepted offer and the current 409A, not the stale reservation', () => {
    const db = hiringDB()
    Object.assign(db.grants[0], { shares: 25_000, type: 'NSO', strikePrice: 0.9, vestingStart: '2026-10-12', cliffMonths: 6, vestingMonths: 36 })
    const { db: next } = run(db, (d) => hireFromOffer(d, 'o-lucas', { date: TODAY }))
    expect(next.grants).toEqual([
      expect.objectContaining({ id: 'g-lucas', status: 'promised', shares: 30_000, type: 'ISO', strikePrice: 1.15, vestingStart: START, cliffMonths: 12, vestingMonths: 48 }),
    ])
  })

  it('cancels the reservation when the accepted version has no equity', () => {
    const db = hiringDB()
    db.offers[0].equityShares = 0
    const { db: next } = run(db, (d) => hireFromOffer(d, 'o-lucas', { date: TODAY }))
    expect(next.grants[0]).toMatchObject({ status: 'cancelled', cancelledShares: 30_000, cancelledOn: TODAY })
    expect(next.checklists[0].tasks.some((t) => t.templateTaskId === 'on-equity-board')).toBe(false)
  })
})

describe('startLeave gating', () => {
  it('skips the CFRA designation and benefits tasks under 5 employees', () => {
    const db = baseDB()
    addPerson(db, 'p-a')
    const leave = { personId: 'p-a', kind: 'cfra' as const, requestedOn: '2026-10-06', startDate: '2026-11-16' }
    const cl = run(db, (d) => startLeave(d, leave, { date: '2026-10-06' })).db.checklists[0]
    expect(task(cl, 'lv-designation')).toBeUndefined()
    expect(task(cl, 'lv-benefits')).toBeUndefined()
    expect(task(cl, 'lv-lactation')).toBeUndefined()
    expect(task(cl, 'lv-separation-notices')).toBeDefined()
  })
})

describe('startOffboarding a new supervisor', () => {
  it('closes the supervisor training they owe on a report checklist', () => {
    let db = changeDB()
    db = run(db, (d) => changeJobOrPay(d, 'p-kwame', { effectiveOn: TODAY, reason: 'manager_change', managerId: 'p-lena' }, { date: TODAY })).db
    expect(db.trainings).toEqual([expect.objectContaining({ personId: 'p-lena', kind: 'harassment_supervisor', dueOn: '2027-04-09' })])
    const { db: next } = run(db, (d) => startOffboarding(d, 'p-lena', { type: 'resigned_notice', reason: 'Moved', lastDay: '2026-10-30', noticeGivenOn: '2026-10-16' }, { date: '2026-10-16' }))
    const change = next.checklists.find((c) => c.kind === 'change')
    expect(task(change, 'ch-supervisor-training')).toMatchObject({ status: 'not_applicable', note: expect.stringMatching(/Left on Oct 30, 2026\.$/) })
    expect(next.trainings).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------------------------
// End-to-end review fixes: hires carry the whole offer, exits cancel what never happens
// ---------------------------------------------------------------------------------------------

describe('hireFromOffer carries the whole offer onto the record', () => {
  it('turns a sign-on bonus into a payroll task and a note, with no amount in either', () => {
    const db = hiringDB()
    db.offers[0].signOnBonus = 10_000
    const { db: next } = run(db, (d) => hireFromOffer(d, 'o-lucas', { date: TODAY }))
    const onb = next.checklists[0]
    const t = task(onb, 'on-sign-on-bonus')
    expect(t).toMatchObject({ ownerRole: 'admin', category: 'payroll', dueOn: START, dueRuleText: 'On the start date', status: 'open', statutory: false, link: links.candidate('c-lucas') })
    // Managers see checklists but never pay: no amount in the title, why or note
    expect(`${t?.title} ${t?.why}`).not.toMatch(/\d|\$/)
    const comp = next.comp.find((c) => c.personId === 'p-lucas')
    expect(comp?.note).toMatch(/sign-on bonus/i)
    expect(comp?.note).not.toMatch(/\d|\$/)
    const dates = onb.tasks.map((x) => x.dueOn)
    expect([...dates].sort()).toEqual(dates)
    expect(task(run(hiringDB(), (d) => hireFromOffer(d, 'o-lucas', { date: TODAY })).db.checklists[0], 'on-sign-on-bonus')).toBeUndefined()
  })

  it('records an offer Admin drafted with no separate approval as approved by the drafter', () => {
    const db = hiringDB()
    Object.assign(db.offers[0], { approvals: [], draftedById: 'p-founder', draftedByRole: 'admin' })
    expect(run(db, (d) => hireFromOffer(d, 'o-lucas', { date: TODAY })).db.comp[0]).toMatchObject({ approvedById: 'p-founder', approvedOn: '2026-09-26' })
    // A hiring manager's draft with no approval on file stays unrecorded
    const managers = hiringDB()
    Object.assign(managers.offers[0], { approvals: [], draftedById: 'p-founder', draftedByRole: 'manager' })
    expect(run(managers, (d) => hireFromOffer(d, 'o-lucas', { date: TODAY })).db.comp[0].approvedById).toBeUndefined()
  })

  it('leaves the work email empty when no company domain is known', () => {
    const db = hiringDB()
    delete db.company.website
    db.people[0].workEmail = 'test.only.ledgerlark@gmail.com'
    expect(run(db, (d) => hireFromOffer(d, 'o-lucas', { date: TODAY })).db.people.find((p) => p.id === 'p-lucas')?.workEmail).toBe('')
    // The founder's own company address is enough
    const own = hiringDB()
    delete own.company.website
    own.people[0].workEmail = 'maya@ledgerlark.ai'
    expect(run(own, (d) => hireFromOffer(d, 'o-lucas', { date: TODAY })).db.people.find((p) => p.id === 'p-lucas')?.workEmail).toBe('lucas@ledgerlark.ai')
  })

  it('adds a filled plan line for a job outside the plan, but not a second seat for a rehire', () => {
    const db = hiringDB()
    db.plan = []
    delete db.jobs[0].planSlotId
    const { db: next, result } = run(db, (d) => hireFromOffer(d, 'o-lucas', { date: TODAY }))
    expect(next.plan).toEqual([
      expect.objectContaining({ status: 'filled', personId: result, jobId: 'j-data', title: 'Senior data engineer', quarter: '2026-Q4', targetStart: START, levelId: 'lv-l3' }),
    ])
    expect(planSlotStatus(next, next.plan[0])).toBe('filled')

    const back = hiringDB()
    delete back.jobs[0].planSlotId
    back.plan = [{ id: 'ps-old', quarter: '2025-Q1', title: 'Data engineer', departmentId: 'd-eng', familyId: 'f-eng', levelId: 'lv-l2', targetStart: '2025-01-06', status: 'filled', personId: 'p-lucas-old' }]
    addPerson(back, 'p-lucas-old', { firstName: 'Lucas', lastName: 'Ferreira', personalEmail: 'lucas.f@example.com', startDate: '2025-01-06', endDate: '2026-06-30' })
    const again = run(back, (d) => hireFromOffer(d, 'o-lucas', { date: TODAY }))
    expect(again.db.people.find((p) => p.id === again.result)?.rehireOfPersonId).toBe('p-lucas-old')
    expect(again.db.plan.map((s) => s.id)).toEqual(['ps-old'])
  })
})

/** A second candidate, Ingrid, with an accepted offer on the same job as Lucas, starting a week later. */
function addSecondHire(db: DB): DB {
  db.candidates.push({ ...db.candidates[0], id: 'c-ingrid', firstName: 'Ingrid', lastName: 'Holm', email: 'ingrid.h@example.com', referrerId: null, source: 'inbound' })
  db.applications.push({ ...db.applications[0], id: 'a-ingrid', candidateId: 'c-ingrid' })
  db.offers.push({ ...db.offers[0], id: 'o-ingrid', applicationId: 'a-ingrid', candidateId: 'c-ingrid', startDate: '2026-10-26' })
  return db
}

describe('hireFromOffer with two hires from one job', () => {
  it("gives the second hire a filled line of their own and leaves the first hire's line alone", () => {
    const first = run(addSecondHire(hiringDB()), (d) => hireFromOffer(d, 'o-lucas', { date: TODAY }))
    expect(first.db.plan).toEqual([expect.objectContaining({ id: 'ps-data', status: 'filled', personId: 'p-lucas' })])
    const second = run(first.db, (d) => hireFromOffer(d, 'o-ingrid', { date: TODAY }))
    expect(second.result).toBe('p-ingrid')
    expect(second.db.plan).toHaveLength(2)
    expect(second.db.plan[0]).toMatchObject({ id: 'ps-data', status: 'filled', personId: 'p-lucas', targetStart: START })
    expect(second.db.plan[1]).toMatchObject({ status: 'filled', personId: 'p-ingrid', jobId: 'j-data', targetStart: '2026-10-26', quarter: '2026-Q4' })
    expect(second.db.plan[1].rationale).toMatch(/outside the plan/i)
    expect(second.db.plan.map((s) => planSlotStatus(second.db, s))).toEqual(['filled', 'filled'])
  })

  it('adds a line for each hire from a job outside the plan', () => {
    const db = addSecondHire(hiringDB())
    db.plan = []
    delete db.jobs[0].planSlotId
    const first = run(db, (d) => hireFromOffer(d, 'o-lucas', { date: TODAY }))
    const second = run(first.db, (d) => hireFromOffer(d, 'o-ingrid', { date: TODAY }))
    expect(second.db.plan.map((s) => s.personId)).toEqual(['p-lucas', 'p-ingrid'])
    expect(second.db.plan.every((s) => s.status === 'filled' && s.jobId === 'j-data')).toBe(true)
  })

  it('fills a second line still free on the job before adding one', () => {
    const db = addSecondHire(hiringDB())
    db.plan.push({ ...db.plan[0], id: 'ps-data-2', title: 'Second data engineer', status: 'open', targetStart: '2026-11-02' })
    const first = run(db, (d) => hireFromOffer(d, 'o-lucas', { date: TODAY }))
    // The job's own line (its planSlotId) goes first
    expect(first.db.plan.find((s) => s.id === 'ps-data')?.personId).toBe('p-lucas')
    expect(first.db.plan.find((s) => s.id === 'ps-data-2')?.personId).toBeUndefined()
    const second = run(first.db, (d) => hireFromOffer(d, 'o-ingrid', { date: TODAY }))
    expect(second.db.plan.map((s) => [s.id, s.personId])).toEqual([
      ['ps-data', 'p-lucas'],
      ['ps-data-2', 'p-ingrid'],
    ])
  })
})

describe('startOffboarding cancels what can never take effect', () => {
  const termination = { type: 'terminated' as const, reason: 'Performance', lastDay: '2026-10-10' }

  it('removes a promotion scheduled after the last day with its change checklist and refresh grant', () => {
    let db = changeDB()
    db = run(db, (d) =>
      changeJobOrPay(
        d,
        'p-kwame',
        { effectiveOn: '2026-11-01', reason: 'promotion', title: 'Senior frontend engineer', levelId: 'lv-l3', salary: 215_000, refreshGrantShares: 5_000 },
        { date: '2026-10-10' },
      ),
    ).db
    expect(db.comp.filter((c) => c.personId === 'p-kwame')).toHaveLength(2)
    expect(db.checklists.filter((c) => c.kind === 'change')).toHaveLength(1)

    const { db: next, result } = run(db, (d) => offboardPerson(d, 'p-kwame', termination, { date: '2026-10-10' }))
    // The synced job and pay history never shows a raise that will not happen
    expect(next.comp.filter((c) => c.personId === 'p-kwame').map((c) => c.id)).toEqual(['cr-kwame-hire'])
    expect(next.checklists.filter((c) => c.kind === 'change')).toHaveLength(0)
    expect(next.grants.find((g) => g.personId === 'p-kwame')).toMatchObject({ status: 'cancelled', cancelledShares: 5_000 })
    expect(result.cleanup).toMatchObject({ scheduledChangesCancelled: 1, cancelledChanges: [{ effectiveOn: '2026-11-01', reason: 'promotion' }] })
    expect(exitCleanupLines(result.cleanup)).toEqual(['Cancelled the promotion scheduled for Nov 1, 2026.'])
    expect(
      next.activity.some((a) => a.kind === 'exit_cleanup' && a.text === 'Cancelled the promotion scheduled for Nov 1, 2026 for Kwame Mensah after the exit on Sat, Oct 10'),
    ).toBe(true)
    expect(run(next, (d) => applyScheduledChanges(d, '2026-11-01')).result).toBe(0)
    // A change on or before the last day stays
    const kept = run(db, (d) => offboardPerson(d, 'p-kwame', { ...termination, lastDay: '2026-11-13' }, { date: '2026-10-10' }))
    expect(kept.db.comp.filter((c) => c.personId === 'p-kwame')).toHaveLength(2)
    expect(kept.result.cleanup.scheduledChangesCancelled).toBe(0)
  })

  it('keeps a change checklist with finished work and closes what is open with the reason', () => {
    let db = changeDB()
    addPerson(db, 'p-luis', { firstName: 'Luis', lastName: 'Ortega', flsa: 'non_exempt', employmentType: 'part_time', hoursPerWeek: 24, title: 'Office coordinator' })
    db.comp.push({ id: 'cr-luis', personId: 'p-luis', effectiveOn: '2025-06-01', payType: 'hourly', hourlyRate: 28, title: 'Office coordinator', levelId: 'lv-l1', flsa: 'non_exempt', reason: 'hire' })
    db = run(db, (d) => changeJobOrPay(d, 'p-luis', { effectiveOn: '2026-11-01', reason: 'merit', hourlyRate: 30 }, { date: '2026-10-10' })).db
    db = produce(db, (d) => {
      const t = d.checklists[0].tasks.find((x) => x.templateTaskId === 'ch-payroll')
      if (t) Object.assign(t, { status: 'done', doneOn: '2026-10-10' })
    })
    const { db: next, result } = run(db, (d) => offboardPerson(d, 'p-luis', termination, { date: '2026-10-10' }))
    const cl = next.checklists.find((c) => c.kind === 'change')
    expect(task(cl, 'ch-payroll')?.status).toBe('done')
    expect(task(cl, 'ch-wage-notice')).toMatchObject({ status: 'not_applicable', note: 'Cancelled: last day is Oct 10, 2026.' })
    expect(cl?.completedOn).toBe('2026-10-10')
    expect(result.cleanup.tasksClosed).toBe(1)
  })

  it('drops the supervisor training only the cancelled change created', () => {
    let db = changeDB()
    db = run(db, (d) => changeJobOrPay(d, 'p-kwame', { effectiveOn: '2026-11-01', reason: 'manager_change', managerId: 'p-lena' }, { date: '2026-10-10' })).db
    expect(db.trainings).toEqual([expect.objectContaining({ personId: 'p-lena', kind: 'harassment_supervisor' })])
    const { db: next } = run(db, (d) => offboardPerson(d, 'p-kwame', termination, { date: '2026-10-10' }))
    expect(next.trainings).toHaveLength(0)
    expect(next.checklists.filter((c) => c.kind === 'change')).toHaveLength(0)
  })

  it('cancels time off after the last day and shortens a request that runs past it', () => {
    const db = baseDB()
    addPerson(db, 'p-kofi', { firstName: 'Kofi', lastName: 'Boateng' })
    const base = { personId: 'p-kofi', policyId: 'pol-vacation', requestedOn: '2026-09-20' }
    db.timeOffRequests.push(
      { ...base, id: 'tr-later', startDate: '2026-10-30', endDate: '2026-10-30', hours: 8, status: 'pending' },
      { ...base, id: 'tr-booked', startDate: '2026-11-09', endDate: '2026-11-10', hours: 16, status: 'approved', decidedOn: '2026-09-21' },
      { ...base, id: 'tr-span', startDate: '2026-10-07', endDate: '2026-10-14', partial: 'pm', hours: 44, status: 'approved', decidedOn: '2026-09-21' },
      { ...base, id: 'tr-past', startDate: '2026-09-14', endDate: '2026-09-14', hours: 8, status: 'approved', decidedOn: '2026-09-01' },
      { ...base, id: 'tr-declined', startDate: '2026-11-02', endDate: '2026-11-02', hours: 8, status: 'declined', decidedOn: '2026-09-21' },
    )
    const { db: next, result } = run(db, (d) => offboardPerson(d, 'p-kofi', { ...termination, lastDay: '2026-10-09' }, { date: '2026-10-09' }))
    const req = (id: string) => next.timeOffRequests.find((r) => r.id === id)
    expect(req('tr-later')).toMatchObject({ status: 'cancelled', decidedOn: '2026-10-09', decisionNote: 'Cancelled: last day is Oct 9, 2026.' })
    expect(req('tr-booked')?.status).toBe('cancelled')
    expect(req('tr-span')).toMatchObject({ status: 'approved', endDate: '2026-10-09', hours: 24 })
    expect(req('tr-span')?.partial).toBeUndefined()
    expect(req('tr-span')?.decisionNote).toMatch(/Shortened to end on the last day, Oct 9, 2026/)
    expect(req('tr-past')).toMatchObject({ status: 'approved', endDate: '2026-09-14' })
    expect(req('tr-declined')?.status).toBe('declined')
    expect(result.cleanup).toMatchObject({ timeOffCancelled: 2, timeOffShortened: 1 })
    // Out of the approval queue and the calendar of who is out
    expect(pendingApprovals(next)).toEqual([])
    expect(whoIsOut(next, '2026-10-12', '2026-11-30')).toEqual([])
    expect(exitCleanupLines(result.cleanup)).toEqual(['Cancelled 2 time off requests after the last day.', 'Shortened 1 time off request to end on the last day.'])
    // Activity names no leave type
    expect(next.activity.filter((a) => a.kind === 'exit_cleanup').map((a) => a.text)).toEqual([
      'Cancelled 2 time off requests for Kofi Boateng after the exit on Fri, Oct 9',
      'Shortened 1 time off request for Kofi Boateng to end on the last day, Fri, Oct 9',
    ])
  })

  it('reports nothing for a double click on the same separation', () => {
    const db = baseDB()
    addPerson(db, 'p-kofi')
    const first = run(db, (d) => offboardPerson(d, 'p-kofi', termination, { date: '2026-10-10' }))
    const again = run(first.db, (d) => offboardPerson(d, 'p-kofi', termination, { date: '2026-10-10' }))
    expect(again.result.checklistId).toBe(first.result.checklistId)
    expect(exitCleanupLines(again.result.cleanup)).toEqual([])
    produce(db, (d) => {
      expect(closeForExit(d, 'p-nobody', '2026-10-10', '2026-10-10').scheduledChangesCancelled).toBe(0)
    })
  })
})

describe('changeJobOrPay and payroll', () => {
  it('adds no payroll task, and no checklist, for a manager or team move alone', () => {
    const db = changeDB()
    db.people.find((p) => p.id === 'p-sofia')!.managerId = 'p-lena'
    const moved = run(db, (d) => changeJobOrPay(d, 'p-kwame', { effectiveOn: TODAY, reason: 'manager_change', managerId: 'p-lena' }, { date: TODAY })).db
    expect(moved.checklists).toHaveLength(0)
    expect(moved.comp.filter((c) => c.personId === 'p-kwame')).toHaveLength(2)
    expect(moved.people.find((p) => p.id === 'p-kwame')?.managerId).toBe('p-lena')
    const team = run(db, (d) => changeJobOrPay(d, 'p-kwame', { effectiveOn: TODAY, reason: 'transfer', departmentId: 'd-product', managerId: 'p-lena' }, { date: TODAY })).db
    expect(team.checklists).toHaveLength(0)
    // A first direct report still brings the supervisor training, on its own
    const first = run(changeDB(), (d) => changeJobOrPay(d, 'p-kwame', { effectiveOn: TODAY, reason: 'manager_change', managerId: 'p-lena' }, { date: TODAY })).db
    expect(first.checklists[0].tasks.map((t) => t.templateTaskId)).toEqual(['ch-supervisor-training'])
    // A title or exemption change still goes to payroll
    const titled = run(db, (d) => changeJobOrPay(d, 'p-kwame', { effectiveOn: TODAY, reason: 'title_only', title: 'Frontend engineer II' }, { date: TODAY })).db
    expect(task(titled.checklists[0], 'ch-payroll')).toBeDefined()
    const basis = run(db, (d) => changeJobOrPay(d, 'p-kwame', { effectiveOn: TODAY, reason: 'correction', exemptionBasis: 'computer_professional' }, { date: TODAY })).db
    expect(task(basis.checklists[0], 'ch-payroll')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------------------------
// Second end-to-end pass: reports at exit, scheduled changes, the change task plan
// ---------------------------------------------------------------------------------------------

/** Elena manages Chris; Dana reports to the founder; Caleb works from Austin. */
function teamDB(): DB {
  const db = baseDB()
  addPerson(db, 'p-elena', { firstName: 'Elena', lastName: 'Vasquez', startDate: '2025-03-03' })
  addPerson(db, 'p-caleb', { firstName: 'Caleb', lastName: 'Washington', homeState: 'TX', homeCity: 'Austin', workMode: 'remote', startDate: '2025-08-04' })
  addPerson(db, 'p-chris', { firstName: 'Chris', lastName: 'Nakamura', managerId: 'p-elena', startDate: '2025-09-02' })
  addPerson(db, 'p-dana', { firstName: 'Dana', lastName: 'Ito', startDate: '2026-01-12' })
  for (const p of db.people.filter((x) => !x.isFounder)) {
    db.comp.push({ id: `cr-${p.id}`, personId: p.id, effectiveOn: p.startDate, payType: 'salary', salary: 150_000, title: p.title, levelId: p.levelId, managerId: p.managerId, departmentId: p.departmentId, flsa: p.flsa, reason: 'hire' })
  }
  return db
}

const resignation = { type: 'resigned_notice' as const, reason: 'New job', lastDay: '2026-10-30', noticeGivenOn: TODAY }

describe('offboarding reassigns the reports the leaver has at the exit', () => {
  it('leaves out a report already scheduled to move away, and includes one scheduled to move in', () => {
    let db = teamDB()
    db = run(db, (d) => changeJobOrPay(d, 'p-chris', { effectiveOn: '2026-10-16', reason: 'manager_change', managerId: 'p-caleb' }, { date: TODAY })).db
    db = run(db, (d) => changeJobOrPay(d, 'p-dana', { effectiveOn: '2026-10-20', reason: 'manager_change', managerId: 'p-elena' }, { date: TODAY })).db
    // Today Chris still reports to Elena, but by the day after her last day he reports to Caleb and Dana to her.
    expect(db.people.find((p) => p.id === 'p-chris')?.managerId).toBe('p-elena')
    expect(reportsAsOf(db, 'p-elena', '2026-10-31').map((p) => p.id)).toEqual(['p-dana'])
    expect(reportsAsOf(db, 'p-elena', TODAY).map((p) => p.id)).toEqual(['p-chris'])

    const { db: left, result: checklistId } = run(db, (d) => startOffboarding(d, 'p-elena', resignation, { date: TODAY }))
    expect(task(left.checklists.find((c) => c.id === checklistId), 'off-reassign-reports')).toMatchObject({ status: 'open', note: 'Reassign Dana Ito.' })
    const { db: next, result: moved } = run(left, (d) => reassignReportsAtExit(d, 'p-elena', resignation.lastDay, () => 'p-founder', { date: TODAY, checklistId }))
    expect(moved).toBe(1)
    expect(task(next.checklists.find((c) => c.id === checklistId), 'off-reassign-reports')).toMatchObject({ status: 'done', note: 'New manager from Oct 31, 2026, recorded in the offboarding wizard.' })
    // Chris keeps the move to Caleb: no second row hands him to someone else on Oct 31.
    expect(next.comp.filter((c) => c.personId === 'p-chris').map((c) => c.effectiveOn)).toEqual(['2025-09-02', '2026-10-16'])
    expect(currentJob(next, 'p-chris', '2026-11-02')?.managerId).toBe('p-caleb')
    // Dana moves to the founder the day after the last day.
    expect(next.comp.find((c) => c.personId === 'p-dana' && c.effectiveOn === '2026-10-31')).toMatchObject({ managerId: 'p-founder', reason: 'manager_change', scheduled: true })
    expect(currentJob(next, 'p-dana', '2026-10-31')?.managerId).toBe('p-founder')
  })

  it('adds no reassign task when every report has already moved away by the exit', () => {
    let db = teamDB()
    db = run(db, (d) => changeJobOrPay(d, 'p-chris', { effectiveOn: '2026-10-16', reason: 'manager_change', managerId: 'p-caleb' }, { date: TODAY })).db
    const { db: next } = run(db, (d) => {
      const id = startOffboarding(d, 'p-elena', resignation, { date: TODAY })
      expect(reassignReportsAtExit(d, 'p-elena', resignation.lastDay, () => 'p-founder', { date: TODAY, checklistId: id })).toBe(0)
    })
    expect(task(next.checklists.find((c) => c.kind === 'offboarding'), 'off-reassign-reports')).toBeUndefined()
    expect(next.comp.filter((c) => c.personId === 'p-chris')).toHaveLength(2)
  })

  it('skips a report given no new manager and leaves the task open', () => {
    const { db: next } = run(teamDB(), (d) => {
      const id = startOffboarding(d, 'p-elena', resignation, { date: TODAY })
      expect(reassignReportsAtExit(d, 'p-elena', resignation.lastDay, () => null, { date: TODAY, checklistId: id })).toBe(0)
    })
    expect(task(next.checklists.find((c) => c.kind === 'offboarding'), 'off-reassign-reports')).toMatchObject({ status: 'open', note: 'Reassign Chris Nakamura.' })
  })
})

describe('changeTaskPlan lists exactly what the save creates', () => {
  it('a manager move alone to a manager outside California: no payroll task and no training', () => {
    const db = teamDB()
    addPerson(db, 'p-x1')
    const change = { effectiveOn: '2026-10-16', reason: 'manager_change' as const, managerId: 'p-caleb' }
    expect(changeTaskPlan(db, 'p-dana', change, TODAY)).toEqual({ payroll: null, notice2810_5: null, supervisorTraining: null })
    const saved = run(db, (d) => changeJobOrPay(d, 'p-dana', change, { date: TODAY })).db
    expect(saved.checklists).toHaveLength(0)
    expect(saved.trainings).toHaveLength(0)
  })

  it('names the payroll date, the 2810.5 notice and a new California supervisor as the checklist has them', () => {
    const db = teamDB()
    addPerson(db, 'p-luis', { firstName: 'Luis', lastName: 'Ortega', flsa: 'non_exempt', title: 'Office coordinator' })
    db.comp.push({ id: 'cr-luis', personId: 'p-luis', effectiveOn: '2025-06-01', payType: 'hourly', hourlyRate: 28, title: 'Office coordinator', levelId: 'lv-l1', managerId: 'p-founder', flsa: 'non_exempt', reason: 'hire' })
    const change = { effectiveOn: '2026-11-02', reason: 'merit' as const, hourlyRate: 30, managerId: 'p-dana' }
    const plan = changeTaskPlan(db, 'p-luis', change, TODAY)
    const saved = run(db, (d) => changeJobOrPay(d, 'p-luis', change, { date: TODAY })).db
    const cl = saved.checklists[0]
    expect(plan.payroll).toBe(task(cl, 'ch-payroll')?.dueOn)
    expect(plan.notice2810_5).toBe('2026-11-09')
    expect(plan.notice2810_5).toBe(task(cl, 'ch-wage-notice')?.dueOn)
    expect(plan.supervisorTraining).toEqual({ personId: 'p-dana', dueOn: '2027-05-02' })
    expect(saved.trainings).toEqual([expect.objectContaining({ personId: 'p-dana', dueOn: '2027-05-02' })])
  })

  it('does not count a second move to a manager as a first direct report', () => {
    let db = teamDB()
    db = run(db, (d) => changeJobOrPay(d, 'p-chris', { effectiveOn: '2026-10-16', reason: 'manager_change', managerId: 'p-dana' }, { date: TODAY })).db
    expect(db.trainings).toEqual([expect.objectContaining({ personId: 'p-dana' })])
    // Even with no training on file, Elena moving to Dana a week later is not Dana's first report: Chris is by then.
    db = produce(db, (d) => {
      d.trainings = []
    })
    expect(changeTaskPlan(db, 'p-elena', { effectiveOn: '2026-10-23', reason: 'manager_change', managerId: 'p-dana' }, TODAY).supervisorTraining).toBeNull()
  })
})

describe('cancelScheduledChange', () => {
  it('removes a scheduled promotion with its untouched checklist and the refresh grant it queued', () => {
    let db = changeDB()
    db = run(db, (d) =>
      changeJobOrPay(d, 'p-kwame', { effectiveOn: '2026-11-01', reason: 'promotion', title: 'Senior frontend engineer', levelId: 'lv-l3', salary: 205_000, refreshGrantShares: 5_000 }, { date: TODAY }),
    ).db
    const row = db.comp.find((c) => c.personId === 'p-kwame' && c.effectiveOn === '2026-11-01')
    if (!row) throw new Error('no scheduled row')
    expect(canCancelChange(db, row.id)).toEqual({ ok: true })
    const { db: next, result } = run(db, (d) => cancelScheduledChange(d, row.id, { date: TODAY, actorId: 'p-founder' }))
    expect(result).toEqual({ ok: true })
    expect(next.comp.filter((c) => c.personId === 'p-kwame').map((c) => c.id)).toEqual(['cr-kwame-hire'])
    expect(next.checklists.filter((c) => c.kind === 'change')).toHaveLength(0)
    expect(next.grants.find((g) => g.personId === 'p-kwame')).toMatchObject({ status: 'cancelled', cancelledShares: 5_000, cancelledOn: TODAY })
    const logged = next.activity.find((a) => a.kind === 'job_change_cancelled')
    expect(logged).toMatchObject({ actorId: 'p-founder', text: 'Cancelled the promotion scheduled for Nov 1, 2026 for Kwame Mensah and its refresh grant' })
    expect(run(next, (d) => applyScheduledChanges(d, '2026-11-01')).result).toBe(0)
  })

  it('drops the supervisor training only the cancelled manager change created', () => {
    let db = changeDB()
    db = run(db, (d) => changeJobOrPay(d, 'p-kwame', { effectiveOn: '2026-11-01', reason: 'manager_change', managerId: 'p-lena' }, { date: TODAY })).db
    expect(db.trainings).toHaveLength(1)
    const row = db.comp.find((c) => c.personId === 'p-kwame' && c.scheduled)!
    const { db: next } = run(db, (d) => cancelScheduledChange(d, row.id, { date: TODAY }))
    expect(next.trainings).toHaveLength(0)
    expect(next.checklists).toHaveLength(0)
  })

  it('keeps a checklist with finished work and closes what is open', () => {
    let db = changeDB()
    db = run(db, (d) => changeJobOrPay(d, 'p-kwame', { effectiveOn: '2026-11-01', reason: 'merit', salary: 180_000 }, { date: TODAY })).db
    db = produce(db, (d) => {
      const t = d.checklists[0].tasks.find((x) => x.templateTaskId === 'ch-payroll')
      if (t) Object.assign(t, { status: 'done', doneOn: TODAY })
      d.checklists[0].tasks.push({ id: 't-extra', title: 'Extra', ownerRole: 'admin', dueOn: '2026-11-01', status: 'open', category: 'payroll', statutory: false })
    })
    const row = db.comp.find((c) => c.personId === 'p-kwame' && c.scheduled)!
    const { db: next } = run(db, (d) => cancelScheduledChange(d, row.id, { date: TODAY }))
    const cl = next.checklists[0]
    expect(task(cl, 'ch-payroll')?.status).toBe('done')
    expect(cl.tasks.find((t) => t.id === 't-extra')).toMatchObject({ status: 'not_applicable', note: 'Change cancelled on Oct 9, 2026.' })
  })

  it('refuses a change that took effect, and an earlier one while a later change is scheduled', () => {
    let db = changeDB()
    expect(canCancelChange(db, 'cr-kwame-hire').ok).toBe(false)
    db = run(db, (d) => changeJobOrPay(d, 'p-kwame', { effectiveOn: '2026-11-01', reason: 'manager_change', managerId: 'p-lena' }, { date: TODAY })).db
    db = run(db, (d) => changeJobOrPay(d, 'p-kwame', { effectiveOn: '2027-01-01', reason: 'merit', salary: 180_000 }, { date: TODAY })).db
    const [first, second] = db.comp.filter((c) => c.personId === 'p-kwame' && c.scheduled).sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn))
    expect(canCancelChange(db, first.id)).toEqual({ ok: false, reason: 'A later change was recorded after this one. Cancel that one first.' })
    const { db: same, result } = run(db, (d) => cancelScheduledChange(d, first.id, { date: TODAY }))
    expect(result.ok).toBe(false)
    expect(same.comp).toHaveLength(db.comp.length)
    expect(canCancelChange(db, second.id)).toEqual({ ok: true })
  })
})

// ---------------------------------------------------------------------------------------------
// Third end-to-end pass: manager tasks follow the manager
// ---------------------------------------------------------------------------------------------

describe('open manager tasks follow a manager change', () => {
  /** teamDB with Chris (Elena's report) mid-onboarding: the 30-day check-in is overdue, the 90-day one ahead. */
  function onboardingDB(): DB {
    const db = teamDB()
    const chris = db.people.find((p) => p.id === 'p-chris') as Person
    chris.startDate = '2026-08-03'
    const hire = db.comp.find((c) => c.personId === 'p-chris') as CompRecord
    hire.effectiveOn = '2026-08-03'
    db.checklists.push(generateChecklist(db, { person: chris, templateId: 'tpl-onboarding', anchorDate: chris.startDate, createdOn: '2026-07-20', id: 'ck-chris' }))
    return db
  }
  const onb = (db: DB) => db.checklists.find((c) => c.id === 'ck-chris')
  const assignee = (db: DB, id: string) => task(onb(db), id)?.assigneeId

  it('hands the tasks due from a change today to the new manager', () => {
    const db = produce(onboardingDB(), (d) => {
      const welcome = d.checklists[0].tasks.find((t) => t.templateTaskId === 'on-welcome')
      if (welcome) Object.assign(welcome, { status: 'done', doneOn: '2026-07-30' })
    })
    expect(task(onb(db), 'on-checkin-90')).toMatchObject({ ownerRole: 'manager', assigneeId: 'p-elena', status: 'open', dueOn: '2026-11-02' })
    expect(task(onb(db), 'on-checkin-30')).toMatchObject({ assigneeId: 'p-elena', dueOn: '2026-09-02' })
    const { db: next } = run(db, (d) => changeJobOrPay(d, 'p-chris', { effectiveOn: TODAY, reason: 'manager_change', managerId: 'p-dana' }, { date: TODAY }))
    const ninety = task(onb(next), 'on-checkin-90')
    expect(ninety?.assigneeId).toBe('p-dana')
    expect(taskOwnerId(next, onb(next) as Checklist, ninety as Checklist['tasks'][number])).toBe('p-dana')
    // Due before the change, so it stays with the manager it was due under; finished work is history.
    expect(assignee(next, 'on-checkin-30')).toBe('p-elena')
    expect(task(onb(next), 'on-welcome')).toMatchObject({ status: 'done', assigneeId: 'p-elena' })
  })

  it('a scheduled change hands over the tasks due from its date, and cancelling it hands them back', () => {
    const { db, result } = run(onboardingDB(), (d) =>
      changeJobOrPay(d, 'p-chris', { effectiveOn: '2026-10-19', reason: 'manager_change', managerId: 'p-dana' }, { date: TODAY }),
    )
    expect(assignee(db, 'on-checkin-90')).toBe('p-dana')
    expect(assignee(db, 'on-checkin-30')).toBe('p-elena')
    const back = run(db, (d) => cancelScheduledChange(d, result, { date: TODAY })).db
    expect(assignee(back, 'on-checkin-90')).toBe('p-elena')
  })

  it('stops at a later change to someone else', () => {
    let db = produce(onboardingDB(), (d) => {
      const access = d.checklists[0].tasks.find((t) => t.templateTaskId === 'on-production-access')
      if (access) access.dueOn = '2026-10-20'
    })
    db = run(db, (d) => changeJobOrPay(d, 'p-chris', { effectiveOn: '2026-10-26', reason: 'manager_change', managerId: 'p-caleb' }, { date: TODAY })).db
    expect(assignee(db, 'on-checkin-90')).toBe('p-caleb')
    expect(assignee(db, 'on-production-access')).toBe('p-elena')
    // A task added later with no assignee follows the manager field.
    db = produce(db, (d) => {
      d.checklists[0].tasks.push({ id: 't-extra', title: 'Extra', ownerRole: 'manager', assigneeId: null, dueOn: '2026-11-05', status: 'open', category: 'culture', statutory: false })
    })
    db = run(db, (d) => changeJobOrPay(d, 'p-chris', { effectiveOn: '2026-10-12', reason: 'manager_change', managerId: 'p-dana' }, { date: TODAY })).db
    expect(assignee(db, 'on-production-access')).toBe('p-dana')
    expect(assignee(db, 'on-checkin-90')).toBe('p-caleb')
    expect(onb(db)?.tasks.find((t) => t.id === 't-extra')?.assigneeId).toBeNull()
  })

  it('hands over tasks added after a change was scheduled when it lands', () => {
    let db = run(onboardingDB(), (d) => changeJobOrPay(d, 'p-chris', { effectiveOn: '2026-10-19', reason: 'manager_change', managerId: 'p-dana' }, { date: TODAY })).db
    db = run(db, (d) => startLeave(d, { personId: 'p-chris', kind: 'other', requestedOn: TODAY, startDate: '2026-11-16', expectedReturn: '2027-01-04' }, { date: TODAY })).db
    const leave = () => db.checklists.find((c) => c.kind === 'leave')
    const managerTasks = leave()?.tasks.filter((t) => t.ownerRole === 'manager') ?? []
    expect(managerTasks.length).toBeGreaterThan(0)
    expect(managerTasks.every((t) => t.assigneeId === 'p-elena')).toBe(true)
    db = run(db, (d) => applyScheduledChanges(d, '2026-10-19')).db
    expect(db.people.find((p) => p.id === 'p-chris')?.managerId).toBe('p-dana')
    expect(leave()?.tasks.filter((t) => t.ownerRole === 'manager').every((t) => t.assigneeId === 'p-dana')).toBe(true)
  })

  it("hands a leaver's open manager tasks to each report's next manager", () => {
    const db = onboardingDB()
    const held = onb(db)?.tasks.filter((t) => t.status === 'open' && t.ownerRole === 'manager' && t.assigneeId === 'p-elena').length ?? 0
    expect(held).toBeGreaterThanOrEqual(2)
    const termination = { type: 'terminated' as const, reason: 'Performance', lastDay: TODAY }
    const { db: left, result } = run(db, (d) => offboardPerson(d, 'p-elena', termination, { date: TODAY }))
    expect(result.cleanup.managerTasksHandedOff).toBe(held)
    expect(exitCleanupLines(result.cleanup)).toContain(`Handed ${held} open manager tasks for their reports to each report's next manager.`)
    expect(assignee(left, 'on-checkin-90')).toBeNull()
    let next = run(left, (d) => reassignReportsAtExit(d, 'p-elena', TODAY, () => 'p-founder', { date: TODAY, checklistId: result.checklistId })).db
    // Due from the day after the last day: the new manager's now.
    expect(assignee(next, 'on-checkin-90')).toBe('p-founder')
    // Due before it: the manager field owns it, Elena until the move lands, then the new manager.
    const ownerOfThirty = (x: DB) => taskOwnerId(x, onb(x) as Checklist, task(onb(x), 'on-checkin-30') as Checklist['tasks'][number])
    expect(ownerOfThirty(next)).toBe('p-elena')
    next = run(next, (d) => applyScheduledChanges(d, addDays(TODAY, 1))).db
    expect(ownerOfThirty(next)).toBe('p-founder')
  })
})
