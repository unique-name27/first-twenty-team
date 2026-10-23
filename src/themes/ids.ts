// Look ids (no React here, so prefs and tests can import it cheaply). See docs/LOOKS.md.

export type LookId = 'sleek' | 'web90s' | 'comic' | 'trading'

/** Display order in the Display menu and the command palette. */
export const LOOK_IDS: readonly LookId[] = ['sleek', 'web90s', 'comic', 'trading']

export const DEFAULT_LOOK: LookId = 'sleek'

/**
 * Looks that were renamed or replaced, by their old saved id. 'ledger' (green-bar printout) became the
 * trading desk look on 2026-10-10. index.html's pre-paint script keeps the same map.
 */
export const RENAMED_LOOKS: Readonly<Record<string, LookId>> = { ledger: 'trading' }

export function isLookId(v: unknown): v is LookId {
  return typeof v === 'string' && (LOOK_IDS as readonly string[]).includes(v)
}

/** The look a saved preference asks for: renamed ids move to their new id, anything unknown gets the default. */
export function savedLook(v: unknown): LookId {
  const id = typeof v === 'string' && Object.hasOwn(RENAMED_LOOKS, v) ? RENAMED_LOOKS[v] : v
  return isLookId(id) ? id : DEFAULT_LOOK
}
