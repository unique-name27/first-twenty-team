// HTTP tests for the API server (docs/SYNC.md, Protocol): in-memory PGlite + app.inject().
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { connect } from 'node:net'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import { buildSampleDB } from '@/data/seed'
import type { DB } from '@/domain/types'
import { RECORD_COLLECTIONS } from '../../src/sync/collections'
import { createHash } from 'node:crypto'
import { buildApp, LOGIN_BODY_LIMIT, REQUEST_TIMEOUT_MS } from './app'
import { ConcurrencyGate, hashToken, LoginRateLimiter, MAX_PASSWORD_LENGTH, upsertAdmin } from './auth'
import { testConfig } from './config'
import type { Db } from './db'
import { ConfigError } from './errors'
import { migrationFiles } from './migrate'
import { pruneChangeLog } from './repo'
import {
  ADMIN,
  codePoint,
  createAdmin,
  CSRF,
  deviceCookie,
  login,
  makeApp,
  makeTestDb,
  resetDb,
  sessionCookie,
  spyOnEmailLookups,
  TRIMMED_SPACES,
} from './test/helpers'

let db: Db
let app: FastifyInstance

beforeAll(async () => {
  db = await makeTestDb()
})
afterAll(async () => {
  await db.close()
})
beforeEach(async () => {
  await resetDb(db)
  await createAdmin(db)
  app = await makeApp(db)
})

const small = (): DB => blankDB({ companyName: 'Testco', founderFirstName: 'Ada', founderLastName: 'Byte', foundedOn: '2026-01-05' })

async function authed(): Promise<Record<string, string>> {
  return { ...CSRF, cookie: await login(app) }
}

async function upload(headers: Record<string, string>, data: DB = small(), confirmReplace?: boolean) {
  return app.inject({ method: 'PUT', url: '/api/workspace', headers, payload: confirmReplace === undefined ? { db: data } : { db: data, confirmReplace } })
}

async function push(headers: Record<string, string>, changes: unknown[]) {
  return app.inject({ method: 'POST', url: '/api/changes', headers, payload: { changes } })
}

const normalize = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** The Set-Cookie line a response sends for cookie `name`, or '' when it sends none. */
function rawCookie(res: LightMyRequestResponse, name: string): string {
  const header = res.headers['set-cookie']
  const lines = Array.isArray(header) ? header : header === undefined ? [] : [String(header)]
  return lines.find((l) => l.startsWith(`${name}=`)) ?? ''
}

describe('health and headers', () => {
  it('reports the database as up, with security headers and no caching', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, db: 'up', version: expect.any(String) })
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['x-frame-options']).toBe('DENY')
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    expect(res.headers['content-security-policy']).toContain("default-src 'none'")
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('answers 503 without details when the database is down', async () => {
    const broken: Db = {
      ...db,
      query: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:5432 password=secret')
      },
    }
    const down = await buildApp({ db: broken, config: testConfig(), logger: false })
    const res = await down.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ ok: false, db: 'down' })
    expect(res.body).not.toContain('ECONNREFUSED')
    await down.close()
  })

  it('answers 503 while the schema is behind the build, without naming migrations, until they are applied', async () => {
    const lagging = await makeTestDb()
    const newest = migrationFiles().at(-1)!
    await lagging.query('DELETE FROM schema_migrations WHERE name = $1', [newest])
    const behind = await buildApp({ db: lagging, config: testConfig(), logger: false })
    const res = await behind.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ ok: false, db: 'up', schema: 'behind' })
    expect(res.body).not.toContain('.sql')
    // server:migrate records it (the table already exists, so nothing is re-run here).
    await lagging.query('INSERT INTO schema_migrations (name) VALUES ($1)', [newest])
    const caughtUp = await behind.inject({ method: 'GET', url: '/api/health' })
    expect(caughtUp.statusCode).toBe(200)
    expect(caughtUp.json()).toMatchObject({ ok: true, db: 'up' })
    await behind.close()
    await lagging.close()
  })

  it('stays healthy when schema_migrations cannot be read (the check never takes the server down)', async () => {
    const unreadable: Db = {
      ...db,
      query: (async (text: string, params?: unknown[]) => {
        if (/schema_migrations/.test(text)) throw new Error('permission denied for table schema_migrations')
        return db.query(text, params)
      }) as Db['query'],
    }
    const app2 = await buildApp({ db: unreadable, config: testConfig(), logger: false })
    const res = await app2.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, db: 'up' })
    await app2.close()
  })

  it('never leaks error messages, SQL or stack traces', async () => {
    const broken: Db = {
      ...db,
      tx: async () => {
        throw Object.assign(new Error('relation "people" does not exist at SELECT * FROM people'), { code: '42P01' })
      },
    }
    const bad = await buildApp({ db: broken, config: testConfig(), logger: false })
    const loginRes = await bad.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: ADMIN })
    const cookie = `ft_session=${sessionCookie(loginRes)}`
    const res = await bad.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'server_error' })
    expect(res.body).not.toMatch(/relation|SELECT|at /)
    await bad.close()
  })

  it('returns JSON 404 for unknown /api paths and refuses CORS preflights', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'not_found' })
    const pre = await app.inject({
      method: 'OPTIONS',
      url: '/api/changes',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-first-twenty' },
    })
    expect(pre.statusCode).toBe(404)
    expect(pre.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('answers unknown paths and methods with 404 before reading the body', async () => {
    const json = { ...CSRF, 'content-type': 'application/json' }
    // Malformed JSON would be a 400 if the body were parsed first, and too much a 413.
    for (const [method, url] of [
      ['POST', '/nope'],
      ['PUT', '/'],
      ['POST', '/api/nope'],
      ['DELETE', '/api/workspace'],
      ['PATCH', '/api/changes'],
    ] as const) {
      const res = await app.inject({ method, url, headers: json, payload: '{x' })
      expect(res.statusCode, `${method} ${url}`).toBe(404)
      expect(res.json()).toEqual({ error: 'not_found' })
      const huge = await app.inject({ method, url, headers: json, payload: `{"x":"${'x'.repeat(2.5 * 1024 * 1024)}"}` })
      expect(huge.statusCode, `${method} ${url}`).toBe(404)
    }
    // Unknown API paths still get the API's no-store header.
    expect((await app.inject({ method: 'POST', url: '/api/nope', headers: json, payload: '{x' })).headers['cache-control']).toBe('no-store')
  })

  it('answers a stalled upload to an unknown path at once, and drops unfinished requests after REQUEST_TIMEOUT_MS', async () => {
    expect(app.server.requestTimeout).toBe(REQUEST_TIMEOUT_MS)
    const live = await makeApp(db)
    await live.listen({ host: '127.0.0.1', port: 0 })
    try {
      const { port } = live.server.address() as { port: number }
      for (const path of ['/nope', '/api/nope']) {
        // Headers announce 2,000,000 bytes; only a few arrive, then nothing.
        const answer = await new Promise<string>((resolve, reject) => {
          const socket = connect(port, '127.0.0.1')
          let data = ''
          const timer = setTimeout(() => {
            socket.destroy()
            reject(new Error(`no answer for ${path} while its body was unfinished`))
          }, 5000)
          socket.on('data', (chunk) => {
            data += chunk.toString('latin1')
            if (data.includes('\r\n\r\n')) {
              clearTimeout(timer)
              socket.destroy()
              resolve(data)
            }
          })
          socket.on('error', reject)
          socket.write(`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nX-First-Twenty: 1\r\nContent-Length: 2000000\r\n\r\n{"a":"`)
        })
        expect(answer, path).toMatch(/^HTTP\/1\.1 404 /)
      }
    } finally {
      await live.close()
    }
  })

  it('allows one development origin when ALLOWED_ORIGIN is set', async () => {
    const dev = await makeApp(db, { allowedOrigin: 'http://localhost:8826' })
    const pre = await dev.inject({ method: 'OPTIONS', url: '/api/changes', headers: { origin: 'http://localhost:8826' } })
    expect(pre.statusCode).toBe(204)
    expect(pre.headers['access-control-allow-origin']).toBe('http://localhost:8826')
    expect(pre.headers['access-control-allow-credentials']).toBe('true')
    const other = await dev.inject({ method: 'OPTIONS', url: '/api/changes', headers: { origin: 'https://evil.example' } })
    expect(other.headers['access-control-allow-origin']).toBeUndefined()
    await dev.close()
  })

  it('refuses to start with the test password hashing cost outside tests', async () => {
    const cheap = testConfig()
    await expect(buildApp({ db, config: { ...cheap, nodeEnv: 'production' }, logger: false })).rejects.toThrow(ConfigError)
    await expect(buildApp({ db, config: { ...cheap, nodeEnv: 'development' }, logger: false })).rejects.toThrow(/for tests only/)
  })
})

