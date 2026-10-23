// A public demo server (SIGNUP_MODE=open): signing up makes a login and an empty company, the new
// company's workspace goes up with uploadNew, an invite link brings a teammate in (acceptInvite, then the
// server's copy), the login's company (name, careers page) is asked once per sign-in, and a browser that
// holds one company's copy never carries on under a login of another.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DB } from '@/domain/types'
import { setClockOverride } from '@/lib/dates'
import { createStore } from 'zustand/vanilla'
import { createAccountLoader } from './account'
import type { SyncApi } from './api'
import { diffDB } from './diff'
import { CONNECTED_ACCOUNT_MESSAGE, createSyncEngine, SAMPLE_MESSAGE } from './engine'
import { workspaceIdOf } from './loadTime'
import { LOGOUT_PENDING_KEY, loadConnection } from './state'
import type { SyncStatusState } from './status'
import { FakeServer, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from './testing/fakeServer'
import { createStatusStore, createTestStore, makeDB, makePerson, memoryStorage, testEnv } from './testing/kit'

const cleanups: Array<() => void> = []

beforeAll(() => setClockOverride('2026-10-10'))
beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-10T17:00:00.000Z') })
})
afterEach(() => {
  for (const stop of cleanups.splice(0)) stop()
  vi.useRealTimers()
})

function device(api: SyncApi, db: DB = makeDB({ sample: true, company: 'Ledgerlark' }), storage = memoryStorage()) {
  const store = createTestStore(db)
  const status = createStatusStore()
  const env = testEnv()
  const engine = createSyncEngine({ store, api, storage, env: env.env, status })
  cleanups.push(() => engine.stop())
  return { store, status, storage, engine, emit: env.emit, db: () => store.getState().db, conn: () => engine.getConnection(), st: () => status.getState() }
}

function demoServer(): FakeServer {
  const server = new FakeServer()
  server.signedIn = false
  server.signupOpen = true
  return server
}

const PASSWORD = 'a demo password'
const signup = { email: ' Sam@Example.test ', password: PASSWORD, companyName: '  Acme Robots ' }

