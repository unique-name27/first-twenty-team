// Settings > Server, the connect steps: the sign-in form, the choice between this browser's workspace
// and the server's (inspect, upload, use the server's copy), the screens for a paused connection
// (holds) and the small helpers they share. Every server call goes through '@/sync'.
import type { ReactNode } from 'react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { href } from '@/app/router'
import { fmtDay } from '@/lib/dates'
import { useDB } from '@/store/db'
import { usePrefs } from '@/store/prefs'
import { connect, type FlowResult, type HoldReason, type InspectResult, SAMPLE_MESSAGE, signOut, type SyncUser, useSyncStatus } from '@/sync'
import { Badge, Button, Callout, Checkbox, ConfirmButton, DescriptionList, Field, focusFirstInvalid, IconButton, Panel, TextInput, toast } from '@/ui'
import { downloadBackup, setDemoClock } from './DataTab'
import { revealElement } from './serverFocus'
import { ButtonLink, Row, RowList } from './kit'
import {
  compareWorkspaces,
  describeCounts,
  describeDetail,
  joinAnd,
  missingRecords,
  moreWorkIn,
  plural,
  recommendedCopy,
  summarize,
  type WorkspaceSummary,
} from './serverLogic'

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

/** One server action at a time per screen. Buttons stay focusable while it runs (aria-disabled). */
export function useBusy() {
  const ref = useRef<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const run = useCallback(async <T,>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    if (ref.current) return undefined
    ref.current = name
    setBusy(name)
    try {
      return await fn()
    } finally {
      ref.current = null
      setBusy(null)
    }
  }, [])
  return { busy, run }
}

// The email of the last admin login used in this browser, so signing in again only needs the password.
// It starts with "first-twenty:", so Sign out and remove data clears it with everything else.
const EMAIL_KEY = 'first-twenty:server-email:v1'

export function rememberedEmail(): string {
  try {
    return typeof localStorage === 'undefined' ? '' : (localStorage.getItem(EMAIL_KEY) ?? '')
  } catch {
    return ''
  }
}

export function rememberEmail(email: string): void {
  try {
    if (typeof localStorage !== 'undefined' && email) localStorage.setItem(EMAIL_KEY, email)
  } catch {
    /* storage blocked: the field just starts empty next time */
  }
}

/**
 * An error from a server step, announced as soon as it appears (role="alert") and scrolled into view,
 * so a person who pressed Enter in a field far above it sees it too. `n` changes per attempt, so a repeat
 * is announced and shown too. Focus stays where it was: the field to fix.
 */
