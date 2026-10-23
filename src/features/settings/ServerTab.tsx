// Settings > Server (#settings.server): connect this browser to the company's own First Twenty server.
// Opened from a file or inside the claude.ai artifact viewer, or where no server answers, it explains
// what the server is and how to set it up (docs/SERVER.md), with no sign-in form and no network call.
// Where a server answers it walks through sign-in, then Upload or Use the server's copy, and once
// connected shows the live sync status (useSyncStatus) with Sync now, Sign out and Disconnect.
// On a demo server (anyone may sign up) Create a demo company sits next to Sign in
// (#settings.server.signup puts focus there), and a signed-in login sees its company on the server with
// invite links and its careers page.
import type { ReactNode } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { replaceRoute, useRoute } from '@/app/router'
import { fmtDateTime, fmtTime } from '@/lib/dates'
import { useDB } from '@/store/db'
import {
  clearRefreshed,
  connect,
  type DemoSignup,
  demoSignup,
  discardRejected,
  disconnect,
  type RecordRef,
  retryRejected,
  signOut,
  STORAGE_FULL_MESSAGE,
  type SyncMode,
  syncNow,
  type SyncUser,
  useServerAccount,
  useSyncStatus,
  waitingCount,
} from '@/sync'
import { Badge, Button, Callout, ConfirmButton, DescriptionList, Icon, Panel, toast } from '@/ui'
import { downloadBackup, StartFreshSheet } from './DataTab'
import { signInFootnote } from './demoLogic'
import { CompanyPanel, SignupPanel } from './demoParts'
import { focusPanelTitle, focusSignInField, focusSignupField } from './serverFocus'
import { ButtonLink, Row, RowList } from './kit'
import {
  agoText,
  checkFailureText,
  classifyCheckFailure,
  describeRecord,
  detectHostContext,
  plural,
  refreshedNames,
  refusedText,
  retryIn,
  serverAddress,
  signInSubtitle,
  statusView,
  tooLargeText,
} from './serverLogic'
import {
  BusyNote,
  busyText,
  ConnectPanel,
  connectedToast,
  FlowError,
  HoldPanel,
  SignInPanel,
  useBusy,
} from './serverParts'

/** What the last server check found, and the connection mode it ran in (a check made while connected is stale once the mode changes). */
type Check = ({ kind: 'checking' } | { kind: 'missing' } | { kind: 'unreachable'; message: string } | { kind: 'ready' }) & { mode?: SyncMode }

function pageOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin
}

/** What Sync now ended with, read out after the button is pressed. */
function syncResultText(s: ReturnType<typeof useSyncStatus.getState>): string {
  switch (s.status) {
    case 'synced':
      if (s.rejected > 0) return 'Synced, except some changes your server refused. See below.'
      return s.lastSyncAt ? `Synced at ${fmtTime(s.lastSyncAt)}.` : 'Synced.'
    case 'offline':
      return 'Sync did not finish: your server cannot be reached right now. Changes stay in this browser.'
    case 'signed_out':
      return 'Sync did not finish: sign in again first.'
    case 'syncing':
      return 'Still sending changes. They go out on their own.'
    case 'error':
      return `Sync did not finish. ${s.lastError ?? ''}`.trim()
    case 'local':
      return statusView(s).sentence
  }
}

/** Re-renders every 15 seconds, for "4 minutes ago" and "next try in 30 seconds". */
function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

