// Primary navigation per docs/SPEC.md: Home, Hiring, People, Comp and plan, Compliance, Settings, Me.
// Visibility depends on the Viewing-as mode (src/domain/access.ts).
import { canSeeSection, type Section } from '@/domain/access'
import type { Viewer } from '@/domain/types'
import type { IconName } from '@/ui'
import { links } from './router'

export type NavItem = {
  key: Section
  label: string
  icon: IconName
  href: string
  /** Route views that highlight this item (detail pages belong to their section). */
  matches: string[]
}

export const NAV: NavItem[] = [
  { key: 'home', label: 'Home', icon: 'home', href: links.home(), matches: ['home', ''] },
  { key: 'hiring', label: 'Hiring', icon: 'briefcase', href: links.hiring(), matches: ['hiring', 'job', 'candidate'] },
  {
    key: 'people',
    label: 'People',
    icon: 'users',
    href: links.people(),
    matches: ['people', 'person', 'checklist', 'contractor', 'timeoff'],
  },
  { key: 'comp', label: 'Comp and plan', icon: 'coins', href: links.comp(), matches: ['comp', 'plan'] },
  { key: 'compliance', label: 'Compliance', icon: 'shield-check', href: links.compliance(), matches: ['compliance'] },
  { key: 'me', label: 'Me', icon: 'user', href: links.me(), matches: ['me'] },
  { key: 'settings', label: 'Settings', icon: 'settings', href: links.settings(), matches: ['settings'] },
]

export function visibleNav(viewer: Viewer): NavItem[] {
  return NAV.filter((n) => canSeeSection(viewer, n.key))
}

/** Route views that belong to no section, so no nav item is current on them (an invite link's page). */
const NO_SECTION = new Set(['invite'])

/** The nav item that is the current page, or null on a page of no section. Unknown views count as Home. */
export function activeNavKey(view: string, viewer: Viewer): string | null {
  if (NO_SECTION.has(view)) return null
  if ((view === 'home' || view === '') && viewer.role === 'employee') return 'me'
  return NAV.find((n) => n.matches.includes(view))?.key ?? 'home'
}

/** Which section a route view belongs to (for access checks on direct links). */
export function sectionOf(view: string): Section | null {
  return NAV.find((n) => n.matches.includes(view))?.key ?? null
}
