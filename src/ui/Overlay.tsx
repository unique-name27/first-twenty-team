// Sheets (side panels), modals, inline confirmations and menus.
// The app never calls window.confirm/alert/prompt (they are blocked in some hosts); use ConfirmButton.
import type { ReactNode } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, type ButtonProps } from './Button'
import { cx } from './cx'
import { Icon, type IconName } from './Icon'

/** Open overlays that listen for Escape, oldest first. Only the newest (topmost) one closes. */
const escapeStack: object[] = []

/**
 * Calls onClose when Escape is pressed anywhere while `active`, but only for the topmost overlay:
 * a menu or dialog opened over a sheet closes alone, and the sheet (and its form) stays. A key event
 * something else already handled (defaultPrevented) is left alone.
 */
export function useEscape(onClose: () => void, active: boolean) {
  const latest = useRef(onClose)
  latest.current = onClose
  useEffect(() => {
    if (!active) return
    const token = {}
    escapeStack.push(token)
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (escapeStack[escapeStack.length - 1] !== token) return
      e.preventDefault()
      latest.current()
    }
    window.addEventListener('keydown', h)
    return () => {
      window.removeEventListener('keydown', h)
      const i = escapeStack.lastIndexOf(token)
      if (i !== -1) escapeStack.splice(i, 1)
    }
  }, [active])
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

function focusablesIn(root: Element | null): HTMLElement[] {
  if (!root) return []
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.tabIndex >= 0 && (n.offsetParent !== null || n === document.activeElement))
}

type FocusFingerprint = { id: string; tag: string; label: string | null; text: string; href: string | null }

function fingerprint(el: HTMLElement): FocusFingerprint {
  return {
    id: el.id,
    tag: el.tagName,
    label: el.getAttribute('aria-label'),
    text: (el.textContent ?? '').trim().slice(0, 80),
    href: el.getAttribute('href'),
  }
}

/** Finds the element that replaced `fp` after a re-render (same id, or same tag, name and text). */
function findReplacement(fp: FocusFingerprint): HTMLElement | null {
  if (fp.id) {
    const byId = document.getElementById(fp.id)
    if (byId) return byId
  }
  const sel = fp.tag.toLowerCase()
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(sel)).filter((n) => {
    if (n.closest('[aria-modal="true"]')) return false
    if (fp.label != null && n.getAttribute('aria-label') !== fp.label) return false
    if (fp.href != null && n.getAttribute('href') !== fp.href) return false
    return (n.textContent ?? '').trim().slice(0, 80) === fp.text
  })
  return candidates.length === 1 ? candidates[0] : null
}

/** Where focus goes when nothing better exists: the page title, else the main region. */
export function focusPageStart(): void {
  const h1 = document.querySelector<HTMLElement>('#main h1')
  if (h1) {
    if (!h1.hasAttribute('tabindex')) h1.setAttribute('tabindex', '-1')
    // A heading is not a control: screen readers announce it, but it needs no focus ring (styles.css).
    h1.setAttribute('data-focus-target', '')
    h1.focus({ preventScroll: true })
    return
  }
  document.getElementById('main')?.focus({ preventScroll: true })
}

/**
 * Focuses a stand-in for the control the user last touched (its re-rendered twin, or a fallback such as
 * the next action) and scrolls it into view when it is not fully on screen: unlike the original trigger,
 * it may sit anywhere on the page (below the fold on a phone, or lower in a roomier look). It lands
 * mid-screen, clear of the phone's fixed top bar and of a toast at the bottom.
 */
function focusStandIn(el: HTMLElement): void {
  el.focus({ preventScroll: true })
  const r = el.getBoundingClientRect()
  const vh = window.innerHeight || document.documentElement.clientHeight
  const vw = window.innerWidth || document.documentElement.clientWidth
  if (r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw) return
  el.scrollIntoView({ block: 'center', inline: 'nearest' })
}

/**
 * Puts focus back on `prev` after an overlay closes. When React replaced or removed it (a route
 * change, or the trigger disappeared because the action finished), focus goes to its replacement,
 * then to `fallback`, then to the page title, so keyboard users never land on <body>. The original
 * trigger is focused where it is (no scroll); a replacement or fallback is scrolled into view.
 */
export function restoreFocus(prev: HTMLElement | null, fallback?: () => HTMLElement | null | undefined): void {
  const fp = prev ? fingerprint(prev) : null
  const attempt = () => {
    const active = document.activeElement
    // Something else (another sheet, the next row) already took focus on purpose.
    if (active && active !== document.body && active.isConnected && !active.closest('[data-overlay-closing]')) return true
    if (prev?.isConnected) {
      prev.focus({ preventScroll: true })
      return document.activeElement === prev
    }
    const repl = fp ? findReplacement(fp) : null
    if (repl) {
      focusStandIn(repl)
      return true
    }
    return false
  }
  if (prev?.isConnected) {
    prev.focus({ preventScroll: true })
    if (document.activeElement === prev) return
  }
  // Let the page re-render (route changes remount records) before looking for a stand-in.
  setTimeout(() => {
    if (attempt()) return
    const fb = fallback?.()
    if (fb?.isConnected) focusStandIn(fb)
    else focusPageStart()
  }, 0)
}

