// What the simulator panel keeps from the worker's messages: history that grows while it plays, a feed that
// keeps its newest events, history replaced after a replay, and errors that leave the run where it was.
import { describe, expect, it } from 'vitest'
import type { MetricPoint } from '@/sim/metrics'
import type { SimEvent } from '@/sim/story'
import { INITIAL_PANEL, type PanelState, pauseAnnouncement, reduce } from './panelState'
import { EVENTS_KEPT, type FromWorker, type PausedState } from './protocol'

const point = (date: string, headcount = 8): MetricPoint => ({
  date,
  headcount,
  incoming: 1,
  openRoles: 2,
  heldRoles: 0,
  pipeline: 10,
  offersOut: 0,
  startsToDate: 0,
  departuresToDate: 0,
  onLeave: 0,
  monthlyPayroll: 100_000,
})
const event = (day: string, n = 0): SimEvent => ({ day, kind: 'started', importance: 1, area: 'people', text: `Event ${n}` })
const paused = (date: string): PausedState => ({
  date,
  metrics: point(date, 9),
  roster: [],
  departments: [],
  keyframes: ['2026-10-01'],
  situations: [],
  pace: { hiringPace: 1, attritionPerYear: 0.12, timeOff: 1, offerAcceptRate: 0.8 },
  size: 1000,
  integrity: 0,
})
const ready: FromWorker = {
  type: 'ready',
  label: 'seed-8, seed 8008, as of 2026-10-01: Quillpine',
  companyName: 'Quillpine',
  from: '2026-10-01',
  run: { version: 1, seed: 1, pace: { preset: 'normal' }, situations: [], until: '2027-10-01' },
  ...paused('2026-10-01'),
}
const run = (...messages: FromWorker[]): PanelState => messages.reduce(reduce, { ...INITIAL_PANEL, phase: 'starting' })

describe('the panel state', () => {
  it('loads a run and grows its history as days are lived', () => {
    const s = run(ready, { type: 'tick', date: '2026-10-03', playing: true, metrics: point('2026-10-03'), points: [point('2026-10-02'), point('2026-10-03')], events: [event('2026-10-02')], notes: [] })
    expect(s).toMatchObject({ phase: 'ready', playing: true, date: '2026-10-03', from: '2026-10-01', companyName: 'Quillpine' })
    expect(s.points.map((p) => p.date)).toEqual(['2026-10-02', '2026-10-03'])
    expect(s.startMetrics?.date).toBe('2026-10-01')
    expect(s.events).toHaveLength(1)
  })

  it('keeps the newest events only', () => {
    const many = Array.from({ length: EVENTS_KEPT + 20 }, (_, i) => event('2026-10-02', i))
    const s = run(ready, { type: 'tick', date: '2026-10-02', playing: true, metrics: point('2026-10-02'), points: [], events: many, notes: [] })
    expect(s.events).toHaveLength(EVENTS_KEPT)
    expect(s.events.at(-1)?.text).toBe(`Event ${EVENTS_KEPT + 19}`)
  })

  it('announces a pause with the date and headcount', () => {
    const s = run(ready, { type: 'paused', reason: 'asked', ...paused('2027-03-04') })
    expect(s.playing).toBe(false)
    expect(s.announce).toBe('Paused on Thu, Mar 4, 2027. 9 employees, 1 starting.')
    expect(pauseAnnouncement('2027-03-04', { headcount: 1, incoming: 0 })).toBe('Paused on Thu, Mar 4, 2027. 1 employee.')
  })

  it('replaces its history after a replay', () => {
    const s = run(
      ready,
      { type: 'tick', date: '2026-10-10', playing: false, metrics: point('2026-10-10'), points: [point('2026-10-09'), point('2026-10-10')], events: [event('2026-10-10')], notes: [] },
      { type: 'replayed', from: '2026-10-01', date: '2026-10-05', metrics: point('2026-10-05'), points: [point('2026-10-05')], events: [], notes: [] },
    )
    expect(s.points.map((p) => p.date)).toEqual(['2026-10-05'])
    expect(s.events).toEqual([])
    expect(s.date).toBe('2026-10-05')
  })

  it('keeps the run after a refused request, and stops playing after a stop', () => {
    const refused = run(ready, { type: 'error', message: 'The situations do not fit.', stopped: false, day: '2026-10-01', traceTail: [] })
    expect(refused).toMatchObject({ phase: 'ready', error: { message: 'The situations do not fit.', stopped: false } })
    const first = reduce({ ...INITIAL_PANEL, phase: 'starting' }, { type: 'error', message: 'The run file does not fit.', stopped: false, day: null, traceTail: [] })
    expect(first.phase).toBe('idle')
    const stopped = run(ready, { type: 'tick', date: '2026-10-02', playing: true, metrics: point('2026-10-02'), points: [], events: [], notes: [] }, { type: 'error', message: 'Refused.', stopped: true, day: '2026-10-02', traceTail: ['a'] })
    expect(stopped).toMatchObject({ playing: false, error: { stopped: true, traceTail: ['a'] } })
  })
})
