// Regression tests for cross-cutting fixes: scheduling conflicts, state-aware legal rules, dates,
// compliance evidence and calendar rules. Fixed dates only; the store's sample seed is mocked out.
import { produce } from 'immer'
import { describe, expect, it, vi } from 'vitest'
import { blankDB } from '@/data/blank'
import { generateChecklist, taskDueOn } from '@/domain/checklists/generate'
import { DEFAULT_CHECKLIST_TEMPLATES } from '@/domain/checklists/templates'
import { complianceCalendar } from '@/domain/compliance/calendar'
import { evaluateRule } from '@/domain/compliance/engine'
import { RULE_BY_ID } from '@/domain/compliance/rules'
import { soc2Evidence } from '@/domain/compliance/soc2'
import { criminalHistoryLint, salaryHistoryLint } from '@/domain/hiring/postings'
import { exemptCheck, offerLetter } from '@/domain/hiring/offers'
import { proposeTimesFor, scheduleWarnings } from '@/domain/hiring/scheduling'
import { leaveEligibility } from '@/domain/lifecycle'
import { priorStint, welcomeEmail } from '@/domain/people'
import { isStatutoryTraining, trainingRequirements } from '@/domain/trainings'
import type { DB, Interview, Offer, Person } from '@/domain/types'
import { federalHolidays, localDateOf, pacificDateOf, shiftTimestampDays } from '@/lib/dates'

vi.mock('@/data/seed', async () => {
  const blank = await import('@/data/blank')
  return { SAMPLE_ANCHOR: '2026-10-09', buildSampleDB: () => blank.blankDB({ companyName: 'Fixture', founderFirstName: 'F', founderLastName: 'F' }) }
})

function mk(id: string, firstName: string, over: Partial<Person> = {}): Person {
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
    startDate: '2025-06-02',
    hireNumber: 2,
    emergencyContacts: [],
    ...over,
  }
}

function base(): DB {
  const db = blankDB({ companyName: 'Testco', founderFirstName: 'Maya', founderLastName: 'Raman', foundedOn: '2025-02-03' })
  db.locations.push({ id: 'loc-remote-tx', name: 'Remote (Texas)', kind: 'remote', state: 'TX', minWageHourly: 7.25 })
  for (let i = 2; i <= 7; i++) db.people.push(mk(`p-${i}`, `P${i}`, { hireNumber: i }))
  return db
}

const interview = (id: string, startsAt: string, interviewerIds: string[], extra: Partial<Interview> = {}): Interview => ({
  id,
  applicationId: 'a-other',
  stageId: 'intro',
  name: 'Intro call',
  startsAt,
  durationMin: 45,
  interviewerIds,
  format: 'video',
  status: 'scheduled',
  attributes: [],
  ...extra,
})

