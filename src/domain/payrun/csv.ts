// Pay run exports (docs/SPEC.md: PAY RUN PREP). One file per pay period:
//   generic           One row per person, ISO dates, plain numbers with 2 decimals and no $ or commas, blank (never 0)
//                     in every amount and hours cell with nothing in it, a $0 estimate included (the On leave and Notes
//                     columns say why): Gusto's Smart Import overwrites entries with zeros, not blanks. Gusto's own
//                     column names are used where they fit (PTO hours, Sick hours, Other time off, Bonus).
//   adp               ADP RUN Time Sheet Import ('Time Sheet Import and RUN Powered by ADP', GTSG-V0418A, 2018): row 1
//                     '##GENERIC## V1.0', row 2 the column titles, MM/DD/YYYY dates, one pay frequency and period
//                     per file, company earnings codes. Carries sign-on bonuses and time off hours (rate code BASE, as
//                     the guide's sample does for a salaried employee's vacation hours). What it does not carry is listed
//                     to enter in RUN by hand: a salary that is not the regular check (a prorated first or last check,
//                     a pay change, unpaid days, leave) and payouts at exit. The guide does not say how RUN treats a
//                     dollar amount against a salary it already pays, so the file never sends one. People without a
//                     payroll ID, or on leave all period, are left out.
//   justworks_bonus   Justworks Bulk Payments (sign-on bonuses only, never regular wages): First Name, Last Name,
//                     Email, Pay Date, Amount, Notes. The date format is not stated by Justworks; MM/DD/YYYY is used.
// Privacy: no SSN, date of birth, bank details or address (the app never has them), no leave types (bereavement
// and reproductive loss hours sit unnamed under Other time off). Text cells that start with =, +, -, @, a tab or a
// carriage return get a leading apostrophe so a spreadsheet never runs them as formulas.
import type { DB } from '@/domain/types'
import { slug, toCSV } from '@/lib/files'
import { money2 } from '@/lib/format'
import { hoursText2, type PayRunPrep, type PayRunRow } from './prep'

export type PayRunFormat = 'generic' | 'adp' | 'justworks_bonus'

/** The export choices, in the order the picker shows them. */
export function payRunFormats(): Array<{ value: PayRunFormat; label: string; hint: string }> {
  return [
    { value: 'generic', label: 'Generic CSV', hint: 'One row per person: rates, estimates, time off, start and last days, final pay. Works with any provider.' },
    { value: 'adp', label: 'ADP RUN time sheet import', hint: 'Bonuses and time off hours in the ADP RUN import layout. Needs your company code and payroll IDs.' },
    { value: 'justworks_bonus', label: 'Justworks bonus upload', hint: 'Sign-on bonuses in the Justworks bulk payments layout. Not for regular wages.' },
  ]
}

export type PayRunExport = {
  format: PayRunFormat
  filename: string
  text: string
  /** Data rows written. */
  rows: number
  /** People or amounts left out of the file and why ('No payroll ID', 'Prorated first check $7,500.00: enter it in RUN'). */
  skipped: Array<{ name: string; reason: string }>
  /** Why the file cannot be used (a missing company code, nothing to import), or null. Download is blocked then. */
  problem: string | null
}

/** A text cell made safe for spreadsheets: a leading =, +, -, @, tab or carriage return gets an apostrophe. */
export function safeText(s: string | undefined | null): string {
  const v = s ?? ''
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
}

/** A number with 2 decimals and no $ or commas; blank for nothing to report (null, undefined or 0 unless keepZero). The
 * exports never pass keepZero: a 0 overwrites an entry in Gusto's Smart Import, a blank does not. */
export function amount(n: number | null | undefined, keepZero = false): string {
  if (n == null || Number.isNaN(n)) return ''
  if (n === 0 && !keepZero) return ''
  return (Math.round(n * 100) / 100).toFixed(2)
}

/** '10/15/2026' from '2026-10-15'. */
export function usDate(d: string | undefined): string {
  if (!d) return ''
  return `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`
}

function fileName(db: Pick<DB, 'company'>, prep: PayRunPrep, format: PayRunFormat): string {
  const stem = slug(db.company.name || 'company') || 'company'
  const kind = format === 'generic' ? 'pay-run' : format === 'adp' ? 'adp-time-sheet' : 'justworks-bonuses'
  return `${stem}-${kind}-${prep.period.start}.csv`
}

