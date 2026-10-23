import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { defaultHolidays } from '@/data/defaults'
import { makeDB } from '@/domain/compliance/testkit'
import { applyInboxOp, inboxItems } from '@/domain/inbox'
import type { DB, Holiday, Viewer } from '@/domain/types'
import { hasHolidaysIn, holidaysForYear, nthWeekday, observedDate, rolloverHolidays } from './holidays'

const inYear = (list: Holiday[], y: number) => list.filter((h) => h.date.startsWith(`${y}-`))
const pairs = (list: Holiday[]) => list.map((h) => [h.date, h.name])

describe('nthWeekday and observedDate', () => {
  it('finds nth and last weekdays', () => {
    expect(nthWeekday(2028, 1, 1, 3)).toBe('2028-01-17') // MLK Day
    expect(nthWeekday(2028, 5, 1, -1)).toBe('2028-05-29') // Memorial Day
    expect(nthWeekday(2028, 9, 1, 1)).toBe('2028-09-04') // Labor Day
    expect(nthWeekday(2028, 11, 4, 4)).toBe('2028-11-23') // Thanksgiving
  })
  it('moves Saturday to Friday and Sunday to Monday', () => {
    expect(observedDate('2026-07-04')).toBe('2026-07-03')
    expect(observedDate('2027-07-04')).toBe('2027-07-05')
    expect(observedDate('2028-07-04')).toBe('2028-07-04')
  })
})

describe('holidaysForYear', () => {
  it('matches the built-in 2025 and 2026 lists', () => {
    expect(pairs(holidaysForYear(2025))).toEqual(pairs(inYear(defaultHolidays(), 2025)))
    expect(pairs(holidaysForYear(2026))).toEqual(pairs(inYear(defaultHolidays(), 2026)))
  })
  it('keeps Christmas Eve in 2027 by moving it to Thursday, and observes New Year 2028 on Dec 31', () => {
    const got = holidaysForYear(2027)
    const built = inYear(defaultHolidays(), 2027)
    expect(got.filter((h) => h.date !== '2027-12-23').map((h) => h.date)).toEqual(built.map((h) => h.date))
    expect(got.find((h) => h.date === '2027-12-23')?.name).toBe('Christmas Eve (observed)')
    expect(got.find((h) => h.date === '2027-12-31')?.name).toBe("New Year's Day (observed)")
  })
  it('builds 2028 with observed dates and no Jan 1 (observed in 2027)', () => {
    expect(pairs(holidaysForYear(2028))).toEqual([
      ['2028-01-17', 'Martin Luther King Jr. Day'],
      ['2028-02-21', "Presidents' Day"],
      ['2028-05-29', 'Memorial Day'],
      ['2028-06-19', 'Juneteenth'],
      ['2028-07-04', 'Independence Day'],
      ['2028-09-04', 'Labor Day'],
      ['2028-11-23', 'Thanksgiving'],
      ['2028-11-24', 'Day after Thanksgiving'],
      ['2028-12-22', 'Christmas Eve (observed)'],
      ['2028-12-25', 'Christmas Day'],
    ])
  })
  it('uses only the named rules, matching observed names and aliases', () => {
    const got = holidaysForYear(2029, ['Independence Day (observed)', 'Columbus Day', 'Veterans Day', 'Floating holiday'])
    expect(pairs(got)).toEqual([
      ['2029-07-04', 'Independence Day'],
      ['2029-10-08', "Indigenous Peoples' Day"],
      ['2029-11-12', 'Veterans Day (observed)'],
    ])
  })
  it('never lands on a weekend and never repeats a date', () => {
    for (let y = 2025; y <= 2040; y++) {
      const list = holidaysForYear(y, ['Christmas Eve', 'Christmas Day', 'Day after Christmas', "New Year's Day", 'Veterans Day', 'Cesar Chavez Day'])
      const days = list.map((h) => new Date(`${h.date}T12:00:00`).getDay())
      expect(days.every((d) => d !== 0 && d !== 6)).toBe(true)
      expect(new Set(list.map((h) => h.date)).size).toBe(list.length)
      expect(list.every((h) => h.date.startsWith(`${y}-`))).toBe(true)
    }
  })
})

