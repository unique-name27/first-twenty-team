// Ledgerlark sample: what the company has recorded against the compliance rule catalog
// (src/domain/compliance/rules.ts) and its recurring obligations. Done dates follow the story in
// docs/SAMPLE.md: workers' comp and EDD before the first payroll (2025-05-15), the 5-employee items
// before Kofi's start (2025-10-06), the 401(k) and CalSavers exemption in January 2026, Texas before
// Caleb's start, the first SB 294 notice on 2026-01-30. The SB 553 workplace violence prevention plan is
// deliberately not done: HQ typically has 11 people on site, so it applies with an open action.
// Yearly actions are stored per cycle ('send-annual@2026'), as setRuleActionDone would store them.
// Functions only (see ./company for why).
import type { Draft } from 'immer'
import type { ComplianceStatus, DB, RecurringItem } from '@/domain/types'
import type { ISODate } from '@/lib/dates'
import { seedLog } from './company'

type StatusSpec = {
  ruleId: string
  actions: Record<string, ISODate>
  /** Rule marked done on this date (otherwise the actions alone decide). */
  doneOn?: ISODate
  inProgress?: boolean
  ownerId?: string
  note?: string
}

function statusSpecs(): StatusSpec[] {
  return [
    // First hire and first payroll (May 2025)
    { ruleId: 'workers-comp', actions: { 'bind-policy': '2025-05-08', 'save-carrier': '2025-05-08', 'new-hire-pamphlet': '2025-05-12' }, doneOn: '2025-05-12', note: 'Policy with Golden Poppy Mutual.' },
    { ruleId: 'edd-registration', actions: { register: '2025-05-14', 'save-account': '2025-05-14' }, doneOn: '2025-05-14', note: 'Registered the day before the first payroll.' },
    { ruleId: 'new-hire-reporting', actions: { 'confirm-provider': '2025-05-14', 'onboarding-task': '2025-05-14' }, doneOn: '2025-05-14', note: 'The PEO files DE 34; each onboarding checklist tracks the confirmation.' },
    { ruleId: 'form-i9', actions: { 'current-edition': '2025-05-12', 'onboarding-tasks': '2025-05-12', retention: '2025-05-12' }, doneOn: '2025-05-12' },
    { ruleId: 'w4-de4', actions: { 'onboarding-task': '2025-05-12' }, doneOn: '2025-05-12' },
    { ruleId: 'paid-sick-leave', actions: { 'set-policy': '2025-05-01', 'pay-stub': '2025-05-15' }, doneOn: '2025-05-15', note: '40 hours front-loaded each January 1 and at hire.' },
    { ruleId: 'iipp', actions: { 'write-iipp': '2025-05-08', 'name-owner': '2025-05-08', 'safety-training': '2025-05-12' }, doneOn: '2025-05-12', ownerId: 'p-jasmine', note: 'Jasmine owns the IIPP since June 2026.' },
    { ruleId: 'posters-federal', actions: { 'poster-advisor': '2025-05-08', post: '2025-05-12' }, doneOn: '2025-05-12' },
    { ruleId: 'posters-california', actions: { 'post@2026': '2026-01-12', 'remote-copies@2026': '2026-01-12' } },
    { ruleId: 'posters-san-jose', actions: { 'post@2026': '2025-12-29' } },
    { ruleId: 'lactation-policy', actions: { 'write-policy': '2025-05-01', onboarding: '2025-05-12', space: '2025-07-01' }, doneOn: '2025-07-01', note: 'Wellness room in Suite 410.' },
    { ruleId: 'victims-leave-notice', actions: { onboarding: '2025-05-12', 'annual@2026': '2026-01-30' } },
    { ruleId: 'harassment-ban', actions: { 'complaint-path': '2025-05-01' }, doneOn: '2025-05-01' },
    { ruleId: 'salary-history-ban', actions: { interviewers: '2025-05-01', agencies: '2026-01-26' }, doneOn: '2026-01-26' },
    { ruleId: 'pay-scale-on-request', actions: { ranges: '2025-08-01', respond: '2025-08-01' }, doneOn: '2025-08-01' },
    { ruleId: 'wage-rate-history', actions: { 'keep-history': '2025-05-12' }, doneOn: '2025-05-12' },
    { ruleId: 'noncompete-notice', actions: { 'review-templates': '2025-05-01', 'void-notice': '2025-05-01' }, doneOn: '2025-05-01', note: 'No earlier contract had a noncompete.' },
    { ruleId: 'stay-or-pay-ban', actions: { 'review-offers': '2026-09-22' }, inProgress: true, ownerId: 'p-jasmine', note: 'Offer template reviewed; sign-on bonus language still to move into a separate agreement.' },
    // First contractor, first grant, first out-of-state employee, first non-founder manager
    { ruleId: 'first-contractor', actions: { 'ab5-check': '2025-05-27', de542: '2026-04-14', w9: '2025-05-28', 'form-1099@2026': '2026-01-28' }, note: 'Northline and Studio Fieldnote received 1099-NEC forms for last year.' },
    { ruleId: 'first-option-grant', actions: { 'get-409a': '2025-05-01', 'file-25102o': '2025-06-10', 'board-consent': '2025-05-28' }, doneOn: '2025-06-10' },
    { ruleId: 'calsavers-or-401k', actions: { 'choose-plan': '2025-11-20', 'file-exemption': '2026-01-05' }, doneOn: '2026-01-05', note: '401(k) through the PEO from January 2026, no match. CalSavers exemption filed.' },
    { ruleId: 'first-out-of-state-employee', actions: { 'register-state': '2026-02-20', 'electronic-posting': '2026-03-02', reimbursement: '2026-03-02', 'state-card': '2026-02-20' }, doneOn: '2026-03-02', note: 'Texas withholding and unemployment registration through the PEO for Caleb.' },
    { ruleId: 'first-non-founder-manager', actions: { 'supervisor-training': '2025-10-06', 'manager-basics': '2025-10-06' }, doneOn: '2025-10-06' },
    { ruleId: 'first-remote-employee', actions: { 'electronic-posting': '2026-01-12', reimbursement: '2026-01-12' }, doneOn: '2026-01-12', note: 'Set up for Sofia (remote in Oakland): notices by email and a monthly internet and phone stipend.' },
    { ruleId: 'first-group-health-plan', actions: { 'carrier-notice': '2025-05-12', 'offboarding-notices': '2025-05-12', 'aca-pointer': '2025-05-12' }, doneOn: '2025-05-12', note: 'Medical, dental and vision through the PEO, which sends the continuation notices.' },
    // Five employees (October 2025)
    { ruleId: 'harassment-info-sheet', actions: { 'add-to-packet': '2025-10-01', distribute: '2025-10-01' }, doneOn: '2025-10-01' },
    { ruleId: 'feha', actions: { accommodation: '2025-10-01', notices: '2025-10-01' }, doneOn: '2025-10-01' },
    { ruleId: 'harassment-policy', actions: { adopt: '2025-10-01', acknowledgements: '2025-10-06' }, doneOn: '2025-10-06', note: 'Written policy adopted ahead of the fifth hire.' },
    { ruleId: 'harassment-training', actions: { assign: '2025-09-02', 'crd-course': '2025-09-02', certificates: '2025-11-18' }, doneOn: '2025-11-18' },
    { ruleId: 'cfra-pdl', actions: { handbook: '2025-10-01', notices: '2025-10-01', 'leave-cases': '2025-10-06' }, doneOn: '2025-10-06' },
    { ruleId: 'bereavement-reproductive-loss', actions: { 'turn-on': '2025-10-06', handbook: '2025-10-01' }, doneOn: '2025-10-06' },
    { ruleId: 'fair-chance-act', actions: { postings: '2025-10-01', process: '2025-10-01' }, doneOn: '2025-10-01' },
    { ruleId: 'crd-ads-regulations', actions: { vendors: '2025-10-15', retention: '2025-10-06' }, doneOn: '2025-10-15', note: 'No automated screening tools in use.' },
    { ruleId: 'sb700-cannabis', actions: { 'review-forms': '2025-10-01' }, doneOn: '2025-10-01' },
    { ruleId: 'records-retention', actions: { requests: '2025-10-01', retention: '2025-10-01' }, doneOn: '2025-10-01' },
    // 2026
    { ruleId: 'sb294-annual-notice', actions: { 'send-annual@2026': '2026-01-30', 'record-dates@2026': '2026-01-30', 'year-2026': '2026-01-30' }, note: 'First yearly notice delivered to everyone by email.' },
    { ruleId: 'sb294-new-hire', actions: { 'onboarding-notice': '2026-01-02', 'emergency-contact': '2026-03-20' }, doneOn: '2026-03-20', note: 'Existing staff were offered the arrest-notification contact before the March 30 deadline.' },
    { ruleId: 'cal-cobra', actions: { 'offboarding-task': '2026-08-14' }, doneOn: '2026-08-14', note: 'The PEO administers continuation coverage.' },
    { ruleId: 'iipp-records', actions: { 'inspection-records': '2026-05-15', 'training-records': '2026-05-15' }, doneOn: '2026-05-15' },
    { ruleId: 'first-non-exempt-hire', actions: { timekeeping: '2026-07-15', 'meal-rest': '2026-07-15', 'sick-accrual': '2026-07-15' }, doneOn: '2026-07-15', note: 'Set up for Luis (part time, hourly).' },
    { ruleId: 'wage-notice-2810-5', actions: { template: '2026-07-10', onboarding: '2026-07-10', 'change-notices': '2026-07-10' }, doneOn: '2026-07-10' },
    { ruleId: 'first-separation', actions: { 'final-pay': '2026-08-14', notices: '2026-08-28', access: '2026-08-28' }, doneOn: '2026-08-28' },
    { ruleId: 'first-visa-sponsorship', actions: { counsel: '2026-10-07' }, inProgress: true, ownerId: 'p-jasmine', note: "Mei Tanaka's H-1B transfer: counsel engaged. LCA posting and the public access file are next." },
    // Deliberately absent: 'wvpp' (SB 553 plan not written yet).
  ]
}

