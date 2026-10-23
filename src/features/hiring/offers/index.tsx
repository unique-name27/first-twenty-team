// Offers, background checks and Hire (owned by the hiring-process builder).
// Exports keep the names and props the hiring core imports.
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { links } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { canApproveOffer, canDraftOffer, canSeeOffer } from '@/domain/access'
import { capTableIsPlaceholder } from '@/domain/equity'
import { offerNudgeMessage } from '@/domain/hiring/messages'
import {
  approvalRequired,
  approveOffer,
  classificationIssues,
  defaultStartDate,
  effectiveBand,
  extendOffer,
  isDiscarded,
  isLapsed,
  markAccepted,
  markSent,
  moveOfferStart,
  offerEquitySummary,
  offerLocationDrift,
  offerWorkLocationText,
  sendBlockerList,
  startHasPassed,
  submitForApproval,
  updateOffer,
  waitingOnApproval,
} from '@/domain/hiring/offers'
import { dbHolidays, desiredPayOf, offersFor, outcomeReasonLabel } from '@/domain/hiring/util'
import { hirePreview } from '@/domain/lifecycle'
import { personNameById } from '@/domain/people'
import { ThresholdPreview } from '@/features/compliance'
import type { ID, Offer } from '@/domain/types'
import { addBusinessDays, fmtDay, type ISODate, nowISO, today } from '@/lib/dates'
import { num, pct } from '@/lib/format'
import { useDB } from '@/store/db'
import { Badge, Button, DescriptionList, EmptyState, IconButton, Menu, type MenuItem, Money, Private } from '@/ui'
import { act, SubPanel, copyWithToast, MoneyText, Note } from '../interviews/common'
import { expiryPhrase } from '../interviews/logic'
import { BandMeter } from './BandMeter'
import { offerFocusTarget, offerTitleId } from './focus'
import { HireDetails, hireNow, StartPassedCallout, WelcomeBanner } from './HireFlow'
import { LetterSheet } from './LetterSheet'
import {
  approvalLine,
  bandMeterFigures,
  extendOptions,
  hasKeptOfferDraft,
  type OfferAction,
  offerActionPlan,
  type OfferMoreAction,
  offerStatusLabel,
  peerBases,
  rescindReasonText,
  trimPeriod,
} from './logic'
import { OfferBuilder } from './OfferBuilder'
import { OfferPay } from './OfferPay'
import { DeclineModal, RequestChangesModal, RescindModal } from './OfferDialogs'

export { CandidateBackground } from './Background'
export { OffersTab } from './OffersTab'
export { HireDetails, hireNow, WelcomeBanner } from './HireFlow'

type Dialog = { kind: 'decline' | 'rescind' | 'changes'; offerId: ID } | null

const CONTINGENCY_LABEL: Record<Offer['contingencies'][number], string> = { background_check: 'background check', i9: 'I-9', piia: 'PIIA' }
const BASIS_LABEL: Record<string, string> = {
  computer_professional: 'computer professional',
  professional: 'professional',
  administrative: 'administrative',
  executive: 'executive',
  outside_sales: 'outside sales',
}

