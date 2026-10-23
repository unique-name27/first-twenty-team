import { produce } from 'immer'
import { describe, expect, it, vi } from 'vitest'
import { closeOutRemaining, departmentForFamily, findTemplateFor, jobFromTemplate, markPosted, setCreditCheckBasis, setJobStatus, templateLabel } from './jobs'
import { fixtureDB, FRI, person } from './testkit'

vi.mock('@/data/seed', async () => {
  const { blankDB } = await import('@/data/blank')
  return { SAMPLE_ANCHOR: '2026-10-09', buildSampleDB: () => blankDB({ companyName: 'Fixture', founderFirstName: 'F', founderLastName: 'F' }) }
})

describe('jobFromTemplate', () => {
  it('prefills level, band range, equity guideline, JD outline, stages and interview plan', () => {
    const db = fixtureDB()
    const t = findTemplateFor(db, 'f-ml', 'lv-l3')
    expect(t?.id).toBe('rt-ml-agents')
    const job = jobFromTemplate(db, t, { id: 'j-new', date: FRI, hiringManagerId: 'p-priya' })
    expect(job).toMatchObject({
      id: 'j-new',
      title: 'ML engineer (agents)',
      familyId: 'f-ml',
      levelId: 'lv-l3',
      departmentId: 'd-eng',
      hiringManagerId: 'p-priya',
      panelIds: ['p-priya'],
      locationIds: ['loc-hq'],
      payMin: 195_000,
      payMax: 250_000,
      equityMinPct: 0.0015,
      equityMaxPct: 0.004,
      status: 'draft',
      roleTemplateId: 'rt-ml-agents',
      backgroundCheck: true,
      creditCheckBasis: null,
    })
    expect(job.stages.map((s) => s.id)).toEqual(['new', 'intro', 'technical', 'onsite', 'offer', 'hired'])
    expect(job.interviewPlan.every((s) => s.interviewerIds.length === 0 && s.attributes.length >= 3)).toBe(true)
    expect(job.description.startsWith("What you'll do")).toBe(true)
    // Copies, not shared references.
    job.stages[0].name = 'Changed'
    expect(db.settings.roleTemplates.find((x) => x.id === 'rt-ml-agents')?.stages[0].name).toBe('New')
  })

  it('falls back to the family template and leaves the range empty without a band', () => {
    const db = fixtureDB()
    expect(findTemplateFor(db, 'f-eng', 'lv-l5')?.familyId).toBe('f-eng')
    const job = jobFromTemplate(db, undefined, { date: FRI, hiringManagerId: 'p-founder', familyId: 'f-exec', levelId: 'lv-x1', title: 'Chief of staff' })
    expect(job).toMatchObject({ payMin: null, payMax: null, title: 'Chief of staff' })
  })

  it('titles a job with the plain role name, never the posting qualifier in the hint', () => {
    const db = fixtureDB()
    const csm = db.settings.roleTemplates.find((t) => t.id === 'rt-csm')
    expect(jobFromTemplate(db, csm, { date: FRI, hiringManagerId: 'p-founder' }).title).toBe('Customer success manager')
    const acct = db.settings.roleTemplates.find((t) => t.id === 'rt-accounting-lead')
    expect(jobFromTemplate(db, acct, { date: FRI, hiringManagerId: 'p-founder' }).title).toBe('Accounting lead')
    // The picker still shows the qualifier next to the name.
    expect(templateLabel(csm!)).toBe('Customer success manager (CPA preferred)')
    expect(templateLabel({ name: 'Product designer' })).toBe('Product designer')
  })

  it('leaves the title empty when there is no template and no title, so the sheet asks for one', () => {
    const job = jobFromTemplate(fixtureDB(), undefined, { date: FRI, hiringManagerId: 'p-founder' })
    expect(job.title).toBe('')
  })

  it('puts a blank job in the team its family belongs to, not Engineering', () => {
    const db = fixtureDB()
    const blank = (familyId: string) => jobFromTemplate(db, undefined, { date: FRI, hiringManagerId: 'p-founder', familyId, levelId: 'lv-l1', title: 'x' }).departmentId
    expect(blank('f-ops')).toBe('d-ops')
    expect(blank('f-acct')).toBe('d-ops')
    expect(blank('f-gtm')).toBe('d-gtm')
    expect(blank('f-design')).toBe('d-product')
    expect(blank('f-exec')).toBe('d-exec')
    expect(blank('f-ml')).toBe('d-eng')
    expect(departmentForFamily(db, 'f-ops')).toBe('d-ops')
    // A workspace without that department falls back to the first one on file; the template and an explicit pick still win.
    expect(departmentForFamily({ families: db.families, departments: [{ id: 'd-custom', name: 'Everyone' }] }, 'f-ops')).toBe('d-custom')
    expect(jobFromTemplate(db, undefined, { date: FRI, hiringManagerId: 'p-founder', familyId: 'f-ops', departmentId: 'd-eng' }).departmentId).toBe('d-eng')
    expect(jobFromTemplate(db, findTemplateFor(db, 'f-ml', 'lv-l3'), { date: FRI, hiringManagerId: 'p-founder', familyId: 'f-ops' }).departmentId).toBe('d-eng')
  })
})

