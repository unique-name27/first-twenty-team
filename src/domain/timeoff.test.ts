import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import {
  approveAsUnpaid,
  approveRequest,
  balances,
  cancelRequest,
  checkRequest,
  createRequest,
  declineRequest,
  hoursLabel,
  hoursPerDayFor,
  payPeriods,
  pendingApprovals,
  policyAvailable,
  requestHours,
  serviceWait,
  timeOffICS,
  unpaidPolicyFor,
  vacationPayout,
  whoIsOut,
  workdays,
} from '@/domain/timeoff'
import type { CompRecord, DB, Person, TimeOffPolicy, TimeOffRequest } from '@/domain/types'

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

function baseDB(): DB {
  return blankDB({ companyName: 'Testco', founderFirstName: 'Maya', founderLastName: 'Raman', foundedOn: '2025-02-03' })
}

function addRequest(db: DB, id: string, personId: string, policyId: string, startDate: string, endDate: string, status: TimeOffRequest['status'] = 'approved'): void {
  const person = db.people.find((p) => p.id === personId) as Person
  db.timeOffRequests.push({
    id,
    personId,
    policyId,
    startDate,
    endDate,
    hours: requestHours(startDate, endDate, db.holidays, undefined, hoursPerDayFor(person)),
    status,
    requestedOn: '2026-01-01',
  })
}

function salary(personId: string, effectiveOn: string, amount: number, over: Partial<CompRecord> = {}): CompRecord {
  return { id: `cr-${personId}`, personId, effectiveOn, payType: 'salary', salary: amount, title: 'Engineer', levelId: 'lv-l3', reason: 'hire', ...over }
}

function row(db: DB, personId: string, policyId: string, date = D) {
  const r = balances(db, personId, date).find((b) => b.policy.id === policyId)
  if (!r) throw new Error(`No ${policyId} row`)
  return r
}

describe('workdays and request hours', () => {
  const db = baseDB()
  it('skips weekends and company holidays', () => {
    // Thanksgiving week 2026: Thu Nov 26 and Fri Nov 27 are holidays.
    expect(workdays('2026-11-23', '2026-11-27', db.holidays)).toBe(3)
    expect(requestHours('2026-11-23', '2026-11-27', db.holidays)).toBe(24)
    // Independence Day observed on Fri Jul 3, 2026.
    expect(workdays('2026-06-29', '2026-07-05', db.holidays)).toBe(4)
    expect(workdays('2026-06-29', '2026-07-05', ['2026-07-02'])).toBe(4)
    expect(workdays('2026-10-10', '2026-10-11', db.holidays)).toBe(0)
    expect(workdays('2026-10-12', '2026-10-09', db.holidays)).toBe(0)
  })

  it('halves the last day for a partial request and scales for part time', () => {
    expect(requestHours('2026-10-30', '2026-10-30', db.holidays, 'pm')).toBe(4)
    expect(requestHours('2026-11-23', '2026-11-27', db.holidays, 'am')).toBe(20)
    expect(hoursPerDayFor({ hoursPerWeek: 24 })).toBe(4.8)
    expect(requestHours('2026-11-23', '2026-11-27', db.holidays, undefined, 4.8)).toBe(14.4)
  })

  it('builds semi-monthly pay periods', () => {
    expect(payPeriods('semi_monthly', '2026-02-10', '2026-03-01', '2025-02-03')).toEqual([
      { start: '2026-02-01', end: '2026-02-15' },
      { start: '2026-02-16', end: '2026-02-28' },
      { start: '2026-03-01', end: '2026-03-15' },
    ])
  })
})

describe('policy availability', () => {
  it('turns on bereavement leave at 5 employees and respects who a policy covers', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-a', 'Ana', '2026-01-05'))
    const bereavement = db.timeOffPolicies.find((p) => p.id === 'pol-bereavement') as TimeOffPolicy
    expect(policyAvailable(db, bereavement, db.people[1], D)).toBe(false)
    db.people.push(mkPerson('p-b', 'Ben', '2026-01-05'), mkPerson('p-c', 'Cy', '2026-01-05'), mkPerson('p-d', 'Di', '2026-01-05'))
    expect(policyAvailable(db, bereavement, db.people[1], D)).toBe(true)
    const nonExemptOnly: TimeOffPolicy = { ...bereavement, id: 'pol-x', appliesFromHeadcount: undefined, appliesTo: 'non_exempt' }
    expect(policyAvailable(db, nonExemptOnly, db.people[1], D)).toBe(false)
    expect(balances(db, 'p-a', D).map((b) => b.policy.id)).toContain('pol-bereavement')
  })

  it('limits a policy to the work states it lists', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-ca', 'Ana', '2026-01-05'), mkPerson('p-tx', 'Tex', '2026-01-05', { homeState: 'TX' }))
    // Without appliesToStates, a policy reaches everyone.
    db.timeOffPolicies = db.timeOffPolicies.map((p) => (p.id === 'pol-sick' ? { ...p, appliesToStates: undefined } : p))
    expect(balances(db, 'p-tx', D).map((b) => b.policy.id)).toContain('pol-sick')
    db.timeOffPolicies = db.timeOffPolicies.map((p) => (p.id === 'pol-sick' ? { ...p, appliesToStates: ['CA'] } : p))
    const sick = db.timeOffPolicies.find((p) => p.id === 'pol-sick') as TimeOffPolicy
    expect(policyAvailable(db, sick, db.people.find((p) => p.id === 'p-ca') as Person, D)).toBe(true)
    expect(policyAvailable(db, sick, db.people.find((p) => p.id === 'p-tx') as Person, D)).toBe(false)
    expect(balances(db, 'p-tx', D).map((b) => b.policy.id)).not.toContain('pol-sick')
    expect(checkRequest(db, { personId: 'p-tx', policyId: 'pol-sick', startDate: '2026-10-12', endDate: '2026-10-12' }, D).warnings).toContain(
      'Sick leave does not apply to this person.',
    )
  })
})

