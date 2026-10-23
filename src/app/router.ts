// Hash router. Routes look like #hiring, #hiring.jobs, #job.j-staff-ml, #person.p-founder.equity.
// Only letters, digits, '.', '_', '~' and '-' are used so deep links survive hosts that
// only pass plain anchors through.
import { useSyncExternalStore } from 'react'

export type Route = { view: string; segments: string[]; raw: string }

/** A segment with a broken %-escape (a mangled link) stays as typed instead of throwing. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

export function parse(hash: string): Route {
  const raw = hash.replace(/^#/, '')
  const segments = raw.split('.').filter(Boolean).map(decodeSegment)
  return { view: segments[0] ?? 'home', segments, raw }
}

function subscribe(cb: () => void) {
  window.addEventListener('hashchange', cb)
  return () => window.removeEventListener('hashchange', cb)
}

let cachedHash = ''
let cachedRoute: Route = parse('')

function snapshot(): Route {
  const h = typeof window === 'undefined' ? '' : window.location.hash
  if (h !== cachedHash) {
    cachedHash = h
    cachedRoute = parse(h)
  }
  return cachedRoute
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, snapshot, () => parse(''))
}

/** Builds an href from segments: href('job', 'j-1') -> '#job.j-1' */
export function href(...segments: Array<string | null | undefined | false>): string {
  return `#${segments
    .filter(Boolean)
    .map((s) => encodeURIComponent(String(s)))
    .join('.')}`
}

export function navigate(...segments: Array<string | null | undefined | false>): void {
  navigateTo(href(...segments))
}

/** Goes to an href built with href(...) or links.* (nothing happens when the page is already there). */
export function navigateTo(h: string): void {
  if (window.location.hash !== h) window.location.hash = h.slice(1)
}

/** Replace the current hash without adding a history entry (e.g. closing a sheet). */
export function replaceRoute(...segments: Array<string | null | undefined | false>): void {
  const h = href(...segments)
  history.replaceState(null, '', h)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

/**
 * Canonical links to every page and record, so modules link the same way.
 * Detail pages are owned by the feature that renders them (see ARCHITECTURE.md, Routes).
 */
export const links = {
  home: () => href('home'),
  // Hiring
  hiring: (tab?: 'jobs' | 'candidates' | 'offers' | 'kits') => href('hiring', tab),
  job: (id: string, view?: 'board' | 'list' | 'sweep' | 'edit' | 'posting') => href('job', id, view),
  candidate: (id: string) => href('candidate', id),
  /** The candidate's profile with focus on one application's offer (its next action: Make offer, Mark sent, Hire). */
  candidateOffer: (id: string, applicationId: string) => href('candidate', id, 'offer', applicationId),
  newCandidate: (jobId?: string) => href('hiring', 'add', jobId),
  newJob: (planSlotId?: string) => href('hiring', 'new-job', planSlotId),
  // People
  people: (tab?: 'directory' | 'org' | 'wall' | 'checklists' | 'timeoff' | 'contractors') => href('people', tab),
  person: (id: string, tab?: 'overview' | 'job' | 'equity' | 'timeoff' | 'checklists' | 'emergency' | 'activity') =>
    href('person', id, tab),
  checklist: (id: string) => href('checklist', id),
  contractor: (id: string) => href('contractor', id),
  newPerson: () => href('people', 'new'),
  newContractor: () => href('people', 'contractors', 'new'),
  offboard: (personId: string) => href('person', personId, 'offboard'),
  changeJob: (personId: string) => href('person', personId, 'change'),
  // Comp and plan
  comp: (tab?: 'plan' | 'bands' | 'table' | 'equity' | 'cost' | 'payruns') => href('comp', tab),
  /** Comp and plan > Pay runs, on one pay period when its start date is given. */
  payRun: (periodStart?: string) => href('comp', 'payruns', periodStart),
  // Compliance
  compliance: (tab?: 'milestones' | 'calendar' | 'training' | 'notices' | 'soc2' | 'records') => href('compliance', tab),
  rule: (ruleId: string) => href('compliance', 'milestones', ruleId),
  // Me
  me: (tab?: 'summary' | 'job' | 'equity' | 'timeoff' | 'tasks' | 'profile' | 'roles') => href('me', tab),
  requestTimeOff: () => href('me', 'timeoff', 'request'),
  // Settings
  settings: (
    tab?: 'company' | 'org' | 'hiring' | 'templates' | 'timeoff' | 'rules' | 'links' | 'data' | 'server',
  ) => href('settings', tab),
  /** Settings > Data with the Start fresh (solo founder) sheet open. */
  startFresh: () => href('settings', 'data', 'fresh'),
}
