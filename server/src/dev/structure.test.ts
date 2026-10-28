// server/src/dev holds development-only server code (POST /__dev/sql for npm run sql). It stays out of
// production by structure: only the development entry, server/src/dev/index.ts, imports it, and npm run
// stack is the only thing that starts that entry. This walks the import graph of every production entry
// (the ones vite.server.config.ts bundles, which include server/src/index.ts, and app.ts on its own) and
// fails if any path reaches this folder. It reads the source instead of building (a build is slow).
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const DEV = path.join(ROOT, 'server', 'src', 'dev')
const rel = (file: string) => path.relative(ROOT, file).replace(/\\/g, '/')
const insideDev = (file: string) => file === DEV || file.startsWith(DEV + path.sep)

/** Every module specifier in `code`: static imports and re-exports, side-effect imports and import(). */
export function specifiers(code: string): string[] {
  const out: string[] = []
  for (const m of code.matchAll(/^\s*(?:import|export)\b[^'"`;]*?(?:\bfrom\s*)?['"]([^'"]+)['"]/gm)) out.push(m[1])
  for (const m of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1])
  return out
}

/** The file a specifier names (relative or @/), or null for a package. */
function resolve(spec: string, fromFile: string): string | null {
  const base = spec.startsWith('@/') ? path.join(ROOT, 'src', spec.slice(2)) : spec.startsWith('.') ? path.resolve(path.dirname(fromFile), spec) : null
  if (base === null) return null
  const stem = base.replace(/\.(m?js)$/, '')
  for (const candidate of [base, `${stem}.ts`, `${stem}.tsx`, `${base}.mjs`, path.join(base, 'index.ts')]) {
    if (existsSync(candidate) && !candidate.endsWith(path.sep) && /\.(ts|tsx|mjs|js|json)$/.test(candidate)) return candidate
  }
  throw new Error(`cannot resolve ${spec} from ${rel(fromFile)}`)
}

/** Every file `entry` reaches through imports, each with the chain that reaches it. */
function importGraph(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>([[entry, [rel(entry)]]])
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.shift()!
    if (!/\.(ts|tsx|mjs)$/.test(file)) continue
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      const target = resolve(spec, file)
      if (target === null || seen.has(target)) continue
      seen.set(target, [...seen.get(file)!, rel(target)])
      queue.push(target)
    }
  }
  return seen
}

/** The entries vite.server.config.ts bundles into dist-server. */
function buildEntries(): string[] {
  const config = readFileSync(path.join(ROOT, 'vite.server.config.ts'), 'utf8')
  const input = /input:\s*\{([\s\S]*?)\}/.exec(config)?.[1] ?? ''
  return [...input.matchAll(/['"]([^'"]+\.ts)['"]/g)].map((m) => path.join(ROOT, m[1]))
}

describe('server/src/dev stays out of production', () => {
  const entries = buildEntries()

  it('reads the production entries from vite.server.config.ts (so this test checks something)', () => {
    expect(entries.map(rel)).toEqual(expect.arrayContaining(['server/src/index.ts', 'server/src/cli/migrate.ts']))
    expect(entries.filter(insideDev)).toEqual([])
  })

  for (const entry of [...entries.map(rel), 'server/src/app.ts']) {
    it(`is never imported from ${entry}`, () => {
      const graph = importGraph(path.join(ROOT, entry))
      if (entry === 'server/src/index.ts') {
        expect([...graph.keys()].map(rel)).toEqual(expect.arrayContaining(['server/src/serve.ts', 'server/src/app.ts', 'server/src/repo.ts', 'src/sync/collections.ts']))
      }
      const reached = [...graph.entries()].filter(([file]) => insideDev(file)).map(([, chain]) => chain.join(' -> '))
      expect(reached, 'production code must not import server/src/dev').toEqual([])
    })
  }

  it('is started by npm run stack only, through the development entry', () => {
    expect(readFileSync(path.join(ROOT, 'scripts', 'dev', 'stack.mjs'), 'utf8')).toContain("'server/src/dev/index.ts'")
    const scripts = (JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
    for (const [name, command] of Object.entries(scripts)) expect(command, `npm run ${name}`).not.toContain('server/src/dev')
  })

  it('reads the import forms this test relies on', () => {
    const sample = "import { a } from './a'\nimport type { B } from '../b'\nexport { c } from '@/c'\nimport './d'\nimport {\n  e,\n} from './e'\nconst f = await import('./f')\n"
    expect(specifiers(sample)).toEqual(['./a', '../b', '@/c', './d', './e', './f'])
  })
})
