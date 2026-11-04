// A simulation that steps (docs/DEV.md, "The time machine"): the time machine (src/sim/machine.ts) held open
// between steps, so it can live a day, a week or a month at a time, and go back to an earlier day. One run
// (src/lib/runContext.ts) holds the whole simulation's id stream, and the machine keeps one stream of random
// choices, so stepping in any chunks gives byte-identical JSON to one long step. advance (src/sim/advance.ts)
// is one stepTo.
//
// Keyframes: the start and the end of each simulated month keep the workspace (an Immer value, so keeping it
// costs nothing), the machine's state, the run's and the situations'. Going back to a day restores the nearest
// keyframe on or before it and lives forward from there, at most a month of days.
//
// Situations (src/sim/situations.ts) happen on their dates; a change of pace is a situation too, so a saved
// run replays exactly. Changing the situations after some days have been lived goes back to the last keyframe
// before the first change and lives forward again: nothing before that day differs, so the result equals a
// fresh simulation with the new list.
//
// Each day lived also gives the feed's events (src/sim/story.ts) and the day's numbers (src/sim/metrics.ts),
// unless they are turned off (advance needs neither).
//
// Test and tooling code only (src/sim/guard.test.ts).
import { founder } from '@/domain/people'
import type { DB } from '@/domain/types'
import { addDays, getClockOverride, type ISODate, isUsableDate, parseDate, setClockOverride } from '@/lib/dates'
import { openRun, type RunHandle, type RunState, restoreRun, runIdSuffixes, runState, withRun } from '@/lib/runContext'
import type { TraceLine } from './actions'
import { type MetricPoint, metricsOn } from './metrics'
import { type AdvancePolicy, type AdvanceReport, type MachineSnapshot, type PolicyInput, resolvePolicy, TimeMachine } from './machine'
import {
  applyPace,
  checkSituationDates,
  PACE_CHANGES,
  type PaceChanges,
  paceOn,
  parseSituations,
  type Situation,
  type SituationInput,
  type SituationNote,
  Situations,
  type SituationsSnapshot,
} from './situations'
import { dayEvents, type SimEvent, weekEvent } from './story'

export type SimulationOptions = {
  /** The company's date: the last day already lived. The first step lives the day after it. */
  from: ISODate
  /** Same workspace, date, seed and policy: the same story. */
  seed: number | string
  /** Default normal. */
  policy?: PolicyInput
  /** The pace to start at, over the policy (hiring pace and time off scale it; attrition and offer acceptance replace it). */
  pace?: PaceChanges
  /** Keep a keyframe at the end of each simulated month, for rewindTo (default), or only the start. */
  keyframes?: 'month' | 'none'
  /** Evaluate the compliance rules each Monday for the report (default true). They change nothing in the workspace. */
  reportCompliance?: boolean
  /** What happens on given dates, pace changes included (src/sim/situations.ts). Each comes after `from`. */
  situations?: readonly SituationInput[]
  /** Tell each day as events for a feed (default true). */
  story?: boolean
  /** Take each day's numbers (default true). */
  metrics?: boolean
}

/** What one step lived. */
export type StepResult = {
  /** The last day lived before the step, and the last day it lived. */
  from: ISODate
  to: ISODate
  /** The actions the step applied, in order. */
  lines: TraceLine[]
  /** What the situations did on the days lived, or why they skipped a step. */
  notes: SituationNote[]
  /** The feed's events for the days lived (empty with story off). */
  events: SimEvent[]
  /** Each day's numbers (empty with metrics off). */
  points: MetricPoint[]
}

/** What a change of situations did: the days lived again (from the keyframe it went back to), or none. */
export type SituationsChange = StepResult & { replayed: boolean }

/** A point the simulation can go back to: the end of a day it lived. */
export type Keyframe = {
  readonly day: ISODate
  readonly db: DB
  readonly traceLength: number
  readonly machine: MachineSnapshot
  readonly run: RunState
  readonly situations: SituationsSnapshot
  readonly notesLength: number
  readonly eventsLength: number
  readonly pointsLength: number
}

