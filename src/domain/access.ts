// What each "Viewing as" mode can see and do (docs/SPEC.md, "Viewing as rules").
// It is a preview, not security: anyone using this browser can switch views. The rules exist so each
// person sees a calm, relevant app and so the sample can show how the product behaves for each role.
//
// Admin: everything.
// Hiring manager: Home, Hiring, People, Me. Full pipeline on jobs they manage; on jobs where they are
//   only on the panel, just their own interviews and scorecards. Their reports' job history, time off,
//   checklists, trainings and pay band, but never anyone's individual pay or equity.
// Employee: Me and People. Their own record, pay, band, equity, time off and tasks; directory and org
//   chart; open roles and referrals; interviews they are on.
import { employedOn, incomingOn, isPeopleManager, reportingLine } from '@/domain/people'
import type { Application, DB, ID, Job, TimeOffRequest, Viewer } from '@/domain/types'
import { nowISO } from '@/lib/dates'

export type Section = 'home' | 'hiring' | 'people' | 'comp' | 'compliance' | 'settings' | 'me'

const SECTIONS: Record<Viewer['role'], Section[]> = {
  admin: ['home', 'hiring', 'people', 'comp', 'compliance', 'settings', 'me'],
  manager: ['home', 'hiring', 'people', 'me'],
  employee: ['me', 'people'],
}

export function canSeeSection(v: Viewer, s: Section): boolean {
  return SECTIONS[v.role].includes(s)
}

export const isAdmin = (v: Viewer) => v.role === 'admin'

// ---- People -----------------------------------------------------------------------------------

export type PersonArea =
  | 'basic' // name, title, team, manager, location, start date, work anniversary, work email
  | 'job' // level, FLSA class, employment type, job and title history
  | 'band' // pay band for their level
  | 'pay' // individual salary/hourly, variable, comp history amounts
  | 'equity'
  | 'timeoff' // balances, request types and notes
  | 'leave' // leave case types (others see only "Leave, back <date>")
  | 'checklists'
  | 'training'
  | 'emergency'
  | 'notes'
  | 'separation'
  | 'activity'

/** Is `personId` in the viewer's reporting line (reports, their reports, ...)? */
export function isInReportingLine(v: Viewer, db: DB, personId: ID): boolean {
  if (!v.personId) return false
  return reportingLine(db, v.personId).some((p) => p.id === personId)
}

export function canSeePerson(v: Viewer, db: DB, personId: ID, area: PersonArea): boolean {
  if (area === 'basic') return true
  if (v.role === 'admin') return true
  const self = v.personId === personId
  if (self) return area !== 'notes' && area !== 'activity'
  if (v.role === 'manager' && isInReportingLine(v, db, personId)) {
    return area === 'job' || area === 'band' || area === 'timeoff' || area === 'checklists' || area === 'training'
  }
  return false
}

/**
 * A departure that has not happened yet (a last day still ahead): Admin, the person and their manager
 * line see it; everyone else sees the person as Active until they are alumni (SPEC: Viewing as rules,
 * an employee sees only name, title, team, manager, location, start date and work anniversary).
 */
export function canSeeSeparation(v: Viewer, db: DB, personId: ID): boolean {
  if (v.role === 'admin') return true
  if (v.personId === personId) return true
  return v.role === 'manager' && isInReportingLine(v, db, personId)
}

// ---- Hiring -----------------------------------------------------------------------------------

export function isHiringManager(v: Viewer, job: Job): boolean {
  return !!v.personId && job.hiringManagerId === v.personId
}

export function isOnPanel(v: Viewer, job: Job): boolean {
  if (!v.personId) return false
  const id = v.personId
  return job.panelIds.includes(id) || job.interviewPlan.some((s) => s.interviewerIds.includes(id))
}

function interviewApps(db: DB, personId: ID): Set<ID> {
  const apps = new Set<ID>()
  for (const i of db.interviews) if (i.interviewerIds.includes(personId)) apps.add(i.applicationId)
  return apps
}

/** Full pipeline (all candidates, desired pay, move stages, draft offers). */
export function canSeePipeline(v: Viewer, job: Job): boolean {
  return v.role === 'admin' || isHiringManager(v, job)
}

export function canManageJob(v: Viewer, job: Job): boolean {
  return v.role === 'admin' || isHiringManager(v, job)
}

/** Jobs that appear in the viewer's Hiring section (full pipeline or panel-only). */
export function visibleJobs(v: Viewer, db: DB): Job[] {
  if (v.role === 'admin') return db.jobs
  return db.jobs.filter((j) => isHiringManager(v, j) || isOnPanel(v, j))
}

/** Can the viewer open this application (candidate profile in the context of a job)? */
export function canSeeApplication(v: Viewer, db: DB, app: Application): boolean {
  if (v.role === 'admin') return true
  const job = db.jobs.find((j) => j.id === app.jobId)
  if (job && canSeePipeline(v, job)) return true
  return !!v.personId && interviewApps(db, v.personId).has(app.id)
}

export function canSeeCandidate(v: Viewer, db: DB, candidateId: ID): boolean {
  if (v.role === 'admin') return true
  return db.applications.some((a) => a.candidateId === candidateId && canSeeApplication(v, db, a))
}

