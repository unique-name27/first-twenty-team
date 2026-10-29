// The time machine's engine (docs/DEV.md, "The time machine"): one simulated day at a time. Each day opens
// the app once, so the changes it makes on its own when a workspace loads run (applyLoadChanges in
// src/store/db.ts: scheduled job and pay changes, leavers' hand-offs, offers past their expiry; the app has
// no timer at midnight). Then, on business days, the people act, each through an action (src/sim/actions.ts)
// and each after asking the check its screen asks:
// - time off: checkRequest before a request is sent (nobody sends one it warns about, sick days aside),
//   then the manager or Admin approves it the next business day;
// - hiring: the founder keeps roles in the headcount plan and opens each from its plan line when its start
//   draws near (openJobFromPlan), candidates arrive, are reviewed, interviewed and scored, and the hiring
//   manager decides on the scorecards; an offer goes out only when sendBlockerList is empty;
// - raises: a merit raise on a work anniversary, as Change job or pay proposes it, unless it leaves the band;
// - attrition and leave: a low weekly chance of a resignation (and a backfill) or a protected leave
//   (only when leaveEligibility says the person qualifies);
// - pay runs: each period's prep (payRunPrep, whose totals come from payRunTotals) and Mark submitted on
//   its 'run payroll by' day;
// - every Monday Admin clears the inbox (inboxItems, then applyInboxOp for each one-button item), and the
//   compliance rules are evaluated (evaluateAll); in December next year's holidays are added if missing.
//
// The machine lives each day inside a run its caller holds (src/sim/simulation.ts, which advance uses), and
// every random choice comes from one generator seeded with the seed and the starting date. Its state between
// days (snapshot, restore) is small, so a simulation can step in any chunks, and rewind, and still give the
// same JSON as one long run. Situations (src/sim/situations.ts) join a day through DayHooks. Test and tooling
// code only (src/sim/guard.test.ts).
import { DEFAULT_ROLE_TEMPLATES } from '@/data/starterRoleTemplates'
import {
  bayAreaPlaces,
  firstNames,
  lastNames,
  otherCaliforniaPlaces,
  outOfStatePlaces,
  type ProfileKey,
  profile,
  reservedNames,
  scoreNotes,
} from '@/data/seed/hiring/pools'
import { makeRng, type Rng } from '@/data/seed/hiring/rng'
import { TASK_IDS } from '@/domain/checklists/templates'
import { evaluateAll, summarizeResults } from '@/domain/compliance'
import { GRADUATION_OUTGROW_AT } from '@/domain/graduation'
import { leaverRoles } from '@/domain/handoff'
import {
  approvalRequired,
  businessDayOnOrAfter,
  closeOutMessage,
  dbHolidays,
  defaultStartDate,
  departmentForFamily,
  effectiveBand,
  nextStage,
  postingBlockReason,
  roleTemplates,
  sendBlockerList,
  stageById,
} from '@/domain/hiring'
import { hasHolidaysIn, rolloverHolidays } from '@/domain/holidays'
import { type InboxOp, inboxItems, taskOwnerId } from '@/domain/inbox'
import { currentJob, leaveEligibility } from '@/domain/lifecycle'
import { bandFor, fullTimeEquivalentBase, planSlotStatus } from '@/domain/pay'
import { hasPaidPeople, payCalendar, payRunPrep, runForPeriod } from '@/domain/payrun'
import { employedOn, incomingOn, isEmployedOn } from '@/domain/people'
import { checkRequest, policiesFor, serviceWait } from '@/domain/timeoff'
import type { Candidate, DB, ID, Job, OutcomeReason, Person, PlanSlot, Rating, Role } from '@/domain/types'
import { effectiveDatePresets, hiringManagerForSlot, proposedBase } from '@/features/comp/helpers'
import { proposedSlots } from '@/features/hiring/interviews/conflicts'
import { defaultStepFor, formatForStage } from '@/features/hiring/interviews/logic'
import { nextFriday } from '@/features/people/helpers'
import { addBusinessDays, addDays, type ISODate, isWeekday, pacificDateOf, parseDate, setClockOverride } from '@/lib/dates'
import { type ActionName, type ArgsOf, applyAction, INBOX_OP_TYPES, type ResultOf, type SimState, type TraceLine } from './actions'
import { profileFor, slug } from './profiles'

// ---------------------------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------------------------

/** How busy the company is: the rates the people act at. Every chance is drawn from the advance's seed. */
export type AdvancePolicy = {
  /** Vacation requests each person makes a year: one to five workdays, one to six weeks out. */
  vacationRequestsPerYear: number
  /** Sick days each person records a year, on the day. */
  sickDaysPerYear: number
  /** Roles the founder keeps in the headcount plan (planned or open) while the company is under maxHeadcount. */
  openRoles: number
  /** Employees, people starting later and roles in the plan the company grows to. */
  maxHeadcount: number
  /** New candidates a week on each open job, until it has maxCandidatesPerJob or an offer is out. */
  candidatesPerJobPerWeek: number
  /** Applications a job takes in all before sourcing stops. */
  maxCandidatesPerJob: number
  /** Share of new applications the hiring manager moves past review. */
  reviewPassRate: number
  /** Chance an interview goes well (its scorecards lean positive). */
  interviewPassRate: number
  /** Chance a candidate accepts an offer. */
  offerAcceptRate: number
  /** Chance a candidate declines one. The rest never answer, and the offer expires on its date. */
  offerDeclineRate: number
  /** Chance a candidate withdraws, each business day they are in the pipeline without an offer. */
  withdrawPerDay: number
  /** Chance a person gets a merit raise on their work anniversary. */
  anniversaryRaiseRate: number
  /** Chance a person resigns within a year (drawn each Monday). */
  attritionPerYear: number
  /** Chance a leaver's role is backfilled the day they give notice. */
  backfillRate: number
  /** Protected leaves a person starts a year (drawn each Monday). */
  leavesPerYear: number
  /** Admin clears the inbox's one-button items every Monday afternoon. */
  weeklyInboxSweep: boolean
}

export type PolicyName = 'quiet' | 'normal' | 'busy'

/**
 * The presets, for a company of 1 to 20 people. normal: a steady hire at a time, a few days off a quarter
 * each, about one person in eight leaving in a year. quiet: nobody hired, raised, leaving or going on leave;
 * the existing pipeline trickles on. busy: three roles open at once and more of everything.
 * The company grows to GRADUATION_OUTGROW_AT (25), where the graduation packs say a fuller system fits.
 */
export const POLICIES: Record<PolicyName, AdvancePolicy> = {
  quiet: {
    vacationRequestsPerYear: 1,
    sickDaysPerYear: 1,
    openRoles: 0,
    maxHeadcount: GRADUATION_OUTGROW_AT,
    candidatesPerJobPerWeek: 1,
    maxCandidatesPerJob: 30,
    reviewPassRate: 0.35,
    interviewPassRate: 0.6,
    offerAcceptRate: 0.8,
    offerDeclineRate: 0.12,
    withdrawPerDay: 0.003,
    anniversaryRaiseRate: 0,
    attritionPerYear: 0,
    backfillRate: 0,
    leavesPerYear: 0,
    weeklyInboxSweep: true,
  },
  normal: {
    vacationRequestsPerYear: 4,
    sickDaysPerYear: 3,
    openRoles: 1,
    maxHeadcount: GRADUATION_OUTGROW_AT,
    candidatesPerJobPerWeek: 6,
    maxCandidatesPerJob: 40,
    reviewPassRate: 0.35,
    interviewPassRate: 0.6,
    offerAcceptRate: 0.8,
    offerDeclineRate: 0.12,
    withdrawPerDay: 0.004,
    anniversaryRaiseRate: 0.7,
    attritionPerYear: 0.12,
    backfillRate: 0.8,
    leavesPerYear: 0.03,
    weeklyInboxSweep: true,
  },
  busy: {
    vacationRequestsPerYear: 6,
    sickDaysPerYear: 5,
    openRoles: 3,
    maxHeadcount: GRADUATION_OUTGROW_AT,
    candidatesPerJobPerWeek: 10,
    maxCandidatesPerJob: 60,
    reviewPassRate: 0.35,
    interviewPassRate: 0.6,
    offerAcceptRate: 0.8,
    offerDeclineRate: 0.12,
    withdrawPerDay: 0.005,
    anniversaryRaiseRate: 0.85,
    attritionPerYear: 0.2,
    backfillRate: 0.9,
    leavesPerYear: 0.06,
    weeklyInboxSweep: true,
  },
}

