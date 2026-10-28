// HTTP tests for the API server, in-memory PGlite + app.inject(): signing in, the session and device
// cookies, who is signed in, and signing out (docs/SYNC.md, Security rules).
import { describe, expect, it } from 'vitest'
import { LOGIN_BODY_LIMIT } from './app'
import { hashToken } from './auth'
import { app, db, rawCookie, useApp } from './test/api'
import { ADMIN, CSRF, deviceCookie, login, makeApp, sessionCookie } from './test/helpers'

useApp()

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
