// Situations: things a team member sets up for a simulation to live through (docs/DEV.md, "Situations"), such
// as a hiring push, a freeze, someone quitting, a layoff, a leave, a raise round, a senior hire with reports
// moving under them, or a change of pace. Each is plain JSON with an id and a date (`on`), checked by zod.
//
// A situation happens on the first business day on or after its date, at 08:20 (after the app opens and next
// year's holidays are added, before the founder plans roles), and only through the simulator's actions
// (src/sim/actions.ts), the steps people take on the screens. Each draws from its own random numbers, seeded
// with the run's seed and its id, so adding one never shifts the choices the rest of the story makes before
// it. When the app refuses one of its steps (a person who already left, a leave they do not qualify for), the
// step is skipped with a note, and the workspace stays as it was: the run goes on, the same every time.
//
// A freeze and a push to a headcount are windows the founder's hiring reads (frozen, growTo); a pace entry
// changes the rates the people act at from its date (policyOn). Test and tooling code only.
import { z } from 'zod'
import { makeRng, type Rng } from '@/data/seed/hiring/rng'
import { DEFAULT_ROLE_TEMPLATES } from '@/data/starterRoleTemplates'
import { businessDayOnOrAfter, departmentForFamily, roleTemplates } from '@/domain/hiring'
import { currentJob, leaveEligibility } from '@/domain/lifecycle'
import { bandFor, fullTimeEquivalentBase } from '@/domain/pay'
import { fullName, isEmployedOn } from '@/domain/people'
import type { ID, Person } from '@/domain/types'
import { effectiveDatePresets } from '@/features/comp/helpers'
import { nextFriday } from '@/features/people/helpers'
import { addDays, type ISODate, isUsableDate } from '@/lib/dates'
import { money, num } from '@/lib/format'
import { type AdvancePolicy, type DayHooks, type GrowTarget, LEAD_DAYS, type MachineHost, RESIGN_REASONS, storySeed } from './machine'

// ---------------------------------------------------------------------------------------------
// The JSON
// ---------------------------------------------------------------------------------------------

const isoDate = z.string().refine(isUsableDate, { message: 'a date written YYYY-MM-DD' })
const id = z.string().min(1)
const common = { id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, { message: '1 to 64 letters, digits, dots, dashes or underscores' }), on: isoDate }

/** The rates a pace entry changes: hiring pace and time off scale the preset, attrition and offer acceptance replace it. */
export const PACE_CHANGES = z.strictObject({
  /** Candidates a week on each job, and roles kept open: 0 to 3 times the preset's. */
  hiringPace: z.number().min(0).max(3).optional(),
  /** Chance a person resigns within a year: 0 to 1. */
  attritionPerYear: z.number().min(0).max(1).optional(),
  /** Vacation requests and sick days: 0 to 3 times the preset's. */
  timeOff: z.number().min(0).max(3).optional(),
  /** Chance a candidate accepts an offer: 0 to 1. Declines are 60% of the rest; the others never answer. */
  offerAcceptRate: z.number().min(0).max(1).optional(),
})

export type PaceChanges = z.output<typeof PACE_CHANGES>

