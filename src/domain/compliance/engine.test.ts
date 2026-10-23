import { describe, expect, it } from 'vitest'
import { generateChecklist } from '@/domain/checklists/generate'
import {
  evaluateAll,
  evaluateRule,
  hasPerPersonTasks,
  headcountRuler,
  milestoneHistory,
  nextThreshold,
  payRangeRequiredToPost,
  roughDate,
  ruleApplies,
  ruleDeadlineBesideTasks,
  summarizeResults,
} from './engine'
import { RULE_BY_ID, RULES } from './rules'
import { addContractor, addMany, addOffer, addPerson, ledgerlarkLite, makeDB } from './testkit'

const rule = (id: string) => {
  const r = RULE_BY_ID[id]
  if (!r) throw new Error(`missing rule ${id}`)
  return r
}

describe('rule catalog', () => {
  it('has stable, unique kebab ids and complete data', () => {
    const ids = RULES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const r of RULES) {
      expect(r.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(r.citation.url).toMatch(/^https:\/\//)
      expect(r.lastReviewedOn).toBe('2026-10-09')
      expect(r.actions.length).toBeGreaterThan(0)
      expect(new Set(r.actions.map((a) => a.id)).size).toBe(r.actions.length)
      const n = r.trigger.kind === 'headcount' || r.trigger.kind === 'site' ? r.trigger.n : 0
      expect(r.upcoming).toBe(n > 20)
    }
  })

  it('uses sentence case and no em dashes in user-facing text', () => {
    for (const r of RULES) {
      const text = [r.title, r.summary, r.countMethod, ...r.actions.map((a) => a.title)].join(' ')
      expect(text).not.toMatch(/[—–‘’“”]/)
      expect(r.title.charAt(0)).toBe(r.title.charAt(0).toUpperCase())
      // No Title Case: words after the first are lower case unless they are names, acronyms or codes.
      const words = r.title.split(/\s+/).slice(1)
      const capitalized = words.filter((w) => /^[A-Z][a-z]{3,}/.test(w))
      const allowed = ['California', 'Form', 'Fair', 'Chance', 'Jose', 'Opportunity', 'Work', 'Ordinance', 'Labor', 'Code', 'Family', 'Medical', 'Leave', 'Act', 'Federal', 'WARN']
      expect(capitalized.filter((w) => !allowed.includes(w.replace(/[^A-Za-z]/g, '')))).toEqual([])
    }
  })

  it('has exactly one hard stop (pay scale at 15) and no 26-employee rule', () => {
    expect(RULES.filter((r) => r.hardStop).map((r) => r.id)).toEqual(['pay-scale-in-postings'])
    expect(RULES.some((r) => (r.trigger.kind === 'headcount' || r.trigger.kind === 'site') && r.trigger.n === 26)).toBe(false)
  })

  it('covers the required thresholds and events', () => {
    const at = (n: number) => RULES.filter((r) => (r.trigger.kind === 'headcount' || r.trigger.kind === 'site') && r.trigger.n === n).map((r) => r.id)
    expect(at(5)).toEqual(expect.arrayContaining(['feha', 'harassment-policy', 'harassment-training', 'cfra-pdl', 'bereavement-reproductive-loss', 'fair-chance-act']))
    expect(at(10)).toEqual(expect.arrayContaining(['wvpp']))
    expect(at(15)).toEqual(expect.arrayContaining(['pay-scale-in-postings', 'organ-bone-marrow-leave', 'title-vii-ada-gina-pwfa']))
    expect(at(20)).toEqual(expect.arrayContaining(['adea', 'federal-cobra']))
    expect(at(25)).toEqual(expect.arrayContaining(['victims-leave-expanded', 'school-activities-leave']))
    expect(at(36)).toEqual(['sj-opportunity-to-work'])
    expect(at(50)).toEqual(expect.arrayContaining(['fmla', 'aca-employer-mandate']))
    expect(at(75)).toEqual(['cal-warn'])
    expect(at(100)).toEqual(expect.arrayContaining(['eeo-1', 'ca-pay-data-report', 'federal-warn']))
    const events = RULES.flatMap((r) => (r.trigger.kind === 'event' ? [r.trigger.event] : []))
    expect(new Set(events)).toEqual(
      new Set([
        'first_payroll',
        'first_non_owner_employee',
        'first_contractor',
        'first_option_grant',
        'first_out_of_state_employee',
        'first_remote_employee',
        'first_group_health_plan',
        'first_non_founder_manager',
        'first_non_exempt_hire',
        'first_visa_sponsorship',
        'first_separation',
        'ccpa_revenue',
        'credit_check',
      ]),
    )
    expect(rule('harassment-training').trigger).toEqual({ kind: 'headcount', n: 5, method: 'w2_plus_contractors' })
    expect(rule('title-vii-ada-gina-pwfa').trigger).toEqual({ kind: 'headcount', n: 15, method: 'weeks_20' })
    expect(rule('federal-cobra').trigger).toEqual({ kind: 'headcount', n: 20, method: 'cobra_prior_year' })
  })
})

describe('threshold states', () => {
  it('approaching when an incoming hire crosses within 60 days, then applies on the start date', () => {
    const db = makeDB()
    addMany(db, 3, '2025-02-03')
    addPerson(db, { id: 'p-fifth', firstName: 'Kofi', lastName: 'Boateng', startDate: '2025-10-06' })
    const before = evaluateRule(db, rule('feha'), '2025-09-01')
    expect(before.state).toBe('approaching')
    expect(before.projectedOn).toBe('2025-10-06')
    expect(before.projectedIfOffersAccepted).toBeUndefined()
    const after = evaluateRule(db, rule('feha'), '2025-10-06')
    expect(after.state).toBe('applies')
    expect(after.firstAppliedOn).toBe('2025-10-06')
    expect(after.count).toBe(5)
  })

  it('not yet when the projected date is more than 60 days out', () => {
    const db = makeDB()
    addMany(db, 3, '2025-02-03')
    addPerson(db, { id: 'p-fifth', startDate: '2025-12-01' })
    const r = evaluateRule(db, rule('feha'), '2025-09-01')
    expect(r.state).toBe('not_yet')
    expect(r.projectedOn).toBe('2025-12-01')
  })

  it("labels a crossing that depends on an outstanding offer as 'if accepted'", () => {
    const db = makeDB()
    addMany(db, 3, '2025-02-03')
    addOffer(db, { id: 'o1', startDate: '2025-10-06', status: 'sent' })
    const r = evaluateRule(db, rule('feha'), '2025-09-15')
    expect(r.state).toBe('approaching')
    expect(r.projectedOn).toBeUndefined()
    expect(r.projectedIfOffersAccepted).toBe('2025-10-06')
  })

  it('counts an accepted offer that has not been converted by Hire as incoming', () => {
    const db = makeDB()
    addMany(db, 3, '2025-02-03')
    addOffer(db, { id: 'o1', startDate: '2025-10-06', status: 'accepted' })
    expect(evaluateRule(db, rule('feha'), '2025-09-15').projectedOn).toBe('2025-10-06')
  })

  it('contractors count toward the harassment training threshold but not toward headcount', () => {
    const db = makeDB()
    addMany(db, 2, '2025-02-03')
    addContractor(db, { id: 'k1', startOn: '2025-03-01' })
    addContractor(db, { id: 'k2', startOn: '2025-04-01' })
    addContractor(db, { id: 'k-adv', kind: 'advisor', startOn: '2025-01-01' })
    const d = '2025-05-01'
    const training = evaluateRule(db, rule('harassment-training'), d)
    expect(training.state).toBe('applies')
    expect(training.count).toBe(5)
    expect(training.firstAppliedOn).toBe('2025-04-01')
    expect(training.howCounted).toContain('2 active contractors')
    expect(evaluateRule(db, rule('feha'), d).state).toBe('not_yet')
    expect(evaluateRule(db, rule('feha'), d).count).toBe(3)
  })

  it('honors an admin count override with a note', () => {
    const db = makeDB()
    addMany(db, 3, '2025-02-03')
    db.complianceStatus.feha = { countOverride: { value: 5, note: 'Two staff on a staffing agency payroll' } }
    const r = evaluateRule(db, rule('feha'), '2025-06-01')
    expect(r.state).toBe('applies')
    expect(r.overridden).toBe(true)
    expect(r.count).toBe(5)
    expect(r.computedCount).toBe(4)
    expect(r.howCounted).toContain('An admin set this count to 5 (Two staff on a staffing agency payroll); the computed count is 4.')
  })

  it("is done when marked done or when every action is done", () => {
    const db = makeDB()
    addMany(db, 5, '2025-02-03')
    db.complianceStatus.feha = { status: 'done', doneOn: '2025-03-01' }
    expect(evaluateRule(db, rule('feha'), '2025-06-01').state).toBe('done')
    db.complianceStatus['cfra-pdl'] = { actionsDone: { handbook: '2025-03-01', notices: '2025-03-01' } }
    const partial = evaluateRule(db, rule('cfra-pdl'), '2025-06-01')
    expect(partial.state).toBe('applies')
    expect(partial.openActions.map((a) => a.id)).toEqual(['leave-cases'])
    db.complianceStatus['cfra-pdl'].actionsDone = { handbook: '2025-03-01', notices: '2025-03-01', 'leave-cases': '2025-03-02' }
    expect(evaluateRule(db, rule('cfra-pdl'), '2025-06-01').state).toBe('done')
  })

  it('is not applicable when marked, outside its city, or with no one in California', () => {
    const db = makeDB()
    db.complianceStatus.iipp = { status: 'not_applicable', note: 'Covered by the PEO' }
    expect(evaluateRule(db, rule('iipp'), '2025-06-01')).toMatchObject({ state: 'not_applicable', notApplicableReason: 'Marked not applicable: Covered by the PEO.' })
    expect(evaluateRule(db, rule('posters-san-jose'), '2025-06-01').state).toBe('applies')

    const elsewhere = makeDB()
    elsewhere.company.hq.city = 'Oakland'
    elsewhere.locations[0].city = 'Oakland'
    elsewhere.people[0].homeCity = 'Oakland'
    expect(evaluateRule(elsewhere, rule('posters-san-jose'), '2025-06-01').state).toBe('not_applicable')

    const texas = makeDB()
    texas.company.hq.state = 'TX'
    texas.people[0].homeState = 'TX'
    expect(evaluateRule(texas, rule('paid-sick-leave'), '2025-06-01').notApplicableReason).toBe('No one works in California.')
    expect(evaluateRule(texas, rule('form-i9'), '2025-06-01').state).toBe('applies')
  })

  it('always-on rules apply from founding', () => {
    const db = makeDB('2025-01-06')
    const r = evaluateRule(db, rule('salary-history-ban'), '2025-01-06')
    expect(r.state).toBe('applies')
    expect(r.firstAppliedOn).toBe('2025-01-06')
  })

  it('recommends the harassment information sheet from the first hire', () => {
    const db = makeDB()
    const r = evaluateRule(db, rule('harassment-info-sheet'), '2025-06-01')
    expect(r.state).toBe('not_yet')
    expect(r.recommended).toBe(true)
  })
})

describe('site rule (SB 553)', () => {
  it('applies at 10 on site from Settings, ignoring remote staff', () => {
    const db = makeDB()
    addMany(db, 14, '2025-03-03')
    db.locations[0].typicalMaxOnSite = 11
    expect(evaluateRule(db, rule('wvpp'), '2025-06-01').state).toBe('applies')
    db.locations[0].typicalMaxOnSite = 9
    // 15 onsite or hybrid people are assigned to HQ, so a peak of 9 looks out of date.
    const stale = evaluateRule(db, rule('wvpp'), '2025-06-01')
    expect(stale.state).toBe('approaching')
    expect(stale.howCounted).toContain('Your Settings peak (9) is below the 15 people assigned to the office on an onsite or hybrid basis; update it in Settings.')
    const small = makeDB()
    addMany(small, 7, '2025-03-03')
    small.locations[0].typicalMaxOnSite = 6
    expect(evaluateRule(small, rule('wvpp'), '2025-06-01').state).toBe('not_yet')
  })

  it('a stale peak of 1 from a fresh workspace does not hide SB 553 as the office fills up', () => {
    const db = makeDB() // blankDB ships typicalMaxOnSite 1
    expect(db.locations[0].typicalMaxOnSite).toBe(1)
    addMany(db, 14, '2026-01-05')
    const r = evaluateRule(db, rule('wvpp'), '2026-10-09')
    expect(r.state).toBe('approaching')
    expect(r.count).toBe(1)
    expect(r.howCounted).toContain('Your Settings peak (1) is below the 15 people assigned to the office on an onsite or hybrid basis; update it in Settings.')
    // Onsite-only staff are certainly there at once, so they floor the setting.
    for (const p of db.people.slice(1, 11)) p.workMode = 'onsite'
    const floored = evaluateRule(db, rule('wvpp'), '2026-10-09')
    expect(floored).toMatchObject({ state: 'applies', count: 10 })
  })

  it('a peak of 0 does not hide a workplace open to the public once people work there', () => {
    const db = makeDB()
    db.locations[0].typicalMaxOnSite = 0
    db.locations[0].publicAccess = true
    addMany(db, 2, '2025-03-03')
    expect(evaluateRule(db, rule('wvpp'), '2025-06-01').state).toBe('applies')
  })

  it('applies below 10 when the workplace is open to the public', () => {
    const db = makeDB()
    db.locations[0].typicalMaxOnSite = 3
    db.locations[0].publicAccess = true
    expect(evaluateRule(db, rule('wvpp'), '2025-06-01').state).toBe('applies')
  })

  it('projects from incoming onsite hires when no peak is set, and excludes remote hires', () => {
    const db = makeDB()
    delete db.locations[0].typicalMaxOnSite
    addMany(db, 8, '2025-03-03')
    addPerson(db, { id: 'p-remote', startDate: '2025-06-02', workMode: 'remote', locationId: 'loc-remote-ca' })
    addPerson(db, { id: 'p-tenth', startDate: '2025-06-16' })
    const r = evaluateRule(db, rule('wvpp'), '2025-06-01')
    expect(r.state).toBe('approaching')
    expect(r.projectedOn).toBe('2025-06-16')
    expect(evaluateRule(db, rule('wvpp'), '2025-06-16').firstAppliedOn).toBe('2025-06-16')
  })
})

describe('federal 20-week rules', () => {
  it('applies this year when last year had 20 qualifying weeks', () => {
    const db = makeDB('2024-01-01')
    db.people[0].startDate = '2024-01-01'
    addMany(db, 14, '2025-01-06')
    const r = evaluateRule(db, rule('title-vii-ada-gina-pwfa'), '2026-02-01')
    expect(r.state).toBe('applies')
    expect(r.weeks).toMatchObject({ n: 15, lastYear: 52 })
    // Coverage is retroactive to Jan 1 of the year week 20 was reached, and lasts through the next year.
    expect(r.firstAppliedOn).toBe('2025-01-01')
    expect(r.howCounted).toContain('coverage reaches back to Jan 1 of that year and lasts through the next year')
  })

  it('reports a 20-week override in weeks, not people', () => {
    const db = makeDB()
    addMany(db, 15, '2026-09-07')
    db.complianceStatus['title-vii-ada-gina-pwfa'] = { countOverride: { value: 16, note: 'Agency temps' } }
    const r = evaluateRule(db, rule('title-vii-ada-gina-pwfa'), '2026-10-09')
    expect(r).toMatchObject({ state: 'not_yet', count: 16, computedCount: 5, overridden: true })
    expect(r.howCounted.startsWith('An admin set this to 16 qualifying weeks (Agency temps) (computed: 5 weeks). ')).toBe(true)
  })

  it('estimates the 20th week from the crossing date', () => {
    const db = makeDB()
    addMany(db, 13, '2025-06-02')
    addPerson(db, { id: 'p-15', startDate: '2026-11-09' })
    const r = evaluateRule(db, rule('title-vii-ada-gina-pwfa'), '2026-10-09')
    expect(r.state).toBe('not_yet')
    expect(r.weeks).toMatchObject({ thisYear: 0, lastYear: 0, estimatedOn: '2027-05-21' })
    expect(roughDate('2027-05-21')).toBe('late May 2027')
  })
})

describe('COBRA', () => {
  it('Cal-COBRA applies at 2 to 19 and gives way to federal COBRA at 20', () => {
    const db = makeDB('2024-01-01')
    db.people[0].startDate = '2024-01-01'
    addMany(db, 4, '2025-01-02')
    expect(evaluateRule(db, rule('cal-cobra'), '2026-03-01').state).toBe('applies')
    expect(evaluateRule(db, rule('federal-cobra'), '2026-03-01').state).toBe('not_yet')
    addMany(db, 16, '2025-01-02')
    const fed = evaluateRule(db, rule('federal-cobra'), '2026-03-01')
    expect(fed.state).toBe('applies')
    expect(fed.firstAppliedOn).toBe('2026-01-01')
    expect(evaluateRule(db, rule('cal-cobra'), '2026-03-01')).toMatchObject({ state: 'not_applicable', notApplicableReason: 'Federal COBRA applies instead.' })
  })

  it('projects federal COBRA for next year from this year', () => {
    const db = makeDB('2025-01-06')
    addMany(db, 19, '2026-01-05')
    const r = evaluateRule(db, rule('federal-cobra'), '2026-11-15')
    expect(r.projectedOn).toBe('2027-01-01')
    expect(r.state).toBe('approaching')
  })
})

describe('event triggers', () => {
  it('fires each event on its date', () => {
    const db = ledgerlarkLite()
    const d = '2026-10-09'
    expect(evaluateRule(db, rule('first-contractor'), d)).toMatchObject({ state: 'applies', firstAppliedOn: '2025-06-01' })
    expect(evaluateRule(db, rule('first-out-of-state-employee'), d)).toMatchObject({ state: 'applies', firstAppliedOn: '2026-03-02' })
    expect(evaluateRule(db, rule('first-non-founder-manager'), d).firstAppliedOn).toBe('2025-10-06')
    expect(evaluateRule(db, rule('wage-notice-2810-5'), d).firstAppliedOn).toBe('2026-07-20')
    expect(evaluateRule(db, rule('first-non-exempt-hire'), d).state).toBe('applies')
    expect(evaluateRule(db, rule('first-separation'), d).firstAppliedOn).toBe('2026-08-28')
    expect(evaluateRule(db, rule('first-option-grant'), d).state).toBe('not_yet')
    expect(evaluateRule(db, rule('ccpa-workforce-privacy'), d).howCounted).toContain('Add trailing revenue in Settings')
  })

  it('EDD registration is due 15 days after the first payroll', () => {
    const db = makeDB('2025-01-06')
    db.company.firstPayrollOn = '2025-01-06'
    const r = evaluateRule(db, rule('edd-registration'), '2025-01-10')
    expect(r).toMatchObject({ state: 'applies', firstAppliedOn: '2025-01-06', dueOn: '2025-01-21' })
    // A recorded first payroll makes it a legal deadline, not an estimate.
    expect(r.dueEstimated).toBeUndefined()
  })

  it('a founder working unpaid does not start the DE 1 clock; a paid founder starts it as an estimate', () => {
    const db = makeDB('2025-01-06')
    expect(evaluateRule(db, rule('edd-registration'), '2025-01-10')).toMatchObject({ state: 'not_yet', dueOn: undefined })
    db.comp.push({ id: 'cr-f', personId: 'p-founder', effectiveOn: '2025-01-06', payType: 'salary', salary: 0, title: 'CEO', levelId: 'lv-l3', reason: 'hire' })
    expect(evaluateRule(db, rule('edd-registration'), '2025-01-10').state).toBe('not_yet')
    db.comp.push({ id: 'cr-f2', personId: 'p-founder', effectiveOn: '2025-03-03', payType: 'salary', salary: 90000, title: 'CEO', levelId: 'lv-l3', reason: 'merit' })
    const paid = evaluateRule(db, rule('edd-registration'), '2025-04-01')
    expect(paid).toMatchObject({ state: 'applies', firstAppliedOn: '2025-03-03', dueOn: '2025-03-18', dueEstimated: true })
  })

  it('the golden path: an unpaid founder from Jan 1 and a first hire on Nov 2 date DE 1 from the hire, as an estimate', () => {
    const db = makeDB('2026-01-01')
    addPerson(db, { id: 'p-first', startDate: '2026-11-02' })
    db.comp.push({ id: 'cr-1', personId: 'p-first', effectiveOn: '2026-11-02', payType: 'salary', salary: 150000, title: 'Engineer', levelId: 'lv-l3', reason: 'hire' })
    const before = evaluateRule(db, rule('edd-registration'), '2026-10-10')
    expect(before).toMatchObject({ state: 'approaching', projectedOn: '2026-11-02', dueOn: '2026-11-17', dueEstimated: true })
    const on = evaluateRule(db, rule('edd-registration'), '2026-11-02')
    expect(on).toMatchObject({ state: 'applies', firstAppliedOn: '2026-11-02', dueOn: '2026-11-17', dueEstimated: true })
  })

  it('stay-or-pay applies to contracts from Jan 1, 2027: preparation before, in force from then, never since founding', () => {
    const db = makeDB('2025-02-03')
    const before = evaluateRule(db, rule('stay-or-pay-ban'), '2026-10-09')
    expect(before).toMatchObject({ state: 'applies', firstAppliedOn: undefined, effectiveOn: '2027-01-01' })
    expect(before.howCounted).toContain('contracts entered on or after Jan 1, 2027')
    const after = evaluateRule(db, rule('stay-or-pay-ban'), '2027-02-01')
    expect(after).toMatchObject({ state: 'applies', firstAppliedOn: '2027-01-01' })
    expect(after.effectiveOn).toBeUndefined()
  })

  it('CalSavers applies at the first non-owner hire but has no deadline until a notice is recorded', () => {
    const db = makeDB('2025-01-06')
    expect(evaluateRule(db, rule('calsavers-or-401k'), '2025-03-01').state).toBe('not_yet')
    addPerson(db, { id: 'p-first', startDate: '2025-04-07' })
    const soon = evaluateRule(db, rule('calsavers-or-401k'), '2025-03-01')
    expect(soon).toMatchObject({ state: 'approaching', projectedOn: '2025-04-07' })
    const r = evaluateRule(db, rule('calsavers-or-401k'), '2025-05-01')
    expect(r.state).toBe('applies')
    expect(r.dueOn).toBeUndefined()
    db.complianceStatus['calsavers-or-401k'] = { dueOn: '2026-12-31', note: 'CalSavers notice received Apr 2026' }
    expect(evaluateRule(db, rule('calsavers-or-401k'), '2026-05-01').dueOn).toBe('2026-12-31')
  })

  it('first option grant: 25102(o) due in 30 days, filing date detected from equity data', () => {
    const db = makeDB()
    db.equity.firstIssuanceOn = '2025-05-28'
    db.equity.valuations.push({ id: 'v1', effectiveOn: '2025-05-01', fmvPerShare: 0.25, provider: 'X', expiresOn: '2026-05-01' })
    let r = evaluateRule(db, rule('first-option-grant'), '2025-06-01')
    expect(r).toMatchObject({ state: 'applies', dueOn: '2025-06-27' })
    expect(r.actionsDone['get-409a']).toBe('2025-05-01')
    expect(r.openActions.map((a) => a.id)).toEqual(['file-25102o', 'board-consent'])
    db.equity.filing25102oOn = '2025-06-10'
    db.grants.push({
      id: 'g1',
      personId: 'p-founder',
      holderType: 'employee',
      type: 'ISO',
      shares: 1,
      strikePrice: 0.25,
      vestingStart: '2025-05-12',
      cliffMonths: 12,
      vestingMonths: 48,
      status: 'approved',
      boardApprovedOn: '2025-05-28',
      exercisedShares: 0,
      postTerminationExerciseDays: 90,
    })
    r = evaluateRule(db, rule('first-option-grant'), '2025-06-15')
    expect(r.state).toBe('done')
  })

  it('an incoming first non-exempt hire makes the wage notice approaching', () => {
    const db = makeDB()
    addPerson(db, { id: 'p-hourly', startDate: '2025-07-07', flsa: 'non_exempt', employmentType: 'part_time', hoursPerWeek: 25 })
    expect(evaluateRule(db, rule('wage-notice-2810-5'), '2025-06-20')).toMatchObject({ state: 'approaching', projectedOn: '2025-07-07' })
  })

  it('CCPA and credit checks trigger from company and job data', () => {
    const db = makeDB()
    db.company.annualRevenue = 27_000_000
    expect(evaluateRule(db, rule('ccpa-workforce-privacy'), '2026-10-09').state).toBe('applies')
  })
})

describe('evaluateAll and helpers', () => {
  it('evaluates the whole catalog for the sample-like roster', () => {
    const db = ledgerlarkLite()
    const all = evaluateAll(db, '2026-10-09')
    expect(all).toHaveLength(RULES.length)
    const byId = Object.fromEntries(all.map((r) => [r.rule.id, r]))
    expect(byId.feha.state).toBe('applies')
    expect(byId.wvpp.state).toBe('applies')
    expect(byId['pay-scale-in-postings']).toMatchObject({ state: 'approaching', projectedOn: '2026-10-19' })
    expect(byId['organ-bone-marrow-leave'].state).toBe('approaching')
    expect(byId['title-vii-ada-gina-pwfa']).toMatchObject({ state: 'not_yet' })
    expect(byId['title-vii-ada-gina-pwfa'].weeks?.estimatedOn).toBe('2027-05-21')
    expect(byId.adea.state).toBe('not_yet')
    expect(byId['sj-opportunity-to-work'].state).toBe('not_yet')
    const sum = summarizeResults(all)
    expect(sum.applies + sum.approaching + sum.not_yet + sum.done + sum.not_applicable).toBe(RULES.length)
    expect(ruleApplies(db, rule('wvpp'), '2026-10-09')).toBe(true)
  })

  it('pay range hard stop counts employees plus accepted offers', () => {
    const db = makeDB()
    addMany(db, 12, '2025-03-03') // 13
    addPerson(db, { id: 'p-incoming', startDate: '2026-11-02' })
    expect(payRangeRequiredToPost(db, '2026-10-09')).toMatchObject({ required: false, count: 14 })
    addOffer(db, { id: 'o-acc', startDate: '2026-11-16', status: 'accepted' })
    const r = payRangeRequiredToPost(db, '2026-10-09')
    expect(r).toMatchObject({ required: true, count: 15 })
    expect(r.howCounted).toBe('13 employees and 2 accepted offers not started yet: 15 in total. At 15, every job post needs a pay range.')
    addOffer(db, { id: 'o-sent', startDate: '2026-11-16', status: 'sent' })
    expect(payRangeRequiredToPost(db, '2026-10-09').count).toBe(15)
  })
})

describe('milestone history', () => {
  it('tells the story of each crossing, up and down', () => {
    const db = ledgerlarkLite()
    const history = milestoneHistory(db, '2026-10-09')
    expect(history.map((m) => m.text)).toEqual([
      'Crossed 5 on Oct 6, 2025 when Kofi Boateng joined.',
      'Crossed 10 on May 4, 2026 when Omar Haddad joined.',
    ])
    expect(history[0]).toMatchObject({ n: 5, date: '2025-10-06', direction: 'up', personId: 'p-kofi' })
    const all = milestoneHistory(db)
    expect(all[all.length - 1].text).toBe('Crossed 15 on Oct 19, 2026 when Lucas Ferreira joined.')
  })

  it('records a down-crossing on the first day without the person', () => {
    const db = makeDB()
    addMany(db, 3, '2025-02-03')
    addPerson(db, { id: 'p-ben', firstName: 'Ben', lastName: 'Carter', startDate: '2025-03-03', endDate: '2025-09-18' })
    addPerson(db, { id: 'p-new', firstName: 'Grace', lastName: 'Liu', startDate: '2025-10-01' })
    expect(milestoneHistory(db).map((m) => [m.direction, m.date, m.text])).toEqual([
      ['up', '2025-03-03', 'Crossed 5 on Mar 3, 2025 when Ben Carter joined.'],
      ['down', '2025-09-19', "Dropped below 5 after Ben Carter's last day on Sep 18, 2025."],
      ['up', '2025-10-01', 'Crossed 5 on Oct 1, 2025 when Grace Liu joined.'],
    ])
  })
})

describe('next threshold', () => {
  it('a solo founder is working toward 5', () => {
    const db = makeDB()
    const next = nextThreshold(db, '2025-03-01')
    expect(next).toMatchObject({ n: 5, kind: 'headcount', current: 1, withIncoming: 1 })
    expect(next?.rules.map((r) => r.id)).toEqual(expect.arrayContaining(['feha', 'cfra-pdl', 'fair-chance-act']))
    expect(next?.summary).toBe('You have 1 employee.')
  })

  it('15 with an incoming hire, plus the federal week counter', () => {
    const db = ledgerlarkLite()
    const next = nextThreshold(db, '2026-10-09')
    expect(next).toMatchObject({ n: 15, kind: 'headcount', current: 14, withIncoming: 16, projectedOn: '2026-10-19' })
    expect(next?.rules.map((r) => r.id)).toEqual(['pay-scale-in-postings', 'organ-bone-marrow-leave', 'title-vii-ada-gina-pwfa'])
    expect(next?.federalWeeks).toEqual({ n: 15, weeksSoFar: 0, estimatedOn: '2027-05-21', estimatedIfOffersAccepted: undefined })
    expect(next?.summary).toBe(
      'You have 14 employees. With Lucas Ferreira (Oct 19), you reach 15 on Oct 19, 2026. Federal coverage at 15 needs 15 or more employees in 20 calendar weeks of one year (week 0 of 20 in 2026); at that pace you would reach week 20 around late May 2027, and coverage then reaches back to Jan 1, 2027, so plan as covered for all of 2027.',
    )
  })

  it("names offers that are not accepted yet as 'if accepted'", () => {
    const db = makeDB()
    addMany(db, 12, '2025-03-03') // 13
    addPerson(db, { id: 'p-ravi', firstName: 'Ravi', lastName: 'Subramanian', startDate: '2026-10-26' })
    addOffer(db, { id: 'o-dani', startDate: '2026-11-09', status: 'sent' }, { firstName: 'Danielle', lastName: 'Brooks' })
    const next = nextThreshold(db, '2026-10-09')
    expect(next).toMatchObject({ n: 15, current: 13, withIncoming: 14, projectedIfOffersAccepted: '2026-11-09' })
    expect(next?.projectedOn).toBeUndefined()
    expect(next?.summary).toContain('With Ravi Subramanian (Oct 26) and Danielle Brooks (Nov 9, if accepted), you would reach 15 on Nov 9, 2026.')
    expect(next?.federalWeeks?.estimatedIfOffersAccepted).toBe('2027-05-21')
  })

  it('shows the 10-on-site milestone before 15 when the office is not there yet', () => {
    const db = makeDB()
    addMany(db, 7, '2025-03-03')
    db.locations[0].typicalMaxOnSite = 6
    const next = nextThreshold(db, '2025-06-01')
    expect(next).toMatchObject({ n: 10, kind: 'site', current: 6 })
    expect(next?.rules.map((r) => r.id)).toEqual(['wvpp', 'iipp-records'])
  })

  it('shows the 10-employee IIPP records rule even without an office', () => {
    const db = makeDB()
    db.locations = db.locations.filter((l) => l.kind !== 'hq')
    addMany(db, 6, '2025-03-03')
    const next = nextThreshold(db, '2025-06-01')
    expect(next).toMatchObject({ n: 10, kind: 'headcount', current: 7 })
    expect(next?.rules.map((r) => r.id)).toEqual(['iipp-records'])
  })
})

describe('headcount ruler', () => {
  it('solid dots for employees and incoming hires, hollow for outstanding offers', () => {
    const db = makeDB()
    addPerson(db, { id: 'p-a', firstName: 'Ana', lastName: 'Lee', startDate: '2025-03-03' })
    addPerson(db, { id: 'p-gone', startDate: '2025-03-03', endDate: '2025-05-01' })
    addPerson(db, { id: 'p-b', firstName: 'Bo', lastName: 'Ng', startDate: '2025-07-07' })
    addOffer(db, { id: 'o-acc', startDate: '2025-07-14', status: 'accepted' }, { firstName: 'Cy', lastName: 'Ray' })
    addOffer(db, { id: 'o-sent', startDate: '2025-07-21', status: 'sent' }, { firstName: 'Di', lastName: 'Oz' })
    expect(headcountRuler(db, '2025-06-01')).toEqual([
      { personId: 'p-founder', label: 'Fay Founder', kind: 'employee', date: '2025-01-06' },
      { personId: 'p-a', label: 'Ana Lee', kind: 'employee', date: '2025-03-03' },
      { personId: 'p-b', label: 'Bo Ng', kind: 'incoming', date: '2025-07-07' },
      { offerId: 'o-acc', label: 'Cy Ray', kind: 'incoming', date: '2025-07-14' },
      { offerId: 'o-sent', label: 'Di Oz', kind: 'if_accepted', date: '2025-07-21' },
    ])
  })
})

describe('yearly cycles', () => {
  function withStaff() {
    const db = makeDB('2025-01-06')
    addMany(db, 2, '2025-03-03')
    return db
  }

  it('SB 294 actions done for 2026 rest until the 2027 notice reopens, then stay open if missed', () => {
    const db = withStaff()
    db.complianceStatus['sb294-annual-notice'] = { actionsDone: { 'send-annual': '2026-01-20', 'record-dates': '2026-01-20' } }
    const quiet = evaluateRule(db, rule('sb294-annual-notice'), '2026-06-01')
    expect(quiet.state).toBe('done')
    expect(quiet.actionsDone['send-annual']).toBe('2026-01-20')
    expect(quiet.cycle).toMatchObject({ year: 2027, dueOn: '2027-02-01', startsOn: '2026-02-02', lastDoneOn: '2026-01-20', open: false })
    const due = evaluateRule(db, rule('sb294-annual-notice'), '2027-01-25')
    expect(due.state).toBe('applies')
    expect(due.openActions.map((a) => a.id)).toEqual(['send-annual', 'record-dates'])
    expect(due.cycle?.open).toBe(true)
    expect(summarizeResults([due]).openActions).toBe(2)
    const later = evaluateRule(db, rule('sb294-annual-notice'), '2028-01-25')
    expect(later.state).toBe('applies')
    expect(later.cycle?.overdueYear).toBe(2027)
  })

  it('a company that first hires after Feb 1 owes its first notice the next Feb 1, with nothing open before then', () => {
    const db = makeDB('2026-03-02')
    addPerson(db, { id: 'p-first', startDate: '2026-03-02' })
    const r = evaluateRule(db, rule('sb294-annual-notice'), '2026-06-01')
    expect(r.state).toBe('applies')
    expect(r.openActions).toEqual([])
    expect(evaluateRule(db, rule('sb294-annual-notice'), '2026-12-15').openActions.map((a) => a.id)).toEqual(['send-annual', 'record-dates'])
  })

  it('owes no yearly employee notice while the only person is an owner with no pay', () => {
    const db = makeDB('2026-01-01')
    // Before any hire: nothing open, nothing overdue for the Feb 1, 2026 cycle, and the card says why.
    const solo = evaluateRule(db, rule('sb294-annual-notice'), '2026-10-11')
    expect(solo.openActions).toEqual([])
    expect(solo.cycle).toMatchObject({ awaitingEmployees: true })
    expect(solo.cycle?.overdueYear).toBeUndefined()
    expect(evaluateRule(db, rule('victims-leave-notice'), '2026-10-11').cycle?.overdueYear).toBeUndefined()
    expect(evaluateRule(db, rule('sb294-annual-notice'), '2027-01-25').openActions).toEqual([])
    // A first hire on Nov 2 makes the Feb 1, 2027 notice the first one owed.
    addPerson(db, { id: 'p-first', startDate: '2026-11-02' })
    const hired = evaluateRule(db, rule('sb294-annual-notice'), '2026-12-15')
    expect(hired.cycle?.awaitingEmployees).toBeUndefined()
    expect(hired.cycle?.overdueYear).toBeUndefined()
    expect(hired.openActions.map((a) => a.id)).toEqual(['send-annual', 'record-dates'])
    // A founder on paid payroll is an employee to notify.
    const paid = makeDB('2026-01-01')
    paid.comp.push({ id: 'cr-f', personId: 'p-founder', effectiveOn: '2026-01-01', payType: 'salary', salary: 120_000, title: 'CEO', levelId: 'lv-l5', reason: 'hire' })
    expect(evaluateRule(paid, rule('sb294-annual-notice'), '2026-10-11').cycle?.overdueYear).toBe(2026)
  })

  it('the yearly employee notices apply from the first paid employee, not from an unpaid founding', () => {
    const db = makeDB('2026-01-01')
    // A solo founder with no pay: nobody to send them to yet, so no start date.
    expect(evaluateRule(db, rule('sb294-annual-notice'), '2026-10-11').firstAppliedOn).toBeUndefined()
    addPerson(db, { id: 'p-first', startDate: '2026-11-02' })
    for (const id of ['sb294-annual-notice', 'victims-leave-notice']) {
      expect(evaluateRule(db, rule(id), '2026-11-02')).toMatchObject({ state: 'applies', firstAppliedOn: '2026-11-02' })
    }
    // Duties at hire still start with the company's first employee.
    expect(evaluateRule(db, rule('sb294-new-hire'), '2026-11-02').firstAppliedOn).toBe('2026-01-01')
    // A founder on paid payroll from Mar 2 is the first person owed the notices.
    db.comp.push({ id: 'cr-f', personId: 'p-founder', effectiveOn: '2026-03-02', payType: 'salary', salary: 120_000, title: 'CEO', levelId: 'lv-l5', reason: 'merit' })
    expect(evaluateRule(db, rule('sb294-annual-notice'), '2026-11-02').firstAppliedOn).toBe('2026-03-02')
  })

  it('a rule marked done counts for its cycle only', () => {
    const db = withStaff()
    db.complianceStatus['posters-california'] = { status: 'done', doneOn: '2026-01-10' }
    expect(evaluateRule(db, rule('posters-california'), '2026-07-01').state).toBe('done')
    expect(evaluateRule(db, rule('posters-california'), '2027-01-05').state).toBe('applies')
  })

  it('marking a rule done in the quiet months confirms last cycle and never covers the next filing', () => {
    const db = withStaff()
    addContractor(db, { id: 'k1', startOn: '2025-06-01', rate: 5000 })
    db.complianceStatus['first-contractor'] = { status: 'done', doneOn: '2026-03-01' }
    expect(evaluateRule(db, rule('first-contractor'), '2026-10-09').state).toBe('done')
    const jan = evaluateRule(db, rule('first-contractor'), '2027-01-15')
    expect(jan.state).toBe('applies')
    expect(jan.openActions.map((a) => a.id)).toEqual(['form-1099'])
  })

  it('the whole-cycle key from the calendar marks every yearly action done', () => {
    const db = withStaff()
    db.complianceStatus['sb294-annual-notice'] = { actionsDone: { 'year-2027': '2027-01-22' } }
    const r = evaluateRule(db, rule('sb294-annual-notice'), '2027-01-25')
    expect(r.state).toBe('done')
    expect(r.cycle?.doneOn).toBe('2027-01-22')
  })

  it('the 1099-NEC action opens only when a contractor crossed the threshold the year before', () => {
    const db = withStaff()
    addContractor(db, { id: 'k1', startOn: '2026-04-01', rate: 5000 })
    db.complianceStatus['first-contractor'] = { actionsDone: { 'ab5-check': '2026-03-20', de542: '2026-04-10', w9: '2026-03-25' } }
    expect(evaluateRule(db, rule('first-contractor'), '2026-10-09')).toMatchObject({ state: 'done', openActions: [] })
    const jan = evaluateRule(db, rule('first-contractor'), '2027-01-15')
    expect(jan.state).toBe('applies')
    expect(jan.openActions.map((a) => a.id)).toEqual(['form-1099'])
    const small = withStaff()
    addContractor(small, { id: 'k2', startOn: '2026-05-01', endOn: '2026-05-31', rate: 1500, rateUnit: 'project' })
    expect(evaluateRule(small, rule('first-contractor'), '2027-01-15').openActions.map((a) => a.id)).not.toContain('form-1099')
  })
})

describe('first payroll and data on file', () => {
  it('uses the first payroll date from Settings, and an estimate otherwise', () => {
    const db = makeDB('2025-02-03')
    addPerson(db, { id: 'p-tomas', startDate: '2025-05-12' })
    // The founder has no pay recorded, so the estimate starts with the first paid employee.
    const est = evaluateRule(db, rule('edd-registration'), '2025-06-01')
    expect(est).toMatchObject({ firstAppliedOn: '2025-05-12', dueOn: '2025-05-27', dueEstimated: true })
    expect(est.howCounted).toContain('Estimated from the first paid W-2 start on record')
    expect(est.howCounted).toContain('Owners with no pay recorded are left out.')
    db.company.firstPayrollOn = '2025-05-15'
    const exact = evaluateRule(db, rule('edd-registration'), '2025-06-01')
    expect(exact).toMatchObject({ firstAppliedOn: '2025-05-15', dueOn: '2025-05-30' })
    expect(exact.dueEstimated).toBeUndefined()
    expect(exact.howCounted).toBe('First payroll on May 15, 2025 (from Settings).')
  })

  it("treats a saved EDD account number and workers' comp policy number as done", () => {
    const db = makeDB('2025-02-03')
    addPerson(db, { id: 'p-tomas', startDate: '2025-05-12' })
    db.company.eddAccountNumber = '123-4567-8'
    db.company.workersCompCarrier = { name: 'Golden Poppy Mutual' }
    // EDD issues the account number only after registration: both steps are on file and the rule is done.
    const edd = evaluateRule(db, rule('edd-registration'), '2025-06-01')
    expect(edd.openActions).toEqual([])
    expect(edd.onFile).toEqual(['register', 'save-account'])
    expect(edd.state).toBe('done')
    // A carrier name alone does not show a bound policy; its policy number does.
    expect(evaluateRule(db, rule('workers-comp'), '2025-06-01').openActions.map((a) => a.id)).toEqual(['bind-policy', 'new-hire-pamphlet'])
    db.company.workersCompCarrier = { name: 'Golden Poppy Mutual', policyNumber: ' WC-2025-0042 ' }
    const wc = evaluateRule(db, rule('workers-comp'), '2025-06-01')
    expect(wc.openActions.map((a) => a.id)).toEqual(['new-hire-pamphlet'])
    expect(wc.onFile).toEqual(['bind-policy', 'save-carrier'])
  })
})

describe('per-person deadlines on checklist tasks', () => {
  /** An unpaid founder since Jan 1 and Maria, the first hire, starting Mon Nov 2 with her onboarding checklist. */
  function golden() {
    const db = makeDB('2026-01-01')
    const maria = addPerson(db, { id: 'p-maria', firstName: 'Maria', lastName: 'Gonzalez', startDate: '2026-11-02' })
    db.checklists.push(generateChecklist(db, { id: 'ck-maria', person: maria, templateId: 'tpl-onboarding', anchorDate: '2026-11-02', createdOn: '2026-10-11' }))
    return db
  }

  it("gives an overdue DE 34 the task's file-by day, and a deadline recorded on the card its own", () => {
    const db = golden()
    // DE 34 is due Sun Nov 22: file by Fri Nov 20, as the checklist row says.
    const late = evaluateRule(db, rule('new-hire-reporting'), '2026-11-30')
    expect(late).toMatchObject({ state: 'applies', dueOn: '2026-11-22', fileBy: '2026-11-20' })
    expect(late.followUps?.[0]).toMatchObject({ personId: 'p-maria', dueOn: '2026-11-22', fileBy: '2026-11-20' })
    // I-9 section 1 is not an agency filing (and is due on a Monday anyway).
    const i9 = evaluateRule(db, rule('form-i9'), '2026-11-30')
    expect(i9.dueOn).toBe('2026-11-02')
    expect(i9.fileBy).toBeUndefined()
    // DE 34 is an agency filing: a deadline recorded on the card for Sat Dec 5 is filed by Fri Dec 4.
    db.complianceStatus['new-hire-reporting'] = { dueOn: '2026-12-05' }
    expect(evaluateRule(db, rule('new-hire-reporting'), '2026-11-10')).toMatchObject({ dueOn: '2026-12-05', fileBy: '2026-12-04' })
  })

  it("leaves a date that comes from a task on the task, and keeps a deadline of the rule's own", () => {
    const db = golden()
    expect(['new-hire-reporting', 'form-i9', 'sb294-new-hire', 'wage-notice-2810-5'].every(hasPerPersonTasks)).toBe(true)
    expect(hasPerPersonTasks('edd-registration')).toBe(false)
    expect(ruleDeadlineBesideTasks(db, evaluateRule(db, rule('new-hire-reporting'), '2026-11-30'))).toBeUndefined()
    expect(ruleDeadlineBesideTasks(db, evaluateRule(db, rule('form-i9'), '2026-11-30'))).toBeUndefined()
    db.complianceStatus['new-hire-reporting'] = { dueOn: '2026-12-15' }
    expect(ruleDeadlineBesideTasks(db, evaluateRule(db, rule('new-hire-reporting'), '2026-11-30'))).toBe('2026-12-15')
    // Other rules keep their own dates.
    db.company.firstPayrollOn = '2026-11-13'
    expect(ruleDeadlineBesideTasks(db, evaluateRule(db, rule('edd-registration'), '2026-11-30'))).toBe('2026-11-28')
  })

  it('keeps a clock for a hire with no such task, and drops it once their checklist has one', () => {
    // A per-person rule with a clock from its trigger (none in the catalog today): the founder started it.
    const clocked = { ...rule('new-hire-reporting'), dueDaysAfterTrigger: 20 }
    const db = makeDB('2026-11-02')
    expect(ruleDeadlineBesideTasks(db, evaluateRule(db, clocked, '2026-11-30'))).toBe('2026-11-22')
    db.checklists.push({
      id: 'ck-founder',
      personId: 'p-founder',
      kind: 'onboarding',
      templateId: 'tpl-onboarding',
      anchorDate: '2026-11-02',
      createdOn: '2026-11-02',
      tasks: [{ id: 't-de34', templateTaskId: 'on-de34', title: 'DE 34 new hire report filed', ownerRole: 'admin', dueOn: '2026-11-22', status: 'done', category: 'legal', statutory: true }],
    })
    expect(ruleDeadlineBesideTasks(db, evaluateRule(db, clocked, '2026-11-30'))).toBeUndefined()
  })
})
