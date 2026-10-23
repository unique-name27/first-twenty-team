import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { defaultHolidays } from '@/data/defaults'
import { buildSampleDB } from '@/data/seed'
import { inboxItems } from '@/domain/inbox'
import { markDesignationSent as domainMarkDesignationSent, startLeave } from '@/domain/lifecycle'
import { whoIsOut } from '@/domain/timeoff'
import type { LeaveCase } from '@/domain/types'
import {
  afterTheFactKind,
  approvalGroups,
  approverLabel,
  defaultLeaveReturn,
  leaveDatesValid,
  leaveKindsFor,
  leaveSheetMode,
  designationState,
  endPresets,
  entryView,
  holidaysForYear,
  holidaysICS,
  holidaysText,
  hoursWithDays,
  leavePhase,
  leaveText,
  markDesignationSent,
  markReturned,
  monthWeeks,
  outByDay,
  hireStartPresets,
  leaveStartPresets,
  noteCountText,
  rangePresets,
  rangeSummary,
  rangeText,
  shortRange,
  startInWeeks,
  startPresets,
  waitingOnManager,
} from './logic'

const HOL = defaultHolidays()
const FRI = '2026-10-09'

describe('monthWeeks', () => {
  it('covers October 2026 in Monday-first weeks', () => {
    const weeks = monthWeeks('2026-10-15')
    expect(weeks).toHaveLength(5)
    expect(weeks[0][0]).toBe('2026-09-28')
    expect(weeks[0][3]).toBe('2026-10-01')
    expect(weeks[4][6]).toBe('2026-11-01')
    for (const w of weeks) expect(w).toHaveLength(7)
  })

  it('needs six rows when the month starts on a Sunday', () => {
    const weeks = monthWeeks('2026-11-01')
    expect(weeks[0][6]).toBe('2026-11-01')
    expect(weeks).toHaveLength(6)
  })
})

describe('leave start chips', () => {
  it('lands "In N weeks" on the Monday on or after today plus N weeks', () => {
    const sun = '2026-10-11'
    expect(leaveStartPresets(sun, HOL)).toEqual([
      { label: 'Today', date: sun },
      { label: 'Next Mon', date: '2026-10-12' },
      { label: 'In 2 weeks (Mon)', date: '2026-10-26' },
      { label: 'In 4 weeks (Mon)', date: '2026-11-09' },
      { label: 'In 6 weeks (Mon)', date: '2026-11-23' },
    ])
    // From a Monday, two weeks out is that Monday.
    expect(startInWeeks('2026-10-12', 2, HOL)).toBe('2026-10-26')
    // A Monday holiday moves to the next workday, and the label says so.
    const ownHoliday = [...HOL, { date: '2026-10-26', name: 'Company day' }]
    expect(leaveStartPresets(sun, ownHoliday)[2]).toEqual({ label: 'In 2 weeks (Tue)', date: '2026-10-27' })
  })
})

describe('hire start chips', () => {
  it('lands "In 2 weeks" and "In 3 weeks" on the Monday on or after today plus N weeks, late in the week too', () => {
    // Sunday Oct 11: two weeks out is Sun Oct 25, so the chip is Mon Oct 26 (not Oct 19, 8 days away).
    expect(hireStartPresets('2026-10-11', HOL)).toEqual([
      { label: 'Next Mon', date: '2026-10-12' },
      { label: 'In 2 weeks (Mon)', date: '2026-10-26' },
      { label: 'In 3 weeks (Mon)', date: '2026-11-02' },
    ])
    // Thursday Oct 15: Next Mon Oct 19, then Nov 2 and Nov 9.
    expect(hireStartPresets('2026-10-15', HOL).map((p) => p.date)).toEqual(['2026-10-19', '2026-11-02', '2026-11-09'])
    // A Monday holiday moves to the next workday, and the label says so.
    const ownHoliday = [...HOL, { date: '2026-10-26', name: 'Company day' }]
    expect(hireStartPresets('2026-10-11', ownHoliday)[1]).toEqual({ label: 'In 2 weeks (Tue)', date: '2026-10-27' })
  })
})