export const SITUATION = z.discriminatedUnion('kind', [
  /** Open N roles now, in a department (or any). */
  z.strictObject({ ...common, kind: z.literal('hiringPush'), roles: z.number().int().min(1).max(10), departmentId: id.optional() }),
  /** Keep enough roles in the plan to reach a headcount by a date. */
  z.strictObject({ ...common, kind: z.literal('growTo'), headcount: z.number().int().min(2).max(60), by: isoDate, departmentId: id.optional() }),
  /** No roles planned or opened and no backfills, from `on` through `until`; holdOpenJobs pauses the open jobs meanwhile. */
  z.strictObject({ ...common, kind: z.literal('freeze'), until: isoDate, holdOpenJobs: z.boolean().default(false) }),
  /** Someone resigns: a named person, or one at random (null). */
  z.strictObject({
    ...common,
    kind: z.literal('quit'),
    personId: id.nullable().default(null),
    notice: z.enum(['two_weeks', 'none']).default('two_weeks'),
    backfill: z.boolean().default(true),
  }),
  /** A layoff: a number of people at random, a department, or named people. */
  z.strictObject({
    ...common,
    kind: z.literal('layoff'),
    count: z.number().int().min(1).optional(),
    departmentId: id.optional(),
    personIds: z.array(id).min(1).optional(),
    /** Days from the notice to the last day (0: the same day). */
    noticeDays: z.number().int().min(0).max(90).default(0),
    /** Close the open jobs: the department's, or every one for a count or named people. */
    closeJobs: z.boolean().default(false),
    /** A hiring freeze for this many days from the layoff. */
    freezeDays: z.number().int().min(0).max(365).default(0),
  }),
  /** A protected leave (bonding or CFRA, when the person qualifies) or another leave, for some weeks. */
  z.strictObject({
    ...common,
    kind: z.literal('leave'),
    personId: id.nullable().default(null),
    leaveKind: z.enum(['bonding', 'cfra', 'other']).default('bonding'),
    weeks: z.number().int().min(1).max(26).default(8),
  }),
  /** A market raise for everyone (the founder too when included), from the day or the next pay period. */
  z.strictObject({
    ...common,
    kind: z.literal('raiseRound'),
    percent: z.number().gt(0).max(50),
    includeFounder: z.boolean().default(false),
    /** Hold a raise that would leave the band (else it goes through with 'Raise round' as the exception reason). */
    respectBands: z.boolean().default(true),
    effective: z.enum(['on_the_day', 'next_pay_period']).default('next_pay_period'),
  }),
  /** A Head of (M2) or executive (X1) hired through the pipeline; on their first day the reports move under them. */
  z.strictObject({
    ...common,
    kind: z.literal('leaderHire'),
    departmentId: id,
    levelId: z.enum(['lv-m2', 'lv-x1']).default('lv-m2'),
    title: z.string().min(1).optional(),
    /** Who moves under the leader: the department's people, or named people. */
    reports: z.union([z.literal('department'), z.array(id).min(1)]).default('department'),
    /** The band for the level when there is none yet (default: the family's top band plus 25%). */
    band: z.strictObject({ min: z.number().positive(), mid: z.number().positive(), max: z.number().positive() }).optional(),
  }),
  /** A change of pace from its date on (recorded when a slider moves while the simulation plays). */
  z.strictObject({ ...common, kind: z.literal('pace'), changes: PACE_CHANGES }),
])

export type Situation = z.output<typeof SITUATION>
/** A situation as written: defaults may be left out. */
export type SituationInput = z.input<typeof SITUATION>
export type SituationKind = Situation['kind']

const SITUATIONS = z.array(SITUATION).superRefine((list, ctx) => {
  const seen = new Set<string>()
  list.forEach((s, i) => {
    const at = (field: string, message: string) => ctx.addIssue({ code: 'custom', path: [i, field], message })
    if (seen.has(s.id)) at('id', `another situation is already called ${s.id}`)
    seen.add(s.id)
    if (s.kind === 'freeze' && s.until < s.on) at('until', `the freeze ends (${s.until}) before it starts (${s.on})`)
    if (s.kind === 'growTo' && s.by <= s.on) at('by', `the date to reach ${s.headcount} (${s.by}) must come after the push starts (${s.on})`)
    if (s.kind === 'layoff' && [s.count, s.departmentId, s.personIds].filter((x) => x !== undefined).length !== 1) at('count', 'give exactly one of count, departmentId or personIds')
    if (s.kind === 'leaderHire' && s.band && !(s.band.min <= s.band.mid && s.band.mid <= s.band.max)) at('band', 'the minimum, midpoint and maximum must go up in that order')
  })
})

/**
 * Situations from JSON, with their defaults filled in, or an error that names each problem: which situation
 * (by place and id) and which field.
 */
export function parseSituations(input: unknown): Situation[] {
  const parsed = SITUATIONS.safeParse(input)
  if (parsed.success) return parsed.data
  const list = Array.isArray(input) ? input : []
  const problems = parsed.error.issues.map((issue) => {
    const [i, ...rest] = issue.path
    const s = typeof i === 'number' ? (list[i] as { id?: unknown } | undefined) : undefined
    const which = typeof i === 'number' ? `Situation ${i + 1}${typeof s?.id === 'string' ? ` (${s.id})` : ''}` : 'The situations'
    return `${which}${rest.length ? `, ${rest.join('.')}` : ''}: ${issue.message}`
  })
  throw new Error(`The situations do not fit: ${problems.join('; ')}.`)
}

