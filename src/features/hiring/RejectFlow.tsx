// Reject or Withdraw: one reason chip closes the application (with Undo), then the notify step offers
// a stage-aware note (kind or brief, signed by the founder) to copy or open in the mail app, which
// stamps Notified on the timeline. Final-round rejections suggest a call instead. Two taps total.
import { useEffect, useRef, useState } from 'react'
import {
  candidateName,
  markNotified,
  openOffer,
  outcomeReasonLabel,
  quickLog,
  rejectApplication,
  rejectionMessage,
  stageById,
  withdrawApplication,
} from '@/domain/hiring'
import type { ID, OutcomeReason } from '@/domain/types'
import { mailtoHref } from '@/lib/email'
import { copyText } from '@/lib/files'
import { nowISO, today } from '@/lib/dates'
import { useDB } from '@/store/db'
import { Button, Callout, ChipGroup, Field, focusFirstInvalid, Icon, IconButton, Modal, Segmented, TextArea, toast } from '@/ui'
import { commit } from './actions'
import { candidateOfferOn, NOTE_MAX_CHARS, rejectReasons, textIssueError, textIssues, withdrawalMessage, withdrawReasons } from './logic'
import { TextIssueNotes } from './parts'

export type RejectResult = { closed: boolean; notified: boolean }

export function RejectFlow({
  appId,
  mode,
  startAt = 'reason',
  onClose,
}: {
  appId: ID | null
  mode: 'reject' | 'withdraw'
  /** 'notify' skips straight to the note (the application is already closed). */
  startAt?: 'reason' | 'notify'
  onClose: (result: RejectResult) => void
}) {
  if (!appId) return null
  return <RejectFlowInner key={`${appId}-${mode}-${startAt}`} appId={appId} mode={mode} startAt={startAt} onClose={onClose} />
}

