// One-click Hire from an accepted offer: the threshold preview sits next to the button ('This hire
// takes you to 15'), and one click runs hireFromOffer, which creates employee #N (Pre-start) with job
// and pay records, the grant queued for board consent, the filled plan line, the referral bonus date
// and the onboarding checklist. Undo in the toast takes it back. Afterwards a calm welcome banner links
// to the person and their checklist and offers close-out notes for the job; it takes focus when it
// appears, since the Hire button that was pressed is gone. When the start date has passed by the time
// the offer is accepted or hired, StartPassedCallout asks whether they started then or the start moves.
import { useEffect, useRef } from 'react'
import { links } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { canSeeSection } from '@/domain/access'
import { current409A } from '@/domain/equity'
import { closeOutRemaining } from '@/domain/hiring/jobs'
import { closeOutMessage } from '@/domain/hiring/messages'
import { startHasPassed } from '@/domain/hiring/offers'
import { candidateName, dbHolidays } from '@/domain/hiring/util'
import { companyDomain, hireFromOffer, parseCityState } from '@/domain/lifecycle'
import { founder, firstName, fullName, personNameById, priorStint } from '@/domain/people'
import { jobHasPlanLine, planSlotForHire } from '@/domain/plan'
import type { DB, ID, Offer } from '@/domain/types'
import { addBusinessDays, fmtDay, fmtShort, type ISODate, today } from '@/lib/dates'
import { num, plural } from '@/lib/format'
import { useDB } from '@/store/db'
import { Button, Callout, Icon, Private } from '@/ui'
import { act, copyWithToast } from '../interviews/common'
import { missingWorkEmailHint } from '../logic'
import { checkCleared, otherOffersText } from './logic'

/**
 * Records the hire from an accepted offer in one click; the toast offers Undo instead of a confirmation
 * step (the threshold preview already sits next to the button). Returns the new person's id.
 */
export function hireNow(offerId: ID, actorId: ID | null): ID | null {
  const db = useDB.getState().db
  const offer = db.offers.find((o) => o.id === offerId)
  if (!offer) return null
  const nextNumber = db.people.reduce((m, p) => Math.max(m, p.hireNumber), 0) + 1
  const res = act(`Hired ${candidateName(db, offer.candidateId)} as employee #${nextNumber}`, (d) => hireFromOffer(d, offerId, { date: today(), actorId }))
  return res ? res.value : null
}

/**
 * The state the hire will work in, read the way hireFromOffer reads it: remote hires work from their
 * own state (from their location), everyone else from the office's state.
 */
function hireWorkState(db: DB, offer: Offer): string {
  const office = (db.locations.find((l) => l.id === offer.locationId)?.state || 'CA').toUpperCase()
  if (offer.workMode !== 'remote') return office
  const cand = db.candidates.find((c) => c.id === offer.candidateId)
  return (parseCityState(cand?.location).state ?? office).toUpperCase()
}

/** What the onboarding line says: California dates, or the hire's state and whether it is new to the company. */
function onboardingLine(db: DB, offer: Offer): string {
  const st = hireWorkState(db, offer)
  if (st === 'CA') return 'Starts the onboarding checklist with California dates (I-9, DE 34, notices, trainings).'
  const setUp = db.people.some((p) => p.homeState.toUpperCase() === st && (!p.endDate || p.endDate >= offer.startDate))
  return setUp
    ? `Starts the onboarding checklist for work in ${st} (I-9, the ${st} new hire report). California-only steps are left out, and ${st} is already set up.`
    : `Starts the onboarding checklist for work in ${st} (I-9, the ${st} new hire report) and a new-state setup checklist, since nobody works in ${st} yet. California-only steps are left out.`
}

