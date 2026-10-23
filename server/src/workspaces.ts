// Companies on one server (migrations 004 and 005; docs/SYNC.md, Data layout and Companies): creating one
// for a demo sign-up, its slug (its part of the careers page address), invite links that let a teammate
// join it, whether its careers page is public, and the expiry of demo companies nobody uses any more.
//
// Slugs are never handed out twice: a deleted demo company's slug goes to released_slugs, so its old
// careers links never start working for a stranger. A demo company's slug also ends in random characters
// (acme-robotics-k7m2qx), so nobody can find companies, or learn that a name is taken, by guessing.
//
// Every function here takes a workspace id from its caller, and app.ts takes it only from the session's
// login (users.workspace_id). No function reads a workspace id from a request. Invites resolve to their
// own workspace on the server side, so a token can only ever join the company that created it.
//
// Sign-ups and accepted invites take one advisory lock (ACCOUNT_LOCK_KEY), so the email check, the demo
// company count and the slug pick cannot race each other; the unique constraints back them up.
import { randomBytes, randomUUID } from 'node:crypto'
import { RECORD_COLLECTIONS, tableName } from '../../src/sync/collections'
import { type AuthUser, hashToken, isTokenShape, newToken } from './auth'
import type { Db, Queryable } from './db'

/**
 * Slugs that would collide with a careers path (/assets/...) or read as part of the site rather than a
 * company. Must match the list in server/sql/004_multitenant.sql (a test compares them).
 */
export const RESERVED_SLUGS: readonly string[] = ['admin', 'api', 'assets', 'careers', 'jobs', 'static', 'www']
export const SLUG_MAX_LENGTH = 40
const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/

/** Days an invite link works. */
export const INVITE_DAYS = 7
/** Most invite links a company may have open (unused and unexpired) at once. */
export const MAX_OPEN_INVITES = 20
/**
 * email_taken answers one invite gives before it stops working: enough for a typo or two, too few to use
 * one link to test which emails have a login on the server.
 */
export const MAX_INVITE_REFUSALS = 3
/**
 * A sign-up whose company was never uploaded holds a place under DEMO_MAX_WORKSPACES for this long only
 * (the app uploads right after signing up), so empty sign-ups cannot fill the demo server.
 */
export const PENDING_SIGNUP_HOURS = 1
/** A demo company never uploaded is deleted this long after its sign-up (when demo companies expire at all). */
export const UNUSED_SIGNUP_HOURS = 24
/** Most logins a company may have, counting open invites as logins to come. */
export const MAX_LOGINS_PER_WORKSPACE = 50
/** The company name a sign-up gives: 2 to 80 characters after trimming. */
export const COMPANY_NAME_MIN = 2
export const COMPANY_NAME_MAX = 80

// Any constant works; it only has to be the same for every First Twenty process (migrate.ts uses 72_026_001).
const ACCOUNT_LOCK_KEY = 72_026_004

export type WorkspaceInfo = { id: string; name: string; slug: string }

/** True for a well-formed slug: 3 to 40 characters of a-z, 0-9 and '-', starting and ending with a letter or digit. */
export function isValidSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && slug.length >= 3 && slug.length <= SLUG_MAX_LENGTH && SLUG_RE.test(slug)
}

/**
 * The slug a company name asks for: lowercase, every run of other characters one '-', at most 40
 * characters, 'company' when fewer than 3 are left. Accents are dropped first (Société -> societe); the
 * migration's backfill does the same for plain ASCII names.
 */
export function slugBase(name: string): string {
  const trimDashes = (s: string) => s.replace(/^-+|-+$/g, '')
  const ascii = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  const slug = trimDashes(trimDashes(ascii.replace(/[^a-z0-9]+/g, '-')).slice(0, SLUG_MAX_LENGTH))
  return slug.length >= 3 ? slug : 'company'
}

