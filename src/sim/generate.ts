// Generated companies (docs/DEV.md, "Generated companies"). generateCompany starts from a blank workspace on
// the founding date and builds the company only through actions (src/sim/actions.ts), the steps people take
// in the app: the founder sets up the org and their pay, then every later employee arrives through the
// hiring pipeline (a job, candidates, interviews, scorecards, an offer, the hire), so each one has a
// candidate, an application, an offer, a starting pay row, a grant when the offer has options, an
// onboarding checklist, documents and activity. Pay runs are marked submitted, checklist tasks are done on
// their due dates, and the app's own load-time changes run each morning.
//
// The story is a queue of events in date and time order, each one a few actions by one person. Nothing
// after the as-of date happens: jobs whose people start later are open on the as-of date, with their
// candidates part way through. The whole generation is one run (src/lib/runContext.ts) seeded with the
// scenario and seed, and every random choice comes from one seeded generator, so the same scenario and seed
// give byte-identical JSON on every computer.
import { blankDB } from '@/data/blank'
import { defaultHolidays } from '@/data/defaults'
import { DEFAULT_LAW, LOCAL_MIN_WAGES } from '@/data/law'
import { buildSampleDB, SAMPLE_ANCHOR } from '@/data/seed'
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
import { DEFAULT_ROLE_TEMPLATES } from '@/data/starterRoleTemplates'
import { businessDayOnOrAfter, closeOutMessage, dbHolidays, defaultStartDate, effectiveBand, mondayOnOrAfter, nextStage, stageById } from '@/domain/hiring'
import { payCalendar, periodContaining } from '@/domain/payrun/calendar'
import { isEmployedOn } from '@/domain/people'
import type { Candidate, DB, ID, OutcomeReason, Rating, Role } from '@/domain/types'
import { proposedSlots } from '@/features/hiring/interviews/conflicts'
import { defaultStepFor, formatForStage } from '@/features/hiring/interviews/logic'
import { addBusinessDays, addDays, addMonths, getClockOverride, type ISODate, isUsableDate, pacificDateOf, setClockOverride } from '@/lib/dates'
import { withRunContext } from '@/lib/runContext'
import { type ActionName, type ArgsOf, applyAction, type ResultOf, type SimState, type TraceLine } from './actions'
import { profileFor, slug } from './profiles'
import { type CompanyPlan, type PayPeriodDay, type RolePlan, SCENARIOS, type Scenario, type ScenarioName } from './scenarios'
import { summarize } from './summary'

export type GenerateOptions = {
  scenario: ScenarioName
  /** Default: the scenario's own seed. */
  seed?: number
  /** Default: the scenario's own as-of date. */
  asOf?: ISODate
}

export type GeneratedCompany = {
  scenario: ScenarioName
  seed: number
  asOf: ISODate
  db: DB
  /** Every action applied, in order (traceToJsonLines writes it as JSON lines). Empty for ledgerlark. */
  trace: TraceLine[]
  /** A short plain-text account: headcount, departments, hires by month, open roles, pay runs. */
  summary: string
}

/** Generates a scenario's company. Any as-of date works: dates outside 2026 use the rules the app has (the 2026 law tables). */
export function generateCompany(options: GenerateOptions): GeneratedCompany {
  const scenario: Scenario | undefined = SCENARIOS[options.scenario]
  if (!scenario) throw new Error(`No scenario named ${options.scenario}.`)
  const seed = options.seed ?? scenario.seed
  const asOf = options.asOf ?? scenario.asOf
  if (!Number.isSafeInteger(seed)) throw new Error(`A seed is a whole number, not ${seed}.`)
  if (!isUsableDate(asOf)) throw new Error(`The as-of date is a date written YYYY-MM-DD, not '${asOf}'.`)

  if (scenario.kind === 'sample') {
    if (asOf !== SAMPLE_ANCHOR || seed !== scenario.seed) {
      throw new Error(`ledgerlark is the sample exactly as buildSampleDB builds it: as of ${SAMPLE_ANCHOR}, with no seed of its own.`)
    }
    const db = buildSampleDB()
    return { scenario: scenario.name, seed, asOf, db, trace: [], summary: summarize(db, { scenario, seed, asOf, actions: 0 }) }
  }

  const plan = scenario.company as CompanyPlan
  const foundedOn = foundingDate(plan, asOf)

  const previous = getClockOverride()
  try {
    const sim = withRunContext({ seed: `${scenario.name} ${seed}`, actorId: FOUNDER, viewingAs: 'admin', timeOfDay: '09:00' }, () => {
      setClockOverride(foundedOn)
      const world = new World(scenario, plan, seed, asOf, foundedOn)
      return world.run()
    })
    return { scenario: scenario.name, seed, asOf, db: sim.db, trace: sim.trace, summary: summarize(sim.db, { scenario, seed, asOf, actions: sim.trace.length }) }
  } finally {
    setClockOverride(previous)
  }
}