export function ServerTab() {
  const route = useRoute()
  const wantsFresh = route.segments[2] === 'fresh'
  const wantsSignup = route.segments[2] === 'signup'
  const host = useMemo(detectHostContext, [])
  const mode = useSyncStatus((s) => s.mode)
  const hold = useSyncStatus((s) => s.hold)
  const status = useSyncStatus((s) => s.status)
  const statusUser = useSyncStatus((s) => s.user)
  const signedOutByUser = useSyncStatus((s) => s.signedOutByUser)
  const [rawCheck, setCheck] = useState<Check>(host === 'web' ? { kind: 'checking' } : { kind: 'missing' })
  const [session, setSession] = useState<SyncUser | null>(null)
  const [needsSignIn, setNeedsSignIn] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // Whether the server holds no workspace yet, from the check (signed in) or the connect step's look.
  const [serverEmpty, setServerEmpty] = useState<boolean | undefined>(undefined)
  // A demo server: anyone may create a company here (asked with the check, once per page load).
  const [demo, setDemo] = useState<DemoSignup | null>(null)
  // A sign-up made its login and is putting the new company on the server: Sign in steps aside.
  const [creating, setCreating] = useState(false)
  // The company whose copy this browser holds (named in the demo server's sign-in subtitle).
  const localCompany = useDB((s) => (typeof s.db.company?.name === 'string' ? s.db.company.name : ''))

  const runCheck = useCallback(
    async (focusAfter = false) => {
      // Never a network call where no server can live at this origin (a file, the artifact viewer).
      if (host !== 'web') return
      const ranIn = useSyncStatus.getState().mode
      setCheck({ kind: 'checking', mode: ranIn })
      // Asked side by side, so a demo server's sign-up shows with the sign-in form, not after it.
      const [res, demoHere] = await Promise.all([connect.checkServer(), demoSignup()])
      setDemo(res.ok ? demoHere : null)
      if (res.ok) {
        setCheck({ kind: 'ready', mode: ranIn })
        setSession(res.signedIn ? res.user : null)
        setNeedsSignIn(!res.signedIn)
        setServerEmpty(res.empty)
      } else {
        const online = typeof navigator === 'undefined' ? true : navigator.onLine
        setCheck(
          classifyCheckFailure(res.kind) === 'missing'
            ? { kind: 'missing', mode: ranIn }
            : { kind: 'unreachable', message: checkFailureText(res, online, pageOrigin()), mode: ranIn },
        )
      }
      if (focusAfter) focusPanelTitle(res.ok ? (res.signedIn ? 'server-connect' : 'server-signin') : 'server-unreachable')
    },
    [host],
  )

  useEffect(() => {
    void runCheck()
  }, [runCheck])

  // A check made while connected says nothing about now once the connection ends (Disconnect here or in
  // another tab): it shows as Checking and runs again. So does one made offline, once back online.
  const stale = host === 'web' && mode !== 'server' && rawCheck.kind !== 'checking' && rawCheck.mode !== undefined && rawCheck.mode !== mode
  const check: Check = stale ? { kind: 'checking' } : rawCheck
  useEffect(() => {
    if (stale) void runCheck()
  }, [stale, runCheck])
  useEffect(() => {
    if (host !== 'web' || typeof window === 'undefined') return
    const again = () => {
      if (useSyncStatus.getState().mode !== 'server') void runCheck()
    }
    window.addEventListener('online', again)
    return () => window.removeEventListener('online', again)
  }, [host, runCheck])

  // Arriving from somewhere else (the banner's Sign in, the header chip, Settings, Data) leaves focus on
  // that link, far from what needs doing. Once the tab knows its state, focus moves to the next step:
  // the sign-in form's next field, or the title of a paused connection or of refused changes. Arriving
  // by the settings tab strip keeps focus on the tab, as tabs do, and so does the Start fresh sheet.
  const rejected = useSyncStatus((s) => s.rejected)
  const arrival = useRef<{ pending: boolean } | null>(null)
  useLayoutEffect(() => {
    if (arrival.current) return
    arrival.current = { pending: !wantsFresh && !document.activeElement?.closest('.ft-tabs-wrap') }
  }, [wantsFresh])
  const settled = mode === 'server' || host !== 'web' || check.kind !== 'checking'
  const signInShown = mode === 'server' ? status === 'signed_out' || needsSignIn : check.kind === 'ready' && (!session || !statusUser)
  useEffect(() => {
    const a = arrival.current
    if (!a?.pending || !settled) return
    a.pending = false
    if (signInShown && wantsSignup && demo && mode !== 'server') focusSignupField()
    else if (signInShown) focusSignInField()
    else if (mode === 'server' && hold) focusPanelTitle('server-hold')
    else if (mode === 'server' && rejected > 0) focusPanelTitle('server-status')
  }, [settled, signInShown, mode, hold, rejected, wantsSignup, demo])

  // The signed-in login's company on the server (a server that holds companies), once per sign-in.
  const account = useServerAccount(host === 'web' && (mode === 'server' ? !signInShown : check.kind === 'ready' && !!session && !!statusUser))
  const companyPanel = account?.workspace ? <CompanyPanel account={account} /> : null

  const toSignIn = (text: string | null) => {
    setSession(null)
    setNeedsSignIn(true)
    setNotice(text)
    focusPanelTitle('server-signin')
  }

  const signedIn = (user: SyncUser) => {
    setSession(user)
    setNeedsSignIn(false)
    setNotice(null)
  }

  let content: ReactNode
  if (mode === 'server') {
    const showSignIn = signInShown
    const email = statusUser?.email ?? session?.email ?? null
    content = (
      <>
        {showSignIn && (
          <SignInPanel
            id="server-signin"
            title="Sign in to keep syncing"
            // A sign-out the user chose keeps saying so after edits and reloads (status signedOutByUser). On
            // a demo server it names the company whose login carries on with this browser's copy.
            subtitle={notice ?? signInSubtitle({ signedOutByUser, ...(demo ? { company: localCompany } : {}) })}
            // Demo logins come from a sign-up or an invite, not from whoever set the server up.
            footnote={signInFootnote(!!demo) ?? undefined}
            // After a deliberate sign-out the engine forgets the user; SignInPanel falls back to the remembered email.
            defaultEmail={email ?? undefined}
            onSignedIn={(user) => {
              signedIn(user)
              toast({ text: 'Signed in. Syncing again.' })
              focusPanelTitle('server-status')
            }}
          />
        )}
        {hold && (
          <HoldPanel
            hold={hold}
            onSignedOut={() => toSignIn('Your session on the server ended. Sign in, then choose again.')}
            onResumed={(text) => {
              toast({ text })
              focusPanelTitle('server-status')
            }}
          />
        )}
        <StatusPanel email={showSignIn ? null : email} />
        {!showSignIn && companyPanel}
        <AccountPanel
          signedOut={showSignIn}
          onSignedOut={(message) => {
            // The engine's message says whether the server confirmed the sign-out (LOGOUT_PENDING_MESSAGE when
            // not) and how many changes could not be sent first.
            toast({ text: message })
            toSignIn(null)
          }}
          onDisconnected={(message) => {
            toast({ text: message })
            toSignIn(null)
          }}
        />
      </>
    )
  } else if (host !== 'web') {
    content = <Explainer reason={host} />
  } else if (check.kind === 'checking') {
    content = (
      <Panel id="server-checking" title="Looking for your server" icon="globe">
        <p role="status" className="text-[14.5px] text-ink-2">
          Checking for a First Twenty server at {serverAddress(pageOrigin())}.
        </p>
      </Panel>
    )
  } else if (check.kind === 'missing') {
    content = <Explainer reason="missing" />
  } else if (check.kind === 'unreachable') {
    content = (
      <>
        <Panel id="server-unreachable" title="No working server here right now" icon="alert">
          <div className="flex flex-col gap-3">
            <div role="alert">
              <Callout tone="warn">{check.message}</Callout>
            </div>
            <div>
              <Button icon="rotate-ccw" onClick={() => void runCheck(true)}>
                Check again
              </Button>
            </div>
          </div>
        </Panel>
        <Explainer reason="unreachable" />
      </>
    )
  } else if (!session || !statusUser) {
    // statusUser drops to null the moment the engine ends the session (Disconnect, Sign out), before
    // this component hears back, so the connect step never flashes up (and never inspects) signed out.
    const signInPanel = (
      <SignInPanel
        id="server-signin"
        title="Sign in to your server"
        subtitle={
          notice ??
          (demo
            ? `A First Twenty demo server answers at ${serverAddress(pageOrigin())}. Sign in to the company you created or joined here.`
            : `A First Twenty server answers at ${serverAddress(pageOrigin())}. Sign in with its admin login to choose what syncs.`)
        }
        footnote={signInFootnote(!!demo) ?? undefined}
        onSignedIn={(user) => {
          signedIn(user)
          focusPanelTitle('server-connect')
        }}
      />
    )
    content = demo ? (
      <div className="grid items-start gap-5 xl:grid-cols-2">
        {!creating && signInPanel}
        <SignupPanel
          id="server-signup"
          demo={demo}
          onAccount={() => setCreating(true)}
          onCreated={(name, user) => {
            setCreating(false)
            signedIn(user)
            toast({ text: `Created ${name} on this demo server. Every change now syncs.` })
            if (wantsSignup) replaceRoute('settings', 'server')
            focusPanelTitle('server-status')
          }}
        />
      </div>
    ) : (
      signInPanel
    )
  } else {
    content = (
      <>
        <ConnectPanel
          email={session.email}
          onConnected={(how) => {
            connectedToast(how)
            focusPanelTitle('server-status')
          }}
          onSignedOut={() => toSignIn('Signed out. Sign in again to choose what syncs.')}
          onInspected={setServerEmpty}
        />
        {companyPanel}
      </>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {content}
      {wantsFresh && (
        <StartFreshSheet
          onClose={() => replaceRoute('settings', 'server')}
          // Not connected: what the check found, so the sheet can upload to an empty server or say what is next.
          server={mode !== 'server' && check.kind === 'ready' ? { signedIn: !!session && !!statusUser, empty: serverEmpty } : null}
          onDone={() => {
            if (useSyncStatus.getState().mode === 'server') focusPanelTitle('server-status')
            else if (session && useSyncStatus.getState().user) focusPanelTitle('server-connect')
            else focusSignInField()
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Connected: status and account
// ---------------------------------------------------------------------------------------------

function StatusPanel({ email }: { email: string | null }) {
  const s = useSyncStatus()
  const now = useNow()
  const view = statusView(s)
  const db = useDB((d) => d.db)
  const refreshedList = refreshedNames(db, s.refreshed, s.refreshedKeys, s.refreshedKeys.length)
  const tooLarge = s.rejectedKeys.filter((r) => r.tooLarge)
  const refused = s.rejected - tooLarge.length
  const { busy, run } = useBusy()
  // What the last Sync now (or Retry) ended with, and the state it described. Once the state moves on
  // (back online, signed in again, refusals cleared) the line would contradict the badge, so it goes.
  const [result, setResult] = useState<{ text: string; state: string } | null>(null)
  const stateKey = (x: { status: string; rejected: number }) => `${x.status}:${x.rejected > 0}`
  const current = stateKey(s)
  useEffect(() => {
    if (!busy && result && result.state !== current) setResult(null)
  }, [busy, result, current])
  const syncBtn = useRef<HTMLButtonElement>(null)
  const retry = retryIn(s.nextRetryAt, now)
  const ago = agoText(s.lastSyncAt, now)

  /** Sync now, then say how it went. `first` runs before the sync (Retry puts refused changes back). */
  const doSync = async (first?: () => void) => {
    if (busy) return
    setResult(null)
    await run('sync', async () => {
      first?.()
      await syncNow()
    })
    const after = useSyncStatus.getState()
    setResult({ text: syncResultText(after), state: stateKey(after) })
  }

  /** Drops a change too large to sync and puts the server's copy back; says how it went. */
  const discard = async (ref: RecordRef) => {
    const res = await run('discard', () => discardRejected([ref]))
    if (!res) return
    if (res.ok) {
      toast({ text: 'Change discarded. This browser shows what your server has.' })
      afterRemoved()
    } else toast({ text: res.message, tone: 'bad' })
  }

  /** The button that removed itself is gone: land on Sync now (or the panel title while paused). */
  const afterRemoved = () => {
    setTimeout(() => {
      if (syncBtn.current?.isConnected) syncBtn.current.focus()
      else focusPanelTitle('server-status')
    }, 0)
  }

  return (
    <Panel
      id="server-status"
      title="Sync status"
      icon="globe"
      actions={
        !s.hold && (
          <Button ref={syncBtn} icon="rotate-ccw" onClick={() => void doSync()} aria-disabled={busy ? true : undefined}>
            {busy ? 'Syncing' : 'Sync now'}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Badge tone={view.tone} icon={view.icon} className="text-[13.5px]">
            {view.word}
          </Badge>
          <span className="min-w-0 text-[14.5px] text-ink">{view.sentence}</span>
        </div>
        <p role="status" className={result || busy ? 'text-[13.5px] text-ink-2' : 'sr-only'}>
          {busy ? busyText(busy) : (result?.text ?? '')}
        </p>
        <DescriptionList
          items={[
            { label: 'Server', value: serverAddress(pageOrigin()) },
            { label: 'Signed in as', value: email ?? 'Not signed in' },
            {
              label: 'Last synced',
              value: s.lastSyncAt ? `${fmtDateTime(s.lastSyncAt)}${ago ? ` (${ago})` : ''}` : 'Not yet',
            },
            {
              label: 'Changes waiting in this browser',
              value:
                waitingCount(s) === 0
                  ? 'None'
                  : [s.pendingEdits > 0 && plural(s.pendingEdits, 'change to send', 'changes to send'), s.rejected > 0 && `${s.rejected} refused`]
                      .filter(Boolean)
                      .join(', '),
            },
            { label: 'Next try', value: retry ? `Automatically ${retry}` : '', hidden: !retry },
          ]}
        />
        {/* Callout buttons sit under the text, never beside it, so a phone keeps full-width lines. */}
        {s.storageFull && (
          <Callout tone="bad" title="This browser is not saving">
            <p>{STORAGE_FULL_MESSAGE}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" icon="download" onClick={() => downloadBackup()}>
                Download backup
              </Button>
            </div>
          </Callout>
        )}
        {s.lastError && !s.storageFull && s.status === 'error' && (
          <Callout tone="bad" title="Your server reported a problem">
            {s.lastError}
            {retry ? ` Next try ${retry}, or press Sync now.` : ''}
          </Callout>
        )}
        {s.refreshed > 0 && (
          <Callout tone="accent" icon="rotate-ccw" title={`${plural(s.refreshed, 'item was', 'items were')} replaced by your server's copy`}>
            <p>
              Your server's copy of {s.refreshed === 1 ? 'it' : 'each'} was different (changed on another computer, or restored from an
              earlier copy), and the server's version wins. This browser now shows what your server has, so check{' '}
              {s.refreshed === 1 ? 'it' : 'them'} if something you typed is missing.
            </p>
            {refreshedList.names.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1" aria-label="Replaced by your server's copy">
                {refreshedList.names.map((n, i) => (
                  <li key={`${i}-${n.label}`}>
                    {/* One per line, so each link gets the full 40px hit area. */}
                    {n.href ? (
                      <a href={n.href} className="inline-flex min-h-10 items-center font-semibold text-accent underline">
                        {n.label}
                      </a>
                    ) : (
                      n.label
                    )}
                    {n.removed && ' (removed on another computer, so your edit was dropped)'}
                  </li>
                ))}
                {refreshedList.more > 0 && <li>{plural(refreshedList.more, 'more item', 'more items')}</li>}
              </ul>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => {
                  clearRefreshed()
                  afterRemoved()
                }}
              >
                Dismiss
              </Button>
            </div>
          </Callout>
        )}
        {tooLarge.length > 0 && (
          <Callout tone="bad" title={tooLarge.length === 1 ? 'A change is too large to sync' : `${tooLarge.length} changes are too large to sync`}>
            <p>Your server takes records up to 256 KB. Retrying cannot help; discarding puts back what your server has.</p>
            <ul className="mt-2 flex flex-col gap-3" aria-label="Too large to sync">
              {tooLarge.map((r) => {
                const label = describeRecord(db, r.collection, r.id)
                return (
                  <li key={`${r.collection}:${r.id}`} className="flex flex-col gap-2">
                    <span>{tooLargeText(label, r.collection)}</span>
                    <span className="flex flex-wrap gap-2">
                      {label.href && (
                        <ButtonLink href={label.href} variant="ghost">
                          Open it
                        </ButtonLink>
                      )}
                      <ConfirmButton
                        size="sm"
                        icon="trash"
                        confirmLabel="Press again to discard it"
                        onConfirm={() => !busy && void discard(r)}
                        aria-disabled={busy ? true : undefined}
                      >
                        Discard this change
                      </ConfirmButton>
                    </span>
                  </li>
                )
              })}
            </ul>
          </Callout>
        )}
        {refused > 0 && (
          // Counts are saved records, and one edit can save two (the record and its activity log entry),
          // so the title says "some changes" and the number is explained where it appears.
          <Callout tone="bad" title="Your server refused some changes">
            <p>
              {refusedText(refused)} One edit can save more than one record, such as the record and its activity log entry. Retry sends{' '}
              {refused === 1 ? 'it' : 'them'} again. If your server keeps refusing, download a backup; the server's log says why it refused.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm"
                icon="rotate-ccw"
                onClick={() =>
                  void doSync(() => {
                    retryRejected()
                    afterRemoved()
                  })
                }
                aria-disabled={busy ? true : undefined}
              >
                Retry
              </Button>
              <Button size="sm" variant="ghost" icon="download" onClick={() => downloadBackup()}>
                Download backup
              </Button>
            </div>
          </Callout>
        )}
      </div>
    </Panel>
  )
}

function AccountPanel({
  signedOut,
  onSignedOut,
  onDisconnected,
}: {
  signedOut: boolean
  onSignedOut: (message: string) => void
  onDisconnected: (message: string) => void
}) {
  const waiting = useSyncStatus(waitingCount)
  // Signed out, Sync now cannot send anything: the way to keep waiting changes is to sign in first.
  const cannotSend = useSyncStatus((s) => s.status === 'signed_out' || s.logoutPending)
  const { busy, run } = useBusy()
  const [error, setError] = useState<{ message: string; n: number } | null>(null)
  const [forgetBlocked, setForgetBlocked] = useState<{ message: string; n: number } | null>(null)
  // The server could not end the session, so nothing was removed (kind 'session_open').
  const [sessionOpen, setSessionOpen] = useState<{ message: string; n: number; discardPending: boolean } | null>(null)
  const [disconnectBlocked, setDisconnectBlocked] = useState<{ message: string; n: number } | null>(null)
  const guard = busy ? { 'aria-disabled': true as const } : {}

  const doSignOut = async () => {
    const res = await run('signout', () => signOut())
    if (!res) return
    if (res.ok) onSignedOut(res.message)
    else setError({ message: res.message, n: Date.now() })
  }
  const doForget = async (discardPending: boolean, keepServerSession = false) => {
    setDisconnectBlocked(null)
    setSessionOpen(null)
    setError(null)
    const res = await run('forget', () => signOut({ forgetThisBrowser: true, discardPending, keepServerSession }))
    if (!res || res.ok) return // the page reloads once this browser's data is gone
    if (res.kind === 'pending') setForgetBlocked({ message: res.message, n: Date.now() })
    else if (res.kind === 'session_open') {
      setForgetBlocked(null)
      setSessionOpen({ message: res.message, n: Date.now(), discardPending })
    } else setError({ message: res.message, n: Date.now() })
  }
  const doDisconnect = async (discardPending: boolean) => {
    setForgetBlocked(null)
    setSessionOpen(null)
    setError(null)
    const res = await run('disconnect', () => disconnect({ discardPending }))
    if (!res) return
    if (res.ok) onDisconnected(res.message)
    else if (res.kind === 'pending') setDisconnectBlocked({ message: res.message, n: Date.now() })
    else setError({ message: res.message, n: Date.now() })
  }

  return (
    <Panel id="server-account" title="Sign out or disconnect" icon="log-out">
      <div className="flex flex-col gap-3">
        <RowList label="Sign out or disconnect">
          {!signedOut && (
            <Row
              title="Sign out"
              meta="Sends waiting changes first, then ends your session on the server. This browser keeps an offline copy you can keep working in; changes you make wait here and sync when you sign in again."
              actions={
                <Button icon="log-out" onClick={() => !busy && void doSignOut()} {...guard}>
                  Sign out
                </Button>
              }
            />
          )}
          <Row
            title="Sign out and remove data from this browser"
            meta={
              <>
                For shared computers. Sends waiting changes first, then removes the workspace, the sync state and display preferences from
                this browser and reloads the page. Your server keeps everything that reached it.
                {waiting > 0 && (
                  <span className="mt-1 flex items-start gap-1.5 font-semibold text-warn">
                    <Icon name="alert" size={15} className="mt-0.5 shrink-0" />
                    {plural(waiting, 'change has', 'changes have')} not reached the server yet.
                  </span>
                )}
              </>
            }
            actions={
              <ConfirmButton icon="trash" confirmLabel="Press again to remove this browser's data" onConfirm={() => !busy && void doForget(false)} {...guard}>
                Sign out and remove data
              </ConfirmButton>
            }
          />
          <Row
            title="Disconnect"
            meta="Stop syncing and go back to local only. This also signs you out. The workspace stays in this browser and your server keeps its copy. You can connect again any time."
            actions={
              <Button icon="x" onClick={() => !busy && void doDisconnect(false)} {...guard}>
                Disconnect
              </Button>
            }
          />
        </RowList>
        {forgetBlocked && waiting > 0 && (
          <div role="alert" key={forgetBlocked.n}>
            <Callout tone="bad" title="Nothing was removed">
              <p>{forgetBlocked.message}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {cannotSend ? (
                  <Button icon="key" onClick={() => focusSignInField()}>
                    Sign in
                  </Button>
                ) : (
                  <Button icon="rotate-ccw" onClick={() => !busy && void syncNow()} {...guard}>
                    Sync now
                  </Button>
                )}
                <ConfirmButton icon="trash" confirmLabel="Press again to lose them" onConfirm={() => !busy && void doForget(true)} {...guard}>
                  Remove anyway and lose {waiting === 1 ? 'it' : 'them'}
                </ConfirmButton>
              </div>
            </Callout>
          </div>
        )}
        {sessionOpen && (
          <div role="alert" key={sessionOpen.n}>
            <Callout tone="bad" title="Nothing was removed">
              <p>{sessionOpen.message}</p>
              <p className="mt-1">
                Removing anyway clears this browser now, but its session on your server stays valid until this browser reaches the server
                again, or until the session goes 12 hours unused.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <ConfirmButton
                  icon="trash"
                  confirmLabel="Press again to remove this browser's data"
                  onConfirm={() => !busy && void doForget(sessionOpen.discardPending, true)}
                  {...guard}
                >
                  Remove anyway
                </ConfirmButton>
              </div>
            </Callout>
          </div>
        )}
        {disconnectBlocked && waiting > 0 && (
          <div role="alert" key={disconnectBlocked.n}>
            <Callout tone="warn" title="Still connected">
              <p>{disconnectBlocked.message}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button icon="rotate-ccw" onClick={() => !busy && void syncNow()} {...guard}>
                  Sync now
                </Button>
                <ConfirmButton icon="x" confirmLabel="Press again to disconnect" onConfirm={() => !busy && void doDisconnect(true)} {...guard}>
                  Disconnect anyway
                </ConfirmButton>
              </div>
            </Callout>
          </div>
        )}
        <FlowError error={error} title="That did not work" />
        <BusyNote text={busyText(busy)} />
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------
// No server here: what the server is and how to set it up (docs/SERVER.md in short)
// ---------------------------------------------------------------------------------------------

const SETUP_STEPS: Array<{ title: string; body: ReactNode }> = [
  {
    title: 'Get an EC2 instance with Postgres',
    body: (
      <>
        Postgres 13 or newer on Amazon Linux 2023 or Ubuntu, an Elastic IP, and a domain such as hr.example.com pointed at it. Open ports 443
        and 80 to everyone, 22 to your own address only, and never 5432.
      </>
    ),
  },
  {
    title: 'Create the database roles',
    body: (
      <>
        Run <Code>server/deploy/postgres-setup.sql</Code> as the Postgres superuser. It makes the first_twenty database and two logins
        that can only use it.
      </>
    ),
  },
  {
    title: 'Copy the code and run the setup script',
    body: (
      <>
        Clone or copy First Twenty to the instance, then from its folder run{' '}
        <Code>sudo bash server/deploy/setup-ec2.sh --domain hr.example.com</Code>. It installs Node.js, Caddy for HTTPS, the service and
        nightly backups, and leaves the code in /opt/first-twenty.
      </>
    ),
  },
  {
    title: 'Fill in the settings file',
    body: (
      <>
        Put the two database passwords in <Code>/etc/first-twenty/env</Code>. Only root can read it.
      </>
    ),
  },
  {
    title: 'Build and create your admin login',
    body: (
      <>
        In /opt/first-twenty, run these one at a time, with your own email in the last one: <CommandList
          commands={[
            'npm ci',
            'npm run build:all',
            'bash server/deploy/with-env.sh npm run server:migrate',
            'bash server/deploy/with-env.sh npm run server:create-admin -- --email you@company.com',
          ]}
        />
        The last one asks for the admin password twice. That one login protects the data.
      </>
    ),
  },
  {
    title: 'Start the server and bring your data',
    body: (
      <>
        Restart the first-twenty service and open https://your-domain. Download a backup here, import it there in Settings, Data, then sign
        in under Settings, Server and choose Upload this browser's workspace.
      </>
    ),
  },
]

function Code({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[12.5px] break-words text-ink">{children}</code>
}

/** Commands to type, one per line, exactly as the server guide gives them (copy-paste works). */
function CommandList({ commands }: { commands: string[] }) {
  return (
    <ul className="my-1.5 flex flex-col gap-1" aria-label="Commands">
      {commands.map((c) => (
        <li key={c} className="rounded bg-surface-2 px-2 py-1">
          <Code>{c}</Code>
        </li>
      ))}
    </ul>
  )
}

function Explainer({ reason }: { reason: 'file' | 'artifact' | 'missing' | 'unreachable' }) {
  // A server that is only down right now needs no new setup: the steps stay behind a button there.
  const [showSetup, setShowSetup] = useState(reason !== 'unreachable')
  const where: Record<typeof reason, string | null> = {
    file: 'This copy was opened from a file on this computer, so it has no server to sync with.',
    artifact: 'This copy runs inside the claude.ai artifact viewer, so it has no server to sync with.',
    missing: `No First Twenty server answers at ${serverAddress(pageOrigin())}.`,
    unreachable: null,
  }
  const lead = where[reason]
  return (
    <>
      <Panel
        id="server-about"
        title="Sync with your own server"
        icon="globe"
        subtitle="Optional. First Twenty works fully in this browser without one."
      >
        <div className="flex flex-col gap-4">
          {lead && (
            <Callout tone="neutral" title={lead}>
              Syncing works when the app is opened from your First Twenty server's address, such as <strong>https://your-domain</strong>. Open
              that address, sign in under Settings, Server, and every change syncs from then on.
            </Callout>
          )}
          <p className="max-w-[75ch] text-[14.5px] text-ink">
            The First Twenty server is a small program that runs next to your Postgres database on an Amazon EC2 instance and serves this same
            app at your own address. With it, every change goes into your database, any computer you sign in from sees the same data, and the
            database is backed up every night. Offline keeps working: the browser keeps its own copy, holds changes and catches up when the
            connection returns. One admin login protects the data.
          </p>
          {reason === 'unreachable' && (
            <div>
              <Button
                variant="ghost"
                icon={showSetup ? 'chevron-up' : 'chevron-down'}
                aria-expanded={showSetup}
                aria-controls={showSetup ? 'server-setup' : undefined}
                onClick={() => setShowSetup((v) => !v)}
              >
                {showSetup ? 'Hide the setup steps' : 'Set up a server'}
              </Button>
            </div>
          )}
        </div>
      </Panel>
      {showSetup && (
        <Panel
          id="server-setup"
          title="Set up your server"
          icon="settings"
          subtitle="About an hour the first time. The full guide, with every command, is docs/SERVER.md in the First Twenty code."
        >
          <div className="flex flex-col gap-4">
            <ol className="flex flex-col gap-3.5" aria-label="Setup steps">
              {SETUP_STEPS.map((step, i) => (
                <li key={step.title} className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className="ft-checkmark ft-checkmark--open num inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[13px] font-bold text-ink-2"
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[14.5px] font-bold text-ink">
                      <span className="sr-only">Step {i + 1}: </span>
                      {step.title}
                    </p>
                    <div className="max-w-[75ch] text-[13.5px] text-ink-2">{step.body}</div>
                  </div>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-4">
              <Button icon="download" onClick={() => downloadBackup()}>
                Download a backup to bring along
              </Button>
              <span className="text-[13px] text-ink-3">
                Opened from your server's address, the app starts with the sample company, so bring this backup and import it there.
              </span>
            </div>
          </div>
        </Panel>
      )}
    </>
  )
}
