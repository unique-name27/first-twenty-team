// What a live careers page reads (routes.ts): the workspace a slug names, when its careers page is on,
// and the part of its records the careers renderer needs (src/careers/render.ts): the company, meta and
// settings documents, the jobs it lists (open and posted) and only the departments, locations and pay
// bands those jobs name, the time-off policies and holiday dates the posting's benefits line counts.
// The apply form adds the people that pick the next step's owner (applicationPeople). Nothing here
// writes: applications go through repo.ts applyChanges.
//
// The records come from whoever signed the company up, and a careers page answers anyone, so what it
// loads is capped in the database, before it reaches this process: the listed jobs by count
// (MAX_LISTED_JOBS) and by bytes (LOAD_BUDGET), every other collection likewise. A company that holds
// far more than a careers page could show costs a page view no more than one that holds exactly that.
// The records are also checked for the shape the renderer relies on; a job or department that does not
// have it is left off the page instead of breaking the page for every other job.
import { DOC_KEYS, RECORD_COLLECTIONS, type RecordCollection, tableName } from '../../../src/sync/collections'
import type { DB, Person } from '../../../src/domain/types'
import type { Db, Queryable } from '../db'
import { isPlainObject } from '../validate'
import { isValidSlug } from '../workspaces'

export type CareersWorkspace = { id: string; slug: string; name: string; lastSeq: number; initialized: boolean }

/**
 * The workspace a careers address names, with the seq of its last write (the page cache key), or null:
 * no such company, or its careers page is off (workspaces.careers).
 */
export async function careersWorkspace(db: Queryable, slug: string): Promise<CareersWorkspace | null> {
  if (!isValidSlug(slug)) return null
  const r = await db.query<{ id: string; slug: string; name: string | null; last_seq: unknown; initialized: boolean }>(
    'SELECT id, slug, name, last_seq, initialized_at IS NOT NULL AS initialized FROM workspaces WHERE slug = $1 AND careers',
    [slug],
  )
  const row = r.rows[0]
  if (!row) return null
  return { id: row.id, slug: row.slug, name: row.name ?? row.slug, lastSeq: Number(row.last_seq), initialized: row.initialized === true }
}

/** Most open roles a careers page lists (the first by the company's own order). */
export const MAX_LISTED_JOBS = 200
/** Most rows of each other collection a careers page reads. */
const MAX_ROWS = 500

/**
 * Bytes of record JSON a careers page reads at most, per collection: its listed jobs together, and each
 * other collection. Past it the rest is left off (the jobs that come later in the company's order).
 */
export const LOAD_BUDGET = {
  jobs: 2 * 1024 * 1024,
  departments: 128 * 1024,
  locations: 128 * 1024,
  bands: 256 * 1024,
  timeOffPolicies: 128 * 1024,
  holidays: 64 * 1024,
}

const str = (v: unknown): v is string => typeof v === 'string'
const strOrMissing = (v: unknown) => v === undefined || v === null || typeof v === 'string'
const numOrNull = (v: unknown) => v === undefined || v === null || (typeof v === 'number' && Number.isFinite(v))

/** A job the renderer and the application builder can use without tripping over a missing field. */
function isUsableJob(j: unknown): boolean {
  if (!isPlainObject(j)) return false
  return (
    str(j.id) &&
    str(j.title) &&
    str(j.status) &&
    str(j.departmentId) &&
    str(j.description) &&
    strOrMissing(j.postedOn) &&
    strOrMissing(j.familyId) &&
    strOrMissing(j.levelId) &&
    strOrMissing(j.hiringManagerId) &&
    Array.isArray(j.locationIds) &&
    j.locationIds.every(str) &&
    (j.stages === undefined || (Array.isArray(j.stages) && j.stages.every((s) => isPlainObject(s) && str(s.id) && str(s.name) && str(s.kind)))) &&
    numOrNull(j.payMin) &&
    numOrNull(j.payMax) &&
    (j.requisition === undefined || j.requisition === null || isPlainObject(j.requisition))
  )
}

const named = (r: unknown): boolean => isPlainObject(r) && str(r.id) && str(r.name)

