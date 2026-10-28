// Generated companies: the same JSON every time for the same scenario and seed, valid by the shared
// integrity checks, small enough for a browser and the demo caps, built only through the hiring path, each
// scenario what it says it is, and summed up the way the committed summaries in src/sim/summaries say.
// Every browser scenario is generated here; stress is server only and never generated in this tier.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildSampleDB } from '@/data/seed'
import { integrityProblems } from '@/domain/integrity'
import { periodContaining } from '@/domain/payrun'
import { employedOn, headcountOn } from '@/domain/people'
import type { DB } from '@/domain/types'
import { addDays, getClockOverride, setClockOverride } from '@/lib/dates'
import { DOC_KEYS, RECORD_COLLECTIONS } from '@/sync/collections'
import { ACTIONS, traceToJsonLines } from './actions'
import { type GeneratedCompany, generateCompany, lawCoverage } from './generate'
import { SCENARIO_NAMES, SCENARIOS, type ScenarioName } from './scenarios'

const SUMMARIES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'summaries')
const BROWSER = SCENARIO_NAMES.filter((n) => SCENARIOS[n].target === 'browser')
const GENERATED = BROWSER.filter((n) => SCENARIOS[n].kind === 'company')

/**
 * The demo workspace caps (server/src/validate.ts LIMITS, which tests in this tier may not import): records
 * in all collections, bytes of record and document JSON, and one record's JSON. A browser scenario also
 * stays under about 2 MB in all, so it loads quickly.
 */
const CAPS = { records: 20_000, bytes: 16 * 1024 * 1024, recordBytes: 64 * 1024, browserBytes: 2_000_000 }

const cache = new Map<ScenarioName, GeneratedCompany>()
function generated(name: ScenarioName): GeneratedCompany {
  let g = cache.get(name)
  if (!g) {
    g = generateCompany({ scenario: name })
    cache.set(name, g)
  }
  return g
}

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8')

describe.each(BROWSER)('%s', (name) => {
  it('gives byte-identical JSON when generated twice: the workspace, the trace and the summary', () => {
    const first = generated(name)
    const second = generateCompany({ scenario: name })
    expect(JSON.stringify(second.db)).toBe(JSON.stringify(first.db))
    expect(traceToJsonLines(second.trace)).toBe(traceToJsonLines(first.trace))
    expect(second.summary).toBe(first.summary)
  })

  it('has no integrity failures (and a generated company not even a note)', () => {
    const problems = integrityProblems(generated(name).db)
    expect(problems.filter((p) => p.severity === 'failure')).toEqual([])
    if (SCENARIOS[name].kind === 'company') expect(problems).toEqual([])
  })

  it('fits a browser and the demo caps', () => {
    const { db } = generated(name)
    const records = RECORD_COLLECTIONS.flatMap((c) => db[c] as unknown[])
    const docs = DOC_KEYS.map((k) => db[k])
    expect(records.length).toBeLessThanOrEqual(CAPS.records)
    expect(Math.max(...records.map(bytes))).toBeLessThanOrEqual(CAPS.recordBytes)
    expect(records.reduce<number>((n, r) => n + bytes(r), 0) + docs.reduce<number>((n, d) => n + bytes(d), 0)).toBeLessThanOrEqual(CAPS.bytes)
    expect(bytes(db)).toBeLessThan(CAPS.browserBytes)
  })

  it('matches its committed summary', () => {
    const { summary } = generated(name)
    const file = path.join(SUMMARIES, `${name}.txt`)
    if (process.env.SIM_WRITE_SUMMARIES === '1') writeFileSync(file, summary)
    let committed = ''
    try {
      committed = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    } catch {
      // Missing: the comparison below fails with the instructions.
    }
    expect(
      summary,
      `The ${name} company changed (src/sim/summaries/${name}.txt). If that is on purpose, write the new summaries with ` +
        '`SIM_WRITE_SUMMARIES=1 npx vitest run src/sim/generate.test.ts` and commit them with the change.',
    ).toBe(committed)
  })

  it('acts only up to the as-of date, in date and time order', () => {
    const { trace, asOf } = generated(name)
    const moments = trace.map((t) => `${t.day} ${t.time}`)
    expect(moments).toEqual([...moments].sort())
    expect(trace.every((t) => t.day <= asOf && t.action in ACTIONS)).toBe(true)
  })
})

