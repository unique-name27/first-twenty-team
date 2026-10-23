import { describe, expect, it } from 'vitest'
import {
  businessDayOnOrBefore,
  businessDaysBetween,
  desiredAnnual,
  desiredHourly,
  desiredPayOf,
  isHire,
  isPacificDaylight,
  median,
  mondayOnOrAfter,
  pacificDateOf,
  pacificOffsetHours,
  pacificToUTC,
  snapTo,
  vestingText,
} from './util'

describe('business days', () => {
  it('counts business days after the start up to and including the end', () => {
    expect(businessDaysBetween('2026-10-09', '2026-10-09')).toBe(0)
    expect(businessDaysBetween('2026-10-09', '2026-10-10')).toBe(0) // Fri -> Sat
    expect(businessDaysBetween('2026-10-09', '2026-10-11')).toBe(0) // Fri -> Sun
    expect(businessDaysBetween('2026-10-09', '2026-10-12')).toBe(1) // Fri -> Mon
    expect(businessDaysBetween('2026-10-09', '2026-10-16')).toBe(5)
    expect(businessDaysBetween('2026-10-16', '2026-10-09')).toBe(0)
  })

  it('skips holidays given as dates or rows', () => {
    expect(businessDaysBetween('2026-11-25', '2026-11-30', ['2026-11-26', '2026-11-27'])).toBe(1)
    expect(businessDaysBetween('2026-11-25', '2026-11-30', [{ date: '2026-11-26' }, { date: '2026-11-27' }])).toBe(1)
  })

  it('finds the business day on or before a date', () => {
    expect(businessDayOnOrBefore('2026-10-11')).toBe('2026-10-09')
    expect(businessDayOnOrBefore('2026-11-27', ['2026-11-26', '2026-11-27'])).toBe('2026-11-25')
  })

  it('finds the Monday on or after a date', () => {
    expect(mondayOnOrAfter('2026-10-23')).toBe('2026-10-26')
    expect(mondayOnOrAfter('2026-10-26')).toBe('2026-10-26')
    expect(mondayOnOrAfter('2026-10-25')).toBe('2026-10-26')
  })
})

describe('Pacific time', () => {
  it('knows the 2026 and 2027 daylight saving boundaries', () => {
    expect(isPacificDaylight('2026-03-07')).toBe(false)
    expect(isPacificDaylight('2026-03-08')).toBe(true) // second Sunday of March
    expect(isPacificDaylight('2026-10-31')).toBe(true)
    expect(isPacificDaylight('2026-11-01')).toBe(false) // first Sunday of November
    expect(isPacificDaylight('2027-03-13')).toBe(false)
    expect(isPacificDaylight('2027-03-14')).toBe(true)
    expect(isPacificDaylight('2027-11-07')).toBe(false)
    expect(pacificOffsetHours('2026-07-01')).toBe(-7)
    expect(pacificOffsetHours('2026-12-01')).toBe(-8)
  })

  it('converts Pacific wall-clock times to UTC', () => {
    expect(pacificToUTC('2026-10-30', 10)).toBe('2026-10-30T17:00:00.000Z')
    expect(pacificToUTC('2026-11-02', 10)).toBe('2026-11-02T18:00:00.000Z')
    expect(pacificToUTC('2026-11-04', 15, 30)).toBe('2026-11-04T23:30:00.000Z')
  })

  it('reads the Pacific date of a timestamp', () => {
    expect(pacificDateOf('2026-10-14T06:30:00.000Z')).toBe('2026-10-13') // 11:30 PM PDT
    expect(pacificDateOf('2026-12-02T07:59:00.000Z')).toBe('2026-12-01') // 11:59 PM PST
    expect(pacificDateOf('2026-12-02T08:00:00.000Z')).toBe('2026-12-02')
  })
})

describe('small helpers', () => {
  it('computes medians', () => {
    expect(median([])).toBeNull()
    expect(median([5])).toBe(5)
    expect(median([9, 1, 5])).toBe(5)
    expect(median([1, 2, 3, 10])).toBe(2.5)
  })

  it('snaps to a step', () => {
    expect(snapTo(187_400, 1000)).toBe(187_000)
    expect(snapTo(237_500, 1000)).toBe(238_000)
    expect(snapTo(26_740, 500)).toBe(26_500)
  })

  it('describes vesting', () => {
    expect(vestingText(48, 12)).toBe('4-year vesting with a 1-year cliff, then monthly')
    expect(vestingText(24, 0)).toBe('2-year vesting, monthly')
  })

  it('counts hires only for hired or still-active accepted applications', () => {
    expect(isHire({ status: 'hired' })).toBe(true)
    expect(isHire({ status: 'active', conditionalOfferOn: '2026-10-07' })).toBe(true)
    expect(isHire({ status: 'rejected', conditionalOfferOn: '2026-10-07' })).toBe(false)
    expect(isHire({ status: 'active' })).toBe(false)
  })

  it('reads desired pay in its own unit, a year when none is stored', () => {
    expect(desiredPayOf({})).toBeUndefined()
    expect(desiredPayOf({ desiredPay: 62_000 })).toEqual({ amount: 62_000, unit: 'year' })
    const hourly = desiredPayOf({ desiredPay: 30, desiredPayUnit: 'hour' })
    expect(hourly).toEqual({ amount: 30, unit: 'hour' })
    expect(desiredAnnual(hourly)).toBe(62_400)
    expect(desiredHourly(hourly)).toBe(30)
    expect(desiredAnnual({ amount: 62_000, unit: 'year' })).toBe(62_000)
    expect(desiredHourly({ amount: 52_000, unit: 'year' })).toBe(25)
    expect(desiredAnnual(undefined)).toBeUndefined()
  })
})