/** What Hire will do, shown under the Hire button: a background-check warning and an expandable list. */
export function HireDetails({ offerId }: { offerId: ID }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const offer = db.offers.find((o) => o.id === offerId)
  if (!offer) return null
  const nextNumber = db.people.reduce((m, p) => Math.max(m, p.hireNumber), 0) + 1
  const job = db.jobs.find((j) => j.id === offer.jobId)
  // The line hireFromOffer fills: the job's own line while nobody holds it (a second hire gets a new one).
  const slot = planSlotForHire(db, offer, job)
  const cand = db.candidates.find((c) => c.id === offer.candidateId)
  // hireFromOffer adds a filled plan line when no free line is linked, unless a rehire's earlier stint holds one.
  const prior = cand ? priorStint(db, { id: '', firstName: cand.firstName, lastName: cand.lastName, personalEmail: cand.email, startDate: offer.startDate }) : undefined
  const addsPlanLine = !slot && !(prior && db.plan.some((s) => s.personId === prior.id))
  const extraSeat = addsPlanLine && jobHasPlanLine(db, offer, job)
  // Work emails are built only on a known domain (the website, or the founder's work email), never guessed.
  const domain = companyDomain(db.company, founder(db)?.workEmail)
  const others = db.offers.filter((o) => o.jobId === offer.jobId && o.id !== offer.id && (o.status === 'draft' || o.status === 'awaiting_approval' || o.status === 'approved' || o.status === 'sent' || (o.status === 'accepted' && !o.personId)))
  const keepsOpen = otherOffersText(others)
  const no409A = !current409A(db, today())
  const needsCheck = offer.contingencies.includes('background_check')
  const cleared = checkCleared(offer.backgroundCheck)
  return (
    <>
      {needsCheck && !cleared && (
        <Callout tone="warn" title="The background check has not cleared yet">
          You can record the hire now. The onboarding checklist keeps &quot;Background check cleared&quot; open, and it must be done before the start date (SOC 2 evidence).
        </Callout>
      )}
      {/* A flex summary has no native marker: the chevron says it opens (turned down while open). As wide as its
          words, so its focus ring is a box around them, not two rules across the column. */}
      <details className="group">
        <summary className="flex min-h-10 w-fit cursor-pointer items-center gap-1.5 text-[13.5px] font-semibold text-ink">
          <Icon name="chevron-right" size={16} className="shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
          What Hire does
        </summary>
        <ul className="mt-1 flex list-disc flex-col gap-1 pl-5 text-[13.5px] text-ink-2">
          <li>
            {startHasPassed(offer, today())
              ? `Creates employee #${nextNumber}, ${offer.title}, starting ${fmtDay(offer.startDate)}, reporting to ${personNameById(db, offer.managerId, 'their manager')}. That day has passed, so they count as active at once, and first-day tasks such as I-9 section 1 are already due.`
              : `Creates employee #${nextNumber}, ${offer.title}, as Pre-start until ${fmtDay(offer.startDate)}, reporting to ${personNameById(db, offer.managerId, 'their manager')}.`}
          </li>
          <li>Writes the job and pay records, effective on the start date.</li>
          <li>
            {domain
              ? `Gives them a work email at ${domain}.`
              : 'Leaves their work email empty: no company domain is on file. Add your website in Settings > Company to fill work emails in, or set it on their profile after the hire.'}
          </li>
          {offer.equityShares > 0 && (
            <li>
              Queues <Private>{num(offer.equityShares)}</Private> options for the next board consent{no409A ? '. Add a 409A valuation before the board approves them.' : ' at the current 409A.'}
              {no409A && canSeeSection(viewer, 'comp') && (
                <>
                  {' '}
                  <a href={links.comp('equity')} className="ft-link -my-2 inline-flex min-h-10 items-center font-semibold text-accent underline">
                    Record a 409A in Comp and plan &gt; Equity
                  </a>
                </>
              )}
            </li>
          )}
          <li>{onboardingLine(db, offer)}</li>
          {(offer.signOnBonus ?? 0) > 0 && <li>Adds a task to put the sign-on bonus on the first paycheck.</li>}
          {slot && <li>Fills the plan line {slot.title}.</li>}
          {addsPlanLine && (
            <li>
              {extraSeat
                ? "Adds a filled line for this hire to the headcount plan. The job's plan line is already filled, so this adds a seat outside the plan."
                : 'Adds a filled line for this hire to the headcount plan (the job is outside the plan).'}
            </li>
          )}
          {cand?.referrerId && <li>Dates the referral bonus for {personNameById(db, cand.referrerId, 'the referrer')}, {db.settings.referralBonusPayableDays} days after the start.</li>}
          <li>{job?.status === 'filled' ? 'The job stays filled.' : (keepsOpen ?? 'Marks the job filled.')}</li>
          <li>Undo in the toast that follows takes it all back.</li>
        </ul>
      </details>
    </>
  )
}

/** The next business day after `date`, where a start that has passed moves to. */
function nextStartDay(db: DB, date: ISODate): ISODate {
  return addBusinessDays(date, 1, dbHolidays(db))
}

/**
 * Asked when the start date has passed by the time the offer is accepted or hired: did they start then
 * (a late record keeps the date), or does the start move to the next business day? Never a hard block,
 * since a founder may record a hire after the fact. Without `onMove` and `onKeep` it only explains.
 */
