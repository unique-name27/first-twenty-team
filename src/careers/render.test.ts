// The shared careers renderer in live mode (the server's careers pages): every value from a workspace is
// escaped wherever it lands, the live form posts for real and says where it goes, the answers to a post
// are announced, the demo and live pages print the same posting, live pages state no fact a demo sign-up
// made up, job addresses survive a rename, and the pages keep the static site's accessibility structure.
import { describe, expect, it } from 'vitest'
import { buildSampleDB, SAMPLE_ANCHOR } from '@/data/seed'
import type { DB } from '@/domain/types'
import {
  careerJobs,
  companyFactsSet,
  jobAddress,
  type LiveMode,
  type PageContext,
  type PageLinks,
  renderIndexPage,
  renderJobPage,
  renderMessagePage,
  roleQuestion,
} from './render'

const date = SAMPLE_ANCHOR
const links: PageLinks = { home: '/acme/', job: (j) => `/acme/jobs/${j.slug}`, asset: (f) => `/assets/${f}` }
const live: LiveMode = { kind: 'live', appOrigin: 'https://hr.example.test' }
const ctx: PageContext = { links, mode: live }

const XSS = {
  script: '<script>alert(1)</script>',
  img: '"><img src=x onerror=alert(2)>',
  attr: 'x" onmouseover="alert(3)',
  textarea: '</textarea><script>alert(4)</script>',
}

/** The sample, with every text a careers page prints from it replaced by something hostile. */
function hostileDb(): DB {
  const db = structuredClone(buildSampleDB())
  db.company.name = `Acme ${XSS.img}`
  db.company.tagline = `We build ${XSS.script}`
  db.company.stage = XSS.attr
  db.company.workweek = XSS.script
  db.company.hq = { ...db.company.hq, city: XSS.img, state: XSS.attr }
  for (const d of db.departments) {
    d.name = `${d.name} ${XSS.script}`
    d.id = `${d.id} ${XSS.attr}`
  }
  for (const j of db.jobs) {
    const dept = db.departments.find((d) => d.id.startsWith(`${j.departmentId} `))
    if (dept) j.departmentId = dept.id
    j.title = `${j.title} ${XSS.script}`
    j.description = `${XSS.img}\n\nWhat you will do\n- ${XSS.script}\n- ${XSS.attr}`
  }
  for (const l of db.locations) l.name = `${l.name} ${XSS.img}`
  return db
}