export function FlowError({ error, title }: { error: { message: string; n: number } | null; title: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const n = error?.n
  useEffect(() => {
    if (n !== undefined) revealElement(ref.current)
  }, [n])
  return (
    <div ref={ref} role="alert" key={error?.n ?? 0} className={error ? undefined : 'sr-only'}>
      {error && (
        <Callout tone="bad" title={title}>
          {error.message}
        </Callout>
      )}
    </div>
  )
}

/** Status text for a running step ("Signing in"), read out politely. Always rendered so it is announced. */
export function BusyNote({ text }: { text: string | null }) {
  return (
    <p role="status" className={text ? 'text-[13.5px] text-ink-2' : 'sr-only'}>
      {text ?? ''}
    </p>
  )
}

const busyProps = (busy: string | null) => (busy ? { 'aria-disabled': true as const } : {})

/** Text for a step that is running, per action name. */
const BUSY_TEXT: Record<string, string> = {
  signin: 'Signing in. Checking the password can take a few seconds.',
  inspect: 'Looking at what your server holds.',
  upload: 'Uploading this browser\'s workspace to your server.',
  servercopy: 'Downloading the server\'s workspace into this browser.',
  replace: 'Replacing the server\'s workspace with this browser\'s.',
  signout: 'Signing out.',
  forget: 'Sending waiting changes, then removing this browser\'s data.',
  disconnect: 'Disconnecting.',
  sync: 'Syncing now.',
  discard: 'Discarding the change and putting back what your server has.',
  signup: 'Creating your login and company. Checking the password can take a few seconds.',
  newcompany: 'Saving the new company on the server.',
  join: 'Joining. Checking the password can take a few seconds.',
  invite: 'Creating an invite link.',
}
export function busyText(busy: string | null): string | null {
  return busy ? (BUSY_TEXT[busy] ?? 'Working.') : null
}

// ---------------------------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------------------------

// The server ends a plain session after 12 hours at most; the browser usually drops its cookie on close,
// but "continue where you left off" can restore it, so the hint promises only the server's cap. The
// offline copy stays either way: only Sign out and remove data clears a shared computer.
export const REMEMBER_HINT =
  'On, you stay signed in for up to a week. Off, your server ends the session after 12 hours at most, and usually when the browser closes. Either way this browser keeps an offline copy, so on a shared computer choose Sign out and remove data when you finish.'

export function SignInPanel({
  id,
  title,
  subtitle,
  defaultEmail,
  onSignedIn,
  extra,
  footnote,
}: {
  id: string
  title: string
  subtitle: ReactNode
  defaultEmail?: string
  onSignedIn: (user: SyncUser) => void
  /** Shown under the form (for example Disconnect while signed out). */
  extra?: ReactNode
  /** Where the login comes from, under the button (default: the admin login made at setup). */
  footnote?: ReactNode
}) {
  const uid = useId().replace(/:/g, '')
  const emailId = `signin-email-${uid}`
  const passwordId = `signin-password-${uid}`
  const [email, setEmail] = useState(() => defaultEmail || rememberedEmail())
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [remember, setRemember] = useState(false)
  const [tried, setTried] = useState(false)
  const [error, setError] = useState<{ message: string; n: number } | null>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const { busy, run } = useBusy()

  const trimmed = email.trim()
  const emailProblem = !trimmed
    ? 'Add the email of your admin login.'
    : !/^[^\s@]+@[^\s@]+$/.test(trimmed)
      ? 'Check the email. It looks like you@company.com.'
      : null
  const passwordProblem = password ? null : 'Add your password.'

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (emailProblem || passwordProblem) {
      setTried(true)
      setError(null)
      focusFirstInvalid(formRef.current ?? undefined)
      return
    }
    const pw = password
    // Cleared after every attempt, whatever the answer: the password never lingers on screen.
    setPassword('')
    setShow(false)
    setTried(false)
    const res = await run('signin', () => connect.signIn(trimmed, pw, { remember }))
    if (!res) return
    if (res.ok) {
      setError(null)
      rememberEmail(res.user.email)
      onSignedIn(res.user)
      return
    }
    setError({ message: res.message, n: Date.now() })
    // Start again where the fix goes: the empty password field.
    setTimeout(() => document.getElementById(passwordId)?.focus(), 30)
  }

  return (
    <Panel id={id} title={title} subtitle={subtitle} icon="key">
      <form ref={formRef} noValidate onSubmit={submit} aria-busy={busy ? true : undefined} className="flex max-w-[32rem] flex-col gap-4">
        <Field label="Email" id={emailId} error={tried ? emailProblem : null}>
          {(fid, hint) => (
            <TextInput
              id={fid}
              name="username"
              type="email"
              inputMode="email"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-describedby={hint}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
        <Field label="Password" id={passwordId} error={tried ? passwordProblem : null}>
          {(fid, hint) => (
            <div className="flex items-center gap-2">
              <TextInput
                id={fid}
                name="password"
                type={show ? 'text' : 'password'}
                autoComplete="current-password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-describedby={hint}
                className="min-w-0 flex-1"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <IconButton
                icon={show ? 'eye-off' : 'eye'}
                label="Show password"
                variant="secondary"
                aria-pressed={show}
                aria-controls={fid}
                className={show ? 'ft-iconbtn--on' : undefined}
                onClick={() => setShow((s) => !s)}
              />
            </div>
          )}
        </Field>
        <Checkbox checked={remember} onChange={setRemember} label="Keep me signed in on this device" description={REMEMBER_HINT} />
        <FlowError error={error} title="Sign-in did not work" />
        <BusyNote text={busyText(busy)} />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" size="lg" icon="key" {...busyProps(busy)}>
            {busy === 'signin' ? 'Signing in' : 'Sign in'}
          </Button>
        </div>
        <p className="text-[13px] text-ink-3">
          {footnote ?? 'Use the admin email and password created when the server was set up. Forgot it? Whoever runs the server can set a new one.'}
        </p>
      </form>
      {extra && <div className="mt-4 border-t border-line pt-4">{extra}</div>}
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------
// Connect: the server is reachable and this browser is signed in but not syncing yet
// ---------------------------------------------------------------------------------------------

type Inspected = Extract<InspectResult, { ok: true }>

export function ConnectPanel({
  email,
  onConnected,
  onSignedOut,
  onInspected,
}: {
  email: string
  onConnected: (how: 'upload' | 'server' | 'replace') => void
  onSignedOut: () => void
  /** Told whether the server is empty each time the panel looks (Start fresh then offers to upload). */
  onInspected?: (empty: boolean) => void
}) {
  const db = useDB((s) => s.db)
  const local = useMemo(() => summarize(db), [db])
  const [server, setServer] = useState<Inspected | null>(null)
  const [error, setError] = useState<{ message: string; n: number; kind: string } | null>(null)
  const { busy, run } = useBusy()
  // The parent passes new callbacks on every render; the inspect below must still run only once.
  const signedOutRef = useRef(onSignedOut)
  signedOutRef.current = onSignedOut
  const inspectedRef = useRef(onInspected)
  inspectedRef.current = onInspected

  const inspect = useCallback(async () => {
    const res = await run('inspect', () => connect.inspectServer())
    if (!res) return
    if (res.ok) {
      setServer(res)
      setError(null)
      inspectedRef.current?.(res.empty)
    } else {
      setServer(null)
      setError({ message: res.message, n: Date.now(), kind: res.kind })
      if (res.kind === 'signed_out') signedOutRef.current()
    }
  }, [run])

  useEffect(() => {
    void inspect()
  }, [inspect])

  const finish = (res: FlowResult | undefined, how: 'upload' | 'server' | 'replace') => {
    if (!res) return
    if (res.ok) {
      onConnected(how)
      return
    }
    setError({ message: res.message, n: Date.now(), kind: res.kind })
    if (res.kind === 'signed_out') onSignedOut()
  }

  const signOutHere = async () => {
    const res = await run('signout', () => signOut())
    if (!res) return
    if (!res.ok) {
      setError({ message: res.message, n: Date.now(), kind: res.kind })
      return
    }
    // Not confirmed: the server could not be reached, so its session stays open until this browser ends it.
    if (!res.confirmed) toast({ text: res.message })
    onSignedOut()
  }

  return (
    <Panel
      id="server-connect"
      title={server ? (server.empty ? 'Your server is empty' : 'Your server already has a workspace') : 'Signed in to your server'}
      subtitle={`Signed in as ${email}. Nothing syncs until you choose below.`}
      icon="globe"
      actions={
        <Button variant="ghost" icon="log-out" onClick={() => !busy && void signOutHere()} {...busyProps(busy)}>
          Sign out
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        <BusyNote text={busyText(busy)} />
        {error && error.kind !== 'pending' && (
          <FlowError error={error} title={server ? 'That did not work' : 'Could not look at your server'} />
        )}
        {!server && error && error.kind !== 'signed_out' && (
          <div>
            <Button icon="rotate-ccw" onClick={() => !busy && void inspect()} {...busyProps(busy)}>
              Try again
            </Button>
          </div>
        )}
        {server?.empty && <UploadChoice local={local} busy={busy} run={run} onDone={(res) => finish(res, 'upload')} />}
        {server && !server.empty && (
          <ServerHasData
            local={local}
            server={server}
            busy={busy}
            run={run}
            pendingError={error?.kind === 'pending' ? error : null}
            onDone={finish}
          />
        )}
      </div>
    </Panel>
  )
}

type Run = <T>(name: string, fn: () => Promise<T>) => Promise<T | undefined>

/**
 * One workspace in the connect step's comparison: name and counts, then what tells two copies with one
 * name apart (when it was created, its last logged change, how much is filled in), and which one holds
 * more of the work.
 */
function WorkspaceLine({ summary, recommended }: { summary: WorkspaceSummary; recommended: boolean }) {
  const detail = describeDetail(summary)
  return (
    <>
      <span className="block">
        {summary.companyName || 'an unnamed company'}
        {summary.sample ? ' (sample company)' : ''}: {describeCounts(summary.counts)}
      </span>
      {detail && <span className="mt-0.5 block text-[13px] text-ink-2">{detail}</span>}
      {recommended && (
        <Badge tone="good" icon="check" className="mt-1.5">
          Recommended: has more of your work
        </Badge>
      )}
    </>
  )
}

/** What an upload sends, in words. */
function UploadWhat({ local }: { local: WorkspaceSummary }) {
  return (
    <p className="max-w-[75ch] text-[14.5px] text-ink">
      Uploading sends this browser's workspace to your server: <strong>{local.companyName || 'your company'}</strong> with{' '}
      {describeCounts(local.counts)}, plus pay, equity, checklists, time off, settings and the activity log. Display preferences and
      Viewing as stay on this device. From then on every change syncs, and other computers can sign in and use the server's copy.
    </p>
  )
}

/**
 * The sample never syncs on its own: say so and offer the ways out. Only for an empty server (nothing
 * there to lose); when the server has a workspace, Use the server's copy is the way.
 */
function SampleChoice({ anywayLabel, onAnyway, busy }: { anywayLabel: string; onAnyway: () => void; busy: string | null }) {
  return (
    <Callout tone="warn" title="This browser shows the sample company">
      <p>{SAMPLE_MESSAGE}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <ButtonLink href={href('settings', 'server', 'fresh')} variant="primary" icon="user">
          Start fresh
        </ButtonLink>
        {/* Lands on the Import panel itself; a finished import comes back here to choose what syncs. */}
        <ButtonLink href={href('settings', 'data', 'import')} icon="upload">
          Import a backup
        </ButtonLink>
        <Button variant="ghost" onClick={() => !busy && onAnyway()} {...busyProps(busy)}>
          {anywayLabel}
        </Button>
      </div>
    </Callout>
  )
}

function UploadChoice({ local, busy, run, onDone }: { local: WorkspaceSummary; busy: string | null; run: Run; onDone: (res: FlowResult | undefined) => void }) {
  const upload = async (includeSample: boolean) => onDone(await run('upload', () => connect.uploadLocal({ includeSample })))
  return (
    <div className="flex flex-col gap-3">
      <UploadWhat local={local} />
      {local.sample ? (
        <SampleChoice anywayLabel="Upload the sample anyway" busy={busy} onAnyway={() => void upload(true)} />
      ) : (
        <div>
          <Button variant="primary" size="lg" icon="upload" onClick={() => !busy && void upload(false)} {...busyProps(busy)}>
            Upload this browser's workspace
          </Button>
        </div>
      )}
    </div>
  )
}

function ServerHasData({
  local,
  server,
  busy,
  run,
  pendingError,
  onDone,
}: {
  local: WorkspaceSummary
  server: Extract<Inspected, { empty: false }>
  busy: string | null
  run: Run
  pendingError: { message: string; n: number } | null
  onDone: (res: FlowResult | undefined, how: 'server' | 'replace') => void
}) {
  const serverSummary = useMemo(() => summarize(server.db), [server.db])
  const compare = compareWorkspaces(local, serverSummary)
  // Two copies with one name: say which holds more of the work, and what each choice would lose.
  const recommended = compare === 'same_name' ? recommendedCopy(local, serverSummary) : null
  const onlyHere = moreWorkIn(local, serverSummary)
  const onlyOnServer = moreWorkIn(serverSummary, local)
  // Each copy holds records the other lacks: neither is recommended, and both losses are said up front.
  const diverged =
    compare === 'same_name' && recommended === null && missingRecords(local, serverSummary).length > 0 && missingRecords(serverSummary, local).length > 0
  const serverName = server.companyName || 'an unnamed company'
  const localName = local.companyName || 'an unnamed company'
  const useServer = async (discardPending: boolean) => onDone(await run('servercopy', () => connect.useServerCopy({ discardPending })), 'server')
  const replace = async () =>
    onDone(await run('replace', () => connect.uploadLocal({ confirmReplace: true, includeSample: local.sample })), 'replace')

  return (
    <div className="flex flex-col gap-5">
      <DescriptionList
        items={[
          { label: 'On your server', value: <WorkspaceLine summary={serverSummary} recommended={recommended === 'server'} /> },
          { label: 'In this browser', value: <WorkspaceLine summary={local} recommended={recommended === 'local'} /> },
        ]}
      />
      {diverged && (
        <Callout tone="warn" title="Each copy has work the other does not">
          <p>
            This browser's copy has {joinAnd(onlyHere)} than your server's, which using the server's copy would lose. Your server's copy
            has {joinAnd(onlyOnServer)} than this browser's, which replacing it would lose. Neither is recommended: download a backup of
            this browser's copy first, whichever you choose.
          </p>
        </Callout>
      )}

      <section aria-labelledby="server-choice-copy" className="flex flex-col gap-3 border-t border-line pt-4">
        <h3 id="server-choice-copy" className="text-[15.5px] font-bold text-ink">
          Use the server's copy
        </h3>
        <p className="max-w-[75ch] text-[14.5px] text-ink-2">
          This browser switches to {serverName} from your server and starts syncing. Choose this on a new computer, or whenever the server
          holds the workspace you work in.
        </p>
        {compare === 'sample' && (
          <p className="text-[14px] text-ink-2">The sample company in this browser is replaced. Nothing of yours is lost.</p>
        )}
        {compare !== 'sample' && (
          // A name and a few counts cannot prove two workspaces are the same one, so this never says
          // "same" and always offers the backup. The button sits under the text so phones keep full lines.
          <Callout
            tone="warn"
            title={
              compare === 'same_name'
                ? `This browser has a workspace named ${localName} too`
                : `This browser holds ${localName}, which is not what your server has`
            }
          >
            <p>
              Using the server's copy replaces it here ({describeCounts(local.counts)}).
              {onlyHere.length > 0 && ` This browser's copy has ${joinAnd(onlyHere)} than your server's.`} Download a backup first to keep it.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" icon="download" onClick={() => downloadBackup()}>
                Download backup
              </Button>
            </div>
          </Callout>
        )}
        {pendingError && (
          <div role="alert" key={pendingError.n}>
            <Callout tone="bad" title="Some changes exist only in this browser">
              <p>{pendingError.message}</p>
              <div className="mt-3">
                <ConfirmButton
                  icon="trash"
                  confirmLabel="Press again to discard them"
                  onConfirm={() => !busy && void useServer(true)}
                  {...busyProps(busy)}
                >
                  Use the server's copy and discard them
                </ConfirmButton>
              </div>
            </Callout>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {compare === 'sample' ? (
            <Button variant="primary" size="lg" icon="download" onClick={() => !busy && void useServer(false)} {...busyProps(busy)}>
              Use the server's copy
            </Button>
          ) : (
            <ConfirmButton
              variant="primary"
              size="lg"
              icon="download"
              confirmLabel="Press again to replace this browser's copy"
              onConfirm={() => !busy && void useServer(false)}
              {...busyProps(busy)}
            >
              Use the server's copy
            </ConfirmButton>
          )}
        </div>
      </section>

      <section aria-labelledby="server-choice-replace" className="flex flex-col gap-3 border-t border-line pt-4">
        <h3 id="server-choice-replace" className="text-[15.5px] font-bold text-ink">
          Replace the server with this browser's workspace
        </h3>
        {local.sample ? (
          // Nothing of the company's is in this browser: Use the server's copy is the only sensible step,
          // so this section recommends nothing. The way to put the sample on the server stays, quietly.
          <>
            <p className="max-w-[75ch] text-[14.5px] text-ink-2">This browser only has the sample company. Use the server's copy above.</p>
            <div className="flex flex-wrap gap-2">
              <ConfirmButton
                variant="ghost"
                confirmLabel={`Press again to replace ${serverName} with the sample for everyone`}
                onConfirm={() => !busy && void replace()}
                {...busyProps(busy)}
              >
                Replace the server with the sample anyway
              </ConfirmButton>
            </div>
          </>
        ) : (
          <>
            <Callout
              tone="bad"
              title={
                compare === 'same_name'
                  ? `This replaces your server's copy of ${serverName} for everyone`
                  : `This removes ${serverName} from your server for everyone`
              }
            >
              {onlyOnServer.length > 0 && <>The server's copy has {joinAnd(onlyOnServer)} than this browser's, and they would be lost. </>}
              Your server's {describeCounts(server.counts)} are replaced by {localName} from this browser, and every computer that syncs
              switches to it. The app cannot bring the server's copy back; only a database backup on the server can.
            </Callout>
            <div className="flex flex-wrap gap-2">
              <ConfirmButton
                icon="upload"
                confirmLabel="Press again to replace the server's workspace"
                onConfirm={() => !busy && void replace()}
                {...busyProps(busy)}
              >
                Replace the server's workspace
              </ConfirmButton>
            </div>
          </>
        )}
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Paused connection (a hold): the sample, an empty server, a workspace swapped outside sync, or the
// demo clock
// ---------------------------------------------------------------------------------------------

export function HoldPanel({
  hold,
  onSignedOut,
  onResumed,
}: {
  hold: HoldReason
  onSignedOut: () => void
  onResumed: (text: string) => void
}) {
  const db = useDB((s) => s.db)
  const local = useMemo(() => summarize(db), [db])
  const waiting = useSyncStatus((s) => s.pendingEdits)
  const pretend = usePrefs((s) => s.clockOverride)
  const { busy, run } = useBusy()
  const [error, setError] = useState<{ message: string; n: number; kind: string } | null>(null)
  const done = (res: FlowResult | undefined, text: string) => {
    if (!res) return
    if (res.ok) {
      setError(null)
      // The engine says so when it did something other than asked (Upload found another computer's copy).
      onResumed(res.message ?? text)
      return
    }
    setError({ message: res.message, n: Date.now(), kind: res.kind })
    if (res.kind === 'signed_out') onSignedOut()
  }
  const useServer = async (discardPending: boolean) =>
    done(await run('servercopy', () => connect.useServerCopy({ discardPending })), 'Using the server\'s copy. Syncing again.')
  const upload = async (o: { confirmReplace?: boolean; includeSample?: boolean }) =>
    done(await run('upload', () => connect.uploadLocal(o)), 'Uploaded. Syncing again.')
  const name = local.companyName || 'This workspace'
  // Two answers get their own callouts below (server_empty); anything else is a plain error.
  const shownError = error && error.kind !== 'not_empty' && error.kind !== 'pending' ? error : null

  const body: Record<HoldReason, { title: string; subtitle: string; content: ReactNode }> = {
    sample: {
      title: 'Syncing is paused',
      subtitle: 'This browser shows the sample company, which never syncs. Your workspace is still on your server.',
      content: (
        <RowList label="Ways to resume">
          <Row
            title="Go back to your workspace"
            meta="Undo (Ctrl Z) back to the workspace you had, or download it again from your server. Both resume syncing."
            actions={
              <Button variant="primary" icon="download" onClick={() => !busy && void useServer(true)} {...busyProps(busy)}>
                Use the server's copy
              </Button>
            }
          />
        </RowList>
      ),
    },
    server_empty: {
      title: 'Your server has no workspace',
      subtitle: 'Syncing is paused. The server may have been reset or restored from an empty backup. Keep working: changes wait in this browser.',
      content: (
        <div className="flex flex-col gap-3">
          <UploadWhat local={local} />
          {waiting > 0 && (
            <p className="max-w-[75ch] text-[14.5px] text-ink">
              {plural(waiting, 'change is', 'changes are')} waiting in this browser. {waiting === 1 ? 'It reaches' : 'They reach'} your server
              either way: with this upload, or on top of the copy another computer uploads.
            </p>
          )}
          {local.sample ? (
            <SampleChoice anywayLabel="Upload the sample anyway" busy={busy} onAnyway={() => void upload({ includeSample: true })} />
          ) : (
            <div>
              <Button variant="primary" size="lg" icon="upload" onClick={() => !busy && void upload({})} {...busyProps(busy)}>
                Upload this browser's workspace
              </Button>
            </div>
          )}
          <p className="max-w-[75ch] text-[13px] text-ink-3">
            If another computer uploads first, this browser notices when you come back to it and syncs with that copy, keeping the changes
            waiting here.
          </p>
          {error?.kind === 'not_empty' && (
            <div role="alert" key={error.n}>
              <Callout tone="warn" title="Your server has a workspace again">
                <p>
                  Another computer uploaded one, and this browser could not load it just now. Use the server's copy to sync with it (the changes
                  waiting here are kept when it is the same workspace), or replace it with this browser's workspace for every computer.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <ConfirmButton
                    variant="primary"
                    icon="download"
                    confirmLabel="Press again to use the server's copy"
                    onConfirm={() => !busy && void useServer(false)}
                    {...busyProps(busy)}
                  >
                    Use the server's copy
                  </ConfirmButton>
                  <ConfirmButton
                    icon="upload"
                    confirmLabel="Press again to replace the server's workspace"
                    onConfirm={() => !busy && void upload({ confirmReplace: true, includeSample: local.sample })}
                    {...busyProps(busy)}
                  >
                    Replace the server's workspace
                  </ConfirmButton>
                  <Button variant="ghost" icon="download" onClick={() => downloadBackup()}>
                    Download backup
                  </Button>
                </div>
              </Callout>
            </div>
          )}
          {error?.kind === 'pending' && (
            <div role="alert" key={error.n}>
              <Callout tone="bad" title="Your server holds a different workspace">
                <p>{error.message}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="ghost" icon="download" onClick={() => downloadBackup()}>
                    Download backup
                  </Button>
                  <ConfirmButton icon="trash" confirmLabel="Press again to discard them" onConfirm={() => !busy && void useServer(true)} {...busyProps(busy)}>
                    Use the server's copy and discard them
                  </ConfirmButton>
                </div>
              </Callout>
            </div>
          )}
        </div>
      ),
    },
    replaced: {
      title: 'This browser\'s workspace was replaced',
      subtitle: 'Syncing is paused. Import or Start fresh replaced it while it could not reach your server, so the server never got it.',
      content: (
        <RowList label="Ways to resume">
          <Row
            title={`Upload ${name} to your server`}
            meta="Replaces the server's workspace for every computer that syncs. Only a database backup on the server can bring the old one back."
            actions={
              <ConfirmButton
                icon="upload"
                confirmLabel="Press again to replace the server's workspace"
                onConfirm={() => !busy && void upload({ confirmReplace: true, includeSample: local.sample })}
                {...busyProps(busy)}
              >
                Replace the server's workspace
              </ConfirmButton>
            }
          />
          <Row
            title="Use the server's copy"
            meta={`Discards ${name} in this browser and goes back to what your server has. Download a backup first to keep it.`}
            actions={
              <>
                <Button variant="ghost" icon="download" onClick={() => downloadBackup()}>
                  Download backup
                </Button>
                <ConfirmButton
                  icon="trash"
                  confirmLabel="Press again to discard this browser's copy"
                  onConfirm={() => !busy && void useServer(true)}
                  {...busyProps(busy)}
                >
                  Use the server's copy
                </ConfirmButton>
              </>
            }
          />
        </RowList>
      ),
    },
    demo_clock: pretend
      ? {
          title: 'Syncing is paused',
          subtitle: `The app pretends today is ${fmtDay(pretend)}, ${pretend.slice(0, 4)} (Settings, Data). Nothing reaches your server until you go back to the real date.`,
          content: (
            <RowList label="Ways to resume">
              <Row
                title="Go back to the real date"
                meta="Syncing resumes and this browser takes your server's copy again. Job changes and hand-offs the pretend date applied, and changes made while pretending, are dropped. Download a backup first to keep them."
                actions={
                  <>
                    <Button variant="ghost" icon="download" onClick={() => downloadBackup()}>
                      Download backup
                    </Button>
                    <ConfirmButton icon="rotate-ccw" confirmLabel="Press again to take the server's copy" onConfirm={() => setDemoClock(null)}>
                      Go back to the real date
                    </ConfirmButton>
                  </>
                }
              />
            </RowList>
          ),
        }
      : {
          // Back on the real date, but this browser had no copy from before the pretend date to go back
          // to, so it waits for the server's copy (the engine queues nothing until then).
          title: 'Waiting for your server',
          subtitle:
            'The app is back on the real date, but this browser still shows what the pretend date applied. It takes your server\'s copy as soon as it can reach your server, and syncing resumes.',
          content: (
            <RowList label="Until then">
              <Row
                title="Changes made now are not kept"
                meta="They would carry what the pretend date applied. Download a backup first to keep anything from this browser."
                actions={
                  <Button variant="ghost" icon="download" onClick={() => downloadBackup()}>
                    Download backup
                  </Button>
                }
              />
            </RowList>
          ),
        },
  }
  const b = body[hold]
  return (
    <Panel id="server-hold" title={b.title} subtitle={b.subtitle} icon="clock">
      <div className="flex flex-col gap-4">
        {b.content}
        <FlowError error={shownError} title="That did not work" />
        <BusyNote text={busyText(busy)} />
      </div>
    </Panel>
  )
}

/** A toast that confirms a finished connect step. */
export function connectedToast(how: 'upload' | 'server' | 'replace'): void {
  toast({
    text:
      how === 'upload'
        ? 'Uploaded. Every change now syncs to your server.'
        : how === 'replace'
          ? 'The server now has this browser\'s workspace. Syncing.'
          : 'Using the server\'s copy. Every change now syncs.',
  })
}
