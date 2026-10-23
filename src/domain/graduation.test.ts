// The store loads first so every seed and domain module finishes loading before the sample is built.
import '@/store/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildSampleDB } from '@/data/seed'
import { addMany, addOffer, addPerson, makeDB } from '@/domain/compliance/testkit'
import { inboxItems } from '@/domain/inbox'
import type { DB, Viewer } from '@/domain/types'
import { setClockOverride } from '@/lib/dates'
import { buildGraduationPack, GRADUATION_PACKS, graduationCount } from './graduation'

const TODAY = '2026-10-09'

let sample: DB

beforeAll(() => {
  setClockOverride(TODAY)
  sample = buildSampleDB()
})
afterAll(() => setClockOverride(null))

const header = (csv: string) => csv.split('\r\n')[0].split(',')

describe('graduationCount', () => {
  it('counts employees, future starts and accepted offers not yet turned into people', () => {
    const db = makeDB()
    addMany(db, 3, '2025-02-03')
    addPerson(db, { id: 'p-soon', startDate: '2026-11-02' })
    addPerson(db, { id: 'p-gone', startDate: '2025-02-03', endDate: '2026-03-31' })
    addOffer(db, { id: 'o-acc', startDate: '2026-12-07', status: 'accepted' })
    addOffer(db, { id: 'o-out', startDate: '2026-12-07', status: 'sent' })
    const c = graduationCount(db, TODAY)
    expect(c.employed).toBe(db.people.filter((p) => p.startDate <= TODAY && !p.endDate).length)
    expect(c.incoming).toBe(2)
    expect(c.total).toBe(c.employed + 2)
  })
  it('lists work states outside the HQ state', () => {
    const db = makeDB()
    addPerson(db, { id: 'p-co', startDate: '2025-02-03', homeState: 'CO' })
    addPerson(db, { id: 'p-tx', startDate: '2025-02-03', homeState: 'tx' })
    const c = graduationCount(db, TODAY)
    expect(c.outOfState).toBe(2)
    expect(c.outOfStateStates).toEqual(['CO', 'TX'])
  })
  it('counts the sample company', () => {
    const c = graduationCount(sample, TODAY)
    expect(c.employed).toBeGreaterThanOrEqual(10)
    expect(c.total).toBeGreaterThanOrEqual(c.employed)
  })
})

describe('buildGraduationPack', () => {
  it('builds every pack for the sample with one row per record', () => {
    for (const pack of GRADUATION_PACKS) {
      const { csv, rows } = buildGraduationPack(sample, pack.id, TODAY)
      expect(rows).toBeGreaterThan(0)
      expect(csv.split('\r\n').length).toBeGreaterThanOrEqual(rows + 1)
    }
    expect(buildGraduationPack(sample, 'people', TODAY).rows).toBe(sample.people.length)
    expect(buildGraduationPack(sample, 'job_pay', TODAY).rows).toBe(sample.comp.length)
    expect(buildGraduationPack(sample, 'grants', TODAY).rows).toBe(sample.grants.length)
  })
  it('never exports protected characteristics, government ids or desired pay', () => {
    const all = GRADUATION_PACKS.map((p) => header(buildGraduationPack(sample, p.id, TODAY).csv).join('|').toLowerCase()).join('|')
    for (const banned of ['birth', 'gender', 'race', 'ssn', 'social security', 'bank', 'desired', 'salary history', 'sponsorship', 'pronoun']) {
      expect(all).not.toContain(banned)
    }
  })
  it('uses ISO dates and plain headers', () => {
    const people = buildGraduationPack(sample, 'people', TODAY).csv
    expect(header(people).slice(0, 4)).toEqual(['Employee ID', 'Employee number', 'First name', 'Last name'])
    const founder = people.split('\r\n')[1]
    expect(founder).toMatch(/,\d{4}-\d{2}-\d{2},/)
    const candidates = buildGraduationPack(sample, 'candidates', TODAY)
    expect(candidates.rows).toBe(sample.applications.filter((a) => sample.candidates.some((c) => c.id === a.candidateId)).length)
  })
})

describe('graduation inbox item', () => {
  const admin = (db: DB): Viewer => ({ role: 'admin', person: db.people[0], personId: db.people[0]?.id ?? null })
  const now = { now: `${TODAY}T19:00:00.000Z` }
  it('appears for Admin at 20 people counting accepted offers, and stays gone once dismissed', () => {
    const db = makeDB()
    addMany(db, 18, '2025-02-03')
    const before = graduationCount(db, TODAY).total
    expect(inboxItems(db, admin(db), TODAY, now).some((i) => i.kind === 'graduation')).toBe(before >= 20)
    for (let i = before; i < 20; i++) addOffer(db, { id: `o-g${i}`, startDate: '2026-12-07', status: 'accepted' })
    const item = inboxItems(db, admin(db), TODAY, now).find((i) => i.kind === 'graduation')
    expect(item).toMatchObject({ key: 'graduation', statutory: false, href: '#settings.data.graduation' })
    expect(item?.title).toMatch(/^20 people, counting accepted offers/)
    expect(inboxItems(db, { ...admin(db), role: 'manager' }, TODAY, now).some((i) => i.kind === 'graduation')).toBe(false)
    db.inboxState.graduation = { dismissedOn: TODAY }
    expect(inboxItems(db, admin(db), TODAY, now).some((i) => i.kind === 'graduation')).toBe(false)
  })
})
