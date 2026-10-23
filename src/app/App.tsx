import { Component, type ErrorInfo, type ReactNode, useEffect, useLayoutEffect, useRef } from 'react'
import { canSeeCandidate, canSeeSection } from '@/domain/access'
import { useDB } from '@/store/db'
import { usePrefs } from '@/store/prefs'
import { LOOKS } from '@/themes/registry'
import { EmptyState, focusPageStart, toast, Toaster } from '@/ui'
import { CommandPalette } from './CommandPalette'
import { sectionOf } from './nav'
import { links, replaceRoute, useRoute } from './router'
import { ALIASES, ROUTES } from './routes'
import { Shell } from './Shell'
import { useShortcut } from './shortcuts'
import { useViewer } from './useViewer'

/**
 * Keeps one page's render error from blanking the whole app (rail, Viewing as, Undo stay usable).
 * The caller keys it on the page (view plus record id), so tab switches and route-driven sheets keep
 * the page mounted (focus, filters and scroll survive); any route change clears a shown error.
 */
class PageErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Page failed to render', error, info.componentStack)
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <EmptyState
        icon="alert"
        title="This page could not be shown"
        body={`Your data is safe. Try Undo (Ctrl+Z) if a recent change caused this, or go home. Details: ${this.state.error.message}`}
        action={
          <a href={links.home()} className="font-bold text-accent underline">
            Go home
          </a>
        }
      />
    )
  }
}

function useDisplayPrefs() {
  const look = usePrefs((s) => s.look)
  const theme = usePrefs((s) => s.theme)
  const scale = usePrefs((s) => s.textScale)
  const reduced = usePrefs((s) => s.reducedMotion)
  const supportsDark = LOOKS[look].supportsDark
  // Layout effects, so a change of look or theme never paints one frame in the old skin.
  useLayoutEffect(() => {
    // The skin (docs/LOOKS.md). index.html sets it before the first paint too, from the saved prefs.
    document.documentElement.setAttribute('data-look', look)
  }, [look])
  useLayoutEffect(() => {
    const root = document.documentElement
    // Light/dark only applies to looks that have both palettes; a fixed-palette look ignores the
    // setting (its CSS is not scoped to data-theme at all), and the app drops a theme it set itself.
    const effective = supportsDark ? theme : 'system'
    // "Match system" leaves any theme a host page set alone; only undo a theme this app set itself.
    if (effective === 'system') {
      if (root.dataset.themeOwner === 'app') {
        root.removeAttribute('data-theme')
        delete root.dataset.themeOwner
      }
    } else {
      root.setAttribute('data-theme', effective)
      root.dataset.themeOwner = 'app'
    }
  }, [theme, supportsDark])
  useEffect(() => {
    // Tailwind sizes are mostly px; zoom keeps every size in proportion at 115-150%. Media queries
    // ignore zoom, so the sm/md/lg breakpoints query the body's width instead (styles.css): at 150%
    // on a laptop the rail folds into the top bar and rows stack as they would on a narrower window.
    document.documentElement.style.setProperty('zoom', String(scale))
  }, [scale])
  useEffect(() => {
    if (reduced) document.documentElement.setAttribute('data-reduced-motion', '')
    else document.documentElement.removeAttribute('data-reduced-motion')
  }, [reduced])
}

/**
 * Ctrl/Cmd+Z undoes the last change when focus is not in a text field (listed in the ? sheet). Not while
 * a sheet or dialog is open: its form is unsaved work, and the newest saved change is something behind it.
 */
function useUndoShortcut() {
  useShortcut(
    'mod+z',
    () => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) {
        toast({ text: 'Close the open sheet or dialog to undo a saved change.', tone: 'neutral' })
        return
      }
      const label = useDB.getState().undo()
      toast(label ? { text: `Undid: ${label}`, tone: 'neutral' } : { text: 'Nothing to undo', tone: 'neutral' })
    },
    { description: 'Undo the last change', group: 'Anywhere', ignoreInInputs: true },
  )
}

/**
 * Views whose second segment is a record id; other views keep one page across their tabs. An invite's
 * token is one too: it never becomes the tab's title.
 */
const RECORD_VIEWS = new Set(['job', 'candidate', 'person', 'checklist', 'contractor', 'invite'])
/** Route segments that open a sheet over the current page. */
const SHEET_SEGMENTS = new Set(['add', 'new', 'new-job', 'request', 'offboard', 'change', 'edit', 'posting', 'fresh'])

function pageKey(view: string, segments: string[]): string {
  return RECORD_VIEWS.has(view) ? `${view}.${segments[1] ?? ''}` : view
}

function hasSheet(segments: string[]): boolean {
  return segments.slice(1).some((s) => SHEET_SEGMENTS.has(s))
}

const SECTION_TITLES: Record<string, string> = {
  home: 'Home',
  hiring: 'Hiring',
  people: 'People',
  comp: 'Comp and plan',
  compliance: 'Compliance',
  me: 'Me',
  settings: 'Settings',
  invite: 'Join a company',
}

