import { describe, expect, it } from 'vitest'
import {
  cobraLevel,
  countFor,
  estimateTwentyWeeks,
  eventHit,
  firstDateAtOrAbove,
  firstPaidEmployeeOn,
  offerPhantoms,
  projectionDB,
  qualifyingWeeks,
  rawCount,
  supervisorSince,
  weeksAtOrAbove,
} from './counting'
import { addContractor, addMany, addOffer, addPerson, ledgerlarkLite, makeDB } from './testkit'

describe('w2_one_in_ca', () => {
  it('counts every W-2 employee in any state, part-time, interns and people on leave', () => {
    const db = makeDB()
    addPerson(db, { id: 'p-pt', startDate: '2025-03-03', employmentType: 'part_time', hoursPerWeek: 20 })
    addPerson(db, { id: 'p-intern', startDate: '2025-06-02', employmentType: 'intern' })
    addPerson(db, { id: 'p-tx', startDate: '2025-04-01', homeState: 'TX', workMode: 'remote', locationId: 'loc-remote-tx' })
    addPerson(db, { id: 'p-leave', startDate: '2025-02-03' })
    db.leaveCases.push({ id: 'lc1', personId: 'p-leave', kind: 'cfra', requestedOn: '2025-08-01', startDate: '2025-08-15', expectedReturn: '2025-11-01' })
    addPerson(db, { id: 'p-gone', startDate: '2025-02-03', endDate: '2025-05-30' })
    addPerson(db, { id: 'p-future', startDate: '2025-12-01' })
    addContractor(db, { id: 'k1', startOn: '2025-01-15' })
    addContractor(db, { id: 'k-adv', kind: 'advisor', startOn: '2025-01-15' })

    const r = countFor(db, 'w2_one_in_ca', '2025-09-01')
    expect(r.count).toBe(5) // founder, part-timer, intern, TX, on leave
    expect(r.personIds).not.toContain('p-gone')
    expect(r.personIds).not.toContain('p-future')
    expect(r.howCounted).toContain('5 W-2 employees on Sep 1, 2025')
    expect(r.howCounted).toContain('4 in California, 1 in TX'.replace('TX', 'Texas'))
    expect(r.howCounted).toContain('1 on leave')
    expect(r.howCounted).toContain('Not counted: 1 contractor, 1 advisor, 1 former employee and 1 person who had not started yet.')
  })

  it('says when no one works in California', () => {
    const db = makeDB()
    db.company.hq.state = 'TX'
    db.people[0].homeState = 'TX'
    expect(countFor(db, 'w2_one_in_ca', '2025-09-01').howCounted).toContain('No one works in California')
  })
})

describe('w2_plus_contractors', () => {
  it('adds active contractors but not advisors or ended contracts, and contractors never count as headcount', () => {
    const db = makeDB()
    addMany(db, 2, '2025-02-03')
    addContractor(db, { id: 'k-llc', entityName: 'Acme LLC', entityType: 'llc', startOn: '2025-01-01' })
    addContractor(db, { id: 'k-ind', name: 'Ivy Individual', startOn: '2025-03-01' })
    addContractor(db, { id: 'k-old', startOn: '2025-01-01', endOn: '2025-02-28' })
    addContractor(db, { id: 'k-adv', kind: 'advisor', startOn: '2025-01-01' })
    const r = countFor(db, 'w2_plus_contractors', '2025-04-01')
    expect(r.count).toBe(5)
    expect(r.contractorIds).toEqual(['k-llc', 'k-ind'])
    expect(r.howCounted).toContain('3 W-2 employees in any state plus 2 active contractors (Acme LLC and Ivy Individual)')
    expect(r.howCounted).toContain('advisors are not counted')
    expect(r.howCounted).not.toContain('Counting the')
    expect(rawCount(db, 'w2_one_in_ca', '2025-04-01')).toBe(3)
  })

  it('says when counting active advisors would reach 5 (a judgment call left to counsel)', () => {
    const db = makeDB()
    addMany(db, 1, '2025-02-03')
    addContractor(db, { id: 'k-ind', startOn: '2025-03-01' })
    addContractor(db, { id: 'k-adv1', kind: 'advisor', startOn: '2025-01-01' })
    addContractor(db, { id: 'k-adv2', kind: 'advisor', startOn: '2025-01-01' })
    addContractor(db, { id: 'k-adv-old', kind: 'advisor', startOn: '2024-01-01', endOn: '2024-12-31' })
    const r = countFor(db, 'w2_plus_contractors', '2025-04-01', { n: 5 })
    expect(r.count).toBe(3)
    expect(r.howCounted).toContain('Counting the 2 active advisors would make 5, which reaches 5: if they give regular services under contract, confirm with counsel and override the count.')
  })
})

