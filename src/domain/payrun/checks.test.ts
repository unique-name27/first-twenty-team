// Checks before the pay schedule or the pay run settings are saved: monthly pay only with everyone exempt (Labor Code
// 204), the 2810.5 notice of new paydays, and paydays the settings would put past their 204 date.
import { describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import type { DB, Person } from '@/domain/types'
import { defaultPayrollSettings } from './calendar'
import { latePaydaysText, latePaydaysWith, monthlyScheduleProblem, nonExemptStaff, paydayChangeNotice } from './checks'

const D = '2026-10-12'

function db(): DB {
  return blankDB({ companyName: 'Testco', founderFirstName: 'Maya', founderLastName: 'Raman', foundedOn: '2025-02-03' })
}

function addPerson(d: DB, id: string, over: Partial<Person>): void {
  d.people.push({ ...d.people[0], id, firstName: id.slice(2, 3).toUpperCase() + id.slice(3), lastName: 'Test', hireNumber: d.people.length + 1, ...over })
}

describe('monthlyScheduleProblem', () => {
  it('blocks monthly pay while anyone non-exempt is employed or starting, naming them', () => {
    const d = db()
    expect(monthlyScheduleProblem(d, D)).toBeNull()
    addPerson(d, 'p-luis', { flsa: 'non_exempt', startDate: '2026-07-20' })
    expect(monthlyScheduleProblem(d, D)).toBe(
      'Monthly pay is allowed only when everyone on it is exempt (Labor Code 204). Luis Test is non-exempt and needs at least two paydays a month: keep a semi-monthly or two-week schedule.',
    )
    // Someone starting later counts; someone who already left does not.
    addPerson(d, 'p-ana', { flsa: 'non_exempt', startDate: '2026-11-02' })
    addPerson(d, 'p-old', { flsa: 'non_exempt', startDate: '2025-06-01', endDate: '2026-03-31' })
    expect(nonExemptStaff(d, D).map((p) => p.id)).toEqual(['p-luis', 'p-ana'])
    expect(monthlyScheduleProblem(d, D)).toContain('Luis Test and Ana Test are non-exempt and need at least two paydays a month')
  })
})

describe('paydayChangeNotice', () => {
  it('reminds of the 7-day written notice to non-exempt staff (Labor Code 2810.5), and says nothing without them', () => {
    const d = db()
    expect(paydayChangeNotice(d, D)).toBeNull()
    addPerson(d, 'p-luis', { flsa: 'non_exempt', startDate: '2026-07-20' })
    expect(paydayChangeNotice(d, D)).toBe('Changing paydays? Luis Test is non-exempt: give written notice of the new paydays within 7 days (Labor Code 2810.5).')
  })
})

describe('latePaydaysWith (before Settings saves the pay run settings)', () => {
  it('finds none with the defaults', () => {
    expect(latePaydaysWith(db(), defaultPayrollSettings(), 'semi_monthly', D)).toEqual([])
  })

  it('lists the paydays the 26th, the 10th and Next business day would put past the 204 date, and which are covered', () => {
    const d = db()
    const late = latePaydaysWith(d, { cutoffBusinessDays: 2, paydayShift: 'after', semiMonthlyPaydays: { first: 26, second: 10 } }, 'semi_monthly', D)
    expect(late.slice(0, 3).map((l) => [l.start, l.payday, l.limit, l.covered])).toEqual([
      // Thu Nov 26 (Thanksgiving, then a company holiday and the weekend): Mon Nov 30.
      ['2026-11-01', '2026-11-30', '2026-11-26', true],
      // Sat Dec 26: Mon Dec 28.
      ['2026-12-01', '2026-12-28', '2026-12-26', true],
      // Sun Jan 10: Mon Jan 11.
      ['2026-12-16', '2027-01-11', '2027-01-10', true],
    ])
    // Business day before puts every one of them on or before the 204 date.
    expect(latePaydaysWith(d, { cutoffBusinessDays: 2, paydayShift: 'before', semiMonthlyPaydays: { first: 26, second: 10 } }, 'semi_monthly', D)).toEqual([])
  })

  it('says it in the form before saving: up to four paydays, the ones the position does not cover, and the fix', () => {
    const d = db()
    expect(latePaydaysText([], D)).toBeNull()
    const late = latePaydaysWith(d, { cutoffBusinessDays: 2, paydayShift: 'after', semiMonthlyPaydays: { first: 26, second: 10 } }, 'semi_monthly', D)
    const words = latePaydaysText(late, D)
    expect(words?.title).toBe(`${late.length} paydays in the next year would fall after the Labor Code 204 date`)
    expect(words?.text).toMatch(/^Mon, Nov 30 \(for Thu, Nov 26\); Mon, Dec 28 \(for Sat, Dec 26\); Mon, Jan 11, 2027 \(for Sun, Jan 10, 2027\); /)
    expect(words?.text).toContain(`; and ${late.length - 4} more.`)
    // Columbus Day 2027 pushes one past the position; the year is said for dates outside this year.
    expect(words?.text).toContain("Tue, Oct 12, 2027 is pushed past a bank holiday you work, which the Labor Commissioner's next-business-day position does not cover.")
    expect(words?.text.endsWith('Choose Business day before, or an earlier payday, to pay on or before the 204 date.')).toBe(true)
  })

  it('marks a payday pushed past a bank holiday the company works as not covered (Columbus Day 2027)', () => {
    const d = db()
    // Sun Oct 10, 2027, then Mon Oct 11 (Columbus Day): Tue Oct 12.
    const late = latePaydaysWith(d, { cutoffBusinessDays: 2, paydayShift: 'after', semiMonthlyPaydays: { first: 15, second: 10 } }, 'semi_monthly', D, 13)
    expect(late.find((l) => l.start === '2027-09-16')).toMatchObject({ payday: '2027-10-12', limit: '2027-10-10', dlseDay: '2027-10-11', covered: false })
  })
})
