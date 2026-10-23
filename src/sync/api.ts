// Fetch client for the First Twenty server (docs/SYNC.md, "Protocol"). Same-origin only: the server serves
// the app, or the Vite dev server proxies /api. Every call resolves (never throws) to a typed result, so the
// engine can tell "offline" (network error or timeout) from "signed out" (401) from a server error.
import type { DB } from '@/domain/types'
import type {
  AccountResponse,
  Applied,
  CareersSwitchResponse,
  Change,
  ChangesResponse,
  ClientChange,
  Conflict,
  HealthResponse,
  InviteInfo,
  InviteResponse,
  LoginResponse,
  MeResponse,
  OpenInvite,
  PostChangesResponse,
  PutWorkspaceResponse,
  ServerWorkspace,
  SessionResponse,
  SignupModeResponse,
  SyncUser,
  WorkspaceSnapshot,
  WorkspaceStatus,
} from './protocol'

export type ApiErrorKind =
  | 'offline' // network error or timeout: nothing reached the server, or no answer came back
  | 'signed_out' // 401 on anything but login
  | 'invalid_credentials' // 401 on login
  | 'rate_limited' // 429
  | 'empty' // GET /api/workspace before the first upload (GET /api/workspace/status says so without an error)
  | 'not_empty' // PUT /api/workspace without confirmReplace on a server that has data
  | 'resync' // 409 {error: 'resync'} on POST /api/changes: the server's history changed (replace or restore)
  | 'email_taken' // 409 {error: 'email_taken'} on sign-up or accepting an invite: that email already has a login
  | 'too_large' // 413
  | 'forbidden' // 403 (CSRF guard, origin check, an invite asked for by a login that is not an admin)
  | 'not_found' // 404 other than 'empty': not a First Twenty server at this address (or sign-up closed, a bad invite)
  | 'bad_request' // other 4xx
  | 'demo_full' // 503 {error: 'demo_full'} on sign-up: the demo server holds as many companies as it may
  | 'server' // 5xx, including 503 from /api/health when the database is down
  | 'bad_response' // an answer that is not the JSON this client expects

export type ApiFailure = {
  ok: false
  kind: ApiErrorKind
  status: number | null
  /** The server's error code (`{error}`), never shown raw to users. */
  error: string | null
  /** Seconds, for rate_limited. */
  retryAfter?: number
}
export type ApiOk<T> = { ok: true; status: number; data: T }
export type ApiResult<T> = ApiOk<T> | ApiFailure

export type PushOptions = {
  keepalive?: boolean
  /** The history id this client last saw; the server refuses the whole push (kind 'resync') when it changed. */
  historyId?: string | null
}

/**
 * remember: "Keep me signed in". The server keeps a remembered session for SESSION_MAX_DAYS (7 days by
 * default) in a cookie that outlives the browser; otherwise the cookie ends with the browser and the
 * session after 12 hours at most. Default false. Servers from before this option ignore it (7 days).
 */
export type LoginOptions = { remember?: boolean }

/**
 * What workspaceStatus() learned. snapshot: the whole workspace, when a server from before the status
 * route had to be asked for it (GET /api/workspace), so the caller need not fetch it again.
 */
export type WorkspaceStatusResult = Extract<WorkspaceStatus, { empty: true }> | (Extract<WorkspaceStatus, { empty: false }> & { snapshot?: WorkspaceSnapshot })

/** fallback: on a server from before the status route, ask GET /api/workspace instead (default true). */
export type WorkspaceStatusOptions = { fallback?: boolean }

/** POST /api/auth/signup: a new login and a new company named companyName (remember as in LoginOptions). */
export type SignupInput = { email: string; password: string; companyName: string; remember?: boolean }

/** POST /api/auth/accept-invite: a new login in the company the invite token joins. */
export type AcceptInviteInput = { token: string; email: string; password: string; remember?: boolean }

