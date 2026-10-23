// The live careers pages (routes.ts), in-memory PGlite + app.inject() with Host headers: careers hosts
// only, pages from each company's own records (when its careers page is on), every value escaped, strict
// headers and no cookies, stable job addresses, and the apply form writing a candidate and an application
// through the sync write path into that company's change log and no other, within its limits, which hold
// against bursts and say nothing about who applied before.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { careerJobs, jobAddress } from '../../../src/careers/render'
import { buildSampleDB, SAMPLE_ANCHOR } from '../../../src/data/seed'
import type { DB } from '../../../src/domain/types'
import { buildApp } from '../app'
import { testConfig } from '../config'
import { CAREERS_CSP } from '../csp'
import type { Db } from '../db'
import { applyChanges, changesSince, replaceWorkspace, snapshot } from '../repo'
import { createAdmin, makeTestDb, resetDb } from '../test/helpers'
import { LIMITS, parseChanges, parseWorkspace } from '../validate'
import { LOAD_BUDGET, loadCareersDb, MAX_LISTED_JOBS } from './data'
import { ApplyRateLimiter } from './limits'
import { APPLIED_PROOF_MS, APPLY_BODY_LIMIT, CAREERS_REFERRER_POLICY, registerCareers, SITE_LOADS, SiteCache } from './routes'

const HOST = 'careers.test'
const NOW = new Date(`${SAMPLE_ANCHOR}T19:00:00.000Z`) // noon in California on the sample's own day
const config = testConfig({ careersHosts: [HOST, 'jobs.test'], careersOrigin: `https://${HOST}`, publicOrigin: 'https://hr.test', secureCookies: true })
const ADDRESS = '203.0.113.7'

let db: Db
let app: FastifyInstance

beforeAll(async () => {
  db = await makeTestDb()
})
afterAll(async () => {
  await db.close()
})

const sample = (): DB => structuredClone(buildSampleDB()) as DB

/** Another company: the sample under another name, with its own job titles. */
function otherCo(): DB {
  const db = sample()
  db.company.name = 'Otherco'
  for (const j of db.jobs) j.title = `Other ${j.title}`
  return db
}

/** A demo company (careers page on, as a sign-up leaves it), or with `careers: false` one whose page is off. */
async function addCompany(id: string, slug: string, data: DB | null, opts: { careers?: boolean; keep?: boolean } = {}): Promise<void> {
  await db.query('INSERT INTO workspaces (id, name, slug, keep, careers) VALUES ($1, $2, $3, $4, $5)', [
    id,
    data?.company.name ?? slug,
    slug,
    opts.keep ?? false,
    opts.careers ?? true,
  ])
  if (data) await replaceWorkspace(db, parseWorkspace({ db: data }), null, id)
}

async function careersApp(limiter?: ApplyRateLimiter, opts: { db?: Db; now?: () => Date } = {}): Promise<FastifyInstance> {
  const a = Fastify({ logger: false })
  await registerCareers(a, { db: opts.db ?? db, config, now: opts.now ?? (() => NOW), ...(limiter ? { limiter } : {}) })
  await a.ready()
  return a
}

beforeEach(async () => {
  await resetDb(db)
  await addCompany('w-acme', 'acme', sample())
  await addCompany('w-other', 'other-co', otherCo())
  await addCompany('w-empty', 'empty-co', null)
  app = await careersApp()
})

const jobs = careerJobs(buildSampleDB(), SAMPLE_ANCHOR)
const job = jobs[0]
const jobPath = `/acme/jobs/${jobAddress(job)}`
const otherJobs = careerJobs(otherCo(), SAMPLE_ANCHOR)
const otherJobPath = `/other-co/jobs/${jobAddress(otherJobs[0])}`

function get(url: string, headers: Record<string, string> = {}, a = app) {
  return a.inject({ method: 'GET', url, headers: { host: HOST, ...headers } })
}

const FORM = { name: 'Rosa Alvarez', email: 'rosa@example.com', phone: '408 555 0134', link: 'linkedin.com/in/rosa', answer: 'I rebuilt our close checklist and cut it from nine days to five.', website: '' }

