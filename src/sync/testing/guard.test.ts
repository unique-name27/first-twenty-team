// src/sync/testing holds helpers for tests only (an in-memory sync world, fetch over app.inject). The app
// must never import it, or the helpers would ship in the build: only test files may. This reads the
// source instead of building (a build is slow), the way src/dev/guard.test.ts does.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const TESTING = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(TESTING, '..', '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return full === TESTING ? [] : sourceFiles(full)
    return /\.(ts|tsx)$/.test(e.name) ? [full] : []
  })
}

/** Every module specifier in `code`: static imports and exports, and dynamic import(). */
function specifiers(code: string): string[] {
  const out: string[] = []
  for (const m of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1])
  for (const m of code.matchAll(/^\s*(?:import|export)\b[^'"`;]*?(?:\bfrom\s*)?['"]([^'"]+)['"]/gm)) out.push(m[1])
  return out
}

/** Where a specifier points inside src, or null for packages. */
function resolve(spec: string, fromFile: string): string | null {
  if (spec.startsWith('@/')) return path.join(SRC, spec.slice(2))
  if (spec.startsWith('.')) return path.resolve(path.dirname(fromFile), spec)
  return null
}

const insideTesting = (p: string | null) => p !== null && (p === TESTING || p.startsWith(TESTING + path.sep))
const isTestFile = (file: string) => /\.test\.tsx?$/.test(file)

describe('src/sync/testing stays out of the app', () => {
  const users = sourceFiles(SRC)
    .filter((file) => specifiers(readFileSync(file, 'utf8')).some((spec) => insideTesting(resolve(spec, file))))
    .map((file) => path.relative(SRC, file).replace(/\\/g, '/'))

  it('finds the round trip tests among its users (so this test checks something)', () => {
    expect(users).toContain('sync/roundtrip.test.ts')
  })

  it('is imported by test files only', () => {
    expect(users.filter((file) => !isTestFile(file))).toEqual([])
  })

  it('reads the import patterns this test relies on', () => {
    const sample = "import { a } from '@/sync/testing/kit'\nexport { b } from './testing/inject'\nconst c = await import('../sync/testing/kit')\n"
    expect(specifiers(sample).sort()).toEqual(['../sync/testing/kit', './testing/inject', '@/sync/testing/kit'])
  })
})
