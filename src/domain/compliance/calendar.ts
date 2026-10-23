// Compliance calendar: recurring and dated obligations between two dates, with stable ids so the
// inbox can snooze or dismiss them, plus an .ics export. Sources: db.recurring, trainings, I-9
// reverification, 409A expiry, Jan 1 rate review, Jan 31 1099-NEC, Feb 1 SB 294 notice, quarterly
// SOC 2 access reviews, contract ends, leave designation notices, DE 542 and rule deadlines
// (EDD registration, 25102(o), a recorded CalSavers notice deadline). Built-in generators step aside
// when a db.recurring item carries the same ruleId, so nothing shows twice.
import { fullName, isEmployedOn } from '@/domain/people'
import { isStatutoryTraining, TRAINING_LABELS, trainingRequirements } from '@/domain/trainings'
import type { DB, ID, RecurringItem } from '@/domain/types'
import { addDays, addMonths, fmtDate, type ISODate, isWeekday, isWithin, nextQuarter, quarterEnd, quarterOf } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { type ICSEvent, buildICS } from '@/lib/ics'
import { contractors1099, estimatePaidInYear, form1099ThresholdFor, paidEmployeesOn } from './counting'
import { cycleDoneOn, evaluateAll, type RuleResult } from './engine'
import { annualDoneKey, RULE_BY_ID, SOC2_ACCESS_REVIEW_ID } from './rules'

// Re-exported so callers can keep importing them from the calendar.
export { annualDoneKey, contractors1099, estimatePaidInYear, form1099ThresholdFor }

export type CalendarKind =
  | 'recurring'
  | 'training'
  | 'i9_reverify'
  | 'valuation_409a'
  | 'rate_review'
  | 'form_1099'
  | 'sb294_notice'
  | 'victims_notice'
  | 'soc2_access_review'
  | 'contract_end'
  | 'leave_notice'
  | 'de542'
  | 'rule_deadline'

export type CalendarItem = {
  /** Stable across renders and days (kind + record + date). */
  id: string
  date: ISODate
  title: string
  kind: CalendarKind
  ruleId?: string
  personId?: ID
  contractorId?: ID
  /** Legal deadline: shows red when overdue and cannot be snoozed past its date. */
  statutory: boolean
  /** An agency filing due on a weekend or holiday (the DE 1): the business day before, to file by. */
  fileBy?: ISODate
  done?: boolean
  link?: string
  detail?: string
}

const yearOf = (d: ISODate): number => Number(d.slice(0, 4))

function yearsIn(from: ISODate, to: ISODate): number[] {
  const out: number[] = []
  for (let y = yearOf(from); y <= yearOf(to); y++) out.push(y)
  return out
}

/** Moves a Saturday or Sunday due date to the next Monday (IRS and most filing deadlines). */
export function nextBusinessDay(d: ISODate): ISODate {
  let x = d
  while (!isWeekday(x)) x = addDays(x, 1)
  return x
}

const CADENCE_MONTHS: Record<RecurringItem['cadence'], number> = { monthly: 1, quarterly: 3, annual: 12, biennial: 24, once: 0 }

function recurringItems(db: DB, from: ISODate, to: ISODate): CalendarItem[] {
  const out: CalendarItem[] = []
  for (const r of db.recurring) {
    const statutory = RULE_BY_ID[r.ruleId ?? '']?.statutory ?? false
    const step = CADENCE_MONTHS[r.cadence]
    let d = r.nextDueOn
    for (let i = 0; i < 400 && d <= to; i++) {
      // A statutory date on a weekend moves to the next business day (IRS and state filing rule), so
      // the Jan 31, 2027 1099-NEC deadline shows as Mon Feb 1 (LAW.md b-1099nec-2026).
      const shown = statutory ? nextBusinessDay(d) : d
      const moved = shown !== d ? ` ${fmtDate(d)} falls on a weekend, so the deadline moves to ${fmtDate(shown)}.` : ''
      if (shown >= from && shown <= to)
        out.push({ id: `rec-${r.id}-${d}`, date: shown, title: r.title, kind: 'recurring', ruleId: r.ruleId, statutory, link: r.link, detail: `${r.notes ?? ''}${moved}`.trim() || undefined })
      if (!step) break
      d = addMonths(r.nextDueOn, step * (i + 1))
    }
    if (r.lastDoneOn && isWithin(r.lastDoneOn, from, to)) {
      out.push({ id: `rec-${r.id}-done-${r.lastDoneOn}`, date: r.lastDoneOn, title: r.title, kind: 'recurring', ruleId: r.ruleId, statutory, done: true, link: r.link })
    }
  }
  return out
}