function apply(url: string, form: Record<string, string> = FORM, headers: Record<string, string> = {}, remoteAddress = ADDRESS, a = app) {
  return a.inject({
    method: 'POST',
    url,
    headers: { host: HOST, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin', origin: `https://${HOST}`, ...headers },
    payload: new URLSearchParams(form).toString(),
    remoteAddress,
  })
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  return Number((await db.query<{ n: unknown }>(sql, params)).rows[0].n)
}

const logRows = (workspaceId: string) => count('SELECT count(*) AS n FROM change_log WHERE workspace_id = $1', [workspaceId])

function expectCareersHeaders(res: LightMyRequestResponse) {
  expect(res.headers['x-content-type-options']).toBe('nosniff')
  expect(res.headers['x-robots-tag']).toBe('noindex, nofollow')
  expect(res.headers['referrer-policy']).toBe(CAREERS_REFERRER_POLICY)
  expect(res.headers['content-security-policy']).toBe(CAREERS_CSP)
  expect(res.headers['set-cookie']).toBeUndefined()
}

describe('careers hosts', () => {
  it('answer on every careers host, in any case and on any port, and nowhere else', async () => {
    // A fully qualified name (its trailing dot) is the same host.
    for (const host of [HOST, 'jobs.test', 'CAREERS.TEST', 'jobs.test:8443', 'careers.test.', 'careers.test.:8443']) {
      const res = await get('/', { host })
      expect(res.statusCode, host).toBe(200)
      expect(res.body).toContain('Careers pages for companies on this First Twenty demo server')
    }
    for (const host of ['hr.test', 'careers.test.evil.example', 'evil-careers.test', 'careers.test..', 'careers.testx.']) {
      expect((await get('/', { host })).statusCode, host).toBe(404)
      expect((await get('/acme/', { host })).statusCode, host).toBe(404)
    }
    // HEAD goes with every GET, on the same hosts only.
    expect((await app.inject({ method: 'HEAD', url: '/acme/', headers: { host: HOST } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'HEAD', url: '/acme/', headers: { host: 'hr.test' } })).statusCode).toBe(404)
  })

  it('list no companies on the landing page, and say anyone can create one', async () => {
    const res = await get('/')
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.body).not.toMatch(/Ledgerlark|Otherco|acme|other-co/)
    expect(res.body).toContain('A company or job here may not be real')
    expect(res.body).toContain('href="https://hr.test/">Make a careers page in First Twenty')
    expectCareersHeaders(res)
  })

  it('ask robots to stay away', async () => {
    const res = await get('/robots.txt')
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('User-agent: *\nDisallow: /\n')
  })

  it('serve the stylesheet, the font and its license from memory, and nothing else', async () => {
    const root = config.rootDir
    const css = await get('/assets/careers.css')
    expect(css.statusCode).toBe(200)
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8')
    expect(css.body).toBe(readFileSync(path.join(root, 'src/careers/careers.css'), 'utf8'))
    expect(css.headers['cache-control']).toBe('public, max-age=3600')
    const etag = String(css.headers.etag)
    const again = await get('/assets/careers.css', { 'if-none-match': etag })
    expect(again.statusCode).toBe(304)
    expect(again.body).toBe('')
    const font = await get('/assets/archivo-latin-standard-normal.woff2')
    expect(font.headers['content-type']).toBe('font/woff2')
    expect(font.rawPayload.equals(readFileSync(path.join(root, 'src/themes/sleek/fonts/archivo-latin-standard-normal.woff2')))).toBe(true)
    expect((await get('/assets/LICENSE-Archivo.txt')).statusCode).toBe(200)
    for (const url of ['/assets/apply.js', '/assets/..%2F..%2Fpackage.json', '/assets/../package.json', '/package.json', '/server/src/app.ts']) {
      const res = await get(url)
      expect(res.statusCode, url).toBe(404)
      expect(res.body, url).not.toContain('"name": "first-twenty"')
    }
  })
})