export type SyncApi = {
  health(): Promise<ApiResult<HealthResponse>>
  /** POST /api/auth/login: the login and, on servers that hold companies, its company. */
  login(email: string, password: string, opts?: LoginOptions): Promise<ApiResult<LoginResponse>>
  logout(): Promise<ApiResult<null>>
  /**
   * GET /api/auth/me: 401 (kind 'signed_out') when there is no session. Also names the login's company,
   * its careers page and the sign-up mode on servers that hold companies (see MeResponse).
   */
  me(): Promise<ApiResult<MeResponse>>
  /**
   * GET /api/auth/signup-mode (public): whether anyone may create a demo company here. A server from
   * before demo sign-ups answers 404, which is 'closed'.
   */
  signupMode(): Promise<ApiResult<SignupModeResponse>>
  /**
   * POST /api/auth/signup: creates a login and its company and signs in (a session cookie, like login).
   * 404 (kind 'not_found') when sign-up is closed, 409 'email_taken', 503 'demo_full', 429 'rate_limited'.
   */
  signup(input: SignupInput): Promise<ApiResult<AccountResponse>>
  /** POST /api/invites (an admin): a single-use link that lets someone join this login's company. */
  createInvite(): Promise<ApiResult<InviteResponse>>
  /** GET /api/invites (an admin): the company's open invite links, without tokens. */
  listInvites(): Promise<ApiResult<OpenInvite[]>>
  /** DELETE /api/invites/:id (an admin): revokes an open link; 404 (kind 'not_found') when it was used, revoked or expired. */
  revokeInvite(id: string): Promise<ApiResult<null>>
  /**
   * POST /api/invites/lookup (public): the company an invite joins; 404 (kind 'not_found') for a bad,
   * used or expired one. The token goes in the body, where no proxy or access log keeps it.
   */
  inviteInfo(token: string): Promise<ApiResult<InviteInfo>>
  /** PUT /api/workspace/careers (an admin): turns the company's careers page on or off. */
  setCareers(enabled: boolean): Promise<ApiResult<CareersSwitchResponse>>
  /** POST /api/auth/accept-invite: creates a login in the invite's company and signs in; 404 bad token, 409 'email_taken'. */
  acceptInvite(input: AcceptInviteInput): Promise<ApiResult<AccountResponse>>
  /**
   * Who is signed in, without an error when nobody is: GET /api/auth/session answers {user: null} instead
   * of a 401 (which browsers log as a console error on every page load). A server from before that route
   * answers 404: then /api/auth/me is asked instead, and its 401 becomes {user: null}.
   */
  session(): Promise<ApiResult<SessionResponse>>
  getWorkspace(): Promise<ApiResult<WorkspaceSnapshot>>
  /**
   * Whether the server holds a workspace, without an error when it does not: GET /api/workspace/status
   * answers {empty: true} where GET /api/workspace answers 404 (a console error on every look at an empty
   * server). A server from before that route answers 404: from then on GET /api/workspace is asked
   * instead (its 'empty' becomes {empty: true}, and a workspace comes along as `snapshot`), or, with
   * fallback false, the answer is kind 'not_found' without asking.
   */
  workspaceStatus(opts?: WorkspaceStatusOptions): Promise<ApiResult<WorkspaceStatusResult>>
  putWorkspace(db: DB, confirmReplace?: boolean): Promise<ApiResult<PutWorkspaceResponse>>
  /** historyId: the one this client last saw; a different current history answers {resync: true}. */
  getChanges(since: number, historyId?: string | null): Promise<ApiResult<ChangesResponse>>
  postChanges(changes: ClientChange[], opts?: PushOptions): Promise<ApiResult<PostChangesResponse>>
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type ApiOptions = {
  /** Prefix for /api paths. '' (same origin) in the app; tests may point it elsewhere. */
  baseUrl?: string
  fetch?: FetchLike
  /** Ordinary calls. Default 20 s. */
  timeoutMs?: number
  /** Whole-workspace transfers (GET and PUT /api/workspace). Default 90 s. */
  longTimeoutMs?: number
}

export const CSRF_HEADER = 'X-First-Twenty'

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

type RequestSpec<T> = {
  method: Method
  path: string
  body?: unknown
  timeoutMs: number
  keepalive?: boolean
  /** 401 means wrong email or password (login) instead of an expired session. */
  login?: boolean
  /** Turns a 2xx JSON body into data, or null when the shape is wrong. */
  parse: (json: unknown, status: number) => T | null
}

export function createApi(options: ApiOptions = {}): SyncApi {
  const base = (options.baseUrl ?? '').replace(/\/+$/, '')
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const timeoutMs = options.timeoutMs ?? 20_000
  const longTimeoutMs = options.longTimeoutMs ?? 90_000

  async function request<T>(spec: RequestSpec<T>): Promise<ApiResult<T>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), spec.timeoutMs)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (spec.method !== 'GET') headers[CSRF_HEADER] = '1'
    let body: string | undefined
    if (spec.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(spec.body)
    }
    let res: Response
    let text: string
    try {
      res = await doFetch(base + spec.path, {
        method: spec.method,
        headers,
        body,
        credentials: 'same-origin',
        ...(spec.method === 'GET' ? { cache: 'no-store' as RequestCache } : {}),
        ...(spec.keepalive ? { keepalive: true } : {}),
        signal: controller.signal,
      })
      text = await res.text()
    } catch {
      return failure('offline', null, null)
    } finally {
      clearTimeout(timer)
    }
    let json: unknown = null
    let isJSON = text === ''
    if (text !== '') {
      try {
        json = JSON.parse(text)
        isJSON = true
      } catch {
        isJSON = false
      }
    }
    if (res.status >= 200 && res.status < 300) {
      if (!isJSON) return failure('bad_response', res.status, null)
      const data = spec.parse(json, res.status)
      return data === null ? failure('bad_response', res.status, null) : { ok: true, status: res.status, data }
    }
    return errorFor(res, isJSON ? json : null, spec.login === true)
  }

  const me = () => request<MeResponse>({ method: 'GET', path: '/api/auth/me', timeoutMs, parse: parseMe })
  /** False once the server answered 404 to /api/auth/session (it predates the route). */
  let sessionRoute = true
  const getWorkspace = () => request<WorkspaceSnapshot>({ method: 'GET', path: '/api/workspace', timeoutMs: longTimeoutMs, parse: parseSnapshot })
  /** False once the server answered 404 to /api/workspace/status (it predates the route). */
  let statusRoute = true

  return {
    health: () =>
      request<HealthResponse>({
        method: 'GET',
        path: '/api/health',
        timeoutMs,
        parse: (j) => (isObj(j) && j.ok === true ? { ok: true, db: 'up', version: typeof j.version === 'string' ? j.version : '' } : null),
      }),
    login: (email, password, opts) =>
      request<LoginResponse>({
        method: 'POST',
        path: '/api/auth/login',
        body: { email, password, remember: opts?.remember === true },
        timeoutMs,
        login: true,
        parse: parseLogin,
      }),
    // 204 with no body; any 2xx counts as signed out.
    logout: () =>
      request<true>({ method: 'POST', path: '/api/auth/logout', timeoutMs, parse: () => true }).then((r): ApiResult<null> =>
        r.ok ? { ok: true, status: r.status, data: null } : r,
      ),
    me,
    signupMode: async () => {
      const r = await request<SignupModeResponse>({ method: 'GET', path: '/api/auth/signup-mode', timeoutMs, parse: parseSignupMode })
      // A server from before demo sign-ups has no such route: nobody may sign up there.
      return !r.ok && r.kind === 'not_found' ? { ok: true, status: r.status ?? 404, data: { signupMode: 'closed' } } : r
    },
    signup: (input) =>
      request<AccountResponse>({
        method: 'POST',
        path: '/api/auth/signup',
        body: { email: input.email, password: input.password, companyName: input.companyName, remember: input.remember === true },
        timeoutMs,
        parse: parseAccount,
      }),
    // No body: the route needs none, and Fastify refuses an empty body sent as JSON.
    createInvite: () => request<InviteResponse>({ method: 'POST', path: '/api/invites', timeoutMs, parse: parseInvite }),
    listInvites: () =>
      request<OpenInvite[]>({ method: 'GET', path: '/api/invites', timeoutMs, parse: (j) => (isObj(j) && Array.isArray(j.invites) ? j.invites.flatMap(parseOpenInvite) : null) }),
    revokeInvite: (id) =>
      request<true>({ method: 'DELETE', path: `/api/invites/${encodeURIComponent(id)}`, timeoutMs, parse: () => true }).then((r): ApiResult<null> =>
        r.ok ? { ok: true, status: r.status, data: null } : r,
      ),
    inviteInfo: (token) =>
      request<InviteInfo>({
        method: 'POST',
        path: '/api/invites/lookup',
        body: { token },
        timeoutMs,
        parse: (j) => (isObj(j) && typeof j.companyName === 'string' ? { companyName: j.companyName } : null),
      }),
    setCareers: (enabled) =>
      request<CareersSwitchResponse>({
        method: 'PUT',
        path: '/api/workspace/careers',
        body: { enabled },
        timeoutMs,
        parse: (j) => (isObj(j) && typeof j.careersEnabled === 'boolean' ? { careersUrl: httpUrl(j.careersUrl), careersEnabled: j.careersEnabled } : null),
      }),
    acceptInvite: (input) =>
      request<AccountResponse>({
        method: 'POST',
        path: '/api/auth/accept-invite',
        body: { token: input.token, email: input.email, password: input.password, remember: input.remember === true },
        timeoutMs,
        parse: parseAccount,
      }),
    session: async () => {
      if (sessionRoute) {
        const r = await request<SessionResponse>({ method: 'GET', path: '/api/auth/session', timeoutMs, parse: parseSessionBody })
        if (r.ok) return r
        if (r.kind === 'signed_out') return { ok: true, status: r.status ?? 401, data: { user: null } }
        if (r.kind !== 'not_found') return r
        // A server from before /api/auth/session: ask it the old way from now on.
        sessionRoute = false
      }
      const r = await me()
      if (r.ok) return r
      return r.kind === 'signed_out' ? { ok: true, status: r.status ?? 401, data: { user: null } } : r
    },
    getWorkspace,
    workspaceStatus: async (opts) => {
      if (statusRoute) {
        const r = await request<WorkspaceStatusResult>({ method: 'GET', path: '/api/workspace/status', timeoutMs, parse: parseWorkspaceStatus })
        if (r.ok || r.kind !== 'not_found') return r
        // A server from before /api/workspace/status: ask it the old way from now on.
        statusRoute = false
      }
      if (opts?.fallback === false) return failure('not_found', 404, 'not_found')
      const snap = await getWorkspace()
      if (snap.ok) {
        const { workspaceId, historyId, seq } = snap.data
        return { ok: true, status: snap.status, data: { empty: false, workspaceId, ...(historyId ? { historyId } : {}), seq, snapshot: snap.data } }
      }
      return snap.kind === 'empty' ? { ok: true, status: snap.status ?? 404, data: { empty: true } } : snap
    },
    putWorkspace: (db, confirmReplace) =>
      request<PutWorkspaceResponse>({
        method: 'PUT',
        path: '/api/workspace',
        body: confirmReplace ? { db, confirmReplace: true } : { db },
        timeoutMs: longTimeoutMs,
        parse: (j) => {
          if (!isObj(j)) return null
          const seq = num(j.seq)
          const versions = parseVersions(j.versions)
          if (seq === null || !versions) return null
          const out: PutWorkspaceResponse = { seq, versions }
          const historyId = str(j.historyId)
          if (historyId) out.historyId = historyId
          const workspaceId = str(j.workspaceId)
          if (workspaceId) out.workspaceId = workspaceId
          return out
        },
      }),
    getChanges: (since, historyId) =>
      request<ChangesResponse>({
        method: 'GET',
        path: `/api/changes?since=${encodeURIComponent(String(Math.max(0, Math.floor(since))))}${historyId ? `&history=${encodeURIComponent(historyId)}` : ''}`,
        timeoutMs,
        parse: parseChanges,
      }),
    postChanges: (changes, opts) =>
      request<PostChangesResponse>({
        method: 'POST',
        path: '/api/changes',
        body: opts?.historyId ? { changes, historyId: opts.historyId } : { changes },
        timeoutMs,
        keepalive: opts?.keepalive,
        parse: parsePostChanges,
      }),
  }
}

