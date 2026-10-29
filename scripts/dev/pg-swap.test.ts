// npm run sim works on a copy of the stack's database folder and swaps it in (pg-swap.mjs): a swap, and the
// clean-up after a command stopped at each point on the way. Plain folders and files stand in for a database
// here; server/src/dev/pg-swap.test.ts does the same with a real PGlite folder.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyToWork, discardWork, recoverSimFolders, swapIn, workFolder } from './pg-swap.mjs'

let dir: string
const PID = 4242

/** A stand-in database folder with one file saying what it holds. */
function folder(name: string, holds: string): void {
  mkdirSync(path.join(dir, name), { recursive: true })
  writeFileSync(path.join(dir, name, 'PG_VERSION'), holds)
}
const holds = (name: string) => readFileSync(path.join(dir, name, 'PG_VERSION'), 'utf8')
const entries = () => readdirSync(dir).sort()

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ft-pg-swap-'))
  writeFileSync(path.join(dir, 'stack.pid'), '{}')
  folder('saves', 'kept')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('a swap', () => {
  it('works on a copy and puts it in place of pg, leaving nothing behind', () => {
    folder('pg', 'before')
    const work = copyToWork(dir, PID)
    expect(work).toBe(workFolder(dir, PID))
    expect(holds('pg')).toBe('before')
    writeFileSync(path.join(work, 'PG_VERSION'), 'after')
    expect(holds('pg')).toBe('before')
    swapIn(dir, PID)
    expect(holds('pg')).toBe('after')
    expect(entries()).toEqual(['pg', 'saves', 'stack.pid'])
  })

  it('throws away a copy it only read', () => {
    folder('pg', 'before')
    copyToWork(dir, PID)
    discardWork(dir, PID)
    expect(entries()).toEqual(['pg', 'saves', 'stack.pid'])
    expect(holds('pg')).toBe('before')
  })
})

describe('the clean-up after a command stopped on the way', () => {
  it('has nothing to do after a command that finished', () => {
    folder('pg', 'db')
    expect(recoverSimFolders(dir)).toEqual([])
    expect(recoverSimFolders(path.join(dir, 'no-such-folder'))).toEqual([])
  })

  it('deletes a copy left by a command stopped before the swap, and leaves pg as it was', () => {
    folder('pg', 'before')
    folder(`pg.sim-work-${PID}`, 'half written')
    expect(recoverSimFolders(dir)).toEqual([`deleted pg.sim-work-${PID}, a copy left by an npm run sim that stopped`])
    expect(holds('pg')).toBe('before')
    expect(entries()).toEqual(['pg', 'saves', 'stack.pid'])
  })

  it('finishes a swap stopped between its two renames: the closed copy becomes pg', () => {
    folder(`pg.sim-old-${PID}`, 'before')
    folder(`pg.sim-work-${PID}`, 'after')
    const lines = recoverSimFolders(dir)
    expect(lines[0]).toMatch(/^finished a write npm run sim was stopped in the middle of/)
    expect(holds('pg')).toBe('after')
    expect(entries()).toEqual(['pg', 'saves', 'stack.pid'])
  })

  it('puts the old folder back when pg is missing and the copy is not there', () => {
    folder(`pg.sim-old-${PID}`, 'before')
    expect(recoverSimFolders(dir)[0]).toMatch(/^put back the database npm run sim was replacing/)
    expect(holds('pg')).toBe('before')
  })

  it('deletes an old folder left after a swap that finished all but its last step', () => {
    folder('pg', 'after')
    folder(`pg.sim-old-${PID}`, 'before')
    recoverSimFolders(dir)
    expect(holds('pg')).toBe('after')
    expect(entries()).toEqual(['pg', 'saves', 'stack.pid'])
  })
})
