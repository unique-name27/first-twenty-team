// Ledgerlark sample: company profile, departments, locations and pay bands (docs/SAMPLE.md).
// Also the small helpers every seed file shares (activity rows with fixed timestamps and ids).
//
// Module rule: functions only, no module-level runtime constants. The seed can run while the store
// module is still loading (store -> seed -> lifecycle -> store), and a constant in a module that has not
// finished evaluating would be in its temporal dead zone (see src/domain/lifecycle.ts).
import type { Draft } from 'immer'
import type { Activity, Band, DB, Department, EntityType, FLSA, ID, Location } from '@/domain/types'
import type { ISODate } from '@/lib/dates'

// ---------------------------------------------------------------------------------------------
// Shared seed helpers
// ---------------------------------------------------------------------------------------------

/** The day the sample is authored against (Friday). Mirrors SAMPLE_ANCHOR in ./index. */
export function seedToday(): ISODate {
  return '2026-10-09'
}

/** A fixed timestamp on a date, during Pacific business hours (17:00 to 23:59 UTC), varied by a slot number. */
export function seedAt(date: ISODate, slot = 0): string {
  const minutes = 17 * 60 + ((slot * 37) % 400)
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0')
  const mm = String(minutes % 60).padStart(2, '0')
  return `${date}T${hh}:${mm}:00.000Z`
}

/**
 * Adds an activity row with a fixed id and timestamp (seed history is deterministic: no real clock, no
 * random ids, no Viewing-as actor). Text follows the activity rules: no pay, equity amounts or leave types.
 */
export function seedLog(
  draft: Draft<DB>,
  date: ISODate,
  actorId: ID | null,
  a: { entityType: EntityType; entityId: ID; kind: string; text: string; relatedId?: ID },
): void {
  const n = draft.activity.length + 1
  const row: Activity = { id: `act-core-${n}`, at: seedAt(date, n), actorId, ...a }
  draft.activity.push(row)
}

/**
 * Domain mutations (startOffboarding, startLeave, createRequest...) log through the store with the real
 * clock, a random id and the Viewing-as actor. Rewrites the rows added since `from` to a fixed date, id and actor.
 */
export function restampActivity(draft: Draft<DB>, from: number, date: ISODate, actorId: ID | null): void {
  for (let i = from; i < draft.activity.length; i++) {
    const row = draft.activity[i]
    row.id = `act-core-${i + 1}`
    row.at = seedAt(date, i + 1)
    row.actorId = actorId
  }
}

/** The admin doing people operations on a date: Maya until Jasmine started (Jun 1, 2026), then Jasmine. */
export function adminOn(date: ISODate): ID {
  return date < '2026-06-01' ? 'p-founder' : 'p-jasmine'
}

/** Who handled IT tasks on a date: Maya, then Tomas once he started, then Nikhil (security and compliance). */
export function itOn(date: ISODate): ID {
  if (date < '2025-05-12') return 'p-founder'
  return date < '2026-04-13' ? 'p-tomas' : 'p-nikhil'
}

// ---------------------------------------------------------------------------------------------
// Company
// ---------------------------------------------------------------------------------------------

function departments(): Department[] {
  return [
    { id: 'd-exec', name: 'Executive', headId: 'p-founder' },
    { id: 'd-eng', name: 'Engineering', headId: 'p-tomas' },
    { id: 'd-ai', name: 'Applied AI', headId: 'p-priya' },
    { id: 'd-product', name: 'Product and design', headId: 'p-founder' },
    { id: 'd-gtm', name: 'Go to market', headId: 'p-caleb' },
    { id: 'd-acct', name: 'Accounting', headId: 'p-elena' },
    { id: 'd-ops', name: 'Operations', headId: 'p-jasmine' },
  ]
}

