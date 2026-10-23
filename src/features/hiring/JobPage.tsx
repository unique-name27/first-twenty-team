// Job page (#job.<id>[.board|.list|.sweep|.edit|.posting]): status, hiring manager, pay range, days
// open, the back-scheduling line and actions; then the pipeline (board or list), Sweep mode, the
// talent pool and bulk close-out once the job fills. Panel-only viewers see just their interviews.
import { useMemo, useState } from 'react'
import type { PageProps } from '@/app/routes'
import { links, navigate, replaceRoute } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { canManageJob, canSeePipeline, visibleJobs } from '@/domain/access'
import { addApplication, approveRequisition, backScheduleLine, closeOutMessage, declineRequisition, formatDual, isPendingRequisition, markPosted, setJobStatus } from '@/domain/hiring'
import { slotBudgetBase } from '@/domain/pay'
import { personNameById } from '@/domain/people'
import type { Job } from '@/domain/types'
import { fmtDate, fmtQuarter, nowISO, today } from '@/lib/dates'
import { plural } from '@/lib/format'
import { useDB } from '@/store/db'
import { Avatar, Badge, Button, Callout, EmptyState, Icon, Menu, type MenuItem, Money, MoneyRange, PageHeader, Panel, Tabs, toast } from '@/ui'
import { commit } from './actions'
import { CloseOutSheet } from './CloseOutSheet'
import { JobEditSheet } from './JobEditSheet'
import { jobAgeText, sweepQueue, talentPool } from './logic'
import { JobStatusBadge, RequestBadge, SourceChip, useNarrow, WRAP_BUTTON } from './parts'
import { Pipeline } from './Pipeline'
import { PostingSheet } from './PostingSheet'
import { QuickAddSheet } from './QuickAddSheet'
import { Sweep } from './Sweep'

type View = 'board' | 'list' | 'sweep'

