// One integrity checker for a workspace (a DB). It reports what should never be true of the data:
// - a field that names a record which does not exist (people.managerId, offers.applicationId, ...);
// - an incomplete hire: an application marked hired whose person, starting pay row or onboarding
//   checklist is missing;
// - dates out of order (a start after its end, an offer decided before it was sent, ...);
// - two records sharing a value the domain keeps unique (an employee number, one accepted offer per
//   application);
// - and a few consistency checks between related records (a stage the job does not have, an offer whose
//   candidate differs from its application's).
//
// Each problem is a stable code plus the record ids, so tests can compare lists. Severity 'failure' means
// the data contradicts itself; 'note' means something expected is missing or unusual while the data stays
// readable (a hire recorded without an accepted offer, a manager with a last day who still has reports,
// history that names a record which no longer exists).
//
// Most checks are data (the rule lists below), not code: the server's read model turns the same lists into
// the SQL view v_integrity_problems (server/src/readmodel/integritySql.ts), and the few checks written as
// code (CUSTOM_CHECKS) have their SQL written there too. readmodel.test.ts plants every kind of problem and
// compares this file's answer with the view's, so SQL and TypeScript stay in step. Changing a rule changes
// the generated SQL: run `npm run server:gen-sql -- --read-model --write` (server/src/readmodel/spec.ts).
import { asDate, type IdPath, type PathTo, textOf, valueAt, valuesAt } from '@/domain/paths'
import type { CollectionKey, DB, ID } from '@/domain/types'

export type IntegritySeverity = 'failure' | 'note'

export type IntegrityCode =
  /** A field names a record that does not exist (otherId: the missing id, or null when a required field is empty). */
  | 'broken_reference'
  /** A person is their own manager. */
  | 'self_reference'
  /** A stage id the job's stage list does not have. */
  | 'unknown_stage'
  /** An interview step the job's interview plan does not have. */
  | 'unknown_step'
  /** A scorecard written by someone who is not on the interview's panel. */
  | 'not_on_panel'
  /** An application's stage differs from the last stage in its history. */
  | 'stage_history_mismatch'
  /** An application's stage history goes back in time. */
  | 'history_out_of_order'
  /** Two related records disagree (otherId: the related record), e.g. an offer's candidate and its application's. */
  | 'mismatched_link'
  /** An application marked hired with no person whose fromApplicationId points back. */
  | 'hire_missing_person'
  /** An application marked hired with no accepted offer. */
  | 'hire_missing_offer'
  /** A hired person (otherId) without a pay row of reason 'hire'. */
  | 'hire_missing_comp'
  /** A hired person (otherId) without an onboarding checklist. */
  | 'hire_missing_checklist'
  /** Two dates out of order; field names them as 'first>then'. */
  | 'date_order'
  /** A value the domain keeps unique appears again (otherId: the record that has it first, by id). */
  | 'duplicate_value'
  /** A person whose manager (otherId) has a last day while they stay on after it. */
  | 'manager_leaving'
  /** Two records in one collection share an id. Only the browser can hold this: the server refuses it. */
  | 'duplicate_id'

export type IntegrityProblem = {
  code: IntegrityCode
  severity: IntegritySeverity
  /** Where the record lives: a collection ('people'), or 'complianceStatus' for a rule's recorded status. */
  collection: string
  recordId: ID
  /** The field the problem is about, as a path: 'managerId', 'tasks[].assigneeId', 'startDate>endDate'. */
  field: string
  /** The other record involved, or the missing id; null when there is none. */
  otherId: ID | null
}

// ---------------------------------------------------------------------------------------------
// The rules, as data
// ---------------------------------------------------------------------------------------------

type Row<K extends CollectionKey> = DB[K][number]

/** Check only records whose `field` holds one of these values (a grant's holderType, an activity's entityType). */
export type When = { field: string; in: readonly string[] }

