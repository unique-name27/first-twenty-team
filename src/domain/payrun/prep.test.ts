// Pay run prep for one period: proration, pay changes, bonuses, time off, leaves and last days. Worked examples
// from the pay run prep research (docs/LAW.md w-salary-first-last-week, w-exempt-deductions-ca).
import { describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import type { CompRecord, DB, LeaveCase, Offer, Person, TimeOffRequest } from '@/domain/types'
import { periodContaining, periodStarting } from './calendar'
import {
  hireOffer,
  hoursText2,
  nextPayRunDue,
  payRunPrep,
  payRunStatus,
  peopleOnPayroll,
  periodChanges,
  requestDays,
  runForPeriod,
  salaryHourlyRate,
  unmarkedPayRuns,
  weekdayList,
} from './prep'

const D = '2026-10-12'

function mkPerson(id: string, over: Partial<Person> = {}): Person {
  return {
    id,
    firstName: id.slice(2, 3).toUpperCase() + id.slice(3),
    lastName: 'Test',
    workEmail: `${id.slice(2)}@testco.com`,
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
  return { id: `cr-${personId}-${effectiveOn}`, personId, effectiveOn, payType: 'salary', salary, title: 'Engineer', levelId: 'lv-l3', reason: 'hire', ...over }
}

function mkRequest(id: string, personId: string, policyId: string, startDate: string, endDate: string, hours: number, over: Partial<TimeOffRequest> = {}): TimeOffRequest {
  return { id, personId, policyId, startDate, endDate, hours, status: 'approved', requestedOn: '2026-09-01', ...over }
}

function baseDB(): DB {
  const db = blankDB({ companyName: 'Testco', founderFirstName: 'Maya', founderLastName: 'Raman', foundedOn: '2025-02-03' })
  db.comp.push(mkComp('p-founder', '2025-02-03', 150_000, { levelId: 'lv-x1', title: 'Founder and CEO', flsa: 'exempt' }))
  return db
}

function prepFor(db: DB, start: string, date = D) {
  const period = periodStarting(db, start)
  if (!period) throw new Error(`No period starts on ${start}`)
  return payRunPrep(db, period, date)
}

function row(db: DB, start: string, personId: string, date = D) {
  const r = prepFor(db, start, date).rows.find((x) => x.personId === personId)
  if (!r) throw new Error(`${personId} is not on the ${start} payroll`)
  return r
}

describe('who is on payroll', () => {
  it('lists everyone employed at any time in the period, in hire order', () => {
    const db = baseDB()
    db.people.push(
      mkPerson('p-ravi', { startDate: '2026-10-26', hireNumber: 4 }),
      mkPerson('p-gone', { startDate: '2025-06-01', endDate: '2026-09-30', hireNumber: 2 }),
      mkPerson('p-ben', { startDate: '2025-07-01', endDate: '2026-10-20', hireNumber: 3 }),
      mkPerson('p-later', { startDate: '2026-11-02', hireNumber: 5 }),
    )
    const period = { start: '2026-10-16', end: '2026-10-31' }
    expect(peopleOnPayroll(db, period).map((p) => p.id)).toEqual(['p-founder', 'p-ben', 'p-ravi'])
  })

  it('counts weekdays Monday to Friday with holidays included', () => {
    expect(weekdayList('2026-10-16', '2026-10-31')).toHaveLength(11)
    // Nov 16-30 has Thanksgiving and the day after: still 11 weekdays for a salary.
    expect(weekdayList('2026-11-16', '2026-11-30')).toHaveLength(11)
  })
})

describe('salary estimates (annual / 260 x weekdays on payroll, never more than the regular check)', () => {
  it('pays the regular check for a whole period: annual / 24', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-lena', { startDate: '2025-08-18' }))
    db.comp.push(mkComp('p-lena', '2025-08-18', 185_000))
    const r = row(db, '2026-10-16', 'p-lena')
    expect(r).toMatchObject({ regularAmount: 7708.33, salaryEstimate: 7708.33, estimatedGross: 7708.33, weekdays: 11, weekdaysOnPayroll: 11, deduction: 0 })
    expect(r.notes).toContain('Estimate only: the provider calculates taxes and net pay')
  })

  it('prorates a first check: Ravi, $245,000, starts Mon Oct 26 (5 of 11 weekdays)', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-ravi', { firstName: 'Ravi', lastName: 'Subramanian', startDate: '2026-10-26', hireNumber: 14 }))
    db.comp.push(mkComp('p-ravi', '2026-10-26', 245_000))
    const prep = prepFor(db, '2026-10-16')
    const r = prep.rows.find((x) => x.personId === 'p-ravi')
    expect(r).toMatchObject({ startInPeriod: '2026-10-26', weekdaysOnPayroll: 5, regularAmount: 10_208.33, salaryEstimate: 4711.54, estimatedGross: 4711.54 })
    expect(r?.notes).toContain('New hire: first check prorated, 5 of 11 weekdays')
    expect(prep.period.payday).toBe('2026-10-30')
    expect(periodChanges(prep).newHires.map((x) => x.personId)).toEqual(['p-ravi'])
  })

  it('never pays more than the regular check for a partial period', () => {
    const db = baseDB()
    // Starts Fri Oct 16, the first day: a full period. Starts Mon Oct 19: 10 x 245,000 / 260 = 9,423.08.
    db.people.push(mkPerson('p-a', { startDate: '2026-10-19' }))
    db.comp.push(mkComp('p-a', '2026-10-19', 245_000))
    expect(row(db, '2026-10-16', 'p-a').salaryEstimate).toBe(9423.08)
    // Last day Fri Oct 30: all 11 weekdays x $1,000 = $11,000 would beat the $10,833.33 check, so the check wins.
    db.people.push(mkPerson('p-b', { startDate: '2025-11-03', endDate: '2026-10-30', separation: { type: 'resigned_notice', reason: 'Moving', noticeGivenOn: '2026-10-01', lastDay: '2026-10-30' } }))
    db.comp.push(mkComp('p-b', '2025-11-03', 260_000))
    expect(row(db, '2026-10-16', 'p-b')).toMatchObject({ weekdaysOnPayroll: 11, salaryEstimate: 10_833.33 })
  })

  it('pays the regular check when every weekday of the period is on payroll, even with a start inside it', () => {
    const db = baseDB()
    // Nov 1-15 starts on a Sunday: a start on Mon Nov 2 misses no weekday, so 228,000 / 24 = 9,500, not 10 x 228,000 / 260.
    db.people.push(mkPerson('p-mei', { firstName: 'Mei', startDate: '2026-11-02', hireNumber: 17 }))
    db.comp.push(mkComp('p-mei', '2026-11-02', 228_000))
    const r = row(db, '2026-11-01', 'p-mei')
    expect(r).toMatchObject({ startInPeriod: '2026-11-02', weekdays: 10, weekdaysOnPayroll: 10, regularAmount: 9500, salaryEstimate: 9500 })
    expect(r.notes).toContain('New hire: first check, on payroll every weekday of the period')
    // Last day on the period's last weekday (Fri Nov 13; Nov 14-15 are a weekend): the regular check too.
    db.people.push(mkPerson('p-leo', { startDate: '2025-11-03', endDate: '2026-11-13', separation: { type: 'resigned_notice', reason: 'Moving', noticeGivenOn: '2026-10-01', lastDay: '2026-11-13' } }))
    db.comp.push(mkComp('p-leo', '2025-11-03', 228_000))
    const leo = row(db, '2026-11-01', 'p-leo')
    expect(leo.salaryEstimate).toBe(9500)
    expect(leo.notes).toContain('Last day Fri, Nov 13: on payroll every weekday of the period')
  })

  it('prorates a last check: Ben, $165,000, last day Fri Sep 18 (3 weekdays)', () => {
    const db = baseDB()
    db.people.push(
      mkPerson('p-ben', {
        firstName: 'Ben',
        lastName: 'Carter',
        startDate: '2025-03-03',
        endDate: '2026-09-18',
        separation: { type: 'resigned_notice', reason: 'New job', noticeGivenOn: '2026-09-04', lastDay: '2026-09-18' },
      }),
    )
    db.comp.push(mkComp('p-ben', '2025-03-03', 165_000))
    const r = row(db, '2026-09-16', 'p-ben', '2026-09-14')
    expect(r).toMatchObject({ endInPeriod: '2026-09-18', weekdaysOnPayroll: 3, salaryEstimate: 1903.85 })
    // 72+ hours' notice: due on the last day (Labor Code 202), before the Sep 30 payday.
    expect(r.finalPay).toMatchObject({ dueOn: '2026-09-18', rule: 'last_day', beforePayday: true })
    expect(r.flags.find((f) => f.kind === 'final_pay_off_cycle')?.text).toBe(
      'Final check due Fri, Sep 18 (Labor Code 202), before the Wed, Sep 30 payday: run an off-cycle (dismissal) payroll.',
    )
    expect(r.notes).toContain('Final check due Fri, Sep 18 (Labor Code 202): pay off-cycle')
  })

  it('splits the regular check by weekdays for a pay change: Kwame, $172,000 to $192,000 on Wed Oct 21', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-kwame', { startDate: '2025-05-12' }))
    db.comp.push(mkComp('p-kwame', '2025-05-12', 172_000), mkComp('p-kwame', '2026-10-21', 192_000, { reason: 'promotion' }))
    const prep = prepFor(db, '2026-10-16')
    const r = prep.rows.find((x) => x.personId === 'p-kwame')
    // 7,166.67 x 3/11 + 8,000 x 8/11
    expect(r).toMatchObject({ salaryEstimate: 7772.73, rate: 192_000, regularAmount: 8000 })
    expect(r?.payChanges).toEqual([{ effectiveOn: '2026-10-21', from: { payType: 'salary', salary: 172_000, hourlyRate: undefined }, to: { payType: 'salary', salary: 192_000, hourlyRate: undefined } }])
    expect(r?.notes).toContain('Pay change Wed, Oct 21: $172,000 to $192,000')
    expect(periodChanges(prep).payChanges).toHaveLength(1)
    // An unchanged rate (a title-only row) is not a pay change and leaves the check whole.
    db.comp.push(mkComp('p-kwame', '2026-11-04', 192_000, { reason: 'title_only', title: 'Senior engineer' }))
    expect(row(db, '2026-11-01', 'p-kwame')).toMatchObject({ salaryEstimate: 8000, payChanges: [] })
  })

  it('sums each weekday at its own rate for a partial period with a pay change, capped at the higher check', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-c', { startDate: '2026-10-19' }))
    db.comp.push(mkComp('p-c', '2026-10-19', 130_000), mkComp('p-c', '2026-10-26', 156_000))
    // 5 x 500 + 5 x 600 = 5,500 (the higher check is 6,500)
    expect(row(db, '2026-10-16', 'p-c').salaryEstimate).toBe(5500)
  })
})

