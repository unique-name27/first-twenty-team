// GET and POST /__dev/workspace (development only, for npm run sim): the same protection as POST /__dev/sql
// (a loopback socket and the stack's secret, else 404 before the body is read), the stack's own company only,
// a body limit, and a replace that a browser's sync engine takes the way it takes another computer's Import.
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '@/domain/types'
import { setClockOverride } from '@/lib/dates'
import { createApi } from '../../../src/sync/api'
import { RECORD_COLLECTIONS } from '../../../src/sync/collections'
import { createSyncEngine, type SyncEngine } from '../../../src/sync/engine'
import { injectFetch } from '../../../src/sync/testing/inject'
import { createStatusStore, createTestStore, makeDB, makePerson, memoryStorage, testEnv } from '../../../src/sync/testing/kit'
import { buildApp, WORKSPACE_BODY_LIMIT } from '../app'
import { testConfig } from '../config'
import type { Db } from '../db'
import { ADMIN, createAdmin, CSRF, login, makeTestDb, resetDb } from '../test/helpers'
import { DEV_WORKSPACE_BODY_LIMIT, DEV_WORKSPACE_PATH, registerDevRoutes, stackWorkspaceOf } from './routes'
import { STACK_WORKSPACE } from './workspace'

// An invented secret for this test only (the stack makes a random one each run).
const SECRET = 'test-only-dev-tools-secret-0123456789abcdef'
const AUTH = { authorization: `Bearer ${SECRET}` }

let db: Db
let app: FastifyInstance

beforeAll(async () => {
  setClockOverride('2026-10-09')
  db = await makeTestDb()
}, 60_000)
afterAll(async () => {
  await db?.close()
  setClockOverride(null)
})
beforeEach(async () => {
  await resetDb(db)
  await createAdmin(db)
  app = await buildApp({ db, config: testConfig({ devTools: true }), logger: false })
  await registerDevRoutes(app, { db, secret: SECRET })
  await app.ready()
})
afterEach(async () => {
  await app.close()
})

/** A small company with an identity, as the app uploads one. */
function company(name: string, workspaceId: string, people = 1): DB {
  const d = makeDB({ company: name })
  d.meta = { ...d.meta, workspaceId } as DB['meta']
  for (let i = 0; i < people; i++) d.people.push(makePerson(`p-${i + 1}`))
  return d
}

const read = (headers: Record<string, string> = AUTH, url = DEV_WORKSPACE_PATH, remoteAddress = '127.0.0.1') =>
  app.inject({ method: 'GET', url, headers, remoteAddress })
const replace = (payload: unknown, headers: Record<string, string> = AUTH, remoteAddress = '127.0.0.1') =>
  app.inject({ method: 'POST', url: DEV_WORKSPACE_PATH, headers, payload: payload as Record<string, unknown>, remoteAddress })

