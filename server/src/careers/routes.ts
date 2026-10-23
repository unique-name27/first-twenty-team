// Live careers pages (docs/SERVER.md, "Careers pages"). On a careers host (CAREERS_HOSTS) every company on
// the server whose careers page is on (workspaces.careers) has a careers page at /<slug>/ and a page per
// open job, rendered per request from its workspace by the renderer the static demo site uses
// (src/careers/render.ts, live mode). The apply form posts back here, and the candidate, the application
// and their activity rows land in that company's pipeline through the sync write path (repo.ts
// applyChanges, markActive: false), so the change log records them and every connected browser receives
// them on its next pull.
//
// Routes, on careers hosts only (each carries a host constraint and config.careers, and app.ts answers
// nothing else on those hosts; HEAD goes with every GET):
//   GET  /                               a landing page, with no directory of companies
//   GET  /robots.txt                     Disallow: / (a demo server; every page also says noindex)
//   GET  /assets/<file>                  careers.css, the Archivo font and its license, from memory
//   GET  /<slug>                         301 to /<slug>/
//   GET  /<slug>/                        the company's open roles (isPublicJob, as on the static site)
//   GET  /<slug>/jobs/<job>              one open role, at its address (render.ts jobAddress: its title
//                                        and record id), with the apply form; any other way to the same
//                                        role (an address from before a rename, the bare title or id, a
//                                        trailing slash) is a 301 to that address. ?applied=<proof> shows
//                                        the confirmation in place of the form, for a real send only
//   POST /<slug>/jobs/<job>/apply        the form (application/x-www-form-urlencoded, 32 KB at most):
//                                        303 to ?applied=<proof>, or the form again with its problems
//                                        (400) or with why nothing was sent (429), what was typed kept
//   GET  anything else                   a 404 page (the company's own when the address names one)
// A slug with capital letters is a 301 to the same address in lowercase.
//
// Abuse limits: limits.ts (form posts and applications per address, applications per company per day,
// each taken before any await), a hidden field bots fill, a form accepted only from its own page
// (Sec-Fetch-Site, Origin), every field length-capped and checked (src/careers/application.ts), no file
// upload, and the demo record cap. What a page reads is capped too (data.ts), only SITE_LOADS.running
// sites are read at once, and the page cache holds a fixed number of bytes (CAREERS_CACHE_BYTES), so page
// views cannot exhaust the memory.
// Headers: the careers CSP (csp.ts), nosniff, Referrer-Policy and X-Robots-Tag on every response, and
// no cookie is ever set or read here (app.ts also empties request.cookies and drops Set-Cookie).
//
// Pages are cached per company in memory, keyed by the workspace's last_seq and the date, so a page view
// costs one small query until the company's records change.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { applicationRecords, parseApplication } from '../../../src/careers/application'
import {
  APPLY_FIELDS,
  type ApplyValues,
  type CareerJob,
  careerJobs,
  CSS_FILE,
  FONT_FILE,
  FONT_LICENSE,
  jobAddress,
  jobIdToken,
  type LiveApply,
  type LiveMode,
  type MessagePage,
  type PageLinks,
  renderIndexPage,
  renderJobPage,
  renderMessagePage,
} from '../../../src/careers/render'
import type { DB } from '../../../src/domain/types'
import { type ISODate, pacificDateOf } from '../../../src/lib/dates'
import { careersHostPattern } from '../app'
import { clientAddressKey, ConcurrencyGate, GateFullError } from '../auth'
import type { Config } from '../config'
import { CAREERS_CSP } from '../csp'
import type { Db } from '../db'
import { HttpError } from '../errors'
import { applyChanges } from '../repo'
import { parseChanges } from '../validate'
import { isValidSlug } from '../workspaces'
import { alreadyApplied, applicationPeople, careersWorkspace, loadCareersDb } from './data'
import { ApplyRateLimiter } from './limits'

/** The apply form takes a few KB; 32 KB leaves room for every character of it percent-encoded. */
export const APPLY_BODY_LIMIT = 32 * 1024
/**
 * Bytes the page cache may hold, estimated (CACHE_BYTES_PER_LOADED_BYTE times the JSON a site read); the
 * least recently viewed company goes first. What a site reads is capped (data.ts LOAD_BUDGET), so every
 * site fits.
 */