describe('time off and unpaid days', () => {
  it('lists hours by payroll column and never names bereavement or reproductive loss', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-elena', { startDate: '2025-08-18' }))
    db.comp.push(mkComp('p-elena', '2025-08-18', 200_000))
    db.timeOffRequests.push(
      // Oct 12-16 crosses into the next period: Oct 12-15 here (32 hours).
      mkRequest('tr-1', 'p-elena', 'pol-vacation', '2026-10-12', '2026-10-16', 40),
      mkRequest('tr-2', 'p-elena', 'pol-sick', '2026-10-02', '2026-10-02', 8),
      mkRequest('tr-3', 'p-elena', 'pol-repro-loss', '2026-10-05', '2026-10-06', 16),
      mkRequest('tr-4', 'p-elena', 'pol-vacation', '2026-10-07', '2026-10-07', 8, { status: 'declined' }),
    )
    const r = row(db, '2026-10-01', 'p-elena')
    expect(r.timeOff).toEqual({ pto: 32, sick: 8, other: 16, unpaid: 0 })
    // Paid leave never changes an exempt salary.
    expect(r.salaryEstimate).toBe(8333.33)
    expect(r.notes.join(' ')).not.toMatch(/reproductive|bereave/i)
    expect(row(db, '2026-10-16', 'p-elena').timeOff.pto).toBe(8)
  })

  it('takes annual / 260 off an exempt salary for each unpaid personal day: Grace, $190,000', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-grace', { startDate: '2025-08-18' }))
    db.comp.push(mkComp('p-grace', '2025-08-18', 190_000))
    db.timeOffRequests.push(mkRequest('tr-u', 'p-grace', 'pol-unpaid', '2026-10-20', '2026-10-20', 8))
    const r = row(db, '2026-10-16', 'p-grace')
    expect(r).toMatchObject({ deduction: 730.77, unpaidDaysDeducted: 1, salaryEstimate: 7185.9 })
    expect(r.timeOff.unpaid).toBe(8)
    expect(r.notes).toContain('1 unpaid day taken off the salary')
  })

  it('never docks an exempt salary for part of a day or for sick time recorded as unpaid (flags them instead)', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-aisha', { startDate: '2026-09-08' }))
    db.comp.push(mkComp('p-aisha', '2026-09-08', 140_000))
    db.timeOffRequests.push(
      mkRequest('tr-half', 'p-aisha', 'pol-unpaid', '2026-10-20', '2026-10-20', 4, { partial: 'pm' }),
      // Before the 90-day wait: moved to the unpaid policy by Record as unpaid.
      mkRequest('tr-sick', 'p-aisha', 'pol-unpaid', '2026-10-22', '2026-10-22', 8, { recordedUnpaidFrom: 'pol-sick', decisionNote: 'Recorded as unpaid' }),
      // No unpaid policy: kept on sick leave with no hours.
      mkRequest('tr-sick2', 'p-aisha', 'pol-sick', '2026-10-23', '2026-10-23', 0),
    )
    const r = row(db, '2026-10-16', 'p-aisha')
    expect(r).toMatchObject({ deduction: 0, salaryEstimate: 5833.33 })
    expect(r.timeOff).toEqual({ pto: 0, sick: 0, other: 0, unpaid: 20 })
    expect(r.flags.map((f) => f.kind).sort()).toEqual(['partial_unpaid', 'unpaid_sick'])
    expect(r.flags.find((f) => f.kind === 'unpaid_sick')?.text).toContain('check before docking pay')
  })

  it('takes unpaid hours off a non-exempt salary at annual / 2080 and shows that hourly rate', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-ops', { startDate: '2026-01-05', flsa: 'non_exempt', exemptionBasis: undefined }))
    db.comp.push(mkComp('p-ops', '2026-01-05', 62_400, { flsa: 'non_exempt' }))
    db.timeOffRequests.push(mkRequest('tr-u', 'p-ops', 'pol-unpaid', '2026-10-20', '2026-10-20', 4, { partial: 'pm' }))
    const r = row(db, '2026-10-16', 'p-ops')
    // 62,400 / 2080 = $30 an hour; 4 unpaid hours = $120 off the $2,600 check.
    expect(r).toMatchObject({ hourlyEquivalent: 30, deduction: 120, salaryEstimate: 2480 })
    expect(r.notes).toContain('Overtime from the last period is due this payday (hours from time tracking)')
  })

  it('leaves hourly pay to time tracking and lists paid sick hours', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-luis', { startDate: '2026-07-20', hoursPerWeek: 24, employmentType: 'part_time', flsa: 'non_exempt', exemptionBasis: undefined }))
    db.comp.push(mkComp('p-luis', '2026-07-20', 0, { payType: 'hourly', salary: undefined, hourlyRate: 30, flsa: 'non_exempt' }))
    db.timeOffRequests.push(mkRequest('tr-s', 'p-luis', 'pol-sick', '2026-10-02', '2026-10-02', 4.8))
    const r = row(db, '2026-10-01', 'p-luis')
    expect(r).toMatchObject({ payType: 'hourly', rate: 30, rateBasis: 'hour', salaryEstimate: null, estimatedGross: null, regularAmount: 0 })
    expect(r.timeOff.sick).toBe(4.8)
    expect(r.notes).toContain('Hours from your time tracking')
    expect(r.flags).toEqual([])
  })

  it('flags requests still waiting for a decision', () => {
    const db = baseDB()
    db.timeOffRequests.push(mkRequest('tr-p', 'p-founder', 'pol-vacation', '2026-10-30', '2026-10-30', 8, { status: 'pending' }))
    const prep = prepFor(db, '2026-10-16')
    expect(prep.pendingTimeOff).toEqual([{ requestId: 'tr-p', personId: 'p-founder', name: 'Maya Raman', startDate: '2026-10-30', endDate: '2026-10-30' }])
    expect(prep.rows[0].flags.map((f) => f.kind)).toEqual(['pending_time_off'])
    expect(prep.rows[0].timeOff.pto).toBe(0)
  })
})