/** The n-th choice for a base: the base itself, then base-2, base-3 ... (shortened to fit 40 characters). */
export function slugCandidate(base: string, n: number): string {
  if (n <= 1) return base
  const suffix = `-${n}`
  return `${base.slice(0, SLUG_MAX_LENGTH - suffix.length).replace(/-+$/, '')}${suffix}`
}

/** The first candidate for `base` that is neither taken nor reserved. */
export function pickSlug(base: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n++) {
    const candidate = slugCandidate(base, n)
    if (!taken.has(candidate) && !RESERVED_SLUGS.includes(candidate)) return candidate
  }
}

/** Letters and digits a demo slug's random ending uses: no 0, o, 1 or l, which read alike. */
const SUFFIX_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'
/** Characters in a demo slug's random ending: 32^6, about a billion endings per name. */
export const SLUG_SUFFIX_LENGTH = 6

/** A random ending for a demo slug (SLUG_SUFFIX_LENGTH characters of SUFFIX_ALPHABET). */
export function randomSlugSuffix(): string {
  const bytes = randomBytes(SLUG_SUFFIX_LENGTH)
  let out = ''
  for (const b of bytes) out += SUFFIX_ALPHABET[b % SUFFIX_ALPHABET.length]
  return out
}

/** A demo company's slug: the base (shortened to fit 40 characters), '-' and the random ending. */
export function demoSlug(base: string, suffix: string): string {
  return `${base.slice(0, SLUG_MAX_LENGTH - suffix.length - 1).replace(/-+$/, '')}-${suffix}`
}

/** Slugs that start like `base` and are in use or were released: every candidate keeps its first 30 characters. */
async function takenSlugs(q: Queryable, base: string): Promise<Set<string>> {
  // Slugs hold no LIKE wildcards.
  const r = await q.query<{ slug: string }>(
    'SELECT slug FROM workspaces WHERE slug LIKE $1 UNION SELECT slug FROM released_slugs WHERE slug LIKE $1',
    [`${base.slice(0, 30)}%`],
  )
  return new Set(r.rows.map((row) => row.slug))
}

/**
 * A free slug for a demo company: its name's base and a random ending, never one in use or released.
 * The ending keeps companies from being found by guessing names, and keeps the answer to a sign-up from
 * saying whether another company has the same name. Callers hold ACCOUNT_LOCK_KEY.
 */
async function freeDemoSlug(q: Queryable, name: string): Promise<string> {
  const base = slugBase(name)
  const taken = await takenSlugs(q, base)
  for (let i = 0; i < 20; i++) {
    const slug = demoSlug(base, randomSlugSuffix())
    if (!taken.has(slug)) return slug
  }
  throw new Error('no free slug')
}

/** The slug the migration gives the server's own workspace while it has no company yet ('Default workspace'). */
export const PLACEHOLDER_SLUG = 'default-workspace'

/**
 * The first upload into a workspace still on PLACEHOLDER_SLUG (a new server whose admin was created before
 * any company existed) names it after the uploaded company: base, base-2 ... (no random ending: the
 * owner's own workspace, whose careers page stays off until the owner turns it on). Inside the upload's
 * transaction (repo.ts replaceWorkspace). Any other slug is left as it is.
 */
export async function slugFromFirstUpload(q: Queryable, workspaceId: string, companyName: unknown): Promise<void> {
  if (typeof companyName !== 'string' || !companyName.trim()) return
  const current = await q.query<{ slug: string }>('SELECT slug FROM workspaces WHERE id = $1', [workspaceId])
  if (current.rows[0]?.slug !== PLACEHOLDER_SLUG) return
  await q.query('SELECT pg_advisory_xact_lock($1)', [ACCOUNT_LOCK_KEY])
  const base = slugBase(companyName)
  const slug = pickSlug(base, await takenSlugs(q, base))
  await q.query('UPDATE workspaces SET slug = $2 WHERE id = $1', [workspaceId, slug])
}

