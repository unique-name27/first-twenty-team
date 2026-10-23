// Invariants for the composed Ledgerlark sample (buildSampleDB), built the way the app builds it.
// Every check runs with the clock pretending today is the sample anchor, Friday 2026-10-09.
// The store loads first so every seed and domain module finishes loading before the sample is built
// (the store builds the sample on load; see the import note in src/domain/lifecycle.ts).
import '@/store/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openTasks } from '@/domain/checklists/generate'
import { evaluateAll, payRangeRequiredToPost } from '@/domain/compliance/engine'
import { boardConsentQueue, cliffDate, poolSummary, sharesHeld, vestedShares } from '@/domain/equity'
import { allScorecardsOwed } from '@/domain/hiring/scorecards'
import { postingBlockReason, postingHeadcount } from '@/domain/hiring/postings'
import { pacificDateOf } from '@/domain/hiring/util'
import { currentComp, exemptCheck, exemptFlags } from '@/domain/pay'
import { payCalendar, payRunPrep, periodStarting } from '@/domain/payrun'
import { employmentState, headcountOn, incomingOn, onLeave } from '@/domain/people'
import { pendingApprovals, whoIsOut } from '@/domain/timeoff'
import { trainingRequirements } from '@/domain/trainings'
import type { DB, EntityType, ID } from '@/domain/types'
import { addDays, setClockOverride } from '@/lib/dates'
import { buildSampleDB, SAMPLE_ANCHOR } from './index'
import { samplePayRuns } from './payroll'

const TODAY = '2026-10-09'

let db: DB

beforeAll(() => {
  setClockOverride(TODAY)
  db = buildSampleDB()
})

afterAll(() => {
  setClockOverride(null)
})

const person = (id: ID) => {
  const p = db.people.find((x) => x.id === id)
  if (!p) throw new Error(`missing person ${id}`)
  return p
}