/** Open focus traps, oldest first. Only the newest (topmost) one pulls stray focus back, as with Escape. */
const trapStack: object[] = []

/**
 * Focus outside the topmost trapped overlay that is still fine: a menu (menus render in a portal), a
 * toast, or another modal dialog with its own focus handling (the search palette opened over a sheet).
 */
function focusMayLeave(trap: HTMLElement, node: Element): boolean {
  if (node.closest('[role="menu"], .ft-toaster')) return true
  const dialog = node.closest('[role="dialog"][aria-modal="true"]')
  return !!dialog && dialog !== trap
}

/**
 * Keeps Tab focus inside the container and restores focus when it closes. Initial focus goes to
 * [data-autofocus], else the first control in the body, so a reflexive Enter never hits Close.
 * When focus falls out of the topmost one (a control that removed itself leaves it on <body>, or a
 * script focused the page behind), the next Tab, or the stray focus itself, brings it back inside.
 */
export function useFocusTrap(
  ref: React.RefObject<HTMLElement | null>,
  active: boolean,
  opts: { returnFocus?: () => HTMLElement | null | undefined } = {},
) {
  const returnFocus = useRef(opts.returnFocus)
  returnFocus.current = opts.returnFocus
  useEffect(() => {
    if (!active || !ref.current) return
    const prev = document.activeElement as HTMLElement | null
    const el = ref.current
    // React re-runs effects on the same element in development; it is open again, not closing.
    el.removeAttribute('data-overlay-closing')
    const first =
      el.querySelector<HTMLElement>('[data-autofocus]') ??
      focusablesIn(el.querySelector('[data-overlay-body]'))[0] ??
      focusablesIn(el.querySelector('[data-overlay-footer]'))[0] ??
      focusablesIn(el)[0]
    first?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const f = focusablesIn(el)
      if (f.length === 0) return
      const a = f[0]
      const z = f[f.length - 1]
      if (e.shiftKey && document.activeElement === a) {
        e.preventDefault()
        z.focus()
      } else if (!e.shiftKey && document.activeElement === z) {
        e.preventDefault()
        a.focus()
      }
    }
    el.addEventListener('keydown', onKey)
    const token = {}
    trapStack.push(token)
    const isTop = () => trapStack[trapStack.length - 1] === token
    const strayed = (node: Element | null) => !node || node === document.body || (!el.contains(node) && !focusMayLeave(el, node))
    // Tab from <body> (or from the page behind) goes to the first control, Shift+Tab to the last.
    const onDocKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.defaultPrevented || !isTop() || !strayed(document.activeElement)) return
      const f = focusablesIn(el)
      if (f.length === 0) return
      e.preventDefault()
      ;(e.shiftKey ? f[f.length - 1] : f[0]).focus()
    }
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target instanceof Element ? e.target : null
      if (!isTop() || !target || target === document.body || !strayed(target)) return
      focusablesIn(el)[0]?.focus()
    }
    document.addEventListener('keydown', onDocKey)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      el.removeEventListener('keydown', onKey)
      document.removeEventListener('keydown', onDocKey)
      document.removeEventListener('focusin', onFocusIn)
      const i = trapStack.lastIndexOf(token)
      if (i !== -1) trapStack.splice(i, 1)
      el.setAttribute('data-overlay-closing', '')
      restoreFocus(prev && prev !== document.body ? prev : null, returnFocus.current)
    }
  }, [ref, active])
}

