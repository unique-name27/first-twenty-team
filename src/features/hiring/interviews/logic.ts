// Pure helpers for interviews, scheduling, scorecards, the hiring pulse and referrals.
// No store or React imports, so they can be unit tested (logic.test.ts).
import { jobStages, stageById } from '@/domain/hiring/pipeline'
import { candidateName, latestOffer, lowerFirst, pacificToUTC } from '@/domain/hiring/util'
import type { Rate } from '@/domain/hiring/metrics'
import { reportingLine } from '@/domain/people'
import type { Application, DB, ID, Interview, InterviewStep, Job, Offer, Rating, StageKind, Viewer } from '@/domain/types'
import { addDays, daysBetween, fmtDay, type ISODate, isWeekday } from '@/lib/dates'

/** Interview format that fits a stage: onsite rounds on site, everything else on video. */
export function formatForStage(kind: StageKind | undefined): Interview['format'] {
  return kind === 'onsite' ? 'onsite' : 'video'
}

/**
 * The interview step to schedule next: the first step without a live interview, starting from the
 * application's current stage and moving forward; else the first step of the current stage; else the
 * first step. Undefined when the job has no interview plan.
 */
export function defaultStepFor(job: Pick<Job, 'interviewPlan' | 'stages'>, app: Pick<Application, 'stageId'>, interviews: Interview[]): InterviewStep | undefined {
  const plan = orderedSteps(job)
  if (plan.length === 0) return undefined
  const live = new Set(interviews.filter((i) => i.status !== 'cancelled' && i.status !== 'no_show' && i.stepId).map((i) => i.stepId as ID))
  const stages = jobStages(job)
  const idx = (stageId: string) => stages.findIndex((s) => s.id === stageId)
  const cur = idx(app.stageId)
  const ahead = plan.find((s) => !live.has(s.id) && idx(s.stageId) >= cur)
  return ahead ?? plan.find((s) => s.stageId === app.stageId) ?? plan[0]
}

/** Interview steps in stage order (steps for stages the job no longer has go last). */
export function orderedSteps(job: Pick<Job, 'interviewPlan' | 'stages'>): InterviewStep[] {
  const order = new Map(jobStages(job).map((s, i) => [s.id, i]))
  return [...(job.interviewPlan ?? [])].sort((a, b) => (order.get(a.stageId) ?? 99) - (order.get(b.stageId) ?? 99))
}

/** Pacific wall-clock times offered under "Pick" in the schedule sheet. */
export function pickTimes(): Array<{ hour: number; minute: number; label: string }> {
  const rows: Array<[number, number]> = [
    [9, 0],
    [10, 0],
    [11, 0],
    [13, 0],
    [14, 0],
    [15, 30],
    [16, 30],
  ]
  return rows.map(([hour, minute]) => ({ hour, minute, label: clockLabel(hour, minute) }))
}

/** '9:00 AM', '3:30 PM' */
export function clockLabel(hour: number, minute: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12
  return `${h}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`
}

/** UTC timestamp for a picked Pacific date and time (weekends move to Monday). */
export function pickedStart(date: ISODate, hour: number, minute: number): string {
  let d = date
  for (let i = 0; i < 3 && !isWeekday(d); i++) d = addDays(d, 1)
  return pacificToUTC(d, hour, minute)
}

/** Durations offered as chips, always including the step's own duration. */
export function durationChoices(stepMinutes?: number): number[] {
  const base = [30, 45, 60, 75, 90]
  if (stepMinutes && !base.includes(stepMinutes)) base.push(stepMinutes)
  return base.sort((a, b) => a - b)
}

export function ratingWord(r: Rating | null | undefined): string {
  switch (r) {
    case 1:
      return 'Strong no'
    case 2:
      return 'No'
    case 3:
      return 'Yes'
    case 4:
      return 'Strong yes'
    default:
      return ''
  }
}

/** Badge tone for a rating: yes side good, no side warn (red is reserved for statutory deadlines). */
export function ratingTone(r: Rating | null | undefined): 'good' | 'warn' | 'outline' {
  if (r === 3 || r === 4) return 'good'
  if (r === 1 || r === 2) return 'warn'
  return 'outline'
}

/**
 * 'Expires today', 'Expires tomorrow', 'Expires in 5 days', 'Expired Mon, Oct 12'. With `midSentence`,
 * only the leading word is lowercased ('expired Mon, Oct 12'), so day and month names keep their capitals.
 */
