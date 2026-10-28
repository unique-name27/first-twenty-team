// server/sql/SHA256SUMS lists every migration with its SHA-256, so an applied migration cannot change
// without the change showing (checksums.ts). The real folder must match its list; the rest runs on a copy.
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { changeRefusal, type GitRunner, migrationSum, onMain, readSums, SUMS_COMMAND, SUMS_FILE, sumProblems, updateSums } from './checksums'
import { migrationFiles, migrationsDir } from './migrate'

describe('server/sql/SHA256SUMS', () => {
  it('lists every migration, each exactly as it is', () => {
    const problems = sumProblems(migrationsDir())
    expect(problems, `server/sql/${SUMS_FILE}: ${problems.join('; ')}. Put an applied migration back as it was; list a new one with ${SUMS_COMMAND}`).toEqual([])
    expect([...readSums(migrationsDir()).keys()]).toEqual(migrationFiles(migrationsDir()))
  })
})

describe('the checksum list on a copy of server/sql', () => {
  let dir: string
  /** git that says these files are on origin/main. */
  const gitWith =
    (onMainFiles: string[]): GitRunner =>
    (_cwd, args) =>
      args[0] === 'cat-file' && onMainFiles.some((f) => args[2] === `origin/main:./${f}`)
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ft-sums-'))
    cpSync(migrationsDir(), dir, { recursive: true })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('finds a migration that changed, one that is not listed, and one that is gone', () => {
    const [first, second] = migrationFiles(dir)
    expect(sumProblems(dir)).toEqual([])
    appendFileSync(path.join(dir, first), '-- edited after it was applied\n')
    writeFileSync(path.join(dir, '999_new_table.sql'), 'SELECT 1;\n')
    rmSync(path.join(dir, second))
    expect(sumProblems(dir)).toEqual([`${first} differs from its line: it changed after it was listed`, '999_new_table.sql is not listed', `${second} is listed but missing`])
  })

  it('hashes the text as git checks it out, so Windows line endings change nothing', () => {
    const file = migrationFiles(dir)[0]
    const sum = migrationSum(dir, file)
    writeFileSync(path.join(dir, file), readFileSync(path.join(dir, file), 'utf8').replace(/\n/g, '\r\n'))
    expect(migrationSum(dir, file)).toBe(sum)
  })

  it("lists new migrations and updates a branch's own, but never the line of a migration on main", () => {
    const files = migrationFiles(dir)
    const applied = files[0]
    const own = files.at(-1)!
    const before = readSums(dir)
    appendFileSync(path.join(dir, applied), '-- edited after it was applied\n')
    appendFileSync(path.join(dir, own), '-- still being written on this branch\n')
    writeFileSync(path.join(dir, '999_new_table.sql'), 'SELECT 1;\n')
    const r = updateSums(dir, gitWith(files.slice(0, -1)))
    expect(r.added).toEqual(['999_new_table.sql'])
    expect(r.updated).toEqual([own])
    expect(r.refused).toHaveLength(1)
    expect(r.refused[0]).toContain(`server/sql/${applied} is on origin/main already`)
    const after = readSums(dir)
    expect(after.get(applied)).toBe(before.get(applied))
    expect(after.get(own)).toBe(migrationSum(dir, own))
    expect(sumProblems(dir)).toEqual([`${applied} differs from its line: it changed after it was listed`])
  })

  it('keeps the line of a migration on main that was deleted, and drops one of a branch\'s own', () => {
    const files = migrationFiles(dir)
    rmSync(path.join(dir, files[0]))
    rmSync(path.join(dir, files.at(-1)!))
    const r = updateSums(dir, gitWith([files[0]]))
    expect(r.refused[0]).toContain(files[0])
    expect([...readSums(dir).keys()]).toEqual(files.slice(0, -1))
  })

  it('asks origin/main, then main, and refuses a change to a file either has', () => {
    const file = migrationFiles(dir).at(-1)!
    const seen: string[] = []
    const none: GitRunner = (_cwd, args) => {
      seen.push(args[2])
      return false
    }
    expect(onMain(dir, file, none)).toBeNull()
    expect(seen).toEqual([`origin/main:./${file}`, `main:./${file}`])
    expect(changeRefusal(dir, file, none)).toBeNull()
    expect(onMain(dir, file, (_cwd, args) => args[2] === `main:./${file}`)).toBe('main')
    expect(changeRefusal(dir, file, gitWith([file]))).toContain('Make the change a new migration instead')
  })

  it('reads no git outside a git checkout (a copy in a temporary folder is never on main)', () => {
    expect(onMain(dir, migrationFiles(dir)[0])).toBeNull()
  })
})
