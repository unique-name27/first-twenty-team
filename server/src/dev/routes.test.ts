// POST /__dev/sql (development only): answers on a loopback socket with the stack's secret and nothing
// else, refuses before reading the body, and passes refusals and database errors back in plain words.
import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app'
import { testConfig } from '../config'
import type { Db } from '../db'
import { createAdmin, CSRF, login, makeTestDb } from '../test/helpers'
import { bearerMatches, DEV_SQL_BODY_LIMIT, DEV_SQL_PATH, isLoopbackAddress, parseSqlRequest, registerDevRoutes } from './routes'

// An invented secret for this test only (the stack makes a random one each run).
const SECRET = 'test-only-dev-tools-secret-0123456789abcdef'
const AUTH = { authorization: `Bearer ${SECRET}` }

let db: Db
let app: FastifyInstance

beforeAll(async () => {
  db = await makeTestDb()
  await createAdmin(db)
  app = await buildApp({ db, config: testConfig({ devTools: true }), logger: false })
  await registerDevRoutes(app, { db, secret: SECRET })
  await app.ready()
})
afterAll(async () => {
  await app.close()
  await db.close()
})

const ask = (payload: unknown, headers: Record<string, string> = AUTH, remoteAddress = '127.0.0.1') =>
  app.inject({ method: 'POST', url: DEV_SQL_PATH, headers, payload: payload as Record<string, unknown>, remoteAddress })

describe('POST /__dev/sql: who it answers', () => {
  it('answers a loopback request with the secret', async () => {
    const res = await ask({ sql: "SELECT id, name FROM workspaces WHERE id = $1", params: ['default'] })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ columns: [{ name: 'id', typeId: 25 }, { name: 'name', typeId: 25 }], rows: [['default', 'Default workspace']], truncated: false })
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('answers 404, as for a path that does not exist, without the right secret', async () => {
    const notFound = (await app.inject({ method: 'POST', url: '/__dev/nothing-here' })).json()
    const wrong: Record<string, string>[] = [
      {},
      { authorization: 'Bearer wrong-secret-of-the-same-sort-0123456789abc' },
      { authorization: SECRET },
      { authorization: `Bearer ${SECRET} ` },
      { authorization: `Basic ${SECRET}` },
      { authorization: `Bearer ${SECRET}x` },
    ]
    for (const headers of wrong) {
      const res = await ask({ sql: 'SELECT 1 AS one' }, headers)
      expect(res.statusCode, JSON.stringify(headers)).toBe(404)
      expect(res.json()).toEqual(notFound)
    }
  })

  it('answers 404 to a request from another computer, even with the secret', async () => {
    for (const address of ['10.0.0.5', '192.168.1.20', '::ffff:10.0.0.5', '2001:db8::1']) {
      expect((await ask({ sql: 'SELECT 1 AS one' }, AUTH, address)).statusCode, address).toBe(404)
    }
    // A proxy's X-Forwarded-For never makes a request local.
    expect((await ask({ sql: 'SELECT 1 AS one' }, { ...AUTH, 'x-forwarded-for': '127.0.0.1' }, '10.0.0.5')).statusCode).toBe(404)
    expect((await ask({ sql: 'SELECT 1 AS one' }, AUTH, '::1')).statusCode).toBe(200)
  })

  it('never answers a signed-in session: the secret is the only key', async () => {
    const cookie = await login(app)
    const res = await app.inject({ method: 'POST', url: DEV_SQL_PATH, headers: { ...CSRF, cookie }, payload: { sql: 'SELECT 1 AS one' } })
    expect(res.statusCode).toBe(404)
  })

  it('refuses before reading the body: a request without the secret gets 404 even when its body is too large', async () => {
    const big = { sql: `SELECT '${'x'.repeat(DEV_SQL_BODY_LIMIT)}'` }
    expect((await ask(big, {})).statusCode).toBe(404)
    expect((await ask(big)).statusCode).toBe(413)
  })

  it('answers POST only', async () => {
    expect((await app.inject({ method: 'GET', url: DEV_SQL_PATH, headers: AUTH })).statusCode).toBe(404)
  })

  it('will not start with a short secret', async () => {
    const other = await buildApp({ db, config: testConfig(), logger: false })
    await expect(registerDevRoutes(other, { db, secret: 'short' })).rejects.toThrow(/at least 32 characters/)
    await other.close()
  })
})

describe('POST /__dev/sql: answers', () => {
  it('passes refusals back as 400 refused, in plain words', async () => {
    for (const sql of ['COMMIT', 'ROLLBACK', 'SET TRANSACTION READ WRITE', 'BEGIN', 'SELECT 1; SELECT 2', 'DELETE FROM workspaces']) {
      const res = await ask({ sql })
      expect(res.statusCode, sql).toBe(400)
      expect(res.json().error).toBe('refused')
      expect(res.json().detail).toMatch(/refuse|one statement at a time/)
    }
    expect((await db.query('SELECT count(*)::int AS n FROM workspaces')).rows).toEqual([{ n: 1 }])
  })

  it("passes the database's error back as 400 sql_error, with its code and position", async () => {
    const res = await ask({ sql: 'SELECT nope FROM workspaces' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'sql_error', detail: 'column "nope" does not exist', code: '42703', position: 8 })
  })

  it('refuses a malformed body', async () => {
    for (const payload of [{}, { sql: 7 }, { sql: 'SELECT $1::text', params: 'x' }, { sql: 'SELECT $1::text', params: [{ a: 1 }] }, { sql: 'SELECT 1', today: 20261009 }]) {
      const res = await ask(payload)
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
      expect(res.json().error).toBe('refused')
    }
  })
})

describe('the checks', () => {
  it('knows loopback addresses', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '::FFFF:127.0.0.1']) expect(isLoopbackAddress(a), a).toBe(true)
    for (const a of [undefined, '', '10.0.0.1', '0.0.0.0', '::', '::ffff:10.0.0.1', '128.0.0.1', '127.0.0.1.example.com', 'fe80::1']) expect(isLoopbackAddress(a), String(a)).toBe(false)
  })

  it('compares the secret in full', () => {
    const expected = createHash('sha256').update(SECRET).digest()
    expect(bearerMatches(`Bearer ${SECRET}`, expected)).toBe(true)
    for (const h of [undefined, '', 'Bearer ', `Bearer ${SECRET.slice(0, -1)}`, `bearer ${SECRET}`, `Bearer  ${SECRET}`]) expect(bearerMatches(h, expected), String(h)).toBe(false)
  })

  it('reads a request body', () => {
    expect(parseSqlRequest({ sql: 'SELECT $1::text', params: ['a'], today: '2026-10-09' })).toEqual({ sql: 'SELECT $1::text', params: ['a'], today: '2026-10-09' })
    expect(parseSqlRequest({ sql: 'SELECT 1' })).toEqual({ sql: 'SELECT 1', params: [] })
  })
})
