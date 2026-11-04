// The pure rules the simulator panel and its worker share: how many days a slice of the loop lives at each
// speed, and how the feed keeps its newest events.
import { describe, expect, it } from 'vitest'
import { appendCapped, sliceDays } from './protocol'

describe('sliceDays', () => {
  it('lives 1, 7 or 30 days for each second that passes', () => {
    expect(sliceDays('day', 0, 1000)).toEqual({ days: 1, carried: 0 })
    expect(sliceDays('week', 0, 1000)).toEqual({ days: 7, carried: 0 })
    expect(sliceDays('month', 0, 1000)).toEqual({ days: 30, carried: 0 })
  })

  it('carries part of a day to the next slice', () => {
    const first = sliceDays('day', 0, 600)
    expect(first.days).toBe(0)
    expect(first.carried).toBeCloseTo(0.6)
    expect(sliceDays('day', first.carried, 600).days).toBe(1)
  })

  it('never owes more than a second of days after the tab slept, or less than none when the clock jumps back', () => {
    expect(sliceDays('week', 0, 60_000).days).toBe(7)
    expect(sliceDays('week', 0.5, -500)).toEqual({ days: 0, carried: 0.5 })
  })

  it('has no budget at Max: the slice time stops it', () => {
    expect(sliceDays('max', 3, 10)).toEqual({ days: Number.POSITIVE_INFINITY, carried: 0 })
  })
})

describe('appendCapped', () => {
  it('keeps the newest items up to the cap', () => {
    expect(appendCapped([1, 2, 3], [4, 5], 4)).toEqual([2, 3, 4, 5])
    expect(appendCapped([1, 2], [3], 5)).toEqual([1, 2, 3])
    expect(appendCapped([1, 2, 3], [], 2)).toEqual([2, 3])
  })

  it('gives back the same list when nothing is added and it fits', () => {
    const list = [1, 2]
    expect(appendCapped(list, [], 5)).toBe(list)
  })
})