describe.each(GENERATED)('%s, generated', (name) => {
  it('brings every employee in through the hiring pipeline, whole', () => {
    const { db } = generated(name)
    const hires = db.people.filter((p) => !p.isFounder)
    expect(hires.length).toBeGreaterThan(0)
    for (const p of hires) {
      const app = db.applications.find((a) => a.id === p.fromApplicationId)
      const offer = db.offers.find((o) => o.personId === p.id)
      expect(app, p.id).toMatchObject({ candidateId: p.fromCandidateId, status: 'hired' })
      expect(db.candidates.some((c) => c.id === p.fromCandidateId)).toBe(true)
      expect(offer, p.id).toMatchObject({ applicationId: app?.id, status: 'accepted', sentOn: expect.any(String) })
      expect(db.interviews.filter((i) => i.applicationId === app?.id && i.status === 'completed').length, p.id).toBeGreaterThanOrEqual(3)
      expect(db.comp.filter((c) => c.personId === p.id && c.reason === 'hire'), p.id).toHaveLength(1)
      expect(db.checklists.some((c) => c.personId === p.id && c.kind === 'onboarding'), p.id).toBe(true)
      expect(db.documents.some((d) => d.personId === p.id && d.type === 'offer_letter'), p.id).toBe(true)
      expect(db.activity.some((a) => a.entityId === p.id && a.kind === 'hired'), p.id).toBe(true)
      // A grant exactly when the offer had options.
      expect(db.grants.some((g) => g.fromOfferId === offer?.id && g.personId === p.id), p.id).toBe((offer?.equityShares ?? 0) > 0)
      expect(db.plan.some((s) => s.personId === p.id && s.status === 'filled' && s.jobId === app?.jobId), p.id).toBe(true)
    }
    // Every job came from a plan line and has the hiring manager on its panel.
    for (const j of db.jobs) {
      expect(db.plan.find((s) => s.id === j.planSlotId)?.jobId, j.id).toBe(j.id)
      expect(j.panelIds).toContain(j.hiringManagerId)
    }
  })

  it('marks every pay run submitted from the first payroll, and finishes the tasks due by the as-of date', () => {
    const { db, asOf } = generated(name)
    const runs = (db.company.payRuns ?? []).filter((r) => r.submittedOn)
    expect(runs.length).toBeGreaterThan(20)
    expect(db.company.firstPayrollOn).toBe(periodContaining(db, db.company.foundedOn).payday)
    expect(runs.every((r) => r.submittedOn && r.submittedOn <= asOf)).toBe(true)
    const open = db.checklists.flatMap((c) => c.tasks.filter((t) => t.status === 'open' && t.dueOn <= asOf).map((t) => `${c.kind}: ${t.title}`))
    expect(open).toEqual([])
  })
})

/** People working on a date: started, not past their last day. */
const working = (db: DB, date: string) => employedOn(db, date).length

