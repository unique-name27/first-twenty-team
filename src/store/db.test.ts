// The sample company's moving dates: only loadSample moves them, so the banner's promise holds only
// while a loaded copy still matches this week (r2-39). migrate's upgrade of role template names saved
// before posting qualifiers moved to the hint. And holdPersisting, which keeps a simulated company out of
// this browser's saved copy.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RENAMED_ROLE_TEMPLATES } from '@/data/roleTemplates'
import type { DB } from '@/domain/types'
import { addDays, setClockOverride } from '@/lib/dates'
import { loadSample, migrate, sampleIsCurrent } from './db'

afterEach(() => setClockOverride(null))

describe('sampleIsCurrent', () => {
  it('is true for a sample loaded this week, also on its anchor day (no shift)', () => {
    const anchor = loadSample().meta.sampleAnchor as string
    setClockOverride(anchor)
    expect(sampleIsCurrent(loadSample())).toBe(true)
    setClockOverride(addDays(anchor, 30))
    const later = loadSample()
    expect(later.meta.sampleShiftDays).toBe(28)
    expect(sampleIsCurrent(later)).toBe(true)
    // Two days on is still the same whole-week shift.
    setClockOverride(addDays(anchor, 31))
    expect(sampleIsCurrent(later)).toBe(true)
  })

  it('is false once a saved copy is opened in a later week', () => {
    const anchor = loadSample().meta.sampleAnchor as string
    setClockOverride(anchor)
    const saved = loadSample()
    setClockOverride(addDays(anchor, 14))
    expect(sampleIsCurrent(saved)).toBe(false)
  })

  it('is false for a workspace that is not the sample', () => {
    const db = loadSample()
    expect(sampleIsCurrent({ meta: { ...db.meta, sample: false } })).toBe(false)
    expect(sampleIsCurrent({ meta: { ...db.meta, sampleAnchor: undefined } })).toBe(false)
  })
})

describe('migrate: role template names from before qualifiers moved to the hint', () => {
  /** The sample as a version from before the rename saved it: the qualifier in the name, no hint. */
  function savedBeforeRename(): DB {
    const db = loadSample()
    const roleTemplates = db.settings.roleTemplates.map((t) => {
      const old = RENAMED_ROLE_TEMPLATES.find((r) => r.name === t.name)
      if (!old) return t
      const { hint: _hint, ...rest } = t
      return { ...rest, name: old.from }
    })
    return { ...db, settings: { ...db.settings, roleTemplates } }
  }
  const names = (db: DB) => db.settings.roleTemplates.map((t) => [t.name, t.hint ?? null])

  it('renames the templates that still have an old default name, with the qualifier as the hint', () => {
    const saved = savedBeforeRename()
    expect(names(saved)).toContainEqual(['Accounting lead (CPA)', null])
    expect(names(saved)).toContainEqual(['Customer success manager (CPA preferred)', null])
    const frozen = JSON.stringify(saved)
    const upgraded = migrate(saved)
    // Exactly the templates the sample has now, and nothing else changed.
    expect(upgraded.settings.roleTemplates).toEqual(loadSample().settings.roleTemplates)
    expect(upgraded.settings.roleTemplates.find((t) => t.id === 'rt-accounting-lead')).toMatchObject({ name: 'Accounting lead', hint: 'CPA' })
    expect(upgraded.settings.roleTemplates.find((t) => t.id === 'rt-csm')).toMatchObject({ name: 'Customer success manager', hint: 'CPA preferred' })
    expect({ ...upgraded, settings: { ...upgraded.settings, roleTemplates: [] } }).toEqual({ ...saved, settings: { ...saved.settings, roleTemplates: [] } })
    // The saved copy itself is left as it was.
    expect(JSON.stringify(saved)).toBe(frozen)
  })

  it('never touches a name the user changed, or any other template', () => {
    const saved = savedBeforeRename()
    const edited = ['Accounting lead (CPA), part time', 'accounting lead (cpa)', 'Accounting lead (CPA) ', 'Accounting lead']
    const roleTemplates = saved.settings.roleTemplates.map((t) => (t.id === 'rt-accounting-lead' ? { ...t, name: edited[0] } : t))
    roleTemplates.push(...edited.slice(1).map((name, i) => ({ ...roleTemplates[0], id: `rt-mine-${i}`, name })))
    const upgraded = migrate({ ...saved, settings: { ...saved.settings, roleTemplates } })
    expect(upgraded.settings.roleTemplates.find((t) => t.id === 'rt-accounting-lead')).toMatchObject({ name: 'Accounting lead (CPA), part time' })
    expect(upgraded.settings.roleTemplates.find((t) => t.id === 'rt-accounting-lead')?.hint).toBeUndefined()
    expect(upgraded.settings.roleTemplates.filter((t) => t.id.startsWith('rt-mine-')).map((t) => [t.name, t.hint ?? null])).toEqual(edited.slice(1).map((n) => [n, null]))
    // The other old name, unchanged by the user, is still upgraded.
    expect(upgraded.settings.roleTemplates.find((t) => t.id === 'rt-csm')).toMatchObject({ name: 'Customer success manager', hint: 'CPA preferred' })
    const others = (db: DB) => db.settings.roleTemplates.filter((t) => !['rt-csm', 'rt-accounting-lead'].includes(t.id) && !t.id.startsWith('rt-mine-'))
    expect(others(upgraded)).toEqual(others(saved))
  })

  it('happens once: running it again changes nothing, and a template renamed back to the old name by hand keeps it', () => {
    const once = migrate(savedBeforeRename())
    const twice = migrate(once)
    expect(twice).toEqual(once)
    // Nothing to rename: the same settings object comes back, so nothing looks edited.
    expect(twice.settings).toBe(once.settings)
    const current = loadSample()
    expect(migrate(current).settings).toBe(current.settings)
    // After the upgrade, the user names it as it was: it has its hint now, so it stays as they named it.
    const renamedBack = { ...once, settings: { ...once.settings, roleTemplates: once.settings.roleTemplates.map((t) => (t.id === 'rt-accounting-lead' ? { ...t, name: 'Accounting lead (CPA)' } : t)) } }
    expect(migrate(renamedBack).settings.roleTemplates.find((t) => t.id === 'rt-accounting-lead')).toMatchObject({ name: 'Accounting lead (CPA)', hint: 'CPA' })
  })

  it('loads a save without role templates as it is', () => {
    const db = loadSample()
    const bare = { ...db, settings: { ...db.settings, roleTemplates: undefined } } as unknown as DB
    expect(migrate(bare).settings).toBe(bare.settings)
  })
})

