// Ledgerlark sample: employees 1-15 (docs/SAMPLE.md) with job and pay history, onboarding checklists,
// trainings, policies and acknowledgements, documents (status and date only) and Omar's exit.
// People are added in hire order and each checklist is generated right after its person, so headcount,
// supervisor status and thresholds are what they were on that date. Hires 16 and 17 (Lucas, Mei) come
// later through the real Hire flow in ./hiring. Functions only (see ./company for why).
//
// Legal notes (docs/LAW.md): computer professionals are paid above the 2026 Labor Code 515.5 minimum
// ($122,573.13, w-software-exempt-2026); Luis is non-exempt hourly above San Jose's $18.45 and gets the
// Labor Code 2810.5 notice; SB 294 notices apply to hires from Jan 1, 2026 (a-sb294-1); harassment training
// applies to California staff once employees plus contractors reach 5 (a-shpt-5), here on 2025-08-18.
import type { Draft } from 'immer'
import { generateChecklist, holidayDates, onOrAfterBusinessDay } from '@/domain/checklists/generate'
import { startOffboarding } from '@/domain/lifecycle'
import { fullName, headcountOn } from '@/domain/people'
import type {
  Acknowledgment,
  Checklist,
  ChecklistTask,
  CompRecord,
  DB,
  DocumentRecord,
  EmergencyContact,
  EmploymentType,
  ExemptionBasis,
  FLSA,
  ID,
  Person,
  Training,
  WorkMode,
} from '@/domain/types'
import { addBusinessDays, addDays, fmtDay, type ISODate } from '@/lib/dates'
import { adminOn, itOn, restampActivity, seedLog, seedToday } from './company'
import { contractorRows } from './contractors'
import { boardApprovalFor, hasGrant, sampleGrants } from './equity'

type PersonSpec = {
  id: ID
  key: string
  first: string
  last: string
  title: string
  levelId: ID
  familyId: ID
  departmentId: ID
  managerId: ID | null
  locationId: ID
  workMode: WorkMode
  homeCity: string
  homeState: string
  employmentType: EmploymentType
  hoursPerWeek: number
  flsa: FLSA
  exemptionBasis?: ExemptionBasis
  startDate: ISODate
  hireNumber: number
  isFounder?: boolean
  candidateId?: ID
  /** Offer accepted (matches the hire records in ./hiring/catalog.ts). */
  offerAcceptedOn: ISODate
  /**
   * Background check cleared (status only), 3 to 6 business days after the offer was accepted (Fair Chance Act:
   * never before the conditional offer). Every hire from Kofi on; the three founding hires had none. The hiring
   * seed copies these dates onto the accepted offers (./hiring/build.ts).
   */
  backgroundClearOn?: ISODate
  contacts: EmergencyContact[]
  bio: string
  pay: { salary?: number; hourlyRate?: number; variablePct?: number; exceptionReason?: string; effectiveOn?: ISODate; note?: string }
  /** Salary from the 2026-03-01 post-seed market adjustment. */
  market?: number
}

