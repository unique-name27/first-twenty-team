// This device's connection to a First Twenty server, kept in localStorage under 'first-twenty:sync:v1'
// (docs/SYNC.md, "Browser sync engine"), plus the outbox coalescing rules. Every storage access is wrapped:
// a private window or blocked site data must never break the app, it only means nothing persists.
//
// The outbox holds keys, not copies: which records changed and how. The data is read from the store when
// the push goes out, so the outbox can never hold an edit the saved store lacks (the store is saved after
// 400 ms of quiet, the connection at once) and the sync key stays small. Entries are `fixed` (carry their
// data) only while the store no longer shows the synced workspace (the sample or an import is open).
import { DOC_KEYS, RECORD_COLLECTIONS } from './collections'
import type { LocalChange } from './diff'
import { fingerprint } from './fingerprint'
import { type ChangeOp, recordKey, type SyncUser } from './protocol'

export const SYNC_STORAGE_KEY = 'first-twenty:sync:v1'
export const SYNC_STATE_VERSION = 1
/**
 * Bumped together with each save of the store that the engine makes before it records server progress
 * (seq, versions, delivered changes). A connection whose storeMark differs from this key's value may be
 * ahead of the saved store (the browser refused the store save, or the page died between the writes), so
 * the engine rebases on the server's snapshot before pushing.
 */
export const SYNC_MARK_KEY = 'first-twenty:sync:mark:v1'

/**
 * Set while this browser signed out (or disconnected, or removed its data) but the server never confirmed
 * that the session ended (offline, a server error). The session cookie is HttpOnly, so only the server
 * can end it. While the key exists the engine never resumes from the cookie, and it posts
 * /api/auth/logout again on start, on focus and when the browser comes back online, removing the key once
 * the server answers. A successful sign-in removes it too. Kept apart from the connection so it survives
 * Disconnect and "Sign out and remove data", which clear the connection.
 */
export const LOGOUT_PENDING_KEY = 'first-twenty:logout-pending'

/**
 * The demo clock's way back (see the 'demo_clock' hold): the workspace as it was saved before the first
 * page load on a pretend date, with the connection as it was then. Written by the first tab that starts
 * on a pretend date, never replaced while it exists (later loads already show pretend data), and kept
 * apart from the connection so another tab saving its connection cannot erase it. Its presence means
 * the saved workspace may hold changes a pretend date applied: the next start on the real date rebuilds
 * from it, then removes it. Cleared with the connection.
 */
export const CLOCK_COPY_KEY = 'first-twenty:sync:clock:v1'

/** Identifies the collection list this build syncs. A connection saved by a build with another list resyncs. */
export const SYNC_SCHEMA = fingerprint([RECORD_COLLECTIONS, DOC_KEYS])

export type SyncMode = 'local' | 'server'

/**
 * Why a server connection is paused without being an error:
 * - 'sample': the sample company is open in this browser and was never uploaded on purpose.
 * - 'server_empty': the server lost its workspace (someone reset it); upload or disconnect. Edits still
 *   queue, and the engine looks again on start, focus and when back online: once another computer has
 *   uploaded, this browser joins that copy with its queued edits on top (or takes another workspace whole).
 * - 'replaced': this browser's workspace was swapped for another one (Import or Start fresh through the
 *   store instead of engine.replaceWorkspace); upload it to replace the server's, or use the server's copy.
 * - 'demo_clock': the demo clock ('Pretend today is') is on, so the store shows job changes and hand-offs
 *   that are not due yet. Nothing syncs and edits are not queued. Going back to the real date (a reload)
 *   rebuilds this browser from the copy saved before the pretend date (CLOCK_COPY_KEY), or, without
 *   one, from the server's copy before anything is pushed (the hold stays until then).
 */
export type HoldReason = 'sample' | 'server_empty' | 'replaced' | 'demo_clock'

/**
 * A change waiting to be pushed: a key, plus the op seen when it was queued. `rev` changes on every edit,
 * so a push can tell if the record was edited while in flight. The push reads the record from the store,
 * unless the entry is `fixed`: then `op` and `data` are what goes out.
 */
export type OutboxEntry = { collection: string; id: string; op: ChangeOp; rev: number; at: number; data?: unknown; fixed?: boolean }

/** A change the server refused on its own (too large, invalid), with the data that was sent. Kept so nothing is lost; never retried automatically. */
export type RejectedEntry = OutboxEntry & { reason: string }

/**
 * Pushes that left without a definite answer (written before the request, cleared when the server
 * answers for the key). The server may have committed one of them: a later conflict whose server copy
 * matches one of these prints, on the next version, is this device's own write, not another device's.
 */
