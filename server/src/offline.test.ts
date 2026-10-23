// The offline worker and the served mark (offline.ts). The worker's script runs here in a plain context
// with stand-ins for the browser's service worker globals (self, caches, fetch).
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { markServed, SERVICE_WORKER_JS } from './offline'

const ORIGIN = 'https://hr.example.test'

type FakeRequest = { url: string; mode: string; method: string }
type Network = (request: FakeRequest | string) => Promise<Response>

/**
 * Loads the worker with a network and an empty cache; returns its listeners and what it stored.
 * `brokenCache` makes every Cache Storage call reject, as Chrome does when its store is damaged or full.
 */
function loadWorker(network: Network, brokenCache = false) {
  const listeners = new Map<string, (event: unknown) => void>()
  const stored = new Map<string, Response>()
  const cache = {
    add: async (url: string) => {
      const res = await network(new URL(url, ORIGIN).href)
      if (!res.ok) throw new TypeError('bad response')
      stored.set(url, res)
    },
    put: async (key: string, res: Response) => {
      stored.set(key, res)
    },
    match: async (key: string) => stored.get(key)?.clone(),
  }
  const broken = () => Promise.reject(new Error('UnknownError: Failed to execute open on CacheStorage'))
  const caches = {
    open: vi.fn(async () => (brokenCache ? broken() : cache)),
    keys: async () => (brokenCache ? broken() : ['first-twenty-app-v0', 'first-twenty-app-v1', 'someone-else']),
    delete: vi.fn(async () => true),
  }
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(async () => undefined) },
  }
  runInNewContext(SERVICE_WORKER_JS, { self, caches, fetch: network, URL, Promise })
  return { listeners, stored, caches, self }
}

/** Dispatches a fetch event; `answer` is what the worker responded with (undefined: it let it through). */
async function dispatch(w: ReturnType<typeof loadWorker>, url: string, mode = 'navigate', method = 'GET') {
  let responded: Promise<Response> | undefined
  const waits: Array<Promise<unknown>> = []
  w.listeners.get('fetch')!({ request: { url, mode, method }, respondWith: (p: Promise<Response>) => (responded = p), waitUntil: (p: Promise<unknown>) => waits.push(p) })
  const answer = responded ? await responded : undefined
  await Promise.all(waits)
  return answer
}

const page = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } })

