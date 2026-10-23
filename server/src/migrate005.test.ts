// Migration 005 (seqs per workspace, released slugs, careers switch, byte counts, invite handles) applied
// to a database at 004 that holds what a demo server would: the owner's kept workspace and a demo company,
// their records and change logs numbered by the old server-wide sequence, logins and an invite. Every
// number a browser already holds stays valid, and the next write in each company goes past it.
import { copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, describe, expect, it } from 'vitest'
import { type Db, fromPGlite } from './db'
import { migrate, migrationFiles, migrationsDir } from './migrate'
import { applyChanges, changesSince, snapshot } from './repo'
import { parseChanges } from './validate'

const TO_004 = ['001_init.sql', '002_history_and_seq_versions.sql', '003_trusted_devices.sql', '004_multitenant.sql']

const opened: PGlite[] = []
afterEach(async () => {
  for (const pg of opened.splice(0)) if (!pg.closed) await pg.close()
})

/** A database at 004 with two companies whose writes took turns on the server-wide sequence. */
async function databaseAt004(): Promise<Db> {
  const dir = mkdtempSync(path.join(tmpdir(), 'ft-pre005-'))
  for (const f of TO_004) copyFileSync(path.join(migrationsDir(), f), path.join(dir, f))
  const pg = await PGlite.create()
  opened.push(pg)
  const db = fromPGlite(pg as unknown as Parameters<typeof fromPGlite>[0])
  expect((await migrate(db, { dir })).applied).toEqual(TO_004)
  await db.query(`UPDATE workspaces SET initialized_at = now() WHERE id = 'default'`)
  await db.query(`INSERT INTO workspaces (id, name, slug, keep, initialized_at) VALUES ('w-demo', 'Demo', 'demo-k7m2qx', false, now())`)
  await db.query(`INSERT INTO users (email, password_hash, workspace_id) VALUES ('owner@example.com', 'x', 'default'), ('demo@example.com', 'x', 'w-demo')`)
  // Writes taking turns: the owner's p-1 (1), the demo's p-1 (2), the owner's company doc (3), the demo's j-1 (4).
  const write = async (ws: string, collection: string, id: string) => {
    const r = await db.query<{ seq: unknown }>(
      `INSERT INTO change_log (workspace_id, collection, record_id, op, version, data) VALUES ($1, $2, $3, 'upsert', 0, '{}') RETURNING seq`,
      [ws, collection, id],
    )
    const seq = Number(r.rows[0].seq)
    await db.query('UPDATE change_log SET version = $1, data = $2::jsonb WHERE seq = $1', [seq, JSON.stringify(collection === '$doc' ? { name: ws } : { id })])
    if (collection === '$doc') await db.query(`INSERT INTO workspace_docs (workspace_id, key, data, version) VALUES ($1, $2, $3::jsonb, $4)`, [ws, id, JSON.stringify({ name: ws }), seq])
    else await db.query(`INSERT INTO ${collection === 'jobs' ? 'jobs' : 'people'} (workspace_id, id, data, version) VALUES ($1, $2, $3::jsonb, $4)`, [ws, id, JSON.stringify({ id }), seq])
    return seq
  }
  await write('default', 'people', 'p-1')
  await write('w-demo', 'people', 'p-1')
  await write('default', '$doc', 'company')
  await write('w-demo', 'jobs', 'j-1')
  // last_seq as 004 kept it, except the owner's, left behind (it must still come out past every seq).
  await db.query(`UPDATE workspaces SET last_seq = 1 WHERE id = 'default'`)
  await db.query(`UPDATE workspaces SET last_seq = 4 WHERE id = 'w-demo'`)
  const owner = await db.query<{ id: string }>(`SELECT id::text AS id FROM users WHERE email = 'owner@example.com'`)
  await db.query(`INSERT INTO invites (token_hash, workspace_id, created_by, expires_at) VALUES ('t-1', 'default', $1, now() + interval '7 days')`, [owner.rows[0].id])
  return db
}

