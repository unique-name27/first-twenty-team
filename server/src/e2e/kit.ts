// The journey kit (docs/DEV.md, "Journey tests"): one path through the app the way people take it, against
// the real server and database, in one test file. startJourney gives:
// - an in-memory PGlite migrated by the schema owner, with the server and every query of the test running
//   as the rows-only role production uses (server/deploy/postgres-setup.sql);
// - the real Fastify app (makeApp) with the careers pages on, their clock and apply limits set for tests;
// - an admin made the way `npm run server:create-admin` makes one, whose browser connects the normal way
//   (sign in, the server is empty, upload this browser's workspace: the Ledgerlark sample) and turns the
//   careers page on;
// - browsers: each a real sync engine over injectFetch with its own store, storage and cookie jar.
// A test then drives it with act (a domain change through one browser's store, as the app makes it, then a
// sync), apply (the careers form, as a candidate's browser sends it), advanceTo (the app's clock override)
// and sql (the read model's views). Wrap each part in step(): when one fails, the failure dump prints the
// step log, the hire journeys, the integrity problems and the tail of the change log.
// Test-only: only tests import server/src/e2e.
//
// The store loads first, so every seed and domain module finishes loading before the sample is built.
import '@/store/db'
import { PGlite } from '@electric-sql/pglite'
import type { FastifyInstance } from 'fastify'
import type { Draft } from 'immer'
import type { StoreApi } from 'zustand/vanilla'
import { viewerPerson } from '@/domain/people'
import type { DB, ID, Role } from '@/domain/types'
import { getClockOverride, type ISODate, setClockOverride, today } from '@/lib/dates'
import { applyLoadChanges, loadSample, migrate as upgradeStored } from '@/store/db'
import { usePrefs } from '@/store/prefs'
import { createApi, type SyncApi } from '../../../src/sync/api'
import { createSyncEngine, type SyncEngine } from '../../../src/sync/engine'
import type { SyncStatusState } from '../../../src/sync/status'
import { type InjectApp, injectFetch } from '../../../src/sync/testing/inject'
import { createStatusStore, createTestStore, memoryStorage, type TestDBState, testEnv } from '../../../src/sync/testing/kit'
import { ApplyRateLimiter } from '../careers/limits'
import { registerCareers } from '../careers/routes'
import { type Db, fromPGlite } from '../db'
import { migrate } from '../migrate'
import { WORKSPACE_ID } from '../sqlgen'
import { ADMIN, createAdmin, makeApp } from '../test/helpers'

/** The careers host the journey's careers pages answer on. */
export const CAREERS_HOST = 'careers.journey.test'
/** Where a candidate's browser sends the careers form from (a documentation address, RFC 5737). */
export const CANDIDATE_ADDRESS = '203.0.113.10'
/** The apply limits for journeys: small, so a journey that sends more than a person would hits them. */
export const JOURNEY_APPLY_LIMITS = { postsPerAddress: 6, perAddress: 3, perWorkspace: 20 }
/** Password for logins a journey makes (invites). Test-only, like ADMIN in test/helpers.ts. */
export const JOURNEY_PASSWORD = 'journey-password-1234'

/** The roles of server/deploy/postgres-setup.sql: the owner runs migrations, the server only reads and writes rows. */
const ROLES_SQL = `
  CREATE ROLE first_twenty_owner NOLOGIN;
  CREATE ROLE first_twenty NOLOGIN;
  GRANT USAGE, CREATE ON SCHEMA public TO first_twenty_owner;
  GRANT USAGE ON SCHEMA public TO first_twenty;
  ALTER DEFAULT PRIVILEGES FOR ROLE first_twenty_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO first_twenty;
  ALTER DEFAULT PRIVILEGES FOR ROLE first_twenty_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO first_twenty;
`

/** One browser: a real sync engine with its own store, storage, cookie jar and Viewing-as. */
export type Browser = {
  name: string
  engine: SyncEngine
  api: SyncApi
  /** Its store, as useDB is the app's: every change through mutate(label, recipe), with Undo history. */
  store: StoreApi<TestDBState>
  /** Its login on the server. */
  userId: string
  /** Its Viewing-as preference (a per-device setting in the app; act applies it while it runs). */
  viewAs: { role: Role; personId: ID | null }
  /** Its workspace now. */
  db(): DB
  status(): SyncStatusState
  /** The person it is acting as (useViewer): the actor the app passes to domain functions. */
  viewerId(): ID
  /** Sends what waits and takes what is new, then waits until the engine is idle. */
  sync(): Promise<void>
}

