// The people lifecycle: hire from an accepted offer, change job or pay, protected leave,
// offboarding, and opening a job from a plan line. Mutations take an Immer draft, change it in one
// step and log plain-language activity (no pay or equity amounts and no leave types in activity text, since
// activity can be seen outside Admin). Pure helpers take a DB and a date.
//
// Import order matters: '@/store/db' is imported last and this module keeps no module-level
// constants, because the sample seed calls hireFromOffer while the store module is still loading
// (db.ts -> seed -> hiring -> lifecycle -> db.ts). Function declarations are hoisted, so the cycle
// is safe in the browser; log() also guards the one store call for module runners (vitest) that
// load this file before the store.
import { current, type Draft, isDraft } from 'immer'
import { setTaskStatus, syncCompletedOn } from '@/domain/checklists/actions'
import { finalPayDeadline, vacationPaidAtExit } from '@/domain/checklists/finalPay'
import { links } from '@/app/router'
import { contextFor, generateChecklist, holidayDates, mootAfterExit, onOrBeforeBusinessDay, type TaskOverride } from '@/domain/checklists/generate'
import { TASK_IDS } from '@/domain/checklists/templates'
import { current409A, vestedShares } from '@/domain/equity'
import { isAdminPerson } from '@/domain/hiring/offers'
import { directReports, founder, fullName, headcountOn, priorStint } from '@/domain/people'
import { planSlotForHire } from '@/domain/plan'
import { hoursPerDayFor, requestHours } from '@/domain/timeoff'
import type {
  Checklist,
  ChecklistTask,
  CompReason,
  CompRecord,
  DB,
  EquityGrant,
  ExemptionBasis,
  FLSA,
  ID,
  Job,
  LeaveCase,
  Location,
  Person,
  SeparationType,
} from '@/domain/types'
import { cancelUnstartedInterviews } from '@/domain/hiring/util'
import {
  addBusinessDays,
  addDays,
  addMonths,
  daysBetween,
  fmtDate,
  fmtDay,
  fullMonthsBetween,
  type ISODate,
  nowISO,
  pacificDateOf,
  quarterOf,
  today,
} from '@/lib/dates'
import { num } from '@/lib/format'
import { newId } from '@/lib/id'
import { logActivity } from '@/store/draft'

type Actor = { date: ISODate; actorId?: ID | null; /** Now, for "has this interview started" checks; defaults to date-level. */ nowISO?: string }

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

function log(draft: Draft<DB>, a: Parameters<typeof logActivity>[1], actorId?: ID | null): void {
  try {
    logActivity(draft, a)
  } catch {
    // Only while the store module is still loading and building the sample (the import cycle
    // above, under module runners without live bindings): write the same row directly.
    draft.activity.push({ id: newId('act'), at: nowISO(), actorId: actorId ?? null, ...a })
    return
  }
  if (actorId !== undefined) draft.activity[draft.activity.length - 1].actorId = actorId
}

/** Plain (non-draft) deep copy, safe to place elsewhere in the tree. */
function plain<T>(v: T): T {
  return structuredClone(isDraft(v) ? current(v) : v)
}

export function slugify(s: string): string {
  const slug = s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'x'
}

function uniqueId(candidates: string[], taken: Set<string>): string {
  for (const c of candidates) if (!taken.has(c)) return c
  const base = candidates[0]
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
}

/** A personal mail provider: an address there says nothing about the company's own domain. */
function isFreeMailDomain(domain: string): boolean {
  return [
    'gmail.com',
    'googlemail.com',
    'outlook.com',
    'hotmail.com',
    'live.com',
    'msn.com',
    'yahoo.com',
    'icloud.com',
    'me.com',
    'mac.com',
    'aol.com',
    'proton.me',
    'protonmail.com',
    'fastmail.com',
    'hey.com',
    'gmx.com',
  ].includes(domain)
}

/**
 * The company's email domain: 'ledgerlark.com' from the website, else the domain of the founder's work
 * email (unless it is a personal mail provider), else null. Never guessed from the company name, so a
 * new hire never gets an address on a domain the company may not own.
 */