describe('vacation accrual', () => {
  it('earns 5 hours each completed semi-monthly period and subtracts what was taken', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-v', 'Vic', '2026-01-01'))
    addRequest(db, 'tr-past', 'p-v', 'pol-vacation', '2026-03-02', '2026-03-06')
    addRequest(db, 'tr-future', 'p-v', 'pol-vacation', '2026-11-23', '2026-11-25')
    addRequest(db, 'tr-pending', 'p-v', 'pol-vacation', '2026-12-28', '2026-12-30', 'pending')
    addRequest(db, 'tr-declined', 'p-v', 'pol-vacation', '2026-08-03', '2026-08-07', 'declined')
    const r = row(db, 'p-v', 'pol-vacation')
    // Jan 1 to Sep 30: 18 completed periods; Oct 1-15 is still running on Oct 9.
    expect(r).toMatchObject({ display: 'hours', earned: 90, used: 40, balance: 50, scheduled: 24, available: 26, pending: 24, capReached: false })
    expect(r.note).toBe('Earns 5 hours each pay period, up to 180 hours.')
  })

  it('pauses earning at the 180-hour cap and resumes after time is used', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-cap', 'Cass', '2024-01-01'))
    // 36 periods of 5 hours reach 180 hours on Jun 30, 2025. Earning stays paused until Sep 1-4, 2026 (32 hours).
    addRequest(db, 'tr-sep', 'p-cap', 'pol-vacation', '2026-09-01', '2026-09-04')
    const before = row(db, 'p-cap', 'pol-vacation', '2026-08-31')
    expect(before).toMatchObject({ earned: 180, balance: 180, capReached: true })
    expect(before.note).toBe('At the 180-hour cap, so earning is paused until some is used.')
    const after = row(db, 'p-cap', 'pol-vacation')
    // 148 after the time off, then Sep 15 and Sep 30 add 5 each.
    expect(after).toMatchObject({ earned: 190, used: 32, balance: 158, capReached: false })
  })

  it('prorates part-time accrual by hours per week and a mid-period start by days', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-pt', 'Luis', '2026-07-20', { employmentType: 'part_time', hoursPerWeek: 24, flsa: 'non_exempt' }))
    const r = row(db, 'p-pt', 'pol-vacation')
    // 3 hours a period at 24/40; Jul 20-31 is 12 of 16 days (2.25), then 4 full periods (12).
    expect(r.earned).toBe(14.25)
    expect(r.note).toBe('Earns 3 hours each pay period (prorated for 24 hours a week), up to 180 hours.')
  })

  it('adds manual adjustments', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-v', 'Vic', '2026-01-01'))
    db.timeOffAdjustments.push({ id: 'adj-1', personId: 'p-v', policyId: 'pol-vacation', date: '2026-02-01', hours: 8, reason: 'Carryover from offer' })
    expect(row(db, 'p-v', 'pol-vacation')).toMatchObject({ earned: 90, adjustments: 8, balance: 98 })
  })
})

