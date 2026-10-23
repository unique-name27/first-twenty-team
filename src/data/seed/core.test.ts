// Tests for the Ledgerlark sample's company, people, equity, time off, contractors and compliance seed
// (everything except hiring, which another seed file owns). Built the way ./index builds it, without hiring.
import { produce } from 'immer'
import { describe, expect, it, vi } from 'vitest'
import { blankDB } from '@/data/blank'
import { openTasks } from '@/domain/checklists/generate'
import { evaluateAll } from '@/domain/compliance/engine'
import { RULE_BY_ID } from '@/domain/compliance/rules'
import { soc2Evidence } from '@/domain/compliance/soc2'
import { capTableIsPlaceholder, cliffDate, current409A, poolSummary, valuationWarnings, vestedShares } from '@/domain/equity'
import { annualBase, bandFor, currentComp, exemptFlags, outOfBand } from '@/domain/pay'
import { employedOn, headcountOn, incomingOn } from '@/domain/people'
import { balances, pendingApprovals, whoIsOut } from '@/domain/timeoff'
import { trainingRequirements } from '@/domain/trainings'
import type { DB } from '@/domain/types'
import { applyCompany } from './company'
import { applyCompliance } from './compliance'
import { applyContractors } from './contractors'
import { applyEquity } from './equity'
import { applyPeople } from './people'
import { applyTimeoff } from './timeoff'

// The store builds the sample on import; keep it out of these tests (the cycle store -> seed -> store).
vi.mock('@/data/seed', async () => {
  const blank = await import('@/data/blank')
  return {
    SAMPLE_ANCHOR: '2026-10-09',
    buildSampleDB: () => blank.blankDB({ companyName: 'Test', founderFirstName: 'Test', founderLastName: 'Founder', foundedOn: '2025-01-01' }),
  }
})

const TODAY = '2026-10-09'

function build(): DB {
  const base = blankDB({ companyName: 'Ledgerlark', founderFirstName: 'Maya', founderLastName: 'Raman', founderTitle: 'Founder and CEO', foundedOn: '2025-02-03' })
  return produce(base, (d) => {
    applyCompany(d)
    applyPeople(d)
    applyEquity(d)
    applyTimeoff(d)
    applyContractors(d)
    applyCompliance(d)
  })
}

const db = build()
const person = (id: string) => {
  const p = db.people.find((x) => x.id === id)
  if (!p) throw new Error(`missing ${id}`)
  return p
}

describe('sample build', () => {
  it('is deterministic and reasonably small', () => {
    expect(build()).toEqual(db)
    expect(JSON.stringify(db).length).toBeLessThan(500_000)
  })

  it('has unique ids in every collection', () => {
    for (const key of ['people', 'comp', 'grants', 'contractors', 'documents', 'checklists', 'timeOffRequests', 'leaveCases', 'trainings', 'acks', 'activity', 'recurring'] as const) {
      const ids = (db[key] as Array<{ id: string }>).map((r) => r.id)
      expect(new Set(ids).size, key).toBe(ids.length)
    }
    const taskIds = db.checklists.flatMap((c) => c.tasks.map((t) => t.id))
    expect(new Set(taskIds).size).toBe(taskIds.length)
  })

  it('uses no em dashes and stores no protected characteristics', () => {
    const json = JSON.stringify({ ...db, checklistTemplates: [], settings: null, emailTemplates: [] })
    expect(json).not.toContain(String.fromCharCode(0x2014))
    for (const banned of ['gender', 'dateOfBirth', 'birthday', 'ssn', 'race', 'ethnicity', 'salaryHistory', 'pronoun']) {
      expect(json.toLowerCase()).not.toContain(`"${banned.toLowerCase()}"`)
    }
  })

  it('dates every activity row on or before the anchor, with fixed ids', () => {
    for (const a of db.activity) {
      expect(a.at.slice(0, 10) <= TODAY, a.text).toBe(true)
      expect(a.id).toMatch(/^act-core-\d+$/)
    }
  })
})

