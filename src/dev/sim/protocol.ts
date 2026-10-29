// The messages between the simulator panel and its worker (docs/DEV.md, "The simulator panel"), and the pure
// rules both sides share: the speeds, how many days a slice of the loop lives, and how the panel keeps the
// feed short. The worker (sim.worker.ts, runner.ts) owns the simulation; the panel only ever sees what these
// messages carry, and the whole workspace only in a 'snapshot'.
//
// Development only: main.tsx loads src/dev behind import.meta.env.DEV (src/dev/guard.test.ts).
import type { DB, ID } from '@/domain/types'
import type { ISODate } from '@/lib/dates'
import type { MetricPoint } from '@/sim/metrics'
import type { RunFile } from '@/sim/play'
import type { Pace, PaceChanges, Situation, SituationInput, SituationNote } from '@/sim/situations'
import type { SimEvent } from '@/sim/story'

export type Speed = 'day' | 'week' | 'month' | 'max'

export const SPEEDS: Record<Speed, { label: string; short: string; daysPerSecond: number | null }> = {
  day: { label: '1 day/s', short: '1d', daysPerSecond: 1 },
  week: { label: '1 week/s', short: '1w', daysPerSecond: 7 },
  month: { label: '1 month/s', short: '1m', daysPerSecond: 30 },
  // As fast as the computer goes, in slices so a pause still lands within one.
  max: { label: 'Max', short: 'Max', daysPerSecond: null },
}

export const SPEED_ORDER: Speed[] = ['day', 'week', 'month', 'max']

/** How long one slice of the loop may run before the worker reads its messages again. */
export const SLICE_MS = 30
/** The panel hears from a playing worker at most this often. */
export const TICK_MS = 100
/** Events the panel keeps (newest); the feed shows at most these. */
export const EVENTS_KEPT = 500
/** The longest run the panel starts, in days from its start date (about three years). */
export const MAX_RUN_DAYS = 3 * 366

/** Someone in the simulated company, for the situation editor's pickers. */
export type RosterEntry = { id: ID; name: string; title: string; departmentId: ID; founder: boolean }

export type DepartmentEntry = { id: ID; name: string }

/** A run file without where it starts (the panel keeps the start it sent; a workspace start is big). */
export type RunMeta = Omit<RunFile, 'start'>

/** Why a worker stopped playing. */
export type PauseReason = 'asked' | 'until' | 'stop_at' | 'error' | 'step' | 'started' | 'changed'

export type ToWorker =
  /** A new run: the run file as JSON (checked in the worker). */
  | { type: 'start'; run: unknown }
  /** Play at a speed; stopAt pauses on that day (the scrubber's "go to this day"). */
  | { type: 'play'; speed: Speed; stopAt?: ISODate }
  | { type: 'pause' }
  /** Lives some days while paused. */
  | { type: 'step'; days: number }
  /** A change of pace from the next simulated day, kept in the run as a pace situation. */
  | { type: 'setPace'; changes: PaceChanges }
  /** A new list of situations (pauses first); may live days again from a keyframe. */
  | { type: 'setSituations'; situations: SituationInput[] }
  /** Back to the end of an earlier day (pauses first). */
  | { type: 'rewind'; to: ISODate }
  /** The whole workspace now, for Open in the app and Download company. */
  | { type: 'snapshot'; id: number }

/** What a paused simulation looks like: the numbers, the roster and the situations as they stand. */
export type PausedState = {
  date: ISODate
  metrics: MetricPoint
  roster: RosterEntry[]
  departments: DepartmentEntry[]
  keyframes: ISODate[]
  situations: Situation[]
  pace: Pace
  /** The workspace as JSON, in characters (what a browser's storage counts). */
  size: number
  /** How many integrity problems the workspace has (src/domain/integrity.ts). */
  integrity: number
}

export type FromWorker =
  | ({ type: 'ready'; label: string; companyName: string; from: ISODate; run: RunMeta } & PausedState)
  | { type: 'tick'; date: ISODate; playing: boolean; metrics: MetricPoint; points: MetricPoint[]; events: SimEvent[]; notes: SituationNote[] }
  | ({ type: 'paused'; reason: PauseReason } & PausedState)
  /** The days from `from` on were lived again: the panel replaces its history with these. */
  | { type: 'replayed'; from: ISODate; date: ISODate; metrics: MetricPoint; points: MetricPoint[]; events: SimEvent[]; notes: SituationNote[] }
  /** The situations changed without living anything again (a pace change while playing). */
  | { type: 'situations'; situations: Situation[]; pace: Pace }
  | { type: 'snapshot'; id: number; db: DB; date: ISODate; companyName: string }
  /**
   * stopped: the simulation stopped part way through a day (a bug: only going back gets it going). Otherwise
   * a request was refused and nothing changed (a run file or a situation that does not fit).
   */
  | { type: 'error'; message: string; stopped: boolean; day: ISODate | null; traceTail: string[] }

/**
 * How many days a slice may live at a paced speed: the budget it carries plus the time since the last slice,
 * at most a second's worth (a tab that slept does not race to catch up). Returns the whole days and what is
 * left over for the next slice. Max speed has no budget: the slice's time limit stops it.
 */
export function sliceDays(speed: Speed, carried: number, elapsedMs: number): { days: number; carried: number } {
  const perSecond = SPEEDS[speed].daysPerSecond
  if (perSecond === null) return { days: Number.POSITIVE_INFINITY, carried: 0 }
  const budget = Math.min(carried + (Math.max(0, elapsedMs) * perSecond) / 1000, perSecond)
  const days = Math.floor(budget)
  return { days, carried: budget - days }
}

/** The newest `cap` of a list with more added (the feed keeps its newest events). */
export function appendCapped<T>(list: readonly T[], more: readonly T[], cap: number): T[] {
  if (more.length === 0) return list.length > cap ? list.slice(-cap) : (list as T[])
  const all = list.length + more.length <= cap ? [...list, ...more] : [...list, ...more].slice(-cap)
  return all
}