function trainingItems(db: DB, from: ISODate, to: ISODate): CalendarItem[] {
  const out: CalendarItem[] = []
  const people = db.people.filter((p) => p.startDate <= to && !(p.endDate && p.endDate < from))
  for (const p of people) {
    // A leaver is evaluated on their last day, and nothing falls due after it.
    const lastDay = p.separation?.lastDay ?? p.endDate ?? undefined
    const evalOn = lastDay && lastDay < to ? lastDay : to
    for (const row of trainingRequirements(db, p, evalOn)) {
      const name = fullName(p)
      if (row.completedOn && isWithin(row.completedOn, from, to)) {
        out.push({
          id: `tr-${p.id}-${row.kind}-done-${row.completedOn}`,
          date: row.completedOn,
          title: `${name} completed ${TRAINING_LABELS[row.kind].toLowerCase()}`,
          kind: 'training',
          personId: p.id,
          statutory: isStatutoryTraining(row),
          done: true,
        })
      }
      if (!row.required || !row.dueOn || row.status === 'done' || !isWithin(row.dueOn, from, to)) continue
      if (lastDay && row.dueOn > lastDay) continue
      const refresher = !!row.completedOn
      out.push({
        id: `tr-${p.id}-${row.kind}-${row.dueOn}`,
        date: row.dueOn,
        title: `${name}: ${TRAINING_LABELS[row.kind].toLowerCase()}${refresher ? ' refresher' : ''} due`,
        kind: 'training',
        ruleId: row.course === 'harassment' ? 'harassment-training' : row.course === 'wvpp' ? 'wvpp' : undefined,
        personId: p.id,
        statutory: isStatutoryTraining(row),
        link: row.link,
        detail: row.reason,
      })
    }
  }
  return out
}

function i9Items(db: DB, from: ISODate, to: ISODate): CalendarItem[] {
  return db.people
    .filter((p) => p.i9ReverifyOn && isWithin(p.i9ReverifyOn, from, to) && (isEmployedOn(p, p.i9ReverifyOn) || p.startDate > p.i9ReverifyOn))
    .map((p) => ({
      id: `i9-${p.id}-${p.i9ReverifyOn}`,
      date: p.i9ReverifyOn as ISODate,
      title: `Reverify I-9 work authorization for ${fullName(p)}`,
      kind: 'i9_reverify' as const,
      ruleId: 'form-i9',
      personId: p.id,
      statutory: true,
      detail: 'Record the new expiration date only, never the document.',
    }))
}

function valuationItems(db: DB, from: ISODate, to: ISODate): CalendarItem[] {
  const out: CalendarItem[] = []
  const vals = [...db.equity.valuations].sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn))
  const current = vals.filter((v) => v.effectiveOn <= to).pop()
  if (!current) return out
  const warn = addDays(current.expiresOn, -60)
  if (isWithin(warn, from, to)) {
    out.push({
      id: `409a-warn-${current.id}`,
      date: warn,
      title: `409A expires in 60 days (${fmtDate(current.expiresOn)}): start the next valuation`,
      kind: 'valuation_409a',
      ruleId: 'first-option-grant',
      statutory: false,
    })
  }
  if (isWithin(current.expiresOn, from, to)) {
    out.push({
      id: `409a-expires-${current.id}`,
      date: current.expiresOn,
      title: '409A safe harbor ends: get a new valuation before granting',
      kind: 'valuation_409a',
      ruleId: 'first-option-grant',
      statutory: false,
    })
  }
  for (const round of db.company.fundingRounds) {
    if (round.instrument === 'SAFE' || round.closedOn <= current.effectiveOn || !isWithin(round.closedOn, from, to)) continue
    out.push({
      id: `409a-financing-${round.id}`,
      date: round.closedOn,
      title: `${round.name} closed after the last 409A: get a new valuation before the next grant`,
      kind: 'valuation_409a',
      ruleId: 'first-option-grant',
      statutory: false,
    })
  }
  return out
}

