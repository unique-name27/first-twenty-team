// Turns two DB snapshots into the record-level changes between them (docs/SYNC.md, "Diff").
// Immer keeps every unchanged record the same object, so most records are skipped by identity; a deep
// compare runs only when an object was replaced, so a re-created but identical record (a JSON round trip,
// a no-op edit) is not reported. Pure: no store, no network.
import type { DB } from '@/domain/types'
import { DOC_COLLECTION, DOC_KEYS, RECORD_COLLECTIONS } from './collections'
import type { ChangeOp } from './protocol'

/** A change without baseVersion: the engine adds that from its versions map when it pushes. */
export type LocalChange = { collection: string; id: string; op: ChangeOp; data?: unknown }

type Rec = { id: string }

/**
 * Changes that turn `prev` into `next`: per record collection, records added or replaced become upserts
 * and records gone become deletes; changed documents become `$doc` upserts. schemaVersion is ignored, and
 * so is record order (the server stores rows, not arrays).
 */
export function diffDB(prev: DB, next: DB): LocalChange[] {
  if (prev === next) return []
  const out: LocalChange[] = []
  const p = prev as unknown as Record<string, unknown>
  const n = next as unknown as Record<string, unknown>
  for (const collection of RECORD_COLLECTIONS) {
    const a = p[collection]
    const b = n[collection]
    if (a === b) continue
    diffCollection(collection, records(a), records(b), out)
  }
  for (const key of DOC_KEYS) {
    const a = p[key]
    const b = n[key]
    // A document is never deleted; a missing one (an older save) is filled in by migrate().
    if (a === b || b === undefined) continue
    if (!deepEqual(a, b)) out.push({ collection: DOC_COLLECTION, id: key, op: 'upsert', data: b })
  }
  return out
}

function diffCollection(collection: string, before: Map<string, Rec>, after: Map<string, Rec>, out: LocalChange[]): void {
  for (const [id, rec] of after) {
    const old = before.get(id)
    if (old === rec) continue
    if (old !== undefined && deepEqual(old, rec)) continue
    out.push({ collection, id, op: 'upsert', data: rec })
  }
  for (const id of before.keys()) {
    if (!after.has(id)) out.push({ collection, id, op: 'delete' })
  }
}

/** Records by id (the last one wins if an id repeats). Entries without a string id are not synced. */
function records(value: unknown): Map<string, Rec> {
  const map = new Map<string, Rec>()
  if (!Array.isArray(value)) return map
  for (const r of value) {
    if (r && typeof r === 'object' && typeof (r as Rec).id === 'string') map.set((r as Rec).id, r as Rec)
  }
  return map
}

/**
 * Structural equality with JSON semantics: a key holding undefined equals a missing key, because the
 * server (JSON) never sees undefined. Arrays compare in order.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const aArr = Array.isArray(a)
  if (aArr !== Array.isArray(b)) return false
  if (aArr) {
    const x = a as unknown[]
    const y = b as unknown[]
    if (x.length !== y.length) return false
    for (let i = 0; i < x.length; i++) if (!deepEqual(x[i], y[i])) return false
    return true
  }
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  let defined = 0
  for (const k in x) {
    if (!Object.hasOwn(x, k) || x[k] === undefined) continue
    defined++
    if (!Object.hasOwn(y, k) || !deepEqual(x[k], y[k])) return false
  }
  for (const k in y) {
    if (Object.hasOwn(y, k) && y[k] !== undefined) defined--
  }
  return defined === 0
}
