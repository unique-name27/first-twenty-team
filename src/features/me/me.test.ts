import { produce } from 'immer'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildSampleDB } from '@/data/seed'
import type { DB } from '@/domain/types'
import { setClockOverride } from '@/lib/dates'
import { daysFromHours, hoursNum, hoursText, hoursWithDays, plural } from '@/lib/format'
import {
  acknowledgePolicy,
  changedFields,
  cityError,
  contactErrors,
  contactInfoErrors,
  contactInfoOf,
  emailError,
  phoneError,
  removeContact,
  saveEmergencyContacts,
  sb294Index,
  upsertContact,
  withSb294Choice,
} from './profile'
import { stateName, US_STATES } from './states'
import {
  availabilityText,
  coveredByTasks,
  daysAwayText,
  equityHeadline,
  greetingFor,
  isDueSoon,
  myPay,
  myTaskItems,
  payrollProviderName,
  myTodos,
  nextAnniversary,
  nextStarter,
  nextTimeOff,
  policyStatuses,
  rangeText,
  sameVersion,
  startingThisMonth,
  summaryHTML,
  summaryModel,
  summaryText,
  taskCounts,
  teammatesOut,
  tenureText,
  todoCount,
  trainingStatusText,
  upcomingHolidays,
  vacationAndSick,
} from './summary'

const D = '2026-10-09'
const NOW = '2026-10-10T03:00:00.000Z' // Friday evening, Oct 9, in California
let db: DB

beforeAll(() => {
  setClockOverride(D)
  db = buildSampleDB()
})
afterAll(() => setClockOverride(null))

describe('text helpers', () => {
  it('greets by time of day', () => {
    expect(greetingFor(8)).toBe('Good morning')
    expect(greetingFor(13)).toBe('Good afternoon')
    expect(greetingFor(20)).toBe('Good evening')
    expect(greetingFor(2)).toBe('Good evening')
  })

  it('writes ranges and distances in plain words', () => {
    expect(rangeText('2026-10-12', '2026-10-16')).toBe('Mon, Oct 12 to Fri, Oct 16')
    expect(rangeText('2026-10-12', '2026-10-12')).toBe('Mon, Oct 12')
    expect(daysAwayText(D, D)).toBe('today')
    expect(daysAwayText(D, '2026-10-10')).toBe('tomorrow')
    expect(daysAwayText(D, '2026-11-01')).toBe('in 23 days')
    expect(daysAwayText(D, '2026-10-07')).toBe('2 days ago')
  })

  it('describes tenure', () => {
    expect(tenureText('2026-09-08', D)).toBe('1 month')
    expect(tenureText('2025-02-03', D)).toBe('1 year, 8 months')
    expect(tenureText('2026-09-25', D)).toBe('2 weeks')
    expect(tenureText(D, D)).toBe('First day')
    expect(tenureText('2026-10-19', D)).toBe('Starts in 10 days')
  })

  it('finds the next work anniversary', () => {
    expect(nextAnniversary('2026-09-08', D)).toEqual({ date: '2027-09-08', years: 1 })
    expect(nextAnniversary('2025-10-06', D)).toEqual({ date: '2027-10-06', years: 2 })
    expect(nextAnniversary('2025-10-09', D)).toEqual({ date: '2026-10-09', years: 1 })
    expect(nextAnniversary('2025-10-20', D)).toEqual({ date: '2026-10-20', years: 1 })
    expect(nextAnniversary('2024-02-29', '2026-01-10')).toEqual({ date: '2026-02-28', years: 2 })
    expect(nextAnniversary('2026-10-19', D)).toBeNull()
  })

  it('compares policy versions loosely', () => {
    expect(sameVersion('2.0', 'v2')).toBe(true)
    expect(sameVersion('2.1', '2.1.0')).toBe(true)
    expect(sameVersion('2.0', '2.1')).toBe(false)
  })
})

