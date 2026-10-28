// The read model: views that make the server's database readable with plain SQL (docs/DEV.md, "Query the
// data with SQL"; ready-made queries in server/deploy/browse.sql). Records stay one JSONB row each and the
// app stays the only writer; these views only read. Every field a view names is a typed path into
// src/domain/types.ts, so a misspelled or renamed field fails `npm run typecheck`.
//
// How a change ships. This file and the checks in src/domain/integrity.ts are the source; the SQL is
// generated (generate.ts) and committed as a migration:
//   1. Change this file (or the integrity checks).
//   2. Run `npm run server:gen-sql -- --read-model --write`. It saves the whole read model as the next
//      migration, server/sql/NNN_read_model.sql, which drops every read-model view and creates them all
//      again, so no applied migration ever changes. (If the newest NNN_read_model.sql is one your own branch
//      added and it is not on main yet, use --replace instead, which rewrites that file.)
//   3. readmodel.test.ts fails until the newest NNN_read_model.sql equals the generator's output.
// A view removed from this file goes into RETIRED_VIEWS, so the next migration drops it.
//
// Rules for every view (the generator and readmodel.test.ts enforce them): workspace_id first (filter on it
// to read one company), then the row's own id; security_invoker, so a login reads through a view only what
// it may read in the tables; only the record tables, workspace_docs and workspaces, never users, sessions,
// trusted_devices or invites; plain views, no triggers, nothing on the write path.
import type { Application, Department, Job, JobStage, LeaveCase, Person } from '../../../src/domain/types'
import { F, Fields } from './columns'
import { integrityViewSql } from './integritySql'
import { collectionView, docListView, listView, sqlView, type View } from './views'

/** Names of views an earlier read model created that this one no longer has; the next migration drops them. */
export const RETIRED_VIEWS: readonly string[] = []

// Field names for the SQL written by hand below, checked against the types like every other field.
const A = F<Application>()
const D = F<Department>()
const J = F<Job>()
const L = F<LeaveCase>()
const S = F<JobStage>()

/** The name or kind of the job stage an application sits in (from the job's stage list). */
function stageField(field: 'name' | 'kind'): string {
  return `(SELECT NULLIF(s.el ->> ${S(field)}, '') FROM jobs j CROSS JOIN LATERAL jsonb_array_elements(ft_array(j.data -> ${J('stages')})) AS s(el)
            WHERE j.workspace_id = r.workspace_id AND j.id = r.data ->> ${A('jobId')} AND s.el ->> ${S('id')} = r.data ->> ${A('stageId')} LIMIT 1)`
}