/** A field (or every id in a list) must name a record in one of the `to` collections. */
export type RefRule = {
  from: CollectionKey
  path: string
  to: readonly CollectionKey[]
  /** An empty value is a problem too (otherwise empty means "none" and is fine). */
  required: boolean
  when?: When
  /** A record pointing at itself through this field is a self_reference. */
  notSelf: boolean
  severity: IntegritySeverity
}

/** A field's values must appear in a list inside a parent record (or the record itself when parent is null). */
export type ListRule = {
  code: 'unknown_stage' | 'not_on_panel'
  from: CollectionKey
  path: string
  parent: { via: string; target: CollectionKey } | null
  list: string
  severity: IntegritySeverity
}

/** The record that `via` names must hold, in `theirs`, the value this record holds in `mine`. */
export type LinkRule = {
  from: CollectionKey
  via: string
  target: CollectionKey
  mine: string
  theirs: string
  severity: IntegritySeverity
}

/** `first` must not be after `then` when both are real dates. */
export type DateRule = { from: CollectionKey; first: string; then: string; severity: IntegritySeverity }

/** No two records may share a value at `path` (compared lowercased when `lower`). */
export type UniqueRule = { from: CollectionKey; path: string; when?: When; lower: boolean; severity: IntegritySeverity }

type RefInput<T> = {
  path: IdPath<T>
  to: CollectionKey | readonly CollectionKey[]
  required?: boolean
  when?: { field: PathTo<T, string>; in: readonly string[] }
  notSelf?: boolean
  severity?: IntegritySeverity
}

function refs<K extends CollectionKey>(from: K, list: Array<RefInput<Row<K>>>): RefRule[] {
  return list.map((r) => ({
    from,
    path: r.path,
    to: typeof r.to === 'string' ? [r.to] : r.to,
    required: r.required ?? false,
    ...(r.when ? { when: { field: r.when.field, in: r.when.in } } : {}),
    notSelf: r.notSelf ?? false,
    severity: r.severity ?? 'failure',
  }))
}

const req = <T>(path: IdPath<T>, to: CollectionKey | readonly CollectionKey[]): RefInput<T> => ({ path, to, required: true })
const opt = <T>(path: IdPath<T>, to: CollectionKey | readonly CollectionKey[]): RefInput<T> => ({ path, to })

/** Activity rows name a record of the kind their entityType says. History may outlive a record, so these are notes. */
const ACTIVITY_ENTITIES: Array<[string, CollectionKey]> = [
  ['person', 'people'],
  ['candidate', 'candidates'],
  ['application', 'applications'],
  ['job', 'jobs'],
  ['offer', 'offers'],
  ['interview', 'interviews'],
  ['checklist', 'checklists'],
  ['timeoff', 'timeOffRequests'],
  ['leave', 'leaveCases'],
  ['contractor', 'contractors'],
  ['plan', 'plan'],
]

