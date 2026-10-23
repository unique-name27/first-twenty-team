// The browser sync engine (docs/SYNC.md, "Browser sync engine"). It watches the store, turns every change
// into outbox entries, pushes them after a quiet moment, pulls other devices' changes, and applies server
// copies straight into the store with setState (never mutate, so nothing becomes an Undo step). It renders
// no UI: it reports through a status store.
//
// Invariants:
// - Network work runs one cycle at a time (push, then pull). Connect flows wait for the running cycle.
// - A record with a queued local change (or one the server refused) is never overwritten by a pull; its
//   push either applies or comes back as a conflict, and the server wins.
// - A push that left without a definite answer is remembered before it is sent (unconfirmed). If the
//   server did commit it, the next push sees this device's own write and rebases on it instead of letting
//   it beat the newer local edit. A retry of an attempt that landed, beaten by this same user's newer copy
//   (writes whose answers a browser that died never saved), takes that copy quietly, and a row the server
//   already held (applied as existing) is never deleted as part of an edit that lost.
// - The outbox holds keys; the data is read from the store at push time. The saved store is always at
//   least as new as the saved server progress (seq, versions, delivered changes): the engine saves the
//   store first (persistStore) and checks a mark on start.
// - Remote changes are applied to the Undo history too, so Undo only ever reverts this user's own edits.
// - The sample company never syncs unless the user uploads it on purpose, and a swapped workspace (Import,
//   Start fresh) never syncs as record-by-record changes: replaceWorkspace() sends it whole.
// - A sign-out the server did not confirm is remembered (LOGOUT_PENDING_KEY): the engine never resumes
//   from that session and keeps asking the server to end it. Removing this browser's data waits for that
//   confirmation unless the user accepts that the session stays open.
// - A workspace another computer swapped in on the server reaches this browser whole, with a notice and a
//   copy of what was here (replacedRemotely), never as a silent merge.
// - The demo clock ('Pretend today is') never syncs: while it is on, the connection holds ('demo_clock')
//   and nothing is queued, pushed or pulled. The first load on a pretend date saves the workspace and the
//   connection as they were (CLOCK_COPY_KEY, apart from the connection so no other tab erases it); the
//   next start on the real date rebuilds from that copy before the store is shown or anything is sent.
//   Without a copy the hold stays, and nothing is queued, until the server's copy has replaced the store.
// - While the server has no workspace ('server_empty') edits still queue; they are never pushed into an
//   empty server. Joining the copy another computer uploads keeps a queued edit on top only where that
//   copy still has the record the edit was made on (base prints); elsewhere the server wins, as always.
//   The same goes for a server copy from another history of this workspace (a 409 resync after a
//   re-upload, an Import of a backup, a restore): versions from the old history mean nothing there.
// - An edit the server's copy replaced leaves no trace: its Undo step and the activity rows it logged
//   (while still unsynced) go too, so neither Undo nor the activity log claims an edit that never landed.
//   Documents ($doc) are merged by top-level field when the server changed only other fields.
import type { Activity, DB } from '@/domain/types'
import { newId } from '@/lib/id'
import type { HistoryEntry } from '@/store/db'
import {
  type AcceptInviteInput,
  type ApiErrorKind,
  type ApiFailure,
  type ApiResult,
  describeFailure,
  type LoginOptions,
  type SignupInput,
  type SyncApi,
} from './api'
import { applyChanges, isApplicable, localValue, type RemoteChange } from './apply'
import { DOC_COLLECTION, RECORD_COLLECTIONS } from './collections'
import { inviteFailureText, signupFailureText } from './demo'
import { deepEqual, diffDB, type LocalChange } from './diff'
import { fingerprint } from './fingerprint'
import { isWorkspaceSwap, LOAD_TIME_ACTIVITY_PREFIX, stabilizeLoadTimeIds, withWorkspaceId, workspaceIdOf } from './loadTime'
import {
  type AccountResponse,
  type Change,
  type ClientChange,
  type Conflict,
  type LoginResponse,
  MAX_PUSH_CHANGES,
  MAX_RECORD_BYTES,
  type PostChangesResponse,
  type PutWorkspaceResponse,
  recordKey,
  type ServerWorkspace,
  type SyncUser,
  type WorkspaceSnapshot,
} from './protocol'
import {
  ABSENT_PRINT,
  basePrint,
  type ClockCopy,
  clearClockCopy,
  clearConnection,
  type ConnectionState,
  defaultStorage,
  emptyConnection,
  enqueueChanges,
  type HoldReason,
  hasClockCopy,
  loadClockCopy,
  loadConnection,
  maxRev,
  type OutboxEntry,
  type RejectedEntry,
  readLogoutPending,
  readStoreMark,
  SYNC_SCHEMA,
  saveClockCopy,
  saveConnection,
  type StorageLike,
  type Unconfirmed,
  writeLogoutPending,
  writeStoreMark,
} from './state'
import {
  MAX_REFRESHED_KEYS,
  type RecordRef,
  type RefreshedRef,
  type ReplacedRemotely,
  type RestoredRemotely,
  type StatusStoreLike,
  type SyncStatus,
  useSyncStatus,
} from './status'

/** What the engine needs from the store: useDB satisfies it. */
export type StoreLike = {
  getState(): { db: DB; past: HistoryEntry[]; replace?: (db: DB, label?: string) => void }
  setState(partial: { db: DB; past: HistoryEntry[] }): void
  subscribe(listener: (state: { db: DB }, prevState: { db: DB }) => void): () => void
}

export type SyncClock = {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type SyncEnvEvent = 'focus' | 'visibilitychange' | 'pagehide' | 'online'

/** The page around the engine: visibility and the events that trigger a push or a pull. */
export type SyncEnv = {
  isVisible(): boolean
  on(event: SyncEnvEvent, fn: () => void): () => void
  /** Asks the browser to confirm before the tab closes (changes would be lost). Optional. */
  setLeaveWarning?(on: boolean): void
}

export type EngineOptions = {
  store: StoreLike
  api: SyncApi
  /** Where the connection state lives. Default localStorage; null keeps it in memory only. */
  storage?: StorageLike | null
  clock?: SyncClock
  env?: SyncEnv
  status?: StatusStoreLike
  /** Fills in a server snapshot before it enters the store (the app passes migrate()). */
  prepareSnapshot?: (db: DB) => DB
  /**
   * The DB as last saved in this browser. On start, differences from the live DB (effective-dated changes
   * applied on load, edits made before the engine started) are queued so they reach the server too.
   */
  baseline?: () => DB | null
  /**
   * The changes the app makes on its own when a workspace loads (effective-dated changes and hand-offs
   * whose date has come). Run on a server copy or a replacement workspace before it enters the store, the
   * way useDB.replace does; what it changes is synced.
   */
  onLoad?: (db: DB) => DB
  /**
   * Saves the store now (the app writes useDB's localStorage key). Returns false when the browser refused.
   * Called before the engine records server progress, so the saved store is never older than it.
   */
  persistStore?: () => boolean
  /**
   * The demo clock's pretend date ('Pretend today is'), or null for the real date (the app passes
   * getClockOverride). While it is set the connection holds ('demo_clock') and the connect flows refuse.
   */
  clockOverride?: () => string | null
  /** Removes this app's saved data from the browser (signOut with forgetThisBrowser). */
  wipeLocal?: () => void
  /** What the store shows after forgetting this browser (the app passes the sample company). */
  freshDB?: () => DB
  /**
   * Reloads the page after forgetting this browser, so nothing stays in memory. notice: what happened, in
   * plain words, for the page after the reload to show (this page's toast goes with it).
   */
  reload?: (notice?: string) => void
  debounceMs?: number
  pullIntervalMs?: number
  minBackoffMs?: number
  maxBackoffMs?: number
}

export type FlowFailure = {
  ok: false
  /**
   * 'session_open': removing this browser's data was refused because the server could not be reached to
   * end the session (see SignOutOptions.keepServerSession). 'demo_clock': refused while the demo clock is
   * on (CLOCK_MESSAGE). 'other_company': a sign-in with a login of another company than the one this
   * browser syncs with (otherCompanyMessage); this browser stays signed out.
   */
  kind: ApiErrorKind | 'sample' | 'pending' | 'session_open' | 'demo_clock' | 'other_company'
  status: number | null
  /** Plain-language text for the UI. */
  message: string
  retryAfter?: number
  /** Changes that have not reached the server, counted as a person counts their edits (see pendingEdits). */
  pending?: number
}
/** message: set when the flow did something other than asked, in plain words for a toast (see uploadLocal). */
export type FlowResult = { ok: true; message?: string } | FlowFailure
/**
 * empty: asked only for a browser that is signed in and not connected (the sample banner and Start fresh
 * point an empty server's founder at putting a workspace on it): true when the server holds no workspace
 * yet. Absent when it could not tell, such as on a server from before GET /api/workspace/status.
 */
export type CheckServerResult = { ok: true; version: string; signedIn: boolean; user: SyncUser | null; empty?: boolean } | FlowFailure
export type SignInResult = { ok: true; user: SyncUser } | FlowFailure
/**
 * A new login, from signUp or acceptInvite: signed in like signIn, not syncing yet. workspace: the company
 * the login belongs to (null when the server did not say).
 */
export type AccountResult = { ok: true; user: SyncUser; workspace: ServerWorkspace | null } | FlowFailure
/**
 * confirmed: the server ended the session. When it did not (offline, a server error), this browser
 * still treats itself as signed out and ends the session as soon as the server answers (logoutPending in
 * the status). forgotten: this browser's copy was removed (the page reloads). waiting: changes that could
 * not be sent first (a plain sign-out tries for a few seconds); they sync after the next sign-in in this
 * browser. message: what happened, in plain words, for a toast (it mentions waiting changes).
 */
export type SignOutResult = { ok: true; confirmed: boolean; forgotten?: true; waiting: number; message: string } | FlowFailure
export type SignOutOptions = {
  /**
   * Also remove the workspace, the sync state and the queued changes from this browser (shared
   * computers). Queued changes are sent first; if some cannot be, nothing is removed and the result is
   * kind 'pending', unless discardPending is set. The server must confirm that the session ended; if it
   * cannot be reached, nothing is removed and the result is kind 'session_open', unless keepServerSession
   * is set.
   */
  forgetThisBrowser?: boolean
  discardPending?: boolean
  /**
   * With forgetThisBrowser: remove the data even though the server could not end the session. The session
   * cookie (HttpOnly) then stays in this browser until the server ends it: the app treats the browser as
   * signed out and ends the session the next time it loads with the server reachable, but the session
   * itself stays valid until then (at most 12 hours idle).
   */
  keepServerSession?: boolean
}
/** confirmed: as in SignOutResult. message: what happened, in plain words, for a toast. */
export type DisconnectResult = { ok: true; confirmed: boolean; message: string } | FlowFailure
export type InspectResult =
  | { ok: true; empty: true }
  | {
      ok: true
      empty: false
      sample: boolean
      companyName: string
      counts: { people: number; candidates: number; jobs: number }
      seq: number
      /** The server's workspace (filled in like a snapshot), so the connect step can compare it in detail. */
      db: DB
    }
  | FlowFailure

export type UploadOptions = {
  /** Needed when the server already has a workspace (it is replaced). */
  confirmReplace?: boolean
  /** Needed when this browser holds the sample company: the only way the sample ever syncs. */
  includeSample?: boolean
}

export type SyncEngine = {
  /** Starts syncing when the saved connection is a server one; otherwise only publishes 'local'. */
  start(): void
  stop(): void
  /** Push and pull now; resolves when the cycle is done. */
  syncNow(): Promise<void>
  /** Resolves once no push or pull is running (timers may still be waiting). */
  whenIdle(): Promise<void>
  /** Sends queued changes with fetch keepalive (page hiding or closing). */
  flush(): void
  checkServer(): Promise<CheckServerResult>
  /** opts.remember: "Keep me signed in" (see LoginOptions). Default false. */
  signIn(email: string, password: string, opts?: LoginOptions): Promise<SignInResult>
  /**
   * Creates a login and a new, empty company on a demo server (POST /api/auth/signup) and signs in, as
   * signIn does. Nothing syncs yet: uploadNew then puts the new company's workspace there. Refused (kind
   * 'pending', CONNECTED_ACCOUNT_MESSAGE) while this browser syncs with a server: Disconnect first.
   */
  signUp(input: SignupInput): Promise<AccountResult>
  /**
   * Creates a login in the company an invite link joins (POST /api/auth/accept-invite) and signs in, as
   * signIn does. Nothing syncs yet: useServerCopy then takes that company's workspace. Refused like signUp
   * while this browser syncs with a server.
   */
  acceptInvite(input: AcceptInviteInput): Promise<AccountResult>
  /**
   * Puts a new workspace (the company a sign-up just created) on the signed-in login's empty server
   * workspace (PUT without confirmReplace) and starts syncing it. The store takes it only once the server
   * has it: on failure nothing changes in this browser. Never the sample (kind 'sample'); refused while
   * this browser already syncs with a server (kind 'pending').
   */
  uploadNew(db: DB): Promise<FlowResult>
  /** Ends the session. With forgetThisBrowser, also removes this browser's copy and reloads the page. */
  signOut(opts?: SignOutOptions): Promise<SignOutResult>
  /** Looks at the server's workspace (downloads it once; useServerCopy reuses it for two minutes). */
  inspectServer(): Promise<InspectResult>
  /**
   * PUT this browser's workspace to the server and start syncing it. From the 'server_empty' hold, when
   * another computer uploaded first (409 not_empty), this browser takes what it uploaded instead: the
   * same workspace with this browser's queued edits on top, or another workspace whole (with a copy of
   * this one, as replacedRemotely). The result is ok, and its message says what happened.
   */
  uploadLocal(opts?: UploadOptions): Promise<FlowResult>
  /**
   * Replaces this browser's workspace with the server's and starts syncing (clears Undo history). Refuses
   * with kind 'pending' when that would throw away local work: changes the server refused, or a workspace
   * swapped in by Import or Start fresh. discardPending skips sending queued changes and those checks.
   * From the 'server_empty' hold, a server that holds this same workspace again (another computer uploaded
   * it) is joined with the queued edits on top; another workspace asks first (kind 'pending') when edits
   * are queued.
   */
  useServerCopy(opts?: { discardPending?: boolean }): Promise<FlowResult>
  /**
   * Import and Start fresh. Not connected: the same as useDB.replace (an Undo step). Connected: the
   * workspace replaces the server's for every device (PUT with confirmReplace) before it enters this
   * store, with no Undo step; on failure nothing changes. The sample company is never uploaded this way:
   * loading it puts the connection on hold, as before.
   */
  replaceWorkspace(db: DB, opts?: { label?: string }): Promise<FlowResult>
  /** Stops syncing and forgets the server. The workspace stays in this browser. */
  disconnect(opts?: { discardPending?: boolean }): Promise<DisconnectResult>
  clearRefreshed(): void
  /** Puts changes the server refused back in the outbox (not the ones too large to sync: see discardRejected). */
  retryRejected(): void
  /**
   * Drops changes the server refused (or this browser set aside as too large), all of them or the ones
   * named, and puts the server's copy of each record back in the store, or removes the record when the
   * server never had it. Applied like a pull (no Undo step); the Undo step that made the change goes when
   * nothing else is left of it. Fails, changing nothing, when the server's copy cannot be fetched.
   */
  discardRejected(refs?: RecordRef[]): Promise<FlowResult>
  getConnection(): Readonly<ConnectionState>
  /**
   * Another tab removed this browser's data (Sign out and remove data): stop syncing, show the fresh
   * workspace, and never save anything again (the caller reloads the page).
   */
  dropLocal(): void
  /** Another tab disconnected this browser: stop syncing without saving this tab's connection over it. */
  disconnectedElsewhere(): void
  /** The workspace this browser showed before another computer replaced the server's (see replacedRemotely). */
  getReplacedBackup(): DB | null
  /** The user saw (or dismissed) the replaced-from-another-computer notice: forget it and the copy. */
  clearReplacedRemotely(): void
  /** The user saw (or dismissed) the notice that the server's copy was replaced by another copy of this workspace. */
  clearRestoredRemotely(): void
  /**
   * Asks the server again to end a session a sign-out could not end. Resolves true when there is none
   * left to end. Runs on its own on start, on focus and when the browser comes back online.
   */
  endPendingSession(): Promise<boolean>
}

export const DEBOUNCE_MS = 800
export const PULL_INTERVAL_MS = 30_000
export const MIN_BACKOFF_MS = 2_000
export const MAX_BACKOFF_MS = 60_000
/** How long a plain sign-out keeps starting batches of queued changes before it ends the session. */
export const SIGN_OUT_PUSH_MS = 5_000
/** Bytes of change data per POST (under Fastify's default 1 MiB body limit). */
export const MAX_BATCH_BYTES = 900_000
/** Browsers cap all in-flight keepalive bodies at 64 KiB. */
export const KEEPALIVE_BYTES = 60_000
/**
 * Single changes the server may refuse in a row before the engine stops setting them aside and treats
 * the refusals as a server problem (backs off and retries). A broken server or proxy answering 400 to
 * everything must not empty the outbox into the rejected list.
 */
export const MAX_REFUSALS_IN_A_ROW = 3
const INSPECT_TTL_MS = 120_000
const ENTRY_OVERHEAD_BYTES = 120
/** Earlier attempts remembered per record while no answer has come back. */
const MAX_UNCONFIRMED_PRINTS = 6
const DELETE_PRINT = 'delete'

export const SAMPLE_MESSAGE =
  'The sample company never syncs on its own. Start fresh or import your workspace first, or confirm uploading the sample.'

/** Connect flows, Import and Start fresh while the demo clock is on. */
export const CLOCK_MESSAGE =
  'The app is pretending today is another day (Settings, Data, Pretend today is). Go back to the real date first: a pretend date applies job changes and hand-offs that are not due yet, and those must not reach your server.'

/** Upload while this browser waits for the server's copy after going back to the real date (no copy saved). */
export const LEAVING_CLOCK_MESSAGE =
  "This browser still shows what the pretend date applied. It takes your server's copy as soon as it can reach your server; upload after that."

/** Upload from the server_empty hold found that another computer uploaded this same workspace first. */
export const JOINED_MESSAGE =
  'Another computer uploaded this workspace to your server first. This browser now syncs with that copy, and the changes waiting here go on top.'

/** Upload from the server_empty hold found that another computer put a different workspace on the server. */
export const SWITCHED_MESSAGE =
  'Another computer put a different workspace on your server first. This browser switched to it. Download a backup of what was here from the notice at the top of the page.'

/** Sign-up, joining with an invite, or uploading a new company while this browser already syncs with a server. */
export const CONNECTED_ACCOUNT_MESSAGE =
  'This browser syncs with a company on this server. Disconnect it first (Settings, Server), then create or join another company.'

/**
 * A sign-in, on a browser that syncs one company's copy, with a login of another company: what happened
 * (nothing: this browser stays signed out, its copy and its waiting changes as they were) and the two
 * ways on. waiting: changes not sent yet, counted as a person counts edits.
 */
export function otherCompanyMessage(otherName: string, thisName: string, waiting: number): string {
  const other = otherName.trim() || 'another company'
  const here = thisName.trim() || 'another company'
  const changes = waiting === 1 ? '1 change' : `${waiting} changes`
  const held = waiting > 0 ? `${here}'s copy, with ${changes} not sent yet` : `${here}'s copy`
  const keep = waiting > 0 ? ` to send ${waiting === 1 ? 'it' : 'them'}` : ''
  return `That login belongs to ${other}. This browser holds ${held}, so nothing changed and it stays signed out. Sign in with a login of ${here}${keep}, or disconnect this browser first (Disconnect, below) to use ${other} here.`
}

export const STORAGE_FULL_MESSAGE =
  'This browser refused to save changes that have not reached the server yet (its storage is full or blocked). Keep this tab open until they sync; closing it now would lose them.'

/** "Sign out and remove data" when the server could not end the session: nothing was removed. */
export const SESSION_OPEN_MESSAGE = 'Could not reach your server to end the session, so nothing was removed. Connect and try again.'

/** A sign-out the server did not confirm. */
export const LOGOUT_PENDING_MESSAGE =
  'Signed out in this browser. Your server could not be reached, so its session stays open until this browser reconnects and ends it.'

export const SIGNED_OUT_MESSAGE = 'Signed out. This browser keeps an offline copy.'
export const DISCONNECTED_MESSAGE = 'Disconnected. This browser is local only now; your server keeps its copy.'
export const DISCONNECTED_PENDING_MESSAGE =
  'Disconnected. This browser is local only now. Your server could not be reached, so its session stays open until this browser reconnects and ends it.'
export const FORGOTTEN_MESSAGE = "Signed out and removed this browser's data. Your server keeps everything that reached it."
export const FORGOTTEN_OPEN_MESSAGE =
  'Removed this browser\'s data. Your server could not be reached, so this browser stays signed in to it until this browser reconnects and ends the session.'

const systemClock: SyncClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
}

