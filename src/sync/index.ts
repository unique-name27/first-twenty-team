// Public API of the sync engine for the app and the sync UI (Settings > Data > Server, header chip).
// Importing this module has no side effects; nothing talks to a server until initSync() finds a saved
// server connection or the user goes through a connect flow.
//
//   initSync()                       call once at startup, before the first edit (main.tsx); a no-op in a
//                                    local-only install
//   isServedPage()                   was this page served by a First Twenty server (its meta tag)?
//   useSyncStatus((s) => s.status)   'local' | 'synced' | 'syncing' | 'offline' | 'signed_out' | 'error'
//   connect.checkServer()            is a server answering at this origin, and are we signed in?
//   connect.signIn(email, password, {remember?})   remember: "Keep me signed in" (7 days instead of
//                                    ending with the browser or after 12 hours)
//   connect.inspectServer()          empty, or what the server holds (company name, counts)
//   connect.uploadLocal({confirmReplace?, includeSample?})   this browser's workspace -> server
//   connect.useServerCopy({discardPending?})                 server's workspace -> this browser
//   connect.signUp({email, password, companyName, remember?})   a demo server (signupMode 'open'): a new
//                                    login and company, signed in; then connect.uploadNew(db) puts the new
//                                    company's workspace there and starts syncing
//   connect.acceptInvite({token, email, password, remember?})   a new login in an invite's company, signed
//                                    in; then connect.useServerCopy() takes its workspace
//   demoSignup()                     may anyone create a demo company here? (once per page load)
//   inviteInfo(token), createInvite() the company an invite joins; a new invite link (admins)
//   listInvites(), revokeInvite(id)  the company's open invite links, and revoking one (admins)
//   setCareers(enabled)              turns the company's careers page on or off (admins)
//   useServerAccount(ask)            the signed-in login's company on the server (name, careers page)
//   replaceWorkspace(db, label)      Import and Start fresh: use this instead of useDB.replace, so a
//                                    connected browser replaces the server's workspace as a whole
//   signOut()                        sends queued changes (a few seconds at most), then ends the session;
//                                    this browser keeps an offline copy. Resolves {confirmed, waiting,
//                                    message}: confirmed false means the server could not be reached; the
//                                    browser stays signed out and ends the session later. waiting: changes
//                                    not sent yet (the message says so)
//   signOut({forgetThisBrowser: true, discardPending?, keepServerSession?})   "Sign out and remove data
//                                    from this browser"; kind 'session_open' when the server could not end
//                                    the session (nothing removed) unless keepServerSession
//   disconnect({discardPending?})    resolves {confirmed, message} like signOut
//   syncNow(), clearRefreshed(), retryRejected()
//   discardRejected(refs?)           drops refused changes and puts the server's copy back (no Undo step)
//   getReplacedBackup(), clearReplacedRemotely()   the workspace shown before another computer replaced
//                                    the server's (status.replacedRemotely), for a backup download
//   clearRestoredRemotely()          dismisses status.restoredRemotely (the server's copy was replaced by
//                                    another copy of this workspace)
//   takeReloadNotice()               a notice the page before a reload left (Sign out and remove data), once
//   assistantInfo(), assistantChat(input, handlers)   the assistant on the server (GET /api/assistant, the
//                                    streamed POST /api/assistant/chat); see ./assistant
//   assistantWorkspaceKey()          the server workspace and history this tab is connected to, which an
//                                    assistant conversation belongs to
// Other tabs: removing this browser's data or disconnecting in one tab stops the engine in the others
// (storage events plus a BroadcastChannel), so no tab writes the workspace or the connection back.
import { useEffect } from 'react'
import { useStore } from 'zustand'
import type { DB } from '@/domain/types'
import { getClockOverride } from '@/lib/dates'
import { applyLoadChanges, loadSample, migrate, persistingHeld, stopPersisting, STORAGE_KEY, useDB } from '@/store/db'
import { type AccountLoader, createAccountLoader, type ServerAccount } from './account'
import { type AcceptInviteInput, type ApiFailure, createApi, describeFailure, type LoginOptions, type SignupInput, type SyncApi } from './api'
import { type AssistantApi, createAssistantApi, type ChatHandlers, type ChatInput } from './assistant'
import { type DemoSignup, demoSignupOf, inviteFailureText, isInviteToken } from './demo'
import { createSyncEngine, type FlowFailure, type FlowResult, type SignOutOptions, type SyncEngine, type UploadOptions } from './engine'
import { type CareersSwitchResponse, type InviteInfo, type InviteResponse, type OpenInvite, SERVED_MARKER } from './protocol'
import { defaultStorage, LOGOUT_PENDING_KEY, loadConnection, readLogoutPending, type StorageLike, SYNC_STORAGE_KEY } from './state'
import { type RecordRef, useSyncStatus } from './status'

