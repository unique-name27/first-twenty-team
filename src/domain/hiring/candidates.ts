// Adding candidates and applications. Quick-add parses a pasted blob (parse.ts), the UI checks
// findDuplicates first, then addCandidate creates the candidate and lands them in New with the next
// step 'Review application'. Candidates have desired pay only, never salary history (Labor Code
// 432.3). Applicant records are archived, never deleted, and kept 4 years (Gov Code 12946).
// Module rule: the store import stays LAST and there are no module-level runtime constants.
import type { Draft } from 'immer'
import type { Candidate, DB, ID, SourceKind } from '@/domain/types'
import { type ISODate } from '@/lib/dates'
import { newId } from '@/lib/id'
import { defaultNextStep, jobStages, stageById } from './pipeline'
import { createReferral } from './referrals'
import { addYears, candidateName, maxDate } from './util'
import { logActivity } from '@/store/draft'

export type NewCandidateInput = {
  id?: ID
  firstName: string
  lastName: string
  email: string
  phone?: string
  linkedin?: string
  github?: string
  resume?: string
  portfolio?: string
  location?: string
  timezone?: string
  currentTitle?: string
  currentCompany?: string
  source: SourceKind
  sourceDetail?: string
  referrerId?: ID | null
  desiredPay?: number
  /** 'hour' when desiredPay is an hourly rate (hourly and part-time jobs); a year otherwise. */
  desiredPayUnit?: Candidate['desiredPayUnit']
  sponsorship?: Candidate['sponsorship']
  tags?: string[]
  summary?: string
}

/**
 * Adds a candidate and, when a job is given, an application in the job's first stage with the default
 * next step. A referral source with a referrer also records the referral bonus.
 */
export function addCandidate(
  draft: Draft<DB>,
  input: NewCandidateInput,
  opts: { date: ISODate; jobId?: ID; ownerId?: ID },
): { candidateId: ID; applicationId?: ID } {
  const id = input.id ?? newId('c')
  const links: Candidate['links'] = {}
  if (input.linkedin) links.linkedin = input.linkedin
  if (input.github) links.github = input.github
  if (input.resume) links.resume = input.resume
  if (input.portfolio) links.portfolio = input.portfolio
  const cand: Candidate = {
    id,
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    email: input.email.trim(),
    links,
    source: input.source,
    sponsorship: input.sponsorship ?? 'unknown',
    tags: input.tags ?? [],
    createdOn: opts.date,
    ...(input.phone ? { phone: input.phone } : {}),
    ...(input.location ? { location: input.location } : {}),
    ...(input.timezone ? { timezone: input.timezone } : {}),
    ...(input.currentTitle ? { currentTitle: input.currentTitle } : {}),
    ...(input.currentCompany ? { currentCompany: input.currentCompany } : {}),
    ...(input.sourceDetail ? { sourceDetail: input.sourceDetail } : {}),
    ...(input.referrerId ? { referrerId: input.referrerId } : {}),
    ...(input.desiredPay != null ? { desiredPay: input.desiredPay, ...(input.desiredPayUnit === 'hour' ? { desiredPayUnit: 'hour' as const } : {}) } : {}),
    ...(input.summary ? { summary: input.summary } : {}),
    retainUntil: addYears(opts.date, 4),
  }
  draft.candidates.push(cand)
  logActivity(draft, { entityType: 'candidate', entityId: id, kind: 'candidate_added', text: `Added ${cand.firstName} ${cand.lastName}`.trim() })
  if (input.source === 'referral' && input.referrerId) {
    const job = opts.jobId ? draft.jobs.find((j) => j.id === opts.jobId) : undefined
    createReferral(draft, { candidateId: id, referrerId: input.referrerId, bonusAmount: job?.referralBonus ?? draft.settings.referralBonusDefault })
  }
  const applicationId = opts.jobId ? addApplication(draft, id, opts.jobId, { date: opts.date, ...(opts.ownerId ? { ownerId: opts.ownerId } : {}) }) : null
  return applicationId ? { candidateId: id, applicationId } : { candidateId: id }
}

/**
 * Adds an application for a candidate to a job (first stage, default next step). Returns the
 * existing application when the candidate already has one for the job.
 */
export function addApplication(
  draft: Draft<DB>,
  candidateId: ID,
  jobId: ID,
  opts: { date: ISODate; ownerId?: ID; stageId?: string; id?: ID },
): ID | null {
  const job = draft.jobs.find((j) => j.id === jobId)
  const cand = draft.candidates.find((c) => c.id === candidateId)
  if (!job || !cand) return null
  const existing = draft.applications.find((a) => a.candidateId === candidateId && a.jobId === jobId)
  if (existing) return existing.id
  const stage = (opts.stageId && stageById(job, opts.stageId)) || jobStages(job)[0]
  const id = opts.id ?? newId('a')
  const step = defaultNextStep(draft, job, stage.id, opts.date, opts.ownerId ?? job.hiringManagerId)
  draft.applications.push({
    id,
    candidateId,
    jobId,
    stageId: stage.id,
    status: 'active',
    appliedOn: opts.date,
    stageEnteredOn: opts.date,
    history: [{ stageId: stage.id, at: opts.date }],
    ...(step ? { nextStep: step } : {}),
  })
  if (cand.archived) cand.archived = false
  logActivity(draft, {
    entityType: 'application',
    entityId: id,
    relatedId: candidateId,
    kind: 'application_added',
    text: `Added ${candidateName(draft, candidateId)} to ${job.title} in ${stage.name}`,
  })
  return id
}

/**
 * Archives a candidate (Delete becomes Archive while the retention period runs). Retention is 4 years
 * from the later of the record date and the latest decision (LAW.md a-ads-1), and never shortens.
 */
export function archiveCandidate(draft: Draft<DB>, candidateId: ID, opts: { date: ISODate }): boolean {
  const c = draft.candidates.find((x) => x.id === candidateId)
  if (!c || c.archived) return false
  c.archived = true
  // Latest decision on any application; with none, archiving is the decision.
  const decided = draft.applications.filter((a) => a.candidateId === candidateId && a.closedOn).map((a) => a.closedOn as ISODate)
  const latest = decided.sort().pop() ?? opts.date
  const until = maxDate(c.retainUntil, addYears(c.createdOn, 4), addYears(latest, 4))
  if (until) c.retainUntil = until
  logActivity(draft, { entityType: 'candidate', entityId: c.id, kind: 'candidate_archived', text: `Archived ${c.firstName} ${c.lastName}`.trim() })
  return true
}

/** Adds or removes a tag such as 'keep warm' or 'silver medalist'. */
export function toggleCandidateTag(draft: Draft<DB>, candidateId: ID, tag: string): boolean {
  const c = draft.candidates.find((x) => x.id === candidateId)
  const t = tag.trim()
  if (!c || !t) return false
  const has = c.tags.includes(t)
  c.tags = has ? c.tags.filter((x) => x !== t) : [...c.tags, t]
  logActivity(draft, {
    entityType: 'candidate',
    entityId: c.id,
    kind: 'tag',
    text: has ? `Removed the ${t} tag from ${c.firstName} ${c.lastName}` : `Tagged ${c.firstName} ${c.lastName} ${t}`,
  })
  return true
}