function form1099Items(db: DB, from: ISODate, to: ISODate, skip: Set<string>): CalendarItem[] {
  if (skip.has('first-contractor')) return []
  const out: CalendarItem[] = []
  for (const y of yearsIn(from, addDays(to, 7))) {
    const nominal = `${y}-01-31`
    const due = nextBusinessDay(nominal)
    if (!isWithin(due, from, to)) continue
    const list = contractors1099(db, y - 1)
    if (!list.length) continue
    const threshold = form1099ThresholdFor(db, y - 1)
    const moved = due !== nominal ? ` Jan 31 falls on a weekend, so the deadline moves to ${fmtDate(due)}.` : ''
    out.push({
      id: `1099-${y}`,
      date: due,
      title: `File 1099-NEC for ${plural(list.length, 'contractor')} paid ${money(threshold)} or more in ${y - 1}`,
      kind: 'form_1099',
      ruleId: 'first-contractor',
      statutory: true,
      link: 'https://www.irs.gov/instructions/i1099mec',
      detail: `${list.map((x) => `${x.contractor.entityName || x.contractor.name} (about ${money(x.estimate)})`).join(', ')}. Estimated from rates and contract dates; confirm against what you paid.${moved}`,
      done: !!yearDone(db, 'first-contractor', y),
    })
  }
  return out
}

/** When a rule's yearly cycle was completed (calendar tick, or every yearly action on the rule card). */
function yearDone(db: DB, ruleId: string, year: number): ISODate | undefined {
  const rule = RULE_BY_ID[ruleId]
  return rule ? cycleDoneOn(db, rule, year) : db.complianceStatus[ruleId]?.actionsDone?.[annualDoneKey(year)]
}

/**
 * The Feb 1 employee notices (SB 294, survivors of violence leave). A Feb 1 counts only when someone other
 * than an owner with no pay is employed then: a solo founder working unpaid owes nothing, and a first hire
 * gets the notice at hire (the onboarding task), so the first yearly one is the next Feb 1.
 */
function annualNoticeItems(db: DB, from: ISODate, to: ISODate, skip: Set<string>): CalendarItem[] {
  const out: CalendarItem[] = []
  for (const y of yearsIn(from, to)) {
    const feb1 = `${y}-02-01`
    if (!isWithin(feb1, from, to) || paidEmployeesOn(db, feb1).length === 0) continue
    if (y >= 2026 && !skip.has('sb294-annual-notice')) {
      out.push({
        id: `sb294-${y}`,
        date: feb1,
        title: 'Send the SB 294 workplace rights notice to every employee',
        kind: 'sb294_notice',
        ruleId: 'sb294-annual-notice',
        statutory: true,
        link: RULE_BY_ID['sb294-annual-notice']?.citation.url,
        detail: 'Due by Feb 1 each year. Keep the date sent for 3 years.',
        done: !!yearDone(db, 'sb294-annual-notice', y),
      })
    }
    if (!skip.has('victims-leave-notice')) {
      out.push({
        id: `victims-notice-${y}`,
        date: feb1,
        title: 'Send the yearly survivors of violence leave notice (send it with the SB 294 notice)',
        kind: 'victims_notice',
        ruleId: 'victims-leave-notice',
        statutory: false,
        link: RULE_BY_ID['victims-leave-notice']?.citation.url,
        detail: 'Required once a year; Feb 1 is a suggested date.',
        done: !!yearDone(db, 'victims-leave-notice', y),
      })
    }
  }
  return out
}

