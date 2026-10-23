// Migration 004 (companies) applied to a database that already has 001-003 and the data a live server
// holds: the owner's workspace with records, its admin, a session and a trusted device. Everything keeps
// working afterwards, under the same logins, and the slugs it backfills follow the same rules as
// sign-up (workspaces.ts slugBase and pickSlug).
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, describe, expect, it } from 'vitest'
import { hashToken } from './auth'
import { type Db, fromPGlite } from './db'
import { migrate, migrationFiles, migrationsDir } from './migrate'
import { snapshot } from './repo'
import { ADMIN, createAdmin, CSRF, login, makeApp } from './test/helpers'
import { pickSlug, RESERVED_SLUGS, slugBase } from './workspaces'

const PRE_004 = ['001_init.sql', '002_history_and_seq_versions.sql', '003_trusted_devices.sql']

const opened: PGlite[] = []
afterEach(async () => {
  for (const pg of opened.splice(0)) if (!pg.closed) await pg.close()
})

/** A database at 003, as every live server was before 004. */
async function databaseAt003(): Promise<{ pg: PGlite; db: Db }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'ft-pre004-'))
  for (const f of PRE_004) copyFileSync(path.join(migrationsDir(), f), path.join(dir, f))
  const pg = await PGlite.create()
  opened.push(pg)
  const db = fromPGlite(pg as unknown as Parameters<typeof fromPGlite>[0])
  expect((await migrate(db, { dir })).applied).toEqual(PRE_004)
  return { pg, db }
}

