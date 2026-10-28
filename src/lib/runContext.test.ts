// Runs make ids and timestamps reproducible: the same seed gives the same ids, nowISO gives the pretend date
// at the run's Pacific time of day, a run always ends and never nests, and outside a run newId and nowISO
// behave exactly as they did before runs existed (compared with copies of that code below).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nowISO, parseDate, setClockOverride } from './dates'
import { newId } from './id'
import { activeRun, type RunOptions, withRunContext } from './runContext'

const RUN: RunOptions = { seed: 'ledgerlark', actorId: 'p-founder', timeOfDay: '10:30' }
const RUN_ID = /^[a-z]+-s[0-9a-z]{9}$/
const APP_ID = /^[a-z]+-[0-9a-f]{10}$/

/** newId before runs existed, kept here to compare with. */
function newIdBefore(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 10)
      : Math.random().toString(36).slice(2, 12)
  return `${prefix}-${rand}`
}

/** nowISO before runs existed, with the override passed in, kept here to compare with. */
function nowISOBefore(clockOverride: string | null): string {
  const real = new Date()
  if (!clockOverride) return real.toISOString()
  const d = parseDate(clockOverride)
  d.setHours(real.getHours(), real.getMinutes(), real.getSeconds(), 0)
  return d.toISOString()
}

/** What a run makes: a few ids and its now. */
function sample(options: RunOptions = RUN) {
  return withRunContext(options, () => ({ ids: [newId('p'), newId('act'), newId('c'), newId('act')], at: nowISO() }))
}

