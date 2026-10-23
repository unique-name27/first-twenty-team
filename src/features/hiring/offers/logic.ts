// Pure helpers for offers, the position-in-band meter, background checks and the Offers tab, plus the
// in-memory cache of unsaved offer builder forms (one page load).
// No store or React imports, so they can be unit tested (logic.test.ts).
import { RULES } from '@/domain/compliance'
import { type DesiredPay, desiredAnnual, desiredHourly } from '@/domain/hiring/util'
import { isEmployedOn } from '@/domain/people'
import type { Band, BackgroundCheck, CompRecord, ID, Job, Offer, OfferStatus, Person } from '@/domain/types'
import { addBusinessDays, addDays, fmtDay, fmtShort, type ISODate, parseDate } from '@/lib/dates'

export const OFFER_STATUS: Record<OfferStatus, { label: string; tone: 'neutral' | 'accent' | 'good' | 'warn' | 'outline' }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  awaiting_approval: { label: 'Waiting for approval', tone: 'warn' },
  approved: { label: 'Approved', tone: 'accent' },
  sent: { label: 'Out', tone: 'accent' },
  accepted: { label: 'Accepted', tone: 'good' },
  declined: { label: 'Declined', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'neutral' },
  rescinded: { label: 'Rescinded', tone: 'outline' },
}

/** One-tap reasons for going above the band or the equity guideline. */
export function exceptionReasonChoices(): string[] {
  return ['Competing offer', 'Rare skill set', 'Founding-level scope', 'Internal equity', 'Market moved since bands were set']
}

/** Reason chips when a candidate declines (stored as the offer's decline reason). */
export function declineReasonChoices(): Array<{ value: string; label: string }> {
  return [
    { value: 'chose_other_offer', label: 'Competing offer' },
    { value: 'Counteroffer from current employer', label: 'Counteroffer' },
    { value: 'comp', label: 'Comp' },
    { value: 'location', label: 'Location' },
    { value: 'timing', label: 'Timing' },
    { value: 'other', label: 'Other' },
  ]
}

export function rescindReasonChoices(): string[] {
  return ['Role on hold', 'Budget changed', 'Contingency not met', 'Offer made in error']
}

/** Mondays from the default start date on (holidays move to the next business day). */
export function startDatePresets(defaultStart: ISODate, count = 4): Array<{ label: string; date: ISODate }> {
  const out: Array<{ label: string; date: ISODate }> = []
  let d = defaultStart
  // Align to a Monday on or after the default.
  for (let i = 0; i < 7 && parseDate(d).getDay() !== 1; i++) d = addDays(d, 1)
  for (let i = 0; i < count; i++) {
    const date = addDays(d, 7 * i)
    out.push({ label: shortDay(date), date })
  }
  return out
}

/** Expiry presets: 3, 5 (default) and 7 business days from the date, plus 2 weeks. */
export function expiryPresets(date: ISODate, holidays: ISODate[] = []): Array<{ label: string; date: ISODate }> {
  return [
    { label: '3 business days', date: addBusinessDays(date, 3, holidays) },
    { label: '5 business days', date: addBusinessDays(date, 5, holidays) },
    { label: '7 business days', date: addBusinessDays(date, 7, holidays) },
    { label: '2 weeks', date: addDays(date, 14) },
  ]
}

/** Extension options from the later of today and the current expiry. */
export function extendOptions(expiresOn: ISODate, date: ISODate, holidays: ISODate[] = []): Array<{ days: number; date: ISODate }> {
  const from = expiresOn > date ? expiresOn : date
  return [2, 3, 5].map((days) => ({ days, date: addBusinessDays(from, days, holidays) }))
}

/** 'Mon, Nov 16' without the year. */
export function shortDay(d: ISODate): string {
  return fmtDay(d)
}