function failure(kind: ApiErrorKind, status: number | null, error: string | null, retryAfter?: number): ApiFailure {
  return retryAfter === undefined ? { ok: false, kind, status, error } : { ok: false, kind, status, error, retryAfter }
}

function errorFor(res: Response, json: unknown, login: boolean): ApiFailure {
  const status = res.status
  const error = isObj(json) && typeof json.error === 'string' ? json.error : null
  if (status === 401) return failure(login ? 'invalid_credentials' : 'signed_out', status, error)
  if (status === 429) {
    const fromBody = isObj(json) ? num(json.retryAfter) : null
    const fromHeader = num(res.headers.get('Retry-After'))
    return failure('rate_limited', status, error, fromBody ?? fromHeader ?? 900)
  }
  if (status === 404 && error === 'empty') return failure('empty', status, error)
  if (status === 409 && error === 'resync') return failure('resync', status, error)
  if (status === 409 && error === 'email_taken') return failure('email_taken', status, error)
  if (status === 409 || error === 'not_empty') return failure('not_empty', status, error)
  if (status === 413) return failure('too_large', status, error)
  if (status === 403) return failure('forbidden', status, error)
  if (status === 404) return failure('not_found', status, error)
  if (status === 503 && error === 'demo_full') return failure('demo_full', status, error)
  if (status >= 500) return failure('server', status, error)
  if (status >= 400) return failure('bad_request', status, error)
  return failure('bad_response', status, error)
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** Numbers, or numeric strings (Postgres bigint columns often arrive as strings). */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

/** A non-empty string, or null. */
function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

function parseUser(u: unknown): SyncUser | null {
  if (!isObj(u) || typeof u.id !== 'string' || typeof u.email !== 'string') return null
  return { id: u.id, email: u.email, role: typeof u.role === 'string' ? u.role : 'admin' }
}

function parseUserBody(j: unknown): { user: SyncUser } | null {
  const user = isObj(j) ? parseUser(j.user) : null
  return user ? { user } : null
}

/** {user, workspace?} from POST /api/auth/login (workspace only from servers that hold companies). */
function parseLogin(j: unknown): LoginResponse | null {
  const body = parseUserBody(j)
  if (!body || !isObj(j)) return null
  const workspace = parseWorkspace(j.workspace)
  return workspace ? { user: body.user, workspace } : body
}

function parseOpenInvite(j: unknown): OpenInvite[] {
  if (!isObj(j) || typeof j.id !== 'string' || typeof j.expiresAt !== 'string') return []
  return [{ id: j.id, createdAt: typeof j.createdAt === 'string' ? j.createdAt : '', expiresAt: j.expiresAt, createdBy: typeof j.createdBy === 'string' ? j.createdBy : null }]
}

/**
 * An absolute http(s) address, or null. Addresses from the server end up in links (the careers page, an
 * invite), so anything else (a javascript: URL, a relative path) is dropped rather than rendered.
 */
export function httpUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 2048) return null
  try {
    const u = new URL(v)
    return u.protocol === 'https:' || u.protocol === 'http:' ? v : null
  } catch {
    return null
  }
}

