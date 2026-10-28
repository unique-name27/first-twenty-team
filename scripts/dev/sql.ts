// `npm run sql`: read-only SQL on the npm run stack database, for development (docs/DEV.md).
//
//   npm run sql -- hires                   a shortcut (sql-lib.ts SHORTCUTS)
//   npm run sql -- "SELECT ... "           one statement of your own
//   npm run sql -- --help                  everything else
//
// While the stack runs, its API holds the PGlite database (one process per folder), so this asks the API:
// POST /__dev/sql on 127.0.0.1 at the stack's port, with the secret the stack wrote to <data folder>/
// dev-tools.json (server/src/dev/routes.ts). With no stack running, it copies <data folder>/pg to a temporary
// folder (sql-copy.ts says why) and opens the copy in a worker thread (sql-worker.ts) that it stops after
// STATEMENT_TIMEOUT_MS, then deletes the copy. Either way the statement runs in
// server/src/dev/readonly.ts: one statement, read only, rolled back. It never reads DATABASE_URL or a .env
// file, and never connects anywhere but this computer's dev stack. The pure parts are in sql-lib.ts.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { type SqlAnswer, type SqlProblem, type SqlRequest, STATEMENT_TIMEOUT_MS } from '../../server/src/dev/readonly'
import { DEV_SQL_PATH } from '../../server/src/dev/routes'
import {
  asObjects,
  DEFAULT_WORKSPACE,
  formatTable,
  parseSqlArgs,
  problemText,
  requestFor,
  rowCountLine,
  type SqlArgs,
  USAGE,
  WORKSPACE_LIST_SQL,
  WORKSPACE_LOOKUP_SQL,
} from './sql-lib'
import { copyForReading, type DatabaseCopy } from './sql-copy'
import type { FromWorker, ToWorker, WorkerData } from './sql-worker'
import { DEV_TOOLS_FILE, devDirName, stackPorts } from './stack-lib.mjs'
import { isStackProcess, readStackPid } from './stack-process.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
/** How long past the statement limit to wait for the stack's API (it answers other requests too). */
const API_GRACE_MS = 3000
/** How long opening the database may take without a stack (PGlite starts in about a second). */
const OPEN_TIMEOUT_MS = 60_000

/** A statement that was refused or failed in the database: printed in plain words, exit code 1. */
class ProblemError extends Error {
  constructor(readonly problem: SqlProblem) {
    super(problem.message)
  }
}

type Runner = {
  /** Where the rows came from, for the line under them. */
  where: string
  run(request: SqlRequest): Promise<SqlAnswer>
  close(): Promise<void>
}

/** The secret in the stack's dev-tools.json, or null when the file is missing or not one of ours. */
function readSecret(file: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { secret?: unknown }
    return typeof parsed.secret === 'string' && parsed.secret.length >= 32 ? parsed.secret : null
  } catch {
    return null
  }
}

const refused = (err: unknown) => (err as { cause?: { code?: string } } | null)?.cause?.code === 'ECONNREFUSED'

/** Whether anything listens on 127.0.0.1:port: 'nothing' only when the connection is refused. */
async function probe(port: number): Promise<'answers' | 'nothing'> {
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })
    return 'answers'
  } catch (err) {
    // No answer in time still means something holds the port: a busy API, most likely.
    return refused(err) ? 'nothing' : 'answers'
  }
}

