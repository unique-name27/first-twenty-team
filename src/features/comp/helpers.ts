// Pure helpers for the Comp and plan feature (tested in helpers.test.ts). Domain rules live in
// src/domain (pay, equity, plan, lifecycle); this file only shapes their results for the UI:
// effective-date chips, cliff wording, combined vesting points, the comp CSV and the board print.
import { cliffDate, holderName, poolSummary, upcomingCliffs, vestingPoints } from '@/domain/equity'
import { daysOpen } from '@/domain/hiring/pipeline'
import { compTable, type CompTableRow, exemptFlags, outstandingOffers, peopleCostSummary, candidateName, type RunRate } from '@/domain/pay'
import { employedOn, fullName, headcountOn, incomingOn } from '@/domain/people'
import { budgetVariance, headcountProjection, planRollup, planSummary } from '@/domain/plan'
import type { Band, Company, CompReason, CompRecord, DB, EquityGrant, ExemptionBasis, FLSA, ID, Level, PlanSlot } from '@/domain/types'
import { addDays, addMonths, daysBetween, fmtDate, fmtDay, fmtQuarter, fmtShort, type ISODate, parseDate, toISODate } from '@/lib/dates'
import { escapeHTML, toCSV } from '@/lib/files'
import { listJoin, money, money2, moneyShort, num, pct, plural } from '@/lib/format'

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

export const REASON_LABEL: Record<CompReason, string> = {
  hire: 'Hire',
  promotion: 'Promotion',
  merit: 'Merit',
  market: 'Market adjustment',
  title_only: 'Title only',
  manager_change: 'Manager change',
  transfer: 'Transfer',
  correction: 'Correction',
}

export const EXEMPTION_LABEL: Record<ExemptionBasis, string> = {
  executive: 'Executive',
  administrative: 'Administrative',
  professional: 'Professional',
  computer_professional: 'Computer professional',
  outside_sales: 'Outside sales',
}

/** "Exempt (computer professional)", "Exempt" or "Non-exempt": the overtime status as people pages show it. */
export function overtimeStatusText(flsa: FLSA | undefined, basis?: ExemptionBasis): string {
  if (flsa !== 'exempt') return 'Non-exempt'
  return basis ? `Exempt (${EXEMPTION_LABEL[basis].toLowerCase()})` : 'Exempt'
}

export const PLAN_STATUS_LABEL: Record<PlanSlot['status'], string> = {
  planned: 'Planned',
  open: 'Open',
  offer: 'Offer out',
  filled: 'Filled',
  cut: 'Cut',
}

export const PLAN_STATUS_TONE: Record<PlanSlot['status'], 'neutral' | 'accent' | 'warn' | 'good' | 'outline'> = {
  planned: 'neutral',
  open: 'accent',
  offer: 'warn',
  filled: 'good',
  cut: 'outline',
}

/** "50/50 OTE", "15% variable", "No variable". */
export function variableLabel(variablePct: number | undefined | null): string {
  if (!variablePct) return 'No variable'
  if (Math.abs(variablePct - 1) < 0.001) return '50/50 OTE'
  return `${pct(variablePct)} variable`
}

/** "0.15% to 0.35%" for an equity guideline (fractions of fully diluted shares). */
export function equityGuidelineLabel(band: Pick<Band, 'equityMinPct' | 'equityMaxPct'>): string {
  if (!band.equityMinPct && !band.equityMaxPct) return 'None'
  return `${pct(band.equityMinPct, 2)} to ${pct(band.equityMaxPct, 2)}`
}

/** Rounds to the nearest $1,000 (offer and change amounts snap to $1K). */
export function snapTo1K(n: number): number {
  return Math.round(n / 1000) * 1000
}

// ---------------------------------------------------------------------------------------------
// Note length (sync limit)
// ---------------------------------------------------------------------------------------------

/**
 * The longest note a comp box accepts (maxLength): a job or pay change note, a plan line's reason, a 409A
 * note. Each is saved inside one record, which syncs as at most 256 KB (docs/SYNC.md), and they run a few
 * sentences, so the cap sits well below that.
 */
export const NOTE_MAX_CHARS = 5_000

/** '4,600 of 5,000 characters' once a note gets near the limit (90% of it), else null. */
export function noteCountText(text: string): string | null {
  return text.length >= NOTE_MAX_CHARS * 0.9 ? `${num(text.length)} of ${num(NOTE_MAX_CHARS)} characters` : null
}

// ---------------------------------------------------------------------------------------------
// Pay limits
// ---------------------------------------------------------------------------------------------

/** Upper limits that catch a mistyped amount, such as digits typed onto a prefilled one. An exception reason never lifts them. */
export const PAY_LIMITS = { hourly: 1_000, salary: 5_000_000, multiple: 5 } as const

/**
 * Why a new pay amount looks mistyped, or null: over $1,000 an hour, a salary over $5M a year, or (at full
 * time) more than 5 times the band maximum, or with no band, more than 5 times current pay. The text names
 * no amount of this person's pay: it also goes in a toast, which the privacy blur does not cover.
 */
