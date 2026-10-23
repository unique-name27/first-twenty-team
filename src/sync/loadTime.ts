// Changes the app makes on its own when a workspace loads (effective-dated job and pay changes, leavers'
// hand-offs, offer expiry: src/store/db.ts applyLoadChanges) have to reach the server like any edit, or a comp row
// syncs as "applied" while the person row never gets the new title. Every device that opens the workspace
// on or after the effective date makes the same change, so the activity rows it logs must get the same id
// on every device; otherwise each device (and each reload) would add its own copy. Pure.
import type { Activity, DB } from '@/domain/types'
import { fingerprint } from './fingerprint'

/** Ids from newId('act') (src/lib/id.ts): random, so different on every device. */
const RANDOM_ACTIVITY_ID = /^act-[0-9a-z]{10}$/

export const LOAD_TIME_ACTIVITY_PREFIX = 'act-auto-'

/**
 * Gives activity rows that `after` added on top of `before` (with random ids) an id derived from what
 * they say, so two devices applying the same effective-dated change log the same row. Returns `after`
 * itself when there is nothing to rename. Nothing else refers to activity ids, so renaming is safe.
 */
export function stabilizeLoadTimeIds(before: DB, after: DB): DB {
  if (before === after || before.activity === after.activity || !Array.isArray(after.activity)) return after
  const old = new Set((before.activity ?? []).map((a) => a.id))
  const taken = new Set(after.activity.map((a) => a.id))
  let out: Activity[] | null = null
  after.activity.forEach((row, i) => {
    if (old.has(row.id) || !RANDOM_ACTIVITY_ID.test(row.id)) return
    const base = LOAD_TIME_ACTIVITY_PREFIX + fingerprint([row.kind, row.entityType, row.entityId, row.relatedId ?? null, row.text]).replace('.', '')
    let id = base
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
    taken.delete(row.id)
    taken.add(id)
    out ??= after.activity.slice()
    out[i] = { ...row, id }
  })
  return out ? { ...after, activity: out } : after
}

/** `meta.workspaceId`: a stable identity for one workspace (see workspaceIdOf). Optional in the data. */
type MetaWithId = DB['meta'] & { workspaceId?: unknown }

/**
 * The workspace's identity, or null for workspaces saved before identities existed. The engine gives a
 * workspace one when it is created through replaceWorkspace (Start fresh, Import of a backup without one)
 * or uploaded to a server, and it then syncs like any other field of `meta`. It is set only when a
 * workspace is created, never on load (migrate), so every copy of one workspace carries the same id.
 */
export function workspaceIdOf(db: DB | null | undefined): string | null {
  const id = (db?.meta as MetaWithId | undefined)?.workspaceId
  return typeof id === 'string' && id !== '' ? id : null
}

/** The same workspace with this identity (returns `db` itself when it already has one). */
export function withWorkspaceId(db: DB, makeId: () => string): DB {
  if (workspaceIdOf(db) || !db.meta) return db
  return { ...db, meta: { ...db.meta, workspaceId: makeId() } as DB['meta'] }
}

/**
 * True when `next` is a different workspace from `prev` (Import, Start fresh, the sample), not an edit
 * of it. A synced browser must never turn that into record-by-record changes: the deletes would lose to
 * other devices' edits and the old records would survive inside the new workspace.
 *
 * Workspaces with an identity compare it (one with an identity and one without are different: only a
 * newly created or uploaded workspace gains one, and remote copies of `meta` reach every Undo step).
 * Older workspaces fall back to the creation date and the sample flag, which two workspaces created on
 * the same day share.
 */
export function isWorkspaceSwap(prev: DB, next: DB): boolean {
  if (prev === next) return false
  const a = prev.meta
  const b = next.meta
  if (!a || !b) return false
  if ((a.sample === true) !== (b.sample === true)) return true
  const idA = workspaceIdOf(prev)
  const idB = workspaceIdOf(next)
  if (idA || idB) return idA !== idB
  return a.createdOn !== b.createdOn
}
