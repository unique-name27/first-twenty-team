// Comp and plan > Pay runs: which period opens, status words, estimate and time off wording, what changed, the
// check list, who submitted, and the regular paydays notice (Labor Code 207).
import { describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import { payRunPrep, periodStarting } from '@/domain/payrun'
import type { CompRecord, DB, Offer, Person } from '@/domain/types'
import {
  changeLines,
  checkList,
  estimateNote,
  flagWord,
  grossFooter,
  neighborPeriods,
  paydayNoticeHTML,
  paydayNoticeText,
  periodChoices,
  periodStatusShort,
  periodStatusWord,
  rowNotes,
  selectedPeriod,
  submittedText,
  timeOffText,
  upcomingPaydays,
} from './payRunView'

const D = '2026-10-12'

function mkPerson(id: string, over: Partial<Person> = {}): Person {
  return {
    id,
    firstName: id.slice(2, 3).toUpperCase() + id.slice(3),
    lastName: 'Test',
    workEmail: `${id.slice(2)}@testco.com`,
    title: 'Engineer',
    departmentId: 'd-eng',
    familyId: 'f-eng',
    levelId: 'lv-l3',
    managerId: 'p-founder',
    locationId: 'loc-hq',
    workMode: 'hybrid',
    homeState: 'CA',
    employmentType: 'full_time',
    hoursPerWeek: 40,
    flsa: 'exempt',
    exemptionBasis: 'professional',
    startDate: '2026-01-05',
    hireNumber: 2,
    emergencyContacts: [],
    ...over,
  }
}

function mkComp(personId: string, effectiveOn: string, salary: number, over: Partial<CompRecord> = {}): CompRecord {
  return { id: `cr-${personId}-${effectiveOn}`, personId, effectiveOn, payType: 'salary', salary, title: 'Engineer', levelId: 'lv-l3', reason: 'hire', ...over }
}

/**
 * Founder; Ravi starting Mon Oct 26 with a $10,000 sign-on bonus; Kwame's raise on Wed Oct 21; Elena with vacation;
 * Ben leaving Fri Oct 23 (terminated, so final pay is due that day, before the Oct 30 payday).
 */
function db(): DB {
  const d = blankDB({ companyName: 'Testco', founderFirstName: 'Maya', founderLastName: 'Raman', foundedOn: '2025-02-03' })
  d.company.legalName = 'Testco, Inc.'
  d.people.push(
    mkPerson('p-ravi', { firstName: 'Ravi', hireNumber: 5, startDate: '2026-10-26', fromApplicationId: 'a-ravi' }),
    mkPerson('p-kwame', { firstName: 'Kwame', hireNumber: 3 }),
    mkPerson('p-elena', { firstName: 'Elena', hireNumber: 2 }),
    mkPerson('p-ben', { firstName: 'Ben', hireNumber: 4, endDate: '2026-10-23', separation: { type: 'terminated', reason: 'Role eliminated', lastDay: '2026-10-23' } }),
  )
  d.comp.push(
    mkComp('p-founder', '2025-02-03', 150_000),
    mkComp('p-ravi', '2026-10-26', 245_000),
    mkComp('p-kwame', '2026-01-05', 172_000),
    mkComp('p-kwame', '2026-10-21', 192_000, { reason: 'merit' }),
    mkComp('p-elena', '2026-01-05', 200_000),
    mkComp('p-ben', '2026-01-05', 165_000),
  )
  d.offers.push({ id: 'o-ravi', applicationId: 'a-ravi', version: 1, status: 'accepted', signOnBonus: 10_000, personId: 'p-ravi' } as Offer)
  d.timeOffRequests.push({ id: 'tr-1', personId: 'p-elena', policyId: 'pol-vacation', startDate: '2026-10-19', endDate: '2026-10-20', hours: 16, status: 'approved', requestedOn: '2026-10-01' })
  return d
}

function prepFor(d: DB, start: string) {
  const p = periodStarting(d, start)
  if (!p) throw new Error(`no period ${start}`)
  return payRunPrep(d, p, D)
}

describe('which period the page shows', () => {
  it("opens the route's period, else the next payroll to run, else today's", () => {
    const d = db()
    expect(selectedPeriod(d, '2026-11-01', D).start).toBe('2026-11-01')
    // Mon Oct 12: the next payday (Thu Oct 15) pays Oct 1-15.
    expect(selectedPeriod(d, undefined, D).start).toBe('2026-10-01')
    // A date that starts no period, or a mangled segment, falls back the same way.
    expect(selectedPeriod(d, '2026-10-02', D).start).toBe('2026-10-01')
    expect(selectedPeriod(d, 'oops', D).start).toBe('2026-10-01')
    expect(selectedPeriod(d, undefined, '2026-10-16').start).toBe('2026-10-16')
  })

  it('opens the next payroll to run, not a period already submitted', () => {
    const d = db()
    // Oct 1-15 marked submitted on Mon Oct 12: the page opens on Oct 16-31, whose payday is the next one to run.
    d.company.payRuns = [{ periodStart: '2026-10-01', periodEnd: '2026-10-15', payday: '2026-10-15', submittedOn: D }]
    expect(selectedPeriod(d, undefined, D).start).toBe('2026-10-16')
    // With nobody paid at all there is no payroll to run: the next payday.
    const blank = blankDB({ companyName: 'Solo', founderFirstName: 'Maya', founderLastName: 'Raman', foundedOn: '2026-10-12' })
    expect(selectedPeriod(blank, undefined, D).start).toBe('2026-10-01')
  })

  it('offers six periods back and six ahead, plus the one shown, and its neighbors', () => {
    const d = db()
    const list = periodChoices(d, D)
    expect(list).toHaveLength(13)
    expect(list[0].start).toBe('2026-07-01')
    expect(list[6].start).toBe('2026-10-01')
    expect(list[12].start).toBe('2027-01-01')
    const far = periodStarting(d, '2027-06-01')
    expect(far && periodChoices(d, D, far).at(-1)?.start).toBe('2027-06-01')
    const oct = periodStarting(d, '2026-10-16')
    expect(oct && neighborPeriods(d, oct)).toMatchObject({ prev: { start: '2026-10-01' }, next: { start: '2026-11-01' } })
  })
})

describe('a new company with nobody paid yet', () => {
  it("says 'No payroll' for periods before anyone is paid, and starts the picker at today's period", () => {
    // The founder starts Mon Oct 12 with no pay yet.
    const d = blankDB({ companyName: 'Solo', founderFirstName: 'Maya', founderLastName: 'Raman', foundedOn: '2026-10-12' })
    const oct1 = periodStarting(d, '2026-10-01')
    if (!oct1) throw new Error('no period')
    expect(periodStatusWord(d, oct1, D)).toEqual({ label: 'No payroll', tone: 'neutral' })
    const list = periodChoices(d, D)
    expect(list[0].start).toBe('2026-10-01')
    expect(list).toHaveLength(7)
    // Once the founder is paid from Nov 2, that period runs normally and the picker starts at today's period still.
    d.comp.push(mkComp('p-founder', '2026-11-02', 120_000))
    const nov1 = periodStarting(d, '2026-11-01')
    if (!nov1) throw new Error('no period')
    expect(periodStatusWord(d, nov1, D).label).toBe('Upcoming')
    expect(periodStatusWord(d, oct1, D).label).toBe('No payroll')
    expect(periodChoices(d, D)[0].start).toBe('2026-10-01')
  })

  it('starts the picker at the first paid period when that is less than six periods back', () => {
    const d = blankDB({ companyName: 'Young', founderFirstName: 'Maya', founderLastName: 'Raman', foundedOn: '2026-08-03' })
    d.comp.push(mkComp('p-founder', '2026-09-01', 120_000))
    expect(periodChoices(d, D).map((p) => p.start).slice(0, 3)).toEqual(['2026-09-01', '2026-09-16', '2026-10-01'])
  })
})

describe('status words', () => {
  it('says Submitted, Run by, Cutoff passed, Not marked or Upcoming', () => {
    const d = db()
    const oct1 = periodStarting(d, '2026-10-01')
    const oct2 = periodStarting(d, '2026-10-16')
    const dec = periodStarting(d, '2026-12-01')
    if (!oct1 || !oct2 || !dec) throw new Error('no period')
    expect(periodStatusWord(d, oct1, D)).toEqual({ label: 'Run by Tue, Oct 13', tone: 'accent' })
    expect(periodStatusWord(d, oct1, '2026-10-14')).toEqual({ label: 'Cutoff passed', tone: 'warn' })
    expect(periodStatusWord(d, oct1, '2026-10-16')).toEqual({ label: 'Not marked', tone: 'outline' })
    expect(periodStatusWord(d, dec, D)).toEqual({ label: 'Upcoming', tone: 'outline' })
    // More than two weeks out is Upcoming; from Fri Oct 16 the Oct 28 cutoff shows.
    expect(periodStatusWord(d, oct2, D).label).toBe('Upcoming')
    expect(periodStatusWord(d, oct2, '2026-10-16').label).toBe('Run by Wed, Oct 28')
    d.company.payRuns = [{ periodStart: '2026-10-01', periodEnd: '2026-10-15', payday: '2026-10-15', submittedOn: '2026-10-13', submittedById: 'p-founder' }]
    expect(periodStatusWord(d, oct1, '2026-10-16')).toEqual({ label: 'Submitted', tone: 'good' })
    expect(submittedText(d, d.company.payRuns[0])).toBe('Submitted Tue, Oct 13 by Maya Raman')
    expect(submittedText(d, { ...d.company.payRuns[0], submittedById: null })).toBe('Submitted Tue, Oct 13')
    expect(submittedText(d, undefined)).toBe('')
  })

  it("shortens 'Run by' to 'Due soon' for the pay calendar table, where the cutoff has its own column", () => {
    const d = db()
    const oct1 = periodStarting(d, '2026-10-01')
    const dec = periodStarting(d, '2026-12-01')
    if (!oct1 || !dec) throw new Error('no period')
    expect(periodStatusShort(d, oct1, D)).toEqual({ label: 'Due soon', tone: 'accent' })
    expect(periodStatusShort(d, oct1, '2026-10-14')).toEqual({ label: 'Cutoff passed', tone: 'warn' })
    expect(periodStatusShort(d, dec, D)).toEqual({ label: 'Upcoming', tone: 'outline' })
  })
})

describe('rows and the period summary', () => {
  it('words time off and the estimate for each kind of check', () => {
    expect(timeOffText({ pto: 16, sick: 8, other: 0, unpaid: 4.5 })).toBe('PTO 16 hours, sick 8 hours, unpaid 4.5 hours')
    expect(timeOffText({ pto: 1, sick: 0, other: 0, unpaid: 0 })).toBe('PTO 1 hour')
    expect(timeOffText({ pto: 0, sick: 0, other: 0, unpaid: 0 })).toBe('')
    const prep = prepFor(db(), '2026-10-16')
    const note = (id: string) => estimateNote(prep.rows.find((r) => r.personId === id) ?? prep.rows[0])
    expect(note('p-founder')).toBe('Regular check')
    expect(note('p-ravi')).toBe('5 of 11 weekdays')
    expect(note('p-kwame')).toBe('Split at the pay change')
    // The bonus and his vacation payout (the new company's vacation accrues) show on lines of their own.
    expect(note('p-ben')).toBe('6 of 11 weekdays')
    expect(prep.rows.find((r) => r.personId === 'p-ben')?.vacationPayout?.amount).toBeGreaterThan(0)
  })

  it('lists what changed by kind, with names and dates', () => {
    const lines = changeLines(prepFor(db(), '2026-10-16'))
    expect(lines).toEqual([
      { key: 'newHires', label: 'Starting', text: 'Ravi Test, Mon, Oct 26' },
      { key: 'leaving', label: 'Last days', text: 'Ben Test, Fri, Oct 23' },
      { key: 'payChanges', label: 'Pay changes', text: 'Kwame Test, Wed, Oct 21' },
      { key: 'bonuses', label: 'Sign-on bonuses', text: 'Ravi Test' },
      { key: 'timeOff', label: 'Time off', text: 'Elena Test (PTO 16 hours)' },
    ])
    expect(changeLines(prepFor(db(), '2026-12-01'))).toEqual([])
  })

  it('puts deadlines first in the check list, words each badge, and drops the estimate disclaimer from notes', () => {
    const prep = prepFor(db(), '2026-10-16')
    const items = checkList(prep)
    expect(items[0]).toMatchObject({ personId: 'p-ben', flag: { kind: 'final_pay_off_cycle', tone: 'bad' } })
    expect(items[0].flag.text).toBe('Final check due Fri, Oct 23 (Labor Code 201), before the Fri, Oct 30 payday: run an off-cycle (dismissal) payroll.')
    expect([flagWord('bad'), flagWord('warn'), flagWord('info')]).toEqual(['Deadline', 'Check', 'Note'])
    const ravi = prep.rows.find((r) => r.personId === 'p-ravi')
    expect(ravi && rowNotes(ravi)).toEqual(['New hire: first check prorated, 5 of 11 weekdays', 'Sign-on bonus from the offer, with the first check'])
    // An hourly row's 'Hours from your time tracking' is already under its estimate.
    const hourly = { ...prep.rows[0], notes: ['Hours from your time tracking', 'Overtime from the last period is due this payday (hours from time tracking)'] }
    expect(rowNotes(hourly)).toEqual(['Overtime from the last period is due this payday (hours from time tracking)'])
  })
})

describe('the footer total', () => {
  it("says 'including' only of amounts inside the total, and lists an hourly leaver's payout apart", () => {
    const footer = grossFooter({
      people: 3,
      estimatedGross: 118_916.67,
      salaried: 15,
      hourly: 1,
      bonus: 7_500,
      vacationPayout: 0,
      otherPayout: 0,
      outside: [{ personId: 'p-luis', name: 'Luis Ortega', bonus: 0, vacationPayout: 667.5, otherPayout: 0 }],
    })
    expect(footer).toEqual({
      included: [{ amount: 7_500, what: 'in sign-on bonuses' }],
      outside: [{ amount: 667.5, what: 'of vacation payout', name: 'Luis Ortega' }],
      hourlyNote: '1 person paid hourly: the hours come from your time tracking.',
    })
  })

  it('builds the parts from a real period: a salaried leaver payout is included, nothing outside', () => {
    const prep = prepFor(db(), '2026-10-16')
    const ben = prep.rows.find((r) => r.personId === 'p-ben')
    const footer = grossFooter(prep.totals)
    expect(footer.included).toEqual([
      { amount: 10_000, what: 'in sign-on bonuses' },
      { amount: ben?.vacationPayout?.amount, what: 'of vacation payout' },
    ])
    expect(footer.outside).toEqual([])
    expect(footer.hourlyNote).toBe('')
    // Every included amount is inside the total.
    expect(prep.totals.estimatedGross).toBe(Math.round(prep.rows.reduce((t, r) => t + (r.estimatedGross ?? 0), 0) * 100) / 100)
  })
})

describe('regular paydays notice (Labor Code 207)', () => {
  it('lists the next paydays, moved off weekends and holidays', () => {
    const d = db()
    expect(upcomingPaydays(d, D, 4).map((p) => p.payday)).toEqual(['2026-10-15', '2026-10-30', '2026-11-13', '2026-11-30'])
    const text = paydayNoticeText(d, D)
    expect(text.split('\n').slice(0, 6)).toEqual([
      'Regular paydays: Testco, Inc.',
      '',
      'Wages are paid the 15th and the last day of each month, or the business day before when that is a weekend or holiday.',
      '',
      'Next paydays:',
      '- Thu, Oct 15, 2026: pay for Oct 1-15',
    ])
    expect(text).toContain('- Fri, Oct 30, 2026: pay for Oct 16-31')
    expect(text).toContain('Time of payment: ______________________')
    expect(text.endsWith('Posted Oct 12, 2026 (California Labor Code 207).')).toBe(true)
  })

  it('escapes the company name in the printable notice', () => {
    const d = db()
    d.company.legalName = 'Testco <Labs> & Co.'
    const html = paydayNoticeHTML(d, D)
    expect(html).toContain('<strong>Testco &lt;Labs&gt; &amp; Co.</strong>')
    expect(html).toContain('<tr><td>Thu, Oct 15, 2026</td><td>Oct 1-15</td></tr>')
    expect(html).toContain('Labor Code 207')
  })
})
