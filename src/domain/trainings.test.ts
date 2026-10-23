import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { addContractor, addMany, addPerson, ledgerlarkLite, makeDB } from '@/domain/compliance/testkit'
import type { DB, Person, TrainingKind } from '@/domain/types'
import { harassmentThresholdReachedOn, openTrainingRows, trainingMatrix, trainingRequirements } from './trainings'

function row(db: DB, p: Person, date: string, course: 'harassment' | 'security_awareness' | 'wvpp') {
  const r = trainingRequirements(db, p, date).find((x) => x.course === course)
  if (!r) throw new Error('missing row')
  return r
}

function complete(db: DB, personId: string, kind: TrainingKind, completedOn: string) {
  db.trainings.push({ id: `t-${db.trainings.length + 1}`, personId, kind, dueOn: completedOn, completedOn, certificateLink: 'https://example.test/cert' })
}

describe('harassment prevention training', () => {
  it('CA staff hired after the company has 5: due 6 months after hire, then every 2 years', () => {
    const db = makeDB()
    addMany(db, 4, '2025-02-03') // 5 from Feb 3, 2025
    const p = addPerson(db, { id: 'p-new', startDate: '2025-06-02' })
    expect(row(db, p, '2025-06-10', 'harassment')).toMatchObject({
      kind: 'harassment_employee',
      hours: 1,
      required: true,
      dueOn: '2025-12-02',
      status: 'upcoming',
    })
    expect(row(db, p, '2025-11-10', 'harassment').status).toBe('due')
    expect(row(db, p, '2025-12-03', 'harassment').status).toBe('overdue')
    complete(db, 'p-new', 'harassment_employee', '2025-11-20')
    expect(row(db, p, '2025-12-03', 'harassment')).toMatchObject({
      status: 'done',
      completedOn: '2025-11-20',
      nextDueOn: '2027-11-20',
      dueOn: '2027-11-20',
      certificateLink: 'https://example.test/cert',
    })
    expect(row(db, p, '2027-11-01', 'harassment').status).toBe('due')
    expect(row(db, p, '2027-11-21', 'harassment').status).toBe('overdue')
  })

  it('when the company reaches 5 after hire (contractors count), due 6 months after reaching 5', () => {
    const db = makeDB()
    const early = addPerson(db, { id: 'p-early', startDate: '2025-02-03' })
    addContractor(db, { id: 'k1', startOn: '2025-03-01' })
    addContractor(db, { id: 'k2', startOn: '2025-05-01' })
    addContractor(db, { id: 'k-adv', kind: 'advisor', startOn: '2025-01-01' })
    addPerson(db, { id: 'p-fifth', startDate: '2025-07-07' })
    expect(harassmentThresholdReachedOn(db)).toBe('2025-07-07')
    const r = row(db, early, '2025-08-01', 'harassment')
    expect(r).toMatchObject({ required: true, dueOn: '2026-01-07', status: 'upcoming' })
    expect(r.reason).toContain('Due 6 months after the company reached 5 on Jul 7, 2025.')
  })

  it('is required in advance when an incoming hire will take the company to 5', () => {
    const db = makeDB()
    addMany(db, 3, '2025-02-03')
    const p = db.people[1]
    addPerson(db, { id: 'p-fifth', startDate: '2025-08-04' })
    const r = row(db, p, '2025-07-01', 'harassment')
    expect(r).toMatchObject({ required: true, status: 'upcoming', dueOn: '2026-02-04' })
    expect(r.reason).toContain('Required from Aug 4, 2025')
  })

  it('below 5 it is recommended, not required', () => {
    const db = makeDB()
    const p = addPerson(db, { id: 'p-one', startDate: '2025-03-03' })
    const r = row(db, p, '2025-06-01', 'harassment')
    expect(r).toMatchObject({ required: false, recommended: true, status: 'not_required' })
    expect(r.reason).toBe('Required once the company has 5 or more employees and contractors (2 now). Recommended now.')
  })

  it('a promotion to supervisor needs the 2-hour course within 6 months, even after the 1-hour one', () => {
    const db = makeDB()
    addMany(db, 3, '2025-02-03')
    const lead = addPerson(db, { id: 'p-lead', startDate: '2025-02-03' })
    complete(db, 'p-lead', 'harassment_employee', '2025-05-01')
    addPerson(db, { id: 'p-ic', startDate: '2025-03-03', managerId: 'p-lead' })
    db.comp.push(
      { id: 'cr1', personId: 'p-ic', effectiveOn: '2025-03-03', payType: 'salary', salary: 1, title: 'Eng', levelId: 'lv-l3', managerId: 'p-founder', reason: 'hire' },
      { id: 'cr2', personId: 'p-ic', effectiveOn: '2025-09-01', payType: 'salary', salary: 1, title: 'Eng', levelId: 'lv-l3', managerId: 'p-lead', reason: 'manager_change' },
    )
    const r = row(db, lead, '2025-10-01', 'harassment')
    expect(r).toMatchObject({ kind: 'harassment_supervisor', hours: 2, required: true, dueOn: '2026-03-01', status: 'upcoming' })
    expect(r.completedOn).toBeUndefined()
    complete(db, 'p-lead', 'harassment_supervisor', '2026-01-15')
    expect(row(db, lead, '2026-02-01', 'harassment')).toMatchObject({ status: 'done', nextDueOn: '2028-01-15' })
  })

  it('outside California it is not required (recommended), and a completion still shows as done', () => {
    const db = makeDB()
    addMany(db, 5, '2025-02-03')
    const tx = addPerson(db, { id: 'p-tx', startDate: '2025-03-03', homeState: 'TX', workMode: 'remote', locationId: 'loc-remote-tx' })
    const r = row(db, tx, '2025-10-01', 'harassment')
    expect(r).toMatchObject({ required: false, recommended: true, status: 'not_required', dueOn: '2025-09-03' })
    expect(r.reason).toBe('Works outside California (TX), so this training is not required. Recommended.')
    complete(db, 'p-tx', 'harassment_employee', '2025-08-01')
    expect(row(db, tx, '2025-10-01', 'harassment').status).toBe('done')
  })

  it('matches the sample story dates', () => {
    const db = ledgerlarkLite()
    const d = '2026-10-09'
    const get = (id: string) => db.people.find((p) => p.id === id) as Person
    expect(harassmentThresholdReachedOn(db)).toBe('2025-08-18') // Elena plus the Northline contract
    expect(row(db, get('p-founder'), d, 'harassment')).toMatchObject({ kind: 'harassment_supervisor', dueOn: '2026-02-18', status: 'overdue' })
    expect(row(db, get('p-tomas'), d, 'harassment')).toMatchObject({ kind: 'harassment_supervisor', dueOn: '2026-04-06' })
    expect(row(db, get('p-kofi'), d, 'harassment')).toMatchObject({ kind: 'harassment_employee', dueOn: '2026-04-06' })
    expect(row(db, get('p-caleb'), d, 'harassment')).toMatchObject({ required: false, status: 'not_required' })
    expect(row(db, get('p-lucas'), d, 'harassment')).toMatchObject({ required: true, dueOn: '2027-04-19', status: 'upcoming' })
    expect(row(db, get('p-aisha'), d, 'security_awareness')).toMatchObject({ required: true, dueOn: '2026-10-08', status: 'overdue' })
  })
})

