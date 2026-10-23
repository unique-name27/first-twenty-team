// A brand-new workspace: one founder, sensible defaults, nothing else.
// Used by "Start fresh as a solo founder" (Settings > Data) and as the base of the sample.
import { DEFAULT_LAW } from '@/data/law'
import {
  DEFAULT_BANDS,
  DEFAULT_DEPARTMENTS,
  DEFAULT_EMAIL_TEMPLATES,
  DEFAULT_FAMILIES,
  DEFAULT_LEVELS,
  DEFAULT_STAGES,
  DEFAULT_TIME_OFF_POLICIES,
  defaultHolidays,
  defaultPolicies,
} from '@/data/defaults'
import { DEFAULT_ROLE_TEMPLATES } from '@/data/starterRoleTemplates'
import { DEFAULT_CHECKLIST_TEMPLATES } from '@/domain/checklists/templates'
import type { DB } from '@/domain/types'
import { today } from '@/lib/dates'

export type BlankInput = {
  companyName: string
  founderFirstName: string
  founderLastName: string
  founderTitle?: string
  /**
   * The founder's work email. '' keeps it empty (Start fresh, when the founder leaves it blank). Left out,
   * it is guessed as first name at the company name + '.com', for the sample and test kits only.
   */
  founderEmail?: string
  foundedOn?: string
  hqCity?: string
  hqState?: string
  hqZip?: string
}

export function blankDB(input: BlankInput): DB {
  // Defaults are cloned so a workspace never shares (and Immer never freezes) the module constants.
  const c = <T>(v: T): T => structuredClone(v)
  const start = input.foundedOn ?? today()
  const domain = `${input.companyName.toLowerCase().replace(/[^a-z0-9]+/g, '')}.com`
  const founderId = 'p-founder'
  const city = input.hqCity ?? 'San Jose'
  const state = input.hqState ?? 'CA'
  return {
    schemaVersion: 1,
    meta: { createdOn: today(), sample: false },
    company: {
      name: input.companyName,
      legalName: `${input.companyName}, Inc.`,
      tagline: '',
      hq: { street: '', city, state, zip: input.hqZip ?? '95113' },
      foundedOn: start,
      incorporatedIn: 'Delaware',
      entityType: 'C corporation',
      timezone: 'America/Los_Angeles',
      stage: 'Pre-seed',
      workweek: 'Monday to Friday',
      paySchedule: 'semi_monthly',
      fundingRounds: [],
      // No provider name until the founder adds one in Settings, Link-outs (screens say "your payroll or PEO provider").
      payrollProvider: { name: '', kind: 'PEO', url: '' },
      linkOuts: {},
      costModel: { benefitsPerHeadMonthly: 1150, peoToolsPerHeadMonthly: 375, workersCompPct: 0.003 },
      soc2Enabled: false,
    },
    departments: DEFAULT_DEPARTMENTS.map((d) => ({ ...d, headId: d.id === 'd-exec' ? founderId : null })),
    locations: [
      {
        id: 'loc-hq',
        name: `${city} HQ`,
        kind: 'hq',
        city,
        state,
        minWageHourly: city === 'San Jose' ? DEFAULT_LAW.sanJoseMinWageHourly : DEFAULT_LAW.caMinWageHourly,
        minWageNote: city === 'San Jose' ? 'City of San Jose minimum wage' : 'California minimum wage',
        publicAccess: false,
        typicalMaxOnSite: 1,
      },
      {
        id: 'loc-remote-ca',
        name: 'Remote (California)',
        kind: 'remote',
        state: 'CA',
        minWageHourly: DEFAULT_LAW.caMinWageHourly,
        minWageNote: 'California minimum wage (some cities are higher)',
      },
    ],
    families: c(DEFAULT_FAMILIES),
    levels: c(DEFAULT_LEVELS),
    bands: c(DEFAULT_BANDS),
    people: [
      {
        id: founderId,
        firstName: input.founderFirstName,
        lastName: input.founderLastName,
        workEmail: input.founderEmail ?? `${input.founderFirstName.toLowerCase()}@${domain}`,
        title: input.founderTitle ?? 'Founder and CEO',
        departmentId: 'd-exec',
        familyId: 'f-exec',
        levelId: 'lv-x1',
        managerId: null,
        locationId: 'loc-hq',
        workMode: 'hybrid',
        homeCity: city,
        homeState: state,
        employmentType: 'full_time',
        hoursPerWeek: 40,
        flsa: 'exempt',
        exemptionBasis: 'executive',
        startDate: start,
        hireNumber: 1,
        isFounder: true,
        emergencyContacts: [],
      },
    ],
    comp: [],
    // Placeholder cap table numbers (capTableConfirmedOn stays unset): Comp and plan > Equity asks the
    // founder to check them against the cap table tool, and offer letters leave out the % until then.
    equity: {
      authorizedShares: 12_000_000,
      fullyDilutedShares: 10_000_000,
      founderShares: 8_500_000,
      poolShares: 1_500_000,
      poolIncreases: [],
      valuations: [],
    },
    grants: [],
    contractors: [],
    documents: [],
    plan: [],
    jobs: [],
    candidates: [],
    applications: [],
    interviews: [],
    scorecards: [],
    offers: [],
    referrals: [],
    emailTemplates: c(DEFAULT_EMAIL_TEMPLATES),
    checklistTemplates: c(DEFAULT_CHECKLIST_TEMPLATES),
    checklists: [],
    timeOffPolicies: c(DEFAULT_TIME_OFF_POLICIES),
    timeOffRequests: [],
    timeOffAdjustments: [],
    holidays: defaultHolidays(),
    leaveCases: [],
    complianceStatus: {},
    recurring: [],
    trainings: [],
    // Version 1.0 of each starter policy, in effect from the founding date (never before the company existed).
    policies: defaultPolicies(start),
    acks: [],
    recordsRequests: [],
    inboxState: {},
    activity: [],
    settings: {
      outcomeReasons: [
        'not_a_fit_level',
        'skills_gap',
        'chose_other_offer',
        'comp',
        'location',
        'timing',
        'no_response',
        'withdrew',
        'position_filled',
        'other',
      ],
      defaultStages: c(DEFAULT_STAGES),
      scorecardDueHours: 24,
      responseSlaBusinessDays: 5,
      offerExpiryBusinessDays: 5,
      referralBonusDefault: 5000,
      referralBonusPayableDays: 90,
      defaultVestingMonths: 48,
      defaultCliffMonths: 12,
      law: {
        year: DEFAULT_LAW.year,
        caMinWageHourly: DEFAULT_LAW.caMinWageHourly,
        exemptSalaryMin: DEFAULT_LAW.exemptSalaryMin,
        computerProHourly: DEFAULT_LAW.computerProHourly,
        computerProAnnual: DEFAULT_LAW.computerProAnnual,
        form1099Threshold: DEFAULT_LAW.form1099Threshold,
        de542Threshold: DEFAULT_LAW.de542Threshold,
        lastReviewedOn: DEFAULT_LAW.lastReviewedOn,
      },
      // Company-neutral starters: the sample installs its own (src/data/seed/hiring.ts).
      roleTemplates: c(DEFAULT_ROLE_TEMPLATES),
    },
  }
}
