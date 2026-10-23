import { produce } from 'immer'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import { RULES } from '@/domain/compliance'
import { addContractor, addMany, addOffer, addPerson, makeDB } from '@/domain/compliance/testkit'
import type { Checklist, ChecklistTask, DB, Job, Viewer } from '@/domain/types'
import { setClockOverride } from '@/lib/dates'
import { welcomeEmail } from '@/domain/people'
import { generateChecklist } from '@/domain/checklists/generate'
import {
  ab5Result,
  applyInboxOp,
  canDismiss,
  candidatesTitle,
  dayText,
  dismissItem,
  filterItems,
  firstHireKitShown,
  groupFor,
  type InboxItem,
  inboxItems,
  isHidden,
  isSoloWorkspace,
  KIT_RULE_IDS,
  minutesText,
  noSnoozeDetail,
  noSnoozeReason,
  rangeText,
  snoozeItem,
  snoozeOptions,
  tonightHeadline,
  tonightSummary,
  unlockEvents,
  visibleForFilter,
} from './inbox'

const FRI = '2026-10-09'
const NOW = '2026-10-09T22:00:00.000Z'

beforeAll(() => setClockOverride(FRI))
afterAll(() => setClockOverride(null))

function task(id: string, extra: Partial<ChecklistTask>): ChecklistTask {
  return {
    id,
    title: id,
    ownerRole: 'admin',
    dueOn: FRI,
    status: 'open',
    category: 'legal',
    statutory: false,
    ...extra,
  }
}

/** Founder, a manager (Tomas) with a report (Ana, recently hired) and an incoming hire (Lee). */
function fixture(): DB {
  const db = makeDB('2025-01-06')
  addPerson(db, { id: 'p-tomas', firstName: 'Tomas', lastName: 'Herrera', startDate: '2025-05-12' })
  addPerson(db, { id: 'p-ana', firstName: 'Ana', lastName: 'Lima', startDate: '2026-09-08', managerId: 'p-tomas' })
  addPerson(db, { id: 'p-lee', firstName: 'Lee', lastName: 'Park', startDate: '2026-10-19', managerId: 'p-tomas' })
  const ana: Checklist = {
    id: 'ck-ana',
    personId: 'p-ana',
    kind: 'onboarding',
    templateId: 'tpl-onboarding',
    anchorDate: '2026-09-08',
    createdOn: '2026-09-01',
    tasks: [
      task('t-de34', { templateTaskId: 'on-de34', title: 'DE 34 new hire report filed', dueOn: '2026-09-28', statutory: true }),
      task('t-sec', { templateTaskId: 'on-security-training', title: 'Security awareness training completed', ownerRole: 'employee', assigneeId: 'p-ana', dueOn: '2026-10-13', category: 'training' }),
      task('t-check', { templateTaskId: 'on-checkin-30', title: '30-day check-in', ownerRole: 'manager', assigneeId: 'p-tomas', dueOn: '2026-10-12', category: 'culture' }),
    ],
  }
  const lee: Checklist = {
    id: 'ck-lee',
    personId: 'p-lee',
    kind: 'onboarding',
    templateId: 'tpl-onboarding',
    anchorDate: '2026-10-19',
    createdOn: '2026-10-01',
    tasks: [
      task('t-laptop', { templateTaskId: 'on-laptop', title: 'Laptop ordered with MDM and disk encryption', ownerRole: 'it', dueOn: '2026-10-12', category: 'it' }),
      task('t-n1', { title: 'Notice one given', dueOn: '2026-10-19', statutory: true }),
      task('t-n2', { title: 'Notice two given', dueOn: '2026-10-19' }),
      task('t-n3', { title: 'Notice three given', dueOn: '2026-10-19' }),
      task('t-far', { title: 'Far away task', dueOn: '2026-12-01' }),
    ],
  }
  db.checklists.push(ana, lee)
  db.timeOffRequests.push({
    id: 'tr-ana',
    personId: 'p-ana',
    policyId: db.timeOffPolicies.find((p) => !p.autoApprove)?.id ?? db.timeOffPolicies[0].id,
    startDate: '2026-11-23',
    endDate: '2026-11-25',
    hours: 24,
    status: 'pending',
    requestedOn: '2026-10-05',
  })
  db.grants.push({
    id: 'g-ana',
    personId: 'p-ana',
    holderType: 'employee',
    type: 'ISO',
    shares: 12000,
    strikePrice: 1.15,
    vestingStart: '2026-09-08',
    cliffMonths: 12,
    vestingMonths: 48,
    status: 'promised',
    exercisedShares: 0,
    postTerminationExerciseDays: 90,
  })
  addContractor(db, { id: 'k-marisol', name: 'Marisol Vega', startOn: '2026-04-01', ab5: { exemption: 'none', a: false, b: false, c: true } })
  db.policies = []
  addOffer(db, { id: 'o-dan', startDate: '2026-11-09', status: 'awaiting_approval', draftedById: 'p-tomas', draftedByRole: 'manager' }, { firstName: 'Dan', lastName: 'Reyes' })
  return db
}

const admin = (db: DB): Viewer => ({ role: 'admin', person: db.people.find((p) => p.id === 'p-founder'), personId: 'p-founder' })
const manager = (db: DB): Viewer => ({ role: 'manager', person: db.people.find((p) => p.id === 'p-tomas'), personId: 'p-tomas' })
const employee = (db: DB, id = 'p-ana'): Viewer => ({ role: 'employee', person: db.people.find((p) => p.id === id), personId: id })

const byKey = (items: InboxItem[], key: string) => items.find((i) => i.key === key)

describe('groups, snoozes and the Tonight header', () => {
  it('groups by due date', () => {
    expect(groupFor('2026-10-08', FRI)).toBe('overdue')
    expect(groupFor(FRI, FRI)).toBe('this_week')
    expect(groupFor('2026-10-16', FRI)).toBe('this_week')
    expect(groupFor('2026-10-17', FRI)).toBe('coming_up')
    expect(groupFor(undefined, FRI)).toBe('this_week')
  })

  it('offers 1 day, 3 days and 1 week, capped at the due date for statutory items', () => {
    expect(snoozeOptions({ statutory: false, dueOn: '2026-10-10', group: 'this_week' }, FRI).map((o) => o.until)).toEqual([
      '2026-10-10',
      '2026-10-12',
      '2026-10-16',
    ])
    const capped = snoozeOptions({ statutory: true, dueOn: '2026-10-11', group: 'this_week' }, FRI)
    expect(capped.map((o) => o.until)).toEqual(['2026-10-10', '2026-10-11'])
    expect(capped[1]).toMatchObject({ capped: true, label: 'Until the due date' })
    expect(snoozeOptions({ statutory: true, dueOn: FRI, group: 'this_week' }, FRI)).toEqual([])
    expect(snoozeOptions({ statutory: true, dueOn: undefined, group: 'overdue' }, FRI)).toEqual([])
  })

  it('hides snoozed and dismissed items, but legal deadlines come back on their due date', () => {
    expect(isHidden({ snoozedUntil: '2026-10-12' }, { statutory: false, dueOn: '2026-10-20', group: 'coming_up' }, FRI)).toBe(true)
    expect(isHidden({ snoozedUntil: '2026-10-12' }, { statutory: false, dueOn: '2026-10-20', group: 'coming_up' }, '2026-10-12')).toBe(false)
    expect(isHidden({ snoozedUntil: '2026-10-20' }, { statutory: true, dueOn: FRI, group: 'this_week' }, FRI)).toBe(false)
    expect(isHidden({ dismissedOn: FRI }, { statutory: false, group: 'this_week' }, FRI)).toBe(true)
    expect(isHidden({ dismissedOn: FRI }, { statutory: true, group: 'this_week' }, FRI)).toBe(false)
  })

  it('stores snoozes and dismissals by key', () => {
    const db = blankDB({ companyName: 'X', founderFirstName: 'A', founderLastName: 'B', foundedOn: '2026-01-05' })
    const next = produce(db, (d) => {
      snoozeItem(d, 'k1', '2026-10-12')
      dismissItem(d, 'k2', FRI)
    })
    expect(next.inboxState).toEqual({ k1: { snoozedUntil: '2026-10-12' }, k2: { dismissedOn: FRI } })
  })

  it('sums tonight from overdue and this week items, rounded to 5 minutes', () => {
    const mk = (group: InboxItem['group'], minutes: number) => ({ group, minutes }) as InboxItem
    expect(tonightSummary([mk('overdue', 3), mk('this_week', 5), mk('coming_up', 30)])).toEqual({ count: 2, minutes: 8 })
    expect(tonightSummary([mk('overdue', 12), mk('this_week', 11)])).toEqual({ count: 2, minutes: 25 })
    expect(tonightHeadline(FRI, { count: 13, minutes: 25 })).toBe('Friday, Oct 9: 13 things, about 25 minutes')
    expect(tonightHeadline(FRI, { count: 1, minutes: 1 })).toBe('Friday, Oct 9: 1 thing, about 1 minute')
    expect(tonightHeadline(FRI, { count: 0, minutes: 0 })).toBe('Friday, Oct 9: nothing needs you tonight')
    expect(minutesText(90)).toBe('1.5 hours')
  })
})