/** Every reference between collections, as a list of problems (empty when the data is consistent). */
function brokenReferences(d: DB): string[] {
  const out: string[] = []
  const ids = <T extends { id: ID }>(list: T[]) => new Set(list.map((r) => r.id))
  const people = ids(d.people)
  const candidates = ids(d.candidates)
  const jobs = new Map(d.jobs.map((j) => [j.id, j]))
  const apps = ids(d.applications)
  const interviews = new Map(d.interviews.map((i) => [i.id, i]))
  const offers = ids(d.offers)
  const contractors = ids(d.contractors)
  const departments = ids(d.departments)
  const levels = ids(d.levels)
  const families = ids(d.families)
  const locations = ids(d.locations)
  const policies = ids(d.policies)
  const timeOffPolicies = ids(d.timeOffPolicies)
  const plan = ids(d.plan)
  const checklists = ids(d.checklists)
  const requests = ids(d.timeOffRequests)
  const leaves = ids(d.leaveCases)
  const grants = ids(d.grants)
  const templates = ids(d.checklistTemplates)
  const check = (ok: boolean, msg: string) => {
    if (!ok) out.push(msg)
  }
  const optPerson = (id: ID | null | undefined, msg: string) => check(!id || people.has(id), msg)

  for (const dep of d.departments) optPerson(dep.headId, `department ${dep.id}: head ${dep.headId}`)
  for (const b of d.bands) check(families.has(b.familyId) && levels.has(b.levelId), `band ${b.id}: family or level`)

  for (const p of d.people) {
    optPerson(p.managerId, `${p.id}: manager ${p.managerId}`)
    check(p.managerId !== p.id, `${p.id}: manages themselves`)
    check(departments.has(p.departmentId), `${p.id}: department ${p.departmentId}`)
    check(levels.has(p.levelId), `${p.id}: level ${p.levelId}`)
    check(families.has(p.familyId), `${p.id}: family ${p.familyId}`)
    check(locations.has(p.locationId), `${p.id}: location ${p.locationId}`)
    check(!p.fromCandidateId || candidates.has(p.fromCandidateId), `${p.id}: candidate ${p.fromCandidateId}`)
    check(!p.fromApplicationId || apps.has(p.fromApplicationId), `${p.id}: application ${p.fromApplicationId}`)
    const mgr = d.people.find((m) => m.id === p.managerId)
    if (mgr && !p.endDate) check(!mgr.endDate || mgr.endDate >= TODAY, `${p.id}: manager ${mgr.id} has left`)
  }
  for (const c of d.comp) {
    check(people.has(c.personId), `comp ${c.id}: person ${c.personId}`)
    check(levels.has(c.levelId), `comp ${c.id}: level ${c.levelId}`)
    optPerson(c.managerId, `comp ${c.id}: manager ${c.managerId}`)
    check(!c.departmentId || departments.has(c.departmentId), `comp ${c.id}: department ${c.departmentId}`)
    optPerson(c.approvedById, `comp ${c.id}: approver ${c.approvedById}`)
  }
  for (const g of d.grants) {
    const holder =
      g.holderType === 'employee' ? people.has(g.personId) : g.holderType === 'candidate' ? candidates.has(g.personId) : contractors.has(g.personId)
    check(holder, `grant ${g.id}: ${g.holderType} ${g.personId}`)
    check(!g.fromOfferId || offers.has(g.fromOfferId), `grant ${g.id}: offer ${g.fromOfferId}`)
  }
  for (const k of d.contractors) {
    check(people.has(k.managerId), `contractor ${k.id}: manager ${k.managerId}`)
    check(departments.has(k.departmentId), `contractor ${k.id}: department ${k.departmentId}`)
  }
  // Documents belong to employees, or to advisors for their grant agreements.
  for (const doc of d.documents) check(people.has(doc.personId) || contractors.has(doc.personId), `document ${doc.id}: person ${doc.personId}`)

  for (const s of d.plan) {
    check(!s.jobId || jobs.has(s.jobId), `plan ${s.id}: job ${s.jobId}`)
    optPerson(s.personId, `plan ${s.id}: person ${s.personId}`)
    optPerson(s.backfillForPersonId, `plan ${s.id}: backfill for ${s.backfillForPersonId}`)
    check(departments.has(s.departmentId) && families.has(s.familyId) && levels.has(s.levelId), `plan ${s.id}: org fields`)
    if (s.jobId) check(jobs.get(s.jobId)?.planSlotId === s.id, `plan ${s.id}: job ${s.jobId} does not point back`)
  }
  for (const j of d.jobs) {
    check(departments.has(j.departmentId) && families.has(j.familyId) && levels.has(j.levelId), `job ${j.id}: org fields`)
    check(people.has(j.hiringManagerId), `job ${j.id}: hiring manager ${j.hiringManagerId}`)
    for (const p of j.panelIds) check(people.has(p), `job ${j.id}: panel ${p}`)
    for (const l of j.locationIds) check(locations.has(l), `job ${j.id}: location ${l}`)
    for (const step of j.interviewPlan) {
      check(j.stages.some((s) => s.id === step.stageId), `job ${j.id}: step ${step.id} stage ${step.stageId}`)
      for (const p of step.interviewerIds) check(people.has(p), `job ${j.id}: interviewer ${p}`)
    }
    check(!j.planSlotId || plan.has(j.planSlotId), `job ${j.id}: plan slot ${j.planSlotId}`)
    optPerson(j.backfillForPersonId, `job ${j.id}: backfill for ${j.backfillForPersonId}`)
  }
  for (const c of d.candidates) optPerson(c.referrerId, `candidate ${c.id}: referrer ${c.referrerId}`)
  for (const a of d.applications) {
    check(candidates.has(a.candidateId), `application ${a.id}: candidate ${a.candidateId}`)
    const job = jobs.get(a.jobId)
    check(!!job, `application ${a.id}: job ${a.jobId}`)
    if (job) check(job.stages.some((s) => s.id === a.stageId), `application ${a.id}: stage ${a.stageId}`)
    optPerson(a.nextStep?.ownerId, `application ${a.id}: next step owner ${a.nextStep?.ownerId}`)
    for (const h of a.history) optPerson(h.byId, `application ${a.id}: history by ${h.byId}`)
  }
  for (const i of d.interviews) {
    check(apps.has(i.applicationId), `interview ${i.id}: application ${i.applicationId}`)
    for (const p of i.interviewerIds) check(people.has(p), `interview ${i.id}: interviewer ${p}`)
  }
  for (const s of d.scorecards) {
    const i = interviews.get(s.interviewId)
    check(!!i, `scorecard ${s.id}: interview ${s.interviewId}`)
    check(apps.has(s.applicationId), `scorecard ${s.id}: application ${s.applicationId}`)
    check(!i || i.applicationId === s.applicationId, `scorecard ${s.id}: application differs from its interview`)
    check(people.has(s.interviewerId), `scorecard ${s.id}: interviewer ${s.interviewerId}`)
    optPerson(s.enteredById, `scorecard ${s.id}: entered by ${s.enteredById}`)
  }
  for (const o of d.offers) {
    check(apps.has(o.applicationId), `offer ${o.id}: application ${o.applicationId}`)
    check(candidates.has(o.candidateId), `offer ${o.id}: candidate ${o.candidateId}`)
    check(jobs.has(o.jobId), `offer ${o.id}: job ${o.jobId}`)
    const app = d.applications.find((a) => a.id === o.applicationId)
    check(!app || (app.candidateId === o.candidateId && app.jobId === o.jobId), `offer ${o.id}: application does not match`)
    check(people.has(o.managerId), `offer ${o.id}: manager ${o.managerId}`)
    check(levels.has(o.levelId) && families.has(o.familyId) && departments.has(o.departmentId) && locations.has(o.locationId), `offer ${o.id}: org fields`)
    optPerson(o.personId, `offer ${o.id}: person ${o.personId}`)
    optPerson(o.draftedById, `offer ${o.id}: drafted by ${o.draftedById}`)
    for (const ap of o.approvals) check(people.has(ap.approverId), `offer ${o.id}: approver ${ap.approverId}`)
  }
  for (const r of d.referrals) {
    check(candidates.has(r.candidateId), `referral ${r.id}: candidate ${r.candidateId}`)
    check(people.has(r.referrerId), `referral ${r.id}: referrer ${r.referrerId}`)
  }
  for (const c of d.checklists) {
    check(people.has(c.personId), `checklist ${c.id}: person ${c.personId}`)
    check(templates.has(c.templateId), `checklist ${c.id}: template ${c.templateId}`)
    for (const t of c.tasks) {
      optPerson(t.assigneeId, `checklist ${c.id} task ${t.id}: assignee ${t.assigneeId}`)
      optPerson(t.doneById, `checklist ${c.id} task ${t.id}: done by ${t.doneById}`)
    }
  }
  for (const r of d.timeOffRequests) {
    check(people.has(r.personId), `time off ${r.id}: person ${r.personId}`)
    check(timeOffPolicies.has(r.policyId), `time off ${r.id}: policy ${r.policyId}`)
    optPerson(r.approverId, `time off ${r.id}: approver ${r.approverId}`)
  }
  for (const a of d.timeOffAdjustments) {
    check(people.has(a.personId) && timeOffPolicies.has(a.policyId), `adjustment ${a.id}: person or policy`)
  }
  for (const l of d.leaveCases) check(people.has(l.personId), `leave ${l.id}: person ${l.personId}`)
  for (const t of d.trainings) check(people.has(t.personId), `training ${t.id}: person ${t.personId}`)
  for (const a of d.acks) {
    check(people.has(a.personId), `ack ${a.id}: person ${a.personId}`)
    check(policies.has(a.policyId), `ack ${a.id}: policy ${a.policyId}`)
  }
  for (const r of d.recordsRequests) check(people.has(r.personId), `records request ${r.id}: person ${r.personId}`)
  for (const r of d.recurring) optPerson(r.ownerId, `recurring ${r.id}: owner ${r.ownerId}`)
  for (const [ruleId, s] of Object.entries(d.complianceStatus)) optPerson(s.ownerId, `compliance ${ruleId}: owner ${s.ownerId}`)

  const entitySets: Partial<Record<EntityType, Set<ID>>> = {
    person: people,
    candidate: candidates,
    application: apps,
    job: new Set(jobs.keys()),
    offer: offers,
    interview: new Set(interviews.keys()),
    checklist: checklists,
    timeoff: requests,
    leave: leaves,
    contractor: contractors,
    plan,
  }
  for (const a of d.activity) {
    optPerson(a.actorId, `activity ${a.id}: actor ${a.actorId}`)
    const set = entitySets[a.entityType]
    if (set) check(set.has(a.entityId), `activity ${a.id}: ${a.entityType} ${a.entityId}`)
    // Equity rows name a grant, a holder, a 409A valuation, a pool increase or the equity setup ('equity'), as the domain logs them.
    if (a.entityType === 'equity') {
      const known = grants.has(a.entityId) || people.has(a.entityId) || contractors.has(a.entityId) || a.entityId === 'equity'
      const setup = d.equity.valuations.some((v) => v.id === a.entityId) || d.equity.poolIncreases.some((x) => x.id === a.entityId)
      check(known || setup, `activity ${a.id}: equity ${a.entityId}`)
    }
    if (a.relatedId) check(people.has(a.relatedId) || candidates.has(a.relatedId) || contractors.has(a.relatedId) || jobs.has(a.relatedId) || apps.has(a.relatedId), `activity ${a.id}: related ${a.relatedId}`)
  }
  return out
}

