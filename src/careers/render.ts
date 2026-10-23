// Careers pages, shared by the static demo site (scripts/careers/build.ts) and the live careers pages of
// the server (server/src/careers/routes.ts): one markup, one stylesheet (careers.css beside this file) and
// the posting text First Twenty generates, rendered from one workspace's records.
//
// Two modes:
// - demo: the Ledgerlark sample as static files. Ledgerlark is fictional (docs/SAMPLE.md): every page says
//   so, links go to the app's hiring side, and the apply form sends nothing (method="dialog", apply.js).
// - live: a company's careers page on a First Twenty demo server, rendered per request from its workspace.
//   The apply form posts for real, into that company's pipeline, and every page says that anyone can
//   create a company on the server, so the company and its jobs may not be real.
//
// On the server the records come from whoever signed up, so every value from a workspace is escaped
// wherever it lands (element text, attributes, ids), and nothing from a record ever becomes a link. Pages
// carry no inline script or style (the careers CSP is style-src 'self'; script-src 'self'). This module
// imports no browser, router or store code, so the server bundle can use it.
import { eeoStatement, fairChanceStatement, payRangeLine, postingText } from '@/domain/hiring/postings'
import { headcountOn } from '@/domain/people'
import type { DB, Job } from '@/domain/types'
import { fmtDate, type ISODate } from '@/lib/dates'
import { slug as slugify } from '@/lib/files'

/** The stylesheet, the typeface and its license: the files every careers page loads from assets/. */
export const CSS_FILE = 'careers.css'
export const FONT_FILE = 'archivo-latin-standard-normal.woff2'
export const FONT_LICENSE = 'LICENSE-Archivo.txt'

export type CareerJob = {
  id: string
  slug: string
  title: string
  team: string
  teamId: string
  location: string
  workMode: string
  employment: string
  /** "$225,000 to $285,000", from the posting's own pay line; null when the job has no range. */
  payFigure: string | null
  /** "Base salary, plus equity" and the like, read from the posting's pay lines. */
  payNote: string
  postedOn: ISODate
  posting: string
  question: string
}

// ---- Helpers --------------------------------------------------------------------------------------

/** Escapes text for HTML element content and double-quoted attributes. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

/** Prose lines end with punctuation; a tagline stored without a period gets one. */
export function sentence(s: string): string {
  const t = s.trim()
  return !t || /[.!?:;)"'”]$/.test(t) ? t : `${t}.`
}

/** What the careers site lists: open, posted on or before the date, and not a request awaiting approval. */
export function isPublicJob(job: Job, date: ISODate): boolean {
  return job.status === 'open' && !!job.postedOn && job.postedOn <= date && job.requisition?.status !== 'pending'
}

/**
 * One question per role family for the apply form. Never pay history, never criminal history. A family
 * covers several kinds of role (go-to-market holds sales and customer success alike), so each question
 * fits every role in its family.
 */
export function roleQuestion(job: Pick<Job, 'familyId'>): string {
  switch (job.familyId) {
    case 'f-ml':
      return 'Tell us about an evaluation you designed that changed a decision about a model. What did it measure?'
    case 'f-eng':
      return 'Tell us about software you built that people trusted to be correct. How did you know it was?'
    case 'f-gtm':
      return 'Tell us about a customer you won or kept. What made the difference?'
    case 'f-acct':
      return 'Walk us through a close or reconciliation problem you untangled. What was the fix?'
    case 'f-solutions':
      return 'Tell us about a customer rollout that went sideways. What did you do next?'
    case 'f-product':
    case 'f-design':
      return 'Tell us about a product decision you changed your mind on, and why.'
    default:
      return 'What about this role made you want to apply?'
  }
}

