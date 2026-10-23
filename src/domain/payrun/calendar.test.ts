// Pay calendar: paydays off weekends and holidays (docs/LAW.md w-payday-holiday, w-bank-holidays) and the
// 'Run payroll by' cutoff. Test vectors from the pay run prep research (sample company holidays, 2026-2027).
import { describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import type { DB } from '@/domain/types'
import {
  businessDaysBefore,
  cutoffDaysProblem,
  cutoffWords,
  isCalendarPaydayText,
  latePayday,
  lawfulPaydayLimit,
  nextPayPeriod,
  payCalendar,
  payClosures,
  paydayWords,
  payrollProviderName,
  payrollSettings,
  payrollSettingsProblem,
  paydayShiftWords,
  periodContaining,
  periodLabel,
  periodLabelLong,
  periodsAround,
  periodStarting,
  providerPhrase,
  scheduledPayday,
  semiMonthlyPaydayChoices,
  semiMonthlyPaydaysProblem,
  shiftToBusinessDay,
} from './calendar'

function db(): DB {
  // The default company holidays include Nov 26-27, Dec 24-25 2026 and Jan 1, Jan 18, Feb 15 2027.
  return blankDB({ companyName: 'Testco', founderFirstName: 'Maya', founderLastName: 'Raman', foundedOn: '2025-02-03' })
}

describe('payrollSettings', () => {
  it('fills the defaults: 2 business days, the business day before, the 15th and the last day', () => {
    expect(payrollSettings(db().company)).toEqual({ cutoffBusinessDays: 2, paydayShift: 'before', semiMonthlyPaydays: { first: 15, second: 0 } })
  })

  it('keeps valid settings and drops ones out of range', () => {
    expect(payrollSettings({ payroll: { cutoffBusinessDays: 4, paydayShift: 'after', semiMonthlyPaydays: { first: 20, second: 5 } } })).toEqual({
      cutoffBusinessDays: 4,
      paydayShift: 'after',
      semiMonthlyPaydays: { first: 20, second: 5 },
    })
    expect(payrollSettings({ payroll: { cutoffBusinessDays: -1, semiMonthlyPaydays: { first: 27, second: 0 } } })).toMatchObject({
      cutoffBusinessDays: 2,
      semiMonthlyPaydays: { first: 15, second: 0 },
    })
    expect(payrollSettings({ payroll: { cutoffBusinessDays: 2.5 } }).cutoffBusinessDays).toBe(2)
    expect(payrollSettings({ payroll: { cutoffBusinessDays: 0 } }).cutoffBusinessDays).toBe(0)
  })

  it('checks semi-monthly paydays against the Labor Code 204 windows', () => {
    expect(semiMonthlyPaydaysProblem({ first: 15, second: 0 })).toBeNull()
    expect(semiMonthlyPaydaysProblem({ first: 26, second: 10 })).toBeNull()
    expect(semiMonthlyPaydaysProblem({ first: 27, second: 0 })).toContain('26th')
    expect(semiMonthlyPaydaysProblem({ first: 14, second: 0 })).toContain('26th')
    expect(semiMonthlyPaydaysProblem({ first: 20, second: 11 })).toContain('10th')
  })

  it('names the provider, ignoring the old placeholder', () => {
    const c = db().company
    expect(payrollProviderName(c)).toBe('')
    expect(providerPhrase(c)).toBe('your PEO')
    c.payrollProvider = { name: 'Your payroll or PEO provider', kind: 'Payroll', url: '' }
    expect(providerPhrase(c)).toBe('your payroll provider')
    c.payrollProvider.name = '  Gusto '
    expect(providerPhrase(c)).toBe('Gusto')
  })

  it("reads the sample's generic 'Your PEO' as no name, so sentences say 'your PEO'", () => {
    const c = db().company
    c.payrollProvider = { name: 'Your PEO', kind: 'PEO', url: 'https://example.com/peo' }
    expect(payrollProviderName(c)).toBe('')
    expect(providerPhrase(c)).toBe('your PEO')
    c.payrollProvider = { name: 'your payroll provider', kind: 'Payroll', url: '' }
    expect(providerPhrase(c)).toBe('your payroll provider')
    c.payrollProvider.name = 'Your PEO Partners'
    expect(providerPhrase(c)).toBe('Your PEO Partners')
  })

  it('checks the cutoff (0 to 10 business days) and the paydays before Settings saves them', () => {
    expect(cutoffDaysProblem(0)).toBeNull()
    expect(cutoffDaysProblem(10)).toBeNull()
    expect(cutoffDaysProblem(11)).toBe('Pick 0 to 10 business days: how long before payday your provider needs the payroll.')
    expect(cutoffDaysProblem(1.5)).not.toBeNull()
    expect(cutoffDaysProblem(null)).not.toBeNull()
    const ok = { cutoffBusinessDays: 2, paydayShift: 'before' as const, semiMonthlyPaydays: { first: 15, second: 0 } }
    expect(payrollSettingsProblem(ok, 'semi_monthly')).toBeNull()
    const late = { ...ok, semiMonthlyPaydays: { first: 27, second: 0 } }
    expect(payrollSettingsProblem(late, 'semi_monthly')).toContain('Labor Code 204 sets the 26th as the latest')
    // The semi-monthly days do not apply to another schedule.
    expect(payrollSettingsProblem(late, 'biweekly')).toBeNull()
    expect(payrollSettingsProblem({ ...ok, cutoffBusinessDays: -1 }, 'monthly')).toContain('Pick 0 to 10')
  })

  it('offers only semi-monthly paydays inside the Labor Code 204 windows', () => {
    const { first, second } = semiMonthlyPaydayChoices()
    expect(first.map((c) => c.value)).toEqual([15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26])
    expect(first[0].label).toBe('The 15th')
    expect(first[7].label).toBe('The 22nd')
    expect(second.map((c) => c.value)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(second[0].label).toBe('The last day of the month')
    expect(second[3].label).toBe('The 3rd of the next month')
    for (const f of first) for (const s of second) expect(semiMonthlyPaydaysProblem({ first: f.value, second: s.value })).toBeNull()
  })

  it('words the cutoff and the weekend move', () => {
    expect(cutoffWords(2)).toBe('2 business days before payday')
    expect(cutoffWords(1)).toBe('1 business day before payday')
    expect(cutoffWords(0)).toBe('on payday')
    expect(paydayShiftWords('before')).toBe('the business day before')
    expect(paydayShiftWords('after')).toBe('the next business day')
  })
})

describe('business days', () => {
  const closed = payClosures(db().holidays, '2026-10-01', '2027-01-31')

  it('skips weekends, bank holidays (Columbus Day, Veterans Day) and company holidays', () => {
    expect(closed.has('2026-10-12')).toBe(true) // Columbus Day: banks close, the company does not
    expect(closed.has('2026-11-11')).toBe(true)
    expect(closed.has('2026-11-27')).toBe(true) // the day after Thanksgiving: a company holiday only
    expect(shiftToBusinessDay('2026-10-31', 'before', closed)).toBe('2026-10-30')
    expect(shiftToBusinessDay('2026-10-31', 'after', closed)).toBe('2026-11-02')
    expect(shiftToBusinessDay('2026-11-15', 'before', closed)).toBe('2026-11-13')
    expect(shiftToBusinessDay('2026-11-15', 'after', closed)).toBe('2026-11-16')
    expect(shiftToBusinessDay('2026-10-15', 'before', closed)).toBe('2026-10-15')
  })

  it('counts the cutoff back in business days', () => {
    expect(businessDaysBefore('2026-11-30', 2, closed)).toBe('2026-11-24')
    expect(businessDaysBefore('2026-11-30', 0, closed)).toBe('2026-11-30')
    // Counting bank days only would give Wed Nov 25: the company holidays matter too.
    expect(businessDaysBefore('2026-11-30', 2, payClosures([], '2026-10-01', '2027-01-31'))).toBe('2026-11-25')
  })
})

describe('payCalendar (semi-monthly, 15th and last day, business day before, 2 business days)', () => {
  it('matches the research test vectors from Oct 2026 to Jan 2027', () => {
    const rows = payCalendar(db(), '2026-10-01', '2027-01-31').map((p) => [p.start, p.end, p.payday, p.cutoff])
    expect(rows).toEqual([
      // Mon Oct 12 is Columbus Day, but counting back from Thu reaches Tue first.
      ['2026-10-01', '2026-10-15', '2026-10-15', '2026-10-13'],
      // Sat Oct 31 moves to Fri Oct 30.
      ['2026-10-16', '2026-10-31', '2026-10-30', '2026-10-28'],
      // Sun Nov 15 moves to Fri Nov 13; Wed Nov 11 (Veterans Day) is skipped.
      ['2026-11-01', '2026-11-15', '2026-11-13', '2026-11-10'],
      // Nov 26-27 skipped.
      ['2026-11-16', '2026-11-30', '2026-11-30', '2026-11-24'],
      ['2026-12-01', '2026-12-15', '2026-12-15', '2026-12-11'],
      ['2026-12-16', '2026-12-31', '2026-12-31', '2026-12-29'],
      ['2027-01-01', '2027-01-15', '2027-01-15', '2027-01-13'],
      ['2027-01-16', '2027-01-31', '2027-01-29', '2027-01-27'],
    ])
    expect(payCalendar(db(), '2026-10-16', '2026-10-31')[0].scheduledPayday).toBe('2026-10-31')
  })

  it('moves to the next business day when the company picks that option', () => {
    const d = db()
    d.company.payroll = { paydayShift: 'after', cutoffBusinessDays: 3 }
    const [oct2, nov1] = payCalendar(d, '2026-10-16', '2026-11-15')
    expect(oct2).toMatchObject({ payday: '2026-11-02', cutoff: '2026-10-28' })
    expect(nov1).toMatchObject({ payday: '2026-11-16', cutoff: '2026-11-10' })
  })

  it('pays in arrears with custom semi-monthly paydays', () => {
    const d = db()
    d.company.payroll = { semiMonthlyPaydays: { first: 20, second: 5 } }
    const [first, second] = payCalendar(d, '2026-10-01', '2026-10-31')
    expect(first).toMatchObject({ scheduledPayday: '2026-10-20', payday: '2026-10-20' })
    // Thu Nov 5 for Oct 16-31.
    expect(second).toMatchObject({ scheduledPayday: '2026-11-05', payday: '2026-11-05', cutoff: '2026-11-03' })
    expect(lawfulPaydayLimit('semi_monthly', first)).toBe('2026-10-26')
    expect(lawfulPaydayLimit('semi_monthly', second)).toBe('2026-11-10')
    // In arrears, the period that just ended can still be the next payday.
    expect(nextPayPeriod(d, '2026-11-02')?.start).toBe('2026-10-16')
  })

  it('pays monthly on the 26th and every two weeks on the Friday after the period', () => {
    const d = db()
    d.company.paySchedule = 'monthly'
    const [dec] = payCalendar(d, '2026-12-01', '2026-12-31')
    // Sat Dec 26 moves back past Fri Dec 25 and Thu Dec 24 (company holidays) to Wed Dec 23.
    expect(dec).toMatchObject({ start: '2026-12-01', end: '2026-12-31', scheduledPayday: '2026-12-26', payday: '2026-12-23', cutoff: '2026-12-21' })
    expect(lawfulPaydayLimit('monthly', dec)).toBe('2026-12-26')
    d.company.paySchedule = 'biweekly'
    // Founded Mon Feb 3, 2025: two-week periods run Monday to Sunday, and Oct 12, 2026 starts one (44 x 14 days on).
    const [p] = payCalendar(d, '2026-10-12', '2026-10-12')
    expect(p).toMatchObject({ start: '2026-10-12', end: '2026-10-25', scheduledPayday: '2026-10-30', payday: '2026-10-30', cutoff: '2026-10-28' })
    expect(lawfulPaydayLimit('biweekly', p)).toBe('2026-11-01')
    expect(scheduledPayday('biweekly', { start: '2026-10-05', end: '2026-10-16' }, payrollSettings({}))).toBe('2026-10-23')
  })

  it('finds the period around a date and by its start', () => {
    const d = db()
    expect(periodContaining(d, '2026-10-12')).toMatchObject({ start: '2026-10-01', end: '2026-10-15' })
    expect(periodStarting(d, '2026-10-16')?.payday).toBe('2026-10-30')
    expect(periodStarting(d, '2026-10-17')).toBeUndefined()
    expect(periodsAround(d, '2026-10-12', 2, 3).map((p) => p.start)).toEqual(['2026-09-01', '2026-09-16', '2026-10-01', '2026-10-16', '2026-11-01', '2026-11-16'])
    expect(nextPayPeriod(d, '2026-10-16')?.start).toBe('2026-10-16')
  })
})

describe('words', () => {
  it('labels periods', () => {
    expect(periodLabel({ start: '2026-10-01', end: '2026-10-15' })).toBe('Oct 1-15')
    expect(periodLabel({ start: '2026-12-28', end: '2027-01-10' })).toBe('Dec 28 to Jan 10')
    expect(periodLabel({ start: '2026-10-30', end: '2026-10-30' })).toBe('Oct 30')
    expect(periodLabelLong({ start: '2026-10-16', end: '2026-10-31' })).toBe('Oct 16-31, 2026')
    expect(periodLabelLong({ start: '2026-12-28', end: '2027-01-10' })).toBe('Dec 28, 2026 to Jan 10, 2027')
  })

  it('writes the regular paydays for the wage notice (Labor Code 2810.5) and the payday notice (207)', () => {
    const c = db().company
    expect(paydayWords(c)).toBe('the 15th and the last day of each month, or the business day before when that is a weekend or holiday')
    c.payroll = { paydayShift: 'after', semiMonthlyPaydays: { first: 22, second: 3 } }
    expect(paydayWords(c)).toBe(
      'the 22nd of each month for work on the 1st to the 15th, and the 3rd of the next month for work from the 16th to month end, or the next business day when that is a weekend or holiday',
    )
    c.paySchedule = 'monthly'
    expect(paydayWords(c)).toMatch(/^the 26th of each month/)
    c.paySchedule = 'biweekly'
    expect(paydayWords(c)).toMatch(/^every other Friday/)
  })
})

describe('latePayday (a payday past its Labor Code 204 date)', () => {
  it('is null on or before the 204 date, as with the default business day before', () => {
    const d = db()
    for (const p of payCalendar(d, '2026-01-01', '2027-01-31')) expect(latePayday('semi_monthly', p, d.holidays), p.start).toBeNull()
  })

  it('reaches past weekends and observed holidays only, not past a bank holiday the company works', () => {
    const d = db()
    d.company.payroll = { semiMonthlyPaydays: { first: 26, second: 10 }, paydayShift: 'after' }
    const [sep16] = payCalendar(d, '2026-09-20', '2026-09-20')
    const [nov1] = payCalendar(d, '2026-11-05', '2026-11-05')
    // Sat Oct 10 -> Mon Oct 12 is Columbus Day (banks closed, the company open) -> Tue Oct 13: not covered.
    expect(sep16.payday).toBe('2026-10-13')
    expect(latePayday('semi_monthly', sep16, d.holidays)).toEqual({ limit: '2026-10-10', dlseDay: '2026-10-12', covered: false })
    // Thu Nov 26 and Fri Nov 27 are company holidays, then the weekend: Mon Nov 30 is covered.
    expect(nov1.payday).toBe('2026-11-30')
    expect(latePayday('semi_monthly', nov1, d.holidays)).toEqual({ limit: '2026-11-26', dlseDay: '2026-11-30', covered: true })
  })
})

describe('isCalendarPaydayText (a typed regular payday that only repeats the calendar)', () => {
  it("matches the calendar's words with or without the weekend clause, ignoring case and a final period", () => {
    const c = db().company
    expect(isCalendarPaydayText('the 15th and the last day of each month', c)).toBe(true)
    expect(isCalendarPaydayText('The 15th and the last day of each month.', c)).toBe(true)
    expect(isCalendarPaydayText(paydayWords(c), c)).toBe(true)
    expect(isCalendarPaydayText('the 10th and 25th of each month', c)).toBe(false)
    expect(isCalendarPaydayText('', c)).toBe(false)
    expect(isCalendarPaydayText(undefined, c)).toBe(false)
    // Under other paydays the old words no longer match.
    expect(isCalendarPaydayText('the 15th and the last day of each month', { ...c, payroll: { semiMonthlyPaydays: { first: 20, second: 5 } } })).toBe(false)
  })
})
