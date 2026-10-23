// Hiring > Offers: drafts, waiting for approval, ready to send, out (with expiry countdown), accepted
// (with Hire when not yet hired), declined (reason), expired (including sent offers past their expiry
// date, with Extend and reopen on the profile), rescinded and discarded (drafts that never went out,
// kept apart from rescinded offers). Admin approves inline. An accepted offer whose start date has
// passed hires from the profile, which first asks whether they started then.
import { useState } from 'react'
import { links } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { canApproveOffer, canSeeOffer } from '@/domain/access'
import { approveOffer, isDiscarded, isLapsed, startHasPassed } from '@/domain/hiring/offers'
import { candidateName, outcomeReasonLabel } from '@/domain/hiring/util'
import { hirePreview } from '@/domain/lifecycle'
import { personNameById } from '@/domain/people'
import type { ID, Offer } from '@/domain/types'
import { addDays, fmtDay, nowISO, today } from '@/lib/dates'
import { listJoin, num, plural } from '@/lib/format'
import { useDB } from '@/store/db'
import { Badge, Button, EmptyState, Panel, Private } from '@/ui'
import { act, MoneyText } from '../interviews/common'
import { expiryPhrase } from '../interviews/logic'
import { hireNow, WelcomeBanner } from './HireFlow'
import { OfferPay } from './OfferPay'
import { checkCleared, groupOffers, type OfferGroupKey, offerStatusLabel, rescindReasonText, trimPeriod } from './logic'

const GROUPS: Array<{ key: OfferGroupKey; title: string; short: string }> = [
  { key: 'awaiting_approval', title: 'Waiting for approval', short: 'waiting for approval' },
  { key: 'draft', title: 'Drafts', short: 'in draft' },
  { key: 'approved', title: 'Approved, ready to send', short: 'ready to send' },
  { key: 'sent', title: 'Out', short: 'out' },
  { key: 'accepted', title: 'Accepted', short: 'accepted' },
  { key: 'declined', title: 'Declined', short: 'declined' },
  { key: 'expired', title: 'Expired', short: 'expired' },
  { key: 'rescinded', title: 'Rescinded', short: 'rescinded' },
  { key: 'discarded', title: 'Discarded drafts', short: 'discarded' },
]

/** Hiring > Offers tab: drafts, awaiting approval, out with expiry, accepted, declined with reason. */
export function OffersTab() {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const [welcome, setWelcome] = useState<{ personId: ID; jobId: ID } | null>(null)
  const date = today()
  const visible = db.offers.filter((o) => {
    const app = db.applications.find((a) => a.id === o.applicationId)
    return !!app && canSeeOffer(viewer, db, app)
  })
  const since = addDays(date, -120)
  const { groups, earlier } = groupOffers(visible, since, db.people, addDays(date, -30), date)
  const isAdmin = canApproveOffer(viewer)
  const shown = GROUPS.filter((g) => groups[g.key].length > 0)
  const notHired = groups.accepted.filter((o) => !o.personId).length
  const summary = shown.map((g) =>
    g.key === 'accepted' ? `${num(groups.accepted.length)} accepted${notHired ? ` (${num(notHired)} not hired yet)` : ''}` : `${num(groups[g.key].length)} ${g.short}`,
  )
  const hire = (o: Offer) => {
    const personId = hireNow(o.id, viewer.personId)
    if (personId) setWelcome({ personId, jobId: o.jobId })
  }

  if (visible.length === 0) {
    return <EmptyState icon="send" title="No offers yet" body="Offers start from a candidate's profile with Make offer." />
  }

  return (
    <div className="flex flex-col gap-4">
      {welcome && <WelcomeBanner personId={welcome.personId} jobId={welcome.jobId} onDismiss={() => setWelcome(null)} />}
      <p className="text-[14px] text-ink-2" aria-live="polite">
        {summary.length ? `${listJoin(summary)}.` : 'No offers in flight.'}
        {earlier > 0 ? ` ${plural(earlier, 'older offer')} not shown (decided or started a while ago).` : ''}
      </p>
      {shown.map((g) => (
        <Panel key={g.key} title={g.title} subtitle={plural(groups[g.key].length, 'offer')} padded={false}>
          <ul className="divide-y divide-line">
            {groups[g.key].map((o) => (
              <OfferRow key={o.id} offer={o} isAdmin={isAdmin} onHire={() => hire(o)} />
            ))}
          </ul>
        </Panel>
      ))}
    </div>
  )
}

