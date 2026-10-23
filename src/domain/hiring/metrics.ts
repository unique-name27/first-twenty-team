// Small-n hiring metrics. Counts come first; a percentage appears only when the denominator is 5 or
// more ('2 of 3 (small n)' instead of 67%). Every number keeps the ids behind it so the UI can drill
// in. Closed jobs may carry an archived aggregate funnel; those counts are added but not drillable.
import type { Application, DB, ID, Job, OutcomeReason, SourceKind, StageKind } from '@/domain/types'
import { daysBetween, type ISODate, isWithin } from '@/lib/dates'
import { archivedKey, furthestStageIndex, jobStages, miniFunnel, type FunnelStep } from './pipeline'
import { isHire, median, outcomeReasonLabel } from './util'

export type Rate = {
  n: number
  d: number
  /** Fraction 0..1 (format with pct() from lib/format); null when d is 0. */
  pct: number | null
  /** True when d < 5: show the counts, not a percentage. */
  small: boolean
  /** '2 of 3 (small n)' when d < 5, '67%' otherwise, 'None yet' when d is 0. */
  text: string
}

export function rate(n: number, d: number): Rate {
  const pct = d > 0 ? n / d : null
  if (d <= 0) return { n, d, pct, small: true, text: 'None yet' }
  if (d < 5) return { n, d, pct, small: true, text: `${n} of ${d} (small n)` }
  return { n, d, pct, small: false, text: `${Math.round((n / d) * 100)}%` }
}

export type MetricsQuery = {
  /** Applications with appliedOn in [from, to]; offers decided in [from, to]. */
  from: ISODate
  to: ISODate
  jobIds?: ID[]
  /** Add closed jobs' archived funnels (closed or opened inside the range). Default true. */
  includeArchived?: boolean
}

export type FunnelRow = {
  kind: StageKind
  name: string
  count: number
  archived: number
  total: number
  applicationIds: ID[]
}

/**
 * Stage-to-stage conversion. Counts only applications (and archived funnels) on jobs that have both
 * stage kinds, so a stage only some jobs use never reads above 100%.
 */
export type Conversion = {
  from: StageKind
  to: StageKind
  rate: Rate
  /** Applications that reached `from` on jobs with both stages (the denominator, before archived counts). */
  baseIds: ID[]
  /** Of those, the applications that reached `to`. */
  applicationIds: ID[]
  /** Jobs counted in this conversion. */
  jobIds: ID[]
}

export type MedianDays = { days: number | null; n: number; applicationIds: ID[] }

export type SourceRow = {
  source: SourceKind
  applications: number
  hires: number
  hireRate: Rate
  applicationIds: ID[]
  hireIds: ID[]
}

export type HiringMetrics = {
  range: { from: ISODate; to: ISODate }
  applications: { count: number; applicationIds: ID[] }
  funnel: FunnelRow[]
  conversions: Conversion[]
  medianDaysToAccept: MedianDays
  sources: SourceRow[]
  offerAcceptance: {
    accepted: number
    decided: number
    rate: Rate
    acceptedOfferIds: ID[]
    decidedOfferIds: ID[]
    /** Included from archived funnels (not drillable). */
    archivedAccepted: number
    archivedDecided: number
  }
  declineReasons: Array<{ reason: string; count: number; offerIds: ID[]; applicationIds: ID[] }>
  outcomeReasons: Array<{ reason: OutcomeReason; label: string; count: number; applicationIds: ID[] }>
  byJob: Array<{
    jobId: ID
    title: string
    status: Job['status']
    applications: number
    hires: number
    hireIds: ID[]
    funnel: FunnelStep[]
    medianDaysToAccept: MedianDays
  }>
}

function kindOrder(): StageKind[] {
  return ['new', 'recruiter_screen', 'intro', 'technical', 'onsite', 'offer', 'hired']
}

function kindName(kind: StageKind): string {
  switch (kind) {
    case 'new':
      return 'Applied'
    case 'recruiter_screen':
      return 'Recruiter screen'
    case 'intro':
      return 'Intro call'
    case 'technical':
      return 'Technical'
    case 'onsite':
      return 'Onsite'
    case 'offer':
      return 'Offer'
    case 'hired':
      return 'Accepted'
    default:
      return 'Custom'
  }
}

