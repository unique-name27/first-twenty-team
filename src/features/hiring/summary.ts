// The Hiring > Jobs summary strip (docs/SPEC.md, Hiring): what needs a decision before anything else.
// Admin gets four answers (offers waiting on you and what they cost once they land, stuck candidates, open
// roles vs plan, hire cost vs runway with the next legal threshold); a Hiring manager gets three that carry
// no cost (stuck candidates and open roles on their jobs, interviews this week). Pure: everything is built
// from the Home dashboard selectors (hiringRows, approvalsQueue, headcountTile, peopleCostSummary), the
// date and the viewer; nothing is stored, and cost is never computed for a manager.
import { links } from '@/app/router'
import { canSeePipeline } from '@/domain/access'
import type { InboxAction, InboxItem } from '@/domain/inbox'
import { peopleCostSummary, type PeopleCostSummary, runway } from '@/domain/pay'
import { plannedHiresBy } from '@/domain/plan'
import type { DB, ID, Job, Viewer } from '@/domain/types'
import { addDays, type ISODate, pacificDateOf } from '@/lib/dates'
import { approvalsQueue, type ApprovalRow, headcountTile, type HeadcountTile, hiringRows, type HiringRow } from '../home/dashboard'

/** Interviews count for this many days, today included. */
export const INTERVIEW_WINDOW_DAYS = 7

export type OffersWaiting = {
  count: number
  /** Fully loaded monthly cost of those offers once they land (a start date is not needed). */
  monthly: number
  /** Jobs those offers are for, so the Jobs list can put them first. */
  jobIds: ID[]
  /** The approvals queue rows, one per offer, each with its Approve action and the job it is for. */
  rows: (ApprovalRow & { jobId: ID | null })[]
}

export type StuckSummary = { candidates: number; roles: number }

export type RolesVsPlan = {
  open: number
  /** The plan at the end of the quarter, when there is one. */
  plan: { value: number; date: ISODate } | null
  current: number
  /** Plan lines still to hire by the plan date (known starts and departures are not hires); null without a plan. */
  toPlan: number | null
  /** Planned hires with no open role to cover them; null without a plan. */
  uncovered: number | null
}

export type CostVsRunway = {
  /** Extra fully loaded cost a month once the offers out and incoming hires start. */
  addedMonthly: number
  /** Months of runway at today's burn and with those offers; null when cash on hand is not set. */
  runwayNow: number | null
  runwayWithOffers: number | null
  /** The next legal headcount threshold and how many hires away it is; `reached` when offers waiting on you reach it. */
  next: { n: number; away: number; reached: boolean } | null
}

export type InterviewsThisWeek = { count: number; nextAt: string | null }

export type HiringSummary =
  | {
      kind: 'admin'
      offers: OffersWaiting
      stuck: StuckSummary
      roles: RolesVsPlan
      cost: CostVsRunway
    }
  | {
      kind: 'manager'
      stuck: StuckSummary
      roles: RolesVsPlan
      interviews: InterviewsThisWeek
    }

// ---------------------------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------------------------

/** Offers waiting on the admin, with what they add to the monthly bill. Money is fully loaded, from peopleCostSummary. */
export function offersWaiting(db: DB, items: InboxItem[], date: ISODate, cost: PeopleCostSummary = peopleCostSummary(db, date)): OffersWaiting {
  // The job comes from the offer record, falling back to the item's ref, as Home's approvals queue does.
  const rows = approvalsQueue(db, items, date, cost)
    .filter((r) => r.item.kind === 'offer_approval')
    .map((r) => ({ ...r, jobId: db.offers.find((o) => o.id === r.item.refs.offerId)?.jobId ?? r.item.refs.jobId ?? null }))
  const offerIds = new Set(rows.map((r) => r.item.refs.offerId))
  const monthly = cost.withOffers.lines.filter((l) => l.offerId && offerIds.has(l.offerId)).reduce((s, l) => s + l.monthly, 0)
  const jobIds = [...new Set(rows.map((r) => r.jobId).filter((id): id is ID => !!id))]
  return { count: rows.length, monthly, jobIds, rows }
}

/** Candidates past an SLA or with no next step, and the roles they sit in. */
export function stuckSummary(rows: HiringRow[]): StuckSummary {
  return {
    candidates: rows.reduce((s, r) => s + r.stuck, 0),
    roles: rows.filter((r) => r.stuck > 0).length,
  }
}

/** Open roles against the headcount plan. `hires` is plannedHiresBy at the plan date, null without a plan. */
export function rolesVsPlan(rows: HiringRow[], head: HeadcountTile, hires: number | null): RolesVsPlan {
  const toPlan = head.plan ? (hires ?? 0) : null
  return {
    open: rows.length,
    plan: head.plan,
    current: head.current,
    toPlan,
    uncovered: toPlan == null ? null : Math.max(0, toPlan - rows.length),
  }
}

