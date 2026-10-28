// The time machine's rules, on small companies: the policy presets (a quiet one changes little), the
// refusals (stale law, going backwards, no company date), a clock in the middle of a pay period, people who
// resign (and their backfills), go on leave and come back, and next year's holidays in December.
import { afterEach, describe, expect, it } from 'vitest'
import { businessDayOnOrAfter, dbHolidays } from '@/domain/hiring'
import { rolloverHolidays } from '@/domain/holidays'
import { integrityFailures } from '@/domain/integrity'
import { payCalendar, peopleOnPayroll, periodContaining } from '@/domain/payrun'
import type { DB } from '@/domain/types'
import { addDays, getClockOverride, parseDate, setClockOverride } from '@/lib/dates'
import { withRunContext } from '@/lib/runContext'
import { type AdvanceResult, advance, POLICIES, type PolicyInput, resolvePolicy } from './advance'
import { generateCompany } from './generate'
import type { ScenarioName } from './scenarios'

const companies = new Map<string, DB>()
function company(name: ScenarioName, asOf?: string): DB {
  const key = `${name} ${asOf ?? ''}`
  let db = companies.get(key)
  if (!db) {
    db = generateCompany({ scenario: name, ...(asOf ? { asOf } : {}) }).db
    companies.set(key, db)
  }
  return db
}

/** advance from `from` to `to`, with the clock set to `from` first. */
function lived(db: DB, from: string, to: string, policy: PolicyInput = 'normal', seed: number | string = 3): AdvanceResult {
  setClockOverride(from)
  return advance(db, { to, seed, policy })
}

afterEach(() => setClockOverride(null))

// payroll-edge as generated: 2026-10-09, a Friday in the middle of the Oct 1 to 15 pay period.
const EDGE_AS_OF = '2026-10-09'

describe('policies', () => {
  it('reads a preset, or rates changed from one, and refuses settings it does not know', () => {
    expect(resolvePolicy()).toEqual({ ...POLICIES.normal, name: 'normal' })
    expect(resolvePolicy('busy')).toEqual({ ...POLICIES.busy, name: 'busy' })
    expect(resolvePolicy({ preset: 'quiet' })).toEqual({ ...POLICIES.quiet, name: 'quiet' })
    expect(resolvePolicy({ openRoles: 2, weeklyInboxSweep: false })).toEqual({ ...POLICIES.normal, openRoles: 2, weeklyInboxSweep: false, name: 'normal, changed' })
    expect(() => resolvePolicy('lazy' as never)).toThrow('No policy preset named lazy')
    expect(() => resolvePolicy({ hiresPerDay: 3 } as never)).toThrow('No policy setting named hiresPerDay.')
    expect(() => resolvePolicy({ attritionPerYear: -1 })).toThrow('The policy setting attritionPerYear is not a valid number: -1.')
    expect(() => resolvePolicy({ weeklyInboxSweep: 'yes' } as never)).toThrow('is not a valid boolean')
  })

  it('changes little at the quiet policy: nobody hired, raised, leaving or on leave, a day or two off, the routine kept', () => {
    const db = company('payroll-edge')
    const to = addDays(EDGE_AS_OF, 30)
    const quiet = lived(db, EDGE_AS_OF, to, 'quiet')
    const normal = lived(db, EDGE_AS_OF, to, 'normal')
    for (const r of [quiet, normal]) expect(integrityFailures(r.db)).toEqual([])
    const q = quiet.report
    expect(q.hiring).toMatchObject({ planned: 0, opened: 0, candidates: 0, offersDrafted: 0, hires: 0 })
    expect([q.headcount.separations, q.leaves.started, q.raises.given]).toEqual([0, 0, 0])
    expect(q.headcount.to).toBe(q.headcount.from)
    expect(q.timeOff.vacation + q.timeOff.sick).toBeLessThanOrEqual(2)
    // The routine is the same at any policy: the daily tick, pay runs, Monday's inbox sweep and tasks on their days.
    const routine = new Set(['openApp', 'markPayRunSubmitted', 'inboxOp', 'setTaskStatus'])
    const people = (r: AdvanceResult) => r.trace.filter((t) => !routine.has(t.action)).length
    expect(people(quiet)).toBeLessThanOrEqual(4)
    expect(people(normal)).toBeGreaterThan(5 * Math.max(1, people(quiet)))
    expect(quiet.report.payRuns).toEqual(normal.report.payRuns)
  })
})

