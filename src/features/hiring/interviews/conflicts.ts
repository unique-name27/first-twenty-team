// Conflict-aware times for the schedule sheet. Proposed times avoid the panel's scheduled interviews
// and approved days off and stay inside 9 AM to 5 PM in the candidate's zone (proposeTimesFor), and
// also avoid the candidate's own interviews. A time picked by hand lists every clash in plain words:
// who, and why. The sheet only ever adds interviews, so the candidate's own interviews count as
// clashes instead of being left out (ProposeOpts.applicationId is meant for rescheduling).
import { interviewConflicts, proposeTimesFor, scheduleWarnings } from '@/domain/hiring/scheduling'
import { candidateName, pacificDateOf } from '@/domain/hiring/util'
import type { DB, ID, Interview } from '@/domain/types'
import { fmtDay, type ISODate, type ISODateTime } from '@/lib/dates'

export type SlotOpts = {
  /** Who will interview. */
  panelIds: ID[]
  /** The candidate's IANA time zone, when known. */
  candidateTz?: string | null
  durationMin: number
  /** The application being scheduled (its candidate's other interviews are clashes). */
  applicationId: ID
}

/** Scheduled interviews of this candidate, on any of their applications, that overlap the time. */
export function candidateClashes(db: DB, applicationId: ID, startsAt: ISODateTime, durationMin: number): Interview[] {
  const app = db.applications.find((a) => a.id === applicationId)
  if (!app || !startsAt) return []
  const apps = new Set(db.applications.filter((a) => a.candidateId === app.candidateId).map((a) => a.id))
  return interviewConflicts(db, startsAt, durationMin).filter((i) => apps.has(i.applicationId))
}

/**
 * Up to `count` proposed start times (UTC ISO, ascending) for the schedule sheet: the next business
 * days at the usual slots, skipping times the panel is busy or out, times outside the candidate's
 * working hours, and times the candidate already has an interview. When the calendar is that full it
 * still returns `count` times (scheduleWarnings then names the clash).
 */
export function proposedSlots(db: DB, date: ISODate, opts: SlotOpts, count = 3): ISODateTime[] {
  const pool = proposeTimesFor(db, date, count * 3, {
    panelIds: opts.panelIds,
    candidateTz: opts.candidateTz ?? null,
    durationMin: opts.durationMin,
  })
  const out = pool.filter((t) => candidateClashes(db, opts.applicationId, t, opts.durationMin).length === 0).slice(0, count)
  for (const t of pool) {
    if (out.length >= count) break
    if (!out.includes(t)) out.push(t)
  }
  return out.sort()
}

/**
 * Plain-language reasons a time is a problem, naming who and why: a panelist is already interviewing
 * then or is out that day (scheduleWarnings), the candidate already has an interview then, or the day
 * is a company holiday. Empty when the time is clear.
 */
export function slotWarnings(db: DB, startsAt: ISODateTime, opts: Omit<SlotOpts, 'candidateTz'>): string[] {
  if (!startsAt) return []
  const panel = opts.panelIds
  const out = panel.length ? scheduleWarnings(db, startsAt, opts.durationMin, panel) : []
  const reported = new Set(panel.length ? interviewConflicts(db, startsAt, opts.durationMin, panel).map((i) => i.id) : [])
  const app = db.applications.find((a) => a.id === opts.applicationId)
  for (const i of candidateClashes(db, opts.applicationId, startsAt, opts.durationMin)) {
    if (reported.has(i.id)) continue
    out.push(`${candidateName(db, app?.candidateId)} already has ${i.name} then.`)
  }
  const day = pacificDateOf(startsAt)
  const holiday = (db.holidays ?? []).find((h) => h.date === day)
  if (holiday) out.push(`${fmtDay(day)} is a company holiday (${holiday.name}).`)
  return out
}
