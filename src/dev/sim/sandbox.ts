// Open in the app, Back to my company and Keep (docs/DEV.md, "The simulator panel"): the real screens show a
// simulated company on its simulated date, and nothing of it is saved or synced unless the team member keeps it.
//
// The order is what makes it safe:
// - Open sets the clock to the simulated date first. While a pretend date is on, the sync engine starts no
//   cycle and queues no change (docs/SYNC.md, "Demo clock"), so from here nothing reaches the server. It then
//   waits for a cycle already in flight (syncNow returns it and starts no new one), so a pull that was landing
//   is in the store before the company is put aside. Then it holds the store's saving (holdPersisting: the
//   saved copy stays the real company, and the engine's own save refuses too) and swaps the simulated company
//   in, under an identity of its own and with no Undo back across the swap.
// - Back puts the real company back while the clock is still the simulated date, so the engine ignores that
//   change too, then the clock, then the saving. The store holds the very same objects as before (the
//   company, its Undo history), the outbox was never touched, and storage still holds the saved copy.
// - Keep goes back first, then replaces the company the way Import does: one Undo step when not connected,
//   or every device through the server (replaceWorkspace) when connected.
// A reload at any moment ends the sandbox: storage holds the real company and the clock is in memory only.
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { DB } from '@/domain/types'
import type { ISODate } from '@/lib/dates'
import type { HistoryEntry } from '@/store/db'
import { fmtSize, KEEP_LIMIT, withNewIdentity } from './helpers'

export type SandboxDeps = {
  store: { getState(): { db: DB; past: HistoryEntry[] }; setState(next: { db: DB; past: HistoryEntry[] }): void }
  getClock: () => ISODate | null
  setClock: (date: ISODate | null) => void
  /** The sync engine's syncNow: with the clock on, it only waits for a cycle already running. */
  syncNow: () => Promise<void>
  holdPersisting: () => () => void
  /** Why the sandbox cannot open now (a connect flow running, syncing on hold), or null. */
  blocked: () => string | null
  connected: () => boolean
  /** Connected: the server's workspace for every device (src/sync replaceWorkspace). */
  replaceWorkspace: (db: DB, label: string) => Promise<{ ok: true } | { ok: false; message: string }>
  /** Not connected: the store's replace (one Undo step). */
  replaceLocal: (db: DB, label: string) => void
  /** Downloads a backup of a workspace; false when the browser blocked it. */
  download: (db: DB) => boolean
  /** Settings > Data > Pretend today is (reloads the page). */
  pretendToday: (date: ISODate) => void
  newWorkspaceId: () => string
  /** Goes to a route (#home, #sim). */
  go: (hash: string) => void
}

export type SandboxView = { open: boolean; date: ISODate | null; companyName: string; originalName: string }

export type SandboxResult = { ok: true; message: string } | { ok: false; message: string }

export type Sandbox = {
  view: UseBoundStore<StoreApi<SandboxView>>
  open: (snapshot: { db: DB; date: ISODate; companyName: string }) => Promise<SandboxResult>
  back: () => void
  keep: (options: { downloadOriginal: boolean; pretend: boolean }) => Promise<SandboxResult>
  /** The simulated company was edited in the app since it opened. */
  edited: () => boolean
  isOpen: () => boolean
}

export const KEEP_LABEL = 'Kept the simulated company'

type Session = {
  original: { db: DB; past: HistoryEntry[] }
  prevClock: ISODate | null
  release: () => void
  simDb: DB
  date: ISODate
}

export function createSandbox(deps: SandboxDeps): Sandbox {
  const view = create<SandboxView>(() => ({ open: false, date: null, companyName: '', originalName: '' }))
  let session: Session | null = null
  let opening = false

  /** The real company back, then the clock, then the saving (in that order: see the top of the file). */
  function restore(s: Session): void {
    session = null
    deps.store.setState({ db: s.original.db, past: s.original.past })
    deps.setClock(s.prevClock)
    s.release()
    view.setState({ open: false, date: null, companyName: '', originalName: '' })
  }

  return {
    view,
    isOpen: () => session !== null,
    edited: () => !!session && deps.store.getState().db !== session.simDb,

    async open(snapshot) {
      if (session || opening) return { ok: false, message: 'The simulated company is already open in the app.' }
      const blocked = deps.blocked()
      if (blocked) return { ok: false, message: blocked }
      opening = true
      const prevClock = deps.getClock()
      deps.setClock(snapshot.date)
      try {
        await deps.syncNow()
      } catch {
        /* nothing more can start while the clock is on; whatever was running is done */
      } finally {
        opening = false
      }
      const { db, past } = deps.store.getState()
      const release = deps.holdPersisting()
      // An identity of its own: anything that ever looked past the clock would see a different company, never edits to this one.
      const simDb = { ...snapshot.db, meta: { ...snapshot.db.meta, workspaceId: `ws-sim-${snapshot.date}` } as DB['meta'] }
      session = { original: { db, past }, prevClock, release, simDb, date: snapshot.date }
      deps.store.setState({ db: simDb, past: [] })
      view.setState({ open: true, date: snapshot.date, companyName: snapshot.companyName, originalName: db.company.name })
      deps.go('#home')
      return { ok: true, message: `Showing ${snapshot.companyName} on its simulated date. Nothing is saved or synced.` }
    },

    back() {
      if (!session) return
      restore(session)
      deps.go('#sim')
    },

    async keep({ downloadOriginal, pretend }) {
      const s = session
      if (!s) return { ok: false, message: 'Open the simulated company in the app first.' }
      const db = deps.store.getState().db
      const size = JSON.stringify(db).length
      if (size > KEEP_LIMIT) return { ok: false, message: `Too big for this browser to keep (${fmtSize(size)}). Download it, or keep a shorter run.` }
      if (downloadOriginal && !deps.download(s.original.db)) {
        return { ok: false, message: `This browser blocked the download of ${s.original.db.company.name}, so nothing was replaced. Allow downloads, or keep it without the copy.` }
      }
      const name = db.company.name
      restore(s)
      const kept = withNewIdentity(db, deps.newWorkspaceId())
      if (deps.connected()) {
        const done = await deps.replaceWorkspace(kept, KEEP_LABEL)
        if (!done.ok) return { ok: false, message: `${done.message} Your company is as it was.` }
      } else {
        deps.replaceLocal(kept, KEEP_LABEL)
      }
      deps.go('#home')
      if (pretend) deps.pretendToday(s.date)
      return { ok: true, message: deps.connected() ? `Kept ${name} as your company, on your server for everyone who signs in.` : `Kept ${name} as your company. Undo (Ctrl+Z) puts the one before back.` }
    },
  }
}