/**
 * True once the application became a hire: it is marked hired, an offer on it was accepted, or a
 * person record came from it. From then on the numbers are an employee's pay, which non-admins never see.
 */
export function isHiredApplication(db: DB, app: Application): boolean {
  if (app.status === 'hired') return true
  if (db.offers.some((o) => o.applicationId === app.id && (o.status === 'accepted' || !!o.personId))) return true
  return db.people.some((p) => p.fromApplicationId === app.id)
}

/**
 * Desired pay and offers: admin and the job's hiring manager only, and for the hiring manager only
 * until the offer is accepted (after that it is an employee's pay; SPEC: managers never see
 * individual pay, variable or equity for anyone).
 */
export function canSeeCandidatePay(v: Viewer, db: DB, app: Application): boolean {
  if (v.role === 'admin') return true
  const job = db.jobs.find((j) => j.id === app.jobId)
  if (!job || !isHiringManager(v, job)) return false
  return !isHiredApplication(db, app)
}

export const canSeeOffer = canSeeCandidatePay

/** Hiring managers draft offers inside the band; Admin approves. */
export function canDraftOffer(v: Viewer, db: DB, app: Application): boolean {
  return canSeeCandidatePay(v, db, app)
}

export function canApproveOffer(v: Viewer): boolean {
  return v.role === 'admin'
}

/**
 * Scorecards stay hidden from an interviewer until they submit their own, per interview: while the
 * viewer owes a card for any interview of this application that has started (an earlier round's card
 * does not unlock a later round), or was on the panel and has submitted nothing yet, others' cards
 * stay hidden. Admins and hiring managers otherwise see all. `nowISO` defaults to the clock.
 */
export function canSeeOthersScorecards(v: Viewer, db: DB, app: Application, opts: { nowISO?: string } = {}): boolean {
  if (!v.personId) return v.role === 'admin'
  const id = v.personId
  const now = Date.parse(opts.nowISO ?? nowISO())
  const onPanelForApp = db.interviews.some((i) => i.applicationId === app.id && i.interviewerIds.includes(id))
  const mine = db.scorecards.filter((s) => s.applicationId === app.id && s.interviewerId === id)
  const submitted = mine.some((s) => !!s.submittedAt)
  const owesStarted = mine.some((s) => {
    if (s.submittedAt) return false
    const i = db.interviews.find((x) => x.id === s.interviewId)
    return !!i && (i.status === 'scheduled' || i.status === 'completed') && Date.parse(i.startsAt) <= now
  })
  if (owesStarted) return false
  if (onPanelForApp && !submitted) return false
  if (v.role === 'admin') return true
  const job = db.jobs.find((j) => j.id === app.jobId)
  if (job && isHiringManager(v, job)) return true
  return submitted
}

/** Background checks: admin sees status and Fair Chance steps; hiring managers see only cleared yes/no. */
export function canSeeBackgroundDetail(v: Viewer): boolean {
  return v.role === 'admin'
}

/** Candidates the viewer referred (they see stage only). */
export function referredBy(v: Viewer, db: DB): ID[] {
  if (!v.personId) return []
  return db.candidates.filter((c) => c.referrerId === v.personId).map((c) => c.id)
}

// ---- Time off ---------------------------------------------------------------------------------

/**
 * Admin approves anything; a manager approves their direct reports' requests. A pending request on an
 * auto-approve policy (sick leave) is waiting only because it falls before the service wait, and
 * waiving that or recording it as unpaid is Admin's call.
 */
export function canApproveTimeOff(v: Viewer, db: DB, req: TimeOffRequest): boolean {
  if (v.role === 'admin') return true
  if (v.role !== 'manager' || !v.personId) return false
  if (db.timeOffPolicies.find((p) => p.id === req.policyId)?.autoApprove) return false
  const person = db.people.find((p) => p.id === req.personId)
  return person?.managerId === v.personId
}

/** Others see "Out"; the type and note only for self, their manager line, or admin. */
export function canSeeTimeOffDetail(v: Viewer, db: DB, req: TimeOffRequest): boolean {
  return canSeePerson(v, db, req.personId, 'timeoff')
}

// ---- Misc -------------------------------------------------------------------------------------

function managesSomething(db: DB, personId: ID): boolean {
  return isPeopleManager(db, personId) || db.jobs.some((j) => j.hiringManagerId === personId && j.status !== 'closed')
}

/** The Hiring manager view is offered once someone other than the founder manages people or a job. */
export function hiringManagerModeAvailable(db: DB): boolean {
  return db.people.some((p) => !p.isFounder && managesSomething(db, p.id))
}

/** Employee view is offered from hire #2 (docs/SPEC.md, Growth journey), counting a hire who has not started yet. */
export function employeeModeAvailable(db: DB): boolean {
  return [...employedOn(db), ...incomingOn(db)].some((p) => !p.isFounder)
}

/** People who can be chosen in a mode's person picker (current and incoming employees). */
export function pickablePeople(db: DB, role: Viewer['role']): ID[] {
  const people = [...employedOn(db), ...incomingOn(db)]
  if (role === 'manager') return people.filter((p) => managesSomething(db, p.id)).map((p) => p.id)
  return people.map((p) => p.id)
}
