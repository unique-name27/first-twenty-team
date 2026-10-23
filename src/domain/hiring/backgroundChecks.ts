// Background check and Fair Chance mutations (pure rules and dates are in fairChance.ts).
// Hard stop 2: nothing here records a check or a result before a conditional offer exists.
// Module rule: the store import stays LAST and there are no module-level runtime constants.
import type { Draft } from 'immer'
import type { DB, ID } from '@/domain/types'
import { type ISODate } from '@/lib/dates'
import {
  creditCheckAllowed,
  type CreditCheckNoticeTask,
  creditCheckNoticeTask,
  criminalHistoryLockReason,
  earliestFinalNoticeOn,
  preliminaryNoticeWarnings,
  responseDueOn,
} from './fairChance'
import { rescindOffer } from './offers'
import { candidateName, dbHolidays, fmtDayPlain } from './util'
import { logActivity } from '@/store/draft'

export type CheckResult =
  | {
      ok: true
      /** Order problems worth a look (never blocking), e.g. a preliminary notice dated before the assessment. */
      warnings?: string[]
      /** The per-candidate Civil Code 1785.20.5 notice owed before a credit report is ordered. */
      creditNotice?: CreditCheckNoticeTask & { recurringId: ID }
    }
  | { ok: false; reason: string }

function findOfferAndApp(draft: Draft<DB>, offerId: ID) {
  const offer = draft.offers.find((o) => o.id === offerId)
  const app = offer ? draft.applications.find((a) => a.id === offer.applicationId) : undefined
  return { offer, app }
}

function logCheck(draft: Draft<DB>, offer: { id: ID; candidateId: ID }, kind: string, text: string): void {
  logActivity(draft, { entityType: 'offer', entityId: offer.id, relatedId: offer.candidateId, kind, text })
}

/** Id of the one-time calendar item for a candidate's credit check notice. */
export function creditNoticeItemId(offerId: ID): ID {
  return `rc-credit-notice-${offerId}`
}

/**
 * Starts the check (consent and disclosures go through the vendor link-out). Hard stop 2 applies.
 * When the job has a Labor Code 1024.5 credit check basis, it also creates (or returns) the
 * one-time item to send this candidate the Civil Code 1785.20.5 notice before ordering the report.
 */
export function startBackgroundCheck(draft: Draft<DB>, offerId: ID, opts: { date: ISODate; provider?: string }): CheckResult {
  const { offer, app } = findOfferAndApp(draft, offerId)
  if (!offer || !app) return { ok: false, reason: 'Offer not found.' }
  const lock = criminalHistoryLockReason(app)
  if (lock) return { ok: false, reason: lock }
  offer.backgroundCheck = {
    ...(offer.backgroundCheck ?? {}),
    status: 'consent_sent',
    consentSentOn: opts.date,
    ...(opts.provider ? { provider: opts.provider } : {}),
  }
  const name = candidateName(draft, offer.candidateId)
  logCheck(draft, offer, 'background_check_started', `Started the background check for ${name}`)
  const job = draft.jobs.find((j) => j.id === offer.jobId)
  if (!job || !creditCheckAllowed(job)) return { ok: true }
  const task = creditCheckNoticeTask(job, name)
  const recurringId = creditNoticeItemId(offer.id)
  const notes = `${task.why} ${task.citation.label}: ${task.reviewNote}`
  const existing = draft.recurring.find((r) => r.id === recurringId)
  if (existing) {
    if (!existing.lastDoneOn) existing.notes = notes
  } else {
    draft.recurring.push({
      id: recurringId,
      title: task.title,
      cadence: 'once',
      nextDueOn: opts.date,
      ruleId: 'credit-check-notice',
      notes,
      ...(task.citation.url ? { link: task.citation.url } : {}),
    })
    logCheck(draft, offer, 'credit_notice_due', `Added a task to send ${name} the written credit check notice before ordering a credit report`)
  }
  return { ok: true, creditNotice: { ...task, recurringId } }
}

/** Records the result as Clear or Consider (status only, never the report). Hard stop 2 applies. */
export function recordBackgroundResult(draft: Draft<DB>, offerId: ID, result: 'clear' | 'consider', opts: { date: ISODate }): CheckResult {
  const { offer, app } = findOfferAndApp(draft, offerId)
  if (!offer || !app) return { ok: false, reason: 'Offer not found.' }
  const lock = criminalHistoryLockReason(app)
  if (lock) return { ok: false, reason: lock }
  const prev = offer.backgroundCheck ?? { status: 'not_started' as const }
  offer.backgroundCheck = { ...prev, status: 'complete', result, completedOn: opts.date, ...(result === 'consider' ? { fairChance: prev.fairChance ?? {} } : {}) }
  const name = candidateName(draft, offer.candidateId)
  logCheck(draft, offer, 'background_check_result', result === 'clear' ? `Background check clear for ${name}` : `Background check needs review for ${name}: Fair Chance steps opened`)
  return { ok: true }
}

