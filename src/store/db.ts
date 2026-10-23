// The one store. All writes go through mutate(label, recipe) so every change is undoable,
// persisted (debounced) to localStorage, and can log activity in the same step.
// Draft helpers (logActivity, upsert, ...) live in ./draft so domain code never imports the store.
import { type Draft, produce } from 'immer'
import { create } from 'zustand'
import { blankDB } from '@/data/blank'
import { upgradeRoleTemplateNames } from '@/data/roleTemplates'
import { buildSampleDB } from '@/data/seed'
import { samplePayRuns } from '@/data/seed/payroll'
import { applyDueHandoffs } from '@/domain/handoff'
import { expireOffers } from '@/domain/hiring/offers'
import { applyScheduledChanges } from '@/domain/lifecycle'
import type { DB } from '@/domain/types'
import { daysBetween, shiftDatesDeep, today } from '@/lib/dates'

export { currentActorId, findById, logActivity, removeById, upsert } from './draft'

export const STORAGE_KEY = 'first-twenty:db:v1'
const UNDO_LIMIT = 30

/** One undo step: the snapshot before a change, the change's label, a unique id and when it happened. */
export type HistoryEntry = { db: DB; label: string; id: number; at: number }

type DBState = {
  db: DB
  /** Undo stack of previous snapshots with the label of the change that replaced them. */
  past: HistoryEntry[]
  /** False when the browser refused storage (private window, quota, blocked site data). */
  storageOk: boolean
  lastSavedAt: string | null
  mutate: (label: string, recipe: (draft: Draft<DB>) => void) => void
  /** Undoes the newest change. Returns its label, or null when there is nothing to undo. */
  undo: () => string | null
  /**
   * Undoes the change with this history id only when it is still the newest one. Returns 'undone',
   * 'newer' (a later change came after it) or 'gone' (already undone or dropped from history).
   */
  undoEntry: (id: number) => 'undone' | 'newer' | 'gone'
  replace: (db: DB, label?: string) => void
}

let historySeq = 0
function entry(db: DB, label: string): HistoryEntry {
  historySeq += 1
  return { db, label, id: historySeq, at: Date.now() }
}

/**
 * How many days the sample's dates move so "today" in the story is `day`: whole weeks, so weekdays stay
 * aligned (interviews stay on weekdays, starts on Mondays).
 */
function sampleShiftOn(anchor: string, day: string): number {
  return Math.round(daysBetween(anchor, day) / 7) * 7
}

/** Loads the sample company with its dates shifted so "today" in the story is today. */
export function loadSample(): DB {
  const db = buildSampleDB()
  const anchor = db.meta.sampleAnchor
  if (!anchor) return db
  const shift = sampleShiftOn(anchor, today())
  if (shift === 0) return db
  // Law, holiday and settings dates stay put; only the company's story moves. Pay periods follow the calendar
  // (the 15th and the last day), so the submitted payrolls are rebuilt for today rather than shifted.
  const shifted = shiftDatesDeep(db, shift, new Set(['settings', 'lastReviewedOn', 'holidays', 'timeOffPolicies', 'checklistTemplates', 'payRuns']))
  shifted.company = { ...shifted.company, payRuns: samplePayRuns(shifted, today()) }
  shifted.meta = { ...shifted.meta, sampleAnchor: anchor, sampleShiftDays: shift }
  return shifted
}

/**
 * True while the sample's dates match this week (what loadSample would give today). A sample that was
 * saved (any edit) or uploaded loads with the dates it had then, so after a week it no longer does.
 */
export function sampleIsCurrent(db: Pick<DB, 'meta'>): boolean {
  const { sample, sampleAnchor, sampleShiftDays } = db.meta
  return !!sample && !!sampleAnchor && (sampleShiftDays ?? 0) === sampleShiftOn(sampleAnchor, today())
}

/**
 * Fills collections added after a workspace was saved, so older saves keep loading, then upgrades what an
 * older version saved differently (upgradeSaved). Runs on every saved or server copy before it enters the
 * store, and on an imported backup.
 */
export function migrate(db: DB): DB {
  const base = blankDB({ companyName: 'Company', founderFirstName: 'A', founderLastName: 'B' })
  const out = { ...db } as Record<string, unknown>
  for (const [k, v] of Object.entries(base)) {
    if (out[k] === undefined) out[k] = Array.isArray(v) ? [] : v
  }
  return upgradeSaved(out as DB)
}

