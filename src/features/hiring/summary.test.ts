// The Hiring > Jobs summary strip against the Ledgerlark sample (Fri 2026-10-09) and small fixtures.
// The store loads first so every seed and domain module finishes loading before the sample is built.
import '@/store/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildSampleDB } from '@/data/seed'
import { type InboxItem, inboxItems } from '@/domain/inbox'
import { peopleCostSummary } from '@/domain/pay'
import { plannedHiresBy } from '@/domain/plan'
import type { DB, Viewer } from '@/domain/types'
import { setClockOverride } from '@/lib/dates'
import { headcountTile, hiringRows } from '../home/dashboard'
import {
  attentionRank,
  costVsRunway,
  hiringSummary,
  interviewsThisWeek,
  jobAction,
  type JobRowInput,
  jobStatusWord,
  offersWaiting,
  rolesVsPlan,
  stuckSummary,
} from './summary'

const FRI = '2026-10-09'
const NOW = '2026-10-09T22:00:00.000Z'
let db: DB
let items: InboxItem[]
let admin: Viewer
let manager: Viewer

beforeAll(() => {
  setClockOverride(FRI)
  db = buildSampleDB()
  const founder = db.people.find((p) => p.isFounder)!
  admin = { role: 'admin', person: founder, personId: founder.id }
  items = inboxItems(db, admin, FRI, { now: NOW })
  const hm = db.people.find((p) => p.id === db.jobs.find((j) => j.status === 'open')!.hiringManagerId)!
  manager = { role: 'manager', person: hm, personId: hm.id }
})
afterAll(() => setClockOverride(null))

const row = (over: Partial<JobRowInput> & { status?: JobRowInput['job']['status'] } = {}): JobRowInput => ({
  job: {
    id: 'j1',
    status: over.status ?? 'open',
    requisition: over.job?.requisition,
  },
  stuck: over.stuck ?? 0,
  access: over.access ?? 'full',
})

describe('offers waiting on you', () => {
  it('counts offers awaiting approval and the monthly cost they add once they land', () => {
    const cost = peopleCostSummary(db, FRI)
    const w = offersWaiting(db, items, FRI, cost)
    expect(w.count).toBe(1)
    expect(w.rows).toHaveLength(1)
    expect(w.jobIds).toEqual(['j-staff-ml'])
    const line = cost.withOffers.lines.find((l) => l.offerId === w.rows[0].item.refs.offerId)!
    expect(w.monthly).toBe(line.monthly)
    expect(w.monthly).toBeGreaterThan(0)
  })

  it('finds the job from the offer when the approval carries no job ref', () => {
    const bare = items.map((i) => (i.kind === 'offer_approval' ? { ...i, refs: { ...i.refs, jobId: undefined } } : i))
    const w = offersWaiting(db, bare, FRI)
    expect(w.jobIds).toEqual(['j-staff-ml'])
    const staff = { job: { id: 'j-staff-ml', status: 'open' as const }, stuck: 0, access: 'full' as const }
    expect(attentionRank(staff, new Set(w.jobIds))).toBe(0)
    expect(jobStatusWord(staff, new Set(w.jobIds)).text).toBe('Offer waiting')
    expect(jobAction(staff, w).label).toBe('Approve')
  })

  it('is empty when nothing waits', () => {
    expect(offersWaiting(db, [], FRI)).toMatchObject({
      count: 0,
      monthly: 0,
      jobIds: [],
      rows: [],
    })
  })
})

describe('stuck candidates', () => {
  it('sums stuck candidates over open jobs and counts the roles they sit in', () => {
    const rows = hiringRows(db, FRI)
    const s = stuckSummary(rows)
    expect(s.candidates).toBe(rows.reduce((n, r) => n + r.stuck, 0))
    expect(s.roles).toBe(rows.filter((r) => r.stuck > 0).length)
    expect(s).toEqual({ candidates: 3, roles: 2 })
  })
})

describe('open roles vs plan', () => {
  it('compares open roles with the hires still needed to reach the plan', () => {
    const r = rolesVsPlan(hiringRows(db, FRI), headcountTile(db, FRI), plannedHiresBy(db, FRI, '2026-12-31'))
    // Plan 18 less 14 today is 4, but one of those has already accepted: 3 plan lines are still to hire.
    expect(r).toMatchObject({ open: 4, current: 14, toPlan: 3, uncovered: 0 })
    expect(r.plan).toEqual({ value: 18, date: '2026-12-31' })
  })

  it('reports planned hires with no open role, and nothing without a plan', () => {
    const head = headcountTile(db, FRI)
    expect(rolesVsPlan([], head, 3).uncovered).toBe(3)
    const none = rolesVsPlan([], { ...head, plan: null }, null)
    expect(none).toMatchObject({ toPlan: null, uncovered: null })
  })

  it('does not count a hire who already accepted as a hire to make', () => {
    // No plan lines: the projected 15 is the accepted offer starting, so nothing is left to hire.
    const bare = { ...db, plan: [] }
    const s = hiringSummary(bare, items, admin, FRI)
    expect(s?.kind === 'admin' && s.roles).toMatchObject({ plan: { value: 15 }, current: 14, toPlan: 0, uncovered: 0 })
  })
})

