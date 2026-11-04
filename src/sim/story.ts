// What happened in a simulation, as plain sentences for a feed (docs/DEV.md, "The simulator's story"). Each
// event has a day, a kind, an importance (1 a headline, 2 a detail) and an area for the feed's filters, and
// its sentence names people and jobs from the workspace. Routine work (candidates, interviews, scorecards,
// time off, tasks, the inbox) is folded into one line a week. Pure: the same day, trace lines, workspace and
// notes give the same events, however the simulation stepped.
import { outcomeReasonLabel } from '@/domain/hiring'
import { fullName } from '@/domain/people'
import type { DB, ID } from '@/domain/types'
import { addDays, fmtDayAnyYear, fmtShort, type ISODate } from '@/lib/dates'
import { money, num } from '@/lib/format'
import type { TraceLine } from './actions'
import { SITUATION_TIME, type SituationNote } from './situations'

export type EventArea = 'hiring' | 'people' | 'pay' | 'situations' | 'routine'

export type EventKind =
  | 'started'
  | 'last_day'
  | 'resigned'
  | 'laid_off'
  | 'left'
  | 'offer_accepted'
  | 'offer_declined'
  | 'offer_sent'
  | 'hired'
  | 'job_opened'
  | 'job_status'
  | 'role_planned'
  | 'leave_started'
  | 'leave_returned'
  | 'raise'
  | 'manager_change'
  | 'department_head'
  | 'band_added'
  | 'pay_run'
  | 'situation'
  | 'situation_skipped'
  | 'week'

export type SimEvent = {
  day: ISODate
  kind: EventKind
  /** 1: a headline; 2: a detail. */
  importance: 1 | 2
  area: EventArea
  text: string
  /** The person it is about, when there is one. */
  personId?: ID
  /** The situation it came from, for situation notes. */
  situationId?: string
}

/** An event as one line of a feed: "Mar 3: Priya Shah accepted the offer for Account executive." */
export function eventSentence(e: SimEvent): string {
  return `${fmtShort(e.day)}: ${e.text}`
}

/**
 * The events of one day: who started and whose last day it was, what the situations did, then what the
 * people did, in the order they did it. `lines` are the day's trace lines and `db` the workspace at its end.
 * Steps a situation took are told by its note, not again line by line.
 */
export function dayEvents(day: ISODate, lines: readonly TraceLine[], db: DB, notes: readonly SituationNote[] = []): SimEvent[] {
  const out: SimEvent[] = []
  const when = (d: ISODate | undefined) => (d ? fmtDayAnyYear(d, day) : 'a date not set')
  for (const p of db.people) {
    if (p.startDate === day && !(p.separation && p.separation.lastDay < day)) out.push({ day, kind: 'started', importance: 1, area: 'people', text: `${fullName(p)} started as ${p.title}.`, personId: p.id })
  }
  for (const p of db.people) {
    if (p.separation?.lastDay === day) out.push({ day, kind: 'last_day', importance: 1, area: 'people', text: `Last day for ${fullName(p)}.`, personId: p.id })
  }
  for (const n of notes) {
    out.push({ day, kind: n.skipped ? 'situation_skipped' : 'situation', importance: 1, area: 'situations', text: n.text, situationId: n.situationId })
  }
  const ctx = names(db)
  for (const line of lines) {
    if (line.time === SITUATION_TIME) continue
    const e = lineEvent(line, db, ctx, when)
    if (e) out.push({ day, ...e })
  }
  return out
}

/**
 * The week's routine in one line, for a Sunday: applications, interviews, scorecards, rejections and
 * withdrawals, offers drafted, time off sent and approved, tasks done. `lines` are the trace lines of the
 * seven days ending on `day`. Null when nothing routine happened.
 */