function specs(): PersonSpec[] {
  const founding = 'Founding hire before the seed: below band, equity-heavy offer'
  return [
    {
      id: 'p-founder',
      key: 'maya',
      first: 'Maya',
      last: 'Raman',
      title: 'Founder and CEO',
      levelId: 'lv-x1',
      familyId: 'f-exec',
      departmentId: 'd-exec',
      managerId: null,
      locationId: 'loc-hq',
      workMode: 'hybrid',
      homeCity: 'San Jose',
      homeState: 'CA',
      employmentType: 'full_time',
      hoursPerWeek: 40,
      flsa: 'exempt',
      exemptionBasis: 'executive',
      startDate: '2025-02-03',
      hireNumber: 1,
      isFounder: true,
      offerAcceptedOn: '2025-04-21',
      contacts: [{ name: 'Arun Raman', relation: 'Sibling', phone: '(408) 555-0101' }],
      bio: 'Founder. Formerly an ML lead on a small-business accounting product and, before that, a Big Four audit senior.',
      pay: {
        salary: 120_000,
        effectiveOn: '2025-05-01',
        exceptionReason: 'Founder salary held low until the seed',
        note: 'Founder salary starts with the first payroll after the pre-seed closed.',
      },
      market: 175_000,
    },
    {
      id: 'p-tomas',
      key: 'tomas',
      first: 'Tomas',
      last: 'Herrera',
      title: 'Founding engineer',
      levelId: 'lv-l4',
      familyId: 'f-eng',
      departmentId: 'd-eng',
      managerId: 'p-founder',
      locationId: 'loc-hq',
      workMode: 'hybrid',
      homeCity: 'San Jose',
      homeState: 'CA',
      employmentType: 'full_time',
      hoursPerWeek: 40,
      flsa: 'exempt',
      exemptionBasis: 'computer_professional',
      startDate: '2025-05-12',
      hireNumber: 2,
      candidateId: 'c-hire-tomas',
      offerAcceptedOn: '2025-04-18',
      contacts: [{ name: 'Lucia Herrera', relation: 'Partner', phone: '(408) 555-0102', sb294Notify: true }],
      bio: 'Founding engineer. Built the ledger sync and the agent runtime. Worked with Maya on her previous team.',
      pay: { salary: 185_000, exceptionReason: founding },
      market: 212_000,
    },
    {
      id: 'p-priya',
      key: 'priya',
      first: 'Priya',
      last: 'Nair',
      title: 'Founding ML engineer',
      levelId: 'lv-l4',
      familyId: 'f-ml',
      departmentId: 'd-ai',
      managerId: 'p-founder',
      locationId: 'loc-hq',
      workMode: 'hybrid',
      homeCity: 'Sunnyvale',
      homeState: 'CA',
      employmentType: 'full_time',
      hoursPerWeek: 40,
      flsa: 'exempt',
      exemptionBasis: 'computer_professional',
      startDate: '2025-06-09',
      hireNumber: 3,
      candidateId: 'c-hire-priya',
      offerAcceptedOn: '2025-05-16',
      contacts: [{ name: 'Meera Nair', relation: 'Parent', phone: '(650) 555-0103' }],
      bio: 'Founding ML engineer. Leads the reconciliation matching and flux models.',
      pay: { salary: 195_000, exceptionReason: founding },
      market: 228_000,
    },
    {
      id: 'p-elena',
      key: 'elena',
      first: 'Elena',
      last: 'Vasquez',
      title: 'Head of accounting (CPA)',
      levelId: 'lv-m1',
      familyId: 'f-acct',
      departmentId: 'd-acct',
      managerId: 'p-founder',
      locationId: 'loc-hq',
      workMode: 'hybrid',
      homeCity: 'Campbell',
      homeState: 'CA',
      employmentType: 'full_time',
      hoursPerWeek: 40,
      flsa: 'exempt',
      exemptionBasis: 'professional',
      startDate: '2025-08-18',
      hireNumber: 4,
      candidateId: 'c-hire-elena',
      offerAcceptedOn: '2025-07-18',
      contacts: [{ name: 'Diego Vasquez', relation: 'Partner', phone: '(408) 555-0104' }],
      bio: 'CPA. Former Big Four audit manager, then a controller. Owns accounting quality for the close agents.',
      pay: { salary: 182_000, exceptionReason: founding },
      market: 200_000,
    },
    {
      id: 'p-kofi',
      key: 'kofi',
      first: 'Kofi',
      last: 'Boateng',
      title: 'Senior software engineer',
      levelId: 'lv-l3',
      familyId: 'f-eng',
      departmentId: 'd-eng',
      managerId: 'p-tomas',
      locationId: 'loc-hq',
      workMode: 'hybrid',
      homeCity: 'San Jose',
      homeState: 'CA',
      employmentType: 'full_time',
      hoursPerWeek: 40,
      flsa: 'exempt',
      exemptionBasis: 'computer_professional',
      startDate: '2025-10-06',
      hireNumber: 5,
      candidateId: 'c-hire-kofi',
      offerAcceptedOn: '2025-09-05',
      backgroundClearOn: '2025-09-15',
      contacts: [{ name: 'Ama Boateng', relation: 'Sibling', phone: '(408) 555-0105', sb294Notify: true }],
      bio: 'Senior engineer on the ERP integrations (NetSuite, Sage Intacct, QuickBooks Online).',
      pay: { salary: 178_000, exceptionReason: 'Pre-seed offer: below band, equity-heavy' },
      market: 192_000,
    },
    {
      id: 'p-sofia',
      key: 'sofia',
      first: 'Sofia',
      last: 'Rossi',
      title: 'Product designer',
      levelId: 'lv-l3',
      familyId: 'f-design',
      departmentId: 'd-product',
      managerId: 'p-founder',
      locationId: 'loc-remote-ca',
      workMode: 'remote',
      homeCity: 'Oakland',
      homeState: 'CA',
      employmentType: 'full_time',
      hoursPerWeek: 40,
      flsa: 'exempt',
      exemptionBasis: 'computer_professional',
      startDate: '2026-01-12',
      hireNumber: 6,
      candidateId: 'c-hire-sofia',
      offerAcceptedOn: '2025-11-24',
      backgroundClearOn: '2025-12-04',
      contacts: [{ name: 'Giulia Rossi', relation: 'Sibling', phone: '(510) 555-0106' }],
      bio: 'Product designer for the close workspace and the review flows.',
      pay: { salary: 172_000 },
    },
    {
      id: 'p-caleb',
      key: 'caleb',
      first: 'Caleb',
      last: 'Washington',
      title: 'Founding account executive',
      levelId: 'lv-l3',
      familyId: 'f-gtm',
      departmentId: 'd-gtm',
      managerId: 'p-founder',
      locationId: 'loc-remote-tx',
      workMode: 'remote',
      homeCity: 'Austin',
      homeState: 'TX',
      employmentType: 'full_time',
      hoursPerWeek: 40,
      flsa: 'exempt',
      exemptionBasis: 'administrative',
      startDate: '2026-03-02',
      hireNumber: 7,
      candidateId: 'c-hire-caleb',
      offerAcceptedOn: '2026-02-06',
      backgroundClearOn: '2026-02-11',
      contacts: [{ name: 'Denise Washington', relation: 'Parent', phone: '(512) 555-0107' }],
      bio: 'Founding account executive for mid-market controllers.',
      pay: { salary: 140_000, variablePct: 1.0 },
    },
    {
      id: 'p-hannah',
      key: 'hannah',
      first: 'Hannah',
      last: 'Kim',
      title: 'Applied AI engineer (evals)',
      levelId: 'lv-l3',
      familyId: 'f-ml',
      departmentId: 'd-ai',
      managerId: 'p-priya',
      locationId: 'loc-hq',
      workMode: 'hybrid',
      homeCity: 'Santa Clara',
      homeState: 'CA',
      employmentType: 'full_time',
      hoursPerWeek: 40,
      flsa: 'exempt',
      exemptionBasis: 'computer_professional',
      startDate: '2026-03-16',
      hireNumber: 8,
      candidateId: 'c-hire-hannah',
      offerAcceptedOn: '2026-02-17',
      backgroundClearOn: '2026-02-24',
      contacts: [{ name: 'Grace Kim', relation: 'Parent', phone: '(408) 555-0108', sb294Notify: true }],
      bio: 'Applied AI engineer focused on evals for the close agents.',
      pay: { salary: 205_000 },
    },
    {
      id: 'p-nikhil',
      key: 'nikhil',
      first: 'Nikhil',
      last: 'Rao',
      title: 'Security and compliance engineer',
      levelId: 'lv-l3',
      familyId: 'f-eng',
      departmentId: 'd-eng',
      managerId: 'p-tomas',
      locationId: 'loc-hq',
      workMode: 'hybrid',
      homeCity: 'Fremont',
      homeState: 'CA',
      employmentType: 'full_time',
      hoursPerWeek: 40,
      flsa: 'exempt',
      exemptionBasis: 'computer_professional',
      startDate: '2026-04-13',
      hireNumber: 9,
      candidateId: 'c-hire-nikhil',
      offerAcceptedOn: '2026-03-16',
      backgroundClearOn: '2026-03-23',
      contacts: [{ name: 'Anjali Rao', relation: 'Partner', phone: '(510) 555-0109' }],
      bio: 'Security and compliance engineer. Owns SOC 2.',
      pay: { salary: 200_000 },
    },
    {
      id: 'p-omar',
      key: 'omar',
      first: 'Omar',
      last: 'Haddad',
      title: 'Data engineer',
      levelId: 'lv-l3',
      familyId: 'f-eng',
      departmentId: 'd-eng',
      managerId: 'p-tomas',
      locationId: 'loc-hq',
      workMode: 'hybrid',
      homeCity: 'San Jose',
      homeState: 'CA',
      employmentType: 'full_time',
      hoursPerWeek: 40,
      flsa: 'exempt',
      exemptionBasis: 'computer_professional',
      startDate: '2026-05-04',
      hireNumber: 10,
      candidateId: 'c-hire-omar',
      offerAcceptedOn: '2026-04-02',
      backgroundClearOn: '2026-04-09',
      contacts: [{ name: 'Layla Haddad', relation: 'Sibling', phone: '(408) 555-0111' }],
      bio: 'Data engineer on the ERP connectors.',
      pay: { salary: 188_000 },
    },
    {
      id: 'p-jasmine',
      key: 'jasmine',
      first: 'Jasmine',
      last: 'Torres',
      title: 'Finance and people operations lead',
      levelId: 'lv-l3',
      familyId: 'f-ops',
      departmentId: 'd-ops',
      managerId: 'p-founder',
      locationId: 'loc-hq',
      workMode: 'hybrid',
      homeCity: 'San Jose',
      homeState: 'CA',
      employmentType: 'full_time',
      hoursPerWeek: 40,
      flsa: 'exempt',
      exemptionBasis: 'administrative',
      startDate: '2026-06-01',
      hireNumber: 11,
      candidateId: 'c-hire-jasmine',
      offerAcceptedOn: '2026-05-07',
      backgroundClearOn: '2026-05-13',
      contacts: [{ name: 'Marisa Torres', relation: 'Parent', phone: '(408) 555-0112' }],
      bio: 'Runs finance and people operations day to day, including payroll with the PEO.',
      pay: { salary: 150_000 },
    },
    {
      id: 'p-chris',
      key: 'chris',
      first: 'Chris',
      last: 'Nakamura',
      title: 'Solutions engineer',
      levelId: 'lv-l3',
      familyId: 'f-solutions',
      departmentId: 'd-acct',
      managerId: 'p-elena',
      locationId: 'loc-hq',
      workMode: 'hybrid',
      homeCity: 'Milpitas',
      homeState: 'CA',
      employmentType: 'full_time',
      hoursPerWeek: 40,
      flsa: 'exempt',
      exemptionBasis: 'administrative',
      startDate: '2026-07-13',
      hireNumber: 12,
      candidateId: 'c-hire-chris',
      offerAcceptedOn: '2026-06-11',
      backgroundClearOn: '2026-06-22',
      contacts: [{ name: 'Kenji Nakamura', relation: 'Parent', phone: '(408) 555-0113', sb294Notify: true }],
      bio: 'Solutions engineer. Former Big Four advisory. Leads customer implementations.',
      pay: { salary: 168_000, variablePct: 0.15 },
    },
    {
      id: 'p-luis',
      key: 'luis',
      first: 'Luis',
      last: 'Ortega',
      title: 'Office and events coordinator',
      levelId: 'lv-l1',
      familyId: 'f-ops',
      departmentId: 'd-ops',
      managerId: 'p-jasmine',
      locationId: 'loc-hq',
      workMode: 'onsite',
      homeCity: 'San Jose',
      homeState: 'CA',
      employmentType: 'part_time',
      hoursPerWeek: 24,
      flsa: 'non_exempt',
      startDate: '2026-07-20',
      hireNumber: 13,
      candidateId: 'c-hire-luis',
      offerAcceptedOn: '2026-07-02',
      backgroundClearOn: '2026-07-10',
      contacts: [{ name: 'Rosa Ortega', relation: 'Parent', phone: '(408) 555-0114', sb294Notify: true }],
      bio: 'Keeps the San Jose office running on team days and plans events.',
      pay: { hourlyRate: 30 },
    },
    {
      id: 'p-ravi',
      key: 'ravi',
      first: 'Ravi',
      last: 'Subramanian',
      title: 'Staff software engineer',
      levelId: 'lv-l4',
      familyId: 'f-eng',
      departmentId: 'd-eng',
      managerId: 'p-tomas',
      locationId: 'loc-hq',
      workMode: 'hybrid',
      homeCity: 'Cupertino',
      homeState: 'CA',
      employmentType: 'full_time',
      hoursPerWeek: 40,
      flsa: 'exempt',
      exemptionBasis: 'computer_professional',
      startDate: '2026-08-10',
      hireNumber: 14,
      candidateId: 'c-hire-ravi',
      offerAcceptedOn: '2026-07-09',
      backgroundClearOn: '2026-07-15',
      contacts: [{ name: 'Deepa Subramanian', relation: 'Partner', phone: '(669) 555-0115' }],
      bio: 'Staff engineer on the agent platform.',
      pay: { salary: 235_000 },
    },
    {
      id: 'p-aisha',
      key: 'aisha',
      first: 'Aisha',
      last: 'Bello',
      title: 'Customer success manager (CPA)',
      levelId: 'lv-l2',
      familyId: 'f-gtm',
      departmentId: 'd-gtm',
      managerId: 'p-founder',
      locationId: 'loc-hq',
      workMode: 'hybrid',
      homeCity: 'San Jose',
      homeState: 'CA',
      employmentType: 'full_time',
      hoursPerWeek: 40,
      flsa: 'exempt',
      exemptionBasis: 'administrative',
      startDate: '2026-09-08',
      hireNumber: 15,
      candidateId: 'c-hire-aisha',
      offerAcceptedOn: '2026-08-12',
      backgroundClearOn: '2026-08-20',
      contacts: [{ name: 'Tunde Bello', relation: 'Sibling', phone: '(408) 555-0116', sb294Notify: true }],
      bio: 'CPA. Customer success for controllers after go-live.',
      pay: { salary: 140_000, variablePct: 0.1 },
    },
  ]
}

