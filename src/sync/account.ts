// What the server says about the signed-in login's company (GET /api/auth/me on a server that holds
// companies): its name, its careers page address and the login's role. Kept in memory for this page only,
// asked once per sign-in, and forgotten the moment the sync status's user changes (a sign-out, another
// login), so a page never shows one company's careers link or invite button under another's login.
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { SyncApi } from './api'
import type { ServerWorkspace, SignupMode } from './protocol'
import type { SyncStatusState } from './status'

export type ServerAccount = {
  /** The login this describes: the sync status's user when the server was asked. */
  userId: string
  email: string
  role: string
  /** null on a server from before companies (one company, no name to show). */
  workspace: ServerWorkspace | null
  /** The company's careers page (http or https only), or null when the server serves none. */
  careersUrl: string | null
  /**
   * Whether that careers page is public (an admin turns it on and off). Servers that do not say have
   * every company's page on.
   */
  careersEnabled: boolean
  signupMode: SignupMode | null
}

export type AccountState = { account: ServerAccount | null }

/** Anything with the sync status's getState and subscribe (useSyncStatus, or a vanilla store in tests). */
export type StatusSource = {
  getState(): Pick<SyncStatusState, 'user'>
  subscribe(listener: (state: Pick<SyncStatusState, 'user'>, prev: Pick<SyncStatusState, 'user'>) => void): () => void
}

export type AccountLoader = {
  store: StoreApi<AccountState>
  /**
   * Asks the server about the signed-in login's company, once per sign-in (force: again). Resolves with
   * what it knows, or null when nobody is signed in or the server could not say (it is asked again next time).
   */
  load(opts?: { force?: boolean }): Promise<ServerAccount | null>
  /** Stops following the sync status (tests). */
  dispose(): void
}

export function createAccountLoader(api: Pick<SyncApi, 'me'>, status: StatusSource): AccountLoader {
  const store = createStore<AccountState>()(() => ({ account: null }))
  /** The user id this page asked about (or is asking about), so each sign-in asks once. */
  let askedFor: string | null = null
  let asking: Promise<ServerAccount | null> | null = null

  const unsubscribe = status.subscribe((s, prev) => {
    if (s.user?.id === prev.user?.id) return
    askedFor = null
    if (store.getState().account) store.setState({ account: null })
  })

  async function ask(userId: string): Promise<ServerAccount | null> {
    const r = await api.me()
    const now = status.getState().user
    // The login changed while the answer was on its way: it describes nobody shown now.
    if (!now || now.id !== userId) return null
    if (!r.ok || r.data.user.id !== userId) {
      askedFor = null
      return null
    }
    const account: ServerAccount = {
      userId,
      email: r.data.user.email,
      role: r.data.user.role,
      workspace: r.data.workspace ?? null,
      careersUrl: r.data.careersUrl ?? null,
      careersEnabled: r.data.careersEnabled ?? true,
      signupMode: r.data.signupMode ?? null,
    }
    store.setState({ account })
    return account
  }

  return {
    store,
    load: (opts = {}) => {
      const user = status.getState().user
      if (!user) return Promise.resolve(null)
      if (asking && askedFor === user.id) return asking
      if (!opts.force && askedFor === user.id) return Promise.resolve(store.getState().account)
      askedFor = user.id
      const p = ask(user.id).finally(() => {
        if (asking === p) asking = null
      })
      asking = p
      return p
    },
    dispose: unsubscribe,
  }
}
