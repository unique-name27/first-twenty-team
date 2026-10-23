import { produce } from 'immer'
import { describe, expect, it, vi } from 'vitest'
import type { DB } from '@/domain/types'
import { scheduleInterview } from './scheduling'
import { allScorecardsOwed, debrief, overallSuggestion, ratingLabel, scorecardsOwed, submitScorecard } from './scorecards'
import { fixtureDB } from './testkit'

vi.mock('@/data/seed', async () => {
  const { blankDB } = await import('@/data/blank')
  return { SAMPLE_ANCHOR: '2026-10-09', buildSampleDB: () => blankDB({ companyName: 'Fixture', founderFirstName: 'F', founderLastName: 'F' }) }
})

/** Two onsite sessions for Alex on Tue Oct 13 (PDT): design with Tomas and Priya, product with Priya. */
function withInterviews(): { db: DB; design: string; product: string } {
  let design = ''
  let product = ''
  const db = produce(fixtureDB(), (d) => {
    design = scheduleInterview(
      d,
      { applicationId: 'a-alex', stageId: 'onsite', name: 'System design', startsAt: '2026-10-13T17:00:00.000Z', durationMin: 60, interviewerIds: ['p-tomas', 'p-priya'], format: 'onsite', attributes: ['System design', 'Security mindset'] },
      { date: '2026-10-09' },
    )
    product = scheduleInterview(
      d,
      { applicationId: 'a-alex', stageId: 'onsite', name: 'Product session', startsAt: '2026-10-13T18:30:00.000Z', durationMin: 45, interviewerIds: ['p-priya'], format: 'onsite', attributes: ['Product sense'] },
      { date: '2026-10-09' },
    )
  })
  return { db, design, product }
}

describe('overallSuggestion', () => {
  it('rounds the average and never lands on neutral', () => {
    expect(overallSuggestion({ a: 3, b: 4 })).toBe(4)
    expect(overallSuggestion({ a: 3, b: 3, c: 4 })).toBe(3)
    expect(overallSuggestion({ a: 2, b: 3 })).toBe(2) // a split is a no
    expect(overallSuggestion({ a: 1, b: 2, c: 2 })).toBe(2)
    expect(overallSuggestion({ a: 1 })).toBe(1)
    expect(overallSuggestion({})).toBeNull()
    expect(ratingLabel(4)).toBe('Strong yes')
    expect(ratingLabel(1)).toBe('Strong no')
  })
})

describe('scorecardsOwed', () => {
  it('lists scorecards only after the interview ends, oldest first, with overdue flags', () => {
    const { db, design, product } = withInterviews()
    expect(scorecardsOwed(db, 'p-priya', '2026-10-13T17:30:00.000Z')).toEqual([])
    const afterDesign = scorecardsOwed(db, 'p-priya', '2026-10-13T18:00:00.000Z')
    expect(afterDesign.map((o) => o.interview.id)).toEqual([design])
    const later = scorecardsOwed(db, 'p-priya', '2026-10-14T18:30:00.000Z')
    expect(later.map((o) => [o.interview.id, o.overdue])).toEqual([
      [design, true], // due 2026-10-14T18:00Z
      [product, false], // due 2026-10-14T19:15Z
    ])
    expect(allScorecardsOwed(db, '2026-10-14T18:30:00.000Z')).toHaveLength(3)
  })

  it('skips submitted, cancelled and no-show interviews', () => {
    const { db, design } = withInterviews()
    const next = produce(db, (d) => {
      const card = d.scorecards.find((s) => s.interviewId === design && s.interviewerId === 'p-tomas')!
      submitScorecard(d, card.id, { ratings: { 'System design': 3 } }, '2026-10-13T19:00:00.000Z')
      const product = d.interviews.find((i) => i.name === 'Product session')!
      product.status = 'cancelled'
    })
    expect(scorecardsOwed(next, 'p-tomas', '2026-10-15T00:00:00.000Z')).toEqual([])
    expect(scorecardsOwed(next, 'p-priya', '2026-10-15T00:00:00.000Z').map((o) => o.interview.id)).toEqual([design])
  })
})

describe('submitScorecard', () => {
  it('records ratings, suggests the overall, completes the interview and keeps the rating out of activity', () => {
    const { db, design } = withInterviews()
    const card = db.scorecards.find((s) => s.interviewId === design && s.interviewerId === 'p-tomas')!
    const next = produce(db, (d) => {
      expect(submitScorecard(d, card.id, { ratings: { 'System design': 4, 'Security mindset': 3 }, notes: '  Clear tradeoffs.  ' }, '2026-10-13T19:00:00.000Z')).toBe(true)
    })
    const saved = next.scorecards.find((s) => s.id === card.id)!
    expect(saved).toMatchObject({ overall: 4, notes: 'Clear tradeoffs.', submittedAt: '2026-10-13T19:00:00.000Z' })
    expect(saved.enteredById).toBeUndefined()
    expect(next.interviews.find((i) => i.id === design)?.status).toBe('completed')
    expect(next.activity.at(-1)?.text).toBe('Tomas Herrera submitted a scorecard for Alex Kim')
    expect(next.activity.at(-1)?.text).not.toMatch(/yes|no/i)
  })

  it("logs an admin entering a scorecard on someone's behalf and refuses an empty one", () => {
    const { db, design } = withInterviews()
    const card = db.scorecards.find((s) => s.interviewId === design && s.interviewerId === 'p-priya')!
    const next = produce(db, (d) => {
      expect(submitScorecard(d, card.id, { ratings: {} }, '2026-10-13T19:00:00.000Z')).toBe(false)
      expect(submitScorecard(d, card.id, { ratings: { 'System design': 2 }, overall: 1, enteredById: 'p-jasmine' }, '2026-10-13T19:00:00.000Z')).toBe(true)
    })
    const saved = next.scorecards.find((s) => s.id === card.id)!
    expect(saved).toMatchObject({ overall: 1, enteredById: 'p-jasmine' })
    expect(next.activity.at(-1)?.text).toBe("Jasmine Torres entered Priya Nair's scorecard for Alex Kim")
  })
})

describe('debrief', () => {
  it('lays out attributes by scorecard with missing and not-asked flags', () => {
    const { db, design } = withInterviews()
    const next = produce(db, (d) => {
      const tomas = d.scorecards.find((s) => s.interviewId === design && s.interviewerId === 'p-tomas')!
      submitScorecard(d, tomas.id, { ratings: { 'System design': 4 } }, '2026-10-13T19:00:00.000Z')
    })
    const grid = debrief(next, 'a-alex')
    expect(grid.attributes).toEqual(['System design', 'Security mindset', 'Product sense'])
    expect(grid.columns.map((c) => [c.interviewerName, c.interviewName, c.submitted])).toEqual([
      ['Priya Nair', 'System design', false],
      ['Tomas Herrera', 'System design', true],
      ['Priya Nair', 'Product session', false],
    ])
    const design0 = grid.grid[0].cells
    expect(design0.map((c) => [c.rating ?? null, c.missing, c.notAsked])).toEqual([
      [null, true, false],
      [4, false, false],
      [null, false, true],
    ])
    const security = grid.grid[1].cells
    expect(security[1]).toMatchObject({ missing: true, notAsked: false }) // Tomas left it blank
    expect(grid.missing.map((m) => m.name)).toEqual(['Priya Nair', 'Priya Nair'])
    expect(grid.overall.map((o) => o.rating ?? null)).toEqual([null, 4, null])
    expect(grid.allIn).toBe(false)
    expect(debrief(next, 'a-ben')).toMatchObject({ attributes: [], columns: [], allIn: false })
  })
})