/** A careers form to send: the job's title as the careers page shows it, and the fields by name. */
export type ApplyInput = { job: string; fields: Record<string, string>; from?: string }
/** What the candidate's browser ended on: the page after the send (the confirmation, or the form with its problems). */
export type ApplyResult = { status: number; page: string; sent: boolean }

export type Journey = {
  db: Db
  app: FastifyInstance
  /** The admin's browser, connected and synced. */
  admin: Browser
  /** The company's careers page, as Settings shows it. */
  careersUrl: string
  /** Runs one part of the journey under a name; when it throws, prints the failure dump and names the step. */
  step<T>(name: string, fn: () => Promise<T> | T): Promise<T>
  /** Adds a line to the step log. */
  log(line: string): void
  /**
   * A change in one browser, as the app makes it (the store's mutate with a label), then a sync. The
   * recipe is a domain function's call. Returning false or { ok: false, reason } refuses the change, as
   * the app's act() does, and so does a change that changes nothing: either fails the step.
   */
  act<R>(browser: Browser, label: string, recipe: (draft: Draft<DB>) => R): Promise<R>
  /** The careers form, sent the way a candidate's browser sends it: the list page, the job page, its form. */
  apply(input: ApplyInput): Promise<ApplyResult>
  /** Moves the journey's day forward (the app's clock override, which every date in the domain reads). */
  advanceTo(date: ISODate): void
  /** A read-only query as the server's role, with the read model's today set to the journey's day. */
  sql<T extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>
  /** Another computer of the admin: a fresh browser that signs in and takes the server's copy. */
  connect(name: string): Promise<Browser>
  /** A second login, invited from the admin's browser and joined the normal way, synced. */
  invite(name: string, email: string): Promise<Browser>
  /** The failure dump: the step log, the hire journeys, the integrity problems and the change log's tail. */
  dump(): Promise<string>
  close(): Promise<void>
}

export type JourneyOptions = {
  /** The first day (default the sample's anchor, 2026-10-09, so the sample needs no date shift). */
  start?: ISODate
}

/** Why a recipe's result refuses its change, as the app's act() reads it (false, or { ok: false, reason }), or null. */
function refusal(value: unknown): string | null {
  if (value === false) return 'nothing changed'
  if (value && typeof value === 'object' && 'ok' in value && (value as { ok: unknown }).ok === false) return String((value as { reason?: unknown }).reason ?? 'refused')
  return null
}

/** Text as written in the careers pages' HTML (src/careers/render.ts esc), back to plain text. */
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** The first match of `re` in `html`, unescaped, or a clear error. */
function pick(html: string, re: RegExp, what: string): string {
  const m = re.exec(html)
  if (!m) throw new Error(`the careers page has no ${what}`)
  return unescape(m[1])
}

/** An in-memory PGlite migrated by first_twenty_owner, its session then running as first_twenty. */
async function journeyDb(): Promise<Db> {
  const pg = await PGlite.create()
  const db = fromPGlite(pg as unknown as Parameters<typeof fromPGlite>[0])
  await db.exec(`${ROLES_SQL} SET ROLE first_twenty_owner;`)
  await migrate(db)
  await db.exec('RESET ROLE; SET ROLE first_twenty;')
  return db
}

