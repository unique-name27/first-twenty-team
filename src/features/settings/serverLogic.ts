// Pure helpers for Settings > Server and the header's sync notices: where the app is running, what a
// server check means, how to word the sync status, how to name a record a notice is about, and how this
// browser's workspace compares with the server's. No DOM, no store.
import { links } from '@/app/router'
import type { DB } from '@/domain/types'
import { fmtDate, fmtDateTime } from '@/lib/dates'
import type { HoldReason, RefreshedRef } from '@/sync'
import type { IconName, Tone } from '@/ui'

/** Where this copy of the app runs. Only 'web' can have a First Twenty server at its own origin. */
export type HostContext = 'file' | 'artifact' | 'web'

export function hostContext(env: { protocol: string; hasClaudeRuntime: boolean }): HostContext {
  if (env.protocol === 'file:') return 'file'
  if (env.hasClaudeRuntime) return 'artifact'
  return 'web'
}

/** Reads the real page (a no-op outside a browser). The artifact viewer gives pages `window.claude.use`. */
export function detectHostContext(): HostContext {
  if (typeof window === 'undefined') return 'web'
  let hasClaudeRuntime = false
  try {
    const claude = (window as unknown as { claude?: { use?: unknown } }).claude
    hasClaudeRuntime = !!claude && typeof claude === 'object' && claude.use !== undefined
  } catch {
    hasClaudeRuntime = false
  }
  return hostContext({ protocol: window.location.protocol, hasClaudeRuntime })
}

/**
 * What a failed server check means for the screen.
 * - missing: nothing at this address speaks the First Twenty API (a static host answers 404 or its
 *   own page), so show how to set a server up.
 * - unreachable: the address may well be a First Twenty server that is down, offline or broken right
 *   now, so say what went wrong and offer to check again (with the set-up guide below it).
 */
export function classifyCheckFailure(kind: string): 'missing' | 'unreachable' {
  return kind === 'not_found' || kind === 'bad_response' || kind === 'forbidden' ? 'missing' : 'unreachable'
}

export type StatusView = { word: string; icon: IconName; tone: Tone; sentence: string }

type StatusInput = {
  status: 'local' | 'synced' | 'syncing' | 'offline' | 'signed_out' | 'error'
  hold: HoldReason | null
  pending: number
  /** Waiting changes as a person counts them (status pendingEdits); used instead of pending when given. */
  pendingEdits?: number
  /** The user signed out on purpose (status signedOutByUser). */
  signedOutByUser?: boolean
  /** Changes the server refused (kept in this browser). Optional for callers that only show the word. */
  rejected?: number
  storageFull: boolean
}

/**
 * The kinds of state the header sync chip shows (src/app/Header.tsx, syncView) and the tone each one
 * has there. The Settings badge uses the same word and tone for the same state, so the two never
 * disagree about how serious it is (serverLogic.test.ts checks it against the chip).
 */
export const SYNC_KIND_TONE = {
  synced: 'good',
  syncing: 'neutral',
  offline: 'warn',
  'signed-out': 'warn',
  attention: 'bad',
  paused: 'neutral',
} as const satisfies Record<string, Tone>