export function JobPage({ route }: PageProps) {
  const id = route.segments[1]
  const sub = route.segments[2]
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const narrow = useNarrow()
  const [adding, setAdding] = useState(false)
  const [closingOut, setClosingOut] = useState(false)
  const job = db.jobs.find((j) => j.id === id)
  const visible = useMemo(() => !!job && visibleJobs(viewer, db).some((j) => j.id === job.id), [viewer, db, job])

  if (!job) {
    return <EmptyState icon="search" title="That job does not exist" body="It may have been removed in an undo or a data import." action={<a className="font-bold text-accent underline" href={links.hiring('jobs')}>Go to jobs</a>} />
  }
  if (!visible) {
    return (
      <EmptyState
        icon="lock"
        title="Not part of this view"
        body="This job is visible to its hiring manager, its interview panel and admins. Viewing as is a preview, not security."
        action={<a className="font-bold text-accent underline" href={links.hiring('jobs')}>Go to jobs</a>}
      />
    )
  }

  const full = canSeePipeline(viewer, job)
  const manage = canManageJob(viewer, job)
  const view: View = sub === 'board' || sub === 'list' || sub === 'sweep' ? sub : narrow ? 'list' : 'board'
  const t = today()
  const back = backScheduleLine(db, job, t)
  // Drafts were never posted, so they are 'Draft since <date>', never 'N days open'.
  const age = jobAgeText(job, t, fmtDate)
  const slot = db.plan.find((s) => (job.planSlotId && s.id === job.planSlotId) || s.jobId === job.id)
  const isAdmin = viewer.role === 'admin'
  const budget = slot && isAdmin ? slotBudgetBase(db, slot).base : null
  const attention = full ? sweepQueue(db, job, t).length : 0
  const active = db.applications.filter((a) => a.jobId === job.id && a.status === 'active')
  const closeOut = closeOutMessage(db, job.id)
  const needsCloseOut = full && (job.status === 'filled' || job.status === 'closed') && !!closeOut && closeOut.applicationIds.length > 0
  // Non-admins only see candidates they can already see (keep-warm tags on other managers' jobs stay private).
  const pool = full && manage && (job.status === 'open' || job.status === 'draft') ? talentPool(db, job, viewer) : []

  const statusItems: MenuItem[] = []
  const post = () => {
    const failed: { reason?: string } = {}
    commit(job.status === 'on_hold' ? `Resumed the ${job.title} job` : `Posted the ${job.title} job`, (d) => {
      const r = markPosted(d, job.id, { date: t })
      if (!r.ok) failed.reason = r.reason
      return r.ok
    })
    if (failed.reason) toast({ text: failed.reason, tone: 'bad' })
  }
  const status = (s: Job['status'], label: string) => commit(label, (d) => setJobStatus(d, job.id, s, { date: t }))
  const pendingRequest = isPendingRequisition(job) ? job.requisition : undefined
  const decide = (approve: boolean) => {
    const failed: { reason?: string } = {}
    const label = approve ? `Approved the ${job.title} job request` : `Declined the ${job.title} job request`
    commit(label, (d) => {
      const r = (approve ? approveRequisition : declineRequisition)(d, job.id, { approverId: viewer.personId, date: t })
      if (!r.ok) failed.reason = r.reason
      return r.ok
    })
    if (failed.reason) toast({ text: failed.reason, tone: 'bad' })
  }
  if (manage) {
    if (job.status === 'draft' && !pendingRequest) statusItems.push({ label: 'Mark posted', icon: 'send', onSelect: post })
    if (job.status === 'on_hold') statusItems.push({ label: 'Resume posting', icon: 'send', onSelect: post })
    if (job.status === 'open') statusItems.push({ label: 'Pause (on hold)', icon: 'clock', onSelect: () => status('on_hold', `Put the ${job.title} job on hold`) })
    if (job.status === 'open' || job.status === 'on_hold')
      statusItems.push({
        label: 'Mark filled',
        icon: 'user',
        onSelect: () => {
          if (status('filled', `Marked the ${job.title} job filled`)) setClosingOut(true)
        },
      })
    if (job.status !== 'closed' && job.status !== 'filled') statusItems.push({ label: 'Close without hiring', icon: 'x', onSelect: () => status('closed', `Closed the ${job.title} job`) })
    if (job.status === 'filled' || job.status === 'closed') statusItems.push({ label: 'Reopen as draft', icon: 'rotate-ccw', onSelect: () => status('draft', `Moved the ${job.title} job back to draft`) })
  }

  const closeSheet = () => replaceRoute('job', job.id)
  // Edit opened from the posting sheet ('#job.<id>.edit.posting') returns to the posting, so the
  // hard stop flow is Add a pay range > Save > Mark posted.
  const closeEdit = () => (route.segments[3] === 'posting' ? replaceRoute('job', job.id, 'posting') : closeSheet())
  const backfillName = job.isBackfill && job.backfillForPersonId ? personNameById(db, job.backfillForPersonId, '') : ''

  return (
    <>
      <PageHeader
        back={{ href: links.hiring('jobs'), label: 'Jobs' }}
        eyebrow={
          <span className="flex flex-wrap items-center gap-2 normal-case">
            <JobStatusBadge status={job.status} />
            <RequestBadge job={job} />
            {job.priority === 'high' && <Badge tone="accent">High priority</Badge>}
            {job.isBackfill && <Badge tone="outline">Backfill{backfillName ? ` for ${backfillName}` : ''}</Badge>}
            {!full && <Badge tone="neutral">You are on the panel</Badge>}
          </span>
        }
        title={job.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="inline-flex items-center gap-1.5">
              <Avatar name={personNameById(db, job.hiringManagerId)} size={22} />
              Hiring manager: {personNameById(db, job.hiringManagerId)}
            </span>
            <span>
              Range <MoneyRange min={job.payMin} max={job.payMax} />
            </span>
            {age && <span>{age}</span>}
            {job.postedOn && job.status === 'open' && <span>Posted {fmtDate(job.postedOn)}</span>}
            {slot &&
              (isAdmin ? (
                // A 40px hit area (the negative margins keep the subtitle compact); the text wraps inside its own span.
                <a href={links.comp('plan')} className="-my-2 inline-flex min-h-10 items-center gap-1 font-semibold text-accent underline-offset-2 hover:underline">
                  <Icon name="layers" size={14} className="shrink-0" />
                  <span>
                    Plan: {fmtQuarter(slot.quarter)} {slot.title}
                    {budget != null && (
                      <>
                        , budget <Money value={budget} short />
                      </>
                    )}
                  </span>
                </a>
              ) : (
                <span className="inline-flex items-center gap-1">
                  <Icon name="layers" size={14} />
                  Plan: {fmtQuarter(slot.quarter)} {slot.title}
                </span>
              ))}
          </span>
        }
        actions={
          <>
            {manage && job.status !== 'filled' && job.status !== 'closed' && (
              <Button variant="primary" icon="user-plus" onClick={() => setAdding(true)}>
                Add candidate
              </Button>
            )}
            {manage && (
              <Button icon="edit" onClick={() => navigate('job', job.id, 'edit')}>
                Edit
              </Button>
            )}
            <Button icon="file" onClick={() => navigate('job', job.id, 'posting')}>
              Posting
            </Button>
            {statusItems.length > 0 && (
              <Menu
                label="Job status"
                items={statusItems}
                trigger={(p) => (
                  <Button {...p} iconRight="chevron-down">
                    Status
                  </Button>
                )}
              />
            )}
          </>
        }
      />

      {pendingRequest &&
        (isAdmin ? (
          <Callout
            tone="accent"
            icon="briefcase"
            className="mb-4"
            title={`${personNameById(db, pendingRequest.requestedById)} requested this job for ${fmtQuarter(pendingRequest.quarter)}`}
            action={
              <span className="flex flex-wrap gap-2">
                <Button variant="primary" icon="check" onClick={() => decide(true)}>
                  Approve request
                </Button>
                <Button variant="ghost" onClick={() => decide(false)}>
                  Decline
                </Button>
              </span>
            }
          >
            {pendingRequest.reason ? `Why: ${pendingRequest.reason.replace(/[.!?\s]+$/, '')}.` : 'No reason given.'} Approving adds it to the headcount plan, then you can post it.
          </Callout>
        ) : (
          <Callout tone="neutral" icon="clock" className="mb-4" title="Waiting for Admin to approve this job request">
            Requested {fmtDate(pendingRequest.requestedOn)} for {fmtQuarter(pendingRequest.quarter)}. You can edit the details and add candidates now; posting opens once it is approved.
          </Callout>
        ))}

      {back && full && (
        <div className="-mt-1 mb-4 flex flex-wrap items-center gap-2 text-[14px] text-ink-2">
          <Badge tone={back.status === 'on_track' ? 'good' : 'warn'} icon={back.status === 'on_track' ? 'calendar-check' : 'clock'}>
            {back.status === 'on_track' ? 'On track' : back.status === 'tight' ? 'Tight' : 'At risk'}
          </Badge>
          <span>{back.text}</span>
          <span className="text-[12.5px] text-ink-3" title="Gaps come from your own accepted offers once there are 3 or more; otherwise 5 weeks from acceptance to start and 2 from onsite to acceptance.">
            {back.basis.fromHistory ? 'Based on your past hires' : 'Based on typical timing'}
          </span>
        </div>
      )}

      {needsCloseOut && closeOut && (
        <Callout
          tone="accent"
          icon="mail"
          title={`${job.status === 'filled' ? 'Filled' : 'Closed'}: ${plural(closeOut.applicationIds.length, 'candidate')} still waiting to hear back`}
          className="mb-4"
          action={
            <Button variant="primary" onClick={() => setClosingOut(true)}>
              Close out
            </Button>
          }
        >
          Copy one note with everyone on BCC, then archive them as Position filled.
        </Callout>
      )}

      {full ? (
        <>
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <Tabs
              label="Pipeline view"
              value={view}
              tabs={[
                { key: 'board', label: 'Board', href: links.job(job.id, 'board') },
                { key: 'list', label: 'List', href: links.job(job.id, 'list') },
                { key: 'sweep', label: 'Sweep', count: attention, href: links.job(job.id, 'sweep') },
              ]}
            />
            <p className="text-[13.5px] text-ink-3">
              {plural(active.length, 'active candidate')}
              {attention > 0 ? `, ${attention} need${attention === 1 ? 's' : ''} attention` : ', nobody waiting'}
              {view !== 'sweep' && <span className="hidden md:inline">. Keys: arrows to move, A advance, R reject, S snooze, J next, Enter open.</span>}
            </p>
          </div>
          {view !== 'sweep' && attention > 0 && (
            <div className="mb-4">
              <Button icon="zap" className={WRAP_BUTTON} onClick={() => navigate('job', job.id, 'sweep')}>
                Sweep {plural(attention, 'candidate')}, about {plural(Math.max(1, Math.ceil((attention * 25) / 60)), 'minute')}
              </Button>
            </div>
          )}
          {view === 'sweep' ? <Sweep key={job.id} job={job} /> : <Pipeline job={job} layout={view} />}
          {pool.length > 0 && view !== 'sweep' && (
            <Panel title="From your talent pool" subtitle="Tagged keep warm or silver medalist on a similar role. Add them in one tap." icon="star" className="mt-6">
              <ul className="divide-y divide-line">
                {pool.map((p) => (
                  <li key={p.candidate.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
                    <Avatar name={`${p.candidate.firstName} ${p.candidate.lastName}`} size={30} />
                    <div className="min-w-0 flex-1">
                      <a href={links.candidate(p.candidate.id)} className="font-semibold text-ink hover:text-accent">
                        {p.candidate.firstName} {p.candidate.lastName}
                      </a>
                      <p className="text-[13px] text-ink-3">
                        {p.tags.join(', ')}
                        {p.fromJob ? ` from ${p.fromJob.title}` : ''}
                      </p>
                    </div>
                    <SourceChip candidate={p.candidate} />
                    <Button
                      icon="plus"
                      onClick={() =>
                        commit(`Added ${p.candidate.firstName} ${p.candidate.lastName} to ${job.title}`, (d) => !!addApplication(d, p.candidate.id, job.id, { date: t, ownerId: job.hiringManagerId }))
                      }
                    >
                      Add to this job
                    </Button>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </>
      ) : (
        <PanelOnly job={job} />
      )}

      <QuickAddSheet open={adding} jobId={job.id} onClose={() => setAdding(false)} />
      <JobEditSheet job={job} open={sub === 'edit' && manage} onClose={closeEdit} />
      <PostingSheet job={job} open={sub === 'posting'} canManage={manage} onClose={closeSheet} />
      <CloseOutSheet job={job} open={closingOut} onClose={() => setClosingOut(false)} />
    </>
  )
}

/** On jobs where the viewer only interviews: their own interviews and scorecards, nothing else. */
function PanelOnly({ job }: { job: Job }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const me = viewer.personId
  const apps = new Map(db.applications.filter((a) => a.jobId === job.id).map((a) => [a.id, a]))
  const mine = db.interviews.filter((i) => apps.has(i.applicationId) && !!me && i.interviewerIds.includes(me) && i.status !== 'cancelled')
  const now = nowISO()
  // Upcoming interviews first (soonest first), then past ones (newest first).
  mine.sort((a, b) => {
    const ua = a.startsAt > now
    const ub = b.startsAt > now
    if (ua !== ub) return ua ? -1 : 1
    return ua ? a.startsAt.localeCompare(b.startsAt) : b.startsAt.localeCompare(a.startsAt)
  })
  return (
    <Panel title="Your interviews for this job" subtitle="You are on the interview panel, so you see only the candidates you interview and your own scorecards.">
      {mine.length === 0 ? (
        <EmptyState compact icon="calendar" title="No interviews yet" body="When you are scheduled to interview someone for this job, they show up here." />
      ) : (
        <ul className="divide-y divide-line">
          {mine.map((i) => {
            const app = apps.get(i.applicationId)
            const c = app && db.candidates.find((x) => x.id === app.candidateId)
            const card = db.scorecards.find((s) => s.interviewId === i.id && s.interviewerId === me)
            const upcoming = i.startsAt > now
            return (
              <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
                <div className="min-w-0 flex-1">
                  {c ? (
                    <a href={links.candidate(c.id)} className="font-semibold text-ink hover:text-accent">
                      {c.firstName} {c.lastName}
                    </a>
                  ) : (
                    <span className="font-semibold text-ink">Candidate</span>
                  )}
                  <p className="text-[13px] text-ink-3">
                    {i.name}, {formatDual(i.startsAt, c?.timezone)}
                  </p>
                </div>
                {upcoming ? (
                  <Badge tone="accent" icon="calendar">
                    Upcoming
                  </Badge>
                ) : card?.submittedAt ? (
                  <Badge tone="good" icon="check">
                    Scorecard in
                  </Badge>
                ) : card ? (
                  <Badge tone="warn" icon="clock">
                    Scorecard owed
                  </Badge>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}
