// Static careers site for the First Twenty demo: the Ledgerlark sample's open jobs as plain HTML pages,
// one CSS file, one small script for the demo apply form, and the Archivo font. No external requests,
// relative links only, so the folder works under any GitHub Pages subpath (the app sits one level up).
// The pages come from the shared careers renderer (src/careers/render.ts, demo mode), which the server
// also uses for its live careers pages.
//
// Run: npx tsx scripts/careers/build.ts --out <dir>     (npm run build:careers writes dist-careers/)
//
// Ledgerlark, Inc. is fictional (docs/SAMPLE.md). Every page says so, and the apply form sends nothing:
// it has no action, uses method="dialog" (which never navigates or submits anywhere) and its script
// only validates in the tab.
//
// The sample's dates move with the calendar (loadSample shifts them by whole weeks), so rebuild this
// site in the same publish step as the app or its posted dates drift away from the app's.
//
// --app-href <path or URL> points the "hiring side" links somewhere other than the app one folder up
// (a relative path is taken from the site root; the app's hash routes are appended either way).
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { links } from '@/app/router'
import { type CareerJob, careerJobs, CSS_FILE, FONT_FILE, FONT_LICENSE, type PageLinks, renderIndexPage, renderJobPage } from '@/careers/render'
import { type ISODate, today } from '@/lib/dates'
import { loadSample } from '@/store/db'

export { type CareerJob, esc, isPublicJob, type ParsedPosting, parsePosting, postingBodyHtml, sentence } from '@/careers/render'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const SHARED_DIR = join(repoRoot, 'src/careers')
const FONT_DIR = join(repoRoot, 'src/themes/sleek/fonts')

export type CareersBuild = { outDir: string; date: ISODate; company: string; jobs: CareerJob[]; files: string[] }

export type CareersOptions = {
  /** Where the First Twenty app lives. Default: index.html one folder above the site root. */
  appHref?: string
}

/** The app's default place: the careers folder sits beside the app's index.html. */
export const DEFAULT_APP_HREF = '../index.html'

/**
 * A link into the First Twenty app from a page `depth` folders below the site root, opening the
 * app's own hash route (links.hiring / links.job from src/app/router.ts). An absolute base (a URL or a
 * root path) is used as is; a relative one is resolved from the site root.
 */
export function appHref(depth: number, hash: string, base: string = DEFAULT_APP_HREF): string {
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(base) || base.startsWith('/')
  const path = (absolute ? base : '../'.repeat(depth) + base).replace(/#.*$/, '')
  return hash ? `${path}${hash.startsWith('#') ? hash : `#${hash}`}` : path
}

/** Relative links for a page `depth` folders below the site root (index.html at 0, jobs/*.html at 1). */
function pageLinks(depth: 0 | 1): PageLinks {
  const up = depth ? '../' : ''
  return {
    home: `${up}index.html`,
    job: (j) => `${up}jobs/${j.slug}.html`,
    asset: (file) => `${up}assets/${file}`,
  }
}

// ---- Build ----------------------------------------------------------------------------------------

/** Builds the sample workspace for today (the app's own seed and date shift) and writes the site. */
export function buildCareers(outDir: string, options: CareersOptions = {}): CareersBuild {
  const appBase = options.appHref?.trim() || DEFAULT_APP_HREF
  const date = today()
  const db = loadSample()
  const jobs = careerJobs(db, date)
  const out = resolve(outDir)
  const jobsDir = join(out, 'jobs')
  const assets = join(out, 'assets')
  mkdirSync(jobsDir, { recursive: true })
  mkdirSync(assets, { recursive: true })
  // Drop job pages from an earlier build (a role that closed since); only .html files this tool writes.
  for (const f of readdirSync(jobsDir)) if (f.endsWith('.html')) rmSync(join(jobsDir, f))
  const files: string[] = []
  const write = (rel: string, text: string) => {
    writeFileSync(join(out, rel), text, 'utf8')
    files.push(rel)
  }
  const copy = (from: string, rel: string) => {
    if (!existsSync(from)) throw new Error(`Missing ${from}`)
    copyFileSync(from, join(out, rel))
    files.push(rel)
  }
  const hiring = appHref(0, links.hiring('jobs'), appBase)
  write('index.html', renderIndexPage(db, date, jobs, { links: pageLinks(0), mode: { kind: 'demo', appLink: hiring, appHome: hiring } }))
  for (const j of jobs) {
    const mode = { kind: 'demo' as const, appLink: appHref(1, links.job(j.id), appBase), appHome: appHref(1, links.hiring('jobs'), appBase) }
    write(`jobs/${j.slug}.html`, renderJobPage(db, j, { links: pageLinks(1), mode }))
  }
  copy(join(SHARED_DIR, CSS_FILE), `assets/${CSS_FILE}`)
  copy(join(here, 'apply.js'), 'assets/apply.js')
  copy(join(FONT_DIR, FONT_FILE), `assets/${FONT_FILE}`)
  copy(join(FONT_DIR, FONT_LICENSE), `assets/${FONT_LICENSE}`)
  return { outDir: out, date, company: db.company.name, jobs, files }
}

function isMain(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  return pathToFileURL(resolve(entry)).href.toLowerCase() === import.meta.url.toLowerCase()
}

if (isMain()) {
  const arg = (flag: string) => {
    const i = process.argv.indexOf(flag)
    return i > -1 ? process.argv[i + 1] : undefined
  }
  const outArg = arg('--out')
  if (!outArg) {
    console.error('Usage: npx tsx scripts/careers/build.ts --out <dir> [--app-href <path or URL>]')
    process.exit(1)
  }
  const result = buildCareers(outArg, { appHref: arg('--app-href') })
  console.log(`Careers site for ${result.company} (${result.date}): ${result.jobs.length} open roles, ${result.files.length} files in ${result.outDir}`)
}
