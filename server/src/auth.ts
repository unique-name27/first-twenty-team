// Passwords, sessions and the login rate limit (docs/SYNC.md, Security rules).
// - Passwords: scrypt (N=2^15, r=8, p=1, 16-byte salt, 64-byte key), compared in constant time.
// - Sessions: a random 32-byte token in an HttpOnly cookie; only its SHA-256 is stored. Idle and
//   absolute expiry; last_seen_at is refreshed at most once a minute. A sign-in without "Keep me
//   signed in" gets a browser-session cookie and a 12-hour absolute expiry; with it, SESSION_MAX_DAYS.
//   Over https the cookie is __Host-ft_session (Path=/), which no other site can plant or shadow, not
//   even a sibling host under a shared domain such as *.sslip.io; over plain http it is ft_session.
// - Trusted devices: a successful sign-in also gives the browser a 180-day device cookie (only its
//   SHA-256 is stored, in trusted_devices). It grants no access on its own.
// - Login rate limit (in memory, per process), three sliding windows of 15 minutes: per client address
//   (10 attempts; IPv6 counts per /64), per email from one address (10 attempts, cleared by a
//   successful sign-in) and per email from anywhere (100 failures only), so one address cannot lock
//   the only admin out. Many addresses can: whoever reaches the 100 failures locks that email out
//   everywhere. So a sign-in from a trusted device of that same login skips all three and has a
//   limit of its own (10 attempts per device), and the owner keeps signing in from the browsers they
//   already use. The email is normalized once (loginEmail) and that one string is both the key and
//   the lookup. A sign-in that cannot succeed counts against its address only. An email key holding a
//   lockout is never dropped to make room for others; when every address key holds one, the oldest
//   address lockout is forgotten, so cheap sign-ins from many addresses cannot lock everyone out.
// - Password checks (scrypt, 32 MiB each) run at most two at a time; a long queue is refused.
// - Every login belongs to one workspace (users.workspace_id, migration 004). A session resolves to its
//   login's workspace, and that is the only place any route takes a workspace from.
// - Account creation (demo sign-ups and accepted invites) has a limit of its own, per client address and
//   for the whole server, in sliding windows of an hour (AddressRateLimiter).
import { createHash, randomBytes, scrypt as scryptCb, type ScryptOptions, timingSafeEqual } from 'node:crypto'
import { isIPv4, isIPv6 } from 'node:net'
import type { Config } from './config'
import type { Db, Queryable } from './db'
import { WORKSPACE_ID } from './sqlgen'

/** The session cookie over plain http (development, the SSH tunnel): host-only, sent to /api only. */
export const SESSION_COOKIE = 'ft_session'
/**
 * The session cookie over https. Browsers refuse a __Host- cookie unless it is Secure, has Path=/ and
 * no Domain, so a page on another host cannot set one, and an ft_session it planted for a shared parent
 * domain (sslip.io is not a public suffix) is simply never read.
 */
export const SECURE_SESSION_COOKIE = '__Host-ft_session'
/** The trusted-device cookie, over plain http and over https (see SECURE_SESSION_COOKIE). */
export const DEVICE_COOKIE = 'ft_device'
export const SECURE_DEVICE_COOKIE = '__Host-ft_device'
/** How long a trusted-device cookie lasts after the sign-in that set it. */
export const DEVICE_TRUST_DAYS = 180
/** Most trusted devices kept per user; a sign-in on one more forgets the oldest. */
export const MAX_DEVICES_PER_USER = 20

export type CookieSpec = { name: string; options: { httpOnly: true; sameSite: 'strict'; secure: boolean; path: string } }

/**
 * The session and trusted-device cookies for a request over https (`secure`) or plain http. Every set,
 * read and clear of a cookie must use the spec of the same request, or the browser keeps the old one.
 */
export function authCookies(secure: boolean): { session: CookieSpec; device: CookieSpec } {
  const options = { httpOnly: true as const, sameSite: 'strict' as const, secure, path: secure ? '/' : '/api' }
  return {
    session: { name: secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE, options },
    device: { name: secure ? SECURE_DEVICE_COOKIE : DEVICE_COOKIE, options },
  }
}

/** How many times cookie `name` appears in a Cookie header (a browser sends one per path and domain). */
export function cookieCount(header: string | undefined, name: string): number {
  if (!header) return 0
  return header.split(';').filter((pair) => pair.trimStart().startsWith(`${name}=`)).length
}