export type { ServerAccount } from './account'
export type { AcceptInviteInput, ApiErrorKind, ApiFailure, ApiResult, LoginOptions, SignupInput, SyncApi } from './api'
export type { AssistantApi, AssistantFailure, AssistantFailureKind, AssistantInfo, AssistantResult, ChatDone, ChatHandlers, ChatInput } from './assistant'
export { describeFailure } from './api'
export type { DemoSignup } from './demo'
export { companyNameProblem, demoNotice, newPasswordProblem, signupEmailProblem } from './demo'
export type {
  AccountResult,
  CheckServerResult,
  DisconnectResult,
  FlowFailure,
  FlowResult,
  InspectResult,
  SignInResult,
  SignOutOptions,
  SignOutResult,
  SyncEngine,
  UploadOptions,
} from './engine'
export {
  CLOCK_MESSAGE,
  CONNECTED_ACCOUNT_MESSAGE,
  DISCONNECTED_MESSAGE,
  DISCONNECTED_PENDING_MESSAGE,
  FORGOTTEN_MESSAGE,
  FORGOTTEN_OPEN_MESSAGE,
  LEAVING_CLOCK_MESSAGE,
  LOGOUT_PENDING_MESSAGE,
  SAMPLE_MESSAGE,
  SESSION_OPEN_MESSAGE,
  SIGNED_OUT_MESSAGE,
  STORAGE_FULL_MESSAGE,
  SWITCHED_MESSAGE,
  JOINED_MESSAGE,
} from './engine'
export type { InviteInfo, InviteResponse, OpenInvite, ServerWorkspace, SignupMode, SyncUser } from './protocol'
export { INVITE_ROUTE, MAX_COMPANY_NAME_LENGTH, MIN_PASSWORD_LENGTH } from './protocol'
export type { HoldReason, SyncMode } from './state'
export type { RecordRef, RefreshedRef, RejectedRef, ReplacedRemotely, RestoredRemotely, SyncStatus, SyncStatusState } from './status'
export { useSyncStatus, waitingCount } from './status'

/** Every key this app keeps in localStorage starts with this. */
export const APP_STORAGE_PREFIX = 'first-twenty:'

/**
 * True on a page the First Twenty server served: it adds the SERVED_MARKER meta tag to the app page.
 * Never for the one-file build opened from disk, the claude.ai artifact viewer or the Vite dev server, so
 * a check that only a served page should make (the offline worker, asking whether the server is here)
 * never probes /api elsewhere.
 */
export function isServedPage(): boolean {
  try {
    return typeof document !== 'undefined' && document.querySelector(`meta[name="${SERVED_MARKER}"]`) !== null
  } catch {
    return false
  }
}

let engine: SyncEngine | null = null
let sharedApi: SyncApi | null = null

/** The one API client of this page, shared by the engine and the account and invite calls below. */
function getApi(): SyncApi {
  sharedApi ??= createApi()
  return sharedApi
}

/** The workspace as db.ts last saved it (before this load's effective-dated changes), or null. */
export function readSavedDB(storage: StorageLike | null): DB | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as DB
    if (parsed?.schemaVersion !== 1 || !parsed.company) return null
    return migrate(parsed)
  } catch {
    return null
  }
}

/**
 * What db.ts does to a workspace when it loads (effective-dated changes and hand-offs due by today, then
 * offer expiry): the store's own function, so the two can never drift apart.
 */
