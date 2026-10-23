// Money that respects the privacy blur (key B). Use it for any pay, cost or equity value.
import type { ReactNode } from 'react'
import { money, moneyRange, moneyShort } from '@/lib/format'
import { usePrefs } from '@/store/prefs'
import { cx } from './cx'

/** Wraps any sensitive content (amounts, share counts) so the privacy blur hides it. */
export function Private({ children, className }: { children: ReactNode; className?: string }) {
  const blur = usePrefs((s) => s.privacyBlur)
  return (
    <span
      className={cx('ft-private num transition-[filter]', blur && 'ft-private--on select-none blur-[6px]', className)}
      aria-hidden={blur || undefined}
      title={blur ? 'Hidden by privacy blur (press B)' : undefined}
    >
      {children}
    </span>
  )
}

export function Money({
  value,
  short,
  className,
  suffix,
}: {
  value: number | null | undefined
  short?: boolean
  className?: string
  suffix?: string
}) {
  if (value == null) return <span className="text-ink-3">Not set</span>
  return (
    <Private className={className}>
      {short ? moneyShort(value) : money(value)}
      {suffix}
    </Private>
  )
}

export function MoneyRange({ min, max, className }: { min: number | null | undefined; max: number | null | undefined; className?: string }) {
  if (min == null && max == null) return <span className="text-ink-3">No range</span>
  return <Private className={className}>{moneyRange(min, max)}</Private>
}
