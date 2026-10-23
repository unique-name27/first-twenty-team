// Access rules that protect pay and independent scorecards, checked on the Ledgerlark sample.
// The store loads first so every seed and domain module finishes loading before the sample is built.
import '@/store/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildSampleDB } from '@/data/seed'
import { canApproveTimeOff, canSeeCandidatePay, canSeeOffer, canSeeOthersScorecards, canSeeSeparation, isHiredApplication } from '@/domain/access'
import type { DB, Viewer } from '@/domain/types'
import { setClockOverride } from '@/lib/dates'

let db: DB

beforeAll(() => {
  setClockOverride('2026-10-09')
  db = buildSampleDB()
})

afterAll(() => setClockOverride(null))

const viewer = (role: Viewer['role'], personId: string): Viewer => {
  const person = db.people.find((p) => p.id === personId) ?? null
  return { role, personId, person } as Viewer
}
const appFor = (candidateId: string) => {
  const app = db.applications.find((a) => a.candidateId === candidateId)
  if (!app) throw new Error(`no application for ${candidateId}`)
  return app
}

describe('pay on hired applications', () => {
  it('hides a past hire’s offer and desired pay from their hiring manager, but not from admin', () => {
    const app = appFor('c-hire-ravi')
    const job = db.jobs.find((j) => j.id === app.jobId)
    expect(isHiredApplication(db, app)).toBe(true)
    const hm = viewer('manager', job?.hiringManagerId ?? '')
    expect(canSeeCandidatePay(hm, db, app)).toBe(false)
    expect(canSeeOffer(hm, db, app)).toBe(false)
    expect(canSeeCandidatePay(viewer('admin', 'p-founder'), db, app)).toBe(true)
  })

  it('still shows an active candidate’s desired pay to the job’s hiring manager', () => {
    const app = db.applications.find((a) => a.status === 'active' && db.jobs.find((j) => j.id === a.jobId)?.hiringManagerId === 'p-tomas')
    expect(app).toBeDefined()
    if (!app) return
    expect(isHiredApplication(db, app)).toBe(false)
    expect(canSeeCandidatePay(viewer('manager', 'p-tomas'), db, app)).toBe(true)
  })
})

describe('independent scorecards per interview', () => {
  it('an earlier round’s card does not unlock a later round the viewer has not written up yet', () => {
    const app = appFor('c-ananya-krishnan')
    const hannah = viewer('employee', 'p-hannah')
    const mineSubmitted = db.scorecards.some((s) => s.applicationId === app.id && s.interviewerId === 'p-hannah' && s.submittedAt)
    const later = db.interviews.find((i) => i.applicationId === app.id && i.interviewerIds.includes('p-hannah') && i.status === 'scheduled')
    expect(mineSubmitted).toBe(true)
    expect(later).toBeDefined()
    if (!later) return
    // Before the later round starts, her submitted earlier card lets her read the panel.
    expect(canSeeOthersScorecards(hannah, db, app, { nowISO: new Date(Date.parse(later.startsAt) - 3_600_000).toISOString() })).toBe(true)
    // Once it has started and her card for it is still open, others' cards stay hidden.
    expect(canSeeOthersScorecards(hannah, db, app, { nowISO: new Date(Date.parse(later.startsAt) + 26 * 3_600_000).toISOString() })).toBe(false)
  })
})

describe('pending departures', () => {
  it('shows a last day still ahead only to Admin, the person and their manager line', () => {
    // Kofi reports to Tomas, who reports to the founder; Nikhil also reports to Tomas.
    expect(canSeeSeparation(viewer('admin', 'p-founder'), db, 'p-kofi')).toBe(true)
    expect(canSeeSeparation(viewer('employee', 'p-kofi'), db, 'p-kofi')).toBe(true)
    expect(canSeeSeparation(viewer('manager', 'p-tomas'), db, 'p-kofi')).toBe(true)
    expect(canSeeSeparation(viewer('employee', 'p-aisha'), db, 'p-kofi')).toBe(false)
    expect(canSeeSeparation(viewer('employee', 'p-nikhil'), db, 'p-kofi')).toBe(false)
    // A manager outside the line, and the manager in the Employee preview, do not
    expect(canSeeSeparation(viewer('manager', 'p-elena'), db, 'p-kofi')).toBe(false)
    expect(canSeeSeparation(viewer('employee', 'p-tomas'), db, 'p-kofi')).toBe(false)
  })
})

describe('time off approvals', () => {
  it('leaves sick leave that falls before the 90-day wait to Admin', () => {
    const base = { id: 'tr-x', personId: 'p-kofi', startDate: '2026-10-12', endDate: '2026-10-12', hours: 8, status: 'pending' as const, requestedOn: '2026-10-09' }
    const vacation = { ...base, policyId: 'pol-vacation' }
    const sick = { ...base, policyId: 'pol-sick' }
    expect(canApproveTimeOff(viewer('manager', 'p-tomas'), db, vacation)).toBe(true)
    expect(canApproveTimeOff(viewer('manager', 'p-elena'), db, vacation)).toBe(false)
    expect(canApproveTimeOff(viewer('manager', 'p-tomas'), db, sick)).toBe(false)
    expect(canApproveTimeOff(viewer('admin', 'p-founder'), db, sick)).toBe(true)
  })
})
