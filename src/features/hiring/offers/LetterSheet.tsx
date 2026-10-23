// Generated documents for an offer: the offer letter (print to PDF, copy, e-sign link-out) and the
// Labor Code 2810.5 wage notice (required for non-exempt hires, optional for exempt ones). When the
// pay cannot carry the classification (exempt under the salary floor, pay under the minimum wage),
// neither document is built: the letter would state an exemption or a rate the law does not allow.
// Nor while the start date has passed on an offer not yet accepted: the letter would promise a day that
// is gone. The app does not e-sign or email: the sheet points to the e-sign link-out (Settings) and to
// Mark sent, which records the date.
// While the offer waits for Admin approval (waitingOnApproval), Admin sees both documents marked 'Draft,
// not approved' in the preview, the print and the copied text; anyone else gets a note instead (SPEC:
// Admin approves before an offer goes out). Before it goes out, a work location that no longer matches
// the job is flagged with a one-tap fix, since the letter states it.
import { useRef, useState } from 'react'
import { canApproveOffer, canDraftOffer, canSeeSection } from '@/domain/access'
import { capTableIsPlaceholder } from '@/domain/equity'
import {
  classificationIssues,
  defaultStartDate,
  letterStartIssue,
  moveOfferStart,
  offerLetter,
  offerLocationDrift,
  updateOffer,
  waitingOnApproval,
  wageNotice2810_5,
} from '@/domain/hiring/offers'
import { candidateName, dbHolidays } from '@/domain/hiring/util'
import { NOT_LEGAL_ADVICE } from '@/domain/compliance'
import type { ID } from '@/domain/types'
import { fmtDay, today } from '@/lib/dates'
import { printHTML } from '@/lib/files'
import { links } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { useDB } from '@/store/db'
import { Button, Callout, CitationChip, Private, Segmented, Sheet, toast } from '@/ui'
import { act, copyWithToast } from '../interviews/common'
import { PrivateBlock } from './BandMeter'