export const REFERENCE_RULES: readonly RefRule[] = [
  ...refs('departments', [opt('headId', 'people')]),
  ...refs('bands', [req('familyId', 'families'), req('levelId', 'levels')]),
  ...refs('people', [
    { path: 'managerId', to: 'people', notSelf: true },
    req('departmentId', 'departments'),
    req('familyId', 'families'),
    req('levelId', 'levels'),
    req('locationId', 'locations'),
    opt('fromCandidateId', 'candidates'),
    opt('fromApplicationId', 'applications'),
    opt('rehireOfPersonId', 'people'),
    opt('fromContractorId', 'contractors'),
    opt('separation.handoffs[].toId', 'people'),
  ]),
  ...refs('comp', [
    req('personId', 'people'),
    req('levelId', 'levels'),
    opt('managerId', 'people'),
    opt('departmentId', 'departments'),
    opt('approvedById', 'people'),
  ]),
  ...refs('grants', [
    { path: 'personId', to: 'people', required: true, when: { field: 'holderType', in: ['employee'] } },
    { path: 'personId', to: 'candidates', required: true, when: { field: 'holderType', in: ['candidate'] } },
    { path: 'personId', to: 'contractors', required: true, when: { field: 'holderType', in: ['advisor', 'contractor'] } },
    opt('fromOfferId', 'offers'),
  ]),
  ...refs('contractors', [req('managerId', 'people'), req('departmentId', 'departments'), opt('convertedToPersonId', 'people')]),
  // Documents belong to employees, or to advisors for their grant agreements.
  ...refs('documents', [req('personId', ['people', 'contractors'])]),
  ...refs('plan', [
    opt('jobId', 'jobs'),
    opt('personId', 'people'),
    opt('backfillForPersonId', 'people'),
    req('departmentId', 'departments'),
    req('familyId', 'families'),
    req('levelId', 'levels'),
  ]),
  ...refs('jobs', [
    req('hiringManagerId', 'people'),
    req('panelIds[]', 'people'),
    req('locationIds[]', 'locations'),
    req('interviewPlan[].interviewerIds[]', 'people'),
    opt('planSlotId', 'plan'),
    opt('backfillForPersonId', 'people'),
    opt('requisition.requestedById', 'people'),
    opt('requisition.decidedById', 'people'),
    req('departmentId', 'departments'),
    req('familyId', 'families'),
    req('levelId', 'levels'),
  ]),
  ...refs('candidates', [opt('referrerId', 'people'), opt('otherReferrals[].referrerId', 'people'), opt('otherReferrals[].jobId', 'jobs')]),
  ...refs('applications', [req('candidateId', 'candidates'), req('jobId', 'jobs'), opt('nextStep.ownerId', 'people'), opt('history[].byId', 'people')]),
  ...refs('interviews', [req('applicationId', 'applications'), req('interviewerIds[]', 'people')]),
  ...refs('scorecards', [
    req('interviewId', 'interviews'),
    req('applicationId', 'applications'),
    req('interviewerId', 'people'),
    opt('enteredById', 'people'),
  ]),
  ...refs('offers', [
    req('applicationId', 'applications'),
    req('candidateId', 'candidates'),
    req('jobId', 'jobs'),
    req('managerId', 'people'),
    req('locationId', 'locations'),
    opt('personId', 'people'),
    opt('draftedById', 'people'),
    req('approvals[].approverId', 'people'),
    req('departmentId', 'departments'),
    req('familyId', 'families'),
    req('levelId', 'levels'),
  ]),
  ...refs('referrals', [req('candidateId', 'candidates'), req('referrerId', 'people')]),
  ...refs('checklists', [
    req('personId', 'people'),
    req('templateId', 'checklistTemplates'),
    opt('tasks[].assigneeId', 'people'),
    opt('tasks[].doneById', 'people'),
  ]),
  ...refs('timeOffRequests', [
    req('personId', 'people'),
    req('policyId', 'timeOffPolicies'),
    opt('approverId', 'people'),
    opt('recordedUnpaidFrom', 'timeOffPolicies'),
  ]),
  ...refs('timeOffAdjustments', [req('personId', 'people'), req('policyId', 'timeOffPolicies')]),
  ...refs('leaveCases', [req('personId', 'people')]),
  ...refs('trainings', [req('personId', 'people')]),
  ...refs('acks', [req('personId', 'people'), req('policyId', 'policies')]),
  ...refs('recordsRequests', [req('personId', 'people')]),
  ...refs('recurring', [opt('ownerId', 'people')]),
  ...refs('activity', [
    { path: 'actorId', to: 'people', severity: 'note' },
    ...ACTIVITY_ENTITIES.map(([type, to]): RefInput<Row<'activity'>> => ({ path: 'entityId', to, required: true, when: { field: 'entityType', in: [type] }, severity: 'note' })),
    { path: 'relatedId', to: ['people', 'candidates', 'contractors', 'jobs', 'applications'], severity: 'note' },
  ]),
]

function listRule<K extends CollectionKey, P extends CollectionKey>(r: {
  code: ListRule['code']
  from: K
  path: IdPath<Row<K>>
  parent: { via: PathTo<Row<K>, string>; target: P } | null
  list: IdPath<Row<P>>
  severity: IntegritySeverity
}): ListRule {
  return { code: r.code, from: r.from, path: r.path, parent: r.parent ? { via: r.parent.via, target: r.parent.target } : null, list: r.list, severity: r.severity }
}