describe('composed sample: structure', () => {
  it('builds without throwing, flagged as the sample at the anchor', () => {
    expect(SAMPLE_ANCHOR).toBe(TODAY)
    expect(db.meta).toEqual({ createdOn: TODAY, sample: true, sampleAnchor: TODAY })
    expect(db.company.name).toBe('Ledgerlark')
  })

  it('is deterministic and never depends on the real clock', () => {
    expect(JSON.stringify(buildSampleDB())).toBe(JSON.stringify(db))
    setClockOverride('2027-03-15')
    try {
      expect(JSON.stringify(buildSampleDB())).toBe(JSON.stringify(db))
    } finally {
      setClockOverride(TODAY)
    }
  })

  it('stays under 900 KB when stringified', () => {
    expect(JSON.stringify(db).length).toBeLessThan(900_000)
  })

  it('has unique ids in every collection and every checklist', () => {
    for (const [key, value] of Object.entries(db)) {
      if (!Array.isArray(value) || !value.every((r) => r && typeof r === 'object' && 'id' in r)) continue
      const list = (value as Array<{ id: ID }>).map((r) => r.id)
      expect(new Set(list).size, key).toBe(list.length)
    }
    const taskIds = db.checklists.flatMap((c) => c.tasks.map((t) => t.id))
    expect(new Set(taskIds).size).toBe(taskIds.length)
  })

  it('resolves every foreign key', () => {
    expect(brokenReferences(db)).toEqual([])
  })

  it('dates all history on or before the anchor', () => {
    for (const a of db.activity) expect(a.at.slice(0, 10) <= TODAY, `${a.id} ${a.text}`).toBe(true)
    for (const c of db.candidates) expect(c.createdOn <= TODAY, c.id).toBe(true)
    for (const a of db.applications) expect(a.appliedOn <= TODAY && a.stageEnteredOn <= TODAY, a.id).toBe(true)
    for (const o of db.offers) expect(o.createdOn <= TODAY && (o.decidedOn ?? '') <= TODAY, o.id).toBe(true)
    for (const c of db.checklists) {
      expect(c.createdOn <= TODAY, c.id).toBe(true)
      for (const t of c.tasks) if (t.doneOn) expect(t.doneOn <= TODAY, `${c.id} ${t.id}`).toBe(true)
    }
    for (const t of db.trainings) if (t.completedOn) expect(t.completedOn <= TODAY, t.id).toBe(true)
    for (const a of db.acks) expect(a.acknowledgedOn <= TODAY, a.id).toBe(true)
    for (const r of db.timeOffRequests) expect(r.requestedOn <= TODAY && (r.decidedOn ?? '') <= TODAY, r.id).toBe(true)
    for (const g of db.grants) expect((g.boardApprovedOn ?? '') <= TODAY, g.id).toBe(true)
  })

  it('never starts or ends anyone on a weekend, and keeps comp history in order', () => {
    const weekday = (d: string) => {
      const [y, m, day] = d.split('-').map(Number)
      const w = new Date(y, m - 1, day).getDay()
      return w !== 0 && w !== 6
    }
    for (const p of db.people) {
      expect(weekday(p.startDate), `${p.id} start ${p.startDate}`).toBe(true)
      if (p.endDate) expect(weekday(p.endDate), `${p.id} end ${p.endDate}`).toBe(true)
      const rows = db.comp.filter((c) => c.personId === p.id)
      expect(rows.length, p.id).toBeGreaterThan(0)
      const first = [...rows].sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn))[0]
      expect(first.reason, p.id).toBe('hire')
      expect(first.effectiveOn >= p.startDate || p.isFounder, `${p.id} hire comp before start`).toBe(true)
    }
  })
})