export function payLimitProblem(p: { hourly: boolean; pay: number; fte: number; currentFte: number; bandMax?: number }): string | null {
  if (p.hourly && p.pay > PAY_LIMITS.hourly) return `Check the amount: the new rate is over ${money(PAY_LIMITS.hourly)} an hour.`
  if (!p.hourly && p.pay > PAY_LIMITS.salary) return `Check the amount: the new salary is over ${moneyShort(PAY_LIMITS.salary)} a year.`
  if (p.bandMax != null && p.bandMax > 0) {
    return p.fte > p.bandMax * PAY_LIMITS.multiple ? `Check the amount: the new pay is more than ${PAY_LIMITS.multiple} times the band maximum.` : null
  }
  if (p.currentFte > 0 && p.fte > p.currentFte * PAY_LIMITS.multiple) return `Check the amount: the new pay is more than ${PAY_LIMITS.multiple} times current pay.`
  return null
}

// ---------------------------------------------------------------------------------------------
// Effective dates
// ---------------------------------------------------------------------------------------------

function firstOfNextMonth(date: ISODate): ISODate {
  const d = parseDate(date)
  return toISODate(new Date(d.getFullYear(), d.getMonth() + 1, 1))
}

/**
 * First day of the next pay period that starts after `date`. Semi-monthly periods start on the 1st
 * and the 16th; monthly on the 1st; biweekly every 14 days from `anchor` (the first payroll date), or
 * the next Monday when no anchor is known.
 */
export function nextPayPeriodStart(date: ISODate, schedule: Company['paySchedule'], anchor?: ISODate): ISODate {
  const d = parseDate(date)
  if (schedule === 'semi_monthly') {
    if (d.getDate() < 16) return toISODate(new Date(d.getFullYear(), d.getMonth(), 16))
    return firstOfNextMonth(date)
  }
  if (schedule === 'monthly') return firstOfNextMonth(date)
  if (anchor) {
    const diff = daysBetween(anchor, date)
    const periods = diff < 0 ? 0 : Math.floor(diff / 14) + 1
    return addDays(anchor, periods * 14)
  }
  const add = ((8 - d.getDay()) % 7) || 7
  return addDays(date, add)
}

/** Chips for the effective date of a job or pay change, defaulting to the next pay period. Deduplicated by date. */
export function effectiveDatePresets(
  date: ISODate,
  schedule: Company['paySchedule'],
  anchor?: ISODate,
): Array<{ label: string; date: ISODate }> {
  const year = parseDate(date).getFullYear()
  const jan1 = `${year + 1}-01-01`
  const raw = [
    { label: `Next pay period (${fmtShort(nextPayPeriodStart(date, schedule, anchor))})`, date: nextPayPeriodStart(date, schedule, anchor) },
    { label: `1st of next month (${fmtShort(firstOfNextMonth(date))})`, date: firstOfNextMonth(date) },
    { label: `Jan 1, ${year + 1}`, date: jan1 },
    { label: 'Today', date },
  ]
  const seen = new Set<string>()
  return raw.filter((r) => (seen.has(r.date) ? false : (seen.add(r.date), true)))
}

/** Target start chips for a plan line: the first weekday of each of the next four quarters. */
export function quarterStartPresets(date: ISODate): Array<{ label: string; date: ISODate }> {
  const d = parseDate(date)
  const out: Array<{ label: string; date: ISODate }> = []
  let q = new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3 + 3, 1)
  for (let i = 0; i < 4; i++) {
    let iso = toISODate(q)
    while ([0, 6].includes(parseDate(iso).getDay())) iso = addDays(iso, 1)
    const label = `Q${Math.floor(q.getMonth() / 3) + 1} ${q.getFullYear()}`
    out.push({ label, date: iso })
    q = new Date(q.getFullYear(), q.getMonth() + 3, 1)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Scheduled changes
// ---------------------------------------------------------------------------------------------

export type ChangePart = { kind: 'manager' | 'title' | 'level' | 'department' | 'flsa' | 'pay' | 'variable'; text: string }

/**
 * What a job or pay record changes against the record before it, as short phrases: 'reports to Caleb
 * Washington', 'title Senior engineer', 'level L3', 'Product team', 'non-exempt', and the pay ('base
 * $192,000', 'variable 10%'), which the UI shows inside <Private> and only to viewers who may see pay.
 */
export function changeParts(db: Pick<DB, 'people' | 'levels' | 'departments'>, rec: CompRecord, prev: CompRecord | undefined): ChangePart[] {
  if (!prev) return []
  const out: ChangePart[] = []
  if (rec.managerId !== undefined && (rec.managerId ?? null) !== (prev.managerId ?? null)) {
    const m = rec.managerId ? db.people.find((p) => p.id === rec.managerId) : undefined
    out.push({ kind: 'manager', text: rec.managerId ? `reports to ${m ? fullName(m) : 'a new manager'}` : 'no manager' })
  }
  if (rec.title !== prev.title) out.push({ kind: 'title', text: `title ${rec.title}` })
  if (rec.levelId !== prev.levelId) out.push({ kind: 'level', text: `level ${db.levels.find((l) => l.id === rec.levelId)?.code ?? 'changed'}` })
  if (rec.departmentId && rec.departmentId !== prev.departmentId) {
    const dept = db.departments.find((d) => d.id === rec.departmentId)?.name
    out.push({ kind: 'department', text: dept ? `${dept} team` : 'new team' })
  }
  if (rec.flsa && rec.flsa !== prev.flsa) out.push({ kind: 'flsa', text: rec.flsa === 'exempt' ? 'exempt' : 'non-exempt' })
  if (rec.payType !== prev.payType || rec.salary !== prev.salary || rec.hourlyRate !== prev.hourlyRate) {
    out.push({ kind: 'pay', text: rec.payType === 'hourly' ? `${money2(rec.hourlyRate ?? 0)} an hour` : `base ${money(rec.salary ?? 0)}` })
  }
  if ((rec.variablePct ?? 0) !== (prev.variablePct ?? 0)) out.push({ kind: 'variable', text: rec.variablePct ? `variable ${pct(rec.variablePct)}` : 'no variable' })
  return out
}

// ---------------------------------------------------------------------------------------------
// Privacy: blur amounts inside domain sentences
// ---------------------------------------------------------------------------------------------

export type TextPart = { text: string; money: boolean }

/** Splits "Run-rate $256K a month" into plain and money parts so the amounts can go through <Private>. */
export function splitMoneyText(text: string): TextPart[] {
  const parts: TextPart[] = []
  const re = /-?\$[\d,]+(?:\.\d+)?[KM]?/g
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), money: false })
    parts.push({ text: m[0], money: true })
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last), money: false })
  return parts
}