/** Refuses a situation dated on or before the day a simulation starts from: it could never happen. */
export function checkSituationDates(list: readonly Situation[], from: ISODate): void {
  const early = list.find((s) => s.on <= from)
  if (early) throw new Error(`The situation ${early.id} is on ${early.on}, but the simulation starts from ${from}: a situation comes after that day.`)
}

// ---------------------------------------------------------------------------------------------
// Pace
// ---------------------------------------------------------------------------------------------

/** The pace knobs as they stand: the preset's own values until a pace entry changes them. */
export type Pace = { hiringPace: number; attritionPerYear: number; timeOff: number; offerAcceptRate: number }

/** The pace a policy starts at. */
export function basePace(policy: AdvancePolicy): Pace {
  return { hiringPace: 1, attritionPerYear: policy.attritionPerYear, timeOff: 1, offerAcceptRate: policy.offerAcceptRate }
}

/** A policy at a pace: rates scaled or replaced; at the policy's own pace it is that policy, number for number. */
export function applyPace(policy: AdvancePolicy & { name: string }, pace: Pace): AdvancePolicy & { name: string } {
  const same = pace.hiringPace === 1 && pace.timeOff === 1 && pace.attritionPerYear === policy.attritionPerYear && pace.offerAcceptRate === policy.offerAcceptRate
  if (same) return policy
  return {
    ...policy,
    candidatesPerJobPerWeek: policy.candidatesPerJobPerWeek * pace.hiringPace,
    openRoles: Math.round(policy.openRoles * pace.hiringPace),
    vacationRequestsPerYear: policy.vacationRequestsPerYear * pace.timeOff,
    sickDaysPerYear: policy.sickDaysPerYear * pace.timeOff,
    attritionPerYear: pace.attritionPerYear,
    offerAcceptRate: pace.offerAcceptRate,
    offerDeclineRate: pace.offerAcceptRate === policy.offerAcceptRate ? policy.offerDeclineRate : (1 - pace.offerAcceptRate) * 0.6,
    name: policy.name.endsWith(', changed') ? policy.name : `${policy.name}, changed`,
  }
}

/** The pace on a day: the base, with each pace entry dated on or before it applied in date order. */
export function paceOn(policy: AdvancePolicy, list: readonly Situation[], day: ISODate): Pace {
  const pace = basePace(policy)
  for (const s of byDate(list)) if (s.kind === 'pace' && s.on <= day) Object.assign(pace, s.changes)
  return pace
}

/** Situations in date order; the same date keeps the list's order. */
function byDate(list: readonly Situation[]): Situation[] {
  return list.map((s, i) => [s, i] as const).sort(([a, i], [b, j]) => (a.on < b.on ? -1 : a.on > b.on ? 1 : i - j)).map(([s]) => s)
}

// ---------------------------------------------------------------------------------------------
// Living them
// ---------------------------------------------------------------------------------------------

/** A line about a situation for the feed: what it did, or why a step was skipped. */
export type SituationNote = { day: ISODate; situationId: string; kind: SituationKind; skipped: boolean; text: string }

/** What a situation remembers between days. */
type State = {
  /** Its random numbers (makeRng state). */
  rng: number
  done: boolean
  /** A freeze: the jobs it put on hold, and whether they are back. */
  held?: ID[]
  resumed?: boolean
  /** A senior hire: the job, then the person hired from it, then whether the reports moved. */
  jobId?: ID
  personId?: ID
  settled?: boolean
}

/** The situations between days: each one's definition (as JSON) and state, for a keyframe. */
export type SituationsSnapshot = { readonly defs: Readonly<Record<string, string>>; readonly states: Readonly<Record<string, State>> }

const AT = '08:20'

/** The machine's DayHooks for a list of situations. `note` receives each line for the feed. */
export class Situations implements DayHooks {
  private list: Situation[]
  private states = new Map<string, State>()

  constructor(
    list: readonly Situation[],
    private readonly seed: number | string,
    private readonly note: (n: SituationNote) => void,
  ) {
    this.list = byDate(list)
  }

  /** The situations, in date order. */
  get all(): readonly Situation[] {
    return this.list
  }

  frozen(day: ISODate): boolean {
    return this.list.some((s) => (s.kind === 'freeze' && s.on <= day && day <= s.until) || (s.kind === 'layoff' && s.freezeDays > 0 && s.on <= day && day <= addDays(s.on, s.freezeDays)))
  }

