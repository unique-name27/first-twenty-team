// The store loads first so every seed and domain module finishes loading before the hiring seed runs
// (the store builds the sample on load; see the import note in src/domain/lifecycle.ts).
import '@/store/db'
import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import { attentionReasons, slaState } from '@/domain/hiring/pipeline'
import { allScorecardsOwed } from '@/domain/hiring/scorecards'
import { median, pacificDateOf } from '@/domain/hiring/util'
import type { DB, Person } from '@/domain/types'
import { daysBetween, isWeekday } from '@/lib/dates'
import { applyHiring } from './hiring'
import { rosterDates } from './hiring/catalog'
import { buildSampleDB } from './index'

const ANCHOR = '2026-10-09'

function mk(id: string, firstName: string, lastName: string, x: Partial<Person> & Pick<Person, 'title' | 'startDate' | 'hireNumber'>): Person {
  return {
    id,
    firstName,
    lastName,
    workEmail: `${firstName.toLowerCase()}@ledgerlark.com`,
    departmentId: 'd-eng',
    familyId: 'f-eng',
    levelId: 'lv-l3',
    managerId: 'p-founder',
    locationId: 'loc-hq',
    workMode: 'hybrid',
    homeState: 'CA',
    employmentType: 'full_time',
    hoursPerWeek: 40,
    flsa: 'exempt',
    emergencyContacts: [],
    ...x,
  }
}

/** Founder plus hires 2-15 from docs/SAMPLE.md, with the org bits the hiring seed reads. */
function fixture(): DB {
  const db = blankDB({ companyName: 'Ledgerlark', founderFirstName: 'Maya', founderLastName: 'Raman', foundedOn: '2025-02-03' })
  db.company.website = 'ledgerlark.com'
  db.company.soc2Enabled = true
  db.departments.push({ id: 'd-ai', name: 'Applied AI', headId: 'p-priya' }, { id: 'd-acct', name: 'Accounting', headId: 'p-elena' })
  db.locations.push({ id: 'loc-remote-tx', name: 'Remote (Texas)', kind: 'remote', state: 'TX', minWageHourly: 7.25 })
  db.equity.fullyDilutedShares = 12_000_000
  db.equity.valuations = [
    { id: 'v-1', effectiveOn: '2025-05-01', fmvPerShare: 0.25, provider: 'Meridian Valuation Group', expiresOn: '2026-05-01' },
    { id: 'v-2', effectiveOn: '2026-03-20', fmvPerShare: 1.15, provider: 'Meridian Valuation Group', expiresOn: '2027-03-20' },
  ]
  db.people.push(
    mk('p-tomas', 'Tomas', 'Herrera', { title: 'Founding engineer', levelId: 'lv-l4', startDate: '2025-05-12', hireNumber: 2, exemptionBasis: 'computer_professional' }),
    mk('p-priya', 'Priya', 'Nair', { title: 'Founding ML engineer', departmentId: 'd-ai', familyId: 'f-ml', levelId: 'lv-l4', startDate: '2025-06-09', hireNumber: 3 }),
    mk('p-elena', 'Elena', 'Vasquez', { title: 'Head of accounting', departmentId: 'd-acct', familyId: 'f-acct', levelId: 'lv-m1', startDate: '2025-08-18', hireNumber: 4 }),
    mk('p-kofi', 'Kofi', 'Boateng', { title: 'Senior software engineer', managerId: 'p-tomas', startDate: '2025-10-06', hireNumber: 5 }),
    mk('p-sofia', 'Sofia', 'Rossi', { title: 'Product designer', departmentId: 'd-product', familyId: 'f-design', locationId: 'loc-remote-ca', workMode: 'remote', startDate: '2026-01-12', hireNumber: 6 }),
    mk('p-caleb', 'Caleb', 'Washington', { title: 'Founding account executive', departmentId: 'd-gtm', familyId: 'f-gtm', locationId: 'loc-remote-tx', workMode: 'remote', homeState: 'TX', startDate: '2026-03-02', hireNumber: 7 }),
    mk('p-hannah', 'Hannah', 'Kim', { title: 'Applied AI engineer (evals)', departmentId: 'd-ai', familyId: 'f-ml', managerId: 'p-priya', startDate: '2026-03-16', hireNumber: 8 }),
    mk('p-nikhil', 'Nikhil', 'Rao', { title: 'Security and compliance engineer', managerId: 'p-tomas', startDate: '2026-04-13', hireNumber: 9 }),
    mk('p-omar', 'Omar', 'Haddad', { title: 'Data engineer', managerId: 'p-tomas', startDate: '2026-05-04', endDate: '2026-08-28', hireNumber: 10 }),
    mk('p-jasmine', 'Jasmine', 'Torres', { title: 'Finance and people operations lead', departmentId: 'd-ops', familyId: 'f-ops', startDate: '2026-06-01', hireNumber: 11 }),
    mk('p-chris', 'Chris', 'Nakamura', { title: 'Solutions engineer', departmentId: 'd-acct', familyId: 'f-solutions', managerId: 'p-elena', startDate: '2026-07-13', hireNumber: 12 }),
    mk('p-luis', 'Luis', 'Ortega', {
      title: 'Office and events coordinator',
      departmentId: 'd-ops',
      familyId: 'f-ops',
      levelId: 'lv-l1',
      managerId: 'p-jasmine',
      workMode: 'onsite',
      employmentType: 'part_time',
      hoursPerWeek: 24,
      flsa: 'non_exempt',
      startDate: '2026-07-20',
      hireNumber: 13,
    }),
    mk('p-ravi', 'Ravi', 'Subramanian', { title: 'Staff software engineer', levelId: 'lv-l4', managerId: 'p-tomas', startDate: '2026-08-10', hireNumber: 14 }),
    mk('p-aisha', 'Aisha', 'Bello', { title: 'Customer success manager', departmentId: 'd-gtm', familyId: 'f-gtm', levelId: 'lv-l2', startDate: '2026-09-08', hireNumber: 15 }),
  )
  return db
}