describe('my tasks', () => {
  it('lists what Aisha owes: overdue security training and the handbook 2.0 acknowledgement', () => {
    const todos = myTodos(db, 'p-aisha', D, NOW)
    const titles = todos.map((t) => t.title)
    expect(titles[0]).toMatch(/security awareness training was due/i)
    expect(todos[0].overdue).toBe(true)
    expect(todos.find((t) => t.kind === 'policy')?.title).toMatch(/Employee handbook \(v2\.0\)/)
    // The onboarding copy of the security training and the training itself are one task, not three.
    expect(titles.filter((t) => /security awareness/i.test(t))).toHaveLength(1)
    expect(titles.filter((t) => /handbook/i.test(t))).toHaveLength(1)
    expect(titles.filter((t) => /harassment/i.test(t))).toHaveLength(1)
    // Admin and manager items (DE 34, 90-day check-in) are not hers.
    expect(titles.some((t) => /DE 34|check-in/i.test(t))).toBe(false)
    expect(todoCount(todos)).toBe(2)
  })

  it('builds one list with each task once, and counts it the same way everywhere', () => {
    const items = myTaskItems(db, 'p-aisha', D, NOW)
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length)
    // Harassment training is due in March: in the list, but later, so it does not count as needing her now.
    const harassment = items.find((i) => /harassment/i.test(i.title))
    expect(harassment?.dueOn).toBe('2027-03-08')
    expect(isDueSoon(harassment ?? {}, D)).toBe(false)
    expect(taskCounts(items, D)).toEqual({ soon: 2, later: items.length - 2 })
    expect(todoCount(myTodos(db, 'p-aisha', D, NOW))).toBe(taskCounts(items, D).soon)
    // The reference lists know which policies and trainings the list already holds.
    const covered = coveredByTasks(db, 'p-aisha', items)
    expect([...covered.policies]).toEqual(['pl-handbook'])
    expect(covered.trainings.has('security_awareness')).toBe(true)
    expect(covered.trainings.has('harassment_employee')).toBe(true)
    expect(covered.trainings.has('wvpp')).toBe(false)
  })

  it('keeps later tasks in the list instead of saying nothing needs you', () => {
    // Maya's manager tasks are all more than 30 days out: listed as later, not an empty list.
    const items = myTaskItems(db, 'p-founder', D, NOW)
    expect(items.length).toBeGreaterThanOrEqual(3)
    expect(taskCounts(items, D).soon).toBe(0)
    expect(items.every((i) => i.group === 'coming_up' && i.waitingOn === 'you')).toBe(true)
    const m = summaryModel(db, 'p-founder', D, NOW)
    expect(m && summaryText(m)).toContain(`Nothing due in the next 30 days (${plural(items.length, 'task')} later)`)
    // A manager's tasks on a report's checklist count toward their own tasks.
    const tomas = myTaskItems(db, 'p-tomas', D, NOW)
    expect(tomas.some((i) => /welcome email/i.test(i.title) && isDueSoon(i, D))).toBe(true)
  })

  it('gives each row one action that does what the task needs', () => {
    const lucas = myTaskItems(db, 'p-lucas', D, NOW)
    const contacts = lucas.find((i) => i.refs.taskId && /emergency/i.test(i.title))
    expect(contacts?.primary).toMatchObject({ kind: 'navigate', label: 'Add contacts' })
    expect(contacts?.more?.[0]).toMatchObject({ kind: 'mutate', label: 'Mark done' })
    const ack = lucas.find((i) => /handbook/i.test(i.title))
    if (ack) expect(ack.primary).toMatchObject({ kind: 'mutate', label: 'Acknowledge' })
    // Someone starting soon still sees every policy they owe, once: the handbook and security policy
    // through their onboarding tasks, the others as acknowledgements of their own.
    const owed = policyStatuses(db, 'p-lucas', D).filter((r) => r.owed).map((r) => r.policy.id)
    const covered = coveredByTasks(db, 'p-lucas', lucas).policies
    expect(owed.every((id) => covered.has(id))).toBe(true)
    expect(lucas.filter((i) => i.kind === 'ack').map((i) => i.refs.policyId).sort()).toEqual(owed.filter((id) => id !== 'pl-handbook' && id !== 'pl-aup').sort())
    expect(new Set(lucas.map((i) => i.key)).size).toBe(lucas.length)
    // Scorecards appear once each.
    const hannah = myTaskItems(db, 'p-hannah', D, NOW).filter((i) => i.kind === 'scorecard')
    expect(hannah.length).toBe(2)
  })

  it('words training status for the reference list', () => {
    const base = { kind: 'security_awareness', course: 'security_awareness', title: 'Security awareness', required: true, recommended: false, reason: '' } as const
    expect(trainingStatusText({ ...base, status: 'done', nextDueOn: '2027-05-14' }, D)).toEqual({ label: 'Done, next by Fri, May 14, 2027', tone: 'good' })
    expect(trainingStatusText({ ...base, status: 'overdue', dueOn: '2026-10-08' }, D)).toEqual({ label: 'Overdue since Thu, Oct 8', tone: 'warn' })
    expect(trainingStatusText({ ...base, kind: 'harassment_employee', course: 'harassment', status: 'overdue', dueOn: '2026-09-16' }, D).tone).toBe('bad')
    expect(trainingStatusText({ ...base, kind: 'wvpp', course: 'wvpp', status: 'due' }, D).label).toBe('Waiting on plan')
    expect(trainingStatusText({ ...base, status: 'not_required', required: false }, D).label).toBe('Not required')
  })

  it('counts scorecards an interviewer owes', () => {
    const todos = myTodos(db, 'p-hannah', D, NOW)
    expect(todos.some((t) => t.kind === 'scorecard')).toBe(true)
  })

  it('knows where each policy stands', () => {
    const rows = policyStatuses(db, 'p-aisha', D)
    const handbook = rows.find((r) => r.policy.id === 'pl-handbook')
    expect(handbook?.owed).toBe(true)
    expect(handbook?.previousVersionOn).toBe('2026-09-08')
    expect(handbook?.dueOn).toBe('2026-10-15')
    expect(rows.filter((r) => r.owed)).toHaveLength(1)
    expect(rows[0].owed).toBe(true)
  })

  it('treats the confidentiality agreement acknowledgement and the signed PIIA as one document', () => {
    const piiaOf = (d: DB) => d.checklists.find((c) => c.personId === 'p-lucas' && c.kind === 'onboarding')?.tasks.find((t) => t.templateTaskId === 'on-piia')
    const next = produce(db, (d) => {
      const piia = piiaOf(d as DB)
      if (!piia) throw new Error('no PIIA task')
      piia.status = 'open'
      delete piia.doneOn
      delete piia.doneById
      d.acks = d.acks.filter((a) => !(a.personId === 'p-lucas' && a.policyId === 'pl-confidentiality'))
      expect(acknowledgePolicy(d, 'pl-confidentiality', 'p-lucas', D)).not.toBeNull()
    })
    expect(piiaOf(next)).toMatchObject({ status: 'done', doneOn: D })
  })

  it('acknowledges the current version and closes the matching onboarding item', () => {
    const lucasTask = () => db.checklists.find((c) => c.personId === 'p-lucas')?.tasks.find((t) => t.templateTaskId === 'on-ack-handbook')
    const next = produce(db, (d) => {
      expect(acknowledgePolicy(d, 'pl-handbook', 'p-aisha', D)).not.toBeNull()
      // Twice is a no-op.
      expect(acknowledgePolicy(d, 'pl-handbook', 'p-aisha', D)).toBeNull()
      expect(acknowledgePolicy(d, 'pl-missing', 'p-aisha', D)).toBeNull()
      if (lucasTask()?.status === 'open') acknowledgePolicy(d, 'pl-handbook', 'p-lucas', D)
    })
    const ack = next.acks.find((a) => a.personId === 'p-aisha' && a.policyId === 'pl-handbook' && a.version === '2.0')
    expect(ack?.acknowledgedOn).toBe(D)
    expect(policyStatuses(next, 'p-aisha', D).some((r) => r.owed)).toBe(false)
    expect(todoCount(myTodos(next, 'p-aisha', D, NOW))).toBe(1)
    expect(next.activity.some((a) => a.text === 'Acknowledged Employee handbook 2.0')).toBe(true)
    if (lucasTask()?.status === 'open') {
      const t = next.checklists.find((c) => c.personId === 'p-lucas')?.tasks.find((x) => x.templateTaskId === 'on-ack-handbook')
      expect(t?.status).toBe('done')
    }
  })
})

