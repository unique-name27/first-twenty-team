// How fast a demo company may write (app.ts: PUT /api/workspace and POST /api/changes from a login whose
// workspace is not kept), in memory and per process, in sliding windows per workspace:
// - write requests a minute, so a script cannot keep the database busy for every other company;
// - bytes of record JSON an hour, so it cannot churn the disk either. The byte budgets in repo.ts bound
//   what a company holds; this bounds how fast it rewrites it.
// A browser that syncs normally sends a push every few seconds at most, far below both. Over a limit the
// write is refused with 429 write_limit and retryAfter; the browser keeps the changes and tries again.
// The owner's own (kept) workspaces are never limited here.
import { type RateLimitResult, SlidingWindowCounter } from './auth'

export type WriteLimits = {
  /** Write requests one workspace may send per minute. */
  requestsPerMinute: number
  /** Bytes of record and document JSON one workspace may send per hour. */
  bytesPerHour: number
  /** Most workspaces each limit keeps in memory (the least recently used is forgotten beyond). */
  maxKeys: number
}

export const DEMO_WRITE_LIMITS: WriteLimits = { requestsPerMinute: 120, bytesPerHour: 64 * 1024 * 1024, maxKeys: 10_000 }

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000

export class WriteBudget {
  readonly limits: WriteLimits
  private readonly requests: SlidingWindowCounter
  /** Per workspace, the bytes each write sent and when, oldest first; least recently used key first. */
  private readonly sent = new Map<string, Array<{ at: number; bytes: number }>>()
  private readonly now: () => number

  constructor(limits: Partial<WriteLimits> = {}, options: { now?: () => number } = {}) {
    this.limits = { ...DEMO_WRITE_LIMITS, ...limits }
    this.requests = new SlidingWindowCounter(MINUTE_MS, this.limits.maxKeys, this.limits.requestsPerMinute, { forgetLockouts: true })
    this.now = options.now ?? Date.now
  }

  private recent(key: string, now: number): Array<{ at: number; bytes: number }> {
    const list = (this.sent.get(key) ?? []).filter((e) => e.at > now - HOUR_MS)
    if (list.length === 0) this.sent.delete(key)
    else this.sent.set(key, list)
    return list
  }

  /**
   * One write of `bytes` by workspace `key`: counted against both limits, or refused (counted against
   * neither) with the seconds until it would fit. A write bigger than the hourly budget on its own fits
   * when the workspace sent nothing for an hour (the request body limits cap it anyway).
   */
  take(key: string, bytes: number): RateLimitResult {
    const now = this.now()
    const byRequests = this.requests.retryAfter(key, now)
    if (byRequests > 0) return { ok: false, retryAfter: byRequests }
    const list = this.recent(key, now)
    let total = list.reduce((n, e) => n + e.bytes, 0)
    if (total > 0 && total + bytes > this.limits.bytesPerHour) {
      // Until enough of the oldest writes leave the window for this one to fit (all of them at most).
      let i = 0
      while (total > 0 && total + bytes > this.limits.bytesPerHour) total -= list[i++].bytes
      return { ok: false, retryAfter: Math.max(1, Math.ceil((list[i - 1].at + HOUR_MS - now) / 1000)) }
    }
    this.requests.add(key, now)
    // Re-inserting moves the key to the end, so the first key is the least recently used.
    this.sent.delete(key)
    this.sent.set(key, [...list, { at: now, bytes }])
    if (this.sent.size > this.limits.maxKeys) this.sent.delete(this.sent.keys().next().value as string)
    return { ok: true }
  }

  /** Drops workspaces with no recent writes (the owner runs it on a timer, never per request). */
  sweep(): void {
    const now = this.now()
    this.requests.sweep(now)
    for (const key of [...this.sent.keys()]) this.recent(key, now)
  }
}
