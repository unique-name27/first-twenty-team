// The simulator's smoke test (docs/DEV.md, "Simulate a company"): every browser scenario is generated, loaded
// into the server through replaceWorkspace as the app's Import loads a company, advanced 90 days at the normal
// policy and loaded again. Then the read model finds no integrity problem and one hire journey per hire, the
// server gives back exactly what was loaded, and the same run gives the same JSON twice.
//
// stress is generated and loaded once, with no advance, to prove the server takes a company that size. It
// runs only with SIM_STRESS=1 (SIM_STRESS=1 npx vitest run server/src/sim/smoke.test.ts -t stress): it has
// not yet been timed on any computer, so it stays out of the required CI check until it has been.
//
// 90 days from the scenarios' as-of date (2026-10-09) end on 2027-01-07, a week past the law tables' year, so
// the advance passes allowStaleLaw: those days run on the 2026 values, as for a company that has not yet
// reviewed Settings > Rules and rates in January. The holiday list already covers 2027.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DB } from '@/domain/types'
import { addDays, getClockOverride, setClockOverride } from '@/lib/dates'
import { advance } from '@/sim/advance'
import { generateCompany } from '@/sim/generate'
import { SCENARIO_NAMES, SCENARIOS, type ScenarioName } from '@/sim/scenarios'
import type { Db } from '../db'
import { replaceWorkspace, snapshot } from '../repo'
import { WORKSPACE_ID } from '../sqlgen'
import { makeTestDb, resetDb } from '../test/helpers'
import { parseWorkspace } from '../validate'

const BROWSER = SCENARIO_NAMES.filter((n) => SCENARIOS[n].target === 'browser')
const DAYS = 90

let db: Db

beforeAll(async () => {
  db = await makeTestDb()
}, 60_000)
afterAll(async () => {
  await db?.close()
})

/** A scenario generated and advanced 90 days at the normal policy, as JSON text (what the server and a browser receive). */
function simulate(name: ScenarioName): { generated: string; advanced: string; hires: number } {
  const g = generateCompany({ scenario: name })
  const asOf = SCENARIOS[name].asOf
  const previous = getClockOverride()
  setClockOverride(asOf)
  try {
    const a = advance(g.db, { to: addDays(asOf, DAYS), seed: `smoke ${name}`, policy: 'normal', allowStaleLaw: true })
    return { generated: JSON.stringify(g.db), advanced: JSON.stringify(a.db), hires: a.db.applications.filter((x) => x.status === 'hired').length }
  } finally {
    setClockOverride(previous)
  }
}

async function load(json: string): Promise<void> {
  await replaceWorkspace(db, parseWorkspace({ db: JSON.parse(json), confirmReplace: true }), null, WORKSPACE_ID)
}

async function integrityProblems(): Promise<unknown[]> {
  return (await db.query('SELECT severity, code, collection, record_id, field, other_id FROM v_integrity_problems WHERE workspace_id = $1', [WORKSPACE_ID])).rows
}

describe('the simulator, through the server', () => {
  for (const name of BROWSER) {
    it(`${name}: loads, advances ${DAYS} days, loads again, and the read model agrees`, async () => {
      await resetDb(db)
      const run = simulate(name)

      await load(run.generated)
      expect(await integrityProblems(), 'as generated').toEqual([])
      await load(run.advanced)
      expect(await integrityProblems(), `after ${DAYS} days`).toEqual([])

      const journeys = (await db.query<{ person_id: string | null; offer_id: string | null }>('SELECT person_id, offer_id FROM v_hire_journey WHERE workspace_id = $1', [WORKSPACE_ID])).rows
      expect(journeys).toHaveLength(run.hires)
      if (SCENARIOS[name].kind !== 'blank') expect(run.hires).toBeGreaterThan(0)
      expect(journeys.filter((j) => !j.person_id || !j.offer_id)).toEqual([])

      // The server gives back exactly what was loaded.
      const snap = await snapshot(db, WORKSPACE_ID)
      expect(snap?.db).toEqual(JSON.parse(run.advanced) as DB)

      // The same scenario, seed and policy: the same JSON.
      const again = simulate(name)
      expect(again.generated === run.generated, 'generated twice').toBe(true)
      expect(again.advanced === run.advanced, 'advanced twice').toBe(true)
    }, 180_000)
  }

  it.runIf(process.env.SIM_STRESS === '1')('stress: the server takes it whole', async () => {
    await resetDb(db)
    const g = generateCompany({ scenario: 'stress' })
    await load(JSON.stringify(g.db))
    const counts = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM candidates WHERE workspace_id = $1', [WORKSPACE_ID])).rows[0]
    expect(g.db.candidates.length).toBeGreaterThan(2000)
    expect(counts.n).toBe(g.db.candidates.length)
  }, 300_000)
})
