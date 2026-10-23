// Pay run records: Mark submitted (and the first payroll date it fills), provider totals, and taking either back.
import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import type { DB } from '@/domain/types'
import { paydayWords, payrollSettings, periodStarting } from './calendar'
import {
  clearPayRunTotals,
  dropStaleRegularPayday,
  isFirstPayroll,
  markPayRunSubmitted,
  paidBefore,
  runsWithTotals,
  setPayrollSettings,
  setPayRunTotals,
  totalsProblem,
  unmarkPayRunSubmitted,
} from './records'

function db(): DB {
  const d = blankDB({ companyName: 'Testco', founderFirstName: 'Maya', founderLastName: 'Raman', foundedOn: '2025-02-03' })
  d.company.payrollProvider = { name: 'Gusto', kind: 'Payroll', url: '' }
  return d
}

function period(d: DB, start: string) {
  const p = periodStarting(d, start)
  if (!p) throw new Error('no period')
  return p
}

describe('markPayRunSubmitted', () => {
  it('records the day and who, fills the first payroll date when it is empty, and logs without amounts', () => {
    const base = db()
    const oct = period(base, '2026-10-01')
    let result: ReturnType<typeof markPayRunSubmitted> | undefined
    const next = produce(base, (d) => {
      result = markPayRunSubmitted(d, oct, { date: '2026-10-13', actorId: 'p-founder' })
    })
    expect(result).toEqual({ ok: true, firstPayrollOn: '2026-10-15' })
    expect(next.company.payRuns).toEqual([{ periodStart: '2026-10-01', periodEnd: '2026-10-15', payday: '2026-10-15', submittedOn: '2026-10-13', submittedById: 'p-founder' }])
    expect(next.company.firstPayrollOn).toBe('2026-10-15')
    expect(next.activity.at(-1)).toMatchObject({ entityType: 'company', kind: 'payrun_submitted', text: 'Marked the Oct 1-15, 2026 payroll as submitted to Gusto' })

    // A second period keeps the first payroll date, and marking twice is refused.
    const later = produce(next, (d) => {
      expect(markPayRunSubmitted(d, period(d as DB, '2026-10-16'), { date: '2026-10-28' })).toEqual({ ok: true })
      expect(markPayRunSubmitted(d, oct, { date: '2026-10-28' })).toEqual({ ok: false, reason: 'This pay run is already marked submitted.' })
    })
    expect(later.company.firstPayrollOn).toBe('2026-10-15')
    expect(later.company.payRuns?.map((r) => r.periodStart)).toEqual(['2026-10-01', '2026-10-16'])
    expect(later.company.payRuns?.[1].submittedById).toBeNull()
  })

  it('never fills the first payroll date with a later payday when people were paid before the period', () => {
    // Paid staff since May 1, 2025 and no first payroll date: the EDD clock is estimated from that start. Marking Oct
    // 1-15, 2026 must not move it 17 months later.
    const base = db()
    base.people.push({ ...base.people[0], id: 'p-tomas', firstName: 'Tomas', hireNumber: 2, startDate: '2025-05-01' })
    base.comp.push({ id: 'cr-t', personId: 'p-tomas', effectiveOn: '2025-05-01', payType: 'salary', salary: 150_000, title: 'Engineer', levelId: 'lv-l3', reason: 'hire' })
    expect(paidBefore(base, '2026-10-01')).toBe(true)
    let result: ReturnType<typeof markPayRunSubmitted> | undefined
    const next = produce(base, (d) => {
      result = markPayRunSubmitted(d, period(d as DB, '2026-10-01'), { date: '2026-10-13' })
    })
    expect(result).toEqual({ ok: true, firstPayrollUnknown: true })
    expect(next.company.firstPayrollOn).toBeUndefined()
    expect(next.company.payRuns?.[0].submittedOn).toBe('2026-10-13')
  })

  it('never fills it when an earlier run is on record, even with nobody paid on record before (a sample with marked runs)', () => {
    const base = db()
    base.company.payRuns = [{ periodStart: '2026-07-01', periodEnd: '2026-07-15', payday: '2026-07-15', submittedOn: '2026-07-13' }]
    expect(isFirstPayroll(base, { start: '2026-10-01' })).toBe(false)
    const next = produce(base, (d) => {
      expect(markPayRunSubmitted(d, period(d as DB, '2026-10-01'), { date: '2026-10-13' })).toEqual({ ok: true, firstPayrollUnknown: true })
    })
    expect(next.company.firstPayrollOn).toBeUndefined()
  })

  it("fills it with the first paid period's payday: an owner whose salary starts Oct 5", () => {
    const base = db()
    base.comp.push({ id: 'cr-f', personId: 'p-founder', effectiveOn: '2026-10-05', payType: 'salary', salary: 120_000, title: 'Founder', levelId: 'lv-x1', reason: 'hire' })
    expect(paidBefore(base, '2026-10-01')).toBe(false)
    expect(paidBefore(base, '2026-10-16')).toBe(true)
    const next = produce(base, (d) => {
      expect(markPayRunSubmitted(d, period(d as DB, '2026-10-01'), { date: '2026-10-13' })).toEqual({ ok: true, firstPayrollOn: '2026-10-15' })
    })
    expect(next.company.firstPayrollOn).toBe('2026-10-15')
    // A date already set is never touched or reported again.
    const later = produce(next, (d) => {
      expect(markPayRunSubmitted(d, period(d as DB, '2026-10-16'), { date: '2026-10-28' })).toEqual({ ok: true })
    })
    expect(later.company.firstPayrollOn).toBe('2026-10-15')
  })

  it('keeps a record from another schedule that shares the start when a mark is taken back', () => {
    const base = db()
    // A monthly record for Oct 1-31 (from before a switch) and the semi-monthly Oct 1-15 mark.
    base.company.payRuns = [{ periodStart: '2026-10-01', periodEnd: '2026-10-31', payday: '2026-10-26', totals: { gross: 1, employerTaxes: 0, enteredOn: '2026-10-27' } }]
    const marked = produce(base, (d) => {
      expect(markPayRunSubmitted(d, period(d as DB, '2026-10-01'), { date: '2026-10-13' }).ok).toBe(true)
    })
    expect(marked.company.payRuns?.map((r) => `${r.periodStart} ${r.periodEnd} ${r.submittedOn ?? ''}`)).toEqual(['2026-10-01 2026-10-15 2026-10-13', '2026-10-01 2026-10-31 '])
    const back = produce(marked, (d) => {
      unmarkPayRunSubmitted(d, period(d as DB, '2026-10-01'))
    })
    expect(back.company.payRuns?.map((r) => r.periodEnd)).toEqual(['2026-10-31'])
  })

  it('takes the mark back, and drops the record when no totals are on it', () => {
    const base = produce(db(), (d) => {
      markPayRunSubmitted(d, period(d as DB, '2026-10-01'), { date: '2026-10-13' })
    })
    const back = produce(base, (d) => {
      expect(unmarkPayRunSubmitted(d, period(d as DB, '2026-10-01'))).toEqual({ ok: true })
      expect(unmarkPayRunSubmitted(d, period(d as DB, '2026-10-01'))).toEqual({ ok: false, reason: 'This pay run is not marked submitted.' })
    })
    expect(back.company.payRuns).toEqual([])
    expect(back.activity.at(-1)?.kind).toBe('payrun_unsubmitted')
  })
})