export function weekEvent(day: ISODate, lines: readonly TraceLine[]): SimEvent | null {
  const from = addDays(day, -6)
  const count = (action: TraceLine['action'], test: (a: Record<string, unknown>) => boolean = () => true) =>
    lines.filter((t) => t.day >= from && t.day <= day && t.action === action && test(t.args as Record<string, unknown>)).length
  const parts: string[] = []
  const add = (n: number, one: string, many: string) => {
    if (n > 0) parts.push(`${num(n)} ${n === 1 ? one : many}`)
  }
  add(count('addCandidate'), 'application', 'applications')
  add(count('scheduleInterview'), 'interview', 'interviews')
  add(count('submitScorecard'), 'scorecard', 'scorecards')
  add(count('rejectApplication', (a) => !a.withdraw), 'rejection', 'rejections')
  add(count('rejectApplication', (a) => !!a.withdraw), 'withdrawal', 'withdrawals')
  add(count('createOffer'), 'offer drafted', 'offers drafted')
  add(count('requestTimeOff'), 'time off request', 'time off requests')
  add(count('setTaskStatus') + count('inboxOp', (a) => (a.op as { type?: string } | undefined)?.type === 'task_status'), 'task done', 'tasks done')
  if (!parts.length) return null
  return { day, kind: 'week', importance: 2, area: 'routine', text: `This week: ${parts.join(', ')}.` }
}

// ---- Inside ----------------------------------------------------------------------------------

type Names = {
  person(id: ID | null | undefined): string
  /** The candidate (or person) an offer is for, and its job's title. */
  offer(id: unknown): { who: string; title: string; startDate?: ISODate; personId?: ID } | null
  job(id: ID | null | undefined): string
}

function names(db: DB): Names {
  const person = (id: ID | null | undefined) => {
    const p = id ? db.people.find((x) => x.id === id) : undefined
    return p ? fullName(p) : 'someone'
  }
  const job = (id: ID | null | undefined) => (id ? db.jobs.find((j) => j.id === id)?.title : undefined) ?? 'a job'
  return {
    person,
    job,
    offer(id) {
      const o = typeof id === 'string' ? db.offers.find((x) => x.id === id) : undefined
      if (!o) return null
      const c = db.candidates.find((x) => x.id === o.candidateId)
      return { who: c ? fullName(c) : o.personId ? person(o.personId) : 'a candidate', title: job(o.jobId), startDate: o.startDate, ...(o.personId ? { personId: o.personId } : {}) }
    },
  }
}

type LineEvent = Omit<SimEvent, 'day'>

const SEPARATIONS: Record<string, { kind: EventKind; verb: string }> = {
  resigned_notice: { kind: 'resigned', verb: 'resigned' },
  resigned_no_notice: { kind: 'resigned', verb: 'resigned with no notice' },
  laid_off: { kind: 'laid_off', verb: 'was laid off' },
  terminated: { kind: 'left', verb: 'was let go' },
  contract_ended: { kind: 'left', verb: 'came to the end of their contract' },
}

const LEAVES: Record<string, string> = { cfra: 'CFRA leave', pdl: 'pregnancy disability leave', bonding: 'bonding leave', military: 'military leave', other: 'leave' }