export const MIN_PASSWORD_LENGTH = 12
export const MAX_PASSWORD_LENGTH = 1024

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64, saltBytes: 16 }
// 128 * N * r = 32 MiB for the default parameters; leave headroom over Node's 32 MiB default.
const MAXMEM = 96 * 1024 * 1024

function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize('NFKC'), salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)))
  })
}

/** 'scrypt$N$r$p$<salt base64>$<key base64>' */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT.saltBytes)
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: MAXMEM })
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$')
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [N, r, p] = parts.slice(1, 4).map(Number)
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0) || N > 2 ** 20 || r > 32 || p > 16) return false
  const salt = Buffer.from(parts[4], 'base64')
  const expected = Buffer.from(parts[5], 'base64')
  if (salt.length === 0 || expected.length === 0) return false
  const actual = await scrypt(password, salt, expected.length, { N, r, p, maxmem: Math.max(MAXMEM, 256 * N * r) })
  return timingSafeEqual(actual, expected)
}

let dummyHash: Promise<string> | null = null
/** Spends the same time as a real check so unknown emails cannot be told apart by timing. */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(18).toString('base64'))
  await verifyPassword(password, await dummyHash)
}

/** The longest email address there can be (RFC 5321), counted after normalizeEmail. */
export const MAX_EMAIL_LENGTH = 254

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * The email a sign-in is for, normalized once: the login route uses this one string as the rate-limit
 * key and for the lookup, so no padding can count under one key and match another. null when it is
 * empty or longer than MAX_EMAIL_LENGTH after normalizing (no login can have it), and it is never cut
 * short, since a cut string could normalize to someone else's email.
 */
export function loginEmail(raw: string): string | null {
  const email = normalizeEmail(raw)
  return email.length > 0 && email.length <= MAX_EMAIL_LENGTH ? email : null
}

export function isValidEmail(email: string): boolean {
  return email.length >= 3 && email.length <= MAX_EMAIL_LENGTH && /^[^\s@]+@[^\s@]+$/.test(email)
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** A login as the API shows it ({user} in every answer). */
export type SessionUser = { id: string; email: string; role: string }
/**
 * A login as the server uses it: the API's fields plus the one workspace it belongs to (never sent in
 * {user}). keep: whether that workspace is kept (findSession says; absent elsewhere), so the routes know a
 * demo company's login, which the demo write limits apply to.
 */
export type AuthUser = SessionUser & { workspaceId: string; keep?: boolean }

/** The {user} the API answers with: the workspace id stays out of every answer that names a user. */
export function publicUser(user: SessionUser): SessionUser {
  return { id: user.id, email: user.email, role: user.role }
}

export type SessionMeta = { ip?: string; userAgent?: string }

/**
 * Absolute lifetime of a sign-in without "Keep me signed in": its cookie is a browser-session cookie
 * (no Max-Age), and the server ends it after this many hours even if the browser stays open.
 */
export const SHORT_SESSION_HOURS = 12

/** How long a session may live at most: SESSION_MAX_DAYS when remembered, else SHORT_SESSION_HOURS (never longer than the maximum). */
export function sessionLifetimeMs(config: Pick<Config, 'sessionMaxDays'>, remember: boolean): number {
  const max = config.sessionMaxDays * 86_400_000
  return remember ? max : Math.min(max, SHORT_SESSION_HOURS * 3_600_000)
}

/**
 * Creates a session and returns the raw token for the cookie (never stored). `remember` (default true,
 * the longest lifetime) picks the absolute expiry; see sessionLifetimeMs.
 */
export async function createSession(
  db: Queryable,
  userId: string,
  config: Pick<Config, 'sessionMaxDays'>,
  meta: SessionMeta = {},
  remember = true,
): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  const expires = new Date(Date.now() + sessionLifetimeMs(config, remember))
  await db.query(
    'INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent) VALUES ($1, $2, $3, $4, $5)',
    [hashToken(token), userId, expires.toISOString(), meta.ip?.slice(0, 64) ?? null, meta.userAgent?.slice(0, 256) ?? null],
  )
  return token
}

const REFRESH_MS = 60_000

/**
 * The signed-in user for a cookie token, with the workspace its login belongs to, or null when it is
 * unknown, idle too long or past its expiry.
 */