function locations(): Location[] {
  return [
    {
      id: 'loc-hq',
      name: 'San Jose HQ',
      kind: 'hq',
      city: 'San Jose',
      state: 'CA',
      minWageHourly: 18.45,
      minWageNote: 'City of San Jose minimum wage for 2026',
      publicAccess: false,
      typicalMaxOnSite: 11,
    },
    {
      id: 'loc-remote-ca',
      name: 'Remote (California)',
      kind: 'remote',
      state: 'CA',
      minWageHourly: 16.9,
      minWageNote: 'California minimum wage (some cities are higher)',
    },
    {
      id: 'loc-remote-tx',
      name: 'Remote (Texas)',
      kind: 'remote',
      city: 'Austin',
      state: 'TX',
      minWageHourly: 7.25,
      minWageNote: 'Federal minimum wage (Texas follows the federal rate)',
    },
  ]
}

type BandRow = [levelId: string, min: number, mid: number, max: number, eqMin: number, eqMax: number, variablePct?: number, flsa?: FLSA]

/**
 * Ledgerlark's own bands (San Jose, seed stage, base pay in USD; equity as a fraction of 12,000,000 fully
 * diluted shares). Grounded in docs/BENCHMARKS.md: a-comp-staff-swe, a-comp-senior-backend, a-comp-fullstack,
 * a-comp-data-engineer and a-comp-security-compliance (engineering); a-comp-applied-ai-engineer and
 * b-ai-ml-premium (ML about 8% higher base, about 1.3x equity); a-comp-product-designer; a-comp-product-manager;
 * a-comp-founding-ae (50/50 OTE); a-comp-csm; a-comp-forward-deployed; a-comp-accounting-domain-lead;
 * a-comp-people-ops; a-comp-ea-office-manager (hourly, non-exempt); b-founder-salary; b-equity-hires-11-20.
 * Open job ranges in docs/SAMPLE.md sit exactly on these bands. The ops L1 band is an hourly role restated
 * at 2,080 hours ($26 to $35 an hour).
 */
function bandTable(): Record<string, BandRow[]> {
  return {
    'f-exec': [['lv-x1', 160_000, 180_000, 200_000, 0.01, 0.02]],
    'f-eng': [
      ['lv-l2', 150_000, 167_500, 185_000, 0.0008, 0.002],
      ['lv-l3', 180_000, 207_500, 235_000, 0.0015, 0.0035],
      ['lv-l4', 210_000, 235_000, 260_000, 0.0025, 0.005],
      ['lv-m1', 220_000, 245_000, 270_000, 0.003, 0.006],
    ],
    'f-ml': [
      ['lv-l2', 165_000, 185_000, 205_000, 0.001, 0.0025],
      ['lv-l3', 190_000, 215_000, 240_000, 0.002, 0.0045],
      ['lv-l4', 225_000, 255_000, 285_000, 0.0025, 0.006],
    ],
    'f-design': [
      ['lv-l2', 135_000, 152_500, 170_000, 0.0008, 0.002],
      ['lv-l3', 160_000, 180_000, 200_000, 0.002, 0.004],
    ],
    'f-product': [
      ['lv-l3', 170_000, 195_000, 220_000, 0.002, 0.005],
      ['lv-l4', 200_000, 225_000, 250_000, 0.003, 0.006],
    ],
    'f-gtm': [
      ['lv-l2', 125_000, 145_000, 165_000, 0.0005, 0.0015, 0.1],
      ['lv-l3', 130_000, 145_000, 160_000, 0.0008, 0.0025, 1.0],
    ],
    'f-solutions': [
      ['lv-l2', 135_000, 152_500, 170_000, 0.0005, 0.0015, 0.1],
      ['lv-l3', 150_000, 175_000, 200_000, 0.0008, 0.0025, 0.15],
    ],
    'f-acct': [
      ['lv-l3', 165_000, 185_000, 205_000, 0.001, 0.0025],
      ['lv-m1', 185_000, 207_500, 230_000, 0.003, 0.006],
    ],
    'f-ops': [
      ['lv-l1', 54_080, 62_400, 72_800, 0, 0.0002, undefined, 'non_exempt'],
      ['lv-l2', 105_000, 120_000, 135_000, 0.0003, 0.001],
      ['lv-l3', 130_000, 150_000, 170_000, 0.0008, 0.002],
    ],
  }
}

