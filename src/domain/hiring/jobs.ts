// Jobs: build a job from a role template (title, level, band, posted range, JD outline, interview
// plan and hiring manager prefill), mark it posted (hard stop 1 at 15+ without a pay range), change
// status, close out the remaining candidates, and turn on a credit check with a Labor Code 1024.5
// basis. Opening a job from a headcount plan line lives in src/domain/lifecycle.ts (openJobFromPlan).
// Module rule: the store import stays LAST and there are no module-level runtime constants.
import type { Draft } from 'immer'
import { DEFAULT_STAGES } from '@/data/defaults'
import type { DB, ID, Job, RoleTemplate } from '@/domain/types'
import { type ISODate } from '@/lib/dates'
import { newId } from '@/lib/id'
import { creditNoticeItemId } from './backgroundChecks'
import { creditCheckNoticeTask, CREDIT_CHECK_BASES } from './fairChance'
import { bandFor } from './offers'
import { rejectApplication } from './pipeline'
import { postingBlockReason } from './postings'
import { logActivity } from '@/store/draft'

export type JobResult = { ok: true } | { ok: false; reason: string }

export function roleTemplates(db: Pick<DB, 'settings'>): RoleTemplate[] {
  return db.settings.roleTemplates ?? []
}

/** A template as a picker shows it: 'Customer success manager (CPA preferred)'. The job title is the name alone. */
export function templateLabel(template: Pick<RoleTemplate, 'name' | 'hint'>): string {
  return template.hint?.trim() ? `${template.name} (${template.hint.trim()})` : template.name
}

/** The template for a family and level: exact match first, then the same family. */
export function findTemplateFor(db: Pick<DB, 'settings'>, familyId: ID, levelId?: ID): RoleTemplate | undefined {
  const list = roleTemplates(db)
  return list.find((t) => t.familyId === familyId && t.levelId === levelId) ?? list.find((t) => t.familyId === familyId)
}

export type JobFromTemplateOpts = {
  id?: ID
  date: ISODate
  hiringManagerId: ID
  title?: string
  familyId?: ID
  levelId?: ID
  departmentId?: ID
  locationIds?: ID[]
  workMode?: Job['workMode']
  planSlotId?: ID | null
  targetStart?: ISODate
  isBackfill?: boolean
  backfillForPersonId?: ID | null
}

/** The usual team for each job family track (default department ids). */
function trackDepartments(): Record<string, ID> {
  return { engineering: 'd-eng', product_design: 'd-product', gtm: 'd-gtm', finance_ops: 'd-ops', executive: 'd-exec' }
}

/**
 * The team a job in this family usually sits in: the family track's default department when the
 * workspace has it, else the first department on file (a renamed or custom set).
 */
export function departmentForFamily(db: Pick<DB, 'families' | 'departments'>, familyId: ID): ID {
  const track = db.families.find((f) => f.id === familyId)?.track
  const id = track ? trackDepartments()[track] : undefined
  if (id && db.departments.some((d) => d.id === id)) return id
  return db.departments[0]?.id ?? id ?? 'd-eng'
}

/**
 * A draft job prefilled from a role template: level, band (posted range = band min to max), equity
 * guideline, JD outline, stages and interview plan. Interviewers start empty except the hiring manager
 * on the panel. The team comes from the template, else from the family (departmentForFamily).
 */
export function jobFromTemplate(db: DB, template: RoleTemplate | undefined, opts: JobFromTemplateOpts): Job {
  const familyId = opts.familyId ?? template?.familyId ?? 'f-eng'
  const levelId = opts.levelId ?? template?.levelId ?? 'lv-l3'
  const band = bandFor(db, familyId, levelId)
  const hq = db.locations.find((l) => l.kind === 'hq') ?? db.locations[0]
  const job: Job = {
    id: opts.id ?? newId('j'),
    // No template and no title: leave it empty so the sheet's required-title check asks for one.
    title: opts.title ?? template?.name ?? '',
    departmentId: opts.departmentId ?? template?.departmentId ?? departmentForFamily(db, familyId),
    familyId,
    levelId,
    hiringManagerId: opts.hiringManagerId,
    panelIds: [opts.hiringManagerId],
    locationIds: opts.locationIds ?? (hq ? [hq.id] : []),
    workMode: opts.workMode ?? 'hybrid',
    employmentType: 'full_time',
    flsa: band?.flsaDefault ?? 'exempt',
    payMin: band?.min ?? null,
    payMax: band?.max ?? null,
    status: 'draft',
    stages: (template?.stages?.length ? template.stages : DEFAULT_STAGES).map((s) => ({ ...s })),
    interviewPlan: (template?.interviewPlan ?? []).map((s) => ({
      ...s,
      interviewerIds: [],
      attributes: s.attributes.map((a) => ({ ...a, ...(a.questions ? { questions: [...a.questions] } : {}) })),
    })),
    description: template?.jdOutline ?? '',
    sponsorship: 'case_by_case',
    backgroundCheck: db.company.soc2Enabled,
    creditCheckBasis: null,
    priority: 'normal',
    referralBonus: db.settings.referralBonusDefault,
    ...(band ? { equityMinPct: band.equityMinPct, equityMaxPct: band.equityMaxPct } : {}),
    ...(template ? { roleTemplateId: template.id } : {}),
    ...(opts.planSlotId ? { planSlotId: opts.planSlotId } : {}),
    ...(opts.targetStart ? { targetStart: opts.targetStart } : {}),
    ...(opts.isBackfill ? { isBackfill: true } : {}),
    ...(opts.backfillForPersonId ? { backfillForPersonId: opts.backfillForPersonId } : {}),
  }
  return job
}