/** A company name from a sign-up, trimmed, or null when it is not 2 to 80 characters of printable text. */
export function companyName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim().replace(/\s+/g, ' ')
  // No control characters (C0, DEL, C1): the name ends up in page titles, emails and the careers pages.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return null
  return name.length >= COMPANY_NAME_MIN && name.length <= COMPANY_NAME_MAX ? name : null
}

/** A new workspace id: 'w-' and 24 random hex characters. */
function newWorkspaceId(): string {
  return `w-${randomBytes(12).toString('hex')}`
}

/** The company's name: its company document's name once uploaded, else the name it was created with. */
const INFO_COLUMNS = `w.id, w.slug, coalesce(nullif(btrim(d.data->>'name'), ''), w.name, w.slug) AS name`
const INFO_FROM = `workspaces w LEFT JOIN workspace_docs d ON d.workspace_id = w.id AND d.key = 'company'`

/** The id, name and slug of a workspace, or null when it does not exist. */
export async function workspaceInfo(db: Queryable, workspaceId: string): Promise<WorkspaceInfo | null> {
  const r = await db.query<WorkspaceInfo>(`SELECT ${INFO_COLUMNS} FROM ${INFO_FROM} WHERE w.id = $1`, [workspaceId])
  return r.rows[0] ?? null
}

/** The workspace a careers page address names, or null (a malformed slug is not looked up). */
export async function findWorkspaceBySlug(db: Queryable, slug: string): Promise<WorkspaceInfo | null> {
  if (!isValidSlug(slug)) return null
  const r = await db.query<WorkspaceInfo>(`SELECT ${INFO_COLUMNS} FROM ${INFO_FROM} WHERE w.slug = $1`, [slug])
  return r.rows[0] ?? null
}

/** Marks a workspace as in use now (a write or a sign-in): demo companies expire DEMO_EXPIRE_DAYS after this. */
export async function touchWorkspace(db: Queryable, workspaceId: string): Promise<void> {
  await db.query('UPDATE workspaces SET last_active_at = now() WHERE id = $1', [workspaceId])
}

/**
 * Whether a workspace's careers page is public (workspaces.careers): on for demo companies from their
 * sign-up, off for the owner's own until an admin turns it on (Settings, Server).
 */
export async function careersOn(db: Queryable, workspaceId: string): Promise<boolean> {
  const r = await db.query<{ careers: boolean }>('SELECT careers FROM workspaces WHERE id = $1', [workspaceId])
  return r.rows[0]?.careers === true
}

/** Turns a workspace's careers page on or off. False when the workspace is gone. */
export async function setCareers(db: Queryable, workspaceId: string, on: boolean): Promise<boolean> {
  const r = await db.query('UPDATE workspaces SET careers = $2 WHERE id = $1', [workspaceId, on])
  return r.rowCount > 0
}

async function emailTaken(q: Queryable, email: string): Promise<boolean> {
  return (await q.query('SELECT 1 FROM users WHERE email = $1', [email])).rows.length > 0
}

export type NewLogin = { email: string; passwordHash: string }
export type AccountResult =
  | { ok: true; user: AuthUser; workspace: WorkspaceInfo }
  | { ok: false; reason: 'email_taken' | 'demo_full' | 'invalid_invite' }

/**
 * A demo sign-up: a new workspace named `name` (not kept, so it expires when unused), with a free slug
 * (freeDemoSlug) and its careers page on, and its first login, an admin. The workspace starts empty
 * (uninitialized): the app uploads a fresh company to it next, the same way as "Upload this browser's
 * workspace". Nothing is created when the email already has a login (email_taken) or the server holds
 * maxDemoWorkspaces demo companies (demo_full). Only uploaded companies count, and sign-ups from the last
 * PENDING_SIGNUP_HOURS (their upload is on its way), so sign-ups that never upload cannot fill the server.
 */
