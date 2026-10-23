import type { Draft } from 'immer'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DB } from '@/domain/types'
import { setClockOverride } from '@/lib/dates'
import { useDB } from '@/store/db'
import type { SyncApi } from './api'
import { diffDB } from './diff'
import {
  createSyncEngine,
  DEBOUNCE_MS,
  type EngineOptions,
  FORGOTTEN_MESSAGE,
  MAX_REFUSALS_IN_A_ROW,
  STORAGE_FULL_MESSAGE,
  type SyncEngine,
} from './engine'
import { applyLoadChanges } from './index'
import { workspaceIdOf } from './loadTime'
import { CLOCK_COPY_KEY, emptyConnection, LOGOUT_PENDING_KEY, loadConnection, SYNC_SCHEMA, SYNC_STORAGE_KEY, saveConnection } from './state'
import { deviceLink, FakeServer, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from './testing/fakeServer'
import { createStatusStore, createTestStore, makeDB, makePerson, memoryStorage, prng, testEnv } from './testing/kit'

const cleanups: Array<() => void> = []

beforeAll(() => setClockOverride('2026-10-10'))
beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-10T17:00:00.000Z') })
})
afterEach(() => {
  for (const stop of cleanups.splice(0)) stop()
  vi.useRealTimers()
})

type Recipe = (d: Draft<DB>) => void

/** A browser: its own store, page, status store, storage and engine, on a shared (fake) server. */
function device(api: SyncApi, db: DB = makeDB(), storage = memoryStorage(), extra: Partial<EngineOptions> = {}) {
  const store = createTestStore(db)
  const page = testEnv()
  const status = createStatusStore()
  const engine = createSyncEngine({ store, api, storage, env: page.env, status, ...extra })
  cleanups.push(() => engine.stop())
  return {
    store,
    page,
    status,
    storage,
    engine,
    mutate: (recipe: Recipe) => store.getState().mutate('Edit', recipe),
    db: () => store.getState().db,
    conn: () => engine.getConnection(),
    st: () => status.getState(),
  }
}
type Device = ReturnType<typeof device>

/** A workspace with two extra people, uploaded by this device. */
async function uploader(server: FakeServer, api: SyncApi = server): Promise<Device> {
  const db = makeDB()
  db.people.push(makePerson('p-1'), makePerson('p-2'), makePerson('p-3'))
  const d = device(api, db)
  expect(await d.engine.uploadLocal()).toEqual({ ok: true })
  await d.engine.whenIdle()
  return d
}

/** A second browser that takes the server's copy. */
async function joiner(server: FakeServer, api: SyncApi = server): Promise<Device> {
  const d = device(api, makeDB({ company: 'Elsewhere' }))
  expect(await d.engine.useServerCopy()).toEqual({ ok: true })
  await d.engine.whenIdle()
  return d
}

const rename = (id: string, title: string): Recipe => (d) => {
  d.people.find((p) => p.id === id)!.title = title
}
const remove = (id: string): Recipe => (d) => {
  d.people = d.people.filter((p) => p.id !== id)
}
const add = (id: string, title = 'Engineer'): Recipe => (d) => {
  d.people.push(makePerson(id, { title }))
}
const titleOf = (dev: Device, id: string) => dev.db().people.find((p) => p.id === id)?.title
const serverTitle = (server: FakeServer, id: string) => (server.record('people', id) as { title?: string } | undefined)?.title

/** Lets the debounce fire and waits for the push and pull to finish. */
async function quiet(...devices: Device[]): Promise<void> {
  await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
  for (const d of devices) await d.engine.whenIdle()
}

describe('connecting', () => {
  it('uploads this browser\'s workspace and starts syncing', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    expect(diffDB(a.db(), server.snapshot())).toEqual([])
    expect(a.conn().mode).toBe('server')
    // Versions are the server's own (workspace-wide seqs), whatever their numbers.
    expect(a.conn().versions).toEqual(server.versions())
    expect(a.conn().versions['people:p-1']).toBeGreaterThan(0)
    expect(a.st()).toMatchObject({ status: 'synced', mode: 'server', pending: 0, hold: null })
    expect(loadConnection(a.storage).mode).toBe('server')
  })

  it('needs confirmReplace before replacing a server that has data', async () => {
    const server = new FakeServer()
    await uploader(server)
    const b = device(server, makeDB({ company: 'Replacement' }))
    const refused = await b.engine.uploadLocal()
    expect(refused).toMatchObject({ ok: false, kind: 'not_empty' })
    expect(b.conn().mode).toBe('local')
    expect(await b.engine.uploadLocal({ confirmReplace: true })).toEqual({ ok: true })
    expect(server.snapshot().company.name).toBe('Replacement')
  })

  it('takes the server\'s copy, clearing Undo history, and reuses an inspected snapshot', async () => {
    const server = new FakeServer()
    await uploader(server)
    const b = device(server, makeDB({ company: 'Elsewhere' }))
    b.mutate(add('p-local'))
    expect(b.store.getState().past).toHaveLength(1)
    const look = await b.engine.inspectServer()
    expect(look).toMatchObject({ ok: true, empty: false, sample: false, companyName: 'Acme', counts: { people: 4, candidates: 0, jobs: 0 } })
    expect(await b.engine.useServerCopy()).toEqual({ ok: true })
    expect(server.callCount('getWorkspace')).toBe(1)
    expect(diffDB(b.db(), server.snapshot())).toEqual([])
    expect(b.store.getState().past).toEqual([])
    expect(b.conn()).toMatchObject({ mode: 'server', outbox: [], seq: server.seq })
    await b.engine.whenIdle()
    expect(b.st().status).toBe('synced')
  })

  it('reports an empty server', async () => {
    const server = new FakeServer()
    const b = device(server)
    expect(await b.engine.inspectServer()).toEqual({ ok: true, empty: true })
    expect(await b.engine.useServerCopy()).toMatchObject({ ok: false, kind: 'empty' })
  })

  it('checks the server and signs in', async () => {
    const server = new FakeServer()
    server.signedIn = false
    const b = device(server)
    expect(await b.engine.checkServer()).toEqual({ ok: true, version: 'test', signedIn: false, user: null })
    // Asked the way that answers "nobody" without a 401 (r2-48).
    expect(server.calls).toEqual(['health', 'session'])
    const wrong = await b.engine.signIn(TEST_ADMIN_EMAIL, 'nope')
    expect(wrong).toMatchObject({ ok: false, kind: 'invalid_credentials' })
    if (!wrong.ok) expect(wrong.message).toMatch(/email and password/)
    expect(await b.engine.signIn(`  ${TEST_ADMIN_EMAIL.toUpperCase()} `, TEST_ADMIN_PASSWORD)).toMatchObject({ ok: true, user: { email: TEST_ADMIN_EMAIL } })
    expect(await b.engine.checkServer()).toMatchObject({ ok: true, signedIn: true })
    expect(b.conn().user?.email).toBe(TEST_ADMIN_EMAIL)
    server.online = false
    expect(await b.engine.checkServer()).toMatchObject({ ok: false, kind: 'offline' })
  })

  it('passes "Keep me signed in" to the server, off unless asked', async () => {
    const server = new FakeServer()
    server.signedIn = false
    const seen: Array<boolean | undefined> = []
    const link = deviceLink(server)
    const api: SyncApi = {
      ...link,
      login: (email, password, opts) => {
        seen.push(opts?.remember)
        return server.login(email, password)
      },
    }
    const b = device(api)
    await b.engine.signIn(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)
    await b.engine.signIn(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD, { remember: true })
    expect(seen).toEqual([false, true])
  })
})

describe('pushing', () => {
  it('pushes after 800 ms of quiet, one entry per record', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const before = server.pushes.length
    const base = a.conn().versions['people:p-1']
    a.mutate(rename('p-1', 'A'))
    await vi.advanceTimersByTimeAsync(400)
    a.mutate(rename('p-1', 'B'))
    await vi.advanceTimersByTimeAsync(400)
    a.mutate(rename('p-1', 'C'))
    expect(a.st()).toMatchObject({ status: 'syncing', pending: 1 })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1)
    expect(server.pushes.length).toBe(before)
    await vi.advanceTimersByTimeAsync(1)
    await a.engine.whenIdle()
    expect(server.pushes.slice(before)).toEqual([
      [{ collection: 'people', id: 'p-1', op: 'upsert', data: JSON.parse(JSON.stringify(a.db().people.find((p) => p.id === 'p-1'))), baseVersion: base }],
    ])
    expect(serverTitle(server, 'p-1')).toBe('C')
    expect(a.conn().versions['people:p-1']).toBe(server.seq)
    expect(a.st()).toMatchObject({ status: 'synced', pending: 0 })
  })

  it('sends adds, deletes and document edits', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    a.mutate((d) => {
      d.people.push(makePerson('p-9'))
      d.people = d.people.filter((p) => p.id !== 'p-2')
      d.company.name = 'Acme Two'
    })
    await quiet(a)
    expect(server.record('people', 'p-9')).toBeTruthy()
    expect(server.record('people', 'p-2')).toBeUndefined()
    expect(server.snapshot().company.name).toBe('Acme Two')
    expect(a.conn().versions['people:p-2']).toBeUndefined()
    expect(a.conn().versions['people:p-9']).toBe(server.versions()['people:p-9'])
    expect(a.conn().versions['$doc:company']).toBe(server.versions()['$doc:company'])
    expect(a.conn().versions).toEqual(server.versions())
  })

  it('queues while offline, retries with backoff from 2 s to 60 s, and catches up', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    server.online = false
    a.mutate(rename('p-1', 'Offline 1'))
    await quiet(a)
    expect(a.st()).toMatchObject({ status: 'offline', pending: 1 })
    expect(a.st().lastError).toMatch(/Cannot reach the server/)
    expect(a.st().nextRetryAt).toBe(Date.now() + 2000)
    // More edits while backing off wait for the retry instead of hammering the server.
    a.mutate(rename('p-2', 'Offline 2'))
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(server.timesOf('postChanges')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2000 + 4000 + 8000 + 16000 + 32000 + 60000 + 60000)
    const times = server.timesOf('postChanges')
    const gaps = times.slice(1).map((t, i) => t - times[i])
    expect(gaps).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000])
    expect(a.st().pending).toBe(2)
    server.online = true
    await vi.advanceTimersByTimeAsync(60000)
    await a.engine.whenIdle()
    expect(serverTitle(server, 'p-1')).toBe('Offline 1')
    expect(serverTitle(server, 'p-2')).toBe('Offline 2')
    expect(a.st()).toMatchObject({ status: 'synced', pending: 0, lastError: null, nextRetryAt: null })
  })

  it('retries at once when the browser comes back online', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    server.online = false
    a.mutate(rename('p-1', 'Later'))
    await quiet(a)
    expect(a.st().status).toBe('offline')
    server.online = true
    a.page.emit('online')
    await a.engine.whenIdle()
    expect(serverTitle(server, 'p-1')).toBe('Later')
    expect(a.st().status).toBe('synced')
  })

  it('keeps the outbox across a reload', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    server.online = false
    a.mutate(rename('p-3', 'Saved for later'))
    await quiet(a)
    a.engine.stop()
    expect(loadConnection(a.storage).outbox).toHaveLength(1)
    server.online = true
    // The reloaded page: same saved DB and connection, a new engine.
    const reloaded = createSyncEngine({ store: a.store, api: server, storage: a.storage, env: testEnv().env, status: createStatusStore() })
    cleanups.push(() => reloaded.stop())
    reloaded.start()
    await reloaded.whenIdle()
    expect(serverTitle(server, 'p-3')).toBe('Saved for later')
    expect(reloaded.getConnection().outbox).toEqual([])
  })

  it('flushes right away with keepalive when the page is hidden or closed', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    a.mutate(rename('p-1', 'Hidden'))
    a.page.setVisible(false)
    await a.engine.whenIdle()
    expect(server.keepalivePushes).toBe(1)
    expect(serverTitle(server, 'p-1')).toBe('Hidden')
    a.page.setVisible(true)
    await a.engine.whenIdle()
    a.mutate(rename('p-1', 'Closed'))
    a.page.emit('pagehide')
    await a.engine.whenIdle()
    expect(server.keepalivePushes).toBe(2)
    expect(serverTitle(server, 'p-1')).toBe('Closed')
  })

  it('sends a large outbox in batches, keeping keepalive bodies small', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    a.mutate((d) => {
      for (let i = 0; i < 2500; i++) d.people.push(makePerson(`p-bulk-${i}`))
    })
    a.page.setVisible(false)
    await a.engine.whenIdle()
    const sizes = server.pushes.slice(-4).map((b) => b.length)
    expect(JSON.stringify(server.pushes[server.pushes.length - sizes.length]).length).toBeLessThan(64 * 1024)
    expect(sizes.every((n) => n <= 2000)).toBe(true)
    expect(server.snapshot().people).toHaveLength(4 + 2500)
    expect(a.st().pending).toBe(0)
  })

  it('sets aside a change the server refuses and still syncs the rest', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    server.refuseIds.add('p-bad')
    a.mutate((d) => {
      d.people.push(makePerson('p-ok'), makePerson('p-bad'))
      d.people.find((p) => p.id === 'p-1')!.title = 'Fine'
    })
    await quiet(a)
    expect(server.record('people', 'p-ok')).toBeTruthy()
    expect(serverTitle(server, 'p-1')).toBe('Fine')
    expect(server.record('people', 'p-bad')).toBeUndefined()
    expect(a.conn().rejected.map((r) => r.id)).toEqual(['p-bad'])
    expect(a.st()).toMatchObject({ status: 'synced', rejected: 1, pending: 0 })
    server.refuseIds.clear()
    a.engine.retryRejected()
    await quiet(a)
    expect(server.record('people', 'p-bad')).toBeTruthy()
    expect(a.st().rejected).toBe(0)
  })

  it('never sends a record larger than the server accepts', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const before = server.pushes.length
    a.mutate((d) => {
      d.people.find((p) => p.id === 'p-2')!.notes = 'x'.repeat(300 * 1024)
    })
    await quiet(a)
    expect(server.pushes.length).toBe(before)
    expect(a.conn().rejected).toMatchObject([{ id: 'p-2', reason: 'too_large' }])
  })
})

describe('pulling', () => {
  it('applies other devices\' changes with no Undo step and no echo push', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const b = await joiner(server)
    a.mutate(rename('p-3', 'Mine'))
    await quiet(a, b)
    const pastBefore = a.store.getState().past.length
    b.mutate(rename('p-1', 'From B'))
    await quiet(a, b)
    const pushesBefore = server.pushes.length
    a.page.emit('focus')
    await a.engine.whenIdle()
    expect(titleOf(a, 'p-1')).toBe('From B')
    expect(a.store.getState().past).toHaveLength(pastBefore)
    // The Undo snapshot was rebased too, so undoing "Mine" keeps B's change.
    expect(a.store.getState().past[pastBefore - 1].db.people.find((p) => p.id === 'p-1')?.title).toBe('From B')
    await vi.advanceTimersByTimeAsync(5000)
    expect(server.pushes.length).toBe(pushesBefore)
    expect(a.conn().outbox).toEqual([])
    expect(a.conn().seq).toBe(server.seq)
  })

  it('skips its own changes when they come back in a pull', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    a.mutate(rename('p-2', 'Echo'))
    const mine = a.db()
    await quiet(a)
    expect(server.log.some((c) => c.id === 'p-2')).toBe(true)
    expect(a.db()).toBe(mine)
    a.page.emit('focus')
    await a.engine.whenIdle()
    expect(a.db()).toBe(mine)
  })

  it('pulls every 30 s while visible, on focus and when shown again, never while hidden', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const pulls = () => server.callCount('getChanges')
    const start = pulls()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(pulls()).toBe(start + 1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(pulls()).toBe(start + 2)
    a.page.setVisible(false)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(pulls()).toBe(start + 2)
    a.page.setVisible(true)
    await a.engine.whenIdle()
    expect(pulls()).toBe(start + 3)
    a.page.emit('focus')
    await a.engine.whenIdle()
    expect(pulls()).toBe(start + 4)
  })

  it('follows paged change lists to the end', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const b = await joiner(server)
    server.pageSize = 2
    for (let i = 0; i < 5; i++) server.serverUpsert('people', `p-remote-${i}`, makePerson(`p-remote-${i}`))
    await b.engine.syncNow()
    expect(b.db().people.filter((p) => p.id.startsWith('p-remote-'))).toHaveLength(5)
    expect(b.conn().seq).toBe(server.seq)
    expect(a.db().people.some((p) => p.id.startsWith('p-remote-'))).toBe(false)
  })

  it('applies remote deletes and document changes', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    server.serverDelete('people', 'p-2')
    server.serverUpsert('$doc', 'company', { ...server.snapshot().company, name: 'Renamed elsewhere' })
    await a.engine.syncNow()
    expect(a.db().people.some((p) => p.id === 'p-2')).toBe(false)
    expect(a.db().company.name).toBe('Renamed elsewhere')
    expect(a.conn().versions['people:p-2']).toBeUndefined()
  })
})