export const LIST_RULES: readonly ListRule[] = [
  listRule({ code: 'unknown_stage', from: 'applications', path: 'stageId', parent: { via: 'jobId', target: 'jobs' }, list: 'stages[].id', severity: 'failure' }),
  listRule({ code: 'unknown_stage', from: 'applications', path: 'history[].stageId', parent: { via: 'jobId', target: 'jobs' }, list: 'stages[].id', severity: 'failure' }),
  listRule<'jobs', 'jobs'>({ code: 'unknown_stage', from: 'jobs', path: 'interviewPlan[].stageId', parent: null, list: 'stages[].id', severity: 'failure' }),
  // A panel can change after the interview, so this is a note.
  listRule({ code: 'not_on_panel', from: 'scorecards', path: 'interviewerId', parent: { via: 'interviewId', target: 'interviews' }, list: 'interviewerIds[]', severity: 'note' }),
]

function link<K extends CollectionKey, P extends CollectionKey>(
  from: K,
  via: PathTo<Row<K>, string>,
  target: P,
  mine: PathTo<Row<K>, string>,
  theirs: PathTo<Row<P>, string>,
  severity: IntegritySeverity = 'failure',
): LinkRule {
  return { from, via, target, mine, theirs, severity }
}

export const LINK_RULES: readonly LinkRule[] = [
  link('offers', 'applicationId', 'applications', 'candidateId', 'candidateId'),
  link('offers', 'applicationId', 'applications', 'jobId', 'jobId'),
  link('offers', 'personId', 'people', 'applicationId', 'fromApplicationId'),
  link('people', 'fromApplicationId', 'applications', 'fromCandidateId', 'candidateId'),
  link('scorecards', 'interviewId', 'interviews', 'applicationId', 'applicationId'),
  // A second hire from one job gets a plan line of its own while the job keeps pointing at the first.
  link('plan', 'jobId', 'jobs', 'id', 'planSlotId', 'note'),
]

function dates<K extends CollectionKey>(from: K, pairs: Array<[PathTo<Row<K>, string>, PathTo<Row<K>, string>, IntegritySeverity?]>): DateRule[] {
  return pairs.map(([first, then, severity]) => ({ from, first, then, severity: severity ?? 'failure' }))
}

export const DATE_RULES: readonly DateRule[] = [
  ...dates('people', [
    ['startDate', 'endDate'],
    ['startDate', 'separation.lastDay'],
    ['separation.noticeGivenOn', 'separation.lastDay'],
  ]),
  ...dates('contractors', [['startOn', 'endOn']]),
  ...dates('jobs', [
    ['openedOn', 'closedOn'],
    ['postedOn', 'closedOn'],
  ]),
  ...dates('applications', [
    ['appliedOn', 'stageEnteredOn'],
    ['appliedOn', 'closedOn'],
  ]),
  ...dates('offers', [
    ['createdOn', 'sentOn'],
    ['sentOn', 'decidedOn'],
    ['createdOn', 'decidedOn'],
    // A re-sent offer can keep an old expiry.
    ['sentOn', 'expiresOn', 'note'],
  ]),
  ...dates('grants', [['proposedOn', 'boardApprovedOn', 'note']]),
  ...dates('checklists', [['createdOn', 'completedOn']]),
  ...dates('candidates', [['createdOn', 'retainUntil']]),
  ...dates('timeOffRequests', [
    ['startDate', 'endDate'],
    ['requestedOn', 'decidedOn'],
  ]),
  ...dates('leaveCases', [
    ['startDate', 'expectedReturn'],
    ['startDate', 'returnedOn'],
    ['startDate', 'endedOn'],
  ]),
  ...dates('recordsRequests', [
    ['receivedOn', 'dueOn'],
    ['receivedOn', 'fulfilledOn'],
  ]),
]

