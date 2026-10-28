// End to end: two browser sync engines talking to the real API server (server/src/app.ts) over its
// Fastify inject() interface, with PGlite (real Postgres in WebAssembly) underneath. Skipped when the
// server code is not in this checkout. Real timers: PGlite does its own async work.
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '@/domain/types'
import { setClockOverride } from '@/lib/dates'
import { logActivity } from '@/store/draft'
import { createApi, type SyncApi } from './api'
import { diffDB } from './diff'
import { createSyncEngine, type EngineOptions } from './engine'
import { applyLoadChanges } from './index'
import { type InjectApp, injectFetch, type Wire } from './testing/inject'
import { createStatusStore, createTestStore, makeDB, makePerson, memoryStorage, testEnv } from './testing/kit'

const helpersPath = fileURLToPath(new URL('../../server/src/test/helpers.ts', import.meta.url))
const appPath = fileURLToPath(new URL('../../server/src/app.ts', import.meta.url))
const available = existsSync(appPath) && existsSync(helpersPath)

type TestDb = { close(): Promise<void>; query(sql: string, params?: unknown[]): Promise<unknown> }
type ServerHelpers = {
  makeTestDb(): Promise<TestDb>
  resetDb(db: TestDb): Promise<void>
  makeApp(db: TestDb): Promise<InjectApp>
  createAdmin(db: TestDb): Promise<string>
  ADMIN: { email: string; password: string }
}

