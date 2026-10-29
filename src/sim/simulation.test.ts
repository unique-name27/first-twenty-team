// A simulation that steps: living 120 days in any chunks (a day, a week, 30 days, a mix) gives byte-identical
// JSON to one step and to advance, and going back to an earlier day, then on again, gives the same as never
// going back. seed-8 and full-20, generated as of 2026-10-01. Heavy: on a slow computer run it in parts
// (npx vitest run src/sim/simulation.test.ts -t seed-8).
import { afterEach, describe, expect, it } from 'vitest'
import type { DB } from '@/domain/types'
import { addDays, getClockOverride, setClockOverride } from '@/lib/dates'
import { withRunContext } from '@/lib/runContext'
import { traceToJsonLines } from './actions'
import { advance } from './advance'
import { generateCompany } from './generate'
import type { ScenarioName } from './scenarios'
import { Simulation } from './simulation'

const AS_OF = '2026-10-01'
const DAYS = 120
const END = addDays(AS_OF, DAYS)

const companies = new Map<ScenarioName, DB>()
function company(name: ScenarioName): DB {
  let db = companies.get(name)
  if (!db) {
    db = generateCompany({ scenario: name, asOf: AS_OF }).db
    companies.set(name, db)
  }
  return db
}

type Outcome = { db: string; trace: string; report: string }
const outcome = (sim: Simulation): Outcome => ({ db: JSON.stringify(sim.db), trace: traceToJsonLines(sim.trace), report: JSON.stringify(sim.report()) })

const straights = new Map<string, Outcome>()
/** The simulation lived to `to` in one step. */
function straight(name: ScenarioName, to = END): Outcome {
  const key = `${name} ${to}`
  let o = straights.get(key)
  if (!o) {
    const sim = new Simulation(company(name), { from: AS_OF, seed: 1 })
    sim.stepTo(to)
    o = outcome(sim)
    straights.set(key, o)
  }
  return o
}

afterEach(() => setClockOverride(null))

describe.each(['seed-8', 'full-20'] as const)('%s over 120 days', (name) => {
  it.each([
    ['a day at a time', [1]],
    ['a week at a time', [7]],
    ['30 days at a time', [30]],
    ['mixed chunks', [1, 7, 30, 2, 14, 5]],
  ])('%s gives the same JSON as one step', (_label, sizes) => {
    const sim = new Simulation(company(name), { from: AS_OF, seed: 1 })
    for (let i = 0; sim.day < END; i++) {
      const next = addDays(sim.day, sizes[i % sizes.length])
      sim.stepTo(next < END ? next : END)
    }
    expect(outcome(sim)).toEqual(straight(name))
  })

  it('gives the same JSON as advance, which is one step', () => {
    setClockOverride(AS_OF)
    const r = advance(company(name), { to: END, seed: 1 })
    expect({ db: JSON.stringify(r.db), trace: traceToJsonLines(r.trace), report: JSON.stringify(r.report) }).toEqual(straight(name))
  })
})

describe('going back', () => {
  it('keeps a keyframe at the start and at the end of each month lived', () => {
    const sim = new Simulation(company('seed-8'), { from: AS_OF, seed: 1 })
    sim.stepTo(END)
    expect(sim.keyframes()).toEqual(['2026-10-01', '2026-10-31', '2026-11-30', '2026-12-31'])
    expect(new Simulation(company('seed-8'), { from: AS_OF, seed: 1, keyframes: 'none' }).keyframes()).toEqual(['2026-10-01'])
  })

  it('goes back to a day between keyframes as if it had never gone past it, then on again to the same end', () => {
    const sim = new Simulation(company('seed-8'), { from: AS_OF, seed: 1 })
    sim.stepTo(END)
    const back = addDays(AS_OF, 50)
    const r = sim.rewindTo(back)
    expect(r).toMatchObject({ from: '2026-10-31', to: back })
    expect(sim.day).toBe(back)
    expect(sim.keyframes()).toEqual(['2026-10-01', '2026-10-31'])
    expect(outcome(sim)).toEqual(straight('seed-8', back))
    sim.stepTo(END)
    expect(outcome(sim)).toEqual(straight('seed-8'))
  })

  it('goes back to a keyframe and to the start, and plays on to the same end', () => {
    const sim = new Simulation(company('seed-8'), { from: AS_OF, seed: 1 })
    sim.stepTo(END)
    sim.rewindTo('2026-10-31')
    expect(sim.step(DAYS - 30).to).toBe(END)
    expect(outcome(sim)).toEqual(straight('seed-8'))
    sim.rewindTo(AS_OF)
    expect([sim.day, sim.trace.length]).toEqual([AS_OF, 0])
    expect(sim.db).toBe(company('seed-8'))
    sim.stepTo(END)
    expect(outcome(sim)).toEqual(straight('seed-8'))
  })
})

describe('rules', () => {
  it('refuses a step backwards or of no days, a rewind into the future, and leaves the clock as it was', () => {
    const sim = new Simulation(company('seed-8'), { from: AS_OF, seed: 1 })
    setClockOverride('2030-01-01')
    sim.step(3)
    expect(getClockOverride()).toBe('2030-01-01')
    expect(() => sim.step(0)).toThrow('A step is one day or more, not 0.')
    expect(() => sim.stepTo(AS_OF)).toThrow("Time only moves forward: the company's date is 2026-10-04, so it cannot step to 2026-10-01. rewindTo goes back.")
    expect(() => sim.rewindTo('2026-10-05')).toThrow('The simulation is on 2026-10-04: 2026-10-05 is still to come (stepTo goes there).')
    expect(() => sim.rewindTo('2026-09-30')).toThrow('The simulation starts on 2026-10-01, so it cannot go back to 2026-09-30.')
    expect(sim.stepTo(sim.day).lines).toEqual([])
  })

  it('refuses to step inside another run, and goes on afterwards', () => {
    const sim = new Simulation(company('seed-8'), { from: AS_OF, seed: 1 })
    expect(() => withRunContext({ seed: 1, actorId: null, timeOfDay: '09:00' }, () => sim.step(1))).toThrow('A run is already on')
    expect(sim.day).toBe(AS_OF)
    expect(sim.step(1).to).toBe('2026-10-02')
  })

  it('refuses a workspace with no founder, a seed it cannot use and a date that is not one', () => {
    const db = company('seed-8')
    expect(() => new Simulation({ ...db, people: [] }, { from: AS_OF, seed: 1 })).toThrow('The workspace has no founder to act as Admin.')
    expect(() => new Simulation(db, { from: AS_OF, seed: '' })).toThrow('A seed is a whole number or some text, not .')
    expect(() => new Simulation(db, { from: '2026-02-30', seed: 1 })).toThrow("The company's date is a date written YYYY-MM-DD, not '2026-02-30'.")
  })
})
