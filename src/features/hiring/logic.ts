// Pure helpers for the hiring pages: who sees which applications, job list rows, planned rows,
// SLA badges, the sweep queue and summary, the talent pool, candidate search, the timeline, stage
// editing and quick-add validation. No store imports: everything takes db (and a date) so it is
// testable. Rules come from src/domain (access.ts, hiring/*); this file only shapes data for the UI.
import { links } from '@/app/router'
import { canSeeApplication, canSeeCandidate, canSeeOthersScorecards, canSeePipeline } from '@/domain/access'
import {
  attentionReasons,
  type AttentionReason,
  businessDaysBetween,
  criminalHistoryLint,
  businessDaysInStage,
  dbHolidays,
  debrief,
  daysOpen,
  type FunnelStep,
  jobStages,
  lastTouchOn,
  miniFunnel,
  outcomeReasonLabel,
  ratingLabel,
  salaryHistoryLint,
  type SlaDetail,
  stageById,
  stageIndex,
  stuckCount,
  findDuplicates,
  nextStage,
} from '@/domain/hiring'
import { isCareersSiteCandidate } from '@/domain/hiring/sources'
import { planSlotStatus } from '@/domain/pay'
import { founder, fullName, personNameById } from '@/domain/people'
import type {
  Application,
  Candidate,
  DB,
  ID,
  Interview,
  InterviewStep,
  Job,
  JobStage,
  OutcomeReason,
  PlanSlot,
  Rating,
  SourceKind,
  StageKind,
  Viewer,
} from '@/domain/types'
import { type ISODate, type ISODateTime, localDateOf, parseDate, toISODate } from '@/lib/dates'
import { mailtoHref } from '@/lib/email'
import { MAX_RECORD_BYTES } from '@/sync/protocol'

// ---- Visibility -------------------------------------------------------------------------------

/**
 * Applications the viewer may open, computed once (same rule as access.canSeeApplication: admin sees
 * all; otherwise the full pipeline of jobs they hire for, plus applications they interview for).
 */
export function visibleApplicationIds(v: Viewer, db: DB): Set<ID> {
  if (v.role === 'admin') return new Set(db.applications.map((a) => a.id))
  const pipelineJobs = new Set(db.jobs.filter((j) => canSeePipeline(v, j)).map((j) => j.id))
  const mine = new Set<ID>()
  if (v.personId) for (const i of db.interviews) if (i.interviewerIds.includes(v.personId)) mine.add(i.applicationId)
  return new Set(db.applications.filter((a) => pipelineJobs.has(a.jobId) || mine.has(a.id)).map((a) => a.id))
}

/** Candidates the viewer may open (admin: everyone, including the talent pool with no application). */
export function visibleCandidateIds(v: Viewer, db: DB, appIds?: Set<ID>): Set<ID> {
  if (v.role === 'admin') return new Set(db.candidates.map((c) => c.id))
  const apps = appIds ?? visibleApplicationIds(v, db)
  return new Set(db.applications.filter((a) => apps.has(a.id)).map((a) => a.candidateId))
}

// ---- Job list -----------------------------------------------------------------------------------

export type NextInterview = { interview: Interview; candidateId: ID; candidateName: string; appId: ID }

export type JobRowData = {
  job: Job
  /** full = admin or hiring manager; panel = the viewer only interviews for this job. */
  access: 'full' | 'panel'
  funnel: FunnelStep[]
  active: number
  daysOpen: number | null
  stuck: number
  nextInterview: NextInterview | null
  backfillForName: string | null
}

const STATUS_RANK: Record<Job['status'], number> = { open: 0, draft: 1, on_hold: 2, filled: 3, closed: 4 }

export function compareJobs(a: Job, b: Job): number {
  return (
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    (a.priority === 'high' ? 0 : 1) - (b.priority === 'high' ? 0 : 1) ||
    (b.openedOn ?? b.closedOn ?? '').localeCompare(a.openedOn ?? a.closedOn ?? '') ||
    a.title.localeCompare(b.title)
  )
}

/** The next scheduled interview on a job (only the viewer's own when `onlyFor` is set). */
export function nextInterviewFor(db: DB, jobId: ID, nowISO: ISODateTime, onlyFor?: ID | null): NextInterview | null {
  const apps = new Map(db.applications.filter((a) => a.jobId === jobId).map((a) => [a.id, a]))
  let best: Interview | null = null
  for (const i of db.interviews) {
    if (i.status !== 'scheduled' || !apps.has(i.applicationId) || i.startsAt < nowISO) continue
    if (onlyFor && !i.interviewerIds.includes(onlyFor)) continue
    if (!best || i.startsAt < best.startsAt) best = i
  }
  if (!best) return null
  const app = apps.get(best.applicationId) as Application
  const c = db.candidates.find((x) => x.id === app.candidateId)
  return { interview: best, appId: app.id, candidateId: app.candidateId, candidateName: c ? `${c.firstName} ${c.lastName}` : 'Candidate' }
}

export function jobRowData(db: DB, v: Viewer, job: Job, date: ISODate, nowISO: ISODateTime): JobRowData {
  const access = canSeePipeline(v, job) ? 'full' : 'panel'
  const backfill = job.isBackfill && job.backfillForPersonId ? personNameById(db, job.backfillForPersonId, '') : ''
  return {
    job,
    access,
    funnel: access === 'full' ? miniFunnel(db, job) : [],
    active: access === 'full' ? db.applications.filter((a) => a.jobId === job.id && a.status === 'active').length : 0,
    daysOpen: job.status === 'draft' ? null : daysOpen(job, date),
    stuck: access === 'full' && (job.status === 'open' || job.status === 'on_hold' || job.status === 'draft') ? stuckCount(db, job, date) : 0,
    nextInterview: nextInterviewFor(db, job.id, nowISO, access === 'panel' ? v.personId : null),
    backfillForName: backfill || (job.isBackfill ? 'a departure' : null),
  }
}

