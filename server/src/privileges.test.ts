// The running server connects as a role that may only read and write rows (server/deploy/
// postgres-setup.sql): SELECT, INSERT, UPDATE, DELETE on the tables and USAGE, SELECT on sequences, while
// another role owns the schema and runs migrations and after-restore. Every request path must work with
// those rights alone, including taking each workspace's next seq as a version (migration 005: a counter
// in workspaces.last_seq, no sequence). The read model's views (migration 007) apply as that owner and read
// as the server's role and as a read-only login (server/deploy/viewer-role.sql), each only through what it
// may read in the tables.
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import { RECORD_COLLECTIONS, tableName } from '../../src/sync/collections'
import { recordTokens, releaseMessage, remainingToday, reserveMessage } from './assistant/quota'
import { upsertAdmin } from './auth'
import { type Db, fromPGlite } from './db'
import { migrate } from './migrate'
import { readModelViews } from './readmodel/generate'
import { afterRestore, applyChanges, changesSince, pruneChangeLog, replaceWorkspace, snapshot } from './repo'
import { parseChanges, parseWorkspace } from './validate'

let pg: PGlite
let db: Db

beforeAll(async () => {
  pg = await PGlite.create()
  db = fromPGlite(pg as unknown as Parameters<typeof fromPGlite>[0])
  await pg.exec(`
    CREATE ROLE ft_owner NOLOGIN;
    CREATE ROLE ft_app NOLOGIN;
    -- The read-only login exists before the migrations here, so 007's guarded grant gives it the views.
    CREATE ROLE first_twenty_viewer NOLOGIN;
    CREATE ROLE ft_views_only NOLOGIN;
    GRANT USAGE, CREATE ON SCHEMA public TO ft_owner;
    GRANT USAGE ON SCHEMA public TO ft_app, first_twenty_viewer, ft_views_only;
    ALTER DEFAULT PRIVILEGES FOR ROLE ft_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ft_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE ft_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ft_app;
    SET ROLE ft_owner;
  `)
  await migrate(db)
  await pg.exec('RESET ROLE; SET ROLE ft_app')
})
afterAll(async () => {
  await pg.close()
})

