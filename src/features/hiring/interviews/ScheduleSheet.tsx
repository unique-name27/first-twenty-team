// Schedule an interview without integrations: pick the step from the job's interview plan, one of 3
// proposed times (Pacific plus the candidate's zone) or Pick, the duration, the panel and the format.
// Saving creates the interview and its owed scorecards, then shows the scheduling message (Copy, Open
// in mail app) and .ics files for the candidate and the panel (Copy as text when downloads are blocked).
// "Already happened" logs a past interview instead (Today, Yesterday or an earlier day): it is saved as
// completed and the logger's scorecard opens right away. It starts on a step already on the calendar
// (a call held early); logging that step moves the booked interview to the time it was held (one
// interview, one set of owed scorecards), then, while the old time is still ahead, offers its
// cancellation note and .ics for the candidate.
// Proposed times follow the panel, the length and the candidate's zone (conflicts.ts): they skip times a
// panelist is busy or out and times the candidate already has an interview. Any picked time that still
// clashes shows a warning naming who and why; it can be scheduled anyway.
// A video interview takes a meeting link (prefilled from Settings > Link-outs), which goes into the
// confirmation message and the calendar files. Without one, both say so plainly.
// Reschedule opens the same form prefilled from an interview; saving moves it in one Undo step and the
// invite sheet then offers the 'has moved' message, the new files and cancellation files for the old time.
import { useMemo, useState } from 'react'
import { useViewer } from '@/app/useViewer'
import {
  type DraftMessage,
  formatDual,
  interviewCancelICS,
  interviewICS,
  proposeTimesFor,
  rescheduleInterview,
  scheduleInterview,
  schedulingMessage,
} from '@/domain/hiring/scheduling'
import { stageById } from '@/domain/hiring/pipeline'
import { interviewCancelMessage } from '@/domain/hiring/messages'
import { candidateName, dbHolidays, fmtDayPlain, lowerFirst } from '@/domain/hiring/util'
import { founder, fullName, getPerson, isEmployedOn, personNameById } from '@/domain/people'
import type { ID, Interview } from '@/domain/types'
import { addBusinessDays, nowISO, today } from '@/lib/dates'
import { mailtoHref } from '@/lib/email'
import { slug } from '@/lib/files'
import { listJoin } from '@/lib/format'
import { useDB } from '@/store/db'
import { Button, Callout, ChipGroup, ChipMulti, DateChips, Field, focusFirstInvalid, rovingKeyDown, rovingTabIndex, Segmented, Select, Sheet, TextInput } from '@/ui'
import { act, copyWithToast, IcsFileButtons, InvalidChips, Note, TextPreview } from './common'
import { proposedSlots, slotWarnings } from './conflicts'
import { confirmationBody, defaultStepFor, durationChoices, formatForStage, orderedSteps, pickedStart, pickTimes } from './logic'
import { defaultLogStep, latestStartedTime, logPastInterview, pastDayPresets, pastStart, pastTimes, scheduledForStep } from './pastInterview'
import { ScorecardSheet } from './ScorecardSheet'
import { missingWorkEmailHint } from '../logic'

export type ScheduleMode = 'schedule' | 'log'

const FORMAT_OPTIONS: Array<{ value: Interview['format']; label: string }> = [
  { value: 'video', label: 'Video' },
  { value: 'onsite', label: 'On site' },
  { value: 'phone', label: 'Phone' },
]

export function ScheduleSheet({
  applicationId,
  open,
  onClose,
  mode = 'schedule',
  rescheduleId,
}: {
  applicationId: ID
  open: boolean
  onClose: () => void
  mode?: ScheduleMode
  /** Move this interview to a new time instead of scheduling another one. */
  rescheduleId?: ID | null
}) {
  const [scheduled, setScheduled] = useState<{ id: ID; replacedId?: ID } | null>(null)
  const [scorecardId, setScorecardId] = useState<ID | null>(null)
  // A logged interview that was on the calendar: its old time (now cancelled) and the held one, so the
  // candidate can be told and sent the cancellation file after the scorecard.
  const [moved, setMoved] = useState<{ fromId: ID; heldId: ID } | null>(null)
  if (!open) return null
  const close = () => {
    setScheduled(null)
    setScorecardId(null)
    setMoved(null)
    onClose()
  }
  if (scorecardId) return <ScorecardSheet scorecardId={scorecardId} open onClose={moved ? () => setScorecardId(null) : close} />
  if (moved) return <CancelSheet interviewId={moved.fromId} heldInterviewId={moved.heldId} onClose={close} />
  return scheduled ? (
    <InviteSheet interviewId={scheduled.id} open onClose={close} justScheduled replacedId={scheduled.replacedId} />
  ) : (
    <ScheduleForm
      applicationId={applicationId}
      initialMode={rescheduleId ? 'schedule' : mode}
      rescheduleId={rescheduleId ?? null}
      onClose={close}
      onScheduled={(id, replacedId) => setScheduled(replacedId ? { id, replacedId } : { id })}
      onLogged={(cardId, movedFrom) => {
        if (movedFrom) setMoved(movedFrom)
        if (cardId) setScorecardId(cardId)
        else if (!movedFrom) close()
      }}
    />
  )
}