describe('migration 004 on a live database', () => {
  it('lists 004 after 003', () => {
    expect(migrationFiles().slice(0, 4)).toEqual([...PRE_004, '004_multitenant.sql'])
  })

  it("keeps the owner's workspace, logins, sessions and data, and gives the workspace a kept slug", async () => {
    const { db } = await databaseAt003()
    // What a live server holds: an admin (created as 003's create-admin did, without a workspace), a
    // session and a trusted device, an uploaded workspace with a record and its change log.
    const admin = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ('owner@example.com', 'scrypt$x') RETURNING id::text AS id`,
    )
    const userId = admin.rows[0].id
    await db.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [hashToken('session-token'), userId])
    await db.query(`INSERT INTO trusted_devices (token_hash, user_id, expires_at) VALUES ('device', $1, now() + interval '180 days')`, [userId])
    await db.query(`UPDATE workspaces SET initialized_at = now(), last_seq = 2 WHERE id = 'default'`)
    await db.query(`INSERT INTO workspace_docs (workspace_id, key, data, version) VALUES ('default', 'company', '{"name": "Ledgerlark, Inc."}', 1)`)
    await db.query(`INSERT INTO people (workspace_id, id, data, version) VALUES ('default', 'p-1', '{"id": "p-1", "firstName": "Ada"}', 2)`)
    await db.query(`INSERT INTO change_log (workspace_id, collection, record_id, op, version, data) VALUES ('default', 'people', 'p-1', 'upsert', 2, '{"id": "p-1"}')`)
    const historyBefore = (await db.query<{ h: string }>(`SELECT history_id::text AS h FROM workspaces`)).rows[0].h

    // 005 and 006 come with it (they reach a live server in one update); migrate005.test.ts covers 005 on its own.
    expect((await migrate(db)).applied).toEqual(['004_multitenant.sql', '005_demo_hardening.sql', '006_assistant.sql'])

    const ws = await db.query<Record<string, unknown>>(
      `SELECT id, slug, keep, created_by, last_active_at IS NOT NULL AS active, history_id::text AS history_id, last_seq FROM workspaces`,
    )
    expect(ws.rows).toEqual([
      { id: 'default', slug: 'ledgerlark-inc', keep: true, created_by: null, active: true, history_id: historyBefore, last_seq: expect.anything() },
    ])
    expect((await db.query(`SELECT email, workspace_id FROM users`)).rows).toEqual([{ email: 'owner@example.com', workspace_id: 'default' }])
    expect((await db.query('SELECT 1 FROM sessions')).rows).toHaveLength(1)
    expect((await db.query('SELECT 1 FROM trusted_devices')).rows).toHaveLength(1)
    expect((await db.query('SELECT 1 FROM change_log')).rows).toHaveLength(1)
    expect((await snapshot(db, 'default'))?.db.people).toEqual([{ id: 'p-1', firstName: 'Ada' }])
    expect((await db.query('SELECT 1 FROM invites')).rows).toEqual([])
  })

  it('lets the owner keep signing in and syncing after it, with the same browser data', async () => {
    const { db } = await databaseAt003()
    // create-admin as 003 ran it: no workspace column yet.
    await db.query(`INSERT INTO users (email, password_hash) VALUES ('placeholder@example.com', 'x')`)
    await migrate(db)
    await db.query(`DELETE FROM users`)
    await createAdmin(db)
    const app = await makeApp(db)
    try {
      const headers = { ...CSRF, cookie: await login(app) }
      const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers })
      expect(me.json()).toMatchObject({ user: { email: ADMIN.email }, workspace: { id: 'default', slug: 'default-workspace' } })
      const status = await app.inject({ method: 'GET', url: '/api/workspace/status', headers })
      expect(status.json()).toEqual({ empty: true })
    } finally {
      await app.close()
    }
  })

  it('backfills slugs with the sign-up rules: oldest first, -2 when taken, reserved and short names avoided', async () => {
    const { db } = await databaseAt003()
    const names: Array<[id: string, name: string | null, companyDoc?: string]> = [
      ['w-a', 'Workspace A', 'Acme Robotics'],
      ['w-b', 'Acme Robotics'],
      ['w-c', 'Assets'],
      ['w-d', 'X'],
      ['w-e', null],
      ['w-f', 'An extremely long company name that keeps going and going past forty'],
      ['w-g', 'An extremely long company name that keeps going and going past forty, again'],
      ['w-h', '  --Spaced   out, punctuated!! Co.--  '],
      ['w-i', 'Company'],
    ]
    let minute = 0
    for (const [id, name, doc] of names) {
      minute += 1
      await db.query(`INSERT INTO workspaces (id, name, created_at) VALUES ($1, $2, now() - make_interval(mins => 100 - $3::int))`, [id, name, minute])
      if (doc) await db.query(`INSERT INTO workspace_docs (workspace_id, key, data, version) VALUES ($1, 'company', $2::jsonb, 1)`, [id, JSON.stringify({ name: doc })])
    }
    await migrate(db)

    // The same names through the TypeScript rules, in the same order ('default' was created first, by 001).
    const taken = new Set<string>()
    const expected: Record<string, string> = {}
    for (const [id, name] of [['default', 'Default workspace'], ...names.map(([id, name, doc]) => [id, doc ?? name ?? ''])] as Array<[string, string]>) {
      expected[id] = pickSlug(slugBase(name), taken)
      taken.add(expected[id])
    }
    const rows = await db.query<{ id: string; slug: string }>('SELECT id, slug FROM workspaces')
    expect(Object.fromEntries(rows.rows.map((r) => [r.id, r.slug]))).toEqual(expected)
    expect(expected).toMatchObject({
      'w-a': 'acme-robotics',
      'w-b': 'acme-robotics-2',
      'w-c': 'assets-2',
      'w-d': 'company',
      'w-e': 'company-2',
      'w-h': 'spaced-out-punctuated-co',
      'w-i': 'company-3',
    })
    expect(expected['w-f']).toHaveLength(40)
    // The same 40-character base as w-f, shortened to fit its -2.
    expect(expected['w-f']).toBe('an-extremely-long-company-name-that-keep')
    expect(expected['w-g']).toBe('an-extremely-long-company-name-that-ke-2')
    // Every workspace that existed is kept.
    expect((await db.query('SELECT 1 FROM workspaces WHERE NOT keep')).rows).toEqual([])
  })

  it('enforces the slug rules and a workspace for every login from then on', async () => {
    const { db } = await databaseAt003()
    await migrate(db)
    const insert = (id: string, slug: string | null) => db.query(`INSERT INTO workspaces (id, name, slug) VALUES ($1, 'x', $2)`, [id, slug])
    await expect(insert('w1', null)).rejects.toThrow(/null value/)
    for (const bad of ['ab', 'Upper', '-lead', 'trail-', 'sp ace', 'x'.repeat(41), 'dot.ted']) await expect(insert('w1', bad), bad).rejects.toThrow(/check/i)
    await insert('w1', 'good-slug-1')
    await expect(insert('w2', 'good-slug-1')).rejects.toThrow(/unique|duplicate/i)
    await expect(db.query(`INSERT INTO users (email, password_hash) VALUES ('nobody@example.com', 'x')`)).rejects.toThrow(/null value/)
    // A workspace's logins and invites go with it.
    const u = await db.query<{ id: string }>(`INSERT INTO users (email, password_hash, workspace_id) VALUES ('a@example.com', 'x', 'w1') RETURNING id::text AS id`)
    await db.query(`INSERT INTO invites (token_hash, workspace_id, created_by, expires_at) VALUES ('t', 'w1', $1, now() + interval '7 days')`, [u.rows[0].id])
    await db.query(`DELETE FROM workspaces WHERE id = 'w1'`)
    expect((await db.query(`SELECT 1 FROM users WHERE email = 'a@example.com'`)).rows).toEqual([])
    expect((await db.query('SELECT 1 FROM invites')).rows).toEqual([])
  })

  it('reserves the same slugs as workspaces.ts', () => {
    const sql = readFileSync(path.join(migrationsDir(), '004_multitenant.sql'), 'utf8')
    const list = /reserved text\[\] := ARRAY\[([^\]]*)\]/.exec(sql)?.[1]
    expect(list).toBeDefined()
    expect(list!.split(',').map((s) => s.trim().replace(/^'|'$/g, ''))).toEqual([...RESERVED_SLUGS])
  })
})