function recurringItems(): RecurringItem[] {
  return [
    {
      id: 'rec-soc2-access-review',
      title: 'Quarterly access review (SOC 2)',
      cadence: 'quarterly',
      nextDueOn: '2026-10-31',
      lastDoneOn: '2026-07-30',
      ownerId: 'p-nikhil',
      ruleId: 'soc2-access-review',
      link: 'https://example.com/it/access-reviews',
      notes: 'Review who can reach production, customer data, the PEO and banking, and remove what is no longer needed.',
    },
    {
      id: 'rec-409a',
      title: 'Annual 409A valuation refresh',
      cadence: 'annual',
      nextDueOn: '2027-02-19',
      lastDoneOn: '2026-03-20',
      ownerId: 'p-jasmine',
      notes: 'Order it about a month before the current valuation expires, and again after any priced round.',
    },
    {
      id: 'rec-rate-review',
      title: 'Review January 1 rate and law changes',
      cadence: 'annual',
      nextDueOn: '2027-01-01',
      lastDoneOn: '2026-01-05',
      ownerId: 'p-jasmine',
      ruleId: 'rate-review',
      notes: 'State and San Jose minimum wage, exempt salary floor, computer professional minimum and posters. Update Settings, Rules and rates.',
    },
    {
      id: 'rec-sb294',
      title: 'SB 294 workplace rights notice to every employee',
      cadence: 'annual',
      nextDueOn: '2027-02-01',
      lastDoneOn: '2026-01-30',
      ownerId: 'p-jasmine',
      ruleId: 'sb294-annual-notice',
      notes: 'Send the Labor Commissioner template with the survivors of violence leave notice. Keep the date sent for 3 years.',
    },
    {
      id: 'rec-1099',
      title: 'File 1099-NEC forms for contractors',
      cadence: 'annual',
      nextDueOn: '2027-01-31',
      lastDoneOn: '2026-01-28',
      ownerId: 'p-jasmine',
      ruleId: 'first-contractor',
      link: 'https://www.irs.gov/instructions/i1099mec',
      notes: 'For contractors paid at or above the 1099-NEC threshold last year (corporations are exempt). When the due date falls on a weekend, file by the next business day.',
    },
  ]
}

