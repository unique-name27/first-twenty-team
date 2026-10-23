// Logging an interview that already happened ("after the call, fill a scorecard"): the interview is
// created as completed, its scorecards are owed right away and due a full window from now (a call
// logged two days late is not born overdue), and the debrief step is never due in the past.
// When the same step is already on the calendar (say the intro call booked for Monday, held early on
// Sunday), logging it moves that interview to the time it was held instead of adding a second one, so
// there is one interview, one set of owed scorecards, and the old time's cancellation note and .ics.
import type { Draft } from 'immer'
import { formatDual, rescheduleInterview, scheduleInterview, type ScheduleInput } from '@/domain/hiring/scheduling'
import { addHoursISO, candidateName, lowerFirst, pacificToUTC } from '@/domain/hiring/util'
import type { Application, DB, ID, Interview, InterviewStep, Job } from '@/domain/types'
import { addDays, fmtDay, type ISODate, type ISODateTime } from '@/lib/dates'
import { clockLabel, defaultStepFor, orderedSteps } from './logic'

/** Pacific wall-clock times offered when logging a past interview (7 AM to 6 PM). */
export function pastTimes(): Array<{ hour: number; minute: number; label: string }> {
  const out: Array<{ hour: number; minute: number; label: string }> = []
  for (let hour = 7; hour <= 18; hour++) out.push({ hour, minute: 0, label: clockLabel(hour, 0) })
  return out
}

/** UTC start for a past interview: the Pacific date and time as picked (no weekend snapping). */
export function pastStart(date: ISODate, hour: number, minute = 0): ISODateTime {
  return pacificToUTC(date, hour, minute)
}

/** Day chips for a past interview: Today, Yesterday, then the four days before by name. */
export function pastDayPresets(date: ISODate): Array<{ label: string; date: ISODate }> {
  const out = [
    { label: 'Today', date },
    { label: 'Yesterday', date: addDays(date, -1) },
  ]
  for (let i = 2; i <= 5; i++) {
    const d = addDays(date, -i)
    out.push({ label: fmtDay(d), date: d })
  }
  return out
}

/** Index of the latest past time on `date` that has started by `now`; -1 when none has. */
export function latestStartedTime(date: ISODate, now: ISODateTime): number {
  const times = pastTimes()
  let idx = -1
  times.forEach((t, i) => {
    if (pastStart(date, t.hour, t.minute) <= now) idx = i
  })
  return idx
}

/** The interview on the calendar (still scheduled) for this application and step, the earliest; undefined when none. */
export function scheduledForStep(interviews: Interview[], applicationId: ID, stepId: ID | undefined): Interview | undefined {
  if (!stepId) return undefined
  return interviews
    .filter((i) => i.applicationId === applicationId && i.stepId === stepId && i.status === 'scheduled')
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0]
}

/**
 * The step "Already happened" starts on: a step of this application already on the calendar (the
 * earliest), since a call held early is the usual reason to log one, else the next step to schedule.
 */
export function defaultLogStep(job: Pick<Job, 'interviewPlan' | 'stages'>, app: Pick<Application, 'id' | 'stageId'>, interviews: Interview[]): InterviewStep | undefined {
  const plan = orderedSteps(job)
  const booked = interviews
    .filter((i) => i.applicationId === app.id && i.status === 'scheduled' && plan.some((s) => s.id === i.stepId))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0]
  return plan.find((s) => s.id === booked?.stepId) ?? defaultStepFor(job, app, interviews)
}

/**
 * Records an interview that already took place. Creates it through scheduleInterview (owed scorecards,
 * debrief next step), then marks it completed with one activity row. With `replacesId` (the same step
 * already on the calendar) it moves that interview to the logged time instead (rescheduleInterview: the
 * old time is cancelled with its owed scorecards, so only one set is owed) and marks it completed.
 * Returns the logged interview id.
 */
export function logPastInterview(draft: Draft<DB>, input: ScheduleInput, opts: { date: ISODate; now: ISODateTime; replacesId?: ID }): ID {
  if (input.startsAt > opts.now) throw new Error('That time has not happened yet. Pick an earlier time, or schedule it instead.')
  const before = draft.activity.length
  const replaced = opts.replacesId ? draft.interviews.find((i) => i.id === opts.replacesId && i.status === 'scheduled' && i.applicationId === input.applicationId) : undefined
  const was = replaced?.startsAt
  const moved = replaced ? rescheduleInterview(draft, replaced.id, input, { date: opts.date }) : null
  const id = moved ?? scheduleInterview(draft, input, { date: opts.date })
  const interview = draft.interviews.find((i) => i.id === id)
  if (interview) interview.status = 'completed'
  const due = addHoursISO(opts.now, draft.settings.scorecardDueHours)
  for (const s of draft.scorecards) if (s.interviewId === id && !s.submittedAt && s.dueAt < due) s.dueAt = due
  const app = draft.applications.find((a) => a.id === input.applicationId)
  if (app?.nextStep && app.nextStep.text === 'Debrief and decide' && app.nextStep.dueOn < opts.date) app.nextStep.dueOn = opts.date
  // scheduleInterview logged 'Scheduled ... for <a past time>' (rescheduleInterview 'Moved ...'); say what happened instead.
  const row = draft.activity.slice(before).find((a) => (a.kind === 'interview_scheduled' || a.kind === 'interview_rescheduled') && a.entityId === input.applicationId)
  if (row && app) {
    row.kind = 'interview_completed'
    const booked = was ? ` (it was on the calendar for ${formatDual(was)})` : ''
    row.text = `Logged the ${lowerFirst(input.name)} with ${candidateName(draft, app.candidateId)}, held ${formatDual(input.startsAt)}${booked}`
  }
  return id
}
