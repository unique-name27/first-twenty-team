import { produce } from 'immer'
import { describe, expect, it, vi } from 'vitest'
import { blankDB } from '@/data/blank'
import { closeAckTasks, closeTrainingTasks, setTaskStatus, sync83bDeadline, trainingKindForTask } from '@/domain/checklists/actions'
import { recordTrainingCompletion } from '@/domain/compliance/actions'
import { viewerPerson } from '@/domain/people'
import { generateChecklist } from '@/domain/checklists/generate'
import type { DB } from '@/domain/types'

// The store loads the sample on import; keep this test independent of the sample seed.
vi.mock('@/data/seed', async () => {
  const blank = await import('@/data/blank')
  return {
    SAMPLE_ANCHOR: '2026-10-09',
    buildSampleDB: () => blank.blankDB({ companyName: 'Test', founderFirstName: 'Test', founderLastName: 'Founder', foundedOn: '2025-01-01' }),
  }
})

function fixture(): DB {
  const db = blankDB({ companyName: 'Ledgerlark', founderFirstName: 'Maya', founderLastName: 'Raman', foundedOn: '2025-02-03' })
  const person = db.people[0]
  db.checklists.push(
    generateChecklist(db, {
      person,
      templateId: 'tpl-new-state',
      anchorDate: '2026-10-19',
      createdOn: '2026-10-09',
      id: 'ck-ns',
    }),
  )
  return db
}

describe('setTaskStatus', () => {
  it('marks a task done with who and when, and logs it', () => {
    const next = produce(fixture(), (d) => {
      expect(setTaskStatus(d, 'ck-ns', 't-ns-ns-register', 'done', { date: '2026-10-12', byId: 'p-founder', evidenceLink: 'https://peo.example/tx' })).toBe(true)
    })
    const t = next.checklists[0].tasks.find((x) => x.id === 't-ns-ns-register')
    expect(t).toMatchObject({ status: 'done', doneOn: '2026-10-12', doneById: 'p-founder', evidenceLink: 'https://peo.example/tx' })
    expect(next.activity[next.activity.length - 1]).toMatchObject({
      entityType: 'checklist',
      entityId: 'ck-ns',
      kind: 'task_done',
      text: 'Marked done: Registered for withholding and unemployment in the new state for Maya Raman',
    })
    expect(next.checklists[0].completedOn).toBeUndefined()
  })

  it('completes the checklist when nothing is open, and reopens it', () => {
    const done = produce(fixture(), (d) => {
      for (const t of d.checklists[0].tasks) setTaskStatus(d, 'ck-ns', t.id, 'done', { date: '2026-10-20' })
    })
    expect(done.checklists[0].completedOn).toBe('2026-10-20')
    const reopened = produce(done, (d) => {
      setTaskStatus(d, 'ck-ns', d.checklists[0].tasks[0].id, 'open', { date: '2026-10-21' })
    })
    expect(reopened.checklists[0].completedOn).toBeUndefined()
    expect(reopened.checklists[0].tasks[0].doneOn).toBeUndefined()
  })

  it('returns false for unknown ids', () => {
    produce(fixture(), (d) => {
      expect(setTaskStatus(d, 'ck-missing', 'x', 'done', { date: '2026-10-20' })).toBe(false)
    })
  })
})

function staffed(): DB {
  const db = blankDB({ companyName: 'Ledgerlark', founderFirstName: 'Maya', founderLastName: 'Raman', foundedOn: '2025-02-03' })
  const base = db.people[0]
  for (const [id, first] of [['p-lena', 'Lena'], ['p-kwame', 'Kwame'], ['p-sofia', 'Sofia'], ['p-nikhil', 'Nikhil']] as const) {
    db.people.push({ ...base, id, firstName: first, lastName: 'Tester', workEmail: `${first.toLowerCase()}@ledgerlark.com`, isFounder: false, managerId: 'p-founder', startDate: '2026-06-01', hireNumber: db.people.length + 1 })
  }
  return db
}

function findTask(db: DB, checklistId: string, templateTaskId: string) {
  const t = db.checklists.find((c) => c.id === checklistId)?.tasks.find((x) => x.templateTaskId === templateTaskId)
  if (!t) throw new Error(`missing ${templateTaskId}`)
  return t
}

