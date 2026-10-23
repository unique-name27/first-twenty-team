import { produce } from 'immer'
import { describe, expect, it, vi } from 'vitest'
import type { DB } from '@/domain/types'

// The real store builds the sample workspace on import; these helpers only need logActivity.
vi.mock('@/store/db', () => ({
  logActivity: (draft: DB, a: Omit<DB['activity'][number], 'id' | 'at'>) => {
    draft.activity.push({ id: `act-${draft.activity.length + 1}`, at: '2026-10-09T20:00:00.000Z', actorId: null, ...a })
  },
}))

const {
  anonymizeCandidate,
  completeRecurringItem,
  markAccessReviewDone,
  markAnnualDone,
  recordTrainingCompletion,
  setCountOverride,
  setRuleActionDone,
  setRuleDeadline,
  setRuleStatus,
  trainingsRecordedBy,
} = await import('./actions')
const { evaluateRule } = await import('./engine')
const { RULE_BY_ID } = await import('./rules')
const { soc2Evidence } = await import('./soc2')
const { addMany, addPerson, makeDB } = await import('./testkit')

const lastText = (db: DB) => db.activity[db.activity.length - 1]?.text

describe('rule status helpers', () => {
  it('marks a rule done, not applicable, or clears it, and logs each change', () => {
    let db = makeDB()
    addMany(db, 5, '2025-02-03')
    db = produce(db, (d) => setRuleStatus(d, 'feha', 'done', '2026-10-09'))
    expect(db.complianceStatus.feha).toMatchObject({ status: 'done', doneOn: '2026-10-09' })
    expect(evaluateRule(db, RULE_BY_ID.feha, '2026-10-09').state).toBe('done')
    expect(lastText(db)).toBe('Marked done: FEHA anti-discrimination rules')
    db = produce(db, (d) => setRuleStatus(d, 'iipp', 'not_applicable', '2026-10-09', 'Covered by the PEO'))
    expect(lastText(db)).toBe('Marked not applicable: Injury and illness prevention program (IIPP) (Covered by the PEO)')
    db = produce(db, (d) => setRuleStatus(d, 'feha', null, '2026-10-09'))
    expect(db.complianceStatus.feha.status).toBeUndefined()
    expect(db.complianceStatus.feha.doneOn).toBeUndefined()
  })

  it('records and reopens actions, overrides counts and records deadlines', () => {
    let db = makeDB()
    db = produce(db, (d) => setRuleActionDone(d, 'iipp', 'write-iipp', '2026-10-01'))
    expect(db.complianceStatus.iipp.actionsDone).toEqual({ 'write-iipp': '2026-10-01' })
    expect(lastText(db)).toBe('Done: "Write the IIPP" (Injury and illness prevention program (IIPP))')
    db = produce(db, (d) => setRuleActionDone(d, 'iipp', 'write-iipp', null))
    expect(db.complianceStatus.iipp.actionsDone).toEqual({})

    db = produce(db, (d) => setCountOverride(d, 'feha', { value: 5, note: ' Two agency temps ' }))
    expect(db.complianceStatus.feha.countOverride).toEqual({ value: 5, note: 'Two agency temps' })
    expect(evaluateRule(db, RULE_BY_ID.feha, '2026-10-09').overridden).toBe(true)
    db = produce(db, (d) => setCountOverride(d, 'feha', null))
    expect(db.complianceStatus.feha.countOverride).toBeUndefined()

    db = produce(db, (d) => setRuleDeadline(d, 'calsavers-or-401k', '2027-12-31', 'From the CalSavers notice'))
    expect(db.complianceStatus['calsavers-or-401k']).toMatchObject({ dueOn: '2027-12-31', note: 'From the CalSavers notice' })
    expect(lastText(db)).toBe('Set the deadline for CalSavers or a retirement plan to Dec 31, 2027')

    db = produce(db, (d) => markAnnualDone(d, 'sb294-annual-notice', 2027, '2027-01-20'))
    expect(db.complianceStatus['sb294-annual-notice'].actionsDone).toEqual({ 'year-2027': '2027-01-20' })
  })
})

