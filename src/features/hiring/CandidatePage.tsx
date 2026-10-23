// Candidate profile (#candidate.<id>): header and profile (location and time zone, source and
// referrer, tags incl. keep warm and silver medalist, links, sponsorship, desired pay when allowed,
// retain-until date, Archive never Delete); per application a stage stepper, the required next step,
// quick logs and Reject/Withdraw; interviews, offer and background check blocks; notes and timeline.
// Panel-only viewers (and employees who interview) get a reduced profile: their interviews only.
// #candidate.<id>.offer.<applicationId> (links.candidateOffer, from 'Open offer' on a pipeline card)
// puts focus on that application's offer: its next action (Make offer, Mark sent, Hire), not the title.
import { useEffect, useMemo, useState } from 'react'
import type { PageProps } from '@/app/routes'
import { links } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { canSeeCandidatePay, canSeeOffer, canSeePipeline } from '@/domain/access'
import {
  archiveCandidate,
  attentionReasonLabel,
  attentionReasons,
  dbHolidays,
  jobStages,
  openOffer,
  outcomeReasonLabel,
  slaDetail,
  stageIndex,
  toggleCandidateTag,
  zoneLabel,
} from '@/domain/hiring'
import { personNameById } from '@/domain/people'
import type { Application, Candidate, Job } from '@/domain/types'
import { fmtDate, fmtDay, fmtRelative, fmtShort, nowISO, today } from '@/lib/dates'
import { money2, plural } from '@/lib/format'
import { logActivity, useDB } from '@/store/db'
import {
  Badge,
  Button,
  Callout,
  ChipGroup,
  CitationChip,
  cx,
  DescriptionList,
  EmptyState,
  Field,
  focusFirstInvalid,
  FormGrid,
  Icon,
  Money,
  MoneyInput,
  NumberInput,
  PageHeader,
  Panel,
  Private,
  Segmented,
  Select,
  Sheet,
  TextArea,
  TextInput,
  toast,
} from '@/ui'
import { CandidateBackground, CandidateOffer } from './offers'
import { offerFocusTarget } from './offers/focus'
import { CandidateInterviews } from './interviews'
import { advance, commit, logContact, moveTo } from './actions'
import { EditConflictCallout, focusEditConflict, useEditConflicts } from './EditConflict'
import {
  advanceTarget,
  candidateOfferOn,
  candidateTimeline,
  guessTimezone,
  hourlyDesiredFits,
  NOTE_MAX_CHARS,
  noteCountText,
  noteLengthError,
  payTooHighError,
  POOL_TAGS,
  slaBadge,
  switchDesiredUnit,
  textIssueError,
  textIssues,
  visibleApplicationIds,
} from './logic'
import { NextStepEditor } from './NextStepEditor'
import { AppStatusBadge, ExternalLink, NotLegalAdvice, SlaPill, SourceChip, TextIssueNotes } from './parts'
import { RejectFlow } from './RejectFlow'

const LC_4323 = 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=432.3.&lawCode=LAB'
const GC_12946 = 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=12946.&lawCode=GOV'