describe('security awareness training', () => {
  it('required within 30 days of start, then yearly, when SOC 2 is on', () => {
    const db = makeDB()
    db.company.soc2Enabled = true
    const p = addPerson(db, { id: 'p-a', startDate: '2026-09-14' })
    expect(row(db, p, '2026-09-20', 'security_awareness')).toMatchObject({ required: true, dueOn: '2026-10-14', status: 'due' })
    expect(row(db, p, '2026-10-15', 'security_awareness').status).toBe('overdue')
    complete(db, 'p-a', 'security_awareness', '2026-10-02')
    expect(row(db, p, '2026-10-15', 'security_awareness')).toMatchObject({ status: 'done', nextDueOn: '2027-10-02' })
    expect(row(db, p, '2027-09-10', 'security_awareness').status).toBe('due')
  })

  it('recommended when SOC 2 is off', () => {
    const db = makeDB()
    const p = addPerson(db, { id: 'p-a', startDate: '2026-09-14' })
    expect(row(db, p, '2026-09-20', 'security_awareness')).toMatchObject({ required: false, recommended: true, status: 'not_required', dueOn: '2026-10-14' })
  })
})

describe('workplace violence prevention training', () => {
  it('required for on-site staff when SB 553 applies; due 30 days after the plan, then yearly', () => {
    const db = makeDB()
    addMany(db, 11, '2025-03-03')
    db.locations[0].typicalMaxOnSite = 11
    const onsite = db.people[2]
    const remote = addPerson(db, { id: 'p-remote', startDate: '2025-03-03', workMode: 'remote', locationId: 'loc-remote-ca' })
    expect(row(db, onsite, '2025-06-01', 'wvpp')).toMatchObject({ required: true, status: 'due' })
    expect(row(db, onsite, '2025-06-01', 'wvpp').dueOn).toBeUndefined()
    expect(row(db, remote, '2025-06-01', 'wvpp')).toMatchObject({ required: false, status: 'not_required' })
    db.complianceStatus.wvpp = { actionsDone: { 'write-plan': '2025-09-01' } }
    expect(row(db, onsite, '2025-09-05', 'wvpp')).toMatchObject({ required: true, dueOn: '2025-10-01', status: 'due' })
    const late = addPerson(db, { id: 'p-late', startDate: '2025-11-03' })
    expect(row(db, late, '2025-11-05', 'wvpp')).toMatchObject({ dueOn: '2025-12-03' })
    complete(db, onsite.id, 'wvpp', '2025-09-20')
    expect(row(db, onsite, '2025-10-05', 'wvpp')).toMatchObject({ status: 'done', nextDueOn: '2026-09-20' })
  })

  it('not required when fewer than 10 are on site and the office is closed to the public', () => {
    const db = makeDB()
    addMany(db, 11, '2025-03-03')
    db.locations[0].typicalMaxOnSite = 8
    expect(row(db, db.people[1], '2025-06-01', 'wvpp')).toMatchObject({ required: false, status: 'not_required' })
  })
})

