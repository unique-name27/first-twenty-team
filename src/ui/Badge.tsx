import type { ReactNode } from 'react'
import { hashString, initials } from '@/lib/format'
import { cx } from './cx'
import { Icon, type IconName } from './Icon'

export type Tone = 'neutral' | 'accent' | 'good' | 'warn' | 'bad' | 'outline'

const TONE: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-ink-2',
  accent: 'bg-accent-soft text-accent-soft-ink',
  good: 'bg-good-soft text-good',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  outline: 'bg-transparent text-ink-2 ring-1 ring-inset ring-line-strong',
}

/** Small status pill. Pair color with a word (never color alone). */
export function Badge({
  tone = 'neutral',
  icon,
  children,
  className,
  title,
}: {
  tone?: Tone
  icon?: IconName
  children: ReactNode
  className?: string
  title?: string
}) {
  return (
    <span
      title={title}
      className={cx(
        'ft-badge',
        `ft-badge--${tone}`,
        // One line while it fits; a long label wraps inside the pill (never past it) on narrow screens.
        // In a table cell it stays on one line: tables scroll sideways in their own wrapper, and a
        // wrapping pill would let the table squeeze it into a narrow column of one word per line.
        'inline-flex min-h-6 max-w-full shrink-0 items-center gap-1 rounded-xl px-2.5 py-0.5 text-[12.5px] leading-tight font-semibold [td_&]:whitespace-nowrap',
        TONE[tone],
        className,
      )}
    >
      {icon && <Icon name={icon} size={13} strokeWidth={2.2} className="shrink-0" />}
      {children}
    </span>
  )
}

const DOT: Record<Tone, string> = {
  neutral: 'bg-ink-3',
  accent: 'bg-accent',
  good: 'bg-good',
  warn: 'bg-warn',
  bad: 'bg-bad',
  outline: 'bg-line-strong',
}

export function Dot({ tone = 'neutral', className }: { tone?: Tone; className?: string }) {
  return <span aria-hidden className={cx('ft-dot', `ft-dot--${tone}`, 'inline-block h-2 w-2 shrink-0 rounded-full', DOT[tone], className)} />
}

// Initials mix the hue half and half with ink: 5.3:1 or better on the tinted fill in both themes.
const AVATAR_BG = [
  'bg-[color-mix(in_oklab,var(--cat-1)_22%,var(--surface))] text-[color-mix(in_oklab,var(--cat-1)_50%,var(--ink))]',
  'bg-[color-mix(in_oklab,var(--cat-2)_22%,var(--surface))] text-[color-mix(in_oklab,var(--cat-2)_50%,var(--ink))]',
  'bg-[color-mix(in_oklab,var(--cat-3)_22%,var(--surface))] text-[color-mix(in_oklab,var(--cat-3)_50%,var(--ink))]',
  'bg-[color-mix(in_oklab,var(--cat-4)_22%,var(--surface))] text-[color-mix(in_oklab,var(--cat-4)_50%,var(--ink))]',
  'bg-[color-mix(in_oklab,var(--cat-5)_22%,var(--surface))] text-[color-mix(in_oklab,var(--cat-5)_50%,var(--ink))]',
  'bg-[color-mix(in_oklab,var(--cat-6)_22%,var(--surface))] text-[color-mix(in_oklab,var(--cat-6)_50%,var(--ink))]',
]

/** Initials avatar with a stable color per person. */
export function Avatar({
  name,
  size = 32,
  className,
  muted,
}: {
  name: string
  size?: number
  className?: string
  /** Dims the avatar (e.g. former employees, rejected candidates). */
  muted?: boolean
}) {
  const hue = hashString(name) % AVATAR_BG.length
  const color = AVATAR_BG[hue]
  return (
    <span
      aria-hidden
      className={cx(
        'ft-avatar',
        muted && 'ft-avatar--muted',
        'inline-flex shrink-0 items-center justify-center rounded-full font-bold select-none',
        muted ? 'bg-surface-2 text-ink-3' : color,
        className,
      )}
      // --ft-avatar-hue: the person's categorical color, so a look can shade avatars without reading the color class.
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.38)), ['--ft-avatar-hue' as string]: `var(--cat-${hue + 1})` }}
    >
      {initials(name)}
    </span>
  )
}

/** Overlapping avatar stack, e.g. an interview panel. */
export function AvatarStack({ names, size = 26, max = 4 }: { names: string[]; size?: number; max?: number }) {
  const shown = names.slice(0, max)
  const extra = names.length - shown.length
  return (
    <span className="ft-avatarstack inline-flex items-center" title={names.join(', ')}>
      {shown.map((n, i) => (
        <span key={`${n}-${i}`} className={cx('rounded-full ring-2 ring-surface', i > 0 && '-ml-2')}>
          <Avatar name={n} size={size} />
        </span>
      ))}
      {extra > 0 && (
        <span
          className="ft-avatar ft-avatar--more -ml-2 inline-flex items-center justify-center rounded-full bg-surface-3 text-[11px] font-bold text-ink-2 ring-2 ring-surface"
          style={{ width: size, height: size }}
        >
          +{extra}
        </span>
      )}
    </span>
  )
}

/** Keyboard key hint, e.g. <Kbd>Ctrl</Kbd><Kbd>K</Kbd> */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="ft-kbd inline-flex h-5 min-w-5 items-center justify-center rounded border border-line-strong bg-surface px-1 font-mono text-[11px] text-ink-3">
      {children}
    </kbd>
  )
}