export function expiryPhrase(expiresOn: ISODate, date: ISODate, opts: { midSentence?: boolean } = {}): string {
  const n = daysBetween(date, expiresOn)
  const phrase = n < 0 ? `Expired ${fmtDay(expiresOn)}` : n === 0 ? 'Expires today' : n === 1 ? 'Expires tomorrow' : `Expires in ${n} days`
  return opts.midSentence ? phrase.charAt(0).toLowerCase() + phrase.slice(1) : phrase
}

/**
 * One line per outstanding offer for the hiring pulse: 'Offer out to Daniel Reyes, expires in 5 days',
 * 'Offer for Daniel Reyes waiting for approval', 'Lucas Ferreira accepted, starts Mon, Oct 19'. A sent
 * offer past its expiry date reads as expired ('Offer to Kenji Mori expired Fri, Oct 16'), never as out,
 * and so does one marked expired (expiry runs on load) while the candidate is still active: pass
 * `appActive: false` once the application has closed, and it drops off.
 */
export function offerPulseLine(
  offer: Pick<Offer, 'status' | 'expiresOn' | 'startDate' | 'personId'>,
  name: string,
  date: ISODate,
  opts: { appActive?: boolean } = {},
): string | null {
  switch (offer.status) {
    case 'sent':
      if (offer.expiresOn < date) return `Offer to ${name} ${expiryPhrase(offer.expiresOn, date, { midSentence: true })}`
      return `Offer out to ${name}, ${expiryPhrase(offer.expiresOn, date, { midSentence: true })}`
    case 'expired':
      return opts.appActive === false ? null : `Offer to ${name} expired ${fmtDay(offer.expiresOn)}`
    case 'awaiting_approval':
      return `Offer for ${name} waiting for approval`
    case 'approved':
      return `Offer for ${name} approved, ready to send`
    case 'draft':
      return `Offer for ${name} in draft`
    case 'accepted':
      return offer.startDate >= date ? `${name} accepted, starts ${fmtDay(offer.startDate)}` : null
    default:
      return null
  }
}

/** An offer still waiting on someone (sent, awaiting approval, approved, or accepted with no person yet). */
function stillOut(o: Pick<Offer, 'status' | 'personId'>): boolean {
  return o.status === 'sent' || o.status === 'awaiting_approval' || o.status === 'approved' || (o.status === 'accepted' && !o.personId)
}

/** Each application's newest offer on the job (the one the pulse speaks for). */
function latestOffersOn(db: Pick<DB, 'offers'>, jobId: ID): Offer[] {
  return [...new Set(db.offers.filter((o) => o.jobId === jobId).map((o) => o.applicationId))].map((appId) => latestOffer(db, appId)).filter((o) => !!o)
}

/**
 * Jobs the Home hiring pulse lists: every open job, plus a filled job that still has an offer out, so a
 * second offer sent after one hire filled the job stays in sight. A filled job whose offer to a candidate
 * still active expired stays too (its line reads 'Offer to <name> expired <day>') until that application
 * closes. Oldest opened first.
 */
export function pulseJobs(db: Pick<DB, 'jobs' | 'offers' | 'applications'>): Job[] {
  const expiredForActive = (o: Offer) => o.status === 'expired' && db.applications.some((a) => a.id === o.applicationId && a.status === 'active')
  return db.jobs
    .filter((j) => j.status === 'open' || (j.status === 'filled' && latestOffersOn(db, j.id).some((o) => stillOut(o) || expiredForActive(o))))
    .sort((a, b) => (a.openedOn ?? '').localeCompare(b.openedOn ?? ''))
}

/** The offer lines under a job in the hiring pulse (offerPulseLine for each application's newest offer). */
export function pulseOfferLines(db: Pick<DB, 'offers' | 'applications' | 'candidates'>, jobId: ID, date: ISODate): string[] {
  return latestOffersOn(db, jobId)
    .map((o) => {
      const app = db.applications.find((a) => a.id === o.applicationId)
      return offerPulseLine(o, candidateName(db, o.candidateId), date, { appActive: app?.status === 'active' })
    })
    .filter((x): x is string => !!x)
}

/** Splits 'Jordan Lee Park' into first 'Jordan' and last 'Lee Park'. */
export function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { firstName: '', lastName: '' }
  if (parts.length === 1) return { firstName: parts[0], lastName: '' }
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') }
}

