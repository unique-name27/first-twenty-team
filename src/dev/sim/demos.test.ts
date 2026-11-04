// The demo stories are run files the panel plays as they are: each one parses, keeps its situations inside
// its run, and plays its first two weeks without a refusal.
import '@/store/db'
import { describe, expect, it } from 'vitest'
import { addDays } from '@/lib/dates'
import { generateCompany } from '@/sim/generate'
import { buildStart, parseRunFile, playRun } from '@/sim/play'
import { DEMO_STORIES, demoStory } from './demos'
import { SPEED_ORDER } from './protocol'

describe('the demo stories', () => {
  it('have unique ids that fit a link (#sim.demo.<id>), and a speed the panel offers', () => {
    const ids = DEMO_STORIES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of DEMO_STORIES) {
      expect(s.id).toMatch(/^[a-z0-9-]+$/)
      expect(SPEED_ORDER).toContain(s.speed)
    }
    expect(demoStory('growth')?.title).toBeTruthy()
    expect(demoStory('no-such-story')).toBeNull()
    expect(demoStory(undefined)).toBeNull()
  })

  it.each(DEMO_STORIES.map((s) => [s.id, s] as const))('%s parses and plays its first two weeks', (_, story) => {
    const run = parseRunFile(story.run)
    const started = buildStart(run.start, (scenario, seed, asOf) => generateCompany({ scenario, seed, asOf }).db)
    for (const s of run.situations) {
      expect(s.on > started.from, s.id).toBe(true)
      expect(s.on < run.until, s.id).toBe(true)
    }
    const sim = playRun(run, started, addDays(started.from, 14))
    expect(sim.day).toBe(addDays(started.from, 14))
  })
})
