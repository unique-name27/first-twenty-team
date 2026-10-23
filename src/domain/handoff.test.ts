import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { addContractor, addPerson, makeDB } from '@/domain/compliance/testkit'
import type { Application, Checklist, DB, Interview, Job, Separation } from '@/domain/types'
import { applyDueHandoffs, applyHandoffs, HANDOFF_TASK_ID, handoffSummary, leaverRoles, recordHandoffs } from './handoff'

const TODAY = '2026-10-10'
const LAST = '2026-10-30'

function job(id: string, over: Partial<Job> = {}): Job {
  return {
    id,
    title: `Job ${id}`,
    departmentId: 'd-eng',
    familyId: 'f-swe',
    levelId: 'lv-l3',
    hiringManagerId: 'p-elena',
    panelIds: ['p-elena', 'p-sam'],
    locationIds: ['loc-hq'],
    workMode: 'hybrid',
    employmentType: 'full_time',
    flsa: 'exempt',
    payMin: 100_000,
    payMax: 150_000,
    status: 'open',
    stages: [],
    interviewPlan: [],
    description: '',
    sponsorship: 'no',
    backgroundCheck: false,
    priority: 'normal',
    ...over,
  }
}

function app(id: string, over: Partial<Application> = {}): Application {
  return {
    id,
    candidateId: `c-${id}`,
    jobId: 'j-open',
    stageId: 'intro',
    status: 'active',
    appliedOn: '2026-10-01',
    stageEnteredOn: '2026-10-01',
    history: [],
    nextStep: { text: 'Send take-home', dueOn: '2026-10-14', ownerId: 'p-elena' },
    ...over,
  }
}

function interview(id: string, startsAt: string, over: Partial<Interview> = {}): Interview {
  return {
    id,
    applicationId: 'a-1',
    stageId: 'technical',
    name: 'Technical interview',
    startsAt,
    durationMin: 60,
    interviewerIds: ['p-elena'],
    format: 'video',
    status: 'scheduled',
    attributes: [],
    ...over,
  }
}

/** Elena leaves on Oct 30: she manages one open job, owns two next steps, interviews twice, works with a contractor and heads a team. */
function fixture(): DB {
  const db = makeDB()
  addPerson(db, { id: 'p-elena', firstName: 'Elena', lastName: 'Vasquez', startDate: '2025-08-18', managerId: 'p-founder' })
  addPerson(db, { id: 'p-sam', firstName: 'Sam', lastName: 'Lee', startDate: '2025-09-01' })
  db.jobs.push(job('j-open'), job('j-draft', { status: 'draft' }), job('j-closed', { status: 'closed' }), job('j-other', { hiringManagerId: 'p-sam' }))
  db.candidates.push(
    { id: 'c-a-1', firstName: 'Maya', lastName: 'Lin', email: 'm@x.dev', links: {}, source: 'inbound', sponsorship: 'no', tags: [], createdOn: '2026-10-01' },
    { id: 'c-a-2', firstName: 'Omar', lastName: 'Diaz', email: 'o@x.dev', links: {}, source: 'inbound', sponsorship: 'no', tags: [], createdOn: '2026-10-01' },
  )
  db.applications.push(app('a-1'), app('a-2'), app('a-3', { status: 'rejected' }), app('a-4', { nextStep: { text: 'Call', dueOn: '2026-10-14', ownerId: 'p-sam' } }))
  db.interviews.push(
    interview('i-before', '2026-10-20T17:00:00.000Z'),
    interview('i-after', '2026-11-03T17:00:00.000Z'),
    interview('i-shared', '2026-11-04T17:00:00.000Z', { interviewerIds: ['p-elena', 'p-founder'] }),
    interview('i-done', '2026-11-05T17:00:00.000Z', { status: 'cancelled' }),
  )
  addContractor(db, { id: 'k-marisol', name: 'Marisol Vega', startOn: '2026-03-01', managerId: 'p-elena' })
  addContractor(db, { id: 'k-ended', name: 'Old Contract', startOn: '2025-03-01', endOn: '2026-01-31', managerId: 'p-elena' })
  db.departments.push({ id: 'd-acct', name: 'Accounting', headId: 'p-elena' })
  return db
}

function offboarded(db: DB): DB {
  return produce(db, (d) => {
    const p = d.people.find((x) => x.id === 'p-elena')!
    p.endDate = LAST
    p.separation = { type: 'resigned_notice', reason: 'New job', lastDay: LAST } as Separation
    const cl: Checklist = { id: 'ck-off', personId: 'p-elena', kind: 'offboarding', templateId: 'tpl-offboarding', anchorDate: LAST, createdOn: TODAY, tasks: [] }
    d.checklists.push(cl)
  })
}

describe('leaverRoles', () => {
  it('lists live jobs, active next steps, interviews after the last day, current contractors and teams', () => {
    const roles = leaverRoles(fixture(), 'p-elena', LAST)
    expect(roles.map((r) => `${r.kind}:${r.id}`)).toEqual([
      'job:j-open',
      'job:j-draft',
      'next_step:a-1',
      'next_step:a-2',
      'interview:i-after',
      'interview:i-shared',
      'contractor:k-marisol',
      'department:d-acct',
    ])
    expect(roles[2].text).toContain('Next step for Maya Lin, Job j-open: Send take-home')
    expect(roles[0].text).toBe('Hiring manager for Job j-open, open')
    expect(roles.find((r) => r.kind === 'department')?.text).toBe('Head of Accounting')
  })

  it('includes interviews from today when handing off now', () => {
    const ids = leaverRoles(fixture(), 'p-elena', '2026-10-09').filter((r) => r.kind === 'interview').map((r) => r.id)
    expect(ids).toEqual(['i-before', 'i-after', 'i-shared'])
  })

  it('summarizes roles in plain words', () => {
    expect(handoffSummary(leaverRoles(fixture(), 'p-elena', LAST))).toBe(
      'hiring manager for 2 jobs, next steps on 2 candidates, 2 upcoming interviews, 1 contractor or advisor they work with and head of 1 team',
    )
  })
})

