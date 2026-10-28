// Daily housekeeping, which serve.ts also runs once at startup (docs/SERVER.md, "A public demo server"):
// - sessions that ended (idle or past their expiry);
// - demo companies (workspaces not kept) with no write or sign-in for DEMO_EXPIRE_DAYS, each deleted
//   whole in one transaction (workspaces.ts deleteDemoWorkspace);
// - change-log rows older than CHANGE_LOG_DAYS in every workspace, and a demo company's rows past its
//   newest LIMITS.logRowsPerDemoWorkspace (repo.ts pruneChangeLogs);
// - invite links that expired more than a week ago;
// - the assistant's daily counts (assistant_usage) of days more than ASSISTANT_USAGE_DAYS ago.
// Each step runs even when an earlier one failed; the first error is thrown at the end, after the rest.
import { pruneUsage } from './assistant/quota'
import { purgeSessions } from './auth'
import type { Config } from './config'
import type { Db } from './db'
import { pruneChangeLogs } from './repo'
import { expireDemoWorkspaces, purgeInvites } from './workspaces'

/** Change-log rows older than this are pruned (docs/SYNC.md, Data layout). */
export const CHANGE_LOG_DAYS = 120
/**
 * The assistant's daily counts are kept this long (UTC days): a year of the bill to compare with the same
 * month last year, and a month to spare. A demo company's rows also go when it expires (the foreign key
 * cascades); a kept company's go only this way.
 */
export const ASSISTANT_USAGE_DAYS = 400

export type HousekeepingResult = { sessions: number; expiredWorkspaces: number; prunedChanges: number; invites: number; assistantUsage: number }

export async function housekeeping(db: Db, config: Pick<Config, 'sessionIdleHours' | 'demoExpireDays'>): Promise<HousekeepingResult> {
  const result: HousekeepingResult = { sessions: 0, expiredWorkspaces: 0, prunedChanges: 0, invites: 0, assistantUsage: 0 }
  let failure: unknown = null
  const step = async (run: () => Promise<void>) => {
    try {
      await run()
    } catch (err) {
      failure ??= err
    }
  }
  await step(async () => {
    result.sessions = await purgeSessions(db, config)
  })
  // Before pruning, so the change logs of companies that are about to go are not pruned first.
  await step(async () => {
    result.expiredWorkspaces = await expireDemoWorkspaces(db, config.demoExpireDays)
  })
  await step(async () => {
    result.prunedChanges = await pruneChangeLogs(db, CHANGE_LOG_DAYS)
  })
  await step(async () => {
    result.invites = await purgeInvites(db)
  })
  await step(async () => {
    result.assistantUsage = await pruneUsage(db, ASSISTANT_USAGE_DAYS)
  })
  if (failure) throw failure
  return result
}
