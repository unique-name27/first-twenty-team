// Background check and Fair Chance steps. Locked until the offer is accepted (conditional offer date):
// California bars criminal-history checks and questions before then (Gov Code 12952), at every size.
// Admin sees status steps (consent via the vendor link-out, in progress, Clear or Consider: status only,
// never the report) and, on Consider, the Fair Chance stepper with computed dates. Hiring managers see
// only 'Contingencies cleared: yes or no'.
import type { ReactNode } from 'react'
import { useState } from 'react'
import { useViewer } from '@/app/useViewer'
import { canSeeBackgroundDetail, canSeeOffer } from '@/domain/access'
import { NOT_LEGAL_ADVICE } from '@/domain/compliance'
import { decideFairChance, recordBackgroundResult, startBackgroundCheck, updateFairChance } from '@/domain/hiring/backgroundChecks'
import { creditCheckBasisLabel, criminalHistoryLockReason, fairChanceSteps, type FairChanceStep } from '@/domain/hiring/fairChance'
import { candidateName, dbHolidays, offersFor } from '@/domain/hiring/util'
import type { BackgroundCheck, ID, Offer } from '@/domain/types'
import { fmtDay, today } from '@/lib/dates'
import { setTaskStatus } from '@/domain/checklists/actions'
import { TASK_IDS } from '@/domain/checklists/templates'
import { currentActorId, logActivity, useDB } from '@/store/db'
import { Badge, Button, Callout, ChipGroup, CitationChip, ConfirmButton, cx, Field, Icon, TextArea, TextInput, toast } from '@/ui'
import { act, SubPanel } from '../interviews/common'
import { NOTE_MAX_CHARS } from '../logic'
import { backgroundStep, checkCleared, contingenciesCleared } from './logic'

const FCA = { label: 'Gov Code 12952', url: 'https://calcivilrights.ca.gov/wp-content/uploads/sites/32/2025/07/Fair-Chance-Act-Factsheet_English.pdf' }

/** The offer a background check belongs to: the accepted one, else the latest. */
function checkOffer(offers: Offer[]): Offer | undefined {
  return offers.find((o) => o.status === 'accepted') ?? offers[0]
}

/** Candidate profile block: background check status and Fair Chance steps (admin), cleared yes/no (manager). */
export function CandidateBackground({ applicationId }: { applicationId: ID }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const app = db.applications.find((a) => a.id === applicationId)
  if (!app || !canSeeOffer(viewer, db, app)) return null
  const job = db.jobs.find((j) => j.id === app.jobId)
  const offer = checkOffer(offersFor(db, app.id))
  const bg = offer?.backgroundCheck
  const required = !!job?.backgroundCheck || !!offer?.contingencies.includes('background_check') || !!bg
  const person = offer?.personId ? db.people.find((p) => p.id === offer.personId) : undefined
  const detail = canSeeBackgroundDetail(viewer)

  if (!required) {
    return detail ? (
      <SubPanel title="Background check" icon="shield">
        <p className="text-[13.5px] text-ink-2">Not required for this role.</p>
      </SubPanel>
    ) : null
  }
  // Earlier hires recorded before checks were tracked on the offer.
  if (app.status === 'hired' && !bg) {
    if (!person?.backgroundCheck) return null
    return (
      <SubPanel title="Background check" icon="shield">
        <Badge tone={person.backgroundCheck.status === 'clear' ? 'good' : 'neutral'}>
          {person.backgroundCheck.status === 'clear' ? `Clear${person.backgroundCheck.completedOn ? `, ${fmtDay(person.backgroundCheck.completedOn)}` : ''}` : person.backgroundCheck.status === 'pending' ? 'Pending' : 'Not required'}
        </Badge>
      </SubPanel>
    )
  }

  const step = backgroundStep(app.conditionalOfferOn, bg)

  if (!detail) {
    const cleared = offer ? contingenciesCleared(offer) : false
    return (
      <SubPanel title="Contingencies" icon="shield">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[14px] text-ink-2">Contingencies cleared:</span>
          <Badge tone={cleared ? 'good' : 'neutral'} icon={cleared ? 'check' : 'clock'}>
            {cleared ? 'Yes' : 'No'}
          </Badge>
        </div>
        <p className="mt-1.5 text-[13px] text-ink-3">
          {step === 'locked' ? 'The background check starts after the candidate accepts the offer.' : 'Admin runs the background check. Details stay with Admin.'}
        </p>
      </SubPanel>
    )
  }

  if (step === 'locked' || !offer) {
    return (
      <SubPanel title="Background check" icon="lock" actions={<Badge tone="outline" icon="lock">Locked</Badge>}>
        <p className="text-[14px] text-ink-2">{criminalHistoryLockReason(app)}</p>
        <p className="mt-1.5 text-[13.5px] text-ink-3">
          Nothing about convictions can be asked or recorded before then. After acceptance, consent and the disclosures go through your vendor, and any result that gives you pause runs through the Fair Chance steps. First Twenty holds every company to this rule, whatever its size.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <CitationChip label={FCA.label} url={FCA.url} />
          <span className="text-[12.5px] text-ink-3">{NOT_LEGAL_ADVICE}</span>
        </div>
      </SubPanel>
    )
  }

  return <AdminCheck offer={offer} bg={bg} step={step} />
}

