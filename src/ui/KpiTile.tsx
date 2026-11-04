import type { ReactNode } from 'react'

/** Scrolls a section into view and puts focus on it, so a KPI tile works the same by keyboard and pointer. */
export function jumpTo(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  el.scrollIntoView({ block: 'start' })
  el.focus({ preventScroll: true })
}

/**
 * A key figure that is a button: it jumps to the section with the detail (`target` is that section's id,
 * focusable by script, tabIndex -1). Used by the Home and Hiring summary strips.
 */
export function KpiTile({ label, target, jumpLabel, children }: { label: string; target: string; jumpLabel: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => jumpTo(target)}
      className="ft-stat flex min-w-0 flex-col items-start rounded-sm border border-line bg-surface px-4 py-3.5 text-left transition-colors hover:border-line-strong"
    >
      <span className="ft-stat__label text-[13px] font-semibold text-ink-3">{label}</span>
      {children}
      <span className="sr-only">. {jumpLabel}</span>
    </button>
  )
}

export function KpiValue({ children }: { children: ReactNode }) {
  return <span className="ft-stat__value num mt-1.5 font-display text-[28px] leading-none font-bold text-ink">{children}</span>
}

export function KpiSub({ children }: { children: ReactNode }) {
  return <span className="ft-stat__sub mt-1.5 text-[13px] text-ink-2">{children}</span>
}
