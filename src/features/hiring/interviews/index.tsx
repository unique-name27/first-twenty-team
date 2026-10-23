// Interviews, scheduling and scorecards (owned by the hiring-process builder).
// Exports keep the names and props the hiring core imports.
import { useState } from 'react'
import { links } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { canManageJob, canSeeApplication, canSeePipeline, canSeeSection } from '@/domain/access'
import { stageById } from '@/domain/hiring/pipeline'
import { cancelInterview, formatDual, setInterviewStatus, zoneLabel } from '@/domain/hiring/scheduling'
import { interviewEndsAt, scorecardsOwed } from '@/domain/hiring/scorecards'
import { candidateName, lowerFirst } from '@/domain/hiring/util'
import { personNameById } from '@/domain/people'
import type { ID, Interview } from '@/domain/types'
import { fmtDateTime, nowISO, today } from '@/lib/dates'
import { plural } from '@/lib/format'
import { useDB } from '@/store/db'
import { AvatarStack, Badge, Button, EmptyState, IconButton, Menu, type MenuItem, type Tone } from '@/ui'
import { act, SubPanel } from './common'
import { DebriefGrid } from './Debrief'
import { interviewsEmptyText } from './logic'
import { CancelSheet, InviteSheet, ScheduleSheet, type ScheduleMode } from './ScheduleSheet'
import { ScorecardSheet } from './ScorecardSheet'

export { HiringPulse, OpenRolesList } from './pulse'
export { InterviewKitsTab } from './kits'
export { HiringMetricsPanel } from './metrics'
export { ScorecardSheet } from './ScorecardSheet'

