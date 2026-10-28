// The SHA-256 of every migration, in server/sql/SHA256SUMS (the format sha256sum prints), so a migration
// cannot change once it is listed without the change showing in that file. An applied migration must
// never change (CLAUDE.md): staging and live record each one in schema_migrations and never run it again,
// so an edit would reach new databases only. checksums.test.ts fails while a migration is missing from
// the list or differs from its line.
//
// A line changes only while its migration is a branch's own, before it reaches main:
// `npm run server:gen-sql -- --checksums` adds new migrations and updates those lines, and refuses for a
// migration that is on main (onMain asks git). In a pull request, a changed line for an older migration
// means an applied migration changed.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { migrationFiles } from './migrate'

export const SUMS_FILE = 'SHA256SUMS'
/** The command that lists new migrations (named in the test's failure message). */
export const SUMS_COMMAND = 'npm run server:gen-sql -- --checksums'

const LINE_RE = /^([0-9a-f]{64}) [ *]([^\s/\\]+)$/

/** The SHA-256 of a migration as git checks it out (LF line endings, whatever the editor saved). */
export function migrationSum(dir: string, file: string): string {
  const text = readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n')
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** The listed sums by file name; empty when there is no list yet. */
export function readSums(dir: string): Map<string, string> {
  const file = path.join(dir, SUMS_FILE)
  const sums = new Map<string, string>()
  if (!existsSync(file)) return sums
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue
    const m = LINE_RE.exec(line)
    if (!m) throw new Error(`server/sql/${SUMS_FILE} has a line that is not "<sha256>  <file>": ${line}`)
    sums.set(m[2], m[1])
  }
  return sums
}

export function writeSums(dir: string, sums: Map<string, string>): void {
  const lines = [...sums].sort(([a], [b]) => (a < b ? -1 : 1)).map(([file, sum]) => `${sum}  ${file}`)
  writeFileSync(path.join(dir, SUMS_FILE), `${lines.join('\n')}\n`)
}

/** What is wrong with the list, one line each: a migration not listed, a listed one gone, or changed. */
export function sumProblems(dir: string): string[] {
  const sums = readSums(dir)
  const files = migrationFiles(dir)
  const problems: string[] = []
  for (const file of files) {
    const listed = sums.get(file)
    if (listed === undefined) problems.push(`${file} is not listed`)
    else if (listed !== migrationSum(dir, file)) problems.push(`${file} differs from its line: it changed after it was listed`)
  }
  for (const file of sums.keys()) if (!files.includes(file)) problems.push(`${file} is listed but missing`)
  return problems
}

/** Runs git in a folder; true when it exits 0. */
export type GitRunner = (cwd: string, args: string[]) => boolean

const runGit: GitRunner = (cwd, args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { stdio: 'ignore', windowsHide: true })
  return r.status === 0
}

/**
 * The branch (origin/main or main) that already has this migration, or null when neither has it, or git
 * cannot tell (not a git checkout). Fetch first for an up-to-date answer: it reads the local copies.
 */
export function onMain(dir: string, file: string, git: GitRunner = runGit): string | null {
  for (const ref of ['origin/main', 'main']) if (git(dir, ['cat-file', '-e', `${ref}:./${file}`])) return ref
  return null
}

/** Why a migration's file or line may not change: it is on main already. Null when it may. */
export function changeRefusal(dir: string, file: string, git: GitRunner = runGit): string | null {
  const ref = onMain(dir, file, git)
  if (!ref) return null
  return (
    `server/sql/${file} is on ${ref} already, so a database may have applied it: it must never change. ` +
    'Make the change a new migration instead (for the read model: npm run server:gen-sql -- --read-model --write).'
  )
}

/**
 * Adds a line for every migration not listed, updates the line of each one that changed and drops the line
 * of one that is gone, except for a migration on main, whose line it keeps and reports.
 */
export function updateSums(dir: string, git: GitRunner = runGit): { added: string[]; updated: string[]; refused: string[] } {
  const sums = readSums(dir)
  const out = { added: [] as string[], updated: [] as string[], refused: [] as string[] }
  for (const file of migrationFiles(dir)) {
    const sum = migrationSum(dir, file)
    const listed = sums.get(file)
    if (listed === sum) continue
    if (listed === undefined) {
      out.added.push(file)
    } else {
      const refusal = changeRefusal(dir, file, git)
      if (refusal) {
        out.refused.push(refusal)
        continue
      }
      out.updated.push(file)
    }
    sums.set(file, sum)
  }
  for (const file of [...sums.keys()]) {
    if (existsSync(path.join(dir, file))) continue
    const refusal = changeRefusal(dir, file, git)
    if (refusal) out.refused.push(refusal)
    else sums.delete(file)
  }
  writeSums(dir, sums)
  return out
}
