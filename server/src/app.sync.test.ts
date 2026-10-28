// HTTP tests for the API server (docs/SYNC.md, Protocol), in-memory PGlite + app.inject(): the
// workspace (the full copy) and changes (pushes and pulls of single records).
import { beforeEach, describe, expect, it } from 'vitest'
import { buildSampleDB } from '@/data/seed'
import type { DB } from '@/domain/types'
import { RECORD_COLLECTIONS } from '../../src/sync/collections'
import { pruneChangeLog } from './repo'
import { app, authed, db, normalize, push, small, upload, useApp } from './test/api'
import { CSRF } from './test/helpers'

useApp()

describe('workspace', () => {
  it('needs a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/workspace' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/changes?since=0' })).statusCode).toBe(401)
    const put = await app.inject({ method: 'PUT', url: '/api/workspace', headers: CSRF, payload: { db: small() } })
    expect(put.statusCode).toBe(401)
    expect(put.json()).toEqual({ error: 'unauthorized', detail: expect.any(String) })
  })

  it('refuses anonymous requests before reading their bodies', async () => {
    const json = { ...CSRF, 'content-type': 'application/json' }
    // Invalid JSON would be a 400 if the body were parsed first.
    const invalid = await app.inject({ method: 'PUT', url: '/api/workspace', headers: json, payload: '{x' })
    expect(invalid.statusCode).toBe(401)
    const pushInvalid = await app.inject({ method: 'POST', url: '/api/changes', headers: json, payload: '{x' })
    expect(pushInvalid.statusCode).toBe(401)
    // Over the body limit would be a 413 if the body were read first.
    const huge = await app.inject({ method: 'POST', url: '/api/changes', headers: json, payload: '{"changes":"' + 'x'.repeat(2.5 * 1024 * 1024) + '"}' })
    expect(huge.statusCode).toBe(401)
    // An unknown cookie counts as anonymous too.
    const stale = await app.inject({ method: 'PUT', url: '/api/workspace', headers: { ...json, cookie: 'ft_session=not-a-session' }, payload: '{x' })
    expect(stale.statusCode).toBe(401)
  })

  it('says whether it is empty without a 404 (status), and needs a session for that too', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/workspace/status' })
    expect(anon.statusCode).toBe(401)
    expect(anon.json().error).toBe('unauthorized')
    const h = await authed()
    const empty = await app.inject({ method: 'GET', url: '/api/workspace/status', headers: h })
    expect(empty.statusCode).toBe(200)
    expect(empty.json()).toEqual({ empty: true })
    expect(empty.headers['cache-control']).toBe('no-store')
    const put = await upload(h)
    const full = await app.inject({ method: 'GET', url: '/api/workspace/status', headers: h })
    expect(full.statusCode).toBe(200)
    expect(full.json()).toEqual({ empty: false, workspaceId: 'default', historyId: put.json().historyId, seq: put.json().seq })
    // The seq follows pushes, like the snapshot's.
    const pushed = await push(h, [{ collection: 'jobs', id: 'j-status', op: 'upsert', data: { id: 'j-status' }, baseVersion: null }])
    const after = await app.inject({ method: 'GET', url: '/api/workspace/status', headers: h })
    expect(after.json().seq).toBe(pushed.json().seq)
    expect(after.json().seq).toBe((await app.inject({ method: 'GET', url: '/api/workspace', headers: h })).json().seq)
  })

  it('is empty (404) before the first upload', async () => {
    const h = await authed()
    const res = await app.inject({ method: 'GET', url: '/api/workspace', headers: h })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'empty' })
    const pull = await app.inject({ method: 'GET', url: '/api/changes?since=0', headers: h })
    expect(pull.json()).toEqual({ resync: true })
    const pushRes = await push(h, [{ collection: 'jobs', id: 'j-1', op: 'upsert', data: { id: 'j-1' }, baseVersion: null }])
    expect(pushRes.statusCode).toBe(404)
    expect(pushRes.json().error).toBe('empty')
  })

  it('accepts the first upload, then requires confirmReplace', async () => {
    const h = await authed()
    const data = small()
    const first = await upload(h, data)
    expect(first.statusCode).toBe(200)
    const body = first.json() as { seq: number; versions: Record<string, number> }
    expect(body.seq).toBeGreaterThan(0)
    // Each version is the seq of the record's log row: unique, and none above the returned seq.
    const values = Object.values(body.versions)
    expect(new Set(values).size).toBe(values.length)
    expect(values.every((v) => Number.isInteger(v) && v > 0 && v <= body.seq)).toBe(true)
    expect(body.versions['people:p-founder']).toEqual(expect.any(Number))
    expect(body.versions['$doc:company']).toEqual(expect.any(Number))
    expect(first.json().historyId).toMatch(/^[0-9a-f-]{36}$/)

    const again = await upload(h, data)
    expect(again.statusCode).toBe(409)
    expect(again.json().error).toBe('not_empty')

    const changed = { ...data, company: { ...data.company, name: 'Renamed' } }
    const replaced = await upload(h, changed, true)
    expect(replaced.statusCode).toBe(200)
    expect(replaced.json().seq).toBeGreaterThan(body.seq)
    expect(replaced.json().historyId).not.toBe(first.json().historyId)
    const snap = await app.inject({ method: 'GET', url: '/api/workspace', headers: h })
    expect(snap.json().db.company.name).toBe('Renamed')
  })

  it('round-trips the full Ledgerlark sample exactly', async () => {
    const h = await authed()
    const sample = buildSampleDB()
    const put = await upload(h, sample)
    expect(put.statusCode).toBe(200)
    const res = await app.inject({ method: 'GET', url: '/api/workspace', headers: h })
    expect(res.statusCode).toBe(200)
    const snap = res.json() as { workspaceId: string; seq: number; db: DB; versions: Record<string, number> }
    expect(snap.workspaceId).toBe('default')
    expect(snap.seq).toBe(put.json().seq)
    expect(snap.db).toEqual(normalize(sample))
    // Same arrays in the same order, collection by collection.
    for (const c of RECORD_COLLECTIONS) {
      expect(snap.db[c].map((r: { id: string }) => r.id)).toEqual(sample[c].map((r: { id: string }) => r.id))
    }
    const recordCount = RECORD_COLLECTIONS.reduce((n, c) => n + sample[c].length, 0)
    expect(Object.keys(snap.versions)).toHaveLength(recordCount + 6)
  })

  it('refuses unknown keys, duplicate ids and a wrong schema version', async () => {
    const h = await authed()
    const extra = await upload(h, { ...small(), salaries: [] } as unknown as DB)
    expect(extra.statusCode).toBe(400)
    expect(extra.json().error).toBe('bad_request')
    const data = small()
    const dupe = await upload(h, { ...data, people: [...data.people, ...data.people] })
    expect(dupe.statusCode).toBe(400)
    expect(dupe.json().detail).toContain('more than once')
    const v2 = await upload(h, { ...data, schemaVersion: 2 } as unknown as DB)
    expect(v2.statusCode).toBe(400)
  })

  it('enforces the 10 MB body limit on PUT and 2 MB elsewhere', async () => {
    const h = await authed()
    const huge = await app.inject({ method: 'PUT', url: '/api/workspace', headers: { ...h, 'content-type': 'application/json' }, payload: `{"db":"${'x'.repeat(10.5 * 1024 * 1024)}"}` })
    expect(huge.statusCode).toBe(413)
    expect(huge.json()).toEqual({ error: 'too_large' })
    const big = await app.inject({ method: 'POST', url: '/api/changes', headers: { ...h, 'content-type': 'application/json' }, payload: `{"changes":"${'x'.repeat(2.5 * 1024 * 1024)}"}` })
    expect(big.statusCode).toBe(413)
    // 3 MB is fine for the workspace upload (it fails validation, not the size check).
    const mid = await app.inject({ method: 'PUT', url: '/api/workspace', headers: { ...h, 'content-type': 'application/json' }, payload: `{"db":"${'x'.repeat(3 * 1024 * 1024)}"}` })
    expect(mid.statusCode).toBe(400)
  })
})