describe('recordHandoffs and applyDueHandoffs', () => {
  const handoffs = (db: DB) => leaverRoles(db, 'p-elena', LAST).map((r) => ({ kind: r.kind, id: r.id, toId: r.kind === 'job' ? 'p-sam' : 'p-founder' }))

  it('waits for the last day, then moves every role and ticks the checklist task', () => {
    const db = offboarded(fixture())
    const saved = produce(db, (d) => {
      expect(recordHandoffs(d, 'p-elena', handoffs(db), { date: TODAY, checklistId: 'ck-off' })).toBe(0)
    })
    const sep = saved.people.find((p) => p.id === 'p-elena')!.separation!
    expect(sep.handoffs).toHaveLength(8)
    expect(sep.handoffsAppliedOn).toBeUndefined()
    expect(saved.jobs.find((j) => j.id === 'j-open')!.hiringManagerId).toBe('p-elena')
    const task = saved.checklists[0].tasks.find((t) => t.templateTaskId === HANDOFF_TASK_ID)!
    expect(task).toMatchObject({ status: 'open', dueOn: LAST, statutory: false })
    expect(task.note).toContain('Sam Lee takes hiring manager for 2 jobs')

    // Nothing moves before the last day
    expect(produce(saved, (d) => void applyDueHandoffs(d, '2026-10-29'))).toBe(saved)

    const after = produce(saved, (d) => {
      expect(applyDueHandoffs(d, LAST)).toBe(1)
    })
    expect(after.jobs.find((j) => j.id === 'j-open')).toMatchObject({ hiringManagerId: 'p-sam', panelIds: ['p-sam'] })
    expect(after.jobs.find((j) => j.id === 'j-draft')!.hiringManagerId).toBe('p-sam')
    expect(after.jobs.find((j) => j.id === 'j-closed')!.hiringManagerId).toBe('p-elena')
    expect(after.applications.find((a) => a.id === 'a-1')!.nextStep!.ownerId).toBe('p-founder')
    expect(after.applications.find((a) => a.id === 'a-3')!.nextStep!.ownerId).toBe('p-elena')
    expect(after.interviews.find((i) => i.id === 'i-after')!.interviewerIds).toEqual(['p-founder'])
    // Already on the panel: the leaver just drops off
    expect(after.interviews.find((i) => i.id === 'i-shared')!.interviewerIds).toEqual(['p-founder'])
    // Before the last day the leaver still runs their own interview
    expect(after.interviews.find((i) => i.id === 'i-before')!.interviewerIds).toEqual(['p-elena'])
    expect(after.contractors.find((k) => k.id === 'k-marisol')!.managerId).toBe('p-founder')
    expect(after.departments.find((d) => d.id === 'd-acct')!.headId).toBe('p-founder')
    expect(after.people.find((p) => p.id === 'p-elena')!.separation!.handoffsAppliedOn).toBe(LAST)
    expect(after.checklists[0].tasks.find((t) => t.templateTaskId === HANDOFF_TASK_ID)!.status).toBe('done')
    expect(after.activity.some((a) => a.kind === 'roles_handed_off' && a.text.startsWith("Handed off Elena Vasquez's roles to Sam Lee"))).toBe(true)

    // Safe to run again on the next load
    expect(produce(after, (d) => void applyDueHandoffs(d, '2026-11-02'))).toBe(after)
  })

  it('hands off at once when asked, including interviews before the last day', () => {
    const db = offboarded(fixture())
    const roles = leaverRoles(db, 'p-elena', '2026-10-09').map((r) => ({ kind: r.kind, id: r.id, toId: 'p-founder' }))
    const now = produce(db, (d) => {
      expect(recordHandoffs(d, 'p-elena', roles, { date: TODAY, now: true, checklistId: 'ck-off' })).toBe(9)
    })
    expect(now.interviews.find((i) => i.id === 'i-before')!.interviewerIds).toEqual(['p-founder'])
    expect(now.jobs.find((j) => j.id === 'j-open')!.hiringManagerId).toBe('p-founder')
    expect(now.people.find((p) => p.id === 'p-elena')!.separation!.handoffsAppliedOn).toBe(TODAY)
  })

  it('leaves records reassigned by hand alone and sends new roles of the same kind to the same person', () => {
    const db = offboarded(fixture())
    const saved = produce(db, (d) => void recordHandoffs(d, 'p-elena', handoffs(db), { date: TODAY, checklistId: 'ck-off' }))
    const edited = produce(saved, (d) => {
      d.jobs.find((j) => j.id === 'j-open')!.hiringManagerId = 'p-founder'
      d.applications.push(app('a-new'))
    })
    const after = produce(edited, (d) => void applyHandoffs(d, 'p-elena', d.people.find((p) => p.id === 'p-elena')!.separation!.handoffs!, { date: LAST }))
    expect(after.jobs.find((j) => j.id === 'j-open')!.hiringManagerId).toBe('p-founder')
    expect(after.applications.find((a) => a.id === 'a-new')!.nextStep!.ownerId).toBe('p-founder')
  })
})
