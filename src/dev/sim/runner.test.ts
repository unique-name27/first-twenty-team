// The simulator panel's loop without a Worker: a clock and a scheduler the test moves, and the messages it
// posts. seed-8 as of 2026-10-01, never more than about two months of days, so it stays light.
import { afterEach, describe, expect, it } from 'vitest'
import type { DB } from '@/domain/types'
import { getClockOverride } from '@/lib/dates'
import { generateCompany } from '@/sim/generate'
import type { RunFileInput } from '@/sim/play'
import type { ScenarioName } from '@/sim/scenarios'
import type { FromWorker } from './protocol'
import { createRunner, zoneProblem } from './runner'

const companies = new Map<string, DB>()
let generated = 0
function generate(scenario: ScenarioName, seed: number, asOf: string): DB {
  const key = `${scenario} ${seed} ${asOf}`
  let db = companies.get(key)
  if (!db) {
    generated += 1
    db = generateCompany({ scenario, seed, asOf }).db
    companies.set(key, db)
  }
  return db
}

const RUN: RunFileInput = {
  version: 1,
  start: { kind: 'scenario', scenario: 'seed-8', asOf: '2026-10-01' },
  seed: 3,
  situations: [],
  until: '2026-12-31',
}

/** A runner on a clock that moves `perCall` ms each time it is read (work taking time), and a task queue. */
function harness(perCall = 0) {
  let clock = 0
  const queue: Array<{ at: number; fn: () => void }> = []
  const posted: FromWorker[] = []
  const runner = createRunner({
    post: (m) => posted.push(m),
    now: () => (clock += perCall),
    later: (fn, ms) => queue.push({ at: clock + ms, fn }),
    generate,
  })
  /** Runs every task due in the next `ms` milliseconds, in time order. */
  const pass = (ms: number) => {
    const end = clock + ms
    for (;;) {
      queue.sort((a, b) => a.at - b.at)
      const next = queue[0]
      if (!next || next.at > end) break
      queue.shift()
      clock = Math.max(clock, next.at)
      next.fn()
    }
    clock = Math.max(clock, end)
  }
  const of = <T extends FromWorker['type']>(type: T) => posted.filter((m): m is Extract<FromWorker, { type: T }> => m.type === type)
  const last = <T extends FromWorker['type']>(type: T) => of(type).at(-1)
  const send = runner.handle
  return { runner, posted, pass, of, last, send, queued: () => queue.length }
}

afterEach(() => {
  process.env.TZ = 'UTC'
})