/** Stage kinds an application reached (every stage up to its furthest, plus offer and hire facts). */
export function reachedKinds(db: Pick<DB, 'offers'>, job: Job, app: Application): Set<StageKind> {
  const stages = jobStages(job)
  const idx = furthestStageIndex(job, app)
  const out = new Set<StageKind>(['new'])
  for (let i = 0; i <= idx && i < stages.length; i++) out.add(stages[i].kind)
  const offerOut = db.offers.some(
    (o) => o.applicationId === app.id && (o.status === 'sent' || o.status === 'accepted' || o.status === 'declined' || o.status === 'expired'),
  )
  if (offerOut || isHire(app)) out.add('offer')
  if (isHire(app)) out.add('hired')
  // A hire reached the stages before the offer too, even when skipped in the record.
  if (out.has('offer')) {
    for (const s of stages) {
      if (s.kind === 'offer') break
      if (s.kind !== 'custom') out.add(s.kind)
    }
  }
  return out
}

function acceptedOn(db: Pick<DB, 'offers'>, app: Application): ISODate | undefined {
  if (app.conditionalOfferOn) return app.conditionalOfferOn
  const o = db.offers.find((x) => x.applicationId === app.id && x.status === 'accepted' && x.decidedOn)
  return o?.decidedOn
}

function medianDaysToAccept(db: Pick<DB, 'offers'>, apps: Application[]): MedianDays {
  const rows = apps
    .map((a) => ({ id: a.id, acc: acceptedOn(db, a), applied: a.appliedOn }))
    .filter((r): r is { id: ID; acc: ISODate; applied: ISODate } => !!r.acc)
    .map((r) => ({ id: r.id, days: daysBetween(r.applied, r.acc) }))
    .filter((r) => r.days >= 0)
  return { days: median(rows.map((r) => r.days)), n: rows.length, applicationIds: rows.map((r) => r.id) }
}

function archivedJobInRange(job: Job, q: MetricsQuery): boolean {
  if (!job.archivedFunnel) return false
  const anchor = job.closedOn ?? job.openedOn
  return !!anchor && isWithin(anchor, q.from, q.to)
}