/** A preset by name, or rates changed from one (normal unless `preset` names another). */
export type PolicyInput = PolicyName | (Partial<AdvancePolicy> & { preset?: PolicyName })

/** The policy an input stands for, with the name the summary shows ('normal', or 'busy, changed'). */
export function resolvePolicy(input: PolicyInput = 'normal'): AdvancePolicy & { name: string } {
  if (typeof input === 'string') {
    const preset = POLICIES[input]
    if (!preset) throw new Error(`No policy preset named ${input}: use quiet, normal or busy.`)
    return { ...preset, name: input }
  }
  const { preset = 'normal', ...changes } = input
  const base = POLICIES[preset]
  if (!base) throw new Error(`No policy preset named ${preset}: use quiet, normal or busy.`)
  for (const [k, v] of Object.entries(changes)) {
    if (!(k in base)) throw new Error(`No policy setting named ${k}.`)
    if (typeof v !== typeof base[k as keyof AdvancePolicy] || (typeof v === 'number' && !(Number.isFinite(v) && v >= 0))) {
      throw new Error(`The policy setting ${k} is not a valid ${typeof base[k as keyof AdvancePolicy]}: ${String(v)}.`)
    }
  }
  const changed = Object.keys(changes).length > 0
  return { ...base, ...changes, name: changed ? `${preset}, changed` : preset }
}

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

/** What happened, counted: the summary's numbers, for tests and tools. */
export type AdvanceReport = {
  days: number
  businessDays: number
  actions: number
  headcount: { from: number; to: number; starts: number; separations: number; incoming: number }
  timeOff: { vacation: number; sick: number; approved: number; heldBack: Record<string, number> }
  hiring: {
    planned: number
    opened: number
    backfills: number
    postingsHeld: number
    candidates: number
    interviews: number
    scorecards: number
    rejected: number
    withdrew: number
    offersDrafted: number
    offersSent: number
    accepted: number
    declined: number
    expired: number
    offersHeld: Record<string, number>
    hires: number
  }
  raises: { given: number; heldOutsideBand: number }
  leaves: { started: number; returned: number }
  payRuns: Array<{ start: ISODate; end: ISODate; payday: ISODate; submittedOn: ISODate; late: boolean; people: number; estimatedGross: number }>
  inbox: { sweeps: number; cleared: Record<string, number> }
  tasksDone: number
  holidaysAdded: number[]
  compliance: { checks: number; began: Array<{ title: string; on: ISODate }>; openActions: number }
}

// ---------------------------------------------------------------------------------------------
// The days
// ---------------------------------------------------------------------------------------------

/** Days from opening a role to its target start (the generator's jobs open six to seven weeks ahead). */
export const LEAD_DAYS = 45

/** Someone acting, and the Viewing-as mode they act in. */
export type Who = { id: ID; as: Role }

/** A push to grow the company to a headcount by a date (a growTo situation). */
export type GrowTarget = { headcount: number; by: ISODate; departmentId?: ID }

/**
 * What situations (src/sim/situations.ts) add to the days, kept apart so the machine runs exactly the same
 * without them: a step each business morning, and the windows the founder's hiring reads.
 */
export type DayHooks = {
  /** Business days at 08:20: after the holiday rollover, before the founder plans roles. */
  morning(host: MachineHost): void
  /** A hiring freeze is on: no roles planned or opened, and no backfills. */
  frozen(day: ISODate): boolean
  /** The headcount the founder is growing to by a date, while a push is on. */
  growTo(day: ISODate): GrowTarget | null
}

/** What a situation may use of the machine: the day, the workspace, and actions as the people. */
export interface MachineHost {
  readonly db: DB
  readonly day: ISODate
  readonly holidays: ISODate[]
  readonly admin: Who
  act<N extends ActionName>(who: Who, time: string, name: N, args: ArgsOf<N>): ResultOf<N>
  readyAndPost(jobId: ID, time: string): void
  /** Adds a role to the headcount plan, drawn with `rng`; null when no role template fits. */
  planRole(rng: Rng, time: string, opts?: PlanRoleOptions): ID | null
  /** Opens a planned role as a job now, as openPlannedRoles does when its start draws near, and posts it. */
  openFromPlan(planSlotId: ID, openAt: string, postAt: string): ID
  /** Employees, people starting later and roles in the plan not yet filled. */
  headcountWithPlan(): number
  away(person: Person): boolean
  staff(): Person[]
}

/** Where a planned role goes: a department's role templates only, and a target start no later than a date. */
export type PlanRoleOptions = { departmentId?: ID; latestStart?: ISODate }

/** The machine between days: enough to put it back there (restore); the caller keeps the workspace. */
export type MachineSnapshot = {
  readonly day: ISODate
  readonly lastBusinessDay: ISODate
  readonly rngState: number
  readonly policy: AdvancePolicy & { name: string }
  readonly silent: readonly ID[]
  readonly blockedOffers: readonly ID[]
  readonly heldPostings: readonly ID[]
  readonly usedNames: readonly string[]
  readonly usedEmails: readonly string[]
  readonly applies: ReadonlySet<string> | null
  readonly counts: Counts
}

type Counts = {
  days: number
  businessDays: number
  heldBack: Record<string, number>
  offersHeld: Record<string, number>
  raisesHeld: number
  payRuns: AdvanceReport['payRuns']
  sweeps: number
  cleared: Record<string, number>
  holidaysAdded: number[]
  checks: number
  began: AdvanceReport['compliance']['began']
  openActions: number
}

export type MachineOptions = {
  /** Evaluate the compliance rules each Monday for the report (default true). They change nothing in the workspace. */
  reportCompliance?: boolean
  hooks?: DayHooks
}

/** Offer statuses that hold a job's one offer: no second candidate gets one meanwhile. */
const LIVE_OFFER = new Set(['draft', 'awaiting_approval', 'approved', 'sent', 'accepted'])
/** Stage kinds that are not interviews: review, offer and hired. */
const NOT_INTERVIEW = new Set(['new', 'offer', 'hired'])
export const RESIGN_REASONS = ['New job', 'Relocating', 'Career change', 'Personal reasons']

/** A 32-bit seed for the advance's random choices (FNV-1a), apart from the run's id stream. */
export function storySeed(text: string): number {
  let h = 0x811c9dc5
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193)
  return h >>> 0
}

/** How a time off warning reads in the report: what kept the request back. */
function warningKind(text: string): string {
  if (text.startsWith('Overlaps')) return 'overlap'
  if (/balance|yearly limit/.test(text)) return 'balance'
  if (text.includes('usable from')) return 'service wait'
  if (text.includes('per event') || text.includes(' days in ')) return 'limit'
  return 'other'
}