describe('signing up for a demo company', () => {
  it('makes a login, signs in, then puts the new company on the server and syncs it', async () => {
    const server = demoServer()
    const d = device(server)
    const res = await d.engine.signUp(signup)
    expect(res).toEqual({
      ok: true,
      user: { id: server.user.id, email: 'sam@example.test', role: 'admin' },
      workspace: { id: server.workspace?.id, name: 'Acme Robots', slug: 'acme-robots' },
    })
    // Signed in like a sign-in: the user is known, nothing syncs yet, the browser still shows the sample.
    expect(d.st()).toMatchObject({ mode: 'local', user: { email: 'sam@example.test' }, signedOutByUser: false })
    expect(d.conn().mode).toBe('local')
    expect(d.db().meta.sample).toBe(true)

    const fresh = makeDB({ company: 'Acme Robots' })
    fresh.people.push(makePerson('p-2'))
    expect(await d.engine.uploadNew(fresh)).toEqual({ ok: true })
    await d.engine.whenIdle()
    expect(d.st()).toMatchObject({ status: 'synced', mode: 'server', hold: null })
    expect(d.conn()).toMatchObject({ mode: 'server', outbox: [], seq: server.seq })
    expect(diffDB(d.db(), server.snapshot())).toEqual([])
    expect(server.snapshot().company.name).toBe('Acme Robots')
    // It got its identity before it left, so every device that takes the server's copy shares it.
    expect(workspaceIdOf(d.db())).toBeTruthy()
    expect(workspaceIdOf(server.snapshot())).toBe(workspaceIdOf(d.db()))
    // No Undo step can swap the sample back over the new company.
    expect(d.store.getState().past).toEqual([])
    expect(loadConnection(d.storage).mode).toBe('server')
    // From now on edits sync like any other.
    d.store.getState().mutate('Edit', (x) => {
      x.people[0].title = 'Founder and chief robot'
    })
    await vi.advanceTimersByTimeAsync(1000)
    await d.engine.whenIdle()
    expect((server.record('people', d.db().people[0].id) as { title: string }).title).toBe('Founder and chief robot')
  })

  it('sends the email and company name trimmed, and Keep me signed in only when asked', async () => {
    const server = demoServer()
    const seen: unknown[] = []
    const real = server.signup.bind(server)
    server.signup = (input) => {
      seen.push(input)
      return real(input)
    }
    const d = device(server)
    await d.engine.signUp({ ...signup, remember: true })
    expect(seen).toEqual([{ email: 'Sam@Example.test', password: PASSWORD, companyName: 'Acme Robots', remember: true }])
    const e = device(server)
    await e.engine.signUp({ ...signup, email: 'kim@example.test' })
    expect(seen[1]).toMatchObject({ remember: false })
  })

  it('says plainly why nothing was created, and stays signed out', async () => {
    const closed = new FakeServer()
    closed.signedIn = false
    const a = device(closed)
    const no = await a.engine.signUp(signup)
    expect(no).toMatchObject({ ok: false, kind: 'not_found' })
    if (!no.ok) expect(no.message).toMatch(/does not take new demo companies/)
    expect(a.st().user).toBeNull()

    const server = demoServer()
    const b = device(server)
    const taken = await b.engine.signUp({ ...signup, email: TEST_ADMIN_EMAIL })
    expect(taken).toMatchObject({ ok: false, kind: 'email_taken', status: 409 })
    if (!taken.ok) expect(taken.message).toMatch(/already has a login/)
    expect(b.st().user).toBeNull()

    server.failures.push({ ok: false, kind: 'rate_limited', status: 429, error: 'rate_limited', retryAfter: 1800 })
    const slow = await b.engine.signUp(signup)
    expect(slow).toMatchObject({ ok: false, kind: 'rate_limited', retryAfter: 1800 })
    if (!slow.ok) expect(slow.message).toMatch(/Try again in 30 minutes/)

    server.failures.push({ ok: false, kind: 'demo_full', status: 503, error: 'demo_full' })
    expect(await b.engine.signUp(signup)).toMatchObject({ ok: false, kind: 'demo_full' })
    server.online = false
    const off = await b.engine.signUp(signup)
    expect(off).toMatchObject({ ok: false, kind: 'offline' })
    if (!off.ok) expect(off.message).not.toMatch(/Changes stay/)
    expect(b.st().user).toBeNull()
  })

  it('is refused while this browser syncs with a company: its queued changes must never go out under another login', async () => {
    const server = new FakeServer()
    server.signupOpen = true
    const d = device(server, makeDB({ company: 'Acme' }))
    expect(await d.engine.uploadLocal()).toEqual({ ok: true })
    await d.engine.whenIdle()
    const res = await d.engine.signUp({ ...signup, email: 'kim@example.test' })
    expect(res).toEqual({ ok: false, kind: 'pending', status: null, message: CONNECTED_ACCOUNT_MESSAGE })
    expect(await d.engine.acceptInvite({ token: 'test-invite-1-abcdefghijklmnop', email: 'kim@example.test', password: PASSWORD })).toMatchObject({
      ok: false,
      kind: 'pending',
    })
    expect(await d.engine.uploadNew(makeDB({ company: 'Other' }))).toMatchObject({ ok: false, kind: 'pending' })
    expect(server.callCount('signup')).toBe(0)
    expect(server.callCount('acceptInvite')).toBe(0)
    expect(server.snapshot().company.name).toBe('Acme')
  })

  it('a sign-up ends a sign-out the server never confirmed, as a sign-in does', async () => {
    const server = demoServer()
    const storage = memoryStorage()
    storage.setItem(LOGOUT_PENDING_KEY, '1')
    const d = device(server, undefined, storage)
    expect((await d.engine.signUp(signup)).ok).toBe(true)
    expect(storage.getItem(LOGOUT_PENDING_KEY)).toBeNull()
  })
})