describe('company', () => {
  it('has the Ledgerlark profile', () => {
    expect(db.company.legalName).toBe('Ledgerlark, Inc.')
    expect(db.company.hq).toEqual({ street: '99 S Almaden Blvd', suite: 'Suite 410', city: 'San Jose', state: 'CA', zip: '95113' })
    expect(db.company.fundingRounds.map((r) => [r.name, r.closedOn, r.amount])).toEqual([
      ['Pre-seed', '2025-04-15', 3_000_000],
      ['Seed', '2026-02-24', 14_000_000],
    ])
    expect(db.company.costModel).toEqual({ benefitsPerHeadMonthly: 1150, peoToolsPerHeadMonthly: 375, workersCompPct: 0.003 })
    expect(db.company.soc2Enabled).toBe(true)
  })

  it('has the departments with heads and the three locations', () => {
    expect(db.departments.map((d) => [d.id, d.headId])).toEqual([
      ['d-exec', 'p-founder'],
      ['d-eng', 'p-tomas'],
      ['d-ai', 'p-priya'],
      ['d-product', 'p-founder'],
      ['d-gtm', 'p-caleb'],
      ['d-acct', 'p-elena'],
      ['d-ops', 'p-jasmine'],
    ])
    const hq = db.locations.find((l) => l.id === 'loc-hq')
    expect(hq).toMatchObject({ minWageHourly: 18.45, publicAccess: false, typicalMaxOnSite: 11 })
    expect(db.locations.find((l) => l.id === 'loc-remote-tx')).toMatchObject({ city: 'Austin', state: 'TX', minWageHourly: 7.25 })
  })

  it('has a band for every person and open job, matching the posted ranges', () => {
    for (const p of db.people) expect(bandFor(db, p.familyId, p.levelId), p.id).toBeDefined()
    expect(bandFor(db, 'f-ml', 'lv-l4')).toMatchObject({ min: 225_000, max: 285_000, equityMinPct: 0.0025, equityMaxPct: 0.006 })
    expect(bandFor(db, 'f-eng', 'lv-l3')).toMatchObject({ min: 180_000, max: 235_000 })
    expect(bandFor(db, 'f-gtm', 'lv-l3')).toMatchObject({ min: 130_000, max: 160_000, variablePct: 1.0 })
    expect(bandFor(db, 'f-acct', 'lv-l3')).toMatchObject({ min: 165_000, max: 205_000 })
    expect(bandFor(db, 'f-product', 'lv-l3')).toBeDefined()
    expect(bandFor(db, 'f-eng', 'lv-m1')).toBeDefined()
    expect(bandFor(db, 'f-ops', 'lv-l1')).toMatchObject({ flsaDefault: 'non_exempt' })
  })

  it('keeps incoming and pending offers inside the equity guidelines', () => {
    const pct = (shares: number) => shares / 12_000_000
    const inside = (familyId: string, levelId: string, shares: number) => {
      const b = bandFor(db, familyId, levelId)
      return !!b && pct(shares) >= b.equityMinPct && pct(shares) <= b.equityMaxPct
    }
    expect(inside('f-eng', 'lv-l3', 30_000)).toBe(true) // Lucas
    expect(inside('f-ml', 'lv-l3', 38_000)).toBe(true) // Mei
    expect(inside('f-ml', 'lv-l4', 50_000)).toBe(true) // Daniel Reyes
    expect(inside('f-gtm', 'lv-l2', 12_000)).toBe(true) // Aisha
  })
})