describe('harassment tasks and the training tracker', () => {
  it('records the completion when the checklist task is marked done, and undoes it on reopen', () => {
    const db = staffed()
    const lena = db.people.find((p) => p.id === 'p-lena')
    if (!lena) throw new Error('fixture')
    db.checklists.push(generateChecklist(db, { person: lena, templateId: 'tpl-onboarding', anchorDate: lena.startDate, createdOn: '2026-05-20', id: 'ck-lena' }))
    db.trainings.push({ id: 'trn-pending', personId: 'p-lena', kind: 'harassment_employee', dueOn: '2026-12-01' })
    const taskId = findTask(db, 'ck-lena', 'on-harassment-training').id
    const done = produce(db, (d) => {
      setTaskStatus(d, 'ck-lena', taskId, 'done', { date: '2026-10-12' })
    })
    expect(done.trainings).toEqual([expect.objectContaining({ id: 'trn-pending', completedOn: '2026-10-12' })])
    const reopened = produce(done, (d) => {
      setTaskStatus(d, 'ck-lena', taskId, 'open', { date: '2026-10-13' })
    })
    expect(reopened.trainings[0].completedOn).toBeUndefined()
  })

  it('credits the new supervisor, not the report, for the change checklist task', () => {
    const db = staffed()
    const kwame = db.people.find((p) => p.id === 'p-kwame')
    if (!kwame) throw new Error('fixture')
    db.checklists.push(
      generateChecklist(db, {
        person: kwame,
        templateId: 'tpl-change',
        anchorDate: '2026-10-09',
        createdOn: '2026-10-09',
        id: 'ck-change',
        extra: { supervisor: true },
        overrides: { 'ch-supervisor-training': { assigneeId: 'p-lena', dueOn: '2027-04-09' } },
      }),
    )
    const next = produce(db, (d) => {
      setTaskStatus(d, 'ck-change', findTask(d as DB, 'ck-change', 'ch-supervisor-training').id, 'done', { date: '2026-11-02' })
    })
    expect(next.trainings).toEqual([expect.objectContaining({ personId: 'p-lena', kind: 'harassment_supervisor', completedOn: '2026-11-02', dueOn: '2027-04-09' })])
  })
})

describe('security training and policy acknowledgements stay in step with the checklist', () => {
  function withLena(): DB {
    const db = staffed()
    const lena = db.people.find((p) => p.id === 'p-lena')
    if (!lena) throw new Error('fixture')
    db.checklists.push(generateChecklist(db, { person: lena, templateId: 'tpl-onboarding', anchorDate: lena.startDate, createdOn: '2026-05-20', id: 'ck-lena' }))
    return db
  }

  it('maps training tasks to tracker kinds', () => {
    expect(trainingKindForTask({ templateTaskId: 'on-security-training' })).toBe('security_awareness')
    expect(trainingKindForTask({ templateTaskId: 'on-harassment-training' })).toBe('harassment_employee')
    expect(trainingKindForTask({ templateTaskId: 'on-ack-handbook' })).toBeUndefined()
  })

  it('records security training in the tracker when the task is marked done', () => {
    const db = withLena()
    const next = produce(db, (d) => {
      setTaskStatus(d, 'ck-lena', findTask(d as DB, 'ck-lena', 'on-security-training').id, 'done', { date: '2026-10-12' })
    })
    expect(next.trainings).toEqual([expect.objectContaining({ personId: 'p-lena', kind: 'security_awareness', completedOn: '2026-10-12' })])
  })

  it('records the acknowledgement when an acknowledgement task is marked done, once', () => {
    const db = withLena()
    const handbook = db.policies.find((p) => p.id === 'pl-handbook')
    if (!handbook) throw new Error('fixture')
    const next = produce(db, (d) => {
      const id = findTask(d as DB, 'ck-lena', 'on-ack-handbook').id
      setTaskStatus(d, 'ck-lena', id, 'done', { date: '2026-10-12' })
      setTaskStatus(d, 'ck-lena', id, 'open', { date: '2026-10-12' })
      setTaskStatus(d, 'ck-lena', id, 'done', { date: '2026-10-12' })
    })
    expect(next.acks.filter((a) => a.personId === 'p-lena')).toEqual([expect.objectContaining({ policyId: 'pl-handbook', version: handbook.version, acknowledgedOn: '2026-10-12' })])
  })

  it('closes the open training task when the completion is recorded in the tracker', () => {
    const db = withLena()
    const next = produce(db, (d) => {
      recordTrainingCompletion(d, 'p-lena', 'security_awareness', '2026-10-12')
    })
    expect(findTask(next, 'ck-lena', 'on-security-training')).toMatchObject({ status: 'done', doneOn: '2026-10-12' })
    expect(next.trainings.filter((t) => t.kind === 'security_awareness')).toHaveLength(1)
    // Nothing else to close the second time.
    produce(next, (d) => {
      expect(closeTrainingTasks(d, 'p-lena', 'security_awareness', '2026-10-13')).toBe(0)
    })
  })

  it('tracks the signed PIIA and the confidentiality agreement acknowledgement as one document', () => {
    const db = withLena()
    const policy = db.policies.find((p) => p.id === 'pl-confidentiality')
    if (!policy) throw new Error('fixture')
    // Marking the PIIA signed records the acknowledgement on the day it was done
    const signed = produce(db, (d) => {
      setTaskStatus(d, 'ck-lena', findTask(d as DB, 'ck-lena', 'on-piia').id, 'done', { date: '2026-05-26' })
    })
    expect(signed.acks.filter((a) => a.personId === 'p-lena')).toEqual([
      expect.objectContaining({ policyId: 'pl-confidentiality', version: policy.version, acknowledgedOn: '2026-05-26' }),
    ])
    // Recording the acknowledgement elsewhere closes the PIIA task
    const acked = produce(db, (d) => {
      expect(closeAckTasks(d, 'p-lena', 'pl-confidentiality', '2026-05-27')).toBe(1)
    })
    expect(findTask(acked, 'ck-lena', 'on-piia')).toMatchObject({ status: 'done', doneOn: '2026-05-27' })
  })

  it('closes the open acknowledgement task for that person and policy only', () => {
    const db = withLena()
    const next = produce(db, (d) => {
      expect(closeAckTasks(d, 'p-lena', 'pl-aup', '2026-10-12')).toBe(1)
      expect(closeAckTasks(d, 'p-kwame', 'pl-handbook', '2026-10-12')).toBe(0)
    })
    expect(findTask(next, 'ck-lena', 'on-ack-security').status).toBe('done')
    expect(findTask(next, 'ck-lena', 'on-ack-handbook').status).toBe('open')
  })

  it('names the default person for each Viewing-as mode, which is also the activity actor', () => {
    const db = staffed()
    expect(viewerPerson(db, 'admin', null)?.id).toBe('p-founder')
    expect(viewerPerson(db, 'employee', 'p-sofia')?.id).toBe('p-sofia')
    expect(viewerPerson(db, 'employee', null)?.isFounder).toBe(false)
    const next = produce(withLena(), (d) => {
      setTaskStatus(d, 'ck-lena', findTask(d as DB, 'ck-lena', 'on-ack-handbook').id, 'done', { date: '2026-10-12' })
    })
    expect(next.activity[next.activity.length - 1].actorId).toBe('p-founder')
  })
})