const KEEP: Partial<Record<RecordCollection, (r: unknown) => boolean>> = {
  jobs: isUsableJob,
  departments: named,
  locations: named,
  holidays: (r) => isPlainObject(r) && str(r.id) && str(r.date),
}

/**
 * The rows of one collection, in the company's order, while their JSON stays within `budget` bytes and
 * `limit` rows. `where` narrows them ($1 is the workspace id; its own parameters follow); `select` is the
 * JSON each row gives (default: the whole record).
 */
async function budgeted(
  q: Queryable,
  collection: RecordCollection,
  workspaceId: string,
  opts: { where?: string; params?: unknown[]; select?: string; budget: number; limit: number },
): Promise<{ rows: unknown[]; bytes: number }> {
  const params = [workspaceId, ...(opts.params ?? [])]
  const budgetParam = `$${params.length + 1}`
  const limitParam = `$${params.length + 2}`
  const r = await q.query<{ data: unknown; size: unknown }>(
    `SELECT data, size FROM (
        SELECT data, pos, id, size, sum(size) OVER (ORDER BY pos, id) AS upto FROM (
          SELECT ${opts.select ?? 'data'} AS data, pos, id, octet_length((${opts.select ?? 'data'})::text) AS size
            FROM ${tableName(collection)}
           WHERE workspace_id = $1${opts.where ? ` AND (${opts.where})` : ''}
        ) picked
      ) measured
      WHERE upto <= ${budgetParam}
      ORDER BY pos, id
      LIMIT ${limitParam}`,
    [...params, opts.budget, opts.limit],
  )
  const keep = KEEP[collection] ?? isPlainObject
  const rows = r.rows.filter((row) => keep(row.data))
  return { rows: rows.map((row) => row.data), bytes: rows.reduce((n, row) => n + Number(row.size), 0) }
}

/** What a careers page needs from a workspace (see loadCareersDb), and how many bytes of JSON it read. */
export type CareersData = { db: DB; bytes: number }

/**
 * The records a careers page needs on `date`, as a DB (every other collection empty, every other
 * document {}), or null when the workspace has no company document (it was never uploaded). One
 * read-only snapshot; everything it reads is capped (MAX_LISTED_JOBS, LOAD_BUDGET, MAX_ROWS).
 */
