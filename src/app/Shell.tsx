// App frame: left rail (brand, tally headcount meter, nav, Viewing as) on wide screens;
// top bar + menu sheet on phones. The global header sits at the top of the main column.
import type { ReactNode } from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { employeeModeAvailable, hiringManagerModeAvailable, pickablePeople } from '@/domain/access'
import { fullName, headcountOn, incomingOn } from '@/domain/people'
import type { Role } from '@/domain/types'
import { plural } from '@/lib/format'
import { useDB } from '@/store/db'
import { usePrefs } from '@/store/prefs'
import { LOOKS } from '@/themes/registry'
import { Avatar, cx, Icon, rovingKeyDown, rovingTabIndex, Tally, toast, useEscape, useFocusTrap } from '@/ui'
import { isServedPage, takeReloadNotice, useSyncStatus } from '@/sync'
import {
  Header,
  openPalette,
  PreviewBanner,
  SampleBanner,
  ServerHereBanner,
  SyncBanners,
  SyncChip,
  useServerHere,
  useSyncStorageWarning,
} from './Header'
import { activeNavKey, visibleNav } from './nav'
import { links, useRoute } from './router'
import { useViewer } from './useViewer'

function HeadcountBlock({ compact }: { compact?: boolean }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const look = usePrefs((s) => s.look)
  const hc = headcountOn(db)
  const incoming = incomingOn(db).length
  // A look may draw the meter its own way (an odometer, a counter); the number and label above stay.
  const LookHeadcount = LOOKS[look].decor?.Headcount
  const body = (
    <>
      <div className="flex items-baseline gap-2">
        <span className="ft-headcount__value num font-display text-[30px] leading-none font-bold text-ink">{hc}</span>
        <span className="ft-headcount__label text-[13.5px] font-semibold text-ink-2">{hc === 1 ? 'employee' : 'employees'}</span>
        {incoming > 0 && <span className="ft-headcount__incoming ml-auto text-[12.5px] font-semibold text-accent">+{incoming} starting</span>}
      </div>
      <div className={cx('ft-headcount__meter mt-2.5', compact && 'mt-2')}>
        {LookHeadcount ? (
          <LookHeadcount count={hc} incoming={incoming} />
        ) : (
          <Tally count={hc} incoming={incoming} slots={20} size={compact ? 'sm' : 'md'} showScale />
        )}
      </div>
    </>
  )
  const cls = cx('ft-headcount', compact && 'ft-headcount--compact', 'block rounded-xl px-3 py-3')
  const title = 'Headcount as tally marks. Group edges at 5, 15 and 20 are where California and federal rules change.'
  return viewer.role === 'admin' ? (
    <a href={links.compliance('milestones')} className={cx(cls, 'transition-colors hover:bg-surface-2')} title={title}>
      {body}
    </a>
  ) : (
    <div className={cls} title={title}>
      {body}
    </div>
  )
}