function unique<K extends CollectionKey>(
  from: K,
  path: PathTo<Row<K>, string | number>,
  opts: { severity?: IntegritySeverity; lower?: boolean; when?: { field: PathTo<Row<K>, string>; in: readonly string[] } } = {},
): UniqueRule {
  return { from, path, lower: opts.lower ?? false, severity: opts.severity ?? 'failure', ...(opts.when ? { when: { field: opts.when.field, in: opts.when.in } } : {}) }
}

export const UNIQUE_RULES: readonly UniqueRule[] = [
  unique('people', 'hireNumber'),
  // One person per application, and one accepted offer per application.
  unique('people', 'fromApplicationId'),
  unique('offers', 'applicationId', { when: { field: 'status', in: ['accepted'] } }),
  unique('people', 'workEmail', { lower: true, severity: 'note' }),
  unique('people', 'payrollId', { severity: 'note' }),
  // Refer someone looks people up by email, so a second candidate with the same email is a duplicate.
  unique('candidates', 'email', { lower: true, severity: 'note' }),
]

/**
 * Checks written as code below; server/src/readmodel/integritySql.ts holds the SQL for each, under the
 * same name (generating the read model fails when one is missing).
 */
export const CUSTOM_CHECKS = ['stage_history', 'history_order', 'hire', 'interview_step', 'compliance_owner', 'activity_equity', 'manager_leaving'] as const

export type CustomCheck = (typeof CUSTOM_CHECKS)[number]

// ---------------------------------------------------------------------------------------------
// The checker
// ---------------------------------------------------------------------------------------------

type Rec = Record<string, unknown>

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Code-unit order (the read model sorts ids with COLLATE "C", which agrees for these ids). */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

class Checker {
  readonly out = new Map<string, IntegrityProblem>()
  private readonly indexes = new Map<CollectionKey, Map<string, Rec>>()

  constructor(readonly db: DB) {}

  list(c: CollectionKey): Rec[] {
    const v = (this.db as unknown as Record<string, unknown>)[c]
    return Array.isArray(v) ? v.filter(isRec) : []
  }

  index(c: CollectionKey): Map<string, Rec> {
    let m = this.indexes.get(c)
    if (!m) {
      m = new Map()
      for (const r of this.list(c)) {
        const id = textOf(r.id)
        if (id !== null && !m.has(id)) m.set(id, r)
      }
      this.indexes.set(c, m)
    }
    return m
  }

  has(c: CollectionKey, id: string): boolean {
    return this.index(c).has(id)
  }

  add(code: IntegrityCode, severity: IntegritySeverity, collection: string, recordId: string, field: string, otherId: string | null): void {
    const key = [code, collection, recordId, field, otherId ?? ''].join('\u0000')
    if (!this.out.has(key)) this.out.set(key, { code, severity, collection, recordId, field, otherId })
  }

  matches(r: Rec, when: When | undefined): boolean {
    if (!when) return true
    const v = textOf(valueAt(r, when.field))
    return v !== null && when.in.includes(v)
  }
}

function checkRef(c: Checker, rule: RefRule): void {
  for (const r of c.list(rule.from)) {
    const id = textOf(r.id) ?? ''
    if (!c.matches(r, rule.when)) continue
    for (const raw of valuesAt(r, rule.path)) {
      const v = textOf(raw)
      if (v === null) {
        if (rule.required) c.add('broken_reference', rule.severity, rule.from, id, rule.path, null)
        continue
      }
      if (rule.notSelf && v === id) c.add('self_reference', rule.severity, rule.from, id, rule.path, v)
      if (!rule.to.some((t) => c.has(t, v))) c.add('broken_reference', rule.severity, rule.from, id, rule.path, v)
    }
  }
}

