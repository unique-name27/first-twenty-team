// Planted problems for the integrity tests (not used by the app). Each plant breaks the Ledgerlark sample in
// one way and returns the problems the checker must report, as describeProblem lines. They touch different
// records, so plantAll can apply every one to a single copy: src/domain/integrity.test.ts checks each alone
// and all together, and server/src/readmodel/readmodel.test.ts loads plantAll's copy into Postgres to
// compare v_integrity_problems with integrityProblems. everydayFlows is the other side: valid data written
// by the app's own flows, which neither the checker nor the view may report.
import { type Draft, produce } from 'immer'
import { approveOffer, markAccepted, markSent } from '@/domain/hiring/offers'
import { changeJobOrPay, hireFromOffer, offboardPerson, openJobFromPlan, startLeave } from '@/domain/lifecycle'
import { markPayRunSubmitted, setPayRunTotals } from '@/domain/payrun/records'
import { approveRequest, createRequest } from '@/domain/timeoff'
import type { DB, ID } from '@/domain/types'

export type Plant = { name: string; apply: (d: Draft<DB>) => string[] }

function find<T extends { id: ID }>(list: T[], id: ID): T {
  const r = list.find((x) => x.id === id)
  if (!r) throw new Error(`The sample has no record ${id}; update src/domain/integrityKit.ts`)
  return r
}

export const PLANTS: Plant[] = [
  {
    name: 'a manager who does not exist',
    apply(d) {
      find(d.people, 'p-kofi').managerId = 'p-nobody'
      return ['broken_reference people p-kofi managerId p-nobody']
    },
  },
  {
    name: 'a required field left empty',
    apply(d) {
      find(d.offers, 'o-hire-kofi').managerId = ''
      return ['broken_reference offers o-hire-kofi managerId -']
    },
  },
  {
    name: 'an interviewer id inside a job interview plan',
    apply(d) {
      find(d.jobs, 'j-founding-ml').interviewPlan[0].interviewerIds.push('p-ghost')
      return ['broken_reference jobs j-founding-ml interviewPlan[].interviewerIds[] p-ghost']
    },
  },
  {
    name: "an employee grant whose holder is not a person",
    apply(d) {
      find(d.grants, 'g-omar').personId = 'p-missing'
      return ['broken_reference grants g-omar personId p-missing']
    },
  },
  {
    name: 'a compliance owner who does not exist',
    apply(d) {
      d.complianceStatus['workers-comp'] = { ...d.complianceStatus['workers-comp'], ownerId: 'p-gone' }
      return ['broken_reference complianceStatus workers-comp ownerId p-gone']
    },
  },
  {
    name: 'equity history naming an unknown valuation',
    apply(d) {
      d.activity.push({ id: 'act-planted-equity', at: '2026-10-01T17:00:00.000Z', actorId: 'p-founder', entityType: 'equity', entityId: 'v409a-unknown', kind: 'note', text: 'Planted' })
      return ['broken_reference activity act-planted-equity entityId v409a-unknown']
    },
  },
  {
    name: 'a person who manages themselves',
    apply(d) {
      find(d.people, 'p-tomas').managerId = 'p-tomas'
      return ['self_reference people p-tomas managerId p-tomas']
    },
  },
  {
    name: 'an application in a stage its job does not have',
    apply(d) {
      find(d.applications, 'a-kenji-watanabe').stageId = 'no-such-stage'
      return ['stage_history_mismatch applications a-kenji-watanabe stageId technical', 'unknown_stage applications a-kenji-watanabe stageId no-such-stage']
    },
  },
  {
    name: 'stage history going back in time',
    apply(d) {
      find(d.applications, 'a-leila-moradi').history[1].at = '2026-09-01'
      return ['history_out_of_order applications a-leila-moradi history[].at -']
    },
  },
  {
    name: 'an interview step the job plan does not have',
    apply(d) {
      find(d.interviews, 'i-hire-tomas-2').stepId = 'step-gone'
      return ['unknown_step interviews i-hire-tomas-2 stepId step-gone']
    },
  },
  {
    name: 'a scorecard by someone not on the panel',
    apply(d) {
      find(d.scorecards, 's-hire-tomas-1-founder').interviewerId = 'p-aisha'
      return ['not_on_panel scorecards s-hire-tomas-1-founder interviewerId p-aisha']
    },
  },
  {
    name: "an offer whose candidate differs from its application's",
    apply(d) {
      find(d.offers, 'o-daniel-reyes').candidateId = 'c-simone-larsen'
      return ['mismatched_link offers o-daniel-reyes applicationId.candidateId a-daniel-reyes']
    },
  },
  {
    name: 'an application marked hired with no person and no offer',
    apply(d) {
      const app = { ...find(d.applications, 'a-teresa-cruz') }
      d.applications.push({ ...app, id: 'a-planted-hire', status: 'hired', stageId: 'hired', history: [...app.history, { stageId: 'hired', at: '2026-10-08' }], closedOn: '2026-10-08' })
      return ['hire_missing_offer applications a-planted-hire offers -', 'hire_missing_person applications a-planted-hire people -']
    },
  },
  {
    name: 'a hire without a starting pay row',
    apply(d) {
      for (const c of d.comp) if (c.personId === 'p-mei' && c.reason === 'hire') c.reason = 'correction'
      return ['hire_missing_comp applications a-hire-mei comp p-mei']
    },
  },
  {
    name: 'a hire without an onboarding checklist',
    apply(d) {
      for (const c of d.checklists) if (c.personId === 'p-aisha' && c.kind === 'onboarding') c.kind = 'change'
      return ['hire_missing_checklist applications a-hire-aisha checklists p-aisha']
    },
  },
  {
    name: 'time off that ends before it starts, next to a date that is not a day',
    apply(d) {
      const r = find(d.timeOffRequests, 'tr-tomas-1')
      r.startDate = '2025-11-27'
      // Feb 30 is not a date, so this pair is not compared (the read model's ft_as_date gives NULL too).
      find(d.timeOffRequests, 'tr-priya-1').endDate = '2025-02-30'
      return ['date_order timeOffRequests tr-tomas-1 startDate>endDate -']
    },
  },
  {
    name: 'two people with one employee number, two candidates with one email',
    apply(d) {
      find(d.people, 'p-ravi').hireNumber = find(d.people, 'p-aisha').hireNumber
      find(d.candidates, 'c-sergio-owusu').email = 'Simone.Larsen@example.net'
      // The record with the smaller id keeps the value; the other one is the duplicate.
      return ['duplicate_value candidates c-simone-larsen email c-sergio-owusu', 'duplicate_value people p-ravi hireNumber p-aisha']
    },
  },
  {
    name: 'a last day before the start date that is not a hire who never started',
    apply(d) {
      // No separation records it, and a separation whose last day differs from the end date.
      find(d.people, 'p-sofia').endDate = '2026-01-05'
      const caleb = find(d.people, 'p-caleb')
      caleb.endDate = '2026-02-20'
      caleb.separation = { type: 'resigned_notice', reason: 'Planted', lastDay: '2026-02-27' }
      return ['date_order people p-caleb startDate>endDate -', 'date_order people p-caleb startDate>separation.lastDay -', 'date_order people p-sofia startDate>endDate -']
    },
  },
  {
    name: 'a manager with a last day whose reports stay on',
    apply(d) {
      find(d.people, 'p-priya').endDate = '2026-12-31'
      return ['manager_leaving people p-hannah managerId p-priya', 'manager_leaving people p-mei managerId p-priya']
    },
  },
]