describe('conflicts', () => {
  it('lets the server win and reports how many items were refreshed', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const b = await joiner(server)
    b.mutate(rename('p-1', 'B wins'))
    await quiet(a, b)
    a.mutate(rename('p-1', 'A loses'))
    await quiet(a, b)
    expect(titleOf(a, 'p-1')).toBe('B wins')
    expect(serverTitle(server, 'p-1')).toBe('B wins')
    expect(a.st().refreshed).toBe(1)
    expect(a.conn().outbox).toEqual([])
    expect(a.conn().versions['people:p-1']).toBe(server.versions()['people:p-1'])
    a.engine.clearRefreshed()
    expect(a.st().refreshed).toBe(0)
  })

  it('brings back a record whose delete lost to a newer edit', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const b = await joiner(server)
    b.mutate(rename('p-2', 'Still here'))
    await quiet(a, b)
    a.mutate(remove('p-2'))
    await quiet(a, b)
    expect(titleOf(a, 'p-2')).toBe('Still here')
    expect(a.st().refreshed).toBe(1)
  })

  it('does not let a pull overwrite an edit made while it was in flight; the push then settles it', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const b = await joiner(server)
    b.mutate(rename('p-1', 'Remote'))
    await quiet(a, b)
    server.onGetChanges = () => {
      server.onGetChanges = null
      a.mutate(rename('p-1', 'Typed during pull'))
    }
    a.page.emit('focus')
    await a.engine.whenIdle()
    expect(titleOf(a, 'p-1')).toBe('Typed during pull')
    expect(a.st().pending).toBe(1)
    await quiet(a)
    expect(titleOf(a, 'p-1')).toBe('Remote')
    expect(a.st()).toMatchObject({ refreshed: 1, pending: 0 })
  })

  it('a record edited again while its push is in flight goes out once more on the new version', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    let typed = false
    const realPost = server.postChanges.bind(server)
    server.postChanges = async (changes, opts) => {
      const res = await realPost(changes, opts)
      if (!typed) {
        typed = true
        a.mutate(rename('p-1', 'Second'))
      }
      return res
    }
    const before = server.pushes.length
    const base = a.conn().versions['people:p-1']
    a.mutate(rename('p-1', 'First'))
    const first = server.seq + 1
    await quiet(a)
    // The same push loop sends the newer edit right after, on top of the version the first one got.
    expect(server.pushes.slice(before).map((b) => b.map((c) => [c.id, (c.data as { title: string }).title, c.baseVersion]))).toEqual([
      [['p-1', 'First', base]],
      [['p-1', 'Second', first]],
    ])
    expect(serverTitle(server, 'p-1')).toBe('Second')
    expect(a.st()).toMatchObject({ pending: 0, refreshed: 0 })
  })

  it('a new record deleted while its push is in flight is deleted on the server too', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    let deleted = false
    const realPost = server.postChanges.bind(server)
    server.postChanges = async (changes, opts) => {
      const res = await realPost(changes, opts)
      if (!deleted) {
        deleted = true
        a.mutate(remove('p-new'))
      }
      return res
    }
    a.mutate(add('p-new'))
    await quiet(a)
    await quiet(a)
    expect(server.record('people', 'p-new')).toBeUndefined()
    expect(a.st().pending).toBe(0)
  })
})

describe('resync', () => {
  it('rebuilds from a snapshot when the change log no longer reaches back, keeping queued edits', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const b = await joiner(server)
    a.engine.stop()
    b.mutate((d) => {
      d.people.push(makePerson('p-from-b'))
      d.people = d.people.filter((p) => p.id !== 'p-2')
      d.people.find((p) => p.id === 'p-1')!.title = 'Changed by B'
    })
    await quiet(b)
    server.prune()
    server.onGetWorkspace = () => {
      server.onGetWorkspace = null
      a.mutate(rename('p-3', 'Typed during resync'))
    }
    a.engine.start()
    await a.engine.whenIdle()
    expect(titleOf(a, 'p-1')).toBe('Changed by B')
    expect(a.db().people.some((p) => p.id === 'p-from-b')).toBe(true)
    expect(a.db().people.some((p) => p.id === 'p-2')).toBe(false)
    expect(titleOf(a, 'p-3')).toBe('Typed during resync')
    await quiet(a)
    expect(serverTitle(server, 'p-3')).toBe('Typed during resync')
    expect(diffDB(a.db(), server.snapshot())).toEqual([])
    expect(a.conn().seq).toBe(server.seq)
  })

  it('resyncs after another device replaced the whole workspace', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const other = makeDB({ company: 'Imported' })
    other.people.push(makePerson('p-imported'))
    const b = device(server, other)
    expect(await b.engine.uploadLocal({ confirmReplace: true })).toEqual({ ok: true })
    await a.engine.syncNow()
    expect(a.db().company.name).toBe('Imported')
    expect(diffDB(a.db(), server.snapshot())).toEqual([])
    a.mutate(rename('p-imported', 'Works after replace'))
    await quiet(a)
    expect(serverTitle(server, 'p-imported')).toBe('Works after replace')
  })

  it('holds the connection when the server lost its workspace', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    server.hasWorkspace = false
    server.rows.clear()
    a.mutate(rename('p-1', 'Nowhere to go'))
    await quiet(a)
    expect(a.st()).toMatchObject({ status: 'local', hold: 'server_empty' })
    const calls = server.calls.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(server.calls.length).toBe(calls)
    expect(await a.engine.uploadLocal()).toEqual({ ok: true })
    expect(serverTitle(server, 'p-1')).toBe('Nowhere to go')
    expect(a.st().hold).toBeNull()
  })
})

describe('sessions', () => {
  it('a 401 signs out, keeps queueing, and resumes after sign-in', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    server.signedIn = false
    a.mutate(rename('p-1', 'While signed out'))
    await quiet(a)
    expect(a.st()).toMatchObject({ status: 'signed_out', pending: 1 })
    expect(a.st().lastError).toMatch(/Sign in/)
    const syncCalls = () => server.callCount('postChanges') + server.callCount('getChanges')
    const calls = syncCalls()
    await vi.advanceTimersByTimeAsync(120_000)
    a.page.emit('focus')
    a.mutate(rename('p-2', 'Also signed out'))
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(syncCalls()).toBe(calls)
    // Focus only checked whether the session came back (GET /api/auth/session: no 401 for nobody).
    expect(server.calls.at(-1)).toBe('session')
    expect(server.calls).not.toContain('me')
    expect(a.st().pending).toBe(2)
    expect(await a.engine.signIn(TEST_ADMIN_EMAIL, 'wrong')).toMatchObject({ ok: false })
    expect(a.st().status).toBe('signed_out')
    expect(await a.engine.signIn(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)).toMatchObject({ ok: true })
    await a.engine.whenIdle()
    expect(serverTitle(server, 'p-1')).toBe('While signed out')
    expect(serverTitle(server, 'p-2')).toBe('Also signed out')
    expect(a.st()).toMatchObject({ status: 'synced', pending: 0, lastError: null })
  })

  it('a 401 for a request sent before signing in does not sign out again', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const realPost = server.postChanges.bind(server)
    let raced = false
    server.postChanges = async (changes, opts) => {
      if (raced) return realPost(changes, opts)
      raced = true
      // The session ended; the answer arrives only after the user has signed in again.
      server.signedIn = false
      const stale = realPost(changes, opts)
      await a.engine.signIn(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)
      return stale
    }
    a.mutate(rename('p-1', 'Across sign-in'))
    await quiet(a)
    await a.engine.whenIdle()
    expect(a.st()).toMatchObject({ status: 'synced', pending: 0 })
    expect(serverTitle(server, 'p-1')).toBe('Across sign-in')
  })

  it('resumes on focus when another tab of this browser signed in', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    server.signedIn = false
    a.mutate(rename('p-1', 'Waiting'))
    await quiet(a)
    expect(a.st().status).toBe('signed_out')
    a.page.emit('focus')
    await vi.advanceTimersByTimeAsync(1)
    expect(a.st().status).toBe('signed_out')
    server.signedIn = true // the shared session cookie, signed in from another tab
    a.page.emit('focus')
    await vi.advanceTimersByTimeAsync(1)
    await a.engine.whenIdle()
    expect(a.st()).toMatchObject({ status: 'synced', pending: 0 })
    expect(serverTitle(server, 'p-1')).toBe('Waiting')
  })

  it('signing out stops syncing until the next sign-in', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    expect(await a.engine.signOut()).toMatchObject({ ok: true, confirmed: true })
    expect(server.signedIn).toBe(false)
    expect(a.st()).toMatchObject({ status: 'signed_out', user: null })
    a.mutate(rename('p-1', 'Queued'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(serverTitle(server, 'p-1')).toBe('Engineer')
    await a.engine.signIn(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)
    await a.engine.whenIdle()
    expect(serverTitle(server, 'p-1')).toBe('Queued')
  })
})

describe('undo with the real store', () => {
  function realDevice(server: FakeServer) {
    const db = makeDB()
    db.people.push(makePerson('p-1'))
    useDB.setState({ db, past: [] })
    const page = testEnv()
    const engine: SyncEngine = createSyncEngine({ store: useDB, api: server, storage: memoryStorage(), env: page.env, status: createStatusStore() })
    cleanups.push(() => engine.stop())
    return { engine, page }
  }

  it('turns undo into ordinary changes', async () => {
    const server = new FakeServer()
    const { engine } = realDevice(server)
    expect(await engine.uploadLocal()).toEqual({ ok: true })
    await engine.whenIdle()
    useDB.getState().mutate('Added Grace', (d) => {
      d.people.push(makePerson('p-9', { firstName: 'Grace' }))
    })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    await engine.whenIdle()
    useDB.getState().mutate('Promoted Grace', (d) => {
      d.people.find((p) => p.id === 'p-9')!.title = 'Lead'
    })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    await engine.whenIdle()
    expect(serverTitle(server, 'p-9')).toBe('Lead')
    const promoted = server.versions()['people:p-9']

    expect(useDB.getState().undo()).toBe('Promoted Grace')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    await engine.whenIdle()
    expect(serverTitle(server, 'p-9')).toBe('Engineer')
    expect(server.pushes.at(-1)).toEqual([expect.objectContaining({ id: 'p-9', op: 'upsert', baseVersion: promoted })])
    const undone = server.versions()['people:p-9']

    expect(useDB.getState().undo()).toBe('Added Grace')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    await engine.whenIdle()
    expect(server.record('people', 'p-9')).toBeUndefined()
    expect(server.pushes.at(-1)).toEqual([{ collection: 'people', id: 'p-9', op: 'delete', baseVersion: undone }])
  })

  it('undo never reverts what another device did meanwhile', async () => {
    const server = new FakeServer()
    const { engine, page } = realDevice(server)
    expect(await engine.uploadLocal()).toEqual({ ok: true })
    await engine.whenIdle()
    useDB.getState().mutate('Renamed', (d) => {
      d.people.find((p) => p.id === 'p-1')!.title = 'Mine'
    })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    await engine.whenIdle()
    // Another device adds someone and edits the company.
    server.serverUpsert('people', 'p-other', makePerson('p-other'))
    server.serverUpsert('$doc', 'company', { ...server.snapshot().company, tagline: 'From the other device' })
    page.emit('focus')
    await engine.whenIdle()
    expect(useDB.getState().db.people.some((p) => p.id === 'p-other')).toBe(true)
    expect(useDB.getState().past).toHaveLength(1)

    expect(useDB.getState().undo()).toBe('Renamed')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    await engine.whenIdle()
    expect(serverTitle(server, 'p-1')).toBe('Engineer')
    expect(server.record('people', 'p-other')).toBeTruthy()
    expect(server.snapshot().company.tagline).toBe('From the other device')
    expect(useDB.getState().db.company.tagline).toBe('From the other device')
  })
})

describe('the sample company', () => {
  it('is never pushed when it is loaded over a synced workspace', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const pushes = server.pushes.length
    a.store.getState().replace(makeDB({ sample: true, company: 'Ledgerlark' }), 'Reset to the sample company')
    expect(a.st()).toMatchObject({ status: 'local', hold: 'sample', mode: 'server' })
    a.mutate(add('p-sample-edit'))
    a.page.emit('focus')
    a.page.setVisible(false)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(server.pushes.length).toBe(pushes)
    expect(a.conn().outbox).toEqual([])
    expect(server.snapshot().company.name).toBe('Acme')
    // Going back to the server's copy ends the hold.
    a.page.setVisible(true)
    expect(await a.engine.useServerCopy()).toEqual({ ok: true })
    expect(a.db().company.name).toBe('Acme')
    expect(a.st().hold).toBeNull()
  })

  it('does not start syncing a sample that was open before start', async () => {
    const server = new FakeServer()
    await uploader(server)
    const storage = memoryStorage()
    saveConnection(storage, { ...emptyConnection(), mode: 'server', seq: server.seq })
    const d = device(server, makeDB({ sample: true }), storage)
    d.engine.start()
    await d.engine.whenIdle()
    expect(d.st()).toMatchObject({ status: 'local', hold: 'sample' })
    expect(server.callCount('getChanges')).toBe(1) // only the uploader's own pull
    d.mutate(add('p-x'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(server.pushes.flat().some((c) => c.id === 'p-x')).toBe(false)
  })

  it('uploads the sample only when the user explicitly includes it', async () => {
    const server = new FakeServer()
    const d = device(server, makeDB({ sample: true, company: 'Ledgerlark' }))
    const refused = await d.engine.uploadLocal()
    expect(refused).toMatchObject({ ok: false, kind: 'sample' })
    if (!refused.ok) expect(refused.message).toMatch(/sample company never syncs/)
    expect(server.hasWorkspace).toBe(false)
    expect(await d.engine.uploadLocal({ includeSample: true })).toEqual({ ok: true })
    await d.engine.whenIdle()
    expect(server.snapshot().company.name).toBe('Ledgerlark')
    d.mutate(add('p-in-sample'))
    await quiet(d)
    expect(server.record('people', 'p-in-sample')).toBeTruthy()
    expect(d.st().hold).toBeNull()
    // A second browser taking that copy keeps syncing it too.
    const b = await joiner(server)
    b.mutate(rename('p-in-sample', 'Also synced'))
    await quiet(b)
    expect(serverTitle(server, 'p-in-sample')).toBe('Also synced')
  })

  it('pending edits made before the sample was loaded still reach the server', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    server.online = false
    a.mutate(rename('p-2', 'Before the sample'))
    await quiet(a)
    a.store.getState().replace(makeDB({ sample: true }))
    expect(a.st().hold).toBe('sample')
    server.online = true
    expect(await a.engine.useServerCopy()).toEqual({ ok: true })
    expect(serverTitle(server, 'p-2')).toBe('Before the sample')
    expect(titleOf(a, 'p-2')).toBe('Before the sample')
  })
})

