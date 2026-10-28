// Repository edge cases the HTTP tests do not reach easily: truncated pulls and version history.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import type { Db } from './db'
import { applyChanges, changesSince, replaceWorkspace, snapshot } from './repo'
import { makeTestDb, resetDb } from './test/helpers'
import { parseChanges, parseWorkspace } from './validate'

let db: Db
beforeAll(async () => {
  db = await makeTestDb()
})
afterAll(async () => {
  await db.close()
})
beforeEach(async () => {
  await resetDb(db)
})

const workspace0 = () => blankDB({ companyName: 'Repoco', founderFirstName: 'R', founderLastName: 'Po', foundedOn: '2026-01-05' })
const workspace = () => parseWorkspace({ db: workspace0() })
const job = (id: string) => ({ collection: 'jobs', id, op: 'upsert', data: { id, title: `Job ${id}` }, baseVersion: null })

describe('repo', () => {
  it('returns null before the first upload', async () => {
    expect(await snapshot(db)).toBeNull()
  })

  it('pages pulls: more is set and seq is the last change returned', async () => {
    const { seq } = await replaceWorkspace(db, workspace(), null)
    await applyChanges(db, parseChanges({ changes: [job('j-1'), job('j-2'), job('j-3'), job('j-4'), job('j-5')] }), null)
    const page1 = await changesSince(db, seq, { limit: 2 })
    expect(page1).toMatchObject({ more: true, seq: seq + 2 })
    if ('resync' in page1) throw new Error('unexpected resync')
    expect(page1.changes.map((c) => c.id)).toEqual(['j-1', 'j-2'])
    const page2 = await changesSince(db, page1.seq, { limit: 2 })
    if ('resync' in page2) throw new Error('unexpected resync')
    expect(page2.changes.map((c) => c.id)).toEqual(['j-3', 'j-4'])
    const page3 = await changesSince(db, page2.seq, { limit: 2 })
    expect(page3).toEqual({ historyId: expect.any(String), seq: seq + 5, changes: [expect.objectContaining({ id: 'j-5' })] })
  })

  it('replaces only the copy the caller read when it says which (expected), else 409 changed_meanwhile', async () => {
    const replaceAll = () => parseWorkspace({ db: workspace0(), confirmReplace: true })
    const first = await replaceWorkspace(db, workspace(), null)
    const read = { historyId: first.historyId, seq: first.seq }
    await applyChanges(db, parseChanges({ changes: [job('j-1')] }), null)
    await expect(replaceWorkspace(db, replaceAll(), null, undefined, { expected: read })).rejects.toMatchObject({ statusCode: 409, code: 'changed_meanwhile' })
    expect((await snapshot(db))?.db.jobs).toHaveLength(1)
    const now = await snapshot(db)
    const again = await replaceWorkspace(db, replaceAll(), null, undefined, { expected: { historyId: now?.historyId as string, seq: now?.seq as number } })
    // Another history: what was read before it no longer matches either.
    await expect(replaceWorkspace(db, replaceAll(), null, undefined, { expected: { historyId: now?.historyId as string, seq: again.seq } })).rejects.toMatchObject({ code: 'changed_meanwhile' })
  })

  it('keeps versions growing across delete and re-create, so echoes are recognizable', async () => {
    await replaceWorkspace(db, workspace(), null)
    const a = await applyChanges(db, parseChanges({ changes: [job('j-1')] }), null)
    // A version is the seq of the write that produced it.
    expect(a.applied[0].version).toBe(a.seq)
    const d = await applyChanges(db, parseChanges({ changes: [{ collection: 'jobs', id: 'j-1', op: 'delete', baseVersion: a.seq }] }), null)
    expect(d.applied[0].version).toBe(d.seq)
    expect(d.applied[0].version).toBeGreaterThan(a.applied[0].version)
    const again = await applyChanges(db, parseChanges({ changes: [job('j-1')] }), null)
    expect(again.applied[0].version).toBeGreaterThan(d.applied[0].version)
  })

  it('applies a batch change by change: accepted ones commit, rejected ones become conflicts', async () => {
    await replaceWorkspace(db, workspace(), null)
    const r = await applyChanges(
      db,
      parseChanges({
        changes: [job('j-1'), { collection: 'people', id: 'p-founder', op: 'delete', baseVersion: 0 }, job('j-2')],
      }),
      null,
    )
    expect(r.applied.map((x) => x.id)).toEqual(['j-1', 'j-2'])
    expect(r.conflicts).toEqual([expect.objectContaining({ id: 'p-founder', serverVersion: expect.any(Number) })])
    const snap = await snapshot(db)
    expect(snap?.db.jobs).toEqual([
      { id: 'j-1', title: 'Job j-1' },
      { id: 'j-2', title: 'Job j-2' },
    ])
  })

  it('never repeats a version across a full replace, so a stale baseVersion cannot match a newer write', async () => {
    const first = await replaceWorkspace(db, workspace(), null)
    const before = first.versions['people:p-founder']
    const replaced = await replaceWorkspace(db, parseWorkspace({ db: workspace0(), confirmReplace: true }), null)
    const after = replaced.versions['people:p-founder']
    expect(after).toBeGreaterThan(first.seq)
    // Every version in the new workspace is unique and newer than anything from before the replace.
    const values = Object.values(replaced.versions)
    expect(new Set(values).size).toBe(values.length)
    expect(Math.min(...values)).toBeGreaterThan(first.seq)
    expect(Math.max(...values)).toBe(replaced.seq)
    expect(replaced.historyId).not.toBe(first.historyId)
    // An edit based on the old version is a conflict, not an overwrite.
    const stale = await applyChanges(
      db,
      parseChanges({ changes: [{ collection: 'people', id: 'p-founder', op: 'delete', baseVersion: before }] }),
      null,
    )
    expect(stale.applied).toEqual([])
    expect(stale.conflicts).toEqual([expect.objectContaining({ id: 'p-founder', serverVersion: after })])
  })

  it('forgets earlier copies of a deleted record, keeping only the delete', async () => {
    const { seq } = await replaceWorkspace(db, workspace(), null)
    const salary = { collection: 'jobs', id: 'j-pay', op: 'upsert', data: { id: 'j-pay', title: 'Pay', salary: 187_654 }, baseVersion: null }
    const created = await applyChanges(db, parseChanges({ changes: [salary] }), null)
    const v1 = created.applied[0].version
    const edited = await applyChanges(db, parseChanges({ changes: [{ ...salary, data: { id: 'j-pay', title: 'Pay', salary: 191_357 }, baseVersion: v1 }] }), null)
    const v2 = edited.applied[0].version
    const deleted = await applyChanges(db, parseChanges({ changes: [{ collection: 'jobs', id: 'j-pay', op: 'delete', baseVersion: v2 }] }), null)
    const rows = await db.query<{ op: string; version: unknown; data: unknown }>(`SELECT op, version, data FROM change_log WHERE record_id = 'j-pay' ORDER BY seq`)
    expect(rows.rows).toEqual([{ op: 'delete', version: expect.anything(), data: null }])
    expect(Number(rows.rows[0].version)).toBe(deleted.applied[0].version)
    expect((await db.query(`SELECT 1 FROM change_log WHERE data::text LIKE '%187654%' OR data::text LIKE '%191357%'`)).rows).toHaveLength(0)
    // A pull from before the deletes gets the delete; re-creating (as new, the way a client that saw the
    // delete sends it) still gets a newer version.
    const pull = await changesSince(db, seq)
    if ('resync' in pull) throw new Error('unexpected resync')
    expect(pull.changes.filter((c) => c.id === 'j-pay')).toEqual([expect.objectContaining({ op: 'delete', version: deleted.applied[0].version })])
    const back = await applyChanges(db, parseChanges({ changes: [{ ...salary, baseVersion: null }] }), null)
    expect(back.applied[0].version).toBeGreaterThan(deleted.applied[0].version)
  })

  describe('a record another device deleted (r2-44)', () => {
    let deviceOne: string
    let deviceTwo: string
    beforeEach(async () => {
      // Two logins, so the flags can tell who wrote what.
      const users = await db.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, workspace_id) VALUES ('one@example.test', 'x', 'default'), ('two@example.test', 'x', 'default') RETURNING id::text AS id`,
      )
      ;[deviceOne, deviceTwo] = users.rows.map((r) => r.id)
    })
    const dept = (name: string, baseVersion: number | null) => ({ collection: 'departments', id: 'd-ops', op: 'upsert', data: { id: 'd-ops', name }, baseVersion })

    it('refuses a stale edit that would bring it back: a conflict with nothing on the server', async () => {
      const up = await replaceWorkspace(db, workspace(), deviceOne)
      const v = up.versions['departments:d-ops']
      const gone = await applyChanges(db, parseChanges({ changes: [{ collection: 'departments', id: 'd-ops', op: 'delete', baseVersion: v }] }), deviceOne)
      // Device two edited it on the copy from before the delete.
      const stale = await applyChanges(db, parseChanges({ changes: [dept('Finance and ops', v)] }), deviceTwo)
      expect(stale.applied).toEqual([])
      expect(stale.conflicts).toEqual([{ collection: 'departments', id: 'd-ops', serverVersion: null, serverData: null }])
      expect(stale.seq).toBe(gone.seq)
      expect((await snapshot(db))?.versions['departments:d-ops']).toBeUndefined()
      // The same user's stale edit says the delete was theirs.
      const mine = await applyChanges(db, parseChanges({ changes: [dept('Finance and ops', v)] }), deviceOne)
      expect(mine.conflicts).toEqual([{ collection: 'departments', id: 'd-ops', serverVersion: null, serverData: null, byYou: true }])
    })

    it('accepts a re-create from a client that believes it is new or saw the delete', async () => {
      const up = await replaceWorkspace(db, workspace(), deviceOne)
      const v = up.versions['departments:d-ops']
      const gone = await applyChanges(db, parseChanges({ changes: [{ collection: 'departments', id: 'd-ops', op: 'delete', baseVersion: v }] }), deviceOne)
      // Undo of one's own delete: the client dropped the version after the delete, so it sends no base.
      const fresh = await applyChanges(db, parseChanges({ changes: [dept('Back again', null)] }), deviceOne)
      expect(fresh.applied).toEqual([{ collection: 'departments', id: 'd-ops', version: fresh.seq }])
      const removed = await applyChanges(db, parseChanges({ changes: [{ collection: 'departments', id: 'd-ops', op: 'delete', baseVersion: fresh.seq }] }), deviceOne)
      // A base as new as the delete itself is a client that saw it.
      const sawIt = await applyChanges(db, parseChanges({ changes: [dept('Seen the delete', removed.applied[0].version)] }), deviceTwo)
      expect(sawIt.applied).toEqual([{ collection: 'departments', id: 'd-ops', version: sawIt.seq }])
      expect(sawIt.seq).toBeGreaterThan(gone.seq)
    })

    it('a missing document is still recreated whatever its base', async () => {
      await replaceWorkspace(db, workspace(), deviceOne)
      await db.query(`DELETE FROM workspace_docs WHERE key = 'inboxState'`)
      const res = await applyChanges(db, parseChanges({ changes: [{ collection: '$doc', id: 'inboxState', op: 'upsert', data: {}, baseVersion: 3 }] }), deviceTwo)
      expect(res.applied).toHaveLength(1)
    })
  })

  describe('flags for a client that lost answers (r2-45)', () => {
    let deviceOne: string
    let deviceTwo: string
    beforeEach(async () => {
      const users = await db.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, workspace_id) VALUES ('one@example.test', 'x', 'default'), ('two@example.test', 'x', 'default') RETURNING id::text AS id`,
      )
      ;[deviceOne, deviceTwo] = users.rows.map((r) => r.id)
    })
    const app = (stage: string, baseVersion: number | null) => ({ collection: 'applications', id: 'a-1', op: 'upsert', data: { id: 'a-1', stage }, baseVersion })

    it('marks a retry the server already holds as existing, and writes nothing', async () => {
      await replaceWorkspace(db, workspace(), deviceOne)
      const first = await applyChanges(db, parseChanges({ changes: [app('Technical', null)] }), deviceOne)
      const again = await applyChanges(db, parseChanges({ changes: [app('Technical', null)] }), deviceOne)
      expect(again.applied).toEqual([{ collection: 'applications', id: 'a-1', version: first.applied[0].version, existing: true }])
      expect(again.seq).toBe(first.seq)
      // A write that did happen carries no flag.
      expect(first.applied[0]).toEqual({ collection: 'applications', id: 'a-1', version: first.seq })
    })

    it('says who wrote the copy that won, and whether this very edit landed before it', async () => {
      await replaceWorkspace(db, workspace(), deviceOne)
      const v0 = (await applyChanges(db, parseChanges({ changes: [app('Applied', null)] }), deviceOne)).seq
      // Three moves land; the client hears none of the answers and retries the first.
      const v1 = (await applyChanges(db, parseChanges({ changes: [app('Technical', v0)] }), deviceOne)).seq
      const v2 = (await applyChanges(db, parseChanges({ changes: [app('Onsite', v1)] }), deviceOne)).seq
      const v3 = (await applyChanges(db, parseChanges({ changes: [app('Offer', v2)] }), deviceOne)).seq
      const retry = await applyChanges(db, parseChanges({ changes: [app('Technical', v0)] }), deviceOne)
      expect(retry.conflicts).toEqual([
        { collection: 'applications', id: 'a-1', serverVersion: v3, serverData: { id: 'a-1', stage: 'Offer' }, byYou: true, landed: true },
      ])
      // Another login sees the same copy, without byYou.
      const other = await applyChanges(db, parseChanges({ changes: [app('Technical', v0)] }), deviceTwo)
      expect(other.conflicts).toEqual([{ collection: 'applications', id: 'a-1', serverVersion: v3, serverData: { id: 'a-1', stage: 'Offer' }, landed: true }])
      // An edit that never reached the server did not land, and one from before the base does not count.
      const never = await applyChanges(db, parseChanges({ changes: [app('Rejected', v0)] }), deviceOne)
      expect(never.conflicts[0]).toEqual({ collection: 'applications', id: 'a-1', serverVersion: v3, serverData: { id: 'a-1', stage: 'Offer' }, byYou: true })
      const older = await applyChanges(db, parseChanges({ changes: [app('Technical', v1)] }), deviceOne)
      expect(older.conflicts[0].landed).toBeUndefined()
    })
  })

  it('removes the replaced workspace from the change log on a full replace', async () => {
    const first = await replaceWorkspace(db, workspace(), null)
    await applyChanges(db, parseChanges({ changes: [{ collection: 'jobs', id: 'j-old', op: 'upsert', data: { id: 'j-old', salary: 187_654 }, baseVersion: null }] }), null)
    const before = await db.query<{ last_seq: unknown }>('SELECT last_seq FROM workspaces')
    const replaced = await replaceWorkspace(db, parseWorkspace({ db: { ...workspace0(), people: [] }, confirmReplace: true }), null)
    const oldest = await db.query<{ seq: unknown }>('SELECT min(seq) AS seq FROM change_log')
    expect(Number(oldest.rows[0].seq)).toBeGreaterThan(Number(before.rows[0].last_seq))
    expect((await db.query(`SELECT 1 FROM change_log WHERE data::text LIKE '%187654%' OR record_id = 'j-old'`)).rows).toHaveLength(0)
    const ws = await db.query<{ pruned_seq: unknown; reset_seq: unknown }>('SELECT pruned_seq, reset_seq FROM workspaces')
    expect(Number(ws.rows[0].pruned_seq)).toBe(Number(before.rows[0].last_seq))
    expect(Number(ws.rows[0].reset_seq)).toBe(replaced.seq)
    expect(await changesSince(db, first.seq)).toEqual({ resync: true })
  })

  it('tells a client from another history to resync, and refuses its pushes', async () => {
    const first = await replaceWorkspace(db, workspace(), null)
    const ok = await changesSince(db, first.seq, { historyId: first.historyId })
    expect(ok).toEqual({ historyId: first.historyId, seq: first.seq, changes: [] })
    expect(await changesSince(db, first.seq, { historyId: '00000000-0000-4000-8000-000000000000' })).toEqual({ resync: true })
    await expect(
      applyChanges(db, parseChanges({ changes: [job('j-1')] }), null, { historyId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'resync' })
    expect((await db.query(`SELECT 1 FROM jobs WHERE id = 'j-1'`)).rows).toHaveLength(0)
    const pushed = await applyChanges(db, parseChanges({ changes: [job('j-1')] }), null, { historyId: first.historyId })
    expect(pushed.historyId).toBe(first.historyId)
    expect(pushed.applied).toHaveLength(1)
  })
})