describe('helpers', () => {
  it('reads the AB5 result', () => {
    expect(ab5Result({ kind: 'contractor', ab5: { exemption: 'none', a: false, b: true, c: true } })).toBe('likely_employee')
    expect(ab5Result({ kind: 'contractor', ab5: { exemption: 'none', a: true, b: null, c: true } })).toBe('review')
    expect(ab5Result({ kind: 'contractor', ab5: { exemption: 'b2b', a: false, b: false, c: false } })).toBe('likely_ok')
    expect(ab5Result({ kind: 'advisor', ab5: { exemption: 'none', a: false, b: false, c: false } })).toBe('likely_ok')
  })

  it('writes date ranges and candidate group titles', () => {
    expect(rangeText('2026-11-23', '2026-11-25')).toBe('Nov 23-25')
    expect(rangeText('2026-10-30', '2026-10-30')).toBe('Oct 30')
    expect(rangeText('2026-11-30', '2026-12-02')).toBe('Nov 30 to Dec 2')
    const past = { reasons: ['past_sla' as const], stageName: 'Intro call' }
    expect(candidatesTitle('Senior full-stack', [past, past, past])).toBe('Senior full-stack: 3 candidates past SLA in Intro call')
    expect(candidatesTitle('AE', [past, { reasons: ['no_next_step' as const], stageName: 'New' }])).toBe('AE: 2 candidates need a next step')
  })
})