export function CandidatePage({ route }: PageProps) {
  const id = route.segments[1]
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const [editing, setEditing] = useState(false)
  const visibleApps = useMemo(() => visibleApplicationIds(viewer, db), [viewer, db])
  const cand = db.candidates.find((c) => c.id === id)
  // Opened for an offer: once the page has rendered (after the App's own scroll to the top and focus
  // rescue), focus the offer's next action, which scrolls it into view. Without one, focus stays put.
  const offerFor = route.segments[2] === 'offer' ? route.segments[3] : undefined
  useEffect(() => {
    if (!offerFor) return
    const frame = requestAnimationFrame(() => offerFocusTarget(offerFor)?.focus())
    return () => cancelAnimationFrame(frame)
  }, [offerFor, route.raw])

  if (!cand) {
    return <EmptyState icon="search" title="That candidate does not exist" body="The link may be from before an import or reset." action={<a className="font-bold text-accent underline" href={links.hiring('candidates')}>Go to candidates</a>} />
  }
  const apps = db.applications
    .filter((a) => a.candidateId === cand.id && visibleApps.has(a.id))
    .sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || b.appliedOn.localeCompare(a.appliedOn))
  const isAdmin = viewer.role === 'admin'
  if (!isAdmin && apps.length === 0) {
    return (
      <EmptyState
        icon="lock"
        title="Not part of this view"
        body="You see a candidate when you hire for their job or interview them. Viewing as is a preview, not security."
        action={viewer.role === 'employee' ? <a className="font-bold text-accent underline" href={links.me()}>Go to Me</a> : <a className="font-bold text-accent underline" href={links.hiring('candidates')}>Go to candidates</a>}
      />
    )
  }
  const jobOf = (a: Application) => db.jobs.find((j) => j.id === a.jobId)
  const fullApps = apps.filter((a) => {
    const j = jobOf(a)
    return isAdmin || (!!j && canSeePipeline(viewer, j))
  })
  const reduced = !isAdmin && fullApps.length === 0
  const payVisible = isAdmin || apps.some((a) => canSeeCandidatePay(viewer, db, a))
  const name = `${cand.firstName} ${cand.lastName}`.trim()
  const active = apps.some((a) => a.status === 'active')
  const t = today()

  const archive = () => {
    if (active) {
      toast({ text: `Close ${cand.firstName}'s active applications first (Reject or Withdrew), then archive.`, tone: 'neutral' })
      return
    }
    commit(`Archived ${name}`, (d) => archiveCandidate(d, cand.id, { date: t }))
  }
  const restore = () =>
    commit(`Restored ${name}`, (d) => {
      const c = d.candidates.find((x) => x.id === cand.id)
      if (!c || !c.archived) return false
      c.archived = false
      logActivity(d, { entityType: 'candidate', entityId: c.id, kind: 'candidate_restored', text: `Restored ${name} from the archive` })
    })

  return (
    <>
      <PageHeader
        back={viewer.role === 'employee' ? { href: links.me(), label: 'Me' } : { href: links.hiring('candidates'), label: 'Candidates' }}
        eyebrow={
          <span className="flex flex-wrap items-center gap-2 normal-case">
            <SourceChip candidate={cand} detail={!reduced} />
            {cand.archived && <Badge tone="outline">Archived</Badge>}
            {reduced && <Badge tone="neutral">You interview this candidate</Badge>}
          </span>
        }
        title={name}
        subtitle={[cand.currentTitle, cand.currentCompany].filter(Boolean).join(' at ') || undefined}
        actions={
          !reduced && !cand.anonymizedOn ? (
            <>
              <Button icon="edit" onClick={() => setEditing(true)}>
                Edit details
              </Button>
              {cand.archived ? (
                <Button icon="rotate-ccw" onClick={restore}>
                  Restore
                </Button>
              ) : (
                <Button icon="layers" onClick={archive} title="Archive keeps the record for 4 years. Nothing is deleted.">
                  Archive
                </Button>
              )}
            </>
          ) : undefined
        }
      />
      {cand.archived && !reduced && (
        <Callout tone="neutral" icon="layers" className="mb-5" title="Archived, not deleted">
          Applicant records are kept for 4 years after the decision{cand.retainUntil ? `, until ${fmtDate(cand.retainUntil)}` : ''}.
        </Callout>
      )}
      {!reduced && active && apps.some((a) => a.status === 'active' && !a.nextStep) && (
        <Callout tone="warn" className="mb-5" title="No next step">
          Every active candidate needs a next step, a due date and an owner.
        </Callout>
      )}

      {/* Two columns once the page area itself is 840px wide (measured on the content box, so 150% text
          and the rail count), one column below that. */}
      <div className="@container">
        <div className="ft-split ft-split--candidate grid grid-cols-1 gap-6 @[840px]:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex min-w-0 flex-col gap-6">
            {apps.length === 0 && (
              <Panel title="Applications">
                <EmptyState compact icon="briefcase" title="In the talent pool" body="Not on a job yet. Add them from a job's talent pool or with Add candidate." />
              </Panel>
            )}
            {apps.map((a) => {
              const job = jobOf(a)
              if (!job) return null
              const full = isAdmin || canSeePipeline(viewer, job)
              return <ApplicationPanel key={a.id} app={a} job={job} full={full} />
            })}
            {!reduced && <NotesPanel candidate={cand} />}
            {!reduced && <TimelinePanel candidate={cand} appIds={fullApps.map((a) => a.id)} />}
          </div>
          <aside className="ft-split__side flex min-w-0 flex-col gap-6">
            <ProfilePanel candidate={cand} reduced={reduced} payVisible={payVisible} />
          </aside>
        </div>
      </div>
      {editing && <EditCandidateSheet candidate={cand} payVisible={payVisible} onClose={() => setEditing(false)} />}
    </>
  )
}

// ---- Application ------------------------------------------------------------------------------

