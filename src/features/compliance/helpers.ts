// Pure helpers for the compliance feature: grouping and wording for rule cards, the threshold
// ruler scale, the hire threshold preview, calendar actions, policy versions and records requests.
// No React and no store here, so everything is unit tested (helpers.test.ts).
import {
  type CalendarItem,
  candidateRetainUntil,
  type ComplianceRule,
  cycleYearOn,
  type NextThreshold,
  rawCount,
  RULE_BY_ID,
  RULES,
  roughDate,
  ruleApplies,
  type RuleResult,
  type RuleState,
} from '@/domain/compliance'
import { payTransparencyThreshold, postingHeadcount } from '@/domain/hiring'
import { fullName, isEmployedOn } from '@/domain/people'
import { isStatutoryTraining, type TrainingRow } from '@/domain/trainings'
import type { Acknowledgment, DB, ID, Person, Policy, RecordsRequest, TrainingKind } from '@/domain/types'
import { addDays, daysBetween, fmtDate, fmtShort, fmtShort as fmtShortDate, type ISODate } from '@/lib/dates'
import { listJoin, plural } from '@/lib/format'

// ---------------------------------------------------------------------------------------------
// Rule cards
// ---------------------------------------------------------------------------------------------

export type Tone = 'neutral' | 'accent' | 'good' | 'warn' | 'bad' | 'outline'

/** The state chip on a rule card: a word plus a tone (never color alone). */
export function stateChip(r: RuleResult): { label: string; tone: Tone } {
  switch (r.state) {
    case 'not_yet':
      return { label: 'Not yet', tone: 'neutral' }
    case 'approaching': {
      const d = r.projectedOn ?? r.projectedIfOffersAccepted
      return { label: d ? `Approaching (${fmtShort(d)})` : 'Approaching', tone: 'warn' }
    }
    case 'applies':
      // Overdue per-person legal deadlines are statutory, so this is the one red chip.
      if (r.followUps?.length) return { label: 'Overdue', tone: 'bad' }
      return { label: 'Applies', tone: r.openActions.length ? 'warn' : 'accent' }
    case 'done':
      return { label: 'Done', tone: 'good' }
    case 'not_applicable':
      return { label: 'Not applicable', tone: 'outline' }
  }
}

/**
 * True when the card needs attention: it applies with open actions or with overdue per-person deadlines
 * (RuleResult.followUps, such as one person's harassment training), or it is approaching.
 */
export function needsAction(r: RuleResult): boolean {
  return (r.state === 'applies' && (r.openActions.length > 0 || !!r.followUps?.length)) || r.state === 'approaching'
}

export type RuleFollowUp = NonNullable<RuleResult['followUps']>[number]

/** How many different people have an overdue deadline under the rule. */
export function followUpPeople(r: RuleResult): number {
  return new Set((r.followUps ?? []).map((f) => f.personId)).size
}

/**
 * The rule's own due date for the card body. A deadline the user recorded wins; a date that only comes
 * from the oldest overdue follow-up is left out, because the follow-up list shows it with its person.
 */
export function ruleOwnDue(r: RuleResult): { on: ISODate; recorded: boolean } | null {
  if (r.status?.dueOn) return { on: r.status.dueOn, recorded: true }
  if (!r.dueOn) return null
  if (r.followUps?.length && r.dueOn === r.followUps[0].dueOn) return null
  return { on: r.dueOn, recorded: false }
}

/** 'Was due Sep 16, 2026 (24 days ago)' for one overdue follow-up. */
export function followUpDueText(f: RuleFollowUp, date: ISODate): string {
  const late = daysBetween(f.dueOn, date)
  return `Was due ${fmtDate(f.dueOn)}${late > 0 ? ` (${plural(late, 'day')} ago)` : ''}.`
}

export type RuleGroupKey = 'any' | 'events' | 't5' | 't10' | 't15' | 't20' | 'upcoming'

export const RULE_GROUPS: Array<{ key: RuleGroupKey; title: string; subtitle: string }> = [
  { key: 'any', title: 'At any size', subtitle: 'From the first employee, and some from day one.' },
  { key: 'events', title: 'First-time events', subtitle: 'Triggered by something happening for the first time, not by headcount.' },
  { key: 't5', title: 'At 5 employees', subtitle: 'The big California step. Harassment training counts contractors too.' },
  { key: 't10', title: 'At 10, and 10 on site', subtitle: 'A site count (people at one workplace at once) and a headcount.' },
  { key: 't15', title: 'At 15 employees', subtitle: 'Pay ranges become a hard stop; the federal 20-week counter starts.' },
  { key: 't20', title: 'At 20 employees', subtitle: 'Age discrimination law and federal COBRA.' },
  { key: 'upcoming', title: 'Coming later: 25 to 100', subtitle: 'Shown faded on the ruler until you get closer.' },
]