/** The status word, icon, tone and one plain sentence (status is always a word plus a color). */
export function statusView(s: StatusInput): StatusView {
  // The same count as the header chip: edits, not the activity rows each edit also writes.
  const pending = s.pendingEdits ?? s.pending
  const waiting = pending > 0 ? ` ${plural(pending, 'change is', 'changes are')} waiting in this browser.` : ''
  switch (s.status) {
    case 'synced':
      return s.rejected
        ? {
            word: 'Needs attention',
            icon: 'alert',
            tone: SYNC_KIND_TONE.attention,
            sentence: 'Your server refused some changes. Everything else is on your server.',
          }
        : { word: 'Synced', icon: 'check', tone: SYNC_KIND_TONE.synced, sentence: 'Every change in this browser is on your server.' }
    case 'syncing':
      return {
        word: 'Syncing',
        icon: 'rotate-ccw',
        tone: SYNC_KIND_TONE.syncing,
        sentence: pending > 0 ? `Sending ${plural(pending, 'change', 'changes')} to your server.` : 'Catching up with your server.',
      }
    case 'offline':
      return {
        word: 'Offline',
        icon: 'globe',
        tone: SYNC_KIND_TONE.offline,
        sentence: `Cannot reach your server. Keep working; changes sync when the connection returns.${waiting}`,
      }
    case 'signed_out':
      return {
        word: 'Signed out',
        icon: 'lock',
        tone: SYNC_KIND_TONE['signed-out'],
        sentence: s.signedOutByUser
          ? `You signed out. Sign in to sync again; this browser keeps an offline copy until then.${waiting}`
          : `Sign in to keep syncing. This browser keeps an offline copy until then.${waiting}`,
      }
    case 'error':
      return s.storageFull
        ? { word: 'Not saving', icon: 'alert', tone: SYNC_KIND_TONE.attention, sentence: 'This browser cannot save changes that have not reached your server yet.' }
        : { word: 'Needs attention', icon: 'alert', tone: SYNC_KIND_TONE.attention, sentence: `Your server answered with an error. Syncing retries on its own.${waiting}` }
    case 'local':
      // The sample and the demo clock are pauses the person chose (Undo, or going back to the real date,
      // resumes them); an empty server or a replaced workspace needs a decision, which the chip calls
      // Needs attention.
      if (s.hold === 'sample' || s.hold === 'demo_clock') {
        return { word: 'Paused', icon: 'clock', tone: SYNC_KIND_TONE.paused, sentence: holdSentence(s.hold) }
      }
      if (s.hold) return { word: 'Needs attention', icon: 'alert', tone: SYNC_KIND_TONE.attention, sentence: holdSentence(s.hold) }
      return { word: 'Local only', icon: 'laptop', tone: 'neutral', sentence: 'This browser is not connected to a server.' }
  }
}

/**
 * The subtitle of the sign-in form on a connected browser that is signed out: a sign-out the user chose
 * keeps saying so, even after changes queue or the page reloads; only a session that ended on its own
 * (a 401 nobody asked for) says it ended.
 */
/**
 * The subtitle of "Sign in to keep syncing". company: on a server that holds many companies (a demo
 * server), the company this browser holds the copy of: only a login of that company carries on with it.
 */
export function signInSubtitle(s: { signedOutByUser: boolean; company?: string }): string {
  const base = s.signedOutByUser
    ? 'You signed out. This browser keeps an offline copy; changes you make wait here until you sign in again.'
    : 'Your session on the server ended. Keep working: this browser keeps an offline copy and holds your changes until you sign in.'
  const company = s.company?.trim()
  return company ? `${base} Sign in with a login of ${company}.` : base
}

export function holdSentence(hold: HoldReason): string {
  switch (hold) {
    case 'sample':
      return 'Syncing is paused while this browser shows the sample company.'
    case 'demo_clock':
      return 'Syncing is paused while the app pretends today is another day.'
    case 'server_empty':
      return 'Syncing is paused because your server has no workspace.'
    case 'replaced':
      return 'Syncing is paused because this browser\'s workspace was replaced and never uploaded.'
  }
}

export type WorkspaceSummary = {
  companyName: string
  sample: boolean
  counts: { people: number; candidates: number; jobs: number }
  /**
   * What tells two workspaces with one name apart (summarize fills them; a summary without them compares
   * by name and counts only): when it was created, its newest activity row, how many changes the
   * activity log holds, funding rounds, filled company settings and departments.
   */
  detail?: {
    createdOn: string | null
    lastChangeAt: string | null
    changesLogged: number
    fundingRounds: number
    settingsFilled: number
    departments: number
  }
}

const filledText = (v: unknown): boolean => typeof v === 'string' && v.trim() !== ''
const filledNumber = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)