export async function createCompany(db: Db, login: NewLogin, name: string, maxDemoWorkspaces: number): Promise<AccountResult> {
  return db.tx(async (q) => {
    await q.query('SELECT pg_advisory_xact_lock($1)', [ACCOUNT_LOCK_KEY])
    if (await emailTaken(q, login.email)) return { ok: false, reason: 'email_taken' }
    const demos = await q.query<{ n: unknown }>(
      `SELECT count(*) AS n FROM workspaces
        WHERE NOT keep AND (initialized_at IS NOT NULL OR created_at > now() - make_interval(hours => $1::int))`,
      [PENDING_SIGNUP_HOURS],
    )
    if (Number(demos.rows[0].n) >= maxDemoWorkspaces) return { ok: false, reason: 'demo_full' }
    const slug = await freeDemoSlug(q, name)
    const workspaceId = newWorkspaceId()
    const userId = randomUUID()
    await q.query('INSERT INTO workspaces (id, name, slug, keep, careers, created_by) VALUES ($1, $2, $3, false, true, $4)', [
      workspaceId,
      name,
      slug,
      userId,
    ])
    await q.query(`INSERT INTO users (id, email, password_hash, role, workspace_id) VALUES ($1, $2, $3, 'admin', $4)`, [
      userId,
      login.email,
      login.passwordHash,
      workspaceId,
    ])
    return { ok: true, user: { id: userId, email: login.email, role: 'admin', workspaceId }, workspace: { id: workspaceId, name, slug } }
  })
}

export type InviteResult = { ok: true; token: string; expiresAt: string } | { ok: false; reason: 'too_many_invites' | 'too_many_logins'; retryAfter: number }

/**
 * A single-use invite link token for `workspaceId`, created by `userId`, working for INVITE_DAYS. Only
 * its SHA-256 is stored. Refused when the company has MAX_OPEN_INVITES open, or its logins and open
 * invites together reach MAX_LOGINS_PER_WORKSPACE (retryAfter: seconds until the oldest open one expires).
 */
export async function createInvite(db: Db, workspaceId: string, userId: string): Promise<InviteResult> {
  return db.tx(async (q) => {
    // One invite at a time per company, so two cannot both take the last place.
    await q.query('SELECT 1 FROM workspaces WHERE id = $1 FOR UPDATE', [workspaceId])
    const open = await q.query<{ n: unknown; wait: unknown }>(
      `SELECT count(*) AS n, ceil(extract(epoch FROM min(expires_at) - now())) AS wait
         FROM invites WHERE workspace_id = $1 AND used_at IS NULL AND expires_at > now()`,
      [workspaceId],
    )
    const openCount = Number(open.rows[0].n)
    const retryAfter = Math.max(1, Number(open.rows[0].wait ?? 1))
    if (openCount >= MAX_OPEN_INVITES) return { ok: false, reason: 'too_many_invites', retryAfter }
    const logins = await q.query<{ n: unknown }>('SELECT count(*) AS n FROM users WHERE workspace_id = $1', [workspaceId])
    if (Number(logins.rows[0].n) + openCount >= MAX_LOGINS_PER_WORKSPACE) return { ok: false, reason: 'too_many_logins', retryAfter }
    const token = newToken()
    const r = await q.query<{ expires_at: Date | string }>(
      `INSERT INTO invites (token_hash, workspace_id, created_by, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(days => $4::int)) RETURNING expires_at`,
      [hashToken(token), workspaceId, userId, INVITE_DAYS],
    )
    return { ok: true, token, expiresAt: new Date(r.rows[0].expires_at).toISOString() }
  })
}

/** The company an invite token joins, or null when the token is malformed, unknown, used or expired. */
export async function inviteInfo(db: Queryable, token: unknown): Promise<WorkspaceInfo | null> {
  if (!isTokenShape(token)) return null
  const r = await db.query<WorkspaceInfo>(
    `SELECT ${INFO_COLUMNS} FROM invites i JOIN ${INFO_FROM} ON w.id = i.workspace_id
      WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > now()`,
    [hashToken(token)],
  )
  return r.rows[0] ?? null
}