/** Columns of the generic export, in order, with what each holds (documented on the page next to the download). */
export function genericColumns(): Array<{ header: string; about: string; value: (r: PayRunRow, prep: PayRunPrep) => string }> {
  return [
    { header: 'Period start', about: 'First day of the pay period (YYYY-MM-DD).', value: (_r, p) => p.period.start },
    { header: 'Period end', about: 'Last day of the pay period.', value: (_r, p) => p.period.end },
    { header: 'Payday', about: 'The payday, already moved off weekends and holidays.', value: (_r, p) => p.period.payday },
    { header: 'Employee number', about: 'Employee number in order of hire (1 = founder).', value: (r) => String(r.employeeNumber) },
    { header: 'Payroll ID', about: "The provider's own employee ID, when recorded.", value: (r) => safeText(r.payrollId) },
    { header: 'First name', about: 'Legal first name.', value: (r) => safeText(r.firstName) },
    { header: 'Last name', about: 'Last name.', value: (r) => safeText(r.lastName) },
    { header: 'Work email', about: 'Work email, the usual match key.', value: (r) => safeText(r.workEmail) },
    { header: 'Pay type', about: 'Salary or Hourly.', value: (r) => (r.payType === 'hourly' ? 'Hourly' : 'Salary') },
    { header: 'FLSA status', about: 'Exempt or Non-exempt.', value: (r) => (r.flsa === 'exempt' ? 'Exempt' : 'Non-exempt') },
    { header: 'Pay rate', about: 'Annual salary or hourly rate at the end of the period.', value: (r) => amount(r.rate) },
    { header: 'Rate basis', about: 'Year or Hour.', value: (r) => (r.rateBasis === 'hour' ? 'Hour' : 'Year') },
    {
      header: 'Regular check',
      about: 'The regular salary check for a whole period: annual salary / pay periods a year. Blank for hourly pay.',
      value: (r) => amount(r.regularAmount),
    },
    {
      header: 'Regular salary (estimate)',
      about: 'Salary for the period: annual / pay periods a year, or annual / 260 x weekdays on payroll for a first or last check, less unpaid days. Blank for hourly pay, and for $0 (a whole period on leave: see On leave and Notes).',
      value: (r) => amount(r.salaryEstimate),
    },
    { header: 'Bonus', about: 'Sign-on bonus from the accepted offer, paid with the first check.', value: (r) => amount(r.bonus) },
    {
      header: 'Estimated gross',
      about: 'Regular salary + bonus + payouts at exit. Blank for hourly pay (hours come from your time tracking), for final pay already issued, and for $0.',
      value: (r) => amount(r.estimatedGross),
    },
    { header: 'PTO hours', about: 'Vacation hours taken in the period.', value: (r) => amount(r.timeOff.pto) },
    { header: 'Sick hours', about: 'Paid sick hours taken in the period (pay by the next regular payday, Labor Code 246(n)).', value: (r) => amount(r.timeOff.sick) },
    {
      header: 'Other time off',
      about: 'Other paid leave hours, never named: voting time and donor leave (paid under their policies), and for exempt staff any other leave (an exempt salary is not reduced for it).',
      value: (r) => amount(r.timeOff.other),
    },
    {
      header: 'Unpaid time off hours',
      about: 'Unpaid hours, never named: unpaid leave, sick time recorded as unpaid, and for hourly and non-exempt staff leave with no pay rule (jury duty, bereavement, reproductive loss).',
      value: (r) => amount(r.timeOff.unpaid),
    },
    { header: 'Start date', about: 'Start date, when it falls in the period.', value: (r) => r.startInPeriod ?? '' },
    { header: 'End date', about: 'Last day, when it falls in the period.', value: (r) => r.endInPeriod ?? '' },
    { header: 'Final pay due', about: 'Final pay deadline under Labor Code 201 or 202.', value: (r) => (r.finalPay && !r.finalPay.issuedOn ? r.finalPay.dueOn : '') },
    {
      header: 'Vacation payout hours',
      about: 'Unused vacation paid at exit (Labor Code 227.3). Another balance your policy pays out (sick leave) is in Notes under its own name.',
      value: (r) => (r.paidOffCycle ? '' : amount(r.vacationPayout?.hours)),
    },
    { header: 'Vacation payout (estimate)', about: 'Payout hours x the final hourly rate.', value: (r) => (r.paidOffCycle ? '' : amount(r.vacationPayout?.amount)) },
    { header: 'On leave', about: 'Leave dates in the period, never the kind of leave.', value: (r) => (r.leave ? `${r.leave.from} to ${r.leave.to}` : '') },
    {
      header: 'Sick balance hours',
      about: 'Paid sick leave left at the period end, for the pay stub (Labor Code 246(i)) when the provider does not track it. Blank when none is left.',
      value: (r) => amount(r.sickBalance),
    },
    { header: 'Notes', about: 'What changed, in plain words.', value: (r) => safeText(r.notes.join('; ')) },
  ]
}