export type BandMeterGeometry = {
  /** Domain shown on the track (band padded so nearby outliers still fit). */
  lo: number
  hi: number
  /** Fraction 0..1 along the track for a value (clamped). */
  at: (v: number) => number
  /** True when the value sits outside the shown domain (drawn at the edge with an arrow). */
  clipped: (v: number) => boolean
}

/**
 * Track geometry for the position-in-band meter: the band plus 12% padding each side, widened to take
 * in `include` (the job's posted range) so both ranges fit on one scale.
 */
export function bandMeterGeometry(band: Pick<Band, 'min' | 'max'>, include: number[] = []): BandMeterGeometry {
  const from = Math.min(band.min, ...include)
  const to = Math.max(band.max, ...include)
  const span = Math.max(1, to - from)
  const lo = from - span * 0.12
  const hi = to + span * 0.12
  const raw = (v: number) => (v - lo) / (hi - lo)
  return {
    lo,
    hi,
    at: (v) => Math.max(0, Math.min(1, raw(v))),
    clipped: (v) => raw(v) < 0 || raw(v) > 1,
  }
}

/**
 * The job's posted pay range as annual base for the band meter (a range under $1,000 is hourly, as the
 * posting reads it, and is annualized at 2,080 hours). Null when the job has no range.
 */
export function postedRangeAnnual(job: Pick<Job, 'payMin' | 'payMax'> | undefined): { min: number; max: number } | null {
  if (!job || job.payMin == null || job.payMax == null) return null
  const scale = job.payMax < 1000 ? 2080 : 1
  return { min: Math.round(job.payMin * scale), max: Math.round(job.payMax * scale) }
}

export type BandMeterFigures = {
  /** 'hour' for an hourly offer: every figure is a rate. */
  unit: 'year' | 'hour'
  band: { min: number; mid: number; max: number }
  offer: number | null
  posted: { min: number; max: number } | null
  desired: number | null
  /** Set when the desired pay was given in this other unit and converted at 2,080 hours (the meter says so). */
  desiredFrom?: 'year' | 'hour'
}

/**
 * The band meter's figures in the offer's own terms, so it compares like with like. A salary reads in
 * annual base (an hourly posted range, and an hourly desired pay, at 2,080 hours). An hourly offer reads
 * in dollars an hour: its rate, an hourly posted range and an hourly desired pay as given, and the annual
 * band, an annual range and a yearly desired pay divided by 2,080 hours (full-time equivalent), rounded
 * to the cent. A plain number for `desired` is a yearly figure.
 */
export function bandMeterFigures(
  offer: Pick<Offer, 'payType' | 'salary' | 'hourlyRate'>,
  band: Pick<Band, 'min' | 'mid' | 'max'>,
  job: Pick<Job, 'payMin' | 'payMax'> | undefined,
  desired?: DesiredPay | number | null,
): BandMeterFigures {
  const want: DesiredPay | undefined = desired == null ? undefined : typeof desired === 'number' ? { amount: desired, unit: 'year' } : desired
  if (offer.payType !== 'hourly') {
    return {
      unit: 'year',
      band: { min: band.min, mid: band.mid, max: band.max },
      offer: offer.salary || null,
      posted: postedRangeAnnual(job),
      desired: desiredAnnual(want) ?? null,
      ...(want?.unit === 'hour' ? { desiredFrom: 'hour' as const } : {}),
    }
  }
  const hourly = (n: number) => Math.round((n / 2080) * 100) / 100
  const range = job && job.payMin != null && job.payMax != null ? (job.payMax < 1000 ? { min: job.payMin, max: job.payMax } : { min: hourly(job.payMin), max: hourly(job.payMax) }) : null
  const rate = desiredHourly(want)
  return {
    unit: 'hour',
    band: { min: hourly(band.min), mid: hourly(band.mid), max: hourly(band.max) },
    offer: offer.hourlyRate || null,
    posted: range,
    desired: rate != null ? Math.round(rate * 100) / 100 : null,
    ...(want?.unit === 'year' ? { desiredFrom: 'year' as const } : {}),
  }
}

