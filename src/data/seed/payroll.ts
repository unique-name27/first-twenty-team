// Ledgerlark sample: what pay run prep shows on day one (docs/SAMPLE.md, Seeded situations; docs/SPEC.md PAY RUN
// PREP). Runs last, after hiring, so it never shifts the generated pipelines or the ids of earlier activity rows.
// - The last six payrolls marked submitted to the PEO on their cutoff days, with the PEO's totals for the two most
//   recent paydays (Cost and runway shows them as actuals; they fall before the cash date, so runway is unchanged).
// - Nikhil Rao's merit raise effective mid-period (Wed Oct 21), so the Oct 16-31 check splits at the change.
// - Luis Ortega's resignation with notice (given Thu Oct 8, last day Tue Nov 10): final pay is due on his last day,
//   before the Fri Nov 13 payday, and his accrued vacation is paid out (Labor Code 202 and 227.3).
// Lucas Ferreira's sign-on bonus is on his offer in the hiring seed (paid with the Oct 16-31 check).
// Functions only (see ./company for why).
import type { Draft } from 'immer'
import { setTaskStatus } from '@/domain/checklists/actions'
import { changeJobOrPay, startOffboarding } from '@/domain/lifecycle'
import { payCalendar } from '@/domain/payrun/calendar'
import type { DB, PayRunRecord } from '@/domain/types'
import { addDays, type ISODate } from '@/lib/dates'
import { restampActivity, seedToday } from './company'

/**
 * The sample's submitted payrolls as of `date`: the six pay periods whose cutoff passed before it, each marked by
 * Jasmine on its cutoff day, and the PEO's totals (gross wages, the employer's taxes) for the two latest that were
 * paid, entered the day after payday. Pay periods follow the calendar, not the story, so the store rebuilds these
 * from the calendar after it shifts the sample to today (loadSample in src/store/db.ts) instead of shifting them.
 * On the anchor (Fri Oct 9, 2026) that is Jul 1 to Sep 30, with totals for September.
 */
export function samplePayRuns(db: Pick<DB, 'company' | 'holidays'>, date: ISODate): PayRunRecord[] {
  const submitted = payCalendar(db, addDays(date, -140), date)
    .filter((p) => p.cutoff < date)
    .slice(-6)
  const paid = submitted.filter((p) => p.payday < date).slice(-2)
  // From the PEO's payroll register: salaries, Luis's hours and the sales commissions paid that period, and the
  // employer's Social Security, Medicare and the unemployment taxes on a new hire's first wages.
  const totals = [
    { gross: 106_912.4, employerTaxes: 8_177.81 },
    { gross: 109_846.15, employerTaxes: 8_401.73 },
  ].slice(2 - paid.length)
  return submitted.map((p) => {
    const i = paid.findIndex((x) => x.start === p.start)
    const entered = addDays(p.payday, 1)
    return {
      periodStart: p.start,
      periodEnd: p.end,
      payday: p.payday,
      submittedOn: p.cutoff,
      submittedById: 'p-jasmine',
      ...(i >= 0 && entered < date ? { totals: { ...totals[i], enteredOn: entered } } : {}),
    }
  })
}

function raiseNikhil(db: Draft<DB>): void {
  const mark = db.activity.length
  const recordId = changeJobOrPay(
    db,
    'p-nikhil',
    { effectiveOn: '2026-10-21', reason: 'merit', salary: 214_000, approvedById: 'p-founder', note: 'Merit raise after the SOC 2 Type I report.' },
    { date: '2026-10-02', actorId: 'p-jasmine' },
  )
  restampActivity(db, mark, '2026-10-02', 'p-jasmine')
  const record = db.comp.find((c) => c.id === recordId)
  if (record) record.id = 'cr-nikhil-merit-2026-10'
  // The 'Update payroll by' task was done when Jasmine entered the change in the PEO.
  const checklist = db.checklists.find((c) => c.personId === 'p-nikhil' && c.kind === 'change' && c.anchorDate === '2026-10-21')
  if (!checklist) return
  checklist.id = 'ck-change-nikhil'
  for (const t of checklist.tasks) t.id = `t-change-nikhil-${t.templateTaskId ?? t.id}`
  for (const t of checklist.tasks) {
    if (t.status !== 'open') continue
    const at = db.activity.length
    setTaskStatus(db, checklist.id, t.id, 'done', { date: '2026-10-07', byId: 'p-jasmine' })
    restampActivity(db, at, '2026-10-07', 'p-jasmine')
  }
}

function offboardLuis(db: Draft<DB>): void {
  const mark = db.activity.length
  const checklistId = startOffboarding(
    db,
    'p-luis',
    { type: 'resigned_notice', reason: 'Going back to school full time', noticeGivenOn: '2026-10-08', lastDay: '2026-11-10', rehireEligible: true },
    { date: '2026-10-08', actorId: 'p-jasmine' },
  )
  restampActivity(db, mark, '2026-10-08', 'p-jasmine')
  const checklist = db.checklists.find((c) => c.id === checklistId)
  if (!checklist) return
  // Stable ids for docs and tests: ck-off-luis and t-off-luis-<template task>.
  checklist.id = 'ck-off-luis'
  for (const t of checklist.tasks) t.id = `t-off-luis-${t.templateTaskId ?? t.id}`
}

export function applyPayroll(db: Draft<DB>): void {
  db.company.payRuns = samplePayRuns(db, seedToday())
  raiseNikhil(db)
  offboardLuis(db)
}