export function companyDomain(company: { website?: string }, founderEmail?: string | null): string | null {
  const site = company.website?.trim()
  if (site) {
    const host = site.replace(/^[a-z]+:\/\//i, '').replace(/^www\./i, '').split(/[/?#]/)[0].toLowerCase()
    if (host) return host
  }
  const fromEmail = founderEmail?.trim().toLowerCase().split('@')[1]
  if (fromEmail && fromEmail.includes('.') && !isFreeMailDomain(fromEmail)) return fromEmail
  return null
}

/** Two-letter code for a US state name or code, or undefined. */
export function stateCode(s: string): string | undefined {
  const states: Record<string, string> = {
    alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
    delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
    illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME',
    maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
    montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
    'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
    pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN',
    texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV',
    wisconsin: 'WI', wyoming: 'WY',
  }
  const t = s.trim().replace(/\./g, '')
  if (/^[a-z]{2}$/i.test(t)) {
    const code = t.toUpperCase()
    return Object.values(states).includes(code) ? code : undefined
  }
  return states[t.toLowerCase()]
}

/** 'Sunnyvale, CA' or 'Austin, Texas, USA' -> { city, state }. Unparseable parts come back undefined. */
export function parseCityState(location: string | undefined): { city?: string; state?: string } {
  if (!location) return {}
  const parts = location
    .split(',')
    .map((p) => p.trim().replace(/\s*\d{5}(-\d{4})?$/, ''))
    .filter((p) => p && !/^(usa|us|united states)$/i.test(p))
  if (parts.length === 0) return {}
  if (parts.length === 1) {
    const st = stateCode(parts[0])
    return st ? { state: st } : {}
  }
  const state = stateCode(parts[parts.length - 1])
  return state ? { city: parts[0], state } : { city: parts[0] }
}

/**
 * Where a new hire works from. Remote: the candidate's own city and state when parseable. Onsite or
 * hybrid: their city if it is in the office's state (they commute), else the office (they relocate).
 */
function homeFor(candidateLocation: string | undefined, workMode: Person['workMode'], loc: Location | undefined): { homeCity?: string; homeState: string } {
  const parsed = parseCityState(candidateLocation)
  const officeState = loc?.state || 'CA'
  if (workMode === 'remote') {
    if (parsed.state) return { homeCity: parsed.city, homeState: parsed.state }
    return { homeCity: loc?.city, homeState: officeState }
  }
  if (parsed.state && parsed.state === officeState) return { homeCity: parsed.city, homeState: parsed.state }
  return { homeCity: loc?.city ?? parsed.city, homeState: officeState }
}

/** The change reason in a sentence, as activity and toasts say it: 'Recorded a merit increase for ...'. */
export function compReasonLabel(r: CompReason): string {
  switch (r) {
    case 'hire':
      return 'hire'
    case 'promotion':
      return 'promotion'
    case 'merit':
      return 'merit increase'
    case 'market':
      return 'market adjustment'
    case 'title_only':
      return 'title change'
    case 'manager_change':
      return 'manager change'
    case 'transfer':
      return 'transfer'
    case 'correction':
      return 'correction'
  }
}

function separationLabel(t: SeparationType): string {
  switch (t) {
    case 'resigned_notice':
      return 'resigned with notice'
    case 'resigned_no_notice':
      return 'resigned without notice'
    case 'terminated':
      return 'terminated'
    case 'laid_off':
      return 'laid off'
    case 'contract_ended':
      return 'contract ended'
  }
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

// ---------------------------------------------------------------------------------------------
// Hire
// ---------------------------------------------------------------------------------------------

export type HirePreview = {
  /** The offer's start date, where both counts are taken. */
  date: ISODate
  headcountBefore: number
  headcountAfter: number
  /** Thresholds (5, 15, 20) this hire reaches. */
  crossesThresholds: number[]
}

/** Headcount on the start date without and with this hire, and the thresholds it crosses. */
export function hirePreview(db: DB, offerId: ID): HirePreview {
  const offer = db.offers.find((o) => o.id === offerId)
  if (!offer) throw new Error(`No offer with id ${offerId}`)
  const date = offer.startDate
  const count = headcountOn(db, date)
  const already = offer.personId ? db.people.find((p) => p.id === offer.personId) : undefined
  const counted = !!already && already.startDate <= date && (!already.endDate || already.endDate >= date)
  const headcountBefore = counted ? count - 1 : count
  const headcountAfter = headcountBefore + 1
  return {
    date,
    headcountBefore,
    headcountAfter,
    crossesThresholds: [5, 15, 20].filter((t) => headcountBefore < t && headcountAfter >= t),
  }
}

/**
 * The payroll task for a sign-on bonus promised in the offer letter ("paid with your first regular
 * paycheck"). No amount in the title or note: managers see their reports' checklists, never their pay.
 */
function signOnBonusTask(checklist: Pick<Checklist, 'id'>, start: ISODate, candidateId: ID): ChecklistTask {
  const suffix = checklist.id.startsWith('ck-') ? checklist.id.slice(3) : checklist.id
  return {
    id: `t-${suffix}-${TASK_IDS.signOnBonus}`,
    templateTaskId: TASK_IDS.signOnBonus,
    title: 'Add the sign-on bonus from the offer to the first paycheck',
    why: 'The offer letter promised a one-time sign-on bonus with the first regular paycheck. The amount is on the accepted offer.',
    ownerRole: 'admin',
    assigneeId: null,
    dueOn: start,
    dueRuleText: 'On the start date',
    status: 'open',
    category: 'payroll',
    statutory: false,
    link: links.candidate(candidateId),
  }
}

/**
 * Turns an accepted offer into employee #N: person, hire comp record, a grant queued for board
 * consent, onboarding (and new-state) checklists, the application marked Hired, the job filled when
 * nothing else is outstanding, the plan line filled (or a filled line added for a job outside the
 * plan), the referral bonus dated and the signed offer letter recorded. A sign-on bonus in the offer
 * becomes a payroll task on the onboarding checklist. Returns the new person id (or the existing one
 * if the offer was already hired).
 */
export function hireFromOffer(draft: Draft<DB>, offerId: ID, opts: Actor): ID {
  const db = draft as DB
  const { date, actorId } = opts
  const offer = draft.offers.find((o) => o.id === offerId)
  if (!offer) throw new Error(`No offer with id ${offerId}`)
  if (offer.personId && draft.people.some((p) => p.id === offer.personId)) return offer.personId
  if (offer.status !== 'accepted') throw new Error('Only an accepted offer can become a hire. Mark the offer accepted first.')
  const candidate = draft.candidates.find((c) => c.id === offer.candidateId)
  if (!candidate) throw new Error(`No candidate with id ${offer.candidateId}`)
  const app = draft.applications.find((a) => a.id === offer.applicationId)
  const job = draft.jobs.find((j) => j.id === offer.jobId)
  const loc = draft.locations.find((l) => l.id === offer.locationId)
  const start = offer.startDate

  // Person
  const first = slugify(candidate.firstName)
  const last = slugify(candidate.lastName)
  const personId = uniqueId([`p-${first}`, `p-${first}-${last}`], new Set(draft.people.map((p) => p.id)))
  // No known domain (no website, no founder work email on one): left empty for Admin to fill in.
  const domain = companyDomain(draft.company, founder(db)?.workEmail)
  const local = first.replace(/-/g, '')
  const takenEmails = new Set(draft.people.map((p) => p.workEmail.toLowerCase()))
  const workEmail = !domain
    ? ''
    : ([`${local}@${domain}`, `${local}.${last.replace(/-/g, '')}@${domain}`].find((e) => !takenEmails.has(e)) ??
      `${local}.${last.replace(/-/g, '')}.${draft.people.length + 1}@${domain}`)
  const bc = offer.backgroundCheck
  const cleared = bc?.status === 'complete' && (bc.result === 'clear' || bc.fairChance?.decision === 'proceed')
  const needsCheck = !!job?.backgroundCheck || offer.contingencies.includes('background_check') || !!bc
  const hireNumber = draft.people.reduce((m, p) => Math.max(m, p.hireNumber), 0) + 1
  const home = homeFor(candidate.location, offer.workMode, loc)
  const person: Person = {
    id: personId,
    firstName: candidate.firstName,
    lastName: candidate.lastName,
    workEmail,
    personalEmail: candidate.email,
    title: offer.title,
    departmentId: offer.departmentId,
    familyId: offer.familyId,
    levelId: offer.levelId,
    managerId: offer.managerId ?? null,
    locationId: offer.locationId,
    workMode: offer.workMode,
    homeState: home.homeState,
    employmentType: offer.employmentType,
    hoursPerWeek: offer.hoursPerWeek ?? (offer.employmentType === 'part_time' ? 20 : 40),
    flsa: offer.flsa,
    startDate: start,
    endDate: null,
    hireNumber,
    fromCandidateId: candidate.id,
    fromApplicationId: offer.applicationId,
    emergencyContacts: [],
    backgroundCheck: cleared
      ? { status: 'clear', ...(bc?.completedOn ? { completedOn: bc.completedOn } : {}) }
      : { status: needsCheck ? 'pending' : 'not_required' },
  }
  if (home.homeCity) person.homeCity = home.homeCity
  if (candidate.phone) person.phone = candidate.phone
  // A former employee coming back: link the records (sick leave left at exit is restored within 12 months).
  const prior = priorStint(db, person)
  if (prior) person.rehireOfPersonId = prior.id
  if (offer.flsa === 'exempt' && offer.exemptionBasis) person.exemptionBasis = offer.exemptionBasis
  draft.people.push(person)

  // Effective-dated job and pay
  const approval = [...offer.approvals].reverse().find((a) => a.decision === 'approved')
  const comp: CompRecord = {
    id: newId('cr'),
    personId,
    effectiveOn: start,
    payType: offer.payType,
    title: offer.title,
    levelId: offer.levelId,
    managerId: offer.managerId ?? null,
    departmentId: offer.departmentId,
    flsa: offer.flsa,
    reason: 'hire',
    appliedOn: date,
  }
  if (offer.payType === 'salary' && offer.salary != null) comp.salary = offer.salary
  if (offer.payType === 'hourly' && offer.hourlyRate != null) comp.hourlyRate = offer.hourlyRate
  if (offer.variablePct != null) comp.variablePct = offer.variablePct
  if (offer.exceptionReason) comp.exceptionReason = offer.exceptionReason
  if (offer.flsa === 'exempt' && offer.exemptionBasis) comp.exemptionBasis = offer.exemptionBasis
  if (approval) {
    comp.approvedById = approval.approverId
    // The Pacific calendar day of the approval (a UTC slice would date evening approvals tomorrow).
    comp.approvedOn = pacificDateOf(approval.at)
  } else if (offer.draftedById && (offer.draftedByRole === 'admin' || (!offer.draftedByRole && isAdminPerson(db, offer.draftedById)))) {
    // Drafted by Admin, which needs no separate approval: the drafter approved it by sending it.
    comp.approvedById = offer.draftedById
    const on = offer.sentOn ?? offer.decidedOn
    if (on) comp.approvedOn = on
  }
  // The amount stays on the offer: comp notes are plain text, outside the privacy blur.
  if ((offer.signOnBonus ?? 0) > 0) comp.note = 'Sign-on bonus in the offer, paid with the first paycheck. The amount is on the accepted offer.'
  draft.comp.push(comp)

  // Equity: convert the offer's reserved grant (synced to the accepted offer, which may have been
  // revised since the reservation), or queue a new one at the current 409A
  const reserved = draft.grants.find((g) => g.fromOfferId === offer.id && (g.status === 'reserved' || g.status === 'promised'))
  if (offer.equityShares <= 0 && reserved) {
    // The accepted version dropped the equity: the reservation lapses.
    reserved.status = 'cancelled'
    reserved.cancelledShares = reserved.shares
    reserved.cancelledOn = date
  }
  if (offer.equityShares > 0) {
    if (reserved) {
      reserved.status = 'promised'
      reserved.personId = personId
      reserved.holderType = 'employee'
      reserved.type = offer.equityType
      reserved.shares = offer.equityShares
      reserved.vestingStart = start
      reserved.cliffMonths = offer.cliffMonths
      reserved.vestingMonths = offer.vestingMonths
      reserved.strikePrice = current409A(db, date)?.fmvPerShare ?? reserved.strikePrice
      if (!reserved.proposedOn) reserved.proposedOn = date
    } else {
      draft.grants.push({
        id: newId('g'),
        personId,
        holderType: 'employee',
        type: offer.equityType,
        shares: offer.equityShares,
        strikePrice: current409A(db, date)?.fmvPerShare ?? 0,
        vestingStart: start,
        cliffMonths: offer.cliffMonths,
        vestingMonths: offer.vestingMonths,
        status: 'promised',
        proposedOn: date,
        exercisedShares: 0,
        postTerminationExerciseDays: 90,
        fromOfferId: offer.id,
      })
    }
  }

  // Checklists
  const overrides: Record<ID, TaskOverride> = {}
  if (cleared) {
    overrides[TASK_IDS.backgroundCheck] = { status: 'done', doneOn: bc?.completedOn ?? date, note: 'Cleared before the hire was recorded.' }
  }
  const outsideCA = person.homeState.toUpperCase() !== 'CA'
  const sameState = outsideCA
    ? draft.people.find((p) => p.id !== personId && p.homeState === person.homeState && (!p.endDate || p.endDate >= start))
    : undefined
  if (sameState) {
    overrides[TASK_IDS.newStatePointer] = {
      note: `${person.homeState} is already set up (${fullName(sameState)} works there). Confirm the state notices and sick leave rules.`,
    }
  }
  const onboarding = generateChecklist(db, { person, templateId: 'tpl-onboarding', anchorDate: start, createdOn: date, overrides })
  if ((offer.signOnBonus ?? 0) > 0) {
    onboarding.tasks.push(signOnBonusTask(onboarding, start, candidate.id))
    onboarding.tasks.sort((a, b) => a.dueOn.localeCompare(b.dueOn))
  }
  draft.checklists.push(onboarding)
  if (outsideCA && !sameState) {
    draft.checklists.push(generateChecklist(db, { person, templateId: 'tpl-new-state', anchorDate: start, createdOn: date }))
  }

  // Application, job and plan line
  if (app) {
    const hiredStage = job?.stages.find((s) => s.kind === 'hired')?.id ?? 'hired'
    app.status = 'hired'
    app.stageId = hiredStage
    app.stageEnteredOn = date
    app.history.push(actorId ? { stageId: hiredStage, at: date, byId: actorId } : { stageId: hiredStage, at: date })
    app.closedOn = date
    if (!app.conditionalOfferOn) app.conditionalOfferOn = offer.decidedOn ?? date
    delete app.nextStep
    delete app.snoozedUntil
    // Interviews still on the calendar come off it, with the scorecards nobody needs to write now.
    cancelUnstartedInterviews(draft, app.id, date, opts.nowISO ?? (date === today() ? nowISO() : undefined))
  }
  if (job) {
    const outstanding = draft.offers.some(
      (o) =>
        o.jobId === job.id &&
        o.id !== offer.id &&
        (o.status === 'draft' || o.status === 'awaiting_approval' || o.status === 'approved' || o.status === 'sent' || (o.status === 'accepted' && !o.personId)),
    )
    if (!outstanding) {
      job.status = 'filled'
      job.closedOn = date
    }
  }
  // The job's line only while nobody holds it: a second hire from the same job gets a line of their own.
  const slot = planSlotForHire(db, offer, job)
  if (slot) {
    slot.status = 'filled'
    slot.personId = personId
  } else if (!(prior && draft.plan.some((s) => s.personId === prior.id))) {
    // A hire from a job outside the plan still lands on it as a filled line (SPEC: ONE-CLICK HIRE). A
    // rehire whose earlier stint already fills a line takes that seat back instead of adding one.
    draft.plan.push({
      id: newId('ps'),
      quarter: quarterOf(start),
      title: offer.title,
      departmentId: offer.departmentId,
      familyId: offer.familyId,
      levelId: offer.levelId,
      targetStart: start,
      status: 'filled',
      jobId: job?.id ?? null,
      personId,
      rationale: 'Hired outside the plan; added when the hire was recorded.',
    })
  }

  // Referral bonus
  if (candidate.referrerId) {
    const bonusAmount = job?.referralBonus ?? draft.settings.referralBonusDefault
    const payableOn = addDays(start, draft.settings.referralBonusPayableDays)
    const existing = draft.referrals.find((r) => r.candidateId === candidate.id)
    if (existing) {
      if (!existing.paidOn) {
        existing.payableOn = payableOn
        existing.bonusAmount = bonusAmount
      }
    } else {
      draft.referrals.push({ id: newId('ref'), candidateId: candidate.id, referrerId: candidate.referrerId, bonusAmount, payableOn })
    }
  }

  offer.personId = personId
  draft.documents.push({
    id: newId('doc'),
    personId,
    type: 'offer_letter',
    name: `Offer letter, version ${offer.version}`,
    status: 'signed',
    date: offer.decidedOn ?? date,
  })

  const name = fullName(person)
  log(
    draft,
    {
      entityType: 'person',
      entityId: personId,
      relatedId: candidate.id,
      kind: 'hired',
      text: `Hired ${name} as ${offer.title}, employee #${hireNumber}, starting ${fmtDay(start)}`,
    },
    actorId,
  )
  if (app) {
    log(draft, { entityType: 'application', entityId: app.id, relatedId: candidate.id, kind: 'hired', text: `Moved ${name} to Hired` }, actorId)
  }
  return personId
}

// ---------------------------------------------------------------------------------------------
// Offboarding
// ---------------------------------------------------------------------------------------------

export type SeparationInput = {
  type: SeparationType
  reason: string
  lastDay: ISODate
  noticeGivenOn?: ISODate
  rehireEligible?: boolean
}

/**
 * Retention after an exit: personnel records 4 years (Gov Code 12946; Labor Code 1198.5 is 3),
 * payroll records 3 years (Labor Code 226, 1174), I-9 the later of hire + 3 years or exit + 1 year.
 */
export function retentionDates(person: Pick<Person, 'startDate'>, lastDay: ISODate): {
  personnelUntil: ISODate
  payrollUntil: ISODate
  i9Until: ISODate
} {
  const hire3 = addMonths(person.startDate, 36)
  const exit1 = addMonths(lastDay, 12)
  return {
    personnelUntil: addMonths(lastDay, 48),
    payrollUntil: addMonths(lastDay, 36),
    i9Until: hire3 > exit1 ? hire3 : exit1,
  }
}

export type ExitCleanup = {
  tasksClosed: number
  trainingsRemoved: number
  leaveCasesEnded: number
  /** Job and pay changes scheduled after the last day, removed because they can never take effect. */
  scheduledChangesCancelled: number
  /** What those changes were, for the summary ("Cancelled the promotion scheduled for Nov 1, 2026"). */
  cancelledChanges: Array<{ effectiveOn: ISODate; reason: CompReason }>
  /** Pending and approved time off that starts after the last day, cancelled. */
  timeOffCancelled: number
  /** Time off that runs past the last day, shortened to end on it. */
  timeOffShortened: number
  /** Open manager tasks the leaver held on their reports' checklists, handed to each report's manager field. */
  managerTasksHandedOff: number
}

function noCleanup(): ExitCleanup {
  return {
    tasksClosed: 0,
    trainingsRemoved: 0,
    leaveCasesEnded: 0,
    scheduledChangesCancelled: 0,
    cancelledChanges: [],
    timeOffCancelled: 0,
    timeOffShortened: 0,
    managerTasksHandedOff: 0,
  }
}

/**
 * Removes the person's job and pay changes scheduled after the last day (they never take effect, so the
 * synced history must not show them) and settles each one's change checklist: removed when nothing on
 * it was done, else its open tasks become not applicable. Supervisor training that only the cancelled
 * change made someone owe goes too.
 */
function cancelChangesAfterExit(draft: Draft<DB>, person: Draft<Person>, lastDay: ISODate, date: ISODate, cleanup: ExitCleanup): void {
  const note = `Cancelled: last day is ${fmtDate(lastDay)}.`
  for (let i = draft.comp.length - 1; i >= 0; i--) {
    const c = draft.comp[i]
    if (c.personId !== person.id || !c.scheduled || c.appliedOn || c.effectiveOn <= lastDay) continue
    cleanup.cancelledChanges.push({ effectiveOn: c.effectiveOn, reason: c.reason })
    draft.comp.splice(i, 1)
  }
  cleanup.cancelledChanges.sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn))
  cleanup.scheduledChangesCancelled = cleanup.cancelledChanges.length
  const dates = new Set(cleanup.cancelledChanges.map((c) => c.effectiveOn))
  for (let i = draft.checklists.length - 1; i >= 0; i--) {
    const checklist = draft.checklists[i]
    if (checklist.personId !== person.id || checklist.kind !== 'change' || !dates.has(checklist.anchorDate)) continue
    const settled = settleCancelledChangeChecklist(draft, i, note, date)
    if (settled.trainingRemoved) cleanup.trainingsRemoved += 1
    cleanup.tasksClosed += settled.tasksClosed
  }
}

