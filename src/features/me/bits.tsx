// Small pieces shared by the Me tabs (kept local; nothing here is general enough for src/ui).
import type { Draft } from 'immer'
import type { ReactNode } from 'react'
import type { DB } from '@/domain/types'
import { useDB } from '@/store/db'
import { cx, Icon, type IconName, toast } from '@/ui'

/** A link that looks like a Button (secondary, md: 44px tall). Use for navigation, never for actions. */
export function ButtonLink({
  href,
  children,
  icon,
  iconRight,
  variant = 'secondary',
  size = 'md',
  className,
  label,
}: {
  href: string
  children: ReactNode
  icon?: IconName
  iconRight?: IconName
  variant?: 'primary' | 'secondary' | 'ghost'
  size?: 'md' | 'lg'
  className?: string
  /** Accessible name when the visible text is short ("Open"). */
  label?: string
}) {
  return (
    <a
      href={href}
      aria-label={label}
      className={cx(
        'ft-btn',
        `ft-btn--${variant}`,
        `ft-btn--${size}`,
        'inline-flex shrink-0 items-center justify-center font-semibold whitespace-nowrap transition-colors select-none',
        size === 'lg' ? 'h-12 gap-2 rounded-xl px-5 text-[15.5px]' : 'h-11 gap-2 rounded-lg px-4 text-[14.5px]',
        variant === 'primary'
          ? 'border border-transparent bg-accent text-accent-ink shadow-sm hover:bg-accent-hover'
          : variant === 'ghost'
            ? 'border border-transparent bg-transparent text-ink-2 hover:bg-surface-2 hover:text-ink'
            : 'border border-line-strong bg-surface text-ink hover:bg-surface-2',
        className,
      )}
    >
      {icon && <Icon name={icon} size={18} className="ft-btn__icon" />}
      {children}
      {iconRight && <Icon name={iconRight} size={18} className="ft-btn__icon ft-btn__icon--right" />}
    </a>
  )
}

/** Runs a store change and shows the Undo toast that names it. */
export function change(label: string, recipe: (draft: Draft<DB>) => void): void {
  useDB.getState().mutate(label, recipe)
  toast({ text: label, action: { label: 'Undo', onClick: () => useDB.getState().undo() } })
}

/** Label on the left, value on the right; wraps under the label on narrow screens. */
export function LineItem({ label, value, sub }: { label: ReactNode; value: ReactNode; sub?: ReactNode }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2.5">
      <span className="min-w-0 text-[14.5px] text-ink">
        {label}
        {sub && <span className="block text-[13px] text-ink-3">{sub}</span>}
      </span>
      <span className="text-[14px] text-ink-2">{value}</span>
    </li>
  )
}

/** "Not legal advice" line that sits next to citation chips wherever a rule is explained. */
export function NotLegalAdvice() {
  return <span className="text-[12.5px] text-ink-3">Not legal advice.</span>
}