function parseWorkspace(w: unknown): ServerWorkspace | null {
  if (!isObj(w) || typeof w.id !== 'string' || typeof w.name !== 'string') return null
  return { id: w.id, name: w.name, slug: typeof w.slug === 'string' ? w.slug : '' }
}

/** GET /api/auth/me: the user, plus the company, careers page and sign-up mode when the server sends them. */
function parseMe(j: unknown): MeResponse | null {
  const body = parseUserBody(j)
  if (!body || !isObj(j)) return null
  const out: MeResponse = { user: body.user }
  const workspace = parseWorkspace(j.workspace)
  if (workspace) out.workspace = workspace
  if ('careersUrl' in j) out.careersUrl = httpUrl(j.careersUrl)
  if (typeof j.careersEnabled === 'boolean') out.careersEnabled = j.careersEnabled
  if (j.signupMode === 'open' || j.signupMode === 'closed') out.signupMode = j.signupMode
  return out
}

/** Anything but 'open' is closed: a demo server must say so plainly before anyone is offered to sign up. */
function parseSignupMode(j: unknown): SignupModeResponse | null {
  if (!isObj(j)) return null
  const out: SignupModeResponse = { signupMode: j.signupMode === 'open' ? 'open' : 'closed' }
  const days = num(j.demoExpireDays)
  if (days !== null && days >= 0 && Number.isInteger(days)) out.demoExpireDays = days
  return out
}

