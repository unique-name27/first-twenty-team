// Tiny fixture builders for compliance and training tests (not used by the app). Start from
// blankDB() and add rows; ledgerlarkLite() mirrors the sample roster's dates (docs/SAMPLE.md).
import { blankDB } from '@/data/blank'
import type { Candidate, Contractor, DB, Offer, Person } from '@/domain/types'

export function makeDB(foundedOn = '2025-01-06'): DB {
  const db = blankDB({ companyName: 'Testco', founderFirstName: 'Fay', founderLastName: 'Founder', foundedOn })
  db.locations.push({ id: 'loc-remote-tx', name: 'Remote (Texas)', kind: 'remote', state: 'TX', minWageHourly: 7.25 })
  return db
}

export function addPerson(db: DB, p: Partial<Person> & { id: string; startDate: string }): Person {
  const person: Person = {
    firstName: p.id.replace(/^p-/, ''),
    lastName: 'Test',
    workEmail: `${p.id}@test.dev`,
    title: 'Engineer',
    departmentId: 'd-eng',
    familyId: 'f-swe',
    levelId: 'lv-l3',
    managerId: 'p-founder',
    locationId: 'loc-hq',
    workMode: 'hybrid',
    homeCity: 'San Jose',
    homeState: 'CA',
    employmentType: 'full_time',
    hoursPerWeek: 40,
    flsa: 'exempt',
    hireNumber: db.people.length + 1,
    emergencyContacts: [],
    ...p,
  }
  db.people.push(person)
  return person
}

/** Adds n plain employees starting on the same date. */
export function addMany(db: DB, n: number, startDate: string, prefix = 'p-x'): Person[] {
  const out: Person[] = []
  for (let i = 0; i < n; i++) out.push(addPerson(db, { id: `${prefix}${db.people.length + 1}`, startDate }))
  return out
}

export function addContractor(db: DB, c: Partial<Contractor> & { id: string; startOn: string }): Contractor {
  const row: Contractor = {
    kind: 'contractor',
    name: c.id,
    entityType: 'individual',
    email: `${c.id}@test.dev`,
    scope: 'Work',
    rate: 5000,
    rateUnit: 'month',
    managerId: 'p-founder',
    departmentId: 'd-eng',
    state: 'CA',
    ab5: { exemption: 'none', a: true, b: true, c: true },
    w9OnFile: true,
    ...c,
  }
  db.contractors.push(row)
  return row
}

export function addOffer(
  db: DB,
  o: Partial<Offer> & { id: string; startDate: string; status: Offer['status'] },
  cand: Partial<Candidate> = {},
): Offer {
  const candidateId = o.candidateId ?? `c-${o.id}`
  if (!db.candidates.some((c) => c.id === candidateId)) {
    db.candidates.push({
      id: candidateId,
      firstName: 'Cand',
      lastName: o.id,
      email: `${o.id}@cand.dev`,
      links: {},
      source: 'inbound',
      sponsorship: 'no',
      tags: [],
      createdOn: '2026-01-01',
      ...cand,
    })
  }
  const offer: Offer = {
    applicationId: `a-${o.id}`,
    candidateId,
    jobId: 'j-1',
    version: 1,
    title: 'Engineer',
    levelId: 'lv-l3',
    familyId: 'f-swe',
    departmentId: 'd-eng',
    managerId: 'p-founder',
    locationId: 'loc-hq',
    workMode: 'hybrid',
    employmentType: 'full_time',
    flsa: 'exempt',
    payType: 'salary',
    salary: 150000,
    equityType: 'ISO',
    equityShares: 10000,
    vestingMonths: 48,
    cliffMonths: 12,
    expiresOn: '2026-12-31',
    contingencies: [],
    createdOn: '2026-01-01',
    approvals: [],
    ...o,
  }
  db.offers.push(offer)
  return offer
}

