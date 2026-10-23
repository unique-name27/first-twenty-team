// Validates request bodies before anything touches the database (docs/SYNC.md, Rules):
// a collection must be a known record collection or `$doc` with a known key, records carry
// data.id === id, and each record is at most 256 KB. Table names come only from the whitelist.
import {
  DOC_COLLECTION,
  type DocKey,
  isDocKey,
  isRecordCollection,
  type RecordCollection,
  tableName,
} from '../../src/sync/collections'
import { badRequest } from './errors'

export const LIMITS = {
  recordBytes: 256 * 1024,
  changesPerRequest: 2000,
  idLength: 200,
  changesPerPull: 5000,
  /** A pull stops at the change that takes it past this many bytes of record JSON (`more: true`), so no page is huge. */
  bytesPerPull: 8 * 1024 * 1024,
  /** Records (all collections together, documents not counted) a demo workspace may hold: 413 workspace_full beyond. */
  recordsPerDemoWorkspace: 20_000,
  /**
   * Bytes of record and document JSON a demo workspace may hold (workspaces.bytes_used): 413 workspace_full
   * beyond. Room for a full 10 MB upload, and about twenty times the sample company.
   */
  bytesPerDemoWorkspace: 16 * 1024 * 1024,
  /** One record in a demo workspace (documents keep recordBytes: settings alone is about 50 KB): 413 too_large beyond. */
  demoRecordBytes: 64 * 1024,
  /**
   * Change-log rows a demo workspace keeps. A push that takes it past them prunes the oldest at once, and
   * the daily housekeeping checks again (clients behind the pruned rows resync).
   */
  logRowsPerDemoWorkspace: 50_000,
}

export type ClientChange = {
  collection: string
  id: string
  op: 'upsert' | 'delete'
  data?: unknown
  baseVersion: number | null
}

/** A change that passed validation. `table` is null for `$doc`; `json` is set for upserts. */
export type ValidChange =
  | { collection: RecordCollection; table: string; id: string; op: 'upsert' | 'delete'; json: string | null; baseVersion: number | null }
  | { collection: typeof DOC_COLLECTION; table: null; id: DocKey; op: 'upsert'; json: string; baseVersion: number | null }

export type ValidWorkspace = {
  /**
   * Every record collection, in RECORD_COLLECTIONS order of appearance, as a JSON array string. largest:
   * the size of its largest record in bytes (in UTF-16 units when that is under LIMITS.demoRecordBytes / 4,
   * which no limit is near).
   */
  collections: Array<{ collection: RecordCollection; table: string; ids: string[]; json: string; largest: number }>
  docs: Array<{ key: DocKey; json: string }>
  confirmReplace: boolean
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// A JSON "\u0000" escape (preceded by an even number of backslashes): Postgres jsonb rejects it.
const NUL_ESCAPE = /(^|[^\\])(\\\\)*\\u0000/

/** JSON-encodes a record or document, enforcing the size limit. */
export function encode(value: unknown, where: string): string {
  const json = JSON.stringify(value)
  if (json === undefined) throw badRequest(`${where} is not valid JSON data.`)
  if (json.length > LIMITS.recordBytes / 4 && Buffer.byteLength(json, 'utf8') > LIMITS.recordBytes) {
    throw badRequest(`${where} is larger than ${LIMITS.recordBytes / 1024} KB.`)
  }
  if (NUL_ESCAPE.test(json)) throw badRequest(`${where} contains a NUL character, which the database cannot store.`)
  return json
}

/**
 * The UTF-8 size of a JSON string, counted exactly only when it could be over `limit` (a string of n
 * UTF-16 units is at most 4n bytes); below that, its length.
 */
export function jsonBytes(json: string, limit: number): number {
  return json.length > limit / 4 ? Buffer.byteLength(json, 'utf8') : json.length
}

function validId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= LIMITS.idLength
}

/** Short, safe echo of a client-supplied name for error details. */
function show(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
  return JSON.stringify(s.length > 60 ? `${s.slice(0, 57)}...` : s)
}

