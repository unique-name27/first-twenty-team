// The run file (docs/DEV.md, "Play a run"): a simulation written down as plain JSON, so it can be saved,
// shared in a bug report and played again exactly. It names where the run starts (a generated scenario, the
// sample, or a workspace with its date), the run's seed, the pace it starts at, the situations it lives
// through (pace changes included) and the day it runs until. `npm run sim -- play` and the simulator panel
// both build a run with buildStart and playRun, so they give the same result.
//
// Test and tooling code only (src/sim/guard.test.ts).
import { z } from 'zod'
import type { DB } from '@/domain/types'
import { addDays, daysBetween, type ISODate, isUsableDate } from '@/lib/dates'
import { advanceSummary } from './advance'
import { SCENARIO_NAMES, SCENARIOS, type ScenarioName } from './scenarios'
import { Simulation, type SimulationOptions } from './simulation'
import { PACE_CHANGES, type PaceChanges, parseSituations, type Situation } from './situations'

const isoDate = z.string().refine(isUsableDate, { message: 'a date written YYYY-MM-DD' })

const START = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('scenario'),
    scenario: z.enum(SCENARIO_NAMES as unknown as [ScenarioName, ...ScenarioName[]]),
    seed: z.number().int().nonnegative().optional(),
    asOf: isoDate.optional(),
  }),
  z.strictObject({ kind: z.literal('sample') }),
  z.strictObject({ kind: z.literal('workspace'), date: isoDate, db: z.record(z.string(), z.unknown()) }),
])

const RUN_FILE = z.strictObject({
  version: z.literal(1),
  start: START,
  seed: z.union([z.number().int().nonnegative(), z.string().min(1)]).default(1),
  pace: z.strictObject({ preset: z.enum(['quiet', 'normal', 'busy']).default('normal'), ...PACE_CHANGES.shape }).default({ preset: 'normal' }),
  situations: z.array(z.unknown()).default([]),
  until: isoDate,
})

export type RunStart = z.output<typeof START>
export type RunFile = Omit<z.output<typeof RUN_FILE>, 'situations'> & { situations: Situation[] }
/** A run file as written: the seed, pace and situations may be left out. */
export type RunFileInput = z.input<typeof RUN_FILE>

/** A run file from JSON, or an error naming each problem. */
export function parseRunFile(input: unknown): RunFile {
  const parsed = RUN_FILE.safeParse(input)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.length ? i.path.join('.') : 'the file'}: ${i.message}`)
    throw new Error(`The run file does not fit: ${problems.join('; ')}.`)
  }
  return { ...parsed.data, situations: parseSituations(parsed.data.situations) }
}

/** What a run starts from: the workspace and its date (the last day already lived). */
export type Started = { db: DB; from: ISODate; label: string }

/**
 * The workspace a run starts from. `generate` builds a scenario (generateCompany, or a cache of it); the
 * sample is the ledgerlark scenario, on its own date.
 */
export function buildStart(start: RunStart, generate: (scenario: ScenarioName, seed: number, asOf: ISODate) => DB): Started {
  if (start.kind === 'workspace') {
    const db = start.db as unknown as DB
    return { db, from: start.date, label: `${db.company?.name ?? 'A workspace'} on ${start.date}` }
  }
  const scenario = SCENARIOS[start.kind === 'sample' ? 'ledgerlark' : start.scenario]
  const seed = start.kind === 'scenario' ? (start.seed ?? scenario.seed) : scenario.seed
  const asOf = start.kind === 'scenario' ? (start.asOf ?? scenario.asOf) : scenario.asOf
  const db = generate(scenario.name, seed, asOf)
  return { db, from: asOf, label: start.kind === 'sample' ? `the sample (${db.company.name}) on ${asOf}` : `${scenario.name}, seed ${seed}, as of ${asOf}: ${db.company.name}` }
}

/** The simulation a run file describes, not yet stepped. reportCompliance is off unless asked for (it changes nothing). */
export function simulationFor(run: RunFile, started: Started, options: Pick<SimulationOptions, 'story' | 'metrics' | 'keyframes' | 'reportCompliance'> = {}): Simulation {
  const { preset, ...pace } = run.pace
  return new Simulation(started.db, {
    from: started.from,
    seed: run.seed,
    policy: preset,
    pace: pace as PaceChanges,
    situations: run.situations,
    reportCompliance: options.reportCompliance ?? false,
    ...(options.story !== undefined ? { story: options.story } : {}),
    ...(options.metrics !== undefined ? { metrics: options.metrics } : {}),
    ...(options.keyframes ? { keyframes: options.keyframes } : {}),
  })
}

/** Plays a run to `to` (default its `until`) in one step, and returns the simulation. */
export function playRun(run: RunFile, started: Started, to: ISODate = run.until, options: Pick<SimulationOptions, 'story' | 'metrics' | 'reportCompliance'> = {}): Simulation {
  const sim = simulationFor(run, started, { ...options, keyframes: 'none' })
  sim.stepTo(to)
  return sim
}

/** The summary of a run played so far, as advance writes it. */
export function playSummary(sim: Simulation, compliance = false): string {
  return advanceSummary(sim.db, sim.report(), { from: sim.from, to: sim.day, seed: sim.seed, policy: sim.policy.name, compliance })
}

/** The run file for a simulation: where it started, its seed, starting pace and situations, and its end. */
export function runFileOf(sim: Simulation, start: RunStart, until: ISODate, pace: RunFile['pace']): RunFile {
  return { version: 1, start, seed: sim.seed, pace, situations: [...sim.situationList()], until }
}

/**
 * The date a scenario is generated on so its company's date can be `today`: the latest day on or before
 * today with the as-of date's weekday, whole weeks away (scenario plans are written relative to the as-of
 * date, so the plan's weekdays keep their names), and the 0 to 6 days from there to today.
 */
export function startDateFor(asOf: ISODate, today: ISODate): { days: number; movedAsOf: ISODate; rest: number } {
  const gap = daysBetween(asOf, today)
  const days = Math.floor(gap / 7) * 7
  return { days, movedAsOf: addDays(asOf, days), rest: gap - days }
}