/** No hostile markup made it through: no tag, no handler, no attribute that a value broke out of. */
function expectInert(html: string) {
  expect(html).not.toContain('<script')
  expect(html).not.toContain('<img')
  expect(html).not.toContain('</textarea><script')
  // Text is escaped, so every real tag starts with "<" and a letter. None carries an event handler, and
  // every attribute value is closed by its own quote (a quote inside a value would start a new attribute).
  for (const [tag] of html.matchAll(/<[a-zA-Z][^>]*>/g)) {
    expect(tag).toMatch(/^<[a-zA-Z][a-zA-Z0-9]*(\s+[a-z-]+(="[^"<>]*")?)*\s*>$/)
    expect(tag.replace(/="[^"]*"/g, '=""'), tag).not.toMatch(/\son[a-z]+\s*=/i)
  }
}

describe('live careers pages', () => {
  it('escape every company, job, department and location value, in text and in attributes', () => {
    const db = hostileDb()
    const jobs = careerJobs(db, date)
    expect(jobs.length).toBeGreaterThan(0)
    const index = renderIndexPage(db, date, jobs, ctx)
    expectInert(index)
    expect(index).toContain('Acme &quot;&gt;&lt;img src=x onerror=alert(2)&gt;')
    expect(index).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    // Department ids become safe, unique anchors.
    const anchors = [...index.matchAll(/<h3 class="team__name" id="([^"]+)"/g)].map((m) => m[1])
    expect(anchors.length).toBeGreaterThan(0)
    for (const a of anchors) expect(a).toMatch(/^team-[A-Za-z0-9_-]+$/)
    expect(new Set(anchors).size).toBe(anchors.length)
    for (const j of jobs) {
      const page = renderJobPage(db, j, ctx, { action: `${links.job(j)}/apply` })
      expectInert(page)
      expect(page).toContain(`<title>${j.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')} at Acme`)
    }
  })

  it('escape what an applicant typed when the form comes back with problems', () => {
    const db = buildSampleDB()
    const [j] = careerJobs(db, date)
    const page = renderJobPage(db, j, ctx, {
      action: '/acme/jobs/x/apply',
      values: { name: XSS.img, email: XSS.attr, phone: XSS.script, link: XSS.attr, answer: XSS.textarea },
      errors: { email: 'Enter an email address in the format name@example.com.', answer: `Bad ${XSS.script}` },
    })
    expectInert(page)
    expect(page).toContain('value="&quot;&gt;&lt;img src=x onerror=alert(2)&gt;"')
    expect(page).toContain('>&lt;/textarea&gt;&lt;script&gt;alert(4)&lt;/script&gt;</textarea>')
  })

  it('post the form to the server and say where it goes, with no demo script', () => {
    const db = buildSampleDB()
    const [j] = careerJobs(db, date)
    const page = renderJobPage(db, j, ctx, { action: `/acme/jobs/${j.slug}/apply` })
    expect(page).toContain(`<form class="form" id="apply-form" method="post" action="/acme/jobs/${j.slug}/apply" accept-charset="utf-8" novalidate`)
    expect(page).not.toContain('method="dialog"')
    expect(page).not.toMatch(/<script|style=|type="file"/)
    expect(page).toContain("Your application goes to Ledgerlark's hiring team in First Twenty (a demo server).")
    // The demo-server notice comes before the form, on every page, and never calls the company fictional.
    expect(page.indexOf('runs on a First Twenty demo server, where anyone can create a company')).toBeLessThan(page.indexOf('<form'))
    expect(page).not.toContain('fictional')
    expect(page).toContain('<link rel="stylesheet" href="/assets/careers.css">')
    // The hidden anti-spam field is labeled, out of the tab order and never filled in by the page.
    expect(page).toMatch(/<div class="field" hidden>\n<label class="field__label" for="f-website">Leave this field empty<\/label>\n<input class="input" id="f-website" name="website" type="text" autocomplete="off" tabindex="-1" maxlength="200">/)
    // Field lengths match what the server accepts.
    expect(page).toContain('id="f-name" name="name" type="text" autocomplete="name" required maxlength="120"')
    expect(page).toContain('maxlength="2000"')
  })

  it('list the problems first, focused, each linked to its field, and mark the fields invalid', () => {
    const db = buildSampleDB()
    const [j] = careerJobs(db, date)
    const page = renderJobPage(db, j, ctx, {
      action: '/x/apply',
      values: { name: 'A' },
      errors: { name: 'Enter your full name.', answer: 'Answer the question about this role.', website: 'The form could not be sent.' },
    })
    // Announced as well as focused: a screen reader hears the problems whether or not focus moves.
    expect(page).toContain('<div class="errors" id="apply-errors" role="alert" aria-labelledby="apply-errors-h" tabindex="-1" autofocus>')
    expect(page).toContain('There are 3 problems with the form')
    expect(page).toContain('<li><a href="#f-name">Enter your full name.</a></li>')
    expect(page).toContain('<li><a href="#f-answer">Answer the question about this role.</a></li>')
    // The hidden field's problem points at a field people can see.
    expect(page).toContain('<li><a href="#f-name">The form could not be sent.</a></li>')
    expect(page).toMatch(/id="f-name"[^>]*aria-invalid="true"/)
    expect(page).toContain('<p class="field__error" id="f-name-error">Enter your full name.</p>')
    expect(page).toContain('<p class="field__error" id="f-email-error" hidden></p>')
    expect(page).toMatch(/<textarea[^>]*id="f-answer"[^>]*aria-invalid="true"/)
    expect(page.indexOf('apply-errors')).toBeLessThan(page.indexOf('id="f-name"'))
  })

  it('show the confirmation in place of the form once the application is in', () => {
    const db = buildSampleDB()
    const [j] = careerJobs(db, date)
    const page = renderJobPage(db, j, ctx, { action: '/x/apply', applied: true })
    expect(page).not.toContain('<form')
    expect(page).toContain('<div class="done" id="apply-done" role="status">')
    expect(page).toContain('<h3 class="done__title" id="apply-done-h" tabindex="-1" autofocus>Thanks for applying</h3>')
    expect(page).toContain("Your application went to Ledgerlark's hiring team in First Twenty (a demo server).")
    expect(page).toContain('href="/acme/">See all open roles</a>')
    // Nothing left to apply with: no Apply buttons leading to the confirmation.
    expect(page).not.toContain('Apply for this role')
    expect(renderJobPage(db, j, ctx, { action: '/x/apply' })).toContain('Apply for this role')
  })

  it('keep what was typed when nothing was sent for now, and say why first', () => {
    const db = buildSampleDB()
    const [j] = careerJobs(db, date)
    const page = renderJobPage(db, j, ctx, {
      action: '/x/apply',
      values: { name: 'Rosa Alvarez', email: 'rosa@example.com', answer: `A long answer ${XSS.textarea}` },
      refused: { heading: 'Too many applications from your network', message: `Your application was not sent. ${XSS.script}` },
    })
    expectInert(page)
    expect(page).toContain('<div class="errors" id="apply-errors" role="alert" aria-labelledby="apply-errors-h" tabindex="-1" autofocus>\n<h3 class="errors__title" id="apply-errors-h">Too many applications from your network</h3>')
    expect(page).toContain('value="rosa@example.com"')
    expect(page).toContain('>A long answer &lt;/textarea&gt;&lt;script&gt;alert(4)&lt;/script&gt;</textarea>')
    expect(page.indexOf('apply-errors')).toBeLessThan(page.indexOf('id="f-name"'))
  })

  it("leave out the headcount, and every fact a demo sign-up filled in that nobody changed since", () => {
    const db = structuredClone(buildSampleDB())
    const jobs = careerJobs(db, date)
    // The static demo shows the sample's headcount; a live page never shows a company's.
    expect(renderIndexPage(db, date, jobs, { links, mode: { kind: 'demo', appLink: '#a', appHome: '#b' } })).toContain('<dt>People</dt>')
    const index = renderIndexPage(db, date, jobs, ctx)
    expect(index).not.toContain('<dt>People</dt>')
    // A company with no sign-up defaults (the owner's own, the sample) shows its facts.
    expect(index).toContain(`Headquartered in ${db.company.hq.city}, ${db.company.hq.state}`)
    // A demo sign-up records what it filled in; those stay off the page until the company changes them.
    const signup = { hqCity: db.company.hq.city, hqState: db.company.hq.state, stage: db.company.stage, workweek: db.company.workweek, foundedOn: db.company.foundedOn }
    ;(db.meta as { signupDefaults?: unknown }).signupDefaults = signup
    const fresh = renderIndexPage(db, date, jobs, ctx)
    expect(fresh).not.toContain('Headquartered in')
    expect(fresh).not.toContain(`${db.company.stage} stage`)
    expect(fresh).not.toContain(`<li>${db.company.workweek}</li>`)
    expect(fresh).not.toContain('<dt>Founded</dt>')
    expect(companyFactsSet(db)).toEqual({ hq: false, stage: false, workweek: false, foundedOn: false })
    db.company.hq = { ...db.company.hq, city: 'Fresno' }
    db.company.stage = 'Series A'
    const edited = renderIndexPage(db, date, jobs, ctx)
    expect(edited).toContain(`Headquartered in Fresno, ${db.company.hq.state}`)
    expect(edited).toContain('Series A stage')
    expect(edited).not.toContain('<dt>Founded</dt>')
  })

  it('ask every role in a family a question that fits it', () => {
    // Go-to-market covers sales and customer success alike.
    expect(roleQuestion({ familyId: 'f-gtm' })).toBe('Tell us about a customer you won or kept. What made the difference?')
    expect(roleQuestion({ familyId: 'f-gtm' })).not.toMatch(/deal|close/i)
    const csm = careerJobs(buildSampleDB(), date).find((j) => /customer success/i.test(j.title))
    if (csm) expect(csm.question).toBe(roleQuestion({ familyId: 'f-gtm' }))
  })

  it('give each role an address that keeps working when it is renamed: its title, then its record id', () => {
    expect(jobAddress({ id: 'j-csm', title: 'Customer Success Manager' })).toBe('customer-success-manager-j-csm')
    expect(jobAddress({ id: 'j-csm', title: 'Head of Customers' })).toBe('head-of-customers-j-csm')
    expect(jobAddress({ id: 'J_9 x', title: '!!!' })).toBe('job-j-9-x')
    for (const j of careerJobs(buildSampleDB(), date)) expect(jobAddress(j)).toMatch(/^[a-z0-9-]+$/)
  })

  it('print the same posting as the static demo site', () => {
    const db = buildSampleDB()
    const demo: PageContext = { links, mode: { kind: 'demo', appLink: '#a', appHome: '#b' } }
    const posting = (html: string) => /<article class="posting"[\s\S]*?<\/article>/.exec(html)?.[0]
    for (const j of careerJobs(db, date)) {
      const a = posting(renderJobPage(db, j, demo))
      expect(a).toBeTruthy()
      expect(posting(renderJobPage(db, j, ctx, { action: '/x' }))).toBe(a)
    }
  })

  it('link the app only from the "make your own" places, and leave it out when there is no app origin', () => {
    const db = buildSampleDB()
    const jobs = careerJobs(db, date)
    const index = renderIndexPage(db, date, jobs, ctx)
    expect(index).toContain('href="https://hr.example.test/">Make your own careers page in First Twenty')
    expect(index).not.toContain('See the hiring side')
    const bare = renderIndexPage(db, date, jobs, { links, mode: { kind: 'live' } })
    expect(bare).not.toContain('hr.example.test')
    expect(bare).not.toContain('Make your own')
    for (const page of [index, bare]) {
      for (const m of page.matchAll(/\shref="([^"]*)"/g)) expect(m[1], m[1]).toMatch(/^(\/|#|data:|https:\/\/hr\.example\.test\/)/)
    }
  })

  it('keep the accessibility structure: one h1, labeled controls, headings in order', () => {
    const db = buildSampleDB()
    const jobs = careerJobs(db, date)
    const pages = [
      renderIndexPage(db, date, jobs, ctx),
      ...jobs.map((j) => renderJobPage(db, j, ctx, { action: '/x', values: {}, errors: { name: 'Enter your full name.' } })),
      renderMessagePage({ title: 'Page not found', kicker: 'Not found', heading: 'There is no careers page here', paragraphs: ['Check the address.'], assets: '/assets/' }),
    ]
    for (const page of pages) {
      expect(page).toContain('<html lang="en">')
      expect(page).toContain('<a class="skip" href="#main">')
      expect(page.match(/<h1[\s>]/g)?.length).toBe(1)
      expect(page).toContain('<meta name="robots" content="noindex, nofollow">')
      for (const m of page.matchAll(/<(?:input|textarea|select)[^>]*\sid="([^"]+)"/g)) {
        expect(page.includes(`<label class="field__label" for="${m[1]}">`), `${m[1]} has no label`).toBe(true)
      }
      let last = 0
      for (const m of page.matchAll(/<h([1-6])[\s>]/g)) {
        const level = Number(m[1])
        expect(level - last).toBeLessThanOrEqual(1)
        last = level
      }
    }
  })

  it('speak for every company on pages that belong to none, and for the company on its own', () => {
    const generic = renderMessagePage({ title: 'Careers', kicker: 'Careers', heading: 'Careers pages', paragraphs: ['One', 'Two'], assets: '/assets/' })
    expect(generic).toContain('These careers pages run on a First Twenty demo server, where anyone can create a company. A company or job here may not be real')
    expect(generic).toContain('<p class="lede">One</p>\n<p>Two</p>')
    expect(generic).toContain('check with the company before you share')
    const own = renderMessagePage({
      title: 'Not open',
      kicker: 'Not found',
      heading: 'This role is not open',
      paragraphs: [XSS.script],
      company: { name: XSS.img, home: '/acme/' },
      action: { href: '/acme/', label: 'See all open roles' },
      assets: '/assets/',
    })
    expectInert(own)
    expect(own).toContain('<a class="brand" href="/acme/">')
    expect(own).toContain('This careers page runs on a First Twenty demo server')
    expect(own).toContain('&quot;&gt;&lt;img src=x onerror=alert(2)&gt; and its jobs may not be real')
  })
})