export class Simulation {
  readonly from: ISODate
  readonly seed: number | string
  /** The policy the simulation started with, at its starting pace. */
  readonly policy: AdvancePolicy & { name: string }
  /** The policy before any pace (the preset, or rates changed from one). */
  private readonly base: AdvancePolicy & { name: string }
  private readonly startPace: PaceChanges
  private readonly machine: TimeMachine
  private readonly handle: RunHandle
  private readonly keepKeyframes: boolean
  private readonly frames: Keyframe[] = []
  private readonly situations: Situations
  private noteList: SituationNote[] = []
  private eventList: SimEvent[] = []
  private pointList: MetricPoint[] = []
  private readonly tellStory: boolean
  private readonly takeMetrics: boolean
  private paceCount = 0
  private stopped: Error | null = null

  /**
   * Refuses a `from` that is not a date, a seed that is neither a whole number nor some text, a policy it
   * cannot read, situations that do not fit or come too early, and a workspace with no founder to act as Admin.
   */
  constructor(db: DB, options: SimulationOptions) {
    const { from, seed } = options
    if (!isUsableDate(from)) throw new Error(`The company's date is a date written YYYY-MM-DD, not '${from}'.`)
    if (typeof seed === 'number' ? !Number.isSafeInteger(seed) : typeof seed !== 'string' || !seed) throw new Error(`A seed is a whole number or some text, not ${String(seed)}.`)
    this.base = resolvePolicy(options.policy)
    const pace = PACE_CHANGES.safeParse(options.pace ?? {})
    if (!pace.success) throw new Error(`The pace does not fit: ${pace.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}.`)
    this.startPace = pace.data
    this.policy = applyPace(this.base, paceOn(this.base, [], from, this.startPace))
    const list = parseSituations(options.situations ?? [])
    checkSituationDates(list, from)
    const admin = founder(db)
    if (!admin) throw new Error('The workspace has no founder to act as Admin.')
    this.from = from
    this.seed = seed
    this.keepKeyframes = (options.keyframes ?? 'month') === 'month'
    this.tellStory = options.story ?? true
    this.takeMetrics = options.metrics ?? true
    this.handle = openRun({ seed: `advance ${seed} from ${from}`, actorId: admin.id, viewingAs: 'admin', timeOfDay: '08:00', avoid: runIdSuffixes(db) })
    this.situations = new Situations(list, seed, (n) => this.noteList.push(n))
    this.machine = new TimeMachine(db, from, seed, this.policy, admin.id, { reportCompliance: options.reportCompliance ?? true, hooks: this.situations })
    this.keep()
  }

  /** The last day lived (`from` before the first step). */
  get day(): ISODate {
    return this.machine.day
  }

  /** The workspace as of the end of the last day lived. */
  get db(): DB {
    return this.machine.sim.db
  }

  /** Every action applied so far, in order. */
  get trace(): readonly TraceLine[] {
    return this.machine.sim.trace
  }

  /** What the situations did so far, or why they skipped a step. */
  get notes(): readonly SituationNote[] {
    return this.noteList
  }

  /** The feed's events so far, in order. */
  get events(): readonly SimEvent[] {
    return this.eventList
  }

  /** Each day's numbers so far, from the first day lived. */
  get points(): readonly MetricPoint[] {
    return this.pointList
  }

  /** The numbers on the last day lived (also on the start day, before any step). */
  metricsNow(): MetricPoint {
    return metricsOn(this.db, this.day, this.from)
  }

  /** The situations, in date order (pace changes included). */
  situationList(): readonly Situation[] {
    return this.situations.all
  }

  /** Lives the next `days` days (one or more). */
  step(days: number): StepResult {
    if (!Number.isSafeInteger(days) || days < 1) throw new Error(`A step is one day or more, not ${days}.`)
    return this.stepTo(addDays(this.day, days))
  }

  /**
   * Lives every day after the last one lived, up to `to` (inclusive; `to` on the last day lived lives
   * nothing). The clock override is left as it was. When an action the people take is refused (a bug in the
   * simulator or the app), it throws, and the simulation stops: only rewindTo goes on from there.
   */
  stepTo(to: ISODate): StepResult {
    this.mustBeGoing()
    if (!isUsableDate(to)) throw new Error(`The date to step to is a date written YYYY-MM-DD, not '${to}'.`)
    const from = this.day
    if (to < from) throw new Error(`Time only moves forward: the company's date is ${from}, so it cannot step to ${to}. rewindTo goes back.`)
    const mark = this.mark()
    this.live(to)
    return this.since(from, to, mark)
  }

