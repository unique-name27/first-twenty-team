// The assistant's daily limits (assistant_usage, migration 006): each company may send
// ASSISTANT_DAILY_PER_WORKSPACE messages a day and all companies together ASSISTANT_DAILY_GLOBAL, counted
// per UTC day, so a public demo server's bill has a ceiling however many people sign up. The last quarter
// of the server's allowance is kept for companies that have asked little today (fewer than LIGHT_USE
// messages), so a few busy companies (or many sign-ups by one person) cannot use it all up for everyone.
//
// A message is counted when it starts (reserveMessage), under one advisory lock, so parallel chats from a
// company's logins cannot slip past the limit together; the tokens are added when it ends (recordTokens).
// The whole billed input goes in, each kind in its own column: input_tokens holds only the input read at
// full price, the uncached remainder after the last cache breakpoint, which with the conversation cached is
// a handful of tokens a request (two answers on the live server showed 12 in all). The rest of the prompt
// is in cache_creation_input_tokens and cache_read_input_tokens, so the billed input of a row is the three
// together (billedInput). Migration 006 already keeps the cached tokens apart; no migration was needed.
// A message is given back (releaseMessage) only when no request went to the Claude API for it, or when the
// API turned every request away with an HTTP error before answering (runner.ts decides: ChatOutcome
// `charged`). Once a request is out, hanging up does not give the message back.
import type { Db, Queryable } from '../db'
import { HttpError } from '../errors'

// Any constant works; it only has to be the same for every First Twenty process (migrate.ts uses 72_026_001).
const QUOTA_LOCK_KEY = 72_026_006

/** Messages a company may have sent today and still draw on the server's reserve. */
export const LIGHT_USE = 5
/** The share of ASSISTANT_DAILY_GLOBAL kept for companies under LIGHT_USE messages today. */
export const GLOBAL_RESERVE_SHARE = 0.25

export type DailyLimits = { perWorkspace: number; global: number }

/**
 * Tokens one message used, as the API bills them: input read at full price, input written to the prompt
 * cache, input read from it, and output (thinking included).
 */
export type TokenCounts = { input: number; cacheWrite: number; cacheRead: number; output: number }

export const NO_TOKENS: Readonly<TokenCounts> = Object.freeze({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 })

/**
 * Every input token billed, cached or not: input_tokens + cache_creation_input_tokens +
 * cache_read_input_tokens, the prompt's whole size (`input` alone is only its uncached tail).
 */
export function billedInput(t: TokenCounts): number {
  return t.input + t.cacheWrite + t.cacheRead
}

/**
 * workspace: the company's own limit; global: the server's; reserve: the server is down to its reserve and
 * this company has asked LIGHT_USE messages or more today.
 */
export type QuotaScope = 'workspace' | 'global' | 'reserve'

export type Reservation = { ok: true; day: string; remaining: number } | { ok: false; scope: QuotaScope }

/**
 * The day usage counts under: the UTC date of `now`. (The app keeps company dates in Pacific time; the
 * limits are a server budget, which resets at the same instant for everyone.)
 */
export function usageDay(now: Date): string {
  return now.toISOString().slice(0, 10)
}

type Counts = { mine: number; total: number }

async function counts(q: Queryable, workspaceId: string, day: string): Promise<Counts> {
  const r = await q.query<{ mine: unknown; total: unknown }>(
    `SELECT coalesce(sum(messages) FILTER (WHERE workspace_id = $2), 0) AS mine, coalesce(sum(messages), 0) AS total
       FROM assistant_usage WHERE day = $1`,
    [day, workspaceId],
  )
  return { mine: Number(r.rows[0]?.mine ?? 0), total: Number(r.rows[0]?.total ?? 0) }
}

/** Messages kept back from the server's allowance for companies that have asked little today. */
export function globalReserve(limits: DailyLimits): number {
  return Math.floor(limits.global * GLOBAL_RESERVE_SHARE)
}

