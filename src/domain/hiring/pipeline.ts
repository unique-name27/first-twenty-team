// Pipeline logic: stages, SLAs, the required next step, moves, rejections, quick logs, counts,
// mini funnels and the back-scheduling line. Rejected and Withdrew are outcomes, not stages.
//
// Mutation helpers take an Immer draft, change it, and log plain-language activity. They return
// true when something changed. Module rule: the store import stays LAST and this file keeps no
// module-level runtime constants, so the sample builder can call these helpers during store setup.
import type { Draft } from 'immer'
import { DEFAULT_STAGES } from '@/data/defaults'
import { isEmployedOn } from '@/domain/people'
import type { Application, DB, ID, Job, JobStage, Offer, OutcomeReason, StageKind } from '@/domain/types'
import { addBusinessDays, addDays, daysBetween, type ISODate, type ISODateTime } from '@/lib/dates'
import {
  businessDayOnOrBefore,
  businessDaysBetween,
  candidateName,
  cancelReservedGrants,
  cancelUnstartedInterviews,
  dbHolidays,
  extendRetention,
  fmtDayPlain,
  type HolidayInput,
  holidayDates,
  isOpenOfferStatus,
  lowerFirst,
  maxDate,
  median,
  openOffer,
  outcomeReasonLabel,
  pacificDateOf,
} from './util'
import { logActivity } from '@/store/draft'

export type NextStep = { text: string; dueOn: ISODate; ownerId: ID }
export type SlaState = 'ok' | 'due_soon' | 'over'
export type AttentionReason = 'no_next_step' | 'next_step_overdue' | 'past_sla' | 'waiting_too_long'

// ---- Stages ---------------------------------------------------------------------------------

/** The job's ordered stages (the default pipeline when a job has none). */
export function jobStages(job: Pick<Job, 'stages'>): JobStage[] {
  return job.stages && job.stages.length > 0 ? job.stages : DEFAULT_STAGES
}

export function stageIndex(job: Pick<Job, 'stages'>, stageId: string): number {
  return jobStages(job).findIndex((s) => s.id === stageId)
}

export function stageById(job: Pick<Job, 'stages'>, stageId: string): JobStage | undefined {
  return jobStages(job).find((s) => s.id === stageId)
}

export function stageKind(job: Pick<Job, 'stages'>, stageId: string): StageKind | undefined {
  return stageById(job, stageId)?.kind
}

export function firstStageOfKind(job: Pick<Job, 'stages'>, kind: StageKind): JobStage | undefined {
  return jobStages(job).find((s) => s.kind === kind)
}

export function nextStage(job: Pick<Job, 'stages'>, stageId: string): JobStage | undefined {
  const stages = jobStages(job)
  const i = stages.findIndex((s) => s.id === stageId)
  return i >= 0 ? stages[i + 1] : undefined
}

export function prevStage(job: Pick<Job, 'stages'>, stageId: string): JobStage | undefined {
  const stages = jobStages(job)
  const i = stages.findIndex((s) => s.id === stageId)
  return i > 0 ? stages[i - 1] : undefined
}

/** The last stage (Hired) ends the pipeline. */
export function isTerminal(job: Pick<Job, 'stages'>, stageId: string): boolean {
  const stages = jobStages(job)
  const i = stages.findIndex((s) => s.id === stageId)
  return i >= 0 && (stages[i].kind === 'hired' || i === stages.length - 1)
}

/** Furthest stage index the application has reached (its history plus where it is now). */
export function furthestStageIndex(job: Pick<Job, 'stages'>, app: Pick<Application, 'stageId' | 'history'>): number {
  let best = stageIndex(job, app.stageId)
  for (const h of app.history ?? []) best = Math.max(best, stageIndex(job, h.stageId))
  return Math.max(best, 0)
}

// ---- SLA and attention ----------------------------------------------------------------------

/** Business days since the application entered its current stage. */
export function businessDaysInStage(app: Pick<Application, 'stageEnteredOn'>, date: ISODate, holidays: HolidayInput = []): number {
  return businessDaysBetween(app.stageEnteredOn, date, holidays)
}

