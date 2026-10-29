// The simulator panel's pure helpers: situation lines and defaults, the editor's checks, the feed filters, the
// chart series, the timeline, run files (and the list kept in this browser) and the bug report.
import { describe, expect, it } from 'vitest'
import type { DB } from '@/domain/types'
import type { MetricPoint } from '@/sim/metrics'
import { parseSituations, type Situation } from '@/sim/situations'
import type { SimEvent } from '@/sim/story'
import {
  bugReport,
  feedEvents,
  fmtSize,
  freezeWindows,
  headcountSeries,
  loadSavedRuns,
  namesFrom,
  newSituation,
  nextSituationId,
  readRunText,
  removeSavedRun,
  SAVED_RUNS_KEY,
  SAVED_RUNS_MAX,
  saveRun,
  shareableRunFile,
  simFileName,
  situationProblems,
  situationSummary,
  timelineAt,
  untilLimits,
  withNewIdentity,
} from './helpers'
import type { RunMeta } from './protocol'

const names = namesFrom(
  [
    { id: 'p-1', name: 'Maya Chen' },
    { id: 'p-2', name: 'Leo Park' },
  ],
  [{ id: 'd-eng', name: 'Engineering' }],
)
const parse = (s: unknown): Situation => parseSituations([s])[0]

describe('situations in the panel', () => {
  it('reads as one plain line each', () => {
    expect(situationSummary(parse({ id: 'a', on: '2027-01-04', kind: 'hiringPush', roles: 3, departmentId: 'd-eng' }), names)).toBe('Hiring push: 3 roles in Engineering')
    expect(situationSummary(parse({ id: 'b', on: '2027-03-01', kind: 'freeze', until: '2027-04-30', holdOpenJobs: true }), names)).toBe('Hiring freeze to Fri, Apr 30, 2027, open jobs on hold')
    expect(situationSummary(parse({ id: 'c', on: '2027-05-03', kind: 'layoff', count: 2 }), names)).toBe('Layoff: 2 people at random, last day the same day')
    expect(situationSummary(parse({ id: 'd', on: '2027-05-03', kind: 'quit', personId: 'p-1', backfill: false }), names)).toBe('Maya Chen quits, no backfill')
    expect(situationSummary(parse({ id: 'e', on: '2027-05-03', kind: 'quit', personId: 'p-9' }), names)).toBe('someone who has left quits, with a backfill')
    expect(situationSummary(parse({ id: 'f', on: '2027-06-07', kind: 'pace', changes: { attritionPerYear: 0.3, hiringPace: 2 } }), names)).toBe('Pace: hiring pace 2x, attrition 30% a year')
    expect(situationSummary(parse({ id: 'g', on: '2027-06-07', kind: 'leaderHire', departmentId: 'd-eng' }), names)).toBe('Senior hire: a Head of for Engineering, the department moves under them')
  })

  it('starts each kind with defaults the worker accepts, under an id not taken', () => {
    const list = [{ id: 'quit-1' }]
    expect(nextSituationId('quit', list)).toBe('quit-2')
    for (const kind of ['hiringPush', 'growTo', 'freeze', 'quit', 'layoff', 'leave', 'raiseRound', 'leaderHire'] as const) {
      const s = newSituation(kind, '2027-01-04', list, [{ id: 'd-eng' }])
      expect(() => parseSituations([s]), kind).not.toThrow()
      expect(situationProblems(s, '2026-10-01', '2027-10-01'), kind).toEqual({})
    }
  })

  it('names what the editor must fix before the worker sees it', () => {
    expect(situationProblems({ id: 'a', on: '2026-10-01', kind: 'quit' }, '2026-10-01', '2027-10-01')).toEqual({ on: 'Pick a day after the run starts (Thu, Oct 1, 2026).' })
    expect(situationProblems({ id: 'a', on: '2027-11-01', kind: 'quit' }, '2026-10-01', '2027-10-01').on).toMatch(/^Pick a day on or before the run ends/)
    expect(situationProblems({ id: 'a', on: '2027-03-01', kind: 'freeze', until: '2027-02-01' }, '2026-10-01', '2027-10-01')).toEqual({ until: 'The freeze ends before it starts.' })
    expect(situationProblems({ id: 'a', on: '2027-03-01', kind: 'layoff', personIds: [] }, '2026-10-01', '2027-10-01')).toEqual({ personIds: 'Pick at least one person.' })
  })

  it('finds the windows with no hiring, the freeze after a layoff included', () => {
    const list = parseSituations([
      { id: 'f', on: '2027-03-01', kind: 'freeze', until: '2027-04-30' },
      { id: 'l', on: '2027-05-03', kind: 'layoff', count: 1, freezeDays: 30 },
      { id: 'q', on: '2027-05-03', kind: 'quit' },
    ])
    expect(freezeWindows(list)).toEqual([
      { id: 'f', from: '2027-03-01', to: '2027-04-30' },
      { id: 'l', from: '2027-05-03', to: '2027-06-02' },
    ])
  })
})