/**
 * Unsaved offer builder forms, kept for this page load only (never stored): the builder writes its form
 * here while it differs from what it opened with, so following one of its own links (Record a 409A,
 * Check the cap table) and coming back brings the work back. Save and an explicit close clear it.
 * Keyed by application and offer ('new' for an offer not created yet); a new offer's draft also keeps
 * the version it was for, so it never comes back on a later version.
 */
const offerDrafts = new Map<string, { base: unknown; form: unknown; version?: number }>()

function offerDraftKey(applicationId: ID, offerId?: ID): string {
  return `${applicationId}:${offerId ?? 'new'}`
}

/** Keeps the builder's form (and the record it opened with, to spot changes made elsewhere since). */
export function keepOfferDraft<T>(applicationId: ID, offerId: ID | undefined, draft: { base: T; form: T; version?: number }): void {
  offerDrafts.set(offerDraftKey(applicationId, offerId), structuredClone(draft))
}

function findOfferDraft(applicationId: ID, offerId?: ID, version?: number) {
  const kept = offerDrafts.get(offerDraftKey(applicationId, offerId))
  if (!kept || (!offerId && version != null && kept.version != null && kept.version !== version)) return undefined
  return kept
}

/** The kept draft for an application and offer, if any (for a new offer, only for the same version). */
export function keptOfferDraft<T>(applicationId: ID, offerId?: ID, version?: number): { base: T; form: T } | undefined {
  const kept = findOfferDraft(applicationId, offerId, version)
  return kept ? (structuredClone(kept) as { base: T; form: T }) : undefined
}

/** True while unsaved builder changes are kept for the application and offer (the panel says so). */
export function hasKeptOfferDraft(applicationId: ID, offerId?: ID, version?: number): boolean {
  return !!findOfferDraft(applicationId, offerId, version)
}

export function dropOfferDraft(applicationId: ID, offerId?: ID): void {
  offerDrafts.delete(offerDraftKey(applicationId, offerId))
}

/**
 * A kept draft laid over the record as it is now: the fields the user changed come back, unless the
 * record changed there too since (another computer, or the founder in another place), in which case
 * the record's value wins and the field is listed in `dropped`.
 */
export function restoreOfferDraft<T extends object>(kept: { base: T; form: T }, current: T): { form: T; restored: Array<keyof T>; dropped: Array<keyof T> } {
  const form = { ...current }
  const restored: Array<keyof T> = []
  const dropped: Array<keyof T> = []
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  for (const k of new Set([...Object.keys(kept.base), ...Object.keys(kept.form)]) as Set<keyof T>) {
    if (same(kept.form[k], kept.base[k])) continue
    if (!same(current[k], kept.base[k])) {
      dropped.push(k)
      continue
    }
    form[k] = kept.form[k]
    restored.push(k)
  }
  return { form, restored, dropped }
}

/** Plain words for where a base sits: 'Below the band', 'Low in the band', 'Mid band', ... */
export function bandWords(base: number, band: Pick<Band, 'min' | 'mid' | 'max'>): string {
  if (base < band.min) return 'Below the band'
  if (base > band.max) return 'Above the band'
  const pos = band.max === band.min ? 0.5 : (base - band.min) / (band.max - band.min)
  if (pos < 1 / 3) return 'Low in the band'
  if (pos <= 2 / 3) return 'Mid band'
  return 'High in the band'
}

/**
 * Annual base for employees at a family and level on a date (unnamed peers for the band meter).
 * Uses the comp row in effect; hourly rows are annualized at their hours. Excludes the given ids.
 * With unit 'hour' (an hourly offer's meter) it gives rates instead: an hourly row's rate, a salary
 * over 2,080 hours.
 */