describe('note length', () => {
  it('counts characters only near the limit', () => {
    expect(noteCountText('x'.repeat(799))).toBeNull()
    expect(noteCountText('x'.repeat(850))).toBe('850 of 1,000 characters')
  })
})

describe('quick date picks', () => {
  it('skips Tomorrow when it is a Saturday and offers next Mon and Fri', () => {
    expect(startPresets(FRI, HOL)).toEqual([
      { label: 'Today', date: '2026-10-09' },
      { label: 'Next Mon', date: '2026-10-12' },
      { label: 'Next Fri', date: '2026-10-16' },
    ])
  })

  it('offers Tomorrow midweek and moves Next Fri off a holiday', () => {
    const p = startPresets('2026-11-24', HOL)
    expect(p.find((x) => x.label === 'Tomorrow')?.date).toBe('2026-11-25')
    // Fri Nov 27 is the day after Thanksgiving, so the chip lands on Wed Nov 25 and dedupes.
    expect(p.find((x) => x.label === 'Next Fri')).toBeUndefined()
  })

  it('never offers a Next Fri that is today or already past', () => {
    // Thu Nov 26 is Thanksgiving and Fri Nov 27 a holiday, so this week's Friday chip would land on Wed Nov 25.
    expect(startPresets('2026-11-26', HOL)).toEqual([
      { label: 'Next Mon', date: '2026-11-30' },
      { label: 'Next Fri', date: '2026-12-04' },
    ])
    expect(startPresets('2026-11-25', HOL).map((p) => p.date)).toEqual(['2026-11-25', '2026-11-30', '2026-12-04'])
  })

  it('leads with Yesterday for after-the-fact kinds, even on a weekend', () => {
    // Sat Oct 10: no Today chip (not a workday), Yesterday is Fri Oct 9.
    expect(startPresets('2026-10-10', HOL, { past: true })).toEqual([
      { label: 'Yesterday', date: '2026-10-09' },
      { label: 'Next Mon', date: '2026-10-12' },
      { label: 'Next Fri', date: '2026-10-16' },
    ])
    // Sun Oct 11: the last workday is Friday.
    expect(startPresets('2026-10-11', HOL, { past: true })[0]).toEqual({ label: 'Last Fri', date: '2026-10-09' })
    // Mon Oct 12: Today, then last Friday, then the future chips.
    expect(startPresets('2026-10-12', HOL, { past: true }).map((p) => p.label)).toEqual(['Today', 'Last Fri', 'Tomorrow', 'Next Mon', 'Next Fri'])
    // Mon Nov 30: Thanksgiving Thursday and Friday are skipped.
    expect(startPresets('2026-11-30', HOL, { past: true })[1]).toEqual({ label: 'Last Wed', date: '2026-11-25' })
    // Without `past`, no earlier chip appears.
    expect(startPresets('2026-10-12', HOL).some((p) => p.date < '2026-10-12')).toBe(false)
  })

  it('treats sick leave, bereavement and reproductive loss as after-the-fact kinds', () => {
    expect(afterTheFactKind('sick')).toBe(true)
    expect(afterTheFactKind('bereavement')).toBe(true)
    expect(afterTheFactKind('reproductive_loss')).toBe(true)
    expect(afterTheFactKind('vacation')).toBe(false)
    expect(afterTheFactKind('flexible_vacation')).toBe(false)
    expect(afterTheFactKind('jury_duty')).toBe(false)
  })

  it('end chips follow the start and land on workdays', () => {
    expect(endPresets('2026-10-12', HOL)).toEqual([
      { label: 'Same day', date: '2026-10-12' },
      { label: 'End of week', date: '2026-10-16' },
      { label: '2 weeks', date: '2026-10-23' },
    ])
    expect(endPresets('2026-10-14', HOL).map((p) => p.label)).toEqual(['Same day', 'End of week', '1 week', '2 weeks'])
  })

  it('offers Thanksgiving week while it is ahead', () => {
    expect(rangePresets(FRI, HOL)).toEqual([
      { label: 'Next week', start: '2026-10-12', end: '2026-10-16' },
      { label: 'Thanksgiving week', start: '2026-11-23', end: '2026-11-27' },
    ])
    expect(rangePresets('2026-11-24', HOL).map((p) => p.label)).toEqual(['Next week'])
    expect(rangePresets('2026-06-01', HOL).map((p) => p.label)).toEqual(['Next week'])
  })
})