describe('people', () => {
  it('has employees 1-15 with 14 employed on the anchor', () => {
    expect(db.people.map((p) => p.hireNumber).sort((a, b) => a - b)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1))
    expect(headcountOn(db, TODAY)).toBe(14)
    expect(employedOn(db, TODAY).some((p) => p.id === 'p-omar')).toBe(false)
    expect(incomingOn(db, TODAY)).toEqual([])
    expect(headcountOn(db, '2025-10-06')).toBe(5)
    expect(person('p-kofi').workEmail).toBe('kofi@ledgerlark.com')
    expect(person('p-tomas').fromCandidateId).toBe('c-hire-tomas')
    expect(person('p-aisha').fromCandidateId).toBe('c-hire-aisha')
    expect(person('p-founder').fromCandidateId).toBeUndefined()
  })

  it('follows the reporting lines', () => {
    const reports = (id: string) => db.people.filter((p) => p.managerId === id && !p.endDate).map((p) => p.id).sort()
    expect(reports('p-founder')).toEqual(['p-aisha', 'p-caleb', 'p-elena', 'p-jasmine', 'p-priya', 'p-sofia', 'p-tomas'])
    expect(reports('p-tomas')).toEqual(['p-kofi', 'p-nikhil', 'p-ravi'])
    expect(reports('p-priya')).toEqual(['p-hannah'])
    expect(reports('p-elena')).toEqual(['p-chris'])
    expect(reports('p-jasmine')).toEqual(['p-luis'])
  })

  it('classifies pay correctly: exempt pay clears California minimums, Luis is hourly non-exempt', () => {
    expect(exemptFlags(db, TODAY)).toEqual([])
    const luis = person('p-luis')
    expect(luis).toMatchObject({ flsa: 'non_exempt', employmentType: 'part_time', hoursPerWeek: 24, workMode: 'onsite' })
    expect(luis.exemptionBasis).toBeUndefined()
    expect(currentComp(db, 'p-luis', TODAY)).toMatchObject({ payType: 'hourly', hourlyRate: 30 })
    expect(person('p-caleb')).toMatchObject({ homeState: 'TX', locationId: 'loc-remote-tx' })
  })

  it('has the pay history in docs/SAMPLE.md, with founding hires below band only before the seed', () => {
    const salary = (id: string, date = TODAY) => currentComp(db, id, date)?.salary
    expect(salary('p-founder')).toBe(175_000)
    expect(salary('p-founder', '2026-02-28')).toBe(120_000)
    expect(salary('p-tomas')).toBe(212_000)
    expect(salary('p-tomas', '2025-06-01')).toBe(185_000)
    expect(salary('p-priya')).toBe(228_000)
    expect(salary('p-elena')).toBe(200_000)
    expect(salary('p-kofi')).toBe(192_000)
    expect(salary('p-ravi')).toBe(235_000)
    expect(currentComp(db, 'p-caleb', TODAY)?.variablePct).toBe(1.0)
    expect(currentComp(db, 'p-chris', TODAY)?.variablePct).toBe(0.15)
    expect(currentComp(db, 'p-aisha', TODAY)?.variablePct).toBe(0.1)
    expect(outOfBand(db, TODAY)).toEqual([])
    const tomasHire = db.comp.find((c) => c.id === 'cr-tomas-hire')
    expect(tomasHire?.exceptionReason).toBeTruthy()
    expect(db.comp.filter((c) => c.reason === 'market').every((c) => c.approvedById === 'p-founder' && c.effectiveOn === '2026-03-01')).toBe(true)
    expect(annualBase(currentComp(db, 'p-luis', TODAY) ?? { payType: 'salary' }, 24)).toBe(37_440)
  })

  it('records Omar as resigned with notice, final pay on his last day, nothing vested', () => {
    const omar = person('p-omar')
    expect(omar.endDate).toBe('2026-08-28')
    expect(omar.separation).toMatchObject({
      type: 'resigned_notice',
      noticeGivenOn: '2026-08-14',
      lastDay: '2026-08-28',
      finalPayDueOn: '2026-08-28',
      finalPayIssuedOn: '2026-08-28',
      rehireEligible: true,
      vestedAtSeparation: 0,
    })
    expect(omar.separation?.exerciseDeadline).toBeUndefined()
    const off = db.checklists.find((c) => c.id === 'ck-off-omar')
    expect(off?.tasks.filter((t) => t.status === 'open').map((t) => t.templateTaskId)).toEqual(['off-equipment'])
    expect(db.documents.filter((d) => d.personId === 'p-omar').every((d) => !!d.retainUntil)).toBe(true)
  })

  it('gives background checks cleared before start to every hire from March 2026', () => {
    for (const p of db.people.filter((x) => x.startDate >= '2026-03-01')) {
      expect(p.backgroundCheck?.status, p.id).toBe('clear')
      expect((p.backgroundCheck?.completedOn ?? '') < p.startDate, p.id).toBe(true)
    }
  })

  it('has emergency contacts for everyone, some chosen for SB 294 notice', () => {
    expect(db.people.every((p) => p.emergencyContacts.length > 0 && p.emergencyContacts.every((c) => c.phone.includes('555-01')))).toBe(true)
    expect(db.people.filter((p) => p.emergencyContacts.some((c) => c.sb294Notify)).length).toBeGreaterThanOrEqual(3)
  })
})

