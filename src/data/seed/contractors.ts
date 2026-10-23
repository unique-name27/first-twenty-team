// Ledgerlark sample: contractors and advisors (docs/SAMPLE.md). Contractors never count toward headcount,
// but they do count toward the 5-person harassment training threshold (Gov Code 12950.1). Advisors hold
// NSO grants (see ./equity) and have no checklist. Functions only (see ./company for why).
import type { Draft } from 'immer'
import type { Contractor, DB } from '@/domain/types'
import { seedLog } from './company'

/** The contractor and advisor rows, also used by ./people to count the workforce on past dates. */
export function contractorRows(): Contractor[] {
  return [
    {
      id: 'k-northline',
      kind: 'contractor',
      name: 'Dana Whitaker',
      entityName: 'Northline Finance Partners LLC',
      entityType: 'llc',
      email: 'dana.whitaker@example.com',
      scope: 'Fractional CFO: monthly close review, board reporting, cash forecasting and the audit plan.',
      rate: 6_500,
      rateUnit: 'month',
      hoursPerWeek: 8,
      startOn: '2025-06-01',
      endOn: null,
      managerId: 'p-founder',
      departmentId: 'd-exec',
      state: 'CA',
      ab5: {
        exemption: 'b2b',
        a: true,
        b: true,
        c: true,
        assessedOn: '2025-05-27',
        note: 'Own firm with other clients, sets its own hours and methods, and finance leadership is outside our usual course of business.',
      },
      w9OnFile: true,
      agreementSignedOn: '2025-05-28',
      notes: 'An LLC, so no DE 542 is needed. Send a 1099-NEC each January.',
    },
    {
      id: 'k-marisol',
      kind: 'contractor',
      name: 'Marisol Vega',
      entityType: 'individual',
      email: 'marisol.vega@example.com',
      scope: 'Reviews close-agent outputs and labels reconciliation data for model evals.',
      rate: 85,
      rateUnit: 'hour',
      hoursPerWeek: 25,
      startOn: '2026-04-01',
      endOn: null,
      managerId: 'p-elena',
      departmentId: 'd-acct',
      state: 'CA',
      ab5: {
        exemption: 'none',
        a: false,
        b: false,
        c: true,
        assessedOn: '2026-09-28',
        note: 'Works set weekly hours in our tools under Elena\'s direction (A fails) on the core product (B fails). She does run her own CPA practice (C passes). Likely an employee: convert or restructure, and ask counsel.',
      },
      w9OnFile: true,
      de542FiledOn: '2026-04-14',
      agreementSignedOn: '2026-03-27',
      notes: 'Could fit the open Solutions accountant (CPA) role.',
    },
    {
      id: 'k-fieldnote',
      kind: 'contractor',
      name: 'Studio Fieldnote',
      entityName: 'Studio Fieldnote LLC',
      entityType: 'llc',
      email: 'hello.fieldnote@example.com',
      scope: 'Brand identity and marketing website project.',
      rate: 38_000,
      rateUnit: 'project',
      startOn: '2025-11-01',
      endOn: '2026-02-28',
      managerId: 'p-founder',
      departmentId: 'd-product',
      state: 'CA',
      ab5: {
        exemption: 'b2b',
        a: true,
        b: true,
        c: true,
        assessedOn: '2025-10-22',
        note: 'Design agency with its own staff and clients, fixed-fee project with its own methods.',
      },
      w9OnFile: true,
      agreementSignedOn: '2025-10-24',
      notes: 'Project complete. An LLC, so no DE 542.',
    },
    {
      id: 'k-adv-whitfield',
      kind: 'advisor',
      name: 'Carol Whitfield',
      entityType: 'individual',
      email: 'carol.whitfield@example.com',
      scope: 'Advisor: former public-company CFO. Controller buyer insight, audit readiness and finance hiring.',
      rate: 0,
      rateUnit: 'month',
      hoursPerWeek: 1,
      startOn: '2025-07-01',
      endOn: null,
      managerId: 'p-founder',
      departmentId: 'd-exec',
      state: 'CA',
      ab5: { exemption: 'none', a: true, b: true, c: true, assessedOn: '2025-06-24', note: 'Advisor paid in options only; sets her own schedule and advises several companies.' },
      w9OnFile: true,
      agreementSignedOn: '2025-06-26',
      notes: 'Two-year advisor agreement. Options vest monthly with no cliff.',
    },
    {
      id: 'k-adv-osei',
      kind: 'advisor',
      name: 'Dr. Daniel Osei',
      entityType: 'individual',
      email: 'daniel.osei@example.com',
      scope: 'Advisor: AI researcher. Agent evaluation methods and model risk.',
      rate: 0,
      rateUnit: 'month',
      hoursPerWeek: 1,
      startOn: '2026-04-01',
      endOn: null,
      managerId: 'p-priya',
      departmentId: 'd-ai',
      state: 'CA',
      ab5: { exemption: 'none', a: true, b: true, c: true, assessedOn: '2026-03-25', note: 'Advisor paid in options only; keeps his university research role.' },
      w9OnFile: true,
      agreementSignedOn: '2026-03-30',
      notes: 'Two-year advisor agreement. Options vest monthly with no cliff.',
    },
  ]
}

export function applyContractors(db: Draft<DB>): void {
  for (const row of contractorRows()) {
    db.contractors.push(row)
    const name = row.entityName || row.name
    seedLog(db, row.agreementSignedOn ?? row.startOn, 'p-founder', {
      entityType: 'contractor',
      entityId: row.id,
      kind: 'contractor_added',
      text: row.kind === 'advisor' ? `Added ${name} as an advisor` : `Added ${name} as a contractor`,
    })
  }
  seedLog(db, '2026-09-28', 'p-jasmine', {
    entityType: 'contractor',
    entityId: 'k-marisol',
    kind: 'ab5_checked',
    text: 'Ran the AB5 check for Marisol Vega: likely an employee',
  })
}
