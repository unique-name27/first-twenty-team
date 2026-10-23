// Referral bonuses: who referred a candidate, the bonus amount, and when it becomes payable
// (settings.referralBonusPayableDays after the referred hire starts, 90 by default).
// Module rule: the store import stays LAST and there are no module-level runtime constants.
import type { Draft } from 'immer'
import { personNameById } from '@/domain/people'
import type { DB, ID, Referral } from '@/domain/types'
import { addDays, type ISODate } from '@/lib/dates'
import { money } from '@/lib/format'
import { newId } from '@/lib/id'
import { candidateName } from './util'
import { logActivity } from '@/store/draft'

export function referralFor(db: Pick<DB, 'referrals'>, candidateId: ID): Referral | undefined {
  return db.referrals.find((r) => r.candidateId === candidateId)
}

/** The payable date for a referred hire who starts on the date. */
export function referralPayableOn(db: Pick<DB, 'settings'>, startDate: ISODate): ISODate {
  return addDays(startDate, db.settings.referralBonusPayableDays)
}

/** Referral bonuses due on or before the date and not yet paid, oldest first. */
export function referralPayable(db: Pick<DB, 'referrals'>, date: ISODate): Referral[] {
  return db.referrals
    .filter((r) => !r.paidOn && !!r.payableOn && r.payableOn <= date)
    .sort((a, b) => (a.payableOn ?? '').localeCompare(b.payableOn ?? ''))
}

/** Referral bonuses that come due within the next `days` days (for the inbox Coming up group). */
export function referralUpcoming(db: Pick<DB, 'referrals'>, date: ISODate, days = 30): Referral[] {
  const until = addDays(date, days)
  return db.referrals
    .filter((r) => !r.paidOn && !!r.payableOn && r.payableOn > date && r.payableOn <= until)
    .sort((a, b) => (a.payableOn ?? '').localeCompare(b.payableOn ?? ''))
}

/** Records a referral (one per candidate). Returns the referral id. */
export function createReferral(
  draft: Draft<DB>,
  input: { candidateId: ID; referrerId: ID; bonusAmount?: number },
): ID {
  const existing = draft.referrals.find((r) => r.candidateId === input.candidateId)
  if (existing) {
    existing.referrerId = input.referrerId
    if (input.bonusAmount != null) existing.bonusAmount = input.bonusAmount
    return existing.id
  }
  const id = newId('ref')
  draft.referrals.push({
    id,
    candidateId: input.candidateId,
    referrerId: input.referrerId,
    bonusAmount: input.bonusAmount ?? draft.settings.referralBonusDefault,
  })
  logActivity(draft, {
    entityType: 'candidate',
    entityId: input.candidateId,
    relatedId: input.referrerId,
    kind: 'referral',
    text: `${personNameById(draft, input.referrerId, 'A teammate')} referred ${candidateName(draft, input.candidateId)}`,
  })
  return id
}

/** Sets the payable date once the referred person has a start date (called by the Hire flow). */
export function setReferralPayable(draft: Draft<DB>, candidateId: ID, startDate: ISODate): boolean {
  const r = draft.referrals.find((x) => x.candidateId === candidateId)
  if (!r) return false
  r.payableOn = referralPayableOn(draft, startDate)
  return true
}

export function markReferralPaid(draft: Draft<DB>, referralId: ID, date: ISODate): boolean {
  const r = draft.referrals.find((x) => x.id === referralId)
  if (!r || r.paidOn) return false
  r.paidOn = date
  logActivity(draft, {
    entityType: 'candidate',
    entityId: r.candidateId,
    relatedId: r.referrerId,
    kind: 'referral_paid',
    text: `Paid the ${money(r.bonusAmount)} referral bonus to ${personNameById(draft, r.referrerId, 'the referrer')} for ${candidateName(draft, r.candidateId)}`,
  })
  return true
}