describe('the server role (rows only, no schema rights)', () => {
  it('can sign in, replace, push, pull, prune and read the snapshot', async () => {
    const admin = await upsertAdmin(db, 'admin@example.com', 'test-password-1234')
    const ws = blankDB({ companyName: 'Rightsco', founderFirstName: 'R', founderLastName: 'Ow', foundedOn: '2026-01-05' })
    const first = await replaceWorkspace(db, parseWorkspace({ db: ws }), admin.id)
    const pushed = await applyChanges(
      db,
      parseChanges({ changes: [{ collection: 'jobs', id: 'j-1', op: 'upsert', data: { id: 'j-1' }, baseVersion: null }] }),
      admin.id,
      { historyId: first.historyId },
    )
    expect(pushed.applied[0].version).toBe(pushed.seq)
    const deleted = await applyChanges(db, parseChanges({ changes: [{ collection: 'jobs', id: 'j-1', op: 'delete', baseVersion: pushed.seq }] }), admin.id)
    expect(deleted.applied).toHaveLength(1)
    expect(await changesSince(db, first.seq, { historyId: first.historyId })).toMatchObject({ seq: deleted.seq })
    await replaceWorkspace(db, parseWorkspace({ db: ws, confirmReplace: true }), admin.id)
    expect(await pruneChangeLog(db, 120)).toBe(0)
    expect((await snapshot(db))?.db.company).toMatchObject({ name: 'Rightsco' })
  })

  it("can count the assistant's daily messages and tokens (006)", async () => {
    const limits = { perWorkspace: 5, global: 10 }
    const now = new Date('2026-10-11T12:00:00Z')
    const r = await reserveMessage(db, 'default', limits, now)
    expect(r).toMatchObject({ ok: true, remaining: 4 })
    if (!r.ok) return
    await recordTokens(db, 'default', r.day, { input: 100, cacheWrite: 50, cacheRead: 4000, output: 20 })
    await releaseMessage(db, 'default', r.day)
    expect(await remainingToday(db, 'default', limits, now)).toBe(5)
  })

  it('keeps working on the new numbering after-restore gives every workspace (run as the owner, as documented)', async () => {
    // Seqs come from workspaces.last_seq since migration 005, so after-restore moves no sequence any more;
    // it still runs as the owner, through with-env.sh (docs/SERVER.md).
    expect(Number((await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM pg_class WHERE relkind = 'S'`)).rows[0].n)).toBe(0)
    await pg.exec('RESET ROLE; SET ROLE ft_owner')
    try {
      const restored = await afterRestore(db)
      expect(restored.seq).toBeGreaterThan(1_000_000_000)
    } finally {
      await pg.exec('RESET ROLE; SET ROLE ft_app')
    }
    // The server role keeps working on the new numbering.
    const ws = await snapshot(db)
    const next = await applyChanges(
      db,
      parseChanges({ changes: [{ collection: 'jobs', id: 'j-2', op: 'upsert', data: { id: 'j-2' }, baseVersion: null }] }),
      null,
      { historyId: ws?.historyId },
    )
    expect(next.seq).toBeGreaterThan(1_000_000_000)
  })
})

describe('the read model (007) under least privilege', () => {
  const views = readModelViews()
  const recordTables = RECORD_COLLECTIONS.map(tableName)

  async function as<T>(role: string, run: () => Promise<T>): Promise<T> {
    await pg.exec(`RESET ROLE; SET ROLE ${role}`)
    try {
      return await run()
    } finally {
      await pg.exec('RESET ROLE; SET ROLE ft_app')
    }
  }

  it('applied as the owner, who owns every view', async () => {
    const owners = await db.query<{ viewname: string; viewowner: string }>(`SELECT viewname, viewowner FROM pg_views WHERE schemaname = 'public'`)
    expect(owners.rows.map((r) => r.viewname).sort()).toEqual([...views].sort())
    expect(owners.rows.every((r) => r.viewowner === 'ft_owner')).toBe(true)
  })

  it("lets the server's role read every view through the default privileges, and never write through one", async () => {
    for (const view of views) await expect(db.query(`SELECT * FROM ${view} LIMIT 5`), view).resolves.toBeDefined()
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM v_people`)).rows[0].n).toBeGreaterThan(0)
    // The default privileges hand out write rights too; 007 takes them back, so a simple view cannot pass a write on.
    const writable = await db.query<{ view: string }>(
      `SELECT v AS view FROM unnest($1::text[]) AS v
        WHERE has_table_privilege('ft_app', v, 'INSERT') OR has_table_privilege('ft_app', v, 'UPDATE') OR has_table_privilege('ft_app', v, 'DELETE')`,
      [views],
    )
    expect(writable.rows).toEqual([])
    await expect(db.query('DELETE FROM v_people')).rejects.toThrow(/permission denied for view v_people/)
    await expect(db.query('UPDATE v_comp SET version = 1')).rejects.toThrow(/permission denied for view v_comp/)
  })

  it('gives the read-only login every view, which it reads only as far as its table rights go', async () => {
    const granted = await db.query<{ view: string; ok: boolean }>(
      `SELECT v AS view, has_table_privilege('first_twenty_viewer', v, 'SELECT') AS ok FROM unnest($1::text[]) AS v`,
      [views],
    )
    expect(granted.rows.filter((r) => !r.ok)).toEqual([])
    // With SELECT on the record tables only, the views over records read and the ones that also read a
    // workspace document (the company's pay runs, compliance owners) are refused: security_invoker at work.
    await pg.exec(`RESET ROLE; GRANT SELECT ON ${recordTables.join(', ')} TO first_twenty_viewer; SET ROLE ft_app`)
    await as('first_twenty_viewer', async () => {
      for (const view of ['v_people', 'v_comp', 'v_applications', 'v_current_job', 'v_pipeline_funnel', 'v_headcount_by_month', 'v_checklist_tasks']) {
        await expect(db.query(`SELECT * FROM ${view} LIMIT 5`), view).resolves.toBeDefined()
      }
      for (const view of ['v_pay_runs', 'v_hire_journey', 'v_integrity_problems']) {
        await expect(db.query(`SELECT * FROM ${view} LIMIT 5`), view).rejects.toThrow(/permission denied for table workspace_docs/)
      }
    })
    // With the documents too (viewer-role.sql grants every table but the four that hold credentials), all of them.
    await pg.exec('RESET ROLE; GRANT SELECT ON workspace_docs, workspaces TO first_twenty_viewer; SET ROLE ft_app')
    await as('first_twenty_viewer', async () => {
      for (const view of views) await expect(db.query(`SELECT * FROM ${view} LIMIT 5`), view).resolves.toBeDefined()
      await expect(db.query('SELECT * FROM users')).rejects.toThrow(/permission denied/)
    })
  })

  it('gets its privileges back from after-restore, after a restore made the views anew', async () => {
    // pg_restore --no-acl as the owner (docs/SERVER.md): the default privileges give the server's role write
    // rights on each new view, and the read-only login's grant from the dump is skipped.
    const list = views.join(', ')
    await pg.exec(`RESET ROLE; SET ROLE ft_owner; GRANT INSERT, UPDATE, DELETE ON ${list} TO ft_app; REVOKE SELECT ON ${list} FROM first_twenty_viewer`)
    const rights = async () =>
      (
        await db.query<{ view: string; writes: boolean; viewer: boolean }>(
          `SELECT v AS view, has_table_privilege('ft_app', v, 'INSERT') OR has_table_privilege('ft_app', v, 'DELETE') AS writes,
                  has_table_privilege('first_twenty_viewer', v, 'SELECT') AS viewer
             FROM unnest($1::text[]) AS v`,
          [views],
        )
      ).rows
    expect((await rights()).every((r) => r.writes && !r.viewer)).toBe(true)
    try {
      await afterRestore(db)
    } finally {
      await pg.exec('RESET ROLE; SET ROLE ft_app')
    }
    expect((await rights()).filter((r) => r.writes || !r.viewer)).toEqual([])
    await expect(db.query('SELECT count(*) FROM v_people')).resolves.toBeDefined()
  })

  it('refuses a login that may read a view but not the tables under it', async () => {
    await pg.exec('RESET ROLE; GRANT SELECT ON v_people TO ft_views_only; SET ROLE ft_app')
    await as('ft_views_only', async () => {
      await expect(db.query('SELECT * FROM v_people')).rejects.toThrow(/permission denied for table people/)
      await expect(db.query('SELECT * FROM v_comp')).rejects.toThrow(/permission denied for view v_comp/)
    })
  })
})
