// The pure parts of npm run sim: the command line, durations, the company reset puts on today, the
// company's date between commands, the cache key and save names; that it runs in California time on every
// computer; and that npm run sim only ever talks to this computer.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { pacificDateOf } from '@/domain/hiring/util'
import { integrityProblems } from '@/domain/integrity'
import { periodContaining } from '@/domain/payrun'
import { parseBackup } from '@/features/settings/logic'
import { getClockOverride, quarterOf, today } from '@/lib/dates'
import { generateCompany } from '@/sim/generate'
import {
  advanceTarget,
  cacheFileName,
  cachePrefix,
  companyDateFor,
  type Generated,
  parseDuration,
  parseSimArgs,
  resetCompany,
  saveNameProblem,
  scenarioLines,
  sourceHash,
  specifiers,
  weekShift,
  workspaceJson,
} from './sim-lib'

const base = { scenario: null, seed: null, asOf: null, out: null, shift: true, duration: null, policy: 'normal', name: null, offset: 0 }

describe('parseSimArgs', () => {
  it('reads each command', () => {
    expect(parseSimArgs([])).toEqual({ ...base, command: 'help' })
    expect(parseSimArgs(['list'])).toEqual({ ...base, command: 'list' })
    expect(parseSimArgs(['run', 'full-20', '--seed', '7', '--as-of', '2026-09-01', '--out', 'co.json'])).toEqual({
      ...base,
      command: 'run',
      scenario: 'full-20',
      seed: 7,
      asOf: '2026-09-01',
      out: 'co.json',
    })
    expect(parseSimArgs(['reset', 'seed-8', '--seed=3', '--no-shift'])).toEqual({ ...base, command: 'reset', scenario: 'seed-8', seed: 3, shift: false })
    expect(parseSimArgs(['advance', '30d', '--policy', 'busy', '--seed', '0'])).toEqual({ ...base, command: 'advance', duration: '30d', policy: 'busy', seed: 0 })
    expect(parseSimArgs(['save', 'before-payroll'])).toEqual({ ...base, command: 'save', name: 'before-payroll' })
    expect(parseSimArgs(['restore', 'before-payroll'])).toEqual({ ...base, command: 'restore', name: 'before-payroll' })
    expect(parseSimArgs(['saves'])).toEqual({ ...base, command: 'saves' })
  })

  it('takes --offset anywhere, and --help over everything', () => {
    expect(parseSimArgs(['--offset', '80', 'reset', 'full-20'])).toMatchObject({ command: 'reset', offset: 80 })
    expect(parseSimArgs(['advance', '12w', '--offset=10'])).toMatchObject({ command: 'advance', offset: 10, duration: '12w' })
    expect(parseSimArgs(['reset', 'nope', '--help']).command).toBe('help')
  })

  it('says what is wrong', () => {
    const wrong: Array<[string[], RegExp]> = [
      [['go'], /Unknown command "go"/],
      [['run'], /run needs a scenario/],
      [['run', 'nope'], /No scenario named "nope"/],
      [['run', 'seed-8', 'full-20'], /once/],
      [['list', 'extra'], /takes nothing after it/],
      [['advance'], /how far to go/],
      [['advance', '30'], /30d, 12w, 3m/],
      [['advance', '0d'], /at least one day/],
      [['advance', '30d', '--policy', 'lazy'], /quiet, normal, busy/],
      [['advance', '30d', '--out', 'x.json'], /advance does not take --out/],
      [['reset', 'seed-8', '--policy', 'busy'], /reset does not take --policy/],
      [['run', 'seed-8', '--seed', '-1'], /whole number/],
      [['run', 'seed-8', '--seed', '1.5'], /whole number/],
      [['run', 'seed-8', '--seed'], /--seed needs a value/],
      [['run', 'seed-8', '--as-of', '2026-02-30'], /YYYY-MM-DD/],
      [['run', 'seed-8', '--offset', '1001'], /at most 1000/],
      [['run', 'seed-8', '--offset', 'ten'], /whole number/],
      [['run', 'seed-8', '--fast'], /Unknown option "--fast"/],
      [['reset', 'seed-8', '--no-shift=yes'], /takes no value/],
      [['save', '../outside'], /name is 1 to 64/],
      [['save', 'a/b'], /name is 1 to 64/],
    ]
    for (const [argv, message] of wrong) expect(() => parseSimArgs(argv), argv.join(' ')).toThrow(message)
  })
})

