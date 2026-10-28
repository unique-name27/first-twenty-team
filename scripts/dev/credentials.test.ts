import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CREDENTIALS_PATH, credentialsFile, credentialsMiddleware } from './credentials'
import { DEV_TOOLS_FILE } from './stack-lib.mjs'

// Invented values for a temporary file; never a real login.
const LOGIN = { email: 'dev@example.test', password: 'test-only-password-1234', stackId: 'stack-test' }

let dir: string
let file: string
let server: Server
let base: string

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'ft-dev-credentials-'))
  file = path.join(dir, 'credentials.json')
  const middleware = credentialsMiddleware(file)
  server = createServer((req, res) =>
    middleware(req, res, () => {
      res.statusCode = 418
      res.end('next')
    }),
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => rmSync(file, { force: true }))

const get = (headers: Record<string, string> = {}, url = CREDENTIALS_PATH, method = 'GET') =>
  fetch(`${base}${url}`, { method, headers: { 'X-First-Twenty': '1', ...headers } })

describe('GET /__dev/credentials', () => {
  it('answers 404 before npm run stack made a login', async () => {
    const res = await get({ 'Sec-Fetch-Site': 'same-origin' })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'not_found' })
  })

  it('answers the login as JSON, never cached', async () => {
    writeFileSync(file, JSON.stringify({ ...LOGIN, createdAt: '2026-10-27T00:00:00Z', note: 'x' }))
    const res = await get({ 'Sec-Fetch-Site': 'same-origin' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual(LOGIN)
  })

  it('answers the login only, never the dev tools secret kept beside it', async () => {
    writeFileSync(file, JSON.stringify(LOGIN))
    writeFileSync(path.join(dir, DEV_TOOLS_FILE), JSON.stringify({ secret: 'test-only-dev-tools-secret' }))
    const res = await get({ 'Sec-Fetch-Site': 'same-origin' })
    const body = await res.text()
    expect(JSON.parse(body)).toEqual(LOGIN)
    expect(body).not.toContain('test-only-dev-tools-secret')
  })

  it('accepts a same-origin Origin, including the public host a proxy names', async () => {
    writeFileSync(file, JSON.stringify(LOGIN))
    const host = new URL(base).host
    expect((await get({ Origin: base })).status).toBe(200)
    const forwarded = await get({ Origin: 'https://demo-abc-8826.app.github.dev', 'X-Forwarded-Host': 'demo-abc-8826.app.github.dev' })
    expect(forwarded.status).toBe(200)
    expect(host).not.toBe('demo-abc-8826.app.github.dev')
  })

  it('refuses cross-origin requests', async () => {
    writeFileSync(file, JSON.stringify(LOGIN))
    const refused: Record<string, string>[] = [
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Site': 'same-site' },
      { 'Sec-Fetch-Site': 'none' },
      { Origin: 'http://localhost:3000' },
      { Origin: 'null' },
    ]
    for (const headers of refused) {
      const res = await get(headers)
      expect(res.status, JSON.stringify(headers)).toBe(403)
      expect(await res.text()).not.toContain(LOGIN.password)
    }
  })

  it('wants the app header, which other pages cannot send without a preflight', async () => {
    writeFileSync(file, JSON.stringify(LOGIN))
    const res = await fetch(`${base}${CREDENTIALS_PATH}`, { headers: { 'Sec-Fetch-Site': 'same-origin' } })
    expect(res.status).toBe(403)
  })

  it('answers GET only, and leaves every other path to the next handler', async () => {
    writeFileSync(file, JSON.stringify(LOGIN))
    expect((await get({}, CREDENTIALS_PATH, 'POST')).status).toBe(405)
    expect((await get({}, '/__dev/credentials.json')).status).toBe(418)
    expect((await get({}, '/')).status).toBe(418)
  })

  it('treats a file that is not a login as missing', async () => {
    writeFileSync(file, '{"email": "dev@example.test"}')
    expect((await get()).status).toBe(404)
    writeFileSync(file, 'not json')
    expect((await get()).status).toBe(404)
  })
})

describe('credentialsFile', () => {
  it('reads FIRST_TWENTY_DEV_DIR (set for --offset), else .data/dev', () => {
    expect(credentialsFile('/repo', {})).toBe(path.resolve('/repo', '.data/dev', 'credentials.json'))
    expect(credentialsFile('/repo', { FIRST_TWENTY_DEV_DIR: '.data/dev-10' })).toBe(path.resolve('/repo', '.data/dev-10', 'credentials.json'))
  })
})