/** The event a trace line tells, or null for routine work (counted in the week's line instead). */
function lineEvent(line: TraceLine, db: DB, n: Names, when: (d: ISODate | undefined) => string): LineEvent | null {
  const a = line.args as Record<string, unknown>
  const id = (k: string) => a[k] as ID
  switch (line.action) {
    case 'markAccepted': {
      const o = n.offer(a.offerId)
      return o ? { kind: 'offer_accepted', importance: 1, area: 'hiring', text: `${o.who} accepted the offer for ${o.title}, starting ${when(o.startDate)}.` } : null
    }
    case 'markDeclined': {
      const o = n.offer(a.offerId)
      return o ? { kind: 'offer_declined', importance: 1, area: 'hiring', text: `${o.who} declined the offer for ${o.title} (${outcomeReasonLabel(a.reason as string).toLowerCase()}).` } : null
    }
    case 'markSent': {
      const o = n.offer(a.offerId)
      return o ? { kind: 'offer_sent', importance: 2, area: 'hiring', text: `Offer sent to ${o.who} for ${o.title}.` } : null
    }
    case 'hireFromOffer': {
      const o = n.offer(a.offerId)
      return o ? { kind: 'hired', importance: 2, area: 'hiring', text: `Hired ${o.who} as ${o.title}: onboarding and documents started.`, ...(o.personId ? { personId: o.personId } : {}) } : null
    }
    case 'offboardPerson': {
      const sep = SEPARATIONS[a.type as string] ?? { kind: 'left' as const, verb: 'is leaving' }
      const reason = typeof a.reason === 'string' && a.reason ? ` (${a.reason})` : ''
      return { kind: sep.kind, importance: 1, area: 'people', text: `${n.person(id('personId'))} ${sep.verb}${reason}, last day ${when(a.lastDay as ISODate)}.`, personId: id('personId') }
    }
    case 'openJobFromPlan': {
      const slot = db.plan.find((s) => s.id === id('planSlotId'))
      const jobId = line.created.find((c) => db.jobs.some((j) => j.id === c)) ?? slot?.jobId
      return { kind: 'job_opened', importance: 1, area: 'hiring', text: `Opened the ${n.job(jobId)} job${slot?.isBackfill ? ' (a backfill)' : ''}.` }
    }
    case 'openBackfill': {
      const jobId = line.created.find((c) => db.jobs.some((j) => j.id === c)) ?? db.jobs.find((j) => j.backfillForPersonId === id('personId'))?.id
      return { kind: 'job_opened', importance: 1, area: 'hiring', text: `Opened a backfill for ${n.person(id('personId'))}: the ${n.job(jobId)} job.` }
    }
    case 'createJob': {
      const jobId = line.created.find((c) => db.jobs.some((j) => j.id === c))
      return { kind: 'job_opened', importance: 1, area: 'hiring', text: `Opened the ${n.job(jobId)} job.` }
    }
    case 'setJobStatus': {
      const verbs: Record<string, string> = { on_hold: 'Put the {t} job on hold', closed: 'Closed the {t} job without hiring', filled: 'Marked the {t} job filled', draft: 'Moved the {t} job back to draft' }
      return { kind: 'job_status', importance: 2, area: 'hiring', text: `${(verbs[a.status as string] ?? 'Changed the {t} job').replace('{t}', n.job(id('jobId')))}.` }
    }
    case 'addPlanLine':
      return { kind: 'role_planned', importance: 2, area: 'hiring', text: `Added ${a.title as string} to the headcount plan, to start ${when(a.targetStart as ISODate)}.` }
    case 'startLeave': {
      const kind = LEAVES[a.kind as string] ?? 'leave'
      return { kind: 'leave_started', importance: 1, area: 'people', text: `${n.person(id('personId'))} goes on ${kind} from ${when(a.startDate as ISODate)}, back ${when(a.expectedReturn as ISODate)}.`, personId: id('personId') }
    }
    case 'markReturned': {
      const leave = db.leaveCases.find((l) => l.id === id('leaveId'))
      return { kind: 'leave_returned', importance: 1, area: 'people', text: `${n.person(leave?.personId)} is back from leave.`, ...(leave ? { personId: leave.personId } : {}) }
    }
    case 'changeJobOrPay': {
      const change = (a.change ?? {}) as { reason?: string; salary?: number; hourlyRate?: number; managerId?: ID | null; effectiveOn?: ISODate }
      const who = n.person(id('personId'))
      if (change.reason === 'manager_change' && change.managerId) {
        return { kind: 'manager_change', importance: 2, area: 'people', text: `${who} reports to ${n.person(change.managerId)} from ${when(change.effectiveOn)}.`, personId: id('personId') }
      }
      if (change.salary != null || change.hourlyRate != null) {
        const pay = change.salary != null ? `${money(change.salary)} a year` : `${money(change.hourlyRate)} an hour`
        const why = change.reason === 'merit' ? 'merit, on their work anniversary' : (change.reason ?? 'change')
        return { kind: 'raise', importance: 2, area: 'pay', text: `Raise for ${who} to ${pay} from ${when(change.effectiveOn)} (${why}).`, personId: id('personId') }
      }
      return null
    }
    case 'saveDepartment':
      return a.headId ? { kind: 'department_head', importance: 2, area: 'people', text: `${n.person(a.headId as ID)} heads ${a.name as string} now.`, personId: a.headId as ID } : null
    case 'saveBand': {
      const family = db.families.find((f) => f.id === a.familyId)?.name ?? 'a family'
      const level = db.levels.find((l) => l.id === a.levelId)?.code ?? 'a level'
      return { kind: 'band_added', importance: 2, area: 'pay', text: `Set the ${family} ${level} band: ${money(a.min as number)} to ${money(a.max as number)}.` }
    }
    case 'markPayRunSubmitted':
      return { kind: 'pay_run', importance: 2, area: 'pay', text: `Pay run for ${fmtShort(a.start as ISODate)} to ${fmtShort(a.end as ISODate)} submitted, payday ${when(a.payday as ISODate)}.` }
    default:
      return null
  }
}