describe('20-week counter', () => {
  it('counts only weeks at or above n on every weekday', () => {
    const db = makeDB('2025-01-06')
    addMany(db, 13, '2026-01-05') // 14 from Mon Jan 5, 2026
    addPerson(db, { id: 'p-wed', startDate: '2026-01-14' }) // Wednesday: week of Jan 12 does not qualify
    expect(weeksAtOrAbove(db, 15, 2026, '2026-01-16')).toBe(0)
    expect(weeksAtOrAbove(db, 15, 2026, '2026-01-23')).toBe(1)
    expect(qualifyingWeeks(db, 15, 2026, '2026-01-30')).toEqual(['2026-01-23', '2026-01-30'])
    // A week in progress does not count until its Friday has passed.
    expect(weeksAtOrAbove(db, 15, 2026, '2026-01-28')).toBe(1)
  })

  it('does not count a week with a dip below n on any weekday', () => {
    const db = makeDB('2025-01-06')
    addMany(db, 13, '2026-01-05')
    addPerson(db, { id: 'p-left', startDate: '2026-01-05', endDate: '2026-01-14' }) // gone from Thu Jan 15
    addPerson(db, { id: 'p-back', startDate: '2026-01-16' })
    expect(qualifyingWeeks(db, 15, 2026, '2026-01-30')).toEqual(['2026-01-09', '2026-01-23', '2026-01-30'])
  })

  it('weeks do not carry over: 15 from Nov 9, 2026 reaches week 20 on Fri May 21, 2027', () => {
    const db = makeDB('2025-01-06')
    addMany(db, 13, '2025-06-02')
    addPerson(db, { id: 'p-15', startDate: '2026-11-09' })
    expect(weeksAtOrAbove(db, 15, 2026)).toBe(8) // Nov 9 to Dec 28 weeks
    expect(estimateTwentyWeeks(db, 15, '2026-10-09')).toBe('2027-05-21')
    const r = countFor(db, 'weeks_20', '2026-12-31', { n: 15 })
    expect(r.weeks).toEqual({ n: 15, thisYear: 7, lastYear: 0 }) // the Dec 28 week ends Fri Jan 1, 2027
    expect(r.howCounted).toContain('7 of 20 calendar weeks so far in 2026')
  })
})