/** An id attribute value from a record id: letters, digits, '-' and '_' only, unique within one page. */
function anchorId(prefix: string, raw: string, used: Set<string>): string {
  const base = `${prefix}-${raw.replace(/[^A-Za-z0-9_-]/g, '-') || 'x'}`
  let id = base
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`
  used.add(id)
  return id
}

// ---- Posting text -> HTML -------------------------------------------------------------------------

export type ParsedPosting = { title: string; location: string; workMode: string; employment: string; blocks: string[][] }

/** Splits postingText output: title, the location line, then blank-line blocks of trimmed lines. */
export function parsePosting(text: string): ParsedPosting {
  const lines = text.replace(/\r/g, '').trimEnd().split('\n')
  const title = (lines[0] ?? '').trim()
  const sub = (lines[1] ?? '').trim()
  const m = /^(.*) \((remote|on site|hybrid)\) \| (.+)$/.exec(sub)
  const blocks = lines
    .slice(2)
    .join('\n')
    .split(/\n\s*\n/)
    .map((b) => b.split('\n').map((l) => l.trim()).filter(Boolean))
    .filter((b) => b.length > 0)
  return { title, location: m ? m[1] : sub, workMode: m ? m[2] : '', employment: m ? m[3] : '', blocks }
}

const BULLET = /^[-•*]\s+(.*)$/

function isHeading(line: string): boolean {
  return line.length <= 60 && !BULLET.test(line) && !/[.!?:;,]$/.test(line)
}

function renderLines(lines: string[]): string {
  const out: string[] = []
  let list: string[] = []
  const flush = () => {
    if (list.length) out.push(`<ul class="ticks">\n${list.map((li) => `<li>${esc(li)}</li>`).join('\n')}\n</ul>`)
    list = []
  }
  for (const line of lines) {
    const bullet = BULLET.exec(line)
    if (bullet) {
      list.push(bullet[1])
      continue
    }
    flush()
    const fact = /^(Pay range|Equity|Benefits):\s+(.*)$/.exec(line)
    out.push(fact ? `<p><strong>${esc(fact[1])}:</strong> ${esc(sentence(fact[2]))}</p>` : `<p>${esc(sentence(line))}</p>`)
  }
  flush()
  return out.join('\n')
}

/**
 * The posting body as HTML. A block whose first line reads as a heading becomes a section with an h2.
 * The generated tail (sponsorship, background check, Fair Chance and EEO lines) sits under one
 * "Hiring practices" heading so it never reads as part of the section above it.
 */
export function postingBodyHtml(blocks: string[][], companyName: string): string {
  const legalLines = new Set([fairChanceStatement(companyName), eeoStatement(companyName)])
  const isLegal = (block: string[]) =>
    block.every(
      (l) =>
        legalLines.has(l) ||
        /^(We sponsor work visas|We are not able to sponsor|Visa sponsorship for this role)/.test(l) ||
        /^Offers depend on a background check/.test(l),
    )
  const parts: string[] = []
  const legal: string[] = []
  let sawLead = false
  let afterSection = false
  for (const block of blocks) {
    if (block.length > 1 && isHeading(block[0])) {
      parts.push(`<section class="psec">\n<h2 class="psec__h">${esc(block[0])}</h2>\n${renderLines(block.slice(1))}\n</section>`)
      afterSection = true
      continue
    }
    if (isLegal(block)) {
      legal.push(renderLines(block))
      continue
    }
    const cls = !sawLead ? 'pblock pblock--lead' : afterSection ? 'pblock pblock--after' : 'pblock'
    sawLead = true
    afterSection = false
    parts.push(`<div class="${cls}">\n${renderLines(block)}\n</div>`)
  }
  if (legal.length) parts.push(`<section class="psec psec--fine">\n<h2 class="psec__h">Hiring practices</h2>\n${legal.join('\n')}\n</section>`)
  return parts.join('\n')
}

// ---- Data -----------------------------------------------------------------------------------------

/**
 * The jobs a careers site lists on `date` (isPublicJob), by department order, newest posting first, then
 * title, each with its posting text, short facts and a slug that is unique within the list.
 */
export function careerJobs(db: DB, date: ISODate): CareerJob[] {
  const used = new Set<string>()
  const deptOrder = new Map(db.departments.map((d, i) => [d.id, i]))
  const jobs = db.jobs
    .filter((j) => isPublicJob(j, date))
    .sort(
      (a, b) =>
        (deptOrder.get(a.departmentId) ?? 99) - (deptOrder.get(b.departmentId) ?? 99) ||
        (b.postedOn ?? '').localeCompare(a.postedOn ?? '') ||
        a.title.localeCompare(b.title),
    )
  return jobs.map((job) => {
    const posting = postingText(db, job.id, date)
    const parsed = parsePosting(posting)
    const base = slugify(job.title) || slugify(job.id) || 'job'
    let s = base
    for (let n = 2; used.has(s); n++) s = `${base}-${n}`
    used.add(s)
    const payLine = payRangeLine(job)
    const pm = payLine ? /^Pay range: (.+?) (base salary|an hour)\. /.exec(payLine) : null
    const hourly = pm?.[2] === 'an hour'
    const lines = posting.split('\n')
    const variable = lines.find((l) => l.startsWith('Plus variable pay'))
    const extras: string[] = []
    if (variable) extras.push(variable.includes('(commission)') ? 'commission' : 'variable pay')
    if (lines.some((l) => l.startsWith('Equity:'))) extras.push('equity')
    const basis = !pm ? 'Pay range available on request' : hourly ? 'Hourly' : 'Base salary'
    const dept = db.departments.find((d) => d.id === job.departmentId)
    // A hybrid job that also lists a remote location (San Jose or Remote (California)) is open to
    // remote people too, so the short work-mode label says both, as the posting's own text does.
    const remoteToo = job.workMode === 'hybrid' && job.locationIds.some((id) => db.locations.find((l) => l.id === id)?.kind === 'remote')
    return {
      id: job.id,
      slug: s,
      title: parsed.title || job.title,
      team: dept?.name ?? 'Team',
      teamId: dept?.id ?? 'team',
      location: parsed.location,
      workMode: remoteToo ? 'Hybrid or remote' : cap(parsed.workMode),
      employment: parsed.employment,
      payFigure: pm ? (hourly ? `${pm[1]} an hour` : pm[1]) : null,
      payNote: extras.length ? `${basis}, plus ${extras.join(' and ')}` : basis,
      postedOn: job.postedOn as ISODate,
      posting,
      question: roleQuestion(job),
    }
  })
}

/**
 * A job's address on a live careers page: its title and its record id, like
 * senior-engineer-j-3fa9c0b1d2. The id part never changes, so a link shared before the role was renamed
 * still finds it (the server sends it on to the new address); the title part is only there to read.
 */
export function jobAddress(j: Pick<CareerJob, 'id' | 'title'>): string {
  const trim = (s: string) => s.replace(/^-+|-+$/g, '')
  return `${trim(slugify(j.title)) || 'job'}-${jobIdToken(j)}`
}

/** The record-id part of a job's address (jobAddress). */
export function jobIdToken(j: Pick<CareerJob, 'id'>): string {
  return slugify(j.id).replace(/^-+|-+$/g, '') || 'x'
}

// ---- Modes and links ------------------------------------------------------------------------------

/** Where a page's links go: relative files (the static site) or root paths on a careers host (the server). */
export type PageLinks = {
  /** The company's careers home (every open role), from this page. */
  home: string
  /** A job's page, from this page. */
  job: (j: CareerJob) => string
  /** A file in assets/, from this page. */
  asset: (file: string) => string
}

/** The static demo: a fictional company, links into the app's hiring side, a form that sends nothing. */
export type DemoMode = {
  kind: 'demo'
  /** The masthead's app link: the hiring side for this page (the job's pipeline on a job page). */
  appLink: string
  /** The footer's app link: the hiring overview. */
  appHome: string
}

/** The server: a company's live careers page on a demo server where anyone can create a company. */
export type LiveMode = {
  kind: 'live'
  /** The First Twenty app on this server (PUBLIC_ORIGIN), for the "make your own" links. Optional. */
  appOrigin?: string
}

export type PageContext = { links: PageLinks; mode: DemoMode | LiveMode }

/** The live apply form's fields, in page order (ids are f-<name>). */
export const APPLY_FIELDS = ['name', 'email', 'phone', 'link', 'answer'] as const
export type ApplyField = (typeof APPLY_FIELDS)[number]
export type ApplyValues = Partial<Record<ApplyField, string>>
export type ApplyErrors = Partial<Record<ApplyField | 'website', string>>

/** Most characters each live form field takes (the server refuses more; the inputs say so too). */
export const APPLY_MAX: Record<ApplyField, number> = { name: 120, email: 254, phone: 40, link: 300, answer: 2000 }

/** What a live job page shows in its apply section. */
export type LiveApply = {
  /** Where the form posts (the job's apply path). */
  action: string
  values?: ApplyValues
  errors?: ApplyErrors
  /**
   * The form was fine but nothing was sent (too many applications for now): this message tops the form,
   * which keeps what was typed so nothing is lost.
   */
  refused?: { heading: string; message: string }
  /** The application was received: the confirmation replaces the form (and the Apply buttons go). */
  applied?: boolean
}

// ---- Page shell -----------------------------------------------------------------------------------

type Shell = {
  title: string
  description: string
  /** The masthead's name: the company, or First Twenty on the careers host's own pages. */
  company: string
  /** Live pages that belong to no company (the landing page, an unknown address): the notice speaks for all. */
  noCompany?: boolean
  /** Where the brand in the masthead goes. */
  brandHref: string
  /** The stylesheet's address. */
  css: string
  /** The typeface license's address. */
  license: string
  mode: DemoMode | LiveMode
  body: string
  /** The demo apply script's address, on pages with the demo form. */
  script?: string
}

function shell(p: Shell): string {
  const demo = p.mode.kind === 'demo' ? p.mode : null
  const appOrigin = p.mode.kind === 'live' ? p.mode.appOrigin : undefined
  const nav = demo
    ? `<nav class="masthead__nav" aria-label="Demo">
<a class="masthead__demo" href="${esc(demo.appLink)}">See the hiring side in First Twenty<span aria-hidden="true">&nbsp;→</span></a>
</nav>
`
    : ''
  const notice = demo
    ? `<p class="fiction"><span class="fiction__tag">Demo</span><span>${esc(p.company)} is a fictional company used to demo First Twenty. These jobs are not real, and applying sends nothing.</span></p>`
    : `<p class="fiction"><span class="fiction__tag">Demo server</span><span>${p.noCompany ? 'These careers pages run' : 'This careers page runs'} on a First Twenty demo server, where anyone can create a company. ${p.noCompany ? 'A company or job here' : `${esc(p.company)} and its jobs`} may not be real, so never send ID numbers, bank details or passwords here.</span></p>`
  const footNote = demo
    ? `<p class="foot__note"><strong>${esc(p.company)} is fictional.</strong> Its people, jobs and investors are sample data in First Twenty, a hiring and HR app for a company's first twenty people. Nothing here is a real job, and the application form never sends or stores what you type.</p>`
    : `<p class="foot__note"><strong>Hosted on a First Twenty demo server.</strong> First Twenty is a hiring and HR app for a company's first twenty people. Anyone can create a company on this server, and demo companies are deleted after a while without use, so check with ${p.noCompany ? 'the company' : esc(p.company)} before you share anything sensitive.</p>`
  const footLinks = demo
    ? `<li><a href="${esc(demo.appHome)}">See the hiring side in First Twenty</a></li>\n`
    : appOrigin
      ? `<li><a href="${esc(appOrigin)}/">Try First Twenty</a></li>\n`
      : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex, nofollow">
<meta name="description" content="${esc(p.description)}">
<title>${esc(p.title)}</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="${esc(p.css)}">
</head>
<body>
<a class="skip" href="#main">Skip to main content</a>
<header class="masthead">
<div class="wrap masthead__bar">
<a class="brand" href="${esc(p.brandHref)}"><span class="brand__mark" aria-hidden="true"></span><span class="brand__name">${esc(p.company)}</span><span class="brand__sub">Careers</span></a>
${nav}</div>
</header>
<main id="main" tabindex="-1">
<div class="wrap">
${notice}
${p.body}
</div>
</main>
<footer class="foot">
<div class="wrap">
<div class="foot__grid">
${footNote}
<ul class="foot__links">
${footLinks}<li><a href="${esc(p.license)}">Archivo typeface license (SIL OFL 1.1)</a></li>
</ul>
</div>
</div>
</footer>
${p.script ? `<script src="${esc(p.script)}" defer></script>\n` : ''}</body>
</html>
`
}

// ---- Pages ----------------------------------------------------------------------------------------

/**
 * Which company facts the company set itself rather than took from a demo sign-up's defaults
 * (meta.signupDefaults, written by the sign-up): a fact still equal to its default was never chosen.
 * Companies without that record (the owner's own, anything made before it) set every fact.
 */
export function companyFactsSet(db: Pick<DB, 'company' | 'meta'>): { hq: boolean; stage: boolean; workweek: boolean; foundedOn: boolean } {
  const d = (db.meta as { signupDefaults?: unknown } | undefined)?.signupDefaults
  if (!d || typeof d !== 'object') return { hq: true, stage: true, workweek: true, foundedOn: true }
  const defaults = d as Partial<Record<'hqCity' | 'hqState' | 'stage' | 'workweek' | 'foundedOn', unknown>>
  const c = db.company
  return {
    hq: c.hq?.city !== defaults.hqCity || c.hq?.state !== defaults.hqState,
    stage: c.stage !== defaults.stage,
    workweek: c.workweek !== defaults.workweek,
    foundedOn: c.foundedOn !== defaults.foundedOn,
  }
}

/** The company's careers home: who they are, then every open role by team. */
export function renderIndexPage(db: DB, date: ISODate, jobs: CareerJob[], ctx: PageContext): string {
  const { links, mode } = ctx
  const c = db.company
  const name = c.name
  const teams: Array<{ id: string; name: string; jobs: CareerJob[] }> = []
  for (const j of jobs) {
    let t = teams.find((x) => x.id === j.teamId)
    if (!t) teams.push((t = { id: j.teamId, name: j.team, jobs: [] }))
    t.jobs.push(j)
  }
  // A live page leaves out what a demo sign-up filled in for the company and nobody changed since (its
  // headquarters, stage, workweek and founding date), so it never states a made-up fact in public.
  const set = mode.kind === 'live' ? companyFactsSet(db) : { hq: true, stage: true, workweek: true, foundedOn: true }
  const founded = set.foundedOn ? (c.foundedOn ?? '').slice(0, 4) : ''
  const facts = [
    set.stage && c.stage ? `${c.stage} stage` : '',
    set.hq && c.hq?.city ? `Headquartered in ${c.hq.city}, ${c.hq.state}` : '',
    set.workweek ? (c.workweek ?? '') : '',
  ]
    .filter(Boolean)
    .map((f) => `<li>${esc(f)}</li>`)
    .join('')
  const figure = (label: string, value: string) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`
  const roleRow = (j: CareerJob) => `<li class="role">
<div class="role__main">
<h4 class="role__title"><a class="role__link" href="${esc(links.job(j))}">${esc(j.title)}</a></h4>
<p class="role__meta">${esc([j.location, j.workMode, j.employment].filter(Boolean).join(' · '))}</p>
</div>
<div class="role__side">
<p class="role__pay"><span class="vh">Pay range: </span>${esc(j.payFigure ?? 'Pay range on request')}</p>
<p class="role__note">${esc(j.payNote)}</p>
<p class="role__posted">Posted <time datetime="${esc(j.postedOn)}">${esc(fmtDate(j.postedOn))}</time></p>
</div>
</li>`
  // A per-team count only says something when some team has more than one role; it sits outside the
  // heading so the heading reads as the team's name alone.
  const showCounts = teams.some((t) => t.jobs.length > 1)
  const ids = new Set<string>()
  const teamBlocks = teams.length
    ? teams
        .map((t) => {
          const id = anchorId('team', t.id, ids)
          return `<section class="team" aria-labelledby="${id}">
<div class="team__head">
<h3 class="team__name" id="${id}">${esc(t.name)}</h3>
${showCounts ? `<p class="team__count">${t.jobs.length} ${t.jobs.length === 1 ? 'role' : 'roles'}</p>\n` : ''}</div>
<ul class="roles">
${t.jobs.map(roleRow).join('\n')}
</ul>
</section>`
        })
        .join('\n')
    : `<p class="empty">No open roles right now. Check back soon.</p>`
  const about =
    mode.kind === 'demo'
      ? `<p class="about__text">Every posting here is generated by First Twenty from the job record, with the pay range California requires, benefits, Fair Chance and equal opportunity language included. The apply form is a demo: nothing you type is sent or stored.</p>
<p class="about__action"><a class="btn btn--secondary btn--lg" href="${esc(mode.appHome)}">See the hiring side in First Twenty<span aria-hidden="true">&nbsp;→</span></a></p>`
      : `<p class="about__text">Every posting here is generated by First Twenty from ${esc(name)}'s job records, with the pay range, benefits, Fair Chance and equal opportunity language included. Applications go to ${esc(name)}'s hiring team in First Twenty. This is a demo server where anyone can create a company, so send only what you would put on a public profile.</p>${
          mode.appOrigin
            ? `\n<p class="about__action"><a class="btn btn--secondary btn--lg" href="${esc(mode.appOrigin)}/">Make your own careers page in First Twenty<span aria-hidden="true">&nbsp;→</span></a></p>`
            : ''
        }`
  const body = `<div class="pagehead">
<p class="kicker">Careers</p>
<h1 class="pagehead__title">Work at ${esc(name)}</h1>
${c.tagline?.trim() ? `<p class="lede">${esc(sentence(c.tagline))}</p>` : ''}
<ul class="facts-line">${facts}</ul>
<dl class="figures">
${figure('Open roles', String(jobs.length))}
${figure('Teams hiring', String(teams.length))}
${mode.kind === 'demo' ? figure('People', String(headcountOn(db, date))) : ''}
${founded ? figure('Founded', founded) : ''}
</dl>
</div>
<section class="section" aria-labelledby="roles-h">
<div class="section__head"><h2 class="label" id="roles-h">Open roles</h2></div>
${teamBlocks}
</section>
<section class="section about" aria-labelledby="about-h">
<div class="section__head"><h2 class="label" id="about-h">About these pages</h2></div>
<div class="about__grid">
${about}
</div>
</section>`
  return shell({
    title: mode.kind === 'demo' ? `Careers at ${name} (demo)` : `Careers at ${name}`,
    description: mode.kind === 'demo' ? `Open roles at ${name}, a fictional company used to demo First Twenty.` : `Open roles at ${name}.`,
    company: name,
    brandHref: links.home,
    css: links.asset(CSS_FILE),
    license: links.asset(FONT_LICENSE),
    mode,
    body,
  })
}