describe('inboxItems', () => {
  it('builds the Admin inbox with one action per item', () => {
    const db = fixture()
    const items = inboxItems(db, admin(db), FRI, { now: NOW })
    const de34 = byKey(items, 'task:ck-ana:t-de34')
    expect(de34).toMatchObject({ group: 'overdue', statutory: true, waitingOn: 'you', title: 'DE 34 for Ana Lima was due Mon Sep 28: confirm your PEO filed it' })
    expect(de34?.primary).toMatchObject({ kind: 'mutate', label: 'Mark filed' })
    // Someone else's training due this week waits on them; their manager task does not show.
    expect(byKey(items, 'task:ck-ana:t-sec')).toMatchObject({ waitingOn: 'them', waitingOnName: 'Ana' })
    expect(byKey(items, 'task:ck-ana:t-check')).toBeUndefined()
    // Pre-start tasks read as Day 1 readiness.
    expect(byKey(items, 'task:ck-lee:t-laptop')?.title).toBe('Lee starts Mon Oct 19: laptop not ordered yet')
    // Three first-day tasks collapse into one row; far-off tasks wait.
    expect(byKey(items, 'tasks:ck-lee:2026-10-19')).toMatchObject({ kind: 'task_group', statutory: true, group: 'coming_up' })
    expect(byKey(items, 'task:ck-lee:t-far')).toBeUndefined()
    expect(byKey(items, 'grants:g-ana')).toMatchObject({ kind: 'grants', primary: { kind: 'copy', label: 'Copy consent table' } })
    expect(byKey(items, 'ab5:k-marisol:likely_employee')?.title).toBe('Marisol Vega (contractor) is likely an employee under AB5')
    expect(byKey(items, 'offer-approval:o-dan:v1')?.primary).toMatchObject({ kind: 'mutate', label: 'Approve' })
    // Ana's manager approves her time off; Admin sees it only when it starts within a week.
    expect(byKey(items, 'timeoff:tr-ana')).toBeUndefined()
    // Overdue legal deadlines sort first.
    expect(items[0].statutory && items[0].group === 'overdue').toBe(true)
  })

  it('scopes the Hiring manager inbox to their own work and reports', () => {
    const db = fixture()
    const items = inboxItems(db, manager(db), FRI, { now: NOW })
    const keys = items.map((i) => i.key)
    expect(keys).toContain('task:ck-ana:t-check')
    expect(keys).toContain('timeoff:tr-ana')
    expect(keys).toContain('offer-waiting:o-dan:v1')
    expect(keys.some((k) => k.startsWith('grants') || k.startsWith('ab5') || k.startsWith('rule') || k.startsWith('task:ck-ana:t-de34'))).toBe(false)
    expect(byKey(items, 'timeoff:tr-ana')?.primary).toMatchObject({ label: 'Approve' })
  })

  it("puts sick leave held before the 90-day wait in Admin's own inbox, not the manager's", () => {
    const db = fixture()
    const sick = db.timeOffPolicies.find((p) => p.autoApprove)!
    db.timeOffRequests.push({ id: 'tr-sick', personId: 'p-ana', policyId: sick.id, startDate: '2026-11-16', endDate: '2026-11-16', hours: 8, status: 'pending', requestedOn: FRI })
    // Weeks away and Ana has a manager, yet only Admin can decide it.
    expect(byKey(inboxItems(db, admin(db), FRI, { now: NOW }), 'timeoff:tr-sick')).toMatchObject({ waitingOn: 'you', primary: { label: 'Waive the wait' } })
    expect(byKey(inboxItems(db, manager(db), FRI, { now: NOW }), 'timeoff:tr-sick')).toBeUndefined()
  })

  it('offers the same choice as the Time off tab for sick leave before the wait: waive it or record it as unpaid', () => {
    const db = fixture()
    const sick = db.timeOffPolicies.find((p) => p.autoApprove)!
    db.timeOffRequests.push({ id: 'tr-sick', personId: 'p-ana', policyId: sick.id, startDate: '2026-10-16', endDate: '2026-10-16', hours: 8, status: 'pending', requestedOn: FRI })
    const item = byKey(inboxItems(db, admin(db), FRI, { now: NOW }), 'timeoff:tr-sick')
    // Ana started Sep 8, so sick leave is usable from her 90th day, Sun Dec 6.
    expect(item?.detail).toContain('Starts before sick leave is usable (Sun Dec 6, the 90-day wait).')
    expect(item?.primary).toEqual({ kind: 'mutate', label: 'Waive the wait', op: { type: 'approve_timeoff', requestId: 'tr-sick' }, toast: "Waived the wait and approved Ana Lima's time off, Oct 16" })
    const unpaid = item?.more?.find((a) => a.label === 'Record as unpaid')
    expect(unpaid).toMatchObject({ kind: 'mutate', op: { type: 'approve_timeoff_unpaid', requestId: 'tr-sick' } })
    const next = produce(db, (d) => {
      if (unpaid?.kind !== 'mutate') throw new Error('no unpaid action')
      expect(applyInboxOp(d, unpaid.op, { date: FRI, actorId: 'p-founder' })).toEqual({ ok: true })
      expect(applyInboxOp(d, unpaid.op, { date: FRI, actorId: 'p-founder' }).ok).toBe(false)
    })
    const req = next.timeOffRequests.find((r) => r.id === 'tr-sick')
    expect(req).toMatchObject({ status: 'approved', approverId: 'p-founder' })
    expect(req?.decisionNote).toMatch(/^Recorded as unpaid/)
    // A request after the wait keeps the plain Approve, with no unpaid option.
    const later = fixture()
    later.timeOffRequests.push({ id: 'tr-vac', personId: 'p-tomas', policyId: sick.id, startDate: '2026-10-16', endDate: '2026-10-16', hours: 8, status: 'pending', requestedOn: FRI })
    const plain = byKey(inboxItems(later, admin(later), FRI, { now: NOW }), 'timeoff:tr-vac')
    expect(plain?.primary.label).toBe('Approve')
    expect(plain?.more?.some((a) => a.label === 'Record as unpaid')).toBe(false)
  })

  it('tells the drafter when Admin asks for changes to their offer, or approves it', () => {
    const db = fixture()
    const offer = db.offers.find((o) => o.id === 'o-dan')
    if (!offer) throw new Error('no offer')
    const asked = '2026-10-09T18:00:00.000Z'
    offer.status = 'draft'
    offer.approvals.push({ approverId: 'p-founder', decision: 'changes_requested', at: asked, note: '  Lower the equity.\n' })
    let items = inboxItems(db, manager(db), FRI, { now: NOW })
    expect(items.some((i) => i.kind === 'offer_waiting')).toBe(false)
    expect(byKey(items, `offer-changes:o-dan:${asked}`)).toMatchObject({
      kind: 'offer_changes',
      waitingOn: 'you',
      title: 'Fay Founder asked for changes to the offer for Dan Reyes: Lower the equity',
      primary: { kind: 'navigate', label: 'Open offer', href: '#candidate.c-o-dan' },
    })
    // The approver who asked does not get it back, and a manager with no part in the offer never sees it.
    expect(inboxItems(db, admin(db), FRI, { now: NOW }).some((i) => i.kind === 'offer_changes')).toBe(false)
    const other: Viewer = { role: 'manager', person: db.people.find((p) => p.id === 'p-ana'), personId: 'p-ana' }
    expect(inboxItems(db, other, FRI, { now: NOW }).some((i) => i.refs.offerId === 'o-dan')).toBe(false)
    // Resubmitted: back to waiting on Admin.
    offer.status = 'awaiting_approval'
    expect(inboxItems(db, manager(db), FRI, { now: NOW }).map((i) => i.kind)).toContain('offer_waiting')
    // Approved: the drafter is asked to send it.
    offer.status = 'approved'
    offer.approvals.push({ approverId: 'p-founder', decision: 'approved', at: '2026-10-09T19:00:00.000Z' })
    items = inboxItems(db, manager(db), FRI, { now: NOW })
    expect(byKey(items, 'offer-approved:o-dan:v1')).toMatchObject({
      kind: 'offer_send',
      waitingOn: 'you',
      title: 'Send the approved offer to Dan Reyes (Engineer)',
      primary: { kind: 'navigate', label: 'Open offer' },
    })
    expect(byKey(items, 'offer-approved:o-dan:v1')?.detail).toMatch(/^Fay Founder approved it Fri Oct 9\./)
    expect(items.some((i) => i.kind === 'offer_changes' || i.kind === 'offer_waiting')).toBe(false)
    expect(inboxItems(db, admin(db), FRI, { now: NOW }).some((i) => i.kind === 'offer_send')).toBe(false)
    expect(inboxItems(db, employee(db), FRI, { now: NOW }).some((i) => i.refs.offerId === 'o-dan')).toBe(false)
  })

  it('asks whoever sends an offer that needs no approval to send it once it is saved', () => {
    const db = fixture()
    const job: Job = {
      id: 'j-1',
      title: 'Engineer',
      departmentId: 'd-eng',
      familyId: 'f-swe',
      levelId: 'lv-l3',
      hiringManagerId: 'p-tomas',
      panelIds: [],
      locationIds: ['loc-hq'],
      workMode: 'hybrid',
      employmentType: 'full_time',
      flsa: 'exempt',
      payMin: 140000,
      payMax: 170000,
      status: 'open',
      stages: [{ id: 'offer', kind: 'offer', name: 'Offer' }],
      interviewPlan: [],
      description: '',
      sponsorship: 'no',
      backgroundCheck: false,
      priority: 'normal',
    }
    db.jobs.push(job)
    const eve = addOffer(db, { id: 'o-eve', startDate: '2026-11-16', status: 'draft', draftedById: 'p-founder', draftedByRole: 'admin', createdOn: '2026-10-08' }, { firstName: 'Eve', lastName: 'Stone' })
    const send = (v: Viewer) => byKey(inboxItems(db, v, FRI, { now: NOW }), 'offer-send:o-eve:v1')
    // Admin drafted it in Admin view: no approval step, so the next thing is to send it.
    expect(send(admin(db))).toMatchObject({
      kind: 'offer_send',
      title: 'Send the offer to Eve Stone (Engineer)',
      detail: 'You drafted it Thu Oct 8. Generate the letter, send it, then mark it sent on the candidate page.',
      group: 'this_week',
      statutory: false,
      waitingOn: 'you',
      primary: { kind: 'navigate', label: 'Open offer', href: '#candidate.c-o-eve' },
    })
    // The job's hiring manager sends offers too; an employee never sees it.
    expect(send(manager(db))?.detail).toMatch(/^Fay Founder drafted it Thu Oct 8\./)
    expect(send(employee(db))).toBeUndefined()
    // Marked sent, the nudge goes.
    eve.status = 'sent'
    expect(send(admin(db))).toBeUndefined()
    // A hiring manager's draft goes to Admin for approval first: nothing to send yet, for anyone.
    addOffer(db, { id: 'o-kai', startDate: '2026-11-16', status: 'draft', draftedById: 'p-tomas', draftedByRole: 'manager' }, { firstName: 'Kai', lastName: 'Moss' })
    expect(inboxItems(db, manager(db), FRI, { now: NOW }).some((i) => i.refs.offerId === 'o-kai')).toBe(false)
    expect(inboxItems(db, admin(db), FRI, { now: NOW }).some((i) => i.refs.offerId === 'o-kai')).toBe(false)
  })

  it('shows an employee only their own tasks', () => {
    const db = fixture()
    const items = inboxItems(db, employee(db), FRI, { now: NOW })
    expect(items.map((i) => i.key)).toEqual(['task:ck-ana:t-sec'])
    expect(items[0].title).toBe('Your security awareness training is due Tue Oct 13')
  })

  it('drops the AB5 item once the contractor is converted to an employee', () => {
    const db = fixture()
    const k = db.contractors.find((c) => c.id === 'k-marisol')
    if (!k) throw new Error('no contractor')
    // A link to a record that no longer exists (undone or deleted) keeps the alert.
    k.convertedToPersonId = 'p-gone'
    expect(inboxItems(db, admin(db), FRI, { now: NOW }).map((i) => i.key)).toContain('ab5:k-marisol:likely_employee')
    k.convertedToPersonId = db.people[0].id
    expect(inboxItems(db, admin(db), FRI, { now: NOW }).map((i) => i.key)).not.toContain('ab5:k-marisol:likely_employee')
  })

  it('respects snoozes and dismissals', () => {
    const db = fixture()
    db.inboxState['grants:g-ana'] = { snoozedUntil: '2026-10-12' }
    db.inboxState['ab5:k-marisol:likely_employee'] = { dismissedOn: FRI }
    db.inboxState['task:ck-ana:t-de34'] = { snoozedUntil: '2026-10-20' }
    const keys = inboxItems(db, admin(db), FRI, { now: NOW }).map((i) => i.key)
    expect(keys).not.toContain('grants:g-ana')
    expect(keys).not.toContain('ab5:k-marisol:likely_employee')
    // An overdue legal deadline cannot be snoozed away.
    expect(keys).toContain('task:ck-ana:t-de34')
    expect(inboxItems(db, admin(db), '2026-10-12', { now: '2026-10-12T22:00:00.000Z' }).map((i) => i.key)).toContain('grants:g-ana')
  })

  it('filters by waiting on you or them', () => {
    const db = fixture()
    const items = inboxItems(db, admin(db), FRI, { now: NOW })
    expect(filterItems(items, 'them').every((i) => i.waitingOn === 'them')).toBe(true)
    expect(filterItems(items, 'you').length + filterItems(items, 'them').length).toBe(items.length)
  })

  it('gives the DE 1 its file-by day when the deadline lands on a weekend or holiday', () => {
    const db = fixture()
    db.company.firstPayrollOn = '2026-11-13'
    const on = '2026-11-16'
    const de1 = inboxItems(db, admin(db), on, { now: `${on}T19:00:00.000Z` }).find((i) => i.refs.ruleId === 'edd-registration')
    expect(de1).toMatchObject({ dueOn: '2026-11-28', statutory: true, dueNote: 'Due Sat Nov 28, file by Wed Nov 25.' })
  })

  it('leaves the First hire kit rules out of a solo founder inbox', () => {
    const db = blankDB({ companyName: 'Solo', founderFirstName: 'Sam', founderLastName: 'Solo', foundedOn: '2026-09-01' })
    expect(isSoloWorkspace(db, FRI)).toBe(true)
    const items = inboxItems(db, admin(db), FRI, { now: NOW })
    expect(items.some((i) => i.refs.ruleId && KIT_RULE_IDS.includes(i.refs.ruleId))).toBe(false)
    // Rules that apply from the first employee are set-up steps, grouped in one row, never overdue crossings.
    const group = items.filter((i) => i.kind === 'rules_group')
    expect(group).toHaveLength(1)
    // The row counts only the rules it holds, and says the kit has the rest (Compliance lists them all).
    expect(group[0].title).toMatch(/^\d+ more rules that apply at any size have open steps$/)
    expect(group[0].detail).toMatch(/^Besides the \d+ in the First hire kit\. /)
    expect(items.some((i) => i.kind === 'rule' && i.group === 'overdue')).toBe(false)
    expect(isSoloWorkspace(fixture(), FRI)).toBe(false)
  })
})