  growTo(day: ISODate): GrowTarget | null {
    let out: GrowTarget | null = null
    for (const s of this.list) if (s.kind === 'growTo' && s.on <= day && day <= s.by) out = { headcount: s.headcount, by: s.by, ...(s.departmentId ? { departmentId: s.departmentId } : {}) }
    return out
  }

  morning(host: MachineHost): void {
    for (const s of this.list) {
      if (s.kind === 'pace') continue
      const state = this.stateOf(s)
      if (!state.done && s.on <= host.day) {
        state.done = true
        const rng = makeRng(state.rng)
        this.happen(host, s, state, rng)
        state.rng = rng.state()
      }
      if (state.done) this.followUp(host, s, state)
    }
  }

  snapshot(): SituationsSnapshot {
    const defs: Record<string, string> = {}
    const states: Record<string, State> = {}
    for (const s of this.list) {
      defs[s.id] = JSON.stringify(s)
      const st = this.states.get(s.id)
      if (st) states[s.id] = structuredClone(st)
    }
    return { defs, states }
  }

  /** Back to a snapshot, with a list that may differ: a situation changed since starts afresh. */
  restore(snap: SituationsSnapshot, list: readonly Situation[]): void {
    this.list = byDate(list)
    this.states = new Map()
    for (const s of this.list) {
      const st = snap.states[s.id]
      if (st && snap.defs[s.id] === JSON.stringify(s)) this.states.set(s.id, structuredClone(st))
    }
  }

  /** A new list from today on, keeping the state of situations that did not change. */
  replaceList(list: readonly Situation[]): void {
    this.restore(this.snapshot(), list)
  }

  // ---- Inside -----------------------------------------------------------------------------------

  private stateOf(s: Situation): State {
    let st = this.states.get(s.id)
    if (!st) {
      st = { rng: storySeed(`${this.seed} situation ${s.id}`), done: false }
      this.states.set(s.id, st)
    }
    return st
  }

  private say(host: MachineHost, s: Situation, text: string, skipped = false): void {
    this.note({ day: host.day, situationId: s.id, kind: s.kind, skipped, text })
  }

  /**
   * Runs one step of a situation: true when it happened. A refusal by the app (the action was refused,
   * changed nothing or did not fit) becomes a note; anything else is a bug and stops the run.
   */
  private attempt(host: MachineHost, s: Situation, what: string, step: () => void): boolean {
    try {
      step()
      return true
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const refused = /was refused: (.*)$/s.exec(message)?.[1] ?? (/changed nothing\.$|the args do not fit/.test(message) ? message : null)
      if (refused === null) throw e
      this.say(host, s, `Skipped ${what}: ${refused}`, true)
      return false
    }
  }

  private happen(host: MachineHost, s: Situation, state: State, rng: Rng): void {
    switch (s.kind) {
      case 'hiringPush':
        return this.hiringPush(host, s, rng)
      case 'growTo':
        return this.growToStart(host, s, rng)
      case 'freeze':
        return this.freeze(host, s, state)
      case 'quit':
        return this.quit(host, s, rng)
      case 'layoff':
        return this.layoff(host, s, rng)
      case 'leave':
        return this.leave(host, s, rng)
      case 'raiseRound':
        return this.raiseRound(host, s)
      case 'leaderHire':
        return this.leaderHire(host, s, state)
      case 'pace':
        return
    }
  }

  private followUp(host: MachineHost, s: Situation, state: State): void {
    if (s.kind === 'freeze') this.freezeEnds(host, s, state)
    if (s.kind === 'leaderHire') this.leaderStarts(host, s, state)
  }

  private department(host: MachineHost, s: Situation, departmentId: ID | undefined): { id: ID; name: string } | null | undefined {
    if (!departmentId) return undefined
    const dept = host.db.departments.find((d) => d.id === departmentId)
    if (!dept) this.say(host, s, `Skipped: there is no department ${departmentId}.`, true)
    return dept ?? null
  }

  /** People working here today who can be picked: not the founder, not on leave or leaving. */
  private pickable(host: MachineHost): Person[] {
    return host.staff().filter((p) => p.id !== host.admin.id && !host.away(p))
  }

