// Home: hiring pulse (one row per open job, plus a filled job with an offer still out). Me: open roles
// with posted ranges and Refer someone.
import { useState } from 'react'
import { links } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { canSeePipeline } from '@/domain/access'
import { addCandidate } from '@/domain/hiring/candidates'
import { findDuplicates } from '@/domain/hiring/parse'
import { daysOpen, miniFunnel, stuckCount } from '@/domain/hiring/pipeline'
import { candidateName } from '@/domain/hiring/util'
import { departmentName, getPerson, locationName, personNameById } from '@/domain/people'
import type { DB, ID, Job } from '@/domain/types'
import { today } from '@/lib/dates'
import { plural } from '@/lib/format'
import { logActivity, useDB } from '@/store/db'
import { Badge, Button, EmptyState, Field, focusFirstInvalid, Money, MoneyRange, Sheet, TextArea, TextInput } from '@/ui'
import { act, DICTATION_HINT } from './common'
import { looksLikeEmail, pulseJobs, pulseOfferLines, referralRows, splitName } from './logic'
import { NOTE_MAX_CHARS, noteCountText, textIssueError, textIssues } from '../logic'
import { TextIssueNotes } from '../parts'

/**
 * Home: one row per open job with mini funnel, days open, stuck count, offers out. A filled job stays
 * while an offer on it is still out (a second offer sent after the first hire filled it), or expired
 * while that candidate is still active (pulseJobs).
 */
export function HiringPulse() {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const date = today()
  const jobs = pulseJobs(db).filter((j) => canSeePipeline(viewer, j))
  if (jobs.length === 0) {
    return (
      <EmptyState
        compact
        icon="briefcase"
        title="No open jobs"
        body={viewer.role === 'admin' ? 'Open a job from the plan or a role template when you are ready to hire.' : 'Jobs where you are the hiring manager show here.'}
      />
    )
  }
  return (
    <ul className="divide-y divide-line">
      {jobs.map((job) => (
        <PulseRow key={job.id} job={job} date={date} />
      ))}
    </ul>
  )
}