export class TimeMachine implements MachineHost {
  readonly sim: SimState
  private rng: Rng
  private readonly holidaySet = new Set<ISODate>()
  private holidayList: ISODate[] = []
  private readonly usedNames: Set<string>
  private readonly usedEmails: Set<string>
  readonly admin: Who
  private today: ISODate
  private time = '00:00'
  /** The business day before this one (anniversaries between the two count today). */
  private lastBusinessDay: ISODate
  /** Offers whose candidate never answers: they expire on their date. */
  private readonly silent = new Set<ID>()
  private readonly blockedOffers = new Set<ID>()
  private readonly heldPostings = new Set<ID>()
  private applies: ReadonlySet<string> | null = null
  private readonly startHeadcount: number
  private policy: AdvancePolicy & { name: string }
  private readonly reportCompliance: boolean
  private readonly hooks: DayHooks | null
  private counts: Counts = {
    days: 0,
    businessDays: 0,
    heldBack: {},
    offersHeld: {},
    raisesHeld: 0,
    payRuns: [],
    sweeps: 0,
    cleared: {},
    holidaysAdded: [],
    checks: 0,
    began: [],
    openActions: 0,
  }

  /** A machine on `from` (the last day already lived), its random choices seeded with the seed and that date. */
  constructor(
    db: DB,
    readonly from: ISODate,
    seed: number | string,
    policy: AdvancePolicy & { name: string },
    adminId: ID,
    options: MachineOptions = {},
  ) {
    this.sim = { db, trace: [] }
    this.rng = makeRng(storySeed(`advance story ${seed} from ${from}`))
    this.admin = { id: adminId, as: 'admin' }
    this.policy = policy
    this.reportCompliance = options.reportCompliance ?? true
    this.hooks = options.hooks ?? null
    this.today = from
    this.lastBusinessDay = from
    this.usedNames = new Set([...reservedNames(), ...db.people.map((p) => `${p.firstName} ${p.lastName}`), ...db.candidates.map((c) => `${c.firstName} ${c.lastName}`)].map((n) => n.toLowerCase()))
    this.usedEmails = new Set(db.candidates.map((c) => c.email.toLowerCase()))
    this.startHeadcount = employedOn(db, from).length
  }

  /** The last day lived (`from` before the first). */
  get day(): ISODate {
    return this.today
  }

  /** The company holidays as of this morning. */
  get holidays(): ISODate[] {
    return this.holidayList
  }

  /** The rates the people act at, from the next day lived on (a pace change). */
  setPolicy(policy: AdvancePolicy & { name: string }): void {
    this.policy = policy
  }

  /** Lives the day after the last one lived, inside the caller's run, and leaves the clock override on it. */
  liveDay(day: ISODate): void {
    const next = addDays(this.today, 1)
    if (day !== next) throw new Error(`The machine lives one day after another: it is on ${this.today}, so the next day is ${next}, not ${day}.`)
    this.today = day
    this.time = '00:00'
    this.counts.days += 1
    setClockOverride(day)
    this.act(this.admin, '08:00', 'openApp', {})
    this.holidayList = dbHolidays(this.db)
    this.holidaySet.clear()
    for (const h of this.holidayList) this.holidaySet.add(h)
    if (!isWeekday(day) || this.holidaySet.has(day)) return
    this.counts.businessDays += 1
    const monday = parseDate(day).getDay() === 1
    this.holidaysForNextYear()
    this.hooks?.morning(this)
    if (monday) this.planRoles()
    this.openPlannedRoles()
    this.returnsFromLeave()
    this.writeUps()
    this.approveOffers()
    this.candidatesArrive()
    this.payRuns()
    this.reviews()
    this.raises()
    if (monday) this.leaves()
    if (monday) this.resignations()
    this.decisions()
    this.timeOffRequests()
    this.timeOffApprovals()
    this.offerAnswers()
    this.lapsedOffers()
    this.withdrawals()
    this.tasks()
    if (monday && this.policy.weeklyInboxSweep) this.sweepInbox()
    if (monday && this.reportCompliance) this.checkCompliance()
    this.lastBusinessDay = day
  }

  /** The machine as it is between days (the caller keeps the workspace and the trace). */
  snapshot(): MachineSnapshot {
    return {
      day: this.today,
      lastBusinessDay: this.lastBusinessDay,
      rngState: this.rng.state(),
      policy: this.policy,
      silent: [...this.silent],
      blockedOffers: [...this.blockedOffers],
      heldPostings: [...this.heldPostings],
      usedNames: [...this.usedNames],
      usedEmails: [...this.usedEmails],
      applies: this.applies,
      counts: structuredClone(this.counts),
    }
  }

  /** Puts the machine back where a snapshot found it, with the workspace and trace of that moment. */
  restore(snap: MachineSnapshot, db: DB, trace: TraceLine[]): void {
    this.sim.db = db
    this.sim.trace = trace
    this.today = snap.day
    this.time = '00:00'
    this.lastBusinessDay = snap.lastBusinessDay
    this.rng = makeRng(snap.rngState)
    this.policy = snap.policy
    refill(this.silent, snap.silent)
    refill(this.blockedOffers, snap.blockedOffers)
    refill(this.heldPostings, snap.heldPostings)
    refill(this.usedNames, snap.usedNames)
    refill(this.usedEmails, snap.usedEmails)
    this.applies = snap.applies
    this.counts = structuredClone(snap.counts)
  }

  // ---- Plumbing --------------------------------------------------------------------------------

  get db(): DB {
    return this.sim.db
  }

  /** Applies an action today at `time`, or now when that is later: the clock never goes back within a day. */
  act<N extends ActionName>(who: Who, time: string, name: N, args: ArgsOf<N>): ResultOf<N> {
    const at = time < this.time ? this.time : time
    this.time = at
    return applyAction(this.sim, name, args, { day: this.day, time: at, actorId: who.id, viewingAs: who.as })
  }

  private bd(date: ISODate, n: number): ISODate {
    return addBusinessDays(date, n, this.holidays)
  }

  private employed(personId: ID | null | undefined): boolean {
    const p = personId ? this.db.people.find((x) => x.id === personId) : undefined
    return !!p && isEmployedOn(p, this.day)
  }

  /** Someone who acts for the company: the founder as Admin, a manager as a manager, anyone else as an employee. */
  private as(personId: ID): Who {
    if (personId === this.admin.id) return this.admin
    return { id: personId, as: this.db.people.some((p) => p.managerId === personId && isEmployedOn(p, this.day)) ? 'manager' : 'employee' }
  }

  /** The person acting for a job: its hiring manager while they work here, else the founder as Admin. */
  private hiringManager(job: Job): Who {
    return job.hiringManagerId !== this.admin.id && this.employed(job.hiringManagerId) ? { id: job.hiringManagerId, as: 'manager' } : this.admin
  }

  /** Out on a leave that has not ended, or with a last day on record. */
  away(person: Person): boolean {
    return !!person.separation || this.db.leaveCases.some((l) => l.personId === person.id && !l.returnedOn && !l.endedOn)
  }

  /** People working here today, the founder included. */
  staff(): Person[] {
    return employedOn(this.db, this.day)
  }

  /** A count for today that averages `mean`: each whole one by a draw at that chance, so 1.2 gives 1 or 2. */
  private draws(mean: number): number {
    let n = 0
    for (let x = mean; x > 0; x -= 1) if (this.rng.chance(Math.min(1, x))) n += 1
    return n
  }

  /** A full name nobody in the workspace or the sample has. */
  private newName(): [string, string] {
    const firsts = firstNames()
    const lasts = lastNames()
    for (;;) {
      const first = this.rng.pick(firsts)
      const last = this.rng.pick(lasts)
      const key = `${first} ${last}`.toLowerCase()
      if (this.usedNames.has(key)) continue
      this.usedNames.add(key)
      return [first, last]
    }
  }

  // ---- Holidays, the plan and jobs -------------------------------------------------------------