/** What the offers cost against runway, and how close they take the company to the next legal threshold. */
export function costVsRunway(db: DB, date: ISODate, cost: PeopleCostSummary, head: HeadcountTile, waiting: number): CostVsRunway {
  const withOffers = cost.withOffers.monthly === cost.now.monthly ? cost.runwayNow : runway(db, date, 'with_offers')
  return {
    addedMonthly: Math.max(0, cost.withOffers.monthly - cost.now.monthly),
    runwayNow: cost.runwayNow.months,
    runwayWithOffers: withOffers.months,
    next: head.next ? { ...head.next, reached: waiting > 0 && waiting >= head.next.away } : null,
  }
}

/** Scheduled interviews in the next INTERVIEW_WINDOW_DAYS on jobs the viewer manages or panels they are on. */
export function interviewsThisWeek(db: DB, viewer: Viewer, date: ISODate): InterviewsThisWeek {
  const to = addDays(date, INTERVIEW_WINDOW_DAYS - 1)
  const mine = db.interviews
    .filter((i) => {
      if (i.status !== 'scheduled') return false
      const day = pacificDateOf(i.startsAt)
      if (day < date || day > to) return false
      const job = db.jobs.find((j) => j.id === db.applications.find((a) => a.id === i.applicationId)?.jobId)
      return (!!viewer.personId && i.interviewerIds.includes(viewer.personId)) || (!!job && canSeePipeline(viewer, job))
    })
    .map((i) => i.startsAt)
    .sort()
  return { count: mine.length, nextAt: mine[0] ?? null }
}

/** The strip for the viewer. null for an employee, who keeps the plain list. */
export function hiringSummary(db: DB, items: InboxItem[], viewer: Viewer, date: ISODate): HiringSummary | null {
  const head = headcountTile(db, date)
  if (viewer.role === 'admin') {
    const cost = peopleCostSummary(db, date)
    const rows = hiringRows(db, date)
    const offers = offersWaiting(db, items, date, cost)
    return {
      kind: 'admin',
      offers,
      stuck: stuckSummary(rows),
      roles: rolesVsPlan(rows, head, head.plan ? plannedHiresBy(db, date, head.plan.date) : null),
      cost: costVsRunway(db, date, cost, head, offers.count),
    }
  }
  if (viewer.role !== 'manager') return null
  const mine = new Set(db.jobs.filter((j) => canSeePipeline(viewer, j)).map((j) => j.id))
  const rows = hiringRows(db, date).filter((r) => mine.has(r.jobId))
  // A manager's roles tile has no plan: the plan carries cost and belongs to Admin.
  return {
    kind: 'manager',
    stuck: stuckSummary(rows),
    roles: rolesVsPlan(rows, { ...head, plan: null }, null),
    interviews: interviewsThisWeek(db, viewer, date),
  }
}

// ---------------------------------------------------------------------------------------------
// The Jobs list: order, one status word, one inline action
// ---------------------------------------------------------------------------------------------

export type JobRowInput = {
  job: Pick<Job, 'id' | 'status' | 'requisition'>
  stuck: number
  access: 'full' | 'panel'
}

/** 0 an offer waits on you, 1 candidates are stuck, 2 everything else. Sorting is stable, so the usual job order holds within each. */
export function attentionRank(row: JobRowInput, offerJobIds: ReadonlySet<ID>): 0 | 1 | 2 {
  if (offerJobIds.has(row.job.id) && row.job.status === 'open') return 0
  return row.stuck > 0 ? 1 : 2
}

export type JobStatusWord = {
  tone: 'accent' | 'warn' | 'good' | 'neutral'
  text: string
}

/** One word for the row: Offer waiting, "3 stuck", Requested, Draft, On hold, On track, Filled or Closed. */
export function jobStatusWord(row: JobRowInput, offerJobIds: ReadonlySet<ID>): JobStatusWord {
  const { job } = row
  if (attentionRank(row, offerJobIds) === 0) return { tone: 'accent', text: 'Offer waiting' }
  if (row.stuck > 0) return { tone: 'warn', text: `${row.stuck} stuck` }
  if (job.status === 'draft') return job.requisition?.status === 'pending' ? { tone: 'warn', text: 'Requested' } : { tone: 'neutral', text: 'Draft' }
  if (job.status === 'on_hold') return { tone: 'neutral', text: 'On hold' }
  if (job.status === 'filled') return { tone: 'good', text: 'Filled' }
  if (job.status === 'closed') return { tone: 'neutral', text: 'Closed' }
  return { tone: 'good', text: 'On track' }
}

export type JobAction = { label: string; href: string } | { label: string; action: InboxAction }

/** The one inline action: approve the offer, sweep the stuck, or open the job. */
export function jobAction(row: JobRowInput, offers: OffersWaiting | null): JobAction {
  const offerJobIds = new Set(offers?.jobIds ?? [])
  const waiting = attentionRank(row, offerJobIds) === 0 ? offers?.rows.find((r) => r.jobId === row.job.id) : undefined
  if (waiting) return { label: waiting.item.primary.label, action: waiting.item.primary }
  if (row.stuck > 0 && row.access === 'full') return { label: 'Sweep', href: links.job(row.job.id, 'sweep') }
  return { label: 'Open', href: links.job(row.job.id) }
}