describe('time off on the summary', () => {
  it('keeps vacation and California sick leave apart', () => {
    const { vacation, sick } = vacationAndSick(db, 'p-aisha', D)
    expect(vacation?.name).toBe('Vacation')
    expect(sick?.name).toBe('Sick leave')
    expect(sick?.value).toBe('40 hours')
    expect(sick?.days).toBe('5 days')
    expect(sick?.text).toBe('40 hours (5 days)')
    // Granted but not usable before the 90-day wait ends, so never called available
    expect(sick?.usableFrom).toBe('2026-12-06')
    expect(sick && availabilityText(sick)).toBe('5 days, usable from Dec 6, 2026')
    expect(vacation && availabilityText(vacation)).toMatch(/ available$/)
  })

  it('writes balances as hours to one decimal with days, the same way as the rest of the app', () => {
    const { vacation, sick } = vacationAndSick(db, 'p-founder', D)
    // Accrued vacation has a long tail of decimals; it shows as 127.3, never 127.33.
    expect(vacation?.value).toMatch(/^\d+(\.\d)? hours$/)
    expect(vacation?.text).toBe(hoursWithDays(vacation?.hours ?? 0))
    expect(sick?.text).toBe('40 hours (5 days)')
    expect(hoursWithDays(127.333)).toBe('127.3 hours (15.9 days)')
    expect(hoursWithDays(40)).toBe('40 hours (5 days)')
    expect(hoursWithDays(14.4, 4.8)).toBe('14.4 hours (3 days)')
    expect(hoursWithDays(8)).toBe('8 hours (1 day)')
    expect(hoursWithDays(1)).toBe('1 hour (0.1 days)')
    expect(hoursWithDays(0)).toBe('0 hours')
    expect(hoursText(7.666)).toBe('7.7 hours')
    expect(hoursNum(127.33)).toBe('127.3')
    expect(hoursNum(40)).toBe('40')
    expect(daysFromHours(62.33)).toBe('7.8 days')
  })

  it('finds the next booked time off, including leave', () => {
    expect(nextTimeOff(db, 'p-elena', D)).toMatchObject({ from: '2026-10-12', to: '2026-10-16', status: 'approved' })
    expect(nextTimeOff(db, 'p-caleb', D)).toMatchObject({ from: '2026-11-23', status: 'pending' })
    expect(nextTimeOff(db, 'p-tomas', D)).toMatchObject({ from: '2026-11-16', status: 'leave' })
    expect(nextTimeOff(db, 'p-aisha', D)).toBeNull()
  })

  it('shows who is out with no type and no pending requests', () => {
    const out = teammatesOut(db, 'p-aisha', D, '2026-10-15')
    expect(out.map((o) => o.name)).toEqual(['Elena Vasquez'])
    expect(out[0]).toMatchObject({ from: '2026-10-12', to: '2026-10-16' })
    expect(Object.keys(out[0]).sort()).toEqual(['from', 'name', 'personId', 'to'])
    // Kofi's Oct 30 request is pending, so it stays private.
    expect(teammatesOut(db, 'p-aisha', '2026-10-30', '2026-10-30')).toEqual([])
    // People do not see themselves in the list.
    expect(teammatesOut(db, 'p-elena', D, '2026-10-15')).toEqual([])
  })

  it('lists upcoming holidays and teammates starting this month', () => {
    expect(upcomingHolidays(db, D).map((h) => h.name)).toEqual(['Thanksgiving', 'Day after Thanksgiving', 'Christmas Eve'])
    expect(startingThisMonth(db, 'p-aisha', D).map((p) => p.firstName)).toEqual(['Lucas'])
    expect(startingThisMonth(db, 'p-lucas', D)).toEqual([])
    expect(nextStarter(db, 'p-lucas', D)?.firstName).toBe('Mei')
  })
})

