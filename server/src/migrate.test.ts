import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RECORD_COLLECTIONS, tableName } from '../../src/sync/collections'
import type { Db } from './db'
import { migrate, migrationFiles, migrationsDir, pendingMigrations } from './migrate'
import { initSql, recordTableSql, tablesCreatedBy } from './sqlgen'
import { makeTestDb } from './test/helpers'

let db: Db
beforeAll(async () => {
  db = await makeTestDb()
})
afterAll(async () => {
  await db.close()
})

const RECORD_COLUMNS = ['workspace_id', 'id', 'data', 'version', 'pos', 'updated_at', 'updated_by']

describe('migrations', () => {
  it('finds numbered .sql files in server/sql', () => {
    const files = migrationFiles()
    expect(files[0]).toBe('001_init.sql')
    expect(files).toEqual([...files].sort())
  })

  it('create a table for every record collection (static check of the committed SQL)', () => {
    const dir = migrationsDir()
    const created = new Set(migrationFiles(dir).flatMap((f) => tablesCreatedBy(readFileSync(path.join(dir, f), 'utf8'))))
    const missing = RECORD_COLLECTIONS.map(tableName).filter((t) => !created.has(t))
    expect(missing, 'run "npm run server:gen-sql" and add the printed DDL as a new migration').toEqual([])
    for (const t of ['workspaces', 'workspace_docs', 'change_log', 'users', 'sessions']) expect(created.has(t)).toBe(true)
  })

  it('001_init.sql matches what the generator wrote for the original collections', () => {
    const committed = readFileSync(path.join(migrationsDir(), '001_init.sql'), 'utf8').replace(/\r\n/g, '\n')
    const originals = RECORD_COLLECTIONS.filter((c) => tablesCreatedBy(committed).includes(tableName(c)))
    expect(committed).toBe(initSql(originals))
  })

  it('leave every record table in the database with the agreed columns and primary key', async () => {
    const r = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
    )
    const byTable = new Map<string, string[]>()
    for (const row of r.rows) byTable.set(row.table_name, [...(byTable.get(row.table_name) ?? []), row.column_name])
    for (const c of RECORD_COLLECTIONS) {
      expect(byTable.get(tableName(c))?.sort(), c).toEqual([...RECORD_COLUMNS].sort())
    }
    const pk = await db.query<{ table_name: string; cols: string }>(
      `SELECT tc.table_name, string_agg(kcu.column_name, ',' ORDER BY kcu.ordinal_position) AS cols
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_name = tc.table_name
        WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
        GROUP BY tc.table_name`,
    )
    const pks = new Map(pk.rows.map((row) => [row.table_name, row.cols]))
    for (const c of RECORD_COLLECTIONS) expect(pks.get(tableName(c))).toBe('workspace_id,id')
    expect(pks.get('workspace_docs')).toBe('workspace_id,key')
  })

  it('store versions as bigint (change-log seqs) and give the workspace a history id', async () => {
    const r = await db.query<{ table_name: string; data_type: string }>(
      `SELECT table_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'version'`,
    )
    const types = new Map(r.rows.map((row) => [row.table_name, row.data_type]))
    for (const t of [...RECORD_COLLECTIONS.map(tableName), 'workspace_docs', 'change_log']) expect(types.get(t), t).toBe('bigint')
    const ws = await db.query<{ history_id: string }>(`SELECT history_id::text AS history_id FROM workspaces`)
    expect(ws.rows[0].history_id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('generate bigint versions for record tables added later', () => {
    expect(recordTableSql('people')).toContain('version bigint NOT NULL')
    expect(initSql()).toContain('version integer NOT NULL')
  })

  it('keep trusted devices by token hash, gone with their user', async () => {
    const r = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'trusted_devices' ORDER BY column_name`,
    )
    expect(r.rows.map((row) => row.column_name)).toEqual(['created_at', 'expires_at', 'token_hash', 'user_id'])
    const user = await db.query<{ id: string }>(`INSERT INTO users (email, password_hash, workspace_id) VALUES ('device-test@example.com', 'x', 'default') RETURNING id`)
    await db.query(`INSERT INTO trusted_devices (token_hash, user_id, expires_at) VALUES ('h', $1, now() + interval '1 day')`, [user.rows[0].id])
    await db.query('DELETE FROM users WHERE id = $1', [user.rows[0].id])
    expect((await db.query('SELECT 1 FROM trusted_devices')).rows).toEqual([])
  })

  it("keep each company's assistant use per day (006), gone with the company", async () => {
    const r = await db.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'assistant_usage' ORDER BY column_name`,
    )
    expect(r.rows).toEqual([
      { column_name: 'cache_creation_input_tokens', data_type: 'bigint' },
      { column_name: 'cache_read_input_tokens', data_type: 'bigint' },
      { column_name: 'day', data_type: 'date' },
      { column_name: 'input_tokens', data_type: 'bigint' },
      { column_name: 'messages', data_type: 'integer' },
      { column_name: 'output_tokens', data_type: 'bigint' },
      { column_name: 'workspace_id', data_type: 'text' },
    ])
    await db.query(`INSERT INTO workspaces (id, name, slug) VALUES ('w-usage-test', 'Usage', 'usage-test')`)
    await db.query(`INSERT INTO assistant_usage (workspace_id, day, messages) VALUES ('w-usage-test', '2026-10-11', 3)`)
    // One row per company and day.
    await expect(db.query(`INSERT INTO assistant_usage (workspace_id, day) VALUES ('w-usage-test', '2026-10-11')`)).rejects.toThrow()
    await db.query(`DELETE FROM workspaces WHERE id = 'w-usage-test'`)
    expect((await db.query('SELECT 1 FROM assistant_usage')).rows).toEqual([])
  })

  it('index the change log by (workspace_id, seq)', async () => {
    const r = await db.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE tablename = 'change_log'`)
    expect(r.rows.some((row) => /\(workspace_id, seq\)/.test(row.indexdef))).toBe(true)
  })

  it('are recorded and never applied twice', async () => {
    expect(await pendingMigrations(db)).toEqual([])
    const again = await migrate(db)
    expect(again.applied).toEqual([])
    expect(again.alreadyApplied).toEqual(['001_init.sql', '002_history_and_seq_versions.sql', '003_trusted_devices.sql', '004_multitenant.sql', '005_demo_hardening.sql', '006_assistant.sql'])
    const ws = await db.query<{ id: string }>('SELECT id FROM workspaces')
    expect(ws.rows).toEqual([{ id: 'default' }])
  })
})