function seeded(): DB {
  return produce(fixture(), (d) => {
    applyHiring(d)
  })
}

function activeByStage(db: DB, jobId: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const a of db.applications) if (a.jobId === jobId && a.status === 'active') out[a.stageId] = (out[a.stageId] ?? 0) + 1
  return out
}

/** Integrity checks that hold for any people seed: references, stage ids, dates and panels. */
function integrityProblems(db: DB): string[] {
  const out: string[] = []
  const cand = new Set(db.candidates.map((c) => c.id))
  const jobs = new Map(db.jobs.map((j) => [j.id, j]))
  const apps = new Map(db.applications.map((a) => [a.id, a]))
  const interviews = new Map(db.interviews.map((i) => [i.id, i]))
  const roster = rosterDates()
  const ids = new Set<string>()
  for (const list of [db.candidates, db.applications, db.interviews, db.scorecards, db.offers, db.jobs, db.plan, db.referrals]) {
    for (const r of list) {
      if (ids.has(r.id)) out.push(`duplicate id ${r.id}`)
      ids.add(r.id)
    }
  }
  for (const a of db.applications) {
    const job = jobs.get(a.jobId)
    if (!cand.has(a.candidateId)) out.push(`${a.id}: missing candidate`)
    if (!job) {
      out.push(`${a.id}: missing job`)
      continue
    }
    const stageIds = new Set(job.stages.map((s) => s.id))
    if (!stageIds.has(a.stageId)) out.push(`${a.id}: unknown stage ${a.stageId}`)
    let prev = ''
    for (const h of a.history) {
      if (!stageIds.has(h.stageId)) out.push(`${a.id}: history stage ${h.stageId}`)
      if (h.at < prev) out.push(`${a.id}: history out of order`)
      if (h.at > ANCHOR) out.push(`${a.id}: history after the anchor`)
      if (!isWeekday(h.at)) out.push(`${a.id}: stage date ${h.at} on a weekend`)
      prev = h.at
    }
    if (a.history[a.history.length - 1].stageId !== a.stageId) out.push(`${a.id}: stage does not match history`)
    if (job.openedOn && a.appliedOn < job.openedOn && a.status !== 'hired') out.push(`${a.id}: applied before the job opened`)
    if (a.status === 'active') {
      if (!a.nextStep) out.push(`${a.id}: active without a next step`)
    } else if (a.status === 'rejected' || a.status === 'withdrawn') {
      if (!a.outcomeReason || !a.closedOn || !a.notifiedOn) out.push(`${a.id}: closed without reason, close date or notice`)
      if ((a.closedOn ?? '') > ANCHOR) out.push(`${a.id}: closed after the anchor`)
    }
  }
  for (const i of db.interviews) {
    const app = apps.get(i.applicationId)
    if (!app) {
      out.push(`${i.id}: missing application`)
      continue
    }
    const job = jobs.get(app.jobId)
    if (job && !job.interviewPlan.some((s) => s.id === i.stepId)) out.push(`${i.id}: unknown step`)
    const day = pacificDateOf(i.startsAt)
    if (!isWeekday(day)) out.push(`${i.id}: on a weekend`)
    if (i.status === 'completed' && day > ANCHOR) out.push(`${i.id}: completed in the future`)
    if (i.status === 'scheduled' && day <= ANCHOR) out.push(`${i.id}: scheduled in the past`)
    for (const p of i.interviewerIds) {
      const r = roster[p]
      if (!r || r.start > day || (r.end && r.end < day)) out.push(`${i.id}: ${p} not employed on ${day}`)
    }
  }
  // Nobody is in two interviews at once (interviewers or candidates).
  const busy = new Map<string, Array<[number, number, string]>>()
  for (const i of db.interviews) {
    const start = Date.parse(i.startsAt)
    const end = start + i.durationMin * 60_000
    const who = [...i.interviewerIds, apps.get(i.applicationId)?.candidateId ?? '']
    for (const p of who) {
      for (const [s, e, id] of busy.get(p) ?? []) if (start < e && s < end) out.push(`${i.id} overlaps ${id} for ${p}`)
      busy.set(p, [...(busy.get(p) ?? []), [start, end, i.id]])
    }
  }
  for (const s of db.scorecards) {
    const i = interviews.get(s.interviewId)
    if (!i) out.push(`${s.id}: missing interview`)
    else if (!i.interviewerIds.includes(s.interviewerId)) out.push(`${s.id}: interviewer not on the panel`)
    if (s.submittedAt && s.submittedAt > '2026-10-09T23:59:59.000Z') out.push(`${s.id}: submitted in the future`)
    if (s.submittedAt && Object.keys(s.ratings).length === 0) out.push(`${s.id}: submitted without ratings`)
  }
  for (const o of db.offers) {
    if (!apps.has(o.applicationId) || !cand.has(o.candidateId) || !jobs.has(o.jobId)) out.push(`${o.id}: broken reference`)
  }
  for (const s of db.plan) if (s.jobId && !jobs.has(s.jobId)) out.push(`${s.id}: missing job`)
  for (const r of db.referrals) if (!cand.has(r.candidateId)) out.push(`${r.id}: missing candidate`)
  return out
}

