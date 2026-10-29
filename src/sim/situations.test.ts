// Situations: each one happens on its date through the simulator's actions (the steps the screens take), the
// workspace has no integrity failures afterwards, a step the app refuses becomes a note, and the same run with
// the same situations is byte-identical twice. Changing the situations after some days were lived goes back
// and lives them again, equal to a fresh run with the new list. seed-8 and full-20 as of 2026-10-01; each run
// is 60 to 90 days.
import { afterEach, describe, expect, it } from 'vitest'
import { integrityFailures } from '@/domain/integrity'
import { employedOn, incomingOn } from '@/domain/people'
import type { DB } from '@/domain/types'
import { addDays, parseDate, setClockOverride } from '@/lib/dates'
import { type TraceLine, traceToJsonLines } from './actions'
import { POLICIES, resolvePolicy } from './advance'
import { generateCompany } from './generate'
import type { ScenarioName } from './scenarios'
import { Simulation } from './simulation'
import { applyPace, paceOn, parseSituations, type SituationInput } from './situations'

const AS_OF = '2026-10-01'

const companies = new Map<ScenarioName, DB>()
function company(name: ScenarioName): DB {
  let db = companies.get(name)
  if (!db) {
    db = generateCompany({ scenario: name, asOf: AS_OF }).db
    companies.set(name, db)
  }
  return db
}

function run(name: ScenarioName, days: number, situations: SituationInput[]): Simulation {
  const sim = new Simulation(company(name), { from: AS_OF, seed: 1, situations })
  sim.stepTo(addDays(AS_OF, days))
  return sim
}

/** The trace lines a situation's steps made: on its day, at 08:20, as the founder. */
const at820 = (sim: Simulation, day: string): TraceLine[] => sim.trace.filter((t) => t.day === day && t.time === '08:20')
const args = <T,>(t: TraceLine) => t.args as T
const notesOf = (sim: Simulation, id: string) => sim.notes.filter((n) => n.situationId === id)

afterEach(() => setClockOverride(null))

// seed-8: the founder, Engineering (Keiko leads it) and a few more; one job open.
const SEED8: SituationInput[] = [
  { id: 'push', on: '2026-10-05', kind: 'hiringPush', roles: 2, departmentId: 'd-eng' },
  { id: 'quit', on: '2026-10-07', kind: 'quit', personId: null },
  { id: 'leave', on: '2026-10-12', kind: 'leave', personId: null, leaveKind: 'cfra', weeks: 6 },
  { id: 'raise', on: '2026-10-14', kind: 'raiseRound', percent: 4 },
  { id: 'freeze', on: '2026-10-20', kind: 'freeze', until: '2026-11-06', holdOpenJobs: true },
  { id: 'layoff', on: '2026-11-09', kind: 'layoff', count: 1 },
  { id: 'too-many', on: '2026-11-10', kind: 'layoff', count: 40 },
]

const runs = new Map<string, Simulation>()
function seed8(): Simulation {
  let sim = runs.get('seed-8')
  if (!sim) {
    sim = run('seed-8', 60, SEED8)
    runs.set('seed-8', sim)
  }
  return sim
}