describe('equity headline', () => {
  it('says the grant is awaiting board consent', () => {
    const h = equityHeadline(db, 'p-aisha', D)
    expect(h?.title).toBe('Grant awaiting board consent')
    expect(h?.cliffOn).toBe('2027-09-08')
    expect(h?.cliffShares).toBe(3000)
  })

  it('counts down to the cliff', () => {
    const h = equityHeadline(db, 'p-sofia', D)
    expect(h?.title).toBe('Cliff in 95 days')
    expect(h?.cliffDays).toBe(95)
    expect(equityHeadline(db, 'p-sofia', '2027-01-11')?.title).toBe('Cliff tomorrow')
    expect(equityHeadline(db, 'p-sofia', '2027-01-12')?.title).toBe('Next vest in 31 days')
    expect(equityHeadline(db, 'p-tomas', D)?.title).toBe('Next vest in 3 days')
  })

  it('says when vesting stops for someone whose last day is ahead', () => {
    const leaving = produce(db, (d) => {
      d.people.find((p) => p.id === 'p-tomas')!.endDate = '2026-11-30'
    })
    expect(equityHeadline(leaving, 'p-tomas', D)).toMatchObject({ status: 'leaving', title: 'Vesting stops Mon, Nov 30' })
  })

  it('has nothing to say without a grant', () => {
    expect(equityHeadline(db, 'p-founder', D)).toBeNull()
    expect(equityHeadline(db, 'p-luis', D)).toBeNull()
  })
})

