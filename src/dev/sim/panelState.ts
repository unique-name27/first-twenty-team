// What the simulator panel knows, built from the worker's messages (protocol.ts) by one pure reducer, so the
// rules are tested without a Worker or React. client.ts keeps it in a Zustand store.
import type { ISODate } from '@/lib/dates'
import { plural } from '@/lib/format'
import type { MetricPoint } from '@/sim/metrics'
import type { RunStart } from '@/sim/play'
import type { Pace, Situation, SituationNote } from '@/sim/situations'
import type { SimEvent } from '@/sim/story'
import { fmtSimDay } from './helpers'
import { appendCapped, type DepartmentEntry, EVENTS_KEPT, type FromWorker, type RosterEntry, type RunMeta, type Speed } from './protocol'

export type PanelError = { message: string; stopped: boolean; day: ISODate | null; traceTail: string[] }

/** An event in the feed, numbered as it arrived so a row keeps its key while older ones drop off. */
export type FeedEvent = SimEvent & { seq: number }

export type PanelState = {
  /** idle: no run yet; starting: a start is on its way to the worker; ready: a run is loaded. */
  phase: 'idle' | 'starting' | 'ready'
  playing: boolean
  speed: Speed
  /** Where the run starts, as the panel sent it (a workspace start keeps the whole company). */
  start: RunStart | null
  run: RunMeta | null
  label: string
  companyName: string
  from: ISODate | null
  /** The last day lived. */
  date: ISODate | null
  /** The numbers on the start day, then on the last day lived. */
  startMetrics: MetricPoint | null
  metrics: MetricPoint | null
  /** Each day's numbers from the first day lived. */
  points: MetricPoint[]
  /** The newest events (EVENTS_KEPT at most), oldest first. */
  events: FeedEvent[]
  /** The number the next event gets. */
  nextSeq: number
  notes: SituationNote[]
  roster: RosterEntry[]
  departments: DepartmentEntry[]
  keyframes: ISODate[]
  situations: Situation[]
  pace: Pace | null
  size: number | null
  integrity: number | null
  error: PanelError | null
  /** A step, a change of situations or a rewind is on its way to the worker (it answers when it is done). */
  working: boolean
  /** What the live region says: set when the simulation pauses, so a screen reader hears it then only. */
  announce: string
}

export const INITIAL_PANEL: PanelState = {
  phase: 'idle',
  playing: false,
  speed: 'week',
  start: null,
  run: null,
  label: '',
  companyName: '',
  from: null,
  date: null,
  startMetrics: null,
  metrics: null,
  points: [],
  events: [],
  nextSeq: 0,
  notes: [],
  roster: [],
  departments: [],
  keyframes: [],
  situations: [],
  pace: null,
  size: null,
  integrity: null,
  error: null,
  working: false,
  announce: '',
}

function numbered(events: readonly SimEvent[], from: number): FeedEvent[] {
  return events.map((e, i) => ({ ...e, seq: from + i }))
}

/** "Paused on Thu, Mar 4, 2027. 22 employees, 2 starting." */
export function pauseAnnouncement(date: ISODate, m: Pick<MetricPoint, 'headcount' | 'incoming'>): string {
  return `Paused on ${fmtSimDay(date)}. ${plural(m.headcount, 'employee')}${m.incoming ? `, ${m.incoming} starting` : ''}.`
}

export function reduce(s: PanelState, m: FromWorker): PanelState {
  switch (m.type) {
    case 'ready':
      return {
        ...s,
        phase: 'ready',
        playing: false,
        run: m.run,
        label: m.label,
        companyName: m.companyName,
        from: m.from,
        date: m.date,
        startMetrics: m.metrics,
        metrics: m.metrics,
        points: [],
        events: [],
        nextSeq: 0,
        notes: [],
        roster: m.roster,
        departments: m.departments,
        keyframes: m.keyframes,
        situations: m.situations,
        pace: m.pace,
        size: m.size,
        integrity: m.integrity,
        error: null,
        working: false,
        announce: `Started ${m.label}.`,
      }
    case 'tick':
      return {
        ...s,
        playing: m.playing,
        date: m.date,
        metrics: m.metrics,
        points: m.points.length ? [...s.points, ...m.points] : s.points,
        events: appendCapped(s.events, numbered(m.events, s.nextSeq), EVENTS_KEPT),
        nextSeq: s.nextSeq + m.events.length,
        notes: m.notes.length ? [...s.notes, ...m.notes] : s.notes,
      }
    case 'paused':
      return {
        ...s,
        playing: false,
        date: m.date,
        metrics: m.metrics,
        roster: m.roster,
        departments: m.departments,
        keyframes: m.keyframes,
        situations: m.situations,
        pace: m.pace,
        size: m.size,
        integrity: m.integrity,
        working: false,
        announce: pauseAnnouncement(m.date, m.metrics),
      }
    case 'replayed':
      return { ...s, date: m.date, metrics: m.metrics, points: m.points, events: numbered(m.events, s.nextSeq), nextSeq: s.nextSeq + m.events.length, notes: m.notes, error: null }
    case 'situations':
      return { ...s, situations: m.situations, pace: m.pace }
    case 'snapshot':
      return s
    case 'error':
      return {
        ...s,
        phase: s.phase === 'starting' ? (s.run ? 'ready' : 'idle') : s.phase,
        playing: m.stopped ? false : s.playing,
        error: { message: m.message, stopped: m.stopped, day: m.day, traceTail: m.traceTail },
        working: false,
        announce: m.stopped ? `The simulation stopped: ${m.message}` : m.message,
      }
  }
}
