// Ledgerlark sample: option pool, 409A history and grants (docs/SAMPLE.md). Cap table: 12,000,000 fully
// diluted = founder 7,000,000 + pre-seed conversion 900,000 + seed 2,400,000 + pool 1,700,000
// (1,200,000 created 2025-04-20, +500,000 at the seed on 2026-02-24). Grant sizes for hires 2-5 follow the
// Carta State of Seed medians by hire number (docs/BENCHMARKS.md b-equity-hires-1-5). Strike = the 409A in
// effect on the board approval date (b-409a-validity). Functions only (see ./company for why).
import type { Draft } from 'immer'
import { defaultHolidays } from '@/data/defaults'
import { fullName } from '@/domain/people'
import type { DB, DocumentRecord, EquityGrant, EquitySetup, ID } from '@/domain/types'
import { addBusinessDays, addDays, addMonths, fmtDate, type ISODate } from '@/lib/dates'
import { seedLog } from './company'
import { contractorRows } from './contractors'

type GrantSpec = {
  id: ID
  personId: ID
  shares: number
  vestingStart: ISODate
  /** Board approval date; undefined while the grant is promised (waiting for the next consent). */
  boardApprovedOn?: ISODate
  advisor?: boolean
  note?: string
}

function strikeOn(date: ISODate): number {
  // 409A history: $0.25 from 2025-05-01, $1.15 from 2026-03-20 (after the seed).
  return date >= '2026-03-20' ? 1.15 : 0.25
}

function grantSpecs(): GrantSpec[] {
  const founding = 'Founding grant sized by hire number.'
  return [
    { id: 'g-tomas', personId: 'p-tomas', shares: 150_000, vestingStart: '2025-05-12', boardApprovedOn: '2025-05-28', note: founding },
    { id: 'g-priya', personId: 'p-priya', shares: 102_000, vestingStart: '2025-06-09', boardApprovedOn: '2025-06-26', note: founding },
    { id: 'g-elena', personId: 'p-elena', shares: 60_000, vestingStart: '2025-08-18', boardApprovedOn: '2025-08-28', note: founding },
    { id: 'g-kofi', personId: 'p-kofi', shares: 52_000, vestingStart: '2025-10-06', boardApprovedOn: '2025-10-23', note: founding },
    { id: 'g-sofia', personId: 'p-sofia', shares: 40_000, vestingStart: '2026-01-12', boardApprovedOn: '2026-01-22' },
    { id: 'g-caleb', personId: 'p-caleb', shares: 30_000, vestingStart: '2026-03-02', boardApprovedOn: '2026-03-26' },
    { id: 'g-hannah', personId: 'p-hannah', shares: 40_000, vestingStart: '2026-03-16', boardApprovedOn: '2026-03-26' },
    { id: 'g-nikhil', personId: 'p-nikhil', shares: 35_000, vestingStart: '2026-04-13', boardApprovedOn: '2026-04-23' },
    { id: 'g-omar', personId: 'p-omar', shares: 30_000, vestingStart: '2026-05-04', boardApprovedOn: '2026-05-21' },
    { id: 'g-jasmine', personId: 'p-jasmine', shares: 20_000, vestingStart: '2026-06-01', boardApprovedOn: '2026-06-18' },
    { id: 'g-chris', personId: 'p-chris', shares: 18_000, vestingStart: '2026-07-13', boardApprovedOn: '2026-07-23' },
    { id: 'g-ravi', personId: 'p-ravi', shares: 45_000, vestingStart: '2026-08-10', boardApprovedOn: '2026-08-27' },
    { id: 'g-aisha', personId: 'p-aisha', shares: 12_000, vestingStart: '2026-09-08', note: 'Waiting for the next board consent.' },
    {
      id: 'g-adv-whitfield',
      personId: 'k-adv-whitfield',
      shares: 24_000,
      vestingStart: '2025-07-01',
      boardApprovedOn: '2025-06-26',
      advisor: true,
      note: 'Advisor grant: 2-year monthly vesting, no cliff.',
    },
    {
      id: 'g-adv-osei',
      personId: 'k-adv-osei',
      shares: 24_000,
      vestingStart: '2026-04-01',
      boardApprovedOn: '2026-04-23',
      advisor: true,
      note: 'Advisor grant: 2-year monthly vesting, no cliff.',
    },
  ]
}

function toGrant(s: GrantSpec): EquityGrant {
  const g: EquityGrant = {
    id: s.id,
    personId: s.personId,
    holderType: s.advisor ? 'advisor' : 'employee',
    type: s.advisor ? 'NSO' : 'ISO',
    shares: s.shares,
    strikePrice: strikeOn(s.boardApprovedOn ?? s.vestingStart),
    vestingStart: s.vestingStart,
    cliffMonths: s.advisor ? 0 : 12,
    vestingMonths: s.advisor ? 24 : 48,
    status: s.boardApprovedOn ? 'approved' : 'promised',
    proposedOn: s.advisor ? addBusinessDays(s.boardApprovedOn ?? s.vestingStart, -5, defaultHolidays().map((h) => h.date)) : s.vestingStart,
    exercisedShares: 0,
    postTerminationExerciseDays: 90,
  }
  if (s.boardApprovedOn) g.boardApprovedOn = s.boardApprovedOn
  if (s.note) g.note = s.note
  return g
}