describe('markPosted', () => {
  it('enforces the pay range hard stop at 15 when posting', () => {
    const big = produce(fixtureDB(), (d) => {
      for (let i = 0; i < 11; i++) d.people.push(person(`p-x${i}`, `X${i}`, 'Y', { startDate: '2026-01-05', hireNumber: 10 + i }))
      d.jobs[0].payMin = null
      d.jobs[0].status = 'draft'
    })
    produce(big, (d) => {
      expect(markPosted(d, 'j-fullstack', { date: FRI })).toEqual({ ok: false, reason: 'At 15 employees, California requires a pay range on every job post (Labor Code 432.3).' })
      d.jobs[0].payMin = 240_000
      d.jobs[0].payMax = 230_000
      expect(markPosted(d, 'j-fullstack', { date: FRI }).ok).toBe(false)
      d.jobs[0].payMin = 180_000
      expect(markPosted(d, 'j-fullstack', { date: FRI })).toEqual({ ok: true })
      expect(d.jobs[0]).toMatchObject({ status: 'open', postedOn: FRI })
    })
  })
})

describe('status, close-out and credit checks', () => {
  it('sets close dates and logs plain-language status changes', () => {
    const db = produce(fixtureDB(), (d) => {
      setJobStatus(d, 'j-fullstack', 'on_hold', { date: FRI })
      setJobStatus(d, 'j-fullstack', 'filled', { date: '2026-10-20' })
    })
    expect(db.jobs[0]).toMatchObject({ status: 'filled', closedOn: '2026-10-20' })
    expect(db.activity.map((a) => a.text)).toEqual(['Put the Senior full-stack engineer job on hold', 'Marked the Senior full-stack engineer job filled'])
  })

  it('closes out remaining candidates as position filled, sparing accepted offers', () => {
    const db = produce(fixtureDB(), (d) => {
      d.applications[0].conditionalOfferOn = '2026-10-08'
      expect(closeOutRemaining(d, 'j-fullstack', { date: FRI, notified: true })).toBe(2)
    })
    expect(db.applications.map((a) => [a.id, a.status, a.outcomeReason ?? null])).toEqual([
      ['a-alex', 'active', null],
      ['a-ben', 'rejected', 'position_filled'],
      ['a-chen', 'rejected', 'position_filled'],
    ])
    expect(db.applications[1].notifiedOn).toBe(FRI)
  })

  it('needs a listed basis for a credit check; the notice is owed per candidate, not per job', () => {
    const db = produce(fixtureDB(), (d) => {
      expect(setCreditCheckBasis(d, 'j-fullstack', 'because', { date: FRI }).ok).toBe(false)
      expect(setCreditCheckBasis(d, 'j-fullstack', 'account_and_identity_access', { date: FRI }).ok).toBe(true)
    })
    expect(db.jobs[0].creditCheckBasis).toBe('account_and_identity_access')
    expect(db.recurring).toHaveLength(0)
    expect(db.activity.at(-1)?.text).toBe(
      'Turned on a credit check for Senior full-stack engineer (Regular access to account numbers with SSN and date of birth). Each candidate gets the written notice before their report is ordered.',
    )
    // A candidate's open notice item goes away when the check is turned off; a done one stays.
    const withItems = produce(db, (d) => {
      d.offers.push({ id: 'o-1', jobId: 'j-fullstack' } as (typeof d.offers)[number], { id: 'o-2', jobId: 'j-fullstack' } as (typeof d.offers)[number])
      d.recurring.push(
        { id: 'rc-credit-notice-o-1', title: 'x', cadence: 'once', nextDueOn: FRI, ruleId: 'credit-check-notice' },
        { id: 'rc-credit-notice-o-2', title: 'y', cadence: 'once', nextDueOn: FRI, ruleId: 'credit-check-notice', lastDoneOn: FRI },
      )
    })
    const off = produce(withItems, (d) => {
      setCreditCheckBasis(d, 'j-fullstack', null, { date: FRI })
    })
    expect(off.jobs[0].creditCheckBasis).toBeNull()
    expect(off.recurring.map((r) => r.id)).toEqual(['rc-credit-notice-o-2'])
  })
})
