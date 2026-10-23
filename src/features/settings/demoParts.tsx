// The demo server pieces of Settings, Server and the invite page: creating a demo company (a new login,
// then a blank company uploaded as that login's workspace), the signed-in login's company with its invite
// links (the open ones listed, each revocable) and its careers page (an admin's switch), and the shared
// password field. Every server call goes through '@/sync'.
import type { ReactNode } from 'react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { copyText } from '@/lib/files'
import { useDB } from '@/store/db'
import { usePrefs } from '@/store/prefs'
import {
  companyNameProblem,
  connect,
  createInvite,
  type DemoSignup,
  demoNotice,
  MAX_COMPANY_NAME_LENGTH,
  listInvites,
  MIN_PASSWORD_LENGTH,
  newPasswordProblem,
  type OpenInvite,
  refreshServerAccount,
  revokeInvite,
  type ServerAccount,
  setCareers,
  signupEmailProblem,
  type SyncUser,
} from '@/sync'
import { Button, Callout, Checkbox, ConfirmButton, DescriptionList, Field, focusFirstInvalid, FormGrid, IconButton, Panel, Switch, TextInput, toast } from '@/ui'
import { downloadBackup } from './DataTab'
import { careersSwitchText, demoCompanyDB, displayUrl, founderNameProblem, inviteExpiryText, openInviteText, replacedHere } from './demoLogic'
import { summarize } from './serverLogic'
import { BusyNote, busyText, FlowError, REMEMBER_HINT, rememberEmail, useBusy } from './serverParts'

const busyProps = (busy: string | null) => (busy ? { 'aria-disabled': true as const } : {})