function ApplicationPanel({ app, job, full }: { app: Application; job: Job; full: boolean }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const [editingStep, setEditingStep] = useState(false)
  const [closing, setClosing] = useState<'reject' | 'withdraw' | null>(null)
  const [noting, setNoting] = useState(false)
  const t = today()
  const stages = jobStages(job)
  const cur = stageIndex(job, app.stageId)
  const sla = slaDetail(job, app, t, dbHolidays(db), openOffer(db, app.id))
  const slaHasWord = slaBadge(sla).word !== ''
  // The SLA pill already says 'past SLA'; list only the other reasons.
  const reasons = attentionReasons(db, app, t).filter((r) => r !== 'past_sla')
  const isActive = app.status === 'active'
  const closed = app.status === 'rejected' || app.status === 'withdrawn'
  const name = db.candidates.find((c) => c.id === app.candidateId)?.firstName ?? 'them'
  const showOffer = canSeeOffer(viewer, db, app)
  const advanceTo = advanceTarget(job, app)

  return (
    <Panel
      title={
        full ? (
          <a href={links.job(job.id)} className="-my-2 inline-flex min-h-10 items-center hover:text-accent">
            {job.title}
          </a>
        ) : (
          job.title
        )
      }
      subtitle={`Applied ${fmtDate(app.appliedOn)}${isActive ? `, in ${stages[cur]?.name ?? 'stage'} since ${fmtShort(app.stageEnteredOn)} (${plural(sla.days, 'business day')})` : ''}`}
      actions={<AppStatusBadge app={app} />}
    >
      <div className="flex flex-col gap-5">
        {full && (
          <>
            <nav aria-label={`Stages for ${job.title}`}>
              <ol className="ft-stepper flex flex-wrap gap-2">
                {stages.map((s, i) => {
                  const current = i === cur && app.status !== 'hired' && isActive
                  const past = app.status === 'hired' ? true : i < cur
                  const hiredStep = s.kind === 'hired'
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        aria-current={current ? 'step' : undefined}
                        disabled={(hiredStep && app.status !== 'hired') || current || app.status === 'hired'}
                        title={hiredStep ? 'Hire from the accepted offer below' : current ? 'Current stage' : closed ? `Reopen in ${s.name}` : `Move to ${s.name}`}
                        onClick={() => moveTo(app.id, s.id, viewer.personId)}
                        className={cx(
                          'ft-stepper__step',
                          current ? 'ft-stepper__step--current' : past && !closed && 'ft-stepper__step--done',
                          'inline-flex h-11 items-center gap-1.5 rounded-full border px-3.5 text-[13.5px] font-semibold transition-colors disabled:cursor-default',
                          current
                            ? 'border-accent bg-accent text-accent-ink'
                            : past && !closed
                              ? 'border-line bg-accent-soft text-accent-soft-ink hover:border-accent'
                              : 'border-line-strong bg-surface text-ink-2 hover:border-ink-3 hover:text-ink disabled:opacity-60',
                        )}
                      >
                        {past && !closed && <Icon name="check" size={14} strokeWidth={2.4} />}
                        {s.name}
                      </button>
                    </li>
                  )
                })}
              </ol>
            </nav>

            {/* Time in stage is in the subtitle; the pill only shows when it says something about the SLA. */}
            {isActive && (slaHasWord || reasons.length > 0 || (!!app.snoozedUntil && app.snoozedUntil > t)) && (
              <div className="flex flex-wrap items-center gap-2">
                {slaHasWord && <SlaPill detail={sla} />}
                {reasons.map((r) => (
                  <Badge key={r} tone="warn">
                    {attentionReasonLabel(r)}
                  </Badge>
                ))}
                {app.snoozedUntil && app.snoozedUntil > t && (
                  <Badge tone="neutral" icon="clock">
                    Snoozed to {fmtShort(app.snoozedUntil)}
                  </Badge>
                )}
              </div>
            )}

            {isActive && (
              <div className="ft-subpanel rounded-xl border border-line p-4">
                <div className="ft-subpanel__head mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="ft-subpanel__title text-[14.5px] font-bold text-ink">Next step</h3>
                  {app.nextStep && !editingStep && (
                    <Button size="sm" icon="edit" onClick={() => setEditingStep(true)}>
                      Change
                    </Button>
                  )}
                </div>
                {app.nextStep && !editingStep ? (
                  <p className={cx('text-[14.5px]', app.nextStep.dueOn < t ? 'font-semibold text-warn' : 'text-ink')}>
                    {app.nextStep.text}, {app.nextStep.dueOn < t ? 'was due' : 'due'} {fmtDay(app.nextStep.dueOn)} ({fmtRelative(app.nextStep.dueOn)}). Owner: {personNameById(db, app.nextStep.ownerId)}
                  </p>
                ) : (
                  <NextStepEditor app={app} job={job} onDone={app.nextStep ? () => setEditingStep(false) : undefined} autoFocus={editingStep} />
                )}
              </div>
            )}

            {(isActive || app.status === 'hired') && (
              <div className="flex flex-col gap-2">
                <p className="text-[13.5px] font-semibold text-ink-2">
                  Log a contact{app.lastContactOn ? <span className="font-normal text-ink-3"> (last {fmtRelative(app.lastContactOn)})</span> : null}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button icon="mail" onClick={() => logContact(app.id, 'emailed')}>
                    Emailed
                  </Button>
                  <Button icon="phone" onClick={() => logContact(app.id, 'called')}>
                    Called
                  </Button>
                  <Button icon="message" onClick={() => logContact(app.id, 'voicemail')}>
                    Left voicemail
                  </Button>
                </div>
              </div>
            )}

            {isActive && (
              <div className="flex flex-wrap gap-2 border-t border-line pt-4">
                {/* The labeled way forward (the stage names above move too, to any stage): the board's Advance. */}
                {advanceTo && (
                  <Button iconRight="arrow-right" onClick={() => advance(app.id, viewer.personId)}>
                    Advance to {advanceTo.name}
                  </Button>
                )}
                <Button icon="x" onClick={() => setClosing('reject')}>
                  Reject
                </Button>
                <Button variant="ghost" onClick={() => setClosing('withdraw')}>
                  {name} withdrew
                </Button>
              </div>
            )}

            {closed && (
              <div className="flex flex-wrap items-center gap-2 rounded-xl bg-surface-2 px-4 py-3 text-[14px] text-ink-2">
                <span>
                  {app.status === 'withdrawn' ? 'Withdrew' : 'Rejected'}: {outcomeReasonLabel(app.outcomeReason).toLowerCase()}
                  {app.closedOn ? `, ${fmtDate(app.closedOn)}` : ''}.
                  {app.outcomeNote ? ` Note: ${app.outcomeNote}` : ''}
                </span>
                {app.notifiedOn ? (
                  <Badge tone="good" icon="check">
                    Notified {fmtShort(app.notifiedOn)}
                  </Badge>
                ) : (
                  <Button size="sm" icon="mail" onClick={() => setNoting(true)}>
                    Send note
                  </Button>
                )}
                <span className="text-[12.5px] text-ink-3">Click a stage above to reopen.</span>
              </div>
            )}
          </>
        )}

        {/* Embedded blocks are contained so nothing inside them can widen the page at phone width. The clip edge
            sits 4px outside the content (padding taken back by the margin), so a focus ring on a control at
            either edge keeps its sides. */}
        <div className="relative -mx-1 flex min-w-0 flex-col gap-5 overflow-x-clip px-1">
          <CandidateInterviews applicationId={app.id} />
          {full && showOffer && <CandidateOffer applicationId={app.id} />}
          {full && <CandidateBackground applicationId={app.id} />}
        </div>
      </div>
      <RejectFlow appId={closing ? app.id : null} mode={closing ?? 'reject'} onClose={() => setClosing(null)} />
      <RejectFlow appId={noting ? app.id : null} mode={app.status === 'withdrawn' ? 'withdraw' : 'reject'} startAt="notify" onClose={() => setNoting(false)} />
    </Panel>
  )
}

