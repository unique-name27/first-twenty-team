// End to end on a demo server (SIGNUP_MODE=open): browser sync engines talking to the real API server
// (server/src/app.ts) over Fastify's inject(), PGlite underneath. Sign up, upload the new company, invite
// a teammate who joins and syncs, a second company that never sees the first, and a browser that holds
// one company's copy never carrying on under another company's login. Skipped when the server code is
// not in this checkout. Real timers: PGlite does its own async work.
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '@/domain/types'
import { setClockOverride } from '@/lib/dates'
import { createApi, type FetchLike } from './api'
import { diffDB } from './diff'
import { createSyncEngine } from './engine'
import { workspaceIdOf } from './loadTime'
import { createStatusStore, createTestStore, makeDB, makePerson, memoryStorage, testEnv } from './testing/kit'

const helpersPath = fileURLToPath(new URL('../../server/src/test/helpers.ts', import.meta.url))
const appPath = fileURLToPath(new URL('../../server/src/app.ts', import.meta.url))
const available = existsSync(appPath) && existsSync(helpersPath)

type InjectResponse = { statusCode: number; body: string; headers: Record<string, unknown>; cookies: Array<{ name: string; value: string }> }
type InjectApp = {
  inject(opts: { method: string; url: string; headers: Record<string, string>; payload?: string }): Promise<InjectResponse>
  close(): Promise<void>
}
type TestDb = { close(): Promise<void>; query(sql: string, params?: unknown[]): Promise<unknown> }
type ServerHelpers = {
  makeTestDb(): Promise<TestDb>
  resetDb(db: TestDb): Promise<void>
  makeApp(db: TestDb, overrides?: Record<string, unknown>): Promise<InjectApp>
}

/** fetch() over app.inject(), with one cookie jar per browser. */
function injectFetch(app: () => InjectApp): FetchLike {
  let cookie: string | null = null
  return async (url, init = {}) => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) }
    if (cookie) headers.cookie = cookie
    const res = await app().inject({ method: init.method ?? 'GET', url, headers, payload: init.body as string | undefined })
    const session = res.cookies.find((c) => c.name === 'ft_session')
    if (session) cookie = session.value ? `ft_session=${session.value}` : null
    const noBody = res.statusCode === 204 || res.statusCode === 304
    return new Response(noBody ? null : res.body, { status: res.statusCode, headers: { 'Content-Type': String(res.headers['content-type'] ?? '') } })
  }
}

const PASSWORD = 'a demo password'