// ---------------------------------------------------------------------------------------------
// Trainings (completion dates drive the onboarding tasks too)
// ---------------------------------------------------------------------------------------------

type TrainingSpec = [key: string, personId: ID, kind: Training['kind'], dueOn: ISODate, completedOn?: ISODate]

/**
 * Harassment prevention (a-shpt-5): employees plus contractors reached 5 on 2025-08-18 (Elena's start, with
 * Northline), so staff on board then were due 2026-02-18; later hires 6 months after start; supervisors take
 * the 2-hour course. Caleb works in Texas (not required by law), but company policy assigns it; his is open.
 * Security awareness (SOC 2 company policy): within 30 days of start, then a company-wide refresher in May 2026
 * for everyone trained in 2025.
 */
function trainingSpecs(): TrainingSpec[] {
  return [
    ['maya-har', 'p-founder', 'harassment_supervisor', '2026-02-18', '2025-11-18'],
    ['tomas-har', 'p-tomas', 'harassment_supervisor', '2026-04-06', '2025-11-12'],
    ['priya-har-1', 'p-priya', 'harassment_employee', '2026-02-18', '2025-12-10'],
    ['priya-har-2', 'p-priya', 'harassment_supervisor', '2026-09-16', '2026-03-25'],
    ['elena-har', 'p-elena', 'harassment_supervisor', '2026-02-18', '2025-10-15'],
    ['kofi-har', 'p-kofi', 'harassment_employee', '2026-04-06', '2025-11-03'],
    ['sofia-har', 'p-sofia', 'harassment_employee', '2026-07-12', '2026-02-10'],
    ['caleb-har', 'p-caleb', 'harassment_employee', '2026-09-02'],
    // Hannah (California) missed her 6-month deadline: a red, statutory overdue item on day one.
    ['hannah-har', 'p-hannah', 'harassment_employee', '2026-09-16'],
    ['nikhil-har', 'p-nikhil', 'harassment_employee', '2026-10-13', '2026-05-11'],
    ['omar-har', 'p-omar', 'harassment_employee', '2026-11-04', '2026-06-01'],
    ['jasmine-har', 'p-jasmine', 'harassment_supervisor', '2026-12-01', '2026-06-24'],
    ['chris-har', 'p-chris', 'harassment_employee', '2027-01-13', '2026-08-05'],
    ['luis-har', 'p-luis', 'harassment_employee', '2027-01-20', '2026-08-19'],
    ['maya-sec-1', 'p-founder', 'security_awareness', '2025-05-31', '2025-05-20'],
    ['maya-sec-2', 'p-founder', 'security_awareness', '2026-05-20', '2026-05-14'],
    ['tomas-sec-1', 'p-tomas', 'security_awareness', '2025-06-11', '2025-05-22'],
    ['tomas-sec-2', 'p-tomas', 'security_awareness', '2026-05-22', '2026-05-14'],
    ['priya-sec-1', 'p-priya', 'security_awareness', '2025-07-09', '2025-06-18'],
    ['priya-sec-2', 'p-priya', 'security_awareness', '2026-06-18', '2026-05-14'],
    ['elena-sec-1', 'p-elena', 'security_awareness', '2025-09-17', '2025-08-27'],
    ['elena-sec-2', 'p-elena', 'security_awareness', '2026-08-27', '2026-05-14'],
    ['kofi-sec-1', 'p-kofi', 'security_awareness', '2025-11-05', '2025-10-15'],
    ['kofi-sec-2', 'p-kofi', 'security_awareness', '2026-10-15', '2026-05-14'],
    ['sofia-sec', 'p-sofia', 'security_awareness', '2026-02-11', '2026-01-23'],
    ['caleb-sec', 'p-caleb', 'security_awareness', '2026-04-01', '2026-03-12'],
    ['hannah-sec', 'p-hannah', 'security_awareness', '2026-04-15', '2026-03-26'],
    ['nikhil-sec', 'p-nikhil', 'security_awareness', '2026-05-13', '2026-04-20'],
    ['omar-sec', 'p-omar', 'security_awareness', '2026-06-03', '2026-05-12'],
    ['jasmine-sec', 'p-jasmine', 'security_awareness', '2026-07-01', '2026-06-10'],
    ['chris-sec', 'p-chris', 'security_awareness', '2026-08-12', '2026-07-22'],
    ['luis-sec', 'p-luis', 'security_awareness', '2026-08-19', '2026-07-29'],
    ['ravi-sec', 'p-ravi', 'security_awareness', '2026-09-09', '2026-08-20'],
    ['aisha-sec', 'p-aisha', 'security_awareness', '2026-10-08'],
  ]
}