/**
 * Settles the change checklist of a job or pay change that will never take effect: removed when nothing on
 * it was done, else its open tasks become not applicable with `note`. Supervisor training that only this
 * change made someone owe (the trainee has no other reports) is removed from the tracker too.
 */
function settleCancelledChangeChecklist(draft: Draft<DB>, index: number, note: string, date: ISODate): { removed: boolean; tasksClosed: number; trainingRemoved: boolean } {
  const checklist = draft.checklists[index]
  let trainingRemoved = false
  const training = checklist.tasks.find((t) => t.templateTaskId === TASK_IDS.supervisorTraining && t.status === 'open' && t.assigneeId)
  const traineeId = training?.assigneeId
  if (training && traineeId && directReports(draft as DB, traineeId, date).every((r) => r.id === checklist.personId)) {
    const at = draft.trainings.findIndex((t) => t.personId === traineeId && t.kind === 'harassment_supervisor' && !t.completedOn && t.dueOn === training.dueOn)
    if (at >= 0) {
      draft.trainings.splice(at, 1)
      trainingRemoved = true
    }
  }
  if (!checklist.tasks.some((t) => t.status === 'done')) {
    draft.checklists.splice(index, 1)
    return { removed: true, tasksClosed: 0, trainingRemoved }
  }
  let tasksClosed = 0
  for (const task of checklist.tasks) {
    if (task.status !== 'open') continue
    task.status = 'not_applicable'
    task.note = task.note ? `${task.note} ${note}` : note
    tasksClosed += 1
  }
  syncCompletedOn(checklist, date)
  return { removed: false, tasksClosed, trainingRemoved }
}

/**
 * Time off after the last day never happens: pending and approved requests that start after it are
 * cancelled (out of approval queues and the who's-out calendar), and one that runs past it is shortened
 * to end on it, with its hours counted again over the days that are left.
 */
function cancelTimeOffAfterExit(draft: Draft<DB>, person: Draft<Person>, lastDay: ISODate, date: ISODate, cleanup: ExitCleanup): void {
  for (const r of draft.timeOffRequests) {
    if (r.personId !== person.id || (r.status !== 'pending' && r.status !== 'approved')) continue
    if (r.startDate > lastDay) {
      r.status = 'cancelled'
      r.decidedOn = date
      r.decisionNote = `Cancelled: last day is ${fmtDate(lastDay)}.`
      cleanup.timeOffCancelled += 1
    } else if (r.endDate > lastDay) {
      r.endDate = lastDay
      // A half day was the old last day off; the new last day is a full one.
      delete r.partial
      r.hours = requestHours(r.startDate, lastDay, draft.holidays, undefined, hoursPerDayFor(person))
      const shortened = `Shortened to end on the last day, ${fmtDate(lastDay)}.`
      r.decisionNote = r.decisionNote ? `${r.decisionNote} ${shortened}` : shortened
      cleanup.timeOffShortened += 1
    }
  }
}

/**
 * Closes what an exit makes moot. Job and pay changes scheduled after the last day are removed with
 * their change checklists, and time off after it is cancelled (or shortened to end on it). Open tasks
 * on the person's other checklists (onboarding, new state, change, leave) that fall due after the last
 * day become not applicable, except obligations that survive an early exit (I-9, new hire report, ACA
 * notice); if they never started, all of them close. Pending trainings due after the last day are
 * removed and an open leave case ends on it. A refresh grant queued with a cancelled change is still
 * promised, so startOffboarding's equity step cancels it with every other ungranted promise.
 * Open manager tasks the leaver holds on other people's checklists lose their assignee, so each follows
 * that person's manager field (taskOwnerId): the leaver until the reassignment lands, then the new manager
 * (reassignReportsAtExit hands the ones due from that day to the new manager at once).
 */
export function closeForExit(draft: Draft<DB>, personId: ID, lastDay: ISODate, date: ISODate): ExitCleanup {
  const person = draft.people.find((p) => p.id === personId)
  const cleanup = noCleanup()
  if (!person) return cleanup
  cancelChangesAfterExit(draft, person, lastDay, date, cleanup)
  cancelTimeOffAfterExit(draft, person, lastDay, date, cleanup)
  const neverStarted = lastDay < person.startDate
  const leaving = { startDate: person.startDate, endDate: lastDay }
  const note = neverStarted ? `Left on ${fmtDate(lastDay)}, before the start date.` : `Left on ${fmtDate(lastDay)}.`
  for (const checklist of draft.checklists) {
    const own = checklist.personId === personId
    if (own && checklist.kind === 'offboarding') continue
    let changed = false
    for (const task of checklist.tasks) {
      if (task.status !== 'open') continue
      if (!own && task.ownerRole === 'manager' && task.assigneeId === personId) {
        task.assigneeId = null
        cleanup.managerTasksHandedOff += 1
        continue
      }
      if (checklist.kind === 'offboarding') continue
      // Their own tasks, plus supervisor training they owe on a report's change checklist
      const moot = own
        ? mootAfterExit(checklist, task, leaving)
        : task.templateTaskId === TASK_IDS.supervisorTraining && task.assigneeId === personId && (neverStarted || task.dueOn > lastDay)
      if (!moot) continue
      task.status = 'not_applicable'
      task.note = task.note ? `${task.note} ${note}` : note
      changed = true
      cleanup.tasksClosed += 1
    }
    if (changed) syncCompletedOn(checklist, date)
  }
  for (let i = draft.trainings.length - 1; i >= 0; i--) {
    const t = draft.trainings[i]
    if (t.personId === personId && !t.completedOn && (neverStarted || t.dueOn > lastDay)) {
      draft.trainings.splice(i, 1)
      cleanup.trainingsRemoved += 1
    }
  }
  for (const lc of draft.leaveCases) {
    if (lc.personId !== personId || lc.returnedOn || lc.endedOn) continue
    lc.endedOn = lastDay
    cleanup.leaveCasesEnded += 1
  }
  return cleanup
}

