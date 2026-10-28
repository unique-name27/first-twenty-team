// `npm run sql` with no stack running reads a copy of the stack's PGlite folder, never the folder itself.
// PGlite writes to its folder even to answer a SELECT (its control file, the write-ahead log, catalog
// pages), and nothing stops a second process from opening the same folder: two `npm run sql` at once, or
// a stack started while one runs, would both write it and could leave it unreadable (only `npm run stack
// -- --fresh` gets past that, and it deletes the dev database). The copy makes the stack the only process
// that ever writes the folder. A copy made while a stack starts may not open; the folder itself is never
// touched, so running the command again is enough.
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export type DatabaseCopy = {
  /** The copied folder, to open with PGlite. */
  dir: string
  /** Deletes the copy (never throws: a copy left behind in the temporary folder harms nothing). */
  remove(): void
}

/** Copies a PGlite folder into a new temporary folder (tens of megabytes; well under a second). */
export function copyForReading(pgDir: string, under: string = tmpdir()): DatabaseCopy {
  const root = mkdtempSync(path.join(under, 'first-twenty-sql-'))
  const remove = () => {
    try {
      // Windows can hold a file for a moment after the worker that had it open stops.
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // Left for the system's temporary-file cleanup.
    }
  }
  const dir = path.join(root, 'pg')
  try {
    cpSync(pgDir, dir, { recursive: true })
  } catch (err) {
    remove()
    throw err
  }
  return { dir, remove }
}
