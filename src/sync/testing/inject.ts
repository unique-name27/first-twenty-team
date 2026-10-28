// fetch() over Fastify's app.inject(), so a browser's sync engine can talk to the real API server
// (server/src/app.ts) in a test with no network: one cookie jar per browser, and a wire the test can cut or
// make lose answers. Used by the round trip tests here and the journey tests (server/src/e2e). Test-only:
// guard.test.ts keeps it out of the app.
import type { FetchLike } from '../api'

/** What injectFetch reads from an app.inject() answer (Fastify's LightMyRequest response has all of it). */
export type InjectResponse = { statusCode: number; body: string; headers: Record<string, unknown>; cookies: Array<{ name: string; value: string }> }

/**
 * The part of a Fastify app injectFetch drives. Spelled out here so code under src never imports the
 * server: a FastifyInstance fits it.
 */
export type InjectApp = {
  inject(opts: { method: string; url: string; headers: Record<string, string>; payload?: string; remoteAddress?: string }): Promise<InjectResponse>
  close(): Promise<void>
}

/**
 * What a test can do to one browser's network: lose the answers to POST /api/changes after the server
 * committed, or cut it off (down: every request fails as if offline).
 */
export type Wire = { losePushAnswers: number; down?: boolean }

/** fetch() over app.inject(), with one cookie jar per browser. `app` is read on every request, so a test can restart the server. */
export function injectFetch(app: () => InjectApp, wire: Wire = { losePushAnswers: 0 }): FetchLike {
  let cookie: string | null = null
  return async (url, init = {}) => {
    if (wire.down) throw new TypeError('Failed to fetch')
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) }
    if (cookie) headers.cookie = cookie
    const res = await app().inject({ method: init.method ?? 'GET', url, headers, payload: init.body as string | undefined })
    if (init.method === 'POST' && url === '/api/changes' && wire.losePushAnswers > 0) {
      // The transaction committed; the answer never arrives (timeout, dropped connection).
      wire.losePushAnswers -= 1
      throw new TypeError('Failed to fetch')
    }
    const session = res.cookies.find((c) => c.name === 'ft_session')
    if (session) cookie = session.value ? `ft_session=${session.value}` : null
    const noBody = res.statusCode === 204 || res.statusCode === 304
    return new Response(noBody ? null : res.body, { status: res.statusCode, headers: { 'Content-Type': String(res.headers['content-type'] ?? '') } })
  }
}
