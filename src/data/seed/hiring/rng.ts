// Seeded pseudo-random numbers for the sample hiring data (mulberry32). Deterministic: the same seed
// always builds the same candidates, dates and ratings. Never use Math.random in seed code.
// Module rule: functions only (no module-level runtime constants), because the seed can run while
// the store module is still loading (see src/domain/lifecycle.ts).

export type Rng = {
  /** Float in [0, 1). */
  next: () => number
  /** Integer in [min, max], inclusive. */
  int: (min: number, max: number) => number
  pick: <T>(xs: readonly T[]) => T
  chance: (p: number) => boolean
  /** Picks by weight: [[value, weight], ...]. */
  weighted: <T>(pairs: ReadonlyArray<readonly [T, number]>) => T
  shuffle: <T>(xs: readonly T[]) => T[]
}

export function makeRng(seed: number): Rng {
  let a = seed >>> 0
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (min: number, max: number): number => (max <= min ? min : min + Math.floor(next() * (max - min + 1)))
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]
  const chance = (p: number): boolean => next() < p
  const weighted = <T,>(pairs: ReadonlyArray<readonly [T, number]>): T => {
    const total = pairs.reduce((s, [, w]) => s + w, 0)
    let r = next() * total
    for (const [v, w] of pairs) {
      r -= w
      if (r < 0) return v
    }
    return pairs[pairs.length - 1][0]
  }
  const shuffle = <T,>(xs: readonly T[]): T[] => {
    const out = [...xs]
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1))
      ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
  }
  return { next, int, pick, chance, weighted, shuffle }
}