export type SlaDetail = {
  state: SlaState
  /** Business days in the stage so far. */
  days: number
  /** The stage SLA in business days (undefined for stages without one). */
  sla?: number
  /** When the SLA runs out (stage SLA date, or the offer expiry in the Offer stage). */
  dueOn?: ISODate
}

/**
 * SLA state for an active application. Stages count business days against their SLA (due soon with
 * one day or less left). In the Offer stage a sent offer is measured against its expiry date.
 */
export function slaDetail(job: Job, app: Application, date: ISODate, holidays: HolidayInput = [], offer?: Offer): SlaDetail {
  const days = businessDaysInStage(app, date, holidays)
  if (app.status !== 'active') return { state: 'ok', days }
  const stage = stageById(job, app.stageId)
  if (!stage) return { state: 'ok', days }
  if (stage.kind === 'offer' && offer && offer.status === 'sent' && offer.expiresOn) {
    const left = businessDaysBetween(date, offer.expiresOn, holidays)
    const state: SlaState = date > offer.expiresOn ? 'over' : left <= 1 ? 'due_soon' : 'ok'
    return { state, days, dueOn: offer.expiresOn }
  }
  const sla = stage.slaBusinessDays
  if (sla == null) return { state: 'ok', days }
  const left = sla - days
  const state: SlaState = left < 0 ? 'over' : left <= 1 ? 'due_soon' : 'ok'
  return { state, days, sla, dueOn: addBusinessDays(app.stageEnteredOn, sla, holidayDates(holidays)) }
}

export function slaState(job: Job, app: Application, date: ISODate, holidays: HolidayInput = [], offer?: Offer): SlaState {
  return slaDetail(job, app, date, holidays, offer).state
}

/** Interviews for the application that are still on the calendar on or after the date. */
export function hasUpcomingInterview(db: Pick<DB, 'interviews'>, appId: ID, date: ISODate): boolean {
  return db.interviews.some((i) => i.applicationId === appId && i.status === 'scheduled' && pacificDateOf(i.startsAt) >= date)
}

/**
 * The last time the candidate heard from us: applied, entered the stage, a logged contact, a
 * notification, or an interview that has happened.
 */
export function lastTouchOn(db: Pick<DB, 'interviews'>, app: Application, date: ISODate): ISODate {
  const interviewDays = db.interviews
    .filter((i) => i.applicationId === app.id && i.status !== 'cancelled')
    .map((i) => pacificDateOf(i.startsAt))
    .filter((d) => d <= date)
  return maxDate(app.appliedOn, app.stageEnteredOn, app.lastContactOn, app.notifiedOn, ...interviewDays) ?? app.appliedOn
}

/**
 * Why an active candidate needs attention: no next step, next step overdue, past the stage SLA (or a
 * sent offer past its expiry), or waiting more than settings.responseSlaBusinessDays business days
 * to hear back. Snoozed candidates are quiet until the snooze date.
 */
export function attentionReasons(db: DB, app: Application, date: ISODate): AttentionReason[] {
  if (app.status !== 'active') return []
  if (app.snoozedUntil && app.snoozedUntil > date) return []
  const job = db.jobs.find((j) => j.id === app.jobId)
  if (!job) return []
  const holidays = dbHolidays(db)
  const out: AttentionReason[] = []
  if (!app.nextStep) out.push('no_next_step')
  else if (app.nextStep.dueOn < date) out.push('next_step_overdue')
  if (slaState(job, app, date, holidays, openOffer(db, app.id)) === 'over') out.push('past_sla')
  const waited = businessDaysBetween(lastTouchOn(db, app, date), date, holidays)
  // Once the offer is accepted the candidate is not waiting to hear back; onboarding takes over.
  if (!app.conditionalOfferOn && waited > db.settings.responseSlaBusinessDays && !hasUpcomingInterview(db, app.id, date)) out.push('waiting_too_long')
  return out
}