/** {user, workspace} from sign-up and accepting an invite (workspace null when the server leaves it out). */
function parseAccount(j: unknown): AccountResponse | null {
  const body = parseUserBody(j)
  if (!body || !isObj(j)) return null
  return { user: body.user, workspace: parseWorkspace(j.workspace) }
}

function parseInvite(j: unknown): InviteResponse | null {
  if (!isObj(j)) return null
  const url = httpUrl(j.url)
  return url && typeof j.expiresAt === 'string' ? { url, expiresAt: j.expiresAt } : null
}

/** {user: SyncUser | null} from GET /api/auth/session. */
function parseSessionBody(j: unknown): SessionResponse | null {
  if (!isObj(j) || !('user' in j)) return null
  if (j.user === null) return { user: null }
  const user = parseUser(j.user)
  if (!user) return null
  const workspace = parseWorkspace(j.workspace)
  return workspace ? { user, workspace } : { user }
}

function parseVersions(v: unknown): Record<string, number> | null {
  if (!isObj(v)) return null
  const out: Record<string, number> = {}
  for (const [k, n] of Object.entries(v)) {
    const x = num(n)
    if (x !== null) out[k] = x
  }
  return out
}

function parseSnapshot(j: unknown): WorkspaceSnapshot | null {
  if (!isObj(j) || !isObj(j.db)) return null
  const seq = num(j.seq)
  const versions = parseVersions(j.versions)
  if (seq === null || !versions) return null
  const snap: WorkspaceSnapshot = { workspaceId: typeof j.workspaceId === 'string' ? j.workspaceId : 'default', seq, db: j.db as unknown as DB, versions }
  const historyId = str(j.historyId)
  if (historyId) snap.historyId = historyId
  return snap
}