type FieldSpec = {
  id: string
  label: string
  type: string
  auto?: string
  mode?: string
  optional?: boolean
  hint?: string
  /** Live form only: what was typed, the problem with it, and the most characters it takes. */
  value?: string
  error?: string
  max?: number
}

function field(o: FieldSpec): string {
  const described = [o.hint ? `${o.id}-hint` : '', `${o.id}-error`].filter(Boolean).join(' ')
  const live = (o.max !== undefined ? ` maxlength="${o.max}"` : '') + (o.value ? ` value="${esc(o.value)}"` : '') + (o.error ? ' aria-invalid="true"' : '')
  return `<div class="field">
<label class="field__label" for="${o.id}">${esc(o.label)}${o.optional ? ' <span class="opt">(optional)</span>' : ''}</label>
${o.hint ? `<p class="field__hint" id="${o.id}-hint">${esc(o.hint)}</p>\n` : ''}<input class="input" id="${o.id}" name="${o.id.slice(2)}" type="${o.type}"${o.auto ? ` autocomplete="${o.auto}"` : ''}${o.mode ? ` inputmode="${o.mode}"` : ''}${o.optional ? '' : ' required'}${live} aria-describedby="${described}">
${fieldError(o.id, o.error)}
</div>`
}

function fieldError(id: string, error: string | undefined): string {
  return error ? `<p class="field__error" id="${id}-error">${esc(error)}</p>` : `<p class="field__error" id="${id}-error" hidden></p>`
}