/** Light email check for the referral form (the hiring team confirms details later). */
export function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim())
}

/** What a referrer may see about their referral: the stage name only, or the outcome in plain words. */
export function referralStatus(db: Pick<DB, 'jobs'>, app: Pick<Application, 'status' | 'stageId' | 'jobId'>): string {
  if (app.status === 'hired') return 'Hired'
  if (app.status === 'rejected' || app.status === 'withdrawn') return 'Closed'
  const job = db.jobs.find((j) => j.id === app.jobId)
  const stage = job ? stageById(job, app.stageId) : undefined
  if (!stage) return 'In review'
  return stage.kind === 'new' ? 'New, in review' : `In ${stage.name.toLowerCase()}`
}

/** Applications a drill-down list shows, newest applied first, capped. */
export function drillRows<T extends { appliedOn: ISODate }>(apps: T[], cap = 60): { rows: T[]; more: number } {
  const sorted = [...apps].sort((a, b) => b.appliedOn.localeCompare(a.appliedOn))
  return { rows: sorted.slice(0, cap), more: Math.max(0, sorted.length - cap) }
}

/** Date range presets for hiring metrics. */
export function metricsRange(kind: '90d' | '12m' | 'all', date: ISODate, foundedOn: ISODate): { from: ISODate; to: ISODate } {
  if (kind === '90d') return { from: addDays(date, -90), to: date }
  if (kind === '12m') return { from: addDays(date, -365), to: date }
  return { from: foundedOn < '2000-01-01' ? '2000-01-01' : addDays(foundedOn, -60), to: date }
}

/**
 * Confirmation note for a booked interview (the "This time" option): the time in Pacific and the
 * candidate's zone, length, format, the video link and who they will meet. It goes out through a
 * mailto link, which cannot carry an attachment, so it never says a calendar invite is attached; a
 * video call without a link promises to send one.
 */
export function confirmationBody(input: {
  firstName: string
  interviewName: string
  when: string
  durationMin: number
  format: Interview['format']
  panel: string[]
  companyName: string
  address?: string
  senderName: string
  videoLink?: string
  /** The old time, when the interview was moved: the note says so and asks to drop the old time. */
  movedFrom?: string
}): string {
  const link = input.videoLink?.trim()
  const how =
    input.format === 'onsite'
      ? `at our office${input.address ? ` (${input.address})` : ''}`
      : input.format === 'phone'
        ? 'by phone; we will call the number you gave us'
        : 'on video'
  const video = input.format === 'video'
  const sendLater = video && !link ? ' I will send the video link before the call.' : ''
  const joinLine = video && link ? `\n\nJoin here: ${link}` : ''
  const meet = input.panel.length ? ` You will meet ${listOf(input.panel)}.` : ''
  const lead = input.movedFrom
    ? `Your ${lowerFirst(input.interviewName)} with ${input.companyName} has moved from ${input.movedFrom} to:`
    : `You are confirmed for the ${lowerFirst(input.interviewName)} with ${input.companyName}:`
  const dropOld = input.movedFrom ? ' Please take the old time off your calendar.' : ''
  return `Hi ${input.firstName},

${lead}

${input.when}

It runs ${input.durationMin} minutes, ${how}.${meet}${sendLater}${dropOld} If the time stops working, reply and we will find another.${joinLine}

${input.senderName}`
}

function listOf(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/**
 * Splits free text ('Wanted $240,000 base, above the $230K top') into plain and money parts, so the
 * amounts in notes typed by people can go through <Private> and the privacy blur.
 */
export function splitMoney(text: string): Array<{ text: string; money: boolean }> {
  const parts: Array<{ text: string; money: boolean }> = []
  const re = /-?\$\s?\d[\d,]*(?:\.\d+)?(?:\s?[KkMm](?![a-z]))?/g
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), money: false })
    parts.push({ text: m[0], money: true })
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last), money: false })
  return parts
}

export type ReferralRow = { key: string; candidateId: ID; jobId: ID; on: ISODate; status: string; tone: 'good' | 'accent' | 'neutral' }

/**
 * "Your referrals" for one teammate: candidates they referred (with the stage only), plus people they
 * referred who were already on file (candidate.otherReferrals). Those show 'New, in review' while the
 * job is open, or the stage of an application added on or after the referral, so a duplicate reads
 * the same as a brand-new referral. Newest first.
 */