export function attentionReasonLabel(r: AttentionReason): string {
  switch (r) {
    case 'no_next_step':
      return 'No next step'
    case 'next_step_overdue':
      return 'Next step overdue'
    case 'past_sla':
      return 'Past stage SLA'
    case 'waiting_too_long':
      return 'Waiting to hear back'
  }
}

// ---- Next step ------------------------------------------------------------------------------

/** Still on the team on the date (started, and not past their last day). */
function isCurrentPerson(db: Pick<DB, 'people'>, personId: ID | null | undefined, date: ISODate): boolean {
  if (!personId) return false
  const p = db.people.find((x) => x.id === personId)
  return !!p && isEmployedOn(p, date)
}

/**
 * Who owns a defaulted next step: the preferred person (an explicit owner or the current one) when
 * they still work here, else the job's hiring manager when they still work here, else the founder.
 * Next steps never land on someone who has left, where no live inbox would show them.
 */
export function ownerFor(db: Pick<DB, 'people'>, job: Pick<Job, 'hiringManagerId'> | null | undefined, date: ISODate, preferredId?: ID | null): ID {
  for (const id of [preferredId, job?.hiringManagerId]) if (id && isCurrentPerson(db, id, date)) return id
  const founderId = db.people.find((p) => p.isFounder && isEmployedOn(p, date))?.id ?? db.people.find((p) => p.isFounder)?.id
  return founderId ?? preferredId ?? job?.hiringManagerId ?? ''
}

/**
 * The default next step when an application enters a stage: review within the New SLA, schedule the
 * stage's interview within 2 business days, send the offer within 2. Hired has no next step. The
 * owner comes from ownerFor (never someone who has left).
 */
export function defaultNextStep(db: Pick<DB, 'holidays' | 'people'>, job: Job, stageId: string, date: ISODate, ownerId?: ID): NextStep | undefined {
  const stage = stageById(job, stageId)
  if (!stage) return undefined
  const holidays = dbHolidays(db)
  const owner = ownerFor(db, job, date, ownerId)
  const due = (n: number) => addBusinessDays(date, n, holidays)
  switch (stage.kind) {
    case 'new':
      return { text: 'Review application', dueOn: due(stage.slaBusinessDays ?? 3), ownerId: owner }
    case 'offer':
      return { text: 'Send offer', dueOn: due(2), ownerId: owner }
    case 'hired':
      return undefined
    default:
      return { text: `Schedule ${lowerFirst(stage.name)}`, dueOn: due(2), ownerId: owner }
  }
}

/** Next step after an interview: debrief and decide one business day after it happens. */
export function debriefNextStep(db: Pick<DB, 'holidays'>, interviewDate: ISODate, ownerId: ID): NextStep {
  return { text: 'Debrief and decide', dueOn: addBusinessDays(interviewDate, 1, dbHolidays(db)), ownerId }
}

// ---- Mutations ------------------------------------------------------------------------------

type ActOpts = { date: ISODate; actorId?: ID | null }

function findApp(draft: Draft<DB>, appId: ID) {
  return draft.applications.find((a) => a.id === appId)
}

function logApp(draft: Draft<DB>, app: { id: ID; candidateId: ID }, kind: string, text: string): void {
  logActivity(draft, { entityType: 'application', entityId: app.id, relatedId: app.candidateId, kind, text })
}

type MoveOpts = ActOpts & {
  ownerId?: ID
  /**
   * Only the Hire flow may move an application into Hired, because a hire also creates the Person,
   * converts the reserved grant and generates onboarding (src/domain/lifecycle.ts hireFromOffer,
   * which sets the hired status itself). Nothing passes this today.
   */
  viaHire?: boolean
}

/**
 * Moves an application to a stage: records history, resets the stage clock, clears any snooze and
 * sets the stage's default next step. Moving a rejected or withdrawn application reopens it.
 * Refuses (returns false) to move into Hired, which belongs to the Hire flow, and to move an
 * application that is already hired, whose Person record would be left behind.
 */
