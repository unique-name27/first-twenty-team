-- 005_demo_hardening (docs/SYNC.md, Data layout and Companies; docs/SERVER.md, "A public demo server").
-- Never edit a migration that has been applied anywhere: add server/sql/006_*.sql instead.
--
-- What a server open to strangers needs on top of 004:
-- 1. Seqs and versions count per workspace. change_log.seq came from one sequence for the whole server,
--    so any company could count every other company's writes from the gaps in its own versions. A write
--    now takes workspaces.last_seq + 1 under the workspace row lock every write already holds, the change
--    log is keyed by (workspace_id, seq), and the server-wide sequence goes. Every number already handed
--    out stays valid: last_seq is raised to at least every seq a workspace's log holds (versions are seqs
--    of writes that went through the log, so they are covered too), and only grows from there.
-- 2. released_slugs: the slug of every demo company the expiry (or anyone, by hand) deleted. A slug is
--    never handed out again, so an old careers link (on a job board, in an email) cannot start sending
--    applicants to whoever signs up next under the same name.
-- 3. workspaces.careers: whether the company's careers page is public. Off for the owner's workspaces
--    (kept): the owner turns it on in Settings, Server. On for demo companies, which a sign-up makes for
--    trying the careers pages out.
-- 4. workspaces.bytes_used: the size of a workspace's records and documents (the length of their JSON
--    text), kept by every write once known and NULL until then, so a demo company can be held to a byte
--    budget (server/src/validate.ts LIMITS) and the demo companies together to DEMO_MAX_TOTAL_MB.
-- 5. invites.id: a handle for listing and revoking an invite without its token. invites.refused: how
--    many tries with an email that already has a login an invite has answered; it stops working after a
--    few (workspaces.ts MAX_INVITE_REFUSALS), so one link cannot be used to test emails one after another.

-- 1. Per-workspace seqs.
UPDATE workspaces w
   SET last_seq = greatest(w.last_seq, coalesce((SELECT max(c.seq) FROM change_log c WHERE c.workspace_id = w.id), 0));

DO $$
DECLARE
  seq_name text := pg_get_serial_sequence('change_log', 'seq');
BEGIN
  ALTER TABLE change_log ALTER COLUMN seq DROP DEFAULT;
  IF seq_name IS NOT NULL THEN
    EXECUTE format('DROP SEQUENCE %s', seq_name);
  END IF;
END
$$;

ALTER TABLE change_log DROP CONSTRAINT change_log_pkey;
ALTER TABLE change_log ADD CONSTRAINT change_log_pkey PRIMARY KEY (workspace_id, seq);
-- The new primary key's index covers what this one did.
DROP INDEX change_log_workspace_seq_idx;

-- 2. Slugs that are never handed out again.
CREATE TABLE released_slugs (
  slug text PRIMARY KEY,
  released_at timestamptz NOT NULL DEFAULT now()
);

-- 3. Careers pages: on for demo companies, off for the owner's own until turned on.
ALTER TABLE workspaces ADD COLUMN careers boolean NOT NULL DEFAULT false;
UPDATE workspaces SET careers = true WHERE NOT keep;

-- 4. Bytes per workspace (NULL: not counted yet; the next write in a demo company counts them).
ALTER TABLE workspaces ADD COLUMN bytes_used bigint NULL CHECK (bytes_used IS NULL OR bytes_used >= 0);

-- 5. Invites: a handle, and the email_taken answers each has given.
ALTER TABLE invites ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE invites ADD CONSTRAINT invites_id_key UNIQUE (id);
ALTER TABLE invites ADD COLUMN refused integer NOT NULL DEFAULT 0;