export const CAREERS_CACHE_BYTES = 32 * 1024 * 1024
/**
 * Sites read from the database at once (cache misses), and how many more may wait: past that a page view
 * gets a 503 page. With the read caps this bounds the memory page views can take, however many companies
 * an attacker makes and views.
 */
export const SITE_LOADS = { running: 2, waiting: 32 }
/** Parsed records, their posting texts and rendered strings, per byte of JSON read: a generous estimate. */
const CACHE_BYTES_PER_LOADED_BYTE = 4
/** Same-origin referrers only: links out of a careers page tell no one where they came from. */
export const CAREERS_REFERRER_POLICY = 'same-origin'
/** How long the link to an application's confirmation works after the send. */
export const APPLIED_PROOF_MS = 15 * 60_000
const ASSET_CACHE = 'public, max-age=3600'
const SWEEP_MS = 60_000
const FORM_KEYS = new Set<string>([...APPLY_FIELDS, 'website'])

/** The files a careers page loads, read once at startup from the code folder (config.rootDir). */
const ASSET_FILES: Record<string, { from: string; type: string }> = {
  [CSS_FILE]: { from: `src/careers/${CSS_FILE}`, type: 'text/css; charset=utf-8' },
  [FONT_FILE]: { from: `src/themes/sleek/fonts/${FONT_FILE}`, type: 'font/woff2' },
  [FONT_LICENSE]: { from: `src/themes/sleek/fonts/${FONT_LICENSE}`, type: 'text/plain; charset=utf-8' },
}

type Asset = { body: Buffer; type: string; etag: string }

function loadAssets(rootDir: string, warn: (message: string) => void): Map<string, Asset> {
  const out = new Map<string, Asset>()
  for (const [name, { from, type }] of Object.entries(ASSET_FILES)) {
    try {
      const body = readFileSync(path.join(rootDir, from))
      out.set(name, { body, type, etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 22)}"` })
    } catch {
      warn(`careers pages: ${from} is missing, so /assets/${name} answers 404`)
    }
  }
  return out
}

/** One company's careers data for one day: its records (the part the pages read) and its open roles. */
type Site = { workspaceId: string; slug: string; db: DB; date: ISODate; jobs: CareerJob[] }

/**
 * The latest Site per company within `maxBytes` (each entry weighs what its estimate says), least
 * recently used dropped first. An entry over half the budget is not kept at all.
 */
export class SiteCache<T = Site> {
  private readonly entries = new Map<string, { key: string; site: T; bytes: number }>()
  private total = 0
  constructor(private readonly maxBytes: number) {}

  get(workspaceId: string, key: string): T | null {
    const e = this.entries.get(workspaceId)
    if (!e || e.key !== key) return null
    this.entries.delete(workspaceId)
    this.entries.set(workspaceId, e)
    return e.site
  }

  set(workspaceId: string, key: string, site: T, bytes: number): void {
    this.drop(workspaceId)
    if (bytes > this.maxBytes / 2) return
    this.entries.set(workspaceId, { key, site, bytes })
    this.total += bytes
    while (this.total > this.maxBytes) this.drop(this.entries.keys().next().value as string)
  }

  private drop(workspaceId: string): void {
    const e = this.entries.get(workspaceId)
    if (!e) return
    this.entries.delete(workspaceId)
    this.total -= e.bytes
  }

  /** Bytes held now (tests). */
  get bytes(): number {
    return this.total
  }

  get size(): number {
    return this.entries.size
  }
}

/** Root paths on the careers host: /<slug>/, /<slug>/jobs/<job address>, /assets/<file>. */
function siteLinks(slug: string): PageLinks {
  const home = `/${slug}/`
  return { home, job: (j) => `${home}jobs/${encodeURIComponent(jobAddress(j))}`, asset: (file) => `/assets/${file}` }
}

/**
 * Where a job's form posts. No fragment: the answer (the form again, its problems first) is a page whose
 * problems take focus (autofocus), and browsers skip autofocus on an address with a fragment.
 */
const applyAction = (links: PageLinks, job: CareerJob) => `${links.job(job)}/apply`