describe('leaves (dates only, assumed unpaid)', () => {
  function lenaDB(): DB {
    const db = baseDB()
    db.people.push(mkPerson('p-lena', { firstName: 'Lena', lastName: 'Park', startDate: '2025-08-18' }))
    db.comp.push(mkComp('p-lena', '2025-08-18', 185_000))
    const leave: LeaveCase = { id: 'lc-1', personId: 'p-lena', kind: 'bonding', requestedOn: '2026-10-01', startDate: '2026-11-02', expectedReturn: '2027-01-25' }
    db.leaveCases.push(leave)
    return db
  }

  it('estimates $0 for a period with no workday worked', () => {
    const r = row(lenaDB(), '2026-11-01', 'p-lena')
    expect(r).toMatchObject({ salaryEstimate: 0, estimatedGross: 0, leave: { from: '2026-11-02', to: '2026-11-15' } })
    expect(r.flags.map((f) => f.kind)).toEqual(['leave_all_period'])
    expect(r.notes).toContain('On leave Nov 2-15')
    expect(r.notes.join(' ')).not.toMatch(/bonding|CFRA|PDL/i)
  })

  it('estimates the weekdays worked after the return (Jan 25-29, 2027 = 5 weekdays) and flags it for review', () => {
    const r = row(lenaDB(), '2027-01-16', 'p-lena', '2027-01-20')
    expect(r).toMatchObject({ salaryEstimate: 3557.69, leave: { from: '2027-01-16', to: '2027-01-24' } })
    expect(r.flags.map((f) => f.kind)).toEqual(['leave_partial'])
  })

  it('counts days of paid time off during the leave as paid', () => {
    const db = lenaDB()
    db.timeOffRequests.push(mkRequest('tr-v', 'p-lena', 'pol-vacation', '2026-11-02', '2026-11-06', 40))
    const r = row(db, '2026-11-01', 'p-lena')
    // 5 vacation days x 185,000 / 260
    expect(r.salaryEstimate).toBe(3557.69)
    expect(r.timeOff.pto).toBe(40)
  })
})

