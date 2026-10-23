// The running server connects as a role that may only read and write rows (server/deploy/
// postgres-setup.sql): SELECT, INSERT, UPDATE, DELETE on the tables and USAGE, SELECT on sequences, while
// another role owns the schema and runs migrations and after-restore. Every request path must work with
// those rights alone, including taking each workspace's next seq as a version (migration 005: a counter
// in workspaces.last_seq, no sequence).
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import { recordTokens, releaseMessage, remainingToday, reserveMessage } from './assistant/quota'
import { upsertAdmin } from './auth'
import { type Db, fromPGlite } from './db'
import { migrate } from './migrate'
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
    GRANT USAGE, CREATE ON SCHEMA public TO ft_owner;
    GRANT USAGE ON SCHEMA public TO ft_app;
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
