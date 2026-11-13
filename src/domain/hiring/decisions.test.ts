// What the Hiring Jobs tab needs decided, against the Ledgerlark sample (Fri 2026-10-09) and small variations of it.
// The store loads first so every seed and domain module finishes loading before the sample is built.
import '@/store/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import { buildSampleDB } from '@/data/seed'
import { nextThreshold } from '@/domain/compliance'
import { headcountOutlook, offersWaiting } from '@/domain/hiring/decisions'
import { type InboxItem, inboxItems } from '@/domain/inbox'
import { peopleCostSummary } from '@/domain/pay'
import { headcountProjection } from '@/domain/plan'
import type { DB, Viewer } from '@/domain/types'
import { setClockOverride } from '@/lib/dates'

const FRI = '2026-10-09'
const NOW = '2026-10-09T22:00:00.000Z'
let db: DB
let items: InboxItem[]

beforeAll(() => {
  setClockOverride(FRI)
  db = buildSampleDB()
  const founder = db.people.find((p) => p.isFounder)!
  const viewer: Viewer = { role: 'admin', person: founder, personId: founder.id }
  items = inboxItems(db, viewer, FRI, { now: NOW })
})
afterAll(() => setClockOverride(null))

describe('offers waiting on you', () => {
  it('counts the offers awaiting approval and the monthly cost they add once they land', () => {
    const cost = peopleCostSummary(db, FRI)
    const w = offersWaiting(db, items, cost)
    expect(w.count).toBe(1)
    expect(w.jobIds).toEqual(['j-staff-ml'])
    const line = cost.withOffers.lines.find((l) => l.offerId === w.rows[0].offerId)!
    expect(w.monthly).toBe(line.monthly)
    expect(w.monthly).toBeGreaterThan(0)
  })

  it('takes only offer approvals that wait on the admin', () => {
    const cost = peopleCostSummary(db, FRI)
    const others = items.map((i) => (i.kind === 'offer_approval' ? { ...i, waitingOn: 'them' as const } : i))
    expect(offersWaiting(db, others, cost)).toMatchObject({ count: 0, monthly: 0, jobIds: [], rows: [] })
  })

  it('finds the job from the offer record, then from the item ref', () => {
    const cost = peopleCostSummary(db, FRI)
    const item = items.find((i) => i.kind === 'offer_approval')!
    const noRef = { ...item, refs: { ...item.refs, jobId: undefined } }
    expect(offersWaiting(db, [noRef], cost).jobIds).toEqual(['j-staff-ml'])
    const wrongRef = { ...item, refs: { ...item.refs, jobId: 'j-other' } }
    expect(offersWaiting(db, [wrongRef], cost).jobIds).toEqual(['j-staff-ml'])
    const noOffer = { ...item, refs: { ...item.refs, offerId: 'o-gone', jobId: 'j-staff-ml' } }
    expect(offersWaiting(db, [noOffer], cost).rows[0].jobId).toBe('j-staff-ml')
  })
})

describe('headcount outlook', () => {
  it('reads the projection: current count, plan at quarter end and the next threshold', () => {
    const o = headcountOutlook(db, FRI)
    const proj = headcountProjection(db, FRI)
    expect(o.current).toBe(proj.current)
    expect(o.plan?.value).toBe(proj.targets[0].value)
    expect(o.next).not.toBeNull()
    expect(o.next!.n).toBeGreaterThan(o.current)
  })

  it('counts people already hired but not started toward the next threshold', () => {
    // The sample has current 14 and a start on Oct 19 that takes it to 16: no hire is still needed to reach 15.
    const sample = headcountOutlook(db, FRI)
    expect(nextThreshold(db, FRI)).toMatchObject({ n: 15, current: 14, withIncoming: 16 })
    expect(sample.next).toEqual({ n: 15, away: 0 })
    // Without that start, one more hire is needed; with one start, none is.
    const bare = structuredClone(db)
    bare.people = bare.people.filter((p) => p.startDate <= FRI)
    expect(headcountOutlook(bare, FRI).next).toEqual({ n: 15, away: 1 })
    const hire = { ...bare.people.find((p) => !p.isFounder && !p.endDate)!, id: 'p-booked', startDate: '2026-11-02' }
    bare.people.push(hire)
    expect(headcountOutlook(bare, FRI).next).toEqual({ n: 15, away: 0 })
    expect(headcountOutlook(bare, FRI).current).toBe(14)
  })

  it('shows no plan for a company with no plan lines and nobody booked', () => {
    const solo = blankDB({ companyName: 'Solo', founderFirstName: 'Maya', founderLastName: 'Raman', foundedOn: '2025-02-03' })
    expect(headcountOutlook(solo, FRI)).toMatchObject({ current: 1, plan: null })
  })
})
