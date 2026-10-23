import { produce } from 'immer'
import { beforeAll, describe, expect, it } from 'vitest'
import type { DB } from '@/domain/types'
import { setClockOverride } from '@/lib/dates'
import { applyChanges, isApplicable, localValue } from './apply'
import { makeDB, makePerson } from './testing/kit'

beforeAll(() => setClockOverride('2026-10-10'))

function base(): DB {
  return produce(makeDB(), (d) => {
    d.people.push(makePerson('p-1'), makePerson('p-2'))
  })
}

describe('applyChanges', () => {
  it('replaces, appends and removes records, keeping untouched ones identical', () => {
    const db = base()
    const p1 = makePerson('p-1', { title: 'Lead' })
    const next = applyChanges(db, [
      { collection: 'people', id: 'p-1', op: 'upsert', data: p1 },
      { collection: 'people', id: 'p-3', op: 'upsert', data: makePerson('p-3') },
      { collection: 'people', id: 'p-2', op: 'delete' },
    ])
    expect(next.people.map((p) => p.id)).toEqual(['p-founder', 'p-1', 'p-3'])
    expect(next.people[1]).toBe(p1)
    expect(next.people[0]).toBe(db.people[0])
    expect(next.jobs).toBe(db.jobs)
    expect(next.company).toBe(db.company)
    expect(db.people).toHaveLength(3)
  })

  it('returns the same DB when nothing really changes', () => {
    const db = base()
    expect(applyChanges(db, [])).toBe(db)
    expect(applyChanges(db, [{ collection: 'people', id: 'p-1', op: 'upsert', data: makePerson('p-1') }])).toBe(db)
    expect(applyChanges(db, [{ collection: 'people', id: 'nope', op: 'delete' }])).toBe(db)
    expect(applyChanges(db, [{ collection: '$doc', id: 'company', op: 'upsert', data: JSON.parse(JSON.stringify(db.company)) }])).toBe(db)
  })

  it('applies changes in order: the last one for a record wins', () => {
    const db = base()
    const next = applyChanges(db, [
      { collection: 'people', id: 'p-1', op: 'delete' },
      { collection: 'people', id: 'p-1', op: 'upsert', data: makePerson('p-1', { title: 'Back' }) },
      { collection: 'people', id: 'p-9', op: 'upsert', data: makePerson('p-9') },
      { collection: 'people', id: 'p-9', op: 'delete' },
    ])
    expect(next.people.find((p) => p.id === 'p-1')?.title).toBe('Back')
    expect(next.people.some((p) => p.id === 'p-9')).toBe(false)
  })

  it('replaces documents and never deletes them', () => {
    const db = base()
    const company = { ...db.company, name: 'Renamed' }
    const next = applyChanges(db, [
      { collection: '$doc', id: 'company', op: 'upsert', data: company },
      { collection: '$doc', id: 'settings', op: 'delete' },
    ])
    expect(next.company).toBe(company)
    expect(next.settings).toBe(db.settings)
  })

  it('ignores unknown collections, unknown documents and records whose id does not match', () => {
    const db = base()
    const changes = [
      { collection: 'secrets', id: 'x', op: 'upsert' as const, data: { id: 'x' } },
      { collection: '$doc', id: 'schemaVersion', op: 'upsert' as const, data: 9 },
      { collection: '$doc', id: '__proto__', op: 'upsert' as const, data: { polluted: true } },
      { collection: 'people', id: 'p-1', op: 'upsert' as const, data: { id: 'p-2' } },
      { collection: 'people', id: 'p-1', op: 'upsert' as const, data: null },
      { collection: 'people', id: 'p-1', op: 'upsert' as const, data: [] },
    ]
    for (const c of changes) expect(isApplicable(c)).toBe(false)
    expect(applyChanges(db, changes)).toBe(db)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('creates a collection that an older snapshot lacks', () => {
    const db = base()
    const old = { ...db } as Record<string, unknown>
    delete old.acks
    const next = applyChanges(old as unknown as DB, [{ collection: 'acks', id: 'k1', op: 'upsert', data: { id: 'k1', policyId: 'pol', version: '1', personId: 'p-1', acknowledgedOn: '2026-10-01' } }])
    expect(next.acks).toHaveLength(1)
  })
})

describe('localValue', () => {
  it('finds records and documents', () => {
    const db = base()
    expect(localValue(db, 'people', 'p-2')).toBe(db.people[2])
    expect(localValue(db, 'people', 'nope')).toBeUndefined()
    expect(localValue(db, '$doc', 'company')).toBe(db.company)
    expect(localValue(db, '$doc', 'people')).toBeUndefined()
    expect(localValue(db, 'unknown', 'x')).toBeUndefined()
  })
})