function genericExport(db: Pick<DB, 'company'>, prep: PayRunPrep): PayRunExport {
  const cols = genericColumns()
  const text = toCSV(prep.rows, cols.map((c) => ({ header: c.header, value: (r: PayRunRow) => c.value(r, prep) })))
  return { format: 'generic', filename: fileName(db, prep, 'generic'), text, rows: prep.rows.length, skipped: [], problem: null }
}

/** ADP's titles for row 2 of the time sheet import (the guide's examples). */
export function adpTitles(): string[] {
  return ['IID', 'Pay Frequency', 'Pay Period Start Date', 'Pay Period End Date', 'Employee ID', 'Earnings Code', 'Pay Hours', 'Dollars', 'Separate Check', 'Worked In Dept', 'Rate Code']
}

function adpFrequency(schedule: DB['company']['paySchedule']): string {
  return schedule === 'biweekly' ? 'B' : schedule === 'monthly' ? 'M' : 'S'
}

type AdpLine = { code: string; hours: string; dollars: string; rateCode: string }

/**
 * What the ADP file does not carry for a row, to enter in RUN by hand: a salary that is not the regular check, and
 * payouts at exit. Amounts carry a $ so the page can blur them.
 */
function adpByHand(r: PayRunRow): string[] {
  if (r.paidOffCycle) return []
  const out: string[] = []
  const est = r.salaryEstimate
  if (est !== null && Math.abs(est - r.regularAmount) >= 0.005) {
    const partial = r.weekdaysOnPayroll < r.weekdays
    const what = r.startInPeriod && partial ? 'Prorated first check' : r.endInPeriod && partial ? 'Prorated last check' : 'Salary this period'
    out.push(`${what} ${money2(est)} (estimate; the regular check is ${money2(r.regularAmount)}): enter it in RUN`)
  }
  if (r.vacationPayout) out.push(`Vacation payout ${hoursText2(r.vacationPayout.hours)} hours, about ${money2(r.vacationPayout.amount)} (Labor Code 227.3): enter it in RUN`)
  if (r.otherPayout) out.push(`${r.otherPayout.name} payout ${hoursText2(r.otherPayout.hours)} hours, about ${money2(r.otherPayout.amount)}: enter it in RUN`)
  return out
}

function adpExport(db: Pick<DB, 'company'>, prep: PayRunPrep): PayRunExport {
  const adp = db.company.payroll?.adp ?? {}
  const company = (adp.companyCode ?? '').trim()
  const codes = { bonus: (adp.bonusCode ?? '').trim() || 'BON', vacation: (adp.vacationCode ?? '').trim() || 'VAC', sick: (adp.sickCode ?? '').trim() }
  const skipped: PayRunExport['skipped'] = []
  const lines: string[][] = []
  for (const r of prep.rows) {
    const out: AdpLine[] = []
    // Every line uses rate code BASE, as the guide's sample does for a salaried employee's vacation hours. HRLY4SLRY1
    // (the first hourly rate defined for a salary) fails with error 34680 when RUN has no hourly rate set up.
    if (r.bonus > 0) out.push({ code: codes.bonus, hours: '', dollars: amount(r.bonus), rateCode: 'BASE' })
    if (r.timeOff.pto > 0) out.push({ code: codes.vacation, hours: amount(r.timeOff.pto), dollars: '', rateCode: 'BASE' })
    if (r.timeOff.sick > 0) {
      if (codes.sick) out.push({ code: codes.sick, hours: amount(r.timeOff.sick), dollars: '', rateCode: 'BASE' })
      else skipped.push({ name: r.name, reason: 'Sick hours left out: add your sick earnings code' })
    }
    for (const reason of adpByHand(r)) skipped.push({ name: r.name, reason })
    if (!out.length) continue
    if (!r.payrollId) {
      skipped.push({ name: r.name, reason: 'No payroll ID' })
      continue
    }
    if (r.leave && r.weekdaysOnPayroll > 0 && r.leave.from <= prep.period.start && r.leave.to >= prep.period.end) {
      skipped.push({ name: r.name, reason: 'On leave all period (ADP leaves out employees on leave)' })
      continue
    }
    for (const l of out) {
      // Typed text (the company code, the ID, an earnings code) is made formula-safe; numbers stay numbers.
      lines.push([safeText(company), adpFrequency(prep.schedule), usDate(prep.period.start), usDate(prep.period.end), safeText(r.payrollId), safeText(l.code), l.hours, l.dollars, '0', '', l.rateCode])
    }
  }
  const titles = adpTitles()
  const body = toCSV(lines, titles.map((t, i) => ({ header: t, value: (row: string[]) => row[i] })))
  const problem = !company
    ? 'Add your ADP company code (IID) first: every row needs it.'
    : lines.length
      ? null
      : skipped.length
        ? 'Nothing in this period goes in the ADP file: enter the lines below in RUN by hand.'
        : 'No bonuses or time off hours this period: nothing to import.'
  return {
    format: 'adp',
    filename: fileName(db, prep, 'adp'),
    text: ['##GENERIC## V1.0', body].join('\r\n'),
    rows: lines.length,
    skipped,
    problem,
  }
}