describe('sick leave front-load', () => {
  it('grants 40 hours at hire, usable from day 90', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-new', 'Nia', '2026-07-13'))
    const r = row(db, 'p-new', 'pol-sick')
    expect(r).toMatchObject({ earned: 40, balance: 40, available: 40, usableFrom: '2026-10-10' })
    expect(r.note).toBe('Usable from Oct 10, 2026 (the 90th day of employment). 5 days each January 1 and at hire, up to 40 hours used a year.')
    expect(row(db, 'p-new', 'pol-sick', '2026-10-12').usableFrom).toBeUndefined()
  })

  it('resets on January 1 with no carryover', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-s', 'Sam', '2025-10-06'))
    addRequest(db, 'tr-dec', 'p-s', 'pol-sick', '2025-12-15', '2025-12-18')
    expect(row(db, 'p-s', 'pol-sick', '2025-12-31')).toMatchObject({ earned: 40, used: 32, balance: 8 })
    expect(row(db, 'p-s', 'pol-sick', '2026-01-02')).toMatchObject({ earned: 40, used: 0, balance: 40, available: 40 })
  })

  it('caps use at 40 hours a year even with extra hours on the books', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-s', 'Sam', '2025-10-06'))
    db.timeOffAdjustments.push({ id: 'adj-s', personId: 'p-s', policyId: 'pol-sick', date: '2026-02-01', hours: 16, reason: 'Restored on rehire' })
    addRequest(db, 'tr-mar', 'p-s', 'pol-sick', '2026-03-02', '2026-03-06')
    const r = row(db, 'p-s', 'pol-sick')
    expect(r).toMatchObject({ used: 40, adjustments: 16, balance: 0, available: 0, capReached: true })
    expect(r.note).toBe('Used the 40-hour yearly limit. Resets January 1.')
  })
})

describe('sick leave on a rehire (Labor Code 246(g)(2))', () => {
  it('restores the hours left at exit and drops the 90-day wait when rehired within 12 months', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-old', 'Omar', '2026-01-05', { endDate: '2026-06-30', personalEmail: 'omar@example.com' }))
    addRequest(db, 'tr-old', 'p-old', 'pol-sick', '2026-03-02', '2026-03-03')
    db.people.push(mkPerson('p-back', 'Omar', '2026-09-08', { personalEmail: 'Omar@Example.com', hireNumber: 18 }))
    const r = row(db, 'p-back', 'pol-sick', '2026-09-10')
    // 40 granted at the rehire plus the 24 hours left in June.
    expect(r).toMatchObject({ earned: 40, adjustments: 24 })
    expect(r.usableFrom).toBeUndefined()
    expect(r.note).toContain('3 days restored from before')
    expect(checkRequest(db, { personId: 'p-back', policyId: 'pol-sick', startDate: '2026-09-14', endDate: '2026-09-14' }, '2026-09-10').warnings).toEqual([])
  })

  it('says before the start date what day 1 brings, restored hours included', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-old', 'Omar', '2026-01-05', { endDate: '2026-08-28', personalEmail: 'omar@example.com' }))
    addRequest(db, 'tr-old', 'p-old', 'pol-sick', '2026-03-02', '2026-03-03')
    db.people.push(mkPerson('p-back', 'Omar', '2026-10-19', { personalEmail: 'omar@example.com', hireNumber: 18, rehireOfPersonId: 'p-old' }))
    const r = row(db, 'p-back', 'pol-sick', '2026-10-11')
    // Nothing on the books yet, but the row says what arrives on Oct 19: no wait for a rehire within 12 months.
    expect(r).toMatchObject({ earned: 0, balance: 0, usableFrom: '2026-10-19', startsOn: { date: '2026-10-19', granted: 40, restored: 24, hours: 40 } })
    // 64 hours on the books, but the policy's 40-hour yearly limit is what can be used: the note says why the number is 40.
    expect(r.note).toBe(
      'On Oct 19, 2026, the start date: 5 days plus 3 days restored from before (rehired within 12 months, Labor Code 246), 64 hours on the books; up to 40 hours (5 days) can be used a year under your policy, usable from day 1. 5 days each January 1 and at hire.',
    )
    // From day 1 the row is the usual one, and the note still explains the limit.
    const started = row(db, 'p-back', 'pol-sick', '2026-10-19')
    expect(started.startsOn).toBeUndefined()
    expect(started).toMatchObject({ balance: 40, available: 40 })
    expect(started.note).toBe(
      '5 days each January 1 and at hire, up to 40 hours used a year. Includes 3 days restored from before (rehired within 12 months, Labor Code 246), usable now. 64 hours on the books in all, of which up to 40 hours (5 days) can be used a year under your policy.',
    )
    // A new hire who has not started gets the grant on day 1, usable after the 90-day wait.
    db.people.push(mkPerson('p-new', 'Nia', '2026-11-02'))
    const fresh = row(db, 'p-new', 'pol-sick', '2026-10-11')
    expect(fresh).toMatchObject({ usableFrom: '2027-01-30', startsOn: { date: '2026-11-02', granted: 40, restored: 0, hours: 40 } })
    expect(fresh.note).toMatch(/^On Nov 2, 2026, the start date: 5 days, usable from Jan 30, 2027 \(the 90th day of employment\)\./)
  })

  it('keeps the plain day-1 note when the restored hours fit under the yearly limit', () => {
    const db = baseDB()
    db.timeOffPolicies = db.timeOffPolicies.map((p) => (p.id === 'pol-sick' ? { ...p, usageCapHours: 80 } : p))
    db.people.push(mkPerson('p-old', 'Omar', '2026-01-05', { endDate: '2026-08-28' }))
    db.people.push(mkPerson('p-back', 'Omar', '2026-10-19', { hireNumber: 18, rehireOfPersonId: 'p-old' }))
    const r = row(db, 'p-back', 'pol-sick', '2026-10-11')
    expect(r.startsOn).toEqual({ date: '2026-10-19', granted: 40, restored: 40, hours: 80 })
    expect(r.note).toBe(
      'On Oct 19, 2026, the start date: 5 days plus 5 days restored from before (rehired within 12 months, Labor Code 246), usable from day 1. 5 days each January 1 and at hire, up to 80 hours used a year.',
    )
  })

  it('treats a return after more than 12 months as a new hire', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-old', 'Omar', '2025-01-06', { endDate: '2025-06-30' }))
    db.people.push(mkPerson('p-back', 'Omar', '2026-08-03', { hireNumber: 18 }))
    const r = row(db, 'p-back', 'pol-sick', '2026-08-05')
    expect(r.adjustments).toBe(0)
    expect(r.usableFrom).toBe('2026-10-31')
  })

  it('does not match a different person who only shares a name', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-old', 'Omar', '2026-01-05', { endDate: '2026-06-30', personalEmail: 'omar@example.com' }))
    db.people.push(mkPerson('p-other', 'Omar', '2026-09-08', { personalEmail: 'other@example.com', hireNumber: 18 }))
    expect(row(db, 'p-other', 'pol-sick', '2026-09-10').adjustments).toBe(0)
  })
})

