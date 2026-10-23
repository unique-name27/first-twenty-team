// Pure helpers behind the UI kit: chart ticks, weekend-aware date chips, typed dates and the undo history ids.
import { describe, expect, it } from 'vitest'
import { useDB } from '@/store/db'
import { monthTickLabels, niceTicks } from './charts'
import { defaultDateChips, pickedDateProblem } from './Chips'
import { rangeError } from './Field'

describe('chart ticks (design-6)', () => {
  it('uses round steps, never odd halves', () => {
    expect(niceTicks(25)).toEqual([0, 5, 10, 15, 20, 25])
    expect(niceTicks(20)).toEqual([0, 5, 10, 15, 20])
    expect(niceTicks(10)).toEqual([0, 2, 4, 6, 8, 10])
    expect(niceTicks(5)).toEqual([0, 1, 2, 3, 4, 5])
    expect(niceTicks(100)).toEqual([0, 20, 40, 60, 80, 100])
  })

  it('names the year on the first tick and wherever it changes', () => {
    expect(monthTickLabels(['2025-03-01', '2025-09-01', '2026-03-01', '2026-09-01'])).toEqual(['Mar 2025', 'Sep', 'Mar 2026', 'Sep'])
  })
})

describe('date chips on a weekend (flow-13)', () => {
  it('never shows Today or Tomorrow picking Monday, and has one chip per date', () => {
    const chips = defaultDateChips('2026-10-10', true) // Saturday
    expect(chips.map((c) => c.label)).toEqual(['Next Mon', 'Mon, Oct 19', 'Mon, Oct 26'])
    expect(new Set(chips.map((c) => c.date)).size).toBe(chips.length)
  })

  it('keeps the usual chips on a weekday', () => {
    expect(defaultDateChips('2026-10-08', true).map((c) => c.label)).toEqual(['Today', 'Tomorrow', 'Next Mon', '+1 week', '+2 weeks'])
  })

  it('names the year on a moved chip that lands in another year (r2-36)', () => {
    const chips = defaultDateChips('2026-12-26', true) // Saturday
    expect(chips.map((c) => c.label)).toEqual(['Next Mon', 'Mon, Jan 4, 2027', 'Mon, Jan 11, 2027'])
    expect(chips.map((c) => c.date)).toEqual(['2026-12-28', '2027-01-04', '2027-01-11'])
  })
})

describe('typed dates in DateChips (r2-35: a 6-digit year crashed the page)', () => {
  it('refuses a year that is not 4 digits, or one still being typed', () => {
    expect(pickedDateProblem('20266-03-16')).toBe('Enter a date with a 4-digit year')
    expect(pickedDateProblem('202666-03-16')).toBe('Enter a date with a 4-digit year')
    expect(pickedDateProblem('0202-03-16')).toBe('Enter a date with a 4-digit year')
  })

  it('names the limit when a date is outside min to max', () => {
    expect(pickedDateProblem('2026-10-01', '2026-10-11')).toBe('Enter a date on or after Oct 11, 2026')
    expect(pickedDateProblem('2026-10-20', undefined, '2026-10-11')).toBe('Enter a date on or before Oct 11, 2026')
  })

  it('takes a usable date within the limits, and says nothing about an empty field', () => {
    expect(pickedDateProblem('2026-03-16')).toBeNull()
    expect(pickedDateProblem('2026-10-11', '2026-10-11', '2026-10-11')).toBeNull()
    expect(pickedDateProblem('')).toBeNull()
  })
})

describe('number range messages (offers-letters: 4,032 hours a week)', () => {
  it('names the range when a number falls outside it, and says nothing when it fits or is empty', () => {
    expect(rangeError(4032, 1, 60)).toBe('Enter a number from 1 to 60')
    expect(rangeError(0, 1, 60)).toBe('Enter a number from 1 to 60')
    expect(rangeError(40, 1, 60)).toBeNull()
    expect(rangeError(60, '1', '60')).toBeNull()
    expect(rangeError(null, 1, 60)).toBeNull()
    expect(rangeError(-5, 0)).toBe('Enter a number of 0 or more')
    expect(rangeError(5000, undefined, 1000)).toBe('Enter a number of 1,000 or less')
    expect(rangeError(12, undefined, undefined)).toBeNull()
  })
})

describe('undo history (cq-1)', () => {
  it('undoes a change by id only while it is the newest one', () => {
    const { mutate } = useDB.getState()
    mutate('First change', (d) => {
      d.company.name = 'One'
    })
    const first = useDB.getState().past.at(-1)
    mutate('Second change', (d) => {
      d.company.name = 'Two'
    })
    const second = useDB.getState().past.at(-1)
    expect(first && second && first.id !== second.id).toBe(true)
    if (!first || !second) return
    expect(useDB.getState().undoEntry(first.id)).toBe('newer')
    expect(useDB.getState().db.company.name).toBe('Two')
    expect(useDB.getState().undoEntry(second.id)).toBe('undone')
    expect(useDB.getState().db.company.name).toBe('One')
    expect(useDB.getState().undoEntry(second.id)).toBe('gone')
    expect(useDB.getState().undoEntry(first.id)).toBe('undone')
  })
})
