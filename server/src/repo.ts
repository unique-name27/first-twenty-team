// Reads and writes the workspace (docs/SYNC.md, Data layout and Protocol).
//
// Invariants:
// - Every write transaction first locks the workspace row (SELECT ... FOR UPDATE). Writers are
//   serialized, so change_log seq values become visible in order and a pull never skips a seq.
// - Seqs count per workspace (migration 005): a write takes workspaces.last_seq + 1 under that lock. So
//   one company's numbers say nothing about any other company's writes, and the change log is keyed by
//   (workspace_id, seq).
// - workspaces.last_seq is the highest seq written; reset_seq marks the last full replace (or restore)
//   and pruned_seq the last pruned row. A pull whose `since` is older than either must resync.
// - A record's version is the change_log seq of the write that produced it. Versions therefore never
//   repeat within a workspace and only grow per record, across delete and re-create, a full replace and
//   a restore (afterRestore moves every workspace's numbers far ahead), so a stale baseVersion can only
//   match the write it was based on, and echo detection by version works.
// - workspaces.history_id names the current history; it changes on every full replace and restore.
//   A client that sends an older one is told to resync (pulls) or refused with 409 'resync' (pushes).
// - The change log forgets what was deleted: a delete removes the record's earlier log rows (keeping
//   the delete row), and a full replace removes every earlier row.
// - Each record keeps `pos` (its array index on upload; new records append), so the snapshot returns
//   arrays in the order the app keeps them.
// - Many workspaces share the tables (migration 004). Every function reads and writes only the
//   workspaceId its caller passes; app.ts passes the session login's workspace, never one from a request.
//   A workspace row is never created here: sign-up makes it (workspaces.ts), so a deleted workspace
//   stays deleted (a write to it is refused as signed out).
// - workspaces.bytes_used is the length of the workspace's record and document JSON, kept by every write
//   once known (a demo company's first write counts it).
// - A demo workspace (keep = false) is held to the demo limits (validate.ts LIMITS), so strangers on a
//   public server cannot fill the disk or the memory: LIMITS.recordsPerDemoWorkspace records,
//   LIMITS.bytesPerDemoWorkspace bytes, records of LIMITS.demoRecordBytes, the demo companies together
//   to `demoTotalBytes` (DEMO_MAX_TOTAL_MB), and a change log of one upsert row per record (an upsert
//   removes the record's earlier rows, as a delete does) and at most LIMITS.logRowsPerDemoWorkspace rows.
//   Every write that changes something moves its last_active_at, which its expiry counts from.
import { DOC_COLLECTION, DOC_KEYS, RECORD_COLLECTIONS, tableName } from '../../src/sync/collections'
import type { Db, Queryable } from './db'
import { HttpError } from './errors'
import { WORKSPACE_ID } from './sqlgen'
import { jsonBytes, LIMITS, type ValidChange, type ValidWorkspace } from './validate'
import { slugFromFirstUpload } from './workspaces'

export type Change = { seq: number; collection: string; id: string; op: 'upsert' | 'delete'; version: number; data?: unknown }
/** existing: the server already held exactly this data, so nothing was written (a retried push). */
export type Applied = { collection: string; id: string; version: number; existing?: true }
/**
 * byYou: the server's copy (or, when it has none, the delete that removed it) was written by the user who
 * pushed. landed: the change log holds this exact upsert after baseVersion (an earlier attempt landed).
 */
export type Conflict = { collection: string; id: string; serverVersion: number | null; serverData: unknown | null; byYou?: true; landed?: true }

export type Snapshot = { workspaceId: string; historyId: string; seq: number; db: Record<string, unknown>; versions: Record<string, number> }
/** Whether the server holds a workspace, without its data (GET /api/workspace/status). */
export type WorkspaceStatus = { empty: true } | { empty: false; workspaceId: string; historyId: string; seq: number }
/** workspaceId: the workspace that now holds the upload (the client keeps it to know which company it syncs with). */
export type ReplaceResult = { workspaceId: string; historyId: string; seq: number; versions: Record<string, number> }
export type ChangesResult = { historyId: string; seq: number; changes: Change[]; more?: true } | { resync: true }
export type ApplyResult = { historyId: string; seq: number; applied: Applied[]; conflicts: Conflict[] }

/** How far afterRestore moves the seqs: past any seq a browser saw before the restore. */
export const RESTORE_SEQ_JUMP = 1_000_000_000

type WorkspaceRow = {
  initialized: boolean
  lastSeq: number
  resetSeq: number
  prunedSeq: number
  historyId: string
  keep: boolean
  /** workspaces.bytes_used: null until counted. */
  bytesUsed: number | null
}

