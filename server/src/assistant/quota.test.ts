// The daily limits: per company and for the whole server, per UTC day, counted under a lock so parallel chats
// cannot pass a limit together, the server's last quarter kept for companies that have asked little, with
// tokens added afterwards by kind (the whole billed input: full price, cache writes, cache reads) and a
// message given back when no request went out for it. Also: migration 006's table, what deleting a company
// does to its rows, and the old days the daily housekeeping prunes.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../db'
import { HttpError } from '../errors'
import { makeTestDb, resetDb } from '../test/helpers'
import { deleteDemoWorkspace } from '../workspaces'
import { billedInput, globalReserve, LIGHT_USE, pruneUsage, recordTokens, releaseMessage, remainingToday, reserveMessage, usageDay } from './quota'

let db: Db
const NOON = new Date('2026-10-11T12:00:00Z')
const limits = { perWorkspace: 3, global: 5 }

beforeAll(async () => {
  db = await makeTestDb()
})
afterAll(async () => {
  await db.close()
})
beforeEach(async () => {
  await resetDb(db)
  for (const id of ['w-a', 'w-b', 'w-c']) await db.query(`INSERT INTO workspaces (id, name, slug, keep) VALUES ($1, $1, $2, false)`, [id, `slug-${id}`])
})

const row = async (id: string, day = '2026-10-11') =>
  (
    await db.query<{ messages: number; input_tokens: unknown; cache_creation_input_tokens: unknown; cache_read_input_tokens: unknown; output_tokens: unknown }>(
      'SELECT messages, input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens FROM assistant_usage WHERE workspace_id = $1 AND day = $2',
      [id, day],
    )
  ).rows[0]

describe('daily limits', () => {
  it('count messages per company and say how many are left', async () => {
    expect(await remainingToday(db, 'w-a', limits, NOON)).toBe(3)
    expect(await reserveMessage(db, 'w-a', limits, NOON)).toEqual({ ok: true, day: '2026-10-11', remaining: 2 })
    expect(await reserveMessage(db, 'w-a', limits, NOON)).toMatchObject({ ok: true, remaining: 1 })
    expect(await reserveMessage(db, 'w-a', limits, NOON)).toMatchObject({ ok: true, remaining: 0 })
    expect(await reserveMessage(db, 'w-a', limits, NOON)).toEqual({ ok: false, scope: 'workspace' })
    expect(await remainingToday(db, 'w-a', limits, NOON)).toBe(0)
    expect((await row('w-a')).messages).toBe(3)
    // Another company has its own count, within what the server has left (5 - 3).
    expect(await remainingToday(db, 'w-b', limits, NOON)).toBe(2)
  })

  it('stop every company once the server has used its messages for the day', async () => {
    for (let i = 0; i < 3; i++) await reserveMessage(db, 'w-a', limits, NOON)
    for (let i = 0; i < 2; i++) expect((await reserveMessage(db, 'w-b', limits, NOON)).ok).toBe(true)
    expect(await reserveMessage(db, 'w-c', limits, NOON)).toEqual({ ok: false, scope: 'global' })
    expect(await remainingToday(db, 'w-c', limits, NOON)).toBe(0)
  })

  it('start again on the next UTC day', async () => {
    for (let i = 0; i < 3; i++) await reserveMessage(db, 'w-a', limits, NOON)
    expect((await reserveMessage(db, 'w-a', limits, new Date('2026-10-11T23:59:59Z'))).ok).toBe(false)
    expect(await reserveMessage(db, 'w-a', limits, new Date('2026-10-12T00:00:01Z'))).toMatchObject({ ok: true, day: '2026-10-12' })
    expect(usageDay(new Date('2026-10-12T06:59:00Z'))).toBe('2026-10-12') // 11:59 PM on Oct 11 in California
  })

  it('never let parallel requests pass the limit together', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => reserveMessage(db, 'w-a', limits, NOON)))
    expect(results.filter((r) => r.ok)).toHaveLength(3)
    expect((await row('w-a')).messages).toBe(3)
  })

  it('add the tokens by kind to the day the message was counted under, and give back a message that never ran', async () => {
    const r = await reserveMessage(db, 'w-a', limits, NOON)
    if (!r.ok) throw new Error('expected a reservation')
    await recordTokens(db, 'w-a', r.day, { input: 1200.4, cacheWrite: 900, cacheRead: 30_000, output: 300 })
    await recordTokens(db, 'w-a', r.day, { input: 10, cacheWrite: 0, cacheRead: 31_000, output: 5 })
    await recordTokens(db, 'w-a', r.day, { input: Number.NaN, cacheWrite: -4, cacheRead: 0, output: 0 })
    const t = await row('w-a')
    expect(t.messages).toBe(1)
    // Input at full price, cache writes and cache reads apart (they cost $4, $5 and $0.20 per million on Opus 5.5).
    expect([t.input_tokens, t.cache_creation_input_tokens, t.cache_read_input_tokens, t.output_tokens].map(Number)).toEqual([1210, 900, 61_000, 305])
    await releaseMessage(db, 'w-a', r.day)
    await releaseMessage(db, 'w-a', r.day)
    expect((await row('w-a')).messages).toBe(0) // never below zero
    expect(await remainingToday(db, 'w-a', limits, NOON)).toBe(3)
  })

  it('keep the whole billed input of a cached answer: a handful of tokens at full price, the rest as cache writes and reads', async () => {
    // Two answers as the live server saw them: 12 input tokens in all, the prompt itself in the cache columns.
    const r = await reserveMessage(db, 'w-a', limits, NOON)
    if (!r.ok) throw new Error('expected a reservation')
    const first = { input: 6, cacheWrite: 14_200, cacheRead: 0, output: 410 }
    const second = { input: 6, cacheWrite: 650, cacheRead: 14_200, output: 380 }
    await recordTokens(db, 'w-a', r.day, first)
    await recordTokens(db, 'w-a', r.day, second)
    const t = await row('w-a')
    const stored = { input: Number(t.input_tokens), cacheWrite: Number(t.cache_creation_input_tokens), cacheRead: Number(t.cache_read_input_tokens), output: Number(t.output_tokens) }
    expect(stored).toEqual({ input: 12, cacheWrite: 14_850, cacheRead: 14_200, output: 790 })
    expect(billedInput(stored)).toBe(29_062)
    expect(billedInput(stored)).toBe(billedInput(first) + billedInput(second))
    expect(billedInput({ input: 0, cacheWrite: 0, cacheRead: 0, output: 99 })).toBe(0)
  })

  it("keep the server's last quarter for companies that have asked little today", async () => {
    const big = { perWorkspace: 40, global: 20 }
    expect(globalReserve(big)).toBe(5)
    for (const id of ['w-d', 'w-e']) await db.query(`INSERT INTO workspaces (id, name, slug, keep) VALUES ($1, $1, $2, false)`, [id, `slug-${id}`])
    // One busy company takes the server to its reserve (15 of 20), then stops there.
    for (let i = 0; i < 15; i++) expect((await reserveMessage(db, 'w-a', big, NOON)).ok).toBe(true)
    expect(await remainingToday(db, 'w-a', big, NOON)).toBe(0)
    expect(await reserveMessage(db, 'w-a', big, NOON)).toEqual({ ok: false, scope: 'reserve' })
    // Companies under LIGHT_USE still get the rest, each up to LIGHT_USE, until the server's count is used up.
    expect(await remainingToday(db, 'w-b', big, NOON)).toBe(5)
    for (let i = 0; i < LIGHT_USE - 1; i++) expect((await reserveMessage(db, 'w-b', big, NOON)).ok).toBe(true)
    expect(await remainingToday(db, 'w-b', big, NOON)).toBe(1)
    expect((await reserveMessage(db, 'w-c', big, NOON)).ok).toBe(true)
    expect(await reserveMessage(db, 'w-d', big, NOON)).toEqual({ ok: false, scope: 'global' })
    expect((await row('w-a')).messages + (await row('w-b')).messages + (await row('w-c')).messages).toBe(20)
    // A server too small for a reserve keeps none.
    expect(globalReserve({ perWorkspace: 3, global: 3 })).toBe(0)
  })

  it('answer as signed out for a company deleted since its session was checked', async () => {
    await db.query(`DELETE FROM workspaces WHERE id = 'w-c'`)
    await expect(reserveMessage(db, 'w-c', limits, NOON)).rejects.toSatisfy((e) => e instanceof HttpError && e.statusCode === 401)
  })
})