describe('sign-on bonuses', () => {
  it('pays the accepted offer bonus with the first check only', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-ravi', { startDate: '2026-10-26', fromCandidateId: 'c-ravi', fromApplicationId: 'a-ravi' }))
    db.comp.push(mkComp('p-ravi', '2026-10-26', 245_000))
    const offer = { id: 'o-ravi', applicationId: 'a-ravi', candidateId: 'c-ravi', version: 2, status: 'accepted', signOnBonus: 10_000, personId: 'p-ravi', createdOn: '2026-10-01' } as Offer
    db.offers.push({ ...offer, id: 'o-ravi-1', version: 1, signOnBonus: 5_000, status: 'declined' }, offer)
    expect(hireOffer(db, db.people[1])?.id).toBe('o-ravi')
    const prep = prepFor(db, '2026-10-16')
    const r = prep.rows.find((x) => x.personId === 'p-ravi')
    expect(r).toMatchObject({ bonus: 10_000, estimatedGross: 14_711.54 })
    expect(r?.notes).toContain('Sign-on bonus from the offer, with the first check')
    expect(prep.totals.bonus).toBe(10_000)
    expect(periodChanges(prep).bonuses).toHaveLength(1)
    expect(row(db, '2026-11-01', 'p-ravi').bonus).toBe(0)
  })
})

describe('last days', () => {
  function leaverDB(over: Partial<Person> = {}): DB {
    const db = baseDB()
    db.people.push(
      mkPerson('p-omar', {
        startDate: '2026-05-04',
        endDate: '2026-10-02',
        separation: { type: 'terminated', reason: 'Performance', lastDay: '2026-10-02' },
        ...over,
      }),
    )
    db.comp.push(mkComp('p-omar', '2026-05-04', 188_000))
    return db
  }

  it('adds accrued vacation at the final rate when the policy pays it out (Labor Code 227.3)', () => {
    const r = row(leaverDB(), '2026-10-01', 'p-omar', '2026-10-01')
    expect(r.vacationPayout?.hours).toBeGreaterThan(0)
    expect(r.vacationPayout?.rate).toBe(90.38)
    // 2 weekdays (Oct 1-2) of salary plus the payout.
    expect(r.salaryEstimate).toBe(1446.15)
    expect(r.estimatedGross).toBe(Math.round((1446.15 + (r.vacationPayout?.amount ?? 0)) * 100) / 100)
    expect(r.finalPay).toMatchObject({ dueOn: '2026-10-02', rule: 'immediate', beforePayday: true })
  })

  it('pays nothing for flexible vacation', () => {
    const db = leaverDB()
    db.timeOffPolicies = db.timeOffPolicies.map((p) => (p.kind === 'vacation' ? { ...p, method: 'flexible' as const, annualHours: undefined, capHours: undefined, paidOutOnExit: false } : p))
    expect(row(db, '2026-10-01', 'p-omar', '2026-10-01').vacationPayout).toBeUndefined()
  })

  it('shows the waiting time penalty once final pay is late (Labor Code 203)', () => {
    const r = row(leaverDB(), '2026-10-01', 'p-omar', D)
    // Due Oct 2, 10 days late on Oct 12, at 188,000 / 260 = $723.08 a day.
    expect(r.finalPay?.exposure).toEqual({ daysLate: 10, amount: 7231 })
    // The penalty is an amount: the page shows it under the privacy blur.
    expect(r.flags.find((f) => f.kind === 'final_pay_late')).toMatchObject({ tone: 'bad', private: true })
  })

  it('leaves final pay already issued off-cycle out of the run', () => {
    const db = leaverDB({ separation: { type: 'terminated', reason: 'Performance', lastDay: '2026-10-02', finalPayIssuedOn: '2026-10-02' } })
    const prep = prepFor(db, '2026-10-01', D)
    const r = prep.rows.find((x) => x.personId === 'p-omar')
    expect(r).toMatchObject({ paidOffCycle: true, salaryEstimate: null, estimatedGross: null })
    expect(r?.flags.map((f) => f.kind)).toEqual(['final_pay_issued'])
    expect(prep.totals.vacationPayout).toBe(0)
  })

  it("leaves California's deadlines and payout rule to work in California, and flags another state's rules", () => {
    // Remote in Texas, terminated Fri Oct 2: no Labor Code 201 deadline, no 227.3 payout, no waiting time penalty.
    const db = leaverDB({ homeState: 'TX', workMode: 'remote' })
    const r = row(db, '2026-10-01', 'p-omar', D)
    expect(r.finalPay).toBeUndefined()
    expect(r.vacationPayout).toBeUndefined()
    expect(r.flags.map((f) => f.kind)).toEqual(['final_pay_other_state'])
    expect(r.flags[0]).toMatchObject({ tone: 'warn' })
    // No claim about another state's law (not researched): only where to confirm it.
    expect(r.flags[0].text).toBe("Works in TX: final pay and any vacation payout follow TX's rules, not California's. Confirm the deadline with your PEO.")
    expect(r.flags[0].text).not.toMatch(/always on time/)
    expect(r.notes).toContain('Last day Fri, Oct 2: final pay follows TX rules')
    // The 2 weekdays of salary still count: 188,000 / 260 x 2.
    expect(r.estimatedGross).toBe(1446.15)
    // Final pay already issued: left out of the run like anyone else's.
    const issued = leaverDB({ homeState: 'TX', separation: { type: 'terminated', reason: 'Performance', lastDay: '2026-10-02', finalPayIssuedOn: '2026-10-02' } })
    expect(row(issued, '2026-10-01', 'p-omar', D).flags.map((f) => f.kind)).toEqual(['final_pay_issued'])
  })

  it('asks for an offboarding when a last day has no separation', () => {
    const db = leaverDB({ separation: undefined })
    expect(row(db, '2026-10-01', 'p-omar').flags.map((f) => f.kind)).toContain('no_separation')
  })
})