function rateReviewItems(db: DB, from: ISODate, to: ISODate, skip: Set<string>): CalendarItem[] {
  if (skip.has('rate-review')) return []
  return yearsIn(from, to)
    .filter((y) => isWithin(`${y}-01-01`, from, to))
    .map((y) => ({
      id: `rate-review-${y}`,
      date: `${y}-01-01`,
      title: `Review ${y} rates and law changes: state and San Jose minimum wage, exempt salary floor, posters`,
      kind: 'rate_review' as const,
      statutory: false,
      detail: 'Update Settings > Rules and rates and recheck every exempt salary against the new floor.',
      done: db.settings.law.year >= y,
    }))
}

function accessReviewItems(db: DB, from: ISODate, to: ISODate, skip: Set<string>): CalendarItem[] {
  if (!db.company.soc2Enabled || skip.has(SOC2_ACCESS_REVIEW_ID)) return []
  const out: CalendarItem[] = []
  const done = db.complianceStatus[SOC2_ACCESS_REVIEW_ID]?.actionsDone ?? {}
  let q = quarterOf(from)
  for (let i = 0; i < 200; i++) {
    const end = quarterEnd(q)
    if (end > to) break
    out.push({
      id: `soc2-access-review-${q}`,
      date: end,
      title: 'Quarterly access review (SOC 2)',
      kind: 'soc2_access_review',
      ruleId: SOC2_ACCESS_REVIEW_ID,
      statutory: false,
      done: !!done[q],
    })
    q = nextQuarter(q)
  }
  return out
}

/**
 * DE 542 is owed for an individual paid or contracted for the threshold ($600) or more in a calendar year:
 * estimated from the rate and dates, and assumed for open-ended monthly or hourly work.
 */
function needsDE542(db: DB, c: DB['contractors'][number]): boolean {
  if (c.rateUnit !== 'project' && !c.endOn) return true
  return estimatePaidInYear(c, Number(c.startOn.slice(0, 4))) >= db.settings.law.de542Threshold
}

function contractItems(db: DB, from: ISODate, to: ISODate): CalendarItem[] {
  const out: CalendarItem[] = []
  for (const c of db.contractors) {
    const name = c.entityName || c.name
    if (c.endOn && isWithin(c.endOn, from, to)) {
      out.push({
        id: `contract-end-${c.id}-${c.endOn}`,
        date: c.endOn,
        title: `Contract ends: ${name}`,
        kind: 'contract_end',
        contractorId: c.id,
        statutory: false,
        detail: 'Extend, convert or close out the contract.',
      })
    }
    if (c.kind === 'contractor' && c.entityType === 'individual' && needsDE542(db, c)) {
      const due = addDays(c.startOn, 20)
      if (isWithin(due, from, to)) {
        out.push({
          id: `de542-${c.id}`,
          date: due,
          title: `File DE 542 for ${name}`,
          kind: 'de542',
          ruleId: 'first-contractor',
          contractorId: c.id,
          statutory: true,
          detail: `Due within 20 days of paying or contracting for ${money(db.settings.law.de542Threshold)} or more in a calendar year (individual contractors only).`,
          done: !!c.de542FiledOn,
        })
      }
    }
  }
  return out
}

function leaveItems(db: DB, from: ISODate, to: ISODate): CalendarItem[] {
  return db.leaveCases
    .filter((l) => l.designationNoticeDueOn && isWithin(l.designationNoticeDueOn, from, to))
    .map((l) => {
      const p = db.people.find((x) => x.id === l.personId)
      return {
        id: `leave-notice-${l.id}`,
        date: l.designationNoticeDueOn as ISODate,
        title: `Leave designation notice${p ? ` for ${fullName(p)}` : ''} due`,
        kind: 'leave_notice' as const,
        ruleId: 'cfra-pdl',
        personId: l.personId,
        // A company target, not a statutory date: LAW.md does not set a 5-business-day rule.
        statutory: false,
        done: !!l.designationNoticeSentOn,
        detail: 'Company target: respond within 5 business days of the request. CFRA regulations set an outer limit; confirm the exact timing with counsel.',
      }
    })
}