describe('checklists', () => {
  it('gives every employee an onboarding checklist, and Caleb the Texas new-state one', () => {
    for (const p of db.people) expect(db.checklists.some((c) => c.personId === p.id && c.kind === 'onboarding'), p.id).toBe(true)
    expect(db.checklists.find((c) => c.id === 'ck-ns-caleb')?.completedOn).toBeTruthy()
  })

  it('leaves only the seeded overdue items open', () => {
    const overdue = openTasks(db, TODAY)
      .filter((t) => t.overdue)
      .map((t) => t.task.id)
      .sort()
    expect(overdue).toEqual(['t-off-omar-off-equipment', 't-onb-aisha-on-de34', 't-onb-aisha-on-security-training', 't-onb-hannah-on-harassment-training'])
    const statutory = openTasks(db, TODAY).filter((t) => t.overdue && t.task.statutory)
    expect(statutory.map((t) => t.task.id).sort()).toEqual(['t-onb-aisha-on-de34', 't-onb-hannah-on-harassment-training'])
    expect(statutory.find((t) => t.task.id === 't-onb-aisha-on-de34')?.task.dueOn).toBe('2026-09-28')
  })

  it('keeps upcoming tasks open (Ravi 90-day check-in) and long-tenured checklists complete', () => {
    const ravi = db.checklists.find((c) => c.id === 'ck-onb-ravi')
    expect(ravi?.tasks.find((t) => t.templateTaskId === 'on-checkin-90')).toMatchObject({ status: 'open' })
    // Hannah's checklist stays open on purpose: her harassment training is the overdue example.
    for (const key of ['maya', 'tomas', 'priya', 'elena', 'kofi', 'sofia', 'caleb', 'omar', 'jasmine']) {
      expect(db.checklists.find((c) => c.id === `ck-onb-${key}`)?.completedOn, key).toBeTruthy()
    }
    const kofi = db.checklists.find((c) => c.id === 'ck-onb-kofi')
    expect(kofi?.tasks.some((t) => t.templateTaskId === 'on-equity-board' && t.doneOn === '2025-10-23')).toBe(true)
    expect(kofi?.tasks.find((t) => t.templateTaskId === 'on-notice-sb294')?.status).toBe('not_applicable')
  })

  it('includes the non-exempt items for Luis only', () => {
    const luis = db.checklists.find((c) => c.id === 'ck-onb-luis')
    expect(luis?.tasks.find((t) => t.templateTaskId === 'on-notice-2810-5')).toMatchObject({ status: 'done', doneOn: '2026-07-20' })
    const others = db.checklists.filter((c) => c.kind === 'onboarding' && c.personId !== 'p-luis')
    expect(others.some((c) => c.tasks.some((t) => t.templateTaskId === 'on-notice-2810-5'))).toBe(false)
  })
})