  /** A named person who works here today, or a note saying why not (null). */
  private named(host: MachineHost, s: Situation, personId: ID, what: string): Person | null {
    const p = host.db.people.find((x) => x.id === personId)
    const skip = (why: string) => {
      this.say(host, s, `Skipped ${what}: ${why}`, true)
      return null
    }
    if (!p) return skip(`nobody in the workspace has the id ${personId}.`)
    if (p.id === host.admin.id) return skip(`${fullName(p)} is the founder, who runs the company in the simulator.`)
    if (p.separation) return skip(`${fullName(p)} ${p.separation.lastDay < host.day ? 'has already left' : 'is already leaving'} (last day ${p.separation.lastDay}).`)
    if (!isEmployedOn(p, host.day)) return skip(`${fullName(p)} does not work here on ${host.day} (starts ${p.startDate}).`)
    return p
  }

  // ---- Hiring ------------------------------------------------------------------------------------

  private hiringPush(host: MachineHost, s: Extract<Situation, { kind: 'hiringPush' }>, rng: Rng): void {
    const dept = this.department(host, s, s.departmentId)
    if (dept === null) return
    let opened = 0
    for (let i = 0; i < s.roles; i++) {
      let slotId: ID | null = null
      if (!this.attempt(host, s, 'a role', () => (slotId = host.planRole(rng, AT, { departmentId: s.departmentId, latestStart: addDays(host.day, LEAD_DAYS) })))) continue
      if (slotId === null) {
        this.say(host, s, `Skipped: no role template belongs to ${dept?.name ?? 'the company'}.`, true)
        return
      }
      const planSlotId: ID = slotId
      if (this.frozen(host.day)) continue
      if (this.attempt(host, s, 'opening a role', () => host.openFromPlan(planSlotId, AT, AT))) opened += 1
    }
    this.say(host, s, `Hiring push: ${num(s.roles)} role${s.roles === 1 ? '' : 's'} added to the plan${dept ? ` in ${dept.name}` : ''}, ${num(opened)} opened today.`)
  }

  private growToStart(host: MachineHost, s: Extract<Situation, { kind: 'growTo' }>, rng: Rng): void {
    const dept = this.department(host, s, s.departmentId)
    if (dept === null) return
    let added = 0
    while (host.headcountWithPlan() < s.headcount) {
      let slotId: ID | null = null
      if (!this.attempt(host, s, 'a role', () => (slotId = host.planRole(rng, AT, { departmentId: s.departmentId, latestStart: s.by })))) break
      if (slotId === null) break
      added += 1
    }
    this.say(host, s, `Hiring push: growing to ${num(s.headcount)} by ${s.by}${dept ? ` in ${dept.name}` : ''}; ${num(added)} role${added === 1 ? '' : 's'} added to the plan today.`)
  }

  private freeze(host: MachineHost, s: Extract<Situation, { kind: 'freeze' }>, state: State): void {
    const held: ID[] = []
    if (s.holdOpenJobs) {
      for (const job of host.db.jobs) {
        if (job.status !== 'open') continue
        if (this.attempt(host, s, `holding ${job.title}`, () => host.act(host.admin, AT, 'setJobStatus', { jobId: job.id, status: 'on_hold' }))) held.push(job.id)
      }
    }
    state.held = held
    this.say(host, s, `Hiring freeze through ${s.until}: no new roles or backfills${s.holdOpenJobs ? `, ${num(held.length)} open job${held.length === 1 ? '' : 's'} on hold` : ''}.`)
  }

  /** The first business day after a freeze: the jobs it held are posted again (Resume posting). */
  private freezeEnds(host: MachineHost, s: Extract<Situation, { kind: 'freeze' }>, state: State): void {
    if (state.resumed || host.day <= s.until) return
    state.resumed = true
    let resumed = 0
    for (const jobId of state.held ?? []) {
      const job = host.db.jobs.find((j) => j.id === jobId)
      if (job?.status !== 'on_hold') continue
      if (this.attempt(host, s, `resuming ${job.title}`, () => host.act(host.admin, AT, 'markPosted', { jobId }))) resumed += 1
    }
    this.say(host, s, `Hiring freeze over${resumed ? `: ${num(resumed)} job${resumed === 1 ? '' : 's'} posted again` : ''}.`)
  }

  // ---- People ------------------------------------------------------------------------------------

