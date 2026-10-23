// Scorecard form: one tap per attribute on a 4-point scale (no neutral), overall defaulted from the
// attributes, optional notes. Admins can enter one on an interviewer's behalf ('Entered by').
import { useMemo, useState } from 'react'
import { useViewer } from '@/app/useViewer'
import { canSeeApplication } from '@/domain/access'
import { formatDual } from '@/domain/hiring/scheduling'
import { overallSuggestion, submitScorecard } from '@/domain/hiring/scorecards'
import { candidateName, lowerFirst } from '@/domain/hiring/util'
import { fullName, personNameById } from '@/domain/people'
import type { Attribute, DB, ID, Rating, Scorecard } from '@/domain/types'
import { fmtDateTime, nowISO } from '@/lib/dates'
import { useDB } from '@/store/db'
import { Badge, Button, Callout, cx, Field, focusFirstInvalid, rovingKeyDown, rovingTabIndex, Sheet, TextArea } from '@/ui'
import { act, DICTATION_HINT, InvalidChips } from './common'
import { ratingWord } from './logic'
import { candidateOfferOn, NOTE_MAX_CHARS, textIssueError, textIssues } from '../logic'
import { TextIssueNotes } from '../parts'

const RATINGS: Rating[] = [1, 2, 3, 4]

/** Four large buttons: Strong no, No, Yes, Strong yes. */
export function RatingPicker({
  value,
  onChange,
  label,
  suggested,
}: {
  value: Rating | null | undefined
  onChange: (r: Rating) => void
  label: string
  /** Marks the suggested rating when nothing is picked by hand. */
  suggested?: boolean
}) {
  return (
    // One Tab stop per group; arrows, Home and End move focus, and Space or Enter picks (moving
    // focus never changes a rating by itself).
    <div role="radiogroup" aria-label={label} onKeyDown={(e) => rovingKeyDown(e)} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {RATINGS.map((r, i) => {
        const on = value === r
        return (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={rovingTabIndex(i, RATINGS.map((x) => ({ on: x === value })))}
            onClick={() => onChange(r)}
            className={cx(
              'inline-flex h-12 items-center justify-center rounded-xl border px-3 text-[15px] font-bold transition-colors',
              on
                ? suggested
                  ? 'border-accent bg-accent-soft text-accent-soft-ink ring-2 ring-accent/40'
                  : 'border-accent bg-accent text-accent-ink'
                : 'border-line-strong bg-surface text-ink-2 hover:border-ink-3 hover:text-ink',
            )}
          >
            {ratingWord(r)}
          </button>
        )
      })}
    </div>
  )
}

/** Anchors for an interview's attributes, from the job's interview plan. */
export function attributeAnchors(db: DB, applicationId: ID, stepId?: ID): Map<string, Attribute> {
  const app = db.applications.find((a) => a.id === applicationId)
  const job = app ? db.jobs.find((j) => j.id === app.jobId) : undefined
  const out = new Map<string, Attribute>()
  if (!job) return out
  const step = job.interviewPlan.find((s) => s.id === stepId)
  for (const a of step?.attributes ?? []) out.set(a.name, a)
  for (const s of job.interviewPlan) for (const a of s.attributes) if (!out.has(a.name)) out.set(a.name, a)
  return out
}

export function ScorecardSheet({ scorecardId, open, onClose }: { scorecardId: ID | null; open: boolean; onClose: () => void }) {
  return open && scorecardId ? <ScorecardForm key={scorecardId} scorecardId={scorecardId} onClose={onClose} /> : null
}

