import { describe, expect, it } from 'vitest'
import type { LocalChange } from './diff'
import {
  type ConnectionState,
  clearConnection,
  emptyConnection,
  enqueueChanges,
  loadConnection,
  maxRev,
  type OutboxEntry,
  readStoreMark,
  recordKey,
  SYNC_MARK_KEY,
  SYNC_SCHEMA,
  SYNC_STORAGE_KEY,
  saveConnection,
  writeStoreMark,
} from './state'
import { memoryStorage } from './testing/kit'

describe('connection state', () => {
  it('starts local when nothing is saved, storage is missing or unreadable', () => {
    expect(loadConnection(null)).toEqual(emptyConnection())
    expect(loadConnection(memoryStorage())).toEqual(emptyConnection())
    const throwing = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    }
    expect(loadConnection(throwing)).toEqual(emptyConnection())
    expect(saveConnection(throwing, emptyConnection())).toBe(false)
    expect(() => clearConnection(throwing)).not.toThrow()
  })

  it('ignores garbage and other versions', () => {
    const s = memoryStorage()
    s.setItem(SYNC_STORAGE_KEY, '{not json')
    expect(loadConnection(s)).toEqual(emptyConnection())
    s.setItem(SYNC_STORAGE_KEY, JSON.stringify({ v: 2, mode: 'server' }))
    expect(loadConnection(s).mode).toBe('local')
    s.setItem(SYNC_STORAGE_KEY, 'null')
    expect(loadConnection(s)).toEqual(emptyConnection())
  })

  it('round-trips through storage', () => {
    const s = memoryStorage()
    const state: ConnectionState = {
      ...emptyConnection(),
      mode: 'server',
      workspaceId: 'default',
      seq: 42,
      versions: { 'people:p-1': 3, '$doc:company': 1 },
      outbox: [
        { collection: 'people', id: 'p-1', op: 'upsert', rev: 7, at: 1000 },
        { collection: 'people', id: 'p-2', op: 'upsert', rev: 8, at: 1000, data: { id: 'p-2' }, fixed: true },
        { collection: 'people', id: 'p-3', op: 'delete', rev: 9, at: 1000, fixed: true },
      ],
      rejected: [{ collection: 'jobs', id: 'j-1', op: 'delete', rev: 2, at: 900, reason: 'too_large' }],
      lastSyncAt: '2026-10-10T12:00:00.000Z',
      user: { id: 'u1', email: 'a@example.test', role: 'admin' },
      sampleAllowed: true,
      hold: 'replaced',
      unconfirmed: { 'people:p-1': { baseVersion: 3, prints: ['a.1', 'b.2'] }, 'people:p-9': { baseVersion: null, prints: ['delete'] } },
      schema: SYNC_SCHEMA,
      storeMark: 4,
    }
    expect(saveConnection(s, state)).toBe(true)
    expect(loadConnection(s)).toEqual(state)
    writeStoreMark(s, 4)
    expect(readStoreMark(s)).toBe(4)
    clearConnection(s)
    expect(s.data.has(SYNC_STORAGE_KEY)).toBe(false)
    expect(s.data.has(SYNC_MARK_KEY)).toBe(false)
    expect(readStoreMark(s)).toBe(0)
  })

  it('keeps only keys for entries that are not fixed (older saves carried copies)', () => {
    const s = memoryStorage()
    s.setItem(
      SYNC_STORAGE_KEY,
      JSON.stringify({ ...emptyConnection(), mode: 'server', outbox: [{ collection: 'people', id: 'p-1', op: 'upsert', data: { id: 'p-1', title: 'Old copy' }, rev: 1, at: 1 }] }),
    )
    expect(loadConnection(s).outbox).toEqual([{ collection: 'people', id: 'p-1', op: 'upsert', rev: 1, at: 1 }])
  })

  it('drops malformed fields one by one instead of failing', () => {
    const s = memoryStorage()
    s.setItem(
      SYNC_STORAGE_KEY,
      JSON.stringify({
        v: 1,
        mode: 'server',
        seq: -5,
        versions: { 'people:p-1': 2, bad: 'x' },
        outbox: [
          { collection: 'people', id: 'p-1', op: 'upsert', data: {}, rev: 1, at: 1 },
          { collection: 'people' },
          { collection: 'people', id: 'p-2', op: 'upsert', rev: 2, at: 2 },
          { collection: 'people', id: 'p-3', op: 'upsert', rev: 3, at: 3, fixed: true },
        ],
        user: { id: 1 },
        hold: 'nope',
        unconfirmed: { 'people:p-1': { baseVersion: 'x', prints: ['a'] }, 'people:p-2': { baseVersion: 1, prints: [] }, 'people:p-3': { baseVersion: 1, prints: ['a', 5] } },
        schema: 7,
        storeMark: -1,
      }),
    )
    const c = loadConnection(s)
    expect(c.mode).toBe('server')
    expect(c.seq).toBe(0)
    expect(c.versions).toEqual({ 'people:p-1': 2 })
    // A fixed upsert without its data cannot be sent; plain entries never carry data.
    expect(c.outbox.map((e) => e.id)).toEqual(['p-1', 'p-2'])
    expect(c.user).toBeNull()
    expect(c.hold).toBeNull()
    expect(c.unconfirmed).toEqual({ 'people:p-3': { baseVersion: 1, prints: ['a'] } })
    expect(c.schema).toBeNull()
    expect(c.storeMark).toBe(0)
  })

  it('maxRev counts outbox and rejected entries', () => {
    expect(maxRev(emptyConnection())).toBe(0)
    expect(
      maxRev({
        ...emptyConnection(),
        outbox: [{ collection: 'people', id: 'a', op: 'delete', rev: 4, at: 0 }],
        rejected: [{ collection: 'people', id: 'b', op: 'delete', rev: 9, at: 0, reason: 'x' }],
      }),
    ).toBe(9)
  })
})