describe('rangeSummary', () => {
  it('counts Thanksgiving week as 3 workdays', () => {
    const s = rangeSummary('2026-11-23', '2026-11-27', HOL, undefined, 8)
    expect(s.text).toBe('3 workdays, 24 hours')
    expect(s.holidaysSkipped.map((h) => h.date)).toEqual(['2026-11-26', '2026-11-27'])
    expect(s.weekendDays).toBe(0)
  })

  it('skips weekends, handles half days and part-time days', () => {
    expect(rangeSummary('2026-10-09', '2026-10-13', HOL, undefined, 8)).toMatchObject({ workdays: 3, hours: 24, weekendDays: 2 })
    expect(rangeSummary('2026-10-12', '2026-10-12', HOL, 'pm', 8).text).toBe('0.5 workdays, 4 hours')
    expect(rangeSummary('2026-10-12', '2026-10-14', HOL, undefined, 4.8).text).toBe('3 workdays, 14.4 hours')
    expect(rangeSummary('2026-10-10', '2026-10-11', HOL, undefined, 8).text).toBe('No workdays in that range')
    expect(rangeSummary('2026-10-12', '2026-10-09', HOL, undefined, 8).workdays).toBe(0)
  })
})

describe('text helpers', () => {
  it('formats ranges and hours', () => {
    expect(rangeText('2026-10-30', '2026-10-30')).toBe('Fri, Oct 30')
    expect(rangeText('2026-10-12', '2026-10-16')).toBe('Mon, Oct 12 to Fri, Oct 16')
    expect(rangeText('2026-12-21', '2027-01-08')).toBe('Mon, Dec 21, 2026 to Fri, Jan 8, 2027')
    expect(shortRange('2026-10-12', '2026-10-16')).toBe('Oct 12 to 16')
    expect(shortRange('2026-12-21', '2027-01-08')).toBe('Dec 21 to Jan 8')
    expect(hoursWithDays(24)).toBe('24 hours (3 days)')
    expect(hoursWithDays(14.4, 4.8)).toBe('14.4 hours (3 days)')
    expect(hoursWithDays(0)).toBe('0 hours')
  })

  it('names the approver', () => {
    const db = buildSampleDB()
    const kofi = db.people.find((p) => p.id === 'p-kofi')
    const maya = db.people.find((p) => p.id === 'p-founder')
    expect(kofi && approverLabel(db, kofi)).toBe('Tomas Herrera')
    expect(maya && approverLabel(db, maya)).toBe('Admin')
  })
})

describe('outByDay', () => {
  it('lists Elena on each workday of her week and nobody on weekends', () => {
    const db = buildSampleDB()
    const map = outByDay(whoIsOut(db, '2026-10-01', '2026-10-31'), '2026-10-01', '2026-10-31', db.holidays)
    for (const d of ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']) {
      expect(map.get(d)?.some((e) => e.personId === 'p-elena')).toBe(true)
    }
    expect(map.get('2026-10-17')).toBeUndefined()
    expect(map.get('2026-10-30')?.map((e) => [e.personId, e.status])).toEqual([['p-kofi', 'pending']])
  })

  it('leaves out holidays', () => {
    const entries = [{ personId: 'p', from: '2026-11-23', to: '2026-11-27', kind: 'vacation' as const, status: 'approved' as const, label: 'Vacation' }]
    const map = outByDay(entries, '2026-11-01', '2026-11-30', HOL)
    expect([...map.keys()]).toEqual(['2026-11-23', '2026-11-24', '2026-11-25'])
  })
})