// ---- Profile ----------------------------------------------------------------------------------

const ZONE_NAMES: Record<string, string> = { PT: 'Pacific time', MT: 'Mountain time', CT: 'Central time', ET: 'Eastern time' }

/** 'Pacific time (PT)', 'Central time (CT)', or 'London time (GMT+1)' outside the main US zones. */
function tzText(tz: string | undefined): string | null {
  if (!tz) return null
  const label = zoneLabel(tz, nowISO())
  const city = tz.split('/').pop()?.replace(/_/g, ' ')
  return ZONE_NAMES[label] ? `${ZONE_NAMES[label]} (${label})` : `${city} time (${label})`
}

function ProfilePanel({ candidate: c, reduced, payVisible }: { candidate: Candidate; reduced: boolean; payVisible: boolean }) {
  const db = useDB((s) => s.db)
  const [newTag, setNewTag] = useState('')
  const name = `${c.firstName} ${c.lastName}`
  const tz = tzText(c.timezone ?? guessTimezone(c.location))
  const otherTags = c.tags.filter((t) => !(POOL_TAGS as readonly string[]).includes(t.toLowerCase()))
  const linkItems: Array<[string | undefined, string, 'link' | 'file' | 'globe']> = [
    [c.links.linkedin, 'LinkedIn', 'link'],
    [c.links.github, 'GitHub', 'link'],
    [c.links.resume, 'Resume link', 'file'],
    [c.links.portfolio, 'Portfolio', 'globe'],
  ]
  const toggle = (tag: string) => {
    const has = c.tags.includes(tag)
    commit(has ? `Removed the ${tag} tag from ${name}` : `Tagged ${name} ${tag}`, (d) => toggleCandidateTag(d, c.id, tag))
  }
  const addTag = () => {
    const tag = newTag.trim().toLowerCase()
    if (!tag || c.tags.includes(tag)) return
    toggle(tag)
    setNewTag('')
  }

  return (
    <>
      <Panel title="Profile">
        <DescriptionList
          columns={1}
          items={[
            // 40px-tall targets; the negative margins keep the rows compact.
            { label: 'Email', value: c.email ? <a className="-my-2 inline-flex min-h-10 items-center break-all text-accent underline" href={`mailto:${c.email}`}>{c.email}</a> : null, hidden: reduced },
            { label: 'Phone', value: c.phone ? <a className="-my-2 inline-flex min-h-10 items-center text-accent underline" href={`tel:${c.phone.replace(/[^\d+]/g, '')}`}>{c.phone}</a> : null, hidden: reduced },
            { label: 'Location and time zone', value: [c.location, tz].filter(Boolean).join(', ') || null },
            {
              label: 'Source',
              value: (
                <span>
                  {c.source.charAt(0).toUpperCase() + c.source.slice(1)}
                  {c.sourceDetail ? `: ${c.sourceDetail}` : ''}
                  {c.referrerId ? (
                    <>
                      {', referred by '}
                      <a className="-my-2 inline-flex min-h-10 items-center text-accent underline" href={links.person(c.referrerId)}>
                        {personNameById(db, c.referrerId)}
                      </a>
                    </>
                  ) : null}
                </span>
              ),
              hidden: reduced,
            },
            { label: 'Needs visa sponsorship', value: c.sponsorship === 'yes' ? 'Yes' : c.sponsorship === 'no' ? 'No' : 'Unknown', hidden: reduced },
            {
              label: 'Desired pay',
              value:
                c.desiredPay == null ? (
                  <span className="text-ink-3">Not asked yet</span>
                ) : c.desiredPayUnit === 'hour' ? (
                  <>
                    <Private>{money2(c.desiredPay)}</Private> an hour
                  </>
                ) : (
                  <>
                    <Money value={c.desiredPay} /> a year
                  </>
                ),
              hidden: reduced || !payVisible,
            },
            { label: 'Added', value: fmtDate(c.createdOn), hidden: reduced },
          ]}
        />
        {!reduced && payVisible && (
          <p className="mt-3 text-[12.5px] text-ink-3">
            Ask about desired pay only. California bans asking about current or past pay. <CitationChip label="Labor Code 432.3" url={LC_4323} />
          </p>
        )}
        {linkItems.some(([u]) => !!u) && (
          <div className="mt-4 flex flex-wrap gap-2">
            {linkItems.map(([u, label, icon]) => (u ? <ExternalLink key={label} href={u} label={label} icon={icon} /> : null))}
          </div>
        )}
        {c.summary && !reduced && <p className="mt-4 text-[14px] text-ink-2">{c.summary}</p>}
      </Panel>

      {!reduced && (
        <Panel title="Tags" subtitle="Keep warm and silver medalist resurface when a similar job opens.">
          <div className="flex flex-wrap gap-2">
            {POOL_TAGS.map((tag) => {
              const on = c.tags.some((x) => x.toLowerCase() === tag)
              return (
                <button
                  key={tag}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => toggle(c.tags.find((x) => x.toLowerCase() === tag) ?? tag)}
                  className={cx(
                    'inline-flex h-11 items-center gap-1.5 rounded-full border px-3.5 text-[13.5px] font-semibold',
                    on ? 'border-accent bg-accent-soft text-accent-soft-ink' : 'border-line-strong bg-surface text-ink-2 hover:text-ink',
                  )}
                >
                  {on && <Icon name="check" size={14} strokeWidth={2.4} />}
                  {tag.charAt(0).toUpperCase() + tag.slice(1)}
                </button>
              )
            })}
          </div>
          {otherTags.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-2">
              {otherTags.map((tag) => (
                <li key={tag} className="ft-tag ft-tag--removable inline-flex items-center gap-1 rounded-full bg-surface-2 pl-3 text-[13px] text-ink">
                  {tag}
                  <button type="button" aria-label={`Remove the ${tag} tag`} onClick={() => toggle(tag)} className="inline-flex h-10 w-10 items-center justify-center rounded-full text-ink-3 hover:text-ink">
                    <Icon name="x" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex gap-2">
            <label htmlFor={`tag-${c.id}`} className="sr-only">
              New tag
            </label>
            <TextInput
              id={`tag-${c.id}`}
              placeholder="Add a tag"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addTag()
                }
              }}
            />
            <Button onClick={addTag} disabled={!newTag.trim()}>
              Add tag
            </Button>
          </div>
        </Panel>
      )}

      {!reduced && (
        <Panel title="Record keeping">
          <p className="text-[14px] text-ink-2">
            {c.retainUntil ? `Keep this record until ${fmtDate(c.retainUntil)}.` : 'Kept 4 years after the hiring decision.'} Applicant records are archived, never deleted, for 4 years.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <CitationChip label="Gov Code 12946" url={GC_12946} />
            <NotLegalAdvice />
          </div>
          {c.anonymizedOn && <p className="mt-2 text-[13px] text-ink-3">Anonymized on {fmtDate(c.anonymizedOn)}.</p>}
        </Panel>
      )}
    </>
  )
}

