// The admin Home's finance-first summary against the Ledgerlark sample (Fri 2026-10-09) and small fixtures.
// The store loads first so every seed and domain module finishes loading before the sample is built.
import '@/store/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildSampleDB } from '@/data/seed'
import { inboxItems, type InboxItem } from '@/domain/inbox'
import { peopleCostSummary } from '@/domain/pay'
import { headcountProjection } from '@/domain/plan'
import type { DB, Viewer } from '@/domain/types'
import { setClockOverride } from '@/lib/dates'
import {
  APPROVAL_KINDS,
  approvalsQueue,
  headcountTile,
  hiringRows,
  homeAnswer,
  homeDateTitle,
  joiningLeaving,
  LEGAL_WINDOW_DAYS,
  legalExposure,
  waitingOnOthers,
  whenText,
} from './dashboard'

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

describe('page head', () => {
  it('titles the page with the date and answers in one line', () => {
    expect(homeDateTitle(FRI)).toBe('Friday, Oct 9')
    expect(homeAnswer(3, 6)).toBe('3 legal items overdue. 6 decisions waiting on you.')
    expect(homeAnswer(1, 1)).toBe('1 legal item overdue. 1 decision waiting on you.')
    expect(homeAnswer(0, 0)).toBe('No legal items overdue. Nothing waiting on your approval.')
  })
})

describe('whenText', () => {
  it('says how late or how soon in days', () => {
    expect(whenText({ dueOn: '2026-09-25', group: 'overdue' }, FRI)).toBe('14 days late')
    expect(whenText({ dueOn: '2026-10-08', group: 'overdue' }, FRI)).toBe('1 day late')
    expect(whenText({ dueOn: FRI, group: 'this_week' }, FRI)).toBe('Due today')
    expect(whenText({ dueOn: '2026-10-10', group: 'this_week' }, FRI)).toBe('Due tomorrow')
    expect(whenText({ dueOn: '2026-10-14', group: 'this_week' }, FRI)).toBe('Due in 5 days')
    expect(whenText({ group: 'overdue' }, FRI)).toBe('Applies now')
  })
})

describe('legal exposure', () => {
  it('holds only legal items, overdue first, then those due in the window', () => {
    const { rows, overdue, dueSoon } = legalExposure(db, items, FRI)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.item.statutory)).toBe(true)
    expect(overdue + dueSoon).toBe(rows.length)
    const firstSoon = rows.findIndex((r) => r.status === 'due_soon')
    if (firstSoon >= 0) expect(rows.slice(firstSoon).every((r) => r.status === 'due_soon')).toBe(true)
    const until = '2026-10-23'
    expect(rows.filter((r) => r.status === 'due_soon').every((r) => !r.item.dueOn || r.item.dueOn <= until)).toBe(true)
    expect(LEGAL_WINDOW_DAYS).toBe(14)
  })

  it('counts the same overdue legal items as the inbox marks red', () => {
    const red = items.filter((i) => i.statutory && i.group === 'overdue').length
    expect(legalExposure(db, items, FRI).overdue).toBe(red)
  })

  it('keeps operational items such as an unreturned laptop out of the legal list', () => {
    const laptop = items.find((i) => i.refs.taskId?.includes('off-equipment'))
    const { rows } = legalExposure(db, items, FRI)
    if (laptop) expect(rows.some((r) => r.item.key === laptop.key)).toBe(false)
    expect(rows.some((r) => /laptop/i.test(r.task))).toBe(false)
  })

  it('rewrites titles as person and plain-English task, with the form code', () => {
    const { rows } = legalExposure(db, items, FRI)
    const de34 = rows.find((r) => r.item.refs.taskId?.endsWith('on-de34'))
    expect(de34).toBeDefined()
    expect(de34!.subject).toBe('Aisha Bello')
    expect(de34!.task).toBe('Confirm the new hire report was filed (DE 34)')
    expect(de34!.when).toMatch(/^\d+ days? late$|^Due /)
    const rule = rows.find((r) => r.item.kind === 'rule')
    if (rule) expect(rule.subject).toBe('Company')
  })
})

describe('approvals', () => {
  it('lists only decisions waiting on the admin', () => {
    const rows = approvalsQueue(db, items, FRI)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => APPROVAL_KINDS.includes(r.item.kind) && r.item.waitingOn === 'you')).toBe(true)
    expect(rows.some((r) => r.item.statutory)).toBe(false)
  })

  it('puts the fully loaded monthly cost and start date on an offer approval', () => {
    const offer = approvalsQueue(db, items, FRI).find((r) => r.item.kind === 'offer_approval')
    expect(offer).toBeDefined()
    expect(offer!.title).toMatch(/^Offer · /)
    const money = offer!.meta.find((m) => typeof m !== 'string')
    expect(money).toMatchObject({ suffix: '/mo fully loaded' })
    expect(offer!.meta.some((m) => typeof m === 'string' && m.startsWith('starts '))).toBe(true)
  })

  it('counts items waiting on others that are due now', () => {
    const n = waitingOnOthers(items)
    expect(n).toBe(items.filter((i) => i.waitingOn === 'them' && i.group !== 'coming_up').length)
  })
})

describe('headcount tile', () => {
  it('reads the projection: current count, plan at quarter end, history and the next threshold', () => {
    const tile = headcountTile(db, FRI)
    const proj = headcountProjection(db, FRI)
    expect(tile.current).toBe(proj.current)
    expect(tile.history).toEqual(proj.actual.map((p) => p.value))
    expect(tile.plan?.value).toBe(proj.targets[0].value)
    expect(tile.next).not.toBeNull()
    expect(tile.next!.n).toBeGreaterThan(tile.current)
    expect(tile.next!.away).toBe(tile.next!.n - tile.current)
  })
})

describe('people cost', () => {
  it('uses the same run-rate and runway as Comp and plan', () => {
    const s = peopleCostSummary(db, FRI)
    expect(s.withOffers.monthly).toBeGreaterThanOrEqual(s.now.monthly)
    expect(s.runwayNow.months).not.toBeNull()
  })
})

describe('detail tables', () => {
  it('lists every open job with applied, onsite, days open and a status word', () => {
    const rows = hiringRows(db, FRI)
    expect(rows.length).toBe(db.jobs.filter((j) => j.status === 'open').length)
    for (const r of rows) {
      expect(r.applied).toBeGreaterThanOrEqual(r.onsite)
      expect(r.status.text.length).toBeGreaterThan(0)
    }
    const days = rows.map((r) => r.daysOpen ?? -1)
    expect(days).toEqual([...days].sort((a, b) => b - a))
  })

  it('lists joining before leaving, each with checklist progress and a status word', () => {
    const rows = joiningLeaving(db, FRI)
    expect(rows.length).toBeGreaterThan(0)
    const rank = { Joining: 0, Leaving: 1, Started: 2, Left: 3 }
    const order = rows.map((r) => rank[r.change])
    expect(order).toEqual([...order].sort((a, b) => a - b))
    for (const r of rows) {
      expect(r.done).toBeLessThanOrEqual(r.total)
      if (r.status.tone === 'bad') expect(r.status.text).toBe('Legal overdue')
    }
    const incoming = db.people.filter((p) => p.startDate > FRI)
    for (const p of incoming) expect(rows.some((r) => r.personId === p.id && r.change === 'Joining')).toBe(true)
  })
})