  /** In December, next year's company holidays when they are missing (Settings, or Home's inbox row). */
  private holidaysForNextYear(): void {
    if (this.day.slice(5, 7) !== '12') return
    const next = Number(this.day.slice(0, 4)) + 1
    if (hasHolidaysIn(this.db.holidays, next) || rolloverHolidays(this.db.holidays, next).add.length === 0) return
    this.act(this.admin, '08:15', 'inboxOp', { op: { type: 'add_holidays', year: next } })
    this.counts.holidaysAdded.push(next)
  }

  /** Monday: the founder keeps `openRoles` roles in the plan while the company is under its size. */
  private planRoles(): void {
    if (this.hooks?.frozen(this.day)) return
    const grow = this.hooks?.growTo(this.day)
    if (grow) {
      // A push: as many roles as it takes to reach its headcount, starting by its date.
      while (this.headcountWithPlan() < grow.headcount && this.planRole(this.rng, '08:30', { departmentId: grow.departmentId, latestStart: grow.by })) {
        // planRole added one.
      }
      return
    }
    const p = this.policy
    if (p.openRoles <= 0) return
    const db = this.db
    const unfilled = unfilledPlan(db)
    if (unfilled >= p.openRoles) return
    if (employedOn(db, this.day).length + incomingOn(db, this.day).length + unfilled >= p.maxHeadcount) return
    this.planRole(this.rng, '08:30')
  }

  /** Employees, people starting later and roles in the plan not yet filled. */
  headcountWithPlan(): number {
    return employedOn(this.db, this.day).length + incomingOn(this.db, this.day).length + unfilledPlan(this.db)
  }

  /**
   * Comp and plan > Plan, Add a line, for a role template drawn with `rng` (from a department's templates
   * when one is given), starting LEAD_DAYS and up to two weeks out, at the band's midpoint.
   */
  planRole(rng: Rng, time: string, opts: PlanRoleOptions = {}): ID | null {
    const db = this.db
    const all = roleTemplates(db).length ? roleTemplates(db) : DEFAULT_ROLE_TEMPLATES
    const departmentOf = (t: (typeof all)[number]) => (db.departments.some((d) => d.id === t.departmentId) ? t.departmentId : departmentForFamily(db, t.familyId))
    const templates = opts.departmentId ? all.filter((t) => departmentOf(t) === opts.departmentId) : all
    if (!templates.length) return null
    const t = rng.pick(templates)
    const departmentId = departmentOf(t)
    const band = effectiveBand(db, t.familyId, t.levelId)
    let targetStart = businessDayOnOrAfter(addDays(this.day, LEAD_DAYS + rng.int(0, 14)), this.holidays)
    if (opts.latestStart && targetStart > opts.latestStart) targetStart = businessDayOnOrAfter(opts.latestStart < this.day ? this.day : opts.latestStart, this.holidays)
    return this.act(this.admin, time, 'addPlanLine', { title: t.name, departmentId, familyId: t.familyId, levelId: t.levelId, targetStart, ...(band ? { budgetBase: band.mid } : {}) })
  }

  /** A planned role opens as a job once its target start is LEAD_DAYS away (or already past). */
  private openPlannedRoles(): void {
    if (this.hooks?.frozen(this.day)) return
    for (const slot of this.db.plan) {
      if (slot.status !== 'planned' || addDays(slot.targetStart, -LEAD_DAYS) > this.day) continue
      const live = slot.jobId ? this.db.jobs.find((j) => j.id === slot.jobId) : undefined
      if (live && (live.status === 'draft' || live.status === 'open' || live.status === 'on_hold')) continue
      this.openFromPlan(slot.id, '08:45', '08:50')
    }
  }

  /** Comp and plan > Plan, Open job, with the hiring manager the plan line suggests; then Edit details and Mark posted. */
  openFromPlan(planSlotId: ID, openAt: string, postAt: string): ID {
    const slot = this.db.plan.find((s) => s.id === planSlotId)
    const hm = slot ? hiringManagerForSlot(this.db, slot, this.admin.id, this.day) : this.admin.id
    const jobId = this.act(this.admin, openAt, 'openJobFromPlan', { planSlotId, hiringManagerId: hm })
    this.readyAndPost(jobId, postAt)
    return jobId
  }

  /**
   * A job just opened from the plan: Edit details puts the hiring manager on the panel and on every step
   * without interviewers, then Mark posted, when postingBlockReason allows it (else it waits as a draft).
   */
  readyAndPost(jobId: ID, time: string): void {
    const job = this.db.jobs.find((j) => j.id === jobId)
    if (!job) return
    const hm = job.hiringManagerId
    const interviewers: Record<string, ID[]> = {}
    for (const s of job.interviewPlan) if (!s.interviewerIds.length) interviewers[s.id] = [hm]
    const panelIds = job.panelIds.includes(hm) ? job.panelIds : [hm, ...job.panelIds]
    if (panelIds !== job.panelIds || Object.keys(interviewers).length) this.act(this.admin, time, 'editJob', { jobId, panelIds: [...panelIds], interviewers })
    if (postingBlockReason(this.db, jobId, this.day)) {
      this.heldPostings.add(jobId)
      return
    }
    this.act(this.admin, time, 'markPosted', { jobId })
  }

  private liveOffer(jobId: ID): boolean {
    return this.db.offers.some((o) => o.jobId === jobId && LIVE_OFFER.has(o.status) && !(o.status === 'accepted' && o.personId))
  }

  // ---- Candidates --------------------------------------------------------------------------------

  /** New candidates on each open job (Quick add), until it is full or an offer is out. */
  private candidatesArrive(): void {
    for (const job of this.db.jobs) {
      if (job.status !== 'open' || this.liveOffer(job.id)) continue
      const n = this.draws(this.policy.candidatesPerJobPerWeek / 5)
      for (let i = 0; i < n; i++) {
        if (this.db.applications.filter((a) => a.jobId === job.id).length >= this.policy.maxCandidatesPerJob) break
        this.arrive(job)
      }
    }
  }

  private profileOf(job: Job): ProfileKey {
    return profileFor({ template: job.roleTemplateId ?? '', title: job.title })
  }

  /** A candidate applies and Admin adds them with Quick add, the way the generator's candidates arrive. */
  private arrive(job: Job): void {
    const r = this.rng
    const [first, last] = this.newName()
    let email = `${slug(first)}.${slug(last)}@${r.pick(['example.com', 'example.net', 'example.org'])}`
    for (let n = 2; this.usedEmails.has(email); n++) email = email.replace(/(\d*)@/, `${n}@`)
    this.usedEmails.add(email)
    const [location] = r.weighted<[string, string]>([
      [r.pick(bayAreaPlaces()), 0.7],
      [r.pick(otherCaliforniaPlaces()), 0.15],
      [r.pick(outOfStatePlaces()), 0.15],
    ])
    const key = this.profileOf(job)
    const prof = profile(key)
    const band = effectiveBand(this.db, job.familyId, job.levelId, job)
    const hourly = job.flsa === 'non_exempt' && job.payMin != null && job.payMax != null && job.payMax < 1000
    const desired = hourly
      ? { desiredPay: Math.round(((job.payMin as number) + r.next() * ((job.payMax as number) - (job.payMin as number))) * 4) / 4, desiredPayUnit: 'hour' as const }
      : band
        ? { desiredPay: Math.round((band.min + r.next() * (band.max * 1.08 - band.min)) / 5000) * 5000 }
        : {}
    const source = r.weighted<Candidate['source']>([
      ['inbound', 0.55],
      ['outbound', 0.2],
      ['referral', 0.15],
      ['agency', 0.1],
    ])
    const referrers = source === 'referral' ? this.staff() : []
    // Quick add keeps a source detail only for an agency: its name.
    const detail = source === 'agency' ? r.pick(['Lanternfish Talent', 'Bramblegate Search']) : undefined
    this.act(this.admin, '09:40', 'addCandidate', {
      candidate: {
        firstName: first,
        lastName: last,
        email,
        ...(r.chance(0.5) ? { phone: `(408) 555-${String(r.int(100, 199)).padStart(4, '0')}` } : {}),
        location,
        currentTitle: r.pick(prof.titles),
        currentCompany: r.pick(prof.companies),
        source: referrers.length ? 'referral' : source === 'referral' ? 'inbound' : source,
        ...(detail ? { sourceDetail: detail } : {}),
        ...(referrers.length ? { referrerId: r.pick(referrers).id } : {}),
        ...desired,
        sponsorship: r.weighted<Candidate['sponsorship']>([
          ['no', 0.82],
          ['unknown', 0.11],
          ['yes', 0.07],
        ]),
      },
      jobId: job.id,
    })
  }