export type Unconfirmed = { baseVersion: number | null; prints: string[] }

/** The base print of a record nobody had (a new record, or one gone from the copy compared). */
export const ABSENT_PRINT = 'absent'

/** A record's value as a base print (see ConnectionState.bases): its fingerprint, or ABSENT_PRINT. */
export function basePrint(value: unknown): string {
  return value === undefined ? ABSENT_PRINT : fingerprint(value)
}

export type ConnectionState = {
  v: typeof SYNC_STATE_VERSION
  mode: SyncMode
  workspaceId: string | null
  /** Newest change-log seq this device has applied. */
  seq: number
  /** "collection:id" -> the version this device last saw. */
  versions: Record<string, number>
  outbox: OutboxEntry[]
  rejected: RejectedEntry[]
  lastSyncAt: string | null
  /** Cached for display; the session cookie is what really signs requests. */
  user: SyncUser | null
  /** The sample company syncs only after the user uploaded it on purpose (or the server's copy is the sample). */
  sampleAllowed: boolean
  hold: HoldReason | null
  /** "collection:id" -> pushes the server may have committed without this device hearing back. */
  unconfirmed: Record<string, Unconfirmed>
  /**
   * "collection:id" -> basePrint of the server's copy a queued or refused edit was made on, kept while
   * the key is pending. After a server reset the versions of that copy mean nothing, so joining the copy
   * another computer re-uploaded compares records by these prints: a queued edit goes on top only where
   * the uploaded record is still the one it was made on (missing for connections saved by older builds).
   */
  bases: Record<string, string>
  /**
   * "$doc:<key>" -> top-level field -> basePrint of that field in the server's copy the queued edit was
   * made on, for every field this device changed while the document is pending. Present only when every
   * change since the key was queued was recorded (a document is large and holds unrelated panels), so a
   * conflict can keep this device's fields on top of the server's other fields (see handlePushResult).
   */
  fieldBases: Record<string, Record<string, string>>
  /** SYNC_SCHEMA of the build that last caught up with the server (null: unknown, resync on start). */
  schema: string | null
  /** See SYNC_MARK_KEY. */
  storeMark: number
  /**
   * The server's history id from the last snapshot, replace or pull page (null: not known yet, or a server
   * from before history ids). Sent with pulls and pushes, so a server whose workspace was replaced or
   * restored answers "resync" before anything is applied.
   */
  historyId: string | null
  /**
   * The user signed out on purpose (Sign out), as opposed to a session that ended on its own (a 401).
   * Cleared by the next successful sign-in.
   */
  signedOutByUser: boolean
}

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export { recordKey }

export function emptyConnection(): ConnectionState {
  return {
    v: SYNC_STATE_VERSION,
    mode: 'local',
    workspaceId: null,
    seq: 0,
    versions: {},
    outbox: [],
    rejected: [],
    lastSyncAt: null,
    user: null,
    sampleAllowed: false,
    hold: null,
    unconfirmed: {},
    bases: {},
    fieldBases: {},
    schema: null,
    storeMark: 0,
    historyId: null,
    signedOutByUser: false,
  }
}

/** localStorage when the browser allows it, else null. */
export function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** Reads the saved connection. Anything missing, unreadable or from another version gives a local connection. */
export function loadConnection(storage: StorageLike | null | undefined): ConnectionState {
  if (!storage) return emptyConnection()
  let raw: string | null
  try {
    raw = storage.getItem(SYNC_STORAGE_KEY)
  } catch {
    return emptyConnection()
  }
  if (!raw) return emptyConnection()
  try {
    return sanitize(JSON.parse(raw))
  } catch {
    return emptyConnection()
  }
}

/** Saves the connection. Returns false when the browser refused (the engine keeps working from memory). */
export function saveConnection(storage: StorageLike | null | undefined, state: ConnectionState): boolean {
  if (!storage) return false
  try {
    storage.setItem(SYNC_STORAGE_KEY, JSON.stringify(state))
    return true
  } catch {
    return false
  }
}

export function clearConnection(storage: StorageLike | null | undefined): void {
  if (!storage) return
  try {
    storage.removeItem(SYNC_STORAGE_KEY)
    storage.removeItem(SYNC_MARK_KEY)
    storage.removeItem(CLOCK_COPY_KEY)
  } catch {
    /* storage unavailable */
  }
}

/**
 * See CLOCK_COPY_KEY. db: the workspace saved before the first pretend load (as saved, not migrated).
 * conn: the connection as it was then. needsRebase: the connection was already due a rebuild from the
 * server's snapshot then (another build's save, or a store mark that did not match).
 */
export type ClockCopy = { db: unknown; conn: ConnectionState; needsRebase: boolean }