function AdminCheck({ offer, bg, step }: { offer: Offer; bg: BackgroundCheck | undefined; step: ReturnType<typeof backgroundStep> }) {
  const db = useDB((s) => s.db)
  const date = today()
  const name = candidateName(db, offer.candidateId)
  const job = db.jobs.find((j) => j.id === offer.jobId)
  const vendor = db.company.linkOuts.backgroundCheck
  const cleared = checkCleared(bg)
  const consentDone = !!bg?.consentSentOn || step === 'in_progress' || step === 'clear' || step === 'consider'
  const progressDone = step === 'in_progress' || step === 'clear' || step === 'consider'
  const resultDone = step === 'clear' || step === 'consider'

  const start = () => {
    const res = act(`Started the background check for ${name}`, (d) => startBackgroundCheck(d, offer.id, { date }))
    const credit = res?.value && res.value.ok ? res.value.creditNotice : undefined
    if (credit) toast({ text: `Added a task: send ${name} the written credit check notice first`, tone: 'neutral' })
  }
  const markInProgress = () =>
    act(`Marked the background check for ${name} in progress`, (d) => {
      const o = d.offers.find((x) => x.id === offer.id)
      if (!o?.backgroundCheck || o.backgroundCheck.status !== 'consent_sent') return false
      o.backgroundCheck.status = 'in_progress'
      logActivity(d, { entityType: 'offer', entityId: o.id, relatedId: o.candidateId, kind: 'background_check_progress', text: `Background check in progress for ${name}` })
      return true
    })
  const record = (result: 'clear' | 'consider') =>
    act(result === 'clear' ? `Recorded a clear background check for ${name}` : `Recorded Consider for ${name}: Fair Chance steps opened`, (d) => {
      const r = recordBackgroundResult(d, offer.id, result, { date })
      if (!r.ok) return r
      // Already hired (Pre-start): keep the person record and onboarding task in step.
      const o = d.offers.find((x) => x.id === offer.id)
      const p = o?.personId ? d.people.find((x) => x.id === o.personId) : undefined
      if (p && result === 'clear') {
        p.backgroundCheck = { status: 'clear', completedOn: date }
        const ck = d.checklists.find((c) => c.personId === p.id && c.kind === 'onboarding')
        const task = ck?.tasks.find((t) => t.templateTaskId === TASK_IDS.backgroundCheck && t.status === 'open')
        if (ck && task) setTaskStatus(d, ck.id, task.id, 'done', { date, byId: currentActorId(d), note: 'Background check clear.' })
      }
      return r
    })

  return (
    <SubPanel
      title="Background check"
      icon="shield"
      actions={
        cleared ? (
          <Badge tone="good" icon="check">
            Clear{bg?.completedOn ? `, ${fmtDay(bg.completedOn)}` : ''}
          </Badge>
        ) : step === 'consider' ? (
          <Badge tone="warn">Consider: Fair Chance steps</Badge>
        ) : (
          <Badge tone="neutral">Conditional offer {offer.decidedOn ? fmtDay(offer.decidedOn) : ''}</Badge>
        )
      }
    >
      <ol className="flex flex-col gap-3">
        <StepRow n={1} done={consentDone} title="Consent and disclosures" detail={bg?.consentSentOn ? `Sent ${fmtDay(bg.consentSentOn)}` : 'The FCRA and ICRAA disclosures and consent go through your background check vendor.'}>
          {!consentDone && (
            <>
              {vendor && (
                <a href={vendor} target="_blank" rel="noreferrer noopener" className="ft-btn ft-btn--secondary ft-btn--sm inline-flex h-10 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-[13.5px] font-semibold text-ink hover:bg-surface-2">
                  Open the vendor
                  <Icon name="external" size={13} className="ft-btn__icon ft-btn__icon--right" />
                </a>
              )}
              <Button size="sm" variant="primary" onClick={start}>
                Mark consent sent
              </Button>
            </>
          )}
        </StepRow>
        <StepRow n={2} done={progressDone} title="In progress" detail={progressDone ? 'The vendor is running the check.' : 'Mark it once the candidate has given consent.'}>
          {consentDone && !progressDone && (
            <Button size="sm" onClick={markInProgress}>
              Mark in progress
            </Button>
          )}
        </StepRow>
        <StepRow n={3} done={resultDone} title="Result" detail={resultDone ? `${step === 'clear' ? 'Clear' : 'Consider'}${bg?.completedOn ? `, ${fmtDay(bg.completedOn)}` : ''}. Status only: the report stays with the vendor.` : 'Record Clear or Consider only. Never upload or paste the report.'}>
          {consentDone && !resultDone && (
            <>
              <Button size="sm" variant="primary" icon="check" onClick={() => record('clear')}>
                Clear
              </Button>
              <Button size="sm" onClick={() => record('consider')}>
                Consider
              </Button>
            </>
          )}
        </StepRow>
      </ol>
      {job?.creditCheckBasis && (
        <p className="mt-3 text-[13px] text-ink-3">
          Credit check basis: {creditCheckBasisLabel(job.creditCheckBasis)}. Send the written notice before ordering a credit report.
        </p>
      )}
      {step === 'consider' && bg && <FairChanceStepper offer={offer} bg={bg} />}
    </SubPanel>
  )
}

