// The invite page (#invite.<token>): someone opened a link an admin made in Settings, Server. It names the
// company the link joins (asked without signing in), takes an email and a new password for a login in that
// company, then downloads the company's workspace into this browser and starts syncing, as Use the
// server's copy does. A browser that already syncs with a company disconnects first (one browser syncs one
// company); one that holds a company of its own is told it gets replaced, with a backup button. Any role
// may open it: it belongs to no section, and joining is the server's decision, not Viewing as.
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { PageProps } from '@/app/routes'
import { links, replaceRoute } from '@/app/router'
import { useDB } from '@/store/db'
import { usePrefs } from '@/store/prefs'
import {
  connect,
  type DemoSignup,
  demoSignup,
  disconnect,
  inviteInfo,
  MIN_PASSWORD_LENGTH,
  newPasswordProblem,
  refreshServerAccount,
  signupEmailProblem,
  useSyncStatus,
} from '@/sync'
import { Button, Callout, Checkbox, ConfirmButton, EmptyState, focusFirstInvalid, PageHeader, Panel, toast } from '@/ui'
import { downloadBackup } from './DataTab'
import { replacedHere } from './demoLogic'
import { DemoNotice, EmailField, PasswordField } from './demoParts'
import { ButtonLink } from './kit'
import { focusPanelTitle } from './serverFocus'
import { detectHostContext, summarize } from './serverLogic'
import { BusyNote, busyText, FlowError, REMEMBER_HINT, rememberEmail, useBusy } from './serverParts'

/** What the look at the invite found. again: worth trying again (the server could not be reached). */
type Look = { kind: 'checking' } | { kind: 'ok'; companyName: string } | { kind: 'bad'; message: string; again: boolean }

const busyProps = (busy: string | null) => (busy ? { 'aria-disabled': true as const } : {})

export function InvitePage({ route }: PageProps) {
  const token = route.segments[1] ?? ''
  const host = useMemo(detectHostContext, [])
  const connected = useSyncStatus((s) => s.mode === 'server')
  const [look, setLook] = useState<Look>({ kind: 'checking' })
  const [demo, setDemo] = useState<DemoSignup | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    // Never a network call where no server can live (a file, the artifact viewer).
    if (host !== 'web') return
    let live = true
    setLook({ kind: 'checking' })
    void Promise.all([inviteInfo(token), demoSignup()]).then(([res, d]) => {
      if (!live) return
      setDemo(d)
      setLook(
        res.ok
          ? { kind: 'ok', companyName: res.companyName }
          : { kind: 'bad', message: res.message, again: res.kind === 'offline' || res.kind === 'server' || res.kind === 'rate_limited' },
      )
    })
    return () => {
      live = false
    }
  }, [token, host, attempt])

  const title = look.kind === 'ok' ? `Join ${look.companyName}` : 'Join a company'
  let body
  if (host !== 'web') {
    body = (
      <EmptyState
        icon="link"
        title="Invite links open on the server's address"
        body="This copy of First Twenty runs from a file or inside the artifact viewer, so it cannot join a company. Open the invite link in a browser, exactly as it was sent."
      />
    )
  } else if (look.kind === 'checking') {
    body = (
      <Panel id="invite-checking" title="Looking at the invite link" icon="link">
        <p role="status" className="text-[14.5px] text-ink-2">
          Asking the server which company this link joins.
        </p>
      </Panel>
    )
  } else if (look.kind === 'bad') {
    body = (
      <Panel id="invite-bad" title="This invite link cannot be used" icon="alert">
        <div className="flex flex-col gap-3">
          <div role="alert">
            <Callout tone="bad">{look.message}</Callout>
          </div>
          <div className="flex flex-wrap gap-2">
            {look.again && (
              <Button icon="rotate-ccw" onClick={() => setAttempt((a) => a + 1)}>
                Try again
              </Button>
            )}
            <ButtonLink href={links.settings('server')} variant={look.again ? 'ghost' : 'secondary'} icon="key">
              Sign in or create a company
            </ButtonLink>
          </div>
        </div>
      </Panel>
    )
  } else if (connected) {
    body = <DisconnectFirst companyName={look.companyName} />
  } else {
    body = <JoinForm token={token} companyName={look.companyName} demo={demo} />
  }

  return (
    <>
      <PageHeader title={title} subtitle="Someone invited you to work on a company with them in First Twenty." />
      <div className="flex max-w-[48rem] flex-col gap-5">{body}</div>
    </>
  )
}

/**
 * Email and a new password for a login in the invite's company, then the company's workspace into this
 * browser. Once the login exists, a failed download is retried on its own: the invite is used up.
 */
