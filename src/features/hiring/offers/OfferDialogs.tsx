// Small dialogs on an offer: declined (reason chips, optionally keeping the application open for a
// better offer), rescind or discard (reason, confirm), request changes (Admin). Notes are capped
// (NOTE_MAX_CHARS) so the offer record always fits in one sync.
import { useState } from 'react'
import { useViewer } from '@/app/useViewer'
import { markDeclined, requestOfferChanges, rescindOffer } from '@/domain/hiring/offers'
import { candidateName, isOutcomeReason } from '@/domain/hiring/util'
import type { ID, OutcomeReason } from '@/domain/types'
import { nowISO, today } from '@/lib/dates'
import { useDB } from '@/store/db'
import { Button, Checkbox, ChipGroup, ConfirmButton, Field, Modal, TextArea } from '@/ui'
import { act, DICTATION_HINT } from '../interviews/common'
import { NOTE_MAX_CHARS, noteCountText } from '../logic'
import { declineReasonChoices, rescindReasonChoices } from './logic'

type DialogProps = { offerId: ID; onClose: () => void; returnFocus?: () => HTMLElement | null | undefined }

/** A dialog's note box: capped length, with a character count once it gets close. */
function NoteBox({ label, hint, rows, value, onChange }: { label: string; hint: string; rows: number; value: string; onChange: (v: string) => void }) {
  const count = noteCountText(value)
  return (
    <Field label={label} hint={count ? `${hint} ${count}.` : hint}>
      {(id, describedBy) => <TextArea id={id} rows={rows} maxLength={NOTE_MAX_CHARS} aria-describedby={describedBy} value={value} onChange={(e) => onChange(e.target.value)} />}
    </Field>
  )
}

export function DeclineModal({ offerId, onClose, returnFocus }: DialogProps) {
  const db = useDB((s) => s.db)
  const offer = db.offers.find((o) => o.id === offerId)
  const [reason, setReason] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [closeApp, setCloseApp] = useState(true)
  if (!offer) return null
  const name = candidateName(db, offer.candidateId)
  // Backing out after accepting always closes the application: its conditional offer date stays on it.
  const backedOut = offer.status === 'accepted'
  const closes = backedOut || closeApp
  // Only options still reserved go back to the pool now: an expired offer released its own at expiry.
  const reserved = db.grants.some((g) => g.fromOfferId === offer.id && g.status === 'reserved')
  const pool = reserved ? 'The reserved options go back to the pool' : ''
  const save = () => {
    if (!reason) return
    const outcome: OutcomeReason = isOutcomeReason(reason) ? reason : reason.startsWith('Counteroffer') ? 'chose_other_offer' : 'other'
    const label = backedOut ? `Recorded that ${name} backed out` : `Recorded that ${name} declined the offer`
    const res = act(label, (d) =>
      markDeclined(d, offer.id, reason, { date: today(), outcomeReason: outcome, closeApplication: closes, ...(note.trim() ? { note: note.trim() } : {}) }),
    )
    if (res) onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      {...(returnFocus ? { returnFocus } : {})}
      title={backedOut ? `${name} backed out` : `${name} declined`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!reason} onClick={save}>
            Record decline
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-[14px] text-ink-2">
          {closes
            ? `${pool ? `${pool} and the application` : 'The application'} closes as withdrawn. You can undo this.`
            : `${pool ? `${pool}. ` : ''}The application stays open, so you can make a new offer. You can undo this.`}
        </p>
        <ChipGroup label="Reason" value={reason} onChange={setReason} options={declineReasonChoices()} />
        <NoteBox label="Details" hint={`For example the competing company or what would have changed their mind. ${DICTATION_HINT}`} rows={3} value={note} onChange={setNote} />
        {!backedOut && (
          <Checkbox checked={closeApp} onChange={setCloseApp} label="Also close the application" description="Withdrawn with the reason above. Leave it open to make a better offer." />
        )}
      </div>
    </Modal>
  )
}

export function RescindModal({ offerId, onClose, returnFocus }: DialogProps) {
  const db = useDB((s) => s.db)
  const offer = db.offers.find((o) => o.id === offerId)
  const [reason, setReason] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [closeApp, setCloseApp] = useState(true)
  if (!offer) return null
  const name = candidateName(db, offer.candidateId)
  // Never sent: the candidate never had it, so it is discarded, not rescinded.
  const unsent = !offer.sentOn && (offer.status === 'draft' || offer.status === 'awaiting_approval' || offer.status === 'approved')
  // Stored as one sentence pair ('Offer made in error. Hours were wrong: ...'); the panel adds 'Rescinded <day>: '.
  const fullReason = [reason, note.trim()].filter(Boolean).join('. ')
  const save = () => {
    if (!fullReason) return
    const res = act(unsent ? `Discarded the draft offer for ${name}` : `Rescinded the offer for ${name}`, (d) =>
      rescindOffer(d, offer.id, { date: today(), reason: fullReason, closeApplication: unsent ? false : closeApp }),
    )
    if (res) onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      {...(returnFocus ? { returnFocus } : {})}
      title={unsent ? `Discard the draft offer for ${name}?` : `Rescind the offer for ${name}?`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep the offer
          </Button>
          {unsent ? (
            <Button variant="primary" disabled={!fullReason} onClick={save}>
              Discard draft
            </Button>
          ) : (
            <ConfirmButton disabled={!fullReason} onConfirm={save} confirmLabel="Press again to rescind">
              Rescind offer
            </ConfirmButton>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {unsent ? (
          <p className="text-[14px] text-ink-2">{name} never received this draft. It shows as Discarded, with your reason, and the application stays open for a new offer.</p>
        ) : (
          <p className="text-[14px] text-ink-2">
            The candidate has this offer. Rescinding releases the reserved options. Talk to them first, and if the reason is a background check result, finish the Fair Chance steps instead.
          </p>
        )}
        <ChipGroup label="Reason" value={reason} onChange={setReason} options={rescindReasonChoices().map((r) => ({ value: r, label: r }))} />
        <NoteBox label="Details" hint="Shown on the offer with the reason." rows={2} value={note} onChange={setNote} />
        {!unsent && <Checkbox checked={closeApp} onChange={setCloseApp} label="Also close the application" description="Rejected with the reason above. Leave it open to make a new offer." />}
      </div>
    </Modal>
  )
}

export function RequestChangesModal({ offerId, onClose, returnFocus }: DialogProps) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const offer = db.offers.find((o) => o.id === offerId)
  const [chip, setChip] = useState<string | null>(null)
  const [note, setNote] = useState('')
  if (!offer) return null
  const name = candidateName(db, offer.candidateId)
  const text = [chip, note.trim()].filter(Boolean).join('. ')
  const save = () => {
    if (!text || !viewer.personId) return
    const approverId = viewer.personId
    const res = act(`Asked for changes to the offer for ${name}`, (d) => requestOfferChanges(d, offer.id, { approverId, at: nowISO(), note: text }))
    if (res) onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      {...(returnFocus ? { returnFocus } : {})}
      title={`Ask for changes: ${name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!text} onClick={save}>
            Send back to draft
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <ChipGroup
          label="What to change"
          value={chip}
          onChange={setChip}
          options={['Bring base inside the band', 'Lower the equity', 'Move the start date', 'Fix the level'].map((r) => ({ value: r, label: r }))}
        />
        <NoteBox label="Note to the drafter" hint={DICTATION_HINT} rows={3} value={note} onChange={setNote} />
      </div>
    </Modal>
  )
}