/** The demo form: checked in the tab by apply.js, sends nothing. */
function demoApplyBody(name: string, j: CareerJob, pipeline: string): string {
  return `<div class="demo-note" id="apply-demo" role="note">
<p class="demo-note__lead">This is a demo. Nothing you enter here is sent or stored.</p>
<p>${esc(name)} is a fictional company, so this form goes nowhere. It checks your answers in this browser tab, shows a confirmation, and clears itself.</p>
</div>
<form class="form" id="apply-form" method="dialog" novalidate aria-describedby="apply-demo">
<div class="errors" id="apply-errors" role="group" aria-labelledby="apply-errors-h" tabindex="-1" hidden>
<h3 class="errors__title" id="apply-errors-h"></h3>
<ul class="errors__list"></ul>
</div>
<p class="form__req">All fields are required unless marked optional.</p>
${field({ id: 'f-name', label: 'Full name', type: 'text', auto: 'name' })}
${field({ id: 'f-email', label: 'Email', type: 'email', auto: 'email', mode: 'email' })}
${field({ id: 'f-phone', label: 'Phone', type: 'tel', auto: 'tel', mode: 'tel', optional: true })}
${field({ id: 'f-link', label: 'LinkedIn or portfolio', type: 'url', auto: 'url', mode: 'url', optional: true, hint: 'A web address, like linkedin.com/in/yourname' })}
<div class="field">
<label class="field__label" for="f-resume">Resume <span class="opt">(optional)</span></label>
<p class="field__hint" id="f-resume-hint">PDF, Word or text file, up to 10 MB. The demo looks at the file name and size in this tab and never uploads it.</p>
<input class="file" id="f-resume" name="resume" type="file" accept=".pdf,.doc,.docx,.txt,.rtf,.odt" aria-describedby="f-resume-hint f-resume-error">
<p class="field__error" id="f-resume-error" hidden></p>
</div>
<div class="field">
<label class="field__label" for="f-answer">${esc(j.question)}</label>
<p class="field__hint" id="f-answer-hint">A few sentences is plenty. If you need an accommodation to apply or interview, you can say so here too.</p>
<textarea class="input textarea" id="f-answer" name="answer" rows="6" maxlength="2000" required aria-describedby="f-answer-hint f-answer-error"></textarea>
<p class="field__error" id="f-answer-error" hidden></p>
</div>
<div class="selfid" role="note" aria-labelledby="selfid-h">
<h3 class="selfid__h" id="selfid-h">Voluntary self-identification</h3>
<p>${esc(name)} may invite applicants to share gender, race or ethnicity, veteran status and disability status. Answering is always voluntary and declining never affects your application. Answers are kept apart from your application, are not seen by the people making the hiring decision, and are used only for equal opportunity reporting under California and federal law. This demo form does not ask.</p>
</div>
<div class="form__actions">
<button class="btn btn--primary btn--lg" type="submit">Submit application</button>
<p class="form__fine">Demo: submitting shows a confirmation and sends nothing.</p>
</div>
<noscript><p class="form__fine">This demo form needs JavaScript to check your answers. Without it the button does nothing, and nothing is ever sent.</p></noscript>
</form>
<div class="done" id="apply-done" hidden>
<p class="status status--good done__status"><span class="status__mark" aria-hidden="true"></span>Demo complete</p>
<h3 class="done__title" id="apply-done-h" tabindex="-1">Nothing was sent or stored</h3>
<p id="apply-done-thanks">Thanks for trying the demo.</p>
<p>${esc(name)} is a fictional company used to demo First Twenty, so your application did not go to anyone. What you typed never left this browser tab, and the form has been cleared.</p>
<p>In a real First Twenty workspace, an application like this lands in the hiring team's pipeline for the job.</p>
<div class="done__actions">
<a class="btn btn--secondary btn--lg" href="${esc(pipeline)}">See this job's pipeline in First Twenty</a>
<button class="btn btn--ghost btn--lg" type="button" id="apply-again">Start over</button>
</div>
</div>`
}

