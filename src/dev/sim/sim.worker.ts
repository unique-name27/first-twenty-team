// The simulator panel's worker (docs/DEV.md, "The simulator panel"): a shell around runner.ts. client.ts
// starts it with new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' }). A worker has its
// own copy of every module, so the clock override and the run context a simulation sets each day
// (src/lib/dates.ts, src/lib/runContext.ts) are never the app's, and the page stays responsive while it plays.
import { generateCompany } from '@/sim/generate'
import type { FromWorker, ToWorker } from './protocol'
import { createRunner } from './runner'

/** The worker's global, typed by hand: the "webworker" lib clashes with "dom" in one tsconfig. */
const scope = self as unknown as { postMessage(message: FromWorker): void; onmessage: ((e: MessageEvent<ToWorker>) => void) | null }

const runner = createRunner({
  post: (message) => scope.postMessage(message),
  now: () => performance.now(),
  later: (fn, ms) => void setTimeout(fn, ms),
  generate: (scenario, seed, asOf) => generateCompany({ scenario, seed, asOf }).db,
})

scope.onmessage = (e) => runner.handle(e.data)