describe('leave checklist privacy', () => {
  it('logs a neutral line instead of the task title', () => {
    const db = staffed()
    const sofia = db.people.find((p) => p.id === 'p-sofia')
    if (!sofia) throw new Error('fixture')
    db.checklists.push(generateChecklist(db, { person: sofia, templateId: 'tpl-leave', anchorDate: '2026-11-16', createdOn: '2026-10-06', id: 'ck-leave', extra: { leaveKind: 'pdl' } }))
    const next = produce(db, (d) => {
      setTaskStatus(d, 'ck-leave', findTask(d as DB, 'ck-leave', 'lv-lactation').id, 'done', { date: '2026-10-07' })
    })
    expect(next.activity[next.activity.length - 1].text).toBe('Updated the leave checklist for Sofia Tester')
  })
})

describe('sync83bDeadline', () => {
  it('gives the 83(b) task its real deadline once the early exercise is recorded', () => {
    const db = staffed()
    const nikhil = db.people.find((p) => p.id === 'p-nikhil')
    if (!nikhil) throw new Error('fixture')
    db.grants.push({
      id: 'g-n',
      personId: 'p-nikhil',
      holderType: 'employee',
      type: 'ISO',
      shares: 10_000,
      strikePrice: 1.15,
      vestingStart: '2026-06-01',
      cliffMonths: 12,
      vestingMonths: 48,
      status: 'approved',
      exercisedShares: 0,
      earlyExercise: true,
      postTerminationExerciseDays: 90,
    })
    db.checklists.push(generateChecklist(db, { person: nikhil, templateId: 'tpl-onboarding', anchorDate: nikhil.startDate, createdOn: '2026-05-20', id: 'ck-n' }))
    expect(findTask(db, 'ck-n', 'on-83b').statutory).toBe(false)
    db.grants[0].election83bDueOn = '2026-12-04'
    let changed = 0
    const next = produce(db, (d) => {
      changed = sync83bDeadline(d, 'p-nikhil')
    })
    expect(changed).toBe(1)
    expect(findTask(next, 'ck-n', 'on-83b')).toMatchObject({ dueOn: '2026-12-04', statutory: true, dueRuleText: '30 days after early exercise' })
    expect(next.activity[next.activity.length - 1].text).toBe('Set the 83(b) filing deadline for Nikhil Tester to Dec 4, 2026')
  })
})