/**
 * Headcount plan lines still waiting for a job: not cut or filled, and with no live linked job (a
 * draft, open, on hold or filled job already shows as its own row). Hiring managers see only lines
 * for their own department.
 */
export function plannedRows(db: DB, v: Viewer): PlanSlot[] {
  const live = new Set(db.jobs.filter((j) => j.status !== 'closed').map((j) => j.id))
  return db.plan
    .filter((s) => {
      if (s.status === 'cut' || s.status === 'filled') return false
      if (s.jobId && live.has(s.jobId)) return false
      const status = planSlotStatus(db, s)
      if (status === 'filled' || status === 'cut') return false
      if (v.role === 'admin') return true
      return !!v.person && v.person.departmentId === s.departmentId
    })
    .sort((a, b) => a.quarter.localeCompare(b.quarter) || a.targetStart.localeCompare(b.targetStart))
}

// ---- SLA badges ---------------------------------------------------------------------------------

export type SlaBadge = {
  /** Never 'bad': red is reserved for statutory deadlines, and a stage limit is a team habit. */
  tone: 'good' | 'warn' | 'neutral'
  icon?: 'alert' | 'clock'
  word: string
  /** Visible text: '7 days in stage, past SLA'. */
  text: string
  /** The limit in words, for screen readers and the hover title: 'Business days; the SLA is 5'. */
  detail: string
  title: string
}

/** '7 days in stage, past SLA' style badge text for a card. State is a word plus an icon and a color. */
export function slaBadge(d: SlaDetail): SlaBadge {
  const days = `${d.days} ${d.days === 1 ? 'day' : 'days'} in stage`
  if (d.sla == null && !d.dueOn) {
    const detail = 'Counted in business days. This stage has no SLA.'
    return { tone: 'neutral', word: '', text: days, detail, title: detail }
  }
  const offer = d.sla == null
  const left = d.sla != null ? Math.max(0, d.sla - d.days) : null
  const word =
    d.state === 'over'
      ? offer
        ? 'offer expired'
        : 'past SLA'
      : d.state === 'due_soon'
        ? offer
          ? 'offer expires soon'
          : left === 0
            ? 'last day'
            : `${left} day left`
        : 'on track'
  const tone = d.state === 'ok' ? 'good' : 'warn'
  const icon = d.state === 'over' ? 'alert' : d.state === 'due_soon' ? 'clock' : undefined
  const detail = offer ? 'Counted in business days. The limit is the offer expiry.' : `Counted in business days. The SLA for this stage is ${d.sla} business ${d.sla === 1 ? 'day' : 'days'}.`
  return { tone, ...(icon ? { icon } : {}), word, text: `${days}, ${word}`, detail, title: detail }
}

/**
 * Header text for a job's age: 'Requested Oct 10' for a job request, 'Draft since Oct 5' for other
 * drafts (never posted, so never 'days open'), else '24 days open'.
 */
export function jobAgeText(job: Pick<Job, 'status' | 'openedOn' | 'postedOn' | 'closedOn' | 'requisition'>, date: ISODate, fmt: (d: ISODate) => string): string | null {
  if (job.status === 'draft' && job.requisition?.status === 'pending') return `Requested ${fmt(job.requisition.requestedOn)}`
  if (job.status === 'draft') return job.openedOn ? `Draft since ${fmt(job.openedOn)}` : null
  const n = daysOpen(job, date)
  return n == null ? null : `${n} ${n === 1 ? 'day' : 'days'} open`
}

/**
 * The interview to schedule once a candidate lands in their current stage: the first step of the
 * job's interview plan for that stage with no live (scheduled or completed) interview yet.
 */
export function stepToSchedule(db: Pick<DB, 'jobs' | 'interviews'>, app: Application): InterviewStep | undefined {
  if (app.status !== 'active') return undefined
  const job = db.jobs.find((j) => j.id === app.jobId)
  if (!job) return undefined
  const live = db.interviews.filter((i) => i.applicationId === app.id && (i.status === 'scheduled' || i.status === 'completed'))
  // Someone already booked a custom interview for this stage by hand.
  if (live.some((i) => !i.stepId && i.stageId === app.stageId)) return undefined
  const done = new Set(live.map((i) => i.stepId).filter((s): s is string => !!s))
  return job.interviewPlan.find((s) => s.stageId === app.stageId && !done.has(s.id))
}

// ---- Sweep --------------------------------------------------------------------------------------

function urgency(reasons: AttentionReason[]): number {
  if (reasons.includes('past_sla')) return 0
  if (reasons.includes('no_next_step') || reasons.includes('next_step_overdue')) return 1
  if (reasons.length) return 2
  return 3
}

/**
 * Who to sweep on a job: by default the active candidates who need attention (no next step, next step
 * overdue, past SLA or waiting too long), most urgent first, longest in stage next. 'all' adds every
 * other active candidate. Accepted offers (onboarding) are left out.
 */
export function sweepQueue(db: DB, job: Job, date: ISODate, mode: 'attention' | 'all' = 'attention'): ID[] {
  const holidays = dbHolidays(db)
  return db.applications
    .filter((a) => a.jobId === job.id && a.status === 'active' && !a.conditionalOfferOn)
    .map((a) => ({ a, reasons: attentionReasons(db, a, date) }))
    .filter((x) => mode === 'all' || x.reasons.length > 0)
    .sort(
      (x, y) =>
        urgency(x.reasons) - urgency(y.reasons) ||
        businessDaysInStage(y.a, date, holidays) - businessDaysInStage(x.a, date, holidays) ||
        x.a.id.localeCompare(y.a.id),
    )
    .map((x) => x.a.id)
}