describe('login', () => {
  it('signs in with the right password and sets a hardened session cookie', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { email: 'Admin@Example.com ', password: ADMIN.password } })
    expect(res.statusCode).toBe(200)
    // The login's company too, so a browser can tell a login of another company from its own.
    expect(res.json()).toEqual({
      user: { id: expect.any(String), email: ADMIN.email, role: 'admin' },
      workspace: { id: 'default', name: 'Default workspace', slug: 'default-workspace' },
    })
    const raw = rawCookie(res, 'ft_session')
    expect(raw).toMatch(/^ft_session=[A-Za-z0-9_-]{43};/)
    expect(raw).toContain('HttpOnly')
    expect(raw).toContain('SameSite=Strict')
    expect(raw).toContain('Path=/api')
    // Without "Keep me signed in": a browser-session cookie (the browser drops it when it closes).
    expect(raw).not.toContain('Max-Age')
    expect(raw).not.toContain('Expires')
    expect(raw).not.toContain('Secure')
    // Only the SHA-256 of the token is stored.
    const token = sessionCookie(res)!
    const rows = await db.query<{ token_hash: string }>('SELECT token_hash FROM sessions')
    expect(rows.rows).toEqual([{ token_hash: hashToken(token) }])
    expect(rows.rows[0].token_hash).not.toBe(token)
    const user = await db.query<{ last_login_at: unknown }>('SELECT last_login_at FROM users')
    expect(user.rows[0].last_login_at).not.toBeNull()
    // The browser becomes a trusted device for 180 days, also stored as a hash only.
    const device = rawCookie(res, 'ft_device')
    expect(device).toMatch(/^ft_device=[A-Za-z0-9_-]{43}; Max-Age=15552000; Path=\/api; HttpOnly; SameSite=Strict$/)
    const devices = await db.query<{ token_hash: string; days: number }>(
      `SELECT token_hash, round(extract(epoch FROM expires_at - created_at) / 86400)::int AS days FROM trusted_devices`,
    )
    expect(devices.rows).toEqual([{ token_hash: hashToken(deviceCookie(res)!), days: 180 }])
  })

  it('ends a sign-in without remember after 12 hours, and keeps a remembered one for 7 days', async () => {
    const lifetimeHours = async () => {
      const r = await db.query<{ hours: number }>(`SELECT extract(epoch FROM expires_at - created_at)::float8 / 3600 AS hours FROM sessions`)
      expect(r.rows).toHaveLength(1)
      return r.rows[0].hours
    }
    const short = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { ...ADMIN, remember: false } })
    expect(short.statusCode).toBe(200)
    expect(rawCookie(short, 'ft_session')).not.toMatch(/Max-Age|Expires/)
    expect(await lifetimeHours()).toBeCloseTo(12, 1)

    // A new sign-in from the same browser replaces its session.
    const long = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { ...CSRF, cookie: `ft_session=${sessionCookie(short)}` },
      payload: { ...ADMIN, remember: true },
    })
    expect(long.statusCode).toBe(200)
    const raw = rawCookie(long, 'ft_session')
    expect(raw).toContain('Max-Age=604800')
    expect(raw).toContain('HttpOnly')
    expect(raw).toContain('SameSite=Strict')
    expect(await lifetimeHours()).toBeCloseTo(7 * 24, 1)
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `ft_session=${sessionCookie(long)}` } })
    expect(me.statusCode).toBe(200)
  })

  it('gives a remembered sign-in SESSION_MAX_DAYS, and refuses a remember that is not true or false', async () => {
    const capped = await makeApp(db, { sessionMaxDays: 1 })
    const long = await capped.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { ...ADMIN, remember: true } })
    expect(rawCookie(long, 'ft_session')).toContain('Max-Age=86400')
    const bad = await capped.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { ...ADMIN, remember: 'yes' } })
    expect(bad.statusCode).toBe(400)
    expect(bad.headers['set-cookie']).toBeUndefined()
    await capped.close()
  })

  it('expires a short sign-in at its 12-hour mark even while it is in use', async () => {
    const cookie = await login(app)
    await db.query(`UPDATE sessions SET created_at = now() - interval '12 hours 1 minute', expires_at = now() - interval '1 minute', last_seen_at = now()`)
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401)
  })

  it('uses Secure __Host- cookies (Path=/, no Domain) when PUBLIC_ORIGIN is https, and reads only those', async () => {
    const prod = await makeApp(db, { publicOrigin: 'https://hr.example.com', secureCookies: true })
    const res = await prod.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: ADMIN })
    expect(res.statusCode).toBe(200)
    expect(rawCookie(res, '__Host-ft_session')).toMatch(/^__Host-ft_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict$/)
    expect(rawCookie(res, '__Host-ft_device')).toMatch(/^__Host-ft_device=[A-Za-z0-9_-]{43}; Max-Age=15552000; Path=\/; HttpOnly; Secure; SameSite=Strict$/)
    expect(String(res.headers['set-cookie'])).not.toMatch(/Domain=|(^|,)ft_session=/)
    expect(res.headers['strict-transport-security']).toContain('max-age=')
    const token = sessionCookie(res)!
    expect((await prod.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `__Host-ft_session=${token}` } })).statusCode).toBe(200)
    // The plain name is never read in this mode: a cookie another host planted under it changes nothing.
    expect((await prod.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `ft_session=${token}` } })).statusCode).toBe(401)
    const out = await prod.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...CSRF, cookie: `__Host-ft_session=${token}` } })
    expect(out.statusCode).toBe(204)
    expect(rawCookie(out, '__Host-ft_session')).toMatch(/^__Host-ft_session=; Max-Age=0; Path=\/; .*HttpOnly; Secure; SameSite=Strict$/)
    await prod.close()
  })

  it('ignores an ft_session cookie planted for a parent domain ahead of the real one', async () => {
    const prod = await makeApp(db, { publicOrigin: 'https://hr.example.com', secureCookies: true })
    const signIn = await prod.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: ADMIN })
    const real = `__Host-ft_session=${sessionCookie(signIn)}`
    // What a page on a sibling host (x.sslip.io next to hr-1-2-3-4.sslip.io) can plant: Domain=sslip.io,
    // a longer path, so the browser sends it first. Either order works, and the real cookie is never cleared.
    for (const cookie of [`ft_session=planted; ${real}`, `${real}; ft_session=planted`]) {
      const me = await prod.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
      expect(me.statusCode, cookie).toBe(200)
      expect(me.headers['set-cookie'], cookie).toBeUndefined()
    }
    await prod.close()
  })

  it('does not clear the session cookie when the browser sends two of that name', async () => {
    const cookie = await login(app)
    // Plain http (development): the first of two ft_session cookies is a planted one. Clearing would
    // delete the real one, so the 401 leaves both alone.
    const twice = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `ft_session=planted; ${cookie}` } })
    expect(twice.statusCode).toBe(401)
    expect(twice.headers['set-cookie']).toBeUndefined()
    // A single stale cookie is still cleared.
    const stale = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: 'ft_session=not-a-session' } })
    expect(stale.statusCode).toBe(401)
    expect(rawCookie(stale, 'ft_session')).toMatch(/^ft_session=; Max-Age=0;.*Path=\/api/)
  })

  it('still marks cookies Secure and sends HSTS for requests Caddy received over https, when PUBLIC_ORIGIN was left at http', async () => {
    const tunnel = await makeApp(db, { publicOrigin: 'http://localhost:8787', secureCookies: false })
    // Through Caddy: X-Forwarded-Proto from 127.0.0.1, which trustProxy (loopback) honours.
    const viaCaddy = await tunnel.inject({ method: 'POST', url: '/api/auth/login', headers: { ...CSRF, 'x-forwarded-proto': 'https' }, payload: ADMIN })
    expect(viaCaddy.statusCode).toBe(200)
    expect(rawCookie(viaCaddy, '__Host-ft_session')).toContain('; Secure;')
    expect(viaCaddy.headers['strict-transport-security']).toBe('max-age=31536000')
    const me = await tunnel.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { 'x-forwarded-proto': 'https', cookie: `__Host-ft_session=${sessionCookie(viaCaddy)}` },
    })
    expect(me.statusCode).toBe(200)
    // The SSH tunnel (plain http to 127.0.0.1) keeps plain cookies.
    const direct = await tunnel.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: ADMIN })
    expect(rawCookie(direct, 'ft_session')).not.toContain('Secure')
    expect(direct.headers['strict-transport-security']).toBeUndefined()
    // The header counts only from a trusted proxy address.
    const spoofed = await tunnel.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { ...CSRF, 'x-forwarded-proto': 'https' },
      payload: ADMIN,
      remoteAddress: '203.0.113.9',
    })
    expect(rawCookie(spoofed, 'ft_session')).not.toContain('Secure')
    expect(spoofed.headers['strict-transport-security']).toBeUndefined()
    await tunnel.close()
  })

  it('refuses a wrong password or an unknown email with the same answer', async () => {
    const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { email: ADMIN.email, password: 'not-the-password' } })
    expect(wrong.statusCode).toBe(401)
    expect(wrong.json()).toEqual({ error: 'invalid_credentials' })
    expect(wrong.headers['set-cookie']).toBeUndefined()
    const unknown = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { email: 'nobody@example.com', password: ADMIN.password } })
    expect(unknown.statusCode).toBe(401)
    expect(unknown.json()).toEqual({ error: 'invalid_credentials' })
    const malformed = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { email: 1 } })
    expect(malformed.statusCode).toBe(400)
  })

  it('rate limits after 10 attempts per IP, even with the right password', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { email: `user${i}@example.com`, password: 'wrong-password' } })
      expect(res.statusCode).toBe(401)
    }
    const blocked = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: ADMIN })
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json()).toEqual({ error: 'rate_limited', retryAfter: expect.any(Number) })
    expect(blocked.json().retryAfter).toBeGreaterThan(800)
    expect(Number(blocked.headers['retry-after'])).toBe(blocked.json().retryAfter)
    // Another IP is not affected.
    const elsewhere = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: ADMIN, remoteAddress: '10.0.0.9' })
    expect(elsewhere.statusCode).toBe(200)
  })

  it('does not let one address lock the admin out from another address', async () => {
    // 10 wrong passwords for the admin from one address (as Caddy forwards it)...
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { ...CSRF, 'x-forwarded-for': '203.0.113.9' },
        payload: { email: ADMIN.email, password: 'wrong-password' },
      })
      expect(res.statusCode).toBe(401)
    }
    const sameAddress = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...CSRF, 'x-forwarded-for': '203.0.113.9' }, payload: ADMIN })
    expect(sameAddress.statusCode).toBe(429)
    // ...and the right password from anywhere else still signs in.
    const elsewhere = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...CSRF, 'x-forwarded-for': '198.51.100.7' }, payload: ADMIN })
    expect(elsewhere.statusCode).toBe(200)
  })

  it('caps failed attempts per email across addresses, and only failures count', async () => {
    const limiter = new LoginRateLimiter({ perEmailFailures: 4 })
    const capped = await buildApp({ db, config: testConfig(), logger: false, limiter })
    const attempt = (password: string, remoteAddress: string) =>
      capped.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { email: ADMIN.email, password }, remoteAddress })
    for (let i = 0; i < 6; i++) expect((await attempt(ADMIN.password, `10.0.0.${i + 1}`)).statusCode).toBe(200)
    for (let i = 0; i < 4; i++) expect((await attempt('wrong-password', `10.0.1.${i + 1}`)).statusCode).toBe(401)
    const blocked = await attempt(ADMIN.password, '10.0.2.1')
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json()).toEqual({ error: 'rate_limited', retryAfter: expect.any(Number) })
    await capped.close()
  })

  it('lets a trusted device sign in while guesses from many addresses hold the per-email cap', async () => {
    const limiter = new LoginRateLimiter()
    const capped = await buildApp({ db, config: testConfig(), logger: false, limiter })
    const attempt = (password: string, remoteAddress: string, cookie?: string, email = ADMIN.email) =>
      capped.inject({ method: 'POST', url: '/api/auth/login', headers: cookie ? { ...CSRF, cookie } : CSRF, payload: { email, password }, remoteAddress })
    // The owner signed in from home yesterday; the browser kept its device cookie.
    const home = await attempt(ADMIN.password, '198.51.100.7')
    expect(home.statusCode).toBe(200)
    const device = `ft_device=${deviceCookie(home)}`
    // Then 100 wrong passwords from 10 addresses, each under its own limit, fill the email's cap.
    for (let i = 0; i < 100; i++) expect((await attempt('wrong-password', `203.0.113.${(i % 10) + 1}`)).statusCode, String(i)).toBe(401)
    expect(limiter.count(`email:${ADMIN.email}`)).toBe(100)
    // A browser without the device cookie is refused, from home too...
    expect((await attempt(ADMIN.password, '198.51.100.7')).statusCode).toBe(429)
    expect((await attempt(ADMIN.password, '192.0.2.44')).statusCode).toBe(429)
    // ...and the owner's browser still gets in, from home or a new address, however the email is typed.
    const again = await attempt(ADMIN.password, '192.0.2.45', device, ` ${ADMIN.email.toUpperCase()}`)
    expect(again.statusCode).toBe(200)
    // Each sign-in replaces the device token; the old one no longer counts.
    const next = `ft_device=${deviceCookie(again)}`
    expect(next).not.toBe(device)
    expect((await attempt(ADMIN.password, '198.51.100.7', device)).statusCode).toBe(429)
    expect((await attempt(ADMIN.password, '198.51.100.7', next)).statusCode).toBe(200)
    expect(limiter.count(`email:${ADMIN.email}`)).toBe(100)
    await capped.close()
  })

  it('gives a trusted device a limit of its own, kept apart from the email and address limits', async () => {
    const limiter = new LoginRateLimiter()
    const app2 = await buildApp({ db, config: testConfig(), logger: false, limiter })
    const attempt = (password: string, remoteAddress: string, cookie?: string) =>
      app2.inject({ method: 'POST', url: '/api/auth/login', headers: cookie ? { ...CSRF, cookie } : CSRF, payload: { email: ADMIN.email, password }, remoteAddress })
    const device = `ft_device=${deviceCookie(await attempt(ADMIN.password, '198.51.100.7'))}`
    // The home address used up its own attempts on other emails; the device is not held to them.
    for (let i = 0; i < 9; i++) {
      const res = await app2.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { email: `x${i}@example.com`, password: 'wrong-password' }, remoteAddress: '198.51.100.7' })
      expect(res.statusCode).toBe(401)
    }
    expect((await attempt(ADMIN.password, '198.51.100.7')).statusCode).toBe(429)
    // Ten wrong passwords from the device count against the device only, and then it waits too.
    for (let i = 0; i < 10; i++) expect((await attempt('wrong-password', '198.51.100.7', device)).statusCode).toBe(401)
    const hash = hashToken(device.slice('ft_device='.length))
    expect(limiter.count(`device:${hash}`)).toBe(10)
    expect(limiter.count(`email:${ADMIN.email}`)).toBe(0)
    const waits = await attempt(ADMIN.password, '198.51.100.8', device)
    expect(waits.statusCode).toBe(429)
    expect(waits.json()).toEqual({ error: 'rate_limited', retryAfter: expect.any(Number) })
    await app2.close()
  })

  it('trusts a device only for the login that signed in on it, and forgets devices when the admin changes', async () => {
    const limiter = new LoginRateLimiter({ perEmailFailures: 2 })
    const capped = await buildApp({ db, config: testConfig(), logger: false, limiter })
    const attempt = (email: string, password: string, remoteAddress: string, cookie?: string) =>
      capped.inject({ method: 'POST', url: '/api/auth/login', headers: cookie ? { ...CSRF, cookie } : CSRF, payload: { email, password }, remoteAddress })
    const device = `ft_device=${deviceCookie(await attempt(ADMIN.email, ADMIN.password, '198.51.100.7'))}`
    // Another email with its cap full: the admin's device does not get past that one.
    for (let i = 0; i < 2; i++) expect((await attempt('other@example.com', 'wrong-password', `203.0.113.${i + 1}`)).statusCode).toBe(401)
    expect((await attempt('other@example.com', 'wrong-password', '198.51.100.7', device)).statusCode).toBe(429)
    // A malformed or made-up device token is just ignored.
    for (let i = 0; i < 2; i++) expect((await attempt(ADMIN.email, 'wrong-password', `203.0.113.${i + 10}`)).statusCode).toBe(401)
    expect((await attempt(ADMIN.email, ADMIN.password, '198.51.100.9', 'ft_device=x')).statusCode).toBe(429)
    expect((await attempt(ADMIN.email, ADMIN.password, '198.51.100.9', `ft_device=${'A'.repeat(43)}`)).statusCode).toBe(429)
    // server:create-admin (a new password, or a new email to escape a lockout) forgets every device.
    await createAdmin(db)
    expect((await db.query('SELECT 1 FROM trusted_devices')).rows).toEqual([])
    expect((await attempt(ADMIN.email, ADMIN.password, '198.51.100.7', device)).statusCode).toBe(429)
    await capped.close()
  })

  it('charges every password check against the admin to the admin limiter key, however the email is padded', async () => {
    const limiter = new LoginRateLimiter({ perEmailFailures: 10_000 })
    const lookups: string[] = []
    const spied = await buildApp({ db: spyOnEmailLookups(db, lookups), config: testConfig(), logger: false, limiter })
    let n = 0
    const attempt = (email: string) =>
      spied.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { email, password: 'wrong-password' }, remoteAddress: `10.20.${n >> 8}.${n++ & 255}` })
    let adminForms = 0
    for (const p of TRIMMED_SPACES) {
      const sameAsAdmin = [`${p}${p}${ADMIN.email.toUpperCase()}${p}`, `${ADMIN.email}${p.repeat(300)}`]
      // The review's probe: padding in the middle, then one more character, over 254 in all.
      const probe = `${ADMIN.email}${p.repeat(240)}x`
      for (const email of [...sameAsAdmin, probe]) expect((await attempt(email)).statusCode, codePoint(p)).toBe(401)
      adminForms += sameAsAdmin.length
    }
    // At exactly 254 characters it is someone else's email, checked and counted as itself; so is one
    // ending in a zero-width space, which trim keeps.
    const others = [' ', '　'].map((p) => `${ADMIN.email}${p.repeat(254 - ADMIN.email.length - 1)}x`)
    others.push(`${ADMIN.email}​`)
    for (const email of others) expect((await attempt(email)).statusCode).toBe(401)

    // Every check against the admin's row was counted under the admin's key...
    expect(lookups.filter((e) => e === ADMIN.email)).toHaveLength(adminForms)
    expect(limiter.count(`email:${ADMIN.email}`)).toBe(adminForms)
    // ...every other check under the very string it looked up...
    for (const e of new Set(lookups)) expect(limiter.count(`email:${e}`), JSON.stringify(e.slice(-8))).toBe(lookups.filter((x) => x === e).length)
    // ...and no email over 254 characters reached a password check.
    expect(lookups.every((e) => e.length <= 254)).toBe(true)
    expect(lookups).toHaveLength(adminForms + others.length)
    await spied.close()
  })

  it('keeps the per-email cap when the email is padded past 254 characters', async () => {
    const limiter = new LoginRateLimiter({ perEmailFailures: 4 })
    const capped = await buildApp({ db, config: testConfig(), logger: false, limiter })
    let n = 0
    const attempt = (email: string, password: string) =>
      capped.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { email, password }, remoteAddress: `10.30.${n >> 8}.${n++ & 255}` })
    for (let i = 0; i < 4; i++) expect((await attempt(ADMIN.email, 'wrong-password')).statusCode).toBe(401)
    for (const p of TRIMMED_SPACES) {
      // Trimming first and slicing to 254 after cut the x off, and the lookup trimmed the rest away.
      expect((await attempt(`${ADMIN.email}${p.repeat(240)}x`, ADMIN.password)).statusCode, codePoint(p)).toBe(401)
      expect((await attempt(`${p}${ADMIN.email}${p}`, ADMIN.password)).statusCode, codePoint(p)).toBe(429)
    }
    expect((await attempt(ADMIN.email, ADMIN.password)).statusCode).toBe(429)
    expect(limiter.count(`email:${ADMIN.email}`)).toBe(4)
    await capped.close()
  })

  it('charges sign-ins that cannot succeed to the client address only, without a password check', async () => {
    const limiter = new LoginRateLimiter()
    const lookups: string[] = []
    const spied = await buildApp({ db: spyOnEmailLookups(db, lookups), config: testConfig(), logger: false, limiter })
    const hopeless = [
      { email: ADMIN.email, password: '' },
      { email: ADMIN.email, password: 'x'.repeat(MAX_PASSWORD_LENGTH + 1) },
      { email: '', password: ADMIN.password },
      { email: ' \t　﻿', password: ADMIN.password },
      { email: `${'a'.repeat(243)}@example.com`, password: ADMIN.password },
    ]
    for (let i = 0; i < 10; i++) {
      const res = await spied.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: hopeless[i % hopeless.length], remoteAddress: '10.40.0.1' })
      expect(res.statusCode, String(i)).toBe(401)
      expect(res.json()).toEqual({ error: 'invalid_credentials' })
    }
    expect(lookups).toEqual([])
    expect(limiter.size).toBe(1)
    expect(limiter.count('ip:10.40.0.1')).toBe(10)
    expect(limiter.count(`email:${ADMIN.email}`)).toBe(0)
    // They still use up the address's own attempts.
    const blocked = await spied.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: ADMIN, remoteAddress: '10.40.0.1' })
    expect(blocked.statusCode).toBe(429)
    await spied.close()
  })

  it('lets the admin sign in after cheap sign-ins from many addresses filled the address limit with lockouts', async () => {
    const limiter = new LoginRateLimiter({ maxKeys: 20 })
    const flooded = await buildApp({ db, config: testConfig(), logger: false, limiter })
    const login = (payload: { email: string; password: string }, remoteAddress: string) =>
      flooded.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload, remoteAddress })
    expect((await login(ADMIN, '198.51.100.7')).statusCode).toBe(200)
    for (let i = 0; i < 20; i++) {
      for (let j = 0; j < 10; j++) expect((await login({ email: `x${i}@example.com`, password: '' }, `10.50.0.${i}`)).statusCode).toBe(401)
    }
    expect((await login({ email: 'x0@example.com', password: '' }, '10.50.0.0')).statusCode).toBe(429)
    // From home (its key was pushed out by the flood) and from an address the limiter never saw.
    expect((await login(ADMIN, '198.51.100.7')).statusCode).toBe(200)
    expect((await login(ADMIN, '203.0.113.5')).statusCode).toBe(200)
    await flooded.close()
  })

  it('does not let sign-ins refused as busy push the admin failure count out of the limiter', async () => {
    const limiter = new LoginRateLimiter({ maxKeys: 8, perEmailFailures: 3 })
    const gate = new ConcurrencyGate(1, 0)
    const busy = await buildApp({ db, config: testConfig(), logger: false, limiter, passwordGate: gate })
    const attempt = (email: string, password: string, remoteAddress: string) =>
      busy.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { email, password }, remoteAddress })
    for (let i = 0; i < 2; i++) expect((await attempt(ADMIN.email, 'wrong-password', `10.50.0.${i + 1}`)).statusCode).toBe(401)
    expect(limiter.count(`email:${ADMIN.email}`)).toBe(2)
    // Hold the only password-check slot, then flood the server with throwaway emails.
    let release: () => void = () => {}
    const held = gate.run(() => new Promise<void>((resolve) => (release = resolve)))
    for (let i = 0; i < 40; i++) {
      const res = await attempt(`junk${i}@example.com`, 'wrong-password', `10.51.0.${i + 1}`)
      expect(res.statusCode).toBe(429)
      expect(res.json()).toEqual({ error: 'busy', retryAfter: 5 })
    }
    release()
    await held
    expect(limiter.count(`email:${ADMIN.email}`)).toBe(2)
    // Each refused sign-in counted against its address only.
    expect(limiter.count('email:junk39@example.com')).toBe(0)
    expect(limiter.count('email-ip:junk39@example.com|10.51.0.40')).toBe(0)
    expect(limiter.count('ip:10.51.0.40')).toBe(1)
    // One more failure reaches the cap.
    expect((await attempt(ADMIN.email, 'wrong-password', '10.50.0.3')).statusCode).toBe(401)
    expect((await attempt(ADMIN.email, ADMIN.password, '10.50.0.4')).statusCode).toBe(429)
    await busy.close()
  })

  it('counts IPv6 clients per /64, so rotating addresses does not get around the limit', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: CSRF,
        payload: { email: `user${i}@example.com`, password: 'wrong-password' },
        remoteAddress: `2001:db8:1:2::${(i + 1).toString(16)}`,
      })
      expect(res.statusCode).toBe(401)
    }
    const rotated = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: ADMIN, remoteAddress: '2001:db8:1:2:ffff:1:2:3' })
    expect(rotated.statusCode).toBe(429)
    const otherNetwork = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: ADMIN, remoteAddress: '2001:db8:1:3::1' })
    expect(otherNetwork.statusCode).toBe(200)
  })

  it('refuses sign-ins while too many password checks are waiting', async () => {
    // Hashed at the real cost, the first check still holds the only slot when the other two arrive (a
    // check at the test cost might finish first).
    await upsertAdmin(db, ADMIN.email, ADMIN.password)
    const gate = new ConcurrencyGate(1, 0)
    const busy = await buildApp({ db, config: testConfig(), logger: false, passwordGate: gate })
    const attempt = (i: number) =>
      busy.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { email: ADMIN.email, password: 'wrong-password' }, remoteAddress: `10.0.3.${i}` })
    const results = await Promise.all([attempt(1), attempt(2), attempt(3)])
    const codes = results.map((r) => r.statusCode)
    expect(codes).toContain(401)
    expect(codes).toContain(429)
    const refused = results.find((r) => r.statusCode === 429)!
    expect(refused.json()).toEqual({ error: 'busy', retryAfter: 5 })
    expect(refused.headers['retry-after']).toBe('5')
    await busy.close()
  })

  it('keeps login and logout bodies small', async () => {
    const big = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { ...CSRF, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: ADMIN.email, password: 'x'.repeat(LOGIN_BODY_LIMIT) }),
    })
    expect(big.statusCode).toBe(413)
    // The longest allowed email and password still fit (a 2-byte character 1,024 times).
    const longest = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: CSRF,
      payload: { email: `${'a'.repeat(240)}@example.com`, password: String.fromCharCode(0xe9).repeat(1024) },
    })
    expect(longest.statusCode).toBe(401)
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { ...CSRF, 'content-type': 'application/json' },
      payload: JSON.stringify({ x: 'y'.repeat(2048) }),
    })
    expect(logout.statusCode).toBe(413)
  })
})

