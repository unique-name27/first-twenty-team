// Short, readable ids with a type prefix (p-, c-, j-, ...). Collisions are astronomically unlikely
// at this scale; seed data uses hand-picked ids so links in docs and tests stay stable.
import { activeRun } from './runContext'

/** prefix, a dash and 10 characters: random, or inside a run (src/lib/runContext.ts) drawn from its seed. */
export function newId(prefix: string): string {
  const run = activeRun()
  const rand = run
    ? run.nextIdSuffix()
    : typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 10)
      : Math.random().toString(36).slice(2, 12)
  return `${prefix}-${rand}`
}
