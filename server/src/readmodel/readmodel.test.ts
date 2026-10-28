// The read model (migration 007_read_model.sql and later read-model migrations) on PGlite: the committed
// migration equals the generator's output, the guarded casts give NULL for bad text, the Ledgerlark sample
// loaded through the real replaceWorkspace reads back as the TypeScript domain sees it, v_integrity_problems
// agrees with src/domain/integrity.ts on every kind of planted problem, and rows never mix between
// workspaces. Date-dependent views read as of the sample's anchor (SET first_twenty.today).
// The store loads first so every seed and domain module finishes loading before the sample is built.
import '@/store/db'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { produce } from 'immer'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import { buildSampleDB } from '@/data/seed'
import { type IntegrityCode, type IntegrityProblem, integrityProblems } from '@/domain/integrity'
import { everydayFlows, FLOWS_DATE, plantAll } from '@/domain/integrityKit'
import { compOrFirst, currentComp } from '@/domain/pay'
import { asDate } from '@/domain/paths'
import { employmentState, fullName, headcountOn } from '@/domain/people'
import type { DB } from '@/domain/types'
import { setClockOverride } from '@/lib/dates'
import { RECORD_COLLECTIONS, tableName } from '../../../src/sync/collections'
import type { Db } from '../db'
import { migrationsDir } from '../migrate'
import { replaceWorkspace } from '../repo'
import { makeTestDb } from '../test/helpers'
import { parseWorkspace } from '../validate'
import { newestReadModelFile, nextReadModelFile, READ_MODEL_COMMAND, READ_MODEL_FILE_RE, readModelDrift, readModelSql, readModelViews } from './generate'
import { READ_MODEL } from './spec'

const ANCHOR = '2026-10-09'
const sample: DB = buildSampleDB()
const { db: plantedDb } = plantAll(sample)
setClockOverride(FLOWS_DATE)
/** Valid data the app's own flows write (a hire who never started, a job opened from the plan, ...). */
const flowsDb = everydayFlows(sample)
setClockOverride(null)
/** Records that are not the shape the types say: every view and the checks must still read them. */
const malformedDb = produce(sample, (d) => {
  const job = d.jobs[0] as unknown as Record<string, unknown>
  job.stages = 'not a list'
  job.interviewPlan = [null, 7, { stageId: 3, interviewerIds: { not: 'a list' } }]
  const app = d.applications[0] as unknown as Record<string, unknown>
  app.history = { not: 'a list' }
  const person = d.people[2] as unknown as Record<string, unknown>
  person.startDate = '2026-02-30'
  person.hireNumber = 'seven'
  person.separation = 'not an object'
  const checklist = d.checklists[0] as unknown as Record<string, unknown>
  checklist.tasks = 42
  d.company.payRuns = [{ periodStart: 'junk', periodEnd: '', payday: '2026-13-01' } as never]
  ;(d as unknown as Record<string, unknown>).complianceStatus = { 'workers-comp': 'not an object' }
  // An offset past 15:59, which Postgres refuses to read as a time.
  d.activity[0].at = '2026-10-09T10:00:00+18:00'
})
/**
 * Pay run records of every kind: Sep 1 to 15 neither submitted nor with totals (not a pay run), Oct 16 to 31
 * with totals only (payroll ran; it was not marked submitted in the app). An offer with changes requested.
 */
const variantsDb = produce(sample, (d) => {
  const runs = d.company.payRuns!
  const sep = runs.find((r) => r.periodStart === '2026-09-01')!
  delete sep.submittedOn
  delete sep.submittedById
  delete sep.totals
  runs.push({ periodStart: '2026-10-16', periodEnd: '2026-10-31', payday: '2026-10-30', totals: { gross: 98000, employerTaxes: 7500, enteredOn: '2026-10-30' } })
  d.offers.find((o) => o.id === 'o-hire-aisha')!.approvals = [
    { approverId: 'p-founder', decision: 'changes_requested', at: '2026-08-20T17:00:00.000Z' },
    { approverId: 'p-founder', decision: 'approved', at: '2026-08-21T17:00:00.000Z' },
  ]
})

