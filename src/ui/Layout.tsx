import type { ReactNode } from 'react'
import { cx } from './cx'
import { Icon, type IconName } from './Icon'

/** Top of every page: title, one-line context, and the page's primary actions. */
export function PageHeader({
  title,
  subtitle,
  eyebrow,
  actions,
  back,
}: {
  title: ReactNode
  subtitle?: ReactNode
  eyebrow?: ReactNode
  actions?: ReactNode
  /** Optional back link: { href, label } */
  back?: { href: string; label: string }
}) {
  return (
    <header className="ft-pagehead flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-5">
      <div className="ft-pagehead__main min-w-0">
        {back && (
          <a
            href={back.href}
            className="ft-pagehead__back -mt-2 mb-0.5 inline-flex min-h-10 items-center gap-1 text-[13.5px] font-semibold text-ink-3 hover:text-ink"
          >
            <Icon name="arrow-left" size={15} />
            {back.label}
          </a>
        )}
        {eyebrow && <div className="ft-pagehead__eyebrow eyebrow mb-1">{eyebrow}</div>}
        <h1 className="ft-pagehead__title text-[26px] leading-tight font-bold text-ink sm:text-[30px]">{title}</h1>
        {subtitle && <p className="ft-pagehead__subtitle mt-1 max-w-[70ch] text-[15px] text-ink-2">{subtitle}</p>}
      </div>
      {actions && <div className="ft-pagehead__actions flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}

/** A bordered surface for one block of related content. Use for sections, not for every element. */
export function Panel({
  title,
  subtitle,
  actions,
  icon,
  children,
  className,
  bodyClassName,
  padded = true,
  id,
}: {
  title?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  icon?: IconName
  children: ReactNode
  className?: string
  bodyClassName?: string
  padded?: boolean
  id?: string
}) {
  return (
    <section id={id} className={cx('ft-panel min-w-0 rounded-2xl border border-line bg-surface shadow-card', className)}>
      {(title || actions) && (
        // The title keeps at least 14rem (or the whole row); when the actions do not fit beside it they
        // wrap onto their own line instead of squeezing the title to a sliver.
        <div className="ft-panel__head flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line px-5 py-3.5">
          <div className="flex min-w-[min(100%,14rem)] flex-[1_1_14rem] items-start gap-2.5">
            {icon && <Icon name={icon} size={18} className="ft-panel__icon mt-0.5 shrink-0 text-ink-3" />}
            <div className="min-w-0">
              {title && <h2 className="ft-panel__title text-[16px] leading-snug font-bold text-ink">{title}</h2>}
              {subtitle && <p className="ft-panel__subtitle mt-0.5 text-[13.5px] text-ink-3">{subtitle}</p>}
            </div>
          </div>
          {actions && <div className="ft-panel__actions flex max-w-full min-w-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cx('ft-panel__body', padded && 'ft-panel__body--padded px-5 py-4', bodyClassName)}>{children}</div>
    </section>
  )
}

/** Label/value rows for detail views. */
export function DescriptionList({
  items,
  columns = 2,
}: {
  items: Array<{ label: ReactNode; value: ReactNode; hidden?: boolean }>
  columns?: 1 | 2 | 3
}) {
  const cols = columns === 1 ? '' : columns === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-2 lg:grid-cols-3'
  return (
    <dl className={cx('ft-dl grid grid-cols-1 gap-x-6 gap-y-3.5', cols)}>
      {items
        .filter((i) => !i.hidden)
        .map((item, idx) => (
          <div key={idx} className="min-w-0">
            <dt className="ft-dl__term text-[12.5px] font-semibold text-ink-3">{item.label}</dt>
            <dd className="ft-dl__value mt-0.5 text-[14.5px] break-words text-ink">{item.value || <span className="text-ink-3">Not set</span>}</dd>
          </div>
        ))}
    </dl>
  )
}

/** Friendly empty state with one clear next action. */
export function EmptyState({
  icon = 'inbox',
  title,
  body,
  action,
  compact,
  as: Title = 'h2',
}: {
  icon?: IconName
  title: ReactNode
  body?: ReactNode
  action?: ReactNode
  compact?: boolean
  /**
   * The title's element. A heading by default so screen reader users can jump to it; pass 'h1' when the
   * empty state is the whole page (it then also takes focus on route changes), 'h3' inside a sub-section.
   */
  as?: 'h1' | 'h2' | 'h3' | 'h4' | 'p'
}) {
  return (
    <div className={cx('ft-empty flex flex-col items-center text-center', compact ? 'gap-2 py-6' : 'gap-3 py-12')}>
      {/* A plain inline mark, not a tinted circle: looks may restyle or hide it through ft-empty__icon. */}
      <Icon name={icon} size={22} className="ft-empty__icon shrink-0 text-ink-3" />
      <div>
        <Title className="ft-empty__title font-display text-[16px] font-bold text-ink">{title}</Title>
        {body && <p className="ft-empty__body mx-auto mt-1 max-w-[46ch] text-[14px] text-ink-3">{body}</p>}
      </div>
      {action}
    </div>
  )
}

/** Big number with a label; use sparingly, only where the figure is the point. */
export function Stat({
  label,
  value,
  sub,
  tone,
  href,
}: {
  label: ReactNode
  value: ReactNode
  sub?: ReactNode
  tone?: 'good' | 'warn' | 'bad'
  href?: string
}) {
  const body = (
    <>
      <div className="ft-stat__label text-[13px] font-semibold text-ink-3">{label}</div>
      <div
        className={cx(
          'ft-stat__value num mt-1 font-display text-[28px] leading-none font-bold',
          tone === 'good' ? 'text-good' : tone === 'warn' ? 'text-warn' : tone === 'bad' ? 'text-bad' : 'text-ink',
        )}
      >
        {value}
      </div>
      {sub && <div className="ft-stat__sub mt-1.5 text-[13px] text-ink-3">{sub}</div>}
    </>
  )
  const cls = 'ft-stat block min-w-0 rounded-2xl border border-line bg-surface px-4 py-3.5 shadow-card'
  return href ? (
    <a href={href} className={cx(cls, 'transition-colors hover:border-line-strong')}>
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
  )
}

/** Horizontal progress meter with an accessible value. */
export function Meter({
  value,
  max = 1,
  tone = 'accent',
  label,
  className,
}: {
  value: number
  max?: number
  tone?: 'accent' | 'good' | 'warn' | 'bad'
  label?: string
  className?: string
}) {
  const pctVal = max <= 0 ? 0 : Math.max(0, Math.min(1, value / max))
  const bar = tone === 'good' ? 'bg-good' : tone === 'warn' ? 'bg-warn' : tone === 'bad' ? 'bg-bad' : 'bg-accent'
  return (
    <div
      role="meter"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-label={label}
      className={cx('ft-meter', `ft-meter--${tone}`, 'h-2 w-full overflow-hidden rounded-full bg-surface-3', className)}
    >
      <div className={cx('ft-meter__bar h-full rounded-full transition-[width]', bar)} style={{ width: `${pctVal * 100}%` }} />
    </div>
  )
}

/** Callout box for guidance, legal notes and warnings. */
export function Callout({
  tone = 'accent',
  icon,
  title,
  children,
  action,
  className,
}: {
  tone?: 'accent' | 'good' | 'warn' | 'bad' | 'neutral'
  icon?: IconName
  title?: ReactNode
  children?: ReactNode
  action?: ReactNode
  className?: string
}) {
  const t = {
    accent: 'bg-accent-soft text-accent-soft-ink',
    good: 'bg-good-soft text-good',
    warn: 'bg-warn-soft text-warn',
    bad: 'bg-bad-soft text-bad',
    neutral: 'bg-surface-2 text-ink-2',
  }[tone]
  const defaultIcon: IconName = tone === 'warn' || tone === 'bad' ? 'alert' : tone === 'good' ? 'check' : 'info'
  return (
    <div className={cx('ft-callout', `ft-callout--${tone}`, 'flex items-start gap-3 rounded-xl px-4 py-3', t, className)}>
      <Icon name={icon ?? defaultIcon} size={18} className="ft-callout__icon mt-0.5 shrink-0" />
      <div className="ft-callout__content min-w-0 flex-1 text-[14px] text-ink">
        {title && <p className="ft-callout__title font-bold">{title}</p>}
        {children && <div className={cx('ft-callout__body text-ink-2', Boolean(title) && 'mt-0.5')}>{children}</div>}
      </div>
      {action && <div className="ft-callout__action shrink-0">{action}</div>}
    </div>
  )
}

/** Thin labeled divider inside panels and forms. */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('ft-sectionlabel eyebrow flex items-center gap-3 after:h-px after:flex-1 after:bg-line', className)}>{children}</div>
}