describe("a login of another company on a browser that holds one company's copy", () => {
  const bravo = { id: 'ws-bravo', name: 'Bravo Co', slug: 'bravo-co' }
  const mallory = { id: '00000000-0000-4000-8000-00000000b0b0', email: 'mallory@bravo.test', role: 'admin' }

  /** Acme's browser, synced, then signed out with an edit waiting; the server keeps Acme for now. */
  async function acmeSignedOutWithAnEdit(server: FakeServer) {
    const d = device(server)
    await d.engine.signUp(signup)
    expect(await d.engine.uploadNew(makeDB({ company: 'Acme Robots' }))).toEqual({ ok: true })
    await d.engine.whenIdle()
    // The connection names the company the upload went to (the upload's answer says).
    expect(d.conn().workspaceId).toBe(server.workspace?.id)
    expect((await d.engine.signOut()).ok).toBe(true)
    d.store.getState().mutate('Edit', (x) => {
      x.people[0].title = 'Changed while signed out'
    })
    return d
  }

  it('refuses the sign-in, ends that session again, and keeps the copy and its waiting change as they were', async () => {
    const server = demoServer()
    const d = await acmeSignedOutWithAnEdit(server)
    const outbox = d.conn().outbox
    const pushes = server.pushes.length
    server.switchCompany(bravo, mallory, makeDB({ company: 'Bravo Co' }))
    server.signedIn = false
    const res = await d.engine.signIn('mallory@bravo.test', TEST_ADMIN_PASSWORD)
    expect(res).toMatchObject({ ok: false, kind: 'other_company', status: null })
    if (!res.ok) {
      expect(res.message).toBe(
        "That login belongs to Bravo Co. This browser holds Acme Robots's copy, with 1 change not sent yet, so nothing changed and it stays signed out. Sign in with a login of Acme Robots to send it, or disconnect this browser first (Disconnect, below) to use Bravo Co here.",
      )
    }
    expect(server.signedIn).toBe(false)
    expect(server.callCount('logout')).toBeGreaterThan(0)
    await vi.advanceTimersByTimeAsync(5000)
    await d.engine.whenIdle()
    expect(server.pushes.length).toBe(pushes)
    expect(d.conn().outbox).toEqual(outbox)
    expect(d.db().company.name).toBe('Acme Robots')
    expect(d.db().people[0].title).toBe('Changed while signed out')
    expect(d.st()).toMatchObject({ status: 'signed_out', replacedRemotely: null })
    expect(server.snapshot().company.name).toBe('Bravo Co')
  })

  it('ends the other session later when the server cannot be reached to end it now', async () => {
    const server = demoServer()
    const d = await acmeSignedOutWithAnEdit(server)
    server.switchCompany(bravo, mallory, null)
    server.signedIn = false
    const real = server.logout.bind(server)
    let calls = 0
    server.logout = () => {
      calls += 1
      return calls === 1 ? Promise.resolve({ ok: false, kind: 'offline', status: null, error: null }) : real()
    }
    expect(await d.engine.signIn('mallory@bravo.test', TEST_ADMIN_PASSWORD)).toMatchObject({ ok: false, kind: 'other_company' })
    expect(d.storage.getItem(LOGOUT_PENDING_KEY)).toBe('1')
    expect(server.signedIn).toBe(true)
    d.emit('online')
    await vi.advanceTimersByTimeAsync(10)
    expect(server.signedIn).toBe(false)
    expect(d.storage.getItem(LOGOUT_PENDING_KEY)).toBeNull()
  })

  it('never picks the copy up under another company\'s session that another tab signed in to', async () => {
    const server = demoServer()
    const d = await acmeSignedOutWithAnEdit(server)
    const pushes = server.pushes.length
    server.switchCompany(bravo, mallory, makeDB({ company: 'Bravo Co' }))
    expect(server.signedIn).toBe(true)
    expect(await d.engine.checkServer()).toMatchObject({ ok: true, signedIn: false, user: null })
    d.emit('focus')
    await vi.advanceTimersByTimeAsync(5000)
    await d.engine.whenIdle()
    expect(server.callCount('session')).toBeGreaterThan(1)
    expect(server.pushes.length).toBe(pushes)
    expect(d.st().status).toBe('signed_out')
    expect(d.db().company.name).toBe('Acme Robots')
  })

  it('stops syncing when the session it was syncing under turns out to be another company\'s', async () => {
    const server = demoServer()
    const d = device(server)
    await d.engine.signUp(signup)
    await d.engine.uploadNew(makeDB({ company: 'Acme Robots' }))
    await d.engine.whenIdle()
    server.switchCompany(bravo, mallory, makeDB({ company: 'Bravo Co' }))
    expect(await d.engine.checkServer()).toMatchObject({ ok: true, signedIn: false })
    const pushes = server.pushes.length
    d.store.getState().mutate('Edit', (x) => {
      x.people[0].title = 'Never for Bravo'
    })
    await vi.advanceTimersByTimeAsync(5000)
    await d.engine.whenIdle()
    expect(server.pushes.length).toBe(pushes)
    expect(d.st().status).toBe('signed_out')
  })

  it('carries on as before with a login of its own company, and on servers that name no company', async () => {
    const server = demoServer()
    const d = await acmeSignedOutWithAnEdit(server)
    // Sam's own login (the fake signs other logins in with the test password).
    server.otherLogins.set('sam@example.test', { user: { ...server.user }, workspace: { ...server.workspace! } })
    expect(await d.engine.signIn('sam@example.test', TEST_ADMIN_PASSWORD)).toMatchObject({ ok: true })
    await d.engine.whenIdle()
    expect(d.st().status).toBe('synced')
    expect((server.record('people', d.db().people[0].id) as { title: string }).title).toBe('Changed while signed out')
    // A server from before companies names none: the single company it holds is this one.
    const old = new FakeServer()
    const e = device(old, makeDB({ company: 'Solo' }))
    expect(await e.engine.uploadLocal()).toEqual({ ok: true })
    await e.engine.whenIdle()
    expect(e.conn().workspaceId).toBe('default')
    await e.engine.signOut()
    expect(await e.engine.signIn(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)).toMatchObject({ ok: true })
  })
})