/** The sample with `copies` more of every hire: application, person, offers, pay rows and checklists. */
function withHireCopies(base: DB, copies: number): DB {
  return produce(base, (d) => {
    for (const a of base.applications.filter((x) => x.status === 'hired')) {
      const p = base.people.find((x) => x.fromApplicationId === a.id)!
      for (let i = 1; i <= copies; i++) {
        const s = `-copy${i}`
        d.applications.push({ ...a, id: a.id + s })
        d.people.push({ ...p, id: p.id + s, fromApplicationId: a.id + s, hireNumber: p.hireNumber + 1000 * i })
        for (const o of base.offers.filter((x) => x.applicationId === a.id)) d.offers.push({ ...o, id: o.id + s, applicationId: a.id + s, personId: p.id + s })
        for (const c of base.comp.filter((x) => x.personId === p.id)) d.comp.push({ ...c, id: c.id + s, personId: p.id + s })
        for (const c of base.checklists.filter((x) => x.personId === p.id)) d.checklists.push({ ...c, id: c.id + s, personId: p.id + s })
      }
    }
  })
}

let db: Db

async function load(workspaceId: string, data: DB): Promise<void> {
  if (workspaceId !== 'default') {
    await db.query(`INSERT INTO workspaces (id, name, slug, keep) VALUES ($1, $1, $1, true)`, [workspaceId])
  }
  await replaceWorkspace(db, parseWorkspace({ db: data, confirmReplace: true }), null, workspaceId)
}

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T & Record<string, unknown>>(sql, params)).rows
}

beforeAll(async () => {
  db = await makeTestDb()
  await load('default', sample)
  await load('w-planted', plantedDb)
  await load('w-malformed', malformedDb)
  await load('w-flows', flowsDb)
  await load('w-variants', variantsDb)
  await load('w-hires-x4', withHireCopies(sample, 4))
  await load('w-hires-x8', withHireCopies(sample, 8))
  await load('w-blank', blankDB({ companyName: 'Blankco', founderFirstName: 'Bo', founderLastName: 'Lank', foundedOn: '2026-03-02' }))
  await db.exec(`SET first_twenty.today = '${ANCHOR}'`)
})
afterAll(async () => {
  await db.close()
})

