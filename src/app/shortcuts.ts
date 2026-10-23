// Keyboard shortcuts. Every feature registers through useShortcut so the "?" sheet lists them
// and the Display menu can turn single-key shortcuts off (they can clash with dictation and
// switch-access tools). Chords like Ctrl+K always work.
import { useEffect, useId, useRef } from 'react'
import { create } from 'zustand'
import { usePrefs } from '@/store/prefs'

export type ShortcutInfo = { id: string; keys: string; description: string; group: string }

const useRegistry = create<{ items: Record<string, ShortcutInfo> }>(() => ({ items: {} }))

export function useShortcutList(): ShortcutInfo[] {
  const items = useRegistry((s) => s.items)
  return Object.values(items)
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type
    return !['checkbox', 'radio', 'button', 'submit', 'range', 'color'].includes(type)
  }
  return false
}

function matches(e: KeyboardEvent, keys: string): boolean {
  const parts = keys.toLowerCase().split('+')
  const key = parts[parts.length - 1]
  const wantMod = parts.includes('mod')
  const wantShift = parts.includes('shift')
  const mod = e.ctrlKey || e.metaKey
  if (wantMod !== mod) return false
  if (!wantMod && e.altKey) return false
  if (wantShift && !e.shiftKey) return false
  // Chords match Shift exactly, so Ctrl+Shift+Z (redo) is not Ctrl+Z.
  if (wantMod && !wantShift && e.shiftKey) return false
  const k = e.key.toLowerCase()
  if (key === '?') return e.key === '?'
  if (key === 'esc') return k === 'escape'
  if (key === 'enter') return k === 'enter'
  return k === key
}

/**
 * Registers a shortcut while the component is mounted.
 * keys: 'a', 'shift+n', 'mod+k', '?', '/'. Single keys respect the user's shortcuts setting.
 * `enabled: false` turns the key off and takes it off the ? sheet. With `listed: true` it stays on the
 * sheet while the component is mounted, even when off: a key that works only while focus is in one place
 * (the pipeline board) is still listed after the ? sheet takes focus.
 */
export function useShortcut(
  keys: string,
  handler: (e: KeyboardEvent) => void,
  opts: {
    description: string
    group: string
    enabled?: boolean
    allowInInputs?: boolean
    /** For chords: leave the key to the text field while typing (Ctrl+Z undoes typing there). */
    ignoreInInputs?: boolean
    /** Keep it on the ? sheet while mounted, even while `enabled` is false. */
    listed?: boolean
  },
): void {
  const id = useId()
  const ref = useRef(handler)
  ref.current = handler
  const enabled = opts.enabled ?? true
  const onSheet = enabled || !!opts.listed

  useEffect(() => {
    if (!onSheet) return
    useRegistry.setState((s) => ({ items: { ...s.items, [id]: { id, keys, description: opts.description, group: opts.group } } }))
    return () =>
      useRegistry.setState((s) => {
        const next = { ...s.items }
        delete next[id]
        return { items: next }
      })
  }, [id, keys, opts.description, opts.group, onSheet])

  useEffect(() => {
    if (!enabled) return
    const isChord = keys.includes('mod+')
    const h = (e: KeyboardEvent) => {
      if (!isChord && !usePrefs.getState().shortcutsOn) return
      if (!opts.allowInInputs && !isChord && isTyping(e.target)) return
      if (opts.ignoreInInputs && isTyping(e.target)) return
      if (document.querySelector('[role="dialog"][aria-modal="true"]') && !isChord && keys !== 'esc') {
        // Inside a dialog only dialog-owned shortcuts should fire; those set allowInInputs.
        if (!opts.allowInInputs) return
      }
      if (!matches(e, keys)) return
      e.preventDefault()
      ref.current(e)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [keys, enabled, opts.allowInInputs, opts.ignoreInInputs])
}

/** Human label for a key combo: 'mod+k' -> 'Ctrl K' (or Cmd on Mac), 'arrowleft' -> '←', 'enter' -> 'Enter'. */
export function keyLabel(keys: string): string[] {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  const named: Record<string, string> = { shift: 'Shift', esc: 'Esc', enter: 'Enter', arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓' }
  return keys.split('+').map((k) => {
    if (k === 'mod') return mac ? 'Cmd' : 'Ctrl'
    const name = named[k]
    if (name) return name
    return k.length === 1 ? k.toUpperCase() : k
  })
}