export function referralRows(db: Pick<DB, 'candidates' | 'applications' | 'jobs'>, personId: ID | null | undefined): ReferralRow[] {
  if (!personId) return []
  const tone = (a: Pick<Application, 'status'>): ReferralRow['tone'] => (a.status === 'hired' ? 'good' : a.status === 'active' ? 'accent' : 'neutral')
  const rows: ReferralRow[] = []
  const seen = new Set<string>()
  for (const c of db.candidates) {
    if (c.referrerId !== personId) continue
    for (const a of db.applications) {
      if (a.candidateId !== c.id) continue
      seen.add(`${c.id}:${a.jobId}`)
      rows.push({ key: a.id, candidateId: c.id, jobId: a.jobId, on: a.appliedOn, status: referralStatus(db, a), tone: tone(a) })
    }
  }
  for (const c of db.candidates) {
    for (const r of c.otherReferrals ?? []) {
      const k = `${c.id}:${r.jobId}`
      if (r.referrerId !== personId || seen.has(k)) continue
      seen.add(k)
      const app = db.applications.find((a) => a.candidateId === c.id && a.jobId === r.jobId && a.appliedOn >= r.on)
      const job = db.jobs.find((j) => j.id === r.jobId)
      const open = !!job && (job.status === 'open' || job.status === 'on_hold' || job.status === 'draft')
      const row = app
        ? { status: referralStatus(db, app), tone: tone(app) }
        : open
          ? { status: 'New, in review', tone: 'accent' as const }
          : { status: 'Closed', tone: 'neutral' as const }
      rows.push({ key: `ref-${k}`, candidateId: c.id, jobId: r.jobId, on: r.on, ...row })
    }
  }
  return rows.sort((a, b) => b.on.localeCompare(a.on))
}

/**
 * Pay bands in interview kits. Admin sees every band. A hiring manager sees a template's band only for
 * their own level, a level held by someone in their reporting line (SPEC: managers see the band for
 * each report's level), or the level of a job they are hiring for (open, draft or on hold). Employees
 * see none here; their own band lives on Me.
 */
export function canSeeKitBand(viewer: Pick<Viewer, 'role' | 'personId'>, db: DB, familyId: ID, levelId: ID, date?: ISODate): boolean {
  if (viewer.role === 'admin') return true
  if (viewer.role !== 'manager' || !viewer.personId) return false
  const me = viewer.personId
  const same = (x: { familyId: ID; levelId: ID }) => x.familyId === familyId && x.levelId === levelId
  if (db.people.some((p) => p.id === me && same(p))) return true
  if (db.jobs.some((j) => j.hiringManagerId === me && (j.status === 'open' || j.status === 'draft' || j.status === 'on_hold') && same(j))) return true
  return reportingLine(db, me, date).some(same)
}

/**
 * A funnel conversion in words, naming its base so it reads next to the count above it:
 * '43% of the 313 who reached intro call', '2 of the 3 who reached onsite (small n)'.
 */
export function conversionText(r: Pick<Rate, 'n' | 'd' | 'small' | 'text'>, fromName: string): string {
  const from = fromName.toLowerCase()
  if (r.d === 0) return `None yet from ${from}`
  const d = r.d.toLocaleString('en-US')
  const n = r.n.toLocaleString('en-US')
  const who = from === 'applied' ? 'who applied' : `who reached ${from}`
  return r.small ? `${n} of the ${d} ${who} (small n)` : `${r.text} of the ${d} ${who}`
}

/** Median days to accept for one job: '33 days', or why there is no number yet. */
export function medianDaysText(days: number | null, hires: number): string {
  if (days != null) return `${Math.round(days)} ${Math.round(days) === 1 ? 'day' : 'days'}`
  return hires === 0 ? 'No hires yet' : 'Not recorded'
}

/**
 * The candidate panel's line when it has no interviews and the viewer cannot schedule one. Someone who sees
 * every interview (Admin, the hiring team) hears whether any were held; an interviewer, who sees only their
 * own, hears that theirs show here.
 */
export function interviewsEmptyText(o: { seesAll: boolean; active: boolean }): string {
  if (!o.seesAll) return 'Interviews you are on will show here.'
  return o.active ? 'None are scheduled yet.' : 'None were held while the application was open.'
}