function ScheduleForm({
  applicationId,
  initialMode,
  rescheduleId,
  onClose,
  onScheduled,
  onLogged,
}: {
  applicationId: ID
  initialMode: ScheduleMode
  rescheduleId: ID | null
  onClose: () => void
  onScheduled: (id: ID, replacedId?: ID) => void
  /** After logging: the logger's scorecard to fill, and the booked interview it moved (when there was one). */
  onLogged: (scorecardId: ID | null, moved?: { fromId: ID; heldId: ID }) => void
}) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const app = db.applications.find((a) => a.id === applicationId)
  const job = app ? db.jobs.find((j) => j.id === app.jobId) : undefined
  const cand = app ? db.candidates.find((c) => c.id === app.candidateId) : undefined
  const date = today()
  const interviews = useMemo(() => db.interviews.filter((i) => i.applicationId === applicationId), [db.interviews, applicationId])
  const steps = job ? orderedSteps(job) : []
  // Rescheduling starts from the interview being moved: its step (or its name), length, panel and format.
  const moving = rescheduleId ? interviews.find((i) => i.id === rescheduleId) : undefined
  // Logging starts on a step already on the calendar (defaultLogStep), with that interview's panel and length.
  const stepFor = (m: ScheduleMode) => (job && app ? (m === 'log' ? defaultLogStep(job, app, interviews) : defaultStepFor(job, app, interviews)) : undefined)
  const initial = moving ? steps.find((s) => s.id === moving.stepId) : stepFor(initialMode)
  const initialBooked = !moving && initialMode === 'log' ? scheduledForStep(interviews, applicationId, initial?.id) : undefined

  const [stepId, setStepId] = useState<string>(initial?.id ?? 'custom')
  // Set once a step is picked by hand, so switching between Schedule ahead and Already happened leaves it alone.
  const [stepPicked, setStepPicked] = useState(false)
  const step = steps.find((s) => s.id === stepId)
  const stageFor = (sid: string | undefined) => (job && sid ? stageById(job, sid) : undefined)
  const [customName, setCustomName] = useState(() => (moving && !initial ? moving.name : ''))
  const [time, setTime] = useState<string>('')
  const [picking, setPicking] = useState(false)
  const [pickDate, setPickDate] = useState<string>(() => addBusinessDays(date, 1, dbHolidays(db)))
  const [pickIdx, setPickIdx] = useState(1)
  const [duration, setDuration] = useState<number>(moving?.durationMin ?? initialBooked?.durationMin ?? initial?.durationMin ?? 45)
  const stillHere = (id: ID) => {
    const p = getPerson(db, id)
    return !!p && (isEmployedOn(p, date) || p.startDate > date)
  }
  const defaultPanel = (sid: string): ID[] => {
    const s = steps.find((x) => x.id === sid)
    const ids = s?.interviewerIds.length ? s.interviewerIds : job ? [job.hiringManagerId] : []
    return ids.filter(stillHere)
  }
  const viewerCanInterview = !!viewer.personId && db.people.some((p) => p.id === viewer.personId && (isEmployedOn(p, date) || p.startDate > date))
  const [panel, setPanel] = useState<ID[]>(() =>
    moving
      ? moving.interviewerIds.filter(stillHere)
      : initialBooked
        ? initialBooked.interviewerIds.filter(stillHere)
        : initialMode === 'log' && viewerCanInterview && viewer.personId
          ? [viewer.personId]
          : defaultPanel(initial?.id ?? ''),
  )
  const [format, setFormat] = useState<Interview['format']>(() => moving?.format ?? initialBooked?.format ?? formatForStage(stageFor(initial?.stageId ?? app?.stageId)?.kind))
  const [videoLink, setVideoLink] = useState(() => moving?.videoLink ?? db.company.linkOuts.videoRoom ?? '')
  const [mode, setMode] = useState<ScheduleMode>(initialMode)
  const [tried, setTried] = useState(false)
  // Proposed times avoid the panel's interviews and days off, the candidate's own interviews and
  // hours outside 9 to 5 in the candidate's zone. They move when the panel or the length changes.
  const candTz = cand?.timezone ?? null
  const proposals = useMemo(
    () => proposedSlots(db, date, { panelIds: panel, candidateTz: candTz, durationMin: duration, applicationId }),
    [db, date, panel, candTz, duration, applicationId],
  )
  // The chosen proposal, or the first one when the list moved on.
  const chosen = proposals.includes(time) ? time : (proposals[0] ?? '')
  const timeItems = [...proposals.map((t) => ({ on: !picking && t === chosen })), { on: picking }]
  // Logging a past interview: default to the latest hour that has started today, else yesterday.
  const now = nowISO()
  const startedToday = latestStartedTime(date, now)
  const [pastDate, setPastDate] = useState<string>(() => (startedToday >= 0 ? date : pastDayPresets(date)[1].date))
  const [pastIdx, setPastIdx] = useState<number>(() => (startedToday >= 0 ? startedToday : 3))
  /**
   * Picks a step for a mode. Scheduling ahead takes the step's default panel. Logging a step already on
   * the calendar takes that interview's panel, length and format (logging moves it); any other step keeps
   * the panel, which starts as the person logging, who usually held the call.
   */
  const applyStep = (sid: string, m: ScheduleMode) => {
    setStepId(sid)
    const s = steps.find((x) => x.id === sid)
    if (!s) return
    const booked = m === 'log' ? scheduledForStep(interviews, applicationId, sid) : undefined
    setDuration(booked?.durationMin ?? s.durationMin)
    setFormat(booked?.format ?? formatForStage(stageFor(s.stageId)?.kind))
    if (booked) setPanel(booked.interviewerIds.filter(stillHere))
    else if (m !== 'log') setPanel(defaultPanel(sid))
  }
  const chooseMode = (m: ScheduleMode) => {
    setMode(m)
    const next = stepPicked ? undefined : stepFor(m)
    if (next && next.id !== stepId) {
      applyStep(next.id, m)
      if (m === 'log' && scheduledForStep(interviews, applicationId, next.id)) return
    }
    // The person logging a past call usually held it.
    if (m === 'log' && viewerCanInterview && viewer.personId && !panel.includes(viewer.personId)) setPanel([viewer.personId])
  }

  if (!app || !job || !cand) {
    return (
      <Sheet open onClose={onClose} title="Schedule interview">
        <p className="text-[14px] text-ink-2">This application is no longer on file.</p>
      </Sheet>
    )
  }
  if (rescheduleId && moving?.status !== 'scheduled') {
    return (
      <Sheet open onClose={onClose} title="Reschedule interview">
        <p className="text-[14px] text-ink-2">This interview is no longer on the calendar. Schedule a new one instead.</p>
      </Sheet>
    )
  }

  const name = `${cand.firstName} ${cand.lastName}`
  const people = db.people.filter((p) => isEmployedOn(p, date) || (p.startDate > date && !p.endDate))
  const suggestedIds = [...new Set([job.hiringManagerId, ...job.panelIds, ...steps.flatMap((s) => s.interviewerIds), ...panel])].filter((id) =>
    people.some((p) => p.id === id),
  )
  const others = people.filter((p) => !suggestedIds.includes(p.id)).sort((a, b) => fullName(a).localeCompare(fullName(b)))
  const logging = mode === 'log'
  const pastOptions = pastTimes().map((t, i) => ({ ...t, i, future: pastStart(pastDate, t.hour, t.minute) > now }))
  const pastPick = pastOptions[pastIdx] && !pastOptions[pastIdx].future ? pastOptions[pastIdx] : undefined
  const startsAt = logging
    ? pastPick
      ? pastStart(pastDate, pastPick.hour, pastPick.minute)
      : ''
    : picking
      ? pickedStart(pickDate, pickTimes()[pickIdx].hour, pickTimes()[pickIdx].minute)
      : chosen
  const stage = step ? stageFor(step.stageId) : stageFor(moving?.stageId ?? app.stageId)
  const interviewName = step ? step.name : customName.trim() || (stage ? stage.name : 'Interview')

  const chooseStep = (sid: string) => {
    setStepPicked(true)
    applyStep(sid, mode)
  }
  // Logging a step that is already on the calendar moves that interview (logPastInterview replacesId).
  // When its time is still ahead, the candidate has an invite to take back (the cancellation sheet follows).
  const booked = logging ? scheduledForStep(interviews, app.id, step?.id) : undefined
  const bookedAhead = !!booked && booked.startsAt > now

  const input = {
    applicationId: app.id,
    ...(step ? { stepId: step.id } : {}),
    stageId: step?.stageId ?? moving?.stageId ?? app.stageId,
    name: interviewName,
    startsAt,
    durationMin: duration,
    interviewerIds: panel,
    format,
    ...(format === 'video' && videoLink.trim() ? { videoLink: videoLink.trim() } : {}),
    attributes: step?.attributes ?? [],
  }
  const myCardAfterLog = !!viewer.personId && panel.includes(viewer.personId)
  const warnings = logging ? [] : slotWarnings(db, startsAt, { panelIds: panel, durationMin: duration, applicationId: app.id })
  const panelError = tried && panel.length === 0 ? 'Pick at least one interviewer.' : null
  const timeError = tried && !startsAt ? (logging ? 'Pick a start time that has already passed, or an earlier day.' : 'Pick a time.') : null
  const save = () => {
    if (!startsAt || panel.length === 0) {
      setTried(true)
      focusFirstInvalid()
      return
    }
    if (logging) {
      const res = act(`Logged the ${lowerFirst(interviewName)} with ${name}`, (d) => logPastInterview(d, input, { date, now: nowISO(), ...(booked ? { replacesId: booked.id } : {}) }))
      if (!res) return
      const cards = useDB.getState().db.scorecards.filter((sc) => sc.interviewId === res.value && !sc.submittedAt)
      const mine = cards.find((sc) => sc.interviewerId === viewer.personId)
      const moved = booked && bookedAhead && useDB.getState().db.interviews.find((i) => i.id === booked.id)?.status === 'cancelled' ? { fromId: booked.id, heldId: res.value } : undefined
      onLogged(mine?.id ?? (viewer.role === 'admin' ? (cards[0]?.id ?? null) : null), moved)
      return
    }
    if (moving) {
      // One change: the old time comes off the calendar and the new one goes on (one Undo).
      const res = act(`Rescheduled the ${lowerFirst(interviewName)} with ${name}`, (d) => rescheduleInterview(d, moving.id, input, { date }) ?? false)
      if (res?.value) onScheduled(res.value, moving.id)
      return
    }
    const res = act(`Scheduled ${lowerFirst(interviewName)} with ${name}`, (d) => scheduleInterview(d, input, { date }))
    if (res) onScheduled(res.value)
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={logging ? `Log a past interview: ${name}` : moving ? `Reschedule interview: ${name}` : `Schedule interview: ${name}`}
      subtitle={
        logging
          ? `${job.title}. Saved as completed, with scorecards owed by the panel.`
          : `${job.title}.${moving ? ` ${moving.name}, now ${formatDual(moving.startsAt, cand.timezone)}.` : ''} Times in Pacific${cand.timezone && cand.timezone !== 'America/Los_Angeles' ? " and the candidate's time zone" : ''}.`
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {logging ? (
            <Button variant="primary" size="lg" icon={myCardAfterLog ? 'edit' : 'check'} onClick={save}>
              {myCardAfterLog ? 'Log it and fill my scorecard' : 'Log interview'}
            </Button>
          ) : (
            <Button variant="primary" size="lg" icon="calendar-check" onClick={save}>
              {moving ? (warnings.length ? 'Reschedule anyway' : 'Reschedule') : warnings.length ? 'Schedule anyway' : 'Schedule interview'}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-6">
        {!moving && (
          <Segmented
            label="Is the interview coming up or already done"
            value={mode}
            onChange={chooseMode}
            options={[
              { value: 'schedule', label: 'Schedule ahead' },
              { value: 'log', label: 'Already happened' },
            ]}
          />
        )}
        <Field label="Interview step">
          {() =>
            steps.length ? (
              <ChipGroup
                label="Interview step"
                value={stepId}
                onChange={chooseStep}
                options={[
                  ...steps.map((s) => ({ value: s.id, label: `${stageFor(s.stageId)?.name ?? 'Step'}: ${s.name}` })),
                  { value: 'custom', label: 'Other' },
                ]}
              />
            ) : (
              <p className="text-[13.5px] text-ink-3">This job has no interview plan yet. Name the interview below.</p>
            )
          }
        </Field>
        {booked && (
          <Callout tone="accent" icon="calendar" title={`${booked.name} is already on the calendar`}>
            Scheduled for {formatDual(booked.startsAt, cand.timezone)}. Logging it now moves that interview to the time you pick and marks it held, so the panel owes one
            scorecard each, not two.
            {bookedAhead ? ` Next you can send ${cand.firstName} a note and a calendar file that takes the old time off their calendar.` : ''}
          </Callout>
        )}
        {(stepId === 'custom' || steps.length === 0) && (
          <Field label="Interview name" hint="For example: Reference call with the hiring manager">
            {(id, describedBy) => <TextInput id={id} aria-describedby={describedBy} value={customName} onChange={(e) => setCustomName(e.target.value)} />}
          </Field>
        )}
        {logging ? (
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1.5 text-[13.5px] font-semibold text-ink-2">When it happened</legend>
            <InvalidChips id="sch-past" error={timeError}>
              <DateChips label="Interview date" value={pastDate} onChange={setPastDate} presets={pastDayPresets(date)} max={date} />
              <ChipGroup
                label="Start time (Pacific)"
                value={pastPick ? String(pastIdx) : null}
                onChange={(v) => setPastIdx(Number(v))}
                options={pastOptions.map((t) => ({ value: String(t.i), label: `${t.label} PT`, disabled: t.future, ...(t.future ? { hint: 'Later than now' } : {}) }))}
              />
            </InvalidChips>
            <p className="num text-[13.5px] font-semibold text-ink" aria-live="polite">
              {startsAt ? formatDual(startsAt, cand.timezone) : 'Pick a start time that has already passed.'}
            </p>
          </fieldset>
        ) : (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-[13.5px] font-semibold text-ink-2">When</legend>
            {/* One Tab stop; arrows, Home and End move focus and Space or Enter picks the time. */}
            <div role="radiogroup" aria-label="Proposed times" onKeyDown={(e) => rovingKeyDown(e)} className="flex flex-col gap-2">
              {proposals.map((t, i) => {
                const on = !picking && t === chosen
                return (
                  <button
                    key={t}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    tabIndex={rovingTabIndex(i, timeItems)}
                    onClick={() => {
                      setPicking(false)
                      setTime(t)
                    }}
                    className={`flex min-h-12 items-center rounded-xl border px-4 text-left text-[14.5px] font-semibold transition-colors ${
                      on ? 'border-accent bg-accent text-accent-ink' : 'border-line-strong bg-surface text-ink hover:border-ink-3'
                    }`}
                  >
                    {formatDual(t, cand.timezone)}
                  </button>
                )
              })}
              <button
                type="button"
                role="radio"
                aria-checked={picking}
                tabIndex={rovingTabIndex(proposals.length, timeItems)}
                onClick={() => setPicking(true)}
                className={`flex min-h-12 items-center rounded-xl border px-4 text-left text-[14.5px] font-semibold transition-colors ${
                  picking ? 'border-accent bg-accent-soft text-accent-soft-ink' : 'border-line-strong bg-surface text-ink hover:border-ink-3'
                }`}
              >
                Pick another day and time
              </button>
            </div>
            {picking && (
              <div className="mt-2 flex flex-col gap-3 rounded-xl bg-surface-2 p-3">
                <DateChips label="Interview date" value={pickDate} onChange={setPickDate} min={date} weekdaysOnly />
                <ChipGroup
                  size="sm"
                  label="Time (Pacific)"
                  value={String(pickIdx)}
                  onChange={(v) => setPickIdx(Number(v))}
                  options={pickTimes().map((t, i) => ({ value: String(i), label: `${t.label} PT` }))}
                />
                <p className="num text-[13.5px] font-semibold text-ink">{formatDual(startsAt, cand.timezone)}</p>
              </div>
            )}
            <div aria-live="polite">
              {warnings.length > 0 && (
                <Callout tone="warn" title={warnings.length === 1 ? 'This time clashes' : `This time clashes in ${warnings.length} ways`} className="mt-2">
                  <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-5">
                    {warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                  <span className="mt-1 block">Pick another time or change the panel, or schedule it anyway.</span>
                </Callout>
              )}
            </div>
          </fieldset>
        )}
        <Field label="Length">
          {() => (
            <ChipGroup
              size="sm"
              label="Length in minutes"
              value={String(duration)}
              onChange={(v) => setDuration(Number(v))}
              options={durationChoices(step?.durationMin).map((m) => ({ value: String(m), label: `${m} min` }))}
            />
          )}
        </Field>
        <Field
          label="Panel"
          hint={
            panel.length
              ? `Scorecards are created for ${listJoin(panel.map((id) => personNameById(db, id)))}, due ${db.settings.scorecardDueHours} hours after the interview${logging ? ' (or from now, for a call logged late)' : ''}.`
              : panelError
                ? undefined
                : 'Pick at least one interviewer.'
          }
        >
          {() => (
            <div className="flex flex-col gap-2">
              <InvalidChips id="sch-panel" error={panelError}>
                <ChipMulti
                  label="Interviewers"
                  values={panel}
                  onChange={setPanel}
                  options={suggestedIds.map((id) => ({ value: id, label: personNameById(db, id) }))}
                />
              </InvalidChips>
              {others.length > 0 && (
                <Select
                  aria-label="Add another interviewer"
                  placeholder="Add someone else"
                  value=""
                  onChange={(v) => v && setPanel((p) => [...new Set([...p, v])])}
                  options={others.map((p) => ({ value: p.id, label: `${fullName(p)}, ${p.title}` }))}
                />
              )}
            </div>
          )}
        </Field>
        <Field label="Format">
          {() => <ChipGroup size="sm" label="Format" value={format} onChange={setFormat} options={FORMAT_OPTIONS} />}
        </Field>
        {format === 'video' && !logging && (
          <div className="flex flex-col gap-2">
            <Field label="Video link" id="sch-video" hint="Goes in the confirmation message and the calendar files. Set a default room in Settings > Link-outs.">
              {(id, hint) => (
                <TextInput id={id} aria-describedby={hint} type="url" inputMode="url" placeholder="https://" maxLength={500} value={videoLink} onChange={(e) => setVideoLink(e.target.value)} />
              )}
            </Field>
            {!videoLink.trim() && (
              <Note icon="alert">Add a video link so the candidate can join. Without one, the message says you will send the link before the call.</Note>
            )}
          </div>
        )}
      </div>
    </Sheet>
  )
}

/**
 * Scheduling message and calendar files for an interview (after scheduling, or from the list). After a
 * reschedule (`replacedId`, the interview it replaced) the message says the interview moved, and the
 * old time's cancellation files sit next to the new invite.
 */
export function InviteSheet({
  interviewId,
  open,
  onClose,
  justScheduled,
  replacedId,
}: {
  interviewId: ID
  open: boolean
  onClose: () => void
  justScheduled?: boolean
  replacedId?: ID | undefined
}) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const [mode, setMode] = useState<'this' | 'three' | 'calendly'>('this')
  const interview = db.interviews.find((i) => i.id === interviewId)
  const app = interview ? db.applications.find((a) => a.id === interview.applicationId) : undefined
  const cand = app ? db.candidates.find((c) => c.id === app.candidateId) : undefined
  const replaced = replacedId ? db.interviews.find((i) => i.id === replacedId) : undefined
  const proposals = useMemo(
    () =>
      interview && cand
        ? proposeTimesFor(db, today(), 3, { panelIds: interview.interviewerIds, candidateTz: cand.timezone ?? null, durationMin: interview.durationMin, applicationId: interview.applicationId })
        : [],
    [db, interview, cand],
  )
  if (!open) return null
  if (!interview || !app || !cand) {
    return (
      <Sheet open onClose={onClose} title="Interview">
        <p className="text-[14px] text-ink-2">This interview is no longer on file.</p>
      </Sheet>
    )
  }
  const calendly = db.company.linkOuts.calendly
  const sender = viewer.personId ?? founder(db)?.id ?? ''
  const times = mode === 'three' ? proposals : []
  const hq = db.company.hq
  const confirm = (): DraftMessage => {
    const day = formatDual(interview.startsAt, cand.timezone).split(',').slice(0, 2).join(',')
    const subject = `${replaced ? 'Rescheduled' : 'Confirmed'}: ${interview.name} with ${db.company.name}, ${day}`
    const body = confirmationBody({
      firstName: cand.firstName,
      interviewName: interview.name,
      when: formatDual(interview.startsAt, cand.timezone),
      durationMin: interview.durationMin,
      format: interview.format,
      panel: interview.interviewerIds.map((id) => personNameById(db, id)),
      companyName: db.company.name,
      address: [hq.street, hq.suite, hq.city].filter(Boolean).join(', '),
      senderName: personNameById(db, sender, db.company.name),
      ...(interview.videoLink ? { videoLink: interview.videoLink } : {}),
      ...(replaced ? { movedFrom: formatDual(replaced.startsAt, cand.timezone) } : {}),
    })
    return { to: cand.email, subject, body, mailto: mailtoHref(cand.email, subject, body) }
  }
  const msg = mode === 'this' ? confirm() : schedulingMessage(db, app.id, times, { senderId: sender, stageId: interview.stageId, durationMin: interview.durationMin })
  const name = candidateName(db, app.candidateId)
  const fileStem = slug(`${interview.name} ${name}`)
  const panelNames = interview.interviewerIds.map((id) => personNameById(db, id))
  const ics = (aud: 'candidate' | 'panel') => interviewICS(db, interview.id, aud) ?? ''
  const cancelIcs = (aud: 'candidate' | 'panel') => (replaced ? (interviewCancelICS(db, replaced.id, aud) ?? '') : '')

  return (
    <Sheet
      open
      onClose={onClose}
      title={replaced ? `Rescheduled: ${interview.name}` : justScheduled ? `Scheduled: ${interview.name}` : `Invite: ${interview.name}`}
      subtitle={`${name}, ${formatDual(interview.startsAt, cand.timezone)}, ${interview.durationMin} min`}
      footer={
        <Button variant="primary" size="lg" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-6">
        {replaced ? (
          <Note icon="check">
            Moved from {formatDual(replaced.startsAt, cand.timezone)}. Owed scorecards for {listJoin(panelNames)} are now due {db.settings.scorecardDueHours} hours after the new time.
          </Note>
        ) : (
          justScheduled && (
            <Note icon="check">
              Owed scorecards created for {listJoin(panelNames)}, due {db.settings.scorecardDueHours} hours after the interview ends.
            </Note>
          )
        )}
        <section aria-labelledby="inv-msg" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="inv-msg" className="text-[15px] font-bold text-ink">
              Message to {cand.firstName}
            </h3>
            <Segmented
              size="sm"
              label="Times in the message"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'this', label: replaced ? 'New time' : 'Confirm this time' },
                { value: 'three', label: 'Offer 3 times' },
                ...(calendly ? [{ value: 'calendly' as const, label: 'Calendly link' }] : []),
              ]}
            />
          </div>
          <MessageDraft msg={msg} senderId={sender} label="Scheduling message" what="the scheduling message" />
        </section>
        <section aria-labelledby="inv-ics" className="flex flex-col gap-3">
          <h3 id="inv-ics" className="text-[15px] font-bold text-ink">
            Calendar files
          </h3>
          <p className="text-[13.5px] text-ink-3">The candidate&apos;s copy lists who they will meet. The panel&apos;s copy names the candidate and the scorecard attributes.</p>
          <IcsFileButtons stem={fileStem} firstName={cand.firstName} candidate={() => ics('candidate')} panel={() => ics('panel')} />
          {replaced && (
            <>
              <p className="mt-2 text-[13.5px] text-ink-3">
                The old time is a separate calendar event. These cancellations take it off the calendars of anyone who added it.
              </p>
              <IcsFileButtons stem={slug(`${replaced.name} ${name}`)} firstName={cand.firstName} candidate={() => cancelIcs('candidate')} panel={() => cancelIcs('panel')} cancel />
            </>
          )}
        </section>
      </div>
    </Sheet>
  )
}