export async function findSession(
  db: Queryable,
  token: string | undefined,
  config: Pick<Config, 'sessionIdleHours'>,
): Promise<AuthUser | null> {
  if (!token || token.length > 200) return null
  const hash = hashToken(token)
  const r = await db.query<{
    user_id: string
    email: string
    role: string
    workspace_id: string
    keep: boolean
    last_seen_at: Date | string
    expires_at: Date | string
  }>(
    `SELECT s.user_id, s.last_seen_at, s.expires_at, u.email, u.role, u.workspace_id, w.keep
       FROM sessions s JOIN users u ON u.id = s.user_id JOIN workspaces w ON w.id = u.workspace_id
      WHERE s.token_hash = $1`,
    [hash],
  )
  const row = r.rows[0]
  if (!row) return null
  const now = Date.now()
  const lastSeen = new Date(row.last_seen_at).getTime()
  const expires = new Date(row.expires_at).getTime()
  if (expires <= now || lastSeen + config.sessionIdleHours * 3_600_000 <= now) {
    await db.query('DELETE FROM sessions WHERE token_hash = $1', [hash])
    return null
  }
  if (now - lastSeen > REFRESH_MS) {
    await db.query('UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1', [hash])
  }
  return { id: row.user_id, email: row.email, role: row.role, workspaceId: row.workspace_id, keep: row.keep === true }
}

export async function deleteSession(db: Queryable, token: string | undefined): Promise<void> {
  if (!token || token.length > 200) return
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)])
}

/** The shape of every token this server makes: 32 random bytes in base64url. Anything else is not looked up. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

/** True for a string shaped like a token this server makes (sessions, devices, invites); only those are looked up. */
export function isTokenShape(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_RE.test(value)
}

/** A new random token (32 bytes, base64url) for a cookie or a link. Only its hashToken() is ever stored. */
export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * The hash of a trusted-device token when it belongs to the login `email` (from loginEmail) and has not
 * expired, else null: an unknown, expired or malformed token, or another login's device.
 */
export async function findTrustedDevice(db: Queryable, token: string | undefined, email: string): Promise<string | null> {
  if (!token || !TOKEN_RE.test(token)) return null
  const hash = hashToken(token)
  const r = await db.query<{ email: string }>(
    `SELECT u.email FROM trusted_devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = $1 AND d.expires_at > now()`,
    [hash],
  )
  return r.rows[0]?.email === email ? hash : null
}

/**
 * Trusts the browser a user just signed in from and returns the raw token for its cookie (never stored).
 * The token it sent before, if any, is replaced, and the user keeps at most MAX_DEVICES_PER_USER
 * devices, the newest, none expired.
 */
export async function trustDevice(db: Queryable, userId: string, previousToken?: string): Promise<string> {
  if (previousToken && TOKEN_RE.test(previousToken)) {
    await db.query('DELETE FROM trusted_devices WHERE token_hash = $1', [hashToken(previousToken)])
  }
  const token = randomBytes(32).toString('base64url')
  await db.query(
    `INSERT INTO trusted_devices (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3::int))`,
    [hashToken(token), userId, DEVICE_TRUST_DAYS],
  )
  await db.query(
    `DELETE FROM trusted_devices
      WHERE user_id = $1
        AND (expires_at <= now()
             OR token_hash NOT IN (SELECT token_hash FROM trusted_devices WHERE user_id = $1 ORDER BY created_at DESC, token_hash LIMIT $2))`,
    [userId, MAX_DEVICES_PER_USER],
  )
  return token
}

/** Removes expired and idle sessions (run on login and on a timer). */
export async function purgeSessions(db: Queryable, config: Pick<Config, 'sessionIdleHours'>): Promise<number> {
  const r = await db.query(
    `DELETE FROM sessions WHERE expires_at <= now() OR last_seen_at <= now() - make_interval(hours => $1::int)`,
    [config.sessionIdleHours],
  )
  return r.rowCount
}

/**
 * Checks email and password. Returns the user, or null (same timing whether or not the email exists).
 * The email is normalized again here, which leaves a loginEmail() string unchanged, so the login route
 * looks up the very string it rate-limited.
 */
