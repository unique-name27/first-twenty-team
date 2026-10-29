// The simulator panel's loop (docs/DEV.md, "The simulator panel"): holds one Simulation (src/sim/simulation.ts)
// and answers the panel's messages (protocol.ts). It plays in slices of whole days, about 30 ms each, then
// gives the worker back to its messages, so a pause or a change of pace lands within a slice. Paced speeds
// live 1, 7 or 30 days a second; Max lives as many as the slices allow. A playing loop tells the panel what
// happened at most 10 times a second; a pause also sends the roster, the keyframes, the size and the
// integrity count, which cost more to work out.
//
// Pure apart from what it is given: the clock, the scheduler and the way out (post), so a test drives it
// without a Worker. sim.worker.ts wires it to the real ones.
import { integrityProblems } from '@/domain/integrity'
import { fullName, isEmployedOn } from '@/domain/people'
import type { DB } from '@/domain/types'
import { addDays, type ISODate, localDateOf, pacificOffsetHours } from '@/lib/dates'
import type { TraceLine } from '@/sim/actions'
import { resolvePolicy } from '@/sim/machine'
import type { MetricPoint } from '@/sim/metrics'
import { buildStart, parseRunFile, type RunFile, simulationFor } from '@/sim/play'
import type { ScenarioName } from '@/sim/scenarios'
import type { Simulation } from '@/sim/simulation'
import { type Pace, type PaceChanges, paceOn, type Situation, type SituationInput, type SituationNote } from '@/sim/situations'
import type { SimEvent } from '@/sim/story'
import { EVENTS_KEPT, type FromWorker, type PausedState, type PauseReason, SLICE_MS, sliceDays, type Speed, TICK_MS, type ToWorker } from './protocol'

export type RunnerDeps = {
  post: (message: FromWorker) => void
  /** Milliseconds, any origin (performance.now). */
  now: () => number
  /** Runs fn after about ms milliseconds (setTimeout). */
  later: (fn: () => void, ms: number) => void
  /** Generates a scenario's company (generateCompany); the runner keeps each one it made. */
  generate: (scenario: ScenarioName, seed: number, asOf: ISODate) => DB
}

export type Runner = { handle: (message: ToWorker) => void }

/** Trace lines a bug report carries. */
const TRACE_TAIL = 20

/**
 * Why this computer's time zone cannot run a simulation on these dates, or null. Simulated people act at
 * California times of day from 08:00 to 15:59 (src/lib/runContext.ts), and a run refuses a moment that falls
 * on another date here: from about Central Europe eastwards, a California afternoon is already tomorrow.
 */
export function zoneProblem(dates: readonly ISODate[]): string | null {
  for (const date of dates) {
    const [y, m, d] = date.split('-').map(Number)
    for (const [h, min] of [
      [8, 0],
      [15, 59],
    ]) {
      const at = new Date(Date.UTC(y, m - 1, d, h, min) - pacificOffsetHours(date) * 3_600_000).toISOString()
      if (localDateOf(at) !== date) {
        return `This browser's time zone puts a California afternoon on the next day, and simulated people act on California time. Run it with npm run sim -- play (it runs in California time), or set the browser's time zone to Los Angeles in DevTools (Sensors).`
      }
    }
  }
  return null
}

/** The dates a run's time zone check looks at: its start and end, and a winter and a summer day between. */
function zoneDates(from: ISODate, until: ISODate): ISODate[] {
  const year = from.slice(0, 4)
  return [from, until, `${year}-01-15`, `${year}-07-15`]
}

