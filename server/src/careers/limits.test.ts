// The careers apply limits (limits.ts): posts per address, applications per address and per company,
// each in its own sliding window. An application takes its place in both at once, before anything is
// awaited, and gives it back only when the server says so.
import { describe, expect, it } from 'vitest'
import { ApplyRateLimiter, DEFAULT_APPLY_LIMITS } from './limits'

const HOUR = 3_600_000

describe('ApplyRateLimiter', () => {
  it('defaults to 30 posts and 5 applications an address an hour, and 100 applications a company a day', () => {
    expect(DEFAULT_APPLY_LIMITS).toMatchObject({ postsPerAddress: 30, perAddress: 5, perWorkspace: 100 })
  })

  it('counts posts per address and refuses the one over the limit until the hour has passed', () => {
    let now = 0
    const l = new ApplyRateLimiter({ postsPerAddress: 2, now: () => now })
    expect(l.post('a').ok).toBe(true)
    expect(l.post('a').ok).toBe(true)
    const refused = l.post('a')
    expect(refused).toEqual({ ok: false, retryAfter: 3600 })
    expect(l.post('b').ok).toBe(true)
    now = HOUR
    expect(l.post('a').ok).toBe(true)
  })

  it('take a place against the address and the company at once, refusing without counting anything', () => {
    let now = 0
    const l = new ApplyRateLimiter({ perAddress: 2, perWorkspace: 3, now: () => now })
    expect(l.reserve('a', 'w1').ok).toBe(true)
    expect(l.reserve('a', 'w1').ok).toBe(true)
    expect(l.reserve('a', 'w1')).toEqual({ ok: false, retryAfter: 3600, reason: 'address' })
    expect(l.reserve('a', 'w2')).toMatchObject({ ok: false, reason: 'address' })
    // The refusals counted nowhere: w1 holds two, and b takes the third.
    expect(l.reserve('b', 'w1').ok).toBe(true)
    expect(l.reserve('c', 'w1')).toEqual({ ok: false, retryAfter: 86_400, reason: 'workspace' })
    expect(l.reserve('c', 'w2').ok).toBe(true)
    now = HOUR
    expect(l.reserve('a', 'w2').ok).toBe(true)
    expect(l.reserve('a', 'w1')).toMatchObject({ ok: false, reason: 'workspace' })
    now = 24 * HOUR
    l.sweep()
    expect(l.reserve('c', 'w1').ok).toBe(true)
  })

  it('hold every place taken at the same moment, so a burst cannot pass the limits, and give back released ones', () => {
    const l = new ApplyRateLimiter({ perAddress: 5, perWorkspace: 7, now: () => 0 })
    // Thirty posts from one address at once: five places, whatever the database does in between.
    const fromOne = Array.from({ length: 30 }, () => l.reserve('a', 'w1'))
    expect(fromOne.filter((r) => r.ok)).toHaveLength(5)
    // Others fill the company's day, and no more.
    const fromMany = ['b', 'c', 'd', 'e'].map((x) => l.reserve(x, 'w1'))
    expect(fromMany.map((r) => r.ok)).toEqual([true, true, false, false])
    // A place given back (nothing was written) is free again, for the address and for the company.
    l.release('a', 'w1')
    expect(l.reserve('f', 'w1').ok).toBe(true)
    expect(l.reserve('a', 'w2').ok).toBe(true)
  })

  it('never refuses a new address because every key it keeps holds a lockout', () => {
    const l = new ApplyRateLimiter({ postsPerAddress: 1, perAddress: 1, maxKeys: 2, now: () => 0 })
    for (const a of ['a', 'b', 'c', 'd']) {
      expect(l.post(a).ok, a).toBe(true)
      expect(l.reserve(a, `w-${a}`).ok, a).toBe(true)
    }
  })
})