  /** Active applications on open jobs with no offer out, in workspace order. */
  private pipeline(): Array<{ app: DB['applications'][number]; job: Job }> {
    const jobs = new Map(this.db.jobs.filter((j) => j.status === 'open' && !this.liveOffer(j.id)).map((j) => [j.id, j]))
    const out: Array<{ app: DB['applications'][number]; job: Job }> = []
    for (const app of this.db.applications) {
      const job = app.status === 'active' ? jobs.get(app.jobId) : undefined
      if (job) out.push({ app, job })
    }
    return out
  }

  /** The hiring manager reviews applications a business day old or more: moves them on, or rejects them. */
  private reviews(): void {
    for (const { app, job } of this.pipeline()) {
      if (stageById(job, app.stageId)?.kind !== 'new' || app.stageEnteredOn >= this.day) continue
      const waited = app.stageEnteredOn <= this.bd(this.day, -3)
      if (!waited && !this.rng.chance(0.6)) continue
      if (!this.rng.chance(this.policy.reviewPassRate)) {
        this.reject(job, app.id, this.rng.weighted<OutcomeReason>([['not_a_fit_level', 0.4], ['skills_gap', 0.35], ['location', 0.15], ['comp', 0.1]]), '10:15')
        continue
      }
      const next = nextStage(job, app.stageId)
      if (next && !NOT_INTERVIEW.has(next.kind)) this.moveAndSchedule(job, app.id, next.id, '10:15')
    }
  }

  private reject(job: Job, appId: ID, reason: OutcomeReason, time: string, withdraw = false): void {
    const notified = this.rng.chance(0.9)
    this.act(this.hiringManager(job), time, 'rejectApplication', { applicationId: appId, reason, ...(notified ? { notified: true } : {}), ...(withdraw ? { withdraw: true } : {}) })
  }

  /** Moves an application to a stage, then schedules that stage's interviews, as the generator does. */
  private moveAndSchedule(job: Job, appId: ID, stageId: string, time: string): void {
    this.act(this.hiringManager(job), time, 'moveApplication', { applicationId: appId, toStageId: stageId })
    this.schedule(appId, time)
  }

  /**
   * Schedules each interview step of the application's stage that has no interview yet, at one of the three
   * times the schedule sheet proposes, with the step's interviewers who still work here (else the hiring
   * manager). Returns how many it scheduled.
   */
  private schedule(appId: ID, time: string): number {
    let n = 0
    for (;;) {
      const db = this.db
      const app = db.applications.find((a) => a.id === appId)
      const j = app && db.jobs.find((x) => x.id === app.jobId)
      if (!app || !j) return n
      const mine = db.interviews.filter((i) => i.applicationId === appId)
      const step = defaultStepFor(j, app, mine)
      if (!step || step.stageId !== app.stageId || mine.some((i) => i.stepId === step.id && i.status !== 'cancelled' && i.status !== 'no_show')) return n
      const here = step.interviewerIds.filter((id) => this.employed(id) && !db.people.find((p) => p.id === id)?.separation)
      const interviewerIds = here.length ? here : [this.hiringManager(j).id]
      const cand = db.candidates.find((c) => c.id === app.candidateId)
      const times = proposedSlots(db, this.day, { panelIds: interviewerIds, candidateTz: cand?.timezone ?? null, durationMin: step.durationMin, applicationId: appId })
      const startsAt = times[this.rng.int(0, times.length - 1)]
      const format = formatForStage(stageById(j, step.stageId)?.kind)
      this.act(this.hiringManager(j), time, 'scheduleInterview', {
        applicationId: appId,
        stepId: step.id,
        stageId: step.stageId,
        name: step.name,
        startsAt,
        durationMin: step.durationMin,
        interviewerIds,
        format,
        ...(format === 'video' ? { videoLink: `https://meet.example.com/${slug(db.company.name)}-interviews` } : {}),
        attributes: step.attributes.map((a) => a.name),
      })
      n += 1
    }
  }

  /** The business morning after an interview, each interviewer submits their scorecard (Admin enters it for someone gone). */
  private writeUps(): void {
    const active = new Set(this.db.applications.filter((a) => a.status === 'active').map((a) => a.id))
    const due = this.db.interviews.filter((i) => i.status === 'scheduled' && active.has(i.applicationId) && pacificDateOf(i.startsAt) < this.day)
    for (const interview of due) {
      const positive = this.rng.chance(this.policy.interviewPassRate)
      const app = this.db.applications.find((a) => a.id === interview.applicationId)
      const job = app && this.db.jobs.find((j) => j.id === app.jobId)
      const key = job ? this.profileOf(job) : 'eng'
      for (const card of this.db.scorecards.filter((s) => s.interviewId === interview.id && !s.submittedAt)) {
        const ratings: Record<string, Rating> = {}
        for (const name of interview.attributes) {
          ratings[name] = positive
            ? this.rng.weighted<Rating>([
                [4, 0.4],
                [3, 0.5],
                [2, 0.1],
              ])
            : this.rng.weighted<Rating>([
                [1, 0.3],
                [2, 0.6],
                [3, 0.1],
              ])
        }
        const notes = this.rng.pick(scoreNotes(key, positive))
        if (this.employed(card.interviewerId)) {
          this.act(this.as(card.interviewerId), '09:15', 'submitScorecard', { scorecardId: card.id, ratings, notes })
        } else {
          this.act(this.admin, '09:15', 'submitScorecard', { scorecardId: card.id, ratings, notes, enteredById: this.admin.id })
        }
      }
    }
  }

  /**
   * After a stage's scorecards are in, the hiring manager decides on them: on to the next stage, the offer
   * (only one candidate at a time has one), or a rejection. An application in a stage with no interview yet
   * gets it scheduled.
   */
  private decisions(): void {
    for (const { app, job } of this.pipeline()) {
      // An earlier decision today may have closed it, or made the job's one offer.
      if (this.liveOffer(job.id) || !this.db.applications.some((a) => a.id === app.id && a.status === 'active')) continue
      const kind = stageById(job, app.stageId)?.kind
      if (!kind || kind === 'new' || kind === 'hired') continue
      if (kind === 'offer') {
        // In the offer stage with no offer yet; one that expired or was declined is closed instead (lapsedOffers).
        if (!this.db.offers.some((o) => o.applicationId === app.id)) this.makeOffer(job, app.id, null)
        continue
      }
      const mine = this.db.interviews.filter((i) => i.applicationId === app.id && i.stageId === app.stageId && i.status !== 'cancelled' && i.status !== 'no_show')
      if (!mine.length) {
        // A stage the interview plan has no step for is decided the way a review is.
        if (this.schedule(app.id, '11:15') === 0) this.decide(job, app.id, this.rng.chance(this.policy.reviewPassRate) ? 3 : 1)
        continue
      }
      if (mine.some((i) => i.status === 'scheduled')) continue
      const ids = new Set(mine.map((i) => i.id))
      const cards = this.db.scorecards.filter((s) => ids.has(s.interviewId))
      if (!cards.length || cards.some((s) => !s.submittedAt)) continue
      this.decide(job, app.id, cards.reduce((t, s) => t + (s.overall ?? 0), 0) / cards.length)
    }
  }