describe('durations', () => {
  it('reads days, weeks, months and dates', () => {
    expect(parseDuration('30d')).toEqual({ days: 30 })
    expect(parseDuration('12w')).toEqual({ days: 84 })
    expect(parseDuration('3m')).toEqual({ months: 3 })
    expect(parseDuration('2026-12-01')).toEqual({ date: '2026-12-01' })
    for (const bad of ['', '30', 'd', '1y', '-3d', '30 d', '30D', '2026-13-01', '12345d']) expect(() => parseDuration(bad), bad).toThrow()
  })

  it('counts from the company date', () => {
    expect(advanceTarget(parseDuration('30d'), '2026-10-28')).toBe('2026-11-27')
    expect(advanceTarget(parseDuration('12w'), '2026-10-28')).toBe('2027-01-20')
    expect(advanceTarget(parseDuration('3m'), '2026-08-31')).toBe('2026-11-30')
    expect(advanceTarget(parseDuration('1m'), '2026-01-31')).toBe('2026-02-28')
    expect(advanceTarget(parseDuration('2026-12-01'), '2026-10-28')).toBe('2026-12-01')
  })
})

describe('weekShift', () => {
  const coverage = { from: '2025-01-01', to: '2026-12-31' }
  const weekday = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay()

  it('picks the same weekday on or before today, whole weeks away, and the days left', () => {
    // 2026-10-09 is a Friday; 2026-10-28 a Wednesday.
    expect(weekShift({ asOf: '2026-10-09', today: '2026-10-28', coverage })).toEqual({ days: 14, movedAsOf: '2026-10-23', rest: 5 })
    expect(weekShift({ asOf: '2026-10-09', today: '2026-10-30', coverage })).toEqual({ days: 21, movedAsOf: '2026-10-30', rest: 0 })
    expect(weekShift({ asOf: '2026-10-09', today: '2026-10-09', coverage })).toEqual({ days: 0, movedAsOf: '2026-10-09', rest: 0 })
    // Today before the as-of date: back to the Friday before today.
    expect(weekShift({ asOf: '2026-10-09', today: '2026-10-01', coverage })).toEqual({ days: -14, movedAsOf: '2026-09-25', rest: 6 })
    for (const today of ['2026-10-10', '2026-11-03', '2026-12-31', '2026-08-14']) {
      const s = weekShift({ asOf: '2026-10-09', today, coverage })
      expect(s.days % 7 === 0, today).toBe(true)
      expect(weekday(s.movedAsOf), today).toBe(weekday('2026-10-09'))
      expect(s.rest >= 0 && s.rest <= 6, today).toBe(true)
    }
  })

  it('refuses a today past the law coverage', () => {
    expect(() => weekShift({ asOf: '2026-10-09', today: '2027-01-04', coverage })).toThrow(/2027-01-04, is after the dates the built-in rules cover \(2025-01-01 to 2026-12-31/)
  })
})

describe('reset', () => {
  /** What sim.ts passes resetCompany: the scenario generated as of a date (here without the cache). */
  const generate = (scenario: 'payroll-edge' | 'seed-8', seed: number) => (asOf: string): Generated => {
    const g = generateCompany({ scenario, seed, asOf })
    return { db: g.db, summary: g.summary, cached: false, ms: 0 }
  }

  it('generates the scenario on the date that puts it on today, so holidays, plan quarters and pay periods hold', () => {
    // Moving the company made for 2026-10-09 two weeks on put interviews on Labor Day, Thanksgiving and
    // Memorial Day, and left a plan line in 2026-Q3 with a start in October.
    const r = resetCompany({ scenario: 'payroll-edge', seed: 7070, asOf: '2026-10-09', shift: true, today: '2026-10-28' }, generate('payroll-edge', 7070))
    expect(r.companyDate).toBe('2026-10-28')
    expect(r.generated.summary).toContain('Seed 7070, as of 2026-10-23.')
    expect(r.note).toMatch(/^Generated as of 2026-10-23, the last Friday on or before today, then lived 5 days to today, 2026-10-28 \(normal policy, \d+ actions\)\.$/)
    const { db } = r
    const holidays = new Set(db.holidays.map((h) => h.date))
    expect(db.interviews.filter((i) => holidays.has(pacificDateOf(i.startsAt))).map((i) => i.startsAt)).toEqual([])
    expect(db.people.filter((p) => holidays.has(p.startDate)).map((p) => p.startDate)).toEqual([])
    expect(db.plan.filter((s) => s.quarter !== quarterOf(s.targetStart)).map((s) => `${s.title} ${s.targetStart} ${s.quarter}`)).toEqual([])
    // payroll-edge's last day still falls inside a pay period, not on its first day.
    const lastDay = db.people.find((p) => p.separation?.type === 'terminated')?.separation?.lastDay as string
    expect(lastDay > periodContaining(db, lastDay).start).toBe(true)
    expect(integrityProblems(db)).toEqual([])
    expect(getClockOverride()).toBeNull()
  })

  it('keeps the scenario on its as-of date with --no-shift, and lives no days when today is that weekday', () => {
    const kept = resetCompany({ scenario: 'seed-8', seed: 8008, asOf: '2026-10-09', shift: false, today: '2026-10-28' }, generate('seed-8', 8008))
    expect([kept.companyDate, kept.note]).toEqual(['2026-10-09', expect.stringMatching(/^Kept on its as-of date, 2026-10-09 \(--no-shift\)/)])
    const friday = resetCompany({ scenario: 'seed-8', seed: 8008, asOf: '2026-10-09', shift: true, today: '2026-10-30' }, generate('seed-8', 8008))
    expect([friday.companyDate, friday.note]).toEqual(['2026-10-30', 'Generated as of 2026-10-30, the last Friday on or before today: today.'])
    expect(friday.db).toBe(friday.generated.db)
  })
})

describe('the company date between commands', () => {
  it('is the remembered date while the server holds the same copy, else today', () => {
    const remembered = { historyId: 'h-1', date: '2026-11-27' }
    expect(companyDateFor(remembered, 'h-1', '2026-10-28')).toBe('2026-11-27')
    expect(companyDateFor(remembered, 'h-2', '2026-10-28')).toBe('2026-10-28')
    expect(companyDateFor(null, 'h-1', '2026-10-28')).toBe('2026-10-28')
    expect(companyDateFor({ historyId: 'h-1', date: 'soon' }, 'h-1', '2026-10-28')).toBe('2026-10-28')
  })
})

describe('the cache key', () => {
  const hash = 'a'.repeat(64)

  it('names every part of the key in the file name', () => {
    expect(cacheFileName({ scenario: 'full-20', seed: 2020, asOf: '2026-10-09', sourceHash: hash })).toBe('full-20-2020-2026-10-09-aaaaaaaaaaaaaaaa.json')
    expect(cacheFileName({ scenario: 'full-20', seed: 2020, asOf: '2026-10-09', sourceHash: hash }).startsWith(cachePrefix({ scenario: 'full-20', seed: 2020, asOf: '2026-10-09' }))).toBe(true)
    expect(cachePrefix({ scenario: 'seed-8', seed: 1, asOf: '2026-10-09' })).not.toBe(cachePrefix({ scenario: 'seed-8', seed: 12, asOf: '2026-10-09' }).slice(0, -1))
    expect(() => cacheFileName({ scenario: 'full-20', seed: 1, asOf: '2026-10-09', sourceHash: '../x' })).toThrow()
  })

  it('hashes every file the entry reaches through imports, and changes when any of them does', () => {
    const root = path.resolve('/repo')
    const at = (p: string) => path.join(root, p)
    const files: Record<string, string> = {
      [at('src/sim/generate.ts')]: "import { a } from './a'\nimport type { T } from '@/domain/types'\nimport { z } from 'zod'\nexport const g = 1\n",
      [at('src/sim/a.ts')]: "export { b } from '../lib/b.ts'\nconst later = () => import('@/data/law')\n",
      [at('src/lib/b.ts')]: 'export const b = 2\n',
      [at('src/domain/types.ts')]: 'export type T = 1\n',
      [at('src/data/law/index.ts')]: 'export const law = 2026\n',
      [at('src/unrelated.ts')]: 'export const u = 0\n',
    }
    const hashOf = (f: Record<string, string>) => sourceHash([at('src/sim/generate.ts')], root, (file) => f[file])
    const first = hashOf(files)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(hashOf({ ...files })).toBe(first)
    expect(hashOf({ ...files, [at('src/unrelated.ts')]: 'export const u = 1\n' })).toBe(first)
    expect(hashOf({ ...files, [at('src/sim/generate.ts')]: files[at('src/sim/generate.ts')].replace(/\n/g, '\r\n') })).toBe(first)
    for (const changed of ['src/lib/b.ts', 'src/domain/types.ts', 'src/data/law/index.ts', 'src/sim/a.ts']) {
      expect(hashOf({ ...files, [at(changed)]: `${files[at(changed)]}// edited\n` }), changed).not.toBe(first)
    }
    const missing = { ...files }
    delete missing[at('src/lib/b.ts')]
    expect(() => hashOf(missing)).toThrow(/Cannot find \.\.\/lib\/b\.ts/)
  })

  it('reads the import forms the hash relies on', () => {
    const sample = "import { a } from './a'\nimport type { B } from '../b'\nexport { c } from '@/c'\nimport './d'\nimport {\n  e,\n} from './e'\nconst f = await import('./f')\n"
    expect(specifiers(sample)).toEqual(['./a', '../b', '@/c', './d', './e', './f'])
  })
})

describe('saves and output', () => {
  it('takes plain file names only', () => {
    for (const ok of ['before-payroll', 'q4.v2', 'A_1']) expect(saveNameProblem(ok), ok).toBeNull()
    for (const bad of ['', '.hidden', '-x', 'a/b', 'a\\b', 'a..b', 'x'.repeat(65), 'with space', 'café']) expect(saveNameProblem(bad), bad).not.toBeNull()
  })

  it('writes JSON the app\'s Import accepts', () => {
    for (const scenario of ['blank', 'payroll-edge'] as const) {
      const g = generateCompany({ scenario })
      const parsed = parseBackup(workspaceJson(g.db))
      expect(parsed.ok, scenario).toBe(true)
    }
  })

  it('lists every scenario on its own line', () => {
    const lines = scenarioLines()
    expect(lines).toHaveLength(8)
    expect(lines.find((l) => l.trim().startsWith('stress'))).toMatch(/too big for reset/)
    expect(lines.find((l) => l.trim().startsWith('full-20'))).toMatch(/full company of 20/)
  })
})

describe('the time zone', () => {
  it("is California, so a computer east of UTC builds the same company and reset uses California's today", async () => {
    const zone = process.env.TZ
    try {
      const inUtc = JSON.stringify(generateCompany({ scenario: 'payroll-edge' }).db)
      // Tokyo: 9:30 AM in California is already the next day there, so a run refuses it.
      process.env.TZ = 'Asia/Tokyo'
      expect(() => generateCompany({ scenario: 'payroll-edge' })).toThrow(/in this computer's time zone/)
      const { SIM_TIME_ZONE } = await import('./sim-zone')
      expect(process.env.TZ).toBe(SIM_TIME_ZONE)
      expect(JSON.stringify(generateCompany({ scenario: 'payroll-edge' }).db)).toBe(inUtc)
      // 8 PM on Oct 28 in California is Oct 29 in UTC and in Tokyo.
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-10-29T03:00:00Z'))
      expect(today()).toBe('2026-10-28')
    } finally {
      vi.useRealTimers()
      process.env.TZ = zone
    }
  })

  it('is set by sim.ts before anything else is imported', () => {
    const imports = [...readFileSync('scripts/dev/sim.ts', 'utf8').matchAll(/^import\b.*$/gm)].map((m) => m[0])
    expect(imports[0]).toBe("import './sim-zone'")
  })
})

describe("the stack's database folder", () => {
  it('is opened only as a copy, never written in place (pg-swap.mjs swaps the copy in)', () => {
    const code = readFileSync('scripts/dev/sim.ts', 'utf8')
    expect([...code.matchAll(/openPGlite\((\w+)/g)].map((m) => m[1])).toEqual(['copyToWork'])
  })

  it('is left to a process that hears Ctrl+C itself: npm runs node, not the tsx command, which force-stops its child', () => {
    const scripts = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts
    expect(scripts.sim).toBe('node --import tsx scripts/dev/sim.ts')
  })
})

describe('npm run sim stays on this computer', () => {
  const sources =['scripts/dev/sim.ts', 'scripts/dev/sim-lib.ts', 'scripts/dev/sim-zone.ts', 'scripts/dev/stack-api.ts'].map((file) => [file, readFileSync(file, 'utf8')] as const)

  it('never reads DATABASE_URL, a .env file or the server settings', () => {
    for (const [file, code] of sources) {
      // The header comment says so in words; the code itself must not touch them. Setting its own time zone
      // (sim-zone.ts) is the one use of the environment.
      const body = code.replace(/^\/\/.*$/gm, '')
      expect(body, file).not.toMatch(/DATABASE_URL|loadConfig|loadDotEnv|process\.env(?!\.TZ = SIM_TIME_ZONE$)/m)
    }
  })

  it('only ever calls 127.0.0.1', () => {
    const urls = sources.flatMap(([, code]) => [...code.matchAll(/`(\w+:\/\/[^`]*)`/g)].map((m) => m[1]))
    expect(urls.sort()).toEqual(['http://127.0.0.1:${port}${DEV_WORKSPACE_PATH}', 'http://127.0.0.1:${port}/api/health'])
  })
})
