// HTTP tests for companies on one server (docs/SYNC.md, Companies): demo sign-up and its limits (which
// only what was created counts toward server-wide), invites (looked up without a token in the path,
// listed, revoked, and refused before any password work when they do not work), /api/auth/me and the
// careers switch, the demo write limits, tenant isolation through every route, and the careers hosts.
// In-memory PGlite and app.inject(), like app.test.ts.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import type { DB } from '@/domain/types'
import { buildApp, type CareersRoutes, careersHostPattern, loggerOptions, redactPath } from './app'
import { fakeAssistantClient } from './assistant/fake'
import { AddressRateLimiter, ConcurrencyGate, hashToken } from './auth'
import { WriteBudget } from './writeBudget'
import { type Config, testConfig } from './config'
import { CAREERS_CSP } from './csp'
import type { Db } from './db'
import { registerDevRoutes } from './dev/routes'
import { applyChanges, snapshot } from './repo'
import { WORKSPACE_ID } from './sqlgen'
import { ADMIN, createAdmin, CSRF, login, makeApp, makeTestDb, resetDb, sessionCookie, type SignedUp, signUp } from './test/helpers'
import { parseChanges } from './validate'
import { findWorkspaceBySlug } from './workspaces'

let db: Db
const apps: FastifyInstance[] = []

beforeAll(async () => {
  db = await makeTestDb()
})
afterAll(async () => {
  await db.close()
})
beforeEach(async () => {
  await resetDb(db)
  await createAdmin(db)
})
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close()
})

async function open(overrides: Partial<Config> = {}, options: Omit<Parameters<typeof buildApp>[0], 'db' | 'config' | 'logger'> = {}): Promise<FastifyInstance> {
  const app = await buildApp({ db, config: testConfig({ signupMode: 'open', ...overrides }), logger: false, ...options })
  await app.ready()
  apps.push(app)
  return app
}

const company = (name: string, marker: string): DB => {
  const d = blankDB({ companyName: name, founderFirstName: 'Ada', founderLastName: marker, foundedOn: '2026-01-05' })
  return { ...d, jobs: [{ ...({} as DB['jobs'][number]), id: `j-${marker}`, title: `Secret ${marker} role` } as DB['jobs'][number]] }
}

const signupBody = (extra: Record<string, unknown> = {}) => ({ email: 'founder@acme.test', password: ADMIN.password, companyName: 'Acme Robotics', ...extra })

