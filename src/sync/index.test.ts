import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { setClockOverride } from '@/lib/dates'
import type { ClientChange } from './protocol'
import { emptyConnection, loadConnection, SYNC_SCHEMA, SYNC_STORAGE_KEY, saveConnection } from './state'
import { makeDB, makePerson, memoryStorage } from './testing/kit'

// initSync wires the real store, the real fetch client and localStorage. Each test loads fresh modules
// against stubbed browser globals.
const DB_KEY = 'first-twenty:db:v1'
const fakeWindow = { addEventListener: () => {}, removeEventListener: () => {} }

beforeAll(() => setClockOverride('2026-10-10'))
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('initSync', () => {
  it('does nothing outside a browser', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const { initSync, useSyncStatus } = await import('./index')
    initSync()
    await new Promise((r) => setTimeout(r, 0))
    expect(fetch).not.toHaveBeenCalled()
    expect(useSyncStatus.getState().status).toBe('local')
  })

  it('does nothing in a local-only install', async () => {
    const storage = memoryStorage()
    storage.setItem(DB_KEY, JSON.stringify(makeDB()))
    const fetch = vi.fn()
    vi.stubGlobal('window', fakeWindow)
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('fetch', fetch)
    const { initSync, useSyncStatus } = await import('./index')
    initSync()
    await new Promise((r) => setTimeout(r, 0))
    expect(fetch).not.toHaveBeenCalled()
    expect(useSyncStatus.getState()).toMatchObject({ status: 'local', mode: 'local' })
    expect(storage.data.has(SYNC_STORAGE_KEY)).toBe(false)
  })

  it('starts the saved server connection with same-origin requests', async () => {
    const storage = memoryStorage()
    storage.setItem(DB_KEY, JSON.stringify(makeDB()))
    saveConnection(storage, { ...emptyConnection(), mode: 'server', seq: 4, workspaceId: 'default', schema: SYNC_SCHEMA })
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('window', fakeWindow)
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('fetch', fetch)
    const { initSync, useSyncStatus, getSyncEngine } = await import('./index')
    initSync()
    await getSyncEngine().whenIdle()
    expect(fetch).toHaveBeenCalledWith('/api/changes?since=4', expect.objectContaining({ method: 'GET', credentials: 'same-origin' }))
    expect(useSyncStatus.getState()).toMatchObject({ status: 'signed_out', mode: 'server' })
    getSyncEngine().stop()
  })

  it('a connection saved by a build with another collection list starts from the server snapshot (F9)', async () => {
    const storage = memoryStorage()
    storage.setItem(DB_KEY, JSON.stringify(makeDB()))
    saveConnection(storage, { ...emptyConnection(), mode: 'server', seq: 4, workspaceId: 'default', schema: 'an-older-build' })
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('window', fakeWindow)
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('fetch', fetch)
    const { initSync, getSyncEngine } = await import('./index')
    initSync()
    await getSyncEngine().whenIdle()
    expect((fetch.mock.calls[0] as unknown[])[0]).toBe('/api/workspace')
    getSyncEngine().stop()
  })

  it('queues effective-dated changes db.ts applied on load, and saves them so a reload does not apply them again (F5)', async () => {
    const storage = memoryStorage()
    const saved = makeDB()
    saved.people.push(makePerson('p-1', { title: 'Engineer' }))
    saved.comp.push({ id: 'c-1', personId: 'p-1', effectiveOn: '2026-10-01', payType: 'salary', salary: 150000, title: 'Senior engineer', levelId: 'lv-l4', reason: 'promotion', scheduled: true })
    storage.setItem(DB_KEY, JSON.stringify(saved))
    saveConnection(storage, { ...emptyConnection(), mode: 'server', seq: 4, workspaceId: 'default', schema: SYNC_SCHEMA, versions: { 'people:p-1': 1, 'comp:c-1': 1 } })
    const pushed: ClientChange[] = []
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/changes') && init?.method === 'POST') {
        const { changes } = JSON.parse(String(init.body)) as { changes: ClientChange[] }
        pushed.push(...changes)
        return json({ seq: 5, applied: changes.map((c) => ({ collection: c.collection, id: c.id, version: (c.baseVersion ?? 0) + 1 })), conflicts: [] })
      }
      if (url.startsWith('/api/changes')) return json({ seq: 5, changes: [] })
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('window', fakeWindow)
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('fetch', fetch)
    // The modules load fresh, and prefs.ts resets their clock override on load: fix the date itself
    // (only Date, so the engine's timers still run) before the store reads today().
    vi.useFakeTimers({ now: new Date('2026-10-10T17:00:00.000Z'), toFake: ['Date'] })
    const { initSync, getSyncEngine } = await import('./index')
    const { useDB } = await import('@/store/db')
    // db.ts applied the promotion while loading, before the engine existed.
    expect(useDB.getState().db.people.find((p) => p.id === 'p-1')?.title).toBe('Senior engineer')
    initSync()
    await getSyncEngine().whenIdle()
    const byKey = new Map(pushed.map((c) => [`${c.collection}:${c.id}`, c]))
    expect((byKey.get('people:p-1')?.data as { title: string }).title).toBe('Senior engineer')
    expect((byKey.get('comp:c-1')?.data as { appliedOn: string }).appliedOn).toBe('2026-10-10')
    const rows = pushed.filter((c) => c.collection === 'activity')
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toMatch(/^act-auto-/)
    expect(useDB.getState().db.activity.some((a) => a.id === rows[0].id)).toBe(true)
    // The engine saved the store, so the next load starts from the applied copy.
    const stored = JSON.parse(storage.getItem(DB_KEY) ?? '{}') as ReturnType<typeof makeDB>
    expect(stored.comp.find((c) => c.id === 'c-1')?.appliedOn).toBe('2026-10-10')
    expect(loadConnection(storage).outbox).toEqual([])
    getSyncEngine().stop()
  })
})