function PulseRow({ job, date }: { job: Job; date: string }) {
  const db = useDB((s) => s.db)
  const funnel = miniFunnel(db, job).filter((s) => s.kind !== 'hired' && (s.kind !== 'offer' || s.total > 0))
  const open = daysOpen(job, date)
  const stuck = stuckCount(db, job, date)
  const backfill = job.isBackfill && job.backfillForPersonId ? getPerson(db, job.backfillForPersonId) : undefined
  const offers = pulseOfferLines(db, job.id, date)
  const filled = job.status === 'filled'
  const label = (s: { kind: string; name: string }) => (s.kind === 'new' ? 'applied' : s.name.toLowerCase())
  const funnelText = funnel.map((s) => `${s.total} ${label(s)}`).join(', ')
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <a href={links.job(job.id)} className="-my-2 inline-flex min-h-10 items-center text-[15px] font-bold text-ink hover:text-accent">
            {job.title}
          </a>
          {backfill && <span className="ml-1.5 text-[13px] text-ink-3">(backfill for #{backfill.hireNumber})</span>}
          <p className="mt-1 flex flex-wrap items-baseline gap-x-1 gap-y-1 text-[13.5px] text-ink-2" aria-label={`Funnel: ${funnelText}`}>
            {funnel.map((s, i) => (
              <span key={s.stageId} className="inline-flex items-baseline gap-1" aria-hidden>
                {i > 0 && <span className="px-0.5 text-ink-3">/</span>}
                <span className="num font-bold text-ink" title={s.name}>
                  {s.total}
                </span>
                <span className="text-[12px] text-ink-3">{label(s)}</span>
              </span>
            ))}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {filled ? (
            <Badge tone="good" icon="check">
              Filled
            </Badge>
          ) : (
            open != null && <span className="num text-[13px] text-ink-3">{plural(open, 'day')} open</span>
          )}
          {filled && stuck === 0 ? null : stuck > 0 ? (
            <a
              href={links.job(job.id, 'sweep')}
              className="-my-2 inline-flex min-h-10 items-center rounded-full"
              aria-label={`${stuck} stuck on ${job.title}. Open Sweep`}
            >
              <Badge tone="warn" icon="clock">
                {stuck} stuck
              </Badge>
            </a>
          ) : (
            <Badge tone="good" icon="check">
              None stuck
            </Badge>
          )}
        </div>
      </div>
      {offers.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-0.5">
          {offers.map((line) => (
            <li key={line} className="text-[13.5px] font-semibold text-ink">
              {line}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

/** Me: open roles with posted ranges and Refer someone. */
export function OpenRolesList() {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const [referFor, setReferFor] = useState<ID | null>(null)
  const jobs = db.jobs.filter((j) => j.status === 'open').sort((a, b) => a.title.localeCompare(b.title))
  const mine = referralRows(db, viewer.personId)
  return (
    <div className="flex flex-col gap-4">
      {jobs.length === 0 ? (
        <EmptyState compact icon="briefcase" title="No open roles right now" body="When the company opens a job, it shows here with its posted pay range." />
      ) : (
        <ul className="divide-y divide-line">
          {jobs.map((j) => {
            const bonus = j.referralBonus ?? db.settings.referralBonusDefault
            const where = j.workMode === 'remote' ? 'Remote' : `${j.workMode === 'hybrid' ? 'Hybrid' : 'On site'}, ${j.locationIds.map((id) => locationName(db, id)).filter(Boolean).join(', ') || db.company.hq.city}`
            return (
              <li key={j.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                {/* A basis wide enough that, on a narrow screen or at large text, Refer wraps below the text instead of squeezing it. */}
                <div className="min-w-0 flex-[1_1_14rem]">
                  <p className="text-[15px] font-bold text-ink">{j.title}</p>
                  <p className="text-[13.5px] text-ink-2">
                    {departmentName(db, j.departmentId)}. {where}
                  </p>
                  <p className="mt-0.5 text-[13.5px] text-ink-2">
                    Posted range: <MoneyRange min={j.payMin} max={j.payMax} className="font-semibold text-ink" />
                    {bonus > 0 && (
                      <>
                        {' '}
                        <span className="text-ink-3">
                          Referral bonus <Money value={bonus} />, paid {db.settings.referralBonusPayableDays} days after they start.
                        </span>
                      </>
                    )}
                  </p>
                </div>
                <Button icon="user-plus" onClick={() => setReferFor(j.id)} disabled={!viewer.personId} aria-label={`Refer someone for ${j.title}`}>
                  Refer someone
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      {mine.length > 0 && (
        <div>
          <h3 className="mb-1.5 text-[14px] font-bold text-ink">Your referrals</h3>
          <ul className="flex flex-col gap-1">
            {mine.map((r) => (
              <li key={r.key} className="flex flex-wrap items-center gap-2 text-[13.5px] text-ink-2">
                <span className="font-semibold text-ink">{candidateName(db, r.candidateId)}</span>
                <span>{db.jobs.find((j) => j.id === r.jobId)?.title}</span>
                <Badge tone={r.tone}>{r.status}</Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
      {referFor && <ReferSheet jobId={referFor} onClose={() => setReferFor(null)} />}
    </div>
  )
}

function ReferSheet({ jobId, onClose }: { jobId: ID; onClose: () => void }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const job = db.jobs.find((j) => j.id === jobId)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [linkedin, setLinkedin] = useState('')
  const [why, setWhy] = useState('')
  const [tried, setTried] = useState(false)
  if (!job) return null
  const { firstName, lastName } = splitName(name)
  const nameError = tried && !firstName ? 'Add their name.' : undefined
  const emailError = tried && !looksLikeEmail(email) ? 'Add an email address like name@example.com.' : undefined
  // Referral text reaches the hiring team as written: there is never a conditional offer yet, and
  // nobody should pass on what a friend earns, so both pay and criminal history block the send.
  const whyIssues = textIssues(why, { blockPay: true })
  const whyError = textIssueError(whyIssues)
  // Saved in the candidate's highlights or a timeline row, so capped like a note.
  const whyCount = noteCountText(why)

  const submit = () => {
    setTried(true)
    if (!firstName || !looksLikeEmail(email) || whyError) {
      focusFirstInvalid()
      return
    }
    if (!viewer.personId) return
    const referrerId = viewer.personId
    const dupId = findDuplicates(db, { email, linkedin })[0]
    if (dupId) {
      // Already on file: note the referral for the hiring team without saying so to the referrer. The
      // referrer's own list gets the same neutral entry a new referral would (candidate.otherReferrals).
      const res = act(`Referred ${name.trim()} for ${job.title}`, (d) => {
        const cand = d.candidates.find((c) => c.id === dupId)
        if (cand && !(cand.otherReferrals ?? []).some((r) => r.referrerId === referrerId && r.jobId === job.id)) {
          cand.otherReferrals = [...(cand.otherReferrals ?? []), { referrerId, jobId: job.id, on: today() }]
        }
        logActivity(d, {
          entityType: 'candidate',
          entityId: dupId,
          relatedId: referrerId,
          kind: 'referral_again',
          text: `${personNameById(d as DB, referrerId, 'A teammate')} also referred ${candidateName(d, dupId)} for ${job.title}${why.trim() ? `: ${why.trim()}` : ''}`,
        })
      })
      if (res) onClose()
      return
    }
    const res = act(`Referred ${name.trim()} for ${job.title}`, (d) =>
      addCandidate(
        d,
        {
          firstName,
          lastName,
          email: email.trim(),
          ...(linkedin.trim() ? { linkedin: linkedin.trim() } : {}),
          source: 'referral',
          sourceDetail: 'Employee referral',
          referrerId,
          ...(why.trim() ? { summary: `Why they would be great (from the referrer): ${why.trim()}` } : {}),
        },
        { date: today(), jobId: job.id },
      ),
    )
    if (res) onClose()
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="Refer someone"
      subtitle={`${job.title}. They land in New and the hiring team reviews them within ${job.stages[0]?.slaBusinessDays ?? 3} business days.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" icon="send" onClick={submit}>
            Send referral
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Their name" required error={nameError}>
          {(id, describedBy) => <TextInput id={id} data-autofocus aria-describedby={describedBy} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Email" required error={emailError}>
          {(id, describedBy) => <TextInput id={id} type="email" inputMode="email" autoComplete="off" aria-describedby={describedBy} value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Field label="LinkedIn" hint="Optional. A profile link helps the team avoid duplicates.">
          {(id, describedBy) => <TextInput id={id} type="url" inputMode="url" aria-describedby={describedBy} value={linkedin} onChange={(e) => setLinkedin(e.target.value)} placeholder="https://www.linkedin.com/in/" />}
        </Field>
        <Field label="Why they would be great" hint={whyCount ? `${DICTATION_HINT} ${whyCount}.` : DICTATION_HINT} error={whyError}>
          {(id, describedBy) => <TextArea id={id} rows={4} maxLength={NOTE_MAX_CHARS} aria-describedby={describedBy} value={why} onChange={(e) => setWhy(e.target.value)} />}
        </Field>
        <TextIssueNotes issues={whyIssues} />
        <p className="text-[13px] text-ink-3">You will see their stage here, not their interviews or notes. Never share what someone earns now: California bars asking about pay history.</p>
      </div>
    </Sheet>
  )
}