describe('proposed interview times avoid the panel calendar (flow-2)', () => {
  it('keeps the usual rotation when the calendar is clear', () => {
    expect(proposeTimesFor(base(), '2026-10-09')).toEqual(['2026-10-12T17:00:00.000Z', '2026-10-13T20:00:00.000Z', '2026-10-14T22:30:00.000Z'])
  })

  it('moves off a slot a panelist already has, and skips a day a panelist is out', () => {
    const db = base()
    db.interviews.push(interview('i-busy', '2026-10-12T17:00:00.000Z', ['p-2']))
    db.timeOffRequests.push({ id: 'tr-1', personId: 'p-3', policyId: 'pol-vacation', startDate: '2026-10-13', endDate: '2026-10-13', hours: 8, status: 'approved', requestedOn: '2026-10-01' })
    const times = proposeTimesFor(db, '2026-10-09', 3, { panelIds: ['p-2', 'p-3'] })
    expect(times).not.toContain('2026-10-12T17:00:00.000Z')
    expect(times.map((t) => pacificDateOf(t))).not.toContain('2026-10-13')
    expect(times).toHaveLength(3)
    // Someone else's interview does not block a panel that is free.
    expect(proposeTimesFor(db, '2026-10-09', 1, { panelIds: ['p-4'] })).toEqual(['2026-10-12T17:00:00.000Z'])
  })

  it("prefers 9 to 5 in the candidate's time zone", () => {
    const times = proposeTimesFor(base(), '2026-10-09', 3, { candidateTz: 'America/New_York' })
    // 3:30 PM Pacific is 6:30 PM Eastern, so Wednesday moves to an earlier slot.
    expect(times).not.toContain('2026-10-14T22:30:00.000Z')
    for (const t of times) {
      const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(new Date(t)))
      expect(h).toBeGreaterThanOrEqual(9)
      expect(h).toBeLessThan(17)
    }
  })

  it('warns when a picked time double-books a panelist', () => {
    const db = base()
    db.candidates.push({ id: 'c-grace', firstName: 'Grace', lastName: 'Okafor', email: 'g@x.com', links: {}, source: 'inbound', sponsorship: 'no', tags: [], createdOn: '2026-09-01' })
    db.applications.push({ id: 'a-other', candidateId: 'c-grace', jobId: 'j-x', stageId: 'intro', status: 'active', appliedOn: '2026-09-01', stageEnteredOn: '2026-09-01', history: [] })
    db.interviews.push(interview('i-busy', '2026-10-12T17:00:00.000Z', ['p-2']))
    expect(scheduleWarnings(db, '2026-10-12T17:30:00.000Z', 45, ['p-2'])).toEqual(['P2 Test already has Intro call with Grace Okafor then.'])
    expect(scheduleWarnings(db, '2026-10-12T20:00:00.000Z', 45, ['p-2'])).toEqual([])
  })

  it('treats an approved half day off as busy for that half of the day (F3)', () => {
    const db = base()
    // Monday Oct 12: P2 has the afternoon off; Tuesday Oct 13: P3 has the morning off.
    db.timeOffRequests.push({ id: 'tr-pm', personId: 'p-2', policyId: 'pol-vacation', startDate: '2026-10-12', endDate: '2026-10-12', partial: 'pm', hours: 4, status: 'approved', requestedOn: '2026-10-01' })
    db.timeOffRequests.push({ id: 'tr-am', personId: 'p-3', policyId: 'pol-vacation', startDate: '2026-10-13', endDate: '2026-10-13', partial: 'am', hours: 4, status: 'approved', requestedOn: '2026-10-01' })
    // 1:00 PM PT Monday is inside P2's afternoon off; 10:00 AM PT Monday is not.
    expect(scheduleWarnings(db, '2026-10-12T20:00:00.000Z', 30, ['p-2', 'p-4'])).toEqual(['P2 Test is out that afternoon.'])
    expect(scheduleWarnings(db, '2026-10-12T17:00:00.000Z', 45, ['p-2'])).toEqual([])
    // An 11:30 AM interview that runs past noon touches the afternoon off.
    expect(scheduleWarnings(db, '2026-10-12T18:30:00.000Z', 45, ['p-2'])).toEqual(['P2 Test is out that afternoon.'])
    expect(scheduleWarnings(db, '2026-10-13T17:00:00.000Z', 45, ['p-3'])).toEqual(['P3 Test is out that morning.'])
    expect(scheduleWarnings(db, '2026-10-13T20:00:00.000Z', 45, ['p-3'])).toEqual([])
    // A pending half day does not block.
    db.timeOffRequests.push({ id: 'tr-pending', personId: 'p-4', policyId: 'pol-vacation', startDate: '2026-10-12', endDate: '2026-10-12', partial: 'pm', hours: 4, status: 'pending', requestedOn: '2026-10-01' })
    expect(scheduleWarnings(db, '2026-10-12T20:00:00.000Z', 30, ['p-4'])).toEqual([])

    const times = proposeTimesFor(db, '2026-10-09', 3, { panelIds: ['p-2', 'p-3'], durationMin: 30 })
    expect(times).toHaveLength(3)
    for (const t of times) expect(scheduleWarnings(db, t, 30, ['p-2', 'p-3'])).toEqual([])
    // Monday still gets a morning slot (10:00 AM PT), not the 1:00 PM one.
    expect(times[0]).toBe('2026-10-12T17:00:00.000Z')
  })
})

