// Global header: sync status, search, + New, backup age, privacy blur, display options, the shortcut
// sheet and Ask <assistant>. Shown at the top of every page (inside the main column on wide screens). Also
// the shell's notices: preview, sample company and server sync banners.
import { Fragment, type ReactNode, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { daysBetween, fmtDate, fmtDateTime, fmtTime, parseDate, toISODate, today } from '@/lib/dates'
import { copyText, downloadFile } from '@/lib/files'
import { plural } from '@/lib/format'
import { companyStem } from '@/store/backup'
import { sampleIsCurrent, useDB } from '@/store/db'
import { type TextScale, type Theme, usePrefs } from '@/store/prefs'
import {
  describeRecord,
  detectHostContext,
  editsTo,
  moreAloneText,
  type RecordLabel,
  refreshedParts,
  refreshedText,
  refusedText,
  removedTail,
  replacedTail,
  tooLargeManyText,
  tooLargeTail,
  tooLargeText,
} from '@/features/settings/serverLogic'
import { focusServerStep } from '@/features/settings/serverFocus'
import { AskButton } from '@/features/assistant'
import {
  clearRefreshed,
  clearReplacedRemotely,
  clearRestoredRemotely,
  connect,
  type DemoSignup,
  demoSignup,
  discardRejected,
  getReplacedBackup,
  INVITE_ROUTE,
  isServedPage,
  retryRejected,
  STORAGE_FULL_MESSAGE,
  type SyncStatusState,
  type SyncUser,
  syncNow,
  useSyncStatus,
} from '@/sync'
import { LOOKS } from '@/themes/registry'
import { cx, Icon, Kbd, Menu, type MenuItem, Modal, restoreFocus, Segmented, Switch, toast, useTwoStepConfirm } from '@/ui'
import { LookPicker } from './LookPicker'
import { href, links, navigate, useRoute } from './router'
import { keyLabel, useShortcut, useShortcutList } from './shortcuts'
import { useViewer } from './useViewer'

export const OPEN_PALETTE_EVENT = 'ft:open-palette'

export function openPalette() {
  window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT))
}

function NewMenu() {
  const viewer = useViewer()
  const items: MenuItem[] =
    viewer.role === 'admin'
      ? [
          { label: 'Candidate', icon: 'user-plus', onSelect: () => navigate('hiring', 'add') },
          { label: 'Job', icon: 'briefcase', onSelect: () => navigate('hiring', 'new-job') },
          { label: 'Person', icon: 'user', onSelect: () => navigate('people', 'new') },
          { label: 'Contractor or advisor', icon: 'file', onSelect: () => navigate('people', 'contractors', 'new') },
          { label: 'Time off', icon: 'calendar', onSelect: () => navigate('me', 'timeoff', 'request') },
        ]
      : viewer.role === 'manager'
        ? [
            { label: 'Candidate', icon: 'user-plus', onSelect: () => navigate('hiring', 'add') },
            { label: 'Time off', icon: 'calendar', onSelect: () => navigate('me', 'timeoff', 'request') },
          ]
        : [
            { label: 'Time off', icon: 'calendar', onSelect: () => navigate('me', 'timeoff', 'request') },
            { label: 'Refer someone', icon: 'user-plus', onSelect: () => navigate('me', 'roles') },
          ]
  const [open, setOpen] = useState(false)
  useShortcut('n', () => setOpen(true), { description: 'New candidate, job, person or time off', group: 'Anywhere' })
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      label="Create new"
      items={items}
      trigger={(p) => (
        <button
          type="button"
          {...p}
          className="ft-btn ft-btn--primary ft-btn--md ft-newmenu inline-flex h-11 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-[14px] font-bold text-accent-ink shadow-sm hover:bg-accent-hover"
        >
          <Icon name="plus" size={17} />
          New
        </button>
      )}
    />
  )
}

function BackupChip() {
  const meta = useDB((s) => s.db.meta)
  const viewer = useViewer()
  if (viewer.role !== 'admin') return null
  // lastExportedOn is a UTC timestamp; compare by the local calendar day (an evening backup is still today).
  const last = meta.lastExportedOn ? toISODate(parseDate(meta.lastExportedOn)) : undefined
  const age = last ? daysBetween(last, today()) : null
  const stale = age == null || age > 7
  const text = age == null ? 'No backup yet' : age === 0 ? 'Backed up today' : `Backup ${age}d ago`
  return (
    <a
      href={links.settings('data')}
      title={last ? `Last backup ${fmtDate(last)}. Click to back up now.` : 'You have not downloaded a backup yet. Click to back up.'}
      className={cx(
        'ft-backup',
        stale && 'ft-backup--stale',
        'hidden h-10 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-semibold md:inline-flex',
        stale ? 'bg-warn-soft text-warn' : 'bg-surface-2 text-ink-3 hover:text-ink',
      )}
    >
      <Icon name={stale ? 'alert' : 'check'} size={14} className="shrink-0" />
      {text}
    </a>
  )
}

function BlurToggle() {
  const blur = usePrefs((s) => s.privacyBlur)
  const toggle = usePrefs((s) => s.togglePrivacyBlur)
  useShortcut('b', toggle, { description: 'Blur or show pay amounts', group: 'Anywhere' })
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={blur}
      title={blur ? 'Pay amounts are blurred. Press B to show them.' : 'Blur pay amounts for screen sharing (B)'}
      className={cx(
        'ft-iconbtn ft-iconbtn--ghost',
        blur && 'ft-iconbtn--on',
        'inline-flex h-11 w-11 items-center justify-center rounded-lg transition-colors',
        blur ? 'bg-accent-soft text-accent-soft-ink' : 'text-ink-3 hover:bg-surface-2 hover:text-ink',
      )}
    >
      <Icon name={blur ? 'eye-off' : 'eye'} size={19} />
      <span className="sr-only">{blur ? 'Show pay amounts' : 'Blur pay amounts'}</span>
    </button>
  )
}