describe('disconnect and start', () => {
  it('refuses to drop pending changes unless told to, then goes local', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    server.online = false
    a.mutate(rename('p-1', 'Unsent'))
    await quiet(a)
    const refused = await a.engine.disconnect()
    expect(refused).toMatchObject({ ok: false, kind: 'pending', pending: 1 })
    if (!refused.ok) expect(refused.message).toBe('1 change has not reached the server yet. Disconnecting keeps it in this browser only.')
    expect(await a.engine.disconnect({ discardPending: true })).toMatchObject({ ok: true, confirmed: false })
    expect(a.storage.data.has(SYNC_STORAGE_KEY)).toBe(false)
    expect(a.st()).toMatchObject({ status: 'local', mode: 'local', pending: 0, logoutPending: true })
    // Only the watchers that end the session once the server answers.
    expect(a.page.listenerCount()).toBe(3)
    expect(titleOf(a, 'p-1')).toBe('Unsent')
    server.online = true
    a.mutate(rename('p-1', 'Local only'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(serverTitle(server, 'p-1')).toBe('Engineer')
    a.page.emit('online')
    await vi.advanceTimersByTimeAsync(1)
    expect(server.signedIn).toBe(false)
    expect(a.st().logoutPending).toBe(false)
    expect(a.page.listenerCount()).toBe(0)
  })

  it('start() in a local install does nothing', async () => {
    const server = new FakeServer()
    const d = device(server)
    d.engine.start()
    d.mutate(add('p-local'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(server.calls).toEqual([])
    expect(d.st()).toMatchObject({ status: 'local', mode: 'local' })
    expect(d.page.listenerCount()).toBe(0)
  })

  it('queues changes made before the engine started (baseline)', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    a.engine.stop()
    const saved = a.db()
    a.mutate(rename('p-1', 'Applied on load'))
    const restarted = createSyncEngine({
      store: a.store,
      api: server,
      storage: a.storage,
      env: testEnv().env,
      status: createStatusStore(),
      baseline: () => saved,
    })
    cleanups.push(() => restarted.stop())
    restarted.start()
    await restarted.whenIdle()
    expect(serverTitle(server, 'p-1')).toBe('Applied on load')
  })
})

describe('convergence', () => {
  // Random edits, undos, offline spells, a third writer, log pruning (resync), hidden pages, lost push
  // answers and expired sessions. 1,500 seeds of 500 steps passed while building this; a few fixed seeds keep it honest.
  it.each([20261010, 7919, 104729, 1299709])('two devices end up identical with the server (seed %i)', async (seed) => {
    const server = new FakeServer()
    const linkA = deviceLink(server)
    const linkB = deviceLink(server)
    const a = await uploader(server, linkA)
    const b = await joiner(server, linkB)
    const devices: Array<[Device, typeof linkA]> = [
      [a, linkA],
      [b, linkB],
    ]
    const rand = prng(seed)
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]
    let n = 0
    for (let step = 0; step < 400; step++) {
      const [dev, link] = pick(devices)
      const ids = dev.db().people.map((p) => p.id).filter((id) => id !== 'p-founder')
      const roll = rand()
      if (roll < 0.25) dev.mutate(add(`p-r${n++}`))
      else if (roll < 0.5 && ids.length) dev.mutate(rename(pick(ids), `t${n++}`))
      else if (roll < 0.6 && ids.length) dev.mutate(remove(pick(ids)))
      else if (roll < 0.67) dev.mutate((d) => void (d.company.tagline = `tag${n++}`))
      else if (roll < 0.75) dev.store.getState().undo()
      else if (roll < 0.82) link.online = !link.online
      else if (roll < 0.86) dev.page.emit('focus')
      else if (roll < 0.89) server.prune()
      else if (roll < 0.93 && ids.length) {
        const id = pick(ids)
        const cur = server.record('people', id) as Record<string, unknown> | undefined
        if (cur) server.serverUpsert('people', id, { ...cur, title: `c${n++}` })
        else server.serverUpsert('people', `p-c${n}`, makePerson(`p-c${n++}`))
      } else if (roll < 0.95) dev.page.setVisible(!dev.page.env.isVisible())
      // A push commits but its answer is lost (F1).
      else if (roll < 0.96) server.loseResponses(1)
      else if (roll < 0.97) server.signedIn = false
      else if (roll < 0.99 && !server.signedIn) await dev.engine.signIn(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)
      await vi.advanceTimersByTimeAsync(Math.floor(rand() * 3000))
    }
    linkA.online = true
    linkB.online = true
    a.page.setVisible(true)
    b.page.setVisible(true)
    await a.engine.signIn(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)
    await b.engine.signIn(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)
    await vi.advanceTimersByTimeAsync(61_000)
    for (let i = 0; i < 2; i++) {
      await a.engine.syncNow()
      await b.engine.syncNow()
    }
    expect(a.conn().outbox).toEqual([])
    expect(b.conn().outbox).toEqual([])
    expect(diffDB(a.db(), server.snapshot())).toEqual([])
    expect(diffDB(b.db(), server.snapshot())).toEqual([])
    expect(a.st().status).toBe('synced')
    expect(b.st().status).toBe('synced')
  })
})

// ------------------------------------------------------------------------------------------------
// Regressions from the integrity and security reviews (F1, F4-F10, SEC-2).
// ------------------------------------------------------------------------------------------------

describe('pushes whose answer was lost (F1)', () => {
  it('an edit made after a lost answer is not reverted', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const b = await joiner(server)
    server.loseResponses(1)
    a.mutate(rename('p-1', 'v2'))
    await quiet(a)
    expect(serverTitle(server, 'p-1')).toBe('v2')
    expect(a.st().status).toBe('offline')
    a.mutate(rename('p-1', 'v3'))
    await vi.advanceTimersByTimeAsync(2000)
    await a.engine.whenIdle()
    expect(titleOf(a, 'p-1')).toBe('v3')
    expect(serverTitle(server, 'p-1')).toBe('v3')
    expect(a.st()).toMatchObject({ status: 'synced', pending: 0, refreshed: 0 })
    expect(a.conn().unconfirmed).toEqual({})
    expect(a.conn().versions['people:p-1']).toBe(server.versions()['people:p-1'])
    await b.engine.syncNow()
    expect(titleOf(b, 'p-1')).toBe('v3')
  })

  // Versions are workspace-wide seqs: whatever else is written between the base write and the lost one
  // (another record, the activity row of each edit, another device) moves the lost write further up.
  it('an edit after a lost answer is not reverted when other records were written in between', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const b = await joiner(server)
    const base = a.conn().versions['people:p-1']
    b.mutate(rename('p-3', 'Another device'))
    await quiet(b)
    a.mutate(rename('p-2', 'Same device'))
    await quiet(a)
    server.loseResponses(1)
    // Two records in one push, p-1 second: it lands two or more past its base.
    a.mutate(rename('p-2', 'Same batch'))
    a.mutate(rename('p-1', 'v2'))
    await quiet(a)
    expect(serverTitle(server, 'p-1')).toBe('v2')
    expect(server.versions()['people:p-1']).toBeGreaterThan(base + 1)
    expect(a.st().status).toBe('offline')
    a.mutate(rename('p-1', 'v3'))
    await vi.advanceTimersByTimeAsync(2000)
    await a.engine.whenIdle()
    expect(titleOf(a, 'p-1')).toBe('v3')
    expect(titleOf(a, 'p-2')).toBe('Same batch')
    expect(serverTitle(server, 'p-1')).toBe('v3')
    expect(a.st()).toMatchObject({ status: 'synced', pending: 0, refreshed: 0 })
    expect(a.conn().versions['people:p-1']).toBe(server.versions()['people:p-1'])
    await b.engine.syncNow()
    expect(titleOf(b, 'p-1')).toBe('v3')
  })

  it('an edit after a lost answer is not reverted when each edit also logs an activity row', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    let n = 0
    const edit = (title: string): Recipe => (d) => {
      d.people.find((p) => p.id === 'p-1')!.title = title
      d.activity.push({ id: `act-${++n}`, at: '2026-10-10T17:00:00.000Z', entityType: 'person', entityId: 'p-1', kind: 'person_updated', text: title })
      d.company.tagline = title
    }
    a.mutate(edit('v1'))
    await quiet(a)
    server.loseResponses(1)
    a.mutate(edit('v2'))
    await quiet(a)
    expect(a.st().status).toBe('offline')
    a.mutate(edit('v3'))
    await vi.advanceTimersByTimeAsync(2000)
    await a.engine.whenIdle()
    expect(titleOf(a, 'p-1')).toBe('v3')
    expect(a.db().company.tagline).toBe('v3')
    expect(serverTitle(server, 'p-1')).toBe('v3')
    expect(server.snapshot().company.tagline).toBe('v3')
    expect(a.st()).toMatchObject({ status: 'synced', pending: 0, refreshed: 0 })
    expect(diffDB(a.db(), server.snapshot())).toEqual([])
  })

  it('a new record edited after a lost answer keeps the edit', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    server.loseResponses(1)
    a.mutate(add('p-new', 'first'))
    await quiet(a)
    expect(serverTitle(server, 'p-new')).toBe('first')
    a.mutate(rename('p-new', 'second'))
    await vi.advanceTimersByTimeAsync(2000)
    await a.engine.whenIdle()
    expect(titleOf(a, 'p-new')).toBe('second')
    expect(serverTitle(server, 'p-new')).toBe('second')
    expect(a.st()).toMatchObject({ pending: 0, refreshed: 0 })
  })

  it('a new record deleted after a lost answer stays deleted everywhere', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const b = await joiner(server)
    server.loseResponses(1)
    a.mutate(add('p-new', 'first'))
    await quiet(a)
    expect(server.record('people', 'p-new')).toBeTruthy()
    a.mutate(remove('p-new'))
    // The server may have it, so the delete is queued instead of dropped.
    expect(a.st().pending).toBe(1)
    await vi.advanceTimersByTimeAsync(2000)
    await a.engine.whenIdle()
    expect(server.record('people', 'p-new')).toBeUndefined()
    expect(a.db().people.some((p) => p.id === 'p-new')).toBe(false)
    await b.engine.syncNow()
    expect(b.db().people.some((p) => p.id === 'p-new')).toBe(false)
    expect(a.st()).toMatchObject({ pending: 0, refreshed: 0 })
  })

  it('remembers the unanswered push across a reload', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const base = a.conn().versions['people:p-1']
    server.loseResponses(1)
    a.mutate(rename('p-1', 'v2'))
    await quiet(a)
    a.engine.stop()
    expect(loadConnection(a.storage).unconfirmed['people:p-1']).toMatchObject({ baseVersion: base })
    // The reloaded page is still offline when the user edits again.
    server.online = false
    const reloaded = createSyncEngine({ store: a.store, api: server, storage: a.storage, env: testEnv().env, status: createStatusStore() })
    cleanups.push(() => reloaded.stop())
    reloaded.start()
    await reloaded.whenIdle()
    a.mutate(rename('p-1', 'v3'))
    server.online = true
    await reloaded.syncNow()
    expect(titleOf(a, 'p-1')).toBe('v3')
    expect(serverTitle(server, 'p-1')).toBe('v3')
  })

  it('still lets the server win when another device changed the record after the lost write', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const b = await joiner(server)
    server.loseResponses(1)
    a.mutate(rename('p-1', 'v2'))
    await quiet(a)
    await b.engine.syncNow()
    b.mutate(rename('p-1', 'B on top'))
    await quiet(b)
    a.mutate(rename('p-1', 'v3'))
    await vi.advanceTimersByTimeAsync(2000)
    await a.engine.whenIdle()
    expect(titleOf(a, 'p-1')).toBe('B on top')
    expect(serverTitle(server, 'p-1')).toBe('B on top')
    expect(a.st().refreshed).toBe(1)
  })

  it('forgets an attempt the server refused outright', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    server.signedIn = false
    a.mutate(rename('p-1', 'Signed out'))
    await quiet(a)
    expect(a.st().status).toBe('signed_out')
    expect(a.conn().unconfirmed).toEqual({})
  })
})

const DB_KEY = 'first-twenty:db:v1'

/**
 * A browser whose store is saved the way db.ts saves it (400 ms after the last change) and by the engine
 * (persistStore). crash() kills the tab: the pending debounced save never runs.
 */
function persistentBrowser(api: SyncApi, storage: ReturnType<typeof memoryStorage>, db?: DB) {
  const start = db ?? (JSON.parse(storage.getItem(DB_KEY) ?? 'null') as DB)
  let d: Device | null = null
  const save = () => {
    try {
      storage.setItem(DB_KEY, JSON.stringify(d!.db()))
      return true
    } catch {
      return false
    }
  }
  d = device(api, start, storage, { persistStore: save })
  let timer: ReturnType<typeof setTimeout> | null = null
  const unsubscribe = d.store.subscribe((s, prev) => {
    if (s.db === prev.db) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      save()
    }, 400)
  })
  return Object.assign(d, {
    crash: () => {
      d!.engine.stop()
      unsubscribe()
      if (timer) clearTimeout(timer)
    },
  })
}

/** memoryStorage that can refuse writes to some keys (quota). */
function flakyStorage() {
  const inner = memoryStorage()
  const refuse = new Set<string>()
  const storage = Object.assign(inner, {
    refuse,
    setItem: (k: string, v: string) => {
      if (refuse.has(k)) throw new DOMException('quota', 'QuotaExceededError')
      inner.data.set(k, String(v))
    },
  })
  return storage
}

describe('saving the store and the sync state together (F4)', () => {
  it('a tab killed right after a pull keeps what it pulled', async () => {
    const server = new FakeServer()
    const storage = memoryStorage()
    const db = makeDB()
    db.people.push(makePerson('p-1'))
    const a = persistentBrowser(server, storage, db)
    expect(await a.engine.uploadLocal()).toEqual({ ok: true })
    await a.engine.whenIdle()
    const b = await joiner(server)
    b.mutate(rename('p-1', 'From B'))
    await quiet(b)
    await a.engine.syncNow()
    expect(titleOf(a, 'p-1')).toBe('From B')
    a.crash()
    // Reload: the saved store already has B's change, matching the saved seq and versions.
    const a2 = persistentBrowser(server, storage)
    expect(titleOf(a2, 'p-1')).toBe('From B')
    a2.engine.start()
    await a2.engine.whenIdle()
    a2.mutate((d) => {
      d.people.find((p) => p.id === 'p-1')!.notes = 'New phone'
    })
    await quiet(a2)
    expect(serverTitle(server, 'p-1')).toBe('From B')
    expect(a2.st().refreshed).toBe(0)
  })

  it('a tab killed right after an edit never sends the server an edit its saved store lacks', async () => {
    const server = new FakeServer()
    const storage = memoryStorage()
    const db = makeDB()
    db.people.push(makePerson('p-1'))
    const a = persistentBrowser(server, storage, db)
    expect(await a.engine.uploadLocal()).toEqual({ ok: true })
    await a.engine.whenIdle()
    a.mutate(rename('p-1', 'Typed just before the crash'))
    // The outbox (keys only) is saved at once; the store would be saved 400 ms later.
    expect(loadConnection(storage).outbox).toEqual([expect.objectContaining({ id: 'p-1' })])
    expect(loadConnection(storage).outbox[0]).not.toHaveProperty('data')
    a.crash()
    const a2 = persistentBrowser(server, storage)
    a2.engine.start()
    await a2.engine.whenIdle()
    expect(titleOf(a2, 'p-1')).toBe('Engineer')
    expect(diffDB(a2.db(), server.snapshot())).toEqual([])
    a2.mutate((d) => {
      d.people.find((p) => p.id === 'p-1')!.notes = 'Later edit'
    })
    await quiet(a2)
    expect(diffDB(a2.db(), server.snapshot())).toEqual([])
  })

  it('when the store cannot be saved, the next start rebases on the server before pushing', async () => {
    const server = new FakeServer()
    const storage = flakyStorage()
    const db = makeDB()
    db.people.push(makePerson('p-1'))
    const a = persistentBrowser(server, storage, db)
    expect(await a.engine.uploadLocal()).toEqual({ ok: true })
    await a.engine.whenIdle()
    await vi.advanceTimersByTimeAsync(500)
    const b = await joiner(server)
    b.mutate(rename('p-1', 'From B'))
    await quiet(b)
    storage.refuse.add(DB_KEY)
    await a.engine.syncNow()
    expect(titleOf(a, 'p-1')).toBe('From B')
    expect(a.st().storageFull).toBe(true)
    a.crash()
    storage.refuse.clear()
    // The saved store is older than the saved seq: the mark tells the reloaded engine.
    const a2 = persistentBrowser(server, storage)
    expect(titleOf(a2, 'p-1')).toBe('Engineer')
    const snapshots = server.callCount('getWorkspace')
    a2.engine.start()
    await a2.engine.whenIdle()
    expect(server.callCount('getWorkspace')).toBe(snapshots + 1)
    expect(titleOf(a2, 'p-1')).toBe('From B')
    a2.mutate((d) => {
      d.people.find((p) => p.id === 'p-1')!.notes = 'New phone'
    })
    await quiet(a2)
    expect(serverTitle(server, 'p-1')).toBe('From B')
  })
})

describe('changes the app makes on load (F5)', () => {
  const promotion = { id: 'c-1', personId: 'p-1', effectiveOn: '2026-10-01', payType: 'salary', salary: 150000, title: 'Senior engineer', levelId: 'lv-l4', reason: 'promotion', scheduled: true } as const
  function scheduled(): DB {
    const db = makeDB()
    db.people.push(makePerson('p-1', { title: 'Engineer' }))
    db.comp.push({ ...promotion })
    return db
  }
  const effectiveRows = (db: DB) => db.activity.filter((r) => r.kind === 'job_change_effective')

  it('reach the server and every device, with one activity row however many devices apply them', async () => {
    const server = new FakeServer()
    const a0 = device(server, scheduled())
    expect(await a0.engine.uploadLocal()).toEqual({ ok: true })
    await a0.engine.whenIdle()
    const b0 = await joiner(server)
    a0.engine.stop()
    b0.engine.stop()
    // The effective date passed: each browser reloads, and db.ts applies the promotion before the engine starts.
    const savedA = a0.db()
    const a = device(server, applyLoadChanges(savedA), a0.storage, { baseline: () => savedA })
    expect(titleOf(a, 'p-1')).toBe('Senior engineer')
    a.engine.start()
    await a.engine.whenIdle()
    expect(serverTitle(server, 'p-1')).toBe('Senior engineer')
    expect((server.record('comp', 'c-1') as { appliedOn?: string }).appliedOn).toBe('2026-10-10')
    await vi.advanceTimersByTimeAsync(1000)
    const savedB = b0.db()
    const b = device(server, applyLoadChanges(savedB), b0.storage, { baseline: () => savedB })
    b.engine.start()
    await b.engine.whenIdle()
    await a.engine.syncNow()
    expect(effectiveRows(server.snapshot())).toHaveLength(1)
    expect(effectiveRows(a.db())).toEqual(effectiveRows(server.snapshot()))
    expect(effectiveRows(b.db())).toEqual(effectiveRows(server.snapshot()))
    expect(b.st().refreshed).toBe(0)
    // Later edits on either side keep the promotion.
    b.mutate((d) => {
      d.people.find((p) => p.id === 'p-1')!.notes = 'New phone'
    })
    a.mutate((d) => {
      d.comp.find((c) => c.id === 'c-1')!.note = 'Approved in September'
    })
    await quiet(a, b)
    await a.engine.syncNow()
    await b.engine.syncNow()
    for (const dev of [a, b]) expect(titleOf(dev, 'p-1')).toBe('Senior engineer')
    expect(serverTitle(server, 'p-1')).toBe('Senior engineer')
    expect(diffDB(a.db(), server.snapshot())).toEqual([])
    expect(diffDB(b.db(), server.snapshot())).toEqual([])
  })

  it('a server copy taken after the effective date gets the change too, and syncs it', async () => {
    const server = new FakeServer()
    const a = device(server, scheduled())
    expect(await a.engine.uploadLocal()).toEqual({ ok: true })
    const b = device(server, makeDB({ company: 'Elsewhere' }), memoryStorage(), { onLoad: applyLoadChanges })
    expect(await b.engine.useServerCopy()).toEqual({ ok: true })
    await b.engine.whenIdle()
    expect(titleOf(b, 'p-1')).toBe('Senior engineer')
    expect(serverTitle(server, 'p-1')).toBe('Senior engineer')
    expect(effectiveRows(server.snapshot())).toHaveLength(1)
  })
})

const importedWorkspace = () => {
  const db = makeDB({ company: 'Imported Co' })
  db.meta.createdOn = '2025-03-01'
  db.people.push(makePerson('p-imported'))
  return db
}
const peopleIds = (db: DB) => db.people.map((p) => p.id).sort()

describe('replacing the workspace (F6)', () => {
  it('a connected browser replaces the server workspace as a whole: nothing of the old one survives', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const b = await joiner(server)
    b.mutate(rename('p-1', 'Touched by B'))
    await quiet(b)
    a.mutate(rename('p-2', 'Unsent edit to the old workspace'))
    expect(await a.engine.replaceWorkspace(importedWorkspace(), { label: 'Imported a backup of Imported Co' })).toEqual({ ok: true })
    expect(a.store.getState().past).toEqual([])
    expect(a.conn()).toMatchObject({ outbox: [], hold: null })
    expect(peopleIds(server.snapshot())).toEqual(['p-founder', 'p-imported'])
    expect(diffDB(a.db(), server.snapshot())).toEqual([])
    await b.engine.syncNow()
    expect(b.db().company.name).toBe('Imported Co')
    expect(peopleIds(b.db())).toEqual(['p-founder', 'p-imported'])
    a.mutate(rename('p-imported', 'After import'))
    await quiet(a)
    await b.engine.syncNow()
    expect(titleOf(b, 'p-imported')).toBe('After import')
  })

  it('changes nothing when the server cannot take it', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    server.online = false
    const before = a.db()
    expect(await a.engine.replaceWorkspace(importedWorkspace())).toMatchObject({ ok: false, kind: 'offline' })
    expect(a.db()).toBe(before)
    expect(server.snapshot().company.name).toBe('Acme')
  })

  it('is an ordinary replace with an Undo step when not connected', async () => {
    const server = new FakeServer()
    const d = device(server)
    expect(await d.engine.replaceWorkspace(importedWorkspace(), { label: 'Imported' })).toEqual({ ok: true })
    expect(d.db().company.name).toBe('Imported Co')
    expect(d.store.getState().past.map((p) => p.label)).toEqual(['Imported'])
    expect(server.calls).toEqual([])
  })

  it('a swap made straight through the store puts the connection on hold instead of merging', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const b = await joiner(server)
    b.mutate(rename('p-1', 'Touched by B'))
    await quiet(b)
    const pushes = server.pushes.length
    a.store.getState().replace(importedWorkspace(), 'Imported a backup of Imported Co')
    expect(a.st()).toMatchObject({ status: 'local', hold: 'replaced' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(server.pushes.length).toBe(pushes)
    expect(server.snapshot().company.name).toBe('Acme')
    // Using the server's copy would throw the import away: the engine asks first.
    expect(await a.engine.useServerCopy()).toMatchObject({ ok: false, kind: 'pending' })
    expect(a.db().company.name).toBe('Imported Co')
    expect(await a.engine.uploadLocal({ confirmReplace: true })).toEqual({ ok: true })
    await b.engine.syncNow()
    expect(peopleIds(b.db())).toEqual(['p-founder', 'p-imported'])
  })

  it('undoing a swap made through the store resumes syncing the original workspace', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    a.store.getState().replace(importedWorkspace(), 'Imported')
    expect(a.st().hold).toBe('replaced')
    a.store.getState().undo()
    expect(a.st().hold).toBeNull()
    a.mutate(rename('p-1', 'Back on the original'))
    await quiet(a)
    expect(serverTitle(server, 'p-1')).toBe('Back on the original')
    expect(server.snapshot().company.name).toBe('Acme')
  })
})