/** {empty: true}, or {empty: false, workspaceId, historyId?, seq} from GET /api/workspace/status. */
function parseWorkspaceStatus(j: unknown): WorkspaceStatusResult | null {
  if (!isObj(j)) return null
  if (j.empty === true) return { empty: true }
  if (j.empty !== false) return null
  const seq = num(j.seq)
  if (seq === null) return null
  const historyId = str(j.historyId)
  const workspaceId = typeof j.workspaceId === 'string' ? j.workspaceId : 'default'
  return historyId ? { empty: false, workspaceId, historyId, seq } : { empty: false, workspaceId, seq }
}

function parseChange(c: unknown): Change | null {
  if (!isObj(c) || typeof c.collection !== 'string' || typeof c.id !== 'string') return null
  if (c.op !== 'upsert' && c.op !== 'delete') return null
  const seq = num(c.seq)
  const version = num(c.version)
  if (seq === null || version === null) return null
  return c.op === 'upsert'
    ? { seq, collection: c.collection, id: c.id, op: 'upsert', version, data: c.data }
    : { seq, collection: c.collection, id: c.id, op: 'delete', version }
}

function parseChanges(j: unknown): ChangesResponse | null {
  if (!isObj(j)) return null
  if (j.resync === true) return { resync: true }
  const seq = num(j.seq)
  if (seq === null || !Array.isArray(j.changes)) return null
  const changes: Change[] = []
  for (const c of j.changes) {
    const parsed = parseChange(c)
    if (!parsed) return null
    changes.push(parsed)
  }
  changes.sort((a, b) => a.seq - b.seq)
  const historyId = str(j.historyId)
  return historyId ? { historyId, seq, changes, more: j.more === true } : { seq, changes, more: j.more === true }
}

