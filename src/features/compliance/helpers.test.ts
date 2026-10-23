import { describe, expect, it } from 'vitest'
import { type CalendarItem, evaluateAll, evaluateRule, nextThreshold, RULE_BY_ID } from '@/domain/compliance'
import { addMany, addPerson, ledgerlarkLite, makeDB } from '@/domain/compliance/testkit'
import type { Policy } from '@/domain/types'
import {
  acksOwed,
  applicantRecordStats,
  ackReminderText,
  bucketCalendar,
  calendarDoneAction,
  cycleLine,
  followUpDueText,
  followUpPeople,
  futureCrossingText,
  groupResults,
  impactHeadline,
  needsAction,
  nextVersions,
  normVersion,
  policyVersions,
  postingBlock,
  recordsRequestDueOn,
  recordsRequestState,
  ruleGroupOf,
  ruleOwnDue,
  rulerX,
  RULER_MAIN,
  sameVersion,
  stateChip,
  statusLine,
  thresholdImpact,
  thresholdLead,
  trainingCell,
  trainingTodo,
  twentyWeekPaceText,
  whyText,
} from './helpers'

const D = '2026-10-09'

describe('rule cards', () => {
  it('labels states with a word and a tone', () => {
    const db = ledgerlarkLite()
    const pay = evaluateRule(db, RULE_BY_ID['pay-scale-in-postings'], D)
    expect(pay.state).toBe('approaching')
    expect(stateChip(pay)).toEqual({ label: 'Approaching (Oct 19)', tone: 'warn' })
    expect(needsAction(pay)).toBe(true)
    const wvpp = evaluateRule(db, RULE_BY_ID.wvpp, D)
    expect(wvpp.state).toBe('applies')
    expect(stateChip(wvpp).label).toBe('Applies')
    expect(stateChip(wvpp).tone).toBe('warn')
  })

  it('groups by threshold and event, with cards that need action first', () => {
    const db = ledgerlarkLite()
    const groups = groupResults(evaluateAll(db, D))
    expect(groups.map((g) => g.key)).toEqual(['any', 'events', 't5', 't10', 't15', 't20', 'upcoming'])
    const t15 = groups.find((g) => g.key === 't15')
    expect(t15?.results[0] && needsAction(t15.results[0])).toBe(true)
    expect(ruleGroupOf(RULE_BY_ID['harassment-training'])).toBe('t5')
    expect(ruleGroupOf(RULE_BY_ID.wvpp)).toBe('t10')
    expect(ruleGroupOf(RULE_BY_ID['first-contractor'])).toBe('events')
    expect(ruleGroupOf(RULE_BY_ID['cal-warn'])).toBe('upcoming')
    expect(ruleGroupOf(RULE_BY_ID['salary-history-ban'])).toBe('any')
  })

  it('writes status lines and why text in plain words', () => {
    const db = ledgerlarkLite()
    const pay = evaluateRule(db, RULE_BY_ID['pay-scale-in-postings'], D)
    expect(statusLine(pay)).toBe('Projected to apply on Oct 19, 2026.')
    expect(whyText(pay)).toBe('It starts at 15 employees. You have 14 now and reach 15 on Oct 19, 2026.')
    const fed = evaluateRule(db, RULE_BY_ID['title-vii-ada-gina-pwfa'], D)
    expect(statusLine(fed)).toBe('Week 0 of 20 this year.')
    expect(whyText(fed)).toMatch(
      /0 of 20 this year, 0 last year\. At this pace you would reach week 20 around (early|mid|late) May 2027, and coverage then reaches back to Jan 1, 2027, so plan as covered for all of 2027\./,
    )
    const always = evaluateRule(db, RULE_BY_ID['salary-history-ban'], D)
    expect(whyText(always)).toMatch(/every California employer/)
    for (const r of evaluateAll(db, D)) {
      expect(statusLine(r)).not.toMatch(/[—–]/)
      expect(whyText(r)).not.toMatch(/[—–]/)
    }
  })

  it('counts overdue per-person deadlines under a rule as needing action', () => {
    const db = ledgerlarkLite()
    // Every setup step is done, so only the people with overdue harassment training keep the card open.
    db.complianceStatus['harassment-training'] = { actionsDone: { assign: '2025-09-02', 'crd-course': '2025-09-02', certificates: '2025-11-18' } }
    const r = evaluateRule(db, RULE_BY_ID['harassment-training'], D)
    expect(r.state).toBe('applies')
    expect(r.openActions).toEqual([])
    expect(r.followUps?.map((f) => f.personId)).toEqual(['p-founder', 'p-tomas', 'p-kofi', 'p-sofia', 'p-priya', 'p-hannah'])
    expect(needsAction(r)).toBe(true)
    expect(stateChip(r)).toEqual({ label: 'Overdue', tone: 'bad' })
    expect(followUpPeople(r)).toBe(6)
    expect(statusLine(r)).toBe('Applies since Aug 18, 2025. 3 of 3 done; overdue for 6 people since Feb 18, 2026.')
    // The rule's due date only comes from the oldest follow-up, which the list shows with its person.
    expect(r.dueOn).toBe('2026-02-18')
    expect(ruleOwnDue(r)).toBeNull()
    const hannah = r.followUps?.find((f) => f.personId === 'p-hannah')
    expect(hannah?.title).toBe('Hannah Kim: harassment prevention (1 hour)')
    expect(hannah && followUpDueText(hannah, D)).toBe('Was due Sep 16, 2026 (23 days ago).')
    expect(evaluateAll(db, D).filter(needsAction).map((x) => x.rule.id)).toContain('harassment-training')
  })

  it('keeps a recorded deadline as the rule due date even when a follow-up is older', () => {
    const db = ledgerlarkLite()
    db.complianceStatus['harassment-training'] = { actionsDone: {}, dueOn: '2026-12-01' }
    const r = evaluateRule(db, RULE_BY_ID['harassment-training'], D)
    expect(r.dueOn).toBe('2026-02-18')
    expect(ruleOwnDue(r)).toEqual({ on: '2026-12-01', recorded: true })
    const none = evaluateRule(ledgerlarkLite(), RULE_BY_ID['pay-scale-in-postings'], D)
    expect(none.followUps).toBeUndefined()
    expect(stateChip(none).tone).toBe('warn')
  })

  it('words the 20-week projection as coverage for the whole year', () => {
    expect(twentyWeekPaceText('2027-05-24', true)).toBe(
      'At this pace you would reach week 20 around late May 2027, and coverage then reaches back to Jan 1, 2027, so plan as covered for all of 2027.',
    )
    expect(twentyWeekPaceText('2027-05-04', false)).toContain('around early May 2027 if offers are accepted, and coverage')
  })

  it('describes a yearly cycle', () => {
    const db = ledgerlarkLite()
    db.complianceStatus['sb294-annual-notice'] = { actionsDone: { 'year-2026': '2026-01-30' } }
    const r = evaluateRule(db, RULE_BY_ID['sb294-annual-notice'], D)
    expect(cycleLine(r)).toBe('Next due Feb 1, 2027; last done Jan 30, 2026.')
  })

  it('says a yearly employee notice waits for someone other than an unpaid owner', () => {
    const db = makeDB('2026-01-01')
    const r = evaluateRule(db, RULE_BY_ID['sb294-annual-notice'], D)
    expect(statusLine(r)).toBe('Nothing is due yet: it starts once someone other than an unpaid owner works here.')
    expect(cycleLine(r)).toBe('Due each Feb 1 once someone other than an unpaid owner works here.')
    expect(needsAction(r)).toBe(false)
    // It applies from the first paid hire, not from the founding date.
    addPerson(db, { id: 'p-first', startDate: '2026-11-02' })
    const hired = evaluateRule(db, RULE_BY_ID['sb294-annual-notice'], '2026-11-02')
    expect(statusLine(hired)).toBe('Applies since Nov 2, 2026. 0 of 2 done.')
    expect(cycleLine(hired)).toBe('Next due Feb 1, 2027.')
  })

  it('says a law that covers contracts from a later date is preparation, not in force since founding', () => {
    const db = ledgerlarkLite()
    const r = evaluateRule(db, RULE_BY_ID['stay-or-pay-ban'], D)
    expect(statusLine(r)).toBe('Applies to contracts from Jan 1, 2027: prepare now. 0 of 2 done.')
    expect(whyText(r)).toBe('This covers every California employer, whatever the size, for contracts entered on or after Jan 1, 2027. Get ready before then.')
    expect(statusLine(evaluateRule(db, RULE_BY_ID['stay-or-pay-ban'], '2027-01-04'))).toBe('Applies since Jan 1, 2027. 0 of 2 done.')
  })

  it('writes an estimated DE 1 due date as about, until the first payroll date is saved', () => {
    const db = ledgerlarkLite()
    const est = evaluateRule(db, RULE_BY_ID['edd-registration'], D)
    expect(statusLine(est)).toBe('Applies since May 12, 2025; due about May 27, 2025. 0 of 2 done.')
    db.company.firstPayrollOn = '2025-05-15'
    expect(statusLine(evaluateRule(db, RULE_BY_ID['edd-registration'], D))).toBe('Applies since May 15, 2025; due May 30, 2025. 0 of 2 done.')
  })
})