/** "4 minutes", "2 hours": how long until a limit lets someone try again. */
function waitText(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60))
  if (minutes < 90) return minutes === 1 ? '1 minute' : `${minutes} minutes`
  const hours = Math.ceil(minutes / 60)
  return `${hours} hours`
}

/** The fields of a posted form, as strings (anything else the body held is ignored). */
function formFields(body: unknown): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  if (typeof body !== 'object' || body === null) return out
  for (const key of FORM_KEYS) {
    const v = (body as Record<string, unknown>)[key]
    if (typeof v === 'string') out[key] = v
  }
  return out
}

/** A host as it compares: lowercase, without the trailing dot a fully qualified name may carry. */
function normalHost(host: string): string {
  return host.toLowerCase().replace(/\.(?=:\d+$|$)/, '')
}

/** Whether an Origin header names the host the request was sent to. */
function sameHost(origin: string, host: string | undefined): boolean {
  try {
    return normalHost(new URL(origin).host) === normalHost(host ?? '')
  } catch {
    return false
  }
}

/**
 * Proof that an application was just sent, for the confirmation's address: when it was sent and an HMAC
 * of the company, the job and that time under a key this process made at startup. Without it, or past
 * APPLIED_PROOF_MS, the job page shows its form: nobody can send someone a link that claims they applied.
 */
class AppliedProof {
  private readonly key = randomBytes(32)
  constructor(private readonly now: () => Date) {}

  private sign(workspaceId: string, jobId: string, at: string): string {
    return createHmac('sha256', this.key).update(`${workspaceId}\n${jobId}\n${at}`).digest('base64url').slice(0, 22)
  }

  make(workspaceId: string, jobId: string): string {
    const at = this.now().getTime().toString(36)
    return `${at}.${this.sign(workspaceId, jobId, at)}`
  }

  check(workspaceId: string, jobId: string, proof: unknown): boolean {
    if (typeof proof !== 'string' || proof.length > 64) return false
    const m = /^([0-9a-z]{1,12})\.([A-Za-z0-9_-]{22})$/.exec(proof)
    if (!m) return false
    const age = this.now().getTime() - Number.parseInt(m[1], 36)
    if (!(age >= 0 && age <= APPLIED_PROOF_MS)) return false
    const want = Buffer.from(this.sign(workspaceId, jobId, m[1]))
    const got = Buffer.from(m[2])
    return want.length === got.length && timingSafeEqual(want, got)
  }
}

export type CareersOptions = {
  db: Db
  config: Config
  /** The clock (tests). Default: the real one. Pages use the company's day, the Pacific date. */
  now?: () => Date
  /** The apply limits (tests pass small ones). Default: DEFAULT_APPLY_LIMITS. */
  limiter?: ApplyRateLimiter
}

type SlugParams = { slug: string }
type JobParams = { slug: string; job: string }

/**
 * Registers the careers routes on `scope` for config.careersHosts (nothing when there are none). It fits
 * buildApp's `careers` option (app.ts, CareersRoutes); its routes carry their own host constraint and
 * config.careers as well, so they answer on careers hosts only however they are registered.
 */
