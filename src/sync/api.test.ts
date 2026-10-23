import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DB } from '@/domain/types'
import { CSRF_HEADER, createApi, describeFailure, type FetchLike, httpUrl } from './api'

type Call = { url: string; init: RequestInit }

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fn: FetchLike = async (url, init = {}) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  return { fn, calls }
}

const json = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

const header = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name]

afterEach(() => {
  vi.useRealTimers()
})

describe('createApi', () => {
  it('sends same-origin JSON requests, with the CSRF header on everything but GET', async () => {
    const { fn, calls } = fakeFetch((url) => {
      if (url.endsWith('/api/changes')) return json(200, { seq: 3, applied: [], conflicts: [] })
      if (url.includes('/api/changes?')) return json(200, { seq: 3, changes: [] })
      return json(200, { seq: 1, versions: {} })
    })
    const api = createApi({ fetch: fn })
    await api.getChanges(0)
    await api.postChanges([{ collection: 'people', id: 'p-1', op: 'delete', baseVersion: 2 }])
    await api.putWorkspace({ schemaVersion: 1 } as DB)
    const [get, post, put] = calls
    expect(get.url).toBe('/api/changes?since=0')
    expect(get.init.method).toBe('GET')
    expect(get.init.credentials).toBe('same-origin')
    expect(header(get, CSRF_HEADER)).toBeUndefined()
    expect(get.init.body).toBeUndefined()
    expect(post.init.method).toBe('POST')
    expect(header(post, CSRF_HEADER)).toBe('1')
    expect(header(post, 'Content-Type')).toBe('application/json')
    expect(JSON.parse(post.init.body as string)).toEqual({ changes: [{ collection: 'people', id: 'p-1', op: 'delete', baseVersion: 2 }] })
    expect(post.init.keepalive).toBeUndefined()
    expect(put.init.method).toBe('PUT')
    expect(header(put, CSRF_HEADER)).toBe('1')
    expect(JSON.parse(put.init.body as string)).toEqual({ db: { schemaVersion: 1 } })
  })

  it('adds confirmReplace only when asked, and keepalive only for flushes', async () => {
    const { fn, calls } = fakeFetch((url) => (url.endsWith('/api/workspace') ? json(200, { seq: 1, versions: {} }) : json(200, { seq: 1, applied: [], conflicts: [] })))
    const api = createApi({ fetch: fn, baseUrl: 'https://hr.example.test/' })
    await api.putWorkspace({} as DB, true)
    await api.postChanges([], { keepalive: true })
    expect(calls[0].url).toBe('https://hr.example.test/api/workspace')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ db: {}, confirmReplace: true })
    expect(calls[1].init.keepalive).toBe(true)
  })

  it('maps network errors and timeouts to offline', async () => {
    const down = createApi({ fetch: fakeFetch(() => Promise.reject(new TypeError('Failed to fetch'))).fn })
    expect(await down.health()).toMatchObject({ ok: false, kind: 'offline', status: null })

    vi.useFakeTimers()
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    const slow = createApi({ fetch: hang, timeoutMs: 5000 })
    const pending = slow.getChanges(10)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await pending).toMatchObject({ ok: false, kind: 'offline' })
  })

  it('maps 401 to signed_out, except on login where it means wrong credentials', async () => {
    const api = createApi({ fetch: fakeFetch(() => json(401, { error: 'unauthorized' })).fn })
    expect(await api.me()).toMatchObject({ ok: false, kind: 'signed_out', status: 401 })
    expect(await api.getChanges(1)).toMatchObject({ ok: false, kind: 'signed_out' })
    expect(await api.login('a@example.test', 'x')).toMatchObject({ ok: false, kind: 'invalid_credentials', error: 'unauthorized' })
  })

  it('reports rate limits with the wait from the body or the Retry-After header', async () => {
    const body = createApi({ fetch: fakeFetch(() => json(429, { error: 'rate_limited', retryAfter: 120 })).fn })
    const r1 = await body.login('a@example.test', 'x')
    expect(r1).toMatchObject({ ok: false, kind: 'rate_limited', retryAfter: 120 })
    if (!r1.ok) expect(describeFailure(r1)).toBe('Too many sign-in attempts. Try again in 2 minutes.')
    const hdr = createApi({ fetch: fakeFetch(() => json(429, {}, { 'Retry-After': '30' })).fn })
    expect(await hdr.login('a@example.test', 'x')).toMatchObject({ kind: 'rate_limited', retryAfter: 30 })
  })

  it('maps the other statuses to specific kinds', async () => {
    const cases: Array<[Response, string]> = [
      [json(404, { error: 'empty' }), 'empty'],
      [json(404, { error: 'nope' }), 'not_found'],
      [json(409, { error: 'not_empty' }), 'not_empty'],
      [json(413, { error: 'too_large' }), 'too_large'],
      [json(403, { error: 'csrf' }), 'forbidden'],
      [json(400, { error: 'invalid_change' }), 'bad_request'],
      [json(500, { error: 'internal' }), 'server'],
      [json(503, { ok: false, db: 'down' }), 'server'],
      [new Response('<!doctype html><title>Vite</title>', { status: 200, headers: { 'Content-Type': 'text/html' } }), 'bad_response'],
      [json(200, { unexpected: true }), 'bad_response'],
    ]
    for (const [res, kind] of cases) {
      const api = createApi({ fetch: fakeFetch(() => res).fn })
      const r = await api.getWorkspace()
      expect(r, kind).toMatchObject({ ok: false, kind })
      if (!r.ok) expect(describeFailure(r)).not.toMatch(/—/)
    }
  })

  it('asks who is signed in with GET /api/auth/session: nobody is an answer, not a 401 (r2-48)', async () => {
    let signedIn = false
    const { fn, calls } = fakeFetch((url) => {
      if (url === '/api/auth/session') return json(200, { user: signedIn ? { id: 'u1', email: 'admin@example.test', role: 'admin' } : null })
      return json(500, {})
    })
    const api = createApi({ fetch: fn })
    expect(await api.session()).toEqual({ ok: true, status: 200, data: { user: null } })
    signedIn = true
    expect(await api.session()).toEqual({ ok: true, status: 200, data: { user: { id: 'u1', email: 'admin@example.test', role: 'admin' } } })
    expect(calls.map((c) => [c.url, c.init.method])).toEqual([
      ['/api/auth/session', 'GET'],
      ['/api/auth/session', 'GET'],
    ])
    const odd = createApi({ fetch: fakeFetch(() => json(200, { nobody: true })).fn })
    expect(await odd.session()).toMatchObject({ ok: false, kind: 'bad_response' })
    const down = createApi({ fetch: fakeFetch(() => Promise.reject(new TypeError('Failed to fetch'))).fn })
    expect(await down.session()).toMatchObject({ ok: false, kind: 'offline' })
  })

  it('falls back to /api/auth/me on a server from before /api/auth/session, and remembers', async () => {
    let signedIn = false
    const { fn, calls } = fakeFetch((url) => {
      if (url === '/api/auth/session') return json(404, { error: 'not_found' })
      return signedIn ? json(200, { user: { id: 'u1', email: 'admin@example.test', role: 'admin' } }) : json(401, { error: 'unauthorized' })
    })
    const api = createApi({ fetch: fn })
    expect(await api.session()).toEqual({ ok: true, status: 401, data: { user: null } })
    signedIn = true
    expect(await api.session()).toMatchObject({ ok: true, data: { user: { email: 'admin@example.test' } } })
    // The missing route is asked once per page.
    expect(calls.map((c) => c.url)).toEqual(['/api/auth/session', '/api/auth/me', '/api/auth/me'])
  })

  it('asks whether the server is empty with GET /api/workspace/status: empty is an answer, not a 404 (r3-06)', async () => {
    let empty = true
    const { fn, calls } = fakeFetch((url) => {
      if (url === '/api/workspace/status') return json(200, empty ? { empty: true } : { empty: false, workspaceId: 'default', historyId: 'h-1', seq: '42' })
      return json(500, {})
    })
    const api = createApi({ fetch: fn })
    expect(await api.workspaceStatus()).toEqual({ ok: true, status: 200, data: { empty: true } })
    empty = false
    expect(await api.workspaceStatus()).toEqual({ ok: true, status: 200, data: { empty: false, workspaceId: 'default', historyId: 'h-1', seq: 42 } })
    expect(calls.map((c) => [c.url, c.init.method])).toEqual([
      ['/api/workspace/status', 'GET'],
      ['/api/workspace/status', 'GET'],
    ])
    const signedOut = createApi({ fetch: fakeFetch(() => json(401, { error: 'unauthorized' })).fn })
    expect(await signedOut.workspaceStatus()).toMatchObject({ ok: false, kind: 'signed_out' })
    const odd = createApi({ fetch: fakeFetch(() => json(200, { empty: 'maybe' })).fn })
    expect(await odd.workspaceStatus()).toMatchObject({ ok: false, kind: 'bad_response' })
  })

  it('falls back to GET /api/workspace on a server from before the status route, and remembers', async () => {
    let hasWorkspace = false
    const snapshot = { workspaceId: 'default', historyId: 'h-2', seq: 7, db: { schemaVersion: 1 }, versions: {} }
    const { fn, calls } = fakeFetch((url) => {
      if (url === '/api/workspace/status') return json(404, { error: 'not_found' })
      if (url === '/api/workspace') return hasWorkspace ? json(200, snapshot) : json(404, { error: 'empty' })
      return json(500, {})
    })
    const api = createApi({ fetch: fn })
    expect(await api.workspaceStatus()).toEqual({ ok: true, status: 404, data: { empty: true } })
    hasWorkspace = true
    // The workspace it had to download comes along, so nobody fetches it twice.
    expect(await api.workspaceStatus()).toEqual({
      ok: true,
      status: 200,
      data: { empty: false, workspaceId: 'default', historyId: 'h-2', seq: 7, snapshot: { ...snapshot, db: { schemaVersion: 1 } } },
    })
    // Without the fallback (a cheap check on every page load) it says not_found and downloads nothing.
    expect(await api.workspaceStatus({ fallback: false })).toMatchObject({ ok: false, kind: 'not_found' })
    // The missing route is asked once per page.
    expect(calls.map((c) => c.url)).toEqual(['/api/workspace/status', '/api/workspace', '/api/workspace'])
    // Anything other than a missing route stays a failure.
    const down = createApi({ fetch: fakeFetch(() => json(503, { error: 'unavailable' })).fn })
    expect(await down.workspaceStatus()).toMatchObject({ ok: false, kind: 'server' })
  })

  it('reads the existing, byYou and landed flags of a push answer, and ignores anything else', async () => {
    const api = createApi({
      fetch: fakeFetch(() =>
        json(200, {
          seq: 9,
          applied: [
            { collection: 'activity', id: 'act-1', version: 4, existing: true },
            { collection: 'people', id: 'p-2', version: 9, existing: 'yes' },
          ],
          conflicts: [
            { collection: 'people', id: 'p-1', serverVersion: 8, serverData: { id: 'p-1' }, byYou: true, landed: true },
            { collection: 'jobs', id: 'j-1', serverVersion: null, serverData: null, byYou: 1 },
          ],
        }),
      ).fn,
    })
    expect(await api.postChanges([])).toEqual({
      ok: true,
      status: 200,
      data: {
        seq: 9,
        applied: [
          { collection: 'activity', id: 'act-1', version: 4, existing: true },
          { collection: 'people', id: 'p-2', version: 9 },
        ],
        conflicts: [
          { collection: 'people', id: 'p-1', serverVersion: 8, serverData: { id: 'p-1' }, byYou: true, landed: true },
          { collection: 'jobs', id: 'j-1', serverVersion: null, serverData: null },
        ],
      },
    })
  })

  it('parses health, login, me and logout', async () => {
    const { fn } = fakeFetch((url) => {
      if (url === '/api/health') return json(200, { ok: true, db: 'up', version: '0.1.0' })
      if (url === '/api/auth/logout') return new Response(null, { status: 204 })
      return json(200, { user: { id: 'u1', email: 'admin@example.test', role: 'admin' } })
    })
    const api = createApi({ fetch: fn })
    expect(await api.health()).toEqual({ ok: true, status: 200, data: { ok: true, db: 'up', version: '0.1.0' } })
    expect(await api.login('admin@example.test', 'x')).toMatchObject({ ok: true, data: { user: { id: 'u1', role: 'admin' } } })
    expect(await api.me()).toMatchObject({ ok: true, data: { user: { email: 'admin@example.test' } } })
    expect(await api.logout()).toEqual({ ok: true, status: 204, data: null })
  })

  it('sends remember with the sign-in, false unless asked', async () => {
    const { fn, calls } = fakeFetch(() => json(200, { user: { id: 'u1', email: 'admin@example.test', role: 'admin' } }))
    const api = createApi({ fetch: fn })
    await api.login('admin@example.test', 'x')
    await api.login('admin@example.test', 'x', { remember: true })
    await api.login('admin@example.test', 'x', { remember: false })
    expect(calls.map((c) => JSON.parse(c.init.body as string).remember)).toEqual([false, true, false])
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ email: 'admin@example.test', password: 'x', remember: true })
  })

  it('a 503 from health means the database is down', async () => {
    const api = createApi({ fetch: fakeFetch(() => json(503, { ok: false, db: 'down' })).fn })
    const r = await api.health()
    expect(r).toMatchObject({ ok: false, kind: 'server', status: 503 })
    if (!r.ok) expect(describeFailure(r)).toContain('database')
  })

  it('parses snapshots and change pages, accepting numeric strings and sorting by seq', async () => {
    const { fn } = fakeFetch((url) => {
      if (url === '/api/workspace') return json(200, { workspaceId: 'default', seq: '17', db: { schemaVersion: 1 }, versions: { 'people:p-1': '4' } })
      return json(200, {
        seq: '9',
        more: true,
        changes: [
          { seq: '9', collection: 'people', id: 'p-2', op: 'delete', version: 2 },
          { seq: 8, collection: 'people', id: 'p-1', op: 'upsert', version: 3, data: { id: 'p-1' } },
        ],
      })
    })
    const api = createApi({ fetch: fn })
    expect(await api.getWorkspace()).toMatchObject({ ok: true, data: { workspaceId: 'default', seq: 17, versions: { 'people:p-1': 4 } } })
    const page = await api.getChanges(7.9)
    expect(page).toEqual({
      ok: true,
      status: 200,
      data: {
        seq: 9,
        more: true,
        changes: [
          { seq: 8, collection: 'people', id: 'p-1', op: 'upsert', version: 3, data: { id: 'p-1' } },
          { seq: 9, collection: 'people', id: 'p-2', op: 'delete', version: 2 },
        ],
      },
    })
  })

  it('passes resync through and rejects malformed change pages', async () => {
    const resync = createApi({ fetch: fakeFetch(() => json(200, { resync: true })).fn })
    expect(await resync.getChanges(0)).toEqual({ ok: true, status: 200, data: { resync: true } })
    const bad = createApi({ fetch: fakeFetch(() => json(200, { seq: 1, changes: [{ seq: 1, collection: 'people', op: 'merge' }] })).fn })
    expect(await bad.getChanges(0)).toMatchObject({ ok: false, kind: 'bad_response' })
  })

  it('parses push results, including conflicts without server data', async () => {
    const { fn } = fakeFetch(() =>
      json(200, {
        seq: 12,
        applied: [{ collection: 'people', id: 'p-1', version: '5' }],
        conflicts: [
          { collection: 'people', id: 'p-2', serverVersion: 7, serverData: { id: 'p-2' } },
          { collection: 'people', id: 'p-3', serverVersion: null },
        ],
      }),
    )
    const api = createApi({ fetch: fn })
    expect(await api.postChanges([])).toEqual({
      ok: true,
      status: 200,
      data: {
        seq: 12,
        applied: [{ collection: 'people', id: 'p-1', version: 5 }],
        conflicts: [
          { collection: 'people', id: 'p-2', serverVersion: 7, serverData: { id: 'p-2' } },
          { collection: 'people', id: 'p-3', serverVersion: null, serverData: null },
        ],
      },
    })
  })

  it('sends and reads history ids, and maps a 409 resync', async () => {
    const { fn, calls } = fakeFetch((url, init) => {
      if (url.includes('/api/changes?')) return json(200, { historyId: 'h-2', seq: 3, changes: [] })
      if (url.endsWith('/api/changes') && init.method === 'POST') return json(409, { error: 'resync' })
      if (url.endsWith('/api/workspace') && init.method === 'PUT') return json(200, { historyId: 'h-3', seq: 1, versions: {} })
      return json(200, { workspaceId: 'default', historyId: 'h-1', seq: 1, db: {}, versions: {} })
    })
    const api = createApi({ fetch: fn })
    const page = await api.getChanges(2, 'h-1')
    expect(calls[0].url).toBe('/api/changes?since=2&history=h-1')
    expect(page).toMatchObject({ ok: true, data: { historyId: 'h-2', seq: 3 } })
    const push = await api.postChanges([{ collection: 'people', id: 'p-1', op: 'delete', baseVersion: 2 }], { historyId: 'h-1' })
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ changes: [{ collection: 'people', id: 'p-1', op: 'delete', baseVersion: 2 }], historyId: 'h-1' })
    expect(push).toMatchObject({ ok: false, kind: 'resync', status: 409 })
    if (!push.ok) expect(describeFailure(push)).toMatch(/replaced or restored/)
    expect(await api.putWorkspace({ schemaVersion: 1 } as DB, true)).toMatchObject({ ok: true, data: { historyId: 'h-3' } })
    expect(await api.getWorkspace()).toMatchObject({ ok: true, data: { historyId: 'h-1' } })
    // No history id known: none sent.
    await api.getChanges(0, null)
    expect(calls.at(-1)?.url).toBe('/api/changes?since=0')
  })
})

