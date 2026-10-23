// Ctrl/Cmd+K (or /) quick finder: people, candidates, jobs, contractors, pages and actions (switch the
// look, sync with the server). Results respect the Viewing-as mode. Rows are 48px tall for easy pointing.
import { useEffect, useMemo, useRef, useState } from 'react'
import { canSeeCandidate, canSeeSection, isAdmin, visibleJobs } from '@/domain/access'
import { assistantDisplayName } from '@/domain/assistant'
import { fullName } from '@/domain/people'
import { openAssistant } from '@/features/assistant'
import { useDB } from '@/store/db'
import { usePrefs } from '@/store/prefs'
import { useSyncStatus } from '@/sync'
import { LOOK_LIST } from '@/themes/registry'
import { Avatar, cx, Icon, type IconName, restoreFocus, toast } from '@/ui'
import { OPEN_PALETTE_EVENT, runSyncNow, SERVER_SETTINGS_HREF } from './Header'
import { links } from './router'
import { useViewer, type Viewer } from './useViewer'

/** A result either navigates (href) or runs an action in place (run), such as switching the look. */
type Result = { id: string; label: string; sub?: string; href?: string; run?: () => void; icon?: IconName; avatar?: string; group: string }

/** People tabs follow PeoplePage's rules: Checklists and Time off are hidden in Employee view, Contractors outside Admin. */
const notEmployee = (v: Viewer) => v.role !== 'employee'

const PAGES: Array<{
  label: string
  href: string
  keywords: string
  section: Parameters<typeof canSeeSection>[1]
  /** Extra check for tabs a view hides inside a section it can see. */
  show?: (v: Viewer) => boolean
  /** A second line under the label. */
  sub?: () => string | undefined
}> = [
  { label: 'Home', href: links.home(), keywords: 'inbox tonight dashboard', section: 'home' },
  { label: 'Jobs', href: links.hiring('jobs'), keywords: 'hiring requisitions openings pipeline', section: 'hiring' },
  { label: 'Candidates', href: links.hiring('candidates'), keywords: 'hiring applicants talent pool', section: 'hiring' },
  { label: 'Offers', href: links.hiring('offers'), keywords: 'hiring offer letters approvals', section: 'hiring' },
  { label: 'Interview kits', href: links.hiring('kits'), keywords: 'role templates scorecards questions', section: 'hiring' },
  { label: 'Directory', href: links.people('directory'), keywords: 'people employees team', section: 'people' },
  { label: 'Org chart', href: links.people('org'), keywords: 'people managers reporting', section: 'people' },
  { label: 'First twenty wall', href: links.people('wall'), keywords: 'people seats employee numbers', section: 'people' },
  { label: 'Checklists', href: links.people('checklists'), keywords: 'onboarding offboarding tasks i-9 de 34', section: 'people', show: notEmployee },
  { label: 'Time off', href: links.people('timeoff'), keywords: 'vacation sick leave pto calendar holidays', section: 'people', show: notEmployee },
  { label: 'Contractors and advisors', href: links.people('contractors'), keywords: 'ab5 1099 de 542 w-9', section: 'people', show: isAdmin },
  { label: 'Headcount plan', href: links.comp('plan'), keywords: 'plan quarters roles budget board', section: 'comp' },
  { label: 'Levels and bands', href: links.comp('bands'), keywords: 'pay bands salary ranges levels', section: 'comp' },
  { label: 'Comp table', href: links.comp('table'), keywords: 'salaries compa-ratio pay', section: 'comp' },
  { label: 'Equity', href: links.comp('equity'), keywords: 'options pool grants vesting 409a board consent', section: 'comp' },
  { label: 'Cost and runway', href: links.comp('cost'), keywords: 'run-rate payroll cost runway burn', section: 'comp' },
  { label: 'Pay runs', href: links.comp('payruns'), keywords: 'payroll pay run prep payday cutoff peo gusto adp justworks export csv', section: 'comp' },
  { label: 'Milestones', href: links.compliance('milestones'), keywords: 'compliance thresholds law headcount', section: 'compliance' },
  { label: 'Compliance calendar', href: links.compliance('calendar'), keywords: 'deadlines filings 1099 sb 294', section: 'compliance' },
  { label: 'Training tracker', href: links.compliance('training'), keywords: 'harassment training security awareness', section: 'compliance' },
  { label: 'Notices and policies', href: links.compliance('notices'), keywords: 'handbook acknowledgements posters', section: 'compliance' },
  { label: 'SOC 2 evidence', href: links.compliance('soc2'), keywords: 'audit evidence controls access review', section: 'compliance' },
  { label: 'Records and retention', href: links.compliance('records'), keywords: 'retention personnel file requests', section: 'compliance' },
  { label: 'Me', href: links.me(), keywords: 'my profile my pay my equity my time off', section: 'me' },
  { label: 'Settings: company', href: links.settings('company'), keywords: 'company funding cash runway legal name founded stage soc 2 toggle', section: 'settings' },
  {
    label: 'Settings: org',
    href: links.settings('org'),
    keywords: 'departments locations offices remote states levels job families bands minimum wage',
    section: 'settings',
  },
  {
    label: 'Settings: hiring',
    href: links.settings('hiring'),
    keywords: 'pipeline stages sla response times rejection reasons close-out reasons email templates calendly scheduling link offer defaults referral',
    section: 'settings',
  },
  { label: 'Settings: checklist templates', href: links.settings('templates'), keywords: 'checklists onboarding offboarding templates tasks', section: 'settings' },
  { label: 'Settings: time off policies', href: links.settings('timeoff'), keywords: 'time off policies holidays company holidays sick vacation pto accrual', section: 'settings' },
  { label: 'Settings: rules and rates', href: links.settings('rules'), keywords: 'minimum wage exempt salary law rates rules', section: 'settings' },
  {
    label: 'Settings: link-outs',
    href: links.settings('links'),
    keywords: 'link-outs links payroll peo e-sign benefits drive documents',
    section: 'settings',
  },
  { label: 'Settings: data and backup', href: links.settings('data'), keywords: 'export import backup reset start fresh', section: 'settings' },
  {
    label: 'Server settings',
    href: SERVER_SETTINGS_HREF,
    keywords: 'settings server sync postgres database connect sign in sign out upload disconnect',
    section: 'settings',
    sub: () => (servedByAServer() ? undefined : 'Syncing works when the app is opened from your First Twenty server address'),
  },
]