afterEach(() => {
  setClockOverride(null)
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('withRunContext', () => {
  it('gives identical ids and timestamps to two runs with the same seed', () => {
    setClockOverride('2026-10-09')
    const first = sample()
    expect(sample()).toEqual(first)
    for (const id of first.ids) expect(id).toMatch(RUN_ID)
    // The same on every computer and in every version: a recorded simulation stays reproducible.
    expect(first.ids).toEqual(['p-s0lqetgn7i', 'act-spacddy1bq', 'c-snydcd0nd9', 'act-s3ixgf1slv'])
    expect(first.at).toBe('2026-10-09T17:30:00.000Z')
  })

  it('gives different ids to different seeds', () => {
    setClockOverride('2026-10-09')
    const ids = (seed: number | string) => withRunContext({ ...RUN, seed }, () => Array.from({ length: 200 }, () => newId('p')))
    const seven = ids(7)
    for (const other of [ids(8), ids('seven'), ids('ledgerlark')]) {
      expect(other.filter((id) => seven.includes(id))).toEqual([])
    }
    // 7 and '7' are the same seed.
    expect(ids('7')).toEqual(seven)
  })

  it('never repeats an id within a run, across prefixes too', () => {
    const suffixes = withRunContext(RUN, () => Array.from({ length: 20_000 }, (_, i) => newId(i % 2 ? 'p' : 'act').split('-')[1]))
    expect(new Set(suffixes).size).toBe(suffixes.length)
  })

  it('makes ids that never look like the app\'s random ones', () => {
    const ids = withRunContext(RUN, () => Array.from({ length: 1000 }, () => newId('p')))
    expect(ids.filter((id) => APP_ID.test(id))).toEqual([])
  })

  it('puts now at the time of day in California on the pretend date, standard time or daylight time', () => {
    const at = (date: string, timeOfDay: string) => {
      setClockOverride(date)
      return withRunContext({ ...RUN, timeOfDay }, () => [nowISO(), nowISO()])
    }
    expect(at('2026-10-09', '10:30')).toEqual(['2026-10-09T17:30:00.000Z', '2026-10-09T17:30:00.000Z'])
    expect(at('2026-12-01', '10:30')).toEqual(['2026-12-01T18:30:00.000Z', '2026-12-01T18:30:00.000Z'])
    expect(at('2026-10-09', '09:05:42')).toEqual(['2026-10-09T16:05:42.000Z', '2026-10-09T16:05:42.000Z'])
    // The clock moves inside a run, and now moves with it.
    setClockOverride('2026-10-09')
    expect(
      withRunContext(RUN, () => {
        const before = nowISO()
        setClockOverride('2026-10-12')
        return [before, nowISO()]
      }),
    ).toEqual(['2026-10-09T17:30:00.000Z', '2026-10-12T17:30:00.000Z'])
  })

  it('refuses a now with no pretend date, or one on another date in this time zone (tests run in UTC)', () => {
    expect(() => withRunContext(RUN, () => nowISO())).toThrow('A run needs a pretend date: call setClockOverride before nowISO inside withRunContext.')
    setClockOverride('2026-10-09')
    expect(withRunContext({ ...RUN, timeOfDay: '16:59' }, () => nowISO())).toBe('2026-10-09T23:59:00.000Z')
    expect(() => withRunContext({ ...RUN, timeOfDay: '17:00' }, () => nowISO())).toThrow(
      "The run's time of day, 17:00 on 2026-10-09 in California (2026-10-10T00:00:00.000Z), is on 2026-10-10 in this computer's time zone.",
    )
    expect(activeRun()).toBeNull()
  })

  it('refuses a time of day it cannot read, and starts no run', () => {
    for (const timeOfDay of ['9:30', '24:00', '10:60', '10:30:60', '10:30 AM', '']) {
      expect(() => withRunContext({ ...RUN, timeOfDay }, () => 'ran')).toThrow(`A run's time of day is 'HH:MM' or 'HH:MM:SS' (24-hour), not '${timeOfDay}'.`)
      expect(activeRun()).toBeNull()
    }
    expect(() => withRunContext({ ...RUN, seed: Number.NaN }, () => 'ran')).toThrow("A run's seed is a finite number or a string, not NaN.")
  })

  it('throws on a nested run and leaves the outer run as it was', () => {
    setClockOverride('2026-10-09')
    const plain = sample()
    const nested = withRunContext(RUN, () => {
      const ids = [newId('p'), newId('act')]
      expect(() => withRunContext({ ...RUN, seed: 'other' }, () => newId('p'))).toThrow('A run is already on: runs never nest, and only one runs at a time.')
      ids.push(newId('c'), newId('act'))
      return { ids, at: nowISO() }
    })
    expect(nested).toEqual(plain)
  })

  it('throws on a second run while an async run is on, and allows one once it settles', async () => {
    setClockOverride('2026-10-09')
    let release = () => {}
    const first = withRunContext(RUN, async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return newId('p')
    })
    expect(activeRun()).not.toBeNull()
    expect(() => withRunContext(RUN, () => newId('p'))).toThrow('A run is already on')
    release()
    expect(await first).toBe(sample().ids[0])
    expect(activeRun()).toBeNull()
  })

  it('ends the run when fn throws, and when its promise rejects', async () => {
    expect(() =>
      withRunContext(RUN, () => {
        newId('p')
        throw new Error('on purpose')
      }),
    ).toThrow('on purpose')
    expect(activeRun()).toBeNull()
    expect(newId('p')).toMatch(APP_ID)

    const failing = withRunContext(RUN, async () => {
      await Promise.resolve()
      expect(activeRun()).not.toBeNull()
      throw new Error('on purpose, later')
    })
    await expect(failing).rejects.toThrow('on purpose, later')
    expect(activeRun()).toBeNull()
    expect(newId('p')).toMatch(APP_ID)
  })

  it('keeps an async run on across its awaits and returns its value', async () => {
    setClockOverride('2026-10-09')
    const ids = await withRunContext(RUN, async () => {
      const a = newId('p')
      await new Promise((resolve) => setTimeout(resolve, 1))
      return [a, newId('act')]
    })
    expect(ids).toEqual(sample().ids.slice(0, 2))
    expect(activeRun()).toBeNull()
  })

  it('carries nothing from one run to the next', () => {
    setClockOverride('2026-10-09')
    const first = sample()
    withRunContext({ seed: 'another', actorId: null, viewingAs: 'employee', timeOfDay: '15:00' }, () => {
      for (let i = 0; i < 500; i++) newId('p')
      expect(activeRun()).toMatchObject({ actorId: null, viewingAs: 'employee', time: { hours: 15, minutes: 0, seconds: 0 } })
    })
    expect(sample()).toEqual(first)
    expect(withRunContext(RUN, () => activeRun())).toMatchObject({ actorId: 'p-founder', viewingAs: 'admin', time: { hours: 10, minutes: 30, seconds: 0 } })
    expect(activeRun()).toBeNull()
  })
})

describe('outside a run (as before runs existed)', () => {
  it('newId stays random: 10 characters of a random UUID', () => {
    const a = newId('p')
    const b = newId('p')
    expect(a).toMatch(APP_ID)
    expect(b).not.toBe(a)
    vi.stubGlobal('crypto', { randomUUID: () => '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0' })
    expect(newId('act')).toBe('act-0f1e2d3c4b')
    expect(newId('act')).toBe(newIdBefore('act'))
  })

  it('newId falls back to Math.random where randomUUID is missing', () => {
    vi.stubGlobal('crypto', {})
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789)
    expect(newId('p')).toBe(newIdBefore('p'))
    expect(newId('p')).toBe(`p-${(0.123456789).toString(36).slice(2, 12)}`)
  })

  it('newId is random again after a run', () => {
    withRunContext(RUN, () => newId('p'))
    expect(newId('p')).toMatch(APP_ID)
  })

  it('nowISO keeps the real time of day, on the pretend date when there is one', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    for (const real of ['2026-03-05T21:47:13.456Z', '2026-10-28T03:02:01.999Z', '2026-11-01T09:30:00.000Z']) {
      vi.setSystemTime(new Date(real))
      for (const pretend of [null, '2026-10-09', '2027-01-15']) {
        setClockOverride(pretend)
        expect(nowISO()).toBe(nowISOBefore(pretend))
      }
    }
    vi.setSystemTime(new Date('2026-03-05T21:47:13.456Z'))
    setClockOverride(null)
    expect(nowISO()).toBe('2026-03-05T21:47:13.456Z')
    setClockOverride('2026-10-09')
    expect(nowISO()).toBe('2026-10-09T21:47:13.000Z')
    // And again after a run.
    withRunContext(RUN, () => nowISO())
    expect(nowISO()).toBe('2026-10-09T21:47:13.000Z')
  })
})
