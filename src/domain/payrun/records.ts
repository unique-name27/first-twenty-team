// Pay run records (company.payRuns): 'Mark submitted to <provider>' per pay period, and the totals entered from the
// provider's payroll register afterwards (actuals for Comp and plan > Cost and runway). Immer mutation helpers; call
// them inside useDB.getState().mutate so each one can be undone. Activity text never carries an amount.
//
// The first period marked submitted fills company.firstPayrollOn with its payday when it is empty, but only when it
// really is the first payroll: nobody was paid in an earlier period and no earlier run is on record. That date starts
// the EDD registration clock (docs/LAW.md a-edd-register-1), so a later payday must never stand in for an earlier
// first payroll; then the date stays empty and the page asks for it. Undo takes both back.
import type { Draft } from 'immer'
import { firstPaidEmployeeOn } from '@/domain/compliance/counting'
import { lastDayOf } from '@/domain/pay'
import type { Company, DB, ID, PayRunRecord } from '@/domain/types'
import { addDays, type ISODate } from '@/lib/dates'
import { logActivity } from '@/store/draft'
import { isCalendarPaydayText, type PayPeriod, type PayrollSettings, payrollSettings, periodLabelLong, providerPhrase } from './calendar'
import { runForPeriod } from './prep'

/**
 * `firstPayrollOn`: the first payroll date this mark filled in. `firstPayrollUnknown`: it stayed empty because people
 * were paid before this period, so the page asks for the real first payroll date (Settings, Company).
 */
export type PayRunResult = { ok: true; firstPayrollOn?: ISODate; firstPayrollUnknown?: true } | { ok: false; reason: string }

type Opts = { date: ISODate; actorId?: ID | null }

function recordFor(draft: Draft<DB>, period: Pick<PayPeriod, 'start' | 'end' | 'payday'>): Draft<PayRunRecord> {
  if (!draft.company.payRuns) draft.company.payRuns = []
  const found = runForPeriod(draft.company.payRuns as PayRunRecord[], period)
  if (found) return found as Draft<PayRunRecord>
  const rec: PayRunRecord = { periodStart: period.start, periodEnd: period.end, payday: period.payday }
  draft.company.payRuns.push(rec)
  draft.company.payRuns.sort((a, b) => a.periodStart.localeCompare(b.periodStart) || a.periodEnd.localeCompare(b.periodEnd))
  return runForPeriod(draft.company.payRuns as PayRunRecord[], period) as Draft<PayRunRecord>
}

/** Drops one period's record (same start and end), leaving a record from another schedule that shares its start. */
function dropRecord(draft: Draft<DB>, period: Pick<PayPeriod, 'start' | 'end'>): void {
  draft.company.payRuns = (draft.company.payRuns ?? []).filter((r) => !(r.periodStart === period.start && r.periodEnd === period.end))
}

/**
 * True when someone was paid before `start`: a pay record in force on a day they were employed, or the first paid
 * employee the compliance engine counts (the same estimate the EDD clock uses while no first payroll date is set).
 */
export function paidBefore(db: Pick<DB, 'people' | 'comp' | 'company'>, start: ISODate): boolean {
  if (firstPaidEmployeeOn(db as DB, addDays(start, -1))) return true
  return db.people.some((p) =>
    db.comp.some((c) => {
      if (c.personId !== p.id || ((c.payType === 'hourly' ? c.hourlyRate : c.salary) ?? 0) <= 0) return false
      const from = c.effectiveOn > p.startDate ? c.effectiveOn : p.startDate
      return from < start && from <= (lastDayOf(p) ?? '9999-12-31')
    }),
  )
}

/** True when marking this period would record the company's first payroll: nobody paid and no run on record before it. */
export function isFirstPayroll(db: Pick<DB, 'people' | 'comp' | 'company'>, period: Pick<PayPeriod, 'start'>): boolean {
  const earlierRun = (db.company.payRuns ?? []).some((r) => r.periodStart < period.start && (r.submittedOn || r.totals))
  return !earlierRun && !paidBefore(db, period.start)
}

function log(draft: Draft<DB>, kind: string, text: string): void {
  logActivity(draft, { entityType: 'company', entityId: 'company', kind, text })
}

/**
 * Marks a period submitted to the provider today. With no first payroll date yet, fills it with this payday when this
 * is the first payroll (isFirstPayroll); otherwise leaves it empty and says so (firstPayrollUnknown).
 */
export function markPayRunSubmitted(draft: Draft<DB>, period: Pick<PayPeriod, 'start' | 'end' | 'payday'>, opts: Opts): PayRunResult {
  const existing = runForPeriod(draft.company.payRuns as PayRunRecord[] | undefined, period)
  if (existing?.submittedOn) return { ok: false, reason: 'This pay run is already marked submitted.' }
  // Read before the record is written, so this period's own record never counts as an earlier run.
  const first = !draft.company.firstPayrollOn && isFirstPayroll(draft as DB, period)
  const rec = recordFor(draft, period)
  rec.payday = period.payday
  rec.submittedOn = opts.date
  rec.submittedById = opts.actorId ?? null
  log(draft, 'payrun_submitted', `Marked the ${periodLabelLong(period)} payroll as submitted to ${providerPhrase(draft.company)}`)
  if (first) {
    draft.company.firstPayrollOn = period.payday
    return { ok: true, firstPayrollOn: period.payday }
  }
  return draft.company.firstPayrollOn ? { ok: true } : { ok: true, firstPayrollUnknown: true }
}