describe('leave display', () => {
  const leave: LeaveCase = {
    id: 'lc-1',
    personId: 'p-tomas',
    kind: 'bonding',
    requestedOn: '2026-10-06',
    startDate: '2026-11-16',
    expectedReturn: '2027-01-11',
    designationNoticeDueOn: '2026-10-13',
  }

  it('shows the type only to permitted viewers', () => {
    expect(leaveText(leave, { type: true, line: true })).toBe('Baby bonding (CFRA), back Jan 11')
    expect(leaveText(leave, { type: false, line: true })).toBe('Leave, back Jan 11')
    expect(leaveText(leave, { type: false, line: false })).toBe('Out')
  })

  it('tracks the designation notice', () => {
    expect(designationState(leave, '2026-10-09')).toEqual({ state: 'due', text: 'Due Tue, Oct 13' })
    expect(designationState(leave, '2026-10-12').state).toBe('due_soon')
    expect(designationState(leave, '2026-10-13').text).toBe('Due today, Tue, Oct 13')
    expect(designationState(leave, '2026-10-14').state).toBe('overdue')
    expect(designationState({ ...leave, designationNoticeSentOn: '2026-10-09' }, '2026-10-20')).toEqual({ state: 'sent', text: 'Sent Oct 9, 2026' })
  })

  it('knows the phase', () => {
    expect(leavePhase(leave, '2026-10-09')).toBe('upcoming')
    expect(leavePhase(leave, '2026-12-01')).toBe('on_leave')
    expect(leavePhase({ ...leave, returnedOn: '2027-01-11' }, '2027-01-12')).toBe('returned')
  })
})

describe('entryView', () => {
  const db = buildSampleDB()
  const person = (id: string) => db.people.find((p) => p.id === id)
  const viewer = (role: 'admin' | 'manager' | 'employee', id: string) => ({ role, personId: id, person: person(id) })
  const entries = whoIsOut(db, '2026-10-01', '2027-01-31')
  const elena = entries.find((e) => e.personId === 'p-elena' && e.from === '2026-10-12')
  const kofi = entries.find((e) => e.personId === 'p-kofi' && e.status === 'pending')
  const tomasLeave = entries.find((e) => e.personId === 'p-tomas' && e.kind === 'leave')

  it('admin sees types and pending requests', () => {
    const v = viewer('admin', 'p-founder')
    expect(elena && entryView(db, v, elena)).toMatchObject({ visible: true, text: 'Vacation', detail: true })
    expect(kofi && entryView(db, v, kofi)).toMatchObject({ visible: true, pending: true })
    expect(tomasLeave && entryView(db, v, tomasLeave).text).toBe('Baby bonding (CFRA), back Jan 11')
  })

  it('a manager sees types for their line and "Leave, back" for leave', () => {
    const v = viewer('manager', 'p-tomas')
    expect(kofi && entryView(db, v, kofi)).toMatchObject({ visible: true, text: 'Vacation', pending: true })
    expect(elena && entryView(db, v, elena)).toEqual({ visible: true, text: 'Out', detail: false, pending: false })
    const founder = viewer('manager', 'p-founder')
    expect(tomasLeave && entryView(db, { ...founder, role: 'manager' }, tomasLeave).text).toBe('Leave, back Jan 11')
  })

  it('an employee sees only "Out" and no one else\'s pending requests', () => {
    const v = viewer('employee', 'p-aisha')
    expect(elena && entryView(db, v, elena).text).toBe('Out')
    expect(kofi && entryView(db, v, kofi).visible).toBe(false)
    expect(tomasLeave && entryView(db, v, tomasLeave).text).toBe('Out')
    const self = viewer('employee', 'p-tomas')
    expect(tomasLeave && entryView(db, self, tomasLeave).text).toBe('Baby bonding (CFRA), back Jan 11')
  })
})