describe('flexible and per-event policies', () => {
  it('shows flexible vacation without a balance and per-event leave with its limit', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-a', 'Ana', '2026-01-05'))
    // Default policy arrays are shared and frozen by Immer, so replace rather than mutate.
    db.timeOffPolicies = [
      {
        id: 'pol-flex',
        name: 'Flexible vacation',
        kind: 'flexible_vacation',
        method: 'flexible',
        paidOutOnExit: false,
        appliesTo: 'exempt',
        description: 'Take what you need.',
      },
      ...db.timeOffPolicies,
    ]
    addRequest(db, 'tr-flex', 'p-a', 'pol-flex', '2026-06-01', '2026-06-05')
    const flex = row(db, 'p-a', 'pol-flex')
    expect(flex).toMatchObject({ display: 'flexible', earned: null, balance: null, available: null, used: 40 })
    const voting = row(db, 'p-a', 'pol-voting')
    expect(voting).toMatchObject({ display: 'per_event', perEventHours: 2, note: 'Up to 2 hours per event.' })
  })
})

describe('requests', () => {
  function teamDB(): DB {
    const db = baseDB()
    db.people.push(
      mkPerson('p-v', 'Vic', '2026-01-01'),
      mkPerson('p-b', 'Ben', '2026-01-05'),
      mkPerson('p-c', 'Cy', '2026-01-05'),
      mkPerson('p-d', 'Di', '2026-01-05'),
    )
    return db
  }

  it('creates a pending vacation request with holidays skipped, then approves it once', () => {
    const start = teamDB()
    const created = produce(start, (d) => {
      createRequest(d, { personId: 'p-v', policyId: 'pol-vacation', startDate: '2026-11-23', endDate: '2026-11-27' }, { date: D, id: 'tr-1' })
    })
    const req = created.timeOffRequests.find((r) => r.id === 'tr-1')
    expect(req).toMatchObject({ hours: 24, status: 'pending', requestedOn: D })
    expect(pendingApprovals(created).map((r) => r.id)).toEqual(['tr-1'])
    expect(pendingApprovals(created, { managerId: 'p-founder' }).map((r) => r.id)).toEqual(['tr-1'])
    expect(pendingApprovals(created, { managerId: 'p-b' })).toEqual([])
    expect(created.activity[0].text).toBe('Vic Test requested vacation, Mon, Nov 23 to Fri, Nov 27 (3 days)')

    let ok = false
    let again = true
    const approved = produce(created, (d) => {
      ok = approveRequest(d, 'tr-1', { date: D, approverId: 'p-founder' })
      again = approveRequest(d, 'tr-1', { date: D })
    })
    expect(ok).toBe(true)
    expect(again).toBe(false)
    expect(approved.timeOffRequests.find((r) => r.id === 'tr-1')).toMatchObject({ status: 'approved', approverId: 'p-founder', decidedOn: D })
    expect(approved.activity.at(-1)?.text).toBe("Approved Vic Test's vacation, Mon, Nov 23 to Fri, Nov 27")
    expect(pendingApprovals(approved)).toEqual([])

    let declined = true
    const cancelled = produce(approved, (d) => {
      declined = declineRequest(d, 'tr-1', { date: D })
      cancelRequest(d, 'tr-1', { date: D })
    })
    expect(declined).toBe(false)
    expect(cancelled.timeOffRequests.find((r) => r.id === 'tr-1')?.status).toBe('cancelled')
  })

  it('auto-approves sick leave, which never waits for approval', () => {
    const next = produce(teamDB(), (d) => {
      createRequest(d, { personId: 'p-v', policyId: 'pol-sick', startDate: '2026-10-30', endDate: '2026-10-30' }, { date: D, id: 'tr-s' })
    })
    expect(next.timeOffRequests[0]).toMatchObject({ status: 'approved', decidedOn: D, hours: 8 })
    expect(pendingApprovals(next)).toEqual([])
    expect(next.activity[0].text).toBe('Time off recorded for Vic Test, Fri, Oct 30 (1 day), approved automatically')
  })

  it('keeps confidential leave types out of activity text', () => {
    const next = produce(teamDB(), (d) => {
      createRequest(d, { personId: 'p-v', policyId: 'pol-bereavement', startDate: '2026-10-12', endDate: '2026-10-13' }, { date: D, id: 'tr-b' })
    })
    expect(next.activity[0].text).toBe('Vic Test requested time off, Mon, Oct 12 to Tue, Oct 13 (2 days)')
  })

  it('warns about the sick leave wait, a short balance and overlaps without blocking', () => {
    const db = teamDB()
    db.people.push(mkPerson('p-new', 'Nia', '2026-07-13'))
    const sick = checkRequest(db, { personId: 'p-new', policyId: 'pol-sick', startDate: '2026-10-09', endDate: '2026-10-09' }, D)
    expect(sick.hours).toBe(8)
    expect(sick.warnings).toEqual(['Sick leave is usable from Oct 10, 2026 (the 90th day of employment, Labor Code 246).'])
    addRequest(db, 'tr-1', 'p-v', 'pol-vacation', '2026-11-23', '2026-11-25')
    const big = checkRequest(db, { personId: 'p-v', policyId: 'pol-vacation', startDate: '2026-11-02', endDate: '2026-11-24' }, D)
    // Projected to Mon Nov 2: 20 periods (100 hours) minus 24 scheduled after it leaves 76;
    // 17 workdays (no company holidays) = 136 hours.
    expect(big.hours).toBe(136)
    expect(big.balanceAfter).toBe(-60)
    expect(big.warnings).toEqual([
      'This is 60 hours more than the vacation balance on Mon, Nov 2.',
      'Overlaps an existing request (Mon, Nov 23 to Wed, Nov 25).',
    ])
    // Sick leave used up this year does not limit a request next year.
    addRequest(db, 'tr-sick', 'p-v', 'pol-sick', '2026-03-02', '2026-03-06')
    expect(checkRequest(db, { personId: 'p-v', policyId: 'pol-sick', startDate: '2026-10-12', endDate: '2026-10-12' }, D).warnings).toEqual([
      'This goes 8 hours past the 40-hour yearly limit for sick leave.',
    ])
    expect(checkRequest(db, { personId: 'p-v', policyId: 'pol-sick', startDate: '2027-01-04', endDate: '2027-01-04' }, D).warnings).toEqual([])
    const weekend = checkRequest(db, { personId: 'p-v', policyId: 'pol-vacation', startDate: '2026-10-10', endDate: '2026-10-11' }, D)
    expect(weekend.warnings).toContain('Those dates are all weekends or company holidays.')
  })

  it('labels part-time days by their own length in the activity log, .ics and sick note', () => {
    const db = teamDB()
    db.people.push(mkPerson('p-luis', 'Luis', '2026-07-20', { employmentType: 'part_time', hoursPerWeek: 24, flsa: 'non_exempt' }))
    const next = produce(db, (d) => {
      createRequest(d, { personId: 'p-luis', policyId: 'pol-vacation', startDate: '2026-11-02', endDate: '2026-11-06' }, { date: D, id: 'tr-l' })
    })
    expect(next.timeOffRequests[0].hours).toBe(24)
    expect(next.activity[0].text).toBe('Luis Test requested vacation, Mon, Nov 2 to Fri, Nov 6 (5 days, 24 hours)')
    // Unfold the 75-octet ICS lines before matching (commas are escaped in ICS text).
    expect(timeOffICS(next, 'tr-l').replace(/\r\n /g, '')).toContain('Fri\\, Nov 6\\, 5 days\\, 24 hours.')
    // 40 hours is about 8.3 of his 4.8-hour days, so the note says hours.
    expect(row(next, 'p-luis', 'pol-sick', '2026-11-01').note).toBe('40 hours each January 1 and at hire, up to 40 hours used a year.')
    expect(hoursLabel(24)).toBe('3 days')
    expect(hoursLabel(4.8, 4.8)).toBe('1 day, 4.8 hours')
    expect(hoursLabel(12, 4.8)).toBe('12 hours')
    expect(hoursLabel(14.4, 4.8)).toBe('3 days, 14.4 hours')
    expect(hoursLabel(1)).toBe('1 hour')
  })

  it('checks bereavement and reproductive loss service, per-event days and the 12-month limit', () => {
    const db = teamDB()
    db.people.push(
      mkPerson('p-new', 'Nia', '2026-10-01'),
      mkPerson('p-luis', 'Luis', '2026-07-20', { employmentType: 'part_time', hoursPerWeek: 24, flsa: 'non_exempt' }),
    )
    // 30 days of service first, for every kind of policy (not only front-loaded sick leave).
    const early = checkRequest(db, { personId: 'p-new', policyId: 'pol-bereavement', startDate: '2026-10-12', endDate: '2026-10-13' }, D)
    expect(early.warnings).toEqual(['Bereavement is usable from Oct 31, 2026 (30 days after the start date, Gov Code 12945.7).'])
    expect(row(db, 'p-new', 'pol-bereavement')).toMatchObject({ usableFrom: '2026-10-31' })
    expect(row(db, 'p-new', 'pol-bereavement').note).toBe('Usable from Oct 31, 2026 (30 days after the start date). Up to 5 days per event.')
    // 5 days per event, counted in workdays: 7 of Luis's 4.8-hour days (33.6 hours) is still over.
    const luis = checkRequest(db, { personId: 'p-luis', policyId: 'pol-bereavement', startDate: '2026-11-02', endDate: '2026-11-10' }, D)
    expect(luis.hours).toBe(33.6)
    expect(luis.warnings).toEqual(['Bereavement is up to 5 days per event (Gov Code 12945.7).'])
    expect(checkRequest(db, { personId: 'p-v', policyId: 'pol-bereavement', startDate: '2026-11-02', endDate: '2026-11-06' }, D).warnings).toEqual([])
    // Reproductive loss: no more than 20 days in 12 months, approved and pending together.
    addRequest(db, 'tr-r1', 'p-v', 'pol-repro-loss', '2026-02-02', '2026-02-06')
    addRequest(db, 'tr-r2', 'p-v', 'pol-repro-loss', '2026-04-06', '2026-04-10')
    addRequest(db, 'tr-r3', 'p-v', 'pol-repro-loss', '2026-06-01', '2026-06-05')
    addRequest(db, 'tr-r4', 'p-v', 'pol-repro-loss', '2026-08-03', '2026-08-07', 'pending')
    addRequest(db, 'tr-r0', 'p-v', 'pol-repro-loss', '2026-09-07', '2026-09-11', 'declined')
    expect(checkRequest(db, { personId: 'p-v', policyId: 'pol-repro-loss', startDate: '2026-10-12', endDate: '2026-10-13' }, D).warnings).toEqual([
      'Reproductive loss is up to 20 days in 12 months (Gov Code 12945.6). With this request, 22 days fall in the 12 months ending Tue, Oct 13.',
    ])
    // A year later the February days have rolled off.
    expect(checkRequest(db, { personId: 'p-v', policyId: 'pol-repro-loss', startDate: '2027-02-08', endDate: '2027-02-09' }, D).warnings).toEqual([])
  })
})

