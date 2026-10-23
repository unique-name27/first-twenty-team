import type { ReactNode } from 'react'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { cx } from './cx'
import { rovingKeyDown, rovingTabIndex } from './roving'

export type TabDef<K extends string = string> = { key: K; label: ReactNode; count?: number; href?: string }

/**
 * Underline tabs. Pass `href` on each tab to make them links (deep-linkable sub-views): they render
 * as a <nav> of links with aria-current, since each one loads its own view. Pass `onChange` for local
 * state: they render as an ARIA tablist with arrow-key movement.
 * On narrow screens the strip scrolls sideways; the active tab and the focused one are kept in view and a
 * fade shows that more tabs exist.
 */
export function Tabs<K extends string>({
  tabs,
  value,
  onChange,
  label,
  className,
}: {
  tabs: Array<TabDef<K>>
  value: K
  onChange?: (key: K) => void
  label: string
  className?: string
}) {
  const uid = useId().replace(/:/g, '')
  const scroller = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  const isNav = tabs.length > 0 && tabs.every((t) => t.href)

  const measure = useCallback(() => {
    const sc = scroller.current
    if (!sc) return
    const left = sc.scrollLeft > 2
    const right = sc.scrollLeft + sc.clientWidth < sc.scrollWidth - 2
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }))
  }, [])

  const fade = 28

  // Scroll the strip until a tab is clear of the edge fade, with room for its focus ring. Horizontal only
  // (never scrollIntoView), so the page never jumps. Text size zooms the page: rects come back zoomed while
  // scroll offsets do not, hence the scale.
  const keepInView = useCallback((el: HTMLElement | null | undefined) => {
    const sc = scroller.current
    if (!sc || !el) return
    const scr = sc.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    const scale = sc.offsetWidth ? scr.width / sc.offsetWidth : 1
    const l = (r.left - scr.left) / scale + sc.scrollLeft
    const w = r.width / scale
    const room = fade + 8
    // The fades show only where the strip can scroll further.
    const leftFade = sc.scrollLeft > 2 ? room : 0
    const rightFade = sc.scrollLeft + sc.clientWidth < sc.scrollWidth - 2 ? room : 0
    if (l < sc.scrollLeft + leftFade) sc.scrollLeft = Math.max(0, l - room)
    else if (l + w > sc.scrollLeft + sc.clientWidth - rightFade) sc.scrollLeft = l + w - sc.clientWidth + room
  }, [])

  // Keep the active tab in view.
  const reveal = useCallback(() => {
    keepInView(scroller.current?.querySelector<HTMLElement>('[data-active="true"]'))
    measure()
  }, [keepInView, measure])

  useLayoutEffect(reveal, [value, tabs.length, reveal])

  // A page opened straight on a later tab (#settings.server at 375px) lays the strip out before the web
  // fonts and the column width settle, so the first reveal can fall short: reveal again when the strip
  // or its tabs change size, and once the fonts are ready.
  useEffect(() => {
    const sc = scroller.current
    if (!sc) return
    let live = true
    document.fonts?.ready.then(() => {
      if (live) reveal()
    })
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reveal)
    ro?.observe(sc)
    if (sc.firstElementChild) ro?.observe(sc.firstElementChild)
    return () => {
      live = false
      ro?.disconnect()
    }
  }, [reveal])
  const mask =
    edges.left || edges.right
      ? `linear-gradient(to right, ${edges.left ? `transparent 0, #000 ${fade}px` : '#000 0'}, ${edges.right ? `#000 calc(100% - ${fade}px), transparent 100%` : '#000 100%'})`
      : undefined

  const states = tabs.map((t) => ({ on: t.key === value }))
  const strip = tabs.map((t, i) => {
    const active = t.key === value
    const cls = cx(
      'ft-tab',
      active && 'ft-tab--active',
      'relative inline-flex h-11 shrink-0 items-center gap-2 px-3 text-[14.5px] font-semibold transition-colors focus-visible:outline-offset-[-3px]',
      active ? 'text-ink' : 'text-ink-3 hover:text-ink',
    )
    const inner = (
      <>
        {t.label}
        {t.count != null && (
          <span className={cx('ft-tab__count num rounded-full px-1.5 py-px text-[12px]', active ? 'bg-accent-soft text-accent-soft-ink' : 'bg-surface-2 text-ink-3')}>
            {t.count}
          </span>
        )}
        {active && <span aria-hidden className="ft-tab__indicator absolute inset-x-2 -bottom-px h-[3px] rounded-t-full bg-accent" />}
      </>
    )
    if (isNav) {
      return (
        <a key={t.key} href={t.href} aria-current={active ? 'page' : undefined} data-active={active || undefined} className={cls}>
          {inner}
        </a>
      )
    }
    return (
      <button
        key={t.key}
        id={`tab-${uid}-${t.key}`}
        type="button"
        role="tab"
        aria-selected={active}
        tabIndex={rovingTabIndex(i, states)}
        data-active={active || undefined}
        className={cls}
        onClick={() => (t.href ? (window.location.hash = t.href.slice(1)) : onChange?.(t.key))}
      >
        {inner}
      </button>
    )
  })

  return (
    <div
      ref={scroller}
      onScroll={measure}
      // A tab reached with Tab or the arrow keys scrolls fully into view too, not only the active one.
      onFocusCapture={(e) => keepInView((e.target as HTMLElement).closest<HTMLElement>('.ft-tab'))}
      className={cx('ft-tabs-wrap scroll-thin -mx-1 overflow-x-auto overflow-y-hidden', className)}
      style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
    >
      {isNav ? (
        <nav aria-label={label} className="ft-tabs flex min-w-max gap-1 border-b border-line px-1">
          {strip}
        </nav>
      ) : (
        <div
          role="tablist"
          aria-label={label}
          onKeyDown={(e) => rovingKeyDown(e, { select: true })}
          className="ft-tabs flex min-w-max gap-1 border-b border-line px-1"
        >
          {strip}
        </div>
      )}
    </div>
  )
}
