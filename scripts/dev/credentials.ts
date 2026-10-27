// Development only (docs/DEV.md): the Vite dev server answers GET /__dev/credentials with the dev login
// `npm run stack` made (<FIRST_TWENTY_DEV_DIR>/credentials.json), so the app can sign itself in
// (src/dev/autoconnect.ts). The plugin has apply: 'serve', so no build ever includes it, and the API
// server knows nothing about it: signing in still goes through POST /api/auth/login with the password.
//
// It answers same-origin requests only. Vite's host check runs first (server.allowedHosts), and Vite's
// default CORS lets other localhost pages read its answers, so this refuses a request that a browser
// labels as coming from another site (Sec-Fetch-Site) or whose Origin is not this host. It also wants the
// app's X-First-Twenty: 1 header, which no other page can send without a CORS preflight. Tools that send
// none of the browser's labels (curl) get the file, as anyone who can read the folder can.
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import type { Plugin } from 'vite'

export const CREDENTIALS_PATH = '/__dev/credentials'

/** What the endpoint answers: the login and the stack it belongs to (a new one after --fresh). */
export type DevCredentials = { email: string; password: string; stackId: string }

type Next = (err?: unknown) => void

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(JSON.stringify(body))
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

/** True unless the browser says the request came from another origin. */
export function isSameOrigin(req: IncomingMessage): boolean {
  const site = header(req, 'sec-fetch-site')
  if (site !== undefined && site !== 'same-origin') return false
  const origin = header(req, 'origin')
  if (origin === undefined) return true
  let originHost: string
  try {
    originHost = new URL(origin).host.toLowerCase()
  } catch {
    return false
  }
  // A proxy in front (Codespaces port forwarding) may name the public host in X-Forwarded-Host.
  const hosts = [header(req, 'host'), header(req, 'x-forwarded-host')].filter((h): h is string => !!h).map((h) => h.toLowerCase())
  return hosts.includes(originHost)
}

/** The login in credentials.json, or null when the file is missing or not a login. */
export function readDevCredentials(file: string): DevCredentials | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<DevCredentials>
    if (typeof parsed.email !== 'string' || typeof parsed.password !== 'string' || typeof parsed.stackId !== 'string') return null
    return { email: parsed.email, password: parsed.password, stackId: parsed.stackId }
  } catch {
    return null
  }
}

/** The /__dev/credentials middleware for `file`, read on every request (--fresh replaces it). */
export function credentialsMiddleware(file: string) {
  return (req: IncomingMessage, res: ServerResponse, next: Next): void => {
    const url = req.url ?? ''
    if (url !== CREDENTIALS_PATH && !url.startsWith(`${CREDENTIALS_PATH}?`)) return next()
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET')
      return send(res, 405, { error: 'method_not_allowed' })
    }
    if (!isSameOrigin(req) || header(req, 'x-first-twenty') !== '1') return send(res, 403, { error: 'forbidden' })
    const credentials = readDevCredentials(file)
    if (!credentials) return send(res, 404, { error: 'not_found', detail: 'No dev login yet. Start the app with npm run stack.' })
    send(res, 200, credentials)
  }
}

/** The credentials file the stack wrote: FIRST_TWENTY_DEV_DIR (set by the stack for --offset), else .data/dev. */
export function credentialsFile(root: string, env: Record<string, string | undefined>): string {
  return path.resolve(root, env.FIRST_TWENTY_DEV_DIR?.trim() || '.data/dev', 'credentials.json')
}

/** The Vite plugin: dev server only (apply: 'serve'), never in a build. */
export function devCredentials(root: string): Plugin {
  return {
    name: 'first-twenty:dev-credentials',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(credentialsMiddleware(credentialsFile(root, process.env)))
    },
  }
}