/** The date a PayPeriodDay names for a company as of `asOf`, by its pay schedule (the last day of a short period at most). */
function payPeriodDay(db: DB, asOf: ISODate, at: PayPeriodDay): ISODate {
  let period = periodContaining(db, asOf)
  for (let k = 0; k < at.periodsBack; k++) period = periodContaining(db, addDays(period.start, -1))
  const day = addDays(period.start, at.day - 1)
  return day > period.end ? period.end : day
}

/** The founding date: `ageMonths` before the as-of date, on a business day. */
function foundingDate(plan: CompanyPlan, asOf: ISODate): ISODate {
  return businessDayOnOrAfter(addMonths(asOf, -plan.ageMonths), defaultHolidays())
}

// ---------------------------------------------------------------------------------------------
// The story
// ---------------------------------------------------------------------------------------------

const FOUNDER = 'p-founder'

type Event = { date: ISODate; time: string; seq: number; run: () => void }

/** A binary heap of events by date, then time, then the order they were added. */
class Queue {
  private heap: Event[] = []

  get size(): number {
    return this.heap.length
  }

  private static before(a: Event, b: Event): boolean {
    return a.date !== b.date ? a.date < b.date : a.time !== b.time ? a.time < b.time : a.seq < b.seq
  }

  push(e: Event): void {
    const h = this.heap
    h.push(e)
    let i = h.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (!Queue.before(h[i], h[parent])) break
      ;[h[i], h[parent]] = [h[parent], h[i]]
      i = parent
    }
  }

  pop(): Event | undefined {
    const h = this.heap
    const top = h[0]
    const last = h.pop()
    if (h.length && last) {
      h[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < h.length && Queue.before(h[l], h[m])) m = l
        if (r < h.length && Queue.before(h[r], h[m])) m = r
        if (m === i) break
        ;[h[i], h[m]] = [h[m], h[i]]
        i = m
      }
    }
    return top
  }
}

/** Where a candidate stops when they are not the one hired: the stage, and how it ends. */
type Exit = { stage: 'new' | 'intro' | 'technical' | 'onsite'; how: 'reject' | 'withdraw'; reason: OutcomeReason }

type RoleState = {
  index: number
  plan: RolePlan
  departmentId: ID
  profile: ProfileKey
  plannedStart: ISODate
  jobId?: ID
  hiringManagerId?: ID
  personId?: ID
}

type Who = { id: ID; as: Role }