describe('composed sample: headcount and people', () => {
  it('has 14 employed on the anchor, 15 when Lucas starts and 16 when Mei starts', () => {
    expect(headcountOn(db, TODAY)).toBe(14)
    expect(headcountOn(db, '2026-10-19')).toBe(15)
    expect(headcountOn(db, '2026-11-02')).toBe(16)
    expect(incomingOn(db, TODAY).map((p) => p.id)).toEqual(['p-lucas', 'p-mei'])
    expect(db.people.map((p) => p.hireNumber).sort((a, b) => a - b)).toEqual(Array.from({ length: 17 }, (_, i) => i + 1))
  })

  it('shows Omar as a former employee with a completed resignation', () => {
    const omar = person('p-omar')
    expect(employmentState(omar, TODAY, db)).toBe('former')
    expect(omar.endDate).toBe('2026-08-28')
    expect(omar.separation).toMatchObject({ type: 'resigned_notice', noticeGivenOn: '2026-08-14', lastDay: '2026-08-28', rehireEligible: true, finalPayIssuedOn: '2026-08-28' })
    // The only former employee on the anchor (Luis gave notice; his last day is Nov 10, see pay run prep below).
    expect(db.people.filter((p) => p.endDate && p.endDate < TODAY).map((p) => p.id)).toEqual(['p-omar'])
  })

  it('stores no protected characteristics or identity numbers on people', () => {
    const banned = /gender|^race$|ethnic|^age$|birth|^dob$|ssn|pronoun|disabil|veteran|religio|marital/i
    const walk = (v: unknown, path: string): string[] => {
      if (Array.isArray(v)) return v.flatMap((x, i) => walk(x, `${path}[${i}]`))
      if (v && typeof v === 'object') {
        return Object.entries(v).flatMap(([k, x]) => (banned.test(k) ? [`${path}.${k}`] : walk(x, `${path}.${k}`)))
      }
      return []
    }
    expect(walk(db.people, 'people')).toEqual([])
    expect(walk(db.candidates, 'candidates')).toEqual([])
    expect(walk(db.contractors, 'contractors')).toEqual([])
  })

  it('stores no salary history on candidates (desired pay only)', () => {
    const pay = /salary|currentpay|pastpay|previouspay|priorpay|payhistory|comphistory|currentcomp$|currentcompensation|currentbase/i
    for (const c of db.candidates) for (const k of Object.keys(c)) expect(pay.test(k), `${c.id}.${k}`).toBe(false)
    for (const a of db.applications) for (const k of Object.keys(a)) expect(pay.test(k), `${a.id}.${k}`).toBe(false)
    const text = JSON.stringify(db.candidates.map((c) => c.summary ?? '')).toLowerCase()
    expect(text).not.toMatch(/current (salary|pay|base)|currently (makes|earns|paid)/)
  })
})

describe('composed sample: money', () => {
  it('keeps every pay amount in a plausible range', () => {
    for (const c of db.comp) {
      if (c.payType === 'salary') expect(c.salary ?? 0, c.id).toBeGreaterThanOrEqual(100_000)
      if (c.payType === 'salary') expect(c.salary ?? 0, c.id).toBeLessThanOrEqual(300_000)
      if (c.payType === 'hourly') expect(c.hourlyRate ?? 0, c.id).toBeGreaterThanOrEqual(db.locations.find((l) => l.id === 'loc-hq')?.minWageHourly ?? 0)
      if (c.payType === 'hourly') expect(c.hourlyRate ?? 0, c.id).toBeLessThanOrEqual(80)
      if (c.variablePct != null) expect(c.variablePct, c.id).toBeGreaterThan(0)
      if (c.variablePct != null) expect(c.variablePct, c.id).toBeLessThanOrEqual(1)
    }
    for (const o of db.offers) {
      if (o.payType === 'salary') expect(o.salary ?? 0, o.id).toBeGreaterThanOrEqual(100_000)
      if (o.payType === 'salary') expect(o.salary ?? 0, o.id).toBeLessThanOrEqual(300_000)
      expect(o.equityShares, o.id).toBeGreaterThanOrEqual(0)
      expect(o.equityShares, o.id).toBeLessThanOrEqual(200_000)
    }
    for (const j of db.jobs) {
      if (j.payMin == null || j.payMax == null) continue
      expect(j.payMin, j.id).toBeLessThan(j.payMax)
      if (j.flsa === 'exempt') expect(j.payMin, j.id).toBeGreaterThanOrEqual(100_000)
      expect(j.payMax, j.id).toBeLessThanOrEqual(400_000)
    }
    for (const c of db.candidates) {
      if (c.desiredPay == null) continue
      expect(c.desiredPay, c.id).toBeGreaterThanOrEqual(25)
      expect(c.desiredPay, c.id).toBeLessThanOrEqual(400_000)
    }
    for (const b of db.bands) {
      expect(b.min, b.id).toBeLessThanOrEqual(b.mid)
      expect(b.mid, b.id).toBeLessThanOrEqual(b.max)
      expect(b.equityMinPct, b.id).toBeLessThanOrEqual(b.equityMaxPct)
      expect(b.equityMaxPct, b.id).toBeLessThan(0.05)
    }
    for (const g of db.grants) {
      expect(g.shares, g.id).toBeGreaterThan(0)
      expect(g.shares, g.id).toBeLessThanOrEqual(200_000)
      expect([0.25, 1.15], g.id).toContain(g.strikePrice)
    }
    for (const r of db.referrals) expect(r.bonusAmount, r.id).toBeGreaterThan(0)
    for (const r of db.referrals) expect(r.bonusAmount, r.id).toBeLessThanOrEqual(10_000)
    for (const k of db.contractors) {
      if (k.rateUnit === 'hour') expect(k.rate, k.id).toBeLessThanOrEqual(400)
      if (k.rateUnit === 'month') expect(k.rate, k.id).toBeLessThanOrEqual(30_000)
    }
    expect(db.company.cashOnHand).toBe(13_400_000)
  })

  it('pays every exempt salary at or above the California exempt floor for its exemption', () => {
    const law = db.settings.law
    for (const c of db.comp) {
      const p = person(c.personId)
      const flsa = c.flsa ?? p.flsa
      if (flsa !== 'exempt') continue
      expect(c.payType, c.id).toBe('salary')
      expect(c.salary ?? 0, c.id).toBeGreaterThanOrEqual(law.exemptSalaryMin)
      const issue = exemptCheck(law, { payType: c.payType, salary: c.salary, hourlyRate: c.hourlyRate, hoursPerWeek: p.hoursPerWeek, exemptionBasis: p.exemptionBasis, state: 'CA' })
      expect(issue, c.id).toBeNull()
      expect(p.exemptionBasis, p.id).toBeDefined()
    }
    for (const o of db.offers.filter((x) => x.flsa === 'exempt')) {
      expect(o.salary ?? 0, o.id).toBeGreaterThanOrEqual(law.exemptSalaryMin)
    }
    expect(exemptFlags(db, TODAY)).toEqual([])
    expect(exemptFlags(db, '2026-11-02')).toEqual([])
  })

  it('has a positive pool balance whose parts add up', () => {
    const s = poolSummary(db, TODAY)
    expect(s.poolShares).toBe(1_700_000)
    expect(s.available).toBeGreaterThan(0)
    expect(s.grantedOutstanding + s.awaitingBoard + s.reservedByOffers + s.available).toBe(s.poolShares)
    expect(s.unrecordedForfeitures).toBe(0)
    // Independent sums from the grant rows.
    const approved = db.grants.filter((g) => g.status === 'approved').reduce((t, g) => t + sharesHeld(g), 0)
    const promised = db.grants.filter((g) => g.status === 'promised').reduce((t, g) => t + sharesHeld(g), 0)
    expect(s.grantedOutstanding).toBe(approved)
    expect(s.awaitingBoard).toBe(promised)
    expect(promised).toBe(12_000 + 30_000 + 38_000)
    // Omar's 30,000 went back to the pool.
    const omar = db.grants.find((g) => g.personId === 'p-omar')
    expect(omar).toMatchObject({ status: 'cancelled', cancelledShares: 30_000 })
    expect(s.returned).toBeGreaterThanOrEqual(30_000)
    expect(db.equity.founderShares + 900_000 + 2_400_000 + s.poolShares).toBe(db.equity.fullyDilutedShares)
  })
})

