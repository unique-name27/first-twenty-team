// Job requests (requisitions): a hiring manager asks for a new job; it lands as an approval in Admin's
// inbox (docs/SPEC.md, Viewing as rules). The request is a draft job carrying `requisition`, so it
// shows on the requester's Jobs list right away, but it cannot be posted until Admin approves.
// Approving adds a headcount plan line for the requested quarter (linked to the job) so the plan and
// the people cost stay the one place cost decisions live. No cost is stored on the request itself.
// Module rule: the store import stays LAST and there are no module-level runtime constants.
import type { Draft } from 'immer'
import type { DB, ID, Job, JobRequisition, PlanSlot } from '@/domain/types'
import { addDays, addMonths, type ISODate, quarterOf, quarterStart } from '@/lib/dates'
import { newId } from '@/lib/id'
import type { JobResult } from './jobs'
import { mondayOnOrAfter } from './util'
import { logActivity } from '@/store/draft'

/** A draft job still waiting for Admin to approve the request. */
export function isPendingRequisition(job: Pick<Job, 'status' | 'requisition'>): boolean {
  return job.status === 'draft' && job.requisition?.status === 'pending'
}

/** Job requests waiting for Admin, oldest first. */
export function pendingRequisitions(db: Pick<DB, 'jobs'>): Job[] {
  return db.jobs.filter(isPendingRequisition).sort((a, b) => (a.requisition?.requestedOn ?? '').localeCompare(b.requisition?.requestedOn ?? '') || a.id.localeCompare(b.id))
}

/** The quarter chips for a request: this quarter and the next two ('2026-Q4', '2027-Q1', '2027-Q2'). */
export function requisitionQuarters(date: ISODate): string[] {
  const first = quarterStart(quarterOf(date))
  return [0, 3, 6].map((m) => quarterOf(addMonths(first, m)))
}

/** A target start for a requested quarter: a Monday, no sooner than six weeks out (time to hire). */
export function requisitionTargetStart(quarter: string, date: ISODate): ISODate {
  const start = quarterStart(quarter)
  const soonest = addDays(date, 42)
  return mondayOnOrAfter(start > soonest ? start : soonest)
}

/**
 * Saves a hiring manager's job request as a draft job with a pending requisition. The requester is
 * the hiring manager. Returns the job id.
 */
export function requestJob(
  draft: Draft<DB>,
  job: Job,
  req: { requestedById: ID; quarter: string; reason: string; date: ISODate },
): ID {
  const requisition: JobRequisition = { requestedById: req.requestedById, requestedOn: req.date, quarter: req.quarter, reason: req.reason.trim(), status: 'pending' }
  const { openedOn: _opened, postedOn: _posted, ...rest } = job
  const saved: Job = {
    ...rest,
    status: 'draft',
    hiringManagerId: req.requestedById,
    panelIds: rest.panelIds.includes(req.requestedById) ? rest.panelIds : [req.requestedById, ...rest.panelIds],
    targetStart: rest.targetStart ?? requisitionTargetStart(req.quarter, req.date),
    requisition,
  }
  draft.jobs.push(saved)
  const who = draft.people.find((p) => p.id === req.requestedById)
  logActivity(draft, {
    entityType: 'job',
    entityId: saved.id,
    kind: 'job_requested',
    text: `${who ? `${who.firstName} ${who.lastName}` : 'A hiring manager'} requested the ${saved.title} job`,
  })
  return saved.id
}

/**
 * Admin approves a job request: the job stays a draft, ready to post, and a headcount plan line for
 * the requested quarter is added and linked (unless the job already has one).
 */
export function approveRequisition(draft: Draft<DB>, jobId: ID, opts: { approverId: ID | null; date: ISODate }): JobResult {
  const job = draft.jobs.find((j) => j.id === jobId)
  if (!job || !job.requisition) return { ok: false, reason: 'That job request no longer exists.' }
  if (job.requisition.status !== 'pending' || job.status !== 'draft') return { ok: false, reason: 'This job request was already decided.' }
  job.requisition.status = 'approved'
  job.requisition.decidedById = opts.approverId
  job.requisition.decidedOn = opts.date
  // The job counts as opened (for time to fill) from the approval, like a draft opened from the plan.
  job.openedOn = job.openedOn ?? opts.date
  const linked = draft.plan.find((s) => s.id === job.planSlotId || s.jobId === job.id)
  if (!linked) {
    const slot: PlanSlot = {
      id: newId('ps'),
      quarter: job.requisition.quarter,
      title: job.title,
      departmentId: job.departmentId,
      familyId: job.familyId,
      levelId: job.levelId,
      targetStart: job.targetStart ?? requisitionTargetStart(job.requisition.quarter, opts.date),
      status: 'open',
      jobId: job.id,
      ...(job.requisition.reason ? { rationale: job.requisition.reason } : {}),
      ...(job.isBackfill ? { isBackfill: true, backfillForPersonId: job.backfillForPersonId ?? null } : {}),
    }
    draft.plan.push(slot)
    job.planSlotId = slot.id
  }
  logActivity(draft, { entityType: 'job', entityId: job.id, kind: 'job_request_approved', text: `Approved the request for the ${job.title} job` })
  return { ok: true }
}

/** Admin declines a job request: the draft job closes and nothing is added to the plan. */
export function declineRequisition(draft: Draft<DB>, jobId: ID, opts: { approverId: ID | null; date: ISODate }): JobResult {
  const job = draft.jobs.find((j) => j.id === jobId)
  if (!job || !job.requisition) return { ok: false, reason: 'That job request no longer exists.' }
  if (job.requisition.status !== 'pending' || job.status !== 'draft') return { ok: false, reason: 'This job request was already decided.' }
  job.requisition.status = 'declined'
  job.requisition.decidedById = opts.approverId
  job.requisition.decidedOn = opts.date
  job.status = 'closed'
  job.closedOn = opts.date
  logActivity(draft, { entityType: 'job', entityId: job.id, kind: 'job_request_declined', text: `Declined the request for the ${job.title} job` })
  return { ok: true }
}
