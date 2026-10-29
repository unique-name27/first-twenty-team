import { describe, expect, it } from 'vitest'
import { makeRng } from './rng'

describe('makeRng', () => {
  it('gives the same numbers for the same seed', () => {
    const a = makeRng(42)
    const b = makeRng(42)
    expect(Array.from({ length: 5 }, () => a.next())).toEqual(Array.from({ length: 5 }, () => b.next()))
  })

  it('goes on from a state exactly where the sequence was', () => {
    const rng = makeRng(7)
    for (let i = 0; i < 13; i++) rng.next()
    const resumed = makeRng(rng.state())
    expect(Array.from({ length: 20 }, () => resumed.next())).toEqual(Array.from({ length: 20 }, () => rng.next()))
    // A fresh generator's state is its seed.
    expect(makeRng(123).state()).toBe(123)
  })
})