export type FairChancePatch = {
  assessmentOn?: ISODate
  assessmentNote?: string
  preliminaryNoticeOn?: ISODate
  /** 'mail' without confirmed receipt starts the response window 5 calendar days later. */
  preliminaryNoticeMethod?: 'email' | 'mail' | 'hand'
  disputed?: boolean
  finalNoticeOn?: ISODate
}

/**
 * Records a Fair Chance step and recomputes the response deadline. The final notice is refused
 * before the response window closes. A preliminary notice recorded before the individualized
 * assessment (or before the result) is saved with a warning.
 */
export function updateFairChance(draft: Draft<DB>, offerId: ID, patch: FairChancePatch, _opts: { date: ISODate }): CheckResult {
  const { offer, app } = findOfferAndApp(draft, offerId)
  if (!offer || !app) return { ok: false, reason: 'Offer not found.' }
  const lock = criminalHistoryLockReason(app)
  if (lock) return { ok: false, reason: lock }
  const bg = offer.backgroundCheck
  if (!bg || bg.result !== 'consider') return { ok: false, reason: 'Fair Chance steps apply only after a Consider result.' }
  const holidays = dbHolidays(draft)
  const next = { ...(bg.fairChance ?? {}), ...patch }
  const due = responseDueOn({ fairChance: next }, holidays)
  if (due) next.responseDueOn = due
  if (patch.finalNoticeOn) {
    const earliest = earliestFinalNoticeOn({ fairChance: next }, holidays)
    if (!next.preliminaryNoticeOn || (earliest && patch.finalNoticeOn < earliest)) {
      return { ok: false, reason: `The final notice can go out only after the response window closes${due ? ` on ${fmtDayPlain(due)}` : ''}.` }
    }
  }
  bg.fairChance = next
  const name = candidateName(draft, offer.candidateId)
  const what = patch.finalNoticeOn
    ? 'final notice sent'
    : patch.preliminaryNoticeOn
      ? `preliminary notice sent${next.preliminaryNoticeMethod === 'mail' ? ' by mail' : ''}`
      : patch.disputed
        ? 'candidate disputes the report'
        : 'assessment recorded'
  logCheck(draft, offer, 'fair_chance_step', `Fair Chance for ${name}: ${what}`)
  const touchesOrder = patch.preliminaryNoticeOn !== undefined || patch.assessmentOn !== undefined
  const warnings = touchesOrder ? preliminaryNoticeWarnings({ fairChance: next, ...(bg.completedOn ? { completedOn: bg.completedOn } : {}) }) : []
  return warnings.length ? { ok: true, warnings } : { ok: true }
}

/**
 * Confirms the offer or rescinds it after the Fair Chance steps, logging the reason either way;
 * rescinding closes the application.
 */
export function decideFairChance(
  draft: Draft<DB>,
  offerId: ID,
  decision: 'proceed' | 'rescind',
  opts: { date: ISODate; reason?: string },
): CheckResult {
  const { offer, app } = findOfferAndApp(draft, offerId)
  if (!offer || !app) return { ok: false, reason: 'Offer not found.' }
  const bg = offer.backgroundCheck
  if (!bg) return { ok: false, reason: 'No background check on this offer.' }
  if (decision === 'rescind' && bg.result === 'consider') {
    const fc = bg.fairChance ?? {}
    if (!fc.finalNoticeOn) return { ok: false, reason: 'Send the final notice before rescinding.' }
  }
  bg.fairChance = { ...(bg.fairChance ?? {}), decision }
  const name = candidateName(draft, offer.candidateId)
  const reason = opts.reason?.trim()
  if (decision === 'proceed') {
    logCheck(draft, offer, 'fair_chance_decision', `Confirmed the offer for ${name} after the Fair Chance review${reason ? `: ${reason}` : ''}`)
    return { ok: true }
  }
  logCheck(draft, offer, 'fair_chance_decision', `Decided to rescind the offer for ${name} after the Fair Chance review${reason ? `: ${reason}` : ''}`)
  return rescindOffer(draft, offer.id, {
    date: opts.date,
    reason: reason || 'Rescinded after the Fair Chance review',
    closeApplication: true,
  })
}
