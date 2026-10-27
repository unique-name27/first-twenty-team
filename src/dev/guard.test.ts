// src/dev holds development-only code (the dev auto sign-in, docs/DEV.md). It must never reach a build:
// every import of it is a dynamic import inside `if (import.meta.env.DEV)`, which Vite turns into
// `if (false)` and drops, module and all. This reads the source instead of building (a build is slow).
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEV = path.join(SRC, 'dev')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return full === DEV ? [] : sourceFiles(full)
    return /\.(ts|tsx)$/.test(e.name) ? [full] : []
  })
}

/** Every module specifier in `code`, with the line it is on and whether it is a dynamic import(). */
function imports(code: string): { spec: string; line: string; dynamic: boolean }[] {
  const out: { spec: string; line: string; dynamic: boolean }[] = []
  const lines = code.split('\n')
  const lineAt = (index: number) => lines[code.slice(0, index).split('\n').length - 1]
  for (const m of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push({ spec: m[1], line: lineAt(m.index), dynamic: true })
  for (const m of code.matchAll(/^\s*(?:import|export)\b[^'"`;]*?(?:\bfrom\s*)?['"]([^'"]+)['"]/gm)) out.push({ spec: m[1], line: lineAt(m.index), dynamic: false })
  return out
}

/** Where a specifier points inside src, or null for packages. */
function resolve(spec: string, fromFile: string): string | null {
  if (spec.startsWith('@/')) return path.join(SRC, spec.slice(2))
  if (spec.startsWith('.')) return path.resolve(path.dirname(fromFile), spec)
  return null
}

const insideDev = (p: string | null) => p !== null && (p === DEV || p.startsWith(DEV + path.sep))

describe('src/dev stays out of production builds', () => {
  const uses = sourceFiles(SRC).flatMap((file) =>
    imports(readFileSync(file, 'utf8'))
      .filter((i) => insideDev(resolve(i.spec, file)))
      .map((i) => ({ ...i, file: path.relative(SRC, file).replace(/\\/g, '/') })),
  )

  it('finds the dev auto sign-in import in main.tsx (so this test checks something)', () => {
    expect(uses.map((u) => u.file)).toContain('main.tsx')
  })

  it('imports src/dev only dynamically, inside if (import.meta.env.DEV)', () => {
    for (const use of uses) {
      expect(use.dynamic, `${use.file}: a static import of ${use.spec} would ship in every build`).toBe(true)
      expect(use.line, `${use.file}: import(${use.spec}) must sit inside if (import.meta.env.DEV)`).toMatch(/^\s*if \(import\.meta\.env\.DEV\) /)
    }
  })

  it('reads the import patterns this test relies on', () => {
    const sample = "import { a } from '@/dev/x'\nexport { b } from './dev/y'\nif (import.meta.env.DEV) void import('./dev/z')\n"
    expect(imports(sample).map((i) => [i.spec, i.dynamic])).toEqual([
      ['./dev/z', true],
      ['@/dev/x', false],
      ['./dev/y', false],
    ])
  })
})