export function moveApplication(draft: Draft<DB>, appId: ID, toStageId: string, opts: MoveOpts): boolean {
  const app = findApp(draft, appId)
  if (!app) return false
  if (app.status === 'hired') return false
  const job = draft.jobs.find((j) => j.id === app.jobId)
  if (!job) return false
  const stage = stageById(job, toStageId)
  if (!stage) return false
  if (stage.kind === 'hired' && !opts.viaHire) return false
  if (app.stageId === toStageId && app.status === 'active') return false
  const reopened = app.status === 'rejected' || app.status === 'withdrawn'
  app.stageId = toStageId
  app.stageEnteredOn = opts.date
  app.history.push(opts.actorId ? { stageId: toStageId, at: opts.date, byId: opts.actorId } : { stageId: toStageId, at: opts.date })
  delete app.snoozedUntil
  if (stage.kind === 'hired') {
    app.status = 'hired'
    app.closedOn = opts.date
    delete app.nextStep
  } else {
    if (reopened) {
      delete app.outcomeReason
      delete app.outcomeNote
      delete app.closedOn
    }
    app.status = 'active'
    const step = defaultNextStep(draft, job, toStageId, opts.date, opts.ownerId ?? app.nextStep?.ownerId)
    if (step) app.nextStep = step
    else delete app.nextStep
  }
  const name = candidateName(draft, app.candidateId)
  logApp(draft, app, 'stage_moved', reopened ? `Reopened ${name} in ${stage.name}` : `Moved ${name} to ${stage.name}`)
  return true
}

/**
 * True when Advance would land in Hired. The UI sends the user to the Hire flow instead (threshold
 * preview, Person, grant, onboarding), so advanceApplication refuses this move.
 */
export function advanceNeedsHire(job: Pick<Job, 'stages'>, stageId: string): boolean {
  return nextStage(job, stageId)?.kind === 'hired'
}

/** Advances to the next stage (A in Sweep). Returns false from the Offer stage: use the Hire flow. */
export function advanceApplication(draft: Draft<DB>, appId: ID, opts: ActOpts & { ownerId?: ID }): boolean {
  const app = findApp(draft, appId)
  const job = app && draft.jobs.find((j) => j.id === app.jobId)
  if (!app || !job) return false
  const next = nextStage(job, app.stageId)
  if (!next || next.kind === 'hired') return false
  return moveApplication(draft, appId, next.id, { date: opts.date, ...(opts.actorId !== undefined ? { actorId: opts.actorId } : {}), ...(opts.ownerId ? { ownerId: opts.ownerId } : {}) })
}

type CloseOpts = ActOpts & {
  note?: string
  notified?: boolean
  /**
   * The current moment. Interviews that start after it come off the calendar; ones already under
   * way or done stay, with their scorecards. Without it, only interviews on later Pacific dates are
   * cancelled, so a same-day interview is never wiped.
   */
  nowISO?: ISODateTime
}

function closeApplication(
  draft: Draft<DB>,
  appId: ID,
  status: 'rejected' | 'withdrawn',
  reason: OutcomeReason,
  opts: CloseOpts,
): Draft<Application> | undefined {
  const app = findApp(draft, appId)
  if (!app || app.status === 'hired') return undefined
  app.status = status
  app.outcomeReason = reason
  if (opts.note) app.outcomeNote = opts.note
  app.closedOn = opts.date
  delete app.nextStep
  delete app.snoozedUntil
  if (opts.notified) {
    app.notifiedOn = opts.date
    app.lastContactOn = opts.date
  }
  // Interviews that have not started come off the calendar, with their owed scorecards.
  cancelUnstartedInterviews(draft, app.id, opts.date, opts.nowISO)
  closeOffersFor(draft, app, status, reason, opts.date)
  extendRetention(draft, app.candidateId, opts.date)
  return app
}

/**
 * Settles the application's offers when it closes, so no options stay reserved and the record says
 * who said no. When the candidate withdraws, an offer they had (sent or approved) or had accepted
 * but not yet started becomes 'declined' with the withdrawal reason. When we reject, it becomes
 * 'rescinded'. Unsent drafts are rescinded either way. Offers that became a hire are left alone.
 */
