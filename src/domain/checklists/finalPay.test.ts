import { describe, expect, it } from 'vitest'
import { DEFAULT_TIME_OFF_POLICIES } from '@/data/defaults'
import {
  dailyRateFor,
  finalPayDeadline,
  gave72HoursNotice,
  payoutRules,
  policyCovers,
  vacationPaidAtExit,
  waitingTimeExposure,
  waitingTimePenaltyNote,
} from '@/domain/checklists/finalPay'
import type { TimeOffPolicy } from '@/domain/types'

const LAST = '2026-10-30' // Friday

describe('finalPayDeadline', () => {
  it('termination: at the termination meeting (Labor Code 201)', () => {
    const fp = finalPayDeadline('terminated', LAST)
    expect(fp).toMatchObject({ dueOn: LAST, rule: 'immediate', text: 'Final paycheck due at the termination meeting, Fri Oct 30' })
    expect(fp.citation.label).toBe('Labor Code 201')
  })

  it('layoff: same as termination', () => {
    expect(finalPayDeadline('laid_off', LAST)).toMatchObject({ dueOn: LAST, rule: 'immediate' })
  })

  it('end of a fixed-term job counts as a discharge', () => {
    const fp = finalPayDeadline('contract_ended', LAST)
    expect(fp).toMatchObject({ dueOn: LAST, rule: 'immediate' })
    expect(fp.detail).toMatch(/fixed-term/)
  })

  it('resignation with 72+ hours notice: the last day (Labor Code 202)', () => {
    const fp = finalPayDeadline('resigned_notice', LAST, '2026-10-16')
    expect(fp).toMatchObject({ dueOn: LAST, rule: 'last_day', text: 'Final paycheck due on the last day, Fri Oct 30' })
    expect(fp.citation.label).toBe('Labor Code 202')
    expect(finalPayDeadline('resigned_notice', LAST).dueOn).toBe(LAST)
    expect(finalPayDeadline('resigned_notice', LAST, '2026-10-27').rule).toBe('last_day')
  })

  it('resignation with under 72 hours notice: within 72 hours', () => {
    const fp = finalPayDeadline('resigned_notice', LAST, '2026-10-28')
    expect(fp).toMatchObject({ dueOn: '2026-11-02', rule: 'within_72_hours' })
    expect(fp.detail).toMatch(/less than 72 hours/)
  })

  it('resignation without notice: last day + 72 hours', () => {
    const fp = finalPayDeadline('resigned_no_notice', LAST)
    expect(fp).toMatchObject({ dueOn: '2026-11-02', rule: 'within_72_hours', text: 'Final paycheck due within 72 hours, by Mon Nov 2' })
  })

  it('uses plain punctuation', () => {
    for (const t of ['terminated', 'laid_off', 'contract_ended', 'resigned_notice', 'resigned_no_notice'] as const) {
      const fp = finalPayDeadline(t, LAST)
      expect(`${fp.text} ${fp.detail}`).not.toMatch(/—/)
    }
  })
})

describe('gave72HoursNotice', () => {
  it('needs at least 3 calendar days', () => {
    expect(gave72HoursNotice('2026-10-27', LAST)).toBe(true)
    expect(gave72HoursNotice('2026-10-28', LAST)).toBe(false)
  })
})

describe('waiting time penalty', () => {
  it('warns with the code section and the 30-day cap', () => {
    expect(waitingTimePenaltyNote()).toMatch(/Labor Code 203/)
    expect(waitingTimePenaltyNote()).toMatch(/30 days/)
  })

  it('counts calendar days late up to 30', () => {
    expect(waitingTimeExposure({ dailyRate: 700, dueOn: LAST, asOf: '2026-11-05' })).toEqual({ daysLate: 6, amount: 4200 })
    expect(waitingTimeExposure({ dailyRate: 700, dueOn: LAST, asOf: '2027-01-15' }).daysLate).toBe(30)
    expect(waitingTimeExposure({ dailyRate: 700, dueOn: LAST, asOf: '2027-01-15', paidOn: LAST })).toEqual({ daysLate: 0, amount: 0 })
  })

  it('estimates a daily rate', () => {
    expect(dailyRateFor({ payType: 'salary', salary: 260_000 })).toBe(1000)
    expect(dailyRateFor({ payType: 'hourly', hourlyRate: 30 }, 24)).toBe(144)
  })
})