describe('the offline worker', () => {
  it('goes to the network first for the app page and keeps each good answer', async () => {
    let version = 1
    const network = vi.fn<Network>(async () => page(`app v${version}`))
    const w = loadWorker(network)
    expect(await (await dispatch(w, `${ORIGIN}/`))!.text()).toBe('app v1')
    version = 2
    expect(await (await dispatch(w, `${ORIGIN}/index.html?from=bookmark`))!.text()).toBe('app v2')
    expect(await w.stored.get('/')!.clone().text()).toBe('app v2')
  })

  it('opens the kept page when the server cannot be reached or answers with a server error', async () => {
    let answer: () => Promise<Response> = async () => page('kept app')
    const w = loadWorker(() => answer())
    await dispatch(w, `${ORIGIN}/`)
    answer = () => Promise.reject(new TypeError('Failed to fetch'))
    expect(await (await dispatch(w, `${ORIGIN}/`))!.text()).toBe('kept app')
    // Caddy answers 502 while the First Twenty server is stopped.
    answer = async () => page('Bad gateway', 502)
    expect(await (await dispatch(w, `${ORIGIN}/`))!.text()).toBe('kept app')
    // Anything else the server says goes through as it is.
    answer = async () => page('Not here', 404)
    expect((await dispatch(w, `${ORIGIN}/`))!.status).toBe(404)
  })

  it('without a kept page, a failure stays a failure', async () => {
    const w = loadWorker(() => Promise.reject(new TypeError('Failed to fetch')))
    await expect(dispatch(w, `${ORIGIN}/`)).rejects.toThrow('Failed to fetch')
    const down = loadWorker(async () => page('Bad gateway', 502))
    expect((await dispatch(down, `${ORIGIN}/`))!.status).toBe(502)
  })

  it('never touches /api, other files, other sites or anything but page loads', async () => {
    const network = vi.fn<Network>(async () => page('x'))
    const w = loadWorker(network)
    expect(await dispatch(w, `${ORIGIN}/api/changes?since=1`, 'cors')).toBeUndefined()
    expect(await dispatch(w, `${ORIGIN}/api/auth/session`, 'navigate')).toBeUndefined()
    expect(await dispatch(w, `${ORIGIN}/sw.js`, 'same-origin')).toBeUndefined()
    expect(await dispatch(w, `${ORIGIN}/`, 'navigate', 'POST')).toBeUndefined()
    expect(await dispatch(w, 'https://elsewhere.example.test/', 'navigate')).toBeUndefined()
    expect(network).not.toHaveBeenCalled()
  })

  it('keeps a first copy when it installs, and an install that cannot fetch still succeeds', async () => {
    const w = loadWorker(async () => page('first copy'))
    const waits: Array<Promise<unknown>> = []
    w.listeners.get('install')!({ waitUntil: (p: Promise<unknown>) => waits.push(p) })
    await Promise.all(waits)
    expect(w.self.skipWaiting).toHaveBeenCalled()
    expect(await w.stored.get('/')!.clone().text()).toBe('first copy')
    const down = loadWorker(() => Promise.reject(new TypeError('Failed to fetch')))
    const downWaits: Array<Promise<unknown>> = []
    down.listeners.get('install')!({ waitUntil: (p: Promise<unknown>) => downWaits.push(p) })
    await expect(Promise.all(downWaits)).resolves.toBeDefined()
    expect(down.stored.size).toBe(0)
  })

  it('opens the page from the network when Cache Storage fails, and keeps nothing', async () => {
    const w = loadWorker(async () => page('app from the network'), true)
    const answer = await dispatch(w, `${ORIGIN}/`)
    expect(answer!.status).toBe(200)
    expect(await answer!.text()).toBe('app from the network')
    expect(w.stored.size).toBe(0)
  })

  it('when the network and Cache Storage both fail, the network error stands', async () => {
    const w = loadWorker(() => Promise.reject(new TypeError('Failed to fetch')), true)
    await expect(dispatch(w, `${ORIGIN}/`)).rejects.toThrow('Failed to fetch')
  })

  it('a server error with a failing Cache Storage goes through as it is', async () => {
    const w = loadWorker(async () => page('Bad gateway', 502), true)
    const answer = await dispatch(w, `${ORIGIN}/`)
    expect(answer!.status).toBe(502)
    expect(await answer!.text()).toBe('Bad gateway')
  })

  it('activation still takes over open pages when Cache Storage fails', async () => {
    const w = loadWorker(async () => page('x'), true)
    const waits: Array<Promise<unknown>> = []
    w.listeners.get('activate')!({ waitUntil: (p: Promise<unknown>) => waits.push(p) })
    await expect(Promise.all(waits)).resolves.toBeDefined()
    expect(w.self.clients.claim).toHaveBeenCalled()
  })

  it('on activation, drops its own older caches only and takes over open pages', async () => {
    const w = loadWorker(async () => page('x'))
    const waits: Array<Promise<unknown>> = []
    w.listeners.get('activate')!({ waitUntil: (p: Promise<unknown>) => waits.push(p) })
    await Promise.all(waits)
    expect(w.caches.delete.mock.calls).toEqual([['first-twenty-app-v0']])
    expect(w.self.clients.claim).toHaveBeenCalled()
  })
})

describe('the served mark', () => {
  const MARK = '<meta name="first-twenty-served" content="1">'

  it('goes right after the head tag', () => {
    expect(markServed('<!doctype html><html><head><meta charset="utf-8"><title>x</title></head></html>')).toBe(
      `<!doctype html><html><head>${MARK}<meta charset="utf-8"><title>x</title></head></html>`,
    )
    expect(markServed('<!DOCTYPE html><HEAD lang="en"><script></script>')).toBe(`<!DOCTYPE html><HEAD lang="en">${MARK}<script></script>`)
  })

  it('goes after the doctype (or first) when there is no head tag before the scripts', () => {
    expect(markServed('<!doctype html><title>x</title>')).toBe(`<!doctype html>${MARK}<title>x</title>`)
    expect(markServed('<title>x</title>')).toBe(`${MARK}<title>x</title>`)
  })

  it('never lands inside a script that holds a head tag in a string', () => {
    const html = '<!doctype html><title>x</title><script>const doc = "<html><head></head>"</script>'
    expect(markServed(html)).toBe(`<!doctype html>${MARK}<title>x</title><script>const doc = "<html><head></head>"</script>`)
  })
})