/**
 * Data upgrades for workspaces an older version saved. Each one is idempotent and the same on every
 * device, so a copy can go through it any number of times, and the server's copy, upgraded the same way as
 * it arrives (the sync engine's prepareSnapshot), never differs from this browser's because of it. Nothing
 * is queued for it: the upgraded record reaches the server with its next edit (for role templates, the
 * next change to settings, which syncs as one document).
 * - Role templates still named as the defaults were before posting qualifiers moved to `hint`
 *   ('Accounting lead (CPA)'): renamed, never a name the user changed (upgradeRoleTemplateNames).
 */
function upgradeSaved(db: DB): DB {
  const templates = db.settings?.roleTemplates
  if (!Array.isArray(templates)) return db
  const renamed = upgradeRoleTemplateNames(templates)
  return renamed === templates ? db : { ...db, settings: { ...db.settings, roleTemplates: renamed } }
}

function readStored(): { db: DB | null; ok: boolean } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { db: null, ok: true }
    const parsed = JSON.parse(raw) as DB
    if (parsed?.schemaVersion !== 1 || !parsed.company) return { db: null, ok: true }
    return { db: migrate(parsed), ok: true }
  } catch {
    return { db: null, ok: false }
  }
}

/**
 * The changes the app makes on its own when a workspace loads: effective-dated job and pay changes and
 * leavers' hand-offs whose date has arrived, then sent offers past their expiry date. Run on every load
 * and every replace here, and by the sync engine on a server copy (src/sync/index.ts uses this same
 * function), so every device makes the same changes in the same order.
 */
export function applyLoadChanges(db: DB): DB {
  return produce(db, (d) => {
    applyScheduledChanges(d, today())
    applyDueHandoffs(d, today())
    expireOffers(d, today())
  })
}

function initialState(): { db: DB; ok: boolean } {
  const stored = typeof window === 'undefined' ? { db: null, ok: true } : readStored()
  return { db: applyLoadChanges(stored.db ?? loadSample()), ok: stored.ok }
}

const initial = initialState()

export const useDB = create<DBState>((set, get) => ({
  db: initial.db,
  past: [],
  storageOk: initial.ok,
  lastSavedAt: null,
  mutate: (label, recipe) => {
    const prev = get().db
    const next = produce(prev, recipe)
    if (next === prev) return
    set((s) => ({ db: next, past: [...s.past.slice(-(UNDO_LIMIT - 1)), entry(prev, label)] }))
  },
  undo: () => {
    const { past } = get()
    const last = past[past.length - 1]
    if (!last) return null
    set({ db: last.db, past: past.slice(0, -1) })
    return last.label
  },
  undoEntry: (id) => {
    const { past } = get()
    const idx = past.findIndex((p) => p.id === id)
    if (idx === -1) return 'gone'
    if (idx !== past.length - 1) return 'newer'
    set({ db: past[idx].db, past: past.slice(0, -1) })
    return 'undone'
  },
  replace: (db, label = 'Replace workspace') => {
    const prev = get().db
    set((s) => ({ db: applyLoadChanges(db), past: [...s.past.slice(-(UNDO_LIMIT - 1)), entry(prev, label)] }))
  },
}))

// Debounced persistence. Writes are a few hundred KB and happen at most every 400 ms.
let saveTimer: ReturnType<typeof setTimeout> | null = null
let persistStopped = false

/**
 * Stops saving the store for the rest of this page's life. Called when this browser's data is removed
 * (Sign out and remove data, here or in another tab) right before the page reloads, so neither the
 * debounced save nor the flush on the way out writes a workspace back.
 */
export function stopPersisting(): void {
  persistStopped = true
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
}

if (typeof window !== 'undefined') {
  useDB.subscribe((state, prevState) => {
    if (persistStopped || state.db === prevState.db) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(useDB.getState().db))
        useDB.setState({ storageOk: true, lastSavedAt: new Date().toISOString() })
      } catch {
        useDB.setState({ storageOk: false })
      }
    }, 400)
  })
  // Flush on tab close so the last edit is not lost.
  window.addEventListener('beforeunload', () => {
    if (persistStopped || !saveTimer) return
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(useDB.getState().db))
    } catch {
      /* storage unavailable */
    }
  })
}

/** Read the current db outside React (event handlers, domain helpers). */
export function getDB(): DB {
  return useDB.getState().db
}