export function createJob(draft: Draft<DB>, job: Job): ID {
  draft.jobs.push(job)
  logActivity(draft, { entityType: 'job', entityId: job.id, kind: 'job_created', text: `Created the ${job.title} job` })
  return job.id
}

/** Marks a job posted. Hard stop: at 15+ (counting incoming hires and accepted offers) it needs a pay range. */
export function markPosted(draft: Draft<DB>, jobId: ID, opts: { date: ISODate }): JobResult {
  const job = draft.jobs.find((j) => j.id === jobId)
  if (!job) return { ok: false, reason: 'Job not found.' }
  if (job.requisition?.status === 'pending') return { ok: false, reason: 'This job request is waiting for Admin approval. Post it once it is approved.' }
  const block = postingBlockReason(draft, jobId, opts.date)
  if (block) return { ok: false, reason: block }
  if (job.payMin != null && job.payMax != null && job.payMin > job.payMax) {
    return { ok: false, reason: 'The pay range minimum is above the maximum. Fix the range first.' }
  }
  job.status = 'open'
  job.openedOn = job.openedOn ?? opts.date
  job.postedOn = opts.date
  logActivity(draft, { entityType: 'job', entityId: job.id, kind: 'job_posted', text: `Posted the ${job.title} job` })
  return { ok: true }
}

/** Changes a job's status; filled and closed set the close date, open sets the open date. */
export function setJobStatus(draft: Draft<DB>, jobId: ID, status: Job['status'], opts: { date: ISODate }): boolean {
  const job = draft.jobs.find((j) => j.id === jobId)
  if (!job || job.status === status) return false
  job.status = status
  if (status === 'open') {
    job.openedOn = job.openedOn ?? opts.date
    delete job.closedOn
  }
  if (status === 'filled' || status === 'closed') job.closedOn = opts.date
  const words: Record<Job['status'], string> = { draft: 'Moved {t} back to draft', open: 'Opened {t}', on_hold: 'Put {t} on hold', filled: 'Marked {t} filled', closed: 'Closed {t}' }
  logActivity(draft, { entityType: 'job', entityId: job.id, kind: 'job_status', text: words[status].replace('{t}', `the ${job.title} job`) })
  return true
}

/** Closes every remaining active candidate on a filled job as 'position filled'. Returns the count. */
export function closeOutRemaining(draft: Draft<DB>, jobId: ID, opts: { date: ISODate; notified?: boolean }): number {
  const ids = draft.applications.filter((a) => a.jobId === jobId && a.status === 'active' && !a.conditionalOfferOn).map((a) => a.id)
  for (const id of ids) rejectApplication(draft, id, 'position_filled', { date: opts.date, notified: !!opts.notified })
  return ids.length
}

/**
 * Turns a credit check on (with a Labor Code 1024.5 basis) or off. The Civil Code 1785.20.5 notice is
 * owed to each candidate before their report is ordered, so the one-time notice item is created per
 * candidate when their background check starts (backgroundChecks.ts startBackgroundCheck), not here.
 * Turning the check off removes notice items not yet done for this job's candidates.
 */
export function setCreditCheckBasis(draft: Draft<DB>, jobId: ID, basis: string | null, _opts: { date: ISODate }): JobResult {
  const job = draft.jobs.find((j) => j.id === jobId)
  if (!job) return { ok: false, reason: 'Job not found.' }
  if (basis && !CREDIT_CHECK_BASES.some((b) => b.id === basis)) {
    return { ok: false, reason: 'Pick a Labor Code 1024.5 basis from the list to turn on a credit check.' }
  }
  job.creditCheckBasis = basis
  if (basis) {
    const task = creditCheckNoticeTask(job)
    logActivity(draft, {
      entityType: 'job',
      entityId: job.id,
      kind: 'credit_check_on',
      text: `Turned on a credit check for ${job.title} (${task.basis}). Each candidate gets the written notice before their report is ordered.`,
    })
  } else {
    // Open notice items for this job (per candidate, plus the older per-job item) are no longer owed.
    const ids = new Set([`rc-credit-notice-${job.id}`, ...draft.offers.filter((o) => o.jobId === job.id).map((o) => creditNoticeItemId(o.id))])
    draft.recurring = draft.recurring.filter((r) => !ids.has(r.id) || !!r.lastDoneOn)
    logActivity(draft, { entityType: 'job', entityId: job.id, kind: 'credit_check_off', text: `Turned off the credit check for ${job.title}` })
  }
  return { ok: true }
}