export async function registerCareers(scope: FastifyInstance, options: CareersOptions): Promise<void> {
  const { db, config } = options
  const hosts = careersHostPattern(config.careersHosts)
  if (!hosts) return
  const now = options.now ?? (() => new Date())
  const limiter = options.limiter ?? new ApplyRateLimiter()
  const proof = new AppliedProof(now)
  const assets = loadAssets(config.rootDir, (m) => scope.log.warn(m))
  const cache = new SiteCache(CAREERS_CACHE_BYTES)
  const loads = new ConcurrencyGate(SITE_LOADS.running, SITE_LOADS.waiting)
  const appOrigin = config.publicOrigin
  const mode: LiveMode = appOrigin ? { kind: 'live', appOrigin } : { kind: 'live' }

  // The limiter forgets idle keys on a timer, never per request.
  const sweeper = setInterval(() => limiter.sweep(), SWEEP_MS)
  sweeper.unref()
  scope.addHook('onClose', async () => clearInterval(sweeper))

  /** The company a slug names, with its open roles today, or null (no such company, careers off, or never uploaded). */
  async function loadSite(slug: string): Promise<Site | null> {
    const ws = await careersWorkspace(db, slug)
    if (!ws || !ws.initialized) return null
    const date = pacificDateOf(now().toISOString())
    const key = `${ws.lastSeq}|${date}`
    const hit = cache.get(ws.id, key)
    if (hit) return hit
    const data = await loads.run(() => loadCareersDb(db, ws.id, ws.name, date))
    if (!data) return null
    const site: Site = { workspaceId: ws.id, slug: ws.slug, db: data.db, date, jobs: careerJobs(data.db, date) }
    cache.set(ws.id, key, site, data.bytes * CACHE_BYTES_PER_LOADED_BYTE)
    return site
  }

  /**
   * The role an address names: at its own address (canonical), or by any older way to it: an address
   * whose record id is the role's (it was renamed since), the bare id, or the title alone (addresses from
   * before the id was part of them). Those get a 301 to the canonical address.
   */
  function findJob(site: Site, raw: string): { job: CareerJob; canonical: boolean } | null {
    const param = raw.toLowerCase()
    const exact = site.jobs.find((j) => jobAddress(j) === raw)
    if (exact) return { job: exact, canonical: true }
    // Of the roles whose record id ends the address, the longest id (j-data-eng-backfill over j-eng).
    const byId = site.jobs.filter((j) => param.endsWith(`-${jobIdToken(j)}`)).sort((a, b) => jobIdToken(b).length - jobIdToken(a).length)[0]
    const job =
      site.jobs.find((j) => jobAddress(j) === param) ??
      byId ??
      site.jobs.find((j) => j.id === raw || jobIdToken(j) === param) ??
      site.jobs.find((j) => j.slug === param)
    return job ? { job, canonical: false } : null
  }

  const page = (reply: FastifyReply, status: number, html: string, cacheControl = 'no-cache') =>
    reply.code(status).header('Content-Security-Policy', CAREERS_CSP).header('Cache-Control', cacheControl).type('text/html; charset=utf-8').send(html)

  const message = (reply: FastifyReply, status: number, p: Omit<MessagePage, 'assets' | 'appOrigin'>, cacheControl = 'no-store') =>
    page(reply, status, renderMessagePage({ ...p, assets: '/assets/', ...(appOrigin ? { appOrigin } : {}) }), cacheControl)

  const company = (site: Site) => ({ name: site.db.company.name, home: siteLinks(site.slug).home })

  const notFound = (reply: FastifyReply) =>
    message(reply, 404, {
      title: 'Page not found',
      kicker: 'Not found',
      heading: 'There is no careers page here',
      paragraphs: ['Check the address, or ask the company for the link to its careers page.'],
      action: { href: '/', label: 'About these careers pages' },
    })

  const roleNotFound = (reply: FastifyReply, site: Site) =>
    message(reply, 404, {
      title: `Role not found at ${site.db.company.name}`,
      kicker: 'Not found',
      heading: 'This role is not open',
      paragraphs: ['It may have been filled or closed, or its address may have changed.'],
      company: company(site),
      action: { href: siteLinks(site.slug).home, label: 'See all open roles' },
    })

  const pageNotFound = (reply: FastifyReply, site: Site) =>
    message(reply, 404, {
      title: `Page not found at ${site.db.company.name}`,
      kicker: 'Not found',
      heading: `${site.db.company.name} has no page at this address`,
      paragraphs: ['Check the address, or see every open role on the careers page.'],
      company: company(site),
      action: { href: siteLinks(site.slug).home, label: 'See all open roles' },
    })

  const fromOwnPage = (reply: FastifyReply, status: number) =>
    message(reply, status, {
      title: 'Send your application from the job page',
      kicker: 'Not sent',
      heading: 'Send your application from the job page',
      paragraphs: ['This form takes applications only from its own careers page. Open the role again and send it from there.'],
      action: { href: '/', label: 'About these careers pages' },
    })

  /** A 301 to `location`, keeping the query string (a confirmation's proof, say). */
  const moved = (request: FastifyRequest, reply: FastifyReply, location: string) => {
    const q = request.url.indexOf('?')
    return reply.code(301).header('Location', q >= 0 ? `${location}${request.url.slice(q)}` : location).send()
  }

  await scope.register(async (careers) => {
    // Every careers route answers on the careers hosts only, and app.ts lets nothing else answer there.
    careers.addHook('onRoute', (route) => {
      route.constraints = { ...route.constraints, host: hosts }
      route.config = { ...route.config, careers: true }
    })

    // Addresses pasted into an email or a chat pick up capital letters: a slug that is valid once
    // lowercased goes to its lowercase address (GET and HEAD only; nothing is looked up for it).
    careers.addHook('onRequest', async (request, reply) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') return
      const m = /^\/([^/?#]+)(.*)$/.exec(request.url)
      if (!m || m[1] === m[1].toLowerCase()) return
      let first: string
      try {
        first = decodeURIComponent(m[1])
      } catch {
        return
      }
      const lower = first.toLowerCase()
      if (lower !== first && isValidSlug(lower)) return reply.code(301).header('Location', `/${lower}${m[2]}`).send()
    })

    // Form posts only here (the API takes JSON alone); just the form's own fields are kept.
    careers.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
      const fields: Record<string, string> = {}
      for (const [key, value] of new URLSearchParams(String(body))) if (FORM_KEYS.has(key) && !(key in fields)) fields[key] = value
      done(null, fields)
    })

    careers.addHook('onSend', async (_request, reply, payload) => {
      if (!reply.hasHeader('content-security-policy')) reply.header('Content-Security-Policy', CAREERS_CSP)
      reply.header('X-Content-Type-Options', 'nosniff')
      reply.header('Referrer-Policy', CAREERS_REFERRER_POLICY)
      reply.header('X-Robots-Tag', 'noindex, nofollow')
      reply.removeHeader('set-cookie')
      return payload
    })

    careers.setErrorHandler((err: Error & { statusCode?: number; code?: string }, request, reply) => {
      if (err instanceof GateFullError) {
        request.log.warn('careers page refused: too many site loads waiting')
        reply.header('Retry-After', '10')
        return message(reply, 503, {
          title: 'This page is busy',
          kicker: 'Try again in a moment',
          heading: 'This page is busy',
          paragraphs: ['Too many careers pages are being opened at once on this demo server. Try again in a moment.'],
          action: { href: '/', label: 'About these careers pages' },
        })
      }
      const status = typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500
      if (status === 413) {
        return message(reply, 413, {
          title: 'The application is too long',
          kicker: 'Not sent',
          heading: 'The application is too long',
          paragraphs: ['Shorten your answer, then send it again.'],
          action: { href: '/', label: 'About these careers pages' },
        })
      }
      if (status < 500) {
        request.log.info({ code: err.code, status }, 'careers request rejected')
        return fromOwnPage(reply, status)
      }
      request.log.error({ err }, 'careers page failed')
      return message(reply, 500, {
        title: 'This page could not be shown',
        kicker: 'Something went wrong',
        heading: 'This page could not be shown',
        paragraphs: ['Something went wrong on the server. Try again in a minute.'],
        action: { href: '/', label: 'About these careers pages' },
      })
    })

    careers.get('/', async (_request, reply) =>
      message(
        reply,
        200,
        {
          title: 'Careers pages on First Twenty',
          kicker: 'Careers',
          heading: 'Careers pages for companies on this First Twenty demo server',
          paragraphs: [
            'Each company here has a careers page of its own, at this address followed by the company’s name and a few letters, like /your-company-k7m2qx/. Ask the company for its link: there is no list of companies.',
            'Anyone can create a company on this demo server, so a company or job here may not be real. Never send ID numbers, bank details or passwords through a careers page.',
          ],
          ...(appOrigin ? { action: { href: `${appOrigin}/`, label: 'Make a careers page in First Twenty' } } : {}),
        },
        'no-cache',
      ),
    )

    careers.get('/robots.txt', async (_request, reply) =>
      reply.header('Cache-Control', 'public, max-age=86400').type('text/plain; charset=utf-8').send('User-agent: *\nDisallow: /\n'),
    )

    careers.get<{ Params: { file: string } }>('/assets/:file', async (request, reply) => {
      const asset = assets.get(request.params.file)
      if (!asset) return notFound(reply)
      reply.header('ETag', asset.etag).header('Cache-Control', ASSET_CACHE)
      if (request.headers['if-none-match'] === asset.etag) return reply.code(304).send()
      return reply.type(asset.type).send(asset.body)
    })

    careers.get<{ Params: SlugParams }>('/:slug', async (request, reply) => {
      const site = await loadSite(request.params.slug)
      if (!site) return notFound(reply)
      return reply.code(301).header('Location', siteLinks(site.slug).home).send()
    })

    careers.get<{ Params: SlugParams }>('/:slug/', async (request, reply) => {
      const site = await loadSite(request.params.slug)
      if (!site) return notFound(reply)
      return page(reply, 200, renderIndexPage(site.db, site.date, site.jobs, { links: siteLinks(site.slug), mode }))
    })

    careers.get<{ Params: JobParams; Querystring: { applied?: string } }>('/:slug/jobs/:job', async (request, reply) => {
      const site = await loadSite(request.params.slug)
      if (!site) return notFound(reply)
      const found = findJob(site, request.params.job)
      if (!found) return roleNotFound(reply, site)
      const links = siteLinks(site.slug)
      if (!found.canonical) return moved(request, reply, links.job(found.job))
      const { job } = found
      // The confirmation needs proof of a send from this server, a few minutes old at most.
      const applied = proof.check(site.workspaceId, job.id, request.query.applied)
      return page(reply, 200, renderJobPage(site.db, job, { links, mode }, { action: applyAction(links, job), applied }), applied ? 'no-store' : 'no-cache')
    })

    // A job address with a trailing slash: the same role, without it.
    careers.get<{ Params: JobParams }>('/:slug/jobs/:job/', async (request, reply) => {
      const site = await loadSite(request.params.slug)
      if (!site) return notFound(reply)
      const found = findJob(site, request.params.job)
      if (!found) return roleNotFound(reply, site)
      return moved(request, reply, siteLinks(site.slug).job(found.job))
    })

    // The form's address opened as a page (a bookmark, a reload of an answer): the job page's form.
    careers.get<{ Params: JobParams }>('/:slug/jobs/:job/apply', async (request, reply) => {
      const site = await loadSite(request.params.slug)
      if (!site) return notFound(reply)
      const found = findJob(site, request.params.job)
      if (!found) return roleNotFound(reply, site)
      return reply.code(303).header('Location', `${siteLinks(site.slug).job(found.job)}#apply`).send()
    })

    /** Before the body is read: a form, from its own page, within the post limit. */
    async function guardApply(request: FastifyRequest, reply: FastifyReply) {
      const type = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
      if (type !== 'application/x-www-form-urlencoded') return fromOwnPage(reply, 415)
      // Browsers label where a request comes from: only this page's own origin (or the person themselves)
      // may send. Another site's form, or a sibling host under a shared domain, could otherwise post
      // applications from every visitor's address. Under a no-referrer policy the Origin is "null".
      const site = request.headers['sec-fetch-site']
      const origin = request.headers.origin
      if ((site !== undefined && site !== 'same-origin' && site !== 'none') || (origin && origin !== 'null' && !sameHost(origin, request.headers.host))) {
        request.log.info({ site, ip: request.ip }, 'careers application refused: not from its own page')
        return fromOwnPage(reply, 403)
      }
      const limit = limiter.post(clientAddressKey(request.ip))
      if (!limit.ok) {
        reply.header('Retry-After', String(limit.retryAfter))
        return message(reply, 429, {
          title: 'Too many tries',
          kicker: 'Try again later',
          heading: 'Too many tries from your network',
          paragraphs: [`The form takes a limited number of tries from one network. Try again in ${waitText(limit.retryAfter)}.`],
          action: { href: '/', label: 'About these careers pages' },
        })
      }
    }

    careers.post<{ Params: JobParams }>('/:slug/jobs/:job/apply', { bodyLimit: APPLY_BODY_LIMIT, onRequest: guardApply }, async (request, reply) => {
      const site = await loadSite(request.params.slug)
      if (!site) return notFound(reply)
      const job = findJob(site, request.params.job)?.job
      const record = job ? site.db.jobs.find((x) => x.id === job.id) : undefined
      if (!job || !record) return roleNotFound(reply, site)
      const links = siteLinks(site.slug)
      const action = applyAction(links, job)
      const form = (status: number, apply: Omit<LiveApply, 'action'>, values: ApplyValues) =>
        page(reply, status, renderJobPage(site.db, job, { links, mode }, { action, values, ...apply }), 'no-store')
      const parsed = parseApplication(formFields(request.body))
      if (!parsed.ok) return form(400, { errors: parsed.errors }, parsed.values)

      // The place is taken now, before anything below is awaited (see ApplyRateLimiter.reserve). Refused:
      // the form comes back with what was typed, so a shared network's limit loses nobody's answer.
      const address = clientAddressKey(request.ip)
      const limit = limiter.reserve(address, site.workspaceId)
      if (!limit.ok) {
        reply.header('Retry-After', String(limit.retryAfter))
        const name = site.db.company.name
        const byCompany = 'reason' in limit && limit.reason === 'workspace'
        return form(
          429,
          {
            refused: {
              heading: byCompany ? `${name} has had many applications today` : 'Too many applications from your network',
              message: byCompany
                ? `Your application was not sent. On this demo server a company takes a limited number of applications a day. What you typed is still here: try again in ${waitText(limit.retryAfter)}.`
                : `Your application was not sent. Applications from one network are limited to keep spam out. What you typed is still here: try again in ${waitText(limit.retryAfter)}.`,
            },
          },
          parsed.values,
        )
      }

      // The same person applying to the same role again (a second click, a reload) adds nothing, and the
      // answer is the same, so it tells no one whether an email address applied before. Its place in the
      // limits stays taken, for the same reason.
      try {
        if (!(await alreadyApplied(db, site.workspaceId, job.id, parsed.input.email))) {
          const people = await applicationPeople(db, site.workspaceId, record.hiringManagerId)
          const { candidate, application, activity } = applicationRecords({
            db: { people, holidays: site.db.holidays },
            job: record,
            input: parsed.input,
            question: job.question,
            date: site.date,
            at: now().toISOString(),
          })
          const changes = parseChanges({
            changes: [
              { collection: 'candidates', id: candidate.id, op: 'upsert', data: candidate, baseVersion: null },
              { collection: 'applications', id: application.id, op: 'upsert', data: application, baseVersion: null },
              ...activity.map((a) => ({ collection: 'activity', id: a.id, op: 'upsert', data: a, baseVersion: null })),
            ],
          })
          // markActive false: an application from a stranger never keeps an abandoned demo company alive.
          const result = await applyChanges(db, changes, null, { workspaceId: site.workspaceId, markActive: false, demoTotalBytes: config.demoMaxTotalBytes })
          if (result.conflicts.length > 0) throw new Error('a new careers record took an id that already exists')
          request.log.info({ workspaceId: site.workspaceId, jobId: job.id }, 'careers application received')
        }
      } catch (err) {
        // Not written, for a reason of the server's own: the place goes back.
        limiter.release(address, site.workspaceId)
        // Deleted (an expired demo company) or emptied since the page was read.
        if (err instanceof HttpError && (err.statusCode === 401 || err.code === 'empty')) return notFound(reply)
        if (err instanceof HttpError && err.code === 'workspace_full') {
          const name = site.db.company.name
          return message(reply, 503, {
            title: `${name} cannot take applications right now`,
            kicker: 'Not sent',
            heading: `${name} cannot take applications right now`,
            paragraphs: ['Its workspace on this demo server is full. Try again later, or reach the company another way.'],
            company: company(site),
            action: { href: links.home, label: 'See all open roles' },
          })
        }
        throw err
      }
      // No fragment, so the confirmation's heading takes focus (autofocus) on arrival.
      return reply
        .code(303)
        .header('Location', `${links.job(job)}?applied=${proof.make(site.workspaceId, job.id)}`)
        .header('Cache-Control', 'no-store')
        .send()
    })

    // Anything else: the company's own 404 when the address starts with one of its pages.
    careers.get('/*', async (request, reply) => {
      const first = /^\/([^/?#]+)\//.exec(request.url)?.[1]
      const site = first ? await loadSite(first) : null
      return site ? pageNotFound(reply, site) : notFound(reply)
    })
  })
}