describe('on seed-8, 60 days', () => {
  it('has no integrity failures, and is byte-identical when run again', () => {
    const sim = seed8()
    expect(integrityFailures(sim.db)).toEqual([])
    const again = run('seed-8', 60, SEED8)
    expect(JSON.stringify(again.db)).toBe(JSON.stringify(sim.db))
    expect(traceToJsonLines(again.trace)).toBe(traceToJsonLines(sim.trace))
    expect(again.notes).toEqual(sim.notes)
  })

  it('a hiring push adds plan lines in the department and opens and posts each the same morning', () => {
    const lines = at820(seed8(), '2026-10-05')
    expect(lines.map((t) => t.action)).toEqual(['addPlanLine', 'openJobFromPlan', 'editJob', 'markPosted', 'addPlanLine', 'openJobFromPlan', 'editJob', 'markPosted'])
    expect(lines.every((t) => t.actor === 'p-founder' && t.viewingAs === 'admin')).toBe(true)
    for (const t of lines.filter((x) => x.action === 'addPlanLine')) expect(args<{ departmentId: string }>(t).departmentId).toBe('d-eng')
    expect(notesOf(seed8(), 'push')).toEqual([expect.objectContaining({ skipped: false, text: 'Hiring push: 2 roles added to the plan in Engineering, 2 opened today.' })])
  })

  it('someone quits with two weeks notice through the Offboard wizard, and the role is backfilled', () => {
    const sim = seed8()
    const lines = at820(sim, '2026-10-07')
    expect(lines.map((t) => t.action)).toEqual(['offboardPerson', 'openBackfill', 'editJob', 'markPosted'])
    const off = args<{ personId: string; type: string; lastDay: string; noticeGivenOn: string }>(lines[0])
    expect(off).toMatchObject({ type: 'resigned_notice', noticeGivenOn: '2026-10-07', lastDay: '2026-10-23' })
    expect(parseDate(off.lastDay).getDay()).toBe(5)
    expect(off.personId).not.toBe('p-founder')
    expect(sim.db.jobs.some((j) => j.isBackfill && j.backfillForPersonId === off.personId && j.status !== 'draft')).toBe(true)
  })

  it('a leave starts for someone who qualifies, and they come back on the expected day', () => {
    const sim = seed8()
    const [line] = at820(sim, '2026-10-12')
    expect(line.action).toBe('startLeave')
    const a = args<{ personId: string; kind: string; startDate: string; expectedReturn: string }>(line)
    expect(a).toMatchObject({ kind: 'cfra', startDate: '2026-10-12', expectedReturn: '2026-11-23' })
    expect(sim.db.leaveCases.find((l) => l.personId === a.personId && l.startDate === '2026-10-12')).toMatchObject({ kind: 'cfra' })
  })

  it('a raise round gives each person a market raise from the next pay period, holding raises that leave the band', () => {
    const sim = seed8()
    const lines = at820(sim, '2026-10-14')
    expect(lines.length).toBeGreaterThan(2)
    for (const t of lines) {
      expect(t.action).toBe('changeJobOrPay')
      expect(args<{ personId: string; change: { reason: string; effectiveOn: string } }>(t)).toMatchObject({ change: { reason: 'market', effectiveOn: '2026-10-16' } })
      expect(args<{ personId: string }>(t).personId).not.toBe('p-founder')
    }
    expect(notesOf(sim, 'raise')[0].text).toMatch(/^Raise round of 4%: \d+ raised from 2026-10-16/)
  })

  it('a freeze puts open jobs on hold, plans and opens nothing, and posts the jobs again after it', () => {
    const sim = seed8()
    const held = at820(sim, '2026-10-20')
    expect(held.length).toBeGreaterThan(0)
    expect(held.every((t) => t.action === 'setJobStatus' && args<{ status: string }>(t).status === 'on_hold')).toBe(true)
    const inside = sim.trace.filter((t) => t.day >= '2026-10-20' && t.day <= '2026-11-06')
    expect(inside.filter((t) => ['addPlanLine', 'openJobFromPlan', 'openBackfill', 'addCandidate'].includes(t.action))).toEqual([])
    const resumed = at820(sim, '2026-11-09').filter((t) => t.action === 'markPosted').map((t) => args<{ jobId: string }>(t).jobId)
    expect(resumed.sort()).toEqual(held.map((t) => args<{ jobId: string }>(t).jobId).sort())
  })

  it('a layoff lays off people at random as the Offboard wizard does, and one of more people than there are is skipped', () => {
    const sim = seed8()
    const lines = at820(sim, '2026-11-09').filter((t) => t.action === 'offboardPerson')
    expect(lines.map((t) => args<{ type: string; reason: string; lastDay: string }>(t))).toEqual([
      expect.objectContaining({ type: 'laid_off', reason: 'Reduction in force', lastDay: '2026-11-09', rehireEligible: true }),
    ])
    expect(at820(sim, '2026-11-10')).toEqual([])
    expect(notesOf(sim, 'too-many')).toEqual([
      expect.objectContaining({ skipped: true, text: expect.stringMatching(/^Skipped the layoff: it names 40 people, but only \d besides the founder work here/) }),
    ])
  })
})