describe('payoutRules', () => {
  it('pays vacation, never sick leave, and skips leave types without balances', () => {
    const rules = payoutRules(DEFAULT_TIME_OFF_POLICIES)
    expect(rules.find((r) => r.kind === 'vacation')).toMatchObject({ paidOut: true })
    expect(rules.find((r) => r.kind === 'sick')).toMatchObject({ paidOut: false })
    expect(rules.find((r) => r.kind === 'sick')?.text).toMatch(/Labor Code 246/)
    expect(rules.some((r) => r.kind === 'bereavement')).toBe(false)
  })

  it('pays nothing for truly unlimited flexible vacation', () => {
    const flex: TimeOffPolicy = {
      id: 'pol-flex',
      name: 'Flexible vacation',
      kind: 'flexible_vacation',
      method: 'flexible',
      paidOutOnExit: false,
      appliesTo: 'exempt',
      description: 'Take what you need.',
    }
    const [rule] = payoutRules([flex])
    expect(rule).toMatchObject({ paidOut: false })
    expect(rule.text).toMatch(/truly unlimited/)
  })

  it('pays accrued vacation even when the policy says no', () => {
    const bad: TimeOffPolicy = { ...DEFAULT_TIME_OFF_POLICIES[0], paidOutOnExit: false }
    const [rule] = payoutRules([bad])
    expect(rule.paidOut).toBe(true)
    expect(rule.text).toMatch(/California requires it/)
  })
})

describe('payoutRules for a person', () => {
  const flex: TimeOffPolicy = {
    id: 'pol-flex',
    name: 'Flexible vacation',
    kind: 'flexible_vacation',
    method: 'flexible',
    paidOutOnExit: false,
    appliesTo: 'exempt',
    description: 'Take what you need.',
  }
  const accruedHourly: TimeOffPolicy = { ...DEFAULT_TIME_OFF_POLICIES[0], appliesTo: 'non_exempt' }
  const exempt = { flsa: 'exempt' as const, employmentType: 'full_time' as const }
  const hourly = { flsa: 'non_exempt' as const, employmentType: 'part_time' as const }

  it('keeps only the policies that cover the person', () => {
    expect(policyCovers(accruedHourly, exempt)).toBe(false)
    expect(policyCovers(accruedHourly, hourly)).toBe(true)
    expect(policyCovers({ appliesTo: 'full_time' }, hourly)).toBe(false)
    expect(payoutRules([accruedHourly, flex], exempt).map((r) => r.policyId)).toEqual(['pol-flex'])
    expect(vacationPaidAtExit([accruedHourly, flex], exempt)).toBe(false)
    expect(vacationPaidAtExit([accruedHourly, flex], hourly)).toBe(true)
  })

  it('pays a flexible policy that has a cap or a yearly allowance', () => {
    const [rule] = payoutRules([{ ...flex, capHours: 160 }])
    expect(rule.paidOut).toBe(true)
    expect(rule.text).toMatch(/not truly unlimited/)
    expect(payoutRules([{ ...flex, annualHours: 120 }])[0].paidOut).toBe(true)
    expect(vacationPaidAtExit([{ ...flex, capHours: 160 }], exempt)).toBe(true)
  })

  it("writes 72 hours' notice with the apostrophe", () => {
    expect(finalPayDeadline('resigned_notice', LAST, '2026-10-16').detail).toMatch(/72 hours' notice/)
    expect(finalPayDeadline('resigned_no_notice', LAST).detail).toMatch(/72 hours' notice/)
    expect(finalPayDeadline('contract_ended', LAST).text).toBe('Final paycheck due on the last day, Fri Oct 30')
  })
})