describe("who's out", () => {
  it('lists approved and pending time off plus leave cases shown as Leave', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-e', 'Elena', '2025-08-18'), mkPerson('p-t', 'Tomas', '2025-05-12'))
    addRequest(db, 'tr-e', 'p-e', 'pol-vacation', '2026-10-12', '2026-10-16')
    addRequest(db, 'tr-p', 'p-e', 'pol-vacation', '2026-12-28', '2026-12-30', 'pending')
    addRequest(db, 'tr-x', 'p-e', 'pol-vacation', '2026-11-02', '2026-11-03', 'declined')
    db.leaveCases.push({ id: 'lc-t', personId: 'p-t', kind: 'bonding', requestedOn: '2026-10-06', startDate: '2026-11-16', expectedReturn: '2027-01-08' })
    const out = whoIsOut(db, '2026-10-01', '2026-12-31')
    expect(out.map((o) => [o.personId, o.from, o.to, o.kind, o.status, o.label])).toEqual([
      ['p-e', '2026-10-12', '2026-10-16', 'vacation', 'approved', 'Vacation'],
      ['p-t', '2026-11-16', '2027-01-07', 'leave', 'leave', 'Leave'],
      ['p-e', '2026-12-28', '2026-12-30', 'vacation', 'pending', 'Vacation'],
    ])
    expect(whoIsOut(db, '2026-10-19', '2026-11-13')).toEqual([])
    // A case that closed without a return ends on its closing date.
    db.leaveCases = [{ ...db.leaveCases[0], endedOn: '2026-11-30' }]
    expect(whoIsOut(db, '2026-11-01', '2026-12-31').find((o) => o.kind === 'leave')?.to).toBe('2026-11-30')
  })
})

