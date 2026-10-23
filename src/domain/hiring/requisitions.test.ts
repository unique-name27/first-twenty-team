import { produce } from 'immer'
import { describe, expect, it, vi } from 'vitest'
import { applyInboxOp, inboxItems } from '@/domain/inbox'
import { findTemplateFor, jobFromTemplate, markPosted } from './jobs'
import {
  approveRequisition,
  declineRequisition,
  isPendingRequisition,
  pendingRequisitions,
  requestJob,
  requisitionQuarters,
  requisitionTargetStart,
} from './requisitions'
import { fixtureDB, FRI } from './testkit'

vi.mock('@/data/seed', async () => {
  const { blankDB } = await import('@/data/blank')
  return { SAMPLE_ANCHOR: '2026-10-09', buildSampleDB: () => blankDB({ companyName: 'Fixture', founderFirstName: 'F', founderLastName: 'F' }) }
})

function requested() {
  const db = fixtureDB()
  const job = jobFromTemplate(db, findTemplateFor(db, 'f-ml', 'lv-l3'), { id: 'j-req', date: FRI, hiringManagerId: 'p-founder' })
  const next = produce(db, (d) => {
    requestJob(d, job, { requestedById: 'p-priya', quarter: '2027-Q1', reason: 'Agent evals are falling behind.', date: FRI })
  })
  return next
}

describe('job requests', () => {
  it('offers this quarter and the next two', () => {
    expect(requisitionQuarters(FRI)).toEqual(['2026-Q4', '2027-Q1', '2027-Q2'])
    expect(requisitionQuarters('2026-12-31')).toEqual(['2026-Q4', '2027-Q1', '2027-Q2'])
  })

  it('targets a Monday no sooner than six weeks out', () => {
    expect(requisitionTargetStart('2026-Q4', FRI)).toBe('2026-11-23')
    expect(requisitionTargetStart('2027-Q1', FRI)).toBe('2027-01-04')
  })

  it('saves a pending draft job owned by the requester, with no cost and no plan line', () => {
    const db = requested()
    const job = db.jobs.find((j) => j.id === 'j-req')
    expect(job).toMatchObject({ status: 'draft', hiringManagerId: 'p-priya', targetStart: '2027-01-04' })
    expect(job?.requisition).toEqual({ requestedById: 'p-priya', requestedOn: FRI, quarter: '2027-Q1', reason: 'Agent evals are falling behind.', status: 'pending' })
    expect(job?.panelIds).toContain('p-priya')
    expect(job && isPendingRequisition(job)).toBe(true)
    expect(pendingRequisitions(db).map((j) => j.id)).toEqual(['j-req'])
    expect(db.plan.some((s) => s.jobId === 'j-req')).toBe(false)
    expect(db.activity.at(-1)?.text).toBe('Priya Nair requested the ML engineer (agents) job')
  })

  it('cannot be posted while the request waits for Admin', () => {
    const db = requested()
    let result: ReturnType<typeof markPosted> | undefined
    const after = produce(db, (d) => {
      result = markPosted(d, 'j-req', { date: FRI })
    })
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/waiting for Admin approval/) })
    expect(after.jobs.find((j) => j.id === 'j-req')?.status).toBe('draft')
  })

  it('approving adds a linked plan line for the quarter and lets the job be posted', () => {
    const db = produce(requested(), (d) => {
      expect(approveRequisition(d, 'j-req', { approverId: 'p-founder', date: FRI })).toEqual({ ok: true })
    })
    const job = db.jobs.find((j) => j.id === 'j-req')
    expect(job?.requisition).toMatchObject({ status: 'approved', decidedById: 'p-founder', decidedOn: FRI })
    expect(job?.openedOn).toBe(FRI)
    const slot = db.plan.find((s) => s.jobId === 'j-req')
    expect(slot).toMatchObject({ quarter: '2027-Q1', title: 'ML engineer (agents)', familyId: 'f-ml', levelId: 'lv-l3', status: 'open', targetStart: '2027-01-04' })
    expect(slot?.budgetBase).toBeUndefined()
    expect(job?.planSlotId).toBe(slot?.id)
    expect(pendingRequisitions(db)).toEqual([])
    const posted = produce(db, (d) => {
      expect(markPosted(d, 'j-req', { date: FRI })).toEqual({ ok: true })
    })
    expect(posted.jobs.find((j) => j.id === 'j-req')?.status).toBe('open')
  })

  it('lands as an Approve item in the admin inbox and a waiting item for the requester only', () => {
    const db = requested()
    const admin = inboxItems(db, { role: 'admin', personId: 'p-founder', person: db.people.find((p) => p.id === 'p-founder') }, FRI, { now: `${FRI}T22:00:00.000Z` })
    const item = admin.find((i) => i.kind === 'requisition')
    expect(item).toMatchObject({
      key: 'requisition:j-req',
      title: 'Approve the job request: ML engineer (agents) (L3), Q1 2027, from Priya Nair',
      waitingOn: 'you',
      primary: { kind: 'mutate', label: 'Approve', op: { type: 'approve_requisition', jobId: 'j-req' } },
    })
    expect(item?.detail).toBe('Why: Agent evals are falling behind. Approving adds it to the headcount plan. You post it from the job.')
    const asManager = (id: string) => inboxItems(db, { role: 'manager', personId: id, person: db.people.find((p) => p.id === id) }, FRI, { now: `${FRI}T22:00:00.000Z` })
    expect(asManager('p-priya').find((i) => i.kind === 'requisition_waiting')).toMatchObject({ waitingOn: 'them', waitingOnName: 'Admin' })
    expect(asManager('p-priya').some((i) => i.kind === 'requisition')).toBe(false)
    expect(asManager('p-tomas').some((i) => i.kind === 'requisition' || i.kind === 'requisition_waiting')).toBe(false)
    // The inbox action approves it (and the item goes away).
    const after = produce(db, (d) => {
      expect(applyInboxOp(d, { type: 'approve_requisition', jobId: 'j-req' }, { date: FRI, actorId: 'p-founder' })).toEqual({ ok: true })
    })
    expect(inboxItems(after, { role: 'admin', personId: 'p-founder', person: undefined }, FRI, { now: `${FRI}T22:00:00.000Z` }).some((i) => i.kind === 'requisition')).toBe(false)
  })

  it('declining closes the draft and adds nothing to the plan; a decided request cannot be decided again', () => {
    const db = produce(requested(), (d) => {
      expect(declineRequisition(d, 'j-req', { approverId: 'p-founder', date: FRI })).toEqual({ ok: true })
      expect(approveRequisition(d, 'j-req', { approverId: 'p-founder', date: FRI })).toMatchObject({ ok: false })
    })
    expect(db.jobs.find((j) => j.id === 'j-req')).toMatchObject({ status: 'closed', closedOn: FRI, requisition: { status: 'declined' } })
    expect(db.plan.some((s) => s.jobId === 'j-req')).toBe(false)
  })
})