describe('company pages', () => {
  it('list the company open roles, linked to their pages, and nothing of any other company', async () => {
    const res = await get('/acme/')
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<h1 class="pagehead__title">Work at Ledgerlark</h1>')
    for (const j of jobs) expect(res.body).toContain(`<a class="role__link" href="/acme/jobs/${jobAddress(j)}">`)
    expect(res.body).not.toContain('Otherco')
    expect(res.body).not.toContain('Other ')
    expect(res.body).toContain('This careers page runs on a First Twenty demo server')
    expectCareersHeaders(res)
    const other = await get('/other-co/')
    expect(other.body).toContain('Work at Otherco')
    expect(other.body).toContain(`href="${otherJobPath}"`)
  })

  it('send the address without its slash to the page, and answer 404 for companies that are not there', async () => {
    const res = await get('/acme')
    expect(res.statusCode).toBe(301)
    expect(res.headers.location).toBe('/acme/')
    for (const url of ['/nobody/', '/nobody', '/empty-co/', '/A_B/', '/ab/', '/assets/', '/default-workspace/x', '/acme/jobs/']) {
      const page = await get(url)
      expect(page.statusCode, url).toBe(404)
      expect(page.headers['content-type'], url).toBe('text/html; charset=utf-8')
      expectCareersHeaders(page)
    }
    expect((await get('/empty-co/')).body).toContain('There is no careers page here')
  })

  it('show one open role at its address, title and record id, with a form that posts back here', async () => {
    expect(jobPath).toBe(`/acme/jobs/${job.slug}-${job.id.toLowerCase()}`)
    const res = await get(jobPath)
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(`<h1 class="pagehead__title" id="job-title">${job.title}</h1>`)
    // No fragment in the form's address: the answer's problems take focus (browsers skip autofocus on an
    // address with a fragment).
    expect(res.body).toContain(`method="post" action="${jobPath}/apply"`)
    expect(res.body).not.toContain('#apply-form"')
    expect(res.body).toContain("Your application goes to Ledgerlark's hiring team in First Twenty (a demo server).")
    expectCareersHeaders(res)
    const form = await get(`${jobPath}/apply`)
    expect(form.statusCode).toBe(303)
    expect(form.headers.location).toBe(`${jobPath}#apply`)
  })

  it('send every other way to a role to its address: the record id, the title alone, a trailing slash, capitals', async () => {
    for (const url of [`/acme/jobs/${job.id}`, `/acme/jobs/${job.slug}`, `${jobPath}/`, `/acme/jobs/${jobAddress(job).toUpperCase()}`]) {
      const res = await get(url)
      expect(res.statusCode, url).toBe(301)
      expect(res.headers.location, url).toBe(jobPath)
    }
    // A slug with capitals goes to its lowercase address, the rest of the address and the query kept.
    const caps = await get(`/ACME/jobs/${jobAddress(job)}?x=1`)
    expect(caps.statusCode).toBe(301)
    expect(caps.headers.location).toBe(`${jobPath}?x=1`)
    expect((await get('/Acme/')).headers.location).toBe('/acme/')
  })

  it('keep a role reachable at its old address after it is renamed', async () => {
    const snap = await snapshot(db, 'w-acme')
    const record = (snap?.db.jobs as Array<{ id: string; title: string }>).find((j) => j.id === job.id)!
    const changes = parseChanges({
      changes: [{ collection: 'jobs', id: job.id, op: 'upsert', data: { ...record, title: 'Principal Ledger Engineer' }, baseVersion: snap?.versions[`jobs:${job.id}`] }],
    })
    expect((await applyChanges(db, changes, null, { workspaceId: 'w-acme' })).conflicts).toEqual([])
    const renamed = `/acme/jobs/principal-ledger-engineer-${job.id.toLowerCase()}`
    // The link shared before the rename (on a job board, in an email) still leads to the role.
    const old = await get(jobPath)
    expect(old.statusCode).toBe(301)
    expect(old.headers.location).toBe(renamed)
    const now = await get(renamed)
    expect(now.statusCode).toBe(200)
    expect(now.body).toContain('Principal Ledger Engineer')
    // And the form under the old address still takes the application.
    expect((await apply(`${jobPath}/apply`)).statusCode).toBe(303)
  })

  it("answer a near-miss under a company's address with that company's 404, and only one with a page", async () => {
    for (const url of ['/acme/careers', '/acme/jobs/x/y/z', '/acme/nothing/here']) {
      const res = await get(url)
      expect(res.statusCode, url).toBe(404)
      expect(res.body, url).toContain('Ledgerlark has no page at this address')
      expect(res.body, url).toContain('<a class="brand" href="/acme/">')
    }
    // No company there, or one whose page is off: the general 404, the same for both.
    await addCompany('w-off', 'off-co', otherCo(), { careers: false })
    for (const url of ['/nobody/x/y', '/off-co/x/y']) expect((await get(url)).body, url).toContain('There is no careers page here')
  })

  it('never show a role that is not open and posted', async () => {
    const hidden = buildSampleDB().jobs.filter((j) => !jobs.some((x) => x.id === j.id))
    expect(hidden.length).toBeGreaterThan(0)
    for (const j of hidden) {
      const res = await get(`/acme/jobs/${jobAddress({ id: j.id, title: j.title })}`)
      expect(res.statusCode, j.id).toBe(404)
      expect(res.body).toContain('This role is not open')
      expect(res.body).toContain('<a class="brand" href="/acme/">')
    }
  })

  it('follow the company records as soon as they change', async () => {
    expect((await get('/acme/')).body).toContain(`href="${jobPath}"`)
    const snap = await snapshot(db, 'w-acme')
    const record = (snap?.db.jobs as Array<{ id: string }>).find((j) => j.id === job.id)
    const changes = parseChanges({ changes: [{ collection: 'jobs', id: job.id, op: 'upsert', data: { ...record, status: 'closed' }, baseVersion: snap?.versions[`jobs:${job.id}`] }] })
    const result = await applyChanges(db, changes, null, { workspaceId: 'w-acme' })
    expect(result.conflicts).toEqual([])
    expect((await get('/acme/')).body).not.toContain(`href="${jobPath}"`)
    expect((await get(jobPath)).statusCode).toBe(404)
  })

  it('escape hostile company, job, team and location names wherever they appear', async () => {
    const evil = sample()
    evil.company.name = 'Evil "><img src=x onerror=alert(1)>'
    evil.company.tagline = '<script>alert(2)</script>'
    for (const d of evil.departments) d.name = `${d.name} <script>alert(3)</script>`
    for (const l of evil.locations) l.name = `${l.name} "><svg onload=alert(4)>`
    for (const j of evil.jobs) {
      j.title = `${j.title} </title><script>alert(5)</script>`
      j.description = 'About the role\n- <iframe src="https://evil.example"></iframe>\n- " onfocus="alert(6)'
    }
    await addCompany('w-evil', 'evil-co', evil)
    const evilJobs = careerJobs(evil, SAMPLE_ANCHOR)
    const pages = [await get('/evil-co/'), ...(await Promise.all(evilJobs.map((j) => get(`/evil-co/jobs/${jobAddress(j)}`))))]
    for (const res of pages) {
      expect(res.statusCode).toBe(200)
      expect(res.body).not.toMatch(/<script|<img|<svg|<iframe|<\/title><script/)
      for (const [tag] of res.body.matchAll(/<[a-zA-Z][^>]*>/g)) expect(tag.replace(/="[^"]*"/g, '=""'), tag).not.toMatch(/\son[a-z]+\s*=/i)
      expect(res.body).toContain('Evil &quot;&gt;&lt;img src=x onerror=alert(1)&gt;')
    }
  })

  it('leave out records without the fields a page needs, instead of failing the page', async () => {
    const odd = sample()
    const [first, second] = jobs
    const broken = odd.jobs.find((j) => j.id === first.id) as unknown as Record<string, unknown>
    delete broken.locationIds
    ;(odd.company as unknown as Record<string, unknown>).name = 42
    ;(odd.company as unknown as Record<string, unknown>).tagline = { not: 'text' }
    await addCompany('w-odd', 'odd-co', odd)
    await db.query(`UPDATE workspaces SET name = 'Oddco' WHERE id = 'w-odd'`)
    const res = await get('/odd-co/')
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain(`/odd-co/jobs/${jobAddress(first)}"`)
    expect(res.body).toContain(`/odd-co/jobs/${jobAddress(second)}"`)
    // The company document's name was not text, so the page uses the name the company was created with.
    expect(res.body).toContain('Work at Oddco')
  })

  it('never set a cookie, whatever the request carries', async () => {
    for (const url of ['/', '/acme/', jobPath, '/nobody/', '/assets/careers.css']) {
      const res = await get(url, { cookie: '__Host-ft_session=abc; ft_session=def' })
      expect(res.headers['set-cookie'], url).toBeUndefined()
    }
  })
})

describe('applying', () => {
  it('adds a candidate and an application to that company only, through its change log', async () => {
    const before = { acme: await logRows('w-acme'), other: await logRows('w-other') }
    const seq = (await snapshot(db, 'w-acme'))!.seq
    const otherSeq = (await snapshot(db, 'w-other'))!.seq
    const active = (await db.query<{ t: string }>(`SELECT last_active_at::text AS t FROM workspaces WHERE id = 'w-acme'`)).rows[0].t
    const res = await apply(`${jobPath}/apply`)
    expect(res.statusCode).toBe(303)
    // No fragment: the confirmation's heading takes focus on arrival.
    expect(res.headers.location).toMatch(new RegExp(`^${jobPath}\\?applied=[0-9a-z]+\\.[A-Za-z0-9_-]{22}$`))
    expectCareersHeaders(res)

    const cand = await db.query<{ workspace_id: string; data: Record<string, unknown> }>(`SELECT workspace_id, data FROM candidates WHERE data->>'email' = 'rosa@example.com'`)
    expect(cand.rows.map((r) => r.workspace_id)).toEqual(['w-acme'])
    const c = cand.rows[0].data
    expect(c).toMatchObject({ firstName: 'Rosa', lastName: 'Alvarez', source: 'inbound', sourceDetail: 'Careers site', phone: '408 555 0134', links: { linkedin: 'https://linkedin.com/in/rosa' }, createdOn: SAMPLE_ANCHOR })
    const appRow = await db.query<{ workspace_id: string; data: Record<string, unknown>; updated_by: string | null }>(`SELECT workspace_id, data, updated_by FROM applications WHERE data->>'candidateId' = $1`, [c.id])
    expect(appRow.rows).toHaveLength(1)
    expect(appRow.rows[0].workspace_id).toBe('w-acme')
    expect(appRow.rows[0].updated_by).toBeNull()
    expect(appRow.rows[0].data).toMatchObject({ jobId: job.id, stageId: 'new', status: 'active', appliedOn: SAMPLE_ANCHOR, nextStep: { text: 'Review application' } })

    // Five upserts in acme's log (candidate, application, three activity rows), none anywhere else.
    expect(await logRows('w-acme')).toBe(before.acme + 5)
    expect(await logRows('w-other')).toBe(before.other)
    const pulled = await changesSince(db, seq, { workspaceId: 'w-acme' })
    expect('changes' in pulled && pulled.changes.map((ch) => ch.collection).sort()).toEqual(['activity', 'activity', 'activity', 'applications', 'candidates'])
    const otherPull = await changesSince(db, otherSeq, { workspaceId: 'w-other' })
    expect('changes' in otherPull && otherPull.changes).toEqual([])
    const users = await db.query<{ user_id: string | null }>(`SELECT DISTINCT user_id FROM change_log WHERE workspace_id = 'w-acme' AND seq > $1`, [seq])
    expect(users.rows).toEqual([{ user_id: null }])
    // A stranger's application does not count as the company using its workspace.
    const after = (await db.query<{ t: string }>(`SELECT last_active_at::text AS t FROM workspaces WHERE id = 'w-acme'`)).rows[0].t
    expect(after).toBe(active)

    const done = await get(String(res.headers.location))
    expect(done.body).toContain('Thanks for applying')
    expect(done.body).toContain('<div class="done" id="apply-done" role="status">')
    expect(done.body).toContain('tabindex="-1" autofocus>Thanks for applying</h3>')
    expect(done.body).not.toContain('<form')
    // Nothing left to apply with: the Apply buttons go too.
    expect(done.body).not.toContain('Apply for this role')
    expect(done.headers['cache-control']).toBe('no-store')
  })

  it('shows the confirmation only for a real send from this server, a few minutes old at most', async () => {
    const res = await apply(`${jobPath}/apply`)
    const location = String(res.headers.location)
    const proof = new URL(location, 'https://careers.test').searchParams.get('applied')!
    // A made-up or tampered link, or one for another role, shows the form and claims nothing.
    for (const url of [`${jobPath}?applied=1`, `${jobPath}?applied=${proof.slice(0, -1)}${proof.endsWith('A') ? 'B' : 'A'}`, `${jobPath}?applied=zz.${'A'.repeat(22)}`, `/acme/jobs/${jobAddress(jobs[1])}?applied=${proof}`]) {
      const page = await get(url)
      expect(page.statusCode, url).toBe(200)
      expect(page.body, url).not.toContain('Thanks for applying')
      expect(page.body, url).not.toContain('Application sent')
      expect(page.body, url).toContain('<form class="form" id="apply-form" method="post"')
    }
    // Another process (a restart) does not know the proof, and it runs out.
    let now = NOW.getTime()
    const later = await careersApp(undefined, { now: () => new Date(now) })
    expect((await get(location, {}, later)).body).not.toContain('Thanks for applying')
    const fresh = String((await apply(`/acme/jobs/${jobAddress(jobs[1])}/apply`, FORM, {}, ADDRESS, later)).headers.location)
    expect((await get(fresh, {}, later)).body).toContain('Thanks for applying')
    now += APPLIED_PROOF_MS + 1000
    expect((await get(fresh, {}, later)).body).not.toContain('Thanks for applying')
    await later.close()
  })

  it('shows the form again with its problems and what was typed, escaped, and writes nothing', async () => {
    const before = await logRows('w-acme')
    const res = await apply(`${jobPath}/apply`, { name: '<script>x</script>', email: 'nope', answer: 'short', website: '' })
    expect(res.statusCode).toBe(400)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body).toContain('There are 2 problems with the form')
    // Announced, and focused on arrival (the form's address has no fragment, so autofocus works).
    expect(res.body).toContain('<div class="errors" id="apply-errors" role="alert" aria-labelledby="apply-errors-h" tabindex="-1" autofocus>')
    expect(res.body).toContain('value="&lt;script&gt;x&lt;/script&gt;"')
    expect(res.body).toContain('value="nope"')
    expect(res.body).not.toContain('<script>')
    expectCareersHeaders(res)
    expect(await logRows('w-acme')).toBe(before)
  })

  it('keeps what an applicant typed as plain text', async () => {
    const res = await apply(`${jobPath}/apply`, { ...FORM, name: 'Rosa <b>Bold</b>', answer: '<img src=x onerror=alert(1)> is how I would test your forms.' })
    expect(res.statusCode).toBe(303)
    const c = (await db.query<{ data: { firstName: string; lastName: string } }>(`SELECT data FROM candidates WHERE data->>'email' = 'rosa@example.com'`)).rows[0].data
    expect(`${c.firstName} ${c.lastName}`).toBe('Rosa <b>Bold</b>')
  })

  it('refuses a filled hidden field', async () => {
    const before = await logRows('w-acme')
    const res = await apply(`${jobPath}/apply`, { ...FORM, website: 'https://spam.example' })
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('The form could not be sent.')
    expect(res.body).not.toContain('spam.example')
    expect(await logRows('w-acme')).toBe(before)
  })

  it('adds nothing when the same person applies to the same role again, and answers the same', async () => {
    const first = await apply(`${jobPath}/apply`)
    expect(first.statusCode).toBe(303)
    const after = await logRows('w-acme')
    const again = await apply(`${jobPath}/apply`, { ...FORM, email: 'ROSA@example.com' })
    expect(again.statusCode).toBe(303)
    expect(again.headers.location).toBe(first.headers.location)
    expect(await logRows('w-acme')).toBe(after)
    // Another role is another application.
    expect((await apply(`/acme/jobs/${jobAddress(jobs[1])}/apply`)).statusCode).toBe(303)
    expect(await count(`SELECT count(*) AS n FROM applications WHERE workspace_id = 'w-acme' AND data->>'jobId' = ANY(ARRAY[$1, $2])`, [job.id, jobs[1].id])).toBeGreaterThanOrEqual(2)
  })

  it('takes forms only from their own page', async () => {
    const before = await logRows('w-acme')
    const refused: Array<[string, Record<string, string>]> = [
      ['another site', { 'sec-fetch-site': 'cross-site' }],
      ['a sibling host', { 'sec-fetch-site': 'same-site' }],
      ['another origin', { origin: 'https://evil.example' }],
      ['a sibling origin', { origin: 'https://jobs.test' }],
    ]
    for (const [why, headers] of refused) {
      const res = await apply(`${jobPath}/apply`, FORM, headers)
      expect(res.statusCode, why).toBe(403)
      expect(res.body, why).toContain('Send your application from the job page')
      expectCareersHeaders(res)
    }
    const json = await app.inject({ method: 'POST', url: `${jobPath}/apply`, headers: { host: HOST, 'content-type': 'application/json' }, payload: JSON.stringify(FORM) })
    expect(json.statusCode).toBe(415)
    expect(json.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(await logRows('w-acme')).toBe(before)
    // A browser under a no-referrer policy sends Origin: null; curl sends neither header.
    expect((await apply(`${jobPath}/apply`, FORM, { origin: 'null' })).statusCode).toBe(303)
    // The fully qualified name (a trailing dot) on either side is the same host.
    expect((await apply(`${jobPath}/apply`, { ...FORM, email: 'dot1@example.com' }, { host: 'careers.test.', origin: 'https://careers.test' })).statusCode).toBe(303)
    expect((await apply(`${jobPath}/apply`, { ...FORM, email: 'dot2@example.com' }, { origin: 'https://careers.test.' })).statusCode).toBe(303)
    expect((await apply(`${jobPath}/apply`, { ...FORM, email: 'dot3@example.com' }, { origin: 'https://careers.test.evil.example' })).statusCode).toBe(403)
    const plain = await app.inject({ method: 'POST', url: `${jobPath}/apply`, headers: { host: HOST, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ ...FORM, email: 'b@example.com' }).toString() })
    expect(plain.statusCode).toBe(303)
  })

  it('refuses a body over the limit with a page, and unknown companies and roles with 404', async () => {
    const before = await logRows('w-acme')
    const big = await apply(`${jobPath}/apply`, { ...FORM, answer: 'x'.repeat(APPLY_BODY_LIMIT) })
    expect(big.statusCode).toBe(413)
    expect(big.body).toContain('The application is too long')
    expectCareersHeaders(big)
    expect((await apply('/nobody/jobs/x/apply')).statusCode).toBe(404)
    expect((await apply('/acme/jobs/no-such-role/apply')).statusCode).toBe(404)
    expect((await apply('/empty-co/jobs/x/apply')).statusCode).toBe(404)
    expect(await logRows('w-acme')).toBe(before)
  })

  it('says so, and writes nothing, when the company workspace is full', async () => {
    const records = Object.keys((await snapshot(db, 'w-acme'))!.versions).filter((k) => !k.startsWith('$doc:')).length
    expect(records).toBeGreaterThan(0)
    const saved = LIMITS.recordsPerDemoWorkspace
    const before = await logRows('w-acme')
    try {
      // Room for one more record, and an application adds five, so the whole push is refused.
      LIMITS.recordsPerDemoWorkspace = records + 1
      const res = await apply(`${jobPath}/apply`)
      expect(res.statusCode).toBe(503)
      expect(res.body).toContain('Ledgerlark cannot take applications right now')
    } finally {
      LIMITS.recordsPerDemoWorkspace = saved
    }
    expect(await logRows('w-acme')).toBe(before)
  })
})

