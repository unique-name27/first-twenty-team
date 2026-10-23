-- 004_multitenant (docs/SYNC.md, Data layout; docs/SERVER.md, "A public demo server").
-- Never edit a migration that has been applied anywhere: add server/sql/005_*.sql instead.
--
-- One server, many companies. Every data table already has workspace_id; this adds what a workspace
-- needs to be one company among many:
-- 1. workspaces.slug: the company's part of its careers page address (careers.example.com/<slug>/),
--    lowercase a-z, 0-9 and '-', 3 to 40 characters, unique. keep: never deleted by the demo expiry
--    (every workspace that exists now is kept). created_by: the login that signed it up. last_active_at:
--    the last write or sign-in; a demo workspace (keep = false) unused for DEMO_EXPIRE_DAYS is deleted.
-- 2. users.workspace_id: the one company a login belongs to. The server takes the workspace only from
--    the session's login, never from a request. Emails stay unique across the server (one login, one
--    company). Every existing login joins the existing workspace ('default').
-- 3. invites: single-use links that let someone create a login in an existing company. Like sessions,
--    only the SHA-256 of the token is stored.
--
-- The slug rules must match server/src/workspaces.ts (slugBase, RESERVED_SLUGS): a test compares them.

ALTER TABLE workspaces
  ADD COLUMN slug text NULL,
  ADD COLUMN keep boolean NOT NULL DEFAULT false,
  ADD COLUMN created_by uuid NULL,
  ADD COLUMN last_active_at timestamptz NOT NULL DEFAULT now();

-- Logins exist only with the default workspace (001 creates it); make sure it is there for them to join.
INSERT INTO workspaces (id, name)
SELECT 'default', 'Default workspace' WHERE EXISTS (SELECT 1 FROM users)
ON CONFLICT (id) DO NOTHING;

-- Every workspace from before this migration is the owner's: kept, with a slug from its company's name
-- (the company document's name, else the workspace's), oldest first, -2, -3 ... when one is taken.
UPDATE workspaces SET keep = true;

DO $$
DECLARE
  w record;
  base text;
  candidate text;
  n int;
  reserved text[] := ARRAY['admin', 'api', 'assets', 'careers', 'jobs', 'static', 'www'];
BEGIN
  FOR w IN
    SELECT ws.id, coalesce(nullif(btrim(d.data->>'name'), ''), ws.name, '') AS name
      FROM workspaces ws
      LEFT JOIN workspace_docs d ON d.workspace_id = ws.id AND d.key = 'company'
     ORDER BY ws.created_at, ws.id
  LOOP
    base := btrim(left(btrim(regexp_replace(lower(w.name), '[^a-z0-9]+', '-', 'g'), '-'), 40), '-');
    IF length(base) < 3 THEN
      base := 'company';
    END IF;
    candidate := base;
    n := 1;
    WHILE candidate = ANY (reserved) OR EXISTS (SELECT 1 FROM workspaces WHERE slug = candidate) LOOP
      n := n + 1;
      candidate := btrim(left(base, 39 - length(n::text)), '-') || '-' || n;
    END LOOP;
    UPDATE workspaces SET slug = candidate WHERE id = w.id;
  END LOOP;
END
$$;

ALTER TABLE workspaces ALTER COLUMN slug SET NOT NULL;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_slug_key UNIQUE (slug);
ALTER TABLE workspaces ADD CONSTRAINT workspaces_slug_check
  CHECK (length(slug) BETWEEN 3 AND 40 AND slug ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$');
-- The demo expiry and the demo company count read only workspaces that are not kept.
CREATE INDEX workspaces_expiry_idx ON workspaces (last_active_at) WHERE NOT keep;

ALTER TABLE users ADD COLUMN workspace_id text NULL REFERENCES workspaces (id) ON DELETE CASCADE;
UPDATE users SET workspace_id = 'default' WHERE workspace_id IS NULL;
ALTER TABLE users ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX users_workspace_idx ON users (workspace_id);

-- Invite links: 32 random bytes in the link, only their SHA-256 here. Single use, 7 days.
CREATE TABLE invites (
  token_hash text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  created_by uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz NULL,
  used_by uuid NULL REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX invites_workspace_idx ON invites (workspace_id, expires_at);
CREATE INDEX invites_expires_idx ON invites (expires_at);
