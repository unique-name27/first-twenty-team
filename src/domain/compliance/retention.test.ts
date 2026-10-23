import { describe, expect, it } from 'vitest'
import {
  anonymizeQueue,
  applicantRetainUntil,
  candidateRetainUntil,
  i9RetainUntil,
  isFehaEmployerOn,
  personnelRetainUntil,
  personnelRetainUntilFeha,
  personRetention,
} from './retention'
import { addMany, addOffer, addPerson, makeDB } from './testkit'

describe('retention dates', () => {
  it('keeps applicant records 4 years after the decision', () => {
    expect(applicantRetainUntil('2026-10-09')).toBe('2030-10-09')
    expect(applicantRetainUntil('2024-02-29')).toBe('2028-02-29')
  })

  it('keeps an I-9 until the later of 3 years after hire or 1 year after exit', () => {
    expect(i9RetainUntil('2025-08-18', '2026-09-18')).toBe('2028-08-18') // hire + 3 years wins
    expect(i9RetainUntil('2020-01-06', '2026-09-18')).toBe('2027-09-18') // exit + 1 year wins
    expect(i9RetainUntil('2025-08-18')).toBeNull()
  })

  it('keeps personnel files 4 years after the exit for FEHA employers (Gov. Code 12946), 3 years below 5', () => {
    expect(personnelRetainUntilFeha('2026-08-28')).toBe('2030-08-28')
    expect(personnelRetainUntil('2026-08-28')).toBe('2029-08-28') // Labor Code 1198.5 floor
    const db = makeDB()
    const p = addPerson(db, { id: 'p-omar', startDate: '2026-05-04', endDate: '2026-08-28', separation: { type: 'resigned_notice', reason: 'x', lastDay: '2026-08-28' } })
    expect(personRetention(p)).toEqual({ i9: '2029-05-04', personnelFile: '2030-08-28', wageHistory: '2030-08-28', payroll: '2029-08-28' })
    expect(personRetention(p, { fehaEmployer: false })).toEqual({ i9: '2029-05-04', personnelFile: '2029-08-28', wageHistory: '2029-08-28', payroll: '2029-08-28' })
    expect(personRetention(db.people[0])).toEqual({ i9: null, personnelFile: null, wageHistory: null, payroll: null })
    expect(isFehaEmployerOn(db, '2026-08-28')).toBe(false)
    addMany(db, 3, '2026-01-05')
    expect(isFehaEmployerOn(db, '2026-08-28')).toBe(true)
    expect(isFehaEmployerOn(db, '2026-08-29')).toBe(false)
  })
})

describe('anonymize queue', () => {
  function fixture() {
    const db = makeDB()
    const cand = (id: string, extra: Partial<(typeof db.candidates)[number]> = {}) =>
      db.candidates.push({ id, firstName: id, lastName: 'Cand', email: `${id}@x.dev`, links: {}, source: 'inbound', sponsorship: 'no', tags: [], createdOn: '2021-01-04', ...extra })
    const app = (id: string, candidateId: string, status: 'active' | 'rejected' | 'withdrawn' | 'hired', closedOn?: string) =>
      db.applications.push({ id, candidateId, jobId: 'j-1', stageId: 'new', status, appliedOn: '2021-01-04', stageEnteredOn: '2021-01-04', history: [], closedOn })
    cand('c-old')
    app('a-old', 'c-old', 'rejected', '2021-02-01')
    cand('c-recent')
    app('a-recent', 'c-recent', 'rejected', '2023-06-01')
    cand('c-active')
    app('a-active-old', 'c-active', 'rejected', '2021-02-01')
    app('a-active', 'c-active', 'active')
    cand('c-hired')
    app('a-hired', 'c-hired', 'hired', '2021-02-01')
    addPerson(db, { id: 'p-hired', startDate: '2021-03-01', fromCandidateId: 'c-hired' })
    cand('c-done', { anonymizedOn: '2025-06-01' })
    app('a-done', 'c-done', 'rejected', '2021-02-01')
    cand('c-extended', { retainUntil: '2027-01-01' })
    app('a-ext', 'c-extended', 'withdrawn', '2021-02-01')
    cand('c-offer')
    app('a-offer', 'c-offer', 'rejected', '2021-02-01')
    addOffer(db, { id: 'o-open', candidateId: 'c-offer', startDate: '2026-12-01', status: 'sent' })
    cand('c-never', { createdOn: '2021-05-03' })
    return db
  }

  it('offers applicants past 4 years, and skips open, hired, extended and already anonymized records', () => {
    const db = fixture()
    const q = anonymizeQueue(db, '2026-10-09')
    expect(q.map((x) => [x.candidateId, x.retainUntil])).toEqual([
      ['c-old', '2025-02-01'],
      ['c-never', '2025-05-03'],
    ])
    expect(q[0]).toMatchObject({ name: 'c-old Cand', lastDecisionOn: '2021-02-01', reason: 'Past the 4-year applicant record retention period (Gov. Code 12946).' })
  })

  it('computes each candidate retain-until date', () => {
    const db = fixture()
    const get = (id: string) => db.candidates.find((c) => c.id === id) as (typeof db.candidates)[number]
    expect(candidateRetainUntil(db, get('c-recent'))).toBe('2027-06-01')
    expect(candidateRetainUntil(db, get('c-active'))).toBeNull()
    expect(candidateRetainUntil(db, get('c-hired'))).toBeNull()
    expect(candidateRetainUntil(db, get('c-offer'))).toBeNull()
    expect(candidateRetainUntil(db, get('c-extended'))).toBe('2027-01-01')
  })
})