describe('yearly actions', () => {
  const SB294 = 'sb294-annual-notice'
  const done = (db: DB) => db.complianceStatus[SB294].actionsDone ?? {}

  it('stores a yearly action for its cycle, counting a late notice toward last year', () => {
    let db = makeDB('2025-01-06')
    addMany(db, 2, '2025-03-03')
    db = produce(db, (d) => setRuleActionDone(d, SB294, 'send-annual', '2026-02-10'))
    expect(done(db)).toEqual({ 'send-annual@2026': '2026-02-10' })
    expect(lastText(db)).toBe(`Done for 2026: "Send this year's notice by Feb 1" (SB 294 workplace rights notice (every Feb 1))`)
    db = produce(db, (d) => setRuleActionDone(d, SB294, 'record-dates', '2026-02-10'))
    expect(done(db)['year-2026']).toBe('2026-02-10')
    // Quiet until 60 days before Feb 1, 2027, then the 2027 notice opens.
    expect(evaluateRule(db, RULE_BY_ID[SB294], '2026-06-01').state).toBe('done')
    expect(evaluateRule(db, RULE_BY_ID[SB294], '2027-01-25').openActions.map((a) => a.id)).toEqual(['send-annual', 'record-dates'])
    // On time for 2027, then reopened: only the latest cycle is cleared.
    db = produce(db, (d) => setRuleActionDone(d, SB294, 'send-annual', '2027-01-20'))
    expect(done(db)['send-annual@2027']).toBe('2027-01-20')
    db = produce(db, (d) => setRuleActionDone(d, SB294, 'send-annual', null))
    expect(done(db)['send-annual@2027']).toBeUndefined()
    expect(done(db)['send-annual@2026']).toBe('2026-02-10')
    expect(lastText(db)).toBe(`Reopened "Send this year's notice by Feb 1" for 2027 (SB 294 workplace rights notice (every Feb 1))`)
  })

  it('agrees with markAnnualDone: the card reads the calendar key, and reopening one action keeps the other', () => {
    let db = makeDB('2025-01-06')
    addMany(db, 2, '2025-03-03')
    db = produce(db, (d) => markAnnualDone(d, SB294, 2027, '2027-01-22'))
    expect(evaluateRule(db, RULE_BY_ID[SB294], '2027-01-25').state).toBe('done')
    db = produce(db, (d) => setRuleActionDone(d, SB294, 'record-dates', null))
    expect(done(db)).toEqual({ 'send-annual@2027': '2027-01-22' })
    expect(evaluateRule(db, RULE_BY_ID[SB294], '2027-01-25').openActions.map((a) => a.id)).toEqual(['record-dates'])
  })
})