export function ruleGroupOf(rule: ComplianceRule): RuleGroupKey {
  const t = rule.trigger
  if (t.kind === 'always') return 'any'
  if (t.kind === 'event') return 'events'
  if (rule.upcoming || t.n > 20) return 'upcoming'
  if (t.n >= 20) return 't20'
  if (t.n >= 15) return 't15'
  if (t.n >= 10) return 't10'
  if (t.n >= 5) return 't5'
  return 'any'
}

const STATE_ORDER: Record<RuleState, number> = { applies: 0, approaching: 1, not_yet: 2, done: 3, not_applicable: 4 }

/** Results grouped by threshold and by event; inside a group, cards that need action come first. */
export function groupResults(results: RuleResult[]): Array<{ key: RuleGroupKey; title: string; subtitle: string; results: RuleResult[] }> {
  return RULE_GROUPS.map((g) => ({
    ...g,
    results: results
      .filter((r) => ruleGroupOf(r.rule) === g.key)
      .sort((a, b) => Number(needsAction(b)) - Number(needsAction(a)) || STATE_ORDER[a.state] - STATE_ORDER[b.state]),
  })).filter((g) => g.results.length > 0)
}

/** One short line under a collapsed card title. */
export function statusLine(r: RuleResult): string {
  const total = r.rule.actions.length
  const done = r.rule.actions.filter((a) => r.actionsDone[a.id]).length
  switch (r.state) {
    case 'applies': {
      if (r.effectiveOn) return `Applies to contracts from ${fmtDate(r.effectiveOn)}: prepare now. ${done} of ${total} done.`
      // A yearly employee notice with only unpaid owners on payroll: nothing is owed yet.
      if (r.cycle?.awaitingEmployees && r.openActions.length === 0 && !r.followUps?.length) {
        return 'Nothing is due yet: it starts once someone other than an unpaid owner works here.'
      }
      const since = r.firstAppliedOn ? `Applies since ${fmtDate(r.firstAppliedOn)}` : 'Applies now'
      if (r.followUps?.length) {
        return `${since}. ${done} of ${total} done; overdue for ${plural(followUpPeople(r), 'person', 'people')} since ${fmtDate(r.followUps[0].dueOn)}.`
      }
      const due = r.dueOn ? `; due ${r.dueEstimated ? 'about ' : ''}${fmtDate(r.dueOn)}` : ''
      return `${since}${due}. ${done} of ${total} done.`
    }
    case 'approaching': {
      if (r.projectedOn) return `Projected to apply on ${fmtDate(r.projectedOn)}.`
      if (r.projectedIfOffersAccepted) return `Would apply on ${fmtDate(r.projectedIfOffersAccepted)} if offers are accepted.`
      return 'Close to applying. Check the count.'
    }
    case 'done': {
      if (r.cycle) return `Done for this cycle. Next due ${fmtDate(r.cycle.dueOn)}.`
      const when = r.status?.doneOn ?? Object.values(r.actionsDone).sort().pop()
      return when ? `Done ${fmtDate(when)}.` : 'Done.'
    }
    case 'not_applicable':
      return r.notApplicableReason ?? 'Not applicable.'
    case 'not_yet': {
      if (r.weeks) return `Week ${r.weeks.thisYear} of 20 this year.`
      const t = r.rule.trigger
      if (t.kind === 'headcount') return `Starts at ${t.n}; you have ${r.count} by this rule's count.`
      if (t.kind === 'site') return `Starts at ${t.n} on site at once; about ${r.count} now.`
      return 'Starts when this first happens.'
    }
  }
}

