// Option vesting and pool math. Standard schedule: nothing vests before the cliff; at the cliff
// cliffMonths/vestingMonths of the grant vests at once; then 1/vestingMonths each month.
// Whole shares only: vested = floor(shares * monthsVested / vestingMonths), all of it at the end.
// The equity planning view (docs/SPEC.md, EQUITY PLANNING VIEW) is a planning mirror: the cap table
// tool stays the source of truth for issued options, exercises and 409A valuations.
import type { Draft } from 'immer'
import { setTaskStatus } from '@/domain/checklists/actions'
import { TASK_IDS } from '@/domain/checklists/templates'
import { offerLapsed, outstandingOffers } from '@/domain/pay'
import { fullName } from '@/domain/people'
import type { DB, EquityGrant, EquitySetup, ID, Valuation409A } from '@/domain/types'
import { addDays, addMonths, daysBetween, fmtDate, fmtShort, fullMonthsBetween, type ISODate, nowISO } from '@/lib/dates'
import { money2, num, plural } from '@/lib/format'
import { newId } from '@/lib/id'
import { currentActorId, logActivity } from '@/store/draft'

/**
 * Whole months of service from the vesting start to the date, or -1 before the start. A month counts on its
 * monthly anniversary, and for a start on the 29th to 31st that is the last day of a shorter month (a Jan 31
 * start vests on Feb 28), matching addMonths and so every vest date this module reports.
 */
export function creditedMonths(vestingStart: ISODate, date: ISODate): number {
  if (date < vestingStart) return -1
  const m = fullMonthsBetween(vestingStart, date)
  return addMonths(vestingStart, m + 1) <= date ? m + 1 : m
}

/** Months of vesting credited on a date (0 before the cliff). */
export function monthsVested(grant: Pick<EquityGrant, 'vestingStart' | 'cliffMonths' | 'vestingMonths'>, date: ISODate): number {
  if (date < grant.vestingStart) return 0
  const m = Math.min(grant.vestingMonths, creditedMonths(grant.vestingStart, date))
  return m < grant.cliffMonths ? 0 : m
}

/** Shares vested on a date, ignoring cancellation. */
export function vestedShares(
  grant: Pick<EquityGrant, 'shares' | 'vestingStart' | 'cliffMonths' | 'vestingMonths'>,
  date: ISODate,
): number {
  const m = monthsVested(grant, date)
  if (m >= grant.vestingMonths) return grant.shares
  return Math.floor((grant.shares * m) / grant.vestingMonths)
}

export function unvestedShares(
  grant: Pick<EquityGrant, 'shares' | 'vestingStart' | 'cliffMonths' | 'vestingMonths'>,
  date: ISODate,
): number {
  return grant.shares - vestedShares(grant, date)
}

export function cliffDate(grant: Pick<EquityGrant, 'vestingStart' | 'cliffMonths'>): ISODate {
  return addMonths(grant.vestingStart, grant.cliffMonths)
}

export function fullyVestedDate(grant: Pick<EquityGrant, 'vestingStart' | 'vestingMonths'>): ISODate {
  return addMonths(grant.vestingStart, grant.vestingMonths)
}

/** The next date on which more shares vest, after `date`, or null when fully vested. */
export function nextVestDate(
  grant: Pick<EquityGrant, 'vestingStart' | 'cliffMonths' | 'vestingMonths'>,
  date: ISODate,
): ISODate | null {
  const m = creditedMonths(grant.vestingStart, date)
  if (date < grant.vestingStart || m < grant.cliffMonths) return cliffDate(grant)
  if (m >= grant.vestingMonths) return null
  return addMonths(grant.vestingStart, m + 1)
}

/**
 * Shares counted against the pool by a grant: all shares, minus any returned on cancellation. With a
 * date, a cancellation dated later (a leaver's unvested shares come back on their last day) has not
 * taken effect yet, so the grant still holds every share.
 */
export function sharesHeld(grant: EquityGrant, date?: ISODate): number {
  if (cancellationPending(grant, date)) return grant.shares
  if (grant.status === 'cancelled') return Math.max(0, grant.shares - (grant.cancelledShares ?? grant.shares))
  return grant.shares - (grant.cancelledShares ?? 0)
}

/** True when the grant's cancellation is dated after `date` (offboarding records it ahead of the last day). */
export function cancellationPending(grant: Pick<EquityGrant, 'cancelledOn' | 'cancelledShares' | 'status'>, date?: ISODate): boolean {
  return !!date && !!grant.cancelledOn && grant.cancelledOn > date && (grant.cancelledShares != null || grant.status === 'cancelled')
}

/** Shares a grant has returned to the pool by the date (none while its cancellation is still ahead). */
export function sharesReturned(grant: EquityGrant, date?: ISODate): number {
  if (cancellationPending(grant, date)) return 0
  return grant.status === 'cancelled' ? (grant.cancelledShares ?? grant.shares) : (grant.cancelledShares ?? 0)
}

/** Fraction of fully diluted shares (0.005 = 0.5%). */
export function pctOfFullyDiluted(db: DB, shares: number): number {
  return db.equity.fullyDilutedShares > 0 ? shares / db.equity.fullyDilutedShares : 0
}

/**
 * True while the cap table holds the placeholder numbers Start fresh filled in (nobody has entered or
 * confirmed them): percentages of fully diluted shares are then estimates, and offer letters leave them out.
 */
export function capTableIsPlaceholder(db: Pick<DB, 'equity'>): boolean {
  return !db.equity.capTableConfirmedOn
}

export function grantsFor(db: DB, personId: ID): EquityGrant[] {
  return db.grants.filter((g) => g.personId === personId).sort((a, b) => a.vestingStart.localeCompare(b.vestingStart))
}

