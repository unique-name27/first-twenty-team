// The HTTP API (docs/SYNC.md, Protocol). buildApp returns a Fastify instance that is not listening yet,
// so tests drive it with app.inject() and index.ts calls listen().
//
// Every /api route lives in one encapsulated plugin (prefix /api) that carries the CORS, CSRF,
// cross-site and no-store hooks, so they apply by route match: a percent-encoded path such as
// /%61pi/auth/logout reaches the same route and the same guards. Routes that need a session check it
// in onRequest, before Fastify reads the body, and so does the answer for unknown paths and methods: an
// anonymous request gets a body read only by the sign-in, sign-up and invite routes, within their small
// body limits. A request whose body never finishes arriving is dropped after REQUEST_TIMEOUT_MS.
//
// Companies (docs/SYNC.md, Companies): every login belongs to one workspace, and every authenticated
// route works on the session login's workspace (request.user.workspaceId), never on one a request names.
// With SIGNUP_MODE=open anyone may create a login and a company (POST /api/auth/signup); invites let a
// company's admin add teammates in either mode. A demo company's writes are held to the demo limits
// (writeBudget.ts for their pace, repo.ts for what they may hold).
//
// Careers hosts (CAREERS_HOSTS): a request whose Host is one of them reaches the careers routes
// (options.careers, server/src/careers) and nothing else; the app, its worker and the API answer 404
// there, and the careers routes answer only there (each carries a host constraint). No cookie is read or
// set on a careers host.
//
// The assistant (server/src/assistant, docs/SERVER.md "Lark, the assistant"): /api/assistant and
// /api/assistant/chat sit in the same API plugin, so they get its guards. Its model client comes from
// options.assistantClient (index.ts builds the real one when ANTHROPIC_API_KEY is set; tests pass a fake),
// or the scripted fake when ASSISTANT_FAKE is on; with neither, the routes answer that it is off.
import { readFileSync } from 'node:fs'
import fastifyCookie from '@fastify/cookie'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import {
  ACCOUNT_LIMITS,
  AddressRateLimiter,
  type AuthUser,
  authCookies,
  checkCredentials,
  clientAddressKey,
  ConcurrencyGate,
  cookieCount,
  createSession,
  deleteSession,
  DEVICE_TRUST_DAYS,
  findSession,
  findTrustedDevice,
  GateFullError,
  hashPassword,
  INVITE_ACCEPT_LIMITS,
  INVITE_LOOKUP_LIMITS,
  isValidEmail,
  LoginRateLimiter,
  loginEmail,
  MAX_PASSWORD_LENGTH,
  passwordProblem,
  publicUser,
  purgeSessions,
  trustDevice,
} from './auth'
import type { AssistantClient } from './assistant/client'
import { fakeAssistantClient } from './assistant/fake'
import { registerAssistantRoutes } from './assistant/routes'
import type { Config } from './config'
import { API_CSP, appCsp, CAREERS_CSP, inlineScriptHashes } from './csp'
import type { Db } from './db'
import { badRequest, HttpError } from './errors'
import { unappliedMigrations } from './migrate'
import { markServed, SERVICE_WORKER_CSP, SERVICE_WORKER_JS, SERVICE_WORKER_PATH } from './offline'
import { applyChanges, changesSince, replaceWorkspace, snapshot, workspaceStatus } from './repo'
import { isPlainObject, parseHistoryId, parsePush, parseSince, parseWorkspace } from './validate'
import { serverVersion } from './version'
import {
  acceptInvite,
  type AccountResult,
  careersOn,
  companyName,
  createCompany,
  createInvite,
  INVITE_DAYS,
  inviteInfo,
  MAX_LOGINS_PER_WORKSPACE,
  MAX_OPEN_INVITES,
  openInvites,
  revokeInvite,
  setCareers,
  touchWorkspace,
  workspaceInfo,
} from './workspaces'
import { WriteBudget } from './writeBudget'

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null
  }
  interface FastifyContextConfig {
    /** Set on every route options.careers registers: such a route answers on CAREERS_HOSTS only. */
    careers?: boolean
  }
}

/**
 * The careers pages (server/src/careers): registers its routes on `scope`. buildApp gives every route
 * registered there a host constraint for CAREERS_HOSTS and marks it as a careers route, so it answers on
 * the careers hosts only, and those hosts answer nothing else. Writes go through repo.ts applyChanges
 * with the workspace from findWorkspaceBySlug (workspaces.ts) and markActive: false.
 */
export type CareersRoutes = (scope: FastifyInstance, deps: { db: Db; config: Config }) => Promise<void>

export const CSRF_HEADER = 'x-first-twenty'
export const BODY_LIMIT = 2 * 1024 * 1024
export const WORKSPACE_BODY_LIMIT = 10 * 1024 * 1024
/** {email, password}: a 254-character email and a 1,024-character password fit with room to spare. */
export const LOGIN_BODY_LIMIT = 8 * 1024
export const LOGOUT_BODY_LIMIT = 1024
/** {email, password, companyName} or {token, email, password}: the login's fields and 80 characters or a token more. */
export const ACCOUNT_BODY_LIMIT = 8 * 1024
/**
 * How long a request may take to arrive in full (Node's requestTimeout; Fastify's default is none, so a
 * body sent a byte at a time held its socket forever). Enough for a 10 MB workspace upload at about
 * 0.5 Mbit/s; Caddy's read_body timeout in server/deploy/Caddyfile matches it. Node checks every 30 s.
 */