describe('uploading the new company (uploadNew)', () => {
  it('changes nothing in this browser when the upload fails, so it can be tried again', async () => {
    const server = demoServer()
    const d = device(server)
    await d.engine.signUp(signup)
    const before = d.db()
    server.online = false
    const res = await d.engine.uploadNew(makeDB({ company: 'Acme Robots' }))
    expect(res).toMatchObject({ ok: false, kind: 'offline' })
    expect(d.db()).toBe(before)
    expect(d.conn().mode).toBe('local')
    server.online = true
    expect(await d.engine.uploadNew(makeDB({ company: 'Acme Robots' }))).toEqual({ ok: true })
    expect(d.db().company.name).toBe('Acme Robots')
  })

  it('never puts a workspace over one the server already holds, and never uploads the sample', async () => {
    const server = demoServer()
    const d = device(server)
    await d.engine.signUp(signup)
    expect(await d.engine.uploadNew(makeDB({ sample: true }))).toEqual({ ok: false, kind: 'sample', status: null, message: SAMPLE_MESSAGE })
    server.hasWorkspace = true
    expect(await d.engine.uploadNew(makeDB({ company: 'Acme Robots' }))).toMatchObject({ ok: false, kind: 'not_empty' })
    expect(d.db().meta.sample).toBe(true)
  })

  it('needs a session', async () => {
    const server = demoServer()
    const d = device(server)
    const res = await d.engine.uploadNew(makeDB({ company: 'Acme Robots' }))
    expect(res).toMatchObject({ ok: false, kind: 'signed_out' })
    expect(d.conn().mode).toBe('local')
  })
})

describe('joining a company with an invite link', () => {
  it('makes a login in the company, then takes its workspace and syncs', async () => {
    const server = demoServer()
    const founder = device(server)
    await founder.engine.signUp(signup)
    const company = makeDB({ company: 'Acme Robots' })
    company.people.push(makePerson('p-2'))
    expect(await founder.engine.uploadNew(company)).toEqual({ ok: true })
    const invite = await server.createInvite()
    if (!invite.ok) throw new Error('no invite')
    const token = invite.data.url.split('#invite.')[1]

    server.signedIn = false
    const kim = device(server, makeDB({ sample: true }))
    expect(await server.inviteInfo(token)).toMatchObject({ ok: true, data: { companyName: 'Acme Robots' } })
    const res = await kim.engine.acceptInvite({ token, email: ' Kim@Example.test ', password: PASSWORD })
    expect(res).toMatchObject({ ok: true, user: { email: 'kim@example.test' }, workspace: { name: 'Acme Robots' } })
    expect(kim.st().user?.email).toBe('kim@example.test')
    expect(await kim.engine.useServerCopy()).toEqual({ ok: true })
    await kim.engine.whenIdle()
    expect(kim.st()).toMatchObject({ status: 'synced', mode: 'server' })
    expect(kim.db().company.name).toBe('Acme Robots')
    expect(kim.db().people.map((p) => p.id)).toContain('p-2')
  })

  it('refuses a used or unknown invite and an email that has a login, and stays signed out', async () => {
    const server = demoServer()
    server.workspace = { id: 'ws-9', name: 'Acme Robots', slug: 'acme-robots' }
    server.signedIn = true
    const invite = await server.createInvite()
    if (!invite.ok) throw new Error('no invite')
    const token = invite.data.url.split('#invite.')[1]
    server.signedIn = false
    const d = device(server)
    const taken = await d.engine.acceptInvite({ token, email: TEST_ADMIN_EMAIL, password: PASSWORD })
    expect(taken).toMatchObject({ ok: false, kind: 'email_taken' })
    expect(await d.engine.acceptInvite({ token, email: 'kim@example.test', password: PASSWORD })).toMatchObject({ ok: true })
    const e = device(server)
    const used = await e.engine.acceptInvite({ token, email: 'lee@example.test', password: PASSWORD })
    expect(used).toMatchObject({ ok: false, kind: 'not_found' })
    if (!used.ok) expect(used.message).toMatch(/This invite link does not work/)
    expect(e.st().user).toBeNull()
  })
})