describe('the sample company, then Undo (F7)', () => {
  it('Undo after loading the sample ends the hold and later edits sync', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    a.store.getState().replace(makeDB({ sample: true, company: 'Ledgerlark' }), 'Reset to the sample company')
    expect(a.st().hold).toBe('sample')
    a.mutate(add('p-sample-edit'))
    a.store.getState().undo()
    expect(a.st().hold).toBe('sample')
    a.store.getState().undo()
    expect(a.db().company.name).toBe('Acme')
    expect(a.st().hold).toBeNull()
    a.mutate(add('p-day-of-work'))
    a.mutate(rename('p-1', 'Edited after undo'))
    await quiet(a)
    expect(server.record('people', 'p-day-of-work')).toBeTruthy()
    expect(serverTitle(server, 'p-1')).toBe('Edited after undo')
    expect(server.record('people', 'p-sample-edit')).toBeUndefined()
    expect(a.st()).toMatchObject({ status: 'synced', pending: 0, hold: null })
  })

  it('edits queued before the sample was loaded keep their data while it is open', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    server.online = false
    a.mutate(rename('p-2', 'Before the sample'))
    await quiet(a)
    a.store.getState().replace(makeDB({ sample: true }))
    expect(a.conn().outbox).toEqual([expect.objectContaining({ id: 'p-2', fixed: true, op: 'upsert' })])
    // A reload while the sample is open keeps them (the store no longer has that workspace).
    expect(loadConnection(a.storage).outbox[0]).toMatchObject({ fixed: true, data: { title: 'Before the sample' } })
    server.online = true
    expect(await a.engine.useServerCopy()).toEqual({ ok: true })
    expect(serverTitle(server, 'p-2')).toBe('Before the sample')
  })
})

describe('changes the server refused (F8)', () => {
  it('a refused record survives a resync, and using the server copy asks first', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const b = await joiner(server)
    a.mutate((d) => {
      d.people.push(makePerson('p-big', { notes: 'x'.repeat(300 * 1024) }))
    })
    await quiet(a)
    expect(a.conn().rejected.map((r) => r.id)).toEqual(['p-big'])
    b.mutate(rename('p-1', 'From B'))
    await quiet(b)
    server.prune()
    await a.engine.syncNow()
    expect(titleOf(a, 'p-1')).toBe('From B')
    expect(a.db().people.some((p) => p.id === 'p-big')).toBe(true)
    const refused = await a.engine.useServerCopy()
    expect(refused).toMatchObject({ ok: false, kind: 'pending', pending: 1 })
    if (!refused.ok) expect(refused.message).toMatch(/refused/)
    expect(a.db().people.some((p) => p.id === 'p-big')).toBe(true)
    expect(await a.engine.useServerCopy({ discardPending: true })).toEqual({ ok: true })
    expect(a.conn().rejected).toEqual([])
  })

  it('a pulled change never overwrites a refused record', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    server.refuseIds.add('p-1')
    a.mutate(rename('p-1', 'Mine, refused'))
    await quiet(a)
    expect(a.conn().rejected.map((r) => r.id)).toEqual(['p-1'])
    server.serverUpsert('people', 'p-1', { ...(server.record('people', 'p-1') as object), title: 'Elsewhere' })
    await a.engine.syncNow()
    expect(titleOf(a, 'p-1')).toBe('Mine, refused')
  })

  it('a server that refuses everything sets aside a few changes at most, then backs off', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const ids = ['p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6']
    for (const id of ids) server.refuseIds.add(id)
    a.mutate((d) => {
      for (const id of ['p-1', 'p-2', 'p-3']) d.people.find((p) => p.id === id)!.title = `Edited ${id}`
      for (const id of ['p-4', 'p-5', 'p-6']) d.people.push(makePerson(id))
    })
    await quiet(a)
    expect(a.conn().rejected).toHaveLength(MAX_REFUSALS_IN_A_ROW)
    expect(a.st()).toMatchObject({ status: 'error', pending: 6 - MAX_REFUSALS_IN_A_ROW })
    server.refuseIds.clear()
    await vi.advanceTimersByTimeAsync(2000)
    await a.engine.whenIdle()
    expect(a.st()).toMatchObject({ status: 'synced', pending: 0 })
    a.engine.retryRejected()
    await quiet(a)
    expect(a.st()).toMatchObject({ pending: 0, rejected: 0 })
    for (const id of ids) expect(server.record('people', id)).toBeTruthy()
    expect(diffDB(a.db(), server.snapshot())).toEqual([])
  })
})

describe('collections this build does not know (F9)', () => {
  it('skips them, and a build with another collection list starts from the snapshot', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    server.serverUpsert('reviewCycles', 'rc-1', { id: 'rc-1', name: 'H2 reviews' })
    server.serverUpsert('people', 'p-1', { ...(server.record('people', 'p-1') as object), title: 'Remote' })
    await a.engine.syncNow()
    expect(titleOf(a, 'p-1')).toBe('Remote')
    expect(a.conn().versions['reviewCycles:rc-1']).toBeUndefined()
    expect(a.conn().schema).toBe(SYNC_SCHEMA)
    a.engine.stop()
    // The page reloads into a build whose collection list differs from the one that saved the connection.
    saveConnection(a.storage, { ...loadConnection(a.storage), schema: 'the-previous-build' })
    const reloaded = createSyncEngine({ store: a.store, api: server, storage: a.storage, env: testEnv().env, status: createStatusStore() })
    cleanups.push(() => reloaded.stop())
    const calls = server.calls.length
    reloaded.start()
    await reloaded.whenIdle()
    expect(server.calls[calls]).toBe('getWorkspace')
    expect(reloaded.getConnection().schema).toBe(SYNC_SCHEMA)
    expect(diffDB(a.db(), server.snapshot())).toEqual([])
  })
})

describe('storage that refuses the sync state (F10)', () => {
  it('says so, warns before the tab closes while changes wait, and keeps the outbox small', async () => {
    const server = new FakeServer()
    const storage = flakyStorage()
    const warnings: boolean[] = []
    const a = device(server, makeDB(), storage)
    a.page.env.setLeaveWarning = (on) => void warnings.push(on)
    expect(await a.engine.uploadLocal()).toEqual({ ok: true })
    await a.engine.whenIdle()
    storage.refuse.add(SYNC_STORAGE_KEY)
    server.online = false
    a.mutate(add('p-offline'))
    await quiet(a)
    expect(a.st()).toMatchObject({ status: 'error', pending: 1, storageFull: true, lastError: STORAGE_FULL_MESSAGE })
    expect(warnings).toEqual([true])
    server.online = true
    await vi.advanceTimersByTimeAsync(2000)
    await a.engine.whenIdle()
    expect(server.record('people', 'p-offline')).toBeTruthy()
    expect(a.st()).toMatchObject({ status: 'synced', pending: 0 })
    expect(warnings).toEqual([true, false])
  })

  it('stores keys, not copies, in the outbox', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    server.online = false
    a.mutate((d) => {
      d.people.find((p) => p.id === 'p-1')!.notes = 'x'.repeat(50_000)
    })
    await quiet(a)
    const saved = a.storage.getItem(SYNC_STORAGE_KEY) ?? ''
    // The versions map takes a few KB; the 50 KB note is not copied in.
    expect(saved.length).toBeLessThan(10_000)
    expect(loadConnection(a.storage).outbox).toEqual([expect.objectContaining({ collection: 'people', id: 'p-1', op: 'upsert' })])
  })
})