function checkList(c: Checker, rule: ListRule): void {
  for (const r of c.list(rule.from)) {
    const parent = rule.parent ? c.index(rule.parent.target).get(textOf(valueAt(r, rule.parent.via)) ?? '') : r
    if (!parent) continue
    const allowed = new Set(valuesAt(parent, rule.list).map(textOf))
    for (const raw of valuesAt(r, rule.path)) {
      const v = textOf(raw)
      if (v !== null && !allowed.has(v)) c.add(rule.code, rule.severity, rule.from, textOf(r.id) ?? '', rule.path, v)
    }
  }
}

function checkLink(c: Checker, rule: LinkRule): void {
  for (const r of c.list(rule.from)) {
    const target = c.index(rule.target).get(textOf(valueAt(r, rule.via)) ?? '')
    if (!target) continue
    if (textOf(valueAt(r, rule.mine)) !== textOf(valueAt(target, rule.theirs))) {
      c.add('mismatched_link', rule.severity, rule.from, textOf(r.id) ?? '', `${rule.via}.${rule.theirs}`, textOf(target.id))
    }
  }
}

function checkDates(c: Checker, rule: DateRule): void {
  for (const r of c.list(rule.from)) {
    const a = asDate(valueAt(r, rule.first))
    const b = asDate(valueAt(r, rule.then))
    if (a && b && a > b) c.add('date_order', rule.severity, rule.from, textOf(r.id) ?? '', `${rule.first}>${rule.then}`, null)
  }
}

function checkUnique(c: Checker, rule: UniqueRule): void {
  const groups = new Map<string, string[]>()
  for (const r of c.list(rule.from)) {
    if (!c.matches(r, rule.when)) continue
    const raw = textOf(valueAt(r, rule.path))
    const id = textOf(r.id)
    if (raw === null || id === null) continue
    const v = rule.lower ? raw.toLowerCase() : raw
    groups.set(v, [...(groups.get(v) ?? []), id])
  }
  for (const ids of groups.values()) {
    if (ids.length < 2) continue
    const [first, ...rest] = [...ids].sort(byCodeUnit)
    for (const id of rest) if (id !== first) c.add('duplicate_value', rule.severity, rule.from, id, rule.path, first)
  }
}