describe.skipIf(!available)('a demo server, end to end', () => {
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
    app = await h.makeApp(db, { signupMode: 'open', careersOrigin: 'https://careers.example.test' })
  })
  afterEach(async () => {
    for (const stop of stops.splice(0)) stop()
    await app.close()
  })

  /** One browser: its own store, storage and cookie jar. */
  function browser(start: DB = makeDB({ sample: true, company: 'Ledgerlark' })) {
    const store = createTestStore(start)
    const status = createStatusStore()
    const api = createApi({ fetch: injectFetch(() => app) })
    const engine = createSyncEngine({ store, api, storage: memoryStorage(), env: testEnv().env, status, debounceMs: 5, pullIntervalMs: 3_600_000 })
    stops.push(() => engine.stop())
    return {
      engine,
      api,
      st: () => status.getState(),
      db: () => store.getState().db,
      mutate: (recipe: Parameters<ReturnType<typeof store.getState>['mutate']>[1]) => store.getState().mutate('Edit', recipe),
      sync: async () => {
        await engine.syncNow()
        await engine.whenIdle()
      },
    }
  }

  /** Signs up a company from a fresh browser and uploads its first workspace (meta: its meta.workspaceId, when given). */
  async function founder(email: string, companyName: string, meta?: string | null) {
    const b = browser()
    const res = await b.engine.signUp({ email, password: PASSWORD, companyName })
    expect(res).toMatchObject({ ok: true, user: { email, role: 'admin' }, workspace: { name: companyName } })
    const company = makeDB({ company: companyName })
    company.people.push(makePerson('p-2', { firstName: companyName }))
    if (meta) (company.meta as { workspaceId?: string }).workspaceId = meta
    expect(await b.engine.uploadNew(company)).toEqual({ ok: true })
    await b.engine.whenIdle()
    expect(b.st()).toMatchObject({ status: 'synced', mode: 'server' })
    return b
  }

  it('signs up, uploads the new company, names its careers page, and lets an invited teammate join and sync', async () => {
    const first = browser()
    expect(await first.api.signupMode()).toMatchObject({ ok: true, data: { signupMode: 'open' } })

    const a = await founder('sam@example.com', 'Acme Robots')
    const me = await a.api.me()
    expect(me).toMatchObject({
      ok: true,
      data: { user: { email: 'sam@example.com' }, workspace: { name: 'Acme Robots', slug: expect.stringMatching(/^acme-robots-[a-z2-9]{6}$/) }, signupMode: 'open' },
    })
    if (me.ok) expect(me.data.careersUrl).toBe(`https://careers.example.test/${me.data.workspace?.slug}/`)
    // The connection knows which company it syncs with: the upload's answer named it.
    if (me.ok) expect(a.engine.getConnection().workspaceId).toBe(me.data.workspace?.id)

    const invite = await a.api.createInvite()
    expect(invite).toMatchObject({ ok: true, data: { url: expect.stringContaining('/#invite.') } })
    if (!invite.ok) return
    const token = invite.data.url.slice(invite.data.url.indexOf('#invite.') + '#invite.'.length)

    const b = browser()
    expect(await b.api.inviteInfo(token)).toEqual({ ok: true, status: 200, data: { companyName: 'Acme Robots' } })
    // An email that has a login already is refused, and the invite stays usable.
    expect(await b.engine.acceptInvite({ token, email: 'sam@example.com', password: PASSWORD })).toMatchObject({ ok: false, kind: 'email_taken' })
    expect(await b.engine.acceptInvite({ token, email: 'kim@example.com', password: PASSWORD })).toMatchObject({
      ok: true,
      user: { email: 'kim@example.com' },
      workspace: { name: 'Acme Robots' },
    })
    expect(await b.engine.useServerCopy()).toEqual({ ok: true })
    await b.engine.whenIdle()
    expect(diffDB(a.db(), b.db())).toEqual([])

    // Teammates sync both ways.
    b.mutate((d) => {
      d.people.find((p) => p.id === 'p-2')!.title = 'Robot whisperer'
    })
    await b.sync()
    await a.sync()
    expect(a.db().people.find((p) => p.id === 'p-2')?.title).toBe('Robot whisperer')

    // A used invite is gone for everyone.
    const c = browser()
    expect(await c.api.inviteInfo(token)).toMatchObject({ ok: false, kind: 'not_found' })
    const late = await c.engine.acceptInvite({ token, email: 'lee@example.com', password: PASSWORD })
    expect(late).toMatchObject({ ok: false, kind: 'not_found' })
  })

  it('keeps two demo companies apart: neither sees nor changes the other', async () => {
    const a = await founder('sam@example.com', 'Acme Robots')
    const z = await founder('zoe@example.com', 'Zeta Labs')
    expect(z.db().company.name).toBe('Zeta Labs')
    z.mutate((d) => {
      d.people.find((p) => p.id === 'p-2')!.title = 'Only at Zeta'
    })
    await z.sync()
    await a.sync()
    // Same record ids in both companies, different rows: each sees only its own.
    expect(a.db().company.name).toBe('Acme Robots')
    expect(a.db().people.find((p) => p.id === 'p-2')?.firstName).toBe('Acme Robots')
    expect(a.db().people.find((p) => p.id === 'p-2')?.title).not.toBe('Only at Zeta')
    const snapA = await a.api.getWorkspace()
    const snapZ = await z.api.getWorkspace()
    expect(snapA.ok && snapZ.ok && snapA.data.workspaceId !== snapZ.data.workspaceId).toBe(true)
    if (snapA.ok) expect(snapA.data.db.company.name).toBe('Acme Robots')
  })

  it('refuses a second sign-up with the same email, and refuses sign-ups on a closed server', async () => {
    await founder('sam@example.com', 'Acme Robots')
    const again = browser()
    expect(await again.engine.signUp({ email: 'SAM@example.com', password: PASSWORD, companyName: 'Another' })).toMatchObject({
      ok: false,
      kind: 'email_taken',
    })
    await app.close()
    app = await h.makeApp(db, { signupMode: 'closed' })
    const closed = browser()
    expect(await closed.api.signupMode()).toMatchObject({ ok: true, data: { signupMode: 'closed' } })
    const res = await closed.engine.signUp({ email: 'new@example.com', password: PASSWORD, companyName: 'Nope' })
    expect(res).toMatchObject({ ok: false, kind: 'not_found' })
    if (!res.ok) expect(res.message).toMatch(/does not take new demo companies/)
  })

  describe("a browser that holds one company's copy", () => {
    /** A's browser, signed out with a change waiting (a hire with personal data), and B's company on the same server. */
    async function setUp(bMeta: 'own' | 'same as A') {
      const a = await founder('sam@example.com', 'Acme Robots')
      const aMeta = workspaceIdOf(a.db())
      const z = await founder('zoe@example.com', 'Zeta Labs', bMeta === 'same as A' ? aMeta : null)
      expect(workspaceIdOf(z.db()) === aMeta).toBe(bMeta === 'same as A')
      expect((await a.engine.signOut()).ok).toBe(true)
      a.mutate((d) => {
        d.people.push(makePerson('p-hire', { firstName: 'Secret', lastName: 'Hire', personalEmail: 'secret.hire@example.com' }))
      })
      expect(a.engine.getConnection().outbox.length).toBeGreaterThan(0)
      return { a, z }
    }

    for (const bMeta of ['own', 'same as A'] as const) {
      it(`never carries on under another company's login, whose workspace has ${bMeta === 'own' ? 'its own identity' : "A's identity"}`, async () => {
        const { a, z } = await setUp(bMeta)
        const before = a.engine.getConnection()
        const res = await a.engine.signIn('zoe@example.com', PASSWORD)
        expect(res).toMatchObject({ ok: false, kind: 'other_company' })
        if (!res.ok) expect(res.message).toMatch(/That login belongs to Zeta Labs\. This browser holds Acme Robots's copy, with 1 change not sent yet/)
        // Nothing changed here: still Acme's copy, the change still waiting, still signed out.
        expect(a.db().company.name).toBe('Acme Robots')
        expect(a.engine.getConnection()).toMatchObject({ mode: 'server', workspaceId: before.workspaceId, outbox: before.outbox })
        expect(a.st().status).toBe('signed_out')
        // Nothing of Acme's reached Zeta, and the Zeta session ended again.
        await z.sync()
        expect(JSON.stringify(z.db())).not.toContain('secret.hire@example.com')
        const zSnap = await z.api.getWorkspace()
        expect(zSnap.ok && JSON.stringify(zSnap.data.db)).not.toContain('secret.hire@example.com')
        expect(await a.api.session()).toMatchObject({ ok: true, data: { user: null } })
        // Acme's own login carries on, and the waiting change lands in Acme.
        expect(await a.engine.signIn('sam@example.com', PASSWORD)).toMatchObject({ ok: true })
        await a.sync()
        expect(a.st()).toMatchObject({ status: 'synced' })
        const aSnap = await a.api.getWorkspace()
        expect(aSnap.ok && JSON.stringify(aSnap.data.db)).toContain('secret.hire@example.com')
      })
    }

    it("never merges into another company's workspace, even when the session underneath belongs to it", async () => {
      // The session check and the sign-in refuse first; this is what stands behind them: a session of
      // Zeta's login under Acme's synced browser (here: a sign-in made around the engine).
      const a = await founder('sam@example.com', 'Acme Robots')
      const z = await founder('zoe@example.com', 'Zeta Labs', workspaceIdOf(a.db()))
      expect((await a.api.login('zoe@example.com', PASSWORD)).ok).toBe(true)
      a.mutate((d) => {
        d.people.push(makePerson('p-hire', { firstName: 'Secret', lastName: 'Hire', personalEmail: 'secret.hire@example.com' }))
      })
      await a.sync()
      await z.sync()
      const zSnap = await z.api.getWorkspace()
      expect(zSnap.ok && JSON.stringify(zSnap.data.db)).not.toContain('secret.hire@example.com')
      expect(JSON.stringify(z.db())).not.toContain('secret.hire@example.com')
      // This browser took the other copy whole and says so; what it held is kept for a backup download.
      expect(a.st().replacedRemotely).toMatchObject({ companyName: 'Zeta Labs', previousName: 'Acme Robots' })
      expect(JSON.stringify(a.engine.getReplacedBackup())).toContain('secret.hire@example.com')
    })
  })
})