// ---------------------------------------------------------------------------------------------
// Equity wording and vesting
// ---------------------------------------------------------------------------------------------

/** "1-year", "6-month". */
export function spanAdjective(months: number): string {
  return months % 12 === 0 ? `${months / 12}-year` : `${months}-month`
}

/** "Sofia reaches the 1-year cliff Tue, Jan 12: 10,000 options vest." No pronouns (none are stored). */
export function cliffSentence(firstName: string, cliffMonths: number, date: ISODate, shares: number, awaitingBoard = false): string {
  const tail = awaitingBoard ? ' once the board approves the grant' : ''
  return `${firstName} reaches the ${spanAdjective(cliffMonths)} cliff ${fmtDay(date)}: ${num(shares)} options vest${tail}.`
}

/** "Cliff in 23 days, then 1/48 vests monthly" (or "Cliff today", "Cliff tomorrow"). */
export function cliffCountdown(cliff: ISODate, vestingMonths: number, date: ISODate): string {
  const n = daysBetween(date, cliff)
  const when = n <= 0 ? 'Cliff today' : n === 1 ? 'Cliff tomorrow' : `Cliff in ${num(n)} days`
  return `${when} (${fmtDate(cliff)}), then 1/${vestingMonths} vests monthly`
}

export type VestPoint = { date: ISODate; vested: number }

/**
 * Cumulative vested shares across grants at every vest date (each grant's curve from vestingPoints, summed).
 * `stopOf` gives the day a grant stops vesting (vestingStop: the holder's last day), so a leaver's line goes flat there.
 */
export function combinedVesting(grants: EquityGrant[], stopOf?: (g: EquityGrant) => ISODate | undefined): VestPoint[] {
  if (!grants.length) return []
  const curves = grants.map((g) => vestingPoints(g, stopOf?.(g)))
  const dates = [...new Set(curves.flatMap((c) => c.map((p) => p.date)))].sort()
  const at = (curve: VestPoint[], d: ISODate) => {
    let v = 0
    for (const p of curve) {
      if (p.date <= d) v = p.vested
      else break
    }
    return v
  }
  const out: VestPoint[] = []
  for (const d of dates) {
    const vested = curves.reduce((t, c) => t + at(c, d), 0)
    if (out.length && out[out.length - 1].vested === vested) continue
    out.push({ date: d, vested })
  }
  return out
}

/**
 * Yearly milestones for a vesting table view: the cliff, each anniversary and the fully vested date. With
 * `lastDay` (a leaver), anniversaries after it are left out and the last row is the last day itself.
 */
export function vestingMilestones(points: VestPoint[], start: ISODate, lastDay?: ISODate): VestPoint[] {
  if (!points.length) return []
  const end = points[points.length - 1].date
  const at = (d: ISODate) => points.filter((p) => p.date <= d).pop()?.vested ?? 0
  const out: VestPoint[] = []
  for (let y = 1; ; y++) {
    const d = addMonths(start, 12 * y)
    if (lastDay && d > lastDay) {
      out.push({ date: lastDay, vested: at(lastDay) })
      break
    }
    out.push({ date: d, vested: at(d) })
    if (d >= end || d === lastDay) break
    if (y > 10) break
  }
  return out
}

export type CliffCard = { personId: ID; grantId: ID; name: string; date: ISODate; shares: number; awaitingBoard: boolean; text: string }

/** Cliff cards for the next `days` days (default a year), with plain sentences. */
export function cliffCards(db: DB, date: ISODate, days = 365): CliffCard[] {
  return upcomingCliffs(db, date, addDays(date, days)).map((c) => {
    const g = db.grants.find((x) => x.id === c.grantId)
    const p = db.people.find((x) => x.id === c.personId)
    const first = p ? (p.preferredName || p.firstName) : holderName(db, { personId: c.personId }).split(' ')[0]
    return {
      ...c,
      name: p ? fullName(p) : holderName(db, { personId: c.personId }),
      text: cliffSentence(first, g?.cliffMonths ?? 12, c.date, c.shares, c.awaitingBoard),
    }
  })
}

/** Days until a grant's cliff (negative once passed). */
export function daysToCliff(grant: Pick<EquityGrant, 'vestingStart' | 'cliffMonths'>, date: ISODate): number {
  return daysBetween(date, cliffDate(grant))
}

// ---------------------------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------------------------

/** Levels in display order: individual contributors, then managers, then executives, each by seniority. */
export function sortLevels(levels: Level[]): Level[] {
  const track = { ic: 0, manager: 1, executive: 2 } as const
  return [...levels].sort((a, b) => track[a.track] - track[b.track] || a.order - b.order)
}

