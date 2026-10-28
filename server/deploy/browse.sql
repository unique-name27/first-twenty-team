-- First Twenty: ready-made read-only queries for a SQL client such as DBeaver (docs/SERVER.md, "Look at
-- the data in DBeaver"). Connect as first_twenty_viewer to the first_twenty database, open this file in a
-- SQL editor and run one statement at a time (in DBeaver: put the cursor in it and press Ctrl+Enter).
--
-- Most queries read the read model (migration 007; docs/DEV.md, "Query the data with SQL"): views with one
-- typed column per field, named in snake_case (v_people, v_jobs, v_hire_journey, ...). Under them, every
-- record table has the same columns: workspace_id, id, data (the whole record as JSON), version, pos,
-- updated_at, updated_by. data->>'field' reads one field as text; jsonb_pretty(data) shows all of it.
-- Field names match the record types in src/domain/types.ts.
--
-- A server can hold more than one company (a public demo server, SIGNUP_MODE=open), so every query below
-- reads one company: yours, the workspace 'default'. To read another, replace 'default' with its id from
-- the first query. The views that depend on today (v_current_job, v_headcount_by_month) use the database's
-- date; to read them as of another day, run SET first_twenty.today = '2026-12-31' first.

-- Companies on this server: yours is 'default' (kept); demo companies are deleted after DEMO_EXPIRE_DAYS idle.
SELECT w.id, w.slug, w.name, w.keep, w.created_at, w.last_active_at
FROM workspaces w
ORDER BY w.keep DESC, w.last_active_at DESC;

-- People: everyone on the team with today's title, department and pay (from the newest pay record in
-- effect), in order of hire. employment_state is incoming, active, on_leave or former.
SELECT c.hire_number AS employee_no, c.full_name, c.employment_state, c.title, c.department_name, c.pay_type,
       c.salary, c.hourly_rate, c.start_date, c.end_date, p.work_email, p.work_mode, p.home_state
FROM v_current_job c
JOIN v_people p ON p.workspace_id = c.workspace_id AND p.id = c.id
WHERE c.workspace_id = 'default'
ORDER BY c.hire_number;

-- Headcount at the end of each month (W-2 employees; contractors never count), with starts and last days.
SELECT h.month, h.headcount, h.starts, h.departures
FROM v_headcount_by_month h
WHERE h.workspace_id = 'default'
ORDER BY h.month;

-- Hires: one row per application marked hired, from the job to the first pay run. The Hire step writes the
-- person, the starting pay record, the equity grant and the onboarding checklist, marks the application
-- hired and the job filled. An empty column means that step is missing (the integrity query says more).
-- People added by hand (the founder, imports) have no hire row; they are in the people query.
SELECT j.hire_number AS employee_no, j.person_name, j.job_title, j.source, j.applied_on, j.offer_accepted_on,
       j.start_date, j.days_to_hire, j.offer_pay_type, j.offer_salary, j.offer_hourly_rate, j.offer_shares,
       j.onboarding_tasks_done, j.onboarding_tasks_total, j.first_payday
FROM v_hire_journey j
WHERE j.workspace_id = 'default'
ORDER BY j.start_date, j.hire_number;

-- Jobs, with their status and posted pay range.
SELECT j.title, j.status, j.department_name, j.pay_min, j.pay_max, j.work_mode, j.employment_type,
       j.opened_on, j.closed_on, j.updated_at
FROM v_jobs j
WHERE j.workspace_id = 'default'
ORDER BY j.updated_at DESC;

-- The hiring funnel: applications per job and stage, in each job's stage order. reached counts every
-- application that ever entered the stage; in_stage counts the ones there now, split by status.
SELECT f.job_title, f.job_status, f.stage_position, f.stage_name, f.reached, f.in_stage, f.active,
       f.rejected, f.withdrawn, f.hired
FROM v_pipeline_funnel f
WHERE f.workspace_id = 'default'
ORDER BY f.job_title, f.stage_position;

-- Candidates and where each application stands.
SELECT concat_ws(' ', c.first_name, c.last_name) AS candidate, j.title AS job, a.stage_name AS stage,
       a.status, a.applied_on, a.next_step_due_on, c.source
FROM v_applications a
JOIN v_candidates c ON c.workspace_id = a.workspace_id AND c.id = a.candidate_id
JOIN v_jobs j ON j.workspace_id = a.workspace_id AND j.id = a.job_id
WHERE a.workspace_id = 'default'
ORDER BY a.applied_on DESC;