describe('provider totals', () => {
  it('checks the amounts', () => {
    expect(totalsProblem(0, 0)).toContain('gross pay')
    expect(totalsProblem(null, 10)).toContain('gross pay')
    expect(totalsProblem(10_000, -1)).toContain('employer taxes')
    expect(totalsProblem(10_000, undefined)).toContain('employer taxes')
    expect(totalsProblem(1_000, 2_000)).toContain('withholding')
    expect(totalsProblem(10_000, 0)).toBeNull()
  })

  it('saves gross and employer taxes for a period, replaces them, and keeps them when the mark is taken back', () => {
    const base = db()
    const sep = period(base, '2026-09-16')
    const saved = produce(base, (d) => {
      expect(setPayRunTotals(d, sep, { gross: 0, employerTaxes: 0 }, { date: '2026-10-02' }).ok).toBe(false)
      markPayRunSubmitted(d, sep, { date: '2026-09-28' })
      expect(setPayRunTotals(d, sep, { gross: 41_250.5, employerTaxes: 3_100.123 }, { date: '2026-10-02' })).toEqual({ ok: true })
      setPayRunTotals(d, sep, { gross: 41_300, employerTaxes: 3_105 }, { date: '2026-10-03' })
    })
    expect(saved.company.payRuns?.[0].totals).toEqual({ gross: 41_300, employerTaxes: 3_105, enteredOn: '2026-10-03' })
    expect(saved.activity.at(-1)?.text).toBe("Entered Gusto's totals for the Sep 16-30, 2026 payroll")
    expect(saved.activity.map((a) => a.text).join(' ')).not.toMatch(/\$|41,|3,1/)
    const unmarked = produce(saved, (d) => {
      unmarkPayRunSubmitted(d, sep)
    })
    expect(unmarked.company.payRuns?.[0]).toMatchObject({ totals: { gross: 41_300 } })
    expect(unmarked.company.payRuns?.[0].submittedOn).toBeUndefined()
    expect(runsWithTotals(unmarked).map((r) => r.periodStart)).toEqual(['2026-09-16'])
    // Clearing the totals of a record with no mark removes it.
    const cleared = produce(unmarked, (d) => {
      expect(clearPayRunTotals(d, sep)).toEqual({ ok: true })
      expect(clearPayRunTotals(d, sep).ok).toBe(false)
    })
    expect(cleared.company.payRuns).toEqual([])
  })

  it('records totals for a period never marked submitted (a past payroll), newest first', () => {
    const base = db()
    const next = produce(base, (d) => {
      setPayRunTotals(d, period(d as DB, '2026-09-01'), { gross: 40_000, employerTaxes: 3_000 }, { date: '2026-10-02' })
      setPayRunTotals(d, period(d as DB, '2026-09-16'), { gross: 41_000, employerTaxes: 3_050 }, { date: '2026-10-02' })
    })
    expect(next.company.firstPayrollOn).toBeUndefined()
    expect(runsWithTotals(next).map((r) => r.payday)).toEqual(['2026-09-30', '2026-09-15'])
  })
})