function traceTail(trace: readonly TraceLine[]): string[] {
  return trace.slice(-TRACE_TAIL).map((t) => `${t.day} ${t.time} ${t.action} ${JSON.stringify(t.args).slice(0, 240)}`)
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function createRunner(deps: RunnerDeps): Runner {
  const companies = new Map<string, DB>()
  let sim: Simulation | null = null
  let run: RunFile | null = null
  let playing = false
  let speed: Speed = 'week'
  let stopAt: ISODate | null = null
  // Each play starts a chain of slices with its own token; a pause or a new run ends the chain.
  let token = 0
  let carried = 0
  let lastSliceAt = 0
  let lastPostAt = 0
  let pending: { points: MetricPoint[]; events: SimEvent[]; notes: SituationNote[] } = { points: [], events: [], notes: [] }

  const generate = (scenario: ScenarioName, seed: number, asOf: ISODate): DB => {
    const key = `${scenario} ${seed} ${asOf}`
    let db = companies.get(key)
    if (!db) {
      db = deps.generate(scenario, seed, asOf)
      companies.set(key, db)
    }
    return db
  }

  const refuse = (e: unknown) => deps.post({ type: 'error', message: message(e), stopped: false, day: sim?.day ?? null, traceTail: [] })

  function pace(s: Simulation, r: RunFile): Pace {
    const { preset, ...start } = r.pace
    return paceOn(resolvePolicy(preset), s.situationList(), addDays(s.day, 1), start as PaceChanges)
  }

  function pausedState(s: Simulation, r: RunFile): PausedState {
    const db = s.db
    const day = s.day
    return {
      date: day,
      metrics: s.metricsNow(),
      roster: db.people
        .filter((p) => isEmployedOn(p, day) || p.startDate > day)
        .sort((a, b) => a.hireNumber - b.hireNumber)
        .map((p) => ({ id: p.id, name: fullName(p), title: p.title, departmentId: p.departmentId, founder: !!p.isFounder })),
      departments: db.departments.map((d) => ({ id: d.id, name: d.name })),
      keyframes: s.keyframes(),
      situations: [...s.situationList()],
      pace: pace(s, r),
      size: JSON.stringify(db).length,
      integrity: integrityProblems(db).length,
    }
  }

  function postTick(): void {
    if (!sim) return
    const { points, events, notes } = pending
    pending = { points: [], events: [], notes: [] }
    lastPostAt = deps.now()
    deps.post({ type: 'tick', date: sim.day, playing, metrics: points.at(-1) ?? sim.metricsNow(), points, events, notes })
  }

  function postPaused(reason: PauseReason): void {
    if (!sim || !run) return
    deps.post({ type: 'paused', reason, ...pausedState(sim, run) })
  }

  /** Stops the loop; what it lived since the last tick goes out first. */
  function stop(reason: PauseReason): void {
    const was = playing
    playing = false
    token += 1
    if (was || pending.points.length > 0) postTick()
    if (reason !== 'error') postPaused(reason)
  }

  function stopped(e: unknown): void {
    playing = false
    token += 1
    postTick()
    deps.post({ type: 'error', message: message(e), stopped: true, day: sim?.day ?? null, traceTail: sim ? traceTail(sim.trace) : [] })
  }

  /** The last day the loop plays to: the run's end, or the day the scrubber asked for. */
  function endDay(): ISODate {
    if (!run) return '0000-01-01'
    return stopAt && stopAt < run.until ? stopAt : run.until
  }

  function liveOne(s: Simulation): void {
    const r = s.step(1)
    pending.points.push(...r.points)
    pending.events.push(...r.events)
    pending.notes.push(...r.notes)
  }

  function slice(mine: number): void {
    if (mine !== token || !playing || !sim) return
    const s = sim
    const start = deps.now()
    const budget = sliceDays(speed, carried, start - lastSliceAt)
    lastSliceAt = start
    const end = endDay()
    let lived = 0
    try {
      while (lived < budget.days && s.day < end && (lived === 0 || deps.now() - start < SLICE_MS)) {
        liveOne(s)
        lived += 1
      }
    } catch (e) {
      stopped(e)
      return
    }
    // Days the slice had no time for wait for the next one (sliceDays keeps it to a second's worth).
    carried = Number.isFinite(budget.days) ? budget.carried + (budget.days - lived) : 0
    if (s.day >= end) {
      stop(stopAt && end === stopAt ? 'stop_at' : 'until')
      stopAt = null
      return
    }
    if (lived > 0 && deps.now() - lastPostAt >= TICK_MS) postTick()
    deps.later(() => slice(mine), speed === 'max' ? 0 : 20)
  }

  function start(input: unknown): void {
    if (playing) stop('started')
    let parsed: RunFile
    try {
      parsed = parseRunFile(input)
    } catch (e) {
      refuse(e)
      return
    }
    let next: Simulation
    let label: string
    try {
      const started = buildStart(parsed.start, generate)
      const zone = zoneProblem(zoneDates(started.from, parsed.until))
      if (zone) throw new Error(zone)
      if (parsed.until <= started.from) throw new Error(`The run ends on ${parsed.until}, which is not after its start, ${started.from}.`)
      next = simulationFor(parsed, started, { keyframes: 'month', story: true, metrics: true })
      label = started.label
    } catch (e) {
      refuse(e)
      return
    }
    sim = next
    run = parsed
    pending = { points: [], events: [], notes: [] }
    stopAt = null
    const { start: _start, ...meta } = parsed
    deps.post({ type: 'ready', label, companyName: next.db.company.name, from: next.from, run: meta, ...pausedState(next, parsed) })
  }

  function play(next: Speed, at?: ISODate): void {
    if (!sim || !run) return
    speed = next
    if (at !== undefined) stopAt = at > sim.day ? at : null
    if (sim.day >= endDay()) {
      stopAt = null
      postPaused('until')
      return
    }
    if (playing) return
    playing = true
    token += 1
    carried = 0
    lastSliceAt = deps.now()
    lastPostAt = lastSliceAt
    const mine = token
    deps.later(() => slice(mine), 0)
    postTick()
  }

  function step(days: number): void {
    if (!sim || !run) return
    if (playing) stop('asked')
    const to = addDays(sim.day, Math.max(1, Math.floor(days)))
    const end = run.until < to ? run.until : to
    if (end <= sim.day) {
      postPaused('until')
      return
    }
    try {
      const r = sim.stepTo(end)
      pending.points.push(...r.points)
      pending.events.push(...r.events)
      pending.notes.push(...r.notes)
    } catch (e) {
      stopped(e)
      return
    }
    postTick()
    postPaused('step')
  }

  function replayed(s: Simulation, from: ISODate): void {
    pending = { points: [], events: [], notes: [] }
    deps.post({ type: 'replayed', from, date: s.day, metrics: s.metricsNow(), points: [...s.points], events: s.events.slice(-EVENTS_KEPT), notes: [...s.notes] })
  }

  function setPace(changes: PaceChanges): void {
    if (!sim || !run) return
    try {
      // Moves made on the same simulated day (a slider dragged) become one pace entry.
      const on = addDays(sim.day, 1)
      const list = sim.situationList()
      const same = list.find((s): s is Extract<Situation, { kind: 'pace' }> => s.kind === 'pace' && s.on === on)
      if (same) sim.setSituations(list.map((s) => (s === same ? { ...same, changes: { ...same.changes, ...changes } } : s)))
      else sim.setPace(changes)
    } catch (e) {
      refuse(e)
      return
    }
    deps.post({ type: 'situations', situations: [...sim.situationList()], pace: pace(sim, run) })
  }

  function setSituations(list: SituationInput[]): void {
    if (!sim || !run) return
    if (playing) stop('changed')
    try {
      const change = sim.setSituations(list)
      if (change.replayed) replayed(sim, change.from)
    } catch (e) {
      // A list that does not fit changes nothing; a refusal part way through living again stops the run.
      if (e instanceof Error && e.message.startsWith('The situation')) refuse(e)
      else stopped(e)
      return
    }
    postPaused('changed')
  }

  function rewind(to: ISODate): void {
    if (!sim || !run) return
    if (playing) stop('asked')
    const day = to < sim.from ? sim.from : to
    try {
      const r = sim.rewindTo(day > sim.day ? sim.day : day)
      replayed(sim, r.from)
    } catch (e) {
      stopped(e)
      return
    }
    postPaused('changed')
  }

  function snapshot(id: number): void {
    if (!sim) {
      refuse(new Error('No simulation is running.'))
      return
    }
    deps.post({ type: 'snapshot', id, db: sim.db, date: sim.day, companyName: sim.db.company.name })
  }

  return {
    handle(msg: ToWorker): void {
      try {
        switch (msg.type) {
          case 'start':
            return start(msg.run)
          case 'play':
            return play(msg.speed, msg.stopAt)
          case 'pause':
            if (playing) stop('asked')
            return
          case 'step':
            return step(msg.days)
          case 'setPace':
            return setPace(msg.changes)
          case 'setSituations':
            return setSituations(msg.situations)
          case 'rewind':
            return rewind(msg.to)
          case 'snapshot':
            return snapshot(msg.id)
        }
      } catch (e) {
        stopped(e)
      }
    },
  }
}