describe('vacation payout', () => {
  it('pays accrued vacation at the final rate and never sick leave', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-pay', 'Pat', '2026-01-01'))
    db.comp.push(salary('p-pay', '2026-01-01', 156_000))
    const full = vacationPayout(db, 'p-pay', '2026-08-31')
    expect(full).toMatchObject({ hours: 80, rate: 75, amount: 6_000 })
    expect(full.rows.map((r) => r.policyId)).toEqual(['pol-vacation'])
    expect(full.note).toContain('Labor Code 227.3')
    // Vacation vests as earned: Aug 16-23 is 8 of 16 days of a period (2.5 hours).
    expect(vacationPayout(db, 'p-pay', '2026-08-23')).toMatchObject({ hours: 77.5, amount: 5_812.5 })
    addRequest(db, 'tr-jun', 'p-pay', 'pol-vacation', '2026-06-01', '2026-06-05')
    expect(vacationPayout(db, 'p-pay', '2026-08-31')).toMatchObject({ hours: 40, amount: 3_000 })
  })

  it('never counts past the recorded last day, so an alumnus payout stays what it was at exit', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-left', 'Omar', '2026-01-01', { endDate: '2026-08-23' }))
    db.comp.push(salary('p-left', '2026-01-01', 156_000))
    const atExit = vacationPayout(db, 'p-left', '2026-08-23')
    expect(atExit).toMatchObject({ hours: 77.5, amount: 5_812.5, asOf: '2026-08-23' })
    // Asked for today, it is still the payout at the last day.
    expect(vacationPayout(db, 'p-left', D)).toMatchObject({ hours: 77.5, amount: 5_812.5, asOf: '2026-08-23' })
    // The balance on the books after the exit matches it, and stops growing.
    expect(row(db, 'p-left', 'pol-vacation', D)).toMatchObject({ balance: 77.5, available: 77.5 })
    expect(row(db, 'p-left', 'pol-vacation', '2027-03-01').balance).toBe(77.5)
    // A last day still ahead is counted to that day.
    db.people.push(mkPerson('p-going', 'Elena', '2026-01-01', { endDate: '2026-10-30' }))
    db.comp.push(salary('p-going', '2026-01-01', 156_000))
    expect(vacationPayout(db, 'p-going', '2026-10-30').asOf).toBe('2026-10-30')
  })

  it('pays accrued vacation even when the policy says it is not paid out (Labor Code 227.3)', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-pay', 'Pat', '2026-01-01'))
    db.comp.push(salary('p-pay', '2026-01-01', 156_000))
    db.timeOffPolicies = db.timeOffPolicies.map((p) => (p.kind === 'vacation' ? { ...p, paidOutOnExit: false } : p))
    const out = vacationPayout(db, 'p-pay', '2026-08-31')
    expect(out).toMatchObject({ hours: 80, rate: 75, amount: 6_000 })
    expect(out.rows.map((r) => r.policyId)).toEqual(['pol-vacation'])
  })

  it('pays an hourly employee at the hourly rate', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-pt', 'Luis', '2026-07-20', { employmentType: 'part_time', hoursPerWeek: 24, flsa: 'non_exempt' }))
    db.comp.push(salary('p-pt', '2026-07-20', 0, { payType: 'hourly', salary: undefined, hourlyRate: 30 }))
    expect(vacationPayout(db, 'p-pt', '2026-09-30')).toMatchObject({ hours: 14.25, rate: 30, amount: 427.5 })
  })

  it('pays nothing under flexible vacation', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-a', 'Ana', '2026-01-05'))
    db.timeOffPolicies = [
      ...db.timeOffPolicies.filter((p) => p.id !== 'pol-vacation'),
      { id: 'pol-flex', name: 'Flexible vacation', kind: 'flexible_vacation', method: 'flexible', paidOutOnExit: false, appliesTo: 'all', description: '' },
    ]
    const p = vacationPayout(db, 'p-a', '2026-08-31')
    expect(p).toMatchObject({ hours: 0, amount: 0 })
    expect(p.note).toContain('Flexible vacation has no accrued balance')
  })
})