/**
 * A ready message to the candidate: who it goes to, the subject, a preview, Copy and Open in mail app.
 * When the sender has no work email on file (Start fresh never guesses one), it asks for it first, since
 * replies would go nowhere.
 */
function MessageDraft({ msg, senderId, label, what }: { msg: DraftMessage | null; senderId: ID; label: string; what: string }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const senderMissingEmail = !db.people.find((p) => p.id === senderId)?.workEmail?.trim()
  const emailHint = missingWorkEmailHint(viewer, senderId, personNameById(db, senderId, 'the sender'))
  return (
    <>
      {senderMissingEmail && (
        <Note icon="alert">
          {emailHint.text}
          {emailHint.link && (
            <>
              {' '}
              <a href={emailHint.link.href} className="-my-2 inline-flex min-h-10 items-center font-semibold text-accent underline">
                {emailHint.link.label}
              </a>
            </>
          )}
        </Note>
      )}
      {msg ? (
        <>
          <p className="text-[13.5px] text-ink-2">
            To <span className="font-semibold text-ink">{msg.to}</span>. Subject: <span className="font-semibold text-ink">{msg.subject}</span>
          </p>
          <TextPreview text={msg.body} label={label} />
          <div className="flex flex-wrap gap-2">
            <Button icon="copy" onClick={() => void copyWithToast(`Subject: ${msg.subject}\n\n${msg.body}`, what)}>
              Copy message
            </Button>
            <a
              href={msg.mailto}
              className="ft-btn ft-btn--secondary ft-btn--md inline-flex h-11 items-center gap-2 rounded-lg border border-line-strong bg-surface px-4 text-[14.5px] font-semibold text-ink hover:bg-surface-2"
            >
              Open in mail app
            </a>
          </div>
        </>
      ) : (
        <p className="text-[13.5px] text-ink-3">The message could not be built for this candidate.</p>
      )}
    </>
  )
}