export async function startJourney(options: JourneyOptions = {}): Promise<Journey> {
  const started = Date.now()
  const steps: string[] = []
  const stops: Array<() => void> = []
  const clockBefore = getClockOverride()
  const prefsBefore = usePrefs.getState().viewAs
  setClockOverride(options.start ?? '2026-10-09')
  let dumped = false

  const log = (line: string) => steps.push(`${today()}  ${line}`)

  // The careers pages' clock is midday in California on the journey's day (19:00 UTC); their limits read it too.
  const careersNow = () => new Date(`${today()}T19:00:00.000Z`)
  const limiter = new ApplyRateLimiter({ ...JOURNEY_APPLY_LIMITS, now: () => careersNow().getTime() })
  const db = await journeyDb()
  const app = await makeApp(
    db,
    { careersHosts: [CAREERS_HOST], careersOrigin: `https://${CAREERS_HOST}` },
    { careers: (scope, deps) => registerCareers(scope, { ...deps, now: careersNow, limiter }) },
  )
  const adminId = await createAdmin(db)

  /** A fresh browser, holding what a browser holds before it connects: the sample company, as of today. */
  function browser(name: string, userId: string): Browser {
    const store = createTestStore(loadSample())
    const status = createStatusStore()
    const api = createApi({ fetch: injectFetch(() => app as unknown as InjectApp) })
    // Configured as src/sync/index.ts configures the app's engine, except the demo clock: the journey's
    // clock override stands for the real date here, so the engine is never told about a pretend date.
    const engine = createSyncEngine({
      store,
      api,
      storage: memoryStorage(),
      env: testEnv().env,
      status,
      prepareSnapshot: upgradeStored,
      onLoad: applyLoadChanges,
      debounceMs: 5,
      pullIntervalMs: 3_600_000,
    })
    stops.push(() => engine.stop())
    const b: Browser = {
      name,
      engine,
      api,
      store,
      userId,
      viewAs: { role: 'admin', personId: null },
      db: () => store.getState().db,
      status: () => status.getState(),
      viewerId: () => {
        const p = viewerPerson(store.getState().db, b.viewAs.role, b.viewAs.personId)
        if (!p) throw new Error(`${name} views as nobody`)
        return p.id
      },
      sync: async () => {
        await engine.syncNow()
        await engine.whenIdle()
      },
    }
    return b
  }

  /** Fails unless the browser is synced: nothing waiting, nothing refused, no hold. */
  function expectSynced(b: Browser, after: string): void {
    const s = b.status()
    if (s.pending > 0 || s.rejected > 0 || s.hold || s.status !== 'synced') {
      throw new Error(`${b.name} is not synced after "${after}": ${JSON.stringify({ status: s.status, pending: s.pending, rejected: s.rejected, hold: s.hold, lastError: s.lastError })}`)
    }
  }

  function ok<T extends { ok: boolean }>(what: string, result: T): Extract<T, { ok: true }> {
    if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result)}`)
    return result as Extract<T, { ok: true }>
  }

  // The admin's first connection, as Settings, Server makes it on an empty server.
  const admin = browser('admin', adminId)
  ok('signing in', await admin.engine.signIn(ADMIN.email, ADMIN.password))
  const inspected = ok('looking at the server', await admin.engine.inspectServer())
  if (!inspected.empty) throw new Error('the server should start empty')
  ok('uploading the workspace', await admin.engine.uploadLocal({ includeSample: true }))
  await admin.engine.whenIdle()
  expectSynced(admin, 'uploading the workspace')
  const careers = await admin.api.setCareers(true)
  if (!careers.ok || !careers.data.careersUrl) throw new Error(`turning the careers page on failed: ${JSON.stringify(careers)}`)
  const careersUrl = careers.data.careersUrl
  log(`admin connected and uploaded ${admin.db().company.name}; careers page on at ${careersUrl} (${Date.now() - started} ms)`)

  async function sql<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    return db.tx(
      async (q) => {
        await q.query(`SELECT set_config('first_twenty.today', $1, true)`, [today()])
        return (await q.query<T>(text, params)).rows
      },
      { readOnly: true },
    )
  }

  async function dump(): Promise<string> {
    const out = ['Journey failure dump', '', 'Steps (the day, then what happened):', ...steps.map((s) => `  ${s}`)]
    const section = async (title: string, text: string) => {
      out.push('', title)
      try {
        const rows = await sql(text, [WORKSPACE_ID])
        if (rows.length === 0) out.push('  (none)')
        for (const r of rows) out.push(`  ${JSON.stringify(r)}`)
      } catch (err) {
        out.push(`  could not read: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    await section(
      'v_hire_journey, the 8 newest hires (a null is a missing step):',
      `SELECT application_id, candidate_name, job_id, hired_on::text, offer_id, offer_accepted_on::text, person_id, start_date::text,
              hire_comp_id, onboarding_checklist_id, onboarding_tasks_open, onboarding_completed_on::text, first_payday::text
         FROM v_hire_journey WHERE workspace_id = $1 ORDER BY hired_on DESC NULLS FIRST, application_id LIMIT 8`,
    )
    await section(
      'v_integrity_problems:',
      `SELECT code, severity, collection, record_id, field, other_id FROM v_integrity_problems WHERE workspace_id = $1 ORDER BY collection, record_id, code`,
    )
    await section(
      'change_log, the last 25 writes (user: who pushed it; none for the careers form):',
      `SELECT c.seq, c.collection, c.record_id, c.op, coalesce(u.email, 'none') AS user
         FROM change_log c LEFT JOIN users u ON u.id = c.user_id
        WHERE c.workspace_id = $1 ORDER BY c.seq DESC LIMIT 25`,
    )
    return out.join('\n')
  }

  async function step<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    log(`step: ${name}`)
    try {
      return await fn()
    } catch (err) {
      log(`FAILED: ${name}`)
      if (!dumped) {
        dumped = true
        console.error(await dump())
      }
      if (err instanceof Error) err.message = `Journey step "${name}" failed: ${err.message}`
      throw err
    }
  }

  async function act<R>(b: Browser, label: string, recipe: (draft: Draft<DB>) => R): Promise<R> {
    const before = b.db()
    let value: R | undefined
    let refused: string | null = null
    // Viewing-as is a per-device preference: this browser's applies while its change runs.
    const prefs = usePrefs.getState().viewAs
    usePrefs.setState({ viewAs: b.viewAs })
    try {
      b.store.getState().mutate(label, (d) => {
        const r = recipe(d)
        refused = refusal(r)
        if (refused) throw new Error(refused)
        value = r
      })
    } catch (err) {
      throw new Error(`${b.name}: "${label}" was refused: ${refused ?? (err instanceof Error ? err.message : String(err))}`)
    } finally {
      usePrefs.setState({ viewAs: prefs })
    }
    if (b.db() === before) throw new Error(`${b.name}: "${label}" changed nothing`)
    log(`${b.name}: ${label}`)
    await b.sync()
    expectSynced(b, label)
    return value as R
  }

  async function apply(input: ApplyInput): Promise<ApplyResult> {
    const from = input.from ?? CANDIDATE_ADDRESS
    const get = async (url: string) => {
      const res = await app.inject({ method: 'GET', url, headers: { host: CAREERS_HOST }, remoteAddress: from })
      if (res.statusCode !== 200) throw new Error(`GET ${url} on the careers host answered ${res.statusCode}`)
      return res.body
    }
    const list = await get(new URL(careersUrl).pathname)
    const links = [...list.matchAll(/<a class="role__link" href="([^"]+)">([^<]*)<\/a>/g)].map((m) => ({ href: unescape(m[1]), title: unescape(m[2]) }))
    const job = links.find((l) => l.title === input.job)
    if (!job) throw new Error(`the careers page lists no "${input.job}" (it lists ${links.map((l) => `"${l.title}"`).join(', ') || 'nothing'})`)
    const page = await get(job.href)
    const action = pick(page, /<form class="form" id="apply-form" method="post" action="([^"]+)"/, 'apply form')
    const names = new Set([...page.matchAll(/<(?:input|textarea)\b[^>]*\bname="([^"]+)"/g)].map((m) => m[1]))
    const unknown = Object.keys(input.fields).filter((k) => !names.has(k))
    if (unknown.length) throw new Error(`the apply form has no field ${unknown.join(', ')} (it has ${[...names].join(', ')})`)
    // Every field of the form goes, as a browser sends it: the ones left alone empty (the hidden one too).
    const body = new URLSearchParams([...names].map((n) => [n, input.fields[n] ?? '']))
    const res = await app.inject({
      method: 'POST',
      url: action,
      headers: { host: CAREERS_HOST, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin', origin: `https://${CAREERS_HOST}` },
      payload: body.toString(),
      remoteAddress: from,
    })
    if (res.statusCode !== 303) {
      log(`candidate: sent the form for ${input.job}, answered ${res.statusCode}`)
      return { status: res.statusCode, page: res.body, sent: false }
    }
    const confirmation = await get(String(res.headers.location))
    log(`candidate: applied for ${input.job} on the careers page`)
    return { status: 303, page: confirmation, sent: true }
  }

  function advanceTo(date: ISODate): void {
    if (date < today()) throw new Error(`the journey's clock only moves forward (today is ${today()}, asked for ${date})`)
    setClockOverride(date)
    log(`the day is now ${date}`)
  }

  async function connect(name: string): Promise<Browser> {
    const b = browser(name, adminId)
    ok(`${name} signing in`, await b.engine.signIn(ADMIN.email, ADMIN.password))
    ok(`${name} taking the server's copy`, await b.engine.useServerCopy())
    await b.engine.whenIdle()
    expectSynced(b, 'taking the server copy')
    log(`${name}: signed in as the admin on another computer and took the server's copy`)
    return b
  }

  async function invite(name: string, email: string): Promise<Browser> {
    const link = await admin.api.createInvite()
    if (!link.ok) throw new Error(`making an invite failed: ${JSON.stringify(link)}`)
    const token = link.data.url.slice(link.data.url.indexOf('#invite.') + '#invite.'.length)
    const b = browser(name, '')
    const joined = ok(`${name} joining`, await b.engine.acceptInvite({ token, email, password: JOURNEY_PASSWORD }))
    b.userId = joined.user.id
    ok(`${name} taking the server's copy`, await b.engine.useServerCopy())
    await b.engine.whenIdle()
    expectSynced(b, 'joining')
    log(`${name}: joined with an invite as ${email} and took the server's copy`)
    return b
  }

  async function close(): Promise<void> {
    for (const stop of stops.splice(0)) stop()
    await app.close()
    await db.close()
    setClockOverride(clockBefore)
    usePrefs.setState({ viewAs: prefsBefore })
  }

  return { db, app, admin, careersUrl, step, log, act, apply, advanceTo, sql, connect, invite, dump, close }
}
