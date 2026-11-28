// What the Hiring > Jobs tab needs decided (docs/SPEC.md, Hiring): the offers waiting on the admin and where
// headcount stands against the plan and the nex legal threshold. Pure selectors over the db and the inbox
// items; nothing is stored.
import { nextThreshold } from '@/domain/compliance'
import type { InboxItem } from '@/domain/inbox'
import type { PeopleCostSummary } from '@/domain/pay'
import { headcountProjection } from '@/domain/plan'
import type { DB, ID } from '@/domain/types'
import type { ISODate } from '@/lib/dates'

export type OfferWaiting = {
  /** The inbox item, so the row can run its primary action (Approve) as the inbox does. */
  item: InboxItem
  offerId: ID | undefined
  /** From the offer record, falling back to the item's ref; null when neither names a job. */
  jobId: ID | null
  /** Fully loaded monthly cost once the offer lands (a start date is not needed); 0 when unpriced. */
  monthly: number
}

export type OffersWaiting = {
  count: number
  monthly: number
  /** Jobs those offers are for, so the Jobs list can put them first. */
  jobIds: ID[]
  rows: OfferWaiting[]
}

/** Offers waiting on the admin, with what they add to the monthly bill. Money is fully loaded, from peopleCostSummary. */
export function offersWaiting(db: DB, items: InboxItem[], cost: PeopleCostSummary): OffersWaiting {
  const rows = items
    .filter((i) => i.kind === 'offer_approval' && i.waitingOn === 'you')
    .map((item): OfferWaiting => {
      const offerId = item.refs.offerId
      const offer = db.offers.find((o) => o.id === offerId)
      const line = cost.withOffers.lines.find((l) => l.offerId === offerId)
      return { item, offerId, jobId: offer?.jobId ?? item.refs.jobId ?? null, monthly: line?.monthly ?? 0 }
    })
  const jobIds = [...new Set(rows.map((r) => r.jobId).filter((id): id is ID => !!id))]
  return { count: rows.length, monthly: rows.reduce((s, r) => s + r.monthly, 0), jobIds, rows }
}

export type HeadcountOutlook = {
  /** On payroll today. */
  current: number
  /** The plan at the end of the current quarter, when there is a plan. */
  plan: { value: number; date: ISODate } | null
  /** The next legal headcount threshold and how many more hires reach it, counting people already hired who have not started. */
  next: { n: number; away: number } | null
}

export function headcountOutlook(db: DB, date: ISODate): HeadcountOutlook {
  const proj = headcountProjection(db, date)
  const target = proj.targets[0]
  const nt = nextThreshold(db, date)
  return {
    current: proj.current,
    plan: target && (db.plan.length > 0 || target.value !== proj.current) ? { value: target.value, date: target.date } : null,
    next: nt && nt.kind === 'headcount' ? { n: nt.n, away: Math.max(0, nt.n - nt.withIncoming) } : null,
  }
}