// ---- Notes and timeline -----------------------------------------------------------------------

function NotesPanel({ candidate: c }: { candidate: Candidate }) {
  const offerOn = useDB((s) => candidateOfferOn(s.db, c.id))
  const [text, setText] = useState('')
  const [tooLong, setTooLong] = useState<string | undefined>(undefined)
  const issues = textIssues(text, { conditionalOfferOn: offerOn })
  // A note is its own activity record, and each record syncs as at most 256 KB (docs/SYNC.md).
  const error = textIssueError(issues) ?? tooLong
  const count = noteCountText(text)
  const name = `${c.firstName} ${c.lastName}`
  const add = () => {
    const note = text.trim()
    if (!note) return
    const long = noteLengthError(note)
    if (long) setTooLong(long)
    if (error || long) {
      focusFirstInvalid()
      return
    }
    const ok = commit(`Added a note on ${name}`, (d) => {
      logActivity(d, { entityType: 'candidate', entityId: c.id, kind: 'note', text: note })
    })
    if (ok) setText('')
  }
  return (
    <Panel title="Notes" subtitle="Notes go on the timeline. They are visible to admins and the hiring manager.">
      <Field label="Add a note" hint={`Tip: press Win+H to dictate (on a Mac, press Fn twice).${count ? ` ${count}.` : ''}`} error={error} id={`note-${c.id}`}>
        {(id, hint) => (
          <TextArea
            id={id}
            aria-describedby={hint}
            rows={3}
            maxLength={NOTE_MAX_CHARS}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setTooLong(undefined)
            }}
          />
        )}
      </Field>
      <TextIssueNotes issues={issues} className="mt-3" />
      <div className="mt-3">
        <Button variant="primary" icon="plus" onClick={add} disabled={!text.trim() || !!error}>
          Add note
        </Button>
      </div>
    </Panel>
  )
}