function ScorecardForm({ scorecardId, onClose }: { scorecardId: ID; onClose: () => void }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const sc = db.scorecards.find((s) => s.id === scorecardId)
  const interview = sc ? db.interviews.find((i) => i.id === sc.interviewId) : undefined
  const app = sc ? db.applications.find((a) => a.id === sc.applicationId) : undefined
  const anchors = useMemo(() => (sc ? attributeAnchors(db, sc.applicationId, interview?.stepId) : new Map<string, Attribute>()), [db, sc, interview?.stepId])
  const [ratings, setRatings] = useState<Record<string, Rating>>(() => ({ ...(sc?.ratings ?? {}) }))
  const [manualOverall, setManualOverall] = useState<Rating | null>(sc?.submittedAt ? (sc.overall ?? null) : null)
  const [notes, setNotes] = useState(sc?.notes ?? '')
  const [tried, setTried] = useState(false)

  if (!sc || !interview || !app) {
    return (
      <Sheet open onClose={onClose} title="Scorecard">
        <p className="text-[14px] text-ink-2">This scorecard is no longer on file. The interview may have been cancelled.</p>
      </Sheet>
    )
  }
  const own = viewer.personId === sc.interviewerId
  const onBehalf = !own && viewer.role === 'admin'
  const allowed = (own || onBehalf) && canSeeApplication(viewer, db, app)
  const name = candidateName(db, app.candidateId)
  const interviewer = personNameById(db, sc.interviewerId, 'the interviewer')
  const attributes = interview.attributes.length ? interview.attributes : [...anchors.keys()].slice(0, 4)
  const suggestion = overallSuggestion(ratings)
  const overall = manualOverall ?? suggestion
  const rated = attributes.filter((a) => ratings[a]).length
  const issues = textIssues(notes, { conditionalOfferOn: candidateOfferOn(db, app.candidateId) })
  const notesError = textIssueError(issues)
  const submitted = !!sc.submittedAt

  const submit = () => {
    if (!overall || notesError) {
      setTried(true)
      focusFirstInvalid()
      return
    }
    const label = onBehalf ? `Entered ${interviewer}'s scorecard for ${name}` : `Submitted your scorecard for ${name}`
    const res = act(label, (d) =>
      submitScorecard(
        d,
        sc.id,
        { ratings, overall, notes, ...(onBehalf && viewer.personId ? { enteredById: viewer.personId } : {}) },
        nowISO(),
      ),
    )
    if (res) onClose()
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={`Scorecard: ${name}`}
      subtitle={`${interview.name}, ${formatDual(interview.startsAt)}${own ? '' : `. Interviewer: ${interviewer}`}`}
      footer={
        allowed ? (
          <>
            <span className="mr-auto text-[13px] text-ink-3">
              {rated} of {attributes.length} rated
            </span>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" size="lg" icon="check" onClick={submit}>
              {submitted ? 'Save changes' : onBehalf ? 'Submit for them' : 'Submit scorecard'}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Close</Button>
        )
      }
    >
      {!allowed ? (
        <Callout tone="neutral" icon="lock" title="Only the interviewer or Admin can fill this scorecard">
          {interviewer} owes it. Admin can enter it on their behalf, and it is logged as entered by Admin.
        </Callout>
      ) : (
        <div className="flex flex-col gap-6">
          {onBehalf && (
            <Callout tone="accent" icon="edit" title={`Entering for ${interviewer}`}>
              The scorecard is saved under {interviewer} and logged as entered by {viewer.person ? fullName(viewer.person) : 'Admin'}.
            </Callout>
          )}
          {submitted && (
            <p className="text-[13.5px] text-ink-3">
              Submitted {fmtDateTime(sc.submittedAt)}
              {sc.enteredById ? `, entered by ${personNameById(db, sc.enteredById, 'Admin')}` : ''}. Changes replace the earlier answers.
            </p>
          )}
          {attributes.map((attr, i) => {
            const a = anchors.get(attr)
            return (
              <section key={attr} aria-labelledby={`sc-attr-${i}`} className="flex flex-col gap-2">
                <div>
                  <h3 id={`sc-attr-${i}`} className="text-[15px] font-bold text-ink">
                    {attr}
                  </h3>
                  {a?.anchor && <p className="text-[13.5px] text-ink-3">Strong yes looks like: {lowerFirst(a.anchor)}</p>}
                </div>
                <RatingPicker value={ratings[attr]} label={attr} onChange={(r) => setRatings((x) => ({ ...x, [attr]: r }))} />
              </section>
            )
          })}
          <section aria-labelledby="sc-overall" className="flex flex-col gap-2 rounded-xl bg-surface-2 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id="sc-overall" className="text-[15px] font-bold text-ink">
                Overall
              </h3>
              {manualOverall == null && suggestion && <Badge tone="accent">Suggested from your ratings</Badge>}
              {manualOverall != null && suggestion && manualOverall !== suggestion && (
                <button type="button" className="h-10 rounded-lg px-2 text-[13px] font-semibold text-accent hover:bg-accent-soft" onClick={() => setManualOverall(null)}>
                  Use the suggestion ({ratingWord(suggestion)})
                </button>
              )}
            </div>
            <InvalidChips id="sc-overall-pick" error={tried && !overall ? 'Rate at least one attribute, or pick an overall, before you submit.' : null}>
              <RatingPicker value={overall} suggested={manualOverall == null} label="Overall recommendation" onChange={(r) => setManualOverall(r)} />
            </InvalidChips>
            {!overall && !tried && <p className="text-[13px] text-ink-3">Rate at least one attribute, or pick an overall.</p>}
          </section>
          <Field label="Notes" hint={DICTATION_HINT} error={notesError}>
            {(id, describedBy) => (
              <TextArea
                id={id}
                aria-describedby={describedBy}
                rows={4}
                maxLength={NOTE_MAX_CHARS}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="What you saw: evidence for each rating."
              />
            )}
          </Field>
          <TextIssueNotes issues={issues} />
        </div>
      )}
    </Sheet>
  )
}

/** Short status for a scorecard (never the rating, which stays hidden until the viewer may see it). */
export function scorecardState(sc: Scorecard, endsAtISO: string, now: string): { label: string; tone: 'good' | 'warn' | 'neutral' | 'outline' } {
  if (sc.submittedAt) return { label: 'Submitted', tone: 'good' }
  if (endsAtISO > now) return { label: 'After the interview', tone: 'outline' }
  if (sc.dueAt < now) return { label: 'Overdue', tone: 'warn' }
  return { label: 'Due soon', tone: 'neutral' }
}