  private quit(host: MachineHost, s: Extract<Situation, { kind: 'quit' }>, rng: Rng): void {
    let person: Person | null
    if (s.personId) person = this.named(host, s, s.personId, 'the resignation')
    else {
      const pool = this.pickable(host)
      person = pool.length ? rng.pick(pool) : null
      if (!person) this.say(host, s, 'Skipped the resignation: nobody but the founder works here.', true)
    }
    if (!person) return
    const p = person
    const lastDay = s.notice === 'two_weeks' ? nextFriday(host.day, 2) : host.day
    const reason = rng.pick(RESIGN_REASONS)
    const done = this.attempt(host, s, `${fullName(p)}'s resignation`, () =>
      host.act(host.admin, AT, 'offboardPerson', {
        personId: p.id,
        type: s.notice === 'two_weeks' ? 'resigned_notice' : 'resigned_no_notice',
        reason,
        lastDay,
        ...(s.notice === 'two_weeks' ? { noticeGivenOn: host.day } : {}),
        rehireEligible: true,
      }),
    )
    if (!done) return
    let backfill = ''
    if (s.backfill && !this.frozen(host.day)) {
      const opened = this.attempt(host, s, `the backfill for ${fullName(p)}`, () => {
        const jobId = host.act(host.admin, AT, 'openBackfill', { personId: p.id })
        host.readyAndPost(jobId, AT)
      })
      if (opened) backfill = ' Backfill opened.'
    } else if (s.backfill) backfill = ' No backfill during the freeze.'
    this.say(host, s, `${fullName(p)} resigned (${reason}), last day ${lastDay}.${backfill}`)
  }

  private layoff(host: MachineHost, s: Extract<Situation, { kind: 'layoff' }>, rng: Rng): void {
    const pool = this.pickable(host)
    let people: Person[]
    let deptName = ''
    if (s.personIds) {
      people = s.personIds.map((pid) => this.named(host, s, pid, 'a layoff')).filter((p): p is Person => !!p)
    } else if (s.departmentId) {
      const dept = this.department(host, s, s.departmentId)
      if (!dept) return
      deptName = dept.name
      people = pool.filter((p) => p.departmentId === dept.id)
      if (!people.length) {
        this.say(host, s, `Skipped the layoff: nobody but the founder works in ${dept.name} on ${host.day}.`, true)
        return
      }
    } else {
      const count = s.count ?? 0
      if (count > pool.length) {
        this.say(host, s, `Skipped the layoff: it names ${num(count)} people, but only ${num(pool.length)} besides the founder work here and are not on leave or leaving.`, true)
        return
      }
      people = rng.shuffle(pool).slice(0, count)
    }
    // Reports first, managers after, so nobody is handed to someone leaving the same day.
    const managers = new Set(host.db.people.filter((p) => p.managerId).map((p) => p.managerId as ID))
    people = [...people.filter((p) => !managers.has(p.id)), ...people.filter((p) => managers.has(p.id))]
    const lastDay = s.noticeDays ? businessDayOnOrAfter(addDays(host.day, s.noticeDays), host.holidays) : host.day
    const gone: string[] = []
    for (const p of people) {
      const done = this.attempt(host, s, `laying off ${fullName(p)}`, () =>
        host.act(host.admin, AT, 'offboardPerson', { personId: p.id, type: 'laid_off', reason: 'Reduction in force', lastDay, noticeGivenOn: host.day, rehireEligible: true }),
      )
      if (done) gone.push(fullName(p))
    }
    let closed = 0
    if (s.closeJobs) {
      for (const job of host.db.jobs) {
        if (!(job.status === 'open' || job.status === 'on_hold' || job.status === 'draft') || (s.departmentId && job.departmentId !== s.departmentId)) continue
        if (this.attempt(host, s, `closing ${job.title}`, () => host.act(host.admin, AT, 'setJobStatus', { jobId: job.id, status: 'closed' }))) closed += 1
      }
    }
    const parts = [`Layoff${deptName ? ` in ${deptName}` : ''}: ${gone.length ? gone.join(', ') : 'nobody'}, last day ${lastDay}`]
    if (s.closeJobs) parts.push(`${num(closed)} job${closed === 1 ? '' : 's'} closed`)
    if (s.freezeDays) parts.push(`hiring frozen through ${addDays(s.on, s.freezeDays)}`)
    this.say(host, s, `${parts.join('; ')}.`)
  }

