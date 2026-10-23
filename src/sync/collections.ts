// Which parts of the DB sync as records (one Postgres table each) and which as single documents.
// Shared by the browser sync engine and the API server (docs/SYNC.md). A test keeps this list in step
// with src/domain/types.ts, so adding a collection to the DB without listing it here fails the build.
import type { CollectionKey, DB } from '@/domain/types'

/** Record collections: arrays of { id } records. Table name = snake_case of the key. */
export const RECORD_COLLECTIONS = [
  'departments',
  'locations',
  'families',
  'levels',
  'bands',
  'people',
  'comp',
  'grants',
  'contractors',
  'documents',
  'plan',
  'jobs',
  'candidates',
  'applications',
  'interviews',
  'scorecards',
  'offers',
  'referrals',
  'emailTemplates',
  'checklistTemplates',
  'checklists',
  'timeOffPolicies',
  'timeOffRequests',
  'timeOffAdjustments',
  'holidays',
  'leaveCases',
  'recurring',
  'trainings',
  'policies',
  'acks',
  'recordsRequests',
  'activity',
] as const satisfies readonly CollectionKey[]

export type RecordCollection = (typeof RECORD_COLLECTIONS)[number]

/** Single documents (non-array keys), synced under the collection name `$doc` with id = key. */
export const DOC_KEYS = ['meta', 'company', 'equity', 'complianceStatus', 'inboxState', 'settings'] as const satisfies readonly (keyof DB)[]

export type DocKey = (typeof DOC_KEYS)[number]

export const DOC_COLLECTION = '$doc'

export function isRecordCollection(name: string): name is RecordCollection {
  return (RECORD_COLLECTIONS as readonly string[]).includes(name)
}

export function isDocKey(name: string): name is DocKey {
  return (DOC_KEYS as readonly string[]).includes(name)
}

/** 'timeOffRequests' -> 'time_off_requests'. Only ever called with whitelisted names. */
export function tableName(collection: RecordCollection): string {
  return collection.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}
