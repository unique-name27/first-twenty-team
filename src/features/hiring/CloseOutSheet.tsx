// Bulk close-out when a job fills: copy the BCC list and a close-out note, then close every remaining
// active candidate as 'position filled' and archive them (never delete; records are kept 4 years).
// The note is addressed to the founder's own work email; without one on file the To line stays empty
// (BCC only) and the sheet asks for the address.
import { useState } from 'react'
import { useViewer } from '@/app/useViewer'
import { archiveCandidate, closeOutMessage, closeOutRemaining, markNotified } from '@/domain/hiring'
import { founder, fullName } from '@/domain/people'
import type { Job } from '@/domain/types'
import { mailtoHref } from '@/lib/email'
import { copyText } from '@/lib/files'
import { plural } from '@/lib/format'
import { today } from '@/lib/dates'
import { useDB } from '@/store/db'
import { Button, Callout, Field, Sheet, TextArea, toast } from '@/ui'
import { commit } from './actions'
import { missingWorkEmailHint, NOTE_MAX_CHARS, noteCountText } from './logic'

export function CloseOutSheet({ job, open, onClose }: { job: Job; open: boolean; onClose: () => void }) {
  if (!open) return null
  return <CloseOutInner job={job} onClose={onClose} />
}

function CloseOutInner({ job, onClose }: { job: Job; onClose: () => void }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const msg = closeOutMessage(db, job.id)
  const sender = founder(db)
  const emailHint = missingWorkEmailHint(viewer, sender?.id, sender ? fullName(sender) : 'the founder')
  const [body, setBody] = useState(msg?.body ?? '')
  if (!msg) return null
  const active = db.applications.filter((a) => a.jobId === job.id && a.status === 'active' && !a.conditionalOfferOn)
  const n = msg.applicationIds.length
  // Capped like the other note boxes in hiring (the note itself is copied or mailed, never stored).
  const bodyCount = noteCountText(body)

  const copy = async (text: string, what: string) => {
    const ok = await copyText(text)
    toast(ok ? `${what} copied` : { text: 'Copy was blocked by the browser. Select the text and copy it by hand.', tone: 'bad' })
  }

  const closeOut = (notified: boolean) => {
    const t = today()
    const ok = commit(`Closed out ${plural(n, 'candidate')} on ${job.title}`, (d) => {
      const closed = closeOutRemaining(d, job.id, { date: t, notified })
      let told = 0
      if (notified) for (const id of msg.applicationIds) if (markNotified(d, id, { date: t })) told += 1
      for (const id of msg.applicationIds) {
        const app = d.applications.find((a) => a.id === id)
        if (!app) continue
        const stillActive = d.applications.some((a) => a.candidateId === app.candidateId && a.status === 'active')
        if (!stillActive) archiveCandidate(d, app.candidateId, { date: t })
      }
      return closed + told > 0
    })
    if (ok) onClose()
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="Close out the search"
      subtitle={`${job.title}: ${plural(active.length, 'active candidate')} left${n > active.length ? `, ${plural(n - active.length, 'closed candidate')} not told yet` : ''}`}
      width={640}
      footer={
        <>
          <Button variant="ghost" onClick={() => closeOut(false)} disabled={n === 0}>
            Close out without a note
          </Button>
          <Button variant="primary" onClick={() => closeOut(true)} disabled={n === 0}>
            Mark notified and archive {plural(n, 'candidate')}
          </Button>
        </>
      }
    >
      {n === 0 ? (
        <p className="text-[14.5px] text-ink-2">Everyone on this job has heard back. Nothing to close out.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-[14.5px] text-ink-2">
            Send one note with everyone on BCC, then close them out as Position filled. They are archived, never deleted, and kept for 4 years.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button icon="copy" onClick={() => copy(msg.bcc.join(', '), 'BCC list')}>
              Copy BCC list ({msg.bcc.length})
            </Button>
            <Button icon="copy" onClick={() => copy(body, 'Note')}>
              Copy note
            </Button>
            <a
              href={mailtoHref(msg.from, msg.subject, body, { bcc: msg.bcc })}
              className="ft-btn ft-btn--secondary ft-btn--md inline-flex h-11 items-center gap-2 rounded-lg border border-line-strong bg-surface px-4 text-[14.5px] font-semibold text-ink hover:bg-surface-2"
            >
              Open in mail app
            </a>
          </div>
          {!msg.from && (
            <Callout tone="warn" title={emailHint.text}>
              The note goes out with everyone on BCC and nobody on the To line until there is an address to send it from.
              {emailHint.link && (
                <>
                  {' '}
                  <a href={emailHint.link.href} className="-my-2 inline-flex min-h-10 items-center font-semibold text-accent underline">
                    {emailHint.link.label}
                  </a>
                </>
              )}
            </Callout>
          )}
          <p className="text-[13.5px]">
            <span className="font-semibold text-ink-3">Subject: </span>
            <span className="text-ink">{msg.subject}</span>
          </p>
          <Field label="Close-out note" hint={`Edit before you send. Nothing is sent from this app.${bodyCount ? ` ${bodyCount}.` : ''}`} id="closeout-body">
            {(id, hint) => <TextArea id={id} aria-describedby={hint} rows={8} maxLength={NOTE_MAX_CHARS} value={body} onChange={(e) => setBody(e.target.value)} />}
          </Field>
        </div>
      )}
    </Sheet>
  )
}