describe('next threshold lead', () => {
  it('names what changes at 15 and notes the ranges', () => {
    const db = ledgerlarkLite()
    const nt = nextThreshold(db, D)
    expect(nt?.n).toBe(15)
    if (!nt) return
    expect(thresholdLead(nt, db)).toBe(
      'At 15 employees, California requires a pay range on every job post (your open jobs already show one) and paid organ and bone marrow donor leave.',
    )
    db.jobs.push({ ...(db.jobs[0] ?? {}), id: 'j-x', status: 'open', payMin: null, payMax: null } as (typeof db.jobs)[number])
    expect(thresholdLead(nt, db)).toContain('(1 open job has no range yet)')
  })
})

describe('posting block', () => {
  it('reads on with the posting sheet count while the legal rule is still approaching', () => {
    const db = ledgerlarkLite()
    const pay = evaluateRule(db, RULE_BY_ID['pay-scale-in-postings'], D)
    expect(pay.state).toBe('approaching')
    const block = postingBlock(db, D)
    expect(block.on).toBe(true)
    expect(block.total).toBeGreaterThanOrEqual(15)
    expect(block.incoming).toBeGreaterThan(0)
    expect(block.line).toBe(
      `Job posts already need a pay range: counting people starting soon and accepted offers, you have ${block.total}, and the posting block starts at 15.`,
    )
    expect(block.howCounted).toContain(`${block.total} in total. At 15, a job cannot be marked posted without a pay range.`)
  })

  it('reads off below 15 and says nothing extra', () => {
    const db = makeDB('2025-01-06')
    addMany(db, 5, '2025-03-03')
    const block = postingBlock(db, D)
    expect(block).toMatchObject({ on: false, total: 6, incoming: 0, line: null })
    expect(block.howCounted).toBe('The posting block counts 6 employees: 6 in total. At 15, a job cannot be marked posted without a pay range.')
  })
})