export { applyLoadChanges }

/**
 * Removes every key of this app from localStorage (the workspace, the sync state, preferences), except
 * the ones in `keep`.
 */
export function wipeAppStorage(storage?: Pick<Storage, 'length' | 'key' | 'removeItem'> | null, keep: readonly string[] = []): void {
  try {
    const s = storage === undefined ? (typeof localStorage === 'undefined' ? null : localStorage) : storage
    if (!s) return
    const keys: string[] = []
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i)
      if (k?.startsWith(APP_STORAGE_PREFIX) && !keep.includes(k)) keys.push(k)
    }
    for (const k of keys) s.removeItem(k)
  } catch {
    /* storage blocked: nothing was saved there either */
  }
}

// ---------------------------------------------------------------------------------------------
// A notice across a reload
// ---------------------------------------------------------------------------------------------

/**
 * sessionStorage key for a notice the page shows once after it reloads (Sign out and remove data reloads
 * before its toast could be read). sessionStorage, not localStorage: removing this browser's data clears
 * every first-twenty: key there, and this belongs to this tab's next page only.
 */
export const RELOAD_NOTICE_KEY = 'first-twenty-reload-notice'

type SessionLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function sessionStore(storage?: SessionLike | null): SessionLike | null {
  if (storage !== undefined) return storage
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

/** Leaves a notice for the page after the next reload. A browser that refuses just shows none. */
export function leaveReloadNotice(text: string, storage?: SessionLike | null): void {
  try {
    sessionStore(storage)?.setItem(RELOAD_NOTICE_KEY, text)
  } catch {
    /* storage blocked: no notice after the reload */
  }
}

/** The notice the page before the reload left, once (it is removed as it is read), or null. */
export function takeReloadNotice(storage?: SessionLike | null): string | null {
  try {
    const s = sessionStore(storage)
    const text = s?.getItem(RELOAD_NOTICE_KEY) ?? null
    if (text !== null) s?.removeItem(RELOAD_NOTICE_KEY)
    return text || null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// Other tabs of this browser
// ---------------------------------------------------------------------------------------------

/** BroadcastChannel name shared by every tab of the app on this origin. */
export const TAB_CHANNEL = 'first-twenty'

export type TabMessage = { type: 'forget' }

/**
 * What another tab's storage change means for this one:
 * - 'forget': the workspace key was removed (only Sign out and remove data does that);
 * - 'disconnect': the sync state was removed but the workspace stays (Disconnect);
 * - null: nothing to do. That includes storage.clear() (key null): another page on a shared origin (every
 *   page opened from disk shares one) may clear it, and this tab's copy may then be the only one left.
 */
export function storageChangeAction(e: { key: string | null; newValue: string | null }): 'forget' | 'disconnect' | null {
  if (e.key === null || e.newValue !== null) return null
  if (e.key === STORAGE_KEY) return 'forget'
  if (e.key === SYNC_STORAGE_KEY) return 'disconnect'
  return null
}

let tabChannel: BroadcastChannel | null = null
let tabsWired = false
let forgotten = false

/** Tells the other tabs that this browser's data is being removed. */
function announceForget(): void {
  try {
    tabChannel?.postMessage({ type: 'forget' } satisfies TabMessage)
  } catch {
    /* no channel: the storage events still reach them */
  }
}

/**
 * Another tab removed this browser's data: stop syncing, show the fresh workspace, remove anything this
 * tab may have written meanwhile (keeping a pending sign-out), and reload so nothing stays in memory. The
 * store stops saving first (stopPersisting), so nothing is written back on the way out.
 */
export function forgetInThisTab(o: { storage?: Pick<Storage, 'length' | 'key' | 'removeItem'> | null; reload?: () => void } = {}): void {
  if (forgotten) return
  forgotten = true
  stopPersisting()
  if (engine) engine.dropLocal()
  else useDB.setState({ db: loadSample(), past: [] })
  wipeAppStorage(o.storage, [LOGOUT_PENDING_KEY])
  const reload = o.reload ?? (() => typeof window !== 'undefined' && window.location.reload())
  reload()
}

/** Listens for another tab removing this browser's data or disconnecting it. Once per page. */
function wireTabs(): void {
  if (tabsWired || typeof window === 'undefined') return
  tabsWired = true
  try {
    window.addEventListener('storage', (e: StorageEvent) => {
      if (forgotten) return
      try {
        if (e.storageArea && typeof localStorage !== 'undefined' && e.storageArea !== localStorage) return
      } catch {
        return
      }
      const action = storageChangeAction(e)
      if (action === 'forget') forgetInThisTab()
      else if (action === 'disconnect') engine?.disconnectedElsewhere()
    })
  } catch {
    /* no window events (tests): nothing to listen to */
  }
  try {
    const Channel = (window as unknown as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel
    if (typeof Channel === 'function') {
      tabChannel = new Channel(TAB_CHANNEL)
      tabChannel.onmessage = (e: MessageEvent) => {
        if ((e.data as TabMessage | null)?.type === 'forget') forgetInThisTab()
      }
    }
  } catch {
    tabChannel = null
  }
}

/** The app's one engine, created on first use. */
export function getSyncEngine(): SyncEngine {
  if (engine) return engine
  const storage = defaultStorage()
  engine = createSyncEngine({
    store: useDB,
    api: getApi(),
    storage,
    prepareSnapshot: migrate,
    // db.ts applies effective-dated changes before the engine starts and saves them only with the next
    // edit: the difference from the saved copy is queued on start, so those changes reach the server.
    baseline: () => readSavedDB(storage),
    onLoad: applyLoadChanges,
    // 'Pretend today is' (Settings, Data): while it is on, the connection holds and nothing syncs.
    clockOverride: getClockOverride,
    // The engine saves the store itself (db.ts waits 400 ms) right before it records server progress.
    // Never while the store's saving is held (holdPersisting): the store then shows a workspace that must
    // not be saved, such as a simulated company.
    persistStore: () => {
      if (!storage || persistingHeld()) return false
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(useDB.getState().db))
        return true
      } catch {
        return false
      }
    },
    // The other tabs drop their copy too (they would save it again on their next edit).
    // The store stops saving first: the engine puts the sample in it next, and db.ts would otherwise write
    // that back (debounced, or on the way out), leaving a first-twenty: key behind.
    wipeLocal: () => {
      stopPersisting()
      announceForget()
      wipeAppStorage()
    },
    // What a browser that never opened the app shows, until the reload.
    freshDB: loadSample,
    // The toast saying what happened would go with this page: the next one shows it (Shell).
    reload: (notice) => {
      if (notice) leaveReloadNotice(notice)
      if (typeof window !== 'undefined') window.location.reload()
    },
  })
  return engine
}

/**
 * Starts syncing when this browser was connected to a server before. Safe to call in a local-only
 * install (including the one-file build opened from disk): it reads one localStorage key and returns.
 * Call it before the first edit, so changes made on load are told apart from the saved copy.
 */
export function initSync(): void {
  if (typeof window === 'undefined') return
  wireTabs()
  const storage = defaultStorage()
  // A sign-out the server never confirmed starts the engine too, even after Disconnect or removing this
  // browser's data: it ends that session before anything else (and never syncs from it).
  if (loadConnection(storage).mode !== 'server' && !readLogoutPending(storage)) return
  getSyncEngine().start()
}

export const connect = {
  checkServer: () => getSyncEngine().checkServer(),
  signIn: (email: string, password: string, opts?: LoginOptions) => getSyncEngine().signIn(email, password, opts),
  inspectServer: () => getSyncEngine().inspectServer(),
  uploadLocal: (opts?: UploadOptions) => getSyncEngine().uploadLocal(opts),
  useServerCopy: (opts?: { discardPending?: boolean }) => getSyncEngine().useServerCopy(opts),
  signUp: (input: SignupInput) => getSyncEngine().signUp(input),
  acceptInvite: (input: AcceptInviteInput) => getSyncEngine().acceptInvite(input),
  uploadNew: (db: DB) => getSyncEngine().uploadNew(db),
}

// ---------------------------------------------------------------------------------------------
// The signed-in login's company, and invites (a server that holds companies: docs/SERVER.md)
// ---------------------------------------------------------------------------------------------

let accountLoader: AccountLoader | null = null

function getAccountLoader(): AccountLoader {
  accountLoader ??= createAccountLoader(getApi(), useSyncStatus)
  return accountLoader
}

/**
 * Asks the server about the signed-in login's company again (after a sign-up or joining with an invite,
 * whose answers do not carry the careers page address).
 */
export function refreshServerAccount(): Promise<ServerAccount | null> {
  return getAccountLoader().load({ force: true })
}

/**
 * The signed-in login's company on the server: its name and slug, its careers page, the login's role.
 * ask: ask the server now if this sign-in has not been asked about yet (one GET /api/auth/me per sign-in
 * and page). null while nobody is signed in, before the answer, on a server that cannot say, or once the
 * sync status's user changed.
 */
export function useServerAccount(ask: boolean): ServerAccount | null {
  const loader = getAccountLoader()
  const account = useStore(loader.store, (s) => s.account)
  const userId = useSyncStatus((s) => s.user?.id ?? null)
  useEffect(() => {
    if (ask && userId) void loader.load()
  }, [ask, userId, loader])
  return account && account.userId === userId ? account : null
}

let demoAsked: Promise<DemoSignup | null> | null = null

/**
 * Whether anyone may create a demo company on the server at this page's origin (GET
 * /api/auth/signup-mode), asked once per page load; an answer that did not come is asked again next time.
 * null: no (a server that holds one company, or one from before demo sign-ups), or it could not say.
 * Only for a page where a server can live (Settings, Server and the sample banner check that first).
 */
export function demoSignup(): Promise<DemoSignup | null> {
  demoAsked ??= getApi()
    .signupMode()
    .then((r) => {
      if (!r.ok) {
        demoAsked = null
        return null
      }
      return demoSignupOf(r.data)
    })
  return demoAsked
}

/** A FlowFailure for an invite call, worded for its step. */
function inviteFailure(f: Pick<ApiFailure, 'kind' | 'status' | 'error' | 'retryAfter'>, step: 'look' | 'create'): FlowFailure {
  const out: FlowFailure = { ok: false, kind: f.kind, status: f.status, message: inviteFailureText(f, step) }
  if (f.retryAfter !== undefined) out.retryAfter = f.retryAfter
  return out
}

/**
 * The company an invite link joins (public: no sign-in needed). A token that cannot be one is answered
 * here, without asking the server (kind 'not_found').
 */
export async function inviteInfo(token: string): Promise<({ ok: true } & InviteInfo) | FlowFailure> {
  if (!isInviteToken(token)) return inviteFailure({ kind: 'not_found', status: null, error: null }, 'look')
  const r = await getApi().inviteInfo(token)
  return r.ok ? { ok: true, companyName: r.data.companyName } : inviteFailure(r, 'look')
}

/** A new single-use link that lets someone join the signed-in admin's company (it expires: see expiresAt). */
export async function createInvite(): Promise<({ ok: true } & InviteResponse) | FlowFailure> {
  const r = await getApi().createInvite()
  return r.ok ? { ok: true, ...r.data } : inviteFailure(r, 'create')
}

/** The signed-in admin's company's open invite links (no tokens: the server keeps only hashes). */
export async function listInvites(): Promise<{ ok: true; invites: OpenInvite[] } | FlowFailure> {
  const r = await getApi().listInvites()
  return r.ok ? { ok: true, invites: r.data } : inviteFailure(r, 'create')
}

/** Revokes an open invite link of the signed-in admin's company: it never works again. */
export async function revokeInvite(id: string): Promise<{ ok: true } | FlowFailure> {
  const r = await getApi().revokeInvite(id)
  if (r.ok) return { ok: true }
  if (r.kind === 'not_found') return { ok: false, kind: 'not_found', status: r.status, message: 'That link was used, revoked or expired already.' }
  return inviteFailure(r, 'create')
}

/**
 * Turns the signed-in admin's company's careers page on or off, then asks the server about the company
 * again, so every screen shows the new state.
 */
export async function setCareers(enabled: boolean): Promise<({ ok: true } & CareersSwitchResponse) | FlowFailure> {
  const r = await getApi().setCareers(enabled)
  if (!r.ok) {
    const message = r.kind === 'forbidden' ? 'Only an admin of this company can turn its careers page on or off.' : describeFailure(r)
    return { ok: false, kind: r.kind, status: r.status, message }
  }
  await getAccountLoader().load({ force: true })
  return { ok: true, ...r.data }
}

// ---------------------------------------------------------------------------------------------
// The assistant (docs/SERVER.md, "Lark, the assistant"): nothing here runs until the sheet asks
// ---------------------------------------------------------------------------------------------

let assistantApi: AssistantApi | null = null

function getAssistantApi(): AssistantApi {
  assistantApi ??= createAssistantApi()
  return assistantApi
}

/** GET /api/assistant: whether the server has the assistant on, its name, and the questions left today. */
export function assistantInfo() {
  return getAssistantApi().info()
}

/**
 * POST /api/assistant/chat: one question, answered as a stream (handlers get the pieces). Resolves with
 * the conversation the server ran ('done'), to be kept exactly as it came, or with why it did not finish.
 */
export function assistantChat(input: ChatInput, handlers?: ChatHandlers) {
  return getAssistantApi().chat(input, handlers)
}

/**
 * Which server workspace, and which history of it, this tab is connected to ('<workspaceId>/<historyId>'),
 * or null when it is not connected (or the sync engine has not started). Start fresh, Import and another
 * computer's replace give the workspace a new history, so an assistant conversation about the old records
 * can tell it no longer belongs here.
 */
export function assistantWorkspaceKey(): string | null {
  if (!engine) return null
  const c = engine.getConnection()
  return c.mode === 'server' && c.workspaceId ? `${c.workspaceId}/${c.historyId ?? ''}` : null
}

/**
 * Import a backup or Start fresh. Not connected: useDB.replace (one Undo step). Connected: replaces the
 * server's workspace for every device first (no Undo step); on failure nothing changes and the result
 * says why (offline, signed out...).
 */
export function replaceWorkspace(db: DB, label?: string) {
  return getSyncEngine().replaceWorkspace(db, { label })
}

export function disconnect(opts?: { discardPending?: boolean }) {
  return getSyncEngine().disconnect(opts)
}

/**
 * Ends the server session. A plain sign-out keeps the workspace in this browser as an offline copy.
 * With forgetThisBrowser it also removes the workspace, the sync state and preferences from this browser
 * and reloads the page (use it on shared computers); queued changes are sent first, and if some cannot
 * be, nothing is removed (kind 'pending') unless discardPending is set.
 */
export function signOut(opts?: SignOutOptions) {
  return getSyncEngine().signOut(opts)
}

/** Push and pull now (a "Sync now" button). */
export function syncNow(): Promise<void> {
  return getSyncEngine().syncNow()
}

/** The UI showed "N items were refreshed from the server"; reset the count. */
export function clearRefreshed(): void {
  getSyncEngine().clearRefreshed()
}

export function retryRejected(): void {
  getSyncEngine().retryRejected()
}

/**
 * Drops changes the server refused (or that are too large to sync), all or the ones named, and puts the
 * server's copy back in this browser. Resolves with what went wrong when the server's copy is needed and
 * cannot be fetched (nothing changes then).
 */
export function discardRejected(refs?: RecordRef[]): Promise<FlowResult> {
  return getSyncEngine().discardRejected(refs)
}

/**
 * The workspace this browser showed before another computer replaced the server's (useSyncStatus
 * replacedRemotely), or null. Kept in memory only, until clearReplacedRemotely() or the tab closes.
 */
export function getReplacedBackup(): DB | null {
  return engine ? engine.getReplacedBackup() : null
}

/** Dismisses the replaced-from-another-computer notice and forgets the copy it offered. */
export function clearReplacedRemotely(): void {
  engine?.clearReplacedRemotely()
}

/** Dismisses the notice that the server's copy was replaced by another copy of this workspace. */
export function clearRestoredRemotely(): void {
  engine?.clearRestoredRemotely()
}
