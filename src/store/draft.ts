// Helpers for Immer drafts of the DB. Kept apart from the store (db.ts) so domain logic can use
// them without importing the store, which builds the sample (and so imports the domain) on load.
import type { Draft } from 'immer'
import { viewerPerson } from '@/domain/people'
import type { Activity, CollectionKey, DB, EntityType, ID } from '@/domain/types'
import { nowISO } from '@/lib/dates'
import { newId } from '@/lib/id'
import { activeRun } from '@/lib/runContext'
import { usePrefs } from './prefs'

/**
 * The person the app is acting as (Viewing as). Used as the actor on activity rows. Pass the db (or
 * draft) so a mode with no saved person resolves to the same default person useViewer shows. Inside a run
 * (src/lib/runContext.ts), the run's actor.
 */
export function currentActorId(db?: DB | Draft<DB>): ID | null {
  const run = activeRun()
  if (run) return run.actorId
  const { viewAs } = usePrefs.getState()
  if (viewAs.personId || !db) return viewAs.personId
  return viewerPerson(db as DB, viewAs.role, null)?.id ?? null
}

/** Adds an activity row: who (currentActorId), when (nowISO) and in which Viewing-as mode (a run's, inside one). */
export function logActivity(
  draft: Draft<DB>,
  a: { entityType: EntityType; entityId: ID; kind: string; text: string; relatedId?: ID },
): void {
  const viewingAs = activeRun()?.viewingAs ?? usePrefs.getState().viewAs.role
  const row: Activity = { id: newId('act'), at: nowISO(), actorId: currentActorId(draft), viewingAs, ...a }
  draft.activity.push(row)
}

export function findById<K extends CollectionKey>(draft: Draft<DB> | DB, key: K, id: ID) {
  return (draft[key] as Array<{ id: ID }>).find((r) => r.id === id) as DB[K][number] | undefined
}

export function upsert<K extends CollectionKey>(draft: Draft<DB>, key: K, record: DB[K][number]): void {
  const list = draft[key] as unknown as Array<{ id: ID }>
  const i = list.findIndex((r) => r.id === (record as { id: ID }).id)
  if (i >= 0) list[i] = record as { id: ID }
  else list.push(record as { id: ID })
}

export function removeById<K extends CollectionKey>(draft: Draft<DB>, key: K, id: ID): void {
  const list = draft[key] as unknown as Array<{ id: ID }>
  const i = list.findIndex((r) => r.id === id)
  if (i >= 0) list.splice(i, 1)
}