/** A 32-bit seed for the story's random choices from the scenario name and seed (FNV-1a). */
function storySeed(name: string, seed: number): number {
  let h = 0x811c9dc5
  for (const ch of `story ${name} ${seed}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193)
  return h >>> 0
}

class World {
  private readonly sim: SimState
  private readonly rng: Rng
  private readonly queue = new Queue()
  private readonly holidays: ISODate[]
  private readonly roles: RoleState[]
  private readonly usedNames = new Set(reservedNames().map((n) => n.toLowerCase()))
  private readonly usedEmails = new Set<string>()
  private readonly companySlug: string
  private day: ISODate
  private time = '00:00'
  private seq = 0

  constructor(
    private readonly scenario: Scenario,
    private readonly plan: CompanyPlan,
    seed: number,
    private readonly asOf: ISODate,
    private readonly foundedOn: ISODate,
  ) {
    this.rng = makeRng(storySeed(scenario.name, seed))
    this.companySlug = slug(plan.name)
    const [first, last] = this.newName()
    const db = blankDB({
      companyName: plan.name,
      founderFirstName: first,
      founderLastName: last,
      founderTitle: plan.founderTitle,
      // A reserved domain (.example), so no generated address can belong to anyone.
      founderEmail: `${slug(first)}@${this.companySlug}.example`,
      foundedOn,
      hqCity: 'San Jose',
      hqState: 'CA',
      hqZip: '95113',
    })
    this.sim = { db, trace: [] }
    this.holidays = dbHolidays(db)
    this.day = foundedOn
    this.roles = plan.roles.map((p, index) => {
      const template = DEFAULT_ROLE_TEMPLATES.find((t) => t.id === p.template)
      if (!template) throw new Error(`${scenario.name}: no role template ${p.template}.`)
      const plannedStart = businessDayOnOrAfter(p.startsOn ? payPeriodDay(db, asOf, p.startsOn) : mondayOnOrAfter(addDays(asOf, -p.startsDaysBeforeAsOf)), this.holidays)
      return { index, plan: p, departmentId: p.departmentId ?? template.departmentId, profile: profileFor(p), plannedStart }
    })
  }

  /** Runs every event up to the as-of date and returns the simulation. */
  run(): SimState {
    if (this.scenario.kind === 'company') {
      this.at(this.foundedOn, '09:00', () => this.foundingDay())
    }
    for (let e = this.queue.pop(); e; e = this.queue.pop()) {
      if (e.date !== this.day) {
        this.day = e.date
        this.time = '00:00'
        this.act({ id: FOUNDER, as: 'admin' }, '08:00', 'openApp', {})
      }
      if (e.time > this.time) this.time = e.time
      e.run()
    }
    if (this.day !== this.asOf) {
      this.day = this.asOf
      this.act({ id: FOUNDER, as: 'admin' }, '08:00', 'openApp', {})
    }
    return this.sim
  }

  // ---- Plumbing --------------------------------------------------------------------------------

  /** Queues `run` for a date and time. Nothing after the as-of date happens; earlier today moves to now. */
  private at(date: ISODate, time: string, run: () => void): void {
    if (date > this.asOf) return
    if (date < this.day) throw new Error(`${this.scenario.name}: an event on ${date} was queued on ${this.day}.`)
    this.queue.push({ date, time: date === this.day && time < this.time ? this.time : time, seq: this.seq++, run })
  }

  /**
   * Applies an action as `who` today at `time` (or now, when that is later: the story's clock never goes
   * back within a day), then follows up on any checklist it created.
   */
  private act<N extends ActionName>(who: Who, time: string, name: N, args: ArgsOf<N>): ResultOf<N> {
    const at = time < this.time ? this.time : time
    this.time = at
    const traced = this.sim.trace.length
    const result = applyAction(this.sim, name, args, { day: this.day, time: at, actorId: who.id, viewingAs: who.as })
    const created = new Set(this.sim.trace.length > traced ? this.sim.trace[traced].created : [])
    if (created.size) for (const c of this.sim.db.checklists) if (created.has(c.id)) this.followChecklist(c.id)
    return result
  }

  private get db(): DB {
    return this.sim.db
  }

  private bd(date: ISODate, n: number): ISODate {
    return addBusinessDays(date, n, this.holidays)
  }

  private employed(personId: ID | undefined, date: ISODate): boolean {
    const p = personId ? this.db.people.find((x) => x.id === personId) : undefined
    return !!p && isEmployedOn(p, date)
  }

  /** The person acting for a job: its hiring manager as a manager, or the founder as admin. */
  private manager(hiringManagerId: ID): Who {
    return hiringManagerId === FOUNDER ? { id: FOUNDER, as: 'admin' } : { id: hiringManagerId, as: 'manager' }
  }

  /** A full name no one in the company or the sample has. */
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

  // ---- The founding day -------------------------------------------------------------------------

  private foundingDay(): void {
    const founder: Who = { id: FOUNDER, as: 'admin' }
    const setup = this.plan.setup ?? {}
    for (const d of setup.departments ?? []) this.act(founder, '09:00', 'saveDepartment', { id: d.id, name: d.name })
    for (const l of setup.levels ?? []) this.act(founder, '09:00', 'saveLevel', l)
    for (const l of setup.locations ?? []) {
      // The local minimum wage in effect on the as-of date, as the location sheet prefills it (localMinWage).
      const row = LOCAL_MIN_WAGES.find((r) => r.city.toLowerCase() === l.city.toLowerCase())
      const local = !row ? undefined : row.next && this.asOf >= row.next.effective ? row.next.hourly : this.asOf >= row.effective ? row.hourly : undefined
      this.act(founder, '09:00', 'saveLocation', {
        id: l.id,
        name: l.name,
        kind: 'hq',
        city: l.city,
        state: 'CA',
        minWageHourly: local ?? DEFAULT_LAW.caMinWageHourly,
        minWageNote: local ? `City of ${row?.city} minimum wage` : 'California minimum wage',
        publicAccess: false,
        typicalMaxOnSite: 5,
      })
    }
    for (const b of setup.bands ?? []) {
      // The band's edit sheet starts from its current values; the scenario changes the ones it names.
      const current = this.db.bands.find((x) => x.familyId === b.familyId && x.levelId === b.levelId)
      const start = current
        ? { min: current.min, mid: current.mid, max: current.max, equityMinPct: current.equityMinPct, equityMaxPct: current.equityMaxPct, ...(current.variablePct ? { variablePct: current.variablePct } : {}) }
        : {}
      this.act(founder, '09:10', 'saveBand', { ...start, ...b } as ArgsOf<'saveBand'>)
    }
    this.act(founder, '09:30', 'changeJobOrPay', {
      personId: FOUNDER,
      change: { effectiveOn: this.foundedOn, reason: 'market', salary: this.plan.founderSalary, flsa: 'exempt', exemptionBasis: 'executive' },
    })

    // Every payroll from the founder's first: marked submitted on its 'run payroll by' day.
    for (const p of payCalendar(this.db, this.foundedOn, this.asOf)) {
      if (p.cutoff < this.foundedOn) continue
      this.at(p.cutoff, '10:00', () => this.act(founder, '10:00', 'markPayRunSubmitted', { start: p.start, end: p.end, payday: p.payday }))
    }

    // Each job opens six or seven weeks before its person is due to start (or on the day the plan says), never
    // in the company's first two weeks.
    for (const role of this.roles) {
      const lead = this.rng.int(40, 52)
      const opens = role.plan.opensDaysBeforeAsOf
      const open = businessDayOnOrAfter(opens != null ? addDays(this.asOf, -opens) : addDays(role.plannedStart, -lead), this.holidays)
      const earliest = businessDayOnOrAfter(addDays(this.foundedOn, 14), this.holidays)
      this.at(open < earliest ? earliest : open, '08:45', () => this.openJob(role))
    }

    const life = this.plan.life
    if (life?.leave) {
      const l = life.leave
      const requestedOn = businessDayOnOrAfter(addDays(this.asOf, -l.requestedDaysBeforeAsOf), this.holidays)
      this.at(requestedOn, '10:30', () => {
        const personId = this.roles[l.role]?.personId
        if (!personId || !this.employed(personId, this.day)) throw new Error(`${this.scenario.name}: nobody from role ${l.role} is employed to take leave on ${this.day}.`)
        this.act(founder, '10:30', 'startLeave', {
          personId,
          kind: l.kind,
          requestedOn,
          startDate: payPeriodDay(this.db, this.asOf, l.startsOn),
          expectedReturn: addDays(this.asOf, l.returnsDaysAfterAsOf),
        })
      })
    }
    if (life?.termination) {
      const t = life.termination
      const lastDay = payPeriodDay(this.db, this.asOf, t.lastDayOn)
      this.at(lastDay, '10:30', () => {
        const personId = this.roles[t.role]?.personId
        if (!personId || !this.employed(personId, this.day)) throw new Error(`${this.scenario.name}: nobody from role ${t.role} is employed to let go on ${this.day}.`)
        this.act(founder, '10:30', 'offboardPerson', { personId, type: 'terminated', reason: t.reason, lastDay, rehireEligible: false })
      })
    }
  }

  // ---- Checklists ---------------------------------------------------------------------------------

  /**
   * Marks each open task of a new checklist done on its due date (or today, for one already due), by the
   * person it is assigned to while they work here, else the founder. Tasks due after the as-of date stay
   * open. The leave notice goes through markDesignationSent, as every screen that marks it does.
   */
  private followChecklist(checklistId: ID): void {
    const checklist = this.db.checklists.find((c) => c.id === checklistId)
    if (!checklist) return
    const byDay = new Map<ISODate, ID[]>()
    for (const t of checklist.tasks) {
      if (t.status !== 'open') continue
      const when = t.dueOn < this.day ? this.day : t.dueOn
      byDay.set(when, [...(byDay.get(when) ?? []), t.id])
    }
    for (const [when, taskIds] of [...byDay].sort(([a], [b]) => (a < b ? -1 : 1))) {
      this.at(when, '15:00', () => {
        for (const taskId of taskIds) {
          const list = this.db.checklists.find((c) => c.id === checklistId)
          const task = list?.tasks.find((t) => t.id === taskId)
          if (!list || !task || task.status !== 'open') continue
          if (list.kind === 'leave' && task.templateTaskId === 'lv-designation') {
            const leave = this.db.leaveCases.find((l) => l.personId === list.personId && l.startDate === list.anchorDate && !l.designationNoticeSentOn)
            if (leave) this.act({ id: FOUNDER, as: 'admin' }, '15:00', 'markDesignationSent', { leaveId: leave.id })
            continue
          }
          const assignee = task.assigneeId && task.assigneeId !== FOUNDER && this.employed(task.assigneeId, this.day) ? task.assigneeId : FOUNDER
          const as: Role = assignee === FOUNDER || task.ownerRole === 'admin' ? 'admin' : task.ownerRole === 'manager' ? 'manager' : 'employee'
          this.act({ id: assignee, as }, '15:00', 'setTaskStatus', { checklistId, taskId, status: 'done' })
        }
      })
    }
  }

  // ---- Jobs ------------------------------------------------------------------------------------------

  /** The hiring manager: the founder for leads, else the department's lead once they have started. */
  private hiringManagerFor(role: RoleState): ID {
    if (role.plan.lead) return FOUNDER
    const lead = this.roles.find((r) => r.plan.lead && r.departmentId === role.departmentId && r.personId && r.index !== role.index)
    return lead?.personId && this.employed(lead.personId, this.day) ? lead.personId : FOUNDER
  }

  /** The founder adds the role to the headcount plan, opens a job from that line with New job, and posts it. */
  private openJob(role: RoleState): void {
    const founder: Who = { id: FOUNDER, as: 'admin' }
    const p = role.plan
    const template = DEFAULT_ROLE_TEMPLATES.find((t) => t.id === p.template)
    const familyId = p.familyId ?? template?.familyId ?? 'f-eng'
    const levelId = p.levelId ?? template?.levelId ?? 'lv-l3'
    const band = p.hourly ? undefined : effectiveBand(this.db, familyId, levelId)
    const planSlotId = this.act(founder, '08:45', 'addPlanLine', {
      title: p.title ?? template?.name ?? 'New role',
      departmentId: role.departmentId,
      familyId,
      levelId,
      targetStart: role.plannedStart,
      ...(band ? { budgetBase: band.mid } : {}),
    })
    const hm = this.hiringManagerFor(role)
    const jobId = this.act(founder, '09:00', 'createJob', {
      templateId: p.template,
      hiringManagerId: hm,
      planSlotId,
      ...(p.locationId ? { locationIds: [p.locationId] } : {}),
      ...(p.hourly
        ? { employmentType: p.hourly.partTime ? ('part_time' as const) : ('full_time' as const), payMin: p.hourly.range[0], payMax: p.hourly.range[1] }
        : {}),
    })
    this.act(founder, '09:05', 'markPosted', { jobId })
    role.jobId = jobId
    role.hiringManagerId = hm

    // The one who is hired applies in the first two business days; the rest over the first two and a half weeks.
    const [fewest, most] = p.pipeline ?? this.plan.pipeline
    const others = this.rng.int(fewest, most)
    this.at(this.bd(this.day, this.rng.int(1, 2)), '09:30', () => this.arrive(role, null))
    for (let i = 0; i < others; i++) {
      const exit = this.exitFor()
      this.at(this.bd(this.day, this.rng.int(1, 12)), '09:40', () => this.arrive(role, exit))
    }
  }

  /** Where a candidate who is not hired stops: most at review, fewer at each later stage, some withdraw. */
  private exitFor(): Exit {
    const r = this.rng
    if (r.chance(0.08)) {
      const stage = r.weighted<Exit['stage']>([
        ['intro', 0.5],
        ['technical', 0.3],
        ['onsite', 0.2],
      ])
      return { stage, how: 'withdraw', reason: r.weighted<OutcomeReason>([['withdrew', 0.4], ['chose_other_offer', 0.35], ['timing', 0.15], ['comp', 0.1]]) }
    }
    const stage = r.weighted<Exit['stage']>([
      ['new', 0.5],
      ['intro', 0.24],
      ['technical', 0.16],
      ['onsite', 0.1],
    ])
    const reasons: Record<Exit['stage'], Array<[OutcomeReason, number]>> = {
      new: [['not_a_fit_level', 0.4], ['skills_gap', 0.35], ['location', 0.15], ['comp', 0.1]],
      intro: [['skills_gap', 0.4], ['not_a_fit_level', 0.3], ['comp', 0.2], ['timing', 0.1]],
      technical: [['skills_gap', 0.7], ['not_a_fit_level', 0.3]],
      onsite: [['skills_gap', 0.55], ['not_a_fit_level', 0.45]],
    }
    return { stage, how: 'reject', reason: r.weighted(reasons[stage]) }
  }

  // ---- Candidates -----------------------------------------------------------------------------------

  /** A candidate applies and Admin adds them with Quick add. exit null: the one who is hired. */
  private arrive(role: RoleState, exit: Exit | null): void {
    const job = this.db.jobs.find((j) => j.id === role.jobId)
    if (!job || job.status !== 'open') return
    const r = this.rng
    const [first, last] = this.newName()
    let email = `${slug(first)}.${slug(last)}@${r.pick(['example.com', 'example.net', 'example.org'])}`
    for (let n = 2; this.usedEmails.has(email); n++) email = email.replace(/(\d*)@/, `${n}@`)
    this.usedEmails.add(email)
    const [location] =
      exit === null
        ? r.pick(bayAreaPlaces())
        : r.weighted<[string, string]>([
            [r.pick(bayAreaPlaces()), 0.7],
            [r.pick(otherCaliforniaPlaces()), 0.15],
            [r.pick(outOfStatePlaces()), 0.15],
          ])
    const prof = profile(role.profile)
    const hourly = role.plan.hourly
    const band = effectiveBand(this.db, job.familyId, job.levelId, job)
    const desired = hourly
      ? { desiredPay: Math.round((hourly.range[0] + r.next() * (hourly.range[1] - hourly.range[0])) * 4) / 4, desiredPayUnit: 'hour' as const }
      : band
        ? { desiredPay: Math.round((band.min + r.next() * (band.max * 1.08 - band.min)) / 5000) * 5000 }
        : {}
    const source = r.weighted<Candidate['source']>([
      ['inbound', 0.55],
      ['outbound', 0.2],
      ['referral', 0.15],
      ['agency', 0.1],
    ])
    const referrers = source === 'referral' ? this.db.people.filter((p) => isEmployedOn(p, this.day)) : []
    // Quick add keeps a source detail only for an agency: its name.
    const detail = source === 'agency' ? r.pick(['Lanternfish Talent', 'Bramblegate Search']) : undefined
    const added = this.act({ id: FOUNDER, as: 'admin' }, this.time, 'addCandidate', {
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
    const appId = added.applicationId as ID
    this.at(this.bd(this.day, r.int(1, 4)), '10:00', () => this.review(role, appId, exit))
  }

  private application(appId: ID) {
    return this.db.applications.find((a) => a.id === appId)
  }

  /** The hiring manager reviews the application: rejects it, or moves it to the first interview stage. */
  private review(role: RoleState, appId: ID, exit: Exit | null): void {
    const app = this.application(appId)
    if (!app || app.status !== 'active') return
    if (exit?.stage === 'new') return this.close(role, appId, exit)
    const job = this.db.jobs.find((j) => j.id === app.jobId)
    const next = job && nextStage(job, app.stageId)
    if (!job || !next) return
    this.moveAndSchedule(role, appId, next.id, exit)
  }

  /** Closes an application the way its exit says, with a note to the candidate (mostly). */
  private close(role: RoleState, appId: ID, exit: Exit): void {
    const who = this.manager(role.hiringManagerId ?? FOUNDER)
    const notified = this.rng.chance(0.9)
    this.act(who, this.time, 'rejectApplication', { applicationId: appId, reason: exit.reason, ...(notified ? { notified: true } : {}), ...(exit.how === 'withdraw' ? { withdraw: true } : {}) })
  }

  /** Moves an application to a stage and schedules that stage's interviews, as the schedule sheet proposes them. */
  private moveAndSchedule(role: RoleState, appId: ID, stageId: string, exit: Exit | null): void {
    const who = this.manager(role.hiringManagerId ?? FOUNDER)
    this.act(who, this.time, 'moveApplication', { applicationId: appId, toStageId: stageId })
    const scheduled: Array<{ interviewId: ID; day: ISODate }> = []
    for (;;) {
      const db = this.db
      const app = db.applications.find((a) => a.id === appId)
      const job = app && db.jobs.find((j) => j.id === app.jobId)
      if (!app || !job) return
      const mine = db.interviews.filter((i) => i.applicationId === appId)
      const step = defaultStepFor(job, app, mine)
      if (!step || step.stageId !== app.stageId || mine.some((i) => i.stepId === step.id && i.status !== 'cancelled')) break
      const cand = db.candidates.find((c) => c.id === app.candidateId)
      // The sheet proposes three times; the candidate picks one.
      const times = proposedSlots(db, this.day, { panelIds: step.interviewerIds, candidateTz: cand?.timezone ?? null, durationMin: step.durationMin, applicationId: appId })
      const startsAt = times[this.rng.int(0, times.length - 1)]
      const format = formatForStage(stageById(job, step.stageId)?.kind)
      const interviewId = this.act(who, this.time, 'scheduleInterview', {
        applicationId: appId,
        stepId: step.id,
        stageId: step.stageId,
        name: step.name,
        startsAt,
        durationMin: step.durationMin,
        interviewerIds: step.interviewerIds,
        format,
        ...(format === 'video' ? { videoLink: `https://meet.example.com/${this.companySlug}-interviews` } : {}),
        attributes: step.attributes.map((a) => a.name),
      })
      scheduled.push({ interviewId, day: pacificDateOf(startsAt) })
    }
    if (!scheduled.length) return
    // Each interviewer writes up the next business morning; the decision comes that day or the next.
    let lastWriteUp = this.day
    for (const s of scheduled) {
      const writeUp = this.bd(s.day, 1)
      if (writeUp > lastWriteUp) lastWriteUp = writeUp
      this.at(writeUp, '09:15', () => this.writeUp(role, s.interviewId, exit))
    }
    this.at(this.bd(lastWriteUp, this.rng.int(0, 1)), '11:00', () => this.decide(role, appId, stageId, exit))
  }

  /** Every interviewer on the interview submits their scorecard: positive unless this is where the candidate stops. */
  private writeUp(role: RoleState, interviewId: ID, exit: Exit | null): void {
    const interview = this.db.interviews.find((i) => i.id === interviewId)
    if (!interview || interview.status === 'cancelled') return
    const positive = !(exit && exit.how === 'reject' && exit.stage === interview.stageId)
    const r = this.rng
    for (const card of this.db.scorecards.filter((s) => s.interviewId === interviewId && !s.submittedAt)) {
      const ratings: Record<string, Rating> = {}
      for (const name of interview.attributes) {
        ratings[name] = positive
          ? r.weighted<Rating>([
              [4, 0.4],
              [3, 0.5],
              [2, 0.1],
            ])
          : r.weighted<Rating>([
              [1, 0.3],
              [2, 0.6],
              [3, 0.1],
            ])
      }
      const by: Who = card.interviewerId === FOUNDER ? { id: FOUNDER, as: 'admin' } : { id: card.interviewerId, as: card.interviewerId === role.hiringManagerId ? 'manager' : 'employee' }
      this.act(by, '09:15', 'submitScorecard', { scorecardId: card.id, ratings, notes: r.pick(scoreNotes(role.profile, positive)) })
    }
  }

  /** After a stage's interviews: close the application, move it on, or make the offer. */
  private decide(role: RoleState, appId: ID, stageId: string, exit: Exit | null): void {
    const app = this.application(appId)
    if (!app || app.status !== 'active' || app.stageId !== stageId) return
    if (exit && exit.stage === stageId) return this.close(role, appId, exit)
    const job = this.db.jobs.find((j) => j.id === app.jobId)
    const next = job && nextStage(job, app.stageId)
    if (!job || !next) return
    if (next.kind === 'offer') {
      if (exit) return this.close(role, appId, { ...exit, stage: 'onsite' })
      // A job the plan keeps open on the as-of date makes its offer after that date, however fast its
      // interviews went: on the day, the one who will be hired is part way through like the rest.
      if (role.plan.opensDaysBeforeAsOf != null) return
      return this.offer(role, appId, next.id)
    }
    this.moveAndSchedule(role, appId, next.id, exit)
  }

  // ---- Offer and hire -------------------------------------------------------------------------------

  private offer(role: RoleState, appId: ID, offerStageId: string): void {
    const founder: Who = { id: FOUNDER, as: 'admin' }
    const hm = this.manager(role.hiringManagerId ?? FOUNDER)
    this.act(hm, '11:30', 'moveApplication', { applicationId: appId, toStageId: offerStageId })
    const drafter = this.plan.managersDraftOffers ? hm : founder
    // The planned start when it leaves at least ten days' notice, else the builder's default.
    const start = role.plannedStart >= addDays(this.day, 10) ? role.plannedStart : defaultStartDate(this.day, this.holidays)
    const offerId = this.act(drafter, '11:30', 'createOffer', {
      applicationId: appId,
      edits: { startDate: start, ...(role.plan.hourly ? { hoursPerWeek: role.plan.hourly.hoursPerWeek } : {}), ...(role.plan.noEquity ? { equityShares: 0 } : {}) },
    })
    const sendOn = (on: ISODate, time: string) => {
      this.act(founder, time, 'markSent', { offerId })
      this.at(this.bd(on, this.rng.int(1, 3)), '14:00', () => this.accept(role, offerId))
    }
    if (drafter.as !== 'admin') {
      this.act(drafter, '11:35', 'submitForApproval', { offerId })
      const approveOn = this.bd(this.day, 1)
      this.at(approveOn, '09:30', () => {
        this.act(founder, '09:30', 'approveOffer', { offerId })
        sendOn(approveOn, '09:35')
      })
    } else {
      sendOn(this.day, '11:40')
    }
  }

  /** The candidate says yes: Admin records it, hires them and closes out the rest of the job's candidates. */
  private accept(role: RoleState, offerId: ID): void {
    const founder: Who = { id: FOUNDER, as: 'admin' }
    this.act(founder, '14:00', 'markAccepted', { offerId })
    const personId = this.act(founder, '14:15', 'hireFromOffer', { offerId })
    role.personId = personId
    const jobId = role.jobId as ID
    if (closeOutMessage(this.db, jobId)?.applicationIds.length) this.act(founder, '14:30', 'closeOutRemaining', { jobId, notified: true })
    // A lead heads their department from their first day (Settings > Org).
    const person = this.db.people.find((p) => p.id === personId)
    const dept = this.db.departments.find((d) => d.id === role.departmentId)
    if (role.plan.lead && person && dept && !dept.headId) {
      this.at(person.startDate, '09:10', () => this.act(founder, '09:10', 'saveDepartment', { id: dept.id, name: dept.name, headId: personId }))
    }
  }
}