/** The next level up in the same track that has a band in the family, else the next level up in the track. */
export function nextLevel(db: Pick<DB, 'levels' | 'bands'>, familyId: ID, levelId: ID): Level | undefined {
  const cur = db.levels.find((l) => l.id === levelId)
  if (!cur) return undefined
  const above = sortLevels(db.levels).filter((l) => l.track === cur.track && l.order > cur.order)
  return above.find((l) => db.bands.some((b) => b.familyId === familyId && b.levelId === l.id)) ?? above[0]
}

/**
 * ML premium over software engineering at the same level: (ML mid / engineering mid) - 1 for each level
 * that has both bands, plus the range. Null when the families or overlapping levels are missing.
 */
export function mlPremium(
  db: Pick<DB, 'bands' | 'levels'>,
  mlFamily = 'f-ml',
  engFamily = 'f-eng',
): { min: number; max: number; byLevel: Array<{ levelId: ID; premium: number }> } | null {
  const byLevel: Array<{ levelId: ID; premium: number }> = []
  for (const l of sortLevels(db.levels)) {
    const ml = db.bands.find((b) => b.familyId === mlFamily && b.levelId === l.id)
    const eng = db.bands.find((b) => b.familyId === engFamily && b.levelId === l.id)
    if (ml && eng && eng.mid > 0) byLevel.push({ levelId: l.id, premium: ml.mid / eng.mid - 1 })
  }
  if (!byLevel.length) return null
  const ps = byLevel.map((b) => b.premium)
  return { min: Math.min(...ps), max: Math.max(...ps), byLevel }
}

/**
 * How one family's midpoints compare with another's, for "machine learning midpoints run ___ software
 * engineering": "5% to 10% above", "2% below to 10% above", "2% to 5% below", "10% above" or "the same as".
 * Each end is rounded to a whole percent first.
 */
export function premiumRangeText(min: number, max: number): string {
  const lo = Math.round(Math.min(min, max) * 100)
  const hi = Math.round(Math.max(min, max) * 100)
  const end = (n: number) => (n === 0 ? 'the same as' : `${Math.abs(n)}% ${n < 0 ? 'below' : 'above'}`)
  if (lo === hi) return end(lo)
  if (lo >= 0) return `${lo}% to ${hi}% above`
  if (hi <= 0) return `${Math.abs(hi)}% to ${Math.abs(lo)}% below`
  return `${Math.abs(lo)}% below to ${hi}% above`
}

export type BandDraft = { min: number | null; mid: number | null; max: number | null; equityMinPct: number | null; equityMaxPct: number | null; variablePct: number | null }

/** Problems with a band edit, in plain words (empty when it can be saved). Equity and variable are percents here. */
export function bandErrors(b: BandDraft): string[] {
  const out: string[] = []
  if (b.min == null || b.mid == null || b.max == null) out.push('Enter a minimum, midpoint and maximum.')
  else {
    if (b.min <= 0) out.push('The minimum must be more than $0.')
    if (!(b.min <= b.mid && b.mid <= b.max)) out.push('Keep the minimum at or below the midpoint, and the midpoint at or below the maximum.')
  }
  if (b.equityMinPct != null && b.equityMaxPct != null && b.equityMinPct > b.equityMaxPct) {
    out.push('The equity guideline minimum is above the maximum.')
  }
  if ((b.equityMinPct ?? 0) < 0 || (b.equityMaxPct ?? 0) < 0 || (b.variablePct ?? 0) < 0) out.push('Percentages cannot be negative.')
  return out
}

/**
 * The same checks as bandErrors, pinned to the field to fix (the later field of an out-of-order pair),
 * so a failed save can mark that control invalid and move focus to it.
 */
export function bandFieldErrors(b: BandDraft): Partial<Record<keyof BandDraft, string>> {
  const out: Partial<Record<keyof BandDraft, string>> = {}
  if (b.min == null) out.min = 'Enter the minimum.'
  else if (b.min <= 0) out.min = 'Make the minimum more than $0.'
  if (b.mid == null) out.mid = 'Enter the midpoint.'
  if (b.max == null) out.max = 'Enter the maximum.'
  if (b.min != null && b.mid != null && b.max != null) {
    if (b.min > b.mid) out.mid = 'Keep the midpoint at or above the minimum.'
    else if (b.mid > b.max) out.max = 'Keep the maximum at or above the midpoint.'
  }
  if ((b.equityMinPct ?? 0) < 0) out.equityMinPct = 'Use 0 or more.'
  if ((b.equityMaxPct ?? 0) < 0) out.equityMaxPct = 'Use 0 or more.'
  else if (b.equityMinPct != null && b.equityMaxPct != null && b.equityMinPct > b.equityMaxPct) out.equityMaxPct = 'Keep the high end at or above the low end.'
  if ((b.variablePct ?? 0) < 0) out.variablePct = 'Use 0 or more.'
  return out
}

// ---------------------------------------------------------------------------------------------
// Comp table CSV
// ---------------------------------------------------------------------------------------------

/**
 * The comp table as CSV. Bands are full time, so part-time pay is compared at its full-time equivalent: the
 * hours and that base sit next to the actual annual base, and the band columns say "(full-time)".
 */