export function peerBases(
  people: Person[],
  comp: CompRecord[],
  familyId: ID,
  levelId: ID,
  date: ISODate,
  exclude: ID[] = [],
  unit: 'year' | 'hour' = 'year',
): number[] {
  const out: number[] = []
  for (const p of people) {
    if (exclude.includes(p.id) || !isEmployedOn(p, date)) continue
    const rows = comp.filter((c) => c.personId === p.id && c.effectiveOn <= date).sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn))
    const row = rows[rows.length - 1]
    if (!row || row.levelId !== levelId || p.familyId !== familyId) continue
    const base =
      unit === 'hour'
        ? row.payType === 'hourly'
          ? (row.hourlyRate ?? 0)
          : Math.round(((row.salary ?? 0) / 2080) * 100) / 100
        : row.payType === 'hourly'
          ? Math.round((row.hourlyRate ?? 0) * (p.hoursPerWeek || 40) * 52)
          : (row.salary ?? 0)
    if (base > 0) out.push(base)
  }
  return out.sort((a, b) => a - b)
}

/** True when the background check cleared (Clear, or Consider and the Fair Chance decision was Proceed). */
export function checkCleared(bg: BackgroundCheck | undefined): boolean {
  if (!bg || bg.status !== 'complete') return false
  return bg.result === 'clear' || bg.fairChance?.decision === 'proceed'
}

/** Contingencies a hiring manager may see: cleared yes or no (background check only; I-9 and PIIA come at start). */
export function contingenciesCleared(offer: Pick<Offer, 'contingencies' | 'backgroundCheck'>): boolean {
  if (!offer.contingencies.includes('background_check')) return true
  return checkCleared(offer.backgroundCheck)
}

export type BackgroundStep = 'locked' | 'not_started' | 'consent_sent' | 'in_progress' | 'clear' | 'consider' | 'cancelled'

/** Where a background check stands, for the status stepper. */
export function backgroundStep(conditionalOfferOn: ISODate | undefined, bg: BackgroundCheck | undefined): BackgroundStep {
  if (!conditionalOfferOn) return 'locked'
  if (!bg || bg.status === 'not_started') return 'not_started'
  if (bg.status === 'cancelled') return 'cancelled'
  if (bg.status === 'consent_sent') return 'consent_sent'
  if (bg.status === 'in_progress') return 'in_progress'
  return bg.result === 'consider' ? 'consider' : 'clear'
}

export type OfferGroupKey = 'draft' | 'awaiting_approval' | 'approved' | 'sent' | 'accepted' | 'declined' | 'expired' | 'rescinded' | 'discarded'

/**
 * Where an offer stands for display: a sent offer past its expiry date reads 'expired' even before
 * expireOffers marks it, and a rescinded offer that never went out reads 'discarded' (the candidate
 * never received it).
 */
export function offerDisplayStatus(offer: Pick<Offer, 'status' | 'expiresOn' | 'sentOn'>, date?: ISODate): OfferGroupKey {
  if (offer.status === 'sent' && date && offer.expiresOn < date) return 'expired'
  if (offer.status === 'rescinded' && !offer.sentOn) return 'discarded'
  return offer.status
}

/** The badge word for an offer: OFFER_STATUS, with 'Expired' for lapsed and 'Discarded' for unsent rescinds. */
export function offerStatusLabel(offer: Pick<Offer, 'status' | 'expiresOn' | 'sentOn'>, date?: ISODate): { label: string; tone: (typeof OFFER_STATUS)[OfferStatus]['tone'] } {
  const s = offerDisplayStatus(offer, date)
  if (s === 'discarded') return { label: 'Discarded', tone: 'outline' }
  return OFFER_STATUS[s]
}

/** Latest version per application, so revised offers do not show twice. */
export function latestPerApplication(offers: Offer[]): Offer[] {
  const best = new Map<ID, Offer>()
  for (const o of offers) {
    const cur = best.get(o.applicationId)
    if (!cur || o.version > cur.version) best.set(o.applicationId, o)
  }
  return [...best.values()]
}

/**
 * Offers tab groups. Accepted shows offers still to be hired or starting on or after `acceptedSince`;
 * declined, expired, rescinded and discarded show those decided on or after `since`. Older ones are
 * counted in `earlier` so nothing silently disappears. With `date`, a sent offer past its expiry sits
 * under Expired (offerDisplayStatus); a rescinded draft that never went out sits under Discarded.
 */