function trainingRows(): Training[] {
  return trainingSpecs().map(([key, personId, kind, dueOn, completedOn]) => {
    const harassment = kind === 'harassment_employee' || kind === 'harassment_supervisor'
    const t: Training = { id: `trn-${key}`, personId, kind, dueOn, provider: harassment ? 'CRD online course' : 'Company security awareness course' }
    if (completedOn) {
      t.completedOn = completedOn
      t.certificateLink = `https://example.com/training/certificates/${key}`
    }
    return t
  })
}

function firstCompletion(personId: ID, kinds: Training['kind'][]): ISODate | undefined {
  return trainingSpecs()
    .filter(([, pid, kind, , done]) => pid === personId && kinds.includes(kind) && !!done)
    .map(([, , , , done]) => done as ISODate)
    .sort()[0]
}

// ---------------------------------------------------------------------------------------------
// Policies and acknowledgements
// ---------------------------------------------------------------------------------------------

function updatePolicies(db: Draft<DB>): void {
  const handbook = db.policies.find((p) => p.id === 'pl-handbook')
  if (handbook) {
    handbook.version = '2.0'
    handbook.effectiveOn = '2026-09-15'
    handbook.summary =
      'Version 2.0: the hybrid office schedule, updated time off and leave (CFRA, bereavement, reproductive loss), the SB 294 workplace rights notice, pay practices for hourly staff, and the AI and customer data rules.'
    handbook.link = 'https://example.com/handbook'
  }
  // The written FEHA harassment policy (2 CCR 11023) was adopted ahead of the 5th employee.
  const harassment = db.policies.find((p) => p.id === 'pl-harassment')
  if (harassment) {
    harassment.effectiveOn = '2025-10-01'
    harassment.link = 'https://example.com/handbook/harassment'
  }
  // Ledgerlark adopted its first policies on May 1, 2025, and revised the security policy (2.1) for SOC 2.
  const aup = db.policies.find((p) => p.id === 'pl-aup')
  if (aup) {
    aup.version = '2.1'
    aup.effectiveOn = '2026-04-15'
    aup.summary = 'Device, password, MFA and customer financial data handling rules. A SOC 2 control.'
    aup.link = 'https://example.com/policies/security'
  }
  const piia = db.policies.find((p) => p.id === 'pl-confidentiality')
  if (piia) {
    piia.effectiveOn = '2025-05-01'
    piia.link = 'https://example.com/policies/piia'
  }
}