describe('cobra_prior_year', () => {
  it('finds the level met on more than half of typical business days last year, part-timers as fractions', () => {
    const db = makeDB('2024-01-01')
    db.people[0].startDate = '2024-01-01'
    addMany(db, 18, '2025-01-02')
    addPerson(db, { id: 'p-half', startDate: '2025-01-02', employmentType: 'part_time', hoursPerWeek: 20 })
    // 19.5 all year
    expect(cobraLevel(db, '2026-03-01').level).toBe(19.5)
    addPerson(db, { id: 'p-late', startDate: '2025-05-01' }) // 20.5 for about two thirds of the year
    expect(cobraLevel(db, '2026-03-01').level).toBe(20.5)
    addPerson(db, { id: 'p-oct', startDate: '2025-10-01' }) // under half the year: does not move the level
    expect(cobraLevel(db, '2026-03-01').level).toBe(20.5)
    const r = countFor(db, 'cobra_prior_year', '2026-03-01')
    expect(r.howCounted).toMatch(/In 2025, Testco had at least 20\.5 employees on more than half of its \d+ typical business days/)
  })

  it('skips company holidays when counting business days', () => {
    const db = makeDB('2024-01-01')
    db.holidays = []
    const plain = cobraLevel(db, '2026-01-15').businessDays
    db.holidays = [{ id: 'h1', date: '2025-07-04', name: 'Independence Day' }]
    expect(cobraLevel(db, '2026-01-15').businessDays).toBe(plain - 1)
  })

  it('falls back to the preceding quarter when there were no employees last year (Cal-COBRA)', () => {
    const db = makeDB('2026-01-05')
    addMany(db, 2, '2026-01-05')
    expect(cobraLevel(db, '2026-05-01').level).toBe(0)
    const q = cobraLevel(db, '2026-05-01', { priorQuarterFallback: true })
    expect(q.basis).toBe('quarter')
    expect(q.periodLabel).toBe('Q1 2026')
    expect(q.level).toBe(3)
  })
})

describe('site and location counts', () => {
  it('uses the typical peak on site from Settings when set', () => {
    const db = makeDB()
    addMany(db, 12, '2025-03-03')
    db.locations[0].typicalMaxOnSite = 9
    const r = countFor(db, 'site', '2025-06-02')
    expect(r.count).toBe(9)
    expect(r.fromSettings).toBe(true)
    expect(r.howCounted).toContain('9 people at San Jose HQ at once on a typical busy day (from Settings)')
    expect(r.howCounted).toContain('13 employees are assigned there')
    expect(r.publicAccess).toBe(false)
    // 13 onsite or hybrid staff against a peak of 9 is flagged, not trusted silently.
    expect(r.staleSetting).toBe(true)
    expect(r.howCounted).toContain('Your Settings peak (9) is below the 13 people assigned to the office on an onsite or hybrid basis; update it in Settings.')
  })

  it('never counts fewer than the onsite-only staff assigned to the site', () => {
    const db = makeDB()
    addMany(db, 4, '2025-03-03')
    for (const p of db.people.slice(1)) p.workMode = 'onsite'
    const r = countFor(db, 'site', '2025-06-02')
    expect(r).toMatchObject({ count: 4, setting: 1, assigned: 5, staleSetting: false })
    expect(r.howCounted).toContain('4 employees are assigned to San Jose HQ onsite only, so at least 4 are there at once; your Settings peak (1) is lower.')
    expect(rawCount(db, 'site', '2025-06-02')).toBe(4)
  })

  it('finds the first date onsite-only staff lift the site count past a low setting', () => {
    const db = makeDB()
    addMany(db, 9, '2025-03-03')
    for (const p of db.people.slice(1)) p.workMode = 'onsite'
    addPerson(db, { id: 'p-tenth', startDate: '2025-07-07', workMode: 'onsite' })
    expect(firstDateAtOrAbove(db, 'site', 10)).toBe('2025-07-07')
    db.locations[0].typicalMaxOnSite = 12
    expect(firstDateAtOrAbove(db, 'site', 10)).toBeUndefined()
  })

  it('falls back to onsite and hybrid people assigned to the site, excluding remote staff', () => {
    const db = makeDB()
    delete db.locations[0].typicalMaxOnSite
    addMany(db, 6, '2025-03-03')
    addPerson(db, { id: 'p-remote', startDate: '2025-03-03', workMode: 'remote', locationId: 'loc-remote-ca' })
    addPerson(db, { id: 'p-remote-hq', startDate: '2025-03-03', workMode: 'remote' })
    const r = countFor(db, 'site', '2025-06-02')
    expect(r.count).toBe(7)
    expect(r.howCounted).toContain('2 remote employees are not counted')
  })

  it('flags a workplace open to the public', () => {
    const db = makeDB()
    db.locations[0].publicAccess = true
    db.locations[0].typicalMaxOnSite = 3
    const r = countFor(db, 'site', '2025-06-02')
    expect(r.publicAccess).toBe(true)
    expect(r.howCounted).toContain('open to the public')
    // A peak of 0 does not hide public access while people are assigned there.
    db.locations[0].typicalMaxOnSite = 0
    expect(countFor(db, 'site', '2025-06-02').publicAccess).toBe(true)
  })

  it('w2_at_location counts the largest location and leaves out remote staff', () => {
    const db = makeDB()
    addMany(db, 3, '2025-03-03')
    addPerson(db, { id: 'p-r', startDate: '2025-03-03', workMode: 'remote', locationId: 'loc-remote-ca' })
    expect(rawCount(db, 'w2_at_location', '2025-06-02')).toBe(4)
    expect(countFor(db, 'w2_at_location', '2025-06-02').howCounted).toContain('1 remote employee is not counted')
  })

  it('in_san_jose counts people at a San Jose site or remote from San Jose', () => {
    const db = makeDB()
    addPerson(db, { id: 'p-hq-fremont', startDate: '2025-03-03', homeCity: 'Fremont' })
    addPerson(db, { id: 'p-remote-sj', startDate: '2025-03-03', workMode: 'remote', locationId: 'loc-remote-ca', homeCity: 'San Jose' })
    addPerson(db, { id: 'p-remote-oak', startDate: '2025-03-03', workMode: 'remote', locationId: 'loc-remote-ca', homeCity: 'Oakland' })
    expect(rawCount(db, 'in_san_jose', '2025-06-02')).toBe(3)
  })
})