/**
 * The live form: posts to the server, which checks it and answers with this page again (problems listed
 * at the top, which takes focus, and what was typed kept) or a redirect to the confirmation. It works
 * without any script, so the page needs none.
 */
function liveApplyBody(name: string, j: CareerJob, links: PageLinks, apply: LiveApply): string {
  if (apply.applied) {
    // role="status" announces it even where focus does not move; the heading takes focus (autofocus works
    // because the confirmation's address has no fragment).
    return `<div class="done" id="apply-done" role="status">
<p class="status status--good done__status"><span class="status__mark" aria-hidden="true"></span>Application sent</p>
<h3 class="done__title" id="apply-done-h" tabindex="-1" autofocus>Thanks for applying</h3>
<p>Your application went to ${esc(name)}'s hiring team in First Twenty (a demo server). If they want to talk, they will write to the email address you gave.</p>
<div class="done__actions">
<a class="btn btn--secondary btn--lg" href="${esc(links.home)}">See all open roles</a>
</div>
</div>`
  }
  const values = apply.values ?? {}
  const errors = apply.errors ?? {}
  // The hidden anti-spam field is never shown, so its problem points at the first field.
  const problems = (['website', 'name', 'email', 'phone', 'link', 'answer'] as const).flatMap((k) =>
    errors[k] ? [{ id: k === 'website' ? 'f-name' : `f-${k}`, message: errors[k] }] : [],
  )
  // The problems (or why nothing was sent) take focus and are announced (role="alert"): the answer to a
  // post is this page at an address without a fragment, where autofocus works.
  const summary = problems.length
    ? `<div class="errors" id="apply-errors" role="alert" aria-labelledby="apply-errors-h" tabindex="-1" autofocus>
<h3 class="errors__title" id="apply-errors-h">${problems.length === 1 ? 'There is 1 problem with the form' : `There are ${problems.length} problems with the form`}</h3>
<ul class="errors__list">
${problems.map((p) => `<li><a href="#${p.id}">${esc(p.message)}</a></li>`).join('\n')}
</ul>
</div>
`
    : apply.refused
      ? `<div class="errors" id="apply-errors" role="alert" aria-labelledby="apply-errors-h" tabindex="-1" autofocus>
<h3 class="errors__title" id="apply-errors-h">${esc(apply.refused.heading)}</h3>
<p>${esc(apply.refused.message)}</p>
</div>
`
      : ''
  const live = (k: ApplyField) => ({ value: values[k], error: errors[k], max: APPLY_MAX[k] })
  return `<div class="demo-note" id="apply-demo" role="note">
<p class="demo-note__lead">Your application goes to ${esc(name)}'s hiring team in First Twenty (a demo server).</p>
<p>What you send is stored in ${esc(name)}'s workspace on this server, where its hiring team sees it in their pipeline. Anyone can create a company on this demo server, so send only what you would put on a public profile. There is no resume upload: add a link instead.</p>
</div>
<form class="form" id="apply-form" method="post" action="${esc(apply.action)}" accept-charset="utf-8" novalidate aria-describedby="apply-demo">
${summary}<p class="form__req">All fields are required unless marked optional.</p>
${field({ id: 'f-name', label: 'Full name', type: 'text', auto: 'name', ...live('name') })}
${field({ id: 'f-email', label: 'Email', type: 'email', auto: 'email', mode: 'email', ...live('email') })}
${field({ id: 'f-phone', label: 'Phone', type: 'tel', auto: 'tel', mode: 'tel', optional: true, ...live('phone') })}
${field({ id: 'f-link', label: 'LinkedIn, portfolio or resume link', type: 'url', auto: 'url', mode: 'url', optional: true, hint: 'A web address, like linkedin.com/in/yourname', ...live('link') })}
<div class="field">
<label class="field__label" for="f-answer">${esc(j.question)}</label>
<p class="field__hint" id="f-answer-hint">A few sentences is plenty. If you need an accommodation to apply or interview, you can say so here too.</p>
<textarea class="input textarea" id="f-answer" name="answer" rows="6" maxlength="${APPLY_MAX.answer}" required${errors.answer ? ' aria-invalid="true"' : ''} aria-describedby="f-answer-hint f-answer-error">${esc(values.answer ?? '')}</textarea>
${fieldError('f-answer', errors.answer)}
</div>
<div class="field" hidden>
<label class="field__label" for="f-website">Leave this field empty</label>
<input class="input" id="f-website" name="website" type="text" autocomplete="off" tabindex="-1" maxlength="200">
</div>
<div class="selfid" role="note" aria-labelledby="selfid-h">
<h3 class="selfid__h" id="selfid-h">Voluntary self-identification</h3>
<p>${esc(name)} may invite applicants to share gender, race or ethnicity, veteran status and disability status. Answering is always voluntary and declining never affects your application. Answers are kept apart from your application, are not seen by the people making the hiring decision, and are used only for equal opportunity reporting under California and federal law. This form does not ask.</p>
</div>
<div class="form__actions">
<button class="btn btn--primary btn--lg" type="submit">Submit application</button>
<p class="form__fine">Submitting sends your application to ${esc(name)}'s hiring team.</p>
</div>
</form>`
}