describe('leave sheet rules', () => {
  const admin = { role: 'admin' as const, personId: 'p-founder' }
  const aisha = { role: 'employee' as const, personId: 'p-aisha' }
  const tomas = { role: 'manager' as const, personId: 'p-tomas' }

  it('lets Admin open a case for anyone and a person request only their own', () => {
    expect(leaveSheetMode(admin, undefined)).toBe('admin')
    expect(leaveSheetMode(admin, 'p-aisha')).toBe('admin')
    expect(leaveSheetMode(aisha, 'p-aisha')).toBe('self')
    expect(leaveSheetMode(tomas, 'p-tomas')).toBe('self')
    expect(leaveSheetMode(tomas, 'p-kofi')).toBe('none')
    expect(leaveSheetMode(aisha, undefined)).toBe('none')
    expect(leaveSheetMode({ role: 'employee', personId: null }, 'p-aisha')).toBe('none')
  })

  it('offers every kind to Admin and the three protected kinds to the person', () => {
    expect(leaveKindsFor('admin')).toEqual(['bonding', 'cfra', 'pdl', 'military', 'other'])
    expect(leaveKindsFor('self')).toEqual(['bonding', 'cfra', 'pdl'])
    expect(leaveKindsFor('none')).toEqual([])
  })

  it('needs a first day and an expected return after it', () => {
    expect(leaveDatesValid('2026-11-02', '2027-01-25')).toBe(true)
    expect(leaveDatesValid('2026-11-02', '2026-11-02')).toBe(false)
    expect(leaveDatesValid('2026-11-02', null)).toBe(false)
    expect(leaveDatesValid(null, '2027-01-25')).toBe(false)
  })

  it('prefills the return 12 weeks out on a workday', () => {
    // The sample: Lena's bonding leave from Mon Nov 2 is expected back Mon Jan 25, 2027.
    expect(defaultLeaveReturn('2026-11-02', HOL)).toBe('2027-01-25')
    // 12 weeks after Thu Sep 3, 2026 is Thanksgiving (Thu Nov 26); the next workday is Mon Nov 30.
    expect(defaultLeaveReturn('2026-09-03', HOL)).toBe('2026-11-30')
  })

  it("an employee's own request starts the 5-business-day notice in Admin's inbox only", () => {
    const db = buildSampleDB()
    const sat = '2026-10-10'
    const next = produce(db, (d) => {
      startLeave(d, { personId: 'p-aisha', kind: 'cfra', requestedOn: sat, startDate: '2026-10-19', expectedReturn: defaultLeaveReturn('2026-10-19', d.holidays) }, { date: sat, actorId: 'p-aisha' })
    })
    const lc = next.leaveCases.find((l) => l.personId === 'p-aisha')
    // Sat Oct 10 plus 5 business days is Fri Oct 16.
    expect(lc).toMatchObject({ kind: 'cfra', requestedOn: sat, designationNoticeDueOn: '2026-10-16', expectedReturn: '2027-01-11' })
    const person = (id: string) => next.people.find((p) => p.id === id)
    const adminItems = inboxItems(next, { role: 'admin', personId: 'p-founder', person: person('p-founder') }, sat).filter((i) => i.kind === 'leave_notice')
    expect(adminItems.some((i) => i.refs?.leaveCaseId === lc?.id && i.dueOn === '2026-10-16' && !i.statutory)).toBe(true)
    const own = inboxItems(next, { role: 'employee', personId: 'p-aisha', person: person('p-aisha') }, sat)
    expect(own.some((i) => i.kind === 'leave_notice')).toBe(false)
    // Teammates and the activity log never see the type.
    const opened = next.activity.filter((a) => a.entityId === lc?.id)
    expect(opened.every((a) => !/cfra|bonding|pregnan/i.test(a.text))).toBe(true)
  })
})

describe('leave case mutations', () => {
  it('uses the one domain implementation of the designation notice', () => {
    expect(markDesignationSent).toBe(domainMarkDesignationSent)
  })

  it('marks the designation notice sent and closes the checklist task', () => {
    const db = buildSampleDB()
    const next = produce(db, (d) => {
      expect(markDesignationSent(d, 'lc-tomas-bonding', { date: '2026-10-09', byId: 'p-jasmine' })).toBe(true)
      expect(markDesignationSent(d, 'lc-tomas-bonding', { date: '2026-10-09' })).toBe(false)
    })
    expect(next.leaveCases.find((l) => l.id === 'lc-tomas-bonding')?.designationNoticeSentOn).toBe('2026-10-09')
    const task = next.checklists.find((c) => c.id === 'ck-leave-tomas')?.tasks.find((t) => t.templateTaskId === 'lv-designation')
    expect(task).toMatchObject({ status: 'done', doneOn: '2026-10-09', doneById: 'p-jasmine' })
    const logged = next.activity.filter((a) => a.entityId === 'lc-tomas-bonding' && a.kind === 'leave_notice_sent')
    expect(logged).toHaveLength(1)
    expect(logged[0].text).not.toMatch(/bonding|CFRA/i)
  })

  it('records the return and closes the return-to-work check', () => {
    const db = buildSampleDB()
    const next = produce(db, (d) => {
      expect(markReturned(d, 'lc-tomas-bonding', { date: '2027-01-11' })).toBe(true)
    })
    expect(next.leaveCases.find((l) => l.id === 'lc-tomas-bonding')?.returnedOn).toBe('2027-01-11')
    const task = next.checklists.find((c) => c.id === 'ck-leave-tomas')?.tasks.find((t) => t.templateTaskId === 'lv-return')
    expect(task?.status).toBe('done')
    expect(whoIsOut(next, '2027-01-11', '2027-01-15').some((e) => e.personId === 'p-tomas')).toBe(false)
  })
})