describe('first crossings and projections', () => {
  it('finds the first date a count reaches n', () => {
    const db = ledgerlarkLite()
    expect(firstDateAtOrAbove(db, 'w2_one_in_ca', 5)).toBe('2025-10-06')
    expect(firstDateAtOrAbove(db, 'w2_plus_contractors', 5)).toBe('2025-08-18')
    expect(firstDateAtOrAbove(db, 'w2_one_in_ca', 15, { after: '2026-10-09' })).toBe('2026-10-19')
    expect(firstDateAtOrAbove(db, 'w2_one_in_ca', 15, { through: '2026-10-09' })).toBeUndefined()
  })

  it('turns offers into future people: accepted (not hired yet) as incoming, sent or approved as if accepted', () => {
    const db = makeDB()
    addOffer(db, { id: 'o-acc', startDate: '2026-11-02', status: 'accepted' })
    addOffer(db, { id: 'o-sent', startDate: '2026-11-09', status: 'sent' }, { firstName: 'Danielle', lastName: 'Brooks' })
    addOffer(db, { id: 'o-old', applicationId: 'a-o-v', startDate: '2026-11-16', status: 'sent', version: 1 })
    addOffer(db, { id: 'o-new', applicationId: 'a-o-v', candidateId: 'c-o-old', startDate: '2026-11-16', status: 'declined', version: 2 })
    addOffer(db, { id: 'o-hired', startDate: '2026-11-02', status: 'accepted', personId: 'p-someone' })
    addOffer(db, { id: 'o-draft', startDate: '2026-11-02', status: 'draft' })
    const ph = offerPhantoms(db, '2026-10-09')
    expect(ph.map((x) => [x.offer.id, x.kind])).toEqual([
      ['o-acc', 'incoming'],
      ['o-sent', 'if_accepted'],
    ])
    expect(ph[1].person.firstName).toBe('Danielle')
    expect(projectionDB(db, '2026-10-09', false).people).toHaveLength(2)
    expect(projectionDB(db, '2026-10-09', true).people).toHaveLength(3)
  })

  it('leaves out offers past their expiry date: they can no longer be accepted', () => {
    const db = makeDB()
    addOffer(db, { id: 'o-open', startDate: '2026-11-09', status: 'sent', expiresOn: '2026-10-19' })
    addOffer(db, { id: 'o-lapsed', startDate: '2026-11-09', status: 'sent', expiresOn: '2026-10-14' })
    addOffer(db, { id: 'o-approved-lapsed', startDate: '2026-11-16', status: 'approved', expiresOn: '2026-10-16' })
    addOffer(db, { id: 'o-closed', startDate: '2026-11-16', status: 'expired', expiresOn: '2026-10-15' })
    expect(offerPhantoms(db, '2026-10-19').map((x) => x.offer.id)).toEqual(['o-open'])
    expect(offerPhantoms(db, '2026-10-20')).toEqual([])
  })
})

