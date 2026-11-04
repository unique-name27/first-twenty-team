// Demo stories (docs/DEV.md, "Demo stories"): ready-made runs that start and play at a pace a room can follow,
// for showing the simulator to people. Each is a plain run file (src/sim/play.ts), so npm run sim -- play
// replays it too. The dates are fixed, from the scenarios' as-of day (2026-10-09), so a story plays the same
// every time. #sim.demo.<id> opens the panel and plays one.
import type { RunFileInput } from '@/sim/play'
import type { Speed } from './protocol'

export type DemoStory = {
  id: string
  title: string
  /** One sentence on what to watch for. */
  blurb: string
  speed: Speed
  run: RunFileInput
}

export const DEMO_STORIES: readonly DemoStory[] = [
  {
    id: 'growth',
    title: 'From 8 people to 20 in a year',
    blurb: 'A seed-stage company grows to 20: roles planned and posted, candidates interviewed, offers out, people starting.',
    speed: 'month',
    run: {
      version: 1,
      start: { kind: 'scenario', scenario: 'seed-8' },
      seed: 1,
      pace: { preset: 'normal' },
      situations: [{ id: 'grow-to-20', on: '2026-10-12', kind: 'growTo', headcount: 20, by: '2027-08-02' }],
      until: '2027-10-08',
    },
  },
  {
    id: 'rough-quarter',
    title: 'A layoff, a freeze, then a comeback',
    blurb: 'A 20-person company lays off 3 people in January, freezes hiring for 90 days, then hires its way back.',
    speed: 'month',
    run: {
      version: 1,
      start: { kind: 'scenario', scenario: 'full-20' },
      seed: 1,
      pace: { preset: 'normal' },
      situations: [
        { id: 'layoff', on: '2027-01-04', kind: 'layoff', count: 3, freezeDays: 90 },
        { id: 'comeback', on: '2027-05-03', kind: 'hiringPush', roles: 3 },
      ],
      until: '2027-10-08',
    },
  },
  {
    id: 'two-years',
    title: 'Two years of the sample company',
    blurb: 'Ledgerlark at a busy pace for two years: a raise round, a resignation and its backfill, hiring to 20.',
    speed: 'month',
    run: {
      version: 1,
      start: { kind: 'sample' },
      seed: 1,
      pace: { preset: 'busy' },
      situations: [
        { id: 'raises', on: '2027-03-01', kind: 'raiseRound', percent: 4 },
        { id: 'someone-quits', on: '2027-06-01', kind: 'quit' },
      ],
      until: '2028-10-09',
    },
  },
]

/** The story with this id, or null. */
export function demoStory(id: string | undefined): DemoStory | null {
  return DEMO_STORIES.find((s) => s.id === id) ?? null
}
