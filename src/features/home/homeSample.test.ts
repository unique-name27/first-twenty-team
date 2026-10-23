// Home against the Ledgerlark sample (Fri 2026-10-09): growth announcements stay quiet in an established
// company, scorecard rows open the sheet, and This week shows both time zones for out-of-zone candidates.
// The store loads first so every seed and domain module finishes loading before the sample is built.
import '@/store/db'
import { produce } from 'immer'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildSampleDB } from '@/data/seed'
import { allScorecardsOwed } from '@/domain/hiring/scorecards'
import { inboxItems } from '@/domain/inbox'
import type { DB, Viewer } from '@/domain/types'
import { setClockOverride } from '@/lib/dates'
import { weekEvents } from './thisWeek'

const FRI = '2026-10-09'
const NOW = '2026-10-09T22:00:00.000Z'
let db: DB

beforeAll(() => {
  setClockOverride(FRI)
  db = buildSampleDB()
})
afterAll(() => setClockOverride(null))

const viewerFor = (role: Viewer['role'], personId: string): Viewer => ({ role, person: db.people.find((p) => p.id === personId), personId })

describe('Home on the sample', () => {
  it('shows no first-time announcements or bands nudge for an established company', () => {
    const founder = db.people.find((p) => p.isFounder)!
    const items = inboxItems(db, viewerFor('admin', founder.id), FRI, { now: NOW })
    expect(items.some((i) => i.kind === 'unlock' || i.kind === 'bands')).toBe(false)
  })

  it('opens the scorecard sheet from a scorecard row', () => {
    const owed = allScorecardsOwed(db, NOW)[0]
    expect(owed).toBeDefined()
    const who = owed.scorecard.interviewerId
    const person = db.people.find((p) => p.id === who)!
    const items = inboxItems(db, viewerFor(person.isFounder ? 'admin' : 'employee', who), FRI, { now: NOW })
    const row = items.find((i) => i.key === `scorecard:${owed.scorecard.id}`)
    expect(row?.primary).toMatchObject({ kind: 'sheet', sheet: 'scorecard', id: owed.scorecard.id, label: 'Fill scorecard' })
    expect(row?.more?.some((a) => a.kind === 'navigate')).toBe(true)
  })

  it("puts the candidate's own time beside Pacific in This week", () => {
    const founder = db.people.find((p) => p.isFounder)!
    const upcoming = db.interviews.find((i) => i.status === 'scheduled' && i.startsAt.slice(0, 10) >= FRI && i.startsAt.slice(0, 10) <= '2026-10-15')
    expect(upcoming).toBeDefined()
    const app = db.applications.find((a) => a.id === upcoming!.applicationId)!
    const east = produce(db, (d) => {
      const c = d.candidates.find((x) => x.id === app.candidateId)!
      c.timezone = 'America/New_York'
    })
    const ev = weekEvents(east, viewerFor('admin', founder.id), FRI, '2026-10-15').find((e) => e.kind === 'interview' && e.at === upcoming!.startsAt)
    expect(ev?.time).toMatch(/^\d{1,2}:\d{2} [AP]M PT \(\d{1,2}:\d{2} [AP]M ET\)$/)
  })
})