/**
 * Plain sentences for what an exit closed, for the offboarding summary: "Cancelled the promotion
 * scheduled for Nov 1, 2026." Counts only, never pay amounts or leave types.
 */
export function exitCleanupLines(cleanup: ExitCleanup): string[] {
  const lines = cleanup.cancelledChanges.map((c) => `Cancelled the ${compReasonLabel(c.reason)} scheduled for ${fmtDate(c.effectiveOn)}.`)
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
  if (cleanup.timeOffCancelled > 0) lines.push(`Cancelled ${n(cleanup.timeOffCancelled, 'time off request', 'time off requests')} after the last day.`)
  if (cleanup.timeOffShortened > 0) lines.push(`Shortened ${n(cleanup.timeOffShortened, 'time off request', 'time off requests')} to end on the last day.`)
  if (cleanup.tasksClosed > 0) lines.push(`Closed ${n(cleanup.tasksClosed, 'open task', 'open tasks')} due after the last day.`)
  if (cleanup.managerTasksHandedOff > 0) {
    lines.push(`Handed ${n(cleanup.managerTasksHandedOff, 'open manager task', 'open manager tasks')} for their reports to each report's next manager.`)
  }
  if (cleanup.trainingsRemoved > 0) lines.push(`Removed ${n(cleanup.trainingsRemoved, 'pending training', 'pending trainings')}.`)
  if (cleanup.leaveCasesEnded > 0) lines.push('Ended the open leave case on the last day.')
  return lines
}

export type OffboardingResult = { checklistId: ID; cleanup: ExitCleanup }

/**
 * Records a separation: end date, final pay deadline, vested options and exercise deadline,
 * unvested options returned to the pool, document retention dates, the offboarding checklist, and
 * the cleanup of changes, time off, tasks, trainings and leave the exit makes moot (closeForExit).
 * Returns the checklist id.
 */
export function startOffboarding(draft: Draft<DB>, personId: ID, sep: SeparationInput, opts: Actor): ID {
  return offboardPerson(draft, personId, sep, opts).checklistId
}

/** startOffboarding, also returning what the exit closed (closeForExit) for the wizard's summary. */
export function offboardPerson(draft: Draft<DB>, personId: ID, sep: SeparationInput, opts: Actor): OffboardingResult {
  const db = draft as DB
  const { date, actorId } = opts
  const person = draft.people.find((p) => p.id === personId)
  if (!person) throw new Error(`No person with id ${personId}`)
  // Same separation recorded twice (a double click): keep the first checklist.
  const existing = draft.checklists.find(
    (c) => c.personId === personId && c.kind === 'offboarding' && c.anchorDate === sep.lastDay && c.separationType === sep.type,
  )
  if (existing && person.separation?.lastDay === sep.lastDay) return { checklistId: existing.id, cleanup: noCleanup() }
  const fp = finalPayDeadline(sep.type, sep.lastDay, sep.noticeGivenOn)

  // Equity: vested options stay exercisable; unvested ones return to the pool
  const hadEquity = draft.grants.some((g) => g.personId === personId && g.status !== 'cancelled')
  let vestedLeft = 0
  let returned = 0
  let exerciseDays: number | null = null
  for (const g of draft.grants) {
    if (g.personId !== personId || g.status === 'cancelled') continue
    if (g.status === 'approved') {
      const vested = vestedShares(g, sep.lastDay)
      const left = Math.max(0, vested - (g.exercisedShares ?? 0))
      vestedLeft += left
      if (left > 0) {
        const days = g.postTerminationExerciseDays ?? 90
        exerciseDays = exerciseDays == null ? days : Math.min(exerciseDays, days)
      }
      const unvested = g.shares - vested
      if (unvested > 0) {
        g.cancelledShares = unvested
        g.cancelledOn = sep.lastDay
        returned += unvested
      }
      if (vested === 0) g.status = 'cancelled'
    } else {
      // reserved or promised: never granted, so the promise lapses
      g.status = 'cancelled'
      g.cancelledShares = g.shares
      g.cancelledOn = sep.lastDay
      returned += g.shares
    }
  }
  const exerciseDeadline = vestedLeft > 0 ? addDays(sep.lastDay, exerciseDays ?? 90) : undefined

  person.endDate = sep.lastDay
  person.separation = {
    type: sep.type,
    reason: sep.reason,
    lastDay: sep.lastDay,
    finalPayDueOn: fp.dueOn,
    vestedAtSeparation: vestedLeft,
  }
  if (sep.noticeGivenOn) person.separation.noticeGivenOn = sep.noticeGivenOn
  if (sep.rehireEligible !== undefined) person.separation.rehireEligible = sep.rehireEligible
  if (exerciseDeadline) person.separation.exerciseDeadline = exerciseDeadline

  // Retention dates on the person's document records
  const keep = retentionDates(person, sep.lastDay)
  for (const d of draft.documents) {
    if (d.personId !== personId) continue
    d.retainUntil = d.type === 'i9_section1' || d.type === 'i9_section2' ? keep.i9Until : keep.personnelUntil
  }

  // Tasks, trainings and leave the exit makes moot
  const cleanup = closeForExit(draft, personId, sep.lastDay, date)

  // Checklist
  const overrides: Record<ID, TaskOverride> = {}
  const payText = fp.rule === 'within_72_hours' ? 'Within 72 hours of the last day' : 'Last day'
  for (const id of TASK_IDS.finalPay) overrides[id] = { dueOn: fp.dueOn, dueRuleText: payText }
  if (sep.type === 'resigned_notice' && fp.rule === 'within_72_hours') {
    overrides['off-final-pay-notice'] = { dueOn: fp.dueOn, dueRuleText: payText, title: 'Final paycheck paid within 72 hours', why: fp.detail }
  }
  overrides[TASK_IDS.vacationPayout] = vacationPaidAtExit(db.timeOffPolicies, person)
    ? { dueOn: fp.dueOn, dueRuleText: payText }
    : {
        dueOn: fp.dueOn,
        dueRuleText: payText,
        status: 'not_applicable',
        note: 'No accrued vacation policy covers this person, and truly unlimited flexible vacation pays nothing at exit.',
      }
  if (sep.lastDay < person.startDate) {
    // Never started work: no wages were earned and no coverage began.
    const none: TaskOverride = { status: 'not_applicable', note: 'Did not start work, so there are no final wages, notices or coverage.' }
    for (const id of [...TASK_IDS.finalPay, TASK_IDS.vacationPayout, ...TASK_IDS.separationNotices]) overrides[id] = { ...overrides[id], ...none }
  }
  // Who reports to them the day after the last day, by the job history: a move already scheduled away
  // from them is left out, and someone scheduled to move to them before then is in.
  const reports = reportsAsOf(db, personId, addDays(sep.lastDay, 1))
  if (reports.length) overrides[TASK_IDS.reassignReports] = { note: `Reassign ${joinNames(reports.map(fullName))}.` }
  if (vestedLeft > 0 || returned > 0) {
    // No share counts: managers can see a report's checklist but never their equity.
    const parts: string[] = []
    if (vestedLeft > 0 && exerciseDeadline) parts.push(`Vested options can be exercised until ${fmtDate(exerciseDeadline)}.`)
    if (returned > 0) parts.push('Unvested options return to the pool.')
    parts.push('Share counts are on the Equity tab.')
    overrides[TASK_IDS.exitNote] = { note: parts.join(' ') }
  }
  if (sep.rehireEligible !== undefined) {
    overrides[TASK_IDS.rehire] = { status: 'done', doneOn: date, note: `Rehire eligible: ${sep.rehireEligible ? 'yes' : 'no'}.` }
  }
  overrides[TASK_IDS.retention] = {
    status: 'done',
    doneOn: date,
    note: `Personnel records until ${fmtDate(keep.personnelUntil)}; I-9 until ${fmtDate(keep.i9Until)}.`,
  }
  const checklist = generateChecklist(db, {
    person,
    templateId: 'tpl-offboarding',
    anchorDate: sep.lastDay,
    createdOn: date,
    separationType: sep.type,
    // Judge equity by what they held before the unvested part was cancelled above, and reports by who
    // still reports to them at the exit.
    extra: { hasEquity: hadEquity, supervisor: reports.length > 0 },
    overrides,
  })
  draft.checklists.push(checklist)

  const name = fullName(person)
  log(
    draft,
    {
      entityType: 'person',
      entityId: personId,
      kind: 'offboarding_started',
      text: `Started offboarding for ${name}: ${separationLabel(sep.type)}, last day ${fmtDay(sep.lastDay)}`,
    },
    actorId,
  )
  if (returned > 0) {
    log(draft, { entityType: 'equity', entityId: personId, kind: 'options_returned', text: `Returned unvested options from ${name} to the pool` }, actorId)
  }
  if (cleanup.tasksClosed > 0 || cleanup.trainingsRemoved > 0 || cleanup.leaveCasesEnded > 0) {
    const parts: string[] = []
    if (cleanup.tasksClosed > 0) parts.push(`${cleanup.tasksClosed} open ${cleanup.tasksClosed === 1 ? 'task' : 'tasks'}`)
    if (cleanup.trainingsRemoved > 0) parts.push(`${cleanup.trainingsRemoved} pending ${cleanup.trainingsRemoved === 1 ? 'training' : 'trainings'}`)
    if (cleanup.leaveCasesEnded > 0) parts.push('the open leave case')
    log(
      draft,
      { entityType: 'person', entityId: personId, kind: 'exit_cleanup', text: `Closed ${joinNames(parts)} for ${name} after the exit on ${fmtDay(sep.lastDay)}` },
      actorId,
    )
  }
  const requests = (count: number) => `${count} time off ${count === 1 ? 'request' : 'requests'}`
  const cancelled = cleanup.cancelledChanges.map((c) => `the ${compReasonLabel(c.reason)} scheduled for ${fmtDate(c.effectiveOn)}`)
  if (cleanup.timeOffCancelled > 0) cancelled.push(requests(cleanup.timeOffCancelled))
  if (cancelled.length > 0) {
    log(
      draft,
      { entityType: 'person', entityId: personId, kind: 'exit_cleanup', text: `Cancelled ${joinNames(cancelled)} for ${name} after the exit on ${fmtDay(sep.lastDay)}` },
      actorId,
    )
  }
  if (cleanup.timeOffShortened > 0) {
    log(
      draft,
      { entityType: 'person', entityId: personId, kind: 'exit_cleanup', text: `Shortened ${requests(cleanup.timeOffShortened)} for ${name} to end on the last day, ${fmtDay(sep.lastDay)}` },
      actorId,
    )
  }
  return { checklistId: checklist.id, cleanup }
}