describe('signing out and forgetting this browser (SEC-2)', () => {
  function forgetful(server: FakeServer) {
    const wipeLocal = vi.fn()
    const reload = vi.fn()
    const db = makeDB()
    db.people.push(makePerson('p-1'))
    const d = device(server, db, memoryStorage(), { wipeLocal, reload, freshDB: () => makeDB({ sample: true, company: 'Ledgerlark' }) })
    return Object.assign(d, { wipeLocal, reload })
  }

  it('sends queued changes, then removes the workspace and the sync state and reloads', async () => {
    const server = new FakeServer()
    const a = forgetful(server)
    expect(await a.engine.uploadLocal()).toEqual({ ok: true })
    await a.engine.whenIdle()
    a.mutate(rename('p-1', 'Last edit'))
    expect(await a.engine.signOut({ forgetThisBrowser: true })).toMatchObject({ ok: true, confirmed: true, forgotten: true })
    expect(serverTitle(server, 'p-1')).toBe('Last edit')
    expect(server.signedIn).toBe(false)
    expect(a.wipeLocal).toHaveBeenCalledOnce()
    expect(a.reload).toHaveBeenCalledOnce()
    expect(a.storage.data.has(SYNC_STORAGE_KEY)).toBe(false)
    expect(a.db().company.name).toBe('Ledgerlark')
    expect(a.db().people.some((p) => p.id === 'p-1')).toBe(false)
    expect(a.store.getState().past).toEqual([])
    expect(a.st()).toMatchObject({ status: 'local', mode: 'local', pending: 0, user: null })
    // Nothing syncs afterwards.
    a.mutate(add('p-after'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(server.record('people', 'p-after')).toBeUndefined()
  })

  it('removes nothing while changes cannot reach the server, unless told to discard them', async () => {
    const server = new FakeServer()
    const a = forgetful(server)
    expect(await a.engine.uploadLocal()).toEqual({ ok: true })
    await a.engine.whenIdle()
    server.online = false
    a.mutate(rename('p-1', 'Unsent'))
    const refused = await a.engine.signOut({ forgetThisBrowser: true })
    expect(refused).toMatchObject({ ok: false, kind: 'pending', pending: 1 })
    expect(a.wipeLocal).not.toHaveBeenCalled()
    expect(titleOf(a, 'p-1')).toBe('Unsent')
    expect(a.conn().mode).toBe('server')
    // Discarding the queued change is not enough: the server must end the session first.
    expect(await a.engine.signOut({ forgetThisBrowser: true, discardPending: true })).toMatchObject({ ok: false, kind: 'session_open' })
    expect(a.wipeLocal).not.toHaveBeenCalled()
    server.online = true
    expect(await a.engine.signOut({ forgetThisBrowser: true, discardPending: true })).toMatchObject({ ok: true, confirmed: true, forgotten: true })
    expect(a.wipeLocal).toHaveBeenCalledOnce()
    expect(a.db().people.some((p) => p.id === 'p-1')).toBe(false)
  })

  it('a plain sign-out keeps the offline copy', async () => {
    const server = new FakeServer()
    const a = forgetful(server)
    expect(await a.engine.uploadLocal()).toEqual({ ok: true })
    expect(await a.engine.signOut()).toEqual({ ok: true, confirmed: true, waiting: 0, message: 'Signed out. This browser keeps an offline copy.' })
    expect(a.wipeLocal).not.toHaveBeenCalled()
    expect(a.db().people.some((p) => p.id === 'p-1')).toBe(true)
  })
})

describe('sign-outs the server could not confirm (security F1, F2)', () => {
  function forgetful(server: SyncApi, storage = memoryStorage()) {
    const wipeLocal = vi.fn(() => {
      for (const k of [...storage.data.keys()]) if (k.startsWith('first-twenty:')) storage.data.delete(k)
    })
    const reload = vi.fn()
    const db = makeDB()
    db.people.push(makePerson('p-1'))
    const d = device(server, db, storage, { wipeLocal, reload, freshDB: () => makeDB({ sample: true, company: 'Ledgerlark' }) })
    return Object.assign(d, { wipeLocal, reload })
  }

  it('removing this browser\'s data while offline removes nothing and keeps the session for a later sign-out', async () => {
    const server = new FakeServer()
    const a = forgetful(server)
    expect(await a.engine.uploadLocal()).toEqual({ ok: true })
    await a.engine.whenIdle()
    server.online = false
    const refused = await a.engine.signOut({ forgetThisBrowser: true })
    expect(refused).toMatchObject({ ok: false, kind: 'session_open' })
    if (!refused.ok) expect(refused.message).toBe('Could not reach your server to end the session, so nothing was removed. Connect and try again.')
    expect(a.wipeLocal).not.toHaveBeenCalled()
    expect(a.reload).not.toHaveBeenCalled()
    expect(a.db().people.some((p) => p.id === 'p-1')).toBe(true)
    expect(a.conn().mode).toBe('server')
    expect(a.storage.data.has(LOGOUT_PENDING_KEY)).toBe(false)
  })

  it('a server error on logout also removes nothing', async () => {
    const server = new FakeServer()
    const a = forgetful(server)
    expect(await a.engine.uploadLocal()).toEqual({ ok: true })
    await a.engine.whenIdle()
    server.failures.push({ ok: false, kind: 'server', status: 500, error: 'internal' })
    expect(await a.engine.signOut({ forgetThisBrowser: true })).toMatchObject({ ok: false, kind: 'session_open', status: 500 })
    expect(a.wipeLocal).not.toHaveBeenCalled()
    expect(server.signedIn).toBe(true)
  })

  it('a forced removal leaves a pending sign-out that the next load sends before anything else', async () => {
    const server = new FakeServer()
    const a = forgetful(server)
    expect(await a.engine.uploadLocal()).toEqual({ ok: true })
    await a.engine.whenIdle()
    server.online = false
    const res = await a.engine.signOut({ forgetThisBrowser: true, keepServerSession: true })
    expect(res).toMatchObject({ ok: true, confirmed: false, forgotten: true })
    expect(a.wipeLocal).toHaveBeenCalledOnce()
    expect(a.storage.data.has(SYNC_STORAGE_KEY)).toBe(false)
    expect(a.storage.data.get(LOGOUT_PENDING_KEY)).toBe('1')
    expect(server.signedIn).toBe(true)
    // The page reloads: a new engine on the same storage, the server reachable again.
    server.online = true
    server.calls = []
    const next = device(server, makeDB({ sample: true }), a.storage)
    next.engine.start()
    await vi.advanceTimersByTimeAsync(1)
    expect(server.calls[0]).toBe('logout')
    expect(server.signedIn).toBe(false)
    expect(a.storage.data.has(LOGOUT_PENDING_KEY)).toBe(false)
    expect(await next.engine.checkServer()).toMatchObject({ ok: true, signedIn: false })
  })

  it('while the pending sign-out cannot reach the server, the browser stays signed out and nothing uses the session', async () => {
    const server = new FakeServer()
    await uploader(server)
    const storage = memoryStorage()
    storage.setItem(LOGOUT_PENDING_KEY, '1')
    // The server is back, but the logout keeps failing (a proxy error).
    const realLogout = server.logout.bind(server)
    server.logout = async () => {
      server.calls.push('logout')
      return { ok: false, kind: 'server', status: 502, error: null }
    }
    const b = device(server, makeDB({ company: 'Shared computer' }), storage)
    const calls = server.calls.length
    expect(await b.engine.checkServer()).toEqual({ ok: true, version: 'test', signedIn: false, user: null })
    expect(await b.engine.inspectServer()).toMatchObject({ ok: false, kind: 'signed_out' })
    await vi.advanceTimersByTimeAsync(1)
    expect(await b.engine.useServerCopy()).toMatchObject({ ok: false, kind: 'signed_out' })
    await vi.advanceTimersByTimeAsync(1)
    // Only the health check and attempts to end the session: nothing read the workspace or the user.
    expect(new Set(server.calls.slice(calls))).toEqual(new Set(['health', 'logout']))
    server.logout = realLogout
    expect(b.db().company.name).toBe('Shared computer')
    expect(server.signedIn).toBe(true)
    // Signing in replaces the old session and clears the pending sign-out.
    expect(await b.engine.signIn(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)).toMatchObject({ ok: true })
    expect(storage.data.has(LOGOUT_PENDING_KEY)).toBe(false)
    expect(await b.engine.inspectServer()).toMatchObject({ ok: true, empty: false })
  })

  it('a plain sign-out while offline is never undone when the connection returns (F2)', async () => {
    const server = new FakeServer()
    const link = deviceLink(server)
    const a = forgetful(link)
    expect(await a.engine.uploadLocal()).toEqual({ ok: true })
    await a.engine.whenIdle()
    link.online = false
    const res = await a.engine.signOut()
    expect(res).toEqual({
      ok: true,
      confirmed: false,
      waiting: 0,
      message: 'Signed out in this browser. Your server could not be reached, so its session stays open until this browser reconnects and ends it.',
    })
    expect(a.st()).toMatchObject({ status: 'signed_out', user: null, logoutPending: true })
    a.mutate(rename('p-1', 'Offline after sign-out'))
    link.online = true
    const before = server.calls.length
    a.page.emit('online')
    a.page.emit('focus')
    await vi.advanceTimersByTimeAsync(5_000)
    // The session was ended, not resumed: no me, no pull, no push.
    expect(server.calls.slice(before)).toEqual(['logout'])
    expect(server.signedIn).toBe(false)
    expect(a.st()).toMatchObject({ status: 'signed_out', user: null, logoutPending: false, pending: 1 })
    expect(serverTitle(server, 'p-1')).toBe('Engineer')
  })

  it('a reload after an unconfirmed sign-out does not sync from the old session', async () => {
    const server = new FakeServer()
    const link = deviceLink(server)
    const a = forgetful(link)
    expect(await a.engine.uploadLocal()).toEqual({ ok: true })
    await a.engine.whenIdle()
    link.online = false
    await a.engine.signOut()
    a.engine.stop()
    // Still offline on reload: nothing is sent and the browser shows signed out.
    const offline = device(link, a.db(), a.storage)
    offline.engine.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(offline.st()).toMatchObject({ status: 'signed_out', logoutPending: true })
    offline.engine.stop()
    // Back online on the next reload: the session is ended first; syncing waits for a sign-in.
    link.online = true
    const before = server.calls.length
    const again = device(link, a.db(), a.storage)
    again.engine.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(server.calls.slice(before)).toEqual(['logout'])
    expect(again.st()).toMatchObject({ status: 'signed_out', logoutPending: false })
    expect(await again.engine.signIn(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)).toMatchObject({ ok: true })
    await again.engine.whenIdle()
    expect(again.st().status).toBe('synced')
  })

  it('a disconnect the server could not confirm also ends the session later, and Settings never shows it signed in', async () => {
    const server = new FakeServer()
    const link = deviceLink(server)
    const a = forgetful(link)
    expect(await a.engine.uploadLocal()).toEqual({ ok: true })
    await a.engine.whenIdle()
    link.online = false
    expect(await a.engine.disconnect()).toMatchObject({ ok: true, confirmed: false })
    link.online = true
    expect(await a.engine.checkServer()).toMatchObject({ ok: true, signedIn: false })
    expect(server.signedIn).toBe(false)
    expect(a.st().logoutPending).toBe(false)
  })
})

describe('another tab removed this browser\'s data (F3)', () => {
  it('stops syncing, shows the fresh workspace and never saves the connection or the store again', async () => {
    const server = new FakeServer()
    const persistStore = vi.fn(() => true)
    const db = makeDB()
    db.people.push(makePerson('p-1'))
    const tab = device(server, db, memoryStorage(), { persistStore, freshDB: () => makeDB({ sample: true, company: 'Ledgerlark' }) })
    expect(await tab.engine.uploadLocal()).toEqual({ ok: true })
    await tab.engine.whenIdle()
    // The other tab wiped the storage.
    tab.storage.data.clear()
    persistStore.mockClear()
    tab.engine.dropLocal()
    expect(tab.db().company.name).toBe('Ledgerlark')
    expect(tab.store.getState().past).toEqual([])
    expect(tab.st()).toMatchObject({ mode: 'local', status: 'local', user: null })
    tab.mutate(add('p-after'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect([...tab.storage.data.keys()]).toEqual([])
    expect(persistStore).not.toHaveBeenCalled()
    expect(server.record('people', 'p-after')).toBeUndefined()
  })

  it('a disconnect in another tab stops this tab without writing the connection back', async () => {
    const server = new FakeServer()
    const tab = await uploader(server)
    tab.storage.data.delete(SYNC_STORAGE_KEY)
    tab.engine.disconnectedElsewhere()
    expect(tab.st()).toMatchObject({ mode: 'local', status: 'local' })
    tab.mutate(rename('p-1', 'Local now'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(tab.storage.data.has(SYNC_STORAGE_KEY)).toBe(false)
    expect(serverTitle(server, 'p-1')).toBe('Engineer')
    expect(titleOf(tab, 'p-1')).toBe('Local now')
  })
})

describe('a workspace replaced from another computer (UX F1)', () => {
  /** Computer B starts fresh as another company and replaces the server's workspace with it. */
  async function startFreshOnB(server: FakeServer, company = 'Delta Inc'): Promise<Device> {
    const b = await joiner(server)
    const fresh = makeDB({ company })
    fresh.people.push(makePerson('p-delta'))
    expect(await b.engine.replaceWorkspace(fresh, { label: `Started fresh as ${company}` })).toEqual({ ok: true })
    return b
  }

  it('switches to the server\'s workspace whole, says so, and keeps a copy of what was here', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const before = a.db()
    await startFreshOnB(server)
    a.page.emit('focus')
    await a.engine.whenIdle()
    expect(a.db().company.name).toBe('Delta Inc')
    expect(peopleIds(a.db())).toEqual(['p-delta', 'p-founder'])
    expect(a.st().replacedRemotely).toMatchObject({ companyName: 'Delta Inc', previousName: 'Acme' })
    expect(a.engine.getReplacedBackup()).toBe(before)
    expect(a.store.getState().past).toEqual([])
    expect(a.st().status).toBe('synced')
    a.engine.clearReplacedRemotely()
    expect(a.st().replacedRemotely).toBeNull()
    expect(a.engine.getReplacedBackup()).toBeNull()
  })

  it('never pushes this workspace\'s queued edits or new records into the other one', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    await startFreshOnB(server)
    a.mutate(add('p-new-on-a'))
    a.mutate(rename('p-1', 'Edited on A'))
    await quiet(a)
    // The push was refused as a whole (another history); A loaded the new workspace instead.
    expect(server.record('people', 'p-new-on-a')).toBeUndefined()
    expect(peopleIds(server.snapshot())).toEqual(['p-delta', 'p-founder'])
    expect(a.db().company.name).toBe('Delta Inc')
    expect(a.conn().outbox).toEqual([])
    const backup = a.engine.getReplacedBackup()
    expect(backup?.people.some((p) => p.id === 'p-new-on-a')).toBe(true)
    expect(backup?.people.find((p) => p.id === 'p-1')?.title).toBe('Edited on A')
    expect(a.st().replacedRemotely?.companyName).toBe('Delta Inc')
  })

  it('also notices with a server from before history ids, by the workspace identity', async () => {
    const server = new FakeServer()
    server.historyIds = false
    const a = await uploader(server)
    await startFreshOnB(server)
    a.page.emit('focus')
    await a.engine.whenIdle()
    expect(a.db().company.name).toBe('Delta Inc')
    expect(a.st().replacedRemotely?.companyName).toBe('Delta Inc')
  })

  it('a restore of the same workspace is no swap: queued edits stay and go out, no notice', async () => {
    const server = new FakeServer()
    const link = deviceLink(server)
    const a = await uploader(server, link)
    link.online = false
    a.mutate(rename('p-1', 'Edited before the restore'))
    await quiet(a)
    server.restore()
    link.online = true
    await a.engine.syncNow()
    await quiet(a)
    expect(a.st().replacedRemotely).toBeNull()
    expect(serverTitle(server, 'p-1')).toBe('Edited before the restore')
    expect(a.conn().historyId).toBe(server.historyId)
  })

  it('sends the history id it last saw with pulls and pushes', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    expect(a.conn().historyId).toBe(server.historyId)
    a.mutate(rename('p-1', 'With history'))
    await quiet(a)
    expect(server.sentHistory.length).toBeGreaterThan(0)
    expect(server.sentHistory.every((h) => h === server.historyId)).toBe(true)
  })
})

describe('workspace identity and Undo after connecting (UX F2)', () => {
  it('Start fresh and Import get an identity; an imported backup keeps its own', async () => {
    const server = new FakeServer()
    const d = device(server)
    expect(await d.engine.replaceWorkspace(makeDB({ company: 'Gamma Co' }), { label: 'Started fresh' })).toEqual({ ok: true })
    expect(workspaceIdOf(d.db())).toMatch(/^ws-/)
    const withId = makeDB({ company: 'Backup' })
    ;(withId.meta as { workspaceId?: string }).workspaceId = 'ws-kept'
    expect(await d.engine.replaceWorkspace(withId)).toEqual({ ok: true })
    expect(workspaceIdOf(d.db())).toBe('ws-kept')
  })

  it('uploading clears the Undo history, so Ctrl Z cannot swap the old workspace back over the server', async () => {
    const server = new FakeServer()
    const b = device(server, makeDB({ company: 'Acme Robotics' }))
    b.mutate(add('p-dana'))
    expect(await b.engine.replaceWorkspace(makeDB({ company: 'Gamma Co' }), { label: 'Started fresh as Gamma Co' })).toEqual({ ok: true })
    expect(b.store.getState().past).toHaveLength(2)
    expect(await b.engine.uploadLocal({ confirmReplace: true })).toEqual({ ok: true })
    expect(b.store.getState().past).toEqual([])
    expect(b.store.getState().undo()).toBeNull()
    await quiet(b)
    expect(server.snapshot().company.name).toBe('Gamma Co')
  })

  it('the old same-day workspace put back in the store is a swap that holds, not edits that sync', async () => {
    const server = new FakeServer()
    const b = device(server, makeDB({ company: 'Acme Robotics' }))
    expect(await b.engine.replaceWorkspace(makeDB({ company: 'Gamma Co' }), { label: 'Started fresh as Gamma Co' })).toEqual({ ok: true })
    const oldStep = b.store.getState().past[0]
    expect(await b.engine.uploadLocal({ confirmReplace: true })).toEqual({ ok: true })
    b.store.setState({ db: oldStep.db, past: [] })
    expect(b.st()).toMatchObject({ status: 'local', hold: 'replaced' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(server.snapshot().company.name).toBe('Gamma Co')
  })

  it('a workspace uploaded without an identity gets one, and other computers keep the same one', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const id = workspaceIdOf(a.db())
    expect(id).toMatch(/^ws-/)
    expect(workspaceIdOf(server.snapshot())).toBe(id)
    const b = await joiner(server)
    expect(workspaceIdOf(b.db())).toBe(id)
  })
})

describe('another tab signed out without the server confirming', () => {
  it('this tab stops syncing from the shared session and helps end it', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const pushes = server.pushes.length
    // Tab B of the same browser (same storage) signed out while the server was unreachable.
    a.storage.setItem(LOGOUT_PENDING_KEY, '1')
    a.mutate(rename('p-1', 'Edited in tab A'))
    await quiet(a)
    expect(server.pushes.length).toBe(pushes)
    expect(server.signedIn).toBe(false)
    expect(a.storage.data.has(LOGOUT_PENDING_KEY)).toBe(false)
    expect(a.st()).toMatchObject({ status: 'signed_out', pending: 1 })
  })
})

// ------------------------------------------------------------------------------------------------
// Server review, October 2026 (#3 demo clock, #4 server reset).
// ------------------------------------------------------------------------------------------------

describe('the demo clock, "Pretend today is" (review #3)', () => {
  const REAL = '2026-10-10'
  const PRETEND = '2027-01-04'
  const promotion = { id: 'c-1', personId: 'p-1', effectiveOn: '2027-01-01', payType: 'salary', salary: 150000, title: 'Senior engineer', levelId: 'lv-l4', reason: 'promotion', scheduled: true } as const
  afterEach(() => setClockOverride(REAL))

  /** A synced workspace with a Jan 1 promotion, uploaded by this browser. */
  async function syncedWithPromotion(server: FakeServer) {
    const db = makeDB()
    db.people.push(makePerson('p-1'), makePerson('p-2'), makePerson('p-3'))
    db.comp.push({ ...promotion })
    const a0 = device(server, db)
    expect(await a0.engine.uploadLocal()).toEqual({ ok: true })
    await a0.engine.whenIdle()
    return a0
  }

  /**
   * The page reloads with this saved copy: db.ts applies what is due by today() (the pretend date while
   * `clock.now` is set) before the engine starts, then the engine starts.
   */
  function reload(server: SyncApi, saved: DB, storage: ReturnType<typeof memoryStorage>, clock: { now: string | null }) {
    setClockOverride(clock.now ?? REAL)
    const loaded = applyLoadChanges(saved)
    setClockOverride(REAL)
    const d = device(server, loaded, storage, { baseline: () => saved, onLoad: applyLoadChanges, clockOverride: () => clock.now })
    d.engine.start()
    return d
  }
  const appliedOn = (db: DB) => db.comp.find((c) => c.id === 'c-1')?.appliedOn
  const serverComp = (server: FakeServer) => server.record('comp', 'c-1') as { appliedOn?: string }

  it('a pretend date while connected holds the connection: nothing it applies, and nothing edited meanwhile, is sent', async () => {
    const server = new FakeServer()
    const a0 = await syncedWithPromotion(server)
    a0.engine.stop()
    const clock = { now: PRETEND as string | null }
    const a = reload(server, a0.db(), a0.storage, clock)
    await a.engine.whenIdle()
    // The store shows the promotion as of the pretend date, but the server never hears of it.
    expect(titleOf(a, 'p-1')).toBe('Senior engineer')
    expect(serverTitle(server, 'p-1')).toBe('Engineer')
    expect(serverComp(server).appliedOn).toBeUndefined()
    expect(a.st()).toMatchObject({ status: 'local', hold: 'demo_clock', pending: 0 })
    const calls = server.calls.length
    a.mutate(rename('p-2', 'Edited while pretending'))
    await quiet(a)
    a.page.emit('focus')
    a.page.emit('online')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(server.calls.length).toBe(calls)
    expect(a.st()).toMatchObject({ hold: 'demo_clock', pending: 0 })
  })

  it('connecting, uploading or replacing the workspace is refused while pretending', async () => {
    const server = new FakeServer()
    await syncedWithPromotion(server)
    const b = device(server, makeDB({ company: 'Elsewhere' }), memoryStorage(), { onLoad: applyLoadChanges, clockOverride: () => PRETEND })
    const refused = await b.engine.useServerCopy()
    expect(refused).toMatchObject({ ok: false, kind: 'demo_clock' })
    if (!refused.ok) expect(refused.message).not.toMatch(/—/)
    expect(await b.engine.uploadLocal({ confirmReplace: true })).toMatchObject({ ok: false, kind: 'demo_clock' })
    expect(b.conn().mode).toBe('local')
    expect(server.snapshot().company.name).toBe('Acme')
    // Connected (before the pretend date), Import and Start fresh are refused too.
    const a = await joiner(server)
    const c = device(server, a.db(), a.storage, { onLoad: applyLoadChanges, clockOverride: () => PRETEND })
    expect(await c.engine.replaceWorkspace(makeDB({ company: 'Gamma Co' }))).toMatchObject({ ok: false, kind: 'demo_clock' })
    expect(server.snapshot().company.name).toBe('Acme')
  })

  it('going back to the real date takes the server\'s copy again: what the pretend date applied never syncs, earlier queued edits do', async () => {
    const server = new FakeServer()
    const a0 = await syncedWithPromotion(server)
    // Queued before the pretend date (offline): a real edit that must still reach the server.
    server.online = false
    a0.mutate(rename('p-2', 'Queued before'))
    await quiet(a0)
    expect(a0.st().pending).toBe(1)
    a0.engine.stop()
    server.online = true
    const clock = { now: PRETEND as string | null }
    const a = reload(server, a0.db(), a0.storage, clock)
    await a.engine.whenIdle()
    a.mutate(rename('p-3', 'Edited while pretending'))
    // Another device keeps working meanwhile.
    const b = await joiner(server)
    b.mutate(rename('p-1', 'Renamed on B'))
    await quiet(b)
    a.engine.stop()
    // Reset to real date: the page reloads with what this browser saved during the demo.
    clock.now = null
    const saved = a.db()
    expect(appliedOn(saved)).toBe(PRETEND)
    const a2 = reload(server, saved, a0.storage, clock)
    await a2.engine.whenIdle()
    await quiet(a2)
    expect(a2.st()).toMatchObject({ status: 'synced', hold: null, pending: 0, refreshed: 0 })
    expect(serverTitle(server, 'p-1')).toBe('Renamed on B')
    expect(serverComp(server).appliedOn).toBeUndefined()
    expect(serverTitle(server, 'p-2')).toBe('Queued before')
    expect(serverTitle(server, 'p-3')).toBe('Engineer')
    expect(titleOf(a2, 'p-1')).toBe('Renamed on B')
    expect(appliedOn(a2.db())).toBeUndefined()
    expect(titleOf(a2, 'p-3')).toBe('Engineer')
    expect(a2.store.getState().past).toEqual([])
    expect(diffDB(a2.db(), server.snapshot())).toEqual([])
    // On its real date the promotion takes effect the ordinary way, and syncs.
    a2.engine.stop()
    setClockOverride('2027-01-02')
    const loaded = applyLoadChanges(a2.db())
    const a3 = device(server, loaded, a0.storage, { baseline: () => a2.db(), onLoad: applyLoadChanges, clockOverride: () => null })
    a3.engine.start()
    await a3.engine.whenIdle()
    await quiet(a3)
    expect(titleOf(a3, 'p-1')).toBe('Senior engineer')
    expect(serverComp(server).appliedOn).toBe('2027-01-02')
  })

  it('edits made after going back, before the server answers, survive a reload and sync', async () => {
    const server = new FakeServer()
    const a0 = await syncedWithPromotion(server)
    a0.engine.stop()
    const clock = { now: PRETEND as string | null }
    const a = reload(server, a0.db(), a0.storage, clock)
    await a.engine.whenIdle()
    a.engine.stop()
    clock.now = null
    server.online = false
    const a2 = reload(server, a.db(), a0.storage, clock)
    await a2.engine.whenIdle()
    expect(a2.st()).toMatchObject({ status: 'offline', hold: null })
    a2.mutate(rename('p-2', 'After going back'))
    await quiet(a2)
    expect(server.calls.filter((c) => c === 'postChanges')).toHaveLength(0)
    a2.engine.stop()
    const a3 = reload(server, a2.db(), a0.storage, clock)
    await a3.engine.whenIdle()
    server.online = true
    await a3.engine.syncNow()
    await quiet(a3)
    expect(serverTitle(server, 'p-2')).toBe('After going back')
    expect(serverTitle(server, 'p-1')).toBe('Engineer')
    expect(titleOf(a3, 'p-1')).toBe('Engineer')
    expect(titleOf(a3, 'p-2')).toBe('After going back')
    expect(serverComp(server).appliedOn).toBeUndefined()
    expect(a3.st()).toMatchObject({ status: 'synced', hold: null, pending: 0 })
    expect(diffDB(a3.db(), server.snapshot())).toEqual([])
  })

  const setPhone = (id: string, phone: string): Recipe => (d) => {
    d.people.find((p) => p.id === id)!.phone = phone
  }

  // Re-review: back on the real date with the server out of reach, the store still showed the pretend
  // copy, and an edit to the promoted person carried the promotion to the server.
  it('going back while the server cannot be reached shows the real date at once, so an edit to the promoted person carries nothing pretend', async () => {
    const server = new FakeServer()
    const a0 = await syncedWithPromotion(server)
    a0.engine.stop()
    const clock = { now: PRETEND as string | null }
    const a = reload(server, a0.db(), a0.storage, clock)
    await a.engine.whenIdle()
    a.mutate(rename('p-3', 'Edited while pretending'))
    a.engine.stop()
    clock.now = null
    server.online = false
    const a2 = reload(server, a.db(), a0.storage, clock)
    await a2.engine.whenIdle()
    expect(titleOf(a2, 'p-1')).toBe('Engineer')
    expect(appliedOn(a2.db())).toBeUndefined()
    expect(titleOf(a2, 'p-3')).toBe('Engineer')
    expect(a2.st()).toMatchObject({ status: 'offline', hold: null })
    a2.mutate(setPhone('p-1', '555-0199'))
    await quiet(a2)
    server.online = true
    await a2.engine.syncNow()
    await quiet(a2)
    expect(server.record('people', 'p-1')).toMatchObject({ title: 'Engineer', levelId: 'lv-l3', phone: '555-0199' })
    expect(serverComp(server).appliedOn).toBeUndefined()
    expect(serverTitle(server, 'p-3')).toBe('Engineer')
    expect(a2.st()).toMatchObject({ status: 'synced', hold: null, pending: 0 })
    expect(diffDB(a2.db(), server.snapshot())).toEqual([])
  })

  // Re-review: a tab on the real date saved its connection (hold null) over the pretending tab's hold.
  it('a second tab on the real date cannot make this tab forget that its saved copy holds pretend changes', async () => {
    const server = new FakeServer()
    const a0 = await syncedWithPromotion(server)
    // Tab B: the same browser (storage), opened before the clock was set, stays on the real date.
    const tabB = device(server, a0.db(), a0.storage, { onLoad: applyLoadChanges, clockOverride: () => null })
    tabB.engine.start()
    await tabB.engine.whenIdle()
    a0.engine.stop()
    const clock = { now: PRETEND as string | null }
    const a = reload(server, a0.db(), a0.storage, clock)
    await a.engine.whenIdle()
    a.mutate(rename('p-3', 'Edited while pretending'))
    const savedPretend = a.db()
    // Another computer edits; tab B pulls it and saves its own connection, with no hold.
    const c = await joiner(server)
    c.mutate(rename('p-2', 'From another computer'))
    await quiet(c)
    await tabB.engine.syncNow()
    expect(loadConnection(a0.storage).hold).toBeNull()
    a.engine.stop()
    clock.now = null
    const a2 = reload(server, savedPretend, a0.storage, clock)
    await a2.engine.whenIdle()
    await quiet(a2)
    expect(titleOf(a2, 'p-1')).toBe('Engineer')
    expect(titleOf(a2, 'p-3')).toBe('Engineer')
    expect(titleOf(a2, 'p-2')).toBe('From another computer')
    a2.mutate(setPhone('p-1', '555-0123'))
    await quiet(a2)
    expect(server.record('people', 'p-1')).toMatchObject({ title: 'Engineer', levelId: 'lv-l3', phone: '555-0123' })
    expect(serverTitle(server, 'p-3')).toBe('Engineer')
    expect(serverComp(server).appliedOn).toBeUndefined()
    expect(diffDB(a2.db(), server.snapshot())).toEqual([])
  })

  it("without a copy from before the pretend date, going back keeps the hold and queues nothing until the server's copy is in", async () => {
    const server = new FakeServer()
    const a0 = await syncedWithPromotion(server)
    a0.engine.stop()
    // A browser that refuses to store the copy (its storage is full).
    const full: ReturnType<typeof memoryStorage> = {
      data: a0.storage.data,
      getItem: (k) => a0.storage.getItem(k),
      setItem: (k, v) => {
        if (k === CLOCK_COPY_KEY) throw new Error('QuotaExceededError')
        a0.storage.setItem(k, v)
      },
      removeItem: (k) => a0.storage.removeItem(k),
    }
    const clock = { now: PRETEND as string | null }
    const a = reload(server, a0.db(), full, clock)
    await a.engine.whenIdle()
    expect(full.getItem(CLOCK_COPY_KEY)).toBeNull()
    a.engine.stop()
    clock.now = null
    server.online = false
    const a2 = reload(server, a.db(), full, clock)
    await a2.engine.whenIdle()
    expect(a2.st()).toMatchObject({ status: 'local', hold: 'demo_clock' })
    a2.mutate(setPhone('p-1', '555-0100'))
    expect(a2.st().pending).toBe(0)
    expect(await a2.engine.uploadLocal({ confirmReplace: true })).toMatchObject({ ok: false, kind: 'demo_clock' })
    await a2.engine.whenIdle()
    server.online = true
    await a2.engine.syncNow()
    await quiet(a2)
    expect(titleOf(a2, 'p-1')).toBe('Engineer')
    expect(server.record('people', 'p-1')).toMatchObject({ title: 'Engineer', levelId: 'lv-l3' })
    expect((server.record('people', 'p-1') as { phone?: string }).phone).toBeUndefined()
    expect(a2.st()).toMatchObject({ status: 'synced', hold: null, pending: 0 })
    expect(diffDB(a2.db(), server.snapshot())).toEqual([])
  })

  it('a tab still pretending after another tab went back keeps its own way back to the copy from before the pretend date', async () => {
    const server = new FakeServer()
    const a0 = await syncedWithPromotion(server)
    a0.engine.stop()
    const clockA = { now: PRETEND as string | null }
    const a = reload(server, a0.db(), a0.storage, clockA)
    await a.engine.whenIdle()
    // Tab B opens while the browser pretends.
    const clockB = { now: PRETEND as string | null }
    const b = reload(server, a.db(), a0.storage, clockB)
    await b.engine.whenIdle()
    // Tab A goes back to the real date first.
    a.engine.stop()
    clockA.now = null
    const a2 = reload(server, a.db(), a0.storage, clockA)
    await a2.engine.whenIdle()
    await quiet(a2)
    expect(titleOf(a2, 'p-1')).toBe('Engineer')
    // Tab B, still pretending, edits (the browser saves its pretend copy), then goes back too.
    b.mutate(rename('p-3', 'Edited while pretending'))
    b.engine.stop()
    clockB.now = null
    const b2 = reload(server, b.db(), a0.storage, clockB)
    await b2.engine.whenIdle()
    await quiet(b2)
    expect(titleOf(b2, 'p-1')).toBe('Engineer')
    expect(titleOf(b2, 'p-3')).toBe('Engineer')
    b2.mutate(setPhone('p-1', '555-0142'))
    await quiet(b2)
    expect(server.record('people', 'p-1')).toMatchObject({ title: 'Engineer', levelId: 'lv-l3', phone: '555-0142' })
    expect(serverTitle(server, 'p-3')).toBe('Engineer')
    expect(serverComp(server).appliedOn).toBeUndefined()
  })
})

describe('after the server lost its workspace (review #4)', () => {
  /** Two synced browsers; the server is reset; both find out and hold. B had an edit queued. */
  async function resetWithTwoBrowsers() {
    const server = new FakeServer()
    const a = await uploader(server)
    const b = await joiner(server)
    server.loseWorkspace()
    b.mutate(rename('p-1', 'Queued on B'))
    await quiet(b)
    await a.engine.syncNow()
    expect(a.st()).toMatchObject({ status: 'local', hold: 'server_empty' })
    expect(b.st()).toMatchObject({ status: 'local', hold: 'server_empty' })
    return { server, a, b }
  }

  it('edits made during the hold are queued but not sent', async () => {
    const { server, b } = await resetWithTwoBrowsers()
    b.mutate(add('p-hold', 'Added during the hold'))
    expect(b.conn().outbox.map((e) => e.id)).toEqual(['p-1', 'p-hold'])
    expect(b.st().pendingEdits).toBe(2)
    const calls = server.calls.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(server.calls.length).toBe(calls)
  })

  it('a browser that comes back after another one re-uploaded joins it, with its own edits on top', async () => {
    const { server, a, b } = await resetWithTwoBrowsers()
    b.mutate(add('p-hold', 'Added during the hold'))
    a.mutate(rename('p-2', 'Edited on A during the hold'))
    expect(await a.engine.uploadLocal()).toEqual({ ok: true })
    await a.engine.whenIdle()
    // B's tab gets focus again: it looks at the server, finds the same workspace, and syncs on top of it.
    b.page.emit('focus')
    await quiet(b)
    expect(b.st()).toMatchObject({ status: 'synced', hold: null, pending: 0, refreshed: 0 })
    expect(serverTitle(server, 'p-1')).toBe('Queued on B')
    expect(serverTitle(server, 'p-hold')).toBe('Added during the hold')
    expect(serverTitle(server, 'p-2')).toBe('Edited on A during the hold')
    expect(titleOf(b, 'p-2')).toBe('Edited on A during the hold')
    await a.engine.syncNow()
    expect(titleOf(a, 'p-hold')).toBe('Added during the hold')
    expect(diffDB(a.db(), server.snapshot())).toEqual([])
    expect(diffDB(b.db(), server.snapshot())).toEqual([])
  })

  it('Upload from the hold, after another browser got there first, joins instead of getting stuck', async () => {
    const { server, a, b } = await resetWithTwoBrowsers()
    b.mutate(add('p-hold', 'Added during the hold'))
    expect(await a.engine.uploadLocal()).toEqual({ ok: true })
    const res = await b.engine.uploadLocal()
    expect(res).toMatchObject({ ok: true })
    expect(res.ok && res.message).toMatch(/another computer/i)
    await quiet(b)
    expect(b.st()).toMatchObject({ status: 'synced', hold: null, pending: 0 })
    expect(serverTitle(server, 'p-1')).toBe('Queued on B')
    expect(serverTitle(server, 'p-hold')).toBe('Added during the hold')
  })

  it('on start, a different workspace on the server is taken whole, with a copy of what was here', async () => {
    const { server, b } = await resetWithTwoBrowsers()
    b.mutate(add('p-hold', 'Added during the hold'))
    const c = device(server, importedWorkspace())
    expect(await c.engine.uploadLocal()).toEqual({ ok: true })
    b.engine.stop()
    const b2 = device(server, b.db(), b.storage)
    b2.engine.start()
    await quiet(b2)
    expect(b2.db().company.name).toBe('Imported Co')
    expect(b2.st()).toMatchObject({ hold: null, status: 'synced', replacedRemotely: { companyName: 'Imported Co', previousName: 'Acme' } })
    expect(b2.engine.getReplacedBackup()?.people.some((p) => p.id === 'p-hold')).toBe(true)
    expect(server.record('people', 'p-hold')).toBeUndefined()
  })

  it('Use the server\'s copy from the hold keeps waiting edits for the same workspace, and asks first for another one', async () => {
    const { server, a, b } = await resetWithTwoBrowsers()
    b.mutate(add('p-hold', 'Added during the hold'))
    expect(await a.engine.uploadLocal()).toEqual({ ok: true })
    expect(await b.engine.useServerCopy()).toEqual({ ok: true })
    await quiet(b)
    expect(serverTitle(server, 'p-hold')).toBe('Added during the hold')
    expect(b.st()).toMatchObject({ hold: null, pending: 0 })

    const two = await resetWithTwoBrowsers()
    two.b.mutate(add('p-hold', 'Added during the hold'))
    const c = device(two.server, importedWorkspace())
    expect(await c.engine.uploadLocal()).toEqual({ ok: true })
    const asked = await two.b.engine.useServerCopy()
    expect(asked).toMatchObject({ ok: false, kind: 'pending' })
    expect(two.b.st().hold).toBe('server_empty')
    expect(await two.b.engine.useServerCopy({ discardPending: true })).toEqual({ ok: true })
    expect(two.b.db().company.name).toBe('Imported Co')
  })

  // Re-review: joining sent every queued edit on the uploaded copy's versions, so an edit made on an old
  // copy silently beat a newer one that the server would have kept without the reset.
  for (const how of ['focus', 'upload', 'server copy'] as const) {
    it(`an edit queued on an old copy loses to the newer one in the re-uploaded copy, as any conflict would (joined by ${how})`, async () => {
      const server = new FakeServer()
      const a = await uploader(server)
      const link = deviceLink(server)
      const b = await joiner(server, link)
      link.online = false
      b.mutate(rename('p-1', 'B offline (old)'))
      b.mutate(rename('p-2', 'B offline, untouched elsewhere'))
      await quiet(b)
      a.mutate(rename('p-1', 'A newer'))
      await quiet(a)
      server.loseWorkspace()
      link.online = true
      await b.engine.syncNow()
      expect(b.st().hold).toBe('server_empty')
      await a.engine.syncNow()
      expect(a.st().hold).toBe('server_empty')
      expect(await a.engine.uploadLocal()).toEqual({ ok: true })
      await a.engine.whenIdle()
      if (how === 'focus') b.page.emit('focus')
      else if (how === 'upload') expect(await b.engine.uploadLocal()).toMatchObject({ ok: true })
      else expect(await b.engine.useServerCopy()).toEqual({ ok: true })
      await quiet(b)
      expect(serverTitle(server, 'p-1')).toBe('A newer')
      expect(titleOf(b, 'p-1')).toBe('A newer')
      // An edit to a record the uploaded copy still has as it was goes on top.
      expect(serverTitle(server, 'p-2')).toBe('B offline, untouched elsewhere')
      expect(b.st()).toMatchObject({ status: 'synced', hold: null, pending: 0, refreshed: 1 })
      expect(diffDB(b.db(), server.snapshot())).toEqual([])
    })
  }

  it('when both computers edit one record during the hold, the copy uploaded first wins it, as any conflict would', async () => {
    const { server, a, b } = await resetWithTwoBrowsers()
    b.mutate(rename('p-2', 'B during the hold'))
    a.mutate(rename('p-2', 'A during the hold'))
    expect(await a.engine.uploadLocal()).toEqual({ ok: true })
    await a.engine.whenIdle()
    b.page.emit('focus')
    await quiet(b)
    expect(serverTitle(server, 'p-2')).toBe('A during the hold')
    expect(titleOf(b, 'p-2')).toBe('A during the hold')
    // B's edit to a record A left alone still goes on top.
    expect(serverTitle(server, 'p-1')).toBe('Queued on B')
    expect(b.st()).toMatchObject({ status: 'synced', hold: null, pending: 0, refreshed: 1 })
  })
})

// ---------------------------------------------------------------------------------------------
// End-to-end review, package P1 (sync engine)
// ---------------------------------------------------------------------------------------------

/** A rename that also logs an activity row about the person, as the app's edits do. */
const renameLogged =
  (id: string, title: string, rowId: string): Recipe =>
  (d) => {
    d.people.find((p) => p.id === id)!.title = title
    d.activity.push({ id: rowId, at: '2026-10-10T17:00:00.000Z', entityType: 'person', entityId: id, kind: 'edited', text: `Renamed to ${title}` })
  }
const hasRow = (db: DB, id: string) => db.activity.some((r) => r.id === id)
const labels = (dev: Device) => dev.store.getState().past.map((e) => e.label)

describe("an edit the server's copy replaced leaves no trace (r1-01)", () => {
  it('names the record, and drops its Undo step and the activity row it logged, here and on the server', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const b = await joiner(server)
    b.mutate(rename('p-1', 'B wins'))
    await quiet(b)
    a.store.getState().mutate('Renamed p-1', renameLogged('p-1', 'A loses', 'act-a-lost'))
    expect(labels(a)).toEqual(['Renamed p-1'])
    await quiet(a)
    expect(titleOf(a, 'p-1')).toBe('B wins')
    expect(a.st()).toMatchObject({ refreshed: 1, refreshedKeys: [{ collection: 'people', id: 'p-1' }], pending: 0 })
    // Nothing claims the edit any more: no Undo step, no activity row here or on the server.
    expect(labels(a)).toEqual([])
    expect(hasRow(a.db(), 'act-a-lost')).toBe(false)
    expect(server.record('activity', 'act-a-lost')).toBeUndefined()
    await b.engine.syncNow()
    expect(hasRow(b.db(), 'act-a-lost')).toBe(false)
    expect(diffDB(a.db(), server.snapshot())).toEqual([])
  })

  it('keeps the Undo step and the row of an edit that also changed something that stayed', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const b = await joiner(server)
    b.mutate(rename('p-1', 'B wins'))
    await quiet(b)
    a.store.getState().mutate('Renamed two people', (d) => {
      renameLogged('p-1', 'A loses', 'act-two')(d)
      d.people.find((p) => p.id === 'p-2')!.title = 'A keeps'
    })
    await quiet(a)
    expect(titleOf(a, 'p-1')).toBe('B wins')
    expect(serverTitle(server, 'p-2')).toBe('A keeps')
    expect(labels(a)).toEqual(['Renamed two people'])
    expect(server.record('activity', 'act-two')).toBeTruthy()
  })

  it('after a reload (no Undo history), the unsynced row about the lost record goes too', async () => {
    const server = new FakeServer()
    const link = deviceLink(server)
    const a0 = await uploader(server, link)
    link.online = false
    a0.mutate(renameLogged('p-1', 'A offline', 'act-offline'))
    await quiet(a0)
    a0.engine.stop()
    const a = device(link, a0.db(), a0.storage)
    a.engine.start()
    await a.engine.whenIdle()
    const b = await joiner(server)
    b.mutate(rename('p-1', 'B meanwhile'))
    await quiet(b)
    link.online = true
    await a.engine.syncNow()
    await quiet(a)
    expect(titleOf(a, 'p-1')).toBe('B meanwhile')
    expect(hasRow(a.db(), 'act-offline')).toBe(false)
    expect(server.record('activity', 'act-offline')).toBeUndefined()
    expect(a.st()).toMatchObject({ refreshed: 1, pending: 0 })
  })

  it('counts a record once while the notice shows, newest last', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const b = await joiner(server)
    for (const [id, round] of [['p-1', 1], ['p-2', 1], ['p-1', 2]] as const) {
      b.mutate(rename(id, `B ${round}`))
      await quiet(b)
      a.mutate(rename(id, `A ${round}`))
      await quiet(a)
    }
    expect(a.st().refreshed).toBe(2)
    expect(a.st().refreshedKeys).toEqual([
      { collection: 'people', id: 'p-2' },
      { collection: 'people', id: 'p-1' },
    ])
    a.engine.clearRefreshed()
    expect(a.st()).toMatchObject({ refreshed: 0, refreshedKeys: [] })
  })
})

