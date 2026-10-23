-- First Twenty: least-privilege Postgres roles and database for the API server.
--
-- Two login roles, so the internet-facing server cannot change the schema even if it is compromised:
--   first_twenty_owner  owns the tables. Used only by `npm run server:migrate` (MIGRATION_DATABASE_URL).
--   first_twenty        the role the running server uses (DATABASE_URL). It can read, add, change and
--                       delete rows in those tables, and nothing else: no CREATE, DROP, ALTER, TRUNCATE,
--                       functions or schemas.
-- Neither role is a superuser, and neither can create databases or roles.
--
-- What it does (safe to run more than once):
--   1. Creates both roles.
--   2. Asks for each role's password, hidden, the first time only (psql \password; nothing is stored in
--      this file or your shell history). Give the two roles different passwords.
--   3. Creates the database first_twenty, owned by postgres, not by the app.
--   4. Locks the database and its public schema down so only these two roles (and superusers) can use them.
--   5. Lets first_twenty_owner create tables, and gives first_twenty read and write access to every table
--      first_twenty_owner creates, now or later (ALTER DEFAULT PRIVILEGES).
--   6. Upgrades a setup made by an older version of this file, where first_twenty owned the tables:
--      they move to first_twenty_owner, and first_twenty loses CREATE on the schema.
--
-- Run it on the EC2 instance as the postgres superuser, from the folder that holds this file:
--
--   sudo -u postgres psql -v ON_ERROR_STOP=1 < server/deploy/postgres-setup.sql
--
-- (Reading the file through < means the postgres user does not need access to the app folder. The
-- password prompts still come from your terminal.)
--
-- Postgres in Docker: psql needs a terminal for the password prompts, so copy the file in and use -it
-- (with -i alone the prompts would read the next lines of this file as the passwords):
--   docker cp server/deploy/postgres-setup.sql <container>:/tmp/postgres-setup.sql
--   docker exec -it <container> psql -U postgres -v ON_ERROR_STOP=1 -f /tmp/postgres-setup.sql
--
-- Afterwards put the passwords in /etc/first-twenty/env, percent-encoding special characters:
--   DATABASE_URL=postgres://first_twenty:CHANGE_ME@127.0.0.1:5432/first_twenty
--   MIGRATION_DATABASE_URL=postgres://first_twenty_owner:CHANGE_ME@127.0.0.1:5432/first_twenty
-- To change a password later:  sudo -u postgres psql -c '\password first_twenty'   (or first_twenty_owner)
-- (then update the file; for DATABASE_URL also run: sudo systemctl restart first-twenty)
--
-- If you cannot answer a prompt (for example in automation), replace the \password steps below with
--   ALTER ROLE first_twenty PASSWORD 'CHANGE_ME';
--   ALTER ROLE first_twenty_owner PASSWORD 'CHANGE_ME';
-- using a long random value in place of each CHANGE_ME, and never commit the edited file.
--
-- ---------------------------------------------------------------------------------------------------
-- Server settings to check (only an administrator can change these; this script does not touch them):
--
-- postgresql.conf (find it with: sudo -u postgres psql -tAc 'SHOW config_file')
--   listen_addresses = 'localhost'      -- Postgres is never reachable from outside the instance.
--   password_encryption = scram-sha-256 -- the default since Postgres 14; set it before creating the
--                                       -- passwords, or the stored hashes will not work with the lines below.
--
-- pg_hba.conf (find it with: sudo -u postgres psql -tAc 'SHOW hba_file')
-- Add these lines ABOVE any broader "host all all 127.0.0.1/32 ..." line. The first matching line wins,
-- and some distributions (Amazon Linux among them) ship "ident" there, which rejects passwords.
--
--   # TYPE  DATABASE      USER                             ADDRESS        METHOD
--   host    first_twenty  first_twenty,first_twenty_owner  127.0.0.1/32   scram-sha-256
--   host    first_twenty  first_twenty,first_twenty_owner  ::1/128        scram-sha-256
--   host    all           first_twenty,first_twenty_owner  127.0.0.1/32   reject
--   host    all           first_twenty,first_twenty_owner  ::1/128        reject
--
-- The two reject lines keep these roles out of every other database on the instance (a database's
-- CONNECT right goes to PUBLIC by default, and a broader "host all all" line below would let them in).
--
-- Then reload:  sudo systemctl reload postgresql   (or: sudo -u postgres psql -c 'SELECT pg_reload_conf()')
-- Changing listen_addresses needs a restart instead:  sudo systemctl restart postgresql
--
-- Postgres in Docker is different: keep listen_addresses = '*' inside the container (the image's
-- default), publish the port on the instance's loopback only (-p 127.0.0.1:5432:5432), and rely on the
-- image's own "host all all all scram-sha-256" line. The 127.0.0.1 lines above never match there,
-- because connections reach the container from the Docker bridge, not from 127.0.0.1.
--
-- Never open port 5432 in the EC2 security group. For access from your laptop use an SSH tunnel
-- (docs/SERVER.md, "Develop locally against EC2").
-- ---------------------------------------------------------------------------------------------------