describe('applyInboxOp', () => {
  const ctx = { date: FRI, actorId: 'p-founder' }

  it('marks a task done and records security training in the tracker', () => {
    const db = fixture()
    const next = produce(db, (d) => {
      expect(applyInboxOp(d, { type: 'task_status', checklistId: 'ck-ana', taskId: 't-sec', status: 'done' }, ctx)).toEqual({ ok: true })
    })
    const t = next.checklists.find((c) => c.id === 'ck-ana')?.tasks.find((x) => x.id === 't-sec')
    expect(t).toMatchObject({ status: 'done', doneOn: FRI })
    expect(next.trainings.some((x) => x.personId === 'p-ana' && x.kind === 'security_awareness' && x.completedOn === FRI)).toBe(true)
    expect(inboxItems(next, employee(next), FRI, { now: NOW })).toEqual([])
  })

  it('needs a note to mark a legal task not applicable', () => {
    const db = fixture()
    produce(db, (d) => {
      expect(applyInboxOp(d, { type: 'task_status', checklistId: 'ck-ana', taskId: 't-de34', status: 'not_applicable' }, ctx).ok).toBe(false)
      expect(applyInboxOp(d, { type: 'task_status', checklistId: 'ck-ana', taskId: 't-de34', status: 'not_applicable', note: 'PEO files it' }, ctx).ok).toBe(true)
      expect(applyInboxOp(d, { type: 'rule_not_applicable', ruleId: 'iipp', note: ' ' }, ctx).ok).toBe(false)
    })
  })

  it('approves time off and offers, and records acknowledgements', () => {
    const db = fixture()
    db.policies = [{ id: 'pl-handbook', title: 'Employee handbook', version: '2.0', effectiveOn: '2026-09-15', summary: 'Rules', requiresAck: true }]
    const next = produce(db, (d) => {
      expect(applyInboxOp(d, { type: 'approve_timeoff', requestId: 'tr-ana' }, ctx).ok).toBe(true)
      expect(applyInboxOp(d, { type: 'approve_timeoff', requestId: 'tr-ana' }, ctx).ok).toBe(false)
      expect(applyInboxOp(d, { type: 'approve_offer', offerId: 'o-dan' }, ctx).ok).toBe(true)
      expect(applyInboxOp(d, { type: 'acknowledge', policyId: 'pl-handbook', personId: 'p-ana' }, ctx).ok).toBe(true)
    })
    expect(next.timeOffRequests[0]).toMatchObject({ status: 'approved', approverId: 'p-founder' })
    expect(next.offers[0].status).toBe('approved')
    expect(next.acks.some((a) => a.personId === 'p-ana' && a.policyId === 'pl-handbook' && a.version === '2.0')).toBe(true)
  })

  it('records the leave designation notice and closes its task', () => {
    const db = fixture()
    db.leaveCases.push({ id: 'lc-1', personId: 'p-tomas', kind: 'bonding', requestedOn: '2026-10-06', startDate: '2026-11-16', designationNoticeDueOn: '2026-10-13' })
    db.checklists.push({
      id: 'ck-leave',
      personId: 'p-tomas',
      kind: 'leave',
      templateId: 'tpl-leave',
      anchorDate: '2026-11-16',
      createdOn: '2026-10-06',
      tasks: [task('t-des', { templateTaskId: 'lv-designation', title: 'Response and designation notice sent', dueOn: '2026-10-13', statutory: true })],
    })
    const before = inboxItems(db, admin(db), FRI, { now: NOW })
    expect(byKey(before, 'leave-notice:lc-1')).toMatchObject({ statutory: false, title: "Tomas's CFRA bonding designation notice is due Tue Oct 13" })
    // The checklist task does not show twice.
    expect(byKey(before, 'task:ck-leave:t-des')).toBeUndefined()
    const next = produce(db, (d) => {
      applyInboxOp(d, { type: 'leave_notice_sent', leaveCaseId: 'lc-1' }, ctx)
    })
    expect(next.leaveCases[0].designationNoticeSentOn).toBe(FRI)
    expect(next.checklists.find((c) => c.id === 'ck-leave')?.tasks[0].status).toBe('done')
    expect(byKey(inboxItems(next, admin(next), FRI, { now: NOW }), 'leave-notice:lc-1')).toBeUndefined()
  })
})

describe('first hire kit visibility', () => {
  const solo = () => blankDB({ companyName: 'Quillfin', founderFirstName: 'Dana', founderLastName: 'Okoro', foundedOn: '2026-09-01' })

  it('keeps the kit (and leaves its rules out of the inbox) while the first hire is pre-start', () => {
    const db = solo()
    expect(firstHireKitShown(db, FRI)).toBe(true)
    addPerson(db, { id: 'p-sam', firstName: 'Sam', lastName: 'Rivera', startDate: '2026-10-26' })
    // Someone is incoming, so this is no longer the solo layout, but headcount is still 1.
    expect(isSoloWorkspace(db, FRI)).toBe(false)
    expect(firstHireKitShown(db, FRI)).toBe(true)
    const items = inboxItems(db, admin(db), FRI, { now: NOW })
    expect(items.some((i) => i.refs.ruleId && KIT_RULE_IDS.includes(i.refs.ruleId))).toBe(false)
    expect(items.some((i) => i.kind === 'rules_group' && KIT_RULE_IDS.some((id) => i.key.includes(id)))).toBe(false)
    // The founder is not asked to acknowledge their own starter policies while headcount is 1.
    expect(items.some((i) => i.kind === 'ack')).toBe(false)
    // Once Sam starts, headcount is 2: the kit goes and its rules come back to the inbox.
    expect(firstHireKitShown(db, '2026-10-26')).toBe(false)
    const after = inboxItems(db, admin(db), '2026-10-26', { now: '2026-10-26T22:00:00.000Z' })
    const ruleIds = after.flatMap((i) => (i.kind === 'rules_group' ? i.key.replace(/^rules-baseline:/, '').split(',') : i.refs.ruleId ? [i.refs.ruleId] : []))
    expect(ruleIds).toContain('iipp')
  })
})

describe('growth journey announcements', () => {
  it('announces the first hire once, for two weeks, and the row can be dismissed', () => {
    const db = blankDB({ companyName: 'Quillfin', founderFirstName: 'Dana', founderLastName: 'Okoro', foundedOn: '2026-09-01' })
    addPerson(db, { id: 'p-sam', firstName: 'Sam', lastName: 'Rivera', startDate: '2026-10-05' })
    expect(unlockEvents(db, FRI)).toContainEqual({ area: 'first_hire', on: '2026-10-05' })
    const item = byKey(inboxItems(db, admin(db), FRI, { now: NOW }), 'unlock:first_hire')
    expect(item).toMatchObject({ kind: 'unlock', statutory: false, group: 'this_week' })
    expect(item?.detail).toMatch(/^Why now: /)
    // Past the window it no longer shows.
    expect(byKey(inboxItems(db, admin(db), '2026-10-20', { now: '2026-10-20T22:00:00.000Z' }), 'unlock:first_hire')).toBeUndefined()
    // Dismissed, it stays gone.
    const next = produce(db, (d) => dismissItem(d, 'unlock:first_hire', FRI))
    expect(byKey(inboxItems(next, admin(next), FRI, { now: NOW }), 'unlock:first_hire')).toBeUndefined()
    // Only Admin sees announcements.
    expect(inboxItems(db, employee(db, 'p-sam'), FRI, { now: NOW }).some((i) => i.kind === 'unlock')).toBe(false)
  })

  it('announces the first grant and the first contractor from their dates', () => {
    const db = makeDB('2025-01-06')
    addPerson(db, { id: 'p-a', startDate: '2025-03-03' })
    addContractor(db, { id: 'k-1', startOn: '2026-10-01' })
    db.grants.push({
      id: 'g-a',
      personId: 'p-a',
      holderType: 'employee',
      type: 'ISO',
      shares: 1000,
      strikePrice: 0.5,
      vestingStart: '2025-03-03',
      proposedOn: '2026-10-07',
      cliffMonths: 12,
      vestingMonths: 48,
      status: 'promised',
      exercisedShares: 0,
      postTerminationExerciseDays: 90,
    })
    const keys = inboxItems(db, admin(db), FRI, { now: NOW }).map((i) => i.key)
    expect(keys).toContain('unlock:equity')
    expect(keys).toContain('unlock:contractors')
    expect(keys).not.toContain('unlock:first_hire')
  })

  it('nudges for levels and bands at 5 employees until a band is reviewed', () => {
    const db = makeDB('2025-01-06')
    for (const n of [1, 2, 3]) addPerson(db, { id: `p-${n}`, startDate: '2025-03-03' })
    expect(byKey(inboxItems(db, admin(db), FRI, { now: NOW }), 'nudge:bands')).toBeUndefined()
    addPerson(db, { id: 'p-4', startDate: '2025-03-03' })
    const nudge = byKey(inboxItems(db, admin(db), FRI, { now: NOW }), 'nudge:bands')
    expect(nudge).toMatchObject({ title: 'Set levels and bands before your next offer', statutory: false, primary: { kind: 'navigate' } })
    expect(nudge?.citation?.label).toBe('Labor Code 432.3')
    const reviewed = produce(db, (d) => {
      d.activity.push({ id: 'act-b', at: '2026-10-01T18:00:00.000Z', entityType: 'settings', entityId: 'b-1', kind: 'band_changed', text: 'Updated a band' })
    })
    expect(byKey(inboxItems(reviewed, admin(reviewed), FRI, { now: NOW }), 'nudge:bands')).toBeUndefined()
  })
})

