// The companies the simulator generates (src/sim/generate.ts). Each scenario has a fixed default seed and an
// as-of date inside the law coverage. A plan is written relative to its as-of date (days or months before
// it), so the same scenario can be generated as of another date; the seed picks the names, pipelines,
// interview times and outcomes. Every company and person is invented.
import type { ID } from '@/domain/types'
import type { ISODate } from '@/lib/dates'

export type ScenarioName = 'ledgerlark' | 'blank' | 'seed-8' | 'cross-15' | 'full-20' | 'payroll-edge' | 'pipeline-heavy' | 'stress'

/** One hire the company makes: the job, who leads it and when the person starts. */
export type RolePlan = {
  /** The role template the New job sheet starts from (src/data/starterRoleTemplates.ts). */
  template: ID
  title?: string
  familyId?: ID
  levelId?: ID
  /** The team, when not the template's. */
  departmentId?: ID
  /** The office the job is at, when not headquarters. */
  locationId?: ID
  /** Days before the as-of date the person starts (negative: after it, so the job is still open then). */
  startsDaysBeforeAsOf: number
  /**
   * For a job still open on the as-of date: the day it opens, in days before the as-of date (default: about
   * seven weeks before the start). It makes no offer by the as-of date.
   */
  opensDaysBeforeAsOf?: number
  /** Start on exactly that day (the offer builder's date field), not the Monday on or after it. */
  exactStart?: boolean
  /** Leads report to the founder, head their department and are the hiring manager for the rest of it. */
  lead?: boolean
  /** An hourly job: hours a week, full or part time, and the posted hourly range. Its band makes it non-exempt (setup.bands). */
  hourly?: { hoursPerWeek: number; partTime: boolean; range: [number, number] }
  /** No options in the offer (otherwise the midpoint of the band's guideline, as the offer builder starts). */
  noEquity?: boolean
  /** Candidates on the job besides the one who is hired: [fewest, most]. Default: the company's. */
  pipeline?: [number, number]
}

/** Things that happen to people after they are hired, in days relative to the as-of date. */
export type LifeEvents = {
  /** A protected leave for the person hired in roles[role]. */
  leave?: { role: number; kind: 'bonding' | 'cfra' | 'pdl'; requestedDaysBeforeAsOf: number; startsDaysBeforeAsOf: number; returnsDaysAfterAsOf: number }
  /** The person hired in roles[role] is let go; the last day falls inside a pay period. */
  termination?: { role: number; lastDayDaysBeforeAsOf: number; reason: string }
}

export type CompanyPlan = {
  name: string
  /** Months before the as-of date the company was founded (the founder's start and first payroll). */
  ageMonths: number
  founderTitle: string
  founderSalary: number
  roles: RolePlan[]
  /** Candidates per job besides the hire: [fewest, most]. */
  pipeline: [number, number]
  /** Hiring managers other than the founder draft their own offers, and Admin approves them. */
  managersDraftOffers: boolean
  /** Settings > Org and Comp and plan > Bands on the founding day. */
  setup?: {
    departments?: Array<{ id: ID; name: string }>
    levels?: Array<{ id: ID; code: string; name: string; track: 'ic' | 'manager' | 'executive'; order: number; description?: string }>
    /** California offices. The minimum wage comes from src/data/law.ts, as the location sheet prefills it. */
    locations?: Array<{ id: ID; name: string; city: string }>
    /** Bands saved on the Bands tab: a band that exists keeps the values a row leaves out, as its edit sheet starts from them. */
    bands?: Array<{ familyId: ID; levelId: ID; min?: number; mid?: number; max?: number; equityMinPct?: number; equityMaxPct?: number; variablePct?: number; flsaDefault: 'exempt' | 'non_exempt' }>
  }
  life?: LifeEvents
}

export type Scenario = {
  name: ScenarioName
  /** One line for people choosing a scenario. */
  description: string
  /** 'browser' scenarios fit the demo caps and can be loaded into the app; 'server' ones are too big for a browser. */
  target: 'browser' | 'server'
  seed: number
  asOf: ISODate
  /** sample: buildSampleDB exactly; blank: Start fresh as a solo founder on the as-of date; company: generated. */
  kind: 'sample' | 'blank' | 'company'
  company?: CompanyPlan
}

/**
 * The order a small company tends to hire in. Leads come first in their department; the rest of a
 * department reports to its lead once the lead has started.
 */