describe.skipIf(!available)('round trip against the real server', () => {
  let h: ServerHelpers
  let db: TestDb
  let app: InjectApp
  const stops: Array<() => void> = []

  beforeAll(async () => {
    setClockOverride('2026-10-10')
    h = (await import(/* @vite-ignore */ pathToFileURL(helpersPath).href)) as ServerHelpers
    db = await h.makeTestDb()
  }, 60_000)
  afterAll(async () => {
    await db?.close()
  })
  beforeEach(async () => {
    await h.resetDb(db)
    await h.createAdmin(db)
    app = await h.makeApp(db)
  })
  afterEach(async () => {
    for (const stop of stops.splice(0)) stop()
    await app.close()
  })

  type BrowserOptions = Partial<Pick<EngineOptions, 'baseline' | 'onLoad' | 'clockOverride'>>
  /** One browser. `reloadOf`: the same browser after a page reload (its storage and cookie jar). */
  function browser(start: DB, opts: BrowserOptions & { reloadOf?: { api: SyncApi; storage: ReturnType<typeof memoryStorage>; wire: Wire } } = {}) {
    const { reloadOf, ...extra } = opts
    const store = createTestStore(start)
    const status = createStatusStore()
    const wire: Wire = reloadOf?.wire ?? { losePushAnswers: 0 }
    const api = reloadOf?.api ?? createApi({ fetch: injectFetch(() => app, wire) })
    const storage = reloadOf?.storage ?? memoryStorage()
    const page = testEnv()
    const engine = createSyncEngine({
      store,
      api,
      storage,
      env: page.env,
      status,
      debounceMs: 5,
      pullIntervalMs: 3_600_000,
      ...extra,
    })
    stops.push(() => engine.stop())
    return {
      engine,
      store,
      wire,
      api,
      storage,
      page,
      st: () => status.getState(),
      db: () => store.getState().db,
      mutate: (recipe: Parameters<ReturnType<typeof store.getState>['mutate']>[1]) => store.getState().mutate('Edit', recipe),
      sync: async () => {
        await engine.syncNow()
        await engine.whenIdle()
      },
    }
  }

  async function connectedPair() {
    const a = browser(makeDB())
    expect(await a.engine.signIn(h.ADMIN.email, h.ADMIN.password)).toMatchObject({ ok: true })
    expect(await a.engine.inspectServer()).toEqual({ ok: true, empty: true })
    expect(await a.engine.uploadLocal()).toEqual({ ok: true })
    await a.engine.whenIdle()
    const b = browser(makeDB({ company: 'Somewhere else' }))
    expect(await b.engine.signIn(h.ADMIN.email, h.ADMIN.password)).toMatchObject({ ok: true })
    expect(await b.engine.inspectServer()).toMatchObject({ ok: true, empty: false, companyName: 'Acme' })
    expect(await b.engine.useServerCopy()).toEqual({ ok: true })
    await b.engine.whenIdle()
    expect(diffDB(a.db(), b.db())).toEqual([])
    return { a, b }
  }

  it('syncs edits both ways, skips echoes, lets the server win and keeps undo working', async () => {
    const { a, b } = await connectedPair()

    a.mutate((d) => {
      d.people.push(makePerson('p-1'))
      d.company.tagline = 'Close the books faster'
    })
    await a.sync()
    const afterPush = a.db()
    await a.sync()
    expect(a.db()).toBe(afterPush)
    await b.sync()
    expect(b.db().people.some((p) => p.id === 'p-1')).toBe(true)
    expect(b.db().company.tagline).toBe('Close the books faster')

    // Both edit the same person; B gets there first and wins.
    b.mutate((d) => {
      d.people.find((p) => p.id === 'p-1')!.title = 'From B'
    })
    await b.sync()
    a.mutate((d) => {
      d.people.find((p) => p.id === 'p-1')!.title = 'From A'
    })
    await a.sync()
    expect(a.db().people.find((p) => p.id === 'p-1')?.title).toBe('From B')
    expect(a.st().refreshed).toBe(1)

    // Undo of an add becomes a delete everywhere.
    a.mutate((d) => {
      d.people.push(makePerson('p-2'))
    })
    await a.sync()
    await b.sync()
    expect(b.db().people.some((p) => p.id === 'p-2')).toBe(true)
    a.store.getState().undo()
    await a.sync()
    await b.sync()
    expect(b.db().people.some((p) => p.id === 'p-2')).toBe(false)

    // Delete and re-create the same record across browsers.
    a.mutate((d) => {
      d.people = d.people.filter((p) => p.id !== 'p-1')
    })
    await a.sync()
    await b.sync()
    expect(b.db().people.some((p) => p.id === 'p-1')).toBe(false)
    b.mutate((d) => {
      d.people.push(makePerson('p-1', { title: 'Rehired' }))
    })
    await b.sync()
    await a.sync()
    expect(a.db().people.find((p) => p.id === 'p-1')?.title).toBe('Rehired')

    expect(diffDB(a.db(), b.db())).toEqual([])
    expect(a.st()).toMatchObject({ status: 'synced', pending: 0 })
    expect(b.st()).toMatchObject({ status: 'synced', pending: 0 })
  }, 60_000)

  it('signs out when the session is gone and resumes after signing in', async () => {
    const { a, b } = await connectedPair()
    await db.query('DELETE FROM sessions')
    a.mutate((d) => {
      d.people.push(makePerson('p-later'))
    })
    await a.sync()
    expect(a.st()).toMatchObject({ status: 'signed_out', pending: 1 })
    expect(await a.engine.signIn(h.ADMIN.email, h.ADMIN.password)).toMatchObject({ ok: true })
    await a.engine.whenIdle()
    expect(a.st()).toMatchObject({ status: 'synced', pending: 0 })
    expect(await b.engine.signIn(h.ADMIN.email, h.ADMIN.password)).toMatchObject({ ok: true })
    await b.sync()
    expect(b.db().people.some((p) => p.id === 'p-later')).toBe(true)
  }, 60_000)

  it('resyncs after another browser replaces the whole workspace', async () => {
    const { a, b } = await connectedPair()
    const other = makeDB({ company: 'Imported' })
    other.people.push(makePerson('p-imported'))
    b.store.getState().replace(other)
    // Import goes through PUT with confirmReplace (what the sync UI will call).
    expect(await b.engine.uploadLocal()).toMatchObject({ ok: false, kind: 'not_empty' })
    expect(await b.engine.uploadLocal({ confirmReplace: true })).toEqual({ ok: true })
    await b.engine.whenIdle()
    await a.sync()
    expect(a.db().company.name).toBe('Imported')
    expect(diffDB(a.db(), b.db())).toEqual([])
    a.mutate((d) => {
      d.people.find((p) => p.id === 'p-imported')!.title = 'After import'
    })
    await a.sync()
    await b.sync()
    expect(b.db().people.find((p) => p.id === 'p-imported')?.title).toBe('After import')
  }, 60_000)

  // F1: the server committed a push but the browser never heard back, then the user kept editing offline.
  describe('a push whose answer was lost', () => {
    const titleOf = (db: DB, id: string) => db.people.find((p) => p.id === id)?.title
    async function serverPeople(): Promise<Map<string, { title: string }>> {
      const rows = (await db.query('SELECT id, data FROM people')) as { rows: Array<{ id: string; data: { title: string } }> }
      return new Map(rows.rows.map((r) => [r.id, r.data]))
    }

    it('(A) an existing record edited again offline keeps the newer edit', async () => {
      const { a, b } = await connectedPair()
      a.mutate((d) => {
        d.people.push(makePerson('p-1', { title: 'v1' }))
      })
      await a.sync()
      a.wire.losePushAnswers = 1
      a.mutate((d) => {
        d.people.find((p) => p.id === 'p-1')!.title = 'v2'
      })
      await a.sync()
      expect(a.st().status).toBe('offline')
      expect((await serverPeople()).get('p-1')?.title).toBe('v2')
      a.mutate((d) => {
        d.people.find((p) => p.id === 'p-1')!.title = 'v3'
      })
      await a.sync()
      expect(titleOf(a.db(), 'p-1')).toBe('v3')
      expect((await serverPeople()).get('p-1')?.title).toBe('v3')
      expect(a.st()).toMatchObject({ status: 'synced', pending: 0, refreshed: 0 })
      await b.sync()
      expect(titleOf(b.db(), 'p-1')).toBe('v3')
    }, 60_000)

    it('(B) a new record edited offline keeps the edit', async () => {
      const { a, b } = await connectedPair()
      a.wire.losePushAnswers = 1
      a.mutate((d) => {
        d.people.push(makePerson('p-new', { title: 'first' }))
      })
      await a.sync()
      expect((await serverPeople()).get('p-new')?.title).toBe('first')
      a.mutate((d) => {
        d.people.find((p) => p.id === 'p-new')!.title = 'second'
      })
      await a.sync()
      expect(titleOf(a.db(), 'p-new')).toBe('second')
      expect((await serverPeople()).get('p-new')?.title).toBe('second')
      expect(a.st()).toMatchObject({ pending: 0, refreshed: 0 })
      await b.sync()
      expect(titleOf(b.db(), 'p-new')).toBe('second')
    }, 60_000)

    // Versions are change-log seqs shared by the whole workspace (migration 002), so the lost write lands
    // at baseVersion + 1 only when nothing else was written in between. Each case below writes something.
    it('(D) another record synced between the base write and the lost push', async () => {
      const { a, b } = await connectedPair()
      a.mutate((d) => {
        d.people.push(makePerson('p-1', { title: 'v1' }))
      })
      await a.sync()
      a.mutate((d) => {
        d.people.push(makePerson('p-other'))
      })
      await a.sync()
      a.wire.losePushAnswers = 1
      a.mutate((d) => {
        d.people.find((p) => p.id === 'p-1')!.title = 'v2'
      })
      await a.sync()
      expect(a.st().status).toBe('offline')
      a.mutate((d) => {
        d.people.find((p) => p.id === 'p-1')!.title = 'v3'
      })
      await a.sync()
      expect(titleOf(a.db(), 'p-1')).toBe('v3')
      expect((await serverPeople()).get('p-1')?.title).toBe('v3')
      expect(a.st()).toMatchObject({ status: 'synced', pending: 0, refreshed: 0 })
      await b.sync()
      expect(titleOf(b.db(), 'p-1')).toBe('v3')
    }, 60_000)

    it('(E) every edit also logs an activity row, as the domain actions do', async () => {
      const { a, b } = await connectedPair()
      const edit = (title: string) =>
        a.mutate((d) => {
          const p = d.people.find((x) => x.id === 'p-1')
          if (p) p.title = title
          else d.people.push(makePerson('p-1', { title }))
          logActivity(d, { entityType: 'person', entityId: 'p-1', kind: 'person_updated', text: `Title is ${title}` })
        })
      edit('v1')
      await a.sync()
      a.wire.losePushAnswers = 1
      edit('v2')
      await a.sync()
      expect(a.st().status).toBe('offline')
      edit('v3')
      await a.sync()
      expect(titleOf(a.db(), 'p-1')).toBe('v3')
      expect((await serverPeople()).get('p-1')?.title).toBe('v3')
      expect(a.st()).toMatchObject({ status: 'synced', pending: 0, refreshed: 0 })
      await b.sync()
      expect(titleOf(b.db(), 'p-1')).toBe('v3')
      expect(diffDB(a.db(), b.db())).toEqual([])
    }, 60_000)

    it('(F) another record goes first in the same batch as the lost push', async () => {
      const { a, b } = await connectedPair()
      a.mutate((d) => {
        d.people.push(makePerson('p-1', { title: 'v1' }), makePerson('p-2', { title: 'x1' }))
      })
      await a.sync()
      a.wire.losePushAnswers = 1
      a.mutate((d) => {
        d.people.find((p) => p.id === 'p-2')!.title = 'x2'
      })
      a.mutate((d) => {
        d.people.find((p) => p.id === 'p-1')!.title = 'v2'
      })
      await a.sync()
      expect(a.st().status).toBe('offline')
      a.mutate((d) => {
        d.people.find((p) => p.id === 'p-1')!.title = 'v3'
      })
      await a.sync()
      expect(titleOf(a.db(), 'p-1')).toBe('v3')
      expect(titleOf(a.db(), 'p-2')).toBe('x2')
      const server = await serverPeople()
      expect(server.get('p-1')?.title).toBe('v3')
      expect(server.get('p-2')?.title).toBe('x2')
      expect(a.st()).toMatchObject({ status: 'synced', pending: 0, refreshed: 0 })
      await b.sync()
      expect(titleOf(b.db(), 'p-1')).toBe('v3')
    }, 60_000)

    it('(G) a document edited again offline keeps the newer edit', async () => {
      const { a, b } = await connectedPair()
      const tagline = (text: string) =>
        a.mutate((d) => {
          d.company.tagline = text
          logActivity(d, { entityType: 'company', entityId: 'company', kind: 'company_updated', text: `Tagline is ${text}` })
        })
      tagline('t1')
      await a.sync()
      a.wire.losePushAnswers = 1
      tagline('t2')
      await a.sync()
      expect(a.st().status).toBe('offline')
      tagline('t3')
      await a.sync()
      expect(a.db().company.tagline).toBe('t3')
      expect(a.st()).toMatchObject({ status: 'synced', pending: 0, refreshed: 0 })
      await b.sync()
      expect(b.db().company.tagline).toBe('t3')
    }, 60_000)

    it('(C) a new record deleted offline stays deleted on every device and the server', async () => {
      const { a, b } = await connectedPair()
      a.wire.losePushAnswers = 1
      a.mutate((d) => {
        d.people.push(makePerson('p-new', { title: 'first' }))
      })
      await a.sync()
      expect((await serverPeople()).has('p-new')).toBe(true)
      a.mutate((d) => {
        d.people = d.people.filter((p) => p.id !== 'p-new')
      })
      expect(a.st().pending).toBe(1)
      await a.sync()
      await a.sync()
      expect((await serverPeople()).has('p-new')).toBe(false)
      expect(a.db().people.some((p) => p.id === 'p-new')).toBe(false)
      await b.sync()
      expect(b.db().people.some((p) => p.id === 'p-new')).toBe(false)
      expect(a.st()).toMatchObject({ pending: 0, refreshed: 0 })
      expect(diffDB(a.db(), b.db())).toEqual([])
    }, 60_000)
  })

  // Review #4: the server lost its workspace, both browsers paused, one re-uploaded.
  it('after a server reset, the browser that waited joins the re-uploaded copy with its own edits', async () => {
    const { a, b } = await connectedPair()
    await db.query('UPDATE workspaces SET initialized_at = NULL')
    b.mutate((d) => {
      d.people.push(makePerson('p-before', { title: 'Queued when the server was reset' }))
    })
    await b.sync()
    await a.sync()
    expect(a.st()).toMatchObject({ status: 'local', hold: 'server_empty' })
    expect(b.st()).toMatchObject({ status: 'local', hold: 'server_empty' })
    b.mutate((d) => {
      d.people.push(makePerson('p-hold', { title: 'Added during the hold' }))
    })
    expect(b.st().pending).toBe(2)
    expect(await a.engine.uploadLocal()).toEqual({ ok: true })
    await a.engine.whenIdle()
    const res = await b.engine.uploadLocal()
    expect(res).toMatchObject({ ok: true })
    expect(res.ok && res.message).toMatch(/another computer/i)
    await b.sync()
    expect(b.st()).toMatchObject({ status: 'synced', hold: null, pending: 0 })
    const rows = (await db.query('SELECT id FROM people')) as { rows: Array<{ id: string }> }
    expect(rows.rows.map((r) => r.id)).toEqual(expect.arrayContaining(['p-before', 'p-hold']))
    await a.sync()
    expect(a.db().people.some((p) => p.id === 'p-hold')).toBe(true)
    expect(diffDB(a.db(), b.db())).toEqual([])
  }, 60_000)

  // Review #3: 'Pretend today is' while connected.
  it('a pretend date never reaches the server, and going back to the real date takes the server copy', async () => {
    const { a, b } = await connectedPair()
    a.mutate((d) => {
      d.people.push(makePerson('p-1', { title: 'Engineer' }))
      d.comp.push({ id: 'c-1', personId: 'p-1', effectiveOn: '2027-01-01', payType: 'salary', salary: 150000, title: 'Senior engineer', levelId: 'lv-l4', reason: 'promotion', scheduled: true })
    })
    await a.sync()
    a.engine.stop()
    const clock: { now: string | null } = { now: '2027-01-04' }
    const reload = (saved: DB) => {
      setClockOverride(clock.now ?? '2026-10-10')
      const loaded = applyLoadChanges(saved)
      setClockOverride('2026-10-10')
      const next = browser(loaded, { reloadOf: a, baseline: () => saved, onLoad: applyLoadChanges, clockOverride: () => clock.now })
      next.engine.start()
      return next
    }
    const pretending = reload(a.db())
    await pretending.engine.whenIdle()
    expect(pretending.db().people.find((p) => p.id === 'p-1')?.title).toBe('Senior engineer')
    pretending.mutate((d) => {
      d.company.tagline = 'Typed while pretending'
    })
    await pretending.sync()
    expect(pretending.st()).toMatchObject({ status: 'local', hold: 'demo_clock' })
    const server = (await db.query("SELECT data FROM people WHERE id = 'p-1'")) as { rows: Array<{ data: { title: string } }> }
    expect(server.rows[0].data.title).toBe('Engineer')
    const comp = (await db.query("SELECT data FROM comp WHERE id = 'c-1'")) as { rows: Array<{ data: { appliedOn?: string } }> }
    expect(comp.rows[0].data.appliedOn).toBeUndefined()
    pretending.engine.stop()
    clock.now = null
    const back = reload(pretending.db())
    await back.engine.whenIdle()
    await back.sync()
    expect(back.st()).toMatchObject({ status: 'synced', hold: null, pending: 0 })
    expect(back.db().people.find((p) => p.id === 'p-1')?.title).toBe('Engineer')
    expect(back.db().comp.find((c) => c.id === 'c-1')?.appliedOn).toBeUndefined()
    await b.sync()
    expect(b.db().company.tagline).not.toBe('Typed while pretending')
    expect(diffDB(back.db(), b.db())).toEqual([])
  }, 60_000)

  // Re-review of #3 and #4, the verifier's scenarios against the real server.
  describe('re-review: the demo clock, and joining after a reset', () => {
    const REAL = '2026-10-10'
    const promotion = { id: 'c-1', personId: 'p-1', effectiveOn: '2027-01-01', payType: 'salary', salary: 150000, title: 'Senior engineer', levelId: 'lv-l4', reason: 'promotion', scheduled: true } as const
    type Browser = ReturnType<typeof browser>
    const titleOf = (b: Browser, id: string) => b.db().people.find((p) => p.id === id)?.title
    /** The same browser after a reload with `saved` in its storage, on `pretend` (null: the real date). */
    function reloadAt(prev: Browser, saved: DB, pretend: string | null): Browser {
      prev.engine.stop()
      setClockOverride(pretend ?? REAL)
      const loaded = applyLoadChanges(saved)
      setClockOverride(REAL)
      const next = browser(loaded, { reloadOf: prev, baseline: () => saved, onLoad: applyLoadChanges, clockOverride: () => pretend })
      next.engine.start()
      return next
    }
    async function serverPerson(id: string) {
      const r = (await db.query('SELECT data FROM people WHERE id = $1', [id])) as { rows: Array<{ data: { title: string; levelId: string; phone?: string } }> }
      return r.rows[0]?.data
    }
    /** One browser, connected, with p-1 and a Jan 1 promotion for them synced. */
    async function syncedWithPromotion(): Promise<Browser> {
      const a = browser(makeDB())
      expect(await a.engine.signIn(h.ADMIN.email, h.ADMIN.password)).toMatchObject({ ok: true })
      expect(await a.engine.uploadLocal()).toEqual({ ok: true })
      a.mutate((d) => {
        d.people.push(makePerson('p-1', { title: 'Engineer' }))
        d.comp.push({ ...promotion })
      })
      await a.sync()
      return a
    }

    it('back on the real date with the server out of reach, an edit to the promoted person carries nothing pretend', async () => {
      const a = await syncedWithPromotion()
      const pretending = reloadAt(a, a.db(), '2027-01-04')
      await pretending.engine.whenIdle()
      expect(titleOf(pretending, 'p-1')).toBe('Senior engineer')
      pretending.wire.down = true
      const back = reloadAt(pretending, pretending.db(), null)
      await back.engine.whenIdle()
      expect(titleOf(back, 'p-1')).toBe('Engineer')
      back.mutate((d) => {
        d.people.find((p) => p.id === 'p-1')!.phone = '555-0199'
        logActivity(d, { entityType: 'person', entityId: 'p-1', kind: 'person_updated', text: 'Phone changed' })
      })
      back.wire.down = false
      await back.sync()
      expect(await serverPerson('p-1')).toMatchObject({ title: 'Engineer', levelId: 'lv-l3', phone: '555-0199' })
      expect(back.st()).toMatchObject({ status: 'synced', hold: null, pending: 0 })
    }, 60_000)

    it('a second tab on the real date cannot erase what tells this tab that its saved copy is pretend', async () => {
      const a = await syncedWithPromotion()
      // Tab B: the same storage and cookie, opened before the clock was set, never reloaded.
      const tabB = browser(a.db(), { reloadOf: a, clockOverride: () => null })
      tabB.engine.start()
      await tabB.engine.whenIdle()
      const pretending = reloadAt(a, a.db(), '2027-01-04')
      await pretending.engine.whenIdle()
      pretending.mutate((d) => {
        d.company.tagline = 'Typed while pretending'
      })
      const savedPretend = pretending.db()
      await tabB.sync()
      const back = reloadAt(pretending, savedPretend, null)
      await back.engine.whenIdle()
      expect(titleOf(back, 'p-1')).toBe('Engineer')
      back.mutate((d) => {
        d.people.find((p) => p.id === 'p-1')!.phone = '555-0123'
      })
      await back.sync()
      expect(await serverPerson('p-1')).toMatchObject({ title: 'Engineer', levelId: 'lv-l3', phone: '555-0123' })
      expect(back.db().company.tagline).not.toBe('Typed while pretending')
    }, 60_000)

    for (const how of ['focus', 'upload'] as const) {
      it(`after a reset, an edit queued on an old copy loses to the newer one in the re-uploaded copy (joined by ${how})`, async () => {
        const { a, b } = await connectedPair()
        a.mutate((d) => {
          d.people.push(makePerson('p-1', { title: 'v1' }))
        })
        await a.sync()
        await b.sync()
        b.wire.down = true
        b.mutate((d) => {
          d.people.find((p) => p.id === 'p-1')!.title = 'B offline (old)'
        })
        await b.sync()
        a.mutate((d) => {
          d.people.find((p) => p.id === 'p-1')!.title = 'A newer'
        })
        await a.sync()
        await db.query('UPDATE workspaces SET initialized_at = NULL')
        b.wire.down = false
        await b.sync()
        expect(b.st().hold).toBe('server_empty')
        await a.sync()
        expect(a.st().hold).toBe('server_empty')
        expect(await a.engine.uploadLocal()).toEqual({ ok: true })
        await a.engine.whenIdle()
        if (how === 'focus') {
          b.page.emit('focus')
          await b.engine.whenIdle()
        } else {
          expect(await b.engine.uploadLocal()).toMatchObject({ ok: true })
        }
        await b.sync()
        await a.sync()
        expect((await serverPerson('p-1'))?.title).toBe('A newer')
        expect(titleOf(a, 'p-1')).toBe('A newer')
        expect(titleOf(b, 'p-1')).toBe('A newer')
        expect(b.st()).toMatchObject({ status: 'synced', hold: null, pending: 0, refreshed: 1 })
        expect(diffDB(a.db(), b.db())).toEqual([])
      }, 60_000)
    }
  })

  // r2-44: the server wins over an edit made on a copy from before another browser's delete.
  it('a stale edit from another browser does not bring back a record this one deleted; Undo of the delete still does', async () => {
    const { a, b } = await connectedPair()
    const hasOps = (db: DB) => db.departments.some((x) => x.id === 'd-ops')
    a.mutate((d) => {
      d.departments = d.departments.filter((x) => x.id !== 'd-ops')
    })
    await a.sync()
    // B has not pulled the delete when it saves a new name.
    b.mutate((d) => {
      d.departments.find((x) => x.id === 'd-ops')!.name = 'Finance and ops'
    })
    await b.sync()
    expect(hasOps(b.db())).toBe(false)
    expect(b.st()).toMatchObject({ refreshed: 1, refreshedKeys: [{ collection: 'departments', id: 'd-ops' }], pending: 0 })
    await a.sync()
    expect(hasOps(a.db())).toBe(false)
    expect(a.st().refreshed).toBe(0)
    const rows = (await db.query(`SELECT 1 FROM departments WHERE id = 'd-ops'`)) as { rows: unknown[] }
    expect(rows.rows).toHaveLength(0)
    // A's own Undo brings it back for everyone.
    a.store.getState().undo()
    await a.sync()
    await b.sync()
    expect(b.db().departments.find((x) => x.id === 'd-ops')?.name).toBe('Finance and operations')
    expect(diffDB(a.db(), b.db())).toEqual([])
  }, 60_000)

  // r2-45: Chrome writes localStorage to disk in batches; a crash restores an older saved state.
  it('a browser that died before saving its last answers replays the first one: no notice, and no activity row is deleted', async () => {
    const storage = memoryStorage()
    const wire: Wire = { losePushAnswers: 0 }
    const inner = injectFetch(() => app, wire)
    let current: ReturnType<typeof browser> | null = null
    let disk: { data: Map<string, string>; db: DB } | null = null
    const api = createApi({
      fetch: async (url, init) => {
        // The disk as it was when the first move left: the saved sync state and the saved store.
        if (!disk && current && init?.method === 'POST' && url === '/api/changes' && String(init.body).includes('act-technical')) {
          disk = { data: new Map(storage.data), db: current.db() }
        }
        return inner(url, init)
      },
    })
    const start = makeDB()
    start.people.push(makePerson('p-1', { title: 'Applied' }))
    const a = browser(start, { reloadOf: { api, storage, wire } })
    current = a
    expect(await a.engine.signIn(h.ADMIN.email, h.ADMIN.password)).toMatchObject({ ok: true })
    expect(await a.engine.uploadLocal()).toEqual({ ok: true })
    await a.engine.whenIdle()
    for (const [title, row] of [
      ['Technical', 'act-technical'],
      ['Onsite', 'act-onsite'],
      ['Offer', 'act-offer'],
    ] as const) {
      a.store.getState().mutate(`Moved to ${title}`, (d) => {
        d.people.find((p) => p.id === 'p-1')!.title = title
        d.activity.push({ id: row, at: '2026-10-10T17:00:00.000Z', entityType: 'person', entityId: 'p-1', kind: 'edited', text: `Moved to ${title}` })
      })
      await a.sync()
    }
    a.engine.stop()
    expect(disk).not.toBeNull()
    const restored = memoryStorage()
    for (const [k, v] of disk!.data) restored.data.set(k, v)
    const before = (await db.query(`SELECT max(seq) AS seq FROM change_log`)) as { rows: Array<{ seq: unknown }> }
    const b = browser(disk!.db, { reloadOf: { api, storage: restored, wire } })
    b.engine.start()
    await b.engine.whenIdle()
    await b.sync()
    expect(b.db().people.find((p) => p.id === 'p-1')?.title).toBe('Offer')
    expect(b.st()).toMatchObject({ refreshed: 0, refreshedKeys: [], pending: 0, status: 'synced' })
    const kept = (await db.query(`SELECT id FROM activity WHERE id IN ('act-technical', 'act-onsite', 'act-offer') ORDER BY id`)) as { rows: Array<{ id: string }> }
    expect(kept.rows.map((r) => r.id)).toEqual(['act-offer', 'act-onsite', 'act-technical'])
    const written = (await db.query(`SELECT collection, op FROM change_log WHERE seq > $1`, [Number(before.rows[0].seq)])) as { rows: unknown[] }
    expect(written.rows).toEqual([])
  }, 60_000)

  it('refuses to upload the sample company unless asked', async () => {
    const s = browser(makeDB({ sample: true, company: 'Ledgerlark' }))
    expect(await s.engine.signIn(h.ADMIN.email, h.ADMIN.password)).toMatchObject({ ok: true })
    expect(await s.engine.uploadLocal()).toMatchObject({ ok: false, kind: 'sample' })
    expect(await s.engine.inspectServer()).toEqual({ ok: true, empty: true })
  }, 60_000)
})