describe('inbox counts and actions', () => {
  it('counts the same rows in the filter chips and the Tonight header while Coming up is folded', () => {
    const db = fixture()
    const items = inboxItems(db, admin(db), FRI, { now: NOW })
    expect(items.some((i) => i.group === 'coming_up')).toBe(true)
    expect(visibleForFilter(items, 'all').length).toBe(tonightSummary(items).count)
    expect(visibleForFilter(items, 'you').length).toBe(items.filter((i) => i.waitingOn === 'you' && i.group !== 'coming_up').length)
    // Opened, Coming up counts too.
    expect(visibleForFilter(items, 'all', true).length).toBe(items.length)
    // With nothing due now, Coming up is the list, so it is counted.
    const later = items.filter((i) => i.group === 'coming_up')
    expect(visibleForFilter(later, 'all').length).toBe(later.length)
  })
})

describe('welcome email task', () => {
  const withWelcome = () => {
    const db = fixture()
    db.checklists
      .find((c) => c.id === 'ck-lee')
      ?.tasks.push(task('t-welcome', { templateTaskId: 'on-welcome', title: 'Welcome email sent', ownerRole: 'manager', assigneeId: 'p-tomas', dueOn: '2026-10-14', category: 'culture' }))
    return db
  }

  it('makes Copy welcome email the primary action, with Mark sent under More', () => {
    const db = withWelcome()
    const item = byKey(inboxItems(db, manager(db), FRI, { now: NOW }), 'task:ck-lee:t-welcome')
    const mail = welcomeEmail(db, 'p-lee', { senderId: 'p-tomas' })
    expect(mail).not.toBeNull()
    expect(item?.primary).toMatchObject({ kind: 'copy', label: 'Copy welcome email', text: `Subject: ${mail?.subject}\n\n${mail?.body}` })
    expect(item?.primary.kind === 'copy' && item.primary.text).toContain('Hi Lee')
    expect(item?.more).toEqual([expect.objectContaining({ kind: 'mutate', label: 'Mark sent', op: expect.objectContaining({ type: 'task_status', taskId: 't-welcome' }) })])
  })

  it('falls back to Mark sent when there is no welcome template', () => {
    const db = withWelcome()
    db.emailTemplates = db.emailTemplates.filter((t) => t.kind !== 'welcome')
    const item = byKey(inboxItems(db, manager(db), FRI, { now: NOW }), 'task:ck-lee:t-welcome')
    expect(item?.primary).toMatchObject({ kind: 'mutate', label: 'Mark sent' })
    expect(item?.more).toBeUndefined()
  })
})

describe('timestamps read as the local calendar day', () => {
  const tz = process.env.TZ
  beforeAll(() => {
    process.env.TZ = 'America/Los_Angeles'
  })
  afterAll(() => {
    if (tz === undefined) delete process.env.TZ
    else process.env.TZ = tz
  })

  it('writes an evening timestamp as that local day', () => {
    // 7 PM Thursday Oct 1 in California is already Oct 2 in UTC.
    expect(dayText('2026-10-02T02:00:00.000Z')).toBe('Thu Oct 1')
    expect(dayText('2026-10-19')).toBe('Mon Oct 19')
  })

  it('ages the last backup by its local day', () => {
    const db = fixture()
    db.meta.sample = false
    // Backed up 8 PM Thursday Oct 1 local: 8 days before Friday Oct 9 (the UTC date would say 7, not stale yet).
    db.meta.lastExportedOn = '2026-10-02T03:00:00.000Z'
    const backup = inboxItems(db, admin(db), FRI, { now: NOW }).find((i) => i.kind === 'backup')
    expect(backup?.key).toBe('backup:2026-10-01')
  })
})

describe('offers past their expiry', () => {
  /** An offer for Mia Wong (sent, past its date), Lee Kim (closed as expired) and Ana Ruiz (still open). */
  function offers(): DB {
    const db = fixture()
    const app = (id: string, status: 'active' | 'withdrawn' = 'active') =>
      db.applications.push({ id: `a-${id}`, candidateId: `c-${id}`, jobId: 'j-1', stageId: 'offer', status, appliedOn: '2026-09-01', stageEnteredOn: '2026-10-01', history: [] })
    addOffer(db, { id: 'o-mia', startDate: '2026-11-02', status: 'sent', expiresOn: '2026-10-07' }, { firstName: 'Mia', lastName: 'Wong' })
    addOffer(db, { id: 'o-lee', startDate: '2026-11-02', status: 'expired', expiresOn: '2026-10-06', decidedOn: '2026-10-06' }, { firstName: 'Lee', lastName: 'Kim' })
    addOffer(db, { id: 'o-gone', startDate: '2026-11-02', status: 'expired', expiresOn: '2026-10-05', decidedOn: '2026-10-05' }, { firstName: 'Gus', lastName: 'Gone' })
    addOffer(db, { id: 'o-ana', startDate: '2026-11-09', status: 'sent', expiresOn: '2026-10-13' }, { firstName: 'Ana', lastName: 'Ruiz' })
    app('o-mia')
    app('o-lee')
    app('o-gone', 'withdrawn')
    app('o-ana')
    return db
  }

  it('asks you to extend or close out an expired offer, never to send a nudge quoting a passed date', () => {
    const db = offers()
    const items = inboxItems(db, admin(db), FRI, { now: NOW })
    const mia = byKey(items, 'offer-expired:o-mia:2026-10-07')
    expect(mia).toMatchObject({
      kind: 'offer_expiring',
      title: "Mia Wong's offer expired Wed Oct 7",
      detail: 'Extend it to reopen, or record that they declined.',
      group: 'overdue',
      statutory: false,
      waitingOn: 'you',
      primary: { kind: 'mutate', label: 'Extend 3 days', op: { type: 'extend_offer', offerId: 'o-mia', businessDays: 3 } },
      more: [{ kind: 'navigate', label: 'Open offer', href: '#candidate.c-o-mia' }],
    })
    // An offer already closed as expired at load gets the same row while its application is open.
    expect(byKey(items, 'offer-expired:o-lee:2026-10-06')?.title).toBe("Lee Kim's offer expired Tue Oct 6")
    expect(items.some((i) => i.refs.offerId === 'o-gone')).toBe(false)
    expect(items.some((i) => (i.refs.offerId === 'o-mia' || i.refs.offerId === 'o-lee') && i.primary.kind === 'copy')).toBe(false)
    // An offer still open keeps the friendly check-in, waiting on the candidate.
    expect(byKey(items, 'offer-expiring:o-ana:2026-10-13')).toMatchObject({ title: "Ana Ruiz's offer expires Tue Oct 13", waitingOn: 'them', waitingOnName: 'Ana' })
  })

  it('extends an expired offer from the row', () => {
    const db = offers()
    const next = produce(db, (d) => {
      expect(applyInboxOp(d, { type: 'extend_offer', offerId: 'o-lee', businessDays: 3 }, { date: FRI, actorId: 'p-founder' }).ok).toBe(true)
    })
    const lee = next.offers.find((o) => o.id === 'o-lee')
    expect(lee?.status).toBe('sent')
    expect((lee?.expiresOn ?? '') > FRI).toBe(true)
    expect(inboxItems(next, admin(next), FRI, { now: NOW }).some((i) => i.key.startsWith('offer-expired:o-lee'))).toBe(false)
  })
})