const STATUS: Record<Interview['status'], { label: string; tone: Tone }> = {
  scheduled: { label: 'Scheduled', tone: 'accent' },
  completed: { label: 'Completed', tone: 'good' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  no_show: { label: 'No show', tone: 'warn' },
}

const FORMAT_LABEL: Record<Interview['format'], string> = { video: 'Video', onsite: 'On site', phone: 'Phone' }

/**
 * Candidate profile block: interviews (schedule, reschedule, .ics, message), scorecards and debrief.
 * Cancelling one opens the note and cancellation files for telling the candidate.
 */
export function CandidateInterviews({ applicationId }: { applicationId: ID }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const [scheduling, setScheduling] = useState<ScheduleMode | null>(null)
  const [rescheduling, setRescheduling] = useState<ID | null>(null)
  const [inviteFor, setInviteFor] = useState<ID | null>(null)
  const [cancelledFor, setCancelledFor] = useState<ID | null>(null)
  const [filling, setFilling] = useState<ID | null>(null)
  const app = db.applications.find((a) => a.id === applicationId)
  const job = app ? db.jobs.find((j) => j.id === app.jobId) : undefined
  const cand = app ? db.candidates.find((c) => c.id === app.candidateId) : undefined
  if (!app || !job || !cand || !canSeeApplication(viewer, db, app)) return null

  const manage = canManageJob(viewer, job)
  const full = canSeePipeline(viewer, job)
  const now = nowISO()
  const all = db.interviews
    .filter((i) => i.applicationId === app.id)
    .filter((i) => full || (!!viewer.personId && i.interviewerIds.includes(viewer.personId)))
    .sort((a, b) => {
      const ca = a.status === 'cancelled' ? 1 : 0
      const cb = b.status === 'cancelled' ? 1 : 0
      return ca - cb || a.startsAt.localeCompare(b.startsAt)
    })
  const canSchedule = manage && app.status === 'active'
  const name = `${cand.firstName} ${cand.lastName}`

  return (
    <SubPanel
      title="Interviews and scorecards"
      subtitle={
        all.length
          ? `${plural(all.filter((i) => i.status !== 'cancelled').length, 'interview')}. Times in Pacific${cand.timezone && zoneLabel(cand.timezone, all[0].startsAt) !== 'PT' ? `, with ${cand.firstName}'s time in brackets` : ''}.`
          : undefined
      }
      icon="calendar"
      actions={
        canSchedule ? (
          <>
            <Button variant="ghost" icon="check" onClick={() => setScheduling('log')}>
              Log past interview
            </Button>
            <Button variant={all.length ? 'secondary' : 'primary'} icon="plus" onClick={() => setScheduling('schedule')}>
              Schedule interview
            </Button>
          </>
        ) : undefined
      }
    >
      {all.length === 0 ? (
        <EmptyState
          compact
          icon="calendar"
          title={app.status === 'active' ? 'No interviews yet' : 'No interviews'}
          body={
            canSchedule
              ? 'Schedule one to send times to the candidate and create owed scorecards. Already talked? Log past interview records it and opens your scorecard.'
              : interviewsEmptyText({ seesAll: full, active: app.status === 'active' })
          }
        />
      ) : (
        <ul className="-my-1 divide-y divide-line">
          {all.map((i) => {
            const cards = db.scorecards.filter((s) => s.interviewId === i.id)
            const inCount = cards.filter((s) => s.submittedAt).length
            const started = i.startsAt <= now
            const myCard = cards.find((s) => s.interviewerId === viewer.personId && !s.submittedAt)
            const ended = interviewEndsAt(i) <= now
            const stage = stageById(job, i.stageId)
            const st = STATUS[i.status]
            const missing = cards.filter((s) => !s.submittedAt)
            const items: MenuItem[] = []
            if (manage && i.status !== 'cancelled') items.push({ label: 'Message and calendar files', icon: 'mail', onSelect: () => setInviteFor(i.id) })
            if (manage && i.status === 'cancelled') items.push({ label: 'Cancellation note and calendar files', icon: 'mail', onSelect: () => setCancelledFor(i.id) })
            if (canSchedule && i.status === 'scheduled') items.push({ label: 'Reschedule', icon: 'calendar', onSelect: () => setRescheduling(i.id) })
            if (manage && i.status === 'scheduled' && started) {
              items.push({ label: 'Mark completed', icon: 'check', onSelect: () => act(`Marked the ${lowerFirst(i.name)} with ${name} completed`, (d) => setInterviewStatus(d, i.id, 'completed', { date: today() })) })
              items.push({ label: 'Mark as no-show', icon: 'alert', onSelect: () => act(`Marked ${name} as a no-show for the ${lowerFirst(i.name)}`, (d) => setInterviewStatus(d, i.id, 'no_show', { date: today() })) })
            }
            if (manage && i.status === 'scheduled') {
              items.push({
                label: 'Cancel interview',
                icon: 'x',
                danger: true,
                onSelect: () => {
                  // Then prompt to tell the candidate, who already has the confirmation and maybe the invite.
                  if (act(`Cancelled the ${lowerFirst(i.name)} with ${name}`, (d) => cancelInterview(d, i.id, { date: today() }))) setCancelledFor(i.id)
                },
              })
            }
            if (viewer.role === 'admin' && started && i.status !== 'cancelled' && i.status !== 'no_show') {
              const others = missing.filter((s) => s.interviewerId !== viewer.personId)
              if (others.length && items.length) items.push({ divider: true })
              for (const s of others) items.push({ label: `Enter scorecard for ${personNameById(db, s.interviewerId)}`, icon: 'edit', onSelect: () => setFilling(s.id) })
            }
            return (
              <li key={i.id} className={i.status === 'cancelled' ? 'py-3 opacity-70' : 'py-3'}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[15px] font-bold text-ink">{i.name}</span>
                      <Badge tone={st.tone}>{st.label}</Badge>
                      {stage && <span className="text-[12.5px] text-ink-3">{stage.name}</span>}
                    </div>
                    <p className="num mt-0.5 text-[14px] text-ink-2">
                      {formatDual(i.startsAt, cand.timezone)}, {i.durationMin} min, {FORMAT_LABEL[i.format].toLowerCase()}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px] text-ink-3">
                      <AvatarStack names={i.interviewerIds.map((id) => personNameById(db, id))} size={24} />
                      <span className="min-w-0">{i.interviewerIds.map((id) => personNameById(db, id)).join(', ')}</span>
                      {cards.length > 0 && i.status !== 'cancelled' && i.status !== 'no_show' && (
                        <Badge tone={inCount === cards.length ? 'good' : ended ? 'warn' : 'outline'}>
                          {inCount} of {cards.length} scorecards
                        </Badge>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {myCard && started && i.status !== 'cancelled' && i.status !== 'no_show' && (
                      <Button variant="primary" icon="edit" onClick={() => setFilling(myCard.id)}>
                        Fill scorecard
                      </Button>
                    )}
                    {items.length > 0 && (
                      <Menu
                        label={`Actions for ${i.name}`}
                        items={items}
                        trigger={(p) => <IconButton icon="more" label={`More actions for ${i.name}`} variant="ghost" {...p} />}
                      />
                    )}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <div className="mt-4">
        <DebriefGrid applicationId={app.id} onFill={setFilling} />
      </div>
      <ScheduleSheet key={scheduling ?? 'closed'} applicationId={app.id} open={!!scheduling} mode={scheduling ?? 'schedule'} onClose={() => setScheduling(null)} />
      {rescheduling && <ScheduleSheet key={`re-${rescheduling}`} applicationId={app.id} open rescheduleId={rescheduling} onClose={() => setRescheduling(null)} />}
      {inviteFor && <InviteSheet interviewId={inviteFor} open onClose={() => setInviteFor(null)} />}
      {cancelledFor && (
        <CancelSheet
          interviewId={cancelledFor}
          onClose={() => setCancelledFor(null)}
          onScheduleNew={
            canSchedule
              ? () => {
                  setCancelledFor(null)
                  setScheduling('schedule')
                }
              : undefined
          }
        />
      )}
      <ScorecardSheet scorecardId={filling} open={!!filling} onClose={() => setFilling(null)} />
    </SubPanel>
  )
}

/** Scorecards a person owes, each with Fill (Home, Me). */
export function ScorecardsOwedList({ personId }: { personId: ID }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const [filling, setFilling] = useState<ID | null>(null)
  const owed = scorecardsOwed(db, personId, nowISO())
  const canFill = viewer.personId === personId || viewer.role === 'admin'
  if (owed.length === 0) {
    return <EmptyState compact icon="clipboard-check" title="No scorecards owed" body="Scorecards show up here after each interview, due 24 hours later." />
  }
  return (
    <>
      <ul className="divide-y divide-line">
        {owed.map(({ scorecard, interview, overdue }) => {
          const app = db.applications.find((a) => a.id === scorecard.applicationId)
          const job = app ? db.jobs.find((j) => j.id === app.jobId) : undefined
          const cand = app ? db.candidates.find((c) => c.id === app.candidateId) : undefined
          const name = app ? candidateName(db, app.candidateId) : 'Candidate'
          return (
            <li key={scorecard.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {cand && canSeeSection(viewer, 'hiring') ? (
                    <a href={links.candidate(cand.id)} className="-my-2 inline-flex min-h-10 items-center text-[15px] font-bold text-ink hover:text-accent">
                      {name}
                    </a>
                  ) : (
                    <span className="text-[15px] font-bold text-ink">{name}</span>
                  )}
                  <Badge tone={overdue ? 'warn' : 'neutral'} icon={overdue ? 'clock' : undefined}>
                    {overdue ? 'Overdue' : 'Due'} {fmtDateTime(scorecard.dueAt)}
                  </Badge>
                </div>
                <p className="mt-0.5 text-[13.5px] text-ink-2">
                  {job ? `${job.title}: ` : ''}
                  {interview.name}, {formatDual(interview.startsAt, cand?.timezone)}
                </p>
              </div>
              {canFill && (
                <Button variant="primary" size="lg" icon="edit" onClick={() => setFilling(scorecard.id)} aria-label={`Fill scorecard for ${name}`}>
                  Fill
                </Button>
              )}
            </li>
          )
        })}
      </ul>
      <ScorecardSheet scorecardId={filling} open={!!filling} onClose={() => setFilling(null)} />
    </>
  )
}