-- Offers.
SELECT concat_ws(' ', c.first_name, c.last_name) AS candidate, o.title, o.status, o.pay_type, o.salary,
       o.hourly_rate, o.equity_type, o.equity_shares, o.start_date, o.sent_on, o.expires_on
FROM v_offers o
LEFT JOIN v_candidates c ON c.workspace_id = o.workspace_id AND c.id = o.candidate_id
WHERE o.workspace_id = 'default'
ORDER BY o.updated_at DESC;

-- Pay history, one row per change.
SELECT p.full_name AS person, r.effective_on, r.reason, r.pay_type, r.salary, r.hourly_rate, r.title
FROM v_comp r
LEFT JOIN v_people p ON p.workspace_id = r.workspace_id AND p.id = r.person_id
WHERE r.workspace_id = 'default'
ORDER BY person, r.effective_on;

-- Pay runs: the pay periods marked submitted to the payroll provider, with the totals entered from its
-- register afterwards (empty until entered) and how many people were employed in the period.
SELECT r.period_start, r.period_end, r.payday, r.submitted_on, r.gross, r.employer_taxes, r.people_in_period
FROM v_pay_runs r
WHERE r.workspace_id = 'default'
ORDER BY r.period_start;

-- Equity grants (holders can be employees, advisors, contractors, or candidates while an offer is out).
SELECT g.holder_type, coalesce(p.full_name, k.data->>'name', g.holder_id) AS holder, g.grant_type, g.shares,
       g.strike_price, g.vesting_start, g.status
FROM v_grants g
LEFT JOIN v_people p ON p.workspace_id = g.workspace_id AND p.id = g.holder_id
LEFT JOIN contractors k ON k.workspace_id = g.workspace_id AND k.id = g.holder_id
WHERE g.workspace_id = 'default'
ORDER BY g.vesting_start;

-- Time off requests.
SELECT p.full_name AS person, t.policy_name, t.start_date, t.end_date, t.hours, t.status
FROM v_time_off_requests t
LEFT JOIN v_people p ON p.workspace_id = t.workspace_id AND p.id = t.person_id
WHERE t.workspace_id = 'default'
ORDER BY t.start_date DESC;

-- Checklists still open (onboarding, offboarding, new state, leave, job changes), soonest task first.
SELECT p.full_name AS person, k.kind, k.anchor_date, k.tasks_done, k.tasks_total, k.statutory_open, k.next_due_on
FROM v_checklists k
LEFT JOIN v_people p ON p.workspace_id = k.workspace_id AND p.id = k.person_id
WHERE k.workspace_id = 'default' AND k.tasks_open > 0
ORDER BY k.next_due_on;

-- Integrity problems: what should never be true of the data (src/domain/integrity.ts). Empty is good.
-- A failure means records contradict each other (a manager who does not exist, dates out of order); a
-- note means something expected is missing or unusual. Fix them in the app, never here.
SELECT i.severity, i.code, i.collection, i.record_id, i.field, i.other_id
FROM v_integrity_problems i
WHERE i.workspace_id = 'default'
ORDER BY i.severity, i.code, i.collection, i.record_id;

-- Company settings and the other one-per-workspace documents.
SELECT d.key, jsonb_pretty(d.data) AS document, d.updated_at
FROM workspace_docs d
WHERE d.workspace_id = 'default'
ORDER BY d.key;

-- What changed most recently (every synced edit lands here first).
SELECT l.seq, l.at, l.collection, l.record_id, l.op
FROM change_log l
WHERE l.workspace_id = 'default'
ORDER BY l.seq DESC
LIMIT 50;

-- The assistant's use per company and day (UTC), every company: messages, and the tokens Claude read and
-- wrote for them (docs/SERVER.md, "Lark, the assistant"): input at full price, written to the prompt cache,
-- read from it (cache_read high and input low means the cache works), and output. billed_input_tokens adds
-- the three input counts up: everything Claude read, each part billed at its own rate (input_tokens alone is
-- only the uncached part after the last cache point, so it looks small). Nothing of what was asked is stored.
SELECT u.day, w.slug, u.messages,
       u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens AS billed_input_tokens,
       u.input_tokens, u.cache_creation_input_tokens AS cache_write_tokens,
       u.cache_read_input_tokens AS cache_read_tokens, u.output_tokens
FROM assistant_usage u
JOIN workspaces w ON w.id = u.workspace_id
ORDER BY u.day DESC, u.messages DESC
LIMIT 100;

-- How many rows each table holds, every company together.
SELECT relname AS table_name, n_live_tup AS rows
FROM pg_stat_user_tables
WHERE relname NOT IN ('users', 'sessions', 'trusted_devices', 'invites')
ORDER BY relname;
