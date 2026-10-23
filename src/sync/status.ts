// What the sync engine tells the UI (docs/SYNC.md, "Status"). The engine writes it; the header chip and
// Settings > Data > Server read it. The engine never renders UI.
import { create } from 'zustand'
import type { SyncUser } from './protocol'
import type { HoldReason, SyncMode } from './state'

/**
 * - local: this browser is not connected (or a connection is on hold: see `hold`).
 * - synced: connected, nothing waiting.
 * - syncing: changes are waiting or being sent, or the first catch-up after start is running.
 * - offline: the server cannot be reached; changes queue and retry with backoff.
 * - signed_out: the session ended; changes queue until the user signs in again.
 * - error: the server answered with an error; retrying with backoff (see lastError). Also used while this
 *   browser refuses to save changes that have not reached the server (storageFull): they would be lost
 *   when the tab closes.
 */
export type SyncStatus = 'local' | 'synced' | 'syncing' | 'offline' | 'signed_out' | 'error'

/**
 * Another computer replaced the server's whole workspace (Start fresh, Import, or uploading its own copy)
 * and this browser switched to it. The workspace that was here stays in memory until the notice is
 * dismissed or the tab closes, so the user can download it (getReplacedBackup in index.ts).
 */
export type ReplacedRemotely = {
  /** The company this browser shows now (the server's). */
  companyName: string
  /** The company this browser showed before. */
  previousName: string
  /** When the swap happened (ISO timestamp). */
  at: string
}

/**
 * Another computer replaced the server's workspace with another copy of this same workspace (Import of
 * a backup, or a copy uploaded after the server was reset), or the server was restored, and this browser
 * rebased on it. Changes made after that copy may be gone, on every computer.
 */
export type RestoredRemotely = {
  /** When this browser noticed (ISO timestamp). */
  at: string
}

/** One record, as the protocol names it: a collection (or '$doc') and an id (or the document key). */
export type RecordRef = { collection: string; id: string }

/**
 * A record whose local copy the server's replaced. removed: the server no longer has it, so this
 * browser's edit was dropped and its copy removed too; `copy` is what this browser had (memory only), so
 * a notice can still name it ("the Finance and operations department").
 */
export type RefreshedRef = RecordRef & { removed?: true; copy?: unknown }

/** A change the server refused (or this browser set aside as too large to send), kept in this browser. */
export type RejectedRef = RecordRef & {
  /** Too large to sync (over 256 KB): retrying cannot help; shorten it or discard the change. */
  tooLarge: boolean
}

/** Most refreshed records the status remembers by name (the newest ones). */
export const MAX_REFRESHED_KEYS = 20

export type SyncStatusState = {
  status: SyncStatus
  mode: SyncMode
  /** Changes waiting in the outbox (every record, including activity log rows). Internal: never shown. */
  pending: number
  /**
   * The same, as a person counts their edits: activity log rows are left out when the record they are
   * about waits too (each edit also writes one), and counted when nothing else of theirs waits (a note).
   * Use this for every count shown (see waitingCount for "not reached the server").
   */
  pendingEdits: number
  /** Changes the server refused on their own; kept in this browser (see engine.retryRejected). */
  rejected: number
  /** Which changes were refused, and whether each is too large to sync. */
  rejectedKeys: RejectedRef[]
  lastSyncAt: string | null
  /** Plain-language text for the last failure, or null. */
  lastError: string | null
  /** When the next automatic retry runs (epoch ms), or null. */
  nextRetryAt: number | null
  user: SyncUser | null
  hold: HoldReason | null
  /** Items replaced by the server's copy (server wins) since the UI last cleared the count. */
  refreshed: number
  /** Which ones, newest last (at most MAX_REFRESHED_KEYS), so the UI can name them (removed ones too). */
  refreshedKeys: RefreshedRef[]
  /**
   * This browser refused to save the sync state or the workspace (storage full or blocked). Changes that
   * have not reached the server live only in this tab until it can save again; the engine also asks the
   * browser to warn before the tab closes while any are waiting.
   */
  storageFull: boolean
  /**
   * This browser signed out (or disconnected, or removed its data), but the server has not confirmed that
   * the session ended (it could not be reached). The engine never resumes from that session and ends it
   * as soon as the server answers; until then the session stays open on the server.
   */
  logoutPending: boolean
  /** The user signed out on purpose (not a session that ended on its own). Cleared by signing in. */
  signedOutByUser: boolean
  /** Set when another computer replaced the server's workspace and this browser switched to it. */
  replacedRemotely: ReplacedRemotely | null
  /** Set when the server's copy of this workspace was replaced by another copy of it and this browser rebased on it. */
  restoredRemotely: RestoredRemotely | null
}

export const INITIAL_SYNC_STATUS: SyncStatusState = {
  status: 'local',
  mode: 'local',
  pending: 0,
  pendingEdits: 0,
  rejected: 0,
  rejectedKeys: [],
  lastSyncAt: null,
  lastError: null,
  nextRetryAt: null,
  user: null,
  hold: null,
  refreshed: 0,
  refreshedKeys: [],
  storageFull: false,
  logoutPending: false,
  signedOutByUser: false,
  replacedRemotely: null,
  restoredRemotely: null,
}

/** Changes that have not reached the server, as shown to people: the ones waiting plus the ones refused. */
export function waitingCount(s: Pick<SyncStatusState, 'pendingEdits' | 'rejected'>): number {
  return s.pendingEdits + s.rejected
}

/** Anything with zustand's getState/setState (the hook below, or a vanilla store in tests). */
export type StatusStoreLike = {
  getState(): SyncStatusState
  setState(partial: Partial<SyncStatusState>): void
}

/** `const status = useSyncStatus((s) => s.status)` */
export const useSyncStatus = create<SyncStatusState>()(() => ({ ...INITIAL_SYNC_STATUS }))
