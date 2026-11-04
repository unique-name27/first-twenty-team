// A run: domain functions made reproducible, for simulations and journey tests. Inside withRunContext,
// newId (src/lib/id.ts) gives ids from the run's seed, nowISO (src/lib/dates.ts) gives the pretend date at
// the run's time of day, and logActivity and currentActorId (src/store/draft.ts) record the run's actor and
// Viewing-as instead of reading the device's preferences. Outside a run all four behave exactly as before.
//
// One run at a time: the run is module state, not tied to a call stack, because the app's code runs in
// browsers too (no AsyncLocalStorage there). An async run stays on until its promise settles, so anything
// else that runs meanwhile in this process (a timer, a sync engine) runs inside it. A second run started
// while one is on, nested or alongside, throws. A long run that tells a story (the simulator, src/sim) moves
// its actor and time of day along with updateRun, and keeps one stream of ids. A run can also be held open
// between entries (openRun, then withRun each time): its id stream goes on where the last entry left it, and
// runState and restoreRun put it back to an earlier point, for a simulation that steps and rewinds.
//
// Module rule: its only runtime import is the seeded random numbers (rng.ts, which imports nothing), so
// id.ts, dates.ts and draft.ts can all read it without an import cycle.
import { makeRng, type Rng } from '@/data/seed/hiring/rng'
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
  /**
   * Id suffixes (the 10 characters after newId's prefix and dash) the run never issues: the run ids already
   * in a workspace the run builds on (runIdSuffixes), so a later run never repeats an earlier one's ids,
   * whatever their seeds.
   */
  avoid?: Iterable<string>
}

/** The run that is on: what id.ts, dates.ts and draft.ts read. */
export type ActiveRun = {
  readonly actorId: ID | null
  readonly viewingAs: Role
  readonly time: { readonly hours: number; readonly minutes: number; readonly seconds: number }
  /** The 10 characters after newId's prefix and dash: unique within the run. */
  nextIdSuffix(): string
}

/** The run as this module holds it: what updateRun may change, and the id stream it never resets. */
type HeldRun = {
  actorId: ID | null
  viewingAs: Role
  time: ActiveRun['time']
  nextIdSuffix(): string
  /** The id stream's generator: replaced on restoreRun. */
  rng: Rng
  /** Suffixes the run never issues (RunOptions.avoid). */
  readonly avoid: ReadonlySet<string>
  /** Suffixes issued so far, in order (append-only, so a saved state keeps only their count). */
  readonly issued: string[]
  readonly issuedSet: Set<string>
}

/** A run held open between entries (openRun, withRun). */
export type RunHandle = { readonly [handleBrand]: true }
declare const handleBrand: unique symbol

/** Where a held run is: enough to put it back there with restoreRun. */
export type RunState = {
  readonly actorId: ID | null
  readonly viewingAs: Role
  readonly time: ActiveRun['time']
  readonly idRngState: number
  readonly issuedCount: number
}

let active: HeldRun | null = null

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
  return withRun(openRun(options), fn)
}

/**
 * A run that is not on yet: withRun turns it on for one call at a time, and its actor, Viewing-as, time of
 * day and id stream carry over from one call to the next. Throws on options it cannot read.
 */
export function openRun(options: RunOptions): RunHandle {
  return startRun(options) as unknown as RunHandle
}

/**
 * Turns a held run on for fn, as withRunContext does (the same rules: a promise keeps it on until it settles,
 * it always ends, and it throws when a run is already on).
 */