export function LetterSheet({ offerId, open, onClose }: { offerId: ID; open: boolean; onClose: () => void }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const offer = db.offers.find((o) => o.id === offerId)
  const nonExempt = offer?.flsa === 'non_exempt'
  const [doc, setDoc] = useState<'letter' | 'notice'>('letter')
  const printRef = useRef<HTMLButtonElement>(null)
  if (!open || !offer) return null
  const date = today()
  const blocked = classificationIssues(db, offer)
  const startIssue = letterStartIssue(offer, date)
  // Not approved yet: Admin previews a marked draft; a hiring manager waits for the approval.
  const notApproved = waitingOnApproval(db, offer, date)
  const withheld = notApproved && !canApproveOffer(viewer)
  const letter = blocked.length || startIssue || withheld ? null : offerLetter(db, offerId, { notApproved })
  const notice = blocked.length || startIssue || withheld ? null : wageNotice2810_5(db, { offerId, notApproved })
  const showing = doc === 'notice' ? notice : letter
  const title = doc === 'notice' ? `${notApproved ? 'Draft, not approved: ' : ''}Notice to employee (Labor Code 2810.5)` : (letter?.subject ?? 'Offer letter')
  const eSign = db.company.linkOuts.eSign
  const unsent = offer.status === 'draft' || offer.status === 'awaiting_approval' || offer.status === 'approved'
  // Before it goes out, the start moves here (an edit); an offer that is out moves it when it is extended.
  const app = db.applications.find((a) => a.id === offer.applicationId)
  const canMove = unsent && !!app && canDraftOffer(viewer, db, app)
  const newStart = defaultStartDate(date, dbHolidays(db))
  const editor = { role: viewer.role, personId: viewer.personId }
  const drift = unsent ? offerLocationDrift(db, offer) : null
  const moveStart = () => {
    const res = act(`Moved the start date for ${candidateName(db, offer.candidateId)} to ${fmtDay(newStart)}`, (d) => moveOfferStart(d, offer.id, newStart, { date, editor }))
    // The button goes away with the problem: the letter is ready to print.
    if (res) requestAnimationFrame(() => printRef.current?.focus())
  }
  const takeJobLocation = () => {
    if (!drift) return
    const res = act(`Moved the offer for ${candidateName(db, offer.candidateId)} to the job's work location`, (d) =>
      updateOffer(d, offer.id, { workMode: drift.workMode, locationId: drift.locationId }, { date, editor }),
    )
    if (res) requestAnimationFrame(() => printRef.current?.focus())
  }

  const print = () => {
    if (!showing) return
    if (!printHTML(title, showing.html)) toast({ text: 'Pop-ups are blocked here. Use Copy text instead.', tone: 'bad' })
  }

  return (
    <Sheet
      open
      onClose={onClose}
      width={760}
      title={doc === 'notice' ? 'Wage notice' : 'Offer letter'}
      subtitle={`Print to PDF, then send it for signature through your e-sign tool. ${unsent ? 'After you send it, use Mark sent on the offer to record the date. ' : ''}The app keeps the status and date, never the file.`}
      footer={
        <>
          {eSign ? (
            <a
              href={eSign}
              target="_blank"
              rel="noreferrer noopener"
              className="mr-auto inline-flex h-11 items-center gap-2 rounded-lg px-3 text-[14px] font-semibold text-accent hover:bg-accent-soft"
            >
              Open e-sign tool
            </a>
          ) : canSeeSection(viewer, 'settings') ? (
            <a href={links.settings('links')} className="ft-link mr-auto inline-flex min-h-11 items-center px-1 text-[14px] font-semibold text-accent underline">
              Add your e-sign tool in Settings &gt; Link-outs
            </a>
          ) : null}
          {withheld ? (
            <Button variant="primary" size="lg" onClick={onClose}>
              Close
            </Button>
          ) : (
            <>
              <Button icon="copy" disabled={!showing} onClick={() => showing && void copyWithToast(showing.text, doc === 'notice' ? 'the wage notice' : 'the offer letter')}>
                Copy text
              </Button>
              <Button ref={printRef} variant="primary" size="lg" icon="printer" disabled={!showing} onClick={print}>
                Print
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Segmented
          label="Document"
          value={doc}
          onChange={setDoc}
          options={[
            { value: 'letter', label: 'Offer letter' },
            { value: 'notice', label: nonExempt ? 'Wage notice (required)' : 'Wage notice (optional)' },
          ]}
        />
        {doc === 'notice' && (
          <Callout tone={nonExempt ? 'warn' : 'neutral'} title={nonExempt ? 'Required for this non-exempt hire' : 'Optional for exempt hires'}>
            <span className="block">Give the Labor Code 2810.5 notice no later than the start date. {NOT_LEGAL_ADVICE}</span>
            <span className="mt-1.5 inline-flex">
              <CitationChip label="Labor Code 2810.5" url="https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=2810.5.&lawCode=LAB" />
            </span>
          </Callout>
        )}
        {doc === 'notice' && notice && notice.missing.length > 0 && (
          <Callout tone="warn" title="Add these details before you print">
            <ul className="mt-1 list-disc pl-5">
              {notice.missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
            <a href={links.settings('company')} className="mt-1 inline-block font-semibold text-accent underline">
              Open Settings
            </a>
          </Callout>
        )}
        {doc === 'letter' && (
          // Each chip's 40px hit area overhangs its row by 6px (-my-1.5), so wrapped rows need more than 12px apart.
          <div className="flex flex-wrap items-center gap-x-2 gap-y-4 text-[12.5px] text-ink-3">
            <span>Built in:</span>
            <CitationChip label="Labor Code 2922 (at will)" url="https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=2922.&lawCode=LAB" />
            <CitationChip label="B&P Code 16600 (no noncompete)" url="https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=16600.&lawCode=BPC" />
            <CitationChip label="Labor Code 925 (CA law and venue)" url="https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=925.&lawCode=LAB" />
            <CitationChip label="Labor Code 2870 (PIIA notice)" url="https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=2870.&lawCode=LAB" />
            <span>{NOT_LEGAL_ADVICE}</span>
          </div>
        )}
        {doc === 'letter' && letter && offer.equityShares > 0 && capTableIsPlaceholder(db) && (
          <Callout tone="neutral" title="Share count only">
            The cap table still has the placeholder numbers Start fresh filled in, so the letter leaves out the percent of fully diluted shares.
            {canSeeSection(viewer, 'comp') ? (
              <a href={links.comp('equity')} className="ft-link mt-0.5 flex min-h-10 items-center font-semibold text-accent underline">
                Check the cap table in Comp and plan &gt; Equity
              </a>
            ) : (
              ' Admin can confirm the cap table in Comp and plan.'
            )}
          </Callout>
        )}
        {withheld && (
          <Callout tone="neutral" icon="lock" title="Not approved yet">
            Admin approves this offer before it goes out. The letter and wage notice open here once it is approved.
          </Callout>
        )}
        {notApproved && !withheld && (
          <Callout tone="warn" title="Draft, not approved">
            Both documents say so at the top, in print and in the copied text, until you approve the offer. Approve it on the offer before you send the letter.
          </Callout>
        )}
        {drift && (
          <Callout tone="warn" title="The job's work location changed">
            <span className="block">{drift.message} The letter states the offer's work location.</span>
            {canMove ? (
              <span className="mt-2 flex flex-wrap items-center gap-2">
                <Button size="sm" icon="pin" onClick={takeJobLocation}>
                  Use the job&apos;s location
                </Button>
                {offer.status === 'approved' && <span className="text-[13px]">The work location is part of the approval, so this sends the offer back to draft.</span>}
              </span>
            ) : (
              <span className="mt-1 block">Admin or the hiring manager can change it on the offer.</span>
            )}
          </Callout>
        )}
        {startIssue && (
          <Callout tone="warn" title="Pick a new start date first">
            <span className="block">{startIssue}</span>
            {canMove ? (
              <span className="mt-2 flex flex-wrap items-center gap-2">
                <Button size="sm" icon="calendar" onClick={moveStart}>
                  Move start to {fmtDay(newStart)}
                </Button>
                {offer.status === 'approved' && <span className="text-[13px]">The start date is part of the approval, so this sends the offer back to draft.</span>}
              </span>
            ) : (
              <span className="mt-1 block">
                {unsent ? 'Admin or the hiring manager can move it on the offer.' : offer.status === 'accepted' ? 'Move the start on the offer, above the Hire button.' : 'Extend the offer to pick a new start date with it.'}
              </span>
            )}
          </Callout>
        )}
        {blocked.length > 0 && (
          <Callout tone="warn" title="Fix the offer before you generate the letter">
            {blocked.map((b) => (
              <span key={b.message} className="mt-1 block">
                <Private>{b.message}</Private>
              </span>
            ))}
            <span className="mt-1 block">The letter would state {offer.flsa === 'exempt' ? 'an exemption the pay cannot support' : 'a rate below the minimum wage'}. Edit the offer, or for an offer that went out, rescind it and make a new one. {NOT_LEGAL_ADVICE}</span>
          </Callout>
        )}
        {blocked.length > 0 || startIssue || withheld ? null : showing ? (
          <PrivateBlock>
            <article
              aria-label={title}
              className="letter-preview rounded-xl border border-line bg-surface px-5 py-5 font-serif text-[14.5px] leading-relaxed text-ink [&_h1]:mb-4 [&_h1]:font-sans [&_h1]:text-[19px] [&_h1]:font-bold [&_h2]:mt-5 [&_h2]:mb-1.5 [&_h2]:font-sans [&_h2]:text-[15px] [&_h2]:font-bold [&_p]:mb-3 [&_.sig]:mt-8 [&_.sig]:grid [&_.sig]:grid-cols-1 [&_.sig]:gap-8 sm:[&_.sig]:grid-cols-2 [&_.sig>div]:border-t [&_.sig>div]:border-ink-3 [&_.sig>div]:pt-1.5 [&_.sig>div]:text-[13px]"
              // The domain builds this HTML from escaped text only (escapeHTML on every value).
              dangerouslySetInnerHTML={{ __html: showing.html }}
            />
          </PrivateBlock>
        ) : (
          <p className="text-[14px] text-ink-2">The document could not be built for this offer.</p>
        )}
      </div>
    </Sheet>
  )
}