export function applyCompliance(db: Draft<DB>): void {
  for (const s of statusSpecs()) {
    const status: ComplianceStatus = { actionsDone: { ...s.actions } }
    if (s.doneOn) {
      status.status = 'done'
      status.doneOn = s.doneOn
    } else if (s.inProgress) status.status = 'in_progress'
    if (s.ownerId) status.ownerId = s.ownerId
    if (s.note) status.note = s.note
    db.complianceStatus[s.ruleId] = status
  }
  // SOC 2 quarterly access reviews, keyed by quarter (markAccessReviewDone).
  db.complianceStatus['soc2-access-review'] = {
    actionsDone: { '2026-Q1': '2026-01-29', '2026-Q2': '2026-04-28', '2026-Q3': '2026-07-30' },
    ownerId: 'p-nikhil',
  }
  db.recurring.push(...recurringItems())

  seedLog(db, '2025-05-14', 'p-founder', { entityType: 'compliance', entityId: 'edd-registration', kind: 'compliance_status', text: 'Marked done: EDD employer registration (DE 1)' })
  seedLog(db, '2025-10-06', 'p-founder', { entityType: 'compliance', entityId: 'harassment-policy', kind: 'compliance_status', text: 'Marked done: Written harassment and discrimination policy' })
  seedLog(db, '2026-01-05', 'p-founder', { entityType: 'compliance', entityId: 'calsavers-or-401k', kind: 'compliance_status', text: 'Marked done: CalSavers or a retirement plan' })
  seedLog(db, '2026-01-30', 'p-founder', { entityType: 'compliance', entityId: 'sb294-annual-notice', kind: 'compliance_annual', text: 'Done for this year: SB 294 workplace rights notice (every Feb 1)' })
  seedLog(db, '2026-07-30', 'p-nikhil', { entityType: 'compliance', entityId: 'soc2-access-review', kind: 'access_review_done', text: 'Recorded the quarterly access review (SOC 2)' })
}
