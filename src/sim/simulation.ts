// A simulation that steps (docs/DEV.md, "The time machine"): the time machine (src/sim/machine.ts) held open
// between steps, so it can live a day, a week or a month at a time, and go back to an earlier day. One run
// (src/lib/runContext.ts) holds the whole simulation's id stream, and the machine keeps one stream of random
// choices, so stepping in any chunks gives byte-identical JSON to one long step. advance (src/sim/advance.ts)
// is one stepTo.
//
// Keyframes: the start and the end of each simulated month keep the workspace (an Immer value, so keeping it
// costs nothing), the machine's state and the run's. Going back to a day restores the nearest keyframe on or
// before it and lives forward from there, at most a month of days.
//
// Test and tooling code only (src/sim/guard.test.ts).
import { founder } from '@/domain/people'
import type { DB } from '@/domain/types'
import { addDays, getClockOverride, type ISODate, isUsableDate, setClockOverride } from '@/lib/dates'
import { openRun, type RunHandle, type RunState, restoreRun, runIdSuffixes, runState, withRun } from '@/lib/runContext'
import type { TraceLine } from './actions'
import { type AdvancePolicy, type AdvanceReport, type MachineSnapshot, type PolicyInput, resolvePolicy, TimeMachine } from './machine'

export type SimulationOptions = {
  /** The company's date: the last day already lived. The first step lives the day after it. */
  from: ISODate
  /** Same workspace, date, seed and policy: the same story. */
  seed: number | string
  /** Default normal. */
  policy?: PolicyInput
  /** Keep a keyframe at the end of each simulated month, for rewindTo (default), or only the start. */
  keyframes?: 'month' | 'none'
  /** Evaluate the compliance rules each Monday for the report (default true). They change nothing in the workspace. */
  reportCompliance?: boolean
}

/** What one step lived. */
export type StepResult = {
  /** The last day lived before the step, and the last day it lived. */
  from: ISODate
  to: ISODate
  /** The actions the step applied, in order. */
  lines: TraceLine[]
}

/** A point the simulation can go back to: the end of a day it lived. */
export type Keyframe = {
  readonly day: ISODate
  readonly db: DB
  readonly traceLength: number
  readonly machine: MachineSnapshot
  readonly run: RunState
}

export class Simulation {
  readonly from: ISODate
  readonly seed: number | string
  /** The policy the simulation started with. */
  readonly policy: AdvancePolicy & { name: string }
  private readonly machine: TimeMachine
  private readonly handle: RunHandle
  private readonly keepKeyframes: boolean
  private readonly frames: Keyframe[] = []
  private stopped: Error | null = null

  /**
   * Refuses a `from` that is not a date, a seed that is neither a whole number nor some text, a policy it
   * cannot read and a workspace with no founder to act as Admin.
   */
  constructor(db: DB, options: SimulationOptions) {
    const { from, seed } = options
    if (!isUsableDate(from)) throw new Error(`The company's date is a date written YYYY-MM-DD, not '${from}'.`)
    if (typeof seed === 'number' ? !Number.isSafeInteger(seed) : typeof seed !== 'string' || !seed) throw new Error(`A seed is a whole number or some text, not ${String(seed)}.`)
    this.policy = resolvePolicy(options.policy)
    const admin = founder(db)
    if (!admin) throw new Error('The workspace has no founder to act as Admin.')
    this.from = from
    this.seed = seed
    this.keepKeyframes = (options.keyframes ?? 'month') === 'month'
    this.handle = openRun({ seed: `advance ${seed} from ${from}`, actorId: admin.id, viewingAs: 'admin', timeOfDay: '08:00', avoid: runIdSuffixes(db) })
    this.machine = new TimeMachine(db, from, seed, this.policy, admin.id, { reportCompliance: options.reportCompliance ?? true })
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
    const traced = this.trace.length
    this.live(to)
    return { from, to, lines: this.trace.slice(traced) }
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
    this.restore(frame)
    this.live(day)
    return { from: frame.day, to: day, lines: this.trace.slice(frame.traceLength) }
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
          this.machine.liveDay(day)
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

  private keep(): void {
    if (!this.keepKeyframes && this.frames.length > 0) return
    this.frames.push({ day: this.day, db: this.db, traceLength: this.trace.length, machine: this.machine.snapshot(), run: runState(this.handle) })
  }

  /** The latest keyframe on or before a day (the start keyframe is always kept). */
  private frameOnOrBefore(day: ISODate): Keyframe {
    let found = this.frames[0]
    for (const f of this.frames) if (f.day <= day) found = f
    return found
  }

  /** Back to a keyframe: the later keyframes go, and the simulation goes again if it had stopped. */
  private restore(frame: Keyframe): void {
    this.machine.restore(frame.machine, frame.db, this.trace.slice(0, frame.traceLength))
    restoreRun(this.handle, frame.run)
    this.frames.splice(this.frames.indexOf(frame) + 1)
    this.stopped = null
  }
}