describe('hire cost vs runway', () => {
  it('adds the offers and incoming hires to the bill and shortens the runway', () => {
    const cost = peopleCostSummary(db, FRI)
    const c = costVsRunway(db, FRI, cost, headcountTile(db, FRI), 1)
    expect(c.addedMonthly).toBe(cost.withOffers.monthly - cost.now.monthly)
    expect(c.runwayNow).toBe(cost.runwayNow.months)
    expect(c.runwayWithOffers!).toBeLessThan(c.runwayNow!)
  })

  it('says whether the offers waiting reach the next legal threshold', () => {
    const cost = peopleCostSummary(db, FRI)
    const head = headcountTile(db, FRI)
    expect(head.next).toMatchObject({ n: 15, away: 1 })
    expect(costVsRunway(db, FRI, cost, head, 1).next).toEqual({
      n: 15,
      away: 1,
      reached: true,
    })
    expect(costVsRunway(db, FRI, cost, head, 0).next).toEqual({
      n: 15,
      away: 1,
      reached: false,
    })
  })

  it('keeps the runway as is when nothing is added', () => {
    const cost = peopleCostSummary(db, FRI)
    const flat = {
      ...cost,
      withOffers: { ...cost.withOffers, monthly: cost.now.monthly },
    }
    const c = costVsRunway(db, FRI, flat, headcountTile(db, FRI), 0)
    expect(c.addedMonthly).toBe(0)
    expect(c.runwayWithOffers).toBe(c.runwayNow)
  })
})

describe('interviews this week', () => {
  it('counts scheduled interviews in the next seven days on the manager’s jobs or panels', () => {
    const w = interviewsThisWeek(db, manager, FRI)
    expect(w.count).toBeGreaterThan(0)
    expect(w.nextAt! >= FRI).toBe(true)
    const none = interviewsThisWeek(db, manager, '2030-01-01')
    expect(none).toEqual({ count: 0, nextAt: null })
  })
})

describe('hiringSummary by viewer', () => {
  it('gives Admin four tiles of data, including cost', () => {
    const s = hiringSummary(db, items, admin, FRI)!
    expect(s.kind).toBe('admin')
    if (s.kind !== 'admin') return
    expect(s.offers.count).toBe(1)
    expect(s.cost.addedMonthly).toBeGreaterThan(0)
  })

  it('gives a manager stuck candidates, their roles and interviews, with no cost and no plan', () => {
    const s = hiringSummary(db, items, manager, FRI)!
    expect(s.kind).toBe('manager')
    expect(Object.keys(s).sort()).toEqual(['interviews', 'kind', 'roles', 'stuck'])
    expect(s.roles.plan).toBeNull()
    const mine = db.jobs.filter((j) => j.status === 'open' && j.hiringManagerId === manager.personId).length
    expect(s.roles.open).toBe(mine)
    const all = hiringSummary(db, items, admin, FRI)!
    expect(s.stuck.candidates).toBeLessThanOrEqual(all.stuck.candidates)
  })

  it('leaves employees without a strip', () => {
    const emp = db.people.find((p) => !p.isFounder && p.id !== manager.personId)!
    expect(hiringSummary(db, items, { role: 'employee', person: emp, personId: emp.id }, FRI)).toBeNull()
  })
})

describe('the Jobs list', () => {
  const offerJobs = new Set(['j1'])

  it('ranks offers waiting first, then stuck candidates, then the rest', () => {
    expect(attentionRank(row(), offerJobs)).toBe(0)
    expect(attentionRank({ ...row({ stuck: 2 }), job: { id: 'j2', status: 'open' } }, offerJobs)).toBe(1)
    expect(attentionRank({ ...row(), job: { id: 'j3', status: 'open' } }, offerJobs)).toBe(2)
    // An offer on a job that is no longer open does not jump the queue.
    expect(attentionRank(row({ status: 'filled' }), offerJobs)).toBe(2)
  })

  it('puts one status word on each row', () => {
    const none = new Set<string>()
    expect(jobStatusWord(row(), offerJobs)).toEqual({
      tone: 'accent',
      text: 'Offer waiting',
    })
    expect(jobStatusWord(row({ stuck: 3 }), none)).toEqual({
      tone: 'warn',
      text: '3 stuck',
    })
    expect(jobStatusWord(row(), none)).toEqual({
      tone: 'good',
      text: 'On track',
    })
    expect(jobStatusWord(row({ status: 'draft' }), none).text).toBe('Draft')
    expect(
      jobStatusWord(
        row({
          status: 'draft',
          job: {
            id: 'j1',
            status: 'draft',
            requisition: { status: 'pending' } as never,
          },
        }),
        none,
      ).text,
    ).toBe('Requested')
    expect(jobStatusWord(row({ status: 'on_hold' }), none).text).toBe('On hold')
    expect(jobStatusWord(row({ status: 'filled' }), none).text).toBe('Filled')
    expect(jobStatusWord(row({ status: 'closed' }), none).text).toBe('Closed')
  })

  it('offers one inline action: approve, sweep or open', () => {
    const offers = offersWaiting(db, items, FRI)
    const staff = {
      job: { id: 'j-staff-ml', status: 'open' as const },
      stuck: 0,
      access: 'full' as const,
    }
    const approve = jobAction(staff, offers)
    expect(approve.label).toBe('Approve')
    expect('action' in approve && approve.action.kind).toBe('mutate')
    expect(jobAction(row({ stuck: 2 }), offers)).toEqual({
      label: 'Sweep',
      href: expect.stringContaining('sweep'),
    })
    expect(jobAction(row(), null)).toEqual({
      label: 'Open',
      href: expect.stringContaining('j1'),
    })
    // A panel member cannot sweep a job they do not manage.
    expect(jobAction(row({ stuck: 2, access: 'panel' }), null).label).toBe('Open')
  })
})
