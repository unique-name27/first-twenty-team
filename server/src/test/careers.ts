// What the careers tests share (server/src/careers/routes.test.ts and apply.test.ts): one in-memory
// database per test file holding three companies (acme, other-co and empty-co), put back as they were
// before each test, and a fresh careers app over it. A test file calls useCareers() once at its top, then
// uses db and app (both are ready before each test) and the helpers below.
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, beforeEach, expect } from 'vitest'
import { careerJobs, jobAddress } from '../../../src/careers/render'
import { buildSampleDB, SAMPLE_ANCHOR } from '../../../src/data/seed'
import type { DB } from '../../../src/domain/types'
import type { ApplyRateLimiter } from '../careers/limits'
import { CAREERS_REFERRER_POLICY, registerCareers } from '../careers/routes'
import { testConfig } from '../config'
import { CAREERS_CSP } from '../csp'
import type { Db } from '../db'
import { replaceWorkspace } from '../repo'
import { parseWorkspace } from '../validate'
import { makeTestDb, resetDb, saveRows } from './helpers'

export const HOST = 'careers.test'
export const NOW = new Date(`${SAMPLE_ANCHOR}T19:00:00.000Z`) // noon in California on the sample's own day
export const config = testConfig({ careersHosts: [HOST, 'jobs.test'], careersOrigin: `https://${HOST}`, publicOrigin: 'https://hr.test', secureCookies: true })
export const ADDRESS = '203.0.113.7'

/** The test file's database. */
export let db: Db
/** This test's careers app over db. */
export let app: FastifyInstance
let restoreRows: () => Promise<void>

/** Sets up db and app for every test in the file. */
export function useCareers(): void {
  beforeAll(async () => {
    db = await makeTestDb()
    // The companies every test starts from, set up once (loading the sample takes a while) and put back
    // before each test, so every test still starts from the same rows.
    await resetDb(db)
    await addCompany('w-acme', 'acme', sample())
    await addCompany('w-other', 'other-co', otherCo())
    await addCompany('w-empty', 'empty-co', null)
    restoreRows = await saveRows(db)
  })
  afterAll(async () => {
    await db.close()
  })
  beforeEach(async () => {
    await restoreRows()
    app = await careersApp()
  })
}

export const sample = (): DB => structuredClone(buildSampleDB()) as DB

/** Another company: the sample under another name, with its own job titles. */
export function otherCo(): DB {
  const db = sample()
  db.company.name = 'Otherco'
  for (const j of db.jobs) j.title = `Other ${j.title}`
  return db
}

/** A demo company (careers page on, as a sign-up leaves it), or with `careers: false` one whose page is off. */
export async function addCompany(id: string, slug: string, data: DB | null, opts: { careers?: boolean; keep?: boolean } = {}): Promise<void> {
  await db.query('INSERT INTO workspaces (id, name, slug, keep, careers) VALUES ($1, $2, $3, $4, $5)', [
    id,
    data?.company.name ?? slug,
    slug,
    opts.keep ?? false,
    opts.careers ?? true,
  ])
  if (data) await replaceWorkspace(db, parseWorkspace({ db: data }), null, id)
}

export async function careersApp(limiter?: ApplyRateLimiter, opts: { db?: Db; now?: () => Date } = {}): Promise<FastifyInstance> {
  const a = Fastify({ logger: false })
  await registerCareers(a, { db: opts.db ?? db, config, now: opts.now ?? (() => NOW), ...(limiter ? { limiter } : {}) })
  await a.ready()
  return a
}

export const jobs = careerJobs(buildSampleDB(), SAMPLE_ANCHOR)
export const job = jobs[0]
export const jobPath = `/acme/jobs/${jobAddress(job)}`
export const otherJobs = careerJobs(otherCo(), SAMPLE_ANCHOR)
export const otherJobPath = `/other-co/jobs/${jobAddress(otherJobs[0])}`

export function get(url: string, headers: Record<string, string> = {}, a = app) {
  return a.inject({ method: 'GET', url, headers: { host: HOST, ...headers } })
}

export const FORM = { name: 'Rosa Alvarez', email: 'rosa@example.com', phone: '408 555 0134', link: 'linkedin.com/in/rosa', answer: 'I rebuilt our close checklist and cut it from nine days to five.', website: '' }

export function apply(url: string, form: Record<string, string> = FORM, headers: Record<string, string> = {}, remoteAddress = ADDRESS, a = app) {
  return a.inject({
    method: 'POST',
    url,
    headers: { host: HOST, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin', origin: `https://${HOST}`, ...headers },
    payload: new URLSearchParams(form).toString(),
    remoteAddress,
  })
}

export async function count(sql: string, params: unknown[] = []): Promise<number> {
  return Number((await db.query<{ n: unknown }>(sql, params)).rows[0].n)
}

export const logRows = (workspaceId: string) => count('SELECT count(*) AS n FROM change_log WHERE workspace_id = $1', [workspaceId])

export function expectCareersHeaders(res: LightMyRequestResponse) {
  expect(res.headers['x-content-type-options']).toBe('nosniff')
  expect(res.headers['x-robots-tag']).toBe('noindex, nofollow')
  expect(res.headers['referrer-policy']).toBe(CAREERS_REFERRER_POLICY)
  expect(res.headers['content-security-policy']).toBe(CAREERS_CSP)
  expect(res.headers['set-cookie']).toBeUndefined()
}
