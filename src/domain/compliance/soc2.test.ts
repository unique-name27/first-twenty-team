import { describe, expect, it } from 'vitest'
import type { DB } from '@/domain/types'
import { soc2CSV, soc2Evidence } from './soc2'
import { addOffer, addPerson, makeDB } from './testkit'

function fixture(): DB {
  const db = makeDB('2025-01-06')
  db.company.soc2Enabled = true
  db.policies = [
    { id: 'pl-handbook', title: 'Employee handbook', version: '2.0', effectiveOn: '2026-09-15', summary: '', requiresAck: true },
    { id: 'pl-aup', title: 'Acceptable use policy', version: '1.0', effectiveOn: '2025-01-01', summary: '', requiresAck: true },
    { id: 'pl-new', title: 'Travel policy', version: '1.0', effectiveOn: '2026-10-01', summary: '', requiresAck: true },
    { id: 'pl-info', title: 'Benefits summary', version: '1.0', effectiveOn: '2025-01-01', summary: '', requiresAck: false },
  ]
  const train = (personId: string, completedOn: string) =>
    db.trainings.push({ id: `t-${db.trainings.length}`, personId, kind: 'security_awareness', dueOn: completedOn, completedOn, certificateLink: `https://lms.test/${personId}` })
  const ack = (personId: string, policyId: string, acknowledgedOn: string) =>
    db.acks.push({ id: `ack-${db.acks.length}`, policyId, version: '1.0', personId, acknowledgedOn })

  addPerson(db, { id: 'p-old', firstName: 'Olga', lastName: 'Old', startDate: '2025-03-03' })
  train('p-old', '2025-12-01')
  addPerson(db, { id: 'p-lapsed', firstName: 'Lars', lastName: 'Lapsed', startDate: '2025-03-03' })
  train('p-lapsed', '2025-09-01')

  addPerson(db, { id: 'p-wei', firstName: 'Wei', lastName: 'Chen', startDate: '2026-08-10', backgroundCheck: { status: 'clear', completedOn: '2026-08-01' } })
  train('p-wei', '2026-08-20')
  ack('p-wei', 'pl-handbook', '2026-08-10')
  ack('p-wei', 'pl-aup', '2026-08-11')

  addPerson(db, { id: 'p-jas', firstName: 'Jasmine', lastName: 'Torres', startDate: '2026-09-14', backgroundCheck: { status: 'clear', completedOn: '2026-09-20' } })

  addPerson(db, { id: 'p-ravi', firstName: 'Ravi', lastName: 'Subramanian', startDate: '2026-10-26', fromApplicationId: 'a-o-ravi' })
  addOffer(db, {
    id: 'o-ravi',
    startDate: '2026-10-26',
    status: 'accepted',
    personId: 'p-ravi',
    backgroundCheck: { status: 'complete', result: 'clear', completedOn: '2026-10-07' },
  })

  addPerson(db, { id: 'p-ack', firstName: 'Ana', lastName: 'Acks', startDate: '2026-08-03', backgroundCheck: { status: 'not_required' } })
  train('p-ack', '2026-08-15')
  ack('p-ack', 'pl-aup', '2026-08-03')

  const exit = (id: string, firstName: string, startDate: string, lastDay: string) =>
    addPerson(db, { id, firstName, lastName: 'Exit', startDate, endDate: lastDay, separation: { type: 'resigned_notice', reason: 'New job', lastDay } })
  exit('p-ben', 'Ben', '2025-08-18', '2026-09-18')
  exit('p-late', 'Lou', '2025-08-18', '2026-08-28')
  exit('p-gone', 'Gil', '2025-08-18', '2026-09-30')
  exit('p-soon', 'Sam', '2025-08-18', '2026-10-30')
  const task = (id: string, doneOn: string) => ({
    id: `t-${id}`,
    title: 'Revoke all system access',
    ownerRole: 'it' as const,
    dueOn: doneOn,
    status: 'done' as const,
    doneOn,
    category: 'security' as const,
    soc2Control: 'access-revoked',
    statutory: false,
    evidenceLink: `https://idp.test/${id}`,
  })
  db.checklists.push(
    { id: 'ck-ben', personId: 'p-ben', kind: 'offboarding', templateId: 'x', anchorDate: '2026-09-18', createdOn: '2026-08-28', tasks: [task('ben', '2026-09-19')] },
    { id: 'ck-late', personId: 'p-late', kind: 'offboarding', templateId: 'x', anchorDate: '2026-08-28', createdOn: '2026-08-14', tasks: [task('late', '2026-09-02')] },
  )
  db.recurring.push({ id: 'r-ar', title: 'Quarterly access review (SOC 2)', cadence: 'quarterly', nextDueOn: '2026-10-31', lastDoneOn: '2026-07-28', ruleId: 'soc2-access-review' })
  return db
}

