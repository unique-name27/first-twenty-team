// Hiring (#hiring[.jobs|.candidates|.offers|.kits]): every job and every candidate the viewer may see.
// '#hiring.add[.<jobId>]' opens Quick add; '#hiring.new-job[.<planSlotId>]' opens the New job sheet.
import { useMemo, useState } from 'react'
import type { PageProps } from '@/app/routes'
import { links, navigate, replaceRoute } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { visibleJobs } from '@/domain/access'
import { formatDual, outcomeReasonLabel, stageById } from '@/domain/hiring'
import { openJobFromPlan } from '@/domain/lifecycle'
import { founder, levelLabel, personNameById } from '@/domain/people'
import type { ID, SourceKind, StageKind, Viewer } from '@/domain/types'
import { fmtDate, fmtQuarter, fmtShort, nowISO, today } from '@/lib/dates'
import { plural } from '@/lib/format'
import { useDB } from '@/store/db'
import { useServerAccount, useSyncStatus } from '@/sync'
import {
  Avatar,
  Badge,
  Button,
  buttonClass,
  ChipGroup,
  ChipMulti,
  type Column,
  DataTable,
  EmptyState,
  Icon,
  PageHeader,
  Panel,
  SearchInput,
  Select,
  Tabs,
} from '@/ui'
import { HiringMetricsPanel, InterviewKitsTab } from './interviews'
import { OffersTab } from './offers'
import { commit } from './actions'
import { CAREERS_SITE_DETAIL } from '@/domain/hiring/sources'
import {
  CAREERS_SITE_FILTER,
  type CandidateFilter,
  type CandidateFlag,
  type CandidateRow,
  candidateRows,
  compareJobs,
  filterCandidateRows,
  jobAgeText,
  type JobRowData,
  jobRowData,
  plannedRows,
  visibleApplicationIds,
  visibleCandidateIds,
} from './logic'
import { NewJobSheet } from './NewJobSheet'
import { AppStatusBadge, JobStatusBadge, MiniFunnel, RequestBadge, SOURCE_LABEL, SourceChip, WRAP_BUTTON } from './parts'
import { QuickAddSheet } from './QuickAddSheet'

type Tab = 'jobs' | 'candidates' | 'offers' | 'kits'

export function HiringPage({ route }: PageProps) {
  const viewer = useViewer()
  const seg = route.segments[1]
  const param = route.segments[2]
  const adding = seg === 'add'
  const creating = seg === 'new-job'
  const tab: Tab = seg === 'candidates' || seg === 'offers' || seg === 'kits' ? seg : adding ? 'candidates' : 'jobs'
  const isAdmin = viewer.role === 'admin'
  // Hiring managers request a job; it lands as an approval in Admin's inbox (no cost shown).
  const isManager = viewer.role === 'manager'
  // Synced with a server that serves careers pages: the company's public page, with its posted jobs.
  const connected = useSyncStatus((s) => s.mode === 'server')
  // Only while that page is public: a page an admin turned off shows nothing worth linking to.
  const account = useServerAccount(connected)
  const careersUrl = account?.careersEnabled ? account.careersUrl : null

  return (
    <>
      <PageHeader
        title="Hiring"
        subtitle="Every job and every candidate, each with a next step so nobody is dropped."
        actions={
          <>
            <Button variant="primary" icon="user-plus" onClick={() => navigate('hiring', 'add')}>
              Add candidate
            </Button>
            {isAdmin && (
              <Button icon="briefcase" onClick={() => navigate('hiring', 'new-job')}>
                New job
              </Button>
            )}
            {isManager && (
              <Button icon="briefcase" onClick={() => navigate('hiring', 'new-job')}>
                Request a job
              </Button>
            )}
            {connected && careersUrl && (
              <a href={careersUrl} target="_blank" rel="noopener noreferrer" className={buttonClass('ghost')}>
                <Icon name="external" size={18} className="ft-btn__icon shrink-0" />
                Careers page
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            )}
          </>
        }
      />
      <Tabs
        label="Hiring sections"
        value={tab}
        className="mb-5"
        tabs={[
          { key: 'jobs', label: 'Jobs', href: links.hiring('jobs') },
          { key: 'candidates', label: 'Candidates', href: links.hiring('candidates') },
          { key: 'offers', label: 'Offers', href: links.hiring('offers') },
          { key: 'kits', label: 'Interview kits', href: links.hiring('kits') },
        ]}
      />
      {tab === 'jobs' && <JobsTab />}
      {tab === 'candidates' && <CandidatesTab />}
      {tab === 'offers' && <OffersTab />}
      {tab === 'kits' && <InterviewKitsTab />}

      <QuickAddSheet
        open={adding}
        jobId={param ?? null}
        onClose={(added) => {
          if (added) navigate('candidate', added)
          else if (param) replaceRoute('job', param)
          else replaceRoute('hiring', 'candidates')
        }}
      />
      <NewJobSheet
        open={creating && (isAdmin || isManager)}
        mode={isAdmin ? 'create' : 'request'}
        planSlotId={isAdmin ? (param ?? null) : null}
        onClose={(jobId) => {
          // From a plan line everything is prefilled, so go straight to the posting (Copy, Mark posted).
          if (jobId) navigate('job', jobId, isAdmin && param ? 'posting' : null)
          else replaceRoute('hiring', 'jobs')
        }}
      />
      {creating && !isAdmin && !isManager && (
        <EmptyState icon="lock" compact title="Only an admin can open a job" body="Hiring managers can request one. Viewing as is a preview, not security." />
      )}
    </>
  )
}