describe('setPayrollSettings (Settings > Link-outs)', () => {
  it('saves the cutoff, the weekend move and the semi-monthly paydays, keeping the ADP settings', () => {
    const base = db()
    base.company.payroll = { adp: { companyCode: 'ABC' } }
    let changed = false
    const next = produce(base, (d) => {
      changed = setPayrollSettings(d, { cutoffBusinessDays: 4, paydayShift: 'after', semiMonthlyPaydays: { first: 20, second: 5 } })
    })
    expect(changed).toBe(true)
    expect(next.company.payroll).toEqual({ adp: { companyCode: 'ABC' }, cutoffBusinessDays: 4, paydayShift: 'after', semiMonthlyPaydays: { first: 20, second: 5 } })
    expect(payrollSettings(next.company)).toEqual({ cutoffBusinessDays: 4, paydayShift: 'after', semiMonthlyPaydays: { first: 20, second: 5 } })
  })

  it("clears a 'Regular payday' that only repeated the old paydays, so the wage notice follows the calendar", () => {
    const base = db()
    base.company.regularPayday = 'the 15th and the last day of each month'
    const next = produce(base, (d) => {
      setPayrollSettings(d, { cutoffBusinessDays: 2, paydayShift: 'before', semiMonthlyPaydays: { first: 26, second: 10 } })
    })
    expect(next.company.regularPayday).toBeUndefined()
    expect(paydayWords(next.company)).toBe(
      'the 26th of each month for work on the 1st to the 15th, and the 10th of the next month for work from the 16th to month end, or the business day before when that is a weekend or holiday',
    )
    // Words of the admin's own stay.
    const own = produce({ ...base, company: { ...base.company, regularPayday: 'Every other Friday by direct deposit' } }, (d) => {
      setPayrollSettings(d, { cutoffBusinessDays: 2, paydayShift: 'before', semiMonthlyPaydays: { first: 26, second: 10 } })
    })
    expect(own.company.regularPayday).toBe('Every other Friday by direct deposit')
  })

  it('clears stale payday words after a pay schedule change too, and leaves words that still match', () => {
    const base = db()
    base.company.regularPayday = 'The 15th and the last day of each month, or the business day before when that is a weekend or holiday.'
    const switched = produce(base, (d) => {
      const before = { paySchedule: d.company.paySchedule, payroll: d.company.payroll }
      d.company.paySchedule = 'biweekly'
      expect(dropStaleRegularPayday(d, before)).toBe(true)
    })
    expect(switched.company.regularPayday).toBeUndefined()
    const same = produce(base, (d) => {
      expect(dropStaleRegularPayday(d, { paySchedule: 'semi_monthly', payroll: d.company.payroll })).toBe(false)
    })
    expect(same).toBe(base)
  })

  it('writes nothing when the settings already read that way (the defaults on a new company)', () => {
    const base = db()
    let changed = true
    const next = produce(base, (d) => {
      changed = setPayrollSettings(d, payrollSettings(d.company))
    })
    expect(changed).toBe(false)
    expect(next).toBe(base)
  })
})