describe('pay floors and period notices', () => {
  it('flags an hourly rate under the work location minimum wage and an exempt salary under the floor', () => {
    const db = baseDB()
    db.people.push(
      mkPerson('p-low', { flsa: 'non_exempt', exemptionBasis: undefined }),
      mkPerson('p-floor', { exemptionBasis: 'administrative' }),
    )
    db.comp.push(mkComp('p-low', '2026-01-05', 0, { payType: 'hourly', salary: undefined, hourlyRate: 17, flsa: 'non_exempt' }), mkComp('p-floor', '2026-01-05', 60_000))
    const prep = prepFor(db, '2026-10-16')
    expect(prep.rows.find((r) => r.personId === 'p-low')?.flags[0].text).toBe('$17.00 an hour is below the $18.45 minimum wage for San Jose HQ.')
    expect(prep.rows.find((r) => r.personId === 'p-floor')?.flags[0]).toMatchObject({ kind: 'exempt_floor', private: true })
    expect(prep.rows.find((r) => r.personId === 'p-low')?.flags[0].private).toBe(true)
  })

  it('says when monthly pay covers non-exempt staff and when a payday passes the Labor Code 204 date', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-luis', { flsa: 'non_exempt', exemptionBasis: undefined }))
    db.comp.push(mkComp('p-luis', '2026-01-05', 0, { payType: 'hourly', salary: undefined, hourlyRate: 30, flsa: 'non_exempt' }))
    db.company.paySchedule = 'monthly'
    expect(prepFor(db, '2026-10-01').notices[0]).toBe('Monthly pay is allowed only for exempt staff (Labor Code 204). Luis Test is non-exempt and needs at least two paydays a month.')
    db.company.paySchedule = 'semi_monthly'
    // The 10th of the next month, moved after: Sat Oct 10 -> Mon Oct 12 (Columbus Day) -> Tue Oct 13.
    db.company.payroll = { semiMonthlyPaydays: { first: 25, second: 10 }, paydayShift: 'after' }
    const late = prepFor(db, '2026-09-16')
    expect(late.period.payday).toBe('2026-10-13')
    expect(late.notices[0]).toMatch(/^Payday Tue, Oct 13 falls after Sat, Oct 10, the Labor Code 204 date/)
  })
})

describe('status and records', () => {
  it('reads submitted, open or not marked', () => {
    const period = { payday: '2026-10-15' }
    expect(payRunStatus(undefined, period, '2026-10-12')).toBe('open')
    expect(payRunStatus(undefined, period, '2026-10-16')).toBe('not_marked')
    expect(payRunStatus({ periodStart: '2026-10-01', periodEnd: '2026-10-15', payday: '2026-10-15', submittedOn: '2026-10-13' }, period, '2026-10-16')).toBe('submitted')
  })

  it('finds a period record only by the same start and end, never one that merely falls inside the period', () => {
    const runs = [
      { periodStart: '2026-09-23', periodEnd: '2026-10-07', payday: '2026-10-07' },
      { periodStart: '2026-10-16', periodEnd: '2026-10-31', payday: '2026-10-30' },
      { periodStart: '2026-11-01', periodEnd: '2026-11-30', payday: '2026-11-26' },
    ]
    expect(runForPeriod(runs, { start: '2026-10-16', end: '2026-10-31' })?.payday).toBe('2026-10-30')
    expect(runForPeriod(runs, { start: '2026-09-16', end: '2026-09-30' })).toBeUndefined()
    // Same start, other end (a monthly record against a semi-monthly period): not the same period.
    expect(runForPeriod(runs, { start: '2026-11-01', end: '2026-11-15' })).toBeUndefined()
    expect(runForPeriod(undefined, { start: '2026-11-01', end: '2026-11-15' })).toBeUndefined()
  })

  it('keeps the reminder for a new period after a schedule switch, though an old record falls inside it', () => {
    const db = baseDB()
    // Oct 1-15 was submitted on the semi-monthly schedule, then the company moved to every two weeks.
    db.company.payRuns = [{ periodStart: '2026-10-01', periodEnd: '2026-10-15', payday: '2026-10-15', submittedOn: '2026-10-13' }]
    db.company.paySchedule = 'biweekly'
    const containing = periodContaining(db, '2026-10-01')
    expect(containing.start < '2026-10-01' && containing.end >= '2026-10-01').toBe(true)
    expect(runForPeriod(db.company.payRuns, containing)).toBeUndefined()
    expect(payRunPrep(db, containing, '2026-10-05').status).toBe('open')
    // On Mon Oct 5 (the period before was paid Fri Oct 2) it is the next pay run due: the old mark does not hide it.
    expect(nextPayRunDue(db, '2026-10-05')?.start).toBe(containing.start)
  })

  it('lists paydays in the last 7 days that nobody marked submitted, with someone paid on them', () => {
    const db = baseDB()
    // Wed Sep 30 payday: asked through Wed Oct 7. Thu Oct 15 payday: from Fri Oct 16 through Thu Oct 22, then the
    // period list still says Not marked.
    expect(unmarkedPayRuns(db, '2026-10-07').map((p) => p.start)).toEqual(['2026-09-16'])
    expect(unmarkedPayRuns(db, '2026-10-15')).toEqual([])
    expect(unmarkedPayRuns(db, '2026-10-16').map((p) => p.start)).toEqual(['2026-10-01'])
    expect(unmarkedPayRuns(db, '2026-10-22').map((p) => p.start)).toEqual(['2026-10-01'])
    expect(unmarkedPayRuns(db, '2026-10-23')).toEqual([])
    db.company.payRuns = [{ periodStart: '2026-10-01', periodEnd: '2026-10-15', payday: '2026-10-15', submittedOn: '2026-10-13' }]
    expect(unmarkedPayRuns(db, '2026-10-16')).toEqual([])
    // An unpaid founder alone runs no payroll.
    db.comp = []
    expect(unmarkedPayRuns(db, '2026-10-01')).toEqual([])
  })

  it('totals the estimates', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-luis', { flsa: 'non_exempt', exemptionBasis: undefined }))
    db.comp.push(mkComp('p-luis', '2026-01-05', 0, { payType: 'hourly', salary: undefined, hourlyRate: 30, flsa: 'non_exempt' }))
    const prep = prepFor(db, '2026-10-16')
    expect(prep.totals).toEqual({ people: 2, estimatedGross: 6250, salaried: 1, hourly: 1, bonus: 0, vacationPayout: 0, otherPayout: 0, outside: [] })
    expect(prep.status).toBe('open')
  })

  it("keeps an hourly leaver's vacation payout out of the salaried total and lists it apart", () => {
    const db = baseDB()
    // Luis: $30 an hour, 24 hours a week, from Jul 20, last day Wed Sep 30 with notice: 14.25 vacation hours at exit.
    db.people.push(
      mkPerson('p-luis', {
        firstName: 'Luis',
        lastName: 'Ortega',
        startDate: '2026-07-20',
        hoursPerWeek: 24,
        employmentType: 'part_time',
        flsa: 'non_exempt',
        exemptionBasis: undefined,
        endDate: '2026-09-30',
        separation: { type: 'resigned_notice', reason: 'School', noticeGivenOn: '2026-09-01', lastDay: '2026-09-30' },
      }),
    )
    db.comp.push(mkComp('p-luis', '2026-07-20', 0, { payType: 'hourly', salary: undefined, hourlyRate: 30, flsa: 'non_exempt' }))
    const prep = prepFor(db, '2026-09-16', '2026-09-20')
    const luis = prep.rows.find((r) => r.personId === 'p-luis')
    expect(luis).toMatchObject({ estimatedGross: null, vacationPayout: { hours: 14.25, amount: 427.5, rate: 30 } })
    // The founder's check alone: 150,000 / 24.
    expect(prep.totals).toMatchObject({ estimatedGross: 6250, salaried: 1, hourly: 1, vacationPayout: 0 })
    expect(prep.totals.outside).toEqual([{ personId: 'p-luis', name: 'Luis Ortega', bonus: 0, vacationPayout: 427.5, otherPayout: 0 }])
    // Hours in the note match the export's two decimals (14.25, not 14.3).
    expect(luis?.notes).toContain('Vacation payout: 14.25 hours at the final rate (Labor Code 227.3)')
  })
})