/** The 409A in effect on a date (latest effective on or before it), or undefined. */
export function current409A(db: DB, date: ISODate): Valuation409A | undefined {
  return [...db.equity.valuations]
    .filter((v) => v.effectiveOn <= date)
    .sort((a, b) => b.effectiveOn.localeCompare(a.effectiveOn))[0]
}

// ---------------------------------------------------------------------------------------------
// Holders and vesting
// ---------------------------------------------------------------------------------------------

/** Display name of a grant holder: employee, contractor or advisor, or candidate (reserved by an offer). */
export function holderName(db: DB, grant: Pick<EquityGrant, 'personId'>): string {
  const p = db.people.find((x) => x.id === grant.personId)
  if (p) return fullName(p)
  const k = db.contractors.find((x) => x.id === grant.personId)
  if (k) return k.name
  const c = db.candidates.find((x) => x.id === grant.personId)
  if (c) return `${c.firstName} ${c.lastName}`
  return 'Unknown holder'
}

/**
 * Last day the holder works for the company (employee end date or contract end), if any. A separation
 * in progress counts too: offboarding sets the end date, and its last day stands in when only that is known.
 */
export function holderEndDate(db: DB, grant: Pick<EquityGrant, 'personId'>): ISODate | undefined {
  const p = db.people.find((x) => x.id === grant.personId)
  if (p) return p.endDate ?? p.separation?.lastDay ?? undefined
  const k = db.contractors.find((x) => x.id === grant.personId)
  return k?.endOn ?? undefined
}

/** The day vesting stops for a grant: its cancellation date or the holder's last day, whichever comes first. */
export function vestingStop(db: DB, grant: EquityGrant): ISODate | undefined {
  const end = holderEndDate(db, grant)
  return [grant.cancelledOn, end].filter((d): d is ISODate => !!d).sort()[0]
}

/** Shares vested after `m` whole months of service (cliff and whole-share rules applied). */
function vestAtMonth(g: Pick<EquityGrant, 'shares' | 'cliffMonths' | 'vestingMonths'>, m: number): number {
  if (g.vestingMonths <= 0) return g.shares
  if (m < 0 || m < g.cliffMonths) return 0
  if (m >= g.vestingMonths) return g.shares
  return Math.floor((g.shares * m) / g.vestingMonths)
}

/**
 * Vested shares the holder actually keeps on a date: vesting stops at the cancellation date or the
 * holder's last day, and never exceeds the shares still held. Reserved grants (offer still out) vest nothing.
 */
export function vestedHeld(db: DB, grant: EquityGrant, date: ISODate): number {
  if (grant.status === 'reserved') return 0
  const stop = vestingStop(db, grant)
  return Math.min(vestedShares(grant, stop && stop < date ? stop : date), sharesHeld(grant))
}

export type VestingPoint = { date: ISODate; vested: number }

/**
 * Monthly cumulative vested shares for a chart, from the vesting start to the fully vested date
 * (vestingMonths + 1 points). After the cancellation date, or `stop` when earlier (the holder's last day,
 * from vestingStop), the line stays flat at what was kept.
 */
export function vestingPoints(grant: EquityGrant, stop?: ISODate): VestingPoint[] {
  const months = Math.max(0, grant.vestingMonths)
  const kept = sharesHeld(grant)
  const end = [grant.cancelledOn, stop].filter((d): d is ISODate => !!d).sort()[0]
  const points: VestingPoint[] = []
  let frozen: number | null = null
  for (let m = 0; m <= months; m++) {
    const date = addMonths(grant.vestingStart, m)
    let vested = vestAtMonth(grant, m)
    if (end && date > end) {
      if (frozen == null) frozen = Math.min(vestedShares(grant, end), kept)
      vested = frozen
    }
    points.push({ date, vested })
  }
  return points
}

/** "4-year vesting, 1-year cliff, then monthly" or "Monthly over 2 years, no cliff". */
export function scheduleText(grant: Pick<EquityGrant, 'cliffMonths' | 'vestingMonths'>): string {
  const span = (m: number, adjective: boolean) => {
    if (m % 12 === 0) {
      const y = m / 12
      return adjective ? `${y}-year` : `${y} ${y === 1 ? 'year' : 'years'}`
    }
    return adjective ? `${m}-month` : `${m} ${m === 1 ? 'month' : 'months'}`
  }
  if (grant.vestingMonths <= 0) return 'Fully vested at grant'
  if (grant.cliffMonths <= 0) return `Monthly over ${span(grant.vestingMonths, false)}, no cliff`
  return `${span(grant.vestingMonths, true)} vesting, ${span(grant.cliffMonths, true)} cliff, then monthly`
}

// Helpers below are function declarations, not module constants: equity.ts imports the store, and the
// sample seed may call these functions while that import cycle is still loading.

/** Approved and promised grants are live (promised ones vest from the start date, pending board consent). */
function isLive(status: EquityGrant['status']): boolean {
  return status === 'approved' || status === 'promised'
}

export type VestEvent = {
  personId: ID
  grantId: ID
  date: ISODate
  /** Shares vesting on this date. */
  shares: number
  /** Total vested after this date. */
  cumulative: number
  isCliff: boolean
  /** The grant still waits for board consent. */
  awaitingBoard: boolean
}

/** Live grants (approved or promised) whose holder is still working for the company on `date`. */
function liveOn(db: DB, grant: EquityGrant, date: ISODate): boolean {
  if (!isLive(grant.status) || sharesHeld(grant) <= 0) return false
  if (grant.cancelledOn && grant.cancelledOn < date) return false
  const end = holderEndDate(db, grant)
  return !end || end >= date
}

