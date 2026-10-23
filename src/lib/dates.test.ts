// Date formatting never throws on a value that is not a real date, and date fields pass on only real ones.
import { afterEach, describe, expect, it } from 'vitest'
import {
  bankHolidays,
  federalHolidays,
  fmtDate,
  fmtDateTime,
  fmtDay,
  fmtDayAnyYear,
  fmtMonth,
  fmtRelative,
  fmtShort,
  fmtTime,
  isUsableDate,
  setClockOverride,
} from './dates'

afterEach(() => setClockOverride(null))

describe('formatters with a date that is not real (r2-35: a 6-digit year crashed the page)', () => {
  it('return an empty string instead of throwing', () => {
    for (const bad of ['20266-03-16', '2026-13-45T10:00:00Z', 'not a date', '2026-ab-cd']) {
      expect(fmtDate(bad)).toBe('')
      expect(fmtShort(bad)).toBe('')
      expect(fmtDay(bad)).toBe('')
      expect(fmtDayAnyYear(bad, '2026-10-11')).toBe('')
      expect(fmtDateTime(bad)).toBe('')
      expect(fmtTime(bad)).toBe('')
      expect(fmtMonth(bad)).toBe('')
      expect(fmtRelative(bad)).toBe('')
    }
  })

  it('still format real dates as before', () => {
    setClockOverride('2026-10-09')
    expect(fmtDate('2026-10-09')).toBe('Oct 9, 2026')
    expect(fmtShort('2026-10-09')).toBe('Oct 9')
    expect(fmtDay('2026-10-09')).toBe('Fri, Oct 9')
    expect(fmtMonth('2026-10-09')).toBe('Oct 2026')
    expect(fmtRelative('2026-10-10')).toBe('tomorrow')
    expect(fmtRelative('2026-12-25')).toBe('Dec 25, 2026')
    expect(fmtDateTime('2026-10-09T17:30:00.000Z')).toMatch(/^\w{3}, Oct \d{1,2}, \d{1,2}:30 (AM|PM)$/)
    expect(fmtTime('2026-10-09T17:30:00.000Z')).toMatch(/^\d{1,2}:30 (AM|PM)$/)
  })
})

describe('isUsableDate (what a date field passes on)', () => {
  it('takes a real date with a 4-digit year from 1900 to 2100', () => {
    expect(isUsableDate('2026-03-16')).toBe(true)
    expect(isUsableDate('1900-01-01')).toBe(true)
    expect(isUsableDate('2100-12-31')).toBe(true)
  })

  it('refuses longer or shorter years, years still being typed, and days that do not exist', () => {
    expect(isUsableDate('20266-03-16')).toBe(false)
    expect(isUsableDate('202-03-16')).toBe(false)
    expect(isUsableDate('0002-03-16')).toBe(false)
    expect(isUsableDate('2101-01-01')).toBe(false)
    expect(isUsableDate('2026-02-31')).toBe(false)
    expect(isUsableDate('2026-13-01')).toBe(false)
    expect(isUsableDate('')).toBe(false)
  })
})

describe('fmtDayAnyYear (r2-36: a date a year out read like today)', () => {
  it('leaves the year off in the reference year and adds it in any other', () => {
    expect(fmtDayAnyYear('2026-10-12', '2026-10-11')).toBe('Mon, Oct 12')
    expect(fmtDayAnyYear('2027-10-11', '2026-10-11')).toBe('Mon, Oct 11, 2027')
    expect(fmtDayAnyYear('2025-12-31', '2026-01-02')).toBe('Wed, Dec 31, 2025')
  })

  it('reads today() when no reference is given', () => {
    setClockOverride('2026-10-11')
    expect(fmtDayAnyYear('2027-10-11')).toBe('Mon, Oct 11, 2027')
    expect(fmtDayAnyYear('2026-11-02')).toBe('Mon, Nov 2')
  })
})

describe('bankHolidays (docs/LAW.md w-bank-holidays, Federal Reserve K.8 schedule)', () => {
  it('lists the 2026 closures: Jul 4 is a Saturday, so the Reserve Banks stay open Fri Jul 3', () => {
    expect(bankHolidays(2026)).toEqual([
      '2026-01-01',
      '2026-01-19',
      '2026-02-16',
      '2026-05-25',
      '2026-06-19',
      '2026-09-07',
      '2026-10-12',
      '2026-11-11',
      '2026-11-26',
      '2026-12-25',
    ])
    expect(federalHolidays(2026)).toContain('2026-07-03')
    expect(bankHolidays(2026)).not.toContain('2026-07-03')
  })

  it('moves a Sunday holiday to Monday and gives a Saturday one no weekday closure (2027)', () => {
    expect(bankHolidays(2027)).toEqual(['2027-01-01', '2027-01-18', '2027-02-15', '2027-05-31', '2027-07-05', '2027-09-06', '2027-10-11', '2027-11-11', '2027-11-25'])
    // Jun 19 and Dec 25, 2027 are Saturdays: banks open Fri Jun 18 and Fri Dec 24 (federal offices close).
    expect(bankHolidays(2027)).not.toContain('2027-06-18')
    expect(bankHolidays(2027)).not.toContain('2027-12-24')
    // New Year's Day 2028 is a Saturday: only the Board closes Dec 31, 2027.
    expect(bankHolidays(2027)).not.toContain('2027-12-31')
    expect(bankHolidays(2028)).not.toContain('2028-01-01')
  })
})