/**
 * The manager someone has on a date by their job history: a scheduled change that has not landed yet
 * decides; otherwise the manager field, which also covers history written without a manager. Someone
 * who has not started yet is judged on their start date.
 */
function managerOn(db: DB, p: Person, date: ISODate): ID | null {
  const rec = currentJob(db, p.id, p.startDate > date ? p.startDate : date)
  if (rec && rec.scheduled && !rec.appliedOn && rec.managerId !== undefined) return rec.managerId
  return p.managerId
}

/**
 * The people who report to a manager on a date, scheduled job changes included: evaluated the day after
 * a leaver's last day, someone already moving to another manager by then is left out and someone scheduled
 * to move to them is in. People gone by the date are left out; people starting later are in.
 */
export function reportsAsOf(db: DB, managerId: ID, date: ISODate): Person[] {
  return db.people.filter((p) => p.id !== managerId && !(p.endDate && p.endDate < date) && managerOn(db, p, date) === managerId)
}

/**
 * Moves a leaver's reports (reportsAsOf the day after the last day) to new managers from that day, one
 * manager change each in their job history, which hands the report's open manager tasks due from that day
 * to the new manager. `to` picks each report's new manager; nobody, or the leaver, skips that report. When
 * everyone moved, the offboarding checklist's 'Direct reports reassigned' task is marked done. Returns how
 * many moved.
 */
export function reassignReportsAtExit(
  draft: Draft<DB>,
  leaverId: ID,
  lastDay: ISODate,
  to: (reportId: ID) => ID | null | undefined,
  opts: Actor & { approvedById?: ID | null; checklistId?: ID },
): number {
  const effectiveOn = addDays(lastDay, 1)
  const reports = reportsAsOf(draft as DB, leaverId, effectiveOn)
  let moved = 0
  for (const r of reports) {
    const managerId = to(r.id)
    if (!managerId || managerId === leaverId) continue
    changeJobOrPay(
      draft,
      r.id,
      { effectiveOn, reason: 'manager_change', managerId, ...(opts.approvedById ? { approvedById: opts.approvedById } : {}) },
      { date: opts.date, actorId: opts.actorId },
    )
    moved += 1
  }
  if (reports.length && moved === reports.length) {
    const checklist = draft.checklists.find((c) => (opts.checklistId ? c.id === opts.checklistId : c.personId === leaverId && c.kind === 'offboarding' && c.anchorDate === lastDay))
    const task = checklist?.tasks.find((t) => t.templateTaskId === TASK_IDS.reassignReports)
    if (checklist && task && task.status === 'open') {
      setTaskStatus(draft, checklist.id, task.id, 'done', {
        date: opts.date,
        byId: opts.actorId ?? null,
        note: `New manager from ${fmtDate(effectiveOn)}, recorded in the offboarding wizard.`,
      })
    }
  }
  return moved
}

// ---------------------------------------------------------------------------------------------
// Change job or pay
// ---------------------------------------------------------------------------------------------

export type JobChange = {
  effectiveOn: ISODate
  reason: CompReason
  title?: string
  levelId?: ID
  managerId?: ID | null
  departmentId?: ID
  salary?: number
  hourlyRate?: number
  variablePct?: number
  flsa?: FLSA
  exemptionBasis?: ExemptionBasis
  exceptionReason?: string
  approvedById?: ID
  refreshGrantShares?: number
  note?: string
}

/** The person's job and pay on a date: the latest comp record on or before it (later rows win ties). */
export function currentJob(db: DB, personId: ID, date: ISODate): CompRecord | undefined {
  let best: CompRecord | undefined
  for (const r of db.comp) {
    if (r.personId !== personId || r.effectiveOn > date) continue
    if (!best || r.effectiveOn >= best.effectiveOn) best = r
  }
  return best
}

/** 'Update payroll by' date: two weeks before the effective date (a business day), never before tomorrow's business day. */
export function payrollUpdateDue(effectiveOn: ISODate, createdOn: ISODate, holidays: ISODate[] = []): ISODate {
  const target = onOrBeforeBusinessDay(addDays(effectiveOn, -14), holidays)
  const earliest = addBusinessDays(createdOn, 1, holidays)
  return target > earliest ? target : earliest
}

type JobValues = Pick<CompRecord, 'title' | 'levelId' | 'managerId' | 'departmentId' | 'flsa' | 'exemptionBasis' | 'payType' | 'salary' | 'hourlyRate' | 'variablePct'>

/**
 * A manager change hands the report's open manager tasks (check-ins, coverage plans) due on or after its
 * date, and before `until` (a later change to someone else), from the old manager to the new one. Tasks
 * with no assignee follow the manager field already and are handed over too; with no new manager they
 * are left to the manager field (Admin while there is none). Returns how many moved.
 */
function repointManagerTasks(
  draft: Draft<DB>,
  reportId: ID,
  fromManagerId: ID | null | undefined,
  toManagerId: ID | null | undefined,
  effectiveOn: ISODate,
  until?: ISODate,
): number {
  const to = toManagerId ?? null
  if ((fromManagerId ?? null) === to) return 0
  let moved = 0
  for (const checklist of draft.checklists) {
    if (checklist.personId !== reportId) continue
    for (const task of checklist.tasks) {
      if (task.status !== 'open' || task.ownerRole !== 'manager' || task.dueOn < effectiveOn || (until && task.dueOn >= until)) continue
      if (task.assigneeId && task.assigneeId !== fromManagerId) continue
      if ((task.assigneeId ?? null) === to) continue
      task.assigneeId = to
      moved += 1
    }
  }
  return moved
}

/**
 * Rows dated after a new record carried the old values forward when they were written. Each field
 * the change explicitly set is copied onto those rows where they still hold the value it replaced
 * (a value they set themselves is left alone). Returns the ids of the rows it changed.
 */
function carryForward(draft: Draft<DB>, record: CompRecord, before: JobValues, change: JobChange): Set<ID> {
  const touched = new Set<ID>()
  for (const r of draft.comp) {
    if (r.personId !== record.personId || r.id === record.id || r.effectiveOn <= record.effectiveOn) continue
    let hit = false
    if (change.title !== undefined && record.title !== before.title && r.title === before.title) {
      r.title = record.title
      hit = true
    }
    if (change.levelId !== undefined && record.levelId !== before.levelId && r.levelId === before.levelId) {
      r.levelId = record.levelId
      hit = true
    }
    if (change.managerId !== undefined && record.managerId !== before.managerId && (r.managerId ?? null) === (before.managerId ?? null)) {
      r.managerId = record.managerId
      hit = true
    }
    if (change.departmentId !== undefined && record.departmentId !== before.departmentId && r.departmentId === before.departmentId) {
      r.departmentId = record.departmentId
      hit = true
    }
    if (change.flsa !== undefined && record.flsa !== before.flsa && r.flsa === before.flsa) {
      r.flsa = record.flsa
      if (record.exemptionBasis) r.exemptionBasis = record.exemptionBasis
      else delete r.exemptionBasis
      hit = true
    } else if (
      change.exemptionBasis !== undefined &&
      r.flsa === 'exempt' &&
      record.exemptionBasis !== before.exemptionBasis &&
      r.exemptionBasis === before.exemptionBasis
    ) {
      r.exemptionBasis = record.exemptionBasis
      hit = true
    }
    const newPay = change.salary != null || change.hourlyRate != null
    const samePay = r.payType === before.payType && r.salary === before.salary && r.hourlyRate === before.hourlyRate
    const payDiffers = record.payType !== before.payType || record.salary !== before.salary || record.hourlyRate !== before.hourlyRate
    if (newPay && payDiffers && samePay) {
      r.payType = record.payType
      if (record.salary != null) r.salary = record.salary
      else delete r.salary
      if (record.hourlyRate != null) r.hourlyRate = record.hourlyRate
      else delete r.hourlyRate
      hit = true
    }
    if (change.variablePct !== undefined && record.variablePct !== before.variablePct && r.variablePct === before.variablePct) {
      r.variablePct = record.variablePct
      hit = true
    }
    if (hit) touched.add(r.id)
  }
  return touched
}

function applyRecordToPerson(person: Draft<Person>, r: CompRecord, exemptionBasis: ExemptionBasis | undefined = r.exemptionBasis): void {
  person.title = r.title
  person.levelId = r.levelId
  if (r.managerId !== undefined) person.managerId = r.managerId
  if (r.departmentId) person.departmentId = r.departmentId
  if (r.flsa) {
    person.flsa = r.flsa
    if (r.flsa === 'non_exempt') delete person.exemptionBasis
  }
  if (exemptionBasis && person.flsa === 'exempt') person.exemptionBasis = exemptionBasis
}