/** The real page: document visibility plus window events. A no-op outside a browser. */
export function browserEnv(): SyncEnv {
  if (typeof window === 'undefined' || typeof document === 'undefined') return { isVisible: () => true, on: () => () => {} }
  let leaveHandler: ((e: BeforeUnloadEvent) => void) | null = null
  return {
    isVisible: () => document.visibilityState !== 'hidden',
    on: (event, fn) => {
      const target: EventTarget = event === 'visibilitychange' ? document : window
      target.addEventListener(event, fn)
      return () => target.removeEventListener(event, fn)
    },
    setLeaveWarning: (on) => {
      if (on && !leaveHandler) {
        leaveHandler = (e) => {
          e.preventDefault()
          // Older browsers show the prompt only when returnValue is set.
          ;(e as unknown as { returnValue: unknown }).returnValue = ''
        }
        window.addEventListener('beforeunload', leaveHandler)
      } else if (!on && leaveHandler) {
        window.removeEventListener('beforeunload', leaveHandler)
        leaveHandler = null
      }
    },
  }
}

export function isSampleDB(db: DB | null | undefined): boolean {
  return db?.meta?.sample === true
}

const encoder = new TextEncoder()
function byteLength(s: string): number {
  return encoder.encode(s).length
}

/** A failure after which the server may still have committed the push (no answer, or a gateway error). */
function mayHaveCommitted(kind: ApiErrorKind): boolean {
  return kind === 'offline' || kind === 'server' || kind === 'bad_response'
}

/** What an unanswered attempt remembers of a change (see Unconfirmed): its data's fingerprint, or DELETE_PRINT. */
function sentPrint(change: ClientChange): string {
  return change.op === 'upsert' ? fingerprint(change.data) : DELETE_PRINT
}

type Ok = { ok: true }
const OK: Ok = { ok: true }

/**
 * The document an activity row is about, by its entityType, where the row names a part of it (a
 * compliance item's id, a funding round) rather than the document itself (see countEdits).
 */
const ROW_DOC: Record<string, string> = {
  compliance: 'complianceStatus',
  company: 'company',
  settings: 'settings',
  equity: 'equity',
}

/** One outbox entry as it goes out: the entry, its key and the change built from the store. */
type Sent = { key: string; entry: OutboxEntry; change: ClientChange }

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Said after a sign-out that could not send every queued change first. */
function notSentText(n: number): string {
  return `${plural(n, 'change was', 'changes were')} not sent yet; ${n === 1 ? 'it syncs' : 'they sync'} after you sign in again in this browser.`
}

/** A record's protocol name from its key ("collection:id": collections never hold a colon, ids may). */
function refOf(key: string): RecordRef {
  const i = key.indexOf(':')
  return { collection: key.slice(0, i), id: key.slice(i + 1) }
}

const fieldsOf = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** Top-level fields whose values differ between two copies of a document. */
function changedFields(a: unknown, b: unknown): string[] {
  const x = fieldsOf(a)
  const y = fieldsOf(b)
  const out: string[] = []
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) if (!deepEqual(x[k], y[k])) out.push(k)
  return out
}

/** basePrint of `base`'s value for each field where `local` differs from it (see ConnectionState.fieldBases). */
function fieldPrints(base: unknown, local: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of changedFields(base, local)) out[f] = basePrint(fieldsOf(base)[f])
  return out
}

/** The server's copy of a document with this device's values of `fields` on top. */
function mergeFields(server: unknown, local: unknown, fields: readonly string[]): unknown {
  const out: Record<string, unknown> = { ...fieldsOf(server) }
  const mine = fieldsOf(local)
  for (const f of fields) {
    if (mine[f] === undefined) delete out[f]
    else out[f] = mine[f]
  }
  return out
}

/**
 * True when every field this device changed (`prints`: field -> base print) is, on the server, still the
 * value the edit was made on, or already this device's value: the server changed only other fields.
 */
function fieldsHold(prints: Record<string, string>, server: unknown, local: unknown): boolean {
  const theirs = fieldsOf(server)
  const mine = fieldsOf(local)
  return Object.entries(prints).every(([f, p]) => basePrint(theirs[f]) === p || deepEqual(theirs[f], mine[f]))
}

/** A document whose queued edit goes on top of the server's copy, field by field (see fieldsHold). */
type DocMerge = { id: string; server: unknown; fields: string[] }

/** The local edits a server copy threw away: Undo steps (by history id) and the activity rows they logged. */
type Discard = { entries: Set<number>; rows: Set<string> }