/** Company settings someone filled in (Settings, Company): none of them is set by Start fresh. */
export function settingsFilled(company: Partial<DB['company']> | undefined): number {
  if (!company) return 0
  const texts = [
    company.phone,
    company.website,
    company.regularPayday,
    company.eddAccountNumber,
    company.firstPayrollOn,
    company.workersCompCarrier?.name,
    company.payrollProvider?.url,
    company.hq?.street,
    company.tagline,
    ...Object.values(company.linkOuts ?? {}),
  ]
  const numbers = [company.cashOnHand, company.otherMonthlySpend, company.monthlyRevenue, company.annualRevenue]
  return texts.filter(filledText).length + numbers.filter(filledNumber).length + (company.groupHealthPlanStartedOn !== undefined ? 1 : 0)
}

/** The summary of a workspace (this browser's or the server's) that the connect step compares. */
export function summarize(db: DB): WorkspaceSummary {
  const list = <T>(v: T[] | undefined): T[] => (Array.isArray(v) ? v : [])
  let lastChangeAt: string | null = null
  let last = -Infinity
  for (const a of list(db.activity)) {
    const t = typeof a?.at === 'string' ? Date.parse(a.at) : Number.NaN
    if (Number.isFinite(t) && t > last) {
      last = t
      lastChangeAt = a.at
    }
  }
  return {
    companyName: db.company?.name ?? '',
    sample: db.meta?.sample === true,
    counts: { people: list(db.people).length, candidates: list(db.candidates).length, jobs: list(db.jobs).length },
    detail: {
      createdOn: typeof db.meta?.createdOn === 'string' ? db.meta.createdOn : null,
      lastChangeAt,
      changesLogged: list(db.activity).length,
      fundingRounds: list(db.company?.fundingRounds).length,
      settingsFilled: settingsFilled(db.company),
      departments: list(db.departments).length,
    },
  }
}

/**
 * How this browser's workspace compares with the server's, for "Use the server's copy":
 * - sample: this browser shows the sample company (nothing of the company's is lost).
 * - same_name: a workspace with the server's company name. The name and a few counts cannot prove it
 *   is the same workspace (every fresh start is "1 person, 0 jobs and 0 candidates"), so the screen
 *   never calls it the same and still offers a backup first.
 * - different: another company name: using the server's copy replaces real local data.
 */
export function compareWorkspaces(local: WorkspaceSummary, server: WorkspaceSummary): 'sample' | 'same_name' | 'different' {
  if (local.sample) return 'sample'
  return local.companyName.trim().toLowerCase() === server.companyName.trim().toLowerCase() ? 'same_name' : 'different'
}

/** "3 people, 1 job and 12 candidates" */
export function describeCounts(c: { people: number; candidates: number; jobs: number }): string {
  return `${plural(c.people, 'person', 'people')}, ${plural(c.jobs, 'job', 'jobs')} and ${plural(c.candidates, 'candidate', 'candidates')}`
}

/** "Created Oct 10, 2026, last change Sat, Oct 10, 3:12 PM, 48 changes logged, 9 company settings filled" */
export function describeDetail(s: WorkspaceSummary): string {
  const d = s.detail
  if (!d) return ''
  const parts: string[] = []
  if (d.createdOn) parts.push(`Created ${fmtDate(d.createdOn)}`)
  parts.push(d.lastChangeAt ? `last change ${fmtDateTime(d.lastChangeAt)}` : 'no changes logged yet')
  if (d.changesLogged > 0) parts.push(`${plural(d.changesLogged, 'change', 'changes')} logged`)
  parts.push(`${plural(d.settingsFilled, 'company setting', 'company settings')} filled`)
  if (d.fundingRounds > 0) parts.push(plural(d.fundingRounds, 'funding round', 'funding rounds'))
  return capitalize(parts.join(', '))
}

