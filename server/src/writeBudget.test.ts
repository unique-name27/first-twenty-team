// How fast a demo company may write (writeBudget.ts): requests a minute and bytes an hour, per workspace,
// in sliding windows, refused writes counted against neither.
import { describe, expect, it } from 'vitest'
import { DEMO_WRITE_LIMITS, WriteBudget } from './writeBudget'

const MINUTE = 60_000
const HOUR = 3_600_000

describe('WriteBudget', () => {
  it('defaults to 120 writes a minute and 64 MB an hour, far above a browser that syncs normally', () => {
    expect(DEMO_WRITE_LIMITS).toMatchObject({ requestsPerMinute: 120, bytesPerHour: 64 * 1024 * 1024 })
  })

  it('counts writes per workspace a minute, and refuses the one over until the minute has passed', () => {
    let now = 0
    const b = new WriteBudget({ requestsPerMinute: 2 }, { now: () => now })
    expect(b.take('w1', 10).ok).toBe(true)
    expect(b.take('w1', 10).ok).toBe(true)
    expect(b.take('w1', 10)).toEqual({ ok: false, retryAfter: 60 })
    expect(b.take('w2', 10).ok).toBe(true)
    now = MINUTE
    expect(b.take('w1', 10).ok).toBe(true)
  })

  it('counts bytes per workspace an hour, says when enough has left the window, and counts nothing refused', () => {
    let now = 0
    const b = new WriteBudget({ bytesPerHour: 1000 }, { now: () => now })
    expect(b.take('w1', 600).ok).toBe(true)
    now = 10 * MINUTE
    expect(b.take('w1', 300).ok).toBe(true)
    now = 20 * MINUTE
    // 900 sent: 200 more do not fit until the first 600 leave the window (at one hour).
    expect(b.take('w1', 200)).toEqual({ ok: false, retryAfter: 40 * 60 })
    // 800 more do not fit until both have left.
    expect(b.take('w1', 800)).toEqual({ ok: false, retryAfter: 50 * 60 })
    // The refusals counted nowhere: 100 still fits.
    expect(b.take('w1', 100).ok).toBe(true)
    expect(b.take('w2', 1000).ok).toBe(true)
    now = HOUR + 1
    expect(b.take('w1', 600).ok).toBe(true)
  })

  it('lets one write bigger than the hourly budget through when nothing else was sent in the hour', () => {
    let now = 0
    const b = new WriteBudget({ bytesPerHour: 1000 }, { now: () => now })
    expect(b.take('w1', 5000).ok).toBe(true)
    expect(b.take('w1', 1).ok).toBe(false)
    now = HOUR + 1
    b.sweep()
    expect(b.take('w1', 5000).ok).toBe(true)
  })

  it('keeps at most maxKeys workspaces, forgetting the least recently used', () => {
    const b = new WriteBudget({ bytesPerHour: 100, maxKeys: 2 }, { now: () => 0 })
    expect(b.take('a', 100).ok).toBe(true)
    expect(b.take('b', 100).ok).toBe(true)
    // A third workspace: a, the least recently used, is forgotten.
    expect(b.take('c', 100).ok).toBe(true)
    expect(b.take('c', 1).ok).toBe(false)
    expect(b.take('a', 1).ok).toBe(true)
  })
})