describe('pay and printable summary', () => {
  it('finds pay and the band for the position', () => {
    const pay = myPay(db, 'p-aisha', D)
    expect(pay?.base).toBe(140000)
    expect(pay?.band).toBeDefined()
    expect(pay?.position).toBeGreaterThanOrEqual(0)
    expect(pay?.position).toBeLessThanOrEqual(1)
    expect(myPay(db, 'p-luis', D)?.record.payType).toBe('hourly')
  })

  it('builds a summary for copy and print', () => {
    const m = summaryModel(db, 'p-aisha', D, NOW)
    expect(m).not.toBeNull()
    if (!m) return
    const text = summaryText(m)
    expect(text).toContain('My summary: Aisha Bello')
    expect(text).toContain('employee #15')
    expect(text).toContain('Base: $140,000 a year, plus 10% variable at target')
    expect(text).toContain('Grant awaiting board consent')
    expect(text).toContain('Sick leave: 40 hours (5 days), usable from Dec 6, 2026.')
    expect(text).toContain('Tunde Bello (Sibling)')
    expect(text).toContain('notify if I am arrested or detained at work')
    const hidden = summaryText(m, { hideAmounts: true })
    expect(hidden).not.toContain('$140,000')
    expect(hidden).not.toContain('12,000')
    const html = summaryHTML(m)
    expect(html).toContain('<h1>My summary: Aisha Bello</h1>')
    expect(html).not.toMatch(/<script/i)
  })

  it('names the payroll provider only when one is set', () => {
    const named = (name: string) =>
      payrollProviderName(
        produce(db, (d) => {
          d.company.payrollProvider.name = name
        }),
      )
    expect(named('Justworks')).toBe('Justworks')
    expect(named('  Gusto ')).toBe('Gusto')
    // Start fresh leaves the name empty; older workspaces kept the form placeholder as the name
    expect(named('')).toBeNull()
    expect(named('Your payroll or PEO provider')).toBeNull()
  })

  it('escapes names in the print view', () => {
    const evil = produce(db, (d) => {
      const p = d.people.find((x) => x.id === 'p-aisha')
      if (p) p.emergencyContacts = [{ name: '<b>Bob</b>', relation: 'Friend', phone: '555 0100' }]
    })
    const m = summaryModel(evil, 'p-aisha', D, NOW)
    expect(m && summaryHTML(m)).toContain('&lt;b&gt;Bob&lt;/b&gt;')
  })
})

