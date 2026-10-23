-- First Twenty: ready-made read-only queries for a SQL client such as DBeaver (docs/SERVER.md, "Look at
-- the data in DBeaver"). Connect as first_twenty_viewer to the first_twenty database, open this file in a
-- SQL editor and run one statement at a time (in DBeaver: put the cursor in it and press Ctrl+Enter).
--
-- Every record table has the same columns: workspace_id, id, data (the whole record as JSON), version,
-- pos, updated_at, updated_by. data->>'field' reads one field as text; jsonb_pretty(data) shows all of it.
-- Field names match the record types in src/domain/types.ts.
--
-- A server can hold more than one company (a public demo server, SIGNUP_MODE=open), so every query below
-- reads one company: yours, the workspace 'default'. To read another, replace 'default' with its id from
-- the first query.

-- Companies on this server: yours is 'default' (kept); demo companies are deleted after DEMO_EXPIRE_DAYS idle.
SELECT w.id, w.slug, w.name, w.keep, w.created_at, w.last_active_at
FROM workspaces w
ORDER BY w.keep DESC, w.last_active_at DESC;

-- People: everyone on the team, oldest first.
SELECT p.data->>'firstName' AS first_name, p.data->>'lastName' AS last_name, p.data->>'title' AS title,
       p.data->>'workEmail' AS work_email, p.data->>'startDate' AS start_date, p.data->>'endDate' AS end_date,
       p.data->>'workMode' AS work_mode, p.updated_at
FROM people p
WHERE p.workspace_id = 'default'
ORDER BY p.data->>'startDate';

-- Hires: everyone who joined through the app's Hire step, with the job, application and accepted offer it
-- came from. A hire is not a table of its own: Hire writes the person (people), the first pay record
-- (comp), the equity grant (grants), the onboarding checklist (checklists), marks the application hired
-- and the job filled. people.data->>'fromApplicationId' is the link back. People added by hand (the
-- founder, imports) show with empty hiring columns.
SELECT (p.data->>'hireNumber')::int AS employee_no,
       concat_ws(' ', p.data->>'firstName', p.data->>'lastName') AS person, p.data->>'title' AS title,
       p.data->>'startDate' AS start_date, j.data->>'title' AS hired_for_job, c.data->>'source' AS source,
       a.data->>'appliedOn' AS applied_on, a.data->>'closedOn' AS hired_on, o.data->>'payType' AS pay_type,
       (o.data->>'salary')::numeric AS offer_salary, (o.data->>'hourlyRate')::numeric AS offer_hourly_rate,
       (o.data->>'equityShares')::numeric AS offer_shares, o.data->>'sentOn' AS offer_sent
FROM people p
LEFT JOIN applications a ON a.workspace_id = p.workspace_id AND a.id = p.data->>'fromApplicationId'
LEFT JOIN candidates c ON c.workspace_id = a.workspace_id AND c.id = a.data->>'candidateId'
LEFT JOIN jobs j ON j.workspace_id = a.workspace_id AND j.id = a.data->>'jobId'
LEFT JOIN offers o ON o.workspace_id = a.workspace_id AND o.data->>'applicationId' = a.id AND o.data->>'status' = 'accepted'
WHERE p.workspace_id = 'default'
ORDER BY employee_no;

-- Jobs, with their status and posted pay range.
SELECT j.data->>'title' AS title, j.data->>'status' AS status, (j.data->>'payMin')::numeric AS pay_min,
       (j.data->>'payMax')::numeric AS pay_max, j.data->>'workMode' AS work_mode,
       j.data->>'employmentType' AS employment, j.updated_at
FROM jobs j
WHERE j.workspace_id = 'default'
ORDER BY j.updated_at DESC;

-- Candidates and where each application stands.
SELECT concat_ws(' ', c.data->>'firstName', c.data->>'lastName') AS candidate, j.data->>'title' AS job,
       a.data->>'stageId' AS stage, a.data->>'status' AS status, a.data->>'appliedOn' AS applied_on,
       c.data->>'source' AS source
FROM applications a
JOIN candidates c ON c.workspace_id = a.workspace_id AND c.id = a.data->>'candidateId'
JOIN jobs j ON j.workspace_id = a.workspace_id AND j.id = a.data->>'jobId'
WHERE a.workspace_id = 'default'
ORDER BY a.data->>'appliedOn' DESC;

-- Offers.
SELECT concat_ws(' ', c.data->>'firstName', c.data->>'lastName') AS candidate, o.data->>'title' AS title,
       o.data->>'status' AS status, o.data->>'payType' AS pay_type, (o.data->>'salary')::numeric AS salary,
       (o.data->>'hourlyRate')::numeric AS hourly_rate, o.data->>'equityType' AS equity_type,
       (o.data->>'equityShares')::numeric AS equity_shares, o.data->>'startDate' AS start_date,
       o.data->>'sentOn' AS sent_on, o.data->>'expiresOn' AS expires_on
FROM offers o
LEFT JOIN candidates c ON c.workspace_id = o.workspace_id AND c.id = o.data->>'candidateId'
WHERE o.workspace_id = 'default'
ORDER BY o.updated_at DESC;

-- Pay history, one row per change.
SELECT concat_ws(' ', p.data->>'firstName', p.data->>'lastName') AS person, r.data->>'effectiveOn' AS effective_on,
       r.data->>'payType' AS pay_type, (r.data->>'salary')::numeric AS salary,
       (r.data->>'hourlyRate')::numeric AS hourly_rate, r.data->>'title' AS title, r.data->>'reason' AS reason
FROM comp r
LEFT JOIN people p ON p.workspace_id = r.workspace_id AND p.id = r.data->>'personId'
WHERE r.workspace_id = 'default'
ORDER BY person, effective_on;

-- Equity grants (holders can be employees, advisors, contractors, or candidates while an offer is out).
SELECT g.data->>'holderType' AS holder_type, coalesce(concat_ws(' ', p.data->>'firstName', p.data->>'lastName'), g.data->>'personId') AS holder,
       g.data->>'type' AS type, (g.data->>'shares')::numeric AS shares, (g.data->>'strikePrice')::numeric AS strike_price,
       g.data->>'vestingStart' AS vesting_start, g.data->>'status' AS status
FROM grants g
LEFT JOIN people p ON p.workspace_id = g.workspace_id AND p.id = g.data->>'personId'
WHERE g.workspace_id = 'default'
ORDER BY vesting_start;

-- Time off requests.
SELECT concat_ws(' ', p.data->>'firstName', p.data->>'lastName') AS person, t.data->>'startDate' AS start_date,
       t.data->>'endDate' AS end_date, (t.data->>'hours')::numeric AS hours, t.data->>'status' AS status
FROM time_off_requests t
LEFT JOIN people p ON p.workspace_id = t.workspace_id AND p.id = t.data->>'personId'
WHERE t.workspace_id = 'default'
ORDER BY start_date DESC;

-- Onboarding and offboarding checklists, whole records.
SELECT c.id, jsonb_pretty(c.data) AS checklist, c.updated_at
FROM checklists c
WHERE c.workspace_id = 'default'
ORDER BY c.updated_at DESC;

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