describe('ruler scale', () => {
  it('is linear to 20 and compressed to 100', () => {
    expect(rulerX(0)).toBe(0)
    expect(rulerX(10)).toBeCloseTo(RULER_MAIN / 2)
    expect(rulerX(20)).toBeCloseTo(RULER_MAIN)
    expect(rulerX(100)).toBeCloseTo(1)
    expect(rulerX(250)).toBeCloseTo(1)
    const xs = [1, 5, 15, 20, 25, 36, 50, 75, 100].map(rulerX)
    expect([...xs].sort((a, b) => a - b)).toEqual(xs)
  })
})

describe('hire threshold preview', () => {
  it('lists what changes when a hire takes the company to 15', () => {
    const db = makeDB('2025-01-06')
    addMany(db, 13, '2025-03-03')
    const impact = thresholdImpact(db, '2026-11-02')
    expect(impact.before).toBe(14)
    expect(impact.after).toBe(15)
    expect(impact.crossed).toEqual([15])
    expect(impact.rules.map((r) => r.id).sort()).toEqual(['organ-bone-marrow-leave', 'pay-scale-in-postings'])
    expect(impact.counters.map((c) => c.id)).toEqual(['title-vii-ada-gina-pwfa'])
    expect(impactHeadline(impact)).toBe('This hire takes you to 15: 2 things change.')
  })

  it('returns nothing when no threshold is crossed', () => {
    const db = makeDB('2025-01-06')
    addMany(db, 6, '2025-03-03')
    const impact = thresholdImpact(db, '2026-11-02')
    expect(impact.crossed).toEqual([])
    expect(impact.rules).toEqual([])
    expect(impactHeadline(impact)).toBeNull()
  })

  it('counts several hires together and ignores people who leave before the start', () => {
    const db = makeDB('2025-01-06')
    addMany(db, 2, '2025-03-03')
    addPerson(db, { id: 'p-gone', startDate: '2025-03-03', endDate: '2026-01-30' })
    const impact = thresholdImpact(db, '2026-11-02', 2)
    expect(impact.before).toBe(3)
    expect(impact.after).toBe(5)
    expect(impact.crossed).toEqual([5])
    expect(impact.rules.map((r) => r.id)).toContain('feha')
    expect(impactHeadline(impact, 2)).toMatch(/^These 2 hires take you to 5: \d+ things change\.$/)
  })
})