describe('trainings and policies', () => {
  it('shows Aisha security training overdue and supervisors with the 2-hour course', () => {
    const row = (id: string, course: string) => trainingRequirements(db, person(id), TODAY).find((r) => r.course === course)
    expect(row('p-aisha', 'security_awareness')).toMatchObject({ status: 'overdue', dueOn: '2026-10-08' })
    for (const id of ['p-tomas', 'p-priya', 'p-elena', 'p-jasmine', 'p-founder']) {
      expect(row(id, 'harassment'), id).toMatchObject({ kind: 'harassment_supervisor', status: 'done' })
    }
    // Caleb works in Texas: assigned by company policy (open, due Sep 2), not required by law.
    expect(db.trainings.find((t) => t.id === 'trn-caleb-har')).toMatchObject({ dueOn: '2026-09-02' })
    expect(db.trainings.find((t) => t.id === 'trn-caleb-har')?.completedOn).toBeUndefined()
    const overdue = employedOn(db, TODAY).flatMap((p) => trainingRequirements(db, p, TODAY).filter((r) => r.required && r.status === 'overdue').map((r) => `${p.id}:${r.course}`))
    expect(overdue.sort()).toEqual(['p-aisha:security_awareness', 'p-hannah:harassment'])
  })

  it('has Handbook 2.0 acknowledgements outstanding for Ravi, Aisha and Caleb only', () => {
    const handbook = db.policies.find((p) => p.id === 'pl-handbook')
    expect(handbook).toMatchObject({ version: '2.0', effectiveOn: '2026-09-15' })
    const missing = employedOn(db, TODAY)
      .filter((p) => !db.acks.some((a) => a.personId === p.id && a.policyId === 'pl-handbook' && a.version === '2.0'))
      .map((p) => p.id)
      .sort()
    expect(missing).toEqual(['p-aisha', 'p-caleb', 'p-ravi'])
  })

  it('leaves only the seeded gaps in the SOC 2 Type II window', () => {
    const ev = soc2Evidence(db, '2026-08-01', '2027-01-31', TODAY)
    const gaps = ev.controls.flatMap((c) => [...c.rows, ...(c.subChecks ?? []).flatMap((s) => s.rows)].filter((r) => !r.ok && !r.pending).map((r) => `${c.id}:${r.label}`))
    expect(gaps.sort()).toEqual(['annual-security-training:Aisha Bello', 'onboarding-training-acks:Aisha Bello'])
    const reack = ev.controls.find((c) => c.id === 'onboarding-training-acks')?.subChecks?.[0].rows.filter((r) => r.pending) ?? []
    expect(reack.map((r) => r.personId).sort()).toEqual(['p-aisha', 'p-caleb', 'p-ravi'])
  })
})

describe('equity', () => {
  it('matches the cap table and 409A history', () => {
    expect(db.equity).toMatchObject({ authorizedShares: 15_000_000, fullyDilutedShares: 12_000_000, founderShares: 7_000_000, poolShares: 1_200_000 })
    // Confirmed numbers, so the sample's offer letters state the % of fully diluted shares.
    expect(capTableIsPlaceholder(db)).toBe(false)
    expect(current409A(db, TODAY)?.fmvPerShare).toBe(1.15)
    expect(current409A(db, '2026-01-22')?.fmvPerShare).toBe(0.25)
    expect(valuationWarnings(db, TODAY)).toEqual([])
  })

  it('prices every approved grant at the 409A in effect on its board date', () => {
    for (const g of db.grants.filter((x) => x.boardApprovedOn)) {
      expect(g.strikePrice, g.id).toBe(current409A(db, g.boardApprovedOn as string)?.fmvPerShare)
    }
  })

  it('vests Kofi at his cliff and returns Omar to the pool', () => {
    const kofi = db.grants.find((g) => g.id === 'g-kofi')
    expect(kofi && vestedShares(kofi, TODAY)).toBe(13_000)
    const sofia = db.grants.find((g) => g.id === 'g-sofia')
    expect(sofia && cliffDate(sofia)).toBe('2027-01-12')
    expect(db.grants.find((g) => g.id === 'g-omar')).toMatchObject({ status: 'cancelled', cancelledShares: 30_000, cancelledOn: '2026-08-28' })
    expect(db.grants.find((g) => g.id === 'g-aisha')).toMatchObject({ status: 'promised', shares: 12_000 })
    const pool = poolSummary(db, TODAY)
    expect(pool.poolShares).toBe(1_700_000)
    expect(pool.grantedOutstanding).toBe(640_000)
    expect(pool.awaitingBoard).toBe(12_000)
    expect(pool.returned).toBe(30_000)
  })

  it('gives advisors 2-year NSOs with no cliff', () => {
    for (const id of ['g-adv-whitfield', 'g-adv-osei']) {
      expect(db.grants.find((g) => g.id === id)).toMatchObject({ holderType: 'advisor', type: 'NSO', shares: 24_000, cliffMonths: 0, vestingMonths: 24 })
    }
  })
})