describe('documents merged by field (r1-02)', () => {
  it('two devices editing different fields of the company record both keep their edit', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const b = await joiner(server)
    a.mutate((d) => {
      d.company.website = 'https://a.example'
    })
    await quiet(a)
    b.store.getState().mutate('Updated HQ and pay schedule', (d) => {
      d.company.phone = '408-555-0100'
      d.company.regularPayday = 'the 15th and the last day of each month'
    })
    await quiet(b)
    expect(server.record('$doc', 'company')).toMatchObject({ website: 'https://a.example', phone: '408-555-0100' })
    expect(b.db().company).toMatchObject({ website: 'https://a.example', phone: '408-555-0100' })
    expect(b.st()).toMatchObject({ refreshed: 0, pending: 0 })
    expect(labels(b)).toEqual(['Updated HQ and pay schedule'])
    // Undo on B reverts B's fields only, never what A did.
    b.store.getState().undo()
    expect(b.db().company.website).toBe('https://a.example')
    expect(b.db().company.phone).toBeUndefined()
    await quiet(b)
    await a.engine.syncNow()
    expect(a.db().company.website).toBe('https://a.example')
    expect(a.db().company.phone).toBeUndefined()
    expect(diffDB(a.db(), server.snapshot())).toEqual([])
  })

  it('the same field edited on both: the server wins, and the record is named', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const b = await joiner(server)
    a.mutate((d) => {
      d.company.phone = '408-555-0101'
    })
    await quiet(a)
    b.mutate((d) => {
      d.company.phone = '408-555-0199'
      d.company.website = 'https://b.example'
    })
    await quiet(b)
    expect(b.db().company.phone).toBe('408-555-0101')
    expect(b.db().company.website).toBeUndefined()
    expect(b.st()).toMatchObject({ refreshed: 1, refreshedKeys: [{ collection: '$doc', id: 'company' }], pending: 0 })
  })

  it('a document queued before field tracking existed stays whole-record', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const b = await joiner(server)
    a.mutate((d) => {
      d.company.website = 'https://a.example'
    })
    await quiet(a)
    b.engine.stop()
    b.mutate((d) => {
      d.company.phone = '408-555-0100'
    })
    // Saved by an older build: the key is queued, with no field prints.
    saveConnection(b.storage, { ...b.conn(), outbox: [{ collection: '$doc', id: 'company', op: 'upsert', rev: 1, at: 0 }], fieldBases: {} })
    const b2 = device(server, b.db(), b.storage)
    b2.engine.start()
    await quiet(b2)
    expect(b2.db().company.phone).toBeUndefined()
    expect(b2.st().refreshed).toBe(1)
  })
})

