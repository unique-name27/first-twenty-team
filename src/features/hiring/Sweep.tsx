// Sweep mode: one candidate at a time with big Advance (A), Reject (R), Snooze 3 days (S) and Skip (J)
// buttons, built to take under 10 seconds per candidate. Ends with a summary line
// ('9 touched: 2 advanced, 4 closed with notes, 3 snoozed').
import { useState } from 'react'
import { links, navigate, navigateTo } from '@/app/router'
import { useShortcut } from '@/app/shortcuts'
import { useViewer } from '@/app/useViewer'
import { attentionReasonLabel, attentionReasons, dbHolidays, nextStage, openOffer, slaDetail, stageById } from '@/domain/hiring'
import { personNameById } from '@/domain/people'
import type { ID, Job } from '@/domain/types'
import { fmtDay, fmtRelative, today } from '@/lib/dates'
import { plural } from '@/lib/format'
import { useDB } from '@/store/db'
import { Badge, Button, Callout, DescriptionList, EmptyState, IconButton, Meter, Panel } from '@/ui'
import { advance, snooze3 } from './actions'
import { ScheduleSheet } from './interviews/ScheduleSheet'
import { daysWaiting, emptySweepCounts, lastActivityFor, scorecardSummary, scorecardSummaryText, stepToSchedule, type SweepCounts, sweepQueue, sweepSummaryText } from './logic'
import { KeyHint, SlaPill, SourceChip } from './parts'
import { RejectFlow } from './RejectFlow'

