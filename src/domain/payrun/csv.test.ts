// Pay run exports: the generic CSV (blanks, never zeros; no leave types; formula-safe text), the ADP RUN time
// sheet import and the Justworks bonus upload.
import { describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import type { CompRecord, DB, Offer, Person, TimeOffRequest } from '@/domain/types'
import { periodStarting } from './calendar'
import { adpTitles, amount, downloadBlocked, exportColumnDocs, genericColumns, payRunExport, payRunFormats, safeText, usDate } from './csv'
import { payRunPrep } from './prep'

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

function req(id: string, personId: string, policyId: string, startDate: string, endDate: string, hours: number): TimeOffRequest {
  return { id, personId, policyId, startDate, endDate, hours, status: 'approved', requestedOn: '2026-09-01' }
}

/** Founder; Ravi starting Oct 26 with a $10,000 sign-on bonus; Elena with vacation and bereavement; hourly Luis. */
function sampleDB(): DB {
  const db = blankDB({ companyName: 'Testco Labs', founderFirstName: 'Maya', founderLastName: 'Raman', foundedOn: '2025-02-03' })
  db.company.payrollProvider = { name: 'Gusto', kind: 'Payroll', url: '' }
  db.people.push(
    mkPerson('p-elena', { hireNumber: 2, startDate: '2025-08-18', payrollId: 'E-102' }),
    mkPerson('p-luis', { hireNumber: 3, startDate: '2026-07-20', hoursPerWeek: 24, flsa: 'non_exempt', exemptionBasis: undefined, payrollId: '103' }),
    mkPerson('p-ravi', { firstName: 'Ravi', lastName: '=Subramanian', hireNumber: 4, startDate: '2026-10-26', fromApplicationId: 'a-ravi', fromCandidateId: 'c-ravi' }),
  )
  db.comp.push(
    mkComp('p-founder', '2025-02-03', 150_000, { flsa: 'exempt' }),
    mkComp('p-elena', '2025-08-18', 200_000),
    mkComp('p-luis', '2026-07-20', 0, { payType: 'hourly', salary: undefined, hourlyRate: 30, flsa: 'non_exempt' }),
    mkComp('p-ravi', '2026-10-26', 245_000),
  )
  db.offers.push({ id: 'o-ravi', applicationId: 'a-ravi', candidateId: 'c-ravi', version: 1, status: 'accepted', signOnBonus: 10_000, personId: 'p-ravi', createdOn: '2026-10-01' } as Offer)
  db.timeOffRequests.push(
    req('tr-v', 'p-elena', 'pol-vacation', '2026-10-19', '2026-10-20', 16),
    req('tr-b', 'p-elena', 'pol-bereavement', '2026-10-22', '2026-10-22', 8),
    req('tr-s', 'p-luis', 'pol-sick', '2026-10-21', '2026-10-21', 4.8),
  )
  return db
}

function prep(db: DB, start = '2026-10-16') {
  const period = periodStarting(db, start)
  if (!period) throw new Error('no period')
  return payRunPrep(db, period, '2026-10-12')
}

function parse(text: string): string[][] {
  return text.split('\r\n').map((line) => line.split(','))
}

describe('cells', () => {
  it('writes plain numbers with 2 decimals and blanks for nothing to report', () => {
    expect(amount(4711.538)).toBe('4711.54')
    expect(amount(0)).toBe('')
    expect(amount(0, true)).toBe('0.00')
    expect(amount(null)).toBe('')
    expect(amount(30)).toBe('30.00')
  })

  it('keeps spreadsheets from running text as a formula', () => {
    expect(safeText('=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`)
    for (const s of ['+1 408', '-2', '@SUM(A1)', '\tx', '\rx']) expect(safeText(s).startsWith("'")).toBe(true)
    expect(safeText('Maya')).toBe('Maya')
    expect(safeText(undefined)).toBe('')
  })

  it('writes US dates for ADP and Justworks', () => {
    expect(usDate('2026-10-30')).toBe('10/30/2026')
  })
})

describe('generic CSV', () => {
  it('has one row per person with the documented columns', () => {
    const db = sampleDB()
    const out = payRunExport(db, prep(db), 'generic')
    expect(out.filename).toBe('testco-labs-pay-run-2026-10-16.csv')
    expect(out.problem).toBeNull()
    expect(out.rows).toBe(4)
    const [head, ...rows] = parse(out.text)
    expect(head).toEqual(genericColumns().map((c) => c.header))
    expect(head).toEqual([
      'Period start',
      'Period end',
      'Payday',
      'Employee number',
      'Payroll ID',
      'First name',
      'Last name',
      'Work email',
      'Pay type',
      'FLSA status',
      'Pay rate',
      'Rate basis',
      'Regular check',
      'Regular salary (estimate)',
      'Bonus',
      'Estimated gross',
      'PTO hours',
      'Sick hours',
      'Other time off',
      'Unpaid time off hours',
      'Start date',
      'End date',
      'Final pay due',
      'Vacation payout hours',
      'Vacation payout (estimate)',
      'On leave',
      'Sick balance hours',
      'Notes',
    ])
    expect(rows).toHaveLength(4)
    const col = (name: string) => head.indexOf(name)
    const ravi = out.text.split('\r\n').find((l) => l.includes('ravi@testco.com')) ?? ''
    const raviCells = ravi.split(',')
    expect(raviCells.slice(0, 4)).toEqual(['2026-10-16', '2026-10-31', '2026-10-30', '4'])
    // Formula-safe last name; prorated salary; the bonus; the gross; the start date.
    expect(raviCells[col('Last name')]).toBe("'=Subramanian")
    expect(raviCells[col('Regular check')]).toBe('10208.33')
    expect(raviCells[col('Regular salary (estimate)')]).toBe('4711.54')
    expect(raviCells[col('Bonus')]).toBe('10000.00')
    expect(raviCells[col('Estimated gross')]).toBe('14711.54')
    expect(raviCells[col('Start date')]).toBe('2026-10-26')
    // Blank, never 0, where there is nothing to report (Gusto overwrites entries with zeros).
    expect(raviCells[col('PTO hours')]).toBe('')
    expect(raviCells[col('Final pay due')]).toBe('')
  })

  it('puts bereavement hours under Other time off without naming them, and leaves hourly gross blank', () => {
    const db = sampleDB()
    const out = payRunExport(db, prep(db), 'generic')
    const [head] = parse(out.text)
    const col = (name: string) => head.indexOf(name)
    const elena = (out.text.split('\r\n').find((l) => l.includes('elena@testco.com')) ?? '').split(',')
    expect(elena[col('Payroll ID')]).toBe('E-102')
    expect(elena[col('PTO hours')]).toBe('16.00')
    expect(elena[col('Other time off')]).toBe('8.00')
    expect(out.text).not.toMatch(/bereave|reproductive|bonding|CFRA|PDL/i)
    const luis = (out.text.split('\r\n').find((l) => l.includes('luis@testco.com')) ?? '').split(',')
    expect(luis[col('Pay type')]).toBe('Hourly')
    expect(luis[col('Pay rate')]).toBe('30.00')
    expect(luis[col('Rate basis')]).toBe('Hour')
    expect(luis[col('Estimated gross')]).toBe('')
    expect(luis[col('Regular check')]).toBe('')
    expect(luis[col('Sick hours')]).toBe('4.80')
    // Never an SSN, a birth date, bank details or an address.
    expect(head.join(' ')).not.toMatch(/ssn|social|birth|bank|routing|account|address/i)
  })
})

describe('ADP RUN time sheet import', () => {
  it('needs the company code, writes the header row and MM/DD/YYYY dates, and skips people without an ID', () => {
    const db = sampleDB()
    const missing = payRunExport(db, prep(db), 'adp')
    expect(missing.problem).toContain('company code')
    db.company.payroll = { adp: { companyCode: 'ABC', sickCode: 'SCK' } }
    const out = payRunExport(db, prep(db), 'adp')
    expect(out.problem).toBeNull()
    expect(out.filename).toBe('testco-labs-adp-time-sheet-2026-10-16.csv')
    const lines = out.text.split('\r\n')
    expect(lines[0]).toBe('##GENERIC## V1.0')
    expect(lines[1].split(',')).toEqual(adpTitles())
    expect(lines.slice(2)).toEqual([
      // Rate code BASE on every line, as ADP's sample does for a salaried employee's vacation hours (HRLY4SLRY1 fails
      // with error 34680 when RUN has no hourly rate set up for the salary).
      'ABC,S,10/16/2026,10/31/2026,E-102,VAC,16.00,,0,,BASE',
      'ABC,S,10/16/2026,10/31/2026,103,SCK,4.80,,0,,BASE',
    ])
    // Ravi's prorated first check is not in the file (to enter in RUN by hand), and his bonus has no payroll ID.
    expect(out.skipped).toEqual([
      { name: 'Ravi =Subramanian', reason: 'Prorated first check $4,711.54 (estimate; the regular check is $10,208.33): enter it in RUN' },
      { name: 'Ravi =Subramanian', reason: 'No payroll ID' },
    ])
    expect(out.rows).toBe(2)
    db.people.find((p) => p.id === 'p-ravi')!.payrollId = '104'
    expect(payRunExport(db, prep(db), 'adp').text).toContain('ABC,S,10/16/2026,10/31/2026,104,BON,,10000.00,0,,BASE')
  })

  it('blocks Download of an ADP file without the company code, even with rows in it', () => {
    const db = sampleDB()
    db.company.payroll = { adp: { sickCode: 'SCK' } }
    const out = payRunExport(db, prep(db), 'adp')
    expect(out.rows).toBe(2)
    expect(downloadBlocked(out)).toBe('Add your ADP company code (IID) first: every row needs it.')
    db.company.payroll = { adp: { companyCode: 'ABC', sickCode: 'SCK' } }
    expect(downloadBlocked(payRunExport(db, prep(db), 'adp'))).toBeNull()
    expect(downloadBlocked(payRunExport(db, prep(db, '2026-11-01'), 'adp'))).toBe('No bonuses or time off hours this period: nothing to import.')
    // Justworks with no bonuses has nothing to download; the generic file always downloads.
    expect(downloadBlocked(payRunExport(db, prep(db, '2026-11-01'), 'justworks_bonus'))).toBe('No sign-on bonuses this period, so there is nothing to upload.')
    expect(downloadBlocked(payRunExport(db, prep(db), 'generic'))).toBeNull()
  })

  it('makes typed text formula-safe (company code, payroll ID, earnings code) and leaves numbers alone', () => {
    const db = sampleDB()
    db.company.payroll = { adp: { companyCode: '=HYPERLINK("x")', vacationCode: '+VAC', sickCode: 'SCK' } }
    db.people.find((p) => p.id === 'p-elena')!.payrollId = '-102'
    const lines = parse(payRunExport(db, prep(db), 'adp').text)
    // The company code holds a comma-free formula: quoted by the CSV writer, apostrophe first.
    const elena = lines.find((l) => l.includes("'-102"))
    expect(elena).toBeDefined()
    expect(elena?.[0]).toBe(`"'=HYPERLINK(""x"")"`)
    expect(elena?.slice(4, 8)).toEqual(["'-102", "'+VAC", '16.00', ''])
  })

  it('leaves sick hours out until there is a sick earnings code, and uses B for every two weeks', () => {
    const db = sampleDB()
    db.company.payroll = { adp: { companyCode: 'ABC' } }
    const out = payRunExport(db, prep(db), 'adp')
    expect(out.skipped).toContainEqual({ name: 'Luis Test', reason: 'Sick hours left out: add your sick earnings code' })
    db.company.paySchedule = 'biweekly'
    const bi = periodStarting(db, '2026-10-12')
    if (!bi) throw new Error('no period')
    expect(payRunExport(db, payRunPrep(db, bi, '2026-10-12'), 'adp').text.split('\r\n')[2]).toMatch(/^ABC,B,10\/12\/2026,10\/25\/2026,/)
  })
})

describe('ADP: what the file does not carry, and an empty file', () => {
  it('lists prorated checks and payouts at exit to enter in RUN by hand, never claiming RUN prorates them', () => {
    const db = sampleDB()
    db.company.payroll = { adp: { companyCode: 'ABC', sickCode: 'SCK' } }
    // Luis leaves Wed Sep 30 with notice: 14.25 vacation hours at $30. Elena's last day is Fri Sep 18: 3 of 11 weekdays.
    const luis = db.people.find((p) => p.id === 'p-luis')!
    luis.endDate = '2026-09-30'
    luis.separation = { type: 'resigned_notice', reason: 'School', noticeGivenOn: '2026-09-01', lastDay: '2026-09-30' }
    const elena = db.people.find((p) => p.id === 'p-elena')!
    elena.endDate = '2026-09-18'
    elena.separation = { type: 'resigned_notice', reason: 'New job', noticeGivenOn: '2026-09-01', lastDay: '2026-09-18' }
    const out = payRunExport(db, prep(db, '2026-09-16'), 'adp')
    expect(out.skipped).toContainEqual({ name: 'Luis Test', reason: 'Vacation payout 14.25 hours, about $427.50 (Labor Code 227.3): enter it in RUN' })
    // 200,000 / 260 x 3 = 2,307.69 against the 8,333.33 check.
    expect(out.skipped).toContainEqual({ name: 'Elena Test', reason: 'Prorated last check $2,307.69 (estimate; the regular check is $8,333.33): enter it in RUN' })
    expect(out.skipped.find((x) => x.name === 'Elena Test' && x.reason.startsWith('Vacation payout'))).toBeDefined()
    // Never a dollar amount against a salary in the file itself.
    expect(out.text).not.toMatch(/,REG,/)
  })

  it('refuses an empty file with a reason instead of a header-only download', () => {
    const db = sampleDB()
    db.company.payroll = { adp: { companyCode: 'ABC', sickCode: 'SCK' } }
    // Nov 1-15: no bonuses, no time off, everyone on a regular check.
    const none = payRunExport(db, prep(db, '2026-11-01'), 'adp')
    expect(none).toMatchObject({ rows: 0, skipped: [], problem: 'No bonuses or time off hours this period: nothing to import.' })
    // Only lines to enter by hand: say so.
    db.comp.push(mkComp('p-elena', '2026-11-04', 220_000, { reason: 'merit' }))
    const byHand = payRunExport(db, prep(db, '2026-11-01'), 'adp')
    expect(byHand.rows).toBe(0)
    expect(byHand.problem).toBe('Nothing in this period goes in the ADP file: enter the lines below in RUN by hand.')
    // A raise on Wed Nov 4 splits the check: 8,333.33 x 2/10 + 9,166.67 x 8/10 = 9,000.00.
    expect(byHand.skipped).toEqual([{ name: 'Elena Test', reason: 'Salary this period $9,000.00 (estimate; the regular check is $9,166.67): enter it in RUN' }])
  })
})

describe('blanks, never zeros', () => {
  it('writes a $0 estimate and a used-up sick balance as blanks (Gusto overwrites entries with zeros)', () => {
    const db = sampleDB()
    // Elena on leave all of Nov 1-15 (unpaid): a $0 estimate, explained by On leave and Notes.
    db.leaveCases.push({ id: 'lc-1', personId: 'p-elena', kind: 'bonding', requestedOn: '2026-10-01', startDate: '2026-11-01', expectedReturn: '2026-12-01' })
    // She used all 40 front-loaded sick hours in February: a balance of 0.
    db.timeOffRequests.push(req('tr-sick', 'p-elena', 'pol-sick', '2026-02-02', '2026-02-06', 40))
    const p = prep(db, '2026-11-01')
    expect(p.rows.find((r) => r.personId === 'p-elena')).toMatchObject({ salaryEstimate: 0, estimatedGross: 0, sickBalance: 0 })
    const out = payRunExport(db, p, 'generic')
    const [head] = parse(out.text)
    const col = (name: string) => head.indexOf(name)
    const elena = (out.text.split('\r\n').find((l) => l.includes('elena@testco.com')) ?? '').split(',')
    expect(elena[col('Regular salary (estimate)')]).toBe('')
    expect(elena[col('Estimated gross')]).toBe('')
    expect(elena[col('Sick balance hours')]).toBe('')
    expect(elena[col('On leave')]).toBe('2026-11-01 to 2026-11-15')
    // No cell anywhere in the file is a bare zero.
    expect(out.text.split('\r\n').flatMap((l) => l.split(','))).not.toContain('0.00')
  })
})

describe('Justworks bonus upload', () => {
  it('lists sign-on bonuses only, paid on the payday', () => {
    const db = sampleDB()
    const out = payRunExport(db, prep(db), 'justworks_bonus')
    expect(out.text.split('\r\n')).toEqual(['First Name,Last Name,Email,Pay Date,Amount,Notes', "Ravi,'=Subramanian,ravi@testco.com,10/30/2026,10000.00,Sign-on bonus"])
    expect(out.rows).toBe(1)
    const none = payRunExport(db, prep(db, '2026-11-01'), 'justworks_bonus')
    expect(none).toMatchObject({ rows: 0, problem: 'No sign-on bonuses this period, so there is nothing to upload.' })
  })

  it('offers the three formats with the generic one first', () => {
    expect(payRunFormats().map((f) => f.value)).toEqual(['generic', 'adp', 'justworks_bonus'])
  })

  it('documents every column of each format in file order', () => {
    expect(exportColumnDocs('generic').map((c) => c.header)).toEqual(genericColumns().map((c) => c.header))
    expect(exportColumnDocs('adp').map((c) => c.header)).toEqual(['##GENERIC## V1.0', ...adpTitles()])
    expect(exportColumnDocs('justworks_bonus').map((c) => c.header)).toEqual(['First Name', 'Last Name', 'Email', 'Pay Date', 'Amount', 'Notes'])
    for (const f of payRunFormats()) for (const c of exportColumnDocs(f.value)) expect(c.about.length, `${f.value} ${c.header}`).toBeGreaterThan(3)
  })
})