export const READ_MODEL: readonly View[] = [
  collectionView('v_people', 'people', 'Employees (W-2), one row per person record. Contractors and advisors are not here.', (f) => [
    f.int('hireNumber'),
    f.text('firstName'),
    f.text('lastName'),
    f.text('preferredName'),
    f.sql('full_name', 'text', `concat_ws(' ', coalesce(${f.text('preferredName').sql}, ${f.text('firstName').sql}), ${f.text('lastName').sql})`),
    f.text('workEmail'),
    f.text('title'),
    f.text('departmentId'),
    f.lookup('departmentId', 'departments', 'name', 'department_name'),
    f.text('familyId'),
    f.text('levelId'),
    f.lookup('levelId', 'levels', 'code', 'level_code'),
    f.text('managerId'),
    f.text('locationId'),
    f.lookup('locationId', 'locations', 'name', 'location_name'),
    f.text('workMode'),
    f.text('homeCity'),
    f.text('homeState'),
    f.text('employmentType'),
    f.num('hoursPerWeek'),
    f.text('flsa'),
    f.text('exemptionBasis'),
    f.date('startDate'),
    f.date('endDate'),
    f.bool('isFounder'),
    f.text('payrollId'),
    f.text('fromCandidateId'),
    f.text('fromApplicationId'),
    f.text('rehireOfPersonId'),
    f.text('fromContractorId'),
    f.text('separation.type', 'separation_type'),
    f.date('separation.noticeGivenOn', 'notice_given_on'),
    f.date('separation.lastDay', 'last_day'),
    f.text('backgroundCheck.status', 'background_check_status'),
    f.date('i9ReverifyOn', 'i9_reverify_on'),
  ]),

  collectionView('v_comp', 'comp', 'Job and pay history: one row per effective-dated change. The newest row on or before a date is the job and pay on that date.', (f) => [
    f.text('personId'),
    f.date('effectiveOn'),
    f.text('reason'),
    f.text('payType'),
    f.num('salary'),
    f.num('hourlyRate'),
    f.num('variablePct'),
    f.text('title'),
    f.text('levelId'),
    f.text('managerId'),
    f.text('departmentId'),
    f.text('flsa'),
    f.text('exemptionBasis'),
    f.text('exceptionReason'),
    f.text('approvedById'),
    f.date('approvedOn'),
    f.date('appliedOn'),
    f.bool('scheduled'),
  ]),

  collectionView('v_jobs', 'jobs', 'Jobs (requisitions and postings), with the posted pay range.', (f) => [
    f.text('title'),
    f.text('status'),
    f.text('priority'),
    f.text('departmentId'),
    f.lookup('departmentId', 'departments', 'name', 'department_name'),
    f.text('familyId'),
    f.text('levelId'),
    f.text('hiringManagerId'),
    f.text('workMode'),
    f.text('employmentType'),
    f.text('flsa'),
    f.num('payMin'),
    f.num('payMax'),
    f.num('equityMinPct'),
    f.num('equityMaxPct'),
    f.date('openedOn'),
    f.date('postedOn'),
    f.date('closedOn'),
    f.date('targetStart'),
    f.text('planSlotId'),
    f.text('roleTemplateId'),
    f.bool('isBackfill'),
    f.text('backfillForPersonId'),
    f.text('sponsorship'),
    f.bool('backgroundCheck'),
    f.num('referralBonus'),
    f.count('stages', 'stage_count'),
    f.count('panelIds', 'panel_size'),
    f.text('requisition.status', 'requisition_status'),
    f.text('requisition.requestedById', 'requisition_requested_by_id'),
    f.date('requisition.requestedOn', 'requisition_requested_on'),
  ]),

  collectionView('v_candidates', 'candidates', 'Candidates. Desired pay only: California bans asking about current or past pay.', (f) => [
    f.text('firstName'),
    f.text('lastName'),
    f.text('email'),
    f.text('location'),
    f.text('timezone'),
    f.text('currentTitle'),
    f.text('currentCompany'),
    f.text('source'),
    f.text('sourceDetail'),
    f.text('referrerId'),
    f.num('desiredPay'),
    f.text('desiredPayUnit'),
    f.text('sponsorship'),
    f.joined('tags'),
    f.date('createdOn'),
    f.date('retainUntil'),
    f.bool('archived'),
    f.date('anonymizedOn'),
  ]),

  collectionView('v_applications', 'applications', 'Applications: one candidate for one job, with the stage it is in.', (f) => [
    f.text('candidateId'),
    f.text('jobId'),
    f.text('stageId'),
    f.sql('stage_name', 'text', stageField('name')),
    f.sql('stage_kind', 'text', stageField('kind')),
    f.text('status'),
    f.date('appliedOn'),
    f.date('stageEnteredOn'),
    // History starts with the stage the application entered first, so the moves are one fewer.
    f.sql('stage_moves', 'integer', `greatest(${f.count('history', 'stage_moves').sql} - 1, 0)`),
    f.date('nextStep.dueOn', 'next_step_due_on'),
    f.text('nextStep.ownerId', 'next_step_owner_id'),
    f.date('snoozedUntil'),
    f.date('lastContactOn'),
    f.text('outcomeReason'),
    f.date('closedOn'),
    f.date('notifiedOn'),
    f.date('conditionalOfferOn'),
  ]),

  collectionView('v_offers', 'offers', 'Offers, one row per offer record (offer_version counts revisions of one offer).', (f) => [
    f.text('applicationId'),
    f.text('candidateId'),
    f.text('jobId'),
    f.int('version', 'offer_version'),
    f.text('status'),
    f.text('title'),
    f.text('levelId'),
    f.text('familyId'),
    f.text('departmentId'),
    f.text('managerId'),
    f.text('locationId'),
    f.text('workMode'),
    f.text('employmentType'),
    f.num('hoursPerWeek'),
    f.text('flsa'),
    f.text('exemptionBasis'),
    f.text('payType'),
    f.num('salary'),
    f.num('hourlyRate'),
    f.num('variablePct'),
    f.num('signOnBonus'),
    f.text('equityType'),
    f.num('equityShares'),
    f.int('vestingMonths'),
    f.int('cliffMonths'),
    f.date('startDate'),
    f.date('expiresOn'),
    f.joined('contingencies'),
    f.date('createdOn'),
    f.text('draftedById'),
    f.countWhere('approvals', { decision: 'approved' }, 'approval_count'),
    f.countWhere('approvals', { decision: 'changes_requested' }, 'changes_requested_count'),
    f.date('sentOn'),
    f.date('decidedOn'),
    f.text('backgroundCheck.status', 'background_check_status'),
    f.text('backgroundCheck.result', 'background_check_result'),
    f.text('personId'),
  ]),

  collectionView('v_checklists', 'checklists', 'Onboarding, offboarding, new-state, leave and change checklists, with task counts.', (f) => [
    f.text('personId'),
    f.text('kind'),
    f.text('templateId'),
    f.date('anchorDate'),
    f.text('separationType'),
    f.date('createdOn'),
    f.date('completedOn'),
    f.count('tasks', 'tasks_total'),
    f.countWhere('tasks', { status: 'done' }, 'tasks_done'),
    f.countWhere('tasks', { status: 'open' }, 'tasks_open'),
    f.countWhere('tasks', { status: 'not_applicable' }, 'tasks_not_applicable'),
    f.countWhere('tasks', { status: 'open', statutory: true }, 'statutory_open'),
    f.earliestWhere('tasks', 'dueOn', { status: 'open' }, 'next_due_on'),
  ]),

  collectionView('v_grants', 'grants', 'Equity grants. Holders are employees, advisors, contractors, or candidates while an offer is out (holder_type).', (f) => [
    f.text('personId', 'holder_id'),
    f.text('holderType'),
    f.text('type', 'grant_type'),
    f.text('status'),
    f.num('shares'),
    f.num('strikePrice'),
    f.date('vestingStart'),
    f.int('cliffMonths'),
    f.int('vestingMonths'),
    f.date('proposedOn'),
    f.date('boardApprovedOn'),
    f.num('exercisedShares'),
    f.num('cancelledShares'),
    f.date('cancelledOn'),
    f.bool('earlyExercise'),
    f.date('election83bDueOn', 'election_83b_due_on'),
    f.int('postTerminationExerciseDays'),
    f.text('fromOfferId'),
  ]),

  collectionView('v_time_off_requests', 'timeOffRequests', 'Time off requests. Notes are left out: they can hold private reasons.', (f) => [
    f.text('personId'),
    f.text('policyId'),
    f.lookup('policyId', 'timeOffPolicies', 'name', 'policy_name'),
    f.lookup('policyId', 'timeOffPolicies', 'kind', 'policy_kind'),
    f.date('startDate'),
    f.date('endDate'),
    f.text('partial'),
    f.num('hours'),
    f.text('status'),
    f.date('requestedOn'),
    f.text('approverId'),
    f.date('decidedOn'),
    f.text('recordedUnpaidFrom'),
  ]),

  collectionView('v_documents', 'documents', 'Documents tracked as status, date and link (never the file).', (f) => [
    f.text('personId'),
    f.text('type', 'document_type'),
    f.text('name'),
    f.text('status'),
    f.date('date', 'dated_on'),
    f.text('link'),
    f.date('retainUntil'),
  ]),

  collectionView('v_activity', 'activity', 'The activity log: who did what to which record, newest last.', (f) => [
    f.timestamp('at', 'happened_at'),
    f.text('actorId'),
    f.text('viewingAs'),
    f.text('entityType'),
    f.text('entityId'),
    f.text('relatedId'),
    f.text('kind'),
    f.text('text'),
  ]),

  listView(
    'v_checklist_tasks',
    'checklists',
    'tasks',
    'Checklist tasks, one row per task, with its checklist.',
    { parentKey: 'checklist_id', itemId: true },
    (f) => [f.text('personId'), f.text('kind', 'checklist_kind')],
    (f) => [
      f.text('title'),
      f.text('status'),
      f.date('dueOn'),
      f.date('doneOn'),
      f.text('doneById'),
      f.text('ownerRole'),
      f.text('assigneeId'),
      f.text('category'),
      f.bool('statutory'),
      f.text('citation.label', 'citation'),
      f.text('templateTaskId'),
    ],
  ),

  listView(
    'v_application_stages',
    'applications',
    'history',
    'Every stage move of every application, in order (ordinal 1 is where it started).',
    { parentKey: 'application_id', itemId: false },
    (f) => [f.text('candidateId'), f.text('jobId')],
    (f) => [f.text('stageId'), f.date('at', 'entered_on'), f.text('byId', 'moved_by_id')],
  ),

  docListView(
    'v_pay_runs',
    'company',
    'payRuns',
    'Pay runs on record, one row per pay period: marked submitted to the payroll provider, or with the totals entered from its register (payroll ran without the submitted mark).',
    (f) => {
      const p = new Fields<Person>('p.data', 'p')
      return [
        f.date('periodStart'),
        f.date('periodEnd'),
        f.date('payday'),
        f.date('submittedOn'),
        f.text('submittedById'),
        f.num('totals.gross', 'gross'),
        f.num('totals.employerTaxes', 'employer_taxes'),
        f.date('totals.enteredOn', 'totals_entered_on'),
        f.sql(
          'people_in_period',
          'integer',
          `(SELECT count(*)::int FROM people p WHERE p.workspace_id = d.workspace_id AND ${p.date('startDate').sql} <= ${f.date('periodEnd').sql}
            AND (${p.date('endDate').sql} IS NULL OR ${p.date('endDate').sql} >= ${f.date('periodStart').sql}))`,
        ),
      ]
    },
  ),

  // The journeys put every step of a person or hire into one list (UNION ALL) and group it by that person
  // or application, keeping one row per step with array_agg(... ORDER BY ...)[1]. A join on a JSON field
  // would leave the join method to the planner, which has no statistics on those fields: it guesses one
  // row and loops over one side per row of the other, so the time grows with the square of the records.
  // Grouping reads each table once; the only joins left look a record up by its key. Filter on
  // workspace_id: it is the grouping column, so the filter reaches every table.
  sqlView(
    'v_current_job',
    "Each person's job and pay today: the newest comp row effective on or before ft_today() (today in Pacific time, or the day in first_twenty.today), else nothing yet (an incoming hire). Title and department fall back to the person record.",
    `SELECT k.workspace_id,
       k.person_id AS id,
       (k.p).hire_number,
       (k.p).full_name,
       CASE WHEN (k.p).start_date > ft_today() THEN 'incoming'
            WHEN (k.p).end_date < ft_today() THEN 'former'
            WHEN k.on_leave THEN 'on_leave'
            ELSE 'active' END AS employment_state,
       coalesce((k.c).title, (k.p).title) AS title,
       coalesce((k.c).department_id, (k.p).department_id) AS department_id,
       (SELECT NULLIF(d.data ->> ${D('name')}, '') FROM departments d WHERE d.workspace_id = k.workspace_id AND d.id = coalesce((k.c).department_id, (k.p).department_id)) AS department_name,
       coalesce((k.c).level_id, (k.p).level_id) AS level_id,
       coalesce((k.c).manager_id, (k.p).manager_id) AS manager_id,
       (k.c).pay_type,
       (k.c).salary,
       (k.c).hourly_rate,
       (k.c).variable_pct,
       (k.c).id AS comp_id,
       (k.c).effective_on AS comp_effective_on,
       (k.c).reason AS comp_reason,
       (k.p).start_date,
       (k.p).end_date
  FROM (SELECT u.workspace_id,
               u.person_id,
               bool_or(u.step = 'person') AS is_person,
               (array_agg(u.p) FILTER (WHERE u.step = 'person'))[1] AS p,
               (array_agg(u.c ORDER BY (u.c).effective_on DESC, u.pos DESC) FILTER (WHERE u.step = 'comp'))[1] AS c,
               bool_or(u.step = 'leave') AS on_leave
          FROM (SELECT p.workspace_id, p.id AS person_id, 'person' AS step, p, NULL::v_comp AS c, NULL::integer AS pos
                  FROM v_people p
                UNION ALL
                SELECT c.workspace_id, c.person_id, 'comp', NULL, c, r.pos
                  FROM v_comp c
                  JOIN comp r ON r.workspace_id = c.workspace_id AND r.id = c.id
                 WHERE c.effective_on <= ft_today()
                UNION ALL
                SELECT l.workspace_id, NULLIF(l.data ->> ${L('personId')}, ''), 'leave', NULL, NULL, NULL
                  FROM leave_cases l
                 WHERE ft_as_date(l.data ->> ${L('startDate')}) <= ft_today()
                   AND NULLIF(l.data ->> ${L('returnedOn')}, '') IS NULL
                   AND (NULLIF(l.data ->> ${L('expectedReturn')}, '') IS NULL OR ft_as_date(l.data ->> ${L('expectedReturn')}) > ft_today())) u
         GROUP BY u.workspace_id, u.person_id) k
 WHERE k.is_person`,
  ),

  sqlView(
    'v_hire_journey',
    'One row per hire (an application marked hired): job, application, accepted offer, person, starting pay row, onboarding checklist and the pay run whose period holds the start date (null when that period is not on record, as for people paid before the company kept pay runs in the app, or a hire who never started). A missing step shows as nulls; v_integrity_problems says which.',
    `SELECT h.workspace_id,
       h.application_id,
       (h.a).job_id,
       j.title AS job_title,
       (h.a).candidate_id,
       concat_ws(' ', cand.first_name, cand.last_name) AS candidate_name,
       cand.source,
       (h.a).applied_on,
       (h.a).closed_on AS hired_on,
       (h.a).closed_on - (h.a).applied_on AS days_to_hire,
       (h.o).id AS offer_id,
       (h.o).sent_on AS offer_sent_on,
       (h.o).decided_on AS offer_accepted_on,
       (h.o).pay_type AS offer_pay_type,
       (h.o).salary AS offer_salary,
       (h.o).hourly_rate AS offer_hourly_rate,
       (h.o).equity_shares AS offer_shares,
       (h.p).id AS person_id,
       (h.p).hire_number,
       (h.p).full_name AS person_name,
       (h.p).start_date,
       (h.hc).id AS hire_comp_id,
       (h.hc).effective_on AS hire_comp_effective_on,
       (h.hc).salary AS hire_salary,
       (h.hc).hourly_rate AS hire_hourly_rate,
       (h.ob).id AS onboarding_checklist_id,
       (h.ob).tasks_total AS onboarding_tasks_total,
       (h.ob).tasks_done AS onboarding_tasks_done,
       (h.ob).tasks_open AS onboarding_tasks_open,
       (h.ob).completed_on AS onboarding_completed_on,
       pr.period_start AS first_pay_period_start,
       pr.period_end AS first_pay_period_end,
       pr.payday AS first_payday
  FROM (SELECT u.workspace_id,
               u.application_id,
               bool_or(u.step = 'application') AS is_hire,
               (array_agg(u.a) FILTER (WHERE u.step = 'application'))[1] AS a,
               (array_agg(u.o ORDER BY (u.o).decided_on DESC NULLS LAST, (u.o).id) FILTER (WHERE u.step = 'offer'))[1] AS o,
               (array_agg(u.p ORDER BY (u.p).id COLLATE "C") FILTER (WHERE u.step = 'person'))[1] AS p,
               (array_agg(u.hc ORDER BY (u.p).id COLLATE "C") FILTER (WHERE u.step = 'person'))[1] AS hc,
               (array_agg(u.ob ORDER BY (u.p).id COLLATE "C") FILTER (WHERE u.step = 'person'))[1] AS ob
          FROM (SELECT a.workspace_id, a.id AS application_id, 'application' AS step, a, NULL::v_offers AS o, NULL::v_people AS p, NULL::v_comp AS hc, NULL::v_checklists AS ob
                  FROM v_applications a
                 WHERE a.status = 'hired'
                UNION ALL
                SELECT o.workspace_id, o.application_id, 'offer', NULL, o, NULL, NULL, NULL
                  FROM v_offers o
                 WHERE o.status = 'accepted'
                UNION ALL
                -- Each hired person with their starting pay row and onboarding checklist, grouped the same way.
                SELECT s.workspace_id, (s.p).from_application_id, 'person', NULL, NULL, s.p, s.hc, s.ob
                  FROM (SELECT v.workspace_id,
                               v.person_id,
                               bool_or(v.step = 'person') AS is_person,
                               (array_agg(v.p) FILTER (WHERE v.step = 'person'))[1] AS p,
                               (array_agg(v.hc ORDER BY (v.hc).effective_on, (v.hc).id) FILTER (WHERE v.step = 'comp'))[1] AS hc,
                               (array_agg(v.ob ORDER BY (v.ob).created_on, (v.ob).id) FILTER (WHERE v.step = 'checklist'))[1] AS ob
                          FROM (SELECT p.workspace_id, p.id AS person_id, 'person' AS step, p, NULL::v_comp AS hc, NULL::v_checklists AS ob
                                  FROM v_people p
                                 WHERE p.from_application_id IS NOT NULL
                                UNION ALL
                                SELECT c.workspace_id, c.person_id, 'comp', NULL, c, NULL
                                  FROM v_comp c
                                 WHERE c.reason = 'hire'
                                UNION ALL
                                SELECT k.workspace_id, k.person_id, 'checklist', NULL, NULL, k
                                  FROM v_checklists k
                                 WHERE k.kind = 'onboarding') v
                         GROUP BY v.workspace_id, v.person_id) s
                 WHERE s.is_person) u
         GROUP BY u.workspace_id, u.application_id) h
  LEFT JOIN v_jobs j ON j.workspace_id = h.workspace_id AND j.id = (h.a).job_id
  LEFT JOIN v_candidates cand ON cand.workspace_id = h.workspace_id AND cand.id = (h.a).candidate_id
  LEFT JOIN LATERAL (
        SELECT r.period_start, r.period_end, r.payday
          FROM v_pay_runs r
         WHERE r.workspace_id = h.workspace_id
           AND r.period_start <= (h.p).start_date AND r.period_end >= (h.p).start_date
           AND ((h.p).end_date IS NULL OR r.period_start <= (h.p).end_date)
           AND (r.submitted_on IS NOT NULL OR r.totals_entered_on IS NOT NULL)
         ORDER BY r.period_start
         LIMIT 1) pr ON true
 WHERE h.is_hire`,
  ),

  sqlView(
    'v_pipeline_funnel',
    "Applications per job and stage, in the job's stage order: in_stage are there now (any status), reached ever entered it (from the stage history).",
    `SELECT s.workspace_id,
       s.job_id,
       s.job_title,
       s.job_status,
       s.stage_position,
       s.stage_id,
       s.stage_name,
       s.stage_kind,
       count(a.id) FILTER (WHERE a.stage_id = s.stage_id)::int AS in_stage,
       count(a.id) FILTER (WHERE a.stage_id = s.stage_id AND a.status = 'active')::int AS active,
       count(a.id) FILTER (WHERE a.stage_id = s.stage_id AND a.status = 'rejected')::int AS rejected,
       count(a.id) FILTER (WHERE a.stage_id = s.stage_id AND a.status = 'withdrawn')::int AS withdrawn,
       count(a.id) FILTER (WHERE a.stage_id = s.stage_id AND a.status = 'hired')::int AS hired,
       count(a.id) FILTER (WHERE EXISTS (SELECT 1 FROM v_application_stages h
                                          WHERE h.workspace_id = a.workspace_id AND h.application_id = a.id AND h.stage_id = s.stage_id))::int AS reached
  FROM (SELECT j.workspace_id,
               j.id AS job_id,
               NULLIF(j.data ->> ${J('title')}, '') AS job_title,
               NULLIF(j.data ->> ${J('status')}, '') AS job_status,
               x.n::int AS stage_position,
               NULLIF(x.el ->> ${S('id')}, '') AS stage_id,
               NULLIF(x.el ->> ${S('name')}, '') AS stage_name,
               NULLIF(x.el ->> ${S('kind')}, '') AS stage_kind
          FROM jobs j
         CROSS JOIN LATERAL jsonb_array_elements(ft_array(j.data -> ${J('stages')})) WITH ORDINALITY AS x(el, n)) s
  LEFT JOIN v_applications a ON a.workspace_id = s.workspace_id AND a.job_id = s.job_id
 GROUP BY s.workspace_id, s.job_id, s.job_title, s.job_status, s.stage_position, s.stage_id, s.stage_name, s.stage_kind`,
  ),

  sqlView(
    'v_headcount_by_month',
    'W-2 headcount on the last day of each month (contractors never count), with the starts and last days in the month, from the first start to this month or the latest start or last day.',
    `SELECT m.workspace_id,
       m.month,
       m.month_end,
       count(p.id) FILTER (WHERE p.start_date <= m.month_end AND (p.end_date IS NULL OR p.end_date >= m.month_end))::int AS headcount,
       count(p.id) FILTER (WHERE p.start_date BETWEEN m.month AND m.month_end)::int AS starts,
       count(p.id) FILTER (WHERE p.end_date BETWEEN m.month AND m.month_end)::int AS departures
  FROM (SELECT b.workspace_id, g.month::date AS month, (g.month + interval '1 month' - interval '1 day')::date AS month_end
          FROM (SELECT workspace_id,
                       date_trunc('month', min(start_date))::timestamp AS first_month,
                       date_trunc('month', greatest(max(start_date), max(end_date), ft_today()))::timestamp AS last_month
                  FROM v_people
                 WHERE start_date IS NOT NULL
                 GROUP BY workspace_id) b
         CROSS JOIN LATERAL generate_series(b.first_month, b.last_month, interval '1 month') AS g(month)) m
  LEFT JOIN v_people p ON p.workspace_id = m.workspace_id
 GROUP BY m.workspace_id, m.month, m.month_end`,
  ),

  sqlView(
    'v_integrity_problems',
    'What should never be true of the data, as rows: the checks of src/domain/integrity.ts (code, severity failure or note, the record and field, the other record involved). Empty when the data is consistent.',
    integrityViewSql(),
  ),
]
