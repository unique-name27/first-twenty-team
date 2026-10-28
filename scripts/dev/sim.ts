// `npm run sim`: generated companies for development (docs/DEV.md, "Simulate a company").
//
//   npm run sim -- list                              the scenarios
//   npm run sim -- run full-20 [--out co.json]       generate one, print its summary, write it for Import
//   npm run sim -- reset full-20                     replace the stack's company with one, on today's date
//   npm run sim -- advance 30d                       live the stack's company through the next 30 days
//   npm run sim -- save <name> | restore <name> | saves
//   npm run sim -- --help                            everything else
//
// While the stack runs, its API holds the PGlite database (one process per folder), so reset, advance, save
// and restore go through GET and POST /__dev/workspace (server/src/dev/routes.ts) on 127.0.0.1 at the stack's
// port, with the secret the stack wrote to <data folder>/dev-tools.json. advance reads the company, lives the
// days in this process (src/sim/advance.ts) and replaces it. The app takes a replaced company the way it
// takes one another computer sent. With no stack running, they take the stack's lock (its pid file, which
// npm run stack and npm run sql check first) and work on a copy of <data folder>/pg, which a replace swaps in
// (pg-swap.mjs): the folder itself is never written in place, so a command stopped on the way cannot damage it.
//
// Generated companies are cached in <data folder>/scenarios, keyed by scenario, seed, as-of date and a hash
// of the source files generation runs on. The company's date between commands is kept in <data folder>/
// sim-date.json, for the copy the server holds. It never reads DATABASE_URL or a .env file, and never
// connects anywhere but this computer's dev stack. The pure parts are in sim-lib.ts.
//
// It runs in California time on every computer (sim-zone.ts, imported first, before any date code).
import './sim-zone'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Db, openPGlite } from '../../server/src/db'
import { DEV_WORKSPACE_PATH } from '../../server/src/dev/routes'
import { readStackWorkspace, replaceStackWorkspace, STACK_WORKSPACE, type StackReplaced, type StackWorkspace } from '../../server/src/dev/workspace'
import { migrate as migrateDatabase } from '../../server/src/migrate'
import { describeProblem, integrityProblems } from '../../src/domain/integrity'
import { headcountOn } from '../../src/domain/people'
import type { DB } from '../../src/domain/types'
import { type ISODate, setClockOverride, today } from '../../src/lib/dates'
import { num } from '../../src/lib/format'
import { newId } from '../../src/lib/id'
import { advance } from '../../src/sim/advance'
import { generateCompany } from '../../src/sim/generate'
import { SCENARIOS, type ScenarioName } from '../../src/sim/scenarios'
import { loadSample, migrate as upgradeStored } from '../../src/store/db'
import {
  advanceTarget,
  cacheFileName,
  cachePrefix,
  type CompanyDate,
  companyDateFor,
  DEFAULT_ADVANCE_SEED,
  type Generated,
  parseDuration,
  parseSimArgs,
  resetCompany,
  type SimArgs,
  scenarioLines,
  sourceHash,
  USAGE,
  workspaceJson,
} from './sim-lib'
import { copyToWork, discardWork, recoverSimFolders, swapIn } from './pg-swap.mjs'
import { probe, readSecret } from './stack-api'
import { DEV_TOOLS_FILE, devDirName, stackPorts } from './stack-lib.mjs'
import { createPidFile, isStackProcess, readStackPid } from './stack-process.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
/** What npm run sim writes as `holder` in the stack's pid file while it holds the folder. */
const SIM_HOLDER = 'npm run sim'
/** A replace of a large company takes a few seconds; the API answers nothing else meanwhile. */
const API_TIMEOUT_MS = 120_000

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`
const sizeOf = (bytes: number) => (bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(2)} MB` : `${Math.round(bytes / 1000)} KB`)

// ------------------------------------------------------------------------------------------------
// The stack's company: through its API, or the folder itself
// ------------------------------------------------------------------------------------------------

type Stack = {
  /** Where the company was read or written, for the line that says so. */
  where: string
  read(): Promise<StackWorkspace>
  replace(db: DB): Promise<StackReplaced>
  close(): Promise<void>
}