/**
 * How many records a workspace holds, to tell which of two same-name copies has more of the work: people,
 * jobs, candidates, funding rounds, filled company settings and departments. Activity rows are left out:
 * every click logs one, so a few edits must never outweigh a real record.
 */
function recordCount(s: WorkspaceSummary): number {
  const d = s.detail
  const c = s.counts
  return c.people + c.jobs + c.candidates + (d ? d.fundingRounds + d.settingsFilled + d.departments : 0)
}

const timeOf = (at: string | null | undefined): number => (at ? Date.parse(at) : Number.NaN)

/**
 * The copy to recommend when two workspaces share a name: the one that is newer (its last logged change)
 * and holds more records (more logged changes only breaks a tie). null when neither is both, when either
 * is the sample, and whenever the copy it would replace holds records it lacks (each copy has something
 * the other does not: either choice loses work, so the screen says what each one loses instead).
 */
export function recommendedCopy(local: WorkspaceSummary, server: WorkspaceSummary): 'local' | 'server' | null {
  if (local.sample || server.sample || !local.detail || !server.detail) return null
  const tl = timeOf(local.detail.lastChangeAt)
  const ts = timeOf(server.detail.lastChangeAt)
  const rl = recordCount(local)
  const rs = recordCount(server)
  const serverMore = rs > rl || (rs === rl && server.detail.changesLogged > local.detail.changesLogged)
  const localMore = rl > rs || (rl === rs && local.detail.changesLogged > server.detail.changesLogged)
  const serverNewer = Number.isFinite(ts) && (!Number.isFinite(tl) || ts > tl)
  const localNewer = Number.isFinite(tl) && (!Number.isFinite(ts) || tl > ts)
  // The copy it would replace must hold no record it lacks.
  if (serverNewer && serverMore && missingRecords(local, server).length === 0) return 'server'
  if (localNewer && localMore && missingRecords(server, local).length === 0) return 'local'
  return null
}

/**
 * The records `a` holds that `b` does not, in words ("1 more candidate", "2 more funding rounds"): what
 * replacing `a` with `b` would lose, apart from activity log rows.
 */
export function missingRecords(a: WorkspaceSummary, b: WorkspaceSummary): string[] {
  const out: string[] = []
  const more = (n: number, one: string, many: string) => {
    if (n > 0) out.push(`${n} more ${n === 1 ? one : many}`)
  }
  more(a.counts.people - b.counts.people, 'person', 'people')
  more(a.counts.jobs - b.counts.jobs, 'job', 'jobs')
  more(a.counts.candidates - b.counts.candidates, 'candidate', 'candidates')
  if (a.detail && b.detail) {
    more(a.detail.fundingRounds - b.detail.fundingRounds, 'funding round', 'funding rounds')
    more(a.detail.settingsFilled - b.detail.settingsFilled, 'company setting filled', 'company settings filled')
    more(a.detail.departments - b.detail.departments, 'department', 'departments')
  }
  return out
}

/**
 * What `a` holds that `b` does not, in words ("2 more funding rounds", "48 more logged changes"), for the
 * warning on a step that would replace `a` with `b`.
 */
export function moreWorkIn(a: WorkspaceSummary, b: WorkspaceSummary): string[] {
  const out = missingRecords(a, b)
  const n = a.detail && b.detail ? a.detail.changesLogged - b.detail.changesLogged : 0
  if (n > 0) out.push(`${n} more ${n === 1 ? 'logged change' : 'logged changes'}`)
  return out
}

/** "a, b and c" */
export function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

// ---------------------------------------------------------------------------------------------
// Naming records in sync notices
// ---------------------------------------------------------------------------------------------

/** How a sync notice names a record, with a link to where it is edited (null: nowhere to go). */
export type RecordLabel = { label: string; href: string | null }