describe('each scenario is what it says', () => {
  it('ledgerlark is buildSampleDB exactly, with no actions', () => {
    const g = generated('ledgerlark')
    expect(JSON.stringify(g.db)).toBe(JSON.stringify(buildSampleDB()))
    expect(g.trace).toEqual([])
  })

  it('blank is a solo founder on the as-of date and nothing else', () => {
    const { db, trace, asOf } = generated('blank')
    expect(db.people.map((p) => [p.isFounder, p.startDate])).toEqual([[true, asOf]])
    expect([db.jobs, db.candidates, db.comp, db.activity, trace]).toEqual([[], [], [], [], []])
    expect(db.meta.createdOn).toBe(asOf)
  })

  it('seed-8 has 8 people and one job open with candidates part way through', () => {
    const { db, asOf } = generated('seed-8')
    expect(headcountOn(db, asOf)).toBe(8)
    const open = db.jobs.filter((j) => j.status === 'open')
    expect(open).toHaveLength(1)
    expect(db.applications.filter((a) => a.jobId === open[0].id && a.status === 'active').length).toBeGreaterThan(3)
  })

  it('cross-15 reaches 15 employees in the last two weeks, and Admin approves the offers managers draft', () => {
    const { db, asOf } = generated('cross-15')
    expect(headcountOn(db, asOf)).toBe(15)
    expect(headcountOn(db, addDays(asOf, -14))).toBe(14)
    const byManagers = db.offers.filter((o) => o.draftedByRole === 'manager')
    expect(byManagers.length).toBeGreaterThan(3)
    for (const o of byManagers.filter((x) => x.status === 'accepted')) expect(o.approvals).toMatchObject([{ approverId: 'p-founder', decision: 'approved' }])
    expect(db.people.filter((p) => p.locationId === 'loc-oakland').length).toBeGreaterThan(0)
  })

  it('full-20 has 20 people, every one hired through the pipeline, and no job open', () => {
    const { db, asOf } = generated('full-20')
    expect(headcountOn(db, asOf)).toBe(20)
    expect(db.people.filter((p) => !p.isFounder && p.fromApplicationId)).toHaveLength(19)
    expect(db.jobs.filter((j) => j.status === 'open')).toEqual([])
    const cs = db.departments.find((d) => d.id === 'd-cs')
    expect(db.people.filter((p) => p.departmentId === 'd-cs').map((p) => p.id)).toContain(cs?.headId)
    expect(db.bands.find((b) => b.id === 'b-eng-l3')).toMatchObject({ min: 185_000, mid: 210_000, max: 235_000 })
    expect(db.levels.find((l) => l.id === 'lv-l6')).toMatchObject({ code: 'L6', order: 6 })
  })

  /** payroll-edge's cases: hourly staff, and a start, a leave and a last day inside pay periods. Returns the latest start. */
  function payrollEdgeCases(g: GeneratedCompany): string {
    const { db, asOf } = g
    const people = employedOn(db, asOf)
    expect(people.filter((p) => p.employmentType === 'part_time' && p.flsa === 'non_exempt').map((p) => p.hoursPerWeek)).toEqual([24])
    expect(people.filter((p) => p.employmentType === 'full_time' && p.flsa === 'non_exempt')).toHaveLength(1)
    const hourlyPay = db.comp.filter((c) => c.reason === 'hire' && c.payType === 'hourly')
    expect(hourlyPay).toHaveLength(2)
    const midPeriod = (d: string) => {
      const p = periodContaining(db, d)
      return d > p.start && d < p.end
    }
    const latest = [...people].sort((a, b) => (a.startDate < b.startDate ? 1 : -1))[0]
    expect(midPeriod(latest.startDate)).toBe(true)
    const leave = db.leaveCases.find((l) => !l.returnedOn)
    expect(leave && midPeriod(leave.startDate) && leave.startDate <= asOf && (leave.expectedReturn ?? '') > asOf).toBe(true)
    const gone = db.people.filter((p) => p.separation)
    expect(gone.map((p) => p.separation?.type)).toEqual(['terminated'])
    expect(midPeriod(gone[0].separation?.lastDay as string)).toBe(true)
    expect(working(db, asOf)).toBe(6)
    return latest.startDate
  }

  it('payroll-edge has hourly staff, a hire mid period, a leave and a termination inside pay periods', () => {
    expect(payrollEdgeCases(generated('payroll-edge'))).toBe('2026-09-23')
  })

  it('payroll-edge keeps those cases inside pay periods as of another date, as reset generates it', () => {
    const later = generateCompany({ scenario: 'payroll-edge', asOf: '2026-10-23' })
    expect(payrollEdgeCases(later)).toBe('2026-10-08')
    expect(integrityProblems(later.db)).toEqual([])
  })

  it('pipeline-heavy has about 300 candidates and three jobs open with full pipelines', () => {
    const { db } = generated('pipeline-heavy')
    expect(db.candidates.length).toBeGreaterThanOrEqual(280)
    expect(db.candidates.length).toBeLessThanOrEqual(340)
    const open = db.jobs.filter((j) => j.status === 'open')
    expect(open).toHaveLength(3)
    for (const j of open) expect(db.applications.filter((a) => a.jobId === j.id && a.status === 'active').length).toBeGreaterThanOrEqual(10)
  })

  it('stress is for the server only, and never generated here', () => {
    expect(SCENARIOS.stress.target).toBe('server')
    expect(BROWSER).not.toContain('stress')
  })

  it('a different seed gives a different company, just as valid', () => {
    const other = generateCompany({ scenario: 'seed-8', seed: 1 })
    expect(other.db.people.map((p) => p.lastName)).not.toEqual(generated('seed-8').db.people.map((p) => p.lastName))
    expect(headcountOn(other.db, other.asOf)).toBe(8)
    expect(integrityProblems(other.db)).toEqual([])
  })
})

describe('the dates the rules cover', () => {
  it('runs from the first holiday on the list to the end of the law tables year', () => {
    expect(lawCoverage()).toEqual({ from: '2025-01-01', to: '2026-12-31' })
  })

  it('refuses an as-of date past them unless allowStaleLaw is passed', () => {
    expect(() => generateCompany({ scenario: 'blank', asOf: '2027-01-04' })).toThrow(
      'The as-of date 2027-01-04 is after the dates the built-in rules cover (2025-01-01 to 2026-12-31: the 2026 law tables and the holiday list). Pass allowStaleLaw to generate it anyway.',
    )
    expect(generateCompany({ scenario: 'blank', asOf: '2027-01-04', allowStaleLaw: true }).db.company.foundedOn).toBe('2027-01-04')
  })

  it('refuses a company founded before them', () => {
    expect(() => generateCompany({ scenario: 'seed-8', asOf: '2026-03-02' })).toThrow('seed-8 as of 2026-03-02 would be founded on 2024-08-02, before the dates the built-in rules cover')
  })

  it('leaves the clock as it found it', () => {
    setClockOverride('2026-05-05')
    generateCompany({ scenario: 'blank' })
    expect(getClockOverride()).toBe('2026-05-05')
    expect(() => generateCompany({ scenario: 'blank', asOf: '2027-01-04' })).toThrow()
    expect(getClockOverride()).toBe('2026-05-05')
    setClockOverride(null)
  })

  it('refuses a ledgerlark that is not the sample, and an as-of date that is not a date', () => {
    expect(() => generateCompany({ scenario: 'ledgerlark', asOf: '2026-10-16' })).toThrow('ledgerlark is the sample exactly as buildSampleDB builds it')
    expect(() => generateCompany({ scenario: 'blank', asOf: '2026-02-30' })).toThrow("The as-of date is a date written YYYY-MM-DD, not '2026-02-30'.")
  })
})
