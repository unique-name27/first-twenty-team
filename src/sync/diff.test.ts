import { produce } from 'immer'
import { beforeAll, describe, expect, it } from 'vitest'
import type { DB } from '@/domain/types'
import { setClockOverride } from '@/lib/dates'
import { deepEqual, diffDB } from './diff'
import { makeDB, makePerson } from './testing/kit'

beforeAll(() => setClockOverride('2026-10-10'))

/** A frozen workspace with two extra people, as the store would hold it. */
function base(): DB {
  return produce(makeDB(), (d) => {
    d.people.push(makePerson('p-1'), makePerson('p-2'))
  })
}

describe('diffDB', () => {
  it('returns nothing for the same snapshot', () => {
    const db = base()
    expect(diffDB(db, db)).toEqual([])
  })

  it('returns nothing for an Immer recipe that changes nothing', () => {
    const db = base()
    const next = produce(db, (d) => {
      d.people[0].firstName = d.people[0].firstName
      d.company.name = d.company.name
    })
    expect(next).toBe(db)
    expect(diffDB(db, next)).toEqual([])
  })

  it('reports an edited record as an upsert carrying the new record', () => {
    const db = base()
    const next = produce(db, (d) => {
      d.people.find((p) => p.id === 'p-1')!.title = 'Staff engineer'
    })
    const changes = diffDB(db, next)
    expect(changes).toEqual([{ collection: 'people', id: 'p-1', op: 'upsert', data: next.people.find((p) => p.id === 'p-1') }])
    expect(changes[0].data).toBe(next.people.find((p) => p.id === 'p-1'))
  })

  it('reports added and removed records', () => {
    const db = base()
    const next = produce(db, (d) => {
      d.people.push(makePerson('p-3'))
      d.people.splice(
        d.people.findIndex((p) => p.id === 'p-2'),
        1,
      )
      d.holidays = d.holidays.filter((h) => h !== d.holidays[0])
    })
    const changes = diffDB(db, next)
    expect(changes).toContainEqual({ collection: 'people', id: 'p-3', op: 'upsert', data: makePerson('p-3') })
    expect(changes).toContainEqual({ collection: 'people', id: 'p-2', op: 'delete' })
    expect(changes).toContainEqual({ collection: 'holidays', id: db.holidays[0].id, op: 'delete' })
    expect(changes).toHaveLength(3)
  })

  it('reports a record swapped for a different object with the same id as an upsert', () => {
    const db = base()
    const next = produce(db, (d) => {
      const i = d.people.findIndex((p) => p.id === 'p-1')
      d.people[i] = makePerson('p-1', { lastName: 'Changed' })
    })
    expect(diffDB(db, next)).toEqual([{ collection: 'people', id: 'p-1', op: 'upsert', data: makePerson('p-1', { lastName: 'Changed' }) }])
  })

  it('ignores replaced objects that are deep-equal (JSON round trip, re-created records)', () => {
    const db = base()
    const roundTrip = JSON.parse(JSON.stringify(db)) as DB
    expect(diffDB(db, roundTrip)).toEqual([])
    const recreated = produce(db, (d) => {
      const i = d.people.findIndex((p) => p.id === 'p-2')
      d.people[i] = makePerson('p-2')
    })
    expect(recreated).not.toBe(db)
    expect(diffDB(db, recreated)).toEqual([])
  })

  it('treats a key holding undefined like a missing key (JSON semantics)', () => {
    const db = base()
    const next = produce(db, (d) => {
      d.people[0].endDate = undefined
      d.company.website = undefined
    })
    expect(diffDB(db, next)).toEqual([])
  })

  it('ignores record order', () => {
    const db = base()
    const next = produce(db, (d) => {
      d.people.reverse()
    })
    expect(diffDB(db, next)).toEqual([])
  })

  it('reports changed documents as $doc upserts', () => {
    const db = base()
    const next = produce(db, (d) => {
      d.company.name = 'Acme Two'
      d.settings.scorecardDueHours = 48
      d.complianceStatus['iipp'] = { status: 'done', doneOn: '2026-10-01' }
      d.inboxState['k1'] = { dismissedOn: '2026-10-02' }
    })
    const changes = diffDB(db, next)
    expect(changes.map((c) => `${c.collection}:${c.id}`).sort()).toEqual(['$doc:company', '$doc:complianceStatus', '$doc:inboxState', '$doc:settings'])
    expect(changes.find((c) => c.id === 'company')!.data).toBe(next.company)
  })

  it('ignores schemaVersion', () => {
    const db = base()
    const next = { ...db, schemaVersion: 2 } as unknown as DB
    expect(diffDB(db, next)).toEqual([])
  })

  it('lists record collections in the shared order, then documents', () => {
    const db = base()
    const next = produce(db, (d) => {
      d.meta.lastExportedOn = '2026-10-10T12:00:00.000Z'
      d.activity.push({ id: 'act-1', at: '2026-10-10T12:00:00.000Z', entityType: 'person', entityId: 'p-1', kind: 'note', text: 'Hi' })
      d.people[0].notes = 'Note'
      d.departments[0].name = 'Renamed'
    })
    expect(diffDB(db, next).map((c) => c.collection)).toEqual(['departments', 'people', 'activity', '$doc'])
  })

  it('handles a collection missing from an older save', () => {
    const db = base()
    const old = { ...db } as Record<string, unknown>
    delete old.recordsRequests
    const next = produce(db, (d) => {
      d.recordsRequests.push({ id: 'rr-1', personId: 'p-1', type: 'personnel_file', receivedOn: '2026-10-01', dueOn: '2026-10-31' })
    })
    expect(diffDB(old as unknown as DB, next)).toEqual([{ collection: 'recordsRequests', id: 'rr-1', op: 'upsert', data: next.recordsRequests[0] }])
  })

  it('skips entries without a string id, and the last of repeated ids wins', () => {
    const db = base()
    const next = produce(db, (d) => {
      ;(d.people as unknown[]).push({ name: 'no id' })
      d.people.push(makePerson('p-dup', { title: 'First' }), makePerson('p-dup', { title: 'Second' }))
    })
    const changes = diffDB(db, next)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ id: 'p-dup', op: 'upsert', data: { title: 'Second' } })
  })

  it('reverses cleanly: an undo diff is the inverse of the edit', () => {
    const db = base()
    const next = produce(db, (d) => {
      d.people.push(makePerson('p-3'))
      d.people = d.people.filter((p) => p.id !== 'p-1')
      d.people.find((p) => p.id === 'p-2')!.title = 'Lead'
    })
    const undo = diffDB(next, db)
    expect(undo).toContainEqual({ collection: 'people', id: 'p-3', op: 'delete' })
    expect(undo).toContainEqual({ collection: 'people', id: 'p-1', op: 'upsert', data: db.people.find((p) => p.id === 'p-1') })
    expect(undo).toContainEqual({ collection: 'people', id: 'p-2', op: 'upsert', data: db.people.find((p) => p.id === 'p-2') })
    expect(undo).toHaveLength(3)
  })

  it('stays fast on a big collection with one edit', () => {
    const big = produce(makeDB(), (d) => {
      for (let i = 0; i < 5000; i++) d.activity.push({ id: `act-${i}`, at: '2026-10-10T12:00:00.000Z', entityType: 'person', entityId: 'p-founder', kind: 'note', text: `n${i}` })
    })
    const next = produce(big, (d) => {
      d.activity[2500].text = 'edited'
    })
    const t = performance.now()
    for (let i = 0; i < 50; i++) diffDB(big, next)
    const per = (performance.now() - t) / 50
    expect(diffDB(big, next)).toHaveLength(1)
    expect(per).toBeLessThan(20)
  })
})

describe('deepEqual', () => {
  it('compares values structurally', () => {
    expect(deepEqual({ a: [1, { b: 'x' }] }, { a: [1, { b: 'x' }] })).toBe(true)
    expect(deepEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false)
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true)
    expect(deepEqual({ a: null }, {})).toBe(false)
    expect(deepEqual([], {})).toBe(false)
    expect(deepEqual(null, undefined)).toBe(false)
    expect(deepEqual('1', 1)).toBe(false)
    expect(deepEqual(undefined, undefined)).toBe(true)
  })
})