/** Right-side panel for record details and edit forms. Full-screen on phones. */
export function Sheet({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 560,
  headerExtra,
  returnFocus,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: number
  headerExtra?: ReactNode
  /** Where focus goes on close when the element that opened the sheet is gone. */
  returnFocus?: () => HTMLElement | null | undefined
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEscape(onClose, open)
  useFocusTrap(ref, open, { returnFocus })
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="ft-scrim anim-fade absolute inset-0 bg-[var(--scrim)]" onClick={onClose} aria-hidden />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className="ft-sheet anim-sheet relative flex h-full w-full flex-col bg-surface shadow-pop"
        style={{ maxWidth: width }}
      >
        <div className="ft-sheet__head flex items-start justify-between gap-3 border-b border-line px-5 pt-[max(1rem,env(safe-area-inset-top))] pb-3.5">
          <div className="min-w-0">
            <h2 className="ft-sheet__title text-[19px] leading-snug font-bold text-ink">{title}</h2>
            {subtitle && <div className="ft-sheet__subtitle mt-0.5 text-[13.5px] text-ink-3">{subtitle}</div>}
          </div>
          <div className="flex items-center gap-1">
            {headerExtra}
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="ft-sheet__close ft-iconbtn ft-iconbtn--ghost inline-flex h-11 w-11 items-center justify-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink"
            >
              <Icon name="x" size={20} />
            </button>
          </div>
        </div>
        <div data-overlay-body className="ft-sheet__body scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {children}
        </div>
        {footer && (
          <div
            data-overlay-footer
            className="ft-sheet__foot flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
          >
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

/** Centered dialog for short focused tasks. */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 520,
  returnFocus,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: number
  /** Where focus goes on close when the element that opened the dialog is gone. */
  returnFocus?: () => HTMLElement | null | undefined
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEscape(onClose, open)
  useFocusTrap(ref, open, { returnFocus })
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto px-4 pt-[12vh] pb-8">
      <div className="ft-scrim anim-fade fixed inset-0 bg-[var(--scrim)]" onClick={onClose} aria-hidden />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className="ft-modal anim-pop relative w-full rounded-2xl border border-line bg-surface shadow-pop"
        style={{ maxWidth: width }}
      >
        <div className="ft-modal__head flex items-start justify-between gap-3 px-5 pt-4 pb-2">
          <h2 className="ft-modal__title text-[18px] leading-snug font-bold text-ink">{title}</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="ft-modal__close ft-iconbtn ft-iconbtn--ghost -mt-1 -mr-2 inline-flex h-11 w-11 items-center justify-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink"
          >
            <Icon name="x" size={19} />
          </button>
        </div>
        <div data-overlay-body className="ft-modal__body px-5 pb-4">
          {children}
        </div>
        {footer && (
          <div data-overlay-footer className="ft-modal__foot flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

/** What moves a two-step confirm: a press on it, or the person moving on (focus leaves, Escape, a press elsewhere). */
export type TwoStepEvent = 'press' | 'leave'

/**
 * The two-step rule: the first press arms, a press while armed confirms, and moving on disarms. There is no
 * timer: an armed button waits (its label says "Press again"), so nobody has to beat a clock, and nothing
 * reverts behind their back.
 */
export function twoStepNext(armed: boolean, event: TwoStepEvent): { armed: boolean; confirm: boolean } {
  if (event === 'press') return armed ? { armed: false, confirm: true } : { armed: true, confirm: false }
  return { armed: false, confirm: false }
}

/**
 * A two-step confirm for a button (ConfirmButton, the banner actions). While armed, Escape disarms it (and
 * only that: a dialog around it stays open), and so does a press anywhere else or focus leaving it.
 */
export function useTwoStepConfirm<E extends HTMLElement>(onConfirm: () => void) {
  const [armed, setArmed] = useState(false)
  const ref = useRef<E>(null)
  useEffect(() => {
    if (!armed) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setArmed(false)
    }
    // Touch browsers do not move focus to a tapped button, so a tap elsewhere would never blur it.
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setArmed(false)
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onPointer, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onPointer, true)
    }
  }, [armed])
  const step = (event: TwoStepEvent) => {
    const next = twoStepNext(armed, event)
    setArmed(next.armed)
    if (next.confirm) onConfirm()
  }
  return { armed, ref, onClick: () => step('press'), onBlur: () => step('leave') }
}

/**
 * Two-step button for destructive or irreversible actions: the first press (click, Enter or Space) arms
 * it, the second confirms. It stays armed until it is pressed again or the person moves on (focus leaves,
 * Escape, a press elsewhere): no timer (twoStepNext).
 */
export function ConfirmButton({
  onConfirm,
  confirmLabel = 'Press again to confirm',
  children,
  variant = 'secondary',
  ...rest
}: ButtonProps & { onConfirm: () => void; confirmLabel?: string }) {
  const { armed, ref, onClick, onBlur } = useTwoStepConfirm<HTMLButtonElement>(onConfirm)
  return (
    <Button {...rest} ref={ref} variant={armed ? 'danger' : variant} aria-live="polite" onBlur={onBlur} onClick={onClick}>
      {armed ? confirmLabel : children}
    </Button>
  )
}

export type MenuItem =
  | { label: string; icon?: IconName; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string }
  | { divider: true }

/**
 * Small dropdown menu anchored to a trigger button. The popup renders in a portal with fixed
 * positioning, so scroll containers (the pipeline board) never clip it, and flips above the
 * trigger when there is no room below. Escape or picking an item returns focus to the trigger.
 */
export function Menu({
  trigger,
  items,
  align = 'right',
  label,
  open: openProp,
  onOpenChange,
}: {
  trigger: (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => ReactNode
  items: MenuItem[]
  align?: 'left' | 'right'
  label: string
  /** Controlled open state (optional). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const [openState, setOpenState] = useState(false)
  const open = openProp ?? openState
  const setOpen = (v: boolean | ((o: boolean) => boolean)) => {
    const next = typeof v === 'function' ? v(open) : v
    if (openProp === undefined) setOpenState(next)
    onOpenChange?.(next)
  }
  const menuRef = useRef<HTMLDivElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const triggerEl = () => wrap.current?.querySelector<HTMLElement>('[aria-haspopup]') ?? null
  const closeAndReturn = () => {
    setOpen(false)
    triggerEl()?.focus()
  }
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('[role=menuitem]:not([disabled])')?.focus({ preventScroll: true })
  }, [open])
  useEscape(() => setOpen(false), open)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => {
      const t = e.target as Node
      if (wrap.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const menu = menuRef.current
      const trig = triggerEl()
      if (!menu || !trig) return
      // The entry animation's transform would skew the measurements (an important declaration beats
      // the animation without restarting it); removed again below.
      menu.style.setProperty('transform', 'none', 'important')
      // Calibrate CSS px against screen px (the Display text size zooms the whole page).
      menu.style.maxHeight = ''
      menu.style.left = '0px'
      menu.style.top = '0px'
      const o = menu.getBoundingClientRect()
      menu.style.left = '100px'
      menu.style.top = '100px'
      const p = menu.getBoundingClientRect()
      const sx = (p.left - o.left) / 100 || 1
      const sy = (p.top - o.top) / 100 || 1
      const t = trig.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      const gap = 6
      const below = vh - t.bottom - gap - 8
      const above = t.top - gap - 8
      let top: number
      if (p.height <= below || below >= above) {
        top = t.bottom + gap
        if (p.height > below) menu.style.maxHeight = `${Math.max(120, below) / sy}px`
      } else {
        const h = Math.min(p.height, above)
        if (p.height > above) menu.style.maxHeight = `${above / sy}px`
        top = t.top - gap - h
      }
      let left = align === 'right' ? t.right - p.width : t.left
      left = Math.min(Math.max(8, left), Math.max(8, vw - 8 - p.width))
      menu.style.left = `${(left - o.left) / sx}px`
      menu.style.top = `${(top - o.top) / sy}px`
      menu.style.removeProperty('transform')
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, align, items.length])
  return (
    <div ref={wrap} className="relative inline-block">
      {trigger({ onClick: () => setOpen((o) => !o), 'aria-expanded': open, 'aria-haspopup': 'menu' })}
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={label}
            style={{ position: 'fixed', top: 0, left: 0 }}
            onBlur={(e) => {
              // Close when focus moves to something outside the menu and its trigger.
              const to = e.relatedTarget as Node | null
              if (to && !menuRef.current?.contains(to) && !wrap.current?.contains(to)) setOpen(false)
            }}
            onKeyDown={(e) => {
              const list = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role=menuitem]:not([disabled])'))
              const i = list.indexOf(document.activeElement as HTMLElement)
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                list[(i + 1) % list.length]?.focus()
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                list[(i - 1 + list.length) % list.length]?.focus()
              } else if (e.key === 'Home') {
                e.preventDefault()
                list[0]?.focus()
              } else if (e.key === 'End') {
                e.preventDefault()
                list[list.length - 1]?.focus()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                closeAndReturn()
              } else if (e.key === 'Tab') {
                // Close and let Tab continue from the trigger, so the tab order stays where it was.
                closeAndReturn()
              }
            }}
            className="ft-menu anim-pop scroll-thin z-[58] min-w-[220px] overflow-y-auto rounded-xl border border-line bg-surface p-1.5 shadow-pop"
          >
            {items.map((item, i) =>
              'divider' in item ? (
                <div key={`d${i}`} className="ft-menu__divider my-1 h-px bg-line" />
              ) : (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  disabled={item.disabled}
                  onClick={() => {
                    // Focus the trigger first: a sheet or dialog opened by the item then returns here on close.
                    closeAndReturn()
                    item.onSelect()
                  }}
                  className={cx(
                    'ft-menuitem',
                    item.danger && 'ft-menuitem--danger',
                    'flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[14px] font-medium disabled:opacity-50',
                    item.danger ? 'text-bad hover:bg-bad-soft' : 'text-ink hover:bg-surface-2',
                  )}
                >
                  {item.icon && <Icon name={item.icon} size={17} className={cx('shrink-0', item.danger ? '' : 'text-ink-3')} />}
                  <span className="flex-1">{item.label}</span>
                  {item.hint && <span className="text-[12px] text-ink-3">{item.hint}</span>}
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}