/** Candidate profile block: current offer (builder, approval, letter, sent/accepted), Hire button. */
export function CandidateOffer({ applicationId }: { applicationId: ID }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const [builder, setBuilder] = useState<{ offerId?: ID } | null>(null)
  const [letterFor, setLetterFor] = useState<ID | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [welcome, setWelcome] = useState<ID | null>(null)
  // Mark accepted on an offer whose start date has passed first asks whether they started then.
  const [askStart, setAskStart] = useState(false)
  const askRef = useRef<HTMLDivElement>(null)
  // 'Yes, they started then' for this offer and start date (this visit only; the question is never a block).
  const [startKept, setStartKept] = useState<string | null>(null)
  // After an action that moves the offer on (Mark sent, Mark accepted, Approve, Extend and reopen, a moved
  // start date), focus goes to the panel's next step once it renders: the pressed button is usually gone by then.
  const focusNext = useRef(false)
  const date = today()
  const latest = offersFor(db, applicationId)[0]
  const step = latest ? `${latest.id}:${latest.status}:${isLapsed(latest, date)}:${latest.startDate}` : ''
  useEffect(() => {
    if (!focusNext.current) return
    focusNext.current = false
    requestAnimationFrame(() => offerFocusTarget(applicationId)?.focus())
  }, [step, applicationId])
  useEffect(() => {
    if (askStart) requestAnimationFrame(() => askRef.current?.querySelector<HTMLElement>('button')?.focus())
  }, [askStart])
  const app = db.applications.find((a) => a.id === applicationId)
  const job = app ? db.jobs.find((j) => j.id === app.jobId) : undefined
  const cand = app ? db.candidates.find((c) => c.id === app.candidateId) : undefined
  if (!app || !job || !cand || !canSeeOffer(viewer, db, app)) return null

  const offers = offersFor(db, app.id)
  const offer = offers[0]
  const isAdmin = canApproveOffer(viewer)
  const canDraft = canDraftOffer(viewer, db, app) && app.status === 'active'
  const name = `${cand.firstName} ${cand.lastName}`
  const closed = !offer || offer.status === 'declined' || offer.status === 'rescinded'
  const returnFocus = () => offerFocusTarget(app.id)

  const sheets = (
    <>
      {builder && <OfferBuilder applicationId={app.id} {...(builder.offerId ? { offerId: builder.offerId } : {})} open onClose={() => setBuilder(null)} returnFocus={returnFocus} />}
      {letterFor && <LetterSheet offerId={letterFor} open onClose={() => setLetterFor(null)} />}
      {dialog?.kind === 'decline' && <DeclineModal offerId={dialog.offerId} onClose={() => setDialog(null)} returnFocus={returnFocus} />}
      {dialog?.kind === 'rescind' && <RescindModal offerId={dialog.offerId} onClose={() => setDialog(null)} returnFocus={returnFocus} />}
      {dialog?.kind === 'changes' && <RequestChangesModal offerId={dialog.offerId} onClose={() => setDialog(null)} returnFocus={returnFocus} />}
    </>
  )

  if (!offer) {
    return (
      <SubPanel title="Offer" titleId={offerTitleId(app.id)} icon="send">
        {canDraft && !builder && hasKeptOfferDraft(app.id, undefined, 1) && <Note>Your unsaved offer is kept for this visit. Make offer brings it back.</Note>}
        <EmptyState
          compact
          icon="send"
          title="No offer yet"
          body={canDraft ? 'Level picks the band. Base, equity, a Monday start date and a 5-business-day expiry come prefilled.' : 'Offers show here once drafted.'}
          action={
            canDraft ? (
              // The panel's next action: 'Open offer' on a pipeline card lands here (offerFocusTarget).
              <Button variant="primary" size="lg" icon="plus" onClick={() => setBuilder({})} data-next-action={app.id}>
                Make offer
              </Button>
            ) : undefined
          }
        />
        {sheets}
      </SubPanel>
    )
  }

  const st = offerStatusLabel(offer, date)
  const lapsed = isLapsed(offer, date)
  const expired = offer.status === 'expired' || lapsed
  const discarded = isDiscarded(offer)
  const needsApproval = approvalRequired(db, offer, date)
  const unsent = offer.status === 'draft' || offer.status === 'approved'
  // An offer waiting for approval shows only a start date that has passed, so Admin can move it before approving.
  const blockers = unsent
    ? sendBlockerList(db, offer, date).filter((b) => b.kind !== 'approval')
    : offer.status === 'awaiting_approval'
      ? sendBlockerList(db, offer, date).filter((b) => b.kind === 'start')
      : []
  const hired = offer.personId ? db.people.find((p) => p.id === offer.personId) : undefined
  // Pay the classification cannot carry, on an offer already past the builder (waiting, out or accepted):
  // drafts list it among the send blockers below.
  const classification = !unsent && (offer.status === 'awaiting_approval' || offer.status === 'sent' || (offer.status === 'accepted' && !hired)) ? classificationIssues(db, offer) : []
  const band = effectiveBand(db, offer.familyId, offer.levelId, job)
  const base = offer.payType === 'hourly' ? Math.round((offer.hourlyRate ?? 0) * 2080) : (offer.salary ?? 0)
  // The meter in the offer's own terms: dollars an hour for an hourly offer.
  const meter = band ? bandMeterFigures(offer, band, job, desiredPayOf(cand)) : null
  const equity = offerEquitySummary(db, offer, date)
  const changes = [...offer.approvals].reverse().find((a) => a.decision === 'changes_requested')
  const drafter = offer.draftedById ? personNameById(db, offer.draftedById, 'someone') : undefined
  const holidays = dbHolidays(db)
  const editor = { role: viewer.role, personId: viewer.personId }
  // A start date that has passed: unsent offers and extensions move to the default start (a Monday at
  // least 14 days out); an accepted offer to the next business day.
  const startPassed = startHasPassed(offer, date) && !hired && offer.status !== 'declined' && offer.status !== 'rescinded'
  const startKey = `${offer.id}:${offer.startDate}`
  const newStart = defaultStartDate(date, holidays)
  // Unsaved builder changes kept from an earlier visit (the builder was left by a route change).
  const builderOfferId = unsent || offer.status === 'awaiting_approval' ? offer.id : undefined
  const keptDraft = canDraft && !builder && (closed || !!builderOfferId) && hasKeptOfferDraft(app.id, builderOfferId, builderOfferId ? undefined : offer.version + 1)

  const run = (label: string, fn: Parameters<typeof act>[1], moveFocus = false) => {
    const res = act(label, fn)
    if (res && moveFocus) focusNext.current = true
    return res
  }
  const approve = () => viewer.personId && run(`Approved the offer for ${name}`, (d) => approveOffer(d, offer.id, { approverId: viewer.personId as ID, at: nowISO() }), true)
  const submit = () => run(`Sent the offer for ${name} for approval`, (d) => submitForApproval(d, offer.id, { date }), true)
  const send = () => run(`Marked the offer to ${name} sent`, (d) => markSent(d, offer.id, { date }), true)
  const focusAsk = () => requestAnimationFrame(() => askRef.current?.querySelector<HTMLElement>('button')?.focus())
  const accept = () => {
    // A start date that has passed: ask whether they started then before recording it.
    if (startPassed && startKept !== startKey) {
      if (askStart) focusAsk()
      else setAskStart(true)
      return
    }
    run(`Recorded that ${name} accepted the offer`, (d) => markAccepted(d, offer.id, { date }), true)
  }
  const acceptStarted = () => {
    setStartKept(startKey)
    setAskStart(false)
    run(`Recorded that ${name} accepted the offer`, (d) => markAccepted(d, offer.id, { date }), true)
  }
  const acceptMovingStart = (to: ISODate) => {
    setAskStart(false)
    run(
      `Recorded that ${name} accepted the offer, starting ${fmtDay(to)}`,
      (d) => {
        const r = markAccepted(d, offer.id, { date })
        return r.ok ? moveOfferStart(d, offer.id, to, { date, editor }) : r
      },
      true,
    )
  }
  const moveStart = (to: ISODate) => run(`Moved the start date for ${name} to ${fmtDay(to)}`, (d) => moveOfferStart(d, offer.id, to, { date, editor }), true)
  const keepStart = () => {
    setStartKept(startKey)
    requestAnimationFrame(() => offerFocusTarget(app.id)?.focus())
  }
  const expiryDays = db.settings.offerExpiryBusinessDays
  const resetExpiry = () =>
    run(`Moved the offer expiry for ${name} to ${fmtDay(addBusinessDays(date, expiryDays, holidays))}`, (d) => updateOffer(d, offer.id, { expiresOn: addBusinessDays(date, expiryDays, holidays) }, { date, editor }))
  // Before it goes out, an offer follows its job's work location: the job may have moved (say to remote).
  const drift = unsent || offer.status === 'awaiting_approval' ? offerLocationDrift(db, offer) : null
  const takeJobLocation = () => {
    if (!drift) return
    const res = run(`Moved the offer for ${name} to the job's work location`, (d) => updateOffer(d, offer.id, { workMode: drift.workMode, locationId: drift.locationId }, { date, editor }))
    // The note and its button go away: focus moves on to the panel's next step.
    if (res) requestAnimationFrame(() => offerFocusTarget(app.id)?.focus())
  }
  const nudge = () => {
    const m = offerNudgeMessage(db, offer.id, { ...(viewer.personId ? { senderId: viewer.personId } : {}), date })
    if (m) void copyWithToast(`Subject: ${m.subject}\n\n${m.body}`, `a nudge for ${cand.firstName}`)
  }
  // While the start date has passed, an extension moves the start too (extendOffer refuses otherwise).
  const extendItems: MenuItem[] = extendOptions(offer.expiresOn, date, holidays).map((o) => ({
    label: startPassed ? `Extend to ${fmtDay(o.date)}, start ${fmtDay(newStart)}` : `Extend to ${fmtDay(o.date)}`,
    hint: `+${o.days} business days`,
    icon: 'clock',
    onSelect: () =>
      run(
        startPassed ? `Extended the offer for ${name} to ${fmtDay(o.date)} and moved the start to ${fmtDay(newStart)}` : `Extended the offer for ${name} to ${fmtDay(o.date)}`,
        (d) => extendOffer(d, offer.id, o.date, { date, ...(startPassed ? { startDate: newStart } : {}) }),
        expired,
      ),
  }))
  // The first primary action of each state carries data-next-action: focus lands there after the state changes.
  const next = { 'data-next-action': app.id }

  // Which buttons show, in what order, and which one leads: offerActionPlan (logic.ts, unit tested).
  const plan = offerActionPlan({
    status: offer.status,
    lapsed,
    needsApproval,
    isAdmin,
    hired: !!hired,
    // Admin approves before an offer goes out: until then only Admin opens the letter (marked as a draft).
    letter: !(waitingOnApproval(db, offer, date) && !isAdmin),
  })
  const lead = (key: OfferAction) => (plan.lead === key ? { variant: 'primary' as const, ...next } : {})
  const button: Record<OfferAction, () => ReactNode> = {
    approve: () => (
      <Button key="approve" {...lead('approve')} size={offer.status === 'awaiting_approval' ? 'lg' : 'md'} icon="check" onClick={approve}>
        Approve
      </Button>
    ),
    submit: () => (
      <Button key="submit" {...lead('submit')} icon="send" onClick={submit}>
        Submit for approval
      </Button>
    ),
    changes: () => (
      <Button key="changes" onClick={() => setDialog({ kind: 'changes', offerId: offer.id })}>
        Ask for changes
      </Button>
    ),
    // Ready to go out, the letter leads (print it, send it for signature), then Mark sent records the date.
    letter: () => (
      <Button key="letter" {...lead('letter')} icon="file" onClick={() => setLetterFor(offer.id)}>
        Generate letter
      </Button>
    ),
    send: () => (
      <Button key="send" {...lead('send')} icon="send" onClick={send}>
        Mark sent
      </Button>
    ),
    edit: () => (
      <Button key="edit" icon="edit" onClick={() => setBuilder({ offerId: offer.id })}>
        Edit
      </Button>
    ),
    accept: () => (
      <Button key="accept" {...lead('accept')} icon="check" onClick={accept}>
        Mark accepted
      </Button>
    ),
    decline: () => (
      <Button key="decline" onClick={() => setDialog({ kind: 'decline', offerId: offer.id })}>
        Declined
      </Button>
    ),
    extend: () => <Menu key="extend" label="Extend expiry" items={extendItems} trigger={(p) => <Button icon="clock" {...p}>Extend expiry</Button>} />,
    reopen: () => (
      <Menu key="extend" label="Extend expiry" items={extendItems} trigger={(p) => <Button variant="primary" icon="clock" {...p} {...next}>Extend and reopen</Button>} />
    ),
  }
  const moreItem: Record<OfferMoreAction, MenuItem> = {
    'discard-draft': { label: 'Discard draft', icon: 'trash', danger: true, onSelect: () => setDialog({ kind: 'rescind', offerId: offer.id }) },
    discard: { label: 'Discard offer', icon: 'trash', danger: true, onSelect: () => setDialog({ kind: 'rescind', offerId: offer.id }) },
    letter: { label: 'Generate letter', icon: 'file', onSelect: () => setLetterFor(offer.id) },
    nudge: { label: 'Copy a friendly nudge', icon: 'copy', onSelect: nudge },
    rescind: { label: 'Rescind offer', icon: 'x', danger: true, onSelect: () => setDialog({ kind: 'rescind', offerId: offer.id }) },
    'backed-out': { label: 'Candidate backed out', icon: 'x', onSelect: () => setDialog({ kind: 'decline', offerId: offer.id }) },
    divider: { divider: true },
  }
  const primary: ReactNode[] = plan.buttons.map((k) => button[k]())
  const more: MenuItem[] = plan.more.map((k) => moreItem[k])
  if (closed && canDraft) {
    primary.push(
      <Button key="new" variant="primary" icon="plus" onClick={() => setBuilder({})} {...next}>
        Make a new offer
      </Button>,
    )
  }

  const preview = offer.status === 'accepted' && !hired ? hirePreview(db, offer.id) : null
  const closedNote = (() => {
    if (offer.status === 'declined') {
      return (
        <MoneyText
          text={`Declined${offer.decidedOn ? ` ${fmtDay(offer.decidedOn)}` : ''}: ${outcomeReasonLabel(offer.declineReason).toLowerCase()}${offer.competingNote ? `. ${trimPeriod(offer.competingNote)}` : ''}.`}
        />
      )
    }
    if (expired) return `Expired ${fmtDay(offer.expiresOn)}. Extend it to reopen, or record that they declined.`
    if (offer.status === 'rescinded') {
      const word = discarded ? 'Discarded' : 'Rescinded'
      const why = offer.rescindReason ? `: ${rescindReasonText(offer.rescindReason)}` : ''
      return <MoneyText text={`${word}${offer.decidedOn ? ` ${fmtDay(offer.decidedOn)}` : ''}${why}.${discarded ? ' The candidate never received it.' : ''}`} />
    }
    return null
  })()

  return (
    <SubPanel
      title="Offer"
      titleId={offerTitleId(app.id)}
      icon="send"
      subtitle={`Version ${offer.version}${drafter ? `, drafted by ${drafter}` : ''}${offer.createdOn ? ` on ${fmtDay(offer.createdOn)}` : ''}`}
      actions={
        <>
          <Badge tone={st.tone}>{offer.status === 'sent' && !lapsed ? `Out, ${expiryPhrase(offer.expiresOn, date, { midSentence: true })}` : st.label}</Badge>
          {more.length > 0 && <Menu label="More offer actions" items={more} trigger={(p) => <IconButton icon="more" label="More offer actions" {...p} />} />}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {welcome && <WelcomeBanner personId={welcome} jobId={job.id} onDismiss={() => setWelcome(null)} />}
        {hired && !welcome && (
          <Note icon="check">
            Hired as employee #{hired.hireNumber}, starting {fmtDay(hired.startDate)}.{' '}
            <a href={links.person(hired.id)} className="-my-2 inline-flex min-h-10 items-center font-semibold text-accent underline">
              Open profile
            </a>
          </Note>
        )}
        {offer.status === 'awaiting_approval' && !isAdmin && <Note icon="clock">Waiting for Admin approval. You can still edit it.</Note>}
        {offer.status === 'draft' && changes && (
          <Note icon="alert">
            {personNameById(db, changes.approverId, 'Admin')} asked for changes: <MoneyText text={changes.note ?? ''} />
          </Note>
        )}
        {closedNote && <Note icon="info">{closedNote}</Note>}
        {classification.map((c) => (
          <Note key={c.message} icon="alert">
            <Private>{c.message}</Private>{' '}
            {offer.status === 'awaiting_approval' ? 'Edit the offer before it goes out.' : 'It went out like this. Rescind it and make a new offer that fixes it.'}
          </Note>
        ))}
        <DescriptionList
          columns={2}
          items={[
            { label: 'Base', value: <OfferPay offer={offer} /> },
            {
              label: 'Variable and sign-on',
              value: (
                <>
                  {offer.variablePct ? (
                    <>
                      <Private>{pct(offer.variablePct)}</Private> target (<Money value={Math.round(base * offer.variablePct)} />)
                    </>
                  ) : (
                    'No variable'
                  )}
                  {offer.signOnBonus ? (
                    <>
                      , <Money value={offer.signOnBonus} /> sign-on
                    </>
                  ) : null}
                </>
              ),
            },
            {
              label: 'Equity',
              value:
                offer.equityShares > 0 ? (
                  <>
                    <Private>{num(offer.equityShares)}</Private> {offer.equityType}s, <Private>{pct(equity.pctFD, 3)}</Private> fully diluted
                    {capTableIsPlaceholder(db) ? ' (estimate from the placeholder cap table)' : ''}
                  </>
                ) : (
                  'None'
                ),
            },
            { label: 'Start date', value: `${fmtDay(offer.startDate)}${startPassed ? ' (passed)' : ''}` },
            { label: 'Work location', value: offerWorkLocationText(db, offer) },
            { label: 'Expires', value: `${fmtDay(offer.expiresOn)}${offer.status === 'sent' ? ` (${expiryPhrase(offer.expiresOn, date, { midSentence: true })})` : ''}` },
            {
              label: 'Classification',
              value: (
                <>
                  {offer.flsa === 'exempt' ? `Exempt${offer.exemptionBasis ? `, ${BASIS_LABEL[offer.exemptionBasis] ?? offer.exemptionBasis}` : ''}` : 'Non-exempt (2810.5 notice required)'}
                  {(classification.length > 0 || blockers.some((b) => b.kind === 'classification')) && <span className="font-semibold text-warn">. The pay does not support it</span>}
                </>
              ),
            },
            {
              label: 'Hours',
              value: `${offer.employmentType === 'part_time' ? 'Part time' : offer.employmentType === 'intern' ? 'Internship' : 'Full time'}${offer.hoursPerWeek ? `, ${offer.hoursPerWeek} hours a week` : ''}`,
            },
            { label: 'Contingencies', value: offer.contingencies.length ? offer.contingencies.map((c) => CONTINGENCY_LABEL[c]).join(', ') : 'None' },
            { label: 'Approval', value: approvalLine(offer, needsApproval, (id) => personNameById(db, id, 'Admin'), drafter) },
            { label: 'Exception reason', value: <MoneyText text={offer.exceptionReason ?? ''} />, hidden: !offer.exceptionReason },
          ]}
        />
        {meter && base > 0 && (
          <BandMeter
            compact
            band={meter.band}
            offer={meter.offer}
            desired={meter.desired}
            desiredFrom={meter.desiredFrom}
            posted={meter.posted}
            unit={meter.unit}
            {...(isAdmin ? { peers: peerBases(db.people, db.comp, offer.familyId, offer.levelId, date, offer.personId ? [offer.personId] : [], meter.unit) } : {})}
          />
        )}
        {blockers.length > 0 && (
          <ul className="flex flex-col gap-1">
            {blockers.map((b) => (
              <li key={b.message} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Note icon="alert">
                  <Private>{b.message}</Private>
                </Note>
                {b.kind === 'expiry' && (
                  <Button size="sm" icon="clock" onClick={resetExpiry}>
                    Reset expiry to {expiryDays} business days from today
                  </Button>
                )}
                {b.kind === 'start' && (
                  <>
                    <Button size="sm" icon="calendar" onClick={() => moveStart(newStart)}>
                      Move start to {fmtDay(newStart)}
                    </Button>
                    {offer.status === 'approved' && <span className="text-[13px] text-ink-3">The start date is part of the approval, so this sends the offer back to draft.</span>}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {drift && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Note icon="alert">{drift.message}</Note>
            {canDraft && (
              <>
                <Button size="sm" icon="pin" onClick={takeJobLocation}>
                  Use the job&apos;s location
                </Button>
                {offer.status === 'approved' && <span className="text-[13px] text-ink-3">The work location is part of the approval, so this sends the offer back to draft.</span>}
              </>
            )}
          </div>
        )}
        {preview && startPassed && startKept !== startKey && (
          <StartPassedCallout
            offer={offer}
            intro={
              canDraft
                ? 'Move the start before the hire, or keep the date if they already started (first-day tasks and the I-9 deadlines then count from it).'
                : 'Admin or the hiring manager can move the start before the hire.'
            }
            {...(canDraft ? { onMove: moveStart, onKeep: keepStart } : {})}
          />
        )}
        {preview && (
          <div className="flex flex-col gap-2 rounded-xl bg-surface-2 px-4 py-3">
            <div className="flex flex-wrap items-center gap-3">
              {isAdmin ? (
                <Button
                  variant="primary"
                  size="lg"
                  icon="user-plus"
                  {...next}
                  onClick={() => {
                    const personId = hireNow(offer.id, viewer.personId)
                    if (personId) setWelcome(personId)
                  }}
                >
                  Hire {cand.firstName}
                </Button>
              ) : (
                <span className="text-[14px] font-semibold text-ink">Admin records the hire.</span>
              )}
              <span className="text-[14px] text-ink-2">
                This hire takes you to <span className="num font-bold text-ink">{preview.headcountAfter}</span> on {fmtDay(preview.date)}
                {preview.crossesThresholds.length ? `, crossing ${preview.crossesThresholds.join(' and ')}` : ''}.
              </span>
            </div>
            <ThresholdPreview startDate={offer.startDate} />
            {isAdmin && <HireDetails offerId={offer.id} />}
          </div>
        )}
        {startPassed && (offer.status === 'sent' || offer.status === 'expired') && !askStart && (
          <Note icon="alert">
            The start date {fmtDay(offer.startDate)} has passed. Extending also moves the start to {fmtDay(newStart)}.
            {offer.status === 'sent' && !lapsed ? ' Mark accepted asks whether they started then.' : ''}
          </Note>
        )}
        {askStart && offer.status === 'sent' && startPassed && (
          <div ref={askRef}>
            <StartPassedCallout offer={offer} intro="Pick one to record the acceptance." onMove={acceptMovingStart} onKeep={acceptStarted} />
          </div>
        )}
        {keptDraft && <Note>Your unsaved changes to this offer are kept for this visit. {closed ? 'Make a new offer' : 'Edit'} brings them back.</Note>}
        {primary.length > 0 && <div className="flex flex-wrap gap-2">{primary}</div>}
        {offers.length > 1 && (
          <p className="text-[12.5px] text-ink-3">
            Earlier versions:{' '}
            <MoneyText
              text={offers
                .slice(1)
                .map((o) => `v${o.version} ${offerStatusLabel(o, date).label.toLowerCase()}${o.declineReason ? ` (${outcomeReasonLabel(o.declineReason).toLowerCase()})` : ''}`)
                .join(', ')}
            />
          </p>
        )}
      </div>
      {sheets}
    </SubPanel>
  )
}