// ---- Jobs ---------------------------------------------------------------------------------------

function JobsTab() {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const [showDone, setShowDone] = useState(false)
  const t = today()
  const rows = useMemo(() => {
    const now = nowISO()
    return [...visibleJobs(viewer, db)]
      .sort(compareJobs)
      .map((j) => jobRowData(db, viewer, j, t, now))
  }, [db, viewer, t])
  const live = rows.filter((r) => r.job.status === 'open' || r.job.status === 'draft' || r.job.status === 'on_hold')
  const done = rows.filter((r) => r.job.status === 'filled' || r.job.status === 'closed')
  const planned = plannedRows(db, viewer)
  const counts = { open: 0, draft: 0, on_hold: 0 }
  for (const r of live) counts[r.job.status as keyof typeof counts] += 1

  const openFromPlan = (slotId: ID) => {
    const slot = db.plan.find((s) => s.id === slotId)
    if (!slot) return
    const hm = db.departments.find((d) => d.id === slot.departmentId)?.headId ?? founder(db)?.id ?? ''
    const out: { id?: ID } = {}
    const ok = commit(`Opened a draft job for ${slot.title}`, (d) => {
      out.id = openJobFromPlan(d, slotId, { date: t, hiringManagerId: hm, actorId: viewer.personId })
    })
    // Everything prefills from the plan line and template, so land on the posting: Open job > Copy
    // posting > Mark posted (3 actions). The posting sheet links to Edit details for changes.
    if (out.id) navigate('job', out.id, 'posting')
    else if (!ok) navigate('hiring', 'new-job', slotId)
  }

  return (
    <div className="flex flex-col gap-6">
      <Panel
        title="Jobs"
        subtitle={live.length ? `${counts.open} open, ${counts.draft} draft, ${counts.on_hold} on hold` : undefined}
        padded={false}
      >
        {live.length === 0 && planned.length === 0 ? (
          <EmptyState
            icon="briefcase"
            title={viewer.role === 'admin' ? 'No open jobs' : 'No jobs for you right now'}
            body={
              viewer.role === 'admin'
                ? 'Open one from the headcount plan or start from a role template.'
                : 'Jobs where you are the hiring manager or on the panel show up here. Need someone? Request a job and Admin approves it.'
            }
            action={
              viewer.role === 'admin' || viewer.role === 'manager' ? (
                <Button variant="primary" icon="briefcase" onClick={() => navigate('hiring', 'new-job')}>
                  {viewer.role === 'admin' ? 'New job' : 'Request a job'}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="divide-y divide-line">
            {live.map((r) => (
              <JobRow key={r.job.id} row={r} />
            ))}
            {planned.map((slot) => (
              <li key={slot.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-surface-2/40 px-5 py-4 text-ink-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-ink-2">{slot.title}</p>
                  <p className="text-[13px]">
                    {fmtQuarter(slot.quarter)}, {levelLabel(db, slot.levelId)}, target start {fmtDate(slot.targetStart)}
                    {slot.isBackfill ? ', backfill' : ''}
                  </p>
                </div>
                <Badge tone="outline">Planned</Badge>
                {viewer.role === 'admin' ? (
                  <Button icon="plus" onClick={() => openFromPlan(slot.id)}>
                    Open job
                  </Button>
                ) : (
                  <span className="text-[13px]">An admin opens it</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {done.length > 0 && (
        <div>
          <Button variant="ghost" icon={showDone ? 'chevron-up' : 'chevron-down'} className={WRAP_BUTTON} aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
            {showDone ? 'Hide' : 'Show'} filled and closed jobs ({done.length})
          </Button>
          {showDone && (
            <Panel padded={false} className="mt-2">
              <ul className="divide-y divide-line">
                {done.map((r) => (
                  <JobRow key={r.job.id} row={r} />
                ))}
              </ul>
            </Panel>
          )}
        </div>
      )}

      {viewer.role !== 'employee' && <HiringMetricsPanel />}
    </div>
  )
}

function JobRow({ row }: { row: JobRowData }) {
  const db = useDB((s) => s.db)
  const { job } = row
  const hm = personNameById(db, job.hiringManagerId)
  const ni = row.nextInterview
  const age = jobAgeText(job, today(), fmtShort)
  return (
    // The title link stretches over the whole row (its ::after covers the li), so the row is the hit
    // target; links inside the row sit above it (relative z-10) and keep working.
    <li className="relative grid grid-cols-1 gap-x-5 gap-y-2 px-5 py-4 hover:bg-surface-2/70 md:grid-cols-[minmax(0,2.2fr)_minmax(0,1.1fr)_auto_minmax(0,1.6fr)] md:items-center">
      <div className="min-w-0">
        <a href={links.job(job.id)} className="font-bold text-ink after:absolute after:inset-0 after:content-[''] hover:text-accent">
          {job.title}
        </a>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <JobStatusBadge status={job.status} />
          <RequestBadge job={job} />
          {job.priority === 'high' && job.status === 'open' && <Badge tone="accent">High priority</Badge>}
          {job.isBackfill && <Badge tone="outline">Backfill for {row.backfillForName}</Badge>}
          {row.access === 'panel' && <Badge tone="neutral">On the panel</Badge>}
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-2 text-[13.5px] text-ink-2">
        <Avatar name={hm} size={24} />
        <span className="truncate">{hm}</span>
      </div>
      <div>{row.access === 'full' ? <MiniFunnel steps={row.funnel} /> : <span className="text-[13px] text-ink-3">Your interviews only</span>}</div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-2">
        {age && <span>{age}</span>}
        {row.access === 'full' && job.status !== 'filled' && job.status !== 'closed' && (row.active > 0 || row.stuck > 0) && (
          row.stuck > 0 ? (
            <a href={links.job(job.id, 'sweep')} className="relative z-10 -my-2 inline-flex min-h-10 items-center rounded-full focus-visible:outline-2" aria-label={`${row.stuck} stuck: sweep ${job.title}`}>
              <Badge tone="warn" icon="alert">
                {row.stuck} stuck
              </Badge>
            </a>
          ) : (
            <Badge tone="good" icon="check">
              None stuck
            </Badge>
          )
        )}
        {ni && (
          <span className="min-w-0" title={formatDual(ni.interview.startsAt)}>
            Next interview {fmtShort(ni.interview.startsAt)}, {ni.candidateName}
          </span>
        )}
      </div>
    </li>
  )
}

// ---- Candidates ---------------------------------------------------------------------------------

const STAGE_FILTERS: Array<{ value: StageKind | ''; label: string }> = [
  { value: '', label: 'Any stage' },
  { value: 'new', label: 'New' },
  { value: 'recruiter_screen', label: 'Recruiter screen' },
  { value: 'intro', label: 'Intro call' },
  { value: 'technical', label: 'Technical' },
  { value: 'onsite', label: 'Onsite' },
  { value: 'offer', label: 'Offer' },
  { value: 'hired', label: 'Hired' },
]

function useCandidateRows(viewer: Viewer) {
  const db = useDB((s) => s.db)
  return useMemo(() => {
    const apps = visibleApplicationIds(viewer, db)
    return candidateRows(db, visibleCandidateIds(viewer, db, apps), apps)
  }, [db, viewer])
}

function CandidatesTab() {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const rows = useCandidateRows(viewer)
  const [f, setF] = useState<CandidateFilter>({ q: '', stage: '', jobId: '', source: '', flags: [] })
  const [limit, setLimit] = useState(60)
  const filtered = useMemo(() => filterCandidateRows(db, rows, f).sort((a, b) => b.lastOn.localeCompare(a.lastOn)), [db, rows, f])
  const jobs = [...visibleJobs(viewer, db)].sort(compareJobs)
  const set = <K extends keyof CandidateFilter>(k: K, v: CandidateFilter[K]) => {
    setF((x) => ({ ...x, [k]: v }))
    setLimit(60)
  }

  const jobStageText = (r: CandidateRow): string => {
    if (!r.primary) return 'Talent pool'
    const job = db.jobs.find((j) => j.id === r.primary?.jobId)
    const stage = job ? stageById(job, r.primary.stageId) : undefined
    const where = r.primary.status === 'active' ? stage?.name : r.primary.status === 'hired' ? 'Hired' : r.primary.status === 'withdrawn' ? 'Withdrew' : 'Rejected'
    return `${job?.title ?? 'Job'}, ${where ?? 'stage'}${r.apps.length > 1 ? `, +${r.apps.length - 1} more` : ''}`
  }

  const columns: Array<Column<CandidateRow>> = [
    {
      key: 'name',
      header: 'Candidate',
      sort: (r) => `${r.candidate.lastName} ${r.candidate.firstName}`,
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar name={`${r.candidate.firstName} ${r.candidate.lastName}`} size={28} muted={r.candidate.archived} />
          <span className="min-w-0">
            <span className="block truncate">
              {r.candidate.firstName} {r.candidate.lastName}
            </span>
            {(r.candidate.currentTitle || r.candidate.currentCompany) && (
              <span className="block max-w-[260px] truncate text-[12.5px] font-normal text-ink-3">{[r.candidate.currentTitle, r.candidate.currentCompany].filter(Boolean).join(' at ')}</span>
            )}
            {/* Phones: the job, stage and status columns are hidden, so they ride on a second line. */}
            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] font-normal text-ink-2 sm:hidden">
              <span className="min-w-0">{jobStageText(r)}</span>
              {r.primary ? <AppStatusBadge app={r.primary} /> : <Badge tone="outline">Pool</Badge>}
            </span>
          </span>
        </span>
      ),
    },
    {
      key: 'job',
      header: 'Job and stage',
      hideBelow: 'sm',
      sort: (r) => (r.primary ? (db.jobs.find((j) => j.id === r.primary?.jobId)?.title ?? '') : ''),
      cell: (r) => {
        if (!r.primary) return <span className="text-ink-3">Talent pool</span>
        const job = db.jobs.find((j) => j.id === r.primary?.jobId)
        const stage = job ? stageById(job, r.primary.stageId) : undefined
        return (
          <span className="block min-w-0">
            <span className="block max-w-[240px] truncate">{job?.title ?? 'Job'}</span>
            <span className="text-[12.5px] text-ink-3">
              {r.primary.status === 'active' ? stage?.name : r.primary.status === 'hired' ? 'Hired' : `${r.primary.status === 'withdrawn' ? 'Withdrew' : 'Rejected'}: ${outcomeReasonLabel(r.primary.outcomeReason).toLowerCase()}`}
              {r.apps.length > 1 ? `, +${r.apps.length - 1} more` : ''}
            </span>
          </span>
        )
      },
    },
    { key: 'status', header: 'Status', hideBelow: 'sm', sort: (r) => r.status, cell: (r) => (r.primary ? <AppStatusBadge app={r.primary} /> : <Badge tone="outline">Pool</Badge>) },
    { key: 'source', header: 'Source', hideBelow: 'md', sort: (r) => r.candidate.source, cell: (r) => <SourceChip candidate={r.candidate} /> },
    {
      key: 'tags',
      header: 'Tags',
      hideBelow: 'lg',
      cell: (r) => (
        <span className="flex flex-wrap gap-1">
          {r.candidate.tags.slice(0, 3).map((tag) => (
            <Badge key={tag} tone={tag.toLowerCase() === 'keep warm' || tag.toLowerCase() === 'silver medalist' ? 'accent' : 'neutral'}>
              {tag.charAt(0).toUpperCase() + tag.slice(1)}
            </Badge>
          ))}
        </span>
      ),
    },
    { key: 'last', header: 'Last update', hideBelow: 'md', align: 'right', sort: (r) => r.lastOn, cell: (r) => <span className="num text-ink-2">{fmtShort(r.lastOn)}</span> },
  ]

  // Referrals are a source: the Source chips cover them, so they are not repeated here.
  const flagOptions: Array<{ value: CandidateFlag; label: string }> = [
    { value: 'keep_warm', label: 'Keep warm' },
    { value: 'silver', label: 'Silver medalist' },
    { value: 'archived', label: 'Archived' },
  ]

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <SearchInput value={f.q} onChange={(v) => set('q', v)} placeholder="Search candidates by name, email, company or job" />
        <div>
          <label htmlFor="cf-job" className="sr-only">
            Job
          </label>
          <Select<string> id="cf-job" value={f.jobId} onChange={(v) => set('jobId', v)} options={[{ value: '', label: 'Any job' }, ...jobs.map((j) => ({ value: j.id, label: j.title }))]} />
        </div>
        <div>
          <label htmlFor="cf-stage" className="sr-only">
            Stage
          </label>
          <Select<string> id="cf-stage" value={f.stage} onChange={(v) => set('stage', v as StageKind | '')} options={STAGE_FILTERS.map((s) => ({ value: s.value, label: s.label }))} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
          <span aria-hidden className="text-[13px] font-semibold text-ink-3">
            Source
          </span>
          <ChipGroup<CandidateFilter['source'] | 'any'>
            size="sm"
            label="Source"
            value={f.source || 'any'}
            onChange={(v) => set('source', v === 'any' ? '' : v)}
            options={[
              { value: 'any', label: 'Any source' },
              ...(['inbound', 'referral', 'outbound', 'agency'] as SourceKind[]).map((s) => ({ value: s, label: SOURCE_LABEL[s] })),
              // Inbound candidates who applied on the careers page, on their own.
              { value: CAREERS_SITE_FILTER, label: CAREERS_SITE_DETAIL },
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
          <span aria-hidden className="text-[13px] font-semibold text-ink-3">
            Show only
          </span>
          <ChipMulti<CandidateFlag> label="Show only" values={f.flags} onChange={(v) => set('flags', v)} options={flagOptions} />
        </div>
      </div>
      <Panel padded={false} title={`${plural(filtered.length, 'candidate')}`} subtitle={viewer.role === 'admin' ? undefined : 'Candidates on jobs you hire for, plus the people you interview.'}>
        <DataTable
          caption="Candidates"
          rows={filtered.slice(0, limit)}
          columns={columns}
          rowKey={(r) => r.candidate.id}
          rowHref={(r) => links.candidate(r.candidate.id)}
          empty={<EmptyState compact icon="search" title="No candidates match" body="Clear a filter or search for something shorter." />}
        />
        {filtered.length > limit && (
          <div className="border-t border-line px-5 py-3">
            <Button onClick={() => setLimit((n) => n + 100)}>Show more ({filtered.length - limit} left)</Button>
          </div>
        )}
      </Panel>
    </div>
  )
}