export function parseChanges(body: unknown): ValidChange[] {
  if (!isPlainObject(body) || !Array.isArray(body.changes)) throw badRequest('Send {"changes": [...]}.')
  const list = body.changes as unknown[]
  if (list.length > LIMITS.changesPerRequest) throw badRequest(`Send at most ${LIMITS.changesPerRequest} changes per request.`)
  return list.map((raw, i) => parseChange(raw, `changes[${i}]`))
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** An optional history id (?history= on pulls, historyId in a push): absent is null, malformed is 400. */
export function parseHistoryId(raw: unknown, where = 'history'): string | null {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string' || !UUID.test(raw)) throw badRequest(`${where} must be the historyId the server sent.`)
  return raw.toLowerCase()
}

/** Validates the body of POST /api/changes: {changes, historyId?}. */
export function parsePush(body: unknown): { changes: ValidChange[]; historyId: string | null } {
  const changes = parseChanges(body)
  return { changes, historyId: parseHistoryId((body as Record<string, unknown>).historyId, 'historyId') }
}

function parseChange(raw: unknown, where: string): ValidChange {
  if (!isPlainObject(raw)) throw badRequest(`${where} must be an object.`)
  const { collection, id, op, data, baseVersion } = raw
  if (op !== 'upsert' && op !== 'delete') throw badRequest(`${where}.op must be "upsert" or "delete".`)
  // Versions are change_log seqs (bigint), so anything up to 2^53 is a valid version.
  if (!(baseVersion === null || (Number.isSafeInteger(baseVersion) && (baseVersion as number) >= 0))) {
    throw badRequest(`${where}.baseVersion must be null or a whole number.`)
  }
  const base = baseVersion as number | null
  if (!validId(id)) throw badRequest(`${where}.id must be a string of 1 to ${LIMITS.idLength} characters.`)

  if (collection === DOC_COLLECTION) {
    if (!isDocKey(id)) throw badRequest(`${where}: ${show(id)} is not a known document.`)
    if (op !== 'upsert') throw badRequest(`${where}: documents cannot be deleted.`)
    if (!isPlainObject(data)) throw badRequest(`${where}.data must be an object.`)
    return { collection: DOC_COLLECTION, table: null, id, op, json: encode(data, `${where} ($doc ${id})`), baseVersion: base }
  }
  if (typeof collection !== 'string' || !isRecordCollection(collection)) {
    throw badRequest(`${where}: collection ${show(collection)} is not known.`)
  }
  if (op === 'delete') return { collection, table: tableName(collection), id, op, json: null, baseVersion: base }
  if (!isPlainObject(data)) throw badRequest(`${where}.data must be an object.`)
  if (data.id !== id) throw badRequest(`${where}: data.id must equal id.`)
  return { collection, table: tableName(collection), id, op, json: encode(data, `${where} (${collection} ${id})`), baseVersion: base }
}

/** Validates the body of PUT /api/workspace: {db, confirmReplace?}. */
export function parseWorkspace(body: unknown): ValidWorkspace {
  if (!isPlainObject(body) || !isPlainObject(body.db)) throw badRequest('Send {"db": {...}, "confirmReplace": true|false}.')
  if (body.confirmReplace !== undefined && typeof body.confirmReplace !== 'boolean') throw badRequest('confirmReplace must be true or false.')
  const db = body.db
  if (db.schemaVersion !== 1) throw badRequest('db.schemaVersion must be 1.')
  if (!isPlainObject(db.company)) throw badRequest('db.company is missing.')
  if (!isPlainObject(db.meta)) throw badRequest('db.meta is missing.')

  const out: ValidWorkspace = { collections: [], docs: [], confirmReplace: body.confirmReplace === true }
  for (const [key, value] of Object.entries(db)) {
    if (key === 'schemaVersion') continue
    if (isDocKey(key)) {
      if (!isPlainObject(value)) throw badRequest(`db.${key} must be an object.`)
      out.docs.push({ key, json: encode(value, `db.${key}`) })
    } else if (isRecordCollection(key)) {
      if (!Array.isArray(value)) throw badRequest(`db.${key} must be a list.`)
      const ids: string[] = []
      const seen = new Set<string>()
      let largest = 0
      const parts = value.map((record: unknown, i) => {
        const where = `db.${key}[${i}]`
        if (!isPlainObject(record)) throw badRequest(`${where} must be an object.`)
        if (!validId(record.id)) throw badRequest(`${where}.id must be a string of 1 to ${LIMITS.idLength} characters.`)
        if (seen.has(record.id)) throw badRequest(`${where}: id ${show(record.id)} appears more than once in ${key}.`)
        seen.add(record.id)
        ids.push(record.id)
        const json = encode(record, where)
        largest = Math.max(largest, jsonBytes(json, LIMITS.demoRecordBytes))
        return json
      })
      out.collections.push({ collection: key, table: tableName(key), ids, json: `[${parts.join(',')}]`, largest })
    } else {
      throw badRequest(`db.${show(key).slice(1, -1)} is not a known part of the workspace.`)
    }
  }
  return out
}

/** Parses ?since=<seq>. */
export function parseSince(raw: unknown): number {
  if (typeof raw !== 'string' || !/^\d{1,15}$/.test(raw)) throw badRequest('since must be a whole number (the last seq you saw, 0 for none).')
  return Number(raw)
}
