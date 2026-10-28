// HTTP tests for the API server (docs/SYNC.md, Protocol), in-memory PGlite + app.inject(): health and
// headers, the CSRF guard and serving the app. The rest is by theme: app.login.test.ts (signing in,
// cookies and sessions), app.limits.test.ts (wrong passwords, rate limits, trusted devices and the
// password-check gate) and app.sync.test.ts (the workspace and changes).
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { connect } from 'node:net'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildApp, REQUEST_TIMEOUT_MS } from './app'
import { testConfig } from './config'
import type { Db } from './db'
import { ConfigError } from './errors'
import { migrationFiles } from './migrate'
import { app, db, small, useApp } from './test/api'
import { ADMIN, CSRF, login, makeApp, makeTestDb, sessionCookie } from './test/helpers'

useApp()

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
