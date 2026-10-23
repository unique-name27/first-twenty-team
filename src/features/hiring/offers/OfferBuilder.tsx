// Offer builder on one screen: level picks the band, base defaults from offerDefaults (desired pay when
// inside the band, else the midpoint, snapped to $1K) with the position-in-band meter and the job's
// posted range, variable, sign-on, equity (shares, % fully diluted, strike estimate at the current 409A,
// internal only, no paper value), start date (Mondays), expiry (5 business days), employment type and
// hours, the work mode and location (the job's by default; they set the work state the exempt check
// and the letter read), the exempt check, a one-tap exception reason above band or guideline, and
// contingencies. A work location that differs from the job's is flagged, with Use the job's location.
// Approval routes to Admin when a non-admin drafts, or changes pay, equity, level, start date or work
// location.
// A new version after a rescind or decline starts from the previous version's terms (offerFromPrevious),
// at the job's current work location.
// Editing an existing offer sends only the fields changed here (EditConflict.tsx).
// Unsaved changes are kept for the page load (keepOfferDraft in logic.ts) while the builder is left by
// a route change, such as its own Record a 409A link, and come back when it opens again; Save and an
// explicit close (Cancel, Close, Escape) drop them. When they come back, focus starts on the base pay
// (never on Start over), and Start over keeps focus on the form and offers to restore them.
import { useEffect, useMemo, useRef, useState } from 'react'
import { links } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { canDraftOffer, canSeeSection } from '@/domain/access'
import { capTableIsPlaceholder } from '@/domain/equity'
import {
  approvalRequired,
  approvalRequiredAfterEdit,
  approveOffer,
  createOffer,
  defaultBase,
  defaultHourlyRate,
  defaultStartDate,
  effectiveBand,
  exemptCheck,
  hoursPerWeekProblem,
  jobWorkLocation,
  offerDefaults,
  offerEquitySummary,
  offerExceptions,
  offerFromPrevious,
  offerLocationDrift,
  type OfferPatch,
  postedRangeCheck,
  submitForApproval,
  updateOffer,
} from '@/domain/hiring/offers'
import { candidateName, dbHolidays, desiredAnnual, desiredPayOf, offersFor, snapTo } from '@/domain/hiring/util'
import { NOT_LEGAL_ADVICE } from '@/domain/compliance'
import { fullName, isEmployedOn, personNameById } from '@/domain/people'
import { planSlotForHire } from '@/domain/plan'
import type { EmploymentType, ExemptionBasis, FLSA, ID, Job, Offer, WorkMode } from '@/domain/types'
import { fmtDate, fmtDay, nowISO, today, type ISODate } from '@/lib/dates'
import { listJoin, money, money2, num, pct } from '@/lib/format'
import { useDB } from '@/store/db'
import {
  Button,
  Callout,
  ChipGroup,
  ChipMulti,
  CitationChip,
  DateChips,
  Field,
  focusFirstInvalid,
  FormGrid,
  Icon,
  Money,
  MoneyInput,
  NumberInput,
  Private,
  Segmented,
  Select,
  Sheet,
  TextInput,
  toast,
} from '@/ui'
import { EditConflictCallout, focusEditConflict, useEditConflicts } from '../EditConflict'
import { act } from '../interviews/common'
import { payTooHighError } from '../logic'
import { EMPLOYMENT_OPTIONS } from '../parts'
import { BandMeter } from './BandMeter'
import {
  bandMeterFigures,
  dropOfferDraft,
  exceptionReasonChoices,
  expiryPresets,
  keepOfferDraft,
  keptOfferDraft,
  peerBases,
  restoreOfferDraft,
  startDatePresets,
} from './logic'

const LC_4323 = 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=432.3.&lawCode=LAB'

type Form = {
  levelId: ID
  payType: 'salary' | 'hourly'
  salary: number | null
  hourlyRate: number | null
  /** Percent of base (10 = 10%). */
  variablePct: number | null
  signOnBonus: number | null
  equityShares: number | null
  startDate: string
  expiresOn: string
  flsa: FLSA
  exemptionBasis?: ExemptionBasis
  exceptionReason: string
  contingencies: Offer['contingencies']
  managerId: ID
  employmentType: EmploymentType
  hoursPerWeek: number | null
  workMode: WorkMode
  locationId: ID
}

const WORK_MODE_OPTIONS: Array<{ value: WorkMode; label: string }> = [
  { value: 'onsite', label: 'On site' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'remote', label: 'Remote' },
]

const BASIS_OPTIONS: Array<{ value: ExemptionBasis; label: string }> = [
  { value: 'computer_professional', label: 'Computer professional' },
  { value: 'professional', label: 'Professional (licensed, for example CPA)' },
  { value: 'administrative', label: 'Administrative' },
  { value: 'executive', label: 'Executive (manages 2 or more people)' },
  { value: 'outside_sales', label: 'Outside sales' },
]

const CONTINGENCY_OPTIONS: Array<{ value: Offer['contingencies'][number]; label: string }> = [
  { value: 'background_check', label: 'Background check' },
  { value: 'i9', label: 'I-9 work authorization' },
  { value: 'piia', label: 'PIIA signed' },
]