export type SweepCounts = { advanced: number; closedNotified: number; closed: number; snoozed: number; skipped: number }

export function emptySweepCounts(): SweepCounts {
  return { advanced: 0, closedNotified: 0, closed: 0, snoozed: 0, skipped: 0 }
}

/** '9 touched: 2 advanced, 4 closed with notes, 3 snoozed' (skips are listed after). */
export function sweepSummaryText(c: SweepCounts): string {
  const touched = c.advanced + c.closedNotified + c.closed + c.snoozed
  const parts: string[] = []
  if (c.advanced) parts.push(`${c.advanced} advanced`)
  if (c.closedNotified) parts.push(`${c.closedNotified} closed with notes`)
  if (c.closed) parts.push(`${c.closed} closed without a note`)
  if (c.snoozed) parts.push(`${c.snoozed} snoozed`)
  const skipped = c.skipped ? `${c.skipped} skipped` : ''
  if (!touched) return skipped ? `Nothing changed. ${capitalize(skipped)}.` : 'Nothing changed.'
  return `${touched} touched: ${parts.join(', ')}${skipped ? `. ${capitalize(skipped)}.` : ''}`
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Business days since the candidate last heard from us. */
export function daysWaiting(db: DB, app: Application, date: ISODate): number {
  return businessDaysBetween(lastTouchOn(db, app, date), date, dbHolidays(db))
}

export type LastActivity = { at: string; text: string }

/** The newest logged activity for an application (or its candidate), else its latest stage entry. */
export function lastActivityFor(db: DB, app: Application): LastActivity | null {
  let best: LastActivity | null = null
  for (const a of db.activity) {
    if (a.entityId !== app.id && !(a.relatedId === app.candidateId && a.entityType !== 'job')) continue
    if (!best || a.at > best.at) best = { at: a.at, text: a.text }
  }
  const job = db.jobs.find((j) => j.id === app.jobId)
  const h = app.history[app.history.length - 1]
  if (h && job && (!best || h.at > localDateOf(best.at))) {
    const stage = stageById(job, h.stageId)
    best = { at: h.at, text: `Moved to ${stage?.name ?? h.stageId}` }
  }
  return best
}

export type ScorecardSummary =
  | { kind: 'none' }
  | { kind: 'hidden'; owed: number }
  | { kind: 'shown'; submitted: number; total: number; overall: Rating[]; missing: string[] }

/** Scorecards for the sweep card, honoring 'hidden until you submit your own'. */
export function scorecardSummary(db: DB, v: Viewer, app: Application): ScorecardSummary {
  const d = debrief(db, app.id)
  if (d.columns.length === 0) return { kind: 'none' }
  if (!canSeeOthersScorecards(v, db, app)) {
    const owed = d.missing.filter((m) => m.interviewerId === v.personId).length
    return { kind: 'hidden', owed }
  }
  const overall = d.overall.filter((o) => !!o.rating).map((o) => o.rating as Rating)
  return { kind: 'shown', submitted: d.columns.filter((c) => c.submitted).length, total: d.columns.length, overall, missing: d.missing.map((m) => m.name) }
}

export function scorecardSummaryText(s: ScorecardSummary): string {
  if (s.kind === 'none') return 'No interviews yet'
  if (s.kind === 'hidden') return s.owed ? 'Hidden until you submit yours' : 'Hidden until you submit a scorecard'
  const ratings = s.overall.length ? `: ${s.overall.map((r) => ratingLabel(r)).join(', ')}` : ''
  const missing = s.missing.length ? ` (waiting on ${s.missing.join(', ')})` : ''
  return `${s.submitted} of ${s.total} in${ratings}${missing}`
}

// ---- Talent pool --------------------------------------------------------------------------------

export const POOL_TAGS = ['keep warm', 'silver medalist'] as const

export type PoolMatch = { candidate: Candidate; tags: string[]; fromJob: Job | null }

/**
 * Talent pool resurfacing: candidates tagged keep warm or silver medalist who were considered for a
 * job in the same role family, and are not already on this job. With a non-admin viewer, only
 * candidates they can already see (canSeeCandidate) come back, and 'from' names only a job whose
 * application they can see; admins see the whole pool.
 */
export function talentPool(db: DB, job: Job, viewer?: Viewer): PoolMatch[] {
  const onJob = new Set(db.applications.filter((a) => a.jobId === job.id).map((a) => a.candidateId))
  const jobsById = new Map(db.jobs.map((j) => [j.id, j]))
  const limited = viewer && viewer.role !== 'admin' ? viewer : null
  const out: PoolMatch[] = []
  for (const c of db.candidates) {
    if (c.anonymizedOn || onJob.has(c.id)) continue
    const tags = c.tags.filter((t) => (POOL_TAGS as readonly string[]).includes(t.toLowerCase()))
    if (!tags.length) continue
    if (limited && !canSeeCandidate(limited, db, c.id)) continue
    const apps = db.applications.filter((a) => a.candidateId === c.id).sort((a, b) => b.appliedOn.localeCompare(a.appliedOn))
    if (apps.some((a) => a.status === 'active' || a.status === 'hired')) continue
    const inFamily = apps.filter((a) => jobsById.get(a.jobId)?.familyId === job.familyId)
    if (!inFamily.length) continue
    const shown = limited ? inFamily.find((a) => canSeeApplication(limited, db, a)) : inFamily[0]
    out.push({ candidate: c, tags, fromJob: shown ? (jobsById.get(shown.jobId) ?? null) : null })
  }
  return out.sort((a, b) => a.candidate.lastName.localeCompare(b.candidate.lastName))
}

// ---- Candidates list ----------------------------------------------------------------------------

export type CandidateFlag = 'keep_warm' | 'silver' | 'referral' | 'archived'

/** The Source filter's choice for careers page applicants (inbound, source detail "Careers site"). */
export const CAREERS_SITE_FILTER = 'careers_site'

export type CandidateFilter = {
  q: string
  stage: StageKind | ''
  jobId: ID | ''
  /** A source kind, or CAREERS_SITE_FILTER for the inbound candidates who applied on the careers page. */
  source: SourceKind | typeof CAREERS_SITE_FILTER | ''
  flags: CandidateFlag[]
}

export type CandidateRow = {
  candidate: Candidate
  apps: Application[]
  /** The application to show first: the newest active one, else the newest. */
  primary: Application | null
  status: 'active' | 'hired' | 'closed' | 'pool'
  lastOn: ISODate
}

export function candidateRows(db: DB, candIds: Set<ID>, appIds: Set<ID>): CandidateRow[] {
  const byCand = new Map<ID, Application[]>()
  for (const a of db.applications) {
    if (!appIds.has(a.id)) continue
    const list = byCand.get(a.candidateId) ?? []
    list.push(a)
    byCand.set(a.candidateId, list)
  }
  const rows: CandidateRow[] = []
  for (const c of db.candidates) {
    if (!candIds.has(c.id)) continue
    const apps = (byCand.get(c.id) ?? []).sort((a, b) => b.appliedOn.localeCompare(a.appliedOn))
    const active = apps.find((a) => a.status === 'active')
    const primary = active ?? apps[0] ?? null
    const status: CandidateRow['status'] = !primary
      ? 'pool'
      : apps.some((a) => a.status === 'hired')
        ? 'hired'
        : active
          ? 'active'
          : 'closed'
    const dates = [c.createdOn, ...apps.map((a) => a.closedOn ?? a.stageEnteredOn), ...apps.map((a) => a.lastContactOn ?? '')].filter(Boolean)
    rows.push({ candidate: c, apps, primary, status, lastOn: dates.sort().pop() ?? c.createdOn })
  }
  return rows
}

function appStageKind(db: DB, a: Application): StageKind | undefined {
  if (a.status === 'hired') return 'hired'
  const job = db.jobs.find((j) => j.id === a.jobId)
  return job ? stageById(job, a.stageId)?.kind : undefined
}

export function filterCandidateRows(db: DB, rows: CandidateRow[], f: CandidateFilter): CandidateRow[] {
  const q = f.q.trim().toLowerCase()
  const jobTitles = new Map(db.jobs.map((j) => [j.id, j.title.toLowerCase()]))
  return rows.filter((r) => {
    const c = r.candidate
    if (f.flags.includes('archived') ? !c.archived : c.archived) return false
    if (f.flags.includes('keep_warm') && !c.tags.some((t) => t.toLowerCase() === 'keep warm')) return false
    if (f.flags.includes('silver') && !c.tags.some((t) => t.toLowerCase() === 'silver medalist')) return false
    if (f.flags.includes('referral') && c.source !== 'referral') return false
    if (f.source === CAREERS_SITE_FILTER ? !isCareersSiteCandidate(c) : f.source && c.source !== f.source) return false
    if (f.jobId && !r.apps.some((a) => a.jobId === f.jobId)) return false
    if (f.stage && !r.apps.some((a) => (a.status === 'active' || a.status === 'hired') && appStageKind(db, a) === f.stage)) return false
    if (q) {
      const hay = [
        c.firstName,
        c.lastName,
        `${c.firstName} ${c.lastName}`,
        c.email,
        c.currentTitle ?? '',
        c.currentCompany ?? '',
        c.location ?? '',
        c.sourceDetail ?? '',
        ...c.tags,
        ...r.apps.map((a) => jobTitles.get(a.jobId) ?? ''),
      ]
        .join(' \n ')
        .toLowerCase()
      if (!q.split(/\s+/).every((w) => hay.includes(w))) return false
    }
    return true
  })
}

// ---- Timeline -----------------------------------------------------------------------------------

export type TimelineItem = {
  id: string
  /** ISO date or timestamp, for sorting. */
  at: string
  kind: string
  text: string
  actorId?: ID | null
  appId?: ID
  preview?: boolean
}

/**
 * The candidate's story: logged activity (notes, quick logs, moves, offers, interviews) plus the
 * applications' own stage history and outcomes where nothing was logged for them. Newest first.
 */
export function candidateTimeline(db: DB, candidateId: ID, appIds: ID[]): TimelineItem[] {
  const apps = db.applications.filter((a) => a.candidateId === candidateId && appIds.includes(a.id))
  const appSet = new Set(apps.map((a) => a.id))
  const offerIds = new Set(db.offers.filter((o) => appSet.has(o.applicationId)).map((o) => o.id))
  const interviewIds = new Set(db.interviews.filter((i) => appSet.has(i.applicationId)).map((i) => i.id))
  const items: TimelineItem[] = []
  const logged = new Set<string>() // appId|kind|date
  for (const a of db.activity) {
    const mine =
      (a.entityType === 'candidate' && a.entityId === candidateId) ||
      (a.entityType === 'application' && appSet.has(a.entityId)) ||
      (a.entityType === 'offer' && offerIds.has(a.entityId)) ||
      (a.entityType === 'interview' && interviewIds.has(a.entityId))
    if (!mine) continue
    items.push({
      id: a.id,
      at: a.at,
      kind: a.kind,
      text: a.text,
      actorId: a.actorId ?? null,
      ...(a.entityType === 'application' ? { appId: a.entityId } : {}),
      ...(a.viewingAs && a.viewingAs !== 'admin' ? { preview: true } : {}),
    })
    if (a.entityType === 'application') logged.add(`${a.entityId}|${a.kind}|${localDate(a.at)}`)
  }
  for (const app of apps) {
    const job = db.jobs.find((j) => j.id === app.jobId)
    const title = job?.title ?? 'a job'
    app.history.forEach((h, i) => {
      const stage = job ? stageById(job, h.stageId) : undefined
      const name = stage?.name ?? h.stageId
      if (i === 0) {
        if (!logged.has(`${app.id}|application_added|${h.at}`)) {
          items.push({ id: `${app.id}-h0`, at: h.at, kind: 'applied', text: `Applied for ${title} (${name})`, appId: app.id })
        }
        return
      }
      if (logged.has(`${app.id}|stage_moved|${h.at}`)) return
      items.push({ id: `${app.id}-h${i}`, at: h.at, kind: 'stage_moved', text: `Moved to ${name} (${title})`, actorId: h.byId ?? null, appId: app.id })
    })
    if ((app.status === 'rejected' || app.status === 'withdrawn') && app.closedOn && !logged.has(`${app.id}|${app.status}|${app.closedOn}`)) {
      const reason = outcomeReasonLabel(app.outcomeReason).toLowerCase()
      items.push({
        id: `${app.id}-closed`,
        at: app.closedOn,
        kind: app.status,
        text: app.status === 'rejected' ? `Rejected for ${title} (${reason})` : `Withdrew from ${title}${app.outcomeReason && app.outcomeReason !== 'withdrew' ? ` (${reason})` : ''}`,
        appId: app.id,
      })
    }
    if (app.notifiedOn && !logged.has(`${app.id}|notified|${app.notifiedOn}`) && !logged.has(`${app.id}|rejected|${app.notifiedOn}`)) {
      items.push({ id: `${app.id}-notified`, at: app.notifiedOn, kind: 'notified', text: `Notified about ${title}`, appId: app.id })
    }
  }
  return items.sort((a, b) => sortKey(b.at).localeCompare(sortKey(a.at)) || b.id.localeCompare(a.id))
}

/** Local calendar date of a timestamp (activity is stored in UTC; history uses local dates). */
export function localDate(at: string): ISODate {
  return at.length <= 10 ? at : toISODate(parseDate(at))
}

/** Sort key in local time: a date-only entry sorts at the start of its day. */
function sortKey(at: string): string {
  if (at.length <= 10) return `${at}T00:00:00`
  const d = parseDate(at)
  return `${toISODate(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

// ---- Messages -----------------------------------------------------------------------------------

/** A short acknowledgment when a candidate withdraws (no stored template needed). */
export function withdrawalMessage(db: DB, appId: ID): { to: string; subject: string; body: string; mailto: string } | null {
  const app = db.applications.find((a) => a.id === appId)
  const cand = app && db.candidates.find((c) => c.id === app.candidateId)
  const job = app && db.jobs.find((j) => j.id === app.jobId)
  if (!app || !cand || !job) return null
  const f = founder(db)
  const sender = f ? fullName(f) : db.company.name
  const subject = `Thanks for letting us know`
  const body = `Hi ${cand.firstName},\n\nThank you for letting us know, and for the time you spent with us on the ${job.title} role. I understand, and I wish you the best with what comes next. If the timing changes, our door is open.\n\n${sender}`
  return { to: cand.email, subject, body, mailto: mailtoHref(cand.email, subject, body) }
}

// ---- Reasons ------------------------------------------------------------------------------------

/** Reason chips for a rejection (withdrawal and close-out reasons have their own flows). */
export function rejectReasons(db: DB): OutcomeReason[] {
  const list = db.settings.outcomeReasons?.length ? db.settings.outcomeReasons : (['not_a_fit_level', 'skills_gap', 'chose_other_offer', 'comp', 'location', 'timing', 'no_response'] as OutcomeReason[])
  return list.filter((r) => r !== 'withdrew' && r !== 'position_filled')
}

export function withdrawReasons(db: DB): OutcomeReason[] {
  const allowed: OutcomeReason[] = ['withdrew', 'chose_other_offer', 'comp', 'location', 'timing', 'other']
  const configured = new Set(db.settings.outcomeReasons ?? [])
  return allowed.filter((r) => r === 'withdrew' || configured.size === 0 || configured.has(r))
}

// ---- Stage editing ------------------------------------------------------------------------------

/** Why a stage cannot be removed from a job, or null when it can. */
export function stageRemovalBlock(db: DB, job: Job, stages: JobStage[], stageId: string): string | null {
  const stage = stages.find((s) => s.id === stageId)
  if (!stage) return null
  if (stage.kind === 'new' || stage.kind === 'offer' || stage.kind === 'hired') return `${stage.name} is part of every pipeline.`
  const n = db.applications.filter((a) => a.jobId === job.id && a.stageId === stageId && a.status === 'active').length
  if (n > 0) return `${n} ${n === 1 ? 'candidate is' : 'candidates are'} in ${stage.name}. Move them first.`
  return null
}

/** Adds a Recruiter screen stage right after New (once there is a recruiter). */
export function withRecruiterScreen(stages: JobStage[]): JobStage[] {
  if (stages.some((s) => s.kind === 'recruiter_screen')) return stages
  const i = stages.findIndex((s) => s.kind === 'new')
  const out = [...stages]
  out.splice(i + 1, 0, { id: 'recruiter_screen', kind: 'recruiter_screen', name: 'Recruiter screen', slaBusinessDays: 3 })
  return out
}

/** Adds a custom stage just before Offer. */
export function withCustomStage(stages: JobStage[], name: string): JobStage[] {
  const used = new Set(stages.map((s) => s.id))
  let n = 1
  while (used.has(`custom-${n}`)) n += 1
  const stage: JobStage = { id: `custom-${n}`, kind: 'custom', name: name.trim() || `Stage ${n}`, slaBusinessDays: 5 }
  const i = stages.findIndex((s) => s.kind === 'offer')
  const out = [...stages]
  out.splice(i >= 0 ? i : out.length, 0, stage)
  return out
}

/** Moves a middle stage up or down; New stays first and Offer and Hired stay last. */
export function moveStage(stages: JobStage[], stageId: string, dir: -1 | 1): JobStage[] {
  const i = stages.findIndex((s) => s.id === stageId)
  const j = i + dir
  if (i < 0 || j < 0 || j >= stages.length) return stages
  const fixed = (s: JobStage) => s.kind === 'new' || s.kind === 'offer' || s.kind === 'hired'
  if (fixed(stages[i]) || fixed(stages[j])) return stages
  const out = [...stages]
  ;[out[i], out[j]] = [out[j], out[i]]
  return out
}

/** Stage ids an application could be moved to by 'Move to…' (Hired belongs to the Hire flow). */
export function moveTargets(job: Job, app: Application): JobStage[] {
  return jobStages(job).filter((s) => s.id !== app.stageId || app.status !== 'active')
}

export function isLaterStage(job: Job, from: string, to: string): boolean {
  return stageIndex(job, to) > stageIndex(job, from)
}

// ---- Quick add ----------------------------------------------------------------------------------

export type QuickAddFields = {
  firstName: string
  lastName: string
  email: string
  phone: string
  linkedin: string
  github: string
  location: string
  currentTitle: string
  currentCompany: string
}

/**
 * Splits duplicate matches into the ones the viewer may see (and so may name, open or attach) and
 * whether any match is hidden from them. A hiring manager never learns who a hidden match is, and
 * never attaches them to a job (that would reveal their desired pay, tags and other jobs).
 */
export function visibleDuplicates(db: DB, v: Viewer, matches: ID[]): { visible: ID[]; hidden: boolean } {
  if (v.role === 'admin') return { visible: matches, hidden: false }
  const visible = matches.filter((id) => canSeeCandidate(v, db, id))
  return { visible, hidden: visible.length < matches.length }
}

/**
 * Duplicate matches for quick add. Email, LinkedIn and GitHub are strong matches: the same person, so
 * a match already on the job blocks the add. A phone-only match is soft (a shared office line in a
 * pasted signature is common): it is shown as 'may be the same person' and never blocks. Hidden
 * strong matches are flagged without a name; hidden phone-only matches are left out entirely.
 */
export function quickAddMatches(
  db: DB,
  v: Viewer,
  f: Pick<QuickAddFields, 'email' | 'linkedin' | 'github' | 'phone'>,
): { strong: ID[]; strongHidden: boolean; phoneOnly: ID[] } {
  const strongAll = findDuplicates(db, { email: f.email, linkedin: f.linkedin, github: f.github })
  const phoneAll = findDuplicates(db, { phone: f.phone }).filter((id) => !strongAll.includes(id))
  const strong = visibleDuplicates(db, v, strongAll)
  return { strong: strong.visible, strongHidden: strong.hidden, phoneOnly: visibleDuplicates(db, v, phoneAll).visible }
}

/** What stops a quick add, in plain words (empty when it can be added). */
export function quickAddProblems(f: QuickAddFields): string[] {
  const out: string[] = []
  if (!f.firstName.trim()) out.push('Add a first name.')
  if (!f.email.trim() && !f.phone.trim() && !f.linkedin.trim() && !f.github.trim()) out.push('Add an email, phone, LinkedIn or GitHub so you can reach them.')
  if (f.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) out.push('The email does not look right.')
  return out
}

const TZ_BY_STATE: Record<string, string> = {}
for (const [tz, states] of Object.entries({
  'America/Los_Angeles': 'CA WA OR NV',
  'America/Denver': 'CO UT NM MT WY ID',
  'America/Phoenix': 'AZ',
  'America/Chicago': 'TX IL MN WI MO IA KS OK NE ND SD LA AR MS AL TN',
  'America/New_York': 'NY NJ MA PA FL GA NC SC VA MD DC DE CT RI NH VT ME OH MI IN KY WV',
  'Pacific/Honolulu': 'HI',
  'America/Anchorage': 'AK',
})) {
  for (const s of states.split(' ')) TZ_BY_STATE[s] = tz
}

const STATE_NAMES: Record<string, string> = {
  california: 'CA', washington: 'WA', oregon: 'OR', nevada: 'NV', colorado: 'CO', utah: 'UT', arizona: 'AZ', texas: 'TX',
  illinois: 'IL', minnesota: 'MN', 'new york': 'NY', 'new jersey': 'NJ', massachusetts: 'MA', pennsylvania: 'PA', florida: 'FL',
  georgia: 'GA', 'north carolina': 'NC', virginia: 'VA', maryland: 'MD', ohio: 'OH', michigan: 'MI', hawaii: 'HI', alaska: 'AK',
}

/** A US time zone guessed from 'City, ST' (or a Bay Area label); undefined when unknown. */
export function guessTimezone(location: string | undefined | null): string | undefined {
  if (!location) return undefined
  if (/bay area|silicon valley/i.test(location)) return 'America/Los_Angeles'
  const m = location.match(/,\s*([A-Za-z .]+)\s*$/)
  if (!m) return undefined
  const raw = m[1].trim()
  const code = raw.length === 2 ? raw.toUpperCase() : STATE_NAMES[raw.toLowerCase()]
  return code ? TZ_BY_STATE[code] : undefined
}

/** People who can own a next step or sit on a panel: employed today or starting soon. */
export function teamOptions(db: DB, date: ISODate): Array<{ value: ID; label: string }> {
  return db.people
    .filter((p) => (!p.endDate || p.endDate >= date) && p.startDate <= date)
    .sort((a, b) => fullName(a).localeCompare(fullName(b)))
    .map((p) => ({ value: p.id, label: fullName(p) }))
}

// ---- Free-text guardrails ---------------------------------------------------------------------

/** The date of the candidate's conditional offer on any application, or null when there is none. */
export function candidateOfferOn(db: Pick<DB, 'applications'>, candidateId: ID): ISODate | null {
  return db.applications.find((a) => a.candidateId === candidateId && a.conditionalOfferOn)?.conditionalOfferOn ?? null
}

export type TextIssue = { law: 'pay' | 'criminal'; text: string; blocks: boolean }

/**
 * Checks free text about a candidate (notes, scorecard notes, the private reject note, highlights,
 * referral text). Pay history is a gentle warning (Labor Code 432.3), or blocks with `blockPay`.
 * Criminal history blocks the save until a conditional offer exists (Fair Chance Act, Gov Code
 * 12952; the app applies it at every company size); after one it is a warning to keep status only.
 */
export function textIssues(text: string, opts: { conditionalOfferOn?: string | null; blockPay?: boolean } = {}): TextIssue[] {
  const out: TextIssue[] = []
  const lintOpts = { conditionalOfferOn: opts.conditionalOfferOn ?? null }
  const crime = criminalHistoryLint(text, lintOpts)
  const first = salaryHistoryLint(text, lintOpts)
  // salaryHistoryLint returns the pay warning first, else the criminal one: a different message means pay matched.
  if (first && first !== crime) {
    out.push(
      opts.blockPay
        ? { law: 'pay', blocks: true, text: 'Take out what they earn or earned. California bars employers from asking about or relying on pay history.' }
        : { law: 'pay', blocks: false, text: first },
    )
  }
  if (crime) out.push({ law: 'criminal', blocks: !opts.conditionalOfferOn, text: crime })
  // What stops the save reads first.
  return out.sort((a, b) => Number(b.blocks) - Number(a.blocks))
}

/** The field error for the first issue that blocks a save, or undefined. */
export function textIssueError(issues: TextIssue[]): string | undefined {
  const b = issues.find((i) => i.blocks)
  if (!b) return undefined
  return b.law === 'criminal' ? 'Criminal history cannot be saved before a conditional offer. Take it out to save.' : 'Pay history cannot be saved. Take it out to save.'
}

// ---- Note length (sync limit) -----------------------------------------------------------------

/**
 * The longest note one box accepts. Each record syncs as at most 256 KB (docs/SYNC.md), and a note,
 * scorecard note or offer note lives inside one record, so a single box stays far below that.
 */
export const NOTE_MAX_CHARS = 20_000

/** Show the character count once a note gets this close to the limit. */
export const NOTE_COUNT_FROM = 18_000

/** The record a note is saved into may not pass this many characters of JSON (under the 256 KB limit). */
export const RECORD_MAX_CHARS = 200_000

/**
 * Why a note cannot be saved: longer than NOTE_MAX_CHARS, or the record it lands in would pass
 * RECORD_MAX_CHARS of JSON once it is added (`recordChars`: the record's JSON length before it).
 */
export function noteLengthError(text: string, recordChars = 0): string | undefined {
  if (text.length > NOTE_MAX_CHARS) return `Notes can be up to ${NOTE_MAX_CHARS.toLocaleString('en-US')} characters. Shorten this one.`
  if (recordChars + JSON.stringify(text).length > RECORD_MAX_CHARS) return 'This note is too long to sync. Shorten it.'
  return undefined
}

/** '18,250 of 20,000 characters' near the limit, else null. */
export function noteCountText(text: string): string | null {
  return text.length >= NOTE_COUNT_FROM ? `${text.length.toLocaleString('en-US')} of ${NOTE_MAX_CHARS.toLocaleString('en-US')} characters` : null
}

// ---- Job size (sync limit) --------------------------------------------------------------------

/** The longest job description the box accepts (maxLength). A long posting runs a few thousand characters. */
export const JOB_DESC_MAX_CHARS = 20_000

/** '18,250 of 20,000 characters' once a job description gets near the limit, else null. */
export function jobDescCountText(text: string): string | null {
  return text.length >= JOB_DESC_MAX_CHARS - 2_000 ? `${text.length.toLocaleString('en-US')} of ${JOB_DESC_MAX_CHARS.toLocaleString('en-US')} characters` : null
}

/**
 * Why a job cannot be saved for its size: a description over JOB_DESC_MAX_CHARS, or a job record whose
 * JSON passes MAX_RECORD_BYTES (the most the server takes for one record), so the change could never
 * sync. Pass `descriptionChanged: false` when the description was not edited, so an older long one does
 * not block other edits (the record check still applies).
 */
export function jobSizeError(job: Job, opts: { descriptionChanged?: boolean } = {}): string | undefined {
  if (opts.descriptionChanged !== false && job.description.length > JOB_DESC_MAX_CHARS) {
    return `A job description can be up to ${JOB_DESC_MAX_CHARS.toLocaleString('en-US')} characters. Shorten this one.`
  }
  if (new TextEncoder().encode(JSON.stringify(job)).length > MAX_RECORD_BYTES) return 'This job is too large to sync. Shorten the description.'
  return undefined
}

// ---- Remote jobs and locations ----------------------------------------------------------------

type JobLocation = Pick<DB['locations'][number], 'id' | 'kind' | 'state'>

/** True when no remote location is picked (only offices, or nothing), which a remote job should not quote. */
export function officeOnly(locations: JobLocation[], selected: ID[]): boolean {
  return !locations.some((l) => l.kind === 'remote' && selected.includes(l.id))
}

/**
 * The locations to pick when a job's work mode becomes Remote and only offices are picked: the
 * workspace's remote location in the same state as the first office (Remote (California) for San Jose
 * HQ), else its first remote location. The posting and the offer letter quote the location, so a remote
 * job left on the office would give the HQ street address. Undefined when nothing should change: a
 * remote location is already picked, or the workspace has none (the sheet shows a hint instead).
 */
export function remoteLocationsFor(locations: JobLocation[], selected: ID[]): ID[] | undefined {
  if (!officeOnly(locations, selected)) return undefined
  const remotes = locations.filter((l) => l.kind === 'remote')
  const state = locations.find((l) => selected.includes(l.id))?.state
  const best = remotes.find((l) => l.state === state) ?? remotes[0]
  return best ? [best.id] : undefined
}

// ---- Pay sanity -------------------------------------------------------------------------------

/**
 * A typo check for pay fields: annual pay above $2,000,000 or an hourly rate above $1,000 is almost
 * certainly a slip (an extra digit, two numbers run together). Returns the field error, or undefined.
 */
export function payTooHighError(value: number | null | undefined, basis: 'annual' | 'hourly'): string | undefined {
  if (value == null) return undefined
  return value > (basis === 'hourly' ? 1_000 : 2_000_000) ? 'That looks too high. Check the number.' : undefined
}

// ---- Desired pay unit -------------------------------------------------------------------------

/**
 * True when a candidate's desired pay can be asked by the hour for these jobs: one is posted with an
 * hourly range (under $1,000, as payRangeLine reads it) or is part time. Desired pay only, never pay
 * history (Labor Code 432.3).
 */
export function hourlyDesiredFits(jobs: Array<Pick<Job, 'payMax' | 'employmentType'> | undefined>): boolean {
  return jobs.some((j) => !!j && ((j.payMax != null && j.payMax < 1000) || j.employmentType === 'part_time'))
}

/**
 * The amount when the desired pay unit switches. A figure that only makes sense in the new unit is
 * converted at 2,080 hours ($62,000 a year becomes $29.75 an hour, $30 an hour becomes $62,000 a year);
 * one that already reads right in the new unit (typed before the unit was picked) stays as typed.
 */
export function switchDesiredUnit(amount: number | null, to: 'year' | 'hour'): number | null {
  if (amount == null) return null
  if (to === 'hour') return amount >= 1000 ? Math.round((amount / 2080) * 4) / 4 : amount
  return amount < 1000 ? Math.round((amount * 2080) / 1000) * 1000 : amount
}

// ---- Edit sheets: save only what changed ------------------------------------------------------

function sameJSON(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

/** The fields the user changed in an edit sheet: `draft` against the record as it was when the sheet opened. */
export function changedFields<T extends object>(initial: T, draft: T): Array<keyof T> {
  return (Object.keys(draft) as Array<keyof T>).filter((k) => !sameJSON(initial[k], draft[k]))
}

/**
 * Fields the user changed that also changed in the store since the sheet opened (another computer
 * saved them, and a pull brought it in): saving would overwrite that change. Fields where both sides
 * landed on the same value are not conflicts.
 */
export function conflictingFields<T extends object>(initial: T, draft: T, current: T): Array<keyof T> {
  return changedFields(initial, draft).filter((k) => !sameJSON(current[k], initial[k]) && !sameJSON(current[k], draft[k]))
}

// ---- Sender without a work email -------------------------------------------------------------

/**
 * What to say when the person a hiring email goes out from has no work email on file (Start fresh never
 * guesses one): the same words on the interview invite, the close-out note and the welcome banner. Only
 * Admin sets work emails (on the person page), so other views say to ask Admin.
 */
export function missingWorkEmailHint(
  viewer: Pick<Viewer, 'role' | 'personId'>,
  senderId: ID | null | undefined,
  senderName: string,
): { text: string; link?: { href: string; label: string } } {
  const self = !!senderId && senderId === viewer.personId
  const whose = self ? 'your' : `${senderName}'s`
  const reach = self ? 'replies reach you' : 'replies reach them'
  if (viewer.role !== 'admin') return { text: `Ask Admin to add ${whose} work email to ${self ? 'your' : 'their'} profile so ${reach}.` }
  return {
    text: `Add ${whose} work email to ${self ? 'your' : 'their'} profile so ${reach}.`,
    link: senderId ? { href: links.person(senderId), label: self ? 'Open your profile' : 'Open their profile' } : { href: links.settings('company'), label: 'Open Settings' },
  }
}

/**
 * The stage the candidate page's Advance button moves an active application to, or null when there is none
 * to show: closed or hired applications, and the Offer stage, whose next step (Hired) belongs to the Hire
 * flow in the offer below.
 */
export function advanceTarget(job: Pick<Job, 'stages'>, app: Pick<Application, 'stageId' | 'status'>): JobStage | null {
  if (app.status !== 'active') return null
  const next = nextStage(job, app.stageId)
  return next && next.kind !== 'hired' ? next : null
}