describe('sign-up', () => {
  it('does not exist while SIGNUP_MODE is closed, and says so on the public mode route', async () => {
    const closed = await open({ signupMode: 'closed', demoExpireDays: 14 })
    const res = await closed.inject({ method: 'POST', url: '/api/auth/signup', headers: CSRF, payload: signupBody() })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'not_found' })
    // Refused before the body is read: malformed JSON is a 404 too.
    const raw = await closed.inject({ method: 'POST', url: '/api/auth/signup', headers: { ...CSRF, 'content-type': 'application/json' }, payload: '{x' })
    expect(raw.statusCode).toBe(404)
    const mode = await closed.inject({ method: 'GET', url: '/api/auth/signup-mode' })
    expect(mode.statusCode).toBe(200)
    expect(mode.json()).toEqual({ signupMode: 'closed', demoExpireDays: 14 })
    expect(mode.headers['cache-control']).toBe('no-store')
    expect((await db.query(`SELECT 1 FROM users WHERE email = 'founder@acme.test'`)).rows).toEqual([])
  })

  it('creates a login and an empty company, signs in like a sign-in, and the app uploads the company next', async () => {
    const app = await open()
    expect((await app.inject({ method: 'GET', url: '/api/auth/signup-mode' })).json()).toEqual({ signupMode: 'open', demoExpireDays: 30 })
    const res = await app.inject({ method: 'POST', url: '/api/auth/signup', headers: CSRF, payload: signupBody({ remember: true }) })
    expect(res.statusCode, res.body).toBe(201)
    const body = res.json()
    expect(body).toEqual({
      user: { id: expect.any(String), email: 'founder@acme.test', role: 'admin' },
      workspace: { id: expect.stringMatching(/^w-/), name: 'Acme Robotics', slug: expect.stringMatching(/^acme-robotics-[a-z2-9]{6}$/) },
    })
    // The same cookies as a sign-in: a remembered session and a trusted device, both stored as hashes.
    const token = sessionCookie(res)!
    expect(String(res.headers['set-cookie'])).toMatch(/ft_session=[A-Za-z0-9_-]{43}; Max-Age=604800; Path=\/api; HttpOnly; SameSite=Strict/)
    expect(String(res.headers['set-cookie'])).toMatch(/ft_device=[A-Za-z0-9_-]{43}; Max-Age=15552000/)
    expect((await db.query('SELECT token_hash FROM sessions WHERE token_hash = $1', [hashToken(token)])).rows).toHaveLength(1)
    const headers = { ...CSRF, cookie: `ft_session=${token}` }

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers })
    expect(me.json()).toEqual({ user: body.user, workspace: body.workspace, careersUrl: null, careersEnabled: true, signupMode: 'open' })
    expect((await app.inject({ method: 'GET', url: '/api/workspace/status', headers })).json()).toEqual({ empty: true })
    const up = await app.inject({ method: 'PUT', url: '/api/workspace', headers, payload: { db: company('Acme Robotics', 'acme') } })
    expect(up.statusCode, up.body).toBe(200)
    const status = (await app.inject({ method: 'GET', url: '/api/workspace/status', headers })).json()
    expect(status).toEqual({ empty: false, workspaceId: body.workspace.id, historyId: up.json().historyId, seq: up.json().seq })
    // Signing in again later works the usual way, and names the login's company, as the session check does.
    const again = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { email: 'founder@acme.test', password: ADMIN.password } })
    expect(again.statusCode).toBe(200)
    expect(again.json()).toEqual({ user: body.user, workspace: body.workspace })
    expect((await app.inject({ method: 'GET', url: '/api/auth/session', headers })).json()).toEqual({ user: body.user, workspace: body.workspace })
  })

  it('names the careers page in /api/auth/me when the server serves careers pages', async () => {
    const app = await open({ careersHosts: ['careers.example.com'], careersOrigin: 'https://careers.example.com' })
    const acme = await signUp(app, 'founder@acme.test', 'Acme Robotics')
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: acme.cookie } })
    expect(me.json()).toMatchObject({ careersUrl: `https://careers.example.com/${acme.workspace.slug}/`, careersEnabled: true })
    // The owner's workspace has its slug too, and its careers page stays off until an admin turns it on.
    const ownerCookie = await login(app)
    const owner = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: ownerCookie } })
    expect(owner.json()).toMatchObject({ workspace: { id: WORKSPACE_ID, slug: 'default-workspace' }, careersUrl: 'https://careers.example.com/default-workspace/', careersEnabled: false })
  })

  it('lets an admin turn the careers page on and off, for its own company only', async () => {
    const app = await open({ careersHosts: ['careers.example.com'], careersOrigin: 'https://careers.example.com' })
    const acme = await signUp(app, 'founder@acme.test', 'Acme Robotics')
    const bravo = await signUp(app, 'b@bravo.test', 'Bravo Co')
    const ownerCookie = await login(app)
    const turn = (cookie: string, enabled: unknown, extra: Record<string, unknown> = {}) =>
      app.inject({ method: 'PUT', url: '/api/workspace/careers', headers: { ...CSRF, cookie }, payload: { enabled, ...extra } })
    const on = await turn(ownerCookie, true, { workspaceId: acme.workspace.id })
    expect(on.statusCode).toBe(200)
    expect(on.json()).toEqual({ careersUrl: 'https://careers.example.com/default-workspace/', careersEnabled: true })
    const off = await turn(acme.cookie, false, { workspaceId: bravo.workspace.id })
    expect(off.json()).toEqual({ careersUrl: `https://careers.example.com/${acme.workspace.slug}/`, careersEnabled: false })
    const rows = await db.query<{ id: string; careers: boolean }>('SELECT id, careers FROM workspaces ORDER BY id')
    expect(Object.fromEntries(rows.rows.map((r) => [r.id, r.careers]))).toEqual({ [WORKSPACE_ID]: true, [acme.workspace.id]: false, [bravo.workspace.id]: true })
    // Not for a login that is not an admin, never without a session or the CSRF header, never with a bad body.
    await db.query(`UPDATE users SET role = 'manager' WHERE id = $1`, [bravo.userId])
    expect((await turn(bravo.cookie, false)).statusCode).toBe(403)
    expect((await app.inject({ method: 'PUT', url: '/api/workspace/careers', headers: CSRF, payload: { enabled: true } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'PUT', url: '/api/workspace/careers', headers: { cookie: acme.cookie }, payload: { enabled: true } })).statusCode).toBe(403)
    expect((await turn(acme.cookie, 'yes')).statusCode).toBe(400)
    expect((await db.query<{ careers: boolean }>('SELECT careers FROM workspaces WHERE id = $1', [bravo.workspace.id])).rows[0].careers).toBe(true)
  })

  it('refuses bad fields with 400 and a plain reason, creating nothing', async () => {
    const app = await open()
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [signupBody({ email: 'not-an-email' }), /valid email/],
      [signupBody({ email: `${'a'.repeat(250)}@example.com` }), /valid email/],
      [signupBody({ password: 'short' }), /at least 12/],
      [signupBody({ password: 'x'.repeat(1025) }), /at most 1024/],
      [signupBody({ companyName: 'A' }), /2 to 80/],
      [signupBody({ companyName: 'x'.repeat(81) }), /2 to 80/],
      [signupBody({ companyName: 'Bad\u0000Co' }), /2 to 80/],
      [signupBody({ companyName: 42 }), /2 to 80/],
      [signupBody({ remember: 'yes' }), /remember/],
      [signupBody({ website: 'https://spam.example' }), /website/],
      [{ email: 'a@b.c' }, /email and a password/],
    ]
    for (const [payload, detail] of cases) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/signup', headers: CSRF, payload })
      expect(res.statusCode, JSON.stringify(payload).slice(0, 80)).toBe(400)
      expect(res.json().detail, JSON.stringify(payload).slice(0, 80)).toMatch(detail)
      expect(res.headers['set-cookie']).toBeUndefined()
    }
    // An empty honeypot is what the app sends.
    expect((await app.inject({ method: 'POST', url: '/api/auth/signup', headers: CSRF, payload: signupBody({ website: '' }) })).statusCode).toBe(201)
    expect((await db.query('SELECT 1 FROM workspaces WHERE NOT keep')).rows).toHaveLength(1)
  })

  it('answers 409 email_taken for an email with a login anywhere, after the same password work as a success', async () => {
    let runs = 0
    const gate = new (class extends ConcurrencyGate {
      override run<T>(task: () => Promise<T>) {
        runs++
        return super.run(task)
      }
    })()
    const app = await open({}, { passwordGate: gate })
    await signUp(app, 'founder@acme.test', 'Acme')
    for (const email of ['founder@acme.test', ` ${ADMIN.email.toUpperCase()} `]) {
      const before = runs
      const res = await app.inject({ method: 'POST', url: '/api/auth/signup', headers: CSRF, payload: signupBody({ email, companyName: 'Copycat' }), remoteAddress: '10.1.1.1' })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ error: 'email_taken', detail: expect.any(String) })
      expect(res.headers['set-cookie']).toBeUndefined()
      expect(runs - before).toBe(1) // the password was hashed all the same
    }
    expect((await db.query(`SELECT 1 FROM workspaces WHERE name = 'Copycat'`)).rows).toEqual([])
  })

  it('answers 503 demo_full once the server holds DEMO_MAX_WORKSPACES demo companies', async () => {
    const app = await open({ demoMaxWorkspaces: 2 })
    await signUp(app, 'one@example.com', 'One')
    await signUp(app, 'two@example.com', 'Two')
    const res = await app.inject({ method: 'POST', url: '/api/auth/signup', headers: CSRF, payload: signupBody({ email: 'three@example.com' }) })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ error: 'demo_full', detail: expect.any(String) })
  })

  it('allows 5 accounts per address per hour, and 60 from all addresses together', async () => {
    const app = await open()
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/signup', headers: CSRF, payload: signupBody({ email: `u${i}@example.com` }), remoteAddress: '203.0.113.5' })
      expect(res.statusCode, String(i)).toBe(201)
    }
    const sixth = await app.inject({ method: 'POST', url: '/api/auth/signup', headers: CSRF, payload: signupBody({ email: 'u6@example.com' }), remoteAddress: '203.0.113.5' })
    expect(sixth.statusCode).toBe(429)
    expect(sixth.json()).toEqual({ error: 'rate_limited', retryAfter: expect.any(Number) })
    expect(sixth.json().retryAfter).toBeGreaterThan(3000)
    expect(Number(sixth.headers['retry-after'])).toBe(sixth.json().retryAfter)
    // IPv6 counts per /64.
    const v6 = await open({}, { accountLimiter: new AddressRateLimiter({ windowMs: 3_600_000, perAddress: 1, global: 60, maxKeys: 100 }) })
    expect((await v6.inject({ method: 'POST', url: '/api/auth/signup', headers: CSRF, payload: signupBody({ email: 'v6a@example.com' }), remoteAddress: '2001:db8::1' })).statusCode).toBe(201)
    const sameNet = await v6.inject({ method: 'POST', url: '/api/auth/signup', headers: CSRF, payload: signupBody({ email: 'v6b@example.com' }), remoteAddress: '2001:db8::2' })
    expect(sameNet.statusCode).toBe(429)

    // The server-wide limit cannot be spread over addresses.
    const small = await open({}, { accountLimiter: new AddressRateLimiter({ windowMs: 3_600_000, perAddress: 5, global: 3, maxKeys: 100 }) })
    for (let i = 0; i < 3; i++) await signUp(small, `g${i}@example.com`, `G${i}`, `198.51.100.${i + 1}`)
    const over = await small.inject({ method: 'POST', url: '/api/auth/signup', headers: CSRF, payload: signupBody({ email: 'g9@example.com' }), remoteAddress: '198.51.100.99' })
    expect(over.statusCode).toBe(429)
  })

  it('counts only sign-ups that created a company toward the server-wide limit, and every try toward its address', async () => {
    const limiter = new AddressRateLimiter({ windowMs: 3_600_000, perAddress: 5, global: 3, maxKeys: 100 })
    const app = await open({}, { accountLimiter: limiter })
    // Tries that create nothing (emails that have a login), from many addresses: none stays server-wide.
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/signup', headers: CSRF, payload: signupBody({ email: ADMIN.email }), remoteAddress: `203.0.113.${100 + i}` })
      expect(res.statusCode, String(i)).toBe(409)
    }
    expect(limiter.count('all')).toBe(0)
    // So real sign-ups still get all three places.
    for (let i = 0; i < 3; i++) await signUp(app, `real${i}@example.com`, `Real ${i}`, `198.51.100.${i + 1}`)
    expect(limiter.count('all')).toBe(3)
    // An address still pays for every try, so it cannot test email after email.
    const probe = await open({}, { accountLimiter: new AddressRateLimiter({ windowMs: 3_600_000, perAddress: 5, global: 60, maxKeys: 100 }) })
    for (let i = 0; i < 5; i++) expect((await probe.inject({ method: 'POST', url: '/api/auth/signup', headers: CSRF, payload: signupBody({ email: ADMIN.email }), remoteAddress: '10.6.6.6' })).statusCode).toBe(409)
    expect((await probe.inject({ method: 'POST', url: '/api/auth/signup', headers: CSRF, payload: signupBody({ email: 'new@example.com' }), remoteAddress: '10.6.6.6' })).statusCode).toBe(429)
  })

  it('refuses sign-ups while too many password checks wait, without counting them', async () => {
    const limiter = new AddressRateLimiter({ windowMs: 3_600_000, perAddress: 5, global: 60, maxKeys: 100 })
    const app = await open({}, { passwordGate: new ConcurrencyGate(1, 0), accountLimiter: limiter })
    const results = await Promise.all(
      [1, 2, 3].map((i) => app.inject({ method: 'POST', url: '/api/auth/signup', headers: CSRF, payload: signupBody({ email: `b${i}@example.com` }), remoteAddress: '10.4.4.4' })),
    )
    const busy = results.filter((r) => r.statusCode === 429)
    expect(busy.length).toBeGreaterThan(0)
    expect(busy[0].json()).toEqual({ error: 'busy', retryAfter: 5 })
    expect(limiter.count('ip:10.4.4.4')).toBe(3 - busy.length)
  })

  it('keeps the CSRF guard, JSON only, and a small body', async () => {
    const app = await open()
    expect((await app.inject({ method: 'POST', url: '/api/auth/signup', payload: signupBody() })).statusCode).toBe(403)
    const sibling = await app.inject({ method: 'POST', url: '/api/auth/signup', headers: { ...CSRF, 'sec-fetch-site': 'same-site' }, payload: signupBody() })
    expect(sibling.statusCode).toBe(403)
    const form = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      headers: { ...CSRF, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=a%40b.co&password=xxxxxxxxxxxx&companyName=Acme',
    })
    expect(form.statusCode).toBe(415)
    const big = await app.inject({ method: 'POST', url: '/api/auth/signup', headers: CSRF, payload: signupBody({ companyName: 'x'.repeat(9000) }) })
    expect(big.statusCode).toBe(413)
    expect((await db.query('SELECT 1 FROM workspaces WHERE NOT keep')).rows).toEqual([])
  })
})