function roleSequence(): Array<Omit<RolePlan, 'startsDaysBeforeAsOf'>> {
  return [
    { template: 'rt-fullstack', title: 'Founding engineer', levelId: 'lv-l4', lead: true },
    { template: 'rt-ml', title: 'Machine learning engineer' },
    { template: 'rt-fullstack', title: 'Senior full-stack engineer' },
    { template: 'rt-designer', title: 'Founding product designer', lead: true },
    { template: 'rt-ae-founding', title: 'Founding account executive', lead: true },
    { template: 'rt-ops-people', title: 'Ops and people generalist', lead: true },
    { template: 'rt-fullstack', title: 'Full-stack engineer', levelId: 'lv-l2' },
    { template: 'rt-csm', title: 'Customer success manager' },
    { template: 'rt-pm', title: 'Product manager' },
    { template: 'rt-solutions', title: 'Solutions engineer' },
    { template: 'rt-ml', title: 'Senior ML engineer' },
    { template: 'rt-finance', title: 'Finance and accounting lead' },
    { template: 'rt-fullstack', title: 'Senior backend engineer' },
    { template: 'rt-csm', title: 'Customer success manager' },
    { template: 'rt-ae-founding', title: 'Account executive', levelId: 'lv-l2' },
    { template: 'rt-fullstack', title: 'Senior full-stack engineer' },
    { template: 'rt-designer', title: 'Product designer' },
    { template: 'rt-ml', title: 'ML engineer', levelId: 'lv-l2' },
    { template: 'rt-solutions', title: 'Implementation engineer', levelId: 'lv-l2' },
    { template: 'rt-fullstack', title: 'Full-stack engineer', levelId: 'lv-l2' },
    { template: 'rt-csm', title: 'Customer success manager' },
    { template: 'rt-pm', title: 'Senior product manager' },
    { template: 'rt-fullstack', title: 'Senior frontend engineer' },
    { template: 'rt-ae-founding', title: 'Account executive', levelId: 'lv-l2' },
  ]
}

/**
 * `count` start days (days before the as-of date) from `first` down to `last`, closer together as the
 * company grows (hiring speeds up after a round): the k-th of n sits at (k / (n - 1)) ^ (1 / 1.6) of the way.
 */
function spread(count: number, first: number, last: number): number[] {
  if (count === 1) return [last]
  return Array.from({ length: count }, (_, k) => Math.round(first - (first - last) * (k / (count - 1)) ** (1 / 1.6)))
}

/** How many days before the as-of date the open jobs opened, in turn: candidates are part way through on the day. */
function openedDaysAgo(): number[] {
  return [12, 5, 18, 9]
}

/**
 * The first `hires` roles of the sequence, starting from `firstDays` to `lastDays` before the as-of date,
 * then `open` more whose jobs opened shortly before it and whose people would start about six weeks after.
 */
function hiringPlan(hires: number, firstDays: number, lastDays: number, open: number, openPipeline?: [number, number]): RolePlan[] {
  const seq = roleSequence()
  const days = spread(hires, firstDays, lastDays)
  const out: RolePlan[] = days.map((d, k) => ({ ...seq[k % seq.length], startsDaysBeforeAsOf: d }))
  for (let k = 0; k < open; k++) {
    const opened = openedDaysAgo()[k % openedDaysAgo().length]
    out.push({ ...seq[(hires + k) % seq.length], opensDaysBeforeAsOf: opened, startsDaysBeforeAsOf: opened - 46, ...(openPipeline ? { pipeline: openPipeline } : {}) })
  }
  return out
}

/** Puts every role from `template` in `departmentId`; the first one leads it. */
function intoDepartment(roles: RolePlan[], template: ID, departmentId: ID): RolePlan[] {
  let led = false
  return roles.map((r) => {
    if (r.template !== template) return r
    const lead = !led
    led = true
    return { ...r, departmentId, ...(lead ? { lead: true } : {}) }
  })
}

/** Puts the roles at these positions at the office `locationId`. */
function atOffice(roles: RolePlan[], positions: number[], locationId: ID): RolePlan[] {
  return roles.map((r, k) => (positions.includes(k) ? { ...r, locationId } : r))
}

const AS_OF = '2026-10-09'

