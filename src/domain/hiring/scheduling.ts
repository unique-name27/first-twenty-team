// Scheduling without integrations: proposed times in Pacific (DST-correct), shown side by side with
// the candidate's time zone, a copyable message or mailto link, .ics files for the candidate and the
// panel, and interviews that create their owed scorecards automatically. A cancelled interview hands
// the next step back to scheduling; a cancelled or moved one gets cancellation .ics files (same UID).
// Module rule: the store import stays LAST and there are no module-level runtime constants.
import type { Draft } from 'immer'
import { getPerson, personNameById } from '@/domain/people'
import type { Application, DB, ID, Interview } from '@/domain/types'
import { addBusinessDays, type ISODate, type ISODateTime } from '@/lib/dates'
import { fillTemplate, mailtoHref } from '@/lib/email'
import { buildICS, type ICSEvent } from '@/lib/ics'
import { newId } from '@/lib/id'
import { debriefNextStep, defaultNextStep, ownerFor, stageById } from './pipeline'
import {
  addHoursISO,
  addMinutesISO,
  candidateName,
  dbHolidays,
  type HolidayInput,
  holidayDates,
  lowerFirst,
  PACIFIC_TZ,
  pacificDateOf,
  pacificToUTC,
} from './util'
import { logActivity } from '@/store/draft'

/** Default slots: 10:00 AM, 1:00 PM and 3:30 PM Pacific. */
export function defaultSlots(): Array<[hour: number, minute: number]> {
  return [
    [10, 0],
    [13, 0],
    [15, 30],
  ]
}

/**
 * Proposed interview times on the next business days after the date, one per day, cycling through
 * 10:00 AM, 1:00 PM and 3:30 PM Pacific. Returned as UTC ISO timestamps with the correct PDT or PST
 * offset for each day.
 */
export function proposeTimes(date: ISODate, holidays: HolidayInput = [], count = 3): ISODateTime[] {
  const h = holidayDates(holidays)
  const slots = defaultSlots()
  const out: ISODateTime[] = []
  let d = date
  for (let i = 0; i < count; i++) {
    d = addBusinessDays(d, 1, h)
    const [hour, minute] = slots[i % slots.length]
    out.push(pacificToUTC(d, hour, minute))
  }
  return out
}

type Parts = { weekday: string; month: string; day: string; hour: string; minute: string; dayPeriod: string; ymd: string }

function zonedParts(iso: ISODateTime, timeZone: string): Parts {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
  const map: Record<string, string> = {}
  for (const p of f.formatToParts(new Date(iso))) map[p.type] = p.value
  const ymdF = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  return {
    weekday: map.weekday ?? '',
    month: map.month ?? '',
    day: map.day ?? '',
    hour: map.hour ?? '',
    minute: map.minute ?? '00',
    dayPeriod: (map.dayPeriod ?? '').toUpperCase(),
    ymd: ymdF.format(new Date(iso)),
  }
}

/** Short zone label: PT, MT, CT, ET for US zones with daylight time; otherwise what Intl reports. */
export function zoneLabel(timeZone: string, iso: ISODateTime): string {
  const pt = ['America/Los_Angeles', 'America/Vancouver', 'America/Tijuana', 'US/Pacific']
  const mt = ['America/Denver', 'America/Boise', 'America/Edmonton', 'US/Mountain']
  const ct = ['America/Chicago', 'America/Winnipeg', 'America/Indiana/Knox', 'America/Menominee', 'US/Central']
  const et = ['America/New_York', 'America/Detroit', 'America/Toronto', 'America/Indiana/Indianapolis', 'America/Kentucky/Louisville', 'US/Eastern']
  if (pt.includes(timeZone)) return 'PT'
  if (mt.includes(timeZone)) return 'MT'
  if (ct.includes(timeZone)) return 'CT'
  if (et.includes(timeZone)) return 'ET'
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(new Date(iso))
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? timeZone
  } catch {
    return timeZone
  }
}

