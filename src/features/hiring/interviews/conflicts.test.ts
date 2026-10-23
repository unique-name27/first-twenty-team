import { describe, expect, it, vi } from 'vitest'
import { fixtureDB } from '@/domain/hiring/testkit'
import { proposeTimesFor } from '@/domain/hiring/scheduling'
import { pacificDateOf } from '@/domain/hiring/util'
import type { DB, Interview } from '@/domain/types'
import { candidateClashes, proposedSlots, slotWarnings } from './conflicts'

vi.mock('@/data/seed', async () => {
  const { blankDB } = await import('@/data/blank')
  return { SAMPLE_ANCHOR: '2026-10-09', buildSampleDB: () => blankDB({ companyName: 'Fixture', founderFirstName: 'F', founderLastName: 'F' }) }
})

const DATE = '2026-10-09'

function interview(id: string, applicationId: string, startsAt: string, interviewerIds: string[], extra: Partial<Interview> = {}): Interview {
  return { id, applicationId, stageId: 'onsite', name: `Interview ${id}`, startsAt, durationMin: 45, interviewerIds, format: 'video', status: 'scheduled', attributes: [], ...extra }
}

function dbWith(interviews: Interview[] = []): DB {
  const db = fixtureDB()
  db.interviews.push(...interviews)
  return db
}

describe('proposedSlots', () => {
  it('matches the plain rotation when nobody is busy', () => {
    const db = dbWith()
    expect(proposedSlots(db, DATE, { panelIds: ['p-tomas'], durationMin: 45, applicationId: 'a-alex' })).toEqual(proposeTimesFor(db, DATE, 3))
  })

  it("skips a time a panelist already interviews someone else, but not other people's interviews", () => {
    const base = proposeTimesFor(dbWith(), DATE, 3)
    const db = dbWith([interview('i-busy', 'a-ben', base[0], ['p-tomas'])])
    const forTomas = proposedSlots(db, DATE, { panelIds: ['p-tomas'], durationMin: 45, applicationId: 'a-alex' })
    expect(forTomas).toHaveLength(3)
    expect(forTomas).not.toContain(base[0])
    expect(proposedSlots(db, DATE, { panelIds: ['p-priya'], durationMin: 45, applicationId: 'a-alex' })).toContain(base[0])
  })

  it('skips days a panelist is out', () => {
    const base = proposeTimesFor(dbWith(), DATE, 3)
    const day = pacificDateOf(base[0])
    const db = dbWith()
    db.timeOffRequests.push({ id: 'tr-1', personId: 'p-tomas', policyId: 'pol-pto', startDate: day, endDate: day, hours: 8, status: 'approved', requestedOn: '2026-09-01' })
    const slots = proposedSlots(db, DATE, { panelIds: ['p-tomas'], durationMin: 45, applicationId: 'a-alex' })
    expect(slots).toHaveLength(3)
    expect(slots.map(pacificDateOf)).not.toContain(day)
  })

  it("skips times the candidate already has an interview, whoever runs it", () => {
    const base = proposeTimesFor(dbWith(), DATE, 3)
    const db = dbWith([interview('i-own', 'a-alex', base[0], ['p-priya'])])
    expect(candidateClashes(db, 'a-alex', base[0], 45).map((i) => i.id)).toEqual(['i-own'])
    expect(proposedSlots(db, DATE, { panelIds: ['p-tomas'], durationMin: 45, applicationId: 'a-alex' })).not.toContain(base[0])
  })

  it("keeps 9 AM to 5 PM in the candidate's zone", () => {
    const db = dbWith()
    // Alex is in New York: 3:30 PM Pacific is 6:30 PM there.
    const slots = proposedSlots(db, DATE, { panelIds: ['p-tomas'], candidateTz: 'America/New_York', durationMin: 45, applicationId: 'a-alex' })
    for (const t of slots) {
      const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(new Date(t)))
      expect(h).toBeGreaterThanOrEqual(9)
      expect(h).toBeLessThan(17)
    }
  })
})

describe('slotWarnings', () => {
  const base = proposeTimesFor(dbWith(), DATE, 3)

  it('is empty for a clear time', () => {
    expect(slotWarnings(dbWith(), base[0], { panelIds: ['p-tomas'], durationMin: 45, applicationId: 'a-alex' })).toEqual([])
  })

  it('names the busy panelist, the other candidate and the interview', () => {
    const db = dbWith([interview('i-busy', 'a-ben', base[0], ['p-tomas'], { name: 'Phone screen' })])
    const w = slotWarnings(db, base[0], { panelIds: ['p-tomas', 'p-priya'], durationMin: 45, applicationId: 'a-alex' })
    expect(w).toHaveLength(1)
    expect(w[0]).toMatch(/Tomas/)
    expect(w[0]).toMatch(/Phone screen with Ben Ortiz/)
    expect(w[0]).not.toMatch(/Priya/)
  })

  it('names a panelist who is out that day', () => {
    const db = dbWith()
    const day = pacificDateOf(base[0])
    db.timeOffRequests.push({ id: 'tr-1', personId: 'p-priya', policyId: 'pol-pto', startDate: day, endDate: day, hours: 8, status: 'approved', requestedOn: '2026-09-01' })
    expect(slotWarnings(db, base[0], { panelIds: ['p-tomas', 'p-priya'], durationMin: 45, applicationId: 'a-alex' })).toEqual([expect.stringMatching(/Priya .*is out that day\./)])
  })

  it("names the candidate's own clash once, even when a panelist is on it too", () => {
    const own = dbWith([interview('i-own', 'a-alex', base[0], ['p-priya'], { name: 'Values interview' })])
    expect(slotWarnings(own, base[0], { panelIds: ['p-tomas'], durationMin: 45, applicationId: 'a-alex' })).toEqual(['Alex Kim already has Values interview then.'])
    const shared = slotWarnings(own, base[0], { panelIds: ['p-priya'], durationMin: 45, applicationId: 'a-alex' })
    expect(shared).toHaveLength(1)
    expect(shared[0]).toMatch(/Priya .*Values interview with Alex Kim/)
  })

  it('flags a company holiday', () => {
    const db = dbWith()
    db.holidays.push({ id: 'h-x', date: pacificDateOf(base[0]), name: 'Founders day' })
    expect(slotWarnings(db, base[0], { panelIds: ['p-tomas'], durationMin: 45, applicationId: 'a-alex' })).toEqual([expect.stringMatching(/company holiday \(Founders day\)/)])
  })

  it('ignores cancelled interviews', () => {
    const db = dbWith([interview('i-gone', 'a-ben', base[0], ['p-tomas'], { status: 'cancelled' })])
    expect(slotWarnings(db, base[0], { panelIds: ['p-tomas'], durationMin: 45, applicationId: 'a-alex' })).toEqual([])
  })
})
