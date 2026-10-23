-- 002_history_and_seq_versions (docs/SYNC.md, Data layout).
-- Never edit a migration that has been applied anywhere: add server/sql/003_*.sql instead.
--
-- 1. A record's version becomes the change_log seq of the write that produced it. Versions then never
--    repeat anywhere in a workspace: they keep growing across delete and re-create, a full replace
--    (Import, Start fresh) and a restore from backup, so a stale baseVersion can only ever match the
--    write it was based on. bigint, because `npm run server:after-restore` moves the sequence a
--    billion ahead. Versions written before this migration are smaller than every seq still to come.
-- 2. workspaces.history_id names the current history. It changes on every full replace and after a
--    restore; clients send it back, and the server answers resync when it no longer matches.

ALTER TABLE workspaces ADD COLUMN history_id uuid NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE change_log ALTER COLUMN version TYPE bigint;
ALTER TABLE workspace_docs ALTER COLUMN version TYPE bigint;
ALTER TABLE departments ALTER COLUMN version TYPE bigint;
ALTER TABLE locations ALTER COLUMN version TYPE bigint;
ALTER TABLE families ALTER COLUMN version TYPE bigint;
ALTER TABLE levels ALTER COLUMN version TYPE bigint;
ALTER TABLE bands ALTER COLUMN version TYPE bigint;
ALTER TABLE people ALTER COLUMN version TYPE bigint;
ALTER TABLE comp ALTER COLUMN version TYPE bigint;
ALTER TABLE grants ALTER COLUMN version TYPE bigint;
ALTER TABLE contractors ALTER COLUMN version TYPE bigint;
ALTER TABLE documents ALTER COLUMN version TYPE bigint;
ALTER TABLE plan ALTER COLUMN version TYPE bigint;
ALTER TABLE jobs ALTER COLUMN version TYPE bigint;
ALTER TABLE candidates ALTER COLUMN version TYPE bigint;
ALTER TABLE applications ALTER COLUMN version TYPE bigint;
ALTER TABLE interviews ALTER COLUMN version TYPE bigint;
ALTER TABLE scorecards ALTER COLUMN version TYPE bigint;
ALTER TABLE offers ALTER COLUMN version TYPE bigint;
ALTER TABLE referrals ALTER COLUMN version TYPE bigint;
ALTER TABLE email_templates ALTER COLUMN version TYPE bigint;
ALTER TABLE checklist_templates ALTER COLUMN version TYPE bigint;
ALTER TABLE checklists ALTER COLUMN version TYPE bigint;
ALTER TABLE time_off_policies ALTER COLUMN version TYPE bigint;
ALTER TABLE time_off_requests ALTER COLUMN version TYPE bigint;
ALTER TABLE time_off_adjustments ALTER COLUMN version TYPE bigint;
ALTER TABLE holidays ALTER COLUMN version TYPE bigint;
ALTER TABLE leave_cases ALTER COLUMN version TYPE bigint;
ALTER TABLE recurring ALTER COLUMN version TYPE bigint;
ALTER TABLE trainings ALTER COLUMN version TYPE bigint;
ALTER TABLE policies ALTER COLUMN version TYPE bigint;
ALTER TABLE acks ALTER COLUMN version TYPE bigint;
ALTER TABLE records_requests ALTER COLUMN version TYPE bigint;
ALTER TABLE activity ALTER COLUMN version TYPE bigint;