describe('feed and chart', () => {
  const ev = (day: string, importance: 1 | 2, area: SimEvent['area']): SimEvent => ({ day, kind: 'started', importance, area, text: `${day} ${area}` })
  const events = [ev('2027-01-01', 1, 'people'), ev('2027-01-02', 2, 'hiring'), ev('2027-01-03', 2, 'pay'), ev('2027-01-04', 1, 'situations'), ev('2027-01-05', 2, 'routine')]

  it('filters the feed, newest first', () => {
    expect(feedEvents(events, 'headlines').map((e) => e.day)).toEqual(['2027-01-04', '2027-01-01'])
    expect(feedEvents(events, 'hiring').map((e) => e.day)).toEqual(['2027-01-02'])
    expect(feedEvents(events, 'people').map((e) => e.day)).toEqual(['2027-01-04', '2027-01-01'])
    expect(feedEvents(events, 'pay').map((e) => e.day)).toEqual(['2027-01-03'])
    expect(feedEvents(events, 'all')).toHaveLength(5)
  })

  it('keeps a chart point only where a value changes', () => {
    const p = (date: string, headcount: number, incoming: number) => ({ date, headcount, incoming }) as MetricPoint
    const { employees, withStarting } = headcountSeries(p('2026-10-01', 8, 1), [p('2026-10-02', 8, 1), p('2026-10-03', 8, 2), p('2026-10-05', 9, 1)])
    expect(employees).toEqual([
      { date: '2026-10-01', value: 8 },
      { date: '2026-10-05', value: 9 },
    ])
    expect(withStarting).toEqual([
      { date: '2026-10-01', value: 9 },
      { date: '2026-10-03', value: 10 },
    ])
  })

  it('places days on the timeline and bounds a run at about three years', () => {
    expect(timelineAt('2026-10-01', '2026-10-01', '2027-10-01')).toBe(0)
    expect(timelineAt('2027-10-01', '2026-10-01', '2027-10-01')).toBe(1)
    expect(timelineAt('2028-01-01', '2026-10-01', '2027-10-01')).toBe(1)
    expect(timelineAt('2027-04-01', '2026-10-01', '2027-10-01')).toBeCloseTo(0.5, 1)
    expect(untilLimits('2026-10-01')).toEqual({ latest: '2029-10-03', byDefault: '2027-10-01' })
  })

  it('says sizes the way the footer does', () => {
    expect(fmtSize(2_412_000)).toBe('2.4 MB')
    expect(fmtSize(84_000)).toBe('84 KB')
  })
})