describe('/__dev/workspace: who it answers', () => {
  it('reads and replaces the stack\'s company for a loopback request with the secret', async () => {
    expect((await read()).json()).toEqual({ empty: true, workspaceId: STACK_WORKSPACE })
    const tidebeam = company('Tidebeam', 'ws-one', 3)
    const res = await replace({ db: tidebeam })
    expect(res.statusCode, res.body).toBe(200)
    const records = RECORD_COLLECTIONS.reduce((n, c) => n + ((tidebeam as unknown as Record<string, unknown[]>)[c]?.length ?? 0), 0)
    expect(res.json()).toMatchObject({ workspaceId: STACK_WORKSPACE, historyId: expect.any(String), records })
    expect(res.headers['cache-control']).toBe('no-store')

    const got = await read()
    expect(got.statusCode).toBe(200)
    expect(got.headers['cache-control']).toBe('no-store')
    const body = got.json()
    expect(body).toMatchObject({ empty: false, workspaceId: STACK_WORKSPACE, historyId: res.json().historyId, seq: res.json().seq })
    expect(body.db.company.name).toBe('Tidebeam')
    expect(body.db.people.map((p: { id: string }) => p.id)).toEqual(['p-founder', 'p-1', 'p-2', 'p-3'])
    expect(body.db.meta.workspaceId).toBe('ws-one')
  })

  it('answers 404, as for a path that does not exist, without the right secret or from another computer', async () => {
    const notFound = (await app.inject({ method: 'GET', url: '/__dev/nothing-here' })).json()
    const wrong: Record<string, string>[] = [{}, { authorization: 'Bearer wrong-secret-of-the-same-sort-0123456789abc' }, { authorization: SECRET }, { authorization: `Basic ${SECRET}` }]
    for (const headers of wrong) {
      for (const res of [await read(headers), await replace({ db: company('Nope', 'ws-nope') }, headers)]) {
        expect(res.statusCode, JSON.stringify(headers)).toBe(404)
        expect(res.json()).toEqual(notFound)
      }
    }
    for (const address of ['10.0.0.5', '::ffff:192.168.1.20', '2001:db8::1']) {
      expect((await read(AUTH, DEV_WORKSPACE_PATH, address)).statusCode, address).toBe(404)
      expect((await replace({ db: company('Nope', 'ws-nope') }, AUTH, address)).statusCode, address).toBe(404)
    }
    expect((await read({ ...AUTH, 'x-forwarded-for': '127.0.0.1' }, DEV_WORKSPACE_PATH, '10.0.0.5')).statusCode).toBe(404)
    expect((await read(AUTH, DEV_WORKSPACE_PATH, '::1')).statusCode).toBe(200)
    // Nothing was replaced by any of them.
    expect((await read()).json()).toEqual({ empty: true, workspaceId: STACK_WORKSPACE })
  })

  it('never answers a signed-in session: the secret is the only key', async () => {
    const cookie = await login(app)
    expect((await read({ ...CSRF, cookie })).statusCode).toBe(404)
    expect((await replace({ db: company('Nope', 'ws-nope') }, { ...CSRF, cookie })).statusCode).toBe(404)
  })

  it('refuses before reading the body: 404 without the secret even when the body is too large, 413 with it', async () => {
    const big = { db: { ...company('Big', 'ws-big'), company: { ...makeDB().company, tagline: 'x'.repeat(DEV_WORKSPACE_BODY_LIMIT) } } }
    expect((await replace(big, {})).statusCode).toBe(404)
    expect((await replace(big)).statusCode).toBe(413)
    expect(DEV_WORKSPACE_BODY_LIMIT).toBe(WORKSPACE_BODY_LIMIT)
  })

  it('answers GET and POST only', async () => {
    for (const method of ['PUT', 'DELETE', 'PATCH'] as const) {
      expect((await app.inject({ method, url: DEV_WORKSPACE_PATH, headers: AUTH, remoteAddress: '127.0.0.1' })).statusCode, method).toBe(404)
    }
  })
})

describe('/__dev/workspace: the stack\'s company only', () => {
  it('refuses any other workspace id, in the query or the body, and changes nothing', async () => {
    expect((await replace({ db: company('Tidebeam', 'ws-one') })).statusCode).toBe(200)
    const before = (await read()).json()
    for (const url of [`${DEV_WORKSPACE_PATH}?workspaceId=other`, `${DEV_WORKSPACE_PATH}?workspaceId=${STACK_WORKSPACE}&workspaceId=other`]) {
      const res = await read(AUTH, url)
      expect(res.statusCode, url).toBe(403)
      expect(res.json().error).toBe('other_workspace')
    }
    for (const workspaceId of ['other', '', 7, null]) {
      const res = await replace({ workspaceId, db: company('Elsewhere', 'ws-two') })
      expect(res.statusCode, String(workspaceId)).toBe(403)
    }
    expect((await read()).json()).toEqual(before)
    expect((await read(AUTH, `${DEV_WORKSPACE_PATH}?workspaceId=${STACK_WORKSPACE}`)).json()).toEqual(before)
    expect((await replace({ workspaceId: STACK_WORKSPACE, db: company('Again', 'ws-three') })).statusCode).toBe(200)
  })

  it('refuses a body that is not a workspace, with the reason', async () => {
    for (const payload of [{}, { db: 'x' }, { db: [] }]) {
      const res = await replace(payload)
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
      expect(res.json().error).toBe('refused')
    }
    const twice = company('Twice', 'ws-twice')
    twice.people.push(makePerson('p-1'))
    const res = await replace({ db: twice })
    expect(res.statusCode).toBe(400)
    expect(res.json().detail).toMatch(/appears more than once/)
    expect((await read()).json().empty).toBe(true)
  })

  it('names the stack\'s workspace when a request names none', () => {
    expect(stackWorkspaceOf(undefined, 'default')).toBe('default')
    expect(stackWorkspaceOf('default', 'default')).toBe('default')
    for (const other of ['other', 'Default', '', null, 0, ['default']]) expect(stackWorkspaceOf(other, 'default')).toBeNull()
  })
})

