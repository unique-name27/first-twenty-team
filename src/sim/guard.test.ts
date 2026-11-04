// src/sim generates companies for tests and tools. The app must never import it, or the generator, its
// scenarios and the name pools would ship in the build: only files inside src/sim, test files and the
// development-only code in src/dev may (and tools outside src, such as npm run sim in scripts/dev). src/dev
// itself never reaches a build: src/dev/guard.test.ts holds every import of it to a dynamic import inside
// `if (import.meta.env.DEV)`. That covers imports Vite resolves from a pattern too (import.meta.glob, a
// template literal in import()) and files it bundles from a URL (new URL('...', import.meta.url), as a
// worker is started). This reads the source instead of building (a build is slow), the way
// src/sync/testing/guard.test.ts does. server/src/dev/structure.test.ts keeps src/sim out of the server's
// production bundle.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SIM = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(SIM, '..')
/** The development-only folder, relative to src as the users list writes it. */
const DEV_PREFIX = 'dev/'

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return full === SIM ? [] : sourceFiles(full)
    return /\.(ts|tsx)$/.test(e.name) ? [full] : []
  })
}

/**
 * Every module specifier in `code`: static imports and exports, dynamic import(), and files bundled from a
 * URL (new URL('./sim.worker.ts', import.meta.url), how a worker is started).
 */
function specifiers(code: string): string[] {
  const out: string[] = []
  for (const m of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1])
  for (const m of code.matchAll(/\bnew\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) out.push(m[1])
  for (const m of code.matchAll(/^\s*(?:import|export)\b[^'"`;]*?(?:\bfrom\s*)?['"]([^'"]+)['"]/gm)) out.push(m[1])
  return out
}

/**
 * Paths an import names only in part, which Vite still bundles: the patterns of import.meta.glob (and
 * globEager) calls, and template literals in import(), such as import(`../sim/${name}.ts`).
 */
function patterns(code: string): string[] {
  const out: string[] = []
  for (const m of code.matchAll(/\bimport\.meta\.glob(?:Eager)?\s*(?:<[^>]*>)?\s*\(\s*(\[[^\]]*\]|'[^']*'|"[^"]*"|`[^`]*`)/g)) {
    for (const lit of m[1].matchAll(/['"`]([^'"`]+)['"`]/g)) if (!lit[1].startsWith('!')) out.push(lit[1])
  }
  for (const m of code.matchAll(/\bimport\s*\(\s*`([^`]*)`\s*\)/g)) out.push(m[1])
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

/**
 * Whether a glob or template pattern could name a file in src/sim: its fixed start (up to the first *, ?,
 * {, [ or ${) is inside src/sim, or is a folder or the start of a name that src/sim falls under (as
 * ../../** does from a feature).
 */
function mayReachSim(pattern: string, fromFile: string): boolean {
  const cut = pattern.search(/[*?{[]|\$\{/)
  const base = resolve(cut < 0 ? pattern : pattern.slice(0, cut), fromFile)
  return base !== null && (insideSim(base) || SIM.startsWith(base))
}

/** Whether a file's code imports from src/sim, by a plain specifier or by a pattern. */
function importsSim(code: string, file: string): boolean {
  return specifiers(code).some((spec) => insideSim(resolve(spec, file))) || patterns(code).some((p) => mayReachSim(p, file))
}

describe('src/sim stays out of the app', () => {
  const users = sourceFiles(SRC)
    .filter((file) => importsSim(readFileSync(file, 'utf8'), file))
    .map((file) => path.relative(SRC, file).replace(/\\/g, '/'))

  it('is imported only by test files and the development-only code in src/dev, outside src/sim', () => {
    expect(users.filter((file) => !isTestFile(file) && !file.startsWith(DEV_PREFIX))).toEqual([])
  })

  it('finds the simulator panel among its users (so the test above checks something)', () => {
    expect(users).toContain('dev/sim/runner.ts')
  })

  it('finds an import of src/sim when one is there (so this test checks something)', () => {
    const file = path.join(SRC, 'features', 'home', 'Example.tsx')
    expect(importsSim("import { generateCompany } from '@/sim/generate'\n", file)).toBe(true)
    expect(importsSim("export { SCENARIOS } from '../../sim/scenarios'\n", file)).toBe(true)
    expect(importsSim("const s = await import('@/sim')\n", file)).toBe(true)
    expect(importsSim("import { simulate } from '@/simple'\n", file)).toBe(false)
  })

  it('finds src/sim reached through import.meta.glob or a template literal in import()', () => {
    const file = path.join(SRC, 'features', 'home', 'Example.tsx')
    expect(importsSim("const all = import.meta.glob('../../sim/*.ts')\n", file)).toBe(true)
    expect(importsSim("const all = import.meta.glob(['@/sim/**/*.ts', '!**/*.test.ts'], { eager: true })\n", file)).toBe(true)
    expect(importsSim("const everything = import.meta.glob('../../**/*.ts')\n", file)).toBe(true)
    expect(importsSim('const mod = await import(`../../sim/${name}.ts`)\n', file)).toBe(true)
    expect(importsSim("const icons = import.meta.glob('./icons/*.svg')\n", file)).toBe(false)
    expect(importsSim('const page = await import(`./pages/${name}.tsx`)\n', file)).toBe(false)
    expect(importsSim("const near = import.meta.glob('../../simple/*.ts')\n", file)).toBe(false)
  })

  it('finds src/sim bundled from a URL, as a worker is started', () => {
    const file = path.join(SRC, 'features', 'home', 'Example.tsx')
    expect(importsSim("const w = new Worker(new URL('../../sim/play.ts', import.meta.url), { type: 'module' })\n", file)).toBe(true)
    expect(importsSim("const u = new URL( '@/sim/play' , import.meta.url )\n", file)).toBe(true)
    expect(importsSim("const u = new URL('./icon.svg', import.meta.url)\n", file)).toBe(false)
  })
})