describe('demo server routes (sign-up, invites, the login\'s company)', () => {
  const user = { id: 'u2', email: 'sam@example.test', role: 'admin' }
  const workspace = { id: 'ws-1', name: 'Acme Robots', slug: 'acme-robots' }

  it('signs up with POST /api/auth/signup: JSON with the CSRF header, remember false unless asked', async () => {
    const { fn, calls } = fakeFetch(() => json(201, { user, workspace }))
    const api = createApi({ fetch: fn })
    expect(await api.signup({ email: 'sam@example.test', password: 'twelve chars!', companyName: 'Acme Robots' })).toEqual({
      ok: true,
      status: 201,
      data: { user, workspace },
    })
    await api.signup({ email: 'sam@example.test', password: 'twelve chars!', companyName: 'Acme Robots', remember: true })
    expect(calls[0].url).toBe('/api/auth/signup')
    expect(calls[0].init.method).toBe('POST')
    expect(header(calls[0], CSRF_HEADER)).toBe('1')
    // No honeypot field: the app never fills it, so it never sends it.
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ email: 'sam@example.test', password: 'twelve chars!', companyName: 'Acme Robots', remember: false })
    expect(JSON.parse(calls[1].init.body as string).remember).toBe(true)
  })

  it('maps the sign-up refusals: closed, email taken, demo full, rate limited', async () => {
    const cases: Array<[Response, string]> = [
      [json(404, { error: 'not_found' }), 'not_found'],
      [json(409, { error: 'email_taken' }), 'email_taken'],
      [json(503, { error: 'demo_full' }), 'demo_full'],
      [json(503, { error: 'db_down' }), 'server'],
      [json(429, { error: 'rate_limited', retryAfter: 600 }), 'rate_limited'],
      [json(400, { error: 'invalid_company' }), 'bad_request'],
      // A 409 that is not about the email is still the workspace's answer.
      [json(409, { error: 'not_empty' }), 'not_empty'],
    ]
    for (const [res, kind] of cases) {
      const api = createApi({ fetch: fakeFetch(() => res.clone()).fn })
      const r = await api.signup({ email: 'a@example.test', password: 'x'.repeat(12), companyName: 'Acme' })
      expect(r, kind).toMatchObject({ ok: false, kind })
      if (!r.ok) expect(describeFailure(r)).not.toMatch(/—/)
    }
    expect(describeFailure({ kind: 'email_taken', status: 409, error: 'email_taken' })).toMatch(/already has a login/)
    expect(describeFailure({ kind: 'demo_full', status: 503, error: 'demo_full' })).toMatch(/Try again later/)
  })

  it('reads the sign-up mode: open only when the server says so, closed on a server from before it', async () => {
    const mode = (res: Response) => createApi({ fetch: fakeFetch(() => res).fn }).signupMode()
    expect(await mode(json(200, { signupMode: 'open', demoExpireDays: 30 }))).toEqual({ ok: true, status: 200, data: { signupMode: 'open', demoExpireDays: 30 } })
    expect(await mode(json(200, { signupMode: 'open' }))).toEqual({ ok: true, status: 200, data: { signupMode: 'open' } })
    expect(await mode(json(200, { signupMode: 'closed' }))).toMatchObject({ ok: true, data: { signupMode: 'closed' } })
    // Anything unclear is closed, and an expiry that is not a whole number of days is left out.
    expect(await mode(json(200, { signupMode: 'OPEN', demoExpireDays: -3 }))).toEqual({ ok: true, status: 200, data: { signupMode: 'closed' } })
    expect(await mode(json(200, { signupMode: 'open', demoExpireDays: 1.5 }))).toEqual({ ok: true, status: 200, data: { signupMode: 'open' } })
    expect(await mode(json(404, { error: 'not_found' }))).toEqual({ ok: true, status: 404, data: { signupMode: 'closed' } })
    expect(await mode(json(500, {}))).toMatchObject({ ok: false, kind: 'server' })
    const { fn, calls } = fakeFetch(() => json(200, { signupMode: 'closed' }))
    await createApi({ fetch: fn }).signupMode()
    expect(calls.map((c) => [c.url, c.init.method, header(c, CSRF_HEADER)])).toEqual([['/api/auth/signup-mode', 'GET', undefined]])
  })

  it('reads the company, careers page and sign-up mode from /api/auth/me, and only http(s) careers links', async () => {
    const me = (body: unknown) => createApi({ fetch: fakeFetch(() => json(200, body)).fn }).me()
    expect(await me({ user, workspace, careersUrl: 'https://careers.example.test/acme-robots/', signupMode: 'open' })).toEqual({
      ok: true,
      status: 200,
      data: { user, workspace, careersUrl: 'https://careers.example.test/acme-robots/', signupMode: 'open' },
    })
    expect(await me({ user, workspace, careersUrl: null })).toEqual({ ok: true, status: 200, data: { user, workspace, careersUrl: null } })
    // A server from before companies sends the user only.
    expect(await me({ user })).toEqual({ ok: true, status: 200, data: { user } })
    // A careers link the app would put in an href must be http(s): anything else becomes "no careers page".
    expect(await me({ user, workspace, careersUrl: 'javascript:alert(1)' })).toMatchObject({ ok: true, data: { careersUrl: null } })
    expect(await me({ user, workspace, careersUrl: '/acme/' })).toMatchObject({ ok: true, data: { careersUrl: null } })
    // A company without a slug still names itself; one without a name is ignored.
    expect(await me({ user, workspace: { id: 'ws-1', name: 'Acme' } })).toMatchObject({ ok: true, data: { workspace: { id: 'ws-1', name: 'Acme', slug: '' } } })
    expect(await me({ user, workspace: { id: 'ws-1' } })).toEqual({ ok: true, status: 200, data: { user } })
  })

  it('creates an invite with an empty POST and keeps only an http(s) link', async () => {
    const { fn, calls } = fakeFetch(() => json(201, { url: 'https://hr.example.test/#invite.abcdefghijklmnopqrstuv', expiresAt: '2026-10-17T17:00:00.000Z' }))
    const api = createApi({ fetch: fn })
    expect(await api.createInvite()).toEqual({
      ok: true,
      status: 201,
      data: { url: 'https://hr.example.test/#invite.abcdefghijklmnopqrstuv', expiresAt: '2026-10-17T17:00:00.000Z' },
    })
    expect(calls[0].url).toBe('/api/invites')
    expect(calls[0].init.method).toBe('POST')
    expect(header(calls[0], CSRF_HEADER)).toBe('1')
    // No body and no JSON content type: Fastify refuses an empty JSON body.
    expect(calls[0].init.body).toBeUndefined()
    expect(header(calls[0], 'Content-Type')).toBeUndefined()
    const odd = createApi({ fetch: fakeFetch(() => json(201, { url: 'javascript:alert(1)', expiresAt: 'soon' })).fn })
    expect(await odd.createInvite()).toMatchObject({ ok: false, kind: 'bad_response' })
    const notAdmin = createApi({ fetch: fakeFetch(() => json(403, { error: 'forbidden' })).fn })
    expect(await notAdmin.createInvite()).toMatchObject({ ok: false, kind: 'forbidden' })
  })

  it('looks at an invite with its token in a body, never in the address (proxies log addresses), and accepts it with JSON', async () => {
    const { fn, calls } = fakeFetch((url) => {
      if (url === '/api/invites/lookup') return json(200, { companyName: 'Acme Robots' })
      return json(201, { user, workspace })
    })
    const api = createApi({ fetch: fn })
    expect(await api.inviteInfo('abc_DEF-123/x')).toEqual({ ok: true, status: 200, data: { companyName: 'Acme Robots' } })
    expect(calls[0].url).toBe('/api/invites/lookup')
    expect(calls[0].url).not.toContain('abc_DEF')
    expect(calls[0].init.method).toBe('POST')
    expect(header(calls[0], CSRF_HEADER)).toBe('1')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ token: 'abc_DEF-123/x' })
    expect(await api.acceptInvite({ token: 'tok', email: 'kim@example.test', password: 'twelve chars!' })).toEqual({ ok: true, status: 201, data: { user, workspace } })
    expect(calls[1].url).toBe('/api/auth/accept-invite')
    expect(header(calls[1], CSRF_HEADER)).toBe('1')
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ token: 'tok', email: 'kim@example.test', password: 'twelve chars!', remember: false })
    // A server that leaves the company out of the answer still signs the login in.
    const bare = createApi({ fetch: fakeFetch(() => json(201, { user })).fn })
    expect(await bare.acceptInvite({ token: 'tok', email: 'kim@example.test', password: 'x' })).toEqual({ ok: true, status: 201, data: { user, workspace: null } })
    const used = createApi({ fetch: fakeFetch(() => json(404, { error: 'not_found' })).fn })
    expect(await used.inviteInfo('tok')).toMatchObject({ ok: false, kind: 'not_found' })
    expect(await used.acceptInvite({ token: 'tok', email: 'kim@example.test', password: 'x' })).toMatchObject({ ok: false, kind: 'not_found' })
    const taken = createApi({ fetch: fakeFetch(() => json(409, { error: 'email_taken' })).fn })
    expect(await taken.acceptInvite({ token: 'tok', email: 'kim@example.test', password: 'x' })).toMatchObject({ ok: false, kind: 'email_taken' })
  })

  it('lists open invites, revokes one with DELETE, and switches the careers page', async () => {
    const { fn, calls } = fakeFetch((url, init) => {
      if (url === '/api/invites' && init.method === 'GET') {
        return json(200, { invites: [{ id: 'i-1', createdAt: '2026-10-10T17:00:00.000Z', expiresAt: '2026-10-17T17:00:00.000Z', createdBy: 'sam@example.test' }, { nope: true }] })
      }
      if (url.startsWith('/api/invites/')) return new Response(null, { status: 204 })
      return json(200, { careersUrl: 'https://careers.example.test/acme-k7m2qx/', careersEnabled: false })
    })
    const api = createApi({ fetch: fn })
    expect(await api.listInvites()).toEqual({
      ok: true,
      status: 200,
      data: [{ id: 'i-1', createdAt: '2026-10-10T17:00:00.000Z', expiresAt: '2026-10-17T17:00:00.000Z', createdBy: 'sam@example.test' }],
    })
    expect(await api.revokeInvite('i 1/x')).toEqual({ ok: true, status: 204, data: null })
    expect([calls[1].url, calls[1].init.method, header(calls[1], CSRF_HEADER)]).toEqual(['/api/invites/i%201%2Fx', 'DELETE', '1'])
    expect(await api.setCareers(false)).toEqual({ ok: true, status: 200, data: { careersUrl: 'https://careers.example.test/acme-k7m2qx/', careersEnabled: false } })
    expect([calls[2].url, calls[2].init.method, JSON.parse(calls[2].init.body as string)]).toEqual(['/api/workspace/careers', 'PUT', { enabled: false }])
    const gone = createApi({ fetch: fakeFetch(() => json(404, { error: 'not_found' })).fn })
    expect(await gone.revokeInvite('i-1')).toMatchObject({ ok: false, kind: 'not_found' })
  })

  it('reads the company from a sign-in and a session check, and the workspace an upload went to', async () => {
    const login = (body: unknown) => createApi({ fetch: fakeFetch(() => json(200, body)).fn }).login('a@b.c', 'pw')
    expect(await login({ user, workspace })).toEqual({ ok: true, status: 200, data: { user, workspace } })
    // A server from before companies sends the user only.
    expect(await login({ user })).toEqual({ ok: true, status: 200, data: { user } })
    const session = (body: unknown) => createApi({ fetch: fakeFetch(() => json(200, body)).fn }).session()
    expect(await session({ user, workspace })).toEqual({ ok: true, status: 200, data: { user, workspace } })
    expect(await session({ user: null })).toEqual({ ok: true, status: 200, data: { user: null } })
    const put = (body: unknown) => createApi({ fetch: fakeFetch(() => json(200, body)).fn }).putWorkspace({} as never)
    expect(await put({ workspaceId: 'w-1', historyId: 'h', seq: 3, versions: {} })).toEqual({ ok: true, status: 200, data: { workspaceId: 'w-1', historyId: 'h', seq: 3, versions: {} } })
    expect(await put({ seq: 3, versions: {} })).toEqual({ ok: true, status: 200, data: { seq: 3, versions: {} } })
  })

  it('names the demo limits plainly: writing too fast, and a full demo company', () => {
    expect(describeFailure({ kind: 'rate_limited', status: 429, error: 'write_limit', retryAfter: 90 })).toMatch(/faster than the demo server allows.*within 2 minutes/)
    expect(describeFailure({ kind: 'rate_limited', status: 429, error: 'rate_limited', retryAfter: 90 })).toMatch(/sign-in attempts/)
    expect(describeFailure({ kind: 'too_large', status: 413, error: 'workspace_full' })).toMatch(/as full as the demo server allows/)
    expect(describeFailure({ kind: 'too_large', status: 413, error: 'too_large' })).toMatch(/larger than the server accepts/)
  })

  it('httpUrl keeps absolute http(s) addresses only', () => {
    expect(httpUrl('https://careers.example.test/acme/')).toBe('https://careers.example.test/acme/')
    expect(httpUrl('http://localhost:8826/#invite.x')).toBe('http://localhost:8826/#invite.x')
    expect(httpUrl('javascript:alert(1)')).toBeNull()
    expect(httpUrl('data:text/html,hi')).toBeNull()
    expect(httpUrl('/relative')).toBeNull()
    expect(httpUrl(42)).toBeNull()
    expect(httpUrl(`https://example.test/${'a'.repeat(3000)}`)).toBeNull()
  })
})
