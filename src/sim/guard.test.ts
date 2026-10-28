// src/sim generates companies for tests and tools. The app must never import it, or the generator, its
// scenarios and the name pools would ship in the build: only files inside src/sim and test files may (and
// tools outside src, such as npm run sim in scripts/dev). This reads the source instead of building (a build
// is slow), the way src/sync/testing/guard.test.ts does.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SIM = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(SIM, '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return full === SIM ? [] : sourceFiles(full)
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

const insideSim = (p: string | null) => p !== null && (p === SIM || p.startsWith(SIM + path.sep))
const isTestFile = (file: string) => /\.test\.tsx?$/.test(file)

describe('src/sim stays out of the app', () => {
  const users = sourceFiles(SRC)
    .filter((file) => specifiers(readFileSync(file, 'utf8')).some((spec) => insideSim(resolve(spec, file))))
    .map((file) => path.relative(SRC, file).replace(/\\/g, '/'))

  it('is imported by test files only, outside src/sim', () => {
    expect(users.filter((file) => !isTestFile(file))).toEqual([])
  })

  it('finds an import of src/sim when one is there (so this test checks something)', () => {
    const file = path.join(SRC, 'features', 'home', 'Example.tsx')
    expect(specifiers("import { generateCompany } from '@/sim/generate'\n").some((spec) => insideSim(resolve(spec, file)))).toBe(true)
    expect(specifiers("export { SCENARIOS } from '../../sim/scenarios'\n").some((spec) => insideSim(resolve(spec, file)))).toBe(true)
    expect(specifiers("const s = await import('@/sim')\n").some((spec) => insideSim(resolve(spec, file)))).toBe(true)
    expect(specifiers("import { simulate } from '@/simple'\n").some((spec) => insideSim(resolve(spec, file)))).toBe(false)
  })
})