export async function checkCredentials(db: Queryable, email: string, password: string): Promise<AuthUser | null> {
  const r = await db.query<{ id: string; email: string; role: string; workspace_id: string; password_hash: string }>(
    'SELECT id, email, role, workspace_id, password_hash FROM users WHERE email = $1',
    [normalizeEmail(email)],
  )
  const user = r.rows[0]
  if (!user) {
    await burnPasswordCheck(password)
    return null
  }
  if (!(await verifyPassword(password, user.password_hash))) return null
  return { id: user.id, email: user.email, role: user.role, workspaceId: user.workspace_id }
}

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`
  if (password.length > MAX_PASSWORD_LENGTH) return `The password must be at most ${MAX_PASSWORD_LENGTH} characters.`
  return null
}

export type UpsertAdminResult = { id: string; email: string; created: boolean; previousEmail: string | null }

/**
 * Creates the admin of a workspace (the server's own, WORKSPACE_ID, by default), or updates it (email and
 * password) when one exists. Existing sessions of that admin are signed out and its trusted devices
 * forgotten. The id is kept, so updated_by references stay valid. Only this workspace's logins count:
 * the admins of demo companies on the same server are never touched, and an email that already signs in
 * to another company is refused (one login belongs to one company).
 */
export async function upsertAdmin(db: Db, rawEmail: string, password: string, workspaceId = WORKSPACE_ID): Promise<UpsertAdminResult> {
  const email = normalizeEmail(rawEmail)
  if (!isValidEmail(email)) throw new Error('Enter a valid email address, like you@company.com.')
  const problem = passwordProblem(password)
  if (problem) throw new Error(problem)
  const hash = await hashPassword(password)
  return db.tx(async (q) => {
    const admins = await q.query<{ id: string; email: string }>(
      `SELECT id, email FROM users WHERE role = 'admin' AND workspace_id = $1 ORDER BY created_at FOR UPDATE`,
      [workspaceId],
    )
    const target = admins.rows.find((a) => a.email === email) ?? admins.rows[0]
    if (!target) {
      // A non-admin login of this workspace may hold this email; promote it instead of failing. A login
      // of another workspace is left alone: the WHERE leaves that conflict unresolved, so no row returns.
      const r = await q.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, workspace_id) VALUES ($1, $2, 'admin', $3)
         ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin'
           WHERE users.workspace_id = EXCLUDED.workspace_id
         RETURNING id`,
        [email, hash, workspaceId],
      )
      if (r.rows.length === 0) throw new Error(`Another company on this server already has a login with ${email}. Choose another email.`)
      await q.query('DELETE FROM sessions WHERE user_id = $1', [r.rows[0].id])
      await q.query('DELETE FROM trusted_devices WHERE user_id = $1', [r.rows[0].id])
      return { id: r.rows[0].id, email, created: true, previousEmail: null }
    }
    if (target.email !== email) {
      const clash = await q.query('SELECT 1 FROM users WHERE email = $1 AND id <> $2', [email, target.id])
      if (clash.rows.length > 0) throw new Error(`Another login already uses ${email}.`)
    }
    await q.query('UPDATE users SET email = $1, password_hash = $2 WHERE id = $3', [email, hash, target.id])
    await q.query('DELETE FROM sessions WHERE user_id = $1', [target.id])
    await q.query('DELETE FROM trusted_devices WHERE user_id = $1', [target.id])
    return { id: target.id, email, created: false, previousEmail: target.email === email ? null : target.email }
  })
}

// ---------------------------------------------------------------------------------------------
// Login rate limit
// ---------------------------------------------------------------------------------------------

export type RateLimitResult = { ok: true } | { ok: false; retryAfter: number }

/** Expands a valid IPv6 address to its eight 16-bit groups. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.split('%')[0].toLowerCase()
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number)
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const groups =
    halves.length === 2 ? [...head, ...Array<string>(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head
  if (groups.length !== 8) return null
  const out = groups.map((g) => Number.parseInt(g || '0', 16))
  return out.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? out : null
}

/**
 * The rate-limit identity of a client address: IPv4 addresses as they are (IPv4-mapped IPv6 included),
 * IPv6 addresses by their /64, since one host usually controls a whole /64 and could rotate through it.
 */