export async function loadCareersDb(db: Db, workspaceId: string, fallbackName: string, date: string): Promise<CareersData | null> {
  return db.tx(
    async (q) => {
      const docs = await q.query<{ key: string; data: unknown; size: unknown }>(
        `SELECT key, data, octet_length(data::text) AS size FROM workspace_docs WHERE workspace_id = $1 AND key IN ('company', 'meta', 'settings')`,
        [workspaceId],
      )
      const doc = (key: string) => docs.rows.find((d) => d.key === key)?.data
      const company = doc('company')
      if (!isPlainObject(company)) return null
      let bytes = docs.rows.reduce((n, d) => n + Number(d.size), 0)
      const out: Record<string, unknown> = { schemaVersion: 1 }
      for (const c of RECORD_COLLECTIONS) out[c] = []
      for (const k of DOC_KEYS) out[k] = {}
      out.meta = isPlainObject(doc('meta')) ? doc('meta') : {}
      out.settings = isPlainObject(doc('settings')) ? doc('settings') : {}
      // The fields the pages print as text, as text: a name or tagline of another type would break them.
      out.company = {
        ...company,
        name: str(company.name) && company.name.trim() ? company.name : fallbackName,
        tagline: str(company.tagline) ? company.tagline : '',
        hq: isPlainObject(company.hq) ? company.hq : {},
        stage: str(company.stage) ? company.stage : '',
        workweek: str(company.workweek) ? company.workweek : '',
        foundedOn: str(company.foundedOn) ? company.foundedOn : '',
      }
      const add = (collection: RecordCollection, part: { rows: unknown[]; bytes: number }) => {
        out[collection] = part.rows
        bytes += part.bytes
      }

      // The jobs the page lists (isPublicJob in src/careers/render.ts decides again, on the same rule).
      const jobs = await budgeted(q, 'jobs', workspaceId, {
        where: `data->>'status' = 'open' AND coalesce(data->>'postedOn', '') <> '' AND data->>'postedOn' <= $2 AND coalesce(data#>>'{requisition,status}', '') <> 'pending'`,
        params: [date],
        budget: LOAD_BUDGET.jobs,
        limit: MAX_LISTED_JOBS,
      })
      add('jobs', jobs)
      const listed = jobs.rows as Array<{ departmentId: string; locationIds: string[]; familyId?: string | null; levelId?: string | null }>
      const departmentIds = [...new Set(listed.map((j) => j.departmentId))]
      const locationIds = [...new Set(listed.flatMap((j) => j.locationIds))]
      const pairs = new Set(listed.map((j) => `${j.familyId ?? ''}|${j.levelId ?? ''}`))
      const families = [...new Set(listed.map((j) => j.familyId).filter(str))]
      const levels = [...new Set(listed.map((j) => j.levelId).filter(str))]

      // Only what those jobs name.
      add('departments', await budgeted(q, 'departments', workspaceId, { where: 'id = ANY($2::text[])', params: [departmentIds], budget: LOAD_BUDGET.departments, limit: MAX_ROWS }))
      add('locations', await budgeted(q, 'locations', workspaceId, { where: 'id = ANY($2::text[])', params: [locationIds], budget: LOAD_BUDGET.locations, limit: MAX_ROWS }))
      const bands = await budgeted(q, 'bands', workspaceId, {
        where: `data->>'familyId' = ANY($2::text[]) AND data->>'levelId' = ANY($3::text[])`,
        params: [families, levels],
        budget: LOAD_BUDGET.bands,
        limit: MAX_ROWS,
      })
      add('bands', {
        rows: bands.rows.filter((b) => isPlainObject(b) && pairs.has(`${b.familyId ?? ''}|${b.levelId ?? ''}`)),
        bytes: bands.bytes,
      })
      // The benefits line: the vacation policy, and how many holidays a year (their dates only).
      add('timeOffPolicies', await budgeted(q, 'timeOffPolicies', workspaceId, { budget: LOAD_BUDGET.timeOffPolicies, limit: MAX_ROWS }))
      add(
        'holidays',
        await budgeted(q, 'holidays', workspaceId, {
          select: `jsonb_build_object('id', id, 'date', data->'date', 'name', '')`,
          budget: LOAD_BUDGET.holidays,
          limit: MAX_ROWS,
        }),
      )
      return { db: out as unknown as DB, bytes }
    },
    { isolation: 'repeatable read', readOnly: true },
  )
}

/**
 * The people an application's next step needs (src/careers/application.ts): the job's hiring manager and
 * the founders, as start and end dates and the founder flag only.
 */
export async function applicationPeople(db: Queryable, workspaceId: string, hiringManagerId: string | null | undefined): Promise<Person[]> {
  const r = await db.query<{ data: unknown }>(
    `SELECT jsonb_strip_nulls(jsonb_build_object('id', id, 'startDate', data->'startDate', 'endDate', data->'endDate', 'isFounder', data->'isFounder')) AS data
       FROM people
      WHERE workspace_id = $1 AND (id = $2 OR data->'isFounder' = 'true'::jsonb)
      ORDER BY pos, id
      LIMIT 50`,
    [workspaceId, hiringManagerId ?? ''],
  )
  return r.rows.map((row) => row.data).filter((p) => isPlainObject(p) && str(p.startDate) && strOrMissing(p.endDate)) as unknown as Person[]
}

/** True when a candidate with this email (any case) already has an application for this job. */
export async function alreadyApplied(db: Queryable, workspaceId: string, jobId: string, email: string): Promise<boolean> {
  const r = await db.query<{ found: boolean }>(
    `SELECT EXISTS (
        SELECT 1 FROM applications a
          JOIN candidates c ON c.workspace_id = a.workspace_id AND c.id = a.data->>'candidateId'
         WHERE a.workspace_id = $1 AND a.data->>'jobId' = $2 AND lower(c.data->>'email') = lower($3)
      ) AS found`,
    [workspaceId, jobId, email],
  )
  return r.rows[0]?.found === true
}