describe('sample hiring seed (fixture people)', () => {
  const db = seeded()

  it('builds the plan to 20 and every job in the story bible', () => {
    expect(db.plan.map((s) => s.id)).toEqual([
      'ps-q3-solutions',
      'ps-q3-staff-swe',
      'ps-q3-csm',
      'ps-q3-data-backfill',
      'ps-q4-ml-agents',
      'ps-q4-staff-ml',
      'ps-q4-fullstack',
      'ps-q4-solutions-acct',
      'ps-q1-ae',
      'ps-q2-pm',
      'ps-q2-em-platform',
    ])
    const backfill = db.plan.find((s) => s.id === 'ps-q3-data-backfill')
    expect(backfill).toMatchObject({ isBackfill: true, backfillForPersonId: 'p-omar', personId: 'p-lucas', status: 'filled' })
    expect(db.plan.find((s) => s.id === 'ps-q4-ml-agents')?.personId).toBe('p-mei')
    expect(db.jobs).toHaveLength(22)
    const byId = new Map(db.jobs.map((j) => [j.id, j]))
    expect(byId.get('j-staff-ml')).toMatchObject({ status: 'open', payMin: 225_000, payMax: 285_000, hiringManagerId: 'p-priya', priority: 'high', openedOn: '2026-08-24' })
    expect(byId.get('j-fullstack')).toMatchObject({ status: 'open', payMin: 180_000, payMax: 235_000, hiringManagerId: 'p-tomas', openedOn: '2026-09-14' })
    expect(byId.get('j-ae')).toMatchObject({ status: 'open', payMin: 130_000, payMax: 160_000, hiringManagerId: 'p-caleb', openedOn: '2026-09-28' })
    expect(byId.get('j-ae')?.stages.find((s) => s.kind === 'technical')?.name).toBe('Mock discovery call')
    expect(byId.get('j-solutions-acct')).toMatchObject({ status: 'open', payMin: 165_000, payMax: 205_000, hiringManagerId: 'p-elena', departmentId: 'd-acct' })
    expect(byId.get('j-pm')).toMatchObject({ status: 'draft', payMin: null, payMax: null })
    expect(byId.get('j-em-platform')?.status).toBe('on_hold')
    expect(byId.get('j-data-eng-backfill')).toMatchObject({ status: 'filled', isBackfill: true, backfillForPersonId: 'p-omar' })
    expect(db.jobs.filter((j) => j.status === 'filled')).toHaveLength(16)
    for (const j of db.jobs.filter((x) => x.status === 'open')) {
      for (const step of j.interviewPlan) expect(step.interviewerIds.length).toBeGreaterThan(0)
    }
  })

  it('has the active pipelines from docs/SAMPLE.md and many closed applications', () => {
    expect(activeByStage(db, 'j-staff-ml')).toEqual({ new: 6, intro: 4, technical: 3, onsite: 2, offer: 1 })
    expect(activeByStage(db, 'j-fullstack')).toEqual({ new: 12, intro: 4, technical: 2, onsite: 1 })
    expect(activeByStage(db, 'j-ae')).toEqual({ new: 6, intro: 3, technical: 1 })
    expect(activeByStage(db, 'j-solutions-acct')).toEqual({ new: 8, intro: 2 })
    const count = (jobId: string) => db.applications.filter((a) => a.jobId === jobId).length
    expect(count('j-staff-ml')).toBe(45)
    expect(count('j-fullstack')).toBe(40)
    expect(count('j-ae')).toBe(18)
    expect(count('j-solutions-acct')).toBe(12)
    const newFullstack = db.applications.filter((a) => a.jobId === 'j-fullstack' && a.status === 'active' && a.stageId === 'new')
    const outbound = newFullstack.filter((a) => db.candidates.find((c) => c.id === a.candidateId)?.source === 'outbound')
    expect(outbound).toHaveLength(3)
    const agency = db.candidates.filter((c) => c.source === 'agency')
    expect(agency.length).toBeGreaterThan(0)
    for (const c of agency) expect(c.sourceDetail).toBe('Bright Path Talent')
    for (const c of db.candidates.filter((x) => x.source === 'referral' && x.referrerId)) {
      expect(db.referrals.some((r) => r.candidateId === c.id && r.referrerId === c.referrerId)).toBe(true)
    }
  })

  it('gives every active candidate a next step owned by someone who works here', () => {
    const roster = rosterDates()
    for (const a of db.applications.filter((x) => x.status === 'active')) {
      const owner = a.nextStep?.ownerId ?? ''
      const r = roster[owner]
      expect(r && r.start <= ANCHOR && (!r.end || r.end >= ANCHOR), `${a.id} owner ${owner}`).toBe(true)
    }
  })

  it('puts 2-3 Intro call candidates past SLA in j-fullstack on purpose, and snoozes a few', () => {
    const job = db.jobs.find((j) => j.id === 'j-fullstack')
    if (!job) throw new Error('missing job')
    const intro = db.applications.filter((a) => a.jobId === job.id && a.status === 'active' && a.stageId === 'intro')
    const over = intro.filter((a) => slaState(job, a, ANCHOR, db.holidays) === 'over')
    expect(over.length).toBeGreaterThanOrEqual(2)
    expect(over.length).toBeLessThanOrEqual(3)
    const snoozed = db.applications.filter((a) => a.status === 'active' && a.snoozedUntil && a.snoozedUntil > ANCHOR)
    expect(snoozed.length).toBeGreaterThanOrEqual(2)
    for (const a of snoozed) expect(attentionReasons(db, a, ANCHOR)).toEqual([])
  })

  it('owes exactly 3 scorecards: one by Ravi and two by Hannah for interviews held Oct 7-8', () => {
    const owed = allScorecardsOwed(db, '2026-10-09T20:00:00.000Z')
    expect(owed).toHaveLength(3)
    expect(owed.filter((o) => o.scorecard.interviewerId === 'p-hannah')).toHaveLength(2)
    expect(owed.filter((o) => o.scorecard.interviewerId === 'p-ravi')).toHaveLength(1)
    for (const o of owed) expect(['2026-10-07', '2026-10-08']).toContain(pacificDateOf(o.interview.startsAt))
  })

  it('schedules 2 onsites and 3 intro calls next week at the right Pacific times', () => {
    const next = db.interviews.filter((i) => i.status === 'scheduled')
    expect(next.filter((i) => i.stageId === 'onsite')).toHaveLength(2)
    expect(next.filter((i) => i.stageId === 'intro')).toHaveLength(3)
    expect(next).toHaveLength(5)
    for (const i of next) expect(pacificDateOf(i.startsAt) >= '2026-10-12' && pacificDateOf(i.startsAt) <= '2026-10-16').toBe(true)
    // 10:00 AM PDT on Mon Oct 12 is 17:00 UTC.
    expect(next.some((i) => i.startsAt === '2026-10-12T17:00:00.000Z')).toBe(true)
    // Elena is out Oct 12-16, so she is on no interview next week.
    for (const i of next) expect(i.interviewerIds).not.toContain('p-elena')
  })

  it("holds Daniel Reyes's offer for Maya's approval, with no options reserved yet", () => {
    const o = db.offers.find((x) => x.id === 'o-daniel-reyes')
    expect(o).toMatchObject({ status: 'awaiting_approval', salary: 262_000, equityShares: 50_000, draftedById: 'p-priya', draftedByRole: 'manager', jobId: 'j-staff-ml' })
    expect(db.grants.some((g) => g.fromOfferId === 'o-daniel-reyes')).toBe(false)
    const app = db.applications.find((a) => a.id === o?.applicationId)
    expect(app?.stageId).toBe('offer')
  })

  it('hires Lucas Ferreira and Mei Tanaka through the real Hire flow', () => {
    const lucas = db.people.find((p) => p.id === 'p-lucas')
    expect(lucas).toMatchObject({ hireNumber: 16, startDate: '2026-10-19', managerId: 'p-tomas', fromCandidateId: 'c-hire-lucas', backgroundCheck: { status: 'clear', completedOn: '2026-10-06' } })
    expect(db.comp.find((c) => c.personId === 'p-lucas')).toMatchObject({ id: 'cr-lucas-hire', salary: 195_000, reason: 'hire', approvedById: 'p-founder' })
    expect(db.grants.find((g) => g.personId === 'p-lucas')).toMatchObject({ id: 'g-lucas', status: 'promised', shares: 30_000, holderType: 'employee', fromOfferId: 'o-hire-lucas' })
    expect(db.offers.find((o) => o.id === 'o-hire-lucas')).toMatchObject({ status: 'accepted', decidedOn: '2026-09-30', personId: 'p-lucas', backgroundCheck: { status: 'complete', result: 'clear', completedOn: '2026-10-06' } })
    const ck = db.checklists.find((c) => c.personId === 'p-lucas' && c.kind === 'onboarding')
    expect(ck?.id).toBe('ck-lucas-onboarding')
    const task = (t: string) => ck?.tasks.find((x) => x.templateTaskId === t)
    expect(task('on-piia')?.status).toBe('done')
    expect(task('on-background-check')?.status).toBe('done')
    expect(task('on-payroll-invite')?.status).toBe('done')
    expect(task('on-laptop')).toMatchObject({ status: 'open' })
    expect(task('on-accounts')).toMatchObject({ status: 'open' })
    expect((task('on-laptop')?.dueOn ?? '') < '2026-10-19').toBe(true)
    expect((task('on-accounts')?.dueOn ?? '') < '2026-10-19').toBe(true)

    const mei = db.people.find((p) => p.id === 'p-mei')
    expect(mei).toMatchObject({ hireNumber: 17, startDate: '2026-11-02', managerId: 'p-priya', fromCandidateId: 'c-hire-mei' })
    expect(mei?.notes).toContain('H-1B')
    expect(db.grants.find((g) => g.personId === 'p-mei')).toMatchObject({ status: 'promised', shares: 38_000 })
    expect(db.offers.find((o) => o.id === 'o-hire-mei')).toMatchObject({ status: 'accepted', decidedOn: '2026-10-07', personId: 'p-mei' })
    expect(db.referrals.find((r) => r.candidateId === 'c-hire-mei')).toMatchObject({ referrerId: 'p-hannah', payableOn: '2027-01-31' })
    expect(db.jobs.find((j) => j.id === 'j-ml-agents')?.status).toBe('filled')
    expect(db.candidates.find((c) => c.id === 'c-hire-mei')?.sponsorship).toBe('yes')
    // No random ids left behind by the domain helpers.
    for (const row of db.activity) expect(row.id).toMatch(/^act-h-\d{3}$/)
  })

  it('records accepted offers for hires 2-15 that match the roster, without new hires', () => {
    const roster: Array<[string, number | null, number]> = [
      ['tomas', 185_000, 150_000],
      ['priya', 195_000, 102_000],
      ['elena', 182_000, 60_000],
      ['kofi', 178_000, 52_000],
      ['sofia', 172_000, 40_000],
      ['caleb', 140_000, 30_000],
      ['hannah', 205_000, 40_000],
      ['nikhil', 200_000, 35_000],
      ['omar', 188_000, 30_000],
      ['jasmine', 150_000, 20_000],
      ['chris', 168_000, 18_000],
      ['luis', null, 0],
      ['ravi', 235_000, 45_000],
      ['aisha', 140_000, 12_000],
    ]
    for (const [key, salary, equity] of roster) {
      const o = db.offers.find((x) => x.id === `o-hire-${key}`)
      expect(o, key).toMatchObject({ status: 'accepted', personId: `p-${key}`, equityShares: equity })
      if (salary != null) expect(o?.salary).toBe(salary)
      const p = db.people.find((x) => x.id === `p-${key}`)
      expect(o?.startDate).toBe(p?.startDate)
      expect(p?.fromCandidateId).toBe(`c-hire-${key}`)
      const app = db.applications.find((a) => a.id === `a-hire-${key}`)
      expect(app).toMatchObject({ status: 'hired', stageId: 'hired', conditionalOfferOn: o?.decidedOn })
    }
    const luis = db.offers.find((o) => o.id === 'o-hire-luis')
    expect(luis).toMatchObject({ payType: 'hourly', hourlyRate: 30, hoursPerWeek: 24, flsa: 'non_exempt', employmentType: 'part_time' })
    expect(db.offers.find((o) => o.id === 'o-hire-caleb')).toMatchObject({ variablePct: 1, locationId: 'loc-remote-tx' })
    expect(db.people.filter((p) => p.hireNumber > 15).map((p) => p.id).sort()).toEqual(['p-lucas', 'p-mei'])
    expect(db.referrals.find((r) => r.candidateId === 'c-hire-hannah')).toMatchObject({ referrerId: 'p-priya', bonusAmount: 5_000, paidOn: '2026-06-14' })
    expect(['c-hire-tomas', 'c-hire-priya', 'c-hire-elena'].map((id) => db.candidates.find((c) => c.id === id)?.sourceDetail)).toEqual(['Founder network', 'Founder network', 'Founder network'])
    expect(db.candidates.find((c) => c.id === 'c-hire-caleb')).toMatchObject({ source: 'agency', sourceDetail: 'Bright Path Talent' })
  })

  it('keeps time to accept near the benchmarks and records the lost offers', () => {
    const hired = db.applications.filter((a) => a.id.startsWith('a-hire-'))
    expect(hired).toHaveLength(16)
    const days = hired.map((a) => daysBetween(a.appliedOn, a.conditionalOfferOn ?? a.appliedOn))
    const m = median(days) ?? 0
    expect(m).toBeGreaterThanOrEqual(33)
    expect(m).toBeLessThanOrEqual(45)
    const declined = db.offers.filter((o) => o.status === 'declined')
    expect(declined.map((o) => o.declineReason).sort()).toEqual(['chose_other_offer', 'comp', 'location'])
    expect(declined.some((o) => /counteroffer/i.test(o.competingNote ?? ''))).toBe(true)
    const accepted = db.offers.filter((o) => o.status === 'accepted').length
    const rate = accepted / (accepted + declined.length)
    expect(rate).toBeGreaterThan(0.8)
    expect(rate).toBeLessThan(0.9)
    const keepWarm = db.candidates.filter((c) => c.tags.includes('keep warm'))
    expect(keepWarm.length).toBeGreaterThanOrEqual(5)
    // Grace Okafor, a silver medalist from the data engineer search, is back in the full-stack pipeline.
    const grace = db.applications.filter((a) => a.candidateId === 'c-grace-okafor')
    expect(grace.map((a) => a.jobId).sort()).toEqual(['j-data-eng', 'j-fullstack'])
  })

  it('stores archived funnels for filled jobs in line with the benchmarks', () => {
    for (const j of db.jobs.filter((x) => x.status === 'filled')) {
      const f = j.archivedFunnel
      expect(f, j.id).toBeDefined()
      if (!f) continue
      for (const v of Object.values(f)) expect(v).toBeGreaterThanOrEqual(0)
      const stored = db.applications.filter((a) => a.jobId === j.id).length
      const applied = stored + f.applied
      expect(applied).toBeGreaterThanOrEqual(50)
      expect(applied).toBeLessThanOrEqual(400)
      expect(stored).toBeLessThanOrEqual(5)
      expect(f.accepted).toBe(0)
    }
  })

  it('keeps references, stage ids, dates and interview panels consistent', () => {
    expect(integrityProblems(db)).toEqual([])
    for (const c of db.candidates) expect((c.retainUntil ?? '') >= c.createdOn).toBe(true)
  })

  it('never stores protected characteristics, pay history or em dashes, and stays small', () => {
    const forbidden = ['gender', 'race', 'ethnicity', 'age', 'dateOfBirth', 'birthday', 'pronouns', 'disability', 'veteran', 'religion', 'maritalStatus', 'salaryHistory', 'currentSalary', 'previousSalary']
    for (const c of db.candidates) for (const k of Object.keys(c)) expect(forbidden).not.toContain(k)
    const hiring = JSON.stringify({ plan: db.plan, jobs: db.jobs, candidates: db.candidates, applications: db.applications, interviews: db.interviews, scorecards: db.scorecards, offers: db.offers, referrals: db.referrals })
    expect(hiring.includes('—')).toBe(false)
    expect(hiring.length).toBeLessThan(650_000)
  })

  it('is deterministic', () => {
    expect(JSON.stringify(seeded())).toBe(JSON.stringify(db))
  })
})

describe('sample hiring seed (full sample)', () => {
  it('builds inside the composed sample with consistent hiring data', () => {
    const db = buildSampleDB()
    expect(db.jobs).toHaveLength(22)
    expect(db.offers.find((o) => o.id === 'o-daniel-reyes')?.status).toBe('awaiting_approval')
    expect(integrityProblems(db)).toEqual([])
    expect(JSON.stringify(db).length).toBeLessThan(900_000)
  })
})
