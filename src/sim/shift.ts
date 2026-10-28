// Moves a generated company to another week, for `npm run sim reset` (scripts/dev/sim.ts, docs/DEV.md
// "Simulate a company"). The dev stack shows a company on the real date, so reset moves the story by whole
// weeks, as the sample moves itself on load (loadSample in src/store/db.ts): weekdays keep their names, so
// interviews stay on weekdays and starts on Mondays. Tests never move a company; they use the fixed as-of date.
//
// Law values (settings), the holiday list, time off policies and checklist templates stay on their own
// dates: only the company's story moves. Pay periods follow the calendar (the 15th and the last day, or
// every other week), so pay runs cannot move by weeks: they are marked again for the periods the moved story
// covers, the way the generator marks them (every period from the founding date, submitted on its 'run
// payroll by' day by whoever submitted the first one), and the first payroll date follows the first of them.
import { payCalendar } from '@/domain/payrun/calendar'
import type { DB, PayRunRecord } from '@/domain/types'
import { addDays, type ISODate, shiftDatesDeep } from '@/lib/dates'

/** Keys whose dates stay put when the story moves (at any depth, as shiftDatesDeep reads them). */
export const KEPT_ON_THEIR_DATES = ['settings', 'holidays', 'timeOffPolicies', 'checklistTemplates', 'payRuns'] as const

/**
 * The company `db` (generated as of `asOf`) with its story `days` later (or earlier, when negative), whole
 * weeks only. Throws for a company whose pay runs carry provider totals or a period not marked submitted:
 * those come from people, not the generator, and cannot be marked again.
 */
export function shiftCompany(db: DB, days: number, asOf: ISODate): DB {
  if (!Number.isInteger(days) || days % 7 !== 0) throw new Error(`A company moves by whole weeks, not ${days} days.`)
  if (days === 0) return db
  const runs = db.company.payRuns ?? []
  if (runs.some((r) => !r.submittedOn || r.totals)) {
    throw new Error('This company has pay runs with provider totals or not marked submitted, so it cannot be moved: only a generated company can.')
  }
  const moved = shiftDatesDeep(db, days, new Set<string>(KEPT_ON_THEIR_DATES))
  if (runs.length === 0) return moved
  const foundedOn = moved.company.foundedOn
  const movedAsOf = addDays(asOf, days)
  const submitter = runs[0].submittedById ?? null
  const payRuns: PayRunRecord[] = payCalendar(moved, foundedOn, movedAsOf)
    .filter((p) => p.cutoff >= foundedOn && p.cutoff <= movedAsOf)
    .map((p) => ({ periodStart: p.start, periodEnd: p.end, payday: p.payday, submittedOn: p.cutoff, submittedById: submitter }))
  return { ...moved, company: { ...moved.company, payRuns, ...(payRuns.length > 0 ? { firstPayrollOn: payRuns[0].payday } : {}) } }
}