/** True when a demo clock copy is saved (it may not be readable). */
export function hasClockCopy(storage: StorageLike | null | undefined): boolean {
  if (!storage) return false
  try {
    return storage.getItem(CLOCK_COPY_KEY) !== null
  } catch {
    return false
  }
}

/** Saves the demo clock copy. Returns false when the browser refused. */
export function saveClockCopy(storage: StorageLike | null | undefined, copy: ClockCopy): boolean {
  if (!storage) return false
  try {
    storage.setItem(CLOCK_COPY_KEY, JSON.stringify({ v: SYNC_STATE_VERSION, ...copy }))
    return true
  } catch {
    return false
  }
}

/** The demo clock copy, or null when there is none or it cannot be read. */
export function loadClockCopy(storage: StorageLike | null | undefined): ClockCopy | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(CLOCK_COPY_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Record<string, unknown>
    if (!v || v.v !== SYNC_STATE_VERSION || !v.db || typeof v.db !== 'object' || Array.isArray(v.db)) return null
    const conn = sanitize(v.conn)
    if (conn.mode !== 'server') return null
    return { db: v.db, conn, needsRebase: v.needsRebase === true }
  } catch {
    return null
  }
}

export function clearClockCopy(storage: StorageLike | null | undefined): void {
  if (!storage) return
  try {
    storage.removeItem(CLOCK_COPY_KEY)
  } catch {
    /* storage unavailable */
  }
}

/** True when a sign-out is still waiting for the server to end the session (see LOGOUT_PENDING_KEY). */
export function readLogoutPending(storage: StorageLike | null | undefined): boolean {
  if (!storage) return false
  try {
    return storage.getItem(LOGOUT_PENDING_KEY) !== null
  } catch {
    return false
  }
}

/** Sets or clears LOGOUT_PENDING_KEY. Returns false when the browser refused. */
export function writeLogoutPending(storage: StorageLike | null | undefined, on: boolean): boolean {
  if (!storage) return false
  try {
    if (on) storage.setItem(LOGOUT_PENDING_KEY, '1')
    else storage.removeItem(LOGOUT_PENDING_KEY)
    return true
  } catch {
    return false
  }
}