describe('a server copy from another history of this workspace (r1-03, r1-12)', () => {
  /** A and B synced; B goes offline with a queued edit; the server is reset and A uploads its copy again. */
  async function resetWhileBOffline(editOnA?: Recipe) {
    const server = new FakeServer()
    const a = await uploader(server)
    const link = deviceLink(server)
    const b = await joiner(server, link)
    link.online = false
    b.mutate(rename('p-1', 'Tagged on B'))
    await quiet(b)
    server.loseWorkspace()
    await a.engine.syncNow()
    expect(a.st().hold).toBe('server_empty')
    if (editOnA) a.mutate(editOnA)
    expect(await a.engine.uploadLocal()).toEqual({ ok: true })
    await a.engine.whenIdle()
    link.online = true
    return { server, a, b }
  }

  it('keeps an edit queued on the copy the server still has and sends it, after a 409 resync (never a 404)', async () => {
    const { server, b } = await resetWhileBOffline()
    const before = server.pushes.length
    await b.engine.syncNow()
    await quiet(b)
    // The first push was refused whole (another history); the second carried the edit on the new version.
    expect(server.pushes.length).toBe(before + 2)
    expect(serverTitle(server, 'p-1')).toBe('Tagged on B')
    expect(b.st()).toMatchObject({ status: 'synced', hold: null, pending: 0, refreshed: 0 })
    expect(b.st().restoredRemotely).not.toBeNull()
    expect(diffDB(b.db(), server.snapshot())).toEqual([])
  })

  it('an edit to a record the re-uploaded copy changed loses, named, as any conflict would', async () => {
    const { server, b } = await resetWhileBOffline(rename('p-1', 'A during the hold'))
    await b.engine.syncNow()
    await quiet(b)
    expect(serverTitle(server, 'p-1')).toBe('A during the hold')
    expect(titleOf(b, 'p-1')).toBe('A during the hold')
    expect(b.st()).toMatchObject({ pending: 0, refreshed: 1, refreshedKeys: [{ collection: 'people', id: 'p-1' }] })
  })

  it('another computer importing an older backup of this workspace says so here, and only here (r1-12)', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const b = await joiner(server)
    const backup = structuredClone(a.db())
    b.mutate(rename('p-1', 'After the backup'))
    await quiet(b)
    await a.engine.syncNow()
    expect(await a.engine.replaceWorkspace(backup, { label: 'Imported a backup' })).toEqual({ ok: true })
    await a.engine.whenIdle()
    b.page.emit('focus')
    await b.engine.whenIdle()
    expect(titleOf(b, 'p-1')).toBe('Engineer')
    expect(b.st()).toMatchObject({ replacedRemotely: null, restoredRemotely: { at: expect.any(String) } })
    // The computer that imported knows what it did: no notice there.
    await a.engine.syncNow()
    expect(a.st().restoredRemotely).toBeNull()
    b.engine.clearRestoredRemotely()
    expect(b.st().restoredRemotely).toBeNull()
  })
})

describe('signing out with changes waiting (r1-04, r1-10, r1-13)', () => {
  it('a plain sign-out sends queued changes first while the session still works', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    a.mutate(rename('p-1', 'Sent before sign-out'))
    expect(await a.engine.signOut()).toMatchObject({ ok: true, confirmed: true, waiting: 0 })
    expect(serverTitle(server, 'p-1')).toBe('Sent before sign-out')
    expect(server.calls.filter((c) => c === 'postChanges' || c === 'logout').slice(-2)).toEqual(['postChanges', 'logout'])
    expect(a.st()).toMatchObject({ status: 'signed_out', pending: 0, signedOutByUser: true })
  })

  it('says how many changes could not be sent, and keeps calling it a sign-out until the next sign-in', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    server.failures.push({ ok: false, kind: 'server', status: 503, error: null })
    a.mutate(rename('p-1', 'Not sent'))
    const res = await a.engine.signOut()
    expect(res).toMatchObject({ ok: true, confirmed: true, waiting: 1 })
    expect(res.ok && res.message).toBe(
      'Signed out. This browser keeps an offline copy. 1 change was not sent yet; it syncs after you sign in again in this browser.',
    )
    a.mutate(rename('p-2', 'Queued while signed out'))
    expect(a.st()).toMatchObject({ status: 'signed_out', pendingEdits: 2, signedOutByUser: true })
    // A reload still knows the sign-out was on purpose.
    a.engine.stop()
    const a2 = device(server, a.db(), a.storage)
    a2.engine.start()
    await a2.engine.whenIdle()
    expect(a2.st()).toMatchObject({ status: 'signed_out', pendingEdits: 2, signedOutByUser: true })
    expect(await a2.engine.signIn(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)).toMatchObject({ ok: true })
    expect(a2.st().signedOutByUser).toBe(false)
    await a2.engine.whenIdle()
    expect(serverTitle(server, 'p-2')).toBe('Queued while signed out')
  })

  it('a session that ended on its own is not called a sign-out', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    server.signedIn = false
    a.mutate(rename('p-1', 'After the session ended'))
    await quiet(a)
    expect(a.st()).toMatchObject({ status: 'signed_out', signedOutByUser: false })
  })

  it('signed out, removing this browser\'s data says to sign in first, not to sync (r1-13)', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    expect(await a.engine.signOut()).toMatchObject({ ok: true })
    a.mutate(renameLogged('p-1', 'Waiting', 'act-waiting'))
    const res = await a.engine.signOut({ forgetThisBrowser: true })
    expect(res).toMatchObject({ ok: false, kind: 'pending', pending: 1 })
    expect(!res.ok && res.message).toBe(
      "1 change has not reached the server. Removing this browser's data now loses it. Sign in to send it first, or remove it anyway.",
    )
  })
})

describe('a change too large to sync (r1-05)', () => {
  const bigNote =
    (id: string): Recipe =>
    (d) => {
      d.activity.push({ id, at: '2026-10-10T17:00:00.000Z', entityType: 'person', entityId: 'p-1', kind: 'note', text: 'x'.repeat(300_000) })
    }

  it('is set aside as too large, never retried, and Discard removes it with its Undo step', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const before = server.pushes.length
    a.store.getState().mutate('Added a note', bigNote('act-big'))
    await quiet(a)
    expect(server.pushes.length).toBe(before)
    expect(a.st()).toMatchObject({ rejected: 1, rejectedKeys: [{ collection: 'activity', id: 'act-big', tooLarge: true }] })
    a.engine.retryRejected()
    await quiet(a)
    expect(server.pushes.length).toBe(before)
    expect(a.st().rejected).toBe(1)
    const reads = server.callCount('getWorkspace')
    expect(await a.engine.discardRejected()).toEqual({ ok: true })
    // The server never had it: nothing to fetch, nothing to undo.
    expect(server.callCount('getWorkspace')).toBe(reads)
    expect(hasRow(a.db(), 'act-big')).toBe(false)
    expect(labels(a)).toEqual([])
    expect(a.st()).toMatchObject({ rejected: 0, pending: 0, rejectedKeys: [] })
  })

  it("Discard puts back the server's copy of a record the server has, with no Undo step", async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    a.mutate((d) => {
      d.people.find((p) => p.id === 'p-2')!.notes = 'x'.repeat(300 * 1024)
    })
    await quiet(a)
    expect(a.st().rejectedKeys).toEqual([{ collection: 'people', id: 'p-2', tooLarge: true }])
    expect(await a.engine.discardRejected([{ collection: 'people', id: 'p-2' }])).toEqual({ ok: true })
    expect(a.db().people.find((p) => p.id === 'p-2')?.notes).toBeUndefined()
    expect(diffDB(a.db(), server.snapshot())).toEqual([])
    expect(labels(a)).toEqual([])
    a.mutate(rename('p-2', 'After discard'))
    await quiet(a)
    expect(serverTitle(server, 'p-2')).toBe('After discard')
  })

  it("Discard changes nothing when the server's copy cannot be fetched", async () => {
    const server = new FakeServer()
    const link = deviceLink(server)
    const a = await uploader(server, link)
    a.mutate((d) => {
      d.people.find((p) => p.id === 'p-2')!.notes = 'x'.repeat(300 * 1024)
    })
    await quiet(a)
    link.online = false
    expect(await a.engine.discardRejected()).toMatchObject({ ok: false, kind: 'offline' })
    expect(a.st().rejected).toBe(1)
    expect(a.db().people.find((p) => p.id === 'p-2')?.notes).toHaveLength(300 * 1024)
  })
})

describe('counting waiting changes as a person does (r1-09)', () => {
  it('an edit and its activity row count once; a note on its own counts; every message says the same', async () => {
    const server = new FakeServer()
    const link = deviceLink(server)
    const a = await uploader(server, link)
    link.online = false
    a.mutate(renameLogged('p-1', 'Offline', 'act-offline'))
    expect(a.st()).toMatchObject({ pending: 2, pendingEdits: 1 })
    a.mutate((d) => {
      d.activity.push({ id: 'act-note', at: '2026-10-10T17:00:00.000Z', entityType: 'person', entityId: 'p-3', kind: 'note', text: 'Called back' })
    })
    expect(a.st()).toMatchObject({ pending: 3, pendingEdits: 2 })
    expect(await a.engine.disconnect()).toMatchObject({ ok: false, kind: 'pending', pending: 2 })
    expect(await a.engine.signOut({ forgetThisBrowser: true })).toMatchObject({ ok: false, kind: 'pending', pending: 2 })
  })
})

describe('offers past their expiry date (r1-08)', () => {
  function withSentOffer(): DB {
    const db = makeDB()
    db.offers.push({ id: 'o-1', applicationId: 'a-1', candidateId: 'c-1', jobId: 'j-1', status: 'sent', expiresOn: '2026-10-07' } as unknown as DB['offers'][number])
    return db
  }
  const expiredRows = (db: DB) => db.activity.filter((r) => r.kind === 'offer_expired')

  it('expire when a workspace loads; the change reaches the server once, and a second device adds nothing', async () => {
    const server = new FakeServer()
    const a0 = device(server, withSentOffer())
    expect(await a0.engine.uploadLocal()).toEqual({ ok: true })
    await a0.engine.whenIdle()
    const b0 = await joiner(server)
    a0.engine.stop()
    b0.engine.stop()
    const savedA = a0.db()
    const loadedA = applyLoadChanges(savedA)
    expect(loadedA.offers[0]).toMatchObject({ status: 'expired', decidedOn: '2026-10-07' })
    const a = device(server, loadedA, a0.storage, { baseline: () => savedA })
    a.engine.start()
    await a.engine.whenIdle()
    expect(server.record('offers', 'o-1')).toMatchObject({ status: 'expired' })
    expect(expiredRows(server.snapshot())).toHaveLength(1)
    expect(expiredRows(a.db())).toEqual(expiredRows(server.snapshot()))
    const savedB = b0.db()
    const b = device(server, applyLoadChanges(savedB), b0.storage, { baseline: () => savedB })
    b.engine.start()
    await b.engine.whenIdle()
    // Every device logs the expiry under one id (src/sync/loadTime.ts), so the server keeps one row.
    expect(expiredRows(server.snapshot())).toHaveLength(1)
    expect(b.st()).toMatchObject({ refreshed: 0, pending: 0 })
    expect(diffDB(b.db(), server.snapshot())).toEqual([])
  })

  it('two devices opening on different days after the expiry write identical records: no "newer change" notice', async () => {
    const db = withSentOffer()
    db.jobs.push({ id: 'j-1', hiringManagerId: 'p-founder' } as unknown as DB['jobs'][number])
    db.candidates.push({ id: 'c-1', firstName: 'Dana', lastName: 'Park' } as unknown as DB['candidates'][number])
    db.applications.push({ id: 'a-1', candidateId: 'c-1', jobId: 'j-1', stageId: 'offer', status: 'active', nextStep: { text: 'Follow up on the offer', dueOn: '2026-10-06', ownerId: 'p-founder' } } as unknown as DB['applications'][number])
    db.grants.push({ id: 'g-1', personId: 'c-1', holderType: 'candidate', type: 'ISO', shares: 25_000, strikePrice: 0, vestingStart: '2026-11-02', cliffMonths: 12, vestingMonths: 48, status: 'reserved', fromOfferId: 'o-1', exercisedShares: 0, postTerminationExerciseDays: 90 })
    const server = new FakeServer()
    const a0 = device(server, db)
    expect(await a0.engine.uploadLocal()).toEqual({ ok: true })
    await a0.engine.whenIdle()
    const b0 = await joiner(server)
    a0.engine.stop()
    b0.engine.stop()
    const openOn = (saved: DB, day: string) => {
      setClockOverride(day)
      try {
        return applyLoadChanges(saved)
      } finally {
        setClockOverride('2026-10-10')
      }
    }
    // A opens the day after the expiry, B two days later; each applies the expiry before it syncs.
    const savedA = a0.db()
    const savedB = b0.db()
    const loadedA = openOn(savedA, '2026-10-08')
    const loadedB = openOn(savedB, '2026-10-10')
    expect(diffDB(loadedA, loadedB)).toEqual([])
    expect(loadedB.grants[0]).toMatchObject({ status: 'cancelled', cancelledOn: '2026-10-07', cancelledShares: 25_000 })
    expect(loadedB.applications[0].nextStep).toMatchObject({ text: 'Offer expired: extend it or close out', dueOn: '2026-10-08' })
    const a = device(server, loadedA, a0.storage, { baseline: () => savedA })
    a.engine.start()
    await a.engine.whenIdle()
    const b = device(server, loadedB, b0.storage, { baseline: () => savedB })
    b.engine.start()
    await b.engine.whenIdle()
    expect(expiredRows(server.snapshot())).toHaveLength(1)
    expect(b.st()).toMatchObject({ refreshed: 0, pending: 0 })
    expect(a.st()).toMatchObject({ refreshed: 0 })
    expect(diffDB(b.db(), server.snapshot())).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// End-to-end review, round 2, package E (sync engine and server)
// ---------------------------------------------------------------------------------------------

describe('a record another computer deleted (r2-44)', () => {
  const renameOps =
    (name: string): Recipe =>
    (d) => {
      d.departments.find((x) => x.id === 'd-ops')!.name = name
    }
  const removeOps: Recipe = (d) => {
    d.departments = d.departments.filter((x) => x.id !== 'd-ops')
  }
  const hasOps = (dev: Device) => dev.db().departments.some((x) => x.id === 'd-ops')

  it('a stale edit does not bring it back: the editing computer removes its copy and names it', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const b = await joiner(server)
    // A removes the department; B, which has not pulled since, saves a new name for it.
    a.mutate(removeOps)
    await quiet(a)
    expect(server.record('departments', 'd-ops')).toBeUndefined()
    b.store.getState().mutate('Renamed the department', renameOps('Finance and ops'))
    await quiet(b)
    expect(server.record('departments', 'd-ops')).toBeUndefined()
    expect(hasOps(b)).toBe(false)
    expect(b.st()).toMatchObject({ refreshed: 1, refreshedKeys: [{ collection: 'departments', id: 'd-ops' }], pending: 0 })
    expect(labels(b)).toEqual([])
    // A never sees it come back, and has nothing to be told.
    await a.engine.syncNow()
    expect(hasOps(a)).toBe(false)
    expect(a.st().refreshed).toBe(0)
    expect(diffDB(b.db(), server.snapshot())).toEqual([])
  })

  it('an edit queued offline before the delete reached the server loses the same way', async () => {
    const server = new FakeServer()
    const link = deviceLink(server)
    const a = await uploader(server)
    const b = await joiner(server, link)
    link.online = false
    b.mutate(renameOps('Offline name'))
    await quiet(b)
    a.mutate(removeOps)
    await quiet(a)
    link.online = true
    await b.engine.syncNow()
    expect(hasOps(b)).toBe(false)
    expect(server.record('departments', 'd-ops')).toBeUndefined()
    expect(b.st()).toMatchObject({ refreshed: 1, pending: 0 })
  })

  it('undoing your own delete still brings the record back everywhere', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const b = await joiner(server)
    a.mutate(removeOps)
    await quiet(a)
    expect(a.conn().versions['departments:d-ops']).toBeUndefined()
    a.store.getState().undo()
    await quiet(a)
    expect(server.record('departments', 'd-ops')).toMatchObject({ name: 'Finance and operations' })
    expect(a.st()).toMatchObject({ refreshed: 0, pending: 0 })
    await b.engine.syncNow()
    expect(b.db().departments.find((x) => x.id === 'd-ops')?.name).toBe('Finance and operations')
  })

  it('undoing a delete whose answer was lost still brings it back, with no notice', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    server.loseResponses(1)
    a.mutate(removeOps)
    await quiet(a)
    expect(server.record('departments', 'd-ops')).toBeUndefined()
    expect(a.st().status).toBe('offline')
    a.store.getState().undo()
    await vi.advanceTimersByTimeAsync(2000)
    await a.engine.whenIdle()
    expect(server.record('departments', 'd-ops')).toMatchObject({ name: 'Finance and operations' })
    expect(hasOps(a)).toBe(true)
    expect(a.st()).toMatchObject({ status: 'synced', refreshed: 0, pending: 0 })
  })
})

describe('a browser that died before saving its last answers (r2-45)', () => {
  const moves = [
    ['Technical', 'act-technical'],
    ['Onsite', 'act-onsite'],
    ['Offer', 'act-offer'],
  ] as const

  it('replays its first unanswered move on restart: no notice, and no activity row is deleted', async () => {
    const server = new FakeServer()
    const storage = memoryStorage()
    // What the disk holds when the browser dies: everything saved up to the moment the first move left.
    let disk: Map<string, string> | null = null
    const api: SyncApi = {
      ...deviceLink(server),
      postChanges: (changes, opts) => {
        if (!disk && changes.some((c) => c.id === 'act-technical')) disk = new Map(storage.data)
        return server.postChanges(changes, opts)
      },
    }
    const db = makeDB()
    db.people.push(makePerson('p-1'))
    const a = persistentBrowser(api, storage, db)
    expect(await a.engine.uploadLocal()).toEqual({ ok: true })
    await a.engine.whenIdle()
    for (const [title, row] of moves) {
      a.store.getState().mutate(`Moved to ${title}`, renameLogged('p-1', title, row))
      await quiet(a)
    }
    expect(serverTitle(server, 'p-1')).toBe('Offer')
    a.crash()
    const restored = memoryStorage()
    for (const [k, v] of disk!) restored.data.set(k, v)
    expect(loadConnection(restored).unconfirmed['people:p-1']).toBeTruthy()
    const pushesBefore = server.pushes.length
    const b = persistentBrowser(server, restored)
    expect(titleOf(b, 'p-1')).toBe('Technical')
    b.engine.start()
    await b.engine.whenIdle()
    expect(titleOf(b, 'p-1')).toBe('Offer')
    expect(b.st()).toMatchObject({ refreshed: 0, refreshedKeys: [], pending: 0, status: 'synced' })
    for (const [, row] of moves) {
      expect(server.record('activity', row)).toBeTruthy()
      expect(hasRow(b.db(), row)).toBe(true)
    }
    expect(server.pushes.slice(pushesBefore).flat().filter((c) => c.op === 'delete')).toEqual([])
    expect(diffDB(b.db(), server.snapshot())).toEqual([])
  })

  it('an activity row the server already held stays, even when its edit lost to someone else after a reload', async () => {
    const server = new FakeServer()
    const link = deviceLink(server)
    const a0 = await uploader(server, link)
    server.loseResponses(1)
    a0.mutate(renameLogged('p-1', 'A landed', 'act-landed'))
    await quiet(a0)
    expect(server.record('activity', 'act-landed')).toBeTruthy()
    a0.engine.stop()
    // Another user changes the record afterwards; this browser reloads (no Undo history).
    server.serverUpsert('people', 'p-1', { ...(server.record('people', 'p-1') as object), title: 'Someone else' })
    const pushesBefore = server.pushes.length
    const a = device(link, a0.db(), a0.storage)
    a.engine.start()
    await a.engine.whenIdle()
    expect(titleOf(a, 'p-1')).toBe('Someone else')
    // Another user's change won: that is news. The row is history: the edit did happen.
    expect(a.st()).toMatchObject({ refreshed: 1, pending: 0 })
    expect(hasRow(a.db(), 'act-landed')).toBe(true)
    expect(server.record('activity', 'act-landed')).toBeTruthy()
    expect(server.pushes.slice(pushesBefore).flat().filter((c) => c.op === 'delete')).toEqual([])
  })

  it('a retry that never landed, beaten by the same user on another computer, still says so and drops its row', async () => {
    const server = new FakeServer()
    const link = deviceLink(server)
    const a0 = await uploader(server, link)
    link.online = false
    a0.mutate(renameLogged('p-1', 'Never sent', 'act-never'))
    await quiet(a0)
    a0.engine.stop()
    // The admin edits the record on another computer meanwhile.
    server.serverUpsert('people', 'p-1', { ...(server.record('people', 'p-1') as object), title: 'Other computer' }, server.user.id)
    link.online = true
    const a = device(link, a0.db(), a0.storage)
    a.engine.start()
    await a.engine.whenIdle()
    expect(titleOf(a, 'p-1')).toBe('Other computer')
    expect(a.st()).toMatchObject({ refreshed: 1, pending: 0 })
    expect(hasRow(a.db(), 'act-never')).toBe(false)
    expect(server.record('activity', 'act-never')).toBeUndefined()
  })

  it('a retry that landed, beaten by the same user on another computer, takes that copy quietly', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const b = await joiner(server)
    server.loseResponses(1)
    a.mutate(rename('p-1', 'Landed'))
    await quiet(a)
    await b.engine.syncNow()
    b.mutate(rename('p-1', 'B on top'))
    await quiet(b)
    // No new edit on A: its retry is the attempt that landed.
    await vi.advanceTimersByTimeAsync(2000)
    await a.engine.whenIdle()
    expect(titleOf(a, 'p-1')).toBe('B on top')
    expect(a.st()).toMatchObject({ refreshed: 0, pending: 0, status: 'synced' })
  })
})