describe('apply limits', () => {
  it('take a few applications from one address an hour, then answer 429 until the hour has passed', async () => {
    let now = NOW.getTime()
    const a = await careersApp(new ApplyRateLimiter({ perAddress: 2, now: () => now }))
    for (const email of ['a@example.com', 'b@example.com']) expect((await apply(`${jobPath}/apply`, { ...FORM, email }, {}, ADDRESS, a)).statusCode).toBe(303)
    const before = await logRows('w-acme')
    const answer = 'I kept a two-thousand-character answer here & it <must> survive the refusal.'
    const third = await apply(`${jobPath}/apply`, { ...FORM, email: 'c@example.com', answer }, {}, ADDRESS, a)
    expect(third.statusCode).toBe(429)
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0)
    expect(third.body).toContain('Too many applications from your network')
    // The form again, with what was typed, so a shared network's limit loses nobody's answer.
    expect(third.body).toContain('Your application was not sent.')
    expect(third.body).toContain('value="c@example.com"')
    expect(third.body).toContain('I kept a two-thousand-character answer here &amp; it &lt;must&gt; survive the refusal.</textarea>')
    expect(third.body).toContain('role="alert"')
    expectCareersHeaders(third)
    expect(await logRows('w-acme')).toBe(before)
    // Another address (IPv6 counts per /64) is not held back; the same /64 is.
    expect((await apply(`${jobPath}/apply`, { ...FORM, email: 'd@example.com' }, {}, '2001:db8:1:2::1', a)).statusCode).toBe(303)
    expect((await apply(`${jobPath}/apply`, { ...FORM, email: 'e@example.com' }, {}, '2001:db8:1:2::2', a)).statusCode).toBe(303)
    expect((await apply(`${jobPath}/apply`, { ...FORM, email: 'f@example.com' }, {}, '2001:db8:1:2:ffff::9', a)).statusCode).toBe(429)
    now += 3_600_000 + 1000
    expect((await apply(`${jobPath}/apply`, { ...FORM, email: 'c@example.com' }, {}, ADDRESS, a)).statusCode).toBe(303)
    await a.close()
  })

  it('cap the applications one company takes in a day, whatever the address, and leave other companies alone', async () => {
    const a = await careersApp(new ApplyRateLimiter({ perWorkspace: 2, now: () => NOW.getTime() }))
    expect((await apply(`${jobPath}/apply`, { ...FORM, email: 'a@example.com' }, {}, '198.51.100.1', a)).statusCode).toBe(303)
    expect((await apply(`${jobPath}/apply`, { ...FORM, email: 'b@example.com' }, {}, '198.51.100.2', a)).statusCode).toBe(303)
    const full = await apply(`${jobPath}/apply`, { ...FORM, email: 'c@example.com' }, {}, '198.51.100.3', a)
    expect(full.statusCode).toBe(429)
    expect(full.body).toContain('Ledgerlark has had many applications today')
    expect((await apply(`${otherJobPath}/apply`, { ...FORM, email: 'c@example.com' }, {}, '198.51.100.3', a)).statusCode).toBe(303)
    await a.close()
  })

  it('count every form post from an address, typos included, before reading the body', async () => {
    const a = await careersApp(new ApplyRateLimiter({ postsPerAddress: 3, now: () => NOW.getTime() }))
    for (let i = 0; i < 3; i++) expect((await apply(`${jobPath}/apply`, { ...FORM, email: 'typo' }, {}, ADDRESS, a)).statusCode).toBe(400)
    const res = await apply(`${jobPath}/apply`, FORM, {}, ADDRESS, a)
    expect(res.statusCode).toBe(429)
    expect(res.body).toContain('Too many tries from your network')
    expect((await apply(`${jobPath}/apply`, FORM, {}, '198.51.100.9', a)).statusCode).toBe(303)
    await a.close()
  })
})