/** Asks the running stack's API (server/src/dev/routes.ts). */
function apiStack(port: number, secret: string, devDir: string, restart: string): Stack {
  async function call<T>(method: 'GET' | 'POST', body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await fetch(`http://127.0.0.1:${port}${DEV_WORKSPACE_PATH}`, {
        method,
        headers: { authorization: `Bearer ${secret}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      })
    } catch (err) {
      if ((err as Error).name === 'TimeoutError') throw new Error(`No answer from the stack's API within ${API_TIMEOUT_MS / 1000} seconds.`)
      throw new Error(`Could not reach the stack's API on 127.0.0.1:${port}: ${(err as Error).message}`)
    }
    const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (res.status === 200 && parsed) return parsed as T
    if (res.status === 404) {
      throw new Error(`The stack's API did not take the request: it started before npm run sim existed, or ${devDir}/${DEV_TOOLS_FILE} is from another run. Restart it (${restart}) and try again.`)
    }
    const why = typeof parsed?.detail === 'string' ? `: ${parsed.detail}` : typeof parsed?.error === 'string' ? ` (${parsed.error})` : ''
    throw new Error(`The stack's API answered ${res.status}${why}.`)
  }
  return {
    where: `through the running stack's API (127.0.0.1:${port})`,
    read: () => call<StackWorkspace>('GET'),
    replace: (db) => call<StackReplaced>('POST', { workspaceId: STACK_WORKSPACE, db }),
    async close() {},
  }
}

/**
 * Takes the stack's lock: its pid file, created only if there is none (a file left by a stack or a sim that
 * stopped without cleaning up is removed first), the same way npm run stack creates it, so only one of them
 * can hold the folder. npm run stack refuses to start while it is held. Returns the function that lets it
 * go, which removes the file only while it is still this process's.
 */
function takeLock(dir: string, devDir: string): () => void {
  const pidFile = path.join(dir, 'stack.pid')
  const mine = { pid: process.pid, startedAt: new Date().toISOString(), holder: SIM_HOLDER }
  const stale = `If it is not running any more, delete ${devDir}/stack.pid and try again.`
  for (let attempt = 0; ; attempt++) {
    const taken = createPidFile(pidFile, mine)
    if (!taken) break
    const held = taken.held
    if (held && held.pid !== process.pid && isStackProcess(held.pid)) {
      throw new Error(
        held.holder === SIM_HOLDER
          ? `Another npm run sim is writing to ${devDir} (pid ${held.pid}). Try again when it has finished. ${stale}`
          : `A stack is running or starting on ${devDir} (pid ${held.pid}) and holds its database. Wait for "First Twenty is running", then try again. ${stale}`,
      )
    }
    if (attempt > 0) throw new Error(`Something else took ${devDir}/stack.pid just now. Try again.`)
    rmSync(pidFile, { force: true })
  }
  return () => {
    if (readStackPid(pidFile)?.pid === process.pid) rmSync(pidFile, { force: true })
  }
}

/**
 * The stack's database folder with no stack running, holding the stack's lock until close. It never writes
 * <data folder>/pg in place: it opens a copy, and a replace closes the copy and swaps it in (pg-swap.mjs). So
 * Ctrl+C, or a crash, at any point leaves the folder as it was; Ctrl+C stops the command before the swap.
 */
async function folderStack(dir: string, devDir: string, restart: string): Promise<Stack> {
  const release = takeLock(dir, devDir)
  let stopping = false
  const stop = () => {
    if (!stopping) console.error("sim: stopping. The stack's database stays as it was.")
    stopping = true
  }
  const signals = ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])] as NodeJS.Signals[]
  for (const s of signals) process.on(s, stop)
  let db: Db | null = null
  const finish = async () => {
    try {
      await db?.close()
    } finally {
      db = null
      discardWork(dir, process.pid)
      for (const s of signals) process.off(s, stop)
      release()
    }
  }
  const unlessStopping = () => {
    if (stopping) throw new Error("Stopped (Ctrl+C) before anything was written: the stack's company is as it was.")
  }
  try {
    // Under the lock: put right what an npm run sim stopped on the way left behind.
    for (const line of recoverSimFolders(dir)) console.error(`sim: ${line}.`)
    if (!existsSync(path.join(dir, 'pg', 'PG_VERSION'))) throw new Error(`There is no database in ${devDir} yet. Run ${restart} once to make it.`)
    db = await openPGlite(copyToWork(dir, process.pid))
    // What the stack does on start (MIGRATE_ON_START), so the copy is in the shape the code expects.
    await migrateDatabase(db)
  } catch (err) {
    await finish()
    throw err
  }
  const open = () => {
    if (!db) throw new Error('The database copy is already closed.')
    return db
  }
  return {
    where: `in ${devDir}/pg (no stack is running)`,
    read: () => readStackWorkspace(open()),
    async replace(next) {
      unlessStopping()
      const done = await replaceStackWorkspace(open(), next)
      await open().close()
      db = null
      unlessStopping()
      swapIn(dir, process.pid)
      return done
    },
    close: finish,
  }
}