describe('paydays in arrears and the final pay deadline (Labor Code 201, 202)', () => {
  // Paydays in arrears: the 1st to 15th on the 26th, the 16th to month end on the 10th of the next month. Kofi is
  // terminated with a last day of Wed Nov 4, so everything he earned is due that day.
  function kofiDB(sep: Partial<NonNullable<Person['separation']>> = {}): DB {
    const db = baseDB()
    db.company.payroll = { semiMonthlyPaydays: { first: 26, second: 10 } }
    db.people.push(
      mkPerson('p-kofi', {
        firstName: 'Kofi',
        lastName: 'Mensah',
        startDate: '2025-06-02',
        endDate: '2026-11-04',
        separation: { type: 'terminated', reason: 'Role eliminated', lastDay: '2026-11-04', ...sep },
      }),
    )
    db.comp.push(mkComp('p-kofi', '2025-06-02', 192_000))
    return db
  }

  it('flags the Oct 16-31 wages, paid Tue Nov 10, as part of the final check due Wed Nov 4', () => {
    const db = kofiDB()
    const prep = prepFor(db, '2026-10-16')
    expect(prep.period.payday).toBe('2026-11-10')
    const r = prep.rows.find((x) => x.personId === 'p-kofi')
    expect(r?.endInPeriod).toBeUndefined()
    expect(r?.salaryEstimate).toBe(8000)
    expect(r?.flags.find((f) => f.kind === 'final_pay_arrears')).toEqual({
      kind: 'final_pay_arrears',
      tone: 'bad',
      text: 'Last day Wed, Nov 4: these wages are part of the final check due Wed, Nov 4 (Labor Code 201). Pay them off-cycle, not on Tue, Nov 10.',
    })
    expect(r?.notes).toContain('Wages due with the final check by Wed, Nov 4 (Labor Code 201): pay off-cycle')
    // The Nov 1-15 row (payday Wed Nov 25, the business day before Thanksgiving) says to include them.
    const nov = row(db, '2026-11-01', 'p-kofi')
    expect(nov.flags.find((f) => f.kind === 'final_pay_off_cycle')?.text).toBe(
      'Final check due Wed, Nov 4 (Labor Code 201), before the Wed, Nov 25 payday: run an off-cycle (dismissal) payroll. Include the Oct 16-31 wages too: their payday, Tue, Nov 10, is after the deadline.',
    )
  })

  it('says nothing when the payday comes before the last day, and leaves out wages a final check already paid', () => {
    // Default paydays: Oct 16-31 is paid Fri Oct 30, before the last day.
    const plain = kofiDB()
    plain.company.payroll = {}
    const r = row(plain, '2026-10-16', 'p-kofi')
    expect(r.flags.map((f) => f.kind)).not.toContain('final_pay_arrears')
    expect(r.flags.find((f) => f.kind === 'final_pay_off_cycle')).toBeUndefined()
    // Final pay issued on the last day, before the Nov 10 payday: it paid the Oct 16-31 wages too.
    const issued = row(kofiDB({ finalPayIssuedOn: '2026-11-04' }), '2026-10-16', 'p-kofi', '2026-11-05')
    expect(issued).toMatchObject({ paidOffCycle: true, salaryEstimate: null, estimatedGross: null })
    expect(issued.flags.map((f) => f.kind)).toEqual(['final_pay_issued'])
  })
})

describe('non-exempt salaries per hour (Labor Code 515(d) is for full time)', () => {
  it('uses annual / 2080 at 40 hours a week and weekly salary / scheduled hours below that', () => {
    expect(salaryHourlyRate(62_400, 40)).toEqual({ rate: 30, basis: 'full_time' })
    expect(salaryHourlyRate(62_400, 45)).toEqual({ rate: 30, basis: 'full_time' })
    const pt = salaryHourlyRate(40_000, 20)
    expect(pt.basis).toBe('scheduled_hours')
    expect(Math.round(pt.rate * 100) / 100).toBe(38.46)
  })

  it('takes 4 unpaid hours off a $40,000, 20-hour salary at $38.46 an hour, not $19.23', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-pt', { startDate: '2026-01-05', hoursPerWeek: 20, employmentType: 'part_time', flsa: 'non_exempt', exemptionBasis: undefined }))
    db.comp.push(mkComp('p-pt', '2026-01-05', 40_000, { flsa: 'non_exempt' }))
    db.timeOffRequests.push(mkRequest('tr-u', 'p-pt', 'pol-unpaid', '2026-10-20', '2026-10-20', 4))
    const r = row(db, '2026-10-16', 'p-pt')
    // 40,000 / 52 / 20 = 38.4615 an hour; 4 hours = 153.85 off the 1,666.67 check.
    expect(r).toMatchObject({ hourlyEquivalent: 38.46, hourlyBasis: 'scheduled_hours', deduction: 153.85, salaryEstimate: 1512.82 })
    expect(r.notes).toContain("Hourly rate: weekly salary / 20 scheduled hours, a method for part time (Labor Code 515(d)'s annual / 2080 is for 40 hours)")
  })
})