function closeOffersFor(draft: Draft<DB>, app: Draft<Application>, status: 'rejected' | 'withdrawn', reason: OutcomeReason, date: ISODate): void {
  const name = candidateName(draft, app.candidateId)
  for (const o of draft.offers) {
    if (o.applicationId !== app.id) continue
    const open = isOpenOfferStatus(o.status)
    const reneging = o.status === 'accepted' && !o.personId
    if (!open && !reneging) continue
    const wasAccepted = o.status === 'accepted'
    const candidateSaidNo = status === 'withdrawn' && (o.status === 'sent' || o.status === 'approved' || reneging)
    const unsent = o.status === 'draft' || o.status === 'awaiting_approval'
    o.decidedOn = date
    let kind: string
    let text: string
    if (candidateSaidNo) {
      o.status = 'declined'
      o.declineReason = reason
      kind = 'offer_declined'
      const why = outcomeReasonLabel(reason).toLowerCase()
      text = wasAccepted ? `${name} backed out after accepting the offer (${why})` : `${name} declined the offer (${why})`
    } else {
      o.status = 'rescinded'
      kind = 'offer_rescinded'
      text = unsent ? `Closed the unsent offer for ${name}` : `Rescinded the offer for ${name} when the application closed`
    }
    cancelReservedGrants(draft, o.id, date)
    logActivity(draft, { entityType: 'offer', entityId: o.id, relatedId: o.candidateId, kind, text })
  }
}

/** Rejects with one reason chip; optionally records that the candidate was told. */
export function rejectApplication(draft: Draft<DB>, appId: ID, reason: OutcomeReason, opts: CloseOpts): boolean {
  const app = closeApplication(draft, appId, 'rejected', reason, opts)
  if (!app) return false
  const name = candidateName(draft, app.candidateId)
  const told = opts.notified ? ' and sent a note' : ''
  logApp(draft, app, 'rejected', `Rejected ${name} (${outcomeReasonLabel(reason).toLowerCase()})${told}`)
  return true
}

/** The candidate withdrew (reason defaults to Withdrew). */
export function withdrawApplication(draft: Draft<DB>, appId: ID, reason: OutcomeReason = 'withdrew', opts: CloseOpts): boolean {
  const app = closeApplication(draft, appId, 'withdrawn', reason, opts)
  if (!app) return false
  const name = candidateName(draft, app.candidateId)
  const why = reason === 'withdrew' ? '' : ` (${outcomeReasonLabel(reason).toLowerCase()})`
  logApp(draft, app, 'withdrawn', `${name} withdrew${why}`)
  return true
}

export function setNextStep(draft: Draft<DB>, appId: ID, step: NextStep): boolean {
  const app = findApp(draft, appId)
  if (!app || app.status !== 'active') return false
  app.nextStep = { text: step.text.trim() || 'Follow up', dueOn: step.dueOn, ownerId: step.ownerId }
  logApp(draft, app, 'next_step', `Next step for ${candidateName(draft, app.candidateId)}: ${app.nextStep.text}, due ${fmtDayPlain(step.dueOn)}`)
  return true
}

/** Hides the candidate from the inbox until the date (Snooze 3 days in Sweep). */
export function snoozeApplication(draft: Draft<DB>, appId: ID, untilDate: ISODate): boolean {
  const app = findApp(draft, appId)
  if (!app || app.status !== 'active') return false
  app.snoozedUntil = untilDate
  logApp(draft, app, 'snoozed', `Snoozed ${candidateName(draft, app.candidateId)} until ${fmtDayPlain(untilDate)}`)
  return true
}

/** Records that the candidate was told the outcome (rejection or close-out note sent). */
export function markNotified(draft: Draft<DB>, appId: ID, opts: { date: ISODate }): boolean {
  const app = findApp(draft, appId)
  if (!app) return false
  app.notifiedOn = opts.date
  app.lastContactOn = opts.date
  logApp(draft, app, 'notified', `Notified ${candidateName(draft, app.candidateId)}`)
  return true
}