export function createSyncEngine(opts: EngineOptions): SyncEngine {
  const { store, api } = opts
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage
  const clock = opts.clock ?? systemClock
  const env = opts.env ?? browserEnv()
  const status = opts.status ?? useSyncStatus
  const prepare = opts.prepareSnapshot ?? ((db: DB) => db)
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS
  const pullIntervalMs = opts.pullIntervalMs ?? PULL_INTERVAL_MS
  const minBackoff = opts.minBackoffMs ?? MIN_BACKOFF_MS
  const maxBackoff = opts.maxBackoffMs ?? MAX_BACKOFF_MS

  let conn: ConnectionState = loadConnection(storage)
  let rev = maxRev(conn)
  let active = false
  let unsubscribe: (() => void) | null = null
  let envOff: Array<() => void> = []
  /** True while the engine itself writes to the store, so the subscription does not echo it back. */
  let applying = false
  let running: Promise<void> | null = null
  let rerun = false
  let exclusive = 0
  let signedOut = false
  /** Bumped on every sign-in, so a 401 for a request sent before it does not sign the user out again. */
  let authEpoch = 0
  let failure: { kind: 'offline' | 'error'; message: string } | null = null
  let backoff = 0
  let nextRetryAt: number | null = null
  let catchingUp = false
  let refreshed = 0
  /** The records counted in `refreshed`, newest last (see noteRefreshed). */
  let refreshedKeys: RefreshedRef[] = []
  let inspected: { snap: WorkspaceSnapshot; at: number } | null = null
  /** Keys of the batch being pushed -> the rev sent. */
  const inFlight = new Map<string, number>()
  /**
   * Records this device deleted -> the delete's version, until a pull passes it. `versions` forgets a
   * deleted record (so a re-create goes out as new), so this is how the delete's own echo in the next pull
   * is told apart from another device's delete: applying the echo would also remove the record from every
   * Undo snapshot, and Undo of the delete would bring nothing back. Memory only: a reload has no Undo history.
   */
  const ownDeletes = new Map<string, number>()
  let pushTimer: unknown = null
  let pullTimer: unknown = null
  let retryTimer: unknown = null
  /** The workspace as it was when a sample/replaced hold began (this session only). */
  let holdBaseline: DB | null = null
  /** Rebase on the server's snapshot before the next push (schema or store mark mismatch on start). */
  let needsRebase = false
  let connSaveFailed = false
  let storeSaveFailed = false
  let lastPersistedDb: DB | null = null
  let refusals = 0
  let leaveWarning = false
  /** The logout-pending flag when the browser would not store it (see LOGOUT_PENDING_KEY). */
  let logoutFlagMem = false
  let endingSession: Promise<boolean> | null = null
  let signingIn = false
  /** Listeners that retry ending a session while a sign-out waits for the server. */
  let logoutOff: Array<() => void> = []
  /** This browser's data was removed (here or in another tab): nothing is saved any more. */
  let dropped = false
  let replaced: ReplacedRemotely | null = null
  let restored: RestoredRemotely | null = null
  /** What this browser showed before another computer replaced the server's workspace (memory only). */
  let replacedBackup: DB | null = null
  /** A look at the server during the server_empty hold (recheckEmpty), while it runs. */
  let recheck: Promise<void> | null = null
  /** On start: asking whether the saved user's session still holds (confirmSession), while it runs. */
  let confirming: Promise<void> | null = null
  /**
   * The demo clock copy this tab started from on a pretend date (memory only), so it can save it again if
   * another tab went back to the real date and used it up while this one still shows pretend data.
   */
  let clockCopy: ClockCopy | null = null

  // ------------------------------------------------------------------------------------------
  // State and status
  // ------------------------------------------------------------------------------------------

  /** Saves the connection (outbox keys, holds, the user...). Never records server progress on its own. */
  function setConn(patch: Partial<ConnectionState>): void {
    conn = { ...conn, ...patch }
    // Base prints (whole records and document fields) are kept only while their key is queued or refused.
    if (patch.outbox || patch.rejected || patch.bases || patch.fieldBases) {
      conn.bases = keepPending(conn, conn.bases)
      conn.fieldBases = keepPending(conn, conn.fieldBases)
    }
    if (dropped) return
    connSaveFailed = storage !== null && !saveConnection(storage, conn)
  }

  function keepPending<T>(c: ConnectionState, map: Record<string, T>): Record<string, T> {
    const keys = Object.keys(map)
    if (keys.length === 0) return map
    const pending = new Set<string>()
    for (const e of c.outbox) pending.add(recordKey(e.collection, e.id))
    for (const e of c.rejected) pending.add(recordKey(e.collection, e.id))
    if (keys.every((k) => pending.has(k))) return map
    const kept: Record<string, T> = {}
    for (const k of keys) if (pending.has(k)) kept[k] = map[k]
    return kept
  }

  /** A sign-out (or disconnect, or removal) is still waiting for the server to end the session. */
  function logoutPending(): boolean {
    return logoutFlagMem || readLogoutPending(storage)
  }

  function setLogoutPending(on: boolean): void {
    const saved = writeLogoutPending(storage, on)
    // Kept in memory only when the browser refused: another tab that signs in clears the stored flag,
    // and a stale copy here must not end that tab's new session.
    logoutFlagMem = on && !saved
    if (on) watchLogout()
    else unwatchLogout()
  }

  /**
   * Records server progress (seq, versions, delivered or refreshed changes). The store is saved first, so
   * a page that dies between the two writes leaves the store ahead (safe: the work is redone), never
   * behind. If the store cannot be saved, the mark no longer matches and the next start rebases.
   */
  function commit(patch: Partial<ConnectionState>): void {
    let storeMark = conn.storeMark
    if (opts.persistStore && !dropped) {
      const db = store.getState().db
      if (db !== lastPersistedDb) {
        storeMark += 1
        let stored = false
        try {
          stored = opts.persistStore()
        } catch {
          stored = false
        }
        storeSaveFailed = !stored
        if (stored) {
          lastPersistedDb = db
          writeStoreMark(storage, storeMark)
        }
      }
    }
    setConn({ ...patch, storeMark })
  }

  const storageFull = (): boolean => connSaveFailed || storeSaveFailed
  const hasPending = (): boolean => conn.outbox.length > 0 || conn.rejected.length > 0

  /**
   * How many changes a person would count among queued entries: each edit also writes an activity row,
   * so a row is left out when the record it is about waits too, and counted when nothing else of its
   * own waits (a note, or a row an Undo removed). A row about a document's part (a compliance item, the
   * company) is about that document: ticking a kit item writes complianceStatus and one row about the
   * item, and counts once. Never 0 while something waits.
   */
  function countEdits(entries: readonly OutboxEntry[], db: DB): number {
    let n = 0
    const ids = new Set<string>()
    const docs = new Set<string>()
    const rows: OutboxEntry[] = []
    for (const e of entries) {
      if (e.collection === 'activity') rows.push(e)
      else {
        n++
        ids.add(e.id)
        if (e.collection === DOC_COLLECTION) docs.add(e.id)
      }
    }
    if (rows.length === 0) return n
    const wanted = new Set(rows.filter((r) => !r.fixed).map((r) => r.id))
    const about = new Map<string, Partial<Activity>>()
    if (wanted.size > 0) for (const a of Array.isArray(db.activity) ? db.activity : []) if (wanted.has(a?.id)) about.set(a.id, a)
    for (const r of rows) {
      const row = r.fixed ? (r.data as Partial<Activity> | undefined) : about.get(r.id)
      const entity = row?.entityId
      const doc = typeof row?.entityType === 'string' ? ROW_DOC[row.entityType] : undefined
      if (doc !== undefined && docs.has(doc)) continue
      if (entity === undefined ? ids.size === 0 : !ids.has(entity)) n++
    }
    return n
  }

  /** Changes that have not reached the server, as shown to people (status pendingEdits plus rejected). */
  function waitingEdits(c: Pick<ConnectionState, 'outbox' | 'rejected'> = conn): number {
    return countEdits(c.outbox, store.getState().db) + c.rejected.length
  }

  let rejectedFor: RejectedEntry[] | null = null
  let rejectedRefsCache: Array<RecordRef & { tooLarge: boolean }> = []
  /** The refused changes for the status (the same array until they change, so the UI does not churn). */
  function rejectedRefs(): Array<RecordRef & { tooLarge: boolean }> {
    if (rejectedFor !== conn.rejected) {
      rejectedFor = conn.rejected
      rejectedRefsCache = conn.rejected.map((r) => ({ collection: r.collection, id: r.id, tooLarge: r.reason === 'too_large' }))
    }
    return rejectedRefsCache
  }

  /** Counts a record the server's copy replaced (once per record while the UI shows the list). */
  function noteRefreshed(refs: readonly RefreshedRef[]): void {
    if (refs.length === 0) return
    let keys = refreshedKeys
    for (const r of refs) {
      const known = keys.some((k) => k.collection === r.collection && k.id === r.id)
      if (!known) refreshed += 1
      const ref: RefreshedRef = r.removed ? { collection: r.collection, id: r.id, removed: true, copy: r.copy } : { collection: r.collection, id: r.id }
      keys = [...keys.filter((k) => k.collection !== r.collection || k.id !== r.id), ref]
    }
    refreshedKeys = keys.slice(-MAX_REFRESHED_KEYS)
  }

  /**
   * How a refreshed record is noted: one the server no longer has keeps what this browser had, since the
   * notice is read after the local copy is removed too.
   */
  function refreshedRef(collection: string, id: string, local: unknown, theirs: unknown): RefreshedRef {
    return local !== undefined && (theirs === null || theirs === undefined) ? { collection, id, removed: true, copy: local } : { collection, id }
  }

  function resetRefreshed(): void {
    refreshed = 0
    refreshedKeys = []
  }

  /** The demo clock is on: nothing syncs (see the 'demo_clock' hold). */
  function clockOn(): boolean {
    try {
      return !!opts.clockOverride?.()
    } catch {
      return false
    }
  }
  /**
   * The demo clock hold is still recorded but the clock is back on the real date, and there was no copy
   * from before the pretend date to rebuild from (start uses it when there is): the next cycle rebuilds
   * from the server's copy (leaveClockHold) before anything is pushed. Until then the hold stays shown
   * and edits are not queued, since the store still shows what the pretend date applied.
   */
  const leavingClock = (): boolean => conn.hold === 'demo_clock' && !clockOn()
  /** The hold the user sees. */
  const shownHold = (): HoldReason | null => (conn.mode === 'server' ? conn.hold : null)

  function computeStatus(): SyncStatus {
    if (conn.mode !== 'server' || shownHold()) return 'local'
    if (storageFull() && hasPending()) return 'error'
    if (signedOut) return 'signed_out'
    if (failure) return failure.kind
    if (exclusive > 0 || catchingUp || conn.outbox.length > 0) return 'syncing'
    return 'synced'
  }

  function lastError(): string | null {
    if (conn.mode !== 'server') return null
    if (storageFull() && hasPending()) return STORAGE_FULL_MESSAGE
    if (signedOut) return describeFailure({ kind: 'signed_out', status: 401, error: null })
    return failure?.message ?? null
  }

  function publish(): void {
    const full = conn.mode === 'server' && storageFull()
    status.setState({
      status: computeStatus(),
      mode: conn.mode,
      pending: conn.outbox.length,
      // Each edit also writes an activity row; count the edits themselves for display.
      pendingEdits: countEdits(conn.outbox, store.getState().db),
      rejected: conn.rejected.length,
      rejectedKeys: rejectedRefs(),
      lastSyncAt: conn.lastSyncAt,
      lastError: lastError(),
      nextRetryAt,
      user: conn.user,
      hold: shownHold(),
      refreshed,
      refreshedKeys,
      storageFull: full,
      logoutPending: logoutPending(),
      signedOutByUser: conn.mode === 'server' && conn.signedOutByUser,
      replacedRemotely: replaced,
      restoredRemotely: restored,
    })
    const warn = active && full && hasPending()
    if (warn !== leaveWarning) {
      leaveWarning = warn
      env.setLeaveWarning?.(warn)
    }
  }

  const canSync = (): boolean =>
    active && conn.mode === 'server' && !clockOn() && (!conn.hold || leavingClock()) && !signedOut && exclusive === 0 && !confirming
  /** The server may hold this record: a version is known, or a push carrying it may have reached it. */
  const isKnown = (key: string): boolean => conn.versions[key] !== undefined || inFlight.has(key) || conn.unconfirmed[key] !== undefined
  const nowISO = (): string => new Date(clock.now()).toISOString()

  function pendingKeys(): Set<string> {
    const keys = new Set<string>()
    for (const e of conn.outbox) keys.add(recordKey(e.collection, e.id))
    for (const e of conn.rejected) keys.add(recordKey(e.collection, e.id))
    return keys
  }

  function fail(f: Pick<ApiFailure, 'kind' | 'status' | 'error' | 'retryAfter'>): FlowFailure {
    const out: FlowFailure = { ok: false, kind: f.kind, status: f.status, message: describeFailure(f) }
    if (f.retryAfter !== undefined) out.retryAfter = f.retryAfter
    return out
  }

  /** A 401 during a connect flow on a server connection means the session ended. */
  function noteAuth(f: ApiFailure): void {
    if (f.kind === 'signed_out' && conn.mode === 'server') {
      signedOut = true
      catchingUp = false
    }
  }

  // ------------------------------------------------------------------------------------------
  // Timers
  // ------------------------------------------------------------------------------------------

  function clearPushTimer(): void {
    if (pushTimer !== null) clock.clearTimeout(pushTimer)
    pushTimer = null
  }
  function clearPullTimer(): void {
    if (pullTimer !== null) clock.clearTimeout(pullTimer)
    pullTimer = null
  }
  function clearRetryTimer(): void {
    if (retryTimer !== null) clock.clearTimeout(retryTimer)
    retryTimer = null
    nextRetryAt = null
  }
  function clearAllTimers(): void {
    clearPushTimer()
    clearPullTimer()
    clearRetryTimer()
  }

  function schedulePush(): void {
    // While backing off, the retry timer carries the queued changes.
    if (!canSync() || retryTimer !== null || conn.outbox.length === 0) return
    clearPushTimer()
    pushTimer = clock.setTimeout(() => {
      pushTimer = null
      void requestSync()
    }, debounceMs)
  }

  function schedulePull(): void {
    clearPullTimer()
    if (!canSync() || !env.isVisible()) return
    pullTimer = clock.setTimeout(() => {
      pullTimer = null
      void requestSync()
    }, pullIntervalMs)
  }

  // ------------------------------------------------------------------------------------------
  // Store
  // ------------------------------------------------------------------------------------------

  function setStoreQuietly(db: DB, past: HistoryEntry[]): void {
    applying = true
    try {
      store.setState({ db, past })
    } finally {
      applying = false
    }
  }

  /**
   * Server changes into the store and into every Undo snapshot, without creating an Undo step. A document
   * in `merges` becomes the server's copy with each snapshot's own values of this device's fields on top.
   * `drop`: Undo steps to remove (an edit the server's copy threw away; see planDiscard).
   */
  function applyRemote(changes: RemoteChange[], merges: readonly DocMerge[] = [], drop: ReadonlySet<number> = new Set()): void {
    if ((changes.length === 0 && merges.length === 0 && drop.size === 0) || conn.hold) return
    const state = store.getState()
    const apply = (db: DB): DB => {
      if (merges.length === 0) return applyChanges(db, changes)
      const own = merges.map(
        (m): RemoteChange => ({ collection: DOC_COLLECTION, id: m.id, op: 'upsert', data: mergeFields(m.server, localValue(db, DOC_COLLECTION, m.id), m.fields) }),
      )
      return applyChanges(db, [...changes, ...own])
    }
    const db = apply(state.db)
    let pastChanged = false
    const past: HistoryEntry[] = []
    for (const entry of state.past) {
      if (drop.has(entry.id)) {
        pastChanged = true
        continue
      }
      const next = apply(entry.db)
      if (next !== entry.db) pastChanged = true
      past.push(next === entry.db ? entry : { ...entry, db: next })
    }
    if (db === state.db && !pastChanged) return
    setStoreQuietly(db, pastChanged ? past : state.past)
    // The server's copy is the sample only when someone uploaded it on purpose.
    if (isSampleDB(db) && !conn.sampleAllowed) setConn({ sampleAllowed: true })
  }

  /** The changes the app makes on load (effective-dated changes), with activity ids every device shares. */
  function withLoadChanges(db: DB): DB {
    if (!opts.onLoad) return db
    return stabilizeLoadTimeIds(db, opts.onLoad(db))
  }

  function onStoreChange(state: { db: DB }, prev: { db: DB }): void {
    if (applying || state.db === prev.db) return
    if (conn.mode !== 'server') return
    if (clockOn()) {
      // Seen from a pretend date: nothing is queued (see the 'demo_clock' hold). The browser saves this
      // store soon: if another tab went back to the real date and used up the copy meanwhile, put it back.
      if (clockCopy && !hasClockCopy(storage)) saveClockCopy(storage, clockCopy)
      if (conn.hold === 'sample' || conn.hold === 'replaced') reconsiderHold(state.db)
      return
    }
    if (leavingClock()) {
      // Back on the real date with no copy to rebuild from: the store still shows what the pretend date
      // applied until the server's copy replaces it, so an edit now would carry it. Not queued (the hold
      // stays shown), like an edit made while pretending.
      return
    }
    const sample = isSampleDB(state.db) && !conn.sampleAllowed
    const swapped = isWorkspaceSwap(prev.db, state.db)
    if (conn.hold === 'server_empty') {
      // Nothing is pushed while the server has no workspace, but edits queue, so they are kept whichever
      // way the hold ends (this browser uploads, or it joins the copy another computer uploaded).
      if (!sample && !swapped) enqueueLocal(diffDB(prev.db, state.db), prev.db)
      return
    }
    if (conn.hold) {
      reconsiderHold(state.db)
      return
    }
    if (sample) {
      // Loading the sample over a synced workspace must never push it (or pull into it).
      enterHold('sample', prev.db)
      return
    }
    if (swapped) {
      // Import or Start fresh through the store: a merge would keep records other devices touched.
      enterHold('replaced', prev.db)
      return
    }
    enqueueLocal(diffDB(prev.db, state.db), prev.db)
  }

  /**
   * Pauses syncing while the store shows something other than the synced workspace. Queued entries take
   * their data from that workspace now, since the store no longer has it.
   */
  function enterHold(reason: HoldReason, baseline: DB): void {
    clearPushTimer()
    clearPullTimer()
    holdBaseline = baseline
    const outbox: OutboxEntry[] = []
    for (const e of conn.outbox) {
      const fixed = e.fixed ? e : fixEntry(e, baseline)
      if (fixed) outbox.push(fixed)
    }
    setConn({ hold: reason, outbox })
    publish()
  }

  /** The store changed during a sample/replaced hold: resume when it shows the synced workspace again (Undo). */
  function reconsiderHold(db: DB): void {
    // Only going back to the real date (a reload) ends the demo clock hold; edits meanwhile never sync.
    if (conn.hold === 'demo_clock') return
    if (isSampleDB(db) && !conn.sampleAllowed) {
      if (conn.hold !== 'sample') {
        setConn({ hold: 'sample' })
        publish()
      }
      return
    }
    if (holdBaseline && !isWorkspaceSwap(holdBaseline, db)) {
      if (clockOn()) {
        // The synced workspace again, but seen from a pretend date: hold for the clock instead.
        holdBaseline = null
        setConn({ hold: 'demo_clock' })
        publish()
        return
      }
      const base = holdBaseline
      holdBaseline = null
      setConn({ hold: null })
      catchingUp = true
      // After an Undo this is exactly what was edited since the hold began (often nothing).
      enqueueLocal(diffDB(base, db), base)
      publish()
      void requestSync()
      return
    }
    if (conn.hold !== 'replaced') {
      setConn({ hold: 'replaced' })
      publish()
    }
  }

  /**
   * Queues `changes`, made on top of `before`. A key that was not pending yet records the base print of
   * its copy in `before`: the server's copy it was made on (see ConnectionState.bases).
   */
  function enqueueLocal(changes: LocalChange[], before: DB): void {
    if (changes.length === 0) return
    const pending = pendingKeys()
    let bases = conn.bases
    let fieldBases = conn.fieldBases
    for (const c of changes) {
      const key = recordKey(c.collection, c.id)
      // A document also records the fields changed, each with its value in the copy the edit was made
      // on: from the moment it is queued, or never (a key queued without it stays whole-record).
      if (c.collection === DOC_COLLECTION && c.op === 'upsert' && (!pending.has(key) || fieldBases[key])) {
        const prev = localValue(before, c.collection, c.id)
        const fields = { ...(pending.has(key) ? fieldBases[key] : {}) }
        for (const f of changedFields(prev, c.data)) if (!(f in fields)) fields[f] = basePrint(fieldsOf(prev)[f])
        if (fieldBases === conn.fieldBases) fieldBases = { ...fieldBases }
        fieldBases[key] = fields
      }
      if (pending.has(key)) continue
      if (bases === conn.bases) bases = { ...bases }
      bases[key] = basePrint(localValue(before, c.collection, c.id))
    }
    setConn({ outbox: enqueueChanges(conn.outbox, changes, { isKnown, nextRev: () => ++rev, now: clock.now() }), bases, fieldBases })
    publish()
    schedulePush()
  }

  // ------------------------------------------------------------------------------------------
  // Push
  // ------------------------------------------------------------------------------------------

  /** The change an entry sends, read from `db` (or its own data when fixed). null: nothing to send. */
  function buildChange(e: OutboxEntry, db: DB): ClientChange | null {
    const key = recordKey(e.collection, e.id)
    const baseVersion = conn.versions[key] ?? null
    let value: unknown
    if (e.fixed) value = e.op === 'upsert' ? e.data : undefined
    else value = localValue(db, e.collection, e.id)
    if (value !== undefined) return { collection: e.collection, id: e.id, op: 'upsert', data: value, baseVersion }
    // Gone locally: a delete, unless the server never had it.
    return isKnown(key) ? { collection: e.collection, id: e.id, op: 'delete', baseVersion } : null
  }

  function fixEntry(e: OutboxEntry, db: DB): OutboxEntry | null {
    const c = buildChange(e, db)
    if (!c) return null
    const base = { collection: e.collection, id: e.id, rev: e.rev, at: e.at, fixed: true as const }
    return c.op === 'upsert' ? { ...base, op: 'upsert', data: c.data } : { ...base, op: 'delete' }
  }

  /** The next batch from the head of the outbox, entries too large to ever send, and entries with nothing to send. */
  function takeBatch(maxBytes: number, limit: number): { batch: Sent[]; oversized: Sent[]; empty: OutboxEntry[] } {
    const db = store.getState().db
    const batch: Sent[] = []
    const oversized: Sent[] = []
    const empty: OutboxEntry[] = []
    let bytes = 0
    for (const e of conn.outbox) {
      if (batch.length >= limit) break
      const change = buildChange(e, db)
      if (!change) {
        empty.push(e)
        continue
      }
      const key = recordKey(e.collection, e.id)
      const size = change.op === 'upsert' ? byteLength(JSON.stringify(change.data) ?? '') : 0
      if (size > MAX_RECORD_BYTES) {
        oversized.push({ key, entry: e, change })
        continue
      }
      const cost = size + ENTRY_OVERHEAD_BYTES
      if (bytes + cost > maxBytes) break
      batch.push({ key, entry: e, change })
      bytes += cost
    }
    return { batch, oversized, empty }
  }

  function dropEntries(entries: OutboxEntry[]): void {
    if (entries.length === 0) return
    const drop = new Set(entries)
    setConn({ outbox: conn.outbox.filter((e) => !drop.has(e)) })
    publish()
  }

  function reject(items: Sent[], reason: string): void {
    if (items.length === 0) return
    const keys = new Set(items.map((s) => s.key))
    const revs = new Map(items.map((s) => [s.key, s.entry.rev]))
    const rejected: RejectedEntry[] = conn.rejected.filter((r) => !keys.has(recordKey(r.collection, r.id)))
    for (const s of items) {
      const base = { collection: s.entry.collection, id: s.entry.id, rev: s.entry.rev, at: s.entry.at, fixed: true as const, reason }
      rejected.push(s.change.op === 'upsert' ? { ...base, op: 'upsert', data: s.change.data } : { ...base, op: 'delete' })
    }
    setConn({
      outbox: conn.outbox.filter((e) => revs.get(recordKey(e.collection, e.id)) !== e.rev),
      rejected,
    })
    publish()
  }

  /** Written before a push leaves: what it carries, in case the answer never arrives. */
  function noteSending(batch: Sent[]): void {
    const next: Record<string, Unconfirmed> = { ...conn.unconfirmed }
    for (const s of batch) {
      const print = sentPrint(s.change)
      const u = next[s.key]
      next[s.key] =
        u && u.baseVersion === s.change.baseVersion
          ? { baseVersion: u.baseVersion, prints: [...u.prints.filter((p) => p !== print), print].slice(-MAX_UNCONFIRMED_PRINTS) }
          : { baseVersion: s.change.baseVersion, prints: [print] }
    }
    setConn({ unconfirmed: next })
  }

  /** The server refused the push outright: it committed nothing, so forget this attempt. */
  function forgetAttempt(before: Record<string, Unconfirmed>, batch: Sent[]): void {
    const next: Record<string, Unconfirmed> = { ...conn.unconfirmed }
    for (const s of batch) {
      if (before[s.key]) next[s.key] = before[s.key]
      else delete next[s.key]
    }
    setConn({ unconfirmed: next })
  }

  /**
   * True when a conflict's server copy is a push of this device that never got its answer: same base, a
   * newer version (any version for a new record) and the same data as one of those attempts. Versions
   * are workspace-wide change-log seqs, so the lost write is rarely at base + 1 (another record in the
   * batch, the activity row each edit logs, another device): only the order is checked, and the
   * fingerprint is the evidence.
   */
  function isOwnEarlierWrite(u: Unconfirmed | undefined, change: ClientChange, c: Conflict): boolean {
    if (!u || u.baseVersion !== change.baseVersion) return false
    if (c.serverVersion === null || c.serverData === null || c.serverData === undefined) return false
    if (u.baseVersion !== null && c.serverVersion <= u.baseVersion) return false
    return u.prints.includes(fingerprint(c.serverData))
  }

  /**
   * deadline: no new batch starts at or after this clock time (a plain sign-out sends what it can in a few
   * seconds); a batch on its way still gets its answer (or the request times out).
   */
  async function pushAll(keepalive: boolean, deadline?: number): Promise<Ok | ApiFailure> {
    let limit = MAX_PUSH_CHANGES
    let useKeepalive = keepalive
    for (let guard = 0; guard < 100_000 && conn.outbox.length > 0; guard++) {
      if (deadline !== undefined && clock.now() >= deadline) break
      const { batch, oversized, empty } = takeBatch(useKeepalive ? KEEPALIVE_BYTES : MAX_BATCH_BYTES, limit)
      dropEntries(empty)
      reject(oversized, 'too_large')
      if (batch.length === 0) {
        if (useKeepalive) {
          // Too big for a keepalive body: send it as an ordinary request.
          useKeepalive = false
          continue
        }
        if (oversized.length > 0 || empty.length > 0) continue
        break
      }
      const before = conn.unconfirmed
      noteSending(batch)
      for (const s of batch) inFlight.set(s.key, s.entry.rev)
      let res: ApiResult<PostChangesResponse>
      try {
        // The history id makes a server whose workspace was replaced refuse the whole push (kind 'resync')
        // instead of taking this workspace's new records into another one.
        res = await api.postChanges(
          batch.map((s) => s.change),
          useKeepalive ? { keepalive: true, historyId: conn.historyId } : { historyId: conn.historyId },
        )
      } finally {
        inFlight.clear()
      }
      useKeepalive = false
      if (!res.ok) {
        if (!mayHaveCommitted(res.kind)) forgetAttempt(before, batch)
        if (res.kind === 'bad_request' || res.kind === 'too_large') {
          // Refusal after refusal looks like a broken server or proxy, not bad records: back off.
          if (refusals >= MAX_REFUSALS_IN_A_ROW) return res
          // A refused batch: find the change the server objects to by halving, then set it aside.
          if (batch.length > 1) {
            limit = Math.max(1, Math.floor(batch.length / 2))
            continue
          }
          refusals++
          reject(batch, res.error ?? res.kind)
          limit = MAX_PUSH_CHANGES
          continue
        }
        return res
      }
      refusals = 0
      const unresolved = handlePushResult(batch, res.data, before)
      if (unresolved > 0) return { ok: false, kind: 'bad_response', status: res.status, error: 'unresolved_changes' }
    }
    return OK
  }

  /**
   * Records applied versions and server-wins copies. Returns how many sent changes got no answer.
   * A document whose server copy changed only fields this device left alone is merged instead of lost:
   * this device's fields go on top of the server's copy and out again on its version. An edit that lost
   * takes its Undo step and the activity rows it logged with it (planDiscard), so nothing claims it.
   * `before`: the unanswered attempts as they were before this push (a delete that landed unanswered).
   * A conflict whose server copy is exactly what was sent counts as applied, and a retry of an attempt
   * that landed (the conflict says `landed`), beaten by this same user's newer copy, takes it quietly: a
   * browser that died before saving its last answers, or even that it sent them, retries from an older
   * copy, and nothing it lost was anyone else's.
   */
  function handlePushResult(batch: Sent[], data: PostChangesResponse, before: Record<string, Unconfirmed>): number {
    const sent = new Map(batch.map((s) => [s.key, s]))
    const resolved = new Set<string>()
    const versions = { ...conn.versions }
    const unconfirmed = { ...conn.unconfirmed }
    const bases = { ...conn.bases }
    const fieldBases = { ...conn.fieldBases }
    const applied = new Set<string>()
    /** Applied because the server already held this exact data: an earlier push of it landed. */
    const existing = new Set<string>()
    const lost = new Set<string>()
    /** Merged documents whose fields all equal the server's already: nothing left to send. */
    const settled = new Set<string>()
    const merges: DocMerge[] = []
    for (const a of data.applied) {
      const key = recordKey(a.collection, a.id)
      const s = sent.get(key)
      if (!s || resolved.has(key)) continue
      resolved.add(key)
      delete unconfirmed[key]
      if (s.change.op === 'delete') {
        delete versions[key]
        ownDeletes.set(key, a.version)
      } else versions[key] = a.version
      applied.add(key)
      if (a.existing) existing.add(key)
    }
    const remote: RemoteChange[] = []
    const db = store.getState().db
    /** Records whose local copy the server's replaced (it differed): counted, named, and their edits discarded. */
    const changed: RefreshedRef[] = []
    for (const c of data.conflicts) {
      const key = recordKey(c.collection, c.id)
      const s = sent.get(key)
      if (!s || resolved.has(key)) continue
      resolved.add(key)
      const u = unconfirmed[key]
      delete unconfirmed[key]
      const local = localValue(db, c.collection, c.id)
      if (isOwnEarlierWrite(u, s.change, c)) {
        // The server has this device's earlier push (its answer was lost): send the newer edit on top.
        versions[key] = c.serverVersion as number
        bases[key] = basePrint(c.serverData)
        if (c.collection === DOC_COLLECTION) fieldBases[key] = fieldPrints(c.serverData, local)
        continue
      }
      const gone = c.serverData === null || c.serverData === undefined
      if (!gone && c.serverVersion !== null && s.change.op === 'upsert' && deepEqual(s.change.data, c.serverData)) {
        // The server already holds exactly what was sent (where newer servers answer applied, existing):
        // nothing was lost, so it counts as applied. An edit made since goes out on top, as after any push.
        versions[key] = c.serverVersion
        applied.add(key)
        existing.add(key)
        continue
      }
      const earlier = before[key]
      if (gone && s.change.op === 'upsert' && earlier?.baseVersion === s.change.baseVersion && earlier.prints.includes(DELETE_PRINT)) {
        // This device's delete reached the server (its answer was lost) and the record was brought back
        // since (Undo): it goes out again as a new record, on no base.
        delete versions[key]
        bases[key] = ABSENT_PRINT
        continue
      }
      const editedSince = conn.outbox.some((e) => e.collection === c.collection && e.id === c.id && e.rev !== s.entry.rev)
      if (c.byYou && c.landed && !gone && c.serverVersion !== null && !editedSince) {
        // A retry of an attempt that did land (the server's log holds this exact upsert), since replaced by
        // a newer copy this same user wrote: this browser's own later writes whose answers it never saved
        // (it died before writing them, or before writing down that it had sent this one at all), or the
        // same person on another computer. Nothing was lost to anyone else, so their copy is taken quietly:
        // no notice, and the Undo step and activity rows stay. (An edit made while the retry was on its
        // way is news: it loses with a notice, below.)
        lost.add(key)
        versions[key] = c.serverVersion
        remote.push({ collection: c.collection, id: c.id, op: 'upsert', data: c.serverData })
        continue
      }
      const prints = conn.fieldBases[key]
      if (c.collection === DOC_COLLECTION && !gone && c.serverVersion !== null && prints && fieldsHold(prints, c.serverData, local)) {
        // Another device changed other fields of this document: this device's fields stay on top.
        const fields = Object.keys(prints)
        const merged = mergeFields(c.serverData, local, fields)
        versions[key] = c.serverVersion
        bases[key] = basePrint(c.serverData)
        if (deepEqual(merged, c.serverData)) {
          settled.add(key)
          remote.push({ collection: c.collection, id: c.id, op: 'upsert', data: c.serverData })
        } else {
          merges.push({ id: c.id, server: c.serverData, fields })
          fieldBases[key] = fieldPrints(c.serverData, merged)
        }
        continue
      }
      lost.add(key)
      if (gone || c.serverVersion === null) delete versions[key]
      else versions[key] = c.serverVersion
      remote.push(gone ? { collection: c.collection, id: c.id, op: 'delete' } : { collection: c.collection, id: c.id, op: 'upsert', data: c.serverData })
      // Load-time activity rows share ids across devices on purpose; taking the server's copy is no news.
      const autoRow = c.collection === 'activity' && c.id.startsWith(LOAD_TIME_ACTIVITY_PREFIX)
      if (!autoRow && !deepEqual(local, gone ? undefined : c.serverData)) changed.push(refreshedRef(c.collection, c.id, local, c.serverData))
    }
    // The lost edits' Undo steps and the rows they logged go too, found before the server's copies change
    // the history. Rows still queued (or refused) were never sent; rows this batch delivered get a delete.
    // A row the server already held (applied as existing) shows that an earlier push of its step landed:
    // it is history, so it stays, and so does its step.
    const unsynced = new Set([...pendingKeys(), ...sent.keys()].filter((k) => !existing.has(k)))
    const discard = planDiscard(new Set(changed.map((r) => recordKey(r.collection, r.id))), unsynced)
    const droppedRows = new Set<string>()
    const deletes: LocalChange[] = []
    for (const id of discard.rows) {
      const key = recordKey('activity', id)
      droppedRows.add(key)
      remote.push({ collection: 'activity', id, op: 'delete' })
      if (applied.has(key)) deletes.push({ collection: 'activity', id, op: 'delete' })
    }
    // An applied entry leaves the outbox only if it was not edited again while in flight (then it goes
    // next time, on top of the new version). A conflict drops it either way: the server wins. A rebased
    // or merged entry stays and goes out again on the version the server gave.
    let outbox = conn.outbox.filter((e) => {
      const key = recordKey(e.collection, e.id)
      if (lost.has(key) || settled.has(key) || droppedRows.has(key)) return false
      return !(applied.has(key) && sent.get(key)?.entry.rev === e.rev)
    })
    // An applied entry edited again in flight stays queued, now on top of the copy it just sent.
    for (const e of outbox) {
      const key = recordKey(e.collection, e.id)
      const s = applied.has(key) ? sent.get(key) : undefined
      if (!s) continue
      bases[key] = s.change.op === 'upsert' ? basePrint(s.change.data) : ABSENT_PRINT
      if (e.collection === DOC_COLLECTION) fieldBases[key] = fieldPrints(s.change.data, localValue(db, e.collection, e.id))
    }
    if (deletes.length > 0) {
      outbox = enqueueChanges(outbox, deletes, { isKnown: (k) => versions[k] !== undefined, nextRev: () => ++rev, now: clock.now() })
      for (const d of deletes) {
        const key = recordKey(d.collection, d.id)
        bases[key] = basePrint(sent.get(key)?.change.data)
      }
    }
    // A refused copy is stale once a newer change for the record has settled.
    const rejected = conn.rejected.filter((r) => {
      const key = recordKey(r.collection, r.id)
      return !(applied.has(key) || lost.has(key) || settled.has(key) || droppedRows.has(key))
    })
    applyRemote(remote, merges, discard.entries)
    commit({ versions, outbox, rejected, unconfirmed, bases, fieldBases })
    noteRefreshed(changed)
    publish()
    return batch.length - resolved.size
  }

  /**
   * The local edits that server copies are about to replace (`lost`), found in the Undo history before
   * those copies are applied to it: each step whose record changes all lost, with the activity rows it
   * added, provided those rows never reached the server before (`unsynced`: queued, or sent in the batch
   * that lost). Such a step leaves nothing to undo once the server's copies are in, and its rows would
   * claim an edit that never happened. A step that also changed something that stays keeps its place and
   * its rows: part of it happened. A lost record no step covers (the page was reloaded since the edit)
   * takes the unsynced rows about it (activity entityId).
   * `delivered`: the step's rows that already reached the server count too (the caller deletes them
   * there). Discarding a refused change uses it: the record change never reached the server, whatever
   * happened to the rows logged with it. A lost record no step covers still takes unsynced rows only.
   */
  function planDiscard(lost: ReadonlySet<string>, unsynced: ReadonlySet<string>, delivered = false): Discard {
    const out: Discard = { entries: new Set(), rows: new Set() }
    if (lost.size === 0) return out
    const { db, past } = store.getState()
    const lostRefs = [...lost].map(refOf)
    const covered = new Set<string>()
    for (let i = past.length - 1; i >= 0; i--) {
      const before = past[i].db
      const after = i + 1 < past.length ? past[i + 1].db : db
      // Unchanged records keep their identity (Immer, applyChanges): only a step that touched one is diffed.
      if (!lostRefs.some((r) => localValue(before, r.collection, r.id) !== localValue(after, r.collection, r.id))) continue
      let touched = false
      let discardable = true
      const rows: string[] = []
      for (const c of diffDB(before, after)) {
        const key = recordKey(c.collection, c.id)
        if (lost.has(key)) {
          touched = true
          covered.add(key)
        } else if (c.collection === 'activity' && c.op === 'upsert' && localValue(before, c.collection, c.id) === undefined && (delivered || unsynced.has(key))) {
          rows.push(c.id)
        } else discardable = false
      }
      if (!touched || !discardable) continue
      out.entries.add(past[i].id)
      for (const id of rows) out.rows.add(id)
    }
    const uncovered = new Set(lostRefs.filter((r) => r.collection !== 'activity' && !covered.has(recordKey(r.collection, r.id))).map((r) => r.id))
    if (uncovered.size === 0) return out
    for (const key of unsynced) {
      const ref = refOf(key)
      if (ref.collection !== 'activity' || lost.has(key) || out.rows.has(ref.id)) continue
      const row = localValue(db, ref.collection, ref.id) as Partial<Activity> | undefined
      if (typeof row?.entityId === 'string' && uncovered.has(row.entityId)) out.rows.add(ref.id)
    }
    return out
  }

  // ------------------------------------------------------------------------------------------
  // Pull
  // ------------------------------------------------------------------------------------------

  async function pullAll(): Promise<Ok | ApiFailure> {
    for (let page = 0; page < 500; page++) {
      const before = conn.seq
      const res = await api.getChanges(before, conn.historyId)
      if (!res.ok) return res
      if (conn.hold) return OK
      // A log that restarted below our seq, or another history, means the server's workspace was
      // replaced, restored or rebuilt: rebase on its snapshot.
      if (res.data.resync || res.data.seq < before) return resync()
      if (res.data.historyId && conn.historyId && res.data.historyId !== conn.historyId) return resync()
      applyPulled(res.data.changes, res.data.seq, res.data.historyId)
      if (!res.data.more || conn.seq <= before) break
    }
    setConn({ lastSyncAt: nowISO() })
    return OK
  }

  /**
   * historyId: the page's. A page (not a resync) means this device's seq belongs to the current history,
   * so a connection that did not know the id yet (saved by an older build) learns it here. Push answers
   * never teach it: an older connection's push is not checked, and may land after a replace.
   */
  function applyPulled(changes: Change[], seq: number, historyId?: string): void {
    const pending = pendingKeys()
    const versions = { ...conn.versions }
    const remote: RemoteChange[] = []
    for (const ch of changes) {
      if (ch.seq <= conn.seq) continue
      const key = recordKey(ch.collection, ch.id)
      // A queued local edit settles at push time (applied, or a conflict where the server wins). A record
      // the server refused keeps this browser's copy until it is retried or replaced.
      if (pending.has(key) || inFlight.has(key)) continue
      // This device's own push coming back, or something older than what we have.
      const known = versions[key]
      if (known !== undefined && ch.version <= known) continue
      // This device's own delete (or anything before it) coming back.
      const deletedAt = ownDeletes.get(key)
      if (deletedAt !== undefined && ch.version <= deletedAt) continue
      const rc: RemoteChange =
        ch.op === 'delete' ? { collection: ch.collection, id: ch.id, op: 'delete' } : { collection: ch.collection, id: ch.id, op: 'upsert', data: ch.data }
      // A collection this build does not know: a newer build resyncs on start (see SYNC_SCHEMA).
      if (!isApplicable(rc)) continue
      if (ch.op === 'delete') delete versions[key]
      else versions[key] = ch.version
      remote.push(rc)
    }
    // Pulls arrive in seq order: an echo at or below this page's seq has come by (or never will).
    for (const [key, v] of ownDeletes) if (v <= seq) ownDeletes.delete(key)
    applyRemote(remote)
    commit({ versions, seq: Math.max(conn.seq, seq), historyId: conn.historyId ?? historyId ?? null })
  }

  /**
   * The server's workspace for the "is it empty?" looks (the connect step, the server_empty hold): asks
   * GET /api/workspace/status first, so an empty server answers kind 'empty' without the 404 of GET
   * /api/workspace, which browsers log as an error; the workspace is downloaded only when there is one.
   */
  async function serverSnapshot(): Promise<ApiResult<WorkspaceSnapshot>> {
    const st = await api.workspaceStatus()
    if (!st.ok) return st
    if (st.data.empty) return { ok: false, kind: 'empty', status: st.status, error: 'empty' }
    // A server from before the status route: the answer already carries the workspace.
    if (st.data.snapshot) return { ok: true, status: st.status, data: st.data.snapshot }
    return api.getWorkspace()
  }

  /** The change log no longer reaches back to our seq: rebase on a full snapshot, keeping queued edits. */
  async function resync(): Promise<Ok | ApiFailure> {
    const res = await api.getWorkspace()
    if (!res.ok) {
      if (res.kind === 'empty') {
        clearPushTimer()
        setConn({ hold: 'server_empty' })
        publish()
        return OK
      }
      return res
    }
    if (conn.hold) return OK
    rebaseOnSnapshot(res.data)
    return OK
  }

  function rebaseOnSnapshot(snap: WorkspaceSnapshot): void {
    const serverDb = prepare(snap.db)
    const local = store.getState().db
    // Another company's workspace on the server (the session belongs to another company's login) is a
    // swap whatever its data says: meta.workspaceId is written by whoever uploaded it, so another company
    // can carry this one's, and merging would send this company's queued edits into it.
    const otherServerWorkspace = conn.workspaceId !== null && snap.workspaceId !== conn.workspaceId
    // The same history as before (a pruned log, a rebuilt store): never a swap. Another history, or one
    // this device cannot compare, is a swap when the server holds a different workspace.
    const sameHistory = conn.historyId !== null && snap.historyId !== undefined && snap.historyId === conn.historyId
    if (otherServerWorkspace || (!sameHistory && isWorkspaceSwap(local, serverDb))) {
      takeRemoteSwap(local, serverDb, snap)
      return
    }
    if (conn.historyId !== null && snap.historyId !== undefined && !sameHistory) {
      // This workspace, from another history: another computer imported a backup of it or re-uploaded it
      // (after the server lost it, or over it), or the server was restored. The versions queued edits were
      // made on belong to the old history, so they are compared by content. This device's own replace or
      // upload learned the new history id from its answer and never gets here.
      rebaseByContent(snap, serverDb)
      restored = { at: nowISO() }
      return
    }
    const pending = pendingKeys()
    const changes = diffDB(store.getState().db, serverDb).filter((c) => !pending.has(recordKey(c.collection, c.id)))
    const versions = { ...snap.versions }
    // Queued edits keep the version they were made on, so a newer server copy still wins at push time.
    for (const key of pending) {
      const v = conn.versions[key]
      if (v === undefined) delete versions[key]
      else versions[key] = v
    }
    const unconfirmed: Record<string, Unconfirmed> = {}
    for (const [key, u] of Object.entries(conn.unconfirmed)) if (pending.has(key)) unconfirmed[key] = u
    applyRemote(changes)
    needsRebase = false
    commit({
      versions,
      unconfirmed,
      seq: snap.seq,
      workspaceId: snap.workspaceId,
      lastSyncAt: nowISO(),
      schema: SYNC_SCHEMA,
      historyId: snap.historyId ?? null,
    })
  }

  /**
   * Another computer replaced the server's workspace with a different one (Start fresh, Import, or its own
   * copy uploaded over this one). Merging would keep this workspace's queued edits and new records inside
   * the other one, so this browser takes the server's whole, with no Undo back into the old one, and keeps
   * what it showed (queued and refused edits included) in memory for a backup download.
   */
  function takeRemoteSwap(local: DB, serverDb: DB, snap: WorkspaceSnapshot): void {
    replacedBackup = local
    const db = withLoadChanges(serverDb)
    setStoreQuietly(db, [])
    holdBaseline = null
    needsRebase = false
    resetRefreshed()
    restored = null
    commit({ ...freshConnection(snap.seq, snap.versions, db, snap.workspaceId, snap.historyId) })
    replaced = {
      companyName: typeof db.company?.name === 'string' ? db.company.name : '',
      previousName: typeof local.company?.name === 'string' ? local.company.name : '',
      at: nowISO(),
    }
    // Effective-dated changes due by now, as when taking the server's copy: synced like any edit.
    if (db !== serverDb) enqueueLocal(diffDB(serverDb, db), serverDb)
    publish()
  }

  // ------------------------------------------------------------------------------------------
  // The demo clock hold, and the server_empty hold
  // ------------------------------------------------------------------------------------------

  /**
   * On a pretend date: makes sure the way back exists (CLOCK_COPY_KEY). The first load on a pretend date
   * saves the workspace as it was saved before this load (opts.baseline), with the connection as it is
   * now. A copy that exists is never replaced: the saved workspace may already hold pretend data. With no
   * saved workspace to copy (or a hold that began without a copy), nothing is saved and going back
   * rebuilds from the server's copy instead.
   */
  function keepClockCopy(db: DB): void {
    clockCopy = loadClockCopy(storage)
    if (clockCopy || hasClockCopy(storage) || conn.hold === 'demo_clock') return
    let saved: DB | null = null
    try {
      saved = opts.baseline?.() ?? null
    } catch {
      saved = null
    }
    if (!saved || isWorkspaceSwap(saved, db)) return
    clockCopy = { db: saved, conn: { ...conn }, needsRebase }
    // Refused (storage full): kept in memory, and tried again with the next edit.
    saveClockCopy(storage, clockCopy)
  }

  /**
   * Back on the real date: the store and the connection go back to the copy saved before the pretend
   * date, as if this browser had been closed meanwhile, and the next cycle catches up with the server
   * the usual way (queued edits keep their base versions, so a newer server copy still wins). The Undo
   * history is cleared. False when the copy cannot be used (then the server's copy rebuilds this browser).
   */
  function leaveClockLocally(held: ClockCopy): boolean {
    let pre: DB
    try {
      pre = prepare(held.db as DB)
    } catch {
      return false
    }
    if (!pre || typeof pre !== 'object' || Array.isArray(pre)) return false
    const db = withLoadChanges(pre)
    setStoreQuietly(db, [])
    holdBaseline = null
    setConn({
      ...held.conn,
      user: conn.user,
      storeMark: conn.storeMark,
      hold: held.conn.hold === 'demo_clock' ? null : held.conn.hold,
      // Due a rebuild from the snapshot when the copy was taken: still due (schema null rebuilds on start).
      schema: held.needsRebase ? null : held.conn.schema,
    })
    rev = Math.max(rev, maxRev(conn))
    needsRebase = conn.schema !== SYNC_SCHEMA
    // Effective-dated changes due by the real date, as on any start.
    if ((!conn.hold || conn.hold === 'server_empty') && db !== pre && (conn.sampleAllowed || !isSampleDB(pre))) {
      enqueueLocal(diffDB(pre, db), pre)
    }
    // Saved at once, so the saved store stops holding what the pretend date applied. The copy goes only
    // once that save worked, or the next start would find pretend data and nothing to rebuild from.
    commit({})
    dropClockCopy()
    return true
  }

  /** The way back was used: forget the copy (only once the store it replaced is saved). */
  function dropClockCopy(): void {
    clockCopy = null
    if (!storeSaveFailed) clearClockCopy(storage)
  }

  /**
   * The demo clock was turned off and there was no copy from before it (see leaveClockLocally): rebuild
   * from the server's copy before anything is pushed. While the clock was on, the store took job changes
   * and hand-offs that are not due yet (marked applied on the pretend date and saved), and edits made then
   * sit on top of them, with pretend timestamps on their activity rows. None of that may reach the server,
   * and it cannot be told apart record by record, so the server's copy replaces it. What is kept goes back
   * on top: edits queued before the clock was set (fixed when the hold began) and refused ones. Nothing
   * was queued since the clock was turned off (the hold stayed). Effective-dated changes due by the real
   * date are applied and synced as usual.
   */
  async function leaveClockHold(): Promise<Ok | ApiFailure> {
    // Another tab may have saved a copy since this one started.
    const held = loadClockCopy(storage)
    if (held && leaveClockLocally(held)) {
      publish()
      return OK
    }
    const res = await api.getWorkspace()
    if (!res.ok) return res
    if (!leavingClock()) return OK
    const snap = res.data
    const serverDb = prepare({ ...snap.db, schemaVersion: 1 })
    const local = store.getState().db
    const sameHistory = conn.historyId !== null && snap.historyId !== undefined && snap.historyId === conn.historyId
    if (!sameHistory && isWorkspaceSwap(local, serverDb)) {
      takeRemoteSwap(local, serverDb, snap)
      dropClockCopy()
      return OK
    }
    const carried: RemoteChange[] = []
    for (const e of [...conn.outbox, ...conn.rejected]) {
      if (e.op === 'delete') carried.push({ collection: e.collection, id: e.id, op: 'delete' })
      else if (e.fixed) carried.push({ collection: e.collection, id: e.id, op: 'upsert', data: e.data })
    }
    const base = applyChanges(serverDb, carried)
    const db = withLoadChanges(base)
    // No Undo back into what the pretend date showed.
    setStoreQuietly(db, [])
    holdBaseline = null
    needsRebase = false
    const pending = pendingKeys()
    const versions = { ...snap.versions }
    // Queued edits keep the version they were made on, so a newer server copy still wins at push time.
    for (const key of pending) {
      const v = conn.versions[key]
      if (v === undefined) delete versions[key]
      else versions[key] = v
    }
    const unconfirmed: Record<string, Unconfirmed> = {}
    for (const [key, u] of Object.entries(conn.unconfirmed)) if (pending.has(key)) unconfirmed[key] = u
    // The store has the queued edits' data again: their entries read it from there, as usual.
    const outbox = conn.outbox.map((e): OutboxEntry => ({ collection: e.collection, id: e.id, op: e.op, rev: e.rev, at: e.at }))
    commit({
      hold: null,
      outbox,
      versions,
      unconfirmed,
      seq: snap.seq,
      workspaceId: snap.workspaceId,
      lastSyncAt: nowISO(),
      schema: SYNC_SCHEMA,
      historyId: snap.historyId ?? null,
    })
    dropClockCopy()
    if (db !== base) enqueueLocal(diffDB(base, db), base)
    publish()
    return OK
  }

  /**
   * The server has a workspace again after the server_empty hold. The same workspace (another computer
   * uploaded its copy): join it, keeping this browser's queued and refused edits. Another workspace: take
   * it whole, keeping a copy of what was here, as when another computer replaces the server's.
   */
  function adoptAfterEmpty(snap: WorkspaceSnapshot): 'joined' | 'switched' {
    const serverDb = prepare({ ...snap.db, schemaVersion: 1 })
    const local = store.getState().db
    if (isWorkspaceSwap(local, serverDb)) {
      takeRemoteSwap(local, serverDb, snap)
      return 'switched'
    }
    joinAfterEmpty(snap, serverDb)
    return 'joined'
  }

  /** Joins the copy of this workspace another computer uploaded to the emptied server (see rebaseByContent). */
  function joinAfterEmpty(snap: WorkspaceSnapshot, serverDb: DB): void {
    rebaseByContent(snap, serverDb, { hold: null })
    catchingUp = true
    publish()
  }

  /**
   * Rebuilds this browser on a server copy of its workspace whose versions say nothing about the copy the
   * queued and refused edits were made on: another computer uploaded it to the emptied server, or it comes
   * from another history (a re-upload, an Import of a backup, a restore). Everything without a queued or
   * refused edit becomes the server's. Each queued key is compared by content instead of by version:
   * where the server's record is still the one the edit was made on (its base print), the edit goes on
   * top, on the server's current version, and so does a document whose server copy changed only fields
   * this device left alone (this device's fields on top of the server's copy). Where it differs (another
   * computer changed the record), the server wins, as in any conflict: the edit is dropped, with its Undo
   * step and unsynced activity rows (planDiscard), and the record counts as refreshed. A key with no base
   * print (queued by an older build) goes on top, as before. `patch` is saved with the new connection.
   */
  function rebaseByContent(snap: WorkspaceSnapshot, serverDb: DB, patch: Partial<ConnectionState> = {}): void {
    const db = store.getState().db
    const lost = new Set<string>()
    const changed: RefreshedRef[] = []
    const merges: DocMerge[] = []
    const bases = { ...conn.bases }
    const fieldBases = { ...conn.fieldBases }
    const queued = new Set(conn.outbox.map((e) => recordKey(e.collection, e.id)))
    for (const key of pendingKeys()) {
      const base = conn.bases[key]
      if (base === undefined) continue
      const { collection, id } = refOf(key)
      const theirs = localValue(serverDb, collection, id)
      if (basePrint(theirs) === base) continue
      const local = localValue(db, collection, id)
      const prints = conn.fieldBases[key]
      if (collection === DOC_COLLECTION && theirs !== undefined && prints && queued.has(key) && fieldsHold(prints, theirs, local)) {
        const fields = Object.keys(prints)
        merges.push({ id, server: theirs, fields })
        bases[key] = basePrint(theirs)
        fieldBases[key] = fieldPrints(theirs, mergeFields(theirs, local, fields))
        continue
      }
      lost.add(key)
      // Load-time activity rows share ids across devices on purpose; taking the server's copy is no news.
      const autoRow = collection === 'activity' && id.startsWith(LOAD_TIME_ACTIVITY_PREFIX)
      if (!autoRow && !deepEqual(local, theirs)) changed.push(refreshedRef(collection, id, local, theirs))
    }
    const pending = pendingKeys()
    const discard = planDiscard(new Set(changed.map((r) => recordKey(r.collection, r.id))), pending)
    for (const id of discard.rows) lost.add(recordKey('activity', id))
    const changes = diffDB(db, serverDb).filter((c) => {
      const key = recordKey(c.collection, c.id)
      return !pending.has(key) || lost.has(key)
    })
    holdBaseline = null
    needsRebase = false
    const kept = (e: OutboxEntry) => !lost.has(recordKey(e.collection, e.id))
    setConn({ ...patch, outbox: conn.outbox.filter(kept), rejected: conn.rejected.filter(kept), bases, fieldBases })
    applyRemote(changes, merges, discard.entries)
    commit({
      versions: { ...snap.versions },
      unconfirmed: {},
      seq: snap.seq,
      workspaceId: snap.workspaceId,
      lastSyncAt: nowISO(),
      schema: SYNC_SCHEMA,
      historyId: snap.historyId ?? null,
    })
    noteRefreshed(changed)
  }

  /**
   * During the server_empty hold: looks at the server again (on start, focus and when back online).
   * Still empty: nothing changes. Otherwise this browser takes what another computer uploaded
   * (adoptAfterEmpty) and syncing resumes.
   */
  function recheckEmpty(): Promise<void> {
    if (recheck) return recheck
    if (conn.mode !== 'server' || conn.hold !== 'server_empty' || !active || signedOut || exclusive > 0 || clockOn() || logoutPending()) {
      return Promise.resolve()
    }
    recheck = exclusiveOp(async () => {
      const res = await serverSnapshot()
      if (!res.ok) {
        if (res.kind !== 'empty') noteAuth(res)
        return
      }
      if (conn.hold === 'server_empty' && active) adoptAfterEmpty(res.data)
    })
      .catch(() => {
        /* nothing changed; the next focus looks again */
      })
      .finally(() => {
        recheck = null
      })
    return recheck
  }

  // ------------------------------------------------------------------------------------------
  // Cycle
  // ------------------------------------------------------------------------------------------

  async function cycle(keepalive: boolean): Promise<void> {
    const epoch = authEpoch
    if (leavingClock()) {
      // The demo clock was turned off: start from the server's copy before anything is pushed.
      const left = await leaveClockHold()
      if (!left.ok) return onFailure(left, epoch)
      if (!canSync()) return
    }
    if (needsRebase) {
      // Saved by another build, or the saved store may be behind the saved progress: start from the
      // server's snapshot (queued edits are kept) before anything is pushed on top of stale versions.
      const rebased = await resync()
      if (!rebased.ok) return onFailure(rebased, epoch)
      needsRebase = false
      if (!canSync()) return
    }
    let pushed = await pushAll(keepalive)
    if (!pushed.ok && pushed.kind === 'resync') {
      // The server's workspace was replaced or restored: nothing was applied. Load it (a different
      // workspace replaces this one whole; the same one keeps queued edits), then push what is left.
      const rebased = await resync()
      if (!rebased.ok) return onFailure(rebased, epoch)
      if (!canSync()) return
      pushed = await pushAll(false)
    }
    if (!pushed.ok) return onFailure(pushed, epoch)
    if (!canSync()) return
    const pulled = await pullAll()
    if (!pulled.ok) return onFailure(pulled, epoch)
    onSuccess()
  }

  function onSuccess(): void {
    failure = null
    backoff = 0
    nextRetryAt = null
    catchingUp = false
    schedulePull()
  }

  function onFailure(f: ApiFailure, epoch = authEpoch): void {
    rerun = false
    if (f.kind === 'signed_out' && epoch !== authEpoch) {
      // The request left before the latest sign-in: try again with the new session.
      rerun = true
      return
    }
    catchingUp = false
    if (f.kind === 'signed_out') {
      // Changes keep queueing; nothing retries until the user signs in again.
      signedOut = true
      failure = null
      clearAllTimers()
      return
    }
    if (f.kind === 'empty') {
      // The server lost its workspace (reset or rebuilt): retrying cannot help; the user decides.
      failure = null
      clearAllTimers()
      setConn({ hold: 'server_empty' })
      return
    }
    failure = { kind: f.kind === 'offline' ? 'offline' : 'error', message: describeFailure(f) }
    clearRetryTimer()
    clearPushTimer()
    if (!active) return
    backoff = backoff === 0 ? minBackoff : Math.min(maxBackoff, backoff * 2)
    nextRetryAt = clock.now() + backoff
    retryTimer = clock.setTimeout(() => {
      retryTimer = null
      nextRetryAt = null
      void requestSync()
    }, backoff)
  }

  function requestSync(o: { keepalive?: boolean } = {}): Promise<void> {
    if (running) {
      rerun = true
      return running
    }
    if (canSync() && logoutPending()) {
      // Another tab of this browser signed out and is still waiting for the server: this tab is signed
      // out too (they share the cookie), and it never syncs from that session.
      signedOut = true
      catchingUp = false
      clearAllTimers()
      publish()
      void endPendingSession()
      return Promise.resolve()
    }
    if (!canSync()) return Promise.resolve()
    clearPushTimer()
    clearPullTimer()
    clearRetryTimer()
    running = (async () => {
      let keepalive = o.keepalive === true
      do {
        rerun = false
        await cycle(keepalive)
        keepalive = false
      } while (rerun && canSync())
    })()
      .catch((err: unknown) => {
        onFailure({ ok: false, kind: 'bad_response', status: null, error: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => {
        running = null
        publish()
      })
    publish()
    return running
  }

  async function exclusiveOp<T>(fn: () => Promise<T>): Promise<T> {
    exclusive++
    clearAllTimers()
    publish()
    try {
      while (running) await running
      return await fn()
    } finally {
      exclusive--
      publish()
      if (exclusive === 0 && canSync()) void requestSync()
    }
  }

  // ------------------------------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------------------------------

  function onFocus(): void {
    if (signedOut) void probeSession()
    else if (conn.hold === 'server_empty') void recheckEmpty()
    else void requestSync()
  }
  function onVisibility(): void {
    if (env.isVisible()) onFocus()
    else {
      clearPullTimer()
      flush()
    }
  }
  function onOnline(): void {
    backoff = 0
    if (conn.hold === 'server_empty') void recheckEmpty()
    else void requestSync()
  }

  let probing = false
  /** Signed out here, but another tab of this browser may have signed in (the cookie is shared). */
  async function probeSession(): Promise<void> {
    if (probing || exclusive > 0 || !active) return
    // This browser signed out and the server has not ended that session yet: end it, never resume it.
    if (logoutPending()) {
      void endPendingSession()
      return
    }
    probing = true
    try {
      // GET /api/auth/session: nobody signed in is an answer, not a 401 in the console.
      const me = await api.session()
      // A session of another company's login (another tab signed in to it) never picks up this copy.
      if (me.ok && me.data.user && signedOut && conn.mode === 'server' && active && !logoutPending() && !otherCompany(me.data.workspace)) {
        resume(me.data.user)
      }
    } finally {
      probing = false
    }
  }

  /** Retries ending the session on focus, when shown again and when the browser comes back online. */
  function watchLogout(): void {
    if (logoutOff.length > 0) return
    const retry = () => void endPendingSession()
    logoutOff = [
      env.on('online', retry),
      env.on('focus', retry),
      env.on('visibilitychange', () => {
        if (env.isVisible()) retry()
      }),
    ]
  }

  function unwatchLogout(): void {
    for (const off of logoutOff) off()
    logoutOff = []
  }

  /** POST /api/auth/logout for a sign-out the server never confirmed. True when no session is left to end. */
  function endPendingSession(): Promise<boolean> {
    if (!logoutPending()) {
      unwatchLogout()
      return Promise.resolve(true)
    }
    // A sign-in is on its way: its new session must not be ended (it clears the flag when it succeeds).
    if (signingIn) return Promise.resolve(false)
    if (endingSession) return endingSession
    endingSession = (async () => {
      try {
        const res = await api.logout()
        // 401: there was no session left to end.
        if (res.ok || res.kind === 'signed_out') {
          setLogoutPending(false)
          publish()
          return true
        }
        watchLogout()
        return false
      } finally {
        endingSession = null
      }
    })()
    return endingSession
  }

  /**
   * The company a login belongs to, when it is not the one this browser syncs with (null: the same, or
   * a server or saved connection from before companies, which hold one company only).
   */
  function otherCompany(workspace: ServerWorkspace | undefined): ServerWorkspace | null {
    return workspace && conn.mode === 'server' && conn.workspaceId !== null && workspace.id !== conn.workspaceId ? workspace : null
  }

  /** A valid session again: start syncing whatever queued up meanwhile. */
  function resume(user: SyncUser): void {
    setConn({ user, signedOutByUser: false })
    authEpoch++
    signedOut = false
    failure = null
    backoff = 0
    activate()
    catchingUp = !shownHold()
    publish()
    if (conn.hold === 'server_empty') void recheckEmpty()
    else void requestSync()
  }

  function flush(): void {
    if (!canSync() || running || conn.outbox.length === 0) return
    void requestSync({ keepalive: true })
  }

  function activate(): void {
    if (active) return
    active = true
    unsubscribe = store.subscribe(onStoreChange)
    envOff = [env.on('focus', onFocus), env.on('visibilitychange', onVisibility), env.on('pagehide', flush), env.on('online', onOnline)]
  }

  function deactivate(): void {
    active = false
    unsubscribe?.()
    unsubscribe = null
    for (const off of envOff) off()
    envOff = []
    clearAllTimers()
    if (leaveWarning) {
      leaveWarning = false
      env.setLeaveWarning?.(false)
    }
  }

  /** Clears everything a connect flow resets. */
  function resetFlags(): void {
    signedOut = false
    failure = null
    backoff = 0
    inspected = null
    holdBaseline = null
    needsRebase = false
    refusals = 0
  }

  function start(): void {
    if (active) return
    const ending = logoutPending()
    if (ending) {
      // Signed out earlier without the server confirming: end that session first; never sync from it.
      watchLogout()
      void endPendingSession()
    }
    if (conn.mode !== 'server') {
      publish()
      return
    }
    activate()
    needsRebase = conn.schema !== SYNC_SCHEMA || conn.storeMark !== readStoreMark(storage)
    if (clockOn()) {
      const loaded = store.getState().db
      // The store took what is due by the pretend date before the engine started: none of it may be
      // queued. The way back is saved first (once, so a later pretend load never replaces it with pretend
      // data); queued entries keep the data of the copy saved before this load.
      keepClockCopy(loaded)
      if (!conn.hold) enterHold('demo_clock', savedBaseline(loaded) ?? loaded)
      if (ending) signedOut = true
      catchingUp = false
      publish()
      return
    }
    // Back on the real date after a pretend one: start from the copy saved before it, before the store is
    // shown, whatever another tab saved in the connection meanwhile. A copy that cannot be read still
    // says the saved store may hold pretend data: the server's copy rebuilds it (the hold stays till then).
    const held = loadClockCopy(storage)
    const restored = held !== null && leaveClockLocally(held)
    if (!restored && hasClockCopy(storage) && conn.hold !== 'demo_clock') setConn({ hold: 'demo_clock' })
    const db = store.getState().db
    if (!conn.hold && isSampleDB(db) && !conn.sampleAllowed) setConn({ hold: 'sample' })
    // While the server is empty, changes applied on load still queue (they are not pushed until it has a
    // workspace again).
    if (!restored && (!conn.hold || conn.hold === 'server_empty')) {
      try {
        const base = savedBaseline(db)
        if (base) {
          // Activity rows logged by changes applied on load get ids every device shares.
          const stable = stabilizeLoadTimeIds(base, db)
          if (stable !== db) setStoreQuietly(stable, store.getState().past)
          const changes = diffDB(base, stable)
          if (changes.length > 0) {
            enqueueLocal(changes, base)
            // Saved now, so the next load does not apply (and log) the same changes again. Not while a
            // rebase is due: a new mark would hide that the saved store is behind (the rebase saves it).
            if (!needsRebase) commit({})
          }
        }
      } catch {
        /* an unreadable save only means nothing extra to queue */
      }
    }
    if (ending || conn.signedOutByUser) {
      // Changes keep queueing; syncing starts again with the next sign-in. After a sign-out the user chose
      // there is no session to try (every request would be a 401), so none is sent.
      signedOut = true
      catchingUp = false
      publish()
      return
    }
    catchingUp = !shownHold()
    publish()
    if (conn.user) {
      // The session may have ended while the browser was closed (a cookie that ends with the browser, the
      // 12-hour limit): ask first, so a page load never meets a 401.
      confirmSession()
      return
    }
    afterStart()
  }

  /** What start does once the session is known to hold (or was not asked about). */
  function afterStart(): void {
    // Another computer may have uploaded since the server was found empty: look again.
    if (conn.hold === 'server_empty') void recheckEmpty()
    else void requestSync()
  }

  /**
   * On start with a saved user: GET /api/auth/session (nobody signed in is an answer there, not a 401)
   * before any route that needs a session. Nobody: signed out, as after a 401, and nothing else is sent
   * until a sign-in (or another tab's, seen on focus). Offline or a server error: start as usual, and the
   * cycle reports it. Nothing syncs while it runs (canSync).
   */
  function confirmSession(): void {
    const epoch = authEpoch
    confirming = (async () => {
      const me = await api.session()
      // A sign-in meanwhile has a new session: an answer about the old one says nothing.
      if (!me.ok || me.data.user || !active || conn.mode !== 'server' || epoch !== authEpoch) return
      signedOut = true
      catchingUp = false
      clearAllTimers()
    })()
      .catch(() => {
        /* nothing learned: start as usual */
      })
      .finally(() => {
        confirming = null
        publish()
        if (active && conn.mode === 'server' && !signedOut) afterStart()
      })
  }

  /** The copy saved before this load (opts.baseline) when it is this workspace, else null. */
  function savedBaseline(db: DB): DB | null {
    try {
      const base = opts.baseline?.() ?? null
      if (base && (conn.sampleAllowed || !isSampleDB(base)) && !isWorkspaceSwap(base, db)) return base
    } catch {
      /* an unreadable save: use what the store shows */
    }
    return null
  }

  function stop(): void {
    deactivate()
    unwatchLogout()
    catchingUp = false
    publish()
  }

  // ------------------------------------------------------------------------------------------
  // Connect flows
  // ------------------------------------------------------------------------------------------

  /**
   * A session this browser signed out of, still waiting for the server: flows that would use it refuse
   * as signed out (and try once more to end it).
   */
  function sessionEndedHere(): FlowFailure | null {
    if (!logoutPending()) return null
    void endPendingSession()
    return fail({ kind: 'signed_out', status: null, error: null })
  }

  /** Flows that would send this browser's workspace, or take the server's, refuse while the demo clock is on. */
  function clockRefusal(): FlowFailure | null {
    return clockOn() ? { ok: false, kind: 'demo_clock', status: null, message: CLOCK_MESSAGE } : null
  }

  async function checkServer(): Promise<CheckServerResult> {
    const health = await api.health()
    if (!health.ok) return fail(health)
    // Signed out earlier without the server confirming: end that session before asking who is signed
    // in, and treat this browser as signed out until the server has ended it.
    if (logoutPending() && !(await endPendingSession())) {
      return { ok: true, version: health.data.version, signedIn: false, user: null }
    }
    // Asked on every page load of a browser that is not connected: a signed-out answer must not be a 401,
    // which the browser would log as an error (api.session falls back to /api/auth/me on older servers).
    const me = await api.session()
    if (!me.ok) return fail(me)
    const user = me.data.user
    if (!user) return { ok: true, version: health.data.version, signedIn: false, user: null }
    if (otherCompany(me.data.workspace)) {
      // The session belongs to another company's login: this browser's copy goes nowhere under it.
      if (!signedOut) {
        signedOut = true
        failure = null
        clearAllTimers()
        publish()
      }
      return { ok: true, version: health.data.version, signedIn: false, user: null }
    }
    if (signedOut && conn.mode === 'server') resume(user)
    else {
      setConn({ user })
      publish()
    }
    if (conn.mode === 'server') return { ok: true, version: health.data.version, signedIn: true, user }
    // Not connected: is there a workspace to take, or is this server waiting for its first one? Never the
    // old servers' fallback here (it would download the whole workspace on every page load).
    const st = await api.workspaceStatus({ fallback: false })
    return st.ok
      ? { ok: true, version: health.data.version, signedIn: true, user, empty: st.data.empty }
      : { ok: true, version: health.data.version, signedIn: true, user }
  }

  /**
   * Sign-up and accepting an invite: a new login, signed in the way signIn is. Only for a browser that
   * does not sync with a server: queued changes of one company must never go out under another's login.
   */
  async function newAccount(call: () => Promise<ApiResult<AccountResponse>>, text: (f: ApiFailure) => string): Promise<AccountResult> {
    if (conn.mode === 'server') return { ok: false, kind: 'pending', status: null, message: CONNECTED_ACCOUNT_MESSAGE }
    // A logout on its way carries the old cookie; let it finish so it cannot end the new session.
    if (endingSession) await endingSession
    signingIn = true
    let res: ApiResult<AccountResponse>
    try {
      res = await call()
    } finally {
      signingIn = false
    }
    if (!res.ok) {
      const out: FlowFailure = { ok: false, kind: res.kind, status: res.status, message: text(res) }
      if (res.retryAfter !== undefined) out.retryAfter = res.retryAfter
      return out
    }
    // The server dropped any session this browser had (a new one with every sign-in).
    if (logoutPending()) setLogoutPending(false)
    setConn({ user: res.data.user, signedOutByUser: false })
    authEpoch++
    publish()
    return { ok: true, user: res.data.user, workspace: res.data.workspace }
  }

  function signUp(input: SignupInput): Promise<AccountResult> {
    const body: SignupInput = { email: input.email.trim(), password: input.password, companyName: input.companyName.trim(), remember: input.remember === true }
    return newAccount(() => api.signup(body), signupFailureText)
  }

  function acceptInvite(input: AcceptInviteInput): Promise<AccountResult> {
    const body: AcceptInviteInput = { token: input.token, email: input.email.trim(), password: input.password, remember: input.remember === true }
    return newAccount(() => api.acceptInvite(body), (f) => inviteFailureText(f, 'join'))
  }

  async function signIn(email: string, password: string, o: LoginOptions = {}): Promise<SignInResult> {
    // A logout on its way carries the old cookie; let it finish so it cannot end the new session.
    if (endingSession) await endingSession
    signingIn = true
    let res: ApiResult<LoginResponse>
    try {
      res = await api.login(email.trim(), password, { remember: o.remember === true })
    } finally {
      signingIn = false
    }
    if (!res.ok) return fail(res)
    // The server dropped the session this browser had (a new one every sign-in), so nothing is left to end.
    if (logoutPending()) setLogoutPending(false)
    const other = otherCompany(res.data.workspace)
    if (other) {
      // A login of another company: this browser's copy and its queued changes must never go out under
      // it, nor be swapped for that company's. The new session ends again (retried on focus and when
      // back online if the server cannot be reached now), and this browser stays as it was, signed out.
      const out = await api.logout()
      if (!out.ok && out.kind !== 'signed_out') {
        setLogoutPending(true)
        watchLogout()
      }
      const here = store.getState().db.company?.name
      return { ok: false, kind: 'other_company', status: null, message: otherCompanyMessage(other.name, typeof here === 'string' ? here : '', waitingEdits()) }
    }
    if (conn.mode === 'server') resume(res.data.user)
    else {
      setConn({ user: res.data.user, signedOutByUser: false })
      authEpoch++
      publish()
    }
    return { ok: true, user: res.data.user }
  }

  /** Why removing this browser's copy now would lose work, or null. */
  function unsyncedWork(): FlowFailure | null {
    if (conn.mode !== 'server') {
      return {
        ok: false,
        kind: 'pending',
        status: null,
        message: 'This browser is not connected to a server, so its workspace exists only here. Export a backup first, or confirm to remove it anyway.',
      }
    }
    // Another tab of this browser may have queued changes this one never saw (they share the saved
    // connection, last writer wins): count them too.
    const saved = storage ? loadConnection(storage) : null
    const n = Math.max(waitingEdits(), saved && saved.mode === 'server' ? waitingEdits(saved) : 0)
    if (n > 0) {
      const them = n === 1 ? 'it' : 'them'
      // Signed out, nothing can be sent: the way to keep them is to sign in, not Sync now.
      const how = signedOut || logoutPending() ? `Sign in to send ${them} first, or remove ${them} anyway.` : `Sync first, or confirm to remove ${them} anyway.`
      return {
        ok: false,
        kind: 'pending',
        status: null,
        pending: n,
        message: `${plural(n, 'change has', 'changes have')} not reached the server. Removing this browser's data now loses ${them}. ${how}`,
      }
    }
    if (conn.hold === 'replaced') {
      return {
        ok: false,
        kind: 'pending',
        status: null,
        message: 'This browser holds a workspace that was never uploaded. Removing this browser\'s data now loses it. Upload it first, or confirm to remove it anyway.',
      }
    }
    return null
  }

  function signOut(o: SignOutOptions = {}): Promise<SignOutResult> {
    return exclusiveOp(async (): Promise<SignOutResult> => {
      if (o.forgetThisBrowser && !o.discardPending) {
        // Send what is queued while the session still works; what cannot be sent stops the wipe.
        if (conn.mode === 'server' && !conn.hold && !signedOut && conn.outbox.length > 0) {
          const pushed = await pushAll(false)
          if (!pushed.ok) noteAuth(pushed)
        }
        const blocked = unsyncedWork()
        if (blocked) return blocked
      } else if (!o.forgetThisBrowser && conn.mode === 'server' && !conn.hold && !signedOut && !logoutPending() && conn.outbox.length > 0) {
        // Send what is queued while the session still works, for a few seconds at most: what is left
        // waits here until the next sign-in in this browser (the result says how many).
        const pushed = await pushAll(false, clock.now() + SIGN_OUT_PUSH_MS)
        if (!pushed.ok) noteAuth(pushed)
      }
      // Is there a session this browser may hold? A browser that never signed in has none to end.
      const mayHoldSession = conn.mode === 'server' || conn.user !== null || logoutPending()
      const res = await api.logout()
      // 401: no session was left to end, which is what signing out wants.
      const confirmed = res.ok || (!res.ok && res.kind === 'signed_out')
      inspected = null
      if (o.forgetThisBrowser) {
        // The session cookie is HttpOnly: only the server can end it. Removing the data while it stays
        // valid would leave the next person at this computer one click from the whole workspace.
        if (!confirmed && mayHoldSession && !o.keepServerSession) {
          return { ok: false, kind: 'session_open', status: res.ok ? null : res.status, message: SESSION_OPEN_MESSAGE }
        }
        // Other tabs hear about it through the storage events of wipeLocal (index.ts) and drop their copy.
        deactivate()
        conn = emptyConnection()
        clearConnection(storage)
        try {
          opts.wipeLocal?.()
        } catch {
          /* storage unavailable: nothing was saved there either */
        }
        dropped = true
        const fresh = opts.freshDB ? opts.freshDB() : emptiedDB(store.getState().db)
        setStoreQuietly(fresh, [])
        resetFlags()
        connSaveFailed = false
        storeSaveFailed = false
        lastPersistedDb = null
        resetRefreshed()
        replaced = null
        restored = null
        replacedBackup = null
        catchingUp = false
        rev = 0
        // Written after the wipe: the next load treats this browser as signed out and ends the session.
        setLogoutPending(!confirmed && mayHoldSession)
        publish()
        const message = confirmed || !mayHoldSession ? FORGOTTEN_MESSAGE : FORGOTTEN_OPEN_MESSAGE
        // The page that would show the message is about to go: the reload carries it to the next one.
        opts.reload?.(message)
        return { ok: true, confirmed, forgotten: true, waiting: 0, message }
      }
      // On purpose: Settings keeps saying so (not that the session ended) until the next sign-in.
      setConn({ user: null, signedOutByUser: conn.mode === 'server' })
      if (conn.mode === 'server') {
        signedOut = true
        catchingUp = false
      }
      // Not confirmed: never resume from that session (focus, start, Settings), and end it once the
      // server answers.
      setLogoutPending(!confirmed && mayHoldSession)
      // Refused changes are not counted: they need Retry (or Discard), not a sign-in.
      const waiting = conn.mode === 'server' ? countEdits(conn.outbox, store.getState().db) : 0
      const said = confirmed || !mayHoldSession ? SIGNED_OUT_MESSAGE : LOGOUT_PENDING_MESSAGE
      return { ok: true, confirmed, waiting, message: waiting > 0 ? `${said} ${notSentText(waiting)}` : said }
    })
  }

  async function inspectServer(): Promise<InspectResult> {
    const ended = sessionEndedHere()
    if (ended) return ended
    const res = await serverSnapshot()
    if (!res.ok) {
      inspected = null
      if (res.kind === 'empty') return { ok: true, empty: true }
      noteAuth(res)
      publish()
      return fail(res)
    }
    inspected = { snap: res.data, at: clock.now() }
    const db = res.data.db as Partial<DB>
    const count = (v: unknown) => (Array.isArray(v) ? v.length : 0)
    return {
      ok: true,
      empty: false,
      sample: db.meta?.sample === true,
      companyName: typeof db.company?.name === 'string' ? db.company.name : '',
      counts: { people: count(db.people), candidates: count(db.candidates), jobs: count(db.jobs) },
      seq: res.data.seq,
      db: prepare({ ...res.data.db, schemaVersion: 1 }),
    }
  }

  /** Connection state right after the whole workspace was exchanged with the server. */
  function freshConnection(
    seq: number,
    versions: Record<string, number>,
    db: DB,
    workspaceId: string,
    historyId: string | undefined,
  ): Partial<ConnectionState> {
    return {
      mode: 'server',
      seq,
      versions: { ...versions },
      outbox: [],
      rejected: [],
      unconfirmed: {},
      bases: {},
      fieldBases: {},
      hold: null,
      signedOutByUser: false,
      sampleAllowed: isSampleDB(db),
      workspaceId,
      lastSyncAt: nowISO(),
      schema: SYNC_SCHEMA,
      historyId: historyId ?? null,
    }
  }

  /** A new workspace identity (see workspaceIdOf in loadTime.ts). */
  const makeWorkspaceId = (): string => newId('ws')

  /**
   * The server workspace an upload went to, as its answer says, so the connection knows which company
   * it syncs with. Servers from before companies do not say: they hold one workspace, 'default'.
   */
  const uploadedTo = (r: PutWorkspaceResponse): string => r.workspaceId ?? conn.workspaceId ?? 'default'

  function uploadLocal(o: UploadOptions = {}): Promise<FlowResult> {
    return exclusiveOp(async (): Promise<FlowResult> => {
      const ended = sessionEndedHere() ?? clockRefusal()
      if (ended) return ended
      // Back on the real date but not rebuilt yet: the store still shows what the pretend date applied.
      if (leavingClock()) return { ok: false, kind: 'demo_clock', status: null, message: LEAVING_CLOCK_MESSAGE }
      const fresh = conn.mode !== 'server'
      const current = store.getState().db
      if (isSampleDB(current) && !o.includeSample) return { ok: false, kind: 'sample', status: null, message: SAMPLE_MESSAGE }
      // Every workspace a server holds gets an identity, so other computers can tell when the server's
      // workspace was swapped for another one.
      const db = withWorkspaceId(current, makeWorkspaceId)
      const res = await api.putWorkspace(db, o.confirmReplace === true)
      if (!res.ok) {
        noteAuth(res)
        if (res.kind === 'not_empty' && conn.mode === 'server' && conn.hold === 'server_empty') {
          // Another computer uploaded after the server lost its workspace: take what it uploaded instead
          // of staying paused (the same workspace keeps this browser's queued edits on top).
          const snap = await api.getWorkspace()
          if (snap.ok && conn.hold === 'server_empty') {
            const how = adoptAfterEmpty(snap.data)
            return { ok: true, message: how === 'joined' ? JOINED_MESSAGE : SWITCHED_MESSAGE }
          }
          if (!snap.ok) noteAuth(snap)
        }
        return fail(res)
      }
      // From here on this is the synced workspace: no Undo step from before connecting may turn into
      // changes on the server (Undo would swap the old workspace back in for every device).
      const after = store.getState().db
      setStoreQuietly(after === current ? db : withWorkspaceId(after, () => workspaceIdOf(db) ?? makeWorkspaceId()), [])
      commit(freshConnection(res.data.seq, res.data.versions, db, uploadedTo(res.data), res.data.historyId))
      // A demo clock copy left from another connection must never be restored over this one.
      if (fresh) dropClockCopy()
      resetFlags()
      activate()
      // Edits made while the upload was on its way go out as ordinary changes.
      const now = store.getState().db
      if (now !== db) enqueueLocal(diffDB(db, now), db)
      return OK
    })
  }

  function uploadNew(input: DB): Promise<FlowResult> {
    return exclusiveOp(async (): Promise<FlowResult> => {
      const ended = sessionEndedHere() ?? clockRefusal()
      if (ended) return ended
      if (conn.mode === 'server') return { ok: false, kind: 'pending', status: null, message: CONNECTED_ACCOUNT_MESSAGE }
      if (isSampleDB(input)) return { ok: false, kind: 'sample', status: null, message: SAMPLE_MESSAGE }
      // A new workspace gets its identity, and the changes due on load, before it leaves: every device
      // that takes the server's copy starts from exactly this.
      const db = withLoadChanges(prepare({ ...withWorkspaceId(input, makeWorkspaceId), schemaVersion: 1 }))
      const res = await api.putWorkspace(db, false)
      if (!res.ok) return fail(res)
      // No Undo step: undoing would swap the old workspace back in as record-by-record changes.
      setStoreQuietly(db, [])
      commit(freshConnection(res.data.seq, res.data.versions, db, uploadedTo(res.data), res.data.historyId))
      // A demo clock copy left from another connection must never be restored over this one.
      dropClockCopy()
      resetFlags()
      resetRefreshed()
      activate()
      return OK
    })
  }

  function useServerCopy(o: { discardPending?: boolean } = {}): Promise<FlowResult> {
    return exclusiveOp(async (): Promise<FlowResult> => {
      const ended = sessionEndedHere() ?? clockRefusal()
      if (ended) return ended
      // Back on the real date but not rebuilt yet (no copy from before the pretend date): this is the
      // rebuild. A new connection: a copy left from another one must never be restored over it.
      const dropCopy = leavingClock() || conn.mode !== 'server'
      if (!o.discardPending && conn.mode === 'server' && conn.hold === 'server_empty') {
        // The server lost its workspace, so queued edits could not be sent first. If it holds this same
        // workspace again (another computer uploaded it), join that copy with the edits on top.
        const res = await serverSnapshot()
        if (!res.ok) {
          noteAuth(res)
          return fail(res)
        }
        const serverDb = prepare({ ...res.data.db, schemaVersion: 1 })
        if (!isWorkspaceSwap(store.getState().db, serverDb)) {
          joinAfterEmpty(res.data, serverDb)
          return OK
        }
        const n = conn.outbox.length + conn.rejected.length > 0 ? waitingEdits() : 0
        if (n > 0) {
          return {
            ok: false,
            kind: 'pending',
            status: null,
            pending: n,
            message: `${plural(n, 'change was', 'changes were')} made to a workspace your server no longer has. Using the server's copy discards ${n === 1 ? 'it' : 'them'}.`,
          }
        }
        inspected = { snap: res.data, at: clock.now() }
      }
      if (!o.discardPending && conn.mode === 'server') {
        // Queued edits belong to the server's workspace: send them first so they are in the copy.
        if (conn.outbox.length > 0) {
          const pushed = await pushAll(false)
          if (!pushed.ok && pushed.kind === 'resync') {
            // The server's workspace was replaced or restored since: these edits have nowhere to go.
            const n = countEdits(conn.outbox, store.getState().db)
            return {
              ok: false,
              kind: 'pending',
              status: null,
              pending: n,
              message: `${plural(n, 'change was', 'changes were')} made to a copy your server no longer has (it was replaced or restored). Using the server's copy discards ${n === 1 ? 'it' : 'them'}.`,
            }
          }
          if (!pushed.ok) {
            noteAuth(pushed)
            return fail(pushed)
          }
          inspected = null
        }
        const kept = conn.rejected.length
        if (kept > 0) {
          return {
            ok: false,
            kind: 'pending',
            status: null,
            pending: kept,
            message: `${plural(kept, 'change the server refused is', 'changes the server refused are')} kept only in this browser. Using the server's copy discards ${kept === 1 ? 'it' : 'them'}.`,
          }
        }
        if (conn.hold === 'replaced') {
          return {
            ok: false,
            kind: 'pending',
            status: null,
            message: 'This browser\'s workspace was replaced (Import or Start fresh) and never uploaded. Using the server\'s copy discards it.',
          }
        }
      }
      let snap: WorkspaceSnapshot
      if (inspected && clock.now() - inspected.at < INSPECT_TTL_MS) snap = inspected.snap
      else {
        const res = await api.getWorkspace()
        if (!res.ok) {
          noteAuth(res)
          return fail(res)
        }
        snap = res.data
      }
      inspected = null
      const serverDb = prepare({ ...snap.db, schemaVersion: 1 })
      // Effective-dated changes due by now, as useDB.replace would apply them; synced below.
      const db = withLoadChanges(serverDb)
      setStoreQuietly(db, [])
      commit(freshConnection(snap.seq, snap.versions, db, snap.workspaceId, snap.historyId))
      if (dropCopy) dropClockCopy()
      resetFlags()
      activate()
      if (db !== serverDb) enqueueLocal(diffDB(serverDb, db), serverDb)
      return OK
    })
  }

  function replaceLocally(db: DB, label?: string): void {
    const state = store.getState()
    if (state.replace) state.replace(db, label)
    else store.setState({ db, past: state.past })
  }

  function replaceWorkspace(input: DB, o: { label?: string } = {}): Promise<FlowResult> {
    // A new workspace (Start fresh, or a backup saved before identities) gets its identity here; an
    // imported backup that has one keeps it. The sample needs none: its flag tells it apart.
    const next = isSampleDB(input) ? input : withWorkspaceId(input, makeWorkspaceId)
    // Not connected, or the sample (which never uploads this way): an ordinary local replace. The store
    // subscription puts a connection on hold for the sample.
    if (conn.mode !== 'server' || (isSampleDB(next) && !conn.sampleAllowed)) {
      replaceLocally(next, o.label)
      return Promise.resolve(OK)
    }
    return exclusiveOp(async (): Promise<FlowResult> => {
      const ended = sessionEndedHere() ?? clockRefusal()
      if (ended) return ended
      const db = withLoadChanges(prepare({ ...next, schemaVersion: 1 }))
      const res = await api.putWorkspace(db, true)
      if (!res.ok) {
        noteAuth(res)
        return fail(res)
      }
      // No Undo step: undoing would turn the old workspace into record-by-record changes again.
      setStoreQuietly(db, [])
      commit(freshConnection(res.data.seq, res.data.versions, db, uploadedTo(res.data), res.data.historyId))
      resetFlags()
      resetRefreshed()
      restored = null
      activate()
      return OK
    })
  }

  function discardRejected(refs?: RecordRef[]): Promise<FlowResult> {
    const wanted = refs ? new Set(refs.map((r) => recordKey(r.collection, r.id))) : null
    const keys = new Set(conn.rejected.map((r) => recordKey(r.collection, r.id)).filter((k) => !wanted || wanted.has(k)))
    if (keys.size === 0) return Promise.resolve(OK)
    return exclusiveOp(async (): Promise<FlowResult> => {
      if (conn.hold) {
        return { ok: false, kind: 'pending', status: null, message: 'Syncing is paused. Resume it in Settings, Server first, then discard the change.' }
      }
      // A record the server may hold gets its copy back; one it never had (a new note) is removed here.
      let snap: WorkspaceSnapshot | null = null
      if ([...keys].some(isKnown)) {
        const ended = sessionEndedHere()
        if (ended) return ended
        const res = await api.getWorkspace()
        if (!res.ok) {
          noteAuth(res)
          return fail(res)
        }
        snap = res.data
      }
      const serverDb = snap ? prepare({ ...snap.db, schemaVersion: 1 }) : null
      const versions = { ...conn.versions }
      const remote: RemoteChange[] = []
      for (const key of keys) {
        const { collection, id } = refOf(key)
        const theirs = serverDb ? localValue(serverDb, collection, id) : undefined
        if (theirs === undefined) {
          remote.push({ collection, id, op: 'delete' })
          delete versions[key]
        } else {
          remote.push({ collection, id, op: 'upsert', data: theirs })
          if (snap?.versions[key] !== undefined) versions[key] = snap.versions[key]
        }
      }
      // The Undo step that made the change goes when nothing else is left of it, and so do the activity
      // rows it logged, even ones an earlier batch delivered (the change itself never reached the server):
      // queued ones leave the outbox, and the ones the server has get a delete. After a reload (no Undo
      // history) only rows still queued about the record go: see planDiscard.
      const discard = planDiscard(keys, pendingKeys(), true)
      const rowDeletes: LocalChange[] = []
      for (const id of discard.rows) {
        remote.push({ collection: 'activity', id, op: 'delete' })
        rowDeletes.push({ collection: 'activity', id, op: 'delete' })
      }
      const rows = new Set(rowDeletes.map((d) => recordKey(d.collection, d.id)))
      const kept = (e: OutboxEntry) => !keys.has(recordKey(e.collection, e.id))
      const before = store.getState().db
      setConn({ outbox: conn.outbox.filter(kept), rejected: conn.rejected.filter((e) => kept(e) && !rows.has(recordKey(e.collection, e.id))) })
      applyRemote(remote, [], discard.entries)
      commit({ versions })
      // A delete of a row the server never had just drops its queued entry (enqueueChanges).
      enqueueLocal(rowDeletes, before)
      return OK
    })
  }

  async function disconnect(o: { discardPending?: boolean } = {}): Promise<DisconnectResult> {
    const pending = conn.outbox.length > 0 ? countEdits(conn.outbox, store.getState().db) : 0
    if (conn.mode === 'server' && pending > 0 && !o.discardPending) {
      return {
        ok: false,
        kind: 'pending',
        status: null,
        pending,
        message: `${pending} change${pending === 1 ? ' has' : 's have'} not reached the server yet. Disconnecting keeps ${pending === 1 ? 'it' : 'them'} in this browser only.`,
      }
    }
    return exclusiveOp(async (): Promise<DisconnectResult> => {
      deactivate()
      let confirmed = true
      const mayHoldSession = conn.mode === 'server' || conn.user !== null || logoutPending()
      if (mayHoldSession) {
        const res = await api.logout()
        confirmed = res.ok || res.kind === 'signed_out'
      }
      conn = emptyConnection()
      clearConnection(storage)
      resetFlags()
      connSaveFailed = false
      storeSaveFailed = false
      resetRefreshed()
      replaced = null
      restored = null
      replacedBackup = null
      catchingUp = false
      // The flag outlives the connection: the next check or start ends the session instead of using it.
      setLogoutPending(!confirmed)
      return { ok: true, confirmed, message: confirmed ? DISCONNECTED_MESSAGE : DISCONNECTED_PENDING_MESSAGE }
    })
  }

  return {
    start,
    stop,
    syncNow: async () => {
      // The user asked: refusals start counting again (a bad record can be set aside once more).
      refusals = 0
      // A running cycle may have read the outbox already: ask it for one more pass and wait for it.
      if (running) {
        rerun = true
        await running
        return
      }
      await requestSync()
    },
    whenIdle: async () => {
      // The session check on start and a look at the emptied server (recheckEmpty) can start a cycle when
      // they end: wait for all of them.
      for (let p = confirming ?? recheck ?? running; p; p = confirming ?? recheck ?? running) await p
    },
    flush,
    checkServer,
    signIn,
    signUp,
    acceptInvite,
    signOut,
    inspectServer,
    uploadLocal,
    uploadNew,
    useServerCopy,
    replaceWorkspace,
    disconnect,
    clearRefreshed: () => {
      resetRefreshed()
      publish()
    },
    discardRejected,
    retryRejected: () => {
      // A change too large to sync would only be set aside again: it waits for a shorter edit or Discard.
      const retry = conn.rejected.filter((r) => r.reason !== 'too_large')
      if (retry.length === 0) return
      const queued = new Set(conn.outbox.map((e) => recordKey(e.collection, e.id)))
      // Read from the store again (it kept the record), unless the store shows something else right now.
      const back = retry
        .filter((r) => !queued.has(recordKey(r.collection, r.id)))
        .map(({ reason: _reason, ...e }): OutboxEntry => (conn.hold ? e : { collection: e.collection, id: e.id, op: e.op, rev: e.rev, at: e.at }))
      refusals = 0
      setConn({ outbox: [...conn.outbox, ...back], rejected: conn.rejected.filter((r) => r.reason === 'too_large') })
      publish()
      schedulePush()
    },
    getConnection: () => conn,
    dropLocal: () => {
      deactivate()
      unwatchLogout()
      dropped = true
      conn = emptyConnection()
      inspected = null
      resetFlags()
      connSaveFailed = false
      storeSaveFailed = false
      lastPersistedDb = null
      resetRefreshed()
      replaced = null
      restored = null
      replacedBackup = null
      catchingUp = false
      rev = 0
      setStoreQuietly(opts.freshDB ? opts.freshDB() : emptiedDB(store.getState().db), [])
      publish()
    },
    disconnectedElsewhere: () => {
      if (conn.mode !== 'server') return
      deactivate()
      // Not saved: the other tab already removed the connection, and this tab must not write it back.
      conn = emptyConnection()
      inspected = null
      resetFlags()
      connSaveFailed = false
      storeSaveFailed = false
      resetRefreshed()
      replaced = null
      restored = null
      replacedBackup = null
      catchingUp = false
      publish()
    },
    getReplacedBackup: () => replacedBackup,
    clearReplacedRemotely: () => {
      replaced = null
      replacedBackup = null
      publish()
    },
    clearRestoredRemotely: () => {
      restored = null
      publish()
    },
    endPendingSession,
  }
}

/** The fallback "fresh" workspace after forgetting a browser: every record gone, documents kept. */
function emptiedDB(db: DB): DB {
  const out = { ...db } as unknown as Record<string, unknown>
  for (const c of RECORD_COLLECTIONS) out[c] = []
  return out as unknown as DB
}