describe('California-only duties stay with California work (legal-1, legal-2, legal-13)', () => {
  it('gives a Texas hire no California notices or statutory California deadlines', () => {
    const db = base()
    const caleb = mk('p-caleb', 'Caleb', { homeState: 'TX', locationId: 'loc-remote-tx', workMode: 'remote', startDate: '2026-11-02', hireNumber: 8 })
    db.people.push(caleb)
    const ids = generateChecklist(db, { person: caleb, templateId: 'tpl-onboarding', anchorDate: caleb.startDate, createdOn: '2026-10-09' }).tasks.map((t) => t.templateTaskId)
    for (const ca of ['on-notice-sb294', 'on-notice-survivors', 'on-notice-de2515', 'on-notice-de2511', 'on-notice-workers-comp', 'on-notice-lactation', 'on-notice-sick', 'on-iipp-training', 'on-notice-crd', 'on-notice-cfra-pdl', 'on-de34']) {
      expect(ids, ca).not.toContain(ca)
    }
    expect(ids).toContain('on-state-new-hire-report')
    expect(ids).toContain('on-i9-section2')
    const off = generateChecklist(db, { person: { ...caleb, endDate: '2027-01-29' }, templateId: 'tpl-offboarding', anchorDate: '2027-01-29', createdOn: '2027-01-15', separationType: 'resigned_notice' }).tasks.map((t) => t.templateTaskId)
    expect(off).not.toContain('off-final-pay-notice')
    expect(off).not.toContain('off-separation-notices-optional')
    expect(off).toContain('off-state-final-pay')
  })

  it('says CFRA and PDL cover California work only', () => {
    const db = base()
    db.people.push(mk('p-caleb', 'Caleb', { homeState: 'TX', startDate: '2025-01-06', hireNumber: 8 }))
    const r = leaveEligibility(db, 'p-caleb', 'cfra', '2026-10-09')
    expect(r.eligible).toBe(false)
    expect(r.reasons[0]).toMatch(/cover employees who work in California; Caleb works in TX/)
  })

  it('checks Texas pay against the Texas minimum wage and skips the California exempt floor', () => {
    const db = base()
    const tx = exemptCheck(db, { flsa: 'non_exempt', payType: 'hourly', hourlyRate: 15, locationId: 'loc-remote-tx' })
    expect(tx.status).toBe('ok')
    expect(tx.messages.join(' ')).not.toMatch(/2810\.5|16\.90|8 hours in a day/)
    expect(exemptCheck(db, { flsa: 'non_exempt', payType: 'hourly', hourlyRate: 7, locationId: 'loc-remote-tx' }).messages[0]).toBe(
      '$7.00 an hour is below the $7.25 minimum wage for Remote (Texas).',
    )
    const exempt = exemptCheck(db, { flsa: 'exempt', payType: 'salary', salary: 60_000, exemptionBasis: 'administrative', locationId: 'loc-remote-tx' })
    expect(exempt.mustBeNonExempt).toBe(false)
    expect(exempt.messages[0]).toMatch(/apply only to work in California/)
    // California still gets the California floor.
    expect(exemptCheck(db, { flsa: 'exempt', payType: 'salary', salary: 60_000, exemptionBasis: 'administrative', locationId: 'loc-hq' }).mustBeNonExempt).toBe(true)
  })

  it('writes neutral governing-law and commission terms into a Texas offer letter', () => {
    const db = base()
    db.candidates.push({ id: 'c-c', firstName: 'Cal', lastName: 'Rivers', email: 'c@x.com', links: {}, source: 'inbound', sponsorship: 'no', tags: [], createdOn: '2026-09-01' })
    const offer = {
      id: 'o-c',
      applicationId: 'a-c',
      candidateId: 'c-c',
      jobId: 'j-c',
      version: 1,
      title: 'Account executive',
      levelId: 'lv-l3',
      familyId: 'f-gtm',
      departmentId: 'd-eng',
      managerId: 'p-founder',
      locationId: 'loc-remote-tx',
      workMode: 'remote',
      employmentType: 'full_time',
      flsa: 'exempt',
      payType: 'salary',
      salary: 120_000,
      variablePct: 0.5,
      equityType: 'ISO',
      equityShares: 0,
      vestingMonths: 48,
      cliffMonths: 12,
      startDate: '2026-11-02',
      expiresOn: '2026-10-20',
      contingencies: [],
      status: 'approved',
      createdOn: '2026-10-09',
      approvals: [],
    } as Offer
    db.offers.push(offer)
    const text = offerLetter(db, 'o-c')?.text ?? ''
    expect(text).not.toMatch(/Labor Code 925|Labor Code 2751|Labor Code 2922/)
    expect(text).toMatch(/governed by the law of the state where you work \(TX\)/)
  })
})