export const SCENARIOS: Record<ScenarioName, Scenario> = {
  ledgerlark: {
    name: 'ledgerlark',
    description: 'The Ledgerlark sample exactly as buildSampleDB builds it, for parity with the app.',
    target: 'browser',
    seed: 0,
    asOf: AS_OF,
    kind: 'sample',
  },
  blank: {
    name: 'blank',
    description: 'Start fresh as a solo founder: one person, the defaults, nothing else.',
    target: 'browser',
    seed: 1,
    asOf: AS_OF,
    kind: 'blank',
    company: { name: 'Northwick', ageMonths: 0, founderTitle: 'Founder and CEO', founderSalary: 0, roles: [], pipeline: [0, 0], managersDraftOffers: false },
  },
  'seed-8': {
    name: 'seed-8',
    description: 'A seed-stage company of 8, with one job open.',
    target: 'browser',
    seed: 8008,
    asOf: AS_OF,
    kind: 'company',
    company: {
      name: 'Quillpine',
      ageMonths: 19,
      founderTitle: 'Founder and CEO',
      founderSalary: 160_000,
      roles: hiringPlan(7, 440, 30, 1),
      pipeline: [12, 20],
      managersDraftOffers: false,
    },
  },
  'cross-15': {
    name: 'cross-15',
    description: 'Fifteen employees reached about a week before the as-of date: the rules that start at 15 just began.',
    target: 'browser',
    seed: 1515,
    asOf: AS_OF,
    kind: 'company',
    company: {
      name: 'Harborwren',
      ageMonths: 21,
      founderTitle: 'Founder and CEO',
      founderSalary: 175_000,
      roles: atOffice(hiringPlan(14, 520, 8, 1), [7, 9, 13], 'loc-oakland'),
      pipeline: [10, 16],
      managersDraftOffers: true,
      setup: { locations: [{ id: 'loc-oakland', name: 'Oakland office', city: 'Oakland' }] },
    },
  },
  'full-20': {
    name: 'full-20',
    description: 'A full company of 20, every hire through the hiring pipeline, no job open.',
    target: 'browser',
    seed: 2020,
    asOf: AS_OF,
    kind: 'company',
    company: {
      name: 'Tidebeam',
      ageMonths: 21,
      founderTitle: 'Founder and CEO',
      founderSalary: 180_000,
      roles: intoDepartment(hiringPlan(19, 540, 21, 0), 'rt-csm', 'd-cs'),
      pipeline: [10, 16],
      managersDraftOffers: true,
      setup: {
        departments: [{ id: 'd-cs', name: 'Customer success' }],
        levels: [{ id: 'lv-l6', code: 'L6', name: 'Distinguished', track: 'ic', order: 6, description: 'Sets technical direction for the whole company.' }],
        bands: [{ familyId: 'f-eng', levelId: 'lv-l3', min: 185_000, mid: 210_000, max: 235_000, equityMinPct: 0.001, equityMaxPct: 0.0035, flsaDefault: 'exempt' }],
      },
    },
  },
  'payroll-edge': {
    name: 'payroll-edge',
    description: 'Pay run edge cases: part-time and full-time hourly staff, a hire mid pay period, a leave, a termination inside a pay period.',
    target: 'browser',
    seed: 7070,
    asOf: AS_OF,
    kind: 'company',
    company: {
      name: 'Fernlight',
      ageMonths: 16,
      founderTitle: 'Founder and CEO',
      founderSalary: 150_000,
      roles: [
        { template: 'rt-fullstack', title: 'Founding engineer', levelId: 'lv-l4', lead: true, startsDaysBeforeAsOf: 395 },
        { template: 'rt-ops-people', title: 'Ops and people generalist', lead: true, startsDaysBeforeAsOf: 300 },
        { template: 'rt-csm', title: 'Customer success manager', startsDaysBeforeAsOf: 210 },
        {
          template: 'rt-ops-people',
          title: 'Office coordinator',
          familyId: 'f-ops',
          levelId: 'lv-l1',
          hourly: { hoursPerWeek: 24, partTime: true, range: [24, 30] },
          noEquity: true,
          startsDaysBeforeAsOf: 125,
        },
        { template: 'rt-fullstack', title: 'Full-stack engineer', levelId: 'lv-l2', startsDaysBeforeAsOf: 150 },
        {
          template: 'rt-csm',
          title: 'Customer support specialist',
          familyId: 'f-gtm',
          levelId: 'lv-l1',
          hourly: { hoursPerWeek: 40, partTime: false, range: [28, 34] },
          noEquity: true,
          // A Wednesday in the middle of the second-half pay period.
          startsDaysBeforeAsOf: 16,
          exactStart: true,
        },
      ],
      pipeline: [8, 12],
      managersDraftOffers: false,
      // The hourly jobs' bands are non-exempt, so New job makes them non-exempt (the job sheets have no FLSA field).
      setup: {
        bands: [
          { familyId: 'f-ops', levelId: 'lv-l1', flsaDefault: 'non_exempt' },
          { familyId: 'f-gtm', levelId: 'lv-l1', flsaDefault: 'non_exempt' },
        ],
      },
      life: {
        leave: { role: 2, kind: 'bonding', requestedDaysBeforeAsOf: 35, startsDaysBeforeAsOf: 17, returnsDaysAfterAsOf: 70 },
        // A Thursday, the second day of the second-half pay period.
        termination: { role: 4, lastDayDaysBeforeAsOf: 22, reason: 'Performance' },
      },
    },
  },
  'pipeline-heavy': {
    name: 'pipeline-heavy',
    description: 'A small company hiring hard: about 300 candidates, three jobs open with full pipelines.',
    target: 'browser',
    seed: 3030,
    asOf: AS_OF,
    kind: 'company',
    company: {
      name: 'Pebblecrest',
      ageMonths: 14,
      founderTitle: 'Founder and CEO',
      founderSalary: 165_000,
      roles: hiringPlan(5, 330, 45, 3, [52, 60]),
      pipeline: [34, 42],
      managersDraftOffers: false,
    },
  },
  stress: {
    name: 'stress',
    description: 'A company of 20 with thousands of candidates: more records than a demo workspace holds. Server only, never loaded into a browser.',
    target: 'server',
    seed: 9999,
    asOf: AS_OF,
    kind: 'company',
    company: {
      name: 'Cinderloom',
      ageMonths: 21,
      founderTitle: 'Founder and CEO',
      founderSalary: 180_000,
      roles: hiringPlan(19, 540, 21, 4),
      pipeline: [110, 140],
      managersDraftOffers: true,
    },
  },
}

export const SCENARIO_NAMES = Object.keys(SCENARIOS) as ScenarioName[]