function StepRow({ n, done, title, detail, children }: { n: number; done: boolean; title: string; detail: string; children?: ReactNode }) {
  return (
    <li className="flex flex-wrap items-start gap-3">
      <span
        className={cx('ft-checkmark', done ? 'ft-checkmark--done' : 'ft-checkmark--open', 'num inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px] font-bold', done ? 'bg-good text-white' : 'bg-surface-2 text-ink-2')}
        aria-hidden
      >
        {done ? <Icon name="check" size={15} strokeWidth={2.6} /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[14.5px] font-bold text-ink">
          {title} <span className="sr-only">{done ? '(done)' : '(open)'}</span>
        </p>
        <p className="text-[13.5px] text-ink-2">{detail}</p>
        {children && <div className="mt-2 flex flex-wrap items-center gap-2 empty:hidden">{children}</div>}
      </div>
    </li>
  )
}

function FairChanceStepper({ offer, bg }: { offer: Offer; bg: BackgroundCheck }) {
  const db = useDB((s) => s.db)
  const date = today()
  const name = candidateName(db, offer.candidateId)
  const steps = fairChanceSteps(bg, dbHolidays(db))
  const fc = bg.fairChance ?? {}
  const [note, setNote] = useState(fc.assessmentNote ?? '')
  const [method, setMethod] = useState<'email' | 'mail' | 'hand'>('email')
  const [reason, setReason] = useState('')
  const decided = fc.decision

  const fair = (label: string, patch: Parameters<typeof updateFairChance>[2]) => {
    const res = act(label, (d) => updateFairChance(d, offer.id, patch, { date }))
    const warnings = res?.value && res.value.ok ? res.value.warnings : undefined
    if (warnings?.length) toast({ text: warnings.join(' '), tone: 'neutral' })
  }
  const decide = (decision: 'proceed' | 'rescind') =>
    act(decision === 'proceed' ? `Confirmed the offer for ${name} after the Fair Chance review` : `Rescinded the offer for ${name} after the Fair Chance review`, (d) =>
      decideFairChance(d, offer.id, decision, { date, ...(reason.trim() ? { reason: reason.trim() } : {}) }),
    )

  const actionFor = (s: FairChanceStep) => {
    if (decided) return null
    switch (s.key) {
      case 'assessment':
        return s.done ? null : (
          <div className="flex w-full flex-col gap-2">
            <Field label="Assessment note" hint="Short reasoning only: the factors you weighed for this job. Never paste the report.">
              {(id, describedBy) => <TextArea id={id} rows={3} maxLength={NOTE_MAX_CHARS} aria-describedby={describedBy} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
            <div>
              <Button size="sm" variant="primary" disabled={!note.trim()} onClick={() => fair(`Recorded the Fair Chance assessment for ${name}`, { assessmentOn: date, assessmentNote: note.trim() })}>
                Record assessment today
              </Button>
            </div>
          </div>
        )
      case 'preliminary_notice':
        return s.done ? null : (
          <div className="flex w-full flex-col gap-2">
            <ChipGroup
              size="sm"
              label="How the notice goes out"
              value={method}
              onChange={setMethod}
              options={[
                { value: 'email', label: 'Email' },
                { value: 'mail', label: 'Mail' },
                { value: 'hand', label: 'By hand' },
              ]}
            />
            {method === 'mail' && <p className="text-[12.5px] text-ink-3">A mailed notice counts as received 5 calendar days later, so the response window starts then.</p>}
            <div>
              <Button size="sm" variant="primary" onClick={() => fair(`Recorded the preliminary notice to ${name}`, { preliminaryNoticeOn: date, preliminaryNoticeMethod: method })}>
                Record notice sent today
              </Button>
            </div>
          </div>
        )
      case 'response_window':
        return fc.preliminaryNoticeOn && !fc.disputed && !fc.finalNoticeOn ? (
          <Button size="sm" onClick={() => fair(`Recorded that ${name} disputes the report`, { disputed: true })}>
            Candidate disputes the report
          </Button>
        ) : null
      case 'final_notice': {
        if (s.done || !fc.preliminaryNoticeOn) return null
        const early = !!s.notBefore && date < s.notBefore
        return early ? (
          <span className="text-[13px] text-ink-3">Not before {fmtDay(s.notBefore)}</span>
        ) : (
          <Button size="sm" onClick={() => fair(`Recorded the final notice to ${name}`, { finalNoticeOn: date })}>
            Record final notice sent today
          </Button>
        )
      }
      default:
        return null
    }
  }

  return (
    <section aria-labelledby="fc-title" className="mt-5 rounded-xl border border-line px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id="fc-title" className="text-[15px] font-bold text-ink">
          Fair Chance steps
        </h4>
        <CitationChip label={FCA.label} url={FCA.url} />
      </div>
      <p className="mt-1 text-[13px] text-ink-3">Each step has a computed date. The response window is a legal minimum; the other dates are suggested targets. {NOT_LEGAL_ADVICE}</p>
      <ol className="mt-3 flex flex-col gap-4">
        {steps.map((s, i) => (
          <li key={s.key} className="flex gap-3">
            <span className={cx('ft-checkmark', s.done ? 'ft-checkmark--done' : 'ft-checkmark--open', 'num mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px] font-bold', s.done ? 'bg-good text-white' : 'bg-surface-2 text-ink-2')} aria-hidden>
              {s.done ? <Icon name="check" size={15} strokeWidth={2.6} /> : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[14.5px] font-bold text-ink">{s.title}</p>
                {s.done ? (
                  <Badge tone="good">Done{s.doneOn ? ` ${fmtDay(s.doneOn)}` : ''}</Badge>
                ) : s.dueOn ? (
                  <Badge tone={s.statutory ? 'warn' : 'neutral'} icon="clock">
                    {s.key === 'final_notice' ? 'Earliest' : s.statutory ? 'Wait until' : 'Target'} {fmtDay(s.dueOn)}
                  </Badge>
                ) : null}
                {s.statutory && !s.done && <span className="text-[12px] font-semibold text-ink-3">Legal minimum</span>}
              </div>
              <p className="mt-0.5 text-[13.5px] text-ink-2">{s.why}</p>
              {s.key === 'assessment' && s.done && fc.assessmentNote && <p className="mt-1 rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-ink-2">{fc.assessmentNote}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-2">{actionFor(s)}</div>
            </div>
          </li>
        ))}
      </ol>
      {decided ? (
        <Callout className="mt-4" tone={decided === 'proceed' ? 'good' : 'neutral'} title={decided === 'proceed' ? 'Offer confirmed after the Fair Chance review' : 'Offer rescinded after the Fair Chance review'} />
      ) : (
        <div className="mt-4 flex flex-col gap-2 border-t border-line pt-3">
          <Field label="Decision reason" hint="Logged on the offer's history.">
            {(id, describedBy) => <TextInput id={id} aria-describedby={describedBy} maxLength={NOTE_MAX_CHARS} value={reason} onChange={(e) => setReason(e.target.value)} />}
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" icon="check" onClick={() => decide('proceed')}>
              Proceed with the offer
            </Button>
            {fc.finalNoticeOn ? (
              <ConfirmButton disabled={!reason.trim()} onConfirm={() => decide('rescind')} confirmLabel="Press again to rescind">
                Rescind the offer
              </ConfirmButton>
            ) : (
              <span className="self-center text-[13px] text-ink-3">Rescinding opens after the final notice.</span>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