describe('wipeAppStorage', () => {
  it('removes every key of this app and nothing else', async () => {
    const data = new Map<string, string>([
      ['first-twenty:db:v1', '{}'],
      ['first-twenty:sync:v1', '{}'],
      ['first-twenty:prefs:v1', '{}'],
      ['another-app', 'keep'],
    ])
    const storage = {
      get length() {
        return data.size
      },
      key: (i: number) => [...data.keys()][i] ?? null,
      removeItem: (k: string) => void data.delete(k),
    }
    const { wipeAppStorage } = await import('./index')
    wipeAppStorage(storage)
    expect([...data.keys()]).toEqual(['another-app'])
    expect(() =>
      wipeAppStorage({
        get length(): number {
          throw new Error('blocked')
        },
        key: () => null,
        removeItem: () => {},
      }),
    ).not.toThrow()
  })
})

describe('a notice across a reload (r3-10)', () => {
  it('is read once, from sessionStorage, so removing this browser\'s data does not clear it', async () => {
    const session = memoryStorage()
    const { leaveReloadNotice, RELOAD_NOTICE_KEY, takeReloadNotice, wipeAppStorage } = await import('./index')
    expect(RELOAD_NOTICE_KEY.startsWith('first-twenty:')).toBe(false)
    leaveReloadNotice('Signed out and removed this browser\'s data.', session)
    wipeAppStorage(null)
    expect(takeReloadNotice(session)).toBe('Signed out and removed this browser\'s data.')
    expect(takeReloadNotice(session)).toBeNull()
    expect(session.data.size).toBe(0)
  })

  it('a browser whose storage throws shows no notice and never fails', async () => {
    const blocked = {
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
    const { leaveReloadNotice, takeReloadNotice } = await import('./index')
    expect(() => leaveReloadNotice('x', blocked)).not.toThrow()
    expect(takeReloadNotice(blocked)).toBeNull()
    expect(takeReloadNotice(null)).toBeNull()
    // No sessionStorage at all (outside a browser): nothing to read.
    expect(takeReloadNotice()).toBeNull()
  })
})

describe('other tabs (F3)', () => {
  it('tells a removed workspace from a disconnect from other changes', async () => {
    const { storageChangeAction } = await import('./index')
    expect(storageChangeAction({ key: DB_KEY, newValue: null })).toBe('forget')
    // storage.clear() from another page on a shared origin: this tab's copy may be the last one.
    expect(storageChangeAction({ key: null, newValue: null })).toBeNull()
    expect(storageChangeAction({ key: SYNC_STORAGE_KEY, newValue: null })).toBe('disconnect')
    expect(storageChangeAction({ key: DB_KEY, newValue: '{}' })).toBeNull()
    expect(storageChangeAction({ key: SYNC_STORAGE_KEY, newValue: '{}' })).toBeNull()
    expect(storageChangeAction({ key: 'first-twenty:prefs:v1', newValue: null })).toBeNull()
  })

  it('when another tab removes this browser\'s data, this tab drops its copy and writes nothing back', async () => {
    const mem = memoryStorage()
    const storage = {
      ...mem,
      get length() {
        return mem.data.size
      },
      key: (i: number) => [...mem.data.keys()][i] ?? null,
    }
    const acme = makeDB({ company: 'Acme Review Co' })
    acme.people.push(makePerson('p-1'))
    storage.setItem(DB_KEY, JSON.stringify(acme))
    saveConnection(storage, { ...emptyConnection(), mode: 'server', seq: 4, workspaceId: 'default', schema: SYNC_SCHEMA, user: { id: 'u', email: 'reviewer@example.test', role: 'admin' } })
    const listeners: Record<string, Array<(e: unknown) => void>> = {}
    const reload = vi.fn()
    const win = {
      addEventListener: (type: string, fn: (e: unknown) => void) => void (listeners[type] ??= []).push(fn),
      removeEventListener: () => {},
      location: { reload },
    }
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    const fetch = vi.fn(async () => json({ historyId: 'h-1', seq: 4, changes: [] }))
    vi.stubGlobal('window', win)
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('fetch', fetch)
    const { initSync, getSyncEngine, useSyncStatus } = await import('./index')
    const { useDB } = await import('@/store/db')
    initSync()
    await getSyncEngine().whenIdle()
    expect(useDB.getState().db.company.name).toBe('Acme Review Co')
    // The other tab: Sign out and remove data (its logout succeeded, then it wiped this origin's keys).
    storage.setItem('first-twenty:logout-pending', '1')
    storage.data.delete(SYNC_STORAGE_KEY)
    storage.data.delete(DB_KEY)
    for (const fn of listeners.storage ?? []) fn({ key: DB_KEY, newValue: null, storageArea: storage })
    expect(reload).toHaveBeenCalledOnce()
    expect(useDB.getState().db.company.name).not.toBe('Acme Review Co')
    expect(useDB.getState().db.meta.sample).toBe(true)
    expect(useSyncStatus.getState()).toMatchObject({ mode: 'local', user: null })
    // An edit in this tab before the reload lands: the store's own save writes only the sample.
    useDB.getState().mutate('Add a department', (d) => {
      d.departments.push({ id: 'd-new', name: 'New' } as (typeof d.departments)[number])
    })
    await new Promise((r) => setTimeout(r, 450))
    expect(storage.data.has(SYNC_STORAGE_KEY)).toBe(false)
    const stored = storage.getItem(DB_KEY)
    if (stored) expect((JSON.parse(stored) as ReturnType<typeof makeDB>).company.name).not.toBe('Acme Review Co')
    // A pending sign-out written by the other tab survives.
    expect(storage.getItem('first-twenty:logout-pending')).toBe('1')
  })
})

describe('a sign-out the server did not confirm (security F1)', () => {
  it('initSync ends it first, even in a browser that is local only now', async () => {
    const storage = memoryStorage()
    storage.setItem(DB_KEY, JSON.stringify(makeDB({ sample: true })))
    storage.setItem('first-twenty:logout-pending', '1')
    const fetch = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('window', fakeWindow)
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('fetch', fetch)
    const { initSync, getSyncEngine, useSyncStatus } = await import('./index')
    initSync()
    await getSyncEngine().endPendingSession()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }))
    expect(storage.data.has('first-twenty:logout-pending')).toBe(false)
    expect(useSyncStatus.getState()).toMatchObject({ mode: 'local', logoutPending: false })
    getSyncEngine().stop()
  })
})