function validZone(tz: string | undefined | null): tz is string {
  if (!tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * 'Tue, Oct 13, 10:00 AM PT (1:00 PM ET)'. The candidate's time is left off when they are on Pacific
 * time or their zone is unknown; their date is shown when it differs from the Pacific date.
 */
export function formatDual(iso: ISODateTime, candidateTz?: string | null): string {
  const p = zonedParts(iso, PACIFIC_TZ)
  const main = `${p.weekday}, ${p.month} ${p.day}, ${p.hour}:${p.minute} ${p.dayPeriod} PT`
  if (!validZone(candidateTz) || zoneLabel(candidateTz, iso) === 'PT') return main
  const c = zonedParts(iso, candidateTz)
  const label = zoneLabel(candidateTz, iso)
  const sameDay = c.ymd === p.ymd
  const time = `${c.hour}:${c.minute} ${c.dayPeriod} ${label}`
  return `${main} (${sameDay ? time : `${c.weekday}, ${c.month} ${c.day}, ${time}`})`
}

export type DraftMessage = { to: string; subject: string; body: string; mailto: string }

/**
 * Copyable scheduling message with proposed times (Pacific plus the candidate's zone) or the
 * Calendly link. Uses the Screen invite or Onsite invite template, else a generic note.
 */
export function schedulingMessage(
  db: DB,
  appId: ID,
  times: ISODateTime[],
  opts: { calendly?: string; senderId: ID; stageId?: string; durationMin?: number },
): DraftMessage | null {
  const app = db.applications.find((a) => a.id === appId)
  if (!app) return null
  const cand = db.candidates.find((c) => c.id === app.candidateId)
  const job = db.jobs.find((j) => j.id === app.jobId)
  if (!cand || !job) return null
  const stage = stageById(job, opts.stageId ?? app.stageId)
  const kind = stage?.kind ?? 'intro'
  const calendly = opts.calendly ?? db.company.linkOuts.calendly ?? ''
  const timeLines = times.map((t) => `- ${formatDual(t, cand.timezone)}`).join('\n')
  let timesBlock = timeLines
  if (!timeLines && calendly) timesBlock = `Pick any time that works for you here: ${calendly}`
  else if (timeLines && calendly) timesBlock = `${timeLines}\n\nOr pick another time here: ${calendly}`
  const templateId = kind === 'onsite' ? 'em-onsite' : kind === 'new' || kind === 'intro' || kind === 'recruiter_screen' ? 'em-screen' : null
  const template = templateId ? db.emailTemplates.find((t) => t.id === templateId) : undefined
  const stageName = stage ? lowerFirst(stage.name) : 'interview'
  const subject = template?.subject ?? `Next step: ${stageName} for {{jobTitle}} at {{companyName}}`
  const body =
    template?.body ??
    'Hi {{firstName}},\n\nThanks again for your time. The next step is a {{duration}}{{stageName}}. Do any of these times work for you?\n\n{{times}}\n\nIf none work, reply with a few that do.\n\n{{senderName}}'
  const fields = {
    firstName: cand.firstName,
    jobTitle: job.title,
    companyName: db.company.name,
    senderName: personNameById(db, opts.senderId, db.company.name),
    times: timesBlock,
    calendly,
    stageName,
    duration: opts.durationMin ? `${opts.durationMin}-minute ` : '',
  }
  const filledSubject = fillTemplate(subject, fields)
  const filledBody = fillTemplate(body, fields)
  return { to: cand.email, subject: filledSubject, body: filledBody, mailto: mailtoHref(cand.email, filledSubject, filledBody) }
}

export type ScheduleInput = {
  applicationId: ID
  stepId?: ID
  stageId: string
  name: string
  startsAt: ISODateTime
  durationMin: number
  interviewerIds: ID[]
  format: Interview['format']
  /** Meeting link for a video interview (kept only when the format is video). */
  videoLink?: string
  /** Scorecard attribute names (or attribute objects) for this interview. */
  attributes: Array<string | { name: string }>
}

/**
 * Schedules an interview and creates one owed scorecard per interviewer, due
 * settings.scorecardDueHours after the interview ends. When the interview is for the current stage,
 * the next step becomes 'Debrief and decide' the business day after. Returns the interview id.
 */
export function scheduleInterview(draft: Draft<DB>, input: ScheduleInput, opts: { date: ISODate }): ID {
  const id = addInterview(draft, input, opts.date)
  const app = draft.applications.find((a) => a.id === input.applicationId)
  if (app) {
    logActivity(draft, {
      entityType: 'application',
      entityId: app.id,
      relatedId: app.candidateId,
      kind: 'interview_scheduled',
      text: `Scheduled ${lowerFirst(input.name)} with ${candidateName(draft, app.candidateId)} for ${formatDual(input.startsAt)}`,
    })
  }
  return id
}

/** The interview, its owed scorecards, the last contact and the debrief next step (no activity row). */
function addInterview(draft: Draft<DB>, input: ScheduleInput, date: ISODate): ID {
  const id = newId('i')
  const interviewers = [...new Set(input.interviewerIds)]
  const attrs = input.attributes.map((a) => (typeof a === 'string' ? a : a.name)).filter(Boolean)
  const videoLink = input.format === 'video' ? input.videoLink?.trim() : undefined
  const interview: Interview = {
    id,
    applicationId: input.applicationId,
    ...(input.stepId ? { stepId: input.stepId } : {}),
    stageId: input.stageId,
    name: input.name,
    startsAt: input.startsAt,
    durationMin: input.durationMin,
    interviewerIds: interviewers,
    format: input.format,
    ...(videoLink ? { videoLink } : {}),
    status: 'scheduled',
    attributes: attrs,
  }
  draft.interviews.push(interview)
  const ends = addMinutesISO(input.startsAt, input.durationMin)
  const dueAt = addHoursISO(ends, draft.settings.scorecardDueHours)
  for (const personId of interviewers) {
    draft.scorecards.push({ id: newId('s'), interviewId: id, applicationId: input.applicationId, interviewerId: personId, dueAt, ratings: {} })
  }
  const app = draft.applications.find((a) => a.id === input.applicationId)
  if (app) {
    app.lastContactOn = date
    const job = draft.jobs.find((j) => j.id === app.jobId)
    if (app.status === 'active' && app.stageId === input.stageId) {
      app.nextStep = debriefNextStep(draft, pacificDateOf(input.startsAt), job ? ownerFor(draft, job, date) : ownerFor(draft, null, date, app.nextStep?.ownerId ?? interviewers[0]))
    }
  }
  return id
}

function removeOwedScorecards(draft: Draft<DB>, interviewId: ID): void {
  draft.scorecards = draft.scorecards.filter((s) => s.interviewId !== interviewId || !!s.submittedAt)
}

/**
 * After an interview comes off the calendar: when nothing else is scheduled or done for the stage the
 * candidate is in, the next step goes back to scheduling that stage (what entering the stage sets), due
 * the next business day since the candidate was expecting a time, with the same owner. A next step
 * someone wrote by hand after scheduling (anything but the debrief) stays.
 */
function restoreSchedulingStep(draft: Draft<DB>, app: Draft<Application>, cancelled: Pick<Interview, 'stageId'>, date: ISODate): void {
  if (app.status !== 'active' || cancelled.stageId !== app.stageId) return
  if (app.nextStep && app.nextStep.text !== debriefNextStep(draft, date, '').text) return
  const live = draft.interviews.some((x) => x.applicationId === app.id && x.stageId === app.stageId && (x.status === 'scheduled' || x.status === 'completed'))
  if (live) return
  const job = draft.jobs.find((j) => j.id === app.jobId)
  const step = job ? defaultNextStep(draft, job, app.stageId, date, app.nextStep?.ownerId) : undefined
  if (step) app.nextStep = { ...step, dueOn: addBusinessDays(date, 1, dbHolidays(draft)) }
}

/**
 * Cancels an interview and drops its unsubmitted scorecards. When it leaves the candidate's stage with
 * no interview, the next step goes back to 'Schedule <stage>' (restoreSchedulingStep).
 */
export function cancelInterview(draft: Draft<DB>, interviewId: ID, opts: { date: ISODate }): boolean {
  const i = draft.interviews.find((x) => x.id === interviewId)
  if (!i || i.status === 'cancelled') return false
  i.status = 'cancelled'
  removeOwedScorecards(draft, interviewId)
  const app = draft.applications.find((a) => a.id === i.applicationId)
  if (app) {
    restoreSchedulingStep(draft, app, i, opts.date)
    logActivity(draft, {
      entityType: 'application',
      entityId: app.id,
      relatedId: app.candidateId,
      kind: 'interview_cancelled',
      text: `Cancelled ${lowerFirst(i.name)} with ${candidateName(draft, app.candidateId)}`,
    })
  }
  return true
}

/**
 * Moves a scheduled interview to a new time in one change (one Undo): the old one is cancelled with its
 * unsubmitted scorecards, and `input` is scheduled in its place, with fresh owed scorecards and the
 * debrief next step. The new interview gets its own calendar UID, so the candidate and the panel need
 * the old time's cancellation file (interviewCancelICS) as well as the new invite. Returns the new
 * interview id, or null when the old one is not on the calendar any more.
 */
export function rescheduleInterview(draft: Draft<DB>, interviewId: ID, input: ScheduleInput, opts: { date: ISODate }): ID | null {
  const old = draft.interviews.find((x) => x.id === interviewId)
  if (!old || old.status !== 'scheduled' || old.applicationId !== input.applicationId) return null
  const was = old.startsAt
  old.status = 'cancelled'
  removeOwedScorecards(draft, interviewId)
  const id = addInterview(draft, input, opts.date)
  const app = draft.applications.find((a) => a.id === input.applicationId)
  if (app) {
    logActivity(draft, {
      entityType: 'application',
      entityId: app.id,
      relatedId: app.candidateId,
      kind: 'interview_rescheduled',
      text: `Moved ${lowerFirst(input.name)} with ${candidateName(draft, app.candidateId)} from ${formatDual(was)} to ${formatDual(input.startsAt)}`,
    })
  }
  return id
}

/** Marks an interview completed or a no-show (a no-show drops its owed scorecards). */
export function setInterviewStatus(draft: Draft<DB>, interviewId: ID, status: 'completed' | 'no_show', _opts: { date: ISODate }): boolean {
  const i = draft.interviews.find((x) => x.id === interviewId)
  if (!i || i.status === status) return false
  i.status = status
  if (status === 'no_show') removeOwedScorecards(draft, interviewId)
  const app = draft.applications.find((a) => a.id === i.applicationId)
  if (app) {
    const name = candidateName(draft, app.candidateId)
    logActivity(draft, {
      entityType: 'application',
      entityId: app.id,
      relatedId: app.candidateId,
      kind: status === 'no_show' ? 'interview_no_show' : 'interview_completed',
      text: status === 'no_show' ? `${name} missed the ${lowerFirst(i.name)}` : `Completed ${lowerFirst(i.name)} with ${name}`,
    })
  }
  return true
}

/** Records that the .ics was downloaded or sent. */
export function markIcsIssued(draft: Draft<DB>, interviewId: ID, date: ISODate): boolean {
  const i = draft.interviews.find((x) => x.id === interviewId)
  if (!i) return false
  i.icsIssuedOn = date
  return true
}

/**
 * .ics for an interview. The candidate's copy lists who they will meet; the panel's copy names the
 * candidate and the scorecard attributes, and only the panel are attendees on it (never the candidate).
 * Times are written in UTC so every calendar shows local time.
 * A video interview carries its meeting link (LOCATION, URL and the description); without one the
 * location just says 'Video call' and never claims a link is somewhere else. People with no email
 * address on file (a founder who has not added one yet) are left off the attendee list by buildICS.
 */
export function interviewICS(db: DB, interviewId: ID, audience: 'candidate' | 'panel' = 'panel'): string | null {
  const i = db.interviews.find((x) => x.id === interviewId)
  if (!i) return null
  return buildICS([interviewEvent(db, i, audience)], audience === 'candidate' ? `${db.company.name} interview` : 'First Twenty interviews')
}

/**
 * Cancellation .ics for an interview that came off the calendar (cancelled, or moved to a new time): the
 * invite's own UID one SEQUENCE higher, with METHOD:CANCEL and STATUS:CANCELLED, so a calendar that
 * added the invite drops it or marks it cancelled. The title starts 'Cancelled:' for calendars that
 * import it as a plain event, and the meeting link is left out so nobody joins an empty room.
 */
export function interviewCancelICS(db: DB, interviewId: ID, audience: 'candidate' | 'panel' = 'panel'): string | null {
  const i = db.interviews.find((x) => x.id === interviewId)
  if (!i) return null
  const { url: _link, ...event } = interviewEvent(db, i, audience)
  return buildICS(
    [
      {
        ...event,
        title: `Cancelled: ${event.title}`,
        description: 'This interview is cancelled.',
        ...(i.format === 'video' ? { location: 'Video call' } : {}),
        sequence: (event.sequence ?? 0) + 1,
        status: 'CANCELLED',
      },
    ],
    audience === 'candidate' ? `${db.company.name} interview` : 'First Twenty interviews',
    { method: 'CANCEL' },
  )
}

function interviewEvent(db: DB, i: Interview, audience: 'candidate' | 'panel'): ICSEvent {
  const app = db.applications.find((a) => a.id === i.applicationId)
  const cand = app ? db.candidates.find((c) => c.id === app.candidateId) : undefined
  const job = app ? db.jobs.find((j) => j.id === app.jobId) : undefined
  const company = db.company
  const panel = i.interviewerIds.map((id) => getPerson(db, id)).filter((p) => !!p)
  const hq = company.hq
  const address = [hq.street, hq.suite, hq.city, `${hq.state} ${hq.zip}`].filter((x) => x && String(x).trim()).join(', ')
  const videoLink = i.format === 'video' ? i.videoLink?.trim() || undefined : undefined
  const location =
    i.format === 'onsite'
      ? `${company.name}, ${address}`
      : i.format === 'video'
        ? (videoLink ?? 'Video call')
        : audience === 'panel' && cand?.phone
          ? `Phone: ${cand.phone}`
          : 'Phone call'
  const cName = cand ? `${cand.firstName} ${cand.lastName}` : 'Candidate'
  const jobTitle = job?.title ?? 'Interview'
  const meet = panel.map((p) => `${p.preferredName || p.firstName} ${p.lastName} (${p.title})`)
  const join = videoLink ? `\nJoin the video call: ${videoLink}` : ''
  return {
    uid: `${i.id}-${audience}`,
    title: audience === 'candidate' ? `${company.name}: ${i.name} for ${jobTitle}` : `${i.name}: ${cName} (${jobTitle})`,
    start: i.startsAt,
    end: addMinutesISO(i.startsAt, i.durationMin),
    location,
    ...(videoLink ? { url: videoLink } : {}),
    description:
      audience === 'candidate'
        ? `${i.durationMin} minutes. You will meet ${meet.length ? meet.join(', ') : 'the team'}.${join}\nReply to the scheduling email if you need to change the time.`
        : `${i.durationMin} minutes with ${cName} for ${jobTitle}.${join}${i.attributes.length ? `\nScorecard attributes: ${i.attributes.join(', ')}.` : ''}\nScorecard due within ${db.settings.scorecardDueHours} hours of the end.`,
    // The panel's copy (internal title, scorecard attributes) lists only the panel, so a calendar that
    // sends invites can never mail it to the candidate; it names them in the title and description.
    attendees: [
      ...(audience === 'candidate' && cand?.email ? [{ name: cName, email: cand.email }] : []),
      ...panel.map((p) => ({ name: `${p.preferredName || p.firstName} ${p.lastName}`, email: p.workEmail })),
    ],
  }
}

export type ProposeOpts = {
  /** Who will interview. Their scheduled interviews and approved days off are avoided. */
  panelIds?: ID[]
  /** The candidate's IANA time zone: slots inside 9 AM to 5 PM there are preferred. */
  candidateTz?: string | null
  /** Interview length in minutes (default 45). */
  durationMin?: number
  /** Leave this application's own interviews out of the conflict check (rescheduling). */
  applicationId?: ID
}

type SchedulingDB = Pick<DB, 'holidays'> & Partial<Pick<DB, 'interviews' | 'timeOffRequests'>>

/** Extra start times tried, in order, when the default slot of a day is taken. */
function fallbackSlots(): Array<[hour: number, minute: number]> {
  return [
    [10, 0],
    [13, 0],
    [15, 30],
    [11, 0],
    [14, 0],
    [9, 30],
    [16, 0],
  ]
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd
}

/** Interviews already on the calendar that overlap this time for anyone on the panel (all interviewers when no panel is given). */
export function interviewConflicts(
  db: Pick<DB, 'interviews'>,
  startsAt: ISODateTime,
  durationMin: number,
  panelIds?: ID[],
  exceptApplicationId?: ID,
): Interview[] {
  const s = Date.parse(startsAt)
  const e = s + durationMin * 60_000
  return db.interviews.filter((i) => {
    if (i.status !== 'scheduled' || (exceptApplicationId && i.applicationId === exceptApplicationId)) return false
    if (panelIds && panelIds.length > 0 && !i.interviewerIds.some((id) => panelIds.includes(id))) return false
    const is = Date.parse(i.startsAt)
    return overlaps(s, e, is, is + i.durationMin * 60_000)
  })
}

/** Panelists with approved full-day time off covering the Pacific date of this time. */
export function panelOutOn(db: Pick<DB, 'timeOffRequests'>, date: ISODate, panelIds: ID[]): ID[] {
  return panelIds.filter((id) =>
    db.timeOffRequests.some((r) => r.personId === id && r.status === 'approved' && !r.partial && r.startDate <= date && r.endDate >= date),
  )
}

/**
 * Panelists whose approved time off overlaps this interview: a full day off, or a half day whose
 * part of the day the interview touches. A morning off ('am') is busy before 12:00 PM Pacific and an
 * afternoon off ('pm') from 12:00 PM Pacific. One entry per panelist; a full day wins.
 */
export function panelTimeOffAt(
  db: Pick<DB, 'timeOffRequests'>,
  startsAt: ISODateTime,
  durationMin: number,
  panelIds: ID[],
): Array<{ personId: ID; part: 'day' | 'am' | 'pm' }> {
  const day = pacificDateOf(startsAt)
  const s = Date.parse(startsAt)
  const e = s + durationMin * 60_000
  const noon = Date.parse(pacificToUTC(day, 12, 0))
  const out: Array<{ personId: ID; part: 'day' | 'am' | 'pm' }> = []
  for (const id of panelIds) {
    const covering = db.timeOffRequests.filter((r) => r.personId === id && r.status === 'approved' && r.startDate <= day && r.endDate >= day)
    if (covering.some((r) => !r.partial)) {
      out.push({ personId: id, part: 'day' })
      continue
    }
    const half = covering.find((r) => (r.partial === 'am' && s < noon) || (r.partial === 'pm' && e > noon))
    if (half?.partial) out.push({ personId: id, part: half.partial })
  }
  return out
}

/**
 * Plain-language reasons a picked time is a problem: a panelist is already interviewing then, or is
 * out that day (or that morning or afternoon, for a half day off). Empty when the time is clear.
 * Shown as a warning in the schedule sheet.
 */
export function scheduleWarnings(
  db: DB,
  startsAt: ISODateTime,
  durationMin: number,
  panelIds: ID[],
  exceptApplicationId?: ID,
): string[] {
  const out: string[] = []
  for (const i of interviewConflicts(db, startsAt, durationMin, panelIds, exceptApplicationId)) {
    const who = i.interviewerIds.filter((id) => panelIds.includes(id)).map((id) => personNameById(db, id))
    const app = db.applications.find((a) => a.id === i.applicationId)
    out.push(`${who.join(' and ')} already ${who.length > 1 ? 'have' : 'has'} ${i.name} with ${candidateName(db, app?.candidateId)} then.`)
  }
  for (const { personId, part } of panelTimeOffAt(db, startsAt, durationMin, panelIds)) {
    const when = part === 'am' ? 'morning' : part === 'pm' ? 'afternoon' : 'day'
    out.push(`${personNameById(db, personId)} is out that ${when}.`)
  }
  return out
}

function inWorkingHours(startsAt: ISODateTime, durationMin: number, tz: string | null | undefined): boolean {
  if (!tz) return true
  try {
    const hourIn = (iso: ISODateTime) => {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso))
      const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
      const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
      return h + m / 60
    }
    const start = hourIn(startsAt)
    const end = start + durationMin / 60
    return start >= 9 && end <= 17
  } catch {
    return true
  }
}

