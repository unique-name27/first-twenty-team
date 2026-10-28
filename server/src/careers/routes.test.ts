// The live careers pages (routes.ts), in-memory PGlite + app.inject() with Host headers: careers hosts
// only, pages from each company's own records (when its careers page is on), every value escaped, strict
// headers and no cookies, stable job addresses, the full server, and what a page view costs. The apply
// form is in apply.test.ts.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'
import { careerJobs, jobAddress } from '../../../src/careers/render'
import { buildSampleDB, SAMPLE_ANCHOR } from '../../../src/data/seed'
import { buildApp } from '../app'
import { CAREERS_CSP } from '../csp'
import type { Db } from '../db'
import { applyChanges, snapshot } from '../repo'
import { addCompany, ADDRESS, app, apply, careersApp, config, count, db, expectCareersHeaders, FORM, get, HOST, job, jobPath, jobs, logRows, NOW, otherCo, otherJobPath, otherJobs, sample, useCareers } from '../test/careers'
import { createAdmin } from '../test/helpers'
import { parseChanges } from '../validate'
import { LOAD_BUDGET, loadCareersDb, MAX_LISTED_JOBS } from './data'
import { CAREERS_REFERRER_POLICY, registerCareers, SITE_LOADS, SiteCache } from './routes'

useCareers()

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