/** The way to the stack's company for this offset: its API when something answers on its port, else the folder. */
async function openStack(offset: number): Promise<Stack> {
  const devDir = devDirName(offset)
  const dir = path.join(root, devDir)
  const port = stackPorts(offset).api
  const restart = `npm run stack${offset ? ` -- --offset ${offset}` : ''}`
  if ((await probe(port)) === 'answers') {
    const secret = readSecret(path.join(dir, DEV_TOOLS_FILE))
    if (secret) return apiStack(port, secret, devDir, restart)
    throw new Error(
      `Something answers on 127.0.0.1:${port}, but ${devDir}/${DEV_TOOLS_FILE} is missing: a stack started before npm run sim existed, ` +
        `or npm run server:dev. Restart the stack (${restart}), or stop what runs on that port.`,
    )
  }
  return folderStack(dir, devDir, restart)
}

// ------------------------------------------------------------------------------------------------
// The company's date between commands, the cache and saves
// ------------------------------------------------------------------------------------------------

const dataDir = (offset: number) => path.join(root, devDirName(offset))
const dateFile = (offset: number) => path.join(dataDir(offset), 'sim-date.json')
const savesDir = (offset: number) => path.join(dataDir(offset), 'saves')

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

/** Writes through a temporary file, so a reader never sees half a file. */
function writeAtomically(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

function rememberDate(offset: number, value: CompanyDate): void {
  writeAtomically(dateFile(offset), `${JSON.stringify(value, null, 2)}\n`)
}

type CacheEntry = { scenario: ScenarioName; seed: number; asOf: ISODate; sourceHash: string; summary: string; db: DB }

/**
 * A scenario's company, from <data folder>/scenarios when this scenario, seed, date and source were generated
 * before. Either way it comes back through JSON, so a cached and a new company are exactly the same.
 */
function generated(offset: number, scenario: ScenarioName, seed: number, asOf: ISODate): Generated {
  const started = Date.now()
  const hash = sourceHash([path.join(root, 'src', 'sim', 'generate.ts')], root, (file) => (existsSync(file) && statSync(file).isFile() ? readFileSync(file, 'utf8') : undefined))
  const dir = path.join(dataDir(offset), 'scenarios')
  const key = { scenario, seed, asOf, sourceHash: hash }
  const file = path.join(dir, cacheFileName(key))
  const hit = readJson<CacheEntry>(file)
  if (hit && hit.sourceHash === hash && hit.db?.schemaVersion === 1) return { db: hit.db, summary: hit.summary, cached: true, ms: Date.now() - started }

  const g = generateCompany({ scenario, seed, asOf })
  const json = JSON.stringify({ ...key, summary: g.summary, db: g.db } satisfies CacheEntry)
  // Files for this scenario, seed and date from older code are of no more use.
  if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.startsWith(cachePrefix(key)) && f.endsWith('.json')) rmSync(path.join(dir, f), { force: true })
  writeAtomically(file, json)
  return { db: (JSON.parse(json) as CacheEntry).db, summary: g.summary, cached: false, ms: Date.now() - started }
}

type SaveFile = { name: string; savedAt: string; companyDate: ISODate; company: string; db: DB }

// ------------------------------------------------------------------------------------------------
// The commands
// ------------------------------------------------------------------------------------------------

function list(): void {
  console.log(['Scenarios (each has its own seed and as-of date; --seed and --as-of pick others):', ...scenarioLines()].join('\n'))
}