describe('refusals', () => {
  it('refuses a date past the law coverage unless allowStaleLaw, and leaves the clock where it was', () => {
    const db = company('blank')
    setClockOverride('2026-12-20')
    expect(() => advance(db, { to: '2027-01-04', seed: 1 })).toThrow('2027-01-04 is after the dates the built-in rules cover (2025-01-01 to 2026-12-31). Pass allowStaleLaw to advance anyway.')
    expect(getClockOverride()).toBe('2026-12-20')
    const stale = advance(db, { to: '2027-01-04', seed: 1, allowStaleLaw: true })
    expect(stale.report.days).toBe(15)
    expect(getClockOverride()).toBe('2027-01-04')
  })

  it('never moves backwards, needs the company date, and never runs inside another run', () => {
    const db = company('blank')
    setClockOverride('2026-10-09')
    expect(() => advance(db, { to: '2026-10-08', seed: 1 })).toThrow("Time only moves forward: the company's date is 2026-10-09, so it cannot advance to 2026-10-08.")
    expect(() => advance(db, { to: 'next week', seed: 1 })).toThrow("The date to advance to is a date written YYYY-MM-DD, not 'next week'.")
    expect(() => advance(db, { to: '2026-10-12', seed: 1.5 })).toThrow('A seed is a whole number or some text, not 1.5.')
    expect(() => withRunContext({ seed: 1, actorId: null, timeOfDay: '09:00' }, () => advance(db, { to: '2026-10-12', seed: 1 }))).toThrow('A run is already on')
    expect(getClockOverride()).toBe('2026-10-09')
    setClockOverride(null)
    expect(() => advance(db, { to: '2026-10-12', seed: 1 })).toThrow("Set the company's date with setClockOverride first")
  })
})

describe('a company whose clock is in the middle of a pay period', () => {
  it('runs the period it is in on that period\'s cutoff, with the whole period in the prep, and leaves the next one for its own day', () => {
    const db = company('payroll-edge')
    const current = periodContaining(db, EDGE_AS_OF)
    expect(current.start < EDGE_AS_OF && current.cutoff > EDGE_AS_OF).toBe(true)
    const r = lived(db, EDGE_AS_OF, addDays(current.end, 5))
    expect(integrityFailures(r.db)).toEqual([])
    const next = payCalendar(r.db, addDays(current.end, 1), addDays(current.end, 1))[0]
    expect(next.cutoff > r.to).toBe(true)
    const runs = r.db.company.payRuns ?? []
    expect(runs.filter((x) => x.periodStart === current.start)).toEqual([expect.objectContaining({ submittedOn: current.cutoff, payday: current.payday })])
    expect(runs.some((x) => x.periodStart === next.start)).toBe(false)
    // Earlier periods were submitted when the company was generated, and stay as they were.
    expect(runs.filter((x) => x.periodEnd < current.start)).toEqual((db.company.payRuns ?? []).filter((x) => x.periodEnd < current.start))
    expect(r.report.payRuns).toEqual([
      { start: current.start, end: current.end, payday: current.payday, submittedOn: current.cutoff, late: false, people: peopleOnPayroll(r.db, current).length, estimatedGross: expect.any(Number) },
    ])
    expect(r.report.payRuns[0].estimatedGross).toBeGreaterThan(0)
  })

  it('runs a period whose cutoff passed before the advance on its first business day, marked late', () => {
    const db = company('payroll-edge')
    const current = periodContaining(db, EDGE_AS_OF)
    const from = current.cutoff
    expect(current.payday > from).toBe(true)
    const r = lived(db, from, addDays(from, 4))
    const first = businessDayOnOrAfter(addDays(from, 1), dbHolidays(db))
    expect(r.report.payRuns.map((x) => [x.start, x.submittedOn, x.late])).toEqual([[current.start, first, true]])
  })
})