describe('rolloverHolidays', () => {
  it('rolls the built-in list into 2028', () => {
    const r = rolloverHolidays(defaultHolidays(), 2028)
    expect(r.basedOn).toEqual([2027, 2026])
    expect(r.byHand).toEqual([])
    expect(r.add).toHaveLength(10)
    expect(r.add[0]).toEqual({ id: 'hol-2028-01-17', date: '2028-01-17', name: 'Martin Luther King Jr. Day' })
    expect(r.observedYearBefore).toEqual({ id: 'hol-2027-12-31', date: '2027-12-31', name: "New Year's Day (observed)" })
    expect(rolloverHolidays(defaultHolidays(), 2027).observedYearBefore).toBeNull()
  })
  it('keeps removed holidays removed and lists custom days to add by hand', () => {
    const list: Holiday[] = [
      { id: 'a', date: '2027-01-01', name: "New Year's Day" },
      { id: 'b', date: '2027-11-11', name: 'Veterans Day' },
      { id: 'c', date: '2027-08-13', name: 'Company day off' },
    ]
    const r = rolloverHolidays(list, 2028)
    expect(r.basedOn).toEqual([2027])
    expect(pairs(r.add)).toEqual([
      ['2028-11-10', 'Veterans Day (observed)'],
    ])
    expect(r.byHand).toEqual(['Company day off'])
  })
  it('uses the standard set with no recent list and skips dates already there', () => {
    const r = rolloverHolidays([{ id: 'x', date: '2030-07-04', name: 'Fourth of July' }], 2030)
    expect(r.basedOn).toEqual([])
    expect(r.add.some((h) => h.date === '2030-07-04')).toBe(false)
    expect(r.add.length).toBe(holidaysForYear(2030).length - 1)
  })
  it('hasHolidaysIn', () => {
    expect(hasHolidaysIn(defaultHolidays(), 2027)).toBe(true)
    expect(hasHolidaysIn(defaultHolidays(), 2028)).toBe(false)
  })
})

describe('December holiday rollover in the inbox', () => {
  const admin = (db: DB): Viewer => ({ role: 'admin', person: db.people[0], personId: db.people[0]?.id ?? null })
  const at = (date: string) => ({ now: `${date}T19:00:00.000Z` })

  it('asks for next year in December only, and only when that year is empty', () => {
    const db = makeDB()
    db.holidays = defaultHolidays()
    expect(inboxItems(db, admin(db), '2027-11-30', at('2027-11-30')).some((i) => i.kind === 'holidays')).toBe(false)
    const item = inboxItems(db, admin(db), '2027-12-06', at('2027-12-06')).find((i) => i.kind === 'holidays')
    expect(item).toMatchObject({ key: 'holidays:2028', title: 'Add the 2028 company holidays', dueOn: '2027-12-31', statutory: false })
    expect(item?.detail).toContain('10 holidays carried over from 2027 and 2026')
    expect(inboxItems(db, admin(db), '2026-12-07', at('2026-12-07')).some((i) => i.kind === 'holidays')).toBe(false) // 2027 is listed
    expect(inboxItems(db, { ...admin(db), role: 'manager' }, '2027-12-06', at('2027-12-06')).some((i) => i.kind === 'holidays')).toBe(false)
  })

  it('adds the holidays in one tap and refuses a second time', () => {
    const db = makeDB()
    db.holidays = defaultHolidays()
    const ctx = { date: '2027-12-06', actorId: null }
    const next = produce(db, (d) => {
      expect(applyInboxOp(d, { type: 'add_holidays', year: 2028 }, ctx)).toEqual({ ok: true })
      expect(applyInboxOp(d, { type: 'add_holidays', year: 2028 }, ctx).ok).toBe(false)
    })
    expect(next.holidays.filter((h) => h.date.startsWith('2028-'))).toHaveLength(10)
    expect(next.holidays.map((h) => h.date)).toEqual([...next.holidays.map((h) => h.date)].sort())
    expect(inboxItems(next, admin(next), '2027-12-06', at('2027-12-06')).some((i) => i.kind === 'holidays')).toBe(false)
  })
})
