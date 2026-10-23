// The careers site generator (scripts/careers/build.ts), run into a temp dir: one page per open job,
// pay ranges and the full posting on every page, a fictional-company notice everywhere, links that
// resolve, no external URLs and nothing that could send what an applicant types.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { links } from '@/app/router'
import { postingText } from '@/domain/hiring/postings'
import { today } from '@/lib/dates'
import { money } from '@/lib/format'
import { loadSample } from '@/store/db'
import { appHref, buildCareers, type CareersBuild, esc, sentence } from './build'

let out = ''
let site: CareersBuild
const html = new Map<string, string>()

function walk(dir: string, base = ''): string[] {
  return readdirSync(join(dir, base), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(dir, join(base, e.name)) : [join(base, e.name).replace(/\\/g, '/')],
  )
}

/** Visible text: tags removed and the common entities decoded. */
function text(page: string): string {
  return page
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
}

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'ft-careers-'))
  site = buildCareers(out)
  for (const f of walk(out)) if (f.endsWith('.html')) html.set(f, readFileSync(join(out, f), 'utf8'))
})

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true })
})

describe('careers site', () => {
  it('writes one page per open, posted job and nothing for the rest', () => {
    const date = today()
    const db = loadSample()
    const open = db.jobs.filter((j) => j.status === 'open' && j.postedOn && j.postedOn <= date && j.requisition?.status !== 'pending')
    expect(open.length).toBeGreaterThan(0)
    const pages = [...html.keys()].filter((f) => f.startsWith('jobs/'))
    expect(pages.length).toBe(open.length)
    expect(site.jobs.map((j) => j.id).sort()).toEqual(open.map((j) => j.id).sort())
    for (const j of site.jobs) expect(html.has(`jobs/${j.slug}.html`)).toBe(true)
    // Drafts, holds and filled jobs never appear.
    const home = html.get('index.html') ?? ''
    for (const j of db.jobs.filter((x) => x.status !== 'open')) expect(home).not.toContain(`>${esc(j.title)}<`)
    for (const j of open) expect(home).toContain(esc(j.title))
  })

  it('shows every job pay range on its page and on the home page', () => {
    const db = loadSample()
    const home = html.get('index.html') ?? ''
    for (const j of site.jobs) {
      const job = db.jobs.find((x) => x.id === j.id)
      expect(job?.payMin).not.toBeNull()
      const page = html.get(`jobs/${j.slug}.html`) ?? ''
      expect(page).toContain(money(job?.payMin))
      expect(page).toContain(money(job?.payMax))
      expect(j.payFigure).toBe(`${money(job?.payMin)} to ${money(job?.payMax)}`)
      expect(home).toContain(j.payFigure as string)
    }
  })

  it('renders the full posting text on each job page', () => {
    const db = loadSample()
    for (const j of site.jobs) {
      const page = text(html.get(`jobs/${j.slug}.html`) ?? '')
      const lines = postingText(db, j.id, site.date).split('\n').slice(2).map((l) => l.trim()).filter(Boolean)
      expect(lines.length).toBeGreaterThan(10)
      for (const line of lines) expect(page).toContain(line.replace(/^-\s+/, ''))
    }
  })

  it('has no template leaks', () => {
    for (const [f, page] of html) {
      for (const bad of ['undefined', 'NaN', '{', '[object', 'null']) expect(page.includes(bad), `${f} contains ${bad}`).toBe(false)
    }
  })

  it('says on every page that Ledgerlark is fictional', () => {
    expect(site.company).toBe('Ledgerlark')
    for (const [f, page] of html) {
      const notice = /<p class="fiction">([\s\S]*?)<\/p>/.exec(page)
      expect(notice, f).not.toBeNull()
      const words = text(notice?.[1] ?? '')
      expect(words).toContain('Ledgerlark')
      expect(words).toContain('fictional')
      expect(words).toContain('First Twenty')
    }
  })

  it('links only to files it wrote, plus the app one level up', () => {
    const written = new Set(walk(out))
    const appIndex = resolve(out, '..', 'index.html')
    let appLinks = 0
    const check = (from: string, ref: string, page: string) => {
      if (ref.startsWith('data:')) return
      expect(/^[a-z]+:/i.test(ref) || ref.startsWith('/'), `${from}: ${ref} is not relative`).toBe(false)
      const [path, frag] = ref.split('#')
      if (!path) {
        expect(page.includes(`id="${frag}"`), `${from}: #${frag} missing`).toBe(true)
        return
      }
      const target = resolve(dirname(join(out, from)), path)
      if (target === appIndex) {
        appLinks++
        return
      }
      const rel = target.slice(resolve(out).length + 1).replace(/\\/g, '/')
      expect(written.has(rel), `${from}: ${ref} does not resolve`).toBe(true)
      if (frag) expect(readFileSync(target, 'utf8').includes(`id="${frag}"`), `${from}: ${ref} fragment missing`).toBe(true)
    }
    for (const [f, page] of html) {
      for (const m of page.matchAll(/\s(?:href|src)="([^"]*)"/g)) check(f, m[1], page)
    }
    const css = readFileSync(join(out, 'assets/careers.css'), 'utf8')
    for (const m of css.matchAll(/url\("?([^")]+)"?\)/g)) check('assets/careers.css', m[1], '')
    expect(appLinks).toBeGreaterThanOrEqual(html.size)
    for (const f of ['assets/careers.css', 'assets/apply.js', 'assets/archivo-latin-standard-normal.woff2', 'assets/LICENSE-Archivo.txt']) {
      expect(existsSync(join(out, f)), f).toBe(true)
    }
  })

  it('opens the app on its hiring routes: the Jobs list from home, the job pipeline from a job page', () => {
    // The app is one folder above the site root: ../index.html from home, ../../index.html from a job.
    const appLinks = (page: string, up: string) =>
      [...page.matchAll(/\shref="([^"]*)"/g)].map((m) => m[1]).filter((h) => h.startsWith(`${up}index.html`))
    const home = appLinks(html.get('index.html') ?? '', '../')
    expect(home.length).toBeGreaterThanOrEqual(3)
    for (const href of home) expect(href).toBe(`../index.html${links.hiring('jobs')}`)
    for (const j of site.jobs) {
      const page = html.get(`jobs/${j.slug}.html`) ?? ''
      const hrefs = appLinks(page, '../../')
      expect(hrefs, j.id).toContain(`../../index.html${links.job(j.id)}`)
      expect(hrefs, j.id).toContain(`../../index.html${links.hiring('jobs')}`)
      expect(hrefs.every((h) => h.startsWith('../../index.html#')), j.id).toBe(true)
      expect(page).toContain("See this job's pipeline in First Twenty")
    }
  })

  it('builds app links from one helper, relative by default and to any base on request', () => {
    expect(appHref(0, '#hiring.jobs')).toBe('../index.html#hiring.jobs')
    expect(appHref(1, '#job.j-ae')).toBe('../../index.html#job.j-ae')
    expect(appHref(1, 'job.j-ae', 'app/index.html')).toBe('../app/index.html#job.j-ae')
    expect(appHref(1, '#job.j-ae', 'https://example.org/ft/')).toBe('https://example.org/ft/#job.j-ae')
    expect(appHref(0, '#hiring.jobs', '/first-twenty/index.html#home')).toBe('/first-twenty/index.html#hiring.jobs')
    const alt = mkdtempSync(join(tmpdir(), 'ft-careers-alt-'))
    try {
      const b = buildCareers(alt, { appHref: 'https://example.org/ft/' })
      const page = readFileSync(join(alt, `jobs/${b.jobs[0].slug}.html`), 'utf8')
      expect(page).toContain(`href="https://example.org/ft/${links.job(b.jobs[0].id)}"`)
      expect(page).not.toContain('../../index.html')
    } finally {
      rmSync(alt, { recursive: true, force: true })
    }
  })

  it('names the work mode the posting describes, including hybrid jobs open to remote people', () => {
    const db = loadSample()
    for (const j of site.jobs) {
      const job = db.jobs.find((x) => x.id === j.id)
      const remote = job?.locationIds.some((id) => db.locations.find((l) => l.id === id)?.kind === 'remote')
      if (job?.workMode === 'hybrid' && remote) expect(j.workMode, j.id).toBe('Hybrid or remote')
      else expect(j.workMode.toLowerCase(), j.id).toBe(job?.workMode === 'onsite' ? 'on site' : job?.workMode)
      const page = html.get(`jobs/${j.slug}.html`) ?? ''
      expect(page).toContain(`<dt>Work mode</dt><dd>${esc(j.workMode)}</dd>`)
    }
    expect(site.jobs.find((j) => j.id === 'j-ae')?.workMode).toBe('Hybrid or remote')
  })

  it('ends prose lines with punctuation and keeps counts out of headings', () => {
    expect(sentence('AI close agents for mid-market controllers')).toBe('AI close agents for mid-market controllers.')
    expect(sentence('Already done.')).toBe('Already done.')
    const db = loadSample()
    const tagline = db.company.tagline.trim()
    for (const j of site.jobs) expect(html.get(`jobs/${j.slug}.html`)).toContain(`<p>${esc(sentence(tagline))}</p>`)
    const home = html.get('index.html') ?? ''
    for (const m of home.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)) expect(m[1], m[1]).not.toMatch(/\d|role/)
    expect(home).not.toContain('class="count"')
    expect(home).toContain('the pay range California requires')
  })

  it('makes no external requests and has no external URLs beyond the posting own links', () => {
    const db = loadSample()
    const allowed = new Set(site.jobs.flatMap((j) => postingText(db, j.id, site.date).match(/https?:\/\/[^\s)]+/g) ?? []))
    const files = [...html.keys(), 'assets/careers.css', 'assets/apply.js']
    for (const f of files) {
      const body = readFileSync(join(out, f), 'utf8')
      for (const url of body.match(/https?:\/\/[^\s"'<>)]+/g) ?? []) expect(allowed.has(url), `${f}: ${url}`).toBe(true)
      expect(body, f).not.toMatch(/fonts\.googleapis|cdn\.|unpkg|jsdelivr|<iframe|<img/i)
    }
  })

  it('never sends what an applicant types', () => {
    const js = readFileSync(join(out, 'assets/apply.js'), 'utf8')
    for (const bad of ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource', 'localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', '.submit()', 'mailto:', 'location.href =']) {
      expect(js.includes(bad), `apply.js uses ${bad}`).toBe(false)
    }
    for (const j of site.jobs) {
      const page = html.get(`jobs/${j.slug}.html`) ?? ''
      expect(page).not.toMatch(/\saction=|mailto:|formaction|<form(?![^>]*method="dialog")/i)
      expect(page).toContain('<form class="form" id="apply-form" method="dialog" novalidate')
      // The demo notice sits above the form, and the confirmation says nothing was sent or stored.
      expect(page.indexOf('Nothing you enter here is sent or stored')).toBeGreaterThan(-1)
      expect(page.indexOf('Nothing you enter here is sent or stored')).toBeLessThan(page.indexOf('<form'))
      expect(page).toContain('Nothing was sent or stored')
      expect(page).toContain('Voluntary self-identification')
      // The error summary that takes focus is announced by its heading.
      expect(page).toContain('id="apply-errors" role="group" aria-labelledby="apply-errors-h"')
      // The sticky facts column carries its own way to the form.
      expect(page).toMatch(/<p class="facts__apply"><a class="btn btn--primary[^"]*" href="#apply">Apply for this role<\/a><\/p>/)
    }
  })

  it('keeps the accessibility structure', () => {
    for (const [f, page] of html) {
      expect(page, f).toContain('<html lang="en">')
      expect(page, f).toContain('<a class="skip" href="#main">')
      expect(page, f).toContain('<main id="main"')
      expect(page.match(/<h1[\s>]/g)?.length, f).toBe(1)
      expect(page, f).toContain('name="viewport" content="width=device-width, initial-scale=1"')
      // Every form control has a label pointing at it.
      for (const m of page.matchAll(/<(?:input|textarea|select)[^>]*\sid="([^"]+)"/g)) {
        expect(page.includes(`<label class="field__label" for="${m[1]}">`), `${f}: ${m[1]} has no label`).toBe(true)
      }
      // Headings never skip a level.
      let last = 0
      for (const m of page.matchAll(/<h([1-6])[\s>]/g)) {
        const level = Number(m[1])
        expect(level - last, `${f}: h${last} then h${level}`).toBeLessThanOrEqual(1)
        last = level
      }
    }
    const css = readFileSync(join(out, 'assets/careers.css'), 'utf8')
    expect(css).toContain('prefers-reduced-motion: reduce')
    expect(css).toContain('prefers-color-scheme: dark')
    expect(css).toContain(':focus-visible')
    expect(css).toContain('forced-colors: active')
  })
})