export type QuickLogKind = 'emailed' | 'called' | 'voicemail'

/** Quick-log buttons on the profile: Emailed, Called, Left voicemail. Updates the last contact date. */
export function quickLog(draft: Draft<DB>, appId: ID, kind: QuickLogKind, opts: { date: ISODate }): boolean {
  const app = findApp(draft, appId)
  if (!app) return false
  app.lastContactOn = opts.date
  const name = candidateName(draft, app.candidateId)
  const text = kind === 'emailed' ? `Emailed ${name}` : kind === 'called' ? `Called ${name}` : `Left ${name} a voicemail`
  logApp(draft, app, kind, text)
  return true
}

// ---- Counts and funnels ---------------------------------------------------------------------

export type StageCount = { stageId: string; name: string; kind: StageKind; count: number; applicationIds: ID[] }

/** Active applications per stage (the Hired column counts hires). */
export function pipelineCounts(db: Pick<DB, 'applications'>, job: Job): StageCount[] {
  const apps = db.applications.filter((a) => a.jobId === job.id)
  return jobStages(job).map((s) => {
    const ids = apps
      .filter((a) => a.stageId === s.id && (a.status === 'active' || (s.kind === 'hired' && a.status === 'hired')))
      .map((a) => a.id)
    return { stageId: s.id, name: s.name, kind: s.kind, count: ids.length, applicationIds: ids }
  })
}

export type FunnelStep = StageCount & {
  /** Aggregate counts from a closed job's archived funnel (not drillable). */
  archived: number
  total: number
}

/** Which archived-funnel bucket a stage kind maps to. */
export function archivedKey(kind: StageKind): keyof NonNullable<Job['archivedFunnel']> | undefined {
  switch (kind) {
    case 'new':
      return 'applied'
    case 'intro':
      return 'intro'
    case 'technical':
      return 'technical'
    case 'onsite':
      return 'onsite'
    case 'offer':
      return 'offers'
    case 'hired':
      return 'accepted'
    default:
      return undefined
  }
}

/**
 * Reached-stage counts: an application counts in every stage up to the furthest one in its history
 * (so the funnel never grows), plus any archived aggregate counts for closed jobs.
 */
export function miniFunnel(db: Pick<DB, 'applications'>, job: Job, apps?: Application[]): FunnelStep[] {
  const list = apps ?? db.applications.filter((a) => a.jobId === job.id)
  const stages = jobStages(job)
  const furthest = new Map(list.map((a) => [a.id, furthestStageIndex(job, a)]))
  const used = new Set<string>()
  return stages.map((s, i) => {
    const ids = list.filter((a) => (furthest.get(a.id) ?? 0) >= i || (s.kind === 'hired' && a.status === 'hired')).map((a) => a.id)
    const key = archivedKey(s.kind)
    let archived = 0
    if (key && job.archivedFunnel && !used.has(key)) {
      archived = job.archivedFunnel[key] ?? 0
      used.add(key)
    }
    return { stageId: s.id, name: s.name, kind: s.kind, count: ids.length, applicationIds: ids, archived, total: ids.length + archived }
  })
}

/** Active applications on the job that need attention today. */
export function stuckApplications(db: DB, job: Job, date: ISODate): ID[] {
  return db.applications.filter((a) => a.jobId === job.id && attentionReasons(db, a, date).length > 0).map((a) => a.id)
}

export function stuckCount(db: DB, job: Job, date: ISODate): number {
  return stuckApplications(db, job, date).length
}

/** Calendar days the job has been open (to its close date once closed). */
export function daysOpen(job: Pick<Job, 'openedOn' | 'postedOn' | 'closedOn'>, date: ISODate): number | null {
  const start = job.openedOn ?? job.postedOn
  if (!start) return null
  return Math.max(0, daysBetween(start, job.closedOn ?? date))
}

// ---- Back-scheduling ------------------------------------------------------------------------

