// Mutation helpers for compliance state. Each takes an Immer draft inside
// useDB.getState().mutate(label, (draft) => ...) and logs a plain-language activity row.
// Import from '@/domain/compliance/actions' (not the folder index): this file pulls in the store,
// and keeping it out of the index lets pure modules and the sample seed import the engine freely.
import type { Draft } from 'immer'
import { closeTrainingTasks } from '@/domain/checklists/actions'
import { fullName } from '@/domain/people'
import { openTrainingRows, TRAINING_LABELS } from '@/domain/trainings'
import type { ComplianceStatus, DB, ID, RecurringItem, TrainingKind } from '@/domain/types'
import { addMonths, fmtDate, fmtQuarter, type ISODate, quarterOf } from '@/lib/dates'
import { newId } from '@/lib/id'
import { logActivity } from '@/store/draft'
import { cycleActionDoneOn, cycleDueOn, cycleStartsOn, cycleYearForCompletion } from './engine'
import { candidateRetainUntil } from './retention'
import { annualDoneKey, type ComplianceRule, cycleActionKey, RULE_BY_ID, SOC2_ACCESS_REVIEW_ID } from './rules'

function title(ruleId: string): string {
  return RULE_BY_ID[ruleId]?.title ?? (ruleId === SOC2_ACCESS_REVIEW_ID ? 'Quarterly access review (SOC 2)' : ruleId)
}

function ensureStatus(draft: Draft<DB>, ruleId: string): Draft<ComplianceStatus> {
  if (!draft.complianceStatus[ruleId]) draft.complianceStatus[ruleId] = {}
  return draft.complianceStatus[ruleId]
}

/** Marks a rule done, in progress or not applicable (with an optional note), or clears it with null. */
export function setRuleStatus(
  draft: Draft<DB>,
  ruleId: string,
  status: NonNullable<ComplianceStatus['status']> | null,
  date: ISODate,
  note?: string,
): void {
  const s = ensureStatus(draft, ruleId)
  if (status === null) {
    delete s.status
    delete s.doneOn
  } else {
    s.status = status
    if (status === 'done') s.doneOn = date
    else delete s.doneOn
  }
  if (note !== undefined) s.note = note || undefined
  const words = status === null ? 'Cleared the status of' : status === 'done' ? 'Marked done:' : status === 'in_progress' ? 'Started:' : 'Marked not applicable:'
  logActivity(draft, {
    entityType: 'compliance',
    entityId: ruleId,
    kind: 'compliance_status',
    text: `${words} ${title(ruleId)}${status === 'not_applicable' && note ? ` (${note})` : ''}`,
  })
}

/**
 * Records (date) or clears (null) one action on a rule card. A yearly action (rule.cycle) is stored for the
 * cycle year it completes ('send-annual@2027', a late filing counts for last year's cycle), and once every
 * yearly action of that cycle is done the whole-cycle key the calendar reads ('year-2027') is set too, the
 * same key markAnnualDone writes. Clearing a yearly action reopens its latest recorded cycle.
 * SB 553 'Train everyone' also records training for everyone in scope: trainingsRecordedBy says how many
 * beforehand, so the toast can name what was recorded. (No return value: recipes are often written as
 * `(d) => setRuleActionDone(...)`, and an Immer recipe that returns a value replaces the state.)
 */
export function setRuleActionDone(draft: Draft<DB>, ruleId: string, actionId: string, date: ISODate | null): void {
  const s = ensureStatus(draft, ruleId)
  const actions = (s.actionsDone ??= {})
  const rule = RULE_BY_ID[ruleId]
  const action = rule?.actions.find((a) => a.id === actionId)
  const label = action?.title ?? actionId
  const yearly = !!rule?.cycle?.actionIds.includes(actionId)
  let year: number | undefined
  if (rule?.cycle && yearly) {
    const db = draft as unknown as DB
    if (date === null) {
      year = latestCycleYear(rule, actions, actionId)
      if (year !== undefined) {
        const whole = actions[annualDoneKey(year)]
        if (whole) {
          // Keep the other yearly actions of that cycle done.
          delete actions[annualDoneKey(year)]
          for (const id of rule.cycle.actionIds) if (id !== actionId && !actions[cycleActionKey(id, year)]) actions[cycleActionKey(id, year)] = whole
        }
        delete actions[cycleActionKey(actionId, year)]
        const plain = actions[actionId]
        if (plain && plain >= cycleStartsOn(rule, year) && plain <= cycleDueOn(rule, year)) delete actions[actionId]
      }
    } else {
      year = cycleYearForCompletion(db, rule, actionId, date)
      actions[cycleActionKey(actionId, year)] = date
      const dates = rule.cycle.actionIds.map((id) => cycleActionDoneOn(rule, actions, id, year as number))
      if (dates.every(Boolean)) actions[annualDoneKey(year)] = (dates as ISODate[]).sort().pop() as ISODate
    }
  } else if (date === null) delete actions[actionId]
  else actions[actionId] = date
  // SB 553: ticking "Train everyone" records a WVPP completion for each person in scope who has none,
  // so the rule card and the training tracker agree (one change, so Undo reverts both).
  if (ruleId === 'wvpp' && actionId === 'train' && date !== null) {
    for (const { person } of openTrainingRows(draft as unknown as DB, date, 'wvpp')) recordTrainingCompletion(draft, person.id, 'wvpp', date)
  }
  const forYear = year !== undefined ? ` for ${year}` : ''
  logActivity(draft, {
    entityType: 'compliance',
    entityId: ruleId,
    kind: 'compliance_action',
    text: date === null ? `Reopened "${label}"${forYear} (${title(ruleId)})` : `Done${forYear}: "${label}" (${title(ruleId)})`,
  })
}