export type ChangeTaskPlan = {
  /** 'Update payroll by' date when the change goes to payroll (title, level, pay, overtime status or exemption). */
  payroll: ISODate | null
  /** The Labor Code 2810.5 change notice due date (a non-exempt pay change in California). */
  notice2810_5: ISODate | null
  /**
   * A first direct report makes a California manager a supervisor: 2-hour harassment prevention training within
   * 6 months, at 5 or more workers, unless they trained in the last 2 years.
   */
  supervisorTraining: { personId: ID; dueOn: ISODate } | null
}

/** Everything changeJobOrPay decides before it writes: the new record, the values it replaces and the change checklist. */
type JobChangePlan = {
  record: CompRecord
  prev: CompRecord | undefined
  before: JobValues
  payChanged: boolean
  newSupervisor?: Person
  needsTraining: boolean
  trainingDue: ISODate
  /** The change checklist the save adds, or null when nothing is left to do (a manager move alone). */
  checklist: Checklist | null
}

function planJobChange(db: DB, person: Person, change: JobChange, date: ISODate): JobChangePlan {
  const personId = person.id
  const holidays = holidayDates(db)
  const prev = currentJob(db, personId, change.effectiveOn)
  const was = {
    title: prev?.title ?? person.title,
    levelId: prev?.levelId ?? person.levelId,
    managerId: prev && prev.managerId !== undefined ? prev.managerId : person.managerId,
    departmentId: prev?.departmentId ?? person.departmentId,
    flsa: prev?.flsa ?? person.flsa,
  }
  const payType: CompRecord['payType'] =
    change.hourlyRate != null ? 'hourly' : change.salary != null ? 'salary' : (prev?.payType ?? 'salary')
  const salary = payType === 'salary' ? (change.salary ?? (prev?.payType === 'salary' ? prev.salary : undefined)) : undefined
  const hourlyRate = payType === 'hourly' ? (change.hourlyRate ?? (prev?.payType === 'hourly' ? prev.hourlyRate : undefined)) : undefined
  const variablePct = change.variablePct ?? prev?.variablePct
  const flsa = change.flsa ?? was.flsa
  // Exempt rows carry their exemption (it decides which pay minimum applies); non-exempt rows never do.
  const exemptionBasis =
    flsa === 'exempt' ? (change.exemptionBasis ?? prev?.exemptionBasis ?? (was.flsa === 'exempt' ? person.exemptionBasis : undefined)) : undefined
  // Read before the person is updated (the payroll task depends on it).
  const basisBefore = was.flsa === 'exempt' ? (prev?.exemptionBasis ?? person.exemptionBasis) : undefined
  const managerId = change.managerId !== undefined ? change.managerId : was.managerId
  const payChanged =
    !prev ||
    payType !== prev.payType ||
    salary !== prev.salary ||
    hourlyRate !== prev.hourlyRate ||
    variablePct !== prev.variablePct ||
    flsa !== was.flsa

  const record: CompRecord = {
    id: newId('cr'),
    personId,
    effectiveOn: change.effectiveOn,
    payType,
    title: change.title ?? was.title,
    levelId: change.levelId ?? was.levelId,
    managerId,
    departmentId: change.departmentId ?? was.departmentId,
    flsa,
    reason: change.reason,
  }
  if (salary != null) record.salary = salary
  if (hourlyRate != null) record.hourlyRate = hourlyRate
  if (variablePct != null) record.variablePct = variablePct
  if (exemptionBasis) record.exemptionBasis = exemptionBasis
  const exceptionReason = change.exceptionReason ?? (payChanged ? undefined : prev?.exceptionReason)
  if (exceptionReason) record.exceptionReason = exceptionReason
  if (change.note) record.note = change.note
  if (change.approvedById) {
    record.approvedById = change.approvedById
    record.approvedOn = date
  }

  // A first direct report makes the new manager a supervisor (2-hour training within 6 months, CA staff, 5+
  // workers). Reports already scheduled to move to them by then count, so a second scheduled move is not a first.
  let newSupervisor: Person | undefined
  if (managerId && managerId !== was.managerId) {
    const others = reportsAsOf(db, managerId, change.effectiveOn).filter((p) => p.id !== personId)
    if (others.length === 0) newSupervisor = db.people.find((p) => p.id === managerId)
  }
  const workforce = contextFor(db, person, change.effectiveOn).workforce
  const trainedRecently =
    !!newSupervisor &&
    db.trainings.some(
      (t) =>
        t.personId === newSupervisor?.id &&
        t.kind === 'harassment_supervisor' &&
        (!t.completedOn || addMonths(t.completedOn, 24) > change.effectiveOn),
    )
  const needsTraining = !!newSupervisor && newSupervisor.homeState.toUpperCase() === 'CA' && workforce >= 5 && !trainedRecently
  const trainingDue = addMonths(change.effectiveOn, 6)

  // Checklist
  const refresh = change.refreshGrantShares ?? 0
  const overrides: Record<ID, TaskOverride> = {
    [TASK_IDS.payroll]: {
      dueOn: payrollUpdateDue(change.effectiveOn, date, holidays),
      dueRuleText: `Before the payroll that covers ${fmtDate(change.effectiveOn)}`,
    },
  }
  // Labor Code 2810.5(b) counts 7 calendar days from the change itself, not from when it was recorded.
  overrides[TASK_IDS.wageChangeNotice] = { dueOn: addDays(change.effectiveOn, 7), dueRuleText: '7 days after the change takes effect' }
  if (needsTraining && newSupervisor) {
    overrides[TASK_IDS.supervisorTraining] = {
      dueOn: trainingDue,
      dueRuleText: '6 months after becoming a supervisor',
      // The trainee, so marking it done records the completion in the training tracker.
      assigneeId: newSupervisor.id,
      note: `For ${fullName(newSupervisor)}, whose first direct report is ${fullName(person)}.`,
    }
  }
  // No share count in the note: managers can see a report's checklist but never their equity.
  if (refresh > 0) overrides[TASK_IDS.refreshGrant] = { dueRuleText: '30 days after the change was recorded', note: 'Share count is on the Equity tab.' }
  const checklist: Checklist = generateChecklist(db, {
    person,
    templateId: 'tpl-change',
    anchorDate: change.effectiveOn,
    createdOn: date,
    extra: { supervisor: needsTraining, flsa, hasEquity: refresh > 0 },
    overrides,
  })
  if (!payChanged) checklist.tasks = checklist.tasks.filter((t) => t.templateTaskId !== TASK_IDS.wageChangeNotice)
  // Payroll carries the title, level, pay and overtime status: a manager or team move alone (a hand-off
  // at someone's exit included) changes none of them, so it adds no payroll task.
  const payrollChanged = payChanged || record.title !== was.title || record.levelId !== was.levelId || exemptionBasis !== basisBefore
  if (!payrollChanged) checklist.tasks = checklist.tasks.filter((t) => t.templateTaskId !== TASK_IDS.payroll)

  const before: JobValues = {
    title: was.title,
    levelId: was.levelId,
    managerId: was.managerId,
    departmentId: was.departmentId,
    flsa: was.flsa,
    exemptionBasis: prev?.exemptionBasis,
    payType: prev?.payType ?? payType,
    salary: prev?.salary,
    hourlyRate: prev?.hourlyRate,
    variablePct: prev?.variablePct,
  }
  // A move with nothing left to do (no payroll, notice or training task) needs no checklist.
  return { record, prev, before, payChanged, newSupervisor, needsTraining, trainingDue, checklist: checklist.tasks.length > 0 ? checklist : null }
}

/**
 * The tasks a job or pay change creates, without saving it: the Change job or pay sheet lists exactly these
 * under 'Saving will' (changeJobOrPay builds its checklist from the same plan).
 */
export function changeTaskPlan(db: DB, personId: ID, change: JobChange, date: ISODate): ChangeTaskPlan {
  const person = db.people.find((p) => p.id === personId)
  if (!person) return { payroll: null, notice2810_5: null, supervisorTraining: null }
  const plan = planJobChange(db, person, change, date)
  const dueOf = (id: string) => plan.checklist?.tasks.find((t) => t.templateTaskId === id)?.dueOn ?? null
  return {
    payroll: dueOf(TASK_IDS.payroll),
    notice2810_5: dueOf(TASK_IDS.wageChangeNotice),
    supervisorTraining: plan.needsTraining && plan.newSupervisor ? { personId: plan.newSupervisor.id, dueOn: plan.trainingDue } : null,
  }
}

/**
 * Records a promotion, pay or manager change as a new comp record (unchanged fields carried
 * forward), creates the change checklist, assigns supervisor harassment training when someone gets
 * a first direct report, and queues any refresh grant for board consent. The person's current
 * fields change only when the record is their job today: a backdated correction behind a later
 * change only fixes history, and later-dated rows that carried the old values get the new ones.
 * Future-dated records are marked scheduled for applyScheduledChanges. A new manager takes over the
 * open manager tasks on the person's checklists that fall due from the change on (repointManagerTasks).
 * Returns the comp record id.
 */