describe('the simulator loop', () => {
  it('starts a run and says what it starts from, and refuses a run file that does not fit', () => {
    const h = harness()
    h.send({ type: 'start', run: { ...RUN, until: 'soon' } })
    expect(h.last('error')).toMatchObject({ stopped: false, message: expect.stringMatching(/^The run file does not fit: until:/) })
    h.send({ type: 'start', run: RUN })
    const ready = h.last('ready')!
    expect(ready).toMatchObject({ from: '2026-10-01', date: '2026-10-01', companyName: 'Quillpine', keyframes: ['2026-10-01'], situations: [], integrity: 0 })
    expect(ready.run).toEqual({ version: 1, seed: 3, pace: { preset: 'normal' }, situations: [], until: '2026-12-31' })
    expect(ready.roster.length).toBe(ready.metrics.headcount + ready.metrics.incoming)
    expect(ready.roster[0].founder).toBe(true)
    expect(ready.pace).toEqual({ hiringPace: 1, attritionPerYear: expect.any(Number), timeOff: 1, offerAcceptRate: expect.any(Number) })
    expect(ready.size).toBeGreaterThan(10_000)
    // The clock is left as it was: the worker's own module copy of it, but a test shares this one.
    expect(getClockOverride()).toBeNull()
  })

  it('generates each scenario once, however often a run starts from it', () => {
    const h = harness()
    const before = generated
    h.send({ type: 'start', run: RUN })
    h.send({ type: 'start', run: { ...RUN, seed: 9 } })
    expect(generated - before).toBeLessThanOrEqual(1)
  })

  it('steps while paused, the same as a day at a time', () => {
    const a = harness()
    a.send({ type: 'start', run: RUN })
    a.send({ type: 'step', days: 7 })
    const b = harness()
    b.send({ type: 'start', run: RUN })
    for (let i = 0; i < 7; i++) b.send({ type: 'step', days: 1 })
    expect(a.last('paused')).toMatchObject({ reason: 'step', date: '2026-10-08' })
    expect(b.last('paused')!.date).toBe('2026-10-08')
    const points = (h: ReturnType<typeof harness>) => h.of('tick').flatMap((t) => t.points)
    const events = (h: ReturnType<typeof harness>) => h.of('tick').flatMap((t) => t.events)
    expect(points(a)).toHaveLength(7)
    expect(points(b)).toEqual(points(a))
    expect(events(b)).toEqual(events(a))
    expect(b.last('paused')!.metrics).toEqual(a.last('paused')!.metrics)
  })

  it('plays a week a second at 1 week/s, telling the panel at most 10 times a second', () => {
    const h = harness()
    h.send({ type: 'start', run: RUN })
    h.send({ type: 'play', speed: 'week' })
    h.pass(1000)
    const lived = h.of('tick').flatMap((t) => t.points).length
    expect(lived).toBeGreaterThanOrEqual(6)
    expect(lived).toBeLessThanOrEqual(7)
    expect(h.of('tick').length).toBeLessThanOrEqual(11)
    expect(h.of('tick').every((t) => t.playing)).toBe(true)
    h.send({ type: 'pause' })
    expect(h.last('paused')).toMatchObject({ reason: 'asked' })
    const date = h.last('paused')!.date
    h.pass(2000)
    expect(h.last('tick')!.date).toBe(date)
  })

  it('plays at Max in slices, so a pause lands between them, and stops on the day asked for', () => {
    const h = harness(4)
    h.send({ type: 'start', run: RUN })
    h.send({ type: 'play', speed: 'max', stopAt: '2026-10-20' })
    // About 30 ms of work per slice, at 4 ms a clock read: a few days, then the worker is free again.
    h.pass(0)
    const firstSlice = h.of('tick').flatMap((t) => t.points).length
    expect(h.queued()).toBe(1)
    expect(firstSlice).toBeLessThan(19)
    h.pass(10_000)
    expect(h.last('paused')).toMatchObject({ reason: 'stop_at', date: '2026-10-20' })
    expect(h.of('tick').flatMap((t) => t.points).map((p) => p.date).at(-1)).toBe('2026-10-20')
  })

  it('records a change of pace from the next day, one entry however often the slider moves that day', () => {
    const h = harness()
    h.send({ type: 'start', run: RUN })
    h.send({ type: 'step', days: 3 })
    h.send({ type: 'setPace', changes: { attritionPerYear: 0.3 } })
    h.send({ type: 'setPace', changes: { hiringPace: 2 } })
    const last = h.last('situations')!
    expect(last.situations).toEqual([{ id: 'pace-2026-10-05-1', on: '2026-10-05', kind: 'pace', changes: { attritionPerYear: 0.3, hiringPace: 2 } }])
    expect(last.pace).toMatchObject({ attritionPerYear: 0.3, hiringPace: 2 })
    h.send({ type: 'setPace', changes: { hiringPace: 9 } })
    expect(h.last('error')).toMatchObject({ stopped: false, message: expect.stringMatching(/changes\.hiringPace: Too big/) })
    expect(h.last('situations')).toBe(last)
  })

  it('lives the days again when a situation lands before today, and refuses one that does not fit', () => {
    const h = harness()
    h.send({ type: 'start', run: RUN })
    h.send({ type: 'step', days: 30 })
    const straight = h.last('paused')!
    h.send({ type: 'setSituations', situations: [{ id: 'quit', on: '2026-10-12', kind: 'quit' }] })
    const replayed = h.last('replayed')!
    expect(replayed.from).toBe('2026-10-01')
    expect(replayed.date).toBe('2026-10-31')
    expect(replayed.points).toHaveLength(30)
    expect(replayed.notes.map((n) => n.situationId)).toContain('quit')
    expect(h.last('paused')).toMatchObject({ reason: 'changed', date: '2026-10-31', situations: [expect.objectContaining({ id: 'quit' })] })
    expect(h.last('paused')!.metrics.departuresToDate).toBeGreaterThan(straight.metrics.departuresToDate)
    const count = h.posted.length
    // A situation from JSON the panel did not check: the worker checks it.
    const unchecked = JSON.parse('[{ "id": "quit", "on": "2026-10-12", "kind": "quit", "notice": "a month" }]')
    h.send({ type: 'setSituations', situations: unchecked })
    expect(h.posted.length).toBe(count + 1)
    expect(h.last('error')).toMatchObject({ stopped: false, message: expect.stringMatching(/^The situations do not fit/) })
  })

  it('goes back to an earlier day and plays on from there the same way', () => {
    const h = harness()
    h.send({ type: 'start', run: RUN })
    h.send({ type: 'step', days: 45 })
    const day20 = h.of('tick').flatMap((t) => t.points)[19]
    h.send({ type: 'rewind', to: '2026-10-21' })
    const back = h.last('replayed')!
    expect(back.date).toBe('2026-10-21')
    expect(back.points.at(-1)).toEqual(day20)
    expect(h.last('paused')!.keyframes).toEqual(['2026-10-01'])
    h.send({ type: 'step', days: 24 })
    expect(h.last('paused')!.date).toBe('2026-11-14')
  })

  it('hands over the whole workspace in a snapshot', () => {
    const h = harness()
    h.send({ type: 'snapshot', id: 1 })
    expect(h.last('error')).toMatchObject({ message: 'No simulation is running.' })
    h.send({ type: 'start', run: RUN })
    h.send({ type: 'step', days: 2 })
    h.send({ type: 'snapshot', id: 2 })
    expect(h.last('snapshot')).toMatchObject({ id: 2, date: '2026-10-03', companyName: 'Quillpine' })
    expect(h.last('snapshot')!.db.people.length).toBeGreaterThan(1)
  })

  it('stops at the end of the run', () => {
    const h = harness()
    h.send({ type: 'start', run: { ...RUN, until: '2026-10-05' } })
    h.send({ type: 'step', days: 30 })
    expect(h.last('paused')).toMatchObject({ date: '2026-10-05' })
    h.send({ type: 'play', speed: 'max' })
    expect(h.last('paused')).toMatchObject({ reason: 'until', date: '2026-10-05' })
  })
})

describe('zoneProblem', () => {
  it('passes where a California working day is one date, and explains where it is not', () => {
    expect(zoneProblem(['2026-10-01', '2027-01-15'])).toBeNull()
    process.env.TZ = 'Europe/Berlin'
    expect(zoneProblem(['2026-10-01'])).toMatch(/^This browser's time zone puts a California afternoon on the next day/)
  })
})
