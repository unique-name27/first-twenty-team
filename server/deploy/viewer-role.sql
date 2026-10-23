-- First Twenty: an optional read-only login for looking at the data in a SQL client such as DBeaver
-- (docs/SERVER.md, "Look at the data in DBeaver").
--
-- Run it on the instance as the postgres superuser, after postgres-setup.sql and the migrations:
--   sudo -u postgres psql -v ON_ERROR_STOP=1 -f server/deploy/viewer-role.sql
-- then give the login a password (psql asks twice and does not show it):
--   sudo -u postgres psql -c '\password first_twenty_viewer'
--
-- first_twenty_viewer can read the workspaces (companies), their records, their documents, the change log
-- and the assistant's daily counts (assistant_usage, migration 006), and nothing else: not users (password
-- hashes), sessions, trusted_devices or invites (token hashes). Every transaction it opens is read-only,
-- and it holds no write privilege anyway, so a slip in a SQL editor cannot change the data. It cannot
-- reach any other database through the grants below (pg_hba.conf can also pin it to first_twenty:
-- docs/SERVER.md). Safe to re-run; run it again after a migration adds a table, so the new table is
-- readable too. A table that holds credentials must be added to both lists below before that.

SELECT 'CREATE ROLE first_twenty_viewer LOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'first_twenty_viewer') \gexec

ALTER ROLE first_twenty_viewer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3;
ALTER ROLE first_twenty_viewer SET default_transaction_read_only = on;

GRANT CONNECT ON DATABASE first_twenty TO first_twenty_viewer;

\connect first_twenty

GRANT USAGE ON SCHEMA public TO first_twenty_viewer;

-- Every table in the schema except the four that hold credentials.
SELECT format('GRANT SELECT ON public.%I TO first_twenty_viewer', tablename)
FROM pg_tables
WHERE schemaname = 'public' AND tablename NOT IN ('users', 'sessions', 'trusted_devices', 'invites') \gexec

SELECT format('REVOKE ALL ON public.%I FROM first_twenty_viewer', tablename)
FROM pg_tables
WHERE schemaname = 'public' AND tablename IN ('users', 'sessions', 'trusted_devices', 'invites') \gexec