/** The plain answer to 'Why am I seeing this?' on a rule card. */
export function whyText(r: RuleResult): string {
  const t = r.rule.trigger
  const unit = t.kind === 'headcount' && t.method === 'w2_plus_contractors' ? 'employees and contractors' : 'employees'
  if (r.state === 'not_applicable') return r.notApplicableReason ?? 'It was marked not applicable.'
  if (t.kind === 'always') {
    if (r.effectiveOn) return `This covers every California employer, whatever the size, for contracts entered on or after ${fmtDate(r.effectiveOn)}. Get ready before then.`
    return 'This applies to every California employer, whatever the size.'
  }
  if (t.kind === 'event') {
    return r.state === 'not_yet' ? `It starts with an event that has not happened yet. ${r.howCounted.replace(/^Not yet\. /, '')}` : `It started with an event: ${r.howCounted}`
  }
  if (r.weeks) {
    const est = r.weeks.estimatedOn ?? r.weeks.estimatedIfOffersAccepted
    const lead = `Federal law counts weeks with ${t.kind === 'headcount' ? t.n : 15} or more on payroll every weekday: ${r.weeks.thisYear} of 20 this year, ${r.weeks.lastYear} last year.`
    // Coverage is retroactive (LAW.md b-titlevii-ada-15): reaching week 20 covers that whole year.
    return est ? `${lead} ${twentyWeekPaceText(est, !!r.weeks.estimatedOn)}` : lead
  }
  const n = t.kind === 'headcount' || t.kind === 'site' ? t.n : 0
  const what = t.kind === 'site' ? 'people on site at once' : unit
  if (r.state === 'approaching') {
    const d = r.projectedOn ?? r.projectedIfOffersAccepted
    return `It starts at ${n} ${what}. You have ${r.count} now${d ? ` and reach ${n} on ${fmtDate(d)}${r.projectedOn ? '' : ' if offers are accepted'}` : ''}.`
  }
  if (r.state === 'not_yet') return `It starts at ${n} ${what}. You have ${r.count} now.`
  const since = r.firstAppliedOn ? ` since ${fmtDate(r.firstAppliedOn)}` : ''
  return `It starts at ${n} ${what}, and you have had ${n} or more${since}. You have ${r.count} now.`
}

/**
 * The federal 20-week projection in the engine's words: week 20 is reached on a date, and coverage then
 * reaches back to Jan 1 of that year (the test is 20 weeks in the current or preceding calendar year).
 */
export function twentyWeekPaceText(est: ISODate, fromHires: boolean): string {
  const y = est.slice(0, 4)
  return `At this pace you would reach week 20 around ${roughDate(est)}${fromHires ? '' : ' if offers are accepted'}, and coverage then reaches back to Jan 1, ${y}, so plan as covered for all of ${y}.`
}

/** 'Next notice due Feb 1, 2027' style line for rules with a yearly cycle. */
export function cycleLine(r: RuleResult): string | null {
  const c = r.cycle
  if (!c) return null
  if (c.awaitingEmployees) return `Due each ${fmtShort(c.dueOn)} once someone other than an unpaid owner works here.`
  const parts = [`Next due ${fmtDate(c.dueOn)}`]
  if (c.overdueYear) parts.push(`the ${c.overdueYear} cycle is still open`)
  else if (c.doneOn) parts.push(`done for ${c.year} on ${fmtDate(c.doneOn)}`)
  else if (c.lastDoneOn) parts.push(`last done ${fmtDate(c.lastDoneOn)}`)
  return `${parts.join('; ')}.`
}

// ---------------------------------------------------------------------------------------------
// Next threshold sentence
// ---------------------------------------------------------------------------------------------

/** Noun phrases for 'At N employees, California requires ...'. Rules without one use their title. */
const RULE_PHRASES: Record<string, string> = {
  'pay-scale-in-postings': 'a pay range on every job post',
  'organ-bone-marrow-leave': 'paid organ and bone marrow donor leave',
  feha: 'its FEHA anti-discrimination rules',
  'harassment-policy': 'a written harassment policy',
  'harassment-training': 'harassment prevention training for California staff',
  'harassment-info-sheet': 'the CRD harassment fact sheet for everyone',
  'cfra-pdl': 'family leave (CFRA) and pregnancy disability leave',
  'bereavement-reproductive-loss': 'bereavement and reproductive loss leave',
  'fair-chance-act': 'the Fair Chance Act steps',
  'crd-ads-regulations': 'care with automated hiring tools',
  'sb700-cannabis': 'no questions about past cannabis use',
  'iipp-records': 'IIPP inspection and training records',
  wvpp: 'a workplace violence prevention plan (SB 553)',
  'federal-cobra': 'federal COBRA (from the next calendar year)',
  'victims-leave-expanded': "more victims' leave purposes",
  'school-activities-leave': 'school activities leave',
  'rehab-literacy-accommodation': 'rehabilitation and literacy accommodation',
  'sj-opportunity-to-work': 'offering hours to part-timers before hiring (San Jose)',
  'aca-employer-mandate': 'the ACA employer mandate',
  'cal-warn': 'Cal-WARN notice before a layoff',
  'eeo-1': 'the federal EEO-1 report',
  'ca-pay-data-report': 'the California pay data report',
  'federal-warn': 'federal WARN notice before a layoff',
}