export function groupOffers(
  offers: Offer[],
  since: ISODate,
  people: Pick<Person, 'id' | 'startDate'>[],
  acceptedSince: ISODate = since,
  date?: ISODate,
): { groups: Record<OfferGroupKey, Offer[]>; earlier: number } {
  const groups: Record<OfferGroupKey, Offer[]> = { draft: [], awaiting_approval: [], approved: [], sent: [], accepted: [], declined: [], expired: [], rescinded: [], discarded: [] }
  let earlier = 0
  for (const o of latestPerApplication(offers)) {
    const s = offerDisplayStatus(o, date)
    if (s === 'accepted') {
      const p = o.personId ? people.find((x) => x.id === o.personId) : undefined
      const recent = !o.personId || (p ? p.startDate >= acceptedSince : (o.decidedOn ?? o.createdOn) >= acceptedSince)
      if (recent) groups.accepted.push(o)
      else earlier += 1
    } else if (s === 'declined' || s === 'expired' || s === 'rescinded' || s === 'discarded') {
      if ((o.decidedOn ?? (o.status === 'sent' ? o.expiresOn : o.createdOn)) >= since) groups[s].push(o)
      else earlier += 1
    } else {
      groups[s].push(o)
    }
  }
  const decided = (o: Offer) => o.decidedOn ?? (o.status === 'sent' ? o.expiresOn : (o.sentOn ?? o.createdOn))
  const byDate = (a: Offer, b: Offer) => decided(b).localeCompare(decided(a))
  groups.sent.sort((a, b) => a.expiresOn.localeCompare(b.expiresOn))
  for (const k of ['draft', 'awaiting_approval', 'approved', 'accepted', 'declined', 'expired', 'rescinded', 'discarded'] as const) groups[k].sort(byDate)
  return { groups, earlier }
}

/**
 * Why Hire keeps the job open: the other offers on it that are still in play, in plain words. Only a
 * sent offer is 'still out'; drafts, approvals and accepted offers not yet hired say what they are.
 */
