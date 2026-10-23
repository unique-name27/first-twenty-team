// Wire types for the First Twenty server API (/api, JSON). docs/SYNC.md is the contract; keep the two in
// step. Pure types and constants only (no DOM, no store), so the server can import this file too.
import type { DB } from '@/domain/types'

export type ChangeOp = 'upsert' | 'delete'

/** One row of the server's change log, returned by GET /api/changes. */
export type Change = { seq: number; collection: string; id: string; op: ChangeOp; version: number; data?: unknown }

/** One change sent by POST /api/changes. baseVersion is the version the client last saw (null = new). */
export type ClientChange = { collection: string; id: string; op: ChangeOp; data?: unknown; baseVersion: number | null }

/**
 * existing: the server already held exactly this data and wrote nothing (a retried push: the earlier
 * attempt landed). Absent from servers before the flag.
 */
export type Applied = { collection: string; id: string; version: number; existing?: true }

/**
 * The server kept its copy. serverData null means the record does not exist on the server. Both flags are
 * absent from servers before them:
 * - byYou: the signed-in user wrote that copy (or the delete that removed it), from this device or another;
 * - landed: an upsert whose exact data the server already took after baseVersion (its change log holds
 *   it): an earlier attempt of this change landed, and the copy above is newer than it.
 */
export type Conflict = { collection: string; id: string; serverVersion: number | null; serverData: unknown; byYou?: true; landed?: true }

export type SyncUser = { id: string; email: string; role: string }

/**
 * The company a login belongs to on the server. A server holds many companies when it runs as a public
 * demo (SIGNUP_MODE=open); each login belongs to exactly one. slug: the company's part of its careers
 * page address (lowercase a-z, 0-9 and '-').
 */
export type ServerWorkspace = { id: string; name: string; slug: string }

/** Whether anyone may create an account and a company on this server ('open': a public demo server). */
export type SignupMode = 'open' | 'closed'

/**
 * GET /api/auth/me. workspace, careersUrl, careersEnabled and signupMode are absent from servers before
 * companies; careersUrl is null when the server serves no careers pages, and careersEnabled says whether
 * this company's careers page is public (demo companies start with it on, the owner's own with it off).
 */
export type MeResponse = {
  user: SyncUser
  workspace?: ServerWorkspace
  careersUrl?: string | null
  careersEnabled?: boolean
  signupMode?: SignupMode
}

/**
 * POST /api/auth/login and GET /api/auth/session: the login, and the company it belongs to (absent from
 * servers before companies). A browser that syncs one company's copy compares it before carrying on.
 */
export type LoginResponse = { user: SyncUser; workspace?: ServerWorkspace }
export type SessionResponse = { user: SyncUser | null; workspace?: ServerWorkspace }

/** GET /api/invites: an open invite link, without its token (the server keeps only a hash). */
export type OpenInvite = { id: string; createdAt: string; expiresAt: string; createdBy: string | null }

/** PUT /api/workspace/careers: the company's careers page, now on or off. */
export type CareersSwitchResponse = { careersUrl: string | null; careersEnabled: boolean }

/**
 * GET /api/auth/signup-mode (public). demoExpireDays: days without activity after which the server
 * deletes a demo company (0: never); absent from servers that do not say, which use the default.
 */
export type SignupModeResponse = { signupMode: SignupMode; demoExpireDays?: number }

/** Days without activity after which a demo company is deleted, when the server does not say (DEMO_EXPIRE_DAYS). */
export const DEFAULT_DEMO_EXPIRE_DAYS = 30

/** POST /api/auth/signup (201) and POST /api/auth/accept-invite: the new login, signed in, and its company. */
export type AccountResponse = { user: SyncUser; workspace: ServerWorkspace | null }

/** POST /api/invites: a single-use link to join the signed-in admin's company, and when it stops working (ISO). */
export type InviteResponse = { url: string; expiresAt: string }

/** GET /api/invites/:token (public): the company the invite joins. */
export type InviteInfo = { companyName: string }

/** The sign-up rules the server enforces (server/src/auth.ts passwordProblem; companyName 2-80 characters). */
export const MIN_PASSWORD_LENGTH = 12
export const MAX_PASSWORD_LENGTH = 1024
export const MAX_EMAIL_LENGTH = 254
export const MIN_COMPANY_NAME_LENGTH = 2
export const MAX_COMPANY_NAME_LENGTH = 80

/** The hash route an invite link opens: PUBLIC_ORIGIN + '/#invite.' + token. */
export const INVITE_ROUTE = 'invite'

export type HealthResponse = { ok: true; db: 'up'; version: string }

export type WorkspaceSnapshot = {
  workspaceId: string
  /** Names the server's current history (absent from servers before history ids). */
  historyId?: string
  seq: number
  db: DB
  /** "collection:id" -> version. Documents use "$doc:<key>". */
  versions: Record<string, number>
}

/**
 * GET /api/workspace/status: whether the server holds a workspace, without its data. An empty server is
 * an answer here ({empty: true}), where GET /api/workspace answers 404 (which browsers log as an error).
 */
export type WorkspaceStatus = { empty: true } | { empty: false; workspaceId: string; historyId?: string; seq: number }

/** workspaceId: the server workspace that now holds the upload (absent from servers before companies). */
export type PutWorkspaceResponse = { workspaceId?: string; historyId?: string; seq: number; versions: Record<string, number> }

export type ChangesResponse = { resync: true } | { resync?: false; historyId?: string; seq: number; changes: Change[]; more?: boolean }

export type PostChangesResponse = { historyId?: string; seq: number; applied: Applied[]; conflicts: Conflict[] }

/** Most changes one POST /api/changes may carry. */
export const MAX_PUSH_CHANGES = 2000

/** Largest record the server accepts (bytes of JSON). */
export const MAX_RECORD_BYTES = 256 * 1024

/**
 * The name of the <meta> tag the server adds to the app page it serves. The app registers the server's
 * offline worker (SERVICE_WORKER_URL) only when it is there: never from a file, the artifact viewer or the
 * Vite dev server.
 */
export const SERVED_MARKER = 'first-twenty-served'

/** Where the server serves its offline worker (server/src/offline.ts). */
export const SERVICE_WORKER_URL = '/sw.js'

/** "collection:id", the key of the versions map and of the outbox. */
export function recordKey(collection: string, id: string): string {
  return `${collection}:${id}`
}