  /** On to the next stage or the offer when the scorecards average 2.5 or more (of 4), else a rejection. */
  private decide(job: Job, appId: ID, score: number): void {
    const app = this.db.applications.find((a) => a.id === appId)
    if (!app || app.status !== 'active') return
    if (score < 2.5) {
      this.reject(job, appId, this.rng.weighted<OutcomeReason>([['skills_gap', 0.6], ['not_a_fit_level', 0.4]]), '11:15')
      return
    }
    const next = nextStage(job, app.stageId)
    if (!next || next.kind === 'hired') return
    if (next.kind === 'offer') {
      if (!this.liveOffer(job.id)) this.makeOffer(job, appId, next.id)
      return
    }
    this.moveAndSchedule(job, appId, next.id, '11:15')
  }

  /** Now and then a candidate pulls out before an offer. */
  private withdrawals(): void {
    if (this.policy.withdrawPerDay <= 0) return
    for (const { app, job } of this.pipeline()) {
      if (stageById(job, app.stageId)?.kind === 'offer' || !this.rng.chance(this.policy.withdrawPerDay)) continue
      const reason = this.rng.weighted<OutcomeReason>([['withdrew', 0.4], ['chose_other_offer', 0.35], ['timing', 0.15], ['comp', 0.1]])
      this.reject(job, app.id, reason, '14:30', true)
    }
  }

  // ---- Offers ------------------------------------------------------------------------------------

  /**
   * The hiring manager moves the candidate to the offer stage and drafts the offer (offerDefaults, with the
   * job's target start when it leaves ten days' notice); a manager's draft goes to Admin for approval, the
   * founder's goes out once nothing blocks Send.
   */
  private makeOffer(job: Job, appId: ID, offerStageId: string | null): void {
    const hm = this.hiringManager(job)
    if (offerStageId) this.act(hm, '11:30', 'moveApplication', { applicationId: appId, toStageId: offerStageId })
    const target = job.targetStart ? businessDayOnOrAfter(job.targetStart, this.holidays) : undefined
    const startDate = target && target >= addDays(this.day, 10) ? target : defaultStartDate(this.day, this.holidays)
    const replaced = job.backfillForPersonId ? this.db.people.find((p) => p.id === job.backfillForPersonId) : undefined
    const hoursPerWeek = job.employmentType === 'part_time' && replaced ? replaced.hoursPerWeek : undefined
    const offerId = this.act(hm, '11:30', 'createOffer', { applicationId: appId, edits: { startDate, ...(hoursPerWeek ? { hoursPerWeek } : {}) } })
    const offer = this.db.offers.find((o) => o.id === offerId)
    if (offer && approvalRequired(this.db, offer, this.day)) this.act(hm, '11:35', 'submitForApproval', { offerId })
    else this.send(offerId, '11:40')
  }

  /** Mark sent, when the offer card's Send has no blocker; otherwise it waits, counted once by the first reason. */
  private send(offerId: ID, time: string): void {
    const offer = this.db.offers.find((o) => o.id === offerId)
    if (!offer) return
    const blockers = sendBlockerList(this.db, offer, this.day)
    if (blockers.length) {
      if (!this.blockedOffers.has(offerId)) {
        this.blockedOffers.add(offerId)
        this.counts.offersHeld[blockers[0].kind] = (this.counts.offersHeld[blockers[0].kind] ?? 0) + 1
      }
      return
    }
    this.act(this.admin, time, 'markSent', { offerId })
  }

  /** Admin approves the offers submitted before today, and sends what is ready to go. */
  private approveOffers(): void {
    for (const offer of this.db.offers) {
      if (offer.status === 'awaiting_approval' && offer.createdOn < this.day) {
        this.act(this.admin, '09:30', 'approveOffer', { offerId: offer.id })
        this.send(offer.id, '09:35')
      } else if ((offer.status === 'approved' || (offer.status === 'draft' && !approvalRequired(this.db, offer, this.day))) && offer.createdOn < this.day) {
        this.send(offer.id, '09:35')
      }
    }
  }

  /**
   * Candidates answer a business day or more after the offer went out: most accept (Admin records it, hires
   * them and closes out the rest), some decline, and a few never answer, so the offer expires on its date.
   */
  private offerAnswers(): void {
    for (const offer of this.db.offers.filter((o) => o.status === 'sent' && (o.sentOn ?? this.day) < this.day && !this.silent.has(o.id))) {
      if (!this.rng.chance(0.5) && (offer.sentOn ?? this.day) > this.bd(this.day, -3)) continue
      const p = this.policy
      const answer = this.rng.weighted<'accept' | 'decline' | 'silent'>([
        ['accept', p.offerAcceptRate],
        ['decline', p.offerDeclineRate],
        ['silent', Math.max(0, 1 - p.offerAcceptRate - p.offerDeclineRate)],
      ])
      if (answer === 'silent') {
        this.silent.add(offer.id)
        continue
      }
      if (answer === 'decline') {
        this.act(this.admin, '13:30', 'markDeclined', { offerId: offer.id, reason: this.rng.weighted<OutcomeReason>([['chose_other_offer', 0.5], ['comp', 0.3], ['timing', 0.2]]) })
        continue
      }
      this.act(this.admin, '13:30', 'markAccepted', { offerId: offer.id })
      this.act(this.admin, '13:45', 'hireFromOffer', { offerId: offer.id })
      if (closeOutMessage(this.db, offer.jobId)?.applicationIds.length) this.act(this.admin, '13:50', 'closeOutRemaining', { jobId: offer.jobId, notified: true })
    }
  }

  /** An application whose offer expired is closed the next business day: the candidate never answered. */
  private lapsedOffers(): void {
    for (const app of this.db.applications) {
      if (app.status !== 'active') continue
      const offers = this.db.offers.filter((o) => o.applicationId === app.id)
      const latest = offers.reduce<(typeof offers)[number] | undefined>((a, o) => (!a || o.version > a.version ? o : a), undefined)
      if (latest?.status !== 'expired' || (latest.decidedOn ?? this.day) >= this.day) continue
      const job = this.db.jobs.find((j) => j.id === app.jobId)
      if (job) this.reject(job, app.id, 'no_response', '14:00')
    }
  }

  // ---- People ---------------------------------------------------------------------------------------

  /**
   * Time off: some days someone records a sick day, or asks for vacation one to six weeks out. They look at
   * what the request sheet shows first (checkRequest) and send nothing it warns about; a sick day before the
   * service wait still goes to Admin, as the sheet says it will.
   */
  private timeOffRequests(): void {
    const p = this.policy
    for (const person of this.staff()) {
      if (this.away(person)) continue
      const sick = this.rng.chance(p.sickDaysPerYear / 260)
      const vacation = !sick && this.rng.chance(p.vacationRequestsPerYear / 260)
      if (!sick && !vacation) continue
      const policy = policiesFor(this.db, person, this.day).find((x) => (sick ? x.kind === 'sick' : x.kind === 'vacation' || x.kind === 'flexible_vacation'))
      if (!policy) continue
      const startDate = sick ? this.day : this.bd(this.day, this.rng.int(5, 30))
      const endDate = sick ? this.day : this.bd(startDate, this.rng.weighted([[0, 0.35], [1, 0.2], [2, 0.15], [4, 0.3]]))
      const input = { personId: person.id, policyId: policy.id, startDate, endDate }
      const warnings = checkRequest(this.db, input, this.day).warnings.filter((w) => !(sick && warningKind(w) === 'service wait'))
      if (warnings.length) {
        const kind = warningKind(warnings[0])
        this.counts.heldBack[kind] = (this.counts.heldBack[kind] ?? 0) + 1
        continue
      }
      const who = this.as(person.id)
      const early = who.as === 'admin' && !!policy.autoApprove && !!serviceWait(this.db, input)
      this.act(who, '11:50', 'requestTimeOff', { ...input, ...(early ? { earlyChoice: 'waive' as const } : {}) })
    }
  }