  /**
   * Goes back to the end of an earlier day: restores the nearest keyframe on or before it, then lives
   * forward to it. The result equals a simulation that never went past that day.
   */
  rewindTo(day: ISODate): StepResult {
    if (!isUsableDate(day)) throw new Error(`The date to go back to is a date written YYYY-MM-DD, not '${day}'.`)
    if (day < this.from) throw new Error(`The simulation starts on ${this.from}, so it cannot go back to ${day}.`)
    if (day > this.day) throw new Error(`The simulation is on ${this.day}: ${day} is still to come (stepTo goes there).`)
    const frame = this.frameOnOrBefore(day)
    this.restore(frame, this.situations.all)
    this.live(day)
    return this.since(frame.day, day, frameMark(frame))
  }

  /**
   * A new list of situations. When a change is dated after the last day lived, nothing is lived again.
   * Otherwise the simulation goes back to the last keyframe before the earliest change and lives forward to the
   * day it was on: the result equals a fresh simulation with the new list. With `liveAgain: false` it stays on
   * that keyframe, and the caller lives the days again at its own pace (the panel's worker does, in slices).
   * Refuses while the simulation has stopped, and situations that do not fit or come too early.
   */
  setSituations(input: readonly SituationInput[], { liveAgain = true }: { liveAgain?: boolean } = {}): SituationsChange {
    this.mustBeGoing()
    const list = parseSituations(input)
    checkSituationDates(list, this.from)
    const day = this.day
    const changedOn = firstChange(this.situations.all, list)
    if (changedOn === null || changedOn > day) {
      this.situations.replaceList(list)
      return { ...this.since(day, day, this.mark()), replayed: false }
    }
    let frame = this.frames[0]
    for (const f of this.frames) if (f.day < changedOn) frame = f
    this.restore(frame, list)
    if (!liveAgain) return { ...this.since(frame.day, frame.day, frameMark(frame)), replayed: true }
    this.live(day)
    return { ...this.since(frame.day, day, frameMark(frame)), replayed: true }
  }

  /** A change of pace from the next day on, kept in the situations as a pace entry, so the run replays exactly. */
  setPace(changes: PaceChanges): Situation {
    const parsed = PACE_CHANGES.safeParse(changes)
    if (!parsed.success) throw new Error(`The pace does not fit: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}.`)
    const on = addDays(this.day, 1)
    const taken = new Set(this.situations.all.map((s) => s.id))
    let n = 1
    while (taken.has(`pace-${on}-${n}`)) n += 1
    const entry: Situation = { id: `pace-${on}-${n}`, on, kind: 'pace', changes: parsed.data }
    this.setSituations([...this.situations.all, entry])
    return entry
  }

  /** The days the simulation can go back to directly, the start first. */
  keyframes(): ISODate[] {
    return this.frames.map((f) => f.day)
  }

  /** What happened from the start to the last day lived, counted. */
  report(): AdvanceReport {
    return this.machine.finish(this.day)
  }

  // ---- Inside ----------------------------------------------------------------------------------

  private mark(): Mark {
    return { trace: this.trace.length, notes: this.noteList.length, events: this.eventList.length, points: this.pointList.length }
  }

  private since(from: ISODate, to: ISODate, m: Mark): StepResult {
    return { from, to, lines: this.trace.slice(m.trace), notes: this.noteList.slice(m.notes), events: this.eventList.slice(m.events), points: this.pointList.slice(m.points) }
  }

  private mustBeGoing(): void {
    if (this.stopped) throw new Error(`The simulation stopped on ${this.day}: ${this.stopped.message} Go back to an earlier day with rewindTo to go on.`)
  }