describe('milestone story', () => {
  it('tells future crossings in the future tense', () => {
    const db = ledgerlarkLite()
    expect(futureCrossingText(db, { n: 15, date: '2026-10-19', direction: 'up', personId: 'p-lucas' })).toBe(
      'On track to cross 15 on Oct 19, 2026 when Lucas Ferreira starts.',
    )
  })
})

describe('calendar', () => {
  const item = (p: Partial<CalendarItem> & { id: string; date: string }): CalendarItem => ({ title: 'x', kind: 'recurring', statutory: false, ...p })

  it('knows how to mark each kind of item done', () => {
    const db = ledgerlarkLite()
    db.recurring.push({ id: 'rec-sb294', title: 'SB 294', cadence: 'annual', nextDueOn: '2027-02-01', ruleId: 'sb294-annual-notice' })
    db.recurring.push({ id: 'rec-x', title: 'Other', cadence: 'quarterly', nextDueOn: '2026-10-31' })
    expect(calendarDoneAction(db, item({ id: 'rec-rec-sb294-2027-02-01', date: '2027-02-01' }))).toEqual({
      kind: 'recurring',
      recurringId: 'rec-sb294',
      ruleId: 'sb294-annual-notice',
      year: 2027,
    })
    expect(calendarDoneAction(db, item({ id: 'rec-rec-x-2026-10-31', date: '2026-10-31' }))).toEqual({ kind: 'recurring', recurringId: 'rec-x' })
    // Only the current occurrence of a recurring item can be ticked.
    expect(calendarDoneAction(db, item({ id: 'rec-rec-x-2027-01-31', date: '2027-01-31' }))).toBeNull()
    expect(
      calendarDoneAction(db, item({ id: 'tr-p-aisha-security_awareness-2026-10-08', date: '2026-10-08', kind: 'training', personId: 'p-aisha' })),
    ).toEqual({ kind: 'training', personId: 'p-aisha', trainingKind: 'security_awareness' })
    expect(
      calendarDoneAction(db, item({ id: 'tr-p-hannah-harassment_employee-2026-09-16', date: '2026-09-16', kind: 'training', personId: 'p-hannah' })),
    ).toEqual({ kind: 'training', personId: 'p-hannah', trainingKind: 'harassment_employee' })
    expect(calendarDoneAction(db, item({ id: '1099-2027', date: '2027-02-01', kind: 'form_1099' }))).toEqual({ kind: 'annual', ruleId: 'first-contractor', year: 2027 })
    expect(calendarDoneAction(db, item({ id: 'soc2-access-review-2026-Q4', date: '2026-12-31', kind: 'soc2_access_review' }))).toEqual({
      kind: 'access_review',
      quarter: '2026-Q4',
    })
    expect(calendarDoneAction(db, item({ id: 'leave-notice-lv-1', date: '2026-10-13', kind: 'leave_notice' }))).toEqual({ kind: 'leave_notice', leaveId: 'lv-1' })
    expect(calendarDoneAction(db, item({ id: 'contract-end-k-1-2026-12-31', date: '2026-12-31', kind: 'contract_end' }))).toBeNull()
    expect(calendarDoneAction(db, item({ id: 'rec-rec-x-2026-10-31', date: '2026-10-31', done: true }))).toBeNull()
  })

  it('puts overdue items first, statutory before the rest, then months', () => {
    const items = [
      item({ id: 'a', date: '2026-09-20' }),
      item({ id: 'b', date: '2026-09-16', statutory: true }),
      item({ id: 'c', date: '2026-10-31' }),
      item({ id: 'd', date: '2026-11-18' }),
      item({ id: 'e', date: '2026-10-01', done: true }),
      item({ id: 'f', date: '2026-10-09' }),
      item({ id: 'g', date: '2026-02-28', kind: 'contract_end' }),
      item({ id: 'h', date: '2026-10-02', kind: 'contract_end' }),
    ]
    const b = bucketCalendar(items, D)
    expect(b.overdue.map((i) => i.id)).toEqual(['b', 'a'])
    expect(b.months.map((m) => [m.month, m.items.map((i) => i.id)])).toEqual([
      ['2026-10', ['f', 'c']],
      ['2026-11', ['d']],
    ])
    expect(b.recentlyDone.map((i) => i.id)).toEqual(['h', 'e'])
  })
})