/** One job: the facts, the full posting and the apply form (the demo's, or the live one when `apply` is given). */
export function renderJobPage(db: DB, j: CareerJob, ctx: PageContext, apply?: LiveApply): string {
  const { links, mode } = ctx
  const name = db.company.name
  const meta = [j.location, j.workMode, j.employment].filter(Boolean).join(' · ')
  const parsed = parsePosting(j.posting)
  const fact = (label: string, value: string, cls = '') => `<div${cls ? ` class="${cls}"` : ''}><dt>${esc(label)}</dt><dd>${value}</dd></div>`
  const applyBody =
    mode.kind === 'demo' ? demoApplyBody(name, j, mode.appLink) : liveApplyBody(name, j, links, apply ?? { action: `${links.job(j)}/apply` })
  // Once the application is in, there is nothing left to apply with: the buttons would only lead to the
  // confirmation.
  const sent = mode.kind === 'live' && apply?.applied === true
  const body = `<p class="crumbs"><a class="back" href="${esc(links.home)}"><span aria-hidden="true">←&nbsp;</span>All open roles</a></p>
<div class="pagehead pagehead--job">
<div class="pagehead__text">
<p class="kicker">${esc(j.team)}</p>
<h1 class="pagehead__title" id="job-title">${esc(j.title)}</h1>
<p class="subtitle">${esc(meta)}</p>
</div>
${sent ? '' : '<a class="btn btn--primary btn--lg" href="#apply">Apply for this role</a>\n'}</div>
<div class="job">
<aside class="facts" aria-labelledby="facts-h">
<div class="facts__inner">
<h2 class="label facts__h" id="facts-h">At a glance</h2>
<dl class="facts__list">
${fact('Pay range', `<span class="fig">${esc(j.payFigure ?? 'On request')}</span><span class="facts__sub">${esc(j.payNote)}</span>`, 'facts__pay')}
${fact('Location', esc(j.location))}
${fact('Work mode', esc(j.workMode))}
${fact('Employment', esc(j.employment))}
${fact('Team', esc(j.team))}
${fact('Posted', `<time datetime="${esc(j.postedOn)}">${esc(fmtDate(j.postedOn))}</time>`)}
${fact('Status', '<span class="status status--good"><span class="status__mark" aria-hidden="true"></span>Open</span>')}
</dl>
${sent ? '' : '<p class="facts__apply"><a class="btn btn--primary btn--lg btn--block" href="#apply">Apply for this role</a></p>\n'}</div>
</aside>
<article class="posting" aria-labelledby="job-title">
${postingBodyHtml(parsed.blocks, name)}
</article>
</div>
<section class="apply" id="apply" aria-labelledby="apply-h">
<div class="apply__grid">
<div class="apply__intro">
<div class="apply__sticky">
<h2 class="apply__h" id="apply-h"><span class="label">Apply</span><span class="vh"> for </span><span class="apply__title">${esc(j.title)}</span></h2>
<p class="apply__meta">${esc(meta)}</p>
<p class="apply__pay"><span class="vh">Pay range: </span><span class="fig">${esc(j.payFigure ?? 'Pay range on request')}</span><span class="facts__sub">${esc(j.payNote)}</span></p>
</div>
</div>
<div class="apply__body">
${applyBody}
</div>
</div>
</section>`
  const demo = mode.kind === 'demo'
  return shell({
    title: demo ? `${j.title} at ${name} (demo careers)` : `${j.title} at ${name}`,
    description: `${j.title}, ${j.location}. ${j.payFigure ? `Pay range ${j.payFigure}. ` : ''}${demo ? `${name} is a fictional company used to demo First Twenty.` : `Open role at ${name}.`}`,
    company: name,
    brandHref: links.home,
    css: links.asset(CSS_FILE),
    license: links.asset(FONT_LICENSE),
    mode,
    body,
    ...(demo ? { script: links.asset('apply.js') } : {}),
  })
}