describe('multi-day requests with a partial last day', () => {
  it('fills whole days first and puts the rest on the last day', () => {
    // Nov 2-4 with a pm partial, 20 hours: 8, 8 and 4.
    expect(requestDays({ startDate: '2026-11-02', endDate: '2026-11-04', hours: 20, partial: 'pm' }, [], 8)).toEqual([
      { date: '2026-11-02', hours: 8, fullDay: true },
      { date: '2026-11-03', hours: 8, fullDay: true },
      { date: '2026-11-04', hours: 4, fullDay: false },
    ])
    // Longer days than the schedule: spread evenly, every day full.
    expect(requestDays({ startDate: '2026-11-02', endDate: '2026-11-04', hours: 30 }, [], 8).map((d) => [d.hours, d.fullDay])).toEqual([
      [10, true],
      [10, true],
      [10, true],
    ])
    // Recorded with no hours (unpaid sick kept on its policy): a day each, the partial last day half of one.
    expect(requestDays({ startDate: '2026-11-02', endDate: '2026-11-03', hours: 0, partial: 'am' }, [], 8)).toEqual([
      { date: '2026-11-02', hours: 8, fullDay: true },
      { date: '2026-11-03', hours: 4, fullDay: false },
    ])
  })

  it('takes 2 full days off an exempt salary for Nov 2-4 with a pm partial: Grace, $190,000', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-grace', { startDate: '2025-08-18' }))
    db.comp.push(mkComp('p-grace', '2025-08-18', 190_000))
    db.timeOffRequests.push(mkRequest('tr-u', 'p-grace', 'pol-unpaid', '2026-11-02', '2026-11-04', 20, { partial: 'pm' }))
    const r = row(db, '2026-11-01', 'p-grace')
    // 2 x 190,000 / 260 = 1,461.54 off the 7,916.67 check; the half day is not deducted.
    expect(r).toMatchObject({ deduction: 1461.54, unpaidDaysDeducted: 2, salaryEstimate: 6455.13 })
    expect(r.timeOff.unpaid).toBe(20)
    expect(r.flags.map((f) => f.kind)).toEqual(['partial_unpaid'])
  })

  it('puts the hours of a request across a period boundary on the right side: Fri Oct 30 to Mon Nov 2 pm', () => {
    const db = baseDB()
    db.people.push(mkPerson('p-grace', { startDate: '2025-08-18' }))
    db.comp.push(mkComp('p-grace', '2025-08-18', 190_000))
    db.timeOffRequests.push(mkRequest('tr-u', 'p-grace', 'pol-unpaid', '2026-10-30', '2026-11-02', 12, { partial: 'pm' }))
    const oct = row(db, '2026-10-16', 'p-grace')
    expect(oct).toMatchObject({ unpaidDaysDeducted: 1, deduction: 730.77, salaryEstimate: 7185.9 })
    expect(oct.timeOff.unpaid).toBe(8)
    const nov = row(db, '2026-11-01', 'p-grace')
    expect(nov).toMatchObject({ unpaidDaysDeducted: 0, deduction: 0 })
    expect(nov.timeOff.unpaid).toBe(4)
    expect(nov.flags.map((f) => f.kind)).toEqual(['partial_unpaid'])
  })
})

describe('the next business day after a weekend or holiday (DLSE Manual 7.6.2)', () => {
  it('says the position does not reach a payday pushed past a bank holiday the company works', () => {
    const db = baseDB()
    // The 10th of the next month, moved after: Sat Oct 10, then Mon Oct 12 (Columbus Day, a bank holiday the company works).
    db.company.payroll = { semiMonthlyPaydays: { first: 25, second: 10 }, paydayShift: 'after' }
    const late = prepFor(db, '2026-09-16')
    expect(late.period.payday).toBe('2026-10-13')
    expect(late.notices).toEqual([
      "Payday Tue, Oct 13 falls after Sat, Oct 10, the Labor Code 204 date, because the scheduled day is not a business day. The Labor Commissioner's next-business-day position (DLSE Manual 7.6.2) reaches only Mon, Oct 12: a bank holiday you work, when direct deposits cannot settle, is not covered. Pay the business day before instead (Labor Code 219).",
    ])
  })

  it('says the position covers a payday moved past a weekend and the holidays the company observes', () => {
    const db = baseDB()
    // The 26th, moved after: Thu Nov 26 and Fri Nov 27 are company holidays, then the weekend: Mon Nov 30.
    db.company.payroll = { semiMonthlyPaydays: { first: 26, second: 0 }, paydayShift: 'after' }
    const nov = prepFor(db, '2026-11-01')
    expect(nov.period.payday).toBe('2026-11-30')
    expect(nov.notices).toEqual([
      "Payday Mon, Nov 30 falls after Thu, Nov 26, the Labor Code 204 date, because the scheduled day is not a business day. The Labor Commissioner's position allows the next business day after a Saturday, a Sunday or a holiday you observe (DLSE Manual 7.6.2); paying the business day before is always lawful (Labor Code 219).",
    ])
    // The default (business day before) pays on time: no notice.
    db.company.payroll = { semiMonthlyPaydays: { first: 26, second: 0 } }
    expect(prepFor(db, '2026-11-01').notices).toEqual([])
  })
})