describe('migration 005 on a live database', () => {
  it('lists 005 after 004', () => {
    expect(migrationFiles().slice(0, 5)).toEqual([...TO_004, '005_demo_hardening.sql'])
  })

  it('keeps every seq and version, moves last_seq past them, and keys the change log by workspace', async () => {
    const db = await databaseAt004()
    expect((await migrate(db)).applied).toEqual(['005_demo_hardening.sql', '006_assistant.sql'])

    const ws = await db.query<{ id: string; last_seq: unknown }>('SELECT id, last_seq FROM workspaces ORDER BY id')
    expect(Object.fromEntries(ws.rows.map((r) => [r.id, Number(r.last_seq)]))).toEqual({ default: 3, 'w-demo': 4 })
    const owner = await snapshot(db, 'default')
    expect(owner?.versions).toEqual({ '$doc:company': 3, 'people:p-1': 1 })
    expect((await snapshot(db, 'w-demo'))?.versions).toEqual({ 'jobs:j-1': 4, 'people:p-1': 2 })

    // No sequence left; each company's seqs are its own, so the same number may appear in two companies,
    // never twice in one.
    expect(Number((await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM pg_class WHERE relkind = 'S'`)).rows[0].n)).toBe(0)
    const pk = await db.query<{ def: string }>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'change_log_pkey'`)
    expect(pk.rows).toEqual([{ def: 'PRIMARY KEY (workspace_id, seq)' }])
    await db.query(`INSERT INTO change_log (seq, workspace_id, collection, record_id, op, version) VALUES (99, 'default', 'jobs', 'x', 'delete', 99), (99, 'w-demo', 'jobs', 'x', 'delete', 99)`)
    await expect(db.query(`INSERT INTO change_log (seq, workspace_id, collection, record_id, op, version) VALUES (99, 'default', 'jobs', 'y', 'delete', 99)`)).rejects.toThrow(/duplicate|unique/i)
    await db.query('DELETE FROM change_log WHERE seq = 99')

    // The next write in each company goes past every number it handed out before, and pulls go on.
    const next = await applyChanges(db, parseChanges({ changes: [{ collection: 'jobs', id: 'j-o', op: 'upsert', data: { id: 'j-o' }, baseVersion: null }] }), null, {
      workspaceId: 'default',
    })
    expect(next.applied[0].version).toBe(4)
    expect(await changesSince(db, 3, { workspaceId: 'default', historyId: owner!.historyId })).toMatchObject({ changes: [{ id: 'j-o', seq: 4 }] })
    const demo = await applyChanges(db, parseChanges({ changes: [{ collection: 'jobs', id: 'j-d', op: 'upsert', data: { id: 'j-d' }, baseVersion: null }] }), null, {
      workspaceId: 'w-demo',
    })
    expect(demo.applied[0].version).toBe(5)
  })

  it('adds released slugs, the careers switch (on for demo companies only), byte counts and invite handles', async () => {
    const db = await databaseAt004()
    await migrate(db)
    const ws = await db.query<{ id: string; careers: boolean; bytes_used: unknown }>('SELECT id, careers, bytes_used FROM workspaces ORDER BY id')
    expect(ws.rows).toEqual([
      { id: 'default', careers: false, bytes_used: null },
      { id: 'w-demo', careers: true, bytes_used: null },
    ])
    await db.query(`INSERT INTO released_slugs (slug) VALUES ('gone-co-abc123')`)
    await expect(db.query(`INSERT INTO released_slugs (slug) VALUES ('gone-co-abc123')`)).rejects.toThrow(/duplicate|unique/i)
    await expect(db.query(`UPDATE workspaces SET bytes_used = -1 WHERE id = 'default'`)).rejects.toThrow(/check/i)
    const invites = await db.query<{ id: string; refused: number }>('SELECT id::text AS id, refused FROM invites')
    expect(invites.rows).toEqual([{ id: expect.stringMatching(/^[0-9a-f-]{36}$/), refused: 0 }])
    await expect(db.query(`INSERT INTO invites (token_hash, workspace_id, expires_at, id) VALUES ('t-2', 'default', now(), $1)`, [invites.rows[0].id])).rejects.toThrow(
      /duplicate|unique/i,
    )
  })
})
