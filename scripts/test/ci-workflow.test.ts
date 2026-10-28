// CI (.github/workflows/ci.yml) and the npm scripts it runs. The branch rule on main requires the check
// named "verify", and the server deploys a commit only once that check passed (auto-update.sh), so the
// "verify" job must wait for every other job and fail unless all of them passed. The repo has no YAML
// parser, so this reads the workflow's simple layout line by line: two-space indents, one key per line.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TIERS } from './tiers'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const workflow = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n')
const scripts = (JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts

type Job = { id: string; text: string; name?: string; needs: string[]; if?: string; runs: string[] }

/** The value of `key:` at exactly `indent` spaces in `text`, or undefined. */
function value(text: string, key: string, indent: number): string | undefined {
  const m = new RegExp(`^ {${indent}}${key}:[ \\t]*(.*)$`, 'm').exec(text)
  return m ? m[1].trim() : undefined
}

/** A list written inline ([a, b]), as one item (a), or as `- a` lines under the key. */
function list(text: string, key: string, indent: number): string[] {
  const inline = value(text, key, indent)
  if (inline === undefined) return []
  if (inline.startsWith('[')) return inline.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)
  if (inline !== '') return [inline]
  const after = text.split('\n')
  const start = after.findIndex((l) => l.startsWith(`${' '.repeat(indent)}${key}:`))
  const items: string[] = []
  for (const line of after.slice(start + 1)) {
    const m = new RegExp(`^ {${indent + 2}}- (.+)$`).exec(line)
    if (!m) break
    items.push(m[1].trim())
  }
  return items
}

/** Every job under `jobs:`, with its own lines. */
function jobs(): Job[] {
  const lines = workflow.split('\n')
  const start = lines.indexOf('jobs:')
  expect(start, 'a jobs: section').toBeGreaterThan(-1)
  const out: Job[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    const head = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (head) out.push({ id: head[1], text: '', needs: [], runs: [] })
    else if (out.length > 0) out[out.length - 1].text += `${line}\n`
  }
  for (const job of out) {
    job.name = value(job.text, 'name', 4)?.replace(/^['"]|['"]$/g, '')
    job.needs = list(job.text, 'needs', 4)
    job.if = value(job.text, 'if', 4)
    job.runs = [...job.text.matchAll(/^\s+(?:- )?run: (.+)$/gm)].map((m) => m[1].trim())
  }
  return out
}

describe('CI', () => {
  const all = jobs()
  const verify = all.find((j) => j.id === 'verify')
  const others = all.filter((j) => j !== verify)

  it('has the four jobs and the verify job', () => {
    expect(all.map((j) => [j.id, j.name])).toEqual([
      ['builds', 'typecheck and builds'],
      ['unit', 'unit'],
      ['server', 'server and journeys'],
      ['deploy', 'deploy kit'],
      ['verify', 'verify'],
    ])
    // Only one check may carry the required name.
    expect(all.filter((j) => j.name === 'verify' || (j.name === undefined && j.id === 'verify'))).toHaveLength(1)
  })

  it('makes verify wait for every other job, and run even when one of them failed', () => {
    expect(verify).toBeDefined()
    expect([...verify!.needs].sort()).toEqual(others.map((j) => j.id).sort())
    expect(verify!.if).toBe('always()')
  })

  it('fails verify unless every job it waits for succeeded', () => {
    const text = verify!.text
    for (const id of verify!.needs) {
      // Each result goes into an environment variable that the check compares with success.
      const m = new RegExp(`^\\s+([A-Z_]+): \\$\\{\\{ needs\\.${id}\\.result \\}\\}$`, 'm').exec(text)
      expect(m, `needs.${id}.result`).not.toBeNull()
      expect(text, id).toMatch(new RegExp(`for result in [^\\n]*"\\$${m![1]}"`))
    }
    expect(text).toContain('if [ "$result" != success ]; then')
    expect(text).toContain('exit 1')
  })

  it('runs every job on ubuntu-24.04 with Node 22 and the npm cache', () => {
    for (const job of all) expect(value(job.text, 'runs-on', 4), job.id).toBe('ubuntu-24.04')
    for (const job of others) {
      expect(job.text, job.id).toContain('uses: actions/setup-node@v5')
      expect(value(job.text, 'node-version', 10), job.id).toBe('22')
      expect(value(job.text, 'cache', 10), job.id).toBe('npm')
      expect(job.runs[0], job.id).toBe('npm ci')
    }
  })

  it('typechecks, builds the app and the server, and checks no development-only code reached them', () => {
    const builds = all.find((j) => j.id === 'builds')!
    expect(builds.runs.slice(0, 4)).toEqual(['npm ci', 'npm run typecheck', 'npm run build', 'npm run server:build'])
    // A missing build must fail the check, not pass it: grep on a missing file is false in an if.
    expect(builds.text).toContain('for built in first-twenty.html dist-server; do')
    expect(builds.text).toContain(`grep -q -e '__dev/credentials' -e 'autoconnect' first-twenty.html`)
    expect(builds.text).toContain(`grep -rq -F '/api/dev/' dist-server`)
  })

  it('runs every test tier in some job', () => {
    const run = others.flatMap((j) => j.runs)
    for (const tier of TIERS) expect(run, tier.name).toContain(`npm run test:${tier.name}`)
    expect(all.find((j) => j.id === 'unit')!.runs).toContain('npm run test:unit')
    expect(all.find((j) => j.id === 'server')!.runs).toEqual(['npm ci', 'npm run test:server', 'npm run test:e2e'])
    expect(all.find((j) => j.id === 'deploy')!.runs).toContain('npm run test:deploy')
  })

  it('keeps its triggers, read-only permissions and one run per branch', () => {
    expect(workflow).toMatch(/^on:\n {2}pull_request:\n {2}push:\n {4}branches: \[main, master\]\n {2}workflow_dispatch:\n/m)
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m)
    expect(workflow).toMatch(/^concurrency:\n {2}group: ci-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: true\n/m)
  })
})

describe('npm scripts for the tiers', () => {
  it('give each tier a script of its own', () => {
    for (const tier of TIERS) expect(scripts[`test:${tier.name}`], tier.name).toBe(`vitest run --project ${tier.name}`)
    expect(scripts.test).toBe('vitest run')
  })

  it('make verify run typecheck, every tier but the deploy kit, and the app build', () => {
    expect(scripts.verify).toBe('npm run typecheck && vitest run --project unit --project server --project e2e && npm run build')
    expect(TIERS.map((t) => t.name).filter((name) => !scripts.verify.includes(`--project ${name}`))).toEqual(['deploy'])
  })

  it('leave the deploy kit out of the quick runs too (it imports the server, and takes minutes on Windows)', () => {
    for (const name of ['test:changed', 'test:watch']) {
      expect(TIERS.map((t) => t.name).filter((tier) => !scripts[name].includes(`--project ${tier}`)), name).toEqual(['deploy'])
    }
    expect(scripts['test:changed'].startsWith('vitest run --changed origin/main ')).toBe(true)
    expect(scripts.check).toBe('npm run typecheck && npm run test:changed')
  })
})