/** How far the server's count may go for this company: all of it, or all but the reserve. */
function ceiling(limits: DailyLimits, c: Counts): number {
  return c.mine >= LIGHT_USE ? limits.global - globalReserve(limits) : limits.global
}

const left = (limits: DailyLimits, c: Counts) => Math.max(0, Math.min(limits.perWorkspace - c.mine, ceiling(limits, c) - c.total))

/** Messages the company may still send today: the smaller of what it and the server have left for it. */
export async function remainingToday(db: Queryable, workspaceId: string, limits: DailyLimits, now: Date): Promise<number> {
  return left(limits, await counts(db, workspaceId, usageDay(now)))
}

/**
 * Counts one message for the company today, or says which limit is used up. A company deleted since the
 * session was checked has no row to count under: that is the signed-out answer (401).
 */
export async function reserveMessage(db: Db, workspaceId: string, limits: DailyLimits, now: Date): Promise<Reservation> {
  const day = usageDay(now)
  try {
    return await db.tx(async (q) => {
      await q.query('SELECT pg_advisory_xact_lock($1)', [QUOTA_LOCK_KEY])
      const c = await counts(q, workspaceId, day)
      if (c.mine >= limits.perWorkspace) return { ok: false as const, scope: 'workspace' as const }
      if (c.total >= limits.global) return { ok: false as const, scope: 'global' as const }
      if (c.total >= ceiling(limits, c)) return { ok: false as const, scope: 'reserve' as const }
      await q.query(
        `INSERT INTO assistant_usage (workspace_id, day, messages) VALUES ($1, $2, 1)
         ON CONFLICT (workspace_id, day) DO UPDATE SET messages = assistant_usage.messages + 1`,
        [workspaceId, day],
      )
      return { ok: true as const, day, remaining: left(limits, { mine: c.mine + 1, total: c.total + 1 }) }
    })
  } catch (err) {
    // 23503: foreign key violation, the workspace row is gone.
    if ((err as { code?: unknown }).code === '23503') throw new HttpError(401, 'unauthorized', 'This company is no longer on the server. Sign in again.')
    throw err
  }
}

/**
 * Adds the tokens a message used to its day's row (the day it was reserved under), each kind in its column:
 * the billed input as three (full price, cache writes, cache reads) and the output.
 */
export async function recordTokens(db: Queryable, workspaceId: string, day: string, tokens: TokenCounts): Promise<void> {
  const n = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0)
  const t = { input: n(tokens.input), cacheWrite: n(tokens.cacheWrite), cacheRead: n(tokens.cacheRead), output: n(tokens.output) }
  if (t.input + t.cacheWrite + t.cacheRead + t.output === 0) return
  await db.query(
    `UPDATE assistant_usage SET input_tokens = input_tokens + $3, cache_creation_input_tokens = cache_creation_input_tokens + $4,
            cache_read_input_tokens = cache_read_input_tokens + $5, output_tokens = output_tokens + $6
      WHERE workspace_id = $1 AND day = $2`,
    [workspaceId, day, t.input, t.cacheWrite, t.cacheRead, t.output],
  )
}

/**
 * Deletes the rows of days more than `olderThanDays` before today (UTC, the day rows count under), every
 * company's: the daily housekeeping (housekeeping.ts ASSISTANT_USAGE_DAYS). Returns how many went.
 */
export async function pruneUsage(db: Queryable, olderThanDays: number, now: Date = new Date()): Promise<number> {
  const oldest = usageDay(new Date(now.getTime() - olderThanDays * 86_400_000))
  const r = await db.query('DELETE FROM assistant_usage WHERE day < $1::date', [oldest])
  return r.rowCount
}

/** Gives back a message no request was made for (or one the API turned away before answering). */
export async function releaseMessage(db: Queryable, workspaceId: string, day: string): Promise<void> {
  await db.query('UPDATE assistant_usage SET messages = greatest(messages - 1, 0) WHERE workspace_id = $1 AND day = $2', [workspaceId, day])
}