describe('assistant_usage (migration 006)', () => {
  it('goes with its company when a demo company is deleted, and when any workspace row goes', async () => {
    await reserveMessage(db, 'w-a', limits, NOON)
    await reserveMessage(db, 'w-b', limits, NOON)
    expect(await deleteDemoWorkspace(db, 'w-a')).toBe(true)
    expect(await row('w-a')).toBeUndefined()
    // The foreign key cascades for a workspace deleted by hand too (docs/SERVER.md shows how).
    await db.query(`DELETE FROM workspaces WHERE id = 'w-b'`)
    expect(await row('w-b')).toBeUndefined()
  })

  it('refuses negative counts', async () => {
    await expect(db.query(`INSERT INTO assistant_usage (workspace_id, day, messages) VALUES ('w-a', '2026-10-11', -1)`)).rejects.toThrow()
  })

  it('loses the days more than the given number before today (UTC), every company, and keeps the rest', async () => {
    // 400 days before 2026-10-11 is 2025-09-06: that day stays, the day before goes.
    const days: Array<[string, string]> = [
      ['w-a', '2025-09-05'],
      ['w-a', '2025-09-06'],
      ['w-a', '2026-10-11'],
      ['w-b', '2024-01-01'],
      ['w-c', '2026-01-01'],
    ]
    for (const [id, day] of days) await db.query(`INSERT INTO assistant_usage (workspace_id, day, messages, input_tokens) VALUES ($1, $2, 3, 100)`, [id, day])
    expect(await pruneUsage(db, 400, NOON)).toBe(2)
    const left = await db.query<{ workspace_id: string; day: string }>(`SELECT workspace_id, to_char(day, 'YYYY-MM-DD') AS day FROM assistant_usage ORDER BY workspace_id, day`)
    expect(left.rows.map((x) => `${x.workspace_id} ${x.day}`)).toEqual(['w-a 2025-09-06', 'w-a 2026-10-11', 'w-c 2026-01-01'])
    // Just after midnight UTC the cutoff moves a day; late in the California evening it already has.
    expect(await pruneUsage(db, 400, new Date('2026-10-12T06:30:00Z'))).toBe(1)
    expect(await pruneUsage(db, 400, new Date('2026-10-12T06:30:00Z'))).toBe(0)
  })
})