/** The sample roster's dates (fictional Ledgerlark), enough for milestone and training stories. */
export function ledgerlarkLite(): DB {
  const db = blankDB({ companyName: 'Ledgerlark', founderFirstName: 'Maya', founderLastName: 'Raman', foundedOn: '2025-02-03' })
  db.locations.push({ id: 'loc-remote-tx', name: 'Remote (Texas)', kind: 'remote', state: 'TX', minWageHourly: 7.25 })
  const hq = db.locations.find((l) => l.id === 'loc-hq') as DB['locations'][number]
  hq.typicalMaxOnSite = 11
  db.company.soc2Enabled = true
  const add = (id: string, firstName: string, lastName: string, startDate: string, extra: Partial<Person> = {}) =>
    addPerson(db, { id, firstName, lastName, startDate, ...extra })
  add('p-tomas', 'Tomas', 'Herrera', '2025-05-12')
  add('p-priya', 'Priya', 'Nair', '2025-06-09', { homeCity: 'Sunnyvale' })
  add('p-elena', 'Elena', 'Vasquez', '2025-08-18', { homeCity: 'Campbell' })
  add('p-kofi', 'Kofi', 'Boateng', '2025-10-06', { managerId: 'p-tomas' })
  add('p-sofia', 'Sofia', 'Rossi', '2026-01-12', { workMode: 'remote', locationId: 'loc-remote-ca', homeCity: 'Oakland' })
  add('p-caleb', 'Caleb', 'Washington', '2026-03-02', { workMode: 'remote', locationId: 'loc-remote-tx', homeCity: 'Austin', homeState: 'TX' })
  add('p-hannah', 'Hannah', 'Kim', '2026-03-16', { managerId: 'p-priya', homeCity: 'Santa Clara' })
  add('p-nikhil', 'Nikhil', 'Rao', '2026-04-13', { managerId: 'p-tomas', homeCity: 'Fremont' })
  add('p-omar', 'Omar', 'Haddad', '2026-05-04', { managerId: 'p-tomas', endDate: '2026-08-28' })
  add('p-jasmine', 'Jasmine', 'Torres', '2026-06-01')
  add('p-chris', 'Chris', 'Nakamura', '2026-07-13', { managerId: 'p-elena', homeCity: 'Milpitas' })
  add('p-luis', 'Luis', 'Ortega', '2026-07-20', {
    managerId: 'p-jasmine',
    employmentType: 'part_time',
    hoursPerWeek: 24,
    flsa: 'non_exempt',
    workMode: 'onsite',
  })
  add('p-ravi', 'Ravi', 'Subramanian', '2026-08-10', { managerId: 'p-tomas', homeCity: 'Cupertino' })
  add('p-aisha', 'Aisha', 'Bello', '2026-09-08')
  add('p-lucas', 'Lucas', 'Ferreira', '2026-10-19', { managerId: 'p-tomas' })
  add('p-mei', 'Mei', 'Tanaka', '2026-11-02', { managerId: 'p-priya' })
  addContractor(db, { id: 'k-northline', name: 'Dana Whitaker', entityName: 'Northline Finance Partners LLC', entityType: 'llc', startOn: '2025-06-01', rate: 6500, rateUnit: 'month', hoursPerWeek: 8 })
  addContractor(db, { id: 'k-marisol', name: 'Marisol Vega', startOn: '2026-04-01', rate: 85, rateUnit: 'hour', hoursPerWeek: 25 })
  addContractor(db, { id: 'k-fieldnote', name: 'Studio Fieldnote', entityName: 'Studio Fieldnote', entityType: 'corporation', startOn: '2025-11-01', endOn: '2026-02-28', rate: 38000, rateUnit: 'project' })
  addContractor(db, { id: 'k-adv-whitfield', kind: 'advisor', name: 'Carol Whitfield', startOn: '2025-07-01', rate: 0 })
  addContractor(db, { id: 'k-adv-osei', kind: 'advisor', name: 'Daniel Osei', startOn: '2026-04-01', rate: 0 })
  return db
}