export function otherOffersText(others: Array<Pick<Offer, 'status' | 'personId'>>): string | null {
  const words: string[] = []
  if (others.some((o) => o.status === 'sent')) words.push('still out')
  if (others.some((o) => o.status === 'awaiting_approval')) words.push('waiting for approval')
  if (others.some((o) => o.status === 'draft' || o.status === 'approved')) words.push('in draft')
  if (others.some((o) => o.status === 'accepted' && !o.personId)) words.push('accepted and not hired yet')
  if (words.length === 0) return null
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`
  return `Keeps the job open, because ${others.length === 1 ? 'another offer on it is' : 'other offers on it are'} ${list}.`
}

/** 'Big-tech counteroffer.' -> 'Big-tech counteroffer' (so sentences do not end in two periods). */
export function trimPeriod(s: string | undefined): string {
  return (s ?? '').trim().replace(/[.\s]+$/, '')
}

/**
 * A rescind reason for 'Rescinded <day>: <reason>.', without its last period. The dialog stores the
 * chip and the details as 'Offer made in error. Hours were wrong: ...'; a reason saved before that,
 * as 'Offer made in error: Hours were wrong: ...', reads the same way instead of with two colons.
 */
export function rescindReasonText(reason: string | undefined): string {
  const r = trimPeriod(reason)
  for (const chip of rescindReasonChoices()) if (r.startsWith(`${chip}: `)) return `${chip}. ${r.slice(chip.length + 2)}`
  return r
}

/** Compliance rules that switch on when headcount reaches n (active milestones only), for the Hire preview. */
export function rulesAtThreshold(n: number) {
  return RULES.filter((r) => r.trigger.kind === 'headcount' && r.trigger.n === n && !r.upcoming)
}

/**
 * The Approval line on an offer. An approval counts only while it still stands: editing an approved
 * offer's pay, equity, level or start date sends it back to draft (updateOffer), so a draft or an
 * offer waiting for approval never shows an older approval as if it covered the current terms.
 */
export function approvalLine(offer: Pick<Offer, 'status' | 'approvals'>, needsApproval: boolean, nameOf: (id: ID) => string, drafter?: string): string {
  const last = [...offer.approvals].reverse().find((a) => a.decision === 'approved')
  const pending = offer.status === 'draft' || offer.status === 'awaiting_approval'
  if (last && !pending) return `Approved by ${nameOf(last.approverId)}, ${fmtDay(last.at)}`
  // The drafter by name, as the panel's subtitle says it ("drafted by Rae Okafor"): Admin is their role.
  if (!needsApproval) return drafter ? `Drafted by ${drafter} as Admin, no separate approval` : 'Drafted by Admin, no separate approval'
  const waiting = offer.status === 'awaiting_approval' ? 'Waiting for Admin approval' : 'Needs Admin approval'
  if (last) return `${waiting} (changed since the ${fmtShort(last.at)} approval)`
  return pending ? waiting : 'No approval on record'
}

/** The offer panel's buttons, by key (the component draws each one). */
export type OfferAction = 'approve' | 'submit' | 'changes' | 'letter' | 'send' | 'edit' | 'accept' | 'decline' | 'extend' | 'reopen'
/** The offer panel's More menu, by key. */
export type OfferMoreAction = 'discard-draft' | 'discard' | 'letter' | 'nudge' | 'rescind' | 'backed-out' | 'divider'

/**
 * Which buttons the offer panel shows for an offer, in order, and which one is the primary action (`lead`:
 * drawn as the primary button, where focus lands after the offer moves on). An offer that is ready to go out
 * leads with its letter: Generate letter comes before Mark sent, since the letter is what gets sent and Mark
 * sent only records the date. Once it is out, the letter stays a visible button (not only in More).
 * `letter` is false while the viewer may not open the letter yet (a hiring manager before Admin approves).
 */
export function offerActionPlan(o: {
  status: OfferStatus
  lapsed: boolean
  needsApproval: boolean
  isAdmin: boolean
  hired: boolean
  letter: boolean
}): { lead: OfferAction | null; buttons: OfferAction[]; more: OfferMoreAction[] } {
  const letter: OfferAction[] = o.letter ? ['letter'] : []
  const rescind: OfferMoreAction[] = o.isAdmin ? ['divider', 'rescind'] : []
  switch (o.status) {
    case 'draft':
      if (o.needsApproval) {
        const lead = o.isAdmin ? 'approve' : 'submit'
        return { lead, buttons: [lead, 'edit', ...letter], more: ['discard-draft'] }
      }
      return { lead: 'letter', buttons: ['letter', 'send', 'edit'], more: ['discard-draft'] }
    case 'awaiting_approval':
      return o.isAdmin
        ? { lead: 'approve', buttons: ['approve', 'changes', 'edit', ...letter], more: ['discard'] }
        : { lead: null, buttons: ['edit', ...letter], more: [] }
    case 'approved':
      return { lead: 'letter', buttons: ['letter', 'send', 'edit'], more: o.isAdmin ? ['discard'] : [] }
    case 'sent':
      // Past its expiry it cannot be accepted until it is extended (markAccepted refuses too).
      return o.lapsed
        ? { lead: 'reopen', buttons: ['reopen', 'decline'], more: ['letter', ...rescind] }
        : { lead: 'accept', buttons: ['accept', 'decline', 'extend', 'letter'], more: ['nudge', ...rescind] }
    case 'accepted':
      return { lead: null, buttons: [], more: o.hired ? [] : ['backed-out', 'letter'] }
    case 'expired':
      return { lead: 'reopen', buttons: ['reopen', 'decline'], more: [] }
    default:
      return { lead: null, buttons: [], more: [] }
  }
}
