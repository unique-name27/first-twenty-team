// The run file: read with its defaults or refused with each problem named, built into a start (a scenario, the
// sample or a workspace), and played the same way by npm run sim -- play (one step to the end) and by the
// simulator panel (a day at a time, with a pace change recorded on the way). seed-8 as of 2026-10-01.
import { describe, expect, it } from 'vitest'
import { SAMPLE_ANCHOR } from '@/data/seed'
import type { DB } from '@/domain/types'
import { traceToJsonLines } from './actions'
import { generateCompany } from './generate'
import { buildStart, parseRunFile, playRun, playSummary, type RunFileInput, runFileOf, simulationFor, startDateFor } from './play'
import { SCENARIOS, type ScenarioName } from './scenarios'

const companies = new Map<string, DB>()
function generate(scenario: ScenarioName, seed: number, asOf: string): DB {
  const key = `${scenario} ${seed} ${asOf}`
  let db = companies.get(key)
  if (!db) {
    db = generateCompany({ scenario, seed, asOf }).db
    companies.set(key, db)
  }
  return db
}

const RUN: RunFileInput = {
  version: 1,
  start: { kind: 'scenario', scenario: 'seed-8', asOf: '2026-10-01' },
  seed: 4,
  pace: { preset: 'normal', attritionPerYear: 0.5 },
  situations: [
    { id: 'push', on: '2026-10-12', kind: 'hiringPush', roles: 1, departmentId: 'd-eng' },
    { id: 'quit', on: '2026-10-20', kind: 'quit' },
    { id: 'slower', on: '2026-11-02', kind: 'pace', changes: { hiringPace: 0.5 } },
  ],
  until: '2026-11-20',
}

describe('parseRunFile', () => {
  it('fills in the seed, pace and situations a file leaves out', () => {
    expect(parseRunFile({ version: 1, start: { kind: 'sample' }, until: '2026-12-01' })).toEqual({
      version: 1,
      start: { kind: 'sample' },
      seed: 1,
      pace: { preset: 'normal' },
      situations: [],
      until: '2026-12-01',
    })
    expect(parseRunFile(RUN).situations[1]).toEqual({ id: 'quit', on: '2026-10-20', kind: 'quit', personId: null, notice: 'two_weeks', backfill: true })
  })

  it('names each problem', () => {
    expect(() => parseRunFile({ version: 2, start: { kind: 'scenario', scenario: 'huge-50' }, until: 'soon' })).toThrow(/^The run file does not fit: version: .*; start\.scenario: .*; until: a date written YYYY-MM-DD\.$/)
    expect(() => parseRunFile({ ...RUN, pace: { preset: 'normal', hiringPace: 9 } })).toThrow('pace.hiringPace:')
    expect(() => parseRunFile({ ...RUN, situations: [{ id: 'q', on: '2026-10-20', kind: 'quit', notice: 'a month' }] })).toThrow('Situation 1 (q), notice:')
  })
})

describe('buildStart', () => {
  it('starts from a scenario on its as-of date, the sample on its own date, or a workspace on its date', () => {
    const scenario = buildStart({ kind: 'scenario', scenario: 'seed-8', asOf: '2026-10-01' }, generate)
    expect([scenario.from, scenario.label]).toEqual(['2026-10-01', `seed-8, seed ${SCENARIOS['seed-8'].seed}, as of 2026-10-01: ${scenario.db.company.name}`])
    const seen: unknown[] = []
    const sample = buildStart({ kind: 'sample' }, (...args) => {
      seen.push(args)
      return scenario.db
    })
    expect([sample.from, seen]).toEqual([SAMPLE_ANCHOR, [['ledgerlark', SCENARIOS.ledgerlark.seed, SAMPLE_ANCHOR]]])
    const workspace = buildStart({ kind: 'workspace', date: '2026-11-02', db: scenario.db as unknown as Record<string, unknown> }, generate)
    expect([workspace.from, workspace.db]).toEqual(['2026-11-02', scenario.db])
  })
})

describe('playing a run', () => {
  it('gives the same company a day at a time as in one step, and npm run sim prints its summary', () => {
    const run = parseRunFile(RUN)
    const started = buildStart(run.start, generate)
    const once = playRun(run, started)
    const daily = simulationFor(run, started)
    while (daily.day < run.until) daily.step(1)
    expect(JSON.stringify(daily.db)).toBe(JSON.stringify(once.db))
    expect(traceToJsonLines(daily.trace)).toBe(traceToJsonLines(once.trace))
    expect(JSON.stringify(daily.events)).toBe(JSON.stringify(once.events))
    expect(once.notes.map((n) => n.situationId)).toEqual(['push', 'quit'])
    expect(playSummary(once)).toMatch(/^Advanced \w+ from 2026-10-01 to 2026-11-20: 50 days, .* normal, changed policy, seed 4\./)
    expect(playSummary(once)).toContain('Compliance: not evaluated in this run.')
  })

  it('writes down a pace change made while playing, and the file plays back the same', () => {
    const run = parseRunFile({ ...RUN, situations: [] })
    const started = buildStart(run.start, generate)
    const sim = simulationFor(run, started)
    sim.stepTo('2026-10-15')
    sim.setPace({ hiringPace: 2, timeOff: 0 })
    sim.stepTo(run.until)
    const file = runFileOf(sim, run.start, run.until, run.pace)
    expect(file.situations).toEqual([{ id: 'pace-2026-10-16-1', on: '2026-10-16', kind: 'pace', changes: { hiringPace: 2, timeOff: 0 } }])
    const replay = playRun(parseRunFile(JSON.parse(JSON.stringify(file))), started)
    expect(traceToJsonLines(replay.trace)).toBe(traceToJsonLines(sim.trace))
    expect(sim.trace.some((t) => t.day >= '2026-10-16' && t.action === 'requestTimeOff')).toBe(false)
  })
})

describe('startDateFor', () => {
  it('picks the same weekday on or before today, whole weeks away, and the days left to live', () => {
    expect(startDateFor('2026-10-09', '2026-10-28')).toEqual({ days: 14, movedAsOf: '2026-10-23', rest: 5 })
    expect(startDateFor('2026-10-09', '2027-01-04')).toEqual({ days: 84, movedAsOf: '2027-01-01', rest: 3 })
  })
})