describe('holdPersisting (the simulator shows a simulated company that is never saved)', () => {
  /** db.ts as a browser loads it: a window, a localStorage and timers this test moves. */
  async function browserStore() {
    vi.resetModules()
    vi.useFakeTimers()
    const saved = new Map<string, string>()
    const listeners: Array<() => void> = []
    vi.stubGlobal('localStorage', { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) })
    vi.stubGlobal('window', { addEventListener: (type: string, fn: () => void) => type === 'beforeunload' && listeners.push(fn) })
    const mod = await import('./db')
    const stored = () => {
      const raw = saved.get(mod.STORAGE_KEY)
      return raw ? (JSON.parse(raw) as DB).company.name : null
    }
    const rename = (name: string) =>
      mod.useDB.getState().mutate(`Rename to ${name}`, (d) => {
        d.company.name = name
      })
    return { ...mod, stored, rename, unload: () => listeners.forEach((fn) => fn()) }
  }

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('writes a waiting save first, then saves nothing while held, on the way out included', async () => {
    const s = await browserStore()
    s.rename('Before the hold')
    const release = s.holdPersisting()
    // The save that was waiting went out at once: the saved copy is the workspace from before the hold.
    expect(s.stored()).toBe('Before the hold')
    expect(s.persistingHeld()).toBe(true)
    s.useDB.setState({ db: { ...s.useDB.getState().db, company: { ...s.useDB.getState().db.company, name: 'Simulated' } } })
    s.rename('Edited while held')
    vi.advanceTimersByTime(5000)
    s.unload()
    expect(s.stored()).toBe('Before the hold')
    release()
    expect(s.persistingHeld()).toBe(false)
    // Releasing saves nothing by itself; the next change saves as usual.
    vi.advanceTimersByTime(5000)
    expect(s.stored()).toBe('Before the hold')
    s.rename('After the hold')
    vi.advanceTimersByTime(400)
    expect(s.stored()).toBe('After the hold')
  })

  it('counts holds, and a release called twice lets go of its own hold only', async () => {
    const s = await browserStore()
    const a = s.holdPersisting()
    const b = s.holdPersisting()
    a()
    a()
    expect(s.persistingHeld()).toBe(true)
    b()
    expect(s.persistingHeld()).toBe(false)
  })
})