describe('policies', () => {
  const handbook: Policy = { id: 'pl-handbook', title: 'Employee handbook', version: '2.0', effectiveOn: '2026-09-15', summary: '', requiresAck: true }

  it('compares and suggests versions', () => {
    expect(normVersion('v2.00')).toBe('2')
    expect(sameVersion('2', '2.0')).toBe(true)
    expect(sameVersion('2.1', '2.0')).toBe(false)
    expect(nextVersions('2.0')).toEqual(['2.1', '3.0'])
    expect(nextVersions('v1')).toEqual(['1.1', '2.0'])
  })

  it('lists versions newest first with their acknowledgements', () => {
    const acks = [
      { id: 'a1', policyId: 'pl-handbook', version: '1.0', personId: 'p-1', acknowledgedOn: '2025-05-01' },
      { id: 'a2', policyId: 'pl-handbook', version: '2', personId: 'p-1', acknowledgedOn: '2026-09-16' },
      { id: 'a3', policyId: 'pl-other', version: '1.0', personId: 'p-1', acknowledgedOn: '2025-05-01' },
    ]
    const v = policyVersions({ ...handbook, history: [{ version: '1.0', effectiveOn: '2025-05-01' }] }, acks)
    expect(v.map((x) => [x.version, x.current, x.acks.length, x.effectiveOn])).toEqual([
      ['2.0', true, 1, '2026-09-15'],
      ['1.0', false, 1, '2025-05-01'],
    ])
  })

  it('finds who still owes an acknowledgement and writes the reminder', () => {
    const db = ledgerlarkLite()
    db.policies = [handbook]
    for (const p of db.people) {
      if (['p-ravi', 'p-aisha', 'p-caleb', 'p-omar'].includes(p.id)) continue
      db.acks.push({ id: `ack-${p.id}`, policyId: 'pl-handbook', version: '2.0', personId: p.id, acknowledgedOn: '2026-09-16' })
    }
    const owed = acksOwed(db, handbook, D)
    expect(owed.map((o) => o.person.id).sort()).toEqual(['p-aisha', 'p-caleb', 'p-ravi'])
    expect(owed.every((o) => o.dueOn === '2026-10-15' && !o.overdue)).toBe(true)
    const text = ackReminderText({ ...handbook, link: 'https://example.com/handbook' }, owed, 'Maya')
    expect(text).toContain('Please read and acknowledge the Employee handbook 2.0 (effective Sep 15, 2026) by Oct 15, 2026.')
    expect(text).toContain('https://example.com/handbook')
    expect(acksOwed(db, { ...handbook, requiresAck: false }, D)).toEqual([])
  })
})

describe('records requests', () => {
  it('sets statutory clocks and reads their state', () => {
    expect(recordsRequestDueOn('personnel_file', '2026-10-01')).toBe('2026-10-31')
    expect(recordsRequestDueOn('payroll_records', '2026-10-01')).toBe('2026-10-22')
    expect(recordsRequestDueOn('signed_documents', '2026-10-01')).toBe('2026-10-08')
    const req = { id: 'r1', personId: 'p-1', type: 'payroll_records' as const, receivedOn: '2026-09-10', dueOn: '2026-10-01' }
    expect(recordsRequestState(req, D)).toEqual({ label: 'Overdue by 8 days', tone: 'bad', daysLeft: -8 })
    expect(recordsRequestState({ ...req, dueOn: '2026-10-12' }, D).label).toBe('3 days left')
    expect(recordsRequestState({ ...req, fulfilledOn: '2026-09-30' }, D)).toEqual({ label: 'Fulfilled Sep 30', tone: 'good' })
    expect(recordsRequestState({ ...req, type: 'signed_documents', dueOn: '2026-10-08' }, D).tone).toBe('warn')
  })
})