describe('in the full server', () => {
  let full: FastifyInstance
  beforeEach(async () => {
    await createAdmin(db)
    full = await buildApp({ db, config: { ...config, secureCookies: false }, logger: false, careers: (scope, deps) => registerCareers(scope, { ...deps, now: () => NOW }) })
    await full.ready()
  })

  it('answers careers pages on careers hosts and nothing else there', async () => {
    expect((await get('/acme/', {}, full)).statusCode).toBe(200)
    expect((await get('/', {}, full)).body).toContain('Careers pages for companies on this First Twenty demo server')
    for (const url of ['/api/health', '/api/auth/session', '/api/workspace', '/sw.js', '/index.html']) {
      const res = await get(url, {}, full)
      expect(res.statusCode, url).toBe(404)
      expect(res.headers['set-cookie'], url).toBeUndefined()
    }
    const login = await full.inject({ method: 'POST', url: '/api/auth/login', headers: { host: HOST, 'x-first-twenty': '1', 'content-type': 'application/json' }, payload: { email: 'admin@example.com', password: 'test-password-1234' } })
    expect(login.statusCode).toBe(404)
    expect(login.headers['set-cookie']).toBeUndefined()
  })

  it('answers no careers page on the app host, where the API goes on as before', async () => {
    const app = { host: 'hr.test' }
    expect((await get('/acme/', app, full)).statusCode).toBe(404)
    expect((await get('/assets/careers.css', app, full)).statusCode).toBe(404)
    expect((await get('/api/health', app, full)).statusCode).toBe(200)
  })

  it('takes an application through the full server, with the careers headers and no cookie', async () => {
    const res = await apply(`${jobPath}/apply`, FORM, { cookie: 'ft_session=abc' }, ADDRESS, full)
    expect(res.statusCode).toBe(303)
    expect(res.headers['set-cookie']).toBeUndefined()
    const page = await get(jobPath, {}, full)
    expect(page.headers['content-security-policy']).toBe(CAREERS_CSP)
    expect(page.headers['x-frame-options']).toBe('DENY')
    expect(page.headers['referrer-policy']).toBe(CAREERS_REFERRER_POLICY)
    expect(await count(`SELECT count(*) AS n FROM candidates WHERE workspace_id = 'w-acme' AND data->>'email' = 'rosa@example.com'`)).toBe(1)
  })
})