/** Asks the running stack's API (server/src/dev/routes.ts). */
function stackRunner(port: number, secret: string, devDir: string, restart: string): Runner {
  const waitMs = STATEMENT_TIMEOUT_MS + API_GRACE_MS
  return {
    where: `Read through the running stack's API (127.0.0.1:${port}).`,
    async run(request) {
      let res: Response
      try {
        res = await fetch(`http://127.0.0.1:${port}${DEV_SQL_PATH}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(waitMs),
        })
      } catch (err) {
        if ((err as Error).name === 'TimeoutError') {
          throw new Error(
            `No answer from the stack's API within ${waitMs / 1000} seconds. PGlite cannot stop a statement once it runs, so the API ` +
              `finishes it before it answers anything else. If it does not come back, stop the stack (Ctrl+C) and run ${restart} again.`,
          )
        }
        throw new Error(`Could not reach the stack's API on 127.0.0.1:${port}: ${(err as Error).message}`)
      }
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
      if (res.status === 200 && body) return body as unknown as SqlAnswer
      if (res.status === 400 && (body?.error === 'refused' || body?.error === 'sql_error')) {
        throw new ProblemError({
          kind: body.error,
          message: String(body.detail),
          ...(typeof body.code === 'string' ? { code: body.code } : {}),
          ...(typeof body.position === 'number' ? { position: body.position } : {}),
        })
      }
      if (res.status === 404) {
        throw new Error(`The stack's API did not take the request: it started before npm run sql existed, or ${devDir}/${DEV_TOOLS_FILE} is from another run. Restart it (${restart}) and try again.`)
      }
      throw new Error(`The stack's API answered ${res.status}${typeof body?.error === 'string' ? ` (${body.error})` : ''}.`)
    },
    async close() {},
  }
}

/**
 * Opens a copy of the database folder in a worker thread, which it stops if a statement runs past
 * STATEMENT_TIMEOUT_MS. The copy goes when the runner closes or fails to open.
 */
async function directRunner(copy: DatabaseCopy, devDir: string, fresh: string): Promise<Runner> {
  try {
    return await openCopy(copy, devDir, fresh)
  } catch (err) {
    copy.remove()
    throw err
  }
}

async function openCopy(copy: DatabaseCopy, devDir: string, fresh: string): Promise<Runner> {
  const worker = new Worker(new URL('./sql-worker.ts', import.meta.url), { workerData: { pgDir: copy.dir } satisfies WorkerData })
  const send = (message: ToWorker) => worker.postMessage(message)
  /** Settles each message the worker sends: one listener at a time. */
  let listener: ((message: FromWorker) => void) | null = null
  let stopped: string | null = null
  const stop = (why: string) => {
    stopped ??= why
    listener?.({ type: 'failed', message: stopped })
  }
  worker.on('message', (message: FromWorker) => listener?.(message))
  worker.on('error', (err) => stop(err.message))
  worker.on('exit', () => stop('the database worker stopped'))

  /** The worker's next message, or `onTimeout()` after `ms`, when the worker is stopped (PGlite cannot be interrupted). */
  const next = (ms: number, onTimeout: () => Error): Promise<FromWorker> =>
    new Promise((resolve, reject) => {
      if (stopped !== null) return resolve({ type: 'failed', message: stopped })
      const timer = setTimeout(() => {
        listener = null
        stopped ??= 'stopped after a timeout'
        void worker.terminate()
        reject(onTimeout())
      }, ms)
      listener = (message) => {
        clearTimeout(timer)
        listener = null
        resolve(message)
      }
    })

  const opened = await next(OPEN_TIMEOUT_MS, () => new Error(`Opening ${devDir}/pg took more than ${OPEN_TIMEOUT_MS / 1000} seconds.`))
  if (opened.type !== 'ready') {
    await worker.terminate()
    // A copy taken while a stack was starting may not open (try again); a folder damaged by a hard stop
    // never does: PGlite cannot open a folder it was writing to when its process was killed.
    if (opened.type === 'failed') {
      throw new Error(
        `${devDir}/pg: ${opened.message} npm run sql read a copy and left the folder as it was. If a stack started just now, ` +
          `run this again. If the stack was stopped hard (killed, or the computer stopped), the folder may be damaged: ${fresh} ` +
          'makes a new one (it deletes this database and the dev login).',
      )
    }
    throw new Error('The database worker did not start.')
  }

  let id = 0
  return {
    where: `Read from a copy of ${devDir}/pg (no stack is running).`,
    async run(request) {
      id += 1
      send({ type: 'run', id, request })
      const reply = await next(
        STATEMENT_TIMEOUT_MS,
        () => new Error(`The statement ran for more than ${STATEMENT_TIMEOUT_MS / 1000} seconds, so npm run sql stopped it. Narrow it with a WHERE or a LIMIT.`),
      )
      if (reply.type === 'answer') return reply.answer
      if (reply.type === 'problem') throw new ProblemError(reply.problem)
      throw new Error(reply.type === 'failed' ? reply.message : 'The database worker answered out of turn.')
    },
    async close() {
      if (stopped === null) {
        send({ type: 'close' })
        await next(10_000, () => new Error('Closing the database took too long; it was stopped instead.')).catch(() => undefined)
      }
      await worker.terminate()
      copy.remove()
    },
  }
}