describe('a browser that syncs with the stack', () => {
  const engines: SyncEngine[] = []
  afterEach(() => {
    for (const e of engines.splice(0)) e.stop()
  })

  async function connectedBrowser(start: DB) {
    const store = createTestStore(start)
    const status = createStatusStore()
    const engine = createSyncEngine({
      store,
      api: createApi({ fetch: injectFetch(() => app) }),
      storage: memoryStorage(),
      env: testEnv().env,
      status,
      debounceMs: 5,
      pullIntervalMs: 3_600_000,
    })
    engines.push(engine)
    expect(await engine.signIn(ADMIN.email, ADMIN.password)).toMatchObject({ ok: true })
    expect(await engine.inspectServer()).toEqual({ ok: true, empty: true })
    expect(await engine.uploadLocal()).toEqual({ ok: true })
    await engine.whenIdle()
    return {
      st: () => status.getState(),
      db: () => store.getState().db,
      edit: (label: string, recipe: (d: DB) => void) => store.getState().mutate(label, recipe),
      sync: async () => {
        await engine.syncNow()
        await engine.whenIdle()
      },
    }
  }

  it('takes a reset (another company) whole, with the replaced notice', async () => {
    const browser = await connectedBrowser(company('Acme', 'ws-acme'))
    expect((await replace({ db: company('Tidebeam', 'ws-tidebeam', 2) })).statusCode).toBe(200)
    await browser.sync()
    expect(browser.db().company.name).toBe('Tidebeam')
    expect(browser.db().people.map((p) => p.id)).toEqual(['p-founder', 'p-1', 'p-2'])
    expect(browser.st().replacedRemotely).toMatchObject({ companyName: 'Tidebeam', previousName: 'Acme' })
  })

  it('takes an advance or a restore (the same company, a new history), with the restored notice', async () => {
    const browser = await connectedBrowser(company('Acme', 'ws-acme'))
    const later = (await read()).json().db as DB
    later.people.push(makePerson('p-new', { startDate: '2026-11-02' }))
    expect((await replace({ db: later })).statusCode).toBe(200)
    await browser.sync()
    expect(browser.db().people.map((p) => p.id)).toContain('p-new')
    expect(browser.st()).toMatchObject({ replacedRemotely: null, restoredRemotely: { at: expect.any(String) } })
  })

  it('keeps an edit the app synced after an advance read the company: that replace gets 409 and changes nothing', async () => {
    const browser = await connectedBrowser(company('Acme', 'ws-acme'))
    const first = (await read()).json()
    const lived = first.db as DB
    lived.people.push(makePerson('p-new', { startDate: '2026-11-02' }))
    // The app syncs an edit while npm run sim lives the days.
    browser.edit('Rename the company', (d) => {
      d.company.name = 'Acme Rockets'
    })
    await browser.sync()
    const stale = await replace({ db: lived, expected: { historyId: first.historyId, seq: first.seq } })
    expect(stale.statusCode, stale.body).toBe(409)
    expect(stale.json().error).toBe('changed_meanwhile')
    expect((await read()).json().db.company.name).toBe('Acme Rockets')
    // Read again, and a replace that sends what it read goes through.
    const second = (await read()).json()
    expect((await replace({ db: second.db, expected: { historyId: second.historyId, seq: second.seq } })).statusCode).toBe(200)
    for (const expected of [{ historyId: second.historyId }, { historyId: 7, seq: 1 }, 'latest']) {
      expect((await replace({ db: second.db, expected })).statusCode, JSON.stringify(expected)).toBe(400)
    }
  })
})