/**
 * How many WVPP training records ticking the rule action would create on the date: everyone in scope with
 * no completion (only the SB 553 'Train everyone' action creates records; any other action, none).
 */
export function trainingsRecordedBy(db: DB, ruleId: string, actionId: string, date: ISODate): number {
  return ruleId === 'wvpp' && actionId === 'train' ? openTrainingRows(db, date, 'wvpp').length : 0
}

/** The latest cycle year in which a yearly action is recorded done (by its own key, the whole-cycle key or a plain date). */
function latestCycleYear(rule: ComplianceRule, actions: Record<string, ISODate>, actionId: string): number | undefined {
  const years = new Set<number>()
  for (const k of Object.keys(actions)) {
    const m = k.match(/^(.*)@(\d{4})$/) ?? k.match(/^(year)-(\d{4})$/)
    if (m && (m[1] === actionId || m[1] === 'year')) years.add(Number(m[2]))
  }
  const plain = actions[actionId]
  if (plain) years.add(plain.slice(5) <= (rule.cycle?.dueMonthDay ?? '12-31') ? Number(plain.slice(0, 4)) : Number(plain.slice(0, 4)) + 1)
  const sorted = [...years].sort((a, b) => b - a)
  return sorted.find((y) => !!cycleActionDoneOn(rule, actions, actionId, y))
}

/**
 * Sets (or clears with null) an admin override of a rule's computed count. A note is required. On 20-week
 * federal rules (method weeks_20) the value is a number of qualifying weeks, not people.
 */
export function setCountOverride(draft: Draft<DB>, ruleId: string, override: { value: number; note: string } | null): void {
  const s = ensureStatus(draft, ruleId)
  if (override === null) delete s.countOverride
  else s.countOverride = { value: override.value, note: override.note.trim() }
  logActivity(draft, {
    entityType: 'compliance',
    entityId: ruleId,
    kind: 'count_override',
    text:
      override === null
        ? `Removed the count override on ${title(ruleId)}`
        : `Set the count for ${title(ruleId)} to ${override.value}: ${override.note.trim()}`,
  })
}

/** Records a deadline for a rule (for example the date in a CalSavers notice), or clears it with null. */
export function setRuleDeadline(draft: Draft<DB>, ruleId: string, dueOn: ISODate | null, note?: string): void {
  const s = ensureStatus(draft, ruleId)
  if (dueOn === null) delete s.dueOn
  else s.dueOn = dueOn
  if (note !== undefined) s.note = note || undefined
  logActivity(draft, {
    entityType: 'compliance',
    entityId: ruleId,
    kind: 'compliance_deadline',
    text: dueOn === null ? `Removed the deadline for ${title(ruleId)}` : `Set the deadline for ${title(ruleId)} to ${fmtDate(dueOn)}`,
  })
}

/** Marks a yearly notice (SB 294 Feb 1 notice, survivors notice, 1099-NEC filing) sent for a year. */
export function markAnnualDone(draft: Draft<DB>, ruleId: string, year: number, date: ISODate): void {
  const s = ensureStatus(draft, ruleId)
  ;(s.actionsDone ??= {})[annualDoneKey(year)] = date
  logActivity(draft, { entityType: 'compliance', entityId: ruleId, kind: 'compliance_annual', text: `Done for ${year}: ${title(ruleId)}` })
}

/**
 * Records a completed course ('one tap marks a course done today'). Fills the open training row for
 * that person and kind when there is one, otherwise adds a row.
 */
export function recordTrainingCompletion(
  draft: Draft<DB>,
  personId: ID,
  kind: TrainingKind,
  completedOn: ISODate,
  opts: { certificateLink?: string; provider?: string; dueOn?: ISODate } = {},
): void {
  const open = draft.trainings.find((t) => t.personId === personId && t.kind === kind && !t.completedOn)
  if (open) {
    open.completedOn = completedOn
    if (opts.certificateLink) open.certificateLink = opts.certificateLink
    if (opts.provider) open.provider = opts.provider
  } else {
    draft.trainings.push({
      id: newId('trn'),
      personId,
      kind,
      dueOn: opts.dueOn ?? completedOn,
      completedOn,
      certificateLink: opts.certificateLink,
      provider: opts.provider,
    })
  }
  const person = draft.people.find((p) => p.id === personId)
  logActivity(draft, {
    entityType: 'person',
    entityId: personId,
    kind: 'training_done',
    text: `${person ? fullName(person) : 'Someone'} completed ${TRAINING_LABELS[kind].toLowerCase()} on ${fmtDate(completedOn)}`,
  })
  // The onboarding (or new supervisor) task for this training is done too, so the checklist agrees.
  closeTrainingTasks(draft, personId, kind, completedOn)
}