function OfferRow({ offer, isAdmin: admin, onHire }: { offer: Offer; isAdmin: boolean; onHire: () => void }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const date = today()
  const name = candidateName(db, offer.candidateId)
  const st = offerStatusLabel(offer, date)
  const lapsed = isLapsed(offer, date)
  const hired = offer.personId ? db.people.find((p) => p.id === offer.personId) : undefined
  let detail = ''
  switch (offer.status) {
    case 'sent':
      detail = lapsed
        ? `Sent ${offer.sentOn ? fmtDay(offer.sentOn) : ''}. Expired ${fmtDay(offer.expiresOn)}. Extend it to reopen, or record that they declined.`
        : `Sent ${offer.sentOn ? fmtDay(offer.sentOn) : ''}. ${expiryPhrase(offer.expiresOn, date)} (${fmtDay(offer.expiresOn)}).`
      break
    case 'awaiting_approval':
    case 'draft':
      detail = `Drafted by ${offer.draftedById ? personNameById(db, offer.draftedById, 'someone') : 'someone'} on ${fmtDay(offer.createdOn)}. Starts ${fmtDay(offer.startDate)}.`
      break
    case 'approved':
      detail = `Approved. Starts ${fmtDay(offer.startDate)}, expires ${fmtDay(offer.expiresOn)}.`
      break
    case 'accepted':
      detail = hired
        ? `Hired as employee #${hired.hireNumber}, starts ${fmtDay(hired.startDate)}.`
        : `Accepted ${offer.decidedOn ? fmtDay(offer.decidedOn) : ''}. Starts ${fmtDay(offer.startDate)}. Background check: ${offer.contingencies.includes('background_check') ? (checkCleared(offer.backgroundCheck) ? 'clear' : 'not clear yet') : 'not required'}.`
      break
    case 'declined':
      detail = `Declined ${offer.decidedOn ? fmtDay(offer.decidedOn) : ''}: ${outcomeReasonLabel(offer.declineReason).toLowerCase()}${offer.competingNote ? `. ${trimPeriod(offer.competingNote)}` : ''}.`
      break
    case 'expired':
      // Same next step as a sent offer past its date, while the application is still open.
      detail =
        db.applications.find((a) => a.id === offer.applicationId)?.status === 'active'
          ? `Expired ${fmtDay(offer.expiresOn)}. Extend it to reopen, or record that they declined.`
          : `Expired ${fmtDay(offer.expiresOn)}.`
      break
    case 'rescinded':
      detail = `${isDiscarded(offer) ? 'Discarded before it went out' : 'Rescinded'} ${offer.decidedOn ? fmtDay(offer.decidedOn) : ''}${offer.rescindReason ? `: ${rescindReasonText(offer.rescindReason)}` : ''}.`
      break
  }
  const preview = admin && offer.status === 'accepted' && !hired ? hirePreview(db, offer.id) : null
  // A start date that has passed is settled on the profile (did they start then, or does it move?) before the hire.
  const startPassed = !!preview && startHasPassed(offer, date)
  if (preview) detail += startPassed ? ` The start date has passed: open the profile to confirm it, then hire.` : ` This hire takes you to ${preview.headcountAfter}.`
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <a href={links.candidate(offer.candidateId)} className="-my-2 inline-flex min-h-10 items-center text-[15px] font-bold text-ink hover:text-accent">
            {name}
          </a>
          <Badge tone={offer.status === 'sent' && !lapsed && offer.expiresOn <= addDays(date, 2) ? 'warn' : offer.status === 'accepted' && !hired ? 'accent' : st.tone}>
            {offer.status === 'sent' && !lapsed ? expiryPhrase(offer.expiresOn, date) : offer.status === 'accepted' ? (hired ? 'Hired' : 'Ready to hire') : st.label}
          </Badge>
        </div>
        <p className="text-[13.5px] text-ink-2">
          {offer.title}. <OfferPay offer={offer} />
          {offer.equityShares > 0 && (
            <>
              , <Private>{num(offer.equityShares)}</Private> options
            </>
          )}
        </p>
        <p className="text-[13px] text-ink-3">
          <MoneyText text={detail} />
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {admin && offer.status === 'awaiting_approval' && (
          <Button
            variant="primary"
            icon="check"
            onClick={() => {
              if (!viewer.personId) return
              const ok = act(`Approved the offer for ${name}`, (d) => approveOffer(d, offer.id, { approverId: viewer.personId as ID, at: nowISO() }))
              // The row moves to 'Approved, ready to send' and this button goes away: follow it there.
              if (ok) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-offer-open="${offer.id}"]`)?.focus())
            }}
          >
            Approve
          </Button>
        )}
        {preview && !startPassed && (
          <Button variant="primary" icon="user-plus" onClick={onHire} aria-label={`Hire ${name}. This hire takes you to ${preview.headcountAfter}.`}>
            Hire
          </Button>
        )}
        <a
          href={links.candidate(offer.candidateId)}
          data-offer-open={offer.id}
          className="inline-flex h-11 items-center rounded-lg px-3 text-[14px] font-semibold text-accent hover:bg-accent-soft"
          aria-label={offer.status === 'approved' ? `Open ${name} to send the approved offer` : startPassed ? `Open ${name} to confirm the start date` : `Open ${name}`}
        >
          Open
        </a>
      </div>
    </li>
  )
}
