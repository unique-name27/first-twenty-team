// A run: domain functions made reproducible, for simulations and journey tests. Inside withRunContext,
// newId (src/lib/id.ts) gives ids from the run's seed, nowISO (src/lib/dates.ts) gives the pretend date at
// the run's time of day, and logActivity and currentActorId (src/store/draft.ts) record the run's actor and
// Viewing-as instead of reading the device's preferences. Outside a run all four behave exactly as before.
//
// One run at a time: the run is module state, not tied to a call stack, because the app's code runs in
// browsers too (no AsyncLocalStorage there). An async run stays on until its promise settles, so anything
// else that runs meanwhile in this process (a timer, a sync engine) runs inside it. A second run started
// while one is on, nested or alongside, throws.
//
// Module rule: its only runtime import is the seeded random numbers (rng.ts, which imports nothing), so
// id.ts, dates.ts and draft.ts can all read it without an import cycle.
import { makeRng } from '@/data/seed/hiring/rng'
import type { ID, Role } from '@/domain/types'

export type RunOptions = {
  /** Same seed, same ids. A number or a string; 7 and '7' are the same seed. */
  seed: number | string
  /** The person the run acts as: currentActorId and the actor on activity rows. null records no one. */
  actorId: ID | null
  /** The Viewing-as role recorded on activity rows. Default 'admin'. */
  viewingAs?: Role
  /**
   * nowISO's time of day, 'HH:MM' or 'HH:MM:SS' (24-hour), as a clock in California reads it on the pretend
   * date. Pacific because the company is there and the app shows times as it does, and because a zone
   * fixed here, not the computer's, gives the same timestamps on every computer. In a process whose own
   * zone puts that moment on another calendar date (an evening time in a UTC process), nowISO throws.
   */
  timeOfDay: string
}

/** The run that is on: what id.ts, dates.ts and draft.ts read. */
export type ActiveRun = {
  readonly actorId: ID | null
  readonly viewingAs: Role
  readonly time: { readonly hours: number; readonly minutes: number; readonly seconds: number }
  /** The 10 characters after newId's prefix and dash: unique within the run. */
  nextIdSuffix(): string
}

let active: ActiveRun | null = null

/** The run that is on, or null (the app, and everything outside withRunContext). */
export function activeRun(): ActiveRun | null {
  return active
}

/**
 * Runs fn inside a run and returns what it returns. A promise keeps the run on until it settles. The run
 * always ends, also when fn throws or its promise rejects. Throws when a run is already on (runs never
 * nest). The run leaves the clock override (setClockOverride) as fn left it: setting it is the caller's job.
 */
export function withRunContext<T>(options: RunOptions, fn: () => T): T {
  if (active) throw new Error('A run is already on: runs never nest, and only one runs at a time.')
  const run = startRun(options)
  active = run
  const end = () => {
    if (active === run) active = null
  }
  let pending = false
  try {
    const out = fn()
    if (isThenable(out)) {
      pending = true
      return Promise.resolve(out).finally(end) as T
    }
    return out
  } finally {
    if (!pending) end()
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return !!value && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function'
}

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/

/**
 * Run ids are 's' and 9 base-36 characters drawn from the seed. The app's random ids are 10 hex characters
 * (crypto.randomUUID), and 's' is never one, so the two never meet. Where randomUUID is missing, the app
 * falls back to 10 random base-36 characters: a run id matches one of those about once in 36^10 (3.6
 * quadrillion) tries. Lowercase base 36 keeps the shape the app expects (src/sync/loadTime.ts).
 */
const RUN_ID_MARK = 's'

function startRun(options: RunOptions): ActiveRun {
  const time = TIME_OF_DAY.exec(options.timeOfDay)
  if (!time) throw new Error(`A run's time of day is 'HH:MM' or 'HH:MM:SS' (24-hour), not '${options.timeOfDay}'.`)
  if (typeof options.seed === 'number' && !Number.isFinite(options.seed)) throw new Error(`A run's seed is a finite number or a string, not ${options.seed}.`)
  const rng = makeRng(hashSeed(`ids ${options.seed}`))
  const issued = new Set<string>()
  const draw = () => Math.floor(rng.next() * 36 ** 5).toString(36).padStart(5, '0') + Math.floor(rng.next() * 36 ** 4).toString(36).padStart(4, '0')
  return {
    actorId: options.actorId,
    viewingAs: options.viewingAs ?? 'admin',
    time: { hours: Number(time[1]), minutes: Number(time[2]), seconds: Number(time[3] ?? 0) },
    nextIdSuffix() {
      let suffix = RUN_ID_MARK + draw()
      while (issued.has(suffix)) suffix = RUN_ID_MARK + draw()
      issued.add(suffix)
      return suffix
    },
  }
}

/** A 32-bit number from the seed's text (FNV-1a, then mixed so seeds one character apart land far apart). */
function hashSeed(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}
