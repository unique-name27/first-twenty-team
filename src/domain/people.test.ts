import { describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import { daysAway, priorStint } from '@/domain/people'
import type { DB, Person } from '@/domain/types'

function db(): DB {
  const d = blankDB({ companyName: 'Ledgerlark', founderFirstName: 'Maya', founderLastName: 'Raman', foundedOn: '2025-02-03' })
  const omar: Person = {
    ...d.people[0],
    id: 'p-omar',
    firstName: 'Omar',
    lastName: 'Haddad',
    workEmail: 'omar@ledgerlark.com',
    personalEmail: 'omar.h@example.com',
    isFounder: false,
    startDate: '2025-01-13',
    endDate: '2026-08-28',
    hireNumber: 10,
  }
  d.people.push(omar)
  return d
}

const NEW = { id: '', startDate: '2026-10-12' }

describe('priorStint', () => {
  it('finds a former employee by full name as someone types it in', () => {
    const d = db()
    expect(priorStint(d, { ...NEW, firstName: 'Omar', lastName: 'Haddad' })?.id).toBe('p-omar')
    expect(priorStint(d, { ...NEW, firstName: ' omar', lastName: 'HADDAD ' })?.id).toBe('p-omar')
    // A partly typed name matches nobody
    expect(priorStint(d, { ...NEW, firstName: 'Omar', lastName: 'H' })).toBeUndefined()
  })

  it('prefers the personal email when both records have one', () => {
    const d = db()
    expect(priorStint(d, { ...NEW, firstName: 'Omar', lastName: 'Haddad', personalEmail: 'Omar.H@example.com' })?.id).toBe('p-omar')
    expect(priorStint(d, { ...NEW, firstName: 'Omar', lastName: 'Haddad', personalEmail: 'someone.else@example.com' })).toBeUndefined()
  })

  it('ignores people still employed on the new start date, and follows an explicit link', () => {
    const d = db()
    expect(priorStint(d, { ...NEW, startDate: '2026-08-01', firstName: 'Omar', lastName: 'Haddad' })).toBeUndefined()
    expect(priorStint(d, { ...NEW, firstName: 'O.', lastName: 'Haddad-Smith', rehireOfPersonId: 'p-omar' })?.id).toBe('p-omar')
  })
})

describe('daysAway', () => {
  it('counts the whole days between the last day and the new start', () => {
    expect(daysAway('2026-08-28', '2026-10-12')).toBe(44)
    expect(daysAway('2026-10-09', '2026-10-12')).toBe(2)
    expect(daysAway('2026-10-11', '2026-10-12')).toBe(0)
  })
})