function justworksExport(db: Pick<DB, 'company'>, prep: PayRunPrep): PayRunExport {
  const rows = prep.rows.filter((r) => r.bonus > 0)
  const text = toCSV(rows, [
    { header: 'First Name', value: (r: PayRunRow) => safeText(r.firstName) },
    { header: 'Last Name', value: (r: PayRunRow) => safeText(r.lastName) },
    { header: 'Email', value: (r: PayRunRow) => safeText(r.workEmail) },
    { header: 'Pay Date', value: () => usDate(prep.period.payday) },
    { header: 'Amount', value: (r: PayRunRow) => amount(r.bonus) },
    // Notes print on the pay stub: what it is, never an amount or a reason.
    { header: 'Notes', value: () => 'Sign-on bonus' },
  ])
  return {
    format: 'justworks_bonus',
    filename: fileName(db, prep, 'justworks_bonus'),
    text,
    rows: rows.length,
    skipped: [],
    problem: rows.length ? null : 'No sign-on bonuses this period, so there is nothing to upload.',
  }
}

/**
 * Why Download is refused, or null. An ADP file with any problem (no company code, nothing to import) would fail in
 * RUN, so it never downloads; any other format with a problem downloads only when it has rows. Copy stays available.
 */
export function downloadBlocked(out: Pick<PayRunExport, 'format' | 'problem' | 'rows'>): string | null {
  if (!out.problem) return null
  return out.format === 'adp' || out.rows === 0 ? out.problem : null
}

/** Builds the export for a period in one of the formats. */
export function payRunExport(db: Pick<DB, 'company'>, prep: PayRunPrep, format: PayRunFormat): PayRunExport {
  if (format === 'adp') return adpExport(db, prep)
  if (format === 'justworks_bonus') return justworksExport(db, prep)
  return genericExport(db, prep)
}

/** What each column of an export holds, in file order, for the page next to the download. */
export function exportColumnDocs(format: PayRunFormat): Array<{ header: string; about: string }> {
  if (format === 'adp') {
    return [
      { header: '##GENERIC## V1.0', about: 'Row 1, as ADP requires. The column titles are row 2 and people start on row 3.' },
      { header: 'IID', about: 'Your company code (ADP RUN import settings), on every row.' },
      { header: 'Pay Frequency', about: 'S semi-monthly, B every two weeks, M monthly. One frequency and one period per file.' },
      { header: 'Pay Period Start Date', about: 'MM/DD/YYYY.' },
      { header: 'Pay Period End Date', about: 'MM/DD/YYYY.' },
      { header: 'Employee ID', about: "The person's payroll ID in RUN. People without one are left out and listed." },
      { header: 'Earnings Code', about: "Your codes for bonus, vacation and sick, from RUN's Earnings Codes Report (ADP's sample uses BON and VAC)." },
      { header: 'Pay Hours', about: 'Vacation or sick hours taken, with decimals.' },
      { header: 'Dollars', about: 'The sign-on bonus, with decimals.' },
      { header: 'Separate Check', about: '0: paid on the regular check.' },
      { header: 'Worked In Dept', about: 'Left blank (optional).' },
      { header: 'Rate Code', about: "BASE on every line, as ADP's sample does for a salaried employee's vacation hours." },
    ]
  }
  if (format === 'justworks_bonus') {
    return [
      { header: 'First Name', about: 'Legal first name.' },
      { header: 'Last Name', about: 'Last name.' },
      { header: 'Email', about: 'Work email.' },
      { header: 'Pay Date', about: 'The payday, MM/DD/YYYY. Justworks takes business days only, and the payday already is one.' },
      { header: 'Amount', about: 'The sign-on bonus from the accepted offer.' },
      { header: 'Notes', about: "Prints on the pay stub: 'Sign-on bonus'." },
    ]
  }
  return genericColumns().map((c) => ({ header: c.header, about: c.about }))
}