describe('training and recurring helpers', () => {
  it("says how many WVPP training records 'Train everyone' creates, and creates exactly those", () => {
    let db = makeDB('2025-01-06')
    db.locations[0].typicalMaxOnSite = 12
    addMany(db, 11, '2026-03-02')
    addPerson(db, { id: 'p-remote', startDate: '2026-03-02', workMode: 'remote', locationId: 'loc-remote-tx', homeState: 'TX' })
    const t = '2026-10-09'
    const n = trainingsRecordedBy(db, 'wvpp', 'train', t)
    // The founder and the 11 on-site staff; the remote employee is outside SB 553.
    expect(n).toBe(12)
    expect(trainingsRecordedBy(db, 'wvpp', 'write-plan', t)).toBe(0)
    expect(trainingsRecordedBy(db, 'iipp', 'train', t)).toBe(0)
    const before = db.trainings.length
    db = produce(db, (d) => setRuleActionDone(d, 'wvpp', 'train', t))
    expect(db.trainings.filter((x) => x.kind === 'wvpp' && x.completedOn === t)).toHaveLength(n)
    expect(db.trainings.length - before).toBe(n)
    // Everyone is trained now, so ticking again would record nothing.
    expect(trainingsRecordedBy(db, 'wvpp', 'train', t)).toBe(0)
  })

  it('fills an open training row or adds one', () => {
    let db = makeDB()
    addPerson(db, { id: 'p-a', firstName: 'Aisha', lastName: 'Bello', startDate: '2026-09-08' })
    db.trainings.push({ id: 't-open', personId: 'p-a', kind: 'security_awareness', dueOn: '2026-10-08' })
    db = produce(db, (d) => recordTrainingCompletion(d, 'p-a', 'security_awareness', '2026-10-09', { certificateLink: 'https://lms.test/a' }))
    expect(db.trainings).toHaveLength(1)
    expect(db.trainings[0]).toMatchObject({ completedOn: '2026-10-09', certificateLink: 'https://lms.test/a' })
    expect(lastText(db)).toBe('Aisha Bello completed security awareness on Oct 9, 2026')
    db = produce(db, (d) => recordTrainingCompletion(d, 'p-a', 'harassment_employee', '2026-10-10'))
    expect(db.trainings).toHaveLength(2)
    expect(db.trainings[1]).toMatchObject({ kind: 'harassment_employee', dueOn: '2026-10-10', completedOn: '2026-10-10' })
  })

  it('ticks recurring items and the SOC 2 access review', () => {
    let db = makeDB()
    db.recurring.push(
      { id: 'r-ar', title: 'Quarterly access review (SOC 2)', cadence: 'quarterly', nextDueOn: '2026-10-31', ruleId: 'soc2-access-review' },
      { id: 'r-once', title: 'Write the WVPP', cadence: 'once', nextDueOn: '2026-11-15' },
      { id: 'r-annual', title: 'Review the handbook', cadence: 'annual', nextDueOn: '2026-09-01' },
    )
    db = produce(db, (d) => markAccessReviewDone(d, '2026-Q4', '2026-10-20'))
    expect(db.complianceStatus['soc2-access-review'].actionsDone).toEqual({ '2026-Q4': '2026-10-20' })
    expect(db.recurring[0]).toMatchObject({ lastDoneOn: '2026-10-20', nextDueOn: '2027-01-31' })
    expect(lastText(db)).toBe('Recorded the Q4 2026 access review (SOC 2), done Oct 20, 2026')
    db = produce(db, (d) => completeRecurringItem(d, 'r-once', '2026-11-01'))
    expect(db.recurring[1]).toMatchObject({ lastDoneOn: '2026-11-01', nextDueOn: '2026-11-15' })
    db = produce(db, (d) => completeRecurringItem(d, 'r-annual', '2026-10-01'))
    expect(db.recurring[2]).toMatchObject({ lastDoneOn: '2026-10-01', nextDueOn: '2027-09-01' })
  })

  it("keeps each quarter's access review evidence when the review is ticked as a recurring item", () => {
    let db = makeDB()
    db.company.soc2Enabled = true
    db.recurring.push({ id: 'r-ar', title: 'Quarterly access review (SOC 2)', cadence: 'quarterly', nextDueOn: '2026-07-31', ruleId: 'soc2-access-review' })
    db = produce(db, (d) => completeRecurringItem(d, 'r-ar', '2026-07-20'))
    db = produce(db, (d) => completeRecurringItem(d, 'r-ar', '2026-10-20'))
    expect(db.complianceStatus['soc2-access-review'].actionsDone).toEqual({ '2026-Q3': '2026-07-20', '2026-Q4': '2026-10-20' })
    expect(db.recurring[0]).toMatchObject({ lastDoneOn: '2026-10-20', nextDueOn: '2027-01-31' })
    const rows = soc2Evidence(db, '2026-08-01', '2027-01-31').controls.find((c) => c.id === 'access-review')?.rows ?? []
    expect(rows.map((r) => [r.label, r.ok, r.pending ?? false])).toEqual([
      ['Q3 2026', true, false],
      ['Q4 2026', true, false],
      ['Q1 2027', false, true],
    ])
  })
})