/**
 * Uses an invite: a new login (an admin, like every login: roles are not enforced by the server yet) in
 * the invite's company, and the invite marked used. invalid_invite when the token is malformed, unknown,
 * used or expired (checked before the email, so a bad token tells nothing about which emails exist);
 * email_taken when the email already has a login. That answer counts against the invite, which stops
 * working after MAX_INVITE_REFUSALS of them, so one link cannot test email after email.
 */
export async function acceptInvite(db: Db, token: unknown, login: NewLogin): Promise<AccountResult> {
  if (!isTokenShape(token)) return { ok: false, reason: 'invalid_invite' }
  return db.tx(async (q) => {
    await q.query('SELECT pg_advisory_xact_lock($1)', [ACCOUNT_LOCK_KEY])
    const invite = await q.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM invites WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE',
      [hashToken(token)],
    )
    const workspaceId = invite.rows[0]?.workspace_id
    if (!workspaceId) return { ok: false, reason: 'invalid_invite' }
    if (await emailTaken(q, login.email)) {
      // Burned (used, by nobody) at the last refusal it may give.
      await q.query(
        `UPDATE invites SET refused = refused + 1, used_at = CASE WHEN refused + 1 >= $2 THEN now() ELSE used_at END WHERE token_hash = $1`,
        [hashToken(token), MAX_INVITE_REFUSALS],
      )
      return { ok: false, reason: 'email_taken' }
    }
    const userId = randomUUID()
    await q.query(`INSERT INTO users (id, email, password_hash, role, workspace_id) VALUES ($1, $2, $3, 'admin', $4)`, [
      userId,
      login.email,
      login.passwordHash,
      workspaceId,
    ])
    await q.query('UPDATE invites SET used_at = now(), used_by = $2 WHERE token_hash = $1', [hashToken(token), userId])
    const workspace = await workspaceInfo(q, workspaceId)
    if (!workspace) throw new Error('invite workspace missing')
    return { ok: true, user: { id: userId, email: login.email, role: 'admin', workspaceId }, workspace }
  })
}

/** An open invite link as its company sees it: no token (the server never kept it), who made it, when it stops. */
export type OpenInvite = { id: string; createdAt: string; expiresAt: string; createdBy: string | null }