function phraseFor(id: string, title: string): string {
  return RULE_PHRASES[id] ?? title.charAt(0).toLowerCase() + title.slice(1)
}

/** Open jobs (posted) with no pay range: used to say 'yours already have them'. */
export function openJobsWithoutRange(db: DB): number {
  return db.jobs.filter((j) => j.status === 'open' && (j.payMin == null || j.payMax == null)).length
}

export type PostingBlock = {
  /** True when Mark posted refuses a job without a pay range (the same count the posting sheet checks). */
  on: boolean
  total: number
  /** People starting soon plus accepted offers not yet hired. */
  incoming: number
  howCounted: string
  /** One sentence for the rule card and the next threshold card while the block is on; null while off. */
  line: string | null
}

/**
 * The pay-range posting block as Mark posted enforces it (postingHeadcount): it counts people starting
 * soon and accepted offers, so it can be on while the legal rule (people on payroll) is still approaching.
 */
export function postingBlock(db: DB, date: ISODate): PostingBlock {
  const hc = postingHeadcount(db, date)
  const n = payTransparencyThreshold()
  const incoming = hc.incoming + hc.acceptedOffers
  const parts = [plural(hc.employed, 'employee'), ...(hc.incoming ? [`${plural(hc.incoming, 'person', 'people')} starting soon`] : []), ...(hc.acceptedOffers ? [plural(hc.acceptedOffers, 'accepted offer')] : [])]
  const on = hc.total >= n
  return {
    on,
    total: hc.total,
    incoming,
    howCounted: `The posting block counts ${listJoin(parts)}: ${hc.total} in total. At ${n}, a job cannot be marked posted without a pay range.`,
    line: on
      ? `Job posts already need a pay range: counting people starting soon and accepted offers, you have ${hc.total}, and the posting block starts at ${n}.`
      : null,
  }
}

/**
 * The lead sentence of the next threshold card: 'At 15 employees, California requires a pay range on
 * every job post (yours already have them) and paid organ and bone marrow donor leave.' Federal 20-week
 * rules are left out (the engine's summary explains the federal counter).
 */
export function thresholdLead(nt: NextThreshold, db: DB): string {
  const rules = nt.rules.map((r) => RULE_BY_ID[r.id]).filter((r): r is ComplianceRule => !!r && !(r.trigger.kind === 'headcount' && r.trigger.method === 'weeks_20'))
  const where = nt.kind === 'site' ? `At ${nt.n} people on site at once` : `At ${nt.n} employees`
  if (!rules.length) return nt.kind === 'site' ? `${where}, the workplace rules for larger sites start.` : `${where}, federal rules start to count.`
  const phrases = rules.map((r) => {
    let p = phraseFor(r.id, r.title)
    if (r.id === 'pay-scale-in-postings') {
      const missing = openJobsWithoutRange(db)
      p += missing ? ` (${plural(missing, 'open job')} ${missing === 1 ? 'has' : 'have'} no range yet)` : ' (your open jobs already show one)'
    }
    return p
  })
  const allCA = rules.every((r) => r.jurisdiction === 'california' || r.jurisdiction === 'san_jose')
  const allFederal = rules.every((r) => r.jurisdiction === 'federal')
  const who = allCA ? 'California requires' : allFederal ? 'federal law requires' : 'the law requires'
  return `${where}, ${who} ${listJoin(phrases)}.`
}

// ---------------------------------------------------------------------------------------------
// Threshold ruler scale
// ---------------------------------------------------------------------------------------------

/** Share of the ruler width used by 0 to 20; the faded tail (25 to 100) takes the rest. */
export const RULER_MAIN = 0.78
export const RULER_TICKS = [5, 10, 15, 20]
export const RULER_TAIL = [25, 36, 50, 75, 100]

/**
 * Position of a count on the ruler as a fraction (0 to 1): linear to 20, then the faded tail places 25, 36,
 * 50, 75 and 100 at even steps (linear between them), so each upcoming milestone gets the same room.
 */
export function rulerX(v: number): number {
  if (v <= 0) return 0
  if (v <= 20) return (v / 20) * RULER_MAIN
  const anchors = [20, ...RULER_TAIL]
  const x = Math.min(v, 100)
  const step = (1 - RULER_MAIN) / RULER_TAIL.length
  for (let i = 1; i < anchors.length; i++) {
    if (x <= anchors[i]) return RULER_MAIN + step * (i - 1 + (x - anchors[i - 1]) / (anchors[i] - anchors[i - 1]))
  }
  return 1
}

// ---------------------------------------------------------------------------------------------
// Hire threshold preview ('This hire takes you to 15: 2 things change')
// ---------------------------------------------------------------------------------------------