const versionKey = (collection: string, id: string) => `${collection}:${id}`

async function readWorkspace(q: Queryable, workspaceId: string, lock: boolean): Promise<WorkspaceRow | null> {
  const r = await q.query<{
    initialized_at: unknown
    last_seq: unknown
    reset_seq: unknown
    pruned_seq: unknown
    history_id: string
    keep: boolean
    bytes_used: unknown
  }>(
    `SELECT initialized_at, last_seq, reset_seq, pruned_seq, history_id::text AS history_id, keep, bytes_used
       FROM workspaces WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [workspaceId],
  )
  const row = r.rows[0]
  if (!row) return null
  return {
    initialized: row.initialized_at !== null,
    lastSeq: Number(row.last_seq),
    resetSeq: Number(row.reset_seq),
    prunedSeq: Number(row.pruned_seq),
    historyId: row.history_id,
    keep: row.keep === true,
    bytesUsed: row.bytes_used === null || row.bytes_used === undefined ? null : Number(row.bytes_used),
  }
}

/**
 * Locks the workspace row for this transaction. A missing row means the workspace was deleted (a demo
 * company that expired) after the session was checked: its logins went with it, so the answer is the
 * one a signed-out browser gets.
 */
async function lockWorkspace(q: Queryable, workspaceId: string): Promise<WorkspaceRow> {
  const found = await readWorkspace(q, workspaceId, true)
  if (!found) throw new HttpError(401, 'unauthorized', 'This company is no longer on the server. Sign in again.')
  return found
}

/** One statement that counts a workspace's records in every record table ($1: the workspace id). */
const COUNT_RECORDS = `SELECT ${RECORD_COLLECTIONS.map((c) => `(SELECT count(*) FROM ${tableName(c)} WHERE workspace_id = $1)`).join(' + ')} AS n`

/** The length of a stored JSON value as the byte counts measure it. */
const SIZE = 'octet_length(data::text)'

/** One statement that measures a workspace's records and documents ($1: the workspace id), as bytes_used counts them. */
const COUNT_BYTES = `SELECT ${['workspace_docs', ...RECORD_COLLECTIONS.map(tableName)]
  .map((t) => `(SELECT coalesce(sum(${SIZE}), 0) FROM ${t} WHERE workspace_id = $1)`)
  .join(' + ')} AS n`

/** 413 workspace_full: a demo workspace would hold more than LIMITS.recordsPerDemoWorkspace records. */
function workspaceFull(): HttpError {
  const max = LIMITS.recordsPerDemoWorkspace.toLocaleString('en-US')
  return new HttpError(413, 'workspace_full', `A demo company holds at most ${max} records on this server. Remove some (old activity, for example) first.`)
}

/** 413 workspace_full: a demo workspace would hold more than LIMITS.bytesPerDemoWorkspace bytes. */
function workspaceFullOfBytes(): HttpError {
  const mb = Math.round(LIMITS.bytesPerDemoWorkspace / (1024 * 1024))
  return new HttpError(413, 'workspace_full', `A demo company holds at most ${mb} MB on this server. Remove large notes or old activity first.`)
}

/** 413 workspace_full: the demo companies together would hold more than DEMO_MAX_TOTAL_MB. */
function demoServerFull(): HttpError {
  return new HttpError(413, 'workspace_full', 'This demo server has no room left for more data right now. Remove some, or try again later.')
}

/** 413 too_large: a record over LIMITS.demoRecordBytes in a demo workspace. */
function demoRecordTooLarge(where: string): HttpError {
  return new HttpError(413, 'too_large', `${where} is larger than ${LIMITS.demoRecordBytes / 1024} KB, the most a record in a demo company may hold.`)
}

/**
 * The byte checks a write to a demo workspace ends with, after everything it changed: its own budget,
 * then the demo companies together (`totalBytes`; their bytes_used, this one's as it now is). Only a
 * write that adds bytes is held to them, so one that removes some always goes through.
 */
async function checkDemoBytes(q: Queryable, workspaceId: string, before: number, after: number, totalBytes: number | undefined): Promise<void> {
  if (after <= before) return
  if (after > LIMITS.bytesPerDemoWorkspace) throw workspaceFullOfBytes()
  if (totalBytes === undefined || !Number.isFinite(totalBytes)) return
  const others = await q.query<{ n: unknown }>('SELECT coalesce(sum(bytes_used), 0) AS n FROM workspaces WHERE NOT keep AND id <> $1', [workspaceId])
  if (Number(others.rows[0].n) + after > totalBytes) throw demoServerFull()
}

/**
 * A demo workspace whose change log may hold more than LIMITS.logRowsPerDemoWorkspace rows (its seqs
 * since the last prune bound how many it holds) loses the oldest ones now, in the write's transaction.
 * Browsers behind them resync.
 */
async function capDemoLog(q: Queryable, workspaceId: string, seq: number, prunedSeq: number): Promise<void> {
  const cap = LIMITS.logRowsPerDemoWorkspace
  if (seq - prunedSeq <= cap) return
  const over = await q.query<{ seq: unknown }>('SELECT seq FROM change_log WHERE workspace_id = $1 ORDER BY seq DESC OFFSET $2 LIMIT 1', [workspaceId, cap])
  if (!over.rows[0]) return
  const cutoff = Number(over.rows[0].seq)
  await q.query('DELETE FROM change_log WHERE workspace_id = $1 AND seq <= $2', [workspaceId, cutoff])
  await q.query('UPDATE workspaces SET pruned_seq = greatest(pruned_seq, $2) WHERE id = $1', [workspaceId, cutoff])
}

export async function isInitialized(db: Queryable, workspaceId = WORKSPACE_ID): Promise<boolean> {
  return (await readWorkspace(db, workspaceId, false))?.initialized ?? false
}

/** Whether a workspace was uploaded, and its history and seq: one row read, no records. */
export async function workspaceStatus(db: Queryable, workspaceId = WORKSPACE_ID): Promise<WorkspaceStatus> {
  const ws = await readWorkspace(db, workspaceId, false)
  if (!ws?.initialized) return { empty: true }
  return { empty: false, workspaceId, historyId: ws.historyId, seq: ws.lastSeq }
}

/** The whole workspace in the shape of src/domain/types.ts DB, or null before the first upload. */
export async function snapshot(db: Db, workspaceId = WORKSPACE_ID): Promise<Snapshot | null> {
  return db.tx(
    async (q) => {
      const ws = await readWorkspace(q, workspaceId, false)
      if (!ws?.initialized) return null
      const out: Record<string, unknown> = { schemaVersion: 1 }
      const versions: Record<string, number> = {}
      const docs = await q.query<{ key: string; data: unknown; version: unknown }>(
        'SELECT key, data, version FROM workspace_docs WHERE workspace_id = $1',
        [workspaceId],
      )
      const byKey = new Map(docs.rows.map((d) => [d.key, d]))
      for (const key of DOC_KEYS) {
        const d = byKey.get(key)
        if (!d) continue
        out[key] = d.data
        versions[versionKey(DOC_COLLECTION, key)] = Number(d.version)
      }
      for (const collection of RECORD_COLLECTIONS) {
        const rows = await q.query<{ id: string; data: unknown; version: unknown }>(
          `SELECT id, data, version FROM ${tableName(collection)} WHERE workspace_id = $1 ORDER BY pos, id`,
          [workspaceId],
        )
        out[collection] = rows.rows.map((r) => r.data)
        for (const r of rows.rows) versions[versionKey(collection, r.id)] = Number(r.version)
      }
      return { workspaceId, historyId: ws.historyId, seq: ws.lastSeq, db: out, versions }
    },
    { isolation: 'repeatable read', readOnly: true },
  )
}

/** Byte limits for writes to demo workspaces that only the caller knows (app.ts: DEMO_MAX_TOTAL_MB). */
export type DemoWriteOptions = {
  /** Bytes the demo companies may hold together (default: no such limit). */
  demoTotalBytes?: number
}

/**
 * Replaces everything in one transaction: deletes the workspace's rows and its whole change log,
 * inserts every record and document (each version is the seq of its log row), logs them as upserts,
 * moves reset_seq so older clients resync and starts a new history id.
 * Without confirmReplace it only runs on an empty server (409 'not_empty' otherwise).
 * The first upload into a workspace still named PLACEHOLDER_SLUG takes its slug from the company's name.
 */
export async function replaceWorkspace(
  db: Db,
  input: ValidWorkspace,
  userId: string | null,
  workspaceId = WORKSPACE_ID,
  options: DemoWriteOptions = {},
): Promise<ReplaceResult> {
  return db.tx(async (q) => {
    const ws = await lockWorkspace(q, workspaceId)
    if (ws.initialized && !input.confirmReplace) {
      throw new HttpError(409, 'not_empty', 'The server already holds a workspace. Send confirmReplace: true to replace it.')
    }
    if (!ws.keep) {
      if (input.collections.reduce((n, c) => n + c.ids.length, 0) > LIMITS.recordsPerDemoWorkspace) throw workspaceFull()
      const big = input.collections.find((c) => c.largest > LIMITS.demoRecordBytes)
      if (big) throw demoRecordTooLarge(`A record in ${big.collection}`)
    }
    await q.query('DELETE FROM workspace_docs WHERE workspace_id = $1', [workspaceId])
    for (const collection of RECORD_COLLECTIONS) {
      await q.query(`DELETE FROM ${tableName(collection)} WHERE workspace_id = $1`, [workspaceId])
    }
    // The replaced workspace's history goes too: deleted records and earlier values must not linger in
    // the log after Start fresh or an Import. Clients from before this point resync anyway.
    await q.query('DELETE FROM change_log WHERE workspace_id = $1', [workspaceId])

    const versions: Record<string, number> = {}
    let bytes = 0
    /** The last seq taken: every record and document takes the next one, in order. */
    let seq = ws.lastSeq
    for (const doc of input.docs) {
      seq += 1
      const r = await q.query<{ version: unknown; bytes: unknown }>(
        `WITH logged AS (
                INSERT INTO change_log (seq, workspace_id, collection, record_id, op, version, data, user_id)
                VALUES ($6, $1, $5, $2, 'upsert', $6, $3::jsonb, $4)
              )
         INSERT INTO workspace_docs (workspace_id, key, data, version, updated_by)
         VALUES ($1, $2, $3::jsonb, $6, $4)
         RETURNING version, ${SIZE} AS bytes`,
        [workspaceId, doc.key, doc.json, userId, DOC_COLLECTION, seq],
      )
      versions[versionKey(DOC_COLLECTION, doc.key)] = Number(r.rows[0].version)
      bytes += Number(r.rows[0].bytes)
    }
    for (const c of input.collections) {
      if (c.ids.length === 0) continue
      // One seq per record, in array order; the record and its log row share it as their version.
      const r = await q.query<{ id: string; version: unknown; bytes: unknown }>(
        `WITH e AS MATERIALIZED (
                SELECT j.value, j.ord, $5::bigint + j.ord AS v
                  FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS j(value, ord)
              ),
              logged AS (
                INSERT INTO change_log (seq, workspace_id, collection, record_id, op, version, data, user_id)
                SELECT v, $1, $4, value->>'id', 'upsert', v, value, $3 FROM e
              )
         INSERT INTO ${c.table} (workspace_id, id, data, version, pos, updated_by)
         SELECT $1, value->>'id', value, v, ord - 1, $3 FROM e
         RETURNING id, version, ${SIZE} AS bytes`,
        [workspaceId, c.json, userId, c.collection, seq],
      )
      for (const row of r.rows) {
        versions[versionKey(c.collection, row.id)] = Number(row.version)
        bytes += Number(row.bytes)
      }
      seq += c.ids.length
    }
    if (!ws.keep) await checkDemoBytes(q, workspaceId, ws.bytesUsed ?? 0, bytes, options.demoTotalBytes)
    if (!ws.initialized) {
      const company = input.docs.find((d) => d.key === 'company')
      await slugFromFirstUpload(q, workspaceId, company ? (JSON.parse(company.json) as { name?: unknown }).name : undefined)
    }

    const updated = await q.query<{ history_id: string }>(
      `UPDATE workspaces
          SET initialized_at = coalesce(initialized_at, now()), replaced_at = now(), last_seq = $2, reset_seq = $2,
              pruned_seq = greatest(pruned_seq, $3), history_id = gen_random_uuid(), last_active_at = now(), bytes_used = $4
        WHERE id = $1
        RETURNING history_id::text AS history_id`,
      [workspaceId, seq, ws.lastSeq, bytes],
    )
    return { workspaceId, historyId: updated.rows[0].history_id, seq, versions }
  })
}

export type ChangesOptions = {
  /** The history id the client last saw; a different one means resync. Null or absent: not checked. */
  historyId?: string | null
  workspaceId?: string
  /** Most changes per pull (5,000 by default). */
  limit?: number
  /** A pull stops at the change that takes it past this many bytes of record JSON (LIMITS.bytesPerPull by default). */
  maxBytes?: number
}

/**
 * Changes after `since`, oldest first, or resync. A page holds at most 5,000 changes and stops at the one
 * that takes it past LIMITS.bytesPerPull bytes of record JSON (always at least one change); `more` says
 * there are more, and `seq` is then the last change returned.
 */
export async function changesSince(db: Db, since: number, options: ChangesOptions = {}): Promise<ChangesResult> {
  const workspaceId = options.workspaceId ?? WORKSPACE_ID
  const limit = options.limit ?? LIMITS.changesPerPull
  const maxBytes = options.maxBytes ?? LIMITS.bytesPerPull
  return db.tx(
    async (q) => {
      const ws = await readWorkspace(q, workspaceId, false)
      if (!ws?.initialized) return { resync: true as const }
      // From another history (replaced or restored since), older than the last full replace or the pruned
      // history, or from a log this server never wrote.
      if (options.historyId && options.historyId !== ws.historyId) return { resync: true as const }
      if (since < ws.resetSeq || since < ws.prunedSeq || since > ws.lastSeq) return { resync: true as const }
      // The first limit + 1 rows, then those whose earlier rows hold fewer than maxBytes: the database
      // measures and drops the rest, so a page never brings more than about maxBytes into memory here.
      const r = await q.query<{
        seq: unknown
        collection: string
        record_id: string
        op: 'upsert' | 'delete'
        version: unknown
        data: unknown
        total: unknown
      }>(
        `SELECT seq, collection, record_id, op, version, data, total FROM (
            SELECT *, sum(size) OVER (ORDER BY seq) AS upto, count(*) OVER () AS total FROM (
              SELECT seq, collection, record_id, op, version, data, coalesce(${SIZE}, 0) AS size
                FROM change_log
               WHERE workspace_id = $1 AND seq > $2 AND seq <= $3
               ORDER BY seq LIMIT $4
            ) first_rows
          ) measured
          WHERE upto - size < $5
          ORDER BY seq`,
        [workspaceId, since, ws.lastSeq, limit + 1, maxBytes],
      )
      const total = r.rows.length > 0 ? Number(r.rows[0].total) : 0
      const more = total > limit || r.rows.length < total
      const rows = r.rows.slice(0, limit)
      const changes: Change[] = rows.map((row) => {
        const change: Change = { seq: Number(row.seq), collection: row.collection, id: row.record_id, op: row.op, version: Number(row.version) }
        if (row.op === 'upsert') change.data = row.data
        return change
      })
      const seq = more ? changes[changes.length - 1].seq : ws.lastSeq
      return more ? { historyId: ws.historyId, seq, changes, more: true as const } : { historyId: ws.historyId, seq, changes }
    },
    { isolation: 'repeatable read', readOnly: true },
  )
}

type CurrentRow = { version: unknown; data: unknown; same: boolean | null; by_you: boolean; bytes: unknown }

/** The record's newest change-log row; byYou: `userId` wrote it. */
async function lastLogged(
  q: Queryable,
  workspaceId: string,
  collection: string,
  id: string,
  userId: string | null,
): Promise<{ op: string; version: number; byYou: boolean } | null> {
  const r = await q.query<{ op: string; version: unknown; by_you: boolean }>(
    `SELECT op, version, coalesce(user_id = $4::uuid, false) AS by_you FROM change_log
      WHERE workspace_id = $1 AND collection = $2 AND record_id = $3
      ORDER BY seq DESC LIMIT 1`,
    [workspaceId, collection, id, userId],
  )
  const row = r.rows[0]
  return row ? { op: row.op, version: Number(row.version), byYou: row.by_you === true } : null
}

/**
 * True when the change log holds an upsert of exactly this change's data for its record after `since`:
 * an earlier attempt of this change landed (its answer never reached the client). The log keeps upserts
 * until the record is deleted or the rows are pruned (in a demo workspace, until the record's next
 * upsert), so a false answer proves nothing.
 */
async function loggedAfter(q: Queryable, workspaceId: string, c: ValidChange, since: number): Promise<boolean> {
  if (c.op !== 'upsert' || c.json === null) return false
  const r = await q.query<{ found: boolean }>(
    `SELECT EXISTS (
        SELECT 1 FROM change_log
         WHERE workspace_id = $1 AND collection = $2 AND record_id = $3 AND op = 'upsert' AND seq > $4 AND data = $5::jsonb
      ) AS found`,
    [workspaceId, c.collection, c.id, since, c.json],
  )
  return r.rows[0]?.found === true
}

function conflict(c: ValidChange, serverVersion: number | null, serverData: unknown, flags: { byYou?: boolean; landed?: boolean } = {}): Conflict {
  const out: Conflict = { collection: c.collection, id: c.id, serverVersion, serverData }
  if (flags.byYou) out.byYou = true
  if (flags.landed) out.landed = true
  return out
}

export type ApplyOptions = DemoWriteOptions & {
  /** The history id the client last saw; a different one refuses the whole push (409 'resync'). */
  historyId?: string | null
  workspaceId?: string
  /**
   * Whether a write counts as the workspace being in use (default true), moving last_active_at, which a
   * demo company's expiry counts from. Writes nobody in the company made (an application from a public
   * careers page) pass false, so strangers cannot keep an abandoned demo company alive.
   */
  markActive?: boolean
}

/**
 * Applies client changes in one transaction, each accepted or rejected on its own:
 * - accepted when baseVersion equals the current version, or the record does not exist and baseVersion
 *   is null, or the record was deleted and baseVersion is at least the delete's version (a re-create by a
 *   client that saw the delete). An edit made on a copy from before the delete is a conflict: it would
 *   bring back a record another device removed. A missing document is always recreated;
 * - an upsert whose data already equals the server copy is reported as applied with `existing` (a
 *   retried push), and nothing is written;
 * - otherwise a conflict carrying the server's current copy (null when it does not exist), with `byYou`
 *   when the pushing user wrote that copy (or the delete), and `landed` when an earlier attempt of this
 *   very upsert is in the log after baseVersion (the client may then take the newer copy quietly).
 * Every accepted write takes the workspace's next seq as its version.
 * Deletes are hard deletes plus a 'delete' row in the change log; the record's earlier log rows go.
 * In a demo workspace an upsert removes the record's earlier rows too, and a push that would pass a demo
 * limit (a new record past LIMITS.recordsPerDemoWorkspace, more bytes than the workspace's or all demo
 * companies' budget: 413 workspace_full; a record over LIMITS.demoRecordBytes: 413 too_large) refuses
 * the whole push, like a record over the size limit: the client sets that change aside.
 */
export async function applyChanges(db: Db, changes: ValidChange[], userId: string | null, options: ApplyOptions = {}): Promise<ApplyResult> {
  const workspaceId = options.workspaceId ?? WORKSPACE_ID
  return db.tx(async (q) => {
    const ws = await lockWorkspace(q, workspaceId)
    if (!ws.initialized) throw new HttpError(404, 'empty', 'The server has no workspace yet. Upload one first (PUT /api/workspace).')
    if (options.historyId && options.historyId !== ws.historyId) {
      throw new HttpError(409, 'resync', 'The server copy was replaced or restored since this browser last synced. Load it again, then push.')
    }
    const demo = !ws.keep
    if (demo) {
      for (const c of changes) {
        if (c.table !== null && c.json !== null && jsonBytes(c.json, LIMITS.demoRecordBytes) > LIMITS.demoRecordBytes) {
          throw demoRecordTooLarge(`${c.collection} ${JSON.stringify(c.id.slice(0, 60))}`)
        }
      }
    }
    const applied: Applied[] = []
    const conflicts: Conflict[] = []
    let seq = ws.lastSeq
    /** A demo workspace's record count, read once on the push's first new record (null until then). */
    let records = null as number | null
    const countNewRecord = async () => {
      if (!demo) return
      records ??= Number((await q.query<{ n: unknown }>(COUNT_RECORDS, [workspaceId])).rows[0].n)
      if (records + 1 > LIMITS.recordsPerDemoWorkspace) throw workspaceFull()
      records += 1
    }
    /** The workspace's bytes: counted now in a demo workspace that never was, else kept only when known. */
    const bytesBefore = ws.bytesUsed ?? (demo ? Number((await q.query<{ n: unknown }>(COUNT_BYTES, [workspaceId])).rows[0].n) : null)
    let bytes = bytesBefore

    /** Appends the log row with the workspace's next seq and returns it, which is the new version. */
    const log = async (c: ValidChange, op: 'upsert' | 'delete'): Promise<number> => {
      const next = seq + 1
      await q.query(
        `INSERT INTO change_log (seq, workspace_id, collection, record_id, op, version, data, user_id)
         VALUES ($1, $2, $3, $4, $5, $1, $6::jsonb, $7)`,
        [next, workspaceId, c.collection, c.id, op, op === 'upsert' ? c.json : null, userId],
      )
      seq = next
      return next
    }
    /** Keeps only the record's newest log row (the delete, or in a demo workspace the upsert, just written). */
    const forgetEarlier = (c: ValidChange, version: number) =>
      q.query('DELETE FROM change_log WHERE workspace_id = $1 AND collection = $2 AND record_id = $3 AND seq < $4', [workspaceId, c.collection, c.id, version])

    for (const c of changes) {
      const sameExpr = c.json === null ? 'NULL::boolean' : 'data = $4::jsonb'
      const params = c.json === null ? [workspaceId, c.id, userId] : [workspaceId, c.id, userId, c.json]
      const columns = `version, data, ${sameExpr} AS same, coalesce(updated_by = $3::uuid, false) AS by_you, ${SIZE} AS bytes`
      const current: CurrentRow | undefined =
        c.table === null
          ? (await q.query<CurrentRow>(`SELECT ${columns} FROM workspace_docs WHERE workspace_id = $1 AND key = $2 FOR UPDATE`, params)).rows[0]
          : (await q.query<CurrentRow>(`SELECT ${columns} FROM ${c.table} WHERE workspace_id = $1 AND id = $2 FOR UPDATE`, params)).rows[0]

      if (current) {
        const version = Number(current.version)
        if (c.baseVersion !== version) {
          if (c.op === 'upsert' && current.same === true) applied.push({ collection: c.collection, id: c.id, version, existing: true })
          else {
            const landed = await loggedAfter(q, workspaceId, c, c.baseVersion ?? 0)
            conflicts.push(conflict(c, version, current.data, { byYou: current.by_you === true, landed }))
          }
          continue
        }
        const next = await log(c, c.op)
        const oldBytes = Number(current.bytes)
        if (c.op === 'delete') {
          await q.query(`DELETE FROM ${c.table} WHERE workspace_id = $1 AND id = $2`, [workspaceId, c.id])
          if (records !== null) records -= 1
          if (bytes !== null) bytes -= oldBytes
          // Keep only the delete row: earlier copies of a deleted record do not stay in the log.
          await forgetEarlier(c, next)
        } else {
          const r =
            c.table === null
              ? await q.query<{ bytes: unknown }>(
                  `UPDATE workspace_docs SET data = $3::jsonb, version = $4, updated_at = now(), updated_by = $5 WHERE workspace_id = $1 AND key = $2 RETURNING ${SIZE} AS bytes`,
                  [workspaceId, c.id, c.json, next, userId],
                )
              : await q.query<{ bytes: unknown }>(
                  `UPDATE ${c.table} SET data = $3::jsonb, version = $4, updated_at = now(), updated_by = $5 WHERE workspace_id = $1 AND id = $2 RETURNING ${SIZE} AS bytes`,
                  [workspaceId, c.id, c.json, next, userId],
                )
          if (bytes !== null) bytes += Number(r.rows[0].bytes) - oldBytes
          // A demo company's log holds one copy per record: editing a record a thousand times leaves one.
          if (demo) await forgetEarlier(c, next)
        }
        applied.push({ collection: c.collection, id: c.id, version: next })
        continue
      }

      // Not on the server.
      const last = await lastLogged(q, workspaceId, c.collection, c.id, userId)
      if (c.op === 'delete') {
        // Already gone: nothing to do, the client's intent holds.
        applied.push({ collection: c.collection, id: c.id, version: last?.version ?? 0 })
        continue
      }
      // Documents always exist after an upload; a missing one is simply recreated. A record comes back
      // only from a client that believes it is new, or that saw it deleted (a base at least as new as the
      // delete): an edit made on a copy from before the delete loses to it, as to any newer change.
      const deleted = last?.op === 'delete' ? last : null
      if (c.table !== null && c.baseVersion !== null && !(deleted && c.baseVersion >= deleted.version)) {
        conflicts.push(conflict(c, null, null, { byYou: deleted?.byYou === true }))
        continue
      }
      if (c.table !== null) await countNewRecord()
      const next = await log(c, 'upsert')
      const r =
        c.table === null
          ? await q.query<{ bytes: unknown }>(
              `INSERT INTO workspace_docs (workspace_id, key, data, version, updated_by) VALUES ($1, $2, $3::jsonb, $4, $5) RETURNING ${SIZE} AS bytes`,
              [workspaceId, c.id, c.json, next, userId],
            )
          : await q.query<{ bytes: unknown }>(
              `INSERT INTO ${c.table} (workspace_id, id, data, version, pos, updated_by)
               VALUES ($1, $2, $3::jsonb, $4, (SELECT coalesce(max(pos), -1) + 1 FROM ${c.table} WHERE workspace_id = $1), $5)
               RETURNING ${SIZE} AS bytes`,
              [workspaceId, c.id, c.json, next, userId],
            )
      if (bytes !== null) bytes += Number(r.rows[0].bytes)
      // A re-created record's delete row is history now, in a demo company's one-row-per-record log.
      if (demo && last) await forgetEarlier(c, next)
      applied.push({ collection: c.collection, id: c.id, version: next })
    }

    if (demo && bytes !== null && bytesBefore !== null) await checkDemoBytes(q, workspaceId, bytesBefore, bytes, options.demoTotalBytes)
    if (seq !== ws.lastSeq || bytes !== ws.bytesUsed) {
      const active = seq !== ws.lastSeq && options.markActive !== false ? ', last_active_at = now()' : ''
      await q.query(`UPDATE workspaces SET last_seq = $2, bytes_used = $3${active} WHERE id = $1`, [workspaceId, seq, bytes])
    }
    if (demo) await capDemoLog(q, workspaceId, seq, ws.prunedSeq)
    return { historyId: ws.historyId, seq, applied, conflicts }
  })
}

/**
 * Deletes a workspace's change-log rows older than `olderThanDays` (120 by default), and, with
 * `maxRows`, every row but the newest maxRows. Clients whose `since` predates the pruned rows get
 * `resync: true`. Returns how many rows were removed.
 */
export async function pruneChangeLog(db: Db, olderThanDays = 120, workspaceId = WORKSPACE_ID, maxRows?: number): Promise<number> {
  return db.tx(async (q) => {
    await lockWorkspace(q, workspaceId)
    const old = await q.query<{ seq: unknown }>(
      `SELECT max(seq) AS seq FROM change_log WHERE workspace_id = $1 AND at < now() - make_interval(days => $2::int)`,
      [workspaceId, olderThanDays],
    )
    let cutoff = old.rows[0]?.seq === null || old.rows[0]?.seq === undefined ? null : Number(old.rows[0].seq)
    if (maxRows !== undefined) {
      // The newest row past the cap: it and everything older go.
      const over = await q.query<{ seq: unknown }>('SELECT seq FROM change_log WHERE workspace_id = $1 ORDER BY seq DESC OFFSET $2 LIMIT 1', [
        workspaceId,
        maxRows,
      ])
      if (over.rows[0]) cutoff = Math.max(cutoff ?? 0, Number(over.rows[0].seq))
    }
    if (cutoff === null) return 0
    const del = await q.query('DELETE FROM change_log WHERE workspace_id = $1 AND seq <= $2', [workspaceId, cutoff])
    await q.query('UPDATE workspaces SET pruned_seq = greatest(pruned_seq, $2) WHERE id = $1', [workspaceId, cutoff])
    return del.rowCount
  })
}

/**
 * pruneChangeLog for every workspace: rows older than `olderThanDays`, and for demo workspaces (not kept)
 * everything past their newest LIMITS.logRowsPerDemoWorkspace rows, so one busy demo company cannot fill
 * the disk. Returns how many rows were removed in all.
 */
export async function pruneChangeLogs(db: Db, olderThanDays = 120): Promise<number> {
  const all = await db.query<{ id: string; keep: boolean }>('SELECT id, keep FROM workspaces ORDER BY id')
  let removed = 0
  for (const ws of all.rows) {
    try {
      removed += await pruneChangeLog(db, olderThanDays, ws.id, ws.keep ? undefined : LIMITS.logRowsPerDemoWorkspace)
    } catch (err) {
      // Deleted (expired) between the list and its turn: nothing left to prune.
      if (!(err instanceof HttpError && err.statusCode === 401)) throw err
    }
  }
  return removed
}

export type AfterRestoreResult = { seq: number; historyId: string; sessionsEnded: number }

/**
 * Run once after loading a backup (`npm run server:after-restore`, docs/SERVER.md). A restored database
 * reuses seqs and versions that browsers already saw in the history that was lost, so this:
 * - moves every workspace's seqs RESTORE_SEQ_JUMP past anything any workspace ever handed out, and sets
 *   last_seq and reset_seq there, so every browser's `since` is older than reset_seq and it resyncs, and
 *   every new version is larger than any version a browser could still hold;
 * - starts a new history id, so browsers that send theirs are told to resync before anything applies;
 * - ends every session and forgets every trusted device: the backup may hold sessions that were signed
 *   out, and devices that were forgotten (server:create-admin), after it was taken.
 * A backup holds every workspace on the server, so all of them get the new numbering (one number for all:
 * it says nothing about any one company) and a history id of their own; the result names `workspaceId`'s
 * (the server's own workspace by default).
 */
export async function afterRestore(db: Db, workspaceId = WORKSPACE_ID): Promise<AfterRestoreResult> {
  return db.tx(async (q) => {
    const ws = await lockWorkspace(q, workspaceId)
    await q.query('SELECT 1 FROM workspaces ORDER BY id FOR UPDATE')
    const top = await q.query<{ top: unknown }>(
      `SELECT greatest(
                $1::bigint,
                (SELECT coalesce(max(seq), 0) FROM change_log),
                (SELECT coalesce(max(last_seq), 0) FROM workspaces)
              ) AS top`,
      [ws.lastSeq],
    )
    const seq = Number(top.rows[0].top) + RESTORE_SEQ_JUMP
    await q.query('UPDATE workspaces SET last_seq = $1, reset_seq = $1, history_id = gen_random_uuid()', [seq])
    const updated = await q.query<{ history_id: string }>('SELECT history_id::text AS history_id FROM workspaces WHERE id = $1', [workspaceId])
    const sessions = await q.query('DELETE FROM sessions')
    await q.query('DELETE FROM trusted_devices')
    return { seq, historyId: updated.rows[0].history_id, sessionsEnded: sessions.rowCount }
  })
}