/** Documents (the protocol's $doc records), by key: what they hold and where they are edited. */
const DOC_LABELS: Record<string, RecordLabel> = {
  company: { label: 'Company details', href: links.settings('company') },
  settings: { label: 'Hiring settings and rules', href: links.settings('hiring') },
  meta: { label: 'Workspace details', href: links.settings('data') },
  equity: { label: 'Equity setup', href: links.comp('equity') },
  complianceStatus: { label: 'Compliance status', href: links.compliance() },
  inboxState: { label: 'Inbox snoozes and dismissals', href: links.home() },
}

/** One record of each collection, in words. */
const NOUNS: Record<string, string> = {
  people: 'person',
  comp: 'pay record',
  grants: 'equity grant',
  contractors: 'contractor or advisor',
  documents: 'document',
  plan: 'hiring plan slot',
  jobs: 'job',
  candidates: 'candidate',
  applications: 'application',
  interviews: 'interview',
  scorecards: 'scorecard',
  offers: 'offer',
  referrals: 'referral',
  emailTemplates: 'email template',
  checklistTemplates: 'checklist template',
  checklists: 'checklist',
  timeOffPolicies: 'time off policy',
  timeOffRequests: 'time off request',
  timeOffAdjustments: 'time off adjustment',
  holidays: 'holiday',
  leaveCases: 'leave case',
  recurring: 'recurring task',
  trainings: 'training',
  policies: 'policy',
  acks: 'policy acknowledgment',
  recordsRequests: 'records request',
  activity: 'activity log entry',
  departments: 'department',
  locations: 'location',
  families: 'job family',
  levels: 'level',
  bands: 'pay band',
}

/** Where the records of a collection without a page of their own are edited. */
const LIST_HREF: Record<string, string> = {
  departments: links.settings('org'),
  locations: links.settings('org'),
  families: links.settings('org'),
  levels: links.settings('org'),
  bands: links.comp('bands'),
  plan: links.comp('plan'),
  emailTemplates: links.settings('templates'),
  checklistTemplates: links.settings('templates'),
  timeOffPolicies: links.settings('timeoff'),
  holidays: links.settings('timeoff'),
  timeOffRequests: links.people('timeoff'),
  trainings: links.compliance('training'),
  policies: links.compliance('notices'),
  recordsRequests: links.compliance('records'),
}

/** The collection behind an activity row's entityType. */
const ENTITY_COLLECTION: Record<string, string> = {
  candidate: 'candidates',
  application: 'applications',
  job: 'jobs',
  offer: 'offers',
  interview: 'interviews',
  person: 'people',
  checklist: 'checklists',
  contractor: 'contractors',
}

type AnyRecord = Record<string, unknown> & { id: string }