describe('composed sample: hiring', () => {
  it('gives every active application a next step with a due date and an owner who works here', () => {
    for (const a of db.applications.filter((x) => x.status === 'active')) {
      expect(a.nextStep, a.id).toBeDefined()
      expect(a.nextStep?.dueOn, a.id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      const owner = person(a.nextStep?.ownerId ?? '')
      expect(employmentState(owner, TODAY), `${a.id} owner`).not.toBe('former')
      expect(owner.startDate <= TODAY, `${a.id} owner not started`).toBe(true)
    }
  })

  it('owes exactly 3 scorecards on Oct 9 (Ravi 1, Hannah 2) for interviews held Oct 7-8', () => {
    for (const now of ['2026-10-09T19:00:00.000Z', '2026-10-10T06:00:00.000Z']) {
      const owed = allScorecardsOwed(db, now)
      expect(owed).toHaveLength(3)
      expect(owed.filter((o) => o.scorecard.interviewerId === 'p-ravi')).toHaveLength(1)
      expect(owed.filter((o) => o.scorecard.interviewerId === 'p-hannah')).toHaveLength(2)
      for (const o of owed) expect(['2026-10-07', '2026-10-08']).toContain(pacificDateOf(o.interview.startsAt))
    }
  })

  it('schedules 2 onsites and 3 intro calls next week and nothing else', () => {
    const next = db.interviews.filter((i) => i.status === 'scheduled')
    expect(next.filter((i) => i.stageId === 'onsite')).toHaveLength(2)
    expect(next.filter((i) => i.stageId === 'intro')).toHaveLength(3)
    expect(next).toHaveLength(5)
    for (const i of next) {
      const day = pacificDateOf(i.startsAt)
      expect(day >= '2026-10-12' && day <= '2026-10-16', i.id).toBe(true)
      expect(i.interviewerIds, i.id).not.toContain('p-elena')
    }
  })

  it("holds Daniel Reyes's offer for Maya's approval and has Lucas and Mei accepted", () => {
    expect(db.offers.find((o) => o.id === 'o-daniel-reyes')).toMatchObject({ status: 'awaiting_approval', salary: 262_000, equityShares: 50_000 })
    expect(db.offers.find((o) => o.id === 'o-hire-lucas')).toMatchObject({ status: 'accepted', decidedOn: '2026-09-30', personId: 'p-lucas' })
    expect(db.offers.find((o) => o.id === 'o-hire-mei')).toMatchObject({ status: 'accepted', decidedOn: '2026-10-07', personId: 'p-mei' })
    expect(person('p-lucas')).toMatchObject({ startDate: '2026-10-19', fromApplicationId: 'a-hire-lucas', backgroundCheck: { status: 'clear', completedOn: '2026-10-06' } })
    expect(person('p-mei')).toMatchObject({ startDate: '2026-11-02', fromApplicationId: 'a-hire-mei' })
    // Every person hired through the pipeline links back to an application and candidate that match.
    for (const p of db.people.filter((x) => x.hireNumber > 1)) {
      expect(p.fromCandidateId, p.id).toBe(`c-hire-${p.id.slice(2)}`)
      const app = db.applications.find((a) => a.id === p.fromApplicationId)
      expect(app, p.id).toMatchObject({ candidateId: p.fromCandidateId, status: 'hired' })
    }
  })

  it('blocks posting the draft PM job without a pay range at 15, and lets ranged jobs post', () => {
    const pm = db.jobs.find((j) => j.id === 'j-pm')
    expect(pm).toMatchObject({ status: 'draft', payMin: null, payMax: null })
    expect(postingHeadcount(db, TODAY).total).toBeGreaterThanOrEqual(15)
    expect(postingBlockReason(db, 'j-pm', TODAY)).toMatch(/pay range/)
    expect(postingBlockReason(db, 'j-pm', '2026-10-19')).toMatch(/pay range/)
    for (const id of ['j-staff-ml', 'j-fullstack', 'j-ae', 'j-solutions-acct']) expect(postingBlockReason(db, id, TODAY), id).toBeNull()
    expect(payRangeRequiredToPost(db, TODAY).required).toBe(true)
  })

  it('links the plan to 20 to its jobs and people', () => {
    const filled = db.plan.filter((s) => s.status === 'filled')
    expect(filled.map((s) => s.personId).sort()).toEqual(['p-aisha', 'p-chris', 'p-lucas', 'p-mei', 'p-ravi'])
    for (const s of filled) {
      const job = db.jobs.find((j) => j.id === s.jobId)
      expect(job?.status, s.id).toBe('filled')
      expect(db.applications.some((a) => a.jobId === s.jobId && a.status === 'hired' && a.candidateId === person(s.personId ?? '').fromCandidateId), s.id).toBe(true)
    }
    // 14 today + Lucas + Mei + three Q4 roles + the Q1 AE = 20.
    const open = db.plan.filter((s) => s.status === 'open').length
    expect(headcountOn(db, '2026-11-02') + open).toBe(20)
  })
})

describe('composed sample: hires agree across the people, equity and hiring seeds', () => {
  const hires = () => db.people.filter((p) => p.hireNumber > 1)
  const offerFor = (personId: ID) => {
    const o = db.offers.find((x) => x.personId === personId && x.status === 'accepted')
    if (!o) throw new Error(`no accepted offer for ${personId}`)
    return o
  }

  it("matches each person's name, job, start, pay and grant to their accepted offer", () => {
    for (const p of hires()) {
      const o = offerFor(p.id)
      const c = db.candidates.find((x) => x.id === p.fromCandidateId)
      expect([c?.firstName, c?.lastName], p.id).toEqual([p.firstName, p.lastName])
      expect(o.startDate, p.id).toBe(p.startDate)
      expect([o.levelId, o.familyId, o.departmentId, o.managerId, o.locationId, o.flsa], p.id).toEqual([p.levelId, p.familyId, p.departmentId, p.managerId, p.locationId, p.flsa])
      const hireComp = db.comp.filter((r) => r.personId === p.id && r.reason === 'hire')
      expect(hireComp, p.id).toHaveLength(1)
      expect([hireComp[0].salary, hireComp[0].hourlyRate, hireComp[0].variablePct], p.id).toEqual([o.salary, o.hourlyRate, o.variablePct])
      expect(hireComp[0].title, p.id).toBe(o.title)
      const grant = db.grants.find((g) => g.personId === p.id)
      if (o.equityShares > 0) {
        expect(grant?.shares, p.id).toBe(o.equityShares)
        expect(grant?.vestingStart, p.id).toBe(p.startDate)
      } else expect(grant, p.id).toBeUndefined()
      const doc = db.documents.find((x) => x.personId === p.id && x.type === 'offer_letter')
      expect(doc?.date, p.id).toBe(o.decidedOn)
    }
  })

  it('records background checks the same way on the offer and the person, never before the conditional offer', () => {
    for (const p of hires()) {
      const o = offerFor(p.id)
      const app = db.applications.find((a) => a.id === p.fromApplicationId)
      const required = o.contingencies.includes('background_check')
      expect(required, p.id).toBe(db.jobs.find((j) => j.id === o.jobId)?.backgroundCheck)
      if (!required) {
        expect(p.backgroundCheck?.status, p.id).toBe('not_required')
        expect(o.backgroundCheck, p.id).toBeUndefined()
        continue
      }
      expect(o.backgroundCheck?.consentSentOn, p.id).toBe(o.decidedOn)
      expect(app?.conditionalOfferOn, p.id).toBe(o.decidedOn)
      if (o.backgroundCheck?.status === 'complete') {
        expect(p.backgroundCheck, p.id).toEqual({ status: 'clear', completedOn: o.backgroundCheck.completedOn })
        expect((o.backgroundCheck.completedOn ?? '') > (o.decidedOn ?? ''), p.id).toBe(true)
        expect((o.backgroundCheck.completedOn ?? '') < p.startDate, p.id).toBe(true)
        const task = db.checklists.find((c) => c.personId === p.id && c.kind === 'onboarding')?.tasks.find((t) => t.templateTaskId === 'on-background-check')
        expect(task?.doneOn, p.id).toBe(o.backgroundCheck.completedOn)
      } else {
        expect(p.backgroundCheck?.status, p.id).toBe('pending')
      }
    }
  })

  it('records each hire on the day the application moved to Hired, which is when onboarding starts', () => {
    for (const p of hires()) {
      const app = db.applications.find((a) => a.id === p.fromApplicationId)
      const hiredOn = app?.history.find((h) => h.stageId === 'hired')?.at
      const row = db.activity.find((a) => a.entityType === 'person' && a.entityId === p.id && a.kind === 'hired')
      expect(row?.at.slice(0, 10), p.id).toBe(hiredOn)
      const ck = db.checklists.find((c) => c.personId === p.id && c.kind === 'onboarding')
      expect(ck?.createdOn, p.id).toBe(hiredOn)
      expect((hiredOn ?? '') >= (offerFor(p.id).decidedOn ?? ''), p.id).toBe(true)
    }
  })

  it('pays referral bonuses 90 days after the referred hire starts', () => {
    for (const r of db.referrals) {
      const p = db.people.find((x) => x.fromCandidateId === r.candidateId)
      if (!p) {
        expect(r.payableOn, r.id).toBeUndefined()
        continue
      }
      expect(r.payableOn, r.id).toBe(addDays(p.startDate, 90))
      if (r.paidOn) expect(r.paidOn <= TODAY, r.id).toBe(true)
    }
  })
})

describe('composed sample: compliance', () => {
  const results = () => evaluateAll(db, TODAY)
  const rule = (id: string, date = TODAY) => {
    const r = evaluateAll(db, date).find((x) => x.rule.id === id)
    if (!r) throw new Error(`missing rule ${id}`)
    return r
  }

  it('evaluates every rule without throwing', () => {
    const all = results()
    expect(all.length).toBeGreaterThan(30)
    for (const r of all) expect(['not_yet', 'approaching', 'applies', 'done', 'not_applicable']).toContain(r.state)
  })

  it('shows SB 553 (workplace violence plan) as applying with the plan not written', () => {
    const r = rule('wvpp')
    expect(r.state).toBe('applies')
    expect(r.openActions.map((a) => a.id)).toContain('write-plan')
    expect(db.complianceStatus.wvpp?.status).not.toBe('done')
    expect(db.locations.find((l) => l.id === 'loc-hq')).toMatchObject({ typicalMaxOnSite: 11, publicAccess: false })
  })

  it('shows the pay scale in postings rule approaching for Oct 19, then applying', () => {
    const r = rule('pay-scale-in-postings')
    expect(r.state).toBe('approaching')
    expect(r.projectedOn).toBe('2026-10-19')
    expect(rule('pay-scale-in-postings', '2026-10-19').state).toBe('applies')
  })
})

describe('composed sample: seeded situations (docs/SAMPLE.md)', () => {
  it("has Lucas's pre-start laptop and account tasks open and due before his start", () => {
    const ck = db.checklists.find((c) => c.personId === 'p-lucas' && c.kind === 'onboarding')
    expect(ck).toBeDefined()
    const open = openTasks(db, TODAY, { personId: 'p-lucas' })
    const laptop = ck?.tasks.find((t) => t.templateTaskId === 'on-laptop')
    const accounts = ck?.tasks.find((t) => t.templateTaskId === 'on-accounts')
    expect(laptop?.status).toBe('open')
    expect(accounts?.status).toBe('open')
    expect((laptop?.dueOn ?? '') < '2026-10-19' && (accounts?.dueOn ?? '') < '2026-10-19').toBe(true)
    expect(open.map((t) => t.task.templateTaskId)).toEqual(expect.arrayContaining(['on-laptop', 'on-accounts']))
    expect(laptop?.dueOn).toBe(TODAY)
    expect(ck?.tasks.some((t) => t.status === 'done')).toBe(true)
  })

  it('has the two pending time off requests and Elena out next week', () => {
    const pending = pendingApprovals(db).map((r) => [r.personId, r.startDate, r.endDate, db.timeOffPolicies.find((p) => p.id === r.policyId)?.kind])
    expect(pending).toHaveLength(2)
    expect(pending).toContainEqual(['p-caleb', '2026-11-23', '2026-11-25', 'vacation'])
    expect(pending).toContainEqual(['p-kofi', '2026-10-30', '2026-10-30', 'vacation'])
    const out = whoIsOut(db, '2026-10-12', '2026-10-16')
    expect(out.some((o) => o.personId === 'p-elena')).toBe(true)
    const elena = db.timeOffRequests.find((r) => r.personId === 'p-elena' && r.startDate === '2026-10-12')
    expect(elena).toMatchObject({ endDate: '2026-10-16', status: 'approved' })
  })

  it("has Tomas's CFRA bonding leave with the designation notice due Oct 13 and not sent", () => {
    const leave = db.leaveCases.find((l) => l.personId === 'p-tomas')
    expect(leave).toMatchObject({ requestedOn: '2026-10-06', startDate: '2026-11-16', designationNoticeDueOn: '2026-10-13' })
    expect(leave?.kind === 'cfra' || leave?.kind === 'bonding').toBe(true)
    expect(leave?.designationNoticeSentOn).toBeUndefined()
    expect(leave?.expectedReturn === '2027-01-08' || leave?.expectedReturn === '2027-01-11').toBe(true)
    expect(onLeave(db, 'p-tomas', TODAY)).toBeUndefined()
    expect(onLeave(db, 'p-tomas', '2026-12-01')).toBeDefined()
  })

  it("has Aisha's security training overdue and Caleb's harassment row due Sep 2", () => {
    const aisha = trainingRequirements(db, person('p-aisha'), TODAY).find((r) => r.course === 'security_awareness')
    expect(aisha).toMatchObject({ status: 'overdue', dueOn: '2026-10-08', required: true })
    const caleb = db.trainings.find((t) => t.personId === 'p-caleb' && t.kind.startsWith('harassment'))
    expect(caleb).toMatchObject({ dueOn: '2026-09-02' })
    expect(caleb?.completedOn).toBeUndefined()
  })

  it("queues Aisha's, Lucas's and Mei's grants for the next board consent", () => {
    const queue = boardConsentQueue(db).map((g) => g.personId).sort()
    expect(queue).toEqual(['p-aisha', 'p-lucas', 'p-mei'])
  })

  it("vests Kofi's cliff on Oct 6 (13,000) and puts Sofia's cliff on Jan 12, 2027", () => {
    const kofi = db.grants.find((g) => g.personId === 'p-kofi' && g.status === 'approved')
    expect(kofi && cliffDate(kofi)).toBe('2026-10-06')
    expect(kofi && vestedShares(kofi, TODAY)).toBe(13_000)
    const sofia = db.grants.find((g) => g.personId === 'p-sofia' && g.status === 'approved')
    expect(sofia && cliffDate(sofia)).toBe('2027-01-12')
  })

  it('flags Marisol as likely an employee', () => {
    const k = db.contractors.find((c) => c.id === 'k-marisol')
    expect(k?.ab5).toMatchObject({ exemption: 'none', a: false, b: false, c: true })
  })

  it('has the SOC 2 quarterly access review due Oct 31', () => {
    const item = db.recurring.find((r) => /access review/i.test(r.title))
    expect(item).toMatchObject({ nextDueOn: '2026-10-31', cadence: 'quarterly' })
  })

  it('has Handbook 2.0 acknowledgments outstanding for Ravi, Aisha and Caleb only', () => {
    const handbook = db.policies.find((p) => /handbook/i.test(p.title))
    expect(handbook).toMatchObject({ version: '2.0', effectiveOn: '2026-09-15', requiresAck: true })
    const acked = new Set(db.acks.filter((a) => a.policyId === handbook?.id && a.version === '2.0').map((a) => a.personId))
    const missing = db.people.filter((p) => p.startDate <= TODAY && !p.endDate && !acked.has(p.id)).map((p) => p.id).sort()
    expect(missing).toEqual(['p-aisha', 'p-caleb', 'p-ravi'])
  })

  it("has Aisha's DE 34 new hire report overdue (due Sep 28, statutory)", () => {
    const ck = db.checklists.find((c) => c.personId === 'p-aisha' && c.kind === 'onboarding')
    const de34 = ck?.tasks.find((t) => /DE 34/.test(t.title))
    expect(de34).toMatchObject({ status: 'open', dueOn: '2026-09-28', statutory: true })
  })

  it("has Omar's offboarding complete except the laptop return", () => {
    const ck = db.checklists.find((c) => c.personId === 'p-omar' && c.kind === 'offboarding')
    expect(ck).toBeDefined()
    const open = ck?.tasks.filter((t) => t.status === 'open') ?? []
    expect(open).toHaveLength(1)
    expect(open[0]?.title).toMatch(/laptop|equipment/i)
  })

  it('makes the hiring manager and employee views useful', () => {
    for (const id of ['p-tomas', 'p-priya', 'p-elena', 'p-caleb', 'p-jasmine']) {
      expect(db.jobs.some((j) => j.hiringManagerId === id) || db.people.some((p) => p.managerId === id), id).toBe(true)
    }
    const newest = db.people.filter((p) => p.startDate <= TODAY && !p.endDate).sort((a, b) => b.startDate.localeCompare(a.startDate))[0]
    expect(newest.id).toBe('p-aisha')
  })
})

describe('composed sample: pay run prep (docs/SPEC.md PAY RUN PREP)', () => {
  const prep = (start: string) => {
    const period = periodStarting(db, start)
    if (!period) throw new Error(`no period starts ${start}`)
    return payRunPrep(db, period, TODAY)
  }
  const rowOf = (start: string, id: ID) => {
    const r = prep(start).rows.find((x) => x.personId === id)
    if (!r) throw new Error(`${id} is not on the ${start} payroll`)
    return r
  }

  it('marks the six payrolls through Sep 30 submitted on their cutoff days, with the PEO totals for September', () => {
    const runs = db.company.payRuns ?? []
    expect(runs.map((r) => [r.periodStart, r.payday, r.submittedOn])).toEqual([
      ['2026-07-01', '2026-07-15', '2026-07-13'],
      ['2026-07-16', '2026-07-31', '2026-07-29'],
      ['2026-08-01', '2026-08-14', '2026-08-12'],
      ['2026-08-16', '2026-08-31', '2026-08-27'],
      ['2026-09-01', '2026-09-15', '2026-09-11'],
      ['2026-09-16', '2026-09-30', '2026-09-28'],
    ])
    expect(runs.every((r) => r.submittedById === 'p-jasmine')).toBe(true)
    expect(runs.filter((r) => r.totals).map((r) => [r.periodStart, r.totals?.enteredOn])).toEqual([
      ['2026-09-01', '2026-09-16'],
      ['2026-09-16', '2026-10-01'],
    ])
    // Each record matches the pay calendar exactly, and the next payroll (Oct 1-15, payday Thu Oct 15) is still open.
    const cal = payCalendar(db, '2026-07-01', '2026-09-30')
    expect(runs.map((r) => [r.periodEnd, r.payday])).toEqual(cal.map((p) => [p.end, p.payday]))
    expect(prep('2026-10-01').status).toBe('open')
    // The first payroll date (the EDD clock) stays the real one.
    expect(db.company.firstPayrollOn).toBe('2025-05-15')
  })

  it('rebuilds the submitted payrolls from the calendar for the day the sample is shifted to', () => {
    // Fri Oct 30: the Oct 16-31 cutoff (Wed Oct 28) has passed, its payday is today, so the totals are the two before.
    const runs = samplePayRuns(db, '2026-10-30')
    expect(runs.map((r) => r.periodStart)).toEqual(['2026-08-01', '2026-08-16', '2026-09-01', '2026-09-16', '2026-10-01', '2026-10-16'])
    expect(runs.filter((r) => r.totals).map((r) => [r.periodStart, r.totals?.enteredOn])).toEqual([
      ['2026-09-16', '2026-10-01'],
      ['2026-10-01', '2026-10-16'],
    ])
  })

  it("pays Lucas's prorated first check with his sign-on bonus: 195,000 / 260 x 10 weekdays + 10,000", () => {
    const offer = db.offers.find((o) => o.personId === 'p-lucas' && o.status === 'accepted')
    expect(offer?.signOnBonus).toBe(10_000)
    const task = db.checklists.find((c) => c.personId === 'p-lucas' && c.kind === 'onboarding')?.tasks.find((t) => /sign-on bonus/i.test(t.title))
    expect(task).toMatchObject({ status: 'open', dueOn: '2026-10-19' })
    const lucas = rowOf('2026-10-16', 'p-lucas')
    expect(lucas).toMatchObject({ startInPeriod: '2026-10-19', weekdays: 11, weekdaysOnPayroll: 10, salaryEstimate: 7500, bonus: 10_000, estimatedGross: 17_500 })
  })

  it("splits Nikhil's Oct 16-31 check at his raise on Wed Oct 21: 8,333.33 x 3/11 + 8,916.67 x 8/11", () => {
    expect(currentComp(db, 'p-nikhil', TODAY)?.salary).toBe(200_000)
    const raise = db.comp.find((c) => c.id === 'cr-nikhil-merit-2026-10')
    expect(raise).toMatchObject({ effectiveOn: '2026-10-21', salary: 214_000, reason: 'merit', scheduled: true })
    const change = db.checklists.find((c) => c.id === 'ck-change-nikhil')
    expect(change?.tasks.length).toBeGreaterThan(0)
    expect(change?.tasks.filter((t) => t.status === 'open')).toEqual([])
    const nikhil = rowOf('2026-10-16', 'p-nikhil')
    expect(nikhil.estimatedGross).toBe(8757.58)
    expect(nikhil.payChanges).toEqual([{ effectiveOn: '2026-10-21', from: { payType: 'salary', salary: 200_000, hourlyRate: undefined }, to: { payType: 'salary', salary: 214_000, hourlyRate: undefined } }])
  })

  it("shows Luis's last day: final pay due Tue Nov 10, before the Fri Nov 13 payday, with his vacation paid out", () => {
    const luis = person('p-luis')
    expect(luis.separation).toMatchObject({ type: 'resigned_notice', noticeGivenOn: '2026-10-08', lastDay: '2026-11-10', rehireEligible: true })
    expect(db.people.filter((p) => p.endDate).map((p) => p.id)).toEqual(['p-omar', 'p-luis'])
    expect(employmentState(luis, TODAY, db)).not.toBe('former')
    expect(db.checklists.some((c) => c.id === 'ck-off-luis' && c.kind === 'offboarding')).toBe(true)
    // 16 when Mei starts, 15 after Luis's last day.
    expect(headcountOn(db, '2026-11-10')).toBe(16)
    expect(headcountOn(db, '2026-11-11')).toBe(15)
    const r = rowOf('2026-11-01', 'p-luis')
    expect(r.finalPay).toMatchObject({ dueOn: '2026-11-10', rule: 'last_day', beforePayday: true })
    expect(r.flags.map((f) => f.kind)).toContain('final_pay_off_cycle')
    expect(r.vacationPayout?.rate).toBe(30)
    expect(r.vacationPayout?.hours).toBeGreaterThan(0)
  })
})
