// Finding a running stack's API, for `npm run sql` and `npm run sim` (scripts/dev/sql.ts, scripts/dev/sim.ts):
// whether anything answers on the stack's port, and the secret for its development-only routes, which the
// stack writes to <data folder>/dev-tools.json each time it starts (server/src/dev/routes.ts).
import { readFileSync } from 'node:fs'

/** The secret in the stack's dev-tools.json, or null when the file is missing or not one of ours. */
export function readSecret(file: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { secret?: unknown }
    return typeof parsed.secret === 'string' && parsed.secret.length >= 32 ? parsed.secret : null
  } catch {
    return null
  }
}

const refused = (err: unknown) => (err as { cause?: { code?: string } } | null)?.cause?.code === 'ECONNREFUSED'

/** Whether anything listens on 127.0.0.1:port: 'nothing' only when the connection is refused. */
export async function probe(port: number): Promise<'answers' | 'nothing'> {
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })
    return 'answers'
  } catch (err) {
    // No answer in time still means something holds the port: a busy API, most likely.
    return refused(err) ? 'nothing' : 'answers'
  }
}