export const REQUEST_TIMEOUT_MS = 180_000
/** How often the login rate limiter drops keys with no recent attempts. */
const LIMITER_SWEEP_MS = 60_000

export type BuildAppOptions = {
  db: Db
  config: Config
  /** Overrides the logger (tests pass false). Default: pino at config.logLevel, or off when 'silent'. */
  logger?: boolean | Record<string, unknown>
  limiter?: LoginRateLimiter
  /** Demo sign-ups (default ACCOUNT_LIMITS). */
  accountLimiter?: AddressRateLimiter
  /** Joining with an invite whose token checked out (default INVITE_ACCEPT_LIMITS). */
  inviteAcceptLimiter?: AddressRateLimiter
  /** Invite token checks: lookups, and the check before joining (default INVITE_LOOKUP_LIMITS). */
  inviteLookupLimiter?: AddressRateLimiter
  /** How fast demo companies may write (default DEMO_WRITE_LIMITS). */
  writeBudget?: WriteBudget
  /** Caps concurrent password checks (default: 2 running, 16 waiting). */
  passwordGate?: ConcurrencyGate
  /** The careers routes, served on CAREERS_HOSTS (see CareersRoutes). None: careers hosts answer 404 only. */
  careers?: CareersRoutes
  /**
   * The assistant's model client (assistant/client.ts). Default: the scripted fake when ASSISTANT_FAKE is on,
   * else none, and the assistant answers that it is off (index.ts passes the real one when the key is set).
   */
  assistantClient?: AssistantClient | null
  /** The assistant's clock (tests): today for its context note and the day its messages count under. Default: now. */
  assistantNow?: () => Date
}