/** The sample with one plant applied, and the problems it must show. */
export function planted(base: DB, plant: Plant): { db: DB; expected: string[] } {
  let expected: string[] = []
  const db = produce(base, (d) => {
    expected = plant.apply(d)
  })
  return { db, expected: [...expected].sort() }
}

/** The sample with every plant applied, and every problem it must show. */
export function plantAll(base: DB): { db: DB; expected: string[] } {
  const expected: string[] = []
  const db = produce(base, (d) => {
    for (const plant of PLANTS) expected.push(...plant.apply(d))
  })
  return { db, expected: expected.sort() }
}

/** The day the everyday flows run on (the sample's anchor). */
export const FLOWS_DATE = '2026-10-09'

/**
 * The sample after the everyday flows, each through the same domain function the app calls: open a job from
 * the headcount plan, take an offer from approval to hire, offboard someone, offboard an incoming hire before
 * their start date (never started), request and approve time off, schedule a raise, start a leave, mark a pay
 * run submitted and enter totals for the next one. Nothing in it is a problem: the checks must stay quiet.
 * Run it with the clock set to FLOWS_DATE (setClockOverride), as the activity log reads the clock.
 */
export function everydayFlows(base: DB): DB {
  const date = FLOWS_DATE
  const ok = (r: { ok: boolean } | boolean, step: string) => {
    if (r === false || (typeof r === 'object' && !r.ok)) throw new Error(`The everyday flow "${step}" did not go through; update src/domain/integrityKit.ts`)
  }
  return produce(base, (d) => {
    openJobFromPlan(d, 'ps-q3-solutions', { date, hiringManagerId: 'p-tomas' })
    ok(approveOffer(d, 'o-daniel-reyes', { approverId: 'p-founder', at: '2026-10-09T17:00:00.000Z' }), 'approve the offer')
    ok(markSent(d, 'o-daniel-reyes', { date, force: true }), 'send the offer')
    ok(markAccepted(d, 'o-daniel-reyes', { date }), 'accept the offer')
    hireFromOffer(d, 'o-daniel-reyes', { date })
    offboardPerson(d, 'p-ravi', { type: 'resigned_notice', reason: 'Moving away', lastDay: '2026-10-30', noticeGivenOn: date }, { date })
    offboardPerson(d, 'p-lucas', { type: 'resigned_notice', reason: 'Took another offer', lastDay: '2026-10-12', noticeGivenOn: date }, { date })
    const request = createRequest(d, { personId: 'p-chris', policyId: 'pol-vacation', startDate: '2026-10-19', endDate: '2026-10-20' }, { date })
    ok(approveRequest(d, request.id, { date, approverId: 'p-elena' }), 'approve the time off')
    changeJobOrPay(d, 'p-chris', { effectiveOn: '2026-11-01', reason: 'merit', salary: 190000 }, { date })
    startLeave(d, { personId: 'p-hannah', kind: 'bonding', requestedOn: date, startDate: '2026-10-26', expectedReturn: '2026-12-21' }, { date })
    ok(markPayRunSubmitted(d, { start: '2026-10-01', end: '2026-10-15', payday: '2026-10-15' }, { date: '2026-10-13', actorId: 'p-jasmine' }), 'mark the pay run submitted')
    ok(setPayRunTotals(d, { start: '2026-10-16', end: '2026-10-31', payday: '2026-10-30' }, { gross: 98000, employerTaxes: 7500 }, { date }), 'enter pay run totals')
  })
}
