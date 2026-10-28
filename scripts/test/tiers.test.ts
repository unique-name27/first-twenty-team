// The test tiers (tiers.ts): every test file runs in exactly one of them, the Vitest config builds its
// projects from them, and every run is in UTC.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfigFnObject } from 'vite'
import { defaultExclude } from 'vitest/config'
import { describe, expect, it } from 'vitest'
import viteConfig from '../../vite.config'
import { SERVER_DRIVEN_TESTS, TIERS } from './tiers'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Anything a test runner could pick up: name.test.ts, name.spec.mjs, name.test.tsx and so on. */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/

/**
 * Every test file in the repo, as a path from the root with forward slashes. Skips node_modules, the
 * build folders (dist*) and dot folders (.git, .data and the like), which hold no tests of ours.
 */
function testFiles(dir = ROOT): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name.startsWith('dist')) return []
      return testFiles(path.join(dir, entry.name))
    }
    return TEST_FILE.test(entry.name) ? [path.relative(ROOT, path.join(dir, entry.name)).split(path.sep).join('/')] : []
  })
}

const matches = (file: string, globs: string[]) => globs.some((glob) => path.posix.matchesGlob(file, glob))
const tiersOf = (file: string) => TIERS.filter((t) => matches(file, t.include) && !matches(file, t.exclude)).map((t) => t.name)

describe('test tiers', () => {
  const files = testFiles()

  it('finds the test files', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files).toContain('scripts/test/tiers.test.ts')
  })

  it('put every test file in exactly one tier', () => {
    const misfiled = files.map((file) => ({ file, tiers: tiersOf(file) })).filter((f) => f.tiers.length !== 1)
    // A file listed here runs in no tier (so in no npm script and no CI job), or in two. Move it under one
    // tier's folder, or add it to that tier in scripts/test/tiers.ts.
    expect(misfiled).toEqual([])
  })

  it('give each tier at least one test file', () => {
    for (const tier of TIERS) expect(files.some((f) => tiersOf(f)[0] === tier.name), tier.name).toBe(true)
  })

  it('keep the tests that drive the real server out of the unit tier, decided by what each file does', () => {
    // Under src/ and scripts/, a test that loads code from server/src (a relative path up into it) starts
    // the API, so it is a journey.
    const loadsServer = (f: string) => /\.\.\/server\/src\//.test(readFileSync(path.join(ROOT, f), 'utf8'))
    const reachesServer = files.filter((f) => /^(src|scripts)\//.test(f) && loadsServer(f))
    expect(reachesServer.sort()).toEqual([...SERVER_DRIVEN_TESTS].sort())
    for (const file of SERVER_DRIVEN_TESTS) expect(tiersOf(file)).toEqual(['e2e'])
  })

  it('are the Vitest projects, with the default excludes kept', () => {
    const config = (viteConfig as UserConfigFnObject)({ command: 'serve', mode: 'test' }) as { test?: { projects?: unknown[] } }
    expect(config.test?.projects).toEqual(
      TIERS.map((t) => ({ extends: true, test: { name: t.name, include: t.include, exclude: [...defaultExclude, ...t.exclude] } })),
    )
  })
})

describe('every test run', () => {
  it('is in UTC, whatever the computer says', () => {
    expect(process.env.TZ).toBe('UTC')
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('UTC')
    expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(0)
    expect(new Date(2026, 6, 1).toISOString()).toBe('2026-07-01T00:00:00.000Z')
  })
})