/**
 * False for the one-file app opened from disk and the published artifact: no First Twenty server can
 * answer at their address, so nothing there may call one (the app never makes cross-origin calls).
 */
function servedByAServer(): boolean {
  if (typeof window === 'undefined') return false
  if (window.location.protocol === 'file:') return false
  try {
    const claude = (window as unknown as { claude?: { use?: unknown } }).claude
    return !(claude && typeof claude === 'object' && claude.use !== undefined)
  } catch {
    return true
  }
}

function score(hay: string, q: string): number {
  const h = hay.toLowerCase()
  if (h.startsWith(q)) return 3
  if (h.split(/\s+/).some((w) => w.startsWith(q))) return 2
  if (h.includes(q)) return 1
  return 0
}

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const look = usePrefs((s) => s.look)
  const syncMode = useSyncStatus((s) => s.mode)
  const syncState = useSyncStatus((s) => s.status)
  const syncHold = useSyncStatus((s) => s.hold)
  // The element that had focus before the palette opened; focus returns there on close.
  const returnTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const h = () => {
      const a = document.activeElement as HTMLElement | null
      if (a && a !== document.body && !a.closest('[aria-label="Search"][role="dialog"]')) returnTo.current = a
      else if (!a || a === document.body) returnTo.current = null
      setOpen(true)
      setQ('')
      setActive(0)
    }
    window.addEventListener(OPEN_PALETTE_EVENT, h)
    return () => window.removeEventListener(OPEN_PALETTE_EVENT, h)
  }, [])

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  const results = useMemo<Result[]>(() => {
    const query = q.trim().toLowerCase()
    const out: Array<Result & { s: number }> = []
    const add = (r: Result, hay: string) => {
      const s = query ? score(hay, query) : 0
      if (!query || s > 0) out.push({ ...r, s })
    }
    for (const p of db.people) {
      add(
        {
          id: p.id,
          label: fullName(p),
          sub: `#${p.hireNumber} · ${p.title}${p.endDate ? ' · alumni' : ''}`,
          href: links.person(p.id),
          avatar: fullName(p),
          group: 'People',
        },
        `${fullName(p)} ${p.firstName} ${p.title}`,
      )
    }
    if (canSeeSection(viewer, 'hiring')) {
      for (const j of visibleJobs(viewer, db)) {
        add({ id: j.id, label: j.title, sub: `Job · ${j.status.replace('_', ' ')}`, href: links.job(j.id), icon: 'briefcase', group: 'Jobs' }, j.title)
      }
      for (const c of db.candidates) {
        if (c.archived || !canSeeCandidate(viewer, db, c.id)) continue
        const name = `${c.firstName} ${c.lastName}`
        add(
          { id: c.id, label: name, sub: `Candidate${c.currentTitle ? ` · ${c.currentTitle}` : ''}`, href: links.candidate(c.id), avatar: name, group: 'Candidates' },
          `${name} ${c.email} ${c.currentCompany ?? ''}`,
        )
      }
    }
    if (isAdmin(viewer)) {
      for (const k of db.contractors) {
        add(
          { id: k.id, label: k.name, sub: `${k.kind === 'advisor' ? 'Advisor' : 'Contractor'} · ${k.scope}`, href: links.contractor(k.id), icon: 'file', group: 'Contractors' },
          `${k.name} ${k.entityName ?? ''} ${k.scope}`,
        )
      }
    }
    for (const pg of PAGES) {
      if (!canSeeSection(viewer, pg.section) || (pg.show && !pg.show(viewer))) continue
      add({ id: pg.href, label: pg.label, sub: pg.sub?.(), href: pg.href, icon: 'arrow-right', group: 'Pages' }, `${pg.label} ${pg.keywords}`)
    }
    // Server sync, only on a browser connected to a server (searched for: "sync", "server", "push"...).
    if (query && syncMode === 'server' && !syncHold) {
      const hay = 'sync now server push pull upload save refresh'
      if (syncState === 'signed_out') {
        add({ id: 'sync-sign-in', label: 'Sign in to your server', sub: 'Changes stay on this device until you sign in', href: SERVER_SETTINGS_HREF, icon: 'lock', group: 'Actions' }, `sign in ${hay}`)
      } else {
        add(
          {
            id: 'sync-now',
            label: 'Sync now',
            sub: syncState === 'offline' ? 'Cannot reach your server. Try again now' : 'Send and fetch changes now',
            run: () => runSyncNow(),
            icon: 'upload',
            group: 'Actions',
          },
          hay,
        )
      }
    }
    // The assistant (Admin view): "ask", "assistant" or its name opens it; any other search can be asked as
    // a question, typed into its box (sorted last).
    if (query && isAdmin(viewer)) {
      const name = assistantDisplayName(db.company)
      const hay = `ask ${name} assistant chat bot ai help question`.toLowerCase()
      const s = score(hay, query)
      if (s > 0 && query.length >= 2 && query.split(/\s+/).length <= 2) {
        out.push({ id: 'ask-assistant', label: `Ask ${name}`, sub: 'Questions about your people, hiring and the rules', run: () => openAssistant(), icon: 'message', group: 'Actions', s })
      } else if (query.length >= 3) {
        out.push({ id: 'ask-assistant', label: `Ask ${name}: "${q.trim()}"`, sub: 'Opens the question, ready to send', run: () => openAssistant(q.trim()), icon: 'message', group: 'Actions', s: 0.01 })
      }
    }
    // Looks (Display menu), only when searched for: "look", "comic", "look trading", "theme" ...
    // Every word of the query must appear, in any order.
    if (query) {
      const words = query.split(/\s+/)
      for (const l of LOOK_LIST) {
        const hay = `look ${l.name} theme style skin appearance display ${l.blurb}`.toLowerCase()
        if (!words.every((w) => hay.includes(w))) continue
        out.push({
          id: `look-${l.id}`,
          label: `Look: ${l.name}`,
          sub: l.id === look ? 'Current look' : l.blurb,
          run: () => {
            usePrefs.getState().setLook(l.id)
            toast({ text: `Look set to ${l.name}`, tone: 'neutral' })
          },
          icon: 'monitor',
          group: 'Display',
          s: words.some((w) => l.name.toLowerCase().split(/[\s-]+/).some((n) => n.startsWith(w))) ? 3 : 1,
        })
      }
    }
    const groupOrder = ['People', 'Candidates', 'Jobs', 'Contractors', 'Pages', 'Actions', 'Display']
    return out
      .sort((a, b) => (query ? b.s - a.s : 0) || groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group))
      .slice(0, query ? 30 : 12)
  }, [q, db, viewer, look, syncMode, syncState, syncHold])

  useEffect(() => setActive(0), [q])
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null

  const close = () => {
    setOpen(false)
    restoreFocus(returnTo.current)
  }

  const go = (r: Result | undefined) => {
    if (!r) return
    setOpen(false)
    // Focus goes back where it was; if the new route removes that element, App moves focus to the page title.
    restoreFocus(returnTo.current)
    if (r.run) r.run()
    else if (r.href) window.location.hash = r.href.slice(1)
  }

  return (
    <div className="fixed inset-0 z-[55] flex items-start justify-center px-4 pt-[10vh]">
      <div className="ft-scrim anim-fade fixed inset-0 bg-[var(--scrim)]" onClick={close} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="ft-palette anim-pop relative flex max-h-[70vh] w-full max-w-[620px] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            // Stop here: a sheet under the palette listens on window and must stay open (with its form).
            e.preventDefault()
            e.stopPropagation()
            close()
          } else if (e.key === 'Tab') {
            // Only the search box takes Tab focus; keep it inside the dialog.
            e.preventDefault()
            inputRef.current?.focus()
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((a) => Math.min(results.length - 1, a + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((a) => Math.max(0, a - 1))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            go(results[active])
          }
        }}
      >
        <div className="ft-palette__head flex items-center gap-3 border-b border-line px-4">
          <Icon name="search" size={19} className="text-ink-3" />
          <input
            ref={inputRef}
            id="palette-input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant={results[active] ? `pr-${active}` : undefined}
            aria-label="Search people, candidates, jobs and pages"
            placeholder="Search people, candidates, jobs and pages"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="ft-palette__input h-14 min-w-0 flex-1 bg-transparent text-[16px] text-ink placeholder:text-ink-3 focus:outline-none"
          />
          <kbd className="ft-kbd rounded border border-line-strong px-1.5 font-mono text-[11px] text-ink-3">Esc</kbd>
        </div>
        <ul ref={listRef} id="palette-results" role="listbox" className="ft-palette__list scroll-thin overflow-y-auto p-2">
          {results.length === 0 && <li className="px-3 py-6 text-center text-[14px] text-ink-3">No matches for "{q}"</li>}
          {results.map((r, i) => {
            const showGroup = i === 0 || results[i - 1].group !== r.group
            return (
              <li key={`${r.group}-${r.id}`}>
                {showGroup && <div className="ft-palette__group eyebrow px-3 pt-2 pb-1">{r.group}</div>}
                <button
                  type="button"
                  id={`pr-${i}`}
                  data-idx={i}
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={() => setActive(i)}
                  onClick={() => go(r)}
                  className={cx(
                    'ft-palette__item',
                    i === active && 'ft-palette__item--active',
                    'flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left',
                    i === active ? 'bg-accent-soft' : 'hover:bg-surface-2',
                  )}
                >
                  {r.avatar ? (
                    <Avatar name={r.avatar} size={28} />
                  ) : (
                    <span className="ft-palette__icon inline-flex h-7 w-7 shrink-0 items-center justify-center text-ink-3">
                      <Icon name={r.icon ?? 'arrow-right'} size={15} />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14.5px] font-semibold text-ink">{r.label}</span>
                    {r.sub && <span className="block truncate text-[12.5px] text-ink-3">{r.sub}</span>}
                  </span>
                  {i === active && <Icon name="arrow-right" size={16} className="text-accent" />}
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
