// What the assistant's tools read: the records of one workspace, the session's, and nothing else. Each tool
// names the collections and documents its domain code needs; the reader loads each one once per chat (a
// chat runs several tools) in a read-only snapshot, and hands the tools a DB shaped like the app's (every
// collection not loaded is empty, every document not loaded is {}), so they can call the app's own domain
// functions on it. It never reads another workspace, and never the activity log unless asked (the largest
// collection, and no tool needs it).
import { DOC_KEYS, type DocKey, isDocKey, RECORD_COLLECTIONS, type RecordCollection, tableName } from '../../../src/sync/collections'
import type { DB } from '../../../src/domain/types'
import type { Db } from '../db'

export type ReadKey = RecordCollection | DocKey

/** Every collection and document except the activity log: what the compliance engine may look at. */
export const ALL_BUT_ACTIVITY: readonly ReadKey[] = [...DOC_KEYS, ...RECORD_COLLECTIONS.filter((c) => c !== 'activity')]

export class WorkspaceReader {
  private readonly loaded = new Map<ReadKey, unknown>()

  constructor(
    private readonly db: Db,
    readonly workspaceId: string,
  ) {}

  /** The workspace as a DB with `keys` loaded (each read from the database at most once per reader). */
  async read(keys: readonly ReadKey[]): Promise<DB> {
    const missing = [...new Set(keys)].filter((k) => !this.loaded.has(k))
    if (missing.length > 0) {
      await this.db.tx(
        async (q) => {
          const docs = missing.filter(isDocKey)
          if (docs.length > 0) {
            const r = await q.query<{ key: string; data: unknown }>('SELECT key, data FROM workspace_docs WHERE workspace_id = $1 AND key = ANY($2::text[])', [
              this.workspaceId,
              docs,
            ])
            for (const key of docs) {
              const row = r.rows.find((d) => d.key === key)
              this.loaded.set(key, row && typeof row.data === 'object' && row.data !== null ? row.data : {})
            }
          }
          for (const c of missing.filter((k): k is RecordCollection => !isDocKey(k))) {
            // Table names come from the collection whitelist, never from input.
            const r = await q.query<{ data: unknown }>(`SELECT data FROM ${tableName(c)} WHERE workspace_id = $1 ORDER BY pos, id`, [this.workspaceId])
            this.loaded.set(
              c,
              r.rows.map((row) => row.data).filter((d) => typeof d === 'object' && d !== null),
            )
          }
        },
        { isolation: 'repeatable read', readOnly: true },
      )
    }
    const out: Record<string, unknown> = { schemaVersion: 1 }
    for (const c of RECORD_COLLECTIONS) out[c] = this.loaded.get(c) ?? []
    for (const k of DOC_KEYS) out[k] = this.loaded.get(k) ?? {}
    return out as unknown as DB
  }
}