export type MessagePage = {
  /** The <title>. */
  title: string
  kicker: string
  heading: string
  /** Plain-text paragraphs (escaped). */
  paragraphs: string[]
  /** The company the page belongs to, when there is one (its careers home is the brand link). */
  company?: { name: string; home: string }
  /** One button: a way on from here. */
  action?: { href: string; label: string }
  /** The assets folder's address, '/assets/' on a careers host. */
  assets: string
  appOrigin?: string
}

/**
 * A live page with a message and no jobs: the careers host's landing page, not found, too many
 * applications, a problem showing the page. It keeps the company's masthead when there is a company.
 */
export function renderMessagePage(p: MessagePage): string {
  const body = `<div class="pagehead">
<p class="kicker">${esc(p.kicker)}</p>
<h1 class="pagehead__title">${esc(p.heading)}</h1>
${p.paragraphs.map((t, i) => (i === 0 ? `<p class="lede">${esc(t)}</p>` : `<p>${esc(t)}</p>`)).join('\n')}
</div>
${p.action ? `<p class="about__action"><a class="btn btn--primary btn--lg" href="${esc(p.action.href)}">${esc(p.action.label)}</a></p>\n` : ''}`
  return shell({
    title: p.title,
    description: p.title,
    company: p.company?.name ?? 'First Twenty',
    noCompany: !p.company,
    brandHref: p.company?.home ?? '/',
    css: `${p.assets}${CSS_FILE}`,
    license: `${p.assets}${FONT_LICENSE}`,
    mode: { kind: 'live', ...(p.appOrigin ? { appOrigin: p.appOrigin } : {}) },
    body,
  })
}