describe('invites', () => {
  it('lets an admin make a link that joins its company, once; the joiner sees the same workspace', async () => {
    const app = await open({ publicOrigin: 'https://hr.example.com' })
    const acme = await signUp(app, 'founder@acme.test', 'Acme Robotics')
    const headers = { ...CSRF, cookie: acme.cookie }
    await app.inject({ method: 'PUT', url: '/api/workspace', headers, payload: { db: company('Acme Robotics', 'acme') } })

    const res = await app.inject({ method: 'POST', url: '/api/invites', headers })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json()).toEqual({ url: expect.stringMatching(/^https:\/\/hr\.example\.com\/#invite\.[A-Za-z0-9_-]{43}$/), expiresAt: expect.any(String) })
    expect(res.headers['cache-control']).toBe('no-store')
    const token = String(res.json().url).split('#invite.')[1]
    expect((await db.query<{ workspace_id: string }>('SELECT workspace_id FROM invites WHERE token_hash = $1', [hashToken(token)])).rows).toEqual([
      { workspace_id: acme.workspace.id },
    ])

    // The app looks the token up in a body, where no proxy or access log keeps it; the path form still answers.
    const info = await app.inject({ method: 'POST', url: '/api/invites/lookup', headers: CSRF, payload: { token } })
    expect(info.statusCode).toBe(200)
    expect(info.json()).toEqual({ companyName: 'Acme Robotics' })
    expect((await app.inject({ method: 'GET', url: `/api/invites/${token}` })).json()).toEqual({ companyName: 'Acme Robotics' })

    const joined = await app.inject({ method: 'POST', url: '/api/auth/accept-invite', headers: CSRF, payload: { token, email: 'Teammate@Acme.test', password: ADMIN.password } })
    expect(joined.statusCode, joined.body).toBe(201)
    expect(joined.json()).toEqual({ user: { id: expect.any(String), email: 'teammate@acme.test', role: 'admin' }, workspace: acme.workspace })
    const mate = { cookie: `ft_session=${sessionCookie(joined)}` }
    const theirs = await app.inject({ method: 'GET', url: '/api/workspace', headers: mate })
    expect(theirs.json().workspaceId).toBe(acme.workspace.id)
    expect(theirs.json().db.jobs.map((j: { id: string }) => j.id)).toEqual(['j-acme'])

    // Used up.
    expect((await app.inject({ method: 'GET', url: `/api/invites/${token}` })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/invites/lookup', headers: CSRF, payload: { token } })).statusCode).toBe(404)
    const twice = await app.inject({ method: 'POST', url: '/api/auth/accept-invite', headers: CSRF, payload: { token, email: 'third@acme.test', password: ADMIN.password } })
    expect(twice.statusCode).toBe(404)
    expect(twice.json()).toEqual({ error: 'invalid_invite', detail: expect.any(String) })
  })

  it('works on a closed server too, for the owner adding a teammate', async () => {
    const app = await open({ signupMode: 'closed' })
    const res = await app.inject({ method: 'POST', url: '/api/invites', headers: { ...CSRF, cookie: await login(app) } })
    expect(res.statusCode).toBe(201)
    // No PUBLIC_ORIGIN (development): the link uses the address the request came to.
    expect(res.json().url).toMatch(/^http:\/\/localhost(:\d+)?\/#invite\./)
    const token = String(res.json().url).split('#invite.')[1]
    const joined = await app.inject({ method: 'POST', url: '/api/auth/accept-invite', headers: CSRF, payload: { token, email: 'mate@example.com', password: ADMIN.password } })
    expect(joined.json().workspace).toMatchObject({ id: WORKSPACE_ID })
  })

  it('needs a signed-in admin to make one', async () => {
    const app = await open()
    expect((await app.inject({ method: 'POST', url: '/api/invites', headers: CSRF })).statusCode).toBe(401)
    const acme = await signUp(app, 'founder@acme.test', 'Acme')
    await db.query(`UPDATE users SET role = 'manager' WHERE id = $1`, [acme.userId])
    const res = await app.inject({ method: 'POST', url: '/api/invites', headers: { ...CSRF, cookie: acme.cookie } })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'forbidden', detail: expect.any(String) })
    expect((await app.inject({ method: 'POST', url: '/api/invites', headers: { cookie: acme.cookie } })).statusCode).toBe(403) // CSRF header
  })

  it('answers 429 too_many_invites past 20 open links', async () => {
    const app = await open()
    const acme = await signUp(app, 'founder@acme.test', 'Acme')
    for (let i = 0; i < 20; i++) expect((await app.inject({ method: 'POST', url: '/api/invites', headers: { ...CSRF, cookie: acme.cookie } })).statusCode).toBe(201)
    const res = await app.inject({ method: 'POST', url: '/api/invites', headers: { ...CSRF, cookie: acme.cookie } })
    expect(res.statusCode).toBe(429)
    expect(res.json()).toEqual({ error: 'too_many_invites', retryAfter: expect.any(Number), detail: expect.stringMatching(/20 invite links open/) })
    expect(res.headers['retry-after']).toBe(String(res.json().retryAfter))
  })

  it('checks the token before the email: a bad token is 404 even for a taken email; a taken email keeps the invite', async () => {
    const app = await open()
    const acme = await signUp(app, 'founder@acme.test', 'Acme')
    const token = String((await app.inject({ method: 'POST', url: '/api/invites', headers: { ...CSRF, cookie: acme.cookie } })).json().url).split('#invite.')[1]
    const accept = (t: unknown, email: string, remoteAddress: string) =>
      app.inject({ method: 'POST', url: '/api/auth/accept-invite', headers: CSRF, payload: { token: t, email, password: ADMIN.password }, remoteAddress })
    expect((await accept('B'.repeat(43), ADMIN.email, '10.2.0.1')).statusCode).toBe(404)
    expect((await accept('nope', ADMIN.email, '10.2.0.2')).statusCode).toBe(404)
    const taken = await accept(token, ADMIN.email, '10.2.0.3')
    expect(taken.statusCode).toBe(409)
    expect(taken.json().error).toBe('email_taken')
    expect((await app.inject({ method: 'GET', url: `/api/invites/${token}` })).statusCode).toBe(200)
    // Validation and the CSRF guard as for sign-up.
    expect((await app.inject({ method: 'POST', url: '/api/auth/accept-invite', headers: CSRF, payload: { token, email: 'x@y.z', password: 'short' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/auth/accept-invite', headers: CSRF, payload: { email: 'x@y.z', password: ADMIN.password } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/auth/accept-invite', payload: { token, email: 'x@y.z', password: ADMIN.password } })).statusCode).toBe(403)
  })

  it('lists open links for an admin, without tokens, and revokes them for good', async () => {
    const app = await open()
    const acme = await signUp(app, 'founder@acme.test', 'Acme')
    const headers = { ...CSRF, cookie: acme.cookie }
    const made: Array<{ url: string; expiresAt: string }> = []
    for (let i = 0; i < 2; i++) made.push((await app.inject({ method: 'POST', url: '/api/invites', headers })).json())
    const listed = await app.inject({ method: 'GET', url: '/api/invites', headers })
    expect(listed.statusCode).toBe(200)
    expect(listed.headers['cache-control']).toBe('no-store')
    const invites = listed.json().invites as Array<{ id: string; expiresAt: string; createdBy: string }>
    expect(invites.map((i) => [i.expiresAt, i.createdBy])).toEqual(made.map((m) => [m.expiresAt, 'founder@acme.test']))
    for (const m of made) expect(listed.body).not.toContain(m.url.split('#invite.')[1])
    const revoked = await app.inject({ method: 'DELETE', url: `/api/invites/${invites[0].id}`, headers })
    expect(revoked.statusCode).toBe(204)
    const token = made[0].url.split('#invite.')[1]
    expect((await app.inject({ method: 'POST', url: '/api/invites/lookup', headers: CSRF, payload: { token } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/auth/accept-invite', headers: CSRF, payload: { token, email: 'late@acme.test', password: ADMIN.password } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: `/api/invites/${invites[0].id}`, headers })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/invites', headers })).json().invites.map((i: { id: string }) => i.id)).toEqual([invites[1].id])
    // A revoked place frees up for a new link (the open-link cap counts only open ones).
    expect((await app.inject({ method: 'POST', url: '/api/invites', headers })).statusCode).toBe(201)
    // Admins only, with a session and the CSRF header.
    expect((await app.inject({ method: 'GET', url: '/api/invites' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'DELETE', url: `/api/invites/${invites[1].id}`, headers: { cookie: acme.cookie } })).statusCode).toBe(403)
    await db.query(`UPDATE users SET role = 'manager' WHERE id = $1`, [acme.userId])
    expect((await app.inject({ method: 'GET', url: '/api/invites', headers })).statusCode).toBe(403)
    expect((await app.inject({ method: 'DELETE', url: `/api/invites/${invites[1].id}`, headers })).statusCode).toBe(403)
  })

  it('refuses a token that does not work before any password work or account limit, so junk cannot keep teammates out', async () => {
    let runs = 0
    const gate = new (class extends ConcurrencyGate {
      override run<T>(task: () => Promise<T>) {
        runs++
        return super.run(task)
      }
    })()
    const app = await open({ signupMode: 'closed' }, { passwordGate: gate })
    // Twelve addresses, five tries each, none with a working token (one not even token-shaped).
    for (let i = 0; i < 60; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/accept-invite',
        headers: CSRF,
        payload: { token: i % 2 ? 'x' : `${String(i).padStart(2, '0')}${'D'.repeat(41)}`, email: `junk${i}@example.com`, password: ADMIN.password },
        remoteAddress: `198.51.100.${10 + (i % 12)}`,
      })
      expect(res.statusCode, String(i)).toBe(404)
    }
    expect(runs).toBe(0)
    // The owner's real teammate, from a fresh address, joins.
    const token = String((await app.inject({ method: 'POST', url: '/api/invites', headers: { ...CSRF, cookie: await login(app) } })).json().url).split('#invite.')[1]
    const before = runs
    const joined = await app.inject({ method: 'POST', url: '/api/auth/accept-invite', headers: CSRF, payload: { token, email: 'mate@example.com', password: ADMIN.password }, remoteAddress: '203.0.113.77' })
    expect(joined.statusCode, joined.body).toBe(201)
    expect(runs - before).toBe(1)
    // Sign-ups never compete with invites for places: a full sign-up budget leaves joining alone.
    const shared = await open({}, { accountLimiter: new AddressRateLimiter({ windowMs: 3_600_000, perAddress: 5, global: 1, maxKeys: 100 }) })
    await signUp(shared, 'first@example.com', 'First')
    expect((await shared.inject({ method: 'POST', url: '/api/auth/signup', headers: CSRF, payload: signupBody({ email: 'second@example.com' }), remoteAddress: '10.7.0.1' })).statusCode).toBe(429)
    const another = String((await shared.inject({ method: 'POST', url: '/api/invites', headers: { ...CSRF, cookie: await login(shared) } })).json().url).split('#invite.')[1]
    expect((await shared.inject({ method: 'POST', url: '/api/auth/accept-invite', headers: CSRF, payload: { token: another, email: 'mate2@example.com', password: ADMIN.password }, remoteAddress: '10.7.0.2' })).statusCode).toBe(201)
  })

  it('limits invite lookups per address, and keeps tokens out of the request log', async () => {
    const app = await open({}, { inviteLookupLimiter: new AddressRateLimiter({ windowMs: 60_000, perAddress: 3, global: Number.POSITIVE_INFINITY, maxKeys: 100 }) })
    for (let i = 0; i < 3; i++) expect((await app.inject({ method: 'GET', url: `/api/invites/${'C'.repeat(43)}`, remoteAddress: '10.3.0.1' })).statusCode).toBe(404)
    const limited = await app.inject({ method: 'GET', url: `/api/invites/${'C'.repeat(43)}`, remoteAddress: '10.3.0.1' })
    expect(limited.statusCode).toBe(429)
    expect((await app.inject({ method: 'GET', url: `/api/invites/${'C'.repeat(43)}`, remoteAddress: '10.3.0.2' })).statusCode).toBe(404)
    // The body lookup and the token check before joining share the limit.
    expect((await app.inject({ method: 'POST', url: '/api/invites/lookup', headers: CSRF, payload: { token: 'C'.repeat(43) }, remoteAddress: '10.3.0.1' })).statusCode).toBe(429)
    const join = await app.inject({ method: 'POST', url: '/api/auth/accept-invite', headers: CSRF, payload: { token: 'C'.repeat(43), email: 'x@example.com', password: ADMIN.password }, remoteAddress: '10.3.0.1' })
    expect(join.statusCode).toBe(429)
    expect(redactPath(`/api/invites/${'C'.repeat(43)}`)).toBe('/api/invites/[redacted]')
    expect(redactPath(`/%61pi/invites/${'C'.repeat(43)}?x=1`)).toBe('/%61pi/invites/[redacted]?x=1')
    expect(redactPath('/api/invites')).toBe('/api/invites')
    expect(redactPath('/api/workspace')).toBe('/api/workspace')
    // The server's request log uses it: Fastify's own request fields, the token cut out.
    const options = loggerOptions(testConfig({ logLevel: 'info' })) as { serializers: { req: (r: unknown) => Record<string, unknown> } }
    expect(options.serializers.req({ method: 'GET', url: `/api/invites/${'C'.repeat(43)}`, host: 'hr.example.com', ip: '10.0.0.1', socket: { remotePort: 5000 } })).toEqual({
      method: 'GET',
      url: '/api/invites/[redacted]',
      host: 'hr.example.com',
      remoteAddress: '10.0.0.1',
      remotePort: 5000,
    })
  })
})

// ---------------------------------------------------------------------------------------------
// Demo write limits: how fast a demo company writes, and what the demo companies hold together
// ---------------------------------------------------------------------------------------------

describe('demo write limits', () => {
  const push = (app: FastifyInstance, cookie: string, id: string) =>
    app.inject({ method: 'POST', url: '/api/changes', headers: { ...CSRF, cookie }, payload: { changes: [{ collection: 'jobs', id, op: 'upsert', data: { id, title: id }, baseVersion: null }] } })

  it("hold a demo company's writes to a pace, with retryAfter, and never the owner's", async () => {
    const app = await open({}, { writeBudget: new WriteBudget({ requestsPerMinute: 3 }) })
    const acme = await signUp(app, 'founder@acme.test', 'Acme')
    const headers = { ...CSRF, cookie: acme.cookie }
    expect((await app.inject({ method: 'PUT', url: '/api/workspace', headers, payload: { db: company('Acme', 'acme') } })).statusCode).toBe(200)
    expect((await push(app, acme.cookie, 'j-1')).statusCode).toBe(200)
    expect((await push(app, acme.cookie, 'j-2')).statusCode).toBe(200)
    const limited = await push(app, acme.cookie, 'j-3')
    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toEqual({ error: 'write_limit', detail: expect.any(String), retryAfter: expect.any(Number) })
    expect(Number(limited.headers['retry-after'])).toBe(limited.json().retryAfter)
    expect((await snapshot(db, acme.workspace.id))!.db.jobs).toHaveLength(3) // the upload's job, j-1 and j-2
    // Another demo company has its own pace; the owner has none.
    const bravo = await signUp(app, 'b@bravo.test', 'Bravo')
    expect((await app.inject({ method: 'PUT', url: '/api/workspace', headers: { ...CSRF, cookie: bravo.cookie }, payload: { db: company('Bravo', 'bravo') } })).statusCode).toBe(200)
    const owner = await login(app)
    expect((await app.inject({ method: 'PUT', url: '/api/workspace', headers: { ...CSRF, cookie: owner }, payload: { db: company('Owner', 'owner') } })).statusCode).toBe(200)
    for (let i = 0; i < 6; i++) expect((await push(app, owner, `j-o${i}`)).statusCode, String(i)).toBe(200)
  })

  it('hold a demo company to bytes an hour', async () => {
    const app = await open({}, { writeBudget: new WriteBudget({ bytesPerHour: 30_000 }) })
    const acme = await signUp(app, 'founder@acme.test', 'Acme')
    const headers = { ...CSRF, cookie: acme.cookie }
    // The first write goes through whatever its size (the body limit caps it); the next waits.
    expect((await app.inject({ method: 'PUT', url: '/api/workspace', headers, payload: { db: company('Acme', 'acme') } })).statusCode).toBe(200)
    expect((await push(app, acme.cookie, 'j-1')).json().error).toBe('write_limit')
  })

  it('hold the demo companies together to DEMO_MAX_TOTAL_MB', async () => {
    const app = await open({ demoMaxTotalBytes: 150_000 })
    const acme = await signUp(app, 'founder@acme.test', 'Acme')
    const bravo = await signUp(app, 'b@bravo.test', 'Bravo')
    expect((await app.inject({ method: 'PUT', url: '/api/workspace', headers: { ...CSRF, cookie: acme.cookie }, payload: { db: company('Acme', 'acme') } })).statusCode).toBe(200)
    const full = await app.inject({ method: 'PUT', url: '/api/workspace', headers: { ...CSRF, cookie: bravo.cookie }, payload: { db: company('Bravo', 'bravo') } })
    expect(full.statusCode).toBe(413)
    expect(full.json().error).toBe('workspace_full')
    // The owner's workspace is not one of them.
    expect((await app.inject({ method: 'PUT', url: '/api/workspace', headers: { ...CSRF, cookie: await login(app) }, payload: { db: company('Owner', 'owner') } })).statusCode).toBe(200)
  })

  it('answer each upload with the workspace it went to, so the browser knows which company it syncs with', async () => {
    const app = await open()
    const acme = await signUp(app, 'founder@acme.test', 'Acme')
    const up = await app.inject({ method: 'PUT', url: '/api/workspace', headers: { ...CSRF, cookie: acme.cookie }, payload: { db: company('Acme', 'acme') } })
    expect(up.json()).toMatchObject({ workspaceId: acme.workspace.id, historyId: expect.any(String), seq: expect.any(Number) })
  })
})

// ---------------------------------------------------------------------------------------------
// Tenant isolation: a session from one company never reads or writes another, through any route
// ---------------------------------------------------------------------------------------------

/**
 * Every [method, path] the server registers, from Fastify's route tree. HEAD routes are the automatic
 * twins of GET routes and are checked separately.
 */
function registeredRoutes(app: FastifyInstance): string[] {
  const out: string[] = []
  const stack: string[] = []
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const m = /^((?:[│ ] {3})*)(?:├── |└── )(\S+)(?: \(([^)]+)\))?$/.exec(line)
    if (!m) continue
    const depth = m[1].length / 4
    stack.length = depth
    const full = (stack[depth - 1] ?? '') + m[2]
    stack[depth] = full
    for (const method of m[3]?.split(', ') ?? []) out.push(`${method} ${full}`)
  }
  return out.sort()
}