function RejectFlowInner({
  appId,
  mode,
  startAt,
  onClose,
}: {
  appId: ID
  mode: 'reject' | 'withdraw'
  startAt: 'reason' | 'notify'
  onClose: (result: RejectResult) => void
}) {
  const db = useDB((s) => s.db)
  const app = db.applications.find((a) => a.id === appId)
  const job = app && db.jobs.find((j) => j.id === app.jobId)
  const name = app ? candidateName(db, app.candidateId) : 'Candidate'
  const [step, setStep] = useState<'reason' | 'notify'>(startAt)
  const [closed, setClosed] = useState(startAt === 'notify')
  const [note, setNote] = useState('')
  const [tone, setTone] = useState<'kind' | 'brief'>('kind')
  const isWithdraw = mode === 'withdraw' || app?.status === 'withdrawn'

  const withdrawNote = app && isWithdraw ? withdrawalMessage(db, app.id) : null
  const message = !app ? null : isWithdraw ? (withdrawNote ? { ...withdrawNote, suggestCall: false } : null) : rejectionMessage(db, app.id, { tone })
  const [body, setBody] = useState<string | null>(null)
  const copyRef = useRef<HTMLButtonElement>(null)
  // Moving to the notify step puts focus on Copy note (one more tap finishes the job).
  useEffect(() => {
    if (step === 'notify') requestAnimationFrame(() => copyRef.current?.focus())
  }, [step])
  const text = body ?? message?.body ?? ''

  if (!app || !job) return null
  const stage = stageById(job, app.stageId)
  const offer = openOffer(db, app.id)
  const reasons = mode === 'withdraw' ? withdrawReasons(db) : rejectReasons(db)

  const finish = (notified: boolean) => onClose({ closed, notified })
  const noteIssues = textIssues(note, { conditionalOfferOn: candidateOfferOn(db, app.candidateId) })
  const noteError = textIssueError(noteIssues)

  const pickReason = (r: OutcomeReason) => {
    if (noteError) {
      toast({ text: `${name} is not closed yet. ${noteError}`, tone: 'bad' })
      focusFirstInvalid()
      return
    }
    const opts = { date: today(), nowISO: nowISO(), ...(note.trim() ? { note: note.trim() } : {}) }
    const label = mode === 'withdraw' ? `${name} withdrew${r === 'withdrew' ? '' : ` (${outcomeReasonLabel(r).toLowerCase()})`}` : `Rejected ${name} (${outcomeReasonLabel(r).toLowerCase()})`
    const ok = commit(label, (d) => (mode === 'withdraw' ? withdrawApplication(d, appId, r, opts) : rejectApplication(d, appId, r, opts)))
    if (!ok) {
      toast({ text: `${name} could not be closed. A hired application stays on record as hired.`, tone: 'bad' })
      return
    }
    setClosed(true)
    setStep('notify')
  }

  const markTold = (how: 'copied' | 'mail' | 'other' | 'call') => {
    const label = how === 'call' ? `Logged a call and marked ${name} notified` : `Marked ${name} notified`
    commit(label, (d) => {
      if (how === 'call') quickLog(d, appId, 'called', { date: today() })
      return markNotified(d, appId, { date: today() })
    })
    finish(true)
  }

  const copyNote = async () => {
    const ok = await copyText(text)
    if (!ok) {
      toast({ text: 'Copy was blocked by the browser. Select the note and copy it by hand.', tone: 'bad' })
      return
    }
    markTold('copied')
  }

  const title = step === 'reason' ? (mode === 'withdraw' ? `${name} withdrew` : `Reject ${name}`) : `Tell ${name}`

  return (
    <Modal
      open
      onClose={() => finish(false)}
      title={title}
      width={600}
      footer={
        step === 'notify' ? (
          <>
            <Button variant="ghost" onClick={() => finish(false)}>
              Skip for now
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={() => finish(false)}>
            Cancel
          </Button>
        )
      }
    >
      {step === 'reason' ? (
        <div className="flex flex-col gap-4">
          <p className="text-[14px] text-ink-2">
            {job.title}, {stage?.name ?? 'stage'}. Pick one reason; you can undo it.
          </p>
          {offer && (
            <Callout tone="warn" title="This closes the open offer">
              The {offer.status === 'draft' || offer.status === 'awaiting_approval' ? 'unsent' : offer.status} offer will be {mode === 'withdraw' ? 'marked declined' : 'rescinded'}, and its reserved options go back to the pool.
            </Callout>
          )}
          <Field label="Private note (optional)" hint="Kept on the record, never sent. No pay history." error={noteError}>
            {(id, hint) => <TextArea id={id} aria-describedby={hint} rows={2} maxLength={NOTE_MAX_CHARS} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
          <TextIssueNotes issues={noteIssues} />
          <div>
            <p className="mb-2 text-[13.5px] font-semibold text-ink-2">
              Reason
            </p>
            <ChipGroup<OutcomeReason>
              label="Reason"
              value={null}
              onChange={pickReason}
              options={reasons.map((r) => ({ value: r, label: outcomeReasonLabel(r) }))}
            />
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {closed && (
            <p className="text-[14px] text-ink-2">
              {name} is {isWithdraw ? 'marked withdrawn' : 'rejected'} for {job.title}. Send a short note so nobody is left waiting.
            </p>
          )}
          {message?.suggestCall && (
            <Callout tone="accent" icon="phone" title="Final round: a call is kinder">
              {name} met the team. Consider calling before (or instead of) the email.
              <div className="mt-2">
                <Button size="sm" icon="phone" onClick={() => markTold('call')}>
                  I called them
                </Button>
              </div>
            </Callout>
          )}
          {!isWithdraw && (
            <Segmented
              label="Tone"
              value={tone}
              onChange={(t) => {
                setTone(t)
                setBody(null)
              }}
              options={[
                { value: 'kind', label: 'Kind' },
                { value: 'brief', label: 'Brief' },
              ]}
            />
          )}
          {message && (
            <>
              <div className="flex flex-wrap gap-2">
                <Button ref={copyRef} variant="primary" size="lg" icon="copy" onClick={copyNote}>
                  Copy note
                </Button>
                {message.to && (
                  <a
                    href={mailtoHref(message.to, message.subject, text)}
                    onClick={() => markTold('mail')}
                    className="ft-btn ft-btn--secondary ft-btn--lg inline-flex h-12 items-center gap-2 rounded-xl border border-line-strong bg-surface px-5 text-[15.5px] font-semibold text-ink hover:bg-surface-2"
                  >
                    <Icon name="mail" size={18} className="ft-btn__icon" />
                    Open in mail app
                  </a>
                )}
                <Button size="lg" variant="ghost" icon="check" onClick={() => markTold('other')}>
                  Mark notified
                </Button>
              </div>
              <p className="-mt-2 text-[12.5px] text-ink-3">Copy or open marks {name} notified on the timeline. Mark notified if you told them another way.</p>
              <div className="flex items-center gap-2 text-[13.5px]">
                <span className="font-semibold text-ink-3">To</span>
                <span className="min-w-0 truncate text-ink">{message.to || 'No email on file'}</span>
              </div>
              <div className="flex items-center gap-2 text-[13.5px]">
                <span className="font-semibold text-ink-3">Subject</span>
                <span className="min-w-0 flex-1 truncate text-ink">{message.subject}</span>
                <IconButton
                  icon="copy"
                  size="sm"
                  label="Copy subject"
                  onClick={async () => toast((await copyText(message.subject)) ? 'Subject copied' : { text: 'Copy was blocked by the browser.', tone: 'bad' })}
                />
              </div>
              <Field label="Note" hint="Edit before you send. Nothing is sent from this app.">
                {(id, hint) => <TextArea id={id} aria-describedby={hint} rows={7} maxLength={NOTE_MAX_CHARS} value={text} onChange={(e) => setBody(e.target.value)} />}
              </Field>
            </>
          )}
        </div>
      )}
    </Modal>
  )
}
