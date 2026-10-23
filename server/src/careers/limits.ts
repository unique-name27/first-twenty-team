// Abuse limits for the careers apply form (routes.ts), in memory and per process, in sliding windows:
// - form posts per client address (IPv6: per /64): 30 an hour, counted before the body is read, so a
//   typo fixed and sent again costs a post but never an application;
// - applications per client address: 5 an hour;
// - applications per company (workspace): 100 a day, so no one, however many addresses they send from,
//   can bury a company's pipeline. The demo record cap (LIMITS.recordsPerDemoWorkspace in validate.ts)
//   bounds what all of it can ever add up to.
// An application counts the moment it passes its checks (reserve), whether it is written or is the same
// person applying to the same role again, so neither concurrent posts nor the answers to them can tell
// anything the limits are not meant to.
// Address keys are cheap to fill, so when every key of a counter holds a lockout the oldest one is
// forgotten instead of refusing new keys (see SlidingWindowCounter in auth.ts).
import { type RateLimitResult, SlidingWindowCounter } from '../auth'

export type ApplyLimits = {
  /** Form posts from one client address per hour, accepted or not. */
  postsPerAddress: number
  /** Applications accepted from one client address per hour. */
  perAddress: number
  /** Applications one company accepts per day. */
  perWorkspace: number
  /** Most keys each counter keeps in memory. */
  maxKeys: number
}

export const DEFAULT_APPLY_LIMITS: ApplyLimits = { postsPerAddress: 30, perAddress: 5, perWorkspace: 100, maxKeys: 10_000 }

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** Why an application was refused: too many from this address, or the company had enough today. */
export type ApplyLimitResult = RateLimitResult | { ok: false; retryAfter: number; reason: 'address' | 'workspace' }

export class ApplyRateLimiter {
  readonly limits: ApplyLimits
  private readonly posts: SlidingWindowCounter
  private readonly byAddress: SlidingWindowCounter
  private readonly byWorkspace: SlidingWindowCounter
  private readonly now: () => number

  constructor(options: Partial<ApplyLimits> & { now?: () => number } = {}) {
    const { now, ...limits } = options
    this.limits = { ...DEFAULT_APPLY_LIMITS, ...limits }
    const { maxKeys } = this.limits
    this.posts = new SlidingWindowCounter(HOUR_MS, maxKeys, this.limits.postsPerAddress, { forgetLockouts: true })
    this.byAddress = new SlidingWindowCounter(HOUR_MS, maxKeys, this.limits.perAddress, { forgetLockouts: true })
    this.byWorkspace = new SlidingWindowCounter(DAY_MS, maxKeys, this.limits.perWorkspace, { forgetLockouts: true })
    this.now = now ?? Date.now
  }

  /** A form post from `address` (a clientAddressKey), before its body is read: counted, or refused. */
  post(address: string): RateLimitResult {
    const now = this.now()
    const key = `ip:${address}`
    const retryAfter = this.posts.retryAfter(key, now)
    if (retryAfter > 0) return { ok: false, retryAfter }
    this.posts.add(key, now)
    return { ok: true }
  }

  /**
   * Takes a place for one application from `address` (a clientAddressKey) to company `workspaceId`,
   * counted against both limits at once, before anything is awaited: posts sent at the same moment cannot
   * all get past a limit none of them was counted against yet. Refused: nothing is counted. Taken: the
   * place stays taken when the application is written and when it is the same person applying to the
   * same role again (so what the limits say never depends on who applied before); give it back with
   * release() only when nothing was written for a reason of the server's own (a full workspace, an error).
   */
  reserve(address: string, workspaceId: string): ApplyLimitResult {
    const now = this.now()
    const fromAddress = this.byAddress.retryAfter(`ip:${address}`, now)
    if (fromAddress > 0) return { ok: false, retryAfter: fromAddress, reason: 'address' }
    const toWorkspace = this.byWorkspace.retryAfter(`ws:${workspaceId}`, now)
    if (toWorkspace > 0) return { ok: false, retryAfter: toWorkspace, reason: 'workspace' }
    this.byAddress.add(`ip:${address}`, now)
    this.byWorkspace.add(`ws:${workspaceId}`, now)
    return { ok: true }
  }

  /** Gives back a place reserve() took (the application was not written). */
  release(address: string, workspaceId: string): void {
    this.byAddress.removeLast(`ip:${address}`)
    this.byWorkspace.removeLast(`ws:${workspaceId}`)
  }

  /** Drops keys with no recent hits (the owner runs it on a timer, never per request). */
  sweep(): void {
    const now = this.now()
    this.posts.sweep(now)
    this.byAddress.sweep(now)
    this.byWorkspace.sweep(now)
  }
}
