// Tiny fixture workspace for the hiring tests (not used by the app). Built from blankDB plus a few
// hand-made rows, with fixed dates around Friday 2026-10-09.
import { blankDB } from '@/data/blank'
import { SAMPLE_ROLE_TEMPLATES } from '@/data/roleTemplates'
import type { Application, Candidate, DB, Job, Person } from '@/domain/types'
import { jobStages } from './pipeline'

export const FRI = '2026-10-09'

export function person(id: string, firstName: string, lastName: string, extra: Partial<Person> = {}): Person {
  return {
    id,
    firstName,
    lastName,
    workEmail: `${firstName.toLowerCase()}@ledgerlark.com`,
    title: 'Engineer',
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
    startDate: '2025-06-01',
    hireNumber: 2,
    emergencyContacts: [],
    ...extra,
  }
}

export function candidate(id: string, firstName: string, lastName: string, extra: Partial<Candidate> = {}): Candidate {
  return {
    id,
    firstName,
    lastName,
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`,
    links: {},
    source: 'inbound',
    sponsorship: 'no',
    tags: [],
    createdOn: '2026-09-20',
    ...extra,
  }
}

export function application(id: string, candidateId: string, jobId: string, extra: Partial<Application> = {}): Application {
  const stageId = extra.stageId ?? 'new'
  const at = extra.stageEnteredOn ?? '2026-09-21'
  return {
    id,
    candidateId,
    jobId,
    stageId,
    status: 'active',
    appliedOn: '2026-09-21',
    stageEnteredOn: at,
    history: [{ stageId: 'new', at: '2026-09-21' }, ...(stageId !== 'new' ? [{ stageId, at }] : [])],
    nextStep: { text: 'Review application', dueOn: '2026-10-20', ownerId: 'p-tomas' },
    ...extra,
  }
}

export function fixtureDB(): DB {
  const db = blankDB({ companyName: 'Ledgerlark', founderFirstName: 'Maya', founderLastName: 'Raman', foundedOn: '2025-02-03' })
  // The sample company's own role templates, as the sample seed installs them (blankDB has the neutral starters).
  db.settings.roleTemplates = structuredClone(SAMPLE_ROLE_TEMPLATES)
  db.company.tagline = 'Ledgerlark builds AI agents that help mid-market controllers close the books faster.'
  db.company.hq = { street: '99 S Almaden Blvd', suite: 'Suite 410', city: 'San Jose', state: 'CA', zip: '95113' }
  db.company.workersCompCarrier = { name: 'Golden Poppy Mutual', phone: '(800) 555-0199', policyNumber: 'WC-2026-118', address: '1 Market St, San Francisco, CA 94105' }
  db.company.phone = '(408) 555-0100'
  db.company.soc2Enabled = true
  db.equity.fullyDilutedShares = 12_000_000
  db.equity.capTableConfirmedOn = '2026-02-24'
  db.equity.valuations = [
    { id: 'v-1', effectiveOn: '2025-05-01', fmvPerShare: 0.25, provider: 'Meridian Valuation Group', expiresOn: '2026-05-01' },
    { id: 'v-2', effectiveOn: '2026-03-20', fmvPerShare: 1.15, provider: 'Meridian Valuation Group', expiresOn: '2027-03-20' },
  ]
  db.people.push(
    person('p-tomas', 'Tomas', 'Herrera', { title: 'Founding engineer', levelId: 'lv-l4', hireNumber: 2, startDate: '2025-05-12' }),
    person('p-priya', 'Priya', 'Nair', { title: 'Founding ML engineer', familyId: 'f-ml', levelId: 'lv-l4', hireNumber: 3, startDate: '2025-06-09' }),
    person('p-jasmine', 'Jasmine', 'Torres', {
      title: 'Finance and people operations lead',
      familyId: 'f-ops',
      departmentId: 'd-ops',
      hireNumber: 4,
      startDate: '2026-06-01',
    }),
  )
  const template = db.settings.roleTemplates.find((t) => t.id === 'rt-fullstack')
  const job: Job = {
    id: 'j-fullstack',
    title: 'Senior full-stack engineer',
    departmentId: 'd-eng',
    familyId: 'f-eng',
    levelId: 'lv-l3',
    hiringManagerId: 'p-tomas',
    panelIds: ['p-tomas', 'p-priya'],
    locationIds: ['loc-hq'],
    workMode: 'hybrid',
    employmentType: 'full_time',
    flsa: 'exempt',
    payMin: 180_000,
    payMax: 235_000,
    status: 'open',
    openedOn: '2026-09-14',
    postedOn: '2026-09-15',
    stages: jobStages({ stages: template?.stages ?? [] }).map((s) => ({ ...s })),
    interviewPlan: (template?.interviewPlan ?? []).map((s) => ({ ...s, interviewerIds: ['p-tomas'] })),
    description: template?.jdOutline ?? '',
    sponsorship: 'case_by_case',
    backgroundCheck: true,
    priority: 'high',
  }
  db.jobs.push(job)
  db.candidates.push(
    candidate('c-alex', 'Alex', 'Kim', { desiredPay: 187_400, timezone: 'America/New_York' }),
    candidate('c-ben', 'Ben', 'Ortiz', { source: 'referral', referrerId: 'p-priya' }),
    candidate('c-chen', 'Chen', 'Wu', { source: 'outbound' }),
  )
  db.applications.push(
    application('a-alex', 'c-alex', 'j-fullstack', { stageId: 'onsite', stageEnteredOn: '2026-10-05' }),
    application('a-ben', 'c-ben', 'j-fullstack', { stageId: 'intro', stageEnteredOn: '2026-10-01' }),
    application('a-chen', 'c-chen', 'j-fullstack'),
  )
  return db
}