describe('payouts at exit by policy kind', () => {
  function omarDB(): DB {
    const db = baseDB()
    db.people.push(mkPerson('p-omar', { startDate: '2026-05-04', endDate: '2026-10-02', separation: { type: 'terminated', reason: 'Performance', lastDay: '2026-10-02' } }))
    db.comp.push(mkComp('p-omar', '2026-05-04', 188_000))
    return db
  }

  it('lists a sick payout the policy makes under its own name, never as vacation', () => {
    const vacationOnly = row(omarDB(), '2026-10-01', 'p-omar', '2026-10-01').vacationPayout
    const db = omarDB()
    db.timeOffPolicies = db.timeOffPolicies.map((p) => (p.kind === 'sick' ? { ...p, paidOutOnExit: true } : p))
    const r = row(db, '2026-10-01', 'p-omar', '2026-10-01')
    expect(r.vacationPayout).toEqual(vacationOnly)
    expect(r.otherPayout).toMatchObject({ name: 'Sick leave', rate: 90.38 })
    const other = r.otherPayout?.hours ?? 0
    expect(other).toBeGreaterThan(0)
    expect(r.notes).toContain(`Sick leave payout: ${hoursText2(other)} hours at the final rate (your policy pays it out)`)
    expect(r.notes.filter((n) => n.startsWith('Vacation payout'))).toEqual([`Vacation payout: ${hoursText2(vacationOnly?.hours ?? 0)} hours at the final rate (Labor Code 227.3)`])
    // Both payouts are in the gross: 2 weekdays of salary (1,446.15) + vacation + sick.
    expect(r.estimatedGross).toBe(Math.round((1446.15 + (vacationOnly?.amount ?? 0) + (r.otherPayout?.amount ?? 0)) * 100) / 100)
  })

  it('pays accrued vacation out even when the policy says it is not paid out (Labor Code 227.3)', () => {
    const db = omarDB()
    db.timeOffPolicies = db.timeOffPolicies.map((p) => (p.kind === 'vacation' ? { ...p, paidOutOnExit: false } : p))
    const expected = row(omarDB(), '2026-10-01', 'p-omar', '2026-10-01').vacationPayout
    expect(expected?.hours).toBeGreaterThan(0)
    expect(row(db, '2026-10-01', 'p-omar', '2026-10-01').vacationPayout).toEqual(expected)
  })

  it('flags flexible vacation with a cap: owed at exit, but the app keeps no balance for it', () => {
    const db = omarDB()
    db.timeOffPolicies = db.timeOffPolicies.map((p) =>
      p.kind === 'vacation' ? { ...p, name: 'Flexible vacation', method: 'flexible' as const, annualHours: undefined, capHours: 160, paidOutOnExit: false } : p,
    )
    const r = row(db, '2026-10-01', 'p-omar', '2026-10-01')
    expect(r.vacationPayout).toBeUndefined()
    expect(r.flags.find((f) => f.kind === 'vacation_payout_check')).toEqual({
      kind: 'vacation_payout_check',
      tone: 'warn',
      text: 'Flexible vacation has a cap or a yearly allowance, so unused hours count as vacation and are paid at the final rate (Labor Code 227.3). The app keeps no balance for it: add the unused hours to the final check.',
    })
  })

  it('writes payout hours to two decimals in the notes, as the export does', () => {
    expect(hoursText2(22.25)).toBe('22.25')
    expect(hoursText2(57.454)).toBe('57.45')
    expect(hoursText2(16)).toBe('16')
  })
})

describe('leave with no pay rule (jury duty)', () => {
  it('lists it as unpaid for hourly and non-exempt staff, unnamed, and as other paid time for exempt staff', () => {
    const db = baseDB()
    db.people.push(
      mkPerson('p-luis', { firstName: 'Luis', startDate: '2026-07-20', hoursPerWeek: 24, employmentType: 'part_time', flsa: 'non_exempt', exemptionBasis: undefined }),
      mkPerson('p-elena', { firstName: 'Elena', startDate: '2025-08-18' }),
    )
    db.comp.push(mkComp('p-luis', '2026-07-20', 0, { payType: 'hourly', salary: undefined, hourlyRate: 30, flsa: 'non_exempt' }), mkComp('p-elena', '2025-08-18', 200_000))
    db.timeOffRequests.push(
      mkRequest('tr-j1', 'p-luis', 'pol-jury', '2026-10-20', '2026-10-20', 4.8),
      mkRequest('tr-b1', 'p-luis', 'pol-bereavement', '2026-10-22', '2026-10-22', 4.8),
      mkRequest('tr-v1', 'p-luis', 'pol-voting', '2026-10-23', '2026-10-23', 2),
      mkRequest('tr-j2', 'p-elena', 'pol-jury', '2026-10-20', '2026-10-20', 8),
    )
    const prep = prepFor(db, '2026-10-16')
    const luis = prep.rows.find((r) => r.personId === 'p-luis')
    // Voting time is paid time under its default policy; jury duty and bereavement have no pay rule in the app.
    expect(luis?.timeOff).toEqual({ pto: 0, sick: 0, other: 2, unpaid: 9.6 })
    const flag = luis?.flags.find((f) => f.kind === 'leave_no_pay_rule')
    expect(flag).toMatchObject({ tone: 'info' })
    expect(flag?.text).toBe('Leave with no pay rule in the law (jury duty, for one) is listed as unpaid hours. If your policy pays it, enter those hours as paid in your PEO.')
    expect(JSON.stringify(luis)).not.toMatch(/bereave|reproductive/i)
    // An exempt salary is not reduced for jury duty: other paid time, no deduction, no flag.
    const elena = prep.rows.find((r) => r.personId === 'p-elena')
    expect(elena?.timeOff).toEqual({ pto: 0, sick: 0, other: 8, unpaid: 0 })
    expect(elena).toMatchObject({ deduction: 0, salaryEstimate: 8333.33 })
    expect(elena?.flags).toEqual([])
  })
})

describe('pay that starts after the start date', () => {
  it("estimates an owner's pay from the first pay record, not as a full check: from Wed May 6, 8 of 11 weekdays", () => {
    const db = blankDB({ companyName: 'Testco', founderFirstName: 'Maya', founderLastName: 'Raman', foundedOn: '2026-02-02' })
    db.comp.push(mkComp('p-founder', '2026-05-06', 156_000, { levelId: 'lv-x1', title: 'Founder and CEO', flsa: 'exempt' }))
    const r = row(db, '2026-05-01', 'p-founder', '2026-05-04')
    // 8 x 156,000 / 260 = 4,800 (the regular check is 6,500).
    expect(r).toMatchObject({ weekdays: 11, weekdaysOnPayroll: 8, regularAmount: 6500, salaryEstimate: 4800, estimatedGross: 4800 })
    expect(r.notes).toContain('Pay starts Wed, May 6 (the first pay record): 8 of 11 weekdays')
    // No exempt floor check on a partial period, and the next period is a whole check.
    expect(r.flags).toEqual([])
    expect(row(db, '2026-05-16', 'p-founder').salaryEstimate).toBe(6500)
    // Before the first pay record there is nothing to estimate for the founder.
    expect(row(db, '2026-04-16', 'p-founder').flags.map((f) => f.kind)).toEqual(['no_pay'])
  })
})