function ViewAsControl() {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const setViewAs = usePrefs((s) => s.setViewAs)
  const managerMode = hiringManagerModeAvailable(db)
  const employeeMode = employeeModeAvailable(db)
  const roles: Array<{ value: Role; label: string; disabled?: boolean; why?: string }> = [
    { value: 'admin', label: 'Admin' },
    { value: 'manager', label: 'Manager', disabled: !managerMode, why: 'Appears once someone other than the founder manages people or a job' },
    // Still offered while in it, so the switch never strands someone in Employee view.
    { value: 'employee', label: 'Employee', disabled: !employeeMode && viewer.role !== 'employee', why: 'Appears with your first hire' },
  ]
  const ids = pickablePeople(db, viewer.role)
  const people = db.people.filter((p) => ids.includes(p.id)).sort((a, b) => a.hireNumber - b.hireNumber)
  // The rail and the phone menu can both render this control, so ids are per instance.
  const uid = useId().replace(/:/g, '')
  const selectId = `viewas-person-${uid}`
  const titleId = `viewas-title-${uid}`
  return (
    <div className="ft-viewas rounded-xl border border-line bg-surface px-3 py-2.5">
      <div className="flex items-center justify-between">
        <span className="ft-viewas__title eyebrow">Viewing as</span>
        <span className="text-[11px] text-ink-3" title="Switching views is a preview. It does not protect data.">
          preview, not security
        </span>
      </div>
      <div
        role="radiogroup"
        aria-label="View"
        onKeyDown={(e) => rovingKeyDown(e, { select: true })}
        className="ft-segmented ft-viewas__roles mt-2 grid grid-cols-3 gap-1 rounded-lg bg-surface-2 p-0.5"
      >
        {roles.map((r, i) => (
          <button
            key={r.value}
            type="button"
            role="radio"
            aria-checked={viewer.role === r.value}
            tabIndex={rovingTabIndex(i, roles.map((x) => ({ on: viewer.role === x.value, disabled: x.disabled })))}
            disabled={r.disabled}
            title={r.disabled ? r.why : undefined}
            onClick={() => setViewAs(r.value, null)}
            className={cx(
              'ft-segmented__item',
              viewer.role === r.value && 'ft-segmented__item--on',
              'h-10 rounded-md text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40',
              viewer.role === r.value ? 'bg-surface text-ink shadow-[inset_0_-2px_0_var(--accent)]' : 'text-ink-3 hover:text-ink',
            )}
          >
            {r.label}
          </button>
        ))}
      </div>
      <label htmlFor={selectId} className="ft-field__label mt-2.5 block text-[12px] font-semibold text-ink-3">
        Person
      </label>
      <div className="mt-1 flex items-center gap-2">
        {viewer.person && <Avatar name={fullName(viewer.person)} size={30} />}
        <div className="ft-select-wrap relative min-w-0 flex-1">
          <select
            id={selectId}
            value={viewer.personId ?? ''}
            onChange={(e) => setViewAs(viewer.role, e.target.value)}
            aria-describedby={viewer.person?.title ? titleId : undefined}
            className="ft-select h-10 w-full cursor-pointer appearance-none truncate rounded-lg border border-[var(--control-border)] bg-surface pr-8 pl-2.5 text-[14px] font-semibold text-ink hover:border-ink-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25"
          >
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                #{p.hireNumber} {fullName(p)}
              </option>
            ))}
          </select>
          <Icon name="chevron-down" size={16} className="ft-select__chevron pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-ink-3" />
        </div>
      </div>
      {viewer.person?.title && (
        <div id={titleId} className="mt-1 truncate text-[12px] text-ink-3">
          {viewer.person.title}
        </div>
      )}
    </div>
  )
}