describe('the EDD DE 1 clock on an estimate', () => {
  /** The golden path: an unpaid founder since Jan 1 and a first hire who started Nov 2. */
  function golden(): DB {
    const db = makeDB('2026-01-01')
    addPerson(db, { id: 'p-first', firstName: 'Sam', lastName: 'Rivera', startDate: '2026-11-02' })
    db.comp.push({ id: 'cr-1', personId: 'p-first', effectiveOn: '2026-11-02', payType: 'salary', salary: 150000, title: 'Engineer', levelId: 'lv-l3', reason: 'hire' })
    return db
  }
  const NOV20 = '2026-11-20'

  it('asks for the first payroll date instead of showing a red legal deadline', () => {
    const db = golden()
    const items = inboxItems(db, admin(db), NOV20, { now: '2026-11-20T22:00:00.000Z' })
    const edd = items.filter((i) => i.refs.ruleId === 'edd-registration')
    expect(edd).toHaveLength(1)
    expect(edd[0]).toMatchObject({
      key: 'rule:edd-registration:estimated',
      title: 'EDD employer registration (DE 1): add your first payroll date in Settings, Company',
      chip: 'About Nov 17',
      group: 'this_week',
      statutory: false,
      primary: { kind: 'navigate', label: 'Add the date', href: '#settings.company' },
    })
    expect(edd[0].dueOn).toBeUndefined()
    expect(edd[0].detail).toMatch(/^Due about Tue Nov 17, 15 days after the first payroll\. Estimated from the first paid W-2 start on record: Sam Rivera on Nov 2, 2026\./)
    expect(edd[0].more?.[0]).toMatchObject({ kind: 'mutate', label: 'Mark step done', op: { type: 'rule_action_done', ruleId: 'edd-registration', actionId: 'register' } })
    // Nothing about DE 1 counts as an overdue legal deadline (the Tonight header would say so).
    expect(items.some((i) => i.statutory && i.group === 'overdue' && i.refs.ruleId === 'edd-registration')).toBe(false)
  })

  it('becomes the legal deadline once the first payroll date is recorded', () => {
    const db = golden()
    db.company.firstPayrollOn = '2026-11-13'
    const items = inboxItems(db, admin(db), '2026-11-30', { now: '2026-11-30T22:00:00.000Z' })
    expect(byKey(items, 'rule:edd-registration:register')).toMatchObject({ statutory: true, dueOn: '2026-11-28', group: 'overdue' })
    expect(byKey(items, 'rule:edd-registration:estimated')).toBeUndefined()
  })

  it('leaves the later step undated once registration is ticked', () => {
    const db = golden()
    db.complianceStatus['edd-registration'] = { actionsDone: { register: '2026-11-10' } }
    const items = inboxItems(db, admin(db), NOV20, { now: '2026-11-20T22:00:00.000Z' })
    const step = byKey(items, 'rule:edd-registration:save-account')
    expect(step).toMatchObject({ statutory: false, group: 'this_week' })
    expect(step?.dueOn).toBeUndefined()
    expect(byKey(items, 'rule:edd-registration:estimated')).toBeUndefined()
  })

  it('drops the row once the EDD account number is saved', () => {
    const db = golden()
    db.company.eddAccountNumber = '123-4567-8'
    expect(inboxItems(db, admin(db), NOV20, { now: '2026-11-20T22:00:00.000Z' }).some((i) => i.refs.ruleId === 'edd-registration')).toBe(false)
  })
})

describe('file-by days on checklist rows', () => {
  /** Tomas terminated Fri Oct 9 with his last day Sat Oct 10, and Lee's DE 34 due Sun Nov 8. */
  function weekendDB(): DB {
    const db = fixture()
    const tomas = db.people.find((p) => p.id === 'p-tomas')!
    tomas.endDate = '2026-10-10'
    db.checklists.push(
      generateChecklist(db, { id: 'ck-tomas-off', person: tomas, templateId: 'tpl-offboarding', anchorDate: '2026-10-10', createdOn: FRI, separationType: 'terminated' }),
    )
    const lee = db.checklists.find((c) => c.id === 'ck-lee')!
    lee.tasks.push(task('t-lee-de34', { templateTaskId: 'on-de34', title: 'DE 34 new hire report filed', dueOn: '2026-11-08', statutory: true }))
    return db
  }

  it('gives the last-day tasks of a Saturday termination their own date, with no earlier file-by day', () => {
    const db = weekendDB()
    const items = inboxItems(db, admin(db), FRI, { now: NOW })
    const off = items.filter((i) => i.refs.checklistId === 'ck-tomas-off')
    expect(off.length).toBeGreaterThan(0)
    expect(off.filter((i) => i.dueOn === '2026-10-10').length).toBeGreaterThan(0)
    expect(off.filter((i) => /file by/.test(i.dueNote ?? ''))).toEqual([])
  })

  it('still gives an agency filing due on a Sunday the Friday to file by', () => {
    const db = weekendDB()
    const items = inboxItems(db, admin(db), '2026-11-02', { now: '2026-11-02T18:00:00.000Z' })
    expect(byKey(items, 'task:ck-lee:t-lee-de34')?.dueNote).toBe('Due Sun Nov 8, file by Fri Nov 6.')
  })

  it('keeps a contract end on its date (not a filing)', () => {
    const db = fixture()
    addContractor(db, { id: 'k-sat', name: 'Sat Contract', startOn: '2026-04-01', endOn: '2026-10-17' })
    const row = inboxItems(db, admin(db), FRI, { now: NOW }).find((i) => i.kind === 'calendar' && i.dueOn === '2026-10-17')
    expect(row).toBeDefined()
    expect(row?.dueNote ?? '').not.toMatch(/file by/)
  })
})

describe('payroll update rows name the change', () => {
  const change = (id: string, anchorDate: string, dueOn: string): Checklist => ({
    id,
    personId: 'p-tomas',
    kind: 'change',
    templateId: 'tpl-change',
    anchorDate,
    createdOn: '2026-10-05',
    tasks: [task(`${id}-pay`, { templateTaskId: 'ch-payroll', title: 'Payroll updated', dueOn })],
  })

  it('tells two changes for one person apart, without amounts', () => {
    const db = fixture()
    db.checklists.push(change('ck-promo', '2026-11-01', '2026-10-19'), change('ck-mgr', '2026-10-19', '2026-10-12'))
    db.comp.push(
      { id: 'cr-promo', personId: 'p-tomas', effectiveOn: '2026-11-01', payType: 'salary', salary: 210000, title: 'Staff engineer', levelId: 'lv-l4', reason: 'promotion' },
      { id: 'cr-mgr', personId: 'p-tomas', effectiveOn: '2026-10-19', payType: 'salary', salary: 180000, title: 'Engineer', levelId: 'lv-l3', managerId: 'p-ana', reason: 'manager_change' },
    )
    const items = inboxItems(db, admin(db), FRI, { now: NOW })
    expect(byKey(items, 'task:ck-promo:ck-promo-pay')?.title).toBe('Update payroll for Tomas Herrera: promotion to L4, effective Nov 1, by Mon Oct 19')
    expect(byKey(items, 'task:ck-mgr:ck-mgr-pay')?.title).toBe('Update payroll for Tomas Herrera: manager change to Ana Lima, effective Oct 19, by Mon Oct 12')
    expect(items.filter((i) => /210|180/.test(i.title))).toEqual([])
  })

  it('falls back to the plain title when no job or pay row matches the date', () => {
    const db = fixture()
    db.checklists.push(change('ck-x', '2026-11-01', '2026-10-19'))
    expect(byKey(inboxItems(db, admin(db), FRI, { now: NOW }), 'task:ck-x:ck-x-pay')?.title).toBe("Update payroll for Tomas Herrera's change by Mon Oct 19")
  })
})