describe('careers pages that are off', () => {
  it("never show or take applications for a company whose careers page is off, such as the owner's own", async () => {
    await addCompany('w-own', 'own-co', otherCo(), { careers: false, keep: true })
    const path = `/own-co/jobs/${jobAddress(otherJobs[0])}`
    for (const url of ['/own-co/', '/own-co', path]) {
      const res = await get(url)
      expect(res.statusCode, url).toBe(404)
      expect(res.body, url).toContain('There is no careers page here')
      expect(res.body, url).not.toContain('Otherco')
    }
    const before = await logRows('w-own')
    expect((await apply(`${path}/apply`)).statusCode).toBe(404)
    expect(await logRows('w-own')).toBe(before)
    // Turned on, it shows.
    await db.query(`UPDATE workspaces SET careers = true WHERE id = 'w-own'`)
    expect((await get('/own-co/')).statusCode).toBe(200)
  })
})

describe('what a page view costs', () => {
  it('reads only the listed jobs and what they name, never closed or unposted jobs or other records', async () => {
    const big = sample()
    // Closed jobs with huge descriptions, a pile of departments nobody posts in, and people.
    const filler = 'x'.repeat(200_000)
    for (let i = 0; i < 20; i++) big.jobs.push({ ...big.jobs[0], id: `j-closed-${i}`, status: 'closed', description: filler })
    for (let i = 0; i < 50; i++) big.departments.push({ ...big.departments[0], id: `d-unused-${i}`, name: `Unused ${filler.slice(0, 5000)}` })
    await addCompany('w-big', 'big-co', big, { keep: true })
    const loaded = await loadCareersDb(db, 'w-big', 'Big', SAMPLE_ANCHOR)
    expect(loaded).not.toBeNull()
    const listed = careerJobs(big, SAMPLE_ANCHOR)
    expect(loaded!.db.jobs.map((j) => j.id).sort()).toEqual(listed.map((j) => j.id).sort())
    expect(loaded!.db.departments.every((d) => !d.id.startsWith('d-unused-'))).toBe(true)
    expect(loaded!.db.people).toEqual([])
    expect(loaded!.bytes).toBeLessThan(200_000)
    // The page itself is the same as from the whole workspace.
    expect(careerJobs(loaded!.db, SAMPLE_ANCHOR).map((j) => j.posting)).toEqual(listed.map((j) => j.posting))
  })

  it(`lists at most ${MAX_LISTED_JOBS} roles and ${LOAD_BUDGET.jobs / (1024 * 1024)} MB of job records, whatever the company holds`, async () => {
    const big = sample()
    const open = big.jobs.find((j) => jobs.some((x) => x.id === j.id))!
    for (let i = 0; i < 300; i++) big.jobs.push({ ...open, id: `j-open-${String(i).padStart(3, '0')}`, title: `Role ${i}` })
    await addCompany('w-many', 'many-co', big, { keep: true })
    const loaded = await loadCareersDb(db, 'w-many', 'Many', SAMPLE_ANCHOR)
    expect(loaded!.db.jobs.length).toBe(MAX_LISTED_JOBS)
    const heavy = sample()
    const long = 'Long posting line. '.repeat(10_000)
    for (let i = 0; i < 30; i++) heavy.jobs.push({ ...open, id: `j-heavy-${String(i).padStart(2, '0')}`, description: long })
    await addCompany('w-heavy', 'heavy-co', heavy, { keep: true })
    const capped = await loadCareersDb(db, 'w-heavy', 'Heavy', SAMPLE_ANCHOR)
    const jobBytes = capped!.db.jobs.reduce((n, j) => n + JSON.stringify(j).length, 0)
    expect(jobBytes).toBeLessThanOrEqual(LOAD_BUDGET.jobs * 1.1)
    expect(capped!.db.jobs.length).toBeLessThan(heavy.jobs.length)
    expect((await get('/heavy-co/')).statusCode).toBe(200)
  })

  it('reads only a few sites at once, and answers 503 rather than queue without end', async () => {
    let release = () => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    // A database that holds every site read until told to go on.
    const stalled: Db = { ...db, tx: (async (fn: Parameters<Db['tx']>[0], options?: Parameters<Db['tx']>[1]) => {
      await held
      return db.tx(fn, options)
    }) as Db['tx'] }
    const a = await careersApp(undefined, { db: stalled })
    const views = Array.from({ length: SITE_LOADS.running + SITE_LOADS.waiting + 3 }, () => get('/acme/', {}, a))
    await new Promise((r) => setTimeout(r, 50))
    release()
    const answers = await Promise.all(views)
    expect(answers.filter((r) => r.statusCode === 503)).toHaveLength(3)
    expect(answers.filter((r) => r.statusCode === 200).length).toBe(SITE_LOADS.running + SITE_LOADS.waiting)
    const busy = answers.find((r) => r.statusCode === 503)!
    expect(busy.body).toContain('This page is busy')
    expect(busy.headers['retry-after']).toBe('10')
    expectCareersHeaders(busy)
    await a.close()
  })

  it('keeps cached pages within a byte budget, dropping the least recently viewed first', () => {
    const cache = new SiteCache<string>(1000)
    cache.set('a', 'k', 'A', 250)
    cache.set('b', 'k', 'B', 200)
    cache.set('c', 'k', 'C', 240)
    expect(cache.bytes).toBe(690)
    expect(cache.get('a', 'k')).toBe('A') // a is now the most recently viewed
    cache.set('d', 'k', 'D', 240)
    cache.set('e', 'k', 'E', 240) // 1,170 bytes: b, the least recently viewed, goes
    expect(cache.get('b', 'k')).toBeNull()
    expect(cache.get('c', 'k')).toBe('C')
    expect(cache.get('a', 'k')).toBe('A')
    expect(cache.bytes).toBe(970)
    cache.set('g', 'k', 'G', 200) // d is now the least recently viewed
    expect(cache.get('d', 'k')).toBeNull()
    expect(cache.bytes).toBeLessThanOrEqual(1000)
    // A site over half the budget is never kept; a new version replaces the old one's bytes.
    cache.set('f', 'k', 'F', 501)
    expect(cache.get('f', 'k')).toBeNull()
    cache.set('a', 'k2', 'A2', 10)
    expect(cache.get('a', 'k')).toBeNull()
    expect(cache.get('a', 'k2')).toBe('A2')
  })
})

