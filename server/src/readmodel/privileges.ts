// Who may do what with the read model's views. The read-model migration runs this at its end, and
// `npm run server:after-restore` runs it again: a restore (pg_restore --no-acl, docs/SERVER.md) creates the
// views anew, the default privileges hand the server's role write rights on them as on any new relation, and
// the dump's own grants are skipped. No imports, so the server bundle carries it without the generator.
import type { Db } from '../db'

/**
 * Every view in public that reads with the reader's own rights (security_invoker: the read model; a view
 * without it is left alone, as server/deploy/viewer-role.sql does): every role but the owner keeps SELECT
 * only, since a simple view would pass a write on to its table, and the optional read-only login
 * (server/deploy/viewer-role.sql) gets SELECT when it exists.
 */
export const VIEW_PRIVILEGES_SQL = `DO $$
DECLARE
  v record;
  grantee text;
BEGIN
  FOR v IN
    SELECT format('public.%I', c.relname) AS name, c.relacl, c.relowner
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'v'
       AND EXISTS (SELECT 1 FROM unnest(c.reloptions) AS o WHERE lower(o) IN ('security_invoker=true', 'security_invoker=on', 'security_invoker=1', 'security_invoker=yes'))
  LOOP
    FOR grantee IN
      SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
        FROM aclexplode(v.relacl) AS a
       WHERE a.privilege_type <> 'SELECT' AND a.grantee <> v.relowner
    LOOP
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %s FROM %s', v.name, grantee);
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'first_twenty_viewer') THEN
      EXECUTE format('GRANT SELECT ON %s TO first_twenty_viewer', v.name);
    END IF;
  END LOOP;
END
$$;`

/** Sets the views' privileges again (run as the schema owner, as after-restore is). */
export async function resetViewPrivileges(db: Pick<Db, 'exec'>): Promise<void> {
  await db.exec(VIEW_PRIVILEGES_SQL)
}