const CUSTOM: Record<CustomCheck, (c: Checker) => void> = {
  stage_history(c) {
    for (const a of c.list('applications')) {
      const history = Array.isArray(a.history) ? a.history : []
      if (history.length === 0) continue
      const last = textOf(valueAt(history[history.length - 1], 'stageId'))
      if (last !== textOf(a.stageId)) c.add('stage_history_mismatch', 'failure', 'applications', textOf(a.id) ?? '', 'stageId', last)
    }
  },
  history_order(c) {
    for (const a of c.list('applications')) {
      const at = valuesAt(a, 'history[]').map((h) => asDate(valueAt(h, 'at')))
      for (let i = 1; i < at.length; i++) {
        const prev = at[i - 1]
        const cur = at[i]
        if (prev && cur && cur < prev) c.add('history_out_of_order', 'failure', 'applications', textOf(a.id) ?? '', 'history[].at', null)
      }
    }
  },
  hire(c) {
    for (const a of c.list('applications')) {
      if (textOf(a.status) !== 'hired') continue
      const appId = textOf(a.id) ?? ''
      if (!c.list('offers').some((o) => textOf(o.applicationId) === appId && textOf(o.status) === 'accepted')) {
        c.add('hire_missing_offer', 'note', 'applications', appId, 'offers', null)
      }
      const people = c.list('people').filter((p) => textOf(p.fromApplicationId) === appId)
      if (people.length === 0) c.add('hire_missing_person', 'failure', 'applications', appId, 'people', null)
      for (const p of people) {
        const personId = textOf(p.id) ?? ''
        if (!c.list('comp').some((r) => textOf(r.personId) === personId && textOf(r.reason) === 'hire')) {
          c.add('hire_missing_comp', 'failure', 'applications', appId, 'comp', personId)
        }
        if (!c.list('checklists').some((r) => textOf(r.personId) === personId && textOf(r.kind) === 'onboarding')) {
          c.add('hire_missing_checklist', 'note', 'applications', appId, 'checklists', personId)
        }
      }
    }
  },
  interview_step(c) {
    // Steps can be edited out of a job's plan after an interview used them, so this is a note.
    for (const i of c.list('interviews')) {
      const step = textOf(i.stepId)
      if (step === null) continue
      const app = c.index('applications').get(textOf(i.applicationId) ?? '')
      const job = app && c.index('jobs').get(textOf(app.jobId) ?? '')
      if (job && !valuesAt(job, 'interviewPlan[].id').map(textOf).includes(step)) c.add('unknown_step', 'note', 'interviews', textOf(i.id) ?? '', 'stepId', step)
    }
  },
  compliance_owner(c) {
    const statuses: unknown = c.db.complianceStatus
    if (!isRec(statuses)) return
    for (const [ruleId, s] of Object.entries(statuses)) {
      const owner = textOf(valueAt(s, 'ownerId'))
      if (owner !== null && !c.has('people', owner)) c.add('broken_reference', 'failure', 'complianceStatus', ruleId, 'ownerId', owner)
    }
  },
  activity_equity(c) {
    // Equity rows name a grant, a holder, a 409A valuation, a pool increase or the equity setup ('equity').
    const setup = new Set([...valuesAt(c.db.equity, 'valuations[].id'), ...valuesAt(c.db.equity, 'poolIncreases[].id')].map(textOf))
    for (const a of c.list('activity')) {
      if (textOf(a.entityType) !== 'equity') continue
      const v = textOf(a.entityId)
      const known = v !== null && (v === 'equity' || c.has('grants', v) || c.has('people', v) || c.has('contractors', v) || setup.has(v))
      if (!known) c.add('broken_reference', 'note', 'activity', textOf(a.id) ?? '', 'entityId', v)
    }
  },
  manager_leaving(c) {
    for (const p of c.list('people')) {
      const id = textOf(p.id) ?? ''
      const manager = c.index('people').get(textOf(p.managerId) ?? '')
      if (!manager || textOf(manager.id) === id) continue
      const managerEnd = asDate(manager.endDate)
      const end = asDate(p.endDate)
      if (managerEnd && (!end || end > managerEnd)) c.add('manager_leaving', 'note', 'people', id, 'managerId', textOf(manager.id))
    }
  },
}

/** Every problem in the workspace, sorted by code, collection, record, field and other id. Empty when consistent. */
export function integrityProblems(db: DB): IntegrityProblem[] {
  const c = new Checker(db)
  for (const [key, value] of Object.entries(db)) {
    if (!Array.isArray(value)) continue
    const seen = new Set<string>()
    for (const r of value) {
      const id = isRec(r) ? textOf(r.id) : null
      if (id === null) continue
      if (seen.has(id)) c.add('duplicate_id', 'failure', key, id, 'id', null)
      seen.add(id)
    }
  }
  for (const rule of REFERENCE_RULES) checkRef(c, rule)
  for (const rule of LIST_RULES) checkList(c, rule)
  for (const rule of LINK_RULES) checkLink(c, rule)
  for (const rule of DATE_RULES) checkDates(c, rule)
  for (const rule of UNIQUE_RULES) checkUnique(c, rule)
  for (const name of CUSTOM_CHECKS) CUSTOM[name](c)
  return [...c.out.values()].sort(
    (a, b) =>
      byCodeUnit(a.code, b.code) ||
      byCodeUnit(a.collection, b.collection) ||
      byCodeUnit(a.recordId, b.recordId) ||
      byCodeUnit(a.field, b.field) ||
      byCodeUnit(a.otherId ?? '', b.otherId ?? ''),
  )
}

/** Only the failures (the data contradicts itself). */
export function integrityFailures(db: DB): IntegrityProblem[] {
  return integrityProblems(db).filter((p) => p.severity === 'failure')
}

/** One line per problem, for test messages and logs: 'broken_reference people p-1 managerId p-9'. */
export function describeProblem(p: IntegrityProblem): string {
  return [p.code, p.collection, p.recordId, p.field, p.otherId ?? '-'].join(' ')
}
