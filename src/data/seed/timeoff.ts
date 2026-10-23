// Ledgerlark sample: time off requests across 2025-2026 and Tomas's protected leave (docs/SAMPLE.md).
// Requests go through the real flow (createRequest, approveRequest) so hours skip weekends and company
// holidays; vacation stays within what each person has accrued (15 days a year, earned per pay period).
// Sick leave is California's front-loaded 40 hours a year, usable from day 90 (Labor Code 246).
// Functions only (see ./company for why).
import type { Draft } from 'immer'
import { startLeave } from '@/domain/lifecycle'
import { approveRequest, createRequest } from '@/domain/timeoff'
import type { DB, ID } from '@/domain/types'
import { addBusinessDays, type ISODate } from '@/lib/dates'
import { restampActivity } from './company'

type RequestSpec = {
  id: ID
  personId: ID
  policyId: 'pol-vacation' | 'pol-sick'
  startDate: ISODate
  endDate: ISODate
  requestedOn: ISODate
  /** Approver and decision date for vacation; omitted while pending. Sick leave approves itself. */
  approverId?: ID
  decidedOn?: ISODate
  pending?: boolean
  note?: string
  decisionNote?: string
}

function requestSpecs(): RequestSpec[] {
  const v = 'pol-vacation' as const
  const s = 'pol-sick' as const
  return [
    // 2025
    { id: 'tr-tomas-1', personId: 'p-tomas', policyId: v, startDate: '2025-11-24', endDate: '2025-11-26', requestedOn: '2025-10-27', approverId: 'p-founder' },
    { id: 'tr-elena-1', personId: 'p-elena', policyId: s, startDate: '2025-12-03', endDate: '2025-12-03', requestedOn: '2025-12-03' },
    { id: 'tr-priya-1', personId: 'p-priya', policyId: v, startDate: '2025-12-22', endDate: '2025-12-23', requestedOn: '2025-11-17', approverId: 'p-founder' },
    { id: 'tr-maya-1', personId: 'p-founder', policyId: v, startDate: '2025-12-26', endDate: '2025-12-31', requestedOn: '2025-12-01', note: 'Out between the holidays.' },
    { id: 'tr-elena-2', personId: 'p-elena', policyId: v, startDate: '2025-12-29', endDate: '2025-12-31', requestedOn: '2025-12-02', approverId: 'p-founder' },
    // 2026
    { id: 'tr-kofi-1', personId: 'p-kofi', policyId: s, startDate: '2026-01-27', endDate: '2026-01-27', requestedOn: '2026-01-27' },
    { id: 'tr-tomas-2', personId: 'p-tomas', policyId: s, startDate: '2026-02-03', endDate: '2026-02-03', requestedOn: '2026-02-03' },
    { id: 'tr-kofi-2', personId: 'p-kofi', policyId: v, startDate: '2026-02-17', endDate: '2026-02-20', requestedOn: '2026-01-20', approverId: 'p-tomas' },
    { id: 'tr-tomas-3', personId: 'p-tomas', policyId: v, startDate: '2026-03-23', endDate: '2026-03-27', requestedOn: '2026-02-23', approverId: 'p-founder' },
    { id: 'tr-sofia-1', personId: 'p-sofia', policyId: s, startDate: '2026-04-20', endDate: '2026-04-20', requestedOn: '2026-04-20' },
    { id: 'tr-priya-2', personId: 'p-priya', policyId: v, startDate: '2026-04-13', endDate: '2026-04-17', requestedOn: '2026-03-16', approverId: 'p-founder' },
    { id: 'tr-sofia-2', personId: 'p-sofia', policyId: v, startDate: '2026-05-22', endDate: '2026-05-22', requestedOn: '2026-05-04', approverId: 'p-founder' },
    { id: 'tr-elena-3', personId: 'p-elena', policyId: v, startDate: '2026-05-26', endDate: '2026-05-29', requestedOn: '2026-04-27', approverId: 'p-founder' },
    { id: 'tr-caleb-1', personId: 'p-caleb', policyId: v, startDate: '2026-06-29', endDate: '2026-07-02', requestedOn: '2026-06-01', approverId: 'p-founder' },
    { id: 'tr-omar-1', personId: 'p-omar', policyId: v, startDate: '2026-07-02', endDate: '2026-07-02', requestedOn: '2026-06-15', approverId: 'p-tomas' },
    { id: 'tr-maya-2', personId: 'p-founder', policyId: v, startDate: '2026-07-06', endDate: '2026-07-10', requestedOn: '2026-06-08' },
    { id: 'tr-hannah-1', personId: 'p-hannah', policyId: v, startDate: '2026-07-06', endDate: '2026-07-08', requestedOn: '2026-06-10', approverId: 'p-priya' },
    { id: 'tr-kofi-3', personId: 'p-kofi', policyId: v, startDate: '2026-07-06', endDate: '2026-07-07', requestedOn: '2026-06-12', approverId: 'p-tomas' },
    { id: 'tr-jasmine-1', personId: 'p-jasmine', policyId: v, startDate: '2026-08-14', endDate: '2026-08-14', requestedOn: '2026-07-27', approverId: 'p-founder' },
    { id: 'tr-tomas-4', personId: 'p-tomas', policyId: v, startDate: '2026-08-17', endDate: '2026-08-21', requestedOn: '2026-07-20', approverId: 'p-founder' },
    { id: 'tr-sofia-3', personId: 'p-sofia', policyId: v, startDate: '2026-08-24', endDate: '2026-08-28', requestedOn: '2026-07-29', approverId: 'p-founder' },
    { id: 'tr-chris-1', personId: 'p-chris', policyId: v, startDate: '2026-09-04', endDate: '2026-09-04', requestedOn: '2026-08-20', approverId: 'p-elena' },
    { id: 'tr-nikhil-1', personId: 'p-nikhil', policyId: v, startDate: '2026-09-08', endDate: '2026-09-11', requestedOn: '2026-08-10', approverId: 'p-tomas' },
    { id: 'tr-hannah-2', personId: 'p-hannah', policyId: s, startDate: '2026-09-21', endDate: '2026-09-21', requestedOn: '2026-09-21' },
    { id: 'tr-luis-1', personId: 'p-luis', policyId: s, startDate: '2026-10-02', endDate: '2026-10-02', requestedOn: '2026-10-02', decisionNote: 'Approved before the 90-day wait; California lets employers allow earlier use.' },
    // Seeded situations: Elena out Oct 12-16, Priya Dec 21-31, and two requests waiting for a decision.
    { id: 'tr-priya-3', personId: 'p-priya', policyId: v, startDate: '2026-12-21', endDate: '2026-12-31', requestedOn: '2026-09-14', approverId: 'p-founder' },
    { id: 'tr-elena-4', personId: 'p-elena', policyId: v, startDate: '2026-10-12', endDate: '2026-10-16', requestedOn: '2026-09-21', approverId: 'p-founder' },
    { id: 'tr-caleb-2', personId: 'p-caleb', policyId: v, startDate: '2026-11-23', endDate: '2026-11-25', requestedOn: '2026-10-05', pending: true, note: 'Thanksgiving week with family.' },
    { id: 'tr-kofi-4', personId: 'p-kofi', policyId: v, startDate: '2026-10-30', endDate: '2026-10-30', requestedOn: '2026-10-08', pending: true },
  ]
}