export type ThresholdImpact = {
  before: number
  after: number
  /** Milestones crossed by this hire (5, 10, 15, 20, 25, 36, 50, 75, 100). */
  crossed: number[]
  /** Rules that do not apply on the start date without the hire and do with it. */
  rules: Array<{ id: string; title: string }>
  /** Federal 20-week counters this hire starts (Title VII at 15, ADEA at 20). */
  counters: Array<{ id: string; title: string; n: number }>
}

const MILESTONE_NUMBERS = [5, 10, 15, 20, 25, 36, 50, 75, 100]

function previewPerson(db: DB, i: number, startDate: ISODate): Person {
  const hq = db.locations.find((l) => l.kind === 'hq') ?? db.locations[0]
  return {
    id: `preview:${i}`,
    firstName: 'New',
    lastName: 'hire',
    workEmail: '',
    title: 'New hire',
    departmentId: db.departments[0]?.id ?? '',
    familyId: db.families[0]?.id ?? '',
    levelId: db.levels[0]?.id ?? '',
    managerId: null,
    locationId: hq?.id ?? '',
    workMode: 'hybrid',
    homeCity: hq?.city ?? db.company.hq.city,
    homeState: hq?.state ?? db.company.hq.state,
    employmentType: 'full_time',
    hoursPerWeek: 40,
    flsa: 'exempt',
    startDate,
    hireNumber: 0,
    emergencyContacts: [],
  }
}

/**
 * What changes when `extra` people (default 1) start on `startDate`, compared with the people already on
 * record. Counts real people only (not offers), so the hire being previewed is never counted twice.
 */
export function thresholdImpact(db: DB, startDate: ISODate, extra = 1): ThresholdImpact {
  const before = rawCount(db, 'w2_one_in_ca', startDate)
  const add = Math.max(1, Math.round(extra))
  const next: DB = { ...db, people: [...db.people, ...Array.from({ length: add }, (_, i) => previewPerson(db, i, startDate))] }
  const after = rawCount(next, 'w2_one_in_ca', startDate)
  const rules: ThresholdImpact['rules'] = []
  const counters: ThresholdImpact['counters'] = []
  for (const r of RULES) {
    const t = r.trigger
    if (t.kind === 'always') continue
    if (t.kind === 'headcount' && t.method === 'weeks_20') {
      if (before < t.n && after >= t.n) counters.push({ id: r.id, title: r.title, n: t.n })
      continue
    }
    if (t.kind === 'headcount' && t.method === 'cobra_prior_year') continue
    if (!ruleApplies(db, r, startDate) && ruleApplies(next, r, startDate)) rules.push({ id: r.id, title: r.title })
  }
  return { before, after, crossed: MILESTONE_NUMBERS.filter((n) => before < n && after >= n), rules, counters }
}

/** 'This hire takes you to 15: 2 things change', or null when nothing changes. */
export function impactHeadline(impact: ThresholdImpact, extra = 1): string | null {
  if (!impact.rules.length && !impact.counters.length) return null
  const n = impact.crossed.length ? impact.crossed[impact.crossed.length - 1] : impact.after
  const who = extra > 1 ? `These ${extra} hires take` : 'This hire takes'
  const things = impact.rules.length ? plural(impact.rules.length, 'thing') + ` change${impact.rules.length === 1 ? 's' : ''}` : 'a federal counter starts'
  return `${who} you to ${n}: ${things}.`
}

// ---------------------------------------------------------------------------------------------
// Milestone history as a story
// ---------------------------------------------------------------------------------------------

/** Future crossings in the future tense: 'On track to cross 15 on Oct 19, 2026 when Lucas Ferreira starts.' */
export function futureCrossingText(db: DB, m: { n: number; date: ISODate; direction: 'up' | 'down'; personId?: ID }): string {
  const p = db.people.find((x) => x.id === m.personId)
  if (m.direction === 'down') return `Will drop below ${m.n} on ${fmtDate(m.date)}${p ? ` after ${fullName(p)}'s last day` : ''}.`
  return `On track to cross ${m.n} on ${fmtDate(m.date)}${p ? ` when ${fullName(p)} starts` : ''}.`
}

// ---------------------------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------------------------

export type CalendarDone =
  | { kind: 'recurring'; recurringId: ID; ruleId?: string; year?: number }
  | { kind: 'training'; personId: ID; trainingKind: TrainingKind }
  | { kind: 'annual'; ruleId: string; year: number }
  | { kind: 'access_review'; quarter: string }
  | { kind: 'leave_notice'; leaveId: ID }
  | { kind: 'de542'; contractorId: ID }