/** Every sample grant as it stood when granted (Omar's is cancelled later by his offboarding). */
export function sampleGrants(): EquityGrant[] {
  return grantSpecs().map(toGrant)
}

/** Board approval date of a person's grant, if any (used by onboarding checklists and documents). */
export function boardApprovalFor(personId: ID): ISODate | undefined {
  return grantSpecs().find((s) => s.personId === personId)?.boardApprovedOn
}

/** People with an option grant (approved or promised): their onboarding includes the board consent task. */
export function hasGrant(personId: ID): boolean {
  return grantSpecs().some((s) => s.personId === personId)
}

function equitySetup(): EquitySetup {
  return {
    authorizedShares: 15_000_000,
    fullyDilutedShares: 12_000_000,
    founderShares: 7_000_000,
    poolShares: 1_200_000,
    poolIncreases: [{ id: 'pool-seed', date: '2026-02-24', shares: 500_000, note: 'Increased at the seed close, approved by the board and stockholders.' }],
    valuations: [
      {
        id: 'v409a-2025',
        effectiveOn: '2025-05-01',
        fmvPerShare: 0.25,
        provider: 'Meridian Valuation Group',
        expiresOn: '2026-05-01',
        note: 'Pre-seed valuation. Superseded by the post-seed valuation after the priced round.',
      },
      {
        id: 'v409a-2026',
        effectiveOn: '2026-03-20',
        fmvPerShare: 1.15,
        provider: 'Meridian Valuation Group',
        expiresOn: '2027-03-20',
        note: 'Post-seed valuation (seed preferred at $5.83 a share).',
      },
    ],
    firstIssuanceOn: '2025-05-28',
    filing25102oOn: '2025-06-10',
    // Copied from the cap table tool after the seed close, so offer letters state the % of fully diluted shares.
    capTableConfirmedOn: '2026-02-24',
  }
}

export function applyEquity(db: Draft<DB>): void {
  db.equity = equitySetup()

  seedLog(db, '2025-04-20', 'p-founder', { entityType: 'equity', entityId: 'equity', kind: 'pool_created', text: 'Created the option pool' })
  seedLog(db, '2025-05-01', 'p-founder', {
    entityType: 'equity',
    entityId: 'v409a-2025',
    kind: 'valuation_added',
    text: 'Added a 409A valuation from Meridian Valuation Group',
  })

  // Grants: Omar's row already exists when ./people recorded his exit (it returned all 30,000 to the pool).
  for (const g of sampleGrants()) {
    if (db.grants.some((x) => x.id === g.id)) continue
    if (g.id === 'g-omar') {
      g.status = 'cancelled'
      g.cancelledShares = g.shares
      g.cancelledOn = '2026-08-28'
    }
    db.grants.push(g)
  }

  // Grant agreements (status and date only), signed about a week after each board consent.
  for (const g of db.grants) {
    if (!g.boardApprovedOn || g.holderType === 'candidate') continue
    const person = db.people.find((p) => p.id === g.personId)
    const doc: DocumentRecord = {
      id: `doc-grant-${g.id.slice(2)}`,
      personId: g.personId,
      type: 'grant_agreement',
      name: `${g.type} grant agreement`,
      status: 'signed',
      date: addDays(g.boardApprovedOn, 6),
    }
    // Personnel records: 4 years after the exit (Gov Code 12946), as startOffboarding sets them.
    if (person?.separation) doc.retainUntil = addMonths(person.separation.lastDay, 48)
    db.documents.push(doc)
  }

  // Board consents: one activity row per grant, worded the way approveGrants (src/domain/equity.ts) logs
  // them, so each row shows on the holder's activity too (names and dates only, no share counts).
  const approvedGrants = db.grants
    .filter((g) => !!g.boardApprovedOn)
    .sort((a, b) => (a.boardApprovedOn as ISODate).localeCompare(b.boardApprovedOn as ISODate))
  for (const g of approvedGrants) {
    const date = g.boardApprovedOn as ISODate
    const person = db.people.find((p) => p.id === g.personId)
    // Advisors are added after equity (./index order), so read their names from the contractor rows.
    const advisor = contractorRows().find((k) => k.id === g.personId)
    const name = person ? fullName(person) : advisor ? advisor.name : g.personId
    seedLog(db, date, 'p-founder', {
      entityType: 'equity',
      entityId: g.id,
      relatedId: g.personId,
      kind: 'grant_approved',
      text: `Board approved the option grant for ${name} (board date ${fmtDate(date)})`,
    })
  }
  seedLog(db, '2025-06-10', 'p-founder', {
    entityType: 'compliance',
    entityId: 'first-option-grant',
    kind: 'filing',
    text: 'Filed the California 25102(o) notice for the first option grant',
  })
  seedLog(db, '2026-02-24', 'p-founder', { entityType: 'equity', entityId: 'pool-seed', kind: 'pool_increased', text: 'Increased the option pool at the seed close' })
  seedLog(db, '2026-03-20', 'p-founder', {
    entityType: 'equity',
    entityId: 'v409a-2026',
    kind: 'valuation_added',
    text: 'Added the post-seed 409A valuation from Meridian Valuation Group',
  })
  seedLog(db, '2026-09-08', 'p-jasmine', {
    entityType: 'equity',
    entityId: 'g-aisha',
    kind: 'grant_queued',
    text: 'Queued an option grant for Aisha Bello for the next board consent',
  })
}