describe('the signed-in login\'s company (account loader)', () => {
  type StatusState = Pick<SyncStatusState, 'user'>
  const sam = { id: 'u-sam', email: 'sam@example.test', role: 'admin' }

  function setup() {
    const server = demoServer()
    server.signedIn = true
    server.user = sam
    server.workspace = { id: 'ws-1', name: 'Acme Robots', slug: 'acme-robots' }
    server.careersOrigin = 'https://careers.example.test'
    const status = createStore<StatusState>()(() => ({ user: null }))
    const loader = createAccountLoader(server, status)
    cleanups.push(loader.dispose)
    return { server, status, loader }
  }

  it('asks once per sign-in and names the company and its careers page', async () => {
    const { server, status, loader } = setup()
    expect(await loader.load()).toBeNull()
    expect(server.callCount('me')).toBe(0)
    status.setState({ user: sam })
    const account = await loader.load()
    expect(account).toEqual({
      userId: 'u-sam',
      email: 'sam@example.test',
      role: 'admin',
      workspace: { id: 'ws-1', name: 'Acme Robots', slug: 'acme-robots' },
      careersUrl: 'https://careers.example.test/acme-robots/',
      careersEnabled: true,
      signupMode: 'open',
    })
    expect(loader.store.getState().account).toEqual(account)
    await loader.load()
    expect(server.callCount('me')).toBe(1)
    await loader.load({ force: true })
    expect(server.callCount('me')).toBe(2)
  })

  it('says whether the careers page is public, and follows the switch', async () => {
    const { server, status, loader } = setup()
    server.careersEnabled = false
    status.setState({ user: sam })
    expect(await loader.load()).toMatchObject({ careersUrl: 'https://careers.example.test/acme-robots/', careersEnabled: false })
    expect(await server.setCareers(true)).toMatchObject({ ok: true, data: { careersEnabled: true } })
    expect(await loader.load({ force: true })).toMatchObject({ careersEnabled: true })
  })

  it('forgets the company the moment the login changes, and drops an answer about the old one', async () => {
    const { server, status, loader } = setup()
    status.setState({ user: sam })
    await loader.load()
    status.setState({ user: null })
    expect(loader.store.getState().account).toBeNull()
    // A sign-in that changes while the answer is on its way: the answer describes nobody shown now.
    status.setState({ user: sam })
    const asking = loader.load()
    status.setState({ user: { id: 'u-kim', email: 'kim@example.test', role: 'admin' } })
    expect(await asking).toBeNull()
    expect(loader.store.getState().account).toBeNull()
    expect(server.callCount('me')).toBe(2)
  })

  it('asks again next time when the server could not answer, and says null on a server without companies', async () => {
    const { server, status, loader } = setup()
    status.setState({ user: sam })
    server.online = false
    expect(await loader.load()).toBeNull()
    server.online = true
    expect(await loader.load()).toMatchObject({ workspace: { name: 'Acme Robots' } })
    server.workspace = null
    expect(await loader.load({ force: true })).toMatchObject({ workspace: null, careersUrl: null, careersEnabled: true, signupMode: null })
  })

  it('a server with no careers pages gives no careers link', async () => {
    const { server, status, loader } = setup()
    server.careersOrigin = null
    status.setState({ user: sam })
    expect(await loader.load()).toMatchObject({ careersUrl: null, workspace: { slug: 'acme-robots' } })
  })
})