/** A request path with any invite token cut out: a working token is a key to a company, and logs keep paths. */
export function redactPath(url: string): string {
  return url.replace(/(\/invites\/)[^/?#]+/i, '$1[redacted]')
}

export function loggerOptions(config: Config): boolean | Record<string, unknown> {
  if (config.logLevel === 'silent') return false
  return {
    level: config.logLevel,
    // The default serializers log method, url, host, remote address and status: never bodies or headers.
    // Fastify's own request serializer, with the url logged without invite tokens. Redact anyway in case
    // a header object is ever logged.
    serializers: {
      req: (req: { method: string; url: string; host?: string; ip?: string; socket?: { remotePort?: number } }) => ({
        method: req.method,
        url: redactPath(req.url),
        host: req.host,
        remoteAddress: req.ip,
        remotePort: req.socket?.remotePort,
      }),
    },
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        'res.headers["set-cookie"]',
        'password',
        '*.password',
        'apiKey',
        '*.apiKey',
      ],
      censor: '[redacted]',
    },
  }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Matches a Host header that names one of `hosts` (any case, any port, with or without the trailing dot
 * of a fully qualified name, which reaches the same host), or null for none.
 */
export function careersHostPattern(hosts: readonly string[]): RegExp | null {
  return hosts.length === 0 ? null : new RegExp(`^(?:${hosts.map(escapeRegExp).join('|')})\\.?(?::\\d{1,5})?$`, 'i')
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { db, config } = options
  const limiter = options.limiter ?? new LoginRateLimiter()
  const accountLimiter = options.accountLimiter ?? new AddressRateLimiter(ACCOUNT_LIMITS)
  const inviteAcceptLimiter = options.inviteAcceptLimiter ?? new AddressRateLimiter(INVITE_ACCEPT_LIMITS)
  const inviteLookupLimiter = options.inviteLookupLimiter ?? new AddressRateLimiter(INVITE_LOOKUP_LIMITS)
  const writeBudget = options.writeBudget ?? new WriteBudget()
  const passwordGate = options.passwordGate ?? new ConcurrencyGate()
  const assistantClient = options.assistantClient ?? (config.assistant.fake ? fakeAssistantClient() : null)
  const version = serverVersion()
  const careersHost = careersHostPattern(config.careersHosts)
  /** Whether a request is for a careers host: the same Host header test the careers routes' constraint makes. */
  const onCareersHost = (request: FastifyRequest) => careersHost !== null && careersHost.test(request.headers.host ?? '')

  // The served app is read once: its inline scripts are allowed by hash, and serving the same bytes
  // that were hashed keeps the two in step even while a deploy rebuilds the file (it restarts after).
  // It carries the served mark, so the app registers the offline worker (offline.ts) only here.
  const appHtml = config.serveApp ? Buffer.from(markServed(readFileSync(config.appFile, 'utf8')), 'utf8') : null
  const appPolicy = appHtml ? appCsp(inlineScriptHashes(appHtml.toString('utf8'))) : null

  // A build started before its migrations ran (MIGRATE_ON_START=false and no server:migrate yet) would
  // answer health checks while every sign-in fails on a missing table, so /api/health says 503 until the
  // schema catches up. Once current, it is not read again. A read that fails counts as current: the
  // check must never take a healthy server down.
  let schemaCurrent = false
  const schemaBehind = async (log: FastifyRequest['log']): Promise<boolean> => {
    if (schemaCurrent) return false
    try {
      const pending = await unappliedMigrations(db)
      if (pending.length === 0) {
        schemaCurrent = true
        return false
      }
      log.error({ pending }, 'the database schema is behind this build: run server:migrate, then restart')
      return true
    } catch (err) {
      log.warn({ err }, 'could not read schema_migrations')
      return false
    }
  }

  const app = Fastify({
    logger: options.logger ?? loggerOptions(config),
    bodyLimit: BODY_LIMIT,
    trustProxy: config.trustProxy,
    requestTimeout: REQUEST_TIMEOUT_MS,
    return503OnClosing: true,
    requestIdHeader: false,
  })

  app.decorateRequest('user', null)

  /**
   * Whether a request gets Secure cookies and HSTS: always when PUBLIC_ORIGIN is https, and also when it
   * reached Caddy over https (X-Forwarded-Proto, honoured from trustProxy addresses only, which is
   * loopback by default), so a PUBLIC_ORIGIN left at http:// never puts the session cookie on the wire
   * without Secure. The SSH tunnel to http://localhost keeps plain cookies while PUBLIC_ORIGIN is http.
   */
  const isSecure = (request: FastifyRequest) => config.secureCookies || request.protocol === 'https'

  // JSON bodies only (no forms, so no simple cross-site POSTs). An empty body counts as no body.
  const defaultJson = app.getDefaultJsonParser('error', 'error')
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    if (body === '' || (typeof body === 'string' && body.trim() === '')) {
      done(null, undefined)
      return
    }
    defaultJson(request, body as string, done)
  })
  app.removeContentTypeParser('text/plain')

  await app.register(fastifyCookie)

  // The limiters forget idle keys on a timer (never per request).
  const sweeper = setInterval(() => {
    limiter.sweep()
    accountLimiter.sweep()
    inviteAcceptLimiter.sweep()
    inviteLookupLimiter.sweep()
    writeBudget.sweep()
  }, LIMITER_SWEEP_MS)
  sweeper.unref()
  app.addHook('onClose', async () => clearInterval(sweeper))

  // ------------------------------------------------------------------------------------------
  // Security headers on every response
  // ------------------------------------------------------------------------------------------

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header('X-Frame-Options', 'DENY')
    reply.header('Cross-Origin-Opener-Policy', 'same-origin')
    reply.header('Cross-Origin-Resource-Policy', 'same-origin')
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()')
    if (isSecure(request)) reply.header('Strict-Transport-Security', 'max-age=31536000')
    const careers = onCareersHost(request)
    // Careers hosts never carry cookies: nothing there may set one.
    if (careers) reply.removeHeader('set-cookie')
    // The app route sets its own policy (with its script hashes), and careers pages theirs; anything
    // else gets the strict one (the careers policy on a careers host).
    if (!reply.hasHeader('content-security-policy')) {
      const type = String(reply.getHeader('content-type') ?? '')
      reply.header('Content-Security-Policy', careers ? CAREERS_CSP : type.startsWith('text/html') ? appCsp([]) : API_CSP)
    }
    return payload
  })

  // ------------------------------------------------------------------------------------------
  // Errors: never leak stack traces, SQL or driver messages
  // ------------------------------------------------------------------------------------------

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, request, reply) => {
    if (err instanceof HttpError) {
      if (err.statusCode >= 500) request.log.error({ err }, 'request failed')
      // A refusal that says when to come back says it in the header too (write_limit).
      if (typeof err.extra?.retryAfter === 'number') reply.header('Retry-After', String(err.extra.retryAfter))
      return reply.code(err.statusCode).send({ error: err.code, ...(err.detail ? { detail: err.detail } : {}), ...err.extra })
    }
    const status = err.statusCode
    if (typeof status === 'number' && status >= 400 && status < 500) {
      request.log.info({ code: err.code, status }, 'request rejected')
      const code =
        status === 413 ? 'too_large' : status === 415 ? 'unsupported_media_type' : status === 404 ? 'not_found' : status === 429 ? 'rate_limited' : 'bad_request'
      return reply.code(status).send({ error: code })
    }
    // Postgres data exceptions (class 22: bad text, unicode or number) mean the input cannot be stored.
    if (typeof err.code === 'string' && /^22[0-9A-Z]{3}$/.test(err.code)) {
      request.log.warn({ code: err.code }, 'data rejected by the database')
      return reply.code(400).send({ error: 'bad_request', detail: 'The data could not be stored.' })
    }
    request.log.error({ err }, 'request failed')
    return reply.code(500).send({ error: 'server_error' })
  })

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: 'not_found' })
  })

  // Unknown paths and methods are answered before anything reads the body: Fastify's not-found handlers
  // would otherwise buffer and parse up to BODY_LIMIT for anyone. Registered before the API plugin, so
  // it and both not-found handlers inherit it. A development CORS preflight lands on a not-found route
  // too (there are no OPTIONS routes), so it goes on to the API's CORS hook.
  app.addHook('onRequest', async (request, reply) => {
    if (request.is404 && !(config.allowedOrigin && request.method === 'OPTIONS')) {
      return reply.code(404).send({ error: 'not_found' })
    }
    // A careers host answers careers routes only (the app, /sw.js and every /api route are 404 there),
    // and reads no cookie. The careers routes' host constraint already keeps them off every other host.
    if (onCareersHost(request)) {
      request.cookies = {}
      if (request.routeOptions.config.careers !== true) return reply.code(404).send({ error: 'not_found' })
    } else if (request.routeOptions.config.careers === true) {
      return reply.code(404).send({ error: 'not_found' })
    }
  })

  // ------------------------------------------------------------------------------------------
  // The API
  // ------------------------------------------------------------------------------------------

  /** The session's user and its workspace, or null. A cookie that names no live session is cleared. */
  async function sessionUser(request: FastifyRequest, reply: FastifyReply): Promise<AuthUser | null> {
    const { session } = authCookies(isSecure(request))
    const token = request.cookies[session.name]
    const user = await findSession(db, token, config)
    // Two cookies of this name mean another host planted one (a browser sends one per domain and path,
    // and the parser keeps the first): clearing would delete the real one, not the planted one.
    if (!user && token && cookieCount(request.headers.cookie, session.name) === 1) reply.clearCookie(session.name, session.options)
    return user
  }

  /** onRequest hook: runs before the body is read, so anonymous requests are refused unparsed. */
  async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
    const user = await sessionUser(request, reply)
    if (!user) throw new HttpError(401, 'unauthorized', 'Sign in first.')
    request.user = user
  }

  /** The signed-in login. Its workspaceId is the only workspace any authenticated route reads or writes. */
  const currentUser = (request: FastifyRequest): AuthUser => {
    if (!request.user) throw new HttpError(401, 'unauthorized', 'Sign in first.')
    return request.user
  }

  /** 429 for a sign-in that got no password check because too many are running or waiting. */
  const refuseBusy = (request: FastifyRequest, reply: FastifyReply) => {
    request.log.warn({ ip: request.ip }, 'login refused: too many password checks waiting')
    reply.header('Retry-After', '5')
    return reply.code(429).send({ error: 'busy', retryAfter: 5 })
  }

  const refuseRateLimited = (reply: FastifyReply, retryAfter: number) => {
    reply.header('Retry-After', String(retryAfter))
    return reply.code(429).send({ error: 'rate_limited', retryAfter })
  }

  /**
   * Signs a login in on this browser, the same way for a sign-in, a sign-up and an accepted invite: the
   * session this browser had is dropped (session fixation) and stale ones purged, a new session and a
   * fresh trusted-device token replace them, and the workspace counts as in use.
   */
  async function startSession(request: FastifyRequest, reply: FastifyReply, user: AuthUser, remember: boolean): Promise<void> {
    const cookies = authCookies(isSecure(request))
    await deleteSession(db, request.cookies[cookies.session.name])
    await purgeSessions(db, config)
    const token = await createSession(db, user.id, config, { ip: request.ip, userAgent: request.headers['user-agent'] }, remember)
    // A fresh device token too, in place of the one this browser sent.
    const deviceToken = await trustDevice(db, user.id, request.cookies[cookies.device.name])
    await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id])
    await touchWorkspace(db, user.workspaceId)
    // Remembered: the cookie outlives the browser for SESSION_MAX_DAYS. Otherwise no Max-Age or
    // Expires, so the browser drops it when it closes (the server ends it after 12 hours anyway).
    const { session, device: deviceCookie } = cookies
    reply.setCookie(session.name, token, remember ? { ...session.options, maxAge: config.sessionMaxDays * 86_400 } : session.options)
    // The device cookie outlasts sessions and sign-outs: on its own it grants nothing but its sign-in limit.
    reply.setCookie(deviceCookie.name, deviceToken, { ...deviceCookie.options, maxAge: DEVICE_TRUST_DAYS * 86_400 })
  }

  /**
   * The password hash for a new login (a sign-up or an accepted invite), within `accounts` (counted for
   * this address, and server-wide until it turns out to create nothing: see AddressRateLimiter.failed)
   * and the password-check gate, or null once a 429 has been sent. The hash is made before the email is
   * looked up, so an email that already has a login costs the same time as one that does not.
   */
  async function newLoginHash(request: FastifyRequest, reply: FastifyReply, password: string, accounts: AddressRateLimiter): Promise<string | null> {
    const address = clientAddressKey(request.ip)
    const limit = accounts.begin(address)
    if (!limit.ok) {
      refuseRateLimited(reply, limit.retryAfter)
      return null
    }
    try {
      if (passwordGate.full) throw new GateFullError()
      return await passwordGate.run(() => hashPassword(password))
    } catch (err) {
      if (!(err instanceof GateFullError)) {
        accounts.failed()
        throw err
      }
      accounts.cancelled(address)
      refuseBusy(request, reply)
      return null
    }
  }

  /**
   * Creates the account `create` makes with a fresh password hash (newLoginHash), or sends the refusal.
   * Anything but a created account leaves the server-wide count of `accounts`.
   */
  async function newAccount(
    request: FastifyRequest,
    reply: FastifyReply,
    password: string,
    accounts: AddressRateLimiter,
    create: (passwordHash: string) => Promise<AccountResult>,
  ): Promise<Extract<AccountResult, { ok: true }> | null> {
    const passwordHash = await newLoginHash(request, reply, password, accounts)
    if (passwordHash === null) return null
    let result: AccountResult
    try {
      result = await create(passwordHash)
    } catch (err) {
      accounts.failed()
      throw err
    }
    if (result.ok) return result
    accounts.failed()
    request.log.info({ ip: request.ip, reason: result.reason }, 'account refused')
    refuseAccount(reply, result.reason)
    return null
  }

  /** The login's company and its careers page as /api/auth/me and the careers switch answer them. */
  async function companyAnswer(user: AuthUser) {
    const [workspace, careersEnabled] = await Promise.all([workspaceInfo(db, user.workspaceId), careersOn(db, user.workspaceId)])
    const careersUrl = config.careersOrigin && workspace ? `${config.careersOrigin}/${workspace.slug}/` : null
    return { workspace, careersUrl, careersEnabled }
  }

  /**
   * The demo write limits for a write of about `bytes` (writeBudget.ts): nothing for a kept workspace;
   * past them, 429 write_limit with retryAfter, and nothing is written.
   */
  function admitWrite(user: AuthUser, bytes: number): void {
    if (user.keep !== false) return
    const limit = writeBudget.take(user.workspaceId, bytes)
    if (!limit.ok) {
      throw new HttpError(429, 'write_limit', 'This demo company is sending changes faster than the demo server allows. They wait in your browser and go out on their own.', {
        retryAfter: limit.retryAfter,
      })
    }
  }

  /** Validates the {email, password, remember?} part of a sign-up or invite body (400 with a plain reason). */
  function newLoginFields(body: Record<string, unknown>): { email: string; password: string; remember: boolean } {
    if (typeof body.email !== 'string' || typeof body.password !== 'string') throw badRequest('Send an email and a password.')
    if (body.remember !== undefined && typeof body.remember !== 'boolean') throw badRequest('remember must be true or false.')
    const email = loginEmail(body.email)
    if (email === null || !isValidEmail(email)) throw badRequest('Enter a valid email address, like you@company.com.')
    const problem = passwordProblem(body.password)
    if (problem) throw badRequest(problem)
    return { email, password: body.password, remember: body.remember === true }
  }

  /** The answer for a sign-up or invite that created nothing. */
  const refuseAccount = (reply: FastifyReply, reason: Extract<AccountResult, { ok: false }>['reason']) => {
    if (reason === 'email_taken') {
      return reply.code(409).send({ error: 'email_taken', detail: 'That email already has a login on this server. Sign in with it, or use another email.' })
    }
    if (reason === 'demo_full') {
      return reply.code(503).send({ error: 'demo_full', detail: 'This demo server holds as many demo companies as it can right now. Try again later.' })
    }
    return reply.code(404).send({ error: 'invalid_invite', detail: 'This invite link does not work: it was used already, it expired, or it is incomplete.' })
  }

  async function apiRoutes(api: FastifyInstance) {
    // Guards: CORS (development only), CSRF header, cross-site requests.
    api.addHook('onRequest', async (request, reply) => {
      const origin = request.headers.origin
      if (config.allowedOrigin && origin === config.allowedOrigin) {
        reply.header('Access-Control-Allow-Origin', origin)
        reply.header('Access-Control-Allow-Credentials', 'true')
        reply.header('Vary', 'Origin')
        if (request.method === 'OPTIONS') {
          reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE')
          reply.header('Access-Control-Allow-Headers', 'Content-Type, X-First-Twenty')
          reply.header('Access-Control-Max-Age', '600')
          return reply.code(204).send()
        }
      }
      if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') {
        // Never relax this check. Under a shared parent domain that is not a public suffix (*.sslip.io),
        // every other host there is "same-site", so SameSite=Strict lets their requests carry the
        // cookie; this header, which no page can send cross-origin without a CORS preflight (refused
        // here), is what stops them.
        if (request.headers[CSRF_HEADER] !== '1') {
          return reply.code(403).send({ error: 'csrf', detail: 'Send the X-First-Twenty: 1 header.' })
        }
        // Browsers label where a request comes from: only the app's own pages (same-origin) may write.
        // 'same-site' is refused too, for the reason above; 'none' is a user action, and tools that send
        // no label at all (curl, scripts) still pass. An allowed dev origin is the one exception.
        const site = request.headers['sec-fetch-site']
        if (site !== undefined && site !== 'same-origin' && site !== 'none' && !(config.allowedOrigin && origin === config.allowedOrigin)) {
          return reply.code(403).send({ error: 'cross_site' })
        }
      }
    })

    api.addHook('onSend', async (_request, reply, payload) => {
      // A route may add to no-store (the assistant's event stream adds no-transform), never drop it.
      if (!/(^|,)\s*no-store\s*(,|$)/.test(String(reply.getHeader('cache-control') ?? ''))) reply.header('Cache-Control', 'no-store')
      return payload
    })

    api.setNotFoundHandler((_request, reply) => {
      reply.code(404).send({ error: 'not_found' })
    })

    const authed = { onRequest: requireAuth }

    api.get('/health', async (request, reply) => {
      let timer: NodeJS.Timeout | undefined
      try {
        const behind = await Promise.race([
          db.query('SELECT 1').then(() => schemaBehind(request.log)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('health check timed out')), 3000)
          }),
        ])
        // The names stay in the log: this route answers anyone.
        if (behind) return reply.code(503).send({ ok: false, db: 'up', schema: 'behind' })
        return { ok: true, db: 'up', version }
      } catch (err) {
        request.log.warn({ err }, 'database health check failed')
        return reply.code(503).send({ ok: false, db: 'down' })
      } finally {
        clearTimeout(timer)
      }
    })

    api.post('/auth/login', { bodyLimit: LOGIN_BODY_LIMIT }, async (request, reply) => {
      const body = request.body
      if (!isPlainObject(body) || typeof body.email !== 'string' || typeof body.password !== 'string') {
        throw badRequest('Send {"email": "...", "password": "..."}.')
      }
      // Optional "Keep me signed in". Absent means false: a browser-session cookie and a 12-hour session.
      if (body.remember !== undefined && typeof body.remember !== 'boolean') {
        throw badRequest('remember must be true or false.')
      }
      const remember = body.remember === true
      const cookies = authCookies(isSecure(request))
      // Normalized once: this exact string is the rate-limit key and the lookup (null: no login has it).
      const email = loginEmail(body.email)
      const password = body.password
      const address = clientAddressKey(request.ip)
      const possible = email !== null && password.length > 0 && password.length <= MAX_PASSWORD_LENGTH
      // A browser that signed in as this login before (its trusted-device cookie) gets its own limit
      // instead of the email and address limits, so guessing from many addresses cannot lock it out.
      const device = possible ? await findTrustedDevice(db, request.cookies[cookies.device.name], email) : null
      // Checked right before run(), with no await in between, so run() cannot refuse it after all.
      const busy = possible && passwordGate.full
      const trusted = device !== null && !busy
      // A sign-in that cannot succeed, or gets no password check, counts against the address only, so
      // it adds no keys for an email and cannot push another email's count out of the limiter.
      const limit = trusted ? limiter.beginTrusted(device) : limiter.begin(possible && !busy ? email : null, address)
      if (!limit.ok) {
        reply.header('Retry-After', String(limit.retryAfter))
        return reply.code(429).send({ error: 'rate_limited', retryAfter: limit.retryAfter })
      }
      if (busy) return refuseBusy(request, reply)
      let user: AuthUser | null = null
      if (possible) {
        try {
          user = await passwordGate.run(() => checkCredentials(db, email, password))
        } catch (err) {
          if (!(err instanceof GateFullError)) throw err
          if (trusted) limiter.cancelledTrusted(device)
          else limiter.cancelled(email, address)
          return refuseBusy(request, reply)
        }
      }
      if (!user || !email) {
        request.log.info({ ip: request.ip, trusted }, 'login failed')
        return reply.code(401).send({ error: 'invalid_credentials' })
      }
      if (trusted) limiter.succeededTrusted(device)
      else limiter.succeeded(email, address)
      // A fresh session every sign-in.
      await startSession(request, reply, user, remember)
      request.log.info({ userId: user.id, workspaceId: user.workspaceId, remember, trusted }, 'login succeeded')
      // The company too: a browser that syncs one company's copy must not carry on under another's login.
      return { user: publicUser(user), workspace: await workspaceInfo(db, user.workspaceId) }
    })

    // Whether anyone may create a demo company here, for the app's "Create a demo company" offers. Public.
    api.get('/auth/signup-mode', async () => ({ signupMode: config.signupMode, demoExpireDays: config.demoExpireDays }))

    // Demo sign-up: a login and a company of its own. Only on a server with SIGNUP_MODE=open; elsewhere
    // the route does not exist (404 before any body is read).
    if (config.signupMode === 'open') {
      api.post('/auth/signup', { bodyLimit: ACCOUNT_BODY_LIMIT }, async (request, reply) => {
        const body = request.body
        if (!isPlainObject(body)) throw badRequest('Send {"email": "...", "password": "...", "companyName": "..."}.')
        // A field the app never shows: whatever fills it in is not a person using the app.
        if (body.website !== undefined && body.website !== '') throw badRequest('Leave the website field empty.')
        const { email, password, remember } = newLoginFields(body)
        const name = companyName(body.companyName)
        if (!name) throw badRequest('Enter a company name of 2 to 80 characters.')
        const result = await newAccount(request, reply, password, accountLimiter, (passwordHash) =>
          createCompany(db, { email, passwordHash }, name, config.demoMaxWorkspaces),
        )
        if (!result) return reply
        await startSession(request, reply, result.user, remember)
        request.log.info({ userId: result.user.id, workspaceId: result.workspace.id }, 'signed up')
        return reply.code(201).send({ user: publicUser(result.user), workspace: result.workspace })
      })
    }

    /** An invite link's company, for its "Join <company>" page, within the lookup limit (null: answered). */
    async function lookUpInvite(request: FastifyRequest, reply: FastifyReply, token: unknown): Promise<{ companyName: string } | null> {
      const limit = inviteLookupLimiter.begin(clientAddressKey(request.ip))
      if (!limit.ok) {
        refuseRateLimited(reply, limit.retryAfter)
        return null
      }
      const info = await inviteInfo(db, token)
      if (!info) {
        refuseAccount(reply, 'invalid_invite')
        return null
      }
      return { companyName: info.name }
    }

    // An invite link's company. Public: the token is the secret, so the app sends it in the body, where no
    // proxy or access log keeps it (paths end up in logs). The token-in-path form stays for older apps;
    // the server's own log cuts the token out of it (redactPath), and so does Caddy's (Caddyfile).
    api.post('/invites/lookup', { bodyLimit: LOGOUT_BODY_LIMIT }, async (request, reply) => {
      const body = request.body
      if (!isPlainObject(body) || typeof body.token !== 'string') throw badRequest('Send {"token": "..."}.')
      return (await lookUpInvite(request, reply, body.token)) ?? reply
    })
    api.get('/invites/:token', async (request, reply) => (await lookUpInvite(request, reply, (request.params as { token?: string }).token)) ?? reply)

    // Joins the company an invite link names, as a new login, and signs in. The token is checked first,
    // against the lookup limit: one that does not work costs no password hashing and none of the
    // account limits, so junk tokens cannot keep real teammates out.
    api.post('/auth/accept-invite', { bodyLimit: ACCOUNT_BODY_LIMIT }, async (request, reply) => {
      const body = request.body
      if (!isPlainObject(body) || typeof body.token !== 'string') throw badRequest('Send {"token": "...", "email": "...", "password": "..."}.')
      const { email, password, remember } = newLoginFields(body)
      if (!(await lookUpInvite(request, reply, body.token))) return reply
      const token = body.token
      const result = await newAccount(request, reply, password, inviteAcceptLimiter, (passwordHash) => acceptInvite(db, token, { email, passwordHash }))
      if (!result) return reply
      await startSession(request, reply, result.user, remember)
      request.log.info({ userId: result.user.id, workspaceId: result.workspace.id }, 'joined by invite')
      return reply.code(201).send({ user: publicUser(result.user), workspace: result.workspace })
    })

    api.post('/auth/logout', { bodyLimit: LOGOUT_BODY_LIMIT }, async (request, reply) => {
      const { session } = authCookies(isSecure(request))
      // Clear the browser's cookie even when the database is unreachable, so a shared computer is never
      // left holding a live session token; the 503 tells the client to retry deleting the server row.
      reply.clearCookie(session.name, session.options)
      try {
        await deleteSession(db, request.cookies[session.name])
      } catch (err) {
        request.log.error({ err }, 'logout could not delete the session row')
        return reply.code(503).send({ error: 'unavailable' })
      }
      return reply.code(204).send()
    })

    // The login, its company, the company's careers page (careersUrl: its address when the server serves
    // careers pages; careersEnabled: whether it is public) and whether this server takes sign-ups.
    api.get('/auth/me', authed, async (request) => {
      const user = currentUser(request)
      return { user: publicUser(user), ...(await companyAnswer(user)), signupMode: config.signupMode }
    })

    // Who is signed in, and the company of that login, for the app's checks on every page load: nobody is
    // an answer here ({user: null}), not a 401, which browsers log as an error. GET and no body, so it
    // needs no guard of its own.
    api.get('/auth/session', async (request, reply) => {
      const user = await sessionUser(request, reply)
      return user ? { user: publicUser(user), workspace: await workspaceInfo(db, user.workspaceId) } : { user: null }
    })

    // Turns the company's careers page on or off (an admin). Demo companies start with it on, the owner's
    // own workspace with it off.
    api.put('/workspace/careers', { ...authed, bodyLimit: LOGOUT_BODY_LIMIT }, async (request, reply) => {
      const user = currentUser(request)
      if (user.role !== 'admin') return reply.code(403).send({ error: 'forbidden', detail: 'Only an admin can change the careers page.' })
      const body = request.body
      if (!isPlainObject(body) || typeof body.enabled !== 'boolean') throw badRequest('Send {"enabled": true} or {"enabled": false}.')
      if (!(await setCareers(db, user.workspaceId, body.enabled))) throw new HttpError(401, 'unauthorized', 'Sign in first.')
      request.log.info({ userId: user.id, workspaceId: user.workspaceId, enabled: body.enabled }, 'careers page switched')
      const { careersUrl, careersEnabled } = await companyAnswer(user)
      return { careersUrl, careersEnabled }
    })

    // An invite link to the signed-in admin's company: single use, INVITE_DAYS days. The link opens the
    // app's #invite route; the token in it is the only copy (the server keeps its hash).
    api.post('/invites', { ...authed, bodyLimit: LOGOUT_BODY_LIMIT }, async (request, reply) => {
      const user = currentUser(request)
      if (user.role !== 'admin') return reply.code(403).send({ error: 'forbidden', detail: 'Only an admin can invite teammates.' })
      const result = await createInvite(db, user.workspaceId, user.id)
      if (!result.ok) {
        reply.header('Retry-After', String(result.retryAfter))
        const detail =
          result.reason === 'too_many_invites'
            ? `This company has ${MAX_OPEN_INVITES} invite links open. One frees up when it is used or expires (after ${INVITE_DAYS} days).`
            : `A company has at most ${MAX_LOGINS_PER_WORKSPACE} logins on this server, counting open invite links.`
        return reply.code(429).send({ error: result.reason, retryAfter: result.retryAfter, detail })
      }
      const origin = config.publicOrigin ?? `${request.protocol}://${request.host}`
      request.log.info({ userId: user.id, workspaceId: user.workspaceId }, 'invite created')
      return reply.code(201).send({ url: `${origin}/#invite.${result.token}`, expiresAt: result.expiresAt })
    })

    // The company's open invite links (an admin): when each was made, by whom, and when it stops working.
    // Never a token: the server keeps only their hashes.
    api.get('/invites', authed, async (request, reply) => {
      const user = currentUser(request)
      if (user.role !== 'admin') return reply.code(403).send({ error: 'forbidden', detail: 'Only an admin can see invite links.' })
      return { invites: await openInvites(db, user.workspaceId) }
    })

    // Revokes one of the company's open invite links (an admin). An id from any other company is 404.
    api.delete('/invites/:id', { ...authed, bodyLimit: LOGOUT_BODY_LIMIT }, async (request, reply) => {
      const user = currentUser(request)
      if (user.role !== 'admin') return reply.code(403).send({ error: 'forbidden', detail: 'Only an admin can revoke invite links.' })
      if (!(await revokeInvite(db, user.workspaceId, (request.params as { id?: string }).id))) {
        return reply.code(404).send({ error: 'not_found', detail: 'That invite link was used, revoked or expired already.' })
      }
      request.log.info({ userId: user.id, workspaceId: user.workspaceId }, 'invite revoked')
      return reply.code(204).send()
    })

    // Every route below works on the signed-in login's workspace only.

    // 404 {error: 'empty'} before the first upload, by protocol (older apps rely on it).
    api.get('/workspace', authed, async (request, reply) => {
      const snap = await snapshot(db, currentUser(request).workspaceId)
      if (!snap) return reply.code(404).send({ error: 'empty' })
      return snap
    })

    // Whether the server holds a workspace, for the app's "is it empty?" checks: an empty server is an
    // answer here ({empty: true}), not a 404, which browsers log as an error. No records are read.
    api.get('/workspace/status', authed, async (request) => workspaceStatus(db, currentUser(request).workspaceId))

    api.put('/workspace', { ...authed, bodyLimit: WORKSPACE_BODY_LIMIT }, async (request) => {
      const input = parseWorkspace(request.body)
      const user = currentUser(request)
      admitWrite(user, input.docs.reduce((n, d) => n + d.json.length, 0) + input.collections.reduce((n, c) => n + c.json.length, 0))
      const result = await replaceWorkspace(db, input, user.id, user.workspaceId, { demoTotalBytes: config.demoMaxTotalBytes })
      request.log.info({ userId: user.id, workspaceId: user.workspaceId, seq: result.seq, replace: input.confirmReplace }, 'workspace replaced')
      return result
    })

    api.get('/changes', authed, async (request) => {
      const query = request.query as Record<string, unknown>
      const since = parseSince(query.since)
      return changesSince(db, since, { historyId: parseHistoryId(query.history), workspaceId: currentUser(request).workspaceId })
    })

    api.post('/changes', authed, async (request) => {
      const { changes, historyId } = parsePush(request.body)
      const user = currentUser(request)
      admitWrite(user, changes.reduce((n, c) => n + (c.json?.length ?? 0), 0))
      return applyChanges(db, changes, user.id, { historyId, workspaceId: user.workspaceId, demoTotalBytes: config.demoMaxTotalBytes })
    })

    // The assistant: GET /api/assistant and POST /api/assistant/chat, on the session login's company.
    await registerAssistantRoutes(api, { db, config, client: assistantClient, requireAuth, currentUser, now: options.assistantNow })
  }

  await app.register(apiRoutes, { prefix: '/api' })

  // ------------------------------------------------------------------------------------------
  // Careers pages, on CAREERS_HOSTS only
  // ------------------------------------------------------------------------------------------

  if (careersHost && options.careers) {
    const careers = options.careers
    await app.register(async (scope) => {
      // Every route the careers module registers answers on a careers host only (find-my-way matches the
      // Host header, as onCareersHost does), and is marked so the guard above lets it through there.
      scope.addHook('onRoute', (route) => {
        route.constraints = { ...route.constraints, host: careersHost }
        route.config = { ...route.config, careers: true }
      })
      await careers(scope, { db, config })
    })
  }

  // ------------------------------------------------------------------------------------------
  // The one-file app (production: the server serves it; development: Vite does)
  // ------------------------------------------------------------------------------------------

  if (appHtml && appPolicy) {
    // Only these two paths: nothing else from the app's folder is ever served.
    const sendApp = (_request: FastifyRequest, reply: FastifyReply) =>
      reply.header('Cache-Control', 'no-cache').header('Content-Security-Policy', appPolicy).type('text/html; charset=utf-8').send(appHtml)
    app.get('/', sendApp)
    app.get('/index.html', sendApp)
    // The offline worker (offline.ts), from memory. no-cache: the browser checks it for updates on every
    // visit. Its own policy (a worker obeys the CSP of its script) allows only fetches to this origin.
    app.get(SERVICE_WORKER_PATH, (_request, reply) =>
      reply
        .header('Cache-Control', 'no-cache')
        .header('Content-Security-Policy', SERVICE_WORKER_CSP)
        .type('application/javascript; charset=utf-8')
        .send(SERVICE_WORKER_JS),
    )
  }

  return app
}