describe('CSRF guard', () => {
  it('refuses non-GET requests without X-First-Twenty: 1', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('csrf')
    const cookie = await login(app)
    const put = await app.inject({ method: 'PUT', url: '/api/workspace', headers: { cookie }, payload: { db: small() } })
    expect(put.statusCode).toBe(403)
    const wrongValue = await app.inject({ method: 'POST', url: '/api/changes', headers: { cookie, 'x-first-twenty': 'yes' }, payload: { changes: [] } })
    expect(wrongValue.statusCode).toBe(403)
    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } })
    expect(logout.statusCode).toBe(403)
  })

  it('lets only same-origin pages (or a user action, or a tool with no label) write', async () => {
    const attempt = (site?: string) =>
      app.inject({ method: 'POST', url: '/api/auth/login', headers: site ? { ...CSRF, 'sec-fetch-site': site } : CSRF, payload: ADMIN })
    // A sibling host under a shared domain (x.sslip.io next to hr-1-2-3-4.sslip.io) is 'same-site'.
    for (const site of ['cross-site', 'same-site']) {
      const res = await attempt(site)
      expect(res.statusCode, site).toBe(403)
      expect(res.json()).toEqual({ error: 'cross_site' })
      expect(res.headers['set-cookie'], site).toBeUndefined()
    }
    for (const site of ['same-origin', 'none', undefined]) expect((await attempt(site)).statusCode, String(site)).toBe(200)
    // The development origin (another port on localhost, so 'same-site') is the exception.
    const dev = await makeApp(db, { allowedOrigin: 'http://localhost:8826' })
    const fromDev = await dev.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { ...CSRF, origin: 'http://localhost:8826', 'sec-fetch-site': 'same-site' },
      payload: ADMIN,
    })
    expect(fromDev.statusCode).toBe(200)
    await dev.close()
  })

  it('guards percent-encoded API paths the same way (the router decodes them)', async () => {
    const logout = await app.inject({ method: 'POST', url: '/%61pi/auth/logout', headers: { 'content-type': 'application/json' }, payload: '' })
    expect(logout.statusCode).toBe(403)
    expect(logout.json().error).toBe('csrf')
    const crossSite = await app.inject({ method: 'POST', url: '/%61pi/auth/login', headers: { ...CSRF, 'sec-fetch-site': 'cross-site' }, payload: ADMIN })
    expect(crossSite.statusCode).toBe(403)
    expect(crossSite.headers['set-cookie']).toBeUndefined()
    const noHeader = await app.inject({ method: 'POST', url: '/%61pi/auth/login', payload: ADMIN })
    expect(noHeader.statusCode).toBe(403)
    const cookie = await login(app)
    const me = await app.inject({ method: 'GET', url: '/%61pi/auth/me', headers: { cookie } })
    expect(me.statusCode).toBe(200)
    expect(me.headers['cache-control']).toBe('no-store')
    const anon = await app.inject({ method: 'GET', url: '/%61pi/workspace' })
    expect(anon.statusCode).toBe(401)
    expect(anon.headers['cache-control']).toBe('no-store')
    const missing = await app.inject({ method: 'GET', url: '/api/nope' })
    expect(missing.headers['cache-control']).toBe('no-store')
  })

  it('accepts only JSON bodies', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { ...CSRF, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=a&password=b',
    })
    expect(res.statusCode).toBe(415)
    expect(res.json()).toEqual({ error: 'unsupported_media_type' })
  })
})

