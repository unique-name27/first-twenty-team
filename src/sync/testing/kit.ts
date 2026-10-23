// Helpers for sync tests: an in-memory Storage, a page environment you can drive, a store that behaves
// like useDB (mutate with Undo history, replace), and a status store per test. Test-only.
import { type Draft, produce } from 'immer'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { blankDB } from '@/data/blank'
import type { DB, Person } from '@/domain/types'
import type { HistoryEntry } from '@/store/db'
import type { SyncEnv, SyncEnvEvent } from '../engine'
import type { StorageLike } from '../state'
import { INITIAL_SYNC_STATUS, type SyncStatusState } from '../status'

export function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
  }
}

export type TestEnv = { env: SyncEnv; emit: (event: SyncEnvEvent) => void; setVisible: (visible: boolean) => void; listenerCount: () => number }

export function testEnv(): TestEnv {
  const listeners = new Map<SyncEnvEvent, Set<() => void>>()
  let visible = true
  const emit = (event: SyncEnvEvent) => {
    for (const fn of [...(listeners.get(event) ?? [])]) fn()
  }
  return {
    env: {
      isVisible: () => visible,
      on: (event, fn) => {
        let set = listeners.get(event)
        if (!set) listeners.set(event, (set = new Set()))
        set.add(fn)
        return () => set.delete(fn)
      },
    },
    emit,
    setVisible: (v) => {
      visible = v
      emit('visibilitychange')
    },
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  }
}

export type TestDBState = {
  db: DB
  past: HistoryEntry[]
  mutate: (label: string, recipe: (draft: Draft<DB>) => void) => void
  undo: () => string | null
  replace: (db: DB, label?: string) => void
}

/** Same Undo semantics as useDB (src/store/db.ts), without persistence or scheduled changes. */
export function createTestStore(db: DB): StoreApi<TestDBState> {
  let seq = 0
  const entry = (snapshot: DB, label: string): HistoryEntry => ({ db: snapshot, label, id: ++seq, at: 0 })
  return createStore<TestDBState>()((set, get) => ({
    db,
    past: [],
    mutate: (label, recipe) => {
      const prev = get().db
      const next = produce(prev, recipe)
      if (next === prev) return
      set((s) => ({ db: next, past: [...s.past.slice(-29), entry(prev, label)] }))
    },
    undo: () => {
      const { past } = get()
      const last = past[past.length - 1]
      if (!last) return null
      set({ db: last.db, past: past.slice(0, -1) })
      return last.label
    },
    replace: (next, label = 'Replace workspace') => {
      const prev = get().db
      set((s) => ({ db: next, past: [...s.past.slice(-29), entry(prev, label)] }))
    },
  }))
}

export function createStatusStore(): StoreApi<SyncStatusState> {
  return createStore<SyncStatusState>()(() => ({ ...INITIAL_SYNC_STATUS }))
}

/** A small real workspace (blankDB) with a fixed founder; sample = true makes it look like the sample company. */
export function makeDB(opts: { sample?: boolean; company?: string } = {}): DB {
  const db = blankDB({ companyName: opts.company ?? 'Acme', founderFirstName: 'Ada', founderLastName: 'Lovelace', foundedOn: '2026-01-05' })
  db.meta = { createdOn: '2026-01-05', sample: opts.sample === true }
  return db
}

export function makePerson(id: string, over: Partial<Person> = {}): Person {
  return {
    id,
    firstName: `First ${id}`,
    lastName: `Last ${id}`,
    workEmail: `${id}@example.test`,
    title: 'Engineer',
    departmentId: 'd-eng',
    familyId: 'f-swe',
    levelId: 'lv-l3',
    managerId: 'p-founder',
    locationId: 'loc-hq',
    workMode: 'hybrid',
    homeState: 'CA',
    employmentType: 'full_time',
    hoursPerWeek: 40,
    flsa: 'exempt',
    startDate: '2026-02-02',
    hireNumber: 2,
    emergencyContacts: [],
    ...over,
  }
}

/** A tiny deterministic PRNG for the convergence test. */
export function prng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
