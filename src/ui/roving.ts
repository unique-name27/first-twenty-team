// Arrow-key movement for groups of buttons that carry radio or tab roles (ARIA radio group and
// tabs patterns): only one item is a Tab stop, and arrows, Home and End move between items.
import type { KeyboardEvent } from 'react'

const MOVE_KEYS = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End']

/**
 * Handles arrow, Home and End keys on a role=radiogroup or role=tablist container. With `select`,
 * the newly focused item is also chosen (pure pickers like filters); without it, focus moves and
 * Space or Enter chooses, which is safer for chips that act right away.
 */
export function rovingKeyDown(e: KeyboardEvent<HTMLElement>, opts: { select?: boolean } = {}): void {
  if (!MOVE_KEYS.includes(e.key) || e.altKey || e.ctrlKey || e.metaKey) return
  const group = e.currentTarget
  const items = Array.from(group.querySelectorAll<HTMLElement>('[role=radio],[role=tab]')).filter(
    (n) => !(n as HTMLButtonElement).disabled && n.closest('[role=radiogroup],[role=tablist]') === group,
  )
  if (items.length === 0) return
  const i = items.indexOf(document.activeElement as HTMLElement)
  let next: number
  if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = items.length - 1
  else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = i < 0 ? 0 : (i + 1) % items.length
  else next = i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length
  e.preventDefault()
  const el = items[next]
  el.focus()
  if (opts.select && el.getAttribute('aria-checked') !== 'true' && el.getAttribute('aria-selected') !== 'true') el.click()
}

/**
 * Tab index for item `i` in a roving group: the chosen item is the one Tab stop, or the first
 * enabled item when nothing is chosen yet.
 */
export function rovingTabIndex(i: number, items: ReadonlyArray<{ on: boolean; disabled?: boolean }>): 0 | -1 {
  const chosen = items.findIndex((x) => x.on && !x.disabled)
  const stop = chosen >= 0 ? chosen : items.findIndex((x) => !x.disabled)
  return i === stop ? 0 : -1
}
