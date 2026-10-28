// Moving a generated company by whole weeks (npm run sim reset): the story moves, weekdays keep their names,
// law values and the holiday list stay put, pay runs are marked again for the calendar's periods, and the
// company still passes every integrity check.
import { describe, expect, it } from 'vitest'
import { integrityProblems } from '@/domain/integrity'
import { payCalendar } from '@/domain/payrun/calendar'
import { addDays, pacificDateOf, parseDate } from '@/lib/dates'
import { generateCompany } from './generate'
import { SCENARIOS } from './scenarios'
import { KEPT_ON_THEIR_DATES, shiftCompany } from './shift'

const edge = generateCompany({ scenario: 'payroll-edge' })
const asOf = SCENARIOS['payroll-edge'].asOf
const weekday = (d: string) => parseDate(d.slice(0, 10)).getDay()

describe('shiftCompany', () => {
  for (const days of [14, -7, 70]) {
    it(`moves payroll-edge ${days} days and it stays valid`, () => {
      const moved = shiftCompany(edge.db, days, asOf)
      expect(integrityProblems(moved)).toEqual([])

      // The story moved, on the same weekdays and the same Pacific time of day.
      expect(moved.people.map((p) => p.startDate)).toEqual(edge.db.people.map((p) => addDays(p.startDate, days)))
      expect(moved.company.foundedOn).toBe(addDays(edge.db.company.foundedOn, days))
      expect(moved.meta.createdOn).toBe(addDays(edge.db.meta.createdOn, days))
      moved.interviews.forEach((iv, i) => {
        const before = edge.db.interviews[i].startsAt
        expect(pacificDateOf(iv.startsAt)).toBe(addDays(pacificDateOf(before), days))
        expect(weekday(pacificDateOf(iv.startsAt))).toBe(weekday(pacificDateOf(before)))
      })
      expect(moved.leaveCases.map((c) => c.startDate)).toEqual(edge.db.leaveCases.map((c) => addDays(c.startDate, days)))

      // Law values, holidays, time off policies and checklist templates stay on their own dates.
      expect(moved.settings).toEqual(edge.db.settings)
      expect(moved.holidays).toEqual(edge.db.holidays)
      expect(moved.timeOffPolicies).toEqual(edge.db.timeOffPolicies)
      expect(moved.checklistTemplates).toEqual(edge.db.checklistTemplates)
      expect(KEPT_ON_THEIR_DATES).toContain('payRuns')

      // Pay runs: every period of the calendar from the founding date to the moved as-of date, submitted on its cutoff.
      const movedAsOf = addDays(asOf, days)
      const periods = payCalendar(moved, moved.company.foundedOn, movedAsOf).filter((p) => p.cutoff >= moved.company.foundedOn && p.cutoff <= movedAsOf)
      expect(periods.length).toBeGreaterThan(3)
      expect(moved.company.payRuns).toEqual(
        periods.map((p) => ({ periodStart: p.start, periodEnd: p.end, payday: p.payday, submittedOn: p.cutoff, submittedById: edge.db.company.payRuns![0].submittedById })),
      )
      expect(moved.company.firstPayrollOn).toBe(periods[0].payday)
    })
  }

  it('changes nothing for zero days, and refuses part of a week', () => {
    expect(shiftCompany(edge.db, 0, asOf)).toBe(edge.db)
    for (const days of [3, 7.5, Number.NaN]) expect(() => shiftCompany(edge.db, days, asOf)).toThrow(/whole weeks/)
  })

  it('refuses a company whose pay runs came from people (totals entered)', () => {
    const runs = edge.db.company.payRuns!
    const withTotals = { ...edge.db, company: { ...edge.db.company, payRuns: [{ ...runs[0], totals: { gross: 1000, employerTaxes: 80, enteredOn: runs[0].payday } }, ...runs.slice(1)] } }
    expect(() => shiftCompany(withTotals, 7, asOf)).toThrow(/cannot be moved/)
  })

  it('moves a company with no pay runs', () => {
    const blank = generateCompany({ scenario: 'blank' })
    const moved = shiftCompany(blank.db, 21, SCENARIOS.blank.asOf)
    expect(moved.company.foundedOn).toBe(addDays(blank.db.company.foundedOn, 21))
    expect(moved.company.payRuns ?? []).toEqual([])
    expect(integrityProblems(moved)).toEqual([])
  })
})
