import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { forwardRef } from 'react'
import { cx } from './cx'
import { Icon, type IconName } from './Icon'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet'
type Size = 'sm' | 'md' | 'lg'

const VARIANT: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink hover:bg-accent-hover border border-transparent shadow-sm',
  secondary: 'bg-surface text-ink border border-line-strong hover:bg-surface-2',
  ghost: 'bg-transparent text-ink-2 border border-transparent hover:bg-surface-2 hover:text-ink',
  danger: 'bg-bad text-white border border-transparent hover:opacity-90',
  quiet: 'bg-surface-2 text-ink border border-transparent hover:bg-surface-3',
}

// Large targets for motor accessibility: at least 40px small, 44px default, 48px large (use lg for
// the primary action in inbox rows, pipeline cards and sheets). Minimum heights, not fixed ones: a
// label longer than the space it has (large text on a phone) wraps onto a second line inside the
// button instead of running past it or widening the page.
const SIZE: Record<Size, string> = {
  sm: 'min-h-10 px-3 py-1 text-[13.5px] leading-tight gap-1.5 rounded-lg',
  md: 'min-h-11 px-4 py-1.5 text-[14.5px] leading-tight gap-2 rounded-lg',
  lg: 'min-h-12 px-5 py-2 text-[15.5px] leading-tight gap-2 rounded-xl',
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant
  size?: Size
  icon?: IconName
  iconRight?: IconName
  children?: ReactNode
}

/**
 * The Button's classes (hooks and utilities), for markup that must look exactly like a Button without
 * being one, such as the decorative sample in a Display menu look card (a button inside a button is invalid).
 */
export function buttonClass(variant: Variant = 'secondary', size: Size = 'md', className?: string): string {
  return cx(
    // shrink-0 keeps one line while there is room; max-w-full lets a long label wrap once there is not.
    'ft-btn',
    `ft-btn--${variant}`,
    `ft-btn--${size}`,
    'inline-flex max-w-full shrink-0 items-center justify-center text-center font-semibold transition-colors select-none',
    'disabled:cursor-not-allowed disabled:opacity-50',
    VARIANT[variant],
    SIZE[size],
    className,
  )
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, iconRight, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={buttonClass(variant, size, className)} {...rest}>
      {icon && <Icon name={icon} size={size === 'sm' ? 16 : 18} className="ft-btn__icon shrink-0" />}
      {children}
      {iconRight && <Icon name={iconRight} size={size === 'sm' ? 16 : 18} className="ft-btn__icon ft-btn__icon--right shrink-0" />}
    </button>
  )
})

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconName
  /** Required: icon-only buttons need an accessible name (also shown as a tooltip). */
  label: string
  variant?: Variant
  size?: Size
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, variant = 'ghost', size = 'md', className, type = 'button', ...rest },
  ref,
) {
  const dim = size === 'sm' ? 'h-10 w-10' : size === 'lg' ? 'h-12 w-12' : 'h-11 w-11'
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        'ft-iconbtn',
        `ft-iconbtn--${variant}`,
        `ft-iconbtn--${size}`,
        'inline-flex shrink-0 items-center justify-center rounded-lg transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIANT[variant],
        dim,
        className,
      )}
      {...rest}
    >
      <Icon name={icon} size={size === 'sm' ? 17 : 19} />
    </button>
  )
})

/**
 * Text-styled link that navigates inside the app (uses the router's href). Its hit area is at least 40px
 * tall without moving anything around it: a transparent 14px border above and below. Inside running text an
 * inline border changes no line spacing and wraps with the words; where the link is a box (a flex item, a
 * panel action) the matching negative margin takes it back out of the layout, and content-box sizing keeps
 * a height a look gives it (the trading desk's 40px bar commands) for the text. The background stops at the
 * padding box, so a look that fills links (on hover, or behind them) never paints over the lines nearby.
 */
export function TextLink({
  href,
  children,
  className,
  title,
  hitArea = true,
}: {
  href: string
  children: ReactNode
  className?: string
  title?: string
  /** false where the call site gives the link a 40px box of its own (a list of full-row links). */
  hitArea?: boolean
}) {
  return (
    <a
      href={href}
      title={title}
      className={cx(
        'ft-link',
        'font-semibold text-accent underline decoration-accent/30 underline-offset-2 hover:decoration-accent',
        // The focus ring keeps to the text, where it was before the hit area.
        hitArea && 'box-content -my-3.5 border-y-[14px] border-transparent focus-visible:outline-offset-[calc(var(--focus-offset)_-_14px)]',
        className,
      )}
      // Inline, so a look's `background` shorthand (which resets background-clip) cannot paint the border.
      style={hitArea ? { backgroundClip: 'padding-box' } : undefined}
    >
      {children}
    </a>
  )
}