describe('me and logout', () => {
  it('reports the user, then signs out and deletes the session', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/auth/me' })
    expect(anon.statusCode).toBe(401)
    const cookie = await login(app)
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
    expect(me.statusCode).toBe(200)
    expect(me.json().user).toMatchObject({ email: ADMIN.email, role: 'admin' })

    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...CSRF, cookie } })
    expect(out.statusCode).toBe(204)
    expect(out.body).toBe('')
    expect(String(out.headers['set-cookie'])).toMatch(/ft_session=;.*Path=\/api/)
    expect((await db.query('SELECT 1 FROM sessions')).rows).toHaveLength(0)

    const after = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
    expect(after.statusCode).toBe(401)
  })

  it('answers who is signed in without a 401 when nobody is (GET /api/auth/session, r2-48)', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/auth/session' })
    expect(anon.statusCode).toBe(200)
    expect(anon.json()).toEqual({ user: null })
    expect(anon.headers['cache-control']).toBe('no-store')
    const cookie = await login(app)
    const signedIn = await app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } })
    expect(signedIn.statusCode).toBe(200)
    expect(signedIn.json().user).toMatchObject({ email: ADMIN.email, role: 'admin' })
    // A session that ended is nobody too, and its cookie is cleared as /api/auth/me would.
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...CSRF, cookie } })
    const ended = await app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } })
    expect(ended.statusCode).toBe(200)
    expect(ended.json()).toEqual({ user: null })
    expect(String(ended.headers['set-cookie'])).toMatch(/ft_session=;/)
    // A planted twin is left alone, as everywhere else.
    const twice = await app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie: `ft_session=planted; ${cookie}` } })
    expect(twice.json()).toEqual({ user: null })
    expect(twice.headers['set-cookie']).toBeUndefined()
    // /api/auth/me keeps its 401 for older clients.
    expect((await app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401)
  })

  it('logs out with a JSON content type and an empty body', async () => {
    const cookie = await login(app)
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...CSRF, cookie, 'content-type': 'application/json' } })
    expect(out.statusCode).toBe(204)
  })

  it('expires sessions after 12 idle hours and after 7 days', async () => {
    const cookie = await login(app)
    await db.query(`UPDATE sessions SET last_seen_at = now() - interval '13 hours'`)
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401)
    expect((await db.query('SELECT 1 FROM sessions')).rows).toHaveLength(0)

    const cookie2 = await login(app)
    await db.query(`UPDATE sessions SET expires_at = now() - interval '1 minute'`)
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookie2 } })).statusCode).toBe(401)
  })

  it('refreshes last_seen_at at most once a minute', async () => {
    const cookie = await login(app)
    await db.query(`UPDATE sessions SET last_seen_at = now() - interval '30 seconds'`)
    const before = await db.query<{ last_seen_at: Date }>('SELECT last_seen_at FROM sessions')
    await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
    const same = await db.query<{ last_seen_at: Date }>('SELECT last_seen_at FROM sessions')
    expect(new Date(same.rows[0].last_seen_at).getTime()).toBe(new Date(before.rows[0].last_seen_at).getTime())
    await db.query(`UPDATE sessions SET last_seen_at = now() - interval '5 minutes'`)
    await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
    const fresh = await db.query<{ age: number }>(`SELECT extract(epoch FROM now() - last_seen_at)::float8 AS age FROM sessions`)
    expect(fresh.rows[0].age).toBeLessThan(60)
  })
})