export function clientAddressKey(ip: string): string {
  if (isIPv4(ip)) return ip
  if (isIPv6(ip)) {
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip)
    if (mapped) return mapped[1]
    const groups = ipv6Groups(ip)
    if (groups) return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`
  }
  return ip.slice(0, 64)
}

/**
 * Sliding-window hit counts per key, in memory, for one limit. The map is bounded: when it is full, a
 * new key pushes out the least recently used key that is below the limit. A key at the limit holds a
 * lockout and is never pushed out, or forgetting it would lift the lockout. When every key holds one,
 * a new key is refused (add returns false; secondsUntilRoom says for how long) while the keys already
 * kept go on as before, unless `forgetLockouts` is set: then the oldest lockout is forgotten to make
 * room. Only sweep walks the keys, and the owner runs it on a timer, never per request.
 */
export class SlidingWindowCounter {
  /** Keys below the limit, least recently used first: these may be pushed out. */
  private readonly open = new Map<string, number[]>()
  /** Keys at the limit (a lockout in force), in the order their lockouts began: never pushed out. */
  private readonly locked = new Map<string, number[]>()
  readonly windowMs: number
  readonly maxKeys: number
  readonly limit: number
  readonly forgetLockouts: boolean

  /**
   * `limit`: the hit count at which a key holds a lockout (default: never, so any key may go).
   * `forgetLockouts`: when every key holds a lockout, a new key pushes out the oldest one instead of
   * being refused. For a limit whose keys are cheap to fill: refusing would let whoever fills it lock
   * every new key out.
   */
  constructor(windowMs: number, maxKeys: number, limit = Number.POSITIVE_INFINITY, opts: { forgetLockouts?: boolean } = {}) {
    this.windowMs = windowMs
    this.maxKeys = Math.max(1, maxKeys)
    this.limit = Math.max(1, limit)
    this.forgetLockouts = opts.forgetLockouts === true
  }

  /** Stores a key's hits where they belong; a key already in a map keeps its place there. */
  private store(key: string, list: number[]): void {
    if (list.length === 0) {
      this.open.delete(key)
      this.locked.delete(key)
    } else if (list.length >= this.limit) {
      this.open.delete(key)
      this.locked.set(key, list)
    } else {
      // Below the limit. A lockout that ended or was taken back joins the open keys at the end: it may
      // be pushed out again, but not first.
      this.locked.delete(key)
      this.open.set(key, list)
    }
  }

  private recent(key: string, now: number): number[] {
    const list = this.locked.get(key) ?? this.open.get(key)
    if (!list) return []
    const kept = list.filter((t) => t > now - this.windowMs)
    if (kept.length !== list.length) this.store(key, kept)
    return kept
  }

  count(key: string, now: number): number {
    return this.recent(key, now).length
  }

  /** Seconds until the key is below `max` hits again (default: the limit), or 0 when it already is. */
  retryAfter(key: string, now: number, max = this.limit): number {
    const list = this.recent(key, now)
    if (list.length < max) return 0
    return Math.max(1, Math.ceil((list[list.length - max] + this.windowMs - now) / 1000))
  }

  /**
   * Seconds until `key` can be added, or 0 when it can be now: it is already kept, there is room, or a
   * key below the limit can be pushed out. Otherwise every key holds a lockout; the answer is when the
   * oldest lockout ends (one that began later may end sooner, and sweep makes room for those).
   */
  secondsUntilRoom(key: string, now: number): number {
    if (this.forgetLockouts || this.recent(key, now).length > 0 || this.size < this.maxKeys || this.open.size > 0) return 0
    const first = this.locked.keys().next()
    return first.done ? 0 : this.retryAfter(first.value, now)
  }

  /** Frees one slot for a new key. False when every key holds a lockout (and they are not forgotten). */
  private makeRoom(now: number): boolean {
    if (this.size < this.maxKeys) return true
    if (this.open.size === 0) {
      // The oldest lockout may have ended by now (recent() then moves or drops it).
      const first = this.locked.keys().next()
      if (!first.done) this.recent(first.value, now)
      if (this.size < this.maxKeys) return true
      const oldestLockout = this.locked.keys().next()
      if (this.forgetLockouts && this.open.size === 0 && !oldestLockout.done) {
        this.locked.delete(oldestLockout.value)
        return true
      }
    }
    const oldest = this.open.keys().next()
    if (oldest.done) return false
    this.open.delete(oldest.value)
    return true
  }

  /** Records a hit. A new key needs room: false, and nothing recorded, when every key holds a lockout. */
  add(key: string, now: number): boolean {
    const list = this.recent(key, now)
    if (list.length === 0 && !this.makeRoom(now)) return false
    // Re-inserting moves an open key to the end, so the first open key is the least recently used.
    this.open.delete(key)
    this.store(key, [...list, now])
    return true
  }

  /** Takes back the most recent hit (a provisional count that turned out not to apply). */
  removeLast(key: string): void {
    const list = this.locked.get(key) ?? this.open.get(key)
    if (list) this.store(key, list.slice(0, -1))
  }

  clear(key: string): void {
    this.open.delete(key)
    this.locked.delete(key)
  }

  /** Drops keys whose hits are all outside the window, and lets go of lockouts that have ended. */
  sweep(now: number): void {
    for (const key of [...this.locked.keys(), ...this.open.keys()]) this.recent(key, now)
  }

  get size(): number {
    return this.open.size + this.locked.size
  }
}

export type LoginLimits = {
  windowMs: number
  /** Attempts per client address (IPv6: per /64), successful ones included. */
  perAddress: number
  /** Attempts per email from one address; a successful sign-in clears it. */
  perEmailAddress: number
  /** Failed attempts per email from all addresses together. */
  perEmailFailures: number
  /** Attempts from one trusted device (instead of the three limits above); a successful sign-in clears it. */
  perDevice: number
  /** Most keys kept in memory for each of the four limits. */
  maxKeys: number
}

export const DEFAULT_LOGIN_LIMITS: LoginLimits = {
  windowMs: 15 * 60_000,
  perAddress: 10,
  perEmailAddress: 10,
  perEmailFailures: 100,
  perDevice: 10,
  maxKeys: 50_000,
}

/**
 * The login rate limit. An attacker at one address reaches that address's limits long before the
 * per-email cap, so the only admin can still sign in from anywhere else; spread over many addresses,
 * 100 failures per 15 minutes is still far too slow to guess a 12-character password.
 *
 * The per-email cap is what such an attacker can reach, though: ten or so addresses keep it full, and
 * then every sign-in for that email is refused, the owner's included. So a sign-in from a trusted
 * device (a browser that signed in as this very login before and kept its device cookie) is checked by
 * beginTrusted against that device's own limit only. Getting a device key takes a successful sign-in,
 * so nobody can fill that limit cheaply.
 *
 * Each limit has its own bounded counter. An email key holding a lockout is never pushed out, so no
 * flood of throwaway sign-ins can make the limiter forget one. Only sign-ins that get a real password
 * check add email keys, and those run at most two at a time, so an email's count cannot be pushed out
 * by cheap requests either: that would take maxKeys password checks inside one window.
 *
 * The address limit is different: every sign-in, even a hopeless one with no password check, adds an
 * address key, so whoever controls maxKeys addresses could fill it with lockouts. Refusing new keys then
 * would lock every other address out, the admin's included. So when every address key holds a lockout,
 * the oldest one is forgotten instead. That gives nothing to such an attacker that their addresses do
 * not already give them: password checks stay capped per email, whatever the address.
 */
export class LoginRateLimiter {
  readonly limits: LoginLimits
  private readonly byAddress: SlidingWindowCounter
  private readonly byEmailAddress: SlidingWindowCounter
  private readonly byEmail: SlidingWindowCounter
  private readonly byDevice: SlidingWindowCounter
  private readonly now: () => number

  constructor(options: Partial<LoginLimits> & { now?: () => number } = {}) {
    const { now, ...limits } = options
    this.limits = { ...DEFAULT_LOGIN_LIMITS, ...limits }
    const { windowMs, maxKeys } = this.limits
    this.byAddress = new SlidingWindowCounter(windowMs, maxKeys, this.limits.perAddress, { forgetLockouts: true })
    this.byEmailAddress = new SlidingWindowCounter(windowMs, maxKeys, this.limits.perEmailAddress)
    this.byEmail = new SlidingWindowCounter(windowMs, maxKeys, this.limits.perEmailFailures)
    this.byDevice = new SlidingWindowCounter(windowMs, maxKeys, this.limits.perDevice)
    this.now = now ?? Date.now
  }

  private keys(email: string, address: string) {
    return { address: `ip:${address}`, emailAddress: `email-ip:${email}|${address}`, email: `email:${email}` }
  }

  /** The counters and keys a sign-in counts against: only the address when there is no email. */
  private charges(email: string | null, address: string): Array<[SlidingWindowCounter, string]> {
    if (email === null) return [[this.byAddress, `ip:${address}`]]
    const k = this.keys(email, address)
    return [
      [this.byAddress, k.address],
      [this.byEmailAddress, k.emailAddress],
      [this.byEmail, k.email],
    ]
  }

  /**
   * Checks the limits for a sign-in as `email` (from loginEmail) from `address` (a clientAddressKey).
   * When none is reached, the attempt counts against all three; the email count is provisional until
   * succeeded() or cancelled() takes it back, so only failures stay counted there. Pass null for a
   * sign-in that cannot succeed (no usable email or password, or no password check because the server
   * is busy): only the address limit applies and only the address is charged. A refused attempt counts
   * nowhere, and so does one that would need a new email key while every key of that kind holds a
   * lockout (a new address key never waits: the oldest address lockout makes room).
   */
  begin(email: string | null, address: string): RateLimitResult {
    const now = this.now()
    const charges = this.charges(email, address)
    let retryAfter = Math.max(...charges.map(([counter, key]) => counter.retryAfter(key, now)))
    if (retryAfter === 0) retryAfter = Math.max(...charges.map(([counter, key]) => counter.secondsUntilRoom(key, now)))
    if (retryAfter > 0) return { ok: false, retryAfter }
    for (const [counter, key] of charges) counter.add(key, now)
    return { ok: true }
  }

  /** The password was right: the email stops counting this attempt and its count from this address resets. */
  succeeded(email: string, address: string): void {
    const k = this.keys(email, address)
    this.byEmail.removeLast(k.email)
    this.byEmailAddress.clear(k.emailAddress)
  }

  /** No password was checked after all: only the address keeps the attempt. */
  cancelled(email: string, address: string): void {
    const k = this.keys(email, address)
    this.byEmail.removeLast(k.email)
    this.byEmailAddress.removeLast(k.emailAddress)
  }

  /**
   * Checks the limit for a sign-in from a trusted device (`device`: the hash from findTrustedDevice)
   * instead of begin(): only the device's own limit applies, and only the device is charged, so neither
   * the email's failure cap nor the address limits can lock it out.
   */
  beginTrusted(device: string): RateLimitResult {
    const now = this.now()
    const key = `device:${device}`
    const retryAfter = Math.max(this.byDevice.retryAfter(key, now), this.byDevice.secondsUntilRoom(key, now))
    if (retryAfter > 0) return { ok: false, retryAfter }
    this.byDevice.add(key, now)
    return { ok: true }
  }

  /** The password was right: the device's count resets. */
  succeededTrusted(device: string): void {
    this.byDevice.clear(`device:${device}`)
  }

  /** No password was checked after all: the device does not keep the attempt. */
  cancelledTrusted(device: string): void {
    this.byDevice.removeLast(`device:${device}`)
  }

  private counterFor(key: string): SlidingWindowCounter {
    if (key.startsWith('ip:')) return this.byAddress
    if (key.startsWith('email-ip:')) return this.byEmailAddress
    if (key.startsWith('device:')) return this.byDevice
    return this.byEmail
  }

  /** How many attempts a key ('ip:…', 'email-ip:…|…', 'email:…' or 'device:…') holds now (tests and diagnostics). */
  count(key: string): number {
    return this.counterFor(key).count(key, this.now())
  }

  /** Drops keys with no recent attempts and lets go of ended lockouts; buildApp runs it on a timer. */
  sweep(now = this.now()): void {
    this.byAddress.sweep(now)
    this.byEmailAddress.sweep(now)
    this.byEmail.sweep(now)
    this.byDevice.sweep(now)
  }

  get size(): number {
    return this.byAddress.size + this.byEmailAddress.size + this.byEmail.size + this.byDevice.size
  }
}

// ---------------------------------------------------------------------------------------------
// Public routes that are not sign-ins (demo sign-ups, invites)
// ---------------------------------------------------------------------------------------------

export type AddressLimits = {
  windowMs: number
  /** Requests per client address (a clientAddressKey: IPv6 per /64). */
  perAddress: number
  /** Requests from all addresses together (Infinity: no such limit). */
  global: number
  /** Most address keys kept in memory. */
  maxKeys: number
}

/**
 * Demo sign-ups (POST /api/auth/signup): 5 tries per address and 60 companies created in all, per hour.
 * Only sign-ups that create a company stay in the server-wide count (see AddressRateLimiter.failed), so
 * tries that create nothing cannot use it up for everyone.
 */
export const ACCOUNT_LIMITS: AddressLimits = { windowMs: 3_600_000, perAddress: 5, global: 60, maxKeys: 50_000 }
/**
 * Joining with an invite (POST /api/auth/accept-invite) once its token checked out: 5 per address per
 * hour, and no server-wide count, which strangers could use up: a company's logins are capped anyway
 * (workspaces.ts MAX_LOGINS_PER_WORKSPACE), and only a working token gets this far.
 */
export const INVITE_ACCEPT_LIMITS: AddressLimits = { windowMs: 3_600_000, perAddress: 5, global: Number.POSITIVE_INFINITY, maxKeys: 50_000 }
/**
 * Invite token checks (looking an invite up, and the token check that comes first when joining with one):
 * 30 per address per 15 minutes. A token is 256 random bits; this only spares the database.
 */
export const INVITE_LOOKUP_LIMITS: AddressLimits = { windowMs: 15 * 60_000, perAddress: 30, global: Number.POSITIVE_INFINITY, maxKeys: 50_000 }

/**
 * A sliding-window limit per client address, with an optional limit for the whole server on top. A
 * request counts against both when neither is reached, and against neither when one is. Address keys
 * are cheap to fill (no password check needs to run first), so when every key holds a lockout the oldest
 * is forgotten instead of refusing new addresses (see LoginRateLimiter). The server-wide limit is the
 * one that cannot be spread over many addresses: it caps what all of them together can create.
 */
export class AddressRateLimiter {
  readonly limits: AddressLimits
  private readonly byAddress: SlidingWindowCounter
  private readonly all: SlidingWindowCounter | null
  private readonly now: () => number

  constructor(limits: AddressLimits, options: { now?: () => number } = {}) {
    this.limits = limits
    this.byAddress = new SlidingWindowCounter(limits.windowMs, limits.maxKeys, limits.perAddress, { forgetLockouts: true })
    this.all = Number.isFinite(limits.global) ? new SlidingWindowCounter(limits.windowMs, 1, limits.global) : null
    this.now = options.now ?? Date.now
  }

  /** Checks both limits for a request from `address` (a clientAddressKey) and counts it when neither is reached. */
  begin(address: string): RateLimitResult {
    const now = this.now()
    const key = `ip:${address}`
    const retryAfter = Math.max(this.byAddress.retryAfter(key, now), this.all?.retryAfter('all', now) ?? 0)
    if (retryAfter > 0) return { ok: false, retryAfter }
    this.byAddress.add(key, now)
    this.all?.add('all', now)
    return { ok: true }
  }

  /** Takes the request back (it was refused as busy before doing anything). */
  cancelled(address: string): void {
    this.byAddress.removeLast(`ip:${address}`)
    this.all?.removeLast('all')
  }

  /**
   * The request ran and created nothing (an email that has a login, a full demo server, an error): it
   * leaves the server-wide count, where only what was created stays, and keeps counting for its address.
   * begin() counted it in both first, so requests running at the same time cannot all get past the
   * server-wide limit before any of them is counted.
   */
  failed(): void {
    this.all?.removeLast('all')
  }

  /** How many requests an address ('ip:…') or the whole server ('all') holds now (tests and diagnostics). */
  count(key: string): number {
    return key === 'all' ? (this.all?.count('all', this.now()) ?? 0) : this.byAddress.count(key, this.now())
  }

  /** Drops keys with no recent requests; buildApp runs it on a timer. */
  sweep(now = this.now()): void {
    this.byAddress.sweep(now)
    this.all?.sweep(now)
  }
}

// ---------------------------------------------------------------------------------------------
// Password-check concurrency
// ---------------------------------------------------------------------------------------------

export class GateFullError extends Error {
  constructor() {
    super('too many password checks waiting')
    this.name = 'GateFullError'
  }
}

/**
 * Runs at most `limit` tasks at once and queues up to `maxQueue` more; beyond that run() rejects with
 * GateFullError. A password check costs 32 MiB and tens of milliseconds on libuv's small thread pool,
 * so a flood of sign-ins must not crowd out real ones or the rest of the server.
 */
export class ConcurrencyGate {
  readonly limit: number
  readonly maxQueue: number
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(limit = 2, maxQueue = 16) {
    this.limit = Math.max(1, limit)
    this.maxQueue = Math.max(0, maxQueue)
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) {
      this.active++
    } else {
      if (this.waiting.length >= this.maxQueue) throw new GateFullError()
      // The task that finishes hands its slot over, so `active` stays the same.
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    }
    try {
      return await task()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.active--
    }
  }

  /** True when run() would refuse a task right now (every slot busy and the queue full). */
  get full(): boolean {
    return this.active >= this.limit && this.waiting.length >= this.maxQueue
  }

  get running(): number {
    return this.active
  }

  get queued(): number {
    return this.waiting.length
  }
}