function findRecord(db: DB, collection: string, id: string): AnyRecord | undefined {
  const list = (db as unknown as Record<string, unknown>)[collection]
  return Array.isArray(list) ? (list as AnyRecord[]).find((r) => r?.id === id) : undefined
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const article = (noun: string): string => (/^[aeiou]/i.test(noun) ? 'an' : 'a')

function personName(db: DB, id: unknown): string {
  const p = typeof id === 'string' ? findRecord(db, 'people', id) : undefined
  return p ? `${text(p.firstName)} ${text(p.lastName)}`.trim() : ''
}

function candidateOf(db: DB, rec: AnyRecord): { name: string; id: string } | null {
  let candidateId = typeof rec.candidateId === 'string' ? rec.candidateId : null
  if (!candidateId && typeof rec.applicationId === 'string') {
    const app = findRecord(db, 'applications', rec.applicationId)
    candidateId = app && typeof app.candidateId === 'string' ? app.candidateId : null
  }
  const c = candidateId ? findRecord(db, 'candidates', candidateId) : undefined
  return c ? { name: `${text(c.firstName)} ${text(c.lastName)}`.trim(), id: c.id } : null
}

/**
 * How a sync notice names a record ("the ML engineer (agents) job", "Priya Nair", "Company details",
 * "a note on Priya Nair"), with a link to it (links.*). A record that is gone from this browser (the
 * server's copy deleted it) is named by its kind, with no link.
 */
export function describeRecord(db: DB, collection: string, id: string): RecordLabel {
  if (collection === '$doc') return DOC_LABELS[id] ?? { label: 'Workspace settings', href: links.settings() }
  const noun = NOUNS[collection] ?? 'record'
  const rec = findRecord(db, collection, id)
  if (!rec) return { label: `${article(noun)} ${noun} your server removed`, href: null }
  const named = (label: string, href: string | null): RecordLabel => ({ label: label || `${article(noun)} ${noun}`, href })
  switch (collection) {
    case 'jobs':
      return named(text(rec.title) ? `the ${text(rec.title)} job` : '', links.job(id))
    case 'candidates':
      return named(`${text(rec.firstName)} ${text(rec.lastName)}`.trim(), links.candidate(id))
    case 'people':
      return named(`${text(rec.firstName)} ${text(rec.lastName)}`.trim(), links.person(id))
    case 'contractors':
      return named(text(rec.name), links.contractor(id))
    case 'offers':
    case 'applications':
    case 'interviews':
    case 'scorecards': {
      const c = candidateOf(db, rec)
      if (!c) return named('', null)
      return { label: `${collection === 'interviews' ? 'an interview with' : `the ${noun} for`} ${c.name}`, href: links.candidate(c.id) }
    }
    case 'checklists': {
      const who = personName(db, rec.personId)
      return named(who ? `${who}'s checklist` : '', links.checklist(id))
    }
    case 'comp':
    case 'grants':
    case 'timeOffAdjustments':
    case 'leaveCases':
    case 'documents': {
      const who = personName(db, rec.personId)
      return who ? { label: `${article(noun)} ${noun} for ${who}`, href: links.person(rec.personId as string) } : named('', null)
    }
    case 'activity': {
      const entity = ENTITY_COLLECTION[text(rec.entityType)]
      const about = entity && typeof rec.entityId === 'string' && findRecord(db, entity, rec.entityId) ? describeRecord(db, entity, rec.entityId) : null
      if (rec.kind === 'note') return { label: about ? `a note on ${about.label}` : 'a note', href: about?.href ?? null }
      return { label: about ? `an activity log entry about ${about.label}` : 'an activity log entry', href: about?.href ?? null }
    }
    default: {
      const name = text(rec.name) || text(rec.title)
      return { label: name ? `the ${name} ${noun}` : `${article(noun)} ${noun}`, href: LIST_HREF[collection] ?? null }
    }
  }
}

/** A record named in a refreshed notice: removed when the server no longer has it (the edit was dropped). */
export type RefreshedLabel = RecordLabel & { removed?: true }

/**
 * How a refreshed notice names a record. One the server removed is gone from this browser too, so it is
 * named from the copy this browser had (the engine keeps it), with no link; without that copy, by its kind.
 */
export function describeRefreshed(db: DB, ref: RefreshedRef): RefreshedLabel {
  if (!ref.removed) return describeRecord(db, ref.collection, ref.id)
  const noun = NOUNS[ref.collection] ?? 'record'
  const list = (db as unknown as Record<string, unknown>)[ref.collection]
  const copy = ref.copy && typeof ref.copy === 'object' && !Array.isArray(ref.copy) ? ref.copy : null
  if (ref.collection !== '$doc' && Array.isArray(list) && copy && !findRecord(db, ref.collection, ref.id)) {
    const withCopy = { ...db, [ref.collection]: [...list, copy] } as unknown as DB
    return { label: describeRecord(withCopy, ref.collection, ref.id).label, href: null, removed: true }
  }
  if (ref.collection === '$doc' || findRecord(db, ref.collection, ref.id)) return { ...describeRecord(db, ref.collection, ref.id), removed: true }
  return { label: `${article(noun)} ${noun}`, href: null, removed: true }
}

/** The first letter in capitals, for a label that starts a sentence. */
export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Most records a notice names before "and N more". */
export const NAMED_IN_NOTICE = 3

/**
 * The records the server's copy replaced, newest first, for a notice: up to `max` named (removed ones
 * marked), and how many more there were (`refreshed` counts every one; the status names at most the last 20).
 */
export function refreshedNames(
  db: DB,
  refreshed: number,
  keys: readonly RefreshedRef[],
  max = NAMED_IN_NOTICE,
): { names: RefreshedLabel[]; more: number } {
  const names = [...keys]
    .reverse()
    .slice(0, max)
    .map((k) => describeRefreshed(db, k))
  return { names, more: Math.max(0, refreshed - names.length) }
}

/**
 * The refreshed notice in parts: the records whose copy the server replaced (with how many more were not
 * named, which go with them), the records it removed (the edit was dropped), and `moreAlone`: unnamed
 * records counted on their own when every named one was removed.
 */
export function refreshedParts(
  db: DB,
  refreshed: number,
  keys: readonly RefreshedRef[],
  max = NAMED_IN_NOTICE,
): { replaced: RefreshedLabel[]; more: number; removed: RefreshedLabel[]; moreAlone: number } {
  const { names, more } = refreshedNames(db, refreshed, keys, max)
  const replaced = names.filter((n) => !n.removed)
  const removed = names.filter((n) => n.removed)
  return replaced.length > 0 || removed.length === 0 ? { replaced, more, removed, moreAlone: 0 } : { replaced, more: 0, removed, moreAlone: more }
}

/** "Your edit to" or "Your edits to", by how many edits a sentence is about. */
export const editsTo = (n: number): string => (n === 1 ? 'Your edit to' : 'Your edits to')

/** The end of the sentence about replaced records, after the names. */
export const replacedTail = (n: number): string => (n === 1 ? " was replaced by your server's copy." : " were replaced by your server's copy.")

/** The end of the sentence about removed records, after the names. */
export const removedTail = (n: number): string =>
  n === 1 ? ' was dropped: it was removed on another computer.' : ' were dropped: they were removed on another computer.'

/** The sentence about unnamed records when every named one was removed. */
export const moreAloneText = (n: number): string => `${plural(n, 'more edit was', 'more edits were')} replaced by your server's copy.`

/**
 * The refreshed notice as plain sentences (the live region, and a fallback when no record is named). It
 * never says why the server's copy differed: another computer's newer change, or an older copy the server
 * was restored to (an imported backup), are both possible. A record the server no longer has is said to
 * be removed, and the edit dropped.
 */
export function refreshedText(db: DB, refreshed: number, keys: readonly RefreshedRef[], max = NAMED_IN_NOTICE): string {
  const { replaced, more, removed, moreAlone } = refreshedParts(db, refreshed, keys, max)
  if (replaced.length === 0 && removed.length === 0) {
    return refreshed === 1
      ? "This device's edit to 1 item was replaced by your server's copy."
      : `This device's edits to ${refreshed} items were replaced by your server's copy.`
  }
  const out: string[] = []
  if (replaced.length > 0) {
    const n = replaced.length + more
    out.push(`${editsTo(n)} ${joinAnd([...replaced.map((r) => r.label), ...(more > 0 ? [`${more} more`] : [])])}${replacedTail(n)}`)
  }
  if (removed.length > 0) out.push(`${editsTo(removed.length)} ${joinAnd(removed.map((r) => r.label))}${removedTail(removed.length)}`)
  if (moreAlone > 0) out.push(moreAloneText(moreAlone))
  return out.join(' ')
}

/** Over this, a record never syncs (MAX_RECORD_BYTES in src/sync/protocol.ts), in words. */
export const TOO_LARGE_LIMIT = '256 KB'

/**
 * Records whose long text the app lets you edit (a job's description, a candidate's summary, an email
 * template's message, a contractor's scope), so "Shorten it" is advice someone can follow. Any other
 * record is discarded and added again with shorter text.
 */
export const SHORTENABLE_COLLECTIONS: ReadonlySet<string> = new Set(['jobs', 'candidates', 'emailTemplates', 'contractors'])

/**
 * What to say about a change too large to sync, after its name (tooLargeText): a note cannot be edited,
 * so it is discarded and added again shorter; a record with an edit path for its long text can be
 * shortened; anything else is discarded and added again with shorter text.
 */
export function tooLargeTail(collection: string): string {
  if (collection === 'activity') return ` is too large to sync (over ${TOO_LARGE_LIMIT}). Discard it, then add a shorter one.`
  return SHORTENABLE_COLLECTIONS.has(collection)
    ? ` is too large to sync (over ${TOO_LARGE_LIMIT}). Shorten it, or discard this change.`
    : ` is too large to sync (over ${TOO_LARGE_LIMIT}). Discard this change, then add it again with shorter text.`
}

/** "A note on Priya Nair is too large to sync (over 256 KB). Discard it, then add a shorter one." */
export function tooLargeText(label: RecordLabel, collection: string): string {
  return `${capitalize(label.label)}${tooLargeTail(collection)}`
}

/**
 * Several changes too large to sync, in one sentence. collections: theirs, so "Shorten them" is said only
 * when every one can be shortened (see SHORTENABLE_COLLECTIONS).
 */
export function tooLargeManyText(n: number, collections: readonly string[] = []): string {
  const shortenable = collections.length > 0 && collections.every((c) => SHORTENABLE_COLLECTIONS.has(c))
  return shortenable
    ? `${n} changes are too large to sync (over ${TOO_LARGE_LIMIT}). Shorten them, or discard them.`
    : `${n} changes are too large to sync (over ${TOO_LARGE_LIMIT}). Discard them, then add them again with shorter text.`
}

/** What to say about changes the server itself refused (not too large ones). */
export function refusedText(n: number): string {
  return `Your server refused ${plural(n, 'change', 'changes')}. ${n === 1 ? 'It is' : 'They are'} kept on this device until you retry.`
}

/** When the next automatic retry runs, in words ("in 40 seconds", "in 2 minutes"), or null. */
export function retryIn(nextRetryAt: number | null, now: number): string | null {
  if (nextRetryAt == null) return null
  const s = Math.max(0, Math.round((nextRetryAt - now) / 1000))
  if (s <= 1) return 'in a moment'
  if (s < 60) return `in ${s} seconds`
  const m = Math.round(s / 60)
  return `in ${m} ${m === 1 ? 'minute' : 'minutes'}`
}

/** "just now", "4 minutes ago", "2 hours ago"; past a day, null (show the date instead). */
export function agoText(at: string | null, now: number): string | null {
  if (!at) return null
  const t = Date.parse(at)
  if (!Number.isFinite(t)) return null
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} ${m === 1 ? 'minute' : 'minutes'} ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} ${h === 1 ? 'hour' : 'hours'} ago`
  return null
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** The address to show for "your server": this page's origin, or the placeholder from the guide. */
export function serverAddress(origin: string | null | undefined): string {
  return origin && /^https?:\/\//.test(origin) ? origin : 'https://your-domain'
}

/**
 * Why the server check failed, worded for a browser that is not syncing yet (the engine's own texts
 * talk about queued changes, which do not exist before connecting).
 */
export function checkFailureText(f: { kind: string; status: number | null; message: string }, online: boolean, origin: string): string {
  if (f.kind === 'offline') {
    return online
      ? `Nothing answered at ${origin}. If your First Twenty server runs here, it may be stopped or restarting. Check again in a minute.`
      : 'This computer is offline. Connect to the internet, then check again.'
  }
  if (f.kind === 'server') {
    return f.status === 503
      ? 'A First Twenty server answers here, but its database does not. Check that Postgres is running, then check again.'
      : `The server at this address had a problem (error ${f.status ?? 500}). Check again in a minute. If it keeps happening, see Troubleshooting in the server guide.`
  }
  return f.message
}