/** Every vest date (cliff and monthly) between from and to, inclusive, for live grants. */
export function upcomingVests(db: DB, from: ISODate, to: ISODate): VestEvent[] {
  const out: VestEvent[] = []
  for (const g of db.grants) {
    if (!isLive(g.status)) continue
    const first = Math.max(g.cliffMonths, 1)
    for (let m = first; m <= g.vestingMonths; m++) {
      const date = addMonths(g.vestingStart, m)
      if (date > to) break
      if (date < from || !liveOn(db, g, date)) continue
      const shares = vestAtMonth(g, m) - (m === g.cliffMonths ? 0 : vestAtMonth(g, m - 1))
      if (shares <= 0) continue
      out.push({
        personId: g.personId,
        grantId: g.id,
        date,
        shares,
        cumulative: vestAtMonth(g, m),
        isCliff: g.cliffMonths > 0 && m === g.cliffMonths,
        awaitingBoard: g.status === 'promised',
      })
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.personId.localeCompare(b.personId))
}

export type CliffEvent = { personId: ID; grantId: ID; date: ISODate; shares: number; awaitingBoard: boolean }

/** Cliffs between from and to, inclusive ("Kofi hits his 1-year cliff Tue Oct 6: 13,000 options vest"). */
export function upcomingCliffs(db: DB, from: ISODate, to: ISODate): CliffEvent[] {
  return upcomingVests(db, from, to)
    .filter((v) => v.isCliff)
    .map((v) => ({ personId: v.personId, grantId: v.grantId, date: v.date, shares: v.shares, awaitingBoard: v.awaitingBoard }))
}

// ---------------------------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------------------------

export type PoolSummary = {
  /** Pool size on the date: the base pool plus increases dated on or before it. */
  poolShares: number
  basePool: number
  increases: number
  /** Board-approved grants, minus shares returned (exercised shares stay counted). */
  grantedOutstanding: number
  exercised: number
  /** Promised grants: accepted offers and other grants waiting for board consent. */
  awaitingBoard: number
  /** Reserved grants plus outstanding offers with equity and no grant row yet. */
  reservedByOffers: number
  /** Shares returned to the pool from cancelled or forfeited board-approved grants (including unrecorded forfeitures). */
  returned: number
  /**
   * Unvested shares of approved grants whose holder has left (end date before `date`) with no cancellation
   * recorded. They are counted in `returned`; the UI can prompt to record them.
   */
  unrecordedForfeitures: number
  unrecordedGrantIds: ID[]
  available: number
  /** Share of the pool used or spoken for (0 to 1). */
  usedPct: number
}

export function poolSummary(db: DB, date: ISODate): PoolSummary {
  const increases = db.equity.poolIncreases.filter((i) => i.date <= date).reduce((t, i) => t + i.shares, 0)
  const poolShares = db.equity.poolShares + increases
  const lapsedOfferIds = new Set(db.offers.filter((o) => offerLapsed(o, date)).map((o) => o.id))
  let granted = 0
  let exercised = 0
  let awaiting = 0
  let reserved = 0
  let returned = 0
  let unrecorded = 0
  const unrecordedGrantIds: ID[] = []
  for (const g of db.grants) {
    if (g.status === 'approved' || (g.status === 'cancelled' && g.boardApprovedOn)) {
      exercised += g.exercisedShares ?? 0
      const end = g.status === 'approved' && g.cancelledShares == null ? holderEndDate(db, g) : undefined
      if (end && end < date) {
        // The holder left but no cancellation was recorded: unvested shares go back to the pool.
        const kept = Math.min(g.shares, Math.max(vestedShares(g, end), g.exercisedShares ?? 0))
        granted += kept
        if (g.shares - kept > 0) {
          returned += g.shares - kept
          unrecorded += g.shares - kept
          unrecordedGrantIds.push(g.id)
        }
        continue
      }
      // A leaver's unvested shares come back on the cancellation date (their last day), not before.
      granted += sharesHeld(g, date)
      returned += sharesReturned(g, date)
    } else if (g.status === 'promised') awaiting += sharesHeld(g, date)
    else if (g.status === 'reserved' && !(g.fromOfferId && lapsedOfferIds.has(g.fromOfferId))) reserved += sharesHeld(g, date)
  }
  // Offers out (not past expiry) whose equity has no grant row yet still hold shares back.
  for (const o of outstandingOffers(db, date)) {
    if (!o.equityShares) continue
    const hasGrant = db.grants.some(
      (g) => g.fromOfferId === o.id || (g.personId === o.candidateId && (g.status === 'reserved' || g.status === 'promised')),
    )
    if (!hasGrant) reserved += o.equityShares
  }
  const available = poolShares - granted - awaiting - reserved
  return {
    poolShares,
    basePool: db.equity.poolShares,
    increases,
    grantedOutstanding: granted,
    exercised,
    awaitingBoard: awaiting,
    reservedByOffers: reserved,
    returned,
    unrecordedForfeitures: unrecorded,
    unrecordedGrantIds,
    available,
    usedPct: poolShares > 0 ? (poolShares - available) / poolShares : 0,
  }
}

// ---------------------------------------------------------------------------------------------
// 409A warnings
// ---------------------------------------------------------------------------------------------

export type ValuationWarning = {
  kind: 'missing' | 'expired' | 'expiring' | 'financing' | 'strike'
  text: string
  valuationId?: ID
  roundId?: ID
  grantId?: ID
}

/**
 * Warnings about the 409A in effect on `date`: none on file while grants exist, expired, expiring within
 * 60 days, a funding round closed after it, and promised grants whose strike differs from it. Pass the
 * board date to check a consent before it happens.
 */
export function valuationWarnings(db: DB, date: ISODate): ValuationWarning[] {
  const out: ValuationWarning[] = []
  const v = current409A(db, date)
  if (!v) {
    if (db.grants.some((g) => g.status !== 'cancelled')) {
      out.push({ kind: 'missing', text: 'No 409A valuation on file. Get one before the board grants options, so the strike price has safe harbor.' })
    }
    return out
  }
  const left = daysBetween(date, v.expiresOn)
  if (left < 0) {
    out.push({
      kind: 'expired',
      valuationId: v.id,
      text: `The 409A from ${fmtDate(v.effectiveOn)} expired on ${fmtDate(v.expiresOn)}. Get a new valuation before the next board grant.`,
    })
  } else if (left <= 60) {
    const when = left === 0 ? 'today' : left === 1 ? 'tomorrow' : `in ${left} days (${fmtDate(v.expiresOn)})`
    out.push({
      kind: 'expiring',
      valuationId: v.id,
      text: `The 409A from ${fmtDate(v.effectiveOn)} expires ${when}. Plan the next valuation now so grants keep safe harbor.`,
    })
  }
  for (const r of db.company.fundingRounds) {
    if (r.closedOn > v.effectiveOn && r.closedOn <= date) {
      out.push({
        kind: 'financing',
        valuationId: v.id,
        roundId: r.id,
        text: `The ${r.name} round closed on ${fmtDate(r.closedOn)}, after the current 409A (${fmtDate(v.effectiveOn)}). A financing usually ends safe harbor, so get a new 409A before the next grant.`,
      })
    }
  }
  for (const g of db.grants) {
    if (g.status !== 'promised' || !g.strikePrice || Math.abs(g.strikePrice - v.fmvPerShare) < 0.005) continue
    out.push({
      kind: 'strike',
      valuationId: v.id,
      grantId: g.id,
      text: `${holderName(db, g)}'s grant shows a ${money2(g.strikePrice)} strike, but the 409A in effect is ${money2(v.fmvPerShare)}. The strike is set when the board approves the grant.`,
    })
  }
  return out
}

/**
 * logActivity, guarded: if the sample seed calls this module while the store is still loading (the
 * store -> seed -> domain import cycle, under module runners without live bindings), write the row directly.
 */
function log(draft: Draft<DB>, a: Parameters<typeof logActivity>[1]): void {
  try {
    logActivity(draft, a)
  } catch {
    draft.activity.push({ id: newId('act'), at: nowISO(), actorId: null, ...a })
  }
}

// ---------------------------------------------------------------------------------------------
// Board consent
// ---------------------------------------------------------------------------------------------

/** Grants waiting for board consent (promised), oldest first. */
export function boardConsentQueue(db: DB): EquityGrant[] {
  return db.grants
    .filter((g) => g.status === 'promised')
    .sort(
      (a, b) =>
        (a.proposedOn ?? a.vestingStart).localeCompare(b.proposedOn ?? b.vestingStart) ||
        holderName(db, a).localeCompare(holderName(db, b)),
    )
}

/**
 * Tab-separated consent table for counsel or the cap table tool, with a header row:
 * Name, Shares, Type, Strike, Vest start, Schedule. Pass the intended board date as `date`. Promised grants
 * show the 409A in effect on that date, the strike approveGrants will set (with `keepStrike`, the stored
 * strike, as in approveGrants); the stored strike is used when no 409A is on file and for approved grants.
 */
export function consentTableText(db: DB, grantIds: ID[], date: ISODate, opts: { keepStrike?: boolean } = {}): string {
  const fmv = current409A(db, date)?.fmvPerShare
  const rows = grantIds
    .map((id) => db.grants.find((g) => g.id === id))
    .filter((g): g is EquityGrant => !!g)
    .map((g) => {
      const priceAtGrant = g.status === 'promised' && !opts.keepStrike && fmv != null
      const strike = priceAtGrant ? fmv : g.strikePrice || fmv
      return [holderName(db, g), num(g.shares), g.type, strike ? money2(strike) : 'Set at grant', g.vestingStart, scheduleText(g)].join('\t')
    })
  return [['Name', 'Shares', 'Type', 'Strike', 'Vest start', 'Schedule'].join('\t'), ...rows].join('\n')
}

/**
 * True when approving the grant on the board date would record a $0 strike: an option grant with no strike
 * entered and no 409A in effect on that date. Options are priced at fair market value on the grant date,
 * so such a grant waits for a valuation (approveGrants skips it).
 */
export function grantNeeds409A(db: DB, grant: Pick<EquityGrant, 'type' | 'strikePrice'>, boardDate: ISODate): boolean {
  return grant.type !== 'RSA' && !(grant.strikePrice > 0) && current409A(db, boardDate) == null
}

/** The onboarding task that waits on the hire grant's board consent (templates.ts ONBOARDING). */
const EQUITY_BOARD_TASK = 'on-equity-board'

/** A refresh grant queued by a job or pay change (changeJobOrPay), found the way cancelScheduledChange finds it. */
function isRefreshGrant(g: Pick<EquityGrant, 'fromOfferId' | 'note'>): boolean {
  return !g.fromOfferId && /^Refresh grant/.test(g.note ?? '')
}

/**
 * Closes the checklist tasks that wait on board consent for the approved grants, through setTaskStatus so each
 * checklist's completion stays in step: a refresh grant's 'ch-refresh-grant' task (on the change checklist dated
 * on the grant's vesting start, else the person's oldest open one), and the onboarding 'on-equity-board' task
 * once none of the person's other grants (refresh grants aside) still waits for the board. Returns how many closed.
 */
function closeBoardConsentTasks(draft: Draft<DB>, approved: EquityGrant[], on: ISODate): number {
  const byId = currentActorId(draft as DB)
  let n = 0
  const openTasks = (personId: ID, templateTaskId: string) =>
    draft.checklists
      .filter((c) => c.personId === personId)
      .sort((a, b) => a.createdOn.localeCompare(b.createdOn))
      .flatMap((c) => c.tasks.filter((t) => t.status === 'open' && t.templateTaskId === templateTaskId).map((t) => ({ checklistId: c.id, kind: c.kind, anchorDate: c.anchorDate, taskId: t.id })))
  for (const g of approved.filter(isRefreshGrant)) {
    const open = openTasks(g.personId, TASK_IDS.refreshGrant)
    const pick = open.find((o) => o.kind === 'change' && o.anchorDate === g.vestingStart) ?? open[0]
    if (pick && setTaskStatus(draft, pick.checklistId, pick.taskId, 'done', { date: on, byId })) n++
  }
  for (const personId of new Set(approved.filter((g) => !isRefreshGrant(g)).map((g) => g.personId))) {
    if (draft.grants.some((g) => g.personId === personId && g.status === 'promised' && !isRefreshGrant(g))) continue
    for (const o of openTasks(personId, EQUITY_BOARD_TASK)) {
      if (setTaskStatus(draft, o.checklistId, o.taskId, 'done', { date: on, byId })) n++
    }
  }
  return n
}

export type ApproveGrantsResult = {
  approved: ID[]
  /** Ids that were left alone: not promised grants, or option grants with no 409A to price them (noStrike). */
  skipped: ID[]
  /** The skipped option grants that need a 409A in effect on the board date first (grantNeeds409A). */
  noStrike: ID[]
  /** Checklist tasks waiting on this consent that were marked done ('on-equity-board', 'ch-refresh-grant'). */
  tasksClosed: number
  /** True when these are the company's first option grants (the 25102(o) notice clock starts). */
  firstIssuance: boolean
  /** California 25102(o) notice due date, 30 days after the first issuance (docs/SPEC.md). */
  notice25102oDueOn?: ISODate
  /**
   * The note about grants not approved for lack of a 409A first (when any), then 409A warnings on the board
   * date, a note when the board date is after `date`, and a late 25102(o) notice.
   */
  warnings: string[]
}

/**
 * Marks promised grants as board approved on `boardDate`. By default the strike is set to the 409A in
 * effect on the board date (options are priced at grant). The checklist tasks that wait on the consent
 * close with it (closeBoardConsentTasks), dated the board date, or today for a board date still ahead.
 * The 25102(o) notice is due 30 days after the first issuance, so equity.firstIssuanceOn is the earliest board
 * approval on record: when it is unset and earlier grants were already approved (approved, or cancelled after
 * board approval), it is set to the earliest of those and this is not the first issuance (with a warning when
 * no filing is recorded). Only with no earlier approval is it set to the board date and the notice clock started.
 */
export function approveGrants(
  draft: Draft<DB>,
  grantIds: ID[],
  boardDate: ISODate,
  opts: { date: ISODate; keepStrike?: boolean },
): ApproveGrantsResult {
  const db = draft as DB
  // Earliest earlier board approval, read before this approval changes any status.
  const earlier = db.grants
    .filter((g) => (g.status === 'approved' || g.status === 'cancelled') && !!g.boardApprovedOn)
    .map((g) => g.boardApprovedOn as ISODate)
    .sort()[0]
  const fmv = current409A(db, boardDate)?.fmvPerShare
  const approved: ID[] = []
  const skipped: ID[] = []
  const noStrike: ID[] = []
  for (const id of grantIds) {
    const g = draft.grants.find((x) => x.id === id)
    if (!g || g.status !== 'promised') {
      skipped.push(id)
      continue
    }
    // Options are priced at fair market value on the grant date: with no 409A in effect and no strike
    // entered, approving would record a $0 strike, so the grant waits for a valuation.
    if (grantNeeds409A(db, g, boardDate)) {
      skipped.push(id)
      noStrike.push(id)
      continue
    }
    g.status = 'approved'
    g.boardApprovedOn = boardDate
    if (!opts.keepStrike && fmv != null) g.strikePrice = fmv
    approved.push(id)
    log(draft, {
      entityType: 'equity',
      entityId: g.id,
      relatedId: g.personId,
      kind: 'grant_approved',
      // No share counts or prices: activity can be seen outside Admin.
      text: `Board approved the ${g.type === 'RSA' ? 'restricted stock' : 'option'} grant for ${holderName(db, g)} (board date ${fmtDate(boardDate)})`,
    })
  }
  const approvedGrants = draft.grants.filter((g) => approved.includes(g.id))
  const tasksClosed = approvedGrants.length ? closeBoardConsentTasks(draft, approvedGrants, boardDate < opts.date ? boardDate : opts.date) : 0
  // What went wrong comes first; the generic "no 409A on file" warning would only repeat it.
  const warnings: string[] = []
  if (noStrike.length) {
    warnings.push(
      `${noStrike.length === 1 ? '1 option grant was' : `${noStrike.length} option grants were`} not approved: no 409A valuation is in effect on ${fmtDate(boardDate)}, so there is no strike price. Record a 409A first.`,
    )
  }
  for (const w of valuationWarnings(db, boardDate)) {
    if (w.kind === 'strike' || (w.kind === 'missing' && noStrike.length)) continue
    warnings.push(w.text)
  }
  if (boardDate > opts.date) warnings.push(`The board date ${fmtDate(boardDate)} is after today.`)
  let firstIssuance = false
  let notice25102oDueOn: ISODate | undefined
  const prior = [draft.equity.firstIssuanceOn, earlier].filter((d): d is ISODate => !!d).sort()[0]
  if (approved.length && prior && prior <= boardDate) {
    if (!draft.equity.firstIssuanceOn) {
      // Earlier approvals exist but the first issuance was never recorded: record the earliest one.
      draft.equity.firstIssuanceOn = prior
      const due = addDays(prior, 30)
      log(draft, {
        entityType: 'equity',
        entityId: 'equity',
        kind: 'first_issuance',
        text: `First option grants recorded as of ${fmtDate(prior)}, the earliest board approval on file. The California 25102(o) notice was due by ${fmtDate(due)}.`,
      })
      if (!draft.equity.filing25102oOn) {
        warnings.push(
          `The California 25102(o) notice was due by ${fmtDate(due)}, 30 days after the first option grants on ${fmtDate(prior)}. No filing is recorded, so file it now or record the filing date.`,
        )
      }
    }
  } else if (approved.length) {
    // No earlier approval (or this board date comes before every one on file): this is the first issuance.
    firstIssuance = true
    draft.equity.firstIssuanceOn = boardDate
    notice25102oDueOn = addDays(boardDate, 30)
    log(draft, {
      entityType: 'equity',
      entityId: 'equity',
      kind: 'first_issuance',
      text: `First option grants recorded on ${fmtDate(boardDate)}. The California 25102(o) notice is due by ${fmtDate(notice25102oDueOn)}.`,
    })
  }
  return { approved, skipped, noStrike, tasksClosed, firstIssuance, ...(notice25102oDueOn ? { notice25102oDueOn } : {}), warnings }
}

/** Last day to exercise vested options after leaving: last day + the grant's post-termination window (90 days by default). */
export function exerciseDeadline(grant: Pick<EquityGrant, 'postTerminationExerciseDays'>, lastDay: ISODate): ISODate {
  return addDays(lastDay, grant.postTerminationExerciseDays > 0 ? grant.postTerminationExerciseDays : 90)
}

// ---------------------------------------------------------------------------------------------
// 409A valuations and cap table numbers (entered by the founder; the cap table tool stays the source of truth)
// ---------------------------------------------------------------------------------------------

export type ValuationInput = Omit<Valuation409A, 'id'>

export type ValuationField = 'effectiveOn' | 'fmvPerShare' | 'provider' | 'expiresOn'

/** Safe harbor end to suggest: 12 months after the effective date (a priced round or other material event ends it sooner). */
export function defaultSafeHarborEnd(effectiveOn: ISODate): ISODate {
  return addMonths(effectiveOn, 12)
}

/**
 * Problems with a 409A entry, pinned to the field to fix (empty when it can be saved). `others` are the
 * valuations already on file (leave out the one being edited): two on the same date would make the one
 * in effect ambiguous.
 */
export function valuationErrors(
  v: { effectiveOn?: ISODate | null; fmvPerShare?: number | null; provider?: string | null; expiresOn?: ISODate | null },
  others: ReadonlyArray<Pick<Valuation409A, 'effectiveOn'>> = [],
): Partial<Record<ValuationField, string>> {
  const out: Partial<Record<ValuationField, string>> = {}
  if (!v.effectiveOn) out.effectiveOn = 'Pick the effective date from the valuation report.'
  else if (others.some((o) => o.effectiveOn === v.effectiveOn)) out.effectiveOn = 'A 409A with this effective date is already on file. Edit that one instead.'
  if (v.fmvPerShare == null || !Number.isFinite(v.fmvPerShare) || v.fmvPerShare <= 0) out.fmvPerShare = 'Enter the fair market value a share, more than $0.'
  if (!v.provider?.trim()) out.provider = 'Name the firm that did the valuation.'
  if (!v.expiresOn) out.expiresOn = 'Pick the date safe harbor ends.'
  else if (v.effectiveOn && v.expiresOn <= v.effectiveOn) out.expiresOn = 'Safe harbor has to end after the effective date.'
  return out
}

function cleanValuation(input: ValuationInput): ValuationInput {
  const out: ValuationInput = {
    effectiveOn: input.effectiveOn,
    fmvPerShare: Math.round(input.fmvPerShare * 10_000) / 10_000,
    provider: input.provider.trim(),
    expiresOn: input.expiresOn,
  }
  if (input.note?.trim()) out.note = input.note.trim()
  return out
}

/** Records a 409A valuation and logs it (with no price: activity can be seen outside Admin). Returns its id. */
export function addValuation(draft: Draft<DB>, input: ValuationInput): ID {
  const v: Valuation409A = { id: newId('v'), ...cleanValuation(input) }
  draft.equity.valuations.push(v)
  log(draft, {
    entityType: 'equity',
    entityId: v.id,
    kind: 'valuation_recorded',
    text: `Recorded a 409A valuation effective ${fmtDate(v.effectiveOn)} from ${v.provider}, safe harbor until ${fmtDate(v.expiresOn)}`,
  })
  return v.id
}

/** Corrects a 409A valuation on file. Returns false when there is no such valuation or nothing changed. */
export function updateValuation(draft: Draft<DB>, id: ID, input: ValuationInput): boolean {
  const list = draft.equity.valuations
  const i = list.findIndex((v) => v.id === id)
  if (i < 0) return false
  const next: Valuation409A = { id, ...cleanValuation(input) }
  if (JSON.stringify(next) === JSON.stringify(list[i])) return false
  list[i] = next
  log(draft, { entityType: 'equity', entityId: id, kind: 'valuation_updated', text: `Updated the 409A valuation effective ${fmtDate(next.effectiveOn)}` })
  return true
}

/** Removes a 409A valuation entered by mistake. Approved grants keep the strike they were given. */
export function removeValuation(draft: Draft<DB>, id: ID): boolean {
  const v = draft.equity.valuations.find((x) => x.id === id)
  if (!v) return false
  draft.equity.valuations = draft.equity.valuations.filter((x) => x.id !== id)
  log(draft, { entityType: 'equity', entityId: id, kind: 'valuation_removed', text: `Removed the 409A valuation effective ${fmtDate(v.effectiveOn)}` })
  return true
}

export type CapTable = Pick<EquitySetup, 'authorizedShares' | 'fullyDilutedShares' | 'founderShares' | 'poolShares'>

export type CapTableField = keyof CapTable

/**
 * Problems with cap table numbers, pinned to the field to fix: whole shares, founder shares plus the option
 * pool (with `poolIncreases`, shares the board added to the pool later) within fully diluted, and fully
 * diluted within authorized.
 */
export function capTableErrors(c: { [K in CapTableField]: number | null }, poolIncreases = 0): Partial<Record<CapTableField, string>> {
  const out: Partial<Record<CapTableField, string>> = {}
  const labels: Record<CapTableField, string> = {
    authorizedShares: 'authorized shares',
    fullyDilutedShares: 'fully diluted shares',
    founderShares: 'founder shares',
    poolShares: 'option pool',
  }
  for (const k of Object.keys(labels) as CapTableField[]) {
    const n = c[k]
    if (n == null || !Number.isFinite(n)) out[k] = `Enter the ${labels[k]}.`
    else if (!Number.isInteger(n) || n < 0) out[k] = 'Use a whole number of shares, 0 or more.'
  }
  if (!out.fullyDilutedShares && (c.fullyDilutedShares ?? 0) <= 0) out.fullyDilutedShares = 'Fully diluted shares must be more than 0.'
  if (Object.keys(out).length) return out
  const fd = c.fullyDilutedShares as number
  const used = (c.founderShares as number) + (c.poolShares as number) + poolIncreases
  if (used > fd) {
    out.fullyDilutedShares = `Fully diluted has to cover the founder shares plus the whole option pool (${num(used)}${poolIncreases ? `, with ${num(poolIncreases)} added to the pool later` : ''}).`
  } else if (fd > (c.authorizedShares as number)) {
    out.authorizedShares = 'Authorized shares have to be at least the fully diluted count. The charter sets how many the company may issue.'
  }
  return out
}

/**
 * The one write path for the cap table numbers (authorized, fully diluted, founder and pool shares). Pool
 * increases stay as they are. Saving marks the numbers as entered (`capTableConfirmedOn`), and saving the
 * placeholder numbers unchanged confirms them. Logs no counts (activity can be seen outside Admin). Returns
 * false when nothing changed.
 */
export function updateCapTable(draft: Draft<DB>, c: CapTable, on: ISODate): boolean {
  const e = draft.equity
  if (
    e.authorizedShares === c.authorizedShares &&
    e.fullyDilutedShares === c.fullyDilutedShares &&
    e.founderShares === c.founderShares &&
    e.poolShares === c.poolShares
  ) {
    return confirmCapTable(draft, on)
  }
  e.authorizedShares = c.authorizedShares
  e.fullyDilutedShares = c.fullyDilutedShares
  e.founderShares = c.founderShares
  e.poolShares = c.poolShares
  e.capTableConfirmedOn = on
  log(draft, { entityType: 'equity', entityId: 'equity', kind: 'cap_table_updated', text: 'Updated the cap table: authorized, fully diluted, founder and option pool shares' })
  return true
}

/** 'These numbers are right': confirms the cap table numbers on file. Returns false when they already were. */
export function confirmCapTable(draft: Draft<DB>, on: ISODate): boolean {
  if (draft.equity.capTableConfirmedOn) return false
  draft.equity.capTableConfirmedOn = on
  log(draft, { entityType: 'equity', entityId: 'equity', kind: 'cap_table_confirmed', text: 'Confirmed the cap table numbers' })
  return true
}

// ---------------------------------------------------------------------------------------------
// Per-person summary
// ---------------------------------------------------------------------------------------------

export type GrantSummary = {
  /** Grants that count for the person: approved, promised, or cancelled with shares kept. */
  grants: EquityGrant[]
  totalShares: number
  vested: number
  unvested: number
  exercised: number
  /** Shares in promised grants (waiting for board consent). */
  awaitingBoard: number
  /** Shares reserved by an offer that is still out. */
  reserved: number
  nextVest: { date: ISODate; shares: number } | null
  /** The next cliff, or the most recent one once all cliffs have passed. */
  cliff: { date: ISODate; shares: number; passed: boolean } | null
  /** When the last live grant finishes vesting; null when vesting stops at the holder's last day first. */
  fullyVestedOn: ISODate | null
  /**
   * The holder's last day (end date, separation or contract end), once one is known: vesting stops there,
   * what had vested is kept, the unvested shares go back to the pool, and vested options can be exercised
   * until exerciseBy (null when nothing vested, or only restricted stock).
   */
  exit: { lastDay: ISODate; vestedAtExit: number; returnsToPool: number; exerciseBy: ISODate | null } | null
  pctFullyDiluted: number
  /** leaving = a last day is set and has not passed yet; ended = it has passed. */
  status: 'none' | 'reserved' | 'awaiting_board' | 'pre_cliff' | 'vesting' | 'fully_vested' | 'leaving' | 'ended'
  text: string
}

export function grantSummary(db: DB, personId: ID, date: ISODate): GrantSummary {
  const all = grantsFor(db, personId)
  const grants = all.filter((g) => isLive(g.status) || (g.status === 'cancelled' && sharesHeld(g) > 0))
  const reserved = all.filter((g) => g.status === 'reserved').reduce((t, g) => t + g.shares, 0)
  const totalShares = grants.reduce((t, g) => t + sharesHeld(g), 0)
  const vested = grants.reduce((t, g) => t + vestedHeld(db, g, date), 0)
  const exercised = grants.reduce((t, g) => t + (g.exercisedShares ?? 0), 0)
  const awaitingBoard = grants.filter((g) => g.status === 'promised').reduce((t, g) => t + sharesHeld(g), 0)
  const live = grants.filter((g) => liveOn(db, g, date))

  let nextVest: GrantSummary['nextVest'] = null
  let cliff: GrantSummary['cliff'] = null
  for (const g of live) {
    const credited = creditedMonths(g.vestingStart, date)
    if (credited >= g.vestingMonths) continue
    const nextM = credited < g.cliffMonths ? g.cliffMonths : credited + 1
    const nextDate = addMonths(g.vestingStart, Math.max(nextM, 1))
    // Nothing vests after the last day (or the cancellation date).
    const stop = vestingStop(db, g)
    if (stop && nextDate > stop) continue
    const shares = vestAtMonth(g, Math.max(nextM, 1)) - vestAtMonth(g, credited)
    if (shares > 0) {
      if (!nextVest || nextDate < nextVest.date) nextVest = { date: nextDate, shares }
      else if (nextDate === nextVest.date) nextVest = { date: nextDate, shares: nextVest.shares + shares }
    }
  }
  for (const g of grants) {
    if (g.cliffMonths <= 0) continue
    const d = cliffDate(g)
    const c = { date: d, shares: vestAtMonth(g, g.cliffMonths), passed: d <= date }
    const stop = vestingStop(db, g)
    if (!c.passed && (!liveOn(db, g, date) || (stop && d > stop))) continue
    if (!cliff) cliff = c
    else if (!c.passed && (cliff.passed || d < cliff.date)) cliff = c
    else if (c.passed && cliff.passed && d > cliff.date) cliff = c
  }
  // A grant whose vesting stops before its schedule ends is never fully vested.
  const completes = live.filter((g) => {
    const stop = vestingStop(db, g)
    return !stop || fullyVestedDate(g) <= stop
  })
  const fullyVestedOn = live.length && completes.length === live.length ? live.map((g) => fullyVestedDate(g)).sort().reverse()[0] : null
  const ended = grants.length > 0 && live.length === 0 && grants.every((g) => g.status === 'cancelled' || !!holderEndDate(db, g))

  const lastDay = holderEndDate(db, { personId })
  let exit: GrantSummary['exit'] = null
  if (lastDay && all.some((g) => g.status !== 'reserved')) {
    const vestedAtExit = grants.reduce((t, g) => t + vestedHeld(db, g, lastDay), 0)
    // Everything granted that had not vested by the last day goes back: recorded cancellations and the rest.
    const returnsToPool = all.filter((g) => g.status !== 'reserved').reduce((t, g) => t + g.shares - vestedHeld(db, g, lastDay), 0)
    const options = grants.filter((g) => g.type !== 'RSA' && vestedHeld(db, g, lastDay) > 0)
    const recorded = db.people.find((p) => p.id === personId)?.separation?.exerciseDeadline
    const exerciseBy = options.length ? (recorded ?? options.map((g) => exerciseDeadline(g, lastDay)).sort()[0]) : null
    exit = { lastDay, vestedAtExit, returnsToPool, exerciseBy }
  }

  let status: GrantSummary['status']
  let text: string
  if (!grants.length) {
    status = reserved ? 'reserved' : 'none'
    text = reserved ? `${num(reserved)} options reserved in an offer` : 'No equity grants'
  } else if (ended) {
    status = 'ended'
    text = `${num(vested)} vested options kept after leaving`
  } else if (exit && exit.lastDay >= date) {
    status = 'leaving'
    text =
      exit.returnsToPool > 0
        ? `Vesting stops ${fmtDate(exit.lastDay)}: ${num(exit.vestedAtExit)} vested, ${num(exit.returnsToPool)} return to the pool`
        : `Last day ${fmtDate(exit.lastDay)}, fully vested: ${plural(exit.vestedAtExit, 'option')}`
  } else if (awaitingBoard === totalShares) {
    status = 'awaiting_board'
    text = 'Grant awaiting board consent'
  } else if (vested >= totalShares) {
    status = 'fully_vested'
    text = `Fully vested: ${plural(totalShares, 'option')}`
  } else if (vested === 0) {
    status = 'pre_cliff'
    text = cliff && !cliff.passed ? `${num(cliff.shares)} options vest at the cliff on ${fmtDate(cliff.date)}` : `${num(totalShares)} options, none vested yet`
  } else {
    status = 'vesting'
    text = `${num(vested)} of ${num(totalShares)} vested${nextVest ? `; next ${num(nextVest.shares)} on ${fmtShort(nextVest.date)}` : ''}`
  }
  return {
    grants,
    totalShares,
    vested,
    unvested: Math.max(0, totalShares - vested),
    exercised,
    awaitingBoard,
    reserved,
    nextVest,
    cliff,
    fullyVestedOn,
    exit,
    pctFullyDiluted: pctOfFullyDiluted(db, totalShares),
    status,
    text,
  }
}
