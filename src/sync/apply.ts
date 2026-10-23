// Applies server changes (pulled changes, conflict copies, a resync) to a DB without Immer: unchanged
// records and collections keep their identity, and an apply that changes nothing returns the same DB, so
// the store does not churn and the diff stays cheap. Pure.
import type { DB } from '@/domain/types'
import { DOC_COLLECTION, isDocKey, isRecordCollection } from './collections'
import { deepEqual } from './diff'
import type { ChangeOp } from './protocol'

export type RemoteChange = { collection: string; id: string; op: ChangeOp; data?: unknown }

/** True when the change names a known collection and, for upserts, carries a usable record. */
export function isApplicable(c: RemoteChange): boolean {
  if (c.collection === DOC_COLLECTION) return isDocKey(c.id) && (c.op === 'delete' || c.data !== undefined)
  if (!isRecordCollection(c.collection)) return false
  if (c.op === 'delete') return true
  const d = c.data as { id?: unknown } | null | undefined
  return !!d && typeof d === 'object' && !Array.isArray(d) && d.id === c.id
}

/** Applies changes in order (a later change to the same record wins). Returns `db` itself when nothing changed. */
export function applyChanges(db: DB, changes: readonly RemoteChange[]): DB {
  if (changes.length === 0) return db
  const groups = new Map<string, Map<string, RemoteChange>>()
  for (const c of changes) {
    if (!isApplicable(c)) continue
    let byId = groups.get(c.collection)
    if (!byId) groups.set(c.collection, (byId = new Map()))
    byId.delete(c.id) // keep insertion order = order of the last change
    byId.set(c.id, c)
  }
  const src = db as unknown as Record<string, unknown>
  let out: Record<string, unknown> | null = null
  for (const [collection, byId] of groups) {
    if (collection === DOC_COLLECTION) {
      for (const [key, c] of byId) {
        // Documents are never deleted (every workspace has them).
        if (c.op === 'delete' || deepEqual(src[key], c.data)) continue
        out ??= { ...src }
        out[key] = c.data
      }
      continue
    }
    const current = Array.isArray(src[collection]) ? (src[collection] as Array<{ id: string }>) : []
    const merged = mergeRecords(current, byId)
    if (merged !== current || !Array.isArray(src[collection])) {
      out ??= { ...src }
      out[collection] = merged
    }
  }
  return out ? (out as unknown as DB) : db
}

function mergeRecords(arr: Array<{ id: string }>, byId: Map<string, RemoteChange>): Array<{ id: string }> {
  let changed = false
  const seen = new Set<string>()
  const result: Array<{ id: string }> = []
  for (const r of arr) {
    const c = byId.get(r?.id)
    if (!c) {
      result.push(r)
      continue
    }
    seen.add(r.id)
    if (c.op === 'delete') {
      changed = true
      continue
    }
    if (deepEqual(r, c.data)) result.push(r)
    else {
      result.push(c.data as { id: string })
      changed = true
    }
  }
  for (const [id, c] of byId) {
    if (seen.has(id) || c.op !== 'upsert') continue
    result.push(c.data as { id: string })
    changed = true
  }
  return changed ? result : arr
}

/** The local copy of one record or document, or undefined when this DB does not have it. */
export function localValue(db: DB, collection: string, id: string): unknown {
  const src = db as unknown as Record<string, unknown>
  if (collection === DOC_COLLECTION) return isDocKey(id) ? src[id] : undefined
  const arr = src[collection]
  if (!Array.isArray(arr)) return undefined
  for (let i = arr.length - 1; i >= 0; i--) {
    const r = arr[i] as { id?: unknown } | null
    if (r && r.id === id) return r
  }
  return undefined
}