describe('on full-20, 90 days', () => {
  const FULL20: SituationInput[] = [
    { id: 'head-of-gtm', on: '2026-10-06', kind: 'leaderHire', departmentId: 'd-gtm' },
    { id: 'grow', on: '2026-11-02', kind: 'growTo', headcount: 26, by: '2027-01-15' },
    { id: 'cs-layoff', on: '2026-12-01', kind: 'layoff', departmentId: 'd-cs', noticeDays: 14, closeJobs: true, freezeDays: 10 },
  ]
  let cached: Simulation | undefined
  const full20 = () => (cached ??= run('full-20', 90, FULL20))

  it('has no integrity failures', () => {
    expect(integrityFailures(full20().db)).toEqual([])
  })

  it('a senior hire opens a Head of job from a plan line, and on their first day the department moves under them', () => {
    const sim = full20()
    expect(at820(sim, '2026-10-06').map((t) => t.action)).toEqual(expect.arrayContaining(['addPlanLine', 'createJob', 'markPosted']))
    const job = sim.db.jobs.find((j) => j.title === 'Head of Go to market')
    expect(job).toMatchObject({ levelId: 'lv-m2', departmentId: 'd-gtm', hiringManagerId: 'p-founder' })
    const leader = sim.db.people.find((p) => p.title === 'Head of Go to market')
    expect(leader, 'hired within the 90 days').toBeDefined()
    const moves = sim.trace.filter((t) => t.action === 'changeJobOrPay' && args<{ change: { reason: string } }>(t).change.reason === 'manager_change')
    expect(moves.length).toBeGreaterThan(0)
    for (const t of moves) expect(args<{ change: { managerId: string; effectiveOn: string } }>(t).change).toMatchObject({ managerId: leader?.id, effectiveOn: leader?.startDate })
    expect(sim.db.departments.find((d) => d.id === 'd-gtm')?.headId).toBe(leader?.id)
  })

  it('a push to a headcount fills the plan to it on the day, with every start by the date', () => {
    const sim = full20()
    const lines = at820(sim, '2026-11-02').filter((t) => t.action === 'addPlanLine')
    expect(lines.length).toBeGreaterThan(0)
    for (const t of lines) expect(args<{ targetStart: string }>(t).targetStart <= '2027-01-15').toBe(true)
  })

  it('a department layoff gives everyone in it the same last day after the notice, and closes its jobs', () => {
    const sim = full20()
    const lines = at820(sim, '2026-12-01')
    const off = lines.filter((t) => t.action === 'offboardPerson').map((t) => args<{ personId: string; lastDay: string; type: string }>(t))
    expect(off.length).toBeGreaterThan(0)
    for (const o of off) {
      expect(o).toMatchObject({ type: 'laid_off', lastDay: '2026-12-15' })
      expect(sim.db.people.find((p) => p.id === o.personId)?.departmentId).toBe('d-cs')
    }
    expect(sim.trace.filter((t) => t.day > '2026-12-01' && t.day <= '2026-12-11' && ['addPlanLine', 'openJobFromPlan', 'openBackfill'].includes(t.action))).toEqual([])
  })
})

describe('notes for steps the app would refuse', () => {
  it('skips a quit by someone who already left, a leave for someone who does not qualify, and names that do not exist', () => {
    const db = company('seed-8')
    const newcomer = db.people.find((p) => p.id !== 'p-founder' && p.startDate > '2025-10-12' && !p.separation)
    expect(newcomer, 'someone with under a year of service').toBeDefined()
    const sim = run('seed-8', 14, [
      { id: 'first', on: '2026-10-05', kind: 'quit', personId: 'p-keiko', notice: 'none', backfill: false },
      { id: 'second', on: '2026-10-06', kind: 'quit', personId: 'p-keiko' },
      { id: 'new-leave', on: '2026-10-07', kind: 'leave', personId: newcomer?.id ?? '', leaveKind: 'cfra' },
      { id: 'nobody', on: '2026-10-08', kind: 'quit', personId: 'p-nobody' },
      { id: 'no-dept', on: '2026-10-08', kind: 'hiringPush', roles: 1, departmentId: 'd-nowhere' },
    ])
    expect(sim.notes.map((n) => [n.situationId, n.skipped])).toEqual([
      ['first', false],
      ['second', true],
      ['new-leave', true],
      ['nobody', true],
      ['no-dept', true],
    ])
    expect(notesOf(sim, 'second')[0].text).toMatch(/^Skipped the resignation: Keiko \w+ has already left \(last day 2026-10-05\)\.$/)
    expect(notesOf(sim, 'new-leave')[0].text).toMatch(/does not qualify on 2026-10-07\. Needs more than 12 months of service/)
    expect(notesOf(sim, 'nobody')[0].text).toBe('Skipped the resignation: nobody in the workspace has the id p-nobody.')
    expect(at820(sim, '2026-10-06')).toEqual([])
    expect(integrityFailures(sim.db)).toEqual([])
  })
})