export function changeJobOrPay(draft: Draft<DB>, personId: ID, change: JobChange, opts: Actor): ID {
  const db = draft as DB
  const { date, actorId } = opts
  const person = draft.people.find((p) => p.id === personId)
  if (!person) throw new Error(`No person with id ${personId}`)
  const plan = planJobChange(db, person, change, date)
  const { record, prev, before, payChanged, newSupervisor, needsTraining, trainingDue } = plan
  const managerId = record.managerId
  draft.comp.push(record)
  const carried = carryForward(draft, record, before, change)
  // Already effective rows are stamped applied even when a later row is the current job, so
  // applyScheduledChanges never revisits them; future rows wait for it.
  if (change.effectiveOn <= date) record.appliedOn = date
  else record.scheduled = true
  const live = currentJob(db, personId, date)
  if (live && (live.id === record.id || carried.has(live.id))) {
    applyRecordToPerson(person, live, live.exemptionBasis ?? change.exemptionBasis)
    const row = draft.comp.find((c) => c.id === live.id)
    if (row && !row.appliedOn) row.appliedOn = date
  }

  if ((record.managerId ?? null) !== (before.managerId ?? null)) {
    // The new manager owns the tasks that fall due from the change on, up to a later change to someone else.
    const until = draft.comp
      .filter((c) => c.personId === personId && c.effectiveOn > record.effectiveOn && c.managerId !== undefined && (c.managerId ?? null) !== (record.managerId ?? null))
      .map((c) => c.effectiveOn)
      .sort()[0]
    repointManagerTasks(draft, personId, before.managerId, record.managerId, record.effectiveOn, until)
  }

  if (plan.checklist) draft.checklists.push(plan.checklist)
  if (needsTraining && newSupervisor) {
    draft.trainings.push({ id: newId('trn'), personId: newSupervisor.id, kind: 'harassment_supervisor', dueOn: trainingDue })
  }

  const refresh = change.refreshGrantShares ?? 0
  if (refresh > 0) {
    const grant: EquityGrant = {
      id: newId('g'),
      personId,
      holderType: 'employee',
      type: 'ISO',
      shares: refresh,
      strikePrice: current409A(db, date)?.fmvPerShare ?? 0,
      vestingStart: change.effectiveOn,
      cliffMonths: 0,
      vestingMonths: draft.settings.defaultVestingMonths || 48,
      status: 'promised',
      proposedOn: date,
      exercisedShares: 0,
      postTerminationExerciseDays: 90,
      note: `Refresh grant (${compReasonLabel(change.reason)})`,
    }
    draft.grants.push(grant)
  }

  const name = fullName(person)
  const details: string[] = []
  if (record.title !== before.title) details.push(`title ${record.title}`)
  if (record.managerId !== before.managerId) details.push(managerId ? `reports to ${fullName(draft.people.find((p) => p.id === managerId) ?? { firstName: 'a new', lastName: 'manager' })}` : 'no manager')
  if (payChanged && prev) details.push('pay updated')
  if (refresh > 0) details.push('refresh grant queued')
  if (carried.size > 0) details.push(`carried into ${carried.size} later ${carried.size === 1 ? 'change' : 'changes'}`)
  log(
    draft,
    {
      entityType: 'person',
      entityId: personId,
      kind: 'job_changed',
      text: `Recorded a ${compReasonLabel(change.reason)} for ${name}, effective ${fmtDate(change.effectiveOn)}${details.length ? ` (${details.join(', ')})` : ''}`,
    },
    actorId,
  )
  if (needsTraining && newSupervisor) {
    log(
      draft,
      {
        entityType: 'person',
        entityId: newSupervisor.id,
        relatedId: personId,
        kind: 'training_assigned',
        text: `Assigned 2-hour supervisor harassment prevention training to ${fullName(newSupervisor)}, due ${fmtDate(trainingDue)}`,
      },
      actorId,
    )
  }
  return record.id
}

/**
 * Copies scheduled comp records (written ahead of their effective date by changeJobOrPay) that have
 * become effective onto each person's current title, level, manager, department and FLSA status.
 * Only rows marked scheduled are touched, so seeded or imported history never overwrites the
 * Person, and a change dated after the person's last day never lands. Safe to run on every load.
 * A manager change that lands also hands over manager tasks still with the old manager that fall due
 * from its date (one added after the change was scheduled, such as a leave checklist's).
 * Returns how many people changed.
 */
export function applyScheduledChanges(draft: Draft<DB>, date: ISODate, actorId?: ID | null): number {
  const db = draft as DB
  let changed = 0
  for (const person of draft.people) {
    const due = draft.comp.filter(
      (c) => c.personId === person.id && c.scheduled && !c.appliedOn && c.effectiveOn <= date && (!person.endDate || c.effectiveOn <= person.endDate),
    )
    if (due.length === 0) continue
    for (const c of due) c.appliedOn = date
    const r = currentJob(db, person.id, date)
    // A later unscheduled row (say a backdated correction) can already be the current job.
    if (!r || !due.some((c) => c.id === r.id)) continue
    const differs =
      person.title !== r.title ||
      person.levelId !== r.levelId ||
      (r.managerId !== undefined && person.managerId !== r.managerId) ||
      (!!r.departmentId && person.departmentId !== r.departmentId) ||
      (!!r.flsa && person.flsa !== r.flsa) ||
      (!!r.exemptionBasis && (r.flsa ?? person.flsa) === 'exempt' && person.exemptionBasis !== r.exemptionBasis)
    if (!differs) continue
    const fromManagerId = person.managerId
    applyRecordToPerson(person, r)
    if (r.managerId !== undefined && (r.managerId ?? null) !== (fromManagerId ?? null)) {
      const since = due.filter((c) => c.managerId !== undefined && (c.managerId ?? null) !== (fromManagerId ?? null)).map((c) => c.effectiveOn).sort()[0]
      repointManagerTasks(draft, person.id, fromManagerId, r.managerId, since ?? r.effectiveOn)
    }
    changed += 1
    log(
      draft,
      { entityType: 'person', entityId: person.id, kind: 'job_change_effective', text: `${fullName(person)}'s ${compReasonLabel(r.reason)} took effect` },
      actorId,
    )
  }
  return changed
}

export type CancelChangeResult = { ok: true } | { ok: false; reason: string }

/**
 * Whether a job or pay change can be cancelled: it is scheduled and has not taken effect, and it is the
 * person's latest change (a later one carried its values forward, so that one is cancelled first).
 */
export function canCancelChange(db: DB, compRecordId: ID): CancelChangeResult {
  const at = db.comp.findIndex((c) => c.id === compRecordId)
  const rec = db.comp[at]
  if (!rec) return { ok: false, reason: 'That change is no longer in the history.' }
  if (!rec.scheduled || rec.appliedOn) return { ok: false, reason: 'That change has already taken effect. Record a correction instead.' }
  const later = db.comp.some((c, i) => c.personId === rec.personId && i !== at && (c.effectiveOn > rec.effectiveOn || (c.effectiveOn === rec.effectiveOn && i > at)))
  if (later) return { ok: false, reason: 'A later change was recorded after this one. Cancel that one first.' }
  return { ok: true }
}

/**
 * Cancels a scheduled job or pay change before it takes effect (canCancelChange): the row comes out of the
 * history, its change checklist (the newest one dated on that day) is removed when nothing on it was done,
 * else its open tasks close with a note, supervisor training only it made someone owe goes, a refresh
 * grant only it promised is cancelled, and manager tasks it handed to a new manager go back to the manager
 * the person keeps. Activity names the change and the date, never pay.
 */
export function cancelScheduledChange(draft: Draft<DB>, compRecordId: ID, opts: Actor): CancelChangeResult {
  const db = draft as DB
  const { date, actorId } = opts
  const check = canCancelChange(db, compRecordId)
  if (!check.ok) return check
  const at = draft.comp.findIndex((c) => c.id === compRecordId)
  const rec = plain(draft.comp[at])
  draft.comp.splice(at, 1)
  const person = draft.people.find((p) => p.id === rec.personId)
  // Manager tasks it handed to the new manager go back to the manager the person keeps.
  const kept = currentJob(db, rec.personId, rec.effectiveOn)
  const keptManagerId = kept && kept.managerId !== undefined ? kept.managerId : person?.managerId
  if (rec.managerId !== undefined) repointManagerTasks(draft, rec.personId, rec.managerId, keptManagerId, rec.effectiveOn)
  // The change checklist it created, settled the way an exit settles a change that will never happen.
  for (let i = draft.checklists.length - 1; i >= 0; i--) {
    const c = draft.checklists[i]
    if (c.personId !== rec.personId || c.kind !== 'change' || c.anchorDate !== rec.effectiveOn) continue
    settleCancelledChangeChecklist(draft, i, `Change cancelled on ${fmtDate(date)}.`, date)
    break
  }
  // A refresh grant queued with it and not yet approved by the board.
  const grant = [...draft.grants]
    .reverse()
    .find((g) => g.personId === rec.personId && g.status === 'promised' && !g.fromOfferId && g.vestingStart === rec.effectiveOn && /^Refresh grant/.test(g.note ?? ''))
  if (grant) {
    grant.status = 'cancelled'
    grant.cancelledShares = grant.shares
    grant.cancelledOn = date
  }
  log(
    draft,
    {
      entityType: 'person',
      entityId: rec.personId,
      kind: 'job_change_cancelled',
      text: `Cancelled the ${compReasonLabel(rec.reason)} scheduled for ${fmtDate(rec.effectiveOn)}${person ? ` for ${fullName(person)}` : ''}${grant ? ' and its refresh grant' : ''}`,
    },
    actorId,
  )
  return { ok: true }
}

// ---------------------------------------------------------------------------------------------
// Protected leave
// ---------------------------------------------------------------------------------------------

/** Opens a leave case with its designation notice deadline and the leave checklist. Returns the case id. */
export function startLeave(draft: Draft<DB>, leave: Omit<LeaveCase, 'id' | 'designationNoticeDueOn'>, opts: Actor): ID {
  const db = draft as DB
  const { date, actorId } = opts
  const person = draft.people.find((p) => p.id === leave.personId)
  if (!person) throw new Error(`No person with id ${leave.personId}`)
  const holidays = holidayDates(db)
  const designationNoticeDueOn = addBusinessDays(leave.requestedOn, 5, holidays)
  const id = newId('lc')
  draft.leaveCases.push({ ...leave, id, designationNoticeDueOn })

  const overrides: Record<ID, TaskOverride> = {
    [TASK_IDS.designation]: leave.designationNoticeSentOn
      ? { dueOn: designationNoticeDueOn, status: 'done', doneOn: leave.designationNoticeSentOn }
      : { dueOn: designationNoticeDueOn },
  }
  if (leave.expectedReturn) overrides[TASK_IDS.returnToWork] = { dueOn: leave.expectedReturn, dueRuleText: 'Expected return date' }
  draft.checklists.push(
    generateChecklist(db, {
      person,
      templateId: 'tpl-leave',
      anchorDate: leave.startDate,
      createdOn: date,
      extra: { leaveKind: leave.kind },
      anchors: { created: leave.requestedOn },
      overrides,
    }),
  )
  log(
    draft,
    {
      entityType: 'leave',
      entityId: id,
      relatedId: person.id,
      kind: 'leave_opened',
      text: `Opened a protected leave case for ${fullName(person)}, starting ${fmtDay(leave.startDate)}`,
    },
    actorId,
  )
  return id
}

