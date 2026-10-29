// The time machine on two generated companies, 30 and 90 days at the normal policy: the result is valid by
// the shared integrity checks, every pay run that came due was submitted once, people took time off and the
// company hired, everything happened inside the days lived through, and the same input gives byte-identical
// output. The companies are generated as of 2026-10-01.
// More cases (policies, refusals, a clock mid pay period, leavers, December) are in advance.rules.test.ts.
import { afterEach, describe, expect, it } from 'vitest'
import { integrityFailures } from '@/domain/integrity'
import { hasPaidPeople, payCalendar } from '@/domain/payrun'
import type { DB } from '@/domain/types'
import { addDays, getClockOverride, setClockOverride } from '@/lib/dates'
import { traceToJsonLines } from './actions'
import { type AdvanceResult, advance } from './advance'
import { generateCompany } from './generate'
import type { ScenarioName } from './scenarios'

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

/** advance from AS_OF, with the clock set and put back as it was. */
function lived(name: ScenarioName, days: number, seed: number | string = 1): AdvanceResult {
  const previous = getClockOverride()
  setClockOverride(AS_OF)
  try {
    return advance(company(name), { to: addDays(AS_OF, days), seed })
  } finally {
    setClockOverride(previous)
  }
}

const results = new Map<string, { result: AdvanceResult; ms: number }>()
function result(name: ScenarioName, days: number): AdvanceResult {
  const key = `${name} ${days}`
  let r = results.get(key)
  if (!r) {
    company(name)
    const start = performance.now()
    const out = lived(name, days)
    r = { result: out, ms: performance.now() - start }
    results.set(key, r)
  }
  return r.result
}

afterEach(() => setClockOverride(null))

describe.each([
  ['seed-8', 30],
  ['seed-8', 90],
  ['full-20', 30],
  ['full-20', 90],
] as const)('%s, %i days at the normal policy', (name, days) => {
  it('has no integrity failures', () => {
    expect(integrityFailures(result(name, days).db)).toEqual([])
  })

  it('submits each pay run that came due once, on its run payroll by day, with its prep', () => {
    const { db, report, from, to } = result(name, days)
    const due = payCalendar(db, from, to).filter((p) => p.cutoff > from && p.cutoff <= to && hasPaidPeople(db, p))
    expect(due.length).toBeGreaterThanOrEqual(Math.floor(days / 16))
    for (const p of due) {
      const runs = (db.company.payRuns ?? []).filter((r) => r.periodStart === p.start && r.periodEnd === p.end)
      expect(runs, p.start).toHaveLength(1)
      expect(runs[0], p.start).toMatchObject({ submittedOn: p.cutoff, payday: p.payday })
    }
    expect(report.payRuns.map((r) => [r.start, r.submittedOn, r.late])).toEqual(due.map((p) => [p.start, p.cutoff, false]))
    expect(report.payRuns.every((r) => r.people > 0 && r.estimatedGross > 0)).toBe(true)
  })

  it('takes time off and hires: requests sent and approved, candidates in, interviews held', () => {
    const { report, trace } = result(name, days)
    expect(report.timeOff.vacation + report.timeOff.sick).toBeGreaterThan(0)
    expect(trace.some((t) => t.action === 'requestTimeOff')).toBe(true)
    expect(report.hiring.candidates).toBeGreaterThan(0)
    expect(report.hiring.interviews + report.hiring.rejected).toBeGreaterThan(0)
    // Every pending request from before the last day was decided.
    const { db, to } = result(name, days)
    expect(db.timeOffRequests.filter((r) => r.status === 'pending' && r.requestedOn < addDays(to, -3))).toEqual([])
  })

  it('acts only on the days it lives through, in date and time order, and leaves the clock on the last day', () => {
    const { trace, from, to } = result(name, days)
    const moments = trace.map((t) => `${t.day} ${t.time}`)
    expect(moments).toEqual([...moments].sort())
    expect(trace.every((t) => t.day > from && t.day <= to)).toBe(true)
    setClockOverride(from)
    const r = advance(company(name), { to: from, seed: 1 })
    expect(r.trace).toEqual([])
    expect(getClockOverride()).toBe(from)
  })
})

describe('the same input', () => {
  it('gives byte-identical JSON when run twice: the workspace, the trace, the report and the summary', () => {
    for (const [name, days] of [
      ['seed-8', 90],
      ['full-20', 30],
    ] as const) {
      const first = result(name, days)
      const second = lived(name, days)
      expect(JSON.stringify(second.db)).toBe(JSON.stringify(first.db))
      expect(traceToJsonLines(second.trace)).toBe(traceToJsonLines(first.trace))
      expect(JSON.stringify(second.report)).toBe(JSON.stringify(first.report))
      expect(second.summary).toBe(first.summary)
    }
  })

  it('tells another story with another seed, and leaves the workspace it started from as it was', () => {
    const before = JSON.stringify(company('seed-8'))
    const other = lived('seed-8', 30, 'another')
    expect(traceToJsonLines(other.trace)).not.toBe(traceToJsonLines(result('seed-8', 30).trace))
    expect(integrityFailures(other.db)).toEqual([])
    expect(JSON.stringify(company('seed-8'))).toBe(before)
  })
})

it('advances full-20 by 90 days quickly (target: under 3 s on CI)', () => {
  result('full-20', 90)
  const { ms } = results.get('full-20 90') as { ms: number }
  console.info(`advance full-20 by 90 days: ${Math.round(ms)} ms`)
  expect(ms).toBeLessThan(10_000)
})