/** A password field with a Show toggle (new passwords: the browser may offer to make one). */
export function PasswordField({
  id,
  label,
  value,
  onChange,
  error,
  hint,
  autoComplete = 'new-password',
}: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  error: string | null
  hint?: ReactNode
  autoComplete?: 'new-password' | 'current-password'
}) {
  const [show, setShow] = useState(false)
  return (
    <Field label={label} id={id} error={error} hint={hint}>
      {(fid, described) => (
        <div className="flex items-center gap-2">
          <TextInput
            id={fid}
            name="password"
            type={show ? 'text' : 'password'}
            autoComplete={autoComplete}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby={described}
            className="min-w-0 flex-1"
            value={value}
            onChange={(e) => onChange(e.target.value)}
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
  )
}

/** An email field for a new login (the password manager pairs it with the new password). */
export function EmailField({ id, value, onChange, error, hint }: { id: string; value: string; onChange: (v: string) => void; error: string | null; hint?: ReactNode }) {
  return (
    <Field label="Email" id={id} error={error} hint={hint}>
      {(fid, described) => (
        <TextInput
          id={fid}
          name="username"
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-describedby={described}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  )
}

/** The demo notice: anyone can sign up, so no real data, and when demo companies are deleted. */
export function DemoNotice({ demo }: { demo: DemoSignup }) {
  return (
    <Callout tone="warn" title="A demo server">
      {demoNotice(demo.expireDays)}
    </Callout>
  )
}

/** Where a fix starts after the server said no: the field the answer is about. */
function focusField(id: string): void {
  setTimeout(() => document.getElementById(id)?.focus(), 30)
}

// ---------------------------------------------------------------------------------------------
// Create a demo company
// ---------------------------------------------------------------------------------------------

/**
 * Create a demo company, next to Sign in on a server where anyone may sign up. A new login and an empty
 * company on the server first (connect.signUp), then a blank company named as typed (Start fresh's
 * defaults) uploaded as its workspace (connect.uploadNew), and syncing starts. When the upload fails, the
 * login exists already: the form says so and the next press only retries the upload. A browser that holds
 * its own company may upload that one instead of starting blank.
 */
export function SignupPanel({
  id,
  demo,
  onAccount,
  onCreated,
}: {
  id: string
  demo: DemoSignup
  /** The login exists (signed in); the company is on its way. */
  onAccount?: () => void
  /** Uploaded and syncing: the company's name and the new login. */
  onCreated: (companyName: string, user: SyncUser) => void
}) {
  const uid = useId().replace(/:/g, '')
  const ids = {
    company: `signup-company-${uid}`,
    first: `signup-first-${uid}`,
    last: `signup-last-${uid}`,
    email: `signup-email-${uid}`,
    password: `signup-password-${uid}`,
  }
  const db = useDB((s) => s.db)
  const local = useMemo(() => summarize(db), [db])
  const ownHere = replacedHere(local)
  const [companyName, setCompanyName] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const [keepLocal, setKeepLocal] = useState(false)
  const [tried, setTried] = useState(false)
  const [error, setError] = useState<{ message: string; n: number } | null>(null)
  // Signed up, but the company did not reach the server yet: the next press retries only that step.
  const [pending, setPending] = useState<{ name: string; keepLocal: boolean; user: SyncUser } | null>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const { busy, run } = useBusy()

  const useLocal = keepLocal && ownHere !== null
  // This browser's own company goes up under its own name, so the server and the app never disagree on it.
  const sentName = useLocal ? local.companyName.trim() : companyName.trim()
  const problems = {
    company: companyNameProblem(sentName),
    name: useLocal ? null : founderNameProblem(firstName, lastName),
    email: signupEmailProblem(email),
    password: newPasswordProblem(password),
  }
  const firstProblem = problems.name && !firstName.trim() ? problems.name : null
  const lastProblem = problems.name && firstName.trim() ? problems.name : null

  /** Puts the new company on the server (or this browser's own, when asked) and starts syncing. */
  const upload = async (name: string, fromHere: boolean, user: SyncUser) => {
    const res = await run('newcompany', () =>
      fromHere ? connect.uploadLocal() : connect.uploadNew(demoCompanyDB({ companyName: name, firstName, lastName })),
    )
    if (!res) return
    if (res.ok) {
      setPending(null)
      setError(null)
      // A fresh company on this device: start as its admin, as Start fresh does.
      usePrefs.getState().setViewAs('admin', null)
      void refreshServerAccount()
      onCreated(name, user)
      return
    }
    setError({
      message: `Your login was created, but the company did not reach the server yet. ${res.message} Press ${fromHere ? 'Upload it again' : 'Create it again'} to try once more.`,
      n: Date.now(),
    })
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (pending) {
      await upload(pending.name, pending.keepLocal, pending.user)
      return
    }
    if (problems.company || problems.name || problems.email || problems.password) {
      setTried(true)
      setError(null)
      focusFirstInvalid(formRef.current ?? undefined)
      return
    }
    setTried(false)
    const name = sentName
    const res = await run('signup', () => connect.signUp({ email: email.trim(), password, companyName: name, remember }))
    if (!res) return
    if (!res.ok) {
      setError({ message: res.message, n: Date.now() })
      if (res.kind === 'email_taken') focusField(ids.email)
      return
    }
    // The password never lingers once it did its job.
    setPassword('')
    rememberEmail(res.user.email)
    onAccount?.()
    const created = res.workspace?.name || name
    setPending({ name: created, keepLocal: useLocal, user: res.user })
    await upload(created, useLocal, res.user)
  }

  const label = busy === 'signup' ? 'Creating' : busy === 'newcompany' ? 'Saving the company' : pending ? (pending.keepLocal ? 'Upload it again' : 'Create it again') : 'Create a demo company'

  return (
    <Panel
      id={id}
      title="Create a demo company"
      subtitle="New here? Make a login and an empty company of your own in a minute, then invite your team to try it with you."
      icon="building"
    >
      <form ref={formRef} noValidate onSubmit={submit} aria-busy={busy ? true : undefined} className="flex max-w-[36rem] flex-col gap-4">
        <DemoNotice demo={demo} />
        {pending ? (
          <p className="text-[14.5px] text-ink">
            Signed in as <strong>{email.trim()}</strong>. {pending.name}
            {pending.keepLocal ? ' from this browser' : ''} still needs to reach the server.
          </p>
        ) : (
          <>
            {ownHere && (
              <Callout tone="neutral" title={`This browser holds ${ownHere}`}>
                <p>
                  {useLocal
                    ? `${ownHere} goes to the server as your demo company, under its own name, and syncs from then on.`
                    : `Starting blank replaces ${ownHere} in this browser with the new company. Download a backup first to keep it, or upload it instead.`}
                </p>
                {useLocal && tried && problems.company && (
                  <p className="mt-1 font-semibold text-bad">
                    Its name does not work on the server. {problems.company} Rename it in Settings, Company first.
                  </p>
                )}
                <div className="mt-3 flex flex-col gap-2">
                  <Checkbox checked={keepLocal} onChange={setKeepLocal} label={`Upload ${ownHere} instead of starting blank`} />
                  <div>
                    <Button size="sm" icon="download" onClick={() => downloadBackup()}>
                      Download backup
                    </Button>
                  </div>
                </div>
              </Callout>
            )}
            {!useLocal && (
              <Field
                label="Company name"
                id={ids.company}
                error={tried ? problems.company : null}
                hint={`Shown in the app and on its careers page. ${MAX_COMPANY_NAME_LENGTH} characters at most.`}
              >
                {(fid, described) => (
                  <TextInput
                    id={fid}
                    name="organization"
                    autoComplete="organization"
                    aria-describedby={described}
                    maxLength={MAX_COMPANY_NAME_LENGTH + 20}
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                  />
                )}
              </Field>
            )}
            {!useLocal && (
              <FormGrid>
                <Field label="Your first name" id={ids.first} error={tried ? firstProblem : null}>
                  {(fid, described) => (
                    <TextInput id={fid} autoComplete="given-name" aria-describedby={described} value={firstName} onChange={(e) => setFirstName(e.target.value)} />
                  )}
                </Field>
                <Field label="Your last name" id={ids.last} error={tried ? lastProblem : null}>
                  {(fid, described) => (
                    <TextInput id={fid} autoComplete="family-name" aria-describedby={described} value={lastName} onChange={(e) => setLastName(e.target.value)} />
                  )}
                </Field>
              </FormGrid>
            )}
            <EmailField id={ids.email} value={email} onChange={setEmail} error={tried ? problems.email : null} hint="Your login. One email belongs to one company here." />
            <PasswordField
              id={ids.password}
              label="Password"
              value={password}
              onChange={setPassword}
              error={tried ? problems.password : null}
              hint={`At least ${MIN_PASSWORD_LENGTH} characters. There is no password reset on a demo server, so keep it somewhere safe.`}
            />
            <Checkbox checked={remember} onChange={setRemember} label="Keep me signed in on this device" description={REMEMBER_HINT} />
          </>
        )}
        <FlowError error={error} title={pending ? 'The company is not on the server yet' : 'The demo company was not created'} />
        <BusyNote text={busyText(busy)} />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" size="lg" icon={pending ? 'rotate-ccw' : 'building'} {...busyProps(busy)}>
            {label}
          </Button>
        </div>
      </form>
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------
// The signed-in login's company: name, careers page, invites
// ---------------------------------------------------------------------------------------------

/**
 * The company this login belongs to on the server (a server that holds companies): its name and short
 * name, its careers page when the server serves them (an admin turns it on or off), and, for an admin,
 * invite links for teammates: making one, and the open ones, each of which can be revoked.
 */
export function CompanyPanel({ account }: { account: ServerAccount }) {
  const workspace = account.workspace
  const { busy, run } = useBusy()
  const [invite, setInvite] = useState<{ url: string; expiresAt: string } | null>(null)
  const [error, setError] = useState<{ message: string; n: number; revoking?: boolean } | null>(null)
  const [careersError, setCareersError] = useState<{ message: string; n: number } | null>(null)
  // The company's open links (admins): null until the server answered.
  const [open, setOpen] = useState<OpenInvite[] | null>(null)
  const linkId = `invite-link-${useId().replace(/:/g, '')}`
  const admin = account.role === 'admin'
  const hasWorkspace = workspace !== null

  const loadOpen = useCallback(async () => {
    const res = await listInvites()
    setOpen(res.ok ? res.invites : null)
  }, [])
  useEffect(() => {
    if (admin && hasWorkspace) void loadOpen()
  }, [admin, hasWorkspace, loadOpen])

  if (!workspace) return null

  const make = async () => {
    const res = await run('invite', () => createInvite())
    if (!res) return
    if (res.ok) {
      setError(null)
      setInvite({ url: res.url, expiresAt: res.expiresAt })
      void loadOpen()
      // The new link, selected, so Ctrl C copies it too.
      setTimeout(() => {
        const el = document.getElementById(linkId) as HTMLInputElement | null
        el?.focus()
        el?.select()
      }, 30)
      return
    }
    setError({ message: res.message, n: Date.now() })
  }

  const revoke = async (id: string) => {
    const res = await run('revoke', () => revokeInvite(id))
    if (!res) return
    if (res.ok || res.kind === 'not_found') {
      setError(null)
      toast({ text: res.ok ? 'Invite link revoked. It no longer works.' : res.message })
      // A link shown above may be the one just revoked: it must not be copied any more.
      setInvite(null)
      await loadOpen()
      setTimeout(() => document.getElementById('server-invite-title')?.focus(), 30)
      return
    }
    setError({ message: res.message, n: Date.now(), revoking: true })
  }

  const switchCareers = async (on: boolean) => {
    const res = await run('careers', () => setCareers(on))
    if (!res) return
    if (res.ok) {
      setCareersError(null)
      toast({ text: on ? 'Careers page is public.' : 'Careers page is off. Its link shows nothing now.' })
      return
    }
    setCareersError({ message: res.message, n: Date.now() })
  }

  const copy = async (text: string, what: string) => {
    const ok = await copyText(text)
    toast(ok ? { text: `${what} copied.` } : { text: `Copy did not work here. Select the ${what.toLowerCase()} and copy it.`, tone: 'bad' })
  }

  const careersOn = account.careersEnabled
  return (
    <Panel id="server-company" title={`${workspace.name} on this server`} subtitle={`Signed in as ${account.email}.`} icon="building">
      <div className="flex flex-col gap-5">
        <DescriptionList
          items={[
            { label: 'Company', value: workspace.name },
            { label: 'Short name', value: <span className="font-mono text-[13px]">{workspace.slug || 'none yet'}</span> },
            {
              label: 'Careers page',
              value: !account.careersUrl ? (
                'This server serves no careers pages.'
              ) : careersOn ? (
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <a
                    href={account.careersUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ft-link inline-flex min-h-10 items-center gap-1 font-semibold break-all text-accent underline"
                  >
                    {displayUrl(account.careersUrl)}
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                  <Button size="sm" variant="ghost" icon="copy" onClick={() => void copy(account.careersUrl ?? '', 'Careers page link')}>
                    Copy link
                  </Button>
                </span>
              ) : (
                'Off'
              ),
            },
          ]}
        />
        {account.careersUrl && (
          <div className="flex max-w-[75ch] flex-col gap-2">
            {admin ? (
              <Switch
                checked={careersOn}
                onChange={(on) => {
                  if (!busy) void switchCareers(on)
                }}
                label="Public careers page"
                description={careersSwitchText(careersOn)}
              />
            ) : (
              <p className="text-[13.5px] text-ink-2">{careersSwitchText(careersOn)} Only an admin can change it.</p>
            )}
            {careersOn && (
              <p className="text-[13.5px] text-ink-2">
                Applications arrive in Hiring as new candidates, marked Inbound: Careers site on their cards and in the candidate list.
              </p>
            )}
            <FlowError error={careersError} title="The careers page did not change" />
          </div>
        )}
        <section aria-labelledby="server-invite-title" className="flex flex-col gap-3 border-t border-line pt-4">
          <h3 id="server-invite-title" tabIndex={-1} className="text-[15.5px] font-bold text-ink">
            Invite a teammate
          </h3>
          {admin ? (
            <>
              <p className="max-w-[75ch] text-[14.5px] text-ink-2">
                An invite link works once. Whoever opens it can join {workspace.name} with their own email and password, and then sees and
                changes everything in it, as you do. Send it only to someone you trust with this company's data, and revoke it below if it
                went to the wrong person.
              </p>
              {invite && (
                <div className="flex flex-col gap-2">
                  <Field label="Invite link" id={linkId} hint={inviteExpiryText(invite.expiresAt)}>
                    {(fid, described) => (
                      <div className="flex flex-wrap items-center gap-2">
                        <TextInput
                          id={fid}
                          readOnly
                          aria-describedby={described}
                          className="min-w-0 flex-[1_1_16rem] font-mono text-[13px]"
                          value={invite.url}
                          onFocus={(e) => e.currentTarget.select()}
                        />
                        <Button icon="copy" onClick={() => void copy(invite.url, 'Invite link')}>
                          Copy link
                        </Button>
                      </div>
                    )}
                  </Field>
                </div>
              )}
              <FlowError error={error} title={error?.revoking ? 'The invite link was not revoked' : 'No invite link was created'} />
              <BusyNote text={busy === 'revoke' ? 'Revoking the invite link.' : busyText(busy)} />
              <div>
                <Button variant={invite ? 'secondary' : 'primary'} icon="user-plus" onClick={() => !busy && void make()} {...busyProps(busy)}>
                  {invite ? 'Create another link' : 'Create an invite link'}
                </Button>
              </div>
              {open && open.length > 0 && (
                <div className="flex flex-col gap-2">
                  <h4 className="text-[14.5px] font-semibold text-ink">Open invite links ({open.length})</h4>
                  <ul className="flex flex-col gap-2">
                    {open.map((item, i) => (
                      <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2">
                        <span className="text-[13.5px] text-ink-2">
                          <span className="sr-only">Link {i + 1}. </span>
                          {openInviteText(item)}
                        </span>
                        <ConfirmButton
                          size="sm"
                          icon="x"
                          confirmLabel="Press again to revoke"
                          aria-label={`Revoke invite link ${i + 1}`}
                          onConfirm={() => {
                            if (!busy) void revoke(item.id)
                          }}
                          {...busyProps(busy)}
                        >
                          Revoke
                        </ConfirmButton>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <p className="max-w-[75ch] text-[14.5px] text-ink-2">Only an admin of {workspace.name} can create invite links. Ask one for a link.</p>
          )}
        </section>
      </div>
    </Panel>
  )
}