export type BackSchedule = {
  text: string
  status: 'on_track' | 'tight' | 'at_risk'
  startBy: ISODate
  acceptBy: ISODate
  onsitesBy: ISODate
  basis: {
    acceptToStartDays: number
    acceptToStartN: number
    onsiteToAcceptDays: number
    onsiteToAcceptN: number
    /** True when at least one gap comes from the company's own history (3+ data points). */
    fromHistory: boolean
  }
}

/** Defaults when there is too little history: 5 weeks from acceptance to start, 2 from onsite to acceptance. */
export function backScheduleDefaults(): { acceptToStartDays: number; onsiteToAcceptDays: number; minN: number } {
  return { acceptToStartDays: 35, onsiteToAcceptDays: 14, minN: 3 }
}

/** The company's own stage gaps from history: offer accepted to start, onsite to accepted. */
export function stageGapHistory(db: DB): { acceptToStart: number[]; onsiteToAccept: number[] } {
  const acceptToStart = db.offers
    .filter((o) => o.status === 'accepted' && o.decidedOn && o.startDate)
    .map((o) => daysBetween(o.decidedOn as ISODate, o.startDate))
    .filter((n) => n >= 0)
  const onsiteToAccept: number[] = []
  for (const a of db.applications) {
    if (!a.conditionalOfferOn) continue
    const job = db.jobs.find((j) => j.id === a.jobId)
    if (!job) continue
    const onsite = a.history.find((h) => stageKind(job, h.stageId) === 'onsite')
    if (onsite) {
      const n = daysBetween(onsite.at, a.conditionalOfferOn)
      if (n >= 0) onsiteToAccept.push(n)
    }
  }
  return { acceptToStart, onsiteToAccept }
}

/**
 * 'To start by Mon Jan 11, accept an offer by Mon Dec 7 and run onsites by Mon Nov 23.' Gaps are the
 * company's own medians (rounded up to whole weeks) once there are 3 or more data points.
 */
export function backScheduleLine(db: DB, job: Job, date: ISODate): BackSchedule | null {
  if (!job.targetStart || job.status === 'filled' || job.status === 'closed') return null
  const d = backScheduleDefaults()
  const hist = stageGapHistory(db)
  const holidays = dbHolidays(db)
  const a2s = hist.acceptToStart.length >= d.minN ? (median(hist.acceptToStart) ?? d.acceptToStartDays) : d.acceptToStartDays
  const o2a = hist.onsiteToAccept.length >= d.minN ? (median(hist.onsiteToAccept) ?? d.onsiteToAcceptDays) : d.onsiteToAcceptDays
  const weeks = (n: number) => Math.max(1, Math.ceil(n / 7))
  const startBy = job.targetStart
  const acceptBy = businessDayOnOrBefore(addDays(startBy, -7 * weeks(a2s)), holidays)
  const onsitesBy = businessDayOnOrBefore(addDays(acceptBy, -7 * weeks(o2a)), holidays)
  const s = fmtDayPlain(startBy)
  const ac = fmtDayPlain(acceptBy)
  const on = fmtDayPlain(onsitesBy)
  let text: string
  let status: BackSchedule['status']
  if (acceptBy < date) {
    status = 'at_risk'
    text = `A ${s} start is at risk: hires here usually accept about ${weeks(a2s)} weeks before starting, which meant accepting by ${ac}.`
  } else if (onsitesBy < date) {
    status = 'tight'
    text = `To start by ${s}, accept an offer by ${ac}. Onsites should already be done (the target was ${on}).`
  } else {
    status = 'on_track'
    text = `To start by ${s}, accept an offer by ${ac} and run onsites by ${on}.`
  }
  return {
    text,
    status,
    startBy,
    acceptBy,
    onsitesBy,
    basis: {
      acceptToStartDays: a2s,
      acceptToStartN: hist.acceptToStart.length,
      onsiteToAcceptDays: o2a,
      onsiteToAcceptN: hist.onsiteToAccept.length,
      fromHistory: hist.acceptToStart.length >= d.minN || hist.onsiteToAccept.length >= d.minN,
    },
  }
}