/** Every route buildApp registers (HEAD twins aside): what a production server answers. */
const ROUTES = [
  'DELETE /api/invites/:token|:id',
  'GET /api/assistant',
  'GET /api/auth/me',
  'GET /api/auth/session',
  'GET /api/auth/signup-mode',
  'GET /api/changes',
  'GET /api/health',
  'GET /api/invites',
  'GET /api/invites/:token|:id',
  'GET /api/workspace',
  'GET /api/workspace/status',
  'POST /api/assistant/chat',
  'POST /api/auth/accept-invite',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'POST /api/auth/signup',
  'POST /api/changes',
  'POST /api/invites',
  'POST /api/invites/lookup',
  'PUT /api/workspace',
  'PUT /api/workspace/careers',
]

/**
 * DEV-ONLY routes: registered by the development entry (server/src/dev/index.ts, which only npm run stack
 * starts), never by buildApp. POST /__dev/sql reads any company's data for npm run sql, and GET and POST
 * /__dev/workspace read and replace the stack's own company for npm run sim, so they answer only on a
 * loopback socket with the stack's secret, never with a session (server/src/dev/routes.test.ts,
 * server/src/dev/workspace.test.ts). The workspace routes refuse every company but the stack's own.
 */
const DEV_ONLY_ROUTES = ['GET /__dev/workspace', 'POST /__dev/sql', 'POST /__dev/workspace']

