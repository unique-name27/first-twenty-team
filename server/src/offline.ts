// The offline copy of the served app (docs/SERVER.md, "Offline keeps working"). The server serves a small
// service worker at /sw.js and marks the app page it serves; the app (src/main.tsx) registers the worker
// only when the page carries the mark, so the one-file build opened from disk, the claude.ai artifact viewer
// and the Vite dev server never get one. The worker keeps the latest copy of the app page and opens it when
// the server cannot be reached, so the browser's own copy of the workspace and its queued changes stay
// within reach after a restart. It never touches /api or anything else.
import { SERVED_MARKER, SERVICE_WORKER_URL } from '../../src/sync/protocol'

export const SERVICE_WORKER_PATH = SERVICE_WORKER_URL

/**
 * The worker's own policy (a worker obeys the CSP sent with its script): no scripts, frames or anything
 * else, only fetches to this origin (the app page).
 */
export const SERVICE_WORKER_CSP = "default-src 'none'; connect-src 'self'"

/**
 * The worker. Navigations to the app (/ and /index.html, any query) go to the network first, and each
 * good answer is kept; when the network fails, or the server answers 5xx (Caddy says 502 while the
 * server is stopped), the kept copy opens instead. Cache Storage is only ever touched through caught
 * calls, so a browser whose store fails still opens the page from the network (with no offline copy)
 * instead of failing the navigation. Installing keeps a first copy right away. Every other
 * request, /api included, never reaches the worker's handler and goes to the network as usual. The kept
 * page is the one the server sent, headers included, so its Content-Security-Policy still matches its
 * inline scripts.
 */
export const SERVICE_WORKER_JS = `'use strict'
// First Twenty: keeps the latest app page so the app opens while the server cannot be reached.
// Served by the First Twenty server (server/src/offline.ts); never touches /api.
const CACHE = 'first-twenty-app-v1'
const APP = '/'

self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(APP)).catch(() => undefined))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('first-twenty-app-') && k !== CACHE).map((k) => caches.delete(k))))
      .catch(() => undefined)
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET' || request.mode !== 'navigate') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || (url.pathname !== '/' && url.pathname !== '/index.html')) return
  event.respondWith(appPage(event))
})

// Cache Storage can fail (a damaged store, a full disk, a quota): that only means there is no offline
// copy, so every use of it is caught and the page still comes from the network.
const keptPage = () =>
  caches
    .open(CACHE)
    .then((cache) => cache.match(APP))
    .catch(() => undefined)

async function appPage(event) {
  let response
  try {
    response = await fetch(event.request)
  } catch (err) {
    const kept = await keptPage()
    if (kept) return kept
    throw err
  }
  if (response.ok) {
    const copy = response.clone()
    event.waitUntil(
      caches
        .open(CACHE)
        .then((cache) => cache.put(APP, copy))
        .catch(() => undefined),
    )
    return response
  }
  if (response.status >= 500) {
    const kept = await keptPage()
    if (kept) return kept
  }
  return response
}
`

const MARK = `<meta name="${SERVED_MARKER}" content="1">`

/**
 * The app page with the served mark, right after its <head> tag (or after the doctype when it has none).
 * Only the part before the first <script> is searched: the bundled scripts hold "<head>" in strings.
 */
export function markServed(html: string): string {
  const firstScript = html.search(/<script/i)
  const prefix = firstScript === -1 ? html : html.slice(0, firstScript)
  const head = /<head(?:\s[^>]*)?>/i.exec(prefix)
  const doctype = /^\s*<!doctype[^>]*>/i.exec(prefix)
  const at = head ? head.index + head[0].length : doctype ? doctype[0].length : 0
  return html.slice(0, at) + MARK + html.slice(at)
}
