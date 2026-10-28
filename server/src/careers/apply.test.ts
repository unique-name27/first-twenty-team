// The careers apply form (routes.ts), in-memory PGlite + app.inject() with Host headers: it writes a
// candidate and an application through the sync write path into that company's change log and no
// other, within its limits, which hold against bursts and say nothing about who applied before.
import { describe, expect, it } from 'vitest'
import { jobAddress } from '../../../src/careers/render'
import { SAMPLE_ANCHOR } from '../../../src/data/seed'
import type { Db } from '../db'
import { changesSince, snapshot } from '../repo'
import { ADDRESS, app, apply, careersApp, count, db, expectCareersHeaders, FORM, get, HOST, job, jobPath, jobs, logRows, NOW, otherJobPath, useCareers } from '../test/careers'
import { LIMITS } from '../validate'
import { ApplyRateLimiter } from './limits'
import { APPLIED_PROOF_MS, APPLY_BODY_LIMIT } from './routes'

useCareers()

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
