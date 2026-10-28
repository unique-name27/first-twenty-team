// `npm run sql` when no stack runs (scripts/dev/sql.ts): this worker thread opens the stack's PGlite folder
// and runs statements through server/src/dev/readonly.ts (read only, rolled back). It is a worker so that
// sql.ts can stop it after STATEMENT_TIMEOUT_MS: PGlite cannot stop a statement once it runs, and a running
// statement holds the thread it runs on. Nothing is written, so stopping it mid-statement loses nothing.
import { parentPort, workerData } from 'node:worker_threads'
import { openPGlite } from '../../server/src/db'
import { runReadOnly, type SqlAnswer, type SqlProblem, sqlProblem, type SqlRequest } from '../../server/src/dev/readonly'

export type WorkerData = { pgDir: string }
export type ToWorker = { type: 'run'; id: number; request: SqlRequest } | { type: 'close' }
export type FromWorker =
  | { type: 'ready' }
  | { type: 'answer'; id: number; answer: SqlAnswer }
  | { type: 'problem'; id: number; problem: SqlProblem }
  | { type: 'failed'; id?: number; message: string }
  | { type: 'closed' }

const port = parentPort
if (!port) throw new Error('scripts/dev/sql-worker.ts runs as a worker thread of scripts/dev/sql.ts.')
const send = (message: FromWorker) => port.postMessage(message)
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

try {
  const db = await openPGlite((workerData as WorkerData).pgDir)
  port.on('message', async (message: ToWorker) => {
    if (message.type === 'close') {
      await db.close()
      send({ type: 'closed' })
      port.close()
      return
    }
    try {
      send({ type: 'answer', id: message.id, answer: await runReadOnly(db, message.request) })
    } catch (err) {
      const problem = sqlProblem(err)
      send(problem ? { type: 'problem', id: message.id, problem } : { type: 'failed', id: message.id, message: messageOf(err) })
    }
  })
  send({ type: 'ready' })
} catch (err) {
  send({ type: 'failed', message: `could not open the database: ${messageOf(err)}` })
}