describe("rules whose deadlines are each hire's checklist tasks", () => {
  const NOV30 = '2026-11-30'
  const AT = { now: '2026-11-30T22:00:00.000Z' }
  const PER_PERSON = ['new-hire-reporting', 'form-i9', 'sb294-new-hire', 'wage-notice-2810-5']

  /** The golden path: an unpaid founder since Jan 1 and Maria Gonzalez, the first hire, starting Mon Nov 2. */
  function golden(): DB {
    const db = makeDB('2026-01-01')
    const maria = addPerson(db, { id: 'p-maria', firstName: 'Maria', lastName: 'Gonzalez', startDate: '2026-11-02' })
    db.comp.push({ id: 'cr-1', personId: 'p-maria', effectiveOn: '2026-11-02', payType: 'salary', salary: 150000, title: 'Engineer', levelId: 'lv-l3', reason: 'hire' })
    db.checklists.push(generateChecklist(db, { id: 'ck-maria', person: maria, templateId: 'tpl-onboarding', anchorDate: '2026-11-02', createdOn: '2026-10-11' }))
    return db
  }

  it('shows each overdue legal deadline once, on the task, with the company steps grouped and undated', () => {
    const db = golden()
    const items = inboxItems(db, admin(db), NOV30, AT)
    expect(byKey(items, 'task:ck-maria:t-maria-on-de34')).toMatchObject({
      title: 'DE 34 for Maria Gonzalez was due Sun Nov 22: confirm your PEO filed it',
      statutory: true,
      group: 'overdue',
      dueNote: 'Due Sun Nov 22, file by Fri Nov 20. 20 days after start.',
    })
    expect(byKey(items, 'task:ck-maria:t-maria-on-i9-section1')).toMatchObject({ statutory: true, group: 'overdue' })
    // No second red row for the DE 34, I-9 or SB 294 rule.
    expect(items.filter((i) => i.kind === 'rule' && PER_PERSON.includes(i.refs.ruleId ?? ''))).toEqual([])
    const group = items.find((i) => i.kind === 'rules_group')
    expect(group?.key.replace(/^rules-baseline:/, '').split(',')).toEqual(expect.arrayContaining(['new-hire-reporting', 'form-i9', 'sb294-new-hire']))
    expect(group).toMatchObject({ statutory: false, group: 'this_week' })
  })

  it('lists a lone company step without a date or a red mark', () => {
    const db = golden()
    for (const r of RULES) if (r.id !== 'form-i9') db.complianceStatus[r.id] = { status: 'not_applicable', note: 'Out of this test' }
    const items = inboxItems(db, admin(db), NOV30, AT).filter((i) => i.refs.ruleId === 'form-i9')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ key: 'rule:form-i9:current-edition', kind: 'rule', statutory: false, group: 'this_week' })
    expect(items[0].dueOn).toBeUndefined()
    expect(items[0].dueNote).toBeUndefined()
  })

  it('keeps a deadline recorded on the card as a dated row of its own', () => {
    const db = golden()
    db.complianceStatus['new-hire-reporting'] = { dueOn: '2026-12-04', note: 'From the PEO' }
    const row = byKey(inboxItems(db, admin(db), NOV30, AT), 'rule:new-hire-reporting:confirm-provider')
    expect(row).toMatchObject({ dueOn: '2026-12-04', statutory: true, group: 'this_week' })
  })
})

describe('SB 553 workplace violence prevention plan row', () => {
  it('says no plan is on file only until the plan step is done, then names the next step', () => {
    const db = makeDB('2025-01-06')
    addMany(db, 12, '2025-03-03')
    db.locations[0].typicalMaxOnSite = 11
    const row = () => inboxItems(db, admin(db), FRI, { now: NOW }).find((i) => i.refs.ruleId === 'wvpp')
    expect(row()).toMatchObject({
      title: '11 people are at the office at once on busy days, so a workplace violence prevention plan applies: none on file',
      group: 'overdue',
      statutory: true,
    })
    expect(row()?.detail).toMatch(/^Next: Write the plan and name who runs it\. 2 more steps after this\. /)
    db.complianceStatus.wvpp = { actionsDone: { 'write-plan': '2026-10-01' } }
    expect(row()).toMatchObject({ key: 'rule:wvpp:train', title: 'Workplace violence prevention plan (SB 553): train everyone, then every year' })
    expect(row()?.detail).toMatch(/^1 more step after this\. /)
  })
})