\set ON_ERROR_STOP on

-- 1. The roles. Created without passwords; step 2 sets them.
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'first_twenty') AS role_is_new \gset
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'first_twenty_owner') AS owner_is_new \gset

SELECT 'CREATE ROLE first_twenty WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 20'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'first_twenty') \gexec

SELECT 'CREATE ROLE first_twenty_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 5'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'first_twenty_owner') \gexec

-- Make sure existing roles are also least privilege.
ALTER ROLE first_twenty WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 20;
ALTER ROLE first_twenty_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 5;

-- 2. The passwords, asked once each (hidden). Re-running this script does not ask again.
\if :role_is_new
  \echo 'Choose a password for first_twenty, the role the server runs as (long and random; it goes in DATABASE_URL).'
  \password first_twenty
\endif
\if :owner_is_new
  \echo 'Choose a different password for first_twenty_owner, the role that changes tables during updates (it goes in MIGRATION_DATABASE_URL).'
  \password first_twenty_owner
\endif

-- Sensible limits so a stuck request cannot hold locks forever.
ALTER ROLE first_twenty SET statement_timeout = '60s';
ALTER ROLE first_twenty SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE first_twenty SET search_path = public;
-- A migration may rebuild a table, so it gets longer; lock_timeout stops it waiting forever behind the
-- running server.
ALTER ROLE first_twenty_owner SET statement_timeout = '15min';
ALTER ROLE first_twenty_owner SET lock_timeout = '60s';
ALTER ROLE first_twenty_owner SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE first_twenty_owner SET search_path = public;

-- 3. The database, owned by postgres so neither role can drop it or change its settings.
SELECT 'CREATE DATABASE first_twenty WITH OWNER postgres ENCODING ''UTF8'' TEMPLATE template0'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'first_twenty') \gexec

-- 4. Nobody but these two roles (and superusers) may connect.
REVOKE ALL ON DATABASE first_twenty FROM PUBLIC;
GRANT CONNECT ON DATABASE first_twenty TO first_twenty, first_twenty_owner;

\connect first_twenty

-- 5. The public schema: no access for PUBLIC. first_twenty_owner may create tables there (the
-- migrations need that); first_twenty may only use what is there.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO first_twenty_owner;
GRANT USAGE ON SCHEMA public TO first_twenty;
REVOKE CREATE ON SCHEMA public FROM first_twenty;

-- 6. Upgrade from the one-role setup: hand the tables first_twenty created to first_twenty_owner.
-- (Only objects in this database; first_twenty owns nothing else.) Does nothing on a fresh setup.
REASSIGN OWNED BY first_twenty TO first_twenty_owner;

-- Read and write access for the server: to the tables that exist now...
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO first_twenty;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO first_twenty;
-- ...and to every table and sequence first_twenty_owner creates from now on (migrations, pg_restore).
ALTER DEFAULT PRIVILEGES FOR ROLE first_twenty_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO first_twenty;
ALTER DEFAULT PRIVILEGES FOR ROLE first_twenty_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO first_twenty;

\echo 'Done: roles first_twenty and first_twenty_owner and database first_twenty are ready.'
\echo 'Next: check pg_hba.conf (see the comments at the top of this file), then fill DATABASE_URL and MIGRATION_DATABASE_URL in /etc/first-twenty/env.'