describe('calendar file', () => {
  it('writes an all-day event that says only "out"', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-e', 'Elena', '2025-08-18'))
    addRequest(db, 'tr-e', 'p-e', 'pol-vacation', '2026-10-12', '2026-10-16')
    const ics = timeOffICS(db, 'tr-e')
    expect(ics).toContain('SUMMARY:Elena Test: out')
    expect(ics).toContain('DTSTART;VALUE=DATE:20261012')
    expect(ics).toContain('DTEND;VALUE=DATE:20261017')
    expect(ics).not.toContain('Vacation')
    expect(timeOffICS(db, 'missing')).toBe('')
  })
})

describe('sick leave before the 90-day wait', () => {
  // Aisha started Sep 8, 2026: sick leave is usable from Dec 6 (the 90th day of employment).
  function aishaDB(): DB {
    const db = baseDB()
    db.people.push(mkPerson('p-aisha', 'Aisha', '2026-09-08'))
    return db
  }
  const early = { personId: 'p-aisha', policyId: 'pol-sick', startDate: '2026-10-12', endDate: '2026-10-12' }

  it('knows when a request falls before the wait', () => {
    const db = aishaDB()
    expect(serviceWait(db, early)).toEqual({ usableFrom: '2026-12-06', days: 90 })
    expect(serviceWait(db, { ...early, startDate: '2026-12-07' })).toBeNull()
    expect(serviceWait(db, { ...early, policyId: 'pol-vacation' })).toBeNull()
    const check = checkRequest(db, { ...early }, D)
    expect(check.wait).toMatchObject({ usableFrom: '2026-12-06', days: 90 })
    expect(check.warnings).toContain(check.wait?.text)
  })

  it('waits for Admin instead of approving itself, and takes nothing off the balance meanwhile', () => {
    const next = produce(aishaDB(), (d) => {
      createRequest(d, early, { date: D, id: 'tr-early', beforeWait: 'hold' })
    })
    expect(next.timeOffRequests[0]).toMatchObject({ status: 'pending', hours: 8 })
    expect(next.timeOffRequests[0].decisionNote).toBeUndefined()
    expect(pendingApprovals(next).map((r) => r.id)).toEqual(['tr-early'])
    expect(balances(next, 'p-aisha', '2026-12-07').find((r) => r.policy.id === 'pol-sick')).toMatchObject({ used: 0, available: 40 })
    // History recorded outside the request sheet keeps its approval (the sample's early sick day)
    const recorded = produce(aishaDB(), (d) => {
      createRequest(d, early, { date: D, id: 'tr-history' })
    })
    expect(recorded.timeOffRequests[0]).toMatchObject({ status: 'approved', decisionNote: 'Approved automatically' })
  })

  it('lets Admin waive the wait for one request, as paid sick leave with a note', () => {
    const recorded = produce(aishaDB(), (d) => {
      createRequest(d, early, { date: D, id: 'tr-waived', beforeWait: 'waive' })
    })
    expect(recorded.timeOffRequests[0]).toMatchObject({ status: 'approved', decidedOn: D, hours: 8, decisionNote: 'Approved: the 90-day wait was waived for this request' })
    expect(recorded.activity[0].text).toBe('Time off recorded for Aisha Test, Mon, Oct 12 (1 day), with the 90-day wait waived')
    // Approving a pending one later says the same
    const approved = produce(aishaDB(), (d) => {
      createRequest(d, early, { date: D, id: 'tr-early', beforeWait: 'hold' })
      approveRequest(d, 'tr-early', { date: D, approverId: 'p-founder' })
    })
    expect(approved.timeOffRequests[0]).toMatchObject({ status: 'approved', decisionNote: 'Approved: the 90-day wait was waived for this request' })
  })

  it('records it as unpaid leave instead: the unpaid policy when there is one, else no hours', () => {
    const unpaid = produce(aishaDB(), (d) => {
      createRequest(d, early, { date: D, id: 'tr-early', beforeWait: 'hold' })
      expect(approveAsUnpaid(d, 'tr-early', { date: D, approverId: 'p-founder' })).toBe(true)
      expect(approveAsUnpaid(d, 'tr-early', { date: D })).toBe(false)
    })
    expect(unpaid.timeOffRequests[0]).toMatchObject({
      status: 'approved',
      policyId: 'pol-unpaid',
      hours: 8,
      approverId: 'p-founder',
      decisionNote: 'Recorded as unpaid: before the 90-day wait ends on Dec 6, 2026',
      // The sick policy it was asked on, so pay run prep flags the day instead of docking an exempt salary.
      recordedUnpaidFrom: 'pol-sick',
    })
    expect(unpaid.activity.at(-1)?.text).toBe("Recorded Aisha Test's time off as unpaid, Mon, Oct 12")
    expect(balances(unpaid, 'p-aisha', '2026-12-07').find((r) => r.policy.id === 'pol-sick')?.used).toBe(0)

    const noPolicy = aishaDB()
    noPolicy.timeOffPolicies = noPolicy.timeOffPolicies.filter((p) => p.kind !== 'unpaid')
    expect(unpaidPolicyFor(noPolicy, noPolicy.people[1], D)).toBeUndefined()
    const kept = produce(noPolicy, (d) => {
      createRequest(d, early, { date: D, id: 'tr-early', beforeWait: 'hold' })
      approveAsUnpaid(d, 'tr-early', { date: D })
    })
    expect(kept.timeOffRequests[0]).toMatchObject({ status: 'approved', policyId: 'pol-sick', hours: 0 })
    expect(kept.timeOffRequests[0].recordedUnpaidFrom).toBeUndefined()
    expect(balances(kept, 'p-aisha', '2026-12-07').find((r) => r.policy.id === 'pol-sick')).toMatchObject({ used: 0, available: 40 })
  })
})