/** The mark saved with the store (0 when none was ever saved or storage is unreadable). */
export function readStoreMark(storage: StorageLike | null | undefined): number {
  if (!storage) return 0
  try {
    const n = Number(storage.getItem(SYNC_MARK_KEY) ?? 0)
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

export function writeStoreMark(storage: StorageLike | null | undefined, mark: number): boolean {
  if (!storage) return false
  try {
    storage.setItem(SYNC_MARK_KEY, String(mark))
    return true
  } catch {
    return false
  }
}

function sanitize(value: unknown): ConnectionState {
  const base = emptyConnection()
  if (!value || typeof value !== 'object') return base
  const v = value as Record<string, unknown>
  if (v.v !== SYNC_STATE_VERSION) return base
  const versions: Record<string, number> = {}
  if (v.versions && typeof v.versions === 'object') {
    for (const [k, n] of Object.entries(v.versions as Record<string, unknown>)) {
      if (typeof n === 'number' && Number.isFinite(n)) versions[k] = n
    }
  }
  // Only fixed entries keep their data: everything else is read from the store at push time.
  const outbox = Array.isArray(v.outbox) ? v.outbox.filter(isEntry).map(toKeyEntry) : []
  const rejected = Array.isArray(v.rejected)
    ? (v.rejected.filter((e) => isEntry(e) && typeof (e as RejectedEntry).reason === 'string') as RejectedEntry[])
    : []
  const unconfirmed: Record<string, Unconfirmed> = {}
  if (v.unconfirmed && typeof v.unconfirmed === 'object') {
    for (const [k, u] of Object.entries(v.unconfirmed as Record<string, unknown>)) {
      if (!u || typeof u !== 'object') continue
      const x = u as Record<string, unknown>
      const okBase = x.baseVersion === null || (typeof x.baseVersion === 'number' && Number.isFinite(x.baseVersion))
      const prints = Array.isArray(x.prints) ? x.prints.filter((p): p is string => typeof p === 'string') : []
      if (okBase && prints.length > 0) unconfirmed[k] = { baseVersion: x.baseVersion as number | null, prints }
    }
  }
  const bases: Record<string, string> = {}
  if (v.bases && typeof v.bases === 'object') {
    for (const [k, p] of Object.entries(v.bases as Record<string, unknown>)) if (typeof p === 'string' && p !== '') bases[k] = p
  }
  const fieldBases: Record<string, Record<string, string>> = {}
  if (v.fieldBases && typeof v.fieldBases === 'object') {
    for (const [k, f] of Object.entries(v.fieldBases as Record<string, unknown>)) {
      if (!f || typeof f !== 'object' || Array.isArray(f)) continue
      const fields: Record<string, string> = {}
      for (const [name, p] of Object.entries(f as Record<string, unknown>)) if (typeof p === 'string' && p !== '') fields[name] = p
      fieldBases[k] = fields
    }
  }
  return {
    v: SYNC_STATE_VERSION,
    mode: v.mode === 'server' ? 'server' : 'local',
    workspaceId: typeof v.workspaceId === 'string' ? v.workspaceId : null,
    seq: typeof v.seq === 'number' && Number.isFinite(v.seq) && v.seq >= 0 ? v.seq : 0,
    versions,
    outbox,
    rejected,
    lastSyncAt: typeof v.lastSyncAt === 'string' ? v.lastSyncAt : null,
    user: isUser(v.user) ? { id: v.user.id, email: v.user.email, role: v.user.role } : null,
    sampleAllowed: v.sampleAllowed === true,
    hold: v.hold === 'sample' || v.hold === 'server_empty' || v.hold === 'replaced' || v.hold === 'demo_clock' ? v.hold : null,
    unconfirmed,
    bases,
    fieldBases,
    schema: typeof v.schema === 'string' ? v.schema : null,
    storeMark: typeof v.storeMark === 'number' && Number.isFinite(v.storeMark) && v.storeMark >= 0 ? v.storeMark : 0,
    historyId: typeof v.historyId === 'string' && v.historyId !== '' ? v.historyId : null,
    signedOutByUser: v.signedOutByUser === true,
  }
}

function isEntry(e: unknown): e is OutboxEntry {
  if (!e || typeof e !== 'object') return false
  const x = e as Record<string, unknown>
  return (
    typeof x.collection === 'string' &&
    typeof x.id === 'string' &&
    (x.op === 'upsert' || x.op === 'delete') &&
    typeof x.rev === 'number' &&
    typeof x.at === 'number' &&
    (x.fixed !== true || x.op === 'delete' || x.data !== undefined)
  )
}

function toKeyEntry(e: OutboxEntry): OutboxEntry {
  const key: OutboxEntry = { collection: e.collection, id: e.id, op: e.op, rev: e.rev, at: e.at }
  if (e.fixed !== true) return key
  return e.op === 'upsert' ? { ...key, data: e.data, fixed: true } : { ...key, fixed: true }
}

function isUser(u: unknown): u is SyncUser {
  if (!u || typeof u !== 'object') return false
  const x = u as Record<string, unknown>
  return typeof x.id === 'string' && typeof x.email === 'string' && typeof x.role === 'string'
}

export type EnqueueOptions = {
  /** True when the server may hold this record: it has a version here, or a push carrying it may have reached the server. */
  isKnown: (key: string) => boolean
  /** A fresh, increasing revision number. */
  nextRev: () => number
  now: number
}

/**
 * Adds changes to the outbox, one entry per collection:id (last write wins locally):
 * - an upsert replaces whatever was queued (an upsert after a delete becomes an upsert);
 * - a delete of a record the server has never seen drops the queued entry instead of sending a delete;
 * - any other delete replaces the queued entry.
 * Entries are keys (no data; see the top of this file). Returns a new array; an entry keeps its place in
 * the queue when it is replaced.
 */
export function enqueueChanges(outbox: readonly OutboxEntry[], changes: readonly LocalChange[], opts: EnqueueOptions): OutboxEntry[] {
  if (changes.length === 0) return outbox.slice()
  const index = new Map<string, number>()
  const out: Array<OutboxEntry | null> = outbox.slice()
  out.forEach((e, i) => e && index.set(recordKey(e.collection, e.id), i))
  for (const c of changes) {
    const key = recordKey(c.collection, c.id)
    const at = index.get(key)
    if (c.op === 'delete' && !opts.isKnown(key)) {
      if (at !== undefined) {
        out[at] = null
        index.delete(key)
      }
      continue
    }
    const entry: OutboxEntry = { collection: c.collection, id: c.id, op: c.op, rev: opts.nextRev(), at: opts.now }
    if (at !== undefined) out[at] = entry
    else {
      index.set(key, out.length)
      out.push(entry)
    }
  }
  return out.filter((e): e is OutboxEntry => e !== null)
}

/** Highest rev in use, so a reloaded engine keeps counting upward. */
export function maxRev(state: ConnectionState): number {
  let max = 0
  for (const e of state.outbox) if (e.rev > max) max = e.rev
  for (const e of state.rejected) if (e.rev > max) max = e.rev
  return max
}