describe('tenant isolation', () => {
  let app: FastifyInstance
  let a: SignedUp
  let b: SignedUp
  let ownerCookie: string
  let bToken: string
  /** Each company's upload: the seq and history a pull from right after it would send. */
  let uploads: Record<string, { seq: number; historyId: string }>
  /** Every row that belongs to B and to the owner's workspace, to compare before and after. */
  const stateOf = async (workspaceId: string) => ({
    snapshot: await snapshot(db, workspaceId),
    log: (await db.query('SELECT seq, collection, record_id, op, version, data FROM change_log WHERE workspace_id = $1 ORDER BY seq', [workspaceId])).rows,
    invites: (await db.query('SELECT token_hash, id, used_at, refused FROM invites WHERE workspace_id = $1 ORDER BY token_hash', [workspaceId])).rows,
    users: (await db.query('SELECT id, email, role, password_hash FROM users WHERE workspace_id = $1 ORDER BY email', [workspaceId])).rows,
    sessions: (await db.query('SELECT s.token_hash FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.workspace_id = $1 ORDER BY 1', [workspaceId])).rows,
    workspace: (await db.query('SELECT id, name, slug, keep, careers, bytes_used, history_id, last_seq, reset_seq, initialized_at FROM workspaces WHERE id = $1', [workspaceId])).rows,
  })

  beforeEach(async () => {
    app = await open({ careersHosts: ['careers.example.com'], careersOrigin: 'https://careers.example.com' })
    a = await signUp(app, 'a@a.test', 'Alpha Co')
    b = await signUp(app, 'b@b.test', 'Bravo Co')
    ownerCookie = await login(app)
    uploads = {}
    for (const [cookie, name, marker] of [
      [a.cookie, 'Alpha Co', 'alpha'],
      [b.cookie, 'Bravo Co', 'bravo'],
      [ownerCookie, 'Zulu Co', 'zulu'],
    ]) {
      const up = await app.inject({ method: 'PUT', url: '/api/workspace', headers: { ...CSRF, cookie }, payload: { db: company(name, marker) } })
      expect(up.statusCode, up.body).toBe(200)
      uploads[marker] = { seq: up.json().seq, historyId: up.json().historyId }
    }
    // B and the owner keep working after A's upload, so their seqs interleave with A's.
    await applyChanges(db, parseChanges({ changes: [{ collection: 'jobs', id: 'j-bravo-2', op: 'upsert', data: { id: 'j-bravo-2', title: 'Secret bravo two' }, baseVersion: null }] }), b.userId, { workspaceId: b.workspace.id })
    bToken = String((await app.inject({ method: 'POST', url: '/api/invites', headers: { ...CSRF, cookie: b.cookie } })).json().url).split('#invite.')[1]
  })

  it('covers every route the server registers (a new route must be added to the checks below)', () => {
    const routes = registeredRoutes(app)
    const gets = routes.filter((r) => r.startsWith('GET ')).map((r) => r.slice(4))
    expect(routes.filter((r) => r.startsWith('HEAD ')).map((r) => r.slice(5))).toEqual(gets)
    // Fastify prints one node for the parameter in /api/invites/:token (GET) and /api/invites/:id (DELETE).
    expect(routes.filter((r) => !r.startsWith('HEAD '))).toEqual([...ROUTES].sort())
    for (const devOnly of DEV_ONLY_ROUTES) expect(routes).not.toContain(devOnly)
  })

  it('adds only the DEV-ONLY routes on the development entry, and none of them answers a session', async () => {
    const dev = await buildApp({ db, config: testConfig({ signupMode: 'open', devTools: true }), logger: false })
    apps.push(dev)
    await registerDevRoutes(dev, { db, secret: 'test-only-dev-tools-secret-0123456789abcdef' })
    await dev.ready()
    expect(registeredRoutes(dev).filter((r) => !r.startsWith('HEAD '))).toEqual([...ROUTES, ...DEV_ONLY_ROUTES].sort())
    for (const route of DEV_ONLY_ROUTES) {
      const [method, url] = route.split(' ') as ['GET' | 'POST', string]
      const payload = method === 'POST' ? { sql: 'SELECT id FROM workspaces', db: company('Alpha Co', 'alpha') } : undefined
      const res = await dev.inject({ method, url, headers: { ...CSRF, cookie: a.cookie }, payload, remoteAddress: '127.0.0.1' })
      expect(res.statusCode, route).toBe(404)
    }
    // Even with the secret, the workspace routes never read or replace another company.
    const secret = { authorization: 'Bearer test-only-dev-tools-secret-0123456789abcdef' }
    const before = await stateOf(b.workspace.id)
    for (const res of [
      await dev.inject({ method: 'GET', url: `/__dev/workspace?workspaceId=${b.workspace.id}`, headers: secret, remoteAddress: '127.0.0.1' }),
      await dev.inject({ method: 'POST', url: '/__dev/workspace', headers: secret, payload: { workspaceId: b.workspace.id, db: company('Alpha Co', 'alpha') }, remoteAddress: '127.0.0.1' }),
    ]) {
      expect(res.statusCode).toBe(403)
      expect(res.body).not.toMatch(/bravo/i)
    }
    expect(await stateOf(b.workspace.id)).toEqual(before)
  })

  it("never lets A read another company's data, whatever the request names", async () => {
    const h = { cookie: a.cookie }
    const foreign = /bravo|zulu/i
    const bSnap = await snapshot(db, b.workspace.id)
    const ownerSnap = await snapshot(db, WORKSPACE_ID)
    const asA = async (url: string, extra: Record<string, string> = {}) => {
      const res = await app.inject({ method: 'GET', url, headers: { ...h, ...extra } })
      expect(res.body, url).not.toMatch(foreign)
      return res
    }
    // The workspace and its status: A's, even when a request names B (query, header).
    for (const url of ['/api/workspace', `/api/workspace?workspaceId=${b.workspace.id}`, `/api/workspace?workspace_id=${WORKSPACE_ID}`]) {
      const snap = (await asA(url, { 'x-workspace-id': b.workspace.id })).json()
      expect(snap.workspaceId, url).toBe(a.workspace.id)
      expect(snap.db.jobs.map((j: { id: string }) => j.id)).toEqual(['j-alpha'])
      expect(snap.db.company.name).toBe('Alpha Co')
    }
    for (const url of ['/api/workspace/status', `/api/workspace/status?workspaceId=${b.workspace.id}`]) {
      expect((await asA(url)).json().workspaceId, url).toBe(a.workspace.id)
    }
    // Pulls: only A's changes, though B's seqs are interleaved; B's history id is just another history.
    const mine = (await asA('/api/workspace')).json()
    const pull = (await asA(`/api/changes?since=${mine.seq}`)).json()
    expect(pull).toEqual({ historyId: mine.historyId, seq: mine.seq, changes: [] })
    expect((await asA(`/api/changes?since=0&workspaceId=${b.workspace.id}`)).json()).toEqual({ resync: true })
    // A pull shaped exactly like B's own next pull (B's seq and history, B named every way) gets nothing of B's:
    // B has a change after that seq, and A is told its own history differs. Without the history, B's seq
    // is just a number in A's own numbering (each company counts its own): at most A's own changes.
    for (const name of ['workspaceId', 'workspace_id', 'workspace']) {
      const url = `/api/changes?since=${uploads.bravo.seq}&history=${uploads.bravo.historyId}&${name}=${b.workspace.id}`
      expect((await asA(url, { 'x-workspace-id': b.workspace.id })).json(), url).toEqual({ resync: true })
      const noHistory = `/api/changes?since=${uploads.bravo.seq}&${name}=${b.workspace.id}`
      const r = (await asA(noHistory)).json()
      expect('resync' in r || r.historyId === mine.historyId, noHistory).toBe(true)
    }
    expect((await asA(`/api/changes?since=${bSnap!.seq - 1}&history=${bSnap!.historyId}`)).json()).toEqual({ resync: true })
    expect((await asA(`/api/changes?since=${ownerSnap!.seq - 1}&history=${ownerSnap!.historyId}`)).json()).toEqual({ resync: true })
    // Who A is.
    const me = (await asA('/api/auth/me')).json()
    expect(me).toEqual({
      user: { id: a.userId, email: 'a@a.test', role: 'admin' },
      workspace: a.workspace,
      careersUrl: `https://careers.example.com/${a.workspace.slug}/`,
      careersEnabled: true,
      signupMode: 'open',
    })
    expect((await asA('/api/auth/session')).json()).toEqual({ user: { id: a.userId, email: 'a@a.test', role: 'admin' }, workspace: a.workspace })
    // A's open invite links only (A has none; B has one).
    expect((await asA('/api/invites')).json()).toEqual({ invites: [] })
    // Public routes name no company's data (an invite names its own company to whoever holds its token).
    expect((await asA('/api/health')).json()).toMatchObject({ ok: true })
    expect((await asA('/api/auth/signup-mode')).json()).toEqual({ signupMode: 'open', demoExpireDays: 30 })
    expect((await app.inject({ method: 'GET', url: `/api/invites/${bToken}`, headers: h })).json()).toEqual({ companyName: 'Bravo Co' })
    expect((await app.inject({ method: 'POST', url: '/api/invites/lookup', headers: { ...CSRF, ...h }, payload: { token: bToken } })).json()).toEqual({ companyName: 'Bravo Co' })
    // HEAD twins send no body at all.
    for (const url of ['/api/workspace', '/api/auth/me', '/api/changes?since=0', '/api/workspace/status', '/api/invites']) {
      const head = await app.inject({ method: 'HEAD', url, headers: h })
      expect(head.body, url).toBe('')
    }
  })

  it("never lets A write another company's data, whatever the request names", async () => {
    const bBefore = await stateOf(b.workspace.id)
    const ownerBefore = await stateOf(WORKSPACE_ID)
    const h = { ...CSRF, cookie: a.cookie }
    const bSnap = bBefore.snapshot!
    const ownerSnap = ownerBefore.snapshot!
    const aVersions = (await snapshot(db, a.workspace.id))!.versions

    // Pushes naming B's records, with B's versions and history id, and B's workspace id in the body.
    const bJob = bSnap.db.jobs as Array<{ id: string }>
    const pushes = [
      { changes: [{ collection: 'jobs', id: 'j-bravo', op: 'upsert', data: { id: 'j-bravo', title: 'Hijacked' }, baseVersion: bSnap.versions['jobs:j-bravo'] }] },
      { changes: [{ collection: 'jobs', id: 'j-bravo-2', op: 'delete', baseVersion: bSnap.versions['jobs:j-bravo-2'] }] },
      { changes: [{ collection: 'people', id: 'p-founder', op: 'upsert', data: { ...(bSnap.db.people as object[])[0], lastName: 'Hijacked' }, baseVersion: bSnap.versions['people:p-founder'] }] },
      { changes: [{ collection: '$doc', id: 'company', op: 'upsert', data: { name: 'Hijacked' }, baseVersion: bSnap.versions['$doc:company'] }] },
      { changes: [{ collection: 'jobs', id: 'j-zulu', op: 'delete', baseVersion: ownerSnap.versions['jobs:j-zulu'] }], workspaceId: WORKSPACE_ID },
      { changes: [{ collection: 'jobs', id: bJob[0].id, op: 'delete', baseVersion: bSnap.versions[`jobs:${bJob[0].id}`] }], historyId: bSnap.historyId },
    ]
    for (const payload of pushes) {
      const res = await app.inject({ method: 'POST', url: `/api/changes?workspaceId=${b.workspace.id}`, headers: { ...h, 'x-workspace-id': b.workspace.id }, payload })
      // A's own history: B's history id is refused as another history; anything else lands in A or conflicts with A's copy.
      expect([200, 409], JSON.stringify(payload).slice(0, 80)).toContain(res.statusCode)
      // Conflicts echo the ids A sent; the copies they carry are A's (or none).
      const copies = (res.json().conflicts ?? []).map((c: { serverData: unknown }) => c.serverData)
      expect(JSON.stringify(copies)).not.toMatch(/bravo|zulu|hijacked/i)
    }
    // The upsert of B's p-founder met A's own founder (same id), never B's. Each company counts its own
    // versions, so B's number may well be A's own version of A's founder: then the edit landed in A's copy,
    // which is A's to change.
    const aSnap = (await app.inject({ method: 'GET', url: '/api/workspace', headers: h })).json()
    const sameNumber = aVersions['people:p-founder'] === bSnap.versions['people:p-founder']
    expect(aSnap.db.people.find((p: { id: string }) => p.id === 'p-founder').lastName).toBe(sameNumber ? 'Hijacked' : 'alpha')
    // A full replace replaces A only.
    const replaced = await app.inject({ method: 'PUT', url: '/api/workspace', headers: h, payload: { db: company('Alpha Again', 'alpha2'), confirmReplace: true, workspaceId: b.workspace.id } })
    expect(replaced.statusCode).toBe(200)
    // B's invite can be neither listed nor revoked from A, by its id or anything else; A's switch turns A's careers page alone.
    const bInviteId = (await db.query<{ id: string }>('SELECT id::text AS id FROM invites WHERE workspace_id = $1', [b.workspace.id])).rows[0].id
    for (const url of [`/api/invites/${bInviteId}`, `/api/invites/${bInviteId}?workspaceId=${b.workspace.id}`, `/api/invites/${bToken}`]) {
      expect((await app.inject({ method: 'DELETE', url, headers: { ...h, 'x-workspace-id': b.workspace.id } })).statusCode, url).toBe(404)
    }
    expect((await app.inject({ method: 'GET', url: `/api/invites?workspaceId=${b.workspace.id}`, headers: h })).body).not.toContain(bInviteId)
    expect((await app.inject({ method: 'PUT', url: `/api/workspace/careers?workspaceId=${b.workspace.id}`, headers: h, payload: { enabled: false, workspaceId: b.workspace.id } })).statusCode).toBe(200)
    // An invite A makes joins A; accepting B's invite joins B, as its token says, not A.
    const aInvite = await app.inject({ method: 'POST', url: '/api/invites', headers: h, payload: { workspaceId: b.workspace.id } })
    expect(aInvite.statusCode).toBe(201)
    const aToken = String(aInvite.json().url).split('#invite.')[1]
    expect((await db.query<{ workspace_id: string }>('SELECT workspace_id FROM invites WHERE token_hash = $1', [hashToken(aToken)])).rows[0].workspace_id).toBe(a.workspace.id)
    const joinA = await app.inject({
      method: 'POST',
      url: '/api/auth/accept-invite',
      headers: { ...CSRF, cookie: a.cookie },
      payload: { token: aToken, email: 'joiner@a.test', password: ADMIN.password, workspaceId: b.workspace.id },
    })
    expect(joinA.json().workspace.id).toBe(a.workspace.id)
    // Signing in, signing up and signing out from A's browser touch A's own logins and sessions only.
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...CSRF, cookie: a.cookie }, payload: { email: 'a@a.test', password: ADMIN.password, workspaceId: b.workspace.id } })).json()).toEqual({
      user: { id: a.userId, email: 'a@a.test', role: 'admin' },
      workspace: { id: a.workspace.id, name: 'Alpha Again', slug: a.workspace.slug },
    })
    const other = await app.inject({ method: 'POST', url: '/api/auth/signup', headers: { ...CSRF, cookie: a.cookie }, payload: signupBody({ email: 'c@c.test', companyName: 'Bravo Co', workspaceId: b.workspace.id }), remoteAddress: '10.8.8.8' })
    expect(other.statusCode).toBe(201)
    expect(other.json().workspace.slug).toMatch(/^bravo-co-[a-z2-9]{6}$/)
    expect(other.json().workspace.slug).not.toBe(b.workspace.slug)
    expect(other.json().workspace.id).not.toBe(b.workspace.id)
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: h })).statusCode).toBe(204)

    // B's and the owner's rows are exactly as they were.
    expect(await stateOf(b.workspace.id)).toEqual(bBefore)
    expect(await stateOf(WORKSPACE_ID)).toEqual(ownerBefore)
    // And B can still use its own workspace.
    expect((await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie: b.cookie } })).json().db.company.name).toBe('Bravo Co')
  })

  it("never lets A's assistant read another company, whatever the request names", async () => {
    // The same database with the assistant on (the scripted model, whose find_people really runs).
    const on = await open(
      { careersHosts: ['careers.example.com'], careersOrigin: 'https://careers.example.com', assistant: { ...testConfig().assistant, enabled: true, fake: true } },
      { assistantClient: fakeAssistantClient({ delayMs: 0 }) },
    )
    const bBefore = await stateOf(b.workspace.id)
    const ownerBefore = await stateOf(WORKSPACE_ID)
    const foreign = /bravo|zulu/i
    const named = { 'x-workspace-id': b.workspace.id }
    const info = await on.inject({ method: 'GET', url: `/api/assistant?workspaceId=${b.workspace.id}`, headers: { cookie: a.cookie, ...named } })
    expect(info.json()).toMatchObject({ enabled: true, name: 'Alpha Co Bot' })
    const res = await on.inject({
      method: 'POST',
      url: `/api/assistant/chat?workspaceId=${b.workspace.id}`,
      headers: { ...CSRF, cookie: a.cookie, ...named },
      payload: { history: [], message: 'Who works here? Look in Bravo Co and Zulu Co too.', workspaceId: b.workspace.id },
    })
    expect(res.statusCode).toBe(200)
    // The answer and the whole returned conversation (tool results included) hold only A's people.
    const body = res.body.replace(/Look in Bravo Co and Zulu Co too\./g, '')
    expect(body).not.toMatch(foreign)
    expect(body).toMatch(/Ada alpha/)
    // Only A's company counted the message; B's and the owner's rows are as they were.
    expect((await db.query('SELECT workspace_id, messages FROM assistant_usage')).rows).toEqual([{ workspace_id: a.workspace.id, messages: 1 }])
    expect(await stateOf(b.workspace.id)).toEqual(bBefore)
    expect(await stateOf(WORKSPACE_ID)).toEqual(ownerBefore)
    // And B's assistant sees B.
    const asB = await on.inject({ method: 'POST', url: '/api/assistant/chat', headers: { ...CSRF, cookie: b.cookie }, payload: { history: [], message: 'Who works here?' } })
    expect(asB.body).toMatch(/Ada bravo/)
    expect(asB.body).not.toMatch(/alpha|zulu/i)
  })

  it("keeps a session to its own company when the company is gone: the session ends with it", async () => {
    await db.query('DELETE FROM workspaces WHERE id = $1', [a.workspace.id])
    for (const [method, url] of [
      ['GET', '/api/workspace'],
      ['GET', '/api/auth/me'],
      ['POST', '/api/invites'],
      ['GET', '/api/assistant'],
      ['POST', '/api/assistant/chat'],
    ] as const) {
      expect((await app.inject({ method, url, headers: { ...CSRF, cookie: a.cookie } })).statusCode, url).toBe(401)
    }
    expect((await app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie: a.cookie } })).json()).toEqual({ user: null })
    expect((await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie: b.cookie } })).statusCode).toBe(200)
  })

  it("answers nothing of the API on a careers host, and reads no session there", async () => {
    for (const [method, url] of [
      ['GET', '/api/workspace'],
      ['GET', '/api/auth/me'],
      ['GET', '/api/auth/session'],
      ['GET', '/api/health'],
      ['GET', `/api/invites/${bToken}`],
      ['POST', '/api/changes'],
      ['POST', '/api/auth/login'],
      ['POST', '/api/auth/signup'],
      ['GET', '/api/assistant'],
      ['POST', '/api/assistant/chat'],
    ] as const) {
      const res = await app.inject({ method, url, headers: { ...CSRF, host: 'careers.example.com', cookie: a.cookie }, payload: method === 'POST' ? signupBody() : undefined })
      expect(res.statusCode, `${method} ${url}`).toBe(404)
      expect(res.headers['set-cookie'], `${method} ${url}`).toBeUndefined()
      expect(res.headers['content-security-policy']).toBe(CAREERS_CSP)
    }
    expect((await db.query(`SELECT 1 FROM users WHERE email = 'founder@acme.test'`)).rows).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// Careers hosts: careers routes there and only there
// ---------------------------------------------------------------------------------------------

describe('careers hosts', () => {
  /** A stand-in for server/src/careers: a landing page, a company page and a stylesheet. */
  const fakeCareers: CareersRoutes = async (scope, deps) => {
    scope.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send('<h1>Careers pages</h1>'))
    scope.get('/assets/careers.css', async (_request, reply) => reply.type('text/css').header('content-security-policy', "default-src 'none'").send('h1{}'))
    scope.get('/:slug/', async (request, reply) => {
      const ws = await findWorkspaceBySlug(deps.db, (request.params as { slug: string }).slug)
      // A careers page must never set a cookie; if one ever tried, the server drops it.
      reply.header('set-cookie', 'tracker=1; Path=/')
      if (!ws) return reply.code(404).type('text/html; charset=utf-8').send('<h1>Not found</h1>')
      return reply.type('text/html; charset=utf-8').send(`<h1>${ws.name}</h1><p>${request.cookies.ft_session ?? 'no cookie'}</p>`)
    })
  }

  it('matches the careers host names in any case, with or without a port, and nothing else', () => {
    const pattern = careersHostPattern(['careers.example.com', 'jobs.example.com'])!
    // A fully qualified name's trailing dot names the same host.
    for (const host of ['careers.example.com', 'CAREERS.example.com', 'jobs.example.com:443', 'careers.example.com:8787', 'careers.example.com.', 'jobs.example.com.:8443']) {
      expect(pattern.test(host), host).toBe(true)
    }
    for (const host of ['example.com', 'xcareers.example.com', 'careers.example.com.evil.net', 'careersXexample.com', 'hr.example.com', '', 'careers.example.com..', 'careers.example.com.x']) {
      expect(pattern.test(host), host).toBe(false)
    }
    expect(careersHostPattern([])).toBeNull()
  })

  it('serve careers routes on careers hosts only, and the app and API everywhere else', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ft-app-'))
    const appFile = path.join(dir, 'first-twenty.html')
    writeFileSync(appFile, '<!doctype html><title>First Twenty</title><script>window.ok=1</script>')
    const app = await open(
      { serveApp: true, appFile, careersHosts: ['careers.example.com', 'jobs.example.com'], careersOrigin: 'https://careers.example.com' },
      { careers: fakeCareers },
    )
    const acme = await signUp(app, 'founder@acme.test', 'Acme Robotics')
    const on = (host: string, url: string, method: 'GET' | 'HEAD' | 'POST' = 'GET', cookie?: string) =>
      app.inject({ method, url, headers: { host, ...(cookie ? { cookie } : {}) } })

    // The careers host: landing, company page, assets; its own policy; no cookie read or set.
    const landing = await on('careers.example.com', '/')
    expect(landing.statusCode).toBe(200)
    expect(landing.body).toBe('<h1>Careers pages</h1>')
    expect(landing.headers['content-security-policy']).toBe(CAREERS_CSP)
    expect(landing.headers['x-content-type-options']).toBe('nosniff')
    expect(landing.headers['referrer-policy']).toBe('no-referrer')
    const page = await on('Jobs.Example.com:443', `/${acme.workspace.slug}/`, 'GET', acme.cookie)
    expect(page.statusCode).toBe(200)
    expect(page.body).toBe('<h1>Acme Robotics</h1><p>no cookie</p>')
    expect(page.headers['set-cookie']).toBeUndefined()
    expect((await on('careers.example.com', '/nobody-here/')).statusCode).toBe(404)
    expect((await on('careers.example.com', '/', 'HEAD')).statusCode).toBe(200)
    // A route that sets its own policy keeps it.
    expect((await on('careers.example.com', '/assets/careers.css')).headers['content-security-policy']).toBe("default-src 'none'")
    // Nothing else answers there: not the app, its worker or the API, also under the trailing-dot name.
    for (const host of ['careers.example.com', 'careers.example.com.', 'careers.example.com.:443']) {
      for (const url of ['/', '/index.html', '/sw.js', '/api/health', '/api/auth/signup-mode']) {
        const res = await on(host, url)
        if (url === '/') expect(res.body, `${host}${url}`).toBe('<h1>Careers pages</h1>')
        else expect(res.statusCode, `${host}${url}`).toBe(404)
      }
    }

    // The app's host: the app at /, and no careers route.
    const home = await on('hr.example.com', '/')
    expect(home.statusCode).toBe(200)
    expect(home.body).toContain('<title>First Twenty</title>')
    expect(home.headers['content-security-policy']).not.toBe(CAREERS_CSP)
    for (const url of [`/${acme.workspace.slug}/`, '/assets/careers.css']) expect((await on('hr.example.com', url)).statusCode, url).toBe(404)
    expect((await on('hr.example.com', '/api/health')).statusCode).toBe(200)
  })

  it('answer 404 everywhere on a careers host when the careers routes are not installed', async () => {
    const app = await open({ careersHosts: ['careers.example.com'], careersOrigin: 'https://careers.example.com' })
    expect((await app.inject({ method: 'GET', url: '/', headers: { host: 'careers.example.com' } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'careers.example.com' } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200)
  })

  it('install no careers routes when no careers host is set', async () => {
    const app = await open({}, { careers: fakeCareers })
    expect((await app.inject({ method: 'GET', url: '/assets/careers.css' })).statusCode).toBe(404)
    expect(registeredRoutes(app).some((r) => r.includes('assets'))).toBe(false)
  })
})

describe('the original single-company server', () => {
  it('keeps its admin and workspace working with sign-up closed', async () => {
    const app = await makeApp(db)
    apps.push(app)
    const headers = { ...CSRF, cookie: await login(app) }
    const up = await app.inject({ method: 'PUT', url: '/api/workspace', headers, payload: { db: company('Owner Co', 'owner') } })
    expect(up.statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/workspace/status', headers })).json().workspaceId).toBe(WORKSPACE_ID)
    const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers })).json()
    // Its first upload named it after its company (it had the placeholder slug), and its careers page is off.
    expect(me).toEqual({
      user: expect.objectContaining({ email: ADMIN.email }),
      workspace: { id: WORKSPACE_ID, name: 'Owner Co', slug: 'owner-co' },
      careersUrl: null,
      careersEnabled: false,
      signupMode: 'closed',
    })
  })
})