describe('events', () => {
  it('reports each first-time event with its date', () => {
    const db = ledgerlarkLite()
    const d = '2026-10-09'
    // The founder has no pay on record, so the first payroll is estimated from the first paid employee.
    expect(eventHit(db, 'first_payroll', d)).toMatchObject({ date: '2025-05-12', personId: 'p-tomas', estimated: true })
    expect(eventHit(db, 'first_non_owner_employee', d)?.date).toBe('2025-05-12')
    expect(eventHit(db, 'first_contractor', d)?.text).toContain('Northline Finance Partners LLC')
    expect(eventHit(db, 'first_out_of_state_employee', d)).toMatchObject({ date: '2026-03-02', personId: 'p-caleb' })
    expect(eventHit(db, 'first_non_founder_manager', d)).toMatchObject({ date: '2025-10-06', personId: 'p-tomas' })
    expect(eventHit(db, 'first_non_exempt_hire', d)).toMatchObject({ date: '2026-07-20', personId: 'p-luis' })
    expect(eventHit(db, 'first_separation', d)).toMatchObject({ date: '2026-08-28', personId: 'p-omar' })
    expect(eventHit(db, 'first_option_grant', d)).toBeUndefined()
    expect(eventHit(db, 'first_visa_sponsorship', d)).toBeUndefined()
    expect(eventHit(db, 'ccpa_revenue', d)).toBeUndefined()
    expect(eventHit(db, 'credit_check', d)).toBeUndefined()
  })

  it('estimates the first payroll from the first paid W-2 start, leaving out unpaid owners', () => {
    const db = makeDB('2026-01-01')
    // Only an unpaid founder: no payroll yet.
    expect(eventHit(db, 'first_payroll', '2026-10-10')).toBeUndefined()
    // A $0 founder record still is not pay.
    db.comp.push({ id: 'cr-f0', personId: 'p-founder', effectiveOn: '2026-01-01', payType: 'salary', salary: 0, title: 'CEO', levelId: 'lv-l3', reason: 'hire' })
    expect(eventHit(db, 'first_payroll', '2026-10-10')).toBeUndefined()
    // The first employee is paid from their start, whatever the pay field says.
    addPerson(db, { id: 'p-first', firstName: 'Sam', lastName: 'Rivera', startDate: '2026-11-02' })
    const hit = eventHit(db, 'first_payroll', '2026-10-10')
    expect(hit).toMatchObject({ date: '2026-11-02', personId: 'p-first', estimated: true })
    expect(hit?.text).toBe(
      'Estimated from the first paid W-2 start on record: Sam Rivera on Nov 2, 2026. Owners with no pay recorded are left out. Add the first payroll date in Settings for an exact date.',
    )
    // A founder salary that starts in March is the first payroll.
    db.comp.push({ id: 'cr-f1', personId: 'p-founder', effectiveOn: '2026-03-02', payType: 'salary', salary: 120000, title: 'CEO', levelId: 'lv-l3', reason: 'merit' })
    expect(eventHit(db, 'first_payroll', '2026-10-10')).toMatchObject({ date: '2026-03-02', personId: 'p-founder', estimated: true })
    // A recorded date is a fact, not an estimate.
    db.company.firstPayrollOn = '2026-03-13'
    const recorded = eventHit(db, 'first_payroll', '2026-10-10')
    expect(recorded).toMatchObject({ date: '2026-03-13' })
    expect(recorded?.estimated).toBeUndefined()
  })

  it('dates the first paid employee: a first hire, or the day an owner starts being paid', () => {
    const db = makeDB('2026-01-01')
    // An unpaid founder alone has never been a paid employee.
    expect(firstPaidEmployeeOn(db)).toBeUndefined()
    addPerson(db, { id: 'p-gone', startDate: '2026-04-06', endDate: '2026-05-29' })
    addPerson(db, { id: 'p-first', startDate: '2026-11-02' })
    // A hire who has left still counts from the day they started; `through` stops before later dates.
    expect(firstPaidEmployeeOn(db)).toBe('2026-04-06')
    expect(firstPaidEmployeeOn(db, '2026-04-05')).toBeUndefined()
    db.people = db.people.filter((p) => p.id !== 'p-gone')
    expect(firstPaidEmployeeOn(db, '2026-10-11')).toBeUndefined()
    expect(firstPaidEmployeeOn(db, '2026-11-02')).toBe('2026-11-02')
    // A founder salary from Mar 2 comes first.
    db.comp.push({ id: 'cr-f1', personId: 'p-founder', effectiveOn: '2026-03-02', payType: 'salary', salary: 120000, title: 'CEO', levelId: 'lv-l3', reason: 'merit' })
    expect(firstPaidEmployeeOn(db)).toBe('2026-03-02')
  })

  it('uses the 25102(o) first issuance date, revenue and job credit checks when present', () => {
    const db = makeDB()
    db.equity.firstIssuanceOn = '2025-05-28'
    db.company.annualRevenue = 30_000_000
    db.jobs.push({
      id: 'j-ctrl',
      title: 'Controller',
      departmentId: 'd-fin',
      familyId: 'f-fin',
      levelId: 'lv-m1',
      hiringManagerId: 'p-founder',
      panelIds: [],
      locationIds: ['loc-hq'],
      workMode: 'hybrid',
      employmentType: 'full_time',
      flsa: 'exempt',
      payMin: 180000,
      payMax: 205000,
      status: 'open',
      openedOn: '2026-09-01',
      stages: [],
      interviewPlan: [],
      description: '',
      sponsorship: 'no',
      backgroundCheck: true,
      creditCheckBasis: 'Signatory on company bank accounts',
      priority: 'normal',
    })
    expect(eventHit(db, 'first_option_grant', '2026-10-09')?.date).toBe('2025-05-28')
    expect(eventHit(db, 'ccpa_revenue', '2026-10-09')?.date).toBe('2026-10-09')
    expect(eventHit(db, 'credit_check', '2026-10-09')?.date).toBe('2026-09-01')
  })

  it('dates a promotion to supervisor from comp history', () => {
    const db = makeDB()
    addPerson(db, { id: 'p-lead', startDate: '2025-02-03' })
    addPerson(db, { id: 'p-ic', startDate: '2025-03-03', managerId: 'p-lead' })
    db.comp.push(
      { id: 'cr1', personId: 'p-ic', effectiveOn: '2025-03-03', payType: 'salary', salary: 1, title: 'Eng', levelId: 'lv-l3', managerId: 'p-founder', reason: 'hire' },
      { id: 'cr2', personId: 'p-ic', effectiveOn: '2025-09-01', payType: 'salary', salary: 1, title: 'Eng', levelId: 'lv-l3', managerId: 'p-lead', reason: 'manager_change' },
    )
    expect(supervisorSince(db, 'p-lead')).toBe('2025-09-01')
    expect(eventHit(db, 'first_non_founder_manager', '2025-10-01')?.date).toBe('2025-09-01')
  })

  it('finds a visa sponsorship from an accepted offer', () => {
    const db = makeDB()
    addOffer(db, { id: 'o-h1b', startDate: '2026-11-02', status: 'accepted', decidedOn: '2026-10-07' }, { sponsorship: 'yes' })
    expect(eventHit(db, 'first_visa_sponsorship', '2026-10-09')?.date).toBe('2026-10-07')
  })
})