describe('profile validation', () => {
  it('checks phones, emails and cities', () => {
    expect(phoneError('(408) 555-0116')).toBeNull()
    expect(phoneError('+1 408 555 0116')).toBeNull()
    expect(phoneError('')).toBeNull()
    expect(phoneError('', true)).toMatch(/Add a phone/)
    expect(phoneError('555')).toMatch(/full phone number/)
    expect(phoneError('call me')).toMatch(/digits/)
    expect(emailError('aisha@example.com')).toBeNull()
    expect(emailError('aisha@')).toMatch(/name@example.com/)
    expect(cityError('San Jose')).toBeNull()
    expect(cityError('123 Main St')).toMatch(/not a street address/)
    expect(cityError('San Jose 95113')).toMatch(/ZIP/)
  })

  it('validates the contact form and names what changed', () => {
    const p = db.people.find((x) => x.id === 'p-aisha')
    if (!p) throw new Error('missing')
    const info = contactInfoOf(p)
    expect(contactInfoErrors(info)).toEqual({})
    expect(contactInfoErrors({ ...info, homeState: '' }).homeState).toBeDefined()
    expect(changedFields(info, { ...info, phone: '408 555 0100', homeCity: 'Campbell' })).toEqual(['phone', 'home city'])
    expect(changedFields(info, { ...info, preferredName: '  ' })).toEqual([])
  })

  it('keeps exactly one SB 294 contact', () => {
    const contacts = [
      { name: 'A', relation: 'Parent', phone: '408 555 0101', sb294Notify: true },
      { name: 'B', relation: 'Friend', phone: '408 555 0102' },
    ]
    expect(sb294Index(contacts)).toBe(0)
    const moved = withSb294Choice(contacts, 1)
    expect(sb294Index(moved)).toBe(1)
    expect(moved.filter((c) => c.sb294Notify)).toHaveLength(1)
    expect(sb294Index(withSb294Choice(contacts, null))).toBeNull()
    // Editing a contact keeps the choice; removing it drops the choice.
    const edited = upsertContact(contacts, 0, { name: 'A2', relation: 'Parent', phone: '408 555 0109' })
    expect(edited[0]).toEqual({ name: 'A2', relation: 'Parent', phone: '408 555 0109', sb294Notify: true })
    expect(upsertContact(contacts, null, { name: ' C ', relation: 'Sibling', phone: '408 555 0103' })[2]).toEqual({ name: 'C', relation: 'Sibling', phone: '408 555 0103' })
    expect(sb294Index(removeContact(contacts, 0))).toBeNull()
    expect(contactErrors({ name: '', relation: '', phone: '' })).toEqual({ name: 'Add a name.', relation: 'Pick how you know them.', phone: 'Add a phone number.' })
  })

  it('marks the emergency contacts onboarding item done once a contact is saved', () => {
    const task = (d: DB) => d.checklists.find((c) => c.personId === 'p-lucas')?.tasks.find((t) => t.templateTaskId === 'on-emergency-contacts')
    expect(task(db)?.status).toBe('open')
    expect(myTodos(db, 'p-lucas', D, NOW).some((t) => t.templateTaskId === 'on-emergency-contacts')).toBe(true)
    const next = produce(db, (d) => {
      saveEmergencyContacts(d, 'p-lucas', [{ name: 'Ana Ferreira', relation: 'Spouse or partner', phone: '650 555 0101' }], 'Added an emergency contact in Me', D)
    })
    expect(next.people.find((p) => p.id === 'p-lucas')?.emergencyContacts).toHaveLength(1)
    expect(task(next)?.status).toBe('done')
    expect(task(next)?.doneOn).toBe(D)
    // Removing every contact does not complete it.
    const empty = produce(db, (d) => {
      saveEmergencyContacts(d, 'p-lucas', [], 'Removed an emergency contact in Me', D)
    })
    expect(task(empty)?.status).toBe('open')
  })

  it('lists every state with its code', () => {
    expect(US_STATES).toHaveLength(51)
    expect(stateName('CA')).toBe('California')
    expect(stateName('TX')).toBe('Texas')
  })
})