describe('pace', () => {
  it('changes the rates from its date, and is the preset number for number at its own pace', () => {
    const normal = resolvePolicy('normal')
    expect(applyPace(normal, paceOn(normal, [], '2026-10-10'))).toBe(normal)
    const list = parseSituations([{ id: 'p', on: '2026-10-10', kind: 'pace', changes: { hiringPace: 2, offerAcceptRate: 0.5 } }])
    expect(applyPace(normal, paceOn(normal, list, '2026-10-09'))).toBe(normal)
    expect(applyPace(normal, paceOn(normal, list, '2026-10-10'))).toEqual({
      ...POLICIES.normal,
      candidatesPerJobPerWeek: 12,
      openRoles: 2,
      offerAcceptRate: 0.5,
      offerDeclineRate: 0.3,
      name: 'normal, changed',
    })
  })

  it('takes effect from the next simulated day when set while paused, and a fresh run of the recorded list is the same', () => {
    const sim = new Simulation(company('seed-8'), { from: AS_OF, seed: 1 })
    sim.stepTo('2026-10-09')
    const entry = sim.setPace({ hiringPace: 0 })
    expect(entry).toEqual({ id: 'pace-2026-10-10-1', on: '2026-10-10', kind: 'pace', changes: { hiringPace: 0 } })
    sim.stepTo('2026-10-30')
    expect(sim.trace.filter((t) => t.day >= '2026-10-10' && t.action === 'addCandidate')).toEqual([])
    const plain = run('seed-8', 29, [])
    expect(plain.trace.filter((t) => t.day >= '2026-10-10' && t.action === 'addCandidate').length).toBeGreaterThan(0)
    const replay = run('seed-8', 29, [...sim.situationList()])
    expect(traceToJsonLines(replay.trace)).toBe(traceToJsonLines(sim.trace))
  })
})

describe('changing the situations', () => {
  const QUIT: SituationInput = { id: 'quit', on: '2026-10-21', kind: 'quit', personId: null }

  it('leaves everything before a situation exactly as without it', () => {
    const plain = run('seed-8', 40, [])
    const withQuit = run('seed-8', 40, [QUIT])
    const before = (s: Simulation) => traceToJsonLines(s.trace.filter((t) => t.day < '2026-10-21'))
    expect(before(withQuit)).toBe(before(plain))
    expect(traceToJsonLines(withQuit.trace)).not.toBe(traceToJsonLines(plain.trace))
  })

  it('lives the days again from before an earlier change, equal to a fresh run with the new list', () => {
    const sim = run('seed-8', 40, [])
    const later = sim.setSituations([{ id: 'later', on: '2026-11-20', kind: 'raiseRound', percent: 3 }])
    expect(later).toMatchObject({ replayed: false, lines: [] })
    const change = sim.setSituations([QUIT])
    expect(change).toMatchObject({ replayed: true, from: '2026-10-01', to: '2026-11-10' })
    const fresh = run('seed-8', 40, [QUIT])
    expect(JSON.stringify(sim.db)).toBe(JSON.stringify(fresh.db))
    expect(traceToJsonLines(sim.trace)).toBe(traceToJsonLines(fresh.trace))
    expect(sim.notes).toEqual(fresh.notes)
  })

  it('refuses situations that do not fit, naming each problem, and ones dated before the start', () => {
    expect(() => parseSituations([{ id: 'x', on: '2026-10-05', kind: 'layoff', count: 1, departmentId: 'd-eng' }])).toThrow(
      'The situations do not fit: Situation 1 (x), count: give exactly one of count, departmentId or personIds.',
    )
    expect(() => parseSituations([{ id: 'f', on: '2026-10-05', kind: 'freeze', until: '2026-10-01' }, { id: 'f', on: '2026-10-06', kind: 'quit' }])).toThrow(
      'Situation 1 (f), until: the freeze ends (2026-10-01) before it starts (2026-10-05); Situation 2 (f), id: another situation is already called f.',
    )
    expect(() => parseSituations([{ id: 'r', on: '2026-10-05', kind: 'raiseRound', percent: 0 }])).toThrow('Situation 1 (r), percent:')
    expect(() => parseSituations([{ id: 'w', on: '2026-10-05', kind: 'wedding' }])).toThrow('Situation 1 (w), kind:')
    expect(() => new Simulation(company('seed-8'), { from: AS_OF, seed: 1, situations: [{ ...QUIT, on: AS_OF }] })).toThrow(
      'The situation quit is on 2026-10-01, but the simulation starts from 2026-10-01: a situation comes after that day.',
    )
  })

  it('counts the people a push to a headcount reaches: employees, people starting and roles in the plan', () => {
    const sim = run('seed-8', 7, [{ id: 'grow', on: '2026-10-05', kind: 'growTo', headcount: 14, by: '2026-12-31' }])
    const db = sim.db
    const unfilled = db.plan.filter((s) => s.status === 'planned' || s.status === 'open' || s.status === 'offer').length
    expect(employedOn(db, sim.day).length + incomingOn(db, sim.day).length + unfilled).toBeGreaterThanOrEqual(14)
    expect(integrityFailures(db)).toEqual([])
  })
})