describe('workspace', () => {
  it('needs a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/workspace' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/changes?since=0' })).statusCode).toBe(401)
    const put = await app.inject({ method: 'PUT', url: '/api/workspace', headers: CSRF, payload: { db: small() } })
    expect(put.statusCode).toBe(401)
    expect(put.json()).toEqual({ error: 'unauthorized', detail: expect.any(String) })
  })

  it('refuses anonymous requests before reading their bodies', async () => {
    const json = { ...CSRF, 'content-type': 'application/json' }
    // Invalid JSON would be a 400 if the body were parsed first.
    const invalid = await app.inject({ method: 'PUT', url: '/api/workspace', headers: json, payload: '{x' })
    expect(invalid.statusCode).toBe(401)
    const pushInvalid = await app.inject({ method: 'POST', url: '/api/changes', headers: json, payload: '{x' })
    expect(pushInvalid.statusCode).toBe(401)
    // Over the body limit would be a 413 if the body were read first.
    const huge = await app.inject({ method: 'POST', url: '/api/changes', headers: json, payload: '{"changes":"' + 'x'.repeat(2.5 * 1024 * 1024) + '"}' })
    expect(huge.statusCode).toBe(401)
    // An unknown cookie counts as anonymous too.
    const stale = await app.inject({ method: 'PUT', url: '/api/workspace', headers: { ...json, cookie: 'ft_session=not-a-session' }, payload: '{x' })
    expect(stale.statusCode).toBe(401)
  })

  it('says whether it is empty without a 404 (status), and needs a session for that too', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/workspace/status' })
    expect(anon.statusCode).toBe(401)
    expect(anon.json().error).toBe('unauthorized')
    const h = await authed()
    const empty = await app.inject({ method: 'GET', url: '/api/workspace/status', headers: h })
    expect(empty.statusCode).toBe(200)
    expect(empty.json()).toEqual({ empty: true })
    expect(empty.headers['cache-control']).toBe('no-store')
    const put = await upload(h)
    const full = await app.inject({ method: 'GET', url: '/api/workspace/status', headers: h })
    expect(full.statusCode).toBe(200)
    expect(full.json()).toEqual({ empty: false, workspaceId: 'default', historyId: put.json().historyId, seq: put.json().seq })
    // The seq follows pushes, like the snapshot's.
    const pushed = await push(h, [{ collection: 'jobs', id: 'j-status', op: 'upsert', data: { id: 'j-status' }, baseVersion: null }])
    const after = await app.inject({ method: 'GET', url: '/api/workspace/status', headers: h })
    expect(after.json().seq).toBe(pushed.json().seq)
    expect(after.json().seq).toBe((await app.inject({ method: 'GET', url: '/api/workspace', headers: h })).json().seq)
  })

  it('is empty (404) before the first upload', async () => {
    const h = await authed()
    const res = await app.inject({ method: 'GET', url: '/api/workspace', headers: h })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'empty' })
    const pull = await app.inject({ method: 'GET', url: '/api/changes?since=0', headers: h })
    expect(pull.json()).toEqual({ resync: true })
    const pushRes = await push(h, [{ collection: 'jobs', id: 'j-1', op: 'upsert', data: { id: 'j-1' }, baseVersion: null }])
    expect(pushRes.statusCode).toBe(404)
    expect(pushRes.json().error).toBe('empty')
  })

  it('accepts the first upload, then requires confirmReplace', async () => {
    const h = await authed()
    const data = small()
    const first = await upload(h, data)
    expect(first.statusCode).toBe(200)
    const body = first.json() as { seq: number; versions: Record<string, number> }
    expect(body.seq).toBeGreaterThan(0)
    // Each version is the seq of the record's log row: unique, and none above the returned seq.
    const values = Object.values(body.versions)
    expect(new Set(values).size).toBe(values.length)
    expect(values.every((v) => Number.isInteger(v) && v > 0 && v <= body.seq)).toBe(true)
    expect(body.versions['people:p-founder']).toEqual(expect.any(Number))
    expect(body.versions['$doc:company']).toEqual(expect.any(Number))
    expect(first.json().historyId).toMatch(/^[0-9a-f-]{36}$/)

    const again = await upload(h, data)
    expect(again.statusCode).toBe(409)
    expect(again.json().error).toBe('not_empty')

    const changed = { ...data, company: { ...data.company, name: 'Renamed' } }
    const replaced = await upload(h, changed, true)
    expect(replaced.statusCode).toBe(200)
    expect(replaced.json().seq).toBeGreaterThan(body.seq)
    expect(replaced.json().historyId).not.toBe(first.json().historyId)
    const snap = await app.inject({ method: 'GET', url: '/api/workspace', headers: h })
    expect(snap.json().db.company.name).toBe('Renamed')
  })

  it('round-trips the full Ledgerlark sample exactly', async () => {
    const h = await authed()
    const sample = buildSampleDB()
    const put = await upload(h, sample)
    expect(put.statusCode).toBe(200)
    const res = await app.inject({ method: 'GET', url: '/api/workspace', headers: h })
    expect(res.statusCode).toBe(200)
    const snap = res.json() as { workspaceId: string; seq: number; db: DB; versions: Record<string, number> }
    expect(snap.workspaceId).toBe('default')
    expect(snap.seq).toBe(put.json().seq)
    expect(snap.db).toEqual(normalize(sample))
    // Same arrays in the same order, collection by collection.
    for (const c of RECORD_COLLECTIONS) {
      expect(snap.db[c].map((r: { id: string }) => r.id)).toEqual(sample[c].map((r: { id: string }) => r.id))
    }
    const recordCount = RECORD_COLLECTIONS.reduce((n, c) => n + sample[c].length, 0)
    expect(Object.keys(snap.versions)).toHaveLength(recordCount + 6)
  })

  it('refuses unknown keys, duplicate ids and a wrong schema version', async () => {
    const h = await authed()
    const extra = await upload(h, { ...small(), salaries: [] } as unknown as DB)
    expect(extra.statusCode).toBe(400)
    expect(extra.json().error).toBe('bad_request')
    const data = small()
    const dupe = await upload(h, { ...data, people: [...data.people, ...data.people] })
    expect(dupe.statusCode).toBe(400)
    expect(dupe.json().detail).toContain('more than once')
    const v2 = await upload(h, { ...data, schemaVersion: 2 } as unknown as DB)
    expect(v2.statusCode).toBe(400)
  })

  it('enforces the 10 MB body limit on PUT and 2 MB elsewhere', async () => {
    const h = await authed()
    const huge = await app.inject({ method: 'PUT', url: '/api/workspace', headers: { ...h, 'content-type': 'application/json' }, payload: `{"db":"${'x'.repeat(10.5 * 1024 * 1024)}"}` })
    expect(huge.statusCode).toBe(413)
    expect(huge.json()).toEqual({ error: 'too_large' })
    const big = await app.inject({ method: 'POST', url: '/api/changes', headers: { ...h, 'content-type': 'application/json' }, payload: `{"changes":"${'x'.repeat(2.5 * 1024 * 1024)}"}` })
    expect(big.statusCode).toBe(413)
    // 3 MB is fine for the workspace upload (it fails validation, not the size check).
    const mid = await app.inject({ method: 'PUT', url: '/api/workspace', headers: { ...h, 'content-type': 'application/json' }, payload: `{"db":"${'x'.repeat(3 * 1024 * 1024)}"}` })
    expect(mid.statusCode).toBe(400)
  })
})