/**
 * Records the leave response and designation notice as sent: dates the case and closes the matching
 * open leave checklist task (the checklist anchored at this leave's start first). Activity names no
 * leave type (it can be seen outside Admin). Returns false when the case is missing or the notice was
 * already recorded. Every path that marks the notice sent (timeoff panel, inbox, compliance calendar)
 * should call this so the case and the checklist never disagree.
 */
export function markDesignationSent(draft: Draft<DB>, leaveId: ID, opts: { date: ISODate; byId?: ID | null }): boolean {
  const leave = draft.leaveCases.find((l) => l.id === leaveId)
  if (!leave || leave.designationNoticeSentOn) return false
  leave.designationNoticeSentOn = opts.date
  const lists = draft.checklists.filter((c) => c.personId === leave.personId && c.kind === 'leave')
  const ordered = [...lists.filter((c) => c.anchorDate === leave.startDate), ...lists.filter((c) => c.anchorDate !== leave.startDate)]
  for (const c of ordered) {
    const t = c.tasks.find((x) => x.templateTaskId === TASK_IDS.designation && x.status === 'open')
    if (!t) continue
    setTaskStatus(draft, c.id, t.id, 'done', { date: opts.date, byId: opts.byId ?? null })
    break
  }
  const person = draft.people.find((p) => p.id === leave.personId)
  log(draft, {
    entityType: 'leave',
    entityId: leave.id,
    relatedId: leave.personId,
    kind: 'leave_notice_sent',
    text: `Recorded the leave response notice as sent${person ? ` to ${fullName(person)}` : ''}`,
  })
  return true
}

export type LeaveEligibility = {
  eligible: boolean
  reasons: string[]
  monthsOfService?: number
  /** Estimated from hours per week times weeks employed in the last 12 months. */
  estimatedHours?: number
}

/**
 * Eligibility hint. CFRA and bonding: employer with 5+ employees, more than 12 months of service and
 * at least 1,250 hours in the last 12 months (estimated). PDL: 5+ employees, no service or hours minimum.
 */
export function leaveEligibility(db: DB, personId: ID, kind: LeaveCase['kind'], date: ISODate): LeaveEligibility {
  const person = db.people.find((p) => p.id === personId)
  if (!person) return { eligible: false, reasons: ['This person is not in the workspace.'] }
  if (kind === 'military' || kind === 'other') {
    return { eligible: true, reasons: ['No size or service minimum is checked for this leave type; confirm the rules with counsel or your PEO.'] }
  }
  // CFRA and pregnancy disability leave are California laws: they cover people who work in California.
  if (person.homeState.toUpperCase() !== 'CA') {
    return {
      eligible: false,
      reasons: [
        `CFRA and pregnancy disability leave cover employees who work in California; ${person.preferredName || person.firstName} works in ${person.homeState}.`,
        `Check ${person.homeState}'s leave laws and, at 50 or more employees, federal FMLA. Confirm with counsel or your PEO.`,
      ],
    }
  }
  const reasons: string[] = []
  const headcount = headcountOn(db, date)
  const covered = headcount >= 5
  reasons.push(
    covered
      ? `The company has ${headcount} employees, so CFRA and pregnancy disability leave apply.`
      : `CFRA and pregnancy disability leave apply at 5 or more employees; the company has ${headcount}.`,
  )
  if (kind === 'pdl') {
    reasons.push('Pregnancy disability leave has no service or hours requirement.')
    return { eligible: covered, reasons }
  }
  const monthsOfService = fullMonthsBetween(person.startDate, date)
  const serviceOk = date > addMonths(person.startDate, 12)
  reasons.push(
    serviceOk
      ? `More than 12 months of service (${monthsOfService} months).`
      : `Needs more than 12 months of service; has ${monthsOfService} ${monthsOfService === 1 ? 'month' : 'months'}.`,
  )
  const windowStart = addDays(date, -365)
  const from = person.startDate > windowStart ? person.startDate : windowStart
  const weeks = Math.max(0, daysBetween(from, date)) / 7
  const estimatedHours = Math.round(person.hoursPerWeek * weeks)
  const hoursOk = estimatedHours >= 1250
  reasons.push(
    hoursOk
      ? `About ${num(estimatedHours)} hours in the last 12 months (needs 1,250).`
      : `About ${num(estimatedHours)} hours in the last 12 months; needs 1,250. Check payroll records.`,
  )
  return { eligible: covered && serviceOk && hoursOk, reasons, monthsOfService, estimatedHours }
}

// ---------------------------------------------------------------------------------------------
// Plan line to job
// ---------------------------------------------------------------------------------------------

/**
 * Opens a draft job from a headcount plan line: title, level, band range, stages, interview plan
 * (interviewers left empty) and the JD outline from the role template. Returns the job id: the
 * existing one while the line's job is still live (draft, open or on hold). A filled line becomes a
 * backfill: the line reopens with the new job and remembers who it replaces.
 */
export function openJobFromPlan(
  draft: Draft<DB>,
  planSlotId: ID,
  opts: { date: ISODate; roleTemplateId?: ID; hiringManagerId: ID; actorId?: ID | null },
): ID {
  const { date, actorId } = opts
  const slot = draft.plan.find((s) => s.id === planSlotId)
  if (!slot) throw new Error(`No plan line with id ${planSlotId}`)
  const linked = slot.jobId ? draft.jobs.find((j) => j.id === slot.jobId) : undefined
  if (linked && (linked.status === 'draft' || linked.status === 'open' || linked.status === 'on_hold')) return linked.id
  // 'Backfill?' after an exit: the line was filled, so the new job replaces that person.
  const backfill = slot.status === 'filled' || linked?.status === 'filled'
  const backfillFor = backfill ? (slot.personId ?? slot.backfillForPersonId ?? null) : (slot.backfillForPersonId ?? null)
  const templates = draft.settings.roleTemplates
  const exact = opts.roleTemplateId
    ? templates.find((t) => t.id === opts.roleTemplateId)
    : templates.find((t) => t.familyId === slot.familyId && t.levelId === slot.levelId)
  // No template at this exact level: a backfill starts from the leaver's own job (the role being
  // replaced), else from the same family's template at the nearest level, so the job never opens blank.
  const replacedPerson = backfillFor ? draft.people.find((p) => p.id === backfillFor) : undefined
  const replacedApp = replacedPerson?.fromApplicationId ? draft.applications.find((a) => a.id === replacedPerson.fromApplicationId) : undefined
  const originalJob = !exact && replacedApp ? draft.jobs.find((j) => j.id === replacedApp.jobId) : undefined
  const orderOf = (levelId: ID) => draft.levels.find((l) => l.id === levelId)?.order ?? 0
  const nearest =
    exact || originalJob
      ? undefined
      : templates
          .filter((t) => t.familyId === slot.familyId)
          .sort((a, b) => Math.abs(orderOf(a.levelId) - orderOf(slot.levelId)) - Math.abs(orderOf(b.levelId) - orderOf(slot.levelId)))[0]
  const template = exact ?? nearest
  const band = draft.bands.find((b) => b.familyId === slot.familyId && b.levelId === slot.levelId)
  const hq = draft.locations.find((l) => l.kind === 'hq') ?? draft.locations[0]
  const id = uniqueId([`j-${slugify(slot.title)}`], new Set(draft.jobs.map((j) => j.id)))
  const stageSource = template?.stages?.length ? template.stages : originalJob?.stages?.length ? originalJob.stages : draft.settings.defaultStages
  const stages = plain(stageSource)
  const interviewPlan = plain(template?.interviewPlan ?? originalJob?.interviewPlan ?? []).map((s) => ({ ...s, interviewerIds: [] as ID[] }))
  const job: Job = {
    id,
    title: slot.title,
    departmentId: slot.departmentId,
    familyId: slot.familyId,
    levelId: slot.levelId,
    hiringManagerId: opts.hiringManagerId,
    panelIds: [],
    locationIds: hq ? [hq.id] : [],
    workMode: /hybrid/i.test(draft.company.workweek) ? 'hybrid' : /remote/i.test(draft.company.workweek) ? 'remote' : 'onsite',
    employmentType: 'full_time',
    flsa: band?.flsaDefault ?? 'exempt',
    payMin: band?.min ?? null,
    payMax: band?.max ?? null,
    status: 'draft',
    openedOn: date,
    targetStart: slot.targetStart,
    planSlotId: slot.id,
    stages,
    interviewPlan,
    description: template?.jdOutline ?? originalJob?.description ?? '',
    sponsorship: 'case_by_case',
    backgroundCheck: draft.company.soc2Enabled,
    creditCheckBasis: null,
    priority: 'normal',
  }
  if (band) {
    job.equityMinPct = band.equityMinPct
    job.equityMaxPct = band.equityMaxPct
  }
  if (template) job.roleTemplateId = template.id
  if (backfill || slot.isBackfill) {
    job.isBackfill = true
    job.backfillForPersonId = backfillFor
  }
  draft.jobs.push(job)
  if (backfill) {
    slot.isBackfill = true
    slot.backfillForPersonId = backfillFor
    slot.personId = null
  }
  slot.jobId = id
  slot.status = 'open'
  const replaced = backfill && backfillFor ? draft.people.find((p) => p.id === backfillFor) : undefined
  const text = backfill
    ? `Reopened ${slot.title} as a draft backfill job${replaced ? ` for ${fullName(replaced)}` : ''}`
    : `Opened a draft job for ${slot.title} from the headcount plan`
  log(draft, { entityType: 'job', entityId: id, relatedId: slot.id, kind: 'job_opened', text }, actorId)
  return id
}