describe('dates (cq-7, cq-8, legal-3)', () => {
  it('keeps Pacific wall-clock time when shifting across daylight saving', () => {
    // Fri Oct 9, 10:00 AM PDT -> Fri Dec 4, 10:00 AM PST.
    expect(shiftTimestampDays('2026-10-09T17:00:00.000Z', 56)).toBe('2026-12-04T18:00:00.000Z')
    expect(shiftTimestampDays('2026-10-09T17:00:00.000Z', 7)).toBe('2026-10-16T17:00:00.000Z')
  })

  it('reads a timestamp as its local calendar day, not its UTC date', () => {
    const ts = new Date(2026, 9, 9, 22, 30).toISOString() // 10:30 PM local on Oct 9
    expect(localDateOf(ts)).toBe('2026-10-09')
    expect(localDateOf('2026-10-09')).toBe('2026-10-09')
  })

  it('lists the 2026 federal holidays with observed dates', () => {
    expect(federalHolidays(2026)).toEqual([
      '2026-01-01',
      '2026-01-19',
      '2026-02-16',
      '2026-05-25',
      '2026-06-19',
      '2026-07-03',
      '2026-09-07',
      '2026-10-12',
      '2026-11-11',
      '2026-11-26',
      '2026-12-25',
    ])
  })

  it('counts I-9 section 2 over federal holidays only, never company days off', () => {
    const db = base()
    const tpl = DEFAULT_CHECKLIST_TEMPLATES.find((t) => t.id === 'tpl-onboarding')
    const task = tpl?.tasks.find((t) => t.id === 'on-i9-section2')
    if (!task) throw new Error('no I-9 task')
    const companyDays = db.holidays.map((h) => h.date) // includes the day after Thanksgiving and Christmas Eve
    expect(taskDueOn(task, '2026-11-25', companyDays)).toBe('2026-12-01')
    expect(taskDueOn(task, '2026-12-23', companyDays)).toBe('2026-12-29')
    expect(taskDueOn(task, '2026-11-24', companyDays)).toBe('2026-11-30')
  })
})

describe('training deadlines (legal-6, legal-17)', () => {
  it('gives a California intern 30 days, the same as the onboarding task', () => {
    const db = base()
    const intern = mk('p-int', 'Ivy', { employmentType: 'intern', startDate: '2026-06-15', hireNumber: 9 })
    db.people.push(intern)
    const row = trainingRequirements(db, intern, '2026-07-01').find((r) => r.course === 'harassment')
    expect(row).toMatchObject({ required: true, dueOn: '2026-07-15' })
    expect(row?.reason).toMatch(/Short-term hire/)
  })

  it('treats only the yearly WVPP refresher as a statutory date', () => {
    expect(isStatutoryTraining({ course: 'wvpp' })).toBe(false)
    expect(isStatutoryTraining({ course: 'wvpp', completedOn: '2026-01-10' })).toBe(true)
    expect(isStatutoryTraining({ course: 'harassment' })).toBe(true)
    expect(isStatutoryTraining({ course: 'security_awareness', completedOn: '2026-01-10' })).toBe(false)
  })
})