  /**
   * Pending requests from before today: the person's manager approves them, or Admin when they have none
   * (or for sick leave held before its service wait, which only Admin decides).
   */
  private timeOffApprovals(): void {
    for (const req of this.db.timeOffRequests) {
      if (req.status !== 'pending' || req.requestedOn >= this.day) continue
      const person = this.db.people.find((p) => p.id === req.personId)
      const policy = this.db.timeOffPolicies.find((p) => p.id === req.policyId)
      const early = !!policy?.autoApprove && !!serviceWait(this.db, req)
      const manager = person?.managerId && person.managerId !== person.id && this.employed(person.managerId) ? person.managerId : null
      const who = early || !manager ? this.admin : manager === this.admin.id ? this.admin : { id: manager, as: 'manager' as const }
      this.act(who, '13:00', 'approveTimeOff', { requestId: req.id })
    }
  }

  /** On a work anniversary, a merit raise from the next pay period as Change job or pay proposes it, unless it leaves the band. */
  private raises(): void {
    const rate = this.policy.anniversaryRaiseRate
    if (rate <= 0) return
    for (const person of this.staff()) {
      if (person.id === this.admin.id || person.separation) continue
      const md = person.startDate.slice(4) === '-02-29' ? '-02-28' : person.startDate.slice(4)
      const years = [...new Set([this.lastBusinessDay.slice(0, 4), this.day.slice(0, 4)])]
      const due = years.some((y) => y > person.startDate.slice(0, 4) && `${y}${md}` > this.lastBusinessDay && `${y}${md}` <= this.day)
      if (!due || !this.rng.chance(rate)) continue
      const rec = currentJob(this.db, person.id, this.day)
      const hourly = rec?.payType === 'hourly'
      const current = (hourly ? rec?.hourlyRate : rec?.salary) ?? 0
      if (!rec || current <= 0) continue
      const band = bandFor(this.db, person.familyId, rec.levelId ?? person.levelId)
      const pay = hourly ? Math.round(current * 1.04 * 4) / 4 : proposedBase('merit', current, band)
      const fte = fullTimeEquivalentBase(hourly ? { payType: 'hourly', hourlyRate: pay } : { payType: 'salary', salary: pay }, person.hoursPerWeek || 40)
      if (band && (fte < band.min || fte > band.max)) {
        this.counts.raisesHeld += 1
        continue
      }
      const effectiveOn = effectiveDatePresets(this.day, this.db.company.paySchedule, this.db.company.firstPayrollOn)[0].date
      this.act(this.admin, '10:30', 'changeJobOrPay', { personId: person.id, change: { effectiveOn, reason: 'merit', ...(hourly ? { hourlyRate: pay } : { salary: pay }) } })
    }
  }

  /** Monday: now and then someone asks for a protected leave; Admin opens the case when leaveEligibility says they qualify. */
  private leaves(): void {
    const rate = this.policy.leavesPerYear
    if (rate <= 0) return
    for (const person of this.staff()) {
      if (person.id === this.admin.id || this.away(person) || !this.rng.chance(rate / 52)) continue
      const kind = this.rng.weighted<'bonding' | 'cfra'>([
        ['bonding', 0.6],
        ['cfra', 0.4],
      ])
      if (!leaveEligibility(this.db, person.id, kind, this.day).eligible) continue
      const startDate = businessDayOnOrAfter(addDays(this.day, this.rng.int(10, 24)), this.holidays)
      const expectedReturn = businessDayOnOrAfter(addDays(startDate, 7 * this.rng.int(6, 12)), this.holidays)
      this.act(this.admin, '10:45', 'startLeave', { personId: person.id, kind, requestedOn: this.day, startDate, expectedReturn })
    }
  }

  /** People back from leave on their expected return day: Admin marks them returned. */
  private returnsFromLeave(): void {
    for (const leave of this.db.leaveCases) {
      if (leave.returnedOn || leave.endedOn || !leave.expectedReturn || leave.expectedReturn > this.day || !this.employed(leave.personId)) continue
      this.act(this.admin, '09:00', 'markReturned', { leaveId: leave.id })
    }
  }

  /**
   * Monday: now and then someone resigns with two weeks' notice. Only people who hold nothing to hand off
   * (no job, candidate, interview or team in their name, leaverRoles) and have been here 90 days; most
   * roles are backfilled the same day, from the Offboard wizard's Backfill?.
   */
  private resignations(): void {
    const rate = this.policy.attritionPerYear
    if (rate <= 0) return
    for (const person of this.staff()) {
      if (person.id === this.admin.id || this.away(person) || person.startDate > addDays(this.day, -90)) continue
      if (!this.rng.chance(rate / 52)) continue
      const lastDay = nextFriday(this.day, 2)
      if (leaverRoles(this.db, person.id, lastDay).length) continue
      this.act(this.admin, '11:00', 'offboardPerson', {
        personId: person.id,
        type: 'resigned_notice',
        reason: this.rng.pick(RESIGN_REASONS),
        lastDay,
        noticeGivenOn: this.day,
        rehireEligible: true,
      })
      if (!this.rng.chance(this.policy.backfillRate) || this.hooks?.frozen(this.day)) continue
      const jobId = this.act(this.admin, '11:05', 'openBackfill', { personId: person.id })
      this.readyAndPost(jobId, '11:10')
    }
  }

  /** Checklist tasks due by today that someone other than Admin owns: done by them on the day. Admin's wait for the inbox. */
  private tasks(): void {
    for (const checklist of this.db.checklists) {
      for (const task of checklist.tasks) {
        if (task.status !== 'open' || task.dueOn > this.day || task.templateTaskId === TASK_IDS.designation) continue
        const owner = taskOwnerId(this.db, checklist, task)
        if (!owner || owner === this.admin.id || !this.employed(owner)) continue
        this.act({ id: owner, as: task.ownerRole === 'manager' ? 'manager' : 'employee' }, '15:00', 'setTaskStatus', { checklistId: checklist.id, taskId: task.id, status: 'done' })
      }
    }
  }

  // ---- Pay runs, the inbox and compliance -------------------------------------------------------------

  /**
   * Each pay period on its 'run payroll by' day: Admin opens the prep (payRunPrep, totals from payRunTotals)
   * and marks it submitted. A period whose cutoff passed before the advance but whose payday has not is run
   * late, on the first business day.
   */
  private payRuns(): void {
    const first = addDays(this.from, 1)
    for (const period of payCalendar(this.db, addDays(this.day, -45), addDays(this.day, 31))) {
      if (period.cutoff > this.day || period.payday < first) continue
      if (runForPeriod(this.db.company.payRuns, period)?.submittedOn || !hasPaidPeople(this.db, period)) continue
      const prep = payRunPrep(this.db, period, this.day)
      this.act(this.admin, '10:00', 'markPayRunSubmitted', { start: period.start, end: period.end, payday: period.payday })
      this.counts.payRuns.push({
        start: period.start,
        end: period.end,
        payday: period.payday,
        submittedOn: this.day,
        late: period.cutoff < this.day,
        people: prep.totals.people,
        estimatedGross: prep.totals.estimatedGross,
      })
    }
  }