describe('after the last day', () => {
  it('nothing is required once a person has left; a still-valid completion shows as done', () => {
    const db = makeDB('2025-01-06')
    db.company.soc2Enabled = true
    addMany(db, 4, '2025-01-06')
    const p = addPerson(db, { id: 'p-gone', startDate: '2025-03-03', endDate: '2026-09-18', separation: { type: 'resigned_notice', reason: 'x', lastDay: '2026-09-18' } })
    complete(db, 'p-gone', 'harassment_employee', '2025-06-01')
    const before = row(db, p, '2026-09-01', 'security_awareness')
    expect(before).toMatchObject({ required: true, status: 'overdue' })
    const rows = trainingRequirements(db, p, '2026-10-09')
    for (const r of rows) {
      expect(r).toMatchObject({ required: false, recommended: false, reason: 'Left on Sep 18, 2026; no longer required.' })
    }
    expect(rows.find((r) => r.course === 'harassment')).toMatchObject({ status: 'done', completedOn: '2025-06-01', nextDueOn: '2027-06-01' })
    expect(rows.find((r) => r.course === 'security_awareness')).toMatchObject({ status: 'not_required', dueOn: undefined })
  })
})

describe('before a scheduled last day', () => {
  /** 12 on site under a written WVPP plan (Oct 11), so on-site staff train by Nov 10. */
  function wvppDB(): DB {
    const db = makeDB()
    addMany(db, 11, '2025-03-03')
    db.locations[0].typicalMaxOnSite = 12
    db.complianceStatus.wvpp = { actionsDone: { 'write-plan': '2026-10-11' } }
    return db
  }

  it('a course due after the last day is not required, and drops from the open rows and the counts', () => {
    const db = wvppDB()
    const nikhil = addPerson(db, { id: 'p-nikhil', startDate: '2025-04-07', endDate: '2026-10-30', separation: { type: 'resigned_notice', reason: 'x', lastDay: '2026-10-30' } })
    const elena = addPerson(db, { id: 'p-elena', startDate: '2025-04-07', endDate: '2026-10-11', separation: { type: 'terminated', reason: 'x', lastDay: '2026-10-11' } })
    const stays = db.people[3]
    const d = '2026-10-11'
    expect(row(db, stays, d, 'wvpp')).toMatchObject({ required: true, dueOn: '2026-11-10', status: 'due' })
    expect(row(db, nikhil, d, 'wvpp')).toMatchObject({ required: false, recommended: false, status: 'not_required', dueOn: undefined, reason: 'Leaves Oct 30, 2026, before it is due; not required.' })
    expect(row(db, elena, d, 'wvpp')).toMatchObject({ required: false, reason: 'Leaves Oct 11, 2026, before it is due; not required.' })
    const open = openTrainingRows(db, d, 'wvpp').map((r) => r.person.id)
    expect(open).toContain(stays.id)
    expect(open).not.toContain('p-nikhil')
    expect(open).not.toContain('p-elena')
    const m = trainingMatrix(db, d)
    const without = trainingMatrix(produce(db, (x) => { x.people = x.people.filter((p) => p.id !== 'p-nikhil' && p.id !== 'p-elena') }), d)
    expect(m.counts.due).toBe(without.counts.due)
  })

  it('harassment training due 6 months after hire is not required for someone leaving before then', () => {
    const db = makeDB()
    addMany(db, 5, '2025-02-03')
    const p = addPerson(db, { id: 'p-short', startDate: '2026-08-03', endDate: '2026-12-18', separation: { type: 'resigned_notice', reason: 'x', lastDay: '2026-12-18' } })
    expect(row(db, p, '2026-10-11', 'harassment')).toMatchObject({ required: false, status: 'not_required', reason: 'Leaves Dec 18, 2026, before it is due; not required.' })
    // Due before the last day: still required.
    const later = addPerson(db, { id: 'p-later', startDate: '2026-08-03', endDate: '2027-03-31', separation: { type: 'resigned_notice', reason: 'x', lastDay: '2027-03-31' } })
    expect(row(db, later, '2026-10-11', 'harassment')).toMatchObject({ required: true, dueOn: '2027-02-03' })
  })

  it('a valid completion with its refresher after the last day still shows as done', () => {
    const db = makeDB()
    addMany(db, 5, '2025-02-03')
    const p = addPerson(db, { id: 'p-done', startDate: '2025-03-03', endDate: '2026-10-30', separation: { type: 'resigned_notice', reason: 'x', lastDay: '2026-10-30' } })
    complete(db, 'p-done', 'harassment_employee', '2025-06-01')
    expect(row(db, p, '2026-10-11', 'harassment')).toMatchObject({ required: false, status: 'done', nextDueOn: '2027-06-01' })
  })
})

describe('training matrix', () => {
  it('lists current and incoming people by course, without former employees', () => {
    const db = ledgerlarkLite()
    const m = trainingMatrix(db, '2026-10-09')
    expect(m.courses.map((c) => c.course)).toEqual(['harassment', 'security_awareness', 'wvpp'])
    const ids = m.rows.map((r) => r.person.id)
    expect(ids).not.toContain('p-omar')
    expect(ids).toContain('p-mei')
    expect(ids[0]).toBe('p-founder')
    const caleb = m.rows.find((r) => r.person.id === 'p-caleb')
    expect(caleb?.cells.harassment.status).toBe('not_required')
    expect(caleb?.cells.wvpp.required).toBe(false) // remote
    expect(m.counts.overdue).toBeGreaterThan(0)
  })
})
