// npm run sim with no stack works on a copy of the stack's PGlite folder and swaps it in (scripts/dev/pg-swap.mjs),
// so the folder itself is never written in place. This checks it with a real PGlite folder: the swapped-in copy
// opens with the new data, and a copy left by a command stopped before or during the swap is cleared up with
// the folder whole. It lives here because it opens a database: tests under scripts/ never load server code
// (scripts/test/tiers.ts).
import { mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyToWork, recoverSimFolders, swapIn } from '../../../scripts/dev/pg-swap.mjs'
import { openPGlite } from '../db'

let dir: string
const PID = 4242

async function notes(folder: string): Promise<string[]> {
  const db = await openPGlite(folder)
  try {
    return (await db.query<{ body: string }>('SELECT body FROM notes ORDER BY body')).rows.map((r) => r.body)
  } finally {
    await db.close()
  }
}

async function addNote(folder: string, body: string): Promise<void> {
  const db = await openPGlite(folder)
  try {
    await db.query('INSERT INTO notes VALUES ($1)', [body])
  } finally {
    await db.close()
  }
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'ft-pg-swap-db-'))
  const db = await openPGlite(path.join(dir, 'pg'))
  await db.exec(`CREATE TABLE notes (body text PRIMARY KEY); INSERT INTO notes VALUES ('kept')`)
  await db.close()
}, 60_000)
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

describe('the copy npm run sim swaps in', () => {
  it('opens with the new data once swapped in, and the folder is untouched until then', async () => {
    const work = copyToWork(dir, PID)
    await addNote(work, 'replaced')
    expect(await notes(path.join(dir, 'pg'))).toEqual(['kept'])
    swapIn(dir, PID)
    expect(await notes(path.join(dir, 'pg'))).toEqual(['kept', 'replaced'])
    expect(readdirSync(dir)).toEqual(['pg'])
  }, 60_000)

  it('leaves the folder whole when the command stops before the swap', async () => {
    await addNote(copyToWork(dir, PID), 'never swapped in')
    expect(recoverSimFolders(dir)).toHaveLength(1)
    expect(await notes(path.join(dir, 'pg'))).toEqual(['kept'])
    expect(readdirSync(dir)).toEqual(['pg'])
  }, 60_000)

  it('finishes a swap stopped between its renames, with the copy whole', async () => {
    await addNote(copyToWork(dir, PID), 'replaced')
    renameSync(path.join(dir, 'pg'), path.join(dir, `pg.sim-old-${PID}`))
    recoverSimFolders(dir)
    expect(await notes(path.join(dir, 'pg'))).toEqual(['kept', 'replaced'])
    expect(readdirSync(dir)).toEqual(['pg'])
  }, 60_000)
})