/** Handbook 2.0 is outstanding for these three (due 30 days after it took effect). */
function missingHandbook2(): ID[] {
  return ['p-ravi', 'p-aisha', 'p-caleb']
}

function acksFor(p: PersonSpec): Acknowledgment[] {
  const out: Acknowledgment[] = []
  const add = (policyId: ID, version: string, on: ISODate) =>
    out.push({ id: `ack-${p.key}-${policyId.slice(3)}-${version.replace('.', '-')}`, policyId, version, personId: p.id, acknowledgedOn: on })
  const founder = !!p.isFounder
  const start = founder ? '2025-05-01' : p.startDate
  add('pl-handbook', '1.0', start)
  add('pl-confidentiality', '1.0', founder ? '2025-05-01' : p.startDate)
  if (p.startDate < '2025-10-01') add('pl-harassment', '1.0', founder ? '2025-10-01' : '2025-10-02')
  else add('pl-harassment', '1.0', p.startDate)
  if (p.startDate < '2026-04-15') {
    add('pl-aup', '1.0', start)
    const reack: Record<string, ISODate> = { maya: '2026-04-15', tomas: '2026-04-16', nikhil: '2026-04-15', caleb: '2026-04-21' }
    add('pl-aup', '2.1', reack[p.key] ?? '2026-04-17')
  } else add('pl-aup', '2.1', p.startDate)
  if (p.startDate < '2026-09-15' && p.id !== 'p-omar' && !missingHandbook2().includes(p.id)) {
    const when: Record<string, ISODate> = {
      maya: '2026-09-15',
      jasmine: '2026-09-15',
      tomas: '2026-09-16',
      priya: '2026-09-16',
      elena: '2026-09-17',
      kofi: '2026-09-17',
      nikhil: '2026-09-16',
      hannah: '2026-09-22',
      sofia: '2026-09-18',
      chris: '2026-09-23',
      luis: '2026-09-24',
    }
    add('pl-handbook', '2.0', when[p.key] ?? '2026-09-25')
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Documents (status and date only, never the file)
// ---------------------------------------------------------------------------------------------

/** PIIA signed (e-sign) 6 business days before the start, ahead of the start - 5 business days task. */
function piiaOn(p: PersonSpec, holidays: ISODate[]): ISODate {
  return p.isFounder ? p.startDate : addBusinessDays(p.startDate, -6, holidays)
}

/**
 * The hire is recorded the day the offer is accepted, as the app's Hire flow does (the application moves to
 * Hired the same day in ./hiring/build.ts), and that creates the onboarding checklist.
 */
function checklistCreatedOn(p: PersonSpec): ISODate {
  return p.isFounder ? p.startDate : p.offerAcceptedOn
}

function documentsFor(p: PersonSpec, holidays: ISODate[]): DocumentRecord[] {
  const i9Day = p.isFounder ? '2025-05-12' : p.startDate
  const out: DocumentRecord[] = []
  if (!p.isFounder) {
    out.push({ id: `doc-${p.key}-offer`, personId: p.id, type: 'offer_letter', name: 'Offer letter, version 1', status: 'signed', date: p.offerAcceptedOn })
  }
  out.push(
    { id: `doc-${p.key}-piia`, personId: p.id, type: 'piia', name: 'Confidential information and invention assignment agreement', status: 'signed', date: piiaOn(p, holidays) },
    { id: `doc-${p.key}-i9-1`, personId: p.id, type: 'i9_section1', name: 'Form I-9 section 1', status: 'signed', date: i9Day },
    { id: `doc-${p.key}-i9-2`, personId: p.id, type: 'i9_section2', name: 'Form I-9 section 2', status: 'filed', date: addBusinessDays(i9Day, 1, holidays) },
  )
  if (p.flsa === 'non_exempt') {
    out.push({ id: `doc-${p.key}-2810-5`, personId: p.id, type: 'wage_notice_2810_5', name: 'Labor Code 2810.5 notice to employee', status: 'delivered', date: p.startDate })
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Person and pay
// ---------------------------------------------------------------------------------------------

function toPerson(p: PersonSpec): Person {
  const person: Person = {
    id: p.id,
    firstName: p.first,
    lastName: p.last,
    workEmail: `${p.first.toLowerCase()}@ledgerlark.com`,
    title: p.title,
    departmentId: p.departmentId,
    familyId: p.familyId,
    levelId: p.levelId,
    managerId: p.managerId,
    locationId: p.locationId,
    workMode: p.workMode,
    homeCity: p.homeCity,
    homeState: p.homeState,
    employmentType: p.employmentType,
    hoursPerWeek: p.hoursPerWeek,
    flsa: p.flsa,
    startDate: p.startDate,
    endDate: null,
    hireNumber: p.hireNumber,
    emergencyContacts: p.contacts.map((c) => ({ ...c })),
    backgroundCheck: p.backgroundClearOn ? { status: 'clear', completedOn: p.backgroundClearOn } : { status: 'not_required' },
    bio: p.bio,
  }
  if (p.exemptionBasis) person.exemptionBasis = p.exemptionBasis
  if (p.isFounder) person.isFounder = true
  if (p.candidateId) person.fromCandidateId = p.candidateId
  return person
}

function compRecords(p: PersonSpec): CompRecord[] {
  const base = {
    personId: p.id,
    title: p.title,
    levelId: p.levelId,
    managerId: p.managerId,
    departmentId: p.departmentId,
    flsa: p.flsa,
    approvedById: 'p-founder',
  }
  const hireOn = p.pay.effectiveOn ?? p.startDate
  const hire: CompRecord = {
    ...base,
    id: `cr-${p.key}-hire`,
    effectiveOn: hireOn,
    payType: p.pay.hourlyRate != null ? 'hourly' : 'salary',
    reason: 'hire',
    approvedOn: p.offerAcceptedOn,
    appliedOn: hireOn,
  }
  if (p.pay.salary != null) hire.salary = p.pay.salary
  if (p.pay.hourlyRate != null) hire.hourlyRate = p.pay.hourlyRate
  if (p.pay.variablePct != null) hire.variablePct = p.pay.variablePct
  if (p.pay.exceptionReason) hire.exceptionReason = p.pay.exceptionReason
  if (p.pay.note) hire.note = p.pay.note
  const out = [hire]
  if (p.market != null) {
    out.push({
      ...base,
      id: `cr-${p.key}-2026-03`,
      effectiveOn: '2026-03-01',
      payType: 'salary',
      salary: p.market,
      reason: 'market',
      note: 'Post-seed market adjustment to the new bands.',
      approvedOn: '2026-02-27',
      appliedOn: '2026-03-01',
    })
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Onboarding checklists
// ---------------------------------------------------------------------------------------------

/** Employees plus active contractors on a date (contractors are added later by ./contractors). */
function workforceOn(db: Draft<DB>, date: ISODate): number {
  const contractors = contractorRows().filter((k) => k.kind === 'contractor' && k.startOn <= date && (!k.endOn || k.endOn >= date)).length
  return headcountOn(db as DB, date) + contractors
}

type TaskPlan = { status: ChecklistTask['status']; doneOn?: ISODate; note?: string; byId?: ID | null }

function doneBy(task: ChecklistTask, p: PersonSpec, on: ISODate): ID | null {
  switch (task.ownerRole) {
    case 'admin':
      return adminOn(on)
    case 'it':
      return itOn(on)
    case 'manager':
      return p.managerId ?? 'p-founder'
    case 'employee':
      return p.id
  }
}

/** Founder: the company had no payroll until May 2025, so the legal items were done when Maya joined it. */
function founderPlan(task: ChecklistTask): TaskPlan {
  const payrollNote = 'Done when Maya joined payroll after the pre-seed.'
  switch (task.templateTaskId) {
    case 'on-piia':
    case 'on-laptop':
    case 'on-accounts':
      return { status: 'done', doneOn: '2025-02-03' }
    case 'on-payroll-invite':
      return { status: 'done', doneOn: '2025-05-05', note: payrollNote }
    case 'on-welcome':
    case 'on-iipp-training':
    case 'on-production-access':
    case 'on-checkin-30':
    case 'on-checkin-90':
      return { status: 'not_applicable', note: 'Founder: no manager.' }
    case 'on-notice-sb294':
      return { status: 'not_applicable', note: 'Hired before SB 294 took effect; covered by the first yearly notice.' }
    case 'on-i9-section1':
      return { status: 'done', doneOn: '2025-05-12', note: payrollNote }
    case 'on-i9-section2':
      return { status: 'done', doneOn: '2025-05-13', note: payrollNote }
    case 'on-de34':
      return { status: 'done', doneOn: '2025-05-20', note: 'Reported with the first payroll.' }
    case 'on-ack-handbook':
    case 'on-ack-security':
      return { status: 'done', doneOn: '2025-05-01' }
    case 'on-security-training':
      return { status: 'done', doneOn: '2025-05-20' }
    default:
      return { status: 'done', doneOn: '2025-05-12', note: task.category === 'notice' ? payrollNote : undefined }
  }
}

function personPlan(task: ChecklistTask, p: PersonSpec, createdOn: ISODate, holidays: ISODate[]): TaskPlan {
  const start = p.startDate
  const prevBusinessDay = (d: ISODate) => {
    const x = addBusinessDays(d, -1, holidays)
    return x < createdOn ? createdOn : x
  }
  const done = (on: ISODate | undefined, note?: string): TaskPlan => (on ? { status: 'done', doneOn: on, note } : { status: 'open', note })
  switch (task.templateTaskId) {
    case 'on-piia':
      return done(piiaOn(p, holidays))
    case 'on-background-check':
      return done(p.backgroundClearOn, 'Cleared after the conditional offer (Fair Chance Act).')
    case 'on-payroll-invite':
    case 'on-laptop':
    case 'on-welcome':
      return done(prevBusinessDay(task.dueOn))
    case 'on-accounts':
    case 'on-new-state':
      return done(task.dueOn, task.templateTaskId === 'on-new-state' ? 'Texas set up through the PEO before the start date.' : undefined)
    case 'on-i9-section2':
      return done(addBusinessDays(start, 1, holidays))
    case 'on-de34':
      if (p.id === 'p-aisha') return { status: 'open', note: 'The PEO has not sent the DE 34 filing confirmation yet.' }
      return done(onOrAfterBusinessDay(addDays(start, 7), holidays), 'Filed by the PEO.')
    case 'on-state-new-hire-report':
      return done(onOrAfterBusinessDay(addDays(start, 7), holidays), 'Reported to the Texas new hire registry by the PEO.')
    case 'on-equity-board':
      if (p.id === 'p-aisha') return done('2026-09-09', 'Queued for the next board consent.')
      return done(boardApprovalFor(p.id))
    case 'on-security-training':
      return done(firstCompletion(p.id, ['security_awareness']))
    case 'on-harassment-training':
    case 'on-harassment-training-supervisor':
    case 'on-harassment-training-short-term': {
      const sup = firstCompletion(p.id, ['harassment_supervisor'])
      const any = firstCompletion(p.id, ['harassment_employee', 'harassment_supervisor'])
      const note = task.templateTaskId === 'on-harassment-training' && sup && sup === any ? 'Took the 2-hour supervisor course.' : undefined
      return done(any, note)
    }
    case 'on-production-access':
      return done(addBusinessDays(start, 7, holidays))
    case 'on-checkin-30':
      if (p.id === 'p-aisha') return done('2026-10-08')
      return done(task.dueOn)
    case 'on-checkin-90':
      return done(task.dueOn)
    case 'on-notice-sb294':
      if (start < '2026-01-01') return { status: 'not_applicable', note: 'Hired before SB 294 took effect; covered by the first yearly notice.' }
      return done(start)
    default:
      return done(start)
  }
}

function buildOnboarding(db: Draft<DB>, person: Person, p: PersonSpec, templateId: 'tpl-onboarding' | 'tpl-new-state'): Checklist {
  const holidays = holidayDates(db)
  const createdOn = checklistCreatedOn(p)
  const prefix = templateId === 'tpl-onboarding' ? 'onb' : 'ns'
  const checklist = generateChecklist(db as DB, {
    person,
    templateId,
    anchorDate: p.startDate,
    createdOn,
    id: `ck-${prefix}-${p.key}`,
    extra: { workforce: workforceOn(db, p.startDate), hasEquity: hasGrant(p.id) },
  })
  const today = seedToday()
  for (const task of checklist.tasks) {
    const plan = p.isFounder ? founderPlan(task) : templateId === 'tpl-new-state' ? { status: 'done' as const, doneOn: task.dueOn < createdOn ? createdOn : task.dueOn } : personPlan(task, p, createdOn, holidays)
    let { status } = plan
    const doneOn = plan.doneOn
    if (status === 'done' && doneOn && doneOn > today) status = 'open'
    task.status = status
    delete task.doneOn
    delete task.doneById
    if (status === 'done' && doneOn) {
      task.doneOn = doneOn
      const by = plan.byId !== undefined ? plan.byId : doneBy(task, p, doneOn)
      if (by) task.doneById = by
    }
    // A note written for a finished task does not apply if the task is still ahead of the anchor.
    if (plan.note && status === plan.status) task.note = plan.note
  }
  const open = checklist.tasks.some((t) => t.status === 'open')
  delete checklist.completedOn
  if (!open && checklist.tasks.length) {
    checklist.completedOn = checklist.tasks.map((t) => t.doneOn ?? createdOn).sort().pop() as ISODate
    compactFinished(checklist)
  }
  return checklist
}

/**
 * Finished checklists keep the record (what was done, when and by whom) but not the why and citation
 * text copied from the template, which stays available by templateTaskId (findTemplate). This keeps the
 * whole sample under about 900 KB. Checklists with open tasks keep every field.
 */
function compactFinished(checklist: Checklist): void {
  for (const t of checklist.tasks) {
    delete t.why
    delete t.citation
  }
}

// ---------------------------------------------------------------------------------------------
// Omar's exit (resigned with notice; left before the cliff)
// ---------------------------------------------------------------------------------------------

function offboardOmar(db: Draft<DB>): void {
  // His grant existed when he resigned, so the real flow returns the unvested options to the pool.
  const grant = sampleGrants().find((g) => g.id === 'g-omar')
  if (grant && !db.grants.some((g) => g.id === grant.id)) db.grants.push(grant)
  const mark = db.activity.length
  const checklistId = startOffboarding(
    db,
    'p-omar',
    { type: 'resigned_notice', reason: 'Joined a later-stage company', noticeGivenOn: '2026-08-14', lastDay: '2026-08-28', rehireEligible: true },
    { date: '2026-08-14', actorId: 'p-jasmine' },
  )
  restampActivity(db, mark, '2026-08-14', 'p-jasmine')
  const omar = db.people.find((p) => p.id === 'p-omar')
  if (omar?.separation) omar.separation.finalPayIssuedOn = '2026-08-28'

  const checklist = db.checklists.find((c) => c.id === checklistId)
  if (!checklist) return
  // Stable ids for docs and tests: ck-off-omar and t-off-omar-<template task>.
  checklist.id = 'ck-off-omar'
  for (const t of checklist.tasks) t.id = `t-off-omar-${t.templateTaskId ?? t.id}`
  for (const t of checklist.tasks) {
    if (t.status !== 'open') continue
    switch (t.templateTaskId) {
      case 'off-equipment':
        t.note = 'Return box shipped to Omar; the laptop is not back yet.'
        continue
      case 'off-cobra':
        t.status = 'done'
        t.doneOn = '2026-09-01'
        t.doneById = 'p-jasmine'
        t.note = 'Started through the PEO.'
        continue
      case 'off-access':
        t.status = 'done'
        t.doneOn = '2026-08-28'
        t.doneById = 'p-nikhil'
        t.evidenceLink = 'https://example.com/it/offboarding/omar-haddad'
        continue
      default:
        t.status = 'done'
        t.doneOn = '2026-08-28'
        t.doneById = 'p-jasmine'
    }
  }
  delete checklist.completedOn
  seedLog(db, '2026-08-28', 'p-jasmine', {
    entityType: 'person',
    entityId: 'p-omar',
    kind: 'final_pay',
    text: 'Recorded final pay for Omar Haddad, issued on his last day',
  })
}

// ---------------------------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------------------------

export function applyPeople(db: Draft<DB>): void {
  updatePolicies(db)
  const holidays = holidayDates(db)
  const list = specs().sort((a, b) => a.startDate.localeCompare(b.startDate))
  let omarDone = false

  for (const p of list) {
    // Omar gave notice on 2026-08-14, before Aisha's start: record his exit in date order.
    if (!omarDone && p.startDate > '2026-08-14') {
      offboardOmar(db)
      omarDone = true
    }
    const person = toPerson(p)
    const existing = db.people.findIndex((x) => x.id === p.id)
    if (existing >= 0) db.people[existing] = person
    else db.people.push(person)
    db.comp.push(...compRecords(p))
    db.documents.push(...documentsFor(p, holidays))
    db.acks.push(...acksFor(p))
    db.checklists.push(buildOnboarding(db, person, p, 'tpl-onboarding'))
    // First employee outside California: the new-state checklist (Texas).
    if (p.homeState !== 'CA' && !list.some((o) => o.homeState === p.homeState && o.startDate < p.startDate)) {
      db.checklists.push(buildOnboarding(db, person, p, 'tpl-new-state'))
    }
    const recordedOn = checklistCreatedOn(p)
    seedLog(db, recordedOn, p.isFounder ? 'p-founder' : adminOn(recordedOn), {
      entityType: 'person',
      entityId: p.id,
      relatedId: p.candidateId,
      kind: 'hired',
      text: p.isFounder ? `Added ${fullName(person)} as employee #1` : `Hired ${fullName(person)} as ${p.title}, employee #${p.hireNumber}, starting ${fmtDay(p.startDate)}`,
    })
  }
  if (!omarDone) offboardOmar(db)

  for (const p of list) {
    if (p.market == null) continue
    seedLog(db, '2026-02-27', 'p-founder', {
      entityType: 'person',
      entityId: p.id,
      kind: 'job_changed',
      text: `Recorded a market adjustment for ${p.first} ${p.last} (pay updated)`,
    })
  }

  db.trainings.push(...trainingRows())
  seedLog(db, '2026-09-15', 'p-jasmine', {
    entityType: 'compliance',
    entityId: 'pl-handbook',
    kind: 'policy_published',
    text: 'Published Employee handbook 2.0 and asked everyone to acknowledge it',
  })
}