describe('enqueueChanges (outbox coalescing)', () => {
  let rev = 0
  const opts = (known: string[] = []) => ({ isKnown: (k: string) => known.includes(k), nextRev: () => ++rev, now: 5 })
  const up = (id: string, data: Record<string, unknown> = {}): LocalChange => ({ collection: 'people', id, op: 'upsert', data: { id, ...data } })
  const del = (id: string): LocalChange => ({ collection: 'people', id, op: 'delete' })
  const view = (o: OutboxEntry[]) => o.map((e) => `${e.op}:${e.id}`)

  it('keeps one entry per record (keys only): the last write wins, in place', () => {
    let o = enqueueChanges([], [up('a', { v: 1 }), up('b', { v: 1 })], opts())
    const firstRev = o[0].rev
    o = enqueueChanges(o, [up('a', { v: 2 })], opts())
    expect(view(o)).toEqual(['upsert:a', 'upsert:b'])
    expect(o[0].rev).toBeGreaterThan(firstRev)
    expect(o[0].at).toBe(5)
    // The data is read from the store when the push goes out.
    expect(o.every((e) => !('data' in e) && !e.fixed)).toBe(true)
  })

  it('drops a never-synced record that is deleted before it was sent', () => {
    let o = enqueueChanges([], [up('a'), up('b')], opts())
    o = enqueueChanges(o, [del('a')], opts())
    expect(view(o)).toEqual(['upsert:b'])
    // A delete of something the server never had sends nothing at all.
    expect(enqueueChanges([], [del('zzz')], opts())).toEqual([])
  })

  it('turns an edit of a synced record into a delete when it is deleted', () => {
    let o = enqueueChanges([], [up('a', { v: 1 })], opts(['people:a']))
    o = enqueueChanges(o, [del('a')], opts(['people:a']))
    expect(view(o)).toEqual(['delete:a'])
  })

  it('keeps a delete when a push carrying the new record is in flight', () => {
    const o = enqueueChanges([{ collection: 'people', id: 'a', op: 'upsert', rev: 1, at: 0 }], [del('a')], opts(['people:a']))
    expect(view(o)).toEqual(['delete:a'])
  })

  it('turns a delete followed by an upsert into an upsert', () => {
    let o = enqueueChanges([], [del('a')], opts(['people:a']))
    o = enqueueChanges(o, [up('a', { v: 3 })], opts(['people:a']))
    expect(view(o)).toEqual(['upsert:a'])
  })

  it('appends a record re-added after its entry was dropped', () => {
    let o = enqueueChanges([], [up('a'), up('b')], opts())
    o = enqueueChanges(o, [del('a'), up('a', { v: 9 })], opts())
    expect(view(o)).toEqual(['upsert:b', 'upsert:a'])
  })

  it('keys by collection and id, and never mutates its input', () => {
    const start = enqueueChanges([], [up('a')], opts())
    const frozen = Object.freeze([...start])
    const o = enqueueChanges(frozen, [{ collection: 'jobs', id: 'a', op: 'upsert', data: { id: 'a' } }], opts())
    expect(frozen).toHaveLength(1)
    expect(o.map((e) => recordKey(e.collection, e.id))).toEqual(['people:a', 'jobs:a'])
  })
})