export function compTableCSV(db: DB, rows: CompTableRow[], date: ISODate): string {
  const flags = new Map(exemptFlags(db, date).map((f) => [f.personId, f]))
  const levelCode = (id: ID) => db.levels.find((l) => l.id === id)?.code ?? ''
  const dept = (id: ID) => db.departments.find((d) => d.id === id)?.name ?? ''
  const outside = (r: CompTableRow) => !!r.band && (r.fteBase < r.band.min || r.fteBase > r.band.max)
  return toCSV(rows, [
    { header: 'Name', value: (r) => r.name },
    { header: 'Title', value: (r) => r.title },
    { header: 'Level', value: (r) => levelCode(r.levelId) },
    { header: 'Department', value: (r) => dept(r.departmentId) },
    { header: 'FLSA', value: (r) => (r.flsa === 'exempt' ? 'Exempt' : 'Non-exempt') },
    { header: 'Pay type', value: (r) => (r.payType === 'hourly' ? 'Hourly' : 'Salary') },
    { header: 'Hourly rate', value: (r) => r.hourlyRate ?? '' },
    { header: 'Annual base', value: (r) => Math.round(r.base) },
    { header: 'Hours per week', value: (r) => r.hoursPerWeek },
    { header: 'Full-time equivalent base', value: (r) => Math.round(r.fteBase) },
    { header: 'Variable %', value: (r) => (r.variablePct ? Math.round(r.variablePct * 1000) / 10 : 0) },
    { header: 'Variable at target', value: (r) => Math.round(r.variable) },
    { header: 'Band min (full-time)', value: (r) => r.band?.min ?? '' },
    { header: 'Band mid (full-time)', value: (r) => r.band?.mid ?? '' },
    { header: 'Band max (full-time)', value: (r) => r.band?.max ?? '' },
    { header: 'Band position (full-time)', value: (r) => r.bandLabel ?? '' },
    { header: 'Compa-ratio (full-time)', value: (r) => (r.compaRatio != null ? r.compaRatio.toFixed(2) : '') },
    { header: 'Last change', value: (r) => r.lastChange?.effectiveOn ?? '' },
    { header: 'Reason', value: (r) => (r.lastChange ? REASON_LABEL[r.lastChange.reason] : '') },
    { header: 'Exception reason', value: (r) => r.exceptionReason ?? (outside(r) ? 'No exception reason' : '') },
    { header: 'Below exempt floor', value: (r) => (flags.has(r.personId) ? 'Yes' : '') },
    { header: 'Starting soon', value: (r) => (r.incoming ? 'Yes' : '') },
  ])
}

// ---------------------------------------------------------------------------------------------
// Cost scenarios
// ---------------------------------------------------------------------------------------------

export type ScenarioDelta = {
  /** Monthly cost of the lines this scenario adds over the previous one (joining). */
  added: { amount: number; names: string[] }
  /** Monthly cost of the lines it drops (people leaving before then). */
  removed: { amount: number; names: string[] }
}

/** What changes from one cost scenario to the next, both ways, so the head counts add up. Plan lines keep their title; people go by first name. */
export function scenarioDelta(prev: RunRate, cur: RunRate): ScenarioDelta {
  const name = (l: RunRate['lines'][number]) => (l.kind === 'plan' ? l.name : l.name.split(' ')[0])
  const added = cur.lines.filter((l) => !prev.lines.some((p) => p.key === l.key))
  const removed = prev.lines.filter((l) => !cur.lines.some((c) => c.key === l.key))
  const sum = (ls: typeof added) => Math.round(ls.reduce((t, l) => t + l.monthly, 0))
  return { added: { amount: sum(added), names: added.map(name) }, removed: { amount: sum(removed), names: removed.map(name) } }
}

/**
 * The scenario card's change line, in parts so the amounts can go through <Private>:
 * "+$45.2K" "for Lucas and Mei", "-$38.3K" "for Kofi and Elena leaving" (past 3 names, counts: "for 4 joining").
 */
export function scenarioDeltaParts(d: ScenarioDelta): Array<{ amount: string; text: string }> {
  const out: Array<{ amount: string; text: string }> = []
  if (d.added.names.length) {
    const who = d.added.names.length <= 3 ? listJoin(d.added.names) : `${d.added.names.length} joining`
    out.push({ amount: `+${moneyShort(d.added.amount)}`, text: `for ${who}` })
  }
  if (d.removed.names.length) {
    const who = d.removed.names.length <= 3 ? `${listJoin(d.removed.names)} leaving` : `${d.removed.names.length} leaving`
    out.push({ amount: `-${moneyShort(d.removed.amount)}`, text: `for ${who}` })
  }
  return out
}