describe('anonymizeCandidate', () => {
  it('removes identifiers from the candidate, applications, scorecards and activity text', () => {
    let db = makeDB()
    db.candidates.push({
      id: 'c-1',
      firstName: 'Priya',
      lastName: 'Nair',
      email: 'priya@x.dev',
      phone: '555',
      links: { linkedin: 'https://linkedin.test/priya' },
      location: 'Sunnyvale, CA',
      currentCompany: 'Big Co',
      source: 'inbound',
      sponsorship: 'no',
      tags: ['keep warm'],
      desiredPay: 200000,
      desiredPayUnit: 'year',
      summary: 'Strong',
      createdOn: '2021-01-04',
    })
    db.applications.push({ id: 'a-1', candidateId: 'c-1', jobId: 'j-1', stageId: 'onsite', status: 'rejected', appliedOn: '2021-01-04', stageEnteredOn: '2021-01-20', history: [], closedOn: '2021-02-01', outcomeNote: 'Close call' })
    db.scorecards.push({ id: 's-1', interviewId: 'i-1', applicationId: 'a-1', interviewerId: 'p-founder', dueAt: '2021-01-21T00:00:00Z', ratings: {}, notes: 'Great at evals' })
    db.activity.push({ id: 'act-0', at: '2021-01-20T00:00:00Z', entityType: 'application', entityId: 'a-1', relatedId: 'c-1', kind: 'stage_moved', text: 'Moved Priya Nair to Onsite' })
    db = produce(db, (d) => anonymizeCandidate(d, 'c-1', '2026-10-09'))
    const c = db.candidates[0]
    expect(c).toMatchObject({ firstName: 'Former', lastName: 'applicant', email: '', links: {}, tags: [], archived: true, anonymizedOn: '2026-10-09' })
    expect(c.phone).toBeUndefined()
    expect(c.desiredPay).toBeUndefined()
    expect(c).not.toHaveProperty('desiredPayUnit')
    expect(c.location).toBeUndefined()
    expect(db.applications[0].outcomeNote).toBeUndefined()
    expect(db.applications[0].closedOn).toBe('2021-02-01')
    expect(db.scorecards[0].notes).toBeUndefined()
    expect(db.activity[0].text).toBe('Moved Former applicant to Onsite')
    expect(lastText(db)).toBe('Anonymized an applicant record past its 4-year retention date')
    const again = produce(db, (d) => anonymizeCandidate(d, 'c-1', '2026-10-10'))
    expect(again).toBe(db)
  })

  it('leaves a candidate inside the 4-year retention period, or with an open application, untouched', () => {
    const db = makeDB()
    const cand = (id: string) =>
      db.candidates.push({ id, firstName: 'Diego', lastName: id, email: `${id}@x.dev`, links: {}, source: 'inbound', sponsorship: 'no', tags: [], createdOn: '2021-01-04' })
    cand('c-recent')
    db.applications.push({ id: 'a-recent', candidateId: 'c-recent', jobId: 'j-1', stageId: 'new', status: 'rejected', appliedOn: '2026-08-01', stageEnteredOn: '2026-08-01', history: [], closedOn: '2026-09-01' })
    cand('c-open')
    db.applications.push({ id: 'a-open', candidateId: 'c-open', jobId: 'j-1', stageId: 'new', status: 'active', appliedOn: '2021-01-04', stageEnteredOn: '2021-01-04', history: [] })
    expect(produce(db, (d) => anonymizeCandidate(d, 'c-recent', '2026-10-09'))).toBe(db)
    expect(produce(db, (d) => anonymizeCandidate(d, 'c-open', '2026-10-09'))).toBe(db)
  })
})