function JoinForm({ token, companyName, demo }: { token: string; companyName: string; demo: DemoSignup | null }) {
  const uid = useId().replace(/:/g, '')
  const emailId = `join-email-${uid}`
  const passwordId = `join-password-${uid}`
  const db = useDB((s) => s.db)
  const ownHere = replacedHere(useMemo(() => summarize(db), [db]))
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const [tried, setTried] = useState(false)
  const [joined, setJoined] = useState(false)
  const [error, setError] = useState<{ message: string; n: number } | null>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const { busy, run } = useBusy()
  const problems = { email: signupEmailProblem(email), password: newPasswordProblem(password) }

  /** Downloads the company's workspace and starts syncing; then Settings, Server shows Synced. */
  const take = async () => {
    const res = await run('servercopy', () => connect.useServerCopy())
    if (!res) return
    if (res.ok || res.kind === 'empty') {
      // A new device for this login: start as admin, as Start fresh does. The address forgets the token.
      usePrefs.getState().setViewAs('admin', null)
      void refreshServerAccount()
      toast(
        res.ok
          ? { text: `Joined ${companyName}. Every change now syncs.` }
          : { text: `Joined ${companyName}. Its workspace is not on the server yet; Settings, Server says what comes next.` },
      )
      replaceRoute('settings', 'server')
      focusPanelTitle(res.ok ? 'server-status' : 'server-connect')
      return
    }
    setError({
      message: `You joined ${companyName}, but its workspace did not download yet. ${res.message} Press Download it again to try once more.`,
      n: Date.now(),
    })
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (joined) {
      await take()
      return
    }
    if (problems.email || problems.password) {
      setTried(true)
      setError(null)
      focusFirstInvalid(formRef.current ?? undefined)
      return
    }
    setTried(false)
    const res = await run('join', () => connect.acceptInvite({ token, email: email.trim(), password, remember }))
    if (!res) return
    if (!res.ok) {
      setError({ message: res.message, n: Date.now() })
      if (res.kind === 'email_taken') setTimeout(() => document.getElementById(emailId)?.focus(), 30)
      return
    }
    setPassword('')
    rememberEmail(res.user.email)
    setJoined(true)
    await take()
  }

  return (
    <Panel
      id="invite-join"
      title={`Make your login for ${companyName}`}
      subtitle={`Once you join, you see and change everything in ${companyName}, and every change syncs with your teammates.`}
      icon="user-plus"
    >
      <form ref={formRef} noValidate onSubmit={submit} aria-busy={busy ? true : undefined} className="flex max-w-[34rem] flex-col gap-4">
        {demo && <DemoNotice demo={demo} />}
        {joined ? (
          <p className="text-[14.5px] text-ink">
            Signed in as <strong>{email.trim()}</strong>. {companyName}'s workspace still needs to download into this browser.
          </p>
        ) : (
          <>
            {ownHere && (
              <Callout tone="warn" title={`Joining replaces ${ownHere} in this browser`}>
                <p>
                  {companyName} takes its place here. Download a backup first to keep this browser's copy of {ownHere}.
                </p>
                <div className="mt-3">
                  <Button size="sm" icon="download" onClick={() => downloadBackup()}>
                    Download backup
                  </Button>
                </div>
              </Callout>
            )}
            <EmailField id={emailId} value={email} onChange={setEmail} error={tried ? problems.email : null} hint="Your login. One email belongs to one company here." />
            <PasswordField
              id={passwordId}
              label="New password"
              value={password}
              onChange={setPassword}
              error={tried ? problems.password : null}
              hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
            />
            <Checkbox checked={remember} onChange={setRemember} label="Keep me signed in on this device" description={REMEMBER_HINT} />
          </>
        )}
        <FlowError error={error} title={joined ? 'The workspace did not download' : 'You did not join yet'} />
        <BusyNote text={busyText(busy)} />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" size="lg" icon={joined ? 'download' : 'user-plus'} {...busyProps(busy)}>
            {busy === 'join' ? 'Joining' : busy === 'servercopy' ? 'Downloading' : joined ? 'Download it again' : `Join ${companyName}`}
          </Button>
          {!joined && (
            <ButtonLink href={links.settings('server')} variant="ghost">
              I already have a login
            </ButtonLink>
          )}
        </div>
      </form>
    </Panel>
  )
}

/** This browser syncs with a company already: disconnect it (it keeps a copy), then join here. */
function DisconnectFirst({ companyName }: { companyName: string }) {
  const localName = useDB((s) => s.db.company.name) || 'a company'
  const { busy, run } = useBusy()
  const [blocked, setBlocked] = useState<{ message: string; n: number } | null>(null)
  const [error, setError] = useState<{ message: string; n: number } | null>(null)

  const go = async (discardPending: boolean) => {
    setError(null)
    const res = await run('disconnect', () => disconnect({ discardPending }))
    if (!res) return
    // Disconnected: this page shows the join form next.
    if (res.ok) {
      setBlocked(null)
      toast({ text: res.message })
      focusPanelTitle('invite-join')
    } else if (res.kind === 'pending') setBlocked({ message: res.message, n: Date.now() })
    else setError({ message: res.message, n: Date.now() })
  }

  return (
    <Panel id="invite-connected" title="Disconnect this browser first" icon="globe">
      <div className="flex flex-col gap-3">
        <p className="max-w-[75ch] text-[14.5px] text-ink">
          This browser syncs with {localName}. One browser syncs with one company at a time, so disconnect it to join {companyName} here, or
          open the invite link in another browser. {localName} stays on its server either way.
        </p>
        <div>
          <Button variant="primary" icon="x" onClick={() => !busy && void go(false)} {...busyProps(busy)}>
            Disconnect this browser
          </Button>
        </div>
        {blocked && (
          <div role="alert" key={blocked.n}>
            <Callout tone="warn" title="Still connected">
              <p>{blocked.message}</p>
              <div className="mt-3">
                <ConfirmButton icon="x" confirmLabel="Press again to disconnect" onConfirm={() => !busy && void go(true)} {...busyProps(busy)}>
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