/** How a field that changed on another computer reads in the conflict callout. */
const FORM_WORDS: Record<keyof Form, string> = {
  levelId: 'the level',
  payType: 'the pay basis',
  salary: 'the base salary',
  hourlyRate: 'the hourly rate',
  variablePct: 'the variable target',
  signOnBonus: 'the sign-on bonus',
  equityShares: 'the stock options',
  startDate: 'the start date',
  expiresOn: 'the expiry date',
  flsa: 'the classification',
  exemptionBasis: 'the exemption',
  exceptionReason: 'the exception reason',
  contingencies: 'the contingencies',
  managerId: 'who they report to',
  employmentType: 'the employment type',
  hoursPerWeek: 'the hours a week',
  workMode: 'the work mode',
  locationId: 'the work location',
}

/** Default hours a week for an employment type. */
function hoursFor(t: EmploymentType): number {
  return t === 'part_time' ? 20 : 40
}

/** The builder's form for an offer (or the prefilled defaults of a new one). */
function formFrom(start: Partial<Offer>, job: Job | undefined, date: ISODate, holidays: ISODate[]): Form {
  const employmentType = start.employmentType ?? job?.employmentType ?? 'full_time'
  return {
    levelId: start.levelId ?? job?.levelId ?? '',
    payType: start.payType ?? 'salary',
    salary: start.salary ?? null,
    hourlyRate: start.hourlyRate ?? null,
    variablePct: start.variablePct != null ? Math.round(start.variablePct * 1000) / 10 : 0,
    signOnBonus: start.signOnBonus ?? 0,
    equityShares: start.equityShares ?? 0,
    startDate: start.startDate ?? defaultStartDate(date, holidays),
    expiresOn: start.expiresOn ?? date,
    flsa: start.flsa ?? 'exempt',
    ...(start.exemptionBasis ? { exemptionBasis: start.exemptionBasis } : {}),
    exceptionReason: start.exceptionReason ?? '',
    contingencies: start.contingencies ?? ['i9', 'piia'],
    managerId: start.managerId ?? job?.hiringManagerId ?? '',
    employmentType,
    hoursPerWeek: start.hoursPerWeek ?? hoursFor(employmentType),
    workMode: start.workMode ?? job?.workMode ?? 'hybrid',
    locationId: start.locationId ?? job?.locationIds[0] ?? '',
  }
}

export function OfferBuilder({
  applicationId,
  offerId,
  open,
  onClose,
  returnFocus,
}: {
  applicationId: ID
  offerId?: ID
  open: boolean
  onClose: () => void
  /** Where focus goes on close when the button that opened the builder is gone (Make offer, once an offer exists). */
  returnFocus?: () => HTMLElement | null | undefined
}) {
  if (!open) return null
  return <BuilderForm key={offerId ?? 'new'} applicationId={applicationId} offerId={offerId} onClose={onClose} returnFocus={returnFocus} />
}