const TRAINING_KINDS: TrainingKind[] = ['harassment_supervisor', 'harassment_employee', 'security_awareness', 'wvpp']

/**
 * How 'Mark done' works for a calendar item, or null when it is done somewhere else (a contract end, a
 * 409A, an I-9 reverification, a rule deadline: those open their own page instead). Recurring items can be
 * ticked only for their current occurrence.
 */
export function calendarDoneAction(db: DB, item: CalendarItem): CalendarDone | null {
  if (item.done) return null
  switch (item.kind) {
    case 'recurring': {
      const r = db.recurring.find((x) => item.id === `rec-${x.id}-${x.nextDueOn}`)
      if (!r) return null
      const rule = r.ruleId ? RULE_BY_ID[r.ruleId] : undefined
      return rule?.cycle ? { kind: 'recurring', recurringId: r.id, ruleId: rule.id, year: cycleYearOn(rule, item.date) } : { kind: 'recurring', recurringId: r.id }
    }
    case 'training': {
      if (!item.personId) return null
      const kind = TRAINING_KINDS.find((k) => item.id.startsWith(`tr-${item.personId}-${k}-`))
      return kind ? { kind: 'training', personId: item.personId, trainingKind: kind } : null
    }
    case 'sb294_notice':
    case 'victims_notice':
      return item.ruleId ? { kind: 'annual', ruleId: item.ruleId, year: Number(item.date.slice(0, 4)) } : null
    case 'form_1099':
      return { kind: 'annual', ruleId: 'first-contractor', year: Number(item.id.replace('1099-', '')) }
    case 'soc2_access_review':
      return { kind: 'access_review', quarter: item.id.replace('soc2-access-review-', '') }
    case 'leave_notice':
      return { kind: 'leave_notice', leaveId: item.id.replace('leave-notice-', '') }
    case 'de542':
      return item.contractorId ? { kind: 'de542', contractorId: item.contractorId } : null
    default:
      return null
  }
}

export type CalendarBuckets = {
  overdue: CalendarItem[]
  months: Array<{ month: string; items: CalendarItem[] }>
  recentlyDone: CalendarItem[]
}

/**
 * Overdue first (statutory before the rest, oldest first), then upcoming by month, then done in the last 30 days.
 * A past contract end counts as done (it happened), never as overdue.
 */
/** Dated events that simply happen (a contract end): once past, they are history, not overdue work. */
const EVENT_KINDS = new Set<CalendarItem['kind']>(['contract_end'])

export function bucketCalendar(all: CalendarItem[], today: ISODate): CalendarBuckets {
  const items = all.map((i) => (EVENT_KINDS.has(i.kind) && i.date < today && !i.done ? { ...i, done: true } : i))
  const overdue = items
    .filter((i) => !i.done && i.date < today)
    .sort((a, b) => Number(b.statutory) - Number(a.statutory) || a.date.localeCompare(b.date))
  const months: CalendarBuckets['months'] = []
  for (const i of items.filter((x) => !x.done && x.date >= today).sort((a, b) => a.date.localeCompare(b.date))) {
    const key = i.date.slice(0, 7)
    const last = months[months.length - 1]
    if (last?.month === key) last.items.push(i)
    else months.push({ month: key, items: [i] })
  }
  const recentlyDone = items.filter((i) => i.done && i.date <= today && i.date >= addDays(today, -30)).sort((a, b) => b.date.localeCompare(a.date))
  return { overdue, months, recentlyDone }
}

/** Plain-text list for Copy: 'Sat, Oct 31: Quarterly access review (SOC 2) (legal deadline)'. */
export function calendarText(items: CalendarItem[], fmt: (d: ISODate) => string): string {
  return items.map((i) => `${fmt(i.date)}: ${i.title}${i.statutory ? ' (legal deadline)' : ''}`).join('\n')
}

// ---------------------------------------------------------------------------------------------
// Policies and acknowledgements
// ---------------------------------------------------------------------------------------------

/** '2', '2.0', 'v2.0' and '2.00' are the same version. */
export function normVersion(v: string): string {
  return v.trim().toLowerCase().replace(/^v/, '').replace(/(\.0+)+$/, '')
}

export function sameVersion(a: string, b: string): boolean {
  return normVersion(a) === normVersion(b)
}

/** Suggested next versions: the next minor and the next major ('2.0' -> ['2.1', '3.0']). */
export function nextVersions(current: string): string[] {
  const parts = current.trim().replace(/^v/i, '').split('.').map((x) => Number.parseInt(x, 10))
  const major = Number.isFinite(parts[0]) ? parts[0] : 1
  const minor = Number.isFinite(parts[1]) ? parts[1] : 0
  return [`${major}.${minor + 1}`, `${major + 1}.0`]
}