/**
 * Proposed times for the next business days from the workspace holidays, one per day. Each day keeps
 * the 10:00 AM, 1:00 PM, 3:30 PM Pacific rotation when that slot is free, and otherwise tries other
 * times that day. A slot is skipped when it overlaps a scheduled interview of anyone on the panel (or
 * of any interviewer when no panel is given), on days a panelist is out, in the half of the day a
 * panelist has off, and, when the candidate's zone is known, when it falls outside 9 AM to 5 PM there.
 */
export function proposeTimesFor(db: SchedulingDB, date: ISODate, count = 3, opts: ProposeOpts = {}): ISODateTime[] {
  const h = dbHolidays(db)
  const dur = opts.durationMin ?? 45
  const panel = opts.panelIds ?? []
  const interviews = db.interviews ?? []
  const timeOff = db.timeOffRequests ?? []
  const preferred = defaultSlots()
  const pool = fallbackSlots()
  const out: ISODateTime[] = []
  let d = date
  for (let tries = 0; tries < 20 && out.length < count; tries++) {
    d = addBusinessDays(d, 1, h)
    if (panel.length > 0 && panelOutOn({ timeOffRequests: timeOff }, d, panel).length > 0) continue
    const first = preferred[out.length % preferred.length]
    const order = [first, ...pool.filter(([hh, mm]) => hh !== first[0] || mm !== first[1])]
    const ok = (t: ISODateTime) =>
      interviewConflicts({ interviews }, t, dur, panel.length ? panel : undefined, opts.applicationId).length === 0 &&
      (panel.length === 0 || panelTimeOffAt({ timeOffRequests: timeOff }, t, dur, panel).length === 0) &&
      inWorkingHours(t, dur, opts.candidateTz)
    const pick = order.map(([hh, mm]) => pacificToUTC(d, hh, mm)).find(ok)
    if (pick) out.push(pick)
  }
  // Never come back empty-handed: fill with the plain rotation if the calendar is that full.
  if (out.length < count) {
    for (const t of proposeTimes(date, h, count * 2)) {
      if (out.length >= count) break
      if (!out.includes(t)) out.push(t)
    }
    out.sort()
  }
  return out
}