describe('people over time', () => {
  it('resigns people who hand nothing off, backfills their roles, opens leaves and sends each leave notice in time', () => {
    const r = lived(company('seed-8', '2026-10-01'), '2026-10-01', '2026-11-30', { preset: 'busy', attritionPerYear: 10, leavesPerYear: 30 })
    expect(integrityFailures(r.db)).toEqual([])
    const leavers = r.trace.filter((t) => t.action === 'offboardPerson').map((t) => (t.args as { personId: string }).personId)
    expect(leavers.length).toBeGreaterThan(0)
    for (const id of leavers) {
      const person = r.db.people.find((p) => p.id === id)
      expect(person?.separation, id).toMatchObject({ type: 'resigned_notice', rehireEligible: true })
      expect(parseDate(person?.separation?.lastDay as string).getDay(), id).toBe(5)
      expect(r.db.checklists.some((c) => c.personId === id && c.kind === 'offboarding'), id).toBe(true)
    }
    const backfills = r.db.jobs.filter((j) => j.isBackfill && leavers.includes(j.backfillForPersonId ?? ''))
    expect(backfills.length).toBe(r.report.hiring.backfills)
    expect(backfills.length).toBeGreaterThan(0)
    for (const j of backfills) {
      expect(j.status === 'open' || j.status === 'filled', j.id).toBe(true)
      expect(j.panelIds, j.id).toContain(j.hiringManagerId)
      expect(j.interviewPlan.every((s) => s.interviewerIds.length > 0), j.id).toBe(true)
    }
    const leaves = r.db.leaveCases.filter((l) => l.requestedOn > r.from)
    expect(leaves.length).toBe(r.report.leaves.started)
    expect(leaves.length).toBeGreaterThan(0)
    for (const l of leaves) expect(!!l.designationNoticeSentOn && !!l.designationNoticeDueOn && l.designationNoticeSentOn <= l.designationNoticeDueOn, l.id).toBe(true)
  })

  it('brings someone back from leave on their expected return day', () => {
    const db = company('payroll-edge')
    const leave = db.leaveCases.find((l) => !l.returnedOn && !l.endedOn && l.expectedReturn)
    const back = businessDayOnOrAfter(leave?.expectedReturn as string, dbHolidays(db))
    const r = lived(db, EDGE_AS_OF, addDays(back, 1))
    expect(integrityFailures(r.db)).toEqual([])
    expect(r.db.leaveCases.find((l) => l.id === leave?.id)).toMatchObject({ returnedOn: back })
    expect(r.report.leaves.returned).toBe(1)
  })
})

it("adds next year's company holidays in December when they are missing, as rolloverHolidays proposes them", () => {
  const blank = company('blank')
  const db = { ...blank, holidays: blank.holidays.filter((h) => !h.date.startsWith('2027')) }
  const r = lived(db, '2026-11-27', '2026-12-04')
  const expected = rolloverHolidays(db.holidays, 2027).add.map((h) => h.date)
  expect(expected.length).toBeGreaterThan(5)
  expect(r.db.holidays.filter((h) => h.date.startsWith('2027')).map((h) => h.date)).toEqual(expected)
  expect(r.report.holidaysAdded).toEqual([2027])
  expect(r.trace.filter((t) => t.action === 'inboxOp').map((t) => [t.day, t.args])).toEqual([['2026-12-01', { op: { type: 'add_holidays', year: 2027 } }]])
})