/**
 * Right after an interview is cancelled (and later from its menu): the note to tell the candidate, who
 * already has a confirmation and maybe the invite on their calendar, and the cancellation calendar files
 * for them and the panel. Schedule a new time opens the schedule sheet. If the cancel was undone, it
 * says the interview is back on instead. With `heldInterviewId` the call was held early and logged in
 * the booked time's place: the sheet and the note say so and promise no new time.
 */
export function CancelSheet({
  interviewId,
  onClose,
  onScheduleNew,
  heldInterviewId,
}: {
  interviewId: ID
  onClose: () => void
  onScheduleNew?: (() => void) | undefined
  heldInterviewId?: ID | undefined
}) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const interview = db.interviews.find((i) => i.id === interviewId)
  const held = heldInterviewId ? db.interviews.find((i) => i.id === heldInterviewId && i.status === 'completed') : undefined
  const app = interview ? db.applications.find((a) => a.id === interview.applicationId) : undefined
  const cand = app ? db.candidates.find((c) => c.id === app.candidateId) : undefined
  if (!interview || !app || !cand) {
    return (
      <Sheet open onClose={onClose} title="Interview">
        <p className="text-[14px] text-ink-2">This interview is no longer on file.</p>
      </Sheet>
    )
  }
  const name = candidateName(db, app.candidateId)
  const when = formatDual(interview.startsAt, cand.timezone)
  const off = interview.status === 'cancelled'
  const sender = viewer.personId ?? founder(db)?.id ?? ''
  const msg = off ? interviewCancelMessage(db, interview.id, { senderId: sender, ...(held ? { heldAt: held.startsAt } : {}) }) : null
  const ics = (aud: 'candidate' | 'panel') => interviewCancelICS(db, interview.id, aud) ?? ''
  const step = app.status === 'active' ? app.nextStep : undefined
  return (
    <Sheet
      open
      onClose={onClose}
      title={off ? (held ? `Logged as held: ${interview.name}` : `Cancelled: ${interview.name}`) : interview.name}
      subtitle={held && off ? `${name}, held ${formatDual(held.startsAt, cand.timezone)} instead of ${when}` : `${name}, ${off ? 'was ' : ''}${when}`}
      footer={
        <>
          {off && !held && onScheduleNew && app.status === 'active' && (
            <Button icon="calendar" onClick={onScheduleNew}>
              Schedule a new time
            </Button>
          )}
          <Button variant="primary" size="lg" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      {off ? (
        <div className="flex flex-col gap-6">
          <Note icon="check">
            {held
              ? `The ${when} time is off the calendar; the interview is logged as held, with its scorecards owed.`
              : 'Off the calendar, with its owed scorecards.'}
            {step ? ` Next step: ${step.text}, due ${fmtDayPlain(step.dueOn)}.` : ''}
          </Note>
          <section aria-labelledby="cxl-msg" className="flex flex-col gap-3">
            <h3 id="cxl-msg" className="text-[15px] font-bold text-ink">
              Tell {cand.firstName}
            </h3>
            <p className="text-[13.5px] text-ink-3">
              {held ? `${cand.firstName} still has the invite for ${when}.` : `${cand.firstName} may already have the confirmation and the invite.`} Nothing is sent from here.
            </p>
            <MessageDraft msg={msg} senderId={sender} label="Cancellation note" what="the cancellation note" />
          </section>
          <section aria-labelledby="cxl-ics" className="flex flex-col gap-3">
            <h3 id="cxl-ics" className="text-[15px] font-bold text-ink">
              Calendar files
            </h3>
            <p className="text-[13.5px] text-ink-3">Opening one takes the invite off the calendar of anyone who added it.</p>
            <IcsFileButtons stem={slug(`${interview.name} ${name}`)} firstName={cand.firstName} candidate={() => ics('candidate')} panel={() => ics('panel')} cancel />
          </section>
        </div>
      ) : (
        <Note icon="info">This interview is back on the calendar, so there is nothing to tell {cand.firstName}.</Note>
      )}
    </Sheet>
  )
}