export function applyTimeoff(db: Draft<DB>): void {
  const holidays = db.holidays.map((h) => h.date)
  const specs = [...requestSpecs()].sort((a, b) => a.requestedOn.localeCompare(b.requestedOn))
  for (const s of specs) {
    const mark = db.activity.length
    createRequest(db, { personId: s.personId, policyId: s.policyId, startDate: s.startDate, endDate: s.endDate, ...(s.note ? { note: s.note } : {}) }, { date: s.requestedOn, id: s.id })
    restampActivity(db, mark, s.requestedOn, s.personId)
    const req = db.timeOffRequests.find((r) => r.id === s.id)
    if (!req) continue
    if (s.policyId === 'pol-sick') {
      if (s.decisionNote) req.decisionNote = s.decisionNote
      continue
    }
    if (s.pending) continue
    // The founder's own vacation is recorded by her as admin; everyone else's by their manager.
    const approverId = s.approverId ?? 'p-founder'
    const decidedOn = s.decidedOn ?? addBusinessDays(s.requestedOn, 1, holidays)
    const decided = db.activity.length
    approveRequest(db, s.id, { date: decidedOn, approverId, ...(s.decisionNote ? { note: s.decisionNote } : {}) })
    restampActivity(db, decided, decidedOn, approverId)
  }

  // Tomas: CFRA baby-bonding leave, requested Tue Oct 6 for Nov 16 to Jan 8. The designation notice
  // (5 business days, so Tue Oct 13) has not been sent yet.
  const mark = db.activity.length
  const leaveId = startLeave(
    db,
    {
      personId: 'p-tomas',
      kind: 'bonding',
      requestedOn: '2026-10-06',
      startDate: '2026-11-16',
      expectedReturn: '2027-01-11', // first day back (leave runs through Fri Jan 8)
      note: 'CFRA baby bonding. Kofi covers engineering standups and Ravi covers code review approvals.',
    },
    { date: '2026-10-06', actorId: 'p-jasmine' },
  )
  restampActivity(db, mark, '2026-10-06', 'p-jasmine')
  const leave = db.leaveCases.find((l) => l.id === leaveId)
  if (leave) leave.id = 'lc-tomas-bonding'
  for (const a of db.activity) if (a.entityId === leaveId) a.entityId = 'lc-tomas-bonding'
  const checklist = db.checklists.find((c) => c.personId === 'p-tomas' && c.kind === 'leave')
  if (checklist) {
    checklist.id = 'ck-leave-tomas'
    for (const t of checklist.tasks) {
      t.id = `t-leave-tomas-${t.templateTaskId ?? t.id}`
      // Shared the EDD link and the policy packet the day after the request.
      if (t.templateTaskId === 'lv-edd' || t.templateTaskId === 'lv-lactation') {
        t.status = 'done'
        t.doneOn = '2026-10-07'
        t.doneById = 'p-jasmine'
      }
    }
  }
}