/**
 * The way to the stack's database for this offset: its API when something answers on the stack's port,
 * else the folder itself, unless a stack is still starting there or the folder holds no database yet.
 */
async function connect(offset: number): Promise<Runner> {
  const devDir = devDirName(offset)
  const dir = path.join(root, devDir)
  const port = stackPorts(offset).api
  const restart = `npm run stack${offset ? ` -- --offset ${offset}` : ''}`
  if ((await probe(port)) === 'answers') {
    const secret = readSecret(path.join(dir, DEV_TOOLS_FILE))
    if (secret) return stackRunner(port, secret, devDir, restart)
    throw new Error(
      `Something answers on 127.0.0.1:${port}, but ${devDir}/${DEV_TOOLS_FILE} is missing: a stack started before npm run sql existed, ` +
        `or npm run server:dev. Restart the stack (${restart}), or stop what runs on that port.`,
    )
  }
  const stack = readStackPid(path.join(dir, 'stack.pid'))
  if (stack && isStackProcess(stack.pid)) {
    throw new Error(`A stack is starting on ${devDir} (pid ${stack.pid}) and holds its database. Wait for "First Twenty is running", then try again.`)
  }
  const pgDir = path.join(dir, 'pg')
  if (!existsSync(path.join(pgDir, 'PG_VERSION'))) throw new Error(`There is no database in ${devDir} yet. Run ${restart} once to make it.`)
  return directRunner(copyForReading(pgDir), devDir, `npm run stack -- ${offset ? `--offset ${offset} ` : ''}--fresh`)
}

/** The company's id for --workspace (an id or a slug), or a message listing the companies there are. */
async function workspaceId(runner: Runner, args: SqlArgs): Promise<string> {
  if (args.workspace === null) return DEFAULT_WORKSPACE
  const found = await runner.run({ sql: WORKSPACE_LOOKUP_SQL, params: [args.workspace] })
  if (found.rows.length > 0) return String(found.rows[0][0])
  const all = await runner.run({ sql: WORKSPACE_LIST_SQL })
  throw new Error(`No company has the id or slug "${args.workspace}". The companies here:\n${formatTable(all)}`)
}

async function main(): Promise<number> {
  let args: SqlArgs
  try {
    args = parseSqlArgs(process.argv.slice(2))
    if (!args.help) requestFor(args, DEFAULT_WORKSPACE) // its checks, before connecting
  } catch (err) {
    console.error(`sql: ${(err as Error).message}\n\n${USAGE}`)
    return 2
  }
  if (args.help) {
    console.log(USAGE)
    return 0
  }

  let runner: Runner | null = null
  try {
    runner = await connect(args.offset)
    const answer = await runner.run(requestFor(args, await workspaceId(runner, args)))
    if (args.json) {
      console.log(JSON.stringify(asObjects(answer), null, 2))
      console.error(`${rowCountLine(answer)} ${runner.where}`)
    } else {
      const table = formatTable(answer)
      console.log([...(table ? [table] : []), rowCountLine(answer), runner.where].join('\n'))
    }
    return 0
  } catch (err) {
    if (err instanceof ProblemError) {
      console.error(problemText(err.problem, args.sql))
      if (err.problem.code === '42P01' && args.shortcut) {
        console.error(`The shortcuts read the views from migration 007. Run npm run stack${args.offset ? ` -- --offset ${args.offset}` : ''} once to bring this database up to date.`)
      }
    } else console.error(`sql: ${(err as Error).message}`)
    return 1
  } finally {
    await runner?.close()
  }
}

process.exitCode = await main()
