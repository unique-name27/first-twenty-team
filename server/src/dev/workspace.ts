// Development only: the stack's own company, read and replaced whole, for npm run sim (scripts/dev/sim.ts,
// docs/DEV.md "Simulate a company"). While the stack runs, GET and POST /__dev/workspace (routes.ts) call
// these, because its API holds the PGlite database; with no stack, npm run sim calls them on the folder
// itself, holding the stack's lock. A replace goes through replaceWorkspace with confirmReplace, as the app's
// Import and Start fresh do when connected (PUT /api/workspace), so a browser that syncs with the stack takes
// the new copy the way it takes one from another computer: the history changes, its next pull resyncs, and
// it shows the server's copy with a notice (src/sync/engine.ts, rebaseOnSnapshot).
import type { Db } from '../db'
import { replaceWorkspace, snapshot } from '../repo'
import { WORKSPACE_ID } from '../sqlgen'
import { parseWorkspace } from '../validate'

/** The company npm run stack makes its dev login in and loads the sample into (scripts/dev/prepare.ts). */
export const STACK_WORKSPACE = WORKSPACE_ID

/** The stack's company, or empty before anything was uploaded to it. */
export type StackWorkspace =
  | { empty: true; workspaceId: string }
  | { empty: false; workspaceId: string; historyId: string; seq: number; db: Record<string, unknown> }

/** What a replace did: the new history and how many records the company now holds (documents not counted). */
export type StackReplaced = { workspaceId: string; historyId: string; seq: number; records: number }

export async function readStackWorkspace(db: Db, workspaceId = STACK_WORKSPACE): Promise<StackWorkspace> {
  const snap = await snapshot(db, workspaceId)
  if (!snap) return { empty: true, workspaceId }
  return { empty: false, workspaceId, historyId: snap.historyId, seq: snap.seq, db: snap.db }
}

/** Replaces the stack's company with `workspace` (a whole DB, as an Import sends it). Throws a 400 HttpError for one the server refuses. */
export async function replaceStackWorkspace(db: Db, workspace: unknown, workspaceId = STACK_WORKSPACE): Promise<StackReplaced> {
  const input = parseWorkspace({ db: workspace, confirmReplace: true })
  const result = await replaceWorkspace(db, input, null, workspaceId)
  return { workspaceId, historyId: result.historyId, seq: result.seq, records: input.collections.reduce((n, c) => n + c.ids.length, 0) }
}
