// Undo after the toast has gone: the Activity list offers Undo on the rows the newest change wrote,
// and pages whose record was removed by an undo say so instead of "no one with that link".
import { useMemo } from 'react'
import type { DB, ID } from '@/domain/types'
import { type HistoryEntry, useDB } from '@/store/db'
import { toast } from '@/ui'

type Undone = { label: string; replaced: DB }

let lastUndo: Undone | null = null

// An undo shortens the history; remember the state it replaced so pages can explain a missing record.
if (typeof window !== 'undefined') {
  useDB.subscribe((s, prev) => {
    if (s.past.length >= prev.past.length || s.db === prev.db) return
    lastUndo = { label: prev.past[prev.past.length - 1]?.label ?? 'the last change', replaced: prev.db }
  })
}

/** The most recent undo in this session (label and the workspace as it was before the undo). */
export function lastUndone(): Undone | null {
  return lastUndo
}

/** When `exists` held in the state an undo replaced, the label of that undo (the record was undone). */
export function undoneLabelFor(exists: (db: DB) => boolean): string | null {
  return lastUndo && exists(lastUndo.replaced) ? lastUndo.label : null
}

export type LatestChange = { entryId: number; label: string; activityIds: Set<ID> }

/**
 * The newest undoable change in `past` and the activity rows it wrote on the way to `db`: the rows `db`
 * has that the change's snapshot does not. Compared by id, never by position: the sync engine appends
 * rows pulled from other devices to the store and to every snapshot, so the rows after the snapshot's
 * length can be another device's.
 */
export function latestChangeOf(past: readonly HistoryEntry[], db: DB): LatestChange | null {
  const top = past[past.length - 1]
  if (!top) return null
  const before = new Set(top.db.activity.map((a) => a.id))
  const ids = new Set(db.activity.filter((a) => !before.has(a.id)).map((a) => a.id))
  return { entryId: top.id, label: top.label, activityIds: ids }
}

/** The newest undoable change and the activity rows it wrote. Null when there is nothing left to undo. */
export function useLatestChange(): LatestChange | null {
  const past = useDB((s) => s.past)
  const db = useDB((s) => s.db)
  return useMemo(() => latestChangeOf(past, db), [past, db])
}

/** Undoes one change if it is still the newest, and says what happened either way. */
export function undoChange(entryId: number, label: string): boolean {
  const r = useDB.getState().undoEntry(entryId)
  if (r === 'undone') toast({ text: `Undid: ${label}`, tone: 'neutral' })
  else if (r === 'newer') toast({ text: 'A newer change came after this one. Undo that one first.', tone: 'neutral' })
  else toast({ text: 'That change can no longer be undone. Change it back by hand.', tone: 'neutral' })
  return r === 'undone'
}