function run(args: SimArgs): void {
  const scenario = SCENARIOS[args.scenario as ScenarioName]
  const g = generated(args.offset, scenario.name, args.seed ?? scenario.seed, args.asOf ?? scenario.asOf)
  console.log(g.summary)
  console.log(`${g.cached ? 'From the cache' : 'Generated'} in ${secs(g.ms)}.`)
  if (args.out) {
    // npm runs scripts from the repo root, so a relative path is from there.
    const out = path.resolve(args.out)
    const json = workspaceJson(g.db)
    writeAtomically(out, json)
    console.log(`Wrote ${out} (${sizeOf(Buffer.byteLength(json))}). Settings > Data > Import reads it.`)
  }
}

/** Integrity problems in a line or a few: what should never be true of the data. */
function integrityLines(db: DB): string[] {
  const problems = integrityProblems(db)
  if (problems.length === 0) return ['Integrity: no problems.']
  return [`Integrity: ${problems.length} problem${problems.length === 1 ? '' : 's'}:`, ...problems.slice(0, 5).map((p) => `  ${describeProblem(p)}`)]
}

async function reset(args: SimArgs): Promise<void> {
  const scenario = SCENARIOS[args.scenario as ScenarioName]
  if (scenario.target !== 'browser') throw new Error(`${scenario.name} is too big for a browser, so it is never loaded into the stack. npm run sim -- run ${scenario.name} --out file.json writes it.`)
  const realToday = today()
  const lines: string[] = []
  let db: DB
  let companyDate: ISODate

  if (scenario.kind === 'sample' && args.shift) {
    if (args.seed !== null || args.asOf !== null) throw new Error('ledgerlark is the sample exactly as the app loads it: it takes no --seed or --as-of (use --no-shift for its authored dates).')
    // The sample as the app and npm run stack load it: moved to this week by loadSample itself.
    db = loadSample()
    companyDate = realToday
    lines.push(`Scenario ledgerlark: ${db.company.name}, the sample as the app loads it, moved to this week.`)
  } else {
    // Generated on the date that puts it on today (sim-lib.ts resetCompany), never moved after it is made.
    const seed = args.seed ?? scenario.seed
    const r = resetCompany({ scenario: scenario.name, seed, asOf: args.asOf ?? scenario.asOf, shift: args.shift, today: realToday }, (asOf) => generated(args.offset, scenario.name, seed, asOf))
    lines.push(r.generated.summary, `${r.generated.cached ? 'From the cache' : 'Generated'} in ${secs(r.generated.ms)}.`, r.note)
    db = r.db
    companyDate = r.companyDate
  }
  // A new identity every reset: a browser that syncs takes it whole, as another company, never merged with what it had.
  db = { ...db, meta: { ...db.meta, workspaceId: newId('ws') } as DB['meta'] }
  lines.push(...integrityLines(db))
  console.log(lines.join('\n'))
  await replaceAndSay(args.offset, db, companyDate, 'The app shows it on its next sync (within 30 seconds, or when its tab gets focus), with a notice that the workspace was replaced.')
}

/** Replaces the stack's company, remembers its date, and says where and how long it took. */
async function replaceAndSay(offset: number, db: DB, companyDate: ISODate, after: string): Promise<void> {
  const started = Date.now()
  const stack = await openStack(offset)
  try {
    const done = await stack.replace(db)
    rememberDate(offset, { historyId: done.historyId, date: companyDate })
    console.log(`Replaced the stack's company ${stack.where}: ${db.company.name}, ${num(done.records)} records, in ${secs(Date.now() - started)}.`)
    console.log(after)
  } finally {
    await stack.close()
  }
}

/** The stack's company as the app would load it, its date, and the stack (still open, for the replace). */
async function readCompany(offset: number): Promise<{ stack: Stack; db: DB; historyId: string; date: ISODate }> {
  const stack = await openStack(offset)
  try {
    const ws = await stack.read()
    if (ws.empty) throw new Error(`The stack has no company yet. npm run sim -- ${offset ? `--offset ${offset} ` : ''}reset seed-8 loads one.`)
    const remembered = readJson<CompanyDate>(dateFile(offset))
    return { stack, db: upgradeStored(ws.db as unknown as DB), historyId: ws.historyId, date: companyDateFor(remembered, ws.historyId, today()) }
  } catch (err) {
    await stack.close()
    throw err
  }
}