describe('changes', () => {
  let h: Record<string, string>
  let seq0: number
  let history0: string
  /** Versions right after the upload: founder and company. */
  let vFounder: number
  let vCompany: number
  const person = (id: string, extra: Record<string, unknown> = {}) => ({ ...small().people[0], id, firstName: 'New', lastName: 'Person', ...extra })

  beforeEach(async () => {
    h = await authed()
    const up = (await upload(h)).json()
    seq0 = up.seq
    history0 = up.historyId
    vFounder = up.versions['people:p-founder']
    vCompany = up.versions['$doc:company']
  })

  it('pulls nothing right after the upload', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/changes?since=${seq0}`, headers: h })
    expect(res.json()).toEqual({ historyId: history0, seq: seq0, changes: [] })
  })

  it('applies a new record and returns it from changes since', async () => {
    const res = await push(h, [{ collection: 'people', id: 'p-new', op: 'upsert', data: person('p-new'), baseVersion: null }])
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // The new version is the seq of the write.
    expect(body.applied).toEqual([{ collection: 'people', id: 'p-new', version: seq0 + 1 }])
    expect(body.conflicts).toEqual([])
    expect(body.seq).toBe(seq0 + 1)
    expect(body.historyId).toBe(history0)

    const pull = await app.inject({ method: 'GET', url: `/api/changes?since=${seq0}`, headers: h })
    expect(pull.json()).toEqual({
      historyId: history0,
      seq: seq0 + 1,
      changes: [{ seq: seq0 + 1, collection: 'people', id: 'p-new', op: 'upsert', version: seq0 + 1, data: normalize(person('p-new')) }],
    })
    // New records append to the end of the array.
    const snap = (await app.inject({ method: 'GET', url: '/api/workspace', headers: h })).json()
    expect(snap.db.people.at(-1).id).toBe('p-new')
    expect(snap.versions['people:p-new']).toBe(seq0 + 1)
    expect(snap.historyId).toBe(history0)
  })

  it('accepts an update whose baseVersion matches and bumps the version', async () => {
    const updated = { ...small().people[0], title: 'Chief everything officer' }
    const res = await push(h, [
      { collection: 'people', id: 'p-founder', op: 'upsert', data: updated, baseVersion: vFounder },
      { collection: '$doc', id: 'company', op: 'upsert', data: { ...small().company, name: 'Docco' }, baseVersion: vCompany },
    ])
    expect(res.json().applied).toEqual([
      { collection: 'people', id: 'p-founder', version: seq0 + 1 },
      { collection: '$doc', id: 'company', version: seq0 + 2 },
    ])
    const snap = (await app.inject({ method: 'GET', url: '/api/workspace', headers: h })).json()
    expect(snap.db.people[0].title).toBe('Chief everything officer')
    expect(snap.db.company.name).toBe('Docco')
    expect(snap.versions['people:p-founder']).toBe(seq0 + 1)
    expect(snap.versions['$doc:company']).toBe(seq0 + 2)
    const log = await db.query<{ user_id: string | null }>(`SELECT user_id FROM change_log WHERE record_id = 'p-founder' ORDER BY seq DESC LIMIT 1`)
    expect(log.rows[0].user_id).toEqual(expect.any(String))
  })

  it('returns the server copy on a stale baseVersion (the server wins)', async () => {
    const v2 = { ...small().people[0], title: 'Version two' }
    const vTwo = (await push(h, [{ collection: 'people', id: 'p-founder', op: 'upsert', data: v2, baseVersion: vFounder }])).json().applied[0].version
    const stale = { ...small().people[0], title: 'Stale edit' }
    const res = await push(h, [
      { collection: 'people', id: 'p-founder', op: 'upsert', data: stale, baseVersion: vFounder },
      { collection: 'people', id: 'p-founder', op: 'delete', baseVersion: vFounder },
    ])
    const body = res.json()
    expect(body.applied).toEqual([])
    // The admin wrote the copy that won (byYou); neither stale change is in the log (no landed).
    expect(body.conflicts).toEqual([
      { collection: 'people', id: 'p-founder', serverVersion: vTwo, serverData: normalize(v2), byYou: true },
      { collection: 'people', id: 'p-founder', serverVersion: vTwo, serverData: normalize(v2), byYou: true },
    ])
    // A create for an id the server already has is a conflict too.
    const dupe = await push(h, [{ collection: 'people', id: 'p-founder', op: 'upsert', data: stale, baseVersion: null }])
    expect(dupe.json().conflicts[0].serverVersion).toBe(vTwo)
    // A retried push whose data the server already holds counts as applied, marked existing.
    const retry = await push(h, [{ collection: 'people', id: 'p-founder', op: 'upsert', data: v2, baseVersion: vFounder }])
    expect(retry.json()).toMatchObject({ applied: [{ collection: 'people', id: 'p-founder', version: vTwo, existing: true }], conflicts: [] })
    // Once something newer is on top, retrying that write is a conflict that says it landed.
    const v3 = (await push(h, [{ collection: 'people', id: 'p-founder', op: 'upsert', data: { ...v2, title: 'Three' }, baseVersion: vTwo }])).json().applied[0].version
    const late = await push(h, [{ collection: 'people', id: 'p-founder', op: 'upsert', data: v2, baseVersion: vFounder }])
    expect(late.json().conflicts).toEqual([
      { collection: 'people', id: 'p-founder', serverVersion: v3, serverData: normalize({ ...v2, title: 'Three' }), byYou: true, landed: true },
    ])
    // Nothing was logged for the rejected or repeated changes: only the two real writes.
    const pull = await app.inject({ method: 'GET', url: `/api/changes?since=${seq0}`, headers: h })
    expect(pull.json().changes.map((c: { version: number }) => c.version)).toEqual([vTwo, v3])
  })

  it('deletes, then pulls the delete; a stale client edit cannot bring the record back, a re-create can', async () => {
    const res = await push(h, [{ collection: 'people', id: 'p-founder', op: 'delete', baseVersion: vFounder }])
    expect(res.json().applied).toEqual([{ collection: 'people', id: 'p-founder', version: seq0 + 1 }])
    const pull = await app.inject({ method: 'GET', url: `/api/changes?since=${seq0}`, headers: h })
    expect(pull.json().changes).toEqual([{ seq: seq0 + 1, collection: 'people', id: 'p-founder', op: 'delete', version: seq0 + 1 }])
    const snap = (await app.inject({ method: 'GET', url: '/api/workspace', headers: h })).json()
    expect(snap.db.people).toEqual([])
    expect(snap.versions['people:p-founder']).toBeUndefined()

    // Deleting again is a no-op that still succeeds.
    const again = await push(h, [{ collection: 'people', id: 'p-founder', op: 'delete', baseVersion: vFounder }])
    expect(again.json()).toMatchObject({ applied: [{ version: seq0 + 1 }], conflicts: [], seq: seq0 + 1 })

    // An edit made on the copy from before the delete loses to it: the server wins, as for any newer
    // change, and says the delete was this user's (r2-44).
    const stale = await push(h, [{ collection: 'people', id: 'p-founder', op: 'upsert', data: small().people[0], baseVersion: vFounder }])
    expect(stale.json()).toMatchObject({
      applied: [],
      conflicts: [{ collection: 'people', id: 'p-founder', serverVersion: null, serverData: null, byYou: true }],
      seq: seq0 + 1,
    })
    // A client that saw the delete re-creates it as new (Undo), with a newer version.
    const back = await push(h, [{ collection: 'people', id: 'p-founder', op: 'upsert', data: small().people[0], baseVersion: null }])
    expect(back.json().applied).toEqual([{ collection: 'people', id: 'p-founder', version: seq0 + 2 }])
  })

  it('reports a conflict with null for an edit to a record the server never had', async () => {
    const res = await push(h, [{ collection: 'jobs', id: 'j-ghost', op: 'upsert', data: { id: 'j-ghost', title: 'Ghost' }, baseVersion: 4 }])
    expect(res.json().conflicts).toEqual([{ collection: 'jobs', id: 'j-ghost', serverVersion: null, serverData: null }])
  })

  it('does not let an edit from before a full replace overwrite the imported copy or later edits', async () => {
    // A and B both know p-founder at vA. A goes offline and edits it; B imports with confirmReplace,
    // then edits the imported record.
    const vA = (await push(h, [{ collection: 'people', id: 'p-founder', op: 'upsert', data: person('p-founder', { title: 'Engineer' }), baseVersion: vFounder }])).json()
      .applied[0].version
    const imported = { ...small(), people: [person('p-founder', { title: 'Staff engineer (imported)' })] }
    const replaced = (await upload(h, imported, true)).json()
    const vImported = replaced.versions['people:p-founder']
    expect(vImported).not.toBe(vA)
    expect(vImported).not.toBe(vFounder)
    const vB = (
      await push(h, [{ collection: 'people', id: 'p-founder', op: 'upsert', data: person('p-founder', { title: 'Staff engineer (imported)', workEmail: 'p@example.test' }), baseVersion: vImported }])
    ).json().applied[0].version
    // A comes back and pushes before pulling: both of its stale versions are conflicts now.
    const fromA = await push(h, [
      { collection: 'people', id: 'p-founder', op: 'upsert', data: person('p-founder', { title: 'Senior engineer' }), baseVersion: vA },
      { collection: '$doc', id: 'company', op: 'upsert', data: { ...small().company, name: 'Old name' }, baseVersion: vCompany },
    ])
    expect(fromA.json().applied).toEqual([])
    expect(fromA.json().conflicts.map((c: { id: string; serverVersion: number }) => [c.id, c.serverVersion])).toEqual([
      ['p-founder', vB],
      ['company', replaced.versions['$doc:company']],
    ])
    const snap = (await app.inject({ method: 'GET', url: '/api/workspace', headers: h })).json()
    expect(snap.db.people[0]).toMatchObject({ title: 'Staff engineer (imported)', workEmail: 'p@example.test' })
    expect(snap.db.company.name).toBe(small().company.name)
  })

  it('checks the history id: pulls from another history resync, pushes from one are refused', async () => {
    const other = '00000000-0000-4000-8000-000000000000'
    const same = await app.inject({ method: 'GET', url: `/api/changes?since=${seq0}&history=${history0}`, headers: h })
    expect(same.json()).toEqual({ historyId: history0, seq: seq0, changes: [] })
    const foreign = await app.inject({ method: 'GET', url: `/api/changes?since=${seq0}&history=${other}`, headers: h })
    expect(foreign.json()).toEqual({ resync: true })
    const malformed = await app.inject({ method: 'GET', url: `/api/changes?since=${seq0}&history=nope`, headers: h })
    expect(malformed.statusCode).toBe(400)

    const change = { collection: 'people', id: 'p-h', op: 'upsert', data: person('p-h'), baseVersion: null }
    const refused = await app.inject({ method: 'POST', url: '/api/changes', headers: h, payload: { changes: [change], historyId: other } })
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toEqual({ error: 'resync', detail: expect.any(String) })
    expect((await db.query(`SELECT 1 FROM people WHERE id = 'p-h'`)).rows).toHaveLength(0)
    const accepted = await app.inject({ method: 'POST', url: '/api/changes', headers: h, payload: { changes: [change], historyId: history0 } })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json().historyId).toBe(history0)

    // A full replace starts a new history: the old id now means resync.
    const replaced = (await upload(h, small(), true)).json()
    expect(replaced.historyId).not.toBe(history0)
    const stale = await app.inject({ method: 'POST', url: '/api/changes', headers: h, payload: { changes: [], historyId: history0 } })
    expect(stale.statusCode).toBe(409)
  })

  it('accepts versions beyond 32 bits (they are change-log seqs)', async () => {
    const res = await push(h, [{ collection: 'jobs', id: 'j-big', op: 'upsert', data: { id: 'j-big' }, baseVersion: 2 ** 40 }])
    expect(res.statusCode).toBe(200)
    expect(res.json().conflicts).toEqual([{ collection: 'jobs', id: 'j-big', serverVersion: null, serverData: null }])
    const unsafe = await push(h, [{ collection: 'jobs', id: 'j-big', op: 'upsert', data: { id: 'j-big' }, baseVersion: 2 ** 53 }])
    expect(unsafe.statusCode).toBe(400)
  })

  it('rejects unknown collections and malformed changes with 400', async () => {
    const cases: unknown[][] = [
      [{ collection: 'salaries', id: 'x', op: 'upsert', data: { id: 'x' }, baseVersion: null }],
      [{ collection: 'people; DROP TABLE people', id: 'x', op: 'delete', baseVersion: null }],
      [{ collection: '$doc', id: 'secrets', op: 'upsert', data: {}, baseVersion: null }],
      [{ collection: '$doc', id: 'company', op: 'delete', baseVersion: 1 }],
      [{ collection: 'people', id: 'p-1', op: 'upsert', data: { id: 'p-2' }, baseVersion: null }],
      [{ collection: 'people', id: 'p-1', op: 'upsert', data: [1], baseVersion: null }],
      [{ collection: 'people', id: 'p-1', op: 'replace', data: { id: 'p-1' }, baseVersion: null }],
      [{ collection: 'people', id: 'p-1', op: 'upsert', data: { id: 'p-1' }, baseVersion: '1' }],
      [{ collection: 'people', id: '', op: 'delete', baseVersion: null }],
    ]
    for (const changes of cases) {
      const res = await push(h, changes)
      expect(res.statusCode, JSON.stringify(changes)).toBe(400)
      expect(res.json().error).toBe('bad_request')
    }
    const tooMany = await push(h, Array.from({ length: 2001 }, (_, i) => ({ collection: 'jobs', id: `j-${i}`, op: 'delete', baseVersion: null })))
    expect(tooMany.statusCode).toBe(400)
    const notList = await app.inject({ method: 'POST', url: '/api/changes', headers: h, payload: { changes: 'nope' } })
    expect(notList.statusCode).toBe(400)
    // A rejected request changes nothing.
    expect((await db.query('SELECT 1 FROM change_log WHERE seq > $1', [seq0])).rows).toHaveLength(0)
  })

  it('rejects a record over 256 KB with 400', async () => {
    const res = await push(h, [{ collection: 'people', id: 'p-big', op: 'upsert', data: person('p-big', { notes: 'x'.repeat(260 * 1024) }), baseVersion: null }])
    expect(res.statusCode).toBe(400)
    expect(res.json().detail).toContain('256 KB')
    const ok = await push(h, [{ collection: 'people', id: 'p-fits', op: 'upsert', data: person('p-fits', { notes: 'x'.repeat(200 * 1024) }), baseVersion: null }])
    expect(ok.statusCode).toBe(200)
  })

  it('rejects text the database cannot store with 400', async () => {
    const res = await push(h, [{ collection: 'jobs', id: 'j-nul', op: 'upsert', data: { id: 'j-nul', title: 'a\u0000b' }, baseVersion: null }])
    expect(res.statusCode).toBe(400)
    const fine = await push(h, [{ collection: 'jobs', id: 'j-slash', op: 'upsert', data: { id: 'j-slash', title: 'a\\u0000b' }, baseVersion: null }])
    expect(fine.statusCode).toBe(200)
  })

  it('tells very old or foreign clients to resync', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/changes?since=0', headers: h })).json()).toEqual({ resync: true })
    expect((await app.inject({ method: 'GET', url: `/api/changes?since=${seq0 + 50}`, headers: h })).json()).toEqual({ resync: true })
    expect((await app.inject({ method: 'GET', url: '/api/changes?since=abc', headers: h })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/changes', headers: h })).statusCode).toBe(400)

    // Pruned history: rows older than 120 days are removed and clients from before them resync.
    await push(h, [{ collection: 'people', id: 'p-a', op: 'upsert', data: person('p-a'), baseVersion: null }])
    const mid = seq0 + 1
    await push(h, [{ collection: 'people', id: 'p-b', op: 'upsert', data: person('p-b'), baseVersion: null }])
    await db.query(`UPDATE change_log SET at = now() - interval '200 days' WHERE seq <= $1`, [mid])
    expect(await pruneChangeLog(db, 120)).toBeGreaterThan(0)
    expect((await app.inject({ method: 'GET', url: `/api/changes?since=${seq0}`, headers: h })).json()).toEqual({ resync: true })
    const recent = (await app.inject({ method: 'GET', url: `/api/changes?since=${mid}`, headers: h })).json()
    expect(recent.changes.map((c: { id: string }) => c.id)).toEqual(['p-b'])
  })

  it('makes clients from before a full replace resync', async () => {
    await push(h, [{ collection: 'people', id: 'p-a', op: 'upsert', data: person('p-a'), baseVersion: null }])
    const seqBefore = seq0 + 1
    const replaced = await upload(h, small(), true)
    expect((await app.inject({ method: 'GET', url: `/api/changes?since=${seqBefore}`, headers: h })).json()).toEqual({ resync: true })
    expect((await app.inject({ method: 'GET', url: `/api/changes?since=${replaced.json().seq}`, headers: h })).json()).toEqual({
      historyId: replaced.json().historyId,
      seq: replaced.json().seq,
      changes: [],
    })
  })
})
