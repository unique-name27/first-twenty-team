// Per-device preferences, kept apart from the workspace so exporting data never carries them.
// "Viewing as" is a preview, not security: anyone with this browser can switch it.
import { create } from 'zustand'
import type { ID, Role } from '@/domain/types'
import { setClockOverride } from '@/lib/dates'
import { DEFAULT_LOOK, type LookId, savedLook } from '@/themes/ids'

const KEY = 'first-twenty:prefs:v1'

export type Theme = 'system' | 'light' | 'dark'
export type TextScale = 1 | 1.15 | 1.3 | 1.5

type Prefs = {
  viewAs: { role: Role; personId: ID | null }
  /** Visual skin (docs/LOOKS.md). Light/dark (theme) only applies to looks that support it. */
  look: LookId
  theme: Theme
  /** Text size, 100% to 150%. */
  textScale: TextScale
  /** App-level reduced motion (on top of the OS setting). */
  reducedMotion: boolean
  /** Single-key shortcuts (/, N, B, ?, A, R, S, J). Can be turned off. */
  shortcutsOn: boolean
  /** Blurs money amounts for screen sharing (key B). */
  privacyBlur: boolean
  /** Demo clock ("Pretend today is"). null = real date. */
  clockOverride: string | null
  /** Inbox filter on Home. */
  inboxFilter: 'all' | 'you' | 'them'
}

type PrefsState = Prefs & {
  setViewAs: (role: Role, personId: ID | null) => void
  setLook: (l: LookId) => void
  setTheme: (t: Theme) => void
  setTextScale: (s: TextScale) => void
  setReducedMotion: (v: boolean) => void
  setShortcutsOn: (v: boolean) => void
  setPrivacyBlur: (v: boolean) => void
  togglePrivacyBlur: () => void
  setClock: (d: string | null) => void
  setInboxFilter: (f: Prefs['inboxFilter']) => void
}

const DEFAULTS: Prefs = {
  viewAs: { role: 'admin', personId: null },
  look: DEFAULT_LOOK,
  theme: 'system',
  textScale: 1,
  reducedMotion: false,
  shortcutsOn: true,
  privacyBlur: false,
  clockOverride: null,
  inboxFilter: 'all',
}

function load(): Prefs {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY)
    if (!raw) return DEFAULTS
    const p = JSON.parse(raw) as Partial<Prefs>
    const scale = [1, 1.15, 1.3, 1.5].includes(Number(p.textScale)) ? (p.textScale as TextScale) : 1
    // A renamed look (the green-bar 'ledger' is now 'trading') loads as its new id.
    const look = savedLook(p.look)
    return { ...DEFAULTS, ...p, textScale: scale, look }
  } catch {
    return DEFAULTS
  }
}

function pick(s: PrefsState): Prefs {
  return {
    viewAs: s.viewAs,
    look: s.look,
    theme: s.theme,
    textScale: s.textScale,
    reducedMotion: s.reducedMotion,
    shortcutsOn: s.shortcutsOn,
    privacyBlur: s.privacyBlur,
    clockOverride: s.clockOverride,
    inboxFilter: s.inboxFilter,
  }
}

const initial = load()
setClockOverride(initial.clockOverride)

export const usePrefs = create<PrefsState>((set, get) => {
  const update = (patch: Partial<Prefs>) => {
    set(patch)
    try {
      localStorage.setItem(KEY, JSON.stringify(pick(get())))
    } catch {
      /* storage unavailable; prefs live for this session only */
    }
  }
  return {
    ...initial,
    setViewAs: (role, personId) => update({ viewAs: { role, personId } }),
    setLook: (look) => update({ look }),
    setTheme: (theme) => update({ theme }),
    setTextScale: (textScale) => update({ textScale }),
    setReducedMotion: (reducedMotion) => update({ reducedMotion }),
    setShortcutsOn: (shortcutsOn) => update({ shortcutsOn }),
    setPrivacyBlur: (privacyBlur) => update({ privacyBlur }),
    togglePrivacyBlur: () => update({ privacyBlur: !get().privacyBlur }),
    setClock: (clockOverride) => {
      setClockOverride(clockOverride)
      update({ clockOverride })
    },
    setInboxFilter: (inboxFilter) => update({ inboxFilter }),
  }
})