describe('discarding a change too large to sync (r2-46)', () => {
  it('also removes the activity row an earlier batch delivered, and the Undo step, here and on the server', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    a.store.getState().mutate('Updated p-2', (d) => {
      d.people.find((p) => p.id === 'p-2')!.notes = 'x'.repeat(300 * 1024)
      d.activity.push({ id: 'act-big-edit', at: '2026-10-10T17:00:00.000Z', entityType: 'person', entityId: 'p-2', kind: 'edited', text: 'Updated p-2' })
    })
    await quiet(a)
    expect(a.st().rejectedKeys).toEqual([{ collection: 'people', id: 'p-2', tooLarge: true }])
    // The row went out in the batch the record was set aside from.
    expect(server.record('activity', 'act-big-edit')).toBeTruthy()
    expect(labels(a)).toEqual(['Updated p-2'])
    expect(await a.engine.discardRejected([{ collection: 'people', id: 'p-2' }])).toEqual({ ok: true })
    // The Undo entry is gone (the toast bound to it closes), and so is the row.
    expect(labels(a)).toEqual([])
    expect(hasRow(a.db(), 'act-big-edit')).toBe(false)
    expect(a.db().people.find((p) => p.id === 'p-2')?.notes).toBeUndefined()
    await a.engine.whenIdle()
    expect(server.record('activity', 'act-big-edit')).toBeUndefined()
    expect(a.st()).toMatchObject({ rejected: 0, pending: 0, refreshed: 0 })
    expect(diffDB(a.db(), server.snapshot())).toEqual([])
  })

  it('a row still queued with the change just leaves the outbox, and nothing is sent for it', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    server.signedIn = false
    a.store.getState().mutate('Added p-big', (d) => {
      d.people.push(makePerson('p-big', { notes: 'x'.repeat(300 * 1024) }))
      d.activity.push({ id: 'act-queued', at: '2026-10-10T17:00:00.000Z', entityType: 'person', entityId: 'p-big', kind: 'edited', text: 'Added p-big' })
    })
    await quiet(a)
    expect(a.st().rejectedKeys).toEqual([{ collection: 'people', id: 'p-big', tooLarge: true }])
    expect(a.conn().outbox.map((e) => e.id)).toEqual(['act-queued'])
    // The server never had the person: nothing to fetch, so this works signed out too.
    expect(await a.engine.discardRejected()).toEqual({ ok: true })
    expect(labels(a)).toEqual([])
    expect(hasRow(a.db(), 'act-queued')).toBe(false)
    expect(a.conn().outbox).toEqual([])
    expect(await a.engine.signIn(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)).toMatchObject({ ok: true })
    await a.engine.whenIdle()
    expect(server.record('activity', 'act-queued')).toBeUndefined()
    expect(server.pushes.flat().some((c) => c.id === 'act-queued')).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// End-to-end review, round 3, package P1 (sync, server, shell and settings)
// ---------------------------------------------------------------------------------------------

describe('looking at an empty server without a 404 (r3-06)', () => {
  it('the connect step asks the status route and downloads nothing from an empty server', async () => {
    const server = new FakeServer()
    const b = device(server)
    expect(await b.engine.inspectServer()).toEqual({ ok: true, empty: true })
    expect(server.calls).toEqual(['workspaceStatus'])
    // With a workspace there, it downloads it once (and Use the server's copy reuses it).
    await uploader(server)
    const c = device(server, makeDB({ company: 'Elsewhere' }))
    const reads = server.callCount('getWorkspace')
    expect(await c.engine.inspectServer()).toMatchObject({ ok: true, empty: false, companyName: 'Acme' })
    expect(await c.engine.useServerCopy()).toEqual({ ok: true })
    expect(server.callCount('getWorkspace')).toBe(reads + 1)
  })

  it('a reload during the server_empty hold looks with the status route while the server stays empty', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    server.loseWorkspace()
    a.mutate(rename('p-1', 'Waiting for a workspace'))
    await quiet(a)
    expect(a.st().hold).toBe('server_empty')
    a.engine.stop()
    const before = server.calls.length
    const a2 = device(server, a.db(), a.storage)
    a2.engine.start()
    await a2.engine.whenIdle()
    a2.page.emit('focus')
    await a2.engine.whenIdle()
    expect(server.calls.slice(before)).toEqual(['workspaceStatus', 'workspaceStatus'])
    expect(a2.st()).toMatchObject({ hold: 'server_empty', pendingEdits: 1 })
    // Another computer uploads this workspace again: the next look downloads it and joins, edit on top.
    expect(await device(server, a.db()).engine.uploadLocal({ confirmReplace: true })).toEqual({ ok: true })
    const reads = server.callCount('getWorkspace')
    a2.page.emit('focus')
    await a2.engine.whenIdle()
    expect(server.callCount('getWorkspace')).toBe(reads + 1)
    expect(a2.st().hold).toBeNull()
    expect(serverTitle(server, 'p-1')).toBe('Waiting for a workspace')
  })

  it('a server from before the status route is asked the old way, once per look', async () => {
    const server = new FakeServer()
    server.statusRoute = false
    const b = device(server)
    expect(await b.engine.inspectServer()).toEqual({ ok: true, empty: true })
    expect(server.callCount('getWorkspace')).toBe(1)
    await uploader(server)
    const c = device(server, makeDB({ company: 'Elsewhere' }))
    const reads = server.callCount('getWorkspace')
    expect(await c.engine.inspectServer()).toMatchObject({ ok: true, empty: false })
    expect(await c.engine.useServerCopy()).toEqual({ ok: true })
    // The snapshot the fallback downloaded is the one Use the server's copy takes.
    expect(server.callCount('getWorkspace')).toBe(reads + 1)
  })

  it('checkServer says whether the server is empty for a signed-in browser that is not connected (r3-03)', async () => {
    const server = new FakeServer()
    const b = device(server)
    expect(await b.engine.checkServer()).toEqual({ ok: true, version: 'test', signedIn: true, user: server.user, empty: true })
    const a = await uploader(server)
    expect(await b.engine.checkServer()).toMatchObject({ ok: true, signedIn: true, empty: false })
    // Connected, or signed out: nothing to ask.
    const calls = server.calls.length
    expect(await a.engine.checkServer()).not.toHaveProperty('empty')
    expect(server.calls.slice(calls)).toEqual(['health', 'session'])
    server.signedIn = false
    expect(await b.engine.checkServer()).toEqual({ ok: true, version: 'test', signedIn: false, user: null })
    // An older server: no answer about emptiness, and nothing downloaded to find out.
    server.signedIn = true
    server.statusRoute = false
    const reads = server.callCount('getWorkspace')
    expect(await b.engine.checkServer()).not.toHaveProperty('empty')
    expect(server.callCount('getWorkspace')).toBe(reads)
  })
})

describe('page loads never meet a 401 (r3-07)', () => {
  it('after a deliberate sign-out, a reload sends nothing until the next sign-in', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    expect(await a.engine.signOut()).toMatchObject({ ok: true, confirmed: true })
    a.mutate(rename('p-1', 'Edited after signing out'))
    a.engine.stop()
    const before = server.calls.length
    const a2 = device(server, a.db(), a.storage)
    a2.engine.start()
    await a2.engine.whenIdle()
    a2.mutate(rename('p-2', 'Also after'))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(server.calls.slice(before)).toEqual([])
    expect(a2.st()).toMatchObject({ status: 'signed_out', signedOutByUser: true, pendingEdits: 2 })
    expect(await a2.engine.signIn(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)).toMatchObject({ ok: true })
    await a2.engine.whenIdle()
    expect(serverTitle(server, 'p-1')).toBe('Edited after signing out')
    expect(serverTitle(server, 'p-2')).toBe('Also after')
  })

  it('a session that ended while the browser was closed is found with the session check, not a 401', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    expect(await a.engine.signIn(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)).toMatchObject({ ok: true })
    await a.engine.whenIdle()
    a.mutate(rename('p-1', 'Before the browser closed'))
    a.engine.stop()
    // The session cookie ended with the browser.
    server.signedIn = false
    const before = server.calls.length
    const a2 = device(server, a.db(), a.storage)
    a2.engine.start()
    await a2.engine.whenIdle()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(server.calls.slice(before)).toEqual(['session'])
    expect(a2.st()).toMatchObject({ status: 'signed_out', signedOutByUser: false, pendingEdits: 1 })
    expect(await a2.engine.signIn(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)).toMatchObject({ ok: true })
    await a2.engine.whenIdle()
    expect(serverTitle(server, 'p-1')).toBe('Before the browser closed')
    expect(a2.st()).toMatchObject({ status: 'synced', pending: 0 })
  })

  it('a session that still holds starts syncing right after the check', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    expect(await a.engine.signIn(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)).toMatchObject({ ok: true })
    await a.engine.whenIdle()
    a.mutate(rename('p-1', 'Sent after the check'))
    a.engine.stop()
    const before = server.calls.length
    const a2 = device(server, a.db(), a.storage)
    a2.engine.start()
    await a2.engine.whenIdle()
    expect(server.calls.slice(before, before + 2)).toEqual(['session', 'postChanges'])
    expect(serverTitle(server, 'p-1')).toBe('Sent after the check')
    expect(a2.st()).toMatchObject({ status: 'synced', pending: 0 })
  })
})

describe('waiting changes counted as a person counts them (r3-08)', () => {
  it('one kit checkbox (complianceStatus and its activity row) counts as one change', async () => {
    const server = new FakeServer()
    const link = deviceLink(server)
    const a = await uploader(server, link)
    link.online = false
    a.store.getState().mutate('Marked done: federal workplace posters', (d) => {
      d.complianceStatus['posters-federal'] = { status: 'done', doneOn: '2026-10-10' }
      d.activity.push({ id: 'act-posters', at: '2026-10-10T17:00:00.000Z', entityType: 'compliance', entityId: 'posters-federal', kind: 'compliance_status', text: 'Marked done' })
    })
    await quiet(a)
    expect(a.conn().outbox.map((e) => e.id).sort()).toEqual(['act-posters', 'complianceStatus'])
    expect(a.st().pendingEdits).toBe(1)
    // The row alone (its document already sent) still counts: never 0 while something waits.
    a.engine.stop()
    saveConnection(a.storage, { ...a.conn(), outbox: a.conn().outbox.filter((e) => e.collection === 'activity') })
    const a2 = device(link, a.db(), a.storage)
    a2.engine.start()
    expect(a2.st().pendingEdits).toBe(1)
  })
})

describe("an edit that lost to another computer's delete is named (r3-12)", () => {
  it("the notice keeps the record's last copy in this browser", async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const b = await joiner(server)
    a.mutate((d) => {
      d.departments = d.departments.filter((x) => x.id !== 'd-ops')
    })
    await quiet(a)
    b.mutate((d) => {
      d.departments.find((x) => x.id === 'd-ops')!.name = 'Finance and ops'
    })
    await quiet(b)
    expect(b.db().departments.some((x) => x.id === 'd-ops')).toBe(false)
    expect(b.st().refreshedKeys).toEqual([
      { collection: 'departments', id: 'd-ops', removed: true, copy: expect.objectContaining({ id: 'd-ops', name: 'Finance and ops' }) },
    ])
  })

  it('a copy the server replaced (not removed) carries no copy', async () => {
    const server = new FakeServer()
    const a = await uploader(server)
    const b = await joiner(server)
    b.mutate(rename('p-1', 'B wins'))
    await quiet(b)
    a.mutate(rename('p-1', 'A loses'))
    await quiet(a)
    expect(a.st().refreshedKeys).toEqual([{ collection: 'people', id: 'p-1' }])
  })
})

describe('a retry the server already had, after the bookkeeping was lost (r3-13)', () => {
  it('takes the newer copy this user wrote quietly, even with no record of having sent it', async () => {
    const server = new FakeServer()
    const storage = memoryStorage()
    // What the disk holds when the browser dies: the store and the queued move, but not the note that
    // it was sent (that last write was lost with the process).
    let disk: Map<string, string> | null = null
    const api: SyncApi = {
      ...deviceLink(server),
      postChanges: (changes, opts) => {
        if (!disk && changes.some((c) => c.id === 'act-offer')) disk = new Map(storage.data)
        return server.postChanges(changes, opts)
      },
    }
    const db = makeDB()
    db.people.push(makePerson('p-1'))
    const a = persistentBrowser(api, storage, db)
    expect(await a.engine.uploadLocal()).toEqual({ ok: true })
    await a.engine.whenIdle()
    a.store.getState().mutate('Moved to Offer', renameLogged('p-1', 'Offer', 'act-offer'))
    await quiet(a)
    a.store.getState().mutate('Sent the offer', renameLogged('p-1', 'Offer sent', 'act-sent'))
    await quiet(a)
    expect(serverTitle(server, 'p-1')).toBe('Offer sent')
    a.crash()
    const restored = memoryStorage()
    for (const [k, v] of disk!) restored.data.set(k, v)
    saveConnection(restored, { ...loadConnection(restored), unconfirmed: {} })
    expect(loadConnection(restored).outbox.map((e) => e.id)).toContain('p-1')
    const b = persistentBrowser(server, restored)
    expect(titleOf(b, 'p-1')).toBe('Offer')
    b.engine.start()
    await b.engine.whenIdle()
    expect(titleOf(b, 'p-1')).toBe('Offer sent')
    expect(b.st()).toMatchObject({ refreshed: 0, refreshedKeys: [], pending: 0, status: 'synced' })
    for (const row of ['act-offer', 'act-sent']) {
      expect(server.record('activity', row)).toBeTruthy()
      expect(hasRow(b.db(), row)).toBe(true)
    }
    expect(diffDB(b.db(), server.snapshot())).toEqual([])
  })
})

describe('Sign out and remove data says what happened after the reload (r3-10)', () => {
  it('hands its message to the reload, which the next page shows', async () => {
    const server = new FakeServer()
    const reload = vi.fn()
    const a = device(server, makeDB(), memoryStorage(), { wipeLocal: vi.fn(), reload, freshDB: () => makeDB({ sample: true }) })
    expect(await a.engine.uploadLocal()).toEqual({ ok: true })
    const res = await a.engine.signOut({ forgetThisBrowser: true })
    expect(res).toMatchObject({ ok: true, confirmed: true, forgotten: true, message: FORGOTTEN_MESSAGE })
    expect(reload).toHaveBeenCalledWith(FORGOTTEN_MESSAGE)
    expect(FORGOTTEN_MESSAGE).toBe("Signed out and removed this browser's data. Your server keeps everything that reached it.")
  })
})
