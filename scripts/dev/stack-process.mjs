// Whether a stack still runs on a data folder, for `npm run stack` (scripts/dev/stack.mjs: one stack per
// folder) and `npm run sql` (scripts/dev/sql.ts: it opens the database itself only when no stack holds
// it). Reads the stack's pid file and asks the system about that process. Types are in stack-process.d.mts.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isStackCommandLine } from './stack-lib.mjs'

/**
 * The stack's pid file ({pid, startedAt, ports}), or null when it is missing or unreadable.
 * @param {string} pidFile
 * @returns {{ pid: number, startedAt?: string } | null}
 */
export function readStackPid(pidFile) {
  if (!existsSync(pidFile)) return null
  try {
    const info = JSON.parse(readFileSync(pidFile, 'utf8'))
    return info && Number.isInteger(info.pid) ? info : null
  } catch {
    return null
  }
}

/**
 * True when `pid` is alive and, as far as the system can tell, is a stack. A pid alone is not enough: a
 * codespace or container that stopped without Ctrl+C left its pid file behind, and after a restart it
 * hands out the same low pids again, often to unrelated processes (or to this very stack).
 * @param {number} pid
 * @returns {boolean}
 */
export function isStackProcess(pid) {
  try {
    process.kill(pid, 0)
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    if (/** @type {NodeJS.ErrnoException} */ (err)?.code !== 'EPERM') return false
  }
  try {
    if (process.platform === 'linux') return isStackCommandLine(readFileSync(`/proc/${pid}/cmdline`, 'utf8'))
    const windows = process.platform === 'win32'
    const ps = windows
      ? spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
      : spawnSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' })
    if (ps.status !== 0) return true
    // Windows names only the program, so any node process counts; ps names its arguments too.
    return windows ? /^"node(\.exe)?"/i.test(ps.stdout.trim()) : isStackCommandLine(ps.stdout.trim().split(/\s+/).join('\0'))
  } catch {
    return true // the system would not say: trust the pid
  }
}
