// Development only (docs/DEV.md). main.tsx imports this module behind `import.meta.env.DEV`, so production
// builds leave it out (src/dev/guard.test.ts checks that). With `npm run stack` running, it signs this
// browser in to the stack's dev login and takes the server's copy of the workspace (the seeded Ledgerlark
// company), through the app's normal connect flow: the same sign-in with the password, then "use the
// server's copy", as Settings, Server does. The server skips no check for it.
//
// The login comes from the Vite dev server (GET /__dev/credentials, scripts/dev/credentials.ts), which
// reads .data/dev/credentials.json. It runs:
// - always when the address ends in #dev.signin (on load, or typed into an open app);
// - on load, once per stack database (credentials.json's stackId, new after --fresh), when this browser
//   holds the sample company and is not connected to a server, or is still connected to an earlier stack
//   database that --fresh deleted. A workspace of your own is never replaced on load: the app says how to
//   sign in instead.
import { connect } from '@/sync'
import { isSampleDB } from '@/sync/engine'
import { defaultStorage, loadConnection, type StorageLike } from '@/sync/state'
import { getDB } from '@/store/db'
import { toast } from '@/ui/Toast'

export const SIGNIN_HASH = '#dev.signin'
export const CREDENTIALS_URL = '/__dev/credentials'
/**
 * The stack database this browser last signed in to (or was told about). Outside the app's
 * 'first-twenty:' keys, so "Sign out and remove data" leaves it and the app does not sign in again by itself.
 */
export const DONE_KEY = 'first-twenty-dev:stack'

type DevCredentials = { email: string; password: string; stackId: string }

/**
 * What to do on this load. connect: sign in and take the server's copy. replace: the same, dropping
 * changes queued for an earlier stack database (it no longer exists). offer: say how to sign in. skip: nothing.
 */
export type AutoconnectPlan = 'connect' | 'replace' | 'offer' | 'skip'

export function planAutoconnect(o: {
  /** The address ended in #dev.signin. */
  explicit: boolean
  /** This browser syncs with a server (any server, any login). */
  connected: boolean
  /** The browser's workspace is the sample company. */
  localIsSample: boolean
  /** DONE_KEY: the stack database this browser signed in to before, or null. */
  doneStackId: string | null
  stackId: string
}): AutoconnectPlan {
  if (o.explicit) return 'connect'
  if (o.doneStackId === o.stackId) return 'skip'
  if (!o.localIsSample) return 'offer'
  if (!o.connected) return 'connect'
  // Connected after an earlier automatic sign-in: that stack's database was deleted (--fresh).
  if (o.doneStackId !== null) return 'replace'
  // Connected some other way (Settings, Server): leave it.
  return 'skip'
}

async function fetchCredentials(): Promise<DevCredentials | null> {
  try {
    const res = await fetch(CREDENTIALS_URL, { headers: { 'X-First-Twenty': '1' }, cache: 'no-store' })
    if (!res.ok) return null
    const body = (await res.json()) as Partial<DevCredentials>
    return typeof body.email === 'string' && typeof body.password === 'string' && typeof body.stackId === 'string'
      ? { email: body.email, password: body.password, stackId: body.stackId }
      : null
  } catch {
    return null
  }
}

function read(storage: StorageLike | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function remember(storage: StorageLike | null, stackId: string): void {
  try {
    storage?.setItem(DONE_KEY, stackId)
  } catch {
    /* storage blocked: it asks again next load */
  }
}

/** Removes #dev.signin from the address without a history entry, so the app opens on its home page. */
function dropHash(): void {
  history.replaceState(null, '', `${location.pathname}${location.search}`)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

/** main.tsx calls this once: a check on load, then again whenever the address changes to #dev.signin. */
export function startAutoconnect(): void {
  void autoconnect()
  window.addEventListener('hashchange', () => {
    if (location.hash === SIGNIN_HASH) void autoconnect()
  })
}

let running = false

async function autoconnect(): Promise<void> {
  if (running) return
  running = true
  try {
    await run()
  } finally {
    running = false
  }
}

async function run(): Promise<void> {
  const explicit = location.hash === SIGNIN_HASH
  if (explicit) dropHash()
  const credentials = await fetchCredentials()
  if (!credentials) {
    if (explicit) toast({ text: 'No dev login here. Start the app with npm run stack, then open #dev.signin again.', tone: 'bad' })
    return
  }
  const storage = defaultStorage()
  const plan = planAutoconnect({
    explicit,
    connected: loadConnection(storage).mode === 'server',
    localIsSample: isSampleDB(getDB()),
    doneStackId: read(storage, DONE_KEY),
    stackId: credentials.stackId,
  })
  if (plan === 'skip') return
  if (plan === 'offer') {
    remember(storage, credentials.stackId)
    toast({
      text: `A dev login (${credentials.email}) is ready. Open #dev.signin to sign in with it: the server's copy replaces this browser's workspace.`,
      tone: 'neutral',
    })
    return
  }

  // Automatic attempts stay quiet when they fail (npm run dev without the stack has no API to answer).
  const failed = (message: string) => {
    if (explicit) toast({ text: `Dev sign-in failed: ${message}`, tone: 'bad' })
    else console.info(`[dev] Automatic sign-in skipped: ${message}`)
  }
  // Already signed in as the dev login (#dev.signin in a synced tab): a new sign-in would end the session
  // that requests in flight still carry, so it is skipped.
  const here = await connect.checkServer()
  if (!here.ok) return failed(here.message)
  if (!(here.signedIn && here.user?.email === credentials.email)) {
    const signedIn = await connect.signIn(credentials.email, credentials.password, { remember: true })
    if (!signedIn.ok) return failed(signedIn.message)
  }
  const server = await connect.inspectServer()
  if (!server.ok) return failed(server.message)
  if (server.empty) {
    remember(storage, credentials.stackId)
    toast({ text: `Signed in as ${credentials.email}. The dev server holds no company yet: upload one from Settings, Server.`, tone: 'neutral' })
    return
  }
  const taken = await connect.useServerCopy({ discardPending: plan === 'replace' })
  if (!taken.ok) return failed(taken.message)
  remember(storage, credentials.stackId)
  toast({ text: `Signed in to the dev server as ${credentials.email}, syncing ${server.companyName || 'its company'}.` })
}
