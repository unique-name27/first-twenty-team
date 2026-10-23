// The daily housekeeping's step for the assistant's daily counts: rows of days more than
// ASSISTANT_USAGE_DAYS ago go, for kept and demo companies alike, the rest stay, and a failure there does
// not stop the other steps. Sessions, demo expiry, change-log pruning and invites: workspaces.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { usageDay } from './assistant/quota'
import type { Db } from './db'
import { ASSISTANT_USAGE_DAYS, housekeeping } from './housekeeping'
import { makeTestDb, resetDb } from './test/helpers'

let db: Db
beforeAll(async () => {
  db = await makeTestDb()
})
afterAll(async () => {
  await db.close()
})
beforeEach(async () => {
  await resetDb(db)
  await db.query(`INSERT INTO workspaces (id, name, slug, keep) VALUES ('w-kept', 'Kept', 'kept', true), ('w-demo', 'Demo', 'demo', false)`)
})

const config = { sessionIdleHours: 12, demoExpireDays: 30 }
/** The UTC day `n` days before today, the way assistant_usage rows are keyed. */
const daysAgo = (n: number) => usageDay(new Date(Date.now() - n * 86_400_000))
const usageRows = async () =>
  (await db.query<{ workspace_id: string; day: string }>(`SELECT workspace_id, to_char(day, 'YYYY-MM-DD') AS day FROM assistant_usage ORDER BY workspace_id, day`)).rows.map(
    (r) => `${r.workspace_id} ${r.day}`,
  )

describe('housekeeping: the assistant usage ledger', () => {
  it(`deletes the days more than ${ASSISTANT_USAGE_DAYS} days ago, for every company, and keeps the rest`, async () => {
    expect(ASSISTANT_USAGE_DAYS).toBe(400)
    for (const [id, n] of [
      ['w-kept', 900],
      ['w-kept', ASSISTANT_USAGE_DAYS + 1],
      ['w-kept', ASSISTANT_USAGE_DAYS - 1],
      ['w-kept', 0],
      ['w-demo', ASSISTANT_USAGE_DAYS + 30],
      ['w-demo', 10],
    ] as Array<[string, number]>) {
      await db.query(`INSERT INTO assistant_usage (workspace_id, day, messages, input_tokens, cache_read_input_tokens) VALUES ($1, $2, 4, 12, 30000)`, [id, daysAgo(n)])
    }
    const done = await housekeeping(db, config)
    expect(done.assistantUsage).toBe(3)
    expect(await usageRows()).toEqual([`w-demo ${daysAgo(10)}`, `w-kept ${daysAgo(ASSISTANT_USAGE_DAYS - 1)}`, `w-kept ${daysAgo(0)}`])
    // Nothing more the next time.
    expect((await housekeeping(db, config)).assistantUsage).toBe(0)
  })

  it('prunes the ledger even when an earlier step failed, and reports that failure at the end', async () => {
    await db.query(`INSERT INTO assistant_usage (workspace_id, day, messages) VALUES ('w-kept', $1, 1)`, [daysAgo(ASSISTANT_USAGE_DAYS + 5)])
    const broken: Db = {
      ...db,
      query: (async (text: string, params?: unknown[]) => {
        if (/DELETE FROM sessions WHERE expires_at/.test(text)) throw new Error('sessions table locked')
        return db.query(text, params)
      }) as Db['query'],
    }
    await expect(housekeeping(broken, config)).rejects.toThrow(/sessions table locked/)
    expect(await usageRows()).toEqual([])
  })

  it('reports a failure of its own after the other steps ran', async () => {
    let invitesPurged = false
    const broken: Db = {
      ...db,
      query: (async (text: string, params?: unknown[]) => {
        if (/DELETE FROM invites/.test(text)) invitesPurged = true
        if (/DELETE FROM assistant_usage/.test(text)) throw new Error('assistant_usage locked')
        return db.query(text, params)
      }) as Db['query'],
    }
    await expect(housekeeping(broken, config)).rejects.toThrow(/assistant_usage locked/)
    expect(invitesPurged).toBe(true)
  })
})