/** Median of numbers (null for none). */
export function median(values: number[]): number | null {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// ---------------------------------------------------------------------------------------------
// Board print
// ---------------------------------------------------------------------------------------------

export type BoardSummary = {
  company: string
  date: ISODate
  headcount: number
  incoming: Array<{ name: string; title: string; startDate: ISODate }>
  contractors: number
  advisors: number
  planText: string
  actual: Array<{ date: ISODate; value: number }>
  plan: Array<{ date: ISODate; value: number }>
  hires: Array<{ number: number; name: string; title: string; startDate: ISODate }>
  departures: Array<{ name: string; title: string; lastDay: ISODate }>
  openJobs: Array<{ title: string; daysOpen: number | null; active: number; status: PlanSlot['status'] | 'open' }>
  offersOut: Array<{ name: string; title: string; status: string; expiresOn?: ISODate }>
  cost: { now: number; withIncoming: number; withOffers: number; atPlan: number; contractors: number; runwayNow: string; runwayAtPlan: string }
  planLines: Array<{ quarter: string; title: string; status: PlanSlot['status']; targetStart: ISODate; budgetBase: number | null }>
  /** Offered or hired base vs budget; `restated` counts the lines whose part-time pay was restated at full time. */
  variance: { budget: number; actual: number; variance: number; lines: number; restated: number }
  pool: { size: number; available: number; granted: number; awaiting: number; reserved: number }
}

export function boardSummary(db: DB, date: ISODate): BoardSummary {
  const year = date.slice(0, 4)
  const proj = headcountProjection(db, date)
  const cost = peopleCostSummary(db, date)
  const incomingRun = cost.withOffers.lines.filter((l) => l.kind === 'incoming').length
  const withIncoming = Math.round(
    cost.withOffers.lines.filter((l) => l.kind === 'employee' || l.kind === 'incoming').reduce((t, l) => t + l.monthly, 0),
  )
  const pool = poolSummary(db, date)
  const variance = budgetVariance(db)
  const statusLabel: Record<string, string> = { awaiting_approval: 'Awaiting approval', approved: 'Approved, not sent', sent: 'Sent' }
  return {
    company: db.company.name,
    date,
    headcount: headcountOn(db, date),
    incoming: incomingOn(db, date).map((p) => ({ name: fullName(p), title: p.title, startDate: p.startDate })),
    contractors: db.contractors.filter((c) => c.kind === 'contractor' && c.startOn <= date && (!c.endOn || c.endOn >= date)).length,
    advisors: db.contractors.filter((c) => c.kind === 'advisor' && c.startOn <= date && (!c.endOn || c.endOn >= date)).length,
    planText: planSummary(db, date),
    actual: proj.actual,
    plan: proj.plan,
    hires: db.people
      .filter((p) => p.startDate.slice(0, 4) === year && p.startDate <= date)
      .sort((a, b) => a.hireNumber - b.hireNumber)
      .map((p) => ({ number: p.hireNumber, name: fullName(p), title: p.title, startDate: p.startDate })),
    departures: db.people
      .filter((p) => p.endDate && p.endDate.slice(0, 4) === year && p.endDate <= date)
      .map((p) => ({ name: fullName(p), title: p.title, lastDay: p.endDate as ISODate })),
    openJobs: db.jobs
      .filter((j) => j.status === 'open')
      .map((j) => ({
        title: j.title,
        daysOpen: daysOpen(j, date),
        active: db.applications.filter((a) => a.jobId === j.id && a.status === 'active').length,
        status: 'open' as const,
      })),
    offersOut: outstandingOffers(db, date).map((o) => ({
      name: candidateName(db, o.candidateId),
      title: o.title,
      status: statusLabel[o.status] ?? o.status,
      ...(o.status === 'sent' ? { expiresOn: o.expiresOn } : {}),
    })),
    cost: {
      now: cost.now.monthly,
      withIncoming: incomingRun ? withIncoming : cost.now.monthly,
      withOffers: cost.withOffers.monthly,
      atPlan: cost.atPlan.monthly,
      contractors: cost.now.contractorsMonthly,
      runwayNow: cost.runwayNow.text,
      runwayAtPlan: cost.runwayAtPlan.text,
    },
    planLines: planRollup(db).map((r) => ({
      quarter: r.slot.quarter,
      title: r.slot.title,
      status: r.status,
      targetStart: r.slot.targetStart,
      budgetBase: r.budgetBase,
    })),
    variance: {
      ...variance.totals,
      lines: variance.rows.filter((r) => r.variance != null).length,
      restated: variance.rows.filter((r) => r.variance != null && r.restatedFromHours != null).length,
    },
    pool: {
      size: pool.poolShares,
      available: pool.available,
      granted: pool.grantedOutstanding,
      awaiting: pool.awaitingBoard,
      reserved: pool.reservedByOffers,
    },
  }
}

function signedMoney(n: number): string {
  return n > 0 ? `+${money(n)}` : n < 0 ? `-${money(-n)}` : '$0'
}

/** "3 employees, 1 contractor, 0 advisors". */
function headcountText(s: Pick<BoardSummary, 'headcount' | 'contractors' | 'advisors'>): string {
  return `${plural(s.headcount, 'employee')}, ${plural(s.contractors, 'contractor')}, ${plural(s.advisors, 'advisor')}`
}

/** Runway today and at plan, once when the two say the same thing (both "Add cash on hand", for example). */
function runwayText(s: Pick<BoardSummary, 'cost'>): string {
  return s.cost.runwayNow === s.cost.runwayAtPlan ? s.cost.runwayNow : `${s.cost.runwayNow} ${s.cost.runwayAtPlan}`
}

/** " (part-time pay restated at full time)" when any variance line restated part-time pay, else "". */
function restatedNote(s: Pick<BoardSummary, 'variance'>): string {
  return s.variance.restated ? ' (part-time pay restated at full time)' : ''
}

/** Plain-text board update for Copy (Slack, email or a board memo). */
export function boardText(s: BoardSummary): string {
  const lines: string[] = []
  lines.push(`${s.company} people update, ${fmtDate(s.date)}`)
  lines.push('')
  lines.push(`Headcount: ${headcountText(s)}.`)
  if (s.incoming.length) lines.push(`Starting soon: ${s.incoming.map((p) => `${p.name} (${p.title}, ${fmtShort(p.startDate)})`).join('; ')}.`)
  lines.push(`${s.planText}.`)
  lines.push('')
  lines.push(`Hires in ${s.date.slice(0, 4)}: ${s.hires.length ? s.hires.map((h) => `#${h.number} ${h.name}, ${h.title} (${fmtShort(h.startDate)})`).join('; ') : 'none'}.`)
  if (s.departures.length) lines.push(`Departures: ${s.departures.map((d) => `${d.name} (${fmtShort(d.lastDay)})`).join('; ')}.`)
  lines.push(`Open jobs: ${s.openJobs.length ? s.openJobs.map((j) => `${j.title} (${j.daysOpen ?? 0} days open, ${j.active} active)`).join('; ') : 'none'}.`)
  lines.push(`Offers out: ${s.offersOut.length ? s.offersOut.map((o) => `${o.name}, ${o.title} (${o.status}${o.expiresOn ? `, expires ${fmtShort(o.expiresOn)}` : ''})`).join('; ') : 'none'}.`)
  lines.push('')
  lines.push(
    `Fully loaded run-rate: ${moneyShort(s.cost.now)} a month now, ${moneyShort(s.cost.withIncoming)} with hires starting soon, ${moneyShort(s.cost.withOffers)} with offers out, about ${moneyShort(s.cost.atPlan)} at plan. Contractors ${moneyShort(s.cost.contractors)} a month.`,
  )
  lines.push(runwayText(s))
  if (s.variance.lines) lines.push(`Offers vs budget on ${plural(s.variance.lines, 'plan line')}: ${signedMoney(s.variance.variance)} in base${restatedNote(s)}.`)
  lines.push(`Option pool: ${num(s.pool.available)} of ${num(s.pool.size)} available.`)
  return lines.join('\n')
}

/** A small black-and-white SVG step chart (actual solid, plan dashed) for the printed board page. */
export function stepChartSVG(actual: Array<{ date: ISODate; value: number }>, plan: Array<{ date: ISODate; value: number }>, width = 640, height = 180): string {
  const all = [...actual, ...plan]
  if (!all.length) return ''
  const from = all.map((p) => p.date).sort()[0]
  const to = all.map((p) => p.date).sort().pop() as ISODate
  const span = Math.max(1, daysBetween(from, to))
  const top = Math.max(20, ...all.map((p) => p.value))
  const padL = 30
  const padR = 12
  const padT = 10
  const padB = 24
  const iw = width - padL - padR
  const ih = height - padT - padB
  const x = (d: ISODate) => padL + (daysBetween(from, d) / span) * iw
  const y = (v: number) => padT + ih - (v / top) * ih
  const path = (pts: Array<{ date: ISODate; value: number }>, end: ISODate) => {
    if (!pts.length) return ''
    let d = `M${x(pts[0].date).toFixed(1)},${y(pts[0].value).toFixed(1)}`
    for (let i = 1; i < pts.length; i++) d += ` H${x(pts[i].date).toFixed(1)} V${y(pts[i].value).toFixed(1)}`
    return `${d} H${x(end).toFixed(1)}`
  }
  const refs = [5, 15, 20].filter((v) => v <= top)
  const yearTicks: ISODate[] = []
  for (let yv = Number(from.slice(0, 4)) + 1; `${yv}-01-01` <= to; yv++) yearTicks.push(`${yv}-01-01`)
  const lastActual = actual[actual.length - 1]
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Headcount, actual and plan">`,
    ...refs.map(
      (v) =>
        `<line x1="${padL}" x2="${padL + iw}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="#ccc" stroke-width="1"/><text x="${padL - 6}" y="${(y(v) + 4).toFixed(1)}" font-size="10" text-anchor="end" fill="#555">${v}</text>`,
    ),
    `<line x1="${padL}" x2="${padL + iw}" y1="${y(0)}" y2="${y(0)}" stroke="#999" stroke-width="1"/>`,
    ...yearTicks.map((d) => `<text x="${x(d).toFixed(1)}" y="${height - 6}" font-size="10" text-anchor="middle" fill="#555">${d.slice(0, 4)}</text>`),
    `<path d="${path(actual, lastActual?.date ?? to)}" fill="none" stroke="#111" stroke-width="2"/>`,
    `<path d="${path(plan, to)}" fill="none" stroke="#666" stroke-width="2" stroke-dasharray="5 4"/>`,
    lastActual ? `<circle cx="${x(lastActual.date).toFixed(1)}" cy="${y(lastActual.value).toFixed(1)}" r="4" fill="#111"/>` : '',
    `</svg>`,
  ].join('')
}

/** One-page board print: actual vs plan chart, hires, open jobs, offers out, cost now and at plan. */
export function boardHTML(s: BoardSummary): string {
  const e = escapeHTML
  const rows = (cells: string[][]) => cells.map((c) => `<tr>${c.map((v) => `<td>${e(v)}</td>`).join('')}</tr>`).join('')
  return [
    `<h1>${e(s.company)} people update</h1>`,
    `<p class="muted">${e(fmtDate(s.date))}. Planning figures, not payroll. Fully loaded cost includes employer taxes, benefits, PEO and tools, and workers' comp.</p>`,
    `<h2>Headcount, actual and plan</h2>`,
    `<p>${e(`${plural(s.headcount, 'employee')} today, ${plural(s.contractors, 'contractor')}, ${plural(s.advisors, 'advisor')}. ${s.planText}.`)}</p>`,
    stepChartSVG(s.actual, s.plan),
    `<p class="muted">Solid line: actual. Dashed line: plan, including hires starting soon and open plan lines.</p>`,
    `<h2>Hires in ${e(s.date.slice(0, 4))}</h2>`,
    s.hires.length || s.incoming.length
      ? `<table><tr><th>#</th><th>Name</th><th>Title</th><th>Start</th></tr>${rows([
          ...s.hires.map((h) => [`${h.number}`, h.name, h.title, fmtDate(h.startDate)]),
          ...s.incoming.map((p) => ['Starting', p.name, p.title, fmtDate(p.startDate)]),
        ])}</table>`
      : '<p>No hires yet this year.</p>',
    s.departures.length ? `<p>Departures: ${e(s.departures.map((d) => `${d.name}, ${d.title} (last day ${fmtDate(d.lastDay)})`).join('; '))}.</p>` : '',
    `<h2>Open jobs and offers out</h2>`,
    s.openJobs.length
      ? `<table><tr><th>Open job</th><th>Days open</th><th>Active candidates</th></tr>${rows(s.openJobs.map((j) => [j.title, `${j.daysOpen ?? 0}`, `${j.active}`]))}</table>`
      : '<p>No open jobs.</p>',
    s.offersOut.length
      ? `<table><tr><th>Offer out to</th><th>Role</th><th>Status</th></tr>${rows(
          s.offersOut.map((o) => [o.name, o.title, `${o.status}${o.expiresOn ? `, expires ${fmtDate(o.expiresOn)}` : ''}`]),
        )}</table>`
      : '<p>No offers out.</p>',
    `<h2>Cost and runway</h2>`,
    `<table><tr><th>Scenario</th><th>Monthly</th><th>Annual</th></tr>${rows([
      ['Now', money(s.cost.now), money(s.cost.now * 12)],
      ['With hires starting soon', money(s.cost.withIncoming), money(s.cost.withIncoming * 12)],
      ['With offers out', money(s.cost.withOffers), money(s.cost.withOffers * 12)],
      ['At plan', money(s.cost.atPlan), money(s.cost.atPlan * 12)],
      ['Contractors (separate)', money(s.cost.contractors), money(s.cost.contractors * 12)],
    ])}</table>`,
    `<p>${e(runwayText(s))}</p>`,
    `<h2>Headcount plan</h2>`,
    `<table><tr><th>Quarter</th><th>Role</th><th>Status</th><th>Target start</th><th>Budgeted base</th></tr>${rows(
      s.planLines.map((l) => [fmtQuarter(l.quarter), l.title, PLAN_STATUS_LABEL[l.status], fmtDate(l.targetStart), l.budgetBase != null ? money(l.budgetBase) : 'Not set']),
    )}</table>`,
    s.variance.lines ? `<p>Offered or hired base vs budget on ${e(plural(s.variance.lines, 'line'))}: ${e(signedMoney(s.variance.variance))}${e(restatedNote(s))}.</p>` : '',
    `<p class="muted">Option pool: ${e(num(s.pool.available))} of ${e(num(s.pool.size))} shares available (${e(num(s.pool.granted))} granted, ${e(num(s.pool.awaiting))} awaiting board consent, ${e(num(s.pool.reserved))} reserved by offers). The cap table tool is the source of truth.</p>`,
  ].join('\n')
}

/** People employed or starting whose current band is this one (family and level). */
export function peopleInBand(db: DB, band: Pick<Band, 'familyId' | 'levelId'>, date: ISODate): CompTableRow[] {
  return compTable(db, date).filter((r) => r.familyId === band.familyId && r.levelId === band.levelId)
}

/** Who should be hiring manager on a job opened from a plan line: the department head if employed, else the fallback. */
export function hiringManagerForSlot(db: DB, slot: Pick<PlanSlot, 'departmentId'>, fallback: ID, date: ISODate): ID {
  const head = db.departments.find((d) => d.id === slot.departmentId)?.headId
  if (head && employedOn(db, date).some((p) => p.id === head)) return head
  return fallback
}

// ---------------------------------------------------------------------------------------------
// Change job or pay defaults
// ---------------------------------------------------------------------------------------------

/** "Senior software engineer" -> "Staff software engineer" when the old level name is in the title. */
export function suggestTitle(title: string, oldLevelName: string | undefined, newLevelName: string | undefined): string {
  if (!oldLevelName || !newLevelName || oldLevelName === newLevelName) return title
  if (!/^[a-z0-9 -]+$/i.test(oldLevelName)) return title
  const re = new RegExp(`\\b${oldLevelName}\\b`, 'i')
  if (!re.test(title)) return title
  return title.replace(re, (m) => (m[0] === m[0].toUpperCase() ? newLevelName : newLevelName.toLowerCase()))
}

/**
 * A starting base for a change reason, snapped to $1K: promotion = the higher of the new band minimum and
 * 5% more; market = the band midpoint when below it, else 3% more; merit = 4% more; other reasons keep pay.
 */
export function proposedBase(reason: CompReason, current: number, band: Pick<Band, 'min' | 'mid'> | undefined): number {
  switch (reason) {
    case 'promotion':
      return snapTo1K(Math.max(band?.min ?? 0, current * 1.05))
    case 'market':
      return band && current < band.mid ? snapTo1K(band.mid) : snapTo1K(current * 1.03)
    case 'merit':
      return snapTo1K(current * 1.04)
    default:
      return current
  }
}