export function ledgerlarkBands(): Band[] {
  return Object.entries(bandTable()).flatMap(([familyId, rows]) =>
    rows.map(([levelId, min, mid, max, equityMinPct, equityMaxPct, variablePct, flsa]) => {
      const band: Band = {
        id: `b-${familyId.slice(2)}-${levelId.slice(3)}`,
        familyId,
        levelId,
        min,
        mid,
        max,
        equityMinPct,
        equityMaxPct,
        flsaDefault: flsa ?? 'exempt',
      }
      if (variablePct != null) band.variablePct = variablePct
      return band
    }),
  )
}

export function applyCompany(db: Draft<DB>): void {
  const c = db.company
  c.name = 'Ledgerlark'
  c.legalName = 'Ledgerlark, Inc.'
  c.tagline = 'AI close agents for mid-market controllers'
  c.hq = { street: '99 S Almaden Blvd', suite: 'Suite 410', city: 'San Jose', state: 'CA', zip: '95113' }
  c.foundedOn = '2025-02-03'
  c.incorporatedIn = 'Delaware'
  c.entityType = 'C corporation'
  c.timezone = 'America/Los_Angeles'
  c.stage = 'Seed'
  c.workweek = 'Hybrid, office Tue to Thu'
  c.paySchedule = 'semi_monthly'
  c.fundingRounds = [
    {
      id: 'fr-preseed',
      name: 'Pre-seed',
      closedOn: '2025-04-15',
      amount: 3_000_000,
      leadInvestor: 'Almaden Peak Ventures',
      instrument: 'SAFE',
    },
    {
      id: 'fr-seed',
      name: 'Seed',
      closedOn: '2026-02-24',
      amount: 14_000_000,
      postMoney: 70_000_000,
      leadInvestor: 'Coyote Valley Capital',
      pricePerShare: 5.83,
      instrument: 'Priced',
    },
  ]
  c.payrollProvider = { name: 'Your PEO', kind: 'PEO', url: 'https://example.com/peo' }
  c.linkOuts = {
    payroll: 'https://example.com/peo',
    benefits: 'https://example.com/peo/benefits',
    backgroundCheck: 'https://example.com/background-checks',
    eSign: 'https://example.com/e-sign',
    capTable: 'https://example.com/cap-table',
    calendly: 'https://example.com/schedule/ledgerlark',
    training: 'https://example.com/security-training',
    handbook: 'https://example.com/handbook',
  }
  c.workersCompCarrier = {
    name: 'Golden Poppy Mutual',
    phone: '(800) 555-0142',
    policyNumber: 'GPM-WC-0000000 (placeholder)',
    address: '2200 Golden Poppy Way, Sacramento, CA 95833',
  }
  c.phone = '(408) 555-0110'
  // The in-app assistant (src/domain/assistant.ts); a new company leaves it unset and gets '<name> Bot'.
  c.assistantName = 'Lark'
  // No typed regular payday: the wage notice prints the pay calendar's words (paydayWords), so it follows Settings.
  c.eddAccountNumber = '000-0000-0 (placeholder)'
  c.firstPayrollOn = '2025-05-15'
  c.cashOnHand = 13_400_000
  c.cashAsOf = '2026-10-01'
  c.otherMonthlySpend = 110_000
  c.monthlyRevenue = 92_000
  c.annualRevenue = 1_100_000
  c.costModel = { benefitsPerHeadMonthly: 1150, peoToolsPerHeadMonthly: 375, workersCompPct: 0.003 }
  // Health benefits through the PEO from the first non-owner hire (Tomas, May 12, 2025).
  c.groupHealthPlanStartedOn = '2025-05-12'
  c.soc2Enabled = true
  c.soc2 = { typeIReportOn: '2026-07-15', typeIIWindow: { from: '2026-08-01', to: '2027-01-31' } }
  c.website = 'https://ledgerlark.com'

  db.departments = departments()
  db.locations = locations()
  db.bands = ledgerlarkBands()

  seedLog(db, '2025-02-03', 'p-founder', {
    entityType: 'company',
    entityId: 'company',
    kind: 'company_created',
    text: 'Set up Ledgerlark, Inc. in First Twenty',
  })
  seedLog(db, '2026-02-27', 'p-founder', {
    entityType: 'settings',
    entityId: 'bands',
    kind: 'bands_updated',
    text: 'Updated pay bands after the seed round',
  })
}