const CADENCE_MONTHS: Record<RecurringItem['cadence'], number> = { monthly: 1, quarterly: 3, annual: 12, biennial: 24, once: 0 }

/**
 * Ticks a recurring item: sets lastDoneOn and moves nextDueOn forward one cadence step. For the SOC 2 access
 * review it also records the review for the quarter of the occurrence being completed, so each quarter keeps
 * its own evidence.
 */
export function completeRecurringItem(draft: Draft<DB>, recurringId: ID, doneOn: ISODate): void {
  const r = draft.recurring.find((x) => x.id === recurringId)
  if (!r) return
  if (r.ruleId === SOC2_ACCESS_REVIEW_ID) {
    const done = (ensureStatus(draft, SOC2_ACCESS_REVIEW_ID).actionsDone ??= {})
    const q = quarterOf(r.nextDueOn)
    if (!done[q]) done[q] = doneOn
  }
  r.lastDoneOn = doneOn
  const step = CADENCE_MONTHS[r.cadence]
  if (step) {
    // The current occurrence is done (early or late): move past it and past the done date.
    const base = r.nextDueOn
    let k = 1
    while (addMonths(base, step * k) <= doneOn && k < 1000) k++
    r.nextDueOn = addMonths(base, step * k)
  }
  logActivity(draft, { entityType: 'compliance', entityId: r.ruleId ?? r.id, kind: 'recurring_done', text: `Done: ${r.title} (${fmtDate(doneOn)})` })
}

/** Records the SOC 2 quarterly access review for a quarter ('2026-Q4') and advances its recurring item. */
export function markAccessReviewDone(draft: Draft<DB>, quarter: string, doneOn: ISODate): void {
  const s = ensureStatus(draft, SOC2_ACCESS_REVIEW_ID)
  ;(s.actionsDone ??= {})[quarter] = doneOn
  const r = draft.recurring.find((x) => x.ruleId === SOC2_ACCESS_REVIEW_ID)
  if (r) {
    if (!r.lastDoneOn || doneOn > r.lastDoneOn) r.lastDoneOn = doneOn
    // Move the next due date past the recorded quarter (recording an older quarter leaves it alone).
    const base = r.nextDueOn
    let k = 0
    while ((quarterOf(addMonths(base, 3 * k)) <= quarter || addMonths(base, 3 * k) <= doneOn) && k < 1000) k++
    r.nextDueOn = addMonths(base, 3 * k)
  }
  logActivity(draft, {
    entityType: 'compliance',
    entityId: SOC2_ACCESS_REVIEW_ID,
    kind: 'access_review_done',
    text: `Recorded the ${fmtQuarter(quarter)} access review (SOC 2), done ${fmtDate(doneOn)}`,
  })
}

/**
 * Anonymizes an applicant past retention: removes name, contact details, links, notes and pay
 * expectations from the candidate, their applications and scorecards, and scrubs the name from
 * related activity rows. Counts and dates stay for hiring metrics. Does nothing while the record is
 * inside its 4-year retention period, or while an application or offer is open (Delete becomes Archive).
 */
export function anonymizeCandidate(draft: Draft<DB>, candidateId: ID, date: ISODate): void {
  const c = draft.candidates.find((x) => x.id === candidateId)
  if (!c || c.anonymizedOn) return
  const until = candidateRetainUntil(draft as unknown as DB, c)
  if (!until || until >= date) return
  const names = [fullName(c), `${c.firstName} ${c.lastName}`].filter((n, i, a) => n.trim() && a.indexOf(n) === i)
  c.firstName = 'Former'
  c.lastName = 'applicant'
  c.email = ''
  delete c.phone
  c.links = {}
  delete c.location
  delete c.timezone
  delete c.currentTitle
  delete c.currentCompany
  delete c.summary
  delete c.desiredPay
  delete c.desiredPayUnit
  delete c.sourceDetail
  c.tags = []
  c.archived = true
  c.anonymizedOn = date
  const appIds = new Set(draft.applications.filter((a) => a.candidateId === candidateId).map((a) => a.id))
  for (const a of draft.applications) {
    if (!appIds.has(a.id)) continue
    delete a.outcomeNote
    delete a.nextStep
  }
  for (const s of draft.scorecards) if (appIds.has(s.applicationId)) delete s.notes
  for (const o of draft.offers) if (o.candidateId === candidateId) delete o.competingNote
  for (const act of draft.activity) {
    const related = act.entityId === candidateId || act.relatedId === candidateId || appIds.has(act.entityId)
    if (!related) continue
    for (const n of names) act.text = act.text.split(n).join('Former applicant')
  }
  logActivity(draft, {
    entityType: 'candidate',
    entityId: candidateId,
    kind: 'anonymized',
    text: 'Anonymized an applicant record past its 4-year retention date',
  })
}