describe('compliance calendar and evidence (legal-11, flow-11, flow-6)', () => {
  it('moves a statutory recurring date off a weekend', () => {
    const db = base()
    db.recurring.push({ id: 'rec-1099', title: 'File 1099-NEC forms', ruleId: 'first-contractor', cadence: 'annual', nextDueOn: '2027-01-31' } as DB['recurring'][number])
    const item = complianceCalendar(db, '2027-01-01', '2027-02-28').find((i) => i.id.startsWith('rec-rec-1099'))
    expect(item?.date).toBe('2027-02-01')
  })

  it('puts only policy versions from the audit period in the re-acknowledgement population', () => {
    const db = base()
    db.company.soc2Enabled = true
    db.policies = [
      { id: 'pl-old', title: 'Old policy', version: '1.0', effectiveOn: '2025-05-01', summary: '', requiresAck: true },
      { id: 'pl-new', title: 'New handbook', version: '2.0', effectiveOn: '2026-09-15', summary: '', requiresAck: true },
    ]
    const ev = soc2Evidence(db, '2026-08-01', '2027-01-31', '2026-10-09')
    const labels = ev.controls.flatMap((c) => [...c.rows, ...(c.subChecks ?? []).flatMap((k) => k.rows)].map((r) => r.label))
    expect(labels.some((l) => l.includes('New handbook'))).toBe(true)
    expect(labels.some((l) => l.includes('Old policy'))).toBe(false)
  })

  it('reopens the SB 553 training step while the tracker shows people untrained', () => {
    const db = produce(base(), (d) => {
      d.locations[0].typicalMaxOnSite = 12
      d.complianceStatus.wvpp = { actionsDone: { 'write-plan': '2026-09-01', train: '2026-09-15' } }
    })
    const r = evaluateRule(db, RULE_BY_ID.wvpp, '2026-10-09')
    expect(r.actionsDone.train).toBeUndefined()
    expect(r.openActions.map((a) => a.id)).toContain('train')
  })
})

describe('notes and people helpers (law-1, spec-5, spec-19)', () => {
  it('flags criminal history in a note but not ordinary words', () => {
    expect(criminalHistoryLint('She mentioned a felony conviction from 2019')).toMatch(/before a conditional offer/)
    expect(criminalHistoryLint('Great track record shipping on time')).toBeNull()
    expect(criminalHistoryLint('Explained our probationary period')).toBeNull()
    expect(criminalHistoryLint('We never ask about arrests')).toBeNull()
    expect(criminalHistoryLint('Background check came back with a DUI', { conditionalOfferOn: '2026-10-01' })).toMatch(/status and dates/)
    expect(salaryHistoryLint('Her current salary is 180k')).toMatch(/pay history/)
    expect(salaryHistoryLint('Has a misdemeanor')).toMatch(/12952/)
  })

  it('finds the earlier stint of a rehire by personal email or name', () => {
    const db = base()
    db.people.push(mk('p-omar', 'Omar', { lastName: 'Haddad', endDate: '2026-08-28', personalEmail: 'omar@x.com', hireNumber: 10 }))
    expect(priorStint(db, { id: 'new', firstName: 'Omar', lastName: 'Haddad', startDate: '2026-11-02' })?.id).toBe('p-omar')
    expect(priorStint(db, { id: 'new', firstName: 'Omar', lastName: 'Haddad', personalEmail: 'other@x.com', startDate: '2026-11-02' })).toBeUndefined()
  })

  it('fills the first-day welcome email for a new hire', () => {
    const db = base()
    db.people.push(mk('p-new', 'Lucas', { lastName: 'Ferreira', startDate: '2026-10-19', personalEmail: 'lucas@x.com', hireNumber: 18 }))
    const mail = welcomeEmail(db, 'p-new')
    expect(mail?.to).toBe('lucas@x.com')
    expect(mail?.subject).toBe('Welcome to Testco: your first day, Monday, October 19')
    expect(mail?.body).toMatch(/Maya Raman is your manager/)
    expect(mail?.body).not.toMatch(/\{\{/)
  })
})