  private leave(host: MachineHost, s: Extract<Situation, { kind: 'leave' }>, rng: Rng): void {
    const label = s.leaveKind === 'cfra' ? 'CFRA leave' : s.leaveKind === 'bonding' ? 'bonding leave' : 'leave'
    let person: Person | null
    if (s.personId) {
      person = this.named(host, s, s.personId, `the ${label}`)
      if (person && host.away(person)) {
        this.say(host, s, `Skipped the ${label}: ${fullName(person)} is already on leave.`, true)
        return
      }
      if (person) {
        const check = leaveEligibility(host.db, person.id, s.leaveKind, host.day)
        if (!check.eligible) {
          const why = check.reasons.filter((r) => /^Needs|; needs|apply at|cover employees/.test(r)).join(' ')
          this.say(host, s, `Skipped the ${label}: ${fullName(person)} does not qualify on ${host.day}. ${why}`.trim(), true)
          return
        }
      }
    } else {
      const pool = this.pickable(host).filter((p) => leaveEligibility(host.db, p.id, s.leaveKind, host.day).eligible)
      person = pool.length ? rng.pick(pool) : null
      if (!person) this.say(host, s, `Skipped the ${label}: nobody who works here qualifies on ${host.day}.`, true)
    }
    if (!person) return
    const p = person
    const startDate = businessDayOnOrAfter(host.day, host.holidays)
    const expectedReturn = businessDayOnOrAfter(addDays(startDate, 7 * s.weeks), host.holidays)
    if (this.attempt(host, s, `${fullName(p)}'s ${label}`, () => host.act(host.admin, AT, 'startLeave', { personId: p.id, kind: s.leaveKind, requestedOn: host.day, startDate, expectedReturn }))) {
      this.say(host, s, `${fullName(p)} started a ${label} of ${num(s.weeks)} week${s.weeks === 1 ? '' : 's'}, back ${expectedReturn}.`)
    }
  }

  private raiseRound(host: MachineHost, s: Extract<Situation, { kind: 'raiseRound' }>): void {
    const db = host.db
    const effectiveOn = s.effective === 'on_the_day' ? host.day : effectiveDatePresets(host.day, db.company.paySchedule, db.company.firstPayrollOn)[0].date
    let raised = 0
    let held = 0
    let outside = 0
    for (const person of host.staff()) {
      if ((person.id === host.admin.id && !s.includeFounder) || person.separation) continue
      const rec = currentJob(host.db, person.id, host.day)
      const hourly = rec?.payType === 'hourly'
      const current = (hourly ? rec?.hourlyRate : rec?.salary) ?? 0
      if (!rec || current <= 0) continue
      const factor = 1 + s.percent / 100
      const pay = hourly ? Math.round(current * factor * 4) / 4 : Math.round((current * factor) / 100) * 100
      const band = bandFor(host.db, person.familyId, rec.levelId ?? person.levelId)
      const fte = fullTimeEquivalentBase(hourly ? { payType: 'hourly', hourlyRate: pay } : { payType: 'salary', salary: pay }, person.hoursPerWeek || 40)
      const out = !!band && (fte < band.min || fte > band.max)
      if (out && s.respectBands) {
        held += 1
        continue
      }
      const change = { effectiveOn, reason: 'market' as const, ...(hourly ? { hourlyRate: pay } : { salary: pay }), ...(out ? { exceptionReason: 'Raise round' } : {}) }
      if (this.attempt(host, s, `${fullName(person)}'s raise`, () => host.act(host.admin, AT, 'changeJobOrPay', { personId: person.id, change }))) {
        raised += 1
        if (out) outside += 1
      }
    }
    const notes = [held ? `${num(held)} held outside the band` : '', outside ? `${num(outside)} past the band as exceptions` : ''].filter(Boolean)
    this.say(host, s, `Raise round of ${s.percent}%: ${num(raised)} raised from ${effectiveOn}${notes.length ? `, ${notes.join(', ')}` : ''}.`)
  }

  // ---- A senior hire ---------------------------------------------------------------------------------