export function Sweep({ job }: { job: Job }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const t = today()
  const [mode, setMode] = useState<'attention' | 'all'>('attention')
  // The queue is fixed when the sweep starts so candidates do not jump around as they change.
  const [queue, setQueue] = useState<ID[]>(() => sweepQueue(db, job, t, 'attention'))
  const [index, setIndex] = useState(0)
  const [counts, setCounts] = useState<SweepCounts>(emptySweepCounts)
  const [rejecting, setRejecting] = useState<ID | null>(null)
  /** The last candidate advanced into a stage with an interview step to book (offered above the card). */
  const [toBook, setToBook] = useState<ID | null>(null)
  const [scheduling, setScheduling] = useState<ID | null>(null)

  const appId = queue[index]
  const app = appId ? db.applications.find((a) => a.id === appId) : undefined
  const done = index >= queue.length
  const live = !!app && app.status === 'active' && !done

  const next = (key?: keyof SweepCounts) => {
    if (key) setCounts((c) => ({ ...c, [key]: c[key] + 1 }))
    setIndex((i) => i + 1)
  }

  const doAdvance = () => {
    if (!app || !live) return
    const outcome = advance(app.id, viewer.personId)
    if (outcome === 'moved') {
      const now = useDB.getState().db
      const moved = now.applications.find((a) => a.id === app.id)
      setToBook(moved && stepToSchedule(now, moved) ? app.id : null)
      next('advanced')
    }
    if (outcome === 'needs_hire') navigateTo(links.candidateOffer(app.candidateId, app.id))
  }
  const doSnooze = () => {
    if (!app || !live) return
    if (snooze3(app.id)) next('snoozed')
  }
  const doSkip = () => !done && next('skipped')
  const doReject = () => app && live && setRejecting(app.id)

  const on = { group: 'Pipeline', enabled: !done }
  useShortcut('a', doAdvance, { ...on, description: 'Sweep: advance' })
  useShortcut('r', doReject, { ...on, description: 'Sweep: reject' })
  useShortcut('s', doSnooze, { ...on, description: 'Sweep: snooze 3 days' })
  useShortcut('j', doSkip, { ...on, description: 'Sweep: skip' })

  const restart = (m: 'attention' | 'all') => {
    setMode(m)
    setQueue(sweepQueue(useDB.getState().db, job, today(), m))
    setIndex(0)
    setCounts(emptySweepCounts())
  }

  if (queue.length === 0) {
    const all = sweepQueue(db, job, t, 'all').length
    return (
      <Panel>
        <EmptyState
          icon="check"
          title={mode === 'attention' ? 'Nobody is waiting on you' : 'No active candidates'}
          body={mode === 'attention' ? 'Every active candidate has a next step, is inside the stage SLA and has heard from you recently.' : 'Add candidates to sweep them.'}
          action={
            mode === 'attention' && all > 0 ? (
              <Button onClick={() => restart('all')}>Sweep all {plural(all, 'active candidate')}</Button>
            ) : (
              <Button onClick={() => navigate('job', job.id)}>Back to the pipeline</Button>
            )
          }
        />
      </Panel>
    )
  }

  const bookPrompt = toBook ? <BookPrompt appId={toBook} onSchedule={() => setScheduling(toBook)} onDismiss={() => setToBook(null)} /> : null
  const scheduleSheet = scheduling ? <ScheduleSheet applicationId={scheduling} open onClose={() => setScheduling(null)} /> : null

  if (done) {
    return (
      <div className="flex flex-col gap-4">
        {bookPrompt}
        <Panel title="Sweep done" icon="check">
          <p className="font-display text-[22px] font-bold text-ink" role="status">
            {sweepSummaryText(counts)}
          </p>
          <p className="mt-2 text-[14px] text-ink-2">Anyone still without a next step or past the SLA comes back next session.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => navigate('job', job.id)}>
              Back to the pipeline
            </Button>
            <Button onClick={() => restart(mode)}>Sweep again</Button>
          </div>
        </Panel>
        {scheduleSheet}
      </div>
    )
  }

  const cand = app && db.candidates.find((c) => c.id === app.candidateId)
  const name = cand ? `${cand.firstName} ${cand.lastName}` : 'Candidate'
  const stage = app ? stageById(job, app.stageId) : undefined
  const holidays = dbHolidays(db)
  const sla = app ? slaDetail(job, app, t, holidays, openOffer(db, app.id)) : null
  // The SLA pill already says 'past SLA'; list only the other reasons.
  const reasons = app ? attentionReasons(db, app, t).filter((r) => r !== 'past_sla') : []
  const last = app ? lastActivityFor(db, app) : null
  const cards = app ? scorecardSummary(db, viewer, app) : null
  const to = app ? nextStage(job, app.stageId) : undefined

  const actions = (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Button variant="primary" size="lg" icon="arrow-right" onClick={doAdvance} disabled={!live} aria-keyshortcuts="A" className="h-14 px-3">
          {stage?.kind === 'offer' ? (app?.conditionalOfferOn ? 'Hire' : 'Open offer') : 'Advance'}
          <KeyHint k="A" />
        </Button>
        <Button size="lg" icon="x" onClick={doReject} disabled={!live} aria-keyshortcuts="R" className="h-14 px-3">
          Reject
          <KeyHint k="R" />
        </Button>
        <Button size="lg" icon="clock" onClick={doSnooze} disabled={!live} aria-keyshortcuts="S" className="h-14 px-3">
          Snooze 3 days
          <KeyHint k="S" />
        </Button>
        <Button size="lg" variant="ghost" icon="chevron-right" onClick={doSkip} aria-keyshortcuts="J" className="h-14 px-3">
          Skip
          <KeyHint k="J" />
        </Button>
      </div>
      {to && live && stage?.kind !== 'offer' && <p className="text-[13px] text-ink-3">Advance moves {cand?.firstName ?? 'them'} to {to.name}.</p>}
    </>
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[14px] font-semibold text-ink-2">
          {index + 1} of {queue.length}
        </span>
        <Meter value={index} max={queue.length} label="Sweep progress" className="max-w-[240px] flex-1" />
        <span className="text-[13px] text-ink-3">{mode === 'attention' ? 'Candidates who need attention' : 'All active candidates'}</span>
      </div>
      {bookPrompt}

      <Panel>
        {!app || !live ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-[15px] text-ink-2">{name} is no longer active on this job.</p>
            <Button onClick={() => next()}>Next candidate</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <a href={links.candidate(app.candidateId)} className="font-display text-[26px] leading-tight font-bold text-ink hover:text-accent">
                  {name}
                </a>
                {(cand?.currentTitle || cand?.currentCompany) && <p className="text-[14.5px] text-ink-2">{[cand?.currentTitle, cand?.currentCompany].filter(Boolean).join(' at ')}</p>}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {cand && <SourceChip candidate={cand} detail />}
                  {sla && <SlaPill detail={sla} />}
                  {reasons.map((r) => (
                    <Badge key={r} tone="warn">
                      {attentionReasonLabel(r)}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>
            {actions}
            <DescriptionList
              items={[
                { label: 'Job', value: job.title },
                { label: 'Stage', value: stage?.name ?? app.stageId },
                { label: 'Days waiting', value: `${plural(daysWaiting(db, app, t), 'business day')} since they last heard from us` },
                { label: 'Last activity', value: last ? `${last.text} (${fmtRelative(last.at)})` : 'None logged' },
                {
                  label: 'Next step',
                  value: app.nextStep ? `${app.nextStep.text}, due ${fmtDay(app.nextStep.dueOn)} (${personNameById(db, app.nextStep.ownerId)})` : 'None',
                },
                { label: 'Scorecards', value: cards ? scorecardSummaryText(cards) : 'None' },
              ]}
            />
            {stage?.kind === 'offer' && (
              <Callout tone="neutral">Advancing from Offer means hiring. That happens from the accepted offer on the profile.</Callout>
            )}
          </div>
        )}
      </Panel>


      <RejectFlow
        appId={rejecting}
        mode="reject"
        onClose={(r) => {
          setRejecting(null)
          if (r.closed) next(r.notified ? 'closedNotified' : 'closed')
        }}
      />
      {scheduleSheet}
    </div>
  )
}

/** After Advance lands someone in a stage with an interview step: book it now (message plus .ics). */
function BookPrompt({ appId, onSchedule, onDismiss }: { appId: ID; onSchedule: () => void; onDismiss: () => void }) {
  const db = useDB((s) => s.db)
  const app = db.applications.find((a) => a.id === appId)
  const job = app && db.jobs.find((j) => j.id === app.jobId)
  const step = app ? stepToSchedule(db, app) : undefined
  if (!app || !job || !step) return null
  const cand = db.candidates.find((c) => c.id === app.candidateId)
  const who = cand ? `${cand.firstName} ${cand.lastName}` : 'They'
  return (
    <Callout
      tone="accent"
      icon="calendar"
      title={`${who} is in ${stageById(job, app.stageId)?.name ?? 'the next stage'}. Schedule next: ${step.name}`}
      action={
        <span className="flex items-center gap-1">
          <Button variant="primary" icon="calendar" onClick={onSchedule}>
            Schedule
          </Button>
          <IconButton icon="x" label="Not now" onClick={onDismiss} />
        </span>
      }
    >
      Copy a scheduling message with times in Pacific and their time zone, then download the .ics.
    </Callout>
  )
}