describe('changes', () => {
  let h: Record<string, string>
  let seq0: number
  let history0: string
  /** Versions right after the upload: founder and company. */
  let vFounder: number
  let vCompany: number
  const person = (id: string, extra: Record<string, unknown> = {}) => ({ ...small().people[0], id, firstName: 'New', lastName: 'Person', ...extra })

  beforeEach(async () => {
    h = await authed()
    const up = (await upload(h)).json()
    seq0 = up.seq
    history0 = up.historyId
    vFounder = up.versions['people:p-founder']
    vCompany = up.versions['$doc:company']
  })

  it('pulls nothing right after the upload', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/changes?since=${seq0}`, headers: h })
    expect(res.json()).toEqual({ historyId: history0, seq: seq0, changes: [] })
  })

  it('applies a new record and returns it from changes since', async () => {
    const res = await push(h, [{ collection: 'people', id: 'p-new', op: 'upsert', data: person('p-new'), baseVersion: null }])
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // The new version is the seq of the write.
    expect(body.applied).toEqual([{ collection: 'people', id: 'p-new', version: seq0 + 1 }])
    expect(body.conflicts).toEqual([])
    expect(body.seq).toBe(seq0 + 1)
    expect(body.historyId).toBe(history0)

    const pull = await app.inject({ method: 'GET', url: `/api/changes?since=${seq0}`, headers: h })
    expect(pull.json()).toEqual({
      historyId: history0,
      seq: seq0 + 1,
      changes: [{ seq: seq0 + 1, collection: 'people', id: 'p-new', op: 'upsert', version: seq0 + 1, data: normalize(person('p-new')) }],
    })
    // New records append to the end of the array.
    const snap = (await app.inject({ method: 'GET', url: '/api/workspace', headers: h })).json()
    expect(snap.db.people.at(-1).id).toBe('p-new')
    expect(snap.versions['people:p-new']).toBe(seq0 + 1)
    expect(snap.historyId).toBe(history0)
  })

  it('accepts an update whose baseVersion matches and bumps the version', async () => {
    const updated = { ...small().people[0], title: 'Chief everything officer' }
    const res = await push(h, [
      { collection: 'people', id: 'p-founder', op: 'upsert', data: updated, baseVersion: vFounder },
      { collection: '$doc', id: 'company', op: 'upsert', data: { ...small().company, name: 'Docco' }, baseVersion: vCompany },
    ])
    expect(res.json().applied).toEqual([
      { collection: 'people', id: 'p-founder', version: seq0 + 1 },
      { collection: '$doc', id: 'company', version: seq0 + 2 },
    ])
    const snap = (await app.inject({ method: 'GET', url: '/api/workspace', headers: h })).json()
    expect(snap.db.people[0].title).toBe('Chief everything officer')
    expect(snap.db.company.name).toBe('Docco')
    expect(snap.versions['people:p-founder']).toBe(seq0 + 1)
    expect(snap.versions['$doc:company']).toBe(seq0 + 2)
    const log = await db.query<{ user_id: string | null }>(`SELECT user_id FROM change_log WHERE record_id = 'p-founder' ORDER BY seq DESC LIMIT 1`)
    expect(log.rows[0].user_id).toEqual(expect.any(String))
  })

  it('returns the server copy on a stale baseVersion (the server wins)', async () => {
    const v2 = { ...small().people[0], title: 'Version two' }
    const vTwo = (await push(h, [{ collection: 'people', id: 'p-founder', op: 'upsert', data: v2, baseVersion: vFounder }])).json().applied[0].version
    const stale = { ...small().people[0], title: 'Stale edit' }
    const res = await push(h, [
      { collection: 'people', id: 'p-founder', op: 'upsert', data: stale, baseVersion: vFounder },
      { collection: 'people', id: 'p-founder', op: 'delete', baseVersion: vFounder },
    ])
    const body = res.json()
    expect(body.applied).toEqual([])
    // The admin wrote the copy that won (byYou); neither stale change is in the log (no landed).
    expect(body.conflicts).toEqual([
      { collection: 'people', id: 'p-founder', serverVersion: vTwo, serverData: normalize(v2), byYou: true },
      { collection: 'people', id: 'p-founder', serverVersion: vTwo, serverData: normalize(v2), byYou: true },
    ])
    // A create for an id the server already has is a conflict too.
    const dupe = await push(h, [{ collection: 'people', id: 'p-founder', op: 'upsert', data: stale, baseVersion: null }])
    expect(dupe.json().conflicts[0].serverVersion).toBe(vTwo)
    // A retried push whose data the server already holds counts as applied, marked existing.
    const retry = await push(h, [{ collection: 'people', id: 'p-founder', op: 'upsert', data: v2, baseVersion: vFounder }])
    expect(retry.json()).toMatchObject({ applied: [{ collection: 'people', id: 'p-founder', version: vTwo, existing: true }], conflicts: [] })
    // Once something newer is on top, retrying that write is a conflict that says it landed.
    const v3 = (await push(h, [{ collection: 'people', id: 'p-founder', op: 'upsert', data: { ...v2, title: 'Three' }, baseVersion: vTwo }])).json().applied[0].version
    const late = await push(h, [{ collection: 'people', id: 'p-founder', op: 'upsert', data: v2, baseVersion: vFounder }])
    expect(late.json().conflicts).toEqual([
      { collection: 'people', id: 'p-founder', serverVersion: v3, serverData: normalize({ ...v2, title: 'Three' }), byYou: true, landed: true },
    ])
    // Nothing was logged for the rejected or repeated changes: only the two real writes.
    const pull = await app.inject({ method: 'GET', url: `/api/changes?since=${seq0}`, headers: h })
    expect(pull.json().changes.map((c: { version: number }) => c.version)).toEqual([vTwo, v3])
  })

  it('deletes, then pulls the delete; a stale client edit cannot bring the record back, a re-create can', async () => {
    const res = await push(h, [{ collection: 'people', id: 'p-founder', op: 'delete', baseVersion: vFounder }])
    expect(res.json().applied).toEqual([{ collection: 'people', id: 'p-founder', version: seq0 + 1 }])
    const pull = await app.inject({ method: 'GET', url: `/api/changes?since=${seq0}`, headers: h })
    expect(pull.json().changes).toEqual([{ seq: seq0 + 1, collection: 'people', id: 'p-founder', op: 'delete', version: seq0 + 1 }])
    const snap = (await app.inject({ method: 'GET', url: '/api/workspace', headers: h })).json()
    expect(snap.db.people).toEqual([])
    expect(snap.versions['people:p-founder']).toBeUndefined()

    // Deleting again is a no-op that still succeeds.
    const again = await push(h, [{ collection: 'people', id: 'p-founder', op: 'delete', baseVersion: vFounder }])
    expect(again.json()).toMatchObject({ applied: [{ version: seq0 + 1 }], conflicts: [], seq: seq0 + 1 })

    // An edit made on the copy from before the delete loses to it: the server wins, as for any newer
    // change, and says the delete was this user's (r2-44).
    const stale = await push(h, [{ collection: 'people', id: 'p-founder', op: 'upsert', data: small().people[0], baseVersion: vFounder }])
    expect(stale.json()).toMatchObject({
      applied: [],
      conflicts: [{ collection: 'people', id: 'p-founder', serverVersion: null, serverData: null, byYou: true }],
      seq: seq0 + 1,
    })
    // A client that saw the delete re-creates it as new (Undo), with a newer version.
    const back = await push(h, [{ collection: 'people', id: 'p-founder', op: 'upsert', data: small().people[0], baseVersion: null }])
    expect(back.json().applied).toEqual([{ collection: 'people', id: 'p-founder', version: seq0 + 2 }])
  })

  it('reports a conflict with null for an edit to a record the server never had', async () => {
    const res = await push(h, [{ collection: 'jobs', id: 'j-ghost', op: 'upsert', data: { id: 'j-ghost', title: 'Ghost' }, baseVersion: 4 }])
    expect(res.json().conflicts).toEqual([{ collection: 'jobs', id: 'j-ghost', serverVersion: null, serverData: null }])
  })

  it('does not let an edit from before a full replace overwrite the imported copy or later edits', async () => {
    // A and B both know p-founder at vA. A goes offline and edits it; B imports with confirmReplace,
    // then edits the imported record.
    const vA = (await push(h, [{ collection: 'people', id: 'p-founder', op: 'upsert', data: person('p-founder', { title: 'Engineer' }), baseVersion: vFounder }])).json()
      .applied[0].version
    const imported = { ...small(), people: [person('p-founder', { title: 'Staff engineer (imported)' })] }
    const replaced = (await upload(h, imported, true)).json()
    const vImported = replaced.versions['people:p-founder']
    expect(vImported).not.toBe(vA)
    expect(vImported).not.toBe(vFounder)
    const vB = (
      await push(h, [{ collection: 'people', id: 'p-founder', op: 'upsert', data: person('p-founder', { title: 'Staff engineer (imported)', workEmail: 'p@example.test' }), baseVersion: vImported }])
    ).json().applied[0].version
    // A comes back and pushes before pulling: both of its stale versions are conflicts now.
    const fromA = await push(h, [
      { collection: 'people', id: 'p-founder', op: 'upsert', data: person('p-founder', { title: 'Senior engineer' }), baseVersion: vA },
      { collection: '$doc', id: 'company', op: 'upsert', data: { ...small().company, name: 'Old name' }, baseVersion: vCompany },
    ])
    expect(fromA.json().applied).toEqual([])
    expect(fromA.json().conflicts.map((c: { id: string; serverVersion: number }) => [c.id, c.serverVersion])).toEqual([
      ['p-founder', vB],
      ['company', replaced.versions['$doc:company']],
    ])
    const snap = (await app.inject({ method: 'GET', url: '/api/workspace', headers: h })).json()
    expect(snap.db.people[0]).toMatchObject({ title: 'Staff engineer (imported)', workEmail: 'p@example.test' })
    expect(snap.db.company.name).toBe(small().company.name)
  })

  it('checks the history id: pulls from another history resync, pushes from one are refused', async () => {
    const other = '00000000-0000-4000-8000-000000000000'
    const same = await app.inject({ method: 'GET', url: `/api/changes?since=${seq0}&history=${history0}`, headers: h })
    expect(same.json()).toEqual({ historyId: history0, seq: seq0, changes: [] })
    const foreign = await app.inject({ method: 'GET', url: `/api/changes?since=${seq0}&history=${other}`, headers: h })
    expect(foreign.json()).toEqual({ resync: true })
    const malformed = await app.inject({ method: 'GET', url: `/api/changes?since=${seq0}&history=nope`, headers: h })
    expect(malformed.statusCode).toBe(400)

    const change = { collection: 'people', id: 'p-h', op: 'upsert', data: person('p-h'), baseVersion: null }
    const refused = await app.inject({ method: 'POST', url: '/api/changes', headers: h, payload: { changes: [change], historyId: other } })
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toEqual({ error: 'resync', detail: expect.any(String) })
    expect((await db.query(`SELECT 1 FROM people WHERE id = 'p-h'`)).rows).toHaveLength(0)
    const accepted = await app.inject({ method: 'POST', url: '/api/changes', headers: h, payload: { changes: [change], historyId: history0 } })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json().historyId).toBe(history0)

    // A full replace starts a new history: the old id now means resync.
    const replaced = (await upload(h, small(), true)).json()
    expect(replaced.historyId).not.toBe(history0)
    const stale = await app.inject({ method: 'POST', url: '/api/changes', headers: h, payload: { changes: [], historyId: history0 } })
    expect(stale.statusCode).toBe(409)
  })

  it('accepts versions beyond 32 bits (they are change-log seqs)', async () => {
    const res = await push(h, [{ collection: 'jobs', id: 'j-big', op: 'upsert', data: { id: 'j-big' }, baseVersion: 2 ** 40 }])
    expect(res.statusCode).toBe(200)
    expect(res.json().conflicts).toEqual([{ collection: 'jobs', id: 'j-big', serverVersion: null, serverData: null }])
    const unsafe = await push(h, [{ collection: 'jobs', id: 'j-big', op: 'upsert', data: { id: 'j-big' }, baseVersion: 2 ** 53 }])
    expect(unsafe.statusCode).toBe(400)
  })

  it('rejects unknown collections and malformed changes with 400', async () => {
    const cases: unknown[][] = [
      [{ collection: 'salaries', id: 'x', op: 'upsert', data: { id: 'x' }, baseVersion: null }],
      [{ collection: 'people; DROP TABLE people', id: 'x', op: 'delete', baseVersion: null }],
      [{ collection: '$doc', id: 'secrets', op: 'upsert', data: {}, baseVersion: null }],
      [{ collection: '$doc', id: 'company', op: 'delete', baseVersion: 1 }],
      [{ collection: 'people', id: 'p-1', op: 'upsert', data: { id: 'p-2' }, baseVersion: null }],
      [{ collection: 'people', id: 'p-1', op: 'upsert', data: [1], baseVersion: null }],
      [{ collection: 'people', id: 'p-1', op: 'replace', data: { id: 'p-1' }, baseVersion: null }],
      [{ collection: 'people', id: 'p-1', op: 'upsert', data: { id: 'p-1' }, baseVersion: '1' }],
      [{ collection: 'people', id: '', op: 'delete', baseVersion: null }],
    ]
    for (const changes of cases) {
      const res = await push(h, changes)
      expect(res.statusCode, JSON.stringify(changes)).toBe(400)
      expect(res.json().error).toBe('bad_request')
    }
    const tooMany = await push(h, Array.from({ length: 2001 }, (_, i) => ({ collection: 'jobs', id: `j-${i}`, op: 'delete', baseVersion: null })))
    expect(tooMany.statusCode).toBe(400)
    const notList = await app.inject({ method: 'POST', url: '/api/changes', headers: h, payload: { changes: 'nope' } })
    expect(notList.statusCode).toBe(400)
    // A rejected request changes nothing.
    expect((await db.query('SELECT 1 FROM change_log WHERE seq > $1', [seq0])).rows).toHaveLength(0)
  })

  it('rejects a record over 256 KB with 400', async () => {
    const res = await push(h, [{ collection: 'people', id: 'p-big', op: 'upsert', data: person('p-big', { notes: 'x'.repeat(260 * 1024) }), baseVersion: null }])
    expect(res.statusCode).toBe(400)
    expect(res.json().detail).toContain('256 KB')
    const ok = await push(h, [{ collection: 'people', id: 'p-fits', op: 'upsert', data: person('p-fits', { notes: 'x'.repeat(200 * 1024) }), baseVersion: null }])
    expect(ok.statusCode).toBe(200)
  })

  it('rejects text the database cannot store with 400', async () => {
    const res = await push(h, [{ collection: 'jobs', id: 'j-nul', op: 'upsert', data: { id: 'j-nul', title: 'a\u0000b' }, baseVersion: null }])
    expect(res.statusCode).toBe(400)
    const fine = await push(h, [{ collection: 'jobs', id: 'j-slash', op: 'upsert', data: { id: 'j-slash', title: 'a\\u0000b' }, baseVersion: null }])
    expect(fine.statusCode).toBe(200)
  })

  it('tells very old or foreign clients to resync', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/changes?since=0', headers: h })).json()).toEqual({ resync: true })
    expect((await app.inject({ method: 'GET', url: `/api/changes?since=${seq0 + 50}`, headers: h })).json()).toEqual({ resync: true })
    expect((await app.inject({ method: 'GET', url: '/api/changes?since=abc', headers: h })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/changes', headers: h })).statusCode).toBe(400)

    // Pruned history: rows older than 120 days are removed and clients from before them resync.
    await push(h, [{ collection: 'people', id: 'p-a', op: 'upsert', data: person('p-a'), baseVersion: null }])
    const mid = seq0 + 1
    await push(h, [{ collection: 'people', id: 'p-b', op: 'upsert', data: person('p-b'), baseVersion: null }])
    await db.query(`UPDATE change_log SET at = now() - interval '200 days' WHERE seq <= $1`, [mid])
    expect(await pruneChangeLog(db, 120)).toBeGreaterThan(0)
    expect((await app.inject({ method: 'GET', url: `/api/changes?since=${seq0}`, headers: h })).json()).toEqual({ resync: true })
    const recent = (await app.inject({ method: 'GET', url: `/api/changes?since=${mid}`, headers: h })).json()
    expect(recent.changes.map((c: { id: string }) => c.id)).toEqual(['p-b'])
  })

  it('makes clients from before a full replace resync', async () => {
    await push(h, [{ collection: 'people', id: 'p-a', op: 'upsert', data: person('p-a'), baseVersion: null }])
    const seqBefore = seq0 + 1
    const replaced = await upload(h, small(), true)
    expect((await app.inject({ method: 'GET', url: `/api/changes?since=${seqBefore}`, headers: h })).json()).toEqual({ resync: true })
    expect((await app.inject({ method: 'GET', url: `/api/changes?since=${replaced.json().seq}`, headers: h })).json()).toEqual({
      historyId: replaced.json().historyId,
      seq: replaced.json().seq,
      changes: [],
    })
  })
})

describe('serving the app', () => {
  it('serves APP_FILE at / with the app CSP, and nothing else from its folder', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ft-app-'))
    const appFile = path.join(dir, 'first-twenty.html')
    const html =
      '<!doctype html><title>First Twenty</title><script>window.ok=1</script>\n' +
      '<script type="module" crossorigin>\nconsole.log("</scr" + "ipt>")\n</script><script src="./x.js"></script>'
    writeFileSync(appFile, html)
    writeFileSync(path.join(dir, 'secret.txt'), 'do not serve')
    const served = await makeApp(db, { serveApp: true, appFile })
    const res = await served.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    // The file as it is, plus the served mark (the app registers the offline worker only with it).
    expect(res.body).toBe(html.replace('<!doctype html>', '<!doctype html><meta name="first-twenty-served" content="1">'))
    // Inline scripts are allowed by their hash only: no 'unsafe-inline' for scripts.
    const csp = String(res.headers['content-security-policy'])
    const sha = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`
    const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src '))!
    expect(scriptSrc).toBe(`script-src 'self' ${sha('window.ok=1')} ${sha('\nconsole.log("</scr" + "ipt>")\n')}`)
    expect(scriptSrc).not.toContain('unsafe-inline')
    expect(csp).toContain("script-src-attr 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect((await served.inject({ method: 'GET', url: '/index.html' })).headers['content-security-policy']).toBe(csp)
    expect(res.headers['cache-control']).toBe('no-cache')
    expect((await served.inject({ method: 'GET', url: '/secret.txt' })).statusCode).toBe(404)
    expect((await served.inject({ method: 'GET', url: '/../package.json' })).statusCode).toBe(404)
    const api = await served.inject({ method: 'GET', url: '/api/unknown' })
    expect(api.statusCode).toBe(404)
    expect(api.json()).toEqual({ error: 'not_found' })
    await served.close()
  })

  it('serves the offline worker with the served app only, under its own strict policy (r2-47)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ft-app-'))
    const appFile = path.join(dir, 'first-twenty.html')
    writeFileSync(appFile, '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <script>window.ok=1</script>\n  </head><body></body></html>')
    const served = await makeApp(db, { serveApp: true, appFile })
    const page = await served.inject({ method: 'GET', url: '/' })
    // The mark goes right after <head>, so the charset stays near the top.
    expect(page.body).toContain('<head><meta name="first-twenty-served" content="1">\n    <meta charset="UTF-8" />')
    // The page may start workers from this server only.
    expect(String(page.headers['content-security-policy'])).toContain("worker-src 'self'")
    const sw = await served.inject({ method: 'GET', url: '/sw.js' })
    expect(sw.statusCode).toBe(200)
    expect(sw.headers['content-type']).toBe('application/javascript; charset=utf-8')
    expect(sw.headers['cache-control']).toBe('no-cache')
    expect(sw.headers['content-security-policy']).toBe("default-src 'none'; connect-src 'self'")
    expect(sw.headers['x-content-type-options']).toBe('nosniff')
    expect(sw.body).toContain("addEventListener('fetch'")
    await served.close()
    // Without the served app there is no worker to register.
    expect((await app.inject({ method: 'GET', url: '/sw.js' })).statusCode).toBe(404)
  })
})