/** Takes a Mark submitted back (the totals, if any, stay). */
export function unmarkPayRunSubmitted(draft: Draft<DB>, period: Pick<PayPeriod, 'start' | 'end'>): PayRunResult {
  const rec = runForPeriod(draft.company.payRuns as PayRunRecord[] | undefined, period) as Draft<PayRunRecord> | undefined
  if (!rec?.submittedOn) return { ok: false, reason: 'This pay run is not marked submitted.' }
  delete rec.submittedOn
  delete rec.submittedById
  if (!rec.totals) dropRecord(draft, period)
  log(draft, 'payrun_unsubmitted', `Took back the submitted mark on the ${periodLabelLong(period)} payroll`)
  return { ok: true }
}

/** Why provider totals cannot be saved, or null: both are amounts of $0 or more, and gross is more than $0. */
export function totalsProblem(gross: number | null | undefined, employerTaxes: number | null | undefined): string | null {
  if (gross == null || !Number.isFinite(gross) || gross <= 0) return 'Enter the gross pay from the payroll register, more than $0.'
  if (employerTaxes == null || !Number.isFinite(employerTaxes) || employerTaxes < 0) return 'Enter the employer taxes from the payroll register ($0 or more).'
  if (employerTaxes > gross) return 'Employer taxes are more than gross pay. Check the register: employee withholding is not an employer tax.'
  return null
}

/** Saves the gross and employer taxes the provider reported for a period (replacing earlier totals). */
export function setPayRunTotals(
  draft: Draft<DB>,
  period: Pick<PayPeriod, 'start' | 'end' | 'payday'>,
  totals: { gross: number; employerTaxes: number },
  opts: Opts,
): PayRunResult {
  const problem = totalsProblem(totals.gross, totals.employerTaxes)
  if (problem) return { ok: false, reason: problem }
  const rec = recordFor(draft, period)
  const round = (n: number) => Math.round(n * 100) / 100
  rec.totals = { gross: round(totals.gross), employerTaxes: round(totals.employerTaxes), enteredOn: opts.date }
  log(draft, 'payrun_totals', `Entered ${providerPhrase(draft.company)}'s totals for the ${periodLabelLong(period)} payroll`)
  return { ok: true }
}

/** Removes the provider totals for a period (the submitted mark stays). */
export function clearPayRunTotals(draft: Draft<DB>, period: Pick<PayPeriod, 'start' | 'end'>): PayRunResult {
  const rec = runForPeriod(draft.company.payRuns as PayRunRecord[] | undefined, period) as Draft<PayRunRecord> | undefined
  if (!rec?.totals) return { ok: false, reason: 'No totals are entered for this pay run.' }
  delete rec.totals
  if (!rec.submittedOn) dropRecord(draft, period)
  log(draft, 'payrun_totals_cleared', `Removed the provider totals for the ${periodLabelLong(period)} payroll`)
  return { ok: true }
}

/** Runs with provider totals, newest payday first (Cost and runway's actuals). */
export function runsWithTotals(db: Pick<DB, 'company'>): PayRunRecord[] {
  return (db.company.payRuns ?? []).filter((r) => r.totals).sort((a, b) => b.payday.localeCompare(a.payday))
}

/**
 * Saves the pay run settings from Settings > Link-outs (cutoff, weekend and holiday move, semi-monthly paydays),
 * keeping the ADP import settings and clearing a 'Regular payday' text that repeated the old paydays. Writes nothing and returns false when the settings already read that way, so a
 * save that changes nothing says so.
 */
export function setPayrollSettings(draft: Draft<DB>, next: PayrollSettings): boolean {
  const cur = payrollSettings(draft.company)
  const same =
    cur.cutoffBusinessDays === next.cutoffBusinessDays &&
    cur.paydayShift === next.paydayShift &&
    cur.semiMonthlyPaydays.first === next.semiMonthlyPaydays.first &&
    cur.semiMonthlyPaydays.second === next.semiMonthlyPaydays.second
  if (same) return false
  const before = { paySchedule: draft.company.paySchedule, payroll: { ...draft.company.payroll } }
  if (!draft.company.payroll) draft.company.payroll = {}
  const p = draft.company.payroll
  p.cutoffBusinessDays = next.cutoffBusinessDays
  p.paydayShift = next.paydayShift
  p.semiMonthlyPaydays = { first: next.semiMonthlyPaydays.first, second: next.semiMonthlyPaydays.second }
  dropStaleRegularPayday(draft, before)
  return true
}

/**
 * After the pay schedule or the paydays change: clears a typed 'Regular payday' (Settings, Company) that only repeated
 * the old calendar's words, so the Labor Code 2810.5 wage notice prints the new calendar's words (regularPaydayText)
 * instead of stale ones. Text in the admin's own words stays. Returns true when it cleared one.
 */
export function dropStaleRegularPayday(draft: Draft<DB>, before: Pick<Company, 'paySchedule' | 'payroll'>): boolean {
  const text = draft.company.regularPayday
  if (!text || !isCalendarPaydayText(text, before) || isCalendarPaydayText(text, draft.company)) return false
  delete draft.company.regularPayday
  return true
}