describe('training cells', () => {
  const base = { kind: 'harassment_employee' as const, course: 'harassment' as const, title: 'x', required: true, recommended: false, reason: '' }
  it('uses a word and a tone; only legal courses turn red', () => {
    expect(trainingCell({ ...base, status: 'overdue', dueOn: '2026-09-16' })).toEqual({ label: 'Overdue', tone: 'bad', detail: 'Was due Sep 16' })
    expect(trainingCell({ ...base, kind: 'security_awareness', course: 'security_awareness', status: 'overdue', dueOn: '2026-10-08' }).tone).toBe('warn')
    expect(trainingCell({ ...base, status: 'done', completedOn: '2026-05-11', nextDueOn: '2028-05-11', dueOn: '2028-05-11' })).toEqual({
      label: 'Done',
      tone: 'good',
      detail: 'Next by May 11',
    })
    expect(trainingCell({ ...base, kind: 'wvpp', course: 'wvpp', status: 'due' }).label).toBe('Waiting on plan')
    // The first WVPP round has a company target only (no statutory day count); a missed yearly refresher is a legal deadline.
    expect(trainingCell({ ...base, kind: 'wvpp', course: 'wvpp', status: 'overdue', dueOn: '2026-09-30' })).toEqual({
      label: 'Past target',
      tone: 'warn',
      detail: 'Target was Sep 30',
    })
    expect(trainingCell({ ...base, kind: 'wvpp', course: 'wvpp', status: 'overdue', dueOn: '2026-09-30', completedOn: '2025-09-30' }).tone).toBe('bad')
    expect(trainingCell({ ...base, required: false, recommended: true, status: 'not_required', dueOn: '2026-09-02' }).label).toBe('Recommended')
    expect(trainingCell({ ...base, required: false, recommended: false, status: 'not_required' }).label).toBe('Not required')
  })

  it('lists what needs a tap now, overdue first', () => {
    const cells = [
      { id: 'a', row: { ...base, status: 'due' as const, dueOn: '2026-10-20' } },
      { id: 'b', row: { ...base, status: 'overdue' as const, dueOn: '2026-09-16' } },
      { id: 'c', row: { ...base, course: 'wvpp' as const, kind: 'wvpp' as const, status: 'due' as const } },
      { id: 'd', row: { ...base, required: false, status: 'overdue' as const, dueOn: '2026-09-01' } },
    ]
    expect(trainingTodo(cells).map((c) => c.id)).toEqual(['b', 'a'])
  })
})

describe('applicant records', () => {
  it('counts records by retention state and finds the next one to expire', () => {
    const db = makeDB('2025-01-06')
    const cand = (id: string, createdOn: string, extra = {}) =>
      db.candidates.push({ id, firstName: id, lastName: 'C', email: '', links: {}, source: 'inbound', sponsorship: 'no', tags: [], createdOn, ...extra })
    cand('c-old', '2020-01-10')
    cand('c-new', '2026-01-10')
    cand('c-gone', '2020-01-10', { anonymizedOn: '2025-02-01' })
    const s = applicantRecordStats(db, D)
    expect(s).toMatchObject({ total: 3, retained: 1, eligible: 1, anonymized: 1, inProcess: 0 })
    expect(s.next).toEqual({ candidateId: 'c-new', name: 'c-new C', retainUntil: '2030-01-10' })
  })
})

describe('training cell dates', () => {
  it('adds the year only for dates in another year', () => {
    const row = { kind: 'harassment_employee' as const, course: 'harassment' as const, title: 'x', required: true, recommended: false, reason: '', status: 'done' as const, completedOn: '2025-11-18', nextDueOn: '2027-11-18', dueOn: '2027-11-18' }
    expect(trainingCell(row, '2026-10-09').detail).toBe('Next by Nov 18, 2027')
    expect(trainingCell({ ...row, status: 'due', nextDueOn: '2026-11-01', dueOn: '2026-11-01' }, '2026-10-09').label).toBe('Due Nov 1')
  })
})
