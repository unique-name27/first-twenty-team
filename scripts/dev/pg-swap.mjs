// `npm run sim` never writes the stack's database folder in place (scripts/dev/sim.ts, docs/DEV.md "Simulate a
// company"). With no stack running, it copies <data folder>/pg to pg.sim-work-<pid> and opens the copy; a
// replace closes the copy and swaps it in with two renames, and a copy it only read is deleted. A command
// stopped on the way (Ctrl+C, a native crash, the computer stopping) leaves pg as it was, plus a leftover
// copy, which the next npm run sim or npm run stack clears up (recoverSimFolders). Only a stop between the two
// renames leaves no pg folder; recoverSimFolders then finishes the swap. The caller holds the folder's lock
// (its stack.pid) throughout. Plain JavaScript, so stack.mjs can use it before anything is compiled. Types
// are in pg-swap.d.mts.
import { cpSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'

const WORK = 'pg.sim-work-'
const OLD = 'pg.sim-old-'

/**
 * The copy npm run sim works on, for process `pid`.
 * @param {string} dir the data folder
 * @param {number} pid
 */
export function workFolder(dir, pid) {
  return path.join(dir, `${WORK}${pid}`)
}

/**
 * Waits `ms` without returning to the event loop (a rename is retried in place).
 * @param {number} ms
 */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Renames a folder, trying again for a moment when Windows still holds a file in it (a virus scanner or the
 * search indexer can, just after a database closes).
 * @param {string} from
 * @param {string} to
 */
function renameFolder(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err)?.code
      if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) throw err
      pause(100)
    }
  }
}

/** @param {string} folder */
function removeFolder(folder) {
  rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

/**
 * Copies <dir>/pg to the work folder for `pid` (tens of megabytes; well under a second) and returns its path.
 * @param {string} dir
 * @param {number} pid
 * @returns {string}
 */
export function copyToWork(dir, pid) {
  const work = workFolder(dir, pid)
  removeFolder(work)
  try {
    cpSync(path.join(dir, 'pg'), work, { recursive: true })
  } catch (err) {
    removeFolder(work)
    throw err
  }
  return work
}

/**
 * Puts the work folder for `pid`, closed, in place of <dir>/pg, then deletes the folder it replaced.
 * @param {string} dir
 * @param {number} pid
 */
export function swapIn(dir, pid) {
  const pg = path.join(dir, 'pg')
  const old = path.join(dir, `${OLD}${pid}`)
  renameFolder(pg, old)
  renameFolder(workFolder(dir, pid), pg)
  removeFolder(old)
}

/**
 * Deletes the work folder for `pid`, if there is one.
 * @param {string} dir
 * @param {number} pid
 */
export function discardWork(dir, pid) {
  removeFolder(workFolder(dir, pid))
}

/**
 * Clears up after an npm run sim that stopped on the way, for whoever holds the folder's lock. When pg is
 * missing, a swap stopped between its renames: the work copy of that same process becomes pg (it is renamed
 * only once closed, so it is whole), or else the folder it replaced goes back. Every other leftover copy is
 * deleted. Returns one line for each thing it did.
 * @param {string} dir
 * @returns {string[]}
 */
export function recoverSimFolders(dir) {
  if (!existsSync(dir)) return []
  const lines = []
  const entries = readdirSync(dir)
  const pg = path.join(dir, 'pg')
  const old = entries.find((e) => e.startsWith(OLD))
  if (!entries.includes('pg') && old) {
    const work = `${WORK}${old.slice(OLD.length)}`
    if (entries.includes(work)) {
      renameFolder(path.join(dir, work), pg)
      lines.push(`finished a write npm run sim was stopped in the middle of: ${work} is now pg`)
    } else {
      renameFolder(path.join(dir, old), pg)
      lines.push(`put back the database npm run sim was replacing when it stopped: ${old} is pg again`)
    }
  }
  for (const e of readdirSync(dir)) {
    if (!e.startsWith(WORK) && !e.startsWith(OLD)) continue
    removeFolder(path.join(dir, e))
    lines.push(`deleted ${e}, a copy left by an npm run sim that stopped`)
  }
  return lines
}