function parsePostChanges(j: unknown): PostChangesResponse | null {
  if (!isObj(j) || !Array.isArray(j.applied) || !Array.isArray(j.conflicts)) return null
  const seq = num(j.seq)
  if (seq === null) return null
  const applied: Applied[] = []
  for (const a of j.applied) {
    const version = isObj(a) ? num(a.version) : null
    if (!isObj(a) || typeof a.collection !== 'string' || typeof a.id !== 'string' || version === null) return null
    applied.push(a.existing === true ? { collection: a.collection, id: a.id, version, existing: true } : { collection: a.collection, id: a.id, version })
  }
  const conflicts: Conflict[] = []
  for (const c of j.conflicts) {
    if (!isObj(c) || typeof c.collection !== 'string' || typeof c.id !== 'string') return null
    const conflict: Conflict = { collection: c.collection, id: c.id, serverVersion: num(c.serverVersion), serverData: c.serverData ?? null }
    if (c.byYou === true) conflict.byYou = true
    if (c.landed === true) conflict.landed = true
    conflicts.push(conflict)
  }
  const historyId = str(j.historyId)
  return historyId ? { historyId, seq, applied, conflicts } : { seq, applied, conflicts }
}

/** Plain-language text for a failure (copy rules: what went wrong and what happens next or how to fix it). */
export function describeFailure(f: Pick<ApiFailure, 'kind' | 'status' | 'error' | 'retryAfter'>): string {
  switch (f.kind) {
    case 'offline':
      return 'Cannot reach the server. Changes stay in this browser and sync when the connection returns.'
    case 'signed_out':
      return 'Signed out of the server. Sign in to keep syncing; changes stay in this browser until then.'
    case 'invalid_credentials':
      return 'That email and password do not match. Check both and try again.'
    case 'rate_limited': {
      const minutes = Math.max(1, Math.ceil((f.retryAfter ?? 900) / 60))
      const wait = `${minutes} minute${minutes === 1 ? '' : 's'}`
      // A demo company writing faster than the demo server allows (server/src/writeBudget.ts).
      if (f.error === 'write_limit') return `This demo company sent changes faster than the demo server allows. They wait in this browser and go out on their own, within ${wait}.`
      return `Too many sign-in attempts. Try again in ${wait}.`
    }
    case 'empty':
      return 'The server has no workspace yet. Upload this browser\'s workspace to start.'
    case 'not_empty':
      return 'The server already has a workspace. Confirm to replace it, or use the server\'s copy.'
    case 'resync':
      return "Your server's workspace was replaced or restored since this browser last synced. This browser loads it again before sending changes."
    case 'email_taken':
      return 'That email already has a login on this server. Sign in with it instead, or use another email.'
    case 'demo_full':
      return 'This demo server holds as many demo companies as it can right now. Try again later.'
    case 'too_large':
      // A demo company at its demo limits (records, bytes, or the demo server's room for all of them).
      if (f.error === 'workspace_full') return 'This demo company is as full as the demo server allows. Remove old activity or large notes, then try again.'
      return 'The upload is larger than the server accepts. Remove large notes or old activity and try again.'
    case 'forbidden':
      return 'The server refused the request. Open the app from the server\'s own address and try again.'
    case 'not_found':
      return 'No First Twenty server answered at this address. Check the address and that the server is running.'
    case 'bad_request':
      return `The server refused the request (error ${f.status ?? 400}). Changes stay in this browser.`
    case 'server':
      return f.error === 'db_down' || f.status === 503
        ? 'The server is up but its database is not answering. Changes stay in this browser; syncing retries on its own.'
        : `The server had a problem (error ${f.status ?? 500}). Changes stay in this browser; syncing retries on its own.`
    case 'bad_response':
      return 'The server sent an answer this app does not understand. Check that the address points to a First Twenty server.'
  }
}
