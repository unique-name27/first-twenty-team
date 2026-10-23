import { describe, expect, it } from 'vitest'
import { moneyRange, moneyShort } from './format'

describe('short money', () => {
  it('reads thousands, millions and billions', () => {
    expect(moneyShort(950)).toBe('$950')
    expect(moneyShort(185_000)).toBe('$185K')
    expect(moneyShort(1_250_000)).toBe('$1.25M')
    expect(moneyShort(12_400_000)).toBe('$12.4M')
    expect(moneyShort(1_200_000_000)).toBe('$1.2B')
    expect(moneyShort(-2_500_000_000)).toBe('-$2.5B')
  })

  it('shows a mistyped range for what it is (180,000 with 175000 typed after it)', () => {
    expect(moneyShort(180_000_175_000)).toBe('$180B')
    expect(moneyRange(180_000_175_000, 230_000_225_000)).toBe('$180B-$230B')
  })
})
