// npm run sql with no stack reads a copy of the stack's PGlite folder (scripts/dev/sql-copy.ts): the folder itself is
// left byte for byte as it was, and the copy goes afterwards. It lives here because it opens a database:
// tests under scripts/ never load server code (scripts/test/tiers.ts).
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { copyForReading } from '../../../scripts/dev/sql-copy'
import { openPGlite } from '../db'
import { runReadOnly } from './readonly'

/** Every file under a folder with the SHA-256 of its bytes. */
function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name)
      if (statSync(full).isDirectory()) walk(full)
      else out[path.relative(dir, full)] = createHash('sha256').update(readFileSync(full)).digest('hex')
    }
  }
  walk(dir)
  return out
}

describe('copyForReading', () => {
  let root: string
  let pgDir: string

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'ft-sql-copy-test-'))
    pgDir = path.join(root, 'pg')
    const db = await openPGlite(pgDir)
    await db.exec(`CREATE TABLE notes (id text PRIMARY KEY, body text); INSERT INTO notes VALUES ('n-1', 'kept')`)
    await db.close()
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it("reads the stack's data from a copy and leaves the folder itself exactly as it was", async () => {
    const before = fingerprint(pgDir)
    const copy = copyForReading(pgDir, root)
    expect(path.relative(pgDir, copy.dir).startsWith('..')).toBe(true)
    const db = await openPGlite(copy.dir)
    try {
      const answer = await runReadOnly(db, { sql: 'SELECT body FROM notes' })
      expect(answer.rows).toEqual([['kept']])
    } finally {
      await db.close()
    }
    copy.remove()
    expect(existsSync(copy.dir)).toBe(false)
    expect(fingerprint(pgDir)).toEqual(before)
  })

  it('leaves nothing behind when the folder cannot be copied', () => {
    const under = mkdtempSync(path.join(root, 'empty-'))
    expect(() => copyForReading(path.join(root, 'no-such-folder'), under)).toThrow()
    expect(readdirSync(under)).toEqual([])
  })
})