  /** True while an inbox op still has something to do (an earlier op in the same sweep may have done it). */
  private stillDue(op: InboxOp): boolean {
    const db = this.db
    switch (op.type) {
      case 'task_status':
        return db.checklists.some((c) => c.id === op.checklistId && c.tasks.some((t) => t.id === op.taskId && t.status === 'open'))
      case 'approve_offer':
        return db.offers.some((o) => o.id === op.offerId && o.status === 'awaiting_approval')
      case 'approve_timeoff':
      case 'approve_timeoff_unpaid':
        return db.timeOffRequests.some((r) => r.id === op.requestId && r.status === 'pending')
      case 'leave_notice_sent':
        return db.leaveCases.some((l) => l.id === op.leaveCaseId && !l.designationNoticeSentOn)
      case 'acknowledge': {
        const policy = db.policies.find((p) => p.id === op.policyId)
        return !!policy && !db.acks.some((a) => a.personId === op.personId && a.policyId === policy.id && a.version === policy.version)
      }
      case 'add_holidays':
        return !hasHolidaysIn(db.holidays, op.year)
      case 'payrun_submitted':
        return !(db.company.payRuns ?? []).some((r) => r.periodStart === op.periodStart && r.submittedOn)
      default:
        return true
    }
  }

  /**
   * Monday afternoon: Admin goes through Home's inbox and presses the one button on each item waiting on them
   * that is due this week or overdue, when that button is a change the simulator makes (INBOX_OP_TYPES).
   */
  private sweepInbox(): void {
    this.counts.sweeps += 1
    const person = this.db.people.find((p) => p.id === this.admin.id)
    const items = inboxItems(this.db, { role: 'admin', person, personId: this.admin.id }, this.day)
      .filter((i) => i.waitingOn === 'you' && i.group !== 'coming_up' && i.primary.kind === 'mutate' && INBOX_OP_TYPES.has(i.primary.op.type))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const seen = new Set<string>()
    for (const item of items) {
      if (item.primary.kind !== 'mutate') continue
      const op = item.primary.op
      if (op.type === 'task_status' && op.status !== 'done') continue
      const key = JSON.stringify(op)
      if (seen.has(key) || !this.stillDue(op)) continue
      seen.add(key)
      this.act(this.admin, '15:30', 'inboxOp', { op: cleanOp(op) })
      this.counts.cleared[op.type] = (this.counts.cleared[op.type] ?? 0) + 1
    }
  }

  /** Monday: the compliance rules as the Compliance page evaluates them; rules that newly apply are reported. */
  private checkCompliance(): void {
    const results = evaluateAll(this.db, this.day)
    const applies = new Set(results.filter((r) => r.state === 'applies').map((r) => r.rule.id))
    if (this.applies) {
      for (const r of results) if (applies.has(r.rule.id) && !this.applies.has(r.rule.id)) this.counts.began.push({ title: r.rule.title, on: this.day })
    }
    this.applies = applies
    this.counts.checks += 1
    this.counts.openActions = summarizeResults(results).openActions
  }

  /** The report, counted from the trace and from the workspace on `to` (default: the last day lived). */
  finish(to: ISODate = this.today): AdvanceReport {
    const trace = this.sim.trace
    const count = (name: ActionName, test: (args: Record<string, unknown>) => boolean = () => true) =>
      trace.filter((t) => t.action === name && test(t.args as Record<string, unknown>)).length
    const db = this.db
    const sickPolicies = new Set(db.timeOffPolicies.filter((p) => p.kind === 'sick').map((p) => p.id))
    return {
      days: this.counts.days,
      businessDays: this.counts.businessDays,
      actions: trace.length,
      headcount: {
        from: this.startHeadcount,
        to: employedOn(db, to).length,
        starts: db.people.filter((p) => p.startDate > this.from && p.startDate <= to).length,
        separations: count('offboardPerson'),
        incoming: incomingOn(db, to).length,
      },
      timeOff: {
        vacation: count('requestTimeOff', (a) => !sickPolicies.has(a.policyId as string)),
        sick: count('requestTimeOff', (a) => sickPolicies.has(a.policyId as string)),
        approved: count('approveTimeOff'),
        heldBack: sorted(this.counts.heldBack),
      },
      hiring: {
        planned: count('addPlanLine'),
        opened: count('openJobFromPlan') + count('openBackfill'),
        backfills: count('openBackfill'),
        postingsHeld: this.heldPostings.size,
        candidates: count('addCandidate'),
        interviews: count('scheduleInterview'),
        scorecards: count('submitScorecard'),
        rejected: count('rejectApplication', (a) => !a.withdraw),
        withdrew: count('rejectApplication', (a) => !!a.withdraw),
        offersDrafted: count('createOffer'),
        offersSent: count('markSent'),
        accepted: count('markAccepted'),
        declined: count('markDeclined'),
        expired: db.offers.filter((o) => o.status === 'expired' && (o.decidedOn ?? '') >= this.from && (o.decidedOn ?? '') < to).length,
        offersHeld: sorted(this.counts.offersHeld),
        hires: count('hireFromOffer'),
      },
      raises: { given: count('changeJobOrPay'), heldOutsideBand: this.counts.raisesHeld },
      leaves: { started: count('startLeave'), returned: count('markReturned') },
      payRuns: this.counts.payRuns,
      inbox: { sweeps: this.counts.sweeps, cleared: sorted(this.counts.cleared) },
      tasksDone: count('setTaskStatus'),
      holidaysAdded: this.counts.holidaysAdded,
      compliance: { checks: this.counts.checks, began: this.counts.began, openActions: this.counts.openActions },
    }
  }
}

const UNFILLED = new Set<PlanSlot['status']>(['planned', 'open', 'offer'])

/**
 * Plan lines planned, open or with an offer out: roles the company means to fill. Read the way Comp and
 * plan reads them (planSlotStatus), so a line whose job was closed without hiring counts as cut.
 */
function unfilledPlan(db: DB): number {
  return db.plan.filter((s) => UNFILLED.has(planSlotStatus(db, s))).length
}

/** Empties a set and fills it with `values`, in their order. */
function refill<T>(set: Set<T>, values: readonly T[]): void {
  set.clear()
  for (const v of values) set.add(v)
}

/** A count map with its keys in order, so the report's JSON never depends on the order things happened. */
function sorted(m: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : 1)))
}

/** An inbox op with only the fields its type has, as the action's args take it. */
function cleanOp(op: InboxOp): ArgsOf<'inboxOp'>['op'] {
  switch (op.type) {
    case 'task_status':
      return { type: op.type, checklistId: op.checklistId, taskId: op.taskId, status: 'done' }
    case 'approve_offer':
      return { type: op.type, offerId: op.offerId }
    case 'approve_timeoff':
    case 'approve_timeoff_unpaid':
      return { type: op.type, requestId: op.requestId }
    case 'leave_notice_sent':
      return { type: op.type, leaveCaseId: op.leaveCaseId }
    case 'rule_action_done':
      return { type: op.type, ruleId: op.ruleId, actionId: op.actionId }
    case 'training_done':
      return { type: op.type, personId: op.personId, kind: op.kind }
    case 'recurring_done':
      return { type: op.type, recurringId: op.recurringId }
    case 'access_review_done':
      return { type: op.type, quarter: op.quarter }
    case 'annual_done':
      return { type: op.type, ruleId: op.ruleId, year: op.year }
    case 'acknowledge':
      return { type: op.type, policyId: op.policyId, personId: op.personId }
    case 'add_holidays':
      return { type: op.type, year: op.year }
    case 'payrun_submitted':
      return { type: op.type, periodStart: op.periodStart }
    default:
      throw new Error(`The simulator does not apply inbox ops of type ${op.type}.`)
  }
}