const KIND_ICON: Record<string, Parameters<typeof Icon>[0]['name']> = {
  note: 'message',
  emailed: 'mail',
  called: 'phone',
  voicemail: 'phone',
  stage_moved: 'arrow-right',
  applied: 'inbox',
  rejected: 'x',
  withdrawn: 'log-out',
  notified: 'send',
  interview_scheduled: 'calendar',
  scorecard_submitted: 'clipboard-check',
  tag: 'star',
  candidate_added: 'user-plus',
  application_added: 'briefcase',
  next_step: 'arrow-right',
  snoozed: 'clock',
  referral: 'heart',
  offer_sent: 'send',
}

function TimelinePanel({ candidate: c, appIds }: { candidate: Candidate; appIds: string[] }) {
  const db = useDB((s) => s.db)
  const [all, setAll] = useState(false)
  const items = useMemo(() => candidateTimeline(db, c.id, appIds), [db, c.id, appIds])
  const shown = all ? items : items.slice(0, 25)
  return (
    <Panel title="Timeline">
      {items.length === 0 ? (
        <p className="text-[14px] text-ink-3">Nothing logged yet.</p>
      ) : (
        <ol className="flex flex-col">
          {shown.map((i) => (
            <li key={i.id} className="flex gap-3 border-l-2 border-line py-2 pl-4">
              <Icon name={KIND_ICON[i.kind] ?? 'clock'} size={16} className="mt-0.5 shrink-0 text-ink-3" />
              <div className="min-w-0">
                <p className={cx('text-[14px] text-ink', i.kind === 'note' && 'whitespace-pre-wrap')}>{i.text}</p>
                <p className="text-[12.5px] text-ink-3">
                  {fmtDate(i.at)}
                  {i.actorId ? `, ${personNameById(db, i.actorId, 'someone')}` : ''}
                  {i.preview ? ' (recorded in a Viewing as preview)' : ''}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
      {items.length > 25 && (
        <Button variant="ghost" className="mt-2" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${plural(items.length, 'event')}`}
        </Button>
      )}
    </Panel>
  )
}

// ---- Edit details -----------------------------------------------------------------------------

const ZONES = [
  { value: '', label: 'Not set' },
  { value: 'America/Los_Angeles', label: 'Pacific (PT)' },
  { value: 'America/Denver', label: 'Mountain (MT)' },
  { value: 'America/Phoenix', label: 'Arizona (MST)' },
  { value: 'America/Chicago', label: 'Central (CT)' },
  { value: 'America/New_York', label: 'Eastern (ET)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii' },
  { value: 'America/Anchorage', label: 'Alaska' },
  { value: 'Europe/London', label: 'London' },
  { value: 'Asia/Kolkata', label: 'India' },
]

/** The Edit details form for a candidate record. */
function detailsForm(c: Candidate) {
  return {
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
    phone: c.phone ?? '',
    location: c.location ?? '',
    timezone: c.timezone ?? '',
    currentTitle: c.currentTitle ?? '',
    currentCompany: c.currentCompany ?? '',
    linkedin: c.links.linkedin ?? '',
    github: c.links.github ?? '',
    resume: c.links.resume ?? '',
    portfolio: c.links.portfolio ?? '',
    summary: c.summary ?? '',
    sponsorship: c.sponsorship,
    desiredPay: c.desiredPay ?? null,
    desiredPayUnit: c.desiredPayUnit === 'hour' ? ('hour' as const) : ('year' as const),
  }
}

type DetailsForm = ReturnType<typeof detailsForm>

const DETAIL_WORDS: Record<keyof DetailsForm, string> = {
  firstName: 'the first name',
  lastName: 'the last name',
  email: 'the email',
  phone: 'the phone',
  location: 'the location',
  timezone: 'the time zone',
  currentTitle: 'the current title',
  currentCompany: 'the current company',
  linkedin: 'the LinkedIn link',
  github: 'the GitHub link',
  resume: 'the resume link',
  portfolio: 'the portfolio link',
  summary: 'the highlights',
  sponsorship: 'the sponsorship answer',
  desiredPay: 'the desired pay',
  desiredPayUnit: 'whether desired pay is per year or per hour',
}

/**
 * Edit details. Saves only the fields changed here, so a change another computer made while the sheet
 * was open survives; a change to the same field asks first (Use theirs or Keep mine).
 */
function EditCandidateSheet({ candidate: opened, payVisible, onClose }: { candidate: Candidate; payVisible: boolean; onClose: () => void }) {
  const c = useDB((s) => s.db.candidates.find((x) => x.id === opened.id)) ?? opened
  const offerOn = useDB((s) => candidateOfferOn(s.db, c.id))
  const edit = useEditConflicts(detailsForm(c))
  const [f, setF] = useState<DetailsForm>(() => edit.base)
  const set = <K extends keyof DetailsForm>(k: K, v: DetailsForm[K]) => setF((x) => ({ ...x, [k]: v }))
  const zones = f.timezone && !ZONES.some((z) => z.value === f.timezone) ? [...ZONES, { value: f.timezone, label: f.timezone }] : ZONES
  const summaryIssues = textIssues(f.summary, { conditionalOfferOn: offerOn })
  const summaryError = textIssueError(summaryIssues) ?? noteLengthError(f.summary)
  // Per hour is offered when one of their jobs is posted by the hour or part time (or it is set already).
  const hourlyFits = useDB((s) => hourlyDesiredFits(s.db.applications.filter((a) => a.candidateId === c.id).map((a) => s.db.jobs.find((j) => j.id === a.jobId))))
  const showUnit = hourlyFits || f.desiredPayUnit === 'hour'
  const payError = payTooHighError(f.desiredPay, f.desiredPayUnit === 'hour' ? 'hourly' : 'annual')
  // Desired pay is not on the form for viewers who cannot see it, so it never counts here.
  const payKey = (k: keyof DetailsForm) => k === 'desiredPay' || k === 'desiredPayUnit'
  const conflicts = edit.conflicts(f).filter((k) => payVisible || !payKey(k))
  const save = () => {
    if (!f.firstName.trim()) {
      toast({ text: 'Add a first name.', tone: 'bad' })
      return
    }
    if (summaryError || (payVisible && payError)) {
      focusFirstInvalid()
      return
    }
    if (conflicts.length) {
      toast({ text: 'These details changed on another computer. Pick Use theirs or Keep mine first.', tone: 'neutral' })
      focusEditConflict()
      return
    }
    const changed = edit.changed(f).filter((k) => payVisible || !payKey(k))
    if (changed.length === 0) {
      onClose()
      return
    }
    commit(`Updated details for ${f.firstName} ${f.lastName}`.trim(), (d) => {
      const x = d.candidates.find((y) => y.id === c.id)
      if (!x) return false
      const opt = (k: 'phone' | 'location' | 'timezone' | 'currentTitle' | 'currentCompany' | 'summary', v: string) => {
        if (v.trim()) x[k] = v.trim()
        else delete x[k]
      }
      // Only the fields changed in this sheet: anything else keeps what is stored now.
      for (const k of changed) {
        switch (k) {
          case 'firstName':
          case 'lastName':
          case 'email':
            x[k] = f[k].trim()
            break
          case 'phone':
          case 'location':
          case 'timezone':
          case 'currentTitle':
          case 'currentCompany':
          case 'summary':
            opt(k, f[k])
            break
          case 'linkedin':
          case 'github':
          case 'resume':
          case 'portfolio': {
            // One link at a time, so a link added on another computer stays.
            const next: Candidate['links'] = { ...x.links }
            if (f[k].trim()) next[k] = f[k].trim()
            else delete next[k]
            x.links = next
            break
          }
          case 'sponsorship':
            x.sponsorship = f.sponsorship
            break
          case 'desiredPay':
            if (f.desiredPay != null) x.desiredPay = f.desiredPay
            else {
              delete x.desiredPay
              delete x.desiredPayUnit
            }
            break
          case 'desiredPayUnit':
            // A unit means nothing without an amount; a yearly figure stores no unit (the default).
            if (f.desiredPayUnit === 'hour' && f.desiredPay != null) x.desiredPayUnit = 'hour'
            else delete x.desiredPayUnit
            break
        }
      }
      logActivity(d, { entityType: 'candidate', entityId: c.id, kind: 'field_change', text: `Edited details for ${x.firstName} ${x.lastName}` })
    })
    onClose()
  }
  const text = (k: 'firstName' | 'lastName' | 'email' | 'phone' | 'location' | 'currentTitle' | 'currentCompany' | 'linkedin' | 'github' | 'resume' | 'portfolio', label: string) => (
    <Field label={label} id={`ec-${k}`}>
      {(id) => <TextInput id={id} value={f[k]} onChange={(e) => set(k, e.target.value)} />}
    </Field>
  )
  return (
    <Sheet
      open
      onClose={onClose}
      title="Edit details"
      subtitle={`${c.firstName} ${c.lastName}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save}>
            Save details
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <EditConflictCallout
          what="candidate"
          lines={conflicts.map((k) => (k === 'email' ? `the email is now ${c.email}` : `${DETAIL_WORDS[k]} changed`))}
          onTheirs={() => edit.takeTheirs(conflicts, setF)}
          onMine={() => edit.keepMine(conflicts)}
        />
        <FormGrid>
          {text('firstName', 'First name')}
          {text('lastName', 'Last name')}
          {text('email', 'Email')}
          {text('phone', 'Phone')}
          {text('location', 'Location')}
          <Field label="Time zone" id="ec-tz">
            {(id) => <Select<string> id={id} value={f.timezone} onChange={(v) => set('timezone', v)} options={zones} />}
          </Field>
          {text('currentTitle', 'Current title')}
          {text('currentCompany', 'Current company')}
        </FormGrid>
        <FormGrid>
          {text('linkedin', 'LinkedIn')}
          {text('github', 'GitHub')}
          {text('resume', 'Resume link (Drive, Dropbox)')}
          {text('portfolio', 'Portfolio')}
        </FormGrid>
        <div>
          <p className="mb-1.5 text-[13.5px] font-semibold text-ink-2">Needs visa sponsorship</p>
          <ChipGroup<Candidate['sponsorship']>
            label="Needs visa sponsorship"
            value={f.sponsorship}
            onChange={(v) => set('sponsorship', v)}
            options={[
              { value: 'unknown', label: 'Unknown' },
              { value: 'no', label: 'No' },
              { value: 'yes', label: 'Yes' },
            ]}
          />
        </div>
        {payVisible && (
          <div className="flex flex-col gap-2">
            <Field label="Desired pay" hint="Ask about desired pay only. California bans asking about current or past pay (Labor Code 432.3)." id="ec-pay" error={payError}>
              {(id, hint) =>
                f.desiredPayUnit === 'hour' ? (
                  <NumberInput id={id} aria-describedby={hint} prefix="$" suffix="/ hour" step={0.25} min={0} sensitive value={f.desiredPay} onChange={(v) => set('desiredPay', v)} />
                ) : (
                  <MoneyInput id={id} aria-describedby={hint} value={f.desiredPay} onChange={(v) => set('desiredPay', v)} suffix="/ year" />
                )
              }
            </Field>
            {showUnit && (
              <Segmented
                size="sm"
                label="Desired pay per"
                value={f.desiredPayUnit}
                onChange={(u) => setF((x) => ({ ...x, desiredPayUnit: u, desiredPay: switchDesiredUnit(x.desiredPay, u) }))}
                options={[
                  { value: 'year', label: 'Per year' },
                  { value: 'hour', label: 'Per hour' },
                ]}
              />
            )}
          </div>
        )}
        <Field label="Highlights" hint="A few lines from their background. No pay history." error={summaryError} id="ec-summary">
          {(id, hint) => <TextArea id={id} aria-describedby={hint} rows={3} maxLength={NOTE_MAX_CHARS} value={f.summary} onChange={(e) => set('summary', e.target.value)} />}
        </Field>
        <TextIssueNotes issues={summaryIssues} />
      </div>
    </Sheet>
  )
}