describe('SOC 2 evidence', () => {
  const ev = soc2Evidence(fixture(), '2026-08-01', '2027-01-31', '2026-10-09')
  const ctl = (id: string) => {
    const c = ev.controls.find((x) => x.id === id)
    if (!c) throw new Error(id)
    return c
  }
  const rowFor = (id: string, personId: string) => ctl(id).rows.find((r) => r.personId === personId)

  it('builds the hire, exit and active populations', () => {
    expect(ev.populations.hires.map((p) => p.id)).toEqual(['p-wei', 'p-jas', 'p-ravi', 'p-ack'])
    expect(ev.populations.exits.map((p) => p.id)).toEqual(['p-ben', 'p-late', 'p-gone', 'p-soon'])
    expect(ev.populations.active.map((p) => p.id)).toEqual(['p-founder', 'p-old', 'p-lapsed', 'p-wei', 'p-jas', 'p-ack', 'p-soon'])
    expect(ev.asOf).toBe('2026-10-09')
  })

  it('background check cleared before start', () => {
    expect(rowFor('background-check', 'p-wei')).toMatchObject({ ok: true, evidence: 'Cleared Aug 1, 2026, before the Aug 10, 2026 start.' })
    expect(rowFor('background-check', 'p-jas')).toMatchObject({ ok: false, gap: 'Cleared after the Sep 14, 2026 start date.' })
    expect(rowFor('background-check', 'p-ravi')).toMatchObject({ ok: true }) // from the accepted offer
    expect(rowFor('background-check', 'p-ack')).toMatchObject({ ok: true, evidence: 'Marked not required for this role.' })
    expect(ctl('background-check').gaps).toBe(1)
  })

  it('security training and policy acknowledgements within 30 days of start', () => {
    expect(rowFor('onboarding-training-acks', 'p-wei')).toMatchObject({ ok: true, evidence: 'Security training Aug 20, 2026; 2 of 2 acknowledgements on time.' })
    expect(rowFor('onboarding-training-acks', 'p-ack')).toMatchObject({ ok: false, gap: 'Missing acknowledgement: Employee handbook.' })
    expect(rowFor('onboarding-training-acks', 'p-jas')).toMatchObject({ ok: false, pending: true, dueOn: '2026-10-14' })
    expect(rowFor('onboarding-training-acks', 'p-ravi')).toMatchObject({ pending: true })
    expect(ctl('onboarding-training-acks').gaps).toBe(1)
  })

  it('annual security training for active staff', () => {
    expect(rowFor('annual-security-training', 'p-old')).toMatchObject({ ok: true, evidence: 'Completed Dec 1, 2025; next due Dec 1, 2026.' })
    expect(rowFor('annual-security-training', 'p-lapsed')).toMatchObject({ ok: false, gap: 'Lapsed on Sep 1, 2026.' })
    expect(rowFor('annual-security-training', 'p-founder')).toMatchObject({ ok: false, gap: 'No security training on record (first due Feb 5, 2025).' })
    expect(rowFor('annual-security-training', 'p-jas')).toMatchObject({ pending: true })
  })

  it('access revoked within 24 hours of the last day', () => {
    expect(rowFor('access-revoked', 'p-ben')).toMatchObject({ ok: true, link: 'https://idp.test/ben', evidence: 'Access revoked Sep 19, 2026 (last day Sep 18, 2026).' })
    expect(rowFor('access-revoked', 'p-late')).toMatchObject({ ok: false, gap: 'Revoked 5 days after the last day (Aug 28, 2026).' })
    expect(rowFor('access-revoked', 'p-gone')).toMatchObject({ ok: false, gap: 'No access revocation recorded for the Sep 30, 2026 last day.' })
    expect(rowFor('access-revoked', 'p-soon')).toMatchObject({ pending: true })
    expect(ctl('access-revoked').gaps).toBe(2)
  })

  it('quarterly access review', () => {
    expect(ctl('access-review').rows.map((r) => [r.label, r.ok, r.pending ?? false])).toEqual([
      ['Q3 2026', true, false],
      ['Q4 2026', false, true],
      ['Q1 2027', false, true],
    ])
    const past = soc2Evidence(fixture(), '2026-08-01', '2027-01-31', '2026-11-05')
    expect(past.controls.find((c) => c.id === 'access-review')?.rows[1]).toMatchObject({ ok: false, gap: 'No access review recorded for Q4 2026.' })
  })

  it('exports a CSV per control', () => {
    const csv = soc2CSV(ev, 'access-revoked')
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('Control,Period,Person,Result,Evidence,Gap,Due,Evidence link')
    expect(lines).toHaveLength(5)
    expect(lines[1]).toContain('Ben Exit,OK,')
    expect(csv).toContain('Not due yet')
    expect(soc2CSV(ev, 'access-review').split('\r\n')[0]).toContain(',Quarter,')
  })
})