describe('the read-model migration', () => {
  it('is exactly what the generator writes', () => {
    expect(readModelDrift(migrationsDir())).toBeNull()
  })

  it('takes the next read-model migration that --write saves, and names the newest file when it drifts', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ft-readmodel-'))
    try {
      cpSync(migrationsDir(), dir, { recursive: true })
      const next = nextReadModelFile(dir)
      expect(next).toMatch(READ_MODEL_FILE_RE)
      expect(next > newestReadModelFile(dir)!).toBe(true)
      writeFileSync(path.join(dir, next), readModelSql())
      expect(readModelDrift(dir)).toBeNull()
      writeFileSync(path.join(dir, next), `${readModelSql()}-- edited by hand\n`)
      expect(readModelDrift(dir)).toContain(`server/sql/${next} differs`)
      expect(readModelDrift(dir)).toContain(READ_MODEL_COMMAND)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stops on Postgres older than 15 before it changes anything', async () => {
    const sql = readModelSql()
    const guard = /DO \$\$\nBEGIN\n {2}IF current_setting\('server_version_num'\)::int < 150000 THEN[\s\S]*?\n\$\$;/.exec(sql)?.[0]
    expect(guard).toBeDefined()
    expect(sql.indexOf(guard!)).toBeLessThan(sql.indexOf('DROP VIEW'))
    await db.exec(guard!)
    await expect(db.exec(guard!.replace("current_setting('server_version_num')::int", '140011'))).rejects.toThrow(/needs Postgres 15 or newer/)
  })

  it('creates every view, each with workspace_id first, security_invoker on and no triggers', async () => {
    const views = await rows<{ relname: string; invoker: boolean }>(
      `SELECT c.relname, coalesce(c.reloptions @> ARRAY['security_invoker=true'], false) AS invoker
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'v' ORDER BY c.relname`,
    )
    expect(views.map((v) => v.relname)).toEqual([...readModelViews()].sort())
    expect(views.filter((v) => !v.invoker)).toEqual([])
    const first = await rows<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND ordinal_position = 1 AND table_name LIKE 'v\\_%'`,
    )
    expect(first.filter((c) => c.column_name !== 'workspace_id')).toEqual([])
    expect(first).toHaveLength(views.length)
    const triggers = await rows(`SELECT tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname LIKE 'v\\_%'`)
    expect(triggers).toEqual([])
  })

  it('reads only the record tables, workspace_docs, workspaces and other views', async () => {
    const used = await rows<{ view: string; used: string }>(
      `SELECT DISTINCT v.relname AS view, t.relname AS used
         FROM pg_class v
         JOIN pg_rewrite rw ON rw.ev_class = v.oid
         JOIN pg_depend d ON d.objid = rw.oid AND d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass
         JOIN pg_class t ON t.oid = d.refobjid
        WHERE v.relkind = 'v' AND v.relname LIKE 'v\\_%' AND t.oid <> v.oid`,
    )
    const allowed = new Set([...RECORD_COLLECTIONS.map(tableName), 'workspace_docs', 'workspaces', ...readModelViews()])
    expect(used.filter((u) => !allowed.has(u.used))).toEqual([])
    expect(used.some((u) => u.used === 'people')).toBe(true)
  })

  it('names every column so it reads without quotes', async () => {
    for (const view of readModelViews()) {
      const cols = await rows<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
        [view],
      )
      expect(cols.length, view).toBeGreaterThan(1)
      await expect(db.query(`SELECT ${cols.map((c) => c.column_name).join(', ')} FROM ${view} LIMIT 1`), view).resolves.toBeDefined()
    }
  })
})

describe('guarded casts', () => {
  it('give NULL for text that is not a date, and agree with asDate', async () => {
    const inputs = ['2026-10-09', '2024-02-29', '2000-02-29', '2026-02-29', '1900-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '2026-00-10', '0000-01-01', '2026-1-9', '2026-10-09T00:00:00Z', ' 2026-10-09', '', 'junk', '٢٠٢٦-١٠-٠٩']
    const got = await rows<{ v: string; d: string | null }>(`SELECT v, ft_as_date(v)::text AS d FROM unnest($1::text[]) AS v`, [inputs])
    expect(Object.fromEntries(got.map((r) => [r.v, r.d]))).toEqual(Object.fromEntries(inputs.map((v) => [v, asDate(v)])))
    expect((await rows<{ d: unknown }>(`SELECT ft_as_date(NULL) AS d`))[0].d).toBeNull()
  })

  it('give NULL for text that is not a number, an integer, a boolean or a timestamp', async () => {
    const [r] = await rows<Record<string, unknown>>(`
      SELECT ft_as_num('185000')::text AS n1, ft_as_num('0.005')::text AS n2, ft_as_num('-3')::text AS n3, ft_as_num('1e-7')::text AS n4,
             ft_as_num('') AS bad1, ft_as_num('abc') AS bad2, ft_as_num('1,000') AS bad3, ft_as_num('NaN') AS bad4, ft_as_num('Infinity') AS bad5,
             ft_as_num('1e99999') AS bad6, ft_as_num(' 5') AS bad7,
             ft_as_int('24') AS i1, ft_as_int('24.0') AS i2, ft_as_int('24.5') AS bad8, ft_as_int('9999999999') AS bad9, ft_as_int('x') AS bad10,
             ft_as_bool('true') AS b1, ft_as_bool('false') AS b2, ft_as_bool('TRUE') AS bad11, ft_as_bool('t') AS bad12,
             ft_as_timestamptz('2026-10-09T17:30:00.000Z') = '2026-10-09 17:30:00+00'::timestamptz AS t1,
             ft_as_timestamptz('2026-10-09T10:30:00-07:00') = '2026-10-09 17:30:00+00'::timestamptz AS t2,
             ft_as_timestamptz('2026-02-30T00:00:00Z') AS bad13, ft_as_timestamptz('2026-10-09') AS bad14,
             ft_as_timestamptz('2026-10-09T25:00:00Z') AS bad15, ft_as_timestamptz('2026-10-09T10:00:00') AS bad16,
             ft_as_timestamptz('2026-10-09T10:00:00+16:00') AS bad17, ft_as_timestamptz('2026-10-09T10:00:00-23:59') AS bad18,
             ft_as_timestamptz('2026-10-09T10:00:00+1600') AS bad19,
             ft_as_timestamptz('2026-10-09T15:59:00+15:59') = '2026-10-09 00:00:00+00'::timestamptz AS t3,
             ft_array('{"a": 1}'::jsonb)::text AS a1, ft_array('[1]'::jsonb)::text AS a2, ft_array(NULL)::text AS a3,
             ft_object('[1]'::jsonb)::text AS o1`)
    expect(r).toMatchObject({ n1: '185000', n2: '0.005', n3: '-3', n4: '0.0000001', i1: 24, i2: 24, b1: true, b2: false, t1: true, t2: true, t3: true, a1: '[]', a2: '[1]', a3: '[]', o1: '{}' })
    for (const [k, v] of Object.entries(r)) if (k.startsWith('bad')) expect(v, k).toBeNull()
  })

  it('are IMMUTABLE where the answer depends only on the text, STABLE where it depends on the session', async () => {
    const fns = await rows<{ proname: string; provolatile: string }>(`SELECT proname, provolatile FROM pg_proc WHERE proname LIKE 'ft\\_%' ORDER BY proname`)
    expect(Object.fromEntries(fns.map((f) => [f.proname, f.provolatile]))).toEqual({
      ft_array: 'i',
      ft_as_bool: 'i',
      ft_as_date: 'i',
      ft_as_int: 'i',
      ft_as_num: 'i',
      ft_as_timestamptz: 's',
      ft_object: 'i',
      ft_today: 's',
    })
  })

  it('let a session read the views as of another day', async () => {
    expect((await rows<{ d: string }>(`SELECT ft_today()::text AS d`))[0].d).toBe(ANCHOR)
    await db.exec(`SET first_twenty.today = 'not a date'`)
    expect((await rows<{ same: boolean }>(`SELECT ft_today() = (now() AT TIME ZONE 'America/Los_Angeles')::date AS same`))[0].same).toBe(true)
    await db.exec(`SET first_twenty.today = '${ANCHOR}'`)
  })

  it("use today's date in Pacific time when no day is set, whatever the session's time zone (the app's own day)", async () => {
    await db.exec(`RESET first_twenty.today; SET TimeZone = 'Pacific/Kiritimati'`)
    try {
      const [r] = await rows<{ d: string; n: Date }>(`SELECT ft_today()::text AS d, now() AS n`)
      const pacific = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(r.n))
      expect(r.d).toBe(pacific)
    } finally {
      await db.exec(`RESET TimeZone; SET first_twenty.today = '${ANCHOR}'`)
    }
  })

  it('read the same whatever the session search_path (the functions name their schema)', async () => {
    await db.exec(`SET search_path = pg_catalog`)
    try {
      for (const view of readModelViews()) {
        await expect(db.query(`SELECT * FROM public.${view} WHERE workspace_id = 'default'`), view).resolves.toBeDefined()
      }
    } finally {
      await db.exec(`RESET search_path`)
    }
  })

  it('keep every view readable over records that are not the shape the types say', async () => {
    for (const view of readModelViews()) {
      await expect(db.query(`SELECT * FROM ${view} WHERE workspace_id = 'w-malformed'`), view).resolves.toBeDefined()
    }
    const [p] = await rows<{ start_date: unknown; hire_number: unknown; separation_type: unknown }>(
      `SELECT start_date, hire_number, separation_type FROM v_people WHERE workspace_id = 'w-malformed' AND id = $1`,
      [malformedDb.people[2].id],
    )
    expect(p).toEqual({ start_date: null, hire_number: null, separation_type: null })
    const [a] = await rows<{ happened_at: unknown }>(`SELECT happened_at FROM v_activity WHERE workspace_id = 'w-malformed' AND id = $1`, [malformedDb.activity[0].id])
    expect(a.happened_at).toBeNull()
    await expect(db.query(`SELECT * FROM v_activity`)).resolves.toBeDefined()
  })
})

describe('the sample, loaded through replaceWorkspace', () => {
  const ws = 'default'

  it('has one row per record in every collection view', async () => {
    for (const view of READ_MODEL) {
      if (view.kind !== 'collection') continue
      const [r] = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM ${view.name} WHERE workspace_id = $1`, [ws])
      expect(r.n, view.name).toBe((sample[view.collection] as unknown[]).length)
    }
    const tasks = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM v_checklist_tasks WHERE workspace_id = $1`, [ws])
    expect(tasks[0].n).toBe(sample.checklists.reduce((n, c) => n + c.tasks.length, 0))
    const moves = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM v_application_stages WHERE workspace_id = $1`, [ws])
    expect(moves[0].n).toBe(sample.applications.reduce((n, a) => n + a.history.length, 0))
  })

  it('reads people with typed columns', async () => {
    const people = await rows<{ id: string; hire_number: number; full_name: string; start_date: string; end_date: string | null; department_name: string; is_founder: boolean | null }>(
      `SELECT id, hire_number, full_name, start_date::text AS start_date, end_date::text AS end_date, department_name, is_founder FROM v_people WHERE workspace_id = $1 ORDER BY hire_number`,
      [ws],
    )
    expect(people).toEqual(
      [...sample.people]
        .sort((a, b) => a.hireNumber - b.hireNumber)
        .map((p) => ({
          id: p.id,
          hire_number: p.hireNumber,
          full_name: fullName(p),
          start_date: p.startDate,
          end_date: p.endDate ?? null,
          department_name: sample.departments.find((d) => d.id === p.departmentId)?.name,
          is_founder: p.isFounder ?? null,
        })),
    )
  })

  it('has no integrity problems', async () => {
    expect(await rows(`SELECT * FROM v_integrity_problems WHERE workspace_id = $1`, [ws])).toEqual([])
  })

  it('has one hire journey per hired application, every step present', async () => {
    const journeys = await rows<Record<string, string | number | null>>(
      `SELECT application_id, job_id, person_id, offer_id, hire_comp_id, onboarding_checklist_id, start_date::text AS start_date,
              first_pay_period_start::text AS first_pay_period_start, onboarding_tasks_total, onboarding_tasks_done
         FROM v_hire_journey WHERE workspace_id = $1 ORDER BY application_id`,
      [ws],
    )
    const hired = sample.applications.filter((a) => a.status === 'hired').sort((a, b) => (a.id < b.id ? -1 : 1))
    expect(journeys.map((j) => j.application_id)).toEqual(hired.map((a) => a.id))
    for (const j of journeys) {
      const app = hired.find((a) => a.id === j.application_id)!
      const person = sample.people.find((p) => p.fromApplicationId === app.id)!
      const checklist = sample.checklists.find((c) => c.personId === person.id && c.kind === 'onboarding')!
      // The pay run whose period holds the start date, when that period is on record.
      const firstRun = (sample.company.payRuns ?? []).find((r) => r.periodStart <= person.startDate && r.periodEnd >= person.startDate)
      expect(j).toEqual({
        application_id: app.id,
        job_id: app.jobId,
        person_id: person.id,
        offer_id: sample.offers.find((o) => o.applicationId === app.id && o.status === 'accepted')!.id,
        hire_comp_id: sample.comp.find((c) => c.personId === person.id && c.reason === 'hire')!.id,
        onboarding_checklist_id: checklist.id,
        start_date: person.startDate,
        first_pay_period_start: firstRun?.periodStart ?? null,
        onboarding_tasks_total: checklist.tasks.length,
        onboarding_tasks_done: checklist.tasks.filter((t) => t.status === 'done').length,
      })
    }
  })

  it("gives a hire's first payday only from the pay run that holds their start date", async () => {
    const first = async (ws: string) =>
      Object.fromEntries(
        (await rows<{ person_id: string; d: string | null }>(`SELECT person_id, first_payday::text AS d FROM v_hire_journey WHERE workspace_id = $1`, [ws])).map((r) => [r.person_id, r.d]),
      )
    // The sample's pay runs on record start on Jul 1, 2026: earlier hires were paid before the app kept them.
    expect(await first(ws)).toMatchObject({ 'p-tomas': null, 'p-jasmine': null, 'p-chris': '2026-07-15', 'p-luis': '2026-07-31', 'p-aisha': '2026-09-15', 'p-lucas': null })
    // A period with totals only counts (payroll ran), one with neither does not; a hire who never started has none.
    expect(await first('w-variants')).toMatchObject({ 'p-aisha': null, 'p-lucas': '2026-10-30' })
    const flows = await rows<{ start_date: string; end_date: string | null; first_payday: unknown }>(
      `SELECT j.start_date::text AS start_date, p.end_date::text AS end_date, j.first_payday FROM v_hire_journey j JOIN v_people p USING (workspace_id) WHERE j.workspace_id = 'w-flows' AND j.person_id = 'p-lucas' AND p.id = j.person_id`,
    )
    expect(flows).toEqual([{ start_date: '2026-10-19', end_date: '2026-10-12', first_payday: null }])
  })

  it('counts stage moves and approvals as their names say', async () => {
    const apps = await rows<{ id: string; stage_moves: number }>(`SELECT id, stage_moves FROM v_applications WHERE workspace_id = $1`, [ws])
    for (const a of apps) expect(a.stage_moves, a.id).toBe(Math.max(0, sample.applications.find((x) => x.id === a.id)!.history.length - 1))
    expect(apps.some((a) => a.stage_moves === 0)).toBe(true)
    const [aisha] = await rows<{ approval_count: number; changes_requested_count: number }>(
      `SELECT approval_count, changes_requested_count FROM v_offers WHERE workspace_id = 'w-variants' AND id = 'o-hire-aisha'`,
    )
    expect(aisha).toEqual({ approval_count: 1, changes_requested_count: 1 })
  })

  it('do work in step with the number of hires, not its square (the journeys stay quick as a company grows)', async () => {
    // The work: every row each step of the plan produced, times the times it ran. Twice the hires should
    // take about twice the work; a step that reads a table once per hire would take about four times.
    const work = async (view: string, ws: string) => {
      const [r] = await rows<{ 'QUERY PLAN': Array<{ Plan: Record<string, unknown> }> }>(`EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM ${view} WHERE workspace_id = '${ws}'`)
      let total = 0
      const walk = (node: Record<string, unknown>) => {
        total += Number(node['Actual Rows']) * Number(node['Actual Loops'])
        for (const child of (node.Plans as Array<Record<string, unknown>> | undefined) ?? []) walk(child)
      }
      walk(r['QUERY PLAN'][0].Plan)
      return total
    }
    for (const view of ['v_current_job', 'v_hire_journey']) {
      const [small, large] = [await work(view, 'w-hires-x4'), await work(view, 'w-hires-x8')]
      expect(large / small, `${view}: ${small} then ${large}`).toBeLessThan(2.5)
      // The workspace filter reaches the tables: a new company's few records take a fraction of the work.
      expect(await work(view, 'w-blank'), view).toBeLessThan(small / 10)
    }
    const [n] = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM v_hire_journey WHERE workspace_id = 'w-hires-x8'`)
    expect(n.n).toBe(9 * sample.applications.filter((a) => a.status === 'hired').length)
  })

  it("gives each person's job, pay and state today as the domain does", async () => {
    const current = await rows<{ id: string; title: string; salary: string | null; hourly_rate: string | null; comp_id: string | null; employment_state: string }>(
      `SELECT id, title, salary::text AS salary, hourly_rate::text AS hourly_rate, comp_id, employment_state FROM v_current_job WHERE workspace_id = $1`,
      [ws],
    )
    expect(current).toHaveLength(sample.people.length)
    for (const row of current) {
      const p = sample.people.find((x) => x.id === row.id)!
      const comp = currentComp(sample, p.id, ANCHOR)
      expect(row, p.id).toEqual({
        id: p.id,
        title: comp?.title ?? p.title,
        salary: comp?.salary != null ? String(comp.salary) : null,
        hourly_rate: comp?.hourlyRate != null ? String(comp.hourlyRate) : null,
        comp_id: comp?.id ?? null,
        employment_state: employmentState(p, ANCHOR, sample),
      })
    }
    // Incoming hires have no pay row in effect yet; their first one is waiting.
    const incoming = current.filter((r) => r.employment_state === 'incoming')
    for (const r of incoming) expect(compOrFirst(sample, r.id, ANCHOR)).toBeDefined()
  })

  it('counts the pipeline per job and stage as the applications say', async () => {
    const funnel = await rows<{ job_id: string; stage_id: string; stage_position: number; in_stage: number; active: number; hired: number; reached: number }>(
      `SELECT job_id, stage_id, stage_position, in_stage, active, hired, reached FROM v_pipeline_funnel WHERE workspace_id = $1`,
      [ws],
    )
    expect(funnel).toHaveLength(sample.jobs.reduce((n, j) => n + j.stages.length, 0))
    for (const row of funnel) {
      const job = sample.jobs.find((j) => j.id === row.job_id)!
      const apps = sample.applications.filter((a) => a.jobId === job.id)
      expect(row, `${row.job_id} ${row.stage_id}`).toEqual({
        job_id: job.id,
        stage_id: row.stage_id,
        stage_position: job.stages.findIndex((s) => s.id === row.stage_id) + 1,
        in_stage: apps.filter((a) => a.stageId === row.stage_id).length,
        active: apps.filter((a) => a.stageId === row.stage_id && a.status === 'active').length,
        hired: apps.filter((a) => a.stageId === row.stage_id && a.status === 'hired').length,
        reached: apps.filter((a) => a.history.some((h) => h.stageId === row.stage_id)).length,
      })
    }
  })

  it('counts headcount at each month end as headcountOn does, from the first start to the last date', async () => {
    const months = await rows<{ month: string; month_end: string; headcount: number; starts: number }>(
      `SELECT month::text AS month, month_end::text AS month_end, headcount, starts FROM v_headcount_by_month WHERE workspace_id = $1 ORDER BY month`,
      [ws],
    )
    const founder = [...sample.people].sort((a, b) => a.startDate.localeCompare(b.startDate))[0]
    expect(months[0].month).toBe(`${founder.startDate.slice(0, 7)}-01`)
    // The latest date on record: a last day in November 2026 (after the anchor).
    expect(months.at(-1)!.month).toBe('2026-11-01')
    for (let i = 1; i < months.length; i++) expect(months[i].month > months[i - 1].month).toBe(true)
    expect(months.reduce((n, m) => n + m.starts, 0)).toBe(sample.people.length)
    for (const m of months) expect(m.headcount, m.month).toBe(headcountOn(sample, m.month_end))
  })

  it('answers every ready-made query in server/deploy/browse.sql', async () => {
    const statements = readFileSync(path.join(migrationsDir(), '..', 'deploy', 'browse.sql'), 'utf8')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((l) => !l.startsWith('--'))
      .join('\n')
      .split(';')
      .map((x) => x.trim())
      .filter(Boolean)
    const answers = new Map<string, number>()
    for (const sql of statements) {
      const r = await db.query(sql)
      answers.set(sql, r.rows.length)
    }
    const count = (from: string) => [...answers].find(([sql]) => sql.includes(`FROM ${from} `))?.[1]
    expect(count('v_hire_journey')).toBe(sample.applications.filter((a) => a.status === 'hired').length)
    expect(count('v_current_job')).toBe(sample.people.length)
    expect(count('v_pay_runs')).toBe(sample.company.payRuns?.length)
    expect(count('v_integrity_problems')).toBe(0)
  })

  it('lists the pay runs from the company document', async () => {
    const runs = await rows<{ ordinal: number; period_start: string; payday: string; submitted_by_id: string; people_in_period: number }>(
      `SELECT ordinal, period_start::text AS period_start, payday::text AS payday, submitted_by_id, people_in_period FROM v_pay_runs WHERE workspace_id = $1 ORDER BY ordinal`,
      [ws],
    )
    expect(runs.map((r) => [r.period_start, r.payday, r.submitted_by_id])).toEqual((sample.company.payRuns ?? []).map((r) => [r.periodStart, r.payday, r.submittedById]))
    for (const r of runs) {
      const run = sample.company.payRuns![r.ordinal - 1]
      expect(r.people_in_period).toBe(sample.people.filter((p) => p.startDate <= run.periodEnd && (!p.endDate || p.endDate >= run.periodStart)).length)
    }
  })
})

type Tuple = [string, string, string, string, string, string | null]
const tupleOf = (p: IntegrityProblem): Tuple => [p.code, p.severity, p.collection, p.recordId, p.field, p.otherId]
const byTuple = (a: Tuple, b: Tuple) => (a.join('\u0000') < b.join('\u0000') ? -1 : 1)

async function sqlProblems(workspaceId: string): Promise<Tuple[]> {
  const r = await rows<{ code: string; severity: string; collection: string; record_id: string; field: string; other_id: string | null }>(
    `SELECT code, severity, collection, record_id, field, other_id FROM v_integrity_problems WHERE workspace_id = $1`,
    [workspaceId],
  )
  return r.map((x): Tuple => [x.code, x.severity, x.collection, x.record_id, x.field, x.other_id]).sort(byTuple)
}

describe('v_integrity_problems and integrityProblems', () => {
  it('report the same problems for every kind planted', async () => {
    const ts = integrityProblems(plantedDb).map(tupleOf).sort(byTuple)
    expect(await sqlProblems('w-planted')).toEqual(ts)
    // Every code turns up, except duplicate_id, which only a browser can hold (the server refuses it).
    const codes: IntegrityCode[] = [
      'broken_reference',
      'self_reference',
      'unknown_stage',
      'unknown_step',
      'not_on_panel',
      'stage_history_mismatch',
      'history_out_of_order',
      'mismatched_link',
      'hire_missing_person',
      'hire_missing_offer',
      'hire_missing_comp',
      'hire_missing_checklist',
      'date_order',
      'duplicate_value',
      'manager_leaving',
    ]
    expect([...new Set(ts.map((t) => t[0]))].sort()).toEqual([...codes].sort())
  })

  it('agree that the everyday flows leave nothing to report', async () => {
    expect(integrityProblems(flowsDb)).toEqual([])
    expect(await sqlProblems('w-flows')).toEqual([])
  })

  it('agree on records that are not the shape the types say', async () => {
    const ts = integrityProblems(malformedDb).map(tupleOf).sort(byTuple)
    expect(ts.length).toBeGreaterThan(0)
    expect(await sqlProblems('w-malformed')).toEqual(ts)
  })

  it('agree on a new company with nothing in it yet', async () => {
    const blank = blankDB({ companyName: 'Blankco', founderFirstName: 'Bo', founderLastName: 'Lank', foundedOn: '2026-03-02' })
    expect(await sqlProblems('w-blank')).toEqual(integrityProblems(blank).map(tupleOf).sort(byTuple))
  })
})

describe('several companies on one server', () => {
  it('never mix rows: each workspace reads only its own records, though the ids are the same', async () => {
    for (const view of READ_MODEL) {
      if (view.kind !== 'collection') continue
      const counts = await rows<{ workspace_id: string; n: number }>(`SELECT workspace_id, count(*)::int AS n FROM ${view.name} GROUP BY workspace_id`)
      const byWs = Object.fromEntries(counts.map((c) => [c.workspace_id, c.n]))
      expect(byWs.default ?? 0, view.name).toBe((sample[view.collection] as unknown[]).length)
      expect(byWs['w-planted'] ?? 0, view.name).toBe((plantedDb[view.collection] as unknown[]).length)
    }
    // The planted copy has the same ids with different values; a join across workspaces would show them here.
    const [kofi] = await rows<{ manager_id: string }>(`SELECT manager_id FROM v_current_job WHERE workspace_id = 'default' AND id = 'p-kofi'`)
    expect(kofi.manager_id).toBe(sample.people.find((p) => p.id === 'p-kofi')!.managerId)
    const journeys = await rows<{ workspace_id: string; n: number; people: number }>(
      `SELECT workspace_id, count(*)::int AS n, count(person_id)::int AS people FROM v_hire_journey GROUP BY workspace_id ORDER BY workspace_id`,
    )
    const hired = sample.applications.filter((a) => a.status === 'hired').length
    expect(journeys.find((j) => j.workspace_id === 'default')).toEqual({ workspace_id: 'default', n: hired, people: hired })
    expect(journeys.find((j) => j.workspace_id === 'w-planted')).toEqual({ workspace_id: 'w-planted', n: hired + 1, people: hired })
    const funnel = await rows<{ workspace_id: string; n: number }>(`SELECT workspace_id, sum(in_stage)::int AS n FROM v_pipeline_funnel GROUP BY workspace_id`)
    expect(funnel.find((f) => f.workspace_id === 'default')?.n).toBe(sample.applications.length)
    const months = await rows<{ headcount: number; month_end: string }>(
      `SELECT headcount, month_end::text AS month_end FROM v_headcount_by_month WHERE workspace_id = 'default'`,
    )
    for (const m of months) expect(m.headcount).toBe(headcountOn(sample, m.month_end))
    const blank = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM v_people WHERE workspace_id = 'w-blank'`)
    expect(blank[0].n).toBe(1)
  })
})