function DisplayMenu() {
  const [open, setOpen] = useState(false)
  const p = usePrefs()
  const fixedPalette = !LOOKS[p.look].supportsDark
  const themeHintId = `theme-hint-${useId().replace(/:/g, '')}`
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Display: look, text size, theme, motion, shortcuts"
        className="ft-iconbtn ft-iconbtn--ghost inline-flex h-11 w-11 items-center justify-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink"
      >
        <Icon name="monitor" size={19} />
        <span className="sr-only">Display options</span>
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Display" width={600}>
        <div className="flex flex-col gap-5">
          <div>
            <div className="mb-2 text-[13.5px] font-semibold text-ink-2">Look</div>
            <LookPicker />
          </div>
          <div>
            <div className="mb-2 text-[13.5px] font-semibold text-ink-2">Text size</div>
            <Segmented<string>
              label="Text size"
              value={String(p.textScale)}
              onChange={(v) => p.setTextScale(Number(v) as TextScale)}
              options={[
                { value: '1', label: '100%' },
                { value: '1.15', label: '115%' },
                { value: '1.3', label: '130%' },
                { value: '1.5', label: '150%' },
              ]}
            />
          </div>
          <div>
            <div className="mb-2 text-[13.5px] font-semibold text-ink-2">Theme</div>
            <Segmented<Theme>
              label="Theme"
              value={p.theme}
              onChange={p.setTheme}
              disabled={fixedPalette}
              describedBy={fixedPalette ? themeHintId : undefined}
              options={[
                { value: 'system', label: 'Match system' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
            />
            {fixedPalette && (
              <p id={themeHintId} className="mt-1.5 text-[12.5px] text-ink-3">
                This look has its own colors
              </p>
            )}
          </div>
          <div className="flex flex-col divide-y divide-line">
            <Switch
              id="pref-motion"
              checked={p.reducedMotion}
              onChange={p.setReducedMotion}
              label="Reduce motion"
              description="Turns off sliding panels and fades."
            />
            <Switch
              id="pref-shortcuts"
              checked={p.shortcutsOn}
              onChange={p.setShortcutsOn}
              label="Single-key shortcuts"
              description="Keys like N, B, A and R. Turn off if they clash with dictation or switch access. Ctrl K always works."
            />
          </div>
        </div>
      </Modal>
    </>
  )
}

function ShortcutSheet() {
  const [open, setOpen] = useState(false)
  const list = useShortcutList()
  useShortcut('?', () => setOpen(true), { description: 'Show keyboard shortcuts', group: 'Anywhere' })
  const groups = [...new Set(list.map((s) => s.group))]
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Keyboard shortcuts (?)"
        className="ft-iconbtn ft-iconbtn--ghost hidden h-11 w-11 items-center justify-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink sm:inline-flex"
      >
        <span className="font-display text-[17px] font-bold">?</span>
        <span className="sr-only">Keyboard shortcuts</span>
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Keyboard shortcuts" width={560}>
        <div className="flex flex-col gap-5">
          {groups.map((g) => (
            <div key={g}>
              <div className="eyebrow mb-2">{g}</div>
              <ul className="flex flex-col gap-2">
                {[
                  ...new Map(list.filter((s) => s.group === g).map((s) => [`${s.keys}|${s.description}`, s])).values(),
                ].map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-4 text-[14.5px] text-ink">
                    <span>{s.description}</span>
                    <span className="flex gap-1">
                      {keyLabel(s.keys).map((k) => (
                        <kbd
                          key={k}
                          className="ft-kbd inline-flex h-8 min-w-8 items-center justify-center rounded-md border border-line-strong bg-surface-2 px-2 font-mono text-[14px] font-bold text-ink"
                        >
                          {k}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p className="text-[13px] text-ink-3">
            Single-key shortcuts can be turned off in Display. Ctrl K (or /) opens search from anywhere.
          </p>
        </div>
      </Modal>
    </>
  )
}

function SearchButton() {
  useShortcut('mod+k', openPalette, { description: 'Search and jump', group: 'Anywhere' })
  useShortcut('/', openPalette, { description: 'Search and jump', group: 'Anywhere' })
  return (
    // Below md the top bar's Search button opens the same palette, so this field is hidden there.
    <button
      type="button"
      onClick={openPalette}
      className="ft-search hidden h-11 min-w-0 flex-1 items-center gap-2.5 rounded-lg border border-control bg-surface px-3 text-[14px] text-ink-3 transition-colors hover:border-ink-3 hover:text-ink sm:max-w-[420px] md:flex"
    >
      <Icon name="search" size={17} className="shrink-0" />
      <span className="flex-1 truncate text-left">Search people, candidates, jobs</span>
      <span className="hidden gap-0.5 md:inline-flex">
        <Kbd>Ctrl</Kbd>
        <Kbd>K</Kbd>
      </span>
    </button>
  )
}

/** Undo for the newest change, one click away for as long as there is one (no key chord needed). */
function UndoButton() {
  const top = useDB((s) => s.past[s.past.length - 1])
  const ref = useRef<HTMLButtonElement>(null)
  if (!top) return null
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => {
        const self = ref.current
        const hadFocus = !!self && document.activeElement === self
        // The next visible header control, captured before the undo re-renders the row.
        const next = self?.parentElement
          ? Array.from(self.parentElement.querySelectorAll<HTMLElement>('a[href],button:not([disabled])')).find((el) => el !== self && el.offsetParent !== null)
          : undefined
        const r = useDB.getState().undoEntry(top.id)
        // Undoing the last change removes this button: keep keyboard focus in the header, not on <body>.
        if (hadFocus && useDB.getState().past.length === 0) next?.focus()
        toast({ text: r === 'undone' ? `Undid: ${top.label}` : 'That change can no longer be undone.', tone: 'neutral' })
      }}
      title={`Undo: ${top.label} (Ctrl Z)`}
      aria-label={`Undo: ${top.label}`}
      className="ft-btn ft-btn--ghost ft-btn--md ft-undo inline-flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg px-2.5 text-[14px] font-semibold text-ink-2 hover:bg-surface-2 hover:text-ink"
    >
      <Icon name="rotate-ccw" size={18} />
      <span className="hidden lg:inline">Undo</span>
    </button>
  )
}

export function Header() {
  return (
    <div className="ft-header mb-6 flex items-center gap-2">
      <SearchButton />
      <div className="ft-header__actions ml-auto flex items-center gap-1">
        {/* First in the row: the actions are right-aligned, so when its word changes nothing to its right
            moves. Below md the phone top bar shows it instead (Shell), icon only. */}
        <SyncChip className="hidden md:inline-flex" />
        <UndoButton />
        <BackupChip />
        <BlurToggle />
        <DisplayMenu />
        <ShortcutSheet />
        <AskButton />
        <NewMenu />
      </div>
    </div>
  )
}

/** Shown in Hiring manager and Employee views so nobody mistakes the preview for security. */
export function PreviewBanner() {
  const viewer = useViewer()
  const setViewAs = usePrefs((s) => s.setViewAs)
  if (viewer.role === 'admin') return null
  return (
    <div className="ft-banner ft-banner--preview mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-surface-2 px-4 py-2.5 text-[13.5px] text-ink-2">
      <Icon name="eye" size={16} className="shrink-0 text-ink-3" />
      <span className="min-w-0 flex-[1_1_12rem]">
        <strong className="text-ink">Preview, not security.</strong> You are viewing as {viewer.person?.firstName}{' '}
        ({viewer.role === 'manager' ? 'Hiring manager' : 'Employee'}). Anyone using this browser can switch views.
      </span>
      {/* 40px hit area; the negative margins keep the banner as compact as its text. */}
      <button
        type="button"
        onClick={() => setViewAs('admin', null)}
        className="ft-banner__action -my-2.5 -mr-2 ml-auto inline-flex min-h-10 items-center rounded-lg px-2 font-bold text-accent hover:underline"
      >
        Back to Admin
      </button>
    </div>
  )
}

// A First Twenty server at this page's origin, for a browser that is not connected (the sample banner,
// the rail note and the server notice point a new computer, or a founder who started fresh here, at
// it). Asked once per page load: for the sample on any page served over http(s), and for any other
// local workspace only on a page the server served (isServedPage), so the Vite dev server, a file or the
// artifact viewer never probes /api for it (docs/SYNC.md). Signing in or out after that (Settings,
// Server) shows at once: the sync status's user changes, and a sign-in asks again, since only a signed-in
// answer says whether the server is empty. Connecting means the server holds a workspace; disconnecting
// asks again. A demo server (anyone may sign up) says so too, so a visitor who is not signed in is offered
// a company of their own.
/**
 * empty: the server holds no workspace yet (known only when signed in; absent when it could not tell).
 * demoSignup: anyone may create a demo company here (given only while not signed in).
 */
type ServerHere = { signedIn: boolean; empty?: boolean; demoSignup?: DemoSignup }
/** The answer, with the sync status's user when it came (a later change of user is a sign-in or sign-out). */
type ServerAnswer = ServerHere & { user: SyncUser | null }
let serverHere: ServerAnswer | null = null
let serverHereAsked = false
let serverHereAsking = false
let statusWatched = false
const serverHereListeners = new Set<() => void>()

function setServerHere(answer: ServerAnswer | null): void {
  serverHere = answer
  for (const fn of serverHereListeners) fn()
}

/** Asks once per page load (again with `again`: after a sign-in or a disconnect). */
function askServerHere(again = false): void {
  if ((serverHereAsked && !again) || serverHereAsking) return
  serverHereAsked = true
  if (detectHostContext() !== 'web') return
  watchStatus()
  serverHereAsking = true
  // Side by side: whether anyone may sign up is asked once per page load (demoSignup keeps the answer).
  void Promise.all([connect.checkServer(), demoSignup()])
    .then(([res, demo]) => {
      setServerHere(res.ok ? { signedIn: res.signedIn, empty: res.empty, user: useSyncStatus.getState().user, ...(demo ? { demoSignup: demo } : {}) } : null)
    })
    .catch(() => {
      /* nothing answered: the banner stays as it is */
    })
    .finally(() => {
      serverHereAsking = false
    })
}

/**
 * Keeps the answer true to what happens after it: a sign-in (no user before, one now) asks again for
 * whether the server is empty; connecting (an upload, or the server's copy) means the server holds a
 * workspace now; going back to local only (Disconnect) asks again.
 */
function watchStatus(): void {
  if (statusWatched) return
  statusWatched = true
  let { mode, user } = useSyncStatus.getState()
  useSyncStatus.subscribe((s) => {
    const signedIn = user === null && s.user !== null
    const modeChanged = s.mode !== mode
    mode = s.mode
    user = s.user
    if (modeChanged && mode === 'server' && serverHere) setServerHere({ ...serverHere, empty: false })
    if (mode !== 'server' && (modeChanged || signedIn)) askServerHere(true)
  })
}

function subscribeServerHere(fn: () => void): () => void {
  serverHereListeners.add(fn)
  return () => serverHereListeners.delete(fn)
}

/**
 * The server answering at this origin (null: none answered, or nobody asked yet). ask: ask now if this
 * page load has not asked yet (the sample banner, and on a served page the rail note and the server
 * notice). signedIn is the answer until the sync status's user changes: the engine sets a new one on
 * sign-in and clears it on sign-out. empty is known only from an answer given while signed in.
 */
export function useServerHere(ask = false): ServerHere | null {
  const here = useSyncExternalStore(subscribeServerHere, () => serverHere, () => null)
  const user = useSyncStatus((s) => s.user)
  useEffect(() => {
    if (ask) askServerHere()
  }, [ask])
  if (!here) return null
  const signedIn = signedInHere(here, user)
  if (signedIn) return here.signedIn && here.empty !== undefined ? { signedIn, empty: here.empty } : SIGNED_IN_HERE
  return here.demoSignup ? { signedIn: false, demoSignup: here.demoSignup } : SIGNED_OUT_HERE
}

/**
 * Whether this browser is signed in to the server here: the page-load answer, until the sync status's
 * user is no longer the one it had then (a new user after signing in, none after signing out).
 */
export function signedInHere(answer: ServerAnswer, user: SyncUser | null): boolean {
  return user === answer.user ? answer.signedIn : user !== null
}

const SIGNED_IN_HERE: ServerHere = { signedIn: true }
const SIGNED_OUT_HERE: ServerHere = { signedIn: false }

/** Start fresh: on a page with a server, from Settings, Server, so the next step there (sign in, upload) follows. */
const startFreshHref = (server: boolean) => (server ? href('settings', 'server', 'fresh') : links.startFresh())

/** Settings, Server with focus on Create a demo company. */
export const DEMO_SIGNUP_HREF = href('settings', 'server', 'signup')

/**
 * Banner while the sample company is loaded. A browser served by the company's server (a new computer)
 * is pointed at signing in there first: the sample is what every new browser shows until then. A server
 * that is still empty asks for a company instead: Start fresh (which then uploads) or Import a backup.
 * A demo server (anyone may sign up) offers a first-time visitor a demo company of their own first. Not
 * on the invite page, which has its own next step.
 */
export function SampleBanner() {
  const meta = useDB((s) => s.db.meta)
  const company = useDB((s) => s.db.company.name)
  const viewer = useViewer()
  const local = useSyncStatus((s) => s.mode !== 'server')
  const inviting = useRoute().view === INVITE_ROUTE
  const shown = meta.sample && viewer.role === 'admin' && !inviting
  const server = useServerHere(shown && local)
  if (!shown) return null
  const here = local ? server : null
  const empty = !!here?.signedIn && here.empty === true
  const demo = !!here && !here.signedIn && !!here.demoSignup
  // Only loadSample moves the dates; a saved or uploaded sample keeps the ones it had then.
  const current = sampleIsCurrent({ meta })
  // 40px hit areas; the negative margins keep the banner as compact as its text.
  const action = 'ft-banner__action inline-flex min-h-10 items-center rounded-lg px-2 font-bold underline'
  return (
    <div className="ft-banner ft-banner--sample mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-accent-soft px-4 py-1.5 text-[13.5px] text-accent-soft-ink sm:py-2.5">
      <span className="min-w-0 flex-[1_1_8rem] sm:hidden">
        Sample company: <strong>{company}</strong>
        {here &&
          (demo
            ? '. Make a demo company of your own to try it.'
            : empty
              ? '. Your server is empty.'
              : here.signedIn
                ? '. Your server is here.'
                : '. Sign in to your server to get started.')}
      </span>
      <span className="hidden min-w-0 flex-[1_1_12rem] sm:inline">
        You are exploring <strong>{company}</strong>, a fictional sample company.{' '}
        {here
          ? demo
            ? 'This page is served by a First Twenty demo server: create a demo company of your own to try it with your team, or sign in to yours.'
            : empty
              ? 'Your server is empty. Start fresh or import a backup, then upload it.'
              : here.signedIn
                ? "This page is served by your company's server, and you are signed in. Open your workspace from it."
                : "This page is served by your company's server. Sign in to your server to get started."
          : current
            ? 'Its dates move with the calendar so the story stays current.'
            : local
              ? 'This saved copy keeps its dates; reset the sample in Settings, Data for current dates.'
              : 'This saved copy keeps its dates.'}
      </span>
      <span className="-my-1.5 -mr-2 ml-auto flex flex-wrap items-center gap-x-1 sm:-my-2.5">
        {demo && (
          <a href={DEMO_SIGNUP_HREF} className={action}>
            <span className="sm:hidden">Create a company</span>
            <span className="hidden sm:inline">Create your own demo company</span>
          </a>
        )}
        {here &&
          (empty ? (
            // Lands on the Import panel; a finished import goes back to Settings, Server to upload it.
            <a href={href('settings', 'data', 'import')} className={action}>
              <span className="sm:hidden">Import</span>
              <span className="hidden sm:inline">Import a backup</span>
            </a>
          ) : (
            <a href={SERVER_SETTINGS_HREF} onClick={stayOnServerPage} className={action}>
              {here.signedIn ? (
                <>
                  <span className="sm:hidden">Open it</span>
                  <span className="hidden sm:inline">Open your server's workspace</span>
                </>
              ) : (
                <>
                  <span className="sm:hidden">Sign in</span>
                  <span className="hidden sm:inline">Sign in to your server</span>
                </>
              )}
            </a>
          ))}
        {/* Opens the Start fresh sheet directly. */}
        <a href={startFreshHref(!!here)} className={action}>
          <span className="sm:hidden">Start fresh</span>
          <span className="hidden sm:inline">Start fresh as a solo founder</span>
        </a>
      </span>
    </div>
  )
}

// Not connected, on a page the server served: the workspace lives in this browser only. A founder who
// started fresh (or imported) here keeps a pointer to the server, until they connect or dismiss it.
const SERVER_HINT_KEY = 'first-twenty:server-hint-dismissed:v1'

function serverHintDismissed(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(SERVER_HINT_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * A notice for a workspace of the company's own (not the sample) that lives only in this browser while
 * the server this page came from answers: signed out (sign in to keep it there) or signed in with an empty
 * server (upload it). Dismissed once per browser.
 */
export function ServerHereBanner() {
  const sample = useDB((s) => s.db.meta.sample)
  const viewer = useViewer()
  const local = useSyncStatus((s) => s.mode !== 'server')
  const inviting = useRoute().view === INVITE_ROUTE
  const shown = !sample && viewer.role === 'admin' && local && !inviting
  const here = useServerHere(shown && isServedPage())
  const [dismissed, setDismissed] = useState(serverHintDismissed)
  if (!shown || !here || dismissed) return null
  const empty = here.signedIn && here.empty === true
  // A demo server takes sign-ups: the company can go there under a new login of its own.
  const demo = !here.signedIn && !!here.demoSignup
  if (here.signedIn && !empty) return null
  const dismiss = () => {
    try {
      localStorage.setItem(SERVER_HINT_KEY, '1')
    } catch {
      /* storage blocked: it stays dismissed until the page reloads */
    }
    setDismissed(true)
  }
  return (
    <SyncBanner
      kind="here"
      icon="globe"
      onDismiss={dismiss}
      actions={
        <>
          {demo && (
            <a href={DEMO_SIGNUP_HREF} className={BANNER_ACTION}>
              Create a demo company
            </a>
          )}
          <a href={SERVER_SETTINGS_HREF} onClick={stayOnServerPage} className={BANNER_ACTION}>
            {empty ? 'Upload it' : demo ? 'Sign in' : 'Sign in to your server'}
          </a>
        </>
      }
    >
      {empty
        ? 'This company is saved in this browser only, and your server is empty. Upload it to keep it on your server.'
        : demo
          ? 'This company is saved in this browser only. This demo server can keep it: create a demo company and upload it, or sign in to yours.'
          : 'This company is saved in this browser only. Your server answers at this address: sign in to keep the company there.'}
    </SyncBanner>
  )
}

// ------------------------------------------------------------------------------------------------
// Server sync: header chip and banners (docs/SYNC.md). They read useSyncStatus only; nothing here
// talks to a server except Sync now and Retry, and only on a connected browser (the engine calls
// its own origin). A browser that never connected (mode 'local', including the one-file app and the
// published copy) shows none of it.
// ------------------------------------------------------------------------------------------------

/** Settings > Server. */
export const SERVER_SETTINGS_HREF = href('settings', 'server')

/**
 * onClick for a link to Settings > Server: on that page already (Start fresh lands there), following the
 * link would do nothing, so focus moves to where the next step starts (the sign-in form, Upload) instead.
 */
function stayOnServerPage(e: { preventDefault: () => void }): void {
  if (window.location.hash !== SERVER_SETTINGS_HREF) return
  if (focusServerStep()) e.preventDefault()
}

/** How long the server must stay unreachable before the offline banner appears. */
const OFFLINE_BANNER_MS = 60_000

type ChipKind = 'synced' | 'syncing' | 'offline' | 'signed-out' | 'attention' | 'paused'

const CHIP_WORD: Record<ChipKind, string> = {
  synced: 'Synced',
  syncing: 'Syncing',
  offline: 'Offline',
  'signed-out': 'Signed out',
  attention: 'Needs attention',
  paused: 'Paused',
}

/** The words a chip flips between on every edit and on a flaky connection: they share one width. */
const STEADY_WORDS: ChipKind[] = ['synced', 'syncing', 'offline']

/** "Last synced today at 2:14 PM" (real time: syncs happen now, whatever the demo clock says). */
export function lastSyncedText(at: string | null): string {
  const d = at ? new Date(at) : null
  if (!at || !d || Number.isNaN(d.getTime())) return 'Not synced yet'
  const now = new Date()
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (d.toDateString() === now.toDateString()) return `Last synced today at ${fmtTime(at)}`
  if (d.toDateString() === yesterday.toDateString()) return `Last synced yesterday at ${fmtTime(at)}`
  return `Last synced ${fmtDateTime(at)}`
}

type SyncView = { kind: ChipKind; tip: string }

type ChipInput = Pick<SyncStatusState, 'status' | 'mode' | 'pending' | 'rejected' | 'lastSyncAt' | 'lastError' | 'hold' | 'user'> &
  Partial<Pick<SyncStatusState, 'logoutPending' | 'pendingEdits' | 'rejectedKeys' | 'signedOutByUser'>>

/** Said after a sign-out the server could not confirm (the chip tip and the signed-out notice). */
const SESSION_STAYS_OPEN = "Your server's session stays open until this browser reaches it again."

/**
 * Signed out: a sign-out the user chose says so; a session that ended on its own (the browser closed, the
 * 12-hour limit) says that, as Settings, Server does. Plus the open-session note when the server could not
 * confirm a sign-out.
 */
export function signedOutText(s: { signedOutByUser?: boolean; logoutPending?: boolean }): string {
  const said = s.signedOutByUser
    ? 'You signed out of your server. Changes stay on this device until you sign in again.'
    : 'Your session on your server ended. Changes stay on this device until you sign in again.'
  return s.logoutPending ? `${said} ${SESSION_STAYS_OPEN}` : said
}

/** What the chip says, or null when this browser is not connected (a local install shows nothing). */
export function syncView(s: ChipInput): SyncView | null {
  if (s.mode !== 'server') return null
  const last = `${lastSyncedText(s.lastSyncAt)}.`
  // Counts show edits, not the activity rows each edit also writes.
  const edits = s.pendingEdits ?? s.pending
  const waiting =
    s.pending > 0 ? (edits > 0 ? ` ${plural(edits, 'change')} ${edits === 1 ? 'waits' : 'wait'} on this device.` : ' Changes wait on this device.') : ''
  if (s.hold === 'sample') {
    return { kind: 'paused', tip: `Syncing is paused while the sample company is open. Undo to go back to your workspace and resume. ${last}` }
  }
  if (s.hold === 'demo_clock') {
    return {
      kind: 'paused',
      tip: `Syncing is paused while the app pretends today is another day. Go back to the real date in Settings, Data to resume. ${last}`,
    }
  }
  if (s.hold === 'server_empty') {
    return {
      kind: 'attention',
      tip: `Syncing is paused: your server has no workspace. Upload this browser's workspace or disconnect in Server settings. ${last}`,
    }
  }
  if (s.hold === 'replaced') {
    return {
      kind: 'attention',
      tip: `Syncing is paused: this browser's workspace was replaced and never uploaded. Choose which copy to keep in Server settings. ${last}`,
    }
  }
  switch (s.status) {
    case 'signed_out':
      return { kind: 'signed-out', tip: `${signedOutText(s)}${waiting} ${last}` }
    case 'offline':
      return { kind: 'offline', tip: `Cannot reach your server. Changes sync when the connection returns.${waiting} ${last}` }
    case 'error':
      return { kind: 'attention', tip: `${s.lastError ?? 'Syncing stopped. It retries on its own.'}${waiting} ${last}` }
    case 'syncing':
      return {
        kind: 'syncing',
        tip: s.pending > 0 ? `Sending ${edits > 0 ? plural(edits, 'change') : 'changes'} to your server. ${last}` : `Catching up with your server. ${last}`,
      }
    default:
      if (s.rejected > 0) {
        // A change too large to sync was never sent: the server did not refuse it.
        const tooLarge = s.rejectedKeys?.filter((r) => r.tooLarge).length ?? 0
        const refused = s.rejected - tooLarge
        const said = [
          refused > 0 && `The server refused ${plural(refused, 'change')}.`,
          tooLarge > 0 && `${plural(tooLarge, 'change is', 'changes are')} too large to sync.`,
        ]
          .filter(Boolean)
          .join(' ')
        return { kind: 'attention', tip: `${said} ${s.rejected === 1 ? 'It is' : 'They are'} kept on this device. ${last}` }
      }
      return { kind: 'synced', tip: `Every change is on your server${s.user ? ` (signed in as ${s.user.email})` : ''}. ${last}` }
  }
}

// A cloud for the connection states; the kit's lock and alert shapes for the ones that need a hand.
const CLOUD = 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z'
const GLYPH: Record<ChipKind, string> = {
  synced: `${CLOUD}M8.6 13.4l2.1 2.1 4-4`,
  syncing: `${CLOUD}M11.5 17v-6M9 13.5 11.5 11l2.5 2.5`,
  offline: `${CLOUD}M3 3l18 18`,
  paused: `${CLOUD}M10 12v4M13.5 12v4`,
  'signed-out': 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  attention: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0M12 9v4M12 17h.01',
}

const CHIP_TONE: Record<ChipKind, string> = {
  synced: 'text-good',
  syncing: 'text-ink-3',
  offline: 'text-warn',
  'signed-out': 'text-warn',
  attention: 'text-bad',
  paused: 'text-ink-3',
}

/**
 * Sync status: a word and an icon (plus how many changes wait) that opens Server settings. compact
 * keeps only the icon and the count on screen (the phone top bar); the word stays in the accessible
 * name. The tooltip (also the description) tells when this browser last synced.
 */
export function SyncChip({ compact, className }: { compact?: boolean; className?: string }) {
  const status = useSyncStatus((s) => s.status)
  const mode = useSyncStatus((s) => s.mode)
  const pending = useSyncStatus((s) => s.pending)
  const pendingEdits = useSyncStatus((s) => s.pendingEdits)
  const rejected = useSyncStatus((s) => s.rejected)
  const lastSyncAt = useSyncStatus((s) => s.lastSyncAt)
  const lastError = useSyncStatus((s) => s.lastError)
  const hold = useSyncStatus((s) => s.hold)
  const user = useSyncStatus((s) => s.user)
  const logoutPending = useSyncStatus((s) => s.logoutPending)
  const signedOutByUser = useSyncStatus((s) => s.signedOutByUser)
  const rejectedKeys = useSyncStatus((s) => s.rejectedKeys)
  const tipId = `sync-tip-${useId().replace(/:/g, '')}`
  const view = syncView({ status, mode, pending, pendingEdits, rejected, rejectedKeys, lastSyncAt, lastError, hold, user, logoutPending, signedOutByUser })
  if (!view) return null
  const word = CHIP_WORD[view.kind]
  const steady = STEADY_WORDS.includes(view.kind)
  return (
    <a
      href={SERVER_SETTINGS_HREF}
      onClick={stayOnServerPage}
      title={view.tip}
      aria-describedby={tipId}
      className={cx(
        'ft-syncchip',
        `ft-syncchip--${view.kind}`,
        compact && 'ft-syncchip--compact',
        'h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-line bg-surface text-[13px] font-semibold whitespace-nowrap text-ink-2 transition-colors hover:border-line-strong hover:text-ink',
        // Compact: a fixed 44px square (the count is a corner badge), so the top bar never changes width.
        compact ? 'relative w-11 px-0' : 'px-3',
        className ?? 'inline-flex',
      )}
    >
      <svg
        width={17}
        height={17}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={cx('ft-syncchip__icon shrink-0', CHIP_TONE[view.kind])}
        data-icon={`sync-${view.kind}`}
        aria-hidden
        focusable="false"
      >
        <path d={GLYPH[view.kind]} />
      </svg>
      <span className="sr-only">Sync status: </span>
      {compact ? (
        <span className="sr-only">{word}</span>
      ) : steady ? (
        // Synced, Syncing and Offline stack in one cell, so the chip keeps one width while they swap.
        <span className="ft-syncchip__label grid">
          {STEADY_WORDS.map((k) => (
            <span key={k} className={cx('col-start-1 row-start-1', k !== view.kind && 'invisible')} aria-hidden={k !== view.kind || undefined}>
              {CHIP_WORD[k]}
            </span>
          ))}
        </span>
      ) : (
        <span className="ft-syncchip__label">{word}</span>
      )}
      {pendingEdits > 0 && (
        <span
          className={cx(
            'ft-syncchip__count ft-count num inline-flex items-center justify-center rounded-full bg-surface-2 font-bold text-ink',
            compact ? 'absolute top-0.5 right-0.5 h-4 min-w-4 px-1 text-[10.5px] leading-none' : 'h-5 min-w-5 px-1.5 text-[12px]',
          )}
        >
          {pendingEdits > 999 ? '999+' : pendingEdits}
          <span className="sr-only"> {pendingEdits === 1 ? 'change waiting' : 'changes waiting'}</span>
        </span>
      )}
      <span id={tipId} hidden>
        {view.tip}
      </span>
    </a>
  )
}

/** 'here' is the server notice for a browser that is not connected (ServerHereBanner), outside SyncBanners. */
type BannerKind = 'storage' | 'replaced' | 'restored' | 'signed-out' | 'offline' | 'rejected' | 'paused' | 'refreshed' | 'here'

/** Top to bottom. */
const BANNER_ORDER: BannerKind[] = ['storage', 'replaced', 'restored', 'signed-out', 'offline', 'rejected', 'paused', 'refreshed']

/**
 * Notices that are role=alert: screen readers speak an alert when it appears with its text. The others
 * are spoken through the one live region SyncBanners keeps mounted (a polite region that enters the page
 * together with its text is often not announced).
 */
const ALERT_BANNERS: ReadonlySet<BannerKind> = new Set(['storage', 'replaced'])

/** One sync notice. Dismissing moves focus to the next notice's first control, else the page title. */
function SyncBanner({
  kind,
  icon,
  alert,
  children,
  actions,
  onDismiss,
}: {
  kind: BannerKind
  icon: 'alert' | 'lock' | 'info' | 'globe'
  alert?: boolean
  children: ReactNode
  actions?: ReactNode
  onDismiss?: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const dismiss = () => {
    const el = ref.current
    const hadFocus = !!el && el.contains(document.activeElement)
    let next: HTMLElement | null = null
    for (let sib = el?.nextElementSibling; sib && !next; sib = sib.nextElementSibling) {
      if (sib.classList.contains('ft-banner')) next = sib.querySelector<HTMLElement>('a[href],button:not([disabled])')
    }
    onDismiss?.()
    if (hadFocus) restoreFocus(null, () => next)
  }
  const warn = kind === 'storage' || kind === 'rejected' || kind === 'paused' || kind === 'replaced'
  return (
    <div
      ref={ref}
      role={alert ? 'alert' : undefined}
      className={cx(
        'ft-banner ft-banner--sync',
        `ft-banner--sync-${kind}`,
        // Storage full is the browser storage warning again, so every look's storage style applies too.
        kind === 'storage' && 'ft-banner--storage',
        'mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-4 py-2.5 text-[13.5px]',
        warn ? 'border-line-strong bg-warn-soft text-ink' : 'border-line bg-surface-2 text-ink-2',
      )}
    >
      {/* Icon and text stay side by side when the actions wrap under them (phones, large text). */}
      <span className="flex min-w-0 flex-[1_1_14rem] items-start gap-3">
        <Icon name={icon} size={16} className={cx('ft-banner__icon mt-0.5 shrink-0', warn ? 'text-warn' : 'text-ink-3')} />
        <span className="ft-banner__text min-w-0 flex-1">{children}</span>
      </span>
      {(actions || onDismiss) && (
        // 40px hit areas; the negative margins keep the banner as compact as its text.
        <span className="ft-banner__actions -my-2 -mr-2 ml-auto flex flex-wrap items-center gap-x-1">
          {actions}
          {onDismiss && (
            <button
              type="button"
              onClick={dismiss}
              title="Dismiss"
              className="ft-iconbtn ft-iconbtn--ghost ft-banner__dismiss inline-flex h-10 w-10 items-center justify-center rounded-lg text-ink-3 hover:bg-surface hover:text-ink"
            >
              <Icon name="x" size={16} />
              <span className="sr-only">Dismiss</span>
            </button>
          )}
        </span>
      )}
    </div>
  )
}

const BANNER_ACTION = 'ft-banner__action inline-flex min-h-10 items-center rounded-lg px-2 font-bold text-accent hover:underline'

/** A banner action that cannot be undone asks for a second click first, as ConfirmButton does (no timer). */
function BannerConfirm({ children, confirmLabel, onConfirm }: { children: ReactNode; confirmLabel: string; onConfirm: () => void }) {
  const { armed, ref, onClick, onBlur } = useTwoStepConfirm<HTMLButtonElement>(onConfirm)
  return (
    <button ref={ref} type="button" aria-live="polite" onBlur={onBlur} onClick={onClick} className={BANNER_ACTION}>
      {armed ? confirmLabel : children}
    </button>
  )
}

/**
 * A record named in a notice: a link to it when it has a page. The link sits inside a sentence, so its
 * vertical padding (which moves no text) gives it a 40px hit area.
 */
function RecordName({ name, capital }: { name: RecordLabel; capital?: boolean }) {
  const label = capital ? name.label.charAt(0).toUpperCase() + name.label.slice(1) : name.label
  return name.href ? (
    <a href={name.href} className="py-3 font-bold text-accent underline">
      {label}
    </a>
  ) : (
    <>{label}</>
  )
}

/** "A, B and 2 more", with links. */
function NamedList({ names, more }: { names: RecordLabel[]; more: number }) {
  return (
    <>
      {names.map((n, i) => (
        <Fragment key={`${i}-${n.label}`}>
          {i === 0 ? '' : i === names.length - 1 && more === 0 ? ' and ' : ', '}
          <RecordName name={n} />
        </Fragment>
      ))}
      {more > 0 && ` and ${more} more`}
    </>
  )
}

/**
 * Sync now, after the user asked (the palette, the notices): says it started and how it went. The
 * engine keeps retrying on its own either way.
 */
export function runSyncNow(startText = 'Syncing with your server') {
  toast({ text: startText, tone: 'neutral' })
  void syncNow().then(() => {
    const s = useSyncStatus.getState()
    // Changes too large to sync are never sent, so they are not "refused again".
    const refused = s.rejected - s.rejectedKeys.filter((r) => r.tooLarge).length
    if (s.status === 'synced' && refused > 0) {
      toast({ text: `The server refused ${plural(refused, 'change')} again. ${refused === 1 ? 'It is' : 'They are'} kept on this device.`, tone: 'bad' })
    } else if (s.status === 'synced') toast({ text: 'Synced with your server', tone: 'good' })
    else if (s.status !== 'syncing') toast({ text: s.lastError ?? 'Sync did not finish. It tries again on its own.', tone: 'bad' })
  })
}

/** The workspace shown before another computer replaced the server's, as backup JSON (Import reads it). */
function replacedBackupJSON(): { name: string; json: string } | null {
  const db = getReplacedBackup()
  if (!db) return null
  return { name: `${companyStem(db.company?.name ?? '')}-backup-before-replace-${today()}.json`, json: JSON.stringify(db, null, 2) }
}

function downloadReplacedBackup() {
  const file = replacedBackupJSON()
  if (!file) {
    toast({ text: 'That copy is gone (the page was reloaded). Nothing to download.', tone: 'bad' })
    return
  }
  const ok = downloadFile(file.name, file.json, 'application/json;charset=utf-8')
  toast(
    ok
      ? { text: 'Backup of what was here downloaded. Import it in Settings, Data to see it again.' }
      : { text: 'This browser blocked the download. Use Copy backup instead.', tone: 'bad' },
  )
}

async function copyReplacedBackup() {
  const file = replacedBackupJSON()
  if (!file) {
    toast({ text: 'That copy is gone (the page was reloaded). Nothing to copy.', tone: 'bad' })
    return
  }
  const ok = await copyText(file.json)
  toast(ok ? { text: 'Backup JSON copied. Paste it into a file you keep somewhere safe.' } : { text: 'Copy was blocked by the browser.', tone: 'bad' })
}

/** True while the storage-full sync banner shows (changes that have not reached the server cannot be saved). */
export function useSyncStorageWarning(): boolean {
  const mode = useSyncStatus((s) => s.mode)
  const hold = useSyncStatus((s) => s.hold)
  const full = useSyncStatus((s) => s.storageFull)
  const waiting = useSyncStatus((s) => s.pending + s.rejected > 0)
  return mode === 'server' && hold !== 'sample' && full && waiting
}

/**
 * Notices about the server connection, under the header: browser storage full, the server's workspace
 * replaced from another computer (or by another copy of this one), signed out, the server unreachable
 * for more than a minute, changes the server refused (or too large to sync), a paused connection, and
 * server copies that won over this device's edits (named, with links). Never in a local install, and
 * never while the sample company is open.
 */
export function SyncBanners() {
  const status = useSyncStatus((s) => s.status)
  const mode = useSyncStatus((s) => s.mode)
  const pendingEdits = useSyncStatus((s) => s.pendingEdits)
  const rejected = useSyncStatus((s) => s.rejected)
  const rejectedKeys = useSyncStatus((s) => s.rejectedKeys)
  const hold = useSyncStatus((s) => s.hold)
  const refreshed = useSyncStatus((s) => s.refreshed)
  const refreshedKeys = useSyncStatus((s) => s.refreshedKeys)
  const logoutPending = useSyncStatus((s) => s.logoutPending)
  const signedOutByUser = useSyncStatus((s) => s.signedOutByUser)
  const replaced = useSyncStatus((s) => s.replacedRemotely)
  const restored = useSyncStatus((s) => s.restoredRemotely)
  const db = useDB((s) => s.db)
  const storageWarning = useSyncStorageWarning()
  const [offlineSince, setOfflineSince] = useState<number | null>(null)
  const [offlineLong, setOfflineLong] = useState(false)
  const [dismissed, setDismissed] = useState<ReadonlySet<BannerKind>>(() => new Set())
  const [spoken, setSpoken] = useState('')
  const shownBefore = useRef<ReadonlySet<BannerKind>>(new Set())
  const connected = mode === 'server' && hold !== 'sample'

  // The engine stays 'offline' through its retries; the banner waits a minute so a blip says nothing.
  useEffect(() => {
    if (status !== 'offline') {
      setOfflineSince(null)
      setOfflineLong(false)
      return
    }
    const since = offlineSince ?? Date.now()
    if (offlineSince === null) setOfflineSince(since)
    const t = setTimeout(() => setOfflineLong(true), Math.max(0, since + OFFLINE_BANNER_MS - Date.now()))
    return () => clearTimeout(t)
  }, [status, offlineSince])

  const showing: Record<Exclude<BannerKind, 'here'>, boolean> = {
    storage: connected && storageWarning,
    replaced: connected && replaced !== null,
    restored: connected && restored !== null && replaced === null,
    'signed-out': connected && status === 'signed_out',
    offline: connected && status === 'offline' && offlineLong,
    rejected: connected && rejected > 0,
    paused: connected && (hold === 'server_empty' || hold === 'replaced'),
    refreshed: connected && refreshed > 0,
  }
  // A dismissed notice comes back the next time its condition starts again (the next time offline...).
  const ended = [...dismissed].filter((k) => k === 'here' || !showing[k]).join(' ')
  useEffect(() => {
    if (!ended) return
    const gone = ended.split(' ')
    setDismissed((d) => new Set([...d].filter((k) => !gone.includes(k))))
  }, [ended])

  const visible = (k: Exclude<BannerKind, 'here'>) => showing[k] && !dismissed.has(k)
  const dismiss = (k: BannerKind) => () => setDismissed((d) => new Set(d).add(k))

  // Named records: the newest ones the server's copy replaced (or removed), and the changes too large to sync.
  const named = refreshedParts(db, refreshed, refreshedKeys)
  const tooLarge = rejectedKeys.filter((r) => r.tooLarge)
  const refusedCount = rejected - tooLarge.length
  const oneTooLarge = tooLarge.length === 1 ? { ref: tooLarge[0], name: describeRecord(db, tooLarge[0].collection, tooLarge[0].id) } : null
  const discardTooLarge = () => {
    void discardRejected(tooLarge.map((r) => ({ collection: r.collection, id: r.id }))).then((res) =>
      toast(
        res.ok
          ? { text: tooLarge.length === 1 ? 'Change discarded. This browser shows what your server has.' : 'Changes discarded. This browser shows what your server has.' }
          : { text: res.message, tone: 'bad' },
      ),
    )
  }

  // What each notice says, also spoken through the live region below when it appears.
  const text: Record<Exclude<BannerKind, 'here'>, string> = {
    storage: STORAGE_FULL_MESSAGE,
    replaced: replaced
      ? `Your server's workspace was replaced from another computer. This browser now shows ${replaced.companyName || 'another workspace'}.`
      : '',
    restored:
      "Your server's workspace was replaced with another copy of it, from a backup or from another computer. Changes made after that copy was taken may be gone.",
    'signed-out': signedOutText({ signedOutByUser, logoutPending }),
    offline:
      pendingEdits > 0
        ? `Cannot reach your server. ${plural(pendingEdits, 'change')} will sync when it is reachable again.`
        : 'Cannot reach your server. Changes will sync when it is reachable again.',
    rejected: [
      oneTooLarge
        ? tooLargeText(oneTooLarge.name, oneTooLarge.ref.collection)
        : tooLarge.length > 1
          ? tooLargeManyText(tooLarge.length, tooLarge.map((r) => r.collection))
          : '',
      refusedCount > 0 ? refusedText(refusedCount) : '',
    ]
      .filter(Boolean)
      .join(' '),
    paused:
      hold === 'server_empty'
        ? "Syncing is paused: your server has no workspace. Upload this browser's workspace or disconnect."
        : "Syncing is paused: this browser's workspace was replaced and never uploaded. Choose which copy to keep.",
    refreshed: refreshedText(db, refreshed, refreshedKeys),
  }
  const textRef = useRef(text)
  textRef.current = text

  // Speak a notice when it appears (cleared first, set on the next frame, so a repeat is spoken again).
  const visibleKey = BANNER_ORDER.filter((k) => k !== 'here' && visible(k)).join(' ')
  useEffect(() => {
    const now = new Set(visibleKey ? (visibleKey.split(' ') as BannerKind[]) : [])
    const fresh = BANNER_ORDER.filter((k): k is Exclude<BannerKind, 'here'> => k !== 'here' && now.has(k) && !shownBefore.current.has(k) && !ALERT_BANNERS.has(k))
    shownBefore.current = now
    if (fresh.length === 0) return
    const say = fresh.map((k) => textRef.current[k]).join(' ')
    setSpoken('')
    // Not cancelled when the notices change again within the frame: the sentence must still be spoken.
    requestAnimationFrame(() => setSpoken(say))
  }, [visibleKey])
  // Emptied again once spoken, so a reader browsing the page never meets an old notice there.
  useEffect(() => {
    if (!spoken) return
    const t = setTimeout(() => setSpoken(''), 10_000)
    return () => clearTimeout(t)
  }, [spoken])

  const syncNowButton = (
    <button type="button" onClick={() => runSyncNow()} className={BANNER_ACTION}>
      Sync now
    </button>
  )

  return (
    <>
      {/* Always mounted, so screen readers hear the notices that appear below. */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {spoken}
      </div>
      {visible('storage') && (
        <SyncBanner kind="storage" icon="alert" alert actions={syncNowButton}>
          {text.storage}
        </SyncBanner>
      )}
      {visible('replaced') && replaced && (
        <SyncBanner
          kind="replaced"
          icon="alert"
          alert
          onDismiss={clearReplacedRemotely}
          actions={
            <>
              <button type="button" onClick={downloadReplacedBackup} className={BANNER_ACTION}>
                Download backup
              </button>
              <button type="button" onClick={() => void copyReplacedBackup()} className={BANNER_ACTION}>
                Copy backup
              </button>
            </>
          }
        >
          {text.replaced} Download a backup of what was here{replaced.previousName ? ` (${replaced.previousName})` : ''}? Dismissing this notice lets
          the copy go.
        </SyncBanner>
      )}
      {visible('restored') && (
        <SyncBanner kind="restored" icon="info" onDismiss={clearRestoredRemotely}>
          {text.restored}
        </SyncBanner>
      )}
      {visible('signed-out') && (
        <SyncBanner
          kind="signed-out"
          icon="lock"
          onDismiss={dismiss('signed-out')}
          actions={
            <a href={SERVER_SETTINGS_HREF} onClick={stayOnServerPage} className={BANNER_ACTION}>
              Sign in
            </a>
          }
        >
          {text['signed-out']}
        </SyncBanner>
      )}
      {visible('offline') && (
        <SyncBanner kind="offline" icon="globe" onDismiss={dismiss('offline')} actions={syncNowButton}>
          {text.offline}
        </SyncBanner>
      )}
      {visible('rejected') && (
        <SyncBanner
          kind="rejected"
          icon="alert"
          onDismiss={dismiss('rejected')}
          actions={
            <>
              {/* Retrying cannot help a change too large to sync: it is shortened or discarded instead. */}
              {refusedCount > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    retryRejected()
                    runSyncNow(`Sending ${plural(refusedCount, 'change')} again`)
                  }}
                  className={BANNER_ACTION}
                >
                  Retry
                </button>
              )}
              {tooLarge.length > 0 && (
                <BannerConfirm confirmLabel="Press again to discard" onConfirm={discardTooLarge}>
                  {tooLarge.length === 1 ? 'Discard this change' : 'Discard them'}
                </BannerConfirm>
              )}
              <a href={SERVER_SETTINGS_HREF} onClick={stayOnServerPage} className={BANNER_ACTION}>
                Details
              </a>
            </>
          }
        >
          {oneTooLarge ? (
            <>
              <RecordName name={oneTooLarge.name} capital />
              {tooLargeTail(oneTooLarge.ref.collection)}
              {refusedCount > 0 && ` ${refusedText(refusedCount)}`}
            </>
          ) : (
            text.rejected
          )}
        </SyncBanner>
      )}
      {visible('paused') && (
        <SyncBanner
          kind="paused"
          icon="alert"
          onDismiss={dismiss('paused')}
          actions={
            <a href={SERVER_SETTINGS_HREF} onClick={stayOnServerPage} className={BANNER_ACTION}>
              Review
            </a>
          }
        >
          {text.paused}
        </SyncBanner>
      )}
      {visible('refreshed') && (
        <SyncBanner kind="refreshed" icon="info" onDismiss={clearRefreshed}>
          {named.replaced.length === 0 && named.removed.length === 0 ? (
            text.refreshed
          ) : (
            <>
              {named.replaced.length > 0 && (
                <>
                  {editsTo(named.replaced.length + named.more)} <NamedList names={named.replaced} more={named.more} />
                  {replacedTail(named.replaced.length + named.more)}
                </>
              )}
              {named.removed.length > 0 && (
                // Gone from this browser too: named from its last copy here, with no link.
                <>
                  {named.replaced.length > 0 && ' '}
                  {editsTo(named.removed.length)} <NamedList names={named.removed} more={0} />
                  {removedTail(named.removed.length)}
                </>
              )}
              {named.moreAlone > 0 && ` ${moreAloneText(named.moreAlone)}`}
            </>
          )}
        </SyncBanner>
      )}
    </>
  )
}