describe('apply limits against bursts and probes', () => {
  /** The database as Postgres over a socket answers: every query a little later, never in the same tick. */
  function slowDb(inner: Db, ms = 1): Db {
    const later = () => new Promise((r) => setTimeout(r, ms))
    const wrap = <T extends Pick<Db, 'query' | 'exec'>>(q: T) => ({
      ...q,
      query: (async (text: string, params?: unknown[]) => {
        await later()
        return q.query(text, params)
      }) as Db['query'],
    })
    return { ...wrap(inner), tx: (fn, options) => inner.tx((q) => fn(wrap(q)), options) } as Db
  }

  it('take no more applications than the limits allow when they arrive at the same moment', async () => {
    const slow = slowDb(db)
    const a = await careersApp(new ApplyRateLimiter({ perAddress: 5, perWorkspace: 8, postsPerAddress: 1000, now: () => NOW.getTime() }), { db: slow })
    const before = await count(`SELECT count(*) AS n FROM applications WHERE workspace_id = 'w-acme'`)
    // Thirty posts from one address at once: five land.
    const burst = await Promise.all(Array.from({ length: 30 }, (_, i) => apply(`${jobPath}/apply`, { ...FORM, email: `burst${i}@example.com` }, {}, ADDRESS, a)))
    expect(burst.filter((r) => r.statusCode === 303)).toHaveLength(5)
    expect(burst.filter((r) => r.statusCode === 429)).toHaveLength(25)
    // Five addresses at once: the company's day (eight) fills, and no more.
    const many = await Promise.all(
      Array.from({ length: 25 }, (_, i) => apply(`${jobPath}/apply`, { ...FORM, email: `many${i}@example.com` }, {}, `198.51.100.${10 + (i % 5)}`, a)),
    )
    expect(many.filter((r) => r.statusCode === 303)).toHaveLength(3)
    expect(await count(`SELECT count(*) AS n FROM applications WHERE workspace_id = 'w-acme'`)).toBe(before + 8)
    await a.close()
  })

  it("say nothing about whether an email applied before: a repeat counts like a new application", async () => {
    // A real candidate applies from their own network.
    expect((await apply(`${jobPath}/apply`, { ...FORM, email: 'target@example.com' }, {}, '198.51.100.50')).statusCode).toBe(303)
    // A stranger probes with junk, then the target, then junk: the answers are the same whether or not the
    // target applied (here they did; below, someone who did not).
    const probe = async (target: string, address: string) => {
      const a = await careersApp(new ApplyRateLimiter({ perAddress: 2, now: () => NOW.getTime() }))
      const out = []
      for (const email of ['junk1@example.com', target, 'junk2@example.com']) out.push((await apply(`${jobPath}/apply`, { ...FORM, email }, {}, address, a)).statusCode)
      await a.close()
      return out
    }
    expect(await probe('target@example.com', '203.0.113.60')).toEqual(await probe('never-applied@example.com', '203.0.113.61'))
  })
})