export function StartPassedCallout({
  offer,
  onMove,
  onKeep,
  intro,
}: {
  offer: Pick<Offer, 'startDate'>
  onMove?: (startDate: ISODate) => void
  onKeep?: () => void
  /** The line under the question, which says what the buttons do here. */
  intro: string
}) {
  const db = useDB((s) => s.db)
  const next = nextStartDay(db, today())
  return (
    <Callout tone="warn" title={`Their start date ${fmtDay(offer.startDate)} has passed. Did they start then?`}>
      <span className="block">{intro}</span>
      {onMove && onKeep && (
        <span className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" icon="calendar" onClick={() => onMove(next)}>
            Move start to {fmtDay(next)}
          </Button>
          <Button size="sm" icon="check" onClick={onKeep}>
            Yes, they started on {fmtShort(offer.startDate)}
          </Button>
        </span>
      )}
    </Callout>
  )
}

/** Calm banner after a hire: links to the person and onboarding, plus close-out notes for the job. */
export function WelcomeBanner({ personId, jobId, onDismiss }: { personId: ID; jobId: ID; onDismiss: () => void }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const open = useRef<HTMLAnchorElement>(null)
  // The banner appears right after Hire, whose button is gone: the next step is opening the profile.
  useEffect(() => {
    requestAnimationFrame(() => open.current?.focus())
  }, [personId])
  const person = db.people.find((p) => p.id === personId)
  const job = db.jobs.find((j) => j.id === jobId)
  if (!person) return null
  const checklist = db.checklists.find((c) => c.personId === personId && c.kind === 'onboarding')
  const closeOut = job && job.status === 'filled' ? closeOutMessage(db, job.id, viewer.personId ? { senderId: viewer.personId } : {}) : null
  const remaining = job ? db.applications.filter((a) => a.jobId === job.id && a.status === 'active' && !a.conditionalOfferOn).length : 0
  const senderId = viewer.personId ?? founder(db)?.id
  const emailHint = missingWorkEmailHint(viewer, senderId, personNameById(db, senderId, 'the sender'))
  return (
    <div className="rounded-2xl border border-good/30 bg-good-soft px-4 py-4" role="status">
      <p className="font-display text-[18px] font-bold text-ink">
        Welcome, {firstName(person)}. Employee #{person.hireNumber}
      </p>
      <p className="mt-0.5 text-[14px] text-ink-2">
        {fullName(person)} starts {fmtDay(person.startDate)}. Onboarding is running{checklist ? `, with ${plural(checklist.tasks.filter((t) => t.status === 'open').length, 'open task')}` : ''}.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <a ref={open} href={links.person(person.id)} className="ft-btn ft-btn--primary ft-btn--md inline-flex h-11 items-center rounded-lg bg-accent px-4 text-[14.5px] font-semibold text-accent-ink hover:bg-accent-hover">
          Open {firstName(person)}&apos;s profile
        </a>
        {checklist && (
          <a href={links.checklist(checklist.id)} className="ft-btn ft-btn--secondary ft-btn--md inline-flex h-11 items-center rounded-lg border border-line-strong bg-surface px-4 text-[14.5px] font-semibold text-ink hover:bg-surface-2">
            Open onboarding checklist
          </a>
        )}
        <Button variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
      {closeOut && closeOut.bcc.length > 0 && job && (
        <div className="mt-4 border-t border-good/20 pt-3">
          <p className="text-[14px] font-bold text-ink">Close the loop with the other candidates</p>
          <p className="text-[13.5px] text-ink-2">
            {plural(closeOut.bcc.length, 'person', 'people')} on {job.title} still {closeOut.bcc.length === 1 ? 'needs' : 'need'} a note{remaining ? `, and ${plural(remaining, 'application')} ${remaining === 1 ? 'is' : 'are'} still open` : ''}.
          </p>
          {!closeOut.from && (
            <p className="text-[13px] text-ink-2">
              The note goes out on BCC only. {emailHint.text}
              {emailHint.link && (
                <>
                  {' '}
                  <a href={emailHint.link.href} className="-my-2 inline-flex min-h-10 items-center font-semibold text-accent underline">
                    {emailHint.link.label}
                  </a>
                </>
              )}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" icon="copy" onClick={() => void copyWithToast(`Subject: ${closeOut.subject}\n\n${closeOut.body}`, 'the close-out note')}>
              Copy close-out note
            </Button>
            <Button size="sm" icon="copy" onClick={() => void copyWithToast(closeOut.bcc.join(', '), 'the BCC list')}>
              Copy BCC list
            </Button>
            <a href={closeOut.mailto} className="ft-btn ft-btn--secondary ft-btn--sm inline-flex h-10 items-center rounded-lg border border-line-strong bg-surface px-3 text-[13.5px] font-semibold text-ink hover:bg-surface-2">
              Open in mail app
            </a>
            {remaining > 0 && (
              <Button size="sm" onClick={() => act(`Closed out ${plural(remaining, 'candidate')} on ${job.title}`, (d) => closeOutRemaining(d, job.id, { date: today(), notified: true }) > 0)}>
                Close out {plural(remaining, 'candidate')} as notified
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