const TAB_TITLES: Record<string, string> = {
  timeoff: 'Time off',
  org: 'Org chart',
  'settings.org': 'Org',
  'settings.timeoff': 'Time off policies',
  wall: 'First twenty wall',
  kits: 'Interview kits',
  soc2: 'SOC 2',
  plan: 'Headcount plan',
  bands: 'Levels and bands',
  table: 'Comp table',
  cost: 'Cost and runway',
  payruns: 'Pay runs',
  templates: 'Checklist templates',
  rules: 'Rules and rates',
  links: 'Link-outs',
  roles: 'Open roles',
  job: 'Job and pay',
}

/** Browser tab title for a route: the record or section, then the tab, then the app name (WCAG 2.4.2). */
function usePageTitle(view: string, segments: string[]) {
  const viewer = useViewer()
  const title = useDB((s) => {
    const db = s.db
    const id = segments[1]
    if (view === 'job') return db.jobs.find((j) => j.id === id)?.title ?? 'Job'
    if (view === 'candidate') {
      const c = db.candidates.find((x) => x.id === id)
      return c && canSeeCandidate(viewer, db, c.id) ? `${c.firstName} ${c.lastName}` : 'Candidate'
    }
    if (view === 'person') {
      const p = db.people.find((x) => x.id === id)
      return p ? `${p.preferredName || p.firstName} ${p.lastName}` : 'Person'
    }
    if (view === 'checklist') return 'Checklist'
    if (view === 'contractor') return canSeeSection(viewer, 'people') ? (db.contractors.find((k) => k.id === id)?.name ?? 'Contractor') : 'Contractor'
    return SECTION_TITLES[view] ?? 'First Twenty'
  })
  const tab = !RECORD_VIEWS.has(view) ? segments[1] : segments[2]
  const tabText = tab && !SHEET_SEGMENTS.has(tab) && !/^[a-z]+-/.test(tab) ? (TAB_TITLES[`${view}.${tab}`] ?? TAB_TITLES[tab] ?? tab[0].toUpperCase() + tab.slice(1).replace(/-/g, ' ')) : ''
  useEffect(() => {
    const parts = [title, tabText, 'First Twenty'].filter(Boolean)
    document.title = [...new Set(parts)].join(' · ')
  }, [title, tabText])
}

export function App() {
  useDisplayPrefs()
  useUndoShortcut()
  const route = useRoute()
  const viewer = useViewer()

  const alias = ALIASES[route.view]
  useEffect(() => {
    if (alias) replaceRoute(...alias, ...route.segments.slice(1))
  }, [alias, route.segments])

  // Employees land on Me; everyone else on Home.
  const view = route.view === '' || (route.view === 'home' && viewer.role === 'employee') ? (viewer.role === 'employee' ? 'me' : 'home') : route.view
  const key = pageKey(view, route.segments)
  usePageTitle(view, route.segments)

  // Scroll to the top for a new page or tab, but not when a sheet opens or closes over the page.
  // When the route change removed the element that held focus, move focus to the page title, not <body>.
  const prevRoute = useRef<{ key: string; segments: string[] } | null>(null)
  useEffect(() => {
    const prev = prevRoute.current
    prevRoute.current = { key, segments: route.segments }
    if (!prev) return
    const sheetMove = hasSheet(prev.segments) || hasSheet(route.segments)
    if (!sheetMove && (prev.key !== key || prev.segments[1] !== route.segments[1] || prev.segments[2] !== route.segments[2])) {
      window.scrollTo({ top: 0 })
    }
    const t = setTimeout(() => {
      const a = document.activeElement
      if (!a || a === document.body || !a.isConnected) focusPageStart()
    }, 0)
    return () => clearTimeout(t)
  }, [key, route.segments])

  const Page = ROUTES[view]
  const section = sectionOf(view)
  // Interviewers in Employee view reach a candidate's profile through their interviews (access.ts).
  const candidateId = view === 'candidate' ? route.segments[1] : undefined
  const interviewsCandidate = useDB((s) => !!candidateId && canSeeCandidate(viewer, s.db, candidateId))
  const allowed = !section || canSeeSection(viewer, section) || interviewsCandidate

  return (
    <>
      <a
        href="#main"
        onClick={(e) => {
          e.preventDefault()
          // The page title, not #main: #main also holds the header toolbar, so the next Tab reaches the page.
          focusPageStart()
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[70] focus:inline-flex focus:min-h-10 focus:items-center focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2.5"
      >
        Skip to content
      </a>
      <Shell>
        {alias ? null : !Page ? (
          <EmptyState
            icon="search"
            title="That page does not exist"
            body="The link may be from an older version."
            action={
              <a href={links.home()} className="font-bold text-accent underline">
                Go home
              </a>
            }
          />
        ) : !allowed ? (
          <EmptyState
            as="h1"
            icon="lock"
            title="Not part of this view"
            body={`In ${viewer.role === 'manager' ? 'Hiring manager' : 'Employee'} view this page is hidden. Switch to Admin under Viewing as to see it.`}
            action={
              <a href={viewer.role === 'employee' ? links.me() : links.home()} className="font-bold text-accent underline">
                Go to {viewer.role === 'employee' ? 'Me' : 'Home'}
              </a>
            }
          />
        ) : (
          <PageErrorBoundary key={key} resetKey={route.raw}>
            <Page route={{ ...route, view }} />
          </PageErrorBoundary>
        )}
      </Shell>
      <CommandPalette />
      <Toaster />
    </>
  )
}
