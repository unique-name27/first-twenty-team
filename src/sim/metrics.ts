// A simulated company's numbers on a day, for the simulator's tiles and charts: headcount, people starting,
// open roles, the pipeline, offers out, starts and departures so far, people on leave and the monthly payroll
// (the loaded run-rate Comp and plan shows). Pure and quick enough to take every simulated day.
import { runRate } from '@/domain/pay'
import { employedOn, incomingOn } from '@/domain/people'
import type { DB } from '@/domain/types'
import type { ISODate } from '@/lib/dates'

export type MetricPoint = {
  date: ISODate
  /** Employed on the day. */
  headcount: number
  /** Hired, starting later. */
  incoming: number
  /** Open jobs, jobs on hold and planned roles not yet opened. */
  openRoles: number
  /** Of openRoles, the jobs on hold. */
  heldRoles: number
  /** Active applications on open jobs. */
  pipeline: number
  /** Offers awaiting approval, approved or sent, and not past their expiry. */
  offersOut: number
  /** People who started, and whose last day came, after the simulation's first day and up to this one. */
  startsToDate: number
  departuresToDate: number
  /** People on a leave that has started and not ended. */
  onLeave: number
  /** The loaded monthly payroll of the people employed on the day (runRate, include 'now'). */
  monthlyPayroll: number
}

/** The numbers on `date` for a simulation that started from `from`. */
export function metricsOn(db: DB, date: ISODate, from: ISODate): MetricPoint {
  const open = new Set(db.jobs.filter((j) => j.status === 'open').map((j) => j.id))
  const held = db.jobs.filter((j) => j.status === 'on_hold').length
  const planned = db.plan.filter((s) => s.status === 'planned').length
  return {
    date,
    headcount: employedOn(db, date).length,
    incoming: incomingOn(db, date).length,
    openRoles: open.size + held + planned,
    heldRoles: held,
    pipeline: db.applications.filter((a) => a.status === 'active' && open.has(a.jobId)).length,
    offersOut: db.offers.filter((o) => (o.status === 'awaiting_approval' || o.status === 'approved' || o.status === 'sent') && !(o.expiresOn && o.expiresOn < date)).length,
    startsToDate: db.people.filter((p) => p.startDate > from && p.startDate <= date).length,
    departuresToDate: db.people.filter((p) => p.separation && p.separation.lastDay > from && p.separation.lastDay <= date).length,
    onLeave: db.leaveCases.filter((l) => l.startDate <= date && !l.returnedOn && !l.endedOn).length,
    monthlyPayroll: runRate(db, date, { include: 'now' }).monthly,
  }
}