export function withRun<T>(handle: RunHandle, fn: () => T): T {
  if (active) throw new Error('A run is already on: runs never nest, and only one runs at a time.')
  const run = held(handle)
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

/** What updateRun may change: who the run acts as, in which Viewing-as mode, and its time of day. */
export type RunUpdate = Partial<Pick<RunOptions, 'actorId' | 'viewingAs' | 'timeOfDay'>>

/**
 * Changes the run's actor, Viewing-as and time of day from here on, for a run that moves through a story
 * (one action by the founder in the morning, the next by an interviewer the day after). Fields left out
 * stay as they were; the id stream goes on unchanged, so ids stay unique across the whole run. Throws
 * outside a run, and on a time of day it cannot read (then nothing changes).
 */
export function updateRun(update: RunUpdate): void {
  if (!active) throw new Error('No run is on: updateRun works only inside withRunContext.')
  const time = update.timeOfDay !== undefined ? readTimeOfDay(update.timeOfDay) : active.time
  if (update.actorId !== undefined) active.actorId = update.actorId
  if (update.viewingAs !== undefined) active.viewingAs = update.viewingAs
  active.time = time
}

/** Where a held run is now: its actor, Viewing-as, time of day and how far its id stream has gone. */
export function runState(handle: RunHandle): RunState {
  const run = held(handle)
  return { actorId: run.actorId, viewingAs: run.viewingAs, time: run.time, idRngState: run.rng.state(), issuedCount: run.issued.length }
}

/**
 * Puts a held run back where runState found it: the ids issued since are forgotten, and the next ids are the
 * ones that came next then. Throws while the run is on, and for a state from further along than the run is.
 */
export function restoreRun(handle: RunHandle, state: RunState): void {
  const run = held(handle)
  if (active === run) throw new Error('A run cannot be put back while it is on.')
  if (state.issuedCount > run.issued.length) throw new Error('That run state is from further along than the run is.')
  for (const suffix of run.issued.splice(state.issuedCount)) run.issuedSet.delete(suffix)
  run.rng = makeRng(state.idRngState)
  run.actorId = state.actorId
  run.viewingAs = state.viewingAs
  run.time = state.time
}

function held(handle: RunHandle): HeldRun {
  return handle as unknown as HeldRun
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

/** A run id in JSON text: the prefix's dash, then the suffix ('s' and 9 base-36 characters), then the closing quote. */
const RUN_ID_IN_JSON = /-(s[0-9a-z]{9})"/g

/**
 * The suffixes of every run id in a value (a workspace), nested ones included, for RunOptions.avoid. Reads
 * the JSON text, so it finds ids wherever they sit (records, checklist tasks, history rows).
 */
export function runIdSuffixes(value: unknown): Set<string> {
  const out = new Set<string>()
  for (const m of JSON.stringify(value).matchAll(RUN_ID_IN_JSON)) out.add(m[1])
  return out
}

/** 'HH:MM' or 'HH:MM:SS' as hours, minutes and seconds; throws on anything else. */
function readTimeOfDay(timeOfDay: string): ActiveRun['time'] {
  const time = TIME_OF_DAY.exec(timeOfDay)
  if (!time) throw new Error(`A run's time of day is 'HH:MM' or 'HH:MM:SS' (24-hour), not '${timeOfDay}'.`)
  return { hours: Number(time[1]), minutes: Number(time[2]), seconds: Number(time[3] ?? 0) }
}

function startRun(options: RunOptions): HeldRun {
  const time = readTimeOfDay(options.timeOfDay)
  if (typeof options.seed === 'number' && !Number.isFinite(options.seed)) throw new Error(`A run's seed is a finite number or a string, not ${options.seed}.`)
  const run: HeldRun = {
    actorId: options.actorId,
    viewingAs: options.viewingAs ?? 'admin',
    time,
    rng: makeRng(hashSeed(`ids ${options.seed}`)),
    avoid: new Set(options.avoid ?? []),
    issued: [],
    issuedSet: new Set(),
    nextIdSuffix() {
      const draw = () => Math.floor(run.rng.next() * 36 ** 5).toString(36).padStart(5, '0') + Math.floor(run.rng.next() * 36 ** 4).toString(36).padStart(4, '0')
      let suffix = RUN_ID_MARK + draw()
      while (run.avoid.has(suffix) || run.issuedSet.has(suffix)) suffix = RUN_ID_MARK + draw()
      run.issued.push(suffix)
      run.issuedSet.add(suffix)
      return suffix
    },
  }
  return run
}

/** A 32-bit number from the seed's text (FNV-1a, then mixed so seeds one character apart land far apart). */
function hashSeed(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}