describe('run files', () => {
  const meta: RunMeta = { version: 1, seed: 1, pace: { preset: 'normal' }, situations: [], until: '2027-10-28' }
  const sits = parseSituations([{ id: 'q', on: '2027-01-04', kind: 'quit' }])
  const workspace = { kind: 'workspace' as const, date: '2026-10-28', db: { company: { name: 'Mine' } } }

  it('never shares the company a run started from', () => {
    const shared = shareableRunFile(workspace, meta, sits)
    expect(shared.start).toEqual({ kind: 'workspace', date: '2026-10-28', db: 'this company, not included' })
    expect(JSON.stringify(shared)).not.toContain('Mine')
    const scenario = { kind: 'scenario' as const, scenario: 'full-20' as const, seed: 2020, asOf: '2026-10-23' }
    expect(shareableRunFile(scenario, meta, sits)).toEqual({ version: 1, start: scenario, seed: 1, pace: { preset: 'normal' }, situations: sits, until: '2027-10-28' })
  })

  it('writes a bug report with the stop, the last actions and a run file to play', () => {
    const text = bugReport({ start: workspace, run: meta, situations: sits, label: 'Mine on 2026-10-28', date: '2027-02-01', error: { message: 'It broke.', day: '2027-02-01', traceTail: ['2027-02-01 08:00 openApp {}'] } })
    expect(text).toContain('start: this company, not included')
    expect(text).toContain('Stopped on 2027-02-01: It broke.')
    expect(text).toContain('  2027-02-01 08:00 openApp {}')
    expect(text).not.toContain('Mine')
  })

  it('reads pasted text, and says what is wrong with text that is not a run file', () => {
    expect(readRunText('  {"version":1}  ')).toEqual({ ok: true, run: { version: 1 } })
    expect(readRunText('')).toEqual({ ok: false, message: 'Paste a run file first.' })
    expect(readRunText('{version')).toMatchObject({ ok: false, message: expect.stringMatching(/^That is not JSON/) })
    expect(readRunText('[1]')).toMatchObject({ ok: false })
    expect(readRunText(JSON.stringify(shareableRunFile(workspace, meta, sits)))).toMatchObject({ ok: false, message: expect.stringMatching(/comes from a bug report/) })
  })

  it('names files after the run or the company and the day', () => {
    expect(simFileName('run', 'full-20', '2027-03-04')).toBe('sim-run-full-20-2027-03-04.json')
    expect(simFileName('company', 'Tidebeam, Inc.', '2027-03-04')).toBe('sim-company-tidebeam-inc-2027-03-04.json')
  })

  it('keeps a short list of runs in this browser, and copes with storage that refuses', () => {
    const data = new Map<string, string>()
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
    const run = { version: 1, until: '2027-01-01' }
    expect(saveRun(storage, ' ', run, 'now')).toEqual({ ok: false, message: 'Name the run first.' })
    for (let i = 0; i < SAVED_RUNS_MAX + 2; i++) expect(saveRun(storage, `run ${i}`, run, `t${i}`).ok).toBe(true)
    expect(loadSavedRuns(storage).map((r) => r.name)).toHaveLength(SAVED_RUNS_MAX)
    expect(loadSavedRuns(storage)[0].name).toBe(`run ${SAVED_RUNS_MAX + 1}`)
    saveRun(storage, 'run 4', { ...run, seed: 2 }, 'later')
    expect(loadSavedRuns(storage).filter((r) => r.name === 'run 4')).toEqual([{ name: 'run 4', savedAt: 'later', run: { ...run, seed: 2 } }])
    expect(removeSavedRun(storage, 'run 4').some((r) => r.name === 'run 4')).toBe(false)
    expect(saveRun(storage, 'big', { db: 'x'.repeat(500_000) }, 'now')).toMatchObject({ ok: false, message: expect.stringMatching(/too big for the list/) })
    const refusing = { getItem: () => null, setItem: () => { throw new Error('full') } }
    expect(saveRun(refusing, 'a', run, 'now')).toMatchObject({ ok: false, message: expect.stringMatching(/did not keep it/) })
    expect(removeSavedRun(refusing, 'a')).toEqual([])
    data.set(SAVED_RUNS_KEY, 'not json')
    expect(loadSavedRuns(storage)).toEqual([])
    expect(loadSavedRuns(null)).toEqual([])
  })

  it('gives a kept company a new identity, never the sample', () => {
    const db = { meta: { createdOn: '2026-01-05', sample: true } } as unknown as DB
    expect(withNewIdentity(db, 'ws-new').meta).toEqual({ createdOn: '2026-01-05', sample: false, workspaceId: 'ws-new' })
  })
})