/** The invite links `workspaceId` has open (unused, unexpired), oldest first. */
export async function openInvites(db: Queryable, workspaceId: string): Promise<OpenInvite[]> {
  const r = await db.query<{ id: string; created_at: Date | string; expires_at: Date | string; created_by: string | null }>(
    `SELECT i.id::text AS id, i.created_at, i.expires_at, u.email AS created_by
       FROM invites i LEFT JOIN users u ON u.id = i.created_by
      WHERE i.workspace_id = $1 AND i.used_at IS NULL AND i.expires_at > now()
      ORDER BY i.created_at, i.id`,
    [workspaceId],
  )
  return r.rows.map((row) => ({
    id: row.id,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    createdBy: row.created_by,
  }))
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Revokes an open invite link of `workspaceId` (deleted: it never works again). False when that company
 * has no such open invite, whatever the id names: another company's invite is never touched.
 */
export async function revokeInvite(db: Queryable, workspaceId: string, inviteId: unknown): Promise<boolean> {
  if (typeof inviteId !== 'string' || !UUID_RE.test(inviteId)) return false
  const r = await db.query('DELETE FROM invites WHERE workspace_id = $1 AND id = $2::uuid AND used_at IS NULL', [workspaceId, inviteId])
  return r.rowCount > 0
}

/** Deletes invites that expired more than INVITE_DAYS ago, used or not (daily housekeeping). */
export async function purgeInvites(db: Queryable): Promise<number> {
  const r = await db.query(`DELETE FROM invites WHERE expires_at <= now() - make_interval(days => $1::int)`, [INVITE_DAYS])
  return r.rowCount
}

/**
 * Which demo workspaces count as stale: unused for `idleDays` days, or never uploaded `unusedHours` hours
 * after their sign-up (and not signed in to since).
 */
export type StaleRule = { idleDays: number } | { unusedHours: number }

/** The SQL condition for a StaleRule, its value in $2. */
function staleSql(rule: StaleRule): string {
  return 'idleDays' in rule
    ? 'last_active_at < now() - make_interval(days => $2::int)'
    : 'initialized_at IS NULL AND created_at < now() - make_interval(hours => $2::int) AND last_active_at < now() - make_interval(hours => $2::int)'
}

const staleValue = (rule: StaleRule) => ('idleDays' in rule ? rule.idleDays : rule.unusedHours)

/**
 * Deletes one demo workspace and everything in it, in one transaction: its records, documents, change
 * log and invites, then its logins (their sessions and trusted devices go with them), then the workspace
 * row, whose slug goes to released_slugs so it is never handed out again. A kept workspace is never
 * deleted. With `stale` (idle days, or a StaleRule), only when it is still stale once its row is locked
 * (a write or sign-in that came first keeps it). Returns whether it was deleted.
 */
export async function deleteDemoWorkspace(db: Db, workspaceId: string, stale?: number | StaleRule): Promise<boolean> {
  const rule = typeof stale === 'number' ? { idleDays: stale } : stale
  return db.tx(async (q) => {
    const row = await q.query(
      `SELECT 1 FROM workspaces WHERE id = $1 AND NOT keep${rule ? ` AND ${staleSql(rule)}` : ''} FOR UPDATE`,
      rule ? [workspaceId, staleValue(rule)] : [workspaceId],
    )
    if (row.rows.length === 0) return false
    // Every table holding this workspace's rows, explicitly (the foreign keys would cascade anyway): the
    // records go before the logins, so deleting the logins finds no updated_by left to clear.
    await q.query('DELETE FROM change_log WHERE workspace_id = $1', [workspaceId])
    await q.query('DELETE FROM workspace_docs WHERE workspace_id = $1', [workspaceId])
    for (const collection of RECORD_COLLECTIONS) {
      await q.query(`DELETE FROM ${tableName(collection)} WHERE workspace_id = $1`, [workspaceId])
    }
    await q.query('DELETE FROM invites WHERE workspace_id = $1', [workspaceId])
    await q.query('DELETE FROM assistant_usage WHERE workspace_id = $1', [workspaceId])
    await q.query('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE workspace_id = $1)', [workspaceId])
    await q.query('DELETE FROM trusted_devices WHERE user_id IN (SELECT id FROM users WHERE workspace_id = $1)', [workspaceId])
    await q.query('DELETE FROM users WHERE workspace_id = $1', [workspaceId])
    await q.query('INSERT INTO released_slugs (slug) SELECT slug FROM workspaces WHERE id = $1 ON CONFLICT (slug) DO NOTHING', [workspaceId])
    await q.query('DELETE FROM workspaces WHERE id = $1 AND NOT keep', [workspaceId])
    return true
  })
}

/**
 * Deletes every stale demo workspace (not kept), one transaction each, oldest first, at most `batch` of
 * each kind per run: those with no write or sign-in for `idleDays` days, and those never uploaded
 * UNUSED_SIGNUP_HOURS after their sign-up. Returns how many went. idleDays 0 means never: nothing is deleted.
 */
export async function expireDemoWorkspaces(db: Db, idleDays: number, batch = 1000): Promise<number> {
  if (idleDays <= 0) return 0
  const rules: StaleRule[] = [{ idleDays }, { unusedHours: UNUSED_SIGNUP_HOURS }]
  let deleted = 0
  for (const rule of rules) {
    const r = await db.query<{ id: string }>(
      `SELECT id FROM workspaces WHERE NOT keep AND ${staleSql(rule)} ORDER BY last_active_at LIMIT $1`,
      [batch, staleValue(rule)],
    )
    for (const { id } of r.rows) if (await deleteDemoWorkspace(db, id, rule)) deleted++
  }
  return deleted
}