function NavList({ onNavigate, autofocusActive }: { onNavigate?: () => void; autofocusActive?: boolean }) {
  const viewer = useViewer()
  const route = useRoute()
  const active = activeNavKey(route.view, viewer)
  return (
    <nav aria-label="Main" className="ft-nav">
      <ul className="flex flex-col gap-0.5">
        {visibleNav(viewer).map((item) => {
          const on = item.key === active
          return (
            <li key={item.key}>
              <a
                href={item.href}
                onClick={onNavigate}
                aria-current={on ? 'page' : undefined}
                data-autofocus={autofocusActive && on ? true : undefined}
                className={cx(
                  'ft-navitem',
                  on && 'ft-navitem--active',
                  'flex h-11 items-center gap-3 rounded-lg px-3 text-[15px] font-semibold transition-colors',
                  on ? 'bg-accent-soft text-accent-soft-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
                )}
              >
                <Icon name={item.icon} size={19} className="ft-navitem__icon" />
                {item.label}
              </a>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

/**
 * The company name and logo. narrow: the phone top bar with the sync chip beside it; below 20rem of
 * layout width (a 375px phone at 130% or 150% text) the logo steps aside so the name keeps about 8
 * characters.
 */
function Brand({ narrow }: { narrow?: boolean }) {
  const company = useDB((s) => s.db.company)
  return (
    <a href="#home" className="ft-brand flex min-w-0 items-center gap-2.5 rounded-lg px-1 py-1">
      <span
        className={cx(
          'ft-brand__mark inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-ink',
          narrow && '@max-[20rem]/app:hidden',
        )}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
          <path
            d="M6 5v14M10 5v14M14 5v14M18 5v14M3.5 16.5 20.5 7.5"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </span>
      <span className="min-w-0">
        <span className="ft-brand__name block truncate font-display text-[16px] leading-tight font-bold text-ink">{company.name}</span>
        <span className="ft-brand__meta block truncate text-[12px] text-ink-3">
          {company.stage} · {company.hq.city}, {company.hq.state}
        </span>
      </span>
    </a>
  )
}

/** Where this workspace lives, under Viewing as. */
function RailNote() {
  const text = useSyncStatus((s) => {
    if (s.mode !== 'server') return 'Saved in this browser only'
    if (s.hold) return 'Saved in this browser; syncing is paused'
    // Only states that last: 'syncing' passes in under a second after every edit, so it never changes the note.
    const stuck = s.status === 'signed_out' || s.status === 'offline' || s.status === 'error'
    if (stuck && s.pendingEdits + s.rejected > 0) return 'Saved in this browser; changes wait to sync'
    if (s.rejected > 0) return 'Saved in this browser; some changes need attention'
    return 'Saved in this browser and on your server'
  })
  // Not connected, on a page a server answered for: say where to sign in, or that an empty server waits
  // for this workspace. Asked on every page the server served, sample or not (a founder who started fresh
  // here keeps the pointer after a reload). Text only: the banners carry the 40px actions.
  const local = useSyncStatus((s) => s.mode !== 'server')
  const sample = useDB((s) => s.db.meta.sample)
  const server = useServerHere(local && isServedPage())
  const hint =
    !local || !server
      ? ''
      : !server.signedIn
        ? '. A server is available here: sign in under Settings, Server'
        : !server.empty
          ? ''
          : sample
            ? '. Your server is empty: start fresh or import your company, then upload it'
            : '. Your server is empty: upload this workspace under Settings, Server'
  return (
    <p className="ft-rail__note px-1 text-[11.5px] text-ink-3">
      {text}
      {hint}
    </p>
  )
}

function StorageWarning() {
  const ok = useDB((s) => s.storageOk)
  // Connected with changes waiting: the sync banner says the same thing for that case (keep the tab open).
  const syncWarns = useSyncStorageWarning()
  if (ok || syncWarns) return null
  return (
    <div role="alert" className="ft-banner ft-banner--storage mb-4 flex items-start gap-2 rounded-xl bg-warn-soft px-4 py-3 text-[14px] text-ink">
      <Icon name="alert" size={18} className="mt-0.5 shrink-0 text-warn" />
      <p>
        This browser is not saving changes (private window, full storage, or blocked site data). Download a backup from{' '}
        <a href={links.settings('data')} className="font-bold text-accent underline">
          Settings, Data
        </a>{' '}
        before you close this tab.
      </p>
    </div>
  )
}

/** The phone and narrow-window menu: a modal panel from the left with Escape and a focus trap. */
function MenuPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEscape(onClose, open)
  useFocusTrap(ref, open)
  if (!open) return null
  return (
    <div className="fixed inset-0 z-40 lg:hidden">
      <div className="ft-scrim anim-fade absolute inset-0 bg-[var(--scrim)]" onClick={onClose} aria-hidden />
      <div
        ref={ref}
        id="app-menu"
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        className="ft-rail ft-rail--sheet anim-sheet absolute inset-y-0 left-0 flex w-[min(320px,88vw)] flex-col gap-3 overflow-y-auto bg-paper px-3 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] shadow-pop"
      >
        <div className="flex items-center justify-between">
          <Brand />
          <button
            type="button"
            aria-label="Close menu"
            onClick={onClose}
            className="ft-iconbtn ft-iconbtn--ghost inline-flex h-11 w-11 items-center justify-center rounded-lg text-ink-3 hover:bg-surface-2"
          >
            <Icon name="x" size={20} />
          </button>
        </div>
        <HeadcountBlock compact />
        <div data-overlay-body>
          <NavList onNavigate={onClose} autofocusActive />
        </div>
        <div className="mt-auto">
          <ViewAsControl />
        </div>
      </div>
    </div>
  )
}

export function Shell({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const route = useRoute()
  const db = useDB((s) => s.db)
  const look = usePrefs((s) => s.look)
  const hc = headcountOn(db)
  const decor = LOOKS[look].decor
  const LookBanner = decor?.Banner
  const LookFooter = decor?.Footer
  const closeMenu = useCallback(() => setMenuOpen(false), [])
  // The compact sync chip shows in the phone top bar whenever this browser is connected.
  const syncShown = useSyncStatus((s) => s.mode === 'server')

  useEffect(() => setMenuOpen(false), [route.raw])

  // A notice the page before a reload left (Sign out and remove data reloads before its toast is read).
  useEffect(() => {
    const notice = takeReloadNotice()
    if (notice) toast({ text: notice })
  }, [])

  return (
    <div className="ft-app flex min-h-full">
      <aside className="ft-rail sticky top-0 hidden h-screen w-[264px] shrink-0 flex-col gap-3 border-r border-line bg-paper px-3 pt-4 pb-3 lg:flex">
        <Brand />
        <HeadcountBlock />
        <div className="scroll-thin -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
          <NavList />
        </div>
        <ViewAsControl />
        <RailNote />
      </aside>

      <div className="ft-topbar fixed inset-x-0 top-0 z-30 border-b border-line bg-paper pt-[env(safe-area-inset-top,0px)] lg:hidden">
        {/* With the sync chip in the row and under 20rem of width, tighter gaps leave the name more room. */}
        <div className={cx('flex h-14 items-center gap-2 px-3', syncShown && '@max-[20rem]/app:gap-1 @max-[20rem]/app:px-2')}>
          <button
            type="button"
            aria-label="Open menu"
            aria-expanded={menuOpen}
            aria-controls="app-menu"
            aria-haspopup="dialog"
            onClick={() => setMenuOpen(true)}
            className="ft-iconbtn ft-iconbtn--ghost inline-flex h-11 w-11 items-center justify-center rounded-lg text-ink-2 hover:bg-surface-2"
          >
            <Icon name="menu" size={21} />
          </button>
          <div className="min-w-0 flex-1">
            <Brand narrow={syncShown} />
          </div>
          <span className="ft-topbar__count num hidden text-[13px] font-semibold text-ink-2 sm:inline">{plural(hc, 'employee')}</span>
          {/* Phones and narrow windows: the header's sync chip moves up here, icon only (the brand truncates). */}
          <SyncChip compact className="inline-flex md:hidden" />
          <button
            type="button"
            aria-label="Search"
            onClick={openPalette}
            className="ft-iconbtn ft-iconbtn--ghost inline-flex h-11 w-11 items-center justify-center rounded-lg text-ink-2 hover:bg-surface-2"
          >
            <Icon name="search" size={20} />
          </button>
        </div>
      </div>

      <MenuPanel open={menuOpen} onClose={closeMenu} />

      <main
        id="main"
        tabIndex={-1}
        className="ft-main min-w-0 flex-1 px-4 pt-[calc(3.5rem+env(safe-area-inset-top,0px)+1rem)] pb-16 focus:outline-none sm:px-6 lg:px-10 lg:pt-6"
      >
        <div className="ft-main__inner mx-auto w-full max-w-[1240px]">
          {LookBanner && (
            <div className="ft-decor ft-decor--banner">
              <LookBanner />
            </div>
          )}
          <Header />
          <StorageWarning />
          <SyncBanners />
          <PreviewBanner />
          <SampleBanner />
          <ServerHereBanner />
          {children}
          {LookFooter && (
            <div className="ft-decor ft-decor--footer">
              <LookFooter />
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