export type PolicyVersion = { version: string; effectiveOn?: ISODate; current: boolean; acks: Acknowledgment[] }

/** Every version on record (history, acknowledgements, current), newest first, with who acknowledged each. */
export function policyVersions(policy: Policy, acks: Acknowledgment[]): PolicyVersion[] {
  const mine = acks.filter((a) => a.policyId === policy.id)
  const map = new Map<string, PolicyVersion>()
  const touch = (version: string, effectiveOn?: ISODate) => {
    const key = normVersion(version)
    const row = map.get(key) ?? { version, effectiveOn, current: false, acks: [] }
    if (effectiveOn && !row.effectiveOn) row.effectiveOn = effectiveOn
    map.set(key, row)
    return row
  }
  for (const h of policy.history ?? []) touch(h.version, h.effectiveOn)
  for (const a of mine) touch(a.version).acks.push(a)
  const cur = touch(policy.version, policy.effectiveOn)
  cur.current = true
  cur.version = policy.version
  cur.effectiveOn = policy.effectiveOn
  const cmp = (a: string, b: string) => normVersion(b).localeCompare(normVersion(a), undefined, { numeric: true })
  return [...map.values()].sort((a, b) => Number(b.current) - Number(a.current) || cmp(a.version, b.version))
}

export type AckOwed = { person: Person; dueOn: ISODate; overdue: boolean }

/**
 * People employed on the date who have not acknowledged the current version. Staff on board when the
 * version took effect have 30 days from its effective date; later hires 30 days from their start.
 */
export function acksOwed(db: DB, policy: Policy, date: ISODate): AckOwed[] {
  if (!policy.requiresAck) return []
  return db.people
    .filter((p) => isEmployedOn(p, date))
    .filter((p) => !db.acks.some((a) => a.personId === p.id && a.policyId === policy.id && sameVersion(a.version, policy.version)))
    .map((person) => {
      const dueOn = addDays(person.startDate > policy.effectiveOn ? person.startDate : policy.effectiveOn, 30)
      return { person, dueOn, overdue: dueOn < date }
    })
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.person.hireNumber - b.person.hireNumber)
}

