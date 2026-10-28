// The test helpers themselves: saveRows puts back exactly the rows it saved, and nothing else changes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildSampleDB } from '../../../src/data/seed'
import type { Db } from '../db'
import { replaceWorkspace } from '../repo'
import { parseWorkspace } from '../validate'
import { createAdmin, makeTestDb, resetDb, saveRows } from './helpers'

let db: Db

beforeAll(async () => {
  db = await makeTestDb()
})
afterAll(async () => {
  await db.close()
})

/** Every row of every table, as JSON text, sorted within each table. */
async function everything(): Promise<Record<string, string[]>> {
  const tables = (await db.query<{ name: string }>(`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)).rows
  const out: Record<string, string[]> = {}
  for (const { name } of tables) {
    out[name] = (await db.query<{ row: string }>(`SELECT row_to_json(t)::text AS row FROM public."${name}" t`)).rows.map((r) => r.row).sort()
  }
  return out
}

describe('saveRows', () => {
  it('puts back exactly the rows it saved, as often as asked', async () => {
    await resetDb(db)
    await createAdmin(db)
    await db.query(`INSERT INTO workspaces (id, name, slug, keep) VALUES ('w-acme', 'Ledgerlark', 'acme', false)`)
    await replaceWorkspace(db, parseWorkspace({ db: structuredClone(buildSampleDB()) }), null, 'w-acme')
    const saved = await everything()
    expect(saved.change_log.length).toBeGreaterThan(100)
    const restore = await saveRows(db)
    for (let round = 0; round < 2; round++) {
      await db.query(`DELETE FROM users`)
      await db.query(`UPDATE workspaces SET name = 'Changed' WHERE id = 'w-acme'`)
      await db.query(`INSERT INTO workspaces (id, name, slug, keep) VALUES ('w-new', 'Newco', 'new-co', false)`)
      await db.query(`DELETE FROM change_log WHERE seq > 10`)
      expect(await everything()).not.toEqual(saved)
      await restore()
      expect(await everything()).toEqual(saved)
    }
  })

  it('leaves foreign keys checked after a restore', async () => {
    const restore = await saveRows(db)
    await restore()
    await expect(db.query(`INSERT INTO users (email, password_hash, role, workspace_id) VALUES ('x@example.com', 'x', 'admin', 'w-nowhere')`)).rejects.toThrow(
      /foreign key/,
    )
  })

  it('has no sequences to save: the schema keeps its counters in rows', async () => {
    // A sequence would keep counting across a restore, so a test could see other numbers than the one
    // before it. If a migration adds one, saveRows must save and set its value too.
    expect((await db.query(`SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'`)).rows).toEqual([])
  })
})