/** Funnel, conversions, time to accept, sources, offer acceptance and reasons for a date range. */
export function hiringMetrics(db: DB, q: MetricsQuery): HiringMetrics {
  const includeArchived = q.includeArchived ?? true
  const jobs = db.jobs.filter((j) => !q.jobIds || q.jobIds.includes(j.id))
  const jobById = new Map(jobs.map((j) => [j.id, j]))
  const apps = db.applications.filter((a) => jobById.has(a.jobId) && isWithin(a.appliedOn, q.from, q.to))
  const archivedJobs = includeArchived ? jobs.filter((j) => archivedJobInRange(j, q)) : []

  // Funnel by stage kind across jobs.
  const kindsPresent = new Set<StageKind>()
  for (const j of jobs) {
    if (!apps.some((a) => a.jobId === j.id) && !archivedJobs.includes(j)) continue
    for (const s of jobStages(j)) kindsPresent.add(s.kind)
  }
  const reached = new Map(apps.map((a) => [a.id, reachedKinds(db, jobById.get(a.jobId) as Job, a)]))
  const funnel: FunnelRow[] = kindOrder()
    .filter((k) => kindsPresent.has(k))
    .map((kind) => {
      const ids = apps.filter((a) => reached.get(a.id)?.has(kind)).map((a) => a.id)
      const key = archivedKey(kind)
      const archived = key ? archivedJobs.reduce((sum, j) => sum + (j.archivedFunnel?.[key] ?? 0), 0) : 0
      return { kind, name: kindName(kind), count: ids.length, archived, total: ids.length + archived, applicationIds: ids }
    })
  // Conversions compare like with like: only jobs whose pipeline has both stage kinds count, and an
  // archived funnel counts only when it has a bucket for both.
  const jobKinds = new Map(jobs.map((j) => [j.id, new Set<StageKind>(['new', ...jobStages(j).map((s) => s.kind)])]))
  const conversions: Conversion[] = []
  for (let i = 0; i + 1 < funnel.length; i++) {
    const from = funnel[i].kind
    const to = funnel[i + 1].kind
    const hasBoth = (jobId: ID) => {
      const kinds = jobKinds.get(jobId)
      return !!kinds && kinds.has(from) && kinds.has(to)
    }
    const pool = apps.filter((a) => hasBoth(a.jobId))
    const baseIds = pool.filter((a) => reached.get(a.id)?.has(from)).map((a) => a.id)
    const toIds = pool.filter((a) => reached.get(a.id)?.has(from) && reached.get(a.id)?.has(to)).map((a) => a.id)
    const fromKey = archivedKey(from)
    const toKey = archivedKey(to)
    const archivedPool = fromKey && toKey ? archivedJobs.filter((j) => hasBoth(j.id)) : []
    const archivedFrom = archivedPool.reduce((s, j) => s + (fromKey ? (j.archivedFunnel?.[fromKey] ?? 0) : 0), 0)
    const archivedTo = archivedPool.reduce((s, j) => s + (toKey ? (j.archivedFunnel?.[toKey] ?? 0) : 0), 0)
    const jobIds = [...new Set([...pool.map((a) => a.jobId), ...archivedPool.map((j) => j.id)])]
    conversions.push({ from, to, rate: rate(toIds.length + archivedTo, baseIds.length + archivedFrom), baseIds, applicationIds: toIds, jobIds })
  }

  // Sources (applications on record only).
  const candidateById = new Map(db.candidates.map((c) => [c.id, c]))
  const sourceKinds: SourceKind[] = ['inbound', 'referral', 'outbound', 'agency']
  const sources: SourceRow[] = sourceKinds.map((source) => {
    const ids = apps.filter((a) => candidateById.get(a.candidateId)?.source === source)
    const hires = ids.filter(isHire)
    return {
      source,
      applications: ids.length,
      hires: hires.length,
      hireRate: rate(hires.length, ids.length),
      applicationIds: ids.map((a) => a.id),
      hireIds: hires.map((a) => a.id),
    }
  })

  // Offer acceptance: offers decided in the range (accepted vs accepted + declined + expired).
  const decidedOffers = db.offers.filter(
    (o) =>
      jobById.has(o.jobId) &&
      o.decidedOn &&
      isWithin(o.decidedOn, q.from, q.to) &&
      (o.status === 'accepted' || o.status === 'declined' || o.status === 'expired'),
  )
  const acceptedOffers = decidedOffers.filter((o) => o.status === 'accepted')
  const archivedAccepted = archivedJobs.reduce((s, j) => s + (j.archivedFunnel?.accepted ?? 0), 0)
  const archivedDecided = archivedJobs.reduce((s, j) => s + (j.archivedFunnel?.offers ?? 0), 0)
  const accepted = acceptedOffers.length + archivedAccepted
  const decided = decidedOffers.length + archivedDecided

  const declineMap = new Map<string, { offerIds: ID[]; applicationIds: ID[] }>()
  for (const o of decidedOffers.filter((x) => x.status === 'declined')) {
    const key = o.declineReason?.trim() || 'Not given'
    const row = declineMap.get(key) ?? { offerIds: [], applicationIds: [] }
    row.offerIds.push(o.id)
    row.applicationIds.push(o.applicationId)
    declineMap.set(key, row)
  }
  const declineReasons = [...declineMap.entries()]
    .map(([reason, r]) => ({ reason: outcomeReasonLabel(reason), count: r.offerIds.length, ...r }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))

  const outcomeMap = new Map<OutcomeReason, ID[]>()
  for (const a of apps) {
    if ((a.status === 'rejected' || a.status === 'withdrawn') && a.outcomeReason) {
      outcomeMap.set(a.outcomeReason, [...(outcomeMap.get(a.outcomeReason) ?? []), a.id])
    }
  }
  const outcomeReasons = [...outcomeMap.entries()]
    .map(([reason, ids]) => ({ reason, label: outcomeReasonLabel(reason), count: ids.length, applicationIds: ids }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))

  const byJob = jobs
    .filter((j) => apps.some((a) => a.jobId === j.id) || archivedJobs.includes(j))
    .map((j) => {
      const jobApps = apps.filter((a) => a.jobId === j.id)
      const jobForFunnel = archivedJobs.includes(j) ? j : { ...j, archivedFunnel: undefined }
      const hires = jobApps.filter(isHire)
      return {
        jobId: j.id,
        title: j.title,
        status: j.status,
        applications: jobApps.length,
        hires: hires.length,
        hireIds: hires.map((a) => a.id),
        funnel: miniFunnel(db, jobForFunnel, jobApps),
        medianDaysToAccept: medianDaysToAccept(db, jobApps),
      }
    })

  return {
    range: { from: q.from, to: q.to },
    applications: { count: apps.length, applicationIds: apps.map((a) => a.id) },
    funnel,
    conversions,
    medianDaysToAccept: medianDaysToAccept(db, apps),
    sources,
    offerAcceptance: {
      accepted,
      decided,
      rate: rate(accepted, decided),
      acceptedOfferIds: acceptedOffers.map((o) => o.id),
      decidedOfferIds: decidedOffers.map((o) => o.id),
      archivedAccepted,
      archivedDecided,
    },
    declineReasons,
    outcomeReasons,
    byJob,
  }
}