  private leaderHire(host: MachineHost, s: Extract<Situation, { kind: 'leaderHire' }>, state: State): void {
    const dept = this.department(host, s, s.departmentId)
    if (!dept) return
    const db = host.db
    const all = roleTemplates(db).length ? roleTemplates(db) : DEFAULT_ROLE_TEMPLATES
    const template = all.find((t) => (db.departments.some((d) => d.id === t.departmentId) ? t.departmentId : departmentForFamily(db, t.familyId)) === dept.id)
    if (!template) {
      this.say(host, s, `Skipped the senior hire: no role template belongs to ${dept.name}.`, true)
      return
    }
    const familyId = template.familyId
    if (!bandFor(db, familyId, s.levelId)) {
      const top = db.bands.filter((b) => b.familyId === familyId).sort((a, b) => b.mid - a.mid)[0]
      const figures = s.band ?? (top ? { min: round1000(top.min * 1.25), mid: round1000(top.mid * 1.25), max: round1000(top.max * 1.25) } : null)
      if (!figures) {
        this.say(host, s, `Skipped the senior hire: ${dept.name} has no band to start the ${s.levelId === 'lv-x1' ? 'X1' : 'M2'} band from. Give one in the situation.`, true)
        return
      }
      const band = { familyId, levelId: s.levelId, ...figures, equityMinPct: top?.equityMinPct ?? 0, equityMaxPct: top?.equityMaxPct ?? 0, flsaDefault: 'exempt' as const }
      if (!this.attempt(host, s, 'the band', () => host.act(host.admin, AT, 'saveBand', band))) return
    }
    const title = s.title ?? `${s.levelId === 'lv-x1' ? 'VP' : 'Head'} of ${dept.name}`
    // As the founder hires any role: a line in the headcount plan, then New job from that line, then Mark posted.
    let jobId: ID | null = null
    const opened = this.attempt(host, s, `the ${title} job`, () => {
      const band = bandFor(host.db, familyId, s.levelId)
      const targetStart = businessDayOnOrAfter(addDays(host.day, LEAD_DAYS), host.holidays)
      const planSlotId = host.act(host.admin, AT, 'addPlanLine', { title, departmentId: dept.id, familyId, levelId: s.levelId, targetStart, ...(band ? { budgetBase: band.mid } : {}) })
      jobId = host.act(host.admin, AT, 'createJob', { templateId: template.id, hiringManagerId: host.admin.id, planSlotId })
      host.readyAndPost(jobId, AT)
    })
    if (!opened || jobId === null) return
    state.jobId = jobId
    const job = host.db.jobs.find((j) => j.id === jobId)
    this.say(host, s, `Senior hire: the ${title} job ${job?.status === 'open' ? 'is open' : 'waits to be posted'}${job?.payMin && job.payMax ? `, ${money(job.payMin)} to ${money(job.payMax)}` : ''}.`)
  }

  /** Once the leader is hired and their first day comes, the reports move under them and they head the department. */
  private leaderStarts(host: MachineHost, s: Extract<Situation, { kind: 'leaderHire' }>, state: State): void {
    if (!state.jobId || state.settled) return
    const db = host.db
    if (!state.personId) {
      const offer = db.offers.find((o) => o.jobId === state.jobId && o.personId)
      if (!offer?.personId) return
      state.personId = offer.personId
    }
    const leader = db.people.find((p) => p.id === state.personId)
    if (!leader || leader.startDate > host.day) return
    state.settled = true
    const dept = db.departments.find((d) => d.id === s.departmentId)
    if (!isEmployedOn(leader, host.day) || leader.separation) {
      this.say(host, s, `Skipped moving the reports: ${fullName(leader)} is not working here on ${host.day}.`, true)
      return
    }
    const candidates = s.reports === 'department' ? host.staff().filter((p) => p.departmentId === s.departmentId) : s.reports.map((pid) => db.people.find((p) => p.id === pid)).filter((p): p is Person => !!p)
    let moved = 0
    for (const p of candidates) {
      if (p.id === leader.id || p.id === host.admin.id || p.separation || !isEmployedOn(p, host.day) || p.managerId === leader.id) continue
      const change = { effectiveOn: host.day, reason: 'manager_change' as const, managerId: leader.id }
      if (this.attempt(host, s, `moving ${fullName(p)}`, () => host.act(host.admin, AT, 'changeJobOrPay', { personId: p.id, change }))) moved += 1
    }
    if (dept) this.attempt(host, s, `making ${fullName(leader)} head of ${dept.name}`, () => host.act(host.admin, AT, 'saveDepartment', { id: dept.id, name: dept.name, headId: leader.id }))
    this.say(host, s, `${fullName(leader)} started as ${leader.title}; ${num(moved)} ${moved === 1 ? 'person reports' : 'people report'} to them now.`)
  }
}

function round1000(n: number): number {
  return Math.round(n / 1000) * 1000
}