/**
 * '<rule>: <what is due>': the rule's dueLabel ('First stock option grant: file the 25102(o) notice with the
 * DFPI'), else 'due'. A date that comes from people's overdue tasks (followUps) says whose it is ('New hire
 * reporting (DE 34): due for Maria Gonzalez'). An estimated clock (no first payroll date saved) is a guide.
 */
function deadlineTitle(db: DB, r: RuleResult): string {
  if (r.dueEstimated) return `${r.rule.title}: estimated due date`
  const people = r.status?.dueOn === r.dueOn ? [] : [...new Set((r.followUps ?? []).filter((f) => f.dueOn === r.dueOn).map((f) => f.personId))]
  if (!people.length) return `${r.rule.title}: ${r.rule.dueLabel ?? 'due'}`
  const person = people.length === 1 ? db.people.find((p) => p.id === people[0]) : undefined
  return `${r.rule.title}: due for ${person ? fullName(person) : plural(people.length, 'person', 'people')}`
}

function ruleDeadlineItems(db: DB, from: ISODate, to: ISODate): CalendarItem[] {
  return evaluateAll(db, to)
    .filter((r) => r.dueOn && r.state !== 'not_applicable' && isWithin(r.dueOn, from, to))
    .map((r) => ({
      id: `rule-${r.rule.id}-${r.dueOn}`,
      date: r.dueOn as ISODate,
      title: deadlineTitle(db, r),
      kind: 'rule_deadline' as const,
      ruleId: r.rule.id,
      statutory: r.rule.statutory && !r.dueEstimated,
      ...(r.fileBy ? { fileBy: r.fileBy } : {}),
      done: r.state === 'done',
      link: r.rule.citation.url,
      detail: r.status?.dueOn ? (r.status.note ?? 'Deadline you recorded.') : r.dueEstimated ? `${r.howCounted} ${r.rule.summary}` : r.rule.summary,
    }))
}

/** Every compliance date between from and to (inclusive), sorted by date. */
export function complianceCalendar(db: DB, from: ISODate, to: ISODate): CalendarItem[] {
  const skip = new Set(db.recurring.map((r) => r.ruleId).filter((x): x is string => !!x))
  const items = [
    ...recurringItems(db, from, to),
    ...trainingItems(db, from, to),
    ...i9Items(db, from, to),
    ...valuationItems(db, from, to),
    ...rateReviewItems(db, from, to, skip),
    ...form1099Items(db, from, to, skip),
    ...annualNoticeItems(db, from, to, skip),
    ...accessReviewItems(db, from, to, skip),
    ...contractItems(db, from, to),
    ...leaveItems(db, from, to),
    ...ruleDeadlineItems(db, from, to),
  ]
  const seen = new Set<string>()
  return items
    .filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)))
    .sort((a, b) => a.date.localeCompare(b.date) || Number(b.statutory) - Number(a.statutory) || a.title.localeCompare(b.title))
}

/** .ics text for calendar items (all-day events). */
export function calendarICS(items: CalendarItem[], calendarName = 'First Twenty compliance'): string {
  const events: ICSEvent[] = items.map((i) => ({
    uid: i.id.replace(/[^A-Za-z0-9-]/g, '-'),
    title: `${i.done ? 'Done: ' : ''}${i.title}`,
    date: i.date,
    description: [i.fileBy ? `File by ${fmtDate(i.fileBy)}.` : '', i.detail, i.statutory ? 'Legal deadline.' : '', i.link ?? '', 'Not legal advice; confirm with counsel or your PEO.']
      .filter(Boolean)
      .join('\n'),
  }))
  return buildICS(events, calendarName)
}