/** The reminder text for Copy reminder. */
export function ackReminderText(policy: Policy, owed: AckOwed[], senderName: string): string {
  const names = listJoin(owed.map((o) => o.person.preferredName || o.person.firstName))
  const due = owed.length ? owed.map((o) => o.dueOn).sort()[0] : undefined
  const lines = [
    `Hi ${names || 'team'},`,
    '',
    `Please read and acknowledge the ${policy.title} ${policy.version} (effective ${fmtDate(policy.effectiveOn)})${due ? ` by ${fmtDate(due)}` : ''}.`,
  ]
  if (policy.link) lines.push(policy.link)
  lines.push('', 'Thank you,', senderName)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------------------------
// Records requests
// ---------------------------------------------------------------------------------------------

export const RECORDS_REQUEST_TYPES: Array<{
  value: RecordsRequest['type']
  label: string
  days: number
  statutory: boolean
  citation: { label: string; url: string }
  clock: string
}> = [
  {
    value: 'personnel_file',
    label: 'Personnel file',
    days: 30,
    statutory: true,
    citation: { label: 'Labor Code 1198.5', url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=1198.5.&lawCode=LAB' },
    clock: 'Within 30 calendar days of the written request (up to 35 by written agreement).',
  },
  {
    value: 'payroll_records',
    label: 'Payroll records',
    days: 21,
    statutory: true,
    citation: { label: 'Labor Code 226', url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=LAB&sectionNum=226' },
    clock: 'Within 21 calendar days of the request.',
  },
  {
    value: 'signed_documents',
    label: 'Signed documents',
    days: 7,
    statutory: false,
    citation: { label: 'Labor Code 432', url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=432.&lawCode=LAB' },
    clock: 'Copies of anything they signed, on request. The law sets no day count; this app uses 7 days.',
  },
]

export function requestTypeInfo(type: RecordsRequest['type']) {
  return RECORDS_REQUEST_TYPES.find((t) => t.value === type) ?? RECORDS_REQUEST_TYPES[0]
}

export function recordsRequestDueOn(type: RecordsRequest['type'], receivedOn: ISODate): ISODate {
  return addDays(receivedOn, requestTypeInfo(type).days)
}

export type RequestState = { label: string; tone: Tone; daysLeft?: number }

export function recordsRequestState(req: RecordsRequest, date: ISODate): RequestState {
  if (req.fulfilledOn) return { label: `Fulfilled ${fmtShort(req.fulfilledOn)}`, tone: 'good' }
  const left = daysBetween(date, req.dueOn)
  if (left < 0) return { label: `Overdue by ${plural(-left, 'day')}`, tone: requestTypeInfo(req.type).statutory ? 'bad' : 'warn', daysLeft: left }
  if (left === 0) return { label: 'Due today', tone: 'warn', daysLeft: 0 }
  return { label: `${plural(left, 'day')} left`, tone: left <= 5 ? 'warn' : 'neutral', daysLeft: left }
}

// ---------------------------------------------------------------------------------------------
// Training tracker cells
// ---------------------------------------------------------------------------------------------

/**
 * Status word, tone and a short detail for a training cell. Only legal courses (harassment prevention,
 * workplace violence prevention) turn red when overdue; security awareness is a company control (amber).
 */
export function trainingCell(row: TrainingRow, today?: ISODate): { label: string; tone: Tone; detail?: string } {
  // Dates in another year carry the year ('Nov 18, 2027'); this year's stay short ('Oct 14').
  const fmtShort = (d: ISODate) => (today && d.slice(0, 4) !== today.slice(0, 4) ? fmtDate(d) : fmtShortDate(d))
  switch (row.status) {
    case 'done':
      return { label: 'Done', tone: 'good', detail: row.nextDueOn ? `Next by ${fmtShort(row.nextDueOn)}` : undefined }
    case 'due':
      if (!row.dueOn) return row.course === 'wvpp' ? { label: 'Waiting on plan', tone: 'neutral', detail: 'Due once the plan is written' } : { label: 'Due', tone: 'warn' }
      return { label: `Due ${fmtShort(row.dueOn)}`, tone: 'warn', detail: row.completedOn ? 'Refresher' : undefined }
    case 'overdue':
      // The first WVPP round has a 30-day company target, not a statutory deadline (LAW.md a-wvpp-1): amber, in its own words.
      if (row.course === 'wvpp' && !isStatutoryTraining(row)) {
        return { label: 'Past target', tone: 'warn', detail: row.dueOn ? `Target was ${fmtShort(row.dueOn)}` : undefined }
      }
      return { label: 'Overdue', tone: isStatutoryTraining(row) && row.required ? 'bad' : 'warn', detail: row.dueOn ? `Was due ${fmtShort(row.dueOn)}` : undefined }
    case 'upcoming':
      return { label: row.dueOn ? `Due ${fmtShort(row.dueOn)}` : 'Upcoming', tone: 'neutral' }
    case 'not_required':
      return row.recommended
        ? { label: 'Recommended', tone: 'outline', detail: row.dueOn ? `Suggested by ${fmtShort(row.dueOn)}` : undefined }
        : { label: 'Not required', tone: 'outline' }
  }
}

/** Rows that need a tap now: required and overdue or due soon (with a date), most urgent first. */
export function trainingTodo<T extends { row: TrainingRow }>(cells: T[]): T[] {
  return cells
    .filter((c) => c.row.required && (c.row.status === 'overdue' || (c.row.status === 'due' && !!c.row.dueOn)))
    .sort((a, b) => Number(b.row.status === 'overdue') - Number(a.row.status === 'overdue') || (a.row.dueOn ?? '').localeCompare(b.row.dueOn ?? ''))
}

// ---------------------------------------------------------------------------------------------
// Applicant records
// ---------------------------------------------------------------------------------------------

export type ApplicantRecordStats = {
  total: number
  /** An application or offer is still open, or the person was hired (their file follows personnel rules). */
  inProcess: number
  /** Inside the 4-year retention period. */
  retained: number
  anonymized: number
  /** Past retention and ready to anonymize. */
  eligible: number
  /** The next record to pass its retention date. */
  next?: { candidateId: ID; name: string; retainUntil: ISODate }
}

export function applicantRecordStats(db: DB, date: ISODate): ApplicantRecordStats {
  const out: ApplicantRecordStats = { total: db.candidates.length, inProcess: 0, retained: 0, anonymized: 0, eligible: 0 }
  for (const c of db.candidates) {
    if (c.anonymizedOn) {
      out.anonymized += 1
      continue
    }
    const until = candidateRetainUntil(db, c)
    if (!until) out.inProcess += 1
    else if (until >= date) {
      out.retained += 1
      if (!out.next || until < out.next.retainUntil) out.next = { candidateId: c.id, name: fullName(c), retainUntil: until }
    } else out.eligible += 1
  }
  return out
}