describe('time off and leave', () => {
  it('has the seeded requests', () => {
    expect(pendingApprovals(db).map((r) => r.id)).toEqual(['tr-caleb-2', 'tr-kofi-4'])
    expect(db.timeOffRequests.find((r) => r.id === 'tr-elena-4')).toMatchObject({ status: 'approved', hours: 40 })
    expect(db.timeOffRequests.find((r) => r.id === 'tr-priya-3')).toMatchObject({ status: 'approved', hours: 56 })
    expect(db.timeOffRequests.find((r) => r.id === 'tr-luis-1')).toMatchObject({ status: 'approved', hours: 4.8, policyId: 'pol-sick' })
    expect(whoIsOut(db, '2026-10-12', '2026-10-16').map((o) => o.personId)).toContain('p-elena')
  })

  it('never takes vacation past what was accrued', () => {
    for (const r of db.timeOffRequests.filter((x) => x.policyId === 'pol-vacation' && x.status === 'approved')) {
      const row = balances(db, r.personId, r.endDate).find((b) => b.policy.id === 'pol-vacation')
      expect(row?.balance ?? 0, r.id).toBeGreaterThanOrEqual(0)
    }
    for (const p of employedOn(db, TODAY)) {
      const row = balances(db, p.id, TODAY).find((b) => b.policy.id === 'pol-vacation')
      expect(row?.available ?? 0, p.id).toBeGreaterThanOrEqual(0)
    }
  })

  it("opens Tomas's bonding leave with the designation notice due Oct 13, not yet sent", () => {
    const lc = db.leaveCases.find((l) => l.id === 'lc-tomas-bonding')
    expect(lc).toMatchObject({ personId: 'p-tomas', kind: 'bonding', requestedOn: '2026-10-06', startDate: '2026-11-16', expectedReturn: '2027-01-11', designationNoticeDueOn: '2026-10-13' })
    expect(lc?.designationNoticeSentOn).toBeUndefined()
    const cl = db.checklists.find((c) => c.id === 'ck-leave-tomas')
    expect(cl?.tasks.find((t) => t.templateTaskId === 'lv-designation')).toMatchObject({ status: 'open', dueOn: '2026-10-13' })
  })
})

describe('contractors and compliance', () => {
  it('has the contractors and advisors', () => {
    expect(db.contractors.map((c) => c.id)).toEqual(['k-northline', 'k-marisol', 'k-fieldnote', 'k-adv-whitfield', 'k-adv-osei'])
    expect(db.contractors.find((c) => c.id === 'k-marisol')?.ab5).toMatchObject({ exemption: 'none', a: false, b: false, c: true })
    for (const c of db.contractors.filter((k) => k.kind === 'contractor' && k.entityType === 'individual')) expect(c.de542FiledOn, c.id).toBeTruthy()
  })

  it('records statuses only against real rules', () => {
    for (const id of Object.keys(db.complianceStatus)) expect(id === 'soc2-access-review' || !!RULE_BY_ID[id], id).toBe(true)
    for (const r of db.recurring) expect(!r.ruleId || r.ruleId === 'soc2-access-review' || r.ruleId === 'rate-review' || !!RULE_BY_ID[r.ruleId], r.id).toBe(true)
  })

  it('shows what Ledgerlark has done as done and the SB 553 plan as open', () => {
    const results = new Map(evaluateAll(db, TODAY).map((r) => [r.rule.id, r]))
    for (const id of [
      'workers-comp',
      'edd-registration',
      'iipp',
      'posters-federal',
      'posters-california',
      'posters-san-jose',
      'paid-sick-leave',
      'harassment-policy',
      'calsavers-or-401k',
      'first-out-of-state-employee',
      'first-option-grant',
      'sb294-annual-notice',
      'sb294-new-hire',
      'lactation-policy',
      'victims-leave-notice',
      'first-contractor',
      'cfra-pdl',
      'first-separation',
      'wage-notice-2810-5',
    ]) {
      expect(results.get(id)?.state, id).toBe('done')
    }
    expect(results.get('wvpp')?.state).toBe('applies')
    // Its setup steps are done, but Hannah Kim's training is overdue, so the card cannot read Done.
    const ht = results.get('harassment-training')
    expect(ht?.state).toBe('applies')
    expect(ht?.openActions).toEqual([])
    expect(ht?.followUps?.map((f) => f.title)).toEqual([expect.stringContaining('Hannah Kim')])
    expect(ht?.dueOn).toBe(ht?.followUps?.[0].dueOn)
    expect(results.get('pay-scale-in-postings')?.state).not.toBe('done')
    const rec = db.recurring.find((r) => r.ruleId === 'soc2-access-review')
    expect(rec).toMatchObject({ nextDueOn: '2026-10-31', lastDoneOn: '2026-07-30', cadence: 'quarterly' })
  })
})