describe('holidays', () => {
  it('lists, copies and exports a year', () => {
    expect(holidaysForYear(HOL, 2026)).toHaveLength(11)
    expect(holidaysForYear(HOL, 2027)).toHaveLength(11)
    const text = holidaysText(HOL, 'Ledgerlark', 2026)
    expect(text.split('\n')[0]).toBe('Ledgerlark holidays 2026')
    expect(text).toContain('Thu, Nov 26: Thanksgiving')
    const ics = holidaysICS(HOL, 'Ledgerlark', 2027)
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(11)
    expect(ics).toContain('DTSTART;VALUE=DATE:20271125')
    expect(ics).toContain('DTEND;VALUE=DATE:20271126')
  })
})

describe('approval routing', () => {
  it('groups requests by who approves them, the same way the inbox routes them', () => {
    const db = buildSampleDB()
    const admin = { role: 'admin' as const, personId: 'p-founder' }
    const pending = db.timeOffRequests.filter((r) => r.status === 'pending')
    const kofi = pending.find((r) => r.personId === 'p-kofi')
    if (!kofi) throw new Error('no pending request for Kofi')
    // Caleb reports to the founder; Kofi reports to Tomas, who approves his Oct 30 request.
    const groups = approvalGroups(db, admin, pending, FRI)
    expect(groups.map((g) => [g.label, g.requests.map((r) => r.personId)])).toEqual([
      ['Waiting for you', ['p-caleb']],
      ['Waiting on Tomas', ['p-kofi']],
    ])
    expect(waitingOnManager(db, admin, kofi, FRI)?.id).toBe('p-tomas')
    // The Admin inbox leaves Kofi's request to Tomas too (it shows only within a week of the start)
    const founder = db.people.find((p) => p.id === 'p-founder')
    const mine = inboxItems(db, { role: 'admin', personId: 'p-founder', person: founder }, FRI).filter((i) => i.kind === 'timeoff' && i.waitingOn === 'you')
    expect(mine.every((i) => groups[0].requests.some((r) => r.id === i.refs?.requestId))).toBe(true)
    // Tomas sees it as his own
    expect(approvalGroups(db, { role: 'manager', personId: 'p-tomas' }, [kofi], FRI).map((g) => [g.label, g.requests.length])).toEqual([['Waiting for you', 1]])
    // With Tomas gone, it comes back to Admin
    const gone = produce(db, (d) => {
      const tomas = d.people.find((p) => p.id === 'p-tomas')
      if (tomas) tomas.endDate = '2026-10-01'
    })
    expect(approvalGroups(gone, admin, pending, FRI).map((g) => g.label)).toEqual(['Waiting for you'])
    // Sick leave before the 90-day wait is always Admin's call
    expect(waitingOnManager(db, admin, { ...kofi, policyId: 'pol-sick' }, FRI)).toBeNull()
  })

  it('keeps an empty "Waiting for you" group first', () => {
    const db = buildSampleDB()
    const kofi = db.timeOffRequests.filter((r) => r.status === 'pending' && r.personId === 'p-kofi')
    const groups = approvalGroups(db, { role: 'admin', personId: 'p-founder' }, kofi, FRI)
    expect(groups.map((g) => [g.label, g.requests.length])).toEqual([
      ['Waiting for you', 0],
      ['Waiting on Tomas', 1],
    ])
  })
})