  /** Lives each day after the last one lived up to `to`, in the simulation's run; the clock is put back after. */
  private live(to: ISODate): void {
    if (to <= this.day) return
    const clock = getClockOverride()
    try {
      withRun(this.handle, () => {
        for (let day = addDays(this.day, 1); day <= to; day = addDays(day, 1)) {
          const m = this.mark()
          this.paceFor(day)
          this.machine.liveDay(day)
          this.tell(day, m)
          if (this.keepKeyframes && addDays(day, 1).endsWith('-01')) this.keep()
        }
      })
    } catch (e) {
      // A run already on refuses before anything changed; anything else stopped part way through a day.
      if (!(e instanceof Error && e.message.startsWith('A run is already on'))) this.stopped = e instanceof Error ? e : new Error(String(e))
      throw e
    } finally {
      setClockOverride(clock)
    }
  }

  /** The day's events and numbers. */
  private tell(day: ISODate, m: Mark): void {
    if (this.tellStory) {
      this.eventList.push(...dayEvents(day, this.trace.slice(m.trace), this.db, this.noteList.slice(m.notes)))
      if (parseDate(day).getDay() === 0) {
        const week = weekEvent(day, this.lastWeek(day))
        if (week) this.eventList.push(week)
      }
    }
    if (this.takeMetrics) this.pointList.push(metricsOn(this.db, day, this.from))
  }

  /** The trace lines of the seven days ending on `day`. */
  private lastWeek(day: ISODate): TraceLine[] {
    const from = addDays(day, -6)
    const trace = this.trace
    let i = trace.length
    while (i > 0 && trace[i - 1].day >= from) i -= 1
    return trace.slice(i)
  }

  /** The policy for a day, at the pace the pace entries dated on or before it set. */
  private paceFor(day: ISODate): void {
    const list = this.situations.all
    let count = 0
    for (const s of list) if (s.kind === 'pace' && s.on <= day) count += 1
    if (count === this.paceCount) return
    this.paceCount = count
    this.machine.setPolicy(applyPace(this.base, paceOn(this.base, list, day, this.startPace)))
  }

  private keep(): void {
    if (!this.keepKeyframes && this.frames.length > 0) return
    this.frames.push({
      day: this.day,
      db: this.db,
      traceLength: this.trace.length,
      machine: this.machine.snapshot(),
      run: runState(this.handle),
      situations: this.situations.snapshot(),
      notesLength: this.noteList.length,
      eventsLength: this.eventList.length,
      pointsLength: this.pointList.length,
    })
  }

  /** The latest keyframe on or before a day (the start keyframe is always kept). */
  private frameOnOrBefore(day: ISODate): Keyframe {
    let found = this.frames[0]
    for (const f of this.frames) if (f.day <= day) found = f
    return found
  }

  /** Back to a keyframe with a list of situations: the later keyframes go, and the simulation goes again if it had stopped. */
  private restore(frame: Keyframe, list: readonly Situation[]): void {
    this.machine.restore(frame.machine, frame.db, this.trace.slice(0, frame.traceLength))
    restoreRun(this.handle, frame.run)
    this.situations.restore(frame.situations, list)
    this.noteList = this.noteList.slice(0, frame.notesLength)
    this.eventList = this.eventList.slice(0, frame.eventsLength)
    this.pointList = this.pointList.slice(0, frame.pointsLength)
    this.paceCount = list.filter((s) => s.kind === 'pace' && s.on <= frame.day).length
    this.frames.splice(this.frames.indexOf(frame) + 1)
    this.stopped = null
  }
}

/** How long each list was at a moment, so a step returns only what it added. */
type Mark = { trace: number; notes: number; events: number; points: number }

function frameMark(f: Keyframe): Mark {
  return { trace: f.traceLength, notes: f.notesLength, events: f.eventsLength, points: f.pointsLength }
}

/** The earliest date a change touches between two lists of situations (added, removed or edited), or null. */
function firstChange(before: readonly Situation[], after: readonly Situation[]): ISODate | null {
  const was = new Map(before.map((s) => [s.id, s]))
  const now = new Map(after.map((s) => [s.id, s]))
  let first: ISODate | null = null
  const touch = (d: ISODate) => {
    if (first === null || d < first) first = d
  }
  for (const [sid, s] of now) {
    const old = was.get(sid)
    if (!old) touch(s.on)
    else if (JSON.stringify(old) !== JSON.stringify(s)) touch(old.on < s.on ? old.on : s.on)
  }
  for (const [sid, s] of was) if (!now.has(sid)) touch(s.on)
  return first
}