async function advanceStack(args: SimArgs): Promise<void> {
  const { stack, db, date: from } = await readCompany(args.offset)
  try {
    const to = advanceTarget(parseDuration(args.duration as string), from)
    const seed = args.seed ?? DEFAULT_ADVANCE_SEED
    const started = Date.now()
    setClockOverride(from)
    let result: ReturnType<typeof advance>
    try {
      result = advance(db, { to, seed, policy: args.policy })
    } finally {
      setClockOverride(null)
    }
    console.log(result.summary)
    console.log(`Lived ${num(result.report.days)} days in ${secs(Date.now() - started)}.`)
    console.log(integrityLines(result.db).join('\n'))
    const replaced = Date.now()
    const done = await stack.replace(result.db)
    rememberDate(args.offset, { historyId: done.historyId, date: to })
    console.log(`Replaced the stack's company ${stack.where}: ${num(done.records)} records, in ${secs(Date.now() - replaced)}.`)
    const real = today()
    console.log(
      to === real
        ? `The company's date is ${to}, today.`
        : `The company's date is now ${to}; the app shows every company on today's date (${real}). To see it on ${to}, let the app take the new copy, then set Settings > Data > Pretend today is to ${to}.`,
    )
  } finally {
    await stack.close()
  }
}

async function save(args: SimArgs): Promise<void> {
  const { stack, db, date } = await readCompany(args.offset)
  await stack.close()
  const file = path.join(savesDir(args.offset), `${args.name}.json`)
  const existed = existsSync(file)
  const body: SaveFile = { name: args.name as string, savedAt: new Date().toISOString(), companyDate: date, company: db.company.name, db }
  writeAtomically(file, `${JSON.stringify(body)}\n`)
  console.log(`${existed ? 'Replaced the save' : 'Saved'} ${args.name}: ${db.company.name} on ${date}, ${num(headcountOn(db, date))} employed, ${sizeOf(statSync(file).size)} (${path.relative(root, file)}).`)
}

async function restore(args: SimArgs): Promise<void> {
  const file = path.join(savesDir(args.offset), `${args.name}.json`)
  const saved = readJson<SaveFile>(file)
  if (!saved?.db) throw new Error(`There is no save named ${args.name}${existsSync(file) ? ' that can be read' : ''}. npm run sim -- saves lists them.`)
  console.log(`Restoring ${args.name}: ${saved.company} on ${saved.companyDate}, saved ${saved.savedAt}.`)
  await replaceAndSay(args.offset, saved.db, saved.companyDate, 'The app shows it on its next sync, with a notice that the workspace was replaced.')
}

function saves(args: SimArgs): void {
  const dir = savesDir(args.offset)
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : []
  if (files.length === 0) {
    console.log(`No saves in ${path.relative(root, dir)} yet. npm run sim -- save <name> keeps a copy of the stack's company.`)
    return
  }
  for (const f of files) {
    const saved = readJson<SaveFile>(path.join(dir, f))
    const size = sizeOf(statSync(path.join(dir, f)).size)
    console.log(saved?.db ? `  ${f.slice(0, -5).padEnd(24)} ${saved.company} on ${saved.companyDate}, saved ${saved.savedAt.slice(0, 16).replace('T', ' ')} UTC, ${size}` : `  ${f} (cannot be read)`)
  }
}

async function main(): Promise<number> {
  let args: SimArgs
  try {
    args = parseSimArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`sim: ${(err as Error).message}\n\n${USAGE}`)
    return 2
  }
  try {
    switch (args.command) {
      case 'help':
        console.log(USAGE)
        break
      case 'list':
        list()
        break
      case 'run':
        run(args)
        break
      case 'reset':
        await reset(args)
        break
      case 'advance':
        await advanceStack(args)
        break
      case 'save':
        await save(args)
        break
      case 'restore':
        await restore(args)
        break
      case 'saves':
        saves(args)
        break
    }
    return 0
  } catch (err) {
    console.error(`sim: ${(err as Error).message}`)
    return 1
  }
}

process.exitCode = await main()