describe('pay run prep row (Run payroll by)', () => {
  function payDB(): DB {
    const db = blankDB({ companyName: 'Testco', founderFirstName: 'Maya', founderLastName: 'Raman', foundedOn: '2025-02-03' })
    db.company.payrollProvider = { name: 'Gusto', kind: 'Payroll', url: '' }
    db.comp.push({ id: 'cr-f', personId: 'p-founder', effectiveOn: '2025-02-03', payType: 'salary', salary: 150_000, title: 'Founder and CEO', levelId: 'lv-x1', reason: 'hire' })
    return db
  }
  const payRow = (db: DB, date: string) => inboxItems(db, admin(db), date, { now: `${date}T19:00:00.000Z` }).find((i) => i.kind === 'payrun')

  it('asks Admin to run the next payroll by the cutoff, never in red, with Mark submitted under More', () => {
    const db = payDB()
    const row = payRow(db, FRI)
    expect(row).toMatchObject({
      key: 'payrun:2026-10-01',
      title: 'Run the Oct 1-15 payroll in Gusto by Tue Oct 13',
      dueOn: '2026-10-13',
      snoozeLimit: '2026-10-13',
      statutory: false,
      group: 'this_week',
      waitingOn: 'you',
      href: '#comp.payruns.2026-10-01',
      primary: { kind: 'navigate', label: 'Open pay run prep', href: '#comp.payruns.2026-10-01' },
      citation: { label: 'Labor Code 204' },
    })
    expect(row?.detail).toBe('Payday Thu Oct 15. No starts, last days, pay changes or time off. Export the prep, enter it in Gusto, then mark it submitted.')
    expect(row?.dueNote).toContain("Gusto's cutoff, 2 business days before payday")
    expect(row?.dueNote).toContain('Labor Code 210')
    expect(row?.more?.[0]).toMatchObject({ kind: 'mutate', label: 'Mark submitted to Gusto', op: { type: 'payrun_submitted', periodStart: '2026-10-01' } })
  })

  it('names what changed and a payday moved off a weekend', () => {
    const db = payDB()
    addPerson(db, { id: 'p-lee', firstName: 'Lee', lastName: 'Park', startDate: '2026-10-19' })
    db.comp.push({ id: 'cr-lee', personId: 'p-lee', effectiveOn: '2026-10-19', payType: 'salary', salary: 180_000, title: 'Engineer', levelId: 'lv-l3', reason: 'hire' })
    db.timeOffRequests.push({ id: 'tr-1', personId: 'p-founder', policyId: 'pol-vacation', startDate: '2026-10-22', endDate: '2026-10-23', hours: 16, status: 'approved', requestedOn: '2026-10-01' })
    const db2 = produce(db, (d) => {
      applyInboxOp(d, { type: 'payrun_submitted', periodStart: '2026-10-01' }, { date: FRI, actorId: 'p-founder' })
    })
    // The next cutoff (Wed Oct 28) is more than two weeks after Fri Oct 9: nothing to show yet.
    expect(payRow(db2, FRI)).toBeUndefined()
    const row = payRow(db2, '2026-10-14')
    expect(row).toMatchObject({ key: 'payrun:2026-10-16', title: 'Run the Oct 16-31 payroll in Gusto by Wed Oct 28', group: 'coming_up' })
    expect(row?.detail).toBe('Payday Fri Oct 30 (moved from Sat Oct 31, not a business day). Lee Park starts; time off for 1 person. Export the prep, enter it in Gusto, then mark it submitted.')
  })

  it('caps snoozes at the cutoff, brings the row back on it and offers no dismiss', () => {
    const db = payDB()
    const row = payRow(db, FRI) as InboxItem
    expect(snoozeOptions(row, FRI).map((o) => o.until)).toEqual(['2026-10-10', '2026-10-12', '2026-10-13'])
    expect(snoozeOptions(row, '2026-10-13')).toEqual([])
    expect(canDismiss(row)).toBe(false)
    expect(isHidden({ snoozedUntil: '2026-10-16' }, row, '2026-10-12')).toBe(true)
    expect(isHidden({ snoozedUntil: '2026-10-16' }, row, '2026-10-13')).toBe(false)
    expect(isHidden({ dismissedOn: FRI }, row, FRI)).toBe(false)
  })

  it('says the cutoff passed until payday, then moves to the next period', () => {
    const db = payDB()
    expect(payRow(db, '2026-10-14')).toMatchObject({
      title: 'Run the Oct 1-15 payroll now: the cutoff was Tue Oct 13, payday is Thu Oct 15',
      group: 'overdue',
      statutory: false,
    })
    expect(payRow(db, '2026-10-16')?.key).toBe('payrun:2026-10-16')
  })

  it('marks the period submitted from the row (Undo-able like any op) and refuses twice', () => {
    const db = payDB()
    const next = produce(db, (d) => {
      expect(applyInboxOp(d, { type: 'payrun_submitted', periodStart: '2026-10-01' }, { date: FRI, actorId: 'p-founder' })).toEqual({ ok: true })
      expect(applyInboxOp(d, { type: 'payrun_submitted', periodStart: '2026-10-01' }, { date: FRI, actorId: 'p-founder' })).toEqual({
        ok: false,
        reason: 'This pay run is already marked submitted.',
      })
      expect(applyInboxOp(d, { type: 'payrun_submitted', periodStart: '2026-10-02' }, { date: FRI, actorId: 'p-founder' }).ok).toBe(false)
    })
    expect(next.company.payRuns?.[0]).toMatchObject({ periodStart: '2026-10-01', submittedOn: FRI, submittedById: 'p-founder' })
    // The founder has been paid since Feb 2025, so Oct 15, 2026 is not the first payroll: the EDD date stays empty.
    expect(next.company.firstPayrollOn).toBeUndefined()
  })

  it("fills the first payroll date from the row's mark when this is the first payroll", () => {
    const db = payDB()
    // The founder's pay starts Oct 1, 2026: Oct 1-15 is the first payroll.
    db.comp = [{ ...db.comp[0], effectiveOn: '2026-10-01' }]
    const next = produce(db, (d) => {
      expect(applyInboxOp(d, { type: 'payrun_submitted', periodStart: '2026-10-01' }, { date: FRI, actorId: 'p-founder' })).toEqual({ ok: true })
    })
    expect(next.company.firstPayrollOn).toBe('2026-10-15')
  })

  it('ranks a payroll past its cutoff with the overdue legal deadlines, ahead of stale reminders', () => {
    const db = payDB()
    db.checklists.push({
      id: 'ck-old',
      personId: 'p-founder',
      kind: 'onboarding',
      templateId: 'tpl-onboarding',
      anchorDate: '2026-08-03',
      createdOn: '2026-08-01',
      tasks: [task('t-laptop', { title: 'Laptop returned', dueOn: '2026-09-01', category: 'it' }), task('t-badge', { title: 'Badge returned', dueOn: '2026-09-02', category: 'it' })],
    })
    // Wed Oct 14: the Oct 13 cutoff has passed, payday is Thu Oct 15.
    const overdue = inboxItems(db, admin(db), '2026-10-14', { now: '2026-10-14T19:00:00.000Z' }).filter((i) => i.group === 'overdue')
    expect(overdue.map((i) => i.kind)).toEqual(['payrun', 'task', 'task'])
    expect(overdue[0].title).toBe('Run the Oct 1-15 payroll now: the cutoff was Tue Oct 13, payday is Thu Oct 15')
    // Still amber, never red: the payday is the legal date, not the cutoff.
    expect(overdue[0].statutory).toBe(false)
  })

  it('leads Overdue ahead of more than 5 overdue legal rows, so Home shows it before Show more', () => {
    const db = payDB()
    // Eight overdue legal deadlines on separate days (Home shows 5 Overdue rows before Show more).
    db.checklists.push({
      id: 'ck-legal',
      personId: 'p-founder',
      kind: 'onboarding',
      templateId: 'tpl-onboarding',
      anchorDate: '2026-08-31',
      createdOn: '2026-08-28',
      tasks: Array.from({ length: 8 }, (_, n) => task(`t-legal-${n}`, { title: `Legal filing ${n + 1}`, dueOn: `2026-09-0${n + 1}`, statutory: true })),
    })
    // Thu Oct 15 is payday (the cutoff passed on Tue Oct 13), and Wed Oct 14 the day before.
    for (const date of ['2026-10-14', '2026-10-15']) {
      const overdue = inboxItems(db, admin(db), date, { now: `${date}T19:00:00.000Z` }).filter((i) => i.group === 'overdue')
      expect(overdue.filter((i) => i.statutory)).toHaveLength(8)
      expect(overdue[0]).toMatchObject({ kind: 'payrun', statutory: false })
      expect(overdue.slice(1).every((i) => i.statutory)).toBe(true)
    }
  })

  it('says why the row cannot be snoozed on and after the cutoff, without calling it a legal deadline', () => {
    const db = payDB()
    const onCutoff = payRow(db, '2026-10-13') as InboxItem
    expect(snoozeOptions(onCutoff, '2026-10-13')).toEqual([])
    expect(noSnoozeReason(onCutoff, '2026-10-13')).toBe('The payroll cutoff is today: it cannot be snoozed')
    const late = payRow(db, '2026-10-14') as InboxItem
    expect(noSnoozeReason(late, '2026-10-14')).toBe('The payroll cutoff has passed: it cannot be snoozed')
    expect(noSnoozeReason({ statutory: true, snoozeLimit: undefined }, FRI)).toBe('A legal deadline cannot be snoozed once due')
    // The expanded row says only why: it is not a legal deadline and has no done or not applicable action.
    expect(noSnoozeDetail(onCutoff, '2026-10-13')).toBe('The payroll cutoff is today: it cannot be snoozed.')
    expect(noSnoozeDetail(late, '2026-10-14')).toBe('The payroll cutoff has passed: it cannot be snoozed.')
    expect(noSnoozeDetail({ statutory: true, snoozeLimit: undefined }, FRI)).toBe('A legal deadline cannot be snoozed once due. Mark it done, or not applicable with a note.')
  })

  it('starts the detail sentence in capitals when the period has only time off', () => {
    const db = payDB()
    db.timeOffRequests.push({ id: 'tr-1', personId: 'p-founder', policyId: 'pol-vacation', startDate: '2026-10-07', endDate: '2026-10-08', hours: 16, status: 'approved', requestedOn: '2026-10-01' })
    expect(payRow(db, FRI)?.detail).toBe('Payday Thu Oct 15. Time off for 1 person. Export the prep, enter it in Gusto, then mark it submitted.')
  })

  it('asks for a week after a payday that passed with no mark whether the payroll ran', () => {
    const db = payDB()
    const ask = (date: string) => inboxItems(db, admin(db), date, { now: `${date}T19:00:00.000Z` }).filter((i) => i.kind === 'payrun_unmarked')
    expect(ask('2026-10-15')).toEqual([])
    const [row] = ask('2026-10-16')
    expect(row).toMatchObject({
      key: 'payrun-unmarked:2026-10-01',
      title: 'Did the Oct 1-15 payroll run? Payday was Thu Oct 15',
      dueOn: '2026-10-15',
      group: 'overdue',
      statutory: false,
      href: '#comp.payruns.2026-10-01',
      primary: { kind: 'mutate', label: 'Mark submitted', op: { type: 'payrun_submitted', periodStart: '2026-10-01' } },
      citation: { label: 'Labor Code 210' },
    })
    expect(row.detail).toBe('Nothing is marked for it here. If it ran in Gusto, mark it submitted. If it did not, run it now: a late payday can cost $100 per employee (Labor Code 210).')
    // Quiet: it can be snoozed and dismissed.
    expect(canDismiss(row)).toBe(true)
    expect(snoozeOptions(row, '2026-10-16').length).toBe(3)
    expect(ask('2026-10-22')).toHaveLength(1)
    expect(ask('2026-10-23')).toEqual([])
    // Marking it submitted from the row clears it (and records the first payroll date).
    const marked = produce(db, (d) => {
      expect(applyInboxOp(d, row.primary.kind === 'mutate' ? row.primary.op : { type: 'backup_downloaded' }, { date: '2026-10-16', actorId: 'p-founder' })).toEqual({ ok: true })
    })
    expect(inboxItems(marked, admin(marked), '2026-10-16', { now: '2026-10-16T19:00:00.000Z' }).some((i) => i.kind === 'payrun_unmarked')).toBe(false)
    // People were paid before Oct 1-15 (the founder since Feb 2025): the first payroll date is not guessed from it.
    expect(marked.company.firstPayrollOn).toBeUndefined()
  })

  it('shows only to Admin, and not while nobody on payroll is paid', () => {
    const db = payDB()
    const manager: Viewer = { role: 'manager', person: db.people[0], personId: 'p-founder' }
    expect(inboxItems(db, manager, FRI, { now: NOW }).some((i) => i.kind === 'payrun')).toBe(false)
    expect(inboxItems(db, admin(db), FRI, { now: NOW, scope: 'personal' }).some((i) => i.kind === 'payrun')).toBe(false)
    db.comp = []
    expect(payRow(db, FRI)).toBeUndefined()
  })
})