function BuilderForm({
  applicationId,
  offerId,
  onClose,
  returnFocus,
}: {
  applicationId: ID
  offerId?: ID
  onClose: () => void
  returnFocus?: () => HTMLElement | null | undefined
}) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const date = today()
  const holidays = dbHolidays(db)
  const app = db.applications.find((a) => a.id === applicationId)
  const job = app ? db.jobs.find((j) => j.id === app.jobId) : undefined
  const cand = app ? db.candidates.find((c) => c.id === app.candidateId) : undefined
  const existing = offerId ? db.offers.find((o) => o.id === offerId) : undefined
  // Defaults are computed once, when the builder opens. A new version starts from the latest one's terms.
  const [defaults] = useState<Partial<Offer>>(() => {
    const d = offerDefaults(db, applicationId, date)
    const prev = offerId ? undefined : offersFor(db, applicationId)[0]
    return prev ? offerFromPrevious(prev, d, date) : d
  })
  const start = existing ?? defaults
  // The stored offer as a form, every render: what a pull brought in while the builder was open.
  const edit = useEditConflicts(formFrom(start, job, date, holidays))
  // Unsaved work from an earlier visit (the builder was left by a route change, such as Record a 409A),
  // laid over the offer as it is now.
  const [kept] = useState(() => {
    const draft = keptOfferDraft<Form>(applicationId, offerId, defaults.version)
    return draft ? restoreOfferDraft(draft, edit.base) : null
  })
  const [f, setF] = useState<Form>(() => kept?.form ?? edit.base)
  const [keptNote, setKeptNote] = useState(() => !!kept && (kept.restored.length > 0 || kept.dropped.length > 0))
  // Set when picking Exempt turned an hourly rate into a salary, so the change is never silent.
  const [payNote, setPayNote] = useState<string | null>(null)
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }))
  const [tried, setTried] = useState(false)
  // Start over's Restore toast can outlive the builder; it does nothing once the builder is gone.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const sheetFocus = returnFocus ? { returnFocus } : {}
  const dirty = edit.changed(f).length > 0
  useEffect(() => {
    if (dirty) keepOfferDraft(applicationId, offerId, { base: edit.base, form: f, ...(defaults.version != null ? { version: defaults.version } : {}) })
    else dropOfferDraft(applicationId, offerId)
  }, [dirty, f, edit.base, applicationId, offerId, defaults.version])
  /** Cancel, Close, Escape and a successful save: the kept draft goes too. A route change keeps it. */
  const close = () => {
    dropOfferDraft(applicationId, offerId)
    onClose()
  }
  /** The base pay field (salary or hourly rate, whichever the form shows). */
  const focusPay = () => (document.getElementById('ob-salary') ?? document.getElementById('ob-rate'))?.focus()
  /**
   * Back to the offer as it opened (the kept changes go). Focus moves to the base pay first, so it never
   * drops to <body> when the callout holding Start over unmounts, and again once the form re-renders (the
   * pay field changes when the pay basis does). The toast can bring the changes back; it is not an Undo,
   * which would undo a saved change instead.
   */
  const startOver = () => {
    const keptForm = f
    const keptPayNote = payNote
    focusPay()
    setF(edit.base)
    setPayNote(null)
    setKeptNote(false)
    dropOfferDraft(applicationId, offerId)
    requestAnimationFrame(focusPay)
    toast({
      text: existing ? 'Started over from the saved offer' : 'Started over from the prefilled offer',
      tone: 'neutral',
      action: {
        label: 'Restore my changes',
        onClick: () => {
          if (!mounted.current) return
          setF(keptForm)
          setPayNote(keptPayNote)
          setKeptNote(true)
        },
      },
    })
  }

  const levels = useMemo(() => {
    if (!job) return []
    const ids = new Set(db.bands.filter((b) => b.familyId === job.familyId).map((b) => b.levelId))
    ids.add(job.levelId)
    return db.levels.filter((l) => ids.has(l.id)).sort((a, b) => a.order - b.order || a.code.localeCompare(b.code))
  }, [db.bands, db.levels, job])

  if (!app || !job || !cand || (offerId && !existing)) {
    return (
      <Sheet open onClose={close} title="Offer" {...sheetFocus}>
        <p className="text-[14px] text-ink-2">{offerId && !existing ? 'This offer is no longer on file.' : 'This application is no longer on file.'}</p>
      </Sheet>
    )
  }
  if (!canDraftOffer(viewer, db, app)) {
    return (
      <Sheet open onClose={close} title="Offer" {...sheetFocus}>
        <Callout tone="neutral" icon="lock" title="Offers are drafted by Admin or the job's hiring manager" />
      </Sheet>
    )
  }

  const name = candidateName(db, app.candidateId)
  // Desired pay in the candidate's own unit: a yearly figure, or an hourly rate for an hourly or part-time job.
  const desired = desiredPayOf(cand)
  const band = effectiveBand(db, job.familyId, f.levelId, job)
  // A second offer on a filled job: say where its hire would land on the headcount plan.
  const freeLine = job.status === 'filled' ? planSlotForHire(db, { jobId: job.id }, job) : undefined
  const fd = db.equity.fullyDilutedShares
  const isAdmin = viewer.role === 'admin'
  const editor = { role: viewer.role, personId: viewer.personId }
  const annual = f.payType === 'hourly' ? Math.round((f.hourlyRate ?? 0) * 2080) : (f.salary ?? 0)
  // Every term as the form shows it; an existing offer is sent only the fields changed here.
  const fullPatch: OfferPatch = {
    levelId: f.levelId,
    payType: f.payType,
    salary: f.payType === 'salary' && f.salary ? f.salary : undefined,
    hourlyRate: f.payType === 'hourly' && f.hourlyRate ? f.hourlyRate : undefined,
    variablePct: f.variablePct ? Math.round(f.variablePct * 10) / 1000 : undefined,
    signOnBonus: f.signOnBonus ? f.signOnBonus : undefined,
    equityShares: f.equityShares ?? 0,
    startDate: f.startDate,
    expiresOn: f.expiresOn,
    flsa: f.flsa,
    exemptionBasis: f.flsa === 'exempt' ? f.exemptionBasis : undefined,
    contingencies: f.contingencies,
    managerId: f.managerId,
    employmentType: f.employmentType,
    hoursPerWeek: f.hoursPerWeek ?? undefined,
    workMode: f.workMode,
    locationId: f.locationId,
  }
  const changed = edit.changed(f)
  const patch: OfferPatch = {}
  if (existing) {
    const keys = new Set<keyof OfferPatch>()
    for (const k of changed) {
      if (k === 'exceptionReason') continue
      keys.add(k)
      // A new pay basis or classification rewrites the fields that depend on it.
      if (k === 'payType') keys.add('salary').add('hourlyRate')
      if (k === 'flsa') keys.add('exemptionBasis')
    }
    for (const k of keys) (patch as Record<string, unknown>)[k] = fullPatch[k]
  } else {
    Object.assign(patch, fullPatch)
  }
  const draftOffer = { ...(defaults as Offer), ...(existing ?? {}), ...fullPatch, exceptionReason: f.exceptionReason } as Offer
  const exceptions = offerExceptions(db, draftOffer)
  const needsReason = exceptions.length > 0
  const reasonMissing = needsReason && !f.exceptionReason.trim()
  const check = exemptCheck(db, {
    flsa: f.flsa,
    payType: f.payType,
    ...(f.salary != null ? { salary: f.salary } : {}),
    ...(f.hourlyRate != null ? { hourlyRate: f.hourlyRate } : {}),
    familyId: job.familyId,
    ...(f.exemptionBasis ? { exemptionBasis: f.exemptionBasis } : {}),
    ...(f.hoursPerWeek != null ? { hoursPerWeek: f.hoursPerWeek } : {}),
    // The work state comes from the location picked here, so the check follows it.
    locationId: f.locationId,
  })
  const posted = postedRangeCheck(job, { payType: f.payType, ...(f.salary != null ? { salary: f.salary } : {}), ...(f.hourlyRate != null ? { hourlyRate: f.hourlyRate } : {}) })
  const equity = offerEquitySummary(db, { equityShares: f.equityShares ?? 0, equityType: draftOffer.equityType ?? 'ISO', vestingMonths: draftOffer.vestingMonths ?? 48, cliffMonths: draftOffer.cliffMonths ?? 12 }, date)
  // The meter reads in the offer's own terms: dollars an hour for an hourly offer, annual base for a salary.
  const meter = band ? bandMeterFigures({ payType: f.payType, ...(f.salary != null ? { salary: f.salary } : {}), ...(f.hourlyRate != null ? { hourlyRate: f.hourlyRate } : {}) }, band, job, desired) : null
  const peers = isAdmin ? peerBases(db.people, db.comp, job.familyId, f.levelId, date, [], meter?.unit) : undefined
  // A hiring manager's change to pay, equity, level, start date or work location makes them the drafter
  // (updateOffer), so it needs Admin approval even when Admin drafted it.
  const needsApproval = existing
    ? approvalRequiredAfterEdit(db, existing, patch, editor, date)
    : approvalRequired(db, { draftedById: viewer.personId ?? undefined, draftedByRole: viewer.role, createdOn: date }, date)
  const payMissing = f.payType === 'salary' ? !f.salary : !f.hourlyRate
  const payHigh = f.payType === 'salary' ? payTooHighError(f.salary, 'annual') : payTooHighError(f.hourlyRate, 'hourly')
  const hoursError = f.hoursPerWeek == null ? 'Enter 1 to 60 hours a week.' : (hoursPerWeekProblem(f.hoursPerWeek) ?? undefined)
  const managers = db.people.filter((p) => isEmployedOn(p, date)).sort((a, b) => a.hireNumber - b.hireNumber)
  const current = edit.conflicts(f)
  const droppedWords = kept ? listJoin(kept.dropped.map((k) => FORM_WORDS[k])) : ''
  const conflictLines = current.map((k) => {
    if (k === 'startDate' || k === 'expiresOn') return `${FORM_WORDS[k]} is now ${fmtDay(start[k] ?? '')}`
    if (k === 'managerId') return `${FORM_WORDS[k]} is now ${personNameById(db, start.managerId ?? '', 'someone else')}`
    if (k === 'locationId') return `${FORM_WORDS[k]} is now ${db.locations.find((l) => l.id === start.locationId)?.name ?? 'another place'}`
    return `${FORM_WORDS[k]} changed`
  })
  // The job's own work location, when the form's differs: flagged as a warning while the stored offer
  // still has an old one (the job moved after it was drafted), else as a note on a choice made here.
  const drift = offerLocationDrift(db, { jobId: job.id, workMode: f.workMode, locationId: f.locationId })
  const staleLocation = !!drift && !!existing && existing.workMode === f.workMode && existing.locationId === f.locationId

  const pickLevel = (levelId: ID) => {
    const b = effectiveBand(db, job.familyId, levelId, job)
    setF((x) => {
      const next: Form = { ...x, levelId }
      if (b) {
        // The same defaults as a new offer: inside the band and the job's posted range.
        const baseAmt = defaultBase(b, job, desiredAnnual(desired))
        const rate = defaultHourlyRate(baseAmt, job, desired)
        if (x.payType === 'salary' && baseAmt != null) next.salary = baseAmt
        else if (x.payType === 'hourly' && rate != null) next.hourlyRate = rate
        next.equityShares = snapTo(((b.equityMinPct + b.equityMaxPct) / 2) * fd, 500)
        if (b.variablePct != null) next.variablePct = Math.round(b.variablePct * 1000) / 10
      }
      return next
    })
  }
  /** Exempt pay is a salary unless the computer professional exemption applies: an hourly rate becomes a salary. */
  const toSalary = (x: Form) => (x.hourlyRate ? snapTo(x.hourlyRate * 2080, 1000) : x.salary)
  const switchToSalary = () => {
    const salary = toSalary(f)
    setF((x) => ({ ...x, payType: 'salary', salary: toSalary(x) }))
    setPayNote(f.hourlyRate && salary ? `Exempt roles are paid a salary, so ${money2(f.hourlyRate)} an hour became ${money(salary)} a year (x 2,080 hours, rounded to $1,000).` : null)
  }
  const pickFlsa = (v: FLSA) => {
    const basis = f.exemptionBasis ?? defaults.exemptionBasis ?? 'administrative'
    setF((x) => ({ ...x, flsa: v, ...(v === 'exempt' && !x.exemptionBasis ? { exemptionBasis: basis } : {}) }))
    setPayNote(null)
    if (v === 'exempt' && f.payType === 'hourly' && basis !== 'computer_professional') switchToSalary()
  }
  const pickEmployment = (t: EmploymentType) =>
    // Hours follow the type while they still hold the old type's default (40 full time, 20 part time).
    setF((x) => ({ ...x, employmentType: t, hoursPerWeek: x.hoursPerWeek == null || x.hoursPerWeek === hoursFor(x.employmentType) ? hoursFor(t) : x.hoursPerWeek }))
  /** Remote work names a remote location (the state it is done from); on site and hybrid name an office. */
  const pickWorkMode = (mode: WorkMode) =>
    setF((x) => {
      const loc = db.locations.find((l) => l.id === x.locationId)
      if (loc && (loc.kind === 'remote') === (mode === 'remote')) return { ...x, workMode: mode }
      // The job's fitting location first, then any in the workspace.
      const swap = jobWorkLocation(db, { workMode: mode, locationIds: [...job.locationIds, ...db.locations.map((l) => l.id)] }).locationId
      return { ...x, workMode: mode, ...(swap ? { locationId: swap } : {}) }
    })
  const takeJobLocation = () => {
    if (!drift) return
    // The callout holding this button goes away with the difference: focus waits on the location field.
    document.getElementById('ob-location')?.focus()
    setF((x) => ({ ...x, workMode: drift.workMode, locationId: drift.locationId }))
  }

  const save = (mode: 'draft' | 'submit' | 'approve') => {
    setTried(true)
    if (payMissing || payHigh || hoursError) {
      focusFirstInvalid()
      return
    }
    if (mode !== 'draft' && reasonMissing) {
      toast({ text: 'Pick an exception reason first: the offer is above the band or the equity guideline.', tone: 'neutral' })
      focusFirstInvalid()
      return
    }
    if (current.length) {
      toast({ text: 'This offer changed on another computer. Pick Use theirs or Keep mine first.', tone: 'neutral' })
      focusEditConflict()
      return
    }
    const reason = needsReason ? f.exceptionReason.trim() || undefined : undefined
    // The reason goes along when it was edited here, or to clear one the offer no longer needs.
    const sendReason = changed.includes('exceptionReason') || (!needsReason && !!existing?.exceptionReason)
    const label =
      mode === 'submit'
        ? `Sent the offer for ${name} for approval`
        : mode === 'approve'
          ? `Approved the offer for ${name}`
          : existing
            ? `Saved the offer for ${name}`
            : `Drafted an offer for ${name}`
    const res = act(label, (d) => {
      let id = existing?.id
      if (existing) {
        const r = updateOffer(d, existing.id, { ...patch, ...(sendReason ? { exceptionReason: reason } : {}) }, { date, editor })
        if (!r.ok) return r
      } else {
        const full: Omit<Offer, 'id'> = {
          ...(defaults as Omit<Offer, 'id'>),
          ...patch,
          ...(reason ? { exceptionReason: reason } : {}),
          ...(viewer.personId ? { draftedById: viewer.personId } : {}),
          draftedByRole: viewer.role,
          status: 'draft',
          createdOn: date,
          approvals: [],
        }
        if (!reason) delete full.exceptionReason
        const r = createOffer(d, full)
        if (!r.ok) return r
        id = r.id
      }
      if (!id) return { ok: false as const, reason: 'Offer not found.' }
      const o = d.offers.find((x) => x.id === id)
      if (mode === 'submit' && o && o.status === 'draft') return submitForApproval(d, id, { date })
      if (mode === 'approve' && viewer.personId) return o?.status === 'approved' ? { ok: true as const } : approveOffer(d, id, { approverId: viewer.personId, at: nowISO() })
      return { ok: true as const }
    })
    if (res) close()
  }

  const footer = (
    <>
      <Button variant="ghost" onClick={close}>
        Cancel
      </Button>
      {needsApproval && !isAdmin && (
        <>
          <Button onClick={() => save('draft')}>Save draft</Button>
          <Button variant="primary" size="lg" icon="send" onClick={() => save('submit')}>
            Submit for approval
          </Button>
        </>
      )}
      {isAdmin && needsApproval && (
        <>
          <Button onClick={() => save('draft')}>Save changes</Button>
          <Button variant="primary" size="lg" icon="check" onClick={() => save('approve')}>
            Save and approve
          </Button>
        </>
      )}
      {!needsApproval && (
        <Button variant="primary" size="lg" icon="check" onClick={() => save('draft')}>
          Save offer
        </Button>
      )}
    </>
  )

  return (
    <Sheet
      open
      onClose={close}
      width={680}
      title={existing ? `Edit offer: ${name}` : `Make offer: ${name}`}
      subtitle={`${job.title}${existing ? `, version ${existing.version}` : defaults.version && defaults.version > 1 ? `, version ${defaults.version} (starts from version ${defaults.version - 1})` : ''}`}
      footer={footer}
      {...sheetFocus}
    >
      <div className="flex flex-col gap-6">
        {keptNote && kept && (
          <Callout
            tone="accent"
            icon="info"
            title="Your unsaved changes are back"
            action={
              <Button size="sm" onClick={startOver}>
                Start over
              </Button>
            }
          >
            Kept from before you left the builder. Save the offer to keep them.
            {kept.dropped.length > 0 &&
              ` ${droppedWords.charAt(0).toUpperCase()}${droppedWords.slice(1)} changed somewhere else in the meantime, so ${kept.dropped.length === 1 ? 'it shows' : 'they show'} the saved value.`}
          </Callout>
        )}
        <EditConflictCallout what="offer" lines={conflictLines} onTheirs={() => edit.takeTheirs(current, setF)} onMine={() => edit.keepMine(current)} />
        {!isAdmin && needsApproval && (
          <Callout tone="accent" icon="info" title="This offer goes to Admin for approval">
            {existing && !approvalRequired(db, existing, date)
              ? 'Admin drafted it. Changes to pay, equity, level, start date or work location go back to Admin for approval before it goes out.'
              : 'Hiring managers draft offers inside the band. Admin approves before it goes out.'}
          </Callout>
        )}
        {job.status === 'filled' && !existing?.personId && (
          <Callout tone="accent" icon="info" title="This job is already filled">
            {freeLine
              ? `You can still make this offer. A hire from it fills the plan line ${freeLine.title}.`
              : 'You can still make this offer. A hire from it adds a seat outside the headcount plan.'}
          </Callout>
        )}

        <Field label="Level">
          {() => (
            <div className="flex flex-col gap-2">
              <ChipGroup label="Level" value={f.levelId} onChange={pickLevel} options={levels.map((l) => ({ value: l.id, label: `${l.code} ${l.name}` }))} />
              {band ? (
                <p className="text-[13px] text-ink-3">
                  Band: <Money value={band.min} /> min, <Money value={band.mid} /> mid, <Money value={band.max} /> max
                  {band.equityMaxPct > 0 && (
                    <>
                      . Equity guideline {pct(band.equityMinPct)} to {pct(band.equityMaxPct)} of fully diluted
                    </>
                  )}
                  .
                </p>
              ) : (
                <p className="text-[13px] text-ink-3">No band for this level yet. Set one in Comp and plan.</p>
              )}
            </div>
          )}
        </Field>

        <section aria-labelledby="ob-base" className="flex flex-col gap-3">
          <h3 id="ob-base" className="text-[15px] font-bold text-ink">
            Base pay
          </h3>
          {/* With restored changes the sheet opens here, past the callout's Start over (data-autofocus). */}
          {f.payType === 'salary' ? (
            <Field label="Base salary (per year)" id="ob-salary" error={tried ? (payMissing ? 'Add the base salary.' : payHigh) : undefined}>
              {(id, describedBy) => <MoneyInput id={id} aria-describedby={describedBy} value={f.salary} onChange={(v) => set('salary', v)} data-autofocus={keptNote || undefined} />}
            </Field>
          ) : (
            <Field label="Hourly rate" id="ob-rate" error={tried ? (payMissing ? 'Add the hourly rate.' : payHigh) : undefined}>
              {(id, describedBy) => (
                <NumberInput id={id} aria-describedby={describedBy} prefix="$" suffix="/ hour" step={0.25} min={0} value={f.hourlyRate} onChange={(v) => set('hourlyRate', v)} data-autofocus={keptNote || undefined} />
              )}
            </Field>
          )}
          {band && f.payType === 'salary' && (
            <ChipGroup
              size="sm"
              label="Quick base amounts"
              value={String(f.salary ?? '')}
              onChange={(v) => set('salary', Number(v))}
              options={[
                { value: String(snapTo(band.min, 1000)), label: 'Band min' },
                { value: String(snapTo(band.mid, 1000)), label: 'Midpoint' },
                ...(desired ? [{ value: String(snapTo(desiredAnnual(desired) ?? 0, 1000)), label: desired.unit === 'hour' ? 'Desired pay (at 2,080 hours)' : 'Desired pay' }] : []),
                { value: String(snapTo(band.max, 1000)), label: 'Band max' },
              ].filter((o, i, all) => all.findIndex((x) => x.value === o.value) === i)}
            />
          )}
          {meter && <BandMeter band={meter.band} offer={meter.offer} desired={meter.desired} desiredFrom={meter.desiredFrom} posted={meter.posted} unit={meter.unit} {...(peers ? { peers } : {})} />}
          {posted && (
            <Callout tone="warn" title="Outside the posted range">
              <Private>{posted.message}</Private>
              <span className="mt-2 flex flex-wrap items-center gap-2">
                <CitationChip label="Labor Code 432.3" url={LC_4323} />
                <span className="text-[12.5px] text-ink-3">{NOT_LEGAL_ADVICE}</span>
              </span>
            </Callout>
          )}
          {!isAdmin && <p className="text-[12.5px] text-ink-3">Peer positions are visible to Admin only.</p>}
        </section>

        <FormGrid>
          <Field
            label="Variable target"
            hint={
              f.variablePct ? (
                <>
                  About <Money value={Math.round(annual * (f.variablePct / 100))} /> a year at target
                  {job.familyId === 'f-gtm' && (
                    <>
                      , OTE <Money value={Math.round(annual * (1 + f.variablePct / 100))} />
                    </>
                  )}
                  .
                </>
              ) : (
                'No variable pay.'
              )
            }
          >
            {(id, describedBy) => <NumberInput id={id} aria-describedby={describedBy} suffix="% of base" min={0} step={1} value={f.variablePct} onChange={(v) => set('variablePct', v)} />}
          </Field>
          <Field label="Sign-on bonus">
            {(id) => <MoneyInput id={id} value={f.signOnBonus} onChange={(v) => set('signOnBonus', v)} />}
          </Field>
        </FormGrid>
        <ChipGroup
          size="sm"
          label="Quick sign-on amounts"
          value={String(f.signOnBonus ?? 0)}
          onChange={(v) => set('signOnBonus', Number(v))}
          options={[
            { value: '0', label: 'No sign-on' },
            { value: '10000', label: '$10K' },
            { value: '25000', label: '$25K' },
          ]}
        />

        <section aria-labelledby="ob-equity" className="flex flex-col gap-3">
          <h3 id="ob-equity" className="text-[15px] font-bold text-ink">
            Equity
          </h3>
          <Field label="Stock options (shares)">
            {(id) => <NumberInput id={id} min={0} step={500} value={f.equityShares} onChange={(v) => set('equityShares', v)} />}
          </Field>
          {band && band.equityMaxPct > 0 && (
            <ChipGroup
              size="sm"
              label="Equity guideline"
              value={String(f.equityShares ?? 0)}
              onChange={(v) => set('equityShares', Number(v))}
              options={[
                { value: String(snapTo(band.equityMinPct * fd, 500)), label: 'Guideline low' },
                { value: String(snapTo(((band.equityMinPct + band.equityMaxPct) / 2) * fd, 500)), label: 'Guideline mid' },
                { value: String(snapTo(band.equityMaxPct * fd, 500)), label: 'Guideline high' },
              ]}
            />
          )}
          <div className="rounded-xl bg-surface-2 px-3.5 py-3 text-[13.5px] text-ink-2">
            <p>
              <Private className="font-semibold text-ink">{num(f.equityShares ?? 0)} options</Private>, <Private>{pct(equity.pctFD, 3)}</Private> of <Private>{num(fd)}</Private> fully diluted shares. {equity.vesting}.
            </p>
            {capTableIsPlaceholder(db) && (
              <p className="mt-1 flex items-start gap-1.5 font-semibold text-warn">
                <Icon name="alert" size={15} className="mt-0.5 shrink-0" />
                <span>
                  The percent comes from the placeholder cap table Start fresh filled in, so the letter leaves it out and gives the share count only.
                  {canSeeSection(viewer, 'comp') ? '' : ' Admin can confirm the cap table.'}
                </span>
              </p>
            )}
            {capTableIsPlaceholder(db) && canSeeSection(viewer, 'comp') && (
              <p className="-mb-1 flex flex-wrap items-center gap-x-1.5">
                <a href={links.comp('equity')} className="ft-link inline-flex min-h-10 items-center font-semibold text-accent underline">
                  Check the cap table in Comp and plan &gt; Equity
                </a>
                <span className="text-[12.5px] text-ink-3">(your changes here are kept)</span>
              </p>
            )}
            <p className="mt-1">
              Strike estimate:{' '}
              {equity.strikeEstimate != null ? (
                <>
                  <Private className="font-semibold text-ink">{money2(equity.strikeEstimate)}</Private> a share at the current 409A
                  {equity.valuationOn ? ` (${fmtDate(equity.valuationOn)})` : ''}.
                </>
              ) : (
                'no 409A on file yet.'
              )}{' '}
              Internal only: the board sets the strike at grant. The letter never shows a dollar value for the equity.
            </p>
            {equity.strikeEstimate == null && canSeeSection(viewer, 'comp') && (
              <p className="-mb-2 flex flex-wrap items-center gap-x-1.5">
                <a href={links.comp('equity')} className="ft-link inline-flex min-h-10 items-center font-semibold text-accent underline">
                  Record a 409A in Comp and plan &gt; Equity
                </a>
                <span className="text-[12.5px] text-ink-3">(your changes here are kept)</span>
              </p>
            )}
          </div>
        </section>

        <Field label="Start date" hint="Mondays shown. A start date on a holiday moves to the next business day in onboarding.">
          {(id) => <DateChips id={id} label="Start date" value={f.startDate} onChange={(v) => set('startDate', v)} presets={startDatePresets(defaultStartDate(date, holidays))} min={date} weekdaysOnly />}
        </Field>
        <Field label="Offer expires">
          {(id) => <DateChips id={id} label="Offer expires" value={f.expiresOn} onChange={(v) => set('expiresOn', v)} presets={expiryPresets(date, holidays)} min={date} />}
        </Field>

        <section aria-labelledby="ob-employment" className="flex flex-col gap-3">
          <h3 id="ob-employment" className="text-[15px] font-bold text-ink">
            Employment
          </h3>
          <FormGrid>
            <Field label="Employment type">
              {() => <ChipGroup label="Employment type" value={f.employmentType} onChange={pickEmployment} options={EMPLOYMENT_OPTIONS} />}
            </Field>
            <Field label="Hours a week" hint={tried && hoursError ? undefined : 'Whole or half hours, 1 to 60.'} error={tried ? hoursError : undefined}>
              {(id, describedBy) => <NumberInput id={id} aria-describedby={describedBy} min={1} max={60} step={0.5} sensitive={false} value={f.hoursPerWeek} onChange={(v) => set('hoursPerWeek', v)} />}
            </Field>
          </FormGrid>
          {f.employmentType === 'full_time' && f.hoursPerWeek != null && f.hoursPerWeek < 30 && (
            <p className="text-[13px] text-ink-3">Under 30 hours a week, the letter says part-time.</p>
          )}
          <FormGrid>
            <Field label="Work mode">
              {() => <ChipGroup label="Work mode" value={f.workMode} onChange={pickWorkMode} options={WORK_MODE_OPTIONS} />}
            </Field>
            <Field label="Work location" id="ob-location" hint="Sets the work state: the exempt check, the minimum wage and the letter follow it.">
              {(id, describedBy) => (
                <Select id={id} aria-describedby={describedBy} value={f.locationId} onChange={(v) => set('locationId', v)} options={db.locations.map((l) => ({ value: l.id, label: l.name }))} />
              )}
            </Field>
          </FormGrid>
          {drift && (
            <Callout tone={staleLocation ? 'warn' : 'neutral'} icon="pin" title={staleLocation ? "The job's work location changed" : "Not the job's work location"}>
              <span className="block">
                {staleLocation ? drift.message : `The job is ${drift.job}. This offer says ${drift.offer}.`} The letter states the offer&apos;s work location.
              </span>
              <span className="mt-2 flex">
                <Button size="sm" icon="pin" onClick={takeJobLocation}>
                  Use the job&apos;s location
                </Button>
              </span>
            </Callout>
          )}
        </section>

        <section aria-labelledby="ob-flsa" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="ob-flsa" className="text-[15px] font-bold text-ink">
              Exempt check
            </h3>
            <Segmented
              size="sm"
              label="Overtime classification"
              value={f.flsa}
              onChange={pickFlsa}
              options={[
                { value: 'exempt', label: 'Exempt' },
                { value: 'non_exempt', label: 'Non-exempt' },
              ]}
            />
          </div>
          {f.flsa === 'exempt' && (
            <Field label="Exemption">
              {(id) => <Select id={id} value={f.exemptionBasis ?? ''} onChange={(v) => set('exemptionBasis', v)} options={BASIS_OPTIONS} />}
            </Field>
          )}
          <Field label="Pay basis" hint={f.flsa === 'exempt' ? 'Exempt roles are paid a salary. Hourly works only under the computer professional exemption.' : undefined}>
            {(_id, describedBy) => (
              <Segmented
                size="sm"
                label="Pay basis"
                value={f.payType}
                {...(describedBy ? { describedBy } : {})}
                onChange={(v) => {
                  setPayNote(null)
                  setF((x) => ({ ...x, payType: v, ...(v === 'hourly' && !x.hourlyRate && x.salary ? { hourlyRate: snapTo(x.salary / 2080, 0.25) } : {}), ...(v === 'salary' && !x.salary && x.hourlyRate ? { salary: snapTo(x.hourlyRate * 2080, 1000) } : {}) }))
                }}
                options={[
                  { value: 'salary', label: 'Salary' },
                  { value: 'hourly', label: 'Hourly' },
                ]}
              />
            )}
          </Field>
          {payNote && (
            <p role="status" className="-mt-1 text-[13px] text-ink-2">
              <Private>{payNote}</Private>
            </p>
          )}
          {check.status === 'ok' ? (
            <Callout tone="good" title={f.flsa === 'exempt' ? 'Pay meets the California exempt minimum' : 'Non-exempt'}>
              {f.flsa === 'exempt' ? `Checked against the ${db.settings.law.year} floors. Duties tests still apply.` : check.messages.join(' ')}
            </Callout>
          ) : (
            <Callout
              tone="warn"
              title={check.mustBeNonExempt ? 'This pay cannot support an exemption' : check.belowMinWage ? 'Below the minimum wage' : 'Check the classification'}
              action={
                check.mustBeNonExempt ? (
                  <span className="flex flex-col items-stretch gap-2">
                    {f.flsa === 'exempt' && f.payType === 'hourly' && (
                      <Button size="sm" onClick={switchToSalary}>
                        Switch to a salary
                      </Button>
                    )}
                    <Button size="sm" onClick={() => pickFlsa('non_exempt')}>
                      Make it non-exempt
                    </Button>
                  </span>
                ) : undefined
              }
            >
              {check.messages.map((m) => (
                <span key={m} className="mt-1 block">
                  {m}
                </span>
              ))}
              {(check.mustBeNonExempt || check.belowMinWage) && <span className="mt-1 block font-semibold text-ink">You can save the draft, but it cannot be sent until this is fixed.</span>}
            </Callout>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {[...new Map(check.citations.map((c) => [c.label, c])).values()].map((c) => (
              <CitationChip key={c.label} label={c.label} url={c.url} />
            ))}
            <span className="text-[12.5px] text-ink-3">{NOT_LEGAL_ADVICE}</span>
          </div>
          {f.flsa === 'non_exempt' && <p className="text-[13px] text-ink-3">The Labor Code 2810.5 wage notice is prepared with the letter. Give it by the start date.</p>}
        </section>

        {needsReason && (
          <section aria-labelledby="ob-exc" className="flex flex-col gap-2 rounded-xl border border-warn/40 bg-warn-soft px-3.5 py-3">
            <h3 id="ob-exc" className="text-[15px] font-bold text-ink">
              Exception reason {tried && reasonMissing && <span className="text-[13px] font-semibold text-warn">(needed before it goes out)</span>}
            </h3>
            {exceptions.map((e) => (
              <p key={e.field} className="text-[13.5px] text-ink-2">
                <Private>{e.message}</Private>
              </p>
            ))}
            <ChipGroup
              size="sm"
              label="Exception reason"
              value={exceptionReasonChoices().includes(f.exceptionReason) ? f.exceptionReason : null}
              onChange={(v) => set('exceptionReason', v)}
              options={exceptionReasonChoices().map((r) => ({ value: r, label: r }))}
            />
            <Field label="Or in your own words" error={tried && reasonMissing ? 'Pick a reason above or write one here before the offer goes out.' : undefined}>
              {(id, describedBy) => <TextInput id={id} aria-describedby={describedBy} maxLength={500} value={f.exceptionReason} onChange={(e) => set('exceptionReason', e.target.value)} />}
            </Field>
          </section>
        )}

        <Field label="Contingencies">
          {() => <ChipMulti label="Contingencies" values={f.contingencies} onChange={(v) => set('contingencies', v)} options={CONTINGENCY_OPTIONS} />}
        </Field>
        <Field label="Reports to">
          {(id) => <Select id={id} value={f.managerId} onChange={(v) => set('managerId', v)} options={managers.map((p) => ({ value: p.id, label: `${fullName(p)}, ${p.title}` }))} />}
        </Field>
      </div>
    </Sheet>
  )
}