describe('policy versions (Handbook 2.0 from Sep 15, 2026)', () => {
  function fixture(): DB {
    const db = makeDB('2025-02-03')
    db.company.soc2Enabled = true
    db.policies = [{ id: 'pl-hb', title: 'Employee handbook', version: '2.0', effectiveOn: '2026-09-15', summary: '', requiresAck: true }]
    const ack = (personId: string, version: string, acknowledgedOn: string) =>
      db.acks.push({ id: `ack-${db.acks.length}`, policyId: 'pl-hb', version, personId, acknowledgedOn })
    const hire = (id: string, firstName: string, startDate: string) => {
      addPerson(db, { id, firstName, lastName: 'Test', startDate, backgroundCheck: { status: 'not_required' } })
      db.trainings.push({ id: `t-${id}`, personId: id, kind: 'security_awareness', dueOn: startDate, completedOn: startDate })
    }
    ack('p-founder', '2', '2026-09-16') // '2' and '2.0' are the same version
    hire('p-tomas', 'Tomas', '2025-05-12')
    ack('p-tomas', '1.0', '2025-05-12')
    ack('p-tomas', '2.0', '2026-09-20')
    hire('p-caleb', 'Caleb', '2026-03-02')
    ack('p-caleb', '1.0', '2026-03-02')
    hire('p-ravi', 'Ravi', '2026-08-10')
    ack('p-ravi', '1.0', '2026-08-10')
    hire('p-aisha', 'Aisha', '2026-09-08')
    ack('p-aisha', '1.0', '2026-09-08')
    hire('p-late', 'Lou', '2025-06-02')
    ack('p-late', '2.0', '2026-10-20')
    hire('p-nina', 'Nina', '2026-10-01') // started after 2.0 took effect but signed the old version
    ack('p-nina', '1.0', '2026-10-01')
    hire('p-lucas', 'Lucas', '2026-10-19')
    ack('p-lucas', '2.0', '2026-10-19')
    return db
  }

  const ev = soc2Evidence(fixture(), '2026-08-01', '2027-01-31', '2026-11-20')
  const ctl = ev.controls.find((c) => c.id === 'onboarding-training-acks')
  if (!ctl) throw new Error('missing control')
  const sub = ctl.subChecks?.[0]
  if (!sub) throw new Error('missing sub-check')

  it('asks staff on board when 2.0 took effect to acknowledge 2.0 within 30 days', () => {
    expect(sub).toMatchObject({ id: 'policy-reacknowledgement', population: 'active' })
    const gapsFor = sub.rows.filter((r) => !r.ok && !r.pending).map((r) => r.personId)
    expect(gapsFor).toEqual(['p-caleb', 'p-ravi', 'p-aisha', 'p-late'])
    expect(sub.rows.find((r) => r.personId === 'p-ravi')).toMatchObject({
      label: 'Ravi Test: Employee handbook 2.0',
      gap: 'Employee handbook 2.0 not acknowledged (due Oct 15, 2026).',
    })
    expect(sub.rows.find((r) => r.personId === 'p-late')?.gap).toBe('Acknowledged Employee handbook 2.0 after the Oct 15, 2026 deadline.')
    expect(sub.rows.find((r) => r.personId === 'p-founder')).toMatchObject({ ok: true })
    expect(sub.rows.some((r) => r.personId === 'p-lucas' || r.personId === 'p-nina')).toBe(false)
  })

  it('a hire who started under 2.0 must acknowledge 2.0; one who started before may use 1.0', () => {
    const row = (id: string) => ctl.rows.find((r) => r.personId === id)
    expect(row('p-ravi')).toMatchObject({ ok: true })
    expect(row('p-aisha')).toMatchObject({ ok: true })
    expect(row('p-lucas')).toMatchObject({ ok: true })
    expect(row('p-nina')).toMatchObject({ ok: false, gap: 'Missing acknowledgement: Employee handbook 2.0.' })
    expect(ctl.gaps).toBe(5) // Nina's onboarding row plus 4 re-acknowledgements
  })

  it('pending before the 30 days are up, and exported with the control', () => {
    const early = soc2Evidence(fixture(), '2026-08-01', '2027-01-31', '2026-10-09')
    const earlySub = early.controls.find((c) => c.id === 'onboarding-training-acks')?.subChecks?.[0]
    expect(earlySub?.rows.find((r) => r.personId === 'p-ravi')).toMatchObject({ ok: false, pending: true, dueOn: '2026-10-15' })
    expect(earlySub?.gaps).toBe(0)
    const csv = soc2CSV(ev, 'onboarding-training-acks')
    expect(csv).toContain('New policy versions acknowledged within 30 days,')
    expect(csv).toContain('Ravi Test: Employee handbook 2.0,Gap,')
  })
})
